package riffet.ui.timeline

import riffet.contracts.NativeActivityKind
import riffet.contracts.RunState
import riffet.core.AssistantPhase
import riffet.core.ReasoningChannel
import riffet.core.StatusTone
import riffet.core.TimelineItem
import riffet.core.TimelineItemKind
import riffet.core.analyzeTimelineTurns
import riffet.core.kind
import riffet.core.timelineItemTime
import riffet.core.toolKind
import riffet.ui.composer.visibleTimeline

/*
 * ============================================================================================
 * Turn grouping: the transcript's rows
 * ============================================================================================
 *
 * The single pure function in this package, and the only thing here worth a test.
 *
 * It is a port of the node-building loop at the top of `TranscriptView.tsx`, and it exists because
 * the alternative — deciding in composition what groups with what — puts three rules where nobody
 * can see them:
 *
 *  1. reasoning, tool calls, plans, images, and intermediate assistant prose fold into
 *     **one** process block per turn; final answers, terminal results and user rows stand outside. A
 *     message's phase says which it is (`commentary` folds, `final_answer` stands outside even if
 *     later work follows it); without one, prose that precedes process work folds;
 *  2. a process block never spans two turns: a new turn key flushes it;
 *  3. consecutive task notifications become one *trigger* row, and leave the turn grouping
 *     entirely, because the CLI injects them into the turn they woke.
 *
 * Only `TimelineItem` and the `core` helpers are used here: no Compose, no JSON, no clock. That is
 * what makes it testable, and it is why every derived flag (running, settled, elapsed bounds,
 * counts) is computed once here rather than at render time.
 */

/** The kinds the web folds into a turn's process block (`processKinds` in TranscriptView.tsx). */
private val PROCESS_KINDS = setOf(
    TimelineItemKind.THOUGHT,
    TimelineItemKind.TOOL,
    TimelineItemKind.PLAN,
    TimelineItemKind.IMAGE,
)

/**
 * A turn's footer (its time and actions) and the row that carries it, as the turn goes from running
 * to settled: the web's `TurnFooter`. The row that would carry it holds its place while the turn
 * runs ([HELD]) and fills it when the turn settles ([SHOWN]), so settling never changes the
 * transcript's height; every other row has none. A row stops holding only because a later row took
 * over the turn's end, which is the transcript growing anyway.
 */
enum class TurnFooter { NONE, HELD, SHOWN }

/** The row holding the place of a running turn's footer, where the working line goes. The latest one wins. */
fun heldFooterRow(rows: List<TimelineRow>): String? = rows.lastOrNull { it.footer == TurnFooter.HELD }?.key

/**
 * One row of the transcript, after grouping.
 *
 * `Process` and `Trigger` are the rows the web builds synthetically; `Single` is everything that
 * keeps its own place in the conversation body.
 */
sealed interface TimelineRow {
    val key: String
    val footer: TurnFooter

    /** The collapsible "Thinking · tools · plan" block of exactly one turn. */
    data class Process(
        override val key: String,
        val turnKey: String,
        val items: List<TimelineItem>,
        /** The header remains Working until the whole turn, including its answer, finishes. */
        val running: Boolean,
        /** The turn is live, whichever block this is; a pending call in it can still finish. */
        val turnActive: Boolean,
        val settled: Boolean,
        /**
         * The turn's last item is in this block: no answer follows it. A block that stops running
         * like this was interrupted or failed, and stays open instead of folding away.
         */
        val endsTurn: Boolean,
        val toolCount: Int,
        /** Terminal failures keep the preceding work open by default; the result itself stays outside. */
        val issueCount: Int,
        /** ISO stamps in, formatting out: this file never touches a clock. */
        val startedAt: String?,
        val endedAt: String?,
        /** The turn's latest prose, carried so a turn that stopped on a tool can still be copied. */
        val answerText: String?,
        /** Explicit stop state also preserves the block when partial prose follows it. */
        val interrupted: Boolean = false,
        /** The turn was stopped while this block was its end: the header reads Stopped, once for the turn. */
        val stopped: Boolean = false,
        /** An answer, or a settled question or plan review, follows this block in its turn. */
        val followedByAnswer: Boolean = false,
        /**
         * The web's `canAutoFold`: only a normal completion folds by itself. A running, stopped,
         * steered, failed or unknown turn, an unfinished tool, or a missing answer keeps it open.
         */
        val canAutoFold: Boolean = false,
        /** The block carries the footer only when its turn ends on it without an answer. */
        override val footer: TurnFooter = TurnFooter.NONE,
    ) : TimelineRow

