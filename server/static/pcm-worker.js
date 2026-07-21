/**
 * pcm-worker.js — AudioWorklet Processor for raw PCM playback.
 *
 * This runs in the Audio Worklet thread (off the main thread) for
 * glitch-free audio playback. It receives raw 16-bit PCM samples
 * via the message port and outputs them to the speakers.
 *
 * Architecture:
 *   Main Thread (app.js)                  Audio Thread (this file)
 *   ─────────────────                     ─────────────────────────
 *   WebSocket receives bytes  ──port──►   Enqueue into ring buffer
 *                                         process() reads from buffer
 *                                         Outputs Float32 samples
 *
 * Ring Buffer:
 *   We use a circular buffer to decouple the network (bursty) from
 *   the audio output (steady 16kHz). This absorbs jitter and prevents
 *   underruns. Buffer size is ~2 seconds of audio.
 */

class PCMPlayerProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        // Ring buffer: holds Float32 samples ready for output
        // Size: 2 seconds of audio at 16kHz = 32,000 samples
        // This gives us plenty of headroom for network jitter
        this.bufferSize = 32000;
        this.buffer = new Float32Array(this.bufferSize);
        this.writePos = 0;   // Next position to write into
        this.readPos = 0;    // Next position to read from
        this.count = 0;      // Number of samples currently in buffer

        // Track underrun state to avoid spamming messages
        this.isUnderrun = false;

        // Listen for incoming PCM data from the main thread
        this.port.onmessage = (event) => {
            if (event.data.type === 'pcm') {
                this._enqueueSamples(event.data.samples);
            } else if (event.data.type === 'clear') {
                // Clear the buffer (e.g., when stream stops)
                this.count = 0;
                this.writePos = 0;
                this.readPos = 0;
            }
        };
    }

    /**
     * Enqueue Float32 samples into the ring buffer.
     * Called when the main thread sends decoded PCM data.
     *
     * @param {Float32Array} samples - Audio samples in [-1.0, 1.0] range.
     */
    _enqueueSamples(samples) {
        for (let i = 0; i < samples.length; i++) {
            if (this.count >= this.bufferSize) {
                // Buffer full — drop oldest samples to stay real-time
                // This is better than accumulating latency
                this.readPos = (this.readPos + 1) % this.bufferSize;
                this.count--;
            }
            this.buffer[this.writePos] = samples[i];
            this.writePos = (this.writePos + 1) % this.bufferSize;
            this.count++;
        }

        // If we were in underrun, signal that we have data again
        if (this.isUnderrun && this.count > 0) {
            this.isUnderrun = false;
            this.port.postMessage({ type: 'status', underrun: false });
        }
    }

    /**
     * AudioWorklet process callback.
     *
     * Called by the browser's audio engine at regular intervals
     * (typically every 128 samples at the audio context's sample rate).
     *
     * We read samples from our ring buffer and write them to the output.
     * If the buffer is empty, we output silence (underrun).
     *
     * @param {Float32Array[][]} inputs - Unused (we're a source node).
     * @param {Float32Array[][]} outputs - Output channels to fill.
     * @returns {boolean} true to keep the processor alive.
     */
    process(inputs, outputs) {
        const output = outputs[0];
        if (!output || output.length === 0) return true;

        const channel = output[0]; // Mono output (channel 0)
        const frameSize = channel.length; // Typically 128 samples

        for (let i = 0; i < frameSize; i++) {
            if (this.count > 0) {
                // Read from ring buffer
                channel[i] = this.buffer[this.readPos];
                this.readPos = (this.readPos + 1) % this.bufferSize;
                this.count--;
            } else {
                // Buffer empty — output silence
                channel[i] = 0;

                if (!this.isUnderrun) {
                    this.isUnderrun = true;
                    this.port.postMessage({ type: 'status', underrun: true });
                }
            }
        }

        // Send buffer level to main thread for monitoring
        // (throttled: only send every ~20 process calls = ~160ms)
        if (Math.random() < 0.05) {
            this.port.postMessage({
                type: 'level',
                count: this.count,
                capacity: this.bufferSize,
                percent: Math.round((this.count / this.bufferSize) * 100),
            });
        }

        return true; // Keep processor alive
    }
}

// Register the processor with the AudioWorklet system
registerProcessor('pcm-player-processor', PCMPlayerProcessor);
