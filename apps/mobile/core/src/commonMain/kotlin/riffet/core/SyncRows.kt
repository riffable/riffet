package riffet.core

import riffet.contracts.NativeActivityKind
import riffet.contracts.Run
import riffet.contracts.TimelineRow
import riffet.contracts.WorkbenchEvent
import kotlinx.serialization.json.JsonObject

/*
 * Sync v3 (docs/SYNC-V3.md, 时间线由服务端折叠): the server folds the timeline and sends its rows;
 * these build the UI's [TimelineItem] from them, so Swift and Compose keep their row types. A row's
 * `pos` stands in for the event sequence the v2 projection ordered by (search targets, scroll
 * anchors), and its source ids become the event's aliases, which is what receipts and marks match on.
 */

/** Where the server files a Run its transcript has not echoed yet: after every real row. */
const val PENDING_ROW_POS: Long = 1L shl 52

/** [row] as the timeline shows it, with [run] on a user row; null for a row this build does not show. */
fun timelineItem(row: TimelineRow, sessionId: String, run: Run? = null, failureShown: Boolean = false): TimelineItem? {
    val event = rowEvent(row, sessionId)
    return when (val body = row.body) {
        is TimelineRow.Body.User -> TimelineItem.User(
            key = row.key,
            text = body.text,
            event = event,
            attachments = body.attachments.map { attachment ->
                val sized = attachment.width != null && attachment.height != null
                UserAttachment(
                    name = attachment.name,
                    id = attachment.id,
                    path = attachment.path,
                    type = attachment.type,
                    mimeType = attachment.mimeType,
                    width = attachment.width.takeIf { sized },
                    height = attachment.height.takeIf { sized },
                )
            },
            run = run,
            references = body.references.orEmpty(),
            failureShown = failureShown,
            from = str(event.data["from"])?.takeIf { it == "coordinator" || it == "peer" },
        )
        is TimelineRow.Body.Assistant -> TimelineItem.Assistant(
            key = row.key,
            text = body.text,
            event = event,
            phase = when (body.phase) {
                TimelineRow.Phase.COMMENTARY -> AssistantPhase.COMMENTARY
                TimelineRow.Phase.FINAL_ANSWER -> AssistantPhase.FINAL_ANSWER
                TimelineRow.Phase.UNKNOWN, null -> null
            },
        )
        is TimelineRow.Body.Thought -> TimelineItem.Thought(
            key = row.key,
            text = body.text,
            channel = if (body.channel == TimelineRow.ReasoningChannel.THINKING) ReasoningChannel.THINKING else ReasoningChannel.NARRATION,
            event = event,
        )
        is TimelineRow.Body.Tool -> TimelineItem.Tool(key = row.key, event = event, job = body.job, subagent = body.subagent, activity = body.activity)
        is TimelineRow.Body.Plan -> TimelineItem.Plan(key = row.key, entries = body.entries, event = event)
        is TimelineRow.Body.Image -> TimelineItem.Image(key = row.key, src = body.src, event = event)
        is TimelineRow.Body.Status -> TimelineItem.Status(
            key = row.key,
            tone = if (body.tone == TimelineRow.Tone.DANGER) StatusTone.DANGER else StatusTone.MUTED,
            text = body.text,
            event = event,
            detail = body.detail,
        )
        is TimelineRow.Body.TaskNotification -> TimelineItem.TaskNotification(
            key = row.key,
            taskId = body.taskId,
            taskKind = body.taskKind,
            status = when (body.status) {
                TimelineRow.TaskNotificationStatus.RUNNING -> TaskNotificationStatus.RUNNING
                TimelineRow.TaskNotificationStatus.COMPLETED -> TaskNotificationStatus.COMPLETED
                TimelineRow.TaskNotificationStatus.FAILED -> TaskNotificationStatus.FAILED
                TimelineRow.TaskNotificationStatus.CANCELLED -> TaskNotificationStatus.CANCELLED
                TimelineRow.TaskNotificationStatus.UNKNOWN -> TaskNotificationStatus.UNKNOWN
            },
            sourceStatus = body.sourceStatus,
            title = body.title,
            command = body.command,
            detail = body.detail,
            jobResult = body.jobResult?.let { result ->
                val status = when (result.status) {
                    TimelineRow.TaskNotificationResult.Status.RUNNING -> TaskNotificationResultStatus.RUNNING
                    TimelineRow.TaskNotificationResult.Status.SUCCEEDED -> TaskNotificationResultStatus.SUCCEEDED
                    TimelineRow.TaskNotificationResult.Status.FAILED -> TaskNotificationResultStatus.FAILED
                    TimelineRow.TaskNotificationResult.Status.UNKNOWN -> return@let null
                }
                TaskNotificationResult(result.id, status, result.exitCode, result.runningMs)
            },
            subagentToolCallId = body.subagentToolCallId,
            tokens = body.tokens,
            durationMs = body.durationMs,
            event = event,
        )
        // Like the v2 projection, an activity of a kind this build cannot draw is left out.
        is TimelineRow.Body.Activity -> body.activity.takeIf { it.kind != NativeActivityKind.UNKNOWN }
            ?.let { TimelineItem.Activity(key = row.key, activity = it, event = event) }
        is TimelineRow.Body.Unknown -> null
    }
}