    /** The batch of task notifications that woke one turn. */
    data class Trigger(
        override val key: String,
        val notices: List<TimelineItem.TaskNotification>,
        val time: String?,
    ) : TimelineRow {
        override val footer: TurnFooter get() = TurnFooter.NONE
    }

    /** A row that stands in the conversation body: a prompt, an answer, a result or a lone notification. */
    data class Single(
        override val key: String,
        val item: TimelineItem,
        val turnKey: String,
        /** Whether this row closes its turn and the turn is over: the answer's footer condition. */
        val settled: Boolean,
        /** An answer or result's footer: held while its turn runs, shown once it settles ([TurnFooter]). */
        override val footer: TurnFooter = TurnFooter.NONE,
        /** The latest prose copied by a terminal result that closes a turn without a final answer. */
        val answerText: String? = null,
        /**
         * The turn was stopped and this row ends it, so it says so: an answer in its footer, a
         * prompt that drew no output under itself. A status row (run_cancelled) says it already.
         */
        val stopped: Boolean = false,
    ) : TimelineRow
}

/**
 * The grouping and the turn analysis it was built from, so a caller that needs both — the
 * transcript's rows and the turn rail's running ticks — pays for `analyzeTimelineTurns` once
 * instead of twice. The row objects are the same ones `buildTimelineRows` used to return.
 */
class TimelineGrouping(
    val rows: List<TimelineRow>,
    val activeTurns: Set<String>,
    /** The items [rows] were built from; [updateTimelineGrouping] diffs the next frame against them. */
    val items: List<TimelineItem> = emptyList(),
    val sessionRunning: Boolean = false,
    val turnKeys: List<String> = emptyList(),
    val lastIndexByTurn: Map<String, Int> = emptyMap(),
    val processingTurn: String? = null,
    /** The row each item landed in. Rows cover the items contiguously and in order. */
    val rowOfItem: IntArray = IntArray(0),
    /** The first item of each row. */
    val rowFirstItem: IntArray = IntArray(0),
    val activeTurnId: String? = null,
    /** Turns with an explicit final answer: that answer carries the footer, not a block after it. */
    val finalAnswerTurns: Set<String> = emptySet(),
) {
    fun withRows(rows: List<TimelineRow>, items: List<TimelineItem> = this.items) = TimelineGrouping(
        rows, activeTurns, items, sessionRunning, turnKeys, lastIndexByTurn, processingTurn, rowOfItem, rowFirstItem, activeTurnId, finalAnswerTurns,
    )
}

/**
 * Groups [items] into rows, mirroring `TranscriptView`'s node loop.
 *
 * [activeTurnId] is the provider's live turn identity when available; it can wake a completed Run.
 * [sessionRunning] is the session's own "the CLI is still working" flag. It can recover an active
 * turn when a native echo has no Run yet, or when its uncertain send was dismissed as "已核对".
 * It can also keep the latest sent turn open when same-turn native output arrived after its Run
 * was marked completed. Another busy turn cannot reopen old work.
 */
fun buildTimelineRows(
    items: List<TimelineItem>,
    sessionRunning: Boolean,
    activeTurnId: String? = null,
): List<TimelineRow> = buildTimelineGrouping(items, sessionRunning, activeTurnId).rows

