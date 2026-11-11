package riffet.cache

import riffet.contracts.RiffetJson
import riffet.contracts.ThemeLibrary

/**
 * The last theme library this device read from one server, kept the way transcripts are: one
 * replace-whole-file write under the app's private storage.
 *
 * It exists for the first frame. The selection is a plain theme id, and a custom id has no palette
 * until its library is known; reading this cache synchronously lets a launch paint the stored theme
 * before the network answers. A failed fetch leaves the cache alone — an unreachable server is not
 * evidence that a theme was deleted.
 *
 * One file per server: the same id can mean a different palette on another host. The file name is a
 * stable hash of the server's base URL, so a relaunch finds the same file without parsing a URL into
 * a path. A corrupt file reads as nothing and is replaced by the next successful fetch.
 */
class ThemeLibraryCache(
    private val files: LocalFiles,
    serverKey: String,
    private val path: String = "themes/${appearanceCacheToken(serverKey)}.json",
) {
    fun load(): ThemeLibrary? {
        val text = files.read(path) ?: return null
        return runCatching { RiffetJson.instance.decodeFromString(ThemeLibrary.serializer(), text) }
            .getOrNull()
            ?.takeIf { it.version == VERSION }
    }

    fun save(library: ThemeLibrary) {
        files.write(path, RiffetJson.instance.encodeToString(ThemeLibrary.serializer(), library))
    }

    private companion object {
        /** The wire schema this build understands; a newer server's file is ignored, not misread. */
        const val VERSION = 1
    }
}

/**
 * FNV-1a over the server key, as 16 lowercase hex digits. `String.hashCode` is not specified to be
 * the same on every Kotlin target, and this value has to outlive a process and a platform update.
 */
internal fun appearanceCacheToken(value: String): String {
    var hash = -0x340d631b7bdddcdbL // 0xcbf29ce484222325
    for (byte in value.encodeToByteArray()) {
        hash = hash xor (byte.toLong() and 0xFF)
        hash *= 0x100000001b3L
    }
    return hash.toULong().toString(16).padStart(16, '0')
}
