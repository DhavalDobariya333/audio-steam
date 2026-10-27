/**
 * database.ts — SQLite database manager using better-sqlite3 with Write-Ahead Logging (WAL).
 *
 * Replaces sql.js (in-memory WASM full-memory export dumps) with native WAL-mode
 * SQLite. Provides high-throughput, non-blocking page-level writes without
 * stalling the Node.js event loop.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DATABASE_PATH } from './config';

let db: Database.Database | null = null;

// ════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ════════════════════════════════════════════════════════════════════════════

export function initDatabase(): void {
    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });

    // Validate existing file is a valid SQLite DB (recovers from corrupted/zero-filled files)
    if (fs.existsSync(DATABASE_PATH)) {
        try {
            const fd = fs.openSync(DATABASE_PATH, 'r');
            const header = Buffer.alloc(16);
            fs.readSync(fd, header, 0, 16, 0);
            fs.closeSync(fd);
            if (!header.toString('utf8').startsWith('SQLite format 3')) {
                console.warn(`[database] Corrupted non-SQLite file detected at ${DATABASE_PATH}. Resetting database file.`);
                fs.renameSync(DATABASE_PATH, `${DATABASE_PATH}.corrupted.${Date.now()}`);
            }
        } catch (e) {
            console.warn('[database] Failed checking database file header:', e);
        }
    }

    db = new Database(DATABASE_PATH);

    // Enable WAL mode & performance tuning
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    // Create tables
    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id      TEXT    UNIQUE NOT NULL,
            title           TEXT    DEFAULT '',
            created_at      TEXT    NOT NULL,
            ended_at        TEXT    DEFAULT NULL,
            status          TEXT    NOT NULL DEFAULT 'live',
            total_chunks    INTEGER DEFAULT 0,
            total_duration  REAL    DEFAULT 0.0,
            total_bytes     INTEGER DEFAULT 0,
            client_name     TEXT    DEFAULT '',
            device_info     TEXT    DEFAULT '',
            in_call         INTEGER DEFAULT 0,
            mic_in_use      INTEGER DEFAULT 0,
            stream_type     TEXT    NOT NULL DEFAULT 'hidden'
        );

        CREATE TABLE IF NOT EXISTS device_commands (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            client_id           TEXT    UNIQUE NOT NULL,
            command             TEXT    NOT NULL DEFAULT 'NONE',
            status              TEXT    NOT NULL DEFAULT 'idle',
            start_time          TEXT    DEFAULT '',
            stop_time           TEXT    DEFAULT '',
            updated_at          TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chunks (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            chunk_id        TEXT    UNIQUE NOT NULL,
            session_id      TEXT    NOT NULL,
            sequence_num    INTEGER NOT NULL,
            filename        TEXT    NOT NULL,
            filepath        TEXT    NOT NULL,
            file_size       INTEGER DEFAULT 0,
            duration_ms     INTEGER DEFAULT 0,
            status          TEXT    NOT NULL DEFAULT 'received',
            received_at     TEXT    NOT NULL,
            checksum        TEXT    DEFAULT '',
            in_call         INTEGER DEFAULT 0,
            mic_in_use      INTEGER DEFAULT 0,
            FOREIGN KEY (session_id) REFERENCES sessions(session_id)
        );

        CREATE TABLE IF NOT EXISTS device_installs (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            client_id       TEXT    NOT NULL,
            device_model    TEXT    NOT NULL,
            manufacturer    TEXT    NOT NULL,
            os_version      TEXT    NOT NULL,
            app_version     TEXT    NOT NULL,
            ip_address      TEXT    DEFAULT '',
            installed_at    TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS device_heartbeats (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            client_id       TEXT    NOT NULL,
            status          TEXT    NOT NULL DEFAULT 'alive',
            is_recording    INTEGER NOT NULL DEFAULT 0,
            battery         INTEGER DEFAULT -1,
            storage_mb      INTEGER DEFAULT -1,
            app_version     TEXT    DEFAULT '',
            trigger_source  TEXT    DEFAULT '',
            ip_address      TEXT    DEFAULT '',
            received_at     TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS device_configs (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            client_id       TEXT    UNIQUE NOT NULL,
            config_json     TEXT    NOT NULL,
            updated_at      TEXT    NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
        CREATE INDEX IF NOT EXISTS idx_chunks_sequence ON chunks(session_id, sequence_num);
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_session_seq ON chunks(session_id, sequence_num);
        CREATE INDEX IF NOT EXISTS idx_installs_client ON device_installs(client_id);
        CREATE INDEX IF NOT EXISTS idx_installs_date ON device_installs(installed_at);
        CREATE INDEX IF NOT EXISTS idx_heartbeats_client ON device_heartbeats(client_id);
        CREATE INDEX IF NOT EXISTS idx_heartbeats_received ON device_heartbeats(received_at);
        CREATE INDEX IF NOT EXISTS idx_configs_client ON device_configs(client_id);
    `);

    // Schema migrations for existing databases
    try {
        db.exec("ALTER TABLE sessions ADD COLUMN stream_type TEXT NOT NULL DEFAULT 'hidden'");
    } catch { }
    try {
        db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_stream_type ON sessions(stream_type)");
    } catch { }
    try {
        db.exec("ALTER TABLE device_commands ADD COLUMN status TEXT NOT NULL DEFAULT 'idle'");
    } catch { }

    try {
        db.exec("ALTER TABLE device_commands ADD COLUMN start_time TEXT DEFAULT ''");
    } catch { }
    try {
        db.exec("ALTER TABLE device_commands ADD COLUMN stop_time TEXT DEFAULT ''");
    } catch { }
    try {
        db.exec("ALTER TABLE device_commands ADD COLUMN battery INTEGER DEFAULT -1");
    } catch { }
    try {
        db.exec("ALTER TABLE device_commands ADD COLUMN storage_mb INTEGER DEFAULT -1");
    } catch { }
    try {
        db.exec("ALTER TABLE device_commands ADD COLUMN is_recording INTEGER DEFAULT 0");
    } catch { }
    try {
        db.exec("ALTER TABLE device_commands ADD COLUMN last_heartbeat TEXT DEFAULT ''");
    } catch { }

    console.log(`[database] Initialized better-sqlite3 in WAL mode: ${DATABASE_PATH}`);
}

function getDb(): Database.Database {
    if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
    return db;
}

/** Helper: run a query and return all rows. */
function queryAll<T = any>(sql: string, params: any[] = []): T[] {
    return getDb().prepare(sql).all(...params) as T[];
}

