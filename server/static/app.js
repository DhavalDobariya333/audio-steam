/**
 * app.js — Main Web Dashboard Application Logic.
 *
 * Handles:
 *   - WebSocket connection to the server (/ws/listen)
 *   - Web Audio API setup for raw PCM playback via AudioWorklet
 *   - UI state updates (status indicators, volume bar, timers)
 *   - Fetching and managing saved recordings via REST API
 *   - Toast notifications
 *
 * Uses Vanilla JavaScript (no frameworks) for maximum performance
 * and minimal overhead on low-end devices.
 */

// ── Configuration ──
// Use current host and protocol for WebSocket URL
const PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const PORT_PART = window.location.port ? `:${window.location.port}` : '';
const WS_URL = `${PROTOCOL}//${window.location.hostname}${PORT_PART}/ws/listen`;
const API_BASE = `/api`;

// ── Application State ──
const state = {
    connected: false,
    streamActive: false,
    recording: false,
    recordingDuration: 0,
    streamers: 0,
    listeners: 0
};

// ── UI Elements ──
const ui = {
    // Status badges
    connStatus: document.getElementById('conn-status'),
    connDot: document.getElementById('conn-dot'),
    streamerCount: document.getElementById('streamer-count'),
    listenerCount: document.getElementById('listener-count'),
    
    // Controls
    btnConnect: document.getElementById('btn-connect'),
    btnRecord: document.getElementById('btn-record'),
    
    // Timers & Volume
    recordTimer: document.getElementById('record-timer'),
    recordTime: document.getElementById('record-time'),
    volumeFill: document.getElementById('volume-fill'),
    waveformOverlay: document.getElementById('waveform-overlay'),
    
    // Recordings
    recordingsList: document.getElementById('recordings-list'),
    
    // Notifications
    toastContainer: document.getElementById('toast-container')
};

// ── Core Components ──
let ws = null;
let audioCtx = null;
let workletNode = null;
let waveform = null;
let recordTimerInterval = null;

// ════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    // Initialize the canvas waveform renderer
    waveform = new window.WaveformRenderer('waveform-canvas');
    waveform.start();
    
    // Start volume bar animation loop
    requestAnimationFrame(updateVolumeBar);
    
    // Bind button events
    ui.btnConnect.addEventListener('click', toggleConnection);
    ui.btnRecord.addEventListener('click', toggleRecording);
    
    // Fetch initial recordings list
    fetchRecordings();
    
    // Auto-connect on load (optional, you can require manual click)
    // For a surveillance app, auto-connect is usually preferred
    connectWebSocket();
});

// ════════════════════════════════════════════════════════════════════════════
// WEBSOCKET & AUDIO PIPELINE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Connect to the server WebSocket and set up the audio pipeline.
 */
async function connectWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    
    // 1. Initialize Web Audio API (must be done after a user gesture in some browsers)
    try {
        await initAudio();
    } catch (e) {
        showToast('Microphone/Audio permission required for playback', 'error');
        console.error('Audio init failed:', e);
        return;
    }
    
    updateConnectionStatus('connecting');
    
    // 2. Connect WebSocket
    ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
        state.connected = true;
        updateConnectionStatus('connected');
        showToast('Connected to server', 'success');
        
        // Change connect button to disconnect
        ui.btnConnect.innerHTML = 'Disconnect';
        ui.btnConnect.classList.replace('btn--primary', 'btn--danger');
    };
    
    ws.onclose = () => {
        state.connected = false;
        state.streamActive = false;
        updateConnectionStatus('disconnected');
        updateStreamStatus();
        
        ui.btnConnect.innerHTML = 'Connect';
        ui.btnConnect.classList.replace('btn--danger', 'btn--primary');
        
        // Stop audio playback if active
        if (audioCtx && audioCtx.state === 'running') {
            audioCtx.suspend();
        }
        
        // Clear waveform
        waveform.clear();
        ui.waveformOverlay.classList.remove('waveform-overlay--hidden');
    };
    
    ws.onerror = (err) => {
        console.error('WebSocket Error:', err);
        showToast('Connection error', 'error');
    };
    
    ws.onmessage = async (event) => {
        // ── Handle JSON Status Messages ──
        if (typeof event.data === 'string') {
            try {
                const msg = JSON.parse(event.data);
                handleServerMessage(msg);
            } catch (e) {
                console.error('Error parsing WS message:', e);
            }
            return;
        }
        
        // ── Handle Binary Audio Messages (Raw PCM) ──
        if (event.data instanceof Blob) {
            // Read the binary PCM data
            const arrayBuffer = await event.data.arrayBuffer();
            // Convert to 16-bit integers
            const int16Array = new Int16Array(arrayBuffer);
            
            // Convert to Float32 [-1.0, 1.0] for the Web Audio API
            const float32Array = new Float32Array(int16Array.length);
            for (let i = 0; i < int16Array.length; i++) {
                // Normalize 16-bit signed integer to float
                float32Array[i] = int16Array[i] / 32768.0; 
            }
            
            // 1. Send to AudioWorklet for playback
            if (workletNode && audioCtx.state === 'running') {
                workletNode.port.postMessage({
                    type: 'pcm',
                    samples: float32Array
                });
            }
            
            // 2. Send to Waveform canvas for visualization
            waveform.pushSamples(float32Array);
        }
    };
}

