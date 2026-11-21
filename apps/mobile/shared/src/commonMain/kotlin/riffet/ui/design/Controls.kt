package riffet.ui.design

import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.foundation.layout.widthIn
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.indication
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.LocalTextStyle
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.FilterChip
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography

/**
 * The app's switch (in place of Material's): a 50×30 track with a 26dp thumb that springs across
 * and stretches a little while pressed. [onCheckedChange] null makes it a picture whose container
 * owns the toggle (a settings row toggled from anywhere on it).
 */
@Composable
internal fun RiffetSwitch(
    checked: Boolean,
    onCheckedChange: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val s = surfaces
    val recipe = LocalInterfaceStyle.current.components.controls
    if (recipe.switches == ComponentBackend.MIUIX && listOf("switchWidth", "switchHeight", "switchThumbSize").none(metrics::isOverridden)) {
        top.yukonga.miuix.kmp.basic.Switch(checked, onCheckedChange, modifier, enabled = enabled,
            colors = top.yukonga.miuix.kmp.basic.SwitchDefaults.switchColors(
                checkedTrackColor = s.primaryAction, checkedThumbColor = s.switchThumb,
                uncheckedTrackColor = colors.bgMuted, uncheckedThumbColor = s.switchThumb,
                disabledCheckedTrackColor = s.press, disabledUncheckedTrackColor = s.press,
                disabledCheckedThumbColor = s.disabledContent, disabledUncheckedThumbColor = s.disabledContent,
            ))
        return
    }
    if (recipe.switches == ComponentBackend.MATERIAL) {
        CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides metrics.controlHeight) {
            Switch(checked = checked, onCheckedChange = onCheckedChange, modifier = modifier, enabled = enabled,
                colors = SwitchDefaults.colors(checkedTrackColor = s.primaryAction, checkedThumbColor = s.switchThumb))
        }
        return
    }
    val source = remember { MutableInteractionSource() }
    val down by source.collectIsPressedAsState()
    val focused by source.collectIsFocusedAsState()
    val thumbSize = minOf(metrics.switchThumbSize, metrics.switchHeight - metrics.hairlineWidth * 2).coerceAtLeast(0.dp)
    val inset = (metrics.switchHeight - thumbSize) / 2
    val travel by animateFloatAsState(if (checked) 1f else 0f, motion.spatial(), label = "switch")
    val stretch by animateDpAsState(if (down) thumbSize * 0.18f else 0.dp, motion.spatial(), label = "stretch")
    val track by animateColorAsState(if (checked) s.primaryAction else s.press, motion.effects(), label = "track")
    val thumbColor by animateColorAsState(if (recipe.outlineSwitchThumb && !checked) colors.fg2 else s.switchThumb, motion.effects(), label = "switch-thumb")
    val toggle = if (onCheckedChange != null) {
        Modifier.sizeIn(minWidth = metrics.controlHeight, minHeight = metrics.controlHeight)
            .toggleable(checked, source, indication = null, enabled = enabled, role = Role.Switch, onValueChange = onCheckedChange)
    } else Modifier
    Box(modifier.then(toggle), contentAlignment = Alignment.Center) {
        Box(Modifier.size(metrics.switchWidth, metrics.switchHeight)
            .graphicsLayer { alpha = if (enabled) 1f else motion.disabledOpacity }
            .clip(CircleShape).background(track)
            .then(if (recipe.outlineSwitchThumb && !checked) Modifier.border(metrics.hairlineWidth, s.hairline, CircleShape) else Modifier)
            .then(if (focused) Modifier.border(metrics.focusWidth, s.focus, CircleShape) else Modifier)) {
            val thumb = minOf(thumbSize + stretch, metrics.switchWidth - inset * 2)
            Box(Modifier.offset { IntOffset((inset + (metrics.switchWidth - inset * 2 - thumb) * travel).roundToPx(), inset.roundToPx()) }
                .size(thumb, thumbSize)
                .dropShadow(CircleShape, Shadow(radius = metrics.floatingShadowRadius / 4, color = s.shadow,
                    offset = DpOffset(0.dp, metrics.hairlineWidth), alpha = motion.floatingShadowOpacity))
                .background(thumbColor, CircleShape))
        }
    }
}

