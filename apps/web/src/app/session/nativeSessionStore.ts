import type { NativeContext, NativeStatus, Run, RunMetrics, Session } from '@contracts';
import type { NativeHistoryState } from '@/lib/api';
import { createStore, type Store } from '@/lib/store';
import type { NativeHistoryLoadState } from './transcriptLoad';

/**
 * What a native conversation renders from: the stream's view of the session and the runs this tab
 * has sent. It lives outside React so the stream and the run commands read and write it
 * synchronously, and so a view can subscribe to just the slice it shows (`useStore`).
 */
export interface NativeSessionState {
  context?: NativeContext;
  /**
   * Output speed per run. A live turn is kept current by `metrics` frames; a finished one is
   * restored from the run's stored aggregate, because for two of the four providers the
   * observation that produced the number no longer exists once their stream has stopped.
   */
  metricsByRun: Map<string, RunMetrics>;
  status: NativeStatus;
  /** Whether `status` came from the backend; until then `offline` is a placeholder, not a fact. */
  statusKnown: boolean;
  loaded: boolean;
  /** Rows still arriving are history the reader missed, not live (`SessionSyncState.catchingUp`). */
  catchingUp: boolean;
  connected: boolean;
  historyLoad: NativeHistoryLoadState;
  runs: Run[];
  sending: boolean;
  interrupting: boolean;
  runActionIds: Set<string>;
  history?: NativeHistoryState;
  historyStale: boolean;
  loadingHistory: boolean;
  timelineVersion: number;
  resetVersion: number;
}

export type NativeSessionStore = Store<NativeSessionState>;

/**
 * Everything a conversation forgets when the view moves to another one. Speeds and an in-flight
 * send are not part of it: the send settles itself, guarded by the session it was made in.
 */
export function blankNativeSession(runs: Run[]): Omit<NativeSessionState, 'metricsByRun' | 'sending' | 'timelineVersion' | 'resetVersion'> {
  return {
    context: undefined, status: { phase: 'offline' }, statusKnown: false, loaded: false, catchingUp: true, connected: false, historyLoad: { state: 'loading' },
    runs, interrupting: false, runActionIds: new Set(), history: undefined, historyStale: false, loadingHistory: false,
  };
}

export function createNativeSessionStore(runs: Run[]): NativeSessionStore {
  return createStore<NativeSessionState>({ ...blankNativeSession(runs), metricsByRun: new Map(), sending: false, timelineVersion: 0, resetVersion: 0 });
}

/**
 * The bookkeeping the stream and the run commands share but never render. Mutated in place, like
 * the refs it replaces, so a late answer can always see whether it still belongs.
 */
export interface NativeSessionTracking {
  /** The conversation the view serves; cleared once its stream closes, so late answers are dropped. */
  sessionId: string;
  /** Counts local edits of the run list, so a slower `/runs` answer cannot overwrite a newer one. */
  runsRevision: number;
  /** Whether a transcript, cached or streamed, has been shown yet. */
  transcriptKnown: boolean;
  /** The run that seeded the view, a stand-in until the server's own list arrives. */
  initialRun?: Run;
  /** A send whose POST has not answered yet. */
  sendInFlight: boolean;
  historyRequest?: { generation: string; controller: AbortController };
}

/** The caller's latest props, read when a frame or a command needs them rather than captured. */
export interface NativeSessionLatest {
  onSessionChanged: (session: Session) => void;
  onError: (message: string) => void;
  notificationsEnabled: boolean;
  title: string;
  chatActive: boolean;
}

export function bumpVersion(store: NativeSessionStore, key: 'timelineVersion' | 'resetVersion'): void {
  store.set((state) => ({ [key]: state[key] + 1 }));
}

/** A local edit of the run list; it advances `runsRevision` so an in-flight `/runs` read stands down. */
export function updateRuns(store: NativeSessionStore, tracking: NativeSessionTracking, update: (current: Run[]) => Run[]): void {
  tracking.runsRevision += 1;
  store.set((state) => ({ runs: update(state.runs) }));
}

export function setRunActionPending(store: NativeSessionStore, runId: string, pending: boolean): void {
  store.set((state) => {
    const next = new Set(state.runActionIds);
    if (pending) next.add(runId);
    else next.delete(runId);
    return { runActionIds: next };
  });
}

const sameMetrics = (a: RunMetrics, b: RunMetrics) => a.outputTokens === b.outputTokens && a.durationMs === b.durationMs && a.steps === b.steps && a.tokens === b.tokens;

/**
 * Pick up the speeds a reload cannot recompute. Every provider stores the settled aggregate on
 * its run, so this is the only path that keeps a finished turn's number on screen after the
 * browser has thrown the live stream away.
 */
export function absorbRunMetrics(store: NativeSessionStore, snapshot: Run[]): void {
  store.set((state) => {
    let next: Map<string, RunMetrics> | undefined;
    for (const run of snapshot) {
      const stored = run.native?.metrics;
      if (!stored) continue;
      const existing = state.metricsByRun.get(run.id);
      if (existing && sameMetrics(existing, stored)) continue;
      next ??= new Map(state.metricsByRun);
      next.set(run.id, stored);
    }
    return next ? { metricsByRun: next } : state;
  });
}

/** A live `metrics` frame for one run. */
export function recordRunMetrics(store: NativeSessionStore, runId: string, aggregate: RunMetrics): void {
  store.set((state) => {
    const existing = state.metricsByRun.get(runId);
    if (existing && sameMetrics(existing, aggregate)) return state;
    const next = new Map(state.metricsByRun);
    next.set(runId, aggregate);
    return { metricsByRun: next };
  });
}
