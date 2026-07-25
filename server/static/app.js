/**
 * app.js — Audio Monitor Dashboard (Mobile-First Edition)
 *
 * Architecture:
 *   - Tab-based navigation (Recordings / Clients / Activity)
 *   - Collapsible filter panel to save screen space
 *   - Fixed bottom player bar with auto-play queue
 *   - Bottom-sheet delete confirmation modal
 *   - REST API polling every 3 seconds
 */

// ── Configuration ──
const API = '/api';
const POLL_INTERVAL = 3000;

// ── Application State ──
const state = {
    clients: [],
    recordings: [],
    recentUploads: [],
    playbackQueue: [],
    stats: {},
    storage: {},

    autoPlayEnabled: false,
    isPlaying: false,
    currentTrack: null,

    filterClient: '',
    filterDate: '',
    filterSearch: '',
    filterSort: 'newest',

    offset: 0,
    limit: 30,
    hasMore: false,

    knownUuids: new Set(),
    initialized: false,
    filtersOpen: false,

    // Delete modal
    deleteTarget: null,
};

// ── UI References ──
const ui = {};

// ════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    cacheUI();
    bindEvents();
    bindTabs();
    fetchDashboard();
    fetchRecordings();
    setInterval(fetchDashboard, POLL_INTERVAL);
    requestAnimationFrame(updatePlaybackProgress);
});

function cacheUI() {
    // Stats
    ui.statOnline = document.getElementById('stat-online');
    ui.statRecordings = document.getElementById('stat-recordings');
    ui.statDuration = document.getElementById('stat-duration');
    ui.statStorage = document.getElementById('stat-storage');
    ui.statFree = document.getElementById('stat-free');
    ui.statUploadsHour = document.getElementById('stat-uploads-hour');

    // Connection
    ui.connectionDot = document.getElementById('connection-dot');
    ui.statusText = document.getElementById('status-text');

    // Clients
    ui.clientsGrid = document.getElementById('clients-grid');
    ui.clientCountBadge = document.getElementById('client-count-badge');

    // Player
    ui.btnAutoplay = document.getElementById('btn-autoplay');
    ui.btnSkip = document.getElementById('btn-skip');
    ui.queueCountBadge = document.getElementById('queue-count-badge');
    ui.nowPlayingTitle = document.getElementById('now-playing-title');
    ui.audioPlayer = document.getElementById('audio-player');
    ui.playbackProgress = document.getElementById('playback-progress');
    ui.playbackTime = document.getElementById('playback-time');
    ui.iconPlay = document.getElementById('icon-play');
    ui.iconPause = document.getElementById('icon-pause');

    // Activity
    ui.activityFeed = document.getElementById('activity-feed');

    // Recordings
    ui.recordingsList = document.getElementById('recordings-list');
    ui.storageInfo = document.getElementById('storage-info');
    ui.exportMinutes = document.getElementById('export-minutes');
    ui.btnExportCombined = document.getElementById('btn-export-combined');
    ui.filterClient = document.getElementById('filter-client');
    ui.filterDate = document.getElementById('filter-date');
    ui.filterSearch = document.getElementById('filter-search');
    ui.filterSort = document.getElementById('filter-sort');
    ui.loadMore = document.getElementById('load-more');
    ui.btnLoadMore = document.getElementById('btn-load-more');

    // Filters
    ui.btnFilterToggle = document.getElementById('btn-filter-toggle');
    ui.filterPanel = document.getElementById('filter-panel');

    // Toast
    ui.toastContainer = document.getElementById('toast-container');

    // Refresh
    ui.btnRefresh = document.getElementById('btn-refresh');

    // Modal
    ui.modalOverlay = document.getElementById('modal-overlay');
    ui.modalFilename = document.getElementById('modal-filename');
    ui.modalCancel = document.getElementById('modal-cancel');
    ui.modalConfirm = document.getElementById('modal-confirm');
}

