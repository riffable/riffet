package riffet.ui.pickers

import androidx.compose.animation.EnterExitState
import riffet.ui.gesture.swipeSurface
import riffet.ui.gesture.SwipeVerdict
import riffet.ui.gesture.SwipeSurface
import riffet.ui.gesture.SwipeDrag
import riffet.ui.gesture.SwipeDirection
import riffet.ui.gesture.horizontalSwipeArbiter
import riffet.ui.gesture.swallowTouches
import riffet.ui.design.materialContentBackground

import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.theme.LocalRiffetPageMotion
import androidx.compose.material3.LocalContentColor
import riffet.ui.settings.SettingsNoticeKind
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import riffet.ui.focus.keyboardPadding
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animate
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import riffet.ui.design.floatingShadow
import riffet.ui.design.SheetRecipe
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.MaterialRole
import riffet.ui.design.RiffetMaterialWindow
import riffet.ui.design.RiffetMaterialContent
import riffet.ui.design.riffetMaterial
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.RiffetIconButton
import riffet.ui.design.RiffetTextButton
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import riffet.ui.app.LocalPageActive
import riffet.ui.app.PageBackHandler
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.ui.icons.RiffetIcons
import riffet.ui.settings.SettingsSwitch
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.shared.LocalNativeFeatures
import riffet.shared.NativeFeature

/*
 * ============================================================================================
 * The shared chrome every picker on this screen is built from
 * ============================================================================================
 *
 * On the web a picker is a popover anchored to its trigger, and on a phone that pattern is the
 * wrong shape: the trigger is 32dp wide and the list is 300px. The web itself already splits the
 * two (`MOBILE_LAYOUT_QUERY` turns `ModelPicker`'s parameter controls into stacked full-width
 * fields), so this is the same control with the phone's own geometry: a sheet over a scrim, with
 * the title, the explanation and the options in one column.
 *
 * Nothing here invents a colour or a size. Every value comes from `riffet.theme.RiffetTheme`
 * (generated) through `LocalRiffetColors` / `LocalRiffetTypography`, exactly like the transcript.
 */

/**
 * What a sheet's pages talk to: the frame's animated close and the back step of whichever page is
 * showing. A page never unmounts its sheet itself, because the frame has to slide it away first.
 */
@Stable
internal class PickerHost(var dismiss: () -> Unit) {
    /** The visible page's back step; null means back closes the sheet. */
    var back: (() -> Unit)? = null

    fun requestBack() {
        val step = back
        if (step != null) step() else dismiss()
    }
}

/** A host for a sheet that is not a [PickerSheetFrame], e.g. a page inside another sheet system. */
@Composable
internal fun rememberPickerHost(dismiss: () -> Unit): PickerHost =
    remember { PickerHost(dismiss) }.also { it.dismiss = dismiss }

/** Once the sheet has started leaving, its dismissal is delivered exactly once, wherever the exit ends. */
private class SheetExit {
    var closing = false
    private var delivered = false

    fun deliver(dismiss: () -> Unit) {
        if (!closing || delivered) return
        delivered = true
        dismiss()
    }
}

internal val LocalPickerHost = staticCompositionLocalOf<PickerHost?> { null }

/** False for a page that is only still on screen while it leaves; its back step is not the sheet's. */
// Flips with every picker page: only its readers recompose.
private val LocalPickerPageActive = compositionLocalOf { true }

/**
 * The sheet itself: a scrim, and a bottom-anchored card that slides up from, and back down to, the
 * bottom edge. Every way out (scrim, close, back, a pick, a swipe) goes through the same slide, and
 * [onDismiss] runs once it has finished, which is when the caller may unmount. A second request
 * while it is leaving is ignored and touches are swallowed, so a double tap cannot select twice.
 *
 * Pages call [PickerHost.dismiss] from [LocalPickerHost]; a pick applies its choice first and only
 * then asks the sheet to leave, so the choice never waits for the animation.
 */
