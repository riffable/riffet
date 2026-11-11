package riffet.cache

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import riffet.contracts.AppSettings
import riffet.contracts.Project
import riffet.contracts.Session
import riffet.contracts.RiffetJson
import riffet.ui.timeline.platformNowMillis
import kotlin.coroutines.CoroutineContext

/** The project and session lists as last fetched, so a cold start can draw the sidebar at once. */
@Serializable
data class CachedList(
    val projects: List<Project>,
    val sessions: List<Session>,
    val settings: AppSettings? = null,
    val savedAt: Long,
)

/**
 * The device copy of one server's lists. Conversations have their own ([TimelineCache]); this is only
 * what the sidebar needs before the first read answers. Disposable like them: anything that does not
 * decode reads as nothing.
 */
class ListCache(
    private val files: LocalFiles,
    serverUrl: String,
    private val io: CoroutineContext = Dispatchers.IO,
    private val now: () -> Long = ::platformNowMillis,
) {
    private val path = "servers/${safeName(serverUrl.trimEnd('/').lowercase())}/list.json"
    private val mutex = Mutex()

    suspend fun loadList(): CachedList? = locked {
        files.read(path)?.let { text -> runCatching { RiffetJson.instance.decodeFromString<CachedList>(text) }.getOrNull() }
    }

    suspend fun saveList(projects: List<Project>, sessions: List<Session>, settings: AppSettings?) = locked {
        files.write(path, RiffetJson.instance.encodeToString(CachedList(projects, sessions, settings, now())))
    }

    suspend fun clear() = locked { files.delete(path) }

    private suspend fun <T> locked(block: () -> T): T = withContext(io) { mutex.withLock { block() } }
}

/** A readable, filesystem-safe name that still cannot collide: the sanitised text plus a hash. */
internal fun safeName(value: String): String {
    val readable = value.map { if (it.isLetterOrDigit() && it.code < 128) it else '_' }.joinToString("").take(48)
    var hash = 0xcbf29ce484222325uL
    for (byte in value.encodeToByteArray()) {
        hash = (hash xor byte.toUByte().toULong()) * 0x100000001b3uL
    }
    return "$readable-${hash.toString(16)}"
}
