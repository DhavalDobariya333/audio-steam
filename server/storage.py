"""
storage.py — File storage manager for recorded audio chunks.

Handles the organized storage of uploaded WAV files on disk:
  - Directory structure: recordings/{client_name}/{date}/{HH-MM-SS}.wav
  - WAV file validation (header check, size sanity)
  - Checksum verification (SHA-256)
  - Disk space monitoring
  - File deletion with database cleanup

This module never touches the database directly — it only manages
files on disk. The caller (main.py) coordinates between storage
and database operations.
"""

import os
import struct
import shutil
import time
from pathlib import Path
from typing import Optional

from utils import (
    RECORDINGS_DIR,
    WAV_HEADER_SIZE,
    MAX_UPLOAD_SIZE,
    SAMPLE_RATE,
    BYTE_RATE,
    compute_sha256,
    sanitize_client_name,
    format_size,
    format_duration,
    ensure_dir,
    get_logger,
)

logger = get_logger("storage")


class StorageManager:
    """
    Manages the on-disk storage of audio recording files.

    File Organization:
        recordings/
        └── John-Galaxy-S21/
            ├── 2026-07-22/
            │   ├── 10-30-00.wav
            │   ├── 10-30-10.wav
            │   └── ...
            └── 2026-07-23/
                └── ...
    """

    def __init__(self, base_dir: Path = RECORDINGS_DIR):
        self._base_dir = base_dir
        ensure_dir(self._base_dir)

    # ══════════════════════════════════════════════════════════════════════
    # FILE STORAGE
    # ══════════════════════════════════════════════════════════════════════

    def save_recording(self, file_data: bytes, client_name: str,
                       timestamp_str: str = None) -> dict:
        """
        Save a WAV file to the organized directory structure.

        Args:
            file_data: Raw WAV file bytes.
            client_name: The client's name (will be sanitized).
            timestamp_str: Optional ISO timestamp for naming.
                          Uses server time if not provided.

        Returns:
            Dict with filepath, filename, file_size.

        Raises:
            ValueError: If the file is invalid.
        """
        # Sanitize client name for safe directory naming
        safe_name = sanitize_client_name(client_name)

        # Parse timestamp for directory/file naming
        if timestamp_str:
            try:
                # Parse ISO format: "2026-07-22T10:30:00" or similar
                # Extract date and time parts
                clean = timestamp_str.replace("T", " ").split(".")[0]
                parts = clean.split(" ")
                date_part = parts[0]  # "2026-07-22"
                time_part = parts[1] if len(parts) > 1 else time.strftime("%H-%M-%S")
                time_part = time_part.replace(":", "-")
            except (IndexError, ValueError):
                date_part = time.strftime("%Y-%m-%d")
                time_part = time.strftime("%H-%M-%S")
        else:
            date_part = time.strftime("%Y-%m-%d")
            time_part = time.strftime("%H-%M-%S")

        # Create directory structure: recordings/{client}/{date}/
        client_dir = self._base_dir / safe_name / date_part
        ensure_dir(client_dir)

        # Generate filename — avoid collisions with counter
        filename = f"{time_part}.wav"
        filepath = client_dir / filename
        counter = 1
        while filepath.exists():
            filename = f"{time_part}_{counter}.wav"
            filepath = client_dir / filename
            counter += 1

        # Write file to disk
        with open(filepath, "wb") as f:
            f.write(file_data)

        logger.info(
            f"Saved recording: {safe_name}/{date_part}/{filename} "
            f"({format_size(len(file_data))})"
        )

        return {
            "filepath": str(filepath),
            "filename": filename,
            "file_size": len(file_data),
            "client_dir": safe_name,
            "date_dir": date_part,
        }

    def combine_wav_files(self, filepaths: list[str]) -> bytes:
        """
        Combine multiple PCM WAV files into a single merged WAV file payload.
        Strips WAV headers from chunks 2..N and updates total data size in the merged header.
        """
        from utils import NUM_CHANNELS, BITS_PER_SAMPLE, BLOCK_ALIGN

        valid_paths = []
        for fp in filepaths:
            path = self.get_file(fp)
            if path:
                valid_paths.append(path)

        if not valid_paths:
            raise ValueError("No valid audio files found to combine")

        total_pcm_bytes = 0
        pcm_chunks = []

        for p in valid_paths:
            try:
                with open(p, "rb") as f:
                    data = f.read()
                    if len(data) > WAV_HEADER_SIZE:
                        pcm = data[WAV_HEADER_SIZE:]
                        pcm_chunks.append(pcm)
                        total_pcm_bytes += len(pcm)
            except OSError as e:
                logger.warning(f"Error reading {p} for combine: {e}")

        if not pcm_chunks:
            raise ValueError("No audio data extracted from files")

        # Build 44-byte WAV header for combined payload
        header = bytearray(WAV_HEADER_SIZE)
        total_file_size = total_pcm_bytes + 36

        # RIFF header
        header[0:4] = b"RIFF"
        struct.pack_into("<I", header, 4, total_file_size)
        header[8:12] = b"WAVE"

        # fmt chunk
        header[12:16] = b"fmt "
        struct.pack_into("<I", header, 16, 16)      # Subchunk1Size
        struct.pack_into("<H", header, 20, 1)       # AudioFormat (1 = PCM)
        struct.pack_into("<H", header, 22, NUM_CHANNELS)
        struct.pack_into("<I", header, 24, SAMPLE_RATE)
        struct.pack_into("<I", header, 28, BYTE_RATE)
        struct.pack_into("<H", header, 32, BLOCK_ALIGN)
        struct.pack_into("<H", header, 34, BITS_PER_SAMPLE)

        # data chunk
        header[36:40] = b"data"
        struct.pack_into("<I", header, 40, total_pcm_bytes)

        return bytes(header) + b"".join(pcm_chunks)

    # ══════════════════════════════════════════════════════════════════════
    # VALIDATION
    # ══════════════════════════════════════════════════════════════════════

    def validate_wav(self, file_data: bytes) -> dict:
        """
        Validate a WAV file's header and extract metadata.

        Returns:
            Dict with validation result and extracted metadata.

        Raises:
            ValueError: If the file is invalid or corrupt.
        """
        if len(file_data) < WAV_HEADER_SIZE:
            raise ValueError(
                f"File too small ({len(file_data)} bytes, "
                f"minimum {WAV_HEADER_SIZE} bytes for WAV header)"
            )

        if len(file_data) > MAX_UPLOAD_SIZE:
            raise ValueError(
                f"File too large ({format_size(len(file_data))}, "
                f"maximum {format_size(MAX_UPLOAD_SIZE)})"
            )

        # Parse WAV header
        try:
            riff = file_data[0:4]
            if riff != b"RIFF":
                raise ValueError("Not a valid WAV file: missing RIFF header")

            wave = file_data[8:12]
            if wave != b"WAVE":
                raise ValueError("Not a valid WAV file: missing WAVE marker")

            fmt = file_data[12:16]
            if fmt != b"fmt ":
                raise ValueError("Not a valid WAV file: missing fmt chunk")

            # Extract audio parameters from fmt chunk
            (audio_format, num_channels, sample_rate, byte_rate,
             block_align, bits_per_sample) = struct.unpack_from(
                "<HHIIHH", file_data, 20
            )

            if audio_format != 1:
                raise ValueError(
                    f"Unsupported audio format: {audio_format} "
                    f"(only PCM/1 is supported)"
                )

            # Calculate duration from data size
            data_size = len(file_data) - WAV_HEADER_SIZE
            if byte_rate > 0:
                duration = data_size / byte_rate
            else:
                duration = 0.0

        except struct.error as e:
            raise ValueError(f"Corrupt WAV header: {e}")

        return {
            "valid": True,
            "sample_rate": sample_rate,
            "channels": num_channels,
            "bits_per_sample": bits_per_sample,
            "byte_rate": byte_rate,
            "data_size": data_size,
            "duration": round(duration, 2),
            "file_size": len(file_data),
        }

    def verify_checksum(self, file_data: bytes, expected_checksum: str) -> bool:
        """
        Verify SHA-256 checksum of file data.
        Returns True if checksum matches, False otherwise.
        """
        if not expected_checksum:
            # If no checksum provided, skip verification
            return True
        from utils import compute_sha256_bytes
        actual = compute_sha256_bytes(file_data)
        return actual == expected_checksum

    # ══════════════════════════════════════════════════════════════════════
    # FILE MANAGEMENT
    # ══════════════════════════════════════════════════════════════════════

    def delete_file(self, filepath: str) -> bool:
        """
        Delete a recording file from disk.
        Returns True if deleted, False if not found.
        """
        path = Path(filepath)

        # Security: verify path is inside our recordings directory
        try:
            resolved = path.resolve()
            base_resolved = self._base_dir.resolve()
            if not str(resolved).startswith(str(base_resolved)):
                logger.warning(f"Path traversal blocked: {filepath}")
                return False
        except (OSError, ValueError):
            return False

        if not path.exists():
            return False

        try:
            path.unlink()
            logger.info(f"Deleted file: {filepath}")

            # Clean up empty parent directories
            self._cleanup_empty_dirs(path.parent)
            return True
        except OSError as e:
            logger.error(f"Failed to delete {filepath}: {e}")
            return False

    def _cleanup_empty_dirs(self, directory: Path) -> None:
        """Remove empty parent directories up to the base recordings dir."""
        try:
            base_resolved = self._base_dir.resolve()
            current = directory.resolve()

            while (current != base_resolved and
                   str(current).startswith(str(base_resolved))):
                if current.exists() and not any(current.iterdir()):
                    current.rmdir()
                    logger.debug(f"Removed empty directory: {current}")
                    current = current.parent
                else:
                    break
        except OSError:
            pass  # Directory not empty or permission error — fine

    def get_file(self, filepath: str) -> Optional[Path]:
        """
        Resolve a filepath with security validation.
        Returns Path if file exists and is safe, None otherwise.
        """
        path = Path(filepath)

        try:
            resolved = path.resolve()
            base_resolved = self._base_dir.resolve()
            if not str(resolved).startswith(str(base_resolved)):
                logger.warning(f"Path traversal blocked: {filepath}")
                return None
        except (OSError, ValueError):
            return None

        if not resolved.exists() or not resolved.is_file():
            return None

        return resolved

    # ══════════════════════════════════════════════════════════════════════
    # DISK SPACE MONITORING
    # ══════════════════════════════════════════════════════════════════════

    def get_storage_info(self) -> dict:
        """Get storage usage information."""
        ensure_dir(self._base_dir)

        # Calculate total recordings size
        recordings_bytes = 0
        recording_count = 0
        try:
            for f in self._base_dir.rglob("*.wav"):
                try:
                    recordings_bytes += f.stat().st_size
                    recording_count += 1
                except OSError:
                    pass
        except OSError:
            pass

        # Get disk space info
        try:
            total, used, free = shutil.disk_usage(self._base_dir)
        except OSError:
            total, used, free = 0, 0, 0

        return {
            "recordings_bytes": recordings_bytes,
            "recordings_human": format_size(recordings_bytes),
            "recording_files": recording_count,
            "free_bytes": free,
            "free_human": format_size(free),
            "total_bytes": total,
            "total_human": format_size(total),
            "used_percent": round((used / total * 100), 1) if total else 0,
        }

    def get_client_dirs(self) -> list[str]:
        """List all client directories in the recordings folder."""
        ensure_dir(self._base_dir)
        dirs = []
        try:
            for item in self._base_dir.iterdir():
                if item.is_dir() and not item.name.startswith('.'):
                    dirs.append(item.name)
        except OSError:
            pass
        return sorted(dirs)
