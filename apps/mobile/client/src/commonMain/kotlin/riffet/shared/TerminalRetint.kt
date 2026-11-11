package riffet.shared

import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

/*
 * A port of `apps/web/src/lib/terminal-palette.ts`: on a light page, the near-black panels a TUI
 * paints with explicit SGR backgrounds (the Cursor CLI's input box, a diff's slab) are rewritten into
 * pale panels just below the page, so the terminal does not show dark slabs on a white surface.
 * Only backgrounds are touched; a dark page passes through untouched.
 */

private const val SLAB_DROP = 0.28
private const val PANEL_DROP = 0.06
const val LIGHT_PAGE_MINIMUM = 0.55
private const val PANEL_SATURATION = 0.25
private const val MAX_CARRY = 64 * 1024
private const val ESC = '\u001b'

private val ANSI_16 = listOf(
    intArrayOf(0, 0, 0), intArrayOf(205, 0, 0), intArrayOf(0, 205, 0), intArrayOf(205, 205, 0),
    intArrayOf(0, 0, 238), intArrayOf(205, 0, 205), intArrayOf(0, 205, 205), intArrayOf(229, 229, 229),
    intArrayOf(127, 127, 127), intArrayOf(255, 0, 0), intArrayOf(0, 255, 0), intArrayOf(255, 255, 0),
    intArrayOf(92, 92, 255), intArrayOf(255, 0, 255), intArrayOf(0, 255, 255), intArrayOf(255, 255, 255),
)
private val CUBE_LEVELS = intArrayOf(0, 95, 135, 175, 215, 255)

fun color256ToRgb(index: Int): IntArray = when {
    index < 16 -> ANSI_16.getOrElse(index) { intArrayOf(0, 0, 0) }
    index < 232 -> (index - 16).let { intArrayOf(CUBE_LEVELS[it / 36], CUBE_LEVELS[(it / 6) % 6], CUBE_LEVELS[it % 6]) }
    else -> min(255, 8 + (index - 232) * 10).let { intArrayOf(it, it, it) }
}

private fun toHsl(r: Int, g: Int, b: Int): DoubleArray {
    val red = r / 255.0
    val green = g / 255.0
    val blue = b / 255.0
    val high = max(red, max(green, blue))
    val low = min(red, min(green, blue))
    val lightness = (high + low) / 2
    if (high == low) return doubleArrayOf(0.0, 0.0, lightness)
    val delta = high - low
    val saturation = if (lightness > 0.5) delta / (2 - high - low) else delta / (high + low)
    val hue = when (high) {
        red -> ((green - blue) / delta + (if (green < blue) 6 else 0)) / 6
        green -> ((blue - red) / delta + 2) / 6
        else -> ((red - green) / delta + 4) / 6
    }
    return doubleArrayOf(hue, saturation, lightness)
}

private fun fromHsl(hue: Double, saturation: Double, lightness: Double): IntArray {
    if (saturation == 0.0) {
        val value = (lightness * 255).roundToInt()
        return intArrayOf(value, value, value)
    }
    val second = if (lightness < 0.5) lightness * (1 + saturation) else lightness + saturation - lightness * saturation
    val first = 2 * lightness - second
    fun channel(offset: Double): Double {
        var t = offset
        if (t < 0) t += 1
        if (t > 1) t -= 1
        return when {
            t < 1.0 / 6 -> first + (second - first) * 6 * t
            t < 1.0 / 2 -> second
            t < 2.0 / 3 -> first + (second - first) * (2.0 / 3 - t) * 6
            else -> first
        }
    }
    return intArrayOf(
        (channel(hue + 1.0 / 3) * 255).roundToInt(),
        (channel(hue) * 255).roundToInt(),
        (channel(hue - 1.0 / 3) * 255).roundToInt(),
    )
}

