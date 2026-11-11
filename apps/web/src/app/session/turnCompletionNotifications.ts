import type { TurnOutlineV3 } from '@contracts';

interface ObservedTurn { running: boolean; consumed: boolean }

/**
 * Completion notifications follow main-lane turn results, never the session's idle phase.
 * Keep this separate from browser permissions: a completion seen in the foreground is consumed too.
 */
export class TurnCompletionNotifications {
  private thread: string | undefined;
  private ready = false;
  private observingSince = 0;
  private readonly turns = new Map<string, ObservedTurn>();

  /** A session update can name a replacement before its new generation supplies an outline. */
  setThread(thread: string | undefined): void {
    if (this.thread === thread) return;
    const firstIdentity = this.thread === undefined && thread !== undefined;
    this.thread = thread;
    // Resolving the initially unnamed thread does not replace the conversation already observed.
    if (firstIdentity) return;
    this.ready = false;
    this.turns.clear();
  }

  /** Reconnects and generation rebuilds preserve the same native turn identities. */
  hello(thread: string | undefined, turns: readonly TurnOutlineV3[], now: number): boolean {
    this.setThread(thread);
    if (this.ready) return this.outline(turns);
    this.ready = true;
    this.observingSince = now;
    for (const turn of turns) {
      // Without an explicit end, completed can be a fold's temporary inference rather than a
      // historical result. Leave it eligible for a later reliable end, without treating it as running.
      const consumed = turn.status === 'failed' || turn.status === 'cancelled'
        || (turn.status === 'completed' && Number.isFinite(Date.parse(turn.endedAt ?? '')));
      this.turns.set(turn.turnId, { running: turn.status === 'running', consumed });
    }
    return false;
  }

  /** Consume all completions in one frame; one browser notification can represent that update. */
  outline(turns: readonly TurnOutlineV3[]): boolean {
    if (!this.ready) return false;
    let completed = false;
    for (const turn of turns) {
      const observed = this.turns.get(turn.turnId) ?? { running: false, consumed: false };
      this.turns.set(turn.turnId, observed);
      // Providers can explicitly reopen a native turn after a terminal outcome. A result correction
      // alone must not reopen eligibility; the running outline also has to withdraw its old end.
      if (turn.status === 'running' && !turn.endedAt) observed.consumed = false;
      if (observed.consumed) continue;
      if (turn.status === 'running') {
        observed.running = true;
      } else if (turn.status !== 'completed') {
        observed.consumed = true;
      } else if (turn.endedAt) {
        // A start and end can be folded into one outline update, including turns typed in the CLI.
        // Their timestamp distinguishes a new fast turn from an old history import. Observed
        // running turns need no clock comparison, including completion while disconnected. The
        // fast-turn fallback assumes aligned client/server clocks; the protocol has no live-only
        // completion marker to distinguish every recent history import from a new fast turn.
        const endedAt = Date.parse(turn.endedAt);
        if (!Number.isFinite(endedAt)) continue;
        observed.consumed = true;
        completed ||= observed.running || endedAt >= this.observingSince;
      }
    }
    return completed;
  }
}