@Composable
internal fun PickerSheetFrame(
    onDismiss: () -> Unit,
    navigationPanel: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val latestDismiss by rememberUpdatedState(onDismiss)
    // Outlives the early return below: a page that goes inactive mid-exit drops the sheet and its
    // coroutines, and the caller must still hear about the dismissal, once.
    val exit = remember { SheetExit() }
    val pageActive = LocalPageActive.current
    SideEffect { if (!pageActive) exit.deliver { latestDismiss() } }
    DisposableEffect(Unit) { onDispose { exit.deliver { latestDismiss() } } }
    if (!pageActive) return
    val colors = LocalRiffetColors.current
    val recipe = LocalInterfaceStyle.current.components.sheets
    val actionSheet = recipe.actionSheet && !navigationPanel
    val surfaces = LocalRiffetSurfaces.current
    val floatingPanel = recipe.insetFloating && LocalInterfaceStyle.current.variants.navigation == riffet.ui.design.NavigationPresentation.FLOATING
    val sheetShape: androidx.compose.ui.graphics.Shape = when {
        actionSheet -> RectangleShape
        floatingPanel -> RoundedCornerShape(metrics.groupRadius)
        else -> RoundedCornerShape(topStart = metrics.groupRadius, topEnd = metrics.groupRadius)
    }
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    // Read in the page's window: the panel's own has not heard of the keyboard yet.
    val pageIme = WindowInsets.ime
    val keyboardUp = remember { pageIme.getBottom(density) > 0 }
    // 0 is below the screen, 1 is in place; the scrim follows the same value.
    val shown = remember { Animatable(0f) }
    var dragOffset by remember { mutableFloatStateOf(0f) }
    var sheetHeight by remember { mutableIntStateOf(0) }
    var closing by remember { mutableStateOf(false) }
    var settling by remember { mutableStateOf<Job?>(null) }
    val host = rememberPickerHost {}
    host.dismiss = {
        if (!closing) {
            closing = true
            exit.closing = true
            scope.launch {
                shown.animateTo(0f, motion.exit())
                exit.deliver { latestDismiss() }
            }
        }
    }
    PageBackHandler(onBack = host::requestBack)
    // Starts once the height is known, so the first frame is already off-screen and the slide
    // covers the sheet's whole height rather than a nudge.
    LaunchedEffect(sheetHeight > 0) {
        if (sheetHeight > 0 && !closing) shown.animateTo(1f, motion.settle())
    }
    // Swipe-down to close. The sheet follows the finger from its header and any non-scrolling area
    // (`draggable`), and from a scrolled list once that list is back at its top (the nested-scroll
    // connection); letting go past a third of its height, or flinging, closes it, and either way it
    // finishes with the velocity the finger left it.
    val flingClose = with(density) { 1200.dp.toPx() }
    fun settle(velocity: Float) {
        if (closing) return
        val close = dragOffset > sheetHeight / 3f || velocity > flingClose
        settling?.cancel()
        settling = scope.launch {
            if (close) {
                closing = true
                exit.closing = true
                animate(dragOffset, sheetHeight.toFloat().coerceAtLeast(dragOffset), initialVelocity = velocity, animationSpec = motion.settle()) { value, _ -> dragOffset = value }
                exit.deliver { latestDismiss() }
            } else {
                // A fast upward release would spring past zero and lift the sheet off the bottom edge.
                animate(dragOffset, 0f, initialVelocity = velocity, animationSpec = motion.settle()) { value, _ -> dragOffset = value.coerceAtLeast(0f) }
            }
        }
    }
    val dragState = rememberDraggableState { delta ->
        settling?.cancel()
        dragOffset = (dragOffset + delta).coerceAtLeast(0f)
    }
    val nestedDrag = remember(motion, flingClose) {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                // Pulled down and now pushed back up: the sheet returns before the list scrolls.
                if (!closing && available.y < 0f && dragOffset > 0f) {
                    settling?.cancel()
                    val used = maxOf(available.y, -dragOffset)
                    dragOffset += used
                    return Offset(0f, used)
                }
                return Offset.Zero
            }

            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                if (!closing && available.y > 0f && source == NestedScrollSource.UserInput) {
                    settling?.cancel()
                    dragOffset += available.y
                    return Offset(0f, available.y)
                }
                return Offset.Zero
            }

            override suspend fun onPreFling(available: Velocity): Velocity {
                if (closing || dragOffset <= 0f) return Velocity.Zero
                settle(available.y)
                return available
            }
        }
    }
    val scrim = surfaces.scrim

    // A modal belongs to the window, not the page's clipped viewport below its header/tab bar.
    Popup(
        popupPositionProvider = remember { object : PopupPositionProvider {
            override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize) = IntOffset.Zero
        } },
        onDismissRequest = host::requestBack,
        properties = PopupProperties(focusable = true, dismissOnClickOutside = false, clippingEnabled = false),
    ) {
        RiffetMaterialWindow {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    // The popup is its own window: its sub-pages' swipe back and its scrollers enlist here.
                    .horizontalSwipeArbiter()
                    // While the sheet leaves, nothing under it may react: consumed in the initial pass, the
                    // sheet's own rows and the scrim never see the touch.
                    .swallowTouches { closing },
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        // The layer is outside the background so the alpha fades the scrim itself, and the
                        // lambda form keeps the per-frame value out of composition.
                        .graphicsLayer {
                            val dragFade = if (sheetHeight > 0) (1f - dragOffset / sheetHeight).coerceIn(0f, 1f) else 1f
                            alpha = shown.value * dragFade
                        }
                        .background(scrim)
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                            onClick = { host.dismiss() },
                        ),
                )
                // The content viewport excludes keyboard space; the window scrim stays full-height.
                riffet.ui.app.AdaptiveModalViewport(Modifier.keyboardPadding(keyboardLeaving = keyboardUp), fullWindowCoordinates = true, alignment = Alignment.BottomCenter) {
                BoxWithConstraints(Modifier.fillMaxSize()) {
                    val maxSheet = pickerSheetMaxHeight(maxHeight, recipe)
                    Column(
                        modifier = Modifier
                            .align(Alignment.BottomCenter)
                            .heightIn(max = maxSheet)
                            .widthIn(max = metrics.sheetMaxWidth)
                            .then(if (actionSheet || floatingPanel)
                                Modifier.padding(horizontal = metrics.controlInset / 2, vertical = metrics.controlInset / 2) else Modifier)
                            .fillMaxWidth()
                            .onSizeChanged { sheetHeight = it.height }
                            .graphicsLayer {
                                // Hidden until measured: translationY is relative to a height not yet known.
                                alpha = if (sheetHeight > 0) 1f else 0f
                                translationY = (1f - shown.value) * sheetHeight + dragOffset
                            }
                            .then(if (floatingPanel && !actionSheet) Modifier.floatingShadow(sheetShape) else Modifier)
                            .clip(sheetShape)
                            .then(if (recipe.border && !actionSheet) Modifier.border(metrics.hairlineWidth, surfaces.hairline, sheetShape) else Modifier)
                            .then(if (actionSheet) Modifier else Modifier.riffetMaterial(MaterialRole.SHEET, sheetShape,
                                if (recipe.tonalSurface) surfaces.floating else surfaces.navigation))
                            // Swallows taps on the sheet's padding so they do not fall through to the scrim.
                            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {}
                            .nestedScroll(nestedDrag)
                            .draggable(
                                state = dragState,
                                orientation = Orientation.Vertical,
                                enabled = !closing,
                                onDragStopped = { velocity -> settle(velocity) },
                            )
                            // keyboardPadding consumes IME insets, so overlapping navigation space is not
                            // added again. With the keyboard hidden, retain the bottom and side safe areas.
                            .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.displayCutout)
                                .only(WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom)),
                    ) {
                        CompositionLocalProvider(LocalPickerHost provides host, LocalPickerNavigationPanel provides navigationPanel) {
                            if (actionSheet) {
                                Column(Modifier.weight(1f, fill = false).fillMaxWidth().clip(RoundedCornerShape(metrics.menuRadius))
                                    .riffetMaterial(MaterialRole.SHEET, RoundedCornerShape(metrics.menuRadius), surfaces.card)) {
                                    RiffetMaterialContent { content() }
                                }
                                Spacer(Modifier.height((metrics.controlInset / 2)))
                                RiffetTextButton(
                                    onClick = { host.dismiss() },
                                    modifier = Modifier.fillMaxWidth().heightIn(min = maxOf(metrics.controlHeight, metrics.rowHeight)).clip(RoundedCornerShape(metrics.menuRadius))
                                        .riffetMaterial(MaterialRole.SHEET, RoundedCornerShape(metrics.menuRadius), surfaces.card),
                                ) {
                                    RiffetMaterialContent {
                                        Text(stringResource(Res.string.session_cancel), style = LocalRiffetTypography.current.button)
                                    }
                                }
                            } else {
                                RiffetMaterialContent {
                                    if (recipe.dragHandle) Box(Modifier.fillMaxWidth().padding(top = metrics.controlInset / 2), contentAlignment = Alignment.Center) {
                                        Box(Modifier.size(width = metrics.smallIconSize * 2, height = metrics.hairlineWidth * 8)
                                            .clip(CircleShape).background(surfaces.hairline))
                                    }
                                    content()
                                }
                            }
                        }
                    }
                }
                }
            }
        }
    }
}

