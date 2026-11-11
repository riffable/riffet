package riffet.ui.design

import riffet.ui.theme.LocalRiffetMotion
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.IndicationNodeFactory
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.FocusInteraction
import androidx.compose.foundation.interaction.HoverInteraction
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.node.DelegatableNode
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.Modifier.Node
import kotlinx.coroutines.launch
import riffet.ui.theme.RiffetMotion

/**
 * The app's press feedback in place of Material's ripple: the pressed surface takes a soft
 * highlight at once and releases it with the current theme's medium motion. It covers the
 * clickable's bounds; a rounded surface clips it by putting `clip(shape)` before `clickable`.
 *
 * Installed as `LocalIndication` by `RiffetTheme`, so every `clickable`, `toggleable` and
 * `selectable` without an explicit indication gets it.
 */
internal class RiffetPressIndication(private val color: Color, private val focusColor: Color, private val motion: RiffetMotion, private val focusWidth: Dp) : IndicationNodeFactory {
    override fun create(interactionSource: InteractionSource): DelegatableNode = PressNode(interactionSource, color, focusColor, motion, focusWidth)
    override fun equals(other: Any?): Boolean = other is RiffetPressIndication && other.color == color && other.focusColor == focusColor && other.motion == motion && other.focusWidth == focusWidth
    override fun hashCode(): Int = 31 * (31 * color.hashCode() + focusColor.hashCode()) + motion.hashCode() + focusWidth.hashCode()
}

private class PressNode(private val source: InteractionSource, private val color: Color, private val focusColor: Color, private val motion: RiffetMotion, private val focusWidth: Dp) : Node(), DrawModifierNode {
    private val alpha = Animatable(0f)
    private var focused by mutableStateOf(false)

    override fun onAttach() {
        focused = false
        // A node reattached mid-fade must not come back lit with no release to follow.
        coroutineScope.launch { alpha.snapTo(0f) }
        coroutineScope.launch {
            val presses = mutableSetOf<PressInteraction.Press>()
            val focuses = mutableSetOf<FocusInteraction.Focus>()
            val hovers = mutableSetOf<HoverInteraction.Enter>()
            source.interactions.collect { interaction ->
                when (interaction) {
                    is PressInteraction.Press -> presses.add(interaction)
                    is PressInteraction.Release -> presses.remove(interaction.press)
                    is PressInteraction.Cancel -> presses.remove(interaction.press)
                    is FocusInteraction.Focus -> focuses.add(interaction)
                    is FocusInteraction.Unfocus -> focuses.remove(interaction.focus)
                    is HoverInteraction.Enter -> hovers.add(interaction)
                    is HoverInteraction.Exit -> hovers.remove(interaction.enter)
                }
                focused = focuses.isNotEmpty()
                launch {
                    val target = when {
                        presses.isNotEmpty() || focuses.isNotEmpty() -> 1f
                        hovers.isNotEmpty() -> 0.6f
                        else -> 0f
                    }
                    if (presses.isNotEmpty()) alpha.snapTo(target)
                    else alpha.animateTo(target, motion.medium())
                    invalidateDraw()
                }
                invalidateDraw()
            }
        }
    }

    override fun ContentDrawScope.draw() {
        drawContent()
        val a = alpha.value
        if (a > 0f) drawRect(color, alpha = a)
        if (focused) drawRect(focusColor, style = Stroke(focusWidth.toPx()))
    }
}

/**
 * A little give under the finger for buttons, chips and cards: the element dips to 97% while
 * pressed and springs back. Pass the same [interactionSource] the element's `clickable` uses.
 */
@Composable
internal fun Modifier.pressScale(interactionSource: InteractionSource, pressed: Float = 1f - (1f - LocalRiffetMotion.current.popScale) / 6f): Modifier {
    val motion = LocalRiffetMotion.current
    val down by interactionSource.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (down) pressed else 1f,
        animationSpec = if (down) tween((motion.SHORT * 0.8f).toInt(), easing = motion.Standard) else motion.spatial(),
        label = "press",
    )
    return graphicsLayer { scaleX = scale; scaleY = scale }
}
