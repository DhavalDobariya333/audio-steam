/**
 * pro-downloader.js — High-Speed Native Slide-Over Downloader & Batch Engine
 * Replaces clunky <iframe> with a native, zero-latency slide-over drawer.
 * Supports single session downloads, multiple session batch queueing,
 * live speed metering, chunk range slicing, and background downloading.
 */

(function () {
    // ════════════════════════════════════════════════════════════════════════
    // WORKER SCRIPT INLINE
    // ════════════════════════════════════════════════════════════════════════
    const workerScript = `
        let isCancelled = false;
        let isPaused = false;
        let cryptoKey = null;
        let aesIv = null;
        let useCorsProxy = false;

        const sleep = ms => new Promise(r => setTimeout(r, ms));

        function getProxiedUrl(url) {
            if (!useCorsProxy) return url;
            return 'https://corsproxy.io/?' + encodeURIComponent(url);
        }

        async function setupCrypto(keyBuffer, ivHex) {
            cryptoKey = await crypto.subtle.importKey("raw", keyBuffer, { name: "AES-CBC" }, false, ["decrypt"]);
            ivHex = ivHex.startsWith('0x') ? ivHex.slice(2) : ivHex;
            ivHex = ivHex.padStart(32, '0');
            aesIv = new Uint8Array(ivHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        }

        async function fetchWithRetry(url, retries = 3) {
            const finalUrl = getProxiedUrl(url);
            for (let i = 0; i < retries; i++) {
                if (isCancelled) throw new Error("Cancelled");
                try {
                    const res = await fetch(finalUrl);
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    const buf = await res.arrayBuffer();
                    let data = new Uint8Array(buf);
                    
                    if (cryptoKey && aesIv) {
                        const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv: aesIv }, cryptoKey, data);
                        data = new Uint8Array(decrypted);
                    }
                    return data;
                } catch (e) {
                    if (i === retries - 1) throw e;
                    await sleep(1000 * (i + 1));
                }
            }
        }

        self.onmessage = async function(e) {
            const { type, payload } = e.data;
            if (type === 'CANCEL') { isCancelled = true; } 
            else if (type === 'PAUSE') { isPaused = payload.isPaused; }
            else if (type === 'START') {
                isCancelled = false;
                isPaused = false;
                
                const { chunks, baseUrl, concurrency, keyBuffer, ivHex, corsProxy, isDirectToDisk, displayOffset } = payload;
                useCorsProxy = corsProxy;
                
                if (keyBuffer && ivHex) {
                    try { await setupCrypto(keyBuffer, ivHex); }
                    catch(err) { self.postMessage({ type: 'ERROR', payload: { error: "Decryption setup failed: " + err.message } }); return; }
                }

                const total = chunks.length;
                const results = new Array(total);
                let completed = 0;
                let currentIndex = 0;

                return new Promise((resolve) => {
                    const processNext = async () => {
                        if (isCancelled) return;
                        while (isPaused && !isCancelled) { await sleep(200); }
                        if (isCancelled) return;
                        
                        const index = currentIndex++;
                        if (index >= total) return;
                        
                        const filename = chunks[index];
                        const url = filename.startsWith('http') ? filename : baseUrl + filename;
                        
                        try {
                            const data = await fetchWithRetry(url);
                            if (isCancelled) return;
                            
                            completed++;
                            self.postMessage({
                                type: 'CHUNK_DONE',
                                payload: {
                                    index,
                                    data,
                                    filename,
                                    completed,
                                    total,
                                    size: data.length,
                                    isDirectToDisk,
                                    displayIndex: (displayOffset || 0) + index + 1
                                }
                            });
                            
                            if (!isDirectToDisk) {
                                results[index] = data;
                            }
                        } catch (err) {
                            if (!isCancelled) {
                                self.postMessage({
                                    type: 'CHUNK_ERROR',
                                    payload: { index, filename, error: err.message }
                                });
                            }
                        }
                        
                        if (completed === total) {
                            self.postMessage({ type: 'ALL_DONE', payload: { results, filenames: chunks } });
                            resolve();
                        } else {
                            processNext();
                        }
                    };

                    const workers = [];
                    for (let i = 0; i < Math.min(concurrency, total); i++) {
                        workers.push(processNext());
                    }
                });
            }
        };
    `;

    // ════════════════════════════════════════════════════════════════════════
    // STATE & VARIABLES
    // ════════════════════════════════════════════════════════════════════════
    let worker = null;
    let isDownloading = false;
    let isPaused = false;
    let currentSession = null;
    let batchQueue = [];
    let currentBatchIndex = 0;
    let totalParsedChunks = [];
    let speedHistory = [];
    let lastTime = 0;
    let lastBytes = 0;
    let isBatchMode = false;

    // Direct-to-Disk vars
    let isDirectToDisk = false;
    let writableStream = null;
    let nextChunkToWrite = 0;
    let pendingChunks = {};
    let isWriting = false;

    // ════════════════════════════════════════════════════════════════════════
    // DOM ELEMENTS CONTAINER
    // ════════════════════════════════════════════════════════════════════════
    let ui = {};

    function ensureJsZip(callback) {
        if (window.JSZip) {
            callback();
            return;
        }
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s.onload = () => callback();
        document.head.appendChild(s);
    }

    function ensureDrawerMarkup() {
        if (document.getElementById('pro-downloader-drawer')) return;

        const markup = `
        <div class="pro-drawer-overlay" id="pro-downloader-overlay"></div>
        <div class="pro-drawer-panel" id="pro-downloader-drawer">
            <!-- Header -->
            <div class="pro-drawer-header">
                <div class="pro-drawer-title-area">
                    <div class="pro-drawer-icon">⚡</div>
                    <div>
                        <div class="pro-drawer-title" id="pro-title">Pro Downloader</div>
                        <div class="pro-drawer-sub" id="pro-sub">High-Speed Segment Downloader</div>
                    </div>
                </div>
                <div class="pro-drawer-controls">
                    <button class="pro-drawer-btn-icon" id="pro-btn-min" title="Minimize to background pill">🗕</button>
                    <button class="pro-drawer-btn-icon" id="pro-btn-close" title="Close Downloader">&times;</button>
                </div>
            </div>

            <!-- Body -->
            <div class="pro-drawer-body">
                <!-- Batch Queue Box (Shown in batch mode) -->
                <div class="pro-queue-box" id="pro-queue-box" style="display: none;">
                    <div class="pro-queue-head">
                        <span class="pro-queue-title">📦 Batch Download Queue</span>
                        <span class="pro-queue-badge" id="pro-queue-count">0 items</span>
                    </div>
                    <div class="pro-queue-list" id="pro-queue-list"></div>
                </div>

                <!-- Playlist URL Field -->
                <div class="pro-field-box">
                    <label class="pro-field-label">
                        <span>Playlist Source (.m3u8)</span>
                        <span id="pro-status-badge" style="color: #a78bfa; font-weight: normal;">Ready</span>
                    </label>
                    <input type="text" class="pro-input" id="pro-url-input" placeholder="https://.../live.m3u8" spellcheck="false">
                </div>

                <!-- Chunk Range Slicing -->
                <div class="pro-range-card" id="pro-range-card" style="display: none;">
                    <label class="pro-field-label">
                        <span>Chunk Range Selector</span>
                        <span class="pro-val-badge" id="pro-total-badge">-- chunks</span>
                    </label>
                    <div class="pro-range-row">
                        <span style="font-size: 0.75rem; color: #9ca3af; width: 35px;">From</span>
                        <input type="range" class="pro-slider" id="pro-range-start" min="1" max="100" value="1">
                        <span class="pro-val-badge" id="pro-start-val">1</span>
                    </div>
                    <div class="pro-range-row">
                        <span style="font-size: 0.75rem; color: #9ca3af; width: 35px;">To</span>
                        <input type="range" class="pro-slider" id="pro-range-end" min="1" max="100" value="100">
                        <span class="pro-val-badge" id="pro-end-val">100</span>
                    </div>
                </div>

                <!-- Format Selection -->
                <div class="pro-field-box">
                    <label class="pro-field-label">Export Package Format</label>
                    <div class="pro-format-grid">
                        <div class="pro-format-card selected" id="pro-card-merge" onclick="window.ProDownloader.setFormat('merge')">
                            <span class="pro-format-icon">🎵</span>
                            <div class="pro-format-text">
                                <span class="pro-format-title">Merged Audio</span>
                                <span class="pro-format-desc">Single continuous stream (.ts)</span>
                            </div>
                        </div>
                        <div class="pro-format-card" id="pro-card-zip" onclick="window.ProDownloader.setFormat('zip')">
                            <span class="pro-format-icon">🗜️</span>
                            <div class="pro-format-text">
                                <span class="pro-format-title">Chunks ZIP</span>
                                <span class="pro-format-desc">Individual segment files (.zip)</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Advanced Settings Toggle -->
                <button class="pro-accordion-btn" id="pro-advanced-toggle">
                    <span>⚙️ Advanced Options & Concurrency</span>
                    <span id="pro-adv-arrow">▼</span>
                </button>
                <div class="pro-advanced-panel" id="pro-advanced-panel">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-size: 0.8rem; color: #9ca3af;">Parallel Thread Concurrency</span>
                        <span class="pro-val-badge" id="pro-conc-badge">8 Threads</span>
                    </div>
                    <input type="range" class="pro-slider" id="pro-conc-slider" min="1" max="16" value="8">

                    <label class="pro-field-label">Custom Output Filename</label>
                    <input type="text" class="pro-input" id="pro-filename-input" placeholder="Auto-generated from session">
                </div>

                <!-- Live Progress Area -->
                <div class="pro-progress-section" id="pro-progress-area" style="display: none;">
                    <div class="pro-progress-stats">
                        <span class="pro-progress-stat-main" id="pro-prog-txt">0 / 0 chunks (0%)</span>
                        <span class="pro-progress-speed" id="pro-speed-txt">⚡ 0.0 MB/s</span>
                    </div>
                    <div class="pro-bar-track">
                        <div class="pro-bar-fill" id="pro-bar-fill"></div>
                    </div>
                    <div class="pro-substats">
                        <span id="pro-status-msg">Downloading chunks...</span>
                        <span id="pro-eta-txt">Size: ~0 MB</span>
                    </div>
                    <div class="pro-mini-log" id="pro-mini-log"></div>
                </div>
            </div>

            <!-- Footer Buttons -->
            <div class="pro-drawer-footer">
                <button class="pro-btn-start" id="pro-btn-start">
                    <span>🚀</span> <span id="pro-btn-start-label">Start Download</span>
                </button>
                <button class="pro-btn-pause" id="pro-btn-pause" style="display: none;">Pause</button>
                <button class="pro-btn-cancel" id="pro-btn-cancel" style="display: none;">Cancel</button>
            </div>
        </div>

        <!-- Floating Minimized Pill -->
        <div class="pro-drawer-minipill" id="pro-downloader-minipill" onclick="window.ProDownloader.maximize()">
            <span class="pro-minipill-icon">⚡</span>
            <div>
                <div class="pro-minipill-text" id="pro-pill-text">Downloading: 0%</div>
                <div class="pro-minipill-speed" id="pro-pill-speed">0.0 MB/s</div>
            </div>
        </div>
        `;

        document.body.insertAdjacentHTML('beforeend', markup);
        bindUiElements();
    }

    let selectedFormat = 'merge';

    function bindUiElements() {
        ui = {
            overlay: document.getElementById('pro-downloader-overlay'),
            panel: document.getElementById('pro-downloader-drawer'),
            minipill: document.getElementById('pro-downloader-minipill'),
            pillText: document.getElementById('pro-pill-text'),
            pillSpeed: document.getElementById('pro-pill-speed'),

            title: document.getElementById('pro-title'),
            sub: document.getElementById('pro-sub'),
            urlInput: document.getElementById('pro-url-input'),
            statusBadge: document.getElementById('pro-status-badge'),

            queueBox: document.getElementById('pro-queue-box'),
            queueCount: document.getElementById('pro-queue-count'),
            queueList: document.getElementById('pro-queue-list'),

            rangeCard: document.getElementById('pro-range-card'),
            totalBadge: document.getElementById('pro-total-badge'),
            rangeStart: document.getElementById('pro-range-start'),
            rangeEnd: document.getElementById('pro-range-end'),
            startVal: document.getElementById('pro-start-val'),
            endVal: document.getElementById('pro-end-val'),

            cardMerge: document.getElementById('pro-card-merge'),
            cardZip: document.getElementById('pro-card-zip'),

            advToggle: document.getElementById('pro-advanced-toggle'),
            advPanel: document.getElementById('pro-advanced-panel'),
            advArrow: document.getElementById('pro-adv-arrow'),
            concSlider: document.getElementById('pro-conc-slider'),
            concBadge: document.getElementById('pro-conc-badge'),
            filenameInput: document.getElementById('pro-filename-input'),

            progressArea: document.getElementById('pro-progress-area'),
            progTxt: document.getElementById('pro-prog-txt'),
            speedTxt: document.getElementById('pro-speed-txt'),
            barFill: document.getElementById('pro-bar-fill'),
            statusMsg: document.getElementById('pro-status-msg'),
            etaTxt: document.getElementById('pro-eta-txt'),
            miniLog: document.getElementById('pro-mini-log'),

            btnStart: document.getElementById('pro-btn-start'),
            btnStartLabel: document.getElementById('pro-btn-start-label'),
            btnPause: document.getElementById('pro-btn-pause'),
            btnCancel: document.getElementById('pro-btn-cancel'),
            btnClose: document.getElementById('pro-btn-close'),
            btnMin: document.getElementById('pro-btn-min')
        };

        // Events
        ui.btnClose?.addEventListener('click', () => window.ProDownloader.close());
        ui.overlay?.addEventListener('click', () => window.ProDownloader.close());
        ui.btnMin?.addEventListener('click', () => window.ProDownloader.minimize());

        ui.advToggle?.addEventListener('click', () => {
            const active = ui.advPanel.classList.toggle('active');
            ui.advArrow.textContent = active ? '▲' : '▼';
        });

        ui.concSlider?.addEventListener('input', (e) => {
            ui.concBadge.textContent = `${e.target.value} Threads`;
        });

        ui.rangeStart?.addEventListener('input', updateSliders);
        ui.rangeEnd?.addEventListener('input', updateSliders);

        ui.urlInput?.addEventListener('change', () => parseCurrentUrl());

        ui.btnStart?.addEventListener('click', () => startDownloadProcess());
        ui.btnPause?.addEventListener('click', () => togglePause());
        ui.btnCancel?.addEventListener('click', () => cancelDownload());
    }

    function updateSliders() {
        let start = parseInt(ui.rangeStart.value, 10);
        let end = parseInt(ui.rangeEnd.value, 10);
        if (start > end) {
            ui.rangeStart.value = end;
            start = end;
        }
        ui.startVal.textContent = start;
        ui.endVal.textContent = end;
    }

    async function parsePlaylist(url) {
        let res = await fetch(url);
        if (!res.ok) throw new Error("Failed to fetch m3u8 playlist (HTTP " + res.status + ")");
        let text = await res.text();

        // Check if master playlist
        if (text.includes('#EXT-X-STREAM-INF')) {
            const lines = text.split('\n');
            let highestBw = 0;
            let bestUri = null;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes('#EXT-X-STREAM-INF')) {
                    const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                    if (bwMatch && parseInt(bwMatch[1], 10) > highestBw) {
                        highestBw = parseInt(bwMatch[1], 10);
                        bestUri = lines[i + 1].trim();
                    }
                }
            }
            if (bestUri) {
                const subUrl = bestUri.startsWith('http') ? bestUri : new URL(bestUri, url).href;
                res = await fetch(subUrl);
                if (!res.ok) throw new Error("Failed to fetch resolved sub-playlist");
                text = await res.text();
                url = subUrl;
            }
        }

        const lines = text.split('\n');
        const chunks = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
                chunks.push(trimmed);
            }
        }

        if (chunks.length === 0) throw new Error("No audio chunks found in playlist");

        let keyBuffer = null, ivHex = null;
        const keyMatch = text.match(/#EXT-X-KEY:METHOD=AES-128,URI="(.*?)".*?IV=(0x[0-9A-Fa-f]+)/);
        if (keyMatch) {
            const keyUrl = new URL(keyMatch[1], url).href;
            ivHex = keyMatch[2];
            const keyRes = await fetch(keyUrl);
            if (!keyRes.ok) throw new Error("Failed to fetch decryption key");
            keyBuffer = await keyRes.arrayBuffer();
        }

        return { chunks, keyBuffer, ivHex, finalUrl: url };
    }

    async function parseCurrentUrl() {
        const url = ui.urlInput.value.trim();
        if (!url || !url.includes('.m3u8')) return;

        ui.statusBadge.textContent = 'Parsing...';
        ui.statusBadge.style.color = '#fbbf24';

        try {
            const { chunks } = await parsePlaylist(url);
            totalParsedChunks = chunks;
            const max = chunks.length;

            ui.rangeStart.max = max;
            ui.rangeEnd.max = max;
            ui.rangeStart.value = 1;
            ui.rangeEnd.value = max;
            ui.totalBadge.textContent = `${max} chunks`;
            ui.startVal.textContent = '1';
            ui.endVal.textContent = max;
            ui.rangeCard.style.display = 'block';

            ui.statusBadge.textContent = `✓ ${max} Chunks Ready`;
            ui.statusBadge.style.color = '#10b981';
            ui.btnStart.disabled = false;
        } catch (e) {
            ui.rangeCard.style.display = 'none';
            ui.statusBadge.textContent = 'Error parsing';
            ui.statusBadge.style.color = '#ef4444';
            log('Error: ' + e.message, true);
        }
    }

    function log(msg, isError = false) {
        if (!ui.miniLog) return;
        const div = document.createElement('div');
        div.className = `pro-log-line ${isError ? 'error' : ''}`;
        div.textContent = `> ${msg}`;
        ui.miniLog.appendChild(div);
        ui.miniLog.scrollTop = ui.miniLog.scrollHeight;
    }

    function createWorker() {
        if (worker) worker.terminate();
        const blob = new Blob([workerScript], { type: 'application/javascript' });
        worker = new Worker(URL.createObjectURL(blob));
        return worker;
    }

    async function startDownloadProcess() {
        if (isBatchMode && batchQueue.length > 0) {
            startBatchDownload();
            return;
        }

        const url = ui.urlInput.value.trim();
        if (!url) return alert('Please enter or select a valid playlist URL');

        ensureJsZip(async () => {
            initSingleDownload(url);
        });
    }

    async function initSingleDownload(url) {
        isDownloading = true;
        isPaused = false;
        speedHistory = [];
        lastTime = Date.now();
        lastBytes = 0;

        ui.btnStart.disabled = true;
        ui.btnPause.style.display = 'block';
        ui.btnPause.textContent = 'Pause';
        ui.btnCancel.style.display = 'block';
        ui.progressArea.style.display = 'flex';
        ui.barFill.style.width = '0%';
        ui.miniLog.innerHTML = '';

        log(`Connecting to: ${url}`);
        let playlistData;
        try {
            playlistData = await parsePlaylist(url);
        } catch (err) {
            log(`Playlist Error: ${err.message}`, true);
            ui.statusMsg.textContent = 'Failed to load playlist';
            ui.btnStart.disabled = false;
            return;
        }

        const { chunks, keyBuffer, ivHex, finalUrl } = playlistData;
        const startIdx = parseInt(ui.rangeStart.value, 10) - 1;
        const endIdx = parseInt(ui.rangeEnd.value, 10);
        const selectedChunks = chunks.slice(startIdx, endIdx);
        const total = selectedChunks.length;
        const baseUrl = finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);
        const concurrency = parseInt(ui.concSlider.value, 10) || 8;

        const defaultFilename = currentSession?.client_name
            ? `${currentSession.client_name}_${currentSession.session_id?.slice(0, 8)}`
            : 'audio_stream_export';
        const finalBaseName = ui.filenameInput.value.trim() || defaultFilename;

        log(`Starting download of ${total} chunks (${concurrency} parallel connections)...`);

        const w = createWorker();

        w.onmessage = async (e) => {
            const { type, payload } = e.data;

            if (type === 'CHUNK_DONE') {
                const { completed, total, size, displayIndex, filename } = payload;
                const pct = Math.round((completed / total) * 100);

                ui.barFill.style.width = `${pct}%`;
                ui.progTxt.textContent = `${completed} / ${total} chunks (${pct}%)`;

                // Calculate speed
                const now = Date.now();
                const deltaT = (now - lastTime) / 1000;
                if (deltaT >= 0.5) {
                    const mbps = (size / 1024 / 1024) / deltaT;
                    ui.speedTxt.textContent = `⚡ ${mbps.toFixed(1)} MB/s`;
                    ui.pillSpeed.textContent = `${mbps.toFixed(1)} MB/s`;
                    lastTime = now;
                }

                ui.pillText.textContent = `Downloading: ${pct}%`;
                ui.statusMsg.textContent = `Downloaded: ${filename}`;
                log(`✓ [${displayIndex}/${total}] ${filename} (${(size / 1024).toFixed(1)} KB)`);
            }

            if (type === 'ALL_DONE') {
                log('All chunks downloaded! Packaging output...');
                ui.statusMsg.textContent = 'Building final package...';

                const { results, filenames } = payload;

                if (selectedFormat === 'merge') {
                    // Combine chunks into single audio file
                    const totalBytes = results.reduce((acc, r) => acc + (r ? r.length : 0), 0);
                    const merged = new Uint8Array(totalBytes);
                    let offset = 0;
                    for (const arr of results) {
                        if (arr) {
                            merged.set(arr, offset);
                            offset += arr.length;
                        }
                    }
                    triggerBrowserDownload(new Blob([merged], { type: 'audio/mp4' }), `${finalBaseName}.aac`);
                } else {
                    // Build ZIP archive
                    const zip = new window.JSZip();
                    results.forEach((data, i) => {
                        if (data) zip.file(filenames[i], data);
                    });
                    const zipBlob = await zip.generateAsync({ type: 'blob' });
                    triggerBrowserDownload(zipBlob, `${finalBaseName}_chunks.zip`);
                }

                ui.statusMsg.textContent = '✓ Download Complete!';
                ui.progTxt.textContent = `${total} / ${total} chunks (100%)`;
                ui.barFill.style.width = '100%';
                ui.btnStart.disabled = false;
                ui.btnPause.style.display = 'none';
                ui.btnCancel.style.display = 'none';
                log('Finished successfully.');
            }

            if (type === 'ERROR') {
                log(`Error: ${payload.error}`, true);
                ui.statusMsg.textContent = 'Download error';
            }
        };

        w.postMessage({
            type: 'START',
            payload: {
                chunks: selectedChunks,
                baseUrl,
                concurrency,
                keyBuffer,
                ivHex,
                corsProxy: false,
                isDirectToDisk: false,
                displayOffset: startIdx
            }
        });
    }

    async function startBatchDownload() {
        if (batchQueue.length === 0) return;
        ensureJsZip(async () => {
            isDownloading = true;
            ui.btnStart.disabled = true;
            ui.progressArea.style.display = 'flex';
            log(`Starting Batch Download of ${batchQueue.length} sessions...`);

            const zip = new window.JSZip();

            for (let i = 0; i < batchQueue.length; i++) {
                currentBatchIndex = i;
                const item = batchQueue[i];
                renderQueueList();

                log(`Batch [${i + 1}/${batchQueue.length}]: Processing ${item.client_name || item.session_id}...`);
                const streamUrl = `${window.location.origin}/storage/sessions/${item.session_id}/hls/vod.m3u8`;

                try {
                    const { chunks, keyBuffer, ivHex, finalUrl } = await parsePlaylist(streamUrl);
                    const baseUrl = finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);

                    const folderName = `${item.client_name || 'session'}_${item.session_id.slice(0, 8)}`;
                    const subFolder = zip.folder(folderName);

                    // Download chunks for this item
                    for (let j = 0; j < chunks.length; j++) {
                        const cName = chunks[j];
                        const cUrl = cName.startsWith('http') ? cName : baseUrl + cName;
                        const res = await fetch(cUrl);
                        if (res.ok) {
                            const buf = await res.arrayBuffer();
                            subFolder.file(cName, buf);
                        }
                        const overallPct = Math.round(((i * 100) + ((j / chunks.length) * 100)) / batchQueue.length);
                        ui.barFill.style.width = `${overallPct}%`;
                        ui.progTxt.textContent = `Batch item ${i + 1}/${batchQueue.length} (${overallPct}%)`;
                    }
                    item.status = 'done';
                } catch (e) {
                    log(`Batch item failed: ${e.message}`, true);
                    item.status = 'error';
                }
            }

            log('Generating Master Batch ZIP archive...');
            ui.statusMsg.textContent = 'Generating Master ZIP...';
            const masterBlob = await zip.generateAsync({ type: 'blob' });
            triggerBrowserDownload(masterBlob, `batch_recordings_${new Date().toISOString().slice(0, 10)}.zip`);

            ui.statusMsg.textContent = '✓ Batch Download Complete!';
            ui.btnStart.disabled = false;
            renderQueueList();
        });
    }

    function renderQueueList() {
        if (!ui.queueList) return;
        ui.queueList.innerHTML = batchQueue.map((item, idx) => {
            const isCur = idx === currentBatchIndex && isDownloading;
            const statusIcon = item.status === 'done' ? '✅' : (item.status === 'error' ? '❌' : (isCur ? '🔄' : '⏳'));
            const statusText = item.status === 'done' ? 'Done' : (item.status === 'error' ? 'Failed' : (isCur ? 'Downloading...' : 'Waiting'));
            return `
                <div class="pro-queue-item ${isCur ? 'active' : ''} ${item.status === 'done' ? 'done' : ''}">
                    <div>
                        <span style="font-weight: 600; color: #ffffff;">📱 ${item.client_name || 'Device'}</span>
                        <span style="font-size: 0.72rem; color: #9ca3af; margin-left: 6px;">${item.session_id?.slice(0, 8)}...</span>
                    </div>
                    <div>
                        <span style="font-size: 0.75rem;">${statusIcon} ${statusText}</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    function togglePause() {
        if (!worker) return;
        isPaused = !isPaused;
        worker.postMessage({ type: 'PAUSE', payload: { isPaused } });
        ui.btnPause.textContent = isPaused ? 'Resume' : 'Pause';
        ui.statusMsg.textContent = isPaused ? 'Download paused' : 'Resuming download...';
    }

    function cancelDownload() {
        if (worker) {
            worker.postMessage({ type: 'CANCEL' });
            worker.terminate();
            worker = null;
        }
        isDownloading = false;
        ui.btnStart.disabled = false;
        ui.btnPause.style.display = 'none';
        ui.btnCancel.style.display = 'none';
        ui.statusMsg.textContent = 'Download cancelled';
        log('Download cancelled by user.', true);
    }

    function triggerBrowserDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 15000);
    }

    // ════════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ════════════════════════════════════════════════════════════════════════
    window.ProDownloader = {
        open(streamUrl, session = null) {
            ensureDrawerMarkup();
            isBatchMode = false;
            currentSession = session;
            batchQueue = [];

            ui.queueBox.style.display = 'none';
            ui.title.textContent = 'Pro Stream Downloader';
            ui.sub.textContent = session ? `${session.client_name || 'Audio Device'} • ID: ${session.session_id?.slice(0, 8)}` : 'HLS Fast Downloader';

            ui.urlInput.value = streamUrl;
            ui.filenameInput.value = session ? `${session.client_name || 'recording'}_${session.session_id?.slice(0, 8)}` : '';

            ui.overlay.classList.add('active');
            ui.panel.classList.add('active');
            ui.minipill.style.display = 'none';

            parseCurrentUrl();
        },

        openBatch(sessionsArray = []) {
            ensureDrawerMarkup();
            if (!sessionsArray || sessionsArray.length === 0) return;

            isBatchMode = true;
            batchQueue = sessionsArray.map(s => ({ ...s, status: 'waiting' }));
            currentBatchIndex = 0;

            ui.queueBox.style.display = 'block';
            ui.queueCount.textContent = `${sessionsArray.length} sessions`;
            renderQueueList();

            ui.title.textContent = 'Pro Batch Downloader';
            ui.sub.textContent = `Batch downloading ${sessionsArray.length} selected sessions`;

            ui.urlInput.value = `${sessionsArray.length} Sessions Queued for Master Download`;
            ui.rangeCard.style.display = 'none';
            ui.btnStart.disabled = false;

            ui.overlay.classList.add('active');
            ui.panel.classList.add('active');
            ui.minipill.style.display = 'none';
        },

        close() {
            if (ui.overlay && ui.panel) {
                ui.overlay.classList.remove('active');
                ui.panel.classList.remove('active');
            }
        },

        minimize() {
            if (ui.overlay && ui.panel && ui.minipill) {
                ui.overlay.classList.remove('active');
                ui.panel.classList.remove('active');
                if (isDownloading) {
                    ui.minipill.style.display = 'flex';
                }
            }
        },

        maximize() {
            if (ui.overlay && ui.panel && ui.minipill) {
                ui.overlay.classList.add('active');
                ui.panel.classList.add('active');
                ui.minipill.style.display = 'none';
            }
        },

        setFormat(fmt) {
            selectedFormat = fmt;
            if (fmt === 'merge') {
                ui.cardMerge?.classList.add('selected');
                ui.cardZip?.classList.remove('selected');
            } else {
                ui.cardZip?.classList.add('selected');
                ui.cardMerge?.classList.remove('selected');
            }
        }
    };

    // Auto-init on load if DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureDrawerMarkup);
    } else {
        ensureDrawerMarkup();
    }
})();
