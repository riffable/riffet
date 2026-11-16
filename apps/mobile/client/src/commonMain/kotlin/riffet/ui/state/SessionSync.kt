package riffet.ui.state

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.dropWhile
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlin.concurrent.atomics.AtomicLong
import kotlin.concurrent.atomics.ExperimentalAtomicApi
import kotlin.coroutines.CoroutineContext
import kotlin.coroutines.EmptyCoroutineContext
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeMark
import kotlin.time.TimeSource
import riffet.cache.MAIN_LANE
import riffet.cache.SyncWindow
import riffet.cache.TimelineCache
import riffet.cache.TimelineSnapshot
import riffet.contracts.NativeActivity
import riffet.i18n.L10n
import riffet.contracts.NativeContext
import riffet.contracts.NativeDeliveryState
import riffet.contracts.NativeHistoryState
import riffet.contracts.Run
import riffet.contracts.RunMetrics
import riffet.contracts.RunState
import riffet.contracts.STREAM_QUEUE_BYTES
import riffet.contracts.STREAM_QUEUE_FRAMES
import riffet.contracts.Session
import riffet.contracts.SyncFrame
import riffet.contracts.SyncLane
import riffet.contracts.SyncMode
import riffet.contracts.SyncOutline
import riffet.contracts.TimelinePage
import riffet.contracts.TimelineRow
import riffet.contracts.TurnOutlineV3
import riffet.contracts.RiffetJson
import riffet.core.PENDING_ROW_POS
import riffet.core.StoredSubagent
import riffet.core.SubagentTranscript
import riffet.core.TimelineItem
import riffet.core.pendingUserItem
import riffet.core.rowRun
import riffet.core.timelineItem
import riffet.core.userRowKey
import riffet.shared.AppLog
import riffet.shared.HEARTBEAT
import riffet.shared.StreamConnection
import riffet.shared.SyncCursor
import riffet.shared.SyncRejectedException
import riffet.shared.SyncServerTooOldException
import riffet.shared.TimelineAnchor
import riffet.shared.RiffetApi
import riffet.shared.RiffetHttpException
import riffet.shared.RiffetUnauthenticatedException
import riffet.shared.serverSpeaksSync
import riffet.shared.sessionBlob
import riffet.shared.syncChanges
import riffet.shared.syncStream
import riffet.shared.syncTimeline
import riffet.ui.composer.OutboxEntry

/** The open conversation's turns as hello and `outline` frames report them, oldest first. */
data class SyncOutlineState(val turnCount: Long, val turns: List<TurnOutlineV3>)

/** A subagent's lane as its page draws it; see [SessionStore.lane]. */
data class LaneView(
    val toolCallId: String,
    val items: List<TimelineItem> = emptyList(),
    /** The lane's first snapshot (or delta) has arrived; an empty lane can be real. */
    val loaded: Boolean = false,
    val hasBefore: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
)

/** What [SessionSync] needs of the store around it. */
internal class SyncHooks(
    val pendingEntries: (List<Run>) -> List<OutboxEntry>,
    val upsertEntries: (Run) -> Unit,
    val applySession: (Session) -> Unit,
    val signedOut: () -> Unit,
    val unauthenticated: StateFlow<Boolean>,
    val liveMetrics: MutableStateFlow<Map<String, RunMetrics>>,
    /** The session's activity stamp in the list, stored with its rows so prefetch can skip it. */
    val activityStamp: (String) -> String?,
    /** The server answered that the conversation is deleted (410 `SESSION_DELETED`). */
    val deleted: (String) -> Unit = {},
    /** A different conversation was opened, or the open one was dropped: find-in-conversation ends. */
    val conversationChanged: () -> Unit = {},
)

/** What the list's background prefetch asks of the v3 device copy (see [SessionLists]). */
internal interface SyncPrefetch {
    suspend fun storedActivity(sessionId: String): String?
    suspend fun prefetch(session: Session)
    suspend fun storedReply(session: Session): String?
}

/**
 * Sync protocol v3 for a [SessionStore] (docs/SYNC-V3.md): the open conversation's lane stream, its
 * window of rows, paging, jumps and truncated rows, the device copy, and subagent lanes.
 *
 * ## What it writes
 *
 * The same [StoreState] the v2 stream writes, so every public flow of the store, and with them the
 * Swift and Compose screens, stay as they are: the timeline is built from the window's rows
 * ([timelineItem]), with each user row's Run attached by `runId`, and the outbox's sends that have
 * no row yet drawn after them under the same key the server's row will have. Control state (status,
 * interaction, runs, context) comes only from hello and the control frames. History paging is
 * reported as a [NativeHistoryState] whose cursor is the oldest row's `pos`.
 *
 * ## The window
 *
 * At most [window] rows and bytes are held. Live growth lets the oldest go (they can be paged back);
 * paging up past the cap lets the newest go, and the window is then away from the head
 * ([RowWindow.hasAfter]): rows the stream adds past its end are not taken until [loadNewer] or
 * [jumpToLatest] comes back. The device copy is the window; it is not resumable while away.
 */
