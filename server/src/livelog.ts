/**
 * livelog.ts — In-memory live log capture + Server-Sent Events (SSE) fan-out.
 *
 * Captures EVERY console.log/info/warn/error produced by the server
 * (telemetry, websocket, broadcast, hls, storage, ...) into a ring buffer
 * and streams each entry in real time to the stealth dashboard's
 * "Live Server Logs" box.
 *
 * Endpoints (registered in index.ts, stealth-role protected):
 *   GET  <STEALTH_ROUTE>/live-logs         — SSE stream (replays recent buffer)
 *   GET  <STEALTH_ROUTE>/live-logs/recent  — JSON snapshot of recent entries
 */

import { Request, Response } from 'express';

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
        try { pushLog('log', ...args); } catch { /* ignore */ }
        origLog(...args);
    };
    console.info = (...args: unknown[]) => {
        try { pushLog('info', ...args); } catch { /* ignore */ }
        origInfo(...args);
    };
    console.warn = (...args: unknown[]) => {
        try { pushLog('warn', ...args); } catch { /* ignore */ }
        origWarn(...args);
    };
    console.error = (...args: unknown[]) => {
        try { pushLog('error', ...args); } catch { /* ignore */ }
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