/** [buildTimelineRows] plus the `activeTurns` the same analysis produced, for callers needing both. */
fun buildTimelineGrouping(
    items: List<TimelineItem>,
    sessionRunning: Boolean,
    activeTurnId: String? = null,
): TimelineGrouping {
    val visible = visibleTimeline(items, emptySet(), false)
    if (visible !== items) return buildTimelineGrouping(visible, sessionRunning, activeTurnId)
    val analysis = analyzeTimelineTurns(items, sessionRunning, activeTurnId)
    val turnKeys = analysis.turnKeys
    val activeTurns = analysis.activeTurns

    // The live CLI can keep producing output after the persisted run says completed. The turn the
    // last non-prompt row belongs to is the one still processing.
    val latestOutputIndex = items.indexOfLast { it.kind != TimelineItemKind.USER && it.kind != TimelineItemKind.ACTIVITY }
    val processingTurn = if (sessionRunning && latestOutputIndex >= 0) {
        turnKeys[latestOutputIndex].takeIf { it in activeTurns }
    } else null
    val interruptedTurns = HashSet<String>()
    val outcomeUnknownTurns = HashSet<String>()
    val finalAnswerIndexByTurn = HashMap<String, Int>()
    val lastSteerIndexByTurn = HashMap<String, Int>()
    items.forEachIndexed { index, item ->
        if (item is TimelineItem.Assistant && item.phase == AssistantPhase.FINAL_ANSWER) {
            finalAnswerIndexByTurn[turnKeys[index]] = index
        } else if (item.kind != TimelineItemKind.ACTIVITY && item.kind != TimelineItemKind.TASK_NOTIFICATION) {
            finalAnswerIndexByTurn.remove(turnKeys[index])
        }
        if (item is TimelineItem.User && item.run?.native?.intent == "steer") lastSteerIndexByTurn[turnKeys[index]] = index
        if (item is TimelineItem.User && item.run?.native?.intent != "steer") {
            if (item.run?.native?.stage == "turn_outcome_unknown") {
                outcomeUnknownTurns.add(turnKeys[index])
            } else if (item.run?.state == RunState.INTERRUPTED ||
                (item.run?.state == RunState.CANCELLED && item.run?.native?.stage != "acknowledged")) {
                interruptedTurns.add(turnKeys[index])
            }
        }
    }
    // A steer or user-facing decision tool (`question` / `plan` review) shares its execution turn
    // with the preceding answer. Later tool work may collect prose from its own segment, but must
    // not pull an earlier answer back into a process.
    val assistantBeforeProcess = BooleanArray(items.size)
    val laterProcessTurns = HashSet<String>()
    for (index in items.indices.reversed()) {
        val item = items[index]
        if (item is TimelineItem.User) laterProcessTurns.clear()
        else if (item.isInteractionTool()) laterProcessTurns.remove(turnKeys[index])
        else if (item.kind in PROCESS_KINDS || item is TimelineItem.Status || item.isCommentary()) laterProcessTurns.add(turnKeys[index])
        else if (item is TimelineItem.Assistant) assistantBeforeProcess[index] = turnKeys[index] in laterProcessTurns
    }
    val activityBeforeProcess = BooleanArray(items.size)
    var nextProcessTurn: String? = null
    for (index in items.indices.reversed()) {
        val item = items[index]
        if (item.isProcessActivity()) {
            activityBeforeProcess[index] = nextProcessTurn == turnKeys[index]
            if (!activityBeforeProcess[index]) nextProcessTurn = null
        } else {
            nextProcessTurn = turnKeys[index].takeIf {
                (!item.isInteractionTool() && item.kind in PROCESS_KINDS) || item.isCommentary() ||
                    (item is TimelineItem.Assistant && item.phase == null && assistantBeforeProcess[index])
            }
        }
    }
    fun isProcessItem(item: TimelineItem, index: Int, continuingProcess: Boolean): Boolean {
        if (item.isInteractionTool()) return false
        if (item.kind in PROCESS_KINDS) return true
        if (item.isProcessActivity()) {
            // Compaction and task updates stay with the surrounding work without splitting its
            // process block or turning an earlier final answer into process prose.
            return continuingProcess || activityBeforeProcess[index]
        }
        if (item !is TimelineItem.Assistant) return false
        // The provider's phase decides; only a message without one is placed by what follows it.
        return item.phase?.let { it == AssistantPhase.COMMENTARY } ?: assistantBeforeProcess[index]
    }

    // The web's `followedByAnswer`: prose outside a process, or a question or plan review that has
    // settled, comes later in the turn.
    fun followedByAnswer(last: Int, turnKey: String): Boolean {
        val turnEnd = analysis.lastIndexByTurn[turnKey] ?: return false
        val stale = turnKey !in activeTurns
        return ((last + 1)..turnEnd).any { index ->
            if (turnKeys[index] != turnKey) return@any false
            when (val later = items[index]) {
                is TimelineItem.Assistant -> later.phase?.let { it != AssistantPhase.COMMENTARY } ?: !assistantBeforeProcess[index]
                is TimelineItem.Tool -> later.isInteractionTool() && toolItemLiveness(later, stale).let { !it.active && !it.incomplete }
                else -> false
            }
        }
    }

    fun endsTurn(index: Int): Boolean {
        val next = items.getOrNull(index + 1)
        return next == null ||
            turnKeys[index + 1] != turnKeys[index] ||
            next.kind == TimelineItemKind.USER ||
            next.kind == TimelineItemKind.TASK_NOTIFICATION ||
            next.kind == TimelineItemKind.ACTIVITY
    }

    val rows = mutableListOf<TimelineRow>()
    val rowOfItem = IntArray(items.size)
    val rowFirstItem = ArrayList<Int>()
    var groupStart = -1
    var groupTurnKey = ""
    var groupLastIndex = -1
    var lastTurnKey = ""

    fun addRow(row: TimelineRow, first: Int, last: Int) {
        for (index in first..last) rowOfItem[index] = rows.size
        rowFirstItem.add(first)
        rows.add(row)
    }

    fun flushGroup() {
        if (groupStart < 0) return
        val first = groupStart
        groupStart = -1
        addRow(
            processRow(
                items, first, groupLastIndex, groupTurnKey, activeTurns, turnKeys, analysis.lastIndexByTurn, processingTurn,
                groupTurnKey in interruptedTurns, groupTurnKey in outcomeUnknownTurns, groupTurnKey in finalAnswerIndexByTurn,
                beforeSteer = groupLastIndex < (lastSteerIndexByTurn[groupTurnKey] ?: -1),
                followedByAnswer = followedByAnswer(groupLastIndex, groupTurnKey),
            ),
            first,
            groupLastIndex,
        )
    }

    var index = 0
    while (index < items.size) {
        val item = items[index]
        val turnKey = turnKeys[index]

        // The CLI gives each injected notice its own turn id, so the batch is recognised by being
        // consecutive rather than by sharing a turn: they woke the same reply.
        if (item is TimelineItem.TaskNotification && turnKey != lastTurnKey) {
            val start = index
            val notices = mutableListOf<TimelineItem.TaskNotification>()
            while (index < items.size && items[index] is TimelineItem.TaskNotification) {
                notices.add(items[index] as TimelineItem.TaskNotification)
                index += 1
            }
            flushGroup()
            addRow(
                TimelineRow.Trigger(
                    key = "trigger:${notices.first().key}",
                    notices = notices,
                    time = timelineItemTime(notices.last()),
                ),
                start,
                index - 1,
            )
            lastTurnKey = turnKey
            continue
        }

        if (isProcessItem(item, index, groupStart >= 0 && groupTurnKey == turnKey)) {
            if (groupStart >= 0 && groupTurnKey != turnKey) flushGroup()
            if (groupStart < 0) {
                groupStart = index
                groupTurnKey = turnKey
            }
            groupLastIndex = index
            lastTurnKey = turnKey
            index += 1
            continue
        }

        flushGroup()
        lastTurnKey = turnKey
        // The turn's answer, or what would be it if the turn ended now. A paragraph can pause before
        // another tool batch or a steer input; only that turn's activity settles its footer,
        // regardless of where the live tail sits.
        val finalAnswer = finalAnswerIndexByTurn[turnKey]
        val carries = when (item) {
            is TimelineItem.Assistant -> if (finalAnswer == null) analysis.lastIndexByTurn[turnKey] == index else finalAnswer == index
            is TimelineItem.Status -> finalAnswer == null && analysis.lastIndexByTurn[turnKey] == index
            is TimelineItem.Tool -> finalAnswer == null && item.isInteractionTool() && analysis.lastIndexByTurn[turnKey] == index
            else -> false
        }
        // For a user row, `settled` records that same-turn output already follows it.
        val settled = if (item is TimelineItem.User) !endsTurn(index) else carries && turnKey !in activeTurns
        addRow(
            TimelineRow.Single(
                key = item.key,
                item = item,
                turnKey = turnKey,
                settled = settled,
                footer = footerOf(carries, settled),
                answerText = if (settled && (item is TimelineItem.Status || item is TimelineItem.Tool)) latestAnswerText(items, turnKeys, index) else null,
                stopped = turnKey in interruptedTurns && analysis.lastIndexByTurn[turnKey] == index &&
                    (item is TimelineItem.Assistant || item is TimelineItem.User || item.isInteractionTool()),
            ),
            index,
            index,
        )
        index += 1
    }
    flushGroup()
    return TimelineGrouping(
        rows = rows,
        activeTurns = activeTurns,
        items = items,
        sessionRunning = sessionRunning,
        turnKeys = turnKeys,
        lastIndexByTurn = analysis.lastIndexByTurn,
        processingTurn = processingTurn,
        rowOfItem = rowOfItem,
        rowFirstItem = rowFirstItem.toIntArray(),
        activeTurnId = activeTurnId,
        finalAnswerTurns = finalAnswerIndexByTurn.keys,
    )
}

