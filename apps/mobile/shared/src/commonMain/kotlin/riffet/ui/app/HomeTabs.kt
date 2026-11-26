package riffet.ui.app

import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.animate
import androidx.compose.foundation.MutatePriority
import androidx.compose.foundation.gestures.ScrollScope
import androidx.compose.foundation.pager.PagerState
import androidx.compose.ui.input.pointer.PointerEvent
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.PointerInputModifierNode
import androidx.compose.ui.unit.IntSize
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

import riffet.ui.theme.appearancePageBackground
import riffet.ui.gesture.SwipeDirection
import riffet.ui.gesture.SwipeDrag
import riffet.ui.gesture.SwipeStart
import riffet.ui.gesture.SwipeSurface
import riffet.ui.gesture.SwipeVerdict
import riffet.ui.gesture.blockSwipes
import riffet.ui.gesture.swallowTouches

import riffet.ui.design.riffetMaterial
import riffet.ui.design.MaterialRole
import riffet.ui.design.RiffetMaterialContent
import androidx.compose.ui.graphics.RectangleShape


import riffet.ui.focus.keyboardPadding
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.pressScale
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.layout.offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LocalContentColor
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.State
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.foundation.layout.ime
import androidx.compose.ui.input.pointer.changedToDown
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.offset
import kotlin.math.roundToInt
import kotlin.math.abs
import riffet.ui.design.keyboardUnfoldSpan
import riffet.ui.design.tabDockBottomPadding
import riffet.ui.design.tabDockInset
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.Stable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.runtime.derivedStateOf
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import riffet.ui.theme.LocalRiffetMotion
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import riffet.ui.icons.Icon
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import riffet.ui.design.TabBarItem
import riffet.ui.design.RiffetTabBar
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.StringResource
import org.jetbrains.compose.resources.stringResource
import riffet.ui.icons.LiveBrandMark
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.assistant_tab
import riffet_mobile.shared.generated.resources.team_tab
import riffet_mobile.shared.generated.resources.session_settings
import riffet_mobile.shared.generated.resources.session_tab_new
import riffet_mobile.shared.generated.resources.session_tab_tasks

/** The workbench's destinations, in the bar's order. [key] is the form the launch preference stores. */
enum class HomeTab(val key: String) {
    NEW_SESSION("new"), ASSISTANT("assistant"), TASKS("tasks"), SETTINGS("settings")
}

/** A tab's badge: the waiting conversations it lists. */
private fun badge(entry: HomeTab, waiting: Int, teamWaiting: Int): Int = when (entry) {
    HomeTab.TASKS -> waiting
    HomeTab.ASSISTANT -> teamWaiting
    else -> 0
}

/** The tab a launch opens: the stored [HomeTab.key]; anything unrecognized (and a first launch) is 新会话. */
internal fun homeTab(raw: String?): HomeTab = HomeTab.entries.firstOrNull { it.key == raw } ?: HomeTab.NEW_SESSION

/** The key a stored launch choice stands for: an unrecognized one is the default, 新会话. */
internal fun homeTabKey(raw: String?): String = homeTab(raw).key

/** From this width the bottom bar becomes a rail at the start edge. */
internal val RailMinWidth = 600.dp

/** From this width the 任务 list and the open session sit side by side. */
internal val TwoPaneMinWidth = 840.dp

/** The list pane's width beside a session. */

/**
 * Pages pushed inside a tab (a settings section, say) report here, so the bar shows on the three
 * roots only. The workbench's own pages and the session already cover the bar; this is the one rule
 * for the rest, kept by [PageHost] rather than by each page.
 */
@Stable
internal class TabChrome {
    var pushed by mutableStateOf(0)
        internal set

    /** Bumped when the current tab is tapped again: its root list scrolls back to the top. */
    var reselected by mutableStateOf(0)
        internal set

    /** How far the bar has opened over a docked composer: 0 folded beside it, 1 open. Read while drawing. */
    var dockOpen: State<Float>? = null
        internal set
}

internal val LocalTabChrome = staticCompositionLocalOf<TabChrome?> { null }
internal val LocalTabContentBottomPadding = staticCompositionLocalOf { 0.dp }

/** The room a tab's composer leaves at its start for the folded bar; zero where the bar is not docked beside it. */
internal val LocalTabDockInset = compositionLocalOf { 0.dp }

