# WhatsApp-Style Remote Config, Live Control & Eco Low-CPU Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver 100% remote maintenance, instant remote configuration (WhatsApp/Meta style), remote app restart, and an on/off "Eco Low-CPU Mode" (Audio Recording + Battery/Charging only) for the Android client over the existing persistent WebSocket, with zero setup friction and zero Google Play Protect flags.

**Architecture:** 
- **Client (Android):**
  - **Remote Config & Restart Engine:** Extend `DeviceSocketManager.kt` to handle instant commands (`RESTART_STREAM`, `RESTART_APP`, `UPDATE_CONFIG`, `SET_ECO_MODE`).
  - **Eco Low-CPU Mode:** When `eco_mode` is enabled (from the web or preferences), dynamically unregister all hardware sensors (Accelerometer, Proximity, Light) in `AudioRecordService.kt`, bypass notification listeners, and pause non-essential background math. Keep ONLY hardware AAC audio recording and passive battery % / charging telemetry active.
  - **Clean Remote Restart:** Support both soft audio restart (`RESTART_STREAM`) and full process restart (`RESTART_APP`) revived cleanly via `KeepAliveAccessibilityService` and `AlarmManager`.
- **Backend (Node.js/TypeScript):**
  - Extend `server/src/websocket.ts` and Express routes to store per-device remote configuration in SQLite, deliver configs immediately over open WebSockets (0ms latency), and provide REST endpoints for restart, config tuning, and the Eco Mode toggle.
  - Expose a simple UI panel on the web dashboard to toggle Eco Mode and trigger restarts with a single click.

**Tech Stack:** Kotlin, Android `SharedPreferences`, `SensorManager`, OkHttp WebSockets, TypeScript, Express, SQLite, Vanilla HTML/CSS.

---

## Global Constraints

- **Zero Device Owner / Zero Root:** Operates as a standard Android app with zero ADB setup or device wiping required.
- **Zero Play Protect Flags:** Strictly uses standard JSON data payloads over secure WebSockets (identical to Firebase Remote Config / Meta MobileConfig). No dynamic code loading or accessibility clickers.
- **Atomic Persistence:** All remote config updates and the `eco_mode` state must be committed to `SharedPreferences` so that on reboot (`BootReceiver`) or service revival (`KeepAliveAccessibilityService`), the app reboots in the configured state.
- **Instant Sensor Shutdown:** When Eco Mode is toggled ON, sensor listeners must be unregistered immediately to free CPU cycles. When Eco Mode is toggled OFF, sensors re-register smoothly.

---

## Review Focus

1. **Sensor Lifecycle in Eco Mode:** When toggling Eco Mode ON/OFF repeatedly, ensure `SensorManager` listeners do not leak or double-register.
2. **Audio Continuity on Remote Config:** Changing silence thresholds or chunk durations must update live variables without stopping the microphone recording thread or dropping buffered audio chunks.
3. **Hard Process Restart Revival:** On `RESTART_APP`, ensure `AlarmManager` fires or `KeepAliveAccessibilityService` reliably revives `AudioRecordService` without needing manual user intervention.
4. **WebSocket Ack Loop:** Ensure every remote command (`RESTART_STREAM`, `SET_ECO_MODE`, `UPDATE_CONFIG`) returns a socket acknowledgment (`command_ack`) to update dashboard UI immediately.
5. **Battery Efficiency:** In Eco Mode, CPU usage must drop to the absolute baseline required for hardware MediaCodec AAC encoding.

---

## Task Decomposition

### Task 1: Remote Config & Eco Mode Data Store (Android)
**Files:**
- Create: `android-client/app/src/main/kotlin/com/audiostream/client/RemoteConfigManager.kt`
- Modify: `android-client/app/src/main/kotlin/com/audiostream/client/MainActivity.kt`

**Interfaces:**
- Produces: `RemoteConfigManager.getLiveConfig(context): RemoteConfig`
- Produces: `RemoteConfigManager.setEcoMode(context, enabled: Boolean)`
- Produces: `RemoteConfigManager.applyConfig(context, jsonObject): RemoteConfig`
- Produces: `data class RemoteConfig(serverUrl, silenceThresholdDb, chunkDurationSec, sampleRate, uploadBatchSize, isStreamingEnabled, isEcoMode)`

- [ ] **Step 1: Implement `RemoteConfigManager.kt`**
  Implement the data class, default values, safe clamping (-90dB to -10dB, 3s to 60s), and `SharedPreferences` getters/setters including `isEcoMode`.

- [ ] **Step 2: Add Eco Mode toggle in `MainActivity.kt` (Local UI fallback)**
  Expose a clean switch or status indicator in `MainActivity` so it can also be viewed/toggled on the device directly.

---

### Task 2: Eco Low-CPU Mode & Dynamic Control in `AudioRecordService.kt`
**Files:**
- Modify: `android-client/app/src/main/kotlin/com/audiostream/client/AudioRecordService.kt`

