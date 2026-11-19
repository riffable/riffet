package riffet.contracts

import kotlinx.serialization.Serializable

/**
 * The session control view (`packages/contracts/src/control.ts`, docs/DISPATCH-ARCHITECTURE.md §3.2).
 * One snapshot is the authority for the foreground turn, the inbox, and which actions a client may offer.
 *
 * The string unions stay strings. The server may add a value, and a client compares the ones it knows
 * (`placement == "queued"`, `actions` contains `send_now`) instead of failing the frame on a new spelling.
 */

@Serializable
data class InboxEntry(
    val id: String,
    val commandId: String,
    /** `message` or `steer`. */
    val kind: String,
    /** `sending`: entering the transcript. `queued`: blocked, shown in the queue. */
    val placement: String,
    /** `queued`, `preparing`, `sending`, `uncertain`, or `failed`. */
    val status: String,
    val prompt: NativeRunInput,
    val contextSnapshots: List<CapturedSessionReference>? = null,
    val createdAt: String,
    val updatedAt: String,
    val error: String? = null,
    val diagnostic: NativeRunDiagnostic? = null,
    /** Actions the server allows. A client does not invent a second set. */
    val actions: List<String>,
)

@Serializable
data class ActiveTurnState(
    /** Journal turn key, or the provider turn id when that is all the server has. */
    val turnId: String? = null,
    val ownerRunId: String? = null,
    val nativeSessionId: String? = null,
    val nativeTurnId: String? = null,
    /** `starting`, `running`, `stopping`, or `attention`. */
    val phase: String,
    val startedAt: String? = null,
    val canStop: Boolean,
    val canSteer: Boolean,
)

/** Top-level action permissions for the composer and the toolbar. */
@Serializable
data class SessionControlCapabilities(
    val canStop: Boolean,
    val canSteer: Boolean,
    val canSendNow: Boolean,
)

@Serializable
data class SessionControlSnapshot(
    /** Monotonic per stream. A client drops a frame whose revision went backwards. A hello starts it over. */
    val revision: Long,
    /** `offline`, `starting`, `ready`, `conflict`, or `failed`. */
    val runtime: String,
    /** Null is an idle foreground. A value is the turn that owns it. */
    val activeTurn: ActiveTurnState? = null,
    /** Unfinished inputs in dispatch order: the one sending now, then what is waiting. */
    val inbox: List<InboxEntry>,
    /** Why the queue is held. The same value [NativeQueue.held] reports. */
    val held: NativeQueueHold? = null,
    val capabilities: SessionControlCapabilities,
    val interaction: NativeInteraction? = null,
    val activity: NativeActivitySummary,
    val outputRate: OutputRate? = null,
    val connection: NativeProviderConnection? = null,
    val history: NativeHistoryStatus? = null,
    val runtimeControl: NativeRuntimeControl? = null,
    val notice: String? = null,
    /** `info`, `warning`, or `error`. */
    val noticeLevel: String? = null,
    val model: String? = null,
    val permission: String? = null,
    val approval: String? = null,
    val profilePending: Boolean? = null,
    val transcript: String? = null,
)
