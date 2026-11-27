@file:OptIn(ExperimentalObjCName::class)

package riffet.contracts

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.descriptors.element
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlin.experimental.ExperimentalObjCName
import kotlin.native.ObjCName

/*
 * Sync protocol v3 from packages/contracts/src/sync.ts (docs/SYNC-V3.md). A newer server may add
 * values anywhere, and none of them may fail a frame: an unknown frame `type` is [SyncFrame.Unknown],
 * a row whose `kind` this build does not know or cannot read has a [TimelineRow.Body.Unknown] body,
 * and every enum here falls back to `UNKNOWN`.
 */

/** `main`, or `sub:<toolCallId>` for a subagent's lane. */
typealias SyncLane = String

/** The event a row was folded from: [createdAt] of its first source event, [lastAt] of its latest. */
@Serializable
data class RowEvent(
    val type: String,
    val data: JsonObject,
    val createdAt: String,
    val lastAt: String,
    val runId: String? = null,
    val nativeId: String? = null,
    val nativeTurnId: String? = null,
    val sourceIds: List<String>,
)

/**
 * One folded row of a lane. On the wire [body]'s fields sit next to `kind` in the row itself. The
 * Objective-C name keeps the client's own `riffet.ui.timeline.TimelineRow` as Swift's `TimelineRow`.
 */
@ObjCName("SyncTimelineRow")
@Serializable(with = TimelineRowSerializer::class)
data class TimelineRow(
    val key: String,
    val pos: Long,
    val turn: String,
    val seq: Long,
    val rev: Long,
    val runId: String? = null,
    val event: RowEvent,
    val truncated: Truncated? = null,
    val body: Body,
) {
    /** The full row is `GET /api/sessions/:id/blobs/:blobRef`. */
    @Serializable
    data class Truncated(val blobRef: String, val bytes: Long)

    sealed interface Body {
        @Serializable
        data class User(
            val text: String,
            val attachments: List<UserAttachment>,
            val pending: Pending? = null,
            val references: List<CapturedSessionReference>? = null,
            val agents: List<AgentMention>? = null,
        ) : Body

        @Serializable
        data class Assistant(val text: String, val phase: Phase? = null) : Body

        @Serializable
        data class Thought(val text: String, val channel: ReasoningChannel) : Body

        @Serializable
        data class Tool(val job: NativeJob? = null, val subagent: Subagent? = null, val activity: NativeActivity? = null) : Body

        @Serializable
        data class Plan(val entries: List<JsonObject>) : Body

        @Serializable
        data class Image(val src: String) : Body

        @Serializable
        data class Status(val tone: Tone, val text: String, val detail: String? = null) : Body

        @Serializable
        data class TaskNotification(
            val taskId: String? = null,
            val taskKind: String,
            val status: TaskNotificationStatus,
            val sourceStatus: String? = null,
            val title: String,
            val command: String? = null,
            val detail: String? = null,
            val jobResult: TaskNotificationResult? = null,
            val subagentToolCallId: String? = null,
            val tokens: Long? = null,
            val durationMs: Long? = null,
        ) : Body

        @Serializable
        data class Activity(val activity: NativeActivity) : Body

        /** The whole row as received; the client skips it. */
        data class Unknown(val kind: String?, val raw: JsonObject) : Body
    }

    /** `id` is present for attachments uploaded through Riffet (`/api/attachments/:id`); `path` is the native file a CLI recorded. */
    @Serializable
    data class UserAttachment(
        val name: String,
        val id: String? = null,
        val path: String? = null,
        val type: String? = null,
        val mimeType: String? = null,
        val size: Long? = null,
        val width: Long? = null,
        val height: Long? = null,
    )

    @Serializable
    data class Subagent(
        val lane: SyncLane,
        val agentId: String,
        val running: Boolean,
        val title: String? = null,
        val subagentType: String? = null,
        val model: String? = null,
        val rows: Long,
        val turnId: String? = null,
        val status: TurnOutlineV3.Status? = null,
        val startedAt: String? = null,
        val endedAt: String? = null,
        val changes: List<FileChange>? = null,
    )

    /** A file a conversation or subagent changed, with net (or aggregated) lines gained and lost. */
    @Serializable
    data class FileChange(
        val path: String,
        val added: Long,
        val removed: Long,
        val created: Boolean,
        val status: String? = null,
        val binary: Boolean? = null,
        val outsideProject: Boolean? = null,
        val accuracy: String? = null,
        val hasSnapshotDiff: Boolean? = null,
        val updatedAt: String? = null,
    )

    @Serializable
    data class TaskNotificationResult(val id: String, val status: Status, val exitCode: Long? = null, val runningMs: Long? = null) {
        @Serializable(with = TaskResultStatusSerializer::class)
        enum class Status(val wire: String) { RUNNING("running"), SUCCEEDED("succeeded"), FAILED("failed"), UNKNOWN("") }
    }

    /** A Run the transcript has not echoed yet. */
    @Serializable(with = PendingSerializer::class)
    enum class Pending(val wire: String) { QUEUED("queued"), PREPARING("preparing"), UNCONFIRMED("unconfirmed"), FAILED("failed"), UNKNOWN("") }

    @Serializable(with = PhaseSerializer::class)
    enum class Phase(val wire: String) { COMMENTARY("commentary"), FINAL_ANSWER("final_answer"), UNKNOWN("") }

    /** `narration` is the summary the CLI itself shows; `thinking` is the model's raw reasoning. */
    @Serializable(with = ReasoningChannelSerializer::class)
    enum class ReasoningChannel(val wire: String) { THINKING("thinking"), NARRATION("narration"), UNKNOWN("") }

    @Serializable(with = ToneSerializer::class)
    enum class Tone(val wire: String) { DANGER("danger"), MUTED("muted"), UNKNOWN("") }

    @Serializable(with = TaskNotificationStatusSerializer::class)
    enum class TaskNotificationStatus(val wire: String) {
        RUNNING("running"), COMPLETED("completed"), FAILED("failed"), CANCELLED("cancelled"), UNKNOWN("unknown"),
    }
}

