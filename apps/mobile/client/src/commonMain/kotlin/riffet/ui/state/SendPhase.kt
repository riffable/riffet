package riffet.ui.state

import riffet.contracts.NativeDeliveryState
import riffet.contracts.NativeQueue
import riffet.contracts.Run

/**
 * Where a message sent to the CLI stands, as the client sees it: the web's `delivery.ts`. The places
 * that ask "is it still queued", "can it still be sent now or withdrawn" and "where does it show" all
 * read it here, so they cannot disagree about the same run in the same frame.
 *
 *   SUBMITTING ─▶ QUEUED ─▶ STARTING ─▶ SENT
 *        └───────────┴──────────┴──────▶ UNCERTAIN · FAILED · CANCELLED
 *
 * [SUBMITTING] is this client's own copy before the server answered ([HTTP_PENDING]); [STARTING] is
 * the server preparing and dispatching it; [SENT] is the CLI having it.
 */
enum class SendPhase { SUBMITTING, QUEUED, STARTING, SENT, UNCERTAIN, FAILED, CANCELLED }

fun sendPhase(run: Run): SendPhase? {
    val native = run.native ?: return null
    return when (native.delivery) {
        NativeDeliveryState.QUEUED -> if (native.stage == HTTP_PENDING) SendPhase.SUBMITTING else SendPhase.QUEUED
        NativeDeliveryState.PREPARING, NativeDeliveryState.DISPATCHING -> SendPhase.STARTING
        NativeDeliveryState.INPUT_SENT, NativeDeliveryState.OBSERVED -> SendPhase.SENT
        NativeDeliveryState.UNCERTAIN -> SendPhase.UNCERTAIN
        NativeDeliveryState.FAILED -> SendPhase.FAILED
        NativeDeliveryState.CANCELLED -> SendPhase.CANCELLED
    }
}

/** A queued message (not a steer) the server holds: it can still be sent now, edited or withdrawn. */
fun inQueue(run: Run): Boolean = run.native?.intent != "steer" && sendPhase(run) == SendPhase.QUEUED

enum class MessagePlace { DOCK, TRANSCRIPT }

/**
 * Where the message shows: in the dock above the composer while it waits its turn, else in the
 * transcript. A send the server has not answered goes where it will most likely land, the dock while
 * the session is working, so it does not show in the transcript first and move a moment later.
 *
 * The server accepts every send as queued and, when nothing runs, starts the first one at once: that
 * one ([next], with no stated reason to wait) stays in the transcript, so a direct send does not pass
 * through the dock on its way there.
 *
 * Once the server has said where its queue stands ([queue]), that answer decides and [sessionWorking]
 * is not consulted; [next] then only stands for "the oldest run the server holds" when the answer
 * names none.
 */
fun messagePlace(run: Run, sessionWorking: Boolean, next: Boolean = false, queue: NativeQueue? = null): MessagePlace {
    if (run.native?.intent == "steer") return MessagePlace.TRANSCRIPT
    if (queue != null) {
        return when (sendPhase(run)) {
            SendPhase.QUEUED -> when {
                queue.held != null -> MessagePlace.DOCK
                queue.next == run.id -> MessagePlace.TRANSCRIPT
                queue.next == null && next -> MessagePlace.TRANSCRIPT
                else -> MessagePlace.DOCK
            }
            SendPhase.SUBMITTING -> if (queue.held != null || queue.next != null) MessagePlace.DOCK else MessagePlace.TRANSCRIPT
            else -> MessagePlace.TRANSCRIPT
        }
    }
    return when (sendPhase(run)) {
        SendPhase.QUEUED -> if (sessionWorking || !next || run.native?.stage != null) MessagePlace.DOCK else MessagePlace.TRANSCRIPT
        SendPhase.SUBMITTING -> if (sessionWorking) MessagePlace.DOCK else MessagePlace.TRANSCRIPT
        else -> MessagePlace.TRANSCRIPT
    }
}

/** The same recovery affordances for Swift and Compose; HTTP uncertainty belongs to local Outbox. */
data class MessageRecovery(val needsCheck: Boolean, val canRetry: Boolean, val taskOutcomeUnknown: Boolean)

fun messageRecovery(run: Run): MessageRecovery {
    val native = run.native ?: return MessageRecovery(false, false, false)
    val outcomeUnknown = native.stage == "turn_outcome_unknown"
    return MessageRecovery(
        needsCheck = native.delivery == NativeDeliveryState.UNCERTAIN || outcomeUnknown || native.stage == "acknowledged",
        canRetry = native.delivery == NativeDeliveryState.UNCERTAIN && native.stage == HTTP_UNKNOWN,
        taskOutcomeUnknown = outcomeUnknown || ((native.delivery == NativeDeliveryState.UNCERTAIN || native.stage == "acknowledged") &&
            (native.nativeMessageId != null || native.timings?.get("observedAt") != null || native.timings?.get("providerAcceptedAt") != null)),
    )
}
