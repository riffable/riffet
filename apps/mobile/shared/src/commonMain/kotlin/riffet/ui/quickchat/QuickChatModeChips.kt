package riffet.ui.quickchat

import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import riffet.contracts.NativeBackendOption
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.theme.LocalRiffetMotion

/**
 * The chat modes as one scrollable strip of chips: 对话 and the presets. A mode the backend no
 * longer lists simply does not appear; the selected value is the session's own `mode`.
 */
@Composable
internal fun QuickChatModeChips(
    options: List<NativeBackendOption>,
    value: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    Row(
        modifier = modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(metrics.controlInset / 2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        options.forEach { option ->
            val selected = option.id == value
            if (!(LocalInterfaceStyle.current.components.controls.chips == riffet.ui.design.ComponentBackend.MATERIAL)) {
                val source = remember(option.id) { MutableInteractionSource() }
                val pressed by source.collectIsPressedAsState()
                val focused by source.collectIsFocusedAsState()
                val shape = RoundedCornerShape(LocalInterfaceStyle.current.selectionRadius)
                Row(
                    Modifier.sizeIn(minWidth = metrics.controlHeight, minHeight = metrics.controlHeight)
                        .graphicsLayer { alpha = if (pressed) motion.pressOpacity else 1f }
                        .then(if (focused) Modifier.border(metrics.focusWidth, LocalRiffetSurfaces.current.focus, shape) else Modifier)
                        .selectable(selected, interactionSource = source, indication = null, role = Role.RadioButton) { onSelect(option.id) }
                        .padding(vertical = ((metrics.controlHeight - metrics.segmentedHeight) / 2).coerceAtLeast(0.dp))
                        .clip(shape)
                        .background(if (selected) LocalRiffetSurfaces.current.selected else androidx.compose.ui.graphics.Color.Transparent)
                        .padding(horizontal = metrics.controlInset),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(option.label.ifEmpty { option.id }, style = typography.footnote, color = if (selected) colors.accent else colors.fg2,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = metrics.menuMaxWidth / 2))
                }
                return@forEach
            }
            androidx.compose.runtime.CompositionLocalProvider(
                androidx.compose.material3.LocalMinimumInteractiveComponentSize provides metrics.controlHeight,
            ) {
                androidx.compose.material3.FilterChip(
                    selected = selected,
                    onClick = { onSelect(option.id) },
                    label = { Text(option.label.ifEmpty { option.id }, style = typography.label, maxLines = 1) },
                    shape = RoundedCornerShape(metrics.selectionRadius),
                    leadingIcon = if (selected) ({
                        riffet.ui.icons.Icon(riffet.ui.icons.RiffetIcons.Check, null, Modifier.size(metrics.smallIconSize))
                    }) else null,
                    colors = androidx.compose.material3.FilterChipDefaults.filterChipColors(
                        selectedContainerColor = LocalRiffetSurfaces.current.selected,
                        selectedLabelColor = LocalRiffetSurfaces.current.selectedContent,
                        labelColor = colors.fg2,
                    ),
                )
            }
        }
    }
}

/**
 * The selected preset's prompt, under the chips. 对话 has none. Two lines collapsed; tapping the
 * text shows the whole prompt, which is what the preset actually sends.
 */
@Composable
internal fun QuickChatPresetPrompt(
    options: List<NativeBackendOption>,
    value: String,
    modifier: Modifier = Modifier,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val option = options.firstOrNull { it.id == value && it.id != "agent" } ?: return
    val prompt = option.description?.takeIf { it.isNotBlank() } ?: return
    var expanded by remember(value) { mutableStateOf(false) }
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    if (!(LocalInterfaceStyle.current.components.controls.chips == riffet.ui.design.ComponentBackend.MATERIAL)) {
        riffet.ui.design.RiffetTextButton(
            onClick = { expanded = !expanded },
            modifier = modifier.fillMaxWidth().animateContentSize(motion.spatial()),
            contentPadding = PaddingValues(12.dp),
        ) {
            Text(prompt, style = typography.caption, color = colors.fg3,
                maxLines = if (expanded) Int.MAX_VALUE else 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        }
        return
    }
    Box(
        modifier = modifier
            .fillMaxWidth()
            .animateContentSize(motion.spatial())
            .clip(RoundedCornerShape(LocalInterfaceStyle.current.groupRadius))
            .background(LocalRiffetSurfaces.current.card)
            .clickable(role = Role.Button) { expanded = !expanded }
            .padding(metrics.controlInset),
    ) {
        Text(
            text = prompt,
            style = typography.caption,
            color = colors.fg3,
            maxLines = if (expanded) Int.MAX_VALUE else 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
