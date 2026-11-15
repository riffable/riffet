package riffet.ui.design

import riffet.ui.theme.LocalRiffetMotion
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography

/** Filled search surface shared by lists and settings; callers own the surrounding page inset. */
@Composable
internal fun RiffetSearchField(
    query: String,
    onQueryChange: (String) -> Unit,
    placeholder: String,
    clearDescription: String,
    modifier: Modifier = Modifier,
    onFocusChange: (Boolean) -> Unit = {},
    requestFocus: Boolean = false,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val focus = LocalFocusManager.current
    val requester = remember { FocusRequester() }
    val focusChanged by rememberUpdatedState(onFocusChange)
    LaunchedEffect(requestFocus) { if (requestFocus) requester.requestFocus() }
    DisposableEffect(Unit) { onDispose { focusChanged(false) } }
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val ring by animateColorAsState(if (focused) LocalRiffetSurfaces.current.focus else Color.Transparent, motion.effects(), label = "search-ring")
    val shape = RoundedCornerShape(LocalInterfaceStyle.current.controlRadius)
    val text = remember(typography, colors.fg) { typography.input.copy(color = colors.fg) }
    Row(
        modifier = modifier
            .onFocusChanged { focusChanged(it.hasFocus) }
            .fillMaxWidth()
            .heightIn(min = metrics.controlHeight)
            .clip(shape)
            // The chips' fill rather than the card's: it reads on a page and on a sheet alike.
            .background(LocalRiffetSurfaces.current.press)
            .border(metrics.focusWidth, ring, shape)
            .clickable(interactionSource = null, indication = null) { requester.requestFocus() }
            .padding(start = metrics.inputInset, end = if (query.isNotEmpty()) metrics.controlInset / 3 else metrics.inputInset),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(metrics.controlInset * 2 / 3),
    ) {
        Icon(RiffetIcons.Search, contentDescription = null, tint = colors.fg3, modifier = Modifier.size(metrics.smallIconSize))
        BasicTextField(
            value = query, onValueChange = onQueryChange, singleLine = true, textStyle = text,
            cursorBrush = SolidColor(colors.accent),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { focus.clearFocus() }),
            interactionSource = source,
            modifier = Modifier.weight(1f).heightIn(min = metrics.controlHeight).focusRequester(requester)
                .semantics { contentDescription = placeholder },
            decorationBox = { field ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (query.isEmpty()) Text(placeholder, style = text, color = colors.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    field()
                }
            },
        )
        if (query.isNotEmpty()) {
            Box(
                modifier = Modifier.size(metrics.controlHeight).clip(shape).clickable(role = Role.Button) { onQueryChange("") },
                contentAlignment = Alignment.Center,
            ) {
                Icon(RiffetIcons.Close, contentDescription = clearDescription, tint = colors.fg3, modifier = Modifier.size(metrics.smallIconSize))
            }
        }
    }
}