/** Equal-width choices rendered as connected segments, a sliding track, pills or underlines. */
@Composable
internal fun SegmentedControl(
    options: List<String>,
    selected: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    if (options.isEmpty()) return
    val style = LocalInterfaceStyle.current
    val recipe = style.components.controls
    if (recipe.segments == SegmentPresentation.PILLS || recipe.segments == SegmentPresentation.UNDERLINE) {
        val s = surfaces
        val colors = LocalRiffetColors.current
        Row(modifier.fillMaxWidth().heightIn(min = metrics.controlHeight).selectableGroup(),
            horizontalArrangement = Arrangement.spacedBy(if (recipe.segments == SegmentPresentation.PILLS) metrics.controlInset / 2 else 0.dp)) {
            options.forEachIndexed { index, label ->
                val on = index == selected
                val source = remember { MutableInteractionSource() }
                val focused by source.collectIsFocusedAsState()
                val shape = RoundedCornerShape(style.controlRadius)
                Box(Modifier.weight(1f).heightIn(min = metrics.controlHeight)
                    .selectable(on, enabled = enabled, role = Role.Tab, interactionSource = source, indication = null) { onSelect(index) },
                    contentAlignment = Alignment.Center) {
                    val fill = if (recipe.segments == SegmentPresentation.UNDERLINE) Color.Transparent else if (on) s.primaryAction else s.secondaryAction
                    val ink = if (!enabled) s.disabledContent else if (recipe.segments == SegmentPresentation.UNDERLINE && on) s.focus
                        else if (recipe.segments == SegmentPresentation.PILLS && on) s.primaryActionContent else colors.fg2
                    Text(label, color = ink, style = LocalRiffetTypography.current.segmented,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().clip(shape)
                            .then(if (on && recipe.segments == SegmentPresentation.PILLS)
                                Modifier.riffetMaterial(MaterialRole.CONTROL, shape, fill, source) else Modifier.background(fill))
                            .then(if (focused) Modifier.border(metrics.focusWidth, s.focus, shape) else Modifier)
                            .indication(source, LocalIndication.current)
                            .padding(horizontal = metrics.controlInset / 2, vertical = metrics.controlInset * 2 / 3))
                    if (recipe.segments == SegmentPresentation.UNDERLINE && on) Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                        .height(metrics.focusWidth).background(s.focus))
                }
            }
        }
        return
    }
    if (recipe.segments == SegmentPresentation.CONNECTED) {
        CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides metrics.controlHeight) {
            SingleChoiceSegmentedButtonRow(modifier.fillMaxWidth()) {
                options.forEachIndexed { index, label ->
                    SegmentedButton(
                        selected = index == selected, onClick = { onSelect(index) }, enabled = enabled,
                        shape = when (index) {
                            0 -> RoundedCornerShape(topStart = metrics.controlRadius, bottomStart = metrics.controlRadius)
                            options.lastIndex -> RoundedCornerShape(topEnd = metrics.controlRadius, bottomEnd = metrics.controlRadius)
                            else -> RoundedCornerShape(0.dp)
                        },
                        modifier = Modifier.heightIn(min = metrics.segmentedHeight),
                        // The check takes a third of a segment; with three or more it truncates the labels,
                        // and the filled segment already marks the choice.
                        // The fill marks the chosen segment; a check on top would mark it twice (mobile.md §1.1).
                        icon = {},
                    ) { Text(label, style = LocalRiffetTypography.current.segmented, textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
            }
        }
        return
    }
    val colors = LocalRiffetColors.current
    val s = surfaces
    val trackHeight = minOf(metrics.segmentedHeight, metrics.controlHeight)
    val thumbHeight = (trackHeight - metrics.hairlineWidth * 6).coerceAtLeast(0.dp)
    val segmentShape = RoundedCornerShape(metrics.selectionRadius)
    val position by animateFloatAsState(selected.toFloat(), motion.spatial(), label = "segment")
    BoxWithConstraints(
        modifier
            .fillMaxWidth()
            .height(metrics.controlHeight)
            .graphicsLayer { alpha = if (enabled) 1f else motion.disabledOpacity }
            .padding(horizontal = metrics.hairlineWidth * 3),
    ) {
        Box(Modifier.fillMaxWidth().height(trackHeight).align(Alignment.Center)
            .background(s.press, RoundedCornerShape(metrics.controlRadius)))
        val cell = maxWidth / options.size.coerceAtLeast(1)
        if (selected in options.indices) Box(
            Modifier
                .offset { IntOffset((cell * position).roundToPx(), ((metrics.controlHeight - thumbHeight) / 2).roundToPx()) }
                .width(cell)
                .height(thumbHeight)
                .then(if (recipe.segmentShadow) Modifier.floatingShadow(segmentShape) else Modifier)
                .riffetMaterial(MaterialRole.CONTROL, segmentShape, if (recipe.segmentCard) s.card else s.selected),
        )
        Row(Modifier.fillMaxWidth().fillMaxHeight().selectableGroup()) {
            options.forEachIndexed { index, label ->
                val on = index == selected
                val tint by animateColorAsState(if (!enabled) s.disabledContent else if (on) s.selectedContent else colors.fg2, motion.effects(), label = "segment-label")
                val source = remember { MutableInteractionSource() }
                val focused by source.collectIsFocusedAsState()
                Box(
                    Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .clip(segmentShape)
                        .then(if (focused) Modifier.border(metrics.focusWidth, s.focus, segmentShape) else Modifier)
                        .selectable(on, enabled = enabled, role = Role.Tab, interactionSource = source, indication = LocalIndication.current) { onSelect(index) },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(label, color = tint, style = LocalRiffetTypography.current.segmented, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/** One filter in a [ChipRow]. */
internal class ChipItem(val key: String, val label: String, val count: Int? = null)

/**
 * A row of filter chips sharing one selection indicator that slides (and resizes) to the chosen
 * chip, instead of each chip snapping its own fill. Scrolls sideways when it does not fit.
 */
@Composable
internal fun ChipRow(
    items: List<ChipItem>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(horizontal = LocalInterfaceStyle.current.metrics.groupInset),
    /** Scrolls with the chips ahead of them, e.g. a [ChipButton] that opens a picker. */
    leading: (@Composable () -> Unit)? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    if (LocalInterfaceStyle.current.components.controls.chips == ComponentBackend.MATERIAL) {
        CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides metrics.controlHeight) {
            Row(modifier.horizontalScroll(rememberScrollState()).padding(contentPadding), horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2)) {
                leading?.invoke()
                items.forEach { item ->
                    FilterChip(selected = selected == item.key, onClick = { onSelect(item.key) }, label = {
                        Text(if (item.count == null) item.label else item.label + " · " + item.count,
                            style = LocalRiffetTypography.current.buttonSmall)
                    }, shape = RoundedCornerShape(metrics.controlRadius))
                }
            }
        }
        return
    }
    val colors = LocalRiffetColors.current
    val s = surfaces
    val density = LocalDensity.current
    // Each chip's placement in the row, so the indicator knows where to go.
    val bounds = remember { mutableStateMapOf<String, Pair<Dp, Dp>>() }
    val target = bounds[selected]
    val xAnim = remember { Animatable(0f) }
    val wAnim = remember { Animatable(0f) }
    var placed by remember { mutableStateOf(false) }
    var lastSelected by remember { mutableStateOf(selected) }
    LaunchedEffect(selected, target) {
        val (tx, tw) = target ?: return@LaunchedEffect
        val animate = placed && (lastSelected != selected || xAnim.isRunning || wAnim.isRunning)
        lastSelected = selected
        if (!animate) {
            xAnim.snapTo(tx.value)
            wAnim.snapTo(tw.value)
            placed = true
        } else {
            val spec = motion.spatial<Float>()
            coroutineScope {
                launch { xAnim.animateTo(tx.value, spec) }
                launch { wAnim.animateTo(tw.value, spec) }
            }
        }
    }
    Box(modifier.horizontalScroll(rememberScrollState()).padding(contentPadding)) {
        if (target != null) {
            Box(
                Modifier
                    .matchParentSize()
                    .layout { measurable, constraints ->
                        val currentX = if (placed && (xAnim.isRunning || lastSelected != selected)) xAnim.value.dp else target.first
                        val currentW = if (placed && (wAnim.isRunning || lastSelected != selected)) wAnim.value.dp else target.second
                        val pillH = metrics.segmentedHeight.roundToPx().coerceAtLeast(0)
                        val placeable = measurable.measure(Constraints.fixed(currentW.roundToPx().coerceAtLeast(0), pillH))
                        val y = ((metrics.controlHeight - metrics.segmentedHeight) / 2).coerceAtLeast(0.dp).roundToPx()
                        layout(constraints.maxWidth, constraints.maxHeight) { placeable.place(currentX.roundToPx(), y) }
                    }
                    .riffetMaterial(MaterialRole.CONTROL, RoundedCornerShape(metrics.controlRadius), s.selected),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy((metrics.controlInset / 2))) {
            leading?.invoke()
            items.forEach { item ->
                val on = item.key == selected
                val tint by animateColorAsState(if (on) s.selectedContent else colors.fg2, motion.effects(), label = "chip")
                val bare = LocalInterfaceStyle.current.components.controls.bareChips
                val fill by animateColorAsState(if (on || bare) s.press.copy(alpha = 0f) else s.press, motion.effects(), label = "chip-fill")
                val source = remember { MutableInteractionSource() }
                val focused by source.collectIsFocusedAsState()
                Row(
                    Modifier
                        .onPlaced { coordinates ->
                            bounds[item.key] = with(density) { coordinates.positionInParentX().toDp() to coordinates.size.width.toDp() }
                        }
                        .height(metrics.controlHeight)
                        .clip(RoundedCornerShape(metrics.controlRadius))
                        .drawBehind {
                            drawRoundRect(fill, topLeft = Offset(0f, ((metrics.controlHeight - metrics.segmentedHeight) / 2).coerceAtLeast(0.dp).toPx()), size = Size(size.width, metrics.segmentedHeight.toPx()), cornerRadius = CornerRadius(metrics.controlRadius.toPx()))
                        }
                        .then(if (focused) Modifier.border(metrics.focusWidth, s.focus, RoundedCornerShape(metrics.controlRadius)) else Modifier)
                        .selectable(on, interactionSource = source, indication = LocalIndication.current, role = Role.Tab) { onSelect(item.key) }
                        .padding(horizontal = metrics.rowPadding),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy((metrics.controlInset / 2)),
                ) {
                    Text(item.label, color = tint, style = LocalRiffetTypography.current.buttonSmall, maxLines = 1)
                    if (item.count != null) Text("${item.count}", color = tint, style = LocalRiffetTypography.current.buttonSmall, maxLines = 1)
                }
            }
        }
    }
}

/**
 * A chip that opens a picker rather than toggling: [label] with a trailing chevron, filled like a
 * selected chip while [active] (a scope is set). Sized and shaped like [ChipRow]'s chips and
 * [ToggleChip], so a row can mix the three.
 */
@Composable
internal fun ChipButton(
    label: String,
    active: Boolean,
    onClick: () -> Unit,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    /** Ahead of the chevron; null for a chip that acts rather than opens a menu (jump to a folder). */
    trailingIcon: ImageVector? = RiffetIcons.ChevronDown,
    /** A second gesture on the chip (the custom-drawn chip only). */
    onLongClick: (() -> Unit)? = null,
) = ChipFrame(label, selected = active, enabled = enabled, role = Role.Button, onClick = onClick,
    leadingIcon = icon, trailingIcon = trailingIcon, onLongClick = onLongClick)

/**
 * An on/off option as a chip (Fast, Max): the selected fill while [selected], nothing else — one
 * mark for one state (mobile.md §1.1). The same chip as [ChipButton], without the chevron.
 */
@Composable
internal fun ToggleChip(label: String, selected: Boolean, onToggle: (Boolean) -> Unit, enabled: Boolean = true) =
    ChipFrame(label, selected = selected, enabled = enabled, role = Role.Switch, onClick = { onToggle(!selected) },
        leadingIcon = null, trailingIcon = null)

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChipFrame(
    label: String,
    selected: Boolean,
    enabled: Boolean,
    role: Role,
    onClick: () -> Unit,
    leadingIcon: ImageVector?,
    trailingIcon: ImageVector?,
    onLongClick: (() -> Unit)? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val glyph = metrics.smallIconSize * 0.85f
    if (LocalInterfaceStyle.current.components.controls.chips == ComponentBackend.MATERIAL) {
        FilterChip(selected = selected, onClick = onClick, enabled = enabled,
            label = { Text(label, style = LocalRiffetTypography.current.buttonSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 160.dp)) },
            leadingIcon = leadingIcon?.let { { Icon(it, contentDescription = null, modifier = Modifier.size(glyph)) } },
            trailingIcon = trailingIcon?.let { { Icon(it, contentDescription = null, modifier = Modifier.size(glyph)) } },
            shape = RoundedCornerShape(metrics.controlRadius))
        return
    }
    val colors = LocalRiffetColors.current
    val s = surfaces
    val tint by animateColorAsState(when {
        !enabled -> s.disabledContent
        selected -> s.selectedContent
        else -> colors.fg2
    }, motion.effects(), label = "chip")
    val fill by animateColorAsState(if (selected) s.selected else s.press, motion.effects(), label = "chip-fill")
    Row(
        Modifier
            .height(metrics.controlHeight)
            .clip(RoundedCornerShape(metrics.controlRadius))
            .drawBehind {
                drawRoundRect(fill, topLeft = Offset(0f, ((metrics.controlHeight - metrics.segmentedHeight) / 2).coerceAtLeast(0.dp).toPx()), size = Size(size.width, metrics.segmentedHeight.toPx()), cornerRadius = CornerRadius(metrics.controlRadius.toPx()))
            }
            .combinedClickable(enabled = enabled, role = role, onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = metrics.rowPadding * 3 / 4),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 3),
    ) {
        leadingIcon?.let { Icon(it, contentDescription = null, tint = tint, modifier = Modifier.size(glyph)) }
        Text(label, color = tint, style = LocalRiffetTypography.current.buttonSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 160.dp))
        trailingIcon?.let { Icon(it, contentDescription = null, tint = tint, modifier = Modifier.size(glyph)) }
    }
}

private fun LayoutCoordinates.positionInParentX(): Float = parentLayoutCoordinates?.localPositionOf(this, Offset.Zero)?.x ?: 0f

/** Semantic action used by settings, files, Git and home. */
@Composable
fun RiffetButton(
    text: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
    primary: Boolean = false,
    danger: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val s = surfaces
    val colors = LocalRiffetColors.current
    val type = LocalRiffetTypography.current
    val recipe = LocalInterfaceStyle.current.components.controls
    val tinted = LocalInterfaceStyle.current.variants.secondaryButtons == riffet.ui.design.SecondaryButtonPresentation.TONAL
    if (!primary && !tinted && recipe.plainSecondary) {
        RiffetTextButton(onClick, modifier, enabled, danger) { Text(text, style = type.button) }
        return
    }
    if (recipe.outlinedSecondary && !primary) {
        androidx.compose.material3.OutlinedButton(
            onClick, modifier.minimumInteractiveComponentSize().heightIn(min = metrics.buttonHeight), enabled, shape = RoundedCornerShape(metrics.controlRadius),
            border = androidx.compose.foundation.BorderStroke(metrics.hairlineWidth, s.hairline),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = if (danger) colors.danger else colors.fg,
                disabledContentColor = s.disabledContent),
        ) { Text(text, style = type.button) }
        return
    }
    if (recipe.buttons == ComponentBackend.MIUIX) {
        val background = if (primary) { if (danger) colors.danger else s.primaryAction } else s.secondaryAction
        val foreground = if (primary) { if (danger) colors.dangerFg else s.primaryActionContent }
            else if (danger) colors.danger else s.secondaryActionContent
        top.yukonga.miuix.kmp.basic.Button(
            onClick, modifier.minimumInteractiveComponentSize(), enabled, cornerRadius = metrics.controlRadius, minHeight = metrics.buttonHeight,
            colors = top.yukonga.miuix.kmp.basic.ButtonDefaults.buttonColors(
                color = background, contentColor = foreground,
                disabledColor = s.press, disabledContentColor = s.disabledContent,
            ),
        ) { Text(text, style = type.button, color = if (!enabled) s.disabledContent else foreground,
            maxLines = 1, overflow = TextOverflow.Ellipsis) }
        return
    }
    if (recipe.buttons == ComponentBackend.MATERIAL) {
        // Material keeps the 48dp touch target outside its 40dp button surface.
        val buttonHeight = metrics.buttonHeight
        val buttonShape = RoundedCornerShape(metrics.controlRadius)
        CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides metrics.controlHeight) {
            if (primary) Button(onClick = onClick, enabled = enabled, modifier = modifier.heightIn(min = buttonHeight), shape = buttonShape,
                colors = ButtonDefaults.buttonColors(containerColor = if (danger) colors.danger else s.primaryAction,
                    contentColor = if (danger) colors.dangerFg else s.primaryActionContent, disabledContentColor = s.disabledContent)) { Text(text, style = type.button) }
            else if (tinted) FilledTonalButton(onClick = onClick, enabled = enabled, modifier = modifier.heightIn(min = buttonHeight), shape = buttonShape,
                colors = ButtonDefaults.filledTonalButtonColors(containerColor = if (danger) colors.dangerSoft else s.secondaryAction,
                    contentColor = if (danger) colors.danger else s.secondaryActionContent, disabledContentColor = s.disabledContent)) { Text(text, style = type.button) }
            else androidx.compose.material3.TextButton(onClick = onClick, enabled = enabled, modifier = modifier.heightIn(min = buttonHeight), shape = buttonShape,
                colors = ButtonDefaults.textButtonColors(contentColor = if (danger) colors.danger else s.primaryAction,
                    disabledContentColor = s.disabledContent)) { Text(text, style = type.button) }
        }
        return
    }
    SharedAction(onClick, modifier, enabled, danger, primary, tinted = tinted) {
        Text(text, modifier = Modifier.padding(horizontal = metrics.controlInset, vertical = metrics.controlInset / 2),
            maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}


/** The containing selectable row owns focus, semantics and activation. */
@Composable
internal fun SelectionMark(selected: Boolean, enabled: Boolean = true, tint: Color? = null) {
    RiffetRadioButton(selected = selected, onClick = null, enabled = enabled, tint = tint)
}

/** Text and icon actions share the same component renderer and minimum touch target. */
@Composable
internal fun RiffetIconButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    if (LocalInterfaceStyle.current.components.controls.buttons == ComponentBackend.MATERIAL) {
        androidx.compose.material3.IconButton(onClick, modifier.sizeIn(minWidth = metrics.controlHeight, minHeight = metrics.controlHeight), enabled, content = content)
    } else SharedAction(onClick, modifier.sizeIn(minWidth = metrics.controlHeight, minHeight = metrics.controlHeight), enabled, false, content = content)
}

@Composable
internal fun RiffetTextButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    danger: Boolean = false,
    contentPadding: PaddingValues = PaddingValues(horizontal = LocalInterfaceStyle.current.metrics.controlInset),
    content: @Composable RowScope.() -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    if (LocalInterfaceStyle.current.components.controls.buttons == ComponentBackend.MATERIAL) {
        val buttonHeight = metrics.buttonHeight
        val buttonShape = RoundedCornerShape(metrics.controlRadius)
        CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides metrics.controlHeight) {
            androidx.compose.material3.TextButton(
                onClick = onClick, modifier = modifier.heightIn(min = buttonHeight), enabled = enabled,
                contentPadding = contentPadding, shape = buttonShape,
                colors = ButtonDefaults.textButtonColors(contentColor = if (danger) LocalRiffetColors.current.danger else surfaces.primaryAction, disabledContentColor = surfaces.disabledContent),
            ) { CompositionLocalProvider(LocalTextStyle provides LocalRiffetTypography.current.button) { content() } }
        }
    } else SharedAction(onClick, modifier, enabled, danger) {
        Row(Modifier.padding(if (LocalDialogAction.current) PaddingValues(horizontal = (metrics.controlInset / 2)) else contentPadding), verticalAlignment = Alignment.CenterVertically, content = content)
    }
}

