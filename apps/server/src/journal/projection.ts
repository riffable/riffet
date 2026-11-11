import { ACTIVITY_EVENT_TYPE, activityOfEvent, isLiveActivity } from './activity.js';

/**
 * The state of a session as a fold over its journal: whether a turn is open, and an outline of the
 * turns. A projection is a cache of that fold (see `Journal.projection`); `asOfSeq` is the last row
 * it has seen, and `check` ties it to that row so a cache built from a different log is detected.
 */

export interface TurnOutline {
  turnId: string;
  /** Seq of the first row seen for the turn, and of the row that closed it. */
  startSeq: number;
  endSeq?: number;
  at: string;
  endedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  /** Start of the turn's first user message, so an outline can label a jump target. */
  preview?: string;
  /** Entities the turn holds (first versions, not revisions). */
  events: number;
}

export interface SessionProjection {
  v: 1;
  asOfSeq: number;
  state: 'idle' | 'running';
  activeTurnId?: string;
  entities: number;
  turnCount: number;
  lastEventAt?: string;
  /** The newest turns, oldest first; older ones are only counted. */
  turns: TurnOutline[];
  /** Activities in progress (see `activity.ts`), by id; absent until the first one is logged. */
  activities?: Record<string, LiveActivity>;
  check: string;
}

/** What the fold keeps of a running activity: enough to count it and to end it with its turn. */
export interface LiveActivity { kind: 'compaction' | 'background_task'; turnId?: string; at: string }

/** `NativeStatus.activity` as the log alone says it: what was running as of the last row. */
export function projectedActivity(projection: SessionProjection): { compacting: boolean; background: number } {
  const live = Object.values(projection.activities ?? {});
  return { compacting: live.some(item => item.kind === 'compaction'), background: live.filter(item => item.kind === 'background_task').length };
}

export interface JournalFoldRow {
  seq: number;
  kind: string;
  nativeId?: string;
  rev: number;
  turnId?: string;
  at: string;
  payload: unknown;
}

export const OUTLINE_TURNS = 2000;
const LIVE_ACTIVITY_LIMIT = 200;
const PREVIEW_CHARS = 120;

export const projectionCheck = (asOfSeq: number, digest: string): string => `${asOfSeq}:${digest}`;

export function emptyProjection(): SessionProjection {
  return { v: 1, asOfSeq: 0, state: 'idle', entities: 0, turnCount: 0, turns: [], check: projectionCheck(0, '') };
}

const RUN_STATUS: Record<string, TurnOutline['status']> = { run_completed: 'completed', run_failed: 'failed', run_cancelled: 'cancelled' };

function textOf(payload: unknown): string | undefined {
  const data = (payload as { data?: { content?: { text?: unknown } } } | undefined)?.data;
  const text = data?.content?.text;
  return typeof text === 'string' ? text : undefined;
}

/** Folds rows (ascending, contiguous with `asOfSeq`) into a new projection; the input is not modified. */
export function foldProjection(base: SessionProjection, rows: readonly JournalFoldRow[]): SessionProjection {
  const next: SessionProjection = { ...base, turns: base.turns.slice(), ...(base.activities ? { activities: { ...base.activities } } : {}) };
  const open = new Map<string, TurnOutline>(next.turns.map(turn => [turn.turnId, turn]));
  const turnFor = (row: JournalFoldRow): TurnOutline | undefined => {
    if (!row.turnId) return undefined;
    let turn = open.get(row.turnId);
    if (!turn) {
      turn = { turnId: row.turnId, startSeq: row.seq, at: row.at, status: 'running', events: 0 };
      open.set(turn.turnId, turn);
      next.turns.push(turn);
      next.turnCount += 1;
      if (next.turns.length > OUTLINE_TURNS) { const dropped = next.turns.shift()!; open.delete(dropped.turnId); }
    }
    return turn;
  };
  for (const row of rows) {
    if (row.seq <= next.asOfSeq) continue;
    next.asOfSeq = row.seq;
    next.lastEventAt = row.at;
    if (row.kind === 'tombstone') {
      // Only a retracted turn end reopens the turn; retiring a content row has no lifecycle meaning.
      if (row.turnId && row.nativeId === `meta:turn:${row.turnId}:ended`) {
        const turn = turnFor(row);
        if (turn) { turn.status = 'running'; delete turn.endSeq; delete turn.endedAt; }
      }
      continue;
    }
    if (row.kind === 'draft') continue;
    const turn = turnFor(row);
    const activity = row.kind === ACTIVITY_EVENT_TYPE ? activityOfEvent(row.payload) : undefined;
    if (activity) {
      // Only the latest state of an id counts: a live one is tracked, any other state removes it.
      if (isLiveActivity(activity) && (activity.kind === 'compaction' || activity.kind === 'background_task')) {
        const live = next.activities ??= {};
        if (!live[activity.id] && Object.keys(live).length >= LIVE_ACTIVITY_LIMIT) delete live[Object.keys(live)[0]!];
        live[activity.id] = { kind: activity.kind, ...(row.turnId ? { turnId: row.turnId } : {}), at: activity.startedAt ?? row.at };
      } else if (next.activities) {
        delete next.activities[activity.id];
        if (!Object.keys(next.activities).length) delete next.activities;
      }
    }
    if (row.kind === 'meta.turn_ended' && turn) {
      // A compaction cannot outlive the turn that ran it, even if its own end was never logged.
      if (next.activities) {
        for (const [id, item] of Object.entries(next.activities)) if (item.kind === 'compaction' && item.turnId === row.turnId) delete next.activities[id];
        if (!Object.keys(next.activities).length) delete next.activities;
      }
      const status = (row.payload as { status?: string } | undefined)?.status;
      turn.status = status === 'failed' ? 'failed' : status === 'cancelled' || status === 'interrupted' ? 'cancelled' : 'completed';
      turn.endSeq = row.seq; turn.endedAt = row.at;
    } else if (RUN_STATUS[row.kind] && turn) {
      turn.status = RUN_STATUS[row.kind]!;
      turn.endSeq = row.seq; turn.endedAt = row.at;
    } else if (!row.kind.startsWith('meta.') && row.rev === 1) {
      next.entities += 1;
      if (turn) {
        turn.events += 1;
        // A late event reopens nothing: only an explicit start does (below).
        if (row.kind === 'user_message_chunk' && turn.preview === undefined) {
          const text = textOf(row.payload);
          if (text) turn.preview = text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
        }
      }
    } else if (row.kind === 'meta.turn_started' && turn) {
      turn.status = 'running'; delete turn.endSeq; delete turn.endedAt;
    }
  }
  const last = next.turns.at(-1);
  next.state = last?.status === 'running' ? 'running' : 'idle';
  if (last?.status === 'running') next.activeTurnId = last.turnId; else delete next.activeTurnId;
  return next;
}
