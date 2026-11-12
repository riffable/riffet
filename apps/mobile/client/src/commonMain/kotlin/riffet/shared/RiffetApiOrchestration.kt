package riffet.shared

import io.ktor.http.HttpMethod
import riffet.contracts.Attachment
import riffet.contracts.Automation
import riffet.contracts.AutomationRun
import riffet.contracts.AutomationTrigger
import riffet.contracts.AttemptGroup
import riffet.contracts.Checkpoint
import riffet.contracts.HandoffDraft
import riffet.contracts.LaunchTarget
import riffet.contracts.ReviewComment
import riffet.contracts.Run

// RiffetApi endpoints — orchestration: review, fork, handoff, attempts and automations. Transport and auth rules: see RiffetApi.kt.

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

/** Every automation the client can see, follow-ups included. */
@Throws(Exception::class)
suspend fun RiffetApi.automations(): List<Automation> = get("/api/automations").decode()

/** [delivery] is `new` or `same`; [catchUp] is `latest` or `skip`. A null [projectId] is chosen at each run. */
@Throws(Exception::class)
suspend fun RiffetApi.createAutomation(
    name: String,
    prompt: String,
    target: LaunchTarget = LaunchTarget(),
    projectId: String? = null,
    isolate: Boolean = false,
    triggers: List<AutomationTrigger> = emptyList(),
    delivery: String = "new",
    catchUp: String = "latest",
    enabled: Boolean = true,
): Automation =
    post(
        "/api/automations",
        wireBody(AutomationBody(name, prompt, target, projectId, isolate, triggers, delivery, catchUp, enabled)),
    ).decode()

/** Only the non-null arguments change; [triggers] replaces the whole list. */
@Throws(Exception::class)
suspend fun RiffetApi.updateAutomation(
    id: String,
    name: String? = null,
    prompt: String? = null,
    target: LaunchTarget? = null,
    projectId: String? = null,
    isolate: Boolean? = null,
    triggers: List<AutomationTrigger>? = null,
    delivery: String? = null,
    catchUp: String? = null,
    enabled: Boolean? = null,
): Automation =
    patch(
        "/api/automations/${id.enc()}",
        wireBody(AutomationBody(name, prompt, target, projectId, isolate, triggers, delivery, catchUp, enabled)),
    ).decode()

@Throws(Exception::class)
suspend fun RiffetApi.deleteAutomation(id: String) {
    delete("/api/automations/${id.enc()}").discard()
}

/** Runs once now without moving the next time; [projectId] is required when the automation has none. */
@Throws(Exception::class)
suspend fun RiffetApi.runAutomation(id: String, projectId: String? = null, clientSessionId: String? = null, commandId: String? = null): AutomationRun =
    post("/api/automations/${id.enc()}/run", wireBody(RunAutomationBody(projectId, clientSessionId, commandId))).decode()

/** One automation's runs, newest first. */
@Throws(Exception::class)
suspend fun RiffetApi.automationRuns(id: String): List<AutomationRun> =
    get("/api/automations/${id.enc()}/runs").decode()

/** The runs of every visible automation, newest first. */
@Throws(Exception::class)
suspend fun RiffetApi.recentAutomationRuns(limit: Int = 20): List<AutomationRun> =
    get("/api/automation-runs?limit=$limit").decode()

/** Sends [prompt] as a turn of [sessionId] at [at] (ISO time, read in [timeZone]): the composer's send later. */
@Throws(Exception::class)
suspend fun RiffetApi.createFollowUp(
    sessionId: String,
    prompt: String,
    at: String,
    timeZone: String? = null,
    attachments: List<Attachment> = emptyList(),
    context: List<PromptContextReference> = emptyList(),
    id: String? = null,
): Automation =
    post(
        "/api/automations",
        wireBody(AutomationBody(id = id, prompt = prompt, followUp = FollowUpRef(sessionId),
            triggers = listOf(AutomationTrigger(kind = "once", at = at, timeZone = timeZone)),
            attachments = attachments.takeIf { it.isNotEmpty() }?.map { AttachmentRef(it.id) },
            context = context.fileReferences(),
            references = context.sessionReferences(),
        )),
    ).decode()
