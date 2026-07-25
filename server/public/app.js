/**
 * Audio Stream Unified SPA JS
 * Combines Live HLS Player, Frequency Visualizer, and Admin Session Dashboard.
 */

const API_LISTEN = '/api/v1/listen';
const API_DASHBOARD = '/api/v1/dashboard';
const POLL_INTERVAL = 4000;

// Application State
const state = {
    sessions: [],
    dashboardSessions: [],
    currentSession: null,
    isPlaying: false,
    isLiveLock: true,
    deleteTargetId: null,
};

// UI Elements
const ui = {
    select: document.getElementById('session-select'),
    liveIndicator: document.getElementById('live-indicator'),
    trackName: document.getElementById('track-name'),
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
    
    // Stats
    statActive: document.getElementById('stat-active'),
    statSessions: document.getElementById('stat-sessions'),
    statChunks: document.getElementById('stat-chunks'),
    statDuration: document.getElementById('stat-duration'),
    statStorage: document.getElementById('stat-storage'),
    
    // Dashboard List
    sessionList: document.getElementById('session-list'),
    sessionCount: document.getElementById('session-count'),
    btnRefresh: document.getElementById('btn-refresh'),
    
    // View tabs
    tabAll: document.getElementById('tab-all'),
    tabPlayer: document.getElementById('tab-player'),
    tabDashboard: document.getElementById('tab-dashboard'),
    secPlayer: document.getElementById('sec-player'),
    secDashboard: document.getElementById('sec-dashboard'),
    gridContainer: document.getElementById('grid-container'),
    
    // Modal
    modalOverlay: document.getElementById('modal-overlay'),
    modalSessionId: document.getElementById('modal-session-id'),
    modalCancel: document.getElementById('modal-cancel'),
    modalConfirm: document.getElementById('modal-confirm'),
};

let hls = null;
let audioCtx = null;
let analyser = null;
let source = null;
let animationId = null;

// ════════════════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    fetchAllData();
    setInterval(fetchAllData, POLL_INTERVAL);
});

function bindEvents() {
    ui.select.addEventListener('change', (e) => loadSession(e.target.value));
    ui.btnPlay.addEventListener('click', togglePlay);
    ui.btnRewind.addEventListener('click', rewind15);
    ui.btnJumpLive.addEventListener('click', jumpToLive);
    ui.btnRefresh.addEventListener('click', fetchAllData);
    
    ui.audio.addEventListener('play', () => setPlayingState(true));
    ui.audio.addEventListener('pause', () => setPlayingState(false));
    ui.audio.addEventListener('timeupdate', updateProgress);
    
    // Progress bar seek
    ui.progressBar.addEventListener('click', (e) => {
        if (!state.currentSession || !ui.audio.duration) return;
        const rect = ui.progressBar.getBoundingClientRect();
        const pos = (e.clientX - rect.left) / rect.width;
        ui.audio.currentTime = pos * ui.audio.duration;
        state.isLiveLock = false;
        ui.btnJumpLive.classList.remove('active');
    });

    // View tabs
    ui.tabAll.addEventListener('click', () => setViewMode('all'));
    ui.tabPlayer.addEventListener('click', () => setViewMode('player'));
    ui.tabDashboard.addEventListener('click', () => setViewMode('dashboard'));

    // Modal
    ui.modalCancel.addEventListener('click', closeModal);
    ui.modalConfirm.addEventListener('click', confirmDelete);
}

function setViewMode(mode) {
    [ui.tabAll, ui.tabPlayer, ui.tabDashboard].forEach(btn => btn.classList.remove('active'));

    if (mode === 'all') {
        ui.tabAll.classList.add('active');
        ui.secPlayer.style.display = 'flex';
        ui.secDashboard.style.display = 'flex';
        ui.gridContainer.style.gridTemplateColumns = '1fr 1fr';
    } else if (mode === 'player') {
        ui.tabPlayer.classList.add('active');
        ui.secPlayer.style.display = 'flex';
        ui.secDashboard.style.display = 'none';
        ui.gridContainer.style.gridTemplateColumns = '1fr';
    } else if (mode === 'dashboard') {
        ui.tabDashboard.classList.add('active');
        ui.secPlayer.style.display = 'none';
        ui.secDashboard.style.display = 'flex';
        ui.gridContainer.style.gridTemplateColumns = '1fr';
    }
}

// ════════════════════════════════════════════════════════════════════════════
// DATA FETCHING & POLLING
// ════════════════════════════════════════════════════════════════════════════

async function fetchAllData() {
    await Promise.all([fetchActiveSessions(), fetchStats(), fetchAllSessions()]);
}

async function fetchActiveSessions() {
    try {
        const res = await fetch(`${API_LISTEN}/active`);
        if (!res.ok) return;
        const data = await res.json();
        updateActiveSessions(data.sessions || []);
    } catch (e) {
        console.error('Active sessions fetch error:', e);
    }
}

