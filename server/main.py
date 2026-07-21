"""
main.py — FastAPI application entry point.

This is the only file you run. It:
  1. Starts the FastAPI ASGI server via uvicorn
  2. Serves the web dashboard (static HTML/CSS/JS) at /
  3. Exposes REST API endpoints at /api/*
  4. Handles WebSocket connections at /ws/stream and /ws/listen

Usage:
    python main.py
    # or: uvicorn main:app --host 0.0.0.0 --port 8765

Endpoints:
    WebSocket:
        /ws/stream          — Android clients send PCM audio here
        /ws/listen          — Dashboard clients receive audio here

    REST API:
        GET  /api/health              — Health check + connection stats
        GET  /api/status              — Detailed server status
        POST /api/recording/start     — Start WAV recording
        POST /api/recording/stop      — Stop WAV recording
        POST /api/recording/cancel    — Cancel and delete current recording
        GET  /api/recordings          — List saved recordings
        GET  /api/recordings/{f}/download — Download a recording
        DELETE /api/recordings/{f}    — Delete a recording

    Static:
        GET /                         — Web dashboard (index.html)
"""

from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from utils import HOST, PORT, RECORDINGS_DIR, setup_logging, ensure_recordings_dir, get_logger
from websocket import manager
from recorder import RecordingManager

# ── Initialize logging FIRST (before anything else logs) ──
setup_logging(level="INFO")
logger = get_logger("server")

# ── Recording file manager ──
recording_mgr = RecordingManager()

# ── Paths ──
STATIC_DIR = Path(__file__).parent / "static"


