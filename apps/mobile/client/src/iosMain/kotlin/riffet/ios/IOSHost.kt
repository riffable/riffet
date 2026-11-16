package riffet.ios

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.plus
import kotlinx.coroutines.withTimeoutOrNull
import riffet.cache.TimelineCache
import riffet.cache.ListCache
import riffet.cache.createLocalFiles
import riffet.cache.createTranscriptIndex
import riffet.shared.AppLog
import riffet.shared.DeviceTokenStore
import riffet.shared.IssuedDevice
import riffet.contracts.TerminalAppearance
import riffet.shared.TerminalConnection
import riffet.shared.RiffetApi
import riffet.shared.RiffetConnection
import riffet.shared.RiffetClientConfig
import riffet.shared.tokenFor
import riffet.shared.createBiometricGate
import riffet.shared.serverOrigin
import riffet.shared.createDeviceTokenStore
import riffet.shared.PairingPayload
import riffet.shared.PairedServer
import kotlinx.coroutines.runBlocking
import riffet.ui.composer.createIosOutboxStore
import riffet.ui.state.SessionStore
import riffet.ui.state.ListPolling
import riffet.ui.state.ListsFeed
import riffet.ui.state.SessionListState
import riffet.ui.timeline.TimelinePresenter

/** iPhone shared client: foreground-only subscriptions, durable state and origin-bound credentials. */
class IOSHost {
    /** A failed background job is logged; on Kotlin/Native an unhandled one would end the process. */
    private val failures = CoroutineExceptionHandler { _, error ->
        AppLog.log("app", "background failure ${error::class.simpleName}: ${error.message}")
    }
    private val scope = MainScope() + failures
    internal val tokens = createDeviceTokenStore()
    internal val clientConfig = RiffetClientConfig(features = listOf("quick-chat", "pi-agent", "antigravity-agent"))

    private val _store = MutableStateFlow<SessionStore?>(null)
    val store: StateFlow<SessionStore?> = _store.asStateFlow()

    private var storeScope: CoroutineScope? = null
    private var cache: ListCache? = null
    private var timelines: TimelineCache? = null
    private var cacheFinalizer: Job? = null
    private var poll: Job? = null
    private var feed: ListsFeed? = null
    private val pokes = Channel<Unit>(Channel.CONFLATED)

    var connection: RiffetConnection? = null
        private set

    /** The installed store's transcript presentation, computed off the main thread. */
    var presenter: TimelinePresenter? = null
        private set

    val api: RiffetApi? get() = connection?.apiOrNull()
    var terminalAppearance: TerminalAppearance? = null
        set(value) { field = value; api?.terminalAppearance = value }

    var foreground: Boolean = true
        set(value) {
            if (field == value) return
            field = value
            if (value) {
                _store.value?.wake()
                poke()
                _store.value?.let { startPoll(it) }
            } else {
                poll?.cancel()
                poll = null
                _store.value?.pause()
            }
        }

    @Throws(Exception::class)
    suspend fun authorizationFor(url: String): String? = tokens.tokenFor(url)?.let { "Bearer $it" }

    @Throws(Exception::class)
    suspend fun authenticate(reason: String): Boolean = createBiometricGate().authenticate(reason)

    @Throws(Exception::class)
    fun parsePairing(raw: String): PairingPayload = PairingPayload.parse(raw)

    @Throws(Exception::class)
    fun hasToken(baseUrl: String): Boolean = runBlocking {
        !tokens.tokenFor(baseUrl).isNullOrEmpty()
    }

    @Throws(Exception::class)
    suspend fun pair(payload: PairingPayload): IssuedDevice {
        val pairing = RiffetConnection(tokens, config = clientConfig)
        return try { pairing.pair(payload) } finally { pairing.close() }
    }

    @Throws(Exception::class)
    suspend fun pair(baseUrl: String, code: String, deviceName: String): IssuedDevice {
        return pair(baseUrl, code, deviceName, null)
    }

