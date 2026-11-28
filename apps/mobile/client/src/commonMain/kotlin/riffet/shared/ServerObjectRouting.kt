package riffet.shared

import io.ktor.http.decodeURLPart
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/**
 * Tracks which linked server owns each work object (`projectId`, `sessionId`, `terminalId`,
 * `attemptGroupId`, `attachmentId`), mirroring `apps/web/src/lib/server-routing.ts`.
 *
 * Objects belonging to the entry server are absent from the map. Entries survive removal from a
 * list so follow-up calls (deletion confirmation, terminal close) still reach their server, and
 * are dropped per server when its link closes ([forgetServer]).
 */
class ObjectServerLocator {
    private val located = MutableStateFlow<Map<String, String>>(emptyMap())

    fun locate(ids: Iterable<String>, serverId: String?) {
        val idList = ids.toList()
        if (idList.isEmpty()) return
        located.update { current ->
            val next = current.toMutableMap()
            val normalized = serverId?.takeIf { it.isNotEmpty() }
            for (id in idList) {
                if (normalized != null) next[id] = normalized else next.remove(id)
            }
            next
        }
    }

    fun locateOne(id: String?, serverId: String?) {
        if (id.isNullOrEmpty()) return
        val normalized = serverId?.takeIf { it.isNotEmpty() }
        located.update { current ->
            if (normalized != null) {
                if (current[id] == normalized) current else current + (id to normalized)
            } else {
                if (id !in current) current else current - id
            }
        }
    }

    fun forgetServer(serverId: String) {
        if (serverId.isEmpty()) return
        located.update { current ->
            if (current.values.none { it == serverId }) current
            else current.filterValues { it != serverId }
        }
    }

    fun serverOf(id: String?): String? = id?.takeIf { it.isNotEmpty() }?.let { located.value[it] }

    fun snapshot(): Map<String, String> = located.value

    fun clear() {
        located.value = emptyMap()
    }
}

private val OBJECT_PATH = Regex("^/api/(?:v3/)?(?:sessions|projects|terminals|attempts|attachments)/([^/?#]+)")
private val OBJECT_QUERY = listOf("sessionId", "projectId")

/**
 * Rewrites `/api/<rest>` to `/api/servers/<serverId>/<rest>` when addressed to a linked peer
 * explicitly ([targetServerId]) or through a located object id in [path] or [query].
 */
internal fun resolveServerPath(
    path: String,
    query: List<Pair<String, String>> = emptyList(),
    targetServerId: String? = null,
    locator: ObjectServerLocator? = null,
): String {
    if (!path.startsWith("/api/") || path.startsWith("/api/servers/")) return path
    val target = targetServerId?.takeIf { it.isNotEmpty() }
        ?: locator?.let { objectServerOf(path, query, it) }
        ?: return path
    return "/api/servers/${target.enc()}/${path.removePrefix("/api/")}"
}

private fun objectServerOf(
    path: String,
    query: List<Pair<String, String>>,
    locator: ObjectServerLocator,
): String? {
    OBJECT_PATH.find(path)?.groupValues?.getOrNull(1)?.let { encoded ->
        val id = runCatching { encoded.decodeURLPart() }.getOrDefault(encoded)
        locator.serverOf(id)?.let { return it }
    }
    for ((key, value) in query) {
        if (key in OBJECT_QUERY) {
            locator.serverOf(value)?.let { return it }
        }
    }
    val qIndex = path.indexOf('?')
    if (qIndex < 0) return null
    val rawQuery = path.substring(qIndex + 1).substringBefore('#')
    for (pair in rawQuery.split('&')) {
        val eq = pair.indexOf('=')
        if (eq <= 0) continue
        val key = pair.substring(0, eq)
        if (key !in OBJECT_QUERY) continue
        val rawValue = pair.substring(eq + 1)
        val value = runCatching { rawValue.decodeURLPart() }.getOrDefault(rawValue)
        locator.serverOf(value)?.let { return it }
    }
    return null
}
