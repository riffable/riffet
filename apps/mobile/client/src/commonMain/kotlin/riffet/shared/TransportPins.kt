package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.HttpClientConfig
import io.ktor.util.sha256
import kotlin.concurrent.Volatile

/**
 * Paired servers whose TLS certificate this app pinned (docs/TRANSPORT-SECURITY.md §3). Credentials, caches and
 * notifications stay keyed by the origin a server was paired at; [ServerRouting] sends a pinned server's requests over
 * TLS to the same host and port, and the platform engine accepts a certificate no CA signed only when it is one of
 * these. A certificate a CA did sign (a `tailscale serve` front door) is checked as usual.
 */
object TransportPins {
    @Volatile
    private var byOrigin: Map<String, String> = emptyMap()

    @Volatile
    private var fingerprints: Set<String> = emptySet()

    /** Replaces every pin: origin → certificate SHA-256 (hex, any case or separators). */
    internal fun replace(next: Map<String, String>) {
        val normal = next.mapValues { (_, value) -> normalFingerprint(value) }
        byOrigin = normal
        fingerprints = normal.values.toSet()
    }

    internal fun put(origin: String, fingerprint: String) = replace(byOrigin + (origin to fingerprint))

    internal fun remove(origin: String) = replace(byOrigin - origin)

    fun fingerprintFor(origin: String?): String? = origin?.let { byOrigin[it] }

    /** Whether the DER certificate [certificate] is a paired server's; the engines trust only these without a CA. */
    fun trusts(certificate: ByteArray): Boolean = fingerprints.contains(hex(sha256(certificate)))
}

/** Uppercase hex without separators, the form pins are compared in. */
fun normalFingerprint(value: String): String = value.filter { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }.uppercase()

internal fun hex(bytes: ByteArray): String = bytes.joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }.uppercase()

/** Whether this platform's engine presents a device certificate of its own on TLS (docs/TRANSPORT-SECURITY.md §2). */
internal expect val presentsDeviceCertificate: Boolean

/** The platform's client with [TransportPins] in its TLS trust decision: OkHttp on Android, Darwin on Apple. */
internal expect fun platformHttpClient(block: HttpClientConfig<*>.() -> Unit): HttpClient

/**
 * [url] as it goes out: over TLS when its server's certificate is pinned, as [ServerRouting] sends the client's own
 * requests. For native code that loads a paired server's resources itself.
 */
fun transportUrl(url: String): String {
    if (TransportPins.fingerprintFor(serverOrigin(url)) == null) return url
    return when {
        url.startsWith("http://") -> "https://" + url.removePrefix("http://")
        url.startsWith("ws://") -> "wss://" + url.removePrefix("ws://")
        else -> url
    }
}
