package riffet.ui.timeline

import riffet.ui.design.riffetMaterialSource
import riffet.ui.design.RiffetMaterialSourceContent
import riffet.ui.app.LocalPageActive

import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import riffet.core.TimelineItem
import riffet.ui.focus.LocalFocusCoordinator
import riffet.ui.state.OpenTrace
import riffet.ui.state.lifecycleTrace
import riffet.ui.state.lifecycleTraceEnabled
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetMotion
import riffet.shared.LocalNativeFeatures
import riffet.shared.NativeFeature

/**
 * The conversation transcript: every [TimelineItem], in order, grouped into turns.
 *
 * This is the mobile counterpart of `TranscriptView` + `Timeline` + `TurnProcess` in
 * apps/web/src/app/session, and it renders what `:core` has already computed. Nothing here
 * re-derives a turn, a tool title, a diff or a speed: `timelineTurnKeys`,
 * `analyzeTimelineTurns`, `toolView`, `toolDiffStats`, `lineDiff` and `Speed.kt` all live in
 * `:core` precisely so that there is one projection and two renderers, not two projections.
 *
 * What it does own:
 *
 *  - one lazy item per [TimelineEntry]: a turn's process block is flattened (see
 *    `TimelineLayout.kt`), so a long turn is composed row by row as it scrolls into view instead of
 *    in one frame;
 *  - following the tail — when a row arrives *and* while the last row grows — and staying put the
 *    moment the reader scrolls up. On a phone, being yanked back to the bottom mid-read is the
 *    single most annoying thing a transcript can do. The state is [TimelineFollow], hoisted so the
 *    host draws the way back ([JumpToLatest]) and resumes following when the reader sends.
 *
 * @param layout the flattened rows, built by the caller so the turn rail can share it.
 * @param tail the newest timeline item; a change of identity (a new row, or the streaming row
 *   growing) re-pins the list to the bottom while the reader is following it.
 * @param onToggleProcess folds or unfolds one turn's process block.
 */
