package riffet.ui.timeline

/*
 * CommonMark lets `**` close only when the character inside it is not punctuation, or the one
 * outside it is whitespace or punctuation. Chinese puts no space after a full-width colon, so
 * `**结论：**正文` stays literal asterisks in every compliant parser. The web takes
 * `remark-cjk-friendly` (github.com/tats-u/markdown-cjk-friendly) and the phone relaxes the rule in
 * its own parser (`TranscriptMarkdownFlavour`). cmark-gfm on the Mac takes no extensions, so its
 * source gets a zero-width space between the punctuation and the run instead, which the parser
 * reads as a letter, and the text built from the parse drops [EMPHASIS_JOINER] again.
 */

const val EMPHASIS_JOINER = '\u200B'

/**
 * [document] with [EMPHASIS_JOINER] between a `*` or `~` run and the punctuation beside it, where
 * the other side is a letter and one side is CJK. That is exactly the case a compliant parser
 * refuses; a run it would already accept is left as it is. Code fences and code spans are untouched,
 * and so is `_`, whose intraword rule the joiner would break.
 */
fun cjkFriendlyEmphasis(document: String): String {
    if (document.none { it == '*' || it == '~' }) return document
    val out = StringBuilder(document.length + 16)
    var fence: Fence? = null
    document.split('\n').forEachIndexed { index, line ->
        if (index > 0) out.append('\n')
        val open = fence
        if (open != null) {
            if (closesFence(line, open)) fence = null
            out.append(line)
            return@forEachIndexed
        }
        val opener = fenceOpener(line)
        if (opener != null) {
            fence = opener
            out.append(line)
            return@forEachIndexed
        }
        joinLine(line, out)
    }
    return out.toString()
}

private fun joinLine(line: String, out: StringBuilder) {
    if (line.none { it == '*' || it == '~' }) {
        out.append(line)
        return
    }
    var i = 0
    while (i < line.length) {
        val c = line[i]
        when (c) {
            '\\' -> {
                out.append(line, i, minOf(i + 2, line.length))
                i += 2
            }
            '`' -> {
                val run = runLength(line, i)
                val close = closingBackticks(line, i + run, run)
                val end = if (close >= 0) close + run else i + run
                out.append(line, i, end)
                i = end
            }
            '*', '~' -> {
                val run = runLength(line, i)
                val before = codePointBefore(line, i)
                val after = codePointAt(line, i + run)
                val cjk = isCjk(before) || isCjk(after)
                if (cjk && isPunctuation(before) && isLetter(after)) out.append(EMPHASIS_JOINER)
                out.append(line, i, i + run)
                if (cjk && isLetter(before) && isPunctuation(after)) out.append(EMPHASIS_JOINER)
                i += run
            }
            else -> {
                out.append(c)
                i++
            }
        }
    }
}

private fun runLength(line: String, start: Int): Int {
    var end = start
    while (end < line.length && line[end] == line[start]) end++
    return end - start
}

/** Where a code span opened by [length] backticks closes on this line, or -1. */
private fun closingBackticks(line: String, from: Int, length: Int): Int {
    var i = from
    while (i < line.length) {
        if (line[i] != '`') {
            i++
            continue
        }
        val run = runLength(line, i)
        if (run == length) return i
        i += run
    }
    return -1
}

/** Line edges read as whitespace, as they do to the parser. */
private const val EDGE = ' '.code

private fun codePointBefore(line: String, index: Int): Int {
    if (index <= 0) return EDGE
    val low = line[index - 1]
    if (low.isLowSurrogate() && index >= 2 && line[index - 2].isHighSurrogate()) return supplementary(line[index - 2], low)
    return low.code
}

private fun codePointAt(line: String, index: Int): Int {
    if (index >= line.length) return EDGE
    val high = line[index]
    if (high.isHighSurrogate() && index + 1 < line.length && line[index + 1].isLowSurrogate()) return supplementary(high, line[index + 1])
    return high.code
}

private fun supplementary(high: Char, low: Char): Int = ((high.code - 0xD800) shl 10) + (low.code - 0xDC00) + 0x10000

private fun isWhitespace(point: Int): Boolean = point <= 0xFFFF && point.toChar().isWhitespace()

private fun isPunctuation(point: Int): Boolean {
    if (point > 0xFFFF) return false
    return when (point.toChar().category) {
        CharCategory.CONNECTOR_PUNCTUATION, CharCategory.DASH_PUNCTUATION, CharCategory.START_PUNCTUATION,
        CharCategory.END_PUNCTUATION, CharCategory.INITIAL_QUOTE_PUNCTUATION, CharCategory.FINAL_QUOTE_PUNCTUATION,
        CharCategory.OTHER_PUNCTUATION, CharCategory.MATH_SYMBOL, CharCategory.CURRENCY_SYMBOL,
        CharCategory.MODIFIER_SYMBOL, CharCategory.OTHER_SYMBOL -> true
        else -> false
    }
}

private fun isLetter(point: Int): Boolean = !isWhitespace(point) && !isPunctuation(point)

/** Han, kana, Hangul, Bopomofo, Yi and their punctuation and full-width forms. */
private fun isCjk(point: Int): Boolean = when (point) {
    in 0x1100..0x11FF, in 0x2E80..0x2FFF, in 0x3000..0x9FFF, in 0xA000..0xA4CF, in 0xA960..0xA97F,
    in 0xAC00..0xD7FF, in 0xF900..0xFAFF, in 0xFE10..0xFE1F, in 0xFE30..0xFE4F, in 0xFF00..0xFFEF,
    in 0x1B000..0x1B2FF, in 0x20000..0x3FFFF -> true
    else -> false
}
