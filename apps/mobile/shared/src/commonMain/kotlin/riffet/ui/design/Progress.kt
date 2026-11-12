package riffet.ui.design

import riffet.ui.theme.LocalRiffetMotion
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.progressSemantics
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ProgressIndicatorDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.unit.Dp
import riffet.ui.theme.rememberVisualWorkVisibility
import riffet.ui.theme.visualWorkActive
import riffet.ui.theme.visualWorkVisibility

/** Indeterminate progress rendered by the resolved progress backend. */
@Composable
internal fun RiffetProgressIndicator(
    modifier: Modifier = Modifier,
    color: Color = LocalRiffetSurfaces.current.primaryAction,
    strokeWidth: Dp = progressStrokeWidth(),
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val motion = LocalRiffetMotion.current
    val visibility = rememberVisualWorkVisibility()
    val visibleModifier = modifier.visualWorkVisibility(visibility)
    val animated = visualWorkActive(visibility.visible, decorative = true) && motion.LONG > 0
    if (LocalInterfaceStyle.current.components.progress == ComponentBackend.MATERIAL) {
        if (animated) CircularProgressIndicator(modifier = visibleModifier, color = color, strokeWidth = strokeWidth)
        else Box(visibleModifier.progressSemantics()) {
            // Keep Material's geometry without reporting a completed operation or running a loop.
            CircularProgressIndicator(progress = { 1f }, modifier = Modifier.clearAndSetSemantics {}, color = color, strokeWidth = strokeWidth)
        }
        return
    }

    // Cupertino advances the opacity trail by whole spokes instead of sweeping an arc.
    // motion-loop: activity spinner; animated is false under reduced motion
    val step = if (animated) rememberInfiniteTransition(label = "activity").animateFloat(
        initialValue = 0f,
        targetValue = 12f,
        animationSpec = infiniteRepeatable(tween(motion.LONG * 3, easing = LinearEasing)),
        label = "activityStep",
    ) else null
    Canvas(visibleModifier.progressSemantics().size(metrics.iconSize)) {
        val radius = size.minDimension / 2f
        // Keep twelve spokes distinct even when a caller supplies Material's thick default.
        val width = strokeWidth.toPx().coerceIn(0f, radius / 5f)
        val start = Offset(center.x, center.y - radius * 0.45f)
        val end = Offset(center.x, center.y - radius + width / 2f)
        val phase = (step?.value?.toInt() ?: 0) % 12
        repeat(12) { index ->
            val age = (phase - index + 12) % 12
            rotate(index * 30f) {
                drawLine(
                    color = color.copy(alpha = color.alpha * (1f - age / 12f).coerceAtLeast(0.1f)),
                    start = start,
                    end = end,
                    strokeWidth = width,
                    cap = StrokeCap.Round,
                )
            }
        }
    }
}

@Composable
private fun progressStrokeWidth(): Dp {
    val style = LocalInterfaceStyle.current
    return when (style.components.progress) {
        ComponentBackend.MATERIAL -> if (style.metrics.isOverridden("hairlineWidth"))
            style.metrics.hairlineWidth * 8 else ProgressIndicatorDefaults.CircularStrokeWidth
        ComponentBackend.MIUIX, ComponentBackend.SHARED -> style.metrics.hairlineWidth * 4
    }
}
