package riffet.shared

import io.ktor.websocket.Frame
import io.ktor.websocket.readBytes
import io.ktor.websocket.readText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withTimeout
import kotlin.io.encoding.Base64
import riffet.ui.composer.UploadableAttachment
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.yield
import kotlin.concurrent.Volatile
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import riffet.contracts.TERMINAL_ACK_CHARS
import riffet.contracts.TerminalAppearance
import riffet.contracts.TerminalClientMessage
import riffet.contracts.TerminalInfo
import riffet.contracts.TerminalServerMessage
import riffet.contracts.TerminalState
import riffet.contracts.RiffetJson
import riffet.i18n.L10n

private const val TAG = "term"

/** A paste remains bound to the connection, lease and input position at the user action. */
class TerminalPasteLease internal constructor(val epoch: Long, internal val generation: Int, internal val inputRevision: Int, internal val pasteRevision: Int)

/** What the terminal socket is doing. */
sealed interface TerminalLink {
    data object Connecting : TerminalLink
    data object Live : TerminalLink
    data class Reconnecting(val attempt: Int) : TerminalLink
    /** The process ended; nothing will reconnect. */
    data class Exited(val exitCode: Long?) : TerminalLink
    /** The server rejected this device's token; redialling cannot help until it is paired again. */
    data object Unauthenticated : TerminalLink
}

/**
 * `WS /api/terminals/:id/ws` for one terminal page, the phone's counterpart of the web's
 * `TerminalView` socket handling.
 *
 * - Every connection starts with the server's full screen snapshot, so a reconnect needs no
 *   bookkeeping: explicit snapshot frames set the grid before [onOutput] receives `fresh`.
 *   Deltas at or before the snapshot sequence and from another stream are discarded.
 * - The phone asks for control with `claim` **without** `takeover` (docs/MOBILE-TERMINAL.md,
 *   decision 2): it gets control when nobody holds it, and stays a viewer while the Mac does.
 *   [takeOver] is the explicit takeover.
 * - `resize` is only sent while this client holds the lease; the server rejects anything else.
 * - [sendInput] is the user's: without control it claims with takeover and sends what was typed
 *   once the lease arrives (the web's `pendingInputRef`). [sendReply] is the engine's answer to a
 *   query: it goes out only while this client already holds control and never claims, so a cursor
 *   position report can never take a terminal away from the Mac.
 * - Reconnection is the same endless backoff as the native stream ([RetryPolicy]); an `exit`
 *   frame, a rejected token or [close] stops it. The WebSocket handshake hides its HTTP status, so a
 *   failed dial asks the REST endpoint whether the token still works.
 * - Threads: every public method may be called from any thread. They only enqueue a command; the
 *   socket loop runs on [scope]'s dispatcher, owns all of the connection's mutable state, and calls
 *   [onOutput] there. A caller that wants output decoded and parsed off the main thread passes a
 *   scope on a single-threaded background dispatcher; one that hands the output to a main-thread
 *   view passes a main scope. The loop yields after every received frame, so a flood of output
 *   cannot starve whatever else shares that dispatcher.
 */
/** The colours this process last asked each conversation's pane for. */
private val requestedAppearances = MutableStateFlow<Map<String, TerminalAppearance>>(emptyMap())