/**
 * A tab whose page ends in a session composer: the bar folds to a disc and the resting composer
 * takes the rest of its line, so the two no longer stack. The page keeps these values while it
 * leaves, so nothing in it moves during the tab transition.
 */
@Composable
internal fun TabComposerDock(enabled: Boolean, content: @Composable () -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    CompositionLocalProvider(
        LocalTabContentBottomPadding provides if (enabled) metrics.tabDockBottomPadding else LocalTabContentBottomPadding.current,
        LocalTabDockInset provides if (enabled) metrics.tabDockInset else 0.dp,
        content = content,
    )
}

/**
 * The composer card beside the folded bar. The room is given up as the keyboard carries the card
 * clear of the disc, so the card is full width while writing; it fades while the bar is open over it.
 */
@Composable
internal fun Modifier.besideTabDock(): Modifier {
    val inset = LocalTabDockInset.current
    val chrome = LocalTabChrome.current
    val ime = WindowInsets.ime
    val bars = WindowInsets.navigationBars
    val unfoldSpan = with(LocalDensity.current) { LocalInterfaceStyle.current.metrics.keyboardUnfoldSpan.toPx() }
    return graphicsLayer { alpha = if (inset > 0.dp) 1f - (chrome?.dockOpen?.value ?: 0f) else 1f }
        .layout { measurable, constraints ->
            val full = inset.roundToPx()
            // The card rises with the keyboard; it starts to widen once it is above the disc.
            val rise = (ime.getBottom(this) - bars.getBottom(this)).coerceAtLeast(0)
            val clear = (unfoldSpan / 2f).coerceAtLeast(1f)
            val start = (full * (1f - ((rise - clear) / clear).coerceIn(0f, 1f))).roundToInt()
            val placeable = measurable.measure(constraints.offset(horizontal = -start))
            layout(placeable.width + start, placeable.height) { placeable.placeRelative(start, 0) }
        }
}

/** 新会话 / 设置's back to 任务: the bar's own step, not a layer over the page, so the drawer still opens. */
internal class TabBackTarget(private val onBack: () -> Unit) : PageBackTarget {
    override fun request() = onBack()
}

/**
 * The bottom tabs as a pager: a horizontal drag on a tab root scrolls [pager] by the finger's
 * pixels, and the release settles on the next or previous tab, so the page and the bar follow the
 * hand exactly. It is the tabs' [SwipeSurface] (see `riffet.ui.gesture`): a page pushed inside a tab
 * refuses swipes before they reach it, and the first tab passes a rightward one on to the drawer.
 *
 * Each release commits to a tab at once ([heading]), and a swipe during the settle counts from
 * that tab: quick swipes advance one tab each instead of waiting for the pages to land.
 */
