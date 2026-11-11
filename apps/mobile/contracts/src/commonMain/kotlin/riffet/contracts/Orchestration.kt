package riffet.contracts

import kotlinx.serialization.Serializable

/*
 * Ported from packages/contracts/src/index.ts: launch targets, parallel attempts, task templates,
 * schedules and review comments (docs/ORCHESTRATION.md). Closed string sets stay strings so a newer
 * server's new value cannot fail a whole list.
 */

/** A backend choice for a launch; unset fields take the backend's saved defaults, as in the composer. */
@Serializable
data class LaunchTarget(
    val backendId: NativeBackendId? = null,
    val backendProfileId: String? = null,
    val model: String? = null,
    val mode: String? = null,
    val approval: String? = null,
    val agentId: String? = null,
) {
    val agent: String? get() = agentId ?: backendId?.let(AgentIds::wire)
}

/**
 * `POST /api/sessions/:id/handoff/draft`: the first message a handoff would open with, for the user
 * to edit. [generatedBy] names the handoff model that wrote it; without one the server stitched it
 * from the transcript, and [fallbackReason] says why a configured model was not used.
 */
@Serializable
data class HandoffDraft(
    val text: String,
    val generatedBy: AuxiliaryModelOption? = null,
    val fallbackReason: String? = null,
)

/** One conversation of an [AttemptGroup], cut into a worktree of its own. */
@Serializable
data class AttemptRef(
    val sessionId: String,
    val projectId: String,
    val branch: String,
    val target: LaunchTarget = LaunchTarget(),
    /** Set once this attempt was discarded or cleaned up after another was adopted. */
    val discardedAt: String? = null,
)

@Serializable
data class AttemptAdoption(val sessionId: String, val at: String, val head: String? = null)

/**
 * One prompt run by several backends side by side, each in a worktree cut from the same commit, so
 * the results can be compared and one of them merged back.
 */
@Serializable
data class AttemptGroup(
    val id: String,
    val projectId: String,
    val prompt: String,
    val base: String,
    val createdAt: String,
    val attempts: List<AttemptRef> = emptyList(),
    val adopted: AttemptAdoption? = null,
)

@Serializable
data class WorktreeComparisonFile(
    val path: String,
    val status: String,
    val added: Long? = null,
    val removed: Long? = null,
)

/** The change of one worktree against the commit its attempt started from, committed or not. */
@Serializable
data class WorktreeComparison(
    val base: String,
    val head: String? = null,
    val commits: Long = 0,
    val files: List<WorktreeComparisonFile> = emptyList(),
    val added: Long = 0,
    val removed: Long = 0,
)

/** [error] is set when this attempt's worktree could not be compared. */
@Serializable
data class AttemptComparison(
    val sessionId: String,
    val projectId: String,
    val branch: String,
    val target: LaunchTarget = LaunchTarget(),
    val state: SessionState? = null,
    val title: String? = null,
    val comparison: WorktreeComparison? = null,
    val error: String? = null,
)

/**
 * A reusable task. `{{date}}` and `{{project}}` in [prompt] are filled in when it runs. The target
 * fields are flat, as the server stores them; [target] gathers them.
 */
@Serializable
data class TaskTemplate(
    val id: String,
    val name: String,
    val prompt: String,
    val backendId: NativeBackendId? = null,
    val backendProfileId: String? = null,
    val model: String? = null,
    val mode: String? = null,
    val approval: String? = null,
    /** Run each time in a fresh worktree of the project instead of its own checkout. */
    val isolate: Boolean? = null,
    val createdAt: String,
    val updatedAt: String,
    val agentId: String? = null,
) {
    val target: LaunchTarget get() = LaunchTarget(backendId, backendProfileId, model, mode, approval, agentId)
}

/**
 * Runs a template on a cron schedule (local time). [target] is `new` (a conversation per run) or
 * `same` (every run goes into one ongoing conversation); [lastResult] is `started`, `skipped`,
 * `missed` or `failed`.
 */
@Serializable
data class Schedule(
    val id: String,
    val name: String,
    val templateId: String,
    val projectId: String,
    val cron: String,
    val enabled: Boolean = true,
    val target: String = "new",
    val nextRunAt: String? = null,
    val lastRunAt: String? = null,
    val lastSessionId: String? = null,
    val lastResult: String? = null,
    val lastError: String? = null,
    val createdAt: String,
    val updatedAt: String,
)

/** One review remark on a diff line or range, sent back to the agent as a message. */
@Serializable
data class ReviewComment(
    val path: String,
    val line: Long? = null,
    val endLine: Long? = null,
    val body: String,
    val quote: String? = null,
)
