/**
 * config.ts — Centralized configuration for the Audio Stream Server.
 *
 * All paths, constants, and environment variable parsing lives here
 * so every other module imports from a single source of truth.
 */

import path from 'path';

// ── Server ──
export const HOST = process.env.AUDIO_HOST || '0.0.0.0';
export const PORT = parseInt(process.env.AUDIO_PORT || '8765', 10);

// ── Paths ──
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
export const STORAGE_ROOT = path.join(PUBLIC_DIR, 'storage', 'sessions');
export const DASHBOARD_DIR = path.join(PUBLIC_DIR, 'dashboard');
export const LISTENER_DIR = path.join(PUBLIC_DIR, 'listener');
export const DATABASE_PATH = path.join(PROJECT_ROOT, 'audio_stream.db');

// ── Audio ──
export const CHUNK_DURATION_MS = 2000;
export const MAX_UPLOAD_SIZE = 5 * 1024 * 1024; // 5 MB per chunk
export const SAMPLE_RATE = 16000;
export const NUM_CHANNELS = 1;
export const BITS_PER_SAMPLE = 16;
export const BYTE_RATE = SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);

// ── HLS ──
export const HLS_SEGMENT_DURATION = 2; // seconds — matches chunk size
export const HLS_LIST_SIZE = 10; // sliding window size for live playlist

// ── Rate Limiting ──
export const MAX_UPLOADS_PER_MINUTE = 120;