internal class SessionSync(
    private val api: RiffetApi,
    private val scope: CoroutineScope,
    private val background: CoroutineContext,
    private val core: StateStore,
    private val cache: TimelineCache?,
    private val window: SyncWindow,
    private val hooks: SyncHooks,
) : SyncPrefetch {
    private var main: MainLane? = null
    private var streamJob: Job? = null
    private var connectionJob: Job? = null
    private var pageJob: Job? = null
    private var saveJob: Job? = null
    private var healthChecked = false

    /** Serialises every change to a lane's window and every timeline built from it. */
    private val lock = Mutex()

    private val _serverTooOld = MutableStateFlow(false)
    val serverTooOld: StateFlow<Boolean> = _serverTooOld.asStateFlow()

    private val _outline = MutableStateFlow<SyncOutlineState?>(null)
    val outline: StateFlow<SyncOutlineState?> = _outline.asStateFlow()

    private val _head = MutableStateFlow(0L)

    /** The lane seq the main window is current to; it moves as the stream adds rows (find re-asks on it). */
    val head: StateFlow<Long> = _head.asStateFlow()

    private val _truncated = MutableStateFlow<Map<String, Long>>(emptyMap())

    /** Rows whose text is a preview, by key, with the full row's size; [expandRow] fetches one. */
    val truncated: StateFlow<Map<String, Long>> = _truncated.asStateFlow()

    private val _liveActivities = MutableStateFlow<List<NativeActivity>>(emptyList())

    /** The conversation's activities still in progress, including ones outside the window. */
    val liveActivities: StateFlow<List<NativeActivity>> = _liveActivities.asStateFlow()

    private val lanes = HashMap<String, ChildLane>()
    private val lanesLock = Mutex()
    private val _loadingLane = MutableStateFlow<String?>(null)
    val loadingLane: StateFlow<String?> = _loadingLane.asStateFlow()
    private val _laneError = MutableStateFlow<String?>(null)
    val laneError: StateFlow<String?> = _laneError.asStateFlow()

    /** Whether [sessionId]'s stream is the one running. */
    fun streaming(sessionId: String): Boolean = main?.sessionId == sessionId && streamJob?.isActive == true

    /* ---- open, dial, frames ---- */

    /** Opens [sessionId] (or redials it when it is the open one): the device copy first, then the stream. */
    fun open(sessionId: String, session: Session?) {
        val before = core.value
        val held = main
        val redial = before.sessionId == sessionId && held?.sessionId == sessionId
        stopStream()
        pageJob?.cancel()
        pageJob = null
        if (!redial) {
            val heldSynced = before.cachedAt == null
            held?.let { previous -> scope.launch { write(previous, heldSynced) } }
            main = MainLane(sessionId, window)
            hooks.conversationChanged()
            releaseLanes()
            _outline.value = null
            _truncated.value = emptyMap()
            _liveActivities.value = emptyList()
            hooks.liveMetrics.value = emptyMap()
        }
        val lane = main ?: return
        var token = 0
        core.update { state ->
            token = state.dial + 1
            val opened = state.copy(dial = token, sessionId = sessionId, connection = RiffetConnectionState.Connecting, historyRetries = 0).withoutOutputRate()
            if (redial) {
                if (session != null) opened.copy(selected = session, context = measuredContext(session, sessionId, opened.context)) else opened
            } else {
                opened.copy(
                    epoch = state.epoch + 1,
                    selected = session,
                    timeline = emptyList(),
                    loaded = false,
                    cachedAt = null,
                    status = null,
                    interaction = null,
                    context = measuredContext(session, sessionId, null),
                    subagents = emptyList(),
                    stoppingActivities = emptySet(),
                    send = ComposerSendState(),
                    steerSources = emptySet(),
                ).droppingHistory(null).withoutOpenDeliveries()
            }
        }
        log("sync open $sessionId token=$token redial=$redial")
        if (!redial) OpenTrace.begin()
        streamJob = scope.launch {
            if (!redial) {
                traceAsyncBegin("riffet.open.restore", token)
                try {
                    restore(token, lane)
                    // A created session's first prompt, or the outbox, shows before any frame.
                    publish(token, lane)
                } finally {
                    traceAsyncEnd("riffet.open.restore", token)
                }
            }
            if (core.value.dial == token) run(token, lane)
        }
    }

    /** Stops the stream and keeps the window, e.g. while the app is in the background. */
    fun pause() {
        stopStream()
        pageJob?.cancel()
        pageJob = null
    }

    /** [SessionStore.clear]: no stream, lane or write of this conversation outlives it. */
    fun clear() {
        pause()
        saveJob?.cancel()
        saveJob = null
        main = null
        hooks.conversationChanged()
        releaseLanes()
        _outline.value = null
        _truncated.value = emptyMap()
        _liveActivities.value = emptyList()
    }

    private fun stopStream() {
        streamJob?.cancel()
        streamJob = null
        connectionJob?.cancel()
        connectionJob = null
    }

    private suspend fun restore(token: Int, lane: MainLane) {
        val cache = cache ?: return
        val stored = try {
            cache.load(lane.sessionId)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            null
        } ?: return
        if (core.value.dial != token || main !== lane) return
        lock.withLock {
            withContext(background) {
                traced("riffet.sync.restore") { lane.rows.restore(stored.meta.generation, stored.meta.lastSeq, stored.meta.hasBefore, stored.rows, stored.sizes) }
            }
        }
        stored.meta.outline?.let { _outline.value = SyncOutlineState(it.turnCount, it.turns) }
        // `loaded` waits for [publish]: set here, a frame would be loaded with none of the rows.
        core.reduceDial(token) { state ->
            state.copy(
                cachedAt = stored.meta.syncedAt,
                context = state.context ?: measuredContext(state.selected, state.sessionId, stored.meta.context),
            )
        }
        val tail = stored.rows.lastOrNull()
        val answer = tail?.body as? TimelineRow.Body.Assistant
        log("sync restored ${lane.sessionId} rows=${stored.rows.size} seq=${stored.meta.lastSeq} tailSeq=${tail?.seq} tailPhase=${answer?.phase} tailChars=${answer?.text?.length}")
    }

    /** The stream of [lane], until it is replaced or ends for good. */
    private suspend fun run(token: Int, lane: MainLane) {
        if (hooks.unauthenticated.value) {
            core.reduceDial(token) { it.withoutOutputRate().copy(connection = RiffetConnectionState.Failed(UNAUTHENTICATED_REASON)) }
            return
        }
        if (_serverTooOld.value) return tooOld(token)
        checkHealth()
        try {
            // A consumer that falls [STREAM_QUEUE_FRAMES] behind drops what is queued and dials again
            // from the lane seq it has applied (docs/guide/performance.md §3.2); the server answers with
            // a delta or a snapshot, as after any reconnect.
            var overflowed = false
            val pacing = OverflowPacing()
            do {
                if (overflowed) pacing.after()
                val cursor = lock.withLock { lane.rows.applied }
                if (overflowed) log("sync overflow ${lane.sessionId} resuming from $cursor")
                val redial = overflowed
                val stream = api.syncStream(lane.sessionId, MAIN_LANE, window, cursor)
                connectionJob?.cancel()
                connectionJob = scope.launch {
                    // A redial after an overflow is not a lost connection: the lane stays as it was until the new one is live.
                    val states = if (redial) stream.connection.dropWhile { it is StreamConnection.Connecting } else stream.connection
                    states.collect { state ->
                        core.reduceDial(token) { current ->
                            val next = current.copy(
                                connection = when (state) {
                                    is StreamConnection.Connecting -> RiffetConnectionState.Connecting
                                    is StreamConnection.Live -> RiffetConnectionState.Live
                                    is StreamConnection.Reconnecting -> RiffetConnectionState.Reconnecting
                                },
                            )
                            if (state !is StreamConnection.Live) next.withoutOutputRate() else next
                        }
                    }
                }
                overflowed = stream.sized().collectBounded(STREAM_QUEUE_FRAMES, STREAM_QUEUE_BYTES, background, { it.bytes }) { handle(token, lane, it.frame) }
            } while (overflowed)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            log("sync failed ${lane.sessionId} ${error::class.simpleName}: ${error.message}")
            connectionJob?.cancel()
            // Deleted (here or on another device): the page closes rather than offering a retry.
            if (error is SyncRejectedException && error.code == SESSION_DELETED_CODE) { hooks.deleted(lane.sessionId); return }
            when (error) {
                is RiffetUnauthenticatedException -> hooks.signedOut()
                is SyncServerTooOldException -> tooOld(token)
                else -> core.reduceDial(token) {
                    it.withoutOutputRate().copy(connection = RiffetConnectionState.Failed(syncFailureText(error)))
                }
            }
        }
    }

    /** Once per store: a server whose `/health` reports an older protocol is too old, whatever its routes say. */
    private fun checkHealth() {
        if (healthChecked) return
        healthChecked = true
        scope.launch {
            if (api.serverSpeaksSync() == false) {
                stopStream()
                tooOld(core.value.dial)
            }
        }
    }

    private fun tooOld(token: Int) {
        _serverTooOld.value = true
        core.reduceDial(token) { it.withoutOutputRate().copy(connection = RiffetConnectionState.Failed(SERVER_TOO_OLD_REASON)) }
    }

    private suspend fun handle(token: Int, lane: MainLane, frame: SyncFrame) {
        if (core.value.dial != token || main !== lane) return
        AppLog.detail("store") { "sync frame ${describe(frame)}" }
        when (frame) {
            is SyncFrame.Hello -> {
                // The window/history can still show the previous generation until the snapshot
                // arrives. Remember the control generation at hello, not at that later publication,
                // so repeated identical hellos do not abandon a POST in flight.
                val generationChanged = lane.interactionGeneration != frame.generation
                lane.interactionGeneration = frame.generation
                hooks.applySession(frame.session)
                val entries = hooks.pendingEntries(frame.runs)
                core.reduceDial(token) { state ->
                    state.withServerRuns(frame.runs, entries).copy(
                        interactionObservation = state.interactionObservation + if (generationChanged) 1 else 0,
                        status = frame.status.copy(interaction = frame.interaction),
                        interaction = frame.interaction,
                        context = frame.context?.let { measuredContext(state.selected, state.sessionId, it) } ?: state.context,
                    )
                }
                pruneMetrics(frame.runs)
                _liveActivities.value = frame.activities
                _outline.value = SyncOutlineState(frame.outline.turnCount, frame.outline.turns)
                if (lock.withLock { lane.rows.hello(frame) }) caughtUp(token, lane)
            }
            is SyncFrame.Snapshot -> {
                val done = lock.withLock { withContext(background) { lane.rows.snapshot(frame) } }
                if (done) {
                    publish(token, lane)
                    caughtUp(token, lane)
                }
            }
            is SyncFrame.Rows -> {
                frame.upserts.filter { (it.body as? TimelineRow.Body.Assistant)?.phase == TimelineRow.Phase.FINAL_ANSWER }.forEach { row ->
                    log("sync final answer ${lane.sessionId} seq=${row.seq} chars=${(row.body as TimelineRow.Body.Assistant).text.length}")
                }
                val (changed, caught) = lock.withLock { withContext(background) { lane.rows.rows(frame) to lane.rows.caughtUp } }
                if (changed) publish(token, lane)
                if (caught && core.value.cachedAt != null) caughtUp(token, lane) else if (changed) scheduleSave(lane)
            }
            is SyncFrame.Reset -> {
                // Reset invalidates an observation even if the generation or dialog contents repeat.
                // Keep epoch/dial untouched: this stream must continue accepting the following frames.
                lane.interactionGeneration = frame.generation
                core.reduceDial(token) { it.copy(interactionObservation = it.interactionObservation + 1) }
                // The rows on screen stay until the snapshot replaces them; nothing stored of the old generation can be resumed.
                lock.withLock { lane.rows.reset() }
                cache?.let { stored -> scope.launch { runCatching { stored.forget(lane.sessionId) } } }
            }
            is SyncFrame.Status -> core.reduceDial(token) { state ->
                val status = if (state.connection is RiffetConnectionState.Live) frame.status else frame.status.copy(outputRate = null, activeTurn = null, runtimeControl = null)
                state.copy(status = status, interaction = status.interaction)
            }
            is SyncFrame.Interaction -> core.reduceDial(token) { it.withInteraction(frame.interaction) }
            is SyncFrame.Runs -> {
                val entries = hooks.pendingEntries(frame.runs)
                core.reduceDial(token) { it.withServerRuns(frame.runs, entries) }
                pruneMetrics(frame.runs)
            }
            is SyncFrame.RunUpsert -> {
                hooks.upsertEntries(frame.run)
                core.reduceDial(token) { state -> if (frame.run.sessionId == state.sessionId) state.upsertRun(frame.run) else state }
            }
            is SyncFrame.Activities -> _liveActivities.value = frame.live
            is SyncFrame.Outline -> _outline.update { held ->
                val changed = frame.turns.associateBy { it.turn }
                val kept = held?.turns.orEmpty().map { changed[it.turn] ?: it }
                val known = kept.mapTo(HashSet()) { it.turn }
                SyncOutlineState(frame.turnCount, (kept + frame.turns.filter { it.turn !in known }).sortedBy { it.startPos })
            }
            is SyncFrame.Context -> {
                core.reduceDial(token) { it.copy(context = measuredContext(it.selected, it.sessionId, frame.context)) }
                scheduleSave(lane)
            }
            is SyncFrame.Metrics -> {
                // A turn typed in the CLI has no Run; its receipt names it, as the presenter looks it up.
                val runId = frame.runId ?: frame.nativeMessageId?.let { "native:$it" }
                val aggregate = frame.run
                if (runId != null && aggregate != null) hooks.liveMetrics.update { it + (runId to aggregate) }
            }
            is SyncFrame.SessionUpdate -> hooks.applySession(frame.session)
            is SyncFrame.Error, is SyncFrame.CaughtUp -> Unit
            is SyncFrame.Unknown -> if (frame.type == HEARTBEAT && lock.withLock { lane.rows.heartbeat() } && core.value.cachedAt != null) caughtUp(token, lane)
        }
    }

    /** The server has brought the window up to its head: it is no longer the stored copy. */
    private fun caughtUp(token: Int, lane: MainLane) {
        core.reduceDial(token) { it.copy(cachedAt = null, loaded = true, historyRetries = 0) }
        scheduleSave(lane)
    }

    private fun pruneMetrics(runs: List<Run>) {
        val live = runs.mapTo(HashSet()) { it.id }
        hooks.liveMetrics.update { metrics -> metrics.filterKeys { it in live || it.startsWith("native:") } }
    }

    /** Every change of the run list: a user row's Run, and the outbox rows, follow it. */
    fun runsChanged() {
        val lane = main ?: return
        scope.launch { publish(core.value.dial, lane) }
    }

    private suspend fun publish(token: Int, lane: MainLane) {
        lock.withLock {
            if (core.value.dial != token || main !== lane) return
            val runs = core.value.runs
            val built = withContext(background) { traced("riffet.sync.build") { lane.build(runs) } }
            if (_truncated.value != built.truncated) _truncated.value = built.truncated
            _head.value = lane.rows.applied?.seq ?: 0L
            core.reduceDial(token) { state ->
                val next = if (state.history?.generation != built.history?.generation) state.droppingHistory(built.history) else state.copy(history = built.history)
                next.copy(
                    timeline = built.timeline,
                    hasNewerHistory = built.hasAfter,
                    loaded = state.loaded || built.history != null,
                    subagents = if (built.subagents == state.subagents) state.subagents else built.subagents,
                )
            }
        }
    }

    /* ---- paging, jumps, truncated rows ---- */

    /** The rows before the oldest one held; a no-op while one is loading, after a failure, or at the start. */
    fun loadOlder() = page(TimelineAnchor.BEFORE)

    /** The rows after the newest one held, while the window is away from the head. */
    fun loadNewer() = page(TimelineAnchor.FROM)

    /** The open conversation and its window's generation, with the rows held (find's view of them), read under the lock. */
    suspend fun <T> withHeld(block: (sessionId: String, generation: String?, rows: RowWindow) -> T): T? {
        val lane = main ?: return null
        return lock.withLock { if (main === lane) block(lane.sessionId, lane.rows.window.generation, lane.rows.window) else null }
    }

    /** Replaces the window with the rows around [pos], e.g. a turn of the outline or a search hit. */
    fun jumpTo(pos: Long) = page(TimelineAnchor.AROUND, pos)

    /** Back to the newest rows after paging or jumping away: the stream is dialled for a snapshot. */
    fun jumpToLatest() {
        val lane = main ?: return
        scope.launch {
            if (main !== lane || core.value.sessionId != lane.sessionId) return@launch
            pageJob?.cancel()
            pageJob = null
            core.update { it.copy(historyRequest = it.historyRequest + 1, loadingHistory = false, historyError = null) }
            val away = lock.withLock { lane.rows.window.hasAfter.also { if (it) lane.rows.forgetCursor() } }
            if (away && main === lane && core.value.sessionId == lane.sessionId) open(lane.sessionId, null)
        }
    }

    private fun page(anchor: TimelineAnchor, at: Long? = null) {
        val lane = main ?: return
        val held = core.value
        if (held.sessionId != lane.sessionId || held.loadingHistory || (anchor == TimelineAnchor.BEFORE && held.historyError != null)) return
        val epoch = held.epoch
        var request = 0L
        core.update { request = it.historyRequest + 1; it.copy(historyRequest = request, loadingHistory = true) }
        pageJob = scope.launch {
            try {
                val target = lock.withLock {
                    val rows = lane.rows.window
                    val generation = rows.generation ?: return@withLock null
                    val pos = when (anchor) {
                        TimelineAnchor.BEFORE -> rows.firstPos.takeIf { rows.hasBefore }
                        TimelineAnchor.FROM -> rows.lastPos.takeIf { rows.hasAfter }
                        TimelineAnchor.AROUND -> at
                    } ?: return@withLock null
                    generation to pos
                } ?: return@launch
                val page = fetchPage(lane.sessionId, MAIN_LANE, target.first, anchor, target.second)
                val applied = lock.withLock {
                    if (core.value.epoch != epoch || core.value.historyRequest != request || main !== lane) return@withLock false
                    withContext(background) { lane.rows.page(anchor, page) }
                }
                if (!applied) return@launch
                publish(core.value.dial, lane)
                scheduleSave(lane)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                log("sync page failed ${error::class.simpleName}: ${error.message}")
                if (error is RiffetUnauthenticatedException) hooks.signedOut()
                if (error is SyncServerTooOldException) tooOld(core.value.dial)
                if (anchor == TimelineAnchor.BEFORE) core.reduce(epoch) { it.copy(historyError = error.message ?: L10n.uiText("sync.historyLoadFailed")) }
            } finally {
                core.reduce(epoch) { if (it.historyRequest == request) it.copy(loadingHistory = false) else it }
            }
        }
    }

    /** One page, retried after 1 s and 2 s before the failure is the reader's. */
    private suspend fun fetchPage(sessionId: String, lane: SyncLane, generation: String, anchor: TimelineAnchor, pos: Long): TimelinePage {
        var failures = 0
        while (true) {
            try {
                return api.syncTimeline(sessionId, lane, generation, anchor, pos, window)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                failures += 1
                if (error is RiffetUnauthenticatedException || failures >= PAGE_ATTEMPTS) throw error
                delay(PAGE_RETRY_MILLIS shl (failures - 1))
            }
        }
    }

    /**
     * The full text of a row cut to a preview: `GET /api/sessions/:id/blobs/:blobRef`. The blob is the
     * whole row, or its full text; either replaces the preview until the row changes again.
     */
    suspend fun expandRow(key: String): Boolean {
        val lane = main ?: return false
        val row = lock.withLock { lane.rows.window.row(key) } ?: return false
        val blob = row.truncated?.blobRef ?: return false
        val text = try {
            api.sessionBlob(lane.sessionId, blob)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            log("sync blob failed ${error::class.simpleName}: ${error.message}")
            return false
        }
        val full = withContext(background) { expandedRow(row, text) } ?: return false
        if (main !== lane) return false
        lock.withLock { lane.expanded[key] = full }
        publish(core.value.dial, lane)
        return true
    }

    /* ---- the device copy ---- */

    private fun scheduleSave(lane: MainLane) {
        if (cache == null) return
        saveJob?.cancel()
        saveJob = scope.launch {
            delay(SAVE_DELAY_MILLIS)
            if (main !== lane) return@launch
            write(lane, synced = core.value.cachedAt == null)
        }
    }

    /** Writes the open lane now, e.g. as the app leaves the foreground. */
    fun flush() {
        val lane = main ?: return
        if (cache == null) return
        saveJob?.cancel()
        val synced = core.value.cachedAt == null
        saveJob = scope.launch { write(lane, synced) }
    }

    /** The open lane's last write, frozen now and run by the host after [clear]. */
    fun captureFinalFlush(): suspend () -> Unit {
        saveJob?.cancel()
        saveJob = null
        val lane = main ?: return {}
        val synced = core.value.cachedAt == null
        return { write(lane, synced) }
    }

    private suspend fun write(lane: MainLane, synced: Boolean) {
        val cache = cache ?: return
        // capture drains the changed keys. Keep writes for this lane in order, and finish a
        // captured write even when a newer flush cancels this job. Otherwise the next capture
        // can persist a newer cursor with none of the rows that advanced it.
        lane.writeLock.withLock {
            withContext(NonCancellable) {
                val state = core.value
                val context = state.context.takeIf { state.sessionId == lane.sessionId }
                val outline = _outline.value.takeIf { main === lane }?.let { SyncOutline(it.turnCount, it.turns.takeLast(OUTLINE_STORED)) }
                val snapshot = lock.withLock {
                    withContext(background) { lane.rows.capture(lane.sessionId, context, hooks.activityStamp(lane.sessionId), outline, synced) }
                } ?: return@withContext
                try {
                    cache.save(snapshot)
                } catch (_: Throwable) {
                    // A full disk costs the device copy, never the conversation; the next save rewrites it.
                    lock.withLock { lane.rows.window.markRewrite() }
                }
            }
        }
    }

    /* ---- prefetch for the lists ---- */

    override suspend fun storedActivity(sessionId: String): String? = cache?.meta(sessionId)?.activity

    /**
     * Brings [session]'s stored lane up to date with `GET .../timeline/changes`: the changes after the
     * stored seq when the server still has them, else its newest rows.
     */
    override suspend fun prefetch(session: Session) {
        val cache = cache ?: return
        val epoch = core.value.epoch
        val stored = cache.load(session.id)
        val cursor = stored?.meta?.let { meta -> meta.lastSeq?.let { SyncCursor(meta.generation, it) } }
        val changes = api.syncChanges(session.id, MAIN_LANE, cursor, window)
        if (session.id == core.value.sessionId || core.value.epoch != epoch) return
        val stamp = session.activityStamp()
        val snapshot = withContext(background) {
            val target = RowWindow(window)
            val delta = changes.mode == SyncMode.DELTA && stored != null && cursor != null && changes.generation == cursor.generation &&
                (changes.from == null || changes.from == cursor.seq + 1)
            when {
                delta && stored != null -> {
                    target.install(stored.meta.generation, stored.rows, stored.meta.hasBefore, sizes = stored.sizes)
                    target.drain()
                    target.apply(changes.rows, changes.deletes.orEmpty())
                    val (changed, deleted) = target.drain()
                    TimelineSnapshot(session.id, MAIN_LANE, changes.generation, changes.to ?: changes.headSeq, target.hasBefore, target.list, changed, deleted, activity = stamp, sizes = target.sizes())
                }
                changes.mode == SyncMode.SNAPSHOT -> {
                    target.install(changes.generation, changes.rows, changes.hasBefore ?: true)
                    TimelineSnapshot(session.id, MAIN_LANE, changes.generation, changes.headSeq, target.hasBefore, target.list, activity = stamp, sizes = target.sizes())
                }
                else -> null
            }
        } ?: return
        if (session.id == core.value.sessionId || core.value.epoch != epoch) return
        cache.save(snapshot)
    }

    override suspend fun storedReply(session: Session): String? {
        val cache = cache ?: return null
        try {
            if (cache.meta(session.id)?.activity != session.activityStamp()) prefetch(session)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Throwable) {
            // The stored copy, if any, still says something.
        }
        val stored = cache.load(session.id) ?: return null
        return withContext(background) { latestReply(stored.rows.takeLast(REPLY_ROWS).mapNotNull { timelineItem(it, session.id) }) }
    }

    /* ---- subagent lanes ---- */

    /**
     * [toolCallId]'s lane, live while collected: its stream opens with the first collector and closes
     * with the last. Lanes belong to the open conversation and close with it.
     */
    fun lane(toolCallId: String): Flow<LaneView> = flow {
        val child = lanesLock.withLock {
            val sessionId = core.value.sessionId ?: return@withLock null
            val lane = lanes[toolCallId]?.takeIf { it.sessionId == sessionId }
                ?: ChildLane(sessionId, toolCallId).also { fresh -> lanes.put(toolCallId, fresh)?.stop() }
            lane.refs += 1
            if (lane.job == null) lane.start()
            lane
        }
        if (child == null) {
            emit(LaneView(toolCallId))
            return@flow
        }
        try {
            emitAll(child.view)
        } finally {
            withContext(NonCancellable) {
                lanesLock.withLock {
                    child.refs -= 1
                    if (child.refs <= 0 && lanes[toolCallId] === child) {
                        lanes.remove(toolCallId)
                        child.stop()
                    }
                }
            }
        }
    }

    /** The rows before [toolCallId]'s oldest; a no-op unless its lane is open. */
    fun loadOlderLane(toolCallId: String) {
        if (_loadingLane.value != null || _laneError.value != null) return
        _loadingLane.value = toolCallId
        scope.launch {
            try {
                val child = lanesLock.withLock { lanes[toolCallId] } ?: return@launch
                val target = child.lock.withLock {
                    val rows = child.rows.window
                    val generation = rows.generation ?: return@withLock null
                    val first = rows.firstPos.takeIf { rows.hasBefore } ?: return@withLock null
                    generation to first
                } ?: return@launch
                val page = fetchPage(child.sessionId, child.lane, target.first, TimelineAnchor.BEFORE, target.second)
                if (child.lock.withLock { withContext(background) { child.rows.page(TimelineAnchor.BEFORE, page) } }) child.publish()
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                _laneError.value = error.message ?: L10n.uiText("sync.recordsLoadFailed")
            } finally {
                if (_loadingLane.value == toolCallId) _loadingLane.value = null
            }
        }
    }

    fun clearLaneError() {
        _laneError.value = null
    }

    /** Stops the lanes of every conversation but the open one; their pages close with it. */
    private fun releaseLanes() {
        val open = main?.sessionId
        scope.launch {
            lanesLock.withLock {
                val gone = lanes.filterValues { it.sessionId != open }
                gone.forEach { (key, lane) ->
                    lanes.remove(key)
                    lane.stop()
                }
            }
        }
        _loadingLane.value = null
        _laneError.value = null
    }

    /** A subagent's lane: its own stream and window; the hello's control state belongs to the main lane. */
    private inner class ChildLane(val sessionId: String, val toolCallId: String) {
        val lane: SyncLane = "sub:$toolCallId"
        val rows = LaneRows(window)
        val lock = Mutex()
        val view = MutableStateFlow(LaneView(toolCallId))
        var refs = 0
        var job: Job? = null
        private var items = HashMap<String, CachedItem>()

        fun start() {
            job = scope.launch {
                try {
                    var overflowed = false
                    val pacing = OverflowPacing()
                    do {
                        if (overflowed) pacing.after()
                        val cursor = lock.withLock { rows.applied }
                        overflowed = api.syncStream(sessionId, lane, window, cursor).sized().collectBounded(STREAM_QUEUE_FRAMES, STREAM_QUEUE_BYTES, background, { it.bytes }) { sized ->
                            val frame = sized.frame
                            val changed = lock.withLock {
                                withContext(background) {
                                    when (frame) {
                                        is SyncFrame.Hello -> rows.hello(frame).let { false }
                                        is SyncFrame.Snapshot -> rows.snapshot(frame)
                                        is SyncFrame.Rows -> rows.rows(frame)
                                        is SyncFrame.Reset -> rows.reset().let { false }
                                        else -> false
                                    }
                                }
                            }
                            if (changed) publish()
                        }
                    } while (overflowed)
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: Throwable) {
                    if (error is RiffetUnauthenticatedException) hooks.signedOut()
                    view.update { it.copy(error = syncFailureText(error)) }
                }
            }
        }

        fun stop() {
            job?.cancel()
            job = null
        }

        suspend fun publish() {
            val next = lock.withLock {
                withContext(background) {
                    val built = ArrayList<TimelineItem>()
                    val cached = HashMap<String, CachedItem>()
                    for (row in rows.window.list) {
                        val held = items[row.key]
                        val item = if (held != null && held.row === row) held.item else timelineItem(row, sessionId) ?: continue
                        built += item
                        cached[row.key] = CachedItem(row, null, item)
                    }
                    items = cached
                    LaneView(toolCallId, built, loaded = true, hasBefore = rows.window.hasBefore)
                }
            }
            view.value = next
        }
    }

    private fun describe(frame: SyncFrame): String = when (frame) {
        is SyncFrame.Hello -> "Hello ${frame.generation} ${frame.mode} head=${frame.headSeq} runs=${frame.runs.size}"
        is SyncFrame.Snapshot -> "Snapshot ${frame.generation} part=${frame.part} final=${frame.final} n=${frame.rows.size} asOf=${frame.asOfSeq}"
        is SyncFrame.Rows -> "Rows ${frame.from}..${frame.to} n=${frame.upserts.size} deletes=${frame.deletes?.size ?: 0}"
        is SyncFrame.Reset -> "Reset ${frame.generation} ${frame.reason}"
        is SyncFrame.Status -> "Status ${frame.status.phase}"
        is SyncFrame.Unknown -> "Unknown ${frame.type}"
        else -> frame::class.simpleName.orEmpty()
    }
}

