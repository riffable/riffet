package riffet.shared

import io.ktor.http.HttpMethod
import riffet.contracts.Attachment
import riffet.contracts.AttemptGroup
import riffet.contracts.Checkpoint
import riffet.contracts.HandoffDraft
import riffet.contracts.LaunchTarget
import riffet.contracts.ReviewComment
import riffet.contracts.Run
import riffet.contracts.Schedule
import riffet.contracts.TaskTemplate

// RiffetApi endpoints — orchestration: review, fork, handoff, attempts, templates and schedules. Transport and auth rules: see RiffetApi.kt.

/** Sends review remarks back to the agent as a message; [commandId] is the idempotency key. */
@Throws(Exception::class)
suspend fun RiffetApi.sendReview(sessionId: String, commandId: String, comments: List<ReviewComment>, note: String? = null): Run =
    post("/api/sessions/${sessionId.enc()}/review", wireBody(SendReviewBody(commandId, comments, note))).decode()

/** The checkpoints taken before each turn of this conversation, newest first. */
@Throws(Exception::class)
suspend fun RiffetApi.sessionCheckpoints(sessionId: String): List<Checkpoint> =
    get("/api/sessions/${sessionId.enc()}/checkpoints").decode()

/**
 * Continues a conversation in a new one, optionally from turn [runId], on another [target], or in
 * a fresh worktree ([isolate]). [clientSessionId] and [commandId] make a retry idempotent.
 */
@Throws(Exception::class)
suspend fun RiffetApi.forkSession(
    sessionId: String,
    clientSessionId: String,
    commandId: String,
    runId: String? = null,
    target: LaunchTarget? = null,
    isolate: Boolean = false,
    note: String? = null,
): NativeSessionCreateResult =
    post(
        "/api/sessions/${sessionId.enc()}/fork",
        wireBody(ForkSessionBody(clientSessionId, commandId, runId, target, isolate, note)),
    ).decode()

/**
 * The first message a handoff to [target] would open with, for the user to edit before sending. A
 * configured handoff model may take minutes to write it; cancelling the call stops it on the server.
 */
@Throws(Exception::class)
suspend fun RiffetApi.handoffDraft(sessionId: String, target: LaunchTarget, goal: String? = null): HandoffDraft =
    request(
        HttpMethod.Post,
        "/api/sessions/${sessionId.enc()}/handoff/draft",
        body = wireBody(HandoffDraftBody(target, goal)),
        timeoutMillis = 150_000,
    ).decode()

/**
 * Moves the work to another backend: the new conversation is the live thread, this one stays
 * readable. [text] is the whole first message (an edited [handoffDraft]); when given, [note] is ignored.
 */
@Throws(Exception::class)
suspend fun RiffetApi.handoffSession(
    sessionId: String,
    clientSessionId: String,
    commandId: String,
    target: LaunchTarget,
    note: String? = null,
    text: String? = null,
): NativeSessionCreateResult =
    post(
        "/api/sessions/${sessionId.enc()}/handoff",
        wireBody(HandoffSessionBody(clientSessionId, commandId, target, note, text)),
    ).decode()

@Throws(Exception::class)
suspend fun RiffetApi.attemptGroups(projectId: String): List<AttemptGroup> =
    get("/api/projects/${projectId.enc()}/attempts").decode()

/** Runs [prompt] on every target in a worktree each; [requestId] makes a retry return the first group. */
@Throws(Exception::class)
suspend fun RiffetApi.createAttempts(
    projectId: String,
    prompt: String,
    targets: List<LaunchTarget>,
    base: String? = null,
    requestId: String? = null,
    attachments: List<Attachment> = emptyList(),
    context: List<PromptContextReference> = emptyList(),
): CreateAttemptsResult =
    post(
        "/api/projects/${projectId.enc()}/attempts",
        wireBody(CreateAttemptsBody(prompt, targets, base, requestId, attachments, context)),
    ).decode()

