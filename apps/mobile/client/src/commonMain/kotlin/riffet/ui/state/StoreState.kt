package riffet.ui.state

import kotlinx.coroutines.ExperimentalForInheritanceCoroutinesApi
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import riffet.contracts.NativeContext
import riffet.contracts.NativeDeliveryState
import riffet.contracts.NativeQueueHoldReason
import riffet.contracts.NativeHistoryState
import riffet.contracts.NativeInteraction
import riffet.contracts.NativeStatus
import riffet.contracts.NativeStatusPhase
import riffet.contracts.Run
import riffet.contracts.RunState
import riffet.contracts.Session
import riffet.contracts.SessionState
import riffet.core.StoredSubagent
import riffet.core.TimelineItem
import riffet.ui.composer.OutboxEntry

/**
 * Everything the store knows about the open conversation, as one immutable value.
 *
 * Before this existed each field was its own `StateFlow` with several writers (stream frames, HTTP
 * answers, the outbox, the device copy, list polling) and every writer defended itself with its own
 * staleness token. Now there is one [StateStore]; a writer names the generation it was started in and
 * the reducer drops it when that generation is gone:
 *
 *  - [epoch] changes when the open conversation changes (select another one, or clear). An HTTP
 *    answer, a history page or a prefetch carries the epoch it started in.
 *  - [dial] changes with every subscription (redial, pause, sign-out) and gates stream frames.
 *  - [interactionObservation] fences dialog GET/POST across content, native-thread and generation
 *    changes within the same epoch, without invalidating the stream's dial.
 *
 * Readers get consistent views of this value: the public flows are projections of it, so two fields
 * read from one [StoreState] always belong to the same moment.
 */
