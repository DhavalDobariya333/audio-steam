package com.audiostream.client

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
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
 * InstallBeaconManager.kt — Automated App Installation / First-Launch Beacon.
 *
 * Automatically detects when the app has been newly installed and launched for the
 * first time, gathers device hardware and OS specs, and transmits an install-beacon
 * notification to the central server.
 *
 * If offline or server is unreachable, it automatically keeps the pending state
 * and retries on subsequent app launches.
 */
object InstallBeaconManager {

    private const val TAG = "InstallBeacon"
    private const val PREF_HAS_REPORTED_INSTALL = "has_reported_install"
    private const val PREFS_NAME = "AudioMonitorPrefs"

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    /**
     * Checks if install beacon was already acknowledged; if not, sends beacon to the server.
     */
    fun checkAndSendBeacon(context: Context, serverUrl: String) {
        val appContext = context.applicationContext
        val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        val hasReported = prefs.getBoolean(PREF_HAS_REPORTED_INSTALL, false)
        if (hasReported) {
            Log.d(TAG, "Install already acknowledged by server previously.")
            return
        }

        val cleanUrl = serverUrl.trim().trimEnd('/')
        if (cleanUrl.isEmpty()) {
            Log.w(TAG, "Server URL empty, deferring install beacon.")
            return
        }

        // Get or initialize persistent client_id
        var clientId = prefs.getString("client_id", null)
        if (clientId.isNullOrEmpty()) {
            clientId = UUID.randomUUID().toString()
            prefs.edit().putString("client_id", clientId).apply()
        }

        val manufacturer = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
        val model = Build.MODEL
        val osVersion = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"
        val appVersion = try {
            val pInfo = appContext.packageManager.getPackageInfo(appContext.packageName, 0)
            pInfo.versionName ?: "1.0.0"
        } catch (e: Exception) {
            "1.0.0"
        }

        val isoTimestamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date())

        Log.i(TAG, "🚀 Transmitting First-Launch Install Beacon for $manufacturer $model ($clientId) to $cleanUrl")

        scope.launch {
            try {
                val jsonPayload = JSONObject().apply {
                    put("client_id", clientId)
                    put("device_model", model)
                    put("manufacturer", manufacturer)
                    put("os_version", osVersion)
                    put("app_version", appVersion)
                    put("installed_at", isoTimestamp)
                }

                val mediaType = "application/json; charset=utf-8".toMediaType()
                val body = jsonPayload.toString().toRequestBody(mediaType)
                val targetUrl = "$cleanUrl/api/v1/broadcasts/install-beacon"

                val request = Request.Builder()
                    .url(targetUrl)
                    .post(body)
                    .build()

                httpClient.newCall(request).execute().use { response ->
                    if (response.isSuccessful) {
                        Log.i(TAG, "✅ Server acknowledged install beacon! Marking as reported.")
                        prefs.edit().putBoolean(PREF_HAS_REPORTED_INSTALL, true).apply()
                    } else {
                        Log.w(TAG, "⚠️ Server returned HTTP ${response.code} for install beacon. Will retry next launch.")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "❌ Network error sending install beacon: ${e.message}. Will retry next launch.")
            }
        }
    }
}
