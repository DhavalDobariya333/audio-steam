/**
 * dashboard.ts — Host dashboard API routes.
 *
 * Provides session management endpoints for the web dashboard:
 *   GET    /api/v1/dashboard/sessions              — List all sessions
 *   GET    /api/v1/dashboard/sessions/:id          — Session detail
 *   DELETE /api/v1/dashboard/sessions/:id          — Delete session + files
 *   GET    /api/v1/dashboard/stats                 — Global statistics
 */

import { Router, Request, Response } from 'express';
import * as db from '../database';
import * as storage from '../storage';

const router = Router();

// ════════════════════════════════════════════════════════════════════════════
// LIST SESSIONS
// ════════════════════════════════════════════════════════════════════════════

router.get('/sessions', (req: Request, res: Response) => {
    try {
        const limit = parseInt(req.query.limit as string || '100', 10);
        const offset = parseInt(req.query.offset as string || '0', 10);

        const sessions = db.listSessions(limit, offset);
        const totalCount = db.getSessionCount();
        const storageInfo = storage.getStorageInfo();

        res.json({
            sessions,
            count: sessions.length,
            total: totalCount,
            storage: storageInfo,
        });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// GET SESSION DETAIL
// ════════════════════════════════════════════════════════════════════════════

router.get('/sessions/:session_id', (req: Request, res: Response) => {
    try {
        const session_id = req.params.session_id as string;
        const session = db.getSession(session_id);
        if (!session) {
            res.status(404).json({ status: 'not_found' });
            return;
        }

        const chunks = db.getSessionChunks(session_id);

        res.json({
            session,
            chunks,
            chunks_count: chunks.length,
        });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// DELETE SESSION
// ════════════════════════════════════════════════════════════════════════════

router.delete('/sessions/:session_id', (req: Request, res: Response) => {
    try {
        const session_id = req.params.session_id as string;

        const session = db.getSession(session_id);
        if (!session) {
            res.status(404).json({ status: 'not_found', session_id });
            return;
        }

        // 1. Delete all files from disk (raw chunks + HLS segments)
        const filesDeleted = storage.deleteSessionFiles(session_id);

        // 2. Delete database records (chunks + session)
        const dbDeleted = db.deleteSession(session_id);

        console.log(`[dashboard] Session deleted: ${session_id} (files=${filesDeleted}, db=${dbDeleted})`);

        res.json({
            status: 'deleted',
            session_id,
            files_deleted: filesDeleted,
            message: 'Session and all associated files permanently deleted.',
        });
    } catch (err: any) {
        console.error('[dashboard] Delete error:', err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// GLOBAL STATS
// ════════════════════════════════════════════════════════════════════════════

router.get('/stats', (req: Request, res: Response) => {
    try {
        const stats = db.getStats();
        const storageInfo = storage.getStorageInfo();

        res.json({
            ...stats,
            storage: storageInfo,
            timestamp: new Date().toISOString(),
        });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// DEVICE STATUS
// ════════════════════════════════════════════════════════════════════════════

router.get('/devices', (req: Request, res: Response) => {
    try {
        const devices = db.getAllDeviceCommands();
        res.json({ devices });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

export default router;
