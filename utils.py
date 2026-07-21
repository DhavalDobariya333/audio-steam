"""
utils.py — Shared constants, configuration, and utility functions.

This module centralizes all configuration values so they can be imported
by any other module without circular dependencies. It also sets up
structured logging for the entire server.

Audio Format:
    16 kHz sample rate, 1 channel (mono), 16-bit signed PCM (little-endian).
    This yields ~32 KB/s of raw audio — ideal for speech over mobile networks.
"""

import os
import logging
import time
from pathlib import Path

# ══════════════════════════════════════════════════════════════════════════════
# AUDIO CONSTANTS
# ══════════════════════════════════════════════════════════════════════════════

SAMPLE_RATE = 16000          # 16 kHz — good for speech, low bandwidth
NUM_CHANNELS = 1             # Mono — halves data vs stereo
BITS_PER_SAMPLE = 16         # 16-bit — standard quality
BYTES_PER_SAMPLE = BITS_PER_SAMPLE // 8   # 2 bytes per sample
BLOCK_ALIGN = NUM_CHANNELS * BYTES_PER_SAMPLE  # 2 bytes per block
BYTE_RATE = SAMPLE_RATE * BLOCK_ALIGN          # 32,000 bytes/second

# WAV file header is always 44 bytes for PCM format
WAV_HEADER_SIZE = 44

# Recommended chunk size for streaming:
# 1024 samples × 2 bytes = 2048 bytes per chunk
# At 16kHz, this is 64ms of audio — good balance of latency vs overhead
CHUNK_SAMPLES = 1024
CHUNK_BYTES = CHUNK_SAMPLES * BYTES_PER_SAMPLE
CHUNK_DURATION_MS = (CHUNK_SAMPLES / SAMPLE_RATE) * 1000  # ~64ms

# ══════════════════════════════════════════════════════════════════════════════
# SERVER CONFIGURATION
# ══════════════════════════════════════════════════════════════════════════════

# Host and port — bind to all interfaces so Cloudflare Tunnel can reach us
HOST = os.getenv("AUDIO_HOST", "0.0.0.0")
PORT = int(os.getenv("AUDIO_PORT", "8765"))

# Directory where WAV recordings are saved
# Resolves to: <project_root>/recordings/
RECORDINGS_DIR = Path(__file__).parent.parent / "recordings"

# Maximum simultaneous streamer connections (prevent abuse)
MAX_STREAMERS = 5

# Maximum simultaneous listener connections
MAX_LISTENERS = 20

# Maximum recording duration in seconds (1 hour) — prevents disk fill
MAX_RECORDING_SECONDS = 3600

# ══════════════════════════════════════════════════════════════════════════════
# LOGGING SETUP
# ══════════════════════════════════════════════════════════════════════════════


def setup_logging(level: str = "INFO") -> None:
    """
    Configure structured logging for the entire application.

    Uses a consistent format with timestamps and module names.
    Call this once at startup (in main.py).

    Args:
        level: Logging level string ("DEBUG", "INFO", "WARNING", "ERROR").
    """
    log_level = getattr(logging, level.upper(), logging.INFO)

    logging.basicConfig(
        level=log_level,
        format="%(asctime)s │ %(name)-12s │ %(levelname)-7s │ %(message)s",
        datefmt="%H:%M:%S",
        force=True,  # Override any existing config
    )

    # Suppress noisy uvicorn access logs (they flood the terminal)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    """
    Get a named logger. Use this instead of logging.getLogger() directly
    so all loggers share the same formatting.

    Args:
        name: Module name (e.g., "websocket", "recorder").

    Returns:
        Configured Logger instance.
    """
    return logging.getLogger(name)


# ══════════════════════════════════════════════════════════════════════════════
# UTILITY FUNCTIONS
# ══════════════════════════════════════════════════════════════════════════════


def timestamp() -> str:
    """
    Generate a filesystem-safe timestamp string.
    Example: "20260721_211500"
    """
    return time.strftime("%Y%m%d_%H%M%S")


def format_duration(seconds: float) -> str:
    """
    Format a duration in seconds to a human-readable string.

    Examples:
        format_duration(65.3)  → "01:05"
        format_duration(3723)  → "01:02:03"

    Args:
        seconds: Duration in seconds.

    Returns:
        Formatted duration string (MM:SS or HH:MM:SS).
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
    Format a byte count to a human-readable size string.

    Examples:
        format_size(1024)     → "1.0 KB"
        format_size(1572864)  → "1.5 MB"

    Args:
        size_bytes: Size in bytes.

    Returns:
        Formatted size string.
    """
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.1f} MB"


def ensure_recordings_dir() -> Path:
    """
    Create the recordings directory if it doesn't exist.

    Returns:
        Path to the recordings directory.
    """
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    return RECORDINGS_DIR
