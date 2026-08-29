# 🎙️ Stream Downloader & MP3 Combiner

A lightweight, high-performance Node.js utility to download HLS audio chunks in parallel from live/VOD sessions and seamlessly merge them into a single high-quality `.mp3` file.

---

## ⚡ Features
- **Parallel Chunk Downloads**: Downloads audio segments using 8 concurrent streams for speed.
- **Smart Resume / Skip**: Automatically skips chunks that are already downloaded.
- **Auto-Retry**: Exponential backoff retry mechanism (up to 3 retries) against flaky network conditions.
- **Numerical Sequence Sorting**: Guarantees chunk segments are merged in exact audio chronological order (`seg_000000.ts` -> `seg_000xxx.ts`).
- **Zero External FFmpeg Setup Needed**: Uses `@ffmpeg-installer/ffmpeg` directly.

---

## 📦 Setup & Installation

```bash
cd stream-downloader
npm install
```

---

## 🚀 Usage

### 1. Download Chunks
To download all chunks for a session:

```bash
# Using default session
node download_chunks.js

# Or passing a specific Session ID
node download_chunks.js <SESSION_ID>

# Or passing custom Session ID and output directory
node download_chunks.js <SESSION_ID> ./my_session_chunks

# Or passing a direct HLS Base URL
node download_chunks.js "https://audio-steam-server.onrender.com/storage/sessions/<SESSION_ID>/hls/"
```

### 2. Combine Chunks into MP3
Once chunks are downloaded, merge them into a clean `.mp3`:

```bash
# Using default folders
node combine_chunks.js

# Or specifying input chunks folder and output MP3 path
node combine_chunks.js ./my_session_chunks ./output_recording.mp3
```

---

## 🛠️ NPM Scripts

```bash
npm run download    # Runs download_chunks.js with default config
npm run combine     # Runs combine_chunks.js with default config
```
