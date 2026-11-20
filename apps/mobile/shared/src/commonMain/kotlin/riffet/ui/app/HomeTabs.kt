package riffet.ui.app

import riffet.ui.theme.appearancePageBackground

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
import riffet_mobile.shared.generated.resources.session_settings
import riffet_mobile.shared.generated.resources.session_tab_new
import riffet_mobile.shared.generated.resources.session_tab_tasks

/** The workbench's destinations, in the bar's order. [key] is the form the launch preference stores. */
enum class HomeTab(val key: String) {
    NEW_SESSION("new"), ASSISTANT("assistant"), TASKS("tasks"), SETTINGS("settings")
}

/** The tab a launch opens: the stored [HomeTab.key]; anything unrecognized (and a first launch) is 助理. */
internal fun homeTab(raw: String?): HomeTab = HomeTab.entries.firstOrNull { it.key == raw } ?: HomeTab.ASSISTANT

/** The key a stored launch choice stands for: an unrecognized one is the default, 助理. */
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
 * The tab chrome around [content]: the app's [RiffetTabBar] on a phone (centred icons, one
 * sliding pill), a navigation rail when [rail]. The keyboard covers the bar, and a page pushed
 * inside a tab slides it away. 任务 carries the number of conversations waiting on the reader.
 */
@Composable
internal fun HomeShell(
    tab: HomeTab,
    onTab: (HomeTab) -> Unit,
    waiting: Int,
    rail: Boolean,
    /** The current tab's page ends in a docked composer ([TabComposerDock]): the bar folds beside it. */
    dock: Boolean = false,
    content: @Composable () -> Unit,
) {
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
                                icon = { TabIcon(if (selected) face.selected else face.icon, face.label, if (entry == HomeTab.TASKS) waiting else 0) },
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
                                    TabIcon(if (selected) face.selected else face.icon, face.label, if (entry == HomeTab.TASKS) waiting else 0)
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
    val fold = animateFloatAsState(if (folded) 1f else 0f, motion.spatial(), label = "dock")
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
                    val gesture = WindowInsets.navigationBars.getBottom(density).toFloat()
                    val faces = HomeTab.entries.map { tabFace(it) }
                    RiffetTabBar(
                        items = HomeTab.entries.mapIndexed { index, entry ->
                            TabBarItem(faces[index].icon, faces[index].selected, faces[index].label, if (entry == HomeTab.TASKS) waiting else 0)
                        },
                        selected = HomeTab.entries.indexOf(tab),
                        onSelect = { onTab(HomeTab.entries[it]) },
                        onReselect = { if (dock) navOpen = false else chrome.reselected += 1 },
                        folded = folded,
                        fold = { fold.value },
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
private fun Modifier.leaving(): Modifier = clearAndSetSemantics { }.pointerInput(Unit) {
    awaitPointerEventScope {
        while (true) awaitPointerEvent(PointerEventPass.Initial).changes.forEach { it.consume() }
    }
}

/** A destination's outline glyph, its filled form while selected (Material's bar convention), and its label. */
private class TabFace(val icon: ImageVector, val selected: ImageVector, val label: String)

/** A tab's name, for the bar and for the launch choice in 设置. */
internal fun HomeTab.title(): StringResource = when (this) {
    HomeTab.NEW_SESSION -> Res.string.session_tab_new
    HomeTab.ASSISTANT -> Res.string.assistant_tab
    HomeTab.TASKS -> Res.string.session_tab_tasks
    HomeTab.SETTINGS -> Res.string.session_settings
}

@Composable
private fun tabFace(tab: HomeTab): TabFace = when (tab) {
    HomeTab.NEW_SESSION -> TabFace(RiffetIcons.MessageSquarePlus, RiffetIcons.MessageSquarePlusFilled, stringResource(Res.string.session_tab_new))
    HomeTab.ASSISTANT -> TabFace(RiffetIcons.Bot, RiffetIcons.Bot, stringResource(Res.string.assistant_tab))
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
