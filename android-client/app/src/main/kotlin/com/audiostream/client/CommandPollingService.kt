package com.audiostream.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * CommandPollingService.kt
 *
 * Runs in the foreground (Standby Mode) to poll the server for remote start commands
 * from the Web Dashboard. When a "START" command is received, it starts the AudioRecordService.
 */
class CommandPollingService : Service() {

    companion object {
        const val ACTION_START_POLLING = "ACTION_START_POLLING"
        const val ACTION_STOP_POLLING = "ACTION_STOP_POLLING"
        const val EXTRA_SERVER_URL = "server_url"
        const val EXTRA_CLIENT_NAME = "client_name"
        
        private const val CHANNEL_ID = "audio_monitor_standby_channel"
        private const val NOTIFICATION_ID = 2
        private const val POLL_INTERVAL_MS = 5000L
        private const val TAG = "CommandPollingService"
        
        @Volatile
        var isPolling = false
            private set
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var wakeLock: PowerManager.WakeLock? = null
    
    private var serverUrl = ""
    private var clientName = ""
    
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) return START_STICKY

        when (intent.action) {
            ACTION_START_POLLING -> {
                val url = intent.getStringExtra(EXTRA_SERVER_URL) ?: return START_NOT_STICKY
                val name = intent.getStringExtra(EXTRA_CLIENT_NAME) ?: return START_NOT_STICKY
                startPolling(url, name)
            }
            ACTION_STOP_POLLING -> stopPolling()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        stopPolling()
    }

    private fun startPolling(url: String, name: String) {
        if (isPolling) return
        isPolling = true
        serverUrl = url
        clientName = name

        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
        acquireWakeLock()

        Log.i(TAG, "Started polling for client: $clientName at $serverUrl")

        serviceScope.launch {
            while (isPolling) {
                try {
                    checkRemoteCommand()
                } catch (e: Exception) {
                    Log.e(TAG, "Poll error: ${e.message}")
                }
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    private fun stopPolling() {
        if (!isPolling) return
        isPolling = false
        Log.i(TAG, "Stopped polling")

        releaseWakeLock()
        serviceScope.coroutineContext.cancelChildren()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private suspend fun checkRemoteCommand() {
        val endpoint = "${serverUrl.trimEnd('/')}/api/v1/broadcasts/command?client_id=$clientName"
        val request = Request.Builder().url(endpoint).get().build()

        httpClient.newCall(request).execute().use { response ->
            if (response.isSuccessful) {
                val body = response.body?.string()
                if (body != null) {
                    val json = JSONObject(body)
                    val command = json.optString("command", "NONE")
                    
                    if (command == "START") {
                        Log.i(TAG, "Received REMOTE START from Dashboard!")
                        // Start recording
                        val serviceIntent = Intent(this, AudioRecordService::class.java).apply {
                            action = AudioRecordService.ACTION_START
                            putExtra(AudioRecordService.EXTRA_SERVER_URL, serverUrl)
                        }
                        ContextCompat.startForegroundService(this, serviceIntent)
                        
                        // We can stop polling since the recording service is now active.
                        // Or we can keep it alive. We will stop polling to avoid two foreground services.
                        stopPolling()
                    } else if (command == "STOP") {
                        // The user hit stop while we were polling?
                        val serviceIntent = Intent(this, AudioRecordService::class.java).apply {
                            action = AudioRecordService.ACTION_STOP
                        }
                        ContextCompat.startForegroundService(this, serviceIntent)
                    }
                }
            }
        }
    }

    private fun buildNotification(): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Audio Stream Standby Mode")
            .setContentText("Listening for remote commands from Dashboard...")
            .setSmallIcon(android.R.drawable.ic_menu_info_details)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Standby Service",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps app alive to receive remote commands"
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AudioStream:StandbyWakeLock")
        }
        if (wakeLock?.isHeld == false) {
            wakeLock?.acquire(12 * 60 * 60 * 1000L) // 12 hours max
        }
    }

    private fun releaseWakeLock() {
        if (wakeLock?.isHeld == true) {
            wakeLock?.release()
        }
    }
}
