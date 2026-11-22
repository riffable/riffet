package riffet.ui.timeline

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield
import riffet.core.ReasoningChannel
import riffet.core.TimelineItem
import riffet.ui.state.traced

/**
 * Parses the markdown a transcript's rows will draw before the rows reach the screen.
 *
 * A row composed before its parse lands draws plain text, then the parsed blocks at another height:
 * in a list that follows its tail, a jump. So every presenter calls this on its background context
 * between grouping a frame and publishing it. The tail — what a page opens on and what a stream
 * grows — is parsed before the frame goes out; the rest of the loaded history follows on a worker,
 * newest first, so rows scrolled back to are ready as well. A row composed before either still
 * parses for itself (`MarkdownBody`).
 */
internal fun prepareTranscriptMarkdown(grouping: TimelineGrouping) {
    val sources = markdownSources(grouping.rows)
    if (sources.isEmpty()) return
    val tail = tailCount(sources)
    traced("riffet.markdown.prepare") {
        rememberParses(sources.take(tail).filter { cachedPreparedMarkdown(it) == null }.asReversed().map { prepareMarkdown(it) })
    }
    if (sources.size > tail) history.value = History(sources.subList(tail, minOf(sources.size, WARM_DOCS)))
}

/**
 * The documents [rows] draw on first composition, newest first, each exactly as its row asks the
 * cache for it (`PlainText`'s target): only blocks open by default, and a streaming text only up to
 * its settled cut.
 */
private fun markdownSources(rows: List<TimelineRow>): List<String> {
    val sources = ArrayList<String>()
    fun add(text: String, streaming: Boolean) {
        val normalised = normaliseNewlines(text)
        val target = if (streaming) splitStreamingMarkdown(normalised).settled else normalised
        if (target.isNotBlank()) sources += target
    }
    for (row in rows.asReversed()) {
        when (row) {
            is TimelineRow.Single -> (row.item as? TimelineItem.Assistant)?.let { add(it.text, streaming = row.footer == TurnFooter.HELD) }
            // `TimelineFolds.isOpen` before the reader touches it; the folded reasoning stays unparsed.
            is TimelineRow.Process -> if (row.running || row.issueCount > 0) {
                for (item in row.items.asReversed()) when {
                    item is TimelineItem.Thought && item.channel == ReasoningChannel.NARRATION -> add(item.text, streaming = row.turnActive)
                    item is TimelineItem.Assistant -> add(item.text, streaming = true)
                }
            }
            is TimelineRow.Trigger -> Unit
        }
        if (sources.size >= WARM_DOCS) break
    }
    return sources
}

/** At least the newest document, then as many as fit a couple of phone screens of prose. */
private fun tailCount(sources: List<String>): Int {
    var chars = 0
    var count = 0
    while (count < sources.size && count < TAIL_DOCS) {
        chars += sources[count].length
        count++
        if (chars >= TAIL_CHARS) break
    }
    return count
}

/** Identity, not content: comparing two histories by value would read every document per frame. */
private class History(val sources: List<String>)

private val history = MutableStateFlow(History(emptyList())).also { latest ->
    CoroutineScope(SupervisorJob() + Dispatchers.Default).launch {
        // A newer frame restarts the walk; finished documents are already cached, so it only skips them.
        latest.collectLatest { next ->
            for (source in next.sources) {
                if (cachedPreparedMarkdown(source) != null) continue
                rememberParses(prepareMarkdown(source))
                yield()
            }
        }
    }
}

private const val TAIL_DOCS = 24
private const val TAIL_CHARS = 12_000

/** Below the cache's 256, so one transcript's warmup never evicts its own tail. */
private const val WARM_DOCS = 192