/** Shared content cap, also used by page previews; available height already excludes the IME. */
internal fun pickerSheetMaxHeight(availableHeight: Dp, recipe: SheetRecipe): Dp =
    minOf(availableHeight * recipe.maxHeightFraction, recipe.maxHeightDp.dp)

/** Navigation pickers keep a bar; simple overlays use a caption and a separate Cancel panel.
 * Structure references: compose-cupertino CupertinoBottomSheet.kt and CupertinoDialogs.kt.
 */
private val LocalPickerNavigationPanel = staticCompositionLocalOf { true }

/**
 * One header and body in a sheet. Alone in a [PickerSheetFrame] it is a single-page sheet; several
 * of them under [PickerPages] are the pages one sheet moves between.
 *
 * A page that was opened from another sets [onBack]: its header shows the way back, and back (button
 * or gesture) takes that step instead of closing the sheet.
 */
@Composable
internal fun PickerPage(
    title: String,
    subtitle: String? = null,
    onBack: (() -> Unit)? = null,
    /** A page whose body uses `weight(1f)` (a searchable list) needs the full height; others wrap. */
    fullHeight: Boolean = false,
    content: @Composable ColumnScope.() -> Unit,
) {
    val host = LocalPickerHost.current
    val active = LocalPickerPageActive.current
    val latestBack by rememberUpdatedState(onBack)
    DisposableEffect(host, active) {
        val step: () -> Unit = { latestBack?.invoke() ?: host?.dismiss?.invoke() ?: Unit }
        if (active) host?.back = step
        onDispose { host?.let { if (it.back === step) it.back = null } }
    }
    Column(modifier = Modifier.fillMaxWidth().then(if (fullHeight) Modifier.fillMaxHeight() else Modifier)) {
        SheetHeader(title = title, subtitle = subtitle, onDismiss = { host?.dismiss?.invoke() }, onBack = onBack)
        Column(modifier = Modifier.fillMaxWidth().weight(1f, fill = fullHeight)) { content() }
    }
}

