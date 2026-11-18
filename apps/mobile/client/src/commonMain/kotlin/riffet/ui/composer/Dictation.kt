package riffet.ui.composer

import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import riffet.contracts.DICTATION_BUDGET_MAX_DURATION_MS
import riffet.contracts.DictationSegment
import riffet.contracts.RiffetJson
import riffet.i18n.L10n
import riffet.shared.AppLog
import riffet.shared.RiffetApi
import riffet.shared.dictationSocket

// Voice input in the composer (docs/VOICE.md §7), shared by the Android and iPhone composers: the platform records, this
// streams the audio to the server and writes what comes back into the draft.

enum class DictationPhase { Idle, Recording, Finishing, Failed }

/** Why the microphone could not record. */
enum class MicrophoneProblem { Denied, NoMicrophone, Failed }

data class DictationState(
    val phase: DictationPhase = DictationPhase.Idle,
    val elapsedMs: Long = 0,
    /** Loudness of the recent frames, oldest first, each 0–1; at most [DICTATION_LEVELS]. */
    val levels: List<Float> = emptyList(),
    /** The sentence still being recognized; settled sentences are already in the draft. */
    val live: String = "",
    /** What this dictation has written into the draft so far: its settled sentences. */
    val written: String = "",
    /** Why the dictation stopped, worded for the person dictating; set in [DictationPhase.Failed]. */
    val failure: String? = null,
    /** Whether [DictationController.retry] can send the same recording again. */
    val canRetry: Boolean = false,
) {
    val active: Boolean get() = phase != DictationPhase.Idle
}

/** The draft a dictation writes into. Called on the main thread. */
interface DictationTarget {
    /** Replaces the whole draft and puts the caret at [caret]. */
    fun replaceDraft(text: String, caret: Int)
}

/**
 * The platform's microphone. [start] asks for permission when it has to, then hands [sink] 100 ms frames of 16 kHz mono
 * PCM16LE (3 200 bytes) until [stop]; the sink may be called from any thread.
 */
interface DictationMicrophone {
    fun start(sink: DictationSink)
    fun stop()
}

interface DictationSink {
    /** One frame and its loudness, 0–1. */
    fun frame(pcm: ByteArray, level: Float)
    fun failed(problem: MicrophoneProblem)
    /** Recording stopped from outside (the app left the screen, a call took the microphone): what was said is finished. */
    fun interrupted()
}

/**
 * Hold to talk on touch screens (docs/design/system/surfaces.md「语音输入（触屏）」): recording starts on press; a release
 * within [TAP_MS] is a tap and keeps recording hands-free; past [CANCEL_DISTANCE_DP] upward the release cancels; from
 * [WARN_AT_MS] the clock warns before the duration cap.
 */
object DictationGesture {
    const val TAP_MS = 300L
    const val CANCEL_DISTANCE_DP = 80
    const val WARN_AT_MS = DICTATION_BUDGET_MAX_DURATION_MS - 10_000L
}

/** Whether this device's composer is in voice mode: hold to talk in place of the keyboard. Kept on the device only. */
object ComposerVoiceMode {
    fun isOn(preferences: riffet.shared.AppPreferences): Boolean = preferences.string(riffet.shared.PreferenceKeys.COMPOSER_INPUT_MODE) == "voice"
    fun set(preferences: riffet.shared.AppPreferences, on: Boolean) =
        preferences.setString(riffet.shared.PreferenceKeys.COMPOSER_INPUT_MODE, if (on) "voice" else null)
}

/** Bars the recording bar may draw. */
const val DICTATION_LEVELS = 28
private const val FRAME_MS = 100L
private const val MAX_FRAMES = (DICTATION_BUDGET_MAX_DURATION_MS / FRAME_MS).toInt()
private const val TAG = "Dictation"

/**
 * One composer's dictations. The draft around the caret is kept as it was when recording started; settled sentences are
 * written between the two halves as they arrive and the final text replaces them. The recording is kept until the
 * dictation ends, so a failed one can be sent again. [scope] must run on the main thread.
 */
