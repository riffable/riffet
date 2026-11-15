package riffet.ui.quickchat

import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
    riffet.ui.design.ChipRow(
        items = options.map { riffet.ui.design.ChipItem(it.id, it.label.ifEmpty { it.id }) },
        selected = value,
        onSelect = onSelect,
        modifier = modifier.fillMaxWidth(),
        contentPadding = PaddingValues(),
    )
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
