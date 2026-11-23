package riffet.shared

import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.alloc
import kotlinx.cinterop.convert
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.reinterpret
import kotlinx.cinterop.sizeOf
import kotlinx.cinterop.usePinned
import platform.posix.memset
import platform.zlib.ZLIB_VERSION
import platform.zlib.Z_BUF_ERROR
import platform.zlib.Z_NO_FLUSH
import platform.zlib.Z_OK
import platform.zlib.Z_STREAM_END
import platform.zlib.inflate
import platform.zlib.inflateEnd
import platform.zlib.inflateInit2_
import platform.zlib.z_stream

@OptIn(ExperimentalForeignApi::class)
internal actual fun inflateRaw(data: ByteArray): ByteArray? {
    if (data.isEmpty()) return ByteArray(0)
    return memScoped {
        val stream = alloc<z_stream>()
        memset(stream.ptr, 0, sizeOf<z_stream>().convert())
        val initStatus = inflateInit2_(stream.ptr, -15, ZLIB_VERSION, sizeOf<z_stream>().toInt())
        if (initStatus != Z_OK) return@memScoped null
        try {
            var output = ByteArray(maxOf(data.size * 2, 4096).coerceAtMost(MAX_INFLATE_BYTES))
            var written = 0
            data.usePinned { inputPinned ->
                stream.next_in = inputPinned.addressOf(0).reinterpret()
                stream.avail_in = data.size.convert()
                while (true) {
                    if (written == output.size) {
                        val nextSize = minOf(output.size * 2, MAX_INFLATE_BYTES)
                        if (nextSize <= output.size) return@memScoped null
                        output = output.copyOf(nextSize)
                    }
                    val status = output.usePinned { outPinned ->
                        val space = output.size - written
                        stream.next_out = outPinned.addressOf(written).reinterpret()
                        stream.avail_out = space.convert()
                        val result = inflate(stream.ptr, Z_NO_FLUSH)
                        written += space - stream.avail_out.toInt()
                        result
                    }
                    when (status) {
                        Z_STREAM_END -> return@memScoped output.copyOf(written)
                        Z_OK -> if (stream.avail_in == 0u && stream.avail_out > 0u) return@memScoped null
                        Z_BUF_ERROR -> if (stream.avail_out > 0u) return@memScoped null
                        else -> return@memScoped null
                    }
                }
            }
            @Suppress("UNREACHABLE_CODE")
            null
        } finally {
            inflateEnd(stream.ptr)
        }
    }
}
