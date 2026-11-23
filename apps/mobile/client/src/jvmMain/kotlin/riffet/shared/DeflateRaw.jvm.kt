package riffet.shared

import java.io.ByteArrayOutputStream
import java.util.zip.Inflater

internal actual fun inflateRaw(data: ByteArray): ByteArray? {
    val inflater = Inflater(/* nowrap = */ true)
    return try {
        inflater.setInput(data)
        val out = ByteArrayOutputStream(maxOf(data.size * 2, 4096))
        val chunk = ByteArray(8192)
        while (!inflater.finished()) {
            val produced = inflater.inflate(chunk)
            if (produced == 0) {
                if (inflater.needsDictionary() || inflater.needsInput()) return null
            } else {
                if (out.size() + produced > MAX_INFLATE_BYTES) return null
                out.write(chunk, 0, produced)
            }
        }
        if (!inflater.finished()) return null
        out.toByteArray()
    } catch (_: Throwable) {
        null
    } finally {
        inflater.end()
    }
}
