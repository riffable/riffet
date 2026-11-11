package riffet.ui.interaction

import riffet.contracts.NativeInteraction
import riffet.contracts.NativeInteractionResponse
import riffet.contracts.NativeInteractionResultStatus

/*
 * The answer card's state machine, for every client: Android and both Apple apps run this file, and
 * the web runs its port, `apps/web/src/app/session/nativeInteractionCardState.ts`. Both are held to the
 * same scenarios (`fixtures/interaction-card/scenarios.json`), so the four cards cannot drift apart
 * again. A client keeps one [InteractionCardState], replaces it with what these functions return,
 * performs the request a transition asks for, and stores [InteractionCardState.storedDraft] and
 * [InteractionCardState.submission] wherever it keeps them across a remount.
 *
 *   POSTING ─▶ SUCCESS · UNCERTAIN · UNKNOWN · STALE      UNKNOWN ─retry─▶ POSTING (same requestId)
 *
 * The CLI redraws its dialog constantly, and every redraw is a new revision. One that lands while an
 * answer is out (POSTING) or inconclusive (UNKNOWN, UNCERTAIN) waits: the card keeps showing what was
 * answered, so the same-request retry stays possible, until the answer settles or the reader syncs.
 * Applying a revision starts the draft over from the CLI's own state, and says so only when that lost
 * something the reader changed and never got through.
 */

enum class SubmissionPhase { POSTING, UNKNOWN, UNCERTAIN, STALE, SUCCESS }

/** An answer that was sent. [message] is what the server said about an uncertain result. */
data class InteractionSubmission(
    val phase: SubmissionPhase,
    val interaction: NativeInteraction,
    val request: NativeInteractionResponse,
    val draft: InteractionDraft,
    val message: String? = null,
)

/** [DRAFT_STALE]: a newer question replaced input the reader never got through. [UNCONFIRMED]: check the current choice. */
enum class InteractionNotice { DRAFT_STALE, UNCONFIRMED }

enum class InteractionErrorKind { SUBMIT, SYNC }

/** A failure with nothing to retry; [message] is the server's or the transport's, shown as is when present. */
data class InteractionError(val kind: InteractionErrorKind, val message: String?)

data class InteractionCardState(
    /** The live interaction, as the server last sent it. */
    val interaction: NativeInteraction,
    /** The revision the draft was taken from. */
    val appliedRevision: String,
    val draft: InteractionDraft,
    /** The reader changed the draft since it was taken from a revision or sent. */
    val edited: Boolean = false,
    val submission: InteractionSubmission? = null,
    val notice: InteractionNotice? = null,
    val error: InteractionError? = null,
    val syncing: Boolean = false,
    /** The reader synced since the last answer went out: the next revision applies even while that answer is inconclusive. */
    val synced: Boolean = false,
) {
    /** Showing what was answered rather than the live interaction. */
    val frozen: Boolean get() = submission?.phase.let { it == SubmissionPhase.POSTING || it == SubmissionPhase.UNKNOWN || it == SubmissionPhase.UNCERTAIN }
    val shown: NativeInteraction get() = if (frozen) submission!!.interaction else interaction
    val currentDraft: InteractionDraft get() = if (frozen) submission!!.draft else draft
    /** The controls are off. A refused (STALE) answer is not busy: the reader may pick again and resubmit. */
    val busy: Boolean get() = syncing || frozen || submission?.phase == SubmissionPhase.SUCCESS
    val canRetry: Boolean get() = submission?.phase == SubmissionPhase.UNKNOWN && !syncing
    val canSync: Boolean get() = submission?.phase.let { it == SubmissionPhase.UNKNOWN || it == SubmissionPhase.STALE || it == SubmissionPhase.UNCERTAIN }
    /** The draft to keep across a remount; nothing when the reader has not changed it. */
    val storedDraft: InteractionDraft? get() = draft.takeIf { edited && it.revision == interaction.revision }
}

