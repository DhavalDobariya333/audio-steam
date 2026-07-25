/**
 * app.js — Host Dashboard for Time-Shifted Live Audio Platform
 *
 * Polls GET /api/v1/dashboard/stats and /api/v1/dashboard/sessions
 * to display broadcast sessions with delete functionality.
 */

const API = '/api/v1/dashboard';
const POLL_INTERVAL = 5000;

const state = {
    sessions: [],
    stats: {},
    storage: {},
    initialized: false,
    offset: 0,
    limit: 50,
    hasMore: false,
    deleteTarget: null,
};

const ui = {};

// ════════════════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    cacheUI();
    bindEvents();
    fetchAll();
    setInterval(fetchAll, POLL_INTERVAL);
});

function cacheUI() {
    ui.statActive = document.getElementById('stat-active');
    ui.statSessions = document.getElementById('stat-sessions');
    ui.statChunks = document.getElementById('stat-chunks');
    ui.statDuration = document.getElementById('stat-duration');
    ui.statStorage = document.getElementById('stat-storage');
    ui.statFree = document.getElementById('stat-free');

    ui.connectionDot = document.getElementById('connection-dot');
    ui.statusText = document.getElementById('status-text');

    ui.liveBanner = document.getElementById('live-banner');
    ui.liveCount = document.getElementById('live-count');

    ui.sessionList = document.getElementById('session-list');
    ui.sessionCount = document.getElementById('session-count');
    ui.loadMore = document.getElementById('load-more');
    ui.btnLoadMore = document.getElementById('btn-load-more');
    ui.btnRefresh = document.getElementById('btn-refresh');

    ui.modalOverlay = document.getElementById('modal-overlay');
    ui.modalSessionId = document.getElementById('modal-session-id');
    ui.modalCancel = document.getElementById('modal-cancel');
    ui.modalConfirm = document.getElementById('modal-confirm');

    ui.toastContainer = document.getElementById('toast-container');
}

function bindEvents() {
    ui.btnRefresh.addEventListener('click', () => {
        ui.btnRefresh.classList.add('spinning');
        setTimeout(() => ui.btnRefresh.classList.remove('spinning'), 600);
        fetchAll();
    });

    if (ui.btnLoadMore) ui.btnLoadMore.addEventListener('click', () => fetchSessions(true));

    ui.modalCancel.addEventListener('click', closeModal);
    ui.modalOverlay.addEventListener('click', (e) => {
        if (e.target === ui.modalOverlay) closeModal();
    });
    ui.modalConfirm.addEventListener('click', confirmDelete);
}

// ════════════════════════════════════════════════════════════════════════════
// DATA
// ════════════════════════════════════════════════════════════════════════════

async function fetchAll() {
    await Promise.all([fetchStats(), fetchSessions()]);
}

async function fetchStats() {
    try {
        const res = await fetch(`${API}/stats`);
        if (!res.ok) { setStatus(false); return; }
        const data = await res.json();
        setStatus(true);

        state.stats = data;
        state.storage = data.storage || {};

        ui.statActive.textContent = data.active_sessions || 0;
        ui.statSessions.textContent = data.total_sessions || 0;
        ui.statChunks.textContent = data.total_chunks || 0;
        ui.statDuration.textContent = data.total_duration_human || '00:00';
        ui.statStorage.textContent = data.total_size_human || '0 B';
        ui.statFree.textContent = state.storage.free_human || '—';

        // Live banner
        const active = data.active_sessions || 0;
        if (active > 0) {
            ui.liveBanner.style.display = 'flex';
            ui.liveCount.textContent = active;
        } else {
            ui.liveBanner.style.display = 'none';
        }
    } catch {
        setStatus(false);
    }
}

async function fetchSessions(append = false) {
    try {
        const offset = append ? state.offset : 0;
        const res = await fetch(`${API}/sessions?limit=${state.limit}&offset=${offset}`);
        if (!res.ok) return;
        const data = await res.json();

        if (append) {
            state.sessions = state.sessions.concat(data.sessions || []);
        } else {
            state.sessions = data.sessions || [];
            state.offset = 0;
        }

        state.hasMore = (data.sessions || []).length >= state.limit;
        state.offset = state.sessions.length;
        state.initialized = true;

        renderSessions();
    } catch (e) {
        console.error('Fetch sessions error:', e);
    }
}

