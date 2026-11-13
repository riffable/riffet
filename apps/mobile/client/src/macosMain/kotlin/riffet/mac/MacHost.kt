package riffet.mac

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
import kotlinx.coroutines.launch
import kotlinx.coroutines.plus
import kotlinx.coroutines.withTimeoutOrNull
import riffet.cache.TimelineCache
import riffet.cache.ListCache
import riffet.cache.createLocalFiles
import riffet.cache.createTranscriptIndex
import riffet.contracts.AgentIds
import riffet.shared.AppLog
import riffet.shared.DeviceTokenStore
import riffet.shared.IssuedDevice
import riffet.contracts.TerminalAppearance
import riffet.shared.TerminalConnection
import riffet.shared.RiffetApi
import riffet.shared.RiffetClientConfig
import riffet.shared.RiffetConnection
import riffet.shared.serverOrigin
import riffet.ui.state.SessionMarks
import riffet.ui.state.SessionStore
import riffet.ui.state.RiffetConnectionState
import riffet.ui.state.active
import riffet.ui.timeline.TimelinePresenter

/**
 * Synchronous secret storage, implemented by the app over the Keychain. Kept synchronous so Swift
 * implements it without bridging Kotlin's `suspend` methods.
 */
interface SecretStore {
    fun read(account: String): String?
    fun write(account: String, value: String?)
}

/** One server's device token in [secrets]. A Mac can be paired with several servers at once. */
class ServerTokenStore(private val secrets: SecretStore, private val baseUrl: String) : DeviceTokenStore {
    private val account = tokenAccount(baseUrl)

    override suspend fun loadPairings(): String? = secrets.read("$account:pairings")

    // Keep the standalone token: the Mac's server management also reads it directly.
    override suspend fun savePairings(value: String) = secrets.write("$account:pairings", value)

    override suspend fun load(): String? = secrets.read(account)

    /** Each store holds one server's token, so the token's origin is always that server's. */
    override suspend fun loadOrigin(): String? = if (load().isNullOrEmpty()) null else serverOrigin(baseUrl)

    override suspend fun save(token: String, origin: String) {
        secrets.write(account, token)
        secrets.write("$account:pairings", null)
    }

    override suspend fun clear() {
        secrets.write(account, null)
        secrets.write("$account:pairings", null)
    }

    override suspend fun loadServer(): String = baseUrl

    override suspend fun saveServer(baseUrl: String) = Unit
}

fun tokenAccount(baseUrl: String): String = "device-token:" + baseUrl.trimEnd('/').lowercase()

/**
 * One extra window's conversation state: its own stream, transcript and presentation, on the host's
 * connection. The session lists, and the poll that refreshes them, stay with the main store.
 */
class WindowSession internal constructor(
    val store: SessionStore,
    val presenter: TimelinePresenter,
    private val scope: CoroutineScope,
    private val onClose: (WindowSession, suspend () -> Unit) -> Unit,
) {
    private var closed = false

    /** Redials a stream that died while the app was away; a live one is left alone. */
    internal fun wake() {
        val state = store.connection.value
        if (state is RiffetConnectionState.Reconnecting || state is RiffetConnectionState.Failed) store.retry()
    }

    /**
     * Stops the window's work and returns its last transcript write, frozen before `clear` cancels
     * the store's jobs. The host runs it in a scope that outlives this one.
     */
    internal fun shutdown(): suspend () -> Unit {
        if (closed) return {}
        closed = true
        val finalWrite = store.captureFinalFlush()
        store.clear()
        scope.cancel()
        return finalWrite
    }

    fun close() {
        onClose(this, shutdown())
    }
}

/**
 * The macOS app's process-scoped client state, the counterpart of Android's `RiffetHost`: the
 * connection, the session store with its device copy, and the session-list poll that turns state
 * transitions into [SessionStore.activity] (which the app turns into notifications) and keeps the
 * saved replies ([marks]) current.
 *
 * Unlike a phone there is no keep-alive to negotiate: the app polls faster while a window is in
 * front ([foreground]) or a conversation is mid-turn, and slowly otherwise.
 */
class MacHost(private val secrets: SecretStore) {
    /** A failed background job is logged; on Kotlin/Native an unhandled one would end the process. */
    private val failures = CoroutineExceptionHandler { _, error ->
        AppLog.log("app", "background failure ${error::class.simpleName}: ${error.message}")
    }
    private val scope = MainScope() + failures

    private val _store = MutableStateFlow<SessionStore?>(null)
    val store: StateFlow<SessionStore?> = _store.asStateFlow()

    private var storeScope: CoroutineScope? = null
    private var cache: ListCache? = null
    private var timelines: TimelineCache? = null
    private val windows = mutableListOf<WindowSession>()
    private var poll: Job? = null
    private val pokes = Channel<Unit>(Channel.CONFLATED)

    var connection: RiffetConnection? = null
        private set

    /** The installed store's transcript presentation, computed off the main thread. */
    var presenter: TimelinePresenter? = null
        private set