/**
 * Disconnect from the server and stop audio.
 */
function disconnectWebSocket() {
    if (ws) {
        ws.close();
        ws = null;
    }
}

function toggleConnection() {
    if (state.connected) {
        disconnectWebSocket();
    } else {
        connectWebSocket();
    }
}

// ════════════════════════════════════════════════════════════════════════════
// WEB AUDIO API
// ════════════════════════════════════════════════════════════════════════════

/**
 * Initialize the Web Audio API context and load our custom PCM processor.
 */
async function initAudio() {
    if (audioCtx) {
        // If already initialized, just resume (browsers pause it if no user interaction)
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }
        return;
    }
    
    // Create audio context at 16kHz (must match our incoming stream)
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContext({ sampleRate: 16000 });
    
    try {
        // Load the AudioWorklet processor module
        await audioCtx.audioWorklet.addModule('/pcm-worker.js');
        
        // Create the node
        workletNode = new AudioWorkletNode(audioCtx, 'pcm-player-processor');
        
        // Connect the node to the speakers
        workletNode.connect(audioCtx.destination);
        
        // Listen for messages from the processor (e.g., underrun warnings)
        workletNode.port.onmessage = (event) => {
            if (event.data.type === 'status' && event.data.underrun) {
                // The ring buffer is empty (network lag)
                // console.warn('Audio underrun (buffer empty)');
            }
        };
        
        console.log('Audio pipeline initialized at 16kHz');
    } catch (e) {
        console.error('Failed to load AudioWorklet:', e);
        throw e;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// MESSAGE HANDLING
// ════════════════════════════════════════════════════════════════════════════

/**
 * Handle JSON status updates from the server.
 */
function handleServerMessage(msg) {
    switch (msg.type) {
        case 'init':
            // Initial state dump on connection
            state.streamActive = msg.stream_active;
            state.streamers = msg.streamers;
            state.listeners = msg.listeners;
            state.recording = msg.recording;
            state.recordingDuration = msg.recording_duration;
            
            updateStreamStatus();
            updateRecordingUI();
            break;
            
        case 'stream_status':
            // Streamer connected or disconnected
            state.streamActive = msg.active;
            state.streamers = msg.streamers;
            if (msg.listeners !== undefined) state.listeners = msg.listeners;
            
            updateStreamStatus();
            if (msg.active) {
                showToast('Incoming audio stream started', 'info');
            } else {
                showToast('Audio stream ended', 'info');
            }
            break;
            
        case 'recording_status':
            // Server started/stopped recording
            state.recording = msg.recording;
            state.recordingDuration = msg.duration || 0;
            updateRecordingUI();
            
            // If recording stopped, fetch the updated list
            if (!msg.recording) {
                fetchRecordings();
            }
            break;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// UI UPDATES
// ════════════════════════════════════════════════════════════════════════════

function updateConnectionStatus(status) {
    if (status === 'connected') {
        ui.connStatus.textContent = 'Connected';
        ui.connStatus.className = 'connection-badge connection-badge--connected';
        ui.connDot.className = 'status-dot status-dot--active';
    } else if (status === 'connecting') {
        ui.connStatus.textContent = 'Connecting...';
        ui.connStatus.className = 'connection-badge';
        ui.connDot.className = 'status-dot';
    } else {
        ui.connStatus.textContent = 'Disconnected';
        ui.connStatus.className = 'connection-badge connection-badge--disconnected';
        ui.connDot.className = 'status-dot';
        ui.streamerCount.textContent = '0';
        ui.listenerCount.textContent = '0';
    }
}

function updateStreamStatus() {
    ui.streamerCount.textContent = state.streamers;
    ui.listenerCount.textContent = state.listeners;
    
    if (state.streamActive) {
        // Hide the "Waiting for stream..." overlay on the canvas
        ui.waveformOverlay.classList.add('waveform-overlay--hidden');
        
        // Ensure audio context is running to play the stream
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    } else {
        // Show overlay
        ui.waveformOverlay.classList.remove('waveform-overlay--hidden');
        
        // Tell waveform to fade out to a flat line
        if (waveform) waveform.clear();
        
        // Tell AudioWorklet to clear its buffer
        if (workletNode) {
            workletNode.port.postMessage({ type: 'clear' });
        }
    }
}

function updateVolumeBar() {
    if (waveform && state.streamActive) {
        // Get smoothed peak level (0.0 to 1.0)
        const peak = waveform.getPeakLevel();
        // Convert to percentage for the CSS width
        ui.volumeFill.style.width = `${Math.min(100, peak * 100)}%`;
    } else {
        ui.volumeFill.style.width = '0%';
    }
    
    // Loop animation
    requestAnimationFrame(updateVolumeBar);
}

// ════════════════════════════════════════════════════════════════════════════
// RECORDING CONTROL (REST API)
// ════════════════════════════════════════════════════════════════════════════

async function toggleRecording() {
    // Prevent action if not connected
    if (!state.connected) {
        showToast('Must be connected to record', 'error');
        return;
    }

    try {
        // Disable button while request is in flight
        ui.btnRecord.disabled = true;
        
        if (state.recording) {
            // Stop recording
            const res = await fetch(`${API_BASE}/recording/stop`, { method: 'POST' });
            const data = await res.json();
            
            if (data.status === 'stopped') {
                showToast(`Recording saved: ${data.recording.size_human}`, 'success');
                // The WebSocket will also receive a recording_status broadcast,
                // but we fetch recordings here just to be safe
                fetchRecordings();
            } else {
                showToast(data.message || 'Error stopping recording', 'error');
            }
        } else {
            // Start recording
            const res = await fetch(`${API_BASE}/recording/start`, { method: 'POST' });
            const data = await res.json();
            
            if (data.status === 'started') {
                showToast('Recording started', 'success');
            } else {
                showToast(data.message || 'Error starting recording', 'error');
            }
        }
    } catch (e) {
        console.error('Recording API error:', e);
        showToast('Network error', 'error');
    } finally {
        ui.btnRecord.disabled = false;
    }
}

function updateRecordingUI() {
    if (state.recording) {
        // Update button to 'Stop'
        ui.btnRecord.innerHTML = 'Stop Recording';
        ui.btnRecord.classList.replace('btn--primary', 'btn--danger');
        
        // Show timer
        ui.recordTimer.classList.add('recording-timer--active');
        
        // Start local timer loop if not already running
        if (!recordTimerInterval) {
            recordTimerInterval = setInterval(() => {
                state.recordingDuration += 1;
                ui.recordTime.textContent = formatDuration(state.recordingDuration);
            }, 1000);
        }
        ui.recordTime.textContent = formatDuration(state.recordingDuration);
        
    } else {
        // Update button to 'Record'
        ui.btnRecord.innerHTML = 'Record Audio';
        ui.btnRecord.classList.replace('btn--danger', 'btn--primary');
        
        // Hide timer
        ui.recordTimer.classList.remove('recording-timer--active');
        
        // Clear local timer
        if (recordTimerInterval) {
            clearInterval(recordTimerInterval);
            recordTimerInterval = null;
        }
        state.recordingDuration = 0;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// SAVED RECORDINGS LIST
// ════════════════════════════════════════════════════════════════════════════

async function fetchRecordings() {
    try {
        const res = await fetch(`${API_BASE}/recordings`);
        const data = await res.json();
        renderRecordings(data.recordings || []);
    } catch (e) {
        console.error('Failed to fetch recordings:', e);
    }
}

function renderRecordings(recordings) {
    ui.recordingsList.innerHTML = '';
    
    if (recordings.length === 0) {
        ui.recordingsList.innerHTML = '<li class="recordings-list__empty">No saved recordings found.</li>';
        return;
    }
    
    recordings.forEach(rec => {
        const li = document.createElement('li');
        li.className = 'recording-item';
        
        li.innerHTML = `
            <div class="recording-item__icon">🎵</div>
            <div class="recording-item__info">
                <div class="recording-item__name" title="${rec.filename}">${rec.filename}</div>
                <div class="recording-item__meta">${rec.duration_human} • ${rec.size_human} • ${rec.created_at}</div>
            </div>
            <div class="recording-item__actions">
                <a href="${API_BASE}/recordings/${rec.filename}/download" class="btn btn--icon" title="Download WAV" download="${rec.filename}">
                    ⬇️
                </a>
                <button class="btn btn--danger btn--icon" title="Delete" onclick="deleteRecording('${rec.filename}')">
                    🗑️
                </button>
            </div>
        `;
        
        ui.recordingsList.appendChild(li);
    });
}

async function deleteRecording(filename) {
    if (!confirm(`Are you sure you want to delete ${filename}?`)) return;
    
    try {
        const res = await fetch(`${API_BASE}/recordings/${filename}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Recording deleted', 'success');
            fetchRecordings();
        } else {
            showToast('Failed to delete recording', 'error');
        }
    } catch (e) {
        showToast('Network error', 'error');
    }
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

function formatDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    
    if (h > 0) {
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

/**
 * Display a temporary toast notification.
 * @param {string} message - Text to display.
 * @param {string} type - 'success', 'error', 'info'.
 */
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    
    ui.toastContainer.appendChild(toast);
    
    // Auto remove after 3 seconds
    setTimeout(() => {
        toast.classList.add('toast--exit');
        toast.addEventListener('animationend', () => {
            toast.remove();
        });
    }, 3000);
}
