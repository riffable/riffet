import { samePromptText } from '@contracts';
import type { AgentHost } from '@riffet/plugin-api/experimental/agent';
import { cursorPromptAlias, type CursorLive, type CursorLiveStep } from '../native/live.js';

/** How long a sent prompt waits for its CLI to take it; a CLI without the live tap never reports one. */
const WAIT_MS = 10 * 60_000;
/** A recovered send's recorded completion can follow the CLI starting its request. */
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
      if (!step?.prompt || this.taken.has(step.turn) || !samePromptText(entry.text, step.prompt)) continue;
      const started = Date.parse(step.at);
      // A recovered run only has the time the handover finished. A live send has its exact pre-write fence.
      if (!Number.isFinite(started) || started < entry.sentAt - (entry.waitFrom === undefined ? 0 : RECOVERED_SKEW_MS)) continue;
      const [run] = await entry.host.runs.find(entry.sessionId, { commandId: entry.commandId }).catch(() => []);
      if (!run || run.id !== runId || this.expected.get(runId) !== entry || this.taken.has(step.turn)) continue;
      // A later identical prompt can be a new send. Only requests started before release may correct the old one.
      if (run.queueReleasedAt !== undefined && !(started < Date.parse(run.queueReleasedAt))) {
        this.expected.delete(runId);
        continue;
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
    this.stop?.();
    this.stop = undefined;
    this.expected.clear();
  }
}
