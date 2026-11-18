package riffet.core

import riffet.contracts.NativeActivity
import riffet.contracts.NativeActivityKind
import riffet.contracts.NativeDeliveryState
import riffet.contracts.NativeJob
import riffet.contracts.Run
import riffet.contracts.RunState
import riffet.contracts.WorkbenchEvent
import riffet.contracts.RiffetJson
import riffet.contracts.samePromptText
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * The conversation's rows as the apps draw them. The server folds the transcript into timeline rows
 * (docs/SYNC-V3.md, 时间线由服务端折叠); `SyncRows.kt` makes these items from them, and the turn grouping
 * below (a port of `packages/timeline/src/timelineTurns.ts`) sorts them into turns.
 *
 * Nothing in this module may import a platform API: it lives in commonMain so iOS reuses it
 * unchanged (docs/MOBILE.md, "架构").
 */

/** `group` heads a run of adjacent choices, e.g. the provider a batch of models came from. */
data class Choice(
    val id: String,
    val label: String,
    val description: String? = null,
    val group: String? = null,
)

data class SlashCommand(
    val name: String,
    val description: String? = null,
    val hint: String? = null,
)

/**
 * Context-window usage reported by the agent. Absent whenever the agent does not report it —
 * we never guess this number.
 */
data class ContextUsage(
    val used: Long,
    val size: Long,
    val cost: ContextCost? = null,
    val breakdown: List<ContextBreakdown>? = null,
)

data class ContextCost(val amount: Double, val currency: String)

data class ContextBreakdown(val id: String, val label: String, val tokens: Long)

/**
 * One attachment on a user message. `id` is present for locally sent attachments, `path` for a
 * native file a CLI recorded; the pixel size is optional because CLI receipts rarely carry it.
 */
data class UserAttachment(
    val name: String,
    val id: String? = null,
    val path: String? = null,
    val type: String? = null,
    val mimeType: String? = null,
    val width: Long? = null,
    val height: Long? = null,
)

data class SessionConfig(
    val ready: Boolean,
    val modes: List<Choice>,
    val models: List<Choice>,
    val modelConfigId: String,
    val mode: String? = null,
    val model: String? = null,
    val params: List<ModelParam> = emptyList(),
    val commands: List<SlashCommand> = emptyList(),
    val usage: ContextUsage? = null,
)

private class ConfigBuilder {
    var ready = false
    var modes = mutableListOf<Choice>()
    var models = mutableListOf<Choice>()
    var modelConfigId = ""
    var mode: String? = null
    var model: String? = null
    var params = mutableListOf<ModelParam>()
    var commands = mutableListOf<SlashCommand>()
    var usage: ContextUsage? = null

    fun build() = SessionConfig(
        ready = ready,
        modes = modes.toList(),
        models = models.toList(),
        modelConfigId = modelConfigId,
        mode = mode,
        model = model,
        params = params.toList(),
        commands = commands.toList(),
        usage = usage,
    )
}

/** Last value wins per id; first-seen position is kept, matching `new Map(pairs).values()`. */
private fun selectChoices(value: JsonElement?): List<Choice> {
    val byId = LinkedHashMap<String, Choice>()
    fun visit(item: JsonElement?) {
        val record = item as? JsonObject ?: return
        val options = record["options"]
        if (options is JsonArray) {
            options.forEach { visit(it) }
            return
        }
        val id = str(record["value"]) ?: str(record["modelId"]) ?: str(record["id"]) ?: return
        val label = str(record["name"]) ?: str(record["label"]) ?: str(record["title"]) ?: id
        byId[id] = Choice(id = id, label = cleanLabel(label), description = str(record["description"]))
    }
    if (value is JsonArray) value.forEach { visit(it) }
    return byId.values.toList()
}

private fun applyConfigOptions(config: ConfigBuilder, options: List<JsonObject>) {
    val modelOption = options.firstOrNull { option ->
        (str(option["id"]) == "model" || str(option["category"]) == "model") && str(option["type"]) == "select"
    }
    val modeOption = options.firstOrNull { option ->
        str(option["category"]) == "mode" && str(option["type"]) == "select"
    }
    if (modelOption != null) {
        config.modelConfigId = str(modelOption["id"]) ?: config.modelConfigId
        val choices = selectChoices(modelOption["options"])
        if (choices.isNotEmpty()) config.models = choices.toMutableList()
        str(modelOption["currentValue"])?.let { config.model = it }
        config.params = paramsFromOptions(options.map { it }).toMutableList()
    }
    if (modeOption != null) {
        val choices = selectChoices(modeOption["options"])
        if (choices.isNotEmpty()) config.modes = choices.toMutableList()
        str(modeOption["currentValue"])?.let { config.mode = it }
    }
}

