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
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import java.util.concurrent.TimeUnit

class AudioStreamService : Service() {

    companion object {
        const val ACTION_START = "ACTION_START"
        const val ACTION_STOP = "ACTION_STOP"
        const val ACTION_STATE_CHANGED = "ACTION_STATE_CHANGED"
        const val ACTION_LOG_EVENT = "ACTION_LOG_EVENT"
        
        const val EXTRA_IS_CONNECTED = "EXTRA_IS_CONNECTED"
        const val EXTRA_MESSAGE = "EXTRA_MESSAGE"
        
        const val NOTIFICATION_CHANNEL_ID = "audio_stream_channel"
        const val NOTIFICATION_ID = 1

        // Keep track of state so UI can sync on recreation
        var isRunning = false
    }

    // Audio config (must match server: 16kHz, Mono, 16-bit PCM)
    private val sampleRate = 16000
    private val channelConfig = AudioFormat.CHANNEL_IN_MONO
    private val audioFormat = AudioFormat.ENCODING_PCM_16BIT
    
    // Chunk size: 1024 samples * 2 bytes = 2048 bytes per chunk (~64ms)
    private val minBufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
    private val bufferSize = Math.max(minBufferSize, 2048)

    private var audioRecord: AudioRecord? = null
    private var isRecording = false
    private var recordingThread: Thread? = null

    // Networking
    private var webSocket: WebSocket? = null
    private val client = OkHttpClient.Builder()
        .pingInterval(10, TimeUnit.SECONDS)
        .build()

    // System
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val url = intent.getStringExtra("url") ?: return START_NOT_STICKY
                startForegroundService(url)
            }
            ACTION_STOP -> {
                stopStreaming()
            }
        }
        return START_NOT_STICKY
    }

    private fun startForegroundService(url: String) {
        if (isRunning) return

        // 1. Create Notification for Foreground Service
        createNotificationChannel()
        val notificationIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent, PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setContentTitle("Audio Stream Active")
            .setContentText("Streaming microphone to server...")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now) // Built-in icon
            .setContentIntent(pendingIntent)
            .build()

        startForeground(NOTIFICATION_ID, notification)

        // 2. Acquire WakeLock so CPU doesn't sleep while streaming
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AudioStream::ServiceWakelock")
        wakeLock?.acquire(4 * 60 * 60 * 1000L /*4 hours max*/)

        // 3. Update state
        isRunning = true
        sendLog("Service started. Connecting to $url...")

        // 4. Connect WebSocket
        val request = Request.Builder().url(url).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                sendLog("WebSocket connected. Starting audio capture.")
                broadcastState(true)
                startAudioRecording()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                sendLog("WebSocket error: ${t.message}")
                stopStreaming()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                sendLog("WebSocket closed: $reason")
                stopStreaming()
            }
        })
    }

    private fun startAudioRecording() {
        try {
            audioRecord = AudioRecord(
                MediaRecorder.AudioSource.MIC,
                sampleRate,
                channelConfig,
                audioFormat,
                bufferSize
            )

            if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {
                sendLog("Failed to initialize AudioRecord. Microphone in use?")
                stopStreaming()
                return
            }

            isRecording = true
            audioRecord?.startRecording()

            recordingThread = Thread {
                // We use a ByteArray since we send raw bytes over WebSocket
                val buffer = ByteArray(2048) 

                while (isRecording && !Thread.interrupted()) {
                    val readResult = audioRecord?.read(buffer, 0, buffer.size) ?: 0
                    
                    if (readResult > 0) {
                        // Create a ByteString containing exactly the number of bytes read
                        // and send it as a binary WebSocket message
                        val byteString = buffer.copyOfRange(0, readResult).toByteString()
                        val success = webSocket?.send(byteString) ?: false
                        
                        if (!success) {
                            sendLog("Failed to send audio chunk. Connection lost?")
                            break
                        }
                    } else if (readResult < 0) {
                        sendLog("AudioRecord read error: $readResult")
                        break
                    }
                }
                
                // If loop breaks, ensure we clean up
                stopStreaming()
                
            }.apply { start() }

        } catch (e: SecurityException) {
            sendLog("Microphone permission denied.")
            stopStreaming()
        } catch (e: Exception) {
            sendLog("Audio capture error: ${e.message}")
            stopStreaming()
        }
    }

    private fun stopStreaming() {
        if (!isRunning) return
        isRunning = false
        isRecording = false
        
        broadcastState(false)
        sendLog("Stopping stream...")

        // 1. Stop audio capture
        try {
            audioRecord?.stop()
            audioRecord?.release()
            audioRecord = null
        } catch (e: Exception) {
            e.printStackTrace()
        }

        // 2. Close WebSocket
        try {
            webSocket?.close(1000, "User stopped stream")
            webSocket = null
        } catch (e: Exception) {
            e.printStackTrace()
        }

        // 3. Release WakeLock
        try {
            if (wakeLock?.isHeld == true) {
                wakeLock?.release()
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }

        // 4. Stop service
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // --- Helpers ---

    private fun broadcastState(connected: Boolean) {
        val intent = Intent(ACTION_STATE_CHANGED)
        intent.putExtra(EXTRA_IS_CONNECTED, connected)
        sendBroadcast(intent)
    }

    private fun sendLog(message: String) {
        val intent = Intent(ACTION_LOG_EVENT)
        intent.putExtra(EXTRA_MESSAGE, message)
        sendBroadcast(intent)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "Audio Stream Service",
                NotificationManager.IMPORTANCE_LOW // Low importance so it doesn't make sound
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }
}