@Stable
internal class TabSwipe(
    private val pager: PagerState,
    private val scope: CoroutineScope,
) : SwipeSurface {
    /** Written after each composition: false on the rail or under a session. */
    var enabled = false
    /** The settle after a release; null jumps (reduced motion). */
    var settle: AnimationSpec<Float>? = null
    /** Release speed, in px/s, past which a short swipe still turns the page. */
    var minFlingVelocity = 0f

    /** The tab the last release settles on, until it lands or another scroll takes over. */
    private var committed by mutableStateOf<Int?>(null)

    /** The tab the pages are going to: a release's choice the moment the finger lifts. */
    val heading: Int get() = committed ?: pager.targetPage

    /** The drag in progress; each drag keeps its own distance and release, so a quick next one cannot take them. */
    private var drag: Drag? = null

    private inner class Drag(val from: Int) : SwipeDrag {
        /** Wakes the scroll session; the distance itself adds up in [pending], so none is lost. */
        val moved = Channel<Unit>(Channel.CONFLATED)
        var pending = 0f
        var travelled = 0f
        var velocity = 0f
        var cancelled = false
        fun take(): Float = pending.also { pending = 0f }

        override fun drag(delta: Float) {
            pending += delta
            travelled += delta
            moved.trySend(Unit)
        }

        override fun release(velocity: Float) {
            this.velocity = velocity
            finish()
        }

        /** Cancelled input goes back to the tab the drag started from. */
        override fun cancel() {
            cancelled = true
            finish()
        }

        private fun finish() {
            moved.close()
            if (this@TabSwipe.drag === this) this@TabSwipe.drag = null
        }
    }

    override fun decide(start: SwipeStart): SwipeVerdict {
        if (!enabled) return SwipeVerdict.Pass
        val forward = start.direction == SwipeDirection.LEFT
        if (HomeTab.entries.getOrNull(heading + if (forward) 1 else -1) == null) return SwipeVerdict.Pass
        return SwipeVerdict.Take { begin() }
    }

    private fun begin(): SwipeDrag {
        val current = Drag(heading)
        drag = current
        // One scroll session per drag: it takes over from the previous settle or a tap's animation,
        // follows every delta, then settles from the release velocity. The pager reports the settled tab.
        scrollSession {
            for (signal in current.moved) scrollBy(-current.take())
            scrollBy(-current.take())
            val to = if (current.cancelled) current.from else target(current)
            committed = to
            settleTo(to, -current.velocity)
        }
        return current
    }

    /**
     * A tab chosen on the bar while a swipe's release is still settling: the tap takes over the way
     * a new drag would. Otherwise the pager's own tap animation runs, which a settle would refuse.
     */
    fun select(page: Int) {
        if (committed == null || committed == page || drag != null) return
        committed = page
        scrollSession { settleTo(page, 0f, jumpFar = true) }
    }

    /** The scroll session that owns [committed]; an earlier one, taken over, leaves it alone. */
    private var session = 0

    private fun scrollSession(block: suspend ScrollScope.() -> Unit) {
        val mine = ++session
        scope.launch {
            try {
                pager.scroll(MutatePriority.UserInput, block)
            } finally {
                if (session == mine) committed = null
            }
        }
    }

    private suspend fun ScrollScope.settleTo(page: Int, velocity: Float, jumpFar: Boolean = false) {
        val size = (pager.layoutInfo.pageSize + pager.layoutInfo.pageSpacing).toFloat()
        val pages = page - pager.currentPage - pager.currentPageOffsetFraction
        val spec = settle
        // A tap two or more pages away switches at once, as the pager's own far tap does. A quick
        // swipe's release can be more than a page off its tab, and still slides.
        if (spec == null || (jumpFar && abs(pages) > 1f)) scrollBy(pages * size)
        else {
            var done = 0f
            animate(0f, pages * size, velocity, spec) { value, _ -> done += scrollBy(value - done) }
        }
    }

    /**
     * One tab per swipe, counted from where the drag began heading. A fling turns it in the drag's
     * direction, a fling back against the drag cancels it, and a slow release turns it past halfway.
     */
    private fun target(current: Drag): Int {
        val page = (pager.layoutInfo.pageSize + pager.layoutInfo.pageSpacing).toFloat().coerceAtLeast(1f)
        // Forward (towards later tabs) is leftward: +1.
        val moved = if (current.travelled < 0f) 1 else -1
        val flung = when {
            current.velocity < -minFlingVelocity -> 1
            current.velocity > minFlingVelocity -> -1
            else -> 0
        }
        val step = when {
            flung != 0 -> if (flung == moved) moved else 0
            abs(current.travelled) > page / 2f -> moved
            else -> 0
        }
        return (current.from + step).coerceIn(0, HomeTab.entries.size - 1)
    }
}

/**
 * The tab chrome around [content]: the app's [RiffetTabBar] on a phone (centred icons, one
 * sliding pill), a navigation rail when [rail]. The keyboard covers the bar, and a page pushed
 * inside a tab slides it away. 任务 and 团队 each carry the number of their conversations waiting on the reader.
 */