/** The server patches `modes` and `models` with the applied selection, so they win over the snapshot. */
private fun applyDetails(config: ConfigBuilder, details: JsonObject) {
    config.ready = true
    applyConfigOptions(config, records(details["configOptions"]))
    val modes = details["modes"] as? JsonObject
    val advertised = records(modes?.get("availableModes")).mapNotNull { mode ->
        val id = str(mode["id"]) ?: return@mapNotNull null
        Choice(id = id, label = cleanLabel(str(mode["name"]) ?: id), description = str(mode["description"]))
    }
    if (advertised.isNotEmpty()) config.modes = advertised.toMutableList()
    str(modes?.get("currentModeId"))?.let { config.mode = it }
    val modelDetails = details["models"] as? JsonObject
    val rawModels = if (details["models"] is JsonArray) details["models"] else modelDetails?.get("availableModels")
    val modelChoices = selectChoices(rawModels)
    if (modelChoices.isNotEmpty()) config.models = modelChoices.toMutableList()
    str(modelDetails?.get("currentModelId"))?.let { config.model = it }
}

/** Replays negotiation events in order so the latest advertised modes, models and commands win. */
fun deriveSessionConfig(events: List<WorkbenchEvent>): SessionConfig {
    val config = ConfigBuilder()
    for (event in events) {
        when {
            (event.type == "session_ready" || event.type == "session_configured") && isRecord(event.data["details"]) ->
                applyDetails(config, event.data["details"] as JsonObject)

            event.type == "current_mode_update" && str(event.data["currentModeId"]) != null ->
                config.mode = str(event.data["currentModeId"])

            event.type == "config_option_update" -> {
                val options = records(event.data["configOptions"])
                if (options.isNotEmpty()) {
                    applyConfigOptions(config, options)
                } else {
                    val key = str(event.data["configId"]) ?: str(event.data["id"])
                    val value = str(event.data["value"]) ?: str(event.data["currentValue"])
                    if (value != null && (key == config.modelConfigId || str(event.data["category"]) == "model")) config.model = value
                    if (value != null && (key == "mode" || str(event.data["category"]) == "mode")) config.mode = value
                    if (value != null && key != null) {
                        config.params = config.params.map { param ->
                            if (param.id == key) param.copy(value = value) else param
                        }.toMutableList()
                    }
                }
            }

            event.type == "usage_update" -> {
                val used = nonNegativeNumber(event.data["used"])
                val size = finiteNumber(event.data["size"])?.takeIf { it > 0.0 }
                // A zero/absent window size cannot be turned into a ratio: treat it as not reported.
                if (used != null && size != null) {
                    val cost = event.data["cost"] as? JsonObject
                    val amount = cost?.let { finiteNumber(it["amount"]) }
                    val currency = cost?.let { str(it["currency"]) }
                    config.usage = ContextUsage(
                        used = used.toLong(),
                        size = size.toLong(),
                        cost = if (amount != null && currency != null) ContextCost(amount, currency) else null,
                    )
                }
            }

            event.type == "available_commands_update" -> {
                config.commands = records(event.data["availableCommands"]).mapNotNull { command ->
                    val name = str(command["name"]) ?: return@mapNotNull null
                    val input = (command["input"] as? JsonObject)?.let { str(it["hint"]) }
                    SlashCommand(
                        name = name.removePrefix("/"),
                        description = str(command["description"]),
                        hint = input,
                    )
                }.toMutableList()
            }
        }
    }
    return config.build()
}

/** `narration` is the CLI's short summary; `thinking` is the model's raw reasoning. */
enum class ReasoningChannel { THINKING, NARRATION }

/**
 * What an assistant message is to its turn, when the provider says: `commentary` is progress prose
 * that folds into the turn's process block, `final_answer` is the answer that stands outside it.
 * Absent (Cursor, older rows) the grouping falls back to the message's position.
 */
enum class AssistantPhase { COMMENTARY, FINAL_ANSWER }

enum class TimelineItemKind { USER, ASSISTANT, THOUGHT, TOOL, PLAN, IMAGE, STATUS, TASK_NOTIFICATION, ACTIVITY }

enum class StatusTone { DANGER, MUTED }

enum class TaskNotificationStatus { RUNNING, COMPLETED, FAILED, CANCELLED, UNKNOWN }

enum class TaskNotificationResultStatus { RUNNING, SUCCEEDED, FAILED }

data class TaskNotificationResult(
    val id: String,
    val status: TaskNotificationResultStatus,
    val exitCode: Long? = null,
    val runningMs: Long? = null,
)

sealed interface TimelineItem {
    val key: String
    val event: ProjectedEvent

    data class User(
        override val key: String,
        val text: String,
        override val event: ProjectedEvent,
        val attachments: List<UserAttachment>,
        val run: Run? = null,
        val references: List<riffet.contracts.CapturedSessionReference> = emptyList(),
        /** Its failure is already represented by a loaded timeline status, including after replay. */
        val failureShown: Boolean = false,
        /** `coordinator` (the main conversation writing into a subagent) or `peer` (another agent); null when the reader typed it. */
        val from: String? = null,
    ) : TimelineItem

    data class Assistant(
        override val key: String,
        val text: String,
        override val event: ProjectedEvent,
        val phase: AssistantPhase? = null,
    ) : TimelineItem

    data class Thought(
        override val key: String,
        val text: String,
        val channel: ReasoningChannel,
        override val event: ProjectedEvent,
    ) : TimelineItem

    data class Tool(
        override val key: String,
        override val event: ProjectedEvent,
        val job: NativeJob? = null,
        val subagent: riffet.contracts.TimelineRow.Subagent? = null,
        val activity: NativeActivity? = null,
    ) : TimelineItem