internal data class StoreState(
    val epoch: Int = 0,
    val dial: Int = 0,
    val sessionId: String? = null,
    val selected: Session? = null,
    val timeline: List<TimelineItem> = emptyList(),
    /** Every send/run the client tracks, keyed by command id; see [Delivery]. */
    val deliveries: Map<String, Delivery> = emptyMap(),
    /**
     * Store-level: a created session's first prompt receipt, by session id. Unlike the rest of the
     * per-session state it survives epoch changes (only `clear` resets it), so leaving the new session
     * before its first frame and coming back still seeds the transcript with that prompt. It follows
     * the newest known copy of the run and is dropped once the run is observed or settled.
     */
    val createdReceipts: Map<String, Run> = emptyMap(),
    // Views of [deliveries] for the open session; maintained only by [withDeliveries].
    val runs: List<Run> = emptyList(),
    /** Sends that can wait in the dock: queued ones, and ones still submitting ([queued] picks). */
    val waiting: List<Run> = emptyList(),
    /** Runs whose delivery is unconfirmed; [uncertain] keeps the ones that still hold the conversation. */
    val unconfirmed: List<Run> = emptyList(),
    val status: NativeStatus? = null,
    val interaction: NativeInteraction? = null,
    /** HTTP observations expire on any dialog content or native-thread change, including A → B → A. */
    val interactionObservation: Long = 0L,
    val context: NativeContext? = null,
    val connection: RiffetConnectionState = RiffetConnectionState.Idle,
    val loaded: Boolean = false,
    val cachedAt: Long? = null,
    val history: NativeHistoryState? = null,
    /** Newer rows exist beyond the resident window, so its tail is not the conversation's latest. */
    val hasNewerHistory: Boolean = false,
    val loadingHistory: Boolean = false,
    val historyError: String? = null,
    /** Bumped whenever the history paging state is replaced, so an overtaken page cannot clear the flag. */
    val historyRequest: Long = 0L,
    /** Automatic redials spent on the open session's history failing to sync. */
    val historyRetries: Int = 0,
    val send: ComposerSendState = ComposerSendState(),
    /** Command ids whose POST has not answered yet: absent from a `runs` frame they are pending, not lost. */
    val inFlight: Set<String> = emptySet(),
    /** Queued runs a steer is converting; their rows are locked until the steer settles. */
    val steerSources: Set<String> = emptySet(),
    val subagents: List<StoredSubagent> = emptyList(),
    /** Activities whose stop was requested: shown as stopping until the server's own state says otherwise. */
    val stoppingActivities: Set<String> = emptySet(),
) {
    fun toOpenSession(): OpenSessionState = OpenSessionState(
        sessionId = sessionId,
        selected = selected,
        interaction = interaction,
        queued = queued,
        uncertain = uncertain,
        runs = runs,
        // The rate changes many times a second; it has its own flow.
        status = if (status?.outputRate != null) status.copy(outputRate = null) else status,
        working = isWorking(),
        connection = connection,
        epoch = epoch,
        loaded = loaded,
        sendState = send,
        history = history,
        loadingHistory = loadingHistory,
        historyError = historyError,
        cachedAt = cachedAt,
        context = context,
        subagents = subagents,
    )

    /** Until the stream reports a status, the session list's state answers, so an open does not start idle. */
    fun isWorking(): Boolean = status?.let { it.phase == NativeStatusPhase.BUSY || it.phase == NativeStatusPhase.ATTENTION }
        ?: (selected?.state == SessionState.RUNNING || selected?.state == SessionState.WAITING || selected?.state == SessionState.CANCELLING)

    /**
     * Unconfirmed sends that still hold the conversation. The server says whether one does (a steer whose
     * turn is over does not); a send whose answer this client lost ([HTTP_UNKNOWN]) is this client's own.
     */
    val uncertain: List<Run>
        get() {
            val queue = status?.queue ?: return unconfirmed
            if (queue.held?.reason == NativeQueueHoldReason.UNCONFIRMED) return unconfirmed
            val local = unconfirmed.filter { it.native?.stage == HTTP_UNKNOWN }
            return if (local.size == unconfirmed.size) unconfirmed else local
        }

    /**
     * The dock's messages ([messagePlace]). Where a send still submitting, or the one the server starts
     * next, goes depends on the server's queue answer (else on whether the session is working), so this
     * is read from [status] as well as [deliveries], not kept beside them.
     */
    val queued: List<Run>
        get() {
            if (waiting.isEmpty()) return waiting
            val queue = status?.queue
            val working = isWorking()
            if (working && queue == null) return waiting
            // [runs] is oldest first, inline receipts included: the first one held is the one the server
            // starts next. None while an earlier send is still on its way into the CLI.
            val starting = runs.any { sendPhase(it) == SendPhase.STARTING || (it.native?.delivery == NativeDeliveryState.INPUT_SENT && (it.state == RunState.QUEUED || it.state == RunState.RUNNING)) }
            val next = if (starting) null else runs.firstOrNull { inQueue(it) }
            val placed = waiting.filter { messagePlace(it, working, next = it === next, queue = queue) == MessagePlace.DOCK }
            return if (placed.size == waiting.size) waiting else placed
        }

    /** The card and waiting strip share the same authority, whether observed through HTTP or SSE. */
    fun withInteraction(next: NativeInteraction?): StoreState {
        val phase = when {
            next != null -> NativeStatusPhase.ATTENTION
            status?.interaction != null && status.phase == NativeStatusPhase.ATTENTION ->
                if (runs.any { it.state == RunState.RUNNING }) NativeStatusPhase.BUSY else NativeStatusPhase.IDLE
            else -> status?.phase ?: NativeStatusPhase.IDLE
        }
        return copy(status = (status ?: NativeStatus(phase)).copy(phase = phase, interaction = next), interaction = next)
    }

    /** Paging state replaced wholesale: whatever page was in flight no longer belongs to it. */
    fun droppingHistory(next: NativeHistoryState?): StoreState =
        copy(history = next, hasNewerHistory = false, historyRequest = historyRequest + 1, loadingHistory = false, historyError = null)

    /** Disconnected streams cannot retain live action targets or fresh rate samples. */
    fun withoutOutputRate(): StoreState =
        if (status?.outputRate == null && status?.activeTurn == null && status?.runtimeControl == null) this
        else copy(status = status?.copy(outputRate = null, activeTurn = null, runtimeControl = null))

    /* ---- delivery table ---- */

    /** Replaces the table and re-derives the run views of the open session. */
    fun withDeliveries(next: Map<String, Delivery>): StoreState {
        // A created session's first prompt is tracked by its receipt: it follows the newest copy in the
        // table, stays (inline) when a `runs` snapshot does not list it yet, and is released once
        // observed or settled, when it can no longer be a waiting input. An unsettled unknown delivery
        // stays tracked so a same-request retry remains inline.
        val staged = LinkedHashMap(next)
        val receipts = LinkedHashMap<String, Run>()
        createdReceipts.forEach { (id, receipt) ->
            val latest = staged[receipt.key()]?.run ?: receipt
            if (!latest.settled()) {
                receipts[id] = latest
                staged[receipt.key()] = Delivery(latest, inline = true)
            }
        }
        val tracked = receipts.values.mapTo(HashSet()) { it.key() }
        val table = staged.mapValues { (key, delivery) -> if (delivery.inline && key !in tracked) delivery.copy(inline = false) else delivery }
        val open = sessionId
        val mine = table.values.filter { it.run.sessionId == open }
        val sorted = mine.sortedBy { it.run.createdAt }
        val runs = sorted.map { it.run }
        // Everything that goes to the dock while the session works; [queued] narrows it when idle.
        val waiting = sorted.filter { !it.inline && messagePlace(it.run, sessionWorking = true) == MessagePlace.DOCK }.map { it.run }
        val unconfirmed = runs.filter { it.native?.delivery == NativeDeliveryState.UNCERTAIN && it.native?.queueReleasedAt == null }
        return copy(
            deliveries = table,
            createdReceipts = if (receipts == createdReceipts) createdReceipts else receipts,
            runs = if (runs == this.runs) this.runs else runs,
            waiting = if (waiting == this.waiting) this.waiting else waiting,
            unconfirmed = if (unconfirmed == this.unconfirmed) this.unconfirmed else unconfirmed,
        )
    }

    /** Server receipts outrank local placeholders; timestamps order updates within either source. */
    fun upsertRun(incoming: Run): StoreState {
        val key = incoming.key()
        val existing = deliveries[key]
        val existingLocal = existing?.run?.native?.fingerprint == "client-pending"
        val incomingLocal = incoming.native?.fingerprint == "client-pending"
        val run = when {
            existing == null -> incoming
            existingLocal != incomingLocal -> if (existingLocal) incoming else existing.run
            existing.run.updatedAt > incoming.updatedAt -> existing.run
            else -> incoming
        }
        return withDeliveries(deliveries + (key to Delivery(run, existing?.inline == true)))
    }

    fun removeCommand(commandId: String): StoreState =
        if (commandId !in deliveries) this
        else copy(createdReceipts = createdReceipts.filterValues { it.key() != commandId }).withDeliveries(deliveries - commandId)

    /** A full `runs` snapshot for the open session, plus the outbox entries the server has not receipted. */
    fun withServerRuns(snapshot: List<Run>, entries: List<OutboxEntry>): StoreState {
        val open = sessionId ?: return this
        val next = LinkedHashMap<String, Delivery>()
        deliveries.forEach { (key, delivery) -> if (delivery.run.sessionId != open) next[key] = delivery }
        snapshot.forEach { next[it.key()] = Delivery(it, deliveries[it.key()]?.inline == true) }
        val session = selected
        if (session != null) entries.forEach { entry ->
            val run = optimisticRun(session, entry, uncertain = entry.body.commandId !in inFlight)
            next[run.key()] = Delivery(run, deliveries[run.key()]?.inline == true)
        }
        return withDeliveries(next)
    }

    /** A queued message a steer has taken over stops being queued. */
    fun settleQueuedSource(sourceRunId: String?): StoreState {
        if (sourceRunId == null) return this
        return mapRuns { run ->
            val native = run.native
            if (run.id == sourceRunId && native?.delivery == NativeDeliveryState.QUEUED) run.copy(
                state = RunState.CANCELLED, native = native.copy(delivery = NativeDeliveryState.CANCELLED, stage = "steer_replaced"),
            ) else run
        }
    }

    fun mapRuns(transform: (Run) -> Run): StoreState =
        withDeliveries(deliveries.mapValues { (_, delivery) -> transform(delivery.run).let { if (it === delivery.run) delivery else delivery.copy(run = it) } })

    /** Leaving the open session: its tracked sends go with it, except a created session's first prompt. */
    fun withoutOpenDeliveries(): StoreState = withDeliveries(deliveries.filterValues { it.inline })
}

