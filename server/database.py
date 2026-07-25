"""
database.py — SQLite database manager for the audio monitoring system.

Manages all persistent state:
  - Clients: registered devices, their stats, online status
  - Recordings: uploaded audio chunks with full metadata
  - Upload log: history of every upload attempt
  - Connection history: when clients come online/offline

Uses WAL mode for concurrent reads during writes (important since
the dashboard polls frequently while uploads are happening).

Thread Safety:
    All methods create their own connections with check_same_thread=False
    and use 'with' statements for automatic commit/rollback.
"""

import sqlite3
import time
from pathlib import Path
from typing import Optional
from contextlib import contextmanager

from utils import DATABASE_PATH, format_duration, format_size, get_logger

logger = get_logger("database")


class DatabaseManager:
    """
    Manages the SQLite database for the audio monitoring system.

    Usage:
        db = DatabaseManager()
        db.initialize()  # Create tables (idempotent)
        db.register_client("John-Galaxy-S21")
        db.insert_recording(...)
    """

    def __init__(self, db_path: Path = DATABASE_PATH):
        self._db_path = db_path
        # Ensure parent directory exists
        self._db_path.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def _connect(self):
        """Create a database connection with proper settings."""
        conn = sqlite3.connect(
            str(self._db_path),
            check_same_thread=False,
            timeout=30,
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=10000")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    # ══════════════════════════════════════════════════════════════════════
    # INITIALIZATION
    # ══════════════════════════════════════════════════════════════════════

    def initialize(self) -> None:
        """Create all tables if they don't exist. Safe to call multiple times."""
        with self._connect() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS clients (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    name        TEXT    UNIQUE NOT NULL,
                    device_info TEXT    DEFAULT '',
                    first_seen  TEXT    NOT NULL,
                    last_seen   TEXT    NOT NULL,
                    total_uploads   INTEGER DEFAULT 0,
                    total_bytes     INTEGER DEFAULT 0,
                    total_duration  REAL    DEFAULT 0.0,
                    is_online       INTEGER DEFAULT 0,
                    last_ip         TEXT    DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS recordings (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    uuid            TEXT    UNIQUE NOT NULL,
                    client_id       INTEGER NOT NULL,
                    client_name     TEXT    NOT NULL,
                    filename        TEXT    NOT NULL,
                    filepath        TEXT    NOT NULL,
                    file_size       INTEGER NOT NULL,
                    duration        REAL    NOT NULL,
                    checksum_sha256 TEXT    NOT NULL,
                    uploaded_at     TEXT    NOT NULL,
                    recorded_at     TEXT    DEFAULT '',
                    sample_rate     INTEGER DEFAULT 16000,
                    channels        INTEGER DEFAULT 1,
                    bits_per_sample INTEGER DEFAULT 16,
                    chunk_index     INTEGER DEFAULT 0,
                    FOREIGN KEY (client_id) REFERENCES clients(id)
                );

                CREATE TABLE IF NOT EXISTS upload_log (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    recording_uuid  TEXT    NOT NULL,
                    client_name     TEXT    NOT NULL,
                    timestamp       TEXT    NOT NULL,
                    status          TEXT    NOT NULL,
                    ip_address      TEXT    DEFAULT '',
                    file_size       INTEGER DEFAULT 0,
                    message         TEXT    DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS connection_history (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    client_name TEXT    NOT NULL,
                    event_type  TEXT    NOT NULL,
                    timestamp   TEXT    NOT NULL,
                    ip_address  TEXT    DEFAULT '',
                    details     TEXT    DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS playback_history (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    recording_uuid  TEXT    NOT NULL,
                    played_at       TEXT    NOT NULL,
                    played_by       TEXT    DEFAULT 'dashboard'
                );

                -- Indexes for fast queries
                CREATE INDEX IF NOT EXISTS idx_recordings_client
                    ON recordings(client_name);
                CREATE INDEX IF NOT EXISTS idx_recordings_uploaded
                    ON recordings(uploaded_at);
                CREATE INDEX IF NOT EXISTS idx_recordings_uuid
                    ON recordings(uuid);
                CREATE INDEX IF NOT EXISTS idx_upload_log_timestamp
                    ON upload_log(timestamp);
                CREATE INDEX IF NOT EXISTS idx_connection_history_client
                    ON connection_history(client_name);
            """)

            # Try to add recorded_at column if database was created by older schema
            try:
                conn.execute("ALTER TABLE recordings ADD COLUMN recorded_at TEXT DEFAULT ''")
            except Exception:
                pass  # Column already exists
        logger.info(f"Database initialized: {self._db_path}")

    # ══════════════════════════════════════════════════════════════════════
    # CLIENT OPERATIONS
    # ══════════════════════════════════════════════════════════════════════

    def register_client(self, name: str, device_info: str = "",
                        ip_address: str = "") -> dict:
        """
        Register a client or update its last_seen if already exists.
        Returns client info dict.
        """
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        with self._connect() as conn:
            # Try to get existing client
            row = conn.execute(
                "SELECT * FROM clients WHERE name = ?", (name,)
            ).fetchone()

            if row:
                # Update last_seen and online status
                conn.execute(
                    """UPDATE clients
                       SET last_seen = ?, is_online = 1, last_ip = ?
                       WHERE name = ?""",
                    (now, ip_address, name)
                )
                client_id = row["id"]
            else:
                # Insert new client
                cursor = conn.execute(
                    """INSERT INTO clients
                       (name, device_info, first_seen, last_seen, is_online, last_ip)
                       VALUES (?, ?, ?, ?, 1, ?)""",
                    (name, device_info, now, now, ip_address)
                )
                client_id = cursor.lastrowid
                logger.info(f"New client registered: {name}")

            # Log connection event
            conn.execute(
                """INSERT INTO connection_history
                   (client_name, event_type, timestamp, ip_address)
                   VALUES (?, 'connected', ?, ?)""",
                (name, now, ip_address)
            )

        return {"id": client_id, "name": name, "status": "registered"}

    def get_clients(self) -> list[dict]:
        """Get all registered clients with their stats."""
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT * FROM clients ORDER BY last_seen DESC"""
            ).fetchall()
        return [dict(row) for row in rows]

    def get_client(self, name: str) -> Optional[dict]:
        """Get a specific client by name."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM clients WHERE name = ?", (name,)
            ).fetchone()
        return dict(row) if row else None

    def update_client_stats(self, name: str, file_size: int,
                            duration: float) -> None:
        """Increment client's upload stats after a successful upload."""
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        with self._connect() as conn:
            conn.execute(
                """UPDATE clients
                   SET total_uploads = total_uploads + 1,
                       total_bytes = total_bytes + ?,
                       total_duration = total_duration + ?,
                       last_seen = ?,
                       is_online = 1
                   WHERE name = ?""",
                (file_size, duration, now, name)
            )

    def mark_client_offline(self, name: str) -> None:
        """Mark a client as offline."""
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        with self._connect() as conn:
            conn.execute(
                "UPDATE clients SET is_online = 0 WHERE name = ?",
                (name,)
            )
            conn.execute(
                """INSERT INTO connection_history
                   (client_name, event_type, timestamp)
                   VALUES (?, 'disconnected', ?)""",
                (name, now)
            )

    def check_stale_clients(self, timeout_seconds: int = 120) -> list[str]:
        """
        Find clients that haven't been seen recently and mark offline.
        Returns list of client names that were marked offline.
        """
        cutoff = time.strftime(
            "%Y-%m-%d %H:%M:%S",
            time.localtime(time.time() - timeout_seconds)
        )
        with self._connect() as conn:
            stale = conn.execute(
                """SELECT name FROM clients
                   WHERE is_online = 1 AND last_seen < ?""",
                (cutoff,)
            ).fetchall()
            stale_names = [row["name"] for row in stale]
            if stale_names:
                conn.execute(
                    f"""UPDATE clients SET is_online = 0
                        WHERE name IN ({','.join('?' * len(stale_names))})""",
                    stale_names
                )
        return stale_names

    # ══════════════════════════════════════════════════════════════════════
    # RECORDING OPERATIONS
    # ══════════════════════════════════════════════════════════════════════

    def recording_exists(self, uuid: str) -> bool:
        """Check if a recording with this UUID already exists."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM recordings WHERE uuid = ?", (uuid,)
            ).fetchone()
        return row is not None

    def insert_recording(self, uuid: str, client_name: str, filename: str,
                         filepath: str, file_size: int, duration: float,
                         checksum: str, recorded_at: str = "",
                         sample_rate: int = 16000,
                         channels: int = 1, bits_per_sample: int = 16) -> dict:
        """Insert a new recording into the database."""
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        client_time = recorded_at if recorded_at else now

        with self._connect() as conn:
            # Get or create client
            client = conn.execute(
                "SELECT id FROM clients WHERE name = ?", (client_name,)
            ).fetchone()
            client_id = client["id"] if client else 0

            conn.execute(
                """INSERT INTO recordings
                   (uuid, client_id, client_name, filename, filepath,
                    file_size, duration, checksum_sha256, uploaded_at, recorded_at,
                    sample_rate, channels, bits_per_sample)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (uuid, client_id, client_name, filename, filepath,
                 file_size, duration, checksum, now, client_time,
                 sample_rate, channels, bits_per_sample)
            )

            # Log upload
            conn.execute(
                """INSERT INTO upload_log
                   (recording_uuid, client_name, timestamp, status, file_size)
                   VALUES (?, ?, ?, 'success', ?)""",
                (uuid, client_name, now, file_size)
            )

        return {
            "uuid": uuid,
            "client_name": client_name,
            "filename": filename,
            "file_size": file_size,
            "duration": duration,
            "uploaded_at": now,
            "recorded_at": client_time,
        }

    def get_recordings(self, client_name: str = None,
                       date_str: str = None,
                       search: str = None,
                       limit: int = 100,
                       offset: int = 0) -> list[dict]:
        """
        List recordings with optional filters.
        Returns newest first.
        """
        query = "SELECT * FROM recordings WHERE 1=1"
        params = []

        if client_name:
            query += " AND client_name = ?"
            params.append(client_name)

        if date_str:
            query += " AND uploaded_at LIKE ?"
            params.append(f"{date_str}%")

        if search:
            query += " AND (filename LIKE ? OR client_name LIKE ?)"
            params.extend([f"%{search}%", f"%{search}%"])

        query += " ORDER BY uploaded_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])

        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()

        results = []
        for row in rows:
            rec = dict(row)
            rec["duration_human"] = format_duration(rec["duration"])
            rec["size_human"] = format_size(rec["file_size"])
            results.append(rec)

        return results

    def get_recording(self, uuid: str) -> Optional[dict]:
        """Get a single recording by UUID."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM recordings WHERE uuid = ?", (uuid,)
            ).fetchone()
        if row:
            rec = dict(row)
            rec["duration_human"] = format_duration(rec["duration"])
            rec["size_human"] = format_size(rec["file_size"])
            return rec
        return None

    def delete_recording(self, uuid: str) -> bool:
        """Delete a recording from the database. Returns True if deleted."""
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM recordings WHERE uuid = ?", (uuid,)
            )
        return cursor.rowcount > 0

    def get_recording_count(self) -> int:
        """Get total number of recordings."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) as cnt FROM recordings"
            ).fetchone()
        return row["cnt"] if row else 0

    def get_recent_uploads(self, limit: int = 20) -> list[dict]:
        """Get recent upload log entries."""
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT * FROM upload_log
                   ORDER BY timestamp DESC LIMIT ?""",
                (limit,)
            ).fetchall()
        return [dict(row) for row in rows]

    def get_unplayed_recordings(self, limit: int = 50) -> list[dict]:
        """Get recordings that haven't been played yet (for auto-playback)."""
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT r.* FROM recordings r
                   LEFT JOIN playback_history ph ON r.uuid = ph.recording_uuid
                   WHERE ph.id IS NULL
                   ORDER BY r.uploaded_at ASC
                   LIMIT ?""",
                (limit,)
            ).fetchall()

        results = []
        for row in rows:
            rec = dict(row)
            rec["duration_human"] = format_duration(rec["duration"])
            rec["size_human"] = format_size(rec["file_size"])
            results.append(rec)
        return results

    def mark_played(self, uuid: str) -> None:
        """Mark a recording as played."""
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO playback_history
                   (recording_uuid, played_at)
                   VALUES (?, ?)""",
                (uuid, now)
            )

    # ══════════════════════════════════════════════════════════════════════
    # STATISTICS
    # ══════════════════════════════════════════════════════════════════════

    def get_stats(self) -> dict:
        """Get global statistics for the dashboard."""
        with self._connect() as conn:
            # Total recordings
            total = conn.execute(
                "SELECT COUNT(*) as cnt, "
                "COALESCE(SUM(file_size), 0) as total_size, "
                "COALESCE(SUM(duration), 0) as total_duration "
                "FROM recordings"
            ).fetchone()

            # Per-client stats
            clients = conn.execute(
                """SELECT client_name,
                          COUNT(*) as recordings,
                          SUM(file_size) as total_bytes,
                          SUM(duration) as total_duration,
                          MAX(uploaded_at) as last_upload
                   FROM recordings
                   GROUP BY client_name
                   ORDER BY last_upload DESC"""
            ).fetchall()

            # Online/offline counts
            online = conn.execute(
                "SELECT COUNT(*) as cnt FROM clients WHERE is_online = 1"
            ).fetchone()
            offline = conn.execute(
                "SELECT COUNT(*) as cnt FROM clients WHERE is_online = 0"
            ).fetchone()

            # Uploads in last hour
            one_hour_ago = time.strftime(
                "%Y-%m-%d %H:%M:%S",
                time.localtime(time.time() - 3600)
            )
            recent = conn.execute(
                """SELECT COUNT(*) as cnt FROM upload_log
                   WHERE timestamp > ? AND status = 'success'""",
                (one_hour_ago,)
            ).fetchone()

        return {
            "total_recordings": total["cnt"],
            "total_size_bytes": total["total_size"],
            "total_size_human": format_size(total["total_size"]),
            "total_duration_seconds": round(total["total_duration"], 1),
            "total_duration_human": format_duration(total["total_duration"]),
            "clients_online": online["cnt"],
            "clients_offline": offline["cnt"],
            "uploads_last_hour": recent["cnt"],
            "per_client": [
                {
                    "client_name": c["client_name"],
                    "recordings": c["recordings"],
                    "total_bytes": c["total_bytes"],
                    "total_size_human": format_size(c["total_bytes"] or 0),
                    "total_duration_human": format_duration(
                        c["total_duration"] or 0
                    ),
                    "last_upload": c["last_upload"],
                }
                for c in clients
            ],
        }
