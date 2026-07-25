# 📡 Time-Shifted Live Audio Streaming Platform

A production-grade, fault-tolerant live audio streaming, HLS transcoding, and time-shifted playback platform.

## 🏗️ System Architecture

```
┌────────────────────────┐         HTTP POST /chunk         ┌──────────────────────────┐
│  Android Client (App)  │ ───────────────────────────────> │  Node.js / Express Server│
│  - Mic Capture (16kHz) │  (FIFO Queue, Offline-First)     │  - Ingest API            │
│  - Silence Detection   │                                  │  - HLS Transcoder (FFmpeg)│
│  - Foreground Service  │                                  │  - SQLite (sql.js)       │
└────────────────────────┘                                  └────────────┬─────────────┘
                                                                         │
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

- **`server/`** — Node.js / TypeScript + Express backend. Handles audio chunk ingestion, HLS transcoding (`FFmpeg`), SQLite state management, and serves the unified web SPA.
- **`server/public/`** — Unified Single Page Application (SPA) HTML5 HLS Player, Frequency Visualizer, and Admin Dashboard.
- **`android-client/`** — Kotlin application. Captures mic audio in a Foreground Service, buffers chunks locally in Room DB, and streams to server with zero data loss.

---

## 🚀 Server Setup & Local Running

1. **Install Dependencies & Build**:
   ```bash
   cd server
   npm install
   npm run build
   ```

2. **Run Dev / Production Server**:
   ```bash
   # Development
   npm run dev

   # Production
   npm start
   ```

3. **Endpoints**:
   - **Dashboard / Unified Player**: `http://localhost:8765/`
   - **Ingest API**: `http://localhost:8765/api/v1/broadcasts`
   - **Health Check**: `http://localhost:8765/api/v1/health`

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

## ✨ Features Implemented

- **Fault-Tolerant Recording**: Android client captures mic input continuously regardless of network drops.
- **Silence Detection**: Client computes RMS volume to skip empty silence chunks and reduce storage/bandwidth consumption.
- **Session Auto-Recovery**: Client resumes active live broadcast session on server after app restarts.
- **HLS Live & VOD**: Real-time HLS transcoding for live streaming + event archive playlists for time-shifted playback.
- **Rich Dashboard & Player**: Playback speed selector (0.5x - 2x), live lag / latency status badges, buffering indicators, and multi-device filtering.