/** The pale panel a too-dark background becomes on a page of [pageLightness], or null to keep it. */
fun lightenBackground(r: Int, g: Int, b: Int, pageLightness: Double): IntArray? {
    val (hue, saturation, lightness) = toHsl(r, g, b).let { Triple(it[0], it[1], it[2]) }
    if (lightness >= pageLightness - SLAB_DROP) return null
    return fromHsl(hue, min(saturation, PANEL_SATURATION), max(0.0, pageLightness - PANEL_DROP))
}

/** HSL lightness of a page colour given as 0–255 channels. */
fun pageLightness(r: Int, g: Int, b: Int): Double = toHsl(r, g, b)[2]

private fun isByte(value: String?): Boolean =
    value != null && value.isNotEmpty() && value.length <= 3 && value.all { it.isDigit() } && value.toInt() <= 255

private fun panel(rgb: IntArray) = "48;2;${rgb[0]};${rgb[1]};${rgb[2]}"

private fun remapColonField(field: String, page: Double): String {
    val parts = field.split(':')
    if (parts.first() != "48") return field
    val rest = parts.drop(1)
    if (rest.firstOrNull() == "2" && rest.size >= 4) {
        val channels = rest.takeLast(3).map { it.toIntOrNull() ?: return field }
        return lightenBackground(channels[0], channels[1], channels[2], page)?.let(::panel) ?: field
    }
    if (rest.firstOrNull() == "5" && rest.getOrNull(1)?.let { it.length in 1..3 && it.all(Char::isDigit) } == true) {
        val rgb = color256ToRgb(rest[1].toInt())
        return lightenBackground(rgb[0], rgb[1], rgb[2], page)?.let(::panel) ?: field
    }
    return field
}

private fun remapSgr(sequence: String, page: Double): String {
    val params = sequence.substring(2, sequence.length - 1)
    if (params.isEmpty()) return sequence
    val fields = params.split(';')
    val output = mutableListOf<String>()
    var index = 0
    while (index < fields.size) {
        val field = fields[index]
        if (':' in field) {
            output += remapColonField(field, page)
            index += 1
            continue
        }
        val code = if (field.isEmpty()) 0 else field.toIntOrNull()
        when {
            code == null -> output += field
            code == 48 && fields.getOrNull(index + 1) == "2" && isByte(fields.getOrNull(index + 2)) && isByte(fields.getOrNull(index + 3)) && isByte(fields.getOrNull(index + 4)) -> {
                val r = fields[index + 2].toInt()
                val g = fields[index + 3].toInt()
                val b = fields[index + 4].toInt()
                output += lightenBackground(r, g, b, page)?.let(::panel) ?: "48;2;$r;$g;$b"
                index += 4
            }
            code == 48 && fields.getOrNull(index + 1) == "5" && isByte(fields.getOrNull(index + 2)) -> {
                val rgb = color256ToRgb(fields[index + 2].toInt())
                output += lightenBackground(rgb[0], rgb[1], rgb[2], page)?.let(::panel) ?: "48;5;${fields[index + 2]}"
                index += 2
            }
            code in 40..47 || code in 100..107 -> {
                val rgb = ANSI_16[if (code >= 100) code - 100 + 8 else code - 40]
                output += lightenBackground(rgb[0], rgb[1], rgb[2], page)?.let(::panel) ?: field
            }
            else -> output += field
        }
        index += 1
    }
    return "$ESC[${output.joinToString(";")}m"
}

private fun findCsiEnd(input: String, from: Int): Int {
    for (index in from until input.length) if (input[index].code in 0x40..0x7e) return index
    return -1
}

private fun findStringEnd(input: String, from: Int, allowBell: Boolean): Int {
    for (index in from until input.length) {
        if (allowBell && input[index] == '\u0007') return index + 1
        if (input[index] == ESC && input.getOrNull(index + 1) == '\\') return index + 2
    }
    return -1
}

/**
 * Rewrites terminal output chunk by chunk. A sequence cut between two chunks is held back until it
 * is whole; [pageLightness] is read on every chunk, so a theme switch applies mid-session.
 */
class TerminalRetint(private val pageLightness: () -> Double) {
    private var carry = ""
    private val contrast = ConfiguredSgrRetinter()

