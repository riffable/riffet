package riffet.ui.terminal

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import riffet.terminal.TextStyle
import riffet.ui.theme.ThemeEntry
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * The terminal's colours for one app theme. The rules are the web's
 * (`apps/web/src/lib/terminal-theme.ts`): the surface, ink and cursor come from `bg`/`fg`, the
 * selection is the accent at an alpha, and only the sixteen ANSI slots are curated per theme — so a
 * screen reads the same on both.
 */
@Immutable
class TerminalPalette(
    /** ARGB of ANSI colours 0–15. */
    val ansi: IntArray,
    val foreground: Int,
    val background: Int,
    val cursor: Int,
    val selection: Color,
) {
    companion object {
        /**
         * The palette for the half of [entry] the current mode shows. Custom themes carry their own
         * sixteen ANSI slots, so nothing here has to fall back to a table keyed by theme id.
         */
        fun from(entry: ThemeEntry, dark: Boolean, appearance: riffet.contracts.TerminalAppearance? = null): TerminalPalette {
            val colors = if (dark) entry.dark else entry.light
            val ansi = if (dark) entry.ansiDark else entry.ansiLight
            val foreground = appearance?.foregroundArgb ?: colors.fg.toArgb()
            return TerminalPalette(
                ansi = ansi.colors.map { it.toArgb() }.toIntArray(),
                foreground = foreground,
                background = appearance?.backgroundArgb ?: colors.bg.toArgb(),
                cursor = foreground,
                selection = colors.accent.copy(alpha = if (dark) 0.3f else 0.18f),
            )
        }
    }

    private val readableCache = HashMap<Long, Int>()

    /**
     * [foreground] adjusted until it reaches a minimum contrast against [background] (4.5:1, or 2.25:1
     * for faint text), as xterm.js's `minimumContrastRatio` does. Colours that already contrast
     * enough are untouched.
     */
    fun readable(foreground: Int, background: Int, faint: Boolean): Int {
        val key = (foreground.toLong() shl 32) or (background.toLong() and 0xFFFFFFFFL) xor (if (faint) 1L shl 63 else 0L)
        readableCache[key]?.let { return it }
        if (readableCache.size >= READABLE_CACHE_LIMIT) readableCache.clear()
        return ensureContrast(foreground, background, if (faint) 2.25 else 4.5).also { readableCache[key] = it }
    }

    /** ARGB of an engine colour: an index 0–255, one of the `COLOR_INDEX_*` slots, or 0xFFRRGGBB. */
    fun resolve(color: Int): Int = when {
        color and -0x1000000 == -0x1000000 -> color
        color < 16 -> ansi[color]
        color < 256 -> xterm256(color)
        color == TextStyle.COLOR_INDEX_BACKGROUND -> background
        color == TextStyle.COLOR_INDEX_CURSOR -> cursor
        else -> foreground
    }

    /** Explicit terminal backgrounds retain their protocol meaning in every app theme. */
    fun resolveBackground(color: Int): Int = resolve(color)

}

private fun channelLuminance(channel: Int): Double {
    val c = channel / 255.0
    return if (c <= 0.03928) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
}

/** WCAG relative luminance. */
private fun luminance(argb: Int): Double =
    0.2126 * channelLuminance(argb shr 16 and 0xFF) + 0.7152 * channelLuminance(argb shr 8 and 0xFF) + 0.0722 * channelLuminance(argb and 0xFF)

private fun contrast(a: Int, b: Int): Double {
    val la = luminance(a)
    val lb = luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
}

/** Find the nearest readable colour in both directions; mid-grey may require black. */
private fun ensureContrast(foreground: Int, background: Int, ratio: Double): Int {
    if (contrast(foreground, background) >= ratio) return foreground
    fun candidate(endpoint: Int): Int? {
        if (contrast(endpoint, background) < ratio) return null
        var low = 0.0
        var high = 1.0
        fun mix(t: Double): Int = rgb(
            (((foreground shr 16 and 255) * (1 - t)) + (endpoint shr 16 and 255) * t).toInt(),
            (((foreground shr 8 and 255) * (1 - t)) + (endpoint shr 8 and 255) * t).toInt(),
            (((foreground and 255) * (1 - t)) + (endpoint and 255) * t).toInt(),
        )
        repeat(24) {
            val middle = (low + high) / 2
            if (contrast(mix(middle), background) >= ratio) high = middle else low = middle
        }
        return mix(high)
    }
    fun distance(color: Int): Int = listOf(0, 8, 16).sumOf { shift ->
        val delta = (foreground shr shift and 255) - (color shr shift and 255)
        delta * delta
    }
    return listOfNotNull(candidate(rgb(0, 0, 0)), candidate(rgb(255, 255, 255))).minByOrNull(::distance) ?: foreground
}

private val CUBE_LEVELS = intArrayOf(0, 95, 135, 175, 215, 255)

private fun xterm256(index: Int): Int {
    if (index >= 232) {
        val gray = min(255, 8 + (index - 232) * 10)
        return rgb(gray, gray, gray)
    }
    val value = index - 16
    return rgb(CUBE_LEVELS[value / 36], CUBE_LEVELS[(value / 6) % 6], CUBE_LEVELS[value % 6])
}

private fun rgb(r: Int, g: Int, b: Int): Int = -0x1000000 or (r shl 16) or (g shl 8) or b

/** Truecolor output can produce unbounded colour pairs; the cache starts over past this many. */
private const val READABLE_CACHE_LIMIT = 4096
