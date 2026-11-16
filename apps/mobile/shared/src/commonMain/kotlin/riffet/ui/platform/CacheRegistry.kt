package riffet.ui.platform

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/** One cache the process holds: what it holds now, its ceiling, and how to empty it. */
class RegisteredCache(
    val name: String,
    val limitBytes: Long,
    val sizeBytes: () -> Long,
    val clear: () -> Unit,
)

/**
 * Where caches register so the host can empty them together when the system asks for memory back
 * (docs/guide/performance.md §3.1). Android: `onTrimMemory` calls [clear].
 */
object CacheRegistry {
    private val caches = MutableStateFlow<Map<String, RegisteredCache>>(emptyMap())

    /** Registering a name again replaces the earlier entry. */
    fun register(cache: RegisteredCache) = caches.update { it + (cache.name to cache) }

    fun clear() = caches.value.values.forEach { runCatching { it.clear() } }

    fun totalBytes(): Long = caches.value.values.sumOf { runCatching { it.sizeBytes() }.getOrDefault(0L) }
}
