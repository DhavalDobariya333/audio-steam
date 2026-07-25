/**
 * app.js — Live Listener Application
 *
 * Capabilities:
 *   - Auto-fetches live/active sessions from /api/v1/listen/active
 *   - Plays HLS streams (.m3u8) using hls.js (or native Safari)
 *   - Renders a live frequency visualizer using Web Audio API
 *   - Supports DVR controls (seek, jump to live)
 */

const API = '/api/v1/listen';
const POLL_INTERVAL = 5000;

// Application State
const state = {
    sessions: [],
    currentSession: null,
    isPlaying: false,
    isLive: false,
};

// UI Elements
const ui = {
    statusDot: document.querySelector('.dot'),
    statusText: document.getElementById('status-text'),
    select: document.getElementById('session-select'),
    trackTitle: document.getElementById('track-title'),
    trackMeta: document.getElementById('track-meta'),
    
    // Player
    audio: document.getElementById('audio-player'),
    btnPlay: document.getElementById('btn-play'),
    btnRewind: document.getElementById('btn-rewind'),
    btnJumpLive: document.getElementById('btn-jump-live'),
    iconPlay: document.getElementById('icon-play'),
    iconPause: document.getElementById('icon-pause'),
    
    // Progress
    progressBar: document.getElementById('progress-bar-container'),
    progressFill: document.getElementById('progress-fill'),
    progressBuffer: document.getElementById('progress-buffer'),
    timeCurrent: document.getElementById('time-current'),
    timeTotal: document.getElementById('time-total'),
    
    // Visualizer
    canvas: document.getElementById('visualizer'),
    overlay: document.getElementById('visualizer-overlay'),
    
    toastContainer: document.getElementById('toast-container')
};

// HLS & Audio Context
let hls = null;
let audioCtx = null;
let analyser = null;
let source = null;
let animationId = null;

// ════════════════════════════════════════════════════════════════════════════
// INIT & POLLING
// ════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    fetchSessions();
    setInterval(fetchSessions, POLL_INTERVAL);
});

function bindEvents() {
    ui.select.addEventListener('change', (e) => loadSession(e.target.value));
    
    ui.btnPlay.addEventListener('click', togglePlay);
    ui.btnRewind.addEventListener('click', rewind15);
    ui.btnJumpLive.addEventListener('click', jumpToLive);
    
    ui.audio.addEventListener('play', () => setPlayingState(true));
    ui.audio.addEventListener('pause', () => setPlayingState(false));
    ui.audio.addEventListener('timeupdate', updateProgress);
    ui.audio.addEventListener('error', onAudioError);
    
    // Seek via progress bar
    ui.progressBar.addEventListener('click', (e) => {
        if (!state.currentSession || !ui.audio.duration) return;
        const rect = ui.progressBar.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        ui.audio.currentTime = pos * ui.audio.duration;
    });
}

async function fetchSessions() {
    try {
        const res = await fetch(`${API}/active`);
        if (!res.ok) throw new Error();
        const data = await res.json();
        
        setStatus(true);
        updateSessionList(data.sessions || []);
    } catch {
        setStatus(false);
    }
}

function setStatus(online) {
    ui.statusDot.className = `dot ${online ? 'dot--online' : 'dot--offline'}`;
    ui.statusText.textContent = online ? 'Online' : 'Reconnecting...';
}

function updateSessionList(sessions) {
    const prev = ui.select.value;
    state.sessions = sessions;
    
    ui.select.innerHTML = '<option value="">Select a broadcast...</option>';
    
    if (sessions.length === 0) {
        ui.select.innerHTML = '<option value="">No live broadcasts right now</option>';
        ui.select.disabled = true;
    } else {
        sessions.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.session_id;
            opt.textContent = `${s.client_name} (LIVE)`;
            ui.select.appendChild(opt);
        });
        ui.select.disabled = false;
        
        // Restore selection if it still exists
        if (prev && sessions.find(s => s.session_id === prev)) {
            ui.select.value = prev;
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// PLAYBACK
// ════════════════════════════════════════════════════════════════════════════

function loadSession(sessionId) {
    const session = state.sessions.find(s => s.session_id === sessionId);
    if (!session) return stopPlayback();
    
    state.currentSession = session;
    ui.trackTitle.textContent = session.client_name;
    ui.trackMeta.textContent = 'Live Broadcast';
    
    ui.btnPlay.disabled = false;
    ui.btnRewind.disabled = false;
    ui.btnJumpLive.disabled = false;
    
    setupHls(session.hls_live_url);
}

function setupHls(url) {
    // Destroy previous HLS instance
    if (hls) {
        hls.destroy();
        hls = null;
    }
    
    ui.audio.pause();
    ui.audio.removeAttribute('src');
    ui.audio.load();

    if (Hls.isSupported()) {
        hls = new Hls({
            liveSyncDurationCount: 2,
            liveMaxLatencyDurationCount: 5,
        });
        
        hls.loadSource(url);
        hls.attachMedia(ui.audio);
        
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            ui.overlay.textContent = 'Ready';
            // Auto-play might be blocked by browser policy until user interacts
        });
        
        hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                switch(data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        hls.startLoad();
                        break;
                    default:
                        showToast('Stream playback error');
                        hls.destroy();
                        break;
                }
            }
        });
    } 
    // Native Safari support
    else if (ui.audio.canPlayType('application/vnd.apple.mpegurl')) {
        ui.audio.src = url;
    }
}