/** Helper: run a query and return the first row. */
function queryOne<T = any>(sql: string, params: any[] = []): T | undefined {
    return getDb().prepare(sql).get(...params) as T | undefined;
}

/** Helper: run a write statement. */
function execute(sql: string, params: any[] = []): Database.RunResult {
    return getDb().prepare(sql).run(...params);
}

// ════════════════════════════════════════════════════════════════════════════
// SESSION OPERATIONS
// ════════════════════════════════════════════════════════════════════════════

export interface Session {
    id: number;
    session_id: string;
    title: string;
    created_at: string;
    ended_at: string | null;
    status: string;
    total_chunks: number;
    total_duration: number;
    total_bytes: number;
    client_name: string;
    device_info: string;
    in_call: number;
    mic_in_use: number;
    stream_type: string;
}

export function createSession(sessionId: string, clientName: string = '', deviceInfo: string = '', title: string = '', streamType: string = 'hidden'): Session {
    const existing = getSession(sessionId);
    if (existing) {
        if (existing.status !== 'live') {
            reactivateSession(sessionId);
        }
        return getSession(sessionId)!;
    }
    const now = new Date().toISOString();
    try {
        execute(
            `INSERT OR IGNORE INTO sessions (session_id, title, created_at, status, client_name, device_info, in_call, mic_in_use, stream_type) VALUES (?, ?, ?, 'live', ?, ?, 0, 0, ?)`,
            [sessionId, title, now, clientName, deviceInfo, streamType]
        );
    } catch { }
    return getSession(sessionId)!;
}

export function getSession(sessionId: string): Session | undefined {
    return queryOne<Session>('SELECT * FROM sessions WHERE session_id = ?', [sessionId]);
}

