/**
 * AudioCapture.ts — Foreground audio recording manager.
 *
 * Captures microphone audio in 2-second WAV chunks and queues them.
 */

import AudioRecord from 'react-native-audio-record';
import RNFS from 'react-native-fs';
import ChunkQueue from './ChunkQueue';

const CHUNK_DURATION_MS = 2000;

export interface AudioStats {
  duration: number;
  dbLevel: number;
  chunksCaptured: number;
}

type StatsCallback = (stats: AudioStats) => void;

class AudioCapture {
  private isRecording: boolean = false;
  private sessionId: string | null = null;
  private sequenceNum: number = 0;
  private startTime: number = 0;
  private chunkTimer: NodeJS.Timeout | null = null;
  private onStatsUpdate: StatsCallback | null = null;
  private lastDbLevel: number = -160;

  async start(sessionId: string, onStatsUpdate: StatsCallback) {
    if (this.isRecording) return;
    
    this.sessionId = sessionId;
    this.onStatsUpdate = onStatsUpdate;
    this.sequenceNum = 0;
    this.startTime = Date.now();
    this.isRecording = true;

    // 16kHz Mono 16-bit PCM — matches the Android native setup exactly
    const options = {
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      audioSource: 6, // VOICE_RECOGNITION (disables AGC to prevent volume drops)
      wavFile: `temp_audio_${Date.now()}.wav`
    };

    AudioRecord.init(options);
    
    // Track amplitude
    AudioRecord.on('data', (data: string) => {
      // Decode base64 to calculate approximate decibel level for visualizer
      if (Math.random() > 0.8) { // Only sample occasionally for perf
        const pcm = Buffer.from(data, 'base64');
        let max = 0;
        for (let i = 0; i < pcm.length; i += 2) {
          const val = Math.abs(pcm.readInt16LE(i));
          if (val > max) max = val;
        }
        
        // Convert to dB (-160 to 0)
        let db = -160;
        if (max > 0) {
          db = 20 * Math.log10(max / 32767);
        }
        
        // Smooth
        this.lastDbLevel = (this.lastDbLevel * 0.7) + (db * 0.3);
      }
    });

    AudioRecord.start();
    
    // Setup recurring chunk capture
    this.chunkTimer = setInterval(() => this.captureChunk(), CHUNK_DURATION_MS);
    
    // Stats ticker
    setInterval(() => this.updateStats(), 250);
  }

  private async captureChunk() {
    if (!this.isRecording || !this.sessionId) return;
    
    // 1. Stop current file
    const filepath = await AudioRecord.stop();
    
    // 2. Immediately start next file
    const options = {
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
      audioSource: 6,
      wavFile: `chunk_${this.sequenceNum}_${Date.now()}.wav`
    };
    AudioRecord.init(options);
    AudioRecord.start();
    
    // 3. Queue the saved file
    try {
      const stat = await RNFS.stat(filepath);
      await ChunkQueue.enqueue(
        this.sessionId,
        this.sequenceNum,
        filepath,
        stat.size,
        CHUNK_DURATION_MS
      );
      this.sequenceNum++;
    } catch (e) {
      console.error('[AudioCapture] Failed to queue chunk:', e);
    }
  }

  private updateStats() {
    if (!this.isRecording || !this.onStatsUpdate) return;
    
    this.onStatsUpdate({
      duration: Math.floor((Date.now() - this.startTime) / 1000),
      dbLevel: this.lastDbLevel,
      chunksCaptured: this.sequenceNum
    });
  }

  async stop() {
    if (!this.isRecording) return;
    
    this.isRecording = false;
    if (this.chunkTimer) clearInterval(this.chunkTimer);
    
    try {
      const filepath = await AudioRecord.stop();
      if (this.sessionId && filepath) {
        const stat = await RNFS.stat(filepath);
        await ChunkQueue.enqueue(
          this.sessionId,
          this.sequenceNum,
          filepath,
          stat.size,
          CHUNK_DURATION_MS
        );
      }
    } catch (e) {
      // Ignore
    }
    
    this.sessionId = null;
    this.sequenceNum = 0;
  }
}

export default new AudioCapture();