@Serializable
data class TurnOutlineV3(
    val turn: String,
    val turnId: String,
    val startPos: Long,
    val endPos: Long? = null,
    val status: Status,
    val at: String,
    val endedAt: String? = null,
    val preview: String? = null,
    val hasUserMessage: Boolean? = null,
    val hasAttachments: Boolean? = null,
    val rows: Long,
    val runId: String? = null,
) {
    @Serializable(with = TurnStatusSerializer::class)
    enum class Status(val wire: String) {
        RUNNING("running"),
        COMPLETED("completed"),
        FAILED("failed"),
        CANCELLED("cancelled"),
        /** The user stopped the turn, or a cancelled turn folded into the same end state. */
        INTERRUPTED("interrupted"),
        /** The turn ended without a confirmed result. */
        OUTCOME_UNKNOWN("outcome_unknown"),
        UNKNOWN(""),
    }
}

@Serializable(with = SyncModeSerializer::class)
enum class SyncMode(val wire: String) { DELTA("delta"), SNAPSHOT("snapshot"), UNKNOWN("") }

/** hello's `outline`: the latest turns, and how many the lane has. */
@Serializable
data class SyncOutline(val turnCount: Long, val turns: List<TurnOutlineV3>)

/** Server-aggregated net file outputs for the whole conversation, newest first. */
@Serializable
data class SessionOutputsSummary(val items: List<TimelineRow.FileChange>, val total: Long)

/** One SSE event of `GET /api/v3/sessions/:id/sync`, discriminated by `type`. */
@Serializable(with = SyncFrameSerializer::class)
sealed interface SyncFrame {
    @Serializable
    data class Hello(
        val protocol: Long,
        val lane: SyncLane,
        val generation: String,
        val headSeq: Long,
        val mode: SyncMode,
        val session: Session,
        val status: NativeStatus,
        val interaction: NativeInteraction? = null,
        @Serializable(with = LenientRunsSerializer::class)
        val runs: List<Run>,
        val activities: List<NativeActivity>,
        val context: NativeContext? = null,
        val outline: SyncOutline,
        /** Server-aggregated net file outputs for the whole conversation (main lane only). */
        val outputs: SessionOutputsSummary? = null,
        /** The transcript is still being read; a [CaughtUp] follows once it is in the lane. */
        val catchingUp: Boolean = false,
        /** Initial control snapshot. A hello replaces whatever revision the previous stream held. */
        val control: SessionControlSnapshot? = null,
    ) : SyncFrame

    @Serializable
    data class Snapshot(
        val generation: String,
        val asOfSeq: Long,
        val part: Long,
        val final: Boolean,
        val rows: List<TimelineRow>,
        val hasBefore: Boolean,
    ) : SyncFrame

    @Serializable
    data class Rows(
        val generation: String,
        val from: Long,
        val to: Long,
        val upserts: List<TimelineRow>,
        val deletes: List<String>? = null,
    ) : SyncFrame

