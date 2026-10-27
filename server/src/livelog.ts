/**
 * livelog.ts — In-memory live log capture + persistent log files + SSE fan-out.
 *
 * Captures EVERY console.log/info/warn/error produced by the server
 * (telemetry, websocket, broadcast, hls, storage, ...) into:
 *   1. an in-memory ring buffer (stealth dashboard Live Logs box), AND
 *   2. a rotating log file on disk (logs/server.log, 50 MB per file,
 *      up to LOG_MAX_FILES rotated copies -> ~500 MB of history).
 *
 * The disk history SURVIVES SSE disconnects and lets you download the full
 * recent server history from the stealth dashboard.
 *
 * Endpoints (registered in index.ts, stealth-role protected):
 *   GET  <STEALTH_ROUTE>/live-logs           — SSE stream (replays recent buffer)
 *   GET  <STEALTH_ROUTE>/live-logs/recent    — JSON snapshot of recent entries
 *   GET  <STEALTH_ROUTE>/live-logs/download  — full rotated history as .txt
 */

import { Request, Response } from 'express';
import fsPromises from 'fs/promises';
import path from 'path';
import { LOG_DIR, LOG_FILE_MAX_MB, LOG_MAX_FILES } from './config';

export type LogLevel = 'log' | 'info' | 'warn' | 'error';

export interface LogEntry {
    id: number;
    ts: string;      // ISO timestamp
    level: LogLevel;
    tag: string;     // first [bracket] token of the message, or 'system'
    message: string;
}

const MAX_BUFFER = 800;      // entries kept in memory
const SSE_REPLAY_COUNT = 300; // entries replayed to a freshly connected viewer
const MAX_SUBSCRIBERS = 8;    // generous cap for dashboards

const buffer: LogEntry[] = [];
let nextId = 1;
const subscribers = new Set<Response>();
let captureInstalled = false;
let inInternalCall = false;

// ══════════════════════════════════════════════════════════════════════════
// PERSISTENT LOG FILE (rotating, survives restarts-until-redeploy)
// ════════════════════════════════════════════════════════════════════════

const LOG_FILE = path.join(LOG_DIR, 'server.log');
const LOG_MAX_BYTES = LOG_FILE_MAX_MB * 1024 * 1024;

/** Serialized appender — guarantees lines never interleave, never blocks callers. */
let writeChain: Promise<void> = Promise.resolve();

function rotateLogFiles(): Promise<void> {
    return (async () => {
        // server.log.(N-1) -> deleted; server.log.(N-2) -> .(N-1); ... server.log -> server.log.1
        const oldest = path.join(LOG_DIR, `server.log.${LOG_MAX_FILES - 1}`);
        try { await fsPromises.rm(oldest, { force: true }); } catch { }
        for (let i = LOG_MAX_FILES - 2; i >= 1; i--) {
            const from = path.join(LOG_DIR, `server.log.${i}`);
            const to = path.join(LOG_DIR, `server.log.${i + 1}`);
            try { await fsPromises.rename(from, to); } catch { /* missing file: skip */ }
        }
        try { await fsPromises.rename(LOG_FILE, path.join(LOG_DIR, 'server.log.1')); } catch { }
    })();
}

/** Append one line to logs/server.log, rotating at LOG_FILE_MAX_MB. */
function persistLine(line: string): void {
    writeChain = writeChain.then(async () => {
        try {
            try {
                const st = await fsPromises.stat(LOG_FILE);
                if (st.size + line.length > LOG_MAX_BYTES) {
                    await rotateLogFiles();
                }
            } catch {
                // current file doesn't exist yet — ensure the directory does
            }
            await fsPromises.mkdir(path.dirname(LOG_FILE), { recursive: true });
            await fsPromises.appendFile(LOG_FILE, line, 'utf8');
        } catch {
            /* NEVER break the app because of log persistence */
        }
    });
}

/** Every rotated log file that exists, OLDEST first (for download). */
async function listLogFilesOldestFirst(): Promise<string[]> {
    const files: string[] = [];
    for (let i = LOG_MAX_FILES - 1; i >= 1; i--) {
        const p = path.join(LOG_DIR, `server.log.${i}`);
        try { await fsPromises.access(p); files.push(p); } catch { }
    }
    try { await fsPromises.access(LOG_FILE); files.push(LOG_FILE); } catch { }
    return files;
}

/** Await until every queued persistence write has hit the disk. */
export async function flushPendingWrites(): Promise<void> {
    await writeChain;
}

/** Extract the leading [tag] from a log line, e.g. "[ws] Telemetry ..." -> "ws" */
function classifyTag(text: string): string {
    const m = text.match(/^\s*\[([^\]]+)\]/);
    return m ? m[1] : 'system';
}

function stringifyArg(a: unknown): string {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
    try {
        return JSON.stringify(a);
    } catch {
        return String(a);
    }
}

