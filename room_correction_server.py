#!/usr/bin/env python3
"""
Nebula DSP — Room Correction HTTP Server (port 5006)
Standalone aiohttp server that exposes /api/rc/* endpoints.

Runs alongside the CamillaGUI backend (port 5005).
The Vite dev proxy routes /api/rc → this server.
In production the main backend can forward /api/rc requests here.
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

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(name)s  %(message)s",
)
logger = logging.getLogger("nebula.rc")

# ─── In-memory state (one measurement at a time) ────────────────────────────────

_jobs: dict[str, dict] = {}
_last_measurement: Optional[MeasurementResult] = None
_last_design: Optional[DesignResult] = None


# ─── Environment helpers ────────────────────────────────────────────────────────

def _config_path() -> str:
    return os.environ.get("NEBULA_CONFIG", "/etc/nebula-dsp/configs/default.yml")

def _cdsp_host() -> str:
    return os.environ.get("CDSP_HOST", "localhost")

def _cdsp_port() -> int:
    return int(os.environ.get("CDSP_PORT", "1234"))


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

    import uuid
    job_id = uuid.uuid4().hex[:12]
    _jobs[job_id] = {"status": "running", "progress": 0, "message": "Starting…"}

    async def _run():
        global _last_measurement
        try:
            engine = MeasurementEngine(
                sample_rate=sample_rate,
                output_device=output_device,
                input_device=input_device,
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


# ─── App factory ────────────────────────────────────────────────────────────────

def build_app() -> web.Application:
    app = web.Application(middlewares=[cors_middleware, normalize_path_middleware()])

    app.router.add_get ("/api/rc/targets",          handle_targets)
    app.router.add_get ("/api/rc/devices",          handle_list_devices)
    app.router.add_post("/api/rc/measure",          handle_start_measure)
    app.router.add_get ("/api/rc/measure/{job_id}", handle_job_status)
    app.router.add_get ("/api/rc/result",           handle_measurement_result)
    app.router.add_post("/api/rc/design",           handle_design)
    app.router.add_post("/api/rc/apply",            handle_apply)
    app.router.add_post("/api/rc/remove",           handle_remove)
    app.router.add_get ("/api/rc/export",           handle_export)

    return app


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Nebula DSP Room Correction Server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5006)
    args = parser.parse_args()

    logger.info("Nebula Room Correction server starting on %s:%d", args.host, args.port)
    web.run_app(build_app(), host=args.host, port=args.port)