export function listSessions(limit: number = 100, offset: number = 0, streamType?: string): Session[] {
    let sql = 'SELECT * FROM sessions';
    const params: any[] = [];

    if (streamType) {
        sql += ' WHERE stream_type = ?';
        params.push(streamType);
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return queryAll<Session>(sql, params);
}

export function getActiveSessions(_streamType?: string): Session[] {
    return queryAll<Session>("SELECT * FROM sessions WHERE status = 'live' ORDER BY created_at DESC");
}

export function endSession(sessionId: string): boolean {
    const now = new Date().toISOString();
    const result = execute(
        "UPDATE sessions SET status = 'ended', ended_at = ? WHERE session_id = ? AND status = 'live'",
        [now, sessionId]
    );
    return result.changes > 0;
}

export function cleanupStaleSessions(timeoutSeconds: number = 60): string[] {
    const active = getActiveSessions();
    const endedIds: string[] = [];
    const nowMs = Date.now();

    for (const session of active) {
        const latestChunkSeq = getLatestChunkSequence(session.session_id);
        let lastActivityMs = new Date(session.created_at).getTime();

        if (latestChunkSeq >= 0) {
            const chunks = getSessionChunks(session.session_id);
            if (chunks.length > 0) {
                const lastChunk = chunks[chunks.length - 1];
                lastActivityMs = new Date(lastChunk.received_at).getTime();
            }
        }

        if (isNaN(lastActivityMs) || (nowMs - lastActivityMs) > timeoutSeconds * 1000) {
            endSession(session.session_id);
            endedIds.push(session.session_id);
        }
    }
    return endedIds;
}

export function deleteSession(sessionId: string): boolean {
    execute('DELETE FROM chunks WHERE session_id = ?', [sessionId]);
    execute('DELETE FROM sessions WHERE session_id = ?', [sessionId]);
    return true;
}

export function getSessionCount(streamType?: string): number {
    const sql = streamType
        ? 'SELECT COUNT(*) as cnt FROM sessions WHERE stream_type = ?'
        : 'SELECT COUNT(*) as cnt FROM sessions';
    const row = queryOne<{ cnt: number }>(sql, streamType ? [streamType] : []);
    return row?.cnt ?? 0;
}

export function reactivateSession(sessionId: string): void {
    execute("UPDATE sessions SET status = 'live', ended_at = NULL WHERE session_id = ?", [sessionId]);
}

export function updateSessionStats(sessionId: string, chunkSize: number, durationMs: number): void {
    execute(
        `UPDATE sessions SET status = 'live', ended_at = NULL, total_chunks = total_chunks + 1, total_bytes = total_bytes + ?, total_duration = total_duration + ? WHERE session_id = ?`,
        [chunkSize, durationMs / 1000.0, sessionId]
    );
}

export function updateSessionTelemetry(sessionId: string, inCall: number, micInUse: number): void {
    execute(
        `UPDATE sessions SET in_call = ?, mic_in_use = ? WHERE session_id = ?`,
        [inCall, micInUse, sessionId]
    );
}

export function updateSessionDeviceInfo(sessionId: string, deviceInfo: string): void {
    execute('UPDATE sessions SET device_info = ? WHERE session_id = ?', [deviceInfo, sessionId]);
}

// ════════════════════════════════════════════════════════════════════════════
// CHUNK OPERATIONS
// ════════════════════════════════════════════════════════════════════════════

export interface Chunk {
    id: number;
    chunk_id: string;
    session_id: string;
    sequence_num: number;
    filename: string;
    filepath: string;
    file_size: number;
    duration_ms: number;
    status: string;
    received_at: string;
    checksum: string;
    in_call: number;
    mic_in_use: number;
}

export function insertChunk(
    chunkId: string,
    sessionId: string,
    sequenceNum: number,
    filename: string,
    filepath: string,
    fileSize: number,
    durationMs: number,
    checksum: string = '',
    inCall: number = 0,
    micInUse: number = 0
): Chunk {
    // 1. Check if chunkId already exists
    const existing = getChunk(chunkId);
    if (existing) return existing;

    // 2. Check if (session_id, sequence_num) already exists
    const seqExisting = queryOne<Chunk>('SELECT * FROM chunks WHERE session_id = ? AND sequence_num = ?', [sessionId, sequenceNum]);
    if (seqExisting) return seqExisting;

    const now = new Date().toISOString();
    try {
        const result = execute(
            `INSERT OR IGNORE INTO chunks (chunk_id, session_id, sequence_num, filename, filepath, file_size, duration_ms, status, received_at, checksum, in_call, mic_in_use) VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?)`,
            [chunkId, sessionId, sequenceNum, filename, filepath, fileSize, durationMs, now, checksum, inCall, micInUse]
        );
        if (result.changes > 0) {
            updateSessionStats(sessionId, fileSize, durationMs);
            updateSessionTelemetry(sessionId, inCall, micInUse);
        }
    } catch (err: any) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || (err.message && err.message.includes('UNIQUE constraint failed'))) {
            const conflictExisting = getChunk(chunkId);
            if (conflictExisting) return conflictExisting;
            const conflictSeq = queryOne<Chunk>('SELECT * FROM chunks WHERE session_id = ? AND sequence_num = ?', [sessionId, sequenceNum]);
            if (conflictSeq) return conflictSeq;
        }
        throw err;
    }

    const found = getChunk(chunkId) || queryOne<Chunk>('SELECT * FROM chunks WHERE session_id = ? AND sequence_num = ?', [sessionId, sequenceNum]);
    if (found) return found;

    return {
        id: 0,
        chunk_id: chunkId,
        session_id: sessionId,
        sequence_num: sequenceNum,
        filename,
        filepath,
        file_size: fileSize,
        duration_ms: durationMs,
        status: 'received',
        received_at: now,
        checksum,
        in_call: inCall,
        mic_in_use: micInUse,
    };
}

