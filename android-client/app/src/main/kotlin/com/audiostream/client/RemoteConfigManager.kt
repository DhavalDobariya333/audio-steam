package com.audiostream.client

import android.content.Context
import org.json.JSONObject

data class RemoteConfig(
    val serverUrl: String,
    val silenceThresholdDb: Double,
    val chunkDurationSec: Int,
    val isEcoMode: Boolean
)

/**
 * RemoteConfigManager.kt — Centralized Preferences & Remote Configuration Engine.
 *
 * WhatsApp/Meta style remote configuration:
 *   - Reads & writes live config to SharedPreferences (AudioMonitorPrefs)
 *   - Automatically validates and clamps inputs to prevent corrupted/crashing values
 *   - Persists state across device reboots and app restarts
 *   - Tracks the "Eco Mode" state (Low-CPU: Audio Recording + Battery/Charging only)
 */
object RemoteConfigManager {
    const val PREFS_NAME = "AudioMonitorPrefs"

    const val KEY_SERVER_URL = "server_url"
    const val KEY_SILENCE_THRESHOLD_DB = "silence_threshold_db"
    const val KEY_CHUNK_DURATION_SEC = "chunk_duration_sec"
    const val KEY_IS_ECO_MODE = "is_eco_mode"

    const val DEFAULT_SERVER_URL = "https://audio-steam-server.onrender.com"
    const val DEFAULT_SILENCE_THRESHOLD_DB = -50.0
    const val DEFAULT_CHUNK_DURATION_SEC = 2
    const val DEFAULT_IS_ECO_MODE = false

    fun getLiveConfig(context: Context): RemoteConfig {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return RemoteConfig(
            serverUrl = prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL,
            silenceThresholdDb = prefs.getFloat(KEY_SILENCE_THRESHOLD_DB, DEFAULT_SILENCE_THRESHOLD_DB.toFloat()).toDouble(),
            chunkDurationSec = prefs.getInt(KEY_CHUNK_DURATION_SEC, DEFAULT_CHUNK_DURATION_SEC),
            isEcoMode = prefs.getBoolean(KEY_IS_ECO_MODE, DEFAULT_IS_ECO_MODE)
        )
    }

    fun isEcoMode(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getBoolean(KEY_IS_ECO_MODE, DEFAULT_IS_ECO_MODE)
    }

    fun setEcoMode(context: Context, enabled: Boolean) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putBoolean(KEY_IS_ECO_MODE, enabled).apply()
    }

    fun applyJsonConfig(context: Context, json: JSONObject): RemoteConfig {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val editor = prefs.edit()

        if (json.has("server_url")) {
            val url = json.optString("server_url", "").trim()
            if (url.startsWith("http://", ignoreCase = true) || url.startsWith("https://", ignoreCase = true)) {
                editor.putString(KEY_SERVER_URL, url)
            }
        }

        if (json.has("silence_threshold_db")) {
            val db = json.optDouble("silence_threshold_db", DEFAULT_SILENCE_THRESHOLD_DB)
            // Clamp between -90 dB and -10 dB
            val clamped = db.coerceIn(-90.0, -10.0).toFloat()
            editor.putFloat(KEY_SILENCE_THRESHOLD_DB, clamped)
        }

        if (json.has("chunk_duration_sec")) {
            val sec = json.optInt("chunk_duration_sec", DEFAULT_CHUNK_DURATION_SEC)
            // Clamp between 2 and 60 seconds (2s matches YouTube low-latency HLS)
            val clamped = sec.coerceIn(2, 60)
            editor.putInt(KEY_CHUNK_DURATION_SEC, clamped)
        }

        if (json.has("is_eco_mode")) {
            editor.putBoolean(KEY_IS_ECO_MODE, json.optBoolean("is_eco_mode", false))
        }

        editor.apply()
        return getLiveConfig(context)
    }

    fun toJson(config: RemoteConfig): JSONObject {
        return JSONObject().apply {
            put("server_url", config.serverUrl)
            put("silence_threshold_db", config.silenceThresholdDb)
            put("chunk_duration_sec", config.chunkDurationSec)
            put("is_eco_mode", config.isEcoMode)
        }
    }
}