@Composable
internal fun Timeline(
    layout: TimelineLayout,
    tail: TimelineItem?,
    onToggleProcess: (TimelineRow.Process) -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
    root: String? = null,
    /** Output speed per answer row ([TimelineRow.key]), as [TimelinePresenter] resolves it. */
    speeds: Map<String, SpeedTag> = emptyMap(),
    onOpenFile: (String, Int?) -> Unit = { _, _ -> },
    listState: LazyListState = rememberLazyListState(),
    /** Drawn after the last row and scrolled with it — the web's 正在处理 line. */
    footer: (@Composable () -> Unit)? = null,
    /**
     * Called whenever the reader is within about two screens of the oldest loaded row, or everything
     * fits on one screen, and once after the first rows are drawn. It must be cheap and idempotent.
     * Rows keep their [TimelineEntry.key], so a page landing above leaves the reader where they are.
     */
    onReachTop: (() -> Unit)? = null,
    /**
     * What the host's older-page request depends on (loading, more to read, failure). A change re-arms
     * [onReachTop] while the reader is still near the top, so a request that was refused or made no
     * progress is asked again once the host could accept it.
     */
    reachTopKey: Any? = null,
    /** A message to bring into view and flash once, e.g. a search hit; see [TimelineFocusTarget]. */
    focus: TimelineFocusTarget? = null,
    /** Whether the list follows the tail; hoisted so the host can offer 回到最新 and resume on send. */
    follow: TimelineFollow = remember { TimelineFollow() },
) {
    riffet.ui.app.TraceLifecycle("timeline")
    val motion = LocalRiffetMotion.current
    val metrics = LocalInterfaceStyle.current.metrics
    val reduced = rememberReducedMotion()
    val focusFadeMillis = motionDuration(reduced, motion.LONG * 2)
    val state = listState
    // A transcript that opens following its tail is measured at the tail from its first frame:
    // laid out from the top, it would compose a screen of the oldest rows only to jump past them.
    // The offset past the end is clamped by the measure itself, so a last answer taller than the
    // screen opens on its newest line (and the footer below it) instead of its first, one frame
    // before the pin below would get there.
    val opened = remember { booleanArrayOf(false) }
    if (!opened[0] && layout.entries.isNotEmpty()) {
        opened[0] = true
        if (follow.following && focus == null) state.requestScrollToItem(layout.entries.lastIndex, PAST_THE_END)
    }
    val entries by rememberUpdatedState(layout.entries)
    val reachTop by rememberUpdatedState(onReachTop)
    val reachKey by rememberUpdatedState(reachTopKey)
    val toggleProcess by rememberUpdatedState(onToggleProcess)
    // Rows animate out and move only for a moment after the reader folds or unfolds a turn: at any
    // other time (streaming, following) nothing may slide underneath them.
    val scope = rememberCoroutineScope()
    var folding by remember { mutableStateOf(false) }
    val foldReset = remember { arrayOfNulls<Job>(1) }
    val foldByReader: (TimelineRow.Process) -> Unit = remember(motion, reduced) {
        { row ->
            // Every toggle is launched on its own and always applied; only the end of the window is
            // restarted by the next one.
            scope.launch {
                // The rows leaving must already carry their exit when the toggle removes them, so
                // the flag is composed into them first.
                folding = true
                withFrameNanos { }
                withFrameNanos { }
                toggleProcess(row)
                foldReset[0]?.cancel()
                foldReset[0] = scope.launch {
                    delay(motionDuration(reduced, motion.LONG).toLong())
                    folding = false
                }
            }
        }
    }
    val foldingNow by rememberUpdatedState(folding)
    // The row hosting the focus flash, and whether it is lit; only that row runs an animation.
    var flashed by remember { mutableStateOf<String?>(null) }
    var flashLit by remember { mutableStateOf(false) }
    // Read inside each row rather than captured: a metrics frame then recomposes only the rows
    // whose own label changed, not every row on screen.
    val speedsState = rememberUpdatedState(speeds)

    LaunchedEffect(focus, focusFadeMillis, motion) {
        val target = focus ?: return@LaunchedEffect
        // The wait starts once the transcript has rows: a slow load is not a missing message.
        snapshotFlow { entries.isNotEmpty() }.first { it }
        var unfolded = false
        val located = withTimeoutOrNull(FOCUS_WAIT_MILLIS) {
            snapshotFlow { entries }.mapNotNull { current ->
                val exact = current.indexOfFirst { entry ->
                    entrySequence(entry) == target.sequence ||
                        (entry is TimelineEntry.ToolRun && entry.items.any { it.event.sequence == target.sequence })
                }
                if (exact >= 0) return@mapNotNull exact
                // A tool call inside a folded turn has no entry until the turn is unfolded; once.
                if (!unfolded) {
                    val header = current.firstOrNull { entry ->
                        entry is TimelineEntry.ProcessHeader && !entry.open && entry.row.items.any { it.event.sequence == target.sequence }
                    } as TimelineEntry.ProcessHeader?
                    if (header != null) {
                        unfolded = true
                        toggleProcess(header.row)
                    }
                }
                null
            }.first()
        } ?: entries.indexOfLast { (entrySequence(it) ?: Long.MAX_VALUE) <= target.sequence }.takeIf { it >= 0 }
        val index = located ?: return@LaunchedEffect
        // Whatever arrives next must not pull the reader away from what they came to see.
        follow.following = false
        state.scrollToItem(index)
        flashed = entries.getOrNull(index)?.key
        flashLit = true
        try {
            delay((motion.LONG * 4).toLong())
            flashLit = false
            delay(focusFadeMillis.toLong())
        } finally {
            flashLit = false
            flashed = null
        }
    }

    val pin = remember { TailPin() }
    val dragged = state.interactionSource.collectIsDraggedAsState()
    // A drag that starts inside a row's own scroller (a tool output, a long message) reaches the list
    // through nested scroll: the list moves, but its interaction source records no drag and it never
    // reports a scroll in progress, so without this the pin below takes it back every frame.
    val nestedDrag = remember { NestedDrag() }
    val readerDragging by remember { derivedStateOf { dragged.value || nestedDrag.active } }
    LaunchedEffect(state) {
        // Only the reader's *own* gesture changes the intent to follow. Deriving it from
        // `canScrollForward` alone would be wrong in both directions: content arriving grows the
        // list and would look like a scroll, and a list too short to scroll reports "at the end"
        // without anyone having asked to be there.
        // A drag interaction excludes the list's own jumps and animated catch-up.
        snapshotFlow { Triple(readerDragging, state.canScrollForward, pin.animating) }
            .collect { (dragging, canScrollForward, ownScroll) ->
                if (dragging && !ownScroll) {
                    if (canScrollForward || !state.canScrollBackward) follow.following = false
                    else follow.resume()
                }
            }
    }
    LaunchedEffect(state) {
        // Read older pages only after the reader leaves the tail. A short collapsed transcript can
        // fit on screen even with a full window; paging it while following would evict the newest rows.
        // The size re-arms after a page lands and the host's [reachTopKey] after request state moves.
        snapshotFlow {
            // Before the first measure both `canScroll*` read false, which would pass for "fits on screen".
            val measured = entries.isNotEmpty() && state.layoutInfo.visibleItemsInfo.isNotEmpty()
            val near = measured && !follow.following && (
                state.rowsAboveViewport() <= TOP_PREFETCH_SCREENS * state.layoutInfo.viewportSize.height ||
                    (!state.canScrollBackward && !state.canScrollForward)
                )
            Triple(near, entries.size, reachKey)
        }.collect { (near, _, _) -> if (near) reachTop?.invoke() }
    }
    LaunchedEffect(Unit) {
        snapshotFlow { entries.isNotEmpty() }.first { it }
        withFrameNanos { }
        OpenTrace.end()
    }
    // A selection holds the list still: following the tail would scroll the selected row away, and a
    // row that leaves the lazy list takes its selection and Copy menu with it. The end of the
    // selection re-runs this and catches up with whatever streamed in meanwhile.
    val selecting = LocalFocusCoordinator.current.selecting || !riffet.ui.app.LocalPageActive.current
    // Something new arrived while the reader is elsewhere: 回到最新 carries a dot until they return.
    var seenTail by remember { mutableStateOf(tail) }
    LaunchedEffect(tail) {
        if (!follow.following && seenTail != null && tail != seenTail) follow.unread = true
        seenTail = tail
    }
    // Keyed on `following` too: resuming (the button, a send) goes back to the tail at once.
    LaunchedEffect(tail, selecting, follow.following) {
        if (!follow.following) {
            pin.wasFollowing = false
            pin.resuming = false
            return@LaunchedEffect
        }
        // The first run after following was off is a resume: it travels to the tail instead of
        // teleporting. Kept until the tail is reached, so a chunk arriving mid-travel carries on.
        if (!pin.wasFollowing) {
            pin.wasFollowing = true
            pin.resuming = true
        }
        if (selecting || entries.isEmpty()) return@LaunchedEffect
        // Jump to the last entry, then to its end: a long answer is taller than the screen, and
        // its newest line — not its first — is what the reader is waiting for. `scrollBy` clamps
        // at the end of the content, so the large delta only means "all the way". A reader's drag
        // outranks this programmatic scroll and cancels it.
        val last = entries.lastIndex
        val lastVisible = state.layoutInfo.visibleItemsInfo.lastOrNull()
        if (pin.resuming) {
            pin.animating = true
            try {
                // The list's real last item, which is the footer while there is one. A tall answer whose
                // top is already above the viewport has nowhere to travel to but its end: only the snap
                // below applies, animating to its start would run backwards.
                val end = maxOf(last, state.layoutInfo.totalItemsCount - 1)
                if (!(lastVisible?.index == end && lastVisible.offset < 0)) state.animateScrollToItemNear(end)
                state.scrollBy(1_000_000f)
            } finally {
                pin.animating = false
            }
        } else {
            if (lastVisible?.index != last) state.scrollToItem(last)
            state.scrollBy(1_000_000f)
        }
        pin.resuming = false
    }
    // While following, the end of the content stays at the end of the viewport. The list is laid out
    // from the top, so nothing else moves it when the viewport shrinks (the keyboard opening — it
    // resizes every frame —, the composer growing, a card or the working line arriving below) or when
    // the last row grows without a new tail (an answer settling, a block opening): the newest lines
    // would slip behind what arrived. Content hanging below the viewport while following is put
    // right back, a frame behind the change. A resume's travel, a selection and the reader's own
    // scroll or fling are left alone.
    val holding by rememberUpdatedState(selecting)
    LaunchedEffect(state) {
        snapshotFlow {
            Triple(
                state.layoutInfo.viewportSize.height,
                state.canScrollForward,
                follow.following && !holding && !foldingNow && !pin.animating && !state.isScrollInProgress && !readerDragging && entries.isNotEmpty(),
            )
        }.collect { (_, overhang, ready) ->
            // A block opening under the reader's finger grows downward from its header, which stays put:
            // pinning to the end would scroll that header away, so the fold window is left alone.
            if (overhang && ready) {
                state.dispatchRawDelta(1_000_000f)
            }
        }
    }
    // `adb shell setprop log.tag.RiffetLifecycle DEBUG`, restart, then `adb logcat -s RiffetLifecycle`:
    // a settled row that changes height while on screen is logged as `shift`. Each one is a jump the
    // pin above only corrects a frame late, so a first frame that differs from the settled one.
    if (layoutShiftTracing) LaunchedEffect(state) {
        val heights = HashMap<Any, Int>()
        snapshotFlow { state.layoutInfo.visibleItemsInfo.map { it.key to it.size } }.collect { visible ->
            val live = entries.filter { it.live() }.mapTo(HashSet()) { it.key }
            for ((key, size) in visible) {
                val before = heights[key]
                if (before != null && before != size && key !in live) {
                    lifecycleTrace("shift $key $before→$size following=${follow.following}")
                }
            }
            heights.clear()
            for ((key, size) in visible) heights[key] = size
        }
    }

    val direction = LocalLayoutDirection.current
    val fadeMillis = motionDuration(reduced, motion.SHORT)
    val colors = LocalRiffetColors.current
    val fadeIn = LocalNativeFeatures.current.isOn(NativeFeature.FADE_IN)
    RiffetMaterialSourceContent {
    LazyColumn(
        state = state,
        modifier = modifier.riffetMaterialSource(key = follow, enabled = LocalPageActive.current).nestedScroll(nestedDrag)
            .pointerInput(nestedDrag) { with(nestedDrag) { clearOnRelease() } },
        contentPadding = PaddingValues(
            start = TimelineRhythm.gutter + contentPadding.calculateLeftPadding(direction),
            end = TimelineRhythm.gutter + contentPadding.calculateRightPadding(direction),
            top = metrics.controlInset + contentPadding.calculateTopPadding(),
            // Every tail state clears the composer's edge by the same small amount. A larger
            // completed-only inset left the last status row floating above the input.
            bottom = metrics.controlInset / 2 + contentPadding.calculateBottomPadding(),
        ),
    ) {
        items(
            items = layout.entries,
            key = { it.key },
            contentType = { it.contentType },
        ) { entry ->
            // A row that arrives — streamed, unfolded, or an older page — fades in; the rows on
            // screen when the list first lays out do not. With 新内容淡入 off only an unfolding
            // turn's rows do. No placement animation, so streamed rows never slide around
            // underneath the reader; only the reader's own fold or unfold (`folding`) moves rows.
            val itemModifier = if (fadeIn || entry is TimelineEntry.ProcessChild || entry is TimelineEntry.ToolRun) {
                Modifier.animateItem(
                    fadeInSpec = tween(fadeMillis, easing = motion.Standard),
                    placementSpec = if (folding && !reduced) motion.spatial<IntOffset>() else null,
                    fadeOutSpec = if (folding) tween<Float>(motionDuration(reduced, motion.SHORT), easing = motion.Standard) else null,
                )
            } else {
                Modifier
            }
            val flashModifier = if (entry.key == flashed) {
                val flash by animateColorAsState(
                    targetValue = if (flashLit) LocalRiffetSurfaces.current.selected else Color.Transparent,
                    animationSpec = tween(if (flashLit) fadeMillis else focusFadeMillis, easing = motion.Standard),
                    label = "focus",
                )
                Modifier.background(flash, RoundedCornerShape(LocalInterfaceStyle.current.selectionRadius))
            } else {
                Modifier
            }
            val speed by remember(entry) { derivedStateOf { (entry as? TimelineEntry.Row)?.let { speedsState.value[it.row.key] } } }
            Box(itemModifier.fillMaxWidth().padding(top = entry.gap * (metrics.rowPadding / 16.dp)).then(flashModifier)) {
                TimelineEntryView(entry, root, speed, onOpenFile, foldByReader, revealed = entry.key == flashed)
            }
        }
        if (footer != null) {
            item(key = "timeline-footer", contentType = "footer") {
                Box(Modifier.fillMaxWidth().padding(top = 12.dp)) { footer() }
            }
        }
    }
    }
}

