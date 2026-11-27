import type { Run } from '../../../../packages/contracts/src/index.js';

/**
 * Where a conversation stands. Derived from its unfinished runs and the operations in flight, never
 * stored: the runs table is the authority across restarts, and a second copy could only drift from it.
 * The first that applies wins, in this order.
 */
export type SessionPhase = 'stopping' | 'recovering' | 'sending' | 'running' | 'unconfirmed' | 'queued' | 'idle';

/**
 * What the actor was handling when a change showed: an observation of the provider (`status`, `echo`, `turn_end`,
 * other `events`), its own timer or a kick (`wake`), or an operation of its own returning (`settle`).
 */
export type TraceSource = 'status' | 'echo' | 'turn_end' | 'events' | 'wake' | 'settle';

/**
 * One line of the dispatch trace: a conversation changing phase, or one of its runs changing delivery or stage,
 * with the turn the run is bound to (docs/TURN-LIFECYCLE.md §4.7).
 */
export type DispatchTraceEntry =
  | { event: 'phase'; session: string; from: SessionPhase; to: SessionPhase; ms: number; cause: TraceSource }
  | { event: 'run'; session: string; run: string; intent?: string; from?: string; to: string; state: string; attempt: number; code?: string; source: TraceSource; turn?: string };

/** The operations a conversation has in flight, beside what its runs say. */
export interface InFlight { stopping: boolean; recovering: boolean; sending: boolean }

export function phaseOf(runs: readonly Run[], inFlight: InFlight): SessionPhase {
  if (inFlight.stopping) return 'stopping';
  if (inFlight.recovering) return 'recovering';
  const deliveries = new Set(runs.filter(run => !run.native?.queueReleasedAt).map(run => run.native?.delivery));
  if (inFlight.sending || deliveries.has('preparing') || deliveries.has('dispatching') || deliveries.has('input_sent')) return 'sending';
  if (deliveries.has('observed')) return 'running';
  if (deliveries.has('uncertain')) return 'unconfirmed';
  return deliveries.has('queued') ? 'queued' : 'idle';
}

/**
 * Reports what each message changed in one conversation: its phase, and every run whose delivery or
 * stage moved. It compares with what it reported last, so a change an operation made between two
 * messages (the adapter crossing the write fence) shows up with the next message, as one step.
 * Holds one entry per unfinished run.
 */
export class DispatchTrace {
  private phase: SessionPhase = 'idle';
  private since = Date.now();
  private readonly runs = new Map<string, string>();

  constructor(private readonly sessionId: string, private readonly log: (entry: DispatchTraceEntry) => void) {}

  /** `finished` reads a run that is no longer unfinished, to report where it ended. */
  record(runs: readonly Run[], phase: SessionPhase, cause: TraceSource, finished: (runId: string) => Run | undefined): void {
    const unfinished = new Set(runs.map(run => run.id));
    for (const run of runs) this.report(run, true, cause);
    for (const id of [...this.runs.keys()]) {
      if (unfinished.has(id)) continue;
      const run = finished(id);
      if (run) this.report(run, false, cause);
      this.runs.delete(id);
    }
    if (phase === this.phase) return;
    const at = Date.now();
    this.log({ event: 'phase', session: this.sessionId, from: this.phase, to: phase, ms: at - this.since, cause });
    this.phase = phase;
    this.since = at;
  }

  clear(): void { this.runs.clear(); }

  private report(run: Run, unfinished: boolean, source: TraceSource): void {
    const native = run.native;
    if (!native) return;
    const from = this.runs.get(run.id);
    const to = native.stage ? `${native.delivery}/${native.stage}` : native.delivery;
    if (from === to) return;
    if (unfinished) this.runs.set(run.id, to);
    this.log({ event: 'run', session: this.sessionId, run: run.id, ...(native.intent ? { intent: native.intent } : {}),
      ...(from ? { from } : {}), to, state: run.state, attempt: native.attempt,
      ...(native.diagnostic?.code ? { code: native.diagnostic.code } : {}), source,
      ...(native.nativeTurnId ? { turn: native.nativeTurnId } : {}) });
  }
}
