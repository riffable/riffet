package riffet.ui.composer

import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.rememberTransition
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import org.jetbrains.compose.resources.stringResource
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.RiffetButton
import riffet.ui.design.RiffetProgressIndicator
import riffet.ui.design.RiffetTextButton
import riffet.ui.design.floatingShadow
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetMotion
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

// Hold to talk (docs/design/system/surfaces.md「语音输入（触屏）」): the composer's voice mode, the gesture on its bar, and the
// overlay a hold raises over the page.

/** How a hold on 按住说话 ended. */
internal enum class HoldEnd { Tap, Finish, Cancel }

/**
 * One hold, under way or waiting for its text. [anchor] is the composer card in window coordinates when it began; [emptyDraft] is
 * the draft as the press found it, so the bar stays where it was while sentences land in the draft. [docked]: the composer sits
 * at the bottom of the screen, and the dome covers it whole for the hold.
 */
internal data class HoldSession(val anchor: Rect, val emptyDraft: Boolean, val docked: Boolean, val cancelling: Boolean = false, val released: Boolean = false)

/** A composer whose top is in the lowest part of the window is docked there (a session); higher up it is part of the page. */
internal fun holdDocked(anchor: Rect, windowHeight: Float): Boolean = windowHeight - anchor.top <= windowHeight * 0.4f

private val BUBBLE_GAP = 12.dp
private val DOME_HEIGHT = 136.dp
/** How far the dome's middle rises above its sides. */
private val DOME_BOW = 24.dp

/** The dome: a shallow bow across the full width, its edge the line a finger crosses to slide away. */
private object DomeShape : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val bow = with(density) { DOME_BOW.toPx() }
        return Outline.Generic(Path().apply {
            moveTo(0f, bow)
            quadraticTo(size.width / 2, -bow, size.width, bow)
            lineTo(size.width, size.height)
            lineTo(0f, size.height)
            close()
        })
    }
}
private const val BUBBLE_BARS = 16

/**
 * Recording starts on press; a release within [DictationGesture.TAP_MS] is a tap, one past [DictationGesture.CANCEL_DISTANCE_DP]
 * above the press point cancels. A gesture the system takes away (a parent scroll, the window losing focus) finishes.
 */
internal fun Modifier.holdToTalk(enabled: Boolean, onPress: () -> Unit, onZone: (cancelling: Boolean) -> Unit, onEnd: (HoldEnd) -> Unit): Modifier =
    pointerInput(enabled) {
        if (!enabled) return@pointerInput
        val cancelPx = DictationGesture.CANCEL_DISTANCE_DP.dp.toPx()
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            down.consume()
            onPress()
            var cancelling = false
            var ended = false
            try {
                while (true) {
                    val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                    if (!change.pressed) {
                        change.consume()
                        ended = true
                        onEnd(when {
                            cancelling -> HoldEnd.Cancel
                            change.uptimeMillis - down.uptimeMillis < DictationGesture.TAP_MS -> HoldEnd.Tap
                            else -> HoldEnd.Finish
                        })
                        break
                    }
                    val past = down.position.y - change.position.y > cancelPx
                    if (past != cancelling) { cancelling = past; onZone(past) }
                    change.consume()
                }
            } finally {
                if (!ended) onEnd(if (cancelling) HoldEnd.Cancel else HoldEnd.Finish)
            }
        }
    }

/**
 * 按住 说话: filling the text area while the draft is empty ([tall]), as tall as the send button in the footer otherwise. While
 * the last sentence of a released hold is [finishing], a spinner stands in for the label.
 */
@Composable
internal fun HoldToTalkBar(
    pressed: Boolean, finishing: Boolean, enabled: Boolean, tall: Boolean,
    onPress: () -> Unit, onZone: (Boolean) -> Unit, onEnd: (HoldEnd) -> Unit,
    modifier: Modifier = Modifier,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val label = stringResource(Res.string.composer_hold_to_talk)
    // The gesture outlives recompositions; it calls whatever the composer passed last.
    val press by rememberUpdatedState(onPress)
    val zone by rememberUpdatedState(onZone)
    val end by rememberUpdatedState(onEnd)
    val onTap = { press(); end(HoldEnd.Tap) }
    Box(
        modifier
            .fillMaxWidth()
            .holdToTalk(enabled, onPress = { press() }, onZone = { zone(it) }, onEnd = { end(it) })
            .then(if (tall) Modifier else Modifier.height(metrics.sendButtonSize))
            .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
            .background(if (pressed) LocalRiffetSurfaces.current.press else colors.bgSubtle)
            // A screen reader cannot hold: activating the bar records hands-free, as a tap does.
            .semantics { onClick(label) { if (enabled) onTap(); enabled } },
        contentAlignment = Alignment.Center,
    ) {
        if (finishing) RiffetProgressIndicator(Modifier.size(16.dp), strokeWidth = 1.5.dp, color = colors.fg3)
        else Text(label, style = typography.body, color = if (enabled) colors.fg2 else LocalRiffetSurfaces.current.disabledContent)
    }
}

