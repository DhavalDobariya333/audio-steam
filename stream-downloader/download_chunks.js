const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// --- Configuration & CLI Args ---
// Usage: node download_chunks.js [sessionId_or_baseUrl] [outputFolder]
const inputArg = process.argv[2];
let baseUrl;

if (inputArg && inputArg.startsWith('http')) {
    baseUrl = inputArg.endsWith('/') ? inputArg : (inputArg.endsWith('.m3u8') ? inputArg.substring(0, inputArg.lastIndexOf('/') + 1) : inputArg + '/');
} else if (inputArg) {
    // Treat as Session ID
    baseUrl = `https://audio-steam-server.onrender.com/storage/sessions/${inputArg}/hls/`;
} else {
    // Default session URL
    baseUrl = "https://audio-steam-server.onrender.com/storage/sessions/ea6d1d18-e930-4eb6-a1fc-0379da3fc97f/hls/";
}

const playlistUrl = baseUrl.endsWith('vod.m3u8') ? baseUrl : (baseUrl + "vod.m3u8");
const outputFolder = process.argv[3] || path.join(__dirname, 'downloaded_chunks');
const CONCURRENCY = 8;
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetch text/playlist from URL with redirect support
 */
function fetchPlaylist(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(fetchPlaylist(res.headers.location));
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP status ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

/**
 * Downloads a single chunk file with retry and backoff
 */
async function downloadFileWithRetry(url, destPath, retries = MAX_RETRIES) {
    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
        return { skipped: true };
    }

    const tempPath = destPath + '.tmp';

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await new Promise((resolve, reject) => {
                const client = url.startsWith('https') ? https : http;
                client.get(url, (res) => {
                    if (res.statusCode !== 200) {
                        return reject(new Error(`HTTP status ${res.statusCode}`));
                    }
                    const fileStream = fs.createWriteStream(tempPath);
                    res.pipe(fileStream);

                    fileStream.on('finish', () => {
                        fileStream.close(() => resolve());
                    });

                    fileStream.on('error', (err) => {
                        fileStream.close();
                        reject(err);
                    });
                }).on('error', reject);
            });

            fs.renameSync(tempPath, destPath);
            return { skipped: false };
        } catch (err) {
            if (fs.existsSync(tempPath)) {
                try { fs.unlinkSync(tempPath); } catch (_) {}
            }
            if (attempt === retries) throw err;
            await sleep(attempt * 1000);
        }
    }
}

async function main() {
    console.log('====================================================');
    console.log('🚀 High-Speed HLS Chunk Downloader');
    console.log(`🌐 Playlist: ${playlistUrl}`);
    console.log(`📂 Output:   ${outputFolder}`);
    console.log(`⚡ Streams:  ${CONCURRENCY} parallel downloads | 🔄 Retries: ${MAX_RETRIES}`);
    console.log('====================================================\n');

    try {
        if (!fs.existsSync(outputFolder)) {
            fs.mkdirSync(outputFolder, { recursive: true });
        }

        console.log('📥 Fetching VOD playlist to extract all chunk segments...');
        const data = await fetchPlaylist(playlistUrl);

        // Save local copy of playlist
        fs.writeFileSync(path.join(outputFolder, 'vod.m3u8'), data);

        // Extract all .ts segment files
        const chunks = data.match(/^seg_.*?\.ts$/gm);

        if (!chunks || chunks.length === 0) {
            console.error('❌ No chunk segments found in the playlist!');
            return;
        }

        console.log(`✅ Found ${chunks.length} total chunks. Starting parallel download...\n`);

        let completed = 0;
        let successCount = 0;
        let index = 0;

        const printProgress = (msg) => {
            process.stdout.write(`\r\x1b[KProgress: [${completed}/${chunks.length}] ${msg}`);
        };

        async function worker() {
            while (index < chunks.length) {
                const i = index++;
                const filename = chunks[i];
                const fileUrl = baseUrl.endsWith('/') ? (baseUrl + filename) : `${baseUrl}/${filename}`;
                const destPath = path.join(outputFolder, filename);

                try {
                    const result = await downloadFileWithRetry(fileUrl, destPath);
                    successCount++;
                    completed++;
                    printProgress(`${filename} ${result.skipped ? '(Skipped: exists)' : '✓'}`);
                } catch (err) {
                    completed++;
                    process.stdout.write('\r\x1b[K');
                    console.error(`❌ [${completed}/${chunks.length}] Error downloading ${filename}: ${err.message}`);
                    printProgress('Continuing...');
                }
            }
        }

        const workers = Array.from({ length: CONCURRENCY }, () => worker());
        await Promise.all(workers);

        console.log(`\n\n🎉 Done! Successfully processed ${successCount} of ${chunks.length} chunks into '${outputFolder}'.`);
        console.log(`💡 Next step: Run 'npm run combine' or 'node combine_chunks.js' to merge them into a single MP3.`);
    } catch (err) {
        console.error(`\n❌ Fatal Error: ${err.message}`);
    }
}

main();
