package riffet.ui.timeline

import riffet.ui.theme.visualWorkVisibility

import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import riffet.ui.icons.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import riffet.contracts.NativeJob
import riffet.contracts.NativeActivityKind
import riffet.i18n.L10n
import riffet.contracts.NativeJobStatus
import riffet.core.TimelineItem
import riffet.core.ToolView
import riffet.core.activeToolStates
import riffet.core.isCommandTitle
import riffet.core.stripRoot
import riffet.core.toolDiffStats
import riffet.core.toolFoldedDetail
import riffet.core.toolView
import riffet.ui.icons.RiffetIcons
import riffet_mobile.shared.generated.resources.*
import org.jetbrains.compose.resources.rememberResourceEnvironment
import org.jetbrains.compose.resources.stringResource

/*
 * A tool call, and the background shell job it may actually be.
 *
 * `ToolRow` in Timeline.tsx dispatches on `item.job` first: a background shell is *one row with its
 * own live state*, not a tool call plus a wait, and it keeps ticking after the turn that started
 * it. Everything else is the regular tool row: the kind's icon, the title, `path:line` chips,
 * added/removed counts, images, and the payload behind one expansion.
 */

@Composable
internal fun ToolRow(
    item: TimelineItem.Tool,
    root: String?,
    stale: Boolean,
    onOpenFile: (String, Int?) -> Unit,
) {
    val job = item.job
    if (job != null) {
        JobRow(job, onOpenFile)
        return
    }
    RegularToolRow(item, root, stale, onOpenFile)
}

