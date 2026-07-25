/**
 * ConfigManager.ts — Manages persistent application settings.
 *
 * Uses the existing SQLite database to store user-configurable
 * options, like the custom Server URL (e.g., Render host).
 */

import SQLite from 'react-native-sqlite-storage';

class ConfigManager {
  private db: SQLite.SQLiteDatabase | null = null;
  
  // Default fallback (Android emulator localhost)
  private memoryUrl: string = 'http://10.0.2.2:8765'; 

  async init() {
    if (this.db) return;
    
    this.db = await SQLite.openDatabase({ name: 'audio_queue.db', location: 'default' });
    await this.db.executeSql(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    
    // Load existing URL on startup
    const [results] = await this.db.executeSql('SELECT value FROM settings WHERE key = ?', ['server_url']);
    if (results.rows.length > 0) {
      this.memoryUrl = results.rows.item(0).value;
    }
  }

  async setServerUrl(url: string) {
    if (!this.db) await this.init();
    
    // Clean URL: remove trailing slashes
    const cleanUrl = url.trim().replace(/\/$/, '');
    
    await this.db!.executeSql(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
      ['server_url', cleanUrl]
    );
    this.memoryUrl = cleanUrl;
    console.log('[ConfigManager] Saved Server URL:', cleanUrl);
  }

  async getServerUrl(): Promise<string> {
    if (!this.db) await this.init();
    return this.memoryUrl;
  }
}

export default new ConfigManager();
