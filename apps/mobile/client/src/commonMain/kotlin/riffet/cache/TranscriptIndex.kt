package riffet.cache

import riffet.contracts.WorkbenchEvent
import riffet.core.TimelineItem
import riffet.core.toolView

/** What a searchable message is: a prompt, a reply, or a tool call's title. */
@kotlinx.serialization.Serializable
enum class IndexRole { USER, ASSISTANT, TOOL }

/** One searchable message of a stored transcript; [sequence] is its first event, the scroll target. */
data class IndexEntry(val sequence: Long, val role: IndexRole, val text: String, val createdAt: String)

/** A message that matched, with the part of it worth showing and where the match sits in [snippet]. */
data class IndexHit(
    val sessionId: String,
    val sequence: Long,
    val role: IndexRole,
    val createdAt: String,
    val snippet: String,
    val highlights: List<IntRange>,
)

/**
 * Full-text search over every transcript on the device. It is kept by [TranscriptCache]: each save
 * replaces the session's entries, and an evicted transcript leaves the index with it.
 *
 * Calls block; the cache makes them on its IO context.
 */
interface TranscriptIndex {
    fun replace(sessionId: String, entries: List<IndexEntry>)
    fun forget(sessionId: String)
    fun clear()

    /** Every session that has entries; a stored transcript missing here is indexed on start. */
    fun sessions(): Set<String>

    /** The newest matches of every term of [query], at most [limit]. */
    fun search(query: String, limit: Int, sessionId: String? = null): List<IndexHit>

    /** Releases what the index holds open; it is not used again afterwards. */
    fun close()
}

/** This host's index; Android uses SQLite, iOS uses durable device files, desktop rebuilds in memory. */
expect fun createTranscriptIndex(serverUrl: String): TranscriptIndex

/**
 * Words for a full-text index that has no idea of Chinese: Latin letters and digits make words,
 * and a run of CJK characters becomes its overlapping pairs, so "本地缓存" is found by "缓存" and
 * by "地缓". A single CJK character stands alone.
 */
fun searchTokens(text: String): List<String> {
    val lower = text.lowercase()
    val tokens = ArrayList<String>()
    var index = 0
    while (index < lower.length) {
        val char = lower[index]
        when {
            isCjk(char) -> {
                var end = index
                while (end < lower.length && isCjk(lower[end])) end += 1
                if (end - index == 1) {
                    tokens += lower.substring(index, end)
                } else {
                    for (start in index until end - 1) tokens += lower.substring(start, start + 2)
                }
                index = end
            }
            char.isLetterOrDigit() -> {
                var end = index
                while (end < lower.length && lower[end].isLetterOrDigit() && !isCjk(lower[end])) end += 1
                tokens += lower.substring(index, end)
                index = end
            }
            else -> index += 1
        }
    }
    return tokens
}

/**
 * What the index stores for [text]: its [searchTokens], then the last character of every CJK run
 * on its own. A one-character query matches as a prefix, which finds "缓" in "缓存" but never "存";
 * the extra words go after the rest so no phrase can run into them.
 */
fun indexTokens(text: String): List<String> {
    val lower = text.lowercase()
    val ends = lower.indices
        .filter { index -> index > 0 && isCjk(lower[index]) && isCjk(lower[index - 1]) && (index + 1 == lower.length || !isCjk(lower[index + 1])) }
        .map { lower[it].toString() }
        .distinct()
    return searchTokens(text) + ends
}

/**
 * An FTS `MATCH` expression for [query]: each whitespace-separated term is a phrase of its tokens,
 * so its pieces must appear in order. A term's last Latin word, or a lone CJK character, matches as
 * a prefix, which is what typing expects. Null when nothing in [query] is searchable.
 */
fun ftsQuery(query: String): String? {
    val phrases = queryTerms(query).mapNotNull { term ->
        val tokens = searchTokens(term)
        if (tokens.isEmpty()) return@mapNotNull null
        val last = tokens.last()
        val prefix = last.none(::isCjk) || last.length == 1
        "\"" + (tokens.dropLast(1) + (last + if (prefix) "*" else "")).joinToString(" ") + "\""
    }
    return phrases.takeIf { it.isNotEmpty() }?.joinToString(" ")
}

fun queryTerms(query: String): List<String> = query.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }

/**
 * The part of [text] around the first match of a [query] term, on one line, with every term's
 * occurrences marked. Text that matched only through tokens (`load older` against `load_older`)
 * shows from its start.
 */
fun snippet(text: String, query: String, radius: Int = SNIPPET_RADIUS): Pair<String, List<IntRange>> {
    val flat = text.replace(Regex("\\s+"), " ").trim()
    // Matched case-insensitively on the text itself: `lowercase()` can change a string's length,
    // and positions found in the lowered copy would not fit the original.
    val terms = queryTerms(query)
    val first = terms.mapNotNull { term -> flat.indexOf(term, ignoreCase = true).takeIf { it >= 0 } }.minOrNull() ?: 0
    val start = (first - radius).coerceAtLeast(0)
    val end = (first + radius * 3).coerceAtMost(flat.length)
    val lead = if (start > 0) "…" else ""
    val window = lead + flat.substring(start, end) + if (end < flat.length) "…" else ""
    val highlights = terms.flatMap { term ->
        generateSequence(window.indexOf(term, ignoreCase = true).takeIf { it >= 0 }) { from ->
            window.indexOf(term, from + term.length, ignoreCase = true).takeIf { it >= 0 }
        }.map { it until it + term.length }.toList()
    }.sortedBy { it.first }
    return window to highlights
}

private fun isCjk(char: Char): Boolean =
    char in '\u4e00'..'\u9fff' || char in '\u3400'..'\u4dbf' || char in '\u3040'..'\u30ff' ||
        char in '\uac00'..'\ud7af' || char in '\uf900'..'\ufaff'

private const val SNIPPET_RADIUS = 24

/** An index in memory: hosts without SQLite, and tests. Matching is by substring of every term. */
class MemoryTranscriptIndex : TranscriptIndex {
    private val entries = mutableMapOf<String, List<IndexEntry>>()

    override fun replace(sessionId: String, entries: List<IndexEntry>) {
        if (entries.isEmpty()) this.entries.remove(sessionId) else this.entries[sessionId] = entries
    }

    override fun forget(sessionId: String) {
        entries.remove(sessionId)
    }

    override fun clear() = entries.clear()

    override fun close() = Unit

    override fun sessions(): Set<String> = entries.keys.toSet()

    override fun search(query: String, limit: Int, sessionId: String?): List<IndexHit> {
        val terms = queryTerms(query).map { it.lowercase() }
        if (terms.isEmpty()) return emptyList()
        return entries.filterKeys { sessionId == null || it == sessionId }.flatMap { (sessionId, list) ->
            list.filter { entry -> entry.text.lowercase().let { text -> terms.all { it in text } } }.map { sessionId to it }
        }
            .sortedByDescending { (_, entry) -> entry.createdAt }
            .take(limit)
            .map { (sessionId, entry) ->
                val (text, highlights) = snippet(entry.text, query)
                IndexHit(sessionId, entry.sequence, entry.role, entry.createdAt, text, highlights)
            }
    }
}