    data class Plan(
        override val key: String,
        val entries: List<JsonObject>,
        override val event: ProjectedEvent,
    ) : TimelineItem

    data class Image(
        override val key: String,
        val src: String,
        override val event: ProjectedEvent,
    ) : TimelineItem

    data class Status(
        override val key: String,
        val tone: StatusTone,
        val text: String,
        override val event: ProjectedEvent,
        val detail: String? = null,
    ) : TimelineItem

    data class TaskNotification(
        override val key: String,
        val taskId: String? = null,
        val taskKind: String,
        val status: TaskNotificationStatus,
        val sourceStatus: String? = null,
        val title: String,
        val command: String? = null,
        val detail: String? = null,
        val jobResult: TaskNotificationResult? = null,
        override val event: ProjectedEvent,
    ) : TimelineItem

    /**
     * Something the CLI does on its own: compacting the context, a background task, a local command's
     * output. It is not a prompt and starts no turn; later states of [activity] replace it in place.
     */
    data class Activity(
        override val key: String,
        val activity: NativeActivity,
        override val event: ProjectedEvent,
    ) : TimelineItem
}

val TimelineItem.kind: TimelineItemKind
    get() = when (this) {
        is TimelineItem.User -> TimelineItemKind.USER
        is TimelineItem.Assistant -> TimelineItemKind.ASSISTANT
        is TimelineItem.Thought -> TimelineItemKind.THOUGHT
        is TimelineItem.Tool -> TimelineItemKind.TOOL
        is TimelineItem.Plan -> TimelineItemKind.PLAN
        is TimelineItem.Image -> TimelineItemKind.IMAGE
        is TimelineItem.Status -> TimelineItemKind.STATUS
        is TimelineItem.TaskNotification -> TimelineItemKind.TASK_NOTIFICATION
        is TimelineItem.Activity -> TimelineItemKind.ACTIVITY
    }

/** `nativeEventIds`: the native id plus every alias, dropping blanks. */
fun nativeEventIds(event: WorkbenchEvent): List<String> {
    val ids = mutableListOf<String>()
    event.nativeId?.takeIf { it.isNotEmpty() }?.let { ids.add(it) }
    event.nativeAliases?.forEach { if (it.isNotEmpty()) ids.add(it) }
    return ids
}

private fun nativeSourceIds(event: ProjectedEvent): List<String> {
    val seen = LinkedHashSet<String>()
    (listOf(event.base) + event.sourceEvents).forEach { seen.addAll(nativeEventIds(it)) }
    return seen.toList()
}

/**
 * Resolves the conversation turn for each displayed row. Most events carry a run id; native
 * transcript rows can omit it, so rows without one inherit the most recently resolved turn.
 */
fun timelineTurnKeys(timeline: List<TimelineItem>): List<String> {
    // A Native user receipt is the exact join between the app's Run id and the CLI's turn id.
    val nativeRunByCliTurn = mutableMapOf<String, String>()
    val ambiguousCliTurns = mutableSetOf<String>()
    for (item in timeline) {
        if (item !is TimelineItem.User) continue
        val run = item.run ?: continue
        val nativeMessageId = run.native?.nativeMessageId ?: continue
        val cliTurnId = item.event.runId ?: continue
        if (nativeMessageId !in nativeSourceIds(item.event)) continue
        val existingRunId = nativeRunByCliTurn[cliTurnId]
        if (existingRunId != null && existingRunId != run.id) {
            nativeRunByCliTurn.remove(cliTurnId)
            ambiguousCliTurns.add(cliTurnId)
        } else if (cliTurnId !in ambiguousCliTurns) {
            nativeRunByCliTurn[cliTurnId] = run.id
        }
    }

    // Explicit turn identity joins all inputs to the execution owner, even after compaction.
    val ownerByNativeTurn = mutableMapOf<String, String>()
    for (item in timeline) {
        val run = (item as? TimelineItem.User)?.run ?: continue
        val native = run.native ?: continue
        val turn = native.nativeTurnId ?: item.event.nativeTurnId ?: continue
        val owner = native.ownerRunId ?: run.id.takeIf { native.intent != "steer" }
        if (owner != null) ownerByNativeTurn[turn] = owner
    }
    val keyByRun = mutableMapOf<String, String>()
    for (item in timeline) {
        val run = (item as? TimelineItem.User)?.run ?: continue
        val native = run.native ?: continue
        val turn = native.nativeTurnId ?: item.event.nativeTurnId
        val owner = native.ownerRunId ?: turn?.let(ownerByNativeTurn::get)
        val key = owner?.let { "run:$it" } ?: turn?.let { "native:${run.sessionId}:$it" } ?: continue
        keyByRun[run.id] = key
    }

    var currentTurn = "turn:orphan"
    var anonymousTurn = 0
    return timeline.map { item ->
        item.event.turn?.let { turn ->
            currentTurn = turn
            return@map turn
        }
        // An activity belongs to whatever turn is current; it never starts or moves one.
        if (item is TimelineItem.Activity) return@map currentTurn
        val explicitTurn = item.event.nativeTurnId ?: (item as? TimelineItem.User)?.run?.native?.nativeTurnId
        val explicitKey = explicitTurn?.let { turn -> ownerByNativeTurn[turn]?.let { "run:$it" } ?: "native:${item.event.sessionId}:$turn" }
            ?: (item as? TimelineItem.User)?.run?.id?.let(keyByRun::get)
            ?: item.event.runId?.let(keyByRun::get)
        if (explicitKey != null) {
            currentTurn = explicitKey
            explicitKey
        } else if (item is TimelineItem.User) {
            val runId = item.run?.id ?: item.event.runId
            currentTurn = if (runId != null) "run:$runId" else "turn:${++anonymousTurn}"
            currentTurn
        } else {
            val eventRunId = item.event.runId
            if (eventRunId != null) {
                val runId = if (eventRunId in ambiguousCliTurns) eventRunId
                else nativeRunByCliTurn[eventRunId] ?: eventRunId
                currentTurn = "run:$runId"
                currentTurn
            } else {
                currentTurn
            }
        }
    }
}

