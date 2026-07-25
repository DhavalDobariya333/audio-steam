/**
 * ChunkQueue.ts — SQLite-backed offline queue for audio chunks.
 *
 * Ensures zero data loss. If network drops, chunks queue up here.
 * When network returns, SyncWorker pulls from this queue.
 */

import SQLite from 'react-native-sqlite-storage';

SQLite.enablePromise(true);

export interface QueueItem {
  id: number;
  session_id: string;
  sequence_num: number;
  filepath: string;
  file_size: number;
  duration_ms: number;
  created_at: string;
}

class ChunkQueue {
  private db: SQLite.SQLiteDatabase | null = null;

  async init() {
    this.db = await SQLite.openDatabase({ name: 'audio_queue.db', location: 'default' });
    await this.db.executeSql(`
      CREATE TABLE IF NOT EXISTS chunk_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        sequence_num INTEGER NOT NULL,
        filepath TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    console.log('[ChunkQueue] Initialized offline queue');
  }

  async enqueue(
    sessionId: string,
    sequenceNum: number,
    filepath: string,
    fileSize: number,
    durationMs: number
  ): Promise<void> {
    if (!this.db) await this.init();
    
    const now = new Date().toISOString();
    await this.db!.executeSql(
      `INSERT INTO chunk_queue (session_id, sequence_num, filepath, file_size, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId, sequenceNum, filepath, fileSize, durationMs, now]
    );
  }

  async getNextBatch(limit: number = 5): Promise<QueueItem[]> {
    if (!this.db) await this.init();
    
    const [results] = await this.db!.executeSql(
      'SELECT * FROM chunk_queue ORDER BY created_at ASC LIMIT ?',
      [limit]
    );

    const items: QueueItem[] = [];
    for (let i = 0; i < results.rows.length; i++) {
      items.push(results.rows.item(i));
    }
    return items;
  }

  async remove(id: number): Promise<void> {
    if (!this.db) await this.init();
    await this.db!.executeSql('DELETE FROM chunk_queue WHERE id = ?', [id]);
  }

  async clearSession(sessionId: string): Promise<void> {
    if (!this.db) await this.init();
    await this.db!.executeSql('DELETE FROM chunk_queue WHERE session_id = ?', [sessionId]);
  }

  async count(): Promise<number> {
    if (!this.db) await this.init();
    const [results] = await this.db!.executeSql('SELECT COUNT(*) as cnt FROM chunk_queue');
    return results.rows.item(0).cnt;
  }
}

export default new ChunkQueue();
