# Architectural Refactoring & Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modernize and harden the audio streaming platform by migrating from `sql.js` to `better-sqlite3` (WAL mode), eliminating dead Python/RN code, optimizing HLS streaming with `#EXT-X-DISCONTINUITY` and eliminating `ffprobe` spawns, and replacing CLI `zip` with cross-platform `archiver`.

**Architecture:** 
1. Replace in-memory WASM `sql.js` and full memory-dump disk writes with `better-sqlite3` running in WAL mode for persistent, non-blocking page-level writes.
2. Clean up legacy Python files and orphaned folders to leave a unified TypeScript backend and native Kotlin Android app.
3. Optimize HLS segment generation by using client-reported chunk duration and injecting `#EXT-X-DISCONTINUITY` when silence detection or drops cause non-contiguous sequences.
4. Replace platform-dependent `spawn('zip')` with streaming `archiver` for cross-platform ZIP export.

**Tech Stack:** Node.js, Express, TypeScript, `better-sqlite3`, `archiver`, FFmpeg.

---

## Global Constraints
- Target Node.js: Compatible with Node 16+ locally and Node 18+ in Docker (`node:18-bullseye-slim`).
- No regressions to Android app API contracts (`/api/v1/broadcasts`, `/chunk`, `/end`, `/command`).
- TypeScript build must pass cleanly with `tsc`.

---

## Tasks

### Task 1: Code Hygiene — Remove Orphaned Files & Consolidate Documentation
- [ ] Remove legacy Python files in `server/`: `main.py`, `database.py`, `storage.py`, `utils.py`, `requirements.txt`, `download.js`, `download_all_chunks.js`, `server.zip`, `audio_recording_7248bf92.m4a`.
- [ ] Remove unconfigured `mobile/` directory.
- [ ] Consolidate Termux/Cloudflare instructions into `README.md` and clean up `SETUP_TERMUX.md` and `SETUP_CLOUDFLARE.md`.

### Task 2: Portability — Replace CLI `zip` with `archiver` in `broadcast.ts`
- [ ] Install `archiver@^5.3.2` and `@types/archiver@^5.3.4` in `server/`.
- [ ] Update `server/src/routes/broadcast.ts` to stream ZIP archive using `archiver`.
- [ ] Verify TypeScript types and export logic.

### Task 3: Streaming — Optimize HLS with Discontinuity & Skip `ffprobe`
- [ ] Update `appendToHLS` in `server/src/hls.ts` to accept `durationMs?: number` and track sequence gap.
- [ ] If `sequenceNum > lastSequence + 1`, inject `#EXT-X-DISCONTINUITY` in `live.m3u8` and `vod.m3u8`.
- [ ] Skip `ffprobe` child process spawn when valid `durationMs` is provided.
- [ ] Pass `duration_ms` from `server/src/routes/broadcast.ts` into `appendToHLS`.

### Task 4: Database — Migrate from `sql.js` to `better-sqlite3` in WAL Mode
- [ ] Install `better-sqlite3@^8.7.0` and `@types/better-sqlite3@^7.6.11`. Remove `sql.js` and `@types/sql.js`.
- [ ] Rewrite `server/src/database.ts` using `better-sqlite3` with `PRAGMA journal_mode = WAL` and `PRAGMA synchronous = NORMAL`.
- [ ] Remove `saveToDisk()`, `db.export()`, and periodic interval timers.
- [ ] Convert all queries (`prepare(...).run(...)` and `prepare(...).all(...)` / `get(...)`) to maintain identical interface contract.
- [ ] Update `server/src/index.ts` to close database cleanly.

### Task 5: Build & Verification
- [ ] Run `npm run build` in `server/`.
- [ ] Run smoke test verifying database initialization, tables creation, WAL file generation, and clean shutdown.
