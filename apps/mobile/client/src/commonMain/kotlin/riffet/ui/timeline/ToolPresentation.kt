package riffet.ui.timeline

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import riffet.contracts.NativeActivity
import riffet.contracts.NativeActivityStatus
import riffet.contracts.TurnOutlineV3
import riffet.core.LineDiff
import riffet.core.TimelineItem
import riffet.core.ToolLocation
import riffet.core.activeToolStates
import riffet.core.lineDiff
import riffet.i18n.L10n
import riffet.core.stripRoot
import riffet.core.toolDiffStats
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
) {
    val showsDiffStats: Boolean get() = !failed && !dangling && (added > 0 || removed > 0 || files > 1)
    val hasDetails: Boolean get() = command != null || locations.isNotEmpty() || blocks.isNotEmpty()
}

private fun text(element: JsonElement?): String? = (element as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun long(element: JsonElement?): Long? = (element as? JsonPrimitive)?.longOrNull

private fun int(element: JsonElement?): Int? = (element as? JsonPrimitive)?.intOrNull

/** One `content` image entry as a host draws it; hosts that read JSON themselves call this too. */
fun toolImage(content: JsonObject, root: String?): ToolImage? {
    val path = text(content["path"])
    val mimeType = text(content["mimeType"])
    val data = text(content["data"])
    val dataUrl = if (data != null && mimeType?.startsWith("image/") == true) "data:$mimeType;base64,$data" else null
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
        TurnOutlineV3.Status.CANCELLED -> activity.status == NativeActivityStatus.STOPPED
        else -> true
    }
    return activity.takeIf { matches }
}

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
    val failed = status == "failed"
    val primaryPath = view.locations.firstOrNull()?.path
    val isCommand = view.command != null && view.title == view.command
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
        isCommand -> null
        primaryPath != null && !view.title.contains(primaryPath.substringAfterLast('/')) -> primaryPath
        else -> null
    }
    val diffPaths = view.contents
        .filter { text(it["type"]) == "diff" }
        .mapNotNull { entry -> text(entry["path"])?.let { stripRoot(it, root) } }
        .toSet()
    val images = if (failed) emptyList() else view.contents.mapNotNull { entry ->
        (entry["content"] as? JsonObject)?.takeIf { text(it["type"]) == "image" }?.let { toolImage(it, root) }
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
    )
}

/** Delegations stand on their own inside the process, like reasoning, rather than joining tools. */
fun isToolRunItem(item: TimelineItem): Boolean = item is TimelineItem.Tool && toolKind(item.event.base) != "agent"

/** The process header's label at [nowMillis]: `Working · 12s` while live, `Processed · 1m 3s` once done, `Stopped · 1m 3s` once stopped. */
fun processHeaderLabel(row: TimelineRow.Process, nowMillis: Long): String {
    val start = instantMillis(row.startedAt)
    val end = instantMillis(row.endedAt)
    val seconds = when {
        start == null -> 0L
        row.running -> ((nowMillis - start) / 1_000L).coerceAtLeast(0L)
        else -> (((end ?: nowMillis) - start) / 1_000L).coerceAtLeast(0L)
    }
    val done = if (row.stopped) "Stopped" else "Processed"
    return when {
        row.running -> "Working · ${formatElapsed(seconds)}"
        seconds > 0 -> "$done · ${formatElapsed(seconds)}"
        else -> done
    }
}

/** `1 tool` / `3 tools`, or null for a block with no tool calls. */
private val toolRunCategories = setOf(
    "read", "search", "execute", "edit", "delete", "move", "fetch", "agent", "message", "think", "switch_mode", "question", "plan",
)

/**
 * The action categories in a run of tool calls, first seen first, for the folded run's label (the
 * web's `toolRunSummary`). Only provider-supplied categories count, never ones guessed from shell
 * text: a Codex call lists its reads, searches and commands in `commandActions`, and reports `other`
 * as its own kind; other calls report one `kind`. Anything unknown is `other`.
 */
fun toolRunKinds(items: List<TimelineItem.Tool>): List<String> {
    val kinds = LinkedHashSet<String>()
    for (item in items) {
        val data = item.event.data
        val input = (data["rawInput"] ?: data["input"]) as? JsonObject
        val actions = (input?.get("commandActions") as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
        val reported = if (actions.isNotEmpty()) {
            actions.map {
                when (text(it["type"])) {
                    "read" -> "read"
                    "search", "listFiles" -> "search"
                    else -> "execute"
                }
            }
        } else {
            listOf(text(data["kind"]) ?: "other")
        }
        for (kind in reported) kinds += if (kind in toolRunCategories) kind else "other"
    }
    return kinds.toList()
}

fun processToolCount(row: TimelineRow.Process): String? =
    if (row.toolCount <= 0) null else "${row.toolCount} ${if (row.toolCount == 1) "tool" else "tools"}"
