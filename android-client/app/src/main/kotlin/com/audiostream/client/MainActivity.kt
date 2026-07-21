package com.audiostream.client

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var etServerUrl: EditText
    private lateinit var tvStatus: TextView
    private lateinit var vStatusDot: View
    private lateinit var btnConnect: Button
    private lateinit var btnDisconnect: Button
    private lateinit var tvLog: TextView
    
    private lateinit var prefs: SharedPreferences

    // Receive broadcast updates from the background service
    private val serviceReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                AudioStreamService.ACTION_STATE_CHANGED -> {
                    val isConnected = intent.getBooleanExtra(AudioStreamService.EXTRA_IS_CONNECTED, false)
                    updateUiState(isConnected)
                }
                AudioStreamService.ACTION_LOG_EVENT -> {
                    val message = intent.getStringExtra(AudioStreamService.EXTRA_MESSAGE)
                    if (message != null) appendLog(message)
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Initialize UI components
        etServerUrl = findViewById(R.id.etServerUrl)
        tvStatus = findViewById(R.id.tvStatus)
        vStatusDot = findViewById(R.id.vStatusDot)
        btnConnect = findViewById(R.id.btnConnect)
        btnDisconnect = findViewById(R.id.btnDisconnect)
        tvLog = findViewById(R.id.tvLog)

        // Load saved URL
        prefs = getSharedPreferences("AudioStreamPrefs", Context.MODE_PRIVATE)
        val savedUrl = prefs.getString("server_url", "ws://192.168.1.100:8765/ws/stream")
        etServerUrl.setText(savedUrl)

        // Button clicks
        btnConnect.setOnClickListener { startStreaming() }
        btnDisconnect.setOnClickListener { stopStreaming() }
        
        // Register receiver for service updates
        val filter = IntentFilter().apply {
            addAction(AudioStreamService.ACTION_STATE_CHANGED)
            addAction(AudioStreamService.ACTION_LOG_EVENT)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(serviceReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(serviceReceiver, filter)
        }
        
        // Check initial state
        updateUiState(AudioStreamService.isRunning)
    }

    override fun onDestroy() {
        super.onDestroy()
        unregisterReceiver(serviceReceiver)
    }

    private fun startStreaming() {
        val url = etServerUrl.text.toString().trim()
        if (url.isEmpty()) {
            Toast.makeText(this, "Please enter a Server URL", Toast.LENGTH_SHORT).show()
            return
        }

        // Save URL for next time
        prefs.edit().putString("server_url", url).apply()

        // Check required permissions
        val requiredPermissions = mutableListOf(Manifest.permission.RECORD_AUDIO)
        
        // Android 13+ requires POST_NOTIFICATIONS for foreground services
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requiredPermissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        val missingPermissions = requiredPermissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (missingPermissions.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missingPermissions.toTypedArray(), 100)
            return
        }

        // Permissions granted, start the service
        val intent = Intent(this, AudioStreamService::class.java).apply {
            action = AudioStreamService.ACTION_START
            putExtra("url", url)
        }
        ContextCompat.startForegroundService(this, intent)
    }

    private fun stopStreaming() {
        val intent = Intent(this, AudioStreamService::class.java).apply {
            action = AudioStreamService.ACTION_STOP
        }
        startService(intent) // stopService doesn't work well with foreground services, better to send an intent
    }

    private fun updateUiState(isConnected: Boolean) {
        if (isConnected) {
            tvStatus.text = "Streaming Active"
            tvStatus.setTextColor(android.graphics.Color.parseColor("#4CAF50"))
            vStatusDot.setBackgroundColor(android.graphics.Color.parseColor("#4CAF50"))
            btnConnect.visibility = View.GONE
            btnDisconnect.visibility = View.VISIBLE
            etServerUrl.isEnabled = false
        } else {
            tvStatus.text = "Disconnected"
            tvStatus.setTextColor(android.graphics.Color.parseColor("#F44336"))
            vStatusDot.setBackgroundColor(android.graphics.Color.parseColor("#F44336"))
            btnConnect.visibility = View.VISIBLE
            btnDisconnect.visibility = View.GONE
            etServerUrl.isEnabled = true
        }
    }

    private fun appendLog(message: String) {
        val time = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        val currentText = tvLog.text.toString()
        val newText = "[$time] $message\n$currentText"
        
        // Keep log size manageable
        if (newText.length > 5000) {
            tvLog.text = newText.substring(0, 5000)
        } else {
            tvLog.text = newText
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 100) {
            if (grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }) {
                startStreaming()
            } else {
                Toast.makeText(this, "Permissions required to stream audio", Toast.LENGTH_LONG).show()
                appendLog("ERROR: Permissions denied by user")
            }
        }
    }
}
