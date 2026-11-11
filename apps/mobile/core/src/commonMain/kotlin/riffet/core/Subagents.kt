package riffet.core

import riffet.contracts.NativeHistoryState
import riffet.contracts.NativeJob
import riffet.contracts.WorkbenchEvent
import riffet.contracts.TurnOutlineV3
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** A subagent's transcript as a conversation holds it: by the tool call that spawned it. */

data class SubagentTranscript(
    val agentId: String,
    val subagentType: String? = null,
    val title: String? = null,
    val prompt: String? = null,
    val model: String? = null,
    val events: List<WorkbenchEvent>,
    val history: NativeHistoryState? = null,
    val resetVersion: Int? = null,
    val running: Boolean? = null,
    /** The child's live turn (`runId` of its rows) while it runs, when its backend names one. */
    val activeTurnId: String? = null,
    val status: TurnOutlineV3.Status? = null,
    val turnId: String? = null,
    val startedAt: String? = null,
    val endedAt: String? = null,
)

data class StoredSubagent(val toolCallId: String, val transcript: SubagentTranscript)

/**
 * One subagent the session has spawned, as the session sheet lists it.
 *
 * The web reads its subagent *store* — the child transcripts the stream pushes — and names each row
 * from the Task call's `description`, falling back to the child's own first user message
 * (`SessionWorkActions.tsx`'s `SubagentRow`). The phone reads both: the `subagent` call the server
 * projects into the parent transcript carries the description, the prompt and the type, and the
 * stored child transcripts add the subagents whose call the parent has not written yet. Cursor writes
 * a foreground Task call only when the step ends, so while the child works the store is all there is.
 */
data class SubagentEntry(
    val toolCallId: String,
    /** The call's `description`, else the first line of its prompt, else the type. */
    val name: String,
    /**
     * The subagent type, omitted when the row already reads it.
     *
     * Deliberately not the web's choice of second line: the web shows the call's *prompt* there
     * (`SessionWorkActions.tsx`'s `detail`), which for DSH is a paragraph of instructions that a
     * phone row can only truncate into noise. The type is the part the name does not already say.
     */
    val detail: String?,
    val state: SubagentState,
)

/**
 * The web's three dot tones (`SessionWorkActions.tsx`: accent, success, idle) plus failure, which
 * the CLI's task notification reports and a phone row has room to show.
 */
enum class SubagentState { RUNNING, DONE, FAILED, UNKNOWN }

/** The tool call an item stands for. Every tool row has one; `null` only if the event is malformed. */
fun TimelineItem.toolCallId(): String? {
    val value = event.data["toolCallId"] as? JsonPrimitive ?: return null
    if (!value.isString) return null
    return value.content.takeIf { it.isNotEmpty() }
}

/** The web's `firstLine`: the label of last resort for a Task call that carries no description. */
private fun firstLine(text: String): String =
    text.split('\n').firstOrNull { it.isNotBlank() }?.trim().orEmpty()

private fun text(element: JsonElement?): String? {
    val value = element as? JsonPrimitive ?: return null
    return if (value.isString) value.content else null
}

private fun notificationState(notification: TimelineItem.TaskNotification): SubagentState = when (notification.status) {
    TaskNotificationStatus.COMPLETED, TaskNotificationStatus.CANCELLED -> SubagentState.DONE
    TaskNotificationStatus.FAILED -> SubagentState.FAILED
    TaskNotificationStatus.RUNNING -> SubagentState.RUNNING
    TaskNotificationStatus.UNKNOWN -> SubagentState.UNKNOWN
}

private fun SubagentTranscript.state(notification: TimelineItem.TaskNotification?): SubagentState {
    // The server identifies the current execution round; delayed task notifications can arrive
    // after a resume and still describe the old round, regardless of their delivery timestamp.
    when (status) {
        TurnOutlineV3.Status.RUNNING -> return SubagentState.RUNNING
        TurnOutlineV3.Status.COMPLETED, TurnOutlineV3.Status.CANCELLED -> return SubagentState.DONE
        TurnOutlineV3.Status.FAILED -> return SubagentState.FAILED
        else -> Unit
    }
    val current = when (running) {
        true -> SubagentState.RUNNING
        false -> SubagentState.DONE
        null -> SubagentState.UNKNOWN
    }
    if (notification == null) return current
    val notifiedAt = parseMillis(timelineItemTime(notification))
    val started = parseMillis(startedAt)
    val ended = parseMillis(endedAt)
    // Agent ids survive resumes: only a notification belonging to the current or a newer turn
    // can override its state. Old servers have no turn timing, so their live signal wins.
    if (notifiedAt != null && started != null && notifiedAt < started) return current
    if (notifiedAt != null && ended != null && notifiedAt <= ended) return current
    if (current == SubagentState.RUNNING && started == null) return current
    return notificationState(notification)
}