/** Inline selectors paint a compact face inside an independent, accessible touch region. */
@Composable
internal fun RiffetInlineAction(
    onClick: (() -> Unit)?,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) {
    val style = LocalInterfaceStyle.current
    val metrics = style.metrics
    val colors = LocalRiffetColors.current
    val s = surfaces
    val recipe = style.components.controls
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val shape = RoundedCornerShape(if (recipe.inlineControlRadius) metrics.controlRadius else metrics.selectionRadius)
    val background = when (recipe.inline) {
        InlinePresentation.TRANSPARENT, InlinePresentation.OUTLINED -> Color.Transparent
        InlinePresentation.NEUTRAL -> colors.bgMuted
        InlinePresentation.TONAL -> s.secondaryAction
    }
    val foreground = if (!enabled) s.disabledContent else if (recipe.inline == InlinePresentation.TRANSPARENT) colors.accent else s.secondaryActionContent
    val action = onClick?.let {
        Modifier.clickable(source, indication = null, enabled = enabled, role = Role.Button, onClick = it)
    } ?: Modifier
    Box(modifier.sizeIn(minWidth = if (onClick == null) 0.dp else metrics.controlHeight,
        minHeight = if (onClick == null) metrics.inlineControlHeight else metrics.controlHeight).then(action),
        contentAlignment = Alignment.CenterStart) {
        Row(Modifier.heightIn(min = metrics.inlineControlHeight).clip(shape)
            .riffetMaterial(MaterialRole.CONTROL, shape, background, source)
            .then(if (recipe.inline == InlinePresentation.OUTLINED || focused) Modifier.border(if (focused) metrics.focusWidth else metrics.hairlineWidth,
                if (focused) s.focus else s.hairline, shape) else Modifier)
            .indication(source, LocalIndication.current)
            .padding(horizontal = metrics.controlInset / 2, vertical = metrics.controlInset / 3),
            verticalAlignment = Alignment.CenterVertically) {
            CompositionLocalProvider(LocalContentColor provides foreground, LocalTextStyle provides LocalRiffetTypography.current.buttonSmall) { content() }
        }
    }
}