@Composable
internal fun HomeShell(
    tab: HomeTab,
    onTab: (HomeTab) -> Unit,
    waiting: Int,
    /** 团队's count: members' conversations waiting on the reader, which 任务 does not list. */
    teamWaiting: Int = 0,
    rail: Boolean,
    /** The tab whose page ends in a docked composer ([TabComposerDock]): there the bar folds beside it. */
    dockTab: HomeTab? = null,
    /** The pages' scroll position in tabs (0 is the first), read while laying out and drawing. */
    position: () -> Float = { tab.ordinal.toFloat() },
    /**
     * The tab the pages are heading to: the drag's nearer page, or where a release or a tap lands.
     * The bar shows it as selected at once, rather than after the pages settle and [tab] follows.
     */
    heading: () -> HomeTab = { tab },
    content: @Composable () -> Unit,
) {
    val dock = tab == dockTab
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val chrome = remember { TabChrome() }
    val style = LocalInterfaceStyle.current
    val surfaces = LocalRiffetSurfaces.current
    var barHeight by remember { mutableStateOf(0.dp) }
    val tabContent: @Composable () -> Unit = {
        CompositionLocalProvider(LocalTabChrome provides chrome,
            LocalTabContentBottomPadding provides if (!rail && chrome.pushed == 0) barHeight else 0.dp,
            content = content)
    }
    if (rail) {
        Row(Modifier.fillMaxSize()) {
            if (chrome.pushed == 0) {
                val destinations: @Composable () -> Unit = {
                    HomeTab.entries.forEach { entry ->
                        val face = tabFace(entry)
                        val selected = entry == tab
                        val select = { if (selected) chrome.reselected += 1 else onTab(entry) }
                        if ((style.components.navigation.rail == riffet.ui.design.ComponentBackend.MATERIAL)) {
                            NavigationRailItem(
                                selected = selected,
                                onClick = select,
                                icon = { TabIcon(if (selected) face.selected else face.icon, face.label, badge(entry, waiting, teamWaiting)) },
                                alwaysShowLabel = false,
                                colors = NavigationRailItemDefaults.colors(
                                    selectedIconColor = surfaces.selectedContent,
                                    unselectedIconColor = colors.fg2,
                                    indicatorColor = surfaces.selected,
                                ),
                            )
                        } else {
                            val source = remember { MutableInteractionSource() }
                            val focused by source.collectIsFocusedAsState()
                            val shape = RoundedCornerShape(style.controlRadius)
                            Box(
                                Modifier.size(64.dp, 56.dp).pressScale(source).clip(shape)
                                    .then(if (focused) Modifier.border(style.metrics.focusWidth, surfaces.focus, shape) else Modifier)
                                    .selectable(selected, interactionSource = source, indication = LocalIndication.current,
                                        role = Role.Tab, onClick = select),
                                contentAlignment = Alignment.Center,
                            ) {
                                CompositionLocalProvider(LocalContentColor provides if (selected) colors.accent else colors.fg3) {
                                    TabIcon(if (selected) face.selected else face.icon, face.label, badge(entry, waiting, teamWaiting))
                                }
                            }
                        }
                    }
                }
                val railSurface = Modifier.riffetMaterial(MaterialRole.NAVIGATION, RectangleShape, pageColor())
                RiffetMaterialContent {
                if ((style.components.navigation.rail == riffet.ui.design.ComponentBackend.MATERIAL)) {
                    NavigationRail(modifier = railSurface, containerColor = Color.Transparent, windowInsets = WindowInsets(0, 0, 0, 0)) {
                        Spacer(Modifier.height(12.dp))
                        destinations()
                    }
                } else {
                    Column(
                        Modifier.width(80.dp).fillMaxHeight().then(railSurface)
                            .padding(horizontal = 8.dp, vertical = 12.dp).selectableGroup(),
                        verticalArrangement = Arrangement.spacedBy(metrics.controlInset / 2),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) { destinations() }
                }
                }
            }
            Box(Modifier.weight(1f).fillMaxHeight().keyboardPadding()) { tabContent() }
        }
        return
    }
    val density = LocalDensity.current
    // The keyboard covers the bar the way a chat app's does: the bar never leaves the layout, and the
    // page above it only gives up what the keyboard rises past the bar. The page follows the inset
    // frame by frame and settles back on the bar, so nothing moves twice.
    val barShown = chrome.pushed == 0
    // Only the keyboard's inset arithmetic needs the height as state; the layout below measures the
    // bar in the same pass as the page, so nothing waits a frame for it.
    // A page pushed inside a tab takes the bar's room at once (it is laid out full height from its
    // first frame), while the bar itself slides down out of the way over it, and back up on return.
    val hidden = animateFloatAsState(if (barShown) 0f else 1f, motion.spatial(), label = "bar")
    val barComposed by remember { derivedStateOf { hidden.value < 1f } }
    // Beside a docked composer the bar is a disc until it is tapped; any touch elsewhere folds it again.
    var navOpen by remember { mutableStateOf(false) }
    LaunchedEffect(dock) { if (!dock) navOpen = false }
    val folded = dock && !navOpen
    // The fold follows the pages: the docked tab's page coming into view folds the bar, leaving it
    // unfolds it, at the finger's pace. Opening the disc unfolds it on its own spring.
    val unfolded = animateFloatAsState(if (navOpen) 1f else 0f, motion.spatial(), label = "dock")
    val latestPosition by rememberUpdatedState(position)
    val fold = remember(dockTab) {
        derivedStateOf {
            val docked = dockTab ?: return@derivedStateOf 0f
            (1f - kotlin.math.abs(latestPosition() - docked.ordinal)).coerceIn(0f, 1f) * (1f - unfolded.value)
        }
    }
    val opened = rememberUpdatedState(dock && navOpen)
    chrome.dockOpen = animateFloatAsState(if (opened.value) 1f else 0f, motion.effects(), label = "dockOpen")
    PageBackHandler(enabled = dock && navOpen) { navOpen = false }
    Layout(
        contents = listOf(
            {
                Box(
                    Modifier
                        // A docked composer sits on the bar's line, so the keyboard lifts it from the first pixel.
                        .consumeWindowInsets(PaddingValues(bottom = if (!barShown) 0.dp else if (dock) metrics.tabDockBottomPadding else barHeight))
                        .keyboardPadding()
                        // The bar opened over a docked composer is modal: the next touch only folds it.
                        .blockSwipes { opened.value }
                        .pointerInput(Unit) {
                            awaitPointerEventScope {
                                while (true) {
                                    val event = awaitPointerEvent(PointerEventPass.Initial)
                                    if (opened.value) {
                                        if (event.changes.any { it.changedToDown() }) navOpen = false
                                        event.changes.forEach { it.consume() }
                                    }
                                }
                            }
                        },
                ) { tabContent() }
            },
            {
                if (barShown || barComposed) {
                    // Read here, so only the bar recomposes when the heading changes.
                    val latestHeading by rememberUpdatedState(heading)
                    val shown by remember { derivedStateOf { latestHeading() } }
                    val gesture = WindowInsets.navigationBars.getBottom(density).toFloat()
                    val faces = HomeTab.entries.map { tabFace(it) }
                    RiffetTabBar(
                        items = HomeTab.entries.mapIndexed { index, entry ->
                            TabBarItem(faces[index].icon, faces[index].selected, faces[index].label, badge(entry, waiting, teamWaiting))
                        },
                        selected = HomeTab.entries.indexOf(shown),
                        onSelect = { onTab(HomeTab.entries[it]) },
                        onReselect = { if (dock) navOpen = false else chrome.reselected += 1 },
                        folded = shown == dockTab && !navOpen,
                        fold = { fold.value },
                        position = { latestPosition() },
                        onUnfold = { navOpen = true },
                        // The page is padded off the gesture bar; the bar's colour runs under it anyway.
                        modifier = Modifier
                            .then(if (barShown) Modifier.snackbarBottomBar() else Modifier.leaving())
                            .onSizeChanged { barHeight = with(density) { it.height.toDp() } }
                            .graphicsLayer { translationY = (size.height + gesture) * hidden.value },
                    )
                }
            },
        ),
        modifier = Modifier.fillMaxSize(),
    ) { (page, bar), constraints ->
        val width = constraints.maxWidth
        val height = constraints.maxHeight
        val barPlaceable = bar.firstOrNull()?.measure(constraints.copy(minWidth = width, minHeight = 0))
        val pagePlaceable = page.first().measure(Constraints.fixed(width, height))
        layout(width, height) {
            pagePlaceable.place(0, 0)
            barPlaceable?.place(0, height - barPlaceable.height)
        }
    }
}