private fun specificType(type: String?): String? = type?.trim()?.takeIf { it.isNotEmpty() }?.takeUnless {
    it.lowercase().filterNot { character -> character == '-' || character == '_' || character.isWhitespace() } in setOf("generalpurpose", "subagent")
}

/**
 * What a Task call's own status says about its child. A foreground call completes when the child
 * does; a background one completes as soon as the child is *launched*, so its success says nothing
 * about whether the child is still working.
 */
private fun callState(data: JsonObject, subagent: JsonObject): SubagentState {
    val status = text(data["status"]).orEmpty()
    if (status in activeToolStates) return SubagentState.RUNNING
    if (status == "failed") return SubagentState.FAILED
    if (status == "cancelled") return SubagentState.DONE
    val result = data["subagentResult"] as? JsonObject
    val background = (subagent["background"] as? JsonPrimitive)?.content == "true" ||
        (result?.get("background") as? JsonPrimitive)?.content == "true"
    return if (status == "completed" && !background) SubagentState.DONE else SubagentState.UNKNOWN
}

/**
 * The subagents [items] spawned, running first and stable in call order within each group.
 *
 * [items] must be *projected* items (`TimelineGrouping.items`), not raw events: the server sends a
 * DSH call's arguments with the call and its status with the later update, and only the projection
 * merges the two — reading raw events would leave every subagent looking like it is still running.
 *
 * [stored] are the child transcripts the stream pushed. A child the parent has no call for yet is
 * listed after the calls, named by its first user message; where the stream says whether a child is
 * working, that wins over the call's status, which a Cursor parent only writes once the step ends.
 * Task notifications name the child by agent id; turn timing prevents an earlier failure from
 * overriding a resumed child's current state.
 */
fun subagentEntries(items: List<TimelineItem>, stored: List<StoredSubagent> = emptyList()): List<SubagentEntry> {
    val storedByCall = stored.associateBy { it.toolCallId }
    val finished = HashMap<String, TimelineItem.TaskNotification>()
    for (item in items) {
        if (item !is TimelineItem.TaskNotification || item.taskKind != "subagent" || item.status == TaskNotificationStatus.UNKNOWN) continue
        val agentId = item.taskId ?: continue
        val previous = finished[agentId]
        if (previous == null || (parseMillis(timelineItemTime(item)) ?: Long.MIN_VALUE) >= (parseMillis(timelineItemTime(previous)) ?: Long.MIN_VALUE)) finished[agentId] = item
    }
    val entries = LinkedHashMap<String, SubagentEntry>()
    for (item in items) {
        val id = item.toolCallId() ?: continue
        val subagent = item.event.data["subagent"] as? JsonObject ?: continue
        val type = text(subagent["type"])?.takeIf { it.isNotBlank() }
        val description = specificType(text(subagent["description"])?.trim()).orEmpty()
        val streamedTitle = specificType(storedByCall[id]?.transcript?.title?.trim()).orEmpty()
        val name = description
            .ifEmpty { streamedTitle }
            .ifEmpty { specificType(firstLine(text(subagent["prompt"]).orEmpty())).orEmpty() }
            .ifEmpty { specificType(type) ?: "subagent" }
        val agentId = text((item.event.data["subagentResult"] as? JsonObject)?.get("agentId"))
        entries[id] = SubagentEntry(
            toolCallId = id,
            name = name,
            detail = specificType(type)?.takeIf { it != name },
            state = agentId?.let { finished[it] }?.let(::notificationState) ?: callState(item.event.data, subagent),
        )
    }
    for (child in stored) {
        val transcript = child.transcript
        val known = entries[child.toolCallId]
        if (known != null) {
            entries[child.toolCallId] = known.copy(state = transcript.state(finished[transcript.agentId]))
            continue
        }
        val type = transcript.subagentType?.takeIf { it.isNotBlank() }
        val prompt = transcript.events.firstNotNullOfOrNull { event ->
            if (event.type != "user_message_chunk") null else specificType(firstLine(chunkText(event)))
        }
        val name = specificType(transcript.title?.trim())?.takeIf { it.isNotBlank() } ?: prompt ?: specificType(type) ?: "subagent"
        entries[child.toolCallId] = SubagentEntry(
            toolCallId = child.toolCallId,
            name = name,
            detail = specificType(type)?.takeIf { it != name },
            state = transcript.state(finished[transcript.agentId]),
        )
    }
    return entries.values.sortedBy { it.state != SubagentState.RUNNING }
}
