import type { Journal } from '../journal/journal.js';
import { hasTurnEnded, JournalLaneWriter, pullLane, type TranscriptSource, type TurnEndStatus } from '../journal/ingest.js';

/*
 * Sync v3's ingest (docs/SYNC-V3.md, 写入契约): reading a conversation's transcript into its journal
 * lanes while someone needs it current. A followed session is pulled when it is opened (a turn typed
 * into the CLI itself produces no notification), whenever its source says the native data moved, and
 * on a backoff after a failed read; one read of a session runs at a time and wakes meanwhile fold into
 * one more. A session is let go `lingerMs` after its last holder leaves.
 */

export interface TranscriptIngestDeps {
  journal: Journal;
  /** The session's transcript source, or undefined when its backend has none. */
  source(sessionId: string): TranscriptSource | undefined;
  /** How long a session stays followed after its last holder leaves; 5 minutes by default. */
  lingerMs?: number;
}

interface Followed {
  /** Replaced when the session's backend is registered again (`reopen`). */
  source: TranscriptSource;
  readonly abort: AbortController;
  holders: number;
  /** What runs and what waits for this session, in order. */
  tail: Promise<void>;
  /** A pull is waiting in `tail` and will read whatever arrives before it starts. */
  pullQueued: boolean;
  failures: number;
  /** The read the latest `follow` started; settles once it caught up or failed. */
  reading?: Promise<void>;
  /** Why the last read failed, until one succeeds. */
  failure?: unknown;
  unwatch?: () => void;
  linger?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
}

const LINGER_MS = 5 * 60_000;
const RETRY_MS = [2_000, 10_000, 60_000] as const;

export class TranscriptIngest {
  /** One writer per session for the life of the process: its ledgers hold the lanes' live activities. */
  private readonly writers = new Map<string, JournalLaneWriter>();
  private readonly followed = new Map<string, Followed>();
  private readonly errorListeners = new Set<(sessionId: string, error: unknown) => void>();
  private closed = false;

  constructor(private readonly deps: TranscriptIngestDeps) {}

  /** The session's writer: the one every write to its lanes goes through, including the control path's. */
  writer(sessionId: string): JournalLaneWriter {
    let writer = this.writers.get(sessionId);
    if (!writer) this.writers.set(sessionId, writer = JournalLaneWriter.open(this.deps.journal, sessionId));
    return writer;
  }

  /** Keeps the session current until the returned release: it is read now and on every wake. */
  follow(sessionId: string): () => void {
    const entry = this.entry(sessionId);
    if (!entry) return () => undefined;
    entry.holders += 1;
    if (entry.linger) { clearTimeout(entry.linger); entry.linger = undefined; }
    if (!entry.unwatch && entry.source.watch) {
      try { entry.unwatch = entry.source.watch(this.writer(sessionId), () => this.wake(sessionId)); }
      catch (error) { this.report(sessionId, error); }
    }
    entry.reading = this.pull(sessionId, entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.holders -= 1;
      if (!entry.holders) this.linger(sessionId, entry);
    };
  }

  /**
   * The backends of the matching sessions were registered again (a plugin reloaded or updated): a session
   * still followed drops the source the earlier activation gave it, which reads nothing any more, and is
   * read through the current one from now on. Holders and the writer stay as they were.
   */
  reopen(match: (sessionId: string) => boolean): void {
    for (const [sessionId, entry] of [...this.followed]) {
      if (entry.abort.signal.aborted || !match(sessionId)) continue;
      let source: TranscriptSource | undefined;
      try { source = this.deps.source(sessionId); }
      catch (error) { this.report(sessionId, error); continue; }
      if (!source || source === entry.source) continue;
      try { entry.unwatch?.(); } catch { /* the old source is let go either way */ }
      entry.unwatch = undefined;
      // A read in flight finishes on the old source, which reads nothing; the next one reads this.
      entry.source = source;
      if (entry.holders && source.watch) {
        try { entry.unwatch = source.watch(this.writer(sessionId), () => this.wake(sessionId)); }
        catch (error) { this.report(sessionId, error); }
      }
      entry.reading = this.pull(sessionId, entry);
    }
  }

  /** Settles once the read the latest `follow` started is done, caught up or failed; undefined for a session without a source. */
  read(sessionId: string): Promise<void> | undefined {
    return this.followed.get(sessionId)?.reading;
  }

  /** Reads the session again soon; a no-op for a session nobody follows. */
  wake(sessionId: string): void {
    const entry = this.followed.get(sessionId);
    if (entry) void this.pull(sessionId, entry);
  }

  /**
   * Reads everything already on disk into the log that serves (G6), after any read in flight; for a
   * turn ended from outside the transcript, before its `turnEnded`. Never rejects: a failure is
   * reported as a read's is.
   */
  drain(sessionId: string): Promise<void> {
    const entry = this.entry(sessionId);
    if (!entry) return Promise.resolve();
    if (!entry.holders && !entry.linger) this.linger(sessionId, entry);
    return this.enqueue(sessionId, entry, () => entry.source.drain(this.writer(sessionId)));
  }

  /**
   * Runs `task` with the session's source and writer between its reads: after the read in flight, before
   * the next. The control path's way to write what needs the source (a turn the CLI ended without
   * recording it). Resolves undefined for a session without a source, or when the task failed (reported
   * as a read's failure is).
   */
  control<T>(sessionId: string, task: (source: TranscriptSource, w: JournalLaneWriter) => Promise<T> | T): Promise<T | undefined> {
    const entry = this.entry(sessionId);
    if (!entry) return Promise.resolve(undefined);
    if (!entry.holders && !entry.linger) this.linger(sessionId, entry);
    let result: T | undefined;
    return this.enqueue(sessionId, entry, async () => { result = await task(entry.source, this.writer(sessionId)); }).then(() => result);
  }

