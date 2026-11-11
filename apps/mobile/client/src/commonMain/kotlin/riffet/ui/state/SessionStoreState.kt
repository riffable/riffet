package riffet.ui.state

import riffet.contracts.AppSettings
import riffet.contracts.Attachment
import riffet.contracts.NativeContext
import riffet.contracts.NativeHistoryState
import riffet.contracts.NativeInteraction
import riffet.contracts.NativeStatus
import riffet.contracts.Project
import riffet.contracts.Run
import riffet.contracts.Session
import riffet.core.StoredSubagent

/** The project/session list, from `GET /api/bootstrap` or, until that answers, from the device. */
data class SessionListState(
    val projects: List<Project> = emptyList(),
    val sessions: List<Session> = emptyList(),
    /** Server-wide defaults (backend, model, approval) the home composer starts from. */
    val settings: AppSettings? = null,
    /** A provider write invalidates the retained home page's catalog without recreating its draft. */
    val backendRevision: Long = 0L,
    val loading: Boolean = false,
    /** True once a load has finished, successfully or not; distinguishes "loading" from "empty". */
    val loaded: Boolean = false,
    val error: String? = null,
    /** When the lists shown were saved on the device; null once the server has answered. */
    val cachedAt: Long? = null,
    /** The server deletes conversations (`session-delete-v1`); learned from the bootstrap. */
    val canDeleteSessions: Boolean = false,
)

/** The lifecycle of the one native stream this store holds open. */
sealed interface RiffetConnectionState {
    /** No session is open. */
    data object Idle : RiffetConnectionState

    /** A stream was started and no frame has arrived yet. */
    data object Connecting : RiffetConnectionState

    /** Frames are arriving; the transcript is authoritative. */
    data object Live : RiffetConnectionState

    /** The previous connection died and a new one is being attempted; reported by the transport. */
    data object Reconnecting : RiffetConnectionState

    data class Failed(val reason: String) : RiffetConnectionState
}

/**
 * The composer's own in-progress state, separate from the run list.
 *
 * [pendingRunIds] is one-at-a-time action guarding (a "立即发送" press disables the row until the
 * server answers); [sending]/[interrupting] stop a second submit while the first is unresolved;
 * [error]/[notice] are the two lines the composer shows under the input.
 */
data class ComposerSendState(
    val sending: Boolean = false,
    val interrupting: Boolean = false,
    val pendingRunIds: Set<String> = emptySet(),
    val error: String? = null,
    val notice: String? = null,
)

/** A queued message moved back into the input by [SessionStore.takeBackQueued]. */
class QueuedDraft(
    val text: String,
    val attachments: List<Attachment>,
    val context: List<riffet.shared.PromptContextReference> = emptyList(),
)

/**
 * The open session's live state as one value, derived from the store's single state, so a host that
 * renders these together never draws a mix of two moments (one session's runs under another's
 * status). [sessionId] names the session the stream is open on; every other field belongs to it.
 * [epoch] changes whenever the open conversation does, so two reads can be checked for consistency.
 *
 * Not included: the transcript ([SessionStore.timeline]) and [SessionStore.outputRate], which change
 * many times a second; [status] here carries no `outputRate`.
 */
data class OpenSessionState(
    val sessionId: String? = null,
    val selected: Session? = null,
    val interaction: NativeInteraction? = null,
    val queued: List<Run> = emptyList(),
    val uncertain: List<Run> = emptyList(),
    val runs: List<Run> = emptyList(),
    val status: NativeStatus? = null,
    /** The store's `working`: the CLI reports BUSY or ATTENTION. */
    val working: Boolean = false,
    val connection: RiffetConnectionState = RiffetConnectionState.Idle,
    val epoch: Int = 0,
    /** True once the open session has received its first snapshot (stored or live). */
    val loaded: Boolean = false,
    val sendState: ComposerSendState = ComposerSendState(),
    val history: NativeHistoryState? = null,
    val loadingHistory: Boolean = false,
    val historyError: String? = null,
    /** When the transcript on screen was last confirmed by the server, while it is still the stored copy. */
    val cachedAt: Long? = null,
    val context: NativeContext? = null,
    val subagents: List<StoredSubagent> = emptyList(),
)
