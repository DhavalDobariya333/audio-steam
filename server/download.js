const ffmpeg = require('@ffmpeg-installer/ffmpeg');
const { execSync } = require('child_process');

console.log('Downloading 30MB audio stream using FFmpeg...');
console.log('Using ffmpeg path:', ffmpeg.path);

const url = "https://audio-steam-server.onrender.com/storage/sessions/7248bf92-7c4d-4459-958f-8439565385ef/hls/vod.m3u8";

try {
    execSync(`"${ffmpeg.path}" -y -i "${url}" -c copy audio_recording_7248bf92.m4a`, { stdio: 'inherit' });
    console.log('Download complete! File saved as audio_recording_7248bf92.m4a');
} catch (e) {
    console.error('Error downloading:', e);
}
