import type { NativeStatus } from '@riffet/contracts';

/**
 * One turn lifecycle for the backends that read a CLI through a protocol and, on the side, a hook or a
 * screen (Codex, Droid, DSH, Cursor). Each used to assemble `NativeStatus.phase` itself and arbitrate
 * with counters and booleans. A tracker owns the phase instead; a backend reports what it saw, tagged
 * with where it saw it, and the tracker decides.
 *
 *   offline -> starting -> idle -> running -> idle        attention can interrupt a running turn
 *
 * Claude Code does not use this: its state is event-sourced from transcript rows and hooks
 * (`backends/claude/session-state.ts`), and no channel outranks another there.
 *
 * Rules, in the order they are applied to an observation:
 *  1. Evidence outranks by source: protocol > hook > transcript > screen. A turn that evidence naming
 *     the turn (`turnId`) opened can only be ended by evidence of at least that rank.
 *  2. An attention state is left only by evidence at least as strong as the one that raised it.
 */
export type TurnPhase = 'offline' | 'starting' | 'idle' | 'running' | 'attention';

export type TurnEvidence = 'screen' | 'transcript' | 'hook' | 'protocol';

const RANK: Record<TurnEvidence, number> = { screen: 1, transcript: 2, hook: 3, protocol: 4 };

export interface TurnObservation {
  source: TurnEvidence;
  phase: TurnPhase;
  /** The turn this evidence is about. Evidence that names none cannot own a turn. */
  turnId?: string;
}

export interface TurnTrackerOptions {
  /** Cadence suggestions. */
  activePollMs?: number;
  /** Backstop cadence for a backend whose protocol already pushes changes. */
  fallbackPollMs?: number;
}

export function turnPhaseOf(native: NativeStatus['phase']): TurnPhase {
  return native === 'busy' ? 'running' : native;
}

export class TurnTracker {
  private current: TurnPhase;
  private turn?: string;
  private ownerRank = 0;
  private attentionRank = 0;
  private readonly options: Required<TurnTrackerOptions>;

  constructor(initial: TurnPhase = 'offline', options: TurnTrackerOptions = {}) {
    this.current = initial;
    this.options = { activePollMs: options.activePollMs ?? 300, fallbackPollMs: options.fallbackPollMs ?? 10_000 };
  }

  get phase(): TurnPhase { return this.current; }

  /** The phase as `NativeStatus` states it. */
  get nativePhase(): NativeStatus['phase'] {
    return this.current === 'running' ? 'busy' : this.current;
  }

  /** Returns whether the observation was accepted. */
  observe(observation: TurnObservation): boolean {
    const { source, phase: target, turnId } = observation;
    const rank = RANK[source];
    const phase = this.current;
    const named = turnId !== undefined && this.turn !== undefined && turnId !== this.turn;
    switch (target) {
      case 'offline': case 'starting':
        this.reset(target);
        return true;
      case 'idle':
        if (phase === 'idle') return true;
        if (named) return false;
        if (phase === 'running' && rank < this.ownerRank) return false;
        if (phase === 'attention' && rank < this.attentionRank) return false;
        this.reset('idle');
        return true;
      case 'running':
        if (phase === 'attention') {
          if (rank < this.attentionRank) return false;
          this.current = 'running';
          this.attentionRank = 0;
          this.claim(rank, turnId);
          return true;
        }
        if (phase === 'running') {
          if (named && rank >= this.ownerRank) {
            this.reset('running');
            this.claim(rank, turnId);
          } else if (named) return false;
          else this.claim(rank, turnId);
          return true;
        }
        // idle / offline / starting: a turn opens.
        this.reset('running');
        this.claim(rank, turnId);
        return true;
      case 'attention':
        if (phase === 'attention' && rank < this.attentionRank) return false;
        if (named && phase !== 'running') return false;
        this.current = 'attention';
        this.attentionRank = rank;
        return true;
    }
  }

  /** Interval for a history read: quick without a trustworthy push feed, a slow backstop with one. */
  suggestedPollMs(pushHealthy: boolean): number {
    return pushHealthy ? this.options.fallbackPollMs : this.options.activePollMs;
  }

  private claim(rank: number, turnId?: string): void {
    if (turnId !== undefined) {
      this.turn = turnId;
      this.ownerRank = Math.max(this.ownerRank, rank);
    }
  }

  private reset(phase: TurnPhase): void {
    this.current = phase;
    this.turn = undefined;
    this.ownerRank = 0;
    this.attentionRank = 0;
  }
}

/**
 * Trackers for backends whose CLI states its phase over one channel (a protocol or a single screen
 * reader) and keep that phase on an object they do not own the shape of. `report` is the one place
 * such a backend turns "what I just read" into `NativeStatus.phase`.
 */
export class KeyedTurnTrackers<K extends object> {
  private readonly trackers = new WeakMap<K, TurnTracker>();

  of(key: K, options?: TurnTrackerOptions): TurnTracker {
    let tracker = this.trackers.get(key);
    if (!tracker) { tracker = new TurnTracker('offline', options); this.trackers.set(key, tracker); }
    return tracker;
  }

  report(key: K, phase: NativeStatus['phase'], source: TurnEvidence = 'protocol', turnId?: string): NativeStatus['phase'] {
    const tracker = this.of(key);
    tracker.observe({ source, phase: turnPhaseOf(phase), ...(turnId ? { turnId } : {}) });
    return tracker.nativePhase;
  }
}
