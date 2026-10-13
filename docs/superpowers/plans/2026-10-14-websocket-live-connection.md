# Live Persistent WebSocket Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace battery-draining HTTP polling with an always-on, 2-way persistent WebSocket connection between Android client devices and the server, enabling 0ms remote command execution and real-time telemetry streaming (WhatsApp/Facebook style).

**Architecture:**
- Server: An integrated WebSocket Gateway (`ws`) attached to the Node.js/Express HTTP server on `/ws/device`. Maintains live device socket registries, pushes commands instantly when triggered, and receives real-time telemetry.
- Android: A dedicated `DeviceSocketManager` using OkHttp WebSocket with automated reconnection, ping/pong keepalives, and instant command routing to `AudioRecordService`.

---

## Global Constraints
- Target Node.js: Compatible with Node 16+ locally and Node 18+ in Docker.
- Backwards Compatibility: Keep HTTP `/api/v1/broadcasts/command` as a fallback for non-socket clients.
- Clean Reconnection: Exponential backoff on disconnect; clean ping/pong keep-alives (15s interval).

---

## Tasks

### Task 1: Server WebSocket Dependencies & Gateway
- [x] Install `ws@^8.18.0` and `@types/ws@^8.5.14` in `server/`.
- [x] Create `server/src/websocket.ts` with `initWebSocketServer`, device connection registry, telemetry handling, and `sendDeviceCommand`.
- [x] Attach WebSocket server to HTTP server in `server/src/index.ts`.
- [x] Integrate instant WebSocket dispatch in `server/src/routes/broadcast.ts` for `/remote-command`.

### Task 2: Android DeviceSocketManager
- [x] Create `android-client/app/src/main/kotlin/com/audiostream/client/DeviceSocketManager.kt` using OkHttp `WebSocket` and `WebSocketListener`.
- [x] Implement automatic reconnection loop with exponential backoff and 15s keep-alive pings.
- [x] Implement message handler for incoming commands (`START`, `STOP`, `SCREENSHOT_NOW`) and automated acknowledgment.

### Task 3: Integrate Socket in AudioRecordService
- [x] Wire `DeviceSocketManager` in `AudioRecordService.kt`.
- [x] Connect command callbacks to `switchToRecording()` and `switchToStandby()`.
- [x] Forward telemetry (battery, storage, audio route) over the live socket.

### Task 4: Build & Automated Verification
- [x] Compile TypeScript with `npm run build`.
- [x] Run automated end-to-end WebSocket test verifying device connection, telemetry ingestion, and instant command push.
- [x] Compile Android Kotlin and assemble fresh `app.apk`.