class TerminalConnection(
    private val api: RiffetApi,
    private val terminalId: String,
    private val clientId: String,
    private val scope: CoroutineScope,
    private val onOutput: (data: String, fresh: Boolean) -> Unit,
    private val retry: RetryPolicy = RetryPolicy(),
    private val onSnapshotGrid: ((Int, Int) -> Unit)? = null,
) {
    private val _link = MutableStateFlow<TerminalLink>(TerminalLink.Connecting)
    val link: StateFlow<TerminalLink> = _link.asStateFlow()

    private val _info = MutableStateFlow<TerminalInfo?>(null)
    val info: StateFlow<TerminalInfo?> = _info.asStateFlow()

    /** The last `error` frame the server sent, for the page to show. */
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    val hasControl: Boolean get() = _info.value?.ownerId == clientId

    private val commands = Channel<Command>(Channel.UNLIMITED)
    private var job: Job? = null
    /** The size this client last asked for, re-sent when it gains control. */
    @Volatile private var wantedSize: Pair<Int, Int>? = null

    // Owned by the socket loop.
    private var sentSize: Pair<Int, Int>? = null
    private val pending = ArrayList<Command>()
    private var claiming = false
    @Volatile private var generation = 0
    @Volatile private var inputRevision = 0
    @Volatile private var pasteRevision = 0
    @Volatile var snapshotColumns: Int = 100
        private set
    @Volatile var snapshotRows: Int = 40
        private set

    fun start() {
        if (job != null) return
        job = scope.launch { run() }
    }

    fun close() {
        generation += 1
        job?.cancel()
        job = null
    }

    /** Takes control from whoever holds it (the web's 接管). */
    fun takeOver() {
        inputRevision += 1
        commands.trySend(Command.TakeOver)
    }

    /** Gives control back (the web's 释放控制权). */
    fun release() {
        inputRevision += 1
        commands.trySend(Command.Release)
    }

    /** Keys and text from the user. Claims control first when this client does not hold it. */
    fun sendInput(data: String) {
        inputRevision += 1
        if (data.isEmpty() || _link.value is TerminalLink.Exited || _link.value == TerminalLink.Unauthenticated) return
        commands.trySend(Command.Input(data))
    }

    /** Pasted text; the server applies bracketed paste. Claims control first like [sendInput]. */
    fun paste(text: String) {
        inputRevision += 1
        if (text.isEmpty() || _link.value is TerminalLink.Exited || _link.value == TerminalLink.Unauthenticated) return
        commands.trySend(Command.Paste(text))
    }

    /** The engine's reply to the program's query; dropped unless this client holds control. */
    fun sendReply(data: String) {
        commands.trySend(Command.Reply(data))
    }

    /** The grid this page can show; applied to the pane only while this client holds control. */
    fun requestSize(cols: Int, rows: Int) {
        wantedSize = cols to rows
        commands.trySend(Command.Size)
    }

    /** Recheck after the app changes theme, without waiting for another terminal state frame. */
    fun followAppearance() {
        commands.trySend(Command.Appearance)
    }

    /** Acquire once at the user action, before asynchronous clipboard/file preparation. */
    @Throws(Exception::class)
    suspend fun acquirePasteLease(): TerminalPasteLease {
        pasteRevision += 1
        val operation = pasteRevision
        val input = inputRevision
        check(_link.value == TerminalLink.Live) { L10n.uiText("terminal.paste.disconnected") }
        val started = generation
        if (!hasControl) {
            commands.trySend(Command.TakeOver)
            withTimeout(5_000) { info.first { it?.ownerId == clientId } }
        }
        val lease = checkNotNull(_info.value)
        check(started == generation && lease.ownerId == clientId) { L10n.uiText("terminal.paste.controlChanged") }
        check(input == inputRevision && operation == pasteRevision) { L10n.uiText("terminal.paste.inputChanged") }
        return TerminalPasteLease(lease.epoch, started, input, operation)
    }

    /** Upload once, then insert server-side paths without Enter under the original lease. */
    @Throws(Exception::class)
    suspend fun pasteAttachments(files: List<UploadableAttachment>, requestId: String, expectedLease: TerminalPasteLease, text: String? = null): TerminalPasteReceipt {
        require(files.isNotEmpty() && files.size <= 20) { L10n.uiText("terminal.paste.invalidCount") }
        require(files.all { it.bytes.size <= 24 * 1024 * 1024 }) { L10n.uiText("terminal.paste.tooLarge") }
        val started = expectedLease.generation
        val lease = checkNotNull(_info.value)
        check(started == generation && expectedLease.inputRevision == inputRevision && expectedLease.pasteRevision == pasteRevision && _link.value == TerminalLink.Live && lease.ownerId == clientId && lease.epoch == expectedLease.epoch) { L10n.uiText("terminal.paste.controlChanged") }
        val attachments = files.map { file ->
            api.uploadAttachment(lease.projectId, UploadAttachmentRequest(
                name = file.name, mimeType = file.mimeType, dataBase64 = Base64.encode(file.bytes),
                width = file.width?.toLong(), height = file.height?.toLong(),
            ))
        }
        val current = _info.value
        check(started == generation && expectedLease.inputRevision == inputRevision && expectedLease.pasteRevision == pasteRevision && _link.value == TerminalLink.Live && current?.ownerId == clientId && current.epoch == lease.epoch) { L10n.uiText("terminal.paste.controlChanged") }
        return api.pasteTerminalAttachments(terminalId, clientId, lease.epoch, requestId, attachments.map { it.id }, text)
    }

    /** What [command] puts on the wire now, if anything. Socket loop only. */
    private fun messageFor(command: Command): TerminalClientMessage? {
        val info = _info.value
        val mine = info != null && info.ownerId == clientId
        return when (command) {
            Command.TakeOver -> TerminalClientMessage.Claim(clientId = clientId, takeover = true)
            Command.Release -> if (mine) TerminalClientMessage.Release(clientId = clientId, epoch = info.epoch) else null
            Command.Size -> sizeIfOwner()
            Command.Appearance -> { info?.let(::followAppearance); null }
            is Command.Reply -> if (mine) TerminalClientMessage.Input(clientId = clientId, epoch = info.epoch, data = command.data) else null
            is Command.Input, is Command.Paste -> when {
                mine -> userMessage(command, info.epoch)
                else -> {
                    // Sent once the lease arrives (the web's `pendingInputRef`).
                    pending += command
                    if (claiming) null else {
                        claiming = true
                        TerminalClientMessage.Claim(clientId = clientId, takeover = true)
                    }
                }
            }
        }
    }

    private fun userMessage(command: Command, epoch: Long): TerminalClientMessage? = when (command) {
        is Command.Input -> TerminalClientMessage.Input(clientId = clientId, epoch = epoch, data = command.data)
        is Command.Paste -> TerminalClientMessage.Paste(clientId = clientId, epoch = epoch, data = command.data)
        else -> null
    }

    /** What waited for the lease, in the order the user produced it. */
    private fun pendingFor(info: TerminalInfo): List<TerminalClientMessage> {
        claiming = false
        val queued = pending.mapNotNull { userMessage(it, info.epoch) }
        pending.clear()
        return queued
    }

    private fun sizeIfOwner(): TerminalClientMessage? {
        val info = _info.value ?: return null
        val size = wantedSize ?: return null
        if (info.ownerId != clientId || size == sentSize) return null
        sentSize = size
        if (info.cols.toInt() == size.first && info.rows.toInt() == size.second) return null
        return TerminalClientMessage.Resize(clientId = clientId, epoch = info.epoch, cols = size.first.toLong(), rows = size.second.toLong())
    }

    private suspend fun run() {
        var attempt = 0
        while (true) {
            _link.value = if (attempt == 0) TerminalLink.Connecting else TerminalLink.Reconnecting(attempt)
            var exited = false
            try {
                AppLog.log(TAG, "dial attempt=$attempt terminal=$terminalId")
                api.terminalSocket(terminalId) {
                    _notice.value = null
                    // Flips to true once the server sends a protocol 4 binary frame; older servers stay on JSON.
                    var binaryProtocol = false
                    suspend fun emit(message: TerminalClientMessage?) {
                        if (message == null) return
                        if (binaryProtocol && message is TerminalClientMessage.Input) {
                            send(Frame.Binary(true, encodeInputBinaryFrame(message.clientId, message.epoch, message.data)))
                        } else {
                            send(Frame.Text(encode(message)))
                        }
                    }
                    // Drop anything queued for the previous connection: its epoch is stale.
                    while (commands.tryReceive().isSuccess) { }
                    sentSize = null
                    claiming = false
                    pending.clear()
                    emit(TerminalClientMessage.Claim(clientId = clientId))
                    generation += 1
                    var fresh = true
                    var streamId: String? = null
                    var sequence = -1L
                    var unacked = 0
                    // Output is acknowledged once handed to the emulator (docs/TERMINAL.md 4.4), so the
                    // server can reseed a viewer that falls too far behind instead of dropping it.
                    suspend fun delivered(data: String, isFresh: Boolean) {
                        onOutput(data, isFresh)
                        unacked += data.length
                        if (unacked >= TERMINAL_ACK_CHARS) {
                            emit(TerminalClientMessage.Ack(chars = unacked.toLong()))
                            unacked = 0
                        }
                    }
                    suspend fun applySnapshot(nextStreamId: String, nextSeq: Long, cols: Int, rows: Int, data: String) {
                        if (streamId == nextStreamId && nextSeq < sequence) return
                        streamId = nextStreamId
                        sequence = nextSeq
                        snapshotColumns = cols
                        snapshotRows = rows
                        attempt = 0
                        _link.value = TerminalLink.Live
                        onSnapshotGrid?.invoke(snapshotColumns, snapshotRows)
                        delivered(data, true)
                        fresh = false
                    }
                    suspend fun applyOutput(nextStreamId: String?, nextSeq: Long, data: String) {
                        if (nextStreamId != null && nextStreamId != streamId) return
                        if (nextSeq <= sequence) return
                        sequence = nextSeq
                        if (fresh) {
                            _info.value?.let { snapshotColumns = it.cols.toInt(); snapshotRows = it.rows.toInt() }
                            onSnapshotGrid?.invoke(snapshotColumns, snapshotRows)
                            attempt = 0
                            _link.value = TerminalLink.Live
                        }
                        delivered(data, fresh)
                        fresh = false
                    }
                    while (true) {
                        val next: Event = select<Event?> {
                            incoming.onReceiveCatching { result -> result.getOrNull()?.let { Incoming(it) } }
                            commands.onReceive { Outgoing(it) }
                        } ?: break
                        when (next) {
                            is Outgoing -> {
                                // A fresh user operation replaces the previous failure. Automatic
                                // terminal replies/output must not immediately hide a new error.
                                if (next.command is Command.TakeOver || next.command is Command.Release || next.command is Command.Input || next.command is Command.Paste) _notice.value = null
                                emit(messageFor(next.command))
                            }
                            is Incoming -> {
                                when (val frame = next.frame) {
                                    is Frame.Binary -> {
                                        binaryProtocol = true
                                        when (val decoded = decodeServerBinaryFrame(frame.readBytes())) {
                                            is TerminalBinaryServerFrame.Ping -> send(Frame.Binary(true, encodePongBinaryFrame(decoded.timestamp)))
                                            is TerminalBinaryServerFrame.Pong -> Unit
                                            is TerminalBinaryServerFrame.Snapshot -> applySnapshot(decoded.streamId, decoded.sequence, decoded.cols, decoded.rows, decoded.data)
                                            is TerminalBinaryServerFrame.Output -> applyOutput(decoded.streamId, decoded.sequence, decoded.data)
                                            null -> Unit
                                        }
                                    }
                                    is Frame.Text -> {
                                        val message = decode(frame.readText()) ?: continue
                                        when (message) {
                                            is TerminalServerMessage.Snapshot -> applySnapshot(message.streamId, message.sequence, message.cols.toInt(), message.rows.toInt(), message.data)
                                            is TerminalServerMessage.Output -> applyOutput(message.streamId, message.sequence, message.data)
                                            is TerminalServerMessage.State -> {
                                                val previousOwner = _info.value?.ownerId
                                                _info.value = message.terminal
                                                followAppearance(message.terminal)
                                                if (previousOwner != message.terminal.ownerId) {
                                                    AppLog.log(TAG, "lease owner=${message.terminal.ownerId ?: "-"} mine=${message.terminal.ownerId == clientId} epoch=${message.terminal.epoch}")
                                                    sentSize = null
                                                }
                                                if (message.terminal.ownerId == clientId) pendingFor(message.terminal).forEach { emit(it) }
                                                if (message.terminal.state == TerminalState.EXITED) {
                                                    exited = true
                                                    _link.value = TerminalLink.Exited(message.terminal.exitCode)
                                                }
                                                emit(sizeIfOwner())
                                            }
                                            is TerminalServerMessage.Error -> {
                                                AppLog.log(TAG, "error ${message.code}: ${message.message}")
                                                // A refused claim drops what was waiting for it, as the web does.
                                                if (claiming) {
                                                    claiming = false
                                                    pending.clear()
                                                }
                                                // A viewer's claim is refused while the Mac holds control; that is
                                                // the expected state, not something to show as a failure.
                                                if (message.code != "TERMINAL_CONTROLLED") _notice.value = message.message
                                            }
                                            is TerminalServerMessage.Exit -> {
                                                exited = true
                                                _link.value = TerminalLink.Exited(message.exitCode)
                                                onOutput("\r\n\u001b[90m[${L10n.uiText("terminal.exited", message.exitCode ?: "?")}]\u001b[0m\r\n", false)
                                            }
                                        }
                                    }
                                    else -> continue
                                }
                                // Frames already buffered would otherwise run back to back without
                                // suspending; let the dispatcher's other work (input, a frame publish) in.
                                yield()
                            }
                        }
                        if (exited) break
                    }
                    AppLog.log(TAG, "closed")
                }
            } catch (cancellation: CancellationException) {
                AppLog.log(TAG, "cancelled")
                throw cancellation
            } catch (error: Throwable) {
                AppLog.log(TAG, "failed ${error::class.simpleName}: ${error.message}")
            }
            if (exited) return
            if (tokenRejected()) {
                _link.value = TerminalLink.Unauthenticated
                return
            }
            val backoff = retry.delayFor(attempt)
            AppLog.log(TAG, "retry in $backoff")
            delay(backoff)
            attempt += 1
        }
    }

    /**
     * The pane follows this device's theme. The server recolours it in place or, for a CLI that read
     * its colours once at startup, relaunches it when idle.
     */
    private fun followAppearance(info: TerminalInfo) {
        val wanted = api.terminalAppearance ?: return
        if (info.state == TerminalState.EXITED) return
        // Remembered per conversation: a relaunch brings a new terminal id, and another device's
        // later choice must not start a ping-pong.
        val target = "${api.baseUrl}:${info.sessionId ?: info.id}"
        val previous = requestedAppearances.getAndUpdate { it + (target to wanted) }[target]
        if (previous == wanted || info.appearance == wanted) return
        scope.launch {
            var applied = false
            try {
                api.setTerminalAppearance(info.id, wanted)
                applied = true
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (error: Throwable) {
                AppLog.log(TAG, "appearance request failed: ${error.message}")
            } finally {
                if (!applied) requestedAppearances.update { current -> if (current[target] == wanted) current - target else current }
            }
        }
    }

    private suspend fun tokenRejected(): Boolean = try {
        api.terminal(terminalId)
        false
    } catch (cancellation: CancellationException) {
        throw cancellation
    } catch (error: Throwable) {
        error is RiffetUnauthenticatedException
    }

    private sealed interface Event
    private class Incoming(val frame: Frame) : Event
    private class Outgoing(val command: Command) : Event

    private sealed interface Command {
        class Input(val data: String) : Command
        class Paste(val data: String) : Command
        class Reply(val data: String) : Command
        data object TakeOver : Command
        data object Release : Command
        data object Size : Command
        data object Appearance : Command
    }

    private fun encode(message: TerminalClientMessage): String =
        RiffetJson.instance.encodeToString(TerminalClientMessage.serializer(), message)

    private fun decode(text: String): TerminalServerMessage? = try {
        RiffetJson.instance.decodeFromString(TerminalServerMessage.serializer(), text)
    } catch (_: SerializationException) {
        AppLog.log(TAG, unreadable(text))
        null
    } catch (_: IllegalArgumentException) {
        AppLog.log(TAG, unreadable(text))
        null
    }

    /** Terminal output is whatever the shell printed, secrets included; the log gets its shape only. */
    private fun unreadable(text: String): String {
        val type = runCatching {
            ((RiffetJson.instance.parseToJsonElement(text) as? JsonObject)?.get("type") as? JsonPrimitive)?.contentOrNull
        }.getOrNull()
        return "unreadable frame type=${type?.take(32) ?: "-"} length=${text.length}"
    }
}