function updateActiveSessions(sessions) {
    const prev = ui.select.value;
    state.sessions = sessions;
    
    ui.select.innerHTML = '';
    
    if (sessions.length === 0) {
        ui.select.innerHTML = '<option value="">No live broadcasts right now</option>';
        ui.select.disabled = true;
    } else {
        sessions.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.session_id;
            const dev = s.device_info ? ` — ${s.device_info}` : '';
            opt.textContent = `🟢 ${s.client_name}${dev} (LIVE)`;
            ui.select.appendChild(opt);
        });
        ui.select.disabled = false;
        
        // Restore selection or AUTO-SELECT if single device!
        if (prev && sessions.find(s => s.session_id === prev)) {
            ui.select.value = prev;
        } else if (sessions.length === 1 && !state.currentSession) {
            ui.select.value = sessions[0].session_id;
            loadSession(sessions[0].session_id);
        }
    }
}

async function fetchStats() {
    try {
        const res = await fetch(`${API_DASHBOARD}/stats`);
        if (!res.ok) return;
        const data = await res.json();
        
        ui.statActive.textContent = data.active_sessions || 0;
        ui.statSessions.textContent = data.total_sessions || 0;
        ui.statChunks.textContent = data.total_chunks || 0;
        ui.statDuration.textContent = data.total_duration_human || '00:00';
        ui.statStorage.textContent = data.total_size_human || '0 B';
    } catch (e) {
        console.error('Stats fetch error:', e);
    }
}

async function fetchAllSessions() {
    try {
        const res = await fetch(`${API_DASHBOARD}/sessions?limit=100`);
        if (!res.ok) return;
        const data = await res.json();
        state.dashboardSessions = data.sessions || [];
        renderSessionsList();
    } catch (e) {
        console.error('Sessions fetch error:', e);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// PLAYBACK CONTROLS & HLS
// ════════════════════════════════════════════════════════════════════════════

function loadSession(sessionId) {
    const session = state.sessions.find(s => s.session_id === sessionId) || 
                    state.dashboardSessions.find(s => s.session_id === sessionId);
    if (!session) return stopPlayback();
    
    state.currentSession = session;
    ui.trackName.textContent = session.client_name || 'Audio Session';
    ui.trackMeta.textContent = `Device: ${session.device_info || 'Android'} | Status: ${(session.status || 'live').toUpperCase()}`;
    
    ui.btnPlay.disabled = false;
    ui.btnRewind.disabled = false;
    
    const hlsUrl = session.hls_live_url || `/storage/sessions/${session.session_id}/hls/live.m3u8`;
    setupHls(hlsUrl);
}

function setupHls(url) {
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
            ui.overlay.classList.add('hidden');
        });
    } else if (ui.audio.canPlayType('application/vnd.apple.mpegurl')) {
        ui.audio.src = url;
    }
}

function stopPlayback() {
    state.currentSession = null;
    ui.trackName.textContent = 'No Device Playing';
    ui.trackMeta.textContent = 'Connect an Android device to stream';
    ui.btnPlay.disabled = true;
    ui.btnRewind.disabled = true;
    
    if (hls) {
        hls.destroy();
        hls = null;
    }
    ui.audio.pause();
    setPlayingState(false);
    ui.overlay.classList.remove('hidden');
}

function togglePlay() {
    if (!state.currentSession) return;
    if (ui.audio.paused) {
        initAudioContext();
        ui.audio.play().catch(e => console.error('Playback error:', e));
    } else {
        ui.audio.pause();
    }
}

function setPlayingState(isPlaying) {
    state.isPlaying = isPlaying;
    ui.iconPlay.style.display = isPlaying ? 'none' : 'inline';
    ui.iconPause.style.display = isPlaying ? 'inline' : 'none';
    
    if (isPlaying) {
        ui.liveIndicator.classList.add('active');
        ui.liveIndicator.textContent = '● STREAMING LIVE';
        ui.overlay.classList.add('hidden');
        startVisualizer();
    } else {
        ui.liveIndicator.classList.remove('active');
        ui.liveIndicator.textContent = 'PAUSED';
    }
}

function rewind15() {
    if (ui.audio.currentTime > 15) {
        ui.audio.currentTime -= 15;
    } else {
        ui.audio.currentTime = 0;
    }
    state.isLiveLock = false;
    ui.btnJumpLive.classList.remove('active');
}

function jumpToLive() {
    state.isLiveLock = true;
    ui.btnJumpLive.classList.add('active');
    if (ui.audio.duration && Number.isFinite(ui.audio.duration)) {
        ui.audio.currentTime = Math.max(0, ui.audio.duration - 1);
    }
}