/** A built item and what it was built from: the same row instance and Run build the same item. */
private class CachedItem(val row: TimelineRow?, val run: Run?, val item: TimelineItem)

/** One built timeline, carried out of the background build. */
private class LaneBuild(
    val timeline: List<TimelineItem>,
    val history: NativeHistoryState?,
    val hasAfter: Boolean,
    val truncated: Map<String, Long>,
    val subagents: List<StoredSubagent>,
)

/** The open conversation's main lane: its rows, and the items built from them. */
private class MainLane(val sessionId: String, window: SyncWindow) {
    val rows = LaneRows(window)
    val writeLock = Mutex()
    /** Latest live control generation; the resident window can temporarily belong to an older one. */
    var interactionGeneration: String? = null

    /** Full rows fetched for truncated ones, kept while the row's seq is the one they were fetched for. */
    val expanded = HashMap<String, TimelineRow>()
    private var items = HashMap<String, CachedItem>()
    private var subagents: List<StoredSubagent> = emptyList()

    fun build(runs: List<Run>): LaneBuild {
        val byId = runs.associateBy { it.id }
        val byCommand = runs.filter { it.commandId.isNotEmpty() }.associateBy { it.commandId }
        val window = rows.window
        val failedRunIds = HashSet<String>()
        val failedTurnIds = HashSet<String>()
        for (row in window.list) {
            if (row.body !is TimelineRow.Body.Status || row.event.type != "run_failed") continue
            row.runId?.let(failedRunIds::add)
            row.event.runId?.let(failedRunIds::add)
            row.event.nativeTurnId?.let(failedTurnIds::add)
        }
        fun failureShown(run: Run?): Boolean {
            if (run == null || (run.state != RunState.FAILED && run.native?.delivery != NativeDeliveryState.FAILED)) return false
            if (run.native?.delivery == NativeDeliveryState.UNCERTAIN || run.native?.stage == "turn_outcome_unknown" || run.native?.stage == "acknowledged") return false
            if (run.id in failedRunIds) return true
            val native = run.native ?: return false
            if (native.delivery != NativeDeliveryState.FAILED) return false
            val received = native.nativeMessageId != null || native.timings?.get("observedAt") != null ||
                native.timings?.get("providerAcceptedAt") != null || native.stage == "provider_failed"
            // A steer can share a turn with its owner while its own delivery fails independently.
            return received && native.nativeTurnId != null && native.nativeTurnId in failedTurnIds
        }
        val timeline = ArrayList<TimelineItem>(window.size + 2)
        val cached = HashMap<String, CachedItem>(window.size)
        val covered = HashSet<String>()
        val truncated = LinkedHashMap<String, Long>()
        val children = ArrayList<StoredSubagent>()
        for (held in window.list) {
            val full = expanded[held.key]?.takeIf { it.seq == held.seq }
            val row = full ?: held
            val run = rowRun(row, byId, byCommand)
            val previous = items[row.key]
            val shown = failureShown(run)
            val item = if (previous != null && previous.row === row && previous.run == run &&
                ((previous.item as? TimelineItem.User)?.failureShown ?: false) == shown) previous.item
            else timelineItem(row, sessionId, run, shown)
            if (item != null) {
                timeline += item
                cached[row.key] = CachedItem(row, run, item)
            }
            if (row.body is TimelineRow.Body.User) {
                covered += row.key
                row.runId?.let(covered::add)
            }
            if (full == null) held.truncated?.let { truncated[held.key] = it.bytes }
            (row.body as? TimelineRow.Body.Tool)?.subagent?.let { child ->
                val toolCallId = child.lane.removePrefix("sub:").ifEmpty { return@let }
                children += StoredSubagent(
                    toolCallId,
                    SubagentTranscript(
                        agentId = child.agentId,
                        subagentType = child.subagentType,
                        title = child.title,
                        model = child.model,
                        events = emptyList(),
                        running = child.running,
                        status = child.status,
                        turnId = child.turnId,
                        startedAt = child.startedAt,
                        endedAt = child.endedAt,
                    ),
                )
            }
        }
        expanded.keys.retainAll { key -> window.row(key)?.let { expanded[key]?.seq == it.seq } == true }
        // Sends the server has no row for yet, under the key its row will have.
        for (run in runs) {
            val key = userRowKey(run)
            if (!needsLocalRow(run) || key in covered || run.id in covered) continue
            val previous = items[key]
            val shown = failureShown(run)
            val item = if (previous != null && previous.row == null && previous.run == run &&
                (previous.item as? TimelineItem.User)?.failureShown == shown) previous.item
            else pendingUserItem(run).copy(failureShown = shown)
            timeline += item
            cached[key] = CachedItem(null, run, item)
        }
        items = cached
        if (children != subagents) subagents = children
        val generation = window.generation
        val history = generation?.let {
            NativeHistoryState(it, cursor = window.firstPos?.takeIf { window.hasBefore }?.let { pos -> "pos:$pos" }, hasMore = window.hasBefore)
        }
        return LaneBuild(timeline, history, window.hasAfter, truncated, subagents)
    }
}