export interface BatchChunkInput {
    chunkId: string;
    sequenceNum: number;
    filename: string;
    filepath: string;
    fileSize: number;
    durationMs: number;
    checksum?: string;
    inCall?: number;
    micInUse?: number;
}

export function insertChunksBatch(sessionId: string, chunks: BatchChunkInput[]): { insertedCount: number } {
    if (chunks.length === 0) return { insertedCount: 0 };
    const now = new Date().toISOString();
    let totalAddedSize = 0;
    let totalAddedDuration = 0;
    let lastInCall = 0;
    let lastMicInUse = 0;
    let count = 0;

    const insertStmt = getDb().prepare(
        `INSERT OR IGNORE INTO chunks (chunk_id, session_id, sequence_num, filename, filepath, file_size, duration_ms, status, received_at, checksum, in_call, mic_in_use) VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?)`
    );

    const runBatch = getDb().transaction((items: BatchChunkInput[]) => {
        for (const item of items) {
            const inCallVal = item.inCall || 0;
            const micInUseVal = item.micInUse || 0;
            const res = insertStmt.run(
                item.chunkId,
                sessionId,
                item.sequenceNum,
                item.filename,
                item.filepath,
                item.fileSize,
                item.durationMs,
                now,
                item.checksum || '',
                inCallVal,
                micInUseVal
            );
            if (res.changes > 0) {
                count++;
                totalAddedSize += item.fileSize;
                totalAddedDuration += item.durationMs;
                lastInCall = inCallVal;
                lastMicInUse = micInUseVal;
            }
        }
    });

    runBatch(chunks);

    if (count > 0) {
        updateSessionStats(sessionId, totalAddedSize, totalAddedDuration);
        updateSessionTelemetry(sessionId, lastInCall, lastMicInUse);
    }

    return { insertedCount: count };
}

export function getChunk(chunkId: string): Chunk | undefined {
    return queryOne<Chunk>('SELECT * FROM chunks WHERE chunk_id = ?', [chunkId]);
}

export function chunkExists(sessionId: string, sequenceNum: number): boolean {
    const row = queryOne<{ found: number }>('SELECT 1 as found FROM chunks WHERE session_id = ? AND sequence_num = ?', [sessionId, sequenceNum]);
    return !!row;
}