/**
 * The pages of one sheet follow the global page motion, using [depth] to select its direction.
 * The frame and scrim stay in place while its height follows the page when animations are enabled.
 */
@Composable
internal fun <P : Any> PickerPages(
    page: P,
    depth: (P) -> Int,
    modifier: Modifier = Modifier,
    content: @Composable (P) -> Unit,
) {
    val motion = LocalRiffetMotion.current
    val pageMotion = LocalRiffetPageMotion.current
    val host = LocalPickerHost.current
    val currentDepth = depth(page)
    val gestures = LocalNativeFeatures.current.isOn(NativeFeature.SWIPE_BACK)
    val canSwipe by rememberUpdatedState(currentDepth > 0 && gestures)
    val latestHost by rememberUpdatedState(host)
    val density = LocalDensity.current.density
    // A sub-page goes back a level with a rightward swipe; from the left edge even over a scroller.
    val swipe = remember(density) {
        SwipeSurface { start ->
            if (!canSwipe || start.direction == SwipeDirection.LEFT) return@SwipeSurface SwipeVerdict.Pass
            val edge = start.position.x <= PickerEdgeWidth * density
            val width = start.size.width.toFloat()
            SwipeVerdict.Take(overChildren = edge) { PickerSwipe(width) { latestHost?.requestBack() } }
        }
    }
    AnimatedContent(
        targetState = page,
        modifier = modifier.swipeSurface(swipe),
        transitionSpec = {
            val from = depth(initialState)
            val to = depth(targetState)
            pageMotion.transition(forward = to >= from) using
                if (pageMotion.enabled) SizeTransform { _, _ -> motion.spatial() } else null
        },
        label = "pickerPage",
    ) { shown ->
        val outer = LocalPickerPageActive.current
        // The page coming in (or staying) is active; the one sliding out is not. `transition` here is this
        // page's enter/exit transition, not the pager's: compare its target, not the page.
        CompositionLocalProvider(LocalPickerPageActive provides (outer && transition.targetState == EnterExitState.Visible)) { content(shown) }
    }
}

/** From this close to the sheet's left edge a sub-page's swipe back wins over a scroller, in dp. */
private const val PickerEdgeWidth = 24f

/** A sub-page's swipe back: a release past a quarter of the sheet's width goes back a level. */
private class PickerSwipe(private val width: Float, private val back: () -> Unit) : SwipeDrag {
    private var travelled = 0f
    override fun drag(delta: Float) { travelled += delta }
    override fun release(velocity: Float) { if (travelled > width * 0.25f) back() }
    override fun cancel() = Unit
}

