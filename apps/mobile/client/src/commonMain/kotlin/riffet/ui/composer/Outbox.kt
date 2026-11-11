package riffet.ui.composer

import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import riffet.contracts.RiffetJson
import riffet.shared.NativeStopRequest
import riffet.shared.NativeMessageInput
import riffet.shared.NativeSteerInput
import riffet.contracts.NativeTurnTarget
import riffet.i18n.L10n

/**
 * The client-side send outbox, ported from `apps/web/src/lib/api.ts` and
 * `apps/web/src/app/session/useNativeSession.ts`.
 *
 * ## The guarantee this exists for
 *
 * `POST /api/sessions/:id/native/send` is idempotent on `commandId` (see `readNativeInput` and
 * `store.findRunByCommand` in `apps/server/src/app.ts`: a repeat returns the already accepted Run
 * instead of creating a second one). The web client therefore:
 *
 *  1. persists the complete request **before** the POST;
 *  2. removes it only once the server answered;
 *  3. when the HTTP result is unknown (offline, timeout, 5xx) *keeps* it and shows the run as
 *     `uncertain`, so a retry reuses the exact same `commandId` — and therefore the server's
 *     receipt — instead of being submitted as a new command;
 *  4. drops the entry as soon as a server run list shows that `commandId`, because a receipt the
 *     server already has must never be sent again.
 *
 * Point 4 is why [reconcile] is called on every `runs` frame: a lost HTTP response whose Run was
 * nevertheless accepted is reconciled by observation, not by guessing.
 *
 * ## Persistence
 *
 * The interface below is the native persistence seam:
 * [createOutboxStore] is `expect`/`actual` (see the platform files), so Android persists to a
 * `SharedPreferences` file, iOS/macOS use atomic files, and JVM tests keep it in memory. Nothing in the send logic
 * knows which one it got.
 */

/**
 * One persisted send request. Serialisable because a durable [OutboxStore] has to write it down;
 * the bytes of an attachment are never here — only the ids of already-uploaded [AttachmentRef]s.
 */
@Serializable
data class OutboxEntry(
    val sessionId: String,
    val body: NativeMessageInput,
    /** ISO-8601 UTC, so it sorts against the server's own `Run.createdAt` stamps. */
    val createdAt: String,
    /** True when this entry was accepted by `interrupt-and-send` rather than plain `send`. */
    val interrupt: Boolean = false,
    val steerTarget: NativeTurnTarget? = null,
    val sourceRunId: String? = null,
    val version: Int = 1,
    /** Definitive local rejection retained until its content is restored; never replayed. */
    val failure: String? = null,
) {
    /** Replay selects only the original payload; it never reads current session configuration. */
    fun steerInput(): NativeSteerInput {
        require(failure == null) { failure ?: L10n.uiText("composer.error.steerRejected") }
        require(sourceRunId == null || sourceRunId.isNotBlank()) { L10n.uiText("composer.error.steerRecordInvalid") }
        require(version == 2 && !interrupt && body.expectedConfigRevision == null) { L10n.uiText("composer.error.steerRecordInvalid") }
        val target = requireNotNull(steerTarget) { L10n.uiText("composer.error.originalRequestMissing") }
        require(target.nativeSessionId.isNotBlank() && target.turnId.isNotBlank()) { L10n.uiText("composer.error.steerRecordInvalid") }
        return NativeSteerInput(body.commandId, body.text, target, body.attachments, body.context, body.references)
    }

}

/**
 * Where outbox entries live between the POST and its answer.
 *
 * Implementations must be safe for main-thread use; the send path calls them synchronously before
 * it suspends, so an entry can never be lost to a race with the network.
 */
interface OutboxStore {
    fun list(sessionId: String): List<OutboxEntry>
    fun save(entry: OutboxEntry)
    fun remove(sessionId: String, commandId: String)
}

/** The fallback on hosts without a durable store; also what the focused outbox test uses. */
class InMemoryOutboxStore : OutboxStore {
    private val entries = mutableMapOf<String, MutableMap<String, OutboxEntry>>()

