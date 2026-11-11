package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.plugins.api.SendingRequest
import io.ktor.client.plugins.api.createClientPlugin
import io.ktor.client.plugins.timeout
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Url
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.util.AttributeKey
import io.ktor.util.generateNonce
import io.ktor.util.sha256
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.buildJsonObject
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
        if (request.attributes.contains(DirectRoute)) return@on
        val route = ServerRoutes.routeFor(serverOrigin(request.url.buildString())) ?: return@on
        request.url.host = route.host
        request.url.port = route.port
    }
}

internal fun PairedServices.applyRoutes() {
    ServerRoutes.replace(servers.mapNotNull { server -> server.route?.let { server.origin to it } }.toMap())
}

/** The record id a device token carries: `wkn_<id>_<secret>`. */
internal fun deviceIdOf(token: String): String? =
    Regex("^wkn_([0-9a-f]+)_").find(token)?.groupValues?.get(1)

/**
 * `POST /api/devices/prove` at [baseUrl]: true when the server there holds this device's record.
 * The server answers HMAC-SHA256 keyed by the token's stored hash; the token itself is never sent.
 */
internal suspend fun HttpClient.provesDevice(baseUrl: String, token: String, timeoutMillis: Long = 3_000): Boolean {
    val deviceId = deviceIdOf(token) ?: return false
    val nonce = generateNonce()
    return try {
        val response = post("${baseUrl.trimEnd('/')}/api/devices/prove") {
            attributes.put(DirectRoute, Unit)
            timeout { requestTimeoutMillis = timeoutMillis; connectTimeoutMillis = timeoutMillis }
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject { put("device", deviceId); put("nonce", nonce) }.toString())
        }
        if (!response.status.isSuccess()) return false
        val proof = RiffetJson.instance.parseToJsonElement(response.bodyAsText()).jsonObject["proof"]?.jsonPrimitive?.content
        proof == base64Url(hmacSha256(base64Url(sha256(token.encodeToByteArray())).encodeToByteArray(), nonce.encodeToByteArray()))
    } catch (cancellation: CancellationException) {
        throw cancellation
    } catch (_: Throwable) {
        false
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