/**
 * One lane's rows as its frames leave them: the window, the lane seq the window is current to
 * ([applied], what the device copy resumes from), a snapshot being received, and whether a delta has
 * reached the head the hello named.
 */
internal class LaneRows(cap: SyncWindow) {
    val window = RowWindow(cap)
    var applied: SyncCursor? = null
        private set
    private var parts: MutableList<TimelineRow>? = null
    private var head: Long? = null
    var caughtUp = false
        private set

    fun restore(generation: String, lastSeq: Long?, hasBefore: Boolean, stored: List<TimelineRow>, sizes: List<Int>? = null) {
        window.install(generation, stored, hasBefore, sizes = sizes)
        window.drain()
        applied = lastSeq?.let { SyncCursor(generation, it) }
    }

    /** True when the hello says the window is already at the head. */
    fun hello(frame: SyncFrame.Hello): Boolean {
        val resumed = frame.mode == SyncMode.DELTA && applied?.generation == frame.generation
        if (!resumed) {
            parts = mutableListOf()
            caughtUp = false
            head = null
            return false
        }
        // A snapshot cut short by a redial is not resumed by a delta.
        parts = null
        head = frame.headSeq
        caughtUp = (applied?.seq ?: -1) >= frame.headSeq
        return caughtUp
    }