/**
 * The Run a user row stands for: the row's own `runId`, else its key for a pending row
 * (`user:<commandId>`). Only user rows carry one.
 */
fun rowRun(row: TimelineRow, runsById: Map<String, Run>, runsByCommand: Map<String, Run>): Run? {
    if (row.body !is TimelineRow.Body.User) return null
    row.runId?.let(runsById::get)?.let { return it }
    return if (row.key.startsWith(USER_KEY_PREFIX)) runsByCommand[row.key.removePrefix(USER_KEY_PREFIX)] else null
}

/** The key the server gives [run]'s user row; a local row for it uses the same, so the server's replaces it. */
fun userRowKey(run: Run): String = USER_KEY_PREFIX + run.commandId.ifEmpty { run.id }

/**
 * A sent message the server has no row for yet (the outbox's optimistic run, or a receipt whose
 * pending row has not arrived), drawn as the v2 projection drew its pending runs.
 */
fun pendingUserItem(run: Run): TimelineItem.User {
    val native = run.native
    val event = ProjectedEvent(
        base = WorkbenchEvent(
            sequence = PENDING_ROW_POS,
            sessionId = run.sessionId,
            runId = run.id,
            nativeTurnId = native?.nativeTurnId,
            type = "user_message_chunk",
            data = JsonObject(emptyMap()),
            createdAt = run.createdAt,
        ),
        projectionKey = "pending:${run.id}",
        sourceEvents = emptyList(),
    )
    val attachments = native?.input?.attachmentIds?.map { UserAttachment(id = it, name = it) }.orEmpty()
    return TimelineItem.User(key = userRowKey(run), text = run.prompt, event = event, attachments = attachments, run = run)
}

/**
 * The row's source event in the shape [TimelineItem] carries: `lastAt` becomes the time of its
 * latest source (what [timelineItemTime] reads), and every source id is an alias.
 */
private fun rowEvent(row: TimelineRow, sessionId: String): ProjectedEvent {
    val source = row.event
    val base = WorkbenchEvent(
        sequence = row.pos,
        sessionId = sessionId,
        runId = source.runId,
        type = source.type,
        data = source.data,
        createdAt = source.createdAt,
        nativeId = source.nativeId,
        nativeAliases = source.sourceIds.filter { it.isNotEmpty() && it != source.nativeId }.takeIf { it.isNotEmpty() },
        nativeTurnId = source.nativeTurnId,
    )
    val latest = if (source.lastAt != source.createdAt) {
        listOf(WorkbenchEvent(sequence = row.pos, sessionId = sessionId, runId = source.runId, type = source.type, createdAt = source.lastAt))
    } else {
        emptyList()
    }
    return ProjectedEvent(base = base, projectionKey = row.key, sourceEvents = latest, turn = row.turn)
}

private const val USER_KEY_PREFIX = "user:"
