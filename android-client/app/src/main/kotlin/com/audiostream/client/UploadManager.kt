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
    private val deviceInfo: String,
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
            uploadLoop()
        }
    }

    fun stop() {
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
                    // Nothing to upload — wait and check again
                    delay(1000)
                    continue
                }

                // Check if server is reachable
                if (!connectionMonitor.isServerReachable()) {
                    onLog("Server not reachable, waiting...")
                    delay(RETRY_INTERVAL_MS)
                    // Try to reach server
                    connectionMonitor.checkServer()
                    continue
                }

                // Attempt upload
                val success = uploadChunk(chunk)

                if (success) {
                    currentRetryCount.set(0)
                } else {
                    // Handle retry logic
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

    private fun ensureSession(): String? {
        if (activeSessionId != null) return activeSessionId
        return try {
            val createUrl = serverUrl.trimEnd('/') + "/api/v1/broadcasts"
            val jsonBody = JSONObject().apply {
                put("client_name", clientName)
                put("device_info", deviceInfo)
                put("title", "Live Stream - $clientName")
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
                    activeSessionId = sid
                    onLog("Session created on server: $sid")
                    sid
                } else null
            } else {
                onLog("Failed to create session (HTTP ${response.code})")
                null
            }
        } catch (e: Exception) {
            onLog("Session creation error: ${e.message}")
            null
        }
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

        val sessionId = ensureSession() ?: return false

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
                    file.asRequestBody("audio/wav".toMediaType())
                )
                .addFormDataPart("chunk_id", chunk.uuid)
                .addFormDataPart("duration_ms", (chunk.duration * 1000).toInt().toString())
                .addFormDataPart("checksum", chunk.checksum)
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

                        // Clean up completed DB entries periodically
                        val completed = dao.getCompleted()
                        if (completed.size > 100) {
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
        updateStats()
        onLog("Enqueued chunk: ${File(chunk.filePath).name}")
    }
}
