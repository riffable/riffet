package riffet.shared

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.awt.Desktop
import java.io.File

actual suspend fun createDownloadSink(name: String, mimeType: String?): DownloadSink = withContext(Dispatchers.IO) {
    val directory = File(System.getProperty("user.home"), "Downloads").apply { mkdirs() }
    require(name.isNotBlank() && name != "." && name != ".." && File(name).name == name) { "无效文件名" }
    // Never overwrite: an existing file of the same name may be one the reader still wants.
    var file = File(directory, name)
    var suffix = 1
    val extension = file.extension.takeIf { it.isNotEmpty() }?.let { ".$it" } ?: ""
    val stem = name.removeSuffix(extension)
    while (!file.createNewFile()) file = File(directory, "$stem (${suffix++})$extension")
    val output = try {
        file.outputStream().buffered()
    } catch (failure: Throwable) {
        file.delete()
        throw failure
    }
    object : DownloadSink {
        override suspend fun write(bytes: ByteArray, offset: Int, length: Int) {
            withContext(Dispatchers.IO) { output.write(bytes, offset, length) }
        }

        override suspend fun commit(): SavedDownload = withContext(Dispatchers.IO) {
            output.close()
            SavedDownload(location = file.absolutePath, mimeType = mimeType)
        }

        override suspend fun discard() {
            withContext(Dispatchers.IO) {
                runCatching { output.close() }
                file.delete()
            }
        }
    }
}

actual val downloadsSupported: Boolean = true

actual fun openDownload(item: DownloadItem): Boolean {
    val file = item.location?.let(::File)?.takeIf(File::isFile) ?: return false
    return runCatching { Desktop.getDesktop().open(file) }.isSuccess
}

actual suspend fun deleteDownload(item: DownloadItem): Boolean =
    item.location?.let(::File)?.takeIf(File::isFile)?.delete() ?: false

/** A desktop has no share sheet; the saved path is the hand-off. */
actual fun shareSavedFile(saved: SavedDownload, title: String): Boolean = false
