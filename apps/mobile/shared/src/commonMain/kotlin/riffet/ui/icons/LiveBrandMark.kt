package riffet.ui.icons

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.graphics.vector.toPath
import kotlin.math.floor
import kotlin.random.Random
import kotlinx.coroutines.launch
import riffet.ui.timeline.rememberReducedMotion

/*
 * The living Riffet mark, ported from `LiveBrandMark` in `apps/web/src/components/BrandMark.tsx` and
 * the `brand-*` keyframes in `apps/web/src/styles/index.css`. Same 24-unit geometry, pivots, timings
 * and easings. Decoration only: it reports nothing and carries no semantics.
 *
 * One node draws it. The clock is a state read only inside the draw lambda, so a frame redraws
 * this node and never recomposes or relayouts anything.
 */

/** The six loops. */
enum class LiveBrandStyle { Mane, Mood, Beat, Draw, Run, Gaze }

/**
 * The mark as a living logo. With a null [style] it plays a random loop, chosen on first
 * composition, and a tap swaps it for another with a short bounce; a given [style] is fixed and the
 * mark is not tappable. The modifier chain is the same either way. Reduced motion draws the static mark.
 */
@Composable
fun LiveBrandMark(
    modifier: Modifier = Modifier,
    fg: Color,
    accent: Color,
    style: LiveBrandStyle? = null,
    /** Plays the loop to its settled frame and stops there; for the welcome page's single drawing. */
    once: Boolean = false,
) {
    val reduced = rememberReducedMotion()
    var picked by remember { mutableStateOf(LiveBrandStyle.entries.random()) }
    val current = style ?: picked
    val clock = remember { mutableLongStateOf(0L) }
    val bounce = remember { Animatable(1f) }
    val scope = rememberCoroutineScope()
    val interaction = remember { MutableInteractionSource() }
    val scratch = remember { Scratch() }

    // A hidden page (a tab out of view, a page under another) stops the loop and resumes it from
    // the same frame; nothing redraws while nobody can see it.
    val running = riffet.ui.theme.visualWorkActive()
    LaunchedEffect(current) { clock.longValue = 0L }
    LaunchedEffect(current, reduced, running) {
        if (reduced) {
            clock.longValue = 0L
            return@LaunchedEffect
        }
        if (!running) return@LaunchedEffect
        var origin = -1L
        while (true) {
            withFrameNanos { now ->
                if (origin < 0L) origin = now - clock.longValue
                clock.longValue = if (once) minOf(now - origin, ONCE_SETTLED_NANOS) else now - origin
            }
            if (once && clock.longValue >= ONCE_SETTLED_NANOS) break
        }
    }

    val swap = {
        picked = LiveBrandStyle.entries.filter { it != picked }.random()
        if (!reduced) scope.launch {
            bounce.snapTo(0f)
            bounce.animateTo(1f, tween(BOUNCE_MILLIS, easing = LinearEasing))
        }
        Unit
    }

    Box(
        modifier
            .graphicsLayer {
                val p = bounce.value
                val first = p < BOUNCE_PEAK
                val f = if (first) BOUNCE_EASING.transform(p / BOUNCE_PEAK) else BOUNCE_EASING.transform((p - BOUNCE_PEAK) / (1f - BOUNCE_PEAK))
                val s = if (first) lerp(0.86f, 1.07f, f) else lerp(1.07f, 1f, f)
                scaleX = s
                scaleY = s
                rotationZ = if (first) lerp(-4f, 2f, f) else lerp(2f, 0f, f)
            }
            .clickable(interactionSource = interaction, indication = null, enabled = style == null, onClick = swap)
            .drawBehind {
                val spec = if (reduced) SPEC_STATIC else specOf(current)
                scratch.draw(this, spec, clock.longValue / 1_000_000_000f, fg, accent)
            },
    )
}

/** The Draw loop's held frame, just before it fades out (92% of 4.2 s). */
private const val ONCE_SETTLED_NANOS = 3_800_000_000L
private const val BOUNCE_MILLIS = 360
private const val BOUNCE_PEAK = 0.55f
private val BOUNCE_EASING = CubicBezierEasing(0.2f, 0.8f, 0.3f, 1f)

private fun lerp(a: Float, b: Float, f: Float) = a + (b - a) * f

// ---------------------------------------------------------------------------------------------
// Keyframes
// ---------------------------------------------------------------------------------------------

private val EASE = CubicBezierEasing(0.25f, 0.1f, 0.25f, 1f)
private val EASE_IN_OUT = CubicBezierEasing(0.42f, 0f, 0.58f, 1f)
private val EASE_OUT = CubicBezierEasing(0f, 0f, 0.58f, 1f)
private fun steps(count: Int) = Easing { f -> floor(f * count) / count }

