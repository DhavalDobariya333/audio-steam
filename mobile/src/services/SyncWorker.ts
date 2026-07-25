/**
 * SyncWorker.ts — Background uploader.
 *
 * Monitors the ChunkQueue and uploads pending chunks sequentially.
 * If an upload fails, it backs off and retries.
 */

import RNFS from 'react-native-fs';
import ChunkQueue, { QueueItem } from './ChunkQueue';
import NetworkMonitor from './NetworkMonitor';
import ConfigManager from './ConfigManager';

class SyncWorker {
  private isUploading: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;
  private sessionId: string | null = null;

  start(sessionId: string) {
    this.sessionId = sessionId;
    
    if (!this.intervalId) {
      // Poll every 3 seconds for new chunks
      this.intervalId = setInterval(() => this.processQueue(), 3000);
      console.log('[SyncWorker] Started for session', sessionId);
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[SyncWorker] Stopped');
    }
  }

  private async processQueue() {
    if (this.isUploading) return;
    if (!NetworkMonitor.getIsOnline()) return;
    
    this.isUploading = true;

    try {
      const batch = await ChunkQueue.getNextBatch(3);
      if (batch.length === 0) {
        this.isUploading = false;
        return;
      }

      console.log(`[SyncWorker] Processing ${batch.length} chunks...`);

      for (const item of batch) {
        // Double check network
        if (!NetworkMonitor.getIsOnline()) break;
        
        const success = await this.uploadChunk(item);
        if (success) {
          await ChunkQueue.remove(item.id);
          // Delete file to save space
          try {
            await RNFS.unlink(item.filepath);
          } catch (e) {
            console.warn(`[SyncWorker] Failed to delete local file ${item.filepath}`);
          }
        } else {
          // Upload failed, stop processing this batch
          console.warn('[SyncWorker] Upload failed, will retry later.');
          break;
        }
      }
    } catch (e) {
      console.error('[SyncWorker] Queue processing error:', e);
    } finally {
      this.isUploading = false;
    }
  }

  private async uploadChunk(item: QueueItem): Promise<boolean> {
    try {
      const exists = await RNFS.exists(item.filepath);
      if (!exists) {
        console.warn(`[SyncWorker] File missing, skipping: ${item.filepath}`);
        return true; // Return true to remove from queue since we can't upload it
      }

      const formData = new FormData();
      formData.append('sequence_num', item.sequence_num.toString());
      formData.append('duration_ms', item.duration_ms.toString());
      
      // React Native FormData file format
      formData.append('audio', {
        uri: `file://${item.filepath}`,
        type: 'audio/wav',
        name: `chunk_${item.sequence_num}.wav`,
      } as any);

      const baseUrl = await ConfigManager.getServerUrl();
      const response = await fetch(`${baseUrl}/api/v1/broadcasts/${item.session_id}/chunk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        body: formData,
      });

      if (response.ok) {
        return true;
      } else {
        const body = await response.json();
        if (body.status === 'already_exists') {
          // Server already has this chunk, consider it successful
          return true;
        }
        console.error('[SyncWorker] Server error:', body);
        return false;
      }
    } catch (e) {
      console.error('[SyncWorker] Network error during upload:', e);
      return false;
    }
  }

  // Called when broadcast begins
  async createSession(clientName: string): Promise<string | null> {
    try {
      const baseUrl = await ConfigManager.getServerUrl();
      const response = await fetch(`${baseUrl}/api/v1/broadcasts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: clientName,
          device_info: 'React Native Broadcaster'
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        return data.session_id;
      }
      return null;
    } catch (e) {
      console.error('[SyncWorker] Create session error:', e);
      return null;
    }
  }

  async endSession(sessionId: string): Promise<void> {
    try {
      const baseUrl = await ConfigManager.getServerUrl();
      await fetch(`${baseUrl}/api/v1/broadcasts/${sessionId}/end`, { method: 'PUT' });
    } catch (e) {
      // Ignore
    }
  }
}

export default new SyncWorker();
