import type { NativeActivity, NativeStatus, NativeWorkbenchEvent } from '@riffet/contracts';
import { AppError } from './errors.js';

/**
 * System activities (context compaction, background tasks, local command output): what the CLI does
 * on its own inside a conversation. See docs/SESSION-JOURNAL.md, 系统活动.
 *
 * An activity travels as a `session/update` event with `data.sessionUpdate === 'activity'`; the event's
 * `nativeId` is the activity id, so each later state of an activity is a new version of the same
 * journal entity and keeps the position of the first one. This module is the one place that knows
 * that shape: backends build events with {@link activityEvent}, keep live state in an
 * {@link ActivityLedger}, and report the summary with {@link withActivity}.
 */

export const ACTIVITY_EVENT_TYPE = 'session/update';
export const ACTIVITY_UPDATE = 'activity';
/** Longest `detail` preview; anything longer goes to a blob and is referenced by `blobRef`. */
export const ACTIVITY_DETAIL_LIMIT = 2048;
/** Largest full text stored for one activity. */
export const ACTIVITY_BLOB_LIMIT = 1024 * 1024;
/** Compaction normally takes minutes; one that claims to run longer than this has lost its end. */
export const COMPACTION_STALE_MS = 30 * 60_000;
const LEDGER_LIMIT = 500;

export const isLiveActivity = (activity: Pick<NativeActivity, 'status'>): boolean => activity.status === 'running' || activity.status === 'stopping';

/** `${backend}:${nativeId}`, the id every state of one activity shares. */
export const activityId = (backend: string, nativeId: string): string => `${backend}:${nativeId}`;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

/** A preview fit for `detail`: no ANSI escapes, cut to the limit on a character boundary. */
export function clipDetail(text: string, limit = ACTIVITY_DETAIL_LIMIT): string {
  const plain = text.replace(ANSI, '').replace(/\r\n?/g, '\n').trim();
  return plain.length > limit ? `${plain.slice(0, limit - 1)}…` : plain;
}