/** A background shell. Driven by the job's live state, not by the tool call that launched it. */
@Composable
internal fun JobRow(job: NativeJob, onOpenFile: (String, Int?) -> Unit) {
    val colors = TimelineTheme.colors
    val type = TimelineTheme.type
    var open by rememberSaveable(job.toolCallId) { mutableStateOf(false) }
    val running = job.status == NativeJobStatus.RUNNING
    val failed = job.status == NativeJobStatus.FAILED
    val unknown = job.status == NativeJobStatus.UNKNOWN

    val visibility = riffet.ui.theme.rememberVisualWorkVisibility()
    val now = rememberTickingNow(running && open, visible = visibility.visible)
    val startedAt = instantMillis(job.startedAt)
    val elapsedMs = maxOf(
        job.runningMs ?: 0L,
        if (running && startedAt != null) (now - startedAt).coerceAtLeast(0L) else 0L,
    )
    val elapsed = if (elapsedMs / 1_000L <= 0L) null else formatDurationMs(elapsedMs)

    TimelineDisclosure(
        modifier = Modifier.visualWorkVisibility(visibility),
        open = open,
        onToggle = { open = !open },
        danger = failed,
        leading = { RunningMark(running) { ToolIcon(RiffetIcons.SquareTerminal) } },
        title = {
            Text(
                text = job.title,
                // The command itself is monospaced like any call's title; a described job reads as prose.
                style = if (job.title.trim() == job.command.trim()) type.codeSmall else type.rowLabel,
                color = colors.fg3,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        // Running and done need no word; only an unexpected outcome follows the title.
        inline = if (failed || unknown) {
            { RowOutcome(failed) }
        } else null,
    ) {
        if (job.title.trim() != job.command.trim()) Text(job.title, style = type.label, color = colors.fg2)
        if (job.command.isNotBlank()) CodeBlock(job.command, prefix = "\$ ", foreground = colors.fg)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            formatDateTime(job.startedAt)?.let { Text(it, style = type.caption, color = colors.fg3) }
            elapsed?.let { Text(it, style = type.caption, color = colors.fg3) }
        }
        val output = job.output
        if (!output.isNullOrEmpty()) {
            CodeBlock(output, maxHeight = 384.dp)
        } else {
            Text(
                text = if (running) stringResource(Res.string.timeline_output_pending) else stringResource(Res.string.timeline_no_output),
                style = type.caption,
                color = colors.fg3,
            )
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            val id = job.id
            if (id != null) Chip("shell $id", mono = true)
            val exitCode = job.exitCode
            if (exitCode != null && exitCode != 0L) {
                Text("exit $exitCode", style = type.caption, color = colors.fg3)
            }
            val matched = job.matched
            if (matched != null) {
                Text(
                    text = stringResource(Res.string.timeline_matched, matched),
                    style = type.caption,
                    color = colors.fg3,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (job.truncated == true) {
                Text(stringResource(Res.string.timeline_output_truncated), style = type.caption, color = colors.fg3)
            }
            val outputPath = job.outputPath
            if (outputPath != null) {
                Text(
                    text = stringResource(Res.string.timeline_view_full_log),
                    style = type.caption,
                    color = colors.fg3,
                    modifier = Modifier.clickable(role = Role.Button) { onOpenFile(outputPath, null) },
                )
            }
        }
    }
}

/**
 * Opens a subagent's own transcript, provided by the session screen.
 *
 * Null inside a child page (a nested subagent is not listed yet) and outside a session, and a row
 * with no handler behaves exactly as it always did.
 */
internal val LocalSubagentOpen = staticCompositionLocalOf<((toolCallId: String, name: String) -> Unit)?> { null }

@Composable
private fun RegularToolRow(
    item: TimelineItem.Tool,
    root: String?,
    stale: Boolean,
    onOpenFile: (String, Int?) -> Unit,
) {
    val colors = TimelineTheme.colors
    val type = TimelineTheme.type
    val environment = rememberResourceEnvironment()
    // `toolView` reads the raw event, and `TimelineItem.event` is the projected wrapper around it.
    val view = remember(item.event, root, environment) { toolView(item.event.base, root) }
    val stats = remember(view) { toolDiffStats(view) }

    val activity = currentToolActivity(item)
    val actions = LocalActivityActions.current
    var open by rememberSaveable { mutableStateOf(false) }
    // The clock only reads in the open detail; the folded row shows no time.
    val visibility = riffet.ui.theme.rememberVisualWorkVisibility()
    val now = rememberTickingNow(active = activity?.status?.active == true && open, visible = visibility.visible)
    val activityState = activity?.let { activityView(it, stopping = actions?.stopping?.contains(it.id) == true, nowMillis = now) }
    val child = item.subagent
    // A child with no turn markers yet has no status: only its running flag is known, and a stopped
    // one falls through to the activity and then the call itself, which may say it failed.
    val liveStatus = child?.status?.takeUnless { it.wire.isEmpty() }?.wire
        ?: child?.takeIf { it.running }?.let { "running" }
        ?: activity?.status?.takeUnless { it.wire == "unknown" }?.wire
    val status = liveStatus ?: view.status
    val active = status in activeToolStates || status == "running" || status == "stopping"
    val running = active && (liveStatus != null || !stale)
    val dangling = active && !running
    val failed = status == "failed"
    var confirming by remember { mutableStateOf(false) }
    // Running and done say nothing on the row; only an unexpected outcome follows the title. One
    // call failing is routine, so only a background task's or a subagent's failure is worth a word.
    val outcome = when {
        activity?.kind == NativeActivityKind.BACKGROUND_TASK -> backgroundOutcome(activity.status)
        failed && view.kind == "agent" -> true
        dangling -> false
        else -> null
    }
    val stopping = running && (activityState?.stopping == true || liveStatus == "stopping")
    val stoppable = activity?.takeIf { activityState?.canStop == true && actions != null }

    val isCommand = isCommandTitle(view.title, view.command)
    fun meaningful(value: String?): String? = value?.trim()?.takeIf { it.isNotEmpty() }?.takeUnless {
        it.lowercase().filterNot { char -> char == '-' || char == '_' || char.isWhitespace() } in setOf("generalpurpose", "subagent")
    }
    val subagent = item.event.data["subagent"] as? JsonObject
    val subagentType = meaningful(child?.subagentType ?: jsonText(subagent?.get("type")))
    // Named as `toolPresentation` names it, so every client and the subagent list agree.
    val title = if (view.kind == "agent") meaningful(jsonText(subagent?.get("description")))
        ?: meaningful(child?.title)
        ?: meaningful(jsonText(subagent?.get("prompt"))?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim())
        ?: subagentType
        ?: meaningful(view.title) ?: L10n.uiText("subagent.title") else view.title
    // A Task row is a conversation of its own: tapping it opens that page rather than unfolding the
    // call's arguments, which is what the web does and what the prompt now has a home for (the page
    // opens on it). Anything else unfolds as before.
    val subagentOpen = LocalSubagentOpen.current
    val opensPage = view.kind == "agent" && subagentOpen != null
    // The command stays in the expanded body, parsed or not: a folded row reads by its title, and
    // a truncated command beside it is neither readable nor needed to tell rows apart.
    val detail = when {
        view.kind == "agent" -> subagentType?.takeIf { it != title }
        isCommand -> toolFoldedDetail(view, root)
        else -> toolFoldedDetail(view, root)
    }

    // A call's title is set like its command, monospaced whole; only a delegation's and a background
    // task's, which are sentences, read in the body face.
    val prose = view.kind == "agent" || activity?.kind == NativeActivityKind.BACKGROUND_TASK
    val pathDir = colors.fg4
    val pathName = colors.fg3
    val titleText = remember(title, view.locations, prose, isCommand, pathDir, pathName) {
        val path = if (prose || isCommand) null else {
            view.locations.firstNotNullOfOrNull { location -> location.path.takeIf { it.isNotEmpty() && title.endsWith(" $it") } }
        }
        if (path == null) {
            AnnotatedString(title)
        } else {
            buildAnnotatedString {
                append(title, 0, title.length - path.length)
                append(pathText(path, pathDir, pathName))
            }
        }
    }

    val images = remember(view, failed) {
        if (failed) emptyList() else view.contents.mapNotNull { entry ->
            (entry["content"] as? JsonObject)?.takeIf { jsonText(it["type"]) == "image" }
        }
    }

    Column(Modifier.visualWorkVisibility(visibility).fillMaxWidth()) {
        TimelineDisclosure(
            // A page, not a fold: the chevron stays pointing right and nothing rotates under the
            // reader's finger.
            open = if (opensPage) false else open,
            onToggle = {
                if (opensPage) subagentOpen?.invoke(view.id, title) else open = !open
            },
            // One call failing is routine: the row stays quiet, and the error reads in its body.
            leading = { RunningMark(running) { ToolIcon(toolIcon(view.kind)) } },
            title = {
                Text(
                    text = titleText,
                    style = if (prose) type.rowLabel else type.codeSmall,
                    color = colors.fg3,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            },
            detail = detail,
            // An unexpected outcome or this edit's counts travel with the title; the right edge is
            // only for what is still going or can be acted on.
            inline = if (outcome != null) {
                { RowOutcome(outcome) }
            } else if (!failed && !dangling && stats != null && (stats.added > 0 || stats.removed > 0 || stats.files > 1)) {
                {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        if (stats.files > 1) {
                            Text(stringResource(Res.string.timeline_file_count, stats.files), style = type.caption, color = colors.fg3, maxLines = 1, softWrap = false)
                        }
                        // Text, so the plain diff roles cannot be used here — they are translucent
                        // backgrounds and would be illegible as type.
                        if (stats.added > 0) {
                            Text("+${stats.added}", style = type.codeSmall, color = colors.success, maxLines = 1, softWrap = false)
                        }
                        if (stats.removed > 0) {
                            Text("−${stats.removed}", style = type.codeSmall, color = colors.danger, maxLines = 1, softWrap = false)
                        }
                    }
                }
            } else null,
            // Only what is still going or can be acted on keeps the right edge.
            status = if (stopping || stoppable != null) {
                {
                    if (stopping) StoppingLabel()
                    if (stoppable != null) {
                        Text(
                            text = stringResource(Res.string.timeline_stop), style = type.caption, color = colors.danger,
                            modifier = Modifier.clickable(role = Role.Button) { if (activityState?.stopWarning != null) confirming = true else actions?.onStop(stoppable.id) }
                                .heightIn(min = TimelineRhythm.touchTarget).wrapContentHeight(Alignment.CenterVertically).padding(horizontal = 6.dp, vertical = 5.dp),
                        )
                    }
                }
            } else null,
        ) {
            if (activity?.kind == NativeActivityKind.BACKGROUND_TASK) {
                activityState?.stats?.let { Text(it, style = type.caption, color = colors.fg3) }
                formatDateTime(activity.endedAt ?: activity.startedAt)?.let { Text(it, style = type.caption, color = colors.fg3) }
            }
            ToolContents(view, root, onOpenFile)
        }
        // A screenshot is the point of the call, so a folded row still shows it (the web's `ml-6`).
        if (images.isNotEmpty() && !open) {
            Column(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.padding(start = 24.dp, bottom = 6.dp),
            ) {
                images.forEach { ToolImage(it, root, maxHeight = 192.dp) }
            }
        }
    }
    if (confirming && activity != null && actions != null) StopConfirmation(activityState?.stopWarning, onConfirm = { confirming = false; actions.onStop(activity.id) }, onDismiss = { confirming = false })
}

/** The web's `toolIcons` table, falling back to its wrench. */
internal fun toolIcon(kind: String): ImageVector = when (kind) {
    "read" -> RiffetIcons.FileText
    "edit" -> RiffetIcons.FilePenLine
    "delete" -> RiffetIcons.Trash
    "move" -> RiffetIcons.ArrowRightLeft
    "search" -> RiffetIcons.Search
    "execute" -> RiffetIcons.SquareTerminal
    "think" -> RiffetIcons.Brain
    "fetch" -> RiffetIcons.Globe
    "switch_mode" -> RiffetIcons.Repeat
    "agent" -> RiffetIcons.Bot
    "message" -> RiffetIcons.Send
    "question" -> RiffetIcons.MessageQuestion
    "goal" -> RiffetIcons.Target
    else -> RiffetIcons.Wrench
}

@Composable
internal fun ToolIcon(icon: ImageVector) {
    Icon(icon, contentDescription = null, tint = TimelineTheme.colors.fg4, modifier = Modifier.size(14.dp))
}

/**
 * The web's `ToolImage`: a file the server can read, or small inline bytes. A path outside a
 * project, or bytes left out upstream for size, get a one-line note instead.
 *
 * The reading of the entry — which fields name and size the picture, when there is nothing to draw
 * — is the shared [toolImage] model, so this row, the web and the Swift client say the same thing.
 */
@Composable
private fun ToolImage(content: JsonObject, root: String?, maxHeight: Dp = 448.dp) {
    rememberResourceEnvironment()
    val colors = TimelineTheme.colors
    val files = LocalFileAccess.current
    val image = toolImage(content, root) ?: return
    val caption = image.caption
    val placeholder = image.placeholder
    val path = image.path
    val dataUrl = image.dataUrl
    val source = when {
        path != null && files != null -> ImageSource.ProjectFile(files.projectId, path)
        dataUrl != null -> ImageSource.DataUrl(dataUrl)
        else -> null
    }
    if (source != null) {
        FlexibleImage(
            source = source,
            label = caption,
            maxHeight = maxHeight,
            detail = image.mimeType,
            onDownload = if (path != null && files?.canDownload == true) ({ files.download(path) }) else null,
        )
        return
    }
    if (path == null && !image.omitted) return
    Row(verticalAlignment = Alignment.CenterVertically) {
        Icon(RiffetIcons.Image, contentDescription = null, tint = colors.fg3, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(6.dp))
        Text(
            text = if (path != null) stringResource(Res.string.timeline_image_with_caption, caption) else placeholder,
            style = TimelineTheme.type.caption,
            color = colors.fg3,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ToolContents(
    view: ToolView,
    root: String?,
    onOpenFile: (String, Int?) -> Unit,
) {
    val colors = TimelineTheme.colors
    val type = TimelineTheme.type
    view.command?.let { command ->
        CodeBlock(
            text = command,
            prefix = "\$ ",
            textStyle = type.codeSmall,
            foreground = colors.fg,
        )
    }

    // A diff header already carries the path with open/copy/download; a bare chip for it is noise.
    val diffPaths = view.contents
        .filter { jsonText(it["type"]) == "diff" }
        .mapNotNull { item -> jsonText(item["path"])?.let { stripRoot(it, root) } }
        .toSet()
    val locations = view.locations.filterNot { it.line == null && it.path in diffPaths }
    if (locations.isNotEmpty()) {
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            locations.forEach { location ->
                PathChip(location.path, location.line, onOpenFile)
            }
        }
    }

    view.contents.forEach { item -> ToolContentBlock(item, root, onOpenFile) }

    val nothingToShow = view.command == null &&
        view.locations.isEmpty() &&
        view.contents.none { renderableContent(it) }
    if (nothingToShow) {
        Text(stringResource(Res.string.timeline_no_more_details), style = type.caption, color = colors.fg3)
    }
}

/** Whether a `content` entry produces anything on screen. Mirrors the web's `filter(Boolean)`. */
private fun renderableContent(item: JsonObject): Boolean = when (jsonText(item["type"])) {
    "question_answer", "diff", "terminal" -> true
    else -> when (jsonText((item["content"] as? JsonObject)?.get("type"))) {
        "text", "image" -> true
        else -> false
    }
}

@Composable
private fun ToolContentBlock(
    item: JsonObject,
    root: String?,
    onOpenFile: (String, Int?) -> Unit,
) {
    val colors = TimelineTheme.colors
    val type = TimelineTheme.type
    when (jsonText(item["type"])) {
        "question_answer" -> {
            val question = jsonText(item["question"])
            val answers = (item["answers"] as? JsonArray)?.mapNotNull { jsonText(it) }.orEmpty()
            val options = (item["options"] as? JsonArray)?.mapNotNull { jsonText(it) }.orEmpty()
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                if (question != null) {
                    Text(question, style = type.label, color = colors.fg3)
                }
                if (options.isNotEmpty()) {
                    Text(
                        stringResource(
                            Res.string.timeline_options,
                            options.joinToString(stringResource(Res.string.timeline_list_separator)),
                        ),
                        style = type.caption,
                        color = colors.fg3,
                    )
                }
                Text(
                    text = answers.joinToString(stringResource(Res.string.timeline_list_separator)).ifEmpty { stringResource(Res.string.timeline_skipped) },
                    style = type.label,
                    color = colors.fg,
                )
            }
        }

        "diff" -> DiffBlock(
            path = jsonText(item["path"])?.let { stripRoot(it, root) },
            before = jsonText(item["oldText"]).orEmpty(),
            after = jsonText(item["newText"]).orEmpty(),
            lineOffset = jsonLong(item["lineOffset"]) ?: 0L,
            trailingLines = jsonLong(item["trailingLines"]) ?: 0L,
            onOpenFile = onOpenFile,
        )

        "terminal" -> Text(
            text = stringResource(Res.string.timeline_terminal_output, jsonText(item["terminalId"]).orEmpty()),
            style = type.caption,
            color = colors.fg3,
        )

        else -> {
            val content = item["content"] as? JsonObject
            when (jsonText(content?.get("type"))) {
                "text" -> jsonText(content?.get("text"))?.let { text ->
                    CodeBlock(text)
                }

                "image" -> if (content != null) ToolImage(content, root)

                else -> Unit
            }
        }
    }
}
