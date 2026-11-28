package riffet.ui.home

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import riffet.contracts.LinkedServerStatus
import riffet.contracts.NativeBackendCatalogEntry
import riffet.contracts.NativeBackendId
import riffet.contracts.AppSettings
import riffet.contracts.Project
import riffet.contracts.RiffetJson
import riffet.contracts.ServerInfo
import riffet.contracts.ServerPlatform
import riffet.contracts.Session
import riffet.i18n.L10n
import riffet.shared.AppPreferences
import riffet.shared.isAssistant
import riffet.shared.isQuickChat
import riffet.ui.sessionlist.activityAt
import riffet.ui.state.SessionListState
import riffet.ui.timeline.instantMillis

/** Readable platform summary from Node's `os` and `arch`, e.g. `macOS · arm64`. */
fun formatServerPlatform(platform: ServerPlatform?): String {
    if (platform == null) return ""
    val os = when (platform.os) {
        "darwin" -> "macOS"
        "linux" -> "Linux"
        "win32" -> "Windows"
        else -> platform.os
    }
    return if (platform.arch.isNotEmpty()) "$os · ${platform.arch}" else os
}

/**
 * One entry in the new-session server picker (`docs/SERVER-LINKS.md §10`).
 * [id] is `""` for the entry server and the linked server's `serverId` otherwise.
 */
data class HomeServerOption(
    val id: String,
    val name: String,
    val alias: String? = null,
    val note: String? = null,
    val platform: ServerPlatform? = null,
    val self: Boolean,
    val online: Boolean,
    val usable: Boolean,
    val reason: String? = null,
) {
    /** Swift-friendly alias for [self] (`self` collides with Objective-C/Swift keywords). */
    val isSelf: Boolean get() = self

    /** Subtitle matching web's server menu: local note, or `alias · platform`. */
    val subtitle: String
        get() {
            if (!note.isNullOrBlank()) return note
            val parts = buildList {
                if (!alias.isNullOrBlank() && alias != name) add(alias)
                val plat = formatServerPlatform(platform)
                if (plat.isNotEmpty()) add(plat)
            }
            return parts.joinToString(" · ")
        }
}

/**
 * Every server known to the workbench for the new-session server pill (`docs/SERVER-LINKS.md §10`).
 * Ordered `self -> online usable -> unavailable`, empty when there are no linked servers.
 */
fun buildHomeServerOptions(
    servers: List<ServerInfo>,
    linkedStatus: Map<String, LinkedServerStatus>,
): List<HomeServerOption> {
    if (servers.size < 2) return emptyList()
    val mapped = servers.map { item ->
        if (item.self == true) {
            HomeServerOption(
                id = "",
                name = item.name,
                alias = item.alias,
                platform = item.platform,
                self = true,
                online = true,
                usable = true,
            )
        } else {
            val online = item.online && linkedStatus[item.id] != LinkedServerStatus.OFFLINE
            val reason = when {
                !online -> L10n.uiText("servers.offline")
                !item.compatible -> L10n.uiText("servers.incompatible")
                !item.outbound -> L10n.uiText("servers.noOutbound")
                else -> null
            }
            HomeServerOption(
                id = item.id,
                name = item.name,
                alias = item.alias,
                note = item.note,
                platform = item.platform,
                self = false,
                online = online,
                usable = reason == null,
                reason = reason,
            )
        }
    }
    return mapped.sortedBy { if (it.self) 0 else if (it.usable) 1 else 2 }
}

/** Server metadata for a work object on a linked peer; null for objects on the entry server. */
data class ServerBadgeInfo(
    val id: String,
    val name: String,
    val alias: String,
    val label: String,
    val offline: Boolean,
    /** True when two or more linked peers exist, so a bare link icon is no longer enough. */
    val multiPeer: Boolean,
)

/** Linked server badge for [objectId] (`sessionId` or `projectId`), or null for the entry server. */
fun serverBadgeFor(objectId: String?, list: SessionListState): ServerBadgeInfo? {
    if (objectId.isNullOrEmpty()) return null
    val serverId = list.objectServers[objectId] ?: return null
    val server = list.servers.firstOrNull { it.id == serverId } ?: return null
    val peerCount = list.servers.count { it.self != true }
    val offline = list.linkedStatus[serverId] == LinkedServerStatus.OFFLINE || !server.online
    val label = if (offline) L10n.uiText("servers.offlineLabel", server.name) else server.name
    return ServerBadgeInfo(
        id = serverId,
        name = server.name,
        alias = server.alias?.takeIf { it.isNotBlank() } ?: server.name,
        label = label,
        offline = offline,
        multiPeer = peerCount >= 2,
    )
}

