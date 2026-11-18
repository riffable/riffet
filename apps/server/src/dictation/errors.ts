/** A dictation that cannot go on; `retryable` says whether sending the same audio again may succeed (docs/VOICE.md §4). */
export class DictationError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) { super(message); this.name = 'DictationError'; }
}