    /**
     * Enables foreground-only contrast correction for a native terminal theme. Colors use ARGB;
     * ANSI contains the active palette's sixteen base colors. Calling this again updates the
     * palette used to resolve subsequent SGR state without resetting that state.
     */
    fun configure(foreground: Int, background: Int, ansi: IntArray) {
        contrast.configure(foreground, background, ansi)
    }

    fun reset() {
        carry = ""
        contrast.reset()
    }

    fun transform(data: String): String {
        if (contrast.isConfigured) return contrast.transform(data)
        return transformLegacy(data)
    }

    private fun transformLegacy(data: String): String {
        val page = pageLightness()
        if (page < LIGHT_PAGE_MINIMUM) {
            carry = ""
            return data
        }
        val input = carry + data
        carry = ""
        val output = StringBuilder()
        fun hold(text: String) {
            if (text.length > MAX_CARRY) output.append(text) else carry = text
        }
        var index = 0
        while (index < input.length) {
            val escape = input.indexOf(ESC, index)
            if (escape < 0) {
                output.append(input, index, input.length)
                break
            }
            output.append(input, index, escape)
            val kind = input.getOrNull(escape + 1)
            if (kind == null) {
                hold(input.substring(escape))
                break
            }
            if (kind == '[') {
                val end = findCsiEnd(input, escape + 2)
                if (end < 0) {
                    hold(input.substring(escape))
                    break
                }
                val sequence = input.substring(escape, end + 1)
                output.append(if (sequence.endsWith('m')) remapSgr(sequence, page) else sequence)
                index = end + 1
                continue
            }
            if (kind == ']' || kind == 'P' || kind == 'X' || kind == '^' || kind == '_') {
                val end = findStringEnd(input, escape + 2, kind == ']')
                if (end < 0) {
                    hold(input.substring(escape))
                    break
                }
                output.append(input, escape, end)
                index = end
                continue
            }
            output.append(input, escape, escape + 2)
            index = escape + 2
        }
        return output.toString()
    }
}

private data class Rgb(val red: Int, val green: Int, val blue: Int) {
    fun toSgr(): String = "${red};${green};${blue}"
}

private fun Int.toRgb(): Rgb = Rgb((this ushr 16) and 0xff, (this ushr 8) and 0xff, this and 0xff)
private fun IntArray.toRgb(): Rgb = Rgb(getOrElse(0) { 0 }, getOrElse(1) { 0 }, getOrElse(2) { 0 })

private enum class ColorKind { DEFAULT_FOREGROUND, DEFAULT_BACKGROUND, INDEXED, RGB }

private data class TerminalColor(
    val kind: ColorKind,
    val index: Int = 0,
    val rgb: Rgb? = null,
    val restoreSgr: String,
) {
    fun resolve(config: ContrastConfig, bold: Boolean = false): Rgb = when (kind) {
        ColorKind.DEFAULT_FOREGROUND -> config.foreground
        ColorKind.DEFAULT_BACKGROUND -> config.background
        ColorKind.INDEXED -> {
            val effectiveIndex = if (bold && index < 7) index + 8 else index
            config.ansi.getOrNull(effectiveIndex) ?: color256ToRgb(effectiveIndex).toRgb()
        }
        ColorKind.RGB -> rgb ?: Rgb(0, 0, 0)
    }

    companion object {
        fun defaultForeground() = TerminalColor(ColorKind.DEFAULT_FOREGROUND, restoreSgr = "39")
        fun defaultBackground() = TerminalColor(ColorKind.DEFAULT_BACKGROUND, restoreSgr = "49")
        fun indexed(index: Int, foreground: Boolean, sgr: String? = null) = TerminalColor(
            ColorKind.INDEXED,
            index = index,
            restoreSgr = sgr ?: if (foreground) "38;5;$index" else "48;5;$index",
        )
        fun rgb(rgb: Rgb, foreground: Boolean) = TerminalColor(
            ColorKind.RGB,
            rgb = rgb,
            restoreSgr = if (foreground) "38;2;${rgb.toSgr()}" else "48;2;${rgb.toSgr()}",
        )
    }
}

