package riffet.ui.timeline

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import riffet.core.ReasoningChannel
import riffet.core.TimelineItem

/*
 * ============================================================================================
 * Rows to lazy entries
 * ============================================================================================
 *
 * A turn's process block (reasoning, every tool call, the plan) used to be one `LazyColumn` item.
 * A long turn is dozens of tool rows plus markdown, and a lazy list composes and measures an item
 * whole: scrolling onto one meant building all of it inside a single frame. That is the jank.
 *
 * So an open block is flattened here into a header entry, one entry per child and a footer, each
 * its own lazy item with its own `contentType`. The list then composes only what is on screen and
 * reuses compositions between rows of the same shape. The grouping itself (`buildTimelineGrouping`)
 * is unchanged; this only decides how a grouped row is laid out.
 *
 * A stretch of tool calls (and the folded reasoning between them) inside an open block is one entry,
 * the web's `ToolRun`: folded, it is a single line naming what the calls did, so a long turn mostly
 * costs one row per stretch rather than one per call.
 */

/** One lazy item of the transcript. */
internal sealed interface TimelineEntry {
    val key: String
    val contentType: Int

    /** The space above this entry; the container owns the rhythm, rows add none of their own. */
    val gap: Dp

    /** A prompt, an answer, a notification batch: a grouped row that is a single item. */
    data class Row(val row: TimelineRow, override val key: String, override val gap: Dp) : TimelineEntry {
        override val contentType: Int get() = when (row) {
            is TimelineRow.Single -> when (row.item) {
                is TimelineItem.User -> TYPE_USER
                is TimelineItem.Assistant -> TYPE_ASSISTANT
                else -> TYPE_OTHER
            }
            is TimelineRow.Trigger -> TYPE_TRIGGER
            is TimelineRow.Process -> TYPE_PROCESS_HEADER
        }
    }

    /** The "Working · 1m 2s · 6 tools" line that folds a turn's process away. */
    data class ProcessHeader(
        val row: TimelineRow.Process,
        val open: Boolean,
        override val key: String,
        override val gap: Dp,
    ) : TimelineEntry {
        override val contentType: Int get() = TYPE_PROCESS_HEADER
    }

    /** One reasoning block, intermediate prose, tool call, plan, image or status line inside an open turn. */
    data class ProcessChild(
        val row: TimelineRow.Process,
        val item: TimelineItem,
        override val key: String,
        override val gap: Dp,
    ) : TimelineEntry {
        override val contentType: Int get() = when (item) {
            is TimelineItem.Assistant -> TYPE_ASSISTANT
            is TimelineItem.Thought -> TYPE_THOUGHT
            is TimelineItem.Tool -> TYPE_TOOL
            is TimelineItem.Plan -> TYPE_PLAN
            is TimelineItem.Image -> TYPE_IMAGE
            else -> TYPE_OTHER
        }
    }

    /**
     * Consecutive ordinary tool calls and folded reasoning inside an open turn (see [toolRunEnd]).
     * Its fold is the entry's own saveable state, which the lazy list keeps by [key] — the run's
     * first item — while the entry is off screen.
     */
    data class ToolRun(
        val row: TimelineRow.Process,
        val items: List<TimelineItem>,
        /** Something follows the run: a later item of the block, or the answer after it. */
        val followedByContent: Boolean,
        override val key: String,
        override val gap: Dp,
    ) : TimelineEntry {
        override val contentType: Int get() = TYPE_TOOL_RUN
    }

    /** A settled turn's copy action and end time, shown whether or not the block is open. */
    data class ProcessFooter(
        val row: TimelineRow.Process,
        override val key: String,
        override val gap: Dp,
    ) : TimelineEntry {
        override val contentType: Int get() = TYPE_PROCESS_FOOTER
    }
}

private const val TYPE_USER = 1
private const val TYPE_ASSISTANT = 2
private const val TYPE_TRIGGER = 3
private const val TYPE_PROCESS_HEADER = 4
private const val TYPE_PROCESS_FOOTER = 5
private const val TYPE_THOUGHT = 6
private const val TYPE_TOOL = 7
private const val TYPE_PLAN = 8
private const val TYPE_IMAGE = 9
private const val TYPE_OTHER = 10
private const val TYPE_TOOL_RUN = 11

