package riffet.contracts

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/*
 * Hand-written DTOs ported from packages/contracts/src/index.ts, which is the authoritative
 * source of the wire types. This file is a faithful encoding of that TS file, not a
 * re-generation: docs/MOBILE.md deliberately rejects code generation because "fixture
 * round-trips" catch the failures that generation cannot (nullability, renamed fields,
 * optional fields, unknown fields).
 *
 * Rules followed here:
 *  - a TS `?` becomes a nullable Kotlin type with a `= null` default;
 *  - a TS field that JSON always sends stays non-null and non-defaulted, so a missing key is a
 *    loud deserialization failure rather than a silently wrong default;
 *  - `@SerialName` is used wherever the JSON name differs from the Kotlin name.
 */

@Serializable
enum class NativeBackendId {
    @SerialName("cursor") CURSOR,
    @SerialName("codex") CODEX,
    @SerialName("claude") CLAUDE,
    @SerialName("dsh") DSH,
    @SerialName("droid") DROID,
    @SerialName("traex") TRAEX,
    @SerialName("pi") PI,
    @SerialName("chat") CHAT,
}

@Serializable
enum class SessionKind {
    @SerialName("native") NATIVE,
}

@Serializable
enum class SessionState {
    @SerialName("idle") IDLE,
    @SerialName("starting") STARTING,
    @SerialName("running") RUNNING,
    @SerialName("waiting") WAITING,
    @SerialName("cancelling") CANCELLING,
    @SerialName("interrupted") INTERRUPTED,
    @SerialName("failed") FAILED,
    @SerialName("archived") ARCHIVED,
}

/**
 * How the native CLI approves tool calls, in the CLI's own vocabulary: `allowlist` asks per call
 * through its allowlist, `auto-review` lets Cursor's classifier run the safe ones, `unrestricted`
 * is "Run Everything".
 */
@Serializable
enum class ApprovalMode {
    @SerialName("allowlist") ALLOWLIST,
    @SerialName("auto-review") AUTO_REVIEW,
    @SerialName("unrestricted") UNRESTRICTED,
}

@Serializable
enum class NativeDeliveryState {
    @SerialName("queued") QUEUED,
    @SerialName("preparing") PREPARING,
    @SerialName("dispatching") DISPATCHING,
    @SerialName("input_sent") INPUT_SENT,
    @SerialName("observed") OBSERVED,
    @SerialName("uncertain") UNCERTAIN,
    @SerialName("failed") FAILED,
    @SerialName("cancelled") CANCELLED,
}

/*
 * Lenient enums: the control frames of sync v3 (status, runs, metrics, hello) carry these, and one
 * spelling a newer server adds must cost that value, not the frame. They decode an unknown spelling
 * to `UNKNOWN` and encode the same wire names as before. The enums Swift or Compose switch over
 * exhaustively (RunState, SessionState, NativeDeliveryState, NativeBackendId) stay strict; sync
 * v3 drops an unreadable Run from its lists instead (see Sync.kt).
 */

@Serializable(with = MetricsTokenSourceSerializer::class)
enum class MetricsTokenSource(val wire: String) {
    PROVIDER("provider"),
    ESTIMATED("estimated"),
    UNKNOWN(""),
}

/**
 * What the measured milliseconds actually bracket, which is what makes two providers comparable.
 */
@Serializable(with = MetricsWindowSerializer::class)
enum class MetricsWindow(val wire: String) {
    STREAM("stream"),
    TRANSCRIPT("transcript"),
    OBSERVED("observed"),
    UNKNOWN(""),
}

@Serializable
enum class RunState {
    @SerialName("queued") QUEUED,
    @SerialName("running") RUNNING,
    @SerialName("completed") COMPLETED,
    @SerialName("failed") FAILED,
    @SerialName("cancelled") CANCELLED,
    @SerialName("interrupted") INTERRUPTED,
}

@Serializable
enum class TerminalKind {
    @SerialName("shell") SHELL,
    @SerialName("cursor") CURSOR,
    @SerialName("native") NATIVE,
    @SerialName("login") LOGIN,
}

@Serializable
enum class TerminalState {
    @SerialName("running") RUNNING,
    @SerialName("exited") EXITED,
    @SerialName("detached") DETACHED,
}

