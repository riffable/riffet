package riffet.ui.state

import riffet.contracts.NativeBackendCapabilities
import riffet.contracts.NativeBackendId
import riffet.contracts.NativeDeliveryState
import riffet.contracts.NativeInteraction
import riffet.contracts.NativeInteractionTransport
import riffet.contracts.NativeStatus
import riffet.contracts.NativeStatusPhase
import riffet.contracts.Run
import riffet.contracts.Session
import riffet.contracts.SessionState
import riffet.i18n.L10n

/** Why the open conversation is not connected, as `connectionNoticeState` in `nativeHistoryLoad.ts` names it. */
enum class ConnectionNotice { RECONNECTING, FAILED, CONFLICT }

/** The conversation header's status badge: [loading] shows a spinner, [warning] the warning colour. */
data class SessionBadge(val text: String, val warning: Boolean, val loading: Boolean)

/**
 * What the open conversation's status means for its page, derived the way
 * `apps/web/src/app/terminal/NativeSession.tsx` does. Desktop hosts extend the web in one place:
 * [syncing] (the status has not arrived, or the stream is still being opened) shares the header's
 * loading badge with starting and reconnecting, and a transport that gave up is [ConnectionNotice.FAILED].
 */
data class ConversationStatus(
    /** The CLI is running; a guess from the list's session state until [statusKnown]. */
    val live: Boolean,
    val statusKnown: Boolean,
    val starting: Boolean,
    val syncing: Boolean,
    val archived: Boolean,
    /** The CLI waits on a dialog the page can answer. */
    val recognizedInteraction: Boolean,
    /** The CLI waits on something only its terminal shows. */
    val unknownAttention: Boolean,
    val connectionNotice: ConnectionNotice?,
    val badge: SessionBadge?,
)

/** `hasNativeTerminal` in `apps/web/src/lib/backends.ts`; without a catalog only Cursor is known to have one. */
fun supportsNativeTerminal(capabilities: NativeBackendCapabilities?, backend: NativeBackendId): Boolean =
    capabilities?.let {
        it.supportsTerminal ?: (it.interactionTransport == NativeInteractionTransport.TERMINAL || it.interactionTransport == NativeInteractionTransport.BOTH)
    } ?: (backend == NativeBackendId.CURSOR)

/**
 * The open conversation's [ConversationStatus] from the store's snapshot ([status], [connection],
 * [runs], [interaction]) and what the host knows besides: a reopen in flight ([reopening]) and
 * whether the backend has a terminal ([supportsTerminal], see [supportsNativeTerminal]).
 */
fun conversationStatus(
    session: Session,
    status: NativeStatus?,
    connection: RiffetConnectionState,
    runs: List<Run>,
    interaction: NativeInteraction?,
    reopening: Boolean,
    supportsTerminal: Boolean,
): ConversationStatus {
    val phase = status?.phase
    val live = if (status != null) phase != NativeStatusPhase.OFFLINE else session.state.active
    val archived = session.archivedAt != null
    val syncing = !archived && (status == null || connection == RiffetConnectionState.Connecting || connection == RiffetConnectionState.Idle)
    val preparing = runs.any { it.native?.delivery in PREPARING_DELIVERIES }
    val starting = reopening || phase == NativeStatusPhase.STARTING ||
        (!live && session.state == SessionState.STARTING) || (!live && preparing)
    val recognizedInteraction = interaction?.actions?.isNotEmpty() == true
    val unknownAttention = phase == NativeStatusPhase.ATTENTION && !recognizedInteraction
    // The provider's own connection state first, as on the web; then this client's stream. A stream
    // that has failed outranks the provider's last "reconnecting": that report can no longer change.
    val provider = status?.connection?.state
    val connectionNotice = when {
        provider == "conflict" -> ConnectionNotice.CONFLICT
        provider == "failed" || connection is RiffetConnectionState.Failed -> ConnectionNotice.FAILED
        provider == "reconnecting" || connection == RiffetConnectionState.Reconnecting -> ConnectionNotice.RECONNECTING
        else -> null
    }
    val badge = when {
        archived -> null
        connectionNotice != null -> when (connectionNotice) {
            ConnectionNotice.CONFLICT -> SessionBadge(L10n.uiText("badge.connectionConflict"), warning = true, loading = false)
            ConnectionNotice.FAILED -> SessionBadge(L10n.uiText("badge.connectionFailed"), warning = true, loading = false)
            ConnectionNotice.RECONNECTING -> SessionBadge(L10n.uiText("badge.reconnecting"), warning = false, loading = true)
        }
        starting -> SessionBadge(L10n.uiText("badge.starting"), warning = false, loading = true)
        syncing -> SessionBadge(L10n.uiText("badge.syncing"), warning = false, loading = true)
        recognizedInteraction -> SessionBadge(L10n.uiText("badge.waitingConfirmation"), warning = true, loading = false)
        unknownAttention -> SessionBadge(
            if (supportsTerminal) L10n.uiText("badge.waitingTerminal") else L10n.uiText("badge.waitingInteraction"),
            warning = true,
            loading = false,
        )
        else -> null
    }
    return ConversationStatus(
        live = live,
        statusKnown = status != null,
        starting = starting,
        syncing = syncing,
        archived = archived,
        recognizedInteraction = recognizedInteraction,
        unknownAttention = unknownAttention,
        connectionNotice = connectionNotice,
        badge = badge,
    )
}

/** A run the server accepted but has not handed to the CLI yet. */
private val PREPARING_DELIVERIES = setOf(
    NativeDeliveryState.QUEUED,
    NativeDeliveryState.PREPARING,
    NativeDeliveryState.DISPATCHING,
    NativeDeliveryState.INPUT_SENT,
)
