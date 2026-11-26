package riffet.ui.pickers

import riffet.ui.theme.LocalRiffetMotion
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.focusGroup
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.runtime.remember
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.MaterialRole
import riffet.ui.design.RiffetMaterialWindow
import riffet.ui.design.RiffetMaterialContent
import riffet.ui.design.riffetMaterial
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Surface
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.layout
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import riffet.ui.app.LocalRiffetWindowInfo
import riffet.ui.app.PageBackHandler
import riffet.ui.focus.rememberKeyboardUpWhen
import riffet.ui.app.RiffetWindowInfo
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.jetbrains.compose.resources.stringResource
import riffet_mobile.shared.generated.resources.*
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography

/* Menu structure reference: compose-cupertino's CupertinoDropdownMenu.kt.
 * https://github.com/alexzhirkevich/compose-cupertino/blob/master/cupertino/src/commonMain/kotlin/io/github/alexzhirkevich/cupertino/CupertinoDropdownMenu.kt
 * Keep Compose's anchored popup/scroll/keyboard contract; own the Cupertino panel and rows.
 */

@Composable
internal fun RiffetDropdownMenu(
    expanded: Boolean,
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier,
    offset: DpOffset = DpOffset(0.dp, LocalInterfaceStyle.current.metrics.controlInset / 2),
    scrollState: ScrollState = rememberScrollState(),
    content: @Composable ColumnScope.() -> Unit,
) {
    // Opened over a page whose keyboard is up, the menu leaves it up: its window does not take focus,
    // so back reaches the page, and closes the menu once the keyboard has gone.
    val keepKeyboard = rememberKeyboardUpWhen(expanded)
    PageBackHandler(enabled = expanded && keepKeyboard, onBack = onDismissRequest)
    RiffetMaterialWindow {
        val style = LocalInterfaceStyle.current
        val metrics = style.metrics
        val recipe = style.components.lists
        val menu = style.components.menus
        val shape = RoundedCornerShape(metrics.menuRadius)
        val window = LocalRiffetWindowInfo.current
        if (window.folds.any { it.separating || it.occluding }) {
            FoldBoundedMenu(expanded, onDismissRequest, modifier, offset, scrollState, window, keepKeyboard, content)
            return@RiffetMaterialWindow
        }
        // The stationary menu surface clips and scrolls; recipes only choose its decoration.
        val panel = modifier.layout { measurable, constraints ->
            // Cap the popup viewport before Material's internal scroll modifier sees its constraints.
            // The popup supplies window bounds; short menus still measure at their content height.
            val heightCap = minOf(menu.maxHeightDp.dp.roundToPx(),
                if (constraints.hasBoundedHeight) (constraints.maxHeight * menu.maxHeightFraction).toInt()
                else constraints.maxHeight)
            val placeable = measurable.measure(constraints.copy(
                minHeight = minOf(constraints.minHeight, heightCap), maxHeight = heightCap,
            ))
            layout(placeable.width, placeable.height) { placeable.placeRelative(0, 0) }
        }.then(if (recipe.outlinedMenu)
            Modifier.widthIn(min = metrics.menuMinWidth, max = metrics.menuMaxWidth)
                .border(metrics.hairlineWidth, LocalRiffetSurfaces.current.hairline, shape)
            else Modifier)
            .riffetMaterial(MaterialRole.MENU, shape, LocalRiffetSurfaces.current.floating)
        DropdownMenu(
            expanded = expanded, onDismissRequest = onDismissRequest,
            modifier = panel.selectableGroup(), offset = offset, scrollState = scrollState,
            properties = PopupProperties(focusable = !keepKeyboard),
            shape = shape, containerColor = Color.Transparent,
            tonalElevation = 0.dp, shadowElevation = metrics.floatingShadowOffset / 2,
        ) {
            RiffetMaterialContent {
                ProvideTextStyle(RiffetMenuText) { content() }
            }
        }
    }
}

