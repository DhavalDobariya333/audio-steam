/**
 * hls.ts — FFmpeg-based HLS playlist generator with Discontinuity & Fast-path metadata.
 *
 * Converts incoming raw audio chunks into HLS-compatible segments:
 *   1. Takes a raw audio chunk (AAC/PCM)
 *   2. Encodes/packages it via FFmpeg into a .ts segment file
 *   3. Maintains the .m3u8 playlists (live sliding window + full VOD)
 *   4. Emits #EXT-X-DISCONTINUITY tags whenever sequence gaps (silence/drops) occur
 *   5. Avoids spawning ffprobe per chunk when duration_ms is provided by the client
 */

import { exec, execSync, spawn } from 'child_process';
import util from 'util';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { getHlsDir } from './storage';
import { HLS_SEGMENT_DURATION, HLS_LIST_SIZE } from './config';

const execAsync = util.promisify(exec);

// ════════════════════════════════════════════════════════════════════════════
// FFMPEG AVAILABILITY CHECK
// ════════════════════════════════════════════════════════════════════════════

let ffmpegAvailable = false;
let FFMPEG_PATH = '';
let FFPROBE_PATH = '';

/** Verify a binary actually executes (exit code 0 on -version). */
function canRun(bin: string): boolean {
    try {
        execSync(`"${bin}" -version`, { stdio: 'ignore', timeout: 15000 });
        return true;
    } catch {
        return false;
    }
}

/**
 * Resolve a working ffmpeg/ffprobe binary.
 *
 * Order:
 *   1. npm @ffmpeg-installer / @ffprobe-installer bundled static binary
 *   2. System binary installed by the Dockerfile (apt-get install -y ffmpeg)
 *   3. Whatever is on PATH
 *
 * Each candidate is ACTUALLY EXECUTED with `-version` before being accepted.
 * This fixes the previous bug where checkFfmpeg() fired exec() fire-and-forget
 * and reported ffmpeg as available even when the binary could not run.
 */
function resolveMediaBinaries(): void {
    const ffmpegCandidates: string[] = [];
    const ffprobeCandidates: string[] = [];

    try {
        const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
        if (ffmpegInstaller?.path) ffmpegCandidates.push(ffmpegInstaller.path);
    } catch { /* npm installer not installed */ }
    try {
        const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
        if (ffprobeInstaller?.path) ffprobeCandidates.push(ffprobeInstaller.path);
    } catch { /* npm installer not installed */ }

    for (const dir of ['/usr/bin', '/usr/local/bin']) {
        ffmpegCandidates.push(path.join(dir, 'ffmpeg'));
        ffprobeCandidates.push(path.join(dir, 'ffprobe'));
    }
    ffmpegCandidates.push('ffmpeg');
    ffprobeCandidates.push('ffprobe');

    for (const candidate of ffmpegCandidates) {
        if (canRun(candidate)) {
            FFMPEG_PATH = candidate;
            console.log(`[hls] FFmpeg resolved and verified: ${candidate}`);
            break;
        }
        console.warn(`[hls] FFmpeg candidate failed to run: ${candidate}`);
    }

    for (const candidate of ffprobeCandidates) {
        if (canRun(candidate)) {
            FFPROBE_PATH = candidate;
            console.log(`[hls] FFprobe resolved and verified: ${candidate}`);
            break;
        }
    }
}

export function checkFfmpeg(): boolean {
    resolveMediaBinaries();
    ffmpegAvailable = !!FFMPEG_PATH;
    if (!ffmpegAvailable) {
        console.error('[hls] NO working FFmpeg found - HLS generation disabled! Install ffmpeg in the Docker image.');
    }
    return ffmpegAvailable;
}

/** Resolved ffmpeg binary path (usable by other modules, e.g. export-channel). */
export function getFfmpegPath(): string {
    return FFMPEG_PATH;
}

// ════════════════════════════════════════════════════════════════════════════
// HLS GENERATION QUEUE & STATE
// ════════════════════════════════════════════════════════════════════════════

type Task = () => Promise<void>;
const hlsQueues = new Map<string, Task[]>();
const isProcessing = new Set<string>();

// Active listener tracking: maps sessionId -> lastRequestTimestampMs
const activeListeners = new Map<string, number>();
const LISTENER_ACTIVE_WINDOW_MS = 60 * 1000; // 60 seconds

export function recordHlsListener(sessionId: string): void {
    activeListeners.set(sessionId, Date.now());
}

export function hasActiveHlsListener(sessionId: string): boolean {
    const lastActive = activeListeners.get(sessionId);
    if (!lastActive) return false;
    if (Date.now() - lastActive > LISTENER_ACTIVE_WINDOW_MS) {
        activeListeners.delete(sessionId);
        return false;
    }
    return true;
}

