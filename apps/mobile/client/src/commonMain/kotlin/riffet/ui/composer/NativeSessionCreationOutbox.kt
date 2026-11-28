package riffet.ui.composer

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import riffet.cache.LocalFiles
import riffet.cache.safeName
import riffet.contracts.RiffetJson
import riffet.i18n.L10n
import riffet.shared.NativeSessionCreateInput

/** Complete first-task request persisted before POST; changing editor state never changes its retry. */
@Serializable
data class PendingSessionCreation(
    val serverUrl: String,
    val body: NativeSessionCreateInput,
    val createdAt: String,
    /** Target linked peer id (`docs/SERVER-LINKS.md`); null targets the entry server. */
    val targetServerId: String? = null,
) {
    val id: String get() = body.clientSessionId
}

/** One durable namespace per server, using the same device-files and atomic writes as transcripts. */
class NativeSessionCreationOutbox(private val files: LocalFiles, serverUrl: String) {
    private val server = serverUrl.trimEnd('/').lowercase()
    private val root = "pending-creations/${safeName(server)}"

    fun persist(body: NativeSessionCreateInput, targetServerId: String? = null): PendingSessionCreation {
        require(body.clientSessionId.isNotBlank() && body.initialMessage?.commandId?.isNotBlank() == true)
        val request = PendingSessionCreation(server, body, isoUtcNow(), targetServerId?.takeIf { it.isNotEmpty() })
        files.write(path(request.id), RiffetJson.instance.encodeToString(request))
        return request
    }

    fun find(id: String): PendingSessionCreation? = files.read(path(id))?.let { raw ->
        runCatching { RiffetJson.instance.decodeFromString<PendingSessionCreation>(raw) }.getOrNull()
    }?.takeIf { it.serverUrl == server && it.id == id && it.body.initialMessage != null }

    fun list(): List<PendingSessionCreation> = files.list(root).mapNotNull { name ->
        files.read("$root/$name")?.let { raw -> runCatching { RiffetJson.instance.decodeFromString<PendingSessionCreation>(raw) }.getOrNull() }
            ?.takeIf { it.serverUrl == server && it.body.initialMessage != null }
    }.sortedBy { it.createdAt }

    fun requirePending(request: PendingSessionCreation) {
        require(request.serverUrl == server) { "This task belongs to another server" }
        check(find(request.id) == request) { "The saved task request is unavailable or has changed" }
    }

    fun remove(id: String) {
        val target = path(id)
        files.delete(target)
        check(files.read(target) == null) { L10n.uiText("composer.error.creationCleanupFailed") }
    }
    private fun path(id: String) = "$root/${safeName(id)}.json"
}
