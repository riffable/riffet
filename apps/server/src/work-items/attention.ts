import type { DatabaseSync } from 'node:sqlite';
import type { NorthStarDay, NorthStarReport, Session } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';

const ACTIVE: ReadonlySet<Session['state']> = new Set(['starting', 'running', 'cancelling']);
const STOPPED: ReadonlySet<Session['state']> = new Set(['idle', 'failed', 'interrupted']);
const DAY_MS = 86_400_000;
const MAX_DAYS = 366;
/** Returning to an idle conversation hours or days later is a new work session, not a continuous wait. */
const MAX_STOPPED_WAIT_MS = 2 * 3_600_000;
const MAX_DECISION_WAIT_MS = 8 * 3_600_000;

function mergedDuration(intervals: ReadonlyArray< readonly [number, number]>): number {
  if (!intervals.length) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let [curStart, curEnd] = sorted[0]!;
  for (let i = 1; i < sorted.length; i += 1) {
    const [nextStart, nextEnd] = sorted[i]!;
    if (nextStart <= curEnd) {
      if (nextEnd > curEnd) curEnd = nextEnd;
    } else {
      total += curEnd - curStart;
      curStart = nextStart;
      curEnd = nextEnd;
    }
  }
  total += curEnd - curStart;
  return Math.min(total, DAY_MS);
}

/**
 * When the owner was held up and for how long (docs/TASK-BOARD.md §1): a conversation waiting on an
 * approval or a question (`decision`), or stopped after a turn (`stopped`), from that moment until it
 * moves again. Written from the conversation's own state changes, inside the write that made them; a
 * conversation archived before anyone came back is dropped, since nobody was waiting on it.
 */
export class AttentionLog {
  private readonly db: DatabaseSync;

  constructor(private readonly store: Store) {
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS attention_log (
        id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER);
      CREATE INDEX IF NOT EXISTS attention_started ON attention_log(started_at);
      CREATE INDEX IF NOT EXISTS attention_open ON attention_log(session_id) WHERE ended_at IS NULL;`);
  }

  /** Starts listening; returns the way to stop. */
  start(): () => void { return this.store.onSessionState((session, from) => this.changed(session, from)); }

  private counted(session: Session): boolean {
    if (session.kind !== 'native' || session.backendId === 'chat') return false;
    try { return !this.store.getProject(session.projectId).system; } catch { return false; }
  }

  private open(sessionId: string, kind: 'decision' | 'stopped', at: number): void {
    if (this.db.prepare('SELECT 1 AS found FROM attention_log WHERE session_id=? AND kind=? AND ended_at IS NULL').get(sessionId, kind)) return;
    this.db.prepare('INSERT INTO attention_log(session_id,kind,started_at) VALUES(?,?,?)').run(sessionId, kind, at);
  }
  private close(sessionId: string, kind: 'decision' | 'stopped', at: number): void {
    const maxWait = kind === 'decision' ? MAX_DECISION_WAIT_MS : MAX_STOPPED_WAIT_MS;
    this.db.prepare('DELETE FROM attention_log WHERE session_id=? AND kind=? AND ended_at IS NULL AND ?-started_at>?').run(sessionId, kind, at, maxWait);
    this.db.prepare('UPDATE attention_log SET ended_at=? WHERE session_id=? AND kind=? AND ended_at IS NULL').run(at, sessionId, kind);
  }

  /** Ends the waits still open on [sessionIds] at [at]: the owner has dealt with what they were waiting for. */
  settle(sessionIds: readonly string[], at: number): void {
    const close = this.db.prepare('UPDATE attention_log SET ended_at=? WHERE session_id=? AND ended_at IS NULL');
    for (const id of sessionIds) close.run(at, id);
  }

  private changed(session: Session, from: Session['state']): void {
    const to = session.state;
    if (to === 'archived') { this.db.prepare('DELETE FROM attention_log WHERE session_id=? AND ended_at IS NULL').run(session.id); return; }
    if (!this.counted(session)) return;
    const at = Date.parse(session.updatedAt) || Date.now();
    if (from === 'waiting') this.close(session.id, 'decision', at);
    if (ACTIVE.has(to)) this.close(session.id, 'stopped', at);
    if (to === 'waiting') this.open(session.id, 'decision', at);
    else if (STOPPED.has(to) && (ACTIVE.has(from) || from === 'waiting')) this.open(session.id, 'stopped', at);
  }

  /**
   * Each day of [from, to) in `timeZone`: how many things reached the owner (approvals and questions
   * a conversation waited on, `task_ask` questions, work submitted for review) and how long the
   * conversations stood waiting on them, counted on the day the wait began. A wait still open is
   * left out until it ends. Days before anything was recorded have no numbers.
   */
  report(from: number, to: number, timeZone: string): NorthStarReport {
    const span = Math.min(to - from, MAX_DAYS * DAY_MS);
    const start = to - span;
    const dayOf = dayKey(timeZone);
    const days = new Map<string, NorthStarDay>();
    const day = (at: number) => {
      const key = dayOf(at);
      let entry = days.get(key);
      if (!entry) days.set(key, entry = { date: key, decisions: 0, questions: 0, reviews: 0, waitMs: 0 });
      return entry;
    };
    for (let at = start; at < to; at += DAY_MS) day(at);
    day(to - 1);
    const waits = this.db.prepare('SELECT kind, started_at, ended_at FROM attention_log WHERE started_at>=? AND started_at<?').all(start, to) as Array<{ kind: string; started_at: number; ended_at: number | null }>;
    const intervalsByDay = new Map<string, Array<readonly [number, number]>>();
    for (const row of waits) {
      const entry = day(row.started_at);
      if (row.kind === 'decision') entry.decisions += 1;
      if (row.ended_at !== null) {
        const duration = row.ended_at - row.started_at;
        const maxWait = row.kind === 'decision' ? MAX_DECISION_WAIT_MS : MAX_STOPPED_WAIT_MS;
        if (duration > 0 && duration <= maxWait) {
          let list = intervalsByDay.get(entry.date);
          if (!list) intervalsByDay.set(entry.date, list = []);
          list.push([row.started_at, row.ended_at]);
        }
      }
    }
    for (const [date, list] of intervalsByDay) {
      const entry = days.get(date);
      if (entry) entry.waitMs = mergedDuration(list);
    }
    const events = this.db.prepare(`SELECT at, json FROM work_item_events WHERE at>=? AND at<? AND (json LIKE '%"kind":"question"%' OR json LIKE '%"kind":"status"%')`)
      .all(new Date(start).toISOString(), new Date(to).toISOString()) as Array<{ at: string; json: string }>;
    for (const row of events) {
      const event = JSON.parse(row.json) as { kind: string; to?: string };
      if (event.kind === 'question') day(Date.parse(row.at)).questions += 1;
      else if (event.kind === 'status' && event.to === 'review') day(Date.parse(row.at)).reviews += 1;
    }
    const first = this.db.prepare('SELECT MIN(started_at) AS at FROM attention_log').get() as { at: number | null };
    return {
      ...(first.at !== null ? { since: new Date(first.at).toISOString() } : {}),
      days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }
}

function dayKey(timeZone: string): (at: number) => string {
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { format = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
  return (at) => format.format(new Date(at));
}
