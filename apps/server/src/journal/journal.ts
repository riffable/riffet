import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { SyncLane } from '../../../../packages/contracts/src/sync.js';
import { AppError } from '../errors.js';
import { foldProjection, emptyProjection, projectionCheck, type JournalFoldRow, type SessionProjection } from './projection.js';

/** Largest payload kept inline in `journal_events`; anything bigger goes to `blobs`. */
export const JOURNAL_PAYLOAD_LIMIT = 64 * 1024;
/** Rows folded into a projection per statement batch; keeps one fold from holding the loop long. */
const FOLD_BATCH = 2000;
/** Draft chunks emptied per transaction, so housekeeping never holds the database (or the loop) for long. */
const COMPACT_BATCH = 500;
const PREVIEW_TEXT = 2000;
const SCHEMA_MARKER = 'journal-schema';
const SCHEMA_VERSION = 2;

/** Kinds that exist in the log but are not part of the transcript a client sees. */
export const DRAFT_KIND = 'draft';
export const TOMBSTONE_KIND = 'tombstone';
export const META_PREFIX = 'meta.';
export const isHiddenKind = (kind: string): boolean => kind === DRAFT_KIND || kind === TOMBSTONE_KIND || kind.startsWith(META_PREFIX);
/** The kind of a `session/update` event, which is how a system activity travels (`activity.ts`). */
const SESSION_UPDATE_KIND = 'session/update';

/*
 * A session has one log per lane (docs/SYNC-V3.md): `main`, and `sub:<toolCallId>` for each subagent. A
 * lane's log is the journal key derived below, so every lane numbers its own rows from 1 and the main
 * lane's key is the session id itself, which is where every log written before lanes existed already is.
 * A lane being imported is served meanwhile from a scratch log under `<key>#tail` (see `ingest.ts`).
 * Session ids never contain `#`, and a tool call id is percent-encoded, so a key names one log only.
 */
const SCRATCH_SUFFIX = '#tail';
const SUB_PREFIX = '#sub:';

/** The journal key of a lane's own log. */
export function laneKey(sessionId: string, lane: SyncLane): string {
  return lane === 'main' ? sessionId : `${sessionId}${SUB_PREFIX}${encodeURIComponent(lane.slice('sub:'.length))}`;
}

/** The journal key of the scratch log that serves a lane's tail while its history is imported. */
export const scratchKeyOf = (key: string): string => `${key}${SCRATCH_SUFFIX}`;

/** Which session, lane and kind of log a journal key names; undefined for a key no lane derives. */
export function laneOfKey(key: string): { sessionId: string; lane: SyncLane; scratch: boolean } | undefined {
  const at = key.indexOf('#');
  if (at < 0) return { sessionId: key, lane: 'main', scratch: false };
  const sessionId = key.slice(0, at);
  let rest = key.slice(at);
  const scratch = rest.endsWith(SCRATCH_SUFFIX);
  if (scratch) rest = rest.slice(0, -SCRATCH_SUFFIX.length);
  if (!rest) return { sessionId, lane: 'main', scratch };
  if (!rest.startsWith(SUB_PREFIX) || rest.includes('#', 1)) return undefined;
  try { return { sessionId, lane: `sub:${decodeURIComponent(rest.slice(SUB_PREFIX.length))}`, scratch }; } catch { return undefined; }
}

/**
 * A committed change to one log, as {@link Journal.onAppend} reports it: rows `fromSeq..toSeq` were
 * appended, or (`reset`) the log was started over under a new generation or removed. A dropped scratch
 * log means its lane's own log serves again (the import was promoted).
 */
export interface JournalAppend {
  sessionId: string;
  lane: SyncLane;
  /** The log is the lane's scratch window, not the lane's own log. */
  scratch: boolean;
  /** The log's generation after the change; absent when it was dropped. */
  generation?: string;
  /** For a reset, `1..0`: nothing of the old log holds. */
  fromSeq: number;
  toSeq: number;
  reset?: 'rebuilt' | 'dropped';
}

export interface JournalEventInput {
  /** What the row is: a native event type, or a `meta.*` synthetic kind. */
  kind: string;
  /** The entity this row is a version of. A later row with the same id is a new version, never an edit. */
  nativeId: string;
  turnId?: string;
  at?: string;
  payload: unknown;
  /**
   * What identifies the content for "is this a new version?". Defaults to the payload; a caller whose
   * payload carries a field that changes without the content changing (a read timestamp) leaves it out here.
   */
  contentKey?: unknown;
}

export interface JournalHead {
  sessionId: string;
  generation: string;
  lastSeq: number;
  ingestCursor: string | null;
  /** The native conversation the log was written from, when its writer records one (see `ingest.ts`). */
  identity?: string;
  projectionSeq: number;
  updatedAt: string;
}

export interface JournalRow {
  seq: number;
  kind: string;
  nativeId: string;
  rev: number;
  turnId?: string;
  at: string;
  digest: string;
  blobRef?: string;
  /** The payload as written, blob resolved. */
  payload: unknown;
}

