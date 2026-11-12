package riffet.ui.composer

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import riffet.contracts.SessionGoal
import riffet.core.TimelineItem
import riffet.core.TimelineItemKind
import riffet.core.kind
import riffet.i18n.L10n
import riffet.ui.timeline.activityTokens

/*
 * What the docks above the composer own: the agent's todo list and the session's goal. The rules
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

/** The status words; a status this build does not know reads as an active goal. */
private val GOAL_STATUSES = mapOf(
    "active" to "goal.active",
    "paused" to "goal.paused",
    "blocked" to "goal.blocked",
    "usage_limited" to "goal.usageLimited",
    "budget_limited" to "goal.budgetLimited",
    "complete" to "goal.completed",
)

/**
 * What the goal's status reads as. A goal stopped by a limit also says how many tokens it used (against
 * its budget when it has one): that is what the reader decides on next.
 */
fun goalStatusLabel(goal: SessionGoal): String {
    val label = L10n.uiText(GOAL_STATUSES[goal.status] ?: "goal.active")
    val used = goal.tokensUsed?.takeIf { goal.status == "usage_limited" || goal.status == "budget_limited" } ?: return label
    val budget = goal.tokenBudget
    val tokens = if (budget != null) L10n.uiText("goal.tokensOfBudget", activityTokens(used), activityTokens(budget)) else L10n.uiText("goal.tokens", activityTokens(used))
    return "$label · $tokens"
}
