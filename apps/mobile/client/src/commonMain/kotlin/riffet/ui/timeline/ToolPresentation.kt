package riffet.ui.timeline

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import riffet.contracts.NativeActivity
import riffet.contracts.NativeActivityKind
import riffet.contracts.NativeActivityStatus
import riffet.contracts.NativeJob
import riffet.contracts.NativeJobStatus
import riffet.contracts.TurnOutlineV3
import riffet.core.LineDiff
import riffet.core.TimelineItem
import riffet.core.ToolLocation
import riffet.core.ToolRowPresentation
import riffet.core.activeToolStates
import riffet.core.describeJobRow
import riffet.core.describeToolRow
import riffet.core.isCommandTitle
import riffet.core.lineDiff
import riffet.i18n.L10n
import riffet.core.stripRoot
import riffet.core.toolDiffStats
import riffet.core.toolFoldedDetail
import riffet.core.toolKind
import riffet.core.toolView

/*
 * A tool call as a host renders it, with the raw JSON already read.
 *
 * The rules are the Compose `ToolRow`'s (and through it the web's `ToolRow` in Timeline.tsx): which
 * detail a row shows, when a pending call reads as unfinished, which content entries produce
 * anything, and which locations a diff header already covers. Hosts that cannot read `JsonObject`
 * comfortably (Swift) render from this instead of re-deriving the rules.
 */

/** An image a tool returned: a project file the server can read, or small inline bytes. */
data class ToolImage(
    val path: String?,
    val label: String?,
    val mimeType: String?,
    /** `data:<mime>;base64,…` when the bytes came inline. */
    val dataUrl: String?,
    /** The bytes were left out upstream for size; the row says so instead of drawing nothing. */
    val omitted: Boolean,
    /** The image's own file name: a store-backed picture has no readable path to name it by. */
    val name: String? = null,
    /** Encoded byte count, when the producer knew it. */
    val bytes: Long? = null,
    val width: Int? = null,
    val height: Int? = null,
) {
    /** What the picture is called where it is drawn. */
    val caption: String get() = name ?: label ?: L10n.uiText("tool.imageFromTool")

    /**
     * The one line a row shows when there is nothing to draw: which image was left out and how big it
     * is (`图片未在此展示 · wk-hero.png · 820×520 · 196 KB`), or the bare sentence when even its name
     * is unknown. The web's `ToolImage` builds the same line.
     */
    val placeholder: String get() {
        val pixels = if ((width ?: 0) > 0 && (height ?: 0) > 0) "${width}×$height" else null
        val parts = listOfNotNull(name ?: label, pixels, bytes?.takeIf { it > 0 }?.let(::imageSizeLabel))
        return if (parts.isEmpty()) {
            L10n.uiText("tool.imageOnlyHint")
        } else {
            (listOf(L10n.uiText("tool.imageNotShown")) + parts).joinToString(" · ")
        }
    }
}

/** `196 KB` / `9.7 KB`: the same rounding the web's `formatBytes` writes, so the hosts agree. */
fun imageSizeLabel(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    if (bytes < 10 * 1024) {
        val tenths = (bytes * 10 + 512) / 1024
        return "${tenths / 10}.${tenths % 10} KB"
    }
    if (bytes < 1024 * 1024) return "${(bytes + 512) / 1024} KB"
    val tenths = (bytes * 10 + 524288) / 1048576
    return "${tenths / 10}.${tenths % 10} MB"
}

/** One `content` entry of a tool call that produces something on screen. */
sealed interface ToolBlock {
    data class QuestionAnswer(val question: String?, val answers: List<String>, val options: List<String> = emptyList()) : ToolBlock

    data class Diff(
        val path: String?,
        val before: String,
        val after: String,
        /** Null when the inputs are too large to diff cheaply; the host shows both sides instead. */
        val diff: LineDiff?,
    ) : ToolBlock

