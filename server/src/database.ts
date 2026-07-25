/**
 * database.ts — SQLite database manager using sql.js (pure WASM).
 *
 * sql.js is a pure JavaScript/WASM SQLite implementation that requires
 * NO native compilation — works on any platform without VC++ toolset.
 *
 * The database is persisted to disk by manually reading/writing the
 * binary database file. We auto-save after every write operation.
 */

// @ts-ignore
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { DATABASE_PATH } from './config';

let db: SqlJsDatabase;

// ════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ════════════════════════════════════════════════════════════════════════════

export async function initDatabase(): Promise<void> {
    const SQL = await initSqlJs();

    // Load existing database from disk if it exists
    if (fs.existsSync(DATABASE_PATH)) {
        const fileBuffer = fs.readFileSync(DATABASE_PATH);
        db = new SQL.Database(fileBuffer);
    } else {
        // Ensure parent directory exists
        fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
        db = new SQL.Database();
    }

    // Create tables
    db.run(`
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
            device_info     TEXT    DEFAULT ''
        );
    `);

    db.run(`
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
            FOREIGN KEY (session_id) REFERENCES sessions(session_id)
        );
    `);

    // Create indexes (using IF NOT EXISTS)
    db.run('CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_chunks_sequence ON chunks(session_id, sequence_num)');
    db.run('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)');

    // Unique constraint for duplicate detection
    try {
        db.run('CREATE UNIQUE INDEX idx_chunks_session_seq ON chunks(session_id, sequence_num)');
    } catch {
        // Index already exists
    }

    saveToDisk();
    console.log(`[database] Initialized: ${DATABASE_PATH}`);
}

/** Persist the in-memory database to disk. */
function saveToDisk(): void {
    if (!db) return;
    try {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(DATABASE_PATH, buffer);
    } catch (err) {
        console.error('[database] Failed to save to disk:', err);
    }
}

// Auto-save interval (every 5 seconds as a safety net)
let saveInterval: NodeJS.Timeout;
function startAutoSave(): void {
    saveInterval = setInterval(saveToDisk, 5000);
}

function getDb(): SqlJsDatabase {
    if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
    return db;
}

/** Helper: run a query and return all rows as plain objects. */
function queryAll(sql: string, params: any[] = []): any[] {
    const stmt = getDb().prepare(sql);
    if (params.length > 0) stmt.bind(params);

    const results: any[] = [];
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

/** Helper: run a query and return the first row. */
function queryOne(sql: string, params: any[] = []): any | undefined {
    const rows = queryAll(sql, params);
    return rows.length > 0 ? rows[0] : undefined;
}

/** Helper: run a write statement. */
function execute(sql: string, params: any[] = []): void {
    getDb().run(sql, params);
    saveToDisk();
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
}

export function createSession(sessionId: string, clientName: string = '', deviceInfo: string = '', title: string = ''): Session {
    const now = new Date().toISOString();
    execute(
        `INSERT INTO sessions (session_id, title, created_at, status, client_name, device_info) VALUES (?, ?, ?, 'live', ?, ?)`,
        [sessionId, title, now, clientName, deviceInfo]
    );
    return getSession(sessionId)!;
}

export function getSession(sessionId: string): Session | undefined {
    return queryOne('SELECT * FROM sessions WHERE session_id = ?', [sessionId]) as Session | undefined;
}

export function listSessions(limit: number = 100, offset: number = 0): Session[] {
    return queryAll('SELECT * FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?', [limit, offset]) as Session[];
}

export function getActiveSessions(): Session[] {
    return queryAll("SELECT * FROM sessions WHERE status = 'live' ORDER BY created_at DESC") as Session[];
}

export function endSession(sessionId: string): boolean {
    const now = new Date().toISOString();
    execute("UPDATE sessions SET status = 'ended', ended_at = ? WHERE session_id = ? AND status = 'live'", [now, sessionId]);
    return getDb().getRowsModified() > 0;
}

export function deleteSession(sessionId: string): boolean {
    execute('DELETE FROM chunks WHERE session_id = ?', [sessionId]);
    execute('DELETE FROM sessions WHERE session_id = ?', [sessionId]);
    return true;
}

export function getSessionCount(): number {
    const row = queryOne('SELECT COUNT(*) as cnt FROM sessions');
    return row?.cnt ?? 0;
}

export function updateSessionStats(sessionId: string, chunkSize: number, durationMs: number): void {
    execute(
        `UPDATE sessions SET total_chunks = total_chunks + 1, total_bytes = total_bytes + ?, total_duration = total_duration + ? WHERE session_id = ?`,
        [chunkSize, durationMs / 1000.0, sessionId]
    );
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
}

export function insertChunk(
    chunkId: string,
    sessionId: string,
    sequenceNum: number,
    filename: string,
    filepath: string,
    fileSize: number,
    durationMs: number,
    checksum: string = ''
): Chunk {
    const now = new Date().toISOString();
    execute(
        `INSERT INTO chunks (chunk_id, session_id, sequence_num, filename, filepath, file_size, duration_ms, status, received_at, checksum) VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`,
        [chunkId, sessionId, sequenceNum, filename, filepath, fileSize, durationMs, now, checksum]
    );
    updateSessionStats(sessionId, fileSize, durationMs);
    return getChunk(chunkId)!;
}

export function getChunk(chunkId: string): Chunk | undefined {
    return queryOne('SELECT * FROM chunks WHERE chunk_id = ?', [chunkId]) as Chunk | undefined;
}

export function chunkExists(sessionId: string, sequenceNum: number): boolean {
    const row = queryOne('SELECT 1 as found FROM chunks WHERE session_id = ? AND sequence_num = ?', [sessionId, sequenceNum]);
    return !!row;
}

export function getSessionChunks(sessionId: string): Chunk[] {
    return queryAll('SELECT * FROM chunks WHERE session_id = ? ORDER BY sequence_num ASC', [sessionId]) as Chunk[];
}

export function getLatestChunkSequence(sessionId: string): number {
    const row = queryOne('SELECT MAX(sequence_num) as max_seq FROM chunks WHERE session_id = ?', [sessionId]);
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

export function getStats(): Stats {
    const sessions = queryOne('SELECT COUNT(*) as cnt FROM sessions');
    const active = queryOne("SELECT COUNT(*) as cnt FROM sessions WHERE status = 'live'");
    const chunks = queryOne('SELECT COUNT(*) as cnt, COALESCE(SUM(file_size), 0) as bytes FROM chunks');
    const duration = queryOne('SELECT COALESCE(SUM(total_duration), 0) as dur FROM sessions');

    return {
        total_sessions: sessions?.cnt ?? 0,
        active_sessions: active?.cnt ?? 0,
        total_chunks: chunks?.cnt ?? 0,
        total_bytes: chunks?.bytes ?? 0,
        total_duration: duration?.dur ?? 0,
        total_duration_human: formatDuration(duration?.dur ?? 0),
        total_size_human: formatSize(chunks?.bytes ?? 0),
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
        saveToDisk();
        db.close();
        clearInterval(saveInterval);
        console.log('[database] Closed');
    }
}

// Start auto-save when module loads
startAutoSave();
