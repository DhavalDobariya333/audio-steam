/**
 * hls.ts — FFmpeg-based HLS playlist generator.
 *
 * Converts incoming raw audio chunks into HLS-compatible segments:
 *   1. Takes a raw audio chunk (WAV/PCM)
 *   2. Encodes it to AAC via FFmpeg
 *   3. Outputs a .ts segment file
 *   4. Maintains the .m3u8 playlist (live sliding window + VOD)
 *
 * Playlist types:
 *   - live.m3u8:  Sliding window for live listeners (last N segments)
 *   - vod.m3u8:   Complete list for DVR / past recording playback
 *
 * Requires FFmpeg in system PATH.
 */

import { exec, spawn } from 'child_process';
import util from 'util';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { getHlsDir } from './storage';
import { HLS_SEGMENT_DURATION, HLS_LIST_SIZE } from './config';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

const FFMPEG_PATH = ffmpegInstaller.path;
const FFPROBE_PATH = ffprobeInstaller.path;
const execAsync = util.promisify(exec);

// ════════════════════════════════════════════════════════════════════════════
// FFMPEG AVAILABILITY CHECK
// ════════════════════════════════════════════════════════════════════════════

let ffmpegAvailable = false;

export function checkFfmpeg(): boolean {
    try {
        exec(`"${FFMPEG_PATH}" -version`);
        ffmpegAvailable = true;
        console.log('[hls] FFmpeg found via static binary');
        return true;
    } catch (e) {
        ffmpegAvailable = false;
        console.error('[hls] FFmpeg static binary failed to run:', e);
        return false;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// HLS GENERATION QUEUE (Prevents fork-bombs and race conditions)
// ════════════════════════════════════════════════════════════════════════════

type Task = () => Promise<void>;
const hlsQueues = new Map<string, Task[]>();
const isProcessing = new Set<string>();

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
    processNextHlsTask(sessionId); // Run next in queue
}

// ════════════════════════════════════════════════════════════════════════════
// HLS SEGMENT GENERATION
// ════════════════════════════════════════════════════════════════════════════

export async function appendToHLS(
    sessionId: string,
    chunkPath: string,
    sequenceNum: number,
    clientTimestamp?: string
): Promise<boolean> {
    if (!ffmpegAvailable) return false;

    // Enqueue the heavy work to prevent race conditions and limit concurrency
    return new Promise((resolve) => {
        enqueueHlsTask(sessionId, async () => {
            const success = await _processHlsChunk(sessionId, chunkPath, sequenceNum, clientTimestamp);
            resolve(success);
        });
    });
}

async function _processHlsChunk(
    sessionId: string,
    chunkPath: string,
    sequenceNum: number,
    clientTimestamp?: string
): Promise<boolean> {
    const hlsDir = getHlsDir(sessionId);
    fs.mkdirSync(hlsDir, { recursive: true });

    let dateStr = clientTimestamp ? clientTimestamp.replace(/[:.]/g, '-') : new Date().toISOString().replace(/[:.]/g, '-');
    const segmentFilename = `seg_${sequenceNum.toString().padStart(6, '0')}_${dateStr}.ts`;
    const segmentPath = path.join(hlsDir, segmentFilename);

    // ── Step 1: Transcode raw chunk → AAC .ts segment ──
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

    // ── Step 2: Get segment duration (Async) ──
    let segDuration = HLS_SEGMENT_DURATION;
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

    // ── Step 3: Update playlists ──
    await updateLivePlaylist(hlsDir, segmentFilename, segDuration, sequenceNum);
    await updateVodPlaylist(hlsDir, segmentFilename, segDuration);

    return true;
}

// ════════════════════════════════════════════════════════════════════════════
// PLAYLIST MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════

async function updateLivePlaylist(
    hlsDir: string,
    segmentFilename: string,
    duration: number,
    sequenceNum: number
): Promise<void> {
    const playlistPath = path.join(hlsDir, 'live.m3u8');
    const segments: { filename: string; duration: number }[] = [];
    let mediaSequence = 0;

    try {
        const content = await fsPromises.readFile(playlistPath, 'utf-8');
        const lines = content.split('\n');
        
        for (const line of lines) {
            const seqMatch = line.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/);
            if (seqMatch) mediaSequence = parseInt(seqMatch[1], 10);
        }

        for (let i = 0; i < lines.length; i++) {
            const extInfMatch = lines[i].match(/^#EXTINF:([\d.]+)/);
            if (extInfMatch && i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
                segments.push({
                    filename: lines[i + 1].trim(),
                    duration: parseFloat(extInfMatch[1]),
                });
            }
        }
    } catch (e) {
        // File doesn't exist yet, which is fine
    }

    segments.push({ filename: segmentFilename, duration });

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
        m3u8 += `#EXTINF:${seg.duration.toFixed(6)},\n`;
        m3u8 += `${seg.filename}\n`;
    }

    await fsPromises.writeFile(playlistPath, m3u8);
}

async function updateVodPlaylist(
    hlsDir: string,
    segmentFilename: string,
    duration: number
): Promise<void> {
    const playlistPath = path.join(hlsDir, 'vod.m3u8');
    const segments: { filename: string; duration: number }[] = [];

    try {
        const content = await fsPromises.readFile(playlistPath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const extInfMatch = lines[i].match(/^#EXTINF:([\d.]+)/);
            if (extInfMatch && i + 1 < lines.length && !lines[i + 1].startsWith('#') && lines[i + 1].trim()) {
                segments.push({
                    filename: lines[i + 1].trim(),
                    duration: parseFloat(extInfMatch[1]),
                });
            }
        }
    } catch (e) {
        // File doesn't exist yet
    }

    if (!segments.some(s => s.filename === segmentFilename)) {
        segments.push({ filename: segmentFilename, duration });
    }

    const targetDuration = Math.ceil(Math.max(...segments.map(s => s.duration), HLS_SEGMENT_DURATION));

    let m3u8 = '#EXTM3U\n';
    m3u8 += '#EXT-X-VERSION:3\n';
    m3u8 += `#EXT-X-TARGETDURATION:${targetDuration}\n`;
    m3u8 += '#EXT-X-MEDIA-SEQUENCE:0\n';
    m3u8 += '#EXT-X-PLAYLIST-TYPE:EVENT\n';
    m3u8 += '\n';

    for (const seg of segments) {
        m3u8 += `#EXTINF:${seg.duration.toFixed(6)},\n`;
        m3u8 += `${seg.filename}\n`;
    }

    await fsPromises.writeFile(playlistPath, m3u8);
}

export function finalizeHLS(sessionId: string): void {
    // We should enqueue this as well to prevent race conditions during finalize
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
                reject(new Error(`FFmpeg exit code ${code}: ${stderr.slice(-500)}`));
            }
        });

        proc.on('error', (err) => {
            reject(new Error(`FFmpeg spawn error: ${err.message}`));
        });
    });
}