    data class Terminal(val terminalId: String) : ToolBlock

    data class Text(val text: String) : ToolBlock

    data class Image(val image: ToolImage) : ToolBlock
}

data class ToolPresentation(
    val id: String,
    val title: String,
    val kind: String,
    /** The title is the command itself, so it is set in the code face. */
    val isCommand: Boolean,
    /** The trailing grey text: a subagent's type, or a file path the title does not already name. The command itself stays in the expanded body. */
    val detail: String?,
    val running: Boolean,
    val failed: Boolean,
    /** Pending, but nothing is running any more: it will never finish. */
    val dangling: Boolean,
    val added: Int,
    val removed: Int,
    val files: Int,
    val command: String?,
    /** Locations not already named by a diff header. */
    val locations: List<ToolLocation>,
    val blocks: List<ToolBlock>,
    /** Images shown under the row even while it is folded: a screenshot is the point of the call. */
    val images: List<ToolImage>,
    /** A Task row: a conversation of its own that a host opens as a page. */
    val opensSubagent: Boolean,
    /** Unified 4-slot presentation shared across Web, Mac, iOS, and Android. */
    val row: ToolRowPresentation,
) {
    val showsDiffStats: Boolean get() = !failed && !dangling && (added > 0 || removed > 0 || files > 1)
    val hasDetails: Boolean get() = command != null || locations.isNotEmpty() || blocks.isNotEmpty()
}

/** Unified 4-slot presentation for a background shell job. */
fun jobRowPresentation(job: NativeJob, root: String?): ToolRowPresentation =
    describeJobRow(job.title, job.command, root)