    @Serializable
    data class Reset(val generation: String, val reason: Reason) : SyncFrame {
        @Serializable(with = ResetReasonSerializer::class)
        enum class Reason(val wire: String) { REBUILT("rebuilt"), PROMOTED("promoted"), FOLD("fold"), UNKNOWN("") }
    }

    @Serializable
    data class Status(val status: NativeStatus) : SyncFrame

    @Serializable
    data class Interaction(val interaction: NativeInteraction? = null) : SyncFrame

    @Serializable
    data class Runs(@Serializable(with = LenientRunsSerializer::class) val runs: List<Run>) : SyncFrame

    @Serializable
    data class RunUpsert(val run: Run) : SyncFrame

    @Serializable
    data class Activities(val live: List<NativeActivity>) : SyncFrame

    /** Only the turns that changed. */
    @Serializable
    data class Outline(val turnCount: Long, val turns: List<TurnOutlineV3>) : SyncFrame

    @Serializable
    data class Context(val context: NativeContext? = null) : SyncFrame

    /** A turn's speed; [nativeMessageId] names a turn typed in the CLI, which has no [runId]. */
    @Serializable
    data class Metrics(val metrics: StepMetrics, val run: RunMetrics? = null, val runId: String? = null, val nativeMessageId: String? = null) : SyncFrame

    @Serializable
    data class SessionUpdate(val session: Session) : SyncFrame

    /** Server-aggregated net file outputs for the whole conversation. */
    @Serializable
    data class Outputs(val outputs: SessionOutputsSummary) : SyncFrame

    /** The session's control snapshot. A client keeps it only when [SessionControlSnapshot.revision] did not go backwards. */
    @Serializable
    @SerialName("control")
    data class Control(val control: SessionControlSnapshot) : SyncFrame

    @Serializable
    data class Error(val code: String, val message: String, val retryable: Boolean) : SyncFrame

    /** What the read the stream started with found is in the lane once it holds [headSeq] of [generation]. */
    @Serializable
    data class CaughtUp(val generation: String, val headSeq: Long) : SyncFrame

    /** A frame this build does not know, including the `ping` heartbeat. */
    data class Unknown(val type: String?, val raw: JsonObject) : SyncFrame
}

/** `GET /api/v3/sessions/:id/timeline`. */
@Serializable
data class TimelinePage(val generation: String, val rows: List<TimelineRow>, val hasBefore: Boolean, val hasAfter: Boolean)

/** A row of the lane holding the query: [count] non-overlapping, case-insensitive occurrences in what the row shows. */
@Serializable
data class LaneFindHit(val key: String, val pos: Long, val turn: String, val count: Long)

/** `GET /api/v3/sessions/:id/find`: [total] sums every count, [hits] stop at the server's cap ([truncated]). */
@Serializable
data class LaneFind(
    val generation: String,
    val headSeq: Long,
    val total: Long,
    val hits: List<LaneFindHit>,
    val truncated: Boolean? = null,
)

/** `GET /api/v3/sessions/:id/timeline/changes`. */
@Serializable
data class TimelineChanges(
    val generation: String,
    val headSeq: Long,
    val mode: SyncMode,
    val from: Long? = null,
    val to: Long? = null,
    val rows: List<TimelineRow>,
    val deletes: List<String>? = null,
    val hasBefore: Boolean? = null,
)

internal object SyncFrameSerializer : KSerializer<SyncFrame> {
    private val VARIANT_SERIALIZERS: Map<String, KSerializer<out SyncFrame>> = linkedMapOf(
        "hello" to SyncFrame.Hello.serializer(),
        "snapshot" to SyncFrame.Snapshot.serializer(),
        "rows" to SyncFrame.Rows.serializer(),
        "reset" to SyncFrame.Reset.serializer(),
        "status" to SyncFrame.Status.serializer(),
        "interaction" to SyncFrame.Interaction.serializer(),
        "runs" to SyncFrame.Runs.serializer(),
        "run" to SyncFrame.RunUpsert.serializer(),
        "activities" to SyncFrame.Activities.serializer(),
        "outline" to SyncFrame.Outline.serializer(),
        "outputs" to SyncFrame.Outputs.serializer(),
        "context" to SyncFrame.Context.serializer(),
        "metrics" to SyncFrame.Metrics.serializer(),
        "session" to SyncFrame.SessionUpdate.serializer(),
        "control" to SyncFrame.Control.serializer(),
        "error" to SyncFrame.Error.serializer(),
        "caughtUp" to SyncFrame.CaughtUp.serializer(),
    )