/**
 * The tail pin's bookkeeping across effect restarts: whether following was on at the last run, and
 * whether the way back to the tail is still owed an animation ([resuming]). [animating] is read by
 * the scroll-intent observer, which must not mistake the pin's own animated scroll for the reader's.
 */
private class TailPin {
    var wasFollowing = true
    var resuming = false
    var animating by mutableStateOf(false)
}

/**
 * Whether the reader's finger is dragging inside the list, including from a nested scroller. Set by
 * the first drag delta, cleared when the last finger lifts: by then the drag has settled whether the
 * list follows, and a fling that a later touch cancels never reports its end.
 */
private class NestedDrag : NestedScrollConnection {
    var active by mutableStateOf(false)

    override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
        if (source == NestedScrollSource.UserInput) active = true
        return Offset.Zero
    }

    suspend fun PointerInputScope.clearOnRelease() {
        awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            while (awaitPointerEvent(PointerEventPass.Initial).changes.any { it.pressed }) Unit
            active = false
        }
    }
}

/**
 * Scrolls to [index] with an animation that never crosses more than a few screens: from far away
 * the list first jumps to just short of it, so the animation shows the arrival, not hundreds of rows
 * streaming past.
 */
internal suspend fun LazyListState.animateScrollToItemNear(index: Int) {
    val target = index.coerceIn(0, (layoutInfo.totalItemsCount - 1).coerceAtLeast(0))
    val first = firstVisibleItemIndex
    val last = layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: first
    val distance = when {
        target > last -> target - last
        target < first -> first - target
        else -> 0
    }
    if (distance > JUMP_NEAR_ITEMS) {
        scrollToItem(if (target > first) (target - JUMP_LEAD_ITEMS).coerceAtLeast(0) else target + JUMP_LEAD_ITEMS)
    }
    animateScrollToItem(target)
}

