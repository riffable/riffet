package riffet.shared

actual suspend fun createDownloadSink(name: String, mimeType: String?): DownloadSink =
    throw UnsupportedOperationException("iOS 版暂不支持下载文件")

actual val downloadsSupported: Boolean = false

actual fun openDownload(item: DownloadItem): Boolean = false

actual suspend fun deleteDownload(item: DownloadItem): Boolean = false

actual fun shareSavedFile(saved: SavedDownload, title: String): Boolean = false
