/**
 * Looks at a Claude terminal while a drafted turn runs: wakes the transcript reader when the pane prints, and reads the
 * pane's tail for it, each at most once per `readMs`. Disarmed (no turn this process saw open, or nobody watching), it
 * holds no observer and reads nothing.
 */
import { CLAUDE_LIVE_SCREEN_BUDGET } from '../../../../../../packages/contracts/src/index.js';
import type { TerminalObserver } from '../../../terminal/service.js';
import type { ScreenTail } from './drafts.js';

export interface ClaudeScreenHost {
  /** The terminal the conversation's CLI runs in now; it changes when the CLI is launched again. */
  terminalId(): string | undefined;
  tail(terminalId: string, rows: number): Promise<ScreenTail | undefined>;
  observe(terminalId: string, callback: TerminalObserver): () => void;
}

export class ClaudeScreenFeed {
  private readonly wakes = new Set<() => void>();
  private armed = false;
  private observed?: { terminalId: string; stop: () => void };
  private timer?: ReturnType<typeof setTimeout>;
  private last?: { terminalId: string; at: number; read: Promise<ScreenTail | undefined> };

  constructor(private readonly host: ClaudeScreenHost) {}

  watch(wake: () => void): () => void {
    this.wakes.add(wake);
    return () => {
      this.wakes.delete(wake);
      this.follow();
    };
  }

  /** On while a turn that can be drafted is open. */
  arm(on: boolean): void {
    this.armed = on;
    this.follow();
  }

  read(): Promise<ScreenTail | undefined> {
    this.follow();
    const terminalId = this.host.terminalId();
    if (!terminalId) return Promise.resolve(undefined);
    const last = this.last;
    if (last?.terminalId === terminalId && Date.now() - last.at < CLAUDE_LIVE_SCREEN_BUDGET.readMs) return last.read;
    const read = this.host.tail(terminalId, CLAUDE_LIVE_SCREEN_BUDGET.tailRows).catch(() => undefined);
    this.last = { terminalId, at: Date.now(), read };
    return read;
  }

  /** Observes the current terminal while armed and watched, and nothing otherwise. */
  private follow(): void {
    const terminalId = this.armed && this.wakes.size ? this.host.terminalId() : undefined;
    if (this.observed?.terminalId === terminalId) return;
    this.observed?.stop();
    this.observed = undefined;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!terminalId) { this.last = undefined; return; }
    this.observed = { terminalId, stop: this.host.observe(terminalId, observation => { if (observation.type === 'output') this.schedule(); }) };
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = Math.max(0, (this.last?.at ?? 0) + CLAUDE_LIVE_SCREEN_BUDGET.readMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const wake of this.wakes) { try { wake(); } catch { /* a reader's failure is its own */ } }
    }, wait);
    this.timer.unref?.();
  }
}
