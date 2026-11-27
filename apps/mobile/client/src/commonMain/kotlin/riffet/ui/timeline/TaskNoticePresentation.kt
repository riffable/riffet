package riffet.ui.timeline

import riffet.core.TaskNotificationStatus
import riffet.core.TimelineItem
import riffet.core.ToolRowPresentation
import riffet.core.describeJobRow
import riffet.i18n.L10n

/** What a background-task notice row shows, decided once for every client (the web's `TaskNotificationRow`). */
data class TaskNoticeView(
    /** `subagent`, `monitor`, `workflow`, `shell`, or `other`: a notice that is not a task's end (a peer's message, a worktree, a provider's note). */
    val kind: String,
    val running: Boolean,
    /** Failed, or completed with a non-zero exit code. */
    val failed: Boolean,
    /** Kind and outcome as one phrase: "后台命令已完成". */
    val headline: String,
    /** The task's name; null when the headline says it all. */
    val name: ToolRowPresentation?,
    /** Muted figures after the name: a duration of a second or more, then a non-zero exit code. */
    val figures: List<String>,
    /** The status is unknown, so the row says it did not settle. */
    val unsettled: Boolean,
)

/** The server's placeholder title for an unnamed subagent, which the headline already says. */
private const val UNNAMED_SUBAGENT = "子 Agent"

fun taskNoticeView(item: TimelineItem.TaskNotification, root: String? = null): TaskNoticeView {
    val kind = when (item.taskKind) {
        "subagent", "monitor", "workflow", "shell" -> item.taskKind
        else -> "other"
    }
    val exitCode = item.jobResult?.exitCode
    val failed = item.status == TaskNotificationStatus.FAILED ||
        (item.status == TaskNotificationStatus.COMPLETED && exitCode != null && exitCode != 0L)
    val outcome = when {
        failed -> "failed"
        item.status == TaskNotificationStatus.COMPLETED -> "done"
        item.status == TaskNotificationStatus.CANCELLED -> "stopped"
        item.status == TaskNotificationStatus.RUNNING && kind == "monitor" -> "running"
        else -> "other"
    }
    val name = when {
        kind == "other" -> null
        kind == "subagent" ->
            item.title.takeIf { it.isNotBlank() && it != UNNAMED_SUBAGENT }
                ?.let { ToolRowPresentation(icon = "execute", verb = "Run", primary = it, primaryKind = "prose") }
        item.title.isNotBlank() || !item.command.isNullOrBlank() -> describeJobRow(item.title, item.command, root)
        else -> null
    }
    val duration = item.jobResult?.runningMs ?: item.durationMs
    return TaskNoticeView(
        kind = kind,
        running = item.status == TaskNotificationStatus.RUNNING,
        failed = failed,
        // Any other notice keeps its own title: the kind-and-outcome phrase would misname it.
        headline = if (kind == "other") item.title.ifBlank { L10n.uiText("activity.kind.background") } else L10n.uiText("notice.$kind.$outcome"),
        name = name,
        figures = listOfNotNull(
            duration?.takeIf { it >= 1_000L }?.let(::formatDurationMs),
            exitCode?.takeIf { it != 0L }?.let { L10n.uiText("notice.exitCode", it) },
        ),
        unsettled = item.status == TaskNotificationStatus.UNKNOWN,
    )
}
