/**
 * broadcast.ts — API routes for broadcaster clients.
 *
 * Handles session lifecycle and chunk ingestion:
 *   POST /api/v1/broadcasts              — Create new session
 *   POST /api/v1/broadcasts/:id/chunk    — Upload an audio chunk
 *   PUT  /api/v1/broadcasts/:id/end      — End a session
 *   GET  /api/v1/broadcasts/:id          — Get session info
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import * as db from '../database';
import * as storage from '../storage';
import { appendToHLS, finalizeHLS } from '../hls';
import { MAX_UPLOAD_SIZE, CHUNK_DURATION_MS, PUBLIC_DIR } from '../config';

const router = Router();
const exportRateLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        status: 'error',
        message: 'Too many export requests. Please retry after a minute.',
    },
});

// Multer: store uploaded chunks in memory (they're small — max 5MB)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_SIZE },
});

// ════════════════════════════════════════════════════════════════════════════
// CREATE SESSION
// ════════════════════════════════════════════════════════════════════════════

router.post('/', (req: Request, res: Response) => {
    try {
        const sessionId = uuidv4();
        const { client_name, device_info, title } = req.body || {};

        // Create storage directories
        storage.createSessionDirs(sessionId);

        // Create database record
        const session = db.createSession(
            sessionId,
            client_name || '',
            device_info || '',
            title || ''
        );

        console.log(`[broadcast] New session: ${sessionId} (client: ${client_name || 'unknown'})`);

        res.status(201).json({
            status: 'created',
            session_id: sessionId,
            session,
        });
    } catch (err: any) {
        console.error('[broadcast] Create session error:', err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// UPLOAD CHUNK
// ════════════════════════════════════════════════════════════════════════════

router.post('/:session_id/chunk', upload.single('audio'), async (req: Request, res: Response) => {
    try {
        const session_id = req.params.session_id as string;
        const file = req.file;

        if (!file) {
            res.status(400).json({ status: 'error', message: 'No audio file provided' });
            return;
        }

        // Verify session exists
        const session = db.getSession(session_id);
        if (!session) {
            res.status(404).json({ status: 'error', message: 'Session not found' });
            return;
        }

        // Get sequence number from body or auto-increment
        let sequenceNum: number;
        if (req.body.sequence_num !== undefined) {
            sequenceNum = parseInt(req.body.sequence_num, 10);
        } else {
            sequenceNum = db.getLatestChunkSequence(session_id) + 1;
        }

        // Duplicate detection: if this sequence already uploaded, skip
        if (db.chunkExists(session_id, sequenceNum)) {
            console.log(`[broadcast] Duplicate chunk skipped: session=${session_id} seq=${sequenceNum}`);
            res.json({
                status: 'already_exists',
                session_id,
                sequence_num: sequenceNum,
                message: 'Chunk already uploaded.',
            });
            return;
        }

        // Parse optional metadata from request body
        const chunkId = req.body.chunk_id || uuidv4();
        const durationMs = parseInt(req.body.duration_ms || String(CHUNK_DURATION_MS), 10);
        const checksum = req.body.checksum || '';
        const inCall = req.body.in_call === '1' || req.body.in_call === 'true' ? 1 : 0;
        const micInUse = req.body.mic_in_use === '1' || req.body.mic_in_use === 'true' ? 1 : 0;

        // Save chunk to disk
        const saved = storage.saveChunk(session_id, sequenceNum, file.buffer, file.originalname);

        // Insert into database
        const chunk = db.insertChunk(
            chunkId,
            session_id,
            sequenceNum,
            saved.filename,
            saved.filepath,
            saved.fileSize,
            durationMs,
            checksum,
            inCall,
            micInUse
        );

        console.log(`[broadcast] Chunk saved: session=${session_id} seq=${sequenceNum} call=${inCall} micUse=${micInUse}`);

        // Generate HLS segment (async — don't block response)
        appendToHLS(session_id, saved.filepath, sequenceNum).catch(err => {
            console.error(`[broadcast] HLS generation failed for seq ${sequenceNum}:`, err);
        });

        res.json({
            status: 'confirmed',
            session_id,
            chunk_id: chunkId,
            sequence_num: sequenceNum,
            file_size: saved.fileSize,
            message: 'Chunk uploaded successfully. You may delete the local copy.',
        });
    } catch (err: any) {
        console.error('[broadcast] Upload chunk error:', err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// EXPORT AUDIO BY CHANNEL (Mic vs Internal vs Stereo)
// ════════════════════════════════════════════════════════════════════════════

router.get('/:session_id/export-channel', exportRateLimit, (req: Request, res: Response) => {
    try {
        const session_id = req.params.session_id as string;
        const channelParam = (req.query.channel as string || 'both').toLowerCase();
        const session = db.getSession(session_id);

        if (!session) {
            res.status(404).json({ status: 'error', message: 'Session not found' });
            return;
        }

        const rawDir = storage.getRawDir(session_id);
        const vodM3u8 = `${storage.getHlsDir(session_id)}/vod.m3u8`;

        if (!require('fs').existsSync(vodM3u8) && !require('fs').existsSync(rawDir)) {
            res.status(404).json({ status: 'error', message: 'No recordings available for this session' });
            return;
        }

        const formatParam = (req.query.format as string || 'aac').toLowerCase();

        if (formatParam === 'zip') {
            const chunks = db.getSessionChunks(session_id);
            if (chunks.length === 0) {
                res.status(404).json({ status: 'error', message: 'No chunks available for this session' });
                return;
            }

            const rawDir = storage.getRawDir(session_id);
            const resolvedRawDir = path.resolve(rawDir);
            const chunkFiles = chunks
                .map(c => path.resolve(c.filepath))
                .filter(filePath =>
                    (filePath === resolvedRawDir || filePath.startsWith(`${resolvedRawDir}${path.sep}`))
                    && fs.existsSync(filePath)
                );

            if (chunkFiles.length === 0) {
                res.status(404).json({ status: 'error', message: 'Chunk files not found on disk' });
                return;
            }

            const filename = `${session.client_name || 'session'}_${session_id.slice(0, 8)}_chunks.zip`;
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            const { spawn } = require('child_process');
            const proc = spawn('zip', ['-q', '-j', '-', '-@'], {
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            proc.stdout.pipe(res);
            proc.stderr.on('data', (data: Buffer) => {
                console.error(`[broadcast] ZIP export stderr: ${data.toString()}`);
            });
            proc.on('error', (err: any) => {
                console.error('[broadcast] ZIP export error:', err);
                if (!res.headersSent) {
                    res.status(500).json({ status: 'error', message: 'ZIP export failed' });
                }
            });
            proc.on('close', (code: number) => {
                if (code !== 0) {
                    console.error(`[broadcast] ZIP export exited with code ${code}`);
                    if (!res.writableEnded) {
                        res.end();
                    }
                }
            });

            for (const filePath of chunkFiles) {
                proc.stdin.write(`${filePath}\n`);
            }
            proc.stdin.end();

            req.on('close', () => {
                if (!proc.killed) {
                    proc.kill();
                }
            });
            return;
        }
        
        if (formatParam === 'm3u8') {
            const filename = `${session.client_name || 'session'}_${session_id.slice(0, 8)}_${channelParam}.m3u8`;
            res.setHeader('Content-Type', 'audio/x-mpegurl');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.sendFile(vodM3u8);
            return;
        }

        // Export as single combined audio file using FFmpeg
        const isMP3 = formatParam === 'mp3';
        const ext = isMP3 ? 'mp3' : 'aac';
        const contentType = isMP3 ? 'audio/mpeg' : 'audio/aac';
        const filename = `${session.client_name || 'session'}_${session_id.slice(0, 8)}_${channelParam}.${ext}`;
        
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
        const { spawn } = require('child_process');

        const args = ['-i', vodM3u8];
        if (isMP3) {
            args.push('-c:a', 'libmp3lame', '-q:a', '2', '-f', 'mp3');
        } else {
            args.push('-c:a', 'copy', '-f', 'adts'); // fast copy
        }
        args.push('pipe:1');

        const proc = spawn(ffmpegInstaller.path, args);
        proc.stdout.pipe(res);

        proc.on('error', (err: any) => {
            console.error('[broadcast] FFmpeg export error:', err);
            if (!res.headersSent) {
                res.status(500).json({ status: 'error', message: 'Export failed' });
            }
        });

        req.on('close', () => {
            if (!proc.killed) {
                proc.kill();
            }
        });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// END SESSION
// ════════════════════════════════════════════════════════════════════════════

router.put('/:session_id/end', (req: Request, res: Response) => {
    try {
        const session_id = req.params.session_id as string;

        const session = db.getSession(session_id);
        if (!session) {
            res.status(404).json({ status: 'error', message: 'Session not found' });
            return;
        }

        db.endSession(session_id);
        finalizeHLS(session_id);

        console.log(`[broadcast] Session ended: ${session_id}`);

        res.json({
            status: 'ended',
            session_id,
            message: 'Session ended. VOD playlist finalized.',
        });
    } catch (err: any) {
        console.error('[broadcast] End session error:', err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// GET SESSION INFO
// ════════════════════════════════════════════════════════════════════════════

router.get('/:session_id', (req: Request, res: Response) => {
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
            chunks_count: chunks.length,
            latest_sequence: chunks.length > 0 ? chunks[chunks.length - 1].sequence_num : -1,
        });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// REMOTE CONTROL COMMANDS
// ════════════════════════════════════════════════════════════════════════════

router.post('/remote-command', (req: Request, res: Response) => {
    try {
        const { client_id, command } = req.body;
        if (!client_id || !command) {
            res.status(400).json({ status: 'error', message: 'Missing client_id or command' });
            return;
        }

        db.setDeviceCommand(client_id, command);
        console.log(`[broadcast] Remote command set for ${client_id}: ${command}`);
        
        res.json({ status: 'success', client_id, command });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/command', (req: Request, res: Response) => {
    try {
        const client_id = req.query.client_id as string;
        const status = req.query.status as string; // 'idle' or 'recording'
        if (!client_id) {
            res.status(400).json({ status: 'error', message: 'Missing client_id' });
            return;
        }

        if (status) {
            db.updateDeviceStatus(client_id, status);
        }

        const cmd = db.getDeviceCommand(client_id);
        const commandStr = cmd ? cmd.command : 'NONE';
        const autoScreenshot = cmd ? cmd.auto_screenshot : 0;
        const screenshotInterval = cmd ? cmd.screenshot_interval : 30;
        
        // Don't clear START/STOP commands here — wait for the APK to acknowledge via /command/ack
        // Only clear transient one-shot commands that don't need reliability
        if (commandStr === 'SCREENSHOT_NOW') {
             db.clearDeviceCommand(client_id);
             console.log(`[broadcast] Transient command consumed by ${client_id}: ${commandStr}`);
        } else if (commandStr === 'START' || commandStr === 'STOP') {
             console.log(`[broadcast] Command delivered to ${client_id}: ${commandStr} (awaiting ACK)`);
        }

        res.json({ 
            command: commandStr,
            auto_screenshot: autoScreenshot,
            screenshot_interval: screenshotInterval
        });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// APK acknowledges it successfully processed a command
router.post('/command/ack', (req: Request, res: Response) => {
    try {
        const { client_id, command } = req.body;
        if (!client_id || !command) {
            res.status(400).json({ status: 'error', message: 'Missing client_id or command' });
            return;
        }
        
        // Only clear the command if it matches what the APK is acknowledging
        const current = db.getDeviceCommand(client_id);
        if (current && current.command === command) {
            db.clearDeviceCommand(client_id);
            console.log(`[broadcast] Command ACK received from ${client_id}: ${command}`);
        }
        
        res.json({ status: 'acknowledged', client_id, command });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.post('/screenshot-settings', (req: Request, res: Response) => {
    try {
        const { client_id, auto_screenshot, interval } = req.body;
        if (!client_id) {
            res.status(400).json({ status: 'error', message: 'Missing client_id' });
            return;
        }
        db.updateDeviceScreenshotSettings(client_id, auto_screenshot ? 1 : 0, interval || 30);
        res.json({ status: 'success' });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.post('/upload-screenshot', upload.single('image'), (req: Request, res: Response) => {
    try {
        const { client_id } = req.body;
        if (!client_id) {
            res.status(400).json({ status: 'error', message: 'Missing client_id' });
            return;
        }
        if (!req.file) {
            res.status(400).json({ status: 'error', message: 'Missing image file' });
            return;
        }
        
        const dir = path.join(PUBLIC_DIR, 'screenshots');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        fs.writeFileSync(path.join(dir, `${client_id}.jpg`), req.file.buffer);
        
        res.json({ status: 'success' });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

export default router;
