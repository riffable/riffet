@file:OptIn(ExperimentalForeignApi::class, kotlinx.cinterop.BetaInteropApi::class)

package riffet.mac

import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import platform.Foundation.NSData
import platform.Foundation.create

/** A downloaded asset's bytes in one copy; reading a `KotlinByteArray` element by element from Swift is O(n) bridge calls. */
fun dataFromByteArray(bytes: ByteArray): NSData = bytes.usePinned {
    if (bytes.isEmpty()) NSData() else NSData.create(bytes = it.addressOf(0), length = bytes.size.toULong())
}
