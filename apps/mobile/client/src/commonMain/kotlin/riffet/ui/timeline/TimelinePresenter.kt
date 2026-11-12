package riffet.ui.timeline

import riffet.shared.ClientPerf
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import riffet.contracts.NativeActivitySummary
import riffet.contracts.NativeJob
import riffet.contracts.OutputRate
import riffet.contracts.RunMetrics
import riffet.contracts.RunMetricsTokenSource
import riffet.contracts.SessionGoal
import riffet.i18n.L10n
import riffet.core.StoredSubagent
import riffet.core.SubagentEntry
import riffet.core.SubagentState
import riffet.core.SessionOutput
import riffet.core.SessionOutputsCache
import riffet.core.SubagentTranscript
import riffet.core.sessionOutputs
import riffet.core.TimelineItem
import riffet.core.subagentEntries
import riffet.core.outputRateDescription
import riffet.core.outputTokensPerSecond
import riffet.core.formatTokensPerSecond
import riffet.core.runIdFromTurnKey
import riffet.core.nativeEventIds
import riffet.core.speedDescription
import riffet.core.timelineItemTime
import riffet.core.tokensPerSecond
import riffet.core.turnHasVisibleOutput
import riffet.ui.composer.TodoEntry
import riffet.ui.composer.latestTodoEntries
import riffet.ui.composer.todoEntries
import riffet.ui.composer.visibleTimeline
import riffet.ui.state.OpenedTimeline
import riffet.ui.state.SessionStore
import riffet.ui.state.RiffetConnectionState
import riffet.ui.state.currentStep
import kotlin.coroutines.CoroutineContext

/** Everything a transcript screen derives from the store, computed together off the main thread. */
data class TimelinePresentation(
    val sessionId: String?,
    /** The session's transcript has been drawn from the device or the server; before that it is empty, not "no messages". */
    val loaded: Boolean = true,
    val grouping: TimelineGrouping,
    val todos: List<TodoEntry>,
    /** The session's goal as the server keeps it; the presenter's frame carries it so the docks change together. */
    val goal: SessionGoal? = null,
    /** What the running turn is doing right now, for the "正在处理" line. */
    val step: String?,
    /** The "正在处理" line shows: the turn runs and has nothing but reasoning (or nothing) on screen. */
    val showsWorking: Boolean,
    /**
     * The row holding the running turn's footer ([heldFooterRow]): the working line goes in its place
     * there, and only below every row when no row holds it.
     */
    val heldFooter: String? = null,
    /** Per row: it and the row above are both single-line rows, so they pack tightly (`rowGap`). */
    val compactAbove: List<Boolean>,
    /** Output speed of the turn an answer row closes, keyed by row key; only measured turns appear. */
    val speeds: Map<String, SpeedTag> = emptyMap(),
    /** The prompts, for the turn rail: each prompt row's key and a one-line preview. */
    val turns: List<TurnTick> = emptyList(),
    /** The recent rolling output speed, for the "正在处理" line (`WorkingIndicator`). */
    val sessionSpeed: SpeedTag? = null,
    /** The store's `working` (BUSY or ATTENTION) the grouping was built with; one rule for every host. */
    val working: Boolean = false,
    /** Background jobs the transcript's tool calls own, in transcript order. */
    val jobs: List<NativeJob> = emptyList(),
    /** The subagents this session spawned, as the details pane lists them ([subagentEntries]). */
    val subagents: List<SubagentEntry> = emptyList(),
    /** Compaction and background tasks above the composer ([activityDock]). */
    val dock: ActivityDock = ActivityDock(),
    /** Activities with a stop request out; a row shows them as stopping ([activityView]). */
    val stoppingActivities: Set<String> = emptySet(),
    /**
     * The files the session's tools wrote, newest first, with paths as the tools wrote them (no project
     * root is known here). Only a presenter made with `withOutputs` fills it ([sessionOutputs]).
     */
    val outputs: List<SessionOutput> = emptyList(),
) {
    /** How many of [subagents] are still working. */
    val runningSubagents: Int get() = subagents.count { it.state == SubagentState.RUNNING }

    /**
     * Subagents still running while the main agent is idle (status `idle`, so not [working]): the
     * background work the stop button and the "后台 N 个任务运行中" hint stand for. Zero while busy,
     * when the turn's own stop already covers them.
     */
    val backgroundSubagents: Int get() = if (working) 0 else runningSubagents

    /** How many of [jobs] have not finished yet. */
    val runningJobs: Int get() = jobs.count { it.status == riffet.contracts.NativeJobStatus.RUNNING }
}