private fun TimelineItem.isCommentary(): Boolean = this is TimelineItem.Assistant && phase == AssistantPhase.COMMENTARY

/** User-facing decision tools (AskQuestion / AskUserQuestion / proposed plan reviews) stand outside the process block and bound earlier prose. */
private fun TimelineItem.isInteractionTool(): Boolean =
    this is TimelineItem.Tool && toolKind(event.base).let { it == "question" || it == "plan" }

private fun TimelineItem.isProcessActivity(): Boolean = this is TimelineItem.Activity &&
    (activity.kind == NativeActivityKind.BACKGROUND_TASK || activity.kind == NativeActivityKind.COMPACTION)

private fun footerOf(carries: Boolean, settled: Boolean): TurnFooter =
    if (!carries) TurnFooter.NONE else if (settled) TurnFooter.SHOWN else TurnFooter.HELD

private fun latestAnswerText(items: List<TimelineItem>, turnKeys: List<String>, last: Int): String? {
    var index = last
    while (index >= 0 && turnKeys[index] == turnKeys[last]) {
        val candidate = items[index]
        if (candidate is TimelineItem.Assistant) return candidate.text
        index -= 1
    }
    return null
}

/** One turn's process block over `items[first..last]`; shared by the full grouping and the patch. */
private fun processRow(
    items: List<TimelineItem>,
    first: Int,
    last: Int,
    turnKey: String,
    activeTurns: Set<String>,
    turnKeys: List<String>,
    lastIndexByTurn: Map<String, Int>,
    processingTurn: String?,
    interrupted: Boolean,
    outcomeUnknown: Boolean = false,
    hasFinalAnswer: Boolean,
    /** Work the reader steered after stays open, as the web keeps it (`lastSteerIndexByTurn`). */
    beforeSteer: Boolean = false,
    followedByAnswer: Boolean,
): TimelineRow.Process {
    val grouped = items.subList(first, last + 1).toList()
    val turnActive = turnKey in activeTurns
    // Turn analysis excludes activities; a trailing activity still belongs to the block whose
    // last actual output closes the turn.
    val ends = lastIndexByTurn[turnKey]?.let { it in first..last } == true
    // Answer prose starts streaming before the turn finishes. Keep its process block Working
    // until the whole turn ends so the first answer chunk does not also collapse the transcript.
    // Earlier process blocks before a later interaction tool, steer, or process block are done.
    val turnEnd = lastIndexByTurn[turnKey] ?: last
    val hasLaterSegment = ((last + 1)..turnEnd).any { index ->
        if (turnKeys[index] != turnKey) return@any false
        val later = items[index]
        later.isInteractionTool() || later is TimelineItem.User || later is TimelineItem.Thought ||
            later is TimelineItem.Tool || later is TimelineItem.Plan || later is TimelineItem.Image || later.isCommentary()
    }
    val running = turnActive && !hasLaterSegment
    // The block carries the footer only when the turn ends on it without an answer.
    val carries = ends && !hasFinalAnswer
    val settled = carries && !turnActive && turnKey != processingTurn
    // A turn that stopped on a tool, as an interrupted one does, has no answer row to carry the
    // copy action, so its footer copies the turn's latest prose — what that row would have copied.
    val answerText = if (settled) latestAnswerText(items, turnKeys, last) else null
    val issueCount = (first..(lastIndexByTurn[turnKey] ?: last)).count {
        val item = items[it]
        turnKeys[it] == turnKey && item is TimelineItem.Status && item.tone == StatusTone.DANGER
    }
    val held = interrupted || outcomeUnknown || beforeSteer
    val hasIncompleteTools = grouped.any { it is TimelineItem.Tool && toolItemLiveness(it, stale = !running).incomplete }
    return TimelineRow.Process(
        key = "process:${grouped.first().key}",
        turnKey = turnKey,
        items = grouped,
        running = running,
        turnActive = running,
        settled = settled,
        endsTurn = ends,
        toolCount = grouped.count { isToolRunItem(it) },
        issueCount = issueCount,
        startedAt = timelineItemTime(grouped.first { it !is TimelineItem.Activity }),
        endedAt = timelineItemTime(grouped.last { it !is TimelineItem.Activity }),
        answerText = answerText,
        // Interrupted, outcome-unknown and steered-after work stays expanded; only a confirmed stop labels "已停止".
        interrupted = held,
        stopped = interrupted && !outcomeUnknown && ends,
        followedByAnswer = followedByAnswer,
        canAutoFold = !running && !held && issueCount == 0 && followedByAnswer && !hasIncompleteTools,
        footer = footerOf(carries, settled),
    )
}