/** Material's DropdownMenu has no public position-provider hook. Only physical folds use this
 * bounded Popup; ordinary windows retain Material's popup, transition and keyboard behavior. */
@Composable
private fun FoldBoundedMenu(
    expanded: Boolean,
    onDismissRequest: () -> Unit,
    modifier: Modifier,
    offset: DpOffset,
    scrollState: ScrollState,
    window: RiffetWindowInfo,
    keepKeyboard: Boolean,
    content: @Composable ColumnScope.() -> Unit,
) {
    if (!expanded) return
    val style = LocalInterfaceStyle.current
    val metrics = style.metrics
    val menu = style.components.menus
    val surfaces = LocalRiffetSurfaces.current
    val shape = RoundedCornerShape(metrics.menuRadius)
    val density = LocalDensity.current
    var viewport by remember(window) { mutableStateOf<IntRect?>(null) }
    val xOffset = with(density) { offset.x.roundToPx() }
    val yOffset = with(density) { offset.y.roundToPx() }
    val margin = with(density) { 8.dp.roundToPx() }
    val position = remember(window, xOffset, yOffset, margin) {
        object : PopupPositionProvider {
            override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
                var safe = IntRect(0, 0, windowSize.width, windowSize.height)
                for (fold in window.folds) {
                    if (!fold.separating && !fold.occluding) continue
                    val b = fold.bounds
                    if (fold.vertical && b.left > safe.left && b.right < safe.right && b.bottom > safe.top && b.top < safe.bottom) {
                        safe = if (anchorBounds.center.x <= b.left) IntRect(safe.left, safe.top, b.left.toInt(), safe.bottom)
                            else IntRect(b.right.toInt(), safe.top, safe.right, safe.bottom)
                    } else if (!fold.vertical && b.top > safe.top && b.bottom < safe.bottom && b.right > safe.left && b.left < safe.right) {
                        safe = if (anchorBounds.center.y <= b.top) IntRect(safe.left, safe.top, safe.right, b.top.toInt())
                            else IntRect(safe.left, b.bottom.toInt(), safe.right, safe.bottom)
                    }
                }
                val horizontalMargin = minOf(margin, safe.width / 4)
                val verticalMargin = minOf(margin, safe.height / 4)
                safe = IntRect(safe.left + horizontalMargin, safe.top + verticalMargin,
                    safe.right - horizontalMargin, safe.bottom - verticalMargin)
                viewport = safe
                val signedOffset = if (layoutDirection == LayoutDirection.Ltr) xOffset else -xOffset
                val preferredX = if (layoutDirection == LayoutDirection.Ltr) anchorBounds.left + signedOffset
                    else anchorBounds.right - popupContentSize.width + signedOffset
                val otherX = if (layoutDirection == LayoutDirection.Ltr) anchorBounds.right - popupContentSize.width + signedOffset
                    else anchorBounds.left + signedOffset
                val maxX = (safe.right - popupContentSize.width).coerceAtLeast(safe.left)
                val x = when { preferredX in safe.left..maxX -> preferredX; otherX in safe.left..maxX -> otherX; else -> preferredX.coerceIn(safe.left, maxX) }
                val below = anchorBounds.bottom + yOffset
                val above = anchorBounds.top - popupContentSize.height + yOffset
                val maxY = (safe.bottom - popupContentSize.height).coerceAtLeast(safe.top)
                val y = when { below in safe.top..maxY -> below; above in safe.top..maxY -> above; else -> below.coerceIn(safe.top, maxY) }
                return IntOffset(x, y)
            }
        }
    }
    Popup(popupPositionProvider = position, onDismissRequest = onDismissRequest,
        properties = PopupProperties(focusable = !keepKeyboard, dismissOnBackPress = true, dismissOnClickOutside = true)) {
        RiffetMaterialWindow {
            val focusManager = LocalFocusManager.current
            val inputMode = LocalInputModeManager.current
            val focusRequester = remember { FocusRequester() }
            val panel = Modifier.layout { measurable, constraints ->
                val safe = viewport
                val widthCap = minOf(constraints.maxWidth, safe?.width ?: constraints.maxWidth, metrics.menuMaxWidth.roundToPx(), 640.dp.roundToPx())
                val availableHeight = minOf(constraints.maxHeight, safe?.height ?: constraints.maxHeight)
                val heightCap = minOf(availableHeight, menu.maxHeightDp.dp.roundToPx(), (availableHeight * menu.maxHeightFraction).toInt())
                val child = measurable.measure(constraints.copy(minWidth = minOf(constraints.minWidth, widthCap), maxWidth = widthCap,
                    minHeight = minOf(constraints.minHeight, heightCap), maxHeight = heightCap))
                layout(child.width, child.height) { child.placeRelative(0, 0) }
            }.then(modifier).alpha(if (viewport == null) 0f else 1f)
                .then(if (style.components.lists.outlinedMenu) Modifier.widthIn(min = metrics.menuMinWidth, max = metrics.menuMaxWidth)
                    .border(metrics.hairlineWidth, surfaces.hairline, shape) else Modifier)
                .riffetMaterial(MaterialRole.MENU, shape, surfaces.floating).selectableGroup()
                .onPreviewKeyEvent { event ->
                    if (event.type == KeyEventType.KeyDown && (event.key == Key.DirectionDown || event.key == Key.DirectionUp)) {
                        inputMode.requestInputMode(InputMode.Keyboard)
                        focusManager.moveFocus(if (event.key == Key.DirectionDown) FocusDirection.Next else FocusDirection.Previous)
                        true
                    } else false
                }.focusRequester(focusRequester).focusGroup()
            LaunchedEffect(focusRequester) { focusRequester.requestFocus() }
            Surface(modifier = panel, shape = shape, color = Color.Transparent, tonalElevation = 0.dp, shadowElevation = metrics.floatingShadowOffset / 2) {
                Column(Modifier.padding(vertical = 8.dp).width(IntrinsicSize.Max).verticalScroll(scrollState)) {
                    RiffetMaterialContent { ProvideTextStyle(RiffetMenuText) { content() } }
                }
            }
        }
    }
}