/** One animated property: values at keyframe percentages, eased per interval as CSS does. */
private class Track(private val easing: Easing, vararg points: Pair<Float, Float>) {
    private val at = FloatArray(points.size) { points[it].first / 100f }
    private val value = FloatArray(points.size) { points[it].second }

    fun eval(f: Float): Float {
        if (f <= at[0]) return value[0]
        for (i in 1 until at.size) {
            if (f < at[i]) {
                val local = (f - at[i - 1]) / (at[i] - at[i - 1])
                return lerp(value[i - 1], value[i], easing.transform(local))
            }
        }
        return value[value.lastIndex]
    }
}

/** The transform one part wears: translate, then rotate, then scale, about the part's own pivot. */
private class Xf {
    var tx = 0f; var ty = 0f; var rot = 0f; var sx = 1f; var sy = 1f; var alpha = 1f
    fun reset() { tx = 0f; ty = 0f; rot = 0f; sx = 1f; sy = 1f; alpha = 1f }
}

/** One looping CSS animation on one part. A negative [delay] starts it part-way in. */
private class Anim(
    private val period: Float,
    private val delay: Float = 0f,
    private val tx: Track? = null,
    private val ty: Track? = null,
    private val rot: Track? = null,
    private val scale: Track? = null,
    private val sx: Track? = null,
    private val sy: Track? = null,
    private val alpha: Track? = null,
) {
    fun eval(out: Xf, seconds: Float) {
        out.reset()
        val local = seconds - delay
        if (local < 0f) return
        val f = (local % period) / period
        tx?.let { out.tx = it.eval(f) }
        ty?.let { out.ty = it.eval(f) }
        rot?.let { out.rot = it.eval(f) }
        scale?.let { out.sx = it.eval(f); out.sy = out.sx }
        sx?.let { out.sx = it.eval(f) }
        sy?.let { out.sy = it.eval(f) }
        alpha?.let { out.alpha = it.eval(f) }
    }
}

/** The outline's stroke trim, fill opacity and group opacity in `draw`. */
private class HeadAnim(val period: Float, val trim: Track, val fill: Track, val alpha: Track)

private class Spec(
    val whole: Anim? = null,
    val teeth: List<Anim?> = emptyList(),
    val ear: Anim? = null,
    val eye: Anim? = null,
    val speed: List<Anim> = emptyList(),
    val head: HeadAnim? = null,
    val showEar: Boolean = true,
)

private val SPEC_STATIC = Spec()

private fun specOf(style: LiveBrandStyle): Spec = when (style) {
    LiveBrandStyle.Mane -> SPEC_MANE
    LiveBrandStyle.Mood -> SPEC_MOOD
    LiveBrandStyle.Beat -> SPEC_BEAT
    LiveBrandStyle.Draw -> SPEC_DRAW
    LiveBrandStyle.Run -> SPEC_RUN
    LiveBrandStyle.Gaze -> SPEC_GAZE
}

private val SPEC_MANE = run {
    val gust = Track(CubicBezierEasing(0.3f, 0.7f, 0.3f, 1f), 0f to 0f, 18f to 11f, 36f to -3f, 55f to 0f, 100f to 0f)
    Spec(teeth = listOf(0f, 0.13f, 0.26f).map { Anim(1.8f, it, rot = gust) })
}

private val SPEC_MOOD = Spec(
    whole = Anim(5f, rot = Track(EASE_IN_OUT, 0f to 0f, 50f to 1.6f, 100f to 0f)),
    teeth = listOf(0f, -0.4f, -0.8f).map { Anim(5f, it, rot = Track(EASE_IN_OUT, 0f to 0f, 50f to 3f, 100f to 0f)) },
    ear = Anim(5f, rot = Track(EASE_OUT, 0f to 0f, 66f to 0f, 69f to -13f, 72f to -2f, 75f to -13f, 78f to 0f, 100f to 0f)),
    eye = Anim(5f, sy = Track(EASE, 0f to 1f, 44f to 1f, 47f to 0.08f, 50f to 1f, 100f to 1f)),
)

/** Three notes and a chord, held on low-frame steps; [on] is 1 while a tooth is struck. */
private fun note(vararg on: Pair<Float, Float>): Anim {
    val step = steps(12)
    return Anim(
        2f,
        rot = Track(step, *Array(on.size) { on[it].first to on[it].second * 7f }),
        scale = Track(step, *Array(on.size) { on[it].first to 1f + on[it].second * 0.34f }),
    )
}