private fun text(element: JsonElement?): String? = (element as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun long(element: JsonElement?): Long? = (element as? JsonPrimitive)?.longOrNull

private fun int(element: JsonElement?): Int? = (element as? JsonPrimitive)?.intOrNull

/** One `content` image entry as a host draws it; hosts that read JSON themselves call this too. */
fun toolImage(content: JsonObject, root: String?): ToolImage? {
    val path = text(content["path"])
    val uri = text(content["uri"])
    val mimeType = text(content["mimeType"])
    val data = text(content["data"])
    val dataUrl = uri ?: if (data != null && mimeType?.startsWith("image/") == true) "data:$mimeType;base64,$data" else null
    val omitted = (content["omitted"] as? JsonPrimitive)?.booleanOrNull == true
    if (path == null && dataUrl == null && !omitted) return null
    return ToolImage(
        path = path,
        label = path?.let { stripRoot(it, root) },
        mimeType = mimeType,
        dataUrl = dataUrl,
        omitted = omitted,
        name = text(content["name"]),
        bytes = long(content["bytes"])?.takeIf { it > 0 },
        width = int(content["width"])?.takeIf { it > 0 },
        height = int(content["height"])?.takeIf { it > 0 },
    )
}

private fun toolBlock(item: JsonObject, root: String?): ToolBlock? = when (text(item["type"])) {
    "question_answer" -> ToolBlock.QuestionAnswer(
        question = text(item["question"]),
        answers = (item["answers"] as? JsonArray)?.mapNotNull { text(it) }.orEmpty(),
        options = (item["options"] as? JsonArray)?.mapNotNull { text(it) }.orEmpty(),
    )
    "diff" -> {
        val before = text(item["oldText"]).orEmpty()
        val after = text(item["newText"]).orEmpty()
        ToolBlock.Diff(
            path = text(item["path"])?.let { stripRoot(it, root) },
            before = before,
            after = after,
            diff = lineDiff(before, after, 3, long(item["lineOffset"]) ?: 0L, long(item["trailingLines"]) ?: 0L),
        )
    }
    "terminal" -> ToolBlock.Terminal(text(item["terminalId"]).orEmpty())
    else -> {
        val content = item["content"] as? JsonObject
        when (text(content?.get("type"))) {
            "text" -> text(content?.get("text"))?.let { ToolBlock.Text(it) }
            "image" -> content?.let { toolImage(it, root) }?.let { ToolBlock.Image(it) }
            else -> null
        }
    }
}

/**
 * The real background activity, when it still agrees with the child's current turn. The raw
 * attachment stays on the item for identity/de-duplication; it is never restated as a new launch.
 * A still-active task may span wakes, so its launch need not be newer than the child's prompt.
 */
fun currentToolActivity(item: TimelineItem.Tool): NativeActivity? {
    val activity = item.activity ?: return null
    val child = item.subagent ?: return activity
    val ended = instantMillis(activity.endedAt)
    val started = instantMillis(child.startedAt)
    if (ended != null && started != null && ended < started) return null
    val matches = when (child.status) {
        TurnOutlineV3.Status.RUNNING -> activity.status.active
        TurnOutlineV3.Status.COMPLETED -> activity.status == NativeActivityStatus.COMPLETED
        TurnOutlineV3.Status.FAILED -> activity.status == NativeActivityStatus.FAILED
        TurnOutlineV3.Status.CANCELLED, TurnOutlineV3.Status.INTERRUPTED -> activity.status == NativeActivityStatus.STOPPED
        // An unknown outcome still belongs to this turn; dropping the activity would hide the unfinished call.
        TurnOutlineV3.Status.OUTCOME_UNKNOWN, TurnOutlineV3.Status.UNKNOWN, null -> true
    }
    return activity.takeIf { matches }
}

/**
 * The web's `toolItemLiveness`: a call still reported active is unfinished once nothing can finish
 * it ([stale]), and one whose state never arrived is unfinished outright.
 */
fun toolItemLiveness(item: TimelineItem.Tool, stale: Boolean): ToolLiveness {
    val job = item.job
    val activity = currentToolActivity(item)
    val status = job?.status?.wire ?: activity?.status?.wire ?: text(item.event.data["status"]) ?: text(item.event.data["state"])
    val reportedActive = status != null && (status == "stopping" || status in activeToolStates)
    val active = if (job != null) job.status == NativeJobStatus.RUNNING else reportedActive && (activity != null || !stale)
    return ToolLiveness(active = active, incomplete = status == "unknown" || (reportedActive && !active))
}

data class ToolLiveness(val active: Boolean, val incomplete: Boolean)

/**
 * [item] as a host renders it. [stale] is true when nothing in the session is running any more, so
 * a call still marked pending is reported as unfinished rather than spinning forever.
 */
fun toolPresentation(item: TimelineItem.Tool, root: String?, stale: Boolean): ToolPresentation {
    val view = toolView(item.event.base, root)
    val stats = toolDiffStats(view)
    val child = item.subagent
    val activity = currentToolActivity(item)
    // A child with no turn markers yet has no status: only its running flag is known, and a stopped
    // one falls through to the activity and then the call itself, which may say it failed.
    val liveStatus = child?.status?.takeUnless { it.wire.isEmpty() }?.wire
        ?: child?.takeIf { it.running }?.let { "running" }
        ?: activity?.status?.takeUnless { it.wire == "unknown" }?.wire
    val status = liveStatus ?: view.status
    val active = status in activeToolStates || status == "running" || status == "stopping"
    val running = active && (liveStatus != null || !stale)
    val failed = status == "failed" || (activity != null && activityFailed(activity))
    val isCommand = isCommandTitle(view.title, view.command)
    val subagent = item.event.data["subagent"] as? JsonObject
    fun meaningful(value: String?): String? = value?.trim()?.takeIf { it.isNotEmpty() }?.takeUnless {
        it.lowercase().filterNot { char -> char == '-' || char == '_' || char.isWhitespace() } in setOf("generalpurpose", "subagent")
    }
    val subagentType = meaningful(child?.subagentType ?: text(subagent?.get("type")))
    // The row and the subagent list must name a child the same way: description, then the
    // streamed title, then the first line of the prompt it was given, then its type.
    val title = if (view.kind == "agent") meaningful(text(subagent?.get("description")))
        ?: meaningful(child?.title)
        ?: meaningful(text(subagent?.get("prompt"))?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim())
        ?: meaningful(subagentType)
        ?: meaningful(view.title) ?: L10n.uiText("subagent.title") else view.title
    // The command stays in the expanded body, parsed or not: a folded row reads by its title, and
    // a truncated command beside it is neither readable nor needed to tell rows apart.
    val detail = when {
        view.kind == "agent" -> subagentType?.takeIf { it != title }
        isCommand -> toolFoldedDetail(view, root)
        else -> toolFoldedDetail(view, root)
    }
    val diffPaths = view.contents
        .filter { text(it["type"]) == "diff" }
        .mapNotNull { entry -> text(entry["path"])?.let { stripRoot(it, root) } }
        .toSet()
    val images = if (failed) emptyList() else view.contents.mapNotNull { entry ->
        (entry["content"] as? JsonObject)?.takeIf { text(it["type"]) == "image" }?.let { toolImage(it, root) }
    }
    val row = if (activity?.kind == NativeActivityKind.BACKGROUND_TASK) {
        describeJobRow(
            title = if (isCommand) activity.title else title,
            command = view.command ?: activity.task?.command,
            root = root,
        )
    } else {
        describeToolRow(item.event.data, L10n.uiText("core.tool.call"), root)
    }
    return ToolPresentation(
        id = view.id,
        title = title,
        kind = view.kind,
        isCommand = isCommand,
        detail = detail,
        running = running,
        failed = failed,
        dangling = active && !running,
        added = stats?.added ?: 0,
        removed = stats?.removed ?: 0,
        files = stats?.files ?: 0,
        command = view.command,
        locations = view.locations.filterNot { it.line == null && it.path in diffPaths },
        blocks = view.contents.mapNotNull { toolBlock(it, root) },
        images = images,
        opensSubagent = view.kind == "agent",
        row = row,
    )
}

/** Delegations stand on their own inside the process, like reasoning, rather than joining tools. */
fun isToolRunItem(item: TimelineItem): Boolean = item is TimelineItem.Tool && toolKind(item.event.base) != "agent"

/** The process header's label at [nowMillis]: `Working` while live, `Processed · 1m 3s` once done, `Stopped · 1m 3s` once stopped. */
fun processHeaderLabel(row: TimelineRow.Process, nowMillis: Long): String {
    if (row.running) return "Working"
    val start = instantMillis(row.startedAt)
    val end = instantMillis(row.endedAt)
    val seconds = if (start == null) 0L else (((end ?: nowMillis) - start) / 1_000L).coerceAtLeast(0L)
    val done = if (row.stopped) "Stopped" else "Processed"
    return if (seconds > 0) "$done · ${formatElapsed(seconds)}" else done
}

data class ToolRunCount(val bucket: String, val count: Int)

data class ToolRunSummary(
    val counts: List<ToolRunCount>,
    val primaryIcon: String,
    val totalAdded: Int,
    val totalRemoved: Int,
) {
    /** The run's header, in the rows' own verbs: `Read 3 · Search 2` (web `toolRunSummary`). */
    val title: String get() = counts.joinToString(" · ") { "${toolRunVerb(it.bucket)} ${it.count}" }.ifEmpty { "Tool" }
}

private fun toolRunVerb(bucket: String): String = when (bucket) {
    "read" -> "Read"
    "edit" -> "Edit"
    "search" -> "Search"
    "execute" -> "Run"
    "fetch" -> "Fetch"
    else -> "Tool"
}

private fun bucketForRow(row: ToolRowPresentation): String = when {
    row.verb == "List" -> "search"
    row.icon == "read" -> "read"
    row.icon == "edit" || row.icon == "delete" || row.icon == "move" -> "edit"
    row.icon == "search" -> "search"
    row.icon == "fetch" -> "fetch"
    row.icon == "execute" || row.icon == "git" -> "execute"
    else -> "other"
}

/**
 * Counts, deduplicated file totals, and aggregate diff lines for a `ToolRun` header
 * (matching the web's `toolRunSummary`). Passing precomputed [presentations] avoids redoing JSON/diffs.
 */
fun toolRunSummary(
    items: List<TimelineItem.Tool>,
    root: String?,
    stale: Boolean = false,
    presentations: List<ToolPresentation>? = null,
): ToolRunSummary {
    val counts = LinkedHashMap<String, Int>()
    val readFiles = LinkedHashSet<String>()
    val editedFiles = LinkedHashSet<String>()
    var unkeyedReads = 0
    var unkeyedEdits = 0
    var totalAdded = 0
    var totalRemoved = 0
    for (index in items.indices) {
        val item = items[index]
        val pres = presentations?.getOrNull(index)
        val row = pres?.row ?: item.job?.let { jobRowPresentation(it, root) } ?: describeToolRow(item.event.data, L10n.uiText("core.tool.call"), root)
        val bucket = bucketForRow(row)
        val view = if (pres == null) toolView(item.event.base, root) else null
        if (pres != null) {
            totalAdded += pres.added
            totalRemoved += pres.removed
        } else if (view != null) {
            val stats = toolDiffStats(view)
            if (stats != null) {
                totalAdded += stats.added
                totalRemoved += stats.removed
            }
        }
        when (bucket) {
            "edit" -> {
                val diffPaths = if (pres != null) {
                    pres.blocks.filterIsInstance<ToolBlock.Diff>().mapNotNull { it.path }
                } else {
                    view!!.contents.mapNotNull { entry ->
                        if (text(entry["type"]) == "diff") text(entry["path"])?.let { stripRoot(it, root) } else null
                    }
                }
                val locPaths = pres?.locations?.map { it.path } ?: view!!.locations.map { it.path }
                val targets = when {
                    diffPaths.isNotEmpty() -> diffPaths
                    locPaths.isNotEmpty() -> locPaths
                    row.primaryKind == "path" -> listOf(row.primary)
                    else -> emptyList()
                }
                if (targets.isNotEmpty()) editedFiles.addAll(targets) else unkeyedEdits += 1
            }
            "read" -> {
                val locPaths = pres?.locations?.map { it.path } ?: view!!.locations.map { it.path }
                val targets = when {
                    locPaths.isNotEmpty() -> locPaths
                    row.primaryKind == "path" -> listOf(row.primary)
                    else -> emptyList()
                }
                if (targets.isNotEmpty()) readFiles.addAll(targets) else unkeyedReads += 1
            }
            else -> counts[bucket] = (counts[bucket] ?: 0) + 1
        }
    }
    val editTotal = editedFiles.size + unkeyedEdits
    val readTotal = readFiles.size + unkeyedReads
    if (editTotal > 0) counts["edit"] = editTotal
    if (readTotal > 0) counts["read"] = readTotal
    val ordered = counts.entries.sortedByDescending { it.value }.map { ToolRunCount(it.key, it.value) }
    val primaryIcon = ordered.firstOrNull()?.bucket ?: "other"
    return ToolRunSummary(
        counts = ordered,
        primaryIcon = primaryIcon,
        totalAdded = totalAdded,
        totalRemoved = totalRemoved,
    )
}

/** One entry in a `ToolRun` after collapsing adjacent completed calls that share a `mergeKey`. */
sealed interface ToolRunGroupEntry {
    data class Single(val item: TimelineItem, val index: Int) : ToolRunGroupEntry

    data class Merged(
        val key: String,
        val items: List<TimelineItem.Tool>,
        val presentation: ToolRowPresentation,
        val added: Int,
        val removed: Int,
        val files: Int,
        val failed: Boolean,
    ) : ToolRunGroupEntry {
        val showsDiffStats: Boolean get() = !failed && (added > 0 || removed > 0 || files > 1)
    }
}

private fun mergeableRow(
    item: TimelineItem,
    root: String?,
    presentationsByKey: Map<String, ToolPresentation>?,
): ToolRowPresentation? {
    if (item !is TimelineItem.Tool || item.job != null) return null
    val activity = currentToolActivity(item)
    if (activity?.kind == NativeActivityKind.BACKGROUND_TASK) return null
    if (toolKind(item.event.base) == "agent") return null
    val rawStatus = text(item.event.data["status"]) ?: text(item.event.data["state"]) ?: "completed"
    if (rawStatus in activeToolStates) return null
    val row = presentationsByKey?.get(item.key)?.row ?: describeToolRow(item.event.data, L10n.uiText("core.tool.call"), root)
    return row.takeUnless { it.mergeKey.isNullOrEmpty() }
}

/**
 * Collapse adjacent completed tool calls inside a `ToolRun` that share the same `mergeKey`
 * (matching the web's `groupAdjacentToolRunEntries`). Never merges across thoughts, jobs, or running/dangling calls.
 */
fun groupAdjacentToolRunEntries(
    entries: List<TimelineItem>,
    root: String?,
    stale: Boolean = false,
    presentationsByKey: Map<String, ToolPresentation>? = null,
): List<ToolRunGroupEntry> {
    val out = ArrayList<ToolRunGroupEntry>(entries.size)
    var index = 0
    while (index < entries.size) {
        val entry = entries[index]
        val row = mergeableRow(entry, root, presentationsByKey)
        if (row == null || entry !is TimelineItem.Tool) {
            out += ToolRunGroupEntry.Single(entry, index)
            index += 1
            continue
        }
        val group = ArrayList<TimelineItem.Tool>()
        group += entry
        var next = index + 1
        while (next < entries.size) {
            val candidate = entries[next]
            val nextRow = mergeableRow(candidate, root, presentationsByKey)
            if (candidate !is TimelineItem.Tool || nextRow == null || nextRow.mergeKey != row.mergeKey) break
            group += candidate
            next += 1
        }
        if (group.size == 1) {
            out += ToolRunGroupEntry.Single(entry, index)
        } else {
            var added = 0
            var removed = 0
            val diffFilePaths = LinkedHashSet<String>()
            var unkeyedDiffs = 0
            var failed = false
            for (sub in group) {
                val pres = presentationsByKey?.get(sub.key)
                if (pres != null) {
                    if (pres.failed) failed = true
                    added += pres.added
                    removed += pres.removed
                    for (block in pres.blocks) {
                        if (block is ToolBlock.Diff) {
                            val path = block.path
                            if (path != null) diffFilePaths += path else unkeyedDiffs += 1
                        }
                    }
                } else {
                    val view = toolView(sub.event.base, root)
                    if (view.status == "failed" && view.status !in activeToolStates) failed = true
                    val stats = toolDiffStats(view)
                    if (stats != null) {
                        added += stats.added
                        removed += stats.removed
                        for (content in view.contents) {
                            if (text(content["type"]) == "diff") {
                                val path = text(content["path"])
                                if (path != null) diffFilePaths += stripRoot(path, root) else unkeyedDiffs += 1
                            }
                        }
                    }
                }
            }
            out += ToolRunGroupEntry.Merged(
                key = entry.key,
                items = group,
                presentation = row,
                added = added,
                removed = removed,
                files = diffFilePaths.size + unkeyedDiffs,
                failed = failed,
            )
        }
        index = next
    }
    return out
}

fun processToolCount(row: TimelineRow.Process): String? =
    if (row.toolCount <= 0) null else "${row.toolCount} ${if (row.toolCount == 1) "tool" else "tools"}"
