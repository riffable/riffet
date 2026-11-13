package riffet.core

import kotlinx.serialization.json.JsonPrimitive

/*
 * The files a conversation's tools wrote, for the session overview column. Ported from
 * apps/web/src/app/session/sessionAsideModel.ts.
 */

data class SessionOutput(val path: String, val added: Int, val removed: Int, val created: Boolean)

/**
 * Each tool row's edits, kept while its event is unchanged: a streamed append then only costs the
 * rows that are new, not a line diff of every earlier edit. Not thread-safe; one per presenter.
 */
class SessionOutputsCache {
    private class Entry(val event: ProjectedEvent, val root: String?, val edits: List<SessionOutput>)

    private val entries = HashMap<String, Entry>()

    internal fun edits(item: TimelineItem.Tool, root: String?): List<SessionOutput> {
        val held = entries[item.key]
        if (held != null && held.root == root && (held.event === item.event || held.event == item.event)) return held.edits
        val edits = computeEdits(item, root)
        entries[item.key] = Entry(item.event, root, edits)
        return edits
    }

    fun clear() = entries.clear()
}

private fun computeEdits(item: TimelineItem.Tool, root: String?): List<SessionOutput> {
    val view = toolView(item.event.base, root)
    // A failed edit was not applied; what a failed command changed was seen on disk and stays.
    return view.contents.mapNotNull { content ->
        if (str(content["type"]) != "diff") return@mapNotNull null
        if (view.status == "failed" && (content["observed"] as? JsonPrimitive)?.content != "true") return@mapNotNull null
        val path = (content["path"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@mapNotNull null
        val before = (content["oldText"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: ""
        val after = (content["newText"] as? JsonPrimitive)?.content ?: ""
        val diff = lineDiff(before, after, 0)
        val added = diff?.added ?: if (after.isEmpty()) 0 else after.split("\n").size
        val removed = diff?.removed ?: if (before.isEmpty()) 0 else before.split("\n").size
        SessionOutput(stripRoot(path, root), added, removed, created = before.isEmpty())
    }
}

/**
 * Every file this conversation's tools wrote or its commands were seen to change, with the lines
 * each one gained and lost, newest first. Edits to one path add up; a file last touched earlier moves to the front when touched again.
 */
fun sessionOutputs(timeline: List<TimelineItem>, root: String?, cache: SessionOutputsCache): List<SessionOutput> {
    val byPath = LinkedHashMap<String, SessionOutput>()
    for (item in timeline) {
        if (item !is TimelineItem.Tool) continue
        // A subagent's own rows sit in a lane of their own; the server sums what it changed onto the row that started it.
        val subagent = item.subagent?.changes.orEmpty().map { SessionOutput(stripRoot(it.path, root), it.added.toInt(), it.removed.toInt(), it.created) }
        for (edit in cache.edits(item, root) + subagent) {
            val current = byPath.remove(edit.path)
            byPath[edit.path] = if (current != null) {
                SessionOutput(edit.path, current.added + edit.added, current.removed + edit.removed, current.created)
            } else {
                edit
            }
        }
    }
    return byPath.values.reversed()
}
