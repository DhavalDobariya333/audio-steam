/**
 * app.js — Audio Monitor Dashboard Application
 *
 * Handles:
 *   - Auto-refreshing dashboard data via REST API polling
 *   - Client status display (online/offline cards)
 *   - Recordings browser with filtering, sorting, and search
 *   - Auto-playback queue (plays new recordings sequentially)
 *   - Activity feed showing recent uploads
 *   - Toast notifications for important events
 *
 * Architecture:
 *   - Polls GET /api/dashboard every 3 seconds for all data
 *   - Individual recording endpoints for download/delete
 *   - No WebSocket needed — pure HTTP polling
 */

// ── Configuration ──
const API = '/api';
const POLL_INTERVAL = 3000;    // Dashboard refresh interval (ms)

// ── Application State ──
const state = {
    // Data
    clients: [],
    recordings: [],
    recentUploads: [],
    playbackQueue: [],
    stats: {},
    storage: {},

    // Playback
    autoPlayEnabled: false,
    isPlaying: false,
    currentTrack: null,
    lastSeenUploadCount: 0,

    // Filters
    filterClient: '',
    filterDate: '',
    filterSearch: '',
    filterSort: 'newest',

    // Pagination
    offset: 0,
    limit: 30,
    hasMore: false,

    // Known recording UUIDs (to detect new arrivals)
    knownUuids: new Set(),
    initialized: false,
};

// ── UI References ──
const ui = {};

// ════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    // Cache all UI element references
    cacheUI();

    // Bind event handlers
    bindEvents();

    // Initial data fetch
    fetchDashboard();
    fetchRecordings();

    // Start polling loop
    setInterval(fetchDashboard, POLL_INTERVAL);

    // Start playback progress animation
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

    // Clients
    ui.clientsGrid = document.getElementById('clients-grid');
    ui.clientCountBadge = document.getElementById('client-count-badge');

    // Playback
    ui.btnAutoplay = document.getElementById('btn-autoplay');
    ui.btnSkip = document.getElementById('btn-skip');
    ui.queueCountBadge = document.getElementById('queue-count-badge');
    ui.nowPlayingTitle = document.getElementById('now-playing-title');
    ui.audioPlayer = document.getElementById('audio-player');
    ui.playbackProgress = document.getElementById('playback-progress');
    ui.playbackTime = document.getElementById('playback-time');

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

    // Toast
    ui.toastContainer = document.getElementById('toast-container');
}

function bindEvents() {
    // Auto-play toggle
    ui.btnAutoplay.addEventListener('click', toggleAutoPlay);
    ui.btnSkip.addEventListener('click', skipTrack);

    // Audio player events
    ui.audioPlayer.addEventListener('ended', onTrackEnded);
    ui.audioPlayer.addEventListener('error', onTrackError);

    // Filters & Export
    ui.filterClient.addEventListener('change', onFilterChange);
    ui.filterDate.addEventListener('change', onFilterChange);
    ui.filterSearch.addEventListener('input', debounce(onFilterChange, 400));
    ui.filterSort.addEventListener('change', onFilterChange);
    if (ui.btnExportCombined) {
        ui.btnExportCombined.addEventListener('click', exportCombinedAudio);
    }

    // Load more
    ui.btnLoadMore.addEventListener('click', loadMore);
}