/** A bar on its way out: it no longer takes touches or reads to accessibility. */
private fun Modifier.leaving(): Modifier = clearAndSetSemantics { }.swallowTouches { true }

/** A destination's outline glyph, its filled form while selected (Material's bar convention), and its label. */
private class TabFace(val icon: ImageVector, val selected: ImageVector, val label: String)

/**
 * Whether the connected server has team members (docs/TEAM.md): the second tab is then 团队, else the single 个人助理
 * of an older server, or of no server yet.
 */
internal val LocalHasTeam = compositionLocalOf { false }

/** A tab's name, for the bar and for the launch choice in 设置. */
internal fun HomeTab.title(team: Boolean): StringResource = when (this) {
    HomeTab.NEW_SESSION -> Res.string.session_tab_new
    HomeTab.ASSISTANT -> if (team) Res.string.team_tab else Res.string.assistant_tab
    HomeTab.TASKS -> Res.string.session_tab_tasks
    HomeTab.SETTINGS -> Res.string.session_settings
}

@Composable
private fun tabFace(tab: HomeTab): TabFace = when (tab) {
    HomeTab.NEW_SESSION -> TabFace(RiffetIcons.MessageSquarePlus, RiffetIcons.MessageSquarePlusFilled, stringResource(Res.string.session_tab_new))
    HomeTab.ASSISTANT -> if (LocalHasTeam.current) TabFace(RiffetIcons.Users, RiffetIcons.Users, stringResource(Res.string.team_tab))
        else TabFace(RiffetIcons.Bot, RiffetIcons.Bot, stringResource(Res.string.assistant_tab))
    // A checklist has no filled form; the indicator pill carries the selection.
    HomeTab.TASKS -> TabFace(RiffetIcons.ListTodo, RiffetIcons.ListTodo, stringResource(Res.string.session_tab_tasks))
    HomeTab.SETTINGS -> TabFace(RiffetIcons.Settings, RiffetIcons.SettingsFilled, stringResource(Res.string.session_settings))
}

