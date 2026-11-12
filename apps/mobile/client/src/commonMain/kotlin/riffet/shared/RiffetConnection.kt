package riffet.shared

import io.ktor.client.HttpClient
import io.ktor.http.Url
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import riffet.i18n.L10n
import riffet.ui.timeline.platformNowMillis
import kotlin.coroutines.CoroutineContext

/** One installed connection; saved credentials remain bound to each service's origin. */
class RiffetConnection(
    private val tokens: DeviceTokenStore,
    private val deviceInfo: DeviceInfo = createDeviceInfo(),
    private val http: HttpClient = createRiffetHttpClient(),
    private val config: RiffetClientConfig = RiffetClientConfig(),
    private val parseContext: CoroutineContext = Dispatchers.Default,
) {
    private var api: RiffetApi? = null

    var baseUrl: String? = null
        private set

    @Throws(Exception::class)
    suspend fun hasStoredToken(): Boolean = pairingChanges.withLock {
        val state = tokens.pairings()
        state.servers.any { it.origin == state.activeOrigin }
    }

    /** Neither probing nor pairing sends any saved credential to the entered address. */
    fun probe(serverBaseUrl: String): RiffetApi =
        RiffetApi(http = http, baseUrl = serverBaseUrl.trim().trimEnd('/'), config = config, parseContext = parseContext)

    private fun authenticated(serverBaseUrl: String): RiffetApi {
        val base = serverBaseUrl.trim().trimEnd('/')
        return RiffetApi(http = http, baseUrl = base, tokenProvider = { tokens.tokenFor(base) }, config = config, parseContext = parseContext)
    }

    internal fun connect(serverBaseUrl: String): RiffetApi = install(authenticated(serverBaseUrl))

    private fun install(created: RiffetApi): RiffetApi {
        api = created
        baseUrl = created.baseUrl
        return created
    }

    /** Debug/host address override. Only a previously paired origin can become the saved selection. */
    @Throws(Exception::class)
    suspend fun connectAndRemember(serverBaseUrl: String): RiffetApi = pairingChanges.withLock {
        val state = tokens.pairings()
        val origin = serverOrigin(serverBaseUrl)
        val known = state.servers.firstOrNull { it.origin == origin }
        if (known != null) {
            tokens.savePairings(state.copy(activeOrigin = known.origin).encoded())
        }
        connect(serverBaseUrl)
    }

    /** Startup can restore the last service while offline; it does not probe the network. */
    @Throws(Exception::class)
    suspend fun restore(): RiffetApi? = pairingChanges.withLock {
        val state = tokens.pairings()
        state.applyRoutes()
        state.servers.firstOrNull { it.origin == state.activeOrigin }?.let { connect(it.baseUrl) }
    }

    @Throws(Exception::class)
    suspend fun pairedServers(): List<PairedServer> = pairingChanges.withLock {
        val state = tokens.pairings()
        state.servers.sortedWith(compareByDescending<PairedCredential> { it.origin == state.activeOrigin }
            .thenByDescending { it.lastUsedAt }).map { it.server() }
    }

    /** A local name change preserves the selected service and all saved authorization. */
    @Throws(Exception::class)
    suspend fun renameServer(origin: String, name: String): PairedServer = pairingChanges.withLock {
        val value = name.trim()
        require(PairedServer.isValidName(value)) { L10n.uiText("connection.invalidServerName") }
        val state = tokens.pairings()
        val previous = state.servers.firstOrNull { it.origin == origin }
            ?: throw IllegalArgumentException(L10n.uiText("connection.pairingRemoved"))
        if (previous.name == value) return@withLock previous.server()
        val renamed = previous.copy(name = value)
        withContext(NonCancellable) {
            tokens.savePairings(state.copy(
                servers = state.servers.map { if (it.origin == origin) renamed else it },
            ).encoded())
        }
        renamed.server()
    }

    /** No selection or installed API changes until the candidate's protected bootstrap succeeds. */
    @Throws(Exception::class)
    suspend fun switchServer(origin: String): RiffetApi = pairingChanges.withLock {
        val state = tokens.pairings()
        val target = state.servers.firstOrNull { it.origin == origin }
            ?: throw IllegalArgumentException(L10n.uiText("connection.pairingRemoved"))
        state.applyRoutes()
        val candidate = authenticated(target.baseUrl)
        if (withTimeoutOrNull(10_000) { candidate.bootstrap(); true } != true) {
            throw RiffetNetworkException(L10n.uiText("connection.bootstrapTimeout"), IllegalStateException("Service bootstrap timed out"))
        }
        val updated = state.copy(
            activeOrigin = origin,
            servers = state.servers.map { if (it.origin == origin) it.copy(lastUsedAt = platformNowMillis()) else it },
        )
        withContext(NonCancellable) {
            tokens.savePairings(updated.encoded())
            install(candidate)
        }
    }

    /**
     * The active server may have stopped answering where it is reached, e.g. its Mac joined another
     * network. Nothing changes while it still answers there; otherwise [candidates] are looked for
     * (discovered `scheme://host:port` addresses), and each, with the paired address itself, is asked
     * to prove it holds this device's record before any request with the token goes there. The first
     * that does becomes the route. Returns it, or null when none proved.
     */
    @Throws(Exception::class)
    suspend fun relocate(candidates: suspend () -> List<String>): String? {
        val current = pairingChanges.withLock {
            val state = tokens.pairings()
            state.servers.firstOrNull { it.origin == state.activeOrigin }
        } ?: return null
        val reached = current.route ?: current.baseUrl
        // A server that answers where it is reached had another reason to fail the read.
        if (http.provesDevice(reached, current.token)) return null
        val scheme = Url(current.baseUrl).protocol.name
        val found = (candidates().map { it.trim().trimEnd('/') } + current.baseUrl)
            .distinct()
            .filter { it != reached && runCatching { Url(it).protocol.name == scheme }.getOrDefault(false) }
            .firstOrNull { http.provesDevice(it, current.token) }
            ?: return null
        val route = found.takeUnless { serverOrigin(it) == current.origin }
        pairingChanges.withLock {
            val state = tokens.pairings()
            // Re-paired or forgotten meanwhile: the proof was for a credential no longer saved.
            if (state.servers.none { it.origin == current.origin && it.token == current.token }) return null
            val next = state.copy(servers = state.servers.map { if (it.origin == current.origin) it.copy(route = route) else it })
            withContext(NonCancellable) {
                tokens.savePairings(next.encoded())
                next.applyRoutes()
            }
        }
        return found
    }

    fun requireApi(): RiffetApi = api ?: throw RiffetNotConnectedException()
    fun apiOrNull(): RiffetApi? = api

    @Throws(Exception::class)
    suspend fun pair(payload: PairingPayload): IssuedDevice =
        pair(payload.baseUrl, payload.code, deviceInfo.deviceName, payload.name)

    @Throws(Exception::class)
    suspend fun pair(baseUrl: String, code: String, deviceName: String, name: String? = null): IssuedDevice =
        pairingChanges.withLock {
            val state = tokens.pairings()
            val target = probe(baseUrl)
            val origin = serverOrigin(target.baseUrl)
                ?: throw IllegalArgumentException(L10n.uiText("connection.invalidAddress"))
            val issued = withTimeoutOrNull(10_000) { target.pairDevice(code.trim(), deviceName) }
                ?: throw RiffetNetworkException(L10n.uiText("connection.pairingTimeout"), IllegalStateException("Device pairing timed out"))
            val previous = state.servers.firstOrNull { it.origin == origin }
            val saved = PairedCredential(
                origin = origin,
                baseUrl = target.baseUrl,
                token = issued.token,
                name = previous?.name ?: name?.trim()?.takeIf { it.isNotEmpty() },
                deviceId = issued.device.id,
                lastUsedAt = platformNowMillis(),
            )
            withContext(NonCancellable) {
                val next = state.copy(activeOrigin = origin, servers = state.servers.filterNot { it.origin == origin } + saved)
                tokens.savePairings(next.encoded())
                next.applyRoutes()
                connect(target.baseUrl)
            }
            issued
        }

    /** Removes only local authorization. Other saved services and remote tasks remain untouched. */
    @Throws(Exception::class)
    suspend fun forgetServer(origin: String): Boolean = pairingChanges.withLock {
        val state = tokens.pairings()
        val wasCurrent = state.activeOrigin == origin
        val disconnect = baseUrl?.let { serverOrigin(it) == origin } ?: wasCurrent
        withContext(NonCancellable) {
            val next = state.copy(
                activeOrigin = state.activeOrigin.takeUnless { wasCurrent },
                servers = state.servers.filterNot { it.origin == origin },
            )
            tokens.savePairings(next.encoded())
            next.applyRoutes()
            if (baseUrl?.let(::serverOrigin) == origin) {
                api = null
                baseUrl = null
            }
        }
        disconnect
    }

    @Throws(Exception::class)
    suspend fun forget() {
        val origin = baseUrl?.let(::serverOrigin) ?: pairingChanges.withLock { tokens.pairings().activeOrigin }
        if (origin != null) forgetServer(origin)
    }

    fun close() { http.close() }
}

