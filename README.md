# 🎙️ Live Audio Monitor (Termux Server Edition)

A complete, production-ready audio surveillance and streaming architecture hosted entirely on an Android phone using Termux. 

No VPS, no cloud hosting, no third-party backends. Just your phone serving the dashboard and handling the WebSocket connections, securely tunneled to the internet via Cloudflare.

## 🏗️ Architecture

```
[ Friend's Phone ] 
       │ 
       │ (Captures Mic, sends 16kHz PCM over WebSocket)
       ▼
[ Internet ]  →  [ Cloudflare Tunnel ] 
                       │ (Routes traffic securely)
                       ▼
[ Your Phone (Termux) ]
       ├── FastAPI Server (0.0.0.0:8765)
       ├── WebSocket Connection Manager
       ├── WAV Recorder (Saves locally)
       └── Vanilla JS Dashboard
```

## 📂 Project Structure

- `server/` — Python/FastAPI backend. Handles connections, PCM relay, and WAV recording.
- `server/static/` — Vanilla HTML/CSS/JS frontend. Live waveform, Web Audio API playback.
- `android-client/` — Kotlin application. Captures mic audio in a Foreground Service and streams it to the server.
- `recordings/` — Automatically created. Where your saved WAV files are stored.

## 🚀 Deployment Guide

We've broken down the deployment into 3 clear steps:

1. **[Termux Server Setup](SETUP_TERMUX.md)** — Install Python, disable Android battery optimization, and run the FastAPI server.
2. **[Cloudflare Tunnel Setup](SETUP_CLOUDFLARE.md)** — Expose your local Termux server to the internet using a free Cloudflare tunnel (no hosting required).
3. **Android Client Setup** — Compile the Kotlin client via CLI and install it on the target device.

---

### Building the Android Client (CLI)

You don't need Android Studio. You can build the APK directly from the command line using Gradle wrapper (or install gradle).

1. Navigate to the client directory:
   ```bash
   cd android-client
   ```

2. Make sure you have the Android SDK installed. If you are building this ON Termux itself, you will need tools like `ecj` and `d8`, but it is much easier to compile the APK on a PC once and send the `.apk` file to the target phone.

   *(Assuming building on PC with JDK 17+ and Android SDK set in `local.properties`):*
   ```bash
   # Linux/Mac
   ./gradlew assembleDebug

   # Windows
   gradlew.bat assembleDebug
   ```

3. The compiled APK will be located at:
   `android-client/app/build/outputs/apk/debug/app-debug.apk`

Install this APK on your friend's phone. Open it, enter the Cloudflare Tunnel URL (e.g., `wss://audio.yourdomain.com/ws/stream`), and tap Connect.
