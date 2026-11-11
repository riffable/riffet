@file:OptIn(ExperimentalForeignApi::class)

package riffet.cache

import kotlinx.cinterop.BooleanVar
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.alloc
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.value
import platform.Foundation.NSFileHandle
import platform.Foundation.NSFileManager
import platform.Foundation.NSFileSize
import platform.Foundation.NSHomeDirectory
import platform.Foundation.NSNumber
import platform.Foundation.NSString
import platform.Foundation.NSUTF8StringEncoding
import platform.Foundation.closeFile
import platform.Foundation.create
import platform.Foundation.dataUsingEncoding
import platform.Foundation.fileHandleForWritingAtPath
import platform.Foundation.seekToEndOfFile
import platform.Foundation.stringWithContentsOfFile
import platform.Foundation.writeData
import platform.Foundation.writeToFile

/** The app is not sandboxed, so these are the user's real Library directories. */
actual fun createLocalFiles(): LocalFiles = DirectoryLocalFiles("${NSHomeDirectory()}/Library/Caches/Riffet")

actual fun createLogFiles(): LocalFiles = DirectoryLocalFiles("${NSHomeDirectory()}/Library/Logs/Riffet")

/** [LocalFiles] over a directory, through Foundation. */
class DirectoryLocalFiles(private val root: String) : LocalFiles {
    private val manager get() = NSFileManager.defaultManager

    private fun file(path: String): String = "$root/${path.trimStart('/')}"

    private fun ensureParent(target: String) {
        val parent = target.substringBeforeLast('/', missingDelimiterValue = root)
        manager.createDirectoryAtPath(parent, withIntermediateDirectories = true, attributes = null, error = null)
    }

    private fun isDirectory(path: String): Boolean? = memScoped {
        val flag = alloc<BooleanVar>()
        if (!manager.fileExistsAtPath(path, isDirectory = flag.ptr)) null else flag.value
    }

    override fun read(path: String): String? {
        val target = file(path)
        if (isDirectory(target) != false) return null
        return NSString.stringWithContentsOfFile(target, encoding = NSUTF8StringEncoding, error = null)
    }

    override fun write(path: String, text: String) {
        val target = file(path)
        ensureParent(target)
        @Suppress("CAST_NEVER_SUCCEEDS")
        val written = (text as NSString).writeToFile(target, atomically = true, encoding = NSUTF8StringEncoding, error = null)
        if (!written) error("Could not write $target")
    }

    override fun append(path: String, text: String) {
        val target = file(path)
        ensureParent(target)
        if (!manager.fileExistsAtPath(target)) manager.createFileAtPath(target, contents = null, attributes = null)
        val handle = NSFileHandle.fileHandleForWritingAtPath(target) ?: error("Could not open $target")
        val data = NSString.create(string = text).dataUsingEncoding(NSUTF8StringEncoding) ?: return
        handle.seekToEndOfFile()
        handle.writeData(data)
        handle.closeFile()
    }

    override fun delete(path: String) {
        manager.removeItemAtPath(file(path), error = null)
    }

    override fun deleteTree(path: String) {
        manager.removeItemAtPath(file(path), error = null)
    }

    override fun list(dir: String): List<String> {
        val target = file(dir)
        val names = manager.contentsOfDirectoryAtPath(target, error = null) ?: return emptyList()
        return names.mapNotNull { it as? String }.filter { isDirectory("$target/$it") == false }
    }

    override fun size(path: String): Long {
        val attributes = manager.attributesOfItemAtPath(file(path), error = null) ?: return 0
        return (attributes[NSFileSize] as? NSNumber)?.longLongValue ?: 0
    }
}