function exportCombinedAudio() {
    const params = new URLSearchParams();
    if (state.filterClient) params.set('client', state.filterClient);
    if (state.filterDate) params.set('date', state.filterDate);
    const minutes = ui.exportMinutes ? parseInt(ui.exportMinutes.value) : 5;
    params.set('minutes', minutes);

    const url = `${API}/recordings/export-combined?${params.toString()}`;
    const label = minutes === 0 ? 'all available audio' : `${minutes}-minute combined audio`;
    showToast(`Merging ${label} & starting download...`, 'info');

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
        if (!res.ok) return;
        const data = await res.json();

        // Update state
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
                showToast(`📥 New: ${r.client_name} — ${r.duration_human}`, 'success');
            });
            // Refresh recordings list to show new ones
            fetchRecordings();
        }

        // Update known UUIDs
        (data.recent_recordings || []).forEach(r => state.knownUuids.add(r.uuid));
        state.initialized = true;

        // Render UI
        renderStats();
        renderClients();
        renderActivity();
        updatePlaybackQueue();
        updateClientFilter();

    } catch (e) {
        // Silent failure — dashboard just stays stale until next poll
        console.error('Dashboard fetch error:', e);
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

        // Apply client-side sorting
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
        const statusClass = isOnline ? 'online' : 'offline';
        const uploads = c.total_uploads || 0;
        const lastSeen = c.last_seen || 'Never';

        return `
            <div class="client-card client-card--${statusClass}">
                <div class="client-card__dot client-card__dot--${statusClass}"></div>
                <div class="client-card__info">
                    <div class="client-card__name">${esc(c.name)}</div>
                    <div class="client-card__meta">Last: ${lastSeen}</div>
                </div>
                <div class="client-card__stats">
                    ${uploads} uploads
                </div>
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

    ui.activityFeed.innerHTML = uploads.slice(0, 15).map(u => {
        const icon = u.status === 'success' ? '✅' : '❌';
        const cls = u.status === 'success' ? 'upload' : 'error';
        const size = formatSize(u.file_size || 0);
        const time = (u.timestamp || '').split(' ')[1] || '';

        return `
            <div class="activity-item activity-item--${cls}">
                <span class="activity-item__icon">${icon}</span>
                <span class="activity-item__text">
                    <strong>${esc(u.client_name)}</strong> uploaded ${size}
                </span>
                <span class="activity-item__time">${time}</span>
            </div>
        `;
    }).join('');
}

function renderRecordings() {
    const recs = state.recordings;

    if (recs.length === 0) {
        ui.recordingsList.innerHTML = '<li class="empty-state">No recordings found.</li>';
        ui.loadMore.style.display = 'none';
        return;
    }

    ui.recordingsList.innerHTML = recs.map(r => {
        const downloadUrl = `${API}/recordings/${r.uuid}/download`;
        const phoneTime = r.recorded_at ? `📱 Recorded: ${r.recorded_at}` : `📅 ${r.uploaded_at || '—'}`;
        const title = `${esc(r.client_name)} — ${r.recorded_at || r.uploaded_at || ''}`;
        const isNew = !state.knownUuids.has(r.uuid);

        return `
            <li class="recording-item ${isNew ? 'recording-item--new' : ''}">
                <div class="recording-item__icon">🎙️</div>
                <div class="recording-item__info">
                    <div class="recording-item__name">${title}</div>
                    <div class="recording-item__meta">
                        ⏱️ ${r.duration_human || '—'} · 📁 ${r.size_human || '—'} · ${phoneTime} (☁️ ${r.uploaded_at || ''})
                    </div>
                    <div class="recording-item__player">
                        <audio controls src="${downloadUrl}" preload="none"></audio>
                    </div>
                </div>
                <div class="recording-item__actions">
                    <a href="${downloadUrl}" class="btn btn--icon btn--sm" title="Download" download="${esc(r.filename)}">⬇️</a>
                    <button class="btn btn--danger btn--icon btn--sm" title="Delete"
                            onclick="deleteRecording('${esc(r.uuid)}', '${esc(r.filename)}')">🗑️</button>
                </div>
            </li>
        `;
    }).join('');

    // Show/hide load more
    ui.loadMore.style.display = state.hasMore ? 'block' : 'none';
}

function renderStorageInfo(storage) {
    if (!storage) return;
    ui.storageInfo.innerHTML = `💾 <strong>${storage.recordings_human || '0 B'}</strong> used · ${storage.recording_files || 0} files · ${storage.free_human || '—'} free`;
}

function updateClientFilter() {
    const current = ui.filterClient.value;
    const clientNames = [...new Set(state.clients.map(c => c.name))].sort();

    // Only update if the options have changed
    const existingOptions = [...ui.filterClient.options].slice(1).map(o => o.value);
    if (JSON.stringify(clientNames) === JSON.stringify(existingOptions)) return;

    // Preserve selection
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
// AUTO-PLAYBACK SYSTEM
// ════════════════════════════════════════════════════════════════════════════

function toggleAutoPlay() {
    state.autoPlayEnabled = !state.autoPlayEnabled;

    if (state.autoPlayEnabled) {
        ui.btnAutoplay.textContent = '⏸ Auto-Play: ON';
        ui.btnAutoplay.classList.add('active');
        ui.btnSkip.disabled = false;
        showToast('Auto-play enabled — new recordings will play automatically', 'info');
        playNextInQueue();
    } else {
        ui.btnAutoplay.textContent = '▶ Auto-Play: OFF';
        ui.btnAutoplay.classList.remove('active');
        ui.btnSkip.disabled = true;
        ui.audioPlayer.pause();
        state.isPlaying = false;
        state.currentTrack = null;
        ui.nowPlayingTitle.textContent = 'Nothing playing';
    }
}

function updatePlaybackQueue() {
    const queue = state.playbackQueue;
    ui.queueCountBadge.textContent = `${queue.length} in queue`;

    // If auto-play is on and nothing is playing, start
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
        ui.nowPlayingTitle.textContent = 'Queue empty — waiting for new recordings...';
        return;
    }

    const track = queue[0];
    state.currentTrack = track;
    state.isPlaying = true;

    const url = `${API}/recordings/${track.uuid}/download`;
    ui.audioPlayer.src = url;
    ui.audioPlayer.play().catch(e => {
        console.error('Playback error:', e);
        // Browser may block autoplay without user interaction
        showToast('Click anywhere to enable audio playback', 'info');
    });

    ui.nowPlayingTitle.textContent = `${track.client_name} — ${track.uploaded_at || ''} (${track.duration_human || ''})`;

    // Mark as played on server
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

    // Remove from local queue
    if (state.playbackQueue.length > 0) {
        state.playbackQueue.shift();
    }

    ui.queueCountBadge.textContent = `${state.playbackQueue.length} in queue`;

    // Play next
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
        // Non-critical — ignore
    }
}

// ════════════════════════════════════════════════════════════════════════════
// FILTERS & SORTING
// ════════════════════════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════════════════════════
// ACTIONS
// ════════════════════════════════════════════════════════════════════════════

window.deleteRecording = async function(uuid, filename) {
    if (!confirm(`Delete recording?\n${filename}`)) return;

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
};

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
    }, 3500);
}