/** Push a structured entry into the ring buffer and fan out to SSE viewers. */
export function pushLog(level: LogLevel, tagOrMessage: string, ...rest: unknown[]): LogEntry {
    const full = [tagOrMessage, ...rest.map(stringifyArg)].join(' ');
    const entry: LogEntry = {
        id: nextId++,
        ts: new Date().toISOString(),
        level,
        tag: classifyTag(full),
        message: full,
    };

    buffer.push(entry);
    if (buffer.length > MAX_BUFFER) {
        buffer.splice(0, buffer.length - MAX_BUFFER);
    }

    // Persist EVERY line to the rotating file (50 MB x LOG_MAX_FILES history)
    persistLine(`${entry.ts} [${entry.level}] ${entry.message}\n`);

    if (subscribers.size > 0 && !inInternalCall) {
        inInternalCall = true;
        try {
            const payload = `data: ${JSON.stringify({ type: 'log', entry })}\n\n`;
            for (const res of Array.from(subscribers)) {
                try {
                    res.write(payload);
                } catch {
                    subscribers.delete(res);
                }
            }
        } catch {
            /* never let logging break the app */
        } finally {
            inInternalCall = false;
        }
    }

    return entry;
}

/**
 * Monkey-patch console so every existing console.* call in the app is
 * captured without touching each file. Original behavior is preserved.
 */
export function initLiveLogCapture(): void {
    if (captureInstalled) return;
    captureInstalled = true;

    const origLog = console.log.bind(console);
    const origInfo = console.info.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);

    console.log = (...args: unknown[]) => {
        try { pushLog('log', args.length > 0 ? stringifyArg(args[0]) : '', ...args.slice(1)); } catch { /* ignore */ }
        origLog(...args);
    };
    console.info = (...args: unknown[]) => {
        try { pushLog('info', args.length > 0 ? stringifyArg(args[0]) : '', ...args.slice(1)); } catch { /* ignore */ }
        origInfo(...args);
    };
    console.warn = (...args: unknown[]) => {
        try { pushLog('warn', args.length > 0 ? stringifyArg(args[0]) : '', ...args.slice(1)); } catch { /* ignore */ }
        origWarn(...args);
    };
    console.error = (...args: unknown[]) => {
        try { pushLog('error', args.length > 0 ? stringifyArg(args[0]) : '', ...args.slice(1)); } catch { /* ignore */ }
        origError(...args);
    };
}

/** Convenience helper for explicit structured events (e.g. API request log). */
export function logApi(method: string, url: string, statusCode: number, durationMs: number): void {
    const level: LogLevel =
        statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'log';
    const cleanUrl = url.length > 180 ? `${url.slice(0, 180)}…` : url;
    pushLog(level, `[api] ${method} ${cleanUrl} → ${statusCode} (${durationMs}ms)`);
}

/**
 * Stealth-only endpoint: stream the FULL rotated log history (oldest -> newest)
 * as a downloadable .txt file. Streams chunk-by-chunk so even ~500 MB never
 * buffers in memory.
 */
export async function handleLiveLogDownload(_req: Request, res: Response): Promise<void> {
    // Flush any queued writes first so the download always includes the
    // very latest lines (appends are async by design — never block callers).
    try { await flushPendingWrites(); } catch { }

    let files: string[];
    try {
        files = await listLogFilesOldestFirst();
    } catch {
        files = [];
    }
    if (files.length === 0) {
        res.status(404).json({ status: 'error', message: 'No persistent logs yet.' });
        return;
    }

    res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="server-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt"`,
        'Cache-Control': 'no-cache',
    });

    for (const file of files) {
        try {
            const fh = await fsPromises.open(file, 'r');
            try {
                const CHUNK = 1024 * 1024; // 1 MB read chunks
                const { size } = await fh.stat();
                let pos = 0;
                while (pos < size) {
                    const read = Math.min(CHUNK, size - pos);
                    const buf = Buffer.allocUnsafe ? Buffer.allocUnsafe(read) : Buffer.alloc(read);
                    await fh.read(buf, 0, read, pos);
                    res.write(buf);
                    pos += read;
                }
            } finally {
                await fh.close();
            }
        } catch {
            // skip unreadable file, keep streaming the rest
        }
    }
    res.end();
}

/** Get the most recent entries (for initial replay / manual refresh). */
export function getRecentEntries(count: number = SSE_REPLAY_COUNT): LogEntry[] {
    if (buffer.length <= count) return buffer.slice();
    return buffer.slice(buffer.length - count);
}

/**
 * SSE endpoint handler. Sends:
 *   1. retry hint
 *   2. { type: 'buffer', entries: [...] }   — recent history replay
 *   3. { type: 'log', entry: {...} }        — live entries as they occur
 *   4. ": keepalive" comments every 25s to survive proxies
 */
export function handleLiveLogSse(req: Request, res: Response): void {
    if (subscribers.size >= MAX_SUBSCRIBERS) {
        res.status(503).json({ status: 'error', message: 'Too many live log viewers.' });
        return;
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    try {
        res.write('retry: 3000\n\n');
        res.write(`data: ${JSON.stringify({ type: 'buffer', entries: getRecentEntries() })}\n\n`);
    } catch {
        return;
    }

    subscribers.add(res);

    const keepAlive = setInterval(() => {
        try {
            res.write(': keepalive\n\n');
        } catch {
            /* handled by close */
        }
    }, 25000);

    req.on('close', () => {
        clearInterval(keepAlive);
        subscribers.delete(res);
    });
}