    /** True once a snapshot is complete and has replaced the window. */
    fun snapshot(frame: SyncFrame.Snapshot): Boolean {
        val received = parts ?: mutableListOf<TimelineRow>().also { parts = it }
        received += frame.rows
        if (!frame.final) return false
        window.install(frame.generation, received, frame.hasBefore)
        applied = SyncCursor(frame.generation, frame.asOfSeq)
        parts = null
        head = null
        caughtUp = true
        return true
    }

    /** True when the frame changed the window. */
    fun rows(frame: SyncFrame.Rows): Boolean {
        val changed = window.apply(frame.upserts, frame.deletes.orEmpty())
        applied = SyncCursor(frame.generation, frame.to)
        head?.let { if (frame.to >= it) caughtUp = true }
        return changed
    }

    fun reset() {
        applied = null
        parts = mutableListOf()
        head = null
        caughtUp = false
    }

    /** The server went quiet after a hello: nothing more is coming, whatever the head said. */
    fun heartbeat(): Boolean {
        if (parts != null || caughtUp) return false
        caughtUp = true
        return true
    }

    /** A dial after this asks for a fresh snapshot. */
    fun forgetCursor() {
        applied = null
    }

    /** Applies a page; false when it belongs to another generation (the stream's reset will follow). */
    fun page(anchor: TimelineAnchor, page: TimelinePage): Boolean {
        if (page.generation != window.generation) return false
        when (anchor) {
            TimelineAnchor.BEFORE -> window.prepend(page.rows, page.hasBefore)
            TimelineAnchor.FROM -> window.appendPage(page.rows, page.hasAfter)
            TimelineAnchor.AROUND -> window.around(page.generation, page.rows, page.hasBefore, page.hasAfter)
        }
        return true
    }

