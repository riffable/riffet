package riffet.ui.design

import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.theme.LocalRiffetTypography
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import riffet.ui.icons.AgentMark
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.rememberVisualWorkVisibility
import riffet.ui.theme.visualWorkActive
import riffet.ui.theme.visualWorkVisibility

/** What an [AgentAvatar] says about its conversation; settled conversations say nothing. */
internal enum class AvatarStatus { NONE, RUNNING, WAITING, FAILED }

/**
 * A conversation's mark: the agent's glyph on a disc tinted with the agent's own colour, with the
 * state riding on the disc rather than in a column of its own: a turning accent arc while it
 * works, a warning dot while it waits on the reader, a danger dot when it failed.
 * [ring] is the colour behind the avatar, so a corner dot is cut out of it cleanly.
 */
@Composable
internal fun AgentAvatar(
    backendId: String,
    tint: Color,
    status: AvatarStatus,
    ring: Color,
    modifier: Modifier = Modifier,
    size: Dp = LocalInterfaceStyle.current.metrics.controlHeight - LocalInterfaceStyle.current.metrics.hairlineWidth * 4,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val colors = LocalRiffetColors.current
    val disc = tint.copy(alpha = motion.floatingShadowOpacity).compositeOver(ring)
    val arc = colors.accent
    val visibility = rememberVisualWorkVisibility()
    val animate = visualWorkActive(visibility.visible, decorative = true)
    val turn = if (status == AvatarStatus.RUNNING && animate && motion.LONG > 0) {
        rememberInfiniteTransition(label = "avatar").animateFloat(0f, 360f, infiniteRepeatable(tween(motion.LONG * 3, easing = LinearEasing), RepeatMode.Restart), label = "turn")
    } else null
    Box(
        modifier.visualWorkVisibility(visibility)
            .size(size)
            .drawBehind {
                if (status == AvatarStatus.RUNNING) {
                    val stroke = metrics.hairlineWidth.toPx() * 2
                    val inset = stroke / 2
                    drawArc(
                        arc,
                        startAngle = (turn?.value ?: 0f) - 90f,
                        sweepAngle = 80f,
                        useCenter = false,
                        topLeft = Offset(inset, inset),
                        size = Size(this.size.width - stroke, this.size.height - stroke),
                        style = Stroke(stroke, cap = StrokeCap.Round),
                    )
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        val inner = if (status == AvatarStatus.RUNNING) size - minOf(metrics.controlInset / 2, size * 0.25f) else size
        Box(Modifier.size(inner).background(disc, CircleShape), contentAlignment = Alignment.Center) {
            AgentMark(backendId, size = size * 0.48f, tint = tint)
        }
        val dot = when (status) {
            AvatarStatus.WAITING -> colors.warning
            AvatarStatus.FAILED -> colors.danger
            else -> null
        }
        if (dot != null) {
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .offset(x = metrics.hairlineWidth * 2, y = metrics.hairlineWidth * 2)
                    .size(metrics.smallIconSize)
                    .background(ring, CircleShape)
                    .padding(metrics.hairlineWidth * 5)
                    .background(dot, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                if (status == AvatarStatus.FAILED) Text("!", color = Color.White, style = LocalRiffetTypography.current.buttonSmall)
            }
        }
    }
}
