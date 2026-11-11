import type { NativeWorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';
import { extractIndexable } from './messages.js';

/** A streamed answer changes on every chunk; its row is written at most this often. */
const THROTTLE_MS = 2_000;
/** A conversation that gained nothing for this long drops what it held. */
const IDLE_MS = 5 * 60_000;
/** Enough of the live tail to join a long streamed answer's chunks; older events were indexed already. */
const MAX_BUFFERED_EVENTS = 4_000;

interface Pending {
  events: NativeWorkbenchEvent[];
  /** Message ids changed since the last write. */
  touched: Set<string>;
  ranAt: number;
  timer?: NodeJS.Timeout;
  idle?: NodeJS.Timeout;
}

function messageId(event: NativeWorkbenchEvent): string {
  return typeof event.nativeId === 'string' && event.nativeId ? event.nativeId : `${event.sequence}`;
}

/**
 * The newest [limit] events. A message whose chunks straddle the cut is left out whole rather than
 * kept as a fragment that would replace its complete text in the index.
 */
function newest(events: readonly NativeWorkbenchEvent[], limit = MAX_BUFFERED_EVENTS): NativeWorkbenchEvent[] {
  if (events.length <= limit) return [...events];
  let start = events.length - limit;
  const cut = messageId(events[start - 1]!);
  while (start < events.length && messageId(events[start]!) === cut) start += 1;
  return events.slice(start);
}

/**
 * Message text is indexed as the session journal gains it (`journal/feed.ts`). It is never fetched to
 * build the index, because reading an arbitrary conversation can start an agent, and a search must not.
 *
 * Each entity replaces what was held under its id, so a streamed answer is stored as the message the
 * reader sees, not one fragment at a time. Writes are throttled per conversation with a trailing
 * edge: the last change always lands, at most one throttle later.
 */
export class LiveTranscriptIndex {
  private readonly sessions = new Map<string, Pending>();

  constructor(private readonly options: {
    store: Pick<Store, 'indexMessages'>;
    /** Called with what was just indexed; failures are the callee's own. */
    onIndexed?: (sessionId: string, events: readonly NativeWorkbenchEvent[]) => void;
    throttleMs?: number;
  }) {}

  /**
   * Entities read back from the session journal (sync v3, `journal/feed.ts`): each event is the whole of its
   * entity as it now stands, so it replaces what was held under its id instead of joining it as a chunk.
   */
  observeEntities(sessionId: string, events: readonly NativeWorkbenchEvent[]): void {
    if (!events.length) return;
    let pending = this.sessions.get(sessionId);
    if (!pending) this.sessions.set(sessionId, pending = { events: [], ranAt: 0, touched: new Set() });
    const ids = new Set(events.map(messageId));
    pending.events = [...pending.events.filter(event => !ids.has(messageId(event))), ...events];
    if (pending.events.length > MAX_BUFFERED_EVENTS) pending.events = newest(pending.events);
    for (const id of ids) pending.touched.add(id);
    this.schedule(sessionId, pending);
  }

  private schedule(sessionId: string, pending: Pending): void {
    if (pending.idle) clearTimeout(pending.idle);
    pending.idle = setTimeout(() => {
      if (this.sessions.get(sessionId) !== pending) return;
      if (pending.timer) clearTimeout(pending.timer);
      this.run(sessionId, pending);
      this.sessions.delete(sessionId);
    }, IDLE_MS);
    pending.idle.unref();
    if (pending.timer) return;
    const wait = pending.ranAt + (this.options.throttleMs ?? THROTTLE_MS) - Date.now();
    if (wait <= 0) { this.run(sessionId, pending); return; }
    pending.timer = setTimeout(() => { pending.timer = undefined; this.run(sessionId, pending); }, wait);
    pending.timer.unref();
  }

  private run(sessionId: string, pending: Pending): void {
    const touched = pending.touched;
    pending.ranAt = Date.now();
    if (!touched.size) return;
    pending.touched = new Set();
    try {
      // A message's chunks share its id, so keeping only touched ids keeps every chunk of each.
      const events = pending.events.filter(event => touched.has(messageId(event)));
      this.options.store.indexMessages(extractIndexable(sessionId, events));
    } catch { /* search must never break a stream */ }
    try { this.options.onIndexed?.(sessionId, pending.events); } catch { /* best effort */ }
  }

  /** A deleted conversation: what is still buffered for it is dropped, not written (nor mirrored) later. */
  forget(sessionId: string): void {
    const pending = this.sessions.get(sessionId);
    if (!pending) return;
    if (pending.idle) clearTimeout(pending.idle);
    if (pending.timer) clearTimeout(pending.timer);
    this.sessions.delete(sessionId);
  }

  /** Writes what is still pending, then stops; called before the store closes. */
  close(): void {
    for (const [sessionId, pending] of this.sessions) {
      if (pending.idle) clearTimeout(pending.idle);
      if (pending.timer) { clearTimeout(pending.timer); this.run(sessionId, pending); }
    }
    this.sessions.clear();
  }
}