/** A sheet of several [PickerPages]: the frame plus the pager, for callers that chain pickers. */
@Composable
internal fun <P : Any> PickerSheet(
    page: P,
    onDismiss: () -> Unit,
    depth: (P) -> Int,
    content: @Composable (P) -> Unit,
) {
    PickerSheetFrame(onDismiss) {
        PickerPages(page = page, depth = depth, modifier = Modifier.weight(1f, fill = false), content = content)
    }
}

/** A dimmed backdrop that dismisses on tap, with a bottom-anchored card on top of it. */
@Composable
internal fun PickerOverlay(
    title: String,
    onDismiss: () -> Unit,
    subtitle: String? = null,
    /** A sheet whose content uses `weight(1f)` (a searchable list) needs the full height; others wrap. */
    fullHeight: Boolean = false,
    /** Set when this sheet was opened from another one: back returns there instead of closing all. */
    onBack: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    PickerSheetFrame(onDismiss, navigationPanel = fullHeight || onBack != null) {
        PickerPage(title = title, subtitle = subtitle, onBack = onBack, fullHeight = fullHeight, content = content)
    }
}

/** The scrim's steady-state opacity, unchanged from before motion was added. */


@Composable
private fun SheetHeader(title: String, subtitle: String?, onDismiss: () -> Unit, onBack: (() -> Unit)?) {
    val style = LocalInterfaceStyle.current
    val metrics = style.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    if (style.components.sheets.actionSheet && !LocalPickerNavigationPanel.current) {
        Column(Modifier.fillMaxWidth().padding(horizontal = metrics.groupInset, vertical = metrics.controlInset),
            horizontalAlignment = Alignment.CenterHorizontally) {
            Text(title, style = typography.footnote, color = colors.fg3, textAlign = TextAlign.Center)
            if (!subtitle.isNullOrBlank()) Text(subtitle, style = typography.bodySmall, color = colors.fg3, textAlign = TextAlign.Center)
        }
        return
    }
    Column(Modifier.fillMaxWidth().sheetLine(0.dp)) {
        // Under a grabber the header is one control tall; alone at the panel's edge it is a bar, so the
        // title has the same room above it as below.
        Row(Modifier.fillMaxWidth().heightIn(min = if (style.components.sheets.dragHandle) metrics.controlHeight else maxOf(metrics.barHeight, metrics.controlHeight)),
            verticalAlignment = Alignment.CenterVertically) {
            // A start-aligned title starts where the rows' text does, or after the back arrow; a
            // centred one keeps the slot so it sits between two equal ends.
            if (onBack != null || style.components.sheets.centeredTitle) Box(Modifier.size(metrics.controlHeight), contentAlignment = Alignment.Center) {
                if (onBack != null) RiffetIconButton(onClick = onBack) {
                    Icon(RiffetIcons.ChevronLeft, stringResource(Res.string.pickers_back), Modifier.size(metrics.iconSize))
                }
            } else Spacer(Modifier.width(SheetInset))
            Text(title, style = if (style.components.sheets.prominentTitle) typography.title else typography.barTitle,
                color = colors.fg, maxLines = 2, overflow = TextOverflow.Ellipsis,
                textAlign = if (style.components.sheets.centeredTitle) TextAlign.Center else TextAlign.Start,
                modifier = Modifier.weight(1f).padding(vertical = metrics.controlInset / 2))
            RiffetIconButton(onClick = onDismiss, modifier = Modifier.size(metrics.controlHeight)) {
                Icon(RiffetIcons.Close, stringResource(Res.string.pickers_close), Modifier.size(metrics.iconSize), tint = colors.fg3)
            }
        }
        if (!subtitle.isNullOrBlank()) Text(subtitle, style = typography.bodySmall, color = colors.fg3,
            maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = if (style.components.sheets.centeredTitle) TextAlign.Center else TextAlign.Start,
            modifier = Modifier.fillMaxWidth().padding(start = if (onBack != null && !style.components.sheets.centeredTitle) metrics.controlHeight else SheetInset, end = metrics.groupInset, bottom = metrics.controlInset))
    }
}

/**
 * Inside a panel that is itself the card (`sheets.flatRows`): its rows carry no fill and no lines.
 * The same rows on a settings page sit in a card and keep both.
 */
internal val flatPanel: Boolean
    @Composable get() = LocalInterfaceStyle.current.components.sheets.flatRows && LocalPickerHost.current != null

/** A grouped style sets a sheet's rows on the card fill, unless the panel is itself the card. */
internal val sheetRowsFilled: Boolean
    @Composable get() = LocalInterfaceStyle.current.components.lists.grouped && !flatPanel