/** One entity as a transcript shows it: its latest version, placed where its first row sits. */
export interface JournalEntity extends JournalRow {
  /** Seq of the entity's first row: its stable position, however many versions follow. */
  identity: number;
}

export interface AppendOptions {
  /** New `ingest_cursor`, committed with the rows; `undefined` leaves it alone. */
  cursor?: string | null;
  /** Refuse the write when the log was rebuilt since the caller last looked. */
  generation?: string;
}

export interface AppendedRow {
  nativeId: string;
  /** Seq of the row written, or of the existing latest version when nothing was written. */
  seq: number;
  identity: number;
  rev: number;
  /** False when the event was byte-identical to its latest version and was therefore skipped. */
  written: boolean;
  created: boolean;
}

export interface AppendResult { head: JournalHead; rows: AppendedRow[]; }

export class JournalGenerationChanged extends Error {
  constructor() { super('The session journal was rebuilt'); }
}

/** A write to a deleted conversation's log, which is refused rather than starting the log again (410, like any request naming it). */
export class JournalSessionDeleted extends AppError {
  constructor(sessionId: string) { super('SESSION_DELETED', 'This conversation was deleted', 410, { sessionId }); }
}

interface RawRow {
  seq: number; kind: string; native_id: string; rev: number; turn_id: string | null; at: string; payload: string; blob_ref: string | null; digest: string;
}

interface HeadRow { session_id: string; generation: string; last_seq: number; ingest_cursor: string | null; identity: string | null; projection_seq: number; updated_at: string }

const sha1 = (text: string) => createHash('sha1').update(text).digest('base64');

/** A bounded stand-in for an oversized payload: identity and scalar fields, text cut short. */
function previewOf(payload: unknown): Record<string, unknown> {
  const clip = (value: string) => value.length > PREVIEW_TEXT ? `${value.slice(0, PREVIEW_TEXT)}…` : value;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { truncated: true };
  const record = payload as Record<string, unknown>;
  const preview: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'data') continue;
    if (typeof value === 'string') preview[key] = clip(value);
    else if (typeof value === 'number' || typeof value === 'boolean') preview[key] = value;
  }
  const data = record.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const shallow: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value === 'string') shallow[key] = clip(value);
      else if (typeof value === 'number' || typeof value === 'boolean') shallow[key] = value;
    }
    const content = (data as Record<string, unknown>).content;
    const text = content && typeof content === 'object' && !Array.isArray(content) ? (content as Record<string, unknown>).text : undefined;
    if (typeof text === 'string') shallow.content = { type: 'text', text: clip(text) };
    preview.data = shallow;
  }
  preview.truncated = true;
  return preview;
}

export class Journal {
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;
  private readonly settleHooks: Array<(committed: boolean) => void> = [];
  private readonly appendListeners = new Set<(change: JournalAppend) => void>();
  /** Changes of the open transaction, reported once it commits. */
  private pending: { changes: JournalAppend[]; last: Map<string, JournalAppend> } | undefined;

