package riffet.cache

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import riffet.shared.RiffetAndroid

/**
 * The no-backup directory: transcripts hold the user's code and prompts, and an adb or cloud
 * backup must not carry them off the phone. Unlike `cacheDir` the system does not purge it under
 * storage pressure, so offline reading survives; the cache enforces its own size budget instead.
 */
actual fun createLocalFiles(): LocalFiles =
    runCatching { DirectoryLocalFiles(File(RiffetAndroid.requireContext().noBackupFilesDir, "riffet-cache")) }
        .getOrElse { InMemoryLocalFiles() }

actual fun createLogFiles(): LocalFiles = createLocalFiles()

/** [LocalFiles] over a directory. The same shape as the JVM one; the two hosts share no source set. */
private class DirectoryLocalFiles(private val root: File) : LocalFiles {
    private fun file(path: String): File = File(root, path)

    override fun read(path: String): String? = file(path).takeIf { it.isFile }?.readText()

    override fun write(path: String, text: String) {
        val target = file(path)
        target.parentFile?.mkdirs()
        val temporary = File(target.parentFile, "${target.name}.tmp")
        temporary.writeText(text)
        Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
    }

    override fun append(path: String, text: String) {
        val target = file(path)
        target.parentFile?.mkdirs()
        target.appendText(text)
    }

    override fun delete(path: String) {
        file(path).delete()
    }

    override fun deleteTree(path: String) {
        file(path).deleteRecursively()
    }

    override fun list(dir: String): List<String> = file(dir).listFiles()?.filter { it.isFile }?.map { it.name }.orEmpty()

    override fun size(path: String): Long = file(path).length()
}
