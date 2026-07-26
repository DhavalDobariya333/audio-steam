package com.audiostream.client

import android.content.Context
import androidx.room.*

/**
 * ChunkDatabase.kt — Room database for persistent upload queue.
 *
 * This is the backbone of the "zero audio loss" guarantee. Every recorded
 * audio chunk is inserted here BEFORE the upload attempt. The entry is
 * only removed AFTER the server confirms receipt. This means:
 *
 *   - App restart: queue is preserved (Room uses SQLite on disk)
 *   - Phone reboot: queue is preserved
 *   - Upload failure: chunk stays in queue for retry
 *   - Duplicate protection: UUID is generated at recording time
 *
 * Upload Status Flow:
 *   PENDING → UPLOADING → COMPLETED (or back to PENDING on failure)
 */

// ══════════════════════════════════════════════════════════════════════════════
// ENTITY
// ══════════════════════════════════════════════════════════════════════════════

@Entity(tableName = "audio_chunks")
data class AudioChunk(
    @PrimaryKey
    val uuid: String,

    @ColumnInfo(name = "file_path")
    val filePath: String,

    @ColumnInfo(name = "timestamp")
    val timestamp: String,          // ISO 8601 format

    @ColumnInfo(name = "duration")
    val duration: Double,           // Seconds

    @ColumnInfo(name = "file_size")
    val fileSize: Long,             // Bytes

    @ColumnInfo(name = "checksum")
    val checksum: String,           // SHA-256

    @ColumnInfo(name = "upload_status")
    val uploadStatus: String = "PENDING",   // PENDING, UPLOADING, COMPLETED, FAILED

    @ColumnInfo(name = "retry_count")
    val retryCount: Int = 0,

    @ColumnInfo(name = "created_at")
    val createdAt: Long = System.currentTimeMillis(),

    @ColumnInfo(name = "last_attempt_at")
    val lastAttemptAt: Long = 0,

    @ColumnInfo(name = "in_call")
    val inCall: Boolean = false,

    @ColumnInfo(name = "mic_in_use")
    val micInUse: Boolean = false
)


// ══════════════════════════════════════════════════════════════════════════════
// DAO
// ══════════════════════════════════════════════════════════════════════════════

@Dao
interface ChunkDao {

    /** Insert a new chunk (after recording finishes). */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(chunk: AudioChunk): Long

    /** Get the next chunk to upload (FIFO — oldest first, PENDING only). */
    @Query("""
        SELECT * FROM audio_chunks 
        WHERE upload_status IN ('PENDING', 'FAILED')
        ORDER BY created_at ASC 
        LIMIT 1
    """)
    suspend fun getNextPending(): AudioChunk?

    /** Mark a chunk as currently being uploaded. */
    @Query("UPDATE audio_chunks SET upload_status = 'UPLOADING', last_attempt_at = :now WHERE uuid = :uuid")
    suspend fun markUploading(uuid: String, now: Long = System.currentTimeMillis())

    /** Mark a chunk as successfully uploaded. */
    @Query("UPDATE audio_chunks SET upload_status = 'COMPLETED' WHERE uuid = :uuid")
    suspend fun markCompleted(uuid: String)

    /** Mark a chunk as failed (increment retry count, reset to PENDING for retry). */
    @Query("""
        UPDATE audio_chunks 
        SET upload_status = 'PENDING', 
            retry_count = retry_count + 1,
            last_attempt_at = :now
        WHERE uuid = :uuid
    """)
    suspend fun markFailed(uuid: String, now: Long = System.currentTimeMillis())

    /** Get count of pending/failed chunks (for UI display). */
    @Query("SELECT COUNT(*) FROM audio_chunks WHERE upload_status IN ('PENDING', 'FAILED', 'UPLOADING')")
    suspend fun getPendingCount(): Int

    /** Get total retry count across all chunks (for UI). */
    @Query("SELECT COALESCE(SUM(retry_count), 0) FROM audio_chunks WHERE upload_status != 'COMPLETED'")
    suspend fun getTotalRetryCount(): Int

    /** Get all completed chunks (for cleanup). */
    @Query("SELECT * FROM audio_chunks WHERE upload_status = 'COMPLETED'")
    suspend fun getCompleted(): List<AudioChunk>

    /** Delete a chunk record. */
    @Query("DELETE FROM audio_chunks WHERE uuid = :uuid")
    suspend fun delete(uuid: String)

    /** Delete all completed chunks. */
    @Query("DELETE FROM audio_chunks WHERE upload_status = 'COMPLETED'")
    suspend fun deleteAllCompleted(): Int

    /** Get all chunks (for debugging). */
    @Query("SELECT * FROM audio_chunks ORDER BY created_at ASC")
    suspend fun getAll(): List<AudioChunk>

    /** Reset any stuck UPLOADING chunks back to PENDING (after app restart). */
    @Query("UPDATE audio_chunks SET upload_status = 'PENDING' WHERE upload_status = 'UPLOADING'")
    suspend fun resetStuckUploads(): Int
}


// ══════════════════════════════════════════════════════════════════════════════
// DATABASE
// ══════════════════════════════════════════════════════════════════════════════

@Database(entities = [AudioChunk::class], version = 2, exportSchema = false)
abstract class ChunkDatabase : RoomDatabase() {
    abstract fun chunkDao(): ChunkDao

    companion object {
        @Volatile
        private var INSTANCE: ChunkDatabase? = null

        fun getInstance(context: Context): ChunkDatabase {
            return INSTANCE ?: synchronized(this) {
                val instance = Room.databaseBuilder(
                    context.applicationContext,
                    ChunkDatabase::class.java,
                    "audio_chunks.db"
                )
                .fallbackToDestructiveMigration()
                .build()
                INSTANCE = instance
                instance
            }
        }
    }
}
