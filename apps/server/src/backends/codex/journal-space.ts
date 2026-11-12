import type { NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { DatabaseSync } from 'node:sqlite';
import type { NativeBackendHost } from '../types.js';
import { Journal, scratchKeyOf } from '../../journal/journal.js';
import { NativeEventLog } from '../../journal/native-log.js';

/**
 * Where a Codex/TraeX thread's events get their numbers: the session's journal.
 *
 * A thread's log is complete once its history has been ingested; until then (the first open of a
 * long thread, or a catch-up after the service missed a stretch) the runtime serves a tail window
 * from a scratch log of its own, with its own generation, while a background import fills the real
 * one in order. Both are rows in the same table, so numbering is never kept in process memory and a
 * restart hands out the same numbers.
 */

/** How far the journal has read the thread. Stored as the log's `ingest_cursor`. */
export interface CodexIngestState {
  v: 1;
  /** The provider thread this log was written from; a log never carries another thread's rows. */
  threadId?: string;
  phase: 'ready' | 'importing';
  /** The last turn whose end has been ingested; the import resumes after it. */
  settled?: string;
  /** The turn that was still running when the state was written, if any. */
  open?: string;
  /** Turns ingested so far. */
  turns?: number;
}

export type SpaceMode = 'unbound' | 'real' | 'scratch';

/** The ingest state recorded for a session's log, read without creating, rebuilding or dropping anything. */
export function readIngestState(journal: Journal, sessionId: string): CodexIngestState | undefined {
  const raw = journal.peek(sessionId)?.ingestCursor;
  if (!raw) return undefined;
  try { const parsed = JSON.parse(raw) as CodexIngestState; return parsed?.v === 1 ? parsed : undefined; } catch { return undefined; }
}

/** The main lane's scratch window; the lane writer (`journal/ingest.ts`) keeps its windows under the same key. */
export const scratchKey = (sessionId: string) => scratchKeyOf(sessionId);

/**
 * A read-only space numbers events in memory and never touches the journal: once sync v3 reads the
 * thread into the journal itself (`transcript-source.ts`) the runtime is no longer its writer, and
 * what v2 clients are served comes from that log (`journal-view.ts`).
 */
export class CodexJournalSpace {
  private mode: SpaceMode = 'unbound';
  private log: NativeEventLog | undefined;
  /** Numbers handed out before the log is chosen. They never reach a client and are dropped at binding. */
  private provisional = new Map<string, number>();
  private provisionalLast = 0;
  initialized = false;

  constructor(readonly journal: Journal, readonly sessionId: string, private threadId?: string, readonly readOnly = false) {
    if (readOnly) return;
    const state = this.ingestState();
    // The session now follows another thread (a fork, a replaced chat): its rows would be a different
    // conversation's, so the log starts over under a new generation.
    if (state && threadId && state.threadId !== threadId) {
      this.journal.rebuild(sessionId);
      this.journal.drop(scratchKey(sessionId));
    } else if (state?.phase === 'ready') {
      this.mode = 'real';
      this.log = new NativeEventLog(journal, sessionId);
      this.initialized = true;
    }
  }

  get bound(): SpaceMode { return this.mode; }
  /** True while the real log holds the whole thread and serves it. */
  get ready(): boolean { return !this.readOnly && this.mode === 'real' && this.ingestState()?.phase === 'ready'; }

  ingestState(): CodexIngestState | undefined { return readIngestState(this.journal, this.sessionId); }

  /** Records ingest progress; call inside the same `batch` as the rows it covers. */
  writeState(state: Omit<CodexIngestState, 'v' | 'threadId'>): void {
    if (this.readOnly) return;
    const next = JSON.stringify({ v: 1, ...(this.threadId ? { threadId: this.threadId } : {}), ...state } satisfies CodexIngestState);
    if (this.journal.peek(this.sessionId)?.ingestCursor !== next) this.journal.setCursor(this.sessionId, next);
  }

  /** A thread created after the runtime was built (a new conversation) names the log's thread. */
  adoptThread(threadId: string): void { this.threadId = threadId; }

  /** Chooses the log. A scratch log is always started fresh: it is only ever a window onto a thread being imported. */
  bind(mode: 'real' | 'scratch'): void {
    if (this.readOnly) { this.mode = mode; return; }
    if (mode === 'scratch' && this.mode !== 'scratch') this.journal.drop(scratchKey(this.sessionId));
    this.mode = mode;
    this.log = new NativeEventLog(this.journal, this.sessionId, mode === 'real' ? this.sessionId : scratchKey(this.sessionId));
    this.provisional.clear();
    this.provisionalLast = 0;
  }

  /** From here on numbers are final and the runtime may publish; before it, a first read is still seeding them. */
  markInitialized(): void { this.initialized = true; }

  unbind(): void {
    this.mode = 'unbound';
    this.log = undefined;
    this.initialized = false;
  }

  /** Discards the scratch window once the real log serves, and moves to it. */
  promote(): void {
    if (this.readOnly) { this.mode = 'real'; return; }
    this.journal.drop(scratchKey(this.sessionId));
    this.mode = 'real';
    this.log = new NativeEventLog(this.journal, this.sessionId);
    // The import is done: drafts it superseded and the scratch window's blobs are garbage now.
    try { this.journal.maintain(); } catch { /* housekeeping; the periodic sweep tries again */ }
  }

  /** The generation clients see for this space; a scratch log has one of its own. */
  get generation(): string { return this.log?.generation ?? 'pending'; }

  batch<T>(fn: () => T): T { return this.log ? this.log.batch(fn) : this.journal.tx(fn); }

  seqOf(nativeId: string): number | undefined { return this.log ? this.log.seqOf(nativeId) : this.provisional.get(nativeId); }

  assign(event: NativeWorkbenchEvent, stable = false): number {
    if (this.log) return this.log.assign(event, stable);
    let sequence = this.provisional.get(event.nativeId);
    if (sequence === undefined) { sequence = ++this.provisionalLast; this.provisional.set(event.nativeId, sequence); }
    return sequence;
  }

  /** The row number of the entity's latest version in the log; none while the space still numbers provisionally. */
  latestSeqOf(nativeId: string): number | undefined { return this.log?.latestSeqOf(nativeId); }

  /** {@link assign} with the row's own number: a later version of an entity is announced live under it. */
  assignRow(event: NativeWorkbenchEvent): { identity: number; seq: number; written: boolean; created: boolean } {
    if (this.log) return this.log.assignRow(event);
    const known = this.provisional.get(event.nativeId);
    const seq = ++this.provisionalLast;
    if (known === undefined) this.provisional.set(event.nativeId, seq);
    return { identity: known ?? seq, seq, written: true, created: known === undefined };
  }

  /** Writes one chunk of a streaming message under the id its committed item will have; returns the chunk's own number. */
  assignDraft(finalId: string, event: NativeWorkbenchEvent): number { return this.log ? this.log.assignDraft(finalId, event) : ++this.provisionalLast; }

  /** The number the next row will get; a draft's chunk is numbered before it is built. */
  peekNext(): number { return this.log ? this.log.peekNext() : this.provisionalLast + 1; }

  retire(nativeId: string): void { if (this.log) this.log.retire(nativeId); else this.provisional.delete(nativeId); }

  meta(kind: `meta.${string}`, nativeId: string, turnId: string | undefined, at: string | undefined, payload: Record<string, unknown>): void {
    this.log?.meta(kind, nativeId, turnId, at, payload);
  }

  tail(limit: number): NativeWorkbenchEvent[] { return this.log?.tail(limit) ?? []; }
  before(identity: number, limit: number): NativeWorkbenchEvent[] { return this.log?.before(identity, limit) ?? []; }
  hasOlder(identity: number): boolean { return this.log?.hasOlder(identity) ?? false; }
}


/**
 * Hosts without a store (unit tests, tools) get a private in-memory journal, shared by every
 * runtime of that host, so numbering still survives a rebuilt runtime. A real host passes the
 * store's journal and nothing here is process-local.
 */
const privateJournals = new WeakMap<object, Journal>();

export function journalOf(host: NativeBackendHost): Journal {
  if (host.journal) return host.journal;
  let journal = privateJournals.get(host);
  if (!journal) privateJournals.set(host, journal = new Journal(new DatabaseSync(':memory:')));
  return journal;
}
