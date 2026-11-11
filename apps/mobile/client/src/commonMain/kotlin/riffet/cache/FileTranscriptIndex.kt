package riffet.cache

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import riffet.contracts.RiffetJson

/**
 * Durable index using the existing device-files seam and search rules. Each session replaces one
 * atomic file; corruption is isolated and TranscriptCache.indexMissing rebuilds it from the log.
 * No raw provider records enter the index, only the same visible text used by the common timeline.
 */
class FileTranscriptIndex(private val files: LocalFiles, serverUrl: String) : TranscriptIndex {
    private val root = "search/${safeName(serverUrl.trimEnd('/').lowercase())}"
    // A replacement cache may still be waiting for the previous cache's final writes.
    // Defer reading these files until its first guarded index operation.
    private val memory by lazy {
        val loaded = MemoryTranscriptIndex()
        for (name in files.list(root)) {
            val stored = files.read("$root/$name")?.let { raw ->
                runCatching { RiffetJson.instance.decodeFromString<StoredIndex>(raw) }.getOrNull()
            } ?: continue
            loaded.replace(stored.sessionId, stored.entries.map { IndexEntry(it.sequence, it.role, it.text, it.createdAt) })
        }
        loaded
    }

    override fun replace(sessionId: String, entries: List<IndexEntry>) {
        if (entries.isEmpty()) return forget(sessionId)
        val current = memory
        val stored = StoredIndex(sessionId, entries.map { StoredEntry(it.sequence, it.role, it.text, it.createdAt) })
        files.write(path(sessionId), RiffetJson.instance.encodeToString(stored))
        current.replace(sessionId, entries)
    }

    override fun forget(sessionId: String) {
        val current = memory
        files.delete(path(sessionId))
        current.forget(sessionId)
    }

    override fun clear() {
        val current = memory
        files.deleteTree(root)
        current.clear()
    }

    override fun sessions(): Set<String> = memory.sessions()
    override fun search(query: String, limit: Int, sessionId: String?): List<IndexHit> = memory.search(query, limit, sessionId)
    override fun close() = memory.close()
    private fun path(sessionId: String) = "$root/${safeName(sessionId)}.json"
}

@Serializable
private data class StoredIndex(val sessionId: String, val entries: List<StoredEntry>)

@Serializable
private data class StoredEntry(val sequence: Long, val role: IndexRole, val text: String, val createdAt: String)
