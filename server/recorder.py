"""
recorder.py — WAV recording manager.

Handles the complete lifecycle of recording audio streams to WAV files:
  1. Start: Creates a new WAV file with a placeholder 44-byte header.
  2. Write: Appends raw PCM chunks to the file as they arrive.
  3. Stop: Seeks back to byte 0, overwrites the header with correct sizes.

The header finalization step is critical — without it, audio players won't
know the file length and may refuse to play the file, or play garbage.

Also provides a RecordingManager for listing, downloading, and deleting
saved recordings from the recordings/ directory.
"""

import os
import time
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field

from utils import (
    RECORDINGS_DIR,
    BYTE_RATE,
    WAV_HEADER_SIZE,
    MAX_RECORDING_SECONDS,
    ensure_recordings_dir,
    timestamp,
    format_duration,
    format_size,
    get_logger,
)
from audio import build_wav_header, validate_pcm_chunk, calculate_duration

logger = get_logger("recorder")


# ══════════════════════════════════════════════════════════════════════════════
# DATA CLASSES
# ══════════════════════════════════════════════════════════════════════════════


@dataclass
class RecordingInfo:
    """Metadata about a saved recording file."""
    filename: str
    filepath: str
    size_bytes: int
    size_human: str
    duration_seconds: float
    duration_human: str
    created_at: str

    def to_dict(self) -> dict:
        """Convert to a JSON-serializable dictionary."""
        return {
            "filename": self.filename,
            "filepath": self.filepath,
            "size_bytes": self.size_bytes,
            "size_human": self.size_human,
            "duration_seconds": round(self.duration_seconds, 1),
            "duration_human": self.duration_human,
            "created_at": self.created_at,
        }


# ══════════════════════════════════════════════════════════════════════════════
# WAV RECORDER
# ══════════════════════════════════════════════════════════════════════════════


class WavRecorder:
    """
    Records incoming PCM audio to a WAV file on disk.

    Lifecycle:
        recorder = WavRecorder()
        recorder.start()                    # Creates file, writes placeholder header
        recorder.write(pcm_bytes)           # Append chunks (call many times)
        recorder.write(pcm_bytes)
        info = recorder.stop()              # Finalize header, close file
        # info.filepath contains the saved WAV file path

    Thread Safety:
        This class is NOT thread-safe. It's designed to be called from
        a single asyncio task (the WebSocket relay loop).
    """

    def __init__(self):
        self._file = None                          # Open file handle
        self._filepath: Optional[Path] = None      # Current recording path
        self._data_size: int = 0                    # Total PCM bytes written
        self._started_at: Optional[float] = None    # Wall-clock start time

    # ── Properties ─────────────────────────────────────────────────────────

    @property
    def is_active(self) -> bool:
        """True if a recording is currently in progress."""
        return self._file is not None

    @property
    def filepath(self) -> Optional[Path]:
        """Path to the current recording file, or None."""
        return self._filepath

    @property
    def duration(self) -> float:
        """Duration of recorded audio in seconds (based on bytes written)."""
        return calculate_duration(self._data_size)

    @property
    def elapsed(self) -> float:
        """Wall-clock seconds since recording started."""
        if self._started_at is None:
            return 0.0
        return time.time() - self._started_at

    @property
    def data_size(self) -> int:
        """Total PCM bytes written so far."""
        return self._data_size

    # ── Lifecycle Methods ──────────────────────────────────────────────────

    def start(self) -> Path:
        """
        Start a new recording.

        Creates a WAV file in the recordings directory with a placeholder
        header. The header will be finalized when stop() is called.

        Returns:
            Path to the new WAV file.

        Raises:
            RuntimeError: If a recording is already in progress.
        """
        if self.is_active:
            raise RuntimeError(
                "Recording already in progress. Call stop() first."
            )

        # Ensure the recordings directory exists
        ensure_recordings_dir()

        # Generate a unique filename with timestamp
        ts = timestamp()
        self._filepath = RECORDINGS_DIR / f"recording_{ts}.wav"
        self._data_size = 0
        self._started_at = time.time()

        # Open the file and write a placeholder WAV header
        # The data_size field is 0 — we'll overwrite it in stop()
        self._file = open(self._filepath, "wb")
        self._file.write(build_wav_header(data_size=0))
        self._file.flush()

        logger.info(f"▶ Recording started → {self._filepath.name}")
        return self._filepath

    def write(self, pcm_data: bytes) -> int:
        """
        Append a chunk of PCM audio data to the recording.

        Args:
            pcm_data: Raw 16-bit signed PCM bytes (little-endian).

        Returns:
            Number of bytes written (0 if skipped).

        Raises:
            RuntimeError: If no recording is in progress.
        """
        if not self.is_active:
            raise RuntimeError("No recording in progress. Call start() first.")

        # Validate the chunk format
        if not validate_pcm_chunk(pcm_data):
            return 0

        # Safety: check if we've exceeded the maximum recording duration
        if self.duration >= MAX_RECORDING_SECONDS:
            logger.warning(
                f"Max recording duration ({MAX_RECORDING_SECONDS}s) reached. "
                f"Auto-stopping recording."
            )
            self.stop()
            return 0

        # Write PCM data to file
        self._file.write(pcm_data)
        self._data_size += len(pcm_data)

        # Flush to disk every ~1 second of audio (32KB) to prevent data loss
        # on unexpected shutdown. This is a trade-off: more frequent flushes
        # are safer but slightly slower on Termux's flash storage.
        if self._data_size % BYTE_RATE < len(pcm_data):
            self._file.flush()

        return len(pcm_data)

    def stop(self) -> Optional[RecordingInfo]:
        """
        Stop recording and finalize the WAV file.

        This is the critical step: we seek back to byte 0 and overwrite
        the placeholder header with the correct RIFF chunk size and data
        chunk size. Without this, the WAV file won't play correctly.

        Returns:
            RecordingInfo with metadata about the saved file,
            or None if no recording was in progress.
        """
        if not self.is_active:
            logger.warning("stop() called but no recording in progress")
            return None

        filepath = self._filepath
        data_size = self._data_size

        # ── Finalize the WAV header ──
        # Seek to the beginning and overwrite with correct sizes
        self._file.seek(0)
        self._file.write(build_wav_header(data_size=data_size))
        self._file.flush()
        self._file.close()

        # Calculate metadata
        duration = calculate_duration(data_size)
        total_size = data_size + WAV_HEADER_SIZE

        # Build recording info
        info = RecordingInfo(
            filename=filepath.name,
            filepath=str(filepath),
            size_bytes=total_size,
            size_human=format_size(total_size),
            duration_seconds=duration,
            duration_human=format_duration(duration),
            created_at=time.strftime(
                "%Y-%m-%d %H:%M:%S", time.localtime(filepath.stat().st_mtime)
            ),
        )

        # Reset state
        self._file = None
        self._filepath = None
        self._data_size = 0
        self._started_at = None

        logger.info(
            f"■ Recording saved → {info.filename} "
            f"({info.duration_human}, {info.size_human})"
        )
        return info

    def cancel(self) -> None:
        """
        Cancel the current recording and delete the partial file.

        Use this when the user explicitly cancels, or if an error
        makes the recording unusable.
        """
        if not self.is_active:
            return

        filepath = self._filepath

        # Close and clean up
        self._file.close()
        self._file = None
        self._filepath = None
        self._data_size = 0
        self._started_at = None

        # Delete the incomplete file
        try:
            if filepath and filepath.exists():
                filepath.unlink()
                logger.info(f"✕ Recording cancelled, deleted → {filepath.name}")
        except OSError as e:
            logger.error(f"Failed to delete cancelled recording: {e}")


