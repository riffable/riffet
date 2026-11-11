package riffet.ui.state

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import riffet.cache.SyncWindow
import riffet.contracts.SyncFrame
import riffet.shared.syncStream
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import riffet.contracts.Attachment
import riffet.contracts.NativeDeliveryState
import riffet.contracts.NativeRunConfig
import riffet.contracts.NativeRunContextReference
import riffet.contracts.NativeRunDetails
import riffet.contracts.NativeRunInput
import riffet.contracts.NativeTurnTarget
import riffet.contracts.Run
import riffet.contracts.RunState
import riffet.contracts.Session
import riffet.contracts.TerminalState
import riffet.i18n.L10n
import riffet.shared.AttachmentRef
import riffet.shared.NativeQueuedSteerInput
import riffet.shared.NativeMessageInput
import riffet.shared.PromptContextReference
import riffet.shared.fileReferences
import riffet.shared.sessionReferences
import riffet.shared.UploadAttachmentRequest
import riffet.shared.RiffetApi
import riffet.shared.RiffetHttpException
import riffet.ui.composer.NativeSendOutbox
import riffet.ui.composer.OutboxEntry
import riffet.ui.composer.UploadableAttachment
import riffet.ui.composer.isoUtcNow
import riffet.ui.composer.newClientId
import riffet.ui.timeline.platformNowMillis
import riffet.shared.attachmentMetadata
import riffet.shared.cancelNativeRun
import riffet.shared.interruptSession
import riffet.shared.nativeInterruptAndSend
import riffet.shared.nativeSend
import riffet.shared.nativeSteer
import riffet.shared.resolveNativeRun
import riffet.shared.checkNativeRun
import riffet.shared.runByCommand
import riffet.shared.NativeRunRecovery
import riffet.shared.NativeStopRequest
import riffet.shared.runs
import riffet.shared.sendQueuedNativeRunNow
import riffet.shared.sessions
import riffet.shared.sessionCatalog
import riffet.shared.steerQueuedNativeRun
import riffet.shared.terminal
import riffet.shared.uploadAttachment

/** Only a definite pre-delivery rejection may become a new sendable draft. */
fun canRestoreUnsentSteer(run: Run): Boolean {
    val native = run.native ?: return false
    return run.state == RunState.FAILED && native.intent == "steer" && native.delivery == NativeDeliveryState.FAILED &&
        native.stage in listOf("steer_rejected", OUTBOX_FAILURE) && native.nativeMessageId == null &&
        native.timings?.get("observedAt") == null && native.timings?.get("providerAcceptedAt") == null
}

fun canRestoreUnsentMessage(run: Run): Boolean = canRestoreUnsentSteer(run) ||
    (run.state == RunState.FAILED && run.native?.delivery == NativeDeliveryState.FAILED &&
        run.native?.stage == OUTBOX_FAILURE && run.native?.nativeMessageId == null)

/**
 * The write half of [SessionStore]: uploading, sending, queueing, retrying and cancelling, all
 * through the [outbox] (see the store's "Sending, queueing and answering").
 *
 * The delivery table, the selected session, the in-flight command ids and the send state all live in
 * the store's [core] state, which the stream's `runs` frames also write. Each action captures the
 * epoch it started in and applies its results only while that conversation is still open; an answer
 * that arrives after a switch is dropped by the reducer (the outbox still keeps what is unknown).
 * [list] is the store's. A send refused because a dialog blocks the CLI asks [interactions] for it,
 * so the card can replace the terminal.
 *
 * A command id is in-flight from the moment its outbox entry is persisted until its POST answers: a
 * `runs` frame that does not list it yet is not evidence of a lost send, so it stays pending, not
 * uncertain.
 */