@Serializable
data class Project(
    val id: String,
    val name: String,
    val cwd: String,
    val tags: List<String>? = null,
    val archivedAt: String? = null,
    val createdAt: String,
    val updatedAt: String,
    /**
     * Set when this project is a git worktree of another one, which is how a conversation gets a
     * checkout to itself.
     */
    val worktree: ProjectWorktree? = null,
    /** A built-in project this client must not list as an ordinary one, e.g. `quick-chat`. */
    val system: String? = null,
)

@Serializable
data class ProjectWorktree(
    val originProjectId: String,
    val branch: String,
)

/**
 * One entry of `POST /api/browse`. The route lists directories only — files are the files panel's
 * business — so [kind] is the literal `directory`, kept here because the wire carries it.
 */
@Serializable
data class BrowseEntry(
    val name: String,
    val kind: String = "directory",
    val hidden: Boolean = false,
    /** Set when this folder is a host-level [FolderFavorite]. */
    val favoriteId: String? = null,
)

/**
 * The server host's filesystem, as `POST /api/browse` reports it: where this listing is, where it
 * came from, and where the host's home is (which is what makes `~` display possible on the phone —
 * the phone has no idea where the Mac's home is).
 */
@Serializable
data class BrowseResult(
    val path: String,
    val parent: String? = null,
    val home: String,
    val entries: List<BrowseEntry> = emptyList(),
    /** Set when the listed folder itself is a host-level [FolderFavorite]. */
    val favoriteId: String? = null,
)

/**
 * A folder bookmarked on the server, shared by every device (`FolderFavorite` in
 * packages/contracts). Without [projectId] it is a host directory and [path] is absolute; with it,
 * it belongs to that project's files panel and [path] is relative to the project's root.
 */
@Serializable
data class FolderFavorite(
    val id: String,
    val path: String,
    val label: String? = null,
    val projectId: String? = null,
    val sort: Int = 0,
    val createdAt: String,
    val lastUsedAt: String? = null,
    val exists: Boolean = true,
)

@Serializable
data class FolderFavoritesResponse(val favorites: List<FolderFavorite> = emptyList())

@Serializable
data class Session(
    val id: String,
    val projectId: String,
    val kind: SessionKind,
    val title: String,
    /**
     * Provenance of [title]: `prompt` (the first human message), `provider` (the CLI's own label) or
     * `user` (what the reader typed). Missing on rows written before the server named conversations.
     */
    val titleSource: String? = null,
    val tags: List<String>,
    val state: SessionState,
    /** Native provider routing. Missing backendId means the legacy default Cursor profile. */
    val backendId: NativeBackendId? = null,
    val backendProfileId: String? = null,
    /** Provider-owned resumable session reference. */
    val nativeSessionId: String? = null,
    val nativeRuntime: SessionNativeRuntime? = null,
    /** Deprecated Cursor reference; retained while old clients or persisted sessions use it. */
    val cursorSessionId: String? = null,
    val terminalId: String? = null,
    val terminalAppearance: TerminalAppearance? = null,
    val resumePicker: Boolean? = null,
    val model: String? = null,
    val mode: String,
    val approval: String? = null,
    val archivedAt: String? = null,
    val error: String? = null,
    /** Incremented when native model/mode/approval settings change; Runs retain the accepted revision. */
    val configRevision: Long? = null,
    /** Immutable fingerprint for a client-created native session and its first submission. */
    val creationFingerprint: String? = null,
    /** Most recent message activity; observing or editing session metadata does not change it. */
    val lastActivityAt: String? = null,
    /**
     * When the conversation last entered an active state (starting, running, waiting, cancelling).
     * Active conversations sort by it, so a streaming turn does not reshuffle them; only meaningful
     * while the state is active.
     */
    val activeSince: String? = null,
    /** A pinned conversation sorts before other conversations in its project. */
    val pinnedAt: String? = null,
    val pinRank: Int? = null,
    /** Set when the workbench opened this conversation on someone's behalf rather than from the composer. */
    val origin: SessionOrigin? = null,
    /** The conversation this one was handed off to; this one stays readable but is no longer the live thread. */
    val handedOffTo: String? = null,
    /**
     * Riffet tool groups the conversation's CLI is launched with (`riffet.core`, `device:<id>`),
     * resolved once from the creating client's settings. Strings, so a newer group never fails decoding.
     */
    val toolGroups: List<String>? = null,
    /** `mcp:<name>` / `skill:<name>` switched off for this conversation; applies the next time the CLI launches. */
    val extensionsOff: List<String>? = null,
    /** Handed to a terminal (`riffet resume`): that CLI is the only writer until the hold is released. */
    val terminalHold: SessionTerminalHold? = null,
    val createdAt: String,
    val updatedAt: String,
    /** The raw id of a plugin Agent, which [backendId] cannot hold; see [AgentIds]. */
    val agentId: String? = null,
) {
    /** The Agent's wire id, built-in or a plugin's. */
    val agent: String? get() = agentId ?: backendId?.let(AgentIds::wire)
}