@Throws(Exception::class)
suspend fun RiffetApi.compareAttempts(groupId: String): AttemptComparisonResult =
    get("/api/attempts/${groupId.enc()}").decode()

/** Merges the chosen attempt's branch back; the body's `strategy` is `merge` or `squash`. */
@Throws(Exception::class)
suspend fun RiffetApi.adoptAttempt(groupId: String, body: AdoptAttemptBody): AdoptAttemptResult =
    post("/api/attempts/${groupId.enc()}/adopt", wireBody(body)).decode()

/** Adds one more attempt to a group, from the group's base and prompt. */
@Throws(Exception::class)
suspend fun RiffetApi.addAttempt(groupId: String, target: LaunchTarget): AddAttemptResult =
    post("/api/attempts/${groupId.enc()}/attempts", wireBody(AddAttemptBody(target))).decode()

/** Archives one attempt's conversation and marks it discarded; its worktree goes only when that loses nothing. */
@Throws(Exception::class)
suspend fun RiffetApi.discardAttempt(groupId: String, sessionId: String, removeWorktree: Boolean = false): DiscardAttemptResult =
    post("/api/attempts/${groupId.enc()}/discard", wireBody(DiscardAttemptBody(sessionId, removeWorktree))).decode()

@Throws(Exception::class)
suspend fun RiffetApi.templates(): List<TaskTemplate> = get("/api/templates").decode()

@Throws(Exception::class)
suspend fun RiffetApi.createTemplate(name: String, prompt: String, target: LaunchTarget = LaunchTarget(), isolate: Boolean = false): TaskTemplate =
    post("/api/templates", wireBody(TemplateBody(name, prompt, target, isolate))).decode()

/** Only the non-null arguments change; a null [target] keeps the template's own. */
@Throws(Exception::class)
suspend fun RiffetApi.updateTemplate(
    id: String,
    name: String? = null,
    prompt: String? = null,
    target: LaunchTarget? = null,
    isolate: Boolean? = null,
): TaskTemplate =
    patch("/api/templates/${id.enc()}", wireBody(TemplateBody(name, prompt, target, isolate))).decode()

@Throws(Exception::class)
suspend fun RiffetApi.deleteTemplate(id: String) {
    delete("/api/templates/${id.enc()}").discard()
}

@Throws(Exception::class)
suspend fun RiffetApi.runTemplate(id: String, projectId: String, clientSessionId: String, commandId: String): NativeSessionCreateResult =
    post("/api/templates/${id.enc()}/run", wireBody(RunTemplateBody(projectId, clientSessionId, commandId))).decode()

@Throws(Exception::class)
suspend fun RiffetApi.schedules(): List<Schedule> = get("/api/schedules").decode()

/** [target] is `new` (a conversation per run) or `same` (one ongoing conversation). */
@Throws(Exception::class)
suspend fun RiffetApi.createSchedule(
    name: String,
    templateId: String,
    projectId: String,
    cron: String,
    enabled: Boolean = true,
    target: String = "new",
): Schedule =
    post("/api/schedules", wireBody(ScheduleBody(name, templateId, projectId, cron, enabled, target))).decode()

/** Only the non-null arguments change. */
@Throws(Exception::class)
suspend fun RiffetApi.updateSchedule(
    id: String,
    name: String? = null,
    templateId: String? = null,
    projectId: String? = null,
    cron: String? = null,
    enabled: Boolean? = null,
    target: String? = null,
): Schedule =
    patch("/api/schedules/${id.enc()}", wireBody(ScheduleBody(name, templateId, projectId, cron, enabled, target))).decode()

@Throws(Exception::class)
suspend fun RiffetApi.deleteSchedule(id: String) {
    delete("/api/schedules/${id.enc()}").discard()
}

/** Runs a schedule now, under the same skip-while-busy rule as its timer; the outcome is in `lastResult`. */
@Throws(Exception::class)
suspend fun RiffetApi.runSchedule(id: String): Schedule =
    post("/api/schedules/${id.enc()}/run").decode()