/** Native editing, selection and IME behavior with recipe-specific decoration. */
@Composable
internal fun RiffetTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String? = null,
    enabled: Boolean = true,
    mono: Boolean = false,
    password: Boolean = false,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE,
    modifier: Modifier = Modifier,
    readOnly: Boolean = false,
    label: (@Composable () -> Unit)? = null,
    trailingIcon: (@Composable () -> Unit)? = null,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val style = LocalInterfaceStyle.current
    val recipe = style.components.inputs
    val s = surfaces
    val shape = RoundedCornerShape(style.controlRadius)
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val transformation = if (password) PasswordVisualTransformation() else VisualTransformation.None
    val textStyle = if (mono) typography.input.copy(fontFamily = typography.monoFamily) else typography.input
    val hint: (@Composable () -> Unit)? = placeholder?.let { { Text(it, style = textStyle) } }
    if (recipe.fields == ComponentBackend.MIUIX) {
        Column(modifier.fillMaxWidth()) {
            label?.invoke()
            top.yukonga.miuix.kmp.basic.TextField(
                value, onValueChange, modifier = Modifier.fillMaxWidth().heightIn(min = metrics.inputMinHeight),
                cornerRadius = metrics.controlRadius, label = placeholder.orEmpty(), useLabelAsPlaceholder = true,
                colors = top.yukonga.miuix.kmp.basic.TextFieldDefaults.textFieldColors(
                    backgroundColor = s.input, labelColor = if (enabled) colors.fg3 else s.disabledContent, borderColor = s.focus,
                ),
                enabled = enabled, readOnly = readOnly, textStyle = textStyle.copy(color = if (enabled) colors.fg else s.disabledContent),
                keyboardOptions = keyboardOptions, keyboardActions = keyboardActions,
                trailingIcon = trailingIcon, singleLine = singleLine, minLines = minLines, maxLines = maxLines,
                visualTransformation = transformation, interactionSource = source, cursorBrush = SolidColor(s.focus),
            )
        }
    } else if (recipe.fields == ComponentBackend.MATERIAL) {
        OutlinedTextField(
            value = value, onValueChange = onValueChange, enabled = enabled, readOnly = readOnly,
            singleLine = singleLine, minLines = minLines, maxLines = maxLines, placeholder = hint,
            label = label, trailingIcon = trailingIcon, keyboardOptions = keyboardOptions, keyboardActions = keyboardActions,
            textStyle = textStyle, visualTransformation = transformation, shape = shape,
            interactionSource = source, modifier = modifier.fillMaxWidth().heightIn(min = metrics.inputMinHeight),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = s.focus, unfocusedBorderColor = MaterialTheme.colorScheme.outline,
                disabledBorderColor = MaterialTheme.colorScheme.outline.copy(alpha = MaterialTheme.colorScheme.outline.alpha * 0.38f), cursorColor = colors.accent,
                focusedTextColor = colors.fg, unfocusedTextColor = colors.fg, disabledTextColor = s.disabledContent,
                focusedPlaceholderColor = colors.fg3, unfocusedPlaceholderColor = colors.fg3, disabledPlaceholderColor = s.disabledContent,
                focusedContainerColor = s.input, unfocusedContainerColor = s.input, disabledContainerColor = s.input,
            ),
        )
    } else {
        val fieldStyle = textStyle
            .copy(color = if (enabled) colors.fg else s.disabledContent)
        Column(modifier.fillMaxWidth()) {
            // Shared editors place their labels outside the editing surface.
            if (label != null) {
                CompositionLocalProvider(
                    LocalContentColor provides if (enabled) colors.fg3 else s.disabledContent,
                    LocalTextStyle provides typography.subhead,
                ) { label() }
                Spacer(Modifier.height((metrics.controlInset / 2)))
            }
            BasicTextField(
                value = value, onValueChange = onValueChange, enabled = enabled, readOnly = readOnly,
                singleLine = singleLine, minLines = minLines, maxLines = maxLines,
                keyboardOptions = keyboardOptions, keyboardActions = keyboardActions,
                textStyle = fieldStyle, visualTransformation = transformation, interactionSource = source,
                cursorBrush = SolidColor(colors.accent),
                modifier = Modifier.fillMaxWidth().heightIn(min = metrics.inputMinHeight)
                    .clip(shape)
                    .background(s.input, shape)
                    .then(if (recipe.underline) Modifier.drawBehind {
                        val width = if (focused) metrics.focusWidth.toPx() else metrics.hairlineWidth.toPx()
                        drawLine(if (focused) s.focus else colors.fg3, Offset(0f, size.height - width / 2), Offset(size.width, size.height - width / 2), strokeWidth = width)
                    } else if (focused) Modifier.border(metrics.focusWidth, s.focus, shape) else Modifier),
                decorationBox = { innerTextField ->
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = metrics.inputMinHeight).padding(horizontal = metrics.inputInset),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier.weight(1f).padding(vertical = metrics.inputInset / 2),
                            contentAlignment = if (singleLine) Alignment.CenterStart else Alignment.TopStart,
                        ) {
                            if (value.isEmpty() && placeholder != null) {
                                Text(placeholder, style = fieldStyle.copy(color = if (enabled) colors.fg3 else s.disabledContent), maxLines = if (singleLine) 1 else maxLines)
                            }
                            innerTextField()
                        }
                        if (trailingIcon != null) {
                            Spacer(Modifier.width((metrics.controlInset / 2)))
                            Box(Modifier.sizeIn(minWidth = metrics.controlHeight, minHeight = metrics.controlHeight), contentAlignment = Alignment.Center) {
                                CompositionLocalProvider(LocalContentColor provides if (enabled) colors.fg3 else s.disabledContent) { trailingIcon() }
                            }
                        }
                    }
                },
            )
        }
    }
}

/**
 * A text field as one row of a [Group] (mobile.md §2.3): the card is its container, so it draws no
 * outline and no fill of its own — an outlined field inside a card is two boxes, and the card's
 * corner clips the outline. [label] above the text, in the third tone, when the group holds more
 * than one field; a lone field says what it is with the page title or [placeholder]. The hairline
 * between fields is the group's.
 */
