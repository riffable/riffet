/**
 * Dictation (docs/VOICE.md §4): a client streams 16 kHz mono PCM16 to the server over one WebSocket and
 * reads the text back. Binary frames carry audio; text frames carry these messages as JSON.
 */
export const DICTATION_ROUTE = '/api/dictation/ws';
export const DICTATION_SAMPLE_RATE = 16_000;
/** `AppSettings.voiceInput.recognizer` for the OpenAI-format transcription service the user configures. */
export const REMOTE_SPEECH_RECOGNIZER = 'remote';

export type DictationClientMessage =
  | { type: 'start'; language?: string }
  | { type: 'finish' }
  | { type: 'cancel' };

/** One sentence. A `final` segment no longer changes; the last one may still. */
export interface DictationSegment { text: string; final: boolean }

export type DictationServerMessage =
  /** The recognizer is open; `streaming` says whether `partial` will come while the user speaks. */
  | { type: 'ready'; streaming: boolean }
  /** Every segment so far, replacing the previous `partial`. */
  | { type: 'partial'; segments: DictationSegment[] }
  | { type: 'final'; text: string }
  /** `retryable`: the same audio may succeed if sent again. */
  | { type: 'error'; code: string; message: string; retryable: boolean };
