"""
websocket.py — WebSocket connection manager and audio relay.

This is the core real-time component of the server. It manages two types
of WebSocket connections:

  STREAMERS (Android clients sending audio):
    → Connect to /ws/stream
    → Send binary messages containing raw 16-bit PCM audio
    → Audio is relayed to all connected listeners

  LISTENERS (Web dashboard clients receiving audio):
    → Connect to /ws/listen
    → Receive binary messages (PCM audio from streamers)
    → Receive JSON messages (status updates)

Data Flow:
  Android App → /ws/stream → ConnectionManager → /ws/listen → Dashboard
                                    │
                                    └→ WavRecorder (if recording)
"""

import time
from typing import Optional
from fastapi import WebSocket

from utils import MAX_STREAMERS, MAX_LISTENERS, get_logger
from recorder import WavRecorder

logger = get_logger("websocket")


class ConnectionManager:
    """
    Manages all WebSocket connections and audio relay.

    This is a singleton — only one instance is created (in main.py)
    and shared across all route handlers.

    Architecture:
      - _streamers dict: conn_id → WebSocket (audio senders)
      - _listeners dict: conn_id → WebSocket (audio receivers)
      - _recorder: WavRecorder instance for server-side recording
      - Audio from ANY streamer is broadcast to ALL listeners
    """

    def __init__(self):
        # ── Active connections ──
        self._streamers: dict[str, WebSocket] = {}
        self._listeners: dict[str, WebSocket] = {}

        # ── Recording ──
        self._recorder = WavRecorder()

        # ── Statistics ──
        self._total_bytes: int = 0        # Total PCM bytes relayed
        self._total_chunks: int = 0       # Total chunks relayed
        self._last_audio_at: Optional[float] = None  # Timestamp of last chunk

        # ── Connection ID counter ──
        self._counter: int = 0

    # ══════════════════════════════════════════════════════════════════════
    # PROPERTIES
    # ══════════════════════════════════════════════════════════════════════

    @property
    def streamer_count(self) -> int:
        """Number of active audio streamer connections."""
        return len(self._streamers)

    @property
    def listener_count(self) -> int:
        """Number of active listener connections."""
        return len(self._listeners)

    @property
    def is_recording(self) -> bool:
        """True if server-side WAV recording is active."""
        return self._recorder.is_active

    @property
    def recording_duration(self) -> float:
        """Duration of current recording in seconds."""
        return self._recorder.duration

    @property
    def has_active_stream(self) -> bool:
        """True if at least one streamer is sending audio."""
        return self.streamer_count > 0

    # ══════════════════════════════════════════════════════════════════════
    # CONNECTION LIFECYCLE
    # ══════════════════════════════════════════════════════════════════════

    def _next_id(self, prefix: str) -> str:
        """Generate a unique connection ID like 'streamer_1' or 'listener_3'."""
        self._counter += 1
        return f"{prefix}_{self._counter}"

    async def connect_streamer(self, websocket: WebSocket) -> Optional[str]:
        """
        Accept a new audio streamer connection.

        Checks the connection limit before accepting. Sends an initial
        status message and notifies all listeners that a stream is active.

        Args:
            websocket: The incoming WebSocket connection.

        Returns:
            Connection ID string, or None if rejected (limit reached).
        """
        # Enforce connection limit to prevent resource exhaustion
        if self.streamer_count >= MAX_STREAMERS:
            logger.warning(
                f"Streamer rejected — limit reached ({MAX_STREAMERS})"
            )
            await websocket.close(code=1008, reason="Too many streamers")
            return None

        await websocket.accept()
        conn_id = self._next_id("streamer")
        self._streamers[conn_id] = websocket

        logger.info(
            f"🎙 Streamer connected: {conn_id} "
            f"[total: {self.streamer_count}]"
        )

        # Notify all dashboard listeners that a stream is now active
        await self._broadcast_json({
            "type": "stream_status",
            "active": True,
            "streamers": self.streamer_count,
            "listeners": self.listener_count,
        })

        return conn_id

    async def connect_listener(self, websocket: WebSocket) -> Optional[str]:
        """
        Accept a new dashboard listener connection.

        Sends an initialization message with the current server state
        so the dashboard can immediately update its UI.

        Args:
            websocket: The incoming WebSocket connection.

        Returns:
            Connection ID string, or None if rejected.
        """
        if self.listener_count >= MAX_LISTENERS:
            logger.warning(
                f"Listener rejected — limit reached ({MAX_LISTENERS})"
            )
            await websocket.close(code=1008, reason="Too many listeners")
            return None

        await websocket.accept()
        conn_id = self._next_id("listener")
        self._listeners[conn_id] = websocket

        logger.info(
            f"👂 Listener connected: {conn_id} "
            f"[total: {self.listener_count}]"
        )

        # Send current server state to the newly connected listener
        # This lets the dashboard render the correct UI immediately
        await websocket.send_json({
            "type": "init",
            "stream_active": self.has_active_stream,
            "streamers": self.streamer_count,
            "listeners": self.listener_count,
            "recording": self.is_recording,
            "recording_duration": round(self.recording_duration, 1),
        })

        return conn_id

    def disconnect_streamer(self, conn_id: str) -> None:
        """Remove a streamer from active connections."""
        if conn_id in self._streamers:
            del self._streamers[conn_id]
            logger.info(
                f"🎙 Streamer disconnected: {conn_id} "
                f"[remaining: {self.streamer_count}]"
            )

    def disconnect_listener(self, conn_id: str) -> None:
        """Remove a listener from active connections."""
        if conn_id in self._listeners:
            del self._listeners[conn_id]
            logger.info(
                f"👂 Listener disconnected: {conn_id} "
                f"[remaining: {self.listener_count}]"
            )

    # ══════════════════════════════════════════════════════════════════════
    # AUDIO RELAY
    # ══════════════════════════════════════════════════════════════════════

    async def relay_audio(self, pcm_data: bytes) -> int:
        """
        Relay a PCM audio chunk from a streamer to all listeners.

        This is called once per audio chunk received from any streamer.
        The chunk is:
          1. Written to the WAV recorder (if recording is active)
          2. Broadcast as binary data to every connected listener

        Args:
            pcm_data: Raw 16-bit PCM audio bytes.

        Returns:
            Number of listeners the chunk was successfully sent to.
        """
        if not pcm_data:
            return 0

        # Update stats
        self._total_bytes += len(pcm_data)
        self._total_chunks += 1
        self._last_audio_at = time.time()

        # Write to WAV file if recording is active
        if self._recorder.is_active:
            self._recorder.write(pcm_data)

        # Broadcast to all listeners
        if not self._listeners:
            return 0

        sent = 0
        dead_connections = []

        for conn_id, ws in self._listeners.items():
            try:
                await ws.send_bytes(pcm_data)
                sent += 1
            except Exception:
                # Connection is dead — mark for removal
                # We don't remove during iteration to avoid dict size change
                dead_connections.append(conn_id)

        # Clean up dead connections
        for conn_id in dead_connections:
            self.disconnect_listener(conn_id)
            logger.warning(f"Dead listener removed: {conn_id}")

        return sent

    # ══════════════════════════════════════════════════════════════════════
    # RECORDING CONTROL
    # ══════════════════════════════════════════════════════════════════════

    def start_recording(self) -> dict:
        """
        Start recording incoming audio to a WAV file.

        Returns:
            Status dict with recording info.
        """
        if self._recorder.is_active:
            return {
                "status": "already_recording",
                "filename": self._recorder.filepath.name if self._recorder.filepath else None,
                "duration": round(self._recorder.duration, 1),
            }

        try:
            filepath = self._recorder.start()
            return {
                "status": "started",
                "filename": filepath.name,
            }
        except Exception as e:
            logger.error(f"Failed to start recording: {e}")
            return {"status": "error", "message": str(e)}

    def stop_recording(self) -> dict:
        """
        Stop recording and finalize the WAV file.

        Returns:
            Status dict with saved file info.
        """
        if not self._recorder.is_active:
            return {"status": "not_recording"}

        try:
            info = self._recorder.stop()
            if info is None:
                return {"status": "error", "message": "Failed to finalize"}
            return {
                "status": "stopped",
                "recording": info.to_dict(),
            }
        except Exception as e:
            logger.error(f"Failed to stop recording: {e}")
            return {"status": "error", "message": str(e)}

    def cancel_recording(self) -> dict:
        """Cancel recording and delete the partial file."""
        if not self._recorder.is_active:
            return {"status": "not_recording"}

        self._recorder.cancel()
        return {"status": "cancelled"}

    # ══════════════════════════════════════════════════════════════════════
    # STATUS & NOTIFICATIONS
    # ══════════════════════════════════════════════════════════════════════

    def get_status(self) -> dict:
        """
        Get the full server status as a JSON-serializable dict.

        This is used by:
          - The /api/status REST endpoint
          - The init message sent to new listeners
        """
        return {
            "streamers": self.streamer_count,
            "listeners": self.listener_count,
            "stream_active": self.has_active_stream,
            "recording": self.is_recording,
            "recording_duration": round(self.recording_duration, 1),
            "total_bytes_relayed": self._total_bytes,
            "total_chunks_relayed": self._total_chunks,
        }

    async def notify_stream_ended(self) -> None:
        """
        Notify all listeners that all streamers have disconnected.

        The dashboard uses this to show "No active stream" and stop
        the waveform animation.
        """
        await self._broadcast_json({
            "type": "stream_status",
            "active": False,
            "streamers": 0,
            "listeners": self.listener_count,
        })

    async def notify_recording_state(self) -> None:
        """
        Broadcast the current recording state to all listeners.

        Called after start/stop/cancel recording so dashboards update
        their record button and timer in real-time.
        """
        await self._broadcast_json({
            "type": "recording_status",
            "recording": self.is_recording,
            "duration": round(self.recording_duration, 1),
        })

    async def _broadcast_json(self, data: dict) -> None:
        """
        Send a JSON message to ALL connected listeners.

        Dead connections are silently removed.
        """
        dead = []
        for conn_id, ws in self._listeners.items():
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(conn_id)

        for conn_id in dead:
            self.disconnect_listener(conn_id)


# ══════════════════════════════════════════════════════════════════════════════
# SINGLETON INSTANCE
# ══════════════════════════════════════════════════════════════════════════════
# Create a single ConnectionManager instance shared by all route handlers.
# Import this in main.py: from websocket import manager
manager = ConnectionManager()