private val SPEC_BEAT = Spec(
    whole = Anim(
        2f,
        rot = Track(
            steps(16), 0f to 2.4f, 12f to 0f, 25f to 2.4f, 37f to 0f, 50f to 2.4f, 62f to 0f, 75f to 2.4f, 90f to 0f, 100f to 2.4f,
        ),
    ),
    teeth = listOf(
        note(0f to 1f, 12.5f to 1f, 25f to 0f, 75f to 0f, 75.1f to 1f, 80f to 1f, 95f to 0f, 100f to 0f),
        note(0f to 0f, 25f to 0f, 25.1f to 1f, 37.5f to 1f, 50f to 0f, 75f to 0f, 75.1f to 1f, 80f to 1f, 95f to 0f, 100f to 0f),
        note(0f to 0f, 50f to 0f, 50.1f to 1f, 62.5f to 1f, 75f to 0f, 75.1f to 1f, 80f to 1f, 95f to 0f, 100f to 0f),
    ),
)

/** The outline in one stroke, filled, then the mane tooth by tooth and the eye. */
private fun pop(from: Float, to: Float) = Anim(
    4.2f,
    scale = Track(EASE_OUT, 0f to 0f, from to 0f, to - 4f to 1.15f, to to 1f, 92f to 1f, 100f to 1f),
    alpha = Track(EASE_OUT, 0f to 1f, 92f to 1f, 100f to 0f),
)

private val SPEC_DRAW = Spec(
    head = HeadAnim(
        4.2f,
        trim = Track(EASE_IN_OUT, 0f to 0f, 34f to 1f),
        fill = Track(EASE_IN_OUT, 0f to 0f, 34f to 0f, 44f to 1f),
        alpha = Track(EASE_IN_OUT, 0f to 1f, 92f to 1f, 100f to 0f),
    ),
    teeth = listOf(pop(44f, 56f), pop(50f, 62f), pop(56f, 68f)),
    eye = Anim(4.2f, scale = Track(EASE_OUT, 0f to 0f, 68f to 0f, 74f to 1.2f, 78f to 1f, 100f to 1f)),
    showEar = false,
)

private val SPEC_RUN = Spec(
    whole = Anim(
        0.46f,
        tx = Track(EASE_IN_OUT, 0f to 0f, 50f to 0.3f, 100f to 0f),
        ty = Track(EASE_IN_OUT, 0f to 0f, 50f to -0.9f, 100f to 0f),
        rot = Track(EASE_IN_OUT, 0f to -5f, 50f to -8f, 100f to -5f),
    ),
    teeth = listOf(0f, -0.08f, -0.16f).map {
        Anim(
            0.23f, it,
            rot = Track(EASE_IN_OUT, 0f to 14f, 50f to 22f, 100f to 14f),
            sx = Track(EASE_IN_OUT, 0f to 1.18f, 50f to 1.3f, 100f to 1.18f),
        )
    },
    speed = listOf(0f, -0.25f, -0.5f).map {
        Anim(0.7f, it, tx = Track(LinearEasing, 0f to 9f, 100f to -7f), alpha = Track(LinearEasing, 0f to 0f, 25f to 1f, 100f to 0f))
    },
)

