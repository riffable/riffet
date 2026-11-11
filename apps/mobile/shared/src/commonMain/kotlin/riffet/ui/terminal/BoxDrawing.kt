package riffet.ui.terminal

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import kotlin.math.max
import kotlin.math.roundToInt

/*
 * Box drawing (U+2500–U+257F) and block elements (U+2580–U+259F) drawn as geometry that fills the
 * cell exactly, instead of as font glyphs. A glyph is designed for one line height; at any other
 * height its vertical strokes stop short of the cell edge and an Ink panel's border turns into a
 * dotted line, which is how the web terminal looks today. xterm.js's WebGL renderer, kitty and
 * Ghostty do the same for the same reason.
 */

/** Light = 1, heavy = 2, double = 3; arms are up, right, down, left. */
private const val L = 1
private const val H = 2
private const val D = 3

/** U+2500…U+254B, then U+2550…U+256C, as URDL arm weights. Dashed lines are listed separately. */
private val LINE_ARMS: Map<Int, IntArray> = buildMap {
    val solid = listOf(
        0x2500 to intArrayOf(0, L, 0, L), 0x2501 to intArrayOf(0, H, 0, H),
        0x2502 to intArrayOf(L, 0, L, 0), 0x2503 to intArrayOf(H, 0, H, 0),
        0x250C to intArrayOf(0, L, L, 0), 0x250D to intArrayOf(0, H, L, 0), 0x250E to intArrayOf(0, L, H, 0), 0x250F to intArrayOf(0, H, H, 0),
        0x2510 to intArrayOf(0, 0, L, L), 0x2511 to intArrayOf(0, 0, L, H), 0x2512 to intArrayOf(0, 0, H, L), 0x2513 to intArrayOf(0, 0, H, H),
        0x2514 to intArrayOf(L, L, 0, 0), 0x2515 to intArrayOf(L, H, 0, 0), 0x2516 to intArrayOf(H, L, 0, 0), 0x2517 to intArrayOf(H, H, 0, 0),
        0x2518 to intArrayOf(L, 0, 0, L), 0x2519 to intArrayOf(L, 0, 0, H), 0x251A to intArrayOf(H, 0, 0, L), 0x251B to intArrayOf(H, 0, 0, H),
        0x251C to intArrayOf(L, L, L, 0), 0x251D to intArrayOf(L, H, L, 0), 0x251E to intArrayOf(H, L, L, 0), 0x251F to intArrayOf(L, L, H, 0),
        0x2520 to intArrayOf(H, L, H, 0), 0x2521 to intArrayOf(H, H, L, 0), 0x2522 to intArrayOf(L, H, H, 0), 0x2523 to intArrayOf(H, H, H, 0),
        0x2524 to intArrayOf(L, 0, L, L), 0x2525 to intArrayOf(L, 0, L, H), 0x2526 to intArrayOf(H, 0, L, L), 0x2527 to intArrayOf(L, 0, H, L),
        0x2528 to intArrayOf(H, 0, H, L), 0x2529 to intArrayOf(H, 0, L, H), 0x252A to intArrayOf(L, 0, H, H), 0x252B to intArrayOf(H, 0, H, H),
        0x252C to intArrayOf(0, L, L, L), 0x252D to intArrayOf(0, L, L, H), 0x252E to intArrayOf(0, H, L, L), 0x252F to intArrayOf(0, H, L, H),
        0x2530 to intArrayOf(0, L, H, L), 0x2531 to intArrayOf(0, L, H, H), 0x2532 to intArrayOf(0, H, H, L), 0x2533 to intArrayOf(0, H, H, H),
        0x2534 to intArrayOf(L, L, 0, L), 0x2535 to intArrayOf(L, L, 0, H), 0x2536 to intArrayOf(L, H, 0, L), 0x2537 to intArrayOf(L, H, 0, H),
        0x2538 to intArrayOf(H, L, 0, L), 0x2539 to intArrayOf(H, L, 0, H), 0x253A to intArrayOf(H, H, 0, L), 0x253B to intArrayOf(H, H, 0, H),
        0x253C to intArrayOf(L, L, L, L), 0x253D to intArrayOf(L, L, L, H), 0x253E to intArrayOf(L, H, L, L), 0x253F to intArrayOf(L, H, L, H),
        0x2540 to intArrayOf(H, L, L, L), 0x2541 to intArrayOf(L, L, H, L), 0x2542 to intArrayOf(H, L, H, L), 0x2543 to intArrayOf(H, L, L, H),
        0x2544 to intArrayOf(H, H, L, L), 0x2545 to intArrayOf(L, L, H, H), 0x2546 to intArrayOf(L, H, H, L), 0x2547 to intArrayOf(H, H, L, H),
        0x2548 to intArrayOf(L, H, H, H), 0x2549 to intArrayOf(H, L, H, H), 0x254A to intArrayOf(H, H, H, L), 0x254B to intArrayOf(H, H, H, H),
        0x2550 to intArrayOf(0, D, 0, D), 0x2551 to intArrayOf(D, 0, D, 0),
        0x2552 to intArrayOf(0, D, L, 0), 0x2553 to intArrayOf(0, L, D, 0), 0x2554 to intArrayOf(0, D, D, 0),
        0x2555 to intArrayOf(0, 0, L, D), 0x2556 to intArrayOf(0, 0, D, L), 0x2557 to intArrayOf(0, 0, D, D),
        0x2558 to intArrayOf(L, D, 0, 0), 0x2559 to intArrayOf(D, L, 0, 0), 0x255A to intArrayOf(D, D, 0, 0),
        0x255B to intArrayOf(L, 0, 0, D), 0x255C to intArrayOf(D, 0, 0, L), 0x255D to intArrayOf(D, 0, 0, D),
        0x255E to intArrayOf(L, D, L, 0), 0x255F to intArrayOf(D, L, D, 0), 0x2560 to intArrayOf(D, D, D, 0),
        0x2561 to intArrayOf(L, 0, L, D), 0x2562 to intArrayOf(D, 0, D, L), 0x2563 to intArrayOf(D, 0, D, D),
        0x2564 to intArrayOf(0, D, L, D), 0x2565 to intArrayOf(0, L, D, L), 0x2566 to intArrayOf(0, D, D, D),
        0x2567 to intArrayOf(L, D, 0, D), 0x2568 to intArrayOf(D, L, 0, L), 0x2569 to intArrayOf(D, D, 0, D),
        0x256A to intArrayOf(L, D, L, D), 0x256B to intArrayOf(D, L, D, L), 0x256C to intArrayOf(D, D, D, D),
        0x2574 to intArrayOf(0, 0, 0, L), 0x2575 to intArrayOf(L, 0, 0, 0), 0x2576 to intArrayOf(0, L, 0, 0), 0x2577 to intArrayOf(0, 0, L, 0),
        0x2578 to intArrayOf(0, 0, 0, H), 0x2579 to intArrayOf(H, 0, 0, 0), 0x257A to intArrayOf(0, H, 0, 0), 0x257B to intArrayOf(0, 0, H, 0),
        0x257C to intArrayOf(0, H, 0, L), 0x257D to intArrayOf(L, 0, H, 0), 0x257E to intArrayOf(0, L, 0, H), 0x257F to intArrayOf(H, 0, L, 0),
    )
    solid.forEach { (code, arms) -> put(code, arms) }
}

