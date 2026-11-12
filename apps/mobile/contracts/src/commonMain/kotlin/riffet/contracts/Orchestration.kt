package riffet.contracts

import kotlinx.serialization.Serializable

/*
 * Ported from packages/contracts/src/index.ts: launch targets, parallel attempts, automations
 * and review comments (docs/ORCHESTRATION.md). Closed string sets stay strings so a newer
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
    /** The branch [base] was found on, when the comparison chose it. */
    val ref: String? = null,
    val head: String? = null,
    val commits: Long = 0,
    val files: List<WorktreeComparisonFile> = emptyList(),
    /** Set when more files changed than are listed. */
    val filesTotal: Long? = null,
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
 * When an [Automation] runs by itself. [kind] is `once` (at [at]) or `cron` ([cron] in [timeZone], an
 * IANA name); a kind this client does not know decodes as it is, so one newer trigger cannot fail the
 * whole list.
 */
@Serializable
data class AutomationTrigger(
    val kind: String,
    val at: String? = null,
    val cron: String? = null,
    val timeZone: String? = null,
)

/**
 * Saved work: what to run, when it runs by itself ([triggers]; none means by hand only) and where each
 * run goes. `{{date}}` and `{{project}}` in [prompt] are filled in when it runs. The target fields are
 * flat, as the server stores them; [target] gathers them. [delivery] is `new` or `same`, [catchUp] is
 * `latest` or `skip`; [lastResult] is `started`, `skipped`, `missed` or `failed`. A [followUp] ([by] is
 * `agent` or `user`) is a turn in one conversation, never a new one.
 */
@Serializable
data class Automation(
    val id: String,
    val name: String,
    val prompt: String,
    val backendId: NativeBackendId? = null,
    val backendProfileId: String? = null,
    val model: String? = null,
    val mode: String? = null,
    val approval: String? = null,
    val agentId: String? = null,
    val projectId: String? = null,
    val isolate: Boolean? = null,
    val triggers: List<AutomationTrigger> = emptyList(),
    val delivery: String = "new",
    val catchUp: String = "latest",
    val enabled: Boolean = true,
    val followUp: AutomationFollowUp? = null,
    /** What a user follow-up sends besides [prompt]: attachments, file and session references. */
    val input: AutomationInput? = null,
    val createdBySessionId: String? = null,
    val nextRunAt: String? = null,
    val lastRunAt: String? = null,
    val lastResult: String? = null,
    val lastError: String? = null,
    val lastSessionId: String? = null,
    val createdAt: String,
    val updatedAt: String,
) {
    val target: LaunchTarget get() = LaunchTarget(backendId, backendProfileId, model, mode, approval, agentId)
}

@Serializable
data class AutomationFollowUp(val sessionId: String, val by: String)

@Serializable
data class AutomationInput(
    val attachmentIds: List<String> = emptyList(),
    val context: List<NativeRunContextReference> = emptyList(),
    val references: List<SessionReferenceInput> = emptyList(),
) {
    val isEmpty: Boolean get() = attachmentIds.isEmpty() && context.isEmpty() && references.isEmpty()
}

/**
 * One firing of an automation. [cause] is `schedule`, `catch-up` or `manual`; [result] is `started`,
 * `skipped`, `missed` or `failed`; [reason] (`busy`, `offline`, `project-unavailable`,
 * `session-unavailable`) says why one was skipped or missed, [error] what a failed one failed with.
 */
@Serializable
data class AutomationRun(
    val id: String,
    val automationId: String,
    val cause: String,
    val scheduledFor: String? = null,
    val at: String,
    val result: String,
    val reason: String? = null,
    val error: String? = null,
    val sessionId: String? = null,
    val runId: String? = null,
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
