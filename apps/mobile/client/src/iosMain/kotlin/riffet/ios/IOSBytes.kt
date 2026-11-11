@file:OptIn(ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package riffet.ios

import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import platform.Foundation.NSData
import platform.Foundation.create
import platform.posix.memcpy

/** An attachment's bytes in one copy; building a `KotlinByteArray` element by element from Swift is O(n) bridge calls. */
fun byteArrayFromData(data: NSData): ByteArray {
    val size = data.length.toInt()
    val result = ByteArray(size)
    if (size > 0) result.usePinned { memcpy(it.addressOf(0), data.bytes, data.length) }
    return result
}

/** Copy shared download bytes into Foundation without per-byte Swift calls. */
fun dataFromByteArray(bytes: ByteArray): NSData = bytes.usePinned {
    if (bytes.isEmpty()) NSData() else NSData.create(bytes = it.addressOf(0), length = bytes.size.toULong())
}
