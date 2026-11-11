import type { Store } from '../store.js';
import type { StatsLedger } from './ledger.js';
import type { UsageTranscript } from './types.js';

export interface StatsBackfillOptions {
  store: Store;
  ledger: Pick<StatsLedger, 'getCursor' | 'setCursor' | 'recordUsageBatch'>;
  /** Backends whose drivers can read usage from their own stored transcripts. */
  backendIds: () => readonly string[];
  /** `null` when the backend cannot backfill, `undefined` when the transcript is unchanged. */
  read: (sessionId: string, known?: string) => Promise<UsageTranscript | undefined | null>;
  /** Whether the event loop is already behind; the pass then stops and leaves the rest for the next round. */
  busy?: () => boolean;
  delayMs?: number;
  intervalMs?: number;
  batch?: number;
}

/**
 * Fills the ledger with turns that ran while nothing was watching (docs/STATS.md §3.2): a turn
 * finished while the server was down, or in a conversation nobody reopened since a restart.
 *
 * Each pass visits a few conversations, least recently visited first, so a large history is
 * covered over time without one long stall. A long transcript still takes a while to parse, so the
 * pass yields between conversations and gives up its turn while the loop is lagging: requests,
 * hooks and launches come first. Drivers only read files, never start an agent. An
 * unchanged transcript is skipped by its generation; a failed read keeps the old generation and
 * moves to the back of the queue, so it is retried on a later round.
 */
export class StatsBackfill {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<number> | undefined;
  private closed = false;

  constructor(private readonly options: StatsBackfillOptions) {}

  start(): void {
    if (this.closed || this.timer) return;
    this.schedule(this.options.delayMs ?? 30_000);
  }

  /** One pass; resolves to the number of usage rows written. Concurrent calls share the pass. */
  runOnce(): Promise<number> {
    this.running ??= this.pass().finally(() => { this.running = undefined; });
    return this.running;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce().catch(() => 0).finally(() => { if (!this.closed) this.schedule(this.options.intervalMs ?? 5 * 60_000); });
    }, delay);
    this.timer.unref?.();
  }

  private candidates(): string[] {
    const backends = [...this.options.backendIds()];
    if (!backends.length) return [];
    const rows = this.options.store.db.prepare(`SELECT s.id FROM sessions s LEFT JOIN stats_cursor c ON c.session_id=s.id
      WHERE json_extract(s.json,'$.kind')='native' AND json_extract(s.json,'$.nativeSessionId') IS NOT NULL
        AND json_extract(s.json,'$.backendId') IN (${backends.map(() => '?').join(',')})
      ORDER BY c.updated_at IS NOT NULL, c.updated_at, json_extract(s.json,'$.updatedAt') DESC LIMIT ?`)
      .all(...backends, this.options.batch ?? 20) as Array<{ id: string }>;
    return rows.map(row => row.id);
  }

  private async pass(): Promise<number> {
    let written = 0;
    for (const sessionId of this.candidates()) {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (this.closed || this.options.busy?.()) break;
      const known = this.options.ledger.getCursor(sessionId)?.generation;
      try {
        const transcript = await this.options.read(sessionId, known);
        if (this.closed) break;
        if (transcript === null) this.options.ledger.setCursor(sessionId, { generation: 'unsupported' });
        else if (transcript === undefined) this.options.ledger.setCursor(sessionId, { ...(known ? { generation: known } : {}) });
        else {
          written += this.options.ledger.recordUsageBatch(sessionId, transcript.entries, 'backfill');
          this.options.ledger.setCursor(sessionId, { generation: transcript.generation });
        }
      } catch {
        this.options.ledger.setCursor(sessionId, { ...(known ? { generation: known } : {}) });
      }
    }
    return written;
  }
}
