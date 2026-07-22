"""
main.py — FastAPI application entry point for the Audio Monitoring Server.

Runs entirely on Android via Termux. Receives uploaded WAV audio chunks
from Android client apps, stores them in an organized directory structure,
maintains a SQLite database of all recordings and clients, and serves
a web dashboard for monitoring and playback.

Architecture:
    Android Client App → Cloudflare Tunnel → This Server
                                                ├── POST /api/upload (receive WAV chunks)
                                                ├── GET  /api/health (heartbeat)
                                                ├── GET  /api/dashboard (all dashboard data)
                                                └── GET  / (web dashboard)

Usage:
    python main.py
    # or: uvicorn main:app --host 0.0.0.0 --port 8765

Endpoints:
    Upload:
        POST /api/upload              — Receive a WAV chunk (multipart form)

    Health & Status:
        GET  /api/health              — Health check (client heartbeat)
        GET  /api/status              — Detailed server status

    Clients:
        GET  /api/clients             — List all registered clients

    Recordings:
        GET  /api/recordings          — List recordings (with filters)
        GET  /api/recordings/{uuid}   — Get recording metadata
        GET  /api/recordings/{uuid}/download — Download WAV file
        DELETE /api/recordings/{uuid} — Delete a recording

    Dashboard:
        GET  /api/dashboard           — Aggregated dashboard data
        GET  /api/stats               — Global statistics
        POST /api/playback/mark-played — Mark recording as played
        GET  /api/playback/queue      — Get unplayed recordings

    Static:
        GET  /                        — Web dashboard (index.html)
"""

import time
import asyncio
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, UploadFile, Form, Query, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from utils import (
    HOST, PORT, MAX_UPLOAD_SIZE,
    setup_logging, get_logger,
    validate_uuid, sanitize_client_name,
    compute_sha256_bytes, format_size, format_duration,
)
from database import DatabaseManager
from storage import StorageManager

# ── Initialize logging FIRST ──
setup_logging(level="INFO")
logger = get_logger("server")

# ── Core managers ──
db = DatabaseManager()
storage = StorageManager()

# ── Paths ──
STATIC_DIR = Path(__file__).parent / "static"

# ── Rate limiting state ──
# Simple in-memory rate limiter: {client_name: [timestamps]}
_rate_limits: dict[str, list[float]] = {}


