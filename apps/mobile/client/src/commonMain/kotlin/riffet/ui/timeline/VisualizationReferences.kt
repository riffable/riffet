package riffet.ui.timeline

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private const val visualizationStart = "\uE200visualize\uE202"
private const val visualizationEnd = '\uE201'
private val visualizationLine = Regex("^ {0,3}$visualizationStart(\\{.*\\})$visualizationEnd[ \\t\\r]*$")
private val pathScheme = Regex("^[a-zA-Z][a-zA-Z0-9+.-]*:")
private val containerMarker = Regex("^(?:[-+*]|\\d{1,9}[.)])[ \\t]+")

/**
 * Only the explicit standalone content-reference contract becomes an artifact. Raw HTML,
 * examples inside fences, malformed JSON and unfinished streaming references remain Markdown.
 * Paths name files on the conversation's server, so readers use the existing project-file API.
 */
fun splitVisualizationReferences(document: String): List<MarkdownSegment> {
    if (!document.contains(visualizationStart)) return listOf(MarkdownSegment.Text(document))
    val result = mutableListOf<MarkdownSegment>()
    var fence: Fence? = null
    var inlineBackticks: Int? = null
    var bufferedFrom = 0
    var offset = 0
    while (offset < document.length) {
        val newline = document.indexOf('\n', offset)
        val end = if (newline < 0) document.length else newline
        val line = document.substring(offset, end).removeSuffix("\r")
        val open = fence
        if (open != null) {
            if (closesFence(visualizationFenceLine(line), open)) fence = null
        } else {
            if (line.isBlank()) inlineBackticks = null
            fence = if (inlineBackticks == null) fenceOpener(visualizationFenceLine(line)) else null
            if (fence == null) {
                val reference = if (inlineBackticks == null) visualizationLine.matchEntire(line)?.groupValues?.get(1)?.let(::parseVisualization) else null
                if (reference != null) {
                    if (offset > bufferedFrom) result += MarkdownSegment.Text(document.substring(bufferedFrom, offset))
                    result += reference
                    bufferedFrom = if (newline < 0) end else end + 1
                } else {
                    var index = 0
                    while (index < line.length) {
                        if (line[index] != '`') { index++; continue }
                        var precedingSlashes = 0
                        var previous = index - 1
                        while (previous >= 0 && line[previous--] == '\\') precedingSlashes++
                        var runEnd = index + 1
                        while (runEnd < line.length && line[runEnd] == '`') runEnd++
                        if (precedingSlashes % 2 == 0) {
                            val length = runEnd - index
                            if (inlineBackticks == null) inlineBackticks = length
                            else if (inlineBackticks == length) inlineBackticks = null
                        }
                        index = runEnd
                    }
                }
            }
        }
        if (newline < 0) break
        offset = end + 1
    }
    if (bufferedFrom < document.length) result += MarkdownSegment.Text(document.substring(bufferedFrom))
    return result.ifEmpty { listOf(MarkdownSegment.Text(document)) }
}

/** Track fences in quote/list examples as well; reference lines themselves stay top-level only. */
private fun visualizationFenceLine(line: String): String {
    if (line.startsWith("    ") || line.startsWith('\t')) return line
    var rest = line
    repeat(12) {
        rest = rest.removePrefix("   ").removePrefix("  ").removePrefix(" ")
        if (rest.startsWith('>')) {
            rest = rest.drop(1).removePrefix(" ")
        } else {
            val marker = containerMarker.find(rest) ?: return rest
            rest = rest.drop(marker.value.length)
        }
    }
    return rest
}

private fun parseVisualization(payload: String): MarkdownSegment.Visualization? {
    if (payload.length > 16_384) return null
    val objectValue = runCatching { Json.parseToJsonElement(payload) as? JsonObject }.getOrNull() ?: return null
    fun string(name: String): String? = (objectValue[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
    val path = string("path")?.trim() ?: return null
    if (path.isEmpty() || path.length > 8192 || path.any { it.code < 32 } || path.startsWith("//") || pathScheme.containsMatchIn(path)) return null
    if (!path.lowercase().endsWith(".html") && !path.lowercase().endsWith(".htm")) return null
    val title = string("title")?.trim()?.takeIf { it.isNotEmpty() && it.length <= 250 }
    return MarkdownSegment.Visualization(path, title, string("mode") == "wide")
}
