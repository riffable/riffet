import type { NativeWorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import type { SyncLane } from '../../../../packages/contracts/src/sync.js';
import { servingKey, turnMetaId, type TurnEndStatus } from './ingest.js';
import { isHiddenKind, laneOfKey, TOMBSTONE_KIND, type Journal, type JournalAppend, type JournalRow } from './journal.js';

/*
 * The journal read back as native events (docs/SYNC-V3.md, 接线), for the in-process readers of a
 * conversation that read the v2 stream before: the dispatcher's receipts, the search index, statistics.
 * Each reads what the log serving a lane gained — the lane's scratch window while one is open, which is
 * what clients are shown, not the history imported beneath it — a turn of the event loop after it was
 * committed, in bounded steps, so a long import never reads its rows back in one go.
 */

export interface TurnMark { edge: 'started' | 'ended' | 'reopened'; turnId: string; at: string; seq: number; revision: number; runId?: string; status?: TurnEndStatus; error?: string }

/** What one log gained, in log order: every new version of an entity (numbered by its first row, as v2 did) and the turn marks. */
export interface FeedBatch {
  sessionId: string;
  lane: SyncLane;
  items: Array<{ event: NativeWorkbenchEvent } | { mark: TurnMark }>;
}

/** Rows read back per turn of the event loop, across every log. */
const STEP_ROWS = 500;
const TURN_STARTED = 'meta.turn_started';
const TURN_ENDED = 'meta.turn_ended';

const str = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;

export class JournalFeed {
  private readonly listeners = new Set<{ wants(sessionId: string, lane: SyncLane): boolean; hear(batch: FeedBatch): void }>();
  /** Per log, the first and last seq still to read. */
  private readonly pending = new Map<string, { from: number; to: number }>();
  private immediate: ReturnType<typeof setImmediate> | undefined;
  private readonly off: () => void;

  constructor(private readonly journal: Journal) {
    this.off = journal.onAppend(change => this.note(change));
  }

  /** Hears what the logs serving the lanes `wants` names gain. Listener errors are the listener's own. */
  subscribe(wants: (sessionId: string, lane: SyncLane) => boolean, hear: (batch: FeedBatch) => void): () => void {
    const listener = { wants, hear };
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The newest `rows` rows of the log serving the lane, read the same way: what a reader that starts now catches up from. */
  recent(sessionId: string, lane: SyncLane, rows: number): FeedBatch {
    const { key } = servingKey(this.journal, sessionId, lane);
    const last = this.journal.peek(key)?.lastSeq ?? 0;
    return { sessionId, lane, items: this.read(key, sessionId, Math.max(0, last - rows), last) };
  }

  /** The current outcome even when its revision is beyond this event-loop step's feed window. */
  turnEnd(sessionId: string, turnId: string): TurnMark | undefined {
    const { key } = servingKey(this.journal, sessionId, 'main');
    const row = this.journal.entity(key, turnMetaId(turnId, 'ended'));
    return row ? markOf(row) : undefined;
  }

  /** An explicit retraction survives the newer end which replaced it, including across restart. */
  turnReopened(sessionId: string, turnId: string): TurnMark | undefined {
    const { key } = servingKey(this.journal, sessionId, 'main');
    const row = this.journal.retraction(key, turnMetaId(turnId, 'ended'));
    return row ? markOf(row) : undefined;
  }

  /** Resolves once what the logs have gained so far has reached the listeners. */
  async delivered(): Promise<void> {
    while (this.pending.size) await new Promise(resolve => setImmediate(resolve));
  }

  close(): void {
    this.off();
    if (this.immediate) clearImmediate(this.immediate);
    this.pending.clear();
    this.listeners.clear();
  }

  private note(change: JournalAppend): void {
    if (change.reset || change.toSeq < change.fromSeq) return;
    if (![...this.listeners].some(listener => listener.wants(change.sessionId, change.lane))) return;
    const key = servingKey(this.journal, change.sessionId, change.lane);
    // History imported beneath an open scratch window is not news to anyone.
    if (key.scratch !== change.scratch) return;
    const known = this.pending.get(key.key);
    this.pending.set(key.key, known ? { from: Math.min(known.from, change.fromSeq), to: Math.max(known.to, change.toSeq) } : { from: change.fromSeq, to: change.toSeq });
    this.immediate ??= setImmediate(() => this.flush());
  }

  private flush(): void {
    this.immediate = undefined;
    let budget = STEP_ROWS;
    for (const [key, range] of [...this.pending]) {
      if (budget <= 0) break;
      const where = laneOfKey(key);
      const from = range.from, to = Math.min(range.to, from + budget - 1);
      if (to >= range.to) this.pending.delete(key); else range.from = to + 1;
      budget -= to - from + 1;
      if (!where) continue;
      let items: FeedBatch['items'];
      try { items = this.read(key, where.sessionId, from - 1, to); }
      catch (error) { console.warn(`[journal] reading ${key} back failed:`, error); continue; }
      if (!items.length) continue;
      const batch: FeedBatch = { sessionId: where.sessionId, lane: where.lane, items };
      for (const listener of this.listeners) {
        if (!listener.wants(batch.sessionId, batch.lane)) continue;
        try { listener.hear(batch); } catch { /* one reader's failure is its own */ }
      }
    }
    if (this.pending.size) this.immediate = setImmediate(() => this.flush());
  }

  /** Rows `after+1 … to` of `key`. */
  private read(key: string, sessionId: string, after: number, to: number): FeedBatch['items'] {
    if (to <= after) return [];
    const items: FeedBatch['items'] = [];
    for (const row of this.journal.range(key, after, to - after)) {
      if (row.kind === TURN_STARTED || row.kind === TURN_ENDED || row.kind === TOMBSTONE_KIND) {
        // The feed can lag several revisions (including across a restart): only the current outcome is authoritative.
        if (this.journal.locate(key, row.nativeId)?.seq === row.seq) {
          const mark = markOf(row);
          if (mark) items.push({ mark });
        }
        continue;
      }
      if (isHiddenKind(row.kind)) continue;
      // Superseded revisions stripped by compaction leave an empty envelope; skip them.
      if (!row.payload || typeof (row.payload as { type?: unknown }).type !== 'string') continue;
      const identity = row.rev === 1 ? row.seq : this.journal.locate(key, row.nativeId)?.identity ?? row.seq;
      items.push({ event: { ...(row.payload as Omit<NativeWorkbenchEvent, 'sequence' | 'sessionId'>), sessionId, sequence: identity } as NativeWorkbenchEvent });
    }
    return items;
  }
}

/** The events of `items`, each entity once: its last version, where that version is. */
export function latestEvents(items: FeedBatch['items']): NativeWorkbenchEvent[] {
  const events = items.flatMap(item => 'event' in item ? [item.event] : []);
  const last = new Map(events.map((event, index) => [event.nativeId, index]));
  return events.filter((event, index) => last.get(event.nativeId) === index);
}

function markOf(row: JournalRow): TurnMark | undefined {
  const payload = row.payload as { turnId?: unknown; runId?: unknown; status?: unknown; error?: unknown } | undefined;
  const turnId = str(payload?.turnId) ?? row.turnId;
  if (!turnId) return undefined;
  const base = { turnId, at: row.at, seq: row.seq, revision: row.rev };
  if (row.kind === TOMBSTONE_KIND) return row.turnId === turnId && row.nativeId === turnMetaId(turnId, 'ended') ? { ...base, edge: 'reopened' } : undefined;
  if (row.kind === TURN_STARTED) return { ...base, edge: 'started', ...(str(payload?.runId) ? { runId: str(payload?.runId) } : {}) };
  if (row.kind !== TURN_ENDED) return undefined;
  const status = payload?.status;
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'interrupted') return undefined;
  return { ...base, edge: 'ended', status, ...(str(payload?.error) ? { error: str(payload?.error) } : {}) };
}