/**
 * One tracked send, keyed by command id. Server runs, the client's own outbox placeholders and a
 * created session's receipt are the same row at different moments, so they share one table instead of
 * three parallel collections.
 *
 * [inline] marks the first prompt of a session just created: it belongs in the transcript while the
 * session starts up, not in the queue strip.
 */
internal data class Delivery(val run: Run, val inline: Boolean = false) {
    val phase: DeliveryPhase
        get() = when {
            run.native?.stage == OUTBOX_FAILURE -> DeliveryPhase.REJECTED
            run.native?.stage == HTTP_UNKNOWN || run.native?.delivery == NativeDeliveryState.UNCERTAIN -> DeliveryPhase.UNCERTAIN
            run.native?.stage == HTTP_PENDING -> DeliveryPhase.PENDING
            else -> DeliveryPhase.ACCEPTED
        }
}

/** Where a tracked send stands: sent locally, awaiting the POST, result unknown, refused, or receipted. */
internal enum class DeliveryPhase { PENDING, UNCERTAIN, REJECTED, ACCEPTED }

internal fun Run.key(): String = commandId.ifBlank { id }

private fun Run.settled(): Boolean =
    native?.delivery == NativeDeliveryState.OBSERVED || state == RunState.COMPLETED || state == RunState.FAILED || state == RunState.CANCELLED

