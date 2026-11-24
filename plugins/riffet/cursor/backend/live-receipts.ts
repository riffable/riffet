import { samePromptText } from '@contracts';
import type { AgentHost } from '@riffet/plugin-api/experimental/agent';
import { cursorPromptAlias, type CursorLive, type CursorLiveStep } from '../native/live.js';

/** How long a sent prompt waits for its CLI to take it; a CLI without the live tap never reports one. */
const WAIT_MS = 10 * 60_000;
/** Recovered sends whose exact pre-write timestamp was lost tolerate slight clock skew. */
const RECOVERED_SKEW_MS = 2000;
const LIMIT = 64;

/** `waitFrom`: when the wait began, if later than the send (a run looked for again at a relaunch or a takeover). */
interface Expected { host: AgentHost; sessionId: string; chatId: string; runId: string; commandId: string; text: string; sentAt: number; waitFrom?: number }

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

  expect(entry: Expected): Promise<void> {
    this.expected.delete(entry.runId);
    this.expected.set(entry.runId, entry);
    while (this.expected.size > LIMIT) this.expected.delete(this.expected.keys().next().value!);
    this.stop ??= this.live.watch(chatId => { void this.check(chatId).catch(() => undefined); });
    return this.check(entry.chatId);
  }

  private async check(chatId: string): Promise<void> {
    const now = Date.now();
    let step: CursorLiveStep | null | undefined;
    for (const [runId, entry] of [...this.expected]) {
      if (now - (entry.waitFrom ?? entry.sentAt) > WAIT_MS) { this.expected.delete(runId); continue; }
      if (entry.chatId !== chatId) continue;
      step ??= this.live.read(chatId) ?? null;
      const started = step ? Date.parse(step.at) : Number.NaN;
      const earliest = entry.waitFrom === undefined ? entry.sentAt : entry.sentAt - RECOVERED_SKEW_MS;
      if (!step?.prompt || this.taken.has(step.turn) || !Number.isFinite(started) || started < earliest || !samePromptText(entry.text, step.prompt)) continue;
      const [run] = await entry.host.runs?.find?.(entry.sessionId, { commandId: entry.commandId }).catch(() => []) ?? [];
      if (this.expected.get(runId) !== entry || this.taken.has(step.turn)) continue;
      if (run && run.id === runId && run.queueReleasedAt !== undefined) {
        const releasedAt = Date.parse(run.queueReleasedAt);
        if (!(started < releasedAt)) {
          this.expected.delete(runId);
          continue;
        }
      }
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
    this.expected.clear();
    this.stop?.();
    this.stop = undefined;
  }
}