/**
 * Why a conversation exists. [sessionId]/[runId] name the conversation (and turn) it continues;
 * [groupId], [templateId] and [scheduleId] name what launched it. [kind] is `fork`, `handoff`,
 * `attempt`, `template` or `schedule`; it stays a string so a newer server's new kind cannot fail
 * the whole session list.
 */
/** [pid] is the terminal CLI's process; missing while it is starting. */
@Serializable
data class SessionTerminalHold(val since: String, val pid: Int? = null)

@Serializable
data class SessionOrigin(
    val kind: String,
    val sessionId: String? = null,
    val runId: String? = null,
    val groupId: String? = null,
    val templateId: String? = null,
    val scheduleId: String? = null,
    val automationId: String? = null,
    val discussion: DiscussionOrigin? = null,
)

@Serializable
data class DiscussionOrigin(
    val anchor: MarkAnchor,
    val quote: MarkQuote,
    val capturedAt: String,
    val contextRef: String,
    val requestFingerprint: String,
)

@Serializable
data class SessionReferenceInput(
    val kind: String = "session",
    val sessionId: String,
    val fromRunId: String? = null,
)

@Serializable
data class SessionReferenceCoverage(
    val source: String,
    val completeness: String,
    val messages: Long,
    val bytes: Long,
    val from: String? = null,
    val through: String? = null,
    val activeTurnIncomplete: Boolean? = null,
    val reason: String? = null,
)

@Serializable
data class CapturedSessionReference(
    val sessionId: String,
    val title: String,
    /** Source metadata can name a plugin even when this client cannot start that Agent. */
    val backendId: String,
    val projectName: String,
    val capturedAt: String,
    val snapshotRef: String,
    val excerpt: String,
    val coverage: SessionReferenceCoverage,
    /** Plugin Agent identity preserved by AgentWire, as on Session. */
    val agentId: String? = null,
) {
    val agent: String get() = agentId ?: backendId
}

@Serializable
data class NativeRunInput(
    val text: String,
    val attachmentIds: List<String>,
    val context: List<NativeRunContextReference>,
    val references: List<SessionReferenceInput>? = null,
)

@Serializable
data class NativeRunContextReference(
    val path: String,
    val line: Long? = null,
)

/** Config values keep the selected backend's own vocabulary and semantics. */
@Serializable
data class NativeRunConfig(
    val model: String? = null,
    val mode: String,
    val approval: String? = null,
)

@Serializable
data class NativeRunDetails(
    val input: NativeRunInput,
    val contextSnapshots: List<CapturedSessionReference>? = null,
    val config: NativeRunConfig,
    /** Actual model selection after CLI capability normalization; config remains the request snapshot. */
    val resolvedConfig: NativeRunConfig? = null,
    val fingerprint: String,
    val delivery: NativeDeliveryState,
    val attempt: Long,
    val terminalId: String? = null,
    val terminalEpoch: Long? = null,
    val nativeSessionId: String? = null,
    val backendId: NativeBackendId? = null,
    val cursorSessionId: String? = null,
    val nativeMessageId: String? = null,
    val stage: String? = null,
    val timings: Map<String, Double>? = null,
    /** Baseline native event sequence and the exact text delivered to the CLI, when known. */
    val baselineSequence: Long? = null,
    val renderedText: String? = null,
    /** Driver-written, secret-free native entry boundary captured before the input was sent. */
    val nativeInputBoundary: String? = null,
    val configRevision: Long,
    val metrics: RunMetrics? = null,
    val intent: String? = null,
    val sourceRunId: String? = null,
    val nativeTurnId: String? = null,
    val ownerRunId: String? = null,
    val queueReleasedAt: String? = null,
    val diagnostic: NativeRunDiagnostic? = null,
)