/**
 * The card as it mounts, from what was stored for this interaction. An answer still POSTING when the
 * card went away belongs to a request the new card cannot await, so it comes back UNKNOWN and is
 * retried as the same request. A stored draft is always one the reader changed.
 */
fun restoreInteractionCard(
    interaction: NativeInteraction,
    savedDraft: InteractionDraft? = null,
    savedSubmission: InteractionSubmission? = null,
): InteractionCardState {
    val submission = savedSubmission
        ?.takeIf { it.interaction.id == interaction.id && it.interaction.revision == interaction.revision }
        ?.let { if (it.phase == SubmissionPhase.POSTING) it.copy(phase = SubmissionPhase.UNKNOWN) else it }
    val base = InteractionCardState(interaction, interaction.revision, snapshotInteractionDraft(interaction), submission = submission)
    return when {
        savedDraft == null -> base
        savedDraft.revision != interaction.revision -> base.copy(notice = InteractionNotice.DRAFT_STALE)
        else -> base.copy(draft = validDraft(interaction, savedDraft), edited = true)
    }
}

private fun validDraft(interaction: NativeInteraction, saved: InteractionDraft): InteractionDraft {
    val ids = interaction.options.map { it.id }.toSet()
    val selected = saved.selectedIds.filter { it in ids }
    val other = sanitizeOtherText(saved.otherText)
    return InteractionDraft(
        revision = interaction.revision,
        selectedIds = if (interaction.multiple == true) selected else if (other.isNotEmpty()) emptyList() else selected.take(1),
        otherText = other,
    )
}

/** The server sent the interaction again (a redraw, the next question of the same request). */
fun InteractionCardState.interactionChanged(next: NativeInteraction): InteractionCardState =
    copy(interaction = next).settle()

private fun InteractionCardState.settle(): InteractionCardState {
    if (interaction.revision == appliedRevision || (frozen && !synced)) return this
    val phase = submission?.phase
    val notice = when {
        phase == SubmissionPhase.SUCCESS -> null
        synced && (phase == SubmissionPhase.UNKNOWN || phase == SubmissionPhase.UNCERTAIN) -> InteractionNotice.UNCONFIRMED
        phase != null || edited -> InteractionNotice.DRAFT_STALE
        else -> null
    }
    return copy(
        appliedRevision = interaction.revision, draft = snapshotInteractionDraft(interaction), edited = false,
        submission = null, notice = notice, error = null, synced = false,
    )
}

private fun InteractionCardState.edit(next: InteractionDraft): InteractionCardState =
    copy(draft = next, edited = true, notice = null)

/** A press on an option: toggles it in a multi-select, else selects it alone and drops the free text. */
fun InteractionCardState.selectOption(optionId: String): InteractionCardState {
    if (busy) return this
    val current = currentDraft
    return edit(
        if (shown.multiple == true) {
            current.copy(selectedIds = if (optionId in current.selectedIds) current.selectedIds - optionId else current.selectedIds + optionId)
        } else {
            current.copy(selectedIds = listOf(optionId), otherText = "")
        },
    )
}

/** Typing in the free-text field. Text replaces a single-select's choice; a locked field cannot be cleared. */
fun InteractionCardState.changeOtherText(value: String): InteractionCardState {
    if (busy) return this
    val current = currentDraft
    val text = sanitizeOtherText(value)
    if (otherTextLocked(shown) && current.otherText.isNotEmpty() && text.isEmpty()) return this
    return edit(current.copy(otherText = text, selectedIds = if (shown.multiple == true || text.isEmpty()) current.selectedIds else emptyList()))
}

/** The request an action sends with the current draft. Free text goes only to an interaction that takes it. */
fun interactionRequest(interaction: NativeInteraction, draft: InteractionDraft, action: String, requestId: String): NativeInteractionResponse {
    val base = NativeInteractionResponse(interactionId = interaction.id, revision = interaction.revision, requestId = requestId, action = action)
    if (!carriesSelection(interaction, action)) return base
    return base.copy(
        selectedIds = draft.selectedIds.ifEmpty { null },
        otherText = draft.otherText.takeIf { interaction.allowOther == true && it.isNotBlank() },
    )
}

