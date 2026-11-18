package riffet.contracts

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

/* Ported from packages/contracts/src/settings.ts: the 助理's settings, instructions, memory and delegations. */

/** `AppSettings.assistant`: the agent and model the 助理 starts with (docs/ASSISTANT.md §4). */
@Serializable
data class AssistantSettings(
    val backendId: NativeBackendId? = null,
    val profileId: String? = null,
    val model: String? = null,
    /** The owner's IANA time zone, as the last client reports it. */
    val timeZone: String? = null,
    /** 跟进: off unless switched on (docs/ASSISTANT.md §7.6). */
    val supervision: Boolean? = null,
    /** `edits` (unset) or `all`: which tasks the 助理 may start itself. */
    val dispatch: String? = null,
    /** 记忆整理: on unless switched off. */
    val consolidation: Boolean? = null,
    /** Background runs started in any 24 hours; unset, [ASSISTANT_BUDGET_DAILY_RUNS]. */
    val dailyRuns: Int? = null,
)

/** A PATCH of [AssistantSettings]: each field given replaces its own, a JSON `null` clears it ([clear]). */
@Serializable
data class AssistantSettingsUpdate(
    val backendId: NativeBackendId? = null,
    val profileId: JsonElement? = null,
    val model: JsonElement? = null,
    val timeZone: String? = null,
    val supervision: Boolean? = null,
    val dispatch: String? = null,
    val consolidation: Boolean? = null,
    val dailyRuns: Int? = null,
) {
    companion object {
        /** A string to store, or the `null` that clears the field. */
        fun clearable(value: String?): JsonElement = if (value == null) JsonNull else JsonPrimitive(value)
    }
}

/**
 * A capability pack of the 助理 (docs/ASSISTANT.md §8.2). [entry] is the command that starts its work
 * (`/travel:plan`), offered above the 助理's composer once [installed]; [builtIn] packs can be added and removed.
 */
@Serializable
data class AssistantPack(
    val id: String,
    val title: String,
    val description: String? = null,
    val entry: String? = null,
    val installed: Boolean = false,
    val builtIn: Boolean = false,
)

/** `GET`, `PUT` and `DELETE /api/assistant/packs[/:id]`. */
@Serializable
data class AssistantPacks(val packs: List<AssistantPack> = emptyList())

/** One job's background runs in [AssistantRunUsage]: `supervise`, `consolidate` or `delegation`. */
@Serializable
data class AssistantJobUsage(val job: String, val runs: Int = 0, val tokens: Long = 0)

/**
 * `GET /api/assistant/runs/usage`: the background runs of the last [days] days by job; [started] counts the last
 * 24 hours against [limit], and [waiting] the runs held back by it.
 */
@Serializable
data class AssistantRunUsage(
    val days: Int = 7,
    val jobs: List<AssistantJobUsage> = emptyList(),
    val started: Int = 0,
    val limit: Int = 0,
    val waiting: Int = 0,
)

/** `GET`/`PUT /api/assistant/instructions`; [custom] is false while the file holds Riffet's own text. */
@Serializable
data class AssistantInstructions(val text: String, val custom: Boolean)

/**
 * `PATCH /api/settings` with only the assistant's settings: a body of its own rather than a field of
 * [AppSettingsUpdate], whose constructor the native clients call positionally.
 */
@Serializable
data class AssistantSettingsPatch(val assistant: AssistantSettingsUpdate)

/** `PUT /api/assistant/instructions`: [text] is a string, or the JSON `null` that restores the default. */
@Serializable
data class AssistantInstructionsUpdate(val text: JsonElement)

@Serializable
data class AssistantMemoryEntry(val name: String, val text: String, val modifiedAt: String)

/** `GET /api/assistant/memory`: what the 助理 remembers, newest topic first. */
@Serializable
data class AssistantMemory(
    val profile: String = "",
    val index: String = "",
    val entries: List<AssistantMemoryEntry> = emptyList(),
    val updatedAt: String? = null,
)

/** What starts a delegation's run: a schedule, a release, a page change, or a task status. */
@Serializable
data class AssistantDelegationTrigger(
    val kind: String,
    val cron: String? = null,
    val timeZone: String? = null,
    val repo: String? = null,
    val url: String? = null,
    val everyMinutes: Int? = null,
    val workItemId: String? = null,
    val taskNumber: Int? = null,
    val status: String? = null,
)

/** Something the owner handed the 助理 to follow over time (docs/ASSISTANT.md §7.3). */
@Serializable
data class AssistantDelegation(
    val id: String,
    val goal: String,
    val attention: String = "",
    val trigger: AssistantDelegationTrigger,
    val until: String,
    /** `active` or `ended`. */
    val state: String,
    val endedReason: String? = null,
    val lastCheckedAt: String? = null,
    val lastRunAt: String? = null,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class AssistantDelegations(val delegations: List<AssistantDelegation> = emptyList())

/** `AppSettings.workItems` (docs/TASK-BOARD.md §10); an unset agent is the composer's default with its own defaults. */
@Serializable
data class WorkItemSettings(
    /** A conversation started from the composer opens a task too. Off unless set. */
    val composerSessions: Boolean? = null,
    val backendId: NativeBackendId? = null,
    val profileId: String? = null,
    val model: String? = null,
)

/** A PATCH of [WorkItemSettings]: each field given replaces its own, a JSON `null` clears it. */
@Serializable
data class WorkItemSettingsUpdate(
    val composerSessions: Boolean? = null,
    val backendId: JsonElement? = null,
    val profileId: JsonElement? = null,
    val model: JsonElement? = null,
)

@Serializable
data class WorkItemSettingsPatch(val workItems: WorkItemSettingsUpdate)