function stopPlayback() {
    state.currentSession = null;
    ui.trackTitle.textContent = 'No session selected';
    ui.trackMeta.textContent = '—';
    ui.btnPlay.disabled = true;
    ui.btnRewind.disabled = true;
    ui.btnJumpLive.disabled = true;
    
    if (hls) {
        hls.destroy();
        hls = null;
    }
    ui.audio.pause();
    setPlayingState(false);
    ui.overlay.classList.remove('hidden');
    ui.overlay.textContent = 'Ready to Play';
}

function togglePlay() {
    if (!state.currentSession) return;
    
    if (ui.audio.paused) {
        initAudioContext(); // Must be initialized on user interaction
        ui.audio.play().catch(e => {
            console.error('Play blocked:', e);
            showToast('Playback blocked by browser');
        });
    } else {
        ui.audio.pause();
    }
}

function setPlayingState(isPlaying) {
    state.isPlaying = isPlaying;
    ui.iconPlay.style.display = isPlaying ? 'none' : 'block';
    ui.iconPause.style.display = isPlaying ? 'block' : 'none';
    
    if (isPlaying) {
        ui.statusDot.classList.add('dot--live');
        ui.overlay.classList.add('hidden');
    } else {
        ui.statusDot.classList.remove('dot--live');
    }
}

// ════════════════════════════════════════════════════════════════════════════
// DVR CONTROLS
// ════════════════════════════════════════════════════════════════════════════

function rewind15() {
    if (ui.audio.currentTime > 15) {
        ui.audio.currentTime -= 15;
    } else {
        ui.audio.currentTime = 0;
    }
}

function jumpToLive() {
    // Seek to near the end of the buffered live stream
    if (ui.audio.duration && Number.isFinite(ui.audio.duration)) {
        ui.audio.currentTime = ui.audio.duration - 2; // 2 seconds from edge
    } else if (hls && hls.liveSyncPosition) {
        ui.audio.currentTime = hls.liveSyncPosition;
    }
}

function updateProgress() {
    if (!ui.audio.duration || !Number.isFinite(ui.audio.duration)) return;
    
    const cur = ui.audio.currentTime;
    const dur = ui.audio.duration;
    
    ui.progressFill.style.width = `${(cur / dur) * 100}%`;
    ui.timeCurrent.textContent = formatTime(cur);
    
    // Check if we are "Live" (within 5 seconds of the edge)
    const isLiveEdge = dur - cur < 5;
    if (isLiveEdge !== state.isLive) {
        state.isLive = isLiveEdge;
        ui.timeTotal.classList.toggle('active', isLiveEdge);
        ui.timeTotal.textContent = isLiveEdge ? 'LIVE' : formatTime(dur);
    }
    
    // Update buffer visualization
    if (ui.audio.buffered.length > 0) {
        const bufferedEnd = ui.audio.buffered.end(ui.audio.buffered.length - 1);
        ui.progressBuffer.style.width = `${(bufferedEnd / dur) * 100}%`;
    }
}

function onAudioError(e) {
    console.error('Audio error:', ui.audio.error);
    showToast('Playback error');
    setPlayingState(false);
}

// ════════════════════════════════════════════════════════════════════════════
// WEB AUDIO API VISUALIZER
// ════════════════════════════════════════════════════════════════════════════

function initAudioContext() {
    if (audioCtx) return; // Already initialized
    
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        
        source = audioCtx.createMediaElementSource(ui.audio);
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        
        drawVisualizer();
    } catch (e) {
        console.warn('Web Audio API not supported:', e);
    }
}

function drawVisualizer() {
    if (!analyser) return;
    
    animationId = requestAnimationFrame(drawVisualizer);
    
    const ctx = ui.canvas.getContext('2d');
    const width = ui.canvas.width;
    const height = ui.canvas.height;
    
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    analyser.getByteFrequencyData(dataArray);
    
    ctx.clearRect(0, 0, width, height);
    
    const barWidth = (width / bufferLength) * 2.5;
    let x = 0;
    
    for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * height;
        
        // Gradient based on height
        const gradient = ctx.createLinearGradient(0, height, 0, height - barHeight);
        gradient.addColorStop(0, '#ff3366');
        gradient.addColorStop(1, '#ff809f');
        
        ctx.fillStyle = gradient;
        
        // Round top corners
        ctx.beginPath();
        ctx.roundRect(x, height - barHeight, barWidth - 2, barHeight, [4, 4, 0, 0]);
        ctx.fill();
        
        x += barWidth;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

function formatTime(s) {
    if (isNaN(s) || !isFinite(s)) return '0:00';
    s = Math.max(0, Math.floor(s));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

function showToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    ui.toastContainer.appendChild(t);
    setTimeout(() => {
        t.classList.add('toast--exit');
        t.addEventListener('animationend', () => t.remove());
    }, 3000);
}