@Serializable
data class NativeRunDiagnostic(val message: String, val at: String, val code: String? = null, val stage: String? = null)

@Serializable
data class StepMetrics(
    /** Backend-scoped identity of one assistant response (one provider request). */
    val stepId: String,
    val outputTokens: Long,
    val tokens: MetricsTokenSource,
    val durationMs: Long,
    val window: MetricsWindow,
    /** True while this step is still streaming; a live step is replaced by its settled value. */
    val live: Boolean,
    /** Reasoning tokens when the provider accounts for them inside `outputTokens`. */
    val reasoningTokens: Long? = null,
    /** Absolute observation interval, in epoch milliseconds, for the rolling output window. */
    val startedAt: Long? = null,
    val endedAt: Long? = null,
)

/** Turn-to-date aggregate: the sum over the turn's assistant steps. */
@Serializable
data class RunMetrics(
    val outputTokens: Long,
    val durationMs: Long,
    val tokens: RunMetricsTokenSource,
    val window: MetricsWindow,
    /** How many assistant steps contributed. Zero means the turn produced no measurable output. */
    val steps: Long,
)

/**
 * `MetricsTokenSource | 'mixed'`: an aggregate can contain both provider and estimated counts.
 */
@Serializable(with = RunMetricsTokenSourceSerializer::class)
enum class RunMetricsTokenSource(val wire: String) {
    PROVIDER("provider"),
    ESTIMATED("estimated"),
    MIXED("mixed"),
    UNKNOWN(""),
}

@Serializable
data class Run(
    val id: String,
    val sessionId: String,
    val commandId: String,
    val prompt: String,
    val state: RunState,
    val native: NativeRunDetails? = null,
    val createdAt: String,
    val updatedAt: String,
    val error: String? = null,
)

/**
 * A persisted workbench event.
 *
 * `nativeId` / `nativeAliases` are not declared on the TS `WorkbenchEvent` itself — the native
 * stream intersects them in (`NativeWorkbenchEvent`). They live here too because every consumer of
 * this type in `core/` reads them (`nativeEventIds`, `eventIdentity`), and `ignoreUnknownKeys`
 * makes their presence harmless on the non-native transports.
 */
@Serializable
data class WorkbenchEvent(
    val sequence: Long,
    val sessionId: String,
    val runId: String? = null,
    val type: String,
    val data: JsonObject = JsonObject(emptyMap()),
    val raw: JsonElement? = null,
    val createdAt: String,
    val nativeId: String? = null,
    val nativeAliases: List<String>? = null,
    val nativeTurnId: String? = null,
)

/** Foreground/background captured before the CLI process starts. */
@Serializable
data class TerminalAppearance(val foreground: String = "#d2d4d7", val background: String = "#141416") {
    val foregroundArgb: Int get() = -0x1000000 or (foreground.removePrefix("#").toIntOrNull(16) ?: 0xd2d4d7)
    val backgroundArgb: Int get() = -0x1000000 or (background.removePrefix("#").toIntOrNull(16) ?: 0x141416)
    /** Matches Codex's startup OSC colour classification. */
    val dark: Boolean get() {
        val rgb = backgroundArgb
        return 0.299 * (rgb shr 16 and 255) + 0.587 * (rgb shr 8 and 255) + 0.114 * (rgb and 255) <= 128
    }
    companion object {
        fun fromArgb(foreground: Int, background: Int): TerminalAppearance = TerminalAppearance(
            "#" + (foreground and 0xffffff).toString(16).padStart(6, '0'),
            "#" + (background and 0xffffff).toString(16).padStart(6, '0'),
        )
    }
}

@Serializable
data class TerminalInfo(
    val id: String,
    val projectId: String,
    val sessionId: String? = null,
    val title: String,
    val kind: TerminalKind,
    val state: TerminalState,
    val persistent: Boolean,
    val ownerId: String? = null,
    val epoch: Long,
    val cols: Long,
    val rows: Long,
    val createdAt: String,
    val exitCode: Long? = null,
    val appearance: TerminalAppearance? = null,
)

