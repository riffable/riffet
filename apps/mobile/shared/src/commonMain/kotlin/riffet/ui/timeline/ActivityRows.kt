package riffet.ui.timeline

import riffet.ui.theme.visualWorkVisibility

import riffet.ui.design.LocalInterfaceStyle
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.shape.RoundedCornerShape
import riffet.ui.design.AlertDialog
import androidx.compose.material3.Text
import riffet.ui.design.RiffetTextButton as TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import riffet.ui.icons.RiffetIcons
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.jetbrains.compose.resources.rememberResourceEnvironment
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.NativeActivity
import riffet.contracts.NativeActivityStatus
import riffet.i18n.L10n
import riffet.contracts.NativeActivityKind
import riffet.core.TimelineItem
import riffet_mobile.shared.generated.resources.*

/*
 * ============================================================================================
 * 系统活动 rows (docs/SESSION-JOURNAL.md): compaction, background tasks, local command output
 * ============================================================================================
 *
 * Not a user bubble and not a turn's trigger: a one-line disclosure in the transcript's own rhythm.
 * The words come from `activityView`, shared with iOS and macOS.
 */

/** What an activity row can ask of the store; absent in previews, where the stop button hides. */
internal class ActivityActions(
    /** Activities with a stop request out ([riffet.ui.state.SessionStore.stoppingActivities]). */
    val stopping: Set<String>,
    val onStop: (String) -> Unit,
    /** The full text behind a preview's `blobRef`; null when it cannot be read. */
    val loadText: suspend (String) -> String?,
)

internal val LocalActivityActions = compositionLocalOf<ActivityActions?> { null }