/** Projects owned by [serverId] (`""` for the entry server), excluding archived and system projects. */
fun projectsForServer(
    projects: List<Project>,
    objectServers: Map<String, String>,
    serverId: String,
): List<Project> {
    val target = serverId.ifEmpty { null }
    return projects.filter { project ->
        project.archivedAt == null &&
            !project.isAssistant &&
            !project.isQuickChat &&
            project.system == null &&
            objectServers[project.id] == target
    }
}

/**
 * Most recently active non-archived user project on [serverId] (`""` for entry), mirroring web's
 * `selectHomeServer` fallback when switching the new-session server pill.
 */
fun preferredProjectForServer(
    projects: List<Project>,
    sessions: List<Session>,
    objectServers: Map<String, String>,
    serverId: String,
): Project? {
    val owned = projectsForServer(projects, objectServers, serverId)
    if (owned.isEmpty()) return null
    val byProject = HashMap<String, Long>()
    for (session in sessions) {
        if (session.archivedAt != null) continue
        val stamp = instantMillis(activityAt(session)) ?: 0L
        val prev = byProject[session.projectId]
        if (prev == null || stamp > prev) byProject[session.projectId] = stamp
    }
    return owned.maxWithOrNull(
        compareBy<Project> { byProject[it.id] ?: Long.MIN_VALUE }
            .thenBy { instantMillis(it.updatedAt) ?: Long.MIN_VALUE },
    )
}

/** Sidebar / session list server scope (`docs/SERVER-LINKS.md §10`). */
enum class ServerScopeKind {
    /** Entry server + sessions on linked servers started from this entry server (`origin.kind == "link"`). */
    RELEVANT,
    ALL,
    LOCAL,
    PEER,
}

/** Whether [session] belongs to the active server scope filter. */
fun inServerScope(
    session: Session,
    scope: ServerScopeKind,
    peerId: String?,
    selfServerId: String?,
    objectServers: Map<String, String>,
): Boolean {
    if (scope == ServerScopeKind.ALL) return true
    val owner = objectServers[session.id] ?: objectServers[session.projectId]
    val origin = session.origin
    return when (scope) {
        ServerScopeKind.LOCAL -> owner == null
        ServerScopeKind.RELEVANT -> owner == null ||
            (selfServerId != null && origin?.kind == "link" && origin.serverId == selfServerId)
        ServerScopeKind.PEER -> owner != null && owner == peerId
        ServerScopeKind.ALL -> true
    }
}

/** Initial agent/provider pick for a linked server when no local pick is remembered yet. */
@Serializable
data class RemoteHomeChoice(
    val backendId: NativeBackendId,
    val profileId: String? = null,
)

fun initialRemoteHomeChoice(
    backends: List<NativeBackendCatalogEntry>,
    settings: AppSettings?,
): RemoteHomeChoice? {
    val usable = backends.filter { it.backendId != NativeBackendId.CHAT }
    if (usable.isEmpty()) return null
    val preferred = settings?.defaultBackendId?.let { id -> usable.firstOrNull { it.backendId == id } }
    val picked = preferred?.takeIf { it.available }
        ?: usable.firstOrNull { it.available }
        ?: preferred
        ?: usable.first()
    val savedProfile = settings?.nativeBackendDefaults?.get(picked.backendId)?.profileId
    val profileId = savedProfile?.takeIf { id -> picked.profiles.any { it.id == id } }
        ?: picked.profiles.firstOrNull { it.isDefault == true }?.id
    return RemoteHomeChoice(picked.backendId, profileId)
}

/**
 * Local per-linked-server agent/provider picks, kept apart from the entry server's defaults so
 * choosing an agent on a peer never writes back to the entry server (`docs/SERVER-LINKS.md §5`).
 */
class RemoteHomeStore(private val preferences: AppPreferences) {
    private var cached: Map<String, RemoteHomeChoice>? = null

    fun get(serverId: String): RemoteHomeChoice? = read()[serverId]

    fun set(serverId: String, backendId: NativeBackendId, profileId: String?) {
        if (serverId.isEmpty()) return
        val next = read().toMutableMap()
        next[serverId] = RemoteHomeChoice(backendId, profileId?.takeIf { it.isNotEmpty() })
        val trimmed = if (next.size > LIMIT) next.entries.toList().takeLast(LIMIT).associate { it.key to it.value } else next
        cached = trimmed
        preferences.setString(KEY, RiffetJson.instance.encodeToString(trimmed))
    }

    private fun read(): Map<String, RemoteHomeChoice> {
        cached?.let { return it }
        val raw = preferences.string(KEY) ?: return emptyMap<String, RemoteHomeChoice>().also { cached = it }
        return runCatching { RiffetJson.instance.decodeFromString<Map<String, RemoteHomeChoice>>(raw) }
            .getOrDefault(emptyMap())
            .also { cached = it }
    }

    private companion object {
        const val KEY = "remote-home-v1"
        const val LIMIT = 32
    }
}
