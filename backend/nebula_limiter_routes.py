"""HTTP proxy from /api/limiter/* to the nebula-limiter Unix socket.

The limiter sidecar exposes a tiny newline-delimited-JSON protocol over a
Unix socket (default /run/nebula-limiter/control.sock).  The aiohttp GUI
backend forwards three operations:

    GET  /api/limiter/status   →  {"op":"status"}
    POST /api/limiter/params   →  {"op":"set","params":{...}}
    POST /api/limiter/reset    →  {"op":"reset_stats"}

If the socket is missing (sidecar not running yet) we return HTTP 503 so
the GUI can show a clear "limiter offline" state instead of a generic
500 page.
"""

import asyncio
import json
import os
from pathlib import Path

from aiohttp import web

SOCKET_PATH = Path(os.environ.get("NEBULA_LIMITER_SOCKET", "/run/nebula-limiter/control.sock"))


async def _ask(payload: dict) -> dict:
    """Send one line of JSON, return the parsed reply line.

    Uses asyncio's Unix-socket transport so we don't block the event loop
    while waiting on the sidecar.
    """
    if not SOCKET_PATH.exists():
        raise FileNotFoundError(str(SOCKET_PATH))
    reader, writer = await asyncio.open_unix_connection(str(SOCKET_PATH))
    try:
        writer.write((json.dumps(payload) + "\n").encode("utf-8"))
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout=1.5)
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
    if not line:
        raise RuntimeError("empty reply from nebula-limiter")
    return json.loads(line.decode("utf-8"))


async def _handle(payload: dict):
    try:
        reply = await _ask(payload)
    except FileNotFoundError:
        return web.json_response(
            {"error": "nebula-limiter sidecar is not running", "online": False},
            status=503,
        )
    except (asyncio.TimeoutError, ConnectionRefusedError, OSError) as exc:
        return web.json_response(
            {"error": f"limiter socket error: {exc}", "online": False},
            status=503,
        )
    if "error" in reply:
        return web.json_response(reply, status=400)
    reply["online"] = True
    return web.json_response(reply)


async def get_status(_request: web.Request):
    return await _handle({"op": "status"})


async def set_params(request: web.Request):
    try:
        params = await request.json()
    except Exception as exc:
        return web.json_response({"error": f"bad json: {exc}"}, status=400)
    # Whitelist the keys the sidecar understands so we don't forward
    # arbitrary user input.
    allowed = {"ceiling_db", "lookahead_ms", "true_peak", "release_ms"}
    clean = {k: v for k, v in params.items() if k in allowed}
    return await _handle({"op": "set", "params": clean})


async def reset_stats(_request: web.Request):
    return await _handle({"op": "reset_stats"})


# ── Service lifecycle (stop / start the Rust sidecar via systemctl) ─────────
#
# The Limiter sidecar is a separate systemd unit, not part of the engine's
# config pipeline. The user can take it out of the audio chain either by
# clicking the × on the Pipeline diagram's Limiter node or via Start/Stop
# buttons on the Limiter tab. We shell out to `sudo systemctl ...` —
# `dsp` has a NOPASSWD entry for this (see install.sh).

_SERVICE = "nebula-limiter.service"


async def _systemctl(verb: str):
    proc = await asyncio.create_subprocess_exec(
        "sudo", "-n", "systemctl", verb, _SERVICE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        msg = (err.decode("utf-8", errors="replace").strip() or
               out.decode("utf-8", errors="replace").strip() or
               f"systemctl {verb} failed (rc={proc.returncode})")
        return web.json_response({"error": msg, "ok": False}, status=500)
    return web.json_response({"ok": True})


async def stop_sidecar(_request: web.Request):
    return await _systemctl("stop")


async def start_sidecar(_request: web.Request):
    return await _systemctl("start")


def setup(app: web.Application) -> None:
    """Register limiter routes onto the aiohttp app."""
    app.router.add_get ("/api/limiter/status", get_status)
    app.router.add_post("/api/limiter/params", set_params)
    app.router.add_post("/api/limiter/reset",  reset_stats)
    app.router.add_post("/api/limiter/stop",   stop_sidecar)
    app.router.add_post("/api/limiter/start",  start_sidecar)
