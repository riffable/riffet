package riffet.ui.timeline

import riffet.contracts.NativeActivity
import riffet.contracts.NativeActivityKind
import riffet.contracts.NativeActivityStatus
import riffet.contracts.NativeActivitySummary
import riffet.i18n.L10n
import riffet.stats.compactCount

/*
 * ============================================================================================
 * 系统活动 (docs/SESSION-JOURNAL.md): what a row and the dock above the composer say
 * ============================================================================================
 *
 * The words live here once, so Android, iOS and macOS print the same line for the same activity and
 * only their drawing differs. Nothing in this file reads a clock: the caller passes `nowMillis`.
 */

/** How an activity's row is tinted; each platform maps it to its own colours. */
enum class ActivityTone { ACTIVE, DONE, FAILED, MUTED }

/** What one activity row shows; [summary] is the whole line for hosts that draw a single string. */
data class ActivityView(
    val kind: NativeActivityKind,
    /** A spinner belongs in front: it is still going (including a stop in flight). */
    val running: Boolean,
    val stopping: Boolean,
    val tone: ActivityTone,
    /** "正在压缩上下文", "上下文已压缩", "后台命令", "/compact". */
    val label: String,
    /** The command or title the label is about; null when the label says it all. */
    val subject: String?,
    /** Figures and state after it: "43.5 万 → 1.3 万 · 1 分 50 秒", "运行中 · 0:45", "exit 1". */
    val stats: String?,
    /** The preview or the full text can be opened. */
    val expandable: Boolean,
    /** The stop button belongs on the row. */
    val canStop: Boolean,
    /** What stopping this also stops, when it is more than the row itself; null otherwise. */
    val stopWarning: String?,
) {
    val summary: String get() = listOfNotNull(label, subject, stats).joinToString(" · ")
}

/** A task that failed, or that completed with a non-zero exit code, as the web reads it. */
fun activityFailed(activity: NativeActivity): Boolean =
    activity.status == NativeActivityStatus.FAILED ||
        (activity.status == NativeActivityStatus.COMPLETED && activity.task?.exitCode.let { it != null && it != 0L })

/** [activity] as it reads at [nowMillis]; [stopping] is the optimistic mark of a stop request out. */
fun activityView(activity: NativeActivity, stopping: Boolean = false, nowMillis: Long = 0L): ActivityView {
    val status = activity.status
    val isStopping = status == NativeActivityStatus.STOPPING || (stopping && status == NativeActivityStatus.RUNNING)
    val running = status == NativeActivityStatus.RUNNING || isStopping
    val elapsed = activityElapsedMs(activity, nowMillis)
    val canStop = running && !isStopping && activity.stop != null
    val tone = when {
        running -> ActivityTone.ACTIVE
        activityFailed(activity) -> ActivityTone.FAILED
        status == NativeActivityStatus.COMPLETED -> ActivityTone.DONE
        else -> ActivityTone.MUTED
    }
    val expandable = !activity.detail.isNullOrBlank() || !activity.blobRef.isNullOrBlank()
    val stopWarning = if (activity.stop?.stopsAll == true) L10n.uiText("activity.stopAll") else null

    fun view(label: String, subject: String?, stats: List<String?>) = ActivityView(
        kind = activity.kind,
        running = running,
        stopping = isStopping,
        tone = tone,
        label = label,
        subject = subject?.takeIf { it.isNotBlank() },
        stats = stats.filterNotNull().filter { it.isNotBlank() }.joinToString(" · ").ifEmpty { null },
        expandable = expandable,
        canStop = canStop,
        stopWarning = stopWarning,
    )

    return when (activity.kind) {
        NativeActivityKind.COMPACTION -> when {
            isStopping -> view(L10n.uiText("activity.compaction.stopping"), null, listOf(elapsed?.let(::activityClock)))
            running -> view(L10n.uiText("activity.compaction.running"), null, listOf(elapsed?.let(::activityClock)))
            status == NativeActivityStatus.COMPLETED -> {
                val compaction = activity.compaction
                val pre = compaction?.preTokens
                val post = compaction?.postTokens
                val tokens = when {
                    pre != null && post != null -> "${activityTokens(pre)} → ${activityTokens(post)}"
                    pre != null -> L10n.uiText("activity.compaction.before", activityTokens(pre))
                    post != null -> L10n.uiText("activity.compaction.after", activityTokens(post))
                    else -> null
                }
                view(L10n.uiText("activity.compaction.done"), null, listOf(tokens, elapsed?.let(::activityDuration)))
            }
            status == NativeActivityStatus.FAILED -> view(L10n.uiText("activity.compaction.failed"), null, listOf(elapsed?.let(::activityDuration)))
            status == NativeActivityStatus.STOPPED -> view(L10n.uiText("activity.compaction.stopped"), null, listOf(elapsed?.let(::activityDuration)))
            else -> view(L10n.uiText("activity.compaction.idle"), null, emptyList())
        }

        NativeActivityKind.BACKGROUND_TASK -> {
            val task = activity.task
            val kindLabel = taskKindLabel(task?.kind)
            val subject = activity.title.takeIf { it.isNotBlank() } ?: task?.command
            val exit = task?.exitCode?.let { "exit $it" }
            val state = when {
                isStopping -> L10n.uiText("activity.state.stopping")
                running -> L10n.uiText("activity.state.running")
                status == NativeActivityStatus.COMPLETED -> L10n.uiText("activity.state.done")
                status == NativeActivityStatus.FAILED -> L10n.uiText("activity.state.failed")
                status == NativeActivityStatus.STOPPED -> L10n.uiText("activity.state.stopped")
                else -> null
            }
            val time = elapsed?.let { if (running) activityClock(it) else activityDuration(it) }
            view(kindLabel, subject, listOf(state, if (running) null else exit, time))
        }

        NativeActivityKind.LOCAL_COMMAND, NativeActivityKind.UNKNOWN -> {
            val name = activity.command?.name?.takeIf { it.isNotBlank() }
            val line = activity.title.takeIf { it.isNotBlank() }
                ?: activity.detail?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim()
            view(if (name != null) "/$name" else L10n.uiText("activity.kind.local"), line, emptyList())
        }
    }
}