function updateProgress() {
    if (!ui.audio.duration || !Number.isFinite(ui.audio.duration)) return;
    
    const cur = ui.audio.currentTime;
    const dur = ui.audio.duration;
    
    if (state.isLiveLock && dur - cur > 3) {
        ui.audio.currentTime = dur - 1;
    }

    ui.progressFill.style.width = `${(cur / dur) * 100}%`;
    ui.timeCurrent.textContent = formatTime(cur);
    
    const isLiveEdge = dur - cur < 5;
    if (isLiveEdge) {
        ui.btnJumpLive.classList.add('active');
    }

    ui.timeTotal.textContent = formatTime(dur);
    
    if (ui.audio.buffered.length > 0) {
        const bufferedEnd = ui.audio.buffered.end(ui.audio.buffered.length - 1);
        ui.progressBuffer.style.width = `${(bufferedEnd / dur) * 100}%`;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// DASHBOARD & SESSIONS RENDER
// ════════════════════════════════════════════════════════════════════════════

function renderSessionsList() {
    const sessions = state.dashboardSessions;
    ui.sessionCount.textContent = `${sessions.length} session${sessions.length !== 1 ? 's' : ''} recorded`;

    if (sessions.length === 0) {
        ui.sessionList.innerHTML = '<li class="empty-state">No broadcast sessions recorded yet.</li>';
        return;
    }

    ui.sessionList.innerHTML = sessions.map(s => {
        const isLive = s.status === 'live';
        const statusClass = isLive ? 'live' : 'ended';
        const badgeText = isLive ? '● LIVE' : 'ENDED';
        const duration = formatTime(s.total_duration || 0);
        const dateStr = formatIST(s.created_at);
        const sizeStr = formatSize(s.total_bytes || 0);
        const client = s.client_name || 'Unknown Device';
        const shortId = s.session_id.slice(0, 8);

        return `
            <li class="session-card session-card--${statusClass}">
                <div class="session-card__top">
                    <div>
                        <div class="session-card__title">
                            ${client}
                            <span class="badge badge--${statusClass}">${badgeText}</span>
                        </div>
                        <div class="session-card__meta">
                            <span>📱 ${s.device_info || 'Android Device'}</span>
                            <span>⏱ ${duration}</span>
                            <span>📦 ${s.total_chunks || 0} chunks</span>
                            <span>💾 ${sizeStr}</span>
                            <span>📅 ${dateStr}</span>
                        </div>
                    </div>
                    <div class="session-card__actions">
                        <a href="/storage/sessions/${s.session_id}/hls/vod.m3u8" download="audio_recording_${shortId}.m3u8" class="icon-btn" title="Download Audio Recording">
                            📥 Download
                        </a>
                        <button class="icon-btn icon-btn--danger" title="Delete Session" onclick="openDeleteModal('${s.session_id}')">
                            🗑️
                        </button>
                    </div>
                </div>
            </li>
        `;
    }).join('');
}

// ════════════════════════════════════════════════════════════════════════════
// MODAL & HELPERS
// ════════════════════════════════════════════════════════════════════════════

function openDeleteModal(sessionId) {
    state.deleteTargetId = sessionId;
    ui.modalSessionId.textContent = `Session ID: ${sessionId}`;
    ui.modalOverlay.classList.add('active');
}

function closeModal() {
    state.deleteTargetId = null;
    ui.modalOverlay.classList.remove('active');
}

async function confirmDelete() {
    if (!state.deleteTargetId) return;
    try {
        const res = await fetch(`${API_DASHBOARD}/sessions/${state.deleteTargetId}`, { method: 'DELETE' });
        if (res.ok) {
            closeModal();
            fetchAllData();
        }
    } catch (e) {
        console.error('Delete error:', e);
    }
}

function formatIST(dateStr) {
    if (!dateStr) return '—';
    try {
        const d = new Date(dateStr);
        return d.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            dateStyle: 'medium',
            timeStyle: 'short',
            hour12: true
        });
    } catch {
        return dateStr;
    }
}

function formatTime(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ════════════════════════════════════════════════════════════════════════════
// AUDIO VISUALIZER
// ════════════════════════════════════════════════════════════════════════════

function initAudioContext() {
    if (audioCtx) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        source = audioCtx.createMediaElementSource(ui.audio);
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
    } catch (e) {
        console.error('Web Audio API error:', e);
    }
}

function startVisualizer() {
    if (!analyser) return;
    const ctx = ui.canvas.getContext('2d');
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    function draw() {
        if (!state.isPlaying) return;
        animationId = requestAnimationFrame(draw);
        analyser.getByteFrequencyData(dataArray);
        
        ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
        const barWidth = (ui.canvas.width / bufferLength) * 2;
        let x = 0;
        
        for (let i = 0; i < bufferLength; i++) {
            const barHeight = (dataArray[i] / 255) * ui.canvas.height;
            const gradient = ctx.createLinearGradient(0, ui.canvas.height, 0, 0);
            gradient.addColorStop(0, '#7c5cfc');
            gradient.addColorStop(1, '#10b981');
            
            ctx.fillStyle = gradient;
            ctx.fillRect(x, ui.canvas.height - barHeight, barWidth - 2, barHeight);
            x += barWidth;
        }
    }
    draw();
}
