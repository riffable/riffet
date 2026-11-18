import { samePromptText } from '@contracts';
import type { AgentHost } from '@riffet/plugin-api/experimental/agent';
import { cursorPromptAlias, type CursorLive, type CursorLiveStep } from '../native/live.js';

/** How long a sent prompt waits for its CLI to take it; a CLI without the live tap never reports one. */
const WAIT_MS = 10 * 60_000;
/** The CLI starts its run after the prompt is written; this much clock difference is still the same send. */
const SKEW_MS = 2000;
const LIMIT = 64;

interface Expected { host: AgentHost; sessionId: string; chatId: string; runId: string; commandId: string; text: string; sentAt: number }

/**
 * A Cursor run is received once its CLI sends the prompt to the agent server, which the live tap sees
 * long before the store records it (a text-only answer: at its end). That is the run's receipt, under
 * the request id the turn is filed under and the alias its prompt row carries (`cursorPromptAlias`).
 */
export class CursorLiveReceipts {
  private readonly expected = new Map<string, Expected>();
  /** Request ids already given to a run: one CLI run answers one send. */
  private readonly taken = new Set<string>();
  private stop: (() => void) | undefined;

  constructor(private readonly live: Pick<CursorLive, 'read' | 'watch'>, private readonly onReceipt?: (sessionId: string) => void) {}

  expect(entry: Expected): void {
    this.expected.delete(entry.runId);
    this.expected.set(entry.runId, entry);
    while (this.expected.size > LIMIT) this.expected.delete(this.expected.keys().next().value!);
    this.stop ??= this.live.watch(chatId => this.check(chatId));
    this.check(entry.chatId);
  }

  private check(chatId: string): void {
    const now = Date.now();
    let step: CursorLiveStep | null | undefined;
    for (const [runId, entry] of [...this.expected]) {
      if (now - entry.sentAt > WAIT_MS) { this.expected.delete(runId); continue; }
      if (entry.chatId !== chatId) continue;
      step ??= this.live.read(chatId) ?? null;
      if (!step?.prompt || this.taken.has(step.turn) || Date.parse(step.at) < entry.sentAt - SKEW_MS || !samePromptText(entry.text, step.prompt)) continue;
      this.expected.delete(runId);
      this.taken.add(step.turn);
      while (this.taken.size > LIMIT) this.taken.delete(this.taken.values().next().value!);
      entry.host.emitEvent(entry.sessionId, {
        type: 'native_input_receipt', nativeId: cursorPromptAlias(step.turn), runId, nativeTurnId: step.turn, createdAt: step.at,
        data: { commandId: entry.commandId, content: { type: 'text', text: entry.text } },
      });
      this.onReceipt?.(entry.sessionId);
    }
    if (!this.expected.size) this.close();
  }

  close(): void {
    this.stop?.();
    this.stop = undefined;
  }
}