function bindEvents() {
    // Auto-play toggle
    ui.btnAutoplay.addEventListener('click', toggleAutoPlay);
    ui.btnSkip.addEventListener('click', skipTrack);

    // Audio player
    ui.audioPlayer.addEventListener('ended', onTrackEnded);
    ui.audioPlayer.addEventListener('error', onTrackError);

    // Filters
    ui.btnFilterToggle.addEventListener('click', toggleFilters);
    ui.filterClient.addEventListener('change', onFilterChange);
    ui.filterDate.addEventListener('change', onFilterChange);
    ui.filterSearch.addEventListener('input', debounce(onFilterChange, 400));
    ui.filterSort.addEventListener('change', onFilterChange);

    // Export
    if (ui.btnExportCombined) {
        ui.btnExportCombined.addEventListener('click', exportCombinedAudio);
    }

    // Load more
    ui.btnLoadMore.addEventListener('click', loadMore);

    // Refresh button
    ui.btnRefresh.addEventListener('click', () => {
        ui.btnRefresh.classList.add('spinning');
        setTimeout(() => ui.btnRefresh.classList.remove('spinning'), 600);
        fetchDashboard();
        fetchRecordings();
    });

    // Modal
    ui.modalCancel.addEventListener('click', closeDeleteModal);
    ui.modalOverlay.addEventListener('click', (e) => {
        if (e.target === ui.modalOverlay) closeDeleteModal();
    });
    ui.modalConfirm.addEventListener('click', confirmDelete);
}

// ════════════════════════════════════════════════════════════════════════════
// TAB NAVIGATION
// ════════════════════════════════════════════════════════════════════════════

function bindTabs() {
    const tabBtns = document.querySelectorAll('.tab-nav__btn');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.dataset.tab;

            // Update buttons
            tabBtns.forEach(b => b.classList.remove('tab-nav__btn--active'));
            btn.classList.add('tab-nav__btn--active');

            // Update panels
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('tab-panel--active'));
            const panel = document.getElementById(`panel-${tabId}`);
            if (panel) {
                panel.classList.add('tab-panel--active');
            }
        });
    });
}

// ════════════════════════════════════════════════════════════════════════════
// FILTERS
// ════════════════════════════════════════════════════════════════════════════

function toggleFilters() {
    state.filtersOpen = !state.filtersOpen;
    ui.filterPanel.classList.toggle('filter-panel--open', state.filtersOpen);
    ui.btnFilterToggle.classList.toggle('filter-toggle--active', state.filtersOpen);
}

function onFilterChange() {
    state.filterClient = ui.filterClient.value;
    state.filterDate = ui.filterDate.value;
    state.filterSearch = ui.filterSearch.value;
    state.filterSort = ui.filterSort.value;
    state.offset = 0;
    fetchRecordings();
}

function sortRecordings() {
    switch (state.filterSort) {
        case 'oldest':
            state.recordings.sort((a, b) => (a.uploaded_at || '').localeCompare(b.uploaded_at || ''));
            break;
        case 'largest':
            state.recordings.sort((a, b) => (b.file_size || 0) - (a.file_size || 0));
            break;
        case 'longest':
            state.recordings.sort((a, b) => (b.duration || 0) - (a.duration || 0));
            break;
        case 'newest':
        default:
            state.recordings.sort((a, b) => (b.uploaded_at || '').localeCompare(a.uploaded_at || ''));
            break;
    }
}

function loadMore() {
    fetchRecordings(true);
}