    override fun list(sessionId: String): List<OutboxEntry> =
        entries[sessionId]?.values?.toList() ?: emptyList()

    override fun save(entry: OutboxEntry) {
        entries.getOrPut(entry.sessionId) { mutableMapOf() }[entry.body.commandId] = entry
    }

    override fun remove(sessionId: String, commandId: String) {
        entries[sessionId]?.remove(commandId)
    }
}

/** JSON codec for a durable [OutboxStore]; the shared config keeps older entries readable. */
object OutboxJson {
    fun encode(entry: OutboxEntry): String = RiffetJson.instance.encodeToString(entry)

    /** A corrupt entry is dropped rather than allowed to block the composer. */
    fun decode(raw: String): OutboxEntry? =
        runCatching { RiffetJson.instance.decodeFromString<OutboxEntry>(raw) }.getOrNull()
}

/** Creates this host's outbox store. See the package comment for why this is a platform seam. */
expect fun createOutboxStore(serverUrl: String? = null): OutboxStore

/**
 * The send outbox as the store uses it. It owns no state of its own: every operation goes straight
 * through to [store], so "persisted before the POST" is true of the actual bytes on disk.
 */
class NativeSendOutbox(private val store: OutboxStore) {

    /** Oldest first, so a retry order matches the order the user pressed send. */
    fun entries(sessionId: String): List<OutboxEntry> =
        store.list(sessionId).filterNot(::isStopOperation).groupBy { it.body.commandId }.values.map { matches ->
            val unique = matches.distinct()
            // Never choose one endpoint arbitrarily when old/new locations disagree on identity.
            if (unique.size == 1) unique.single() else unique.first().copy(version = -1, failure = L10n.uiText("composer.error.outboxConflict"))
        }.sortedBy { it.createdAt }

    private fun isStopOperation(entry: OutboxEntry): Boolean =
        entry.version in 3..4 && entry.body.text.isEmpty() && entry.body.stop?.requestId == entry.body.commandId

    /** Stop operations share the durable store but never project as user messages. */
    fun pendingStop(sessionId: String): NativeStopRequest? =
        store.list(sessionId).filter { isStopOperation(it) && it.version == 3 }.maxByOrNull { it.createdAt }?.body?.stop

    fun persistStop(sessionId: String, stop: NativeStopRequest) {
        store.save(OutboxEntry(sessionId, NativeMessageInput(stop.requestId, "", stop = stop), isoUtcNow(), version = 3))
    }

    fun removeStop(sessionId: String, stop: NativeStopRequest) = store.remove(sessionId, stop.requestId)

    fun queuedStop(sessionId: String, runId: String): NativeStopRequest? =
        store.list(sessionId).firstOrNull { isStopOperation(it) && it.version == 4 && it.sourceRunId == runId }?.body?.stop

    fun persistQueuedStop(sessionId: String, runId: String, stop: NativeStopRequest) {
        store.save(OutboxEntry(sessionId, NativeMessageInput(stop.requestId, "", stop = stop), isoUtcNow(), sourceRunId = runId, version = 4))
    }


    /** The original request for a `commandId`, or null when it has already been receipted. */
    fun find(sessionId: String, commandId: String): OutboxEntry? =
        entries(sessionId).firstOrNull { it.body.commandId == commandId }

    /** Called before the POST. */
    fun persist(entry: OutboxEntry) = store.save(entry)

    /** Called on a definitive answer, acceptance or rejection. Never called on an unknown result. */
    fun remove(sessionId: String, commandId: String) = store.remove(sessionId, commandId)

    /**
     * Drops every entry whose `commandId` the server already knows and returns the ones still
     * awaiting a receipt. This is the "must never be silently re-sent" half of the guarantee:
     * once the server's run list contains the command, the retry affordance disappears.
     */
    fun reconcile(sessionId: String, knownCommandIds: Set<String>): List<OutboxEntry> {
        val remaining = entries(sessionId).filter { entry ->
            if (entry.version != -1 && entry.body.commandId in knownCommandIds) {
                store.remove(sessionId, entry.body.commandId)
                false
            } else {
                true
            }
        }
        return remaining
    }
}