private fun taskKindLabel(kind: String?): String = when (kind) {
    "shell" -> L10n.uiText("activity.kind.shell")
    "monitor" -> L10n.uiText("activity.kind.monitor")
    "agent" -> L10n.uiText("activity.kind.agent")
    "workflow" -> L10n.uiText("activity.kind.workflow")
    "terminal" -> L10n.uiText("activity.kind.terminal")
    else -> L10n.uiText("activity.kind.background")
}

/** The time an activity has taken: its own duration once over, the time since it started while it runs. */
private fun activityElapsedMs(activity: NativeActivity, nowMillis: Long): Long? {
    if (!activity.status.active) {
        activity.durationMs?.let { return it.coerceAtLeast(0L) }
        val start = instantMillis(activity.startedAt) ?: return null
        val end = instantMillis(activity.endedAt) ?: return null
        return (end - start).coerceAtLeast(0L)
    }
    val start = instantMillis(activity.startedAt) ?: return activity.durationMs?.coerceAtLeast(0L)
    if (nowMillis <= 0L) return activity.durationMs?.coerceAtLeast(0L)
    return (nowMillis - start).coerceAtLeast(0L)
}

/** `0:45`, `12:03`, `1:02:03`: a running clock keeps its width as it counts. */
fun activityClock(millis: Long): String {
    val seconds = (millis / 1_000L).coerceAtLeast(0L)
    val hours = seconds / 3_600L
    val minutes = (seconds / 60L) % 60L
    val rest = seconds % 60L
    val two = { value: Long -> if (value < 10) "0$value" else value.toString() }
    return if (hours > 0) "$hours:${two(minutes)}:${two(rest)}" else "$minutes:${two(rest)}"
}

/** `45 秒`, `1 分 50 秒`, `2 分`, `1 小时 2 分`: a finished duration in words. */
fun activityDuration(millis: Long): String {
    val seconds = (millis / 1_000L).coerceAtLeast(0L)
    val hours = seconds / 3_600L
    val minutes = (seconds / 60L) % 60L
    val rest = seconds % 60L
    return when {
        hours > 0 -> if (minutes > 0) {
            L10n.uiText("activity.duration.hoursMinutes", hours, minutes)
        } else {
            L10n.uiText("activity.duration.hours", hours)
        }
        minutes > 0 -> if (rest > 0) {
            L10n.uiText("activity.duration.minutesSeconds", minutes, rest)
        } else {
            L10n.uiText("activity.duration.minutes", minutes)
        }
        else -> L10n.uiText("activity.duration.seconds", rest)
    }
}

/** `9,800`, then `1.3 万`, `43.5 万`, `120 万`: token counts the way a person says them. */
fun activityTokens(count: Long): String {
    if (count < 10_000L) return count.toString()
    // English counts in K/M; the source locale keeps 万.
    if (L10n.locale == "en") return compactCount(count.toDouble())
    val tenths = (count + 500L) / 1_000L
    return if (tenths % 10L == 0L) {
        L10n.uiText("activity.tokens.wan", tenths / 10L)
    } else {
        L10n.uiText("activity.tokens.wanDecimal", tenths / 10L, tenths % 10L)
    }
}

/**
 * What sits above the composer: whether the CLI is compacting, and the background tasks that run.
 * [background] is the server's count (`NativeStatus.activity`) when it reports one, otherwise the
 * running tasks the transcript names; [tasks] are those the transcript can list. A server that sends
 * no activity at all leaves this empty, and the host keeps its older "后台 N 个任务运行中" hint.
 */
data class ActivityDock(
    val compacting: Boolean = false,
    val background: Int = 0,
    val tasks: List<NativeActivity> = emptyList(),
) {
    val visible: Boolean get() = compacting || background > 0
}

/** The newest state of every activity in [timeline], in transcript order. */
fun timelineActivities(timeline: List<riffet.core.TimelineItem>): List<NativeActivity> =
    timeline.mapNotNull { (it as? riffet.core.TimelineItem.Activity)?.activity }

fun activityDock(summary: NativeActivitySummary?, activities: List<NativeActivity>): ActivityDock {
    val tasks = activities.filter { it.kind == NativeActivityKind.BACKGROUND_TASK && it.status.active }
    val compacting = summary?.compacting ?: activities.any { it.kind == NativeActivityKind.COMPACTION && it.status.active }
    return ActivityDock(compacting = compacting, background = summary?.background ?: tasks.size, tasks = tasks)
}
