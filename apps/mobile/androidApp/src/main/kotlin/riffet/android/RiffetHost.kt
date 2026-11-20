package riffet.android

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import riffet.cache.ListCache
import riffet.cache.TimelineCache
import riffet.cache.createLocalFiles
import riffet.cache.createTranscriptIndex
import riffet.contracts.LIST_POLL_MS_BACKGROUND
import riffet.contracts.Session
import riffet.contracts.SessionState
import riffet.shared.AppLog
import riffet.shared.AppLanguages
import riffet.shared.DeviceControl
import riffet.shared.NativeFeature
import riffet.shared.NativeFeatures
import riffet.shared.RiffetApi
import riffet.shared.RiffetClientConfig
import riffet.shared.RiffetConnection
import riffet.shared.RiffetNetworkException
import riffet.shared.createServerDiscovery
import riffet.shared.createAppPreferences
import riffet.ui.composer.ComposerDrafts
import riffet.shared.createDeviceTokenStore
import riffet.shared.serverOrigin
import riffet.ui.composer.migrateLegacyOutbox
import riffet.ui.app.RiffetNavigation
import riffet.ui.state.ListPolling
import riffet.ui.state.SessionMarks
import riffet.ui.state.SessionStore
import riffet.ui.state.RiffetConnectionState
import riffet.ui.state.active
import riffet.ui.state.currentStep
import riffet.ui.platform.KeepAliveNotice

/**
 * The app's process-scoped state: the connection, the session store and the navigation.
 *
 * The Activity is the short-lived part. Android destroys it on a back-out from the home screen, a
 * density or font change, or memory pressure, while the process — kept up by [RiffetSyncService] —
 * goes on. Holding the store here is what lets the open session's stream outlive all of those, so
 * returning to the app shows the live transcript instead of reconnecting and replaying it.
 *
 * It also watches every conversation, not only the open one: the session list is re-read on a
 * short interval, and a conversation that finishes, fails or starts waiting becomes a notification
 * ([RiffetNotifier]). The process is kept up for that while any conversation is mid-turn.
 */
object RiffetHost {
    private val scope = MainScope()
    private lateinit var appContext: Context

    val navigation = RiffetNavigation()
    val drafts by lazy { ComposerDrafts(createAppPreferences()) }
    private val tokens by lazy { createDeviceTokenStore() }
    val connection: RiffetConnection by lazy {
        RiffetConnection(tokens, config = RiffetClientConfig(features = listOf("pi-agent", "antigravity-agent", "projectless-tasks")))
    }
    var currentOrigin: String? = null
        private set

    fun isCurrentStore(store: SessionStore): Boolean = _store.value === store
    val notifier: RiffetNotifier by lazy { RiffetNotifier(appContext) }
    private val features get() = NativeFeatures.shared

    private val _store = MutableStateFlow<SessionStore?>(null)
    val store: StateFlow<SessionStore?> = _store.asStateFlow()

    /** True until the stored pairing has been read; the unpaired screen must not flash before it. */
    private val _restoring = MutableStateFlow(true)
    val restoring: StateFlow<Boolean> = _restoring.asStateFlow()

    /** What the keep-alive notification says; see [LiveStatus]. */
    private val _live = MutableStateFlow(LiveStatus.IDLE)
    val live: StateFlow<LiveStatus> = _live.asStateFlow()

    /** Whether any server is saved on this device; read with the restore, so the first frame already knows. */
    var hasSavedPairing = true
        private set

    private var storeScope: CoroutineScope? = null

    /** Saved replies (收藏) for the open transcript and the sidebar's bookmarks; null until installed. */
    var marks: SessionMarks? = null
        private set
    private var restoreStarted = false
    private var keepAlive = false
    private var foreground = false
    /** [foreground] as a flow: an idle stream keeps the service only while the app is in front. */
    private val inFront = MutableStateFlow(false)
    private var pendingStop: Job? = null

    private val discovery by lazy { createServerDiscovery() }
    private var relocating: Job? = null
    private var relocateTriedAt = 0L

    /** Asks the poll loop for a read now instead of at the end of its interval; one sent mid-read is kept. */
    private val pokes = Channel<Unit>(Channel.CONFLATED)

    /** The installed store's device copy, closed when a new pairing replaces it. */
    private var cache: TimelineCache? = null
    private var cacheFinalizer: Job? = null

