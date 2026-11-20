package riffet.ui.app

import androidx.compose.foundation.layout.padding
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import riffet.ui.design.MaterialRole
import riffet.ui.design.RiffetMaterialContent
import riffet.ui.design.riffetMaterial
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitHorizontalTouchSlopOrCancellation
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.horizontalDrag
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import kotlin.math.abs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.icons.RiffetIcons
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.pickers_close
import riffet_mobile.shared.generated.resources.session_details
import riffet.ui.theme.LocalRiffetMotion

/** A fling faster than this settles the drawer the way it was flung, wherever it was let go. */
private val SettleVelocity = 400.dp

/** Quick start, visible easing and a finite end: no spring tail clipped against 0 or 1. */
private val DrawerEaseOut = CubicBezierEasing(0.18f, 0.72f, 0.32f, 1f)

/**
 * The workbench's two side panels: navigation on the left and session details on the right. The
 * phone page moves beside the panel; expanded and physically split windows keep their panes still.
 * Each style supplies its own sheet surface; the right sheet mirrors the left sheet's corners.
 *
 * On the top-level pages a rightward swipe starting anywhere opens the left drawer. Children see the
 * pointer first, so whatever can still move sideways keeps the drag: horizontal scrolling, and on
 * 新会话 the 快速会话 → 新建任务 swipe, so the drawer only opens from 新建任务. In a session a leftward
 * swipe opens the right drawer, and the rightward one is the session's swipe back. Material 3's
 * `ModalNavigationDrawer` cannot do this: it listens for drags across the whole screen and keeps its
 * drag state internal, so a second one could neither share the screen with it nor be driven from
 * here. With a drawer open, a drag anywhere moves that drawer.
 *
 * At most one drawer is open; the caller owns both flags and this reports every settle back to it.
 */