/** Further than this many rows from the screen, a programmatic scroll jumps to within [JUMP_LEAD_ITEMS] first. */
private const val JUMP_NEAR_ITEMS = 8
private const val JUMP_LEAD_ITEMS = 3

/**
 * Whether a [Timeline] keeps the newest row in view, and whether rows arrived while it did not.
 * Only the reader's own scroll, a focus jump and [resume] change [following].
 */
@Stable
class TimelineFollow {
    var following by mutableStateOf(true)
        internal set
    var unread by mutableStateOf(false)
        internal set

    /** Leave the tail when the reader chooses an older turn. */
    fun pause() {
        following = false
    }

    /** Back to the newest row, and keep following it. */
    fun resume() {
        following = true
        unread = false
    }
}

private val layoutShiftTracing by lazy { lifecycleTraceEnabled() }

/** Still growing: a streaming answer or a running turn's block changes height by design. */
private fun TimelineEntry.live(): Boolean = when (this) {
    is TimelineEntry.Row -> when (val row = row) {
        is TimelineRow.Single -> !row.settled
        is TimelineRow.Process -> !row.settled
        is TimelineRow.Trigger -> false
    }
    is TimelineEntry.ProcessHeader -> !row.settled
    is TimelineEntry.ProcessChild -> !row.settled
    is TimelineEntry.ToolRun -> !row.settled
    is TimelineEntry.ProcessFooter -> !row.settled
}