    /** When each mid-turn conversation was first seen mid-turn; the progress clock starts there. */
    private val activeSince = mutableMapOf<String, Long>()

    /** The default network is gone; a failed read then says nothing about the app being cut off. */
    private var networkLost = false

    /**
     * Evidence, gathered while in the background with the keep-alive service up, that the system
     * cut this app off: Android reported its network blocked, or reads failed with a network up.
     * Judged on the way back ([onForeground]); see [KeepAliveNotice].
     */
    private var blockedInBackground = false
    private var backgroundFailures = 0

    /** Failures alone are confirmed by a read that succeeds once in front: the server was up. */
    private var cutOffPending = false

    /** Shortcuts the launcher's rate limit refused; published again on the next [onForeground]. */
    private var pendingShortcuts: Pair<List<RiffetShortcuts.Entry>, String>? = null

    @OptIn(ExperimentalCoroutinesApi::class)
    fun initialize(context: Context) {
        appContext = context.applicationContext
        RiffetDevice.initialize(appContext)
        val version = runCatching { appContext.packageManager.getPackageInfo(appContext.packageName, 0).versionName }.getOrNull()
        AppLog.log("app", "start version=$version android=${android.os.Build.VERSION.SDK_INT} device=${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")
        scope.launch {
            _store
                .flatMapLatest { store ->
                    if (store == null) {
                        flowOf(false)
                    } else {
                        // A rejected token ends the keep-alive: nothing it could receive would be authorised.
                        // A device that agents may call stays reachable (docs/DEVICES.md §3). An open but
                        // idle stream counts only in front: in the background it would hold the ongoing
                        // notification, and the status-bar island with it, after every turn has ended.
                        combine(store.connection, activeSessions(store), store.unauthenticated, DeviceControl.allowed, inFront) { connection, active, signedOut, device, front ->
                            !signedOut && ((front && connection != RiffetConnectionState.Idle) || active.isNotEmpty() || device)
                        }
                    }
                }
                .distinctUntilChanged()
                .collect { active ->
                    AppLog.log("app", "keepAlive=$active")
                    keepAlive = active
                    syncKeepAlive()
                }
        }
        scope.launch { _store.collectLatest { store -> if (store != null) watch(store) } }
        watchNetwork()
        MetricsReporter.run(scope, inFront) { connection.apiOrNull() }
        // Whatever the reader opens is read: its alert has nothing left to say.
        scope.launch {
            snapshotFlow { navigation.session?.id }.collect { id -> if (id != null) currentOrigin?.let { notifier.cancel(id, it) } }
        }
    }

