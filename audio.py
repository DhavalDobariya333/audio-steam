"""
audio.py — WAV header generation and PCM audio processing.

This module handles the low-level audio format operations:
  - Building correct 44-byte WAV file headers (RIFF/WAVE/fmt/data chunks)
  - Validating incoming PCM data chunks
  - Computing audio duration from byte counts

WAV File Structure (44-byte header for PCM):
┌──────────────────────────────────────────┐
│ Bytes 0-3:   "RIFF"                      │  RIFF chunk descriptor
│ Bytes 4-7:   File size - 8               │
│ Bytes 8-11:  "WAVE"                      │
├──────────────────────────────────────────┤
│ Bytes 12-15: "fmt "                      │  Format sub-chunk
│ Bytes 16-19: 16 (sub-chunk size)         │
│ Bytes 20-21: 1 (PCM format)             │
│ Bytes 22-23: 1 (mono)                    │
│ Bytes 24-27: 16000 (sample rate)         │
│ Bytes 28-31: 32000 (byte rate)           │
│ Bytes 32-33: 2 (block align)            │
│ Bytes 34-35: 16 (bits per sample)        │
├──────────────────────────────────────────┤
│ Bytes 36-39: "data"                      │  Data sub-chunk
│ Bytes 40-43: Data size in bytes          │
├──────────────────────────────────────────┤
│ Bytes 44+:   Raw PCM audio data          │
└──────────────────────────────────────────┘
"""

import struct
from utils import (
    SAMPLE_RATE,
    NUM_CHANNELS,
    BITS_PER_SAMPLE,
    BYTES_PER_SAMPLE,
    BLOCK_ALIGN,
    BYTE_RATE,
    WAV_HEADER_SIZE,
    get_logger,
)

logger = get_logger("audio")


def build_wav_header(data_size: int = 0) -> bytes:
    """
    Build a 44-byte WAV file header for our audio format.

    The header follows the canonical RIFF WAVE PCM format.
    When starting a recording, call with data_size=0 to write a placeholder.
    When finalizing, call again with the actual data_size and seek back
    to byte 0 to overwrite the placeholder header.

    Args:
        data_size: Total size of the raw PCM data section in bytes.
                   Use 0 for a placeholder header.

    Returns:
        44-byte WAV header as a bytes object.
    """
    # RIFF chunk size = total file size minus 8 bytes
    # (excludes the "RIFF" marker and this size field itself)
    riff_chunk_size = data_size + WAV_HEADER_SIZE - 8

    header = struct.pack(
        "<"          # Little-endian byte order
        "4s"         # ChunkID: "RIFF"
        "I"          # ChunkSize: file size - 8
        "4s"         # Format: "WAVE"
        "4s"         # Subchunk1ID: "fmt "
        "I"          # Subchunk1Size: 16 for PCM
        "H"          # AudioFormat: 1 = PCM (no compression)
        "H"          # NumChannels: 1 = Mono
        "I"          # SampleRate: 16000
        "I"          # ByteRate: SampleRate × BlockAlign
        "H"          # BlockAlign: NumChannels × BytesPerSample
        "H"          # BitsPerSample: 16
        "4s"         # Subchunk2ID: "data"
        "I",         # Subchunk2Size: number of bytes of PCM data
        b"RIFF",
        riff_chunk_size,
        b"WAVE",
        b"fmt ",
        16,                 # PCM format chunk is always 16 bytes
        1,                  # Audio format: 1 = PCM
        NUM_CHANNELS,       # 1 channel (mono)
        SAMPLE_RATE,        # 16000 Hz
        BYTE_RATE,          # 32000 bytes/sec
        BLOCK_ALIGN,        # 2 bytes per sample frame
        BITS_PER_SAMPLE,    # 16 bits per sample
        b"data",
        data_size,
    )

    return header


def validate_pcm_chunk(data: bytes) -> bool:
    """
    Validate that a received PCM chunk is well-formed.

    Checks:
      1. Chunk is not empty
      2. Chunk length is a multiple of BYTES_PER_SAMPLE (2 bytes)
         since we're dealing with 16-bit audio

    We intentionally do NOT enforce a fixed chunk size because the Android
    client may send variable-sized chunks depending on AudioRecord buffer fills.

    Args:
        data: Raw bytes received from the WebSocket.

    Returns:
        True if the chunk is valid PCM data, False otherwise.
    """
    if not data or len(data) == 0:
        return False

    if len(data) % BYTES_PER_SAMPLE != 0:
        logger.warning(
            f"Invalid PCM chunk: {len(data)} bytes is not a multiple "
            f"of {BYTES_PER_SAMPLE} (sample size)"
        )
        return False

    return True


def calculate_duration(byte_count: int) -> float:
    """
    Calculate audio duration in seconds from a PCM byte count.

    Args:
        byte_count: Number of raw PCM bytes.

    Returns:
        Duration in seconds.
    """
    if BYTE_RATE == 0:
        return 0.0
    return byte_count / BYTE_RATE


def calculate_sample_count(byte_count: int) -> int:
    """
    Calculate the number of audio samples from a PCM byte count.

    Args:
        byte_count: Number of raw PCM bytes.

    Returns:
        Number of individual audio samples.
    """
    return byte_count // BYTES_PER_SAMPLE