/**
 * The single writer of [StoreState]. `MutableStateFlow.update` is a compare-and-set loop, so every
 * transition is applied to the latest value in turn: writers from the stream collector, HTTP answers
 * and user actions can never interleave inside one another's read-modify-write.
 */
internal class StateStore {
    val state = MutableStateFlow(StoreState())

    val value: StoreState get() = state.value

    // Keep HTTP's fence at the single writer, not in individual stream/list branches: selecting an
    // already-open session, polling its metadata and HTTP/SSE interaction updates all pass here.
    // A same-content hello/redraw is deliberately not a new observation. Generation/reset frames
    // explicitly bump the same counter, without replacing the dial that owns the live SSE callbacks.
    private fun observed(before: StoreState, next: StoreState): StoreState {
        val changed = before.interaction != next.interaction ||
            before.selected?.nativeSessionId != next.selected?.nativeSessionId
        val observation = maxOf(before.interactionObservation, next.interactionObservation) + if (changed) 1 else 0
        return if (next.interactionObservation == observation) next else next.copy(interactionObservation = observation)
    }

    fun update(transform: (StoreState) -> StoreState) = state.update { observed(it, transform(it)) }

    /** Applies [transform] unless the conversation moved on from [epoch]; false means it was dropped. */
    fun reduce(epoch: Int, transform: (StoreState) -> StoreState): Boolean {
        var applied = false
        state.update { current ->
            applied = current.epoch == epoch
            if (applied) observed(current, transform(current)) else current
        }
        return applied
    }

    /** Applies [transform] unless the subscription [dial] was replaced; false means it was dropped. */
    fun reduceDial(dial: Int, transform: (StoreState) -> StoreState): Boolean {
        var applied = false
        state.update { current ->
            applied = current.dial == dial
            if (applied) observed(current, transform(current)) else current
        }
        return applied
    }

    /** Like [update], but [transform] may refuse by returning null; false means it refused. */
    fun tryUpdate(transform: (StoreState) -> StoreState?): Boolean {
        var applied = false
        state.update { current ->
            val next = transform(current)
            applied = next != null
            next?.let { observed(current, it) } ?: current
        }
        return applied
    }

    /** Folds a newer server copy of the open session into [StoreState.selected]. */
    fun replaceSelected(session: Session) = update { if (it.selected?.id == session.id) it.copy(selected = session) else it }

    /** A created session's first prompt belongs in the transcript, not the queue, while it starts. */
    fun addCreated(run: Run) = update {
        it.copy(createdReceipts = it.createdReceipts + (run.sessionId to run))
            .withDeliveries(it.deliveries + (run.key() to Delivery(run, inline = true)))
    }

    /** The composer's lines and flags belong to one conversation: a write from a closed one is dropped. */
    fun updateSend(epoch: Int, transform: (ComposerSendState) -> ComposerSendState) =
        reduce(epoch) { it.copy(send = transform(it.send)) }

    fun setInFlight(commandId: String, inFlight: Boolean) =
        update { it.copy(inFlight = if (inFlight) it.inFlight + commandId else it.inFlight - commandId) }
}

/** See [SessionStore.openedTimeline]. The rows compare by reference, as [SessionStore.timeline] does. */
class OpenedTimeline(val sessionId: String?, val loaded: Boolean, val timeline: List<TimelineItem>) {
    override fun equals(other: Any?): Boolean = other is OpenedTimeline && other.sessionId == sessionId && other.loaded == loaded && other.timeline === timeline
    override fun hashCode(): Int = (sessionId.hashCode() * 31 + loaded.hashCode()) * 31 + timeline.size
}

/**
 * A [StateFlow] that is a pure projection of [source]: reading it never lags behind the source, which
 * a `stateIn` copy would whenever its collector had not run yet. Equal consecutive projections are
 * not re-emitted ([sameRef] compares by identity, for the transcript's large lists).
 */
@OptIn(ExperimentalForInheritanceCoroutinesApi::class)
internal class Projection<S, T>(
    private val source: StateFlow<S>,
    private val sameRef: Boolean = false,
    private val project: (S) -> T,
) : StateFlow<T> {
    override val value: T get() = project(source.value)
    override val replayCache: List<T> get() = listOf(value)

    override suspend fun collect(collector: FlowCollector<T>): Nothing {
        var started = false
        var last: T? = null
        source.collect { snapshot ->
            val next = project(snapshot)
            val same = started && (if (sameRef) last === next else last == next)
            if (!same) {
                started = true
                last = next
                collector.emit(next)
            }
        }
    }
}