# ══════════════════════════════════════════════════════════════════════════════
# APP LIFECYCLE
# ══════════════════════════════════════════════════════════════════════════════


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan handler — runs on startup and shutdown."""
    # ── Startup ──
    db.initialize()
    logger.info("═" * 55)
    logger.info("  Audio Monitor Server — Starting")
    logger.info(f"  Dashboard:  http://{HOST}:{PORT}")
    logger.info(f"  Upload:     http://{HOST}:{PORT}/api/upload")
    logger.info(f"  Health:     http://{HOST}:{PORT}/api/health")
    logger.info("═" * 55)

    # Background task: check for stale clients every 60 seconds
    async def stale_checker():
        while True:
            await asyncio.sleep(60)
            try:
                stale = db.check_stale_clients(timeout_seconds=120)
                for name in stale:
                    logger.info(f"Client marked offline (stale): {name}")
            except Exception as e:
                logger.error(f"Stale checker error: {e}")

    task = asyncio.create_task(stale_checker())

    yield  # Server runs here

    # ── Shutdown ──
    task.cancel()
    logger.info("Audio Monitor Server — Stopped")


# ══════════════════════════════════════════════════════════════════════════════
# FASTAPI APPLICATION
# ══════════════════════════════════════════════════════════════════════════════

app = FastAPI(
    title="Audio Monitor Server",
    description="Bulletproof audio monitoring server for Termux",
    version="2.0.0",
    lifespan=lifespan,
)

# CORS — allow dashboard access from any origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ══════════════════════════════════════════════════════════════════════════════
# RATE LIMITING HELPER
# ══════════════════════════════════════════════════════════════════════════════


def _check_rate_limit(client_name: str, max_per_minute: int = 60) -> bool:
    """
    Check if a client has exceeded the upload rate limit.
    Returns True if allowed, False if rate limited.
    """
    now = time.time()
    if client_name not in _rate_limits:
        _rate_limits[client_name] = []

    # Remove timestamps older than 1 minute
    _rate_limits[client_name] = [
        t for t in _rate_limits[client_name] if now - t < 60
    ]

    if len(_rate_limits[client_name]) >= max_per_minute:
        return False

    _rate_limits[client_name].append(now)
    return True


# ══════════════════════════════════════════════════════════════════════════════
# UPLOAD ENDPOINT — THE CORE OF THE SYSTEM
# ══════════════════════════════════════════════════════════════════════════════


@app.post("/api/upload")
async def upload_recording(
    request: Request,
    file: UploadFile = File(...),
    uuid: str = Form(...),
    client_name: str = Form(...),
    timestamp: str = Form(default=""),
    duration: float = Form(default=0.0),
    checksum: str = Form(default=""),
    device_info: str = Form(default=""),
):
    """
    Receive an uploaded WAV audio chunk from an Android client.

    This is the most critical endpoint — it must:
    1. Validate the upload (UUID, file format, checksum)
    2. Handle duplicates gracefully (return success if already exists)
    3. Save the file to organized storage
    4. Record metadata in the database
    5. Return a clear confirmation so the client can delete its local copy

    The client should NOT delete its local file until it receives
    a successful response from this endpoint.
    """
    # Get client IP
    client_ip = request.client.host if request.client else "unknown"

    # ── Input validation ──
    if not validate_uuid(uuid):
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": "Invalid UUID format"}
        )

    safe_name = sanitize_client_name(client_name)
    if not safe_name:
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": "Invalid client name"}
        )

    # ── Rate limiting ──
    if not _check_rate_limit(safe_name):
        return JSONResponse(
            status_code=429,
            content={
                "status": "error",
                "message": "Rate limit exceeded. Max 60 uploads per minute."
            }
        )

    # ── Duplicate check ──
    if db.recording_exists(uuid):
        logger.info(f"Duplicate upload skipped: {uuid} from {safe_name}")
        return {
            "status": "already_exists",
            "uuid": uuid,
            "message": "Recording already uploaded successfully."
        }

    # ── Read file data ──
    try:
        file_data = await file.read()
    except Exception as e:
        logger.error(f"Failed to read upload from {safe_name}: {e}")
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": f"Failed to read file: {e}"}
        )

    if len(file_data) == 0:
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": "Empty file received"}
        )

    if len(file_data) > MAX_UPLOAD_SIZE:
        return JSONResponse(
            status_code=413,
            content={
                "status": "error",
                "message": f"File too large: {format_size(len(file_data))} "
                           f"(max {format_size(MAX_UPLOAD_SIZE)})"
            }
        )

    # ── Validate WAV format ──
    try:
        wav_info = storage.validate_wav(file_data)
    except ValueError as e:
        logger.warning(f"Invalid WAV from {safe_name}: {e}")
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": f"Invalid WAV file: {e}"}
        )

    # ── Verify checksum ──
    if checksum and not storage.verify_checksum(file_data, checksum):
        actual_checksum = compute_sha256_bytes(file_data)
        logger.warning(
            f"Checksum mismatch from {safe_name}: "
            f"expected={checksum[:16]}... actual={actual_checksum[:16]}..."
        )
        return JSONResponse(
            status_code=400,
            content={
                "status": "error",
                "message": "Checksum mismatch — file may be corrupt"
            }
        )

    # Use WAV-derived duration if client didn't provide one
    actual_duration = duration if duration > 0 else wav_info["duration"]

    # Compute checksum if not provided
    actual_checksum = checksum or compute_sha256_bytes(file_data)

    # ── Save file to disk ──
    try:
        save_result = storage.save_recording(
            file_data=file_data,
            client_name=safe_name,
            timestamp_str=timestamp,
        )
    except Exception as e:
        logger.error(f"Failed to save recording from {safe_name}: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": f"Storage error: {e}"}
        )

    # ── Register client & insert recording in database ──
    try:
        db.register_client(
            name=safe_name,
            device_info=device_info,
            ip_address=client_ip,
        )

        recording = db.insert_recording(
            uuid=uuid,
            client_name=safe_name,
            filename=save_result["filename"],
            filepath=save_result["filepath"],
            file_size=save_result["file_size"],
            duration=actual_duration,
            checksum=actual_checksum,
            recorded_at=timestamp,
            sample_rate=wav_info["sample_rate"],
            channels=wav_info["channels"],
            bits_per_sample=wav_info["bits_per_sample"],
        )

        db.update_client_stats(
            name=safe_name,
            file_size=save_result["file_size"],
            duration=actual_duration,
        )

    except Exception as e:
        logger.error(f"Database error for {safe_name}: {e}")
        # File is saved but DB insert failed — still return success
        # to prevent client from re-uploading (file is safe on disk)
        return {
            "status": "confirmed",
            "uuid": uuid,
            "message": "File saved (database update pending)",
            "warning": str(e),
        }

    logger.info(
        f"✓ Upload confirmed: {safe_name}/{save_result['filename']} "
        f"({format_size(save_result['file_size'])}, "
        f"{format_duration(actual_duration)})"
    )

    return {
        "status": "confirmed",
        "uuid": uuid,
        "filename": save_result["filename"],
        "file_size": save_result["file_size"],
        "duration": actual_duration,
        "message": "Upload successful. You may delete the local copy."
    }


# ══════════════════════════════════════════════════════════════════════════════
# HEALTH & STATUS
# ══════════════════════════════════════════════════════════════════════════════


@app.get("/api/health")
async def health_check():
    """
    Health check endpoint. Used by Android client for heartbeat
    and by Cloudflare Tunnel for health monitoring.
    """
    return {
        "status": "ok",
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "uptime": "running",
    }


@app.get("/api/status")
async def server_status():
    """Detailed server status with all metrics."""
    stats = db.get_stats()
    storage_info = storage.get_storage_info()
    return {
        "status": "ok",
        "stats": stats,
        "storage": storage_info,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


# ══════════════════════════════════════════════════════════════════════════════
# CLIENT ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════


@app.get("/api/clients")
async def list_clients():
    """List all registered clients with their online/offline status."""
    clients = db.get_clients()
    return {"clients": clients, "count": len(clients)}


# ══════════════════════════════════════════════════════════════════════════════
# RECORDING ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════


@app.get("/api/recordings")
async def list_recordings(
    client: str = Query(default=None, description="Filter by client name"),
    date: str = Query(default=None, description="Filter by date (YYYY-MM-DD)"),
    search: str = Query(default=None, description="Search term"),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    """List recordings with optional filters. Returns newest first."""
    recordings = db.get_recordings(
        client_name=client,
        date_str=date,
        search=search,
        limit=limit,
        offset=offset,
    )
    storage_info = storage.get_storage_info()

    return {
        "recordings": recordings,
        "count": len(recordings),
        "total": db.get_recording_count(),
        "storage": storage_info,
    }


@app.get("/api/recordings/{uuid}")
async def get_recording(uuid: str):
    """Get metadata for a specific recording."""
    recording = db.get_recording(uuid)
    if not recording:
        return JSONResponse(
            status_code=404,
            content={"status": "not_found", "uuid": uuid}
        )
    return {"recording": recording}


@app.get("/api/recordings/{uuid}/download")
async def download_recording(uuid: str):
    """Download a recording WAV file."""
    recording = db.get_recording(uuid)
    if not recording:
        return JSONResponse(
            status_code=404,
            content={"status": "not_found", "uuid": uuid}
        )

    filepath = storage.get_file(recording["filepath"])
    if not filepath:
        return JSONResponse(
            status_code=404,
            content={"status": "file_missing", "uuid": uuid}
        )

    return FileResponse(
        path=filepath,
        filename=recording["filename"],
        media_type="audio/wav",
    )


@app.get("/api/recordings/export-combined")
async def export_combined_recordings(
    uuids: str = Query(default="", description="Comma-separated list of UUIDs"),
    client: str = Query(default=None, description="Client name"),
    date: str = Query(default=None, description="Date (YYYY-MM-DD)"),
    minutes: int = Query(default=0, ge=0, le=1440, description="Duration in minutes (1, 5, 15, 30, 0=all)"),
    limit: int = Query(default=300, ge=1, le=2000),
):
    """
    Combine multiple 10-second audio chunks into a single concatenated WAV file.
    Supports duration selection: 1 min, 5 min, 15 min, 30 min, or all available chunks.
    """
    from fastapi.responses import Response

    # Calculate number of 10-second chunks (1 min = 6 chunks)
    target_limit = (minutes * 6) if minutes > 0 else limit

    recordings = []
    if uuids:
        uuid_list = [u.strip() for u in uuids.split(",") if u.strip()]
        for u in uuid_list:
            rec = db.get_recording(u)
            if rec:
                recordings.append(rec)
    else:
        recordings = db.get_recordings(client_name=client, date_str=date, limit=target_limit)
        recordings.reverse()  # Chronological order (oldest to newest)

    if not recordings:
        return JSONResponse(
            status_code=404,
            content={"status": "error", "message": "No recordings found to combine"}
        )

    filepaths = [r["filepath"] for r in recordings]
    try:
        combined_bytes = storage.combine_wav_files(filepaths)
    except ValueError as e:
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": str(e)}
        )

    total_duration = sum(r["duration"] for r in recordings)
    duration_min = round(total_duration / 60.0, 1)
    safe_client = client or "audio"
    filename = f"{safe_client}_combined_{duration_min}min.wav"

    return Response(
        content=combined_bytes,
        media_type="audio/wav",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


@app.delete("/api/recordings/{uuid}")
async def delete_recording(uuid: str):
    """Delete a recording (file and database entry)."""
    recording = db.get_recording(uuid)
    if not recording:
        return JSONResponse(
            status_code=404,
            content={"status": "not_found", "uuid": uuid}
        )

    # Delete file from disk
    storage.delete_file(recording["filepath"])

    # Delete from database
    db.delete_recording(uuid)

    logger.info(f"Recording deleted: {uuid} ({recording['filename']})")
    return {"status": "deleted", "uuid": uuid}


# ══════════════════════════════════════════════════════════════════════════════
# DASHBOARD DATA ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════


@app.get("/api/dashboard")
async def dashboard_data():
    """
    Aggregated dashboard data — single endpoint that returns everything
    the dashboard needs in one request. This minimizes polling overhead.
    """
    stats = db.get_stats()
    clients = db.get_clients()
    recent_uploads = db.get_recent_uploads(limit=20)
    recent_recordings = db.get_recordings(limit=20)
    storage_info = storage.get_storage_info()
    unplayed = db.get_unplayed_recordings(limit=50)

    return {
        "stats": stats,
        "clients": clients,
        "recent_uploads": recent_uploads,
        "recent_recordings": recent_recordings,
        "storage": storage_info,
        "playback_queue": unplayed,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


@app.get("/api/stats")
async def global_stats():
    """Global statistics for the system."""
    return db.get_stats()


@app.post("/api/playback/mark-played")
async def mark_played(uuid: str = Form(...)):
    """Mark a recording as played (removes from auto-playback queue)."""
    db.mark_played(uuid)
    return {"status": "marked", "uuid": uuid}


@app.get("/api/playback/queue")
async def playback_queue():
    """Get the list of unplayed recordings for auto-playback."""
    unplayed = db.get_unplayed_recordings(limit=50)
    return {"queue": unplayed, "count": len(unplayed)}


# ══════════════════════════════════════════════════════════════════════════════
# STATIC FILE SERVING — WEB DASHBOARD
# ══════════════════════════════════════════════════════════════════════════════

if STATIC_DIR.exists():
    app.mount(
        "/",
        StaticFiles(directory=str(STATIC_DIR), html=True),
        name="dashboard",
    )
else:
    logger.warning(f"Static directory not found: {STATIC_DIR}")

    @app.get("/")
    async def no_dashboard():
        return JSONResponse(content={
            "message": "Audio Monitor Server is running",
            "note": "Dashboard files not deployed to server/static/",
            "endpoints": {
                "health": "/api/health",
                "upload": "/api/upload",
                "dashboard_data": "/api/dashboard",
            },
        })


# ══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=HOST,
        port=PORT,
        log_level="info",
        access_log=False,
    )