    /** The installed server's saved replies, refreshed by the same poll as the session list. */
    var marks: SessionMarks? = null
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
                windows.toList().forEach { it.wake() }
                poke()
            } else {
                flushAll()
            }
        }

    /** Starts writing every open transcript to the device, the main store's and each window's. */
    fun flushAll() {
        _store.value?.flush()
        windows.toList().forEach { it.store.flush() }
    }

    fun hasToken(baseUrl: String): Boolean = !secrets.read(tokenAccount(baseUrl)).isNullOrEmpty()

    fun saveToken(baseUrl: String, token: String) = secrets.write(tokenAccount(baseUrl), token)

    fun forgetToken(baseUrl: String) = secrets.write(tokenAccount(baseUrl), null)

    /** Redeems a pairing code against [baseUrl] and stores the device token it returns. */
    @Throws(Exception::class)
    suspend fun pair(baseUrl: String, code: String, deviceName: String): IssuedDevice {
        val url = baseUrl.trimEnd('/')
        val pairing = RiffetConnection(ServerTokenStore(secrets, url))
        try {
            val issued = pairing.probe(url).pairDevice(code, deviceName)
            saveToken(url, issued.token)
            return issued
        } finally {
            pairing.close()
        }
    }

    /** A fresh connection and store for [baseUrl], replacing whatever was installed. */
    fun install(baseUrl: String): SessionStore {
        uninstall()
        val url = baseUrl.trimEnd('/')
        // The server withholds quick chats, pi and plugin Agents from clients that do not name the features.
        val next = RiffetConnection(
            ServerTokenStore(secrets, url),
            config = RiffetClientConfig(features = listOf("quick-chat", "pi-agent", "antigravity-agent", "projectless-tasks", AgentIds.PLUGIN_AGENTS_FEATURE)),
        )
        connection = next
        val api = next.connect(url)
        api.terminalAppearance = terminalAppearance
        val child = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + failures)
        storeScope = child
        // The search index belongs to the conversations' device copy.
        val lists = ListCache(createLocalFiles(), api.baseUrl)
        cache = lists
        val lanes = TimelineCache(createLocalFiles(), api.baseUrl, index = createTranscriptIndex(api.baseUrl))
        timelines = lanes
        val created = SessionStore(api = api, scope = child, listCache = lists, timelineCache = lanes)
        presenter = TimelinePresenter(created, child, withOutputs = true)
        val savedMarks = SessionMarks(api, child)
        marks = savedMarks
        _store.value = created
        AppLog.log("app", "store installed for $url")
        created.refresh()
        poll = scope.launch { pollLoop(created, savedMarks) }
        return created
    }

    /**
     * The conversation state for one more window, or null while no server is installed. It shares
     * the connection and the device copies (one instance each behind one lock, so two stores never
     * race on its files or index) but runs no poll: the main store keeps the lists fresh. The
     * caller closes it when its window goes away; [uninstall] closes any left.
     */
    fun openWindowStore(): WindowSession? {
        val api = api ?: return null
        val lists = cache ?: return null
        val parent = storeScope?.coroutineContext?.get(Job) ?: return null
        val child = CoroutineScope(SupervisorJob(parent) + Dispatchers.Main.immediate + failures)
        val created = SessionStore(api = api, scope = child, listCache = lists, timelineCache = timelines)
        val window = WindowSession(created, TimelinePresenter(created, child, withOutputs = true), child) { closed, finalWrite ->
            windows.remove(closed)
            writeAfterClose(listOf(finalWrite))
        }
        windows += window
        return window
    }

    fun uninstall() {
        poll?.cancel()
        poll = null
        val finalWrites = windows.toList().map { it.shutdown() } + listOfNotNull(_store.value?.captureFinalFlush())
        windows.clear()
        _store.value?.clear()
        _store.value = null
        presenter = null
        marks = null
        storeScope?.cancel()
        storeScope = null
        cache = null
        val previousTimelines = timelines
        timelines = null
        writeAfterClose(finalWrites, previousTimelines)
        connection?.close()
        connection = null
    }

    /**
     * Runs the final transcript writes, then closes [closingTimelines]. They run in their own short scope: the
     * store scope they came from is cancelled, and [close] cancels this host's.
     */
    private fun writeAfterClose(finalWrites: List<suspend () -> Unit>, closingTimelines: TimelineCache? = null) {
        val finalizer = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + failures)
        finalizer.launch {
            try {
                finalWrites.forEach { it() }
            } finally {
                closingTimelines?.close()
            }
        }.invokeOnCompletion { finalizer.cancel() }
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
        var columns = 100
        var rows = 40
        return TerminalConnection(api, terminalId, clientId, scope,
            onOutput = { data, fresh -> onOutput(data, fresh, columns, rows) },
            onSnapshotGrid = { cols, height -> columns = cols; rows = height },
        ).also { it.start() }
    }

    /** Work that must outlive its caller, such as a notification action. */
    fun launch(block: suspend CoroutineScope.() -> Unit): Job = scope.launch(block = block)

    fun close() {
        uninstall()
        scope.cancel()
    }

    private suspend fun pollLoop(store: SessionStore, marks: SessionMarks) {
        while (true) {
            try {
                store.pollSessions()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                AppLog.log("app", "poll failed ${error::class.simpleName}: ${error.message}")
            }
            try {
                marks.poll()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                AppLog.log("app", "marks poll failed ${error::class.simpleName}: ${error.message}")
            }
            val busy = store.list.value.sessions.any { it.archivedAt == null && it.state.active }
            val interval = when {
                foreground -> FOREGROUND_POLL_MILLIS
                busy -> ACTIVE_POLL_MILLIS
                else -> QUIET_POLL_MILLIS
            }
            withTimeoutOrNull(interval) { pokes.receive() }
        }
    }

    private companion object {
        const val FOREGROUND_POLL_MILLIS = 5_000L
        const val ACTIVE_POLL_MILLIS = 10_000L
        const val QUIET_POLL_MILLIS = 30_000L
    }
}