/** A scroll offset beyond any row: the list's measure clamps it to the end of the content. */
private const val PAST_THE_END = 1_000_000

/** How far above the viewport (in viewports) the oldest loaded row may be before older history is read. */
private const val TOP_PREFETCH_SCREENS = 2

/**
 * Pixels between the top of the viewport and the oldest loaded row, estimated with the average
 * height of the rows on screen: the rows above are not measured.
 */
private fun LazyListState.rowsAboveViewport(): Float {
    val visible = layoutInfo.visibleItemsInfo
    if (visible.isEmpty()) return 0f
    val average = visible.sumOf { it.size }.toFloat() / visible.size
    return firstVisibleItemIndex * average + firstVisibleItemScrollOffset
}

/** A message the transcript brings into view once; [token] tells a repeated request apart. */
data class TimelineFocusTarget(val sequence: Long, val token: Long)

/** How long a focus waits for its message to be on screen before settling for the nearest one. */
private const val FOCUS_WAIT_MILLIS = 2_500L

/** The event an entry starts at; a footer has none of its own. */
private fun entrySequence(entry: TimelineEntry): Long? = when (entry) {
    is TimelineEntry.Row -> when (val row = entry.row) {
        is TimelineRow.Single -> row.item.event.sequence
        is TimelineRow.Trigger -> row.notices.firstOrNull()?.event?.sequence
        is TimelineRow.Process -> row.items.firstOrNull()?.event?.sequence
    }
    is TimelineEntry.ProcessHeader -> entry.row.items.firstOrNull()?.event?.sequence
    is TimelineEntry.ProcessChild -> entry.item.event.sequence
    is TimelineEntry.ToolRun -> entry.items.first().event.sequence
    is TimelineEntry.ProcessFooter -> null
}