# ══════════════════════════════════════════════════════════════════════════════
# APP LIFECYCLE
# ══════════════════════════════════════════════════════════════════════════════


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    FastAPI lifespan handler — runs on startup and shutdown.

    Startup: Create directories, log server info.
    Shutdown: Finalize any active recording to prevent data loss.
    """
    # ── Startup ──
    ensure_recordings_dir()
    logger.info("═" * 50)
    logger.info("  Audio Stream Server — Starting")
    logger.info(f"  Dashboard:  http://{HOST}:{PORT}")
    logger.info(f"  WS Stream:  ws://{HOST}:{PORT}/ws/stream")
    logger.info(f"  WS Listen:  ws://{HOST}:{PORT}/ws/listen")
    logger.info(f"  Recordings: {RECORDINGS_DIR.resolve()}")
    logger.info("═" * 50)

    yield  # Server runs here

    # ── Shutdown ──
    # If a recording is in progress, finalize it so we don't lose data
    if manager.is_recording:
        result = manager.stop_recording()
        logger.info(f"Shutdown — recording finalized: {result}")
    logger.info("Audio Stream Server — Stopped")


# ══════════════════════════════════════════════════════════════════════════════
# FASTAPI APPLICATION
# ══════════════════════════════════════════════════════════════════════════════

app = FastAPI(
    title="Audio Stream Server",
    description="Live audio streaming server for Termux",
    version="1.0.0",
    lifespan=lifespan,
)


# ══════════════════════════════════════════════════════════════════════════════
# WEBSOCKET ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════


@app.websocket("/ws/stream")
async def ws_stream_endpoint(websocket: WebSocket):
    """
    WebSocket endpoint for AUDIO STREAMERS (Android clients).

    Protocol:
      - Client sends binary messages containing raw 16-bit PCM audio
      - Server relays each chunk to all connected listeners
      - Server writes to WAV file if recording is active
      - On disconnect, if no streamers remain, listeners are notified

    The Android client should:
      1. Connect to this endpoint
      2. Start capturing audio via AudioRecord
      3. Send PCM chunks as binary WebSocket messages
      4. Close the connection when done
    """
    conn_id = await manager.connect_streamer(websocket)

    # If connection was rejected (limit reached), conn_id is None
    if conn_id is None:
        return

    try:
        # Main receive loop — runs until the client disconnects
        while True:
            # receive_bytes() blocks until data arrives or connection closes
            pcm_data = await websocket.receive_bytes()

            # Relay the audio to all listeners (and to recorder if active)
            await manager.relay_audio(pcm_data)

    except WebSocketDisconnect:
        # Normal disconnection (client closed cleanly)
        logger.info(f"Streamer {conn_id} disconnected")

    except Exception as e:
        # Unexpected error (network drop, protocol error, etc.)
        logger.error(f"Streamer {conn_id} error: {type(e).__name__}: {e}")

    finally:
        # Always clean up, regardless of how the connection ended
        manager.disconnect_streamer(conn_id)

        # If this was the last streamer, tell all listeners
        if not manager.has_active_stream:
            await manager.notify_stream_ended()


@app.websocket("/ws/listen")
async def ws_listen_endpoint(websocket: WebSocket):
    """
    WebSocket endpoint for DASHBOARD LISTENERS.

    Protocol:
      - Server sends binary messages: raw PCM audio chunks
      - Server sends JSON messages: status updates
        - {"type": "init", ...}           — Sent immediately on connect
        - {"type": "stream_status", ...}  — When streamers connect/disconnect
        - {"type": "recording_status", ...} — When recording starts/stops
      - Client may send text messages (currently unused, reserved for future)

    The dashboard JavaScript should:
      1. Connect to this endpoint
      2. Handle binary messages → feed to AudioWorklet for playback
      3. Handle JSON messages → update UI (waveform, status indicators)
    """
    conn_id = await manager.connect_listener(websocket)

    if conn_id is None:
        return

    try:
        # Keep the connection alive.
        # Listeners primarily RECEIVE data (pushed by relay_audio).
        # This loop handles any messages the client might send.
        while True:
            # We accept text messages for future command support
            # (e.g., client-side recording requests)
            msg = await websocket.receive_text()
            logger.debug(f"Listener {conn_id} sent: {msg}")

    except WebSocketDisconnect:
        logger.info(f"Listener {conn_id} disconnected")

    except Exception as e:
        logger.error(f"Listener {conn_id} error: {type(e).__name__}: {e}")

    finally:
        manager.disconnect_listener(conn_id)


# ══════════════════════════════════════════════════════════════════════════════
# REST API — HEALTH & STATUS
# ══════════════════════════════════════════════════════════════════════════════


@app.get("/api/health")
async def health_check():
    """
    Health check endpoint.

    Returns server status and connection counts.
    Useful for monitoring and Cloudflare Tunnel health checks.
    """
    return {
        "status": "ok",
        "connections": manager.get_status(),
    }


@app.get("/api/status")
async def server_status():
    """
    Detailed server status.

    Returns all server metrics including byte counts and recording state.
    The dashboard polls this periodically to stay in sync.
    """
    return manager.get_status()


# ══════════════════════════════════════════════════════════════════════════════
# REST API — RECORDING CONTROL
# ══════════════════════════════════════════════════════════════════════════════


@app.post("/api/recording/start")
async def start_recording():
    """
    Start recording the incoming audio stream to a WAV file.

    The recording captures all PCM data relayed through the server.
    Only one recording can be active at a time.
    """
    result = manager.start_recording()
    # Notify all listeners about the recording state change
    await manager.notify_recording_state()
    return result


@app.post("/api/recording/stop")
async def stop_recording():
    """
    Stop recording and finalize the WAV file.

    The WAV header is updated with correct file/data sizes so the
    file is playable by any standard audio player.
    """
    result = manager.stop_recording()
    await manager.notify_recording_state()
    return result


@app.post("/api/recording/cancel")
async def cancel_recording():
    """
    Cancel the current recording and delete the partial file.

    Use this if you don't want to keep the recording.
    """
    result = manager.cancel_recording()
    await manager.notify_recording_state()
    return result


# ══════════════════════════════════════════════════════════════════════════════
# REST API — RECORDING FILES
# ══════════════════════════════════════════════════════════════════════════════


@app.get("/api/recordings")
async def list_recordings():
    """
    List all saved recordings with metadata.

    Returns an array of recording objects, sorted by newest first.
    Each object includes: filename, size, duration, created_at.
    """
    recordings = recording_mgr.list_recordings()
    return {
        "recordings": [r.to_dict() for r in recordings],
        "count": len(recordings),
    }


@app.get("/api/recordings/{filename}/download")
async def download_recording(filename: str):
    """
    Download a saved recording as a WAV file.

    The file is served with proper Content-Type and Content-Disposition
    headers so the browser triggers a download dialog.
    """
    filepath = recording_mgr.get_filepath(filename)

    if filepath is None:
        return JSONResponse(
            status_code=404,
            content={"error": "Recording not found", "filename": filename},
        )

    return FileResponse(
        path=filepath,
        filename=filename,
        media_type="audio/wav",
    )


@app.delete("/api/recordings/{filename}")
async def delete_recording(filename: str):
    """Delete a saved recording by filename."""
    if recording_mgr.delete(filename):
        return {"status": "deleted", "filename": filename}

    return JSONResponse(
        status_code=404,
        content={"status": "not_found", "filename": filename},
    )


# ══════════════════════════════════════════════════════════════════════════════
# STATIC FILE SERVING — WEB DASHBOARD
# ══════════════════════════════════════════════════════════════════════════════

# Mount the static directory LAST so it doesn't shadow API routes.
# The html=True flag makes it serve index.html for the root path (/).
if STATIC_DIR.exists():
    app.mount(
        "/",
        StaticFiles(directory=str(STATIC_DIR), html=True),
        name="dashboard",
    )
else:
    # Dashboard files not yet deployed — show a helpful JSON message
    logger.warning(f"Static directory not found: {STATIC_DIR}")

    @app.get("/")
    async def no_dashboard():
        return JSONResponse(content={
            "message": "Audio Stream Server is running",
            "note": "Dashboard files not yet deployed to server/static/",
            "endpoints": {
                "health": "/api/health",
                "stream": "ws://<host>:8765/ws/stream",
                "listen": "ws://<host>:8765/ws/listen",
            },
        })


# ══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import uvicorn

    # Run the ASGI server
    # - host: 0.0.0.0 binds to all interfaces (needed for LAN/tunnel access)
    # - port: 8765 (above 1024 so no root needed on Termux)
    # - log_level: matches our logging setup
    # - access_log: disabled (we handle our own logging)
    uvicorn.run(
        "main:app",
        host=HOST,
        port=PORT,
        log_level="info",
        access_log=False,
    )