    @Throws(Exception::class)
    suspend fun pair(baseUrl: String, code: String, deviceName: String, name: String?): IssuedDevice {
        val pairing = RiffetConnection(tokens, config = clientConfig)
        return try {
            pairing.pair(baseUrl, code, deviceName, name)
        } finally { pairing.close() }
    }

    @Throws(Exception::class)
    suspend fun pairedServers(): List<PairedServer> {
        val saved = RiffetConnection(tokens, config = clientConfig)
        return try { saved.pairedServers() } finally { saved.close() }
    }

    /** Mirrors the shared rule so the editor can disable Save before a round trip. */
    fun isValidServerName(name: String): Boolean = PairedServer.isValidName(name)

    @Throws(Exception::class)
    suspend fun renameServer(origin: String, name: String): PairedServer {
        val saved = RiffetConnection(tokens, config = clientConfig)
        return try { saved.renameServer(origin, name) } finally { saved.close() }
    }

    /** Keep the installed store alive until the target's saved authorization has been verified. */
    @Throws(Exception::class)
    suspend fun switchServer(origin: String): SessionStore {
        val next = RiffetConnection(tokens, config = clientConfig)
        val api = try { next.switchServer(origin) } catch (error: Throwable) {
            next.close()
            throw error
        }
        return install(next, api)
    }

    @Throws(Exception::class)
    suspend fun forgetServer(origin: String): Boolean {
        val saved = RiffetConnection(tokens, config = clientConfig)
        val current = try { saved.forgetServer(origin) } finally { saved.close() }
        if (current) uninstall()
        return current
    }

    @Throws(Exception::class)
    suspend fun restore(): SessionStore? {
        val next = RiffetConnection(tokens, config = clientConfig)
        val api = try { next.restore() } catch (error: Throwable) {
            next.close()
            throw error
        }
        if (api == null) { next.close(); return null }
        return install(next, api)
    }

    @Throws(Exception::class)
    suspend fun forget() {
        val saved = RiffetConnection(tokens, config = clientConfig)
        val url = try { saved.restore()?.baseUrl } finally { saved.close() }
        url?.let(::serverOrigin)?.let { forgetServer(it) }
    }

    /** A fresh connection and store for [baseUrl], replacing whatever was installed. */
    @Throws(Exception::class)
    fun install(baseUrl: String): SessionStore {
        val url = baseUrl.trimEnd('/')
        val next = RiffetConnection(tokens, config = clientConfig)
        return install(next, next.connect(url))
    }

