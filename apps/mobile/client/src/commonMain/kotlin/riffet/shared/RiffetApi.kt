package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.client.plugins.timeout
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.header
import io.ktor.client.request.prepareRequest
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.request.url
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.decodeURLPart
import io.ktor.http.encodeURLPathPart
import io.ktor.http.isSuccess
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import kotlinx.serialization.serializer
import riffet.contracts.AgentIds
import riffet.contracts.ApiError
import riffet.contracts.AuthStatus
import riffet.contracts.Bootstrap
import riffet.contracts.NativeBackendId
import riffet.contracts.Session
import riffet.contracts.TerminalInfo
import riffet.contracts.TerminalAppearance
import kotlin.concurrent.Volatile
import riffet.contracts.RiffetJson

/**
 * The HTTP surface the phone needs, ported endpoint-for-endpoint from `apps/web/src/lib/api.ts`.
 *
 * Differences from the web client, all deliberate:
 *  - every request carries `Authorization: Bearer <device token>`; the CSRF header is absent on
 *    purpose. `apps/server/src/auth.ts` skips CSRF for the bearer path because a device token is an
 *    explicit credential, not an ambient one the browser attaches by itself.
 *  - a 401 becomes [RiffetUnauthenticatedException], never a generic error.
 *  - JSON is encoded and decoded with `riffet.contracts.RiffetJson` by hand instead of a
 *    ContentNegotiation plugin, so the shared `ignoreUnknownKeys` configuration is the only thing
 *    that decides whether a newer server breaks an older phone.
 *
 * The class holds the transport and the device/pairing endpoints. Every other endpoint is an
 * extension declared next to its domain (`RiffetApiSessions.kt`, `RiffetApiGit.kt`, …): Swift sees
 * them as methods of this class all the same, and Kotlin outside `riffet.shared` imports them by name.
 *
 * @param tokenProvider read per request, not cached: revoking this device must take effect without
 *   recreating the API object.
 */