@Composable
internal fun SideDrawers(
    startOpen: Boolean,
    onStartOpenChange: (Boolean) -> Unit,
    endOpen: Boolean,
    onEndOpenChange: (Boolean) -> Unit,
    /** False while there is nothing for the right drawer to show (no session is open). */
    endEnabled: Boolean,
    /** False inside a session: a rightward swipe there is the page's own swipe back. */
    startEnabled: Boolean = true,
    startDrawer: @Composable () -> Unit,
    endDrawer: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    /** The system back gesture while it would close the open drawer; read outside composition. */
    backSwipe: () -> BackSwipe? = { null },
    /** Takes the horizontal drags that would otherwise open a drawer, before the drawers do. */
    pageSwipe: PageSwipe? = null,
    content: @Composable () -> Unit,
) {
    val style = LocalInterfaceStyle.current
    val metrics = style.metrics
    val motion = LocalRiffetMotion.current
    val scope = rememberCoroutineScope()
    // Progress from closed (0) to open (1), one per side.
    val start = remember { DrawerProgress(if (startOpen) 1f else 0f) }
    val end = remember { DrawerProgress(if (endOpen && endEnabled) 1f else 0f) }
    FollowFlag(start, startOpen, motion, scope)
    FollowFlag(end, endOpen && endEnabled, motion, scope)

    // The open drawer gives way a little under the back gesture. A completed gesture clears the
    // flag in the same frame and the drawer closes from where it is; a cancelled one slides it back.
    val latestStartOpen by rememberUpdatedState(startOpen)
    val latestEndOpen by rememberUpdatedState(endOpen && endEnabled)
    val latestBackSwipe by rememberUpdatedState(backSwipe)
    LaunchedEffect(motion) {
        snapshotFlow { latestBackSwipe() }.collectLatest { swipe ->
            val open = when {
                latestStartOpen -> start
                latestEndOpen -> end
                else -> return@collectLatest
            }
            if (swipe != null) open.drag(1f - swipe.progress)
            else if (latestStartOpen || latestEndOpen) open.settle(1f, 0f, motion, scope)
        }
    }

    val latestEndEnabled by rememberUpdatedState(endEnabled)
    val latestStartEnabled by rememberUpdatedState(startEnabled)
    val latestPageSwipe by rememberUpdatedState(pageSwipe)
    val latestActive by rememberUpdatedState(LocalPageActive.current)
    val backDispatcher = LocalPageBackDispatcher.current
    val latestStartChange by rememberUpdatedState(onStartOpenChange)
    val latestEndChange by rememberUpdatedState(onEndOpenChange)
    // Keep content through the closing animation, then release its stream subscriptions.
    // Saveable state preserves each drawer's scroll position on reopening.
    val drawerState = rememberSaveableStateHolder()
    val panelVisible by remember { derivedStateOf { start.value > 0f || end.value > 0f } }
    val startVisible by remember { derivedStateOf { start.value > 0f } }
    val endVisible by remember { derivedStateOf { end.value > 0f } }
    var origin by remember { mutableStateOf(Offset.Zero) }
    val window = LocalRiffetWindowInfo.current

    BoxWithConstraints(modifier = modifier.fillMaxSize().trackForFolds(window) { origin = it.positionInWindow() }) {
        // Preserve usable content in narrow windows even when a theme requests a large gap.
        val availableWidth = maxWidth.coerceAtLeast(0.dp)
        val density = LocalDensity.current
        val fold = separatingFold(window, origin, constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat())
        val edgeWidth = if (fold?.vertical == true) with(density) {
            minOf(fold.bounds.left, constraints.maxWidth - fold.bounds.right).toDp()
        } else availableWidth
        val minContentWidth = minOf(metrics.controlHeight, availableWidth)
        val gap = metrics.drawerMinGap.coerceAtMost((edgeWidth - minContentWidth).coerceAtLeast(0.dp))
        val desiredWidth = if (availableWidth >= TwoPaneMinWidth) maxOf(metrics.drawerWidth, (availableWidth * 0.3f).coerceAtMost(420.dp))
            else metrics.drawerWidth
        val sheetWidth = minOf(desiredWidth, edgeWidth - gap).coerceAtLeast(0.dp)
        val safe = if (fold != null && !fold.vertical) largestSegment(fold, constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat())
            else Rect(0f, 0f, constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat())
        val sheetPx = with(density) { sheetWidth.toPx() }
        val pageShift = if (availableWidth >= TwoPaneMinWidth || fold != null) 0f else sheetPx
        val settlePx = with(density) { SettleVelocity.toPx() }
        val fullPx = constraints.maxWidth.toFloat()

        Box(
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(sheetPx, motion) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        if (!latestActive || sheetPx <= 0f) return@awaitEachGesture
                        // Sheets own their gestures; child scrolling and edge-back consume theirs
                        // before this Main-pass detector decides which drawer to open.
                        if (backDispatcher?.current != null && backDispatcher.current !is PageBackState && backDispatcher.current !is TabBackTarget && backDispatcher.current !is InlineBackTarget && !latestStartOpen && !latestEndOpen) return@awaitEachGesture
                        var side: DrawerProgress? = null
                        // Rightward moves the left drawer open; for the right drawer it is the reverse.
                        var sign = 1f
                        var progress = 0f
                        // A page swipe instead: the pages follow the finger's pixels.
                        var paging: PageSwipe? = null
                        val drag = awaitHorizontalTouchSlopOrCancellation(down.id) { change, overSlop ->
                            val drawerOpen = start.target > 0f || start.value > 0f || end.target > 0f || end.value > 0f
                            val pages = latestPageSwipe
                            if (!drawerOpen && overSlop != 0f && pages != null && pages.begin(forward = overSlop < 0f)) {
                                paging = pages
                                pages.drag(overSlop)
                                change.consume()
                                return@awaitHorizontalTouchSlopOrCancellation
                            }
                            val chosen = when {
                                start.target > 0f || start.value > 0f -> start
                                end.target > 0f || end.value > 0f -> end
                                overSlop > 0f && latestStartEnabled -> start
                                overSlop < 0f && latestEndEnabled -> end
                                else -> null
                            } ?: return@awaitHorizontalTouchSlopOrCancellation
                            side = chosen
                            sign = if (chosen === start) 1f else -1f
                            progress = (chosen.value + sign * overSlop / sheetPx).coerceIn(0f, 1f)
                            chosen.drag(progress)
                            change.consume()
                        } ?: return@awaitEachGesture

                        val tracker = VelocityTracker()
                        tracker.addPosition(drag.uptimeMillis, drag.position)
                        paging?.let { pages ->
                            var velocity = 0f
                            try {
                                horizontalDrag(drag.id) { change ->
                                    tracker.addPosition(change.uptimeMillis, change.position)
                                    pages.drag(change.positionChange().x)
                                    change.consume()
                                }
                                velocity = tracker.calculateVelocity().x
                            } finally {
                                pages.end(velocity)
                            }
                            return@awaitEachGesture
                        }
                        val moving = side ?: return@awaitEachGesture
                        horizontalDrag(drag.id) { change ->
                            tracker.addPosition(change.uptimeMillis, change.position)
                            progress = (progress + sign * change.positionChange().x / sheetPx).coerceIn(0f, 1f)
                            moving.drag(progress)
                            change.consume()
                        }
                        val velocity = sign * tracker.calculateVelocity().x
                        val open = when {
                            velocity > settlePx -> true
                            velocity < -settlePx -> false
                            else -> progress > 0.5f
                        }
                        moving.settle(if (open) 1f else 0f, velocity / sheetPx, motion, scope)
                        if (moving === start) latestStartChange(open) else latestEndChange(open)
                    }
                },
        ) {
            // Page and panel share one horizontal edge at every animation frame.
            Box(Modifier.fillMaxSize().offset { IntOffset(((start.value - end.value) * pageShift).roundToInt(), 0) }
                .then(if (panelVisible) Modifier.clearAndSetSemantics { } else Modifier)) {
                content()
                if (panelVisible) {
                    Box(Modifier.fillMaxSize().pointerInput(Unit) {
                        detectTapGestures {
                            if (start.value > 0f) latestStartChange(false)
                            if (end.value > 0f) latestEndChange(false)
                        }
                    })
                }
            }

            // Panels extend through system bars while their own content pads away from those bars.
            Box(Modifier.fillMaxWidth().offset(y = with(density) { safe.top.toDp() })
                .height(with(density) { safe.height.toDp() })
                .then(if (fold == null || fold.vertical) Modifier.coverSystemBars() else Modifier)) {
                if (startOpen || startVisible) {
                    drawerState.SaveableStateProvider("start") {
                        DrawerSheet(
                            width = sheetWidth,
                            navigation = true,
                            modifier = Modifier.offset { IntOffset(((start.value - 1f) * sheetPx).roundToInt(), 0) },
                            content = startDrawer,
                        )
                    }
                }
                if (endEnabled && (endOpen || endVisible)) {
                    drawerState.SaveableStateProvider("end") {
                        DrawerSheet(
                            width = sheetWidth,
                            modifier = Modifier.offset { IntOffset((fullPx - end.value * sheetPx).roundToInt(), 0) },
                            content = endDrawer,
                        )
                    }
                }
            }
        }
    }
}