private data class ContrastConfig(val foreground: Rgb, val background: Rgb, val ansi: List<Rgb>)

private data class SgrStyle(
    var foreground: TerminalColor = TerminalColor.defaultForeground(),
    var background: TerminalColor = TerminalColor.defaultBackground(),
    var bold: Boolean = false,
    var dim: Boolean = false,
    var inverse: Boolean = false,
)

private enum class OverrideTarget { FOREGROUND, BACKGROUND }

private data class ContrastPatch(
    val target: OverrideTarget,
    val color: Rgb,
    val suppressDim: Boolean,
)

private data class ReadabilityKey(
    val foreground: Rgb,
    val background: Rgb,
    val preferred: Rgb,
    val dim: Boolean,
    val inverse: Boolean,
)

/** SGR-only contrast pass. It leaves cell backgrounds and non-SGR control strings untouched. */
private class ConfiguredSgrRetinter {
    private var config: ContrastConfig? = null
    private var carry = ""
    private var style = SgrStyle()
    private val savedStyles = arrayOfNulls<SgrStyle>(2)
    private var alternateScreen = false
    private var patch: ContrastPatch? = null
    private var styleChecked = false
    private val readableCache = HashMap<ReadabilityKey, ContrastPatch?>()

    val isConfigured: Boolean get() = config != null

    fun configure(foreground: Int, background: Int, ansi: IntArray) {
        require(ansi.size == 16) { "ANSI palette must contain exactly 16 colors" }
        config = ContrastConfig(foreground.toRgb(), background.toRgb(), ansi.map(Int::toRgb))
        styleChecked = false
        readableCache.clear()
    }

    fun reset() {
        carry = ""
        style = SgrStyle()
        savedStyles.fill(null)
        alternateScreen = false
        patch = null
        styleChecked = false
    }

    fun transform(data: String): String {
        val palette = config ?: return data
        val input = carry + data
        carry = ""
        val output = StringBuilder()
        var index = 0
        while (index < input.length) {
            val escape = input.indexOf(ESC, index)
            if (escape < 0) {
                appendText(input, index, input.length, output, palette)
                break
            }
            appendText(input, index, escape, output, palette)
            val kind = input.getOrNull(escape + 1)
            if (kind == null) {
                hold(input.substring(escape), output)
                break
            }
            if (kind == '[') {
                val end = findCsiEnd(input, escape + 2)
                if (end < 0) {
                    hold(input.substring(escape), output)
                    break
                }
                val sequence = input.substring(escape, end + 1)
                when (sequence.last()) {
                    'm' -> rewriteSgr(sequence, output, palette)
                    's' -> if (sequence == "${ESC}[s") save(sequence, output, palette) else output.append(sequence)
                    'u' -> if (sequence == "${ESC}[u") restore(sequence, output, palette) else output.append(sequence)
                    'h', 'l' -> privateModes(sequence, output, palette)
                    else -> output.append(sequence)
                }
                index = end + 1
                continue
            }
            when (kind) {
                '7' -> save(input.substring(escape, escape + 2), output, palette)
                '8' -> restore(input.substring(escape, escape + 2), output, palette)
                'c' -> resetTerminal(input.substring(escape, escape + 2), output, palette)
                ']', 'P', 'X', '^', '_' -> {
                    val end = findStringEnd(input, escape + 2, kind == ']')
                    if (end < 0) {
                        hold(input.substring(escape), output)
                        break
                    }
                    output.append(input, escape, end)
                    index = end
                    continue
                }
                else -> output.append(input, escape, escape + 2)
            }
            index = escape + 2
        }
        return output.toString()
    }

    private fun hold(text: String, output: StringBuilder) {
        if (text.length > MAX_CARRY) output.append(text) else carry = text
    }

    private fun appendText(input: String, start: Int, end: Int, output: StringBuilder, palette: ContrastConfig) {
        if (start >= end) return
        ensureStyle(output, palette)
        var index = start
        while (index < end) {
            val character = input[index]
            if (isDrawingGlyph(character) && patch != null) {
                clearPatch(output)
                output.append(character)
                applyPatch(output, palette)
            } else {
                output.append(character)
            }
            index++
        }
    }

