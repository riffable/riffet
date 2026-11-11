package riffet.ui.composer

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import riffet.core.TimelineItem
import riffet.core.TimelineItemKind
import riffet.core.kind
import riffet.core.toolView
import riffet.i18n.L10n

/*
 * What the docks above the composer own: the agent's todo list and the harness's goal. The rules
 * decide what the transcript leaves out (`visibleTimeline`), so every client renders from these.
 */

/** One renderable todo row, normalized from a raw `plan` entry. */
data class TodoEntry(val content: String, val status: TodoStatus)

enum class TodoStatus { PENDING, IN_PROGRESS, COMPLETED }

/** Normalize the raw `plan` payload into renderable todo rows; the web's `todoEntries`. */
fun todoEntries(entries: List<JsonObject>): List<TodoEntry> = entries.mapNotNull { entry ->
    val content = stringField(entry, "content") ?: stringField(entry, "title") ?: return@mapNotNull null
    if (content.isEmpty()) return@mapNotNull null
    val status = when (stringField(entry, "status")) {
        "completed" -> TodoStatus.COMPLETED
        "in_progress" -> TodoStatus.IN_PROGRESS
        else -> TodoStatus.PENDING
    }
    TodoEntry(content, status)
}

/**
 * Normalize a plan without exporting its `List<JsonObject>` through Swift. Kotlin/Native exposes
 * that list as Foundation dictionaries; passing those dictionaries back through `List<JsonObject>`
 * loses their concrete JSON type and can crash when the parser reads an entry.
 */
fun todoEntries(plan: TimelineItem.Plan): List<TodoEntry> = todoEntries(plan.entries)

private fun stringField(entry: JsonObject, name: String): String? =
    (entry[name] as? JsonPrimitive)?.takeIf { it.isString }?.content

/** `2 已完成 · 1 进行中 · 3 待处理`, omitting empty segments; the web's `todoProgress`. */
fun todoProgress(entries: List<TodoEntry>): String {
    val done = entries.count { it.status == TodoStatus.COMPLETED }
    val active = entries.count { it.status == TodoStatus.IN_PROGRESS }
    val pending = entries.size - done - active
    return listOf(
        done to L10n.uiText("todo.done"),
        active to L10n.uiText("todo.active"),
        pending to L10n.uiText("todo.pending"),
    )
        .filter { (count, _) -> count > 0 }
        .joinToString(" · ") { (count, label) -> "$count $label" }
}

/**
 * The newest plan is the checklist the dock owns. Once every entry is done *and* the conversation
 * has moved on to a later user turn, the list has done its job and is dropped — the web's
 * `todoEntries` in `NativeSession.tsx`.
 */
fun latestTodoEntries(timeline: List<TimelineItem>): List<JsonObject>? {
    val planIndex = timeline.indexOfLast { it.kind == TimelineItemKind.PLAN }
    if (planIndex < 0) return null
    val entries = (timeline[planIndex] as TimelineItem.Plan).entries
    val todos = todoEntries(entries)
    val finished = todos.isNotEmpty() && todos.all { it.status == TodoStatus.COMPLETED }
    val laterTurn = timeline.subList(planIndex + 1, timeline.size).any { it.kind == TimelineItemKind.USER }
    return if (finished && laterTurn) null else entries
}

/**
 * What the transcript shows. A queued message is waiting for its turn and a plan is a live checklist
 * rather than a message, so the dock above the composer owns both while it is showing them; hiding
 * them here also keeps the turn rail and the message timeline agreeing on what has actually been
 * sent.
 *
 * `queuedRunIds` comes from the store's `queued` flow, so this rule cannot drift from the queue
 * card. `dockOwnsPlan` is true while [latestTodoEntries] is showing a list. This is the web's
 * `visibleTimeline` exactly: the filter runs at all only when there is something to hide, and once
 * it runs it drops every plan row — even a dropped, finished one — alongside the queued rows.
 * A loaded tool owns its attached activity header; independent activity rows remain visible when
 * their tool is outside the window, so paging never removes the only live stop action.
 */
fun visibleTimeline(
    timeline: List<TimelineItem>,
    queuedRunIds: Set<String>,
    dockOwnsPlan: Boolean,
): List<TimelineItem> {
    val mergedActivities = timeline.mapNotNull { (it as? TimelineItem.Tool)?.activity?.let { activity -> activity.id to activity.toolCallId } }.toSet()
    if (queuedRunIds.isEmpty() && !dockOwnsPlan && mergedActivities.isEmpty()) return timeline
    val visible = timeline.filter { item ->
        if (item is TimelineItem.Activity && (item.activity.id to item.activity.toolCallId) in mergedActivities) return@filter false
        if ((queuedRunIds.isNotEmpty() || dockOwnsPlan) && item.kind == TimelineItemKind.PLAN) return@filter false
        val runId = (item as? TimelineItem.User)?.run?.id
        runId == null || runId !in queuedRunIds
    }
    return if (visible.size == timeline.size) timeline else visible
}

/**
 * One goal phase, in the harness's own vocabulary.
 *
 * `create_goal` carries no action at all - setting a goal is not a transition - so a freshly created
 * goal reads as [goalStatusLabel]'s default, "进行中", and only `update_goal` names a phase.
 */
private val GOAL_ACTIONS = mapOf(
    "edit" to "goal.updated",
    "pause" to "goal.paused",
    "resume" to "goal.resuming",
    "complete" to "goal.completed",
    "blocked" to "goal.blocked",
)

/** What the phase reads as. An action this build does not know still reads as an active goal. */
fun goalStatusLabel(action: String?): String = L10n.uiText(GOAL_ACTIONS[action] ?: "goal.active")

/** The session's goal, as the newest goal tool call describes it. */
data class SessionGoal(
    val objective: String,
    val action: String?,
    val blockedReason: String?,
)

private fun goalField(input: JsonObject?, key: String): String? =
    (input?.get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }

/**
 * The newest goal in the transcript, or null when the session has none.
 *
 * `create_goal` and an `edit` carry the objective; `pause` / `resume` / `complete` / `blocked` carry
 * only the action, so the objective is carried forward from the newest call that had one - otherwise
 * completing a goal would replace what the session is about with the word "已完成".
 *
 * A finished goal is dropped once the conversation has moved on to a later user turn, exactly as the
 * todo dock drops a finished checklist: it has said everything it had to say.
 */
fun latestGoal(timeline: List<TimelineItem>): SessionGoal? {
    var newestIndex = -1
    var action: String? = null
    var blockedReason: String? = null
    var objective: String? = null
    for (index in timeline.indices.reversed()) {
        val tool = timeline[index] as? TimelineItem.Tool ?: continue
        // `toolView` parses the whole call; its kind is just `data.kind`, so most rows are skipped here.
        val kind = tool.event.base.data["kind"] as? JsonPrimitive
        if (kind == null || !kind.isString || kind.content != "goal") continue
        val view = toolView(tool.event.base, null)
        if (view.kind != "goal") continue
        val input = view.rawInput as? JsonObject
        if (newestIndex < 0) {
            newestIndex = index
            action = goalField(input, "action")
            blockedReason = goalField(input, "blocked_reason") ?: goalField(input, "blockedReason")
        }
        if (objective == null) objective = goalField(input, "objective")
        if (objective != null) break
    }
    if (newestIndex < 0) return null
    if (action == "complete") {
        val laterTurn = timeline.drop(newestIndex + 1).any { it.kind == TimelineItemKind.USER }
        if (laterTurn) return null
    }
    return SessionGoal(objective = objective.orEmpty(), action = action, blockedReason = blockedReason)
}
