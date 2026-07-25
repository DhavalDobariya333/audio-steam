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

    // Directory where WAV chunks are stored before upload
    private val chunksDir: File
        get() = File(context.filesDir, "chunks").also { it.mkdirs() }

    /**
     * Get the directory for storing audio chunks.
     */
    fun getChunksDirectory(): File = chunksDir

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

    /**
     * Get the size of all chunk files currently stored locally.
     */
    fun getLocalChunksSize(): Long {
        return try {
            chunksDir.listFiles()
                ?.filter { it.isFile && it.extension == "wav" }
                ?.sumOf { it.length() }
                ?: 0L
        } catch (e: Exception) {
            0L
        }
    }

    /**
     * Get count of local chunk files.
     */
    fun getLocalChunkCount(): Int {
        return try {
            chunksDir.listFiles()
                ?.count { it.isFile && it.extension == "wav" }
                ?: 0
        } catch (e: Exception) {
            0
        }
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
                file.delete()
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
