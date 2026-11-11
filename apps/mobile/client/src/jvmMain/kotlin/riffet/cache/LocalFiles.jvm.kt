package riffet.cache

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** The JVM host is a development and test target; it keeps its cache under the user's home. */
actual fun createLocalFiles(): LocalFiles =
    DirectoryLocalFiles(File(System.getProperty("user.home"), ".riffet-mobile/cache"))

/** Every test run would otherwise append the store's log to the developer's home directory. */
actual fun createLogFiles(): LocalFiles = InMemoryLocalFiles()

/** [LocalFiles] over a directory. The same shape as the Android one; the two hosts share no source set. */
class DirectoryLocalFiles(private val root: File) : LocalFiles {
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
