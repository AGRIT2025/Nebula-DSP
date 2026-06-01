#!/usr/bin/env python3
"""
Nebula DSP — Room Correction routes.

Used in two ways:
  1. Imported by the consolidated nebula-backend (`setup(app)` mounts
     /api/rc/* onto the shared aiohttp Application — same process as
     the GUI backend and the USB watcher).
  2. Run standalone for development with `python room_correction_server.py
     --port 5006` (the Vite dev proxy used to route /api/rc to a
     separate process; kept for backwards compatibility).
"""

import asyncio
import json
import logging
import os
from typing import Optional

from aiohttp import web
from aiohttp.web_middlewares import normalize_path_middleware

from room_correction import (
    CorrectionApplier,
    DesignResult,
    FilterDesigner,
    MeasurementEngine,
    MeasurementResult,
    TargetCurveManager,
)

# Same trick as usb_watcher: cuando este módulo corre dentro del backend
# consolidado, camillagui ya configuró el root logger antes de que nos
# importen, así que logging.basicConfig queda no-op. Adjuntamos los
# handlers directamente al logger de nebula.rc para que sus mensajes
# lleguen a journald.
import sys as _sys
_FORMATTER_RC = logging.Formatter(
    "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("nebula.rc")
logger.setLevel(logging.INFO)
logger.propagate = False
if not logger.handlers:
    _h = logging.StreamHandler(_sys.stdout)
    _h.setFormatter(_FORMATTER_RC)
    logger.addHandler(_h)

# ─── In-memory state (one measurement at a time) ────────────────────────────────

_jobs: dict[str, dict] = {}
_last_measurement: Optional[MeasurementResult] = None
_last_design: Optional[DesignResult] = None


# ─── Device auto-resolution ─────────────────────────────────────────────────────
#
# When the GUI doesn't pass an explicit input_device / output_device, the
# sweep + capture would default to whatever PipeWire's "default" sink/source
# points at — typically NOT the USB audio interface that the user already
# configured for the DSP engine.  We resolve to the engine's hw:X,Y from the
# active config and find the matching sounddevice index, so:
#   - the sweep plays through the same DAC the engine drives
#   - the mic is captured from the same input interface
# i.e. measurement loop is closed on the user's actual audio chain.

def _alsa_card_descriptors(card_idx: int) -> list[str]:
    """Returns a list of strings that PipeWire/PulseAudio likely embed
    in the friendly name of this ALSA card. Multiple candidates are
    returned so we can try them in order from most-specific to most-
    generic.

    /proc/asound/cards entries look like:
        1 [U192k          ]: USB-Audio - UMC202HD 192k
                              BEHRINGER UMC202HD 192k at usb-0000:00:14.0-2

    From these we extract:
      - the short id ("U192k")               — most precise but often
                                                NOT in PipeWire names
      - the description after the dash       ("UMC202HD 192k")
      - the second-line product description  ("BEHRINGER UMC202HD 192k")

    The PipeWire device name for that card is typically:
        "UMC202HD 192k Analog Stereo"
    so the dash-portion match wins."""
    import re
    descriptors: list[str] = []
    try:
        with open(f"/proc/asound/card{card_idx}/id") as f:
            short_id = f.read().strip()
            if short_id:
                descriptors.append(short_id)
    except Exception:
        pass
    try:
        with open("/proc/asound/cards") as f:
            content = f.read()
    except Exception:
        return descriptors
    # Match the 2-line block for this card.
    pattern = re.compile(
        rf"^\s*{card_idx}\s+\[[^\]]+\]:\s*([^\n]+)\n\s+([^\n]+)",
        re.MULTILINE,
    )
    m = pattern.search(content)
    if m:
        line1 = m.group(1).strip()  # e.g. "USB-Audio - UMC202HD 192k"
        line2 = m.group(2).strip()  # e.g. "BEHRINGER UMC202HD 192k at usb-..."
        # Prefer the part AFTER " - " in line 1 — that's the product name
        # PipeWire embeds in the friendly device name.
        if " - " in line1:
            descriptors.append(line1.split(" - ", 1)[1].strip())
        # Trim ' at usb-...' tail from line 2 and add the brand+product.
        line2_short = re.sub(r"\s+at\s+usb-.*$", "", line2).strip()
        if line2_short:
            descriptors.append(line2_short)
    return descriptors


def _resolve_engine_device_indices():
    """Returns (input_index, output_index) matching the engine's active
    ALSA device.

    Match strategy (in order):
      1. `(hw:X,Y)` literal in the sounddevice name — works when
         sounddevice exposes the raw ALSA hostapi entry.
      2. ALSA card short id (from /proc/asound/card<N>/id) substring in
         the sounddevice name — picks up PipeWire / PulseAudio wrappers
         that present the same hardware under a friendlier name (e.g.
         'UMC202HD 192k Analog Stereo' for hw:1,0 when card 1 = 'U192k').

    Returns (None, None) if the config can't be read or no sounddevice
    entry matches — caller falls back to system default."""
    try:
        import re
        import yaml
        import sounddevice as sd
    except ImportError:
        return None, None

    cfg_path = _config_path()
    try:
        with open(cfg_path) as f:
            cfg = yaml.safe_load(f) or {}
    except Exception:
        return None, None

    devices = cfg.get("devices") or {}
    cap_dev = (devices.get("capture")  or {}).get("device", "")
    pb_dev  = (devices.get("playback") or {}).get("device", "")
    if not cap_dev and not pb_dev:
        return None, None

    try:
        sd_devices = sd.query_devices()
    except Exception:
        return None, None

    def find_matching_index(alsa_hw: str, want_input: bool) -> Optional[int]:
        if not alsa_hw.startswith("hw:"):
            return None
        # Match 1: raw ALSA hostapi (`(hw:X,Y)` in the device name).
        marker = f"({alsa_hw})"
        for i, d in enumerate(sd_devices):
            name = d.get("name", "")
            if marker not in name:
                continue
            if want_input and d.get("max_input_channels", 0) > 0:
                return i
            if not want_input and d.get("max_output_channels", 0) > 0:
                return i

        # Match 2: PipeWire/Pulse wrapper. Extract card index from hw:X,Y
        # and look up the short ALSA card id (e.g. 'U192k' for the
        # UMC202HD). Then find a sounddevice entry whose name contains
        # that short id (PipeWire's friendly name typically includes the
        # USB product name, which usually contains the ALSA card id).
        m = re.match(r"hw:(\d+|[A-Za-z]+)(?:,(\d+))?", alsa_hw)
        if not m:
            return None
        card_ref = m.group(1)
        # Resolve numeric card index if needed
        card_idx = None
        if card_ref.isdigit():
            card_idx = int(card_ref)
        else:
            # Card by name reference, find its index
            try:
                with open("/proc/asound/cards") as f:
                    for line in f:
                        line = line.strip()
                        m2 = re.match(r"^(\d+)\s+\[" + re.escape(card_ref) + r"\s*\]:", line)
                        if m2:
                            card_idx = int(m2.group(1))
                            break
            except Exception:
                pass
        if card_idx is None:
            return None
        # Get multiple descriptor candidates ordered from short id (precise
        # but often not in PipeWire names) to long product name.
        descriptors = _alsa_card_descriptors(card_idx)
        if not descriptors:
            return None
        # Search for any descriptor as substring in sounddevice names.
        for descriptor in descriptors:
            for i, d in enumerate(sd_devices):
                name = d.get("name", "")
                if descriptor in name and "(hw:" not in name:
                    # PipeWire/Pulse wrapper for this card
                    if want_input and d.get("max_input_channels", 0) > 0:
                        return i
                    if not want_input and d.get("max_output_channels", 0) > 0:
                        return i
        return None

    in_idx  = find_matching_index(cap_dev, want_input=True)
    out_idx = find_matching_index(pb_dev,  want_input=False)
    return in_idx, out_idx


def _resolve_engine_alsa_string() -> tuple[Optional[str], Optional[str]]:
    """Returns (alsa_device, alsa_format) — e.g. ("hw:1,0", "S32_LE") —
    from the engine's active config. The ALSA-direct path in
    MeasurementEngine uses these to bypass sounddevice / PortAudio /
    JACK entirely, which is the only reliable way to ensure the sweep
    actually reaches the USB DAC on PipeWire systems where sounddevice
    falls back to the laptop speakers."""
    try:
        import yaml
    except ImportError:
        return None, None
    try:
        with open(_config_path()) as f:
            cfg = yaml.safe_load(f) or {}
    except Exception:
        return None, None
    devs = cfg.get("devices") or {}
    pb   = devs.get("playback") or {}
    cap  = devs.get("capture") or {}
    dev  = pb.get("device") or cap.get("device") or ""
    fmt  = pb.get("format")  or cap.get("format")  or "S16_LE"
    if not dev.startswith("hw:"):
        return None, None
    return dev, fmt


# ─── Environment helpers ────────────────────────────────────────────────────────

def _config_path() -> str:
    return os.environ.get("NEBULA_CONFIG", "/etc/nebula-dsp/configs/default.yml")

def _cdsp_host() -> str:
    return os.environ.get("CDSP_HOST", "localhost")

def _cdsp_port() -> int:
    return int(os.environ.get("CDSP_PORT", "1234"))


# ─── Engine pause/resume for exclusive device access during measurement ─────────

async def _pause_engine_for_measurement() -> bool:
    """Tell nebula-engine to release its exclusive grip on the ALSA device
    so the sweep can be played via the same USB DAC. Uses CamillaDSP's
    Stop command (via the WebSocket) which closes the audio devices but
    keeps the websocket / engine process alive — much faster than
    systemctl stop+start.

    Returns True if the engine was running and we paused it (caller is
    responsible for resuming via _resume_engine_after_measurement).
    Returns False if the engine wasn't reachable / wasn't running."""
    try:
        import websockets
        import json as _json
        uri = f"ws://{_cdsp_host()}:{_cdsp_port()}"
        async with websockets.connect(uri, open_timeout=2, close_timeout=2) as ws:
            await ws.send(_json.dumps({"GetState": None}))
            resp = _json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
            state = (resp.get("GetState") or {}).get("value", "")
            if state not in ("Running", "Paused"):
                return False
            await ws.send(_json.dumps({"Stop": None}))
            await asyncio.wait_for(ws.recv(), timeout=2)
            return True
    except Exception as e:
        logger.warning("RC: no se pudo pausar el engine (%s) — la medición puede caer al fallback", e)
        return False


async def _resume_engine_after_measurement() -> None:
    """Reload the engine's config after the measurement. CamillaDSP's
    Stop closes the devices but the engine is still attached to the
    config — re-applying it via SetConfigFilePath reopens the device
    chain. If WebSocket reload fails (engine crashed), fall back to
    `systemctl start nebula-engine` which the install.sh sets up."""
    try:
        import websockets
        import json as _json
        uri = f"ws://{_cdsp_host()}:{_cdsp_port()}"
        async with websockets.connect(uri, open_timeout=2, close_timeout=2) as ws:
            await ws.send(_json.dumps({"GetConfigFilePath": None}))
            resp = _json.loads(await asyncio.wait_for(ws.recv(), timeout=2))
            cfg_path = (resp.get("GetConfigFilePath") or {}).get("value", "")
            if cfg_path:
                # CamillaDSP 4.x: Set* takes the value directly, no
                # {"value": ...} wrapper (verified by direct probe).
                await ws.send(_json.dumps({"SetConfigFilePath": cfg_path}))
                await asyncio.wait_for(ws.recv(), timeout=3)
                logger.info("RC: engine reanudado tras la medición")
                return
    except Exception as e:
        logger.warning("RC: no se pudo reanudar engine via WS (%s) — probando systemctl", e)
    # Fallback systemctl. Best-effort, no return-value check.
    try:
        proc = await asyncio.create_subprocess_exec(
            "systemctl", "restart", "nebula-engine.service",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
    except Exception:
        pass


# ─── CORS middleware ────────────────────────────────────────────────────────────

@web.middleware
async def cors_middleware(request: web.Request, handler):
    if request.method == "OPTIONS":
        return web.Response(headers={
            "Access-Control-Allow-Origin":  "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
        })
    resp = await handler(request)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


# ─── Route handlers ─────────────────────────────────────────────────────────────

async def handle_targets(request: web.Request) -> web.Response:
    return web.json_response(TargetCurveManager.list_curves())


async def handle_list_devices(request: web.Request) -> web.Response:
    """Return available sounddevice audio devices."""
    try:
        import sounddevice as sd
        devices = sd.query_devices()
        result = [
            {
                "index":     i,
                "name":      d["name"],
                "max_input": d["max_input_channels"],
                "max_output": d["max_output_channels"],
                "default_sr": int(d["default_samplerate"]),
            }
            for i, d in enumerate(devices)
        ]
        return web.json_response(result)
    except ImportError:
        return web.json_response({"error": "sounddevice not installed"}, status=503)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def handle_start_measure(request: web.Request) -> web.Response:
    global _last_measurement
    try:
        body = await request.json()
    except Exception:
        body = {}

    output_device = body.get("output_device")
    input_device  = body.get("input_device")
    sample_rate   = int(body.get("sample_rate", 48000))

    # Auto-routing: si la GUI no especificó device, usar el que el engine
    # tiene activo en la config — así el sweep sale por la misma USB DAC
    # y el mic se captura del mismo input que el resto de Nebula.
    if input_device is None or output_device is None:
        auto_in, auto_out = _resolve_engine_device_indices()
        if input_device is None and auto_in is not None:
            input_device = auto_in
            logger.info("RC: auto-selected INPUT device #%d (engine's capture)", auto_in)
        if output_device is None and auto_out is not None:
            output_device = auto_out
            logger.info("RC: auto-selected OUTPUT device #%d (engine's playback)", auto_out)

    # Resolve also the ALSA device + format from the engine's config —
    # used by MeasurementEngine to bypass sounddevice/PortAudio when the
    # latter routes through a hostapi that can't deliver to the actual
    # USB DAC (typical PipeWire+JACK situation where the sweep ends up
    # at the laptop speakers).
    alsa_device, alsa_format = _resolve_engine_alsa_string()
    if alsa_device:
        logger.info("RC: ALSA-direct route via %s (%s)", alsa_device, alsa_format)

    import uuid
    job_id = uuid.uuid4().hex[:12]
    _jobs[job_id] = {
        "status": "running", "progress": 0, "message": "Starting…",
        "input_device": input_device, "output_device": output_device,
    }

    async def _run():
        global _last_measurement
        # nebula-engine abre hw:X,Y en exclusiva ALSA — mientras corre,
        # sounddevice via PipeWire no puede acceder al device y el sweep
        # se desvía al sink default del sistema (típicamente los
        # parlantes del laptop). Pausamos el engine durante la medición
        # y lo restart-eamos al terminar para liberar el USB DAC.
        engine_was_running = await _pause_engine_for_measurement()
        if engine_was_running:
            logger.info("RC: engine pausado para liberar el USB durante la medición")
            await asyncio.sleep(0.8)  # ALSA tarda un toque en liberar el handle

        try:
            engine = MeasurementEngine(
                sample_rate=sample_rate,
                output_device=output_device,
                input_device=input_device,
                alsa_device=alsa_device,
                alsa_format=alsa_format,
            )

            async def on_progress(pct: int, msg: str):
                _jobs[job_id]["progress"] = pct
                _jobs[job_id]["message"]  = msg

            result = await engine.measure(progress_cb=on_progress)
            _last_measurement = result
            _jobs[job_id]["status"]   = "done"
            _jobs[job_id]["progress"] = 100
            _jobs[job_id]["result"]   = result.measurement_id
        except ImportError as e:
            logger.exception("Missing dependency")
            _jobs[job_id]["status"]  = "error"
            _jobs[job_id]["message"] = f"Missing dependency: {e}"
        except Exception as e:
            logger.exception("Measurement failed")
            _jobs[job_id]["status"]  = "error"
            _jobs[job_id]["message"] = str(e)
        finally:
            # Reanudar el engine para retomar el procesamiento de audio
            # del usuario. Se ejecuta incluso si la medición falló.
            if engine_was_running:
                await _resume_engine_after_measurement()

    asyncio.create_task(_run())
    return web.json_response({"job_id": job_id})


async def handle_job_status(request: web.Request) -> web.Response:
    job_id = request.match_info["job_id"]
    job = _jobs.get(job_id)
    if not job:
        raise web.HTTPNotFound(reason="Job not found")
    return web.json_response(job)


async def handle_measurement_result(request: web.Request) -> web.Response:
    if _last_measurement is None:
        raise web.HTTPNotFound(reason="No measurement available")
    m = _last_measurement
    return web.json_response({
        "measurement_id": m.measurement_id,
        "frequencies":    m.frequencies,
        "magnitude_db":   m.magnitude_db,
        "sample_rate":    m.sample_rate,
    })


async def handle_design(request: web.Request) -> web.Response:
    global _last_design
    if _last_measurement is None:
        raise web.HTTPBadRequest(reason="No measurement — run /api/rc/measure first")

    try:
        body = await request.json()
    except Exception:
        body = {}

    mode        = body.get("mode", "iir")
    target_name = body.get("target", "flat")
    max_gain    = float(body.get("max_gain_db", 12.0))
    n_taps      = int(body.get("n_taps", 8192))

    try:
        designer = FilterDesigner()
        if mode == "fir":
            design = designer.design_fir(
                _last_measurement, target_name=target_name, n_taps=n_taps,
            )
        else:
            design = designer.design_iir(
                _last_measurement, target_name=target_name, max_gain_db=max_gain,
            )
        _last_design = design
    except ImportError as e:
        raise web.HTTPServiceUnavailable(reason=f"Missing dependency: {e}")

    return web.json_response({
        "mode":          design.mode,
        "target_label":  design.target_label,
        "correction_db": design.correction_db,
        "biquads": [
            {"type": bq.filter_type, "freq": bq.freq, "gain": bq.gain, "q": bq.q}
            for bq in design.biquads
        ],
        "fir_path": design.fir_path,
    })


async def handle_apply(request: web.Request) -> web.Response:
    if _last_design is None:
        raise web.HTTPBadRequest(reason="No design — run /api/rc/design first")

    cfg = _config_path()
    if not os.path.exists(cfg):
        raise web.HTTPInternalServerError(reason=f"Config not found: {cfg}")

    applier = CorrectionApplier(cdsp_host=_cdsp_host(), cdsp_port=_cdsp_port())
    if _last_design.mode == "fir":
        ok = await applier.apply_fir(_last_design, cfg)
    else:
        ok = await applier.apply_iir(_last_design, cfg)

    return web.json_response({"ok": ok})


async def handle_remove(request: web.Request) -> web.Response:
    cfg = _config_path()
    if not os.path.exists(cfg):
        raise web.HTTPInternalServerError(reason=f"Config not found: {cfg}")
    applier = CorrectionApplier(cdsp_host=_cdsp_host(), cdsp_port=_cdsp_port())
    ok = await applier.remove_correction(cfg)
    return web.json_response({"ok": ok})


async def handle_export(request: web.Request) -> web.Response:
    cfg = _config_path()
    if not os.path.exists(cfg):
        raise web.HTTPNotFound(reason="Config file not found")
    with open(cfg) as f:
        content = f.read()
    return web.Response(
        body=content.encode(),
        content_type="application/x-yaml",
        headers={"Content-Disposition": "attachment; filename=nebula_correction.yml"},
    )


# ─── Route registration ──────────────────────────────────────────────────────

_ROUTES = (
    ("GET",  "/api/rc/targets",          handle_targets),
    ("GET",  "/api/rc/devices",          handle_list_devices),
    ("POST", "/api/rc/measure",          handle_start_measure),
    ("GET",  "/api/rc/measure/{job_id}", handle_job_status),
    ("GET",  "/api/rc/result",           handle_measurement_result),
    ("POST", "/api/rc/design",           handle_design),
    ("POST", "/api/rc/apply",            handle_apply),
    ("POST", "/api/rc/remove",           handle_remove),
    ("GET",  "/api/rc/export",           handle_export),
)


def setup(app: web.Application) -> None:
    """Mount /api/rc/* onto an existing aiohttp Application.

    Called from the consolidated nebula-backend's main.py after
    setup_static_routes(app).  CORS is handled by the main backend
    (aiohttp_cors), so we do NOT register the cors_middleware here.
    """
    for method, path, handler in _ROUTES:
        app.router.add_route(method, path, handler)
    logger.info("Room Correction routes mounted (%d endpoints)", len(_ROUTES))


def build_app() -> web.Application:
    """Standalone app factory — kept for `python room_correction_server.py`."""
    app = web.Application(middlewares=[cors_middleware, normalize_path_middleware()])
    setup(app)
    return app


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Nebula DSP Room Correction Server (standalone dev mode)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5006)
    args = parser.parse_args()

    logger.info("Nebula Room Correction server starting on %s:%d", args.host, args.port)
    web.run_app(build_app(), host=args.host, port=args.port)