@Composable
internal fun ActivityRow(item: TimelineItem.Activity) {
    // Plain L10n getters need the same locale subscription as Compose string resources.
    rememberResourceEnvironment()
    val activity = item.activity
    val colors = TimelineTheme.colors
    val type = TimelineTheme.type
    val actions = LocalActivityActions.current
    val background = activity.kind == NativeActivityKind.BACKGROUND_TASK
    var open by rememberSaveable(item.key) { mutableStateOf(false) }
    // The clock only reads in a background task's open detail; the folded row shows no time.
    val visibility = riffet.ui.theme.rememberVisualWorkVisibility()
    val now = rememberTickingNow(active = activity.status.active && background && open, visible = visibility.visible)
    val view = activityView(activity, stopping = actions?.stopping?.contains(activity.id) == true, nowMillis = now)

    if (activity.kind == NativeActivityKind.LOCAL_COMMAND && !activity.task?.command.isNullOrBlank()) {
        ShellCommandRow(activity, open, onToggle = { open = !open }, modifier = Modifier.visualWorkVisibility(visibility))
        return
    }

    if (activity.kind == NativeActivityKind.LOCAL_COMMAND || activity.kind == NativeActivityKind.UNKNOWN) {
        // A command's own output: quiet, one line, nothing to open.
        Text(
            text = view.summary,
            style = type.caption,
            color = colors.fg3,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth(),
        )
        return
    }

    var confirming by remember { mutableStateOf(false) }
    val outcome = if (background) backgroundOutcome(activity.status) else null
    val tokens = if (background) null else compactionTokens(activity)
    TimelineDisclosure(
        modifier = Modifier.visualWorkVisibility(visibility),
        open = open,
        onToggle = { open = !open },
        expandable = background || view.expandable,
        danger = view.tone == ActivityTone.FAILED,
        // The mark is neutral: a done task says nothing, and a failed one says so after its title.
        leading = { RunningMark(view.running) { StatusDot(colors.fg3, 8.dp) } },
        title = {
            Text(
                text = if (background) view.subject ?: view.label else listOfNotNull(view.label, view.subject).joinToString(" · "),
                style = type.rowLabel,
                color = colors.fg2,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        // A compaction's token figures describe the row, so they travel with the title; a task's
        // outcome is worth a word only when it is not the expected one.
        inline = if (outcome != null || tokens != null) {
            {
                if (outcome != null) RowOutcome(outcome)
                if (tokens != null) Text(tokens, style = type.caption, color = colors.fg3, maxLines = 1)
            }
        } else null,
        // Only what is still going or can be acted on keeps the right edge.
        status = if ((view.stopping && background) || (view.canStop && actions != null)) {
            {
                // A compaction's own label already reads 正在停止压缩.
                if (view.stopping && background) StoppingLabel()
                if (view.canStop && actions != null) {
                    Text(
                        text = stringResource(Res.string.timeline_stop),
                        style = type.caption,
                        color = colors.danger,
                        modifier = Modifier
                            .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
                            .clickable(role = Role.Button) { if (view.stopWarning != null) confirming = true else actions.onStop(activity.id) }
                            .heightIn(min = TimelineRhythm.touchTarget)
                            // Text draws its line at the top of a taller box; centre it in the tap target.
                            .wrapContentHeight(Alignment.CenterVertically)
                            .padding(horizontal = 6.dp, vertical = 5.dp),
                    )
                }
            }
        } else null,
    ) {
        ActivityDetail(activity, view)
    }
    if (confirming && actions != null) StopConfirmation(view.stopWarning, onConfirm = { confirming = false; actions.onStop(activity.id) }, onDismiss = { confirming = false })
}

/** The preview, then the full text on request: nothing is fetched until the reader asks. */
@Composable
private fun ActivityDetail(activity: NativeActivity, view: ActivityView) {
    val colors = TimelineTheme.colors
    val type = TimelineTheme.type
    val actions = LocalActivityActions.current
    var full by remember(activity.blobRef) { mutableStateOf<String?>(null) }
    var loading by remember(activity.blobRef) { mutableStateOf(false) }
    var failed by remember(activity.blobRef) { mutableStateOf(false) }
    val blobRef = activity.blobRef
    LaunchedEffect(loading, blobRef) {
        if (!loading || blobRef == null) return@LaunchedEffect
        val text = actions?.loadText?.invoke(blobRef)
        failed = text == null
        full = text
        loading = false
    }
    if (activity.kind == NativeActivityKind.BACKGROUND_TASK) {
        if (activity.title.trim() != activity.task?.command?.trim()) Text(activity.title, style = type.label, color = colors.fg2)
        view.stats?.let { Text(it, style = type.caption, color = colors.fg3) }
        formatDateTime(activity.endedAt ?: activity.startedAt)?.let { Text(it, style = type.caption, color = colors.fg3) }
    }
    activity.task?.command?.takeIf { it.isNotBlank() }?.let { CodeBlock(it, prefix = "\$ ", foreground = colors.fg) }
    val text = full ?: activity.detail
    if (!text.isNullOrBlank()) CodeBlock(text)
    if (blobRef != null && full == null && actions != null) {
        FullTextAction(loading, failed) { failed = false; loading = true }
    }
    view.stopWarning?.takeIf { view.canStop }?.let { Text(it, style = type.caption, color = colors.fg3) }
}

/** 查看完整内容 / 加载中 / 重试: the one way to ask for a preview's full text. */
@Composable
private fun FullTextAction(loading: Boolean, failed: Boolean, onClick: () -> Unit) {
    Text(
        text = when {
            loading -> stringResource(Res.string.timeline_activity_loading_full)
            failed -> stringResource(Res.string.timeline_activity_load_failed_retry)
            else -> stringResource(Res.string.timeline_activity_view_full)
        },
        style = TimelineTheme.type.caption,
        color = TimelineTheme.colors.accent,
        modifier = Modifier
            .clip(RoundedCornerShape(LocalInterfaceStyle.current.controlRadius))
            .then(if (loading) Modifier else Modifier.clickable(role = Role.Button, onClick = onClick))
            .padding(vertical = 4.dp),
    )
}

/**
 * A `!cmd` the reader ran: one row like a shell tool call, its output's last lines under the title
 * and all of it once opened. The body is drawn below the header by one [CodeBlock], so opening
 * changes its text, not the tree.
 */
@Composable
private fun ShellCommandRow(activity: NativeActivity, open: Boolean, onToggle: () -> Unit, modifier: Modifier) {
    val colors = TimelineTheme.colors
    val type = TimelineTheme.type
    val actions = LocalActivityActions.current
    val running = activity.status == NativeActivityStatus.RUNNING
    val detail = activity.detail?.takeIf { it.isNotBlank() }
    val blobRef = activity.blobRef
    var full by remember(blobRef) { mutableStateOf<String?>(null) }
    var loading by remember(blobRef) { mutableStateOf(false) }
    var failed by remember(blobRef) { mutableStateOf(false) }
    LaunchedEffect(loading, blobRef) {
        if (!loading || blobRef == null) return@LaunchedEffect
        val text = actions?.loadText?.invoke(blobRef)
        failed = text == null
        full = text
        loading = false
    }
    val command = activity.task?.command.orEmpty().lineSequence().firstOrNull { it.isNotBlank() }?.trim().orEmpty()
    val tail = remember(detail) { detail?.trimEnd()?.lines()?.takeLast(6)?.joinToString("\n") }
    val body = if (open) full ?: detail else if (running) null else tail

    Column(modifier.fillMaxWidth()) {
        TimelineDisclosure(
            open = open,
            onToggle = onToggle,
            expandable = detail != null || blobRef != null,
            hasBody = false,
            leading = { RunningMark(running) { ToolIcon(RiffetIcons.SquareTerminal) } },
            title = {
                Text(
                    text = buildAnnotatedString {
                        withStyle(SpanStyle(color = colors.fg4)) { append("! ") }
                        append(command)
                    },
                    style = type.codeSmall,
                    color = colors.fg3,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            },
            inline = if (activity.status == NativeActivityStatus.UNKNOWN) {
                { RowOutcome(false) }
            } else null,
        ) {}
        // Aligned with the title: the icon slot and its gap.
        Column(Modifier.fillMaxWidth().padding(start = 24.dp, bottom = 4.dp)) {
            if (!body.isNullOrBlank()) CodeBlock(body)
            if (open && blobRef != null && full == null && actions != null) {
                FullTextAction(loading, failed) { failed = false; loading = true }
            }
        }
    }
}

@Composable
internal fun StopConfirmation(warning: String?, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(Res.string.timeline_stop_background_task_title)) },
        text = { Text(warning ?: "") },
        confirmButton = { TextButton(onClick = onConfirm) { Text(stringResource(Res.string.timeline_stop)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(Res.string.timeline_cancel)) } },
    )
}