    /** What the device stores of this lane: not resumable while the window is away from the head. */
    fun capture(sessionId: String, context: NativeContext?, activity: String?, outline: SyncOutline?, synced: Boolean): TimelineSnapshot? {
        val generation = window.generation ?: return null
        val (changed, deleted) = window.drain()
        val seq = applied?.takeIf { it.generation == generation && !window.hasAfter && parts == null }?.seq
        return TimelineSnapshot(
            sessionId = sessionId,
            lane = MAIN_LANE,
            generation = generation,
            lastSeq = seq,
            hasBefore = window.hasBefore,
            rows = window.list,
            changed = changed,
            deleted = deleted,
            context = context,
            activity = activity,
            outline = outline,
            synced = synced,
            sizes = window.sizes(),
        )
    }
}

/**
 * A lane's rows in `pos` order, capped at [cap], with what changed since the last [drain] (null
 * when the whole window was replaced). Rows past the end are not taken while [hasAfter].
 */
internal class RowWindow(private val cap: SyncWindow) {
    var generation: String? = null
        private set
    var hasBefore = false
        private set
    var hasAfter = false
        private set
    var list: List<TimelineRow> = emptyList()
        private set
    private val byKey = HashMap<String, TimelineRow>()
    private val sizes = HashMap<String, Int>()
    private var bytes = 0L
    private var changed: MutableSet<String>? = mutableSetOf()
    private val deleted = mutableSetOf<String>()

