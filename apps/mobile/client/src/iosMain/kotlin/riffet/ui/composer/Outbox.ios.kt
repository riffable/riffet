package riffet.ui.composer

import platform.Foundation.NSLock
import riffet.cache.iosSupportDirectory
import riffet.cache.DirectoryLocalFiles
import riffet.cache.safeName

/**
 * One file per entry, written atomically before the POST: a crash between the request and its
 * answer must still leave the exact request on disk (see the package comment in `Outbox.kt`).
 */
private class IosOutboxStore(serverUrl: String? = null) : OutboxStore {
    private val filesRoot = iosSupportDirectory("outbox" + (serverUrl?.let { "/${safeName(it.trimEnd('/').lowercase())}" } ?: ""))
    private val steerRoot = iosSupportDirectory("outbox-steer-v2/${safeName(riffet.shared.serverOrigin(serverUrl.orEmpty()) ?: "unscoped")}")
    private val files = DirectoryLocalFiles(filesRoot)
    private val steerFiles = DirectoryLocalFiles(steerRoot)
    private fun root(directory: DirectoryLocalFiles) = if (directory === files) filesRoot else steerRoot

    private fun name(sessionId: String, commandId: String) = "${sessionId.safe()}.${commandId.safe()}.json"

    private fun String.safe() = safeName(this)

    override fun list(sessionId: String): List<OutboxEntry> {
        val prefix = "${sessionId.safe()}."
        return listOf(files, steerFiles).flatMap { directory -> OutboxNames.list(root(directory), directory).filter { it.startsWith(prefix) }.mapNotNull { directory.read(it)?.let(OutboxJson::decode)?.let { entry -> if (directory === steerFiles && entry.version == 1) entry.copy(version = 2) else entry } } }
            .filter { it.sessionId == sessionId }
    }

    override fun save(entry: OutboxEntry) {
        val destination = if (entry.version != 1 || entry.steerTarget != null) steerFiles else files
        val file = name(entry.sessionId, entry.body.commandId)
        destination.write(file, OutboxJson.encode(entry))
        OutboxNames.add(root(destination), destination, file)
    }

    override fun remove(sessionId: String, commandId: String) {
        val file = name(sessionId, commandId)
        files.delete(file); OutboxNames.remove(filesRoot, file)
        steerFiles.delete(file); OutboxNames.remove(steerRoot, file)
    }
}

/**
 * The file names in each outbox directory, listed once per process. `list` runs on the main thread
 * on every runs update of an open conversation, and listing the directory each time showed up while
 * a conversation opened (docs/guide/ios-performance.md §2.1). Only this app writes these directories,
 * always through [IosOutboxStore], so the names stay true; the files are still read from disk.
 */
private object OutboxNames {
    private val lock = NSLock()
    private val names = mutableMapOf<String, MutableSet<String>>()

    private fun <T> locked(block: () -> T): T { lock.lock(); try { return block() } finally { lock.unlock() } }
    private fun loaded(root: String, directory: DirectoryLocalFiles) = names.getOrPut(root) { directory.list(".").toMutableSet() }

    fun list(root: String, directory: DirectoryLocalFiles): List<String> = locked { loaded(root, directory).toList() }
    fun add(root: String, directory: DirectoryLocalFiles, name: String) { locked { loaded(root, directory).add(name) } }
    fun remove(root: String, name: String) { locked { names[root]?.remove(name) } }
}

actual fun createOutboxStore(serverUrl: String?): OutboxStore = IosOutboxStore(serverUrl)

internal fun createIosOutboxStore(serverUrl: String): OutboxStore = IosOutboxStore(serverUrl)