    private fun install(next: RiffetConnection, api: RiffetApi): SessionStore {
        api.terminalAppearance = terminalAppearance
        uninstall()
        connection = next
        val child = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + failures)
        storeScope = child
        // The search index belongs to the conversations' device copy.
        val lists = ListCache(createLocalFiles(), api.baseUrl)
        cache = lists
        val lanes = TimelineCache(createLocalFiles(), api.baseUrl, index = createTranscriptIndex(api.baseUrl), previousWrites = cacheFinalizer)
        timelines = lanes
        val created = SessionStore(
            api = api, scope = child, outboxStore = createIosOutboxStore(api.baseUrl),
            timelineCache = lanes, listCache = lists,
        )
        presenter = TimelinePresenter(created, child)
        _store.value = created
        AppLog.log("app", "store installed for ${api.baseUrl}")
        created.refresh()
        if (foreground) startPoll(created, deferFirstRead = true)
        return created
    }

    fun uninstall() {
        poll?.cancel()
        poll = null
        val finalWrite = _store.value?.captureFinalFlush()
        _store.value?.clear()
        _store.value = null
        presenter = null
        storeScope?.cancel()
        storeScope = null
        val hadCache = cache != null
        cache = null
        val previousTimelines = timelines
        timelines = null
        if (hadCache) {
            // This write must outlive both the old store scope and close()'s host-scope cancel.
            // It retains the old cache and model, so switching servers cannot redirect its bytes.
            val finalizer = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + failures)
            val previousFinalizer = cacheFinalizer
            cacheFinalizer = finalizer.launch {
                previousFinalizer?.join()
                try { finalWrite?.invoke() } finally { previousTimelines?.close() }
            }.also { job -> job.invokeOnCompletion { finalizer.cancel() } }
        }
        connection?.close()
        connection = null
    }

    /** Asks the poll loop for a read now instead of at the end of its interval. */
    fun poke() {
        pokes.trySend(Unit)
    }

    /**
     * The terminal socket for [terminalId], on this host's scope. [onOutput] receives the server's
     * bytes as text; `fresh` marks the full-screen snapshot each connection starts with.
     */
    fun openTerminal(terminalId: String, clientId: String, onOutput: (String, Boolean, Int, Int) -> Unit): TerminalConnection? {
        val api = api ?: return null
        val owner = storeScope ?: return null
        var columns = 100
        var rows = 40
        return TerminalConnection(api, terminalId, clientId, owner,
            onOutput = { data, fresh -> onOutput(data, fresh, columns, rows) },
            onSnapshotGrid = { cols, height -> columns = cols; rows = height },
        ).also { it.start() }
    }

    /** A view from an uninstalled store must never open its terminal id on the new server. */
    fun openTerminalForStore(store: SessionStore, terminalId: String, clientId: String, onOutput: (String, Boolean, Int, Int) -> Unit): TerminalConnection? {
        if (_store.value !== store) return null
        return openTerminal(terminalId, clientId, onOutput)
    }

    /** Work that must outlive its caller, such as a notification action. */
    fun launch(block: suspend CoroutineScope.() -> Unit): Job = scope.launch(block = block)

    fun close() {
        uninstall()
        scope.cancel()
    }

    private fun startPoll(store: SessionStore, deferFirstRead: Boolean = false) {
        poll?.cancel()
        val api = api ?: return
        // The lists stream lives exactly as long as the poll: in front only, and then the poll is the fallback.
        poll = scope.launch {
            val listsFeed = ListsFeed(api, store, this)
            feed = listsFeed
            val stream = launch { listsFeed.run() }
            try {
                pollLoop(store, deferFirstRead)
            } finally {
                stream.cancel()
                if (feed === listsFeed) feed = null
            }
        }
    }

    private suspend fun pollLoop(store: SessionStore, deferFirstRead: Boolean) {
        // refresh() restores the device copy before its bootstrap request. A cached loaded=true
        // therefore cannot authorize a second list read while that first request is still in flight.
        if (!awaitIOSBootstrap(store.list, store.unauthenticated)) return
        // Installation already requested the authoritative list. Start its normal poll interval
        // after that answer; an explicit poke still wakes it immediately. Returning to foreground
        // deliberately skips this first wait so a backgrounded list becomes current right away.
        if (deferFirstRead) withTimeoutOrNull(ListPolling.foregroundDelay(store, 0)) { pokes.receive() }
        var failures = 0
        while (foreground && !store.unauthenticated.value) {
            // This read fulfils any wake request already queued before it starts. Requests arriving
            // during the network read remain queued and trigger the next iteration immediately.
            pokes.tryReceive()
            failures = try {
                store.pollSessions()
                0
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                AppLog.log("app", "poll failed ${error::class.simpleName}: ${error.message}")
                failures + 1
            }
            if (store.unauthenticated.value) break
            // Slower while the open stream covers the list, backing off while reads fail.
            withTimeoutOrNull(ListPolling.foregroundDelay(store, failures)) { pokes.receive() }
        }
    }

    /**
     * The device's network came back (NWPathMonitor): redial a stream that died with it and read the
     * list now rather than at the end of a backed-off interval.
     */
    fun networkRestored() {
        if (!foreground) return
        AppLog.log("app", "network restored")
        _store.value?.wake()
        feed?.kick()
        poke()
    }
}

/** Cache restoration is useful UI state; only a completed network bootstrap starts polling. */
internal suspend fun awaitIOSBootstrap(list: StateFlow<SessionListState>, unauthenticated: StateFlow<Boolean>): Boolean {
    combine(list, unauthenticated) { state, revoked ->
        revoked || (state.loaded && !state.loading && (state.cachedAt == null || state.error != null))
    }.first { it }
    return !unauthenticated.value
}