internal class SessionComposer(
    private val api: RiffetApi,
    private val scope: CoroutineScope,
    private val outbox: NativeSendOutbox,
    private val core: StateStore,
    private val list: StateFlow<SessionListState>,
    private val interactions: SessionInteractions,
    private val defaultSteerTarget: suspend () -> NativeTurnTarget? = { null },
) {

    private fun openSessionId(): String? = core.value.sessionId

    @OptIn(ExperimentalEncodingApi::class)
    suspend fun uploadAttachment(picked: UploadableAttachment): Attachment {
        val session = core.value.selected ?: error(L10n.uiText("composer.error.noOpenSessionUpload"))
        return uploadAttachment(picked, session.projectId)
    }

    @OptIn(ExperimentalEncodingApi::class)
    suspend fun uploadAttachment(picked: UploadableAttachment, projectId: String?): Attachment {
        val mimeType = picked.mimeType.substringBefore(';').trim().ifBlank { "application/octet-stream" }
        return api.uploadAttachment(
            projectId,
            UploadAttachmentRequest(
                name = picked.name,
                mimeType = mimeType,
                dataBase64 = Base64.encode(picked.bytes),
                width = picked.width?.toLong(),
                height = picked.height?.toLong(),
            ),
        )
    }

    suspend fun replyFor(sessionId: String, text: String) {
        val prompt = text.trim()
        if (prompt.isEmpty()) return
        if (sessionId == openSessionId() && core.value.selected?.id == sessionId) {
            if (!send(prompt, emptyList(), emptyList(), interrupt = false)) error(core.value.send.error ?: core.value.send.notice ?: L10n.uiText("composer.error.sendIncomplete"))
            return
        }
        val session = list.value.sessions.firstOrNull { it.id == sessionId }
            ?: api.sessions().firstOrNull { it.id == sessionId }
            ?: error(L10n.uiText("composer.error.sessionMissing"))
        val body = NativeMessageInput(
            commandId = newClientId(),
            text = prompt,
            expectedConfigRevision = session.configRevision ?: 0,
        )
        outbox.persist(OutboxEntry(sessionId = sessionId, body = body, createdAt = isoUtcNow(), interrupt = false))
        core.setInFlight(body.commandId, true)
        try {
            api.nativeSend(sessionId, body)
            outbox.remove(sessionId, body.commandId)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            if (!isUncertain(error)) outbox.remove(sessionId, body.commandId)
            throw error
        } finally {
            core.setInFlight(body.commandId, false)
        }
    }

    suspend fun send(
        text: String,
        attachments: List<Attachment>,
        context: List<PromptContextReference>,
        interrupt: Boolean,
        onStored: (() -> Unit)? = null,
    ): Boolean {
        val sessionId = core.value.selected?.id ?: return false
        return submit(text, attachments, context, interrupt, null, expectedSessionId = sessionId, selectDefaultTarget = !interrupt, onStored = onStored)
    }

    suspend fun enqueue(text: String, attachments: List<Attachment>, context: List<PromptContextReference>, onStored: (() -> Unit)? = null): Boolean =
        submit(text, attachments, context, false, null, expectedSessionId = core.value.selected?.id, onStored = onStored)

    suspend fun steer(text: String, attachments: List<Attachment>, context: List<PromptContextReference>, target: NativeTurnTarget): Boolean =
        submit(text, attachments, context, false, target)

    suspend fun steerQueued(run: Run, target: NativeTurnTarget): Boolean {
        val current = core.value.runs.firstOrNull { it.id == run.id } ?: return false
        if (!inQueue(current)) return false
        if (outbox.entries(current.sessionId).any { it.sourceRunId == current.id && it.failure == null }) return false
        return submit(current.native?.input?.text ?: current.prompt, emptyList(), emptyList(), false, target, current)
    }

    private suspend fun submit(
        text: String,
        attachments: List<Attachment>,
        context: List<PromptContextReference>,
        interrupt: Boolean,
        requestedTarget: NativeTurnTarget?,
        sourceRun: Run? = null,
        expectedSessionId: String? = null,
        selectDefaultTarget: Boolean = false,
        onStored: (() -> Unit)? = null,
    ): Boolean = scope.async {
        val opened = core.value
        val session = opened.selected ?: return@async false
        val epoch = opened.epoch
        if (opened.sessionId != session.id || (expectedSessionId != null && expectedSessionId != session.id)) return@async false
        val prompt = text.trim()
        if (prompt.isEmpty()) return@async false
        if (opened.send.sending || opened.send.interrupting) return@async false
        if (hasUnknownSubmission()) {
            core.updateSend(epoch) { it.copy(notice = L10n.uiText("composer.error.unknownResult")) }
            return@async false
        }

        // One transition claims the composer: a second submit sees `sending` and is refused.
        val claimed = core.tryUpdate { state ->
            if (state.epoch != epoch || state.send.sending || state.send.interrupting) null
            else state.copy(send = state.send.copy(sending = !interrupt, interrupting = interrupt, error = null, notice = null))
        }
        if (!claimed) return@async false
        try {
            val target = if (selectDefaultTarget) defaultSteerTarget() else requestedTarget
            if (interrupt) requireTargetedStop(session.id)
            if (core.value.epoch != epoch) return@async false
            val body = NativeMessageInput(
                commandId = newClientId(),
                text = prompt,
                attachments = sourceRun?.native?.input?.attachmentIds?.map { AttachmentRef(it) } ?: attachments.takeIf { it.isNotEmpty() }?.map { AttachmentRef(it.id) },
                context = sourceRun?.native?.input?.context?.map { PromptContextReference(it.path, it.line) } ?: context.fileReferences(),
                references = sourceRun?.native?.input?.references ?: context.sessionReferences(),
                expectedConfigRevision = if (target == null) session.configRevision ?: 0 else null,
                stop = if (interrupt) stopTarget(opened) ?: error(L10n.uiText("composer.error.stopTargetMissing")) else null,
            )
            if (core.value.epoch != epoch) return@async false
            val entry = OutboxEntry(sessionId = session.id, body = body, createdAt = isoUtcNow(), interrupt = interrupt, steerTarget = target, sourceRunId = sourceRun?.id, version = if (target != null) 2 else 1)
            // Persist before the POST. This is the whole point of the outbox.
            outbox.persist(entry)
            core.setInFlight(body.commandId, true)
            syncSteerSources(epoch, session.id)

            core.reduce(epoch) { it.upsertRun(optimisticRun(session, entry, uncertain = false)) }
            val started = platformNowMillis()
            log("send command=${shortId(body.commandId)} interrupt=$interrupt chars=${prompt.length}")
            try {
                onStored?.invoke()
                val accepted = deliver(session.id, entry)
                outbox.remove(session.id, body.commandId)
                val held = core.value.runs.firstOrNull { it.id == accepted.id }
                log("send accepted in ${platformNowMillis() - started}ms ${describeRun(accepted)} (held ${held?.let(::describeRun) ?: "none"})")
                core.reduce(epoch) { it.settleQueuedSource(entry.sourceRunId).upsertRun(accepted) }
                if (target != null && accepted.state == RunState.FAILED) {
                    val rejected = canRestoreUnsentSteer(accepted)
                    if (onStored == null) core.updateSend(epoch) { it.copy(error = accepted.error ?: if (rejected) L10n.uiText("composer.error.steerNotSentKept") else L10n.uiText("composer.error.steerDeliveredTurnFailed")) }
                    !rejected
                } else true
            } catch (cancellation: CancellationException) {
                // The caller went away but the request may already have been accepted. Keep the entry so
                // the unknown result is reconciled later rather than re-sent as a new command.
                log("send cancelled after ${platformNowMillis() - started}ms")
                throw cancellation
            } catch (error: Throwable) {
                log("send failed after ${platformNowMillis() - started}ms ${error::class.simpleName}: ${error.message}")
                val uncertain = isUncertain(error)
                val settled = if (uncertain) reconcileAcceptedEntry(epoch, entry, sourceTransferred = onStored != null) else null
                if (settled != null) {
                    settled
                } else if (uncertain) {
                    core.reduce(epoch) { it.upsertRun(optimisticRun(session, entry, uncertain = true)) }
                    // The durable Outbox now owns this content, including an unknown HTTP result.
                    true
                } else {
                    if (target != null || onStored != null) {
                        val rejected = entry.copy(failure = errorText(error, L10n.uiText("composer.error.sendIncomplete")))
                        outbox.persist(rejected)
                        core.reduce(epoch) { it.upsertRun(optimisticRun(session, rejected, uncertain = false)) }
                    } else outbox.remove(session.id, body.commandId)
                    if (core.value.epoch == epoch) {
                        if (target == null && onStored == null) core.reduce(epoch) { it.removeCommand(body.commandId) }
                        // A dialog is blocking the CLI; surface it so the card can replace the terminal.
                        if ((error as? RiffetHttpException)?.code == "CLI_INTERACTION_REQUIRED") {
                            runCatching { interactions.syncInteraction() }
                        }
                        if (onStored == null) core.updateSend(epoch) { it.copy(error = errorText(error, L10n.uiText("composer.error.sendToTerminal"))) }
                    }
                    false
                }
            } finally {
                // Answered, refused or unknown: from here a `runs` frame decides what it was.
                core.setInFlight(body.commandId, false)
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            core.updateSend(epoch) { it.copy(error = errorText(error, L10n.uiText("composer.error.sendIncomplete"))) }
            false
        } finally {
            core.updateSend(epoch) { it.copy(sending = false, interrupting = false) }
            syncSteerSources(epoch, session.id)
        }
    }.await()

    suspend fun sendQueuedNow(run: Run): Boolean = scope.async {
        val opened = core.value
        val session = opened.selected ?: return@async false
        val epoch = opened.epoch
        if (opened.sessionId != session.id) return@async false
        val current = opened.runs.firstOrNull { it.id == run.id } ?: return@async false
        if (!inQueue(current) || run.id in opened.steerSources) return@async false
        if (core.value.send.sending || core.value.send.interrupting) return@async false
        if (hasUnknownSubmission()) return@async false
        markRunPending(epoch, run.id, true)
        core.updateSend(epoch) { it.copy(interrupting = true, error = null, notice = null) }
        var stop: NativeStopRequest? = null
        try {
            stop = outbox.queuedStop(session.id, run.id) ?: stopTarget(opened)
            requireNotNull(stop) { L10n.uiText("composer.error.stopTargetMissing") }
            requireTargetedStop(session.id)
            if (core.value.epoch != epoch) return@async false
            outbox.persistQueuedStop(session.id, run.id, stop)
            val updated = api.sendQueuedNativeRunNow(session.id, run.id, stop)
            outbox.removeStop(session.id, stop)
            core.reduce(epoch) { it.upsertRun(updated) }
            true
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            if (isUncertain(error)) {
                // The accepted run is the source of truth; re-read it instead of guessing.
                refreshRunsNow(session.id)
                core.updateSend(epoch) { it.copy(error = L10n.uiText("composer.error.sendNowUnconfirmed")) }
            } else {
                if (stop != null) outbox.removeStop(session.id, stop)
                core.updateSend(epoch) { it.copy(error = errorText(error, L10n.uiText("composer.error.sendNowFailed"))) }
            }
            false
        } finally {
            markRunPending(epoch, run.id, false)
            core.updateSend(epoch) { it.copy(interrupting = false) }
        }
    }.await()

    suspend fun interruptFor(sessionId: String): Boolean {
        if (core.value.sessionId == sessionId) return interrupt()
        val hello = withTimeout(10_000) {
            api.syncStream(sessionId, "main", SyncWindow.MAC.copy(snapshotRows = 1), null).flow().first { it is SyncFrame.Hello } as SyncFrame.Hello
        }
        val isolated = StateStore()
        isolated.update { it.copy(sessionId = sessionId, selected = hello.session, status = hello.status) }
        return SessionComposer(api, scope, outbox, isolated, list, SessionInteractions(api, isolated)).interrupt()
    }

    suspend fun interrupt(): Boolean = scope.async {
        val opened = core.value
        val session = opened.selected ?: return@async false
        val epoch = opened.epoch
        if (opened.sessionId != session.id) return@async false
        val claimed = core.tryUpdate { state ->
            if (state.epoch != epoch || state.send.sending || state.send.interrupting) null
            else state.copy(send = state.send.copy(interrupting = true, error = null, notice = null))
        }
        if (!claimed) return@async false
        log("interrupt ${shortId(session.id)}")
        val previous = outbox.pendingStop(session.id)
        var stop: NativeStopRequest? = null
        try {
            // An unconfirmed request must keep its identity even if terminal control moved. The
            // server uses its receipt to decide whether that exact stop completed or can recover.
            stop = previous ?: stopTarget(opened) ?: error(L10n.uiText("composer.error.stopTargetMissing"))
            if (core.value.epoch != epoch) return@async false
            outbox.persistStop(session.id, stop)
            requireTargetedStop(session.id)
            if (core.value.epoch != epoch) return@async false
            api.interruptSession(session.id, stop)
            outbox.removeStop(session.id, stop)
            true
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            log("interrupt failed ${error::class.simpleName}: ${error.message}")
            if (!isUncertain(error) && stop != null) outbox.removeStop(session.id, stop)
            if (core.value.epoch == epoch) core.updateSend(epoch) { it.copy(error = errorText(error, L10n.uiText("composer.error.stop"))) }
            false
        } finally {
            core.updateSend(epoch) { it.copy(interrupting = false) }
        }
    }.await()

    suspend fun cancelRun(run: Run): Boolean = scope.async {
        val opened = core.value
        val session = opened.selected ?: return@async false
        val epoch = opened.epoch
        // A send the server has not answered has no run there to cancel yet.
        if (run.id in opened.steerSources || sendPhase(run) == SendPhase.SUBMITTING) return@async false
        markRunPending(epoch, run.id, true)
        log("cancel ${describeRun(run)}")
        try {
            val updated = api.cancelNativeRun(session.id, run.id)
            log("cancel answered ${describeRun(updated)}")
            outbox.remove(session.id, run.commandId)
            core.reduce(epoch) { it.upsertRun(updated) }
            updated.state == RunState.CANCELLED
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            core.updateSend(epoch) { it.copy(error = errorText(error, L10n.uiText("composer.error.cancel"))) }
            false
        } finally {
            markRunPending(epoch, run.id, false)
        }
    }.await()

    suspend fun takeBackQueued(run: Run): QueuedDraft? {
        val epoch = core.value.epoch
        if (sendPhase(run) == SendPhase.SUBMITTING) return null
        // Provider failure/cancellation is not a rejected send. Refuse before reading attachments
        // or touching a converted queue entry, even when a stale renderer still offers recovery.
        if (run.native?.intent == "steer" && !canRestoreUnsentSteer(run)) return null
        // Resolve every attachment before cancelling. A partial draft would permanently lose the
        // queued message's files, while a failed read leaves the accepted queue entry intact.
        val attachments = run.native?.input?.attachmentIds.orEmpty().map { id -> api.attachmentMetadata(id) }
        val context = run.native?.input?.context.orEmpty().map { PromptContextReference(it.path, it.line) } +
            run.native?.input?.references.orEmpty().map { reference ->
                val captured = run.native?.contextSnapshots.orEmpty().firstOrNull { it.sessionId == reference.sessionId }
                PromptContextReference(kind = "session", sessionId = reference.sessionId,
                    fromRunId = if (captured != null) run.id else reference.fromRunId, title = captured?.title)
            }
        if (run.native?.intent != "steer" && canRestoreUnsentMessage(run)) {
            if (openSessionId() != run.sessionId) return null
            val entry = outbox.find(run.sessionId, run.commandId) ?: return null
            if (entry.failure == null || entry.version != 1) return null
            outbox.remove(run.sessionId, run.commandId)
            core.reduce(epoch) { it.removeCommand(run.commandId) }
            return QueuedDraft(run.native?.input?.text ?: run.prompt, attachments, context)
        }
        if (run.native?.intent == "steer" && run.state == RunState.FAILED) {
            val entry = outbox.find(run.sessionId, run.commandId)
            if (entry != null && entry.failure == null && runCatching { entry.steerInput() }.isSuccess) {
                core.updateSend(epoch) { it.copy(error = L10n.uiText("composer.error.steerUnconfirmedRestore")) }
                return null
            }
            val sourceRunId = run.native?.sourceRunId ?: entry?.sourceRunId
            if (sourceRunId != null) {
                val snapshot = try { api.runs(run.sessionId) } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (error: Throwable) {
                    core.updateSend(epoch) { it.copy(error = errorText(error, L10n.uiText("composer.error.queuedCheckFailed"))) }
                    return null
                }
                if (openSessionId() != run.sessionId || core.value.selected?.id != run.sessionId) return null
                val accepted = snapshot.firstOrNull { it.commandId == run.commandId }
                if (accepted != null && !canRestoreUnsentSteer(accepted)) {
                    core.updateSend(epoch) { it.copy(error = L10n.uiText("composer.error.steerStillProcessing")) }
                    return null
                }
                val source = snapshot.firstOrNull { it.id == sourceRunId }
                if (source != null && source.native?.delivery != NativeDeliveryState.CANCELLED && source.state != RunState.CANCELLED) {
                    if (source.state != RunState.QUEUED || source.native?.delivery != NativeDeliveryState.QUEUED || source.native?.intent != null || !cancelRun(source)) {
                        core.updateSend(epoch) { it.copy(error = L10n.uiText("composer.error.queuedTakeBackFailed")) }
                        return null
                    }
                } else if (source == null) {
                    // The runs endpoint omits older finished rows. Only cancellation or an
                    // explicit RUN_NOT_FOUND receipt proves the source cannot execute later.
                    if (sourceRunId in core.value.steerSources) return null
                    try {
                        val updated = api.cancelNativeRun(run.sessionId, sourceRunId)
                        core.update { if (it.sessionId == run.sessionId) it.upsertRun(updated) else it }
                        if (updated.state != RunState.CANCELLED) {
                            core.updateSend(epoch) { it.copy(error = L10n.uiText("composer.error.queuedMaybeRan")) }
                            return null
                        }
                    } catch (cancellation: CancellationException) {
                        throw cancellation
                    } catch (error: Throwable) {
                        if (error !is RiffetHttpException || error.status != 404 || error.code != "RUN_NOT_FOUND") {
                            core.updateSend(epoch) { it.copy(error = errorText(error, L10n.uiText("composer.error.queuedCheckFailed"))) }
                            return null
                        }
                    }
                }
            }
            if (openSessionId() != run.sessionId || core.value.selected?.id != run.sessionId) return null
            if (run.native?.stage == OUTBOX_FAILURE && outbox.find(run.sessionId, run.commandId)?.version != -1) outbox.remove(run.sessionId, run.commandId)
            return QueuedDraft(run.native?.input?.text ?: run.prompt, attachments, context)
        }
        if (!cancelRun(run)) return null
        return QueuedDraft(run.native?.input?.text ?: run.prompt, attachments, context)
    }

    suspend fun retryRun(run: Run): Boolean = scope.async {
        val opened = core.value
        val session = opened.selected ?: return@async false
        val epoch = opened.epoch
        if (!messageRecovery(run).canRetry || run.id in opened.send.pendingRunIds) return@async false
        val entry = outbox.find(session.id, run.commandId)
        if (entry == null) {
            core.updateSend(epoch) { it.copy(error = L10n.uiText("composer.error.originalRequestMissing")) }
            return@async false
        }
        markRunPending(epoch, run.id, true)
        core.updateSend(epoch) { it.copy(error = null, notice = null) }
        try {
            val accepted = deliver(session.id, entry)
            outbox.remove(session.id, entry.body.commandId)
            core.reduce(epoch) { it.settleQueuedSource(entry.sourceRunId).upsertRun(accepted) }
            if (entry.steerTarget != null && accepted.state == RunState.FAILED) {
                val rejected = canRestoreUnsentSteer(accepted)
                core.updateSend(epoch) { it.copy(error = accepted.error ?: if (rejected) L10n.uiText("composer.error.steerNotSentRestore") else L10n.uiText("composer.error.steerDeliveredTurnFailed")) }
                !rejected
            } else true
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            if (isUncertain(error)) reconcileAcceptedEntry(epoch, entry)?.let { return@async it }
            if (!isUncertain(error)) {
                val rejected = entry.copy(failure = errorText(error, L10n.uiText("composer.error.originalRejected")))
                outbox.persist(rejected)
                core.reduce(epoch) { it.upsertRun(optimisticRun(session, rejected, uncertain = false)) }
            } else core.reduce(epoch) { it.upsertRun(optimisticRun(session, entry, uncertain = true)) }
            false
        } finally {
            markRunPending(epoch, run.id, false)
            syncSteerSources(epoch, session.id)
        }
    }.await()

    /** A stream receipt can settle a POST before its HTTP response is lost. Never replace it with
     *  a new unknown placeholder or leave its already-sent contents in a sendable draft. */
    private fun reconcileAcceptedEntry(epoch: Int, entry: OutboxEntry, sourceTransferred: Boolean = false): Boolean? {
        val state = core.value
        if (state.epoch != epoch || state.sessionId != entry.sessionId) return null
        val accepted = state.runs.firstOrNull { it.sessionId == entry.sessionId && it.commandId == entry.body.commandId && it.native?.fingerprint != "client-pending" } ?: return null
        outbox.remove(entry.sessionId, entry.body.commandId)
        core.reduce(epoch) { it.settleQueuedSource(entry.sourceRunId) }
        val rejected = canRestoreUnsentSteer(accepted)
        val failure = if (accepted.state == RunState.FAILED) accepted.error ?: if (rejected) L10n.uiText("composer.error.steerNotSentKept") else L10n.uiText("composer.error.turnFailed") else null
        core.updateSend(epoch) { it.copy(notice = null, error = failure.takeUnless { sourceTransferred }) }
        return !rejected
    }

    /** Reads the exact submission before asking the backend to recover its existing evidence. */
    suspend fun checkRun(run: Run): NativeRunRecovery? = scope.async {
        val opened = core.value
        val session = opened.selected ?: return@async null
        val epoch = opened.epoch
        if (run.sessionId != session.id || run.id in opened.send.pendingRunIds) return@async null
        markRunPending(epoch, run.id, true)
        core.updateSend(epoch) { it.copy(error = null, notice = null) }
        try {
            if (api.sessionCatalog(session.id).capabilities.supportsRecovery != true) return@async null
            val known = if (messageRecovery(run).canRetry) api.runByCommand(session.id, run.commandId) else run
            // An absent exact result does not prove that an in-flight POST was never accepted.
            if (known == null) return@async null
            upsertEntries(known)
            core.reduce(epoch) { it.upsertRun(known) }
            val checked = api.checkNativeRun(session.id, known.id)
            core.reduce(epoch) { it.upsertRun(checked.run) }
            checked.takeIf { core.value.epoch == epoch }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            core.updateSend(epoch) { it.copy(error = errorText(error, L10n.uiText("composer.error.checkStatus"))) }
            null
        } finally {
            markRunPending(epoch, run.id, false)
        }
    }.await()

    /** Only an explicit confirmation of a checked queue can release later messages. */
    suspend fun continueRun(run: Run, queuedRunIds: List<String>): Boolean = scope.async {
        val opened = core.value
        val session = opened.selected ?: return@async false
        val epoch = opened.epoch
        if (run.sessionId != session.id || run.id in opened.send.pendingRunIds) return@async false
        markRunPending(epoch, run.id, true)
        core.updateSend(epoch) { it.copy(error = null, notice = null) }
        try {
            if (api.sessionCatalog(session.id).capabilities.supportsRecovery != true) return@async false
            val updated = api.resolveNativeRun(session.id, run.id, queuedRunIds)
            core.reduce(epoch) { it.upsertRun(updated) }
            true
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Throwable) {
            core.updateSend(epoch) { it.copy(error = errorText(error, L10n.uiText("composer.error.checkStatus"))) }
            false
        } finally {
            markRunPending(epoch, run.id, false)
        }
    }.await()

    private suspend fun stopTarget(state: StoreState): NativeStopRequest? {
        val session = state.selected ?: return null
        val turn = state.status?.activeTurn?.target()
        val nativeSessionId = turn?.nativeSessionId ?: session.nativeSessionId ?: session.cursorSessionId ?: return null
        val terminal = session.terminalId?.let { api.terminal(it) }
        // A Run's terminal epoch records its send, not today's control lease. Claim/release changes
        // that epoch without changing the provider turn, so use the terminal's current identity.
        if (terminal != null && (terminal.sessionId != session.id || terminal.projectId != session.projectId ||
                terminal.state != TerminalState.RUNNING)) return null
        return NativeStopRequest(newClientId(), nativeSessionId, turnId = turn?.turnId,
            terminalId = terminal?.id, terminalEpoch = terminal?.epoch)
    }

    suspend fun refreshRuns() {
        val sessionId = openSessionId() ?: return
        refreshRunsNow(sessionId)
    }

    fun clearComposerMessages() {
        core.updateSend(core.value.epoch) { it.copy(error = null, notice = null) }
    }

    private fun markRunPending(epoch: Int, runId: String, pending: Boolean) {
        core.updateSend(epoch) { state ->
            state.copy(pendingRunIds = if (pending) state.pendingRunIds + runId else state.pendingRunIds - runId)
        }
    }

    private fun hasUnknownSubmission(): Boolean =
        core.value.runs.any { run ->
            run.native?.delivery == NativeDeliveryState.UNCERTAIN && run.native?.stage == HTTP_UNKNOWN
        }

    private suspend fun refreshRunsNow(sessionId: String) {
        val epoch = core.value.epoch
        val snapshot = runCatching { api.runs(sessionId) }.getOrNull() ?: return
        log("runs re-read n=${snapshot.size} ${snapshot.takeLast(2).joinToString(" ") { describeRun(it) }}")
        if (core.value.epoch != epoch || core.value.sessionId != sessionId) return
        val entries = pendingEntries(snapshot)
        core.reduce(epoch) { it.withServerRuns(snapshot, entries) }
    }

    /**
     * The outbox entries the server has not receipted, for a `runs` snapshot of the open session.
     * `reconcile` drops entries the server already receipted, so a lost acceptance can never be
     * offered as a retry again; the rest are folded into the delivery table by
     * [StoreState.withServerRuns], where an in-flight POST keeps its pending row (the frame may
     * simply predate the server accepting it).
     */
    fun pendingEntries(snapshot: List<Run>): List<OutboxEntry> {
        val state = core.value
        val sessionId = state.sessionId
        if (sessionId == null || state.selected == null) return emptyList()
        val entries = outbox.reconcile(sessionId, snapshot.mapTo(HashSet()) { it.commandId })
        syncSteerSources(state.epoch, sessionId)
        return entries
    }

    /** The open session's runs as they would stand after folding [snapshot] and the outbox together. */
    fun withLocalOutbox(snapshot: List<Run>): List<Run> =
        core.value.withServerRuns(snapshot, pendingEntries(snapshot)).runs

    /** A single run added or updated (the stream's `run` frame); it receipts the matching outbox entry. */
    fun upsertEntries(run: Run) {
        val state = core.value
        val sessionId = state.sessionId ?: return
        if (run.sessionId == sessionId) outbox.reconcile(sessionId, setOf(run.commandId))
    }

    private suspend fun deliver(sessionId: String, entry: OutboxEntry): Run = when {
        entry.version !in 1..2 -> error(L10n.uiText("composer.error.sendRecordUnsupported"))
        entry.version == 2 || entry.steerTarget != null || entry.sourceRunId != null -> {
            val input = entry.steerInput()
            entry.sourceRunId?.let { api.steerQueuedNativeRun(sessionId, it, NativeQueuedSteerInput(input.commandId, input.target)) }
                ?: api.nativeSteer(sessionId, input)
        }
        entry.interrupt -> {
            requireNotNull(entry.body.stop) { L10n.uiText("composer.error.stopTargetMissing") }
            requireTargetedStop(sessionId)
            api.nativeInterruptAndSend(sessionId, entry.body)
        }
        else -> api.nativeSend(sessionId, entry.body)
    }

    private fun syncSteerSources(epoch: Int, sessionId: String) {
        val pending = outbox.entries(sessionId).filter { it.failure == null }.mapNotNull { it.sourceRunId }.toSet()
        core.reduce(epoch) { state ->
            state.copy(send = state.send.copy(pendingRunIds = (state.send.pendingRunIds - state.steerSources) + pending), steerSources = pending)
        }
    }

    /** A stop that lacks completion evidence remains unknown even when its HTTP status is 409. */
    private fun isUncertain(error: Throwable): Boolean =
        error !is RiffetHttpException || error.status == 0 || error.status >= 500 || error.code == "NATIVE_STOP_UNCONFIRMED"

    private suspend fun requireTargetedStop(sessionId: String) {
        check(api.sessionCatalog(sessionId).capabilities.supportsTargetedStop == true) {
            L10n.uiText("composer.error.targetedStopUnavailable")
        }
    }

    private fun errorText(error: Throwable, fallback: String): String =
        error.message?.takeIf { it.isNotBlank() } ?: fallback
}

/** The optimistic stage values `useNativeSession.ts` writes; they are not a wire enum. */
internal const val HTTP_PENDING = "http_pending"
internal const val HTTP_UNKNOWN = "http_unknown"

internal const val OUTBOX_FAILURE = "outbox_failure"

/** The web's `optimisticRun`: a placeholder the transcript can render before the server answers. */
internal fun optimisticRun(session: Session, entry: OutboxEntry, uncertain: Boolean): Run {
    val body = entry.body
    val failure = entry.failure ?: if ((entry.version != 1 || entry.steerTarget != null || entry.sourceRunId != null) && runCatching { entry.steerInput() }.isFailure) L10n.uiText("composer.error.steerRecordInvalid") else null
    return Run(
        id = body.commandId,
        sessionId = session.id,
        commandId = body.commandId,
        prompt = body.text,
        state = if (failure != null) RunState.FAILED else if (uncertain) RunState.INTERRUPTED else RunState.QUEUED,
        error = failure,
        native = NativeRunDetails(
            intent = if (entry.version != 1 || entry.steerTarget != null || entry.sourceRunId != null) "steer" else null,
            sourceRunId = entry.sourceRunId,
            nativeSessionId = entry.steerTarget?.nativeSessionId,
            nativeTurnId = entry.steerTarget?.turnId,
            input = NativeRunInput(
                text = body.text,
                attachmentIds = body.attachments?.map { it.id } ?: emptyList(),
                context = body.context?.map { NativeRunContextReference(it.path, it.line) } ?: emptyList(),
                references = body.references,
            ),
            config = NativeRunConfig(model = session.model, mode = session.mode, approval = session.approval),
            fingerprint = "client-pending",
            delivery = if (failure != null) NativeDeliveryState.FAILED else if (uncertain) NativeDeliveryState.UNCERTAIN else NativeDeliveryState.QUEUED,
            attempt = 0,
            stage = if (failure != null) OUTBOX_FAILURE else if (uncertain) HTTP_UNKNOWN else HTTP_PENDING,
            configRevision = body.expectedConfigRevision ?: session.configRevision ?: 0,
        ),
        createdAt = entry.createdAt,
        updatedAt = entry.createdAt,
    )
}