/**
 * The next frame's grouping, built from [previous] instead of from scratch whenever it can be.
 *
 * A streamed chunk only grows an answer, a thought or a tool row: same key, same kind, same turn.
 * None of that can move a row boundary or change a turn's state, so the rows that hold a changed
 * item are rebuilt in place and every other row keeps its instance — which is what lets the lazy
 * list skip them. Anything else (a row appended, a prompt's run changing, a failure) regroups in
 * full, and the regrouped rows that came out equal to the previous ones still keep their
 * instances. Either way the result equals `buildTimelineGrouping(items, sessionRunning)`.
 */
fun updateTimelineGrouping(
    previous: TimelineGrouping?,
    items: List<TimelineItem>,
    sessionRunning: Boolean,
    activeTurnId: String? = null,
): TimelineGrouping {
    val visible = visibleTimeline(items, emptySet(), false)
    if (visible !== items) return updateTimelineGrouping(previous, visible, sessionRunning, activeTurnId)
    if (previous == null || previous.sessionRunning != sessionRunning || previous.activeTurnId != activeTurnId || previous.items.size != items.size) {
        return keepEqualRows(previous, buildTimelineGrouping(items, sessionRunning, activeTurnId))
    }
    var dirty: BooleanArray? = null
    var answerTurns: MutableSet<String>? = null
    for (index in items.indices) {
        val before = previous.items[index]
        val after = items[index]
        if (before === after) continue
        if (!patchable(before, after)) return keepEqualRows(previous, buildTimelineGrouping(items, sessionRunning, activeTurnId))
        // A late chunk can cross the completed Run's timestamp without adding a row.
        // Recheck attribution until a turn becomes active; ordinary streaming keeps its fast path.
        if (sessionRunning && previous.activeTurns.isEmpty() && timelineItemTime(before) != timelineItemTime(after)) {
            return keepEqualRows(previous, buildTimelineGrouping(items, sessionRunning, activeTurnId))
        }
        val rows = dirty ?: BooleanArray(previous.rows.size).also { dirty = it }
        rows[previous.rowOfItem[index]] = true
        if (after is TimelineItem.Assistant) {
            (answerTurns ?: mutableSetOf<String>().also { answerTurns = it }).add(previous.turnKeys[index])
        }
    }
    val changed = dirty ?: return previous.withRows(previous.rows, items)
    // A settled process or terminal result can copy its turn's prose, so edits reach that footer too.
    answerTurns?.let { turns ->
        previous.rows.forEachIndexed { index, row ->
            if (row is TimelineRow.Process && row.settled && row.turnKey in turns ||
                row is TimelineRow.Single && (row.item is TimelineItem.Status || row.item is TimelineItem.Tool) && row.settled && row.turnKey in turns) changed[index] = true
        }
    }
    val rows = previous.rows.toMutableList()
    for (index in rows.indices) {
        if (!changed[index]) continue
        val first = previous.rowFirstItem[index]
        val last = previous.rowFirstItem.getOrElse(index + 1) { items.size } - 1
        rows[index] = when (val row = rows[index]) {
            is TimelineRow.Single -> row.copy(
                item = items[first],
                answerText = if ((row.item is TimelineItem.Status || row.item is TimelineItem.Tool) && row.settled) latestAnswerText(items, previous.turnKeys, first) else null,
            )
            // `interrupted` folds in the turn's stop, an unknown outcome and a later steer; any of
            // them keeps it true here, and a stop that ends the turn keeps `stopped` too.
            is TimelineRow.Process -> processRow(
                items, first, last, row.turnKey,
                previous.activeTurns, previous.turnKeys, previous.lastIndexByTurn, previous.processingTurn,
                interrupted = row.stopped,
                outcomeUnknown = row.interrupted && !row.stopped,
                hasFinalAnswer = row.turnKey in previous.finalAnswerTurns,
                // A patch moves no boundary and leaves question and plan tools alone (`patchable`).
                followedByAnswer = row.followedByAnswer,
            )
            // Notices are never patched (see `patchable`), so a trigger row never gets here.
            is TimelineRow.Trigger -> row
        }
    }
    return previous.withRows(rows, items)
}