@Composable
private fun TimelineEntryView(
    entry: TimelineEntry,
    root: String?,
    speed: SpeedTag?,
    onOpenFile: (String, Int?) -> Unit,
    onToggleProcess: (TimelineRow.Process) -> Unit,
    revealed: Boolean,
) {
    when (entry) {
        is TimelineEntry.ProcessHeader -> TurnProcessHeader(
            row = entry.row,
            open = entry.open,
            onToggle = { onToggleProcess(entry.row) },
        )

        is TimelineEntry.ProcessChild -> ProcessItem(
            entry.item,
            running = entry.row.turnActive,
            settled = entry.row.settled,
            root = root,
            onOpenFile = onOpenFile,
        )

        is TimelineEntry.ToolRun -> ToolRun(
            items = entry.items,
            followedByContent = entry.followedByContent,
            running = entry.row.running,
            turnActive = entry.row.turnActive,
            root = root,
            reveal = revealed,
        ) { item ->
            ProcessItem(item, running = entry.row.turnActive, settled = entry.row.settled, root = root, onOpenFile = onOpenFile)
        }

        is TimelineEntry.ProcessFooter -> TurnProcessFooter(entry.row)

        is TimelineEntry.Row -> when (val row = entry.row) {
            is TimelineRow.Trigger -> TriggerRow(row.notices)
            is TimelineRow.Single -> SingleRow(row, speed)
            // A process row is always laid out as a header entry; spelled out so the `when` stays
            // exhaustive without an `else` that would swallow a new row kind.
            is TimelineRow.Process -> Unit
        }
    }
}

@Composable
private fun SingleRow(row: TimelineRow.Single, speed: SpeedTag?) {
    when (val item = row.item) {
        is TimelineItem.User -> UserRow(item)
        is TimelineItem.Assistant -> AssistantRow(
            item = item,
            settled = row.settled,
            speed = speed,
        )

        is TimelineItem.TaskNotification -> TaskNotificationRow(item)
        is TimelineItem.Activity -> ActivityRow(item)
        // A process kind is always folded into a Process row, so this is unreachable; it is
        // spelled out rather than using `else` so that adding a ninth variant is a compile
        // error here instead of a silently dropped row.
        is TimelineItem.Thought, is TimelineItem.Tool, is TimelineItem.Plan,
        is TimelineItem.Image, is TimelineItem.Status,
        -> Unit
    }
}

/** One item inside a turn's process block. Mirrors the `switch` in TranscriptView.tsx. */
@Composable
private fun ProcessItem(
    item: TimelineItem,
    running: Boolean,
    settled: Boolean,
    root: String?,
    onOpenFile: (String, Int?) -> Unit,
) {
    when (item) {
        // `!settled`, not `running`: what matters to the renderer is "can this text still grow",
        // and a turn whose block was flushed but is not yet over is still growing.
        is TimelineItem.Thought -> ThoughtRow(item, streaming = !settled)
        is TimelineItem.Assistant -> AssistantRow(item = item, settled = false, speed = null)
        is TimelineItem.Tool -> ToolRow(item, root = root, stale = !running, onOpenFile = onOpenFile)
        is TimelineItem.Plan -> PlanRow(item)
        is TimelineItem.Image -> ImageRow(item.src)
        is TimelineItem.Status -> StatusRow(item)
        is TimelineItem.Activity -> ActivityRow(item)
        // A prompt or a lone notification never reaches the process block.
        is TimelineItem.User, is TimelineItem.TaskNotification -> Unit
    }
}
