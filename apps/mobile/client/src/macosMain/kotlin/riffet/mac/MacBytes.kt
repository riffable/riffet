@file:OptIn(ExperimentalForeignApi::class)

package riffet.mac

import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import platform.Foundation.NSData
import platform.posix.memcpy

/** An attachment's bytes in one copy; building a `KotlinByteArray` element by element from Swift is O(n) bridge calls. */
fun byteArrayFromData(data: NSData): ByteArray {
    val size = data.length.toInt()
    val result = ByteArray(size)
    if (size > 0) result.usePinned { memcpy(it.addressOf(0), data.bytes, data.length) }
    return result
}
