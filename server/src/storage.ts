/**
 * storage.ts — Disk storage manager for audio sessions.
 *
 * Directory structure per session:
 *   public/storage/sessions/:session_id/
 *     ├── raw/       ← Incoming audio chunks from broadcaster
 *     └── hls/       ← FFmpeg-generated .m3u8 + .ts segments
 *
 * Handles:
 *   - Directory creation
 *   - Chunk saving to /raw/
 *   - Full session deletion (rm -rf)
 *   - Disk space monitoring
 */

import fs from 'fs';
import path from 'path';
import { STORAGE_ROOT } from './config';

// ════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ════════════════════════════════════════════════════════════════════════════

export function ensureStorageRoot(): void {
    fs.mkdirSync(STORAGE_ROOT, { recursive: true });
    console.log(`[storage] Root: ${STORAGE_ROOT}`);
}

// ════════════════════════════════════════════════════════════════════════════
// SESSION DIRECTORIES
// ════════════════════════════════════════════════════════════════════════════

export function getSessionDir(sessionId: string): string {
    return path.join(STORAGE_ROOT, sessionId);
}

export function getRawDir(sessionId: string): string {
    return path.join(STORAGE_ROOT, sessionId, 'raw');
}

export function getHlsDir(sessionId: string): string {
    return path.join(STORAGE_ROOT, sessionId, 'hls');
}

export function createSessionDirs(sessionId: string): { raw: string; hls: string } {
    const rawDir = getRawDir(sessionId);
    const hlsDir = getHlsDir(sessionId);
    fs.mkdirSync(rawDir, { recursive: true });
    fs.mkdirSync(hlsDir, { recursive: true });
    return { raw: rawDir, hls: hlsDir };
}

// ════════════════════════════════════════════════════════════════════════════
// CHUNK STORAGE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Save an audio chunk to the session's raw directory.
 * Returns the saved file path and metadata.
 */
export function saveChunk(
    sessionId: string,
    sequenceNum: number,
    buffer: Buffer,
    originalFilename: string = ''
): { filepath: string; filename: string; fileSize: number } {
    const rawDir = getRawDir(sessionId);
    fs.mkdirSync(rawDir, { recursive: true });

    // Filename: zero-padded sequence number
    const ext = path.extname(originalFilename) || '.wav';
    const filename = `chunk_${sequenceNum.toString().padStart(6, '0')}${ext}`;
    const filepath = path.join(rawDir, filename);

    fs.writeFileSync(filepath, buffer);

    return {
        filepath,
        filename,
        fileSize: buffer.length,
    };
}

// ════════════════════════════════════════════════════════════════════════════
// DELETION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Delete an entire session directory and all its contents.
 * This is the "nuke from orbit" deletion — permanently frees disk space.
 */
export function deleteSessionFiles(sessionId: string): boolean {
    const sessionDir = getSessionDir(sessionId);

    // Security: verify path is inside storage root
    const resolvedDir = path.resolve(sessionDir);
    const resolvedRoot = path.resolve(STORAGE_ROOT);
    if (!resolvedDir.startsWith(resolvedRoot)) {
        console.warn(`[storage] Path traversal blocked: ${sessionDir}`);
        return false;
    }

    if (!fs.existsSync(sessionDir)) {
        return false;
    }

    try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log(`[storage] Deleted session directory: ${sessionId}`);
        return true;
    } catch (err) {
        console.error(`[storage] Failed to delete ${sessionId}:`, err);
        return false;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// DISK INFO
// ════════════════════════════════════════════════════════════════════════════

export interface StorageInfo {
    sessions_on_disk: number;
    total_bytes: number;
    total_human: string;
    free_bytes: number;
    free_human: string;
}

export function getStorageInfo(): StorageInfo {
    let totalBytes = 0;
    let sessionCount = 0;

    try {
        if (fs.existsSync(STORAGE_ROOT)) {
            const entries = fs.readdirSync(STORAGE_ROOT, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    sessionCount++;
                    totalBytes += getDirSize(path.join(STORAGE_ROOT, entry.name));
                }
            }
        }
    } catch { /* ignore */ }

    // Get free disk space (Node.js 18.15+ has fs.statfsSync)
    let freeBytes = 0;
    try {
        const stats = fs.statfsSync(STORAGE_ROOT);
        freeBytes = stats.bfree * stats.bsize;
    } catch {
        // Fallback — not available on older Node.js
    }

    return {
        sessions_on_disk: sessionCount,
        total_bytes: totalBytes,
        total_human: formatSize(totalBytes),
        free_bytes: freeBytes,
        free_human: formatSize(freeBytes),
    };
}

function getDirSize(dirPath: string): number {
    let size = 0;
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isFile()) {
                size += fs.statSync(fullPath).size;
            } else if (entry.isDirectory()) {
                size += getDirSize(fullPath);
            }
        }
    } catch { /* ignore */ }
    return size;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
