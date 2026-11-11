package riffet.ui.composer

import riffet.cache.iosSupportDirectory
import riffet.cache.DirectoryLocalFiles
import riffet.cache.safeName

/**
 * One file per entry, written atomically before the POST: a crash between the request and its
 * answer must still leave the exact request on disk (see the package comment in `Outbox.kt`).
 */
private class IosOutboxStore(serverUrl: String? = null) : OutboxStore {
    private val files = DirectoryLocalFiles(iosSupportDirectory("outbox" + (serverUrl?.let { "/${safeName(it.trimEnd('/').lowercase())}" } ?: "")))
    private val steerFiles = DirectoryLocalFiles(iosSupportDirectory("outbox-steer-v2/${safeName(riffet.shared.serverOrigin(serverUrl.orEmpty()) ?: "unscoped")}"))

    private fun name(sessionId: String, commandId: String) = "${sessionId.safe()}.${commandId.safe()}.json"

    private fun String.safe() = safeName(this)

    override fun list(sessionId: String): List<OutboxEntry> {
        val prefix = "${sessionId.safe()}."
        return listOf(files, steerFiles).flatMap { directory -> directory.list(".").filter { it.startsWith(prefix) }.mapNotNull { directory.read(it)?.let(OutboxJson::decode)?.let { entry -> if (directory === steerFiles && entry.version == 1) entry.copy(version = 2) else entry } } }
            .filter { it.sessionId == sessionId }
    }

    override fun save(entry: OutboxEntry) {
        val destination = if (entry.version != 1 || entry.steerTarget != null) steerFiles else files
        destination.write(name(entry.sessionId, entry.body.commandId), OutboxJson.encode(entry))
    }

    override fun remove(sessionId: String, commandId: String) {
        files.delete(name(sessionId, commandId))
        steerFiles.delete(name(sessionId, commandId))
    }
}

actual fun createOutboxStore(serverUrl: String?): OutboxStore = IosOutboxStore(serverUrl)

internal fun createIosOutboxStore(serverUrl: String): OutboxStore = IosOutboxStore(serverUrl)
