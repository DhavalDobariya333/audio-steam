/**
 * config.ts — Centralized configuration for the Audio Stream Server.
 *
 * All paths, constants, and environment variable parsing lives here
 * so every other module imports from a single source of truth.
 */

import path from 'path';

// ── Server ──
export const HOST = process.env.AUDIO_HOST || '0.0.0.0';
export const PORT = parseInt(process.env.PORT || process.env.AUDIO_PORT || '8765', 10);

// ── Paths ──
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
export const STEALTH_DIR = path.join(PROJECT_ROOT, 'stealth');
export const STORAGE_ROOT = path.join(PUBLIC_DIR, 'storage', 'sessions');
export const DASHBOARD_DIR = path.join(PUBLIC_DIR, 'dashboard');
export const LISTENER_DIR = path.join(PUBLIC_DIR, 'listener');
export const DATABASE_PATH = path.join(PROJECT_ROOT, 'audio_stream.db');

// ── Stealth Dashboard Route ──
const rawStealthRoute = (process.env.STEALTH_ROUTE || '/c-ctrl-9842').trim();
export const STEALTH_ROUTE = (rawStealthRoute.startsWith('/') ? rawStealthRoute : `/${rawStealthRoute}`).replace(/\/+$/, '') || '/c-ctrl-9842';

// ── Authentication & Passwords ──
export const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME || 'admin@789';
export const MAIN_PASSWORD = process.env.MAIN_PASSWORD || process.env.DASHBOARD_PASSWORD || 'cvb#345';
export const STEALTH_PASSWORD = process.env.STEALTH_PASSWORD || 'stealth#9842';
export const AUTH_SECRET = process.env.AUTH_SECRET || 'audio-stream-auth-key-secret-9842';

// ── Audio ──
export const CHUNK_DURATION_MS = 2000;
export const MAX_UPLOAD_SIZE = 5 * 1024 * 1024; // 5 MB per chunk
export const MAX_ZIP_UPLOAD_SIZE = Math.max(
    MAX_UPLOAD_SIZE,
    parseInt(process.env.MAX_ZIP_UPLOAD_SIZE_MB || '100', 10) * 1024 * 1024
); // default 100 MB for /upload-zip batches
export const SAMPLE_RATE = 16000;
export const NUM_CHANNELS = 1;
export const BITS_PER_SAMPLE = 16;
export const BYTE_RATE = SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);

// ── HLS ──
export const HLS_SEGMENT_DURATION = 2; // seconds — matches chunk size
export const HLS_LIST_SIZE = 10; // sliding window size for live playlist

// ── Rate Limiting ──
export const MAX_UPLOADS_PER_MINUTE = 120;

// ── Session Housekeeping ──
// A live session with no new chunks for this long is auto-ended (was 300s).
// Raise it (e.g. 900) if the phone has slow network / big ZIP batch uploads.
export const STALE_SESSION_TIMEOUT_SEC = Math.max(60, parseInt(process.env.STALE_SESSION_TIMEOUT || '600', 10));

// ── Persistent Server Logs (Live Server Logs box survival + download) ──
// Every captured live-log line is ALSO appended to logs/server.log on disk.
// At LOG_FILE_MAX_MB the file rotates (server.log -> server.log.1 ... .N-1),
// keeping up to LOG_MAX_FILES files -> up to ~LOG_FILE_MAX_MB * LOG_MAX_FILES total.
export const LOG_FILE_MAX_MB = Math.max(1, parseInt(process.env.LOG_MAX_MB || '50', 10));   // 50 MB per file
export const LOG_MAX_FILES = Math.max(2, parseInt(process.env.LOG_MAX_FILES || '10', 10)); // ~500 MB total
export const LOG_DIR = process.env.LIVE_LOG_DIR || path.join(PROJECT_ROOT, 'logs');
