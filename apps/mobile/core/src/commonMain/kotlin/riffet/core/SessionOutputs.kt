package riffet.core

import kotlinx.serialization.json.JsonPrimitive
import riffet.contracts.TimelineRow

/*
 * The files a conversation changed, for the session overview column. Prefer server-aggregated
 * Sync v3 `outputs` (`sessionOutputOf`); `sessionOutputs` remains only as a fallback for older
 * servers that do not send `outputs` frames.
 */

data class SessionOutput(
    val path: String,
    val added: Int,
    val removed: Int,
    val created: Boolean,
    val status: String? = null,
    val binary: Boolean = false,
    val outsideProject: Boolean = false,
    val hasSnapshotDiff: Boolean = false,
)

private val UNSETTLED_STATUSES = setOf("pending", "in_progress", "running", "queued", "cancelled", "rejected")

fun sessionOutputOf(change: TimelineRow.FileChange): SessionOutput = SessionOutput(
    path = change.path,
    added = change.added.toInt(),
    removed = change.removed.toInt(),
    created = change.created,
    status = change.status ?: if (change.created) "created" else "modified",
    binary = change.binary == true,
    outsideProject = change.outsideProject == true,
    hasSnapshotDiff = change.hasSnapshotDiff == true,
)

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
    val failed = view.status == "failed"
    val unsettled = view.status in UNSETTLED_STATUSES
    return view.contents.mapNotNull { content ->
        if (str(content["type"]) != "diff") return@mapNotNull null
        val observed = (content["observed"] as? JsonPrimitive)?.content == "true"
        if ((failed || unsettled) && !observed) return@mapNotNull null
        val path = (content["path"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@mapNotNull null
        val explicitStatus = (content["status"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it == "created" || it == "modified" || it == "deleted" }
        val binary = (content["binary"] as? JsonPrimitive)?.content == "true"
        val before = (content["oldText"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: ""
        val after = (content["newText"] as? JsonPrimitive)?.content ?: ""
        val addedCount = (content["added"] as? JsonPrimitive)?.content?.toIntOrNull()
        val removedCount = (content["removed"] as? JsonPrimitive)?.content?.toIntOrNull()
        val (added, removed) = when {
            binary -> 0 to 0
            addedCount != null && removedCount != null -> maxOf(0, addedCount) to maxOf(0, removedCount)
            else -> {
                val diff = lineDiff(before, after, 0)
                val a = diff?.added ?: if (after.isEmpty()) 0 else after.split("\n").size
                val r = diff?.removed ?: if (before.isEmpty()) 0 else before.split("\n").size
                a to r
            }
        }
        val isPartialHunk = content["lineOffset"] != null || content["newLineOffset"] != null
        val explicitCreated = (content["created"] as? JsonPrimitive)?.content?.let {
            when (it) {
                "true" -> true
                "false" -> false
                else -> null
            }
        }
        val created = when {
            explicitStatus != null -> explicitStatus == "created"
            explicitCreated != null -> explicitCreated
            else -> !isPartialHunk && before.isEmpty() && after.isNotEmpty()
        }
        val status = explicitStatus ?: if (created) "created" else "modified"
        SessionOutput(stripRoot(path, root), added, removed, created, status = status, binary = binary)
    }
}

/**
 * Fallback client-side aggregation when talking to an older server without Sync v3 `outputs`.
 * Edits to one path add up; a file last touched earlier moves to the front when touched again.
 */
fun sessionOutputs(timeline: List<TimelineItem>, root: String?, cache: SessionOutputsCache): List<SessionOutput> {
    val byPath = LinkedHashMap<String, SessionOutput>()
    for (item in timeline) {
        if (item !is TimelineItem.Tool) continue
        // A subagent's own rows sit in a lane of their own; the server sums what it changed onto the row that started it.
        val subagent = item.subagent?.changes.orEmpty().map {
            sessionOutputOf(it).copy(path = stripRoot(it.path, root))
        }
        for (edit in cache.edits(item, root) + subagent) {
            val current = byPath.remove(edit.path)
            if (current != null) {
                if ((current.status == "created" || current.created) && edit.status == "deleted") continue
                val nextStatus = when {
                    edit.status == "deleted" -> "deleted"
                    current.status == "created" || current.created -> "created"
                    else -> edit.status ?: current.status
                }
                byPath[edit.path] = current.copy(
                    added = current.added + edit.added,
                    removed = current.removed + edit.removed,
                    created = nextStatus == "created",
                    status = nextStatus,
                    binary = current.binary || edit.binary,
                )
            } else {
                byPath[edit.path] = edit
            }
        }
    }
    return byPath.values.reversed()
}