function setStatus(online) {
    const dot = ui.connectionDot.querySelector('.dot');
    if (online) {
        dot.classList.remove('dot--offline');
        dot.classList.add('dot--pulse');
        ui.statusText.textContent = 'Connected';
    } else {
        dot.classList.add('dot--offline');
        dot.classList.remove('dot--pulse');
        ui.statusText.textContent = 'Offline';
    }
}

// ════════════════════════════════════════════════════════════════════════════
// RENDER
// ════════════════════════════════════════════════════════════════════════════

function renderSessions() {
    const sessions = state.sessions;
    ui.sessionCount.textContent = `${sessions.length} session${sessions.length !== 1 ? 's' : ''}`;

    if (sessions.length === 0) {
        ui.sessionList.innerHTML = '<li class="empty-state">No broadcast sessions yet.<br>Start recording from the mobile app to see sessions here.</li>';
        ui.loadMore.style.display = 'none';
        return;
    }

    ui.sessionList.innerHTML = sessions.map(s => {
        const isLive = s.status === 'live';
        const statusClass = isLive ? 'live' : 'ended';
        const badgeText = isLive ? '● LIVE' : 'ENDED';
        const duration = formatDuration(s.total_duration || 0);
        const date = formatIST(s.created_at);
        const chunks = s.total_chunks || 0;
        const size = formatSize(s.total_bytes || 0);
        const client = esc(s.client_name || 'Unknown');
        const shortId = s.session_id.slice(0, 8);

        return `
            <li class="session-card session-card--${statusClass}">
                <div class="session-card__top">
                    <div class="session-card__info">
                        <div class="session-card__title">
                            ${client}
                            <span class="session-card__badge session-card__badge--${statusClass}">${badgeText}</span>
                        </div>
                        <div class="session-card__meta">
                            <span class="session-card__meta-item">⏱ ${duration}</span>
                            <span class="session-card__meta-item">📦 ${chunks} chunks</span>
                            <span class="session-card__meta-item">📁 ${size}</span>
                            <span class="session-card__meta-item">📅 ${date} (IST)</span>
                        </div>
                    </div>
                    <div class="session-card__actions">
                        <a href="/storage/sessions/${s.session_id}/hls/vod.m3u8" download="audio_session_${shortId}.m3u8" class="btn btn--icon btn--sm btn--ghost" title="Download Audio Recording">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        </a>
                        ${isLive ? `<a href="/listener/" class="btn btn--icon btn--sm btn--ghost" title="Listen Live">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                        </a>` : ''}
                        <button class="btn btn--icon btn--sm btn--danger" title="Delete Session"
                                onclick="openDeleteModal('${esc(s.session_id)}')">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                    </div>
                </div>
                <div class="session-card__id">ID: ${s.session_id}</div>
            </li>
        `;
    }).join('');

    ui.loadMore.style.display = state.hasMore ? 'block' : 'none';
}

// ════════════════════════════════════════════════════════════════════════════
// DELETE
// ════════════════════════════════════════════════════════════════════════════

window.openDeleteModal = function(sessionId) {
    state.deleteTarget = sessionId;
    ui.modalSessionId.textContent = sessionId;
    ui.modalOverlay.classList.add('modal-overlay--open');
    document.body.style.overflow = 'hidden';
};

function closeModal() {
    ui.modalOverlay.classList.remove('modal-overlay--open');
    document.body.style.overflow = '';
    state.deleteTarget = null;
}

async function confirmDelete() {
    if (!state.deleteTarget) return;
    const sessionId = state.deleteTarget;

    try {
        const res = await fetch(`${API}/sessions/${sessionId}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Session deleted permanently', 'success');
            state.sessions = state.sessions.filter(s => s.session_id !== sessionId);
            renderSessions();
            fetchStats();
        } else {
            showToast('Failed to delete session', 'error');
        }
    } catch {
        showToast('Network error', 'error');
    }

    closeModal();
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

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

function formatDuration(s) {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

function formatSize(b) {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

function showToast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = `toast toast--${type}`;
    t.textContent = msg;
    ui.toastContainer.appendChild(t);
    setTimeout(() => {
        t.classList.add('toast--exit');
        t.addEventListener('animationend', () => t.remove());
    }, 3000);
}