    private fun isDrawingGlyph(character: Char): Boolean =
        character in '\uE0B0'..'\uE0BF' || character in '\u2500'..'\u257F' || character in '\u2580'..'\u259F'

    private fun ensureStyle(output: StringBuilder, palette: ContrastConfig) {
        if (styleChecked) return
        clearPatch(output)
        applyPatch(output, palette)
    }

    private fun save(sequence: String, output: StringBuilder, palette: ContrastConfig) {
        clearPatch(output)
        output.append(sequence)
        savedStyles[if (alternateScreen) 1 else 0] = style.copy()
        applyPatch(output, palette)
    }

    private fun restore(sequence: String, output: StringBuilder, palette: ContrastConfig) {
        clearPatch(output)
        output.append(sequence)
        style = savedStyles[if (alternateScreen) 1 else 0]?.copy() ?: SgrStyle()
        applyPatch(output, palette)
    }

    private fun resetTerminal(sequence: String, output: StringBuilder, palette: ContrastConfig) {
        clearPatch(output)
        output.append(sequence)
        style = SgrStyle()
        savedStyles.fill(null)
        alternateScreen = false
        styleChecked = false
        applyPatch(output, palette)
    }

    private fun privateModes(sequence: String, output: StringBuilder, palette: ContrastConfig) {
        val modes = sequence.removePrefix("${ESC}[?").dropLast(1).split(';').mapNotNull(String::toIntOrNull)
        if (!sequence.startsWith("${ESC}[?") || modes.none { it == 47 || it in 1047..1049 }) {
            output.append(sequence)
            return
        }
        // Save original attributes, as ESC 7/8 do. Primary and alternate buffers have
        // separate cursor slots, so a TUI's save cannot replace the shell's saved colors.
        clearPatch(output)
        val enabled = sequence.last() == 'h'
        for (mode in modes) {
            when (mode) {
                1048 -> {
                    val slot = if (alternateScreen) 1 else 0
                    if (enabled) savedStyles[slot] = style.copy()
                    else style = savedStyles[slot]?.copy() ?: SgrStyle()
                }
                1049 -> {
                    if (enabled) savedStyles[if (alternateScreen) 1 else 0] = style.copy()
                    alternateScreen = enabled
                    if (!enabled) style = savedStyles[0]?.copy() ?: SgrStyle()
                }
                47, 1047 -> alternateScreen = enabled
            }
        }
        output.append(sequence)
        applyPatch(output, palette)
    }

    private fun rewriteSgr(sequence: String, output: StringBuilder, palette: ContrastConfig) {
        val next = style.copy()
        if (!applySgr(next, sequence.substring(2, sequence.length - 1))) {
            output.append(sequence)
            return
        }
        clearPatch(output)
        output.append(sequence)
        style = next
        styleChecked = false
        applyPatch(output, palette)
    }