@Composable
internal fun RiffetMenuItem(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    selected: Boolean = false,
    highlighted: Boolean = false,
    danger: Boolean = false,
    enabled: Boolean = true,
    showCheck: Boolean = false,
    leading: (@Composable RowScope.() -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
    content: @Composable RowScope.() -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val style = LocalInterfaceStyle.current
    val recipe = style.components.lists
    val surface = LocalRiffetSurfaces.current
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val rowInset = if (recipe.roundedSelection) metrics.controlInset / 2 else 0.dp
    // A persistent choice is marked by its check; the row fill is only transient feedback.
    val container by animateColorAsState(
        targetValue = if (highlighted || focused) surface.press else Color.Transparent,
        animationSpec = motion.effects(),
        label = "menuItem",
    )
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = rowInset)
            .heightIn(min = maxOf(metrics.controlHeight, metrics.menuRowHeight))
            .clip(if (recipe.roundedSelection) RoundedCornerShape(LocalInterfaceStyle.current.rowRadius) else RectangleShape)
            .background(container)
            .then(if (focused && !recipe.roundedSelection) Modifier.border(metrics.focusWidth, surface.focus) else Modifier)
            .then(if (showCheck) Modifier.selectable(selected = selected, enabled = enabled, role = Role.RadioButton,
                interactionSource = source, indication = LocalIndication.current, onClick = onClick)
                else Modifier.clickable(enabled = enabled, role = Role.Button,
                    interactionSource = source, indication = LocalIndication.current, onClick = onClick))
            .then(if (recipe.dividers && !recipe.plainMenuRows) Modifier.drawWithContent {
                drawContent()
                drawLine(surface.hairline, Offset(metrics.rowPadding.toPx(), size.height), Offset(size.width, size.height), strokeWidth = metrics.hairlineWidth.toPx())
            } else Modifier)
            .alpha(if (enabled) 1f else motion.disabledOpacity)
            .padding(horizontal = (metrics.rowPadding - rowInset).coerceAtLeast(0.dp), vertical = metrics.controlInset / 2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (recipe.trailingMenuIcons && showCheck) {
            Box(Modifier.size(metrics.smallIconSize), contentAlignment = Alignment.Center) {
                if (selected) Icon(RiffetIcons.Check, contentDescription = null,
                    tint = colors.fg, modifier = Modifier.size(metrics.smallIconSize))
            }
            Spacer(Modifier.width((metrics.controlInset / 2)))
        }
        // A row that leads with something wider than a glyph — a theme swatch — is what `leading`
        // is for; it wins over `icon` so a caller cannot end up with two leading elements. Either
        // way the 12dp gap is owned here, which is what keeps a swatch row's label on the same
        // vertical line as an icon row's.
        if (leading != null) {
            leading(this)
            Spacer(Modifier.width(metrics.controlInset))
        } else if (icon != null && !recipe.trailingMenuIcons) {
            Icon(icon, contentDescription = null, tint = if (danger) colors.danger else colors.fg2, modifier = Modifier.size(metrics.smallIconSize))
            Spacer(Modifier.width(metrics.controlInset))
        }
        content()
        trailing?.invoke(this)
        if (recipe.trailingMenuIcons && icon != null && leading == null) {
            Spacer(Modifier.width(metrics.rowPadding))
            Icon(icon, contentDescription = null, tint = if (danger) colors.danger else colors.fg,
                modifier = Modifier.size(metrics.smallIconSize))
        }
        if (showCheck && !recipe.trailingMenuIcons) {
            Spacer(Modifier.width(metrics.controlInset))
            // The box stays when unchecked so every row's trailing column lines up.
            Box(Modifier.size(metrics.smallIconSize), contentAlignment = Alignment.Center) {
                if (selected) Icon(RiffetIcons.Check, contentDescription = null, tint = LocalRiffetSurfaces.current.primaryAction, modifier = Modifier.size(metrics.smallIconSize))
            }
        }
    }
}

