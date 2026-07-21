/**
 * waveform.js — Canvas-based live oscilloscope waveform visualization.
 *
 * Draws a real-time oscilloscope-style waveform of the incoming PCM audio.
 * This is NOT a frequency spectrum (FFT) — it shows the actual audio
 * waveform shape over time, like a classic oscilloscope.
 *
 * Features:
 *   - Smooth line rendering with anti-aliasing
 *   - Glow effect on the waveform line
 *   - Grid lines for visual reference
 *   - Auto-scales to canvas size (responsive)
 *   - Center line indicator
 *   - Fade-to-silence animation when stream stops
 *
 * Usage:
 *   const waveform = new WaveformRenderer('waveform-canvas');
 *   waveform.start();
 *   waveform.pushSamples(float32Array);  // Call with each PCM chunk
 *   waveform.stop();
 */

class WaveformRenderer {
    /**
     * @param {string} canvasId - ID of the <canvas> element.
     * @param {Object} options - Customization options.
     */
    constructor(canvasId, options = {}) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');

        // Configuration with defaults
        this.lineColor = options.lineColor || '#34d399';     // Green
        this.glowColor = options.glowColor || 'rgba(52, 211, 153, 0.4)';
        this.gridColor = options.gridColor || 'rgba(255, 255, 255, 0.03)';
        this.centerColor = options.centerColor || 'rgba(255, 255, 255, 0.06)';
        this.bgColor = options.bgColor || '#0a0a12';
        this.lineWidth = options.lineWidth || 2;

        // Sample buffer — holds the latest chunk of samples for drawing
        // We keep ~2048 samples which gives a nice waveform view
        this.displaySamples = 2048;
        this.samples = new Float32Array(this.displaySamples);

        // Animation state
        this.animationId = null;
        this.isRunning = false;
        this.hasData = false;
        this.fadeLevel = 0; // 0 = no signal, 1 = full signal

        // Volume/peak tracking
        this.currentPeak = 0;
        this.smoothPeak = 0;