// Track sequence numbers per session to detect silence/drops for #EXT-X-DISCONTINUITY
const lastSequenceNums = new Map<string, number>();

function enqueueHlsTask(sessionId: string, task: Task) {
    if (!hlsQueues.has(sessionId)) {
        hlsQueues.set(sessionId, []);
    }
    hlsQueues.get(sessionId)!.push(task);
    processNextHlsTask(sessionId);
}

async function processNextHlsTask(sessionId: string) {
    if (isProcessing.has(sessionId)) return;

    const queue = hlsQueues.get(sessionId)!;
    if (queue.length === 0) return;

    isProcessing.add(sessionId);
    const task = queue.shift()!;

    try {
        await task();
    } catch (err) {
        console.error(`[hls] Task error for session ${sessionId}:`, err);
    }

    isProcessing.delete(sessionId);
    processNextHlsTask(sessionId);
}

// ════════════════════════════════════════════════════════════════════════════
// HLS SEGMENT GENERATION
// ════════════════════════════════════════════════════════════════════════════

export interface SegmentInfo {
    filename: string;
    duration: number;
    discontinuity: boolean;
}

export async function appendToHLS(
    sessionId: string,
    chunkPath: string,
    sequenceNum: number,
    clientTimestamp?: string,
    durationMs?: number
): Promise<boolean> {
    if (!ffmpegAvailable) return false;

    return new Promise((resolve) => {
        enqueueHlsTask(sessionId, async () => {
            const success = await _processHlsChunk(sessionId, chunkPath, sequenceNum, clientTimestamp, durationMs);
            resolve(success);
        });
    });
}

async function _processHlsChunk(
    sessionId: string,
    chunkPath: string,
    sequenceNum: number,
    clientTimestamp?: string,
    durationMs?: number
): Promise<boolean> {
    const hlsDir = getHlsDir(sessionId);
    fs.mkdirSync(hlsDir, { recursive: true });

    let dateStr = clientTimestamp ? clientTimestamp.replace(/[:.]/g, '-') : new Date().toISOString().replace(/[:.]/g, '-');
    const segmentFilename = `seg_${sequenceNum.toString().padStart(6, '0')}_${dateStr}.ts`;
    const segmentPath = path.join(hlsDir, segmentFilename);

    // Detect if this segment represents a discontinuity (e.g. Silence skipped or dropped chunks)
    const prevSeq = lastSequenceNums.get(sessionId);
    const isDiscontinuity = prevSeq !== undefined && sequenceNum > prevSeq + 1;
    lastSequenceNums.set(sessionId, sequenceNum);

    if (isDiscontinuity) {
        console.log(`[hls] Discontinuity detected for session ${sessionId}: seq ${prevSeq} -> ${sequenceNum}`);
    }

    // ── Step 1: Transcode / Package raw chunk → MPEG-TS segment ──
    try {
        await runFfmpeg([
            '-y',
            '-i', chunkPath,
            '-c:a', 'copy',
            '-f', 'mpegts',
            segmentPath,
        ]);
    } catch (err) {
        console.error(`[hls] FFmpeg encode failed for seq ${sequenceNum}:`, err);
        return false;
    }

    if (!fs.existsSync(segmentPath)) {
        return false;
    }

    // ── Step 2: Get segment duration (Fast Path: client metadata; Fallback: ffprobe) ──
    let segDuration: number;
    if (durationMs && durationMs > 0) {
        segDuration = durationMs / 1000.0;
    } else {
        // Fallback to ffprobe only if client did not supply duration
        segDuration = HLS_SEGMENT_DURATION;
        try {
            const { stdout } = await execAsync(
                `"${FFPROBE_PATH}" -v quiet -show_entries format=duration -of csv=p=0 "${segmentPath}"`,
                { encoding: 'utf-8' }
            );
            const parsed = parseFloat(stdout.trim());
            if (!isNaN(parsed) && parsed > 0) segDuration = parsed;
        } catch {
            // Default to HLS_SEGMENT_DURATION on error
        }
    }

    // ── Step 3: Update playlists ──
    await updateLivePlaylist(hlsDir, segmentFilename, segDuration, sequenceNum, isDiscontinuity);
    await updateVodPlaylist(hlsDir, segmentFilename, segDuration, isDiscontinuity);

    return true;
}

// ════════════════════════════════════════════════════════════════════════════
// PLAYLIST MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════