/** Dashed lines: code to (vertical, heavy, dash count). */
private val DASHES: Map<Int, Triple<Boolean, Boolean, Int>> = mapOf(
    0x2504 to Triple(false, false, 3), 0x2505 to Triple(false, true, 3), 0x2506 to Triple(true, false, 3), 0x2507 to Triple(true, true, 3),
    0x2508 to Triple(false, false, 4), 0x2509 to Triple(false, true, 4), 0x250A to Triple(true, false, 4), 0x250B to Triple(true, true, 4),
    0x254C to Triple(false, false, 2), 0x254D to Triple(false, true, 2), 0x254E to Triple(true, false, 2), 0x254F to Triple(true, true, 2),
)

/** True when [codePoint] is drawn by [drawBoxGlyph] rather than by the font. */
internal fun isBoxGlyph(codePoint: Int): Boolean =
    codePoint in 0x2500..0x259F && (codePoint in LINE_ARMS || codePoint in DASHES || codePoint in 0x256D..0x2573 || codePoint >= 0x2580)

/**
 * Draws [codePoint] into the cell at [left],[top] of [width]×[height] pixels. The caller has
 * checked [isBoxGlyph]. Coordinates are snapped to whole pixels so adjacent cells meet exactly.
 */
internal fun DrawScope.drawBoxGlyph(codePoint: Int, left: Float, top: Float, width: Float, height: Float, color: Color) {
    val light = max(1f, (width / 8f).roundToInt().toFloat())
    val heavy = light * 2
    // Centre lines on a pixel boundary pair so a 1px stroke is crisp and both halves meet.
    val cx = left + ((width - light) / 2f).roundToInt()
    val cy = top + ((height - light) / 2f).roundToInt()
    val right = left + width
    val bottom = top + height

    LINE_ARMS[codePoint]?.let { arms ->
        fun thickness(weight: Int) = if (weight == H) heavy else light
        fun hArm(x0: Float, x1: Float, weight: Int) {
            if (weight == 0) return
            if (weight == D) {
                drawRect(color, Offset(x0, cy - light), Size(x1 - x0, light))
                drawRect(color, Offset(x0, cy + light), Size(x1 - x0, light))
            } else {
                val t = thickness(weight)
                drawRect(color, Offset(x0, cy + (light - t) / 2f), Size(x1 - x0, t))
            }
        }
        fun vArm(y0: Float, y1: Float, weight: Int) {
            if (weight == 0) return
            if (weight == D) {
                drawRect(color, Offset(cx - light, y0), Size(light, y1 - y0))
                drawRect(color, Offset(cx + light, y0), Size(light, y1 - y0))
            } else {
                val t = thickness(weight)
                drawRect(color, Offset(cx + (light - t) / 2f, y0), Size(t, y1 - y0))
            }
        }
        val (up, rightArm, down, leftArm) = arms.toList()
        // Each arm runs from the cell edge to the far side of the centre line, so a corner is solid.
        vArm(top, cy + light, up)
        vArm(cy, bottom, down)
        hArm(left, cx + light, leftArm)
        hArm(cx, right, rightArm)
        return
    }

    DASHES[codePoint]?.let { (vertical, isHeavy, count) ->
        val t = if (isHeavy) heavy else light
        val span = if (vertical) height else width
        val segment = span / count
        val gap = max(1f, segment * 0.3f)
        repeat(count) { index ->
            val start = index * segment
            if (vertical) drawRect(color, Offset(cx + (light - t) / 2f, top + start), Size(t, segment - gap))
            else drawRect(color, Offset(left + start, cy + (light - t) / 2f), Size(segment - gap, t))
        }
        return
    }

    when (codePoint) {
        in 0x256D..0x2570 -> {
            // Rounded corners: a quarter arc between the two arms, meeting the straight lines exactly.
            val x = cx + light / 2f
            val y = cy + light / 2f
            val radius = minOf(width, height) / 2f
            val path = Path()
            when (codePoint) {
                0x256D -> { path.moveTo(x, bottom); path.lineTo(x, y + radius); path.quadraticTo(x, y, x + radius, y); path.lineTo(right, y) }
                0x256E -> { path.moveTo(x, bottom); path.lineTo(x, y + radius); path.quadraticTo(x, y, x - radius, y); path.lineTo(left, y) }
                0x256F -> { path.moveTo(x, top); path.lineTo(x, y - radius); path.quadraticTo(x, y, x - radius, y); path.lineTo(left, y) }
                else -> { path.moveTo(x, top); path.lineTo(x, y - radius); path.quadraticTo(x, y, x + radius, y); path.lineTo(right, y) }
            }
            drawPath(path, color, style = Stroke(width = light))
        }
        0x2571 -> drawLine(color, Offset(right, top), Offset(left, bottom), light)
        0x2572 -> drawLine(color, Offset(left, top), Offset(right, bottom), light)
        0x2573 -> {
            drawLine(color, Offset(right, top), Offset(left, bottom), light)
            drawLine(color, Offset(left, top), Offset(right, bottom), light)
        }
        else -> drawBlockElement(codePoint, left, top, width, height, color)
    }
}