/** Where a sheet's text starts; rows inset their highlight by [SheetGutter] and pad the rest. */
internal val SheetInset
    @Composable get() = LocalInterfaceStyle.current.metrics.groupInset
internal val SheetGutter: androidx.compose.ui.unit.Dp
    @Composable get() = if (LocalInterfaceStyle.current.components.lists.roundedSelection) LocalInterfaceStyle.current.metrics.controlInset / 2 else 0.dp
internal val SheetRowShape: RoundedCornerShape
    @Composable get() = RoundedCornerShape(if (LocalInterfaceStyle.current.components.lists.roundedSelection) LocalInterfaceStyle.current.rowRadius else 0.dp)

/** A sheet row's main line: Material's body-large on a single-line rhythm. */
internal val SheetRowText: TextStyle
    @Composable get() = LocalRiffetTypography.current.body

/** A section caption inside a sheet. */
@Composable
internal fun SectionLabel(text: String) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Text(
        text = text,
        style = typography.footnote,
        color = if (LocalInterfaceStyle.current.components.lists.accentSections) colors.accent else colors.fg3,
        modifier = Modifier.fillMaxWidth()
            .then(if (LocalInterfaceStyle.current.components.lists.sectionBackground) Modifier.background(materialContentBackground(LocalRiffetSurfaces.current.groupedPage)) else Modifier)
            .padding(start = SheetInset, end = SheetInset, top = metrics.rowPadding, bottom = (metrics.controlInset / 2)),
    )
}

@Composable
internal fun Modifier.pickerRowDivider(start: androidx.compose.ui.unit.Dp = SheetInset): Modifier {
    // On a flat panel the rows are a menu's: set apart by their height, with no line left trailing the last one.
    if (flatPanel) return this
    return sheetLine(start)
}

/** The header's line, which every panel with lines keeps: the list scrolls away under it. */
@Composable
private fun Modifier.sheetLine(start: androidx.compose.ui.unit.Dp): Modifier {
    val metrics = LocalInterfaceStyle.current.metrics
    if (!LocalInterfaceStyle.current.components.lists.dividers) return this
    val color = LocalRiffetSurfaces.current.hairline
    return drawWithContent {
        drawContent()
        drawLine(color, Offset(start.toPx(), size.height), Offset(size.width, size.height), strokeWidth = metrics.hairlineWidth.toPx())
    }
}

@Composable
private fun Modifier.pickerFocus(source: MutableInteractionSource): Modifier {
    val metrics = LocalInterfaceStyle.current.metrics
    val focused by source.collectIsFocusedAsState()
    return if (LocalInterfaceStyle.current.components.lists.focusBorder && focused)
        border(metrics.focusWidth, LocalRiffetSurfaces.current.focus) else this
}

/**
 * One selectable line: a label, an optional explanation, and a check when it is the current value.
 *
 * [disabledReason] is what makes a control honest. An option this build cannot act on is rendered
 * dimmed with the reason spelled out instead of disappearing or silently doing nothing.
 */