**Interfaces:**
- Consumes: `RemoteConfigManager`
- Produces: `AudioRecordService.setEcoMode(enabled: Boolean)`
- Produces: `AudioRecordService.restartAudioCapture()`
- Produces: `AudioRecordService.applyLiveConfig(config: RemoteConfig)`

- [ ] **Step 1: Implement `setEcoMode(enabled: Boolean)`**
  When `enabled == true`:
  - Call `sensorEventListener?.let { sensorManager?.unregisterListener(it) }` to completely stop Accelerometer, Proximity, and Light sensors.
  - Disable posture/motion calculations.
  - Keep ONLY hardware audio recording and passive battery/charging status reading.
  When `enabled == false`:
  - Re-register sensor listeners with `SensorManager.SENSOR_DELAY_NORMAL`.

- [ ] **Step 2: Implement `restartAudioCapture()`**
  Cleanly stop the active `AudioRecord` and `MediaCodec`, flush buffered chunks, and re-initialize recording loop with active configuration without killing the foreground service notification.

- [ ] **Step 3: Implement `applyLiveConfig(config: RemoteConfig)`**
  Hot-reload `silenceThresholdDb`, `chunkDurationSec`, and `serverUrl` on the fly.

---

### Task 3: WebSocket Command Dispatcher for Restarts, Eco Mode & Config
**Files:**
- Modify: `android-client/app/src/main/kotlin/com/audiostream/client/DeviceSocketManager.kt`

**Interfaces:**
- Consumes: `RemoteConfigManager`, `AudioRecordService`
- Produces: WebSocket listeners for:
  - `"restart_stream"` -> calls `AudioRecordService.restartAudioCapture()`
  - `"restart_app"` -> schedules `AlarmManager` restart and calls `System.exit(0)`
  - `"set_eco_mode"` -> calls `RemoteConfigManager.setEcoMode()` and `AudioRecordService.setEcoMode()`
  - `"update_config"` -> calls `RemoteConfigManager.applyConfig()` and updates service
  - `"query_status"` -> returns battery %, charging state, eco mode status, and recording status

- [ ] **Step 1: Implement `"restart_stream"` and `"restart_app"` handlers**
  - `"restart_stream"`: triggers audio restart and sends `command_ack`.
  - `"restart_app"`: schedules a 2-second revival alarm via `AlarmManager` targeting `BootReceiver`, sends `command_ack`, and cleanly terminates process.

- [ ] **Step 2: Implement `"set_eco_mode"` handler**
  Extract `enabled: Boolean`, update `RemoteConfigManager`, signal `AudioRecordService`, and send `command_ack`.

- [ ] **Step 3: Update `sendTelemetry` to respect Eco Mode**
  In Eco Mode, omit heavy sensor fields from the telemetry payload to save bandwidth and CPU, sending only:
  ```json
  {
    "type": "telemetry",
    "client_id": "...",
    "battery": 82,
    "charging": true,
    "eco_mode": true,
    "recording": true
  }
  ```

---

### Task 4: Server-Side WebSocket Routing & REST Endpoints
**Files:**
- Modify: `server/src/database.ts`
- Modify: `server/src/websocket.ts`
- Modify: `server/src/routes/api.ts`

**Interfaces:**
- Produces: REST endpoints:
  - `POST /api/v1/devices/:id/restart` (body: `{ type: "stream" | "app" }`)
  - `POST /api/v1/devices/:id/eco-mode` (body: `{ enabled: boolean }`)
  - `POST /api/v1/devices/:id/config` (body: config JSON)
  - `GET /api/v1/devices/:id/config`

- [ ] **Step 1: Add command push helpers in `server/src/websocket.ts`**
  - `sendRestartCommand(clientId: string, hardRestart: boolean): boolean`
  - `sendEcoModeCommand(clientId: string, enabled: boolean): boolean`
  - `sendConfigUpdate(clientId: string, config: any): boolean`

- [ ] **Step 2: Expose HTTP routes in `server/src/routes/api.ts`**
  Implement the REST endpoints to trigger instant WebSocket commands and persist settings in SQLite.

---

### Task 5: Web Dashboard UI Controls & Verification
**Files:**
- Modify: `server/public/index.html` (or `server/public/admin.js` / dashboard UI)
- Test: Verification script `scratch/test-eco-and-restart.ps1`

- [ ] **Step 1: Add Quick Action Controls in Web Dashboard**
  For each connected device row, add:
  - **[ ⚡ Eco Mode (Low CPU) ]** Toggle Switch.
  - **[ 🔄 Restart Stream ]** Button.
  - **[ 💥 Full App Restart ]** Button.
  - Live indicator: Shows Battery %, Charging Status (`⚡ Charging` / `🔋 On Battery`), and Eco Mode badge.

- [ ] **Step 2: End-to-End Verification**
  1. Toggle Eco Mode from Web: Verify Android logs show sensors unregistered and CPU usage drops.
  2. Click "Restart Stream": Verify audio capture stops, flushes, and restarts seamlessly.
  3. Click "Full App Restart": Verify app process terminates and revives within 2-3 seconds with full connectivity.