  /**
   * `transaction` lets the owner of the database (the store) make journal writes join its own
   * transactions; without one, the journal manages its own. `afterTransaction` runs a callback once the owner's
   * open transaction has ended, saying whether it committed, so changes are reported only when they hold.
   */
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction?: <T>(fn: () => T) => T,
    private readonly afterTransaction?: (fn: (committed: boolean) => void) => void,
    /** A deleted conversation: none of its logs is started again (a read or fold finishing late writes nothing). */
    private readonly deleted?: (sessionId: string) => boolean,
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal_heads (
        session_id TEXT PRIMARY KEY, generation TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, ingest_cursor TEXT,
        projection TEXT, projection_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, identity TEXT);
      CREATE TABLE IF NOT EXISTS journal_events (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, native_id TEXT NOT NULL, rev INTEGER NOT NULL,
        turn_id TEXT, at TEXT NOT NULL, payload TEXT NOT NULL, blob_ref TEXT, digest TEXT NOT NULL,
        PRIMARY KEY (session_id, seq));
      CREATE UNIQUE INDEX IF NOT EXISTS journal_native ON journal_events(session_id, native_id, rev);
      CREATE INDEX IF NOT EXISTS journal_turn ON journal_events(session_id, turn_id) WHERE turn_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS journal_blob_ref ON journal_events(blob_ref) WHERE blob_ref IS NOT NULL;
      -- Draft chunks not yet emptied (see compactDrafts): a handful, where the table holds every event ever logged.
      CREATE INDEX IF NOT EXISTS journal_open_drafts ON journal_events(kind) WHERE kind='draft' AND payload<>'{}';
      -- Session updates (system activities among them), which a writer reads back on start (see activityEntities): under 1% of the rows.
      CREATE INDEX IF NOT EXISTS journal_session_updates ON journal_events(session_id, seq) WHERE kind='${SESSION_UPDATE_KIND}';
      CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL);
      -- Blobs a session refers to from inside a payload (an activity's full text), which journal_events.blob_ref does not cover.
      CREATE TABLE IF NOT EXISTS session_blobs (session_id TEXT NOT NULL, hash TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (session_id, hash));
      -- Additive and unversioned for readers that predate it, like message_index; the marker is for later migrations.
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);`);
    const marker = this.sql('SELECT json FROM settings WHERE key=?').get(SCHEMA_MARKER) as { json: string } | undefined;
    const version = marker ? Number(JSON.parse(marker.json)) : 0;
    if (version < SCHEMA_VERSION) {
      this.migrate(version);
      this.sql('INSERT INTO settings(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run(SCHEMA_MARKER, JSON.stringify(SCHEMA_VERSION));
    }
  }

  /**
   * Brings an older shape up to this one. Every step checks before it alters, so a step that ran without
   * its marker being written is not run twice. v2 adds `journal_heads.identity`: a nullable column, which
   * SQLite adds by editing the schema alone, without rewriting a row of any table.
   */
  private migrate(from: number): void {
    if (from < 2) {
      const columns = this.db.prepare('PRAGMA table_info(journal_heads)').all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === 'identity')) this.db.exec('ALTER TABLE journal_heads ADD COLUMN identity TEXT');
    }
  }

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) this.statements.set(text, statement = this.db.prepare(text));
    return statement;
  }

  /** Runs `fn` inside one transaction, joining the owner's when there is one. */
  tx<T>(fn: () => T): T {
    if (this.transaction) return this.transaction(fn);
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const result = fn(); this.db.exec('COMMIT'); this.depth--; this.settle(true); return result; }
    catch (error) { this.db.exec('ROLLBACK'); this.depth--; this.settle(false); throw error; }
  }

  private settle(committed: boolean): void { for (const hook of this.settleHooks.splice(0)) hook(committed); }

  /** Runs `fn` when the open transaction ends (at once, as committed, when none is open). */
  private whenSettled(fn: (committed: boolean) => void): void {
    if (this.afterTransaction) this.afterTransaction(fn);
    else if (!this.transaction && this.depth) this.settleHooks.push(fn);
    else fn(true);
  }

  // ---- changes -----------------------------------------------------------------------------

  /**
   * Committed changes to any lane's log, in commit order: what a projection folds incrementally. A
   * transaction's appends to one log arrive as one contiguous range; nothing is reported for one that
   * rolled back. Listener errors are swallowed: a derived view must not fail a committed write.
   */
  onAppend(listener: (change: JournalAppend) => void): () => void {
    this.appendListeners.add(listener);
    return () => { this.appendListeners.delete(listener); };
  }

  private note(key: string, change: Pick<JournalAppend, 'generation' | 'fromSeq' | 'toSeq' | 'reset'>): void {
    if (!this.appendListeners.size) return;
    const where = laneOfKey(key);
    if (!where) return;
    if (!this.pending) {
      const pending = this.pending = { changes: [], last: new Map() };
      this.whenSettled(committed => {
        if (this.pending === pending) this.pending = undefined;
        if (!committed) return;
        for (const item of pending.changes) for (const listener of this.appendListeners) { try { listener(item); } catch { /* see onAppend */ } }
      });
    }
    const last = this.pending.last.get(key);
    if (last && !last.reset && !change.reset && last.generation === change.generation && last.toSeq + 1 === change.fromSeq) { last.toSeq = change.toSeq; return; }
    const entry: JournalAppend = { ...where, ...change };
    this.pending.changes.push(entry);
    this.pending.last.set(key, entry);
  }

  // ---- heads -------------------------------------------------------------------------------

  private headOf(row: HeadRow): JournalHead {
    return {
      sessionId: row.session_id, generation: row.generation, lastSeq: row.last_seq, ingestCursor: row.ingest_cursor,
      ...(row.identity !== null ? { identity: row.identity } : {}), projectionSeq: row.projection_seq, updatedAt: row.updated_at,
    };
  }

  /** The log's head, or undefined when the session has never been written. */
  peek(sessionId: string): JournalHead | undefined {
    const row = this.sql('SELECT session_id,generation,last_seq,ingest_cursor,identity,projection_seq,updated_at FROM journal_heads WHERE session_id=?').get(sessionId) as HeadRow | undefined;
    return row ? this.headOf(row) : undefined;
  }

  /** Every log of a session: its main lane, its subagent lanes, and their scratch windows. */
  keysOf(sessionId: string): string[] {
    return (this.sql('SELECT session_id FROM journal_heads WHERE session_id=? OR (session_id>=? AND session_id<?) ORDER BY session_id')
      .all(sessionId, `${sessionId}#`, `${sessionId}$`) as Array<{ session_id: string }>).map(row => row.session_id);
  }

  private refuseDeleted(key: string): void {
    const owner = laneOfKey(key)?.sessionId ?? key;
    if (this.deleted?.(owner)) throw new JournalSessionDeleted(owner);
  }

  /** The log's head, created with a fresh generation on first use. */
  head(sessionId: string): JournalHead {
    const existing = this.peek(sessionId);
    if (existing) return existing;
    this.refuseDeleted(sessionId);
    return this.tx(() => {
      this.sql('INSERT OR IGNORE INTO journal_heads(session_id,generation,last_seq,updated_at) VALUES(?,?,0,?)').run(sessionId, randomUUID(), new Date().toISOString());
      return this.peek(sessionId)!;
    });
  }

  setCursor(sessionId: string, cursor: string | null): void {
    this.tx(() => {
      this.head(sessionId);
      this.sql('UPDATE journal_heads SET ingest_cursor=?, updated_at=? WHERE session_id=?').run(cursor, new Date().toISOString(), sessionId);
    });
  }

  setIdentity(sessionId: string, identity: string): void {
    this.tx(() => {
      this.head(sessionId);
      this.sql('UPDATE journal_heads SET identity=?, updated_at=? WHERE session_id=?').run(identity, new Date().toISOString(), sessionId);
    });
  }

  // ---- writes ------------------------------------------------------------------------------

  /**
   * Appends a batch and the cursor that says how far the source has been read, atomically.
   * `seq` continues from the head with no gaps. An input identical to its entity's latest version
   * writes nothing, which is what makes re-reading a source after a crash safe.
   */
  append(sessionId: string, inputs: readonly JournalEventInput[], options: AppendOptions = {}): AppendResult {
    return this.tx(() => {
      const head = this.head(sessionId);
      if (options.generation !== undefined && options.generation !== head.generation) throw new JournalGenerationChanged();
      const rows: AppendedRow[] = [];
      let seq = head.lastSeq;
      const stamp = new Date().toISOString();
      const insert = this.sql('INSERT INTO journal_events(session_id,seq,kind,native_id,rev,turn_id,at,payload,blob_ref,digest) VALUES(?,?,?,?,?,?,?,?,?,?)');
      const latestOf = this.sql('SELECT seq,rev,kind,digest FROM journal_events WHERE session_id=? AND native_id=? ORDER BY rev DESC LIMIT 1');
      const firstOf = this.sql('SELECT seq FROM journal_events WHERE session_id=? AND native_id=? AND rev=1');
      for (const input of inputs) {
        const json = JSON.stringify(input.payload);
        const digest = sha1(`${input.kind}\n${input.contentKey === undefined ? json : JSON.stringify(input.contentKey)}`);
        const latest = latestOf.get(sessionId, input.nativeId) as { seq: number; rev: number; kind: string; digest: string } | undefined;
        if (latest && latest.digest === digest) {
          const identity = latest.rev === 1 ? latest.seq : (firstOf.get(sessionId, input.nativeId) as { seq: number }).seq;
          rows.push({ nativeId: input.nativeId, seq: latest.seq, identity, rev: latest.rev, written: false, created: false });
          continue;
        }
        seq += 1;
        const rev = latest ? latest.rev + 1 : 1;
        const identity = latest ? (latest.rev === 1 ? latest.seq : (firstOf.get(sessionId, input.nativeId) as { seq: number }).seq) : seq;
        let payload = json, blobRef: string | null = null;
        if (Buffer.byteLength(json) > JOURNAL_PAYLOAD_LIMIT) {
          blobRef = this.putBlob(Buffer.from(json));
          payload = JSON.stringify(previewOf(input.payload));
        }
        insert.run(sessionId, seq, input.kind, input.nativeId, rev, input.turnId ?? null, input.at ?? stamp, payload, blobRef, digest);
        rows.push({ nativeId: input.nativeId, seq, identity, rev, written: true, created: !latest });
      }
      const cursor = options.cursor === undefined ? head.ingestCursor : options.cursor;
      // A re-read that found nothing new leaves the head as it was: replaying a source writes nothing at all.
      if (seq === head.lastSeq && cursor === head.ingestCursor) return { head, rows };
      this.sql('UPDATE journal_heads SET last_seq=?, ingest_cursor=?, updated_at=? WHERE session_id=?').run(seq, cursor, stamp, sessionId);
      if (seq > head.lastSeq) this.note(sessionId, { generation: head.generation, fromSeq: head.lastSeq + 1, toSeq: seq });
      return { head: { ...head, lastSeq: seq, ingestCursor: cursor, updatedAt: stamp }, rows };
    });
  }

  /**
   * Starts the log over: every row goes and the generation changes, which is the only way a
   * generation changes. Clients holding the old one reload instead of splicing numbering.
   */
  rebuild(sessionId: string): JournalHead {
    return this.tx(() => {
      // A discussion's source is durable input, not a derived transcript cache.
      this.sql("DELETE FROM session_blobs WHERE session_id=? AND type NOT IN ('application/vnd.riffet.discussion+json','application/vnd.riffet.session-reference+json')").run(sessionId);
      this.sql('DELETE FROM journal_events WHERE session_id=?').run(sessionId);
      this.sql('DELETE FROM journal_heads WHERE session_id=?').run(sessionId);
      const head = this.head(sessionId);
      this.note(sessionId, { generation: head.generation, fromSeq: 1, toSeq: 0, reset: 'rebuilt' });
      return head;
    });
  }

  /** Removes a log without leaving a head behind (a closed session, or a scratch log). */
  drop(sessionId: string): void {
    this.tx(() => {
      this.sql('DELETE FROM session_blobs WHERE session_id=?').run(sessionId);
      this.sql('DELETE FROM journal_events WHERE session_id=?').run(sessionId);
      if (Number(this.sql('DELETE FROM journal_heads WHERE session_id=?').run(sessionId).changes)) this.note(sessionId, { fromSeq: 1, toSeq: 0, reset: 'dropped' });
    });
  }

  /** A redundant child log is removed only when every current entity already exists in its replacement. */
  dropIfCopied(sessionId: string, replacement: string): void {
    this.tx(() => {
      if (sessionId === replacement || !this.peek(sessionId) || this.peek(sessionId)?.identity !== this.peek(replacement)?.identity) return;
      const missing = this.sql(`SELECT 1 FROM journal_events e WHERE e.session_id=?
        AND e.rev=(SELECT MAX(rev) FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id)
        AND NOT EXISTS (SELECT 1 FROM journal_events r WHERE r.session_id=? AND r.native_id=e.native_id AND r.digest=e.digest
          AND r.rev=(SELECT MAX(rev) FROM journal_events WHERE session_id=r.session_id AND native_id=r.native_id)) LIMIT 1`).get(sessionId, replacement);
      if (!missing) this.drop(sessionId);
    });
  }

  // ---- blobs -------------------------------------------------------------------------------

  putBlob(bytes: Buffer): string {
    const hash = createHash('sha256').update(bytes).digest('hex');
    this.sql('INSERT OR IGNORE INTO blobs(hash,size,bytes,created_at) VALUES(?,?,?,?)').run(hash, bytes.length, bytes, new Date().toISOString());
    return hash;
  }

  getBlob(hash: string): Buffer | undefined {
    const row = this.sql('SELECT bytes FROM blobs WHERE hash=?').get(hash) as { bytes: Uint8Array } | undefined;
    return row ? Buffer.from(row.bytes) : undefined;
  }

  /** Stores `bytes` for a session to fetch later (`GET /api/sessions/:id/blobs/:hash`); returns the hash to put in a payload. */
  putSessionBlob(sessionId: string, bytes: Buffer, type = 'text/plain; charset=utf-8'): string {
    this.refuseDeleted(sessionId);
    return this.tx(() => {
      const hash = this.putBlob(bytes);
      this.sql('INSERT OR IGNORE INTO session_blobs(session_id,hash,type) VALUES(?,?,?)').run(sessionId, hash, type);
      return hash;
    });
  }

  /**
   * A blob as seen by one session: only if that session's log refers to it (an oversized payload, or a
   * blob it stored itself). `size` is read first so a caller can refuse a large one without loading it.
   */
  sessionBlob(sessionId: string, hash: string): { size: number; type: string; bytes: () => Buffer } | undefined {
    const owned = this.sql('SELECT type FROM session_blobs WHERE session_id=? AND hash=?').get(sessionId, hash) as { type: string } | undefined;
    // Any log of the session counts: its lanes and their scratch windows (see `keysOf`).
    const payload = owned ? undefined : this.sql('SELECT 1 AS one FROM journal_events WHERE blob_ref=? AND (session_id=? OR (session_id>=? AND session_id<?)) LIMIT 1')
      .get(hash, sessionId, `${sessionId}#`, `${sessionId}$`);
    if (!owned && !payload) return undefined;
    const row = this.sql('SELECT size FROM blobs WHERE hash=?').get(hash) as { size: number } | undefined;
    if (!row) return undefined;
    return { size: row.size, type: owned?.type ?? 'application/json', bytes: () => this.getBlob(hash) ?? Buffer.alloc(0) };
  }

  /**
   * The session no longer refers to these blobs (a row it stored one for was replaced). Its claim goes, so
   * the next sweep deletes the bytes unless a row or another session still refers to them.
   */
  releaseSessionBlobs(sessionId: string, hashes: Iterable<string>): void {
    const release = this.sql('DELETE FROM session_blobs WHERE session_id=? AND hash=?');
    this.tx(() => { for (const hash of hashes) release.run(sessionId, hash); });
  }

  /** Deletes blobs no row refers to any more; returns how many went. */
  sweepBlobs(): number {
    return Number(this.sql('DELETE FROM blobs WHERE hash NOT IN (SELECT blob_ref FROM journal_events WHERE blob_ref IS NOT NULL) AND hash NOT IN (SELECT hash FROM session_blobs)').run().changes);
  }

  /**
   * Empties the payload of streamed chunks whose entity has since been committed: only the final version is
   * read back (`entity`, `entitiesBefore`), and the projection skips drafts. The rows stay, so `seq`, `rev`,
   * `digest` and therefore numbering, paging and re-read dedup are untouched. Returns how many were emptied.
   */
  compactDrafts(): number {
    // The kind is written into the statement: only a literal lets SQLite use the partial `journal_open_drafts` index.
    const pick = this.sql(`SELECT rowid AS id FROM journal_events d WHERE d.kind='${DRAFT_KIND}' AND d.payload<>'{}' AND d.rowid>? AND EXISTS (
      SELECT 1 FROM journal_events n WHERE n.session_id=d.session_id AND n.native_id=d.native_id AND n.rev>d.rev AND n.kind<>'${DRAFT_KIND}')
      ORDER BY d.rowid LIMIT ?`);
    const empty = this.sql(`UPDATE journal_events SET payload='{}', blob_ref=NULL WHERE rowid=?`);
    let after = 0, emptied = 0;
    for (;;) {
      const ids = (pick.all(after, COMPACT_BATCH) as Array<{ id: number }>).map(row => row.id);
      if (!ids.length) return emptied;
      this.tx(() => { for (const id of ids) emptied += Number(empty.run(id).changes); });
      after = ids.at(-1)!;
      if (ids.length < COMPACT_BATCH) return emptied;
    }
  }

  /** Housekeeping the log needs now and then: superseded draft chunks first, so the blobs they referenced go with the sweep. */
  maintain(): { drafts: number; blobs: number } {
    const drafts = this.compactDrafts();
    return { drafts, blobs: this.sweepBlobs() };
  }

  stats(sessionId?: string): { events: number; payloadBytes: number; blobs: number; blobBytes: number } {
    const events = (sessionId
      ? this.sql('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)),0) AS bytes FROM journal_events WHERE session_id=?').get(sessionId)
      : this.sql('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)),0) AS bytes FROM journal_events').get()) as { n: number; bytes: number };
    const blobs = this.sql('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes FROM blobs').get() as { n: number; bytes: number };
    return { events: events.n, payloadBytes: events.bytes, blobs: blobs.n, blobBytes: blobs.bytes };
  }

  // ---- reads -------------------------------------------------------------------------------

  private rowOf(raw: RawRow): JournalRow {
    let payload: unknown;
    if (raw.blob_ref) {
      const blob = this.getBlob(raw.blob_ref);
      payload = blob ? JSON.parse(blob.toString('utf8')) : JSON.parse(raw.payload);
    } else payload = JSON.parse(raw.payload);
    return {
      seq: raw.seq, kind: raw.kind, nativeId: raw.native_id, rev: raw.rev, ...(raw.turn_id ? { turnId: raw.turn_id } : {}),
      at: raw.at, digest: raw.digest, ...(raw.blob_ref ? { blobRef: raw.blob_ref } : {}), payload,
    };
  }

  /** Raw rows by seq, oldest first: what a resuming subscriber replays. */
  range(sessionId: string, afterSeq: number, limit: number): JournalRow[] {
    return (this.sql('SELECT seq,kind,native_id,rev,turn_id,at,payload,blob_ref,digest FROM journal_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(sessionId, afterSeq, limit) as unknown as RawRow[]).map(row => this.rowOf(row));
  }

  /** The latest version of an entity, with the seq of its first row. */
  entity(sessionId: string, nativeId: string): JournalEntity | undefined {
    const raw = this.sql('SELECT seq,kind,native_id,rev,turn_id,at,payload,blob_ref,digest FROM journal_events WHERE session_id=? AND native_id=? ORDER BY rev DESC LIMIT 1').get(sessionId, nativeId) as unknown as RawRow | undefined;
    if (!raw) return undefined;
    const identity = raw.rev === 1 ? raw.seq : (this.sql('SELECT seq FROM journal_events WHERE session_id=? AND native_id=? AND rev=1').get(sessionId, nativeId) as { seq: number }).seq;
    return { ...this.rowOf(raw), identity };
  }

  /** The latest explicit retraction, retained even after a corrected entity supersedes it. */
  retraction(sessionId: string, nativeId: string): JournalRow | undefined {
    const raw = this.sql(`SELECT seq,kind,native_id,rev,turn_id,at,payload,blob_ref,digest FROM journal_events
      WHERE session_id=? AND native_id=? AND kind=? ORDER BY rev DESC LIMIT 1`).get(sessionId, nativeId, TOMBSTONE_KIND) as unknown as RawRow | undefined;
    return raw ? this.rowOf(raw) : undefined;
  }

  /** The oldest current entity of one kind, in original transcript order, with its latest payload. */
  firstEntity(sessionId: string, kind: string): JournalEntity | undefined {
    const first = this.sql(`SELECT e.native_id FROM journal_events e WHERE e.session_id=? AND e.rev=1
      AND (SELECT kind FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id ORDER BY rev DESC LIMIT 1)=?
      ORDER BY e.seq LIMIT 1`).get(sessionId, kind) as { native_id: string } | undefined;
    return first ? this.entity(sessionId, first.native_id) : undefined;
  }

  /** Just where an entity sits and what version it is at, without reading its payload. */
  locate(sessionId: string, nativeId: string): { identity: number; rev: number; seq: number; kind: string; digest: string; turnId?: string } | undefined {
    const latest = this.sql('SELECT seq,rev,kind,digest,turn_id FROM journal_events WHERE session_id=? AND native_id=? ORDER BY rev DESC LIMIT 1').get(sessionId, nativeId) as { seq: number; rev: number; kind: string; digest: string; turn_id: string | null } | undefined;
    if (!latest) return undefined;
    const identity = latest.rev === 1 ? latest.seq : (this.sql('SELECT seq FROM journal_events WHERE session_id=? AND native_id=? AND rev=1').get(sessionId, nativeId) as { seq: number }).seq;
    return { identity, rev: latest.rev, seq: latest.seq, kind: latest.kind, digest: latest.digest, ...(latest.turn_id ? { turnId: latest.turn_id } : {}) };
  }

  /**
   * The latest version of every `session/update` entity whose latest version is one (a system activity's
   * last state, among others), oldest first. Read through a partial index, so it costs what those rows do.
   */
  activityEntities(sessionId: string): JournalEntity[] {
    // The kind is written into the statement: only a literal lets SQLite use the partial `journal_session_updates` index.
    const rows = this.sql(`SELECT e.seq,e.kind,e.native_id,e.rev,e.turn_id,e.at,e.payload,e.blob_ref,e.digest FROM journal_events e
      WHERE e.session_id=? AND e.kind='${SESSION_UPDATE_KIND}' AND e.rev=(SELECT MAX(rev) FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id)
      ORDER BY e.seq`).all(sessionId) as unknown as RawRow[];
    const firstOf = this.sql('SELECT seq FROM journal_events WHERE session_id=? AND native_id=? AND rev=1');
    return rows.map(raw => ({ ...this.rowOf(raw), identity: raw.rev === 1 ? raw.seq : (firstOf.get(sessionId, raw.native_id) as { seq: number }).seq }));
  }

  /** Current child bindings, including children whose parent tool was already folded for good. */
  subagentEntities(sessionId: string): JournalRow[] {
    const rows = this.sql(`SELECT e.seq,e.kind,e.native_id,e.rev,e.turn_id,e.at,e.payload,e.blob_ref,e.digest FROM journal_events e
      WHERE e.session_id=? AND e.native_id>='meta:subagent:' AND e.native_id<'meta:subagent;' AND e.kind='meta.subagent'
        AND e.rev=(SELECT MAX(rev) FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id)
      ORDER BY (SELECT seq FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id AND rev=1)`)
      .all(sessionId) as unknown as RawRow[];
    return rows.map(row => this.rowOf(row));
  }

  /** Current rows of a tool, used when retracting a duplicate child binding without rebuilding history. */
  toolEntities(sessionId: string, toolCallId: string): JournalRow[] {
    const rows = this.sql(`SELECT e.seq,e.kind,e.native_id,e.rev,e.turn_id,e.at,e.payload,e.blob_ref,e.digest FROM journal_events e
      WHERE e.session_id=? AND e.kind IN ('tool_call','tool_call_update') AND json_extract(e.payload,'$.data.toolCallId')=?
        AND e.rev=(SELECT MAX(rev) FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id)
      ORDER BY e.seq`).all(sessionId, toolCallId) as unknown as RawRow[];
    return rows.map(row => this.rowOf(row));
  }

  /** The turn of the newest row that has one. */
  lastTurn(sessionId: string): string | undefined {
    // `+turn_id` keeps the planner on the (session_id, seq) key, read backwards, instead of the turn index.
    const row = this.sql('SELECT turn_id FROM journal_events WHERE session_id=? AND +turn_id IS NOT NULL ORDER BY seq DESC LIMIT 1').get(sessionId) as { turn_id: string } | undefined;
    return row?.turn_id;
  }

  /** The newest execution by its first start mark; late writes to older turns cannot change it. */
  lastStartedTurn(sessionId: string): string | undefined {
    // The `meta:turn:` range keeps the planner on `journal_native`: it reads the turn marks only, not the log backwards.
    const row = this.sql(`SELECT turn_id FROM journal_events WHERE session_id=? AND native_id>='meta:turn:' AND native_id<'meta:turn;'
      AND kind='meta.turn_started' AND rev=1 ORDER BY seq DESC LIMIT 1`).get(sessionId) as { turn_id: string } | undefined;
    return row?.turn_id;
  }

  /**
   * Visible entities whose first row precedes `beforeIdentity`, the newest `limit` of them, in
   * transcript order. `includeDrafts` also reads streamed text; retired and synthetic rows stay hidden.
   */
  entitiesBefore(sessionId: string, beforeIdentity: number, limit: number, includeDrafts = false): JournalEntity[] {
    // Paged by seq cursor, not OFFSET: a page costs the same however deep the walk goes.
    const firsts = this.sql('SELECT seq,native_id FROM journal_events WHERE session_id=? AND rev=1 AND seq<? ORDER BY seq DESC LIMIT ?');
    const latestOf = this.sql('SELECT seq,kind,native_id,rev,turn_id,at,payload,blob_ref,digest FROM journal_events WHERE session_id=? AND native_id=? ORDER BY rev DESC LIMIT 1');
    const found: JournalEntity[] = [];
    const page = Math.max(limit, 64);
    let cursor = beforeIdentity;
    while (found.length < limit) {
      const candidates = firsts.all(sessionId, cursor, page) as Array<{ seq: number; native_id: string }>;
      if (!candidates.length) break;
      for (const candidate of candidates) {
        cursor = candidate.seq;
        const latest = latestOf.get(sessionId, candidate.native_id) as unknown as RawRow;
        if (isHiddenKind(latest.kind) && !(includeDrafts && latest.kind === DRAFT_KIND)) continue;
        found.push({ ...this.rowOf(latest), identity: candidate.seq });
        if (found.length >= limit) break;
      }
    }
    return found.reverse();
  }

  tail(sessionId: string, limit: number, includeDrafts = false): JournalEntity[] {
    return this.entitiesBefore(sessionId, Number.MAX_SAFE_INTEGER, limit, includeDrafts);
  }

  /** Whether any visible entity sits before `identity`. */
  hasEntitiesBefore(sessionId: string, identity: number): boolean {
    return this.entitiesBefore(sessionId, identity, 1).length > 0;
  }

  // ---- projection ---------------------------------------------------------------------------

  private rowDigestAt(sessionId: string, seq: number): string {
    if (seq <= 0) return '';
    const row = this.sql('SELECT digest FROM journal_events WHERE session_id=? AND seq=?').get(sessionId, seq) as { digest: string } | undefined;
    return row?.digest ?? '';
  }

  private foldFrom(sessionId: string, projection: SessionProjection, upTo: number): SessionProjection {
    let current = projection;
    while (current.asOfSeq < upTo) {
      const batch = this.sql('SELECT seq,kind,native_id,rev,turn_id,at,payload,blob_ref,digest FROM journal_events WHERE session_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?')
        .all(sessionId, current.asOfSeq, upTo, FOLD_BATCH) as unknown as RawRow[];
      if (!batch.length) break;
      const rows: JournalFoldRow[] = batch.map(raw => {
        const previous = raw.rev > 1 && (!isHiddenKind(raw.kind) || raw.kind === TOMBSTONE_KIND && raw.native_id.endsWith(':started'))
          ? this.sql('SELECT kind,turn_id FROM journal_events WHERE session_id=? AND native_id=? AND rev=?')
            .get(sessionId, raw.native_id, raw.rev - 1) as { kind: string; turn_id: string | null } | undefined : undefined;
        return {
          seq: raw.seq, kind: raw.kind, nativeId: raw.native_id, rev: raw.rev, turnId: raw.turn_id ?? undefined, at: raw.at,
          ...(previous ? { previousTurnId: previous.turn_id ?? undefined, previousKind: previous.kind } : {}),
          // A fold reads only small fields; an oversized payload's preview carries them.
          payload: JSON.parse(raw.payload),
        };
      });
      current = foldProjection(current, rows);
      current = { ...current, check: projectionCheck(current.asOfSeq, batch[batch.length - 1]!.digest) };
    }
    return current;
  }

  /** Folds the whole log from seq 1 and stores the result. */
  rebuildProjection(sessionId: string): SessionProjection {
    return this.tx(() => {
      const head = this.head(sessionId);
      const projection = this.foldFrom(sessionId, emptyProjection(), head.lastSeq);
      this.saveProjection(sessionId, projection);
      return projection;
    });
  }

  private saveProjection(sessionId: string, projection: SessionProjection): void {
    this.sql('UPDATE journal_heads SET projection=?, projection_seq=? WHERE session_id=?').run(JSON.stringify(projection), projection.asOfSeq, sessionId);
  }

  /**
   * The folded state of the session as of the head. The stored projection is a cache: it may trail
   * the log and is brought forward by folding only the rows after it, but one that claims a seq the
   * log does not have, or whose anchor row is not the one it was built from, is discarded and
   * rebuilt from the log.
   */
  projection(sessionId: string): SessionProjection {
    const head = this.head(sessionId);
    const stored = this.sql('SELECT projection FROM journal_heads WHERE session_id=?').get(sessionId) as { projection: string | null };
    let cached: SessionProjection | undefined;
    try { cached = stored.projection ? JSON.parse(stored.projection) as SessionProjection : undefined; } catch { cached = undefined; }
    const valid = cached && cached.v === 1 && cached.asOfSeq === head.projectionSeq && cached.asOfSeq <= head.lastSeq
      && cached.check === projectionCheck(cached.asOfSeq, this.rowDigestAt(sessionId, cached.asOfSeq));
    if (!valid) return this.rebuildProjection(sessionId);
    if (cached!.asOfSeq === head.lastSeq) return cached!;
    return this.tx(() => {
      const next = this.foldFrom(sessionId, cached!, head.lastSeq);
      this.saveProjection(sessionId, next);
      return next;
    });
  }
}