@Composable
private fun SharedAction(
    onClick: () -> Unit,
    modifier: Modifier,
    enabled: Boolean,
    danger: Boolean,
    primary: Boolean = false,
    tinted: Boolean = false,
    content: @Composable () -> Unit,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val dialogAction = LocalDialogAction.current
    val filledDialog = dialogAction && LocalInterfaceStyle.current.components.controls.filledDialogActions
    val filled = primary && !dialogAction
    val confirm = filledDialog && LocalDialogConfirm.current
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val focused by source.collectIsFocusedAsState()
    val opacity by animateFloatAsState(if (pressed && enabled) motion.pressOpacity else 1f, motion.effects(), label = "button-opacity")
    val shape = RoundedCornerShape(if (dialogAction && !filledDialog) 0.dp else LocalInterfaceStyle.current.controlRadius)
    val textStyle = if (dialogAction) LocalTextStyle.current else LocalRiffetTypography.current.button
    val foreground = when {
        !enabled -> surfaces.disabledContent
        filled && danger -> colors.dangerFg
        filled -> surfaces.primaryActionContent
        danger -> colors.danger
        confirm -> surfaces.primaryActionContent
        else -> surfaces.secondaryActionContent
    }
    val background = when {
        dialogAction -> Color.Transparent
        !filled -> if (tinted) surfaces.secondaryAction else Color.Transparent
        !enabled -> surfaces.press
        danger -> colors.danger
        else -> surfaces.primaryAction
    }
    // Two fills of one weight left the choice to the label's weight alone: the confirming action is the primary
    // fill, a destructive one its danger tint, and the way out stays quiet.
    val actionBackground = when {
        !confirm || !enabled -> surfaces.secondaryAction
        danger -> colors.danger.copy(alpha = 0.12f)
        else -> surfaces.primaryAction
    }
    Box(
        modifier.then(if (dialogAction && !filledDialog) Modifier.fillMaxWidth() else Modifier)
            .minimumInteractiveComponentSize()
            .heightIn(min = if (filled || tinted) metrics.buttonHeight else metrics.controlHeight)
            .graphicsLayer { alpha = if (pressed && enabled) motion.pressOpacity else opacity }
            .clip(shape)
            .background(background)
            .then(if (filledDialog) Modifier.drawBehind {
                val inset = (metrics.controlInset / 3).toPx().coerceAtMost(size.height / 2)
                drawRoundRect(actionBackground, topLeft = Offset(0f, inset),
                    size = Size(size.width, size.height - inset * 2), cornerRadius = CornerRadius(metrics.controlRadius.toPx()))
            } else Modifier)
            .then(if (focused) Modifier.border(metrics.focusWidth, surfaces.focus, shape) else Modifier)
            .clickable(interactionSource = source, indication = null, enabled = enabled, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        CompositionLocalProvider(
            LocalContentColor provides foreground,
            LocalTextStyle provides textStyle,
            content = content,
        )
    }
}

@Composable
internal fun RiffetCheckbox(checked: Boolean, onCheckedChange: ((Boolean) -> Unit)?, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val metrics = LocalInterfaceStyle.current.metrics
    if (LocalInterfaceStyle.current.components.controls.choices == ComponentBackend.MIUIX && !metrics.isOverridden("iconSize")) {
        top.yukonga.miuix.kmp.basic.Checkbox(
            state = if (checked) androidx.compose.ui.state.ToggleableState.On else androidx.compose.ui.state.ToggleableState.Off,
            onClick = onCheckedChange?.let { change -> { change(!checked) } }, modifier = modifier, enabled = enabled,
        )
        return
    }
    if (LocalInterfaceStyle.current.components.controls.choices == ComponentBackend.MATERIAL) {
        CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides metrics.controlHeight) {
            androidx.compose.material3.Checkbox(checked, onCheckedChange, modifier = modifier, enabled = enabled)
        }
        return
    }
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val colors = LocalRiffetColors.current
    val shape = RoundedCornerShape(metrics.selectionRadius / 2)
    val tint = if (enabled) colors.accent else surfaces.disabledContent
    val action = if (onCheckedChange == null) Modifier else Modifier.sizeIn(minWidth = metrics.controlHeight, minHeight = metrics.controlHeight)
        .toggleable(value = checked, interactionSource = source, indication = LocalIndication.current, enabled = enabled, role = Role.Checkbox, onValueChange = onCheckedChange)
    Box(modifier.then(action), contentAlignment = Alignment.Center) {
        Box(Modifier.size(metrics.iconSize).background(if (checked) tint else Color.Transparent, shape)
            .border(if (focused) metrics.focusWidth else metrics.hairlineWidth, if (focused) surfaces.focus else if (checked) tint else colors.fg4, shape), contentAlignment = Alignment.Center) {
            if (checked) riffet.ui.icons.Icon(riffet.ui.icons.RiffetIcons.Check, null, tint = colors.accentFg, modifier = Modifier.size(metrics.smallIconSize))
        }
    }
}

