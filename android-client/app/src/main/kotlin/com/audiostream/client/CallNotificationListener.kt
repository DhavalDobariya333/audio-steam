package com.audiostream.client

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

/**
 * CallNotificationListener.kt — Universal call & microphone app detector.
 *
 * Dynamically detects active calls across ANY application (Cellular dialer, WhatsApp,
 * Instagram, Telegram, Zoom, Google Meet, Discord, Skype, Voice Recorders, etc.)
 * by inspecting ongoing call notifications.
 */
class CallNotificationListener : NotificationListenerService() {

    companion object {
        private const val TAG = "CallNotifListener"

        @Volatile
        var isConnected: Boolean = false
            private set

        @Volatile
        var activeCallApp: String? = null
            private set

        @Volatile
        var activeCallPkg: String? = null
            private set

        private val activeCallMap = java.util.concurrent.ConcurrentHashMap<String, String>()

        /**
         * Check if Notification Access is granted by user in Android Settings.
         */
        fun isNotificationAccessGranted(context: Context): Boolean {
            val packageName = context.packageName
            val flat = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
            return flat?.contains(packageName) == true
        }

        /**
         * Returns short alphanumeric code for chunk names:
         * e.g. "AWA", "AIG", "ATG", "ACELL", "AZOOM", "AMEET", or dynamic "AXYZ"
         */
        fun getActiveCallCode(): String {
            val pkg = activeCallPkg ?: return "AIDLE"
            val app = activeCallApp ?: return "AIDLE"

            return when {
                pkg.contains("whatsapp", ignoreCase = true) -> "AWA"
                pkg.contains("instagram", ignoreCase = true) -> "AIG"
                pkg.contains("telegram", ignoreCase = true) -> "ATG"
                pkg.contains("zoom", ignoreCase = true) -> "AZOOM"
                pkg.contains("tachyon", ignoreCase = true) || app.contains("meet", ignoreCase = true) -> "AMEET"
                pkg.contains("skype", ignoreCase = true) -> "ASKYPE"
                pkg.contains("discord", ignoreCase = true) -> "ADISC"
                pkg.contains("orca", ignoreCase = true) || app.contains("messenger", ignoreCase = true) -> "AFB"
                pkg.contains("dialer", ignoreCase = true) ||
                pkg.contains("telecom", ignoreCase = true) ||
                pkg.contains("incallui", ignoreCase = true) ||
                pkg.contains("phone", ignoreCase = true) -> "ACELL"
                else -> {
                    // Universal fallback: "A" + first 4 alphanumeric characters of app label
                    val clean = app.filter { it.isLetterOrDigit() }.uppercase()
                    if (clean.isNotEmpty()) "A" + clean.take(4) else "AVOIP"
                }
            }
        }
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        isConnected = true
        Log.i(TAG, "✓ CallNotificationListener connected to Android notification stream")
        scanActiveNotifications()
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        isConnected = false
        activeCallMap.clear()
        activeCallApp = null
        activeCallPkg = null
        Log.i(TAG, "CallNotificationListener disconnected")
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        super.onNotificationPosted(sbn)
        if (sbn == null) return
        processNotification(sbn, isPosted = true)
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        super.onNotificationRemoved(sbn)
        if (sbn == null) return
        processNotification(sbn, isPosted = false)
    }

    private fun processNotification(sbn: StatusBarNotification, isPosted: Boolean) {
        val key = sbn.key ?: "${sbn.packageName}_${sbn.id}"
        val pkg = sbn.packageName ?: return

        // Skip our own audio stream app notifications
        if (pkg == applicationContext.packageName) return

        if (!isPosted) {
            if (activeCallMap.remove(key) != null) {
                updateTopActiveCall()
            }
            return
        }

        // Determine if notification represents a call or live mic capture
        val n = sbn.notification ?: return
        val category = n.category
        val isCallCategory = category == Notification.CATEGORY_CALL ||
                (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && category == Notification.CATEGORY_CALL)
        
        val extras = n.extras
        val title = extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        val text = extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""
        val subText = extras?.getCharSequence(Notification.EXTRA_SUB_TEXT)?.toString() ?: ""
        val combinedText = "$title $text $subText".lowercase()

        val hasCallKeyword = combinedText.contains("call") ||
                combinedText.contains("ringing") ||
                combinedText.contains("ongoing") ||
                combinedText.contains("meeting") ||
                combinedText.contains("in progress")

        val isOngoing = (n.flags and Notification.FLAG_ONGOING_EVENT) != 0

        if ((isCallCategory || hasCallKeyword) && isOngoing) {
            val appLabel = try {
                val appInfo = packageManager.getApplicationInfo(pkg, 0)
                packageManager.getApplicationLabel(appInfo).toString()
            } catch (e: Exception) {
                pkg
            }

            activeCallMap[key] = "$pkg|$appLabel"
            Log.d(TAG, "Active call/mic app detected: $appLabel ($pkg)")
            updateTopActiveCall()
        }
    }

    private fun updateTopActiveCall() {
        val latest = activeCallMap.values.lastOrNull()
        if (latest != null) {
            val parts = latest.split("|", limit = 2)
            activeCallPkg = parts.getOrNull(0)
            activeCallApp = parts.getOrNull(1) ?: parts.getOrNull(0)
        } else {
            activeCallPkg = null
            activeCallApp = null
        }
    }

    private fun scanActiveNotifications() {
        try {
            val active = activeNotifications ?: return
            for (sbn in active) {
                processNotification(sbn, isPosted = true)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error scanning active notifications: ${e.message}")
        }
    }
}