# ══════════════════════════════════════════════════════════════════════════════
# RECORDING MANAGER
# ══════════════════════════════════════════════════════════════════════════════


class RecordingManager:
    """
    Manages saved recording files in the recordings/ directory.

    Provides listing, deletion, and path resolution for the REST API.
    """

    def __init__(self, directory: Path = RECORDINGS_DIR):
        self._dir = directory

    def list_recordings(self) -> list[RecordingInfo]:
        """
        List all saved WAV recordings, sorted by newest first.

        Returns:
            List of RecordingInfo objects.
        """
        ensure_recordings_dir()
        recordings = []

        # Glob for .wav files and sort by modification time (newest first)
        for f in sorted(self._dir.glob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                stat = f.stat()
                data_size = max(0, stat.st_size - WAV_HEADER_SIZE)
                duration = calculate_duration(data_size)

                recordings.append(RecordingInfo(
                    filename=f.name,
                    filepath=str(f),
                    size_bytes=stat.st_size,
                    size_human=format_size(stat.st_size),
                    duration_seconds=duration,
                    duration_human=format_duration(duration),
                    created_at=time.strftime(
                        "%Y-%m-%d %H:%M:%S", time.localtime(stat.st_mtime)
                    ),
                ))
            except OSError as e:
                logger.error(f"Error reading file {f.name}: {e}")

        return recordings

    def get_filepath(self, filename: str) -> Optional[Path]:
        """
        Resolve a filename to a full path, with directory traversal protection.

        Args:
            filename: The WAV filename (e.g., "recording_20260721_211500.wav").

        Returns:
            Full Path to the file if it exists and is safe, None otherwise.
        """
        filepath = self._dir / filename

        # Security: prevent directory traversal attacks
        # Resolve both paths and check the file is inside our recordings dir
        try:
            resolved = filepath.resolve()
            if not str(resolved).startswith(str(self._dir.resolve())):
                logger.warning(f"Directory traversal blocked: {filename}")
                return None
        except (OSError, ValueError):
            return None

        # Check file exists and is a WAV
        if not resolved.exists() or resolved.suffix.lower() != ".wav":
            return None

        return resolved

    def delete(self, filename: str) -> bool:
        """
        Delete a recording by filename.

        Args:
            filename: The WAV filename to delete.

        Returns:
            True if the file was deleted, False otherwise.
        """
        filepath = self.get_filepath(filename)

        if filepath is None:
            logger.warning(f"Delete failed — file not found: {filename}")
            return False

        try:
            filepath.unlink()
            logger.info(f"Deleted recording: {filename}")
            return True
        except OSError as e:
            logger.error(f"Delete failed for {filename}: {e}")
            return False

    def get_total_size(self) -> int:
        """Get total size of all recordings in bytes."""
        ensure_recordings_dir()
        return sum(f.stat().st_size for f in self._dir.glob("*.wav"))