function exportCombinedAudio() {
    const params = new URLSearchParams();
    if (state.filterClient) params.set('client', state.filterClient);
    if (state.filterDate) params.set('date', state.filterDate);
    const minutes = ui.exportMinutes ? parseInt(ui.exportMinutes.value) : 5;
    params.set('minutes', minutes);

    const url = `${API}/recordings/export-combined?${params.toString()}`;
    const label = minutes === 0 ? 'all available audio' : `${minutes}-minute combined audio`;
    showToast(`Merging ${label}...`, 'info');

    const a = document.createElement('a');
    a.href = url;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

// ════════════════════════════════════════════════════════════════════════════
// DATA FETCHING
// ════════════════════════════════════════════════════════════════════════════

async function fetchDashboard() {
    try {
        const res = await fetch(`${API}/dashboard`);
        if (!res.ok) {
            setConnectionStatus(false);
            return;
        }
        const data = await res.json();
        setConnectionStatus(true);

        state.clients = data.clients || [];
        state.recentUploads = data.recent_uploads || [];
        state.stats = data.stats || {};
        state.storage = data.storage || {};
        state.playbackQueue = data.playback_queue || [];

        // Detect new uploads
        const newRecordings = (data.recent_recordings || []).filter(
            r => !state.knownUuids.has(r.uuid)
        );

        if (state.initialized && newRecordings.length > 0) {
            newRecordings.forEach(r => {
                showToast(`📥 ${r.client_name} — ${r.duration_human}`, 'success');
            });
            fetchRecordings();
        }

        (data.recent_recordings || []).forEach(r => state.knownUuids.add(r.uuid));
        state.initialized = true;

        renderStats();
        renderClients();
        renderActivity();
        updatePlaybackQueue();
        updateClientFilter();

    } catch (e) {
        setConnectionStatus(false);
        console.error('Dashboard fetch error:', e);
    }
}

function setConnectionStatus(online) {
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

async function fetchRecordings(append = false) {
    try {
        const params = new URLSearchParams();
        if (state.filterClient) params.set('client', state.filterClient);
        if (state.filterDate) params.set('date', state.filterDate);
        if (state.filterSearch) params.set('search', state.filterSearch);
        params.set('limit', state.limit);
        params.set('offset', append ? state.offset : 0);

        const res = await fetch(`${API}/recordings?${params}`);
        if (!res.ok) return;
        const data = await res.json();

        if (append) {
            state.recordings = state.recordings.concat(data.recordings || []);
        } else {
            state.recordings = data.recordings || [];
            state.offset = 0;
        }

        state.hasMore = (data.recordings || []).length >= state.limit;
        state.offset = state.recordings.length;

        sortRecordings();
        renderRecordings();
        renderStorageInfo(data.storage || state.storage);

    } catch (e) {
        console.error('Recordings fetch error:', e);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// RENDERING
// ════════════════════════════════════════════════════════════════════════════

function renderStats() {
    const s = state.stats;
    ui.statOnline.textContent = s.clients_online || 0;
    ui.statRecordings.textContent = s.total_recordings || 0;
    ui.statDuration.textContent = s.total_duration_human || '00:00';
    ui.statStorage.textContent = s.total_size_human || '0 B';
    ui.statUploadsHour.textContent = s.uploads_last_hour || 0;

    const st = state.storage;
    ui.statFree.textContent = st.free_human || '—';
}

function renderClients() {
    const clients = state.clients;
    ui.clientCountBadge.textContent = `${clients.length} client${clients.length !== 1 ? 's' : ''}`;

    if (clients.length === 0) {
        ui.clientsGrid.innerHTML = '<div class="empty-state">No clients connected yet</div>';
        return;
    }

    ui.clientsGrid.innerHTML = clients.map(c => {
        const isOnline = c.is_online === 1;
        const status = isOnline ? 'online' : 'offline';
        const uploads = c.total_uploads || 0;
        const lastSeen = c.last_seen || 'Never';

        return `
            <div class="client-row client-row--${status}">
                <div class="client-row__dot client-row__dot--${status}"></div>
                <div class="client-row__info">
                    <div class="client-row__name">${esc(c.name)}</div>
                    <div class="client-row__detail">Last seen: ${lastSeen}</div>
                </div>
                <div class="client-row__badge">${uploads} uploads</div>
            </div>
        `;
    }).join('');
}

function renderActivity() {
    const uploads = state.recentUploads;
    if (uploads.length === 0) {
        ui.activityFeed.innerHTML = '<div class="empty-state">Waiting for uploads...</div>';
        return;
    }

    ui.activityFeed.innerHTML = uploads.slice(0, 20).map(u => {
        const icon = u.status === 'success' ? '✅' : '❌';
        const cls = u.status === 'success' ? 'success' : 'error';
        const size = formatSize(u.file_size || 0);
        const time = (u.timestamp || '').split(' ')[1] || '';

        return `
            <div class="activity-row activity-row--${cls}">
                <span class="activity-row__icon">${icon}</span>
                <span class="activity-row__text">
                    <strong>${esc(u.client_name)}</strong> · ${size}
                </span>
                <span class="activity-row__time">${time}</span>
            </div>
        `;
    }).join('');
}

function renderRecordings() {
    const recs = state.recordings;

    if (recs.length === 0) {
        ui.recordingsList.innerHTML = '<li class="empty-state">No recordings found</li>';
        ui.loadMore.style.display = 'none';
        return;
    }

    ui.recordingsList.innerHTML = recs.map(r => {
        const downloadUrl = `${API}/recordings/${r.uuid}/download`;
        const clientName = esc(r.client_name);
        const recordedAt = r.recorded_at || r.uploaded_at || '';
        const isNew = !state.knownUuids.has(r.uuid);

        // Format time nicely
        const timeStr = recordedAt.split(' ')[1] || '';
        const dateStr = recordedAt.split(' ')[0] || '';

        return `
            <li class="rec-card ${isNew ? 'rec-card--new' : ''}">
                <div class="rec-card__top">
                    <div class="rec-card__info">
                        <div class="rec-card__title">${clientName}</div>
                        <div class="rec-card__meta">
                            <span class="rec-card__meta-item">⏱ ${r.duration_human || '—'}</span>
                            <span class="rec-card__meta-item">📁 ${r.size_human || '—'}</span>
                            <span class="rec-card__meta-item">📅 ${dateStr}</span>
                            <span class="rec-card__meta-item">🕐 ${timeStr}</span>
                        </div>
                    </div>
                    <div class="rec-card__actions">
                        <a href="${downloadUrl}" class="btn btn--icon btn--sm btn--ghost" title="Download" download="${esc(r.filename)}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                        </a>
                        <button class="btn btn--icon btn--sm btn--danger" title="Delete"
                                onclick="openDeleteModal('${esc(r.uuid)}', '${esc(r.filename)}')">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                    </div>
                </div>
                <div class="rec-card__player">
                    <audio controls src="${downloadUrl}" preload="none"></audio>
                </div>
            </li>
        `;
    }).join('');

    ui.loadMore.style.display = state.hasMore ? 'block' : 'none';
}

function renderStorageInfo(storage) {
    if (!storage) return;
    ui.storageInfo.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
        <span><strong>${storage.recordings_human || '0 B'}</strong> used · ${storage.recording_files || 0} files · ${storage.free_human || '—'} free</span>
    `;
}

function updateClientFilter() {
    const current = ui.filterClient.value;
    const clientNames = [...new Set(state.clients.map(c => c.name))].sort();

    const existingOptions = [...ui.filterClient.options].slice(1).map(o => o.value);
    if (JSON.stringify(clientNames) === JSON.stringify(existingOptions)) return;

    ui.filterClient.innerHTML = '<option value="">All Clients</option>';
    clientNames.forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        if (name === current) option.selected = true;
        ui.filterClient.appendChild(option);
    });
}

// ════════════════════════════════════════════════════════════════════════════
// DELETE MODAL
// ════════════════════════════════════════════════════════════════════════════

window.openDeleteModal = function(uuid, filename) {
    state.deleteTarget = { uuid, filename };
    ui.modalFilename.textContent = filename;
    ui.modalOverlay.classList.add('modal-overlay--open');
    // Prevent body scroll
    document.body.style.overflow = 'hidden';
};

function closeDeleteModal() {
    ui.modalOverlay.classList.remove('modal-overlay--open');
    document.body.style.overflow = '';
    state.deleteTarget = null;
}

async function confirmDelete() {
    if (!state.deleteTarget) return;
    const { uuid, filename } = state.deleteTarget;

    try {
        const res = await fetch(`${API}/recordings/${uuid}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Recording deleted', 'success');
            fetchRecordings();
        } else {
            showToast('Failed to delete', 'error');
        }
    } catch (e) {
        showToast('Network error', 'error');
    }

    closeDeleteModal();
}

// ════════════════════════════════════════════════════════════════════════════
// AUTO-PLAYBACK SYSTEM
// ════════════════════════════════════════════════════════════════════════════

function toggleAutoPlay() {
    state.autoPlayEnabled = !state.autoPlayEnabled;

    if (state.autoPlayEnabled) {
        ui.iconPlay.style.display = 'none';
        ui.iconPause.style.display = 'block';
        ui.btnAutoplay.classList.add('player-btn--active');
        ui.btnSkip.disabled = false;
        showToast('Auto-play enabled', 'info');
        playNextInQueue();
    } else {
        ui.iconPlay.style.display = 'block';
        ui.iconPause.style.display = 'none';
        ui.btnAutoplay.classList.remove('player-btn--active');
        ui.btnSkip.disabled = true;
        ui.audioPlayer.pause();
        state.isPlaying = false;
        state.currentTrack = null;
        ui.nowPlayingTitle.textContent = 'Not playing';
    }
}

function updatePlaybackQueue() {
    const queue = state.playbackQueue;
    ui.queueCountBadge.textContent = queue.length;

    if (state.autoPlayEnabled && !state.isPlaying && queue.length > 0) {
        playNextInQueue();
    }
}

function playNextInQueue() {
    if (!state.autoPlayEnabled) return;

    const queue = state.playbackQueue;
    if (queue.length === 0) {
        state.isPlaying = false;
        state.currentTrack = null;
        ui.nowPlayingTitle.textContent = 'Queue empty — waiting...';
        return;
    }

    const track = queue[0];
    state.currentTrack = track;
    state.isPlaying = true;

    const url = `${API}/recordings/${track.uuid}/download`;
    ui.audioPlayer.src = url;
    ui.audioPlayer.play().catch(e => {
        console.error('Playback error:', e);
        showToast('Tap to enable audio', 'info');
    });

    const name = track.client_name || '';
    const time = (track.uploaded_at || '').split(' ')[1] || '';
    ui.nowPlayingTitle.textContent = `${name} · ${time} (${track.duration_human || ''})`;

    markPlayed(track.uuid);
}

function skipTrack() {
    if (state.currentTrack) {
        ui.audioPlayer.pause();
        onTrackEnded();
    }
}

function onTrackEnded() {
    state.isPlaying = false;
    state.currentTrack = null;

    if (state.playbackQueue.length > 0) {
        state.playbackQueue.shift();
    }

    ui.queueCountBadge.textContent = state.playbackQueue.length;

    if (state.autoPlayEnabled) {
        playNextInQueue();
    }
}

function onTrackError() {
    console.error('Audio playback error');
    onTrackEnded();
}

function updatePlaybackProgress() {
    if (state.isPlaying && ui.audioPlayer.duration) {
        const pct = (ui.audioPlayer.currentTime / ui.audioPlayer.duration) * 100;
        ui.playbackProgress.style.width = `${pct}%`;

        const cur = formatTime(ui.audioPlayer.currentTime);
        const dur = formatTime(ui.audioPlayer.duration);
        ui.playbackTime.textContent = `${cur} / ${dur}`;
    } else {
        ui.playbackProgress.style.width = '0%';
        ui.playbackTime.textContent = '0:00 / 0:00';
    }
    requestAnimationFrame(updatePlaybackProgress);
}

async function markPlayed(uuid) {
    try {
        const form = new FormData();
        form.append('uuid', uuid);
        await fetch(`${API}/playback/mark-played`, { method: 'POST', body: form });
    } catch (e) {
        // Non-critical
    }
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function debounce(fn, ms) {
    let timer;
    return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.textContent = message;
    ui.toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('toast--exit');
        toast.addEventListener('animationend', () => toast.remove());
    }, 3000);
}