/** Puts the popup over the whole window, so [HoldToTalkOverlay] can place the bubble against the composer it came from. */
private object WholeWindow : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset = IntOffset.Zero
}

/**
 * The page under a hold: dimmed, the bubble above the composer with what is being said, and the arc under the finger. It
 * leaves as the finger lifts; a failure brings it back with retry and discard. The popup does not take focus, so the finger's
 * gesture stays with the bar that started it.
 */
@Composable
internal fun HoldToTalkOverlay(
    session: HoldSession?,
    state: DictationState,
    presence: MutableTransitionState<Boolean>,
    onRetry: () -> Unit,
    onDiscard: () -> Unit,
) {
    val motion = LocalRiffetMotion.current
    // The overlay outlives its hold by its exit: the last hold and what it last showed stay drawn while they fade, rather
    // than the bubble emptying the moment the text lands in the draft.
    val last = remember { HoldFrame() }
    if (session != null) {
        last.session = session
        if (state.phase != DictationPhase.Idle) last.state = state
    }
    val frame = last.session
    if (frame == null || (session == null && presence.isIdle && !presence.currentState)) return
    Popup(popupPositionProvider = WholeWindow, properties = PopupProperties(focusable = state.phase == DictationPhase.Failed, clippingEnabled = false)) {
        // The entrance waits for the popup's window to be laid out: it takes a frame or two to appear, and an animation
        // started with the composition would be over before anything is seen.
        var placed by remember { mutableStateOf(false) }
        SideEffect { if (placed || session == null) presence.targetState = session != null }
        val transition = rememberTransition(presence, label = "hold")
        // In fast and landing softly. Out on the standard curve, so it starts fading the moment the finger lifts: an accelerating
        // curve holds still for its first half, and the fade reads as a pause and then a cut.
        val progress by transition.animateFloat(
            transitionSpec = { if (targetState) tween(motion.SHORT, easing = motion.EmphasizedDecelerate) else motion.short() },
            label = "holdProgress",
        ) { if (it) 1f else 0f }
        Box(Modifier.fillMaxSize().onGloballyPositioned { placed = true }) {
            HoldOverlay(frame, if (session != null && state.phase != DictationPhase.Idle) state else last.state, session != null, { progress }, onRetry, onDiscard)
        }
    }
}

/** The last hold drawn; plain fields, since a change of hold recomposes the overlay anyway. */
private class HoldFrame { var session: HoldSession? = null; var state = DictationState() }