data class TimelineTurnAnalysis(
    val turnKeys: List<String>,
    val activeTurns: Set<String>,
    val lastIndexByTurn: Map<String, Int>,
)

/** "已核对" dismisses an uncertain send; it does not cancel the CLI. A receipt proves it arrived. */
private fun hasAcknowledgedReceipt(item: TimelineItem): Boolean {
    if (item !is TimelineItem.User || item.run?.state != RunState.CANCELLED) return false
    val native = item.run.native ?: return false
    return native.stage == "acknowledged" && native.delivery == NativeDeliveryState.CANCELLED
        && native.nativeMessageId != null && native.nativeMessageId in nativeSourceIds(item.event)
}

private fun isPendingUser(item: TimelineItem): Boolean {
    if (item !is TimelineItem.User) return false
    if (hasAcknowledgedReceipt(item)) return false
    val run = item.run ?: return false
    val delivery = run.native?.delivery
    return run.state == RunState.CANCELLED
        || delivery == NativeDeliveryState.QUEUED
        || delivery == NativeDeliveryState.PREPARING
        || delivery == NativeDeliveryState.CANCELLED
        || (run.state == RunState.QUEUED && run.native == null)
}

private fun isDispatchedUserRun(run: Run?): Boolean {
    if (run == null) return false
    val delivery = run.native?.delivery
    if (delivery == NativeDeliveryState.QUEUED
        || delivery == NativeDeliveryState.PREPARING
        || delivery == NativeDeliveryState.CANCELLED
        || delivery == NativeDeliveryState.FAILED
        || delivery == NativeDeliveryState.UNCERTAIN
    ) return false
    return run.state == RunState.RUNNING || (run.state == RunState.QUEUED && (
        delivery == NativeDeliveryState.DISPATCHING
            || delivery == NativeDeliveryState.INPUT_SENT
            || delivery == NativeDeliveryState.OBSERVED
        ))
}

/** A completed Run can still have native output committed after its completion was observed. */
private fun outputFollowsCompletedRun(item: TimelineItem, run: Run): Boolean {
    if (run.state != RunState.COMPLETED) return false
    val completedAt = run.native?.timings?.get("completedAt")
        ?.takeIf { it.isFinite() }
        ?.toLong()
        ?: parseMillis(run.updatedAt)
        ?: return false
    val outputAt = parseMillis(timelineItemTime(item)) ?: return false
    return outputAt > completedAt
}

/**
 * The Run a timeline turn key stands for, when it was derived from one. Turn keys are either
 * `run:<runId>` or a provider-local turn id — only the first kind has a run to hang speed on.
 */
fun runIdFromTurnKey(turnKey: String): String? =
    if (turnKey.startsWith("run:")) turnKey.substring(4) else null

