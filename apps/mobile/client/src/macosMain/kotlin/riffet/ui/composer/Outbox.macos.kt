package riffet.ui.composer

import platform.Foundation.NSHomeDirectory
import riffet.cache.DirectoryLocalFiles

/**
 * One file per entry, written atomically before the POST: a crash between the request and its
 * answer must still leave the exact request on disk (see the package comment in `Outbox.kt`).
 */
private class MacOutboxStore(serverUrl: String? = null) : OutboxStore {
    private val files = DirectoryLocalFiles("${NSHomeDirectory()}/Library/Application Support/Riffet/outbox")
    private val steerFiles = DirectoryLocalFiles("${NSHomeDirectory()}/Library/Application Support/Riffet/outbox-steer-v2/${riffet.cache.safeName(riffet.shared.serverOrigin(serverUrl.orEmpty()) ?: "unscoped")}")

    private fun name(sessionId: String, commandId: String) = "${sessionId.safe()}.${commandId.safe()}.json"

    private fun String.safe() = replace(Regex("[^A-Za-z0-9_-]"), "_")

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

actual fun createOutboxStore(serverUrl: String?): OutboxStore = MacOutboxStore(serverUrl)