/**
 * `GET /api/terminals/:id/history`: the pane's ANSI scrollback. `cells-v1` versions preserve
 * physical rows and trailing cells at [cols]; older versions contain joined lines. [text] is
 * absent when [version] equals the `known` version the request named. With `mode=tail` and [append]
 * true, [text] holds only the lines added after `known`.
 */
@Serializable
data class TerminalHistory(
    val version: String,
    val text: String? = null,
    val append: Boolean? = null,
    val cols: Long? = null,
)

/** A provider-reported context meter; compaction budgets are distinct from model input windows. */
@Serializable
data class NativeContext(
    val used: Long,
    val size: Long,
    val breakdown: List<NativeContextBreakdown> = emptyList(),
    val limitKind: String? = null,
    val breakdownEstimated: Boolean = false,
)

@Serializable
data class NativeContextBreakdown(
    val id: String,
    val label: String,
    val tokens: Long,
)

/**
 * A shell task of a native conversation. It may be a foreground tool call, a background shell,
 * or a task whose final result is not yet confirmed in the CLI store.
 */
@Serializable
data class NativeJob(
    /** The tool call that started it: the timeline row this job belongs to. */
    val toolCallId: String,
    /** The CLI's own shell id, once its launch result has been read. */
    val id: String? = null,
    val title: String,
    val command: String,
    val status: NativeJobStatus,
    val startedAt: String? = null,
    val runningMs: Long? = null,
    val exitCode: Long? = null,
    /** What the agent waited for, when it awaited this job with a pattern. */
    val matched: String? = null,
    val output: String? = null,
    val truncated: Boolean? = null,
    val outputPath: String? = null,
)

/** Any status this build does not know reads as [UNKNOWN], the server's own "not confirmed". */
@Serializable(with = NativeJobStatusSerializer::class)
enum class NativeJobStatus(val wire: String) {
    RUNNING("running"),
    SUCCEEDED("succeeded"),
    FAILED("failed"),
    UNKNOWN("unknown"),
}

/** Recent model output speed over measured response windows. */
@Serializable
data class OutputRate(
    val state: OutputRateState,
    val windowSeconds: Double,
    val outputTokens: Long,
    val tokensPerSecond: Double,
    val tokens: RunMetricsTokenSource? = null,
    val durationMs: Double? = null,
    val window: MetricsWindow? = null,
)

@Serializable(with = OutputRateStateSerializer::class)
enum class OutputRateState(val wire: String) {
    NO_DATA("no_data"),
    LIVE("live"),
    ZERO("zero"),
    STALE("stale"),
    UNKNOWN(""),
}

/** What the CLI screen currently shows: working, waiting at its prompt, or a dialog needing the terminal. */
@Serializable
data class NativeTurnTarget(val nativeSessionId: String, val turnId: String)

@Serializable
data class NativeActiveTurn(val nativeSessionId: String, val turnId: String, val ownerRunId: String? = null) {
    fun target(): NativeTurnTarget = NativeTurnTarget(nativeSessionId, turnId)
}

/** Provider transport state, independent of the app's live SSE connection. Unknown states are not writable. */
@Serializable
data class NativeProviderConnection(val state: String, val message: String? = null)

/** Provider history loading state, independent of whether its event stream is connected. */
@Serializable
data class NativeHistoryStatus(val state: String, val message: String? = null)

/** An action a runtime hook's control offers; labels are keyed by locale tag. */
@Serializable
data class NativeRuntimeAction(
    val id: String,
    val label: Map<String, String>,
    val hint: Map<String, String>? = null,
    val disabled: Boolean? = null,
)

/** Shown beside the conversation's status. `tone` is `neutral`, `progress` or `danger`; unknown tones render as `neutral`. */
@Serializable
data class NativeRuntimeNotice(
    val tone: String,
    val label: Map<String, String>? = null,
    val detail: String? = null,
    val action: NativeRuntimeAction? = null,
)

/**
 * What a plugin's sidecar shows on its conversation. The plugin decides every word and state; a client
 * renders it as given and sends an action back with [revision].
 */
@Serializable
data class NativeRuntimeControl(
    val owner: String,
    val revision: String,
    val notice: NativeRuntimeNotice? = null,
    val actions: List<NativeRuntimeAction>? = null,
)