/**
 * Whether [after] can replace [before] without regrouping: same key, kind and turn, and nothing
 * the grouping reads (a prompt's run, a notice, a status tone, a thought's channel) has changed.
 */
private fun patchable(before: TimelineItem, after: TimelineItem): Boolean {
    if (before.key != after.key || before.event.runId != after.event.runId ||
        before.event.nativeTurnId != after.event.nativeTurnId || before.event.turn != after.event.turn) return false
    return when (after) {
        is TimelineItem.Assistant -> before is TimelineItem.Assistant && before.phase == after.phase
        is TimelineItem.Thought -> before is TimelineItem.Thought && before.channel == after.channel
        // A question or plan review settling decides whether the work before it is followed by an answer.
        is TimelineItem.Tool -> before is TimelineItem.Tool && !before.isInteractionTool() && !after.isInteractionTool()
        is TimelineItem.Plan -> before is TimelineItem.Plan
        is TimelineItem.Image -> before is TimelineItem.Image
        is TimelineItem.Status -> before is TimelineItem.Status && before.tone == after.tone
        // Status updates stay in place; a kind change may enter or leave a process block.
        is TimelineItem.Activity -> before is TimelineItem.Activity && before.activity.kind == after.activity.kind
        is TimelineItem.User, is TimelineItem.TaskNotification -> false
    }
}

/** [fresh] with every row that equals its previous version replaced by that previous instance. */
private fun keepEqualRows(previous: TimelineGrouping?, fresh: TimelineGrouping): TimelineGrouping {
    if (previous == null || previous.rows.isEmpty()) return fresh
    val byKey = HashMap<String, TimelineRow>(previous.rows.size * 2)
    previous.rows.forEach { byKey[it.key] = it }
    var reused = false
    val rows = fresh.rows.map { row ->
        val old = byKey[row.key]
        if (old != null && old == row) {
            reused = true
            old
        } else {
            row
        }
    }
    return if (reused) fresh.withRows(rows) else fresh
}

/**
 * The web's `compact(item)`: only single-line rows pack tightly. Narration is prose and gets the
 * same breathing room as a message; raw thinking folds to one line and packs with the tool rows
 * around it.
 */
fun isCompactItem(item: TimelineItem): Boolean = when (item) {
    is TimelineItem.Tool -> true
    is TimelineItem.Thought -> item.channel == ReasoningChannel.THINKING
    is TimelineItem.Activity -> item.isProcessActivity()
    else -> false
}
