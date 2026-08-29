const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpeg = require('@ffmpeg-installer/ffmpeg');

// --- Configuration & CLI Args ---
// Usage: node combine_chunks.js [inputFolder] [outputMp3File]
const inputFolder = process.argv[2] || path.join(__dirname, 'downloaded_chunks');
const outputFile = process.argv[3] || path.join(__dirname, 'combined_audio.mp3');
const listFile = path.join(__dirname, 'temp_chunks_list.txt');

async function main() {
    console.log('====================================================');
    console.log('🎵 Chunk-to-MP3 Merger');
    console.log(`📂 Source: ${inputFolder}`);
    console.log(`🎯 Output: ${outputFile}`);
    console.log('====================================================\n');

    if (!fs.existsSync(inputFolder)) {
        console.error(`❌ Source folder not found: ${inputFolder}`);
        console.error(`💡 Tip: Run 'node download_chunks.js' first to download the chunks.`);
        return;
    }

    // 1. Get all .ts chunks
    const files = fs.readdirSync(inputFolder).filter(f => f.endsWith('.ts'));

    if (files.length === 0) {
        console.error('❌ No .ts chunk files found in the source folder!');
        return;
    }

    // 2. Sort files numerically by segment number
    files.sort((a, b) => {
        const matchA = a.match(/\d+/);
        const matchB = b.match(/\d+/);
        const numA = matchA ? parseInt(matchA[0], 10) : 0;
        const numB = matchB ? parseInt(matchB[0], 10) : 0;
        return numA - numB;
    });

    console.log(`✅ Found ${files.length} chunk files in sequence. Creating FFmpeg concat manifest...`);

    // 3. Create the concat demuxer text file for FFmpeg
    let fileListContent = '';
    for (const file of files) {
        const absolutePath = path.join(inputFolder, file).replace(/\\/g, '/');
        fileListContent += `file '${absolutePath}'\n`;
    }

    fs.writeFileSync(listFile, fileListContent);
    console.log(`⏳ Launching FFmpeg to combine and re-encode to MP3 (128 kbps)...\n`);

    // 4. Run FFmpeg concat demuxer
    const ffmpegProc = spawn(ffmpeg.path, [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listFile,
        '-c:a', 'libmp3lame',
        '-b:a', '128k',
        outputFile
    ]);

    ffmpegProc.stderr.on('data', (data) => {
        const output = data.toString();
        const firstLine = output.split('\n')[0].substring(0, 80).trim();
        if (firstLine.startsWith('size=') || firstLine.startsWith('frame=')) {
            process.stdout.write(`\r\x1b[KFFmpeg Progress: ${firstLine}`);
        }
    });

    ffmpegProc.on('close', (code) => {
        if (fs.existsSync(listFile)) {
            try { fs.unlinkSync(listFile); } catch (_) {}
        }

        if (code === 0) {
            const stats = fs.statSync(outputFile);
            const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
            console.log(`\n\n🎉 Success! Merged ${files.length} chunks into MP3 file:`);
            console.log(`📁 File: ${outputFile} (${sizeMB} MB)\n`);
        } else {
            console.error(`\n\n❌ FFmpeg failed with exit code ${code}`);
        }
    });
}

main();