/** Gap between the process header and its first child, and between two children. */
private val CHILD_FIRST_GAP = 4.dp
private val CHILD_COMPACT_GAP = 0.dp
// Layout baseline; Timeline applies the theme's rowPadding scale to every entry.gap once.
private val CHILD_GAP get() = 10.dp * TimelineRhythm.scale
private val FOOTER_GAP = 2.dp

/**
 * The flattened transcript, plus where each grouped row starts in it so the turn rail can jump to
 * a row's first entry.
 */
internal class TimelineLayout(
    val entries: List<TimelineEntry>,
    val rowStart: IntArray,
)

/**
 * Lays [rows] out as lazy entries. Keys are made unique here, because a duplicate key is not a
 * rendering glitch in a `LazyColumn` but an `IllegalArgumentException` that takes the app down;
 * the projection is not supposed to produce one, and this guarantees a slip there costs nothing.
 *
 * An entry that would come out the same as in [previous] — same row instance, same item, same
 * gap and fold — is that previous instance. The lazy list compares entries by identity, so this is
 * what keeps a streamed chunk from recomposing every row on screen.
 */
internal fun layoutTimeline(
    rows: List<TimelineRow>,
    previous: TimelineLayout? = null,
    isOpen: (TimelineRow.Process) -> Boolean,
): TimelineLayout {
    val entries = ArrayList<TimelineEntry>(rows.size * 2)
    val rowStart = IntArray(rows.size)
    val seen = HashSet<String>(rows.size * 2)
    val earlier = previous?.entries.orEmpty()
    var earlierByKey: HashMap<String, TimelineEntry>? = null
    fun push(entry: TimelineEntry) {
        // Positions only shift when rows are added or removed, so the same index is tried first.
        val atIndex = earlier.getOrNull(entries.size)
        val old = if (atIndex?.key == entry.key) {
            atIndex
        } else {
            val byKey = earlierByKey ?: HashMap<String, TimelineEntry>(earlier.size * 2).also { map ->
                earlier.forEach { map[it.key] = it }
                earlierByKey = map
            }
            byKey[entry.key]
        }
        entries.add(if (old != null && sameEntry(old, entry)) old else entry)
    }
    fun unique(key: String): String {
        if (seen.add(key)) return key
        var suffix = 1
        while (true) {
            val candidate = "$key#$suffix"
            if (seen.add(candidate)) return candidate
            suffix += 1
        }
    }

    rows.forEachIndexed { index, row ->
        rowStart[index] = entries.size
        val gap = rowGap(rows.getOrNull(index - 1), row)
        when (row) {
            is TimelineRow.Process -> {
                val open = isOpen(row)
                push(TimelineEntry.ProcessHeader(row, open, unique(row.key), gap))
                if (open) {
                    val items = row.items
                    var childIndex = 0
                    while (childIndex < items.size) {
                        val item = items[childIndex]
                        val before = items.getOrNull(childIndex - 1)
                        val childGap = when {
                            before == null -> CHILD_FIRST_GAP
                            isCompactItem(before) && isCompactItem(item) -> CHILD_COMPACT_GAP
                            else -> CHILD_GAP
                        }
                        val end = toolRunEnd(items, childIndex)
                        if (end > childIndex) {
                            val run = items.subList(childIndex, end).toList()
                            val followed = !row.endsTurn || end < items.size
                            // Keyed as its first call was alone: the row that grows into a run stays
                            // the same lazy item, rather than fading in again as a new one.
                            push(TimelineEntry.ToolRun(row, run, followed, unique("${row.key}/${item.key}"), childGap))
                            childIndex = end
                            continue
                        }
                        push(TimelineEntry.ProcessChild(row, item, unique("${row.key}/${item.key}"), childGap))
                        childIndex += 1
                    }
                }
                if (row.settled) {
                    push(TimelineEntry.ProcessFooter(row, unique("${row.key}/footer"), FOOTER_GAP))
                }
            }

            else -> push(TimelineEntry.Row(row, unique(row.key), gap))
        }
    }
    return TimelineLayout(entries, rowStart)
}