@Serializable
data class NativeStatus(
    val phase: NativeStatusPhase,
    val profilePending: Boolean? = null,
    val model: String? = null,
    val permission: String? = null,
    /** The provider's own permission setting, when it reports one we recognise. */
    val approval: String? = null,
    /**
     * Whether the CLI chat store could be read. `unavailable` means the store file is missing;
     * `unparsed` that it exists but no longer decodes.
     */
    val transcript: String? = null,
    /** A persistent session condition that needs attention independently of a turn outcome. */
    val notice: String? = null,
    /** Absent on older servers; unknown levels keep the warning fallback. */
    val noticeLevel: String? = null,
    val interaction: NativeInteraction? = null,
    val outputRate: OutputRate? = null,
    /** The active turn's event runId: an app Run id or a provider turn id for autonomous work. */
    val activeTurnId: String? = null,
    val activeTurn: NativeActiveTurn? = null,
    val connection: NativeProviderConnection? = null,
    val history: NativeHistoryStatus? = null,
    /** Activities in progress apart from the main turn; absent when the server does not report them. */
    val activity: NativeActivitySummary? = null,
    val runtimeControl: NativeRuntimeControl? = null,
    /** Where the queued messages stand; sync stream only. Absent on older servers. */
    val queue: NativeQueue? = null,
)

/**
 * The server's answer to "what starts next, and why not yet": [next] is the queued run that starts
 * first, starting now when [held] is null. An empty queue is `NativeQueue()`.
 */
@Serializable
data class NativeQueue(val next: String? = null, val held: NativeQueueHold? = null)

/** [runId] names the earlier message holding the queue, when one does. */
@Serializable
data class NativeQueueHold(val reason: NativeQueueHoldReason, val runId: String? = null)

/** Why queued messages wait. A reason this build does not know reads as [UNKNOWN]. */
@Serializable(with = NativeQueueHoldReasonSerializer::class)
enum class NativeQueueHoldReason(val wire: String) {
    TURN_RUNNING("turn_running"),
    ATTENTION("attention"),
    STOPPING("stopping"),
    SENDING("sending"),
    STEERING("steering"),
    UNCONFIRMED("unconfirmed"),
    WORKSPACE("workspace"),
    RECOVERING("recovering"),
    RETRYING("retrying"),
    UNKNOWN(""),
}

@Serializable
data class SessionNativeRuntime(val address: String, val fingerprint: String, val scopeFingerprint: String? = null)

/** Whether the CLI is compacting its context, and how many background tasks run (`NativeStatus.activity`). */
@Serializable
data class NativeActivitySummary(
    val compacting: Boolean = false,
    val background: Int = 0,
)

/** [UNKNOWN] is a phase this build cannot interpret: neither working nor offline. */
@Serializable(with = NativeStatusPhaseSerializer::class)
enum class NativeStatusPhase(val wire: String) {
    OFFLINE("offline"),
    STARTING("starting"),
    BUSY("busy"),
    IDLE("idle"),
    ATTENTION("attention"),
    UNKNOWN(""),
}

/** A verified, currently visible dialog belonging to one native terminal instance. */
@Serializable
data class NativeInteraction(
    val id: String,
    val revision: String,
    /** `terminal` preserves Cursor's epoch/revision guard; `protocol` identifies server-mediated requests. */
    val transport: String? = null,
    val terminalId: String? = null,
    val epoch: Long? = null,
    val requestId: String? = null,
    val request: Map<String, JsonElement>? = null,
    val kind: NativeInteractionKind,
    val title: String,
    val message: String? = null,
    val options: List<NativeInteractionOption> = emptyList(),
    val multiple: Boolean? = null,
    val allowOther: Boolean? = null,
    val otherValue: String? = null,
    val otherSelected: Boolean? = null,
    val questionIndex: Long? = null,
    val questionCount: Long? = null,
    val actions: List<NativeInteractionAction> = emptyList(),
    val expiresAt: String? = null,
    val extendableUntil: String? = null,
)

/** [UNKNOWN] is a dialog this build cannot draw; it is answered in the terminal. */
@Serializable(with = NativeInteractionKindSerializer::class)
enum class NativeInteractionKind(val wire: String) {
    QUESTION("question"),
    PERMISSION("permission"),
    PLAN("plan"),
    CONFIRMATION("confirmation"),
    CHOICE("choice"),
    UNKNOWN(""),
}

