/**
 * index.ts — Express application entry point.
 *
 * Wires together:
 *   - Database initialization
 *   - Storage directory setup
 *   - FFmpeg availability check
 *   - API route mounting
 *   - Static file serving (HLS segments, dashboard, listener)
 *   - Graceful shutdown
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { HOST, PORT, PUBLIC_DIR, DASHBOARD_DIR, LISTENER_DIR, STORAGE_ROOT } from './config';
import { initDatabase, closeDatabase } from './database';
import { ensureStorageRoot } from './storage';
import { checkFfmpeg } from './hls';
import broadcastRoutes from './routes/broadcast';
import dashboardRoutes from './routes/dashboard';
import listenRoutes from './routes/listen';

// ════════════════════════════════════════════════════════════════════════════
// APPLICATION SETUP
// ════════════════════════════════════════════════════════════════════════════

const app = express();

// ── Middleware ──
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── API Routes ──
app.use('/api/v1/broadcasts', broadcastRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/listen', listenRoutes);

// ── Health Check ──
app.get('/api/v1/health', (_req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
    });
});

// ── Static File Serving ──

// HLS segments & raw chunks — served from /storage/sessions/:id/hls/
// This lets listeners access: /storage/sessions/:id/hls/live.m3u8
fs.mkdirSync(STORAGE_ROOT, { recursive: true });
app.use('/storage', express.static(path.join(PUBLIC_DIR, 'storage'), {
    // Set proper MIME types for HLS
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.m3u8')) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            // Disable caching for live playlists
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (filePath.endsWith('.ts')) {
            res.setHeader('Content-Type', 'video/mp2t');
            res.setHeader('Cache-Control', 'public, max-age=31536000'); // Segments are immutable
        }
    },
}));

// Host Dashboard — served from /dashboard/
fs.mkdirSync(DASHBOARD_DIR, { recursive: true });
app.use('/dashboard', express.static(DASHBOARD_DIR));

// Listener Web Player — served from /listener/
fs.mkdirSync(LISTENER_DIR, { recursive: true });
app.use('/listener', express.static(LISTENER_DIR));

// Root redirect → dashboard
app.get('/', (_req, res) => {
    res.redirect('/dashboard/');
});

// ════════════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ════════════════════════════════════════════════════════════════════════════

function start(): void {
    // 1. Initialize database
    initDatabase();

    // 2. Ensure storage directories exist
    ensureStorageRoot();

    // 3. Check FFmpeg
    checkFfmpeg();

    // 4. Start listening
    const server = app.listen(PORT, HOST, () => {
        console.log('\n✅ Hosting is completed and server is live!\n');
        console.log('═'.repeat(65));
        console.log('  TIME-SHIFTED LIVE AUDIO PLATFORM');
        console.log('═'.repeat(65));
        console.log('  1. HOST / STORE LINK (Your private admin dashboard)');
        console.log(`     -> http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/dashboard/`);
        console.log('');
        console.log('  2. PUBLIC LISTENING LINK (Share this with your audience)');
        console.log(`     -> http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/listener/`);
        console.log('');
        console.log('  3. MOBILE APP API URL (Enter this in the mobile app Setup)');
        console.log(`     -> http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
        console.log('═'.repeat(65));
        console.log('\n  (Note: If hosted on Render, replace "http://localhost:8765"');
        console.log('         with your actual Render domain like "https://your-app.onrender.com")\n');
    });

    // ── Graceful Shutdown ──
    const shutdown = (signal: string) => {
        console.log(`\n[server] ${signal} received — shutting down...`);
        server.close(() => {
            closeDatabase();
            console.log('[server] Stopped');
            process.exit(0);
        });

        // Force exit after 5 seconds
        setTimeout(() => {
            console.error('[server] Forced shutdown');
            process.exit(1);
        }, 5000);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start();

export default app;
