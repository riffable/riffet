package riffet.ui.composer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.stringResource
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.RiffetIconButton
import riffet.ui.design.RiffetTextButton
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

/**
 * The composer's footer while dictating (docs/VOICE.md §7), as the web's `DictationBar`: cancel where the tools were, the
 * recent loudness and the sentence still being recognized, the time, and done where send sits. A failure keeps the bar with
 * its reason and, when the recording can be sent again, retry.
 */
@Composable
internal fun DictationBar(state: DictationState, onFinish: () -> Unit, onCancel: () -> Unit, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val failed = state.phase == DictationPhase.Failed
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(metrics.controlInset * 2 / 3)) {
        RiffetIconButton(onClick = onCancel) {
            Icon(RiffetIcons.Close, stringResource(if (failed) Res.string.composer_dictation_discard else Res.string.composer_dictation_cancel),
                tint = colors.fg3, modifier = Modifier.size(metrics.iconSize))
        }
        if (failed) {
            Text(state.failure.orEmpty(), style = typography.caption, color = colors.danger, maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Assertive })
            if (state.canRetry) RiffetTextButton(onClick = onRetry) { Text(stringResource(Res.string.composer_dictation_retry)) }
        } else {
            Levels(state.levels, colors.fg3)
            // A sentence too long for the row loses its start: the newest words stay in view.
            Text(state.live, style = typography.bodySmall, color = colors.fg3, maxLines = 1, overflow = TextOverflow.StartEllipsis,
                modifier = Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite })
            Text(dictationClock(state.elapsedMs), style = typography.caption,
                color = if (state.elapsedMs >= DictationGesture.WARN_AT_MS) colors.warning else colors.fg3)
            Spacer(Modifier.width(0.dp))
            RoundAction(
                icon = RiffetIcons.Check,
                description = stringResource(Res.string.composer_dictation_done),
                enabled = state.phase == DictationPhase.Recording,
                busy = state.phase == DictationPhase.Finishing,
                background = LocalRiffetSurfaces.current.primaryAction,
                tint = LocalRiffetSurfaces.current.primaryActionContent,
                onClick = onFinish,
            )
        }
    }
}
