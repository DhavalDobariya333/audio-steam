package com.audiostream.client

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * ConnectionMonitor.kt — Network and server availability monitor.
 *
 * Monitors three layers of connectivity:
 *   1. Network (Android ConnectivityManager — WiFi/mobile data)
 *   2. Internet (DNS resolution, actual connectivity)
 *   3. Server (HTTP health check to the FastAPI server)
 *
 * Implements a connection state machine:
 *   IDLE → CONNECTING → CONNECTED → UPLOADING / RECORDING
 *   DISCONNECTED → RECONNECTING → WAITING → CONNECTING
 *   ERROR → RECONNECTING
 *   STOPPED
 *
 * Broadcasts state changes so the UI and UploadManager can react.
 */

enum class ConnectionState {
    IDLE,
    CONNECTING,
    CONNECTED,
    DISCONNECTED,
    RECONNECTING,
    WAITING,
    ERROR,
    STOPPED
}

class ConnectionMonitor(
    private val context: Context,
    private val serverUrl: String,  // Base URL like "https://example.com"
    private val onStateChange: (ConnectionState) -> Unit,
    private val onLog: (String) -> Unit
) {
    companion object {
        private const val HEARTBEAT_INTERVAL_MS = 30_000L  // 30 seconds
        private const val HEALTH_TIMEOUT_MS = 10_000L      // 10 second timeout
    }

    // Current state
    private val currentState = AtomicReference(ConnectionState.IDLE)
    val state: ConnectionState get() = currentState.get()

    // Network availability flag
    private val hasNetwork = AtomicBoolean(false)
    private val serverReachable = AtomicBoolean(false)

    // Components
    private val handler = Handler(Looper.getMainLooper())
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(HEALTH_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .readTimeout(HEALTH_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .build()

    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var heartbeatRunnable: Runnable? = null
    private var isMonitoring = false

    // ══════════════════════════════════════════════════════════════════════
    // STATE MACHINE
    // ══════════════════════════════════════════════════════════════════════

    private fun transition(newState: ConnectionState) {
        val old = currentState.getAndSet(newState)
        if (old != newState) {
            onLog("State: $old → $newState")
            handler.post { onStateChange(newState) }
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // START / STOP
    // ══════════════════════════════════════════════════════════════════════

    fun start() {
        if (isMonitoring) return
        isMonitoring = true
        transition(ConnectionState.CONNECTING)

        // Register network callback
        registerNetworkCallback()

        // Start heartbeat loop
        startHeartbeat()

        // Initial check
        checkNetworkNow()
    }

    fun stop() {
        isMonitoring = false
        transition(ConnectionState.STOPPED)

        // Unregister network callback
        unregisterNetworkCallback()

        // Stop heartbeat
        heartbeatRunnable?.let { handler.removeCallbacks(it) }
        heartbeatRunnable = null
    }

    // ══════════════════════════════════════════════════════════════════════
    // NETWORK MONITORING (Layer 1: Android connectivity)
    // ══════════════════════════════════════════════════════════════════════

    private fun registerNetworkCallback() {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                hasNetwork.set(true)
                onLog("Network available")
                if (currentState.get() == ConnectionState.DISCONNECTED ||
                    currentState.get() == ConnectionState.WAITING) {
                    transition(ConnectionState.RECONNECTING)
                    // Trigger immediate server check
                    checkServerAsync()
                }
            }

            override fun onLost(network: Network) {
                // Check if ANY network is still available
                val active = cm.activeNetwork
                if (active == null) {
                    hasNetwork.set(false)
                    serverReachable.set(false)
                    onLog("Network lost")
                    transition(ConnectionState.DISCONNECTED)
                }
            }

            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                val hasInternet = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                val validated = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                if (hasInternet && validated && !serverReachable.get()) {
                    checkServerAsync()
                }
            }
        }

        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()

        try {
            cm.registerNetworkCallback(request, callback)
            networkCallback = callback
        } catch (e: Exception) {
            onLog("Failed to register network callback: ${e.message}")
        }
    }

    private fun unregisterNetworkCallback() {
        networkCallback?.let { cb ->
            try {
                val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
                cm.unregisterNetworkCallback(cb)
            } catch (e: Exception) {
                // Ignore — may already be unregistered
            }
        }
        networkCallback = null
    }

    private fun checkNetworkNow() {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        hasNetwork.set(
            caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        )

        if (hasNetwork.get()) {
            checkServerAsync()
        } else {
            transition(ConnectionState.DISCONNECTED)
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // SERVER HEALTH CHECK (Layer 2: Server availability)
    // ══════════════════════════════════════════════════════════════════════

    private fun checkServerAsync() {
        Thread {
            checkServer()
        }.start()
    }

    /**
     * Ping the server's health endpoint.
     * Called from background thread.
     */
    fun checkServer(): Boolean {
        if (!isMonitoring) return false

        return try {
            val healthUrl = serverUrl.trimEnd('/') + "/api/v1/health"
            val request = Request.Builder()
                .url(healthUrl)
                .get()
                .build()

            val response = httpClient.newCall(request).execute()
            val reachable = response.isSuccessful
            response.close()

            serverReachable.set(reachable)

            if (reachable) {
                if (currentState.get() != ConnectionState.CONNECTED) {
                    transition(ConnectionState.CONNECTED)
                    onLog("Server reachable")
                }
            } else {
                serverReachable.set(false)
                if (currentState.get() == ConnectionState.CONNECTED) {
                    transition(ConnectionState.DISCONNECTED)
                    onLog("Server returned error")
                }
            }
            reachable
        } catch (e: Exception) {
            serverReachable.set(false)
            if (currentState.get() == ConnectionState.CONNECTED) {
                transition(ConnectionState.DISCONNECTED)
                onLog("Server unreachable: ${e.message}")
            } else if (currentState.get() == ConnectionState.CONNECTING ||
                       currentState.get() == ConnectionState.RECONNECTING) {
                transition(ConnectionState.WAITING)
            }
            false
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // HEARTBEAT
    // ══════════════════════════════════════════════════════════════════════

    private fun startHeartbeat() {
        heartbeatRunnable = object : Runnable {
            override fun run() {
                if (!isMonitoring) return
                Thread {
                    checkServer()
                }.start()
                handler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
            }
        }
        handler.postDelayed(heartbeatRunnable!!, HEARTBEAT_INTERVAL_MS)
    }

    // ══════════════════════════════════════════════════════════════════════
    // PUBLIC QUERIES
    // ══════════════════════════════════════════════════════════════════════

    fun isNetworkAvailable(): Boolean = hasNetwork.get()
    fun isServerReachable(): Boolean = serverReachable.get()
    fun isConnected(): Boolean = currentState.get() == ConnectionState.CONNECTED
}