    private fun wireName(value: SyncFrame): String? = when (value) {
        is SyncFrame.Hello -> "hello"
        is SyncFrame.Snapshot -> "snapshot"
        is SyncFrame.Rows -> "rows"
        is SyncFrame.Reset -> "reset"
        is SyncFrame.Status -> "status"
        is SyncFrame.Interaction -> "interaction"
        is SyncFrame.Runs -> "runs"
        is SyncFrame.RunUpsert -> "run"
        is SyncFrame.Activities -> "activities"
        is SyncFrame.Outline -> "outline"
        is SyncFrame.Outputs -> "outputs"
        is SyncFrame.Context -> "context"
        is SyncFrame.Metrics -> "metrics"
        is SyncFrame.SessionUpdate -> "session"
        is SyncFrame.Control -> "control"
        is SyncFrame.Error -> "error"
        is SyncFrame.CaughtUp -> "caughtUp"
        is SyncFrame.Unknown -> null
    }

    override val descriptor = buildClassSerialDescriptor("riffet.contracts.SyncFrame") { element<String>("type") }

    override fun deserialize(decoder: Decoder): SyncFrame {
        val json = decoder as? JsonDecoder ?: throw SerializationException("SyncFrame must be decoded from JSON")
        return decodeDiscriminatedFrame(json, VARIANT_SERIALIZERS, "sync") { type, element -> SyncFrame.Unknown(type, element) }
    }

    override fun serialize(encoder: Encoder, value: SyncFrame) {
        val json = encoder as? JsonEncoder ?: throw SerializationException("SyncFrame must be encoded to JSON")
        val name = wireName(value) ?: return json.encodeJsonElement((value as SyncFrame.Unknown).raw)
        encodeDiscriminatedFrame(json, VARIANT_SERIALIZERS, name, value, "sync")
    }
}

/** [TimelineRow]'s own fields, decoded apart from the `kind`-specific ones. */
@Serializable
private data class RowHead(
    val key: String,
    val pos: Long,
    val turn: String,
    val seq: Long,
    val rev: Long,
    val runId: String? = null,
    val event: RowEvent,
    val truncated: TimelineRow.Truncated? = null,
)

internal object TimelineRowSerializer : KSerializer<TimelineRow> {
    private val BODY_SERIALIZERS: Map<String, KSerializer<out TimelineRow.Body>> = linkedMapOf(
        "user" to TimelineRow.Body.User.serializer(),
        "assistant" to TimelineRow.Body.Assistant.serializer(),
        "thought" to TimelineRow.Body.Thought.serializer(),
        "tool" to TimelineRow.Body.Tool.serializer(),
        "plan" to TimelineRow.Body.Plan.serializer(),
        "image" to TimelineRow.Body.Image.serializer(),
        "status" to TimelineRow.Body.Status.serializer(),
        "task_notification" to TimelineRow.Body.TaskNotification.serializer(),
        "activity" to TimelineRow.Body.Activity.serializer(),
    )

    private fun kindOf(body: TimelineRow.Body): String? = when (body) {
        is TimelineRow.Body.User -> "user"
        is TimelineRow.Body.Assistant -> "assistant"
        is TimelineRow.Body.Thought -> "thought"
        is TimelineRow.Body.Tool -> "tool"
        is TimelineRow.Body.Plan -> "plan"
        is TimelineRow.Body.Image -> "image"
        is TimelineRow.Body.Status -> "status"
        is TimelineRow.Body.TaskNotification -> "task_notification"
        is TimelineRow.Body.Activity -> "activity"
        is TimelineRow.Body.Unknown -> null
    }

    override val descriptor = buildClassSerialDescriptor("riffet.contracts.TimelineRow") { element<String>("kind") }

    override fun deserialize(decoder: Decoder): TimelineRow {
        val json = decoder as? JsonDecoder ?: throw SerializationException("TimelineRow must be decoded from JSON")
        val element = json.decodeJsonElement() as? JsonObject ?: throw SerializationException("TimelineRow must be a JSON object")
        val head = json.json.decodeFromJsonElement(RowHead.serializer(), element)
        val kind = (element["kind"] as? JsonPrimitive)?.contentOrNull
        val body = kind?.let(BODY_SERIALIZERS::get)?.let { serializer ->
            // A known kind that this build cannot read (a new job status, say) costs the row, not the frame.
            try { json.json.decodeFromJsonElement(serializer, element) } catch (e: SerializationException) { null }
        } ?: TimelineRow.Body.Unknown(kind, element)
        return TimelineRow(head.key, head.pos, head.turn, head.seq, head.rev, head.runId, head.event, head.truncated, body)
    }