@Composable
internal fun RiffetRadioButton(selected: Boolean, onClick: (() -> Unit)?, modifier: Modifier = Modifier, enabled: Boolean = true, tint: Color? = null) {
    val metrics = LocalInterfaceStyle.current.metrics
    if (LocalInterfaceStyle.current.components.controls.choices == ComponentBackend.MIUIX && !metrics.isOverridden("iconSize")) {
        top.yukonga.miuix.kmp.basic.RadioButton(selected, onClick, modifier, enabled = enabled,
            colors = top.yukonga.miuix.kmp.basic.RadioButtonDefaults.radioButtonColors(
                selectedColor = tint ?: surfaces.focus, disabledSelectedColor = surfaces.disabledContent,
            ))
        return
    }
    if (LocalInterfaceStyle.current.components.controls.choices == ComponentBackend.MATERIAL) {
        CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides metrics.controlHeight) {
            androidx.compose.material3.RadioButton(selected, onClick, modifier = modifier, enabled = enabled,
                colors = RadioButtonDefaults.colors(selectedColor = tint ?: Color.Unspecified,
                    disabledSelectedColor = surfaces.disabledContent))
        }
        return
    }
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val colors = LocalRiffetColors.current
    val resolvedTint = if (enabled) tint ?: colors.accent else surfaces.disabledContent
    val action = if (onClick == null) Modifier else Modifier.sizeIn(minWidth = metrics.controlHeight, minHeight = metrics.controlHeight)
        .selectable(selected = selected, interactionSource = source, indication = LocalIndication.current, enabled = enabled, role = Role.RadioButton, onClick = onClick)
    Box(modifier.then(action).sizeIn(minWidth = metrics.iconSize, minHeight = metrics.iconSize)
        .then(if (focused) Modifier.border(metrics.focusWidth, surfaces.focus, CircleShape) else Modifier), contentAlignment = Alignment.Center) {
        if (selected) riffet.ui.icons.Icon(riffet.ui.icons.RiffetIcons.Check, null, tint = resolvedTint, modifier = Modifier.size(metrics.iconSize))
        else if (onClick != null) Box(Modifier.size(metrics.smallIconSize).border(if (focused) metrics.focusWidth else metrics.hairlineWidth, if (focused) surfaces.focus else colors.fg4, CircleShape))
    }
}
