"""
utils.py — Shared configuration, constants, and utility functions.

Centralizes all configuration so any module can import without
circular dependencies. Also provides logging setup, formatting
helpers, and security utilities.

Audio Format (matches Android client):
    16 kHz sample rate, 1 channel (mono), 16-bit signed PCM.
    ~312 KB per 10-second WAV chunk.
"""

import os
import re
import time
import hashlib
import logging
from pathlib import Path

# ══════════════════════════════════════════════════════════════════════════════
# AUDIO CONSTANTS
# ══════════════════════════════════════════════════════════════════════════════

SAMPLE_RATE = 16000          # 16 kHz — good for speech, low bandwidth
NUM_CHANNELS = 1             # Mono
BITS_PER_SAMPLE = 16         # 16-bit
BYTES_PER_SAMPLE = BITS_PER_SAMPLE // 8   # 2 bytes per sample
BLOCK_ALIGN = NUM_CHANNELS * BYTES_PER_SAMPLE  # 2
BYTE_RATE = SAMPLE_RATE * BLOCK_ALIGN          # 32,000 bytes/sec

WAV_HEADER_SIZE = 44         # Standard PCM WAV header

# Default chunk duration in seconds
DEFAULT_CHUNK_DURATION = 10

# ══════════════════════════════════════════════════════════════════════════════
# SERVER CONFIGURATION
# ══════════════════════════════════════════════════════════════════════════════

HOST = os.getenv("AUDIO_HOST", "0.0.0.0")
PORT = int(os.getenv("AUDIO_PORT", "8765"))

# Base directory for all recordings: <project_root>/recordings/
BASE_DIR = Path(__file__).parent.parent
RECORDINGS_DIR = BASE_DIR / "recordings"

# SQLite database file
DATABASE_PATH = BASE_DIR / "server" / "audio_monitor.db"

# Maximum upload size: 10 MB (generous for 10-second 16kHz WAV ≈ 312 KB)
MAX_UPLOAD_SIZE = 10 * 1024 * 1024

# Rate limiting: max uploads per minute per client
MAX_UPLOADS_PER_MINUTE = 60

# ══════════════════════════════════════════════════════════════════════════════
# LOGGING
# ══════════════════════════════════════════════════════════════════════════════


def setup_logging(level: str = "INFO") -> None:
    """Configure structured logging for the entire application."""
    log_level = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s │ %(name)-12s │ %(levelname)-7s │ %(message)s",
        datefmt="%H:%M:%S",
        force=True,
    )
    # Suppress noisy uvicorn access logs
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    """Get a named logger."""
    return logging.getLogger(name)


# ══════════════════════════════════════════════════════════════════════════════
# FORMATTING HELPERS
# ══════════════════════════════════════════════════════════════════════════════


def timestamp() -> str:
    """Generate a filesystem-safe timestamp. Example: '20260722_203000'"""
    return time.strftime("%Y%m%d_%H%M%S")


def format_duration(seconds: float) -> str:
    """
    Format seconds to human-readable duration.
    Examples: 65.3 → '01:05', 3723 → '01:02:03'
    """
    seconds = max(0, int(seconds))
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    secs = seconds % 60
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def format_size(size_bytes: int) -> str:
    """
    Format bytes to human-readable size.
    Examples: 1024 → '1.0 KB', 1572864 → '1.5 MB'
    """
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.2f} GB"


# ══════════════════════════════════════════════════════════════════════════════
# SECURITY & VALIDATION HELPERS
# ══════════════════════════════════════════════════════════════════════════════


def compute_sha256(filepath: Path) -> str:
    """Compute SHA-256 checksum of a file."""
    sha256 = hashlib.sha256()
    with open(filepath, "rb") as f:
        for block in iter(lambda: f.read(8192), b""):
            sha256.update(block)
    return sha256.hexdigest()


def compute_sha256_bytes(data: bytes) -> str:
    """Compute SHA-256 checksum of bytes."""
    return hashlib.sha256(data).hexdigest()


def sanitize_client_name(name: str) -> str:
    """
    Sanitize a client name for safe use as a directory name.
    Removes special characters, limits length, prevents traversal attacks.
    """
    if not name:
        return "unknown"
    # Keep only alphanumeric, hyphens, underscores
    sanitized = re.sub(r'[^a-zA-Z0-9_\-]', '_', name.strip())
    # Remove leading/trailing underscores/hyphens
    sanitized = sanitized.strip('_-')
    # Limit length
    sanitized = sanitized[:64] if sanitized else "unknown"
    # Prevent reserved names
    if sanitized.lower() in ('.', '..', 'con', 'nul', 'prn', 'aux'):
        sanitized = f"client_{sanitized}"
    return sanitized


def validate_uuid(uuid_str: str) -> bool:
    """Validate UUID format (loose — accepts UUID v4 and similar)."""
    if not uuid_str or len(uuid_str) > 64:
        return False
    # Accept standard UUID format and simple hex strings
    pattern = r'^[a-fA-F0-9\-]{8,64}$'
    return bool(re.match(pattern, uuid_str))


def ensure_dir(path: Path) -> Path:
    """Create a directory (and parents) if it doesn't exist."""
    path.mkdir(parents=True, exist_ok=True)
    return path