    private fun applySgr(target: SgrStyle, params: String): Boolean {
        val fields = params.split(';')
        var changed = false
        var index = 0
        while (index < fields.size) {
            val field = fields[index]
            if (':' in field) {
                val color = parseColonColor(field)
                if (color != null) {
                    if (color.first) target.foreground = color.second else target.background = color.second
                    changed = true
                }
                index++
                continue
            }
            val code = if (field.isEmpty()) 0 else field.toIntOrNull()
            when (code) {
                0 -> {
                    target.foreground = TerminalColor.defaultForeground()
                    target.background = TerminalColor.defaultBackground()
                    target.bold = false
                    target.dim = false
                    target.inverse = false
                    changed = true
                }
                1 -> { target.bold = true; changed = true }
                2 -> { target.dim = true; changed = true }
                7 -> { target.inverse = true; changed = true }
                22 -> { target.bold = false; target.dim = false; changed = true }
                27 -> { target.inverse = false; changed = true }
                39 -> { target.foreground = TerminalColor.defaultForeground(); changed = true }
                49 -> { target.background = TerminalColor.defaultBackground(); changed = true }
                in 30..37 -> {
                    target.foreground = TerminalColor.indexed(code!! - 30, foreground = true, sgr = code.toString())
                    changed = true
                }
                in 40..47 -> {
                    target.background = TerminalColor.indexed(code!! - 40, foreground = false, sgr = code.toString())
                    changed = true
                }
                in 90..97 -> {
                    target.foreground = TerminalColor.indexed(code!! - 90 + 8, foreground = true, sgr = code.toString())
                    changed = true
                }
                in 100..107 -> {
                    target.background = TerminalColor.indexed(code!! - 100 + 8, foreground = false, sgr = code.toString())
                    changed = true
                }
                38, 48 -> {
                    val foreground = code == 38
                    val mode = fields.getOrNull(index + 1)?.toIntOrNull()
                    when {
                        mode == 5 && fields.getOrNull(index + 2)?.toIntOrNull()?.let { it in 0..255 } == true -> {
                            val colorIndex = fields[index + 2].toInt()
                            val color = TerminalColor.indexed(colorIndex, foreground, "${if (foreground) 38 else 48};5;$colorIndex")
                            if (foreground) target.foreground = color else target.background = color
                            changed = true
                            index += 2
                        }
                        mode == 2 && listOf(2, 3, 4).all { fields.getOrNull(index + it)?.let(::isByte) == true } -> {
                            val rgb = Rgb(fields[index + 2].toInt(), fields[index + 3].toInt(), fields[index + 4].toInt())
                            val color = TerminalColor.rgb(rgb, foreground)
                            if (foreground) target.foreground = color else target.background = color
                            changed = true
                            index += 4
                        }
                    }
                }
            }
            index++
        }
        return changed
    }

    private fun parseColonColor(field: String): Pair<Boolean, TerminalColor>? {
        val parts = field.split(':')
        val foreground = when (parts.firstOrNull()) {
            "38" -> true
            "48" -> false
            else -> return null
        }
        val color = when (parts.getOrNull(1)) {
            "5" -> {
                val colorIndex = parts.getOrNull(2)?.toIntOrNull()?.takeIf { it in 0..255 } ?: return null
                TerminalColor.indexed(colorIndex, foreground, "${if (foreground) 38 else 48};5;$colorIndex")
            }
            "2" -> {
                val channels = parts.takeLast(3).map { it.toIntOrNull() ?: return null }
                if (channels.any { it !in 0..255 }) return null
                TerminalColor.rgb(Rgb(channels[0], channels[1], channels[2]), foreground)
            }
            else -> return null
        }
        return foreground to color
    }

    private fun applyPatch(output: StringBuilder, palette: ContrastConfig) {
        val effectiveForeground = if (style.inverse) {
            style.background.resolve(palette, bold = style.bold)
        } else {
            style.foreground.resolve(palette, bold = style.bold)
        }
        val effectiveBackground = if (style.inverse) {
            style.foreground.resolve(palette)
        } else {
            style.background.resolve(palette)
        }
        styleChecked = true
        val correction = readableCorrection(
            foreground = effectiveForeground,
            background = effectiveBackground,
            preferred = palette.foreground,
            dim = style.dim,
            inverse = style.inverse,
        )
        if (correction == null) {
            patch = null
            return
        }

        if (correction.suppressDim) {
            output.append("${ESC}[22m")
            if (style.bold) output.append("${ESC}[1m")
        }
        val code = if (correction.target == OverrideTarget.FOREGROUND) 38 else 48
        output.append("${ESC}[${code};2;${correction.color.toSgr()}m")
        patch = correction
    }