    /**
     * A default network that comes back after being lost redials a stream that died with it and
     * reads the list now, instead of waiting out the transport's or the poll's backoff.
     */
    private fun watchNetwork() {
        val connectivity = appContext.getSystemService(ConnectivityManager::class.java) ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onLost(network: Network) {
                scope.launch { networkLost = true }
            }

            override fun onAvailable(network: Network) {
                scope.launch {
                    if (!networkLost) return@launch
                    networkLost = false
                    AppLog.log("app", "network restored")
                    if (foreground) _store.value?.wake()
                    pokes.trySend(Unit)
                    RiffetDevice.kick()
                }
            }

            // Android 10+: the network is up but this app may not use it (Doze, a background
            // restriction, a maker's power manager that goes through the platform).
            override fun onBlockedStatusChanged(network: Network, blocked: Boolean) {
                scope.launch {
                    AppLog.log("app", "network blocked=$blocked foreground=$foreground keepAlive=$keepAlive")
                    if (blocked && !foreground && keepAlive) blockedInBackground = true
                }
            }
        }
        try {
            connectivity.registerDefaultNetworkCallback(callback)
        } catch (failure: RuntimeException) {
            // Too many callbacks or a missing permission: the poll's own backoff still recovers.
            AppLog.log("app", "network callback unavailable ${failure::class.simpleName}: ${failure.message}")
        }
    }

    /** Polls, notifies and describes progress for one store, for as long as it is installed. */
    private suspend fun watch(store: SessionStore) = coroutineScope {
        val origin = currentOrigin ?: return@coroutineScope
        connection.apiOrNull()?.takeIf { serverOrigin(it.baseUrl) == origin }?.let { api ->
            launch { RiffetDevice.watch(store, api, origin, marks, { foreground || keepAlive }) { id -> foreground && navigation.session?.id == id } }
        }
        launch {
            store.activity.collect { activity ->
                notifier.resolve(activity.sessions, origin)
                if (!features.isOn(NativeFeature.ALERTS)) return@collect
                for (alert in activity.alerts) {
                    if (foreground && navigation.session?.id == alert.session.id) continue
                    launch { notifier.alert(store, alert, origin) }
                }
            }
        }
        launch {
            store.list
                .filter { it.loaded || it.sessions.isNotEmpty() }
                .map { RiffetShortcuts.recent(it.sessions) }
                .distinctUntilChanged()
                .collect { entries ->
                    pendingShortcuts = entries to origin
                    publishShortcuts()
                }
        }
        launch {
            combine(
                activeSessions(store),
                store.selected,
                combine(store.timeline, AppLanguages.changes) { timeline, language -> language to currentStep(timeline) }.distinctUntilChanged(),
                store.connection,
            ) { active, selected, step, connection -> describe(active, selected, step.second, connection) }
                .distinctUntilChanged()
                .collect { _live.value = it }
        }
        // Until the server rejects the token; then only a new pairing (a new store) polls again.
        val savedMarks = marks
        var failures = 0
        while (!store.unauthenticated.value) {
            val visible = foreground
            if (visible || keepAlive) {
                failures = try {
                    store.pollSessions()
                    // Until the first full read succeeds, a failed one is reported in the list, not thrown.
                    if (store.list.value.error != null && !store.unauthenticated.value && !networkLost) relocateSoon()
                    if (visible && cutOffPending) reportCutOff("reads failed in background")
                    0
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: Throwable) {
                    // Unreachable for now; the next read tries again, later each time it fails.
                    AppLog.log("app", "poll failed ${error::class.simpleName}: ${error.message}")
                    if (!visible && keepAlive && !networkLost) backgroundFailures++
                    if (error is RiffetNetworkException && !networkLost) relocateSoon()
                    if (visible) cutOffPending = false
                    failures + 1
                }
                try {
                    savedMarks?.poll()
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: Throwable) {
                    AppLog.log("app", "marks poll failed ${error::class.simpleName}: ${error.message}")
                }
            }
            val busy = features.isOn(NativeFeature.BACKGROUND_WATCH) &&
                store.list.value.sessions.any { it.archivedAt == null && it.state.active }
            val interval = when {
                // Slower while the open stream already covers the list; see `ListPolling`.
                visible -> ListPolling.foregroundDelay(store, failures)
                busy -> ListPolling.backoff(ACTIVE_POLL_MILLIS, failures)
                else -> ListPolling.backoff(QUIET_POLL_MILLIS, failures)
            }
            withTimeoutOrNull(interval) { pokes.receive() }
        }
        AppLog.log("app", "polling stopped: device token rejected")
    }

    /**
     * Reads fail with a network up: the Mac may have a new address (another network, a new lease).
     * It is looked for on this network at most once a minute; [RiffetConnection.relocate] first checks
     * that the current address really stopped answering.
     */
    private fun relocateSoon() {
        val now = System.currentTimeMillis()
        if (relocating?.isActive == true || now - relocateTriedAt < RELOCATE_INTERVAL_MILLIS) return
        relocateTriedAt = now
        relocating = scope.launch {
            try {
                val route = connection.relocate { discovery.discover().map { "http://${it.host}:${it.port}" } } ?: return@launch
                AppLog.log("app", "server reached at $route")
                _store.value?.wake()
                pokes.trySend(Unit)
                RiffetDevice.kick()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                AppLog.log("app", "relocate failed ${failure::class.simpleName}: ${failure.message}")
            }
        }
    }

    /**
     * The conversations mid-turn that the host follows in the background: none while 后台跟进 is
     * off, and then the process stays up only for an open stream, as it did before.
     */
    private fun activeSessions(store: SessionStore): Flow<List<Session>> =
        combine(store.list, snapshotFlow { features.isOn(NativeFeature.BACKGROUND_WATCH) }) { list, watching ->
            if (watching) list.sessions.filter { it.archivedAt == null && it.state.active } else emptyList()
        }.distinctUntilChanged()

    private fun describe(active: List<Session>, selected: Session?, step: String?, connection: RiffetConnectionState): LiveStatus {
        val now = System.currentTimeMillis()
        activeSince.keys.retainAll(active.map { it.id }.toSet())
        active.forEach { activeSince.getOrPut(it.id) { now } }
        val waiting = active.filter { it.state == SessionState.WAITING }
        val running = active - waiting.toSet()
        val others = { count: Int ->
            if (count > 0) " " + hostText(riffet.shared.R.string.host_live_others, count) else ""
        }
        return when {
            waiting.isNotEmpty() -> {
                val first = waiting.first()
                LiveStatus(first.shownTitle, hostText(riffet.shared.R.string.host_live_waiting) + others(active.size - 1), null, running = false, sessionId = first.id)
            }
            running.isNotEmpty() -> {
                val primary = running.firstOrNull { it.id == selected?.id } ?: running.first()
                val doing = (if (primary.id == selected?.id) step else null) ?: hostText(riffet.shared.R.string.host_live_running)
                LiveStatus(primary.shownTitle, doing + others(active.size - 1), activeSince[primary.id], running = true, sessionId = primary.id)
            }
            else -> LiveStatus(
                title = selected?.shownTitle ?: "Riffet",
                text = when (connection) {
                    RiffetConnectionState.Reconnecting -> hostText(riffet.shared.R.string.host_live_reconnecting)
                    is RiffetConnectionState.Failed -> hostText(riffet.shared.R.string.host_live_disconnected)
                    else -> hostText(riffet.shared.R.string.host_live_connected)
                },
                since = null,
                running = false,
                sessionId = selected?.id,
            )
        }
    }

    /** A host-layer string; empty before [initialize] has run, when no notification can be shown yet. */
    internal fun hostText(id: Int, vararg args: Any): String =
        if (::appContext.isInitialized) AppLanguages.localize(appContext).getString(id, *args) else ""

    /**
     * Restores the paired connection once per process. [serverUrl] is the adb override (see
     * [RiffetActivity]); it replaces whatever is connected, so it is honoured on every launch.
     */
    fun start(serverUrl: String?) {
        val override = serverUrl?.takeIf { it.isNotBlank() }
        if (restoreStarted && override == null) return
        restoreStarted = true
        scope.launch {
            hasSavedPairing = runCatching { connection.pairedServers().isNotEmpty() }.getOrDefault(true)
            try {
                val legacyServer = tokens.loadServer()
                val legacyOrigin = tokens.loadOrigin() ?: legacyServer?.let(::serverOrigin)
                migrateLegacyOutbox(legacyServer?.takeIf { serverOrigin(it) == legacyOrigin })
                val api = override?.let { connection.connectAndRemember(it) } ?: connection.restore()
                if (api != null && (override != null || _store.value == null)) install(api)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                // An unreadable credential leaves the device unpaired for this launch, not crashing on every one.
                AppLog.log("app", "restore failed ${failure::class.simpleName}: ${failure.message}")
            } finally {
                _restoring.value = false
            }
        }
    }

    /** The paired store, restoring it first when a notification press is what started the process. */
    suspend fun awaitStore(): SessionStore? {
        _store.value?.let { return it }
        start(null)
        _restoring.first { !it }
        return _store.value
    }

    /** Work that must outlive its caller, e.g. a notification press. */
    fun launch(block: suspend CoroutineScope.() -> Unit): Job = scope.launch(block = block)

    /** For writes started from the UI, which an Activity recreated mid-request must not cancel. */
    val writeScope: CoroutineScope get() = scope

    /**
     * A fresh store over [api], replacing the previous one and everything it was subscribed to. Its
     * device copy is the one kept for [api]'s server, so re-pairing the same Mac keeps it.
     */
    fun install(api: RiffetApi) {
        val replacing = _store.value != null
        releaseStore()
        if (replacing) navigation.resetForServer(skipRestore = true)
        val child = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        storeScope = child
        AppLog.log("app", "store installed for ${api.baseUrl}")
        val next = TimelineCache(createLocalFiles(), api.baseUrl, index = createTranscriptIndex(api.baseUrl), previousWrites = cacheFinalizer)
        cache = next
        currentOrigin = serverOrigin(api.baseUrl)
        marks = SessionMarks(api, child)
        _store.value = SessionStore(api = api, scope = child, timelineCache = next, listCache = ListCache(createLocalFiles(), api.baseUrl))
    }

    fun uninstall() {
        releaseStore()
        navigation.resetForServer()
        pendingShortcuts = null
        RiffetShortcuts.clear(appContext)
    }

    private fun publishShortcuts() {
        val (entries, origin) = pendingShortcuts ?: return
        if (RiffetShortcuts.publish(appContext, entries, origin)) pendingShortcuts = null
    }

    private fun reportCutOff(reason: String) {
        cutOffPending = false
        AppLog.log("app", "background cut-off: $reason")
        KeepAliveNotice.cutOffAt = System.currentTimeMillis()
    }

    private fun releaseStore() {
        val finalWrite = _store.value?.captureFinalFlush()
        val previousCache = cache
        marks = null
        _store.value?.clear()
        storeScope?.cancel()
        storeScope = null
        cache = null
        currentOrigin = null
        _store.value = null
        _live.value = LiveStatus.IDLE
        activeSince.clear()
        if (previousCache != null) {
            val previousFinalizer = cacheFinalizer
            cacheFinalizer = scope.launch {
                previousFinalizer?.join()
                try { finalWrite?.invoke() } finally { previousCache.close() }
            }
        }
    }

    /** The app came to the front: redial a stream that died while it was away, and catch up on the list. */
    fun onForeground() {
        AppLog.log("app", "foreground")
        foreground = true
        inFront.value = true
        when {
            blockedInBackground -> reportCutOff("network blocked in background")
            backgroundFailures >= CUT_OFF_FAILURES -> cutOffPending = true
        }
        blockedInBackground = false
        backgroundFailures = 0
        publishShortcuts()
        _store.value?.wake()
        pokes.trySend(Unit)
        // A permission changed in system settings while away reaches the server's copy here.
        RiffetDevice.platform.refresh()
        RiffetDevice.kick()
        navigation.session?.id?.let { id -> currentOrigin?.let { notifier.cancel(id, it) } }
        syncKeepAlive()
    }

    /** The app left the front: the open transcript goes to the device now, in case the process does not come back. */
    fun onBackground() {
        AppLog.log("app", "background")
        foreground = false
        inFront.value = false
        _store.value?.flush()
    }

    /**
     * Runs [RiffetSyncService] while a conversation is mid-turn, agents may call this device, or a
     * session stream is open with the app in front.
     * Starting it is only allowed while the app is in front, so a refusal is ignored here and
     * retried by the next [onForeground].
     */
    private fun syncKeepAlive() {
        if (!::appContext.isInitialized) return
        val intent = Intent(appContext, RiffetSyncService::class.java)
        if (keepAlive) {
            pendingStop?.cancel()
            pendingStop = null
            try {
                appContext.startForegroundService(intent)
            } catch (_: IllegalStateException) {
            } catch (_: SecurityException) {
            }
        } else if (pendingStop == null) {
            // A turn that just ended still posts its alert, which reads the reply first; a frozen
            // process would lose it, so the service outlives the last active turn briefly.
            pendingStop = scope.launch {
                delay(STOP_GRACE_MILLIS)
                pendingStop = null
                if (!keepAlive) appContext.stopService(intent)
            }
        }
    }

    private const val RELOCATE_INTERVAL_MILLIS = 60_000L

    /** How long the service stays after nothing is left to keep; see [syncKeepAlive]. */
    private const val STOP_GRACE_MILLIS = 15_000L

    /** Background reads that must fail, with a network up, before a return checks for a cut-off. */
    private const val CUT_OFF_FAILURES = 2

    /** In the background while a conversation is mid-turn: soon enough that a finish is news. */
    private const val ACTIVE_POLL_MILLIS = 10_000L

    /** In the background with only an idle stream open: it still notices a turn started elsewhere. */
    private const val QUIET_POLL_MILLIS = LIST_POLL_MS_BACKGROUND.toLong()
}

/**
 * What the keep-alive notification shows: the conversation it is about, what it is doing, and since
 * when ([since] drives the notification's running clock while [running]).
 */
data class LiveStatus(
    val title: String,
    val text: String,
    val since: Long?,
    val running: Boolean,
    val sessionId: String?,
) {
    companion object {
        val IDLE: LiveStatus
            get() = LiveStatus("Riffet", RiffetHost.hostText(riffet.shared.R.string.host_live_connected), null, running = false, sessionId = null)
    }
}