/**
 * A finished task's outcome when it is not the expected one: true for 失败, false for 未完成 (it
 * ended without saying how). Null while it runs, and for a task that completed or was stopped —
 * those say nothing on the row.
 */
internal fun backgroundOutcome(status: NativeActivityStatus): Boolean? = when (status) {
    NativeActivityStatus.FAILED -> true
    NativeActivityStatus.UNKNOWN -> false
    else -> null
}

/** Follows a row's title: a small danger 失败, or a faint 未完成. A success says nothing. */
@Composable
internal fun RowOutcome(failed: Boolean) {
    val colors = TimelineTheme.colors
    Text(
        text = stringResource(if (failed) Res.string.timeline_status_failed else Res.string.timeline_job_status_incomplete),
        style = TimelineTheme.type.caption,
        color = if (failed) colors.danger else colors.fg4,
        maxLines = 1,
    )
}

/** A stop request out: the one state word the right edge keeps. */
@Composable
internal fun StoppingLabel() {
    rememberResourceEnvironment()
    Text(L10n.uiText("activity.state.stopping"), style = TimelineTheme.type.caption, color = TimelineTheme.colors.fg4, maxLines = 1)
}

/** A finished compaction's `43.5 万 → 1.3 万`, without its duration; null otherwise. */
private fun compactionTokens(activity: NativeActivity): String? {
    if (activity.kind != NativeActivityKind.COMPACTION || activity.status != NativeActivityStatus.COMPLETED) return null
    val pre = activity.compaction?.preTokens
    val post = activity.compaction?.postTokens
    return when {
        pre != null && post != null -> "${activityTokens(pre)} → ${activityTokens(post)}"
        pre != null -> L10n.uiText("activity.compaction.before", activityTokens(pre))
        post != null -> L10n.uiText("activity.compaction.after", activityTokens(post))
        else -> null
    }
}