@Composable
internal fun OptionRow(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    description: String? = null,
    icon: ImageVector? = null,
    /** Overrides the icon tint; `Color.Unspecified` keeps a vector's own
     * fill (the Codex mark's gradient) instead of flattening it. */
    iconTint: Color? = null,
    tone: Color? = null,
    disabledReason: String? = null,
    /** Short figures between the label and the check, such as a model's quota and load. */
    trailing: (@Composable () -> Unit)? = null,
    /** One of several choices that can all be on: a check box instead of a radio. */
    multiple: Boolean = false,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val source = remember { MutableInteractionSource() }
    val enabled = disabledReason == null
    val style = LocalInterfaceStyle.current
    // The current value is marked by its check alone (mobile.md §1.1): a filled row reads as
    // pressed, and fill plus check says the same thing twice. Grouped styles set rows on the card.
    val grouped = style.components.lists.grouped
    val action = style.components.sheets.actionSheet && !LocalPickerNavigationPanel.current && description.isNullOrBlank() && icon == null && trailing == null
    val surfaces = LocalRiffetSurfaces.current
    val labelColor = when {
        !enabled -> LocalRiffetSurfaces.current.disabledContent
        tone != null -> tone
        else -> colors.fg
    }
    val rowTint = if (sheetRowsFilled) materialContentBackground(surfaces.card) else Color.Transparent
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = SheetGutter)
            .clip(SheetRowShape)
            .background(rowTint)
            .then(if (style.components.lists.selectionMarker && selected) Modifier.drawWithContent {
                drawContent()
                drawLine(surfaces.focus, Offset(metrics.focusWidth.toPx(), size.height * 0.25f),
                    Offset(metrics.focusWidth.toPx(), size.height * 0.75f), strokeWidth = metrics.focusWidth.toPx())
            } else Modifier)
            .pickerFocus(source)
            .then(if (multiple) Modifier.toggleable(value = selected, enabled = enabled, role = Role.Checkbox,
                interactionSource = source, indication = LocalIndication.current, onValueChange = { onClick() })
            else Modifier.selectable(selected = selected, enabled = enabled, role = Role.RadioButton,
                interactionSource = source, indication = LocalIndication.current, onClick = onClick))
            .heightIn(min = maxOf(metrics.controlHeight, if (!grouped || action) metrics.rowHeight else metrics.controlHeight))
            .pickerRowDivider(if (action) 0.dp else SheetInset)
            .padding(horizontal = (SheetInset - SheetGutter).coerceAtLeast(0.dp), vertical = metrics.rowPadding / 2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (action) Spacer(Modifier.width(metrics.iconSlot + metrics.controlInset / 2))
        if (icon != null) {
            Icon(icon, contentDescription = null,
                tint = iconTint ?: if (!enabled) surfaces.disabledContent else tone ?: colors.fg2,
                modifier = Modifier.size(metrics.iconSize))
            Spacer(Modifier.width(metrics.rowPadding))
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(text = label, style = SheetRowText, color = if (action && enabled && tone == null) colors.accent else labelColor,
                textAlign = if (action) TextAlign.Center else TextAlign.Start,
                modifier = if (action) Modifier.fillMaxWidth() else Modifier,
                maxLines = 2, overflow = TextOverflow.Ellipsis)
            val detail = disabledReason ?: description
            if (!detail.isNullOrBlank()) {
                Text(
                    text = detail,
                    style = typography.bodySmall,
                    color = if (!enabled) surfaces.disabledContent else colors.fg3,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (trailing != null) {
            Spacer(Modifier.width((metrics.controlInset / 2)))
            CompositionLocalProvider(LocalContentColor provides (if (!enabled) surfaces.disabledContent else colors.fg3)) {
                trailing()
            }
        }
        Spacer(Modifier.width(metrics.controlInset))
        // A check on what is chosen and nothing on the rest, single or multiple: a column of empty
        // circles or boxes is noise. The empty slot keeps every row's trailing edge in line.
        Box(Modifier.size(metrics.iconSize), contentAlignment = Alignment.Center) {
            // A style that marks the current row with a bar (Fluent) marks it with that alone.
            if (selected && !style.components.lists.selectionMarker) Icon(RiffetIcons.Check, contentDescription = null,
                tint = if (enabled) colors.accent else surfaces.disabledContent, modifier = Modifier.size(metrics.iconSize))
        }
    }
}

/** A horizontal strip of choices, the phone form of the web's sliding segments. */
@Composable
internal fun SegmentRow(
    label: String,
    options: List<ModelParamOption>,
    value: String,
    display: (String) -> String,
    onSelect: (String) -> Unit,
    enabled: Boolean = true,
    hint: String? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Column(modifier = Modifier.fillMaxWidth()
        .then(if (sheetRowsFilled) Modifier.background(materialContentBackground(LocalRiffetSurfaces.current.card)) else Modifier)
        .pickerRowDivider().padding(horizontal = SheetInset, vertical = metrics.controlInset)) {
        Text(text = label, style = SheetRowText, color = if (enabled) colors.fg else LocalRiffetSurfaces.current.disabledContent)
        if (!hint.isNullOrBlank()) {
            Text(text = hint, style = typography.bodySmall, color = colors.fg3, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height((metrics.rowPadding / 2)))
        riffet.ui.design.SegmentedControl(
            options = options.map { display(it.value) },
            selected = options.indexOfFirst { it.value == value },
            onSelect = { index -> options.getOrNull(index)?.let { onSelect(it.value) } },
            enabled = enabled,
        )
    }
}

/** A labelled switch, matching the web's `ParamControl` toggle row. */
@Composable
internal fun ToggleRow(
    label: String,
    on: Boolean,
    onToggle: (Boolean) -> Unit,
    hint: String? = null,
    enabled: Boolean = true,
    trailing: (@Composable () -> Unit)? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val source = remember { MutableInteractionSource() }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (sheetRowsFilled) Modifier.background(materialContentBackground(LocalRiffetSurfaces.current.card)) else Modifier)
            .pickerRowDivider()
            .pickerFocus(source)
            .toggleable(value = on, enabled = enabled, role = Role.Switch,
                interactionSource = source, indication = LocalIndication.current, onValueChange = onToggle)
            .heightIn(min = maxOf(metrics.controlHeight, metrics.rowHeight))
            .padding(horizontal = SheetInset, vertical = (metrics.controlInset / 2)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(text = label, style = SheetRowText, color = if (enabled) colors.fg else LocalRiffetSurfaces.current.disabledContent)
            if (!hint.isNullOrBlank()) {
                Text(text = hint, style = typography.bodySmall, color = colors.fg3, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        Spacer(Modifier.width(metrics.controlInset))
        trailing?.invoke()
        SettingsSwitch(checked = on, enabled = enabled, onCheckedChange = null)
    }
}

/**
 * A parameter whose options open as their own list: the phone form of the web's parameter dropdown.
 *
 * The value is on the row itself, so the sheet always states the current thinking level even when
 * the list is closed - which is what a strip of eight ellipsised segments could not do.
 */
@Composable
internal fun PickerNavRow(
    label: String,
    value: String,
    enabled: Boolean = true,
    hint: String? = null,
    onClick: () -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val source = remember { MutableInteractionSource() }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (sheetRowsFilled) Modifier.background(materialContentBackground(LocalRiffetSurfaces.current.card)) else Modifier)
            .pickerRowDivider()
            .pickerFocus(source)
            .clickable(enabled = enabled, role = Role.Button,
                interactionSource = source, indication = LocalIndication.current, onClick = onClick)
            .heightIn(min = maxOf(metrics.controlHeight, metrics.rowSubtitleHeight))
            .padding(start = SheetInset, end = metrics.rowPadding, top = (metrics.rowPadding / 2), bottom = (metrics.rowPadding / 2)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(text = label, style = SheetRowText, color = if (enabled) colors.fg else LocalRiffetSurfaces.current.disabledContent)
            Text(
                text = value,
                style = typography.bodySmall,
                color = if (enabled) colors.fg2 else LocalRiffetSurfaces.current.disabledContent,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (!hint.isNullOrBlank()) {
                Text(text = hint, style = typography.caption, color = colors.fg3, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        Spacer(Modifier.width(metrics.controlInset))
        Icon(
            imageVector = RiffetIcons.ChevronRight,
            contentDescription = null,
            tint = colors.fg3,
            modifier = Modifier.size(metrics.iconSize),
        )
    }
}

/** Feedback belongs to the unavailable control or operation inside this sheet; [action] is its one safe remedy. */
@Composable
internal fun SheetNotice(text: String, kind: SettingsNoticeKind, action: String? = null, onAction: (() -> Unit)? = null) {
    val metrics = LocalInterfaceStyle.current.metrics
    val noticeKind = when (kind) {
        SettingsNoticeKind.INFO -> riffet.ui.design.NoticeKind.INFO
        SettingsNoticeKind.SUCCESS -> riffet.ui.design.NoticeKind.SUCCESS
        SettingsNoticeKind.WARNING -> riffet.ui.design.NoticeKind.WARNING
        SettingsNoticeKind.ERROR -> riffet.ui.design.NoticeKind.ERROR
    }
    riffet.ui.design.Notice(
        message = text,
        kind = noticeKind,
        modifier = Modifier.padding(horizontal = metrics.rowPadding, vertical = metrics.controlInset / 2),
        action = action,
        onAction = onAction,
        background = materialContentBackground(LocalRiffetSurfaces.current.groupedPage),
    )
}

/**
 * A [SheetNotice] that opens and closes with its text rather than popping in and out. It keeps the
 * last text while it collapses, so the notice does not empty before it has shrunk.
 */
@Composable
internal fun AnimatedSheetNotice(text: String?, kind: SettingsNoticeKind) {
    val entries = riffet.ui.composer.rememberFeedback(Unit, listOfNotNull(text?.let {
        riffet.ui.composer.FeedbackValue(it, it to kind)
    }))
    var entered by remember { mutableStateOf(false) }
    riffet.ui.composer.Reveal(entries.takeIf { it.isNotEmpty() }, onEnteredChanged = { entered = it }) { retained ->
        Column {
            retained.forEach { entry ->
                riffet.ui.composer.FeedbackVisible(entry, entered) {
                    SheetNotice(entry.value.first, if (entry.current) entry.value.second else SettingsNoticeKind.INFO)
                }
            }
        }
    }
}
