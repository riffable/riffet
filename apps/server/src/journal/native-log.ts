import type { NativeWorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import { DRAFT_KIND, Journal, type AppendedRow, type JournalEntity, type JournalEventInput } from './journal.js';

/** What a stored row holds: the event without the parts that belong to the log itself. */
type StoredEvent = Omit<NativeWorkbenchEvent, 'sequence' | 'sessionId' | 'raw'>;

function toStored(event: NativeWorkbenchEvent): StoredEvent {
  const { sequence: _sequence, sessionId: _sessionId, raw: _raw, ...stored } = event;
  return stored;
}

/** The row of one event: numbered by the log, never by the event, and without the provider's `raw` record. */
export function eventInput(event: NativeWorkbenchEvent): JournalEventInput {
  return {
    kind: event.type, nativeId: event.nativeId, ...(event.nativeTurnId ? { turnId: event.nativeTurnId } : {}), at: event.createdAt, payload: toStored(event),
    // Re-reading an item must not look like a new version of it just because the read happened later.
    contentKey: { ...toStored(event), createdAt: undefined },
  };
}

/** The row of one streamed chunk, under the id its committed event will have. */
export function draftInput(finalId: string, event: NativeWorkbenchEvent): JournalEventInput {
  return { kind: DRAFT_KIND, nativeId: finalId, ...(event.nativeTurnId ? { turnId: event.nativeTurnId } : {}), at: event.createdAt, payload: toStored(event) };
}

/**
 * One session's transcript as native events over a {@link Journal} log: the surface a backend adapter
 * writes through, whatever it reads from.
 *
 * `sequence` of an event is the journal seq of the first row of its `nativeId`, so an entity keeps its
 * place however often it is updated; an update is a new row (version), never an edit. The `raw`
 * provider record is the adapter's own business and is not logged.
 */
export class NativeEventLog {
  /** nativeId -> identity, so settled events are not looked up again on every read. */
  private readonly identities = new Map<string, number>();

  /** `key` is the journal session the rows go to (usually the session id); `sessionId` stamps the events read back. */
  constructor(readonly journal: Journal, readonly sessionId: string, readonly key = sessionId) {}

  get generation(): string { return this.journal.head(this.key).generation; }

  /** The number the next row will get. */
  peekNext(): number { return this.journal.head(this.key).lastSeq + 1; }

  /** Runs `fn` as one transaction; if it fails nothing it wrote exists, so what was remembered about those rows goes too. */
  batch<T>(fn: () => T): T {
    try { return this.journal.tx(fn); }
    catch (error) { this.identities.clear(); throw error; }
  }

  seqOf(nativeId: string): number | undefined {
    const cached = this.identities.get(nativeId);
    if (cached !== undefined) return cached;
    const found = this.journal.locate(this.key, nativeId);
    if (found) this.remember(nativeId, found.identity);
    return found?.identity;
  }

  /** The row of the entity's latest version (equal to its identity until it is updated). */
  latestSeqOf(nativeId: string): number | undefined { return this.journal.locate(this.key, nativeId)?.seq; }

  private remember(nativeId: string, identity: number): void {
    this.identities.set(nativeId, identity);
    if (this.identities.size > 20_000) this.identities.delete(this.identities.keys().next().value!);
  }

  /**
   * Writes an event: a new entity gets the next number, a changed one a new version under the number it
   * already has, an identical one nothing. `stable` marks an event that cannot have changed, so a known
   * one is not even looked at. Returns the entity's number.
   */
  assign(event: NativeWorkbenchEvent, stable = false): number {
    if (stable) { const known = this.identities.get(event.nativeId); if (known !== undefined) return known; }
    return this.assignRow(event).identity;
  }

  /**
   * {@link assign}, but with the row written: `seq` is the number of the row that holds this version (a
   * later version of an entity has a larger one than its `identity`), `written` false when nothing changed.
   */
  assignRow(event: NativeWorkbenchEvent): AppendedRow {
    const [row] = this.journal.append(this.key, [eventInput(event)]).rows;
    this.remember(event.nativeId, row!.identity);
    return row!;
  }

  /** One streamed chunk, logged under the id its committed event will have; returns the chunk's own number. */
  assignDraft(finalId: string, event: NativeWorkbenchEvent): number {
    const [row] = this.journal.append(this.key, [draftInput(finalId, event)]).rows;
    this.remember(finalId, row!.identity);
    return row!.seq;
  }

  /** Takes an entity out of the transcript (a provisional row its settled copy replaced). */
  retire(nativeId: string): void {
    const found = this.journal.locate(this.key, nativeId);
    if (!found || found.kind === 'tombstone') return;
    this.journal.append(this.key, [{ kind: 'tombstone', nativeId, payload: {} }]);
    this.identities.delete(nativeId);
  }

  /** A synthetic row (turn start/end, run terminal state) in the same numbering that is not part of the transcript. */
  meta(kind: `meta.${string}`, nativeId: string, turnId: string | undefined, at: string | undefined, payload: Record<string, unknown>): void {
    this.journal.append(this.key, [{ kind, nativeId, ...(turnId ? { turnId } : {}), ...(at ? { at } : {}), payload }]);
  }

  private toEvent(entity: JournalEntity): NativeWorkbenchEvent {
    return { ...(entity.payload as StoredEvent), sessionId: this.sessionId, sequence: entity.identity } as NativeWorkbenchEvent;
  }

  /** The newest `limit` visible events, in order. */
  tail(limit: number): NativeWorkbenchEvent[] { return this.journal.tail(this.key, limit).map(entity => this.toEvent(entity)); }

  /** The `limit` visible events just before `identity`, in order. */
  before(identity: number, limit: number): NativeWorkbenchEvent[] { return this.journal.entitiesBefore(this.key, identity, limit).map(entity => this.toEvent(entity)); }

  hasOlder(identity: number): boolean { return this.journal.hasEntitiesBefore(this.key, identity); }
}
