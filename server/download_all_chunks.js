const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const ffmpeg = require('@ffmpeg-installer/ffmpeg');
const { execSync } = require('child_process');

// Session ID from command line or default from your latest session
const SESSION_ID = process.argv[2] || "ea6d1d18-e930-4eb6-a1fc-0379da3fc97f";
const SERVER_URL = process.argv[3] || "https://audio-steam-server.onrender.com";

const HLS_BASE_URL = `${SERVER_URL}/storage/sessions/${SESSION_ID}/hls`;
const VOD_M3U8_URL = `${HLS_BASE_URL}/vod.m3u8`;
const OUTPUT_DIR = path.join(__dirname, `chunks_${SESSION_ID.slice(0, 8)}`);

// Helper to fetch text or download file
function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(fetchUrl(res.headers.location));
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function downloadFile(url, destPath) {
    const buffer = await fetchUrl(url);
    fs.writeFileSync(destPath, buffer);
}

async function main() {
    console.log('====================================================');
    console.log(`🎙️ Downloading All Chunks (Chunk-wise) for Session:`);
    console.log(`🆔 ${SESSION_ID}`);
    console.log(`🌐 Server: ${SERVER_URL}`);
    console.log('====================================================\n');

    // 1. Create output directory
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // 2. Fetch vod.m3u8 playlist
    console.log(`📥 Step 1: Fetching playlist from: ${VOD_M3U8_URL}`);
    let m3u8Content;
    try {
        const m3u8Buffer = await fetchUrl(VOD_M3U8_URL);
        m3u8Content = m3u8Buffer.toString('utf-8');
        fs.writeFileSync(path.join(OUTPUT_DIR, 'vod.m3u8'), m3u8Content);
        console.log('✅ Playlist downloaded.');
    } catch (e) {
        console.error('❌ Failed to fetch playlist:', e.message);
        console.log('\n💡 Trying direct ZIP export fallback...');
        const zipUrl = `${SERVER_URL}/api/v1/broadcasts/${SESSION_ID}/export-channel?format=zip`;
        console.log(`Direct ZIP download URL: ${zipUrl}`);
        return;
    }

    // 3. Parse segments (.ts files) from playlist
    const lines = m3u8Content.split(/\r?\n/);
    const segmentFiles = lines
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#') && line.endsWith('.ts'));

    if (segmentFiles.length === 0) {
        console.log('⚠️ No .ts segments found in playlist.');
        return;
    }

    console.log(`\n📦 Step 2: Found ${segmentFiles.length} chunk segment(s). Downloading chunk-wise...`);

    let downloadedCount = 0;
    for (let i = 0; i < segmentFiles.length; i++) {
        const segName = segmentFiles[i];
        const segUrl = `${HLS_BASE_URL}/${segName}`;
        const savePath = path.join(OUTPUT_DIR, segName);

        process.stdout.write(`   [${i + 1}/${segmentFiles.length}] Downloading ${segName}... `);
        try {
            await downloadFile(segUrl, savePath);
            const size = (fs.statSync(savePath).size / 1024).toFixed(1);
            console.log(`✅ (${size} KB)`);
            downloadedCount++;
        } catch (err) {
            console.log(`❌ Failed: ${err.message}`);
        }
    }

    console.log(`\n🎉 Chunk-wise download finished: ${downloadedCount}/${segmentFiles.length} chunks saved to:\n📂 ${OUTPUT_DIR}\n`);

    // 4. Merge all chunks into single audio file using FFmpeg
    const mergedAudioFile = path.join(__dirname, `audio_session_${SESSION_ID.slice(0, 8)}.m4a`);
    console.log(`🎵 Step 3: Merging all chunks into single file: ${path.basename(mergedAudioFile)}...`);
    try {
        execSync(`"${ffmpeg.path}" -y -i "${VOD_M3U8_URL}" -c copy "${mergedAudioFile}"`, { stdio: 'inherit' });
        console.log(`\n✅ Full combined audio saved at: ${mergedAudioFile}`);
    } catch (err) {
        console.error('⚠️ Could not run local FFmpeg merge:', err.message);
    }
}

main().catch(err => {
    console.error('Fatal Error:', err);
});