@Composable
internal fun GroupField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String? = null,
    enabled: Boolean = true,
    mono: Boolean = false,
    password: Boolean = false,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE,
    trailingIcon: (@Composable () -> Unit)? = null,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val s = surfaces
    val base = if (mono) typography.input.copy(fontFamily = typography.monoFamily) else typography.input
    val textStyle = base.copy(color = if (enabled) colors.fg else s.disabledContent)
    BasicTextField(
        value = value, onValueChange = onValueChange, enabled = enabled, singleLine = singleLine,
        minLines = minLines, maxLines = maxLines, keyboardOptions = keyboardOptions, keyboardActions = keyboardActions,
        textStyle = textStyle, visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
        cursorBrush = SolidColor(colors.accent),
        modifier = modifier.fillMaxWidth(),
        decorationBox = { inner ->
            Row(
                Modifier.fillMaxWidth().heightIn(min = metrics.rowHeight)
                    .padding(start = metrics.rowPadding, end = if (trailingIcon != null) metrics.controlInset / 3 else metrics.rowPadding),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f).padding(vertical = metrics.rowPadding / 2)) {
                    if (label != null) Text(label, style = typography.bodySmall, color = if (enabled) colors.fg3 else s.disabledContent,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(bottom = metrics.hairlineWidth * 2))
                    Box(contentAlignment = Alignment.CenterStart) {
                        if (value.isEmpty() && placeholder != null) Text(placeholder, style = base.copy(color = if (enabled) colors.fg3 else s.disabledContent),
                            maxLines = if (singleLine) 1 else maxLines, overflow = TextOverflow.Ellipsis)
                        inner()
                    }
                }
                if (trailingIcon != null) Box(Modifier.sizeIn(minWidth = metrics.controlHeight, minHeight = metrics.controlHeight), contentAlignment = Alignment.Center) {
                    CompositionLocalProvider(LocalContentColor provides if (enabled) colors.fg3 else s.disabledContent) { trailingIcon() }
                }
            }
        },
    )
}

/** M3 owns dragging, stepping, keyboard adjustment and accessibility for both renderers. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RiffetSlider(
    value: Float,
    onValueChange: (Float) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    valueRange: ClosedFloatingPointRange<Float> = 0f..1f,
    steps: Int = 0,
    onValueChangeFinished: (() -> Unit)? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val source = remember { MutableInteractionSource() }
    val s = surfaces
    val recipe = LocalInterfaceStyle.current.components.inputs
    if (recipe.sliders == ComponentBackend.MIUIX && !metrics.isOverridden("sliderTrackHeight") && valueRange.start < valueRange.endInclusive) {
        top.yukonga.miuix.kmp.basic.Slider(
            value, onValueChange, modifier.heightIn(min = metrics.controlHeight), enabled, valueRange, steps,
            onValueChangeFinished = onValueChangeFinished, height = metrics.sliderThumbSize,
        )
        return
    }
    if (recipe.sliders == ComponentBackend.MATERIAL) {
        val sliderColors = SliderDefaults.colors(thumbColor = s.primaryAction, activeTrackColor = s.primaryAction,
            disabledThumbColor = s.disabledContent, disabledActiveTrackColor = s.disabledContent)
        Slider(value = value, onValueChange = onValueChange, modifier = modifier.heightIn(min = metrics.controlHeight), enabled = enabled,
            valueRange = valueRange, steps = steps, onValueChangeFinished = onValueChangeFinished, interactionSource = source,
            colors = sliderColors,
            thumb = { SliderDefaults.Thumb(source, colors = sliderColors, enabled = enabled,
                thumbSize = DpSize(metrics.sliderThumbSize / 7, metrics.sliderThumbSize * (11f / 7f))) },
            track = { SliderDefaults.Track(it, modifier = Modifier.height(metrics.sliderTrackHeight), enabled = enabled, colors = sliderColors) })
        return
    }
    val colors = LocalRiffetColors.current
    val motion = LocalRiffetMotion.current
    val pressed by source.collectIsPressedAsState()
    val dragged by source.collectIsDraggedAsState()
    val focused by source.collectIsFocusedAsState()
    Slider(
        value = value, onValueChange = onValueChange, modifier = modifier.heightIn(min = metrics.controlHeight), enabled = enabled,
        valueRange = valueRange, steps = steps, onValueChangeFinished = onValueChangeFinished,
        interactionSource = source,
        thumb = {
            Box(Modifier.size(metrics.sliderThumbSize)
                .dropShadow(CircleShape, Shadow(radius = if (pressed || dragged) metrics.floatingShadowLiftedRadius / 4 else metrics.floatingShadowRadius / 4, color = s.shadow, alpha = motion.floatingShadowOpacity))
                .background(if (!enabled) s.disabledContent else if (recipe.accentThumb) s.primaryAction else s.switchThumb, CircleShape)
                .border(if (focused) metrics.focusWidth else metrics.hairlineWidth, if (focused) s.focus else s.hairline, CircleShape))
        },
        track = { state ->
            Canvas(Modifier.fillMaxWidth().height(metrics.sliderTrackHeight)) {
                val radius = size.height / 2f
                val left = radius
                val right = (size.width - radius).coerceAtLeast(left)
                val fraction = state.coercedValueAsFraction
                val rtl = layoutDirection == LayoutDirection.Rtl
                val start = if (rtl) right else left
                val end = if (rtl) left else right
                val activeEnd = start + (end - start) * fraction
                drawLine(s.hairline, Offset(left, radius), Offset(right, radius), size.height, StrokeCap.Round)
                drawLine(if (enabled) s.primaryAction else s.disabledContent, Offset(start, radius), Offset(activeEnd, radius), size.height, StrokeCap.Round)
            }
        },
    )
}
