import type { Session, SessionGoal } from '../../../../../packages/contracts/src/index.js';
import { firstMessageTitlePatch, generatedTitlePatch } from '../../session-title.js';
import type { NativeBackendHost, NativeControlMessage } from '../types.js';
import type { ClaudeTranscript } from './history.js';

export class TranscriptAdoption {
  constructor(private readonly deps: {
    host: NativeBackendHost;
    session(): Session;
    transcriptState(): ClaudeTranscript['state'];
    emit(message: NativeControlMessage): void;
  }) {}

  /**
   * Name the conversation after the first human message of its transcript. Idempotent, because
   * the second call sees `titleSource: 'prompt'` (see `session-title.ts`).
   */
  nameFromMessage(text: string): void {
    const patch = firstMessageTitlePatch(this.deps.host.getSession(this.deps.session().id), text);
    if (!patch) return;
    this.deps.emit({ type: 'session', session: this.deps.host.updateSession(this.deps.session().id, patch) });
  }

  /** Keep the session's goal equal to what the transcript's `/goal` rows say. */
  adoptTranscriptGoal(goal: SessionGoal | undefined): void {
    if (this.deps.transcriptState() !== 'ok' || JSON.stringify(goal) === JSON.stringify(this.deps.host.getSession(this.deps.session().id).goal)) return;
    this.deps.emit({ type: 'session', session: this.deps.host.updateSession(this.deps.session().id, { goal }) });
  }

  /** Adopt the title Claude Code recorded in its transcript; it replaces the first message once. */
  adoptTranscriptTitle(title: string, firstPrompt?: string): void {
    const patch = generatedTitlePatch(this.deps.host.getSession(this.deps.session().id), title, firstPrompt);
    if (!patch) return;
    this.deps.emit({ type: 'session', session: this.deps.host.updateSession(this.deps.session().id, patch) });
  }
}