/** Owns one drawer position, so drag samples and the settling animation cannot overtake each other. */
private class DrawerProgress(initial: Float) {
    var value by mutableFloatStateOf(initial)
        private set
    var target = initial
        private set
    private var job: Job? = null

    fun drag(progress: Float) {
        val next = progress.coerceIn(0f, 1f)
        if (target.isNaN() && value == next) return
        job?.cancel()
        target = Float.NaN
        value = next
    }

    fun settle(next: Float, velocity: Float, motion: riffet.ui.theme.RiffetMotion, scope: CoroutineScope) {
        if (target == next) return
        job?.cancel()
        target = next
        val from = value
        job = scope.launch {
            // A finite, distance-aware settle avoids the spring's long subpixel tail at the edge.
            // Faster releases shorten the remaining trip without a second animation when the flag changes.
            val distance = abs(next - from)
            val speed = abs(velocity).coerceAtMost(4f)
            val duration = ((motion.MEDIUM + motion.SHORT / 2f) * distance / (1f + speed * 0.12f)).roundToInt()
                .coerceIn(120, (motion.MEDIUM + motion.SHORT / 2).coerceAtLeast(120))
            animate(initialValue = from, targetValue = next,
                animationSpec = tween(durationMillis = duration, easing = DrawerEaseOut)) { position, _ ->
                value = position
            }
            value = next
        }
    }
}

