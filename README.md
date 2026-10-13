# 📡 Time-Shifted Live Audio Streaming Platform

A production-grade, fault-tolerant live audio streaming, HLS transcoding, and time-shifted playback platform.

## 🏗️ System Architecture

```
┌────────────────────────┐    HTTP POST /api/v1/broadcasts/:id/chunk    ┌──────────────────────────┐
│  Android Client (App)  │ ───────────────────────────────────────────> │  Node.js / Express Server│
│  - Mic Capture (16kHz) │         (FIFO Queue, Offline-First)          │  - Ingest API            │
│  - Hardware AAC Encode │                                              │  - HLS Engine (FFmpeg)   │
│  - Silence Detection   │                                              │  - SQLite (WAL mode)     │
│  - Foreground Service  │                                              └────────────┬─────────────┘
└────────────────────────┘                                                           │
                                                                                     │ HLS Stream (.m3u8)
                                                                                     ▼
                                                                        ┌──────────────────────────┐
                                                                        │  Web Dashboard & Listener│
                                                                        │  - HLS.js Live Player    │
                                                                        │  - Playback Speed Controls│
                                                                        │  - Multi-Device Filter   │
                                                                        └──────────────────────────┘
```

---

## 📂 Project Structure

- **`server/`** — Node.js / TypeScript + Express backend. Handles audio chunk ingestion, HLS packaging (`FFmpeg`), SQLite state management with WAL mode, and serves the web dashboard SPA.
- **`server/public/`** — Unified Single Page Application (SPA) HTML5 HLS Player, Frequency Visualizer, and Admin Dashboard.
- **`android-client/`** — Native Kotlin Android application. Captures mic audio in a Foreground Service, encodes to 16kbps AAC via hardware `MediaCodec`, buffers chunks locally in Room DB, and streams to server.
- **`stream-downloader/`** — Node.js utility to download HLS audio segments in parallel and merge them into a single clean `.mp3`.

---

## 🚀 Server Setup & Running

### 1. Local Development
```bash
cd server
npm install
npm run build
npm start
```

### 2. Docker Deployment
```bash
cd server
docker build -t audio-stream-server .
docker run -p 8765:8765 -e PORT=8765 audio-stream-server
```

### 3. Exposing via Cloudflare Tunnel (Free Public URL)
To allow Android devices outside your local network to stream to your server:
```bash
# Start a free TryCloudflare tunnel pointing to your server
cloudflared tunnel --url http://localhost:8765
```
Use the generated `https://<random-id>.trycloudflare.com` URL as the server URL in the Android app.

---

## 📱 Building the Android Client (CLI)

1. Navigate to the client directory:
   ```bash
   cd android-client
   ```

2. Compile debug APK using Gradle:
   ```bash
   # Windows
   gradlew.bat assembleDebug

   # Linux/Mac
   ./gradlew assembleDebug
   ```

3. The compiled APK will be at:
   `android-client/app/build/outputs/apk/debug/app-debug.apk`

---

## 🛠️ Stream Downloader & Combiner

To download all audio chunks from a live/past session and merge into an MP3:
```bash
cd stream-downloader
npm install
node download_chunks.js <SESSION_ID>
node combine_chunks.js ./downloaded_chunks/<SESSION_ID> ./output.mp3
```

---

## ✨ Key Technical Invariants

- **Hardware AAC Encoding**: Client encodes directly to AAC (16kbps mono) saving 90% bandwidth compared to raw PCM/WAV.
- **Fault-Tolerant FIFO Queue**: Chunks are persisted in Android Room DB before upload and deleted only upon confirmed HTTP 200 server response.
- **Continuous HLS & Discontinuity Handling**: Server maintains live sliding window and full VOD playlists with `#EXT-X-DISCONTINUITY` markers on silence/network breaks.
- **Reliable Storage Engine**: Server runs SQLite in Write-Ahead Logging (WAL) mode for fast, non-blocking page writes.
