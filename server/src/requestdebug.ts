/**
 * requestdebug.ts — Raw Request Inspector ("show me EXACTLY what the API gets").
 *
 * Logs every incoming /api request the MOMENT it arrives — before auth,
 * before multer, before any processing — so you can see in the stealth
 * dashboard's Live Server Logs box:
 *
 *   [req] → POST /api/v1/broadcasts/1/chunk · ip 172.58.x.x · ua okhttp/4.9.3 · ct multipart/form-data · len 1.2MB
 *   [req]   ↳ body {"client_id":"xyz","status":"recording"}        (JSON bodies only)
 *   [req]   ↳ parts: audio="chunk_1729..._.aac"(842.1KB audio/aac) (multipart, after parse)
 *
 * This answers "what is the phone ACTUALLY sending?" — including requests
 * that fail auth, fail multer, or hit unknown routes (the [api] completion
 * line shows the status code the server answered with).
 *
 * Disable with env: DEBUG_REQUESTS=0   (default: ON)
 */

import { Request, Response, NextFunction } from 'express';

// Read dynamically (not at import time) so it can be toggled live / in tests.
export function isRequestDebugEnabled(): boolean {
    return (process.env.DEBUG_REQUESTS || '1') !== '0';
}

// Ultra-noisy endpoints (health checks / the log stream itself) are skipped —
// the log must never feed itself into a loop.
const SKIPPED_EXACT = new Set<string>([
    '/api/v1/health',
    '/api/v1/auth/session',
    '/up',
]);

export function isSkippedPath(originalUrl: string): boolean {
    const p = (originalUrl || '').split('?')[0];
    if (SKIPPED_EXACT.has(p)) return true;
    if (p.endsWith('/live-logs') || p.endsWith('/live-logs/recent') || p.endsWith('/live-logs/download')) return true;
    return false;
}

/** Best-effort client IP: honors Render's X-Forwarded-For proxy header. */
export function getClientIp(req: Request): string {
    const xff = req.headers?.['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
    if (Array.isArray(xff) && xff.length > 0) return String(xff[0]).split(',')[0].trim();
    return (req as any).ip || (req.socket && req.socket.remoteAddress) || '?';
}

export function formatBytes(n: number | string | undefined | null): string {
    let v: number = typeof n === 'string' ? parseInt(n, 10) : Number(n);
    if (!v || isNaN(v) || v <= 0) return '0B';
    if (v < 1024) return `${v}B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`;
    return `${(v / (1024 * 1024)).toFixed(2)}MB`;
}

const SENSITIVE_KEY = /pass|secret|token|auth|cookie/i;
const MAX_BODY_PREVIEW = 500;

/** JSON body → safe one-line preview. Masks password/secret/token fields. */
export function sanitizeBodyPreview(body: any, maxLen: number = MAX_BODY_PREVIEW): string {
    try {
        if (body === undefined || body === null) return '';
        if (typeof body !== 'object') {
            const s = String(body);
            return s ? (s.length > maxLen ? s.slice(0, maxLen) + `…(+${s.length - maxLen}ch)` : s) : '';
        }
        if (Object.keys(body).length === 0) return '';
        const json = JSON.stringify(body, (key, value) => {
            if (SENSITIVE_KEY.test(key) && typeof value === 'string' && value.length > 0) return '***';
            return value;
        });
        if (!json || json === '{}') return '';
        return json.length > maxLen ? json.slice(0, maxLen) + `…(+${json.length - maxLen}ch)` : json;
    } catch {
        return '<unprintable body>';
    }
}

/** One compact line describing the incoming request. */
export function describeRequest(req: Request): string {
    const ua = String((req.headers && req.headers['user-agent']) || '-');
    const uaShort = ua.length > 48 ? ua.slice(0, 48) + '…' : ua;
    let ct = String((req.headers && req.headers['content-type']) || '');
    if (ct) ct = ct.split(';')[0].trim(); // strip multipart boundary noise
    const parts = [
        `${req.method} ${req.originalUrl}`,
        `ip ${getClientIp(req)}`,
        `ua ${uaShort}`,
    ];
    if (ct) parts.push(`ct ${ct}`);
    if (req.headers && req.headers['content-length']) {
        parts.push(`len ${formatBytes(req.headers['content-length'] as any)}`);
    }
    return parts.join(' · ');
}

interface MulterFileLike { originalname?: string; fieldname?: string; size?: number; mimetype?: string; }

/**
 * Multipart summary — works with multer .any() (array) and .fields() (map).
 * Read at res 'finish' time, when multer has already populated req.files.
 */
export function describeFiles(files: unknown, maxList: number = 3): string {
    try {
        let list: MulterFileLike[] = [];
        if (Array.isArray(files)) {
            list = files as MulterFileLike[];
        } else if (files && typeof files === 'object') {
            for (const arr of Object.values(files as Record<string, MulterFileLike[]>)) {
                if (Array.isArray(arr)) list = list.concat(arr);
            }
        }
        if (list.length === 0) return '';
        const shown = list.slice(0, maxList).map(f =>
            `${f.fieldname || '?'}="${String(f.originalname || '?').slice(0, 60)}"(${formatBytes(f.size)} ${f.mimetype || '?'})`
        ).join(', ');
        const extra = list.length > maxList ? ` +${list.length - maxList} more` : '';
        return `parts: ${shown}${extra}`;
    } catch {
        return '';
    }
}

/**
 * Express middleware — mount BEFORE auth to see even rejected requests:
 *     app.use('/api', requestInspector());
 */
export function requestInspector() {
    return (req: Request, res: Response, next: NextFunction) => {
        try {
            if (isRequestDebugEnabled() && !isSkippedPath(req.originalUrl || '')) {
                console.log(`[req] → ${describeRequest(req)}`);
                const bodyPreview = sanitizeBodyPreview(req.body);
                if (bodyPreview) console.log(`[req]   ↳ body ${bodyPreview}`);
                res.on('finish', () => {
                    try {
                        const parts = describeFiles((req as any).files);
                        if (parts) console.log(`[req]   ↳ ${parts}`);
                    } catch { /* never break requests because of logging */ }
                });
            }
        } catch { /* never break requests because of logging */ }
        next();
    };
}
