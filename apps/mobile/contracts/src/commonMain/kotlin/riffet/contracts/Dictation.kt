package riffet.contracts

import kotlinx.serialization.Serializable

// Dictation (docs/VOICE.md §4), mirroring packages/contracts/src/dictation.ts: a client streams 16 kHz mono PCM16LE over
// one WebSocket in binary frames and reads the text back as JSON text frames.

const val DICTATION_ROUTE = "/api/dictation/ws"
const val DICTATION_SAMPLE_RATE = 16_000
/** `AppSettings.voiceInput.recognizer` for the OpenAI-format transcription service the user configures. */
const val REMOTE_SPEECH_RECOGNIZER = "remote"

/** One sentence. A `final` segment no longer changes; the last one may still. */
@Serializable
data class DictationSegment(val text: String, val final: Boolean)

/** 语音输入 settings. Phones only read them: a set [recognizer] turns voice input on. */
@Serializable
data class VoiceInputSettings(
    val recognizer: String? = null,
    val language: String? = null,
)