class RiffetApi(
    internal val http: HttpClient,
    val baseUrl: String,
    internal val tokenProvider: suspend () -> String? = { null },
    internal val config: RiffetClientConfig = RiffetClientConfig(),
) {
    /** Current app colours for the next terminal process; existing processes retain theirs. */
    @Volatile var terminalAppearance: TerminalAppearance? = null

    private val negotiatedFeatures: String
        get() = (config.features + "session-references-v1").distinct().joinToString(",")

    /** Resource loaders reuse this connection's live credentials and capabilities only on its origin. */
    suspend fun resourceHeaders(url: String): Map<String, String> {
        val origin = serverOrigin(baseUrl) ?: return emptyMap()
        if (serverOrigin(url) != origin) return emptyMap()
        val token = readToken()
        return buildMap {
            put(FeaturesHeader, negotiatedFeatures)
            if (!token.isNullOrEmpty()) put(HttpHeaders.Authorization, "Bearer $token")
        }
    }

    /* --------------------------------------------------------------------------------------- */
    /* Auth, bootstrap and pairing                                                              */
    /* --------------------------------------------------------------------------------------- */

    @Throws(Exception::class)
    suspend fun authStatus(): AuthStatus = get("/api/auth/status").decode()

    @Throws(Exception::class)
    suspend fun bootstrap(): Bootstrap = get("/api/bootstrap").decode()

    /** `POST /api/pairing/code`, authenticated by the current device token. */
    @Throws(Exception::class)
    suspend fun pairingCode(name: String? = null): PairingCodeResponse =
        post("/api/pairing/code", wireBody(PairingCodeRequest(name))).decode()

    /** `POST /api/devices/pair`; the one public endpoint the client calls before it has a token. */
    @Throws(Exception::class)
    suspend fun pairDevice(code: String, name: String): IssuedDevice =
        post("/api/devices/pair", wireBody(PairDeviceRequest(code, name))).decode()

    @Throws(Exception::class)
    suspend fun devices(): List<PublicDevice> = get("/api/devices").decode<DevicesResponse>().devices

    @Throws(Exception::class)
    suspend fun revokeDevice(id: String) {
        delete("/api/devices/${id.enc()}").discard()
    }

    /* --------------------------------------------------------------------------------------- */
    /* Transport, shared by the endpoint files                                                  */
    /* --------------------------------------------------------------------------------------- */

    /** A GET with `If-None-Match`: [ConditionalList.items] is null while [etag] is still current. */
    internal suspend inline fun <reified T> conditionalList(path: String, etag: String?): ConditionalList<T> {
        val response = request(HttpMethod.Get, path, ifNoneMatch = etag)
        val next = response.headers[HttpHeaders.ETag]
        if (response.status == HttpStatusCode.NotModified) return ConditionalList(null, next ?: etag)
        return ConditionalList(response.decode(), next)
    }

    internal suspend fun get(path: String, query: List<Pair<String, String>> = emptyList(), timeoutMillis: Long? = null): HttpResponse =
        request(HttpMethod.Get, path, query, timeoutMillis = timeoutMillis)

    internal suspend fun post(path: String, body: JsonElement? = null): HttpResponse =
        request(HttpMethod.Post, path, body = body)

    internal suspend fun patch(path: String, body: JsonElement? = null): HttpResponse =
        request(HttpMethod.Patch, path, body = body)

    internal suspend fun put(path: String, body: JsonElement? = null): HttpResponse =
        request(HttpMethod.Put, path, body = body)

    /** A body is allowed: several of this server's DELETE routes carry their argument in JSON. */
    internal suspend fun delete(path: String, body: JsonElement? = null): HttpResponse =
        request(HttpMethod.Delete, path, body = body)

    internal suspend fun request(
        method: HttpMethod,
        path: String,
        query: List<Pair<String, String>> = emptyList(),
        body: JsonElement? = null,
        timeoutMillis: Long? = null,
        ifNoneMatch: String? = null,
        multipart: io.ktor.client.request.forms.MultiPartFormDataContent? = null,
    ): HttpResponse {
        val token = readToken()
        val response = try {
            http.request(baseUrl + path) {
                configure(method, token, query, body)
                if (multipart != null) setBody(multipart)
                if (ifNoneMatch != null) header(HttpHeaders.IfNoneMatch, ifNoneMatch)
                if (timeoutMillis != null) timeout { requestTimeoutMillis = timeoutMillis; socketTimeoutMillis = timeoutMillis }
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            throw RiffetNetworkException(error.message ?: "Network request failed", error)
        }
        if (ifNoneMatch != null && response.status == HttpStatusCode.NotModified) return response
        ensureSuccess(response)
        return response
    }

    /**
     * A GET whose body [read] consumes as it arrives. [request] cannot do this: Ktor hands back its
     * response only after the whole body has been buffered, so anything reading it afterwards — a
     * download's progress — would only ever see a finished transfer.
     */
    internal suspend fun <T> streamGet(path: String, query: List<Pair<String, String>>, read: suspend (HttpResponse) -> T): T {
        val token = readToken()
        val statement = http.prepareRequest(baseUrl + path) { configure(HttpMethod.Get, token, query, null) }
        return try {
            statement.execute { response ->
                ensureSuccess(response)
                read(response)
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: RiffetException) {
            throw failure
        } catch (error: Throwable) {
            throw RiffetNetworkException(error.message ?: "Network request failed", error)
        }
    }

    /** Streaming POST keeps the response scoped: cancellation closes its channel and connection. */
    internal suspend fun <T> streamPost(path: String, body: JsonElement?, read: suspend (HttpResponse) -> T): T {
        val token = readToken()
        val statement = http.prepareRequest(baseUrl + path) {
            configure(HttpMethod.Post, token, emptyList(), body)
            header(HttpHeaders.Accept, "application/x-ndjson")
            // Draft generation can outlast the ordinary request timeout; socket liveness is kept.
            timeout { requestTimeoutMillis = Long.MAX_VALUE }
        }
        return try {
            statement.execute { response ->
                ensureSuccess(response)
                read(response)
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: RiffetException) {
            throw failure
        } catch (error: Throwable) {
            throw RiffetNetworkException(error.message ?: "Network request failed", error)
        }
    }

    /** A token store that cannot be read is a failed request, not an unauthenticated one. */
    internal suspend fun readToken(): String? = try {
        tokenProvider()
    } catch (cancellation: CancellationException) {
        throw cancellation
    } catch (error: Throwable) {
        throw RiffetNetworkException(error.message ?: "Could not read the device token", error)
    }

    private fun HttpRequestBuilder.configure(method: HttpMethod, token: String?, query: List<Pair<String, String>>, body: JsonElement?) {
        this.method = method
        if (!token.isNullOrEmpty()) header(HttpHeaders.Authorization, "Bearer $token")
        header(FeaturesHeader, negotiatedFeatures)
        terminalAppearance?.let { colors ->
            if (Regex("^#[0-9a-fA-F]{6}$").matches(colors.foreground) && Regex("^#[0-9a-fA-F]{6}$").matches(colors.background)) {
                header("X-Riffet-Terminal-Appearance", "${colors.foreground};${colors.background}")
            }
        }
        if (query.isNotEmpty()) appendQuery(query)
        if (body != null) {
            contentType(ContentType.Application.Json)
            setBody(WireJson.encodeToString(JsonElement.serializer(), if (pluginAgents) AgentWire.lower(body) else body))
        }
    }

    private fun HttpRequestBuilder.appendQuery(query: List<Pair<String, String>>) {
        url { query.forEach { (key, value) -> parameters.append(key, value) } }
    }

    private suspend fun ensureSuccess(response: HttpResponse) {
        if (response.status.isSuccess()) return
        val text = runCatching { response.bodyAsText() }.getOrNull()?.takeIf { it.isNotBlank() }
        val error = text?.let { withContext(Dispatchers.Default) { runCatching { RiffetJson.instance.decodeFromString<ApiError>(it) }.getOrNull() } }
        val code = error?.error?.code
        val message = error?.error?.message ?: text ?: response.status.description
        if (response.status == HttpStatusCode.Unauthorized) throw RiffetUnauthenticatedException(code, message)
        throw RiffetHttpException(response.status.value, code, message, error?.error?.details, error?.error?.params.orEmpty().mapValues { it.value.content })
    }

    internal suspend inline fun <reified T> HttpResponse.decode(): T {
        val text = bodyAsText()
        return withContext(Dispatchers.Default) { decodeBody(text, serializer<T>()) }
    }

    /** Whether the server may send this client Agents a plugin provides (see [AgentWire]). */
    private val pluginAgents: Boolean get() = AgentIds.PLUGIN_AGENTS_FEATURE in config.features

    internal fun <T> decodeBody(text: String, serializer: KSerializer<T>): T =
        if (pluginAgents) AgentWire.decode(text, serializer) else RiffetJson.instance.decodeFromString(serializer, text)

    /** Drains a body that carries no payload (the server answers `{ ok: true }` or similar). */
    internal suspend fun HttpResponse.discard() {
        runCatching { bodyAsText() }
    }
}

internal inline fun <reified T> wireBody(value: T): JsonElement = WireJson.encodeToJsonElement(value)

/** The result of a conditional list read: [items] is null when the held copy named by [etag] is current. */
class ConditionalList<T>(val items: List<T>?, val etag: String?)

/** Percent-encode one path segment; ids can contain `/` and the server would read it as a new segment. */
internal fun String.enc(): String = encodeURLPathPart()

/** A finished [RiffetApi.downloadFile]: what it was called and how many bytes were written. */
class DownloadedFile(val name: String, val mimeType: String?, val size: Long)

/** Where [RiffetApi.downloadFile] puts the body, one chunk at a time. [bytes] is reused after the call. */
fun interface DownloadWriter {
    suspend fun write(bytes: ByteArray, offset: Int, length: Int)
}

/** A text file the server prepared for saving; [name] is null when it did not name one. */
class ExportedText(val name: String?, val text: String)

/** What reopening a conversation's CLI returned; either may be absent depending on the server. */
class StartSessionResult(val session: Session?, val terminal: TerminalInfo?)

/** `filename*=UTF-8''…` carries the real name; the quoted `filename` is the ASCII fallback. */
fun dispositionFileName(header: String): String? {
    Regex("filename\\*=UTF-8''([^;]+)", RegexOption.IGNORE_CASE).find(header)?.let { match ->
        return runCatching { match.groupValues[1].trim().decodeURLPart() }.getOrNull()?.takeIf { it.isNotBlank() }
    }
    return Regex("filename=\"([^\"]*)\"").find(header)?.groupValues?.get(1)?.takeIf { it.isNotBlank() }
}

/** The wire spelling of a backend id is its `@SerialName`, not its Kotlin constant name. */
internal fun NativeBackendId.wire(): String = AgentIds.wire(this)

/** Names the contract extensions this build understands; the server withholds the rest. */
internal const val FeaturesHeader = "X-Riffet-Features"
