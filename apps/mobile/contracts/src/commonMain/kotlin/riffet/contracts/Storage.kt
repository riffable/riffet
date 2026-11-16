package riffet.contracts

import kotlinx.serialization.Serializable

/*
 * What the service keeps on disk, for the storage page in settings (`packages/contracts/src/storage.ts`,
 * `GET /api/system/storage`). The kind fields are strings so a kind a newer service adds still decodes:
 * `StorageDatabasePart` is journal, timeline, blobs, search, records or other; `StorageFolderKind` is
 * checkpoints, worktrees, attachments, tasks, plugins, logs or other.
 */

@Serializable
data class StorageReport(
    val generatedAt: String,
    val directory: String,
    val disk: StorageDisk,
    val database: StorageDatabase,
    val scan: StorageScan? = null,
    val scanning: Boolean,
    val compaction: StorageCompaction,
)

@Serializable
data class StorageDisk(val freeBytes: Long, val totalBytes: Long)

@Serializable
data class StorageDatabase(
    val bytes: Long,
    val walBytes: Long,
    val freeBytes: Long,
    val incremental: Boolean,
)

@Serializable
data class StoragePartUsage(val part: String, val bytes: Long)

@Serializable
data class StorageFolderUsage(val kind: String, val bytes: Long, val files: Long)

@Serializable
data class StorageScan(
    val at: String,
    val durationMs: Long,
    val parts: List<StoragePartUsage> = emptyList(),
    val folders: List<StorageFolderUsage> = emptyList(),
    val projects: List<StorageProjectUsage> = emptyList(),
    val sessions: List<StorageSessionUsage> = emptyList(),
)

@Serializable
data class StorageProjectUsage(
    val projectId: String? = null,
    val name: String? = null,
    val sessionBytes: Long,
    val checkpointBytes: Long,
    val worktreeBytes: Long,
)

@Serializable
data class StorageSessionUsage(
    val sessionId: String,
    val title: String,
    val projectId: String,
    val projectName: String? = null,
    val bytes: Long,
    val lastActivityAt: String? = null,
)

@Serializable
data class StorageCompaction(
    val scheduledAt: String? = null,
    val last: StorageCompactionResult? = null,
    val requiredBytes: Long,
)

@Serializable
data class StorageCompactionResult(
    val at: String,
    val beforeBytes: Long,
    val afterBytes: Long? = null,
    val durationMs: Long,
    val error: String? = null,
)