/** Derives ordering and running state once so a long transcript is scanned only a few times. */
fun analyzeTimelineTurns(timeline: List<TimelineItem>, sessionRunning: Boolean, activeTurnId: String? = null): TimelineTurnAnalysis {
    val turnKeys = timelineTurnKeys(timeline)
    val activeTurns = mutableSetOf<String>()
    val lastIndexByTurn = mutableMapOf<String, Int>()
    timeline.forEachIndexed { index, item ->
        val turnKey = turnKeys[index]
        if (item !is TimelineItem.Activity) lastIndexByTurn[turnKey] = index
        if (item is TimelineItem.User && isDispatchedUserRun(item.run)) {
            activeTurns.add(turnKey)
        }
    }
    if (!sessionRunning) {
        activeTurns.clear()
        return TimelineTurnAnalysis(turnKeys, activeTurns, lastIndexByTurn)
    }
    // A provider can wake completed work without another prompt or newer timestamps. The live
    // identity outranks persisted Run state even before output arrives, without reopening history.
    // It may be the provider's turn id or the execution owner, whose prompt can have been compacted
    // away while its steer receipts still resolve to the same owner through timelineTurnKeys.
    if (!activeTurnId.isNullOrEmpty()) {
        activeTurns.clear()
        // Native/folded identity precedes source run ids, which continuations can inherit.
        val nativeIndex = timeline.indices.lastOrNull { index ->
            val item = timeline[index]
            item.event.turn == activeTurnId || item.event.turn == "native:${item.event.sessionId}:$activeTurnId" ||
                ((item.event.turn == null || item.event.turn?.startsWith("run:") == true) &&
                    (item.event.nativeTurnId == activeTurnId ||
                        (item is TimelineItem.User && item.run?.native?.nativeTurnId == activeTurnId)))
        }
        val index = nativeIndex ?: timeline.indices.lastOrNull { index ->
            val item = timeline[index]
            item.event.turn == "run:$activeTurnId" || (item.event.turn == null &&
                (item.event.runId == activeTurnId ||
                    (item is TimelineItem.User && (item.run?.id == activeTurnId || item.run?.native?.ownerRunId == activeTurnId))))
        }
        if (sessionRunning) activeTurns.add(if (index != null) turnKeys[index] else "run:$activeTurnId")
        return TimelineTurnAnalysis(turnKeys, activeTurns, lastIndexByTurn)
    }
    val latestUserIndex = timeline.indexOfLast { it.kind == TimelineItemKind.USER }
    val latestSentUserIndex = timeline.indexOfLast { it is TimelineItem.User && !isPendingUser(it) }
    val latestNotificationIndex = timeline.indexOfLast { it.kind == TimelineItemKind.TASK_NOTIFICATION }
    val latestOutputIndex = timeline.indexOfLast { it.kind != TimelineItemKind.USER && it.kind != TimelineItemKind.ACTIVITY }
    // Server-folded continuation can have no prompt and can inherit a stopped Run's source id.
    if (sessionRunning && latestOutputIndex > latestUserIndex && latestOutputIndex >= 0 &&
        timeline[latestOutputIndex].event.turn?.startsWith("native:") == true &&
        turnKeys[latestOutputIndex] != turnKeys.getOrNull(latestUserIndex)
    ) {
        activeTurns.clear()
        activeTurns.add(turnKeys[latestOutputIndex])
        return TimelineTurnAnalysis(turnKeys, activeTurns, lastIndexByTurn)
    }
    if (latestNotificationIndex > latestSentUserIndex && latestNotificationIndex >= 0) {
        // A CLI task notification starts its own native turn. It supersedes stale app Run state
        // from the human turn that launched it.
        activeTurns.clear()
        if (sessionRunning) activeTurns.add(turnKeys[latestNotificationIndex])
    }
    if (sessionRunning && activeTurns.isEmpty()) {
        val latestUser = if (latestUserIndex >= 0) timeline[latestUserIndex] else null
        val latestUserIsPending = latestUser != null && isPendingUser(latestUser)
        // A native echo may precede the run-list refresh, so it has a real user row but no Run yet.
        // "已核对" only dismisses delivery uncertainty; its exact native receipt can still be live.
        // A completed Run needs stronger evidence: same-turn output newer than its completion.
        // Neither rule lets an unsent prompt or an unrelated old turn inherit session activity.
        if (latestUser is TimelineItem.User && (!latestUserIsPending || (
                latestOutputIndex > latestUserIndex
                    && turnKeys[latestOutputIndex] == turnKeys[latestUserIndex]
                    && latestUser.run?.state == RunState.QUEUED
                    && latestUser.run.native?.delivery != NativeDeliveryState.CANCELLED
                    && latestUser.run.native?.delivery != NativeDeliveryState.FAILED
                ))
        ) {
            if (latestUser.run == null) {
                activeTurns.add(turnKeys[latestUserIndex])
            } else if (latestOutputIndex > latestUserIndex
                && turnKeys[latestOutputIndex] == turnKeys[latestUserIndex]
                && (latestUser.run.state == RunState.QUEUED
                    || hasAcknowledgedReceipt(latestUser)
                    || outputFollowsCompletedRun(timeline[latestOutputIndex], latestUser.run))
            ) {
                activeTurns.add(turnKeys[latestOutputIndex])
            }
        } else if (latestUserIndex < 0 && latestOutputIndex >= 0) {
            // A paged native/subagent tail can omit its prompt entirely. Missing history does not
            // make the latest visible turn finished while its native session is still working.
            activeTurns.add(turnKeys[latestOutputIndex])
        }
    }
    return TimelineTurnAnalysis(turnKeys = turnKeys, activeTurns = activeTurns, lastIndexByTurn = lastIndexByTurn)
}

/** Returns active turn ids from Run state and the session's narrowly attributed live tail. */
fun activeTimelineTurnKeys(timeline: List<TimelineItem>, sessionRunning: Boolean): Set<String> =
    analyzeTimelineTurns(timeline, sessionRunning).activeTurns

/** The projection's `chunkText`: an absent content body is the empty string. */
fun chunkText(event: WorkbenchEvent): String {
    val content = event.data["content"]
    if (content is JsonObject) {
        val text = content["text"]
        if (text is JsonPrimitive && text.isString) return text.content
    }
    val text = event.data["text"]
    if (text is JsonPrimitive && text.isString) return text.content
    return ""
}

fun timelineItemTime(item: TimelineItem): String =
    item.event.sourceEvents.lastOrNull()?.createdAt ?: item.event.createdAt

data class ToolLocation(val path: String, val line: Long? = null)