        // Handle canvas resizing
        this._setupResize();
        this._resizeCanvas();
    }

    /**
     * Set up a ResizeObserver to handle canvas size changes.
     * This ensures the waveform looks crisp on resize and DPI changes.
     */
    _setupResize() {
        // Use ResizeObserver for efficient resize detection
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => {
                this._resizeCanvas();
            });
            this._resizeObserver.observe(this.canvas.parentElement);
        } else {
            // Fallback: listen to window resize
            window.addEventListener('resize', () => this._resizeCanvas());
        }
    }

    /**
     * Resize the canvas to match its CSS dimensions at device pixel ratio.
     * This prevents blurry rendering on high-DPI screens.
     */
    _resizeCanvas() {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;

        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        this.ctx.scale(dpr, dpr);

        // Store CSS dimensions for drawing calculations
        this.width = rect.width;
        this.height = rect.height;
    }

    /**
     * Push new audio samples for visualization.
     * Called by app.js each time a PCM chunk arrives.
     *
     * @param {Float32Array} newSamples - Audio samples in [-1.0, 1.0] range.
     */
    pushSamples(newSamples) {
        if (!newSamples || newSamples.length === 0) return;

        this.hasData = true;

        // Shift existing samples left and append new ones at the end
        // This creates a scrolling oscilloscope effect
        const shiftAmount = Math.min(newSamples.length, this.displaySamples);
        this.samples.copyWithin(0, shiftAmount);
        
        // Copy new samples to the end of the buffer
        const startPos = this.displaySamples - shiftAmount;
        for (let i = 0; i < shiftAmount; i++) {
            this.samples[startPos + i] = newSamples[
                newSamples.length - shiftAmount + i
            ];
        }

        // Calculate peak amplitude for volume indicator
        let peak = 0;
        for (let i = 0; i < newSamples.length; i++) {
            const abs = Math.abs(newSamples[i]);
            if (abs > peak) peak = abs;
        }
        this.currentPeak = peak;
    }

    /**
     * Start the animation loop.
     */
    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this._animate();
    }

    /**
     * Stop the animation loop.
     */
    stop() {
        this.isRunning = false;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    /**
     * Clear the sample buffer (e.g., when stream disconnects).
     */
    clear() {
        this.samples.fill(0);
        this.hasData = false;
        this.currentPeak = 0;
        this.smoothPeak = 0;
    }

    /**
     * Get the current smoothed peak level (0.0 to 1.0).
     * Used by the volume bar in the UI.
     */
    getPeakLevel() {
        return this.smoothPeak;
    }

    /**
     * Main animation loop. Runs at ~60fps via requestAnimationFrame.
     */
    _animate() {
        if (!this.isRunning) return;

        this._draw();
        this.animationId = requestAnimationFrame(() => this._animate());
    }

    /**
     * Draw one frame of the waveform.
     */
    _draw() {
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;
        const centerY = h / 2;

        // Smooth the fade level for clean transitions
        const targetFade = this.hasData ? 1 : 0;
        this.fadeLevel += (targetFade - this.fadeLevel) * 0.08;

        // Smooth the peak meter
        const peakTarget = this.currentPeak;
        this.smoothPeak += (peakTarget - this.smoothPeak) * 0.15;
        // Decay the current peak slowly so it doesn't stick
        this.currentPeak *= 0.95;

        // ── Clear background ──
        ctx.fillStyle = this.bgColor;
        ctx.fillRect(0, 0, w, h);

        // ── Draw grid lines ──
        ctx.strokeStyle = this.gridColor;
        ctx.lineWidth = 1;
        const gridLines = 8;
        for (let i = 1; i < gridLines; i++) {
            const y = (h / gridLines) * i;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
        // Vertical grid
        const vGridLines = 16;
        for (let i = 1; i < vGridLines; i++) {
            const x = (w / vGridLines) * i;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }

        // ── Draw center line ──
        ctx.strokeStyle = this.centerColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, centerY);
        ctx.lineTo(w, centerY);
        ctx.stroke();

        // ── Draw waveform ──
        if (this.fadeLevel > 0.01) {
            const alpha = this.fadeLevel;

            // Glow effect (drawn first, underneath the main line)
            ctx.save();
            ctx.globalAlpha = alpha * 0.5;
            ctx.strokeStyle = this.glowColor;
            ctx.lineWidth = this.lineWidth + 4;
            ctx.shadowColor = this.glowColor;
            ctx.shadowBlur = 12;
            this._drawWaveformPath(ctx, w, h, centerY);
            ctx.restore();

            // Main crisp line
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.strokeStyle = this.lineColor;
            ctx.lineWidth = this.lineWidth;
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            this._drawWaveformPath(ctx, w, h, centerY);
            ctx.restore();
        } else {
            // No data — draw a flat center line with slight glow
            ctx.save();
            ctx.globalAlpha = 0.3;
            ctx.strokeStyle = this.lineColor;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, centerY);
            ctx.lineTo(w, centerY);
            ctx.stroke();
            ctx.restore();
        }
    }

    /**
     * Draw the actual waveform path from the sample buffer.
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} w - Canvas width
     * @param {number} h - Canvas height
     * @param {number} centerY - Vertical center
     */
    _drawWaveformPath(ctx, w, h, centerY) {
        const samples = this.samples;
        const len = samples.length;
        const step = w / len;
        const amplitude = h * 0.45; // Use 90% of height (45% each way)

        ctx.beginPath();
        ctx.moveTo(0, centerY + samples[0] * amplitude);

        for (let i = 1; i < len; i++) {
            const x = i * step;
            const y = centerY + samples[i] * amplitude;
            ctx.lineTo(x, y);
        }

        ctx.stroke();
    }
}

// Export for use in app.js
// (Works as both a module and a plain script)
if (typeof window !== 'undefined') {
    window.WaveformRenderer = WaveformRenderer;
}