/** No pointer on touch: the eye wanders by itself, as `brand-look` does on the web. */
private val SPEC_GAZE = run {
    val alert = CubicBezierEasing(0.3f, 1.5f, 0.5f, 1f)
    Spec(
        teeth = List(3) { Anim(5f, rot = Track(alert, 0f to 0f, 56f to 0f, 60f to 15f, 78f to 15f, 82f to 0f, 100f to 0f)) },
        ear = Anim(5f, rot = Track(alert, 0f to 0f, 56f to 0f, 60f to 9f, 78f to 9f, 82f to 0f, 100f to 0f)),
        eye = Anim(
            5f,
            tx = Track(CubicBezierEasing(0.4f, 0f, 0.2f, 1f), 0f to 0f, 20f to 0f, 26f to 0.55f, 52f to 0.55f, 58f to 0.55f, 80f to 0.55f, 86f to 0f, 100f to 0f),
            ty = Track(CubicBezierEasing(0.4f, 0f, 0.2f, 1f), 0f to 0f, 20f to 0f, 26f to 0.5f, 52f to 0.5f, 58f to -0.25f, 80f to -0.25f, 86f to 0f, 100f to 0f),
        ),
    )
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

private val LIVE_TEETH = listOf(
    Triple("M8.77 6.2Q6.51 6.56 5.15 8.55L7.76 8.17L9.3 9.2L9.7 6.4Z", 8.9f, 7.6f),
    Triple("M7.76 8.17Q5.43 9.17 4.26 11.65L6.94 10.68L8.7 11.8L9.1 8.4Z", 8.2f, 10.2f),
    Triple("M6.94 10.68Q4.72 12.24 3.82 15.1L6.42 13.42L8.2 14.6L8.6 11Z", 7.6f, 13f),
)
private const val LIVE_EAR = "M8.8 5.8L9.4 2.6L11.2 5.4L10.6 7.2L9.2 7.2Z"
private val SPEED_LINES = listOf(Triple(1f, 4.2f, 9f), Triple(0f, 4f, 13.5f), Triple(2f, 4.6f, 17.5f))

private val HEAD_PATH: Path by lazy { addPathNodes(BRAND_BODY).toPath() }
private val EAR_PATH: Path by lazy { addPathNodes(LIVE_EAR).toPath() }
private val TOOTH_PATHS: List<Path> by lazy { LIVE_TEETH.map { addPathNodes(it.first).toPath() } }

private val OUTLINE = Stroke(width = 1f, join = StrokeJoin.Round)
private val TOOTH_OUTLINE = Stroke(width = 0.6f, join = StrokeJoin.Round)
private val SPEED_STROKE = Stroke(width = 0.7f, cap = StrokeCap.Round)

/** Per-node scratch: reused every frame so drawing allocates nothing. */
private class Scratch {
    val whole = Xf()
    val part = Xf()
    val tooth = Xf()
    val hole = Path().apply { fillType = PathFillType.EvenOdd }
    val trimmed = Path()
    val measure = PathMeasure().apply { setPath(HEAD_PATH, false) }

    fun draw(scope: DrawScope, spec: Spec, seconds: Float, fg: Color, accent: Color) = with(scope) {
        val unit = size.minDimension / 24f
        withTransform({
            // The 24-unit grid, centred in the box, shifted to the mark's optical centre.
            translate((size.width - 24f * unit) / 2f, (size.height - 24f * unit) / 2f)
            scale(unit, unit, Offset.Zero)
            translate(-0.6f, 0.2f)
        }) {
            spec.speed.forEachIndexed { i, anim ->
                anim.eval(part, seconds)
                val (x0, x1, y) = SPEED_LINES[i]
                drawLine(
                    accent.copy(alpha = accent.alpha * part.alpha), Offset(x0 + part.tx, y), Offset(x1 + part.tx, y),
                    strokeWidth = SPEED_STROKE.width, cap = SPEED_STROKE.cap,
                )
            }
            spec.whole?.eval(whole, seconds) ?: whole.reset()
            moving(9f, 21f, whole) {
                for (i in TOOTH_PATHS.indices) {
                    val anim = spec.teeth.getOrNull(i)
                    anim?.eval(tooth, seconds) ?: tooth.reset()
                    if (tooth.sx <= 0.001f) continue
                    val (_, px, py) = LIVE_TEETH[i]
                    val color = accent.copy(alpha = accent.alpha * tooth.alpha)
                    moving(px, py, tooth) {
                        drawPath(TOOTH_PATHS[i], color, style = Fill)
                        drawPath(TOOTH_PATHS[i], color, style = TOOTH_OUTLINE)
                    }
                }
                drawHead(spec, seconds, fg)
            }
        }
    }

    private fun DrawScope.drawHead(spec: Spec, seconds: Float, fg: Color) {
        val head = spec.head
        var groupAlpha = 1f
        var fillAlpha = 1f
        var trim = 1f
        if (head != null) {
            val f = (seconds % head.period) / head.period
            trim = head.trim.eval(f)
            fillAlpha = head.fill.eval(f)
            groupAlpha = head.alpha.eval(f)
        }
        // The eye is a real hole in the fill: the head and the eye oval, filled even-odd.
        val eye = spec.eye
        eye?.eval(part, seconds) ?: part.reset()
        hole.reset()
        hole.addPath(HEAD_PATH)
        val rx = part.sx
        val ry = part.sy
        if (rx > 0.001f && ry > 0.001f) {
            hole.addOval(Rect(12.5f + part.tx - rx, 8.2f + part.ty - ry, 12.5f + part.tx + rx, 8.2f + part.ty + ry))
        }
        drawPath(hole, fg.copy(alpha = fg.alpha * fillAlpha * groupAlpha), style = Fill)
        val strokeColor = fg.copy(alpha = fg.alpha * groupAlpha)
        if (trim >= 1f) {
            drawPath(HEAD_PATH, strokeColor, style = OUTLINE)
        } else if (trim > 0f) {
            trimmed.reset()
            measure.getSegment(0f, measure.length * trim, trimmed, true)
            drawPath(trimmed, strokeColor, style = OUTLINE)
        }
        if (spec.showEar) {
            spec.ear?.eval(part, seconds) ?: part.reset()
            moving(10f, 5.9f, part) {
                drawPath(EAR_PATH, fg, style = Fill)
                drawPath(EAR_PATH, fg, style = OUTLINE)
            }
        }
    }

    /** [block] drawn as [xf] moves it about the pivot (px, py). */
    private inline fun DrawScope.moving(px: Float, py: Float, xf: Xf, block: DrawScope.() -> Unit) {
        withTransform({
            translate(px + xf.tx, py + xf.ty)
            rotate(xf.rot, Offset.Zero)
            scale(xf.sx, xf.sy, Offset.Zero)
            translate(-px, -py)
        }) { block() }
    }
}