/** `tok/s` as the web prints it: an estimated rate keeps its `~` and reads dimmer. */
data class SpeedTag(val label: String, val estimated: Boolean, val description: String)

data class TurnTick(val rowKey: String, val preview: String, val time: String?)

/**
 * The open transcript's rows, docks and working line, recomputed on [context] whenever the timeline,
 * the queue or the running flag changes. Frames that arrive while one is being computed are
 * conflated: a streaming answer costs one grouping per frame the host can show, not one per chunk.
 * Grouping is incremental (`updateTimelineGrouping`), so unchanged rows keep their instance.
 *
 * [prepare] runs on [context] with each grouping before it is published: a host derives there what
 * its rows would otherwise compute after their first frame (the Compose host parses markdown), so
 * a row is drawn at its final size from the start.
 */
class TimelinePresenter(
    private val store: SessionStore,
    scope: CoroutineScope,
    private val context: CoroutineContext = Dispatchers.Default,
    private val prepare: (TimelineGrouping) -> Unit = {},
    private val withOutputs: Boolean = false,
) {
    private class Input(
        val sessionId: String?,
        val loaded: Boolean,
        val timeline: List<TimelineItem>,
        val queued: Set<String>,
        val working: Boolean,
        val metrics: Map<String, RunMetrics>,
        val outputRate: OutputRate?,
        val activeTurnId: String?,
        val subagents: List<StoredSubagent>,
        val activity: NativeActivitySummary?,
        val stopping: Set<String>,
        val goal: SessionGoal?,
    )

    private var previous: TimelineGrouping? = null
    private var previousSession: String? = null
    private val outputsCache = SessionOutputsCache()

    /**
     * The last grouping of each session the store still holds warm ([SessionStore.presentable]), so a
     * warm reopen regroups only what changed and keeps its row instances. Bounded by the warm set.
     */

    private val metrics = combine(store.runs, store.liveMetrics) { runs, live ->
        runs.filter { it.native?.intent != "steer" }.mapNotNull { run -> run.native?.metrics?.let { run.id to it } }.toMap() + live
    }

    private class Live(val byRun: Map<String, RunMetrics>, val outputRate: OutputRate?, val activeTurnId: String?, val activity: NativeActivitySummary?)

    private val speedInputs = combine(metrics, store.status, store.connection) { byRun, status, connection ->
        Live(byRun, status?.outputRate?.takeIf { connection is RiffetConnectionState.Live }, status?.activeTurnId, status?.activity)
    }

    private class Transcript(val opened: OpenedTimeline, val subagents: List<StoredSubagent>, val stopping: Set<String>, val goal: SessionGoal?)

    /** The server keeps the goal on the session; only a change of it, not every session frame, re-presents. */
    private val goal = store.selected.map { it?.id to it?.goal }.distinctUntilChanged()

    private val transcript = combine(store.openedTimeline, store.subagents, store.stoppingActivities, goal) { opened, subagents, stopping, (goalSession, goal) ->
        Transcript(opened, subagents, stopping, goal.takeIf { goalSession == opened.sessionId })
    }

    val presentation: StateFlow<TimelinePresentation?> = combine(transcript, store.queued, store.working, speedInputs, L10n.changes) { transcript, queued, working, live, _ ->
        val opened = transcript.opened
        Input(opened.sessionId, opened.loaded, opened.timeline, queued.mapTo(HashSet()) { it.id }, working, live.byRun, live.outputRate, live.activeTurnId, transcript.subagents, live.activity, transcript.stopping, transcript.goal)
    }
        .conflate()
        .map { ClientPerf.measure("client.present") { present(it) } }
        .flowOn(context)
        .stateIn(scope, SharingStarted.Eagerly, null)

    private fun present(input: Input): TimelinePresentation {
        if (input.sessionId != previousSession) {
            // Another conversation is grouped from scratch: its rows are none of these.
            previous = null
            previousSession = input.sessionId
            outputsCache.clear()
        }
        return presentTimeline(previous, input.sessionId, input.timeline, input.queued, input.working, input.metrics, input.outputRate, input.activeTurnId)
            .copy(
                loaded = input.loaded,
                goal = input.goal,
                working = input.working,
                jobs = timelineJobs(input.timeline),
                subagents = subagentEntries(input.timeline, input.subagents),
                dock = activityDock(input.activity, timelineActivities(input.timeline)),
                stoppingActivities = input.stopping,
                outputs = if (withOutputs) sessionOutputs(input.timeline, null, outputsCache) else emptyList(),
            )
            .also { previous = it.grouping; prepare(it.grouping) }
    }

    /**
     * One subagent's page, computed on this presenter's context; see [subagentPresentation]. A nested
     * child names the transcript that spawned it as [parent]; null reads the open session's.
     */
    fun subagent(toolCallId: String, parent: List<TimelineItem>?): Flow<SubagentPresentation> =
        subagentPresentation(store, toolCallId, context, parent, prepare)
}