export function getSessionChunks(sessionId: string): Chunk[] {
    return queryAll<Chunk>('SELECT * FROM chunks WHERE session_id = ? ORDER BY sequence_num ASC', [sessionId]);
}

export function getLatestChunkSequence(sessionId: string): number {
    const row = queryOne<{ max_seq: number | null }>('SELECT MAX(sequence_num) as max_seq FROM chunks WHERE session_id = ?', [sessionId]);
    return row?.max_seq ?? -1;
}

export function updateChunkStatus(chunkId: string, status: string): void {
    execute('UPDATE chunks SET status = ? WHERE chunk_id = ?', [status, chunkId]);
}

// ════════════════════════════════════════════════════════════════════════════
// STATISTICS
// ════════════════════════════════════════════════════════════════════════════

export interface Stats {
    total_sessions: number;
    active_sessions: number;
    total_chunks: number;
    total_bytes: number;
    total_duration: number;
    total_duration_human: string;
    total_size_human: string;
}

export function getStats(streamType?: string): Stats {
    let sql = `
        SELECT 
            COUNT(*) as total_sessions,
            COALESCE(SUM(CASE WHEN status = 'live' THEN 1 ELSE 0 END), 0) as active_sessions,
            COALESCE(SUM(total_chunks), 0) as total_chunks,
            COALESCE(SUM(total_bytes), 0) as total_bytes,
            COALESCE(SUM(total_duration), 0) as total_duration
        FROM sessions
    `;
    let params: any[] = [];

    if (streamType) {
        sql += ' WHERE stream_type = ?';
        params = [streamType];
    }

    const row = queryOne<{
        total_sessions: number;
        active_sessions: number;
        total_chunks: number;
        total_bytes: number;
        total_duration: number;
    }>(sql, params);

    const totalSessions = row?.total_sessions ?? 0;
    const activeSessions = row?.active_sessions ?? 0;
    const totalChunks = row?.total_chunks ?? 0;
    const totalBytes = row?.total_bytes ?? 0;
    const totalDuration = row?.total_duration ?? 0;

    return {
        total_sessions: totalSessions,
        active_sessions: activeSessions,
        total_chunks: totalChunks,
        total_bytes: totalBytes,
        total_duration: totalDuration,
        total_duration_human: formatDuration(totalDuration),
        total_size_human: formatSize(totalBytes),
    };
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

function formatDuration(seconds: number): string {
    seconds = Math.max(0, Math.floor(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function closeDatabase(): void {
    if (db) {
        db.close();
        db = null;
        console.log('[database] better-sqlite3 closed cleanly');
    }
}

// ════════════════════════════════════════════════════════════════════════════
// DEVICE COMMAND OPERATIONS
// ════════════════════════════════════════════════════════════════════════════

export interface DeviceCommand {
    client_id: string;
    command: string;
    status: string;
    start_time: string;
    stop_time: string;
    updated_at: string;
}

export function setDeviceCommand(clientId: string, command: string): void {
    const now = new Date().toISOString();
    execute(
        `INSERT INTO device_commands (client_id, command, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET command = excluded.command, updated_at = excluded.updated_at`,
        [clientId, command, now]
    );
}

export function getDeviceCommand(clientId: string): DeviceCommand | undefined {
    return queryOne<DeviceCommand>('SELECT * FROM device_commands WHERE client_id = ?', [clientId]);
}

export function getAllDeviceCommands(): DeviceCommand[] {
    return queryAll<DeviceCommand>('SELECT * FROM device_commands ORDER BY updated_at DESC');
}

export function clearDeviceCommand(clientId: string): void {
    execute('UPDATE device_commands SET command = ? WHERE client_id = ?', ['NONE', clientId]);
}

export function updateDeviceStatus(clientId: string, status: string): void {
    const now = new Date().toISOString();
    execute(
        `INSERT INTO device_commands (client_id, status, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
        [clientId, status, now]
    );
}

export function updateDeviceSchedule(clientId: string, startTime: string, stopTime: string): void {
    const now = new Date().toISOString();
    execute(
        `INSERT INTO device_commands (client_id, start_time, stop_time, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET start_time = excluded.start_time, stop_time = excluded.stop_time, updated_at = excluded.updated_at`,
        [clientId, startTime, stopTime, now]
    );
}

// ════════════════════════════════════════════════════════════════════════════
// DEVICE INSTALLATION OPERATIONS
// ════════════════════════════════════════════════════════════════════════════

export interface DeviceInstall {
    id: number;
    client_id: string;
    device_model: string;
    manufacturer: string;
    os_version: string;
    app_version: string;
    ip_address: string;
    installed_at: string;
}

export function recordDeviceInstall(
    clientId: string,
    deviceModel: string,
    manufacturer: string,
    osVersion: string,
    appVersion: string,
    ipAddress: string = ''
): DeviceInstall {
    const now = new Date().toISOString();
    const result = execute(
        `INSERT INTO device_installs (client_id, device_model, manufacturer, os_version, app_version, ip_address, installed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [clientId, deviceModel, manufacturer, osVersion, appVersion, ipAddress, now]
    );
    const id = result.lastInsertRowid as number;
    return queryOne<DeviceInstall>('SELECT * FROM device_installs WHERE id = ?', [id])!;
}

export function getDeviceInstalls(limit: number = 50): DeviceInstall[] {
    return queryAll<DeviceInstall>('SELECT * FROM device_installs ORDER BY installed_at DESC LIMIT ?', [limit]);
}

export function getDeviceInstallCount(): number {
    const row = queryOne<{ cnt: number }>('SELECT COUNT(*) as cnt FROM device_installs');
    return row?.cnt ?? 0;
}

// ════════════════════════════════════════════════════════════════════════════
// DEVICE HEARTBEAT OPERATIONS
// ════════════════════════════════════════════════════════════════════════════

export interface DeviceHeartbeat {
    id: number;
    client_id: string;
    status: string;
    is_recording: number;
    battery: number;
    storage_mb: number;
    app_version: string;
    trigger_source: string;
    ip_address: string;
    received_at: string;
}

export function recordDeviceHeartbeat(
    clientId: string,
    status: string,
    isRecording: boolean,
    battery: number,
    storageMb: number,
    appVersion: string = '',
    triggerSource: string = '',
    ipAddress: string = ''
): void {
    const now = new Date().toISOString();
    // 1. Insert into device_heartbeats history
    execute(
        `INSERT INTO device_heartbeats (client_id, status, is_recording, battery, storage_mb, app_version, trigger_source, ip_address, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [clientId, status, isRecording ? 1 : 0, battery, storageMb, appVersion, triggerSource, ipAddress, now]
    );

    // 2. Update device_commands state
    execute(
        `INSERT INTO device_commands (client_id, status, is_recording, battery, storage_mb, last_heartbeat, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET 
            status = excluded.status,
            is_recording = excluded.is_recording,
            battery = excluded.battery,
            storage_mb = excluded.storage_mb,
            last_heartbeat = excluded.last_heartbeat,
            updated_at = excluded.updated_at`,
        [clientId, status, isRecording ? 1 : 0, battery, storageMb, now, now]
    );
}

export function getRecentHeartbeats(limit: number = 50): DeviceHeartbeat[] {
    return queryAll<DeviceHeartbeat>('SELECT * FROM device_heartbeats ORDER BY received_at DESC LIMIT ?', [limit]);
}

// ════════════════════════════════════════════════════════════════════════════
// REMOTE CONFIGURATION
// ════════════════════════════════════════════════════════════════════════════

export function saveDeviceConfig(clientId: string, config: any): void {
    const configStr = typeof config === 'string' ? config : JSON.stringify(config);
    const now = new Date().toISOString();
    execute(
        `INSERT INTO device_configs (client_id, config_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET
            config_json = excluded.config_json,
            updated_at = excluded.updated_at`,
        [clientId, configStr, now]
    );
}

export function getDeviceConfig(clientId: string): any | null {
    const row = queryOne<{ config_json: string }>('SELECT config_json FROM device_configs WHERE client_id = ?', [clientId]);
    if (!row) return null;
    try {
        return JSON.parse(row.config_json);
    } catch {
        return null;
    }
}
