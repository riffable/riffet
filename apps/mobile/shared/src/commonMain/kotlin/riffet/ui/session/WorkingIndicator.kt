package riffet.ui.session

import riffet.i18n.L10n
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.theme.rememberVisualWorkVisibility
import riffet.ui.theme.visualWorkActive
import riffet.ui.theme.visualWorkVisibility
import androidx.compose.runtime.rememberUpdatedState

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.rememberResourceEnvironment
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.Run
import riffet.contracts.OutputRate
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.outputRateTag
import riffet.ui.timeline.formatElapsed
import riffet.ui.timeline.instantMillis
import riffet.ui.timeline.rememberTickingNow
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.session_working

/**
 * The bottom-of-transcript "正在处理" row: `NativeSession.tsx`'s `WorkingIndicator`.
 *
 * It is here rather than in the turn's own header because the two answer different questions. The
 * turn header (rendered by `riffet.ui.timeline.TurnProcessHeader`) says how long *this turn* has
 * been going; this row is the conversation-level "the CLI is working right now" signal, and it
 * carries the recent rolling output speed sampled by the server.
 *
 * The gate is the web's, character for character (`NativeSession.tsx:289`):
 *
 *     showWorking = busy && turnHasVisibleOutput(visibleTimeline)
 *
 * `turnHasVisibleOutput` is why a turn that has produced **nothing but thinking** stands this row
 * down: the turn's own block is already open and showing a spinner and `Working · 12s`, and a
 * second identical line under it is noise, not liveness. `core.turnHasVisibleOutput` is the single
 * implementation of that rule, and this call site is the mobile port of the web's only call site.
 *
 * The caller evaluates that gate and passes this row as the transcript's footer, so it sits under
 * the newest row and scrolls with it, as on the web.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun WorkingIndicator(
    run: Run?,
    outputRate: OutputRate?,
    stopping: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val motion = LocalRiffetMotion.current
    val metrics = LocalInterfaceStyle.current.metrics
    val visibility = rememberVisualWorkVisibility()
    val animate = visualWorkActive(visibility.visible, decorative = true)
    // A liveness pulse uses the long motion role; reduced motion leaves a steady status dot.
    val pulseDuration = motion.LONG * 3
    val pulse = if (!animate || pulseDuration == 0) rememberUpdatedState(1f) else {
        // motion-loop: liveness pulse; animate is false under reduced motion
        rememberInfiniteTransition(label = "working").animateFloat(
            initialValue = 0.35f, targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = pulseDuration, easing = motion.Standard),
                repeatMode = RepeatMode.Reverse,
            ), label = "pulse",
        )
    }
    // Tabular figures, so the timer does not shimmer sideways as it counts.
    val elapsedStyle = remember(typography) { typography.caption.copy(fontFeatureSettings = "tnum") }
    // Ticks only while the row is on screen; a settled transcript holds no timer.
    val now = rememberTickingNow(active = true, visible = visibility.visible)
    val started = instantMillis(run?.updatedAt)
    val seconds = if (started == null) 0L else ((now - started) / 1_000L).coerceAtLeast(0L)

    Row(
        modifier = modifier.visualWorkVisibility(visibility).fillMaxWidth().heightIn(min = metrics.smallIconSize + metrics.controlInset),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        rememberResourceEnvironment()
        Spacer(
            Modifier
                .size(8.dp)
                .graphicsLayer { alpha = pulse.value }
                .clip(CircleShape)
                .background(colors.accent),
        )
        Spacer(Modifier.width(metrics.controlInset / 2))
        Text(text = if (stopping) L10n.uiText("activity.state.stopping") else stringResource(Res.string.session_working), style = typography.label, color = colors.accent, maxLines = 1)
        if (!stopping && run != null && seconds > 0L) {
            Spacer(Modifier.width(metrics.controlInset / 2))
            Text(text = formatElapsed(seconds), style = elapsedStyle, color = colors.fg3, maxLines = 1)
        }
        val speed = outputRate?.takeUnless { stopping }?.let(::outputRateTag)
        if (speed != null) {
            Spacer(Modifier.width(metrics.controlInset / 2))
            TooltipBox(
                positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Above),
                tooltip = { PlainTooltip { Text(speed.description) } },
                state = rememberTooltipState(),
            ) {
                Text(text = speed.label, style = typography.caption, color = if (speed.estimated) colors.fg4 else colors.fg3, maxLines = 1)
            }
        }
    }
}
