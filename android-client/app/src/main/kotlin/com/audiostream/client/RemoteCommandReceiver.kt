package com.audiostream.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * RemoteCommandReceiver.kt
 *
 * Listens for explicit broadcast intents to remotely start or stop the AudioRecordService.
 *
 * ADB Usage:
 * Start: adb shell am broadcast -a com.audiostream.client.REMOTE_START --es server_url "http://192.168.1.5:8765"
 * Stop:  adb shell am broadcast -a com.audiostream.client.REMOTE_STOP
 */
class RemoteCommandReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_REMOTE_START = "com.audiostream.client.REMOTE_START"
        const val ACTION_REMOTE_STOP = "com.audiostream.client.REMOTE_STOP"
        private const val TAG = "RemoteCommandReceiver"
    }

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent == null) return

        when (intent.action) {
            ACTION_REMOTE_START -> {
                val serverUrl = intent.getStringExtra("server_url")
                if (serverUrl.isNullOrEmpty()) {
                    Log.e(TAG, "REMOTE_START received but missing 'server_url' extra")
                    return
                }
                
                Log.i(TAG, "Received REMOTE_START for url: $serverUrl")
                
                // Save URL to prefs so it auto-restarts correctly
                val prefs = context.getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)
                prefs.edit().putString("server_url", serverUrl).putBoolean("was_running", true).apply()

                val serviceIntent = Intent(context, AudioRecordService::class.java).apply {
                    action = AudioRecordService.ACTION_START
                    putExtra(AudioRecordService.EXTRA_SERVER_URL, serverUrl)
                }
                ContextCompat.startForegroundService(context, serviceIntent)
            }
            ACTION_REMOTE_STOP -> {
                Log.i(TAG, "Received REMOTE_STOP")
                val prefs = context.getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)
                prefs.edit().putBoolean("was_running", false).apply()

                val serviceIntent = Intent(context, AudioRecordService::class.java).apply {
                    action = AudioRecordService.ACTION_STOP
                }
                ContextCompat.startForegroundService(context, serviceIntent)
            }
        }
    }
}