/** A plain-text row: the common case of [RiffetMenuItem]. */
@Composable
internal fun RiffetMenuItem(
    text: String,
    onClick: () -> Unit,
    icon: ImageVector? = null,
    danger: Boolean = false,
    enabled: Boolean = true,
) {
    val colors = LocalRiffetColors.current
    RiffetMenuItem(onClick = onClick, icon = icon, danger = danger, enabled = enabled) {
        Text(text, style = RiffetMenuText, color = if (danger) colors.danger else colors.fg, modifier = if (LocalInterfaceStyle.current.components.lists.trailingMenuIcons) Modifier.weight(1f) else Modifier)
    }
}

/** A menu row's label: the style's menu size (14sp in Material) on one line. */
internal val RiffetMenuText: TextStyle
    @Composable get() = LocalRiffetTypography.current.menu

@Composable
internal fun RiffetMenuLabel(text: String) {
    val metrics = LocalInterfaceStyle.current.metrics
    Text(
        text = text,
        style = LocalRiffetTypography.current.footnote,
        color = LocalRiffetColors.current.fg3,
        modifier = Modifier.padding(horizontal = metrics.rowPadding, vertical = metrics.controlInset / 3),
    )
}

@Composable
internal fun RiffetMenuSeparator() {
    val metrics = LocalInterfaceStyle.current.metrics
    if (!LocalInterfaceStyle.current.components.lists.groupSeparatorLine) {
        // Rows already draw hairlines. Separate action groups with space, not a solid colour band.
        Spacer(Modifier.height(metrics.menuGroupGap))
        return
    }
    Box(Modifier.padding(horizontal = metrics.rowPadding, vertical = metrics.menuGroupGap / 2)
        .fillMaxWidth().height(metrics.hairlineWidth).background(LocalRiffetSurfaces.current.hairline))
}