/** Sending [action]; `null` while the controls are off. The caller posts `submission.request`. */
fun InteractionCardState.submit(action: String, requestId: String): InteractionCardState? {
    if (busy) return null
    val sent = currentDraft
    return copy(
        submission = InteractionSubmission(SubmissionPhase.POSTING, shown, interactionRequest(shown, sent, action, requestId), sent),
        notice = null, error = null, synced = false,
    )
}

/** Sending an inconclusive answer again, as the same request; `null` when there is none. */
fun InteractionCardState.retry(): InteractionCardState? =
    if (!canRetry) null else copy(submission = submission!!.copy(phase = SubmissionPhase.POSTING, message = null), error = null, synced = false)

private fun InteractionCardState.answering(requestId: String): Boolean =
    submission?.phase == SubmissionPhase.POSTING && submission.request.requestId == requestId

/** The server answered request [requestId]. */
fun InteractionCardState.responded(requestId: String, status: NativeInteractionResultStatus, message: String? = null): InteractionCardState {
    if (!answering(requestId)) return this
    val taken = status != NativeInteractionResultStatus.UNCERTAIN
    return copy(
        submission = submission!!.copy(phase = if (taken) SubmissionPhase.SUCCESS else SubmissionPhase.UNCERTAIN, message = message),
        edited = edited && !taken,
    ).settle()
}

/**
 * Request [requestId] failed with HTTP [status], or with no response at all (`null`). A refusal of the
 * revision (409) is STALE; a result that may have landed (no response, 5xx) is UNKNOWN and retried as the
 * same request; anything else was refused outright and leaves the draft to fix.
 */
fun InteractionCardState.failed(requestId: String, status: Int?, message: String? = null): InteractionCardState {
    if (!answering(requestId)) return this
    val next = when {
        status == 409 -> copy(submission = submission!!.copy(phase = SubmissionPhase.STALE, message = null))
        status == null || status == 0 || status >= 500 -> copy(submission = submission!!.copy(phase = SubmissionPhase.UNKNOWN, message = null))
        else -> copy(submission = null, error = InteractionError(InteractionErrorKind.SUBMIT, message))
    }
    return next.settle()
}

fun InteractionCardState.syncStarted(): InteractionCardState = copy(syncing = true, error = null)

fun InteractionCardState.syncFailed(message: String?): InteractionCardState =
    copy(syncing = false, error = InteractionError(InteractionErrorKind.SYNC, message))

/**
 * The reader's sync returned [fresh], the server's interaction now (`null`: it is gone). When it is still
 * the question a refused answer was sent to, that answer is dropped and the reader asked to check the
 * choice. A terminal's visible dialog can also reset an uncertain answer; an unchanged protocol request
 * cannot confirm resolution and must keep it frozen. An UNKNOWN one keeps its same-request retry.
 * The draft is never touched here: a newer revision applies as any other, including one that waited.
 */
fun InteractionCardState.synced(fresh: NativeInteraction?): InteractionCardState {
    val base = copy(syncing = false, synced = true)
    val sent = submission
    if (fresh == null) return if (sent?.phase == SubmissionPhase.STALE) base.copy(submission = null) else base
    val sameQuestion = sent != null && fresh.id == sent.request.interactionId && fresh.revision == sent.request.revision
    // An unresolved candidate may already have been sent; the same pending protocol request is not
    // evidence that a fresh requestId may safely perform that side effect again.
    if (sameQuestion && sent.phase == SubmissionPhase.UNCERTAIN && (fresh.transport == "protocol" || sent.interaction.transport == "protocol")) {
        return base.copy(synced = false)
    }
    val dropped = if (sameQuestion && (sent.phase == SubmissionPhase.STALE || sent.phase == SubmissionPhase.UNCERTAIN)) {
        base.copy(submission = null, notice = InteractionNotice.UNCONFIRMED)
    } else {
        base
    }
    return dropped.settle()
}