async function updateLivePlaylist(
    hlsDir: string,
    segmentFilename: string,
    duration: number,
    sequenceNum: number,
    discontinuity: boolean
): Promise<void> {
    const playlistPath = path.join(hlsDir, 'live.m3u8');
    const segments: SegmentInfo[] = [];
    let mediaSequence = 0;

    try {
        const content = await fsPromises.readFile(playlistPath, 'utf-8');
        const lines = content.split('\n');

        let nextDiscontinuity = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const seqMatch = line.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/);
            if (seqMatch) {
                mediaSequence = parseInt(seqMatch[1], 10);
            }

            if (line === '#EXT-X-DISCONTINUITY') {
                nextDiscontinuity = true;
                continue;
            }

            const extInfMatch = line.match(/^#EXTINF:([\d.]+)/);
            if (extInfMatch && i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
                segments.push({
                    filename: lines[i + 1].trim(),
                    duration: parseFloat(extInfMatch[1]),
                    discontinuity: nextDiscontinuity,
                });
                nextDiscontinuity = false;
            }
        }
    } catch {
        // File doesn't exist yet
    }

    segments.push({
        filename: segmentFilename,
        duration,
        discontinuity,
    });

    while (segments.length > HLS_LIST_SIZE) {
        segments.shift();
        mediaSequence++;
    }

    const targetDuration = Math.ceil(Math.max(...segments.map(s => s.duration), HLS_SEGMENT_DURATION));

    let m3u8 = '#EXTM3U\n';
    m3u8 += '#EXT-X-VERSION:3\n';
    m3u8 += `#EXT-X-TARGETDURATION:${targetDuration}\n`;
    m3u8 += `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}\n`;
    m3u8 += '\n';

    for (const seg of segments) {
        if (seg.discontinuity) {
            m3u8 += '#EXT-X-DISCONTINUITY\n';
        }
        m3u8 += `#EXTINF:${seg.duration.toFixed(6)},\n`;
        m3u8 += `${seg.filename}\n`;
    }

    // Atomic write to prevent client from reading an incomplete file
    const tmpPath = `${playlistPath}.tmp`;
    await fsPromises.writeFile(tmpPath, m3u8);
    await fsPromises.rename(tmpPath, playlistPath);
}

async function updateVodPlaylist(
    hlsDir: string,
    segmentFilename: string,
    duration: number,
    discontinuity: boolean
): Promise<void> {
    const playlistPath = path.join(hlsDir, 'vod.m3u8');
    const segments: SegmentInfo[] = [];

    try {
        const content = await fsPromises.readFile(playlistPath, 'utf-8');
        const lines = content.split('\n');

        let nextDiscontinuity = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line === '#EXT-X-DISCONTINUITY') {
                nextDiscontinuity = true;
                continue;
            }

            const extInfMatch = line.match(/^#EXTINF:([\d.]+)/);
            if (extInfMatch && i + 1 < lines.length && !lines[i + 1].startsWith('#') && lines[i + 1].trim()) {
                segments.push({
                    filename: lines[i + 1].trim(),
                    duration: parseFloat(extInfMatch[1]),
                    discontinuity: nextDiscontinuity,
                });
                nextDiscontinuity = false;
            }
        }
    } catch {
        // File doesn't exist yet
    }

    if (!segments.some(s => s.filename === segmentFilename)) {
        segments.push({
            filename: segmentFilename,
            duration,
            discontinuity,
        });
    }

    const targetDuration = Math.ceil(Math.max(...segments.map(s => s.duration), HLS_SEGMENT_DURATION));

    let m3u8 = '#EXTM3U\n';
    m3u8 += '#EXT-X-VERSION:3\n';
    m3u8 += `#EXT-X-TARGETDURATION:${targetDuration}\n`;
    m3u8 += '#EXT-X-MEDIA-SEQUENCE:0\n';
    m3u8 += '#EXT-X-PLAYLIST-TYPE:EVENT\n';
    m3u8 += '\n';

    for (const seg of segments) {
        if (seg.discontinuity) {
            m3u8 += '#EXT-X-DISCONTINUITY\n';
        }
        m3u8 += `#EXTINF:${seg.duration.toFixed(6)},\n`;
        m3u8 += `${seg.filename}\n`;
    }

    // Atomic write
    const tmpPath = `${playlistPath}.tmp`;
    await fsPromises.writeFile(tmpPath, m3u8);
    await fsPromises.rename(tmpPath, playlistPath);
}

export function finalizeHLS(sessionId: string): void {
    lastSequenceNums.delete(sessionId);
    enqueueHlsTask(sessionId, async () => {
        const hlsDir = getHlsDir(sessionId);
        const vodPath = path.join(hlsDir, 'vod.m3u8');

        if (!fs.existsSync(vodPath)) return;

        let content = await fsPromises.readFile(vodPath, 'utf-8');
        if (!content.includes('#EXT-X-ENDLIST')) {
            content = content.replace('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:VOD');
            content += '#EXT-X-ENDLIST\n';
            await fsPromises.writeFile(vodPath, content);
            console.log(`[hls] Finalized VOD playlist for session ${sessionId}`);
        }
    });
}

function runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(FFMPEG_PATH, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderr = '';
        proc.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
            }
        });

        proc.on('error', (err) => {
            reject(err);
        });
    });
}
