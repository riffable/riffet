package riffet.ui.timeline

/*
 * How an agent's Markdown is cut before it is parsed: standalone images and closed block formulas
 * become their own segments; everything else stays Markdown. Shared by every client renderer so a
 * half-streamed `$$` reads the same everywhere.
 */

/** A CommonMark fence delimiter: which character opened it and how many of them. */
data class Fence(val marker: Char, val length: Int)

/**
 * The fence [line] opens, or null when the line is not a fence opener.
 *
 * Fewer than three markers, more than three spaces of indent, or a backtick fence whose info
 * string contains another backtick (``` ```a```b``` ``` is a paragraph, not an unclosed fence) all
 * return null — the same rules the parser applies, restated here because the split has to agree
 * with the parse about which lines open a block.
 */
fun fenceOpener(line: String): Fence? {
    var indent = 0
    while (indent < line.length && indent < 3 && line[indent] == ' ') indent++
    if (indent >= line.length) return null
    val marker = line[indent]
    if (marker != '`' && marker != '~') return null
    var length = 0
    while (indent + length < line.length && line[indent + length] == marker) length++
    if (length < 3) return null
    if (marker == '`' && line.indexOf('`', indent + length) >= 0) return null
    return Fence(marker, length)
}

/** True when [line] closes a fence opened by [open]: same marker, at least as long, nothing else. */
fun closesFence(line: String, open: Fence): Boolean {
    val opener = fenceOpener(line) ?: return false
    return opener.marker == open.marker && opener.length >= open.length && line.trim().length == opener.length
}

sealed interface MarkdownSegment {
    data class Text(val text: String) : MarkdownSegment
    data class Image(val alt: String, val src: String) : MarkdownSegment
    /** Block TeX: a `math` fence or a `$$…$$` block. [tex] is the formula without its delimiters. */
    data class Math(val tex: String, val display: Boolean) : MarkdownSegment
    /** An explicit interactive HTML artifact reference, opened only when the reader asks. */
    data class Visualization(val path: String, val title: String?, val wide: Boolean) : MarkdownSegment
}

private val standaloneImage = Regex("""^\s*!\[([^\]]*)]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)\s*$""")

/**
 * Splits out images that stand on their own line — how agents show a screenshot — so they render
 * as real images at their own size. Lines inside a code fence are left alone.
 */
fun splitStandaloneImages(document: String): List<MarkdownSegment> {
    if (!document.contains("![")) return listOf(MarkdownSegment.Text(document))
    val segments = mutableListOf<MarkdownSegment>()
    val buffer = StringBuilder()
    var fence: Fence? = null
    fun flush() {
        if (buffer.isNotBlank()) segments += MarkdownSegment.Text(buffer.toString().trim('\n'))
        buffer.clear()
    }
    document.split('\n').forEach { line ->
        val open = fence
        if (open != null) {
            if (closesFence(line, open)) fence = null
            buffer.append(line).append('\n')
            return@forEach
        }
        fenceOpener(line)?.let { fence = it }
        val image = if (fence == null) standaloneImage.find(line) else null
        if (image != null) {
            flush()
            segments += MarkdownSegment.Image(alt = image.groupValues[1], src = image.groupValues[2])
        } else {
            buffer.append(line).append('\n')
        }
    }
    flush()
    return segments.ifEmpty { listOf(MarkdownSegment.Text(document)) }
}

/** The info string of a fence opener line, e.g. `math` in ```` ```math ````. */
private fun fenceInfo(line: String, fence: Fence): String {
    var index = 0
    while (index < line.length && line[index] == ' ') index++
    index += fence.length
    return line.substring(minOf(index, line.length)).trim()
}

private val mathFenceInfo = Regex("""^(?:math|latex|tex)$""", RegexOption.IGNORE_CASE)
private val singleLineDisplayMath = Regex("""^\s*\$\$(.+?)\$\$\s*$""")

/**
 * Splits out block TeX — a `math` fence or a `$$…$$` block — so it can be rendered by a real TeX
 * engine instead of shown as source.
 *
 * Only *closed* blocks become formulas: a half-written `$$` while an answer streams stays the text
 * the agent is typing, which is both honest and the only thing that can be rendered — the same
 * reason the web client parses math with the settled grammar only.
 *
 * Inline `$…$` in the middle of a sentence is deliberately left alone here: the Compose renderer has
 * no inline placeholder for a formula inside a paragraph, and turning one formula into its own block
 * would break the sentence around it.
 */
fun splitBlockMath(document: String): List<MarkdownSegment> {
    if (!document.contains('$') && !document.contains("```") && !document.contains("~~~")) {
        return listOf(MarkdownSegment.Text(document))
    }
    val segments = mutableListOf<MarkdownSegment>()
    val buffer = StringBuilder()
    // The raw lines of a math block being read, so an unclosed one can be handed back as text.
    val mathRaw = StringBuilder()
    val mathBody = StringBuilder()
    var mathFence: Fence? = null
    var displayOpen = false

    fun flush() {
        if (buffer.isNotBlank()) segments += MarkdownSegment.Text(buffer.toString().trim('\n'))
        buffer.clear()
    }

    fun closeMath(tex: String) {
        flush()
        segments += MarkdownSegment.Math(tex.trim(), true)
        mathRaw.clear()
        mathBody.clear()
    }

    fun abandonMath() {
        buffer.append(mathRaw)
        mathRaw.clear()
        mathBody.clear()
    }

    var open: Fence? = null
    document.split('\n').forEach { line ->
        mathFence?.let { fence ->
            mathRaw.append(line).append('\n')
            if (closesFence(line, fence)) {
                val tex = mathBody.toString()
                mathFence = null
                closeMath(tex)
            } else {
                mathBody.append(line).append('\n')
            }
            return@forEach
        }
        if (displayOpen) {
            mathRaw.append(line).append('\n')
            if (line.trimEnd().endsWith("$$")) {
                val body = line.trimEnd().removeSuffix("$$")
                if (body.isNotBlank()) mathBody.append(body)
                displayOpen = false
                closeMath(mathBody.toString())
            } else {
                mathBody.append(line).append('\n')
            }
            return@forEach
        }
        val code = open
        if (code != null) {
            if (closesFence(line, code)) open = null
            buffer.append(line).append('\n')
            return@forEach
        }
        val opener = fenceOpener(line)
        if (opener != null) {
            if (mathFenceInfo.matches(fenceInfo(line, opener))) {
                mathFence = opener
                mathRaw.append(line).append('\n')
                return@forEach
            }
            open = opener
            buffer.append(line).append('\n')
            return@forEach
        }
        val single = singleLineDisplayMath.find(line)
        if (single != null) {
            closeMath(single.groupValues[1])
            return@forEach
        }
        val trimmed = line.trimStart()
        if (trimmed.startsWith("$$")) {
            val rest = trimmed.removePrefix("$$")
            if (rest.trimEnd().endsWith("$$") && rest.trim().length > 2) {
                closeMath(rest.trimEnd().removeSuffix("$$"))
                return@forEach
            }
            displayOpen = true
            mathRaw.append(line).append('\n')
            if (rest.isNotBlank()) mathBody.append(rest).append('\n')
            return@forEach
        }
        buffer.append(line).append('\n')
    }
    // An unclosed block is text: the answer is still being written.
    if (mathFence != null || displayOpen) abandonMath()
    flush()
    return segments.ifEmpty { listOf(MarkdownSegment.Text(document)) }
}