    val size: Int get() = list.size

    /** The oldest real row; pending rows sit after all of them. */
    val firstPos: Long? get() = list.firstOrNull { it.pos < PENDING_ROW_POS }?.pos
    val lastPos: Long? get() = list.lastOrNull { it.pos < PENDING_ROW_POS }?.pos

    fun row(key: String): TimelineRow? = byKey[key]

    /** [sizes], when given, are [rows]' wire sizes in order (the device copy read them off its log), so none is encoded again. */
    fun install(generation: String, rows: List<TimelineRow>, hasBefore: Boolean, hasAfter: Boolean = false, sizes: List<Int>? = null) {
        this.generation = generation
        this.hasBefore = hasBefore
        this.hasAfter = hasAfter
        byKey.clear()
        this.sizes.clear()
        bytes = 0
        val known = sizes?.takeIf { it.size == rows.size }
        rows.forEachIndexed { index, row -> put(row, known?.get(index)) }
        list = byKey.values.sortedWith(ORDER)
        changed = null
        deleted.clear()
        trimOldest()
    }

    /** A `rows` frame; true when the window changed. */
    fun apply(upserts: List<TimelineRow>, deletes: List<String>): Boolean {
        // A row outside the held range belongs to rows not held: before the window's start while
        // older rows exist, or past its end while away from the head. A held row that moved there
        // leaves, so the window's edges stay the paging cursors; the page that reaches it brings it back.
        val start = if (hasBefore) firstPos else null
        val end = if (hasAfter) lastPos else null
        var reorder = false
        var any = false
        for (row in upserts) {
            val held = byKey[row.key]
            if ((start != null && row.pos < start) || (end != null && row.pos > end)) {
                if (held != null && remove(row.key)) any = true
                continue
            }
            if (held == null || held.pos != row.pos) reorder = true
            put(row)
            changed?.add(row.key)
            deleted -= row.key
            any = true
        }
        for (key in deletes) if (remove(key)) any = true
        if (!any) return false
        list = if (reorder) byKey.values.sortedWith(ORDER) else list.mapNotNull { byKey[it.key] }
        if (!hasAfter) trimOldest()
        return true
    }

    /** Older rows paged in; past the cap the newest go and the window is away from the head. */
    fun prepend(rows: List<TimelineRow>, hasBefore: Boolean) {
        for (row in rows) if (row.key !in byKey) {
            put(row)
            changed?.add(row.key)
        }
        this.hasBefore = hasBefore
        list = byKey.values.sortedWith(ORDER)
        while (list.size > 1 && (list.size > cap.rows || bytes > cap.bytes)) {
            hasAfter = true
            drop(list.last().key)
            list = list.dropLast(1)
        }
    }

    /** Newer rows paged in while away from the head; past the cap the oldest go. */
    fun appendPage(rows: List<TimelineRow>, hasAfter: Boolean) {
        for (row in rows) {
            put(newest(row))
            changed?.add(row.key)
        }
        this.hasAfter = hasAfter
        list = byKey.values.sortedWith(ORDER)
        trimOldest()
    }

    /** The rows around a jump; a row the stream already brought further keeps that version. */
    fun around(generation: String, rows: List<TimelineRow>, hasBefore: Boolean, hasAfter: Boolean) =
        install(generation, rows.map(::newest), hasBefore, hasAfter)

    /** A page is read apart from the stream: a version of a row it already brought is not taken back. */
    private fun newest(row: TimelineRow): TimelineRow = byKey[row.key]?.takeIf { it.seq > row.seq } ?: row