@Serializable
data class NativeInteractionOption(
    val id: String,
    val label: String,
    val selected: Boolean,
)

@Serializable
data class NativeInteractionAction(
    val id: String,
    val label: String,
    val tone: String? = null,
)

@Serializable
data class NativeInteractionResponse(
    val interactionId: String,
    val revision: String,
    val requestId: String,
    val action: String,
    val selectedIds: List<String>? = null,
    val otherText: String? = null,
)

@Serializable
data class NativeInteractionResult(
    val status: NativeInteractionResultStatus,
    val interaction: NativeInteraction? = null,
    val message: String? = null,
)

@Serializable
enum class NativeInteractionResultStatus {
    @SerialName("advanced") ADVANCED,
    @SerialName("completed") COMPLETED,
    @SerialName("uncertain") UNCERTAIN,
}

/**
 * Cursor into the older part of a native transcript. The generation changes when the CLI forks or
 * replaces its root.
 */
@Serializable
data class NativeHistoryState(
    val generation: String,
    val cursor: String? = null,
    val hasMore: Boolean,
    val contextIncomplete: Boolean? = null,
)

/** Native event identity includes the absolute message position, blob id, and mapped part. */
@Serializable
data class NativeWorkbenchEvent(
    val sequence: Long,
    val sessionId: String,
    val runId: String? = null,
    val type: String,
    val data: JsonObject = JsonObject(emptyMap()),
    val raw: JsonElement? = null,
    val createdAt: String,
    val nativeId: String,
    val nativeAliases: List<String>? = null,
    val nativeTurnId: String? = null,
) {
    /** Narrows to the plain event `core/` projects, carrying the native identity along. */
    fun toWorkbenchEvent(): WorkbenchEvent = WorkbenchEvent(
        sequence = sequence,
        sessionId = sessionId,
        runId = runId,
        type = type,
        data = data,
        raw = raw,
        createdAt = createdAt,
        nativeId = nativeId,
        nativeAliases = nativeAliases,
        nativeTurnId = nativeTurnId,
    )
}

/** One uploaded attachment. Image dimensions are captured at upload time. */
@Serializable
data class Attachment(
    val id: String,
    val name: String,
    val mimeType: String,
    val size: Long,
    val path: String,
    val width: Long? = null,
    val height: Long? = null,
)

@Serializable
data class ApiError(
    val error: ApiErrorBody,
)

/** `message` is English, for developers and logs; a client shows the text `code` names, filled from `params`. */
@Serializable
data class ApiErrorBody(
    val code: String,
    val message: String,
    val params: Map<String, JsonPrimitive>? = null,
    val details: JsonElement? = null,
)

/** `{ authenticated, tokenRequired, csrfToken? }` as returned by `GET /api/auth/status`. */
@Serializable
data class AuthStatus(
    val authenticated: Boolean,
    val tokenRequired: Boolean,
    val csrfToken: String? = null,
)

/*
 * Something the CLI does on its own inside a conversation (docs/SESSION-JOURNAL.md, 系统活动). It
 * arrives as a `session/update` event with `sessionUpdate: 'activity'`; a later state of the same
 * [NativeActivity.id] is a further event that replaces the earlier one in place.
 *
 * The enums decode an unknown spelling to `UNKNOWN` instead of failing: a newer server may add a
 * kind or a status, and one unreadable activity must not cost the whole transcript.
 */

@Serializable(with = NativeActivityKindSerializer::class)
enum class NativeActivityKind(val wire: String) {
    COMPACTION("compaction"),
    BACKGROUND_TASK("background_task"),
    LOCAL_COMMAND("local_command"),
    UNKNOWN(""),
}

@Serializable(with = NativeActivityStatusSerializer::class)
enum class NativeActivityStatus(val wire: String) {
    RUNNING("running"),
    STOPPING("stopping"),
    COMPLETED("completed"),
    FAILED("failed"),
    STOPPED("stopped"),
    UNKNOWN("unknown");

    /** Still going: the activity can finish, and its elapsed time is still counting. */
    val active: Boolean get() = this == RUNNING || this == STOPPING
}