@Composable
private fun HoldOverlay(session: HoldSession, state: DictationState, active: Boolean, progress: () -> Float, onRetry: () -> Unit, onDiscard: () -> Unit) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val surfaces = LocalRiffetSurfaces.current
    val motion = LocalRiffetMotion.current
    val density = LocalDensity.current
    val failed = state.phase == DictationPhase.Failed
    run {
        // The dark themes' scrim is twice the light one, as the web's dialogs: on a near-black page a light dim reads as none.
        val scrim = if (surfaces.dark) surfaces.scrim.copy(alpha = (surfaces.scrim.alpha * 2).coerceAtMost(1f)) else surfaces.scrim
        BoxWithConstraints(Modifier.fillMaxSize()) {
            // The scrim and the bubble fade; nothing moves on the way in, since a phone that drops a rise's first frames shows
            // it as a jump.
            Box(Modifier.matchParentSize().graphicsLayer { alpha = progress() }.background(scrim))
            val start = with(density) { session.anchor.left.toDp() }
            val end = (maxWidth - with(density) { session.anchor.right.toDp() }).coerceAtLeast(0.dp)
            val top = with(density) { session.anchor.top.toDp() }
            // Docked, the dome covers the composer whole, its sides level with the composer's top edge, so the composer can
            // stay where it is underneath. In the page, the dome is its own strip at the bottom.
            val domeHeight = if (session.docked) maxOf(DOME_HEIGHT, maxHeight - top + DOME_BOW) else DOME_HEIGHT
            // A failure answers in the bubble: the dome and its hint step back, keeping their room so the bubble does not move.
            val dome by animateFloatAsState(if (failed) 0f else 1f, motion.short(), label = "holdDome")
            val bubble: @Composable () -> Unit = {
                Column(
                    Modifier.padding(start = start, end = end).graphicsLayer { alpha = progress() },
                    verticalArrangement = Arrangement.spacedBy(BUBBLE_GAP),
                ) {
                    Bubble(state, session.cancelling)
                    if (failed) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(BUBBLE_GAP, Alignment.End)) {
                        RiffetTextButton(onClick = onDiscard) { Text(stringResource(Res.string.composer_dictation_discard)) }
                        if (state.canRetry) RiffetButton(text = stringResource(Res.string.composer_dictation_retry), onClick = onRetry, primary = true)
                    }
                }
            }
            // The bubble always stands on the dome: above a composer in the page it would cover whatever sits there.
            Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(BUBBLE_GAP)) {
                bubble()
                // The hint is on the dome, under its crest: on the scrim it would sit over the page's own text.
                Column(
                    Modifier.fillMaxWidth().height(domeHeight)
                        // Docked it is opaque over the composer from its first frame, so the composer never shows through it;
                        // in the page it fades in with the scrim. Either way it fades out with it.
                        .graphicsLayer { alpha = dome * if (session.docked && active) 1f else progress() }
                        .floatingShadow(DomeShape, lifted = true).clip(DomeShape)
                        .background(colors.bgPopover).border(1.dp, surfaces.hairline, DomeShape)
                        .padding(top = DOME_BOW + 12.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        stringResource(if (session.cancelling) Res.string.composer_hold_release_cancel else Res.string.composer_hold_hint),
                        style = typography.bodySmall, color = if (session.cancelling) colors.danger else colors.fg2, textAlign = TextAlign.Center,
                    )
                    Icon(RiffetIcons.Mic, contentDescription = null, tint = if (session.cancelling) colors.fg3 else colors.fg,
                        modifier = Modifier.size(28.dp))
                }
            }
        }
    }
}

@Composable
private fun Bubble(state: DictationState, cancelling: Boolean) {
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val shape = RoundedCornerShape(LocalInterfaceStyle.current.groupRadius)
    val failed = state.phase == DictationPhase.Failed
    Column(
        Modifier.fillMaxWidth()
            .floatingShadow(shape, lifted = true)
            .clip(shape)
            .background(colors.bgPopover)
            .background(if (cancelling) colors.dangerSoft else Color.Transparent)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        val text = buildAnnotatedString {
            append(state.written)
            if (state.live.isNotEmpty()) {
                if (state.written.isNotEmpty() && needsSpace(state.written, state.live)) append(' ')
                withStyle(SpanStyle(color = if (cancelling) colors.danger else colors.fg3)) { append(state.live) }
            }
        }
        when {
            failed -> Text(state.failure.orEmpty(), style = typography.body, color = colors.danger, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive })
            text.isNotEmpty() -> Text(text, style = typography.body, color = if (cancelling) colors.danger else colors.fg, maxLines = 8,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            else -> {}
        }
        if (!failed) Row(Modifier.align(Alignment.End), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (state.phase == DictationPhase.Finishing) RiffetProgressIndicator(Modifier.size(16.dp), strokeWidth = 1.5.dp, color = colors.fg3)
            else Levels(state.levels, if (cancelling) colors.danger else colors.fg3)
            Text(dictationClock(state.elapsedMs), style = typography.caption,
                color = if (state.elapsedMs >= DictationGesture.WARN_AT_MS) colors.warning else colors.fg3)
        }
    }
}

/** The recent loudness as bars, on the web's scale: a quiet room is a dotted line, ordinary speech fills the height. */
@Composable
internal fun Levels(levels: List<Float>, ink: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.width(2.dp * BUBBLE_BARS + 2.dp * (BUBBLE_BARS - 1)).height(20.dp)) {
        val recent = levels.takeLast(BUBBLE_BARS)
        val step = 4.dp.toPx()
        val width = 2.dp.toPx()
        for (index in 0 until BUBBLE_BARS) {
            val level = recent.getOrNull(index - (BUBBLE_BARS - recent.size)) ?: 0f
            val height = (2.dp.toPx() + level * 80.dp.toPx()).coerceAtMost(size.height)
            drawRoundRect(ink, topLeft = Offset(index * step, (size.height - height) / 2), size = Size(width, height), cornerRadius = CornerRadius(width / 2))
        }
    }
}