    /** What changed since the previous call; null keys mean the whole window was replaced. */
    fun drain(): Pair<Set<String>?, Set<String>> {
        val result = changed?.toSet() to deleted.toSet()
        changed = mutableSetOf()
        deleted.clear()
        return result
    }

    /** The next save rewrites the stored copy whole, e.g. after a failed write. */
    fun markRewrite() {
        changed = null
        deleted.clear()
    }

    private fun trimOldest() {
        var cut = 0
        while (list.size - cut > 1 && (list.size - cut > cap.rows || bytes > cap.bytes)) {
            drop(list[cut].key)
            cut += 1
        }
        if (cut > 0) {
            hasBefore = true
            list = list.subList(cut, list.size).toList()
        }
    }

    /** Every held row's wire size by key, for the device copy to cap and write without encoding them again. */
    fun sizes(): Map<String, Int> = HashMap(sizes)

    private fun put(row: TimelineRow, known: Int? = null) {
        sizes.remove(row.key)?.let { bytes -= it }
        val size = known ?: rowBytes(row)
        sizes[row.key] = size
        bytes += size
        byKey[row.key] = row
    }

    private fun remove(key: String): Boolean {
        if (byKey.remove(key) == null) return false
        sizes.remove(key)?.let { bytes -= it }
        changed?.remove(key)
        deleted += key
        return true
    }

    private fun drop(key: String) {
        remove(key)
    }

    private companion object {
        /** By position; pending rows share one, and keep the order they were sent in. */
        val ORDER = compareBy<TimelineRow> { it.pos }.thenBy { it.event.createdAt }
    }
}

/** A row's size as the wire carries it: what the window's byte cap counts. */
private fun rowBytes(row: TimelineRow): Int = RiffetJson.instance.encodeToString(TimelineRow.serializer(), row).length

/** A user's send that the timeline shows before the server has a row for it: in flight, not settled or dropped. */
private fun needsLocalRow(run: Run): Boolean {
    if (run.state == RunState.CANCELLED) return false
    val delivery = run.native?.delivery
    if (delivery == NativeDeliveryState.OBSERVED || delivery == NativeDeliveryState.CANCELLED) return false
    return run.native?.fingerprint == "client-pending" || run.state == RunState.QUEUED || run.state == RunState.RUNNING ||
        delivery in LOCAL_ROW_DELIVERIES
}

private val LOCAL_ROW_DELIVERIES = setOf(
    NativeDeliveryState.QUEUED,
    NativeDeliveryState.PREPARING,
    NativeDeliveryState.DISPATCHING,
    NativeDeliveryState.INPUT_SENT,
    NativeDeliveryState.UNCERTAIN,
)

/** [row] with the full content of its blob: the whole row when the blob is one, else its full text. */
private fun expandedRow(row: TimelineRow, blob: String): TimelineRow? {
    val whole = runCatching { RiffetJson.instance.decodeFromString(TimelineRow.serializer(), blob) }.getOrNull()
    if (whole != null && whole.key == row.key && whole.body !is TimelineRow.Body.Unknown) return whole.copy(seq = row.seq, truncated = null)
    val body = when (val held = row.body) {
        is TimelineRow.Body.User -> held.copy(text = blob)
        is TimelineRow.Body.Assistant -> held.copy(text = blob)
        is TimelineRow.Body.Thought -> held.copy(text = blob)
        is TimelineRow.Body.Status -> held.copy(text = blob)
        else -> return null
    }
    return row.copy(body = body, truncated = null)
}

/** What the connection says once the server turns out not to speak sync v3 (docs/SYNC-V3.md, 下线 v2). */
internal val SERVER_TOO_OLD_REASON: String get() = L10n.uiText("sync.serverTooOld")

/** Turns of the outline kept with the device copy: as many as a hello brings. */
private const val SESSION_DELETED_CODE = "SESSION_DELETED"
private const val OUTLINE_STORED = 50

/** Rows a notification's reply is looked for in. */
private const val REPLY_ROWS = 200

private const val PAGE_ATTEMPTS = 3
private const val PAGE_RETRY_MILLIS = 1_000L

/**
 * What a failed sync tells the reader. An HTTP error and a server's refusal carry text the catalogs
 * localise; a transport exception's message (a socket or TLS diagnostic) is for the log, not the page.
 */
internal fun syncFailureText(error: Throwable): String = when (error) {
    is RiffetHttpException -> error.message
    is SyncRejectedException -> L10n.serverError(error.code, emptyMap(), error.message.orEmpty())
    else -> L10n.uiText("sync.serverUnreachable")
}.ifBlank { L10n.uiText("sync.connectionFailed") }

/** Raised inside [collectBounded]'s producer when its queue is full; never leaves it. */
private class QueueFull : CancellationException("stream queue full")

/**
 * Collects with at most [capacity] items, or [maxBytes] of their [weigh]t, queued behind [action];
 * the upstream runs in [producer]. When the queue is full it is dropped, the flow is cancelled and
 * the result is true: the caller resumes from what it applied rather than from what the flow had
 * passed on. False when the flow ended; its error is thrown after the items before it.
 */
@OptIn(ExperimentalAtomicApi::class)
internal suspend fun <T> Flow<T>.collectBounded(
    capacity: Int,
    maxBytes: Long = Long.MAX_VALUE,
    producer: CoroutineContext = EmptyCoroutineContext,
    weigh: (T) -> Int = { 0 },
    action: suspend (T) -> Unit,
): Boolean = coroutineScope {
    val queue = Channel<T>(capacity)
    val queued = AtomicLong(0)
    val overflow = CompletableDeferred<Unit>()
    val upstream = this@collectBounded
    launch(producer) {
        try {
            upstream.collect { item ->
                if (queued.addAndFetch(weigh(item).toLong()) > maxBytes || queue.trySend(item).isFailure) {
                    overflow.complete(Unit)
                    throw QueueFull()
                }
            }
            queue.close()
        } catch (_: QueueFull) {
            queue.close()
        } catch (cancellation: CancellationException) {
            queue.close()
            throw cancellation
        } catch (error: Throwable) {
            queue.close(error)
        }
    }
    while (true) {
        val result = queue.receiveCatching()
        if (overflow.isCompleted) break
        result.exceptionOrNull()?.let { throw it }
        if (result.isClosed) break
        val item = result.getOrThrow()
        queued.addAndFetch(-weigh(item).toLong())
        action(item)
    }
    overflow.isCompleted
}

/**
 * Consecutive overflows of one lane's queue: a consumer that keeps falling behind waits a little
 * before each redial instead of reconnecting every [STREAM_QUEUE_FRAMES] frames.
 */
private class OverflowPacing {
    private var count = 0
    private var last: TimeMark? = null

    suspend fun after() {
        val since = last?.elapsedNow()
        count = if (since != null && since < 30.seconds) count + 1 else 1
        last = TimeSource.Monotonic.markNow()
        if (count >= 2) delay((500L * (count - 1)).coerceAtMost(5_000L).milliseconds)
    }
}