@Composable
private fun TabIcon(icon: ImageVector, label: String, count: Int) {
    val metrics = LocalInterfaceStyle.current.metrics
    if (!(LocalInterfaceStyle.current.components.navigation.badges == riffet.ui.design.ComponentBackend.MATERIAL)) {
        val colors = LocalRiffetColors.current
        Box {
            Icon(icon, contentDescription = label, modifier = Modifier.size(metrics.iconSize))
            if (count > 0) Box(
                Modifier.align(Alignment.TopEnd).offset(x = 10.dp, y = (-5).dp)
                    .background(colors.danger, CircleShape).padding(horizontal = 5.dp, vertical = 1.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(if (count > 99) "99+" else "$count", color = Color.White,
                    style = riffet.ui.theme.LocalRiffetTypography.current.caption, maxLines = 1)
            }
        }
        return
    }
    BadgedBox(badge = { if (count > 0) Badge { Text(if (count > 99) "99+" else "$count") } }) {
        Icon(icon, contentDescription = label, modifier = Modifier.size(metrics.iconSize))
    }
}

/** The empty side of the two panes before a session is chosen: the mark, nothing to read. */
@Composable
internal fun EmptyPane() {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    Box(Modifier.fillMaxSize().appearancePageBackground(colors.bg), contentAlignment = Alignment.Center) {
        LiveBrandMark(fg = colors.fg4, accent = colors.fg4, modifier = Modifier.size(metrics.controlHeight))
    }
}

/**
 * Over a page: while [blocking], the page's own controls get no touches, yet nothing is consumed,
 * so an ancestor's gesture (the tab swipe) still sees the whole drag. Otherwise touches pass
 * through to the page as usual. Read when a touch lands.
 */
internal fun Modifier.blockTouchesWhen(blocking: () -> Boolean): Modifier = this then BlockTouchesElement(blocking)

private class BlockTouchesElement(val blocking: () -> Boolean) : ModifierNodeElement<BlockTouchesNode>() {
    override fun create() = BlockTouchesNode(blocking)
    override fun update(node: BlockTouchesNode) { node.blocking = blocking }
    override fun equals(other: Any?) = other is BlockTouchesElement && other.blocking === blocking
    override fun hashCode() = blocking.hashCode()
}

private class BlockTouchesNode(var blocking: () -> Boolean) : Modifier.Node(), PointerInputModifierNode {
    override fun onPointerEvent(pointerEvent: PointerEvent, pass: PointerEventPass, bounds: IntSize) = Unit
    override fun onCancelPointerInput() = Unit
    // Sharing lets the page beneath receive the touch; not sharing keeps it on this layer alone.
    override fun sharePointerInputWithSiblings(): Boolean = !blocking()
}
