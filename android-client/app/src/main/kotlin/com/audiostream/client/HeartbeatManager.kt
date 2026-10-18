package com.audiostream.client

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.util.Log
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.TimeUnit

/**
 * HeartbeatManager.kt — Automated 1-Hour "Alive" Heartbeat Beacon
 *
 * Requirements:
 * 1. Every 1 hour, signals the server that the APK is ALIVE.
 * 2. Does NOT record audio ("not recording, only alive").
 * 3. Transmits device vitals (battery %, storage, recording state).
 * 4. Resilient against Doze mode using exact RTC_WAKEUP alarms + Guardian verification.
 */
object HeartbeatManager {

    private const val TAG = "HeartbeatManager"
    const val ACTION_HEARTBEAT_ALARM = "com.audiostream.client.ACTION_HEARTBEAT_ALARM"
    private const val REQUEST_CODE_HEARTBEAT = 7001
    private const val PREFS_NAME = "AudioMonitorPrefs"
    private const val PREF_LAST_HEARTBEAT_TIME = "last_heartbeat_timestamp_ms"
    const val HOURLY_INTERVAL_MS = 60 * 60 * 1000L // Exactly 1 hour (3600s)

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    /**
     * Schedules the next exact 1-hour alarm.
     */
    fun scheduleHourlyHeartbeat(context: Context) {
        val appContext = context.applicationContext
        val alarmManager = appContext.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return

        val intent = Intent(appContext, HeartbeatReceiver::class.java).apply {
            action = ACTION_HEARTBEAT_ALARM
        }

        val pendingIntent = PendingIntent.getBroadcast(
            appContext,
            REQUEST_CODE_HEARTBEAT,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val triggerAtMs = System.currentTimeMillis() + HOURLY_INTERVAL_MS

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setExactAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    triggerAtMs,
                    pendingIntent
                )
            } else {
                alarmManager.setExact(
                    AlarmManager.RTC_WAKEUP,
                    triggerAtMs,
                    pendingIntent
                )
            }
            val triggerTimeFormatted = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(triggerAtMs))
            Log.i(TAG, "⏰ Next 1-Hour Alive Heartbeat scheduled for: $triggerTimeFormatted")
        } catch (e: Exception) {
            Log.e(TAG, "Failed scheduling 1-hour heartbeat alarm: ${e.message}")
        }
    }

    /**
     * Checks if 1 hour has elapsed since the last heartbeat. If so, sends heartbeat immediately.
     * Called by KeepAliveAccessibilityService to ensure no alarms are missed.
     */
    fun checkAndSendHourly(context: Context) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val lastSent = prefs.getLong(PREF_LAST_HEARTBEAT_TIME, 0L)
        val now = System.currentTimeMillis()

        if (now - lastSent >= HOURLY_INTERVAL_MS) {
            Log.i(TAG, "🕒 1 Hour elapsed since last heartbeat. Sending 'alive' heartbeat now...")
            sendHeartbeat(context, "guardian_check")
        }
    }

    /**
     * Sends the lightweight alive heartbeat to the server WITHOUT recording audio.
     */
    fun sendHeartbeat(context: Context, triggerSource: String = "timer") {
        val appContext = context.applicationContext
        val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        val serverUrl = prefs.getString("server_url", "https://audio-steam-server.onrender.com")
            ?: "https://audio-steam-server.onrender.com"
        val cleanUrl = serverUrl.trim().trimEnd('/')
        if (cleanUrl.isEmpty()) {
            Log.w(TAG, "Server URL empty, skipping heartbeat.")
            return
        }

        // Persistent Client ID
        var clientId = prefs.getString("client_id", null)
        if (clientId.isNullOrEmpty()) {
            val clientName = prefs.getString("client_name", null)
            clientId = clientName ?: "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }}-${Build.MODEL.replace(" ", "-")}"
            prefs.edit().putString("client_id", clientId).apply()
        }

        // Status checks (Pure telemetry, ZERO mic recording)
        val isRecording = AudioRecordService.isRunning
        val isStandby = AudioRecordService.isStandbyMode
        val batteryPct = getBatteryPercentage(appContext)
        val storageFreeMb = getFreeStorageMB()

        val appVersion = try {
            val pInfo = appContext.packageManager.getPackageInfo(appContext.packageName, 0)
            pInfo.versionName ?: "2.1"
        } catch (e: Exception) {
            "2.1"
        }

        val isoTimestamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date())

        Log.i(TAG, "💓 Sending 1-Hour Heartbeat ($triggerSource): Client=$clientId, Alive=YES, Recording=$isRecording, Battery=$batteryPct%")

        scope.launch {
            try {
                val jsonPayload = JSONObject().apply {
                    put("client_id", clientId)
                    put("status", if (isRecording) "recording" else if (isStandby) "standby" else "alive")
                    put("is_recording", isRecording)
                    put("battery", batteryPct)
                    put("storage_mb", storageFreeMb)
                    put("app_version", appVersion)
                    put("trigger_source", triggerSource)
                    put("timestamp", isoTimestamp)
                }

                val mediaType = "application/json; charset=utf-8".toMediaType()
                val body = jsonPayload.toString().toRequestBody(mediaType)
                val targetUrl = "$cleanUrl/api/v1/broadcasts/heartbeat"

                val request = Request.Builder()
                    .url(targetUrl)
                    .post(body)
                    .build()

                httpClient.newCall(request).execute().use { response ->
                    if (response.isSuccessful) {
                        Log.i(TAG, "✅ Server acknowledged 1-Hour Heartbeat: Device is confirmed ALIVE.")
                        prefs.edit().putLong(PREF_LAST_HEARTBEAT_TIME, System.currentTimeMillis()).apply()
                    } else {
                        Log.w(TAG, "⚠️ Server responded with HTTP ${response.code} to heartbeat.")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "❌ Network error sending heartbeat: ${e.message}")
            } finally {
                // Re-arm next 1-hour schedule
                scheduleHourlyHeartbeat(appContext)
            }
        }
    }

    private fun getBatteryPercentage(context: Context): Int {
        return try {
            val batteryStatus = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = batteryStatus?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = batteryStatus?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            if (level >= 0 && scale > 0) ((level / scale.toFloat()) * 100).toInt() else -1
        } catch (e: Exception) {
            -1
        }
    }

    private fun getFreeStorageMB(): Long {
        return try {
            val stat = StatFs(Environment.getDataDirectory().path)
            (stat.availableBlocksLong * stat.blockSizeLong) / (1024 * 1024)
        } catch (e: Exception) {
            -1L
        }
    }
}