/** The first line of `text`, cut to a one-line title. */
export function activityTitle(text: string, fallback: string, limit = 120): string {
  const line = text.replace(ANSI, '').split('\n').map(part => part.trim()).find(Boolean);
  if (!line) return fallback;
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** The transcript event of one activity state. `sequence` is the backend's number for the entity (0 until the log assigns it). */
export function activityEvent(
  sessionId: string, activity: NativeActivity,
  base: { sequence?: number; runId?: string; nativeTurnId?: string; createdAt?: string } = {},
): NativeWorkbenchEvent {
  return {
    sequence: base.sequence ?? 0,
    sessionId,
    ...(base.runId ? { runId: base.runId } : {}),
    type: ACTIVITY_EVENT_TYPE,
    data: { sessionUpdate: ACTIVITY_UPDATE, activity },
    createdAt: base.createdAt ?? activity.startedAt ?? new Date().toISOString(),
    nativeId: activity.id,
    ...(base.nativeTurnId ? { nativeTurnId: base.nativeTurnId } : {}),
  };
}

/** The activity an event carries, whether read from a stored payload or a live event. */
export function activityOfEvent(value: unknown): NativeActivity | undefined {
  const data = (value as { data?: { sessionUpdate?: unknown; activity?: unknown } } | undefined)?.data;
  if (data?.sessionUpdate !== ACTIVITY_UPDATE) return undefined;
  const activity = data.activity as NativeActivity | undefined;
  return activity && typeof activity.id === 'string' && typeof activity.kind === 'string' && typeof activity.status === 'string' ? activity : undefined;
}

/** What `NativeStatus.activity` reports for a set of activities. */
export function summarizeActivities(activities: Iterable<NativeActivity>, now = Date.now()): { compacting: boolean; background: number } {
  let compacting = false, background = 0;
  for (const activity of activities) {
    if (!isLiveActivity(activity)) continue;
    if (activity.kind === 'compaction') {
      const started = activity.startedAt ? Date.parse(activity.startedAt) : Number.NaN;
      if (!(Number.isFinite(started) && now - started > COMPACTION_STALE_MS)) compacting = true;
    } else if (activity.kind === 'background_task') background += 1;
  }
  return { compacting, background };
}

/**
 * Puts the activity summary on a status. While the context is being compacted the main turn counts as
 * busy even if the CLI reports nothing running; the client shows "compacting" for it, not "running".
 */
export function withActivity(status: NativeStatus, activities: Iterable<NativeActivity>, options: { upgradePhase?: boolean } = {}): NativeStatus {
  const summary = summarizeActivities(activities);
  const { activity: _previous, ...rest } = status;
  if (!summary.compacting && summary.background === 0) return rest;
  // A runtime that feeds its own status back into itself passes `upgradePhase: false`, so the upgrade is never remembered as the CLI's own phase.
  return { ...rest, phase: options.upgradePhase !== false && summary.compacting && rest.phase === 'idle' ? 'busy' : rest.phase, activity: summary };
}

const same = (left: NativeActivity, right: NativeActivity): boolean => JSON.stringify(left) === JSON.stringify(right);

/** A reused agent id starts a new execution only when both the launching call and start changed. */
function agentExecutionOrder(next: NativeActivity, current: NativeActivity): number | undefined {
  if (next.kind !== 'background_task' || current.kind !== 'background_task' || next.task?.kind !== 'agent' || current.task?.kind !== 'agent'
    || !next.toolCallId || !current.toolCallId || next.toolCallId === current.toolCallId) return undefined;
  const a = Date.parse(next.startedAt ?? ''), b = Date.parse(current.startedAt ?? '');
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : 0;
}

/**
 * The live state of one session's activities, and the rules every backend shares:
 * an execution that has ended does not come back to life; a "still running" report cannot undo a stop
 * that was requested; the first `startedAt` of an execution is kept and `durationMs` is derived when
 * both ends are known. A reused agent id needs a different launching call and a later start.
 *
 * `sink` is how a backend writes a new state (journal row, live event); it is called only when
 * something changed, with `created` true for the first state of an id.
 */
export class ActivityLedger {
  private readonly items = new Map<string, NativeActivity>();
  /** Who put an activity into `stopping`: a failed stop may only undo its own. */
  private readonly stopTokens = new Map<string, number>();
  private stopCounter = 0;

  constructor(private readonly sink: (activity: NativeActivity, created: boolean) => void, private readonly read?: (id: string) => NativeActivity | undefined) {}

  get(id: string): NativeActivity | undefined {
    const known = this.items.get(id);
    if (known) return known;
    const retained = this.read?.(id);
    if (retained) { this.items.set(id, retained); this.trim(); }
    return retained;
  }
  list(): NativeActivity[] { return [...this.items.values()]; }
  live(): NativeActivity[] { return this.list().filter(isLiveActivity); }

  /** Records a state; returns the state the ledger now holds. */
  apply(next: NativeActivity, now = new Date()): NativeActivity {
    const previous = this.get(next.id);
    const execution = previous ? agentExecutionOrder(next, previous) : undefined;
    if (execution !== undefined && execution <= 0) return previous!;
    const sameExecution = execution === undefined;
    if (!sameExecution) this.stopTokens.delete(next.id);
    // An ended execution stays ended; `unknown` (a lost connection) is the one end evidence can revoke.
    if (previous && sameExecution && !isLiveActivity(previous) && previous.status !== 'unknown' && isLiveActivity(next)) return previous;
    const merged: NativeActivity = { ...(sameExecution ? previous : {}), ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) } as NativeActivity;
    if (sameExecution && previous?.status === 'stopping' && next.status === 'running') merged.status = 'stopping';
    // The first start stays within its execution; a poller that only knows "now" cannot restart it.
    if (sameExecution && previous?.startedAt) merged.startedAt = previous.startedAt;
    if (sameExecution && previous?.status === 'unknown' && isLiveActivity(merged)) {
      delete merged.endedAt;
      delete merged.durationMs;
    }
    if (!isLiveActivity(merged)) {
      merged.endedAt ??= now.toISOString();
      if (merged.durationMs === undefined && merged.startedAt) {
        const span = Date.parse(merged.endedAt) - Date.parse(merged.startedAt);
        if (Number.isFinite(span) && span >= 0) merged.durationMs = span;
      }
    }
    if (merged.status !== 'stopping') this.stopTokens.delete(merged.id);
    if (previous && same(previous, merged)) return previous;
    this.items.set(merged.id, merged);
    this.trim();
    this.sink(merged, !previous);
    return merged;
  }

  /**
   * A stop was requested: the activity becomes `stopping`. It stays so until native evidence arrives
   * (then the backend applies `stopped`), or the request fails ({@link stopFailed}).
   */
  requestStop(id: string): NativeActivity {
    const current = this.items.get(id);
    if (!current) throw new AppError('ACTIVITY_NOT_FOUND', 'This activity is not known to the conversation', 404);
    if (!current.stop) throw new AppError('ACTIVITY_NOT_STOPPABLE', 'This activity cannot be stopped from here', 409);
    if (!isLiveActivity(current)) throw new AppError('ACTIVITY_ENDED', 'This activity has already ended', 409);
    return current.status === 'stopping' ? current : this.apply({ ...current, status: 'stopping' });
  }

  /**
   * Like {@link requestStop}, and says whether this call is the one that made the activity `stopping`.
   * Only that caller holds the `token` that {@link stopFailed} needs to put it back; a second request
   * while a stop is in flight is told so (`token` undefined) and must not roll the first one back.
   */
  beginStop(id: string): { activity: NativeActivity; token?: number } {
    const current = this.items.get(id);
    if (current?.status === 'stopping') return { activity: current };
    const activity = this.requestStop(id);
    const token = ++this.stopCounter;
    this.stopTokens.set(id, token);
    return { activity, token };
  }

  /**
   * The native stop did not happen: the activity is running again. With a `token` from {@link beginStop}
   * this only undoes that stop; without one it undoes whatever `stopping` there is.
   */
  stopFailed(id: string, token?: number): NativeActivity | undefined {
    const current = this.items.get(id);
    if (!current || current.status !== 'stopping') return current;
    if (token !== undefined && this.stopTokens.get(id) !== token) return current;
    this.stopTokens.delete(id);
    const restored = { ...current, status: 'running' as const };
    this.items.set(id, restored);
    this.sink(restored, false);
    return restored;
  }

  /** Ends every live activity matching `predicate` (their owner is gone), as `status`. */
  settleWhere(predicate: (activity: NativeActivity) => boolean, status: 'completed' | 'failed' | 'stopped' | 'unknown', now = new Date()): void {
    for (const activity of this.live()) if (predicate(activity)) this.apply({ ...activity, status: status === 'completed' && activity.status === 'stopping' ? 'stopped' : status }, now);
  }

  /** Takes up states already written (by an earlier process), without writing them again. */
  restore(activities: Iterable<NativeActivity>): void {
    for (const activity of activities) this.items.set(activity.id, activity);
    this.trim();
  }

  clear(): void { this.items.clear(); this.stopTokens.clear(); }

  /** The source retracted this activity; preserve every other activity's pending stop token. */
  forget(id: string): void { this.items.delete(id); this.stopTokens.delete(id); }

  private trim(): void {
    if (this.items.size <= LEDGER_LIMIT) return;
    for (const [id, activity] of this.items) {
      if (this.items.size <= LEDGER_LIMIT) break;
      if (!isLiveActivity(activity)) this.items.delete(id);
    }
  }
}