data class ToolView(
    val id: String,
    val title: String,
    val kind: String,
    val status: String,
    val locations: List<ToolLocation>,
    val command: String? = null,
    val contents: List<JsonObject>,
    val rawInput: JsonElement? = null,
    val rawOutput: JsonElement? = null,
)

/** `String(x)` for the JSON values that can appear in a command array. */
private fun jsString(element: JsonElement?): String = when (element) {
    null, is JsonNull -> ""
    is JsonPrimitive -> element.content
    else -> ""
}

/** Lines added and removed across every diff a tool returned, whatever the tool. */
data class ToolDiffStats(val added: Int, val removed: Int, val files: Int)

fun toolDiffStats(view: ToolView): ToolDiffStats? {
    val diffs = view.contents.filter { str(it["type"]) == "diff" }
    if (diffs.isEmpty()) return null
    var added = 0
    var removed = 0
    for (item in diffs) {
        val before = (item["oldText"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: ""
        val after = jsString(item["newText"])
        val diff = lineDiff(before, after, 0)
        if (diff != null) {
            added += diff.added
            removed += diff.removed
            continue
        }
        val a = if (before.isEmpty()) emptyList() else before.split("\n")
        val b = if (after.isEmpty()) emptyList() else after.split("\n")
        var head = 0
        while (head < a.size && head < b.size && a[head] == b[head]) head += 1
        var tail = 0
        while (tail < a.size - head && tail < b.size - head && a[a.size - 1 - tail] == b[b.size - 1 - tail]) tail += 1
        added += b.size - head - tail
        removed += a.size - head - tail
    }
    return ToolDiffStats(added = added, removed = removed, files = diffs.map { it["path"] }.toSet().size)
}

/** Rewrites absolute paths under the project root (including macOS /private aliases) as relative. */
fun stripRoot(text: String, root: String?): String {
    if (root == null) return text
    val base = root.trimEnd('/')
    val roots = listOf(
        base,
        if (base.startsWith("/private/")) base.removePrefix("/private") else "/private$base",
    ).sortedByDescending { it.length }
    var result = text
    for (item in roots) {
        result = result.split("$item/").joinToString("") { it }.split(item).joinToString(".")
    }
    return result
}

private val CD_PREFIX = Regex("^cd \\.? ?&& ")
private val LINE_CONTINUATION = Regex("\\\\\\r?\\n[ \\t]*")
private val PATH_SLASHER = Regex("[\\\\/]")
private val BARE_TOOL_TITLES = Regex("^(?:bash|shell|sh|zsh|script|terminal|run command|command|execute)$", RegexOption.IGNORE_CASE)

fun commandHeadline(command: String): String {
    val joined = command.replace(LINE_CONTINUATION, " ")
    val lines = joined.lineSequence().map { cleanLabel(it) }.filter { it.isNotEmpty() }.toList()
    return lines.firstOrNull { !it.startsWith("#") } ?: lines.firstOrNull() ?: cleanLabel(command)
}

fun isCommandTitle(title: String, command: String?): Boolean {
    if (command == null) return false
    val normalized = cleanLabel(title.replace(CD_PREFIX, ""))
    return normalized == cleanLabel(command) || normalized == commandHeadline(command)
}

fun toolFoldedDetail(view: ToolView, root: String? = null): String? {
    val actions = records((view.rawInput as? JsonObject)?.get("commandActions"))
    val path = if (view.locations.size == 1 && actions.size <= 1) view.locations[0].path else null
    if (path != null && path != "." && path != "./" && !view.title.contains(path.substringAfterLast('/'))) {
        return path
    }
    val diffPaths = view.contents.mapNotNull { item ->
        if (str(item["type"]) == "diff") str(item["path"])?.let { stripRoot(it, root) }?.takeIf { it.isNotEmpty() } else null
    }.distinct()
    if (diffPaths.isNotEmpty() && diffPaths.none { view.title.contains(it.substringAfterLast('/')) }) {
        return formatTargetList(shortFileLabels(diffPaths))
    }
    val command = view.command
    if (command != null && BARE_TOOL_TITLES.matches(view.title.trim())) {
        return commandHeadline(command)
    }
    return null
}

private fun shortFileLabels(paths: List<String>): List<String> {
    val split = paths.map { path -> path.split(PATH_SLASHER).filter { it.isNotEmpty() } }
    val baseCounts = HashMap<String, Int>()
    for (parts in split) {
        val base = parts.lastOrNull().orEmpty()
        baseCounts[base] = (baseCounts[base] ?: 0) + 1
    }
    return split.mapIndexed { index, parts ->
        val fallback = paths[index]
        val base = parts.lastOrNull() ?: return@mapIndexed fallback
        if ((baseCounts[base] ?: 0) <= 1 || parts.size <= 1) base
        else parts.takeLast(2).joinToString("/")
    }
}

private fun formatTargetList(items: List<String>, limit: Int = 3): String =
    if (items.size <= limit) items.joinToString(", ")
    else "${items.take(limit).joinToString(", ")} +${items.size - limit}"

private data class DescribedCommandActions(val kind: String, val title: String?)

private fun describeCommandActions(actions: List<JsonObject>, root: String? = null): DescribedCommandActions? {
    if (actions.isEmpty()) return null
    val kinds = actions.map { action ->
        when (str(action["type"])) {
            "read" -> "read"
            "search", "listFiles" -> "search"
            else -> "execute"
        }
    }
    val allSame = kinds.all { it == kinds[0] }
    val hasExecute = "execute" in kinds
    val kind = if (allSame || !hasExecute) kinds[0] else "other"
    if (kind == "execute") return DescribedCommandActions(kind = kind, title = null)

    val groupOrder = ArrayList<String>()
    for (action in actions) {
        val type = when (val raw = str(action["type"])) {
            "read", "search", "listFiles" -> raw
            else -> "unknown"
        }
        if (type !in groupOrder) groupOrder += type
    }

    if (groupOrder.size > 3) {
        val counts = LinkedHashMap<String, Int>()
        for (action in actions) {
            val label = when (str(action["type"])) {
                "read" -> "file read"
                "search" -> "search"
                "listFiles" -> "file listing"
                else -> "command"
            }
            counts[label] = (counts[label] ?: 0) + 1
        }
        val summary = counts.map { (label, count) ->
            "$count $label${if (count == 1) "" else if (label == "search") "es" else "s"}"
        }.joinToString(" · ")
        return DescribedCommandActions(kind = kind, title = summary)
    }

    val singleGroup = groupOrder.size == 1
    val segments = groupOrder.map { group ->
        val members = actions.filter { action ->
            val type = when (val raw = str(action["type"])) {
                "read", "search", "listFiles" -> raw
                else -> "unknown"
            }
            type == group
        }
        when (group) {
            "read" -> {
                val targets = members.mapNotNull { action ->
                    (str(action["path"]) ?: str(action["name"]))?.let { stripRoot(it, root) }?.takeIf { it.isNotEmpty() }
                }.distinct()
                when {
                    targets.isEmpty() -> "Read file"
                    singleGroup && targets.size == 1 -> "Read ${targets[0]}"
                    else -> "Read ${formatTargetList(shortFileLabels(targets))}"
                }
            }
            "listFiles" -> {
                val targets = members.mapNotNull { action ->
                    str(action["path"])?.let { stripRoot(it, root) }?.takeIf { it.isNotEmpty() }
                }.distinct()
                when {
                    targets.isEmpty() -> "List files"
                    singleGroup && targets.size == 1 -> "List files ${targets[0]}"
                    else -> "List files ${formatTargetList(shortFileLabels(targets))}"
                }
            }
            "search" -> {
                val rawPaths = members.map { action ->
                    str(action["path"])?.let { stripRoot(it, root) }.orEmpty()
                }
                val nonEmptyPaths = rawPaths.filter { it.isNotEmpty() }.distinct()
                val shortPaths = if (singleGroup && members.size == 1) rawPaths else {
                    val labels = shortFileLabels(nonEmptyPaths)
                    val map = nonEmptyPaths.zip(labels).toMap()
                    rawPaths.map { path -> if (path.isNotEmpty()) map[path] ?: path else "" }
                }
                val specs = members.mapIndexedNotNull { index, action ->
                    val query = str(action["query"])
                    val path = shortPaths[index].takeIf { it.isNotEmpty() }?.let { "in $it" }
                    listOfNotNull(query, path).joinToString(" ").takeIf { it.isNotEmpty() }
                }.distinct()
                if (specs.isEmpty()) "Search" else "Search ${formatTargetList(specs)}"
            }
            else -> if (members.size == 1) "Run command" else "${members.size} commands"
        }
    }
    return DescribedCommandActions(kind = kind, title = segments.joinToString(" · "))
}

/** A display category, including the child metadata retained by older Task rows. */
fun toolKind(event: WorkbenchEvent): String {
    val data = event.data
    val input = (data["rawInput"] ?: data["input"]) as? JsonObject
    if (data["subagent"] is JsonObject ||
        (str(data["kind"]) == "think" && !str(input?.get("subagent_type")).isNullOrEmpty())
    ) return "agent"
    val kind = str(data["kind"])
    if (kind == null || kind == "other") {
        val actions = records(input?.get("commandActions"))
        val described = describeCommandActions(actions)
        if (described != null) return described.kind
    }
    return kind ?: "other"
}

fun toolView(event: WorkbenchEvent, root: String? = null): ToolView {
    val data = event.data
    val rawInput = data["rawInput"] ?: data["input"]
    val input = rawInput as? JsonObject
    val rawCommand = str(input?.get("command"))
        ?: (input?.get("command") as? JsonArray)?.joinToString(" ") { jsString(it) }
    val command = rawCommand?.let { stripRoot(it, root).replace(CD_PREFIX, "") }
    val described = describeCommandActions(records(input?.get("commandActions")), root)
    val rawTitle = described?.title ?: str(data["title"]) ?: str(data["toolName"]) ?: str(data["name"]) ?: UiText.text("core.tool.call")
    val title = stripRoot(cleanLabel(rawTitle), root).replace(Regex("^`([^`]*)`$"), "$1")
    val kind = toolKind(event)
    val rawStatus = str(data["status"]) ?: str(data["state"]) ?: "completed"
    val status = if (rawStatus == "failed" && kind == "search" && finiteNumber(data["exitCode"])?.toInt() == 1) "completed" else rawStatus
    return ToolView(
        id = str(data["toolCallId"]) ?: event.sequence.toString(),
        title = if (command != null && isCommandTitle(title, command)) commandHeadline(command) else title,
        kind = kind,
        status = status,
        locations = records(data["locations"]).mapNotNull { location ->
            val path = str(location["path"]) ?: return@mapNotNull null
            ToolLocation(path = stripRoot(path, root), line = finiteNumber(location["line"])?.toLong())
        },
        command = command,
        contents = records(data["content"]),
        rawInput = rawInput,
        rawOutput = data["rawOutput"] ?: data["output"],
    )
}

val activeToolStates: Set<String> = setOf("pending", "in_progress", "running", "queued")

enum class DiffLineType { SAME, ADD, DEL, GAP }

data class DiffLine(
    val type: DiffLineType,
    val text: String,
    val oldNo: Long? = null,
    val newNo: Long? = null,
)

data class LineDiff(val lines: List<DiffLine>, val added: Int, val removed: Int)

private const val DIFF_CELL_LIMIT = 1_200_000L

/**
 * Line diff with LCS; returns null when the inputs are too large to diff cheaply. `lineOffset`
 * and `trailingLines` describe unchanged lines the server already trimmed from both sides.
 */
fun lineDiff(
    before: String,
    after: String,
    context: Int = 3,
    lineOffset: Long = 0,
    trailingLines: Long = 0,
): LineDiff? {
    val a = if (before.isEmpty()) emptyList() else before.split("\n")
    val b = if (after.isEmpty()) emptyList() else after.split("\n")
    var start = 0
    while (start < a.size && start < b.size && a[start] == b[start]) start += 1
    var endA = a.size
    var endB = b.size
    while (endA > start && endB > start && a[endA - 1] == b[endB - 1]) {
        endA -= 1
        endB -= 1
    }
    val midA = a.subList(start, endA)
    val midB = b.subList(start, endB)
    if (midA.size.toLong() * midB.size.toLong() > DIFF_CELL_LIMIT) return null
    val n = midA.size
    val m = midB.size
    val table = Array(n + 1) { IntArray(m + 1) }
    for (i in n - 1 downTo 0) {
        for (j in m - 1 downTo 0) {
            table[i][j] = if (midA[i] == midB[j]) table[i + 1][j + 1] + 1 else maxOf(table[i + 1][j], table[i][j + 1])
        }
    }
    val full = mutableListOf<DiffLine>()
    for (i in 0 until start) full.add(DiffLine(DiffLineType.SAME, a[i], oldNo = (i + 1).toLong(), newNo = (i + 1).toLong()))
    var i = 0
    var j = 0
    var added = 0
    var removed = 0
    while (i < n || j < m) {
        if (i < n && j < m && midA[i] == midB[j]) {
            full.add(DiffLine(DiffLineType.SAME, midA[i], oldNo = (start + i + 1).toLong(), newNo = (start + j + 1).toLong()))
            i += 1
            j += 1
        } else if (j < m && (i >= n || table[i][j + 1] >= table[i + 1][j])) {
            full.add(DiffLine(DiffLineType.ADD, midB[j], newNo = (start + j + 1).toLong()))
            j += 1
            added += 1
        } else {
            full.add(DiffLine(DiffLineType.DEL, midA[i], oldNo = (start + i + 1).toLong()))
            i += 1
            removed += 1
        }
    }
    for (k in endA until a.size) {
        full.add(DiffLine(DiffLineType.SAME, a[k], oldNo = (k + 1).toLong(), newNo = (endB + (k - endA) + 1).toLong()))
    }
    val keep = BooleanArray(full.size)
    full.forEachIndexed { index, line ->
        if (line.type == DiffLineType.SAME) return@forEachIndexed
        for (k in maxOf(0, index - context)..minOf(full.size - 1, index + context)) keep[k] = true
    }
    val lines = mutableListOf<DiffLine>()
    var skipped = lineOffset
    full.forEachIndexed { index, line ->
        if (keep[index]) {
            if (skipped > 0) {
                lines.add(DiffLine(DiffLineType.GAP, UiText.text("core.diff.unchangedLines", skipped)))
                skipped = 0
            }
            lines.add(
                if (lineOffset != 0L) {
                    line.copy(
                        oldNo = line.oldNo?.let { it + lineOffset },
                        newNo = line.newNo?.let { it + lineOffset },
                    )
                } else {
                    line
                },
            )
        } else {
            skipped += 1
        }
    }
    skipped += trailingLines
    if (skipped > 0 && lines.isNotEmpty()) lines.add(DiffLine(DiffLineType.GAP, UiText.text("core.diff.unchangedLines", skipped)))
    return LineDiff(lines = lines, added = added, removed = removed)
}

@OptIn(ExperimentalSerializationApi::class)
private val prettyJson: Json = Json { prettyPrint = true; prettyPrintIndent = "  " }

/** `JSON.stringify(value, null, 2)`, except that a JSON string is returned verbatim. */
fun formatJson(value: JsonElement?): String = when {
    value == null -> ""
    value is JsonPrimitive && value.isString -> value.content
    else -> prettyJson.encodeToString(JsonElement.serializer(), value)
}