class DictationController(
    private val api: RiffetApi,
    private val scope: CoroutineScope,
    private val microphone: DictationMicrophone,
) {
    private val _state = MutableStateFlow(DictationState())
    val state: StateFlow<DictationState> = _state.asStateFlow()

    private var target: DictationTarget? = null
    private var before = ""
    private var after = ""
    private val frames = ArrayList<ByteArray>()
    private var attempt: Attempt? = null
    /** Bumped by every start, so a microphone left over from an earlier dictation is ignored. */
    private var recording = 0

    private val phase: DictationPhase get() = _state.value.phase

    /** Starts recording into [draft], replacing the selection [selectionStart]…[selectionEnd] as typing would. */
    fun start(draft: String, selectionStart: Int, selectionEnd: Int, target: DictationTarget) {
        if (phase != DictationPhase.Idle) return
        val from = selectionStart.coerceIn(0, draft.length)
        val to = selectionEnd.coerceIn(from, draft.length)
        this.target = target
        before = draft.substring(0, from)
        after = draft.substring(to)
        frames.clear()
        _state.value = DictationState(phase = DictationPhase.Recording)
        if (from != to) write("")
        connect()
        val session = ++recording
        microphone.start(object : DictationSink {
            override fun frame(pcm: ByteArray, level: Float) {
                scope.launch { if (session == recording) onFrame(pcm, level) }
            }
            override fun failed(problem: MicrophoneProblem) {
                scope.launch { if (session == recording) onMicrophoneFailed(problem) }
            }
            override fun interrupted() {
                scope.launch { if (session == recording) finish() }
            }
        })
    }

    /** Stops recording and waits for the rest of the text. */
    fun finish() {
        if (phase != DictationPhase.Recording) return
        stopMicrophone()
        _state.update { it.copy(phase = DictationPhase.Finishing) }
        attempt?.send(Outgoing.Finish)
    }

    /** Back to the draft as it was before this dictation. */
    fun cancel() {
        if (phase == DictationPhase.Idle) return
        write("")
        release()
        _state.value = DictationState()
    }

    /** The same recording, sent again as a whole. */
    fun retry() {
        if (phase != DictationPhase.Failed || frames.isEmpty()) return
        _state.update { it.copy(phase = DictationPhase.Finishing, failure = null, canRetry = false, live = "") }
        val again = connect()
        for (frame in frames) again.send(Outgoing.Audio(frame))
        again.send(Outgoing.Finish)
    }

    /** The composer is going away: drop whatever is under way and leave the draft as it stands. */
    fun close() {
        release()
        _state.value = DictationState()
    }

    private fun onFrame(pcm: ByteArray, level: Float) {
        if (phase != DictationPhase.Recording) return
        frames += pcm
        attempt?.send(Outgoing.Audio(pcm))
        _state.update { it.copy(elapsedMs = frames.size * FRAME_MS, levels = (it.levels + level.coerceIn(0f, 1f)).takeLast(DICTATION_LEVELS)) }
        if (frames.size >= MAX_FRAMES) finish()
    }

    private fun onMicrophoneFailed(problem: MicrophoneProblem) {
        if (phase != DictationPhase.Recording) return
        attempt?.cancel()
        attempt = null
        stopMicrophone()
        write("")
        val key = when (problem) {
            MicrophoneProblem.Denied -> "dictation.failure.denied"
            MicrophoneProblem.NoMicrophone -> "dictation.failure.noMicrophone"
            MicrophoneProblem.Failed -> "dictation.failure.microphone"
        }
        _state.update { it.copy(phase = DictationPhase.Failed, live = "", failure = L10n.uiText(key), canRetry = false) }
    }

    private fun connect(): Attempt {
        val next = Attempt()
        attempt = next
        next.job = scope.launch { next.run() }
        return next
    }

    /** Writes [inserted] between the halves of the draft the dictation started in. */
    private fun write(inserted: String) {
        val target = target ?: return
        val lead = if (inserted.isNotEmpty() && before.isNotEmpty() && !before.last().isWhitespace() && needsSpace(before, inserted)) " " else ""
        val trail = if (inserted.isNotEmpty() && after.isNotEmpty() && !after.first().isWhitespace() && needsSpace(inserted, after)) " " else ""
        target.replaceDraft(before + lead + inserted + trail + after, before.length + lead.length + inserted.length)
    }

    private fun stopMicrophone() {
        recording++
        microphone.stop()
    }

    private fun release() {
        stopMicrophone()
        attempt?.cancel()
        attempt = null
        frames.clear()
        target = null
    }

    private sealed interface Outgoing {
        class Audio(val pcm: ByteArray) : Outgoing
        data object Finish : Outgoing
    }

    /** One socket: `start` once it opens, the audio, then `finish`. Reports at most one outcome. */
    private inner class Attempt {
        // A whole recording plus `finish` fits, so frames sent while the socket opens wait here.
        private val queue = Channel<Outgoing>(MAX_FRAMES + 2)
        var job: Job? = null
        private var settled = false

        fun send(message: Outgoing) { queue.trySend(message) }

        fun cancel() {
            settled = true
            job?.cancel()
        }

        suspend fun run() {
            var closedWith: Short? = null
            var closedBecause = ""
            try {
                api.dictationSocket {
                    // The language is the one 语音输入 settings name; the server reads it.
                    send(Frame.Text("""{"type":"start"}"""))
                    while (!settled) {
                        val done = select<Boolean> {
                            queue.onReceive { message ->
                                when (message) {
                                    is Outgoing.Audio -> send(Frame.Binary(true, message.pcm))
                                    Outgoing.Finish -> send(Frame.Text("""{"type":"finish"}"""))
                                }
                                false
                            }
                            incoming.onReceiveCatching { result ->
                                val frame = result.getOrNull() ?: return@onReceiveCatching true
                                if (frame is Frame.Text) receive(frame.readText())
                                false
                            }
                        }
                        if (done) break
                    }
                    if (settled) runCatching { close(CloseReason(CloseReason.Codes.NORMAL, "")) }
                    else closeReason.await()?.let { closedWith = it.code; closedBecause = it.message }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                AppLog.log(TAG, "socket failed: ${error.message}")
                closedBecause = error.message.orEmpty()
            }
            // Closed before an answer: the connection dropped, or the server refused it (1013: too many at once).
            if (!settled) fail(if (closedWith == 1013.toShort()) "DICTATION_BUSY" else "DICTATION_DISCONNECTED", closedBecause, retryable = true)
        }

        private fun receive(text: String) {
            val message = runCatching { RiffetJson.instance.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
            when (message["type"]?.jsonPrimitive?.content) {
                "partial" -> {
                    val segments = message["segments"]?.jsonArray?.mapNotNull {
                        runCatching { RiffetJson.instance.decodeFromJsonElement(DictationSegment.serializer(), it) }.getOrNull()
                    } ?: return
                    if (attempt !== this) return
                    val settled = joinTranscript(segments.filter { it.final }.map { it.text })
                    write(settled)
                    _state.update { it.copy(written = settled, live = joinTranscript(segments.filter { !it.final }.map { it.text })) }
                }
                "final" -> {
                    if (settled || attempt !== this) return
                    settled = true
                    write(message["text"]?.jsonPrimitive?.content.orEmpty())
                    attempt = null
                    release()
                    _state.value = DictationState()
                }
                "error" -> fail(
                    message["code"]?.jsonPrimitive?.content.orEmpty(),
                    message["message"]?.jsonPrimitive?.content.orEmpty(),
                    message["retryable"]?.jsonPrimitive?.booleanOrNull == true,
                )
            }
        }

        private fun fail(code: String, detail: String, retryable: Boolean) {
            if (settled || attempt !== this) return
            settled = true
            attempt = null
            stopMicrophone()
            // Nothing recorded, nothing to retry: the dictation simply ends with the reason.
            _state.update { it.copy(phase = DictationPhase.Failed, live = "", failure = failureText(code, detail), canRetry = retryable && frames.isNotEmpty()) }
        }
    }
}

private fun failureText(code: String, detail: String): String = when (code) {
    "DICTATION_OFF" -> L10n.uiText("dictation.failure.off")
    "RECOGNIZER_UNAVAILABLE" -> L10n.uiText("dictation.failure.unavailable")
    "DICTATION_DISCONNECTED" -> L10n.uiText("dictation.failure.disconnected")
    "DICTATION_BUSY" -> L10n.uiText("dictation.failure.busy")
    "TRANSCRIPTION_FAILED" -> L10n.uiText("dictation.failure.transcription", detail)
    else -> detail.ifEmpty { code }
}

/** Sentences joined as one text: a space only where two meet at Latin letters or digits. */
fun joinTranscript(parts: List<String>): String {
    val text = StringBuilder()
    for (raw in parts) {
        val part = raw.trim()
        if (part.isEmpty()) continue
        if (text.isNotEmpty() && needsSpace(text.toString(), part)) text.append(' ')
        text.append(part)
    }
    return text.toString()
}

private val LATIN_END = Regex("[A-Za-z0-9][,.!?;:]?$")
private val LATIN_START = Regex("^[A-Za-z0-9]")

/** Between two texts that meet at Latin letters or digits, or where a Latin sentence or clause has ended. */
fun needsSpace(before: String, after: String): Boolean = LATIN_END.containsMatchIn(before) && LATIN_START.containsMatchIn(after)

/** The elapsed time as the recording bar shows it, `m:ss`. */
fun dictationClock(elapsedMs: Long): String {
    val seconds = elapsedMs / 1000
    return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
}
