package riffet.shared

import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.contentLength
import io.ktor.utils.io.readAvailable
import riffet.contracts.AppearanceCatalog

// RiffetApi endpoints — the plugin appearance catalog and its assets. Transport and auth rules: see RiffetApi.kt.

/**
 * `GET /api/appearance`: what the enabled plugins contribute to appearance. Which items this device
 * shows is a local preference, so the selection is deliberately absent.
 */
@Throws(Exception::class)
suspend fun RiffetApi.appearance(): AppearanceCatalog = get("/api/appearance").decode()

/**
 * The bytes of one catalog asset, addressed by the catalog's own `url`. The address is content-hashed,
 * so the caller may keep the result for good; a body longer than [maxBytes] is refused rather than
 * held, since the server already bounds every asset and a larger one is not what the catalog described.
 */
@Throws(Exception::class)
suspend fun RiffetApi.appearanceAsset(url: String, maxBytes: Long): ByteArray {
    require(maxBytes in 1..Int.MAX_VALUE.toLong()) { "Invalid appearance asset limit" }
    require(url.startsWith("/api/appearance/assets/")) { "Not an appearance asset address" }
    return streamGet(url, emptyList()) { response ->
        val declared = response.contentLength()
        if (declared != null && declared !in 0..maxBytes) error("Appearance asset is larger than $maxBytes bytes")
        val channel = response.bodyAsChannel()
        val buffer = ByteArray(16 * 1024)
        var out = ByteArray(declared?.toInt()?.coerceAtLeast(0) ?: minOf(maxBytes, 64 * 1024L).toInt())
        var size = 0
        while (true) {
            val read = channel.readAvailable(buffer, 0, buffer.size)
            if (read < 0) break
            if (read == 0) continue
            if (size.toLong() + read > maxBytes) error("Appearance asset is larger than $maxBytes bytes")
            if (size + read > out.size) out = out.copyOf(maxOf(minOf(out.size.toLong() * 2, maxBytes).toInt(), size + read))
            buffer.copyInto(out, size, 0, read)
            size += read
        }
        out.copyOf(size)
    }
}