private fun sameEntry(old: TimelineEntry, new: TimelineEntry): Boolean = when (new) {
    is TimelineEntry.Row -> old is TimelineEntry.Row && old.row === new.row && old.gap == new.gap
    is TimelineEntry.ProcessHeader ->
        old is TimelineEntry.ProcessHeader && old.row === new.row && old.open == new.open && old.gap == new.gap
    // A child reads only `turnActive` and `settled` from its row, so a sibling that grew does not
    // make it a different entry.
    is TimelineEntry.ProcessChild -> old is TimelineEntry.ProcessChild && old.item === new.item && old.gap == new.gap &&
        old.row.turnActive == new.row.turnActive && old.row.settled == new.row.settled
    // A run also reads `running`, for reasoning still streaming at its end.
    is TimelineEntry.ToolRun -> old is TimelineEntry.ToolRun && old.gap == new.gap &&
        old.followedByContent == new.followedByContent && old.row.running == new.row.running &&
        old.row.turnActive == new.row.turnActive && old.row.settled == new.row.settled &&
        old.items.size == new.items.size && old.items.indices.all { old.items[it] === new.items[it] }
    is TimelineEntry.ProcessFooter -> old is TimelineEntry.ProcessFooter && old.row === new.row && old.gap == new.gap
}

/**
 * Where the tool run starting at [start] ends (exclusive), or [start] when none starts there. A run
 * gathers ordinary tool calls and the folded reasoning between them, so a thought does not split
 * one stretch of work into lone calls; prose, delegations and anything else end it. It needs a call
 * in it and two items, or its items stand on their own (the web's `toolRuns`).
 */
private fun toolRunEnd(items: List<TimelineItem>, start: Int): Int {
    var end = start
    while (end < items.size && joinsToolRun(items[end])) end += 1
    return if (end - start > 1 && (start until end).any { isToolRunItem(items[it]) }) end else start
}

private fun joinsToolRun(item: TimelineItem): Boolean =
    isToolRunItem(item) || (item is TimelineItem.Thought && item.channel == ReasoningChannel.THINKING)

/**
 * Which turns are open, kept per process row and outliving the row's own composition — the header
 * is a lazy item now, so state remembered inside it would be lost the moment it scrolls away.
 *
 * Running and failed process blocks open by default. Completed and interrupted work folds,
 * including work with no answer. Explicit reading choices survive run-state transitions.
 */
@Stable
internal class ProcessFolds {
    private class Fold(var open: Boolean, var manual: Boolean, var running: Boolean, var issues: Int)

    private val folds = HashMap<String, Fold>()

    /** Bumped on every manual toggle so a layout keyed on it is rebuilt. */
    var version by mutableIntStateOf(0)
        private set

    /** Applies run-state transitions from a fresh grouping. Idempotent for the same rows. */
    fun sync(rows: List<TimelineRow>) {
        for (row in rows) {
            if (row !is TimelineRow.Process) continue
            val fold = folds[row.key]
            if (fold == null) {
                folds[row.key] = Fold(
                    open = row.running || row.issueCount > 0,
                    manual = false,
                    running = row.running,
                    issues = row.issueCount,
                )
                continue
            }
            if (!fold.manual && row.running != fold.running) {
                fold.open = row.running || row.issueCount > 0
            }
            if (row.issueCount != fold.issues && row.issueCount > 0 && !fold.manual) fold.open = true
            fold.running = row.running
            fold.issues = row.issueCount
        }
    }

    fun isOpen(row: TimelineRow.Process): Boolean = folds[row.key]?.open ?: (row.running || row.issueCount > 0)

    fun toggle(row: TimelineRow.Process) {
        val fold = folds.getOrPut(row.key) {
            Fold(open = isOpen(row), manual = false, running = row.running, issues = row.issueCount)
        }
        fold.manual = true
        fold.open = !fold.open
        version += 1
    }
}