  /**
   * A turn the transcript will not end (the CLI exited or crashed in it): what is on disk is read first
   * (G6), then the end goes to the log that serves, unless what was read ended it already.
   */
  endTurn(sessionId: string, turnId: string, status: TurnEndStatus, at: string, error?: string): Promise<void> {
    return this.control(sessionId, async (source, w) => {
      const target = (w.scratch ?? w) as JournalLaneWriter;
      if (source.settleTurnEnd) {
        if (await source.settleTurnEnd(w, { turnId, status, at, error }) || hasTurnEnded(this.deps.journal, target.key, turnId)) return;
      }
      await source.drain(w);
      if (!hasTurnEnded(this.deps.journal, target.key, turnId)) target.turnEnded(turnId, status, at, error);
    }).then(() => undefined);
  }

  /** Why the session's last read failed, while no read since has succeeded. */
  failure(sessionId: string): unknown {
    return this.followed.get(sessionId)?.failure;
  }

  /** Hears a session's failed reads; the session stays followed and is read again later. */
  onError(listener: (sessionId: string, error: unknown) => void): () => void {
    this.errorListeners.add(listener);
    return () => { this.errorListeners.delete(listener); };
  }

  /**
   * The conversation's runtime is about to go (closed, archived, reclaimed): what it wrote last is read now,
   * after any read in flight (G6), and then nothing reads it until someone follows it again, so no read goes
   * through a runtime that is gone or starts it again. A session nobody follows is left alone.
   */
  async retire(sessionId: string): Promise<void> {
    const entry = this.followed.get(sessionId);
    if (!entry) return;
    await this.enqueue(sessionId, entry, () => entry.source.drain(this.writer(sessionId)));
    if (this.followed.get(sessionId) === entry) this.stop(sessionId, entry);
  }

  /** A deleted conversation: nothing of it is read or kept. */
  forget(sessionId: string): void {
    const entry = this.followed.get(sessionId);
    if (entry) this.stop(sessionId, entry);
    this.writers.delete(sessionId);
  }

  close(): void {
    this.closed = true;
    for (const [sessionId, entry] of [...this.followed]) this.stop(sessionId, entry);
    this.errorListeners.clear();
  }

  // ---- internals ---------------------------------------------------------------------------

  private entry(sessionId: string): Followed | undefined {
    if (this.closed) return undefined;
    const known = this.followed.get(sessionId);
    if (known) return known;
    let source: TranscriptSource | undefined;
    try { source = this.deps.source(sessionId); }
    catch (error) { this.report(sessionId, error); return undefined; }
    if (!source) return undefined;
    const entry: Followed = { source, abort: new AbortController(), holders: 0, tail: Promise.resolve(), pullQueued: false, failures: 0 };
    this.followed.set(sessionId, entry);
    return entry;
  }

  /** One pull waits at most: a wake while one waits is read by it. */
  private pull(sessionId: string, entry: Followed): Promise<void> {
    if (entry.pullQueued) return entry.tail;
    entry.pullQueued = true;
    if (entry.retry) { clearTimeout(entry.retry); entry.retry = undefined; }
    return this.enqueue(sessionId, entry, async () => {
      entry.pullQueued = false;
      const writer = this.writer(sessionId);
      // A pull reads a bounded step; one that has not caught up goes on, a turn of the event loop later.
      while (!entry.abort.signal.aborted && !(await pullLane(entry.source, writer, entry.abort.signal)).caughtUp) await new Promise(resolve => setImmediate(resolve));
      entry.failures = 0;
      entry.failure = undefined;
    }, error => {
      entry.failure = error;
      // A source that failed is read again after a while, as long as someone follows the session.
      const delay = RETRY_MS[Math.min(entry.failures, RETRY_MS.length - 1)]!;
      entry.failures += 1;
      if (!entry.abort.signal.aborted && entry.holders && !entry.retry) {
        entry.retry = setTimeout(() => { entry.retry = undefined; void this.pull(sessionId, entry); }, delay);
        entry.retry.unref();
      }
    });
  }

  private enqueue(sessionId: string, entry: Followed, task: () => Promise<void>, failed?: (error: unknown) => void): Promise<void> {
    const run = entry.tail.then(async () => {
      if (entry.abort.signal.aborted) return;
      try { await task(); }
      catch (error) {
        if (entry.abort.signal.aborted) return;
        failed?.(error);
        this.report(sessionId, error);
      }
    });
    entry.tail = run;
    return run;
  }

  private linger(sessionId: string, entry: Followed): void {
    if (entry.linger) clearTimeout(entry.linger);
    entry.linger = setTimeout(() => {
      entry.linger = undefined;
      if (!entry.holders && this.followed.get(sessionId) === entry) this.stop(sessionId, entry);
    }, this.deps.lingerMs ?? LINGER_MS);
    entry.linger.unref();
  }

  private stop(sessionId: string, entry: Followed): void {
    if (entry.linger) clearTimeout(entry.linger);
    if (entry.retry) clearTimeout(entry.retry);
    entry.abort.abort();
    try { entry.unwatch?.(); } catch { /* the source is let go either way */ }
    if (this.followed.get(sessionId) === entry) this.followed.delete(sessionId);
  }

  private report(sessionId: string, error: unknown): void {
    console.warn(`[sync] reading the transcript of ${sessionId} failed:`, error);
    for (const listener of this.errorListeners) {
      try { listener(sessionId, error); } catch { /* a listener must not stop the others */ }
    }
  }
}
