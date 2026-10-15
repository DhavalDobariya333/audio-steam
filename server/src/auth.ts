/**
 * auth.ts — Dual-Password Authentication and Role-Based Session Management.
 *
 * Supports two distinct tiers:
 *   1. 'main'    — Directed to Main Dashboard (/), no access to stealth console.
 *   2. 'stealth' — Directed to Stealth Hub (STEALTH_ROUTE), full access to both consoles.
 */

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { MAIN_PASSWORD, STEALTH_PASSWORD, DASHBOARD_USERNAME, AUTH_SECRET, STEALTH_ROUTE } from './config';

export type UserRole = 'main' | 'stealth';

export interface SessionData {
    role: UserRole;
    timestamp: number;
}

// Extend Express Request to hold role
declare global {
    namespace Express {
        interface Request {
            userRole?: UserRole;
        }
    }
}

export const SESSION_COOKIE_NAME = 'auth_session';
export const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60; // 7 days

/**
 * Creates an HMAC-signed session token.
 * Format: role:timestamp:hmac_signature
 */
export function createSessionToken(role: UserRole): string {
    const timestamp = Date.now();
    const payload = `${role}:${timestamp}`;
    const signature = crypto
        .createHmac('sha256', AUTH_SECRET)
        .update(payload)
        .digest('hex');
    return `${payload}:${signature}`;
}

/**
 * Validates and decodes an HMAC-signed session token.
 */
export function verifySessionToken(token: string): SessionData | null {
    if (!token || typeof token !== 'string') return null;

    const parts = token.split(':');
    if (parts.length !== 3) return null;

    const [role, timestampStr, signature] = parts;
    if (role !== 'main' && role !== 'stealth') return null;

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) return null;

    // Check expiry (7 days)
    if (Date.now() - timestamp > SESSION_MAX_AGE_SEC * 1000) {
        return null;
    }

    const payload = `${role}:${timestampStr}`;
    const expectedSignature = crypto
        .createHmac('sha256', AUTH_SECRET)
        .update(payload)
        .digest('hex');

    // Constant-time comparison to prevent timing attacks
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
        return null;
    }

    return { role: role as UserRole, timestamp };
}

/**
 * Parses raw Cookie header string into key-value pairs.
 */
export function parseCookies(cookieHeader?: string): Record<string, string> {
    const list: Record<string, string> = {};
    if (!cookieHeader) return list;

    const pairs = cookieHeader.split(';');
    for (const pair of pairs) {
        const idx = pair.indexOf('=');
        if (idx < 0) continue;
        const key = pair.substring(0, idx).trim();
        const val = pair.substring(idx + 1).trim();
        list[key] = decodeURIComponent(val);
    }
    return list;
}

/**
 * Set HTTP-only session cookie on response.
 */
export function setSessionCookie(res: Response, token: string): void {
    res.setHeader('Set-Cookie', [
        `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}`
    ]);
}

/**
 * Clear session cookie on response.
 */
export function clearSessionCookie(res: Response): void {
    res.setHeader('Set-Cookie', [
        `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
    ]);
}

/**
 * Handles POST /api/v1/auth/login
 * Validates password and dispatches user to appropriate dashboard.
 */
export function handleLogin(req: Request, res: Response): void {
    const { password } = req.body || {};

    if (!password || typeof password !== 'string') {
        res.status(400).json({ success: false, error: 'Password is required' });
        return;
    }

    const trimmedPassword = password.trim();

    if (trimmedPassword === STEALTH_PASSWORD) {
        const token = createSessionToken('stealth');
        setSessionCookie(res, token);
        res.json({
            success: true,
            role: 'stealth',
            redirect: STEALTH_ROUTE
        });
        return;
    }

    if (trimmedPassword === MAIN_PASSWORD) {
        const token = createSessionToken('main');
        setSessionCookie(res, token);
        res.json({
            success: true,
            role: 'main',
            redirect: '/'
        });
        return;
    }

    res.status(401).json({
        success: false,
        error: 'Invalid password. Please check your credentials and try again.'
    });
}

/**
 * Handles POST /api/v1/auth/logout
 */
export function handleLogout(req: Request, res: Response): void {
    clearSessionCookie(res);
    res.json({ success: true, redirect: '/login' });
}

/**
 * Handles GET /api/v1/auth/session
 */
export function handleSessionCheck(req: Request, res: Response): void {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    const session = token ? verifySessionToken(token) : null;

    if (session) {
        res.json({
            authenticated: true,
            role: session.role,
            stealthRoute: session.role === 'stealth' ? STEALTH_ROUTE : null
        });
    } else {
        res.json({
            authenticated: false,
            role: null,
            stealthRoute: null
        });
    }
}
