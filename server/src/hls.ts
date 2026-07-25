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

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getHlsDir } from './storage';
import { HLS_SEGMENT_DURATION, HLS_LIST_SIZE } from './config';

// ════════════════════════════════════════════════════════════════════════════
// FFMPEG AVAILABILITY CHECK
// ════════════════════════════════════════════════════════════════════════════

let ffmpegAvailable = false;

export function checkFfmpeg(): boolean {
    try {
        execSync('ffmpeg -version', { stdio: 'ignore' });
        ffmpegAvailable = true;
        console.log('[hls] FFmpeg found');
        return true;
    } catch {
        ffmpegAvailable = false;
        console.warn('[hls] FFmpeg NOT found — HLS generation disabled');
        console.warn('[hls] Install FFmpeg to enable live streaming');
        return false;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// HLS SEGMENT GENERATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Convert a raw audio chunk to an AAC .ts segment and update playlists.
 *
 * @param sessionId   - The broadcast session ID
 * @param chunkPath   - Absolute path to the raw audio chunk (WAV)
 * @param sequenceNum - Chunk sequence number (used for segment naming)
 * @returns Promise<boolean> - true if HLS generation succeeded
 */
export async function appendToHLS(
    sessionId: string,
    chunkPath: string,
    sequenceNum: number
): Promise<boolean> {
    if (!ffmpegAvailable) return false;

    const hlsDir = getHlsDir(sessionId);
    fs.mkdirSync(hlsDir, { recursive: true });

    const segmentFilename = `seg_${sequenceNum.toString().padStart(6, '0')}.ts`;
    const segmentPath = path.join(hlsDir, segmentFilename);

    // ── Step 1: Transcode raw chunk → AAC .ts segment ──
    try {
        await runFfmpeg([
            '-y',                       // Overwrite output
            '-i', chunkPath,            // Input: raw WAV chunk
            '-c:a', 'aac',             // AAC codec
            '-b:a', '64k',            // 64 kbps — good for speech
            '-ar', '44100',            // Standard sample rate for AAC
            '-ac', '1',                // Mono
            '-f', 'mpegts',            // MPEG-TS container
            segmentPath,               // Output
        ]);
    } catch (err) {
        console.error(`[hls] FFmpeg encode failed for seq ${sequenceNum}:`, err);
        return false;
    }

    // Verify segment was created
    if (!fs.existsSync(segmentPath)) {
        console.error(`[hls] Segment file not created: ${segmentPath}`);
        return false;
    }

    // ── Step 2: Get segment duration ──
    let segDuration = HLS_SEGMENT_DURATION;
    try {
        const probe = execSync(
            `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${segmentPath}"`,
            { encoding: 'utf-8' }
        ).trim();
        const parsed = parseFloat(probe);
        if (!isNaN(parsed) && parsed > 0) segDuration = parsed;
    } catch {
        // Use default duration
    }

    // ── Step 3: Update playlists ──
    updateLivePlaylist(hlsDir, segmentFilename, segDuration, sequenceNum);
    updateVodPlaylist(hlsDir, segmentFilename, segDuration);

    return true;
}

// ════════════════════════════════════════════════════════════════════════════
// PLAYLIST MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════

/**
 * Update the live.m3u8 playlist (sliding window for live listeners).
 */
function updateLivePlaylist(
    hlsDir: string,
    segmentFilename: string,
    duration: number,
    sequenceNum: number
): void {
    const playlistPath = path.join(hlsDir, 'live.m3u8');

    // Read existing segments from playlist
    const segments: { filename: string; duration: number }[] = [];
    let mediaSequence = 0;

    if (fs.existsSync(playlistPath)) {
        const content = fs.readFileSync(playlistPath, 'utf-8');
        const lines = content.split('\n');

        for (const line of lines) {
            const seqMatch = line.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/);
            if (seqMatch) mediaSequence = parseInt(seqMatch[1], 10);
        }

        // Parse existing segments
        for (let i = 0; i < lines.length; i++) {
            const extInfMatch = lines[i].match(/^#EXTINF:([\d.]+)/);
            if (extInfMatch && i + 1 < lines.length && !lines[i + 1].startsWith('#')) {
                segments.push({
                    filename: lines[i + 1].trim(),
                    duration: parseFloat(extInfMatch[1]),
                });
            }
        }
    }

    // Add new segment
    segments.push({ filename: segmentFilename, duration });

    // Keep only last N segments (sliding window)
    while (segments.length > HLS_LIST_SIZE) {
        segments.shift();
        mediaSequence++;
    }

    // Find max duration for target duration
    const targetDuration = Math.ceil(Math.max(...segments.map(s => s.duration), HLS_SEGMENT_DURATION));

    // Write playlist
    let m3u8 = '#EXTM3U\n';
    m3u8 += '#EXT-X-VERSION:3\n';
    m3u8 += `#EXT-X-TARGETDURATION:${targetDuration}\n`;
    m3u8 += `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}\n`;
    m3u8 += '\n';

    for (const seg of segments) {
        m3u8 += `#EXTINF:${seg.duration.toFixed(6)},\n`;
        m3u8 += `${seg.filename}\n`;
    }

    fs.writeFileSync(playlistPath, m3u8);
}

/**
 * Update the vod.m3u8 playlist (complete list for DVR / replay).
 */
function updateVodPlaylist(
    hlsDir: string,
    segmentFilename: string,
    duration: number
): void {
    const playlistPath = path.join(hlsDir, 'vod.m3u8');

    // Read existing segments
    const segments: { filename: string; duration: number }[] = [];

    if (fs.existsSync(playlistPath)) {
        const content = fs.readFileSync(playlistPath, 'utf-8');
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
    }

    // Add new segment (no duplicates)
    if (!segments.some(s => s.filename === segmentFilename)) {
        segments.push({ filename: segmentFilename, duration });
    }

    const targetDuration = Math.ceil(Math.max(...segments.map(s => s.duration), HLS_SEGMENT_DURATION));

    // Write playlist — NOTE: no #EXT-X-ENDLIST while live
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

    fs.writeFileSync(playlistPath, m3u8);
}

/**
 * Finalize the VOD playlist by appending #EXT-X-ENDLIST.
 * Called when a broadcast session ends.
 */
export function finalizeHLS(sessionId: string): void {
    const hlsDir = getHlsDir(sessionId);
    const vodPath = path.join(hlsDir, 'vod.m3u8');

    if (!fs.existsSync(vodPath)) return;

    let content = fs.readFileSync(vodPath, 'utf-8');
    if (!content.includes('#EXT-X-ENDLIST')) {
        // Change playlist type from EVENT to VOD
        content = content.replace('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:VOD');
        content += '#EXT-X-ENDLIST\n';
        fs.writeFileSync(vodPath, content);
        console.log(`[hls] Finalized VOD playlist for session ${sessionId}`);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// FFMPEG PROCESS WRAPPER
// ════════════════════════════════════════════════════════════════════════════

function runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', args, {
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