/**
 * `scheme://host:port` of [url], lower-cased and with the default port spelled out, or null when it
 * is not an absolute http(s) or ws(s) URL. A WebSocket URL has the origin of its HTTP counterpart.
 */
fun serverOrigin(url: String): String? {
    // Ktor resolves a URL without a scheme against `http://localhost`; that is not an origin.
    if ("://" !in url) return null
    val parsed = runCatching { Url(url.trim()) }.getOrNull() ?: return null
    val scheme = when (parsed.protocol.name.lowercase()) {
        "http", "ws" -> "http"
        "https", "wss" -> "https"
        else -> return null
    }
    val host = parsed.host.lowercase().takeIf { it.isNotEmpty() } ?: return null
    val port = parsed.specifiedPort.takeIf { it > 0 } ?: if (scheme == "https") 443 else 80
    return "$scheme://$host:$port"
}

/**
 * The origin the stored token may be sent to, or null when no token is stored. A token stored before
 * origins were recorded belongs to the server stored with it; it is bound to that server here, once.
 */
suspend fun DeviceTokenStore.boundOrigin(): String? {
    loadPairings()?.let { return PairedServices.decode(it).activeOrigin }
    val token = load()?.takeIf { it.isNotEmpty() } ?: return null
    return loadOrigin() ?: bindToStoredServer(token)
}

/** The stored token when [url] has the origin it was issued by, and null for any other URL. */
suspend fun DeviceTokenStore.tokenFor(url: String): String? {
    val requestedOrigin = serverOrigin(url) ?: return null
    loadPairings()?.let { raw ->
        return PairedServices.decode(raw).servers.firstOrNull { it.origin == requestedOrigin }?.token
    }
    val token = load()?.takeIf { it.isNotEmpty() } ?: return null
    val origin = loadOrigin() ?: bindToStoredServer(token) ?: return null
    return token.takeIf { serverOrigin(url) == origin }
}

private suspend fun DeviceTokenStore.bindToStoredServer(token: String): String? {
    val origin = loadServer()?.let(::serverOrigin) ?: return null
    // Recording the binding is an optimisation; the origin is right whether or not it was persisted.
    try {
        save(token, origin)
    } catch (cancellation: CancellationException) {
        throw cancellation
    } catch (failure: Exception) {
        AppLog.log("auth", "token bind failed ${failure::class.simpleName}")
    }
    return origin
}