/** Follows programmatic open and close requests without restarting a gesture's settle. */
@Composable
private fun FollowFlag(progress: DrawerProgress, open: Boolean, motion: riffet.ui.theme.RiffetMotion, scope: CoroutineScope) {
    LaunchedEffect(open, motion) { progress.settle(if (open) 1f else 0f, 0f, motion, scope) }
}

@Composable
private fun DrawerSheet(width: Dp, modifier: Modifier, navigation: Boolean = false, content: @Composable () -> Unit) {
    val colors = LocalRiffetColors.current
    val style = LocalInterfaceStyle.current
    val surface = LocalRiffetSurfaces.current
    // The navigation drawer sits at the left edge, the details at the right: each keeps clear of
    // a landscape navigation bar or cutout on its own side only.
    val safe = systemBarsPadding()
    val padding = PaddingValues.Absolute(
        left = if (navigation) safe.calculateLeftPadding(LayoutDirection.Ltr) else 0.dp,
        top = safe.calculateTopPadding(),
        right = if (navigation) 0.dp else safe.calculateRightPadding(LayoutDirection.Ltr),
        bottom = safe.calculateBottomPadding(),
    )
    if (LocalInterfaceStyle.current.components.lists.grouped) {
        val radius = style.groupRadius
        val shape = if (navigation) RoundedCornerShape(topEnd = radius, bottomEnd = radius)
            else RoundedCornerShape(topStart = radius, bottomStart = radius)
        val title = if (navigation) "Riffet" else stringResource(Res.string.session_details)
        Box(
            modifier.width(width).fillMaxHeight().semantics { paneTitle = title }
                .clip(shape)
                // Keep blank header and safe-area taps on the sheet, above the scrim.
                // Do not consume: child actions and the ancestor's drawer drag still receive input.
                .pointerInput(Unit) {},
        ) {
            Box(Modifier.matchParentSize().riffetMaterial(MaterialRole.SIDEBAR, shape, surface.groupedPage))
            Column(Modifier.fillMaxSize().padding(padding)) {
                RiffetMaterialContent(baseBackground = surface.groupedPage) {
                    Box(Modifier.fillMaxWidth().weight(1f)) { content() }
                }
            }
        }
        return
    }
    ModalDrawerSheet(
        drawerShape = if (navigation) RoundedCornerShape(topEnd = style.metrics.groupRadius, bottomEnd = style.metrics.groupRadius)
            else RoundedCornerShape(topStart = style.metrics.groupRadius, bottomStart = style.metrics.groupRadius),
        drawerContainerColor = Color.Transparent,
        drawerTonalElevation = 0.dp,
        drawerContentColor = colors.fg,
        windowInsets = WindowInsets(0, 0, 0, 0),
        modifier = modifier.width(width).fillMaxHeight(),
    ) {
        Box(Modifier.fillMaxSize()) {
            // Keep the effect on an empty sibling: cards and controls draw above its output.
            Box(Modifier.matchParentSize().riffetMaterial(MaterialRole.SIDEBAR,
                if (navigation) RoundedCornerShape(topEnd = style.metrics.groupRadius, bottomEnd = style.metrics.groupRadius)
                else RoundedCornerShape(topStart = style.metrics.groupRadius, bottomStart = style.metrics.groupRadius), surface.groupedPage))
            RiffetMaterialContent(baseBackground = surface.groupedPage) {
                Box(Modifier.fillMaxSize().padding(padding)) { content() }
            }
        }
    }
}

/**
 * Horizontal swipes between neighbouring pages (the bottom tabs), arbitrated by [SideDrawers] with
 * its own drags so one gesture never moves both. Called on the pointer thread, outside composition.
 */
internal interface PageSwipe {
    /** A drag toward the next page ([forward]) or the previous one starts; false leaves it to the drawers. */
    fun begin(forward: Boolean): Boolean
    /** The finger moved by [delta] px (positive is rightward). */
    fun drag(delta: Float)
    /** The finger lifted at [velocity] px/s (positive is rightward); the pages settle from there. */
    fun end(velocity: Float)
}
