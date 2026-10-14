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
import { HOST, PORT, PUBLIC_DIR, STEALTH_DIR, STEALTH_ROUTE, DASHBOARD_DIR, LISTENER_DIR, STORAGE_ROOT } from './config';
import { initDatabase, closeDatabase, cleanupStaleSessions } from './database';
import { ensureStorageRoot } from './storage';
import { checkFfmpeg, finalizeHLS } from './hls';
import broadcastRoutes from './routes/broadcast';
import dashboardRoutes from './routes/dashboard';
import listenRoutes from './routes/listen';
import { initWebSocketServer } from './websocket';

// ════════════════════════════════════════════════════════════════════════════
// APPLICATION SETUP
// ════════════════════════════════════════════════════════════════════════════

const app = express();

// ── Basic Authentication Middleware ──
const basicAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Do not protect the upload routes (Android App), health check, or storage (HLS streams)
    if (
        req.path.startsWith('/api/v1/broadcasts') || 
        req.path === '/api/v1/listen/active' ||
        req.path.startsWith('/api/v1/health') ||
        req.path.startsWith('/storage') ||
        req.path.startsWith('/ws')
    ) {
        return next();
    }

    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

    const USERNAME = process.env.DASHBOARD_USERNAME || 'admin@789';
    const PASSWORD = process.env.DASHBOARD_PASSWORD || 'cvb#345';

    if (login && password && login === USERNAME && password === PASSWORD) {
        return next();
    }

    res.set('WWW-Authenticate', 'Basic realm="Dashboard Access"');
    res.status(401).send('Authentication required.');
};

// ── Middleware ──
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(basicAuth); // Apply Basic Auth

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

// Unified Single Page App (SPA) — served from PUBLIC_DIR
app.use(express.static(PUBLIC_DIR));

// Secret portal endpoint for 6-tap trigger redirect from main dashboard
app.post('/api/v1/system/stealth-portal', (req, res) => {
    if (req.body?.trigger === 'header-sequence' || req.body?.tapSequence >= 6) {
        return res.json({ route: STEALTH_ROUTE });
    }
    return res.status(403).json({ error: 'Unauthorized access' });
});

// Stealth dashboard script (served only under dynamic STEALTH_ROUTE)
app.get(`${STEALTH_ROUTE}/stealth.js`, (_req, res) => {
    const jsPath = path.join(STEALTH_DIR, 'stealth.js');
    if (!fs.existsSync(jsPath)) {
        return res.status(404).send('Not found');
    }
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.sendFile(jsPath);
});

// Stealth dashboard route (serves stealth.html with dynamic script path injection)
app.get([STEALTH_ROUTE, `${STEALTH_ROUTE}/`], (_req, res) => {
    const htmlPath = path.join(STEALTH_DIR, 'stealth.html');
    if (!fs.existsSync(htmlPath)) {
        return res.status(404).send('Not found');
    }
    const html = fs.readFileSync(htmlPath, 'utf8')
        .replace(/__STEALTH_ROUTE__/g, STEALTH_ROUTE);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// Direct routes for /, /dashboard, /listener → serve innocent Main SPA
app.get(['/', '/dashboard', '/dashboard/*', '/listener', '/listener/*'], (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ════════════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ════════════════════════════════════════════════════════════════════════════

async function start(): Promise<void> {
    // 1. Initialize database
    await initDatabase();

    // 2. Ensure storage directories exist
    ensureStorageRoot();

    // 3. Check FFmpeg
    checkFfmpeg();

    // 4. Stale session auto-cleanup (every 30s)
    const staleInterval = setInterval(() => {
        try {
            const ended = cleanupStaleSessions(300);
            for (const id of ended) {
                finalizeHLS(id);
                console.log(`[server] Auto-ended stale session: ${id}`);
            }
        } catch (e) {
            console.error('[server] Stale cleanup error:', e);
        }
    }, 30000);

    // 5. Start listening
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

    // 6. Initialize Real-Time WebSocket Gateway
    initWebSocketServer(server);

    // ── Graceful Shutdown ──
    const shutdown = (signal: string) => {
        console.log(`\n[server] ${signal} received — shutting down...`);
        clearInterval(staleInterval);
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
