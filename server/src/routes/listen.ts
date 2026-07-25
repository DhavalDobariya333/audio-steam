/**
 * listen.ts — Listener API routes.
 *
 * Provides endpoints for listeners to discover and consume HLS streams:
 *   GET /api/v1/listen/active           — List active (live) sessions
 *   GET /api/v1/listen/:session_id      — Session info + HLS URLs
 *   GET /api/v1/listen/sessions         — All sessions (live + ended)
 *
 * HLS files (.m3u8 and .ts segments) are served statically by Express
 * from the /storage/ directory, so listeners directly access:
 *   /storage/sessions/:session_id/hls/live.m3u8
 *   /storage/sessions/:session_id/hls/vod.m3u8
 */

import { Router, Request, Response } from 'express';
import * as db from '../database';

const router = Router();

// ════════════════════════════════════════════════════════════════════════════
// ACTIVE (LIVE) SESSIONS
// ════════════════════════════════════════════════════════════════════════════

router.get('/active', (req: Request, res: Response) => {
    try {
        const sessions = db.getActiveSessions();

        const result = sessions.map(s => ({
            session_id: s.session_id,
            title: s.title,
            client_name: s.client_name,
            created_at: s.created_at,
            total_duration: s.total_duration,
            total_chunks: s.total_chunks,
            hls_live_url: `/storage/sessions/${s.session_id}/hls/live.m3u8`,
            hls_vod_url: `/storage/sessions/${s.session_id}/hls/vod.m3u8`,
        }));

        res.json({
            sessions: result,
            count: result.length,
        });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ALL SESSIONS (for replay)
// ════════════════════════════════════════════════════════════════════════════

router.get('/sessions', (req: Request, res: Response) => {
    try {
        const limit = parseInt(req.query.limit as string || '50', 10);
        const offset = parseInt(req.query.offset as string || '0', 10);

        const sessions = db.listSessions(limit, offset);

        const result = sessions.map(s => ({
            session_id: s.session_id,
            title: s.title,
            client_name: s.client_name,
            status: s.status,
            created_at: s.created_at,
            ended_at: s.ended_at,
            total_duration: s.total_duration,
            total_chunks: s.total_chunks,
            hls_live_url: s.status === 'live' ? `/storage/sessions/${s.session_id}/hls/live.m3u8` : null,
            hls_vod_url: `/storage/sessions/${s.session_id}/hls/vod.m3u8`,
        }));

        res.json({
            sessions: result,
            count: result.length,
        });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// SESSION DETAIL
// ════════════════════════════════════════════════════════════════════════════

router.get('/:session_id', (req: Request, res: Response) => {
    try {
        const session = db.getSession(req.params.session_id);
        if (!session) {
            res.status(404).json({ status: 'not_found' });
            return;
        }

        res.json({
            session: {
                ...session,
                hls_live_url: session.status === 'live'
                    ? `/storage/sessions/${session.session_id}/hls/live.m3u8`
                    : null,
                hls_vod_url: `/storage/sessions/${session.session_id}/hls/vod.m3u8`,
            },
        });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

export default router;
