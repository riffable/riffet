package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.plugins.api.SendingRequest
import io.ktor.client.plugins.api.createClientPlugin
import io.ktor.client.plugins.timeout
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.URLProtocol
import io.ktor.http.Url
import io.ktor.http.isSecure
import io.ktor.http.isWebsocket
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.util.AttributeKey
import io.ktor.util.generateNonce
import io.ktor.util.sha256
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import riffet.contracts.RiffetJson
import kotlin.concurrent.Volatile
import kotlin.io.encoding.Base64

/**
 * Where a paired server is reached when that is no longer the address it was paired at. A Mac that
 * changes networks gets a new IP; the pairing keeps its origin, which credentials, caches, drafts
 * and notifications are keyed by, and only the transport goes elsewhere. Requests are built for the
 * paired origin, so the token stays bound to it ([tokenFor]); [ServerRouting] moves them at send time.
 */
object ServerRoutes {
    @Volatile
    private var routes: Map<String, Url> = emptyMap()

    /** Replaces every route: origin → the base URL that last reached it. */
    internal fun replace(next: Map<String, String>) {
        routes = next.mapNotNull { (origin, base) -> runCatching { origin to Url(base) }.getOrNull() }.toMap()
    }

    internal fun routeFor(origin: String?): Url? = origin?.let { routes[it] }
}

/** Set on a request that must reach its own address, such as a proof asked of the paired address itself. */
internal val DirectRoute = AttributeKey<Unit>("RiffetDirectRoute")

/** Runs per send, after every interceptor has judged the request by its paired origin. */
internal val ServerRouting = createClientPlugin("RiffetServerRouting") {
    on(SendingRequest) { request, _ ->
        val origin = serverOrigin(request.url.buildString())
        // A server whose certificate is pinned is reached over TLS on the same port, wherever it is reached.
        if (TransportPins.fingerprintFor(origin) != null && !request.url.protocol.isSecure()) {
            val port = request.url.port.takeIf { it > 0 } ?: request.url.protocol.defaultPort
            request.url.protocol = if (request.url.protocol.isWebsocket()) URLProtocol.WSS else URLProtocol.HTTPS
            request.url.port = port
        }
        if (request.attributes.contains(DirectRoute)) return@on
        val route = ServerRoutes.routeFor(origin) ?: return@on
        request.url.host = route.host
        request.url.port = route.port
    }
}

internal fun PairedServices.applyRoutes() {
    ServerRoutes.replace(servers.mapNotNull { server -> server.route?.let { server.origin to it } }.toMap())
    TransportPins.replace(servers.mapNotNull { server -> server.tlsFingerprint?.let { server.origin to it } }.toMap())
}

/** The record id a device token carries: `wkn_<id>_<secret>`. */
internal fun deviceIdOf(token: String): String? =
    Regex("^wkn_([0-9a-f]+)_").find(token)?.groupValues?.get(1)

/**
 * `POST /api/devices/prove` at [baseUrl]: true when the server there holds this device's record.
 * The server answers HMAC-SHA256 keyed by the token's stored hash; the token itself is never sent.
 */
internal suspend fun HttpClient.provesDevice(baseUrl: String, token: String, timeoutMillis: Long = 3_000): Boolean =
    proveDevice(baseUrl, token, timeoutMillis) != null

/** What a server that proved it holds this device's record also vouched for. */
internal class DeviceProof(
    /** Its TLS certificate's SHA-256, under the same proof (docs/TRANSPORT-SECURITY.md §11); null from a server without TLS. */
    val tlsFingerprint: String?,
)

/** [provesDevice], keeping what the proof covered; null when the server there did not prove it. */
internal suspend fun HttpClient.proveDevice(baseUrl: String, token: String, timeoutMillis: Long = 3_000): DeviceProof? {
    val deviceId = deviceIdOf(token) ?: return null
    val nonce = generateNonce()
    return try {
        val response = post("${baseUrl.trimEnd('/')}/api/devices/prove") {
            attributes.put(DirectRoute, Unit)
            timeout { requestTimeoutMillis = timeoutMillis; connectTimeoutMillis = timeoutMillis }
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject { put("device", deviceId); put("nonce", nonce) }.toString())
        }
        if (!response.status.isSuccess()) return null
        val body = RiffetJson.instance.parseToJsonElement(response.bodyAsText()).jsonObject
        val key = base64Url(sha256(token.encodeToByteArray())).encodeToByteArray()
        if (body["proof"]?.jsonPrimitive?.content != base64Url(hmacSha256(key, nonce.encodeToByteArray()))) return null
        val tls = body["tls"] as? JsonObject
        val fingerprint = tls?.get("fingerprint")?.jsonPrimitive?.contentOrNull?.let(::normalFingerprint)?.takeIf { it.length == 64 }
        val vouched = fingerprint != null &&
            tls["proof"]?.jsonPrimitive?.contentOrNull == base64Url(hmacSha256(key, "riffet-tls\n$nonce\n$fingerprint".encodeToByteArray()))
        DeviceProof(tlsFingerprint = fingerprint?.takeIf { vouched })
    } catch (cancellation: CancellationException) {
        throw cancellation
    } catch (_: Throwable) {
        null
    }
}

private fun hmacSha256(key: ByteArray, message: ByteArray): ByteArray {
    val block = 64
    val padded = (if (key.size > block) sha256(key) else key).copyOf(block)
    val inner = ByteArray(block) { (padded[it].toInt() xor 0x36).toByte() }
    val outer = ByteArray(block) { (padded[it].toInt() xor 0x5c).toByte() }
    return sha256(outer + sha256(inner + message))
}

private fun base64Url(bytes: ByteArray): String = Base64.UrlSafe.encode(bytes).trimEnd('=')