    @Suppress("UNCHECKED_CAST")
    override fun serialize(encoder: Encoder, value: TimelineRow) {
        val json = encoder as? JsonEncoder ?: throw SerializationException("TimelineRow must be encoded to JSON")
        val body = value.body
        val kind = kindOf(body)
        val fields = LinkedHashMap<String, JsonElement>()
        if (kind == null) fields.putAll((body as TimelineRow.Body.Unknown).raw) else fields["kind"] = JsonPrimitive(kind)
        val head = RowHead(value.key, value.pos, value.turn, value.seq, value.rev, value.runId, value.event, value.truncated)
        fields.putAll(json.json.encodeToJsonElement(RowHead.serializer(), head) as JsonObject)
        if (kind != null) {
            val serializer = BODY_SERIALIZERS.getValue(kind) as KSerializer<TimelineRow.Body>
            fields.putAll(json.json.encodeToJsonElement(serializer, body) as JsonObject)
        }
        json.encodeJsonElement(JsonObject(fields))
    }
}

/**
 * A run list that skips the runs this build cannot read (a new [RunState] or delivery state, which
 * the apps switch over exhaustively and so cannot fall back to `UNKNOWN`), instead of failing the frame.
 */
internal object LenientRunsSerializer : KSerializer<List<Run>> {
    private val list = ListSerializer(Run.serializer())
    override val descriptor = list.descriptor

    override fun deserialize(decoder: Decoder): List<Run> {
        val json = decoder as? JsonDecoder ?: return list.deserialize(decoder)
        val array = json.decodeJsonElement() as? JsonArray ?: throw SerializationException("runs must be a JSON array")
        return array.mapNotNull { element ->
            // SerializationException is an IllegalArgumentException, as is a failed enum lookup.
            try { json.json.decodeFromJsonElement(Run.serializer(), element) } catch (e: IllegalArgumentException) { null }
        }
    }

    override fun serialize(encoder: Encoder, value: List<Run>) = list.serialize(encoder, value)
}

internal object PendingSerializer : LenientEnumSerializer<TimelineRow.Pending>(
    "TimelineRow.Pending", TimelineRow.Pending.entries, TimelineRow.Pending.UNKNOWN, { it.wire },
)

internal object PhaseSerializer : LenientEnumSerializer<TimelineRow.Phase>(
    "TimelineRow.Phase", TimelineRow.Phase.entries, TimelineRow.Phase.UNKNOWN, { it.wire },
)

internal object ReasoningChannelSerializer : LenientEnumSerializer<TimelineRow.ReasoningChannel>(
    "TimelineRow.ReasoningChannel", TimelineRow.ReasoningChannel.entries, TimelineRow.ReasoningChannel.UNKNOWN, { it.wire },
)

internal object ToneSerializer : LenientEnumSerializer<TimelineRow.Tone>(
    "TimelineRow.Tone", TimelineRow.Tone.entries, TimelineRow.Tone.UNKNOWN, { it.wire },
)

internal object TaskNotificationStatusSerializer : LenientEnumSerializer<TimelineRow.TaskNotificationStatus>(
    "TimelineRow.TaskNotificationStatus", TimelineRow.TaskNotificationStatus.entries, TimelineRow.TaskNotificationStatus.UNKNOWN, { it.wire },
)

internal object TaskResultStatusSerializer : LenientEnumSerializer<TimelineRow.TaskNotificationResult.Status>(
    "TimelineRow.TaskNotificationResult.Status", TimelineRow.TaskNotificationResult.Status.entries, TimelineRow.TaskNotificationResult.Status.UNKNOWN, { it.wire },
)

internal object TurnStatusSerializer : LenientEnumSerializer<TurnOutlineV3.Status>(
    "TurnOutlineV3.Status", TurnOutlineV3.Status.entries, TurnOutlineV3.Status.UNKNOWN, { it.wire },
)

internal object SyncModeSerializer : LenientEnumSerializer<SyncMode>(
    "SyncMode", SyncMode.entries, SyncMode.UNKNOWN, { it.wire },
)

internal object ResetReasonSerializer : LenientEnumSerializer<SyncFrame.Reset.Reason>(
    "SyncFrame.Reset.Reason", SyncFrame.Reset.Reason.entries, SyncFrame.Reset.Reason.UNKNOWN, { it.wire },
)