private fun DrawScope.drawBlockElement(codePoint: Int, left: Float, top: Float, width: Float, height: Float, color: Color) {
    fun snap(value: Float) = value.roundToInt().toFloat()
    fun rect(x0: Float, y0: Float, x1: Float, y1: Float, tint: Color = color) {
        val l = snap(left + x0 * width)
        val t = snap(top + y0 * height)
        drawRect(tint, Offset(l, t), Size(snap(left + x1 * width) - l, snap(top + y1 * height) - t))
    }
    when (codePoint) {
        0x2580 -> rect(0f, 0f, 1f, 0.5f)
        in 0x2581..0x2588 -> rect(0f, 1f - (codePoint - 0x2580) / 8f, 1f, 1f)
        in 0x2589..0x258F -> rect(0f, 0f, (0x2590 - codePoint) / 8f, 1f)
        0x2590 -> rect(0.5f, 0f, 1f, 1f)
        0x2591 -> rect(0f, 0f, 1f, 1f, color.copy(alpha = color.alpha * 0.25f))
        0x2592 -> rect(0f, 0f, 1f, 1f, color.copy(alpha = color.alpha * 0.5f))
        0x2593 -> rect(0f, 0f, 1f, 1f, color.copy(alpha = color.alpha * 0.75f))
        0x2594 -> rect(0f, 0f, 1f, 1f / 8f)
        0x2595 -> rect(7f / 8f, 0f, 1f, 1f)
        else -> {
            // Quadrants U+2596…U+259F: bit 0 upper-left, 1 upper-right, 2 lower-left, 3 lower-right.
            val mask = when (codePoint) {
                0x2596 -> 0b0100; 0x2597 -> 0b1000; 0x2598 -> 0b0001; 0x2599 -> 0b1101
                0x259A -> 0b1001; 0x259B -> 0b0111; 0x259C -> 0b1011; 0x259D -> 0b0010
                0x259E -> 0b0110; 0x259F -> 0b1110; else -> 0
            }
            if (mask and 0b0001 != 0) rect(0f, 0f, 0.5f, 0.5f)
            if (mask and 0b0010 != 0) rect(0.5f, 0f, 1f, 0.5f)
            if (mask and 0b0100 != 0) rect(0f, 0.5f, 0.5f, 1f)
            if (mask and 0b1000 != 0) rect(0.5f, 0.5f, 1f, 1f)
        }
    }
}
