import type { TimelineRow } from '@contracts';
import type { LaneHeld } from './lane';

/*
 * The main lane of recently opened conversations, kept across reloads (docs/SYNC-V3.md, 预算: the
 * window itself, at most 8 sessions, least recently used out). A cold start paints the copy and its
 * stream resumes from its generation and seq, so reopening a conversation costs only the delta.
 */

/** docs/SYNC-V3.md 预算, 客户端缓存. */
export const CACHE_SESSIONS = 8;

export interface CachedLane extends LaneHeld { sessionId: string; savedAt: number; rows: TimelineRow[] }

/** Where the copies live; `idbBackend` in the browser. Every method settles, never rejects. */
export interface CacheBackend {
  get(sessionId: string): Promise<CachedLane | undefined>;
  put(record: CachedLane): Promise<void>;
  delete(sessionId: string): Promise<void>;
  /** Every saved session with its save time. */
  list(): Promise<Array<{ sessionId: string; savedAt: number }>>;
  clear(): Promise<void>;
}

const valid = (record: unknown): record is CachedLane => {
  const value = record as Partial<CachedLane> | undefined;
  return typeof value?.generation === 'string' && typeof value.seq === 'number' && Array.isArray(value.rows) && typeof value.hasBefore === 'boolean';
};
const held = ({ generation, seq, rows, hasBefore }: CachedLane): LaneHeld => ({ generation, seq, rows, hasBefore });

/**
 * The copies, with this tab's own in memory in front of the backend: switching back to a
 * conversation paints at once, a reloaded page waits one IndexedDB read.
 */
export class SyncCache {
  /** Bumped by `clear` (signing out): a view still open from before may not write its copy back. */
  epoch = 0;
  private memory = new Map<string, CachedLane>();
  /** Deleted conversations: no read answers for them and no write, in flight or later, puts them back. */
  private readonly deleted = new Set<string>();
  private lastSavedAt = 0;

  constructor(private readonly backend?: CacheBackend, private readonly limit = CACHE_SESSIONS) {}

  /** This tab's copy, without waiting. */
  peek(sessionId: string): LaneHeld | undefined {
    const record = this.memory.get(sessionId);
    return record && !this.deleted.has(sessionId) ? held(record) : undefined;
  }

  async load(sessionId: string): Promise<LaneHeld | undefined> {
    if (this.deleted.has(sessionId)) return undefined;
    const memory = this.memory.get(sessionId);
    if (memory) return held(memory);
    const epoch = this.epoch;
    const record = await this.backend?.get(sessionId).catch(() => undefined);
    if (!valid(record) || epoch !== this.epoch || this.deleted.has(sessionId)) return undefined;
    this.remember(record);
    return held(record);
  }

  async save(sessionId: string, lane: LaneHeld, epoch = this.epoch): Promise<void> {
    if (epoch !== this.epoch || this.deleted.has(sessionId)) return;
    // Save times order the copies; two in the same millisecond must still have an order.
    const savedAt = this.lastSavedAt = Math.max(Date.now(), this.lastSavedAt + 1);
    const record: CachedLane = { sessionId, savedAt, generation: lane.generation, seq: lane.seq, hasBefore: lane.hasBefore, rows: lane.rows.slice() };
    this.remember(record);
    if (!this.backend) return;
    await this.backend.put(record).catch(() => undefined);
    // Deleted while the write was in flight: take the copy back out.
    if (this.deleted.has(sessionId)) { await this.backend.delete(sessionId).catch(() => undefined); return; }
    const saved = await this.backend.list().catch(() => []);
    const excess = saved.length - this.limit;
    if (excess <= 0) return;
    const oldest = saved.sort((a, b) => a.savedAt - b.savedAt).slice(0, excess);
    await Promise.all(oldest.map(({ sessionId: id }) => this.backend!.delete(id).catch(() => undefined)));
  }

  /** The lane was rebuilt on the server: its copy can only mislead. */
  async drop(sessionId: string): Promise<void> {
    this.memory.delete(sessionId);
    await this.backend?.delete(sessionId).catch(() => undefined);
  }

  /** The conversation was deleted on the server: drop its copy and refuse every later one. */
  async forget(sessionId: string): Promise<void> {
    this.deleted.add(sessionId);
    await this.drop(sessionId);
  }

  async clear(): Promise<void> {
    this.epoch += 1;
    this.memory.clear();
    await this.backend?.clear().catch(() => undefined);
  }

  private remember(record: CachedLane): void {
    this.memory.delete(record.sessionId);
    this.memory.set(record.sessionId, record);
    for (const key of this.memory.keys()) {
      if (this.memory.size <= this.limit) break;
      this.memory.delete(key);
    }
  }
}

const DB_NAME = 'riffet-sync';
const STORE = 'lanes';

/** The IndexedDB backend: one record per session, indexed by save time for the LRU cut. */
export function idbBackend(factory: IDBFactory = indexedDB): CacheBackend {
  let opening: Promise<IDBDatabase | undefined> | undefined;
  const open = () => opening ??= new Promise<IDBDatabase | undefined>((resolve) => {
    try {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'sessionId' }).createIndex('savedAt', 'savedAt');
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = undefined; };
        resolve(db);
      };
      request.onerror = () => resolve(undefined);
      request.onblocked = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
  /** Runs one request; storage that is missing, full or closing reads as nothing. */
  const run = async <T>(mode: IDBTransactionMode, make: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> => {
    const db = await open();
    if (!db) return undefined;
    return await new Promise<T | undefined>((resolve) => {
      try {
        const request = make(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(undefined);
      } catch { resolve(undefined); }
    });
  };
  return {
    get: async (sessionId) => await run('readonly', (store) => store.get(sessionId)) as CachedLane | undefined,
    put: async (record) => { await run('readwrite', (store) => store.put(record)); },
    delete: async (sessionId) => { await run('readwrite', (store) => store.delete(sessionId)); },
    list: async () => {
      const db = await open();
      if (!db) return [];
      return await new Promise((resolve) => {
        const found: Array<{ sessionId: string; savedAt: number }> = [];
        try {
          const cursor = db.transaction(STORE, 'readonly').objectStore(STORE).index('savedAt').openKeyCursor();
          cursor.onsuccess = () => {
            const at = cursor.result;
            if (!at) { resolve(found); return; }
            found.push({ sessionId: String(at.primaryKey), savedAt: Number(at.key) });
            at.continue();
          };
          cursor.onerror = () => resolve(found);
        } catch { resolve(found); }
      });
    },
    clear: async () => { await run('readwrite', (store) => store.clear()); },
  };
}
