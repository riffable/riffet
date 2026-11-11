package riffet.cache

/**
 * The app's private on-device storage, as the transcript cache uses it.
 *
 * Paths are relative to one root the platform chooses, `/`-separated, and never leave it. Every
 * call is blocking; callers run them off the main thread. A failed write throws, a missing file
 * reads as null: the cache treats its files as disposable and recovers from both.
 */
interface LocalFiles {
    fun read(path: String): String?

    /** Replaces the file as a whole: a reader sees the old content or the new, never a mix. */
    fun write(path: String, text: String)

    /** Appends to the end of the file, creating it when absent. */
    fun append(path: String, text: String)

    fun delete(path: String)

    /** Removes a directory and everything under it. */
    fun deleteTree(path: String)

    /** The names of the files directly inside [dir]; empty when it does not exist. */
    fun list(dir: String): List<String>

    /** The file's size in bytes, 0 when absent. */
    fun size(path: String): Long
}

/** Storage that ends with the process, used by tests and hosts without a device copy. */
class InMemoryLocalFiles : LocalFiles {
    private val files = LinkedHashMap<String, StringBuilder>()

    override fun read(path: String): String? = files[path]?.toString()

    override fun write(path: String, text: String) {
        files[path] = StringBuilder(text)
    }

    override fun append(path: String, text: String) {
        files.getOrPut(path) { StringBuilder() }.append(text)
    }

    override fun delete(path: String) {
        files.remove(path)
    }

    override fun deleteTree(path: String) {
        val prefix = path.trimEnd('/') + "/"
        files.keys.removeAll { it.startsWith(prefix) }
    }

    override fun list(dir: String): List<String> {
        val prefix = dir.trimEnd('/') + "/"
        return files.keys.filter { it.startsWith(prefix) && '/' !in it.removePrefix(prefix) }.map { it.removePrefix(prefix) }
    }

    override fun size(path: String): Long = files[path]?.length?.toLong() ?: 0
}

/** This host's storage. Android keeps it in the app's no-backup directory; see the platform files. */
expect fun createLocalFiles(): LocalFiles

/** Where `AppLog` writes: the device's storage on a phone, memory on the test and desktop host. */
expect fun createLogFiles(): LocalFiles