    private fun readableCorrection(
        foreground: Rgb,
        background: Rgb,
        preferred: Rgb,
        dim: Boolean,
        inverse: Boolean,
    ): ContrastPatch? {
        val key = ReadabilityKey(foreground, background, preferred, dim, inverse)
        if (readableCache.containsKey(key)) return readableCache[key]
        if (readableCache.size >= READABLE_CACHE_LIMIT) readableCache.clear()

        val targetRatio = if (dim) DIM_CONTRAST else TEXT_CONTRAST
        val renderedForeground = if (dim) blend(foreground, background) else foreground
        val correction = if (contrastRatio(renderedForeground, background) >= targetRatio) {
            null
        } else {
            var adjusted = closestContrastingColor(foreground, background, preferred, targetRatio, dim)
            var suppressDim = false
            if (adjusted == null && dim) {
                suppressDim = true
                adjusted = closestContrastingColor(foreground, background, preferred, targetRatio, dim = false)
            }
            adjusted?.let {
                ContrastPatch(if (inverse) OverrideTarget.BACKGROUND else OverrideTarget.FOREGROUND, it, suppressDim)
            }
        }
        readableCache[key] = correction
        return correction
    }

    private fun clearPatch(output: StringBuilder) {
        val active = patch ?: return
        if (active.suppressDim) {
            val modes = mutableListOf("22")
            if (style.bold) modes += "1"
            if (style.dim) modes += "2"
            output.append("${ESC}[${modes.joinToString(";")}m")
        }
        val color = if (active.target == OverrideTarget.FOREGROUND) style.foreground else style.background
        output.append("${ESC}[${color.restoreSgr}m")
        patch = null
    }

    private fun closestContrastingColor(
        source: Rgb,
        background: Rgb,
        preferred: Rgb,
        minimum: Double,
        dim: Boolean,
    ): Rgb? {
        val candidates = mutableListOf<Rgb>()
        fun visible(color: Rgb): Rgb = if (dim) blend(color, background) else color
        if (contrastRatio(visible(preferred), background) >= minimum) candidates += preferred

        val endpoints = listOf(Rgb(0, 0, 0), Rgb(255, 255, 255))
        for (endpoint in endpoints) {
            if (contrastRatio(visible(endpoint), background) < minimum) continue
            var low = 0.0
            var high = 1.0
            repeat(16) {
                val middle = (low + high) / 2
                val candidate = mix(source, endpoint, middle)
                if (contrastRatio(visible(candidate), background) >= minimum) high = middle else low = middle
            }
            candidates += mix(source, endpoint, high)
        }
        return candidates.minByOrNull { distanceSquared(source, it) }
    }

    private fun mix(from: Rgb, to: Rgb, amount: Double) = Rgb(
        (from.red + (to.red - from.red) * amount).roundToInt(),
        (from.green + (to.green - from.green) * amount).roundToInt(),
        (from.blue + (to.blue - from.blue) * amount).roundToInt(),
    )

    /** Mirrors SwiftTerm's SGR 2 renderer, which blends the foreground 50% toward the background. */
    private fun blend(foreground: Rgb, background: Rgb) = Rgb(
        (foreground.red + background.red) / 2,
        (foreground.green + background.green) / 2,
        (foreground.blue + background.blue) / 2,
    )

    private fun distanceSquared(a: Rgb, b: Rgb): Int =
        (a.red - b.red) * (a.red - b.red) + (a.green - b.green) * (a.green - b.green) + (a.blue - b.blue) * (a.blue - b.blue)

    private fun contrastRatio(first: Rgb, second: Rgb): Double {
        val a = luminance(first)
        val b = luminance(second)
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    private fun luminance(color: Rgb): Double {
        fun linear(channel: Int): Double {
            val value = channel / 255.0
            return if (value <= 0.04045) value / 12.92 else ((value + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue)
    }

    private fun isByte(value: String?): Boolean =
        value != null && value.isNotEmpty() && value.length <= 3 && value.all { it.isDigit() } && value.toInt() <= 255

    private companion object {
        const val TEXT_CONTRAST = 4.5
        // The renderer blends in floating point; our cached RGB colors are 8-bit. Leave
        // room for the half-channel rounding difference so the rendered result stays >= 2.25.
        const val DIM_CONTRAST = 2.28
        const val READABLE_CACHE_LIMIT = 4096
    }
}