internal object NativeActivityKindSerializer : LenientEnumSerializer<NativeActivityKind>(
    "NativeActivityKind", NativeActivityKind.entries, NativeActivityKind.UNKNOWN, { it.wire },
)

internal object NativeActivityStatusSerializer : LenientEnumSerializer<NativeActivityStatus>(
    "NativeActivityStatus", NativeActivityStatus.entries, NativeActivityStatus.UNKNOWN, { it.wire },
)

internal object MetricsTokenSourceSerializer : LenientEnumSerializer<MetricsTokenSource>(
    "MetricsTokenSource", MetricsTokenSource.entries, MetricsTokenSource.UNKNOWN, { it.wire },
)

internal object MetricsWindowSerializer : LenientEnumSerializer<MetricsWindow>(
    "MetricsWindow", MetricsWindow.entries, MetricsWindow.UNKNOWN, { it.wire },
)

internal object RunMetricsTokenSourceSerializer : LenientEnumSerializer<RunMetricsTokenSource>(
    "RunMetricsTokenSource", RunMetricsTokenSource.entries, RunMetricsTokenSource.UNKNOWN, { it.wire },
)

internal object NativeJobStatusSerializer : LenientEnumSerializer<NativeJobStatus>(
    "NativeJobStatus", NativeJobStatus.entries, NativeJobStatus.UNKNOWN, { it.wire },
)

internal object OutputRateStateSerializer : LenientEnumSerializer<OutputRateState>(
    "OutputRateState", OutputRateState.entries, OutputRateState.UNKNOWN, { it.wire },
)

internal object NativeQueueHoldReasonSerializer : LenientEnumSerializer<NativeQueueHoldReason>(
    "NativeQueueHoldReason", NativeQueueHoldReason.entries, NativeQueueHoldReason.UNKNOWN, { it.wire },
)

internal object NativeStatusPhaseSerializer : LenientEnumSerializer<NativeStatusPhase>(
    "NativeStatusPhase", NativeStatusPhase.entries, NativeStatusPhase.UNKNOWN, { it.wire },
)

internal object NativeInteractionKindSerializer : LenientEnumSerializer<NativeInteractionKind>(
    "NativeInteractionKind", NativeInteractionKind.entries, NativeInteractionKind.UNKNOWN, { it.wire },
)

internal open class LenientEnumSerializer<E : Enum<E>>(
    name: String,
    private val values: List<E>,
    private val fallback: E,
    private val wire: (E) -> String,
) : KSerializer<E> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("riffet.contracts.$name", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: E) = encoder.encodeString(wire(value))
    override fun deserialize(decoder: Decoder): E {
        val text = decoder.decodeString()
        return values.firstOrNull { wire(it) == text } ?: fallback
    }
}

/** `stop.via`: `session` stops every background task of the conversation, not just this one. */
@Serializable
data class NativeActivityStop(val via: String = "protocol") {
    val stopsAll: Boolean get() = via == "session"
}

@Serializable
data class NativeActivityCompaction(
    val trigger: String? = null,
    val preTokens: Long? = null,
    val postTokens: Long? = null,
)

@Serializable
data class NativeActivityTask(
    /** `shell`, `monitor`, `agent`, `workflow` or `terminal`; any other spelling is shown as a plain task. */
    val kind: String? = null,
    val command: String? = null,
    val exitCode: Long? = null,
)

@Serializable
data class NativeActivityCommand(val name: String? = null)

@Serializable
data class NativeActivity(
    /** Stable across states and restarts: `${backend}:${nativeId}`. */
    val id: String,
    val kind: NativeActivityKind = NativeActivityKind.UNKNOWN,
    val status: NativeActivityStatus = NativeActivityStatus.UNKNOWN,
    val title: String = "",
    /** A preview of at most 2KB; the full text is `GET /api/sessions/:id/blobs/:blobRef`. */
    val detail: String? = null,
    val blobRef: String? = null,
    val toolCallId: String? = null,
    val startedAt: String? = null,
    val endedAt: String? = null,
    val durationMs: Long? = null,
    /** Absent when it cannot be stopped. */
    val stop: NativeActivityStop? = null,
    val compaction: NativeActivityCompaction? = null,
    val task: NativeActivityTask? = null,
    val command: NativeActivityCommand? = null,
)
