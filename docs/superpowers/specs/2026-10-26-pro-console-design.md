# Pro Studio & Database Management Console (Design Specification)

**Date:** 2026-10-26  
**Status:** Approved & Ready for Implementation  
**Target Delivery:** Planned for future implementation sprint  

---

## 1. Intent & Overview
Provide audio stream administrators and pro users with a dedicated, minimalist management studio (`/pro` or `pro.html`) to:
1. Inspect, search, and run SQL queries against the server's SQLite database ([database.ts](file:///c:/Users/Dell/.gemini/antigravity-ide/scratch/audio-stream/server/src/database.ts)).
2. Execute server maintenance actions and view real-time diagnostics via an interactive terminal window without needing direct SSH access.

---

## 2. Goals, Non-Goals & Anti-Goals

### Goals
- **Dedicated Page with Premium Minimalist UI/UX:** Clean, dark obsidian styling (`#090c15` / `#0d121f`), fast and responsive.
- **SQLite Database Explorer:**
  - View tables (`sessions`, audio chunk records, audit metadata).
  - Quick query presets (e.g. *Active Sessions*, *Failed Chunks*, *Table Schema*).
  - Custom SQL runner with formatted tabular results and row counts.
- **Server Command Runner & Live Terminal:**
  - One-click maintenance buttons (*Clean Orphan Chunks*, *Restart Ingest Engine*, *FFmpeg Diagnostic*, *Download SQLite Backup*).
  - Command line prompt (`cmd>`) supporting predefined commands (`clean`, `stats`, `vacuum`, `ffmpeg-check`, `backup-db`).
  - Terminal-style log display with timestamps and color-coded status badges.
- **Demo Mode:** Zero-friction access for early testing and demos without complex authentication.

### Non-Goals
- Multi-tenant enterprise permission management (kept simple for demo/MVP).
- Full remote desktop or arbitrary OS command injection (for server security).

### Anti-Goals (Security Boundaries)
- **No Unrestricted Web Shell:** Arbitrary OS shell execution (`child_process.exec(req.body.cmd)`) must NOT be implemented. All runnable server commands must be dispatched through a validated registry of safe operations.

---

## 3. Architecture & File Structure

```
server/
├── public/
│   ├── pro.html           # Dedicated Pro Studio page
│   ├── pro.css            # Minimalist obsidian dark theme
│   └── pro.js             # Client controller for queries & terminal actions
└── src/
    ├── routes/
    │   └── pro.ts         # REST API endpoints for /api/pro/*
    └── index.ts           # Route registration and static serving
```

---

## 4. API Specification

### `GET /api/pro/vitals`
Returns current server metrics:
```json
{
  "totalSessions": 48,
  "liveSessions": 3,
  "dbSizeBytes": 19348120,
  "storageUsedBytes": 1289123890,
  "ffmpegStatus": "operational",
  "ffmpegVersion": "6.0-static",
  "uptimeSeconds": 1420
}
```

### `POST /api/pro/query`
Executes an SQLite query via `better-sqlite3`:
* **Request:** `{ "query": "SELECT * FROM sessions LIMIT 10;" }`
* **Response:**
  ```json
  {
    "success": true,
    "rowCount": 10,
    "columns": ["id", "session_id", "status", "client_name", "created_at"],
    "rows": [...],
    "executionTimeMs": 1.2
  }
  ```

### `POST /api/pro/command`
Executes a registered server task:
* **Request:** `{ "command": "clean" }`
* **Supported Commands:**
  - `clean`: Scans audio storage directories and removes chunks not mapped to active sessions.
  - `stats`: Returns CPU, RAM, and stream connection metrics.
  - `vacuum`: Runs SQLite `VACUUM` and integrity check.
  - `ffmpeg-check`: Validates FFmpeg and FFprobe binary availability and codec support.
  - `backup-db`: Generates a downloadable `.sqlite` snapshot.
* **Response:**
  ```json
  {
    "success": true,
    "command": "clean",
    "output": "✓ Storage scan complete. 0 orphaned files found. Free disk: 142 GB.",
    "timestamp": "2026-10-26T02:35:00.000Z"
  }
  ```

---

## 5. UI / UX Design Specifications

1. **Top Header & Vitals Bar:**
   - Pro Studio logo with demo mode badge.
   - Live status indicator (green pulse).
   - Metric cards: *Total Sessions*, *DB File Size*, *Disk Storage*, *Ingest Status*.
2. **Tabbed View Switcher:**
   - **Tab 1: 📊 Database:** SQL query textarea, presets chips, execution button, dynamic table grid with sorting.
   - **Tab 2: ⚡ Server & Terminal:** Quick action pills, dark command output console with auto-scroll, command prompt input (`cmd>`).
3. **Navigation Integration:**
   - Direct link added to the main navigation bar in [`index.html`](file:///c:/Users/Dell/.gemini/antigravity-ide/scratch/audio-stream/server/public/index.html) or dashboard header: `⚡ Pro Studio`.