/** The jobs the transcript's tool calls carry, once each, in transcript order. */
private fun timelineJobs(timeline: List<TimelineItem>): List<NativeJob> {
    val jobs = LinkedHashMap<String, NativeJob>()
    for (item in timeline) (item as? TimelineItem.Tool)?.job?.let { job -> jobs.getOrPut(job.toolCallId) { job } }
    return if (jobs.isEmpty()) emptyList() else jobs.values.toList()
}

/** A subagent's own page: the child transcript projected and grouped off the main thread. */
data class SubagentPresentation(
    val toolCallId: String,
    /** Null until the stream has pushed this child's transcript. */
    val transcript: SubagentTranscript?,
    /** Title, prompt, type and model, read from the spawning call with the child filling gaps. */
    val info: SubagentTaskInfo?,
    val items: List<TimelineItem>,
    val grouping: TimelineGrouping,
    val running: Boolean,
    /** The lane's first snapshot (or delta) has arrived; an empty lane can be real. */
    val loaded: Boolean = false,
    /** The lane has rows before the oldest one held (`SessionStore.loadOlderSubagent`). */
    val hasBefore: Boolean = false,
    /** Why the lane's stream failed, until it is opened again. */
    val error: String? = null,
)

/**
 * [toolCallId]'s page as [store] changes. The parent transcript streams far more often than a child,
 * so a parent frame only costs a lookup unless it changed what the page shows; frames that arrive
 * during a projection are conflated, and grouping keeps unchanged row instances (incremental).
 */
fun subagentPresentation(
    store: SessionStore,
    toolCallId: String,
    context: CoroutineContext = Dispatchers.Default,
    parent: List<TimelineItem>? = null,
    prepare: (TimelineGrouping) -> Unit = {},
): Flow<SubagentPresentation> {
    return lanePresentation(store, toolCallId, context, parent, prepare)
}

/**
 * Sync v3's subagent page: the child's own lane, already folded by the server, grouped like any
 * transcript. [SubagentPresentation.transcript] carries what the spawning row says of the child
 * (title, type, model, running) and no events.
 */
private fun lanePresentation(
    store: SessionStore,
    toolCallId: String,
    context: CoroutineContext,
    parent: List<TimelineItem>?,
    prepare: (TimelineGrouping) -> Unit,
): Flow<SubagentPresentation> {
    var previous: TimelineGrouping? = null
    val parents = if (parent != null) kotlinx.coroutines.flow.flowOf(parent) else store.timeline
    return combine(store.lane(toolCallId), store.subagents, parents) { lane, stored, spawning ->
        val transcript = stored.firstOrNull { it.toolCallId == toolCallId }?.transcript
        Triple(lane, transcript, subagentTaskInfoWithTranscript(spawning, toolCallId, transcript))
    }
        .distinctUntilChanged { old, new -> old.first === new.first && old.second == new.second && old.third == new.third }
        .conflate()
        .map { (lane, transcript, info) ->
            val running = transcript?.running == true
            val grouping = updateTimelineGrouping(previous, lane.items, running, null).also { previous = it; prepare(it) }
            SubagentPresentation(toolCallId, transcript, info, lane.items, grouping, running, lane.loaded, lane.hasBefore, lane.error)
        }
        .flowOn(context)
}

/**
 * One transcript frame: what [TimelinePresenter] computes off the main thread, as a pure function.
 * [previous] is the last frame's grouping of the same session, so unchanged rows keep their instance.
 */
fun presentTimeline(
    previous: TimelineGrouping?,
    sessionId: String?,
    timeline: List<TimelineItem>,
    queuedRunIds: Set<String>,
    working: Boolean,
    metricsByRun: Map<String, RunMetrics> = emptyMap(),
    outputRate: OutputRate? = null,
    activeTurnId: String? = null,
): TimelinePresentation {
    val plan = latestTodoEntries(timeline)
    val visible = visibleTimeline(timeline, queuedRunIds, dockOwnsPlan = plan != null)
    val grouping = updateTimelineGrouping(previous, visible, working, activeTurnId)
    val nativeMetricsByTurn = buildMap<String, RunMetrics> {
        for (row in grouping.rows) {
            val trigger = (row as? TimelineRow.Single)?.item ?: continue
            if (trigger !is TimelineItem.User && trigger !is TimelineItem.TaskNotification) continue
            val identities = (listOf(trigger.event.base) + trigger.event.sourceEvents).flatMap(::nativeEventIds)
            identities.firstNotNullOfOrNull { metricsByRun["native:$it"] }?.let { put(row.turnKey, it) }
        }
    }
    return TimelinePresentation(
        sessionId = sessionId,
        grouping = grouping,
        todos = plan?.let(::todoEntries).orEmpty(),
        step = if (working) currentStep(timeline) else null,
        // The web's gate (`NativeSession.tsx`): busy, and the turn has shown more than thinking. While
        // it has only thought, the process block's own Working header is the progress sign.
        showsWorking = working && turnHasVisibleOutput(timeline),
        heldFooter = heldFooterRow(grouping.rows),
        compactAbove = grouping.rows.mapIndexed { index, row ->
            val above = grouping.rows.getOrNull(index - 1)?.lastItem()
            val item = row.lastItem()
            above != null && item != null && isCompactItem(above) && isCompactItem(item)
        },
        speeds = buildMap {
            for (row in grouping.rows) {
                // An answer row, or a process block that closes its turn with an answer.
                val turnKey = when {
                    row is TimelineRow.Single && row.item is TimelineItem.Assistant && row.settled -> row.turnKey
                    row is TimelineRow.Process && row.settled && row.answerText != null -> row.turnKey
                    else -> continue
                }
                val runMetrics = runIdFromTurnKey(turnKey)?.let { metricsByRun[it] } ?: nativeMetricsByTurn[turnKey] ?: continue
                speedTag(runMetrics)?.let { put(row.key, it) }
            }
        },
        sessionSpeed = outputRate?.let(::outputRateTag),
        turns = grouping.rows.filter { it is TimelineRow.Single && it.item is TimelineItem.User }.distinctBy { when (it) {
            is TimelineRow.Single -> it.turnKey
            is TimelineRow.Process -> it.turnKey
            is TimelineRow.Trigger -> it.key
        } }.mapNotNull { row ->
            val user = (row as? TimelineRow.Single)?.item as? TimelineItem.User ?: return@mapNotNull null
            TurnTick(row.key, user.text.lineSequence().firstOrNull { it.isNotBlank() }?.trim()?.take(120) ?: L10n.uiText("timeline.attachmentTick"), timelineItemTime(user))
        },
    )
}

private fun TimelineRow.lastItem(): TimelineItem? = when (this) {
    is TimelineRow.Process -> items.lastOrNull()
    is TimelineRow.Single -> item
    is TimelineRow.Trigger -> notices.lastOrNull()
}

private fun speedTag(metrics: RunMetrics): SpeedTag? {
    val rate = tokensPerSecond(metrics) ?: return null
    val estimated = metrics.tokens != RunMetricsTokenSource.PROVIDER
    return SpeedTag((if (estimated) "~" else "") + formatTokensPerSecond(rate) + " tok/s", estimated, speedDescription(metrics))
}

fun outputRateTag(sample: OutputRate): SpeedTag? {
    val rate = outputTokensPerSecond(sample) ?: return null
    val estimated = sample.tokens == RunMetricsTokenSource.ESTIMATED || sample.tokens == RunMetricsTokenSource.MIXED
    return SpeedTag((if (estimated) "~" else "") + formatTokensPerSecond(rate) + " tok/s", estimated, outputRateDescription(sample))
}
