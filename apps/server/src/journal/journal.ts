import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { STORAGE_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import type { SyncLane } from '../../../../packages/contracts/src/sync.js';
import { AppError } from '../errors.js';
import { prepareBlob, readStoredBlob, removeExternalBlob, sweepOrphanExternalBlobs, writeExternalBlob, type PreparedBlob, type StoredBlobRow } from './blob-store.js';
import { foldProjection, emptyProjection, projectionCheck, type JournalFoldRow, type SessionProjection } from './projection.js';

/** Largest payload kept inline in `journal_events`; anything bigger spills to CAS `blobs` (fits one 4 KiB page). */
export const JOURNAL_PAYLOAD_LIMIT = STORAGE_BUDGET.journalInlineBytes;
/** Rows folded into a projection per statement batch; keeps one fold from holding the loop long. */
const FOLD_BATCH = 2000;
/** Draft/superseded chunks emptied per transaction, so housekeeping never holds the database (or the loop) for long. */
const COMPACT_BATCH = 500;
const PREVIEW_TEXT = STORAGE_BUDGET.journalPreviewChars;
const SCHEMA_MARKER = 'journal-schema';
const SCHEMA_VERSION = 4;
const DICT_RECOMPRESS_MARKER = 'blob-dict-v1-cursor';

/** Kinds that exist in the log but are not part of the transcript a client sees. */
export const DRAFT_KIND = 'draft';
export const TOMBSTONE_KIND = 'tombstone';
export const META_PREFIX = 'meta.';
export const isHiddenKind = (kind: string): boolean => kind === DRAFT_KIND || kind === TOMBSTONE_KIND || kind.startsWith(META_PREFIX);
/** The kind of a `session/update` event, which is how a system activity travels (`activity.ts`). */
const SESSION_UPDATE_KIND = 'session/update';

/** Non-draft event kinds whose superseded earlier revisions can be safely stripped while preserving seq/digest. */
const COMPACTABLE_KINDS_SQL = "'tool_call','tool_call_update','agent_message_chunk','agent_thought_chunk','session/update'";
const ARCHIVED_TRIM_MARKER = '\n... [archived tool output trimmed] ...\n';

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
  compactedSeq: number;
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

export type SessionBlobResult = { size: number; type: string; bytes: () => Buffer };
export type FallbackBlobResolver = (sessionId: string, hash: string) => SessionBlobResult | undefined;

export class JournalGenerationChanged extends Error {
  constructor() { super('The session journal was rebuilt'); }
}

/** A write to a deleted conversation's log, which is refused rather than starting the log again (410, like any request naming it). */
export class JournalSessionDeleted extends AppError {
  constructor(sessionId: string) { super('SESSION_DELETED', 'This conversation was deleted', 410, { sessionId }); }
}

interface RawRow {
  seq: number; kind: string; native_id: string; rev: number; turn_id: string | null; at: string; payload: string; blob_ref: string | null; digest: string;
  blob_codec?: string | null; blob_external?: number | null; blob_bytes?: Uint8Array | null;
}

interface HeadRow { session_id: string; generation: string; last_seq: number; ingest_cursor: string | null; identity: string | null; projection_seq: number; compacted_seq: number; updated_at: string }

const sha1 = (text: string) => createHash('sha1').update(text).digest('base64');

const SELECT_EVENT_COLS = `e.seq,e.kind,e.native_id,e.rev,e.turn_id,e.at,e.payload,e.blob_ref,e.digest,b.codec AS blob_codec,b.external AS blob_external,b.bytes AS blob_bytes`;
const EVENT_JOIN = `LEFT JOIN blobs b ON b.hash=e.blob_ref`;

const isPlainRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * A narrow envelope kept inline in `journal_events` when the full payload spills to `blobs`.
 * Preserves the small structured fields read by projections, activity restoration, tool lookup and
 * work-item evidence without reading the blob, while fitting comfortably inside one 4 KiB page.
 */
const MESSAGE_PREVIEW_BYTES = 2001;
const MESSAGE_INLINE_BYTES = 3072;

function clipUtf8(value: string, maxBytes: number): string {
  if (value.length * 3 <= maxBytes || Buffer.byteLength(value) <= maxBytes) return value;
  return `${Buffer.from(value).subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/, '')}…`;
}

export function previewOf(payload: unknown): Record<string, unknown> {
  const clip = (value: string, max: number = PREVIEW_TEXT) => value.length > max ? `${value.slice(0, max)}…` : value;
  if (!isPlainRecord(payload)) return { truncated: true };
  const preview: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'data') continue;
    if (typeof value === 'string') preview[key] = clip(value, 256);
    else if (typeof value === 'number' || typeof value === 'boolean') preview[key] = value;
  }
  const data = payload.data;
  if (isPlainRecord(data)) {
    const shallow: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string') shallow[key] = clip(value, 256);
      else if (typeof value === 'number' || typeof value === 'boolean') shallow[key] = value;
    }
    // Text chunk preview: user/assistant messages keep up to 2001 UTF-8 bytes (2001 ASCII chars or ~667 CJK chars,
    // fitting one 4 KiB page without duplicating CJK messages in both `journal_events` and `blobs`).
    const isMessageChunk = payload.type === 'user_message_chunk' || payload.type === 'agent_message_chunk';
    const content = data.content;
    if (isPlainRecord(content)) {
      const text = content.text;
      if (typeof text === 'string') shallow.content = { type: typeof content.type === 'string' ? content.type : 'text', text: isMessageChunk ? clipUtf8(text, MESSAGE_PREVIEW_BYTES) : clip(text) };
    } else if (Array.isArray(content)) {
      // First short text snippet for tool exit-code evidence without storing the full output.
      for (const block of content) {
        const inner = isPlainRecord(block) ? block.content : undefined;
        const text = isPlainRecord(inner) ? inner.text : undefined;
        if (typeof text === 'string' && text) {
          shallow.content = [{ type: 'content', content: { type: 'text', text: clip(text, 160) } }];
          break;
        }
      }
    }
    // Preserve edited file paths for work-item evidence.
    if (Array.isArray(data.locations)) {
      const paths: Array<{ path: string }> = [];
      for (const loc of data.locations) {
        if (isPlainRecord(loc) && typeof loc.path === 'string' && loc.path) {
          paths.push({ path: clip(loc.path, 256) });
          if (paths.length >= 16) break;
        }
      }
      if (paths.length) shallow.locations = paths;
    }
    // Preserve scalar input paths/commands and job exit codes for evidence extraction.
    if (isPlainRecord(data.rawInput)) {
      const input: Record<string, unknown> = {};
      for (const key of ['command', 'file_path', 'path', 'filePath']) {
        if (typeof data.rawInput[key] === 'string' && data.rawInput[key]) input[key] = clip(data.rawInput[key] as string, 256);
      }
      if (isPlainRecord(data.rawInput.changes)) {
        const keys = Object.keys(data.rawInput.changes).slice(0, 16);
        if (keys.length) input.changes = Object.fromEntries(keys.map(k => [clip(k, 256), true]));
      }
      if (Object.keys(input).length) shallow.rawInput = input;
    }
    if (isPlainRecord(data.jobResult) && typeof data.jobResult.exitCode === 'number') {
      shallow.jobResult = { exitCode: data.jobResult.exitCode };
    }
    // Preserve activity metadata so `foldProjection` reads live activities without loading blobs.
    if (isPlainRecord(data.activity)) {
      const act: Record<string, unknown> = {};
      for (const key of ['id', 'kind', 'status', 'title', 'toolCallId', 'startedAt', 'endedAt', 'blobRef']) {
        if (typeof data.activity[key] === 'string') act[key] = clip(data.activity[key] as string, 256);
      }
      if (typeof data.activity.durationMs === 'number') act.durationMs = data.activity.durationMs;
      if (typeof data.activity.detail === 'string') act.detail = clip(data.activity.detail, 256);
      if (isPlainRecord(data.activity.stop)) act.stop = data.activity.stop;
      if (isPlainRecord(data.activity.compaction)) act.compaction = data.activity.compaction;
      if (isPlainRecord(data.activity.task)) {
        const task: Record<string, unknown> = {};
        if (typeof data.activity.task.kind === 'string') task.kind = data.activity.task.kind;
        if (typeof data.activity.task.command === 'string') task.command = clip(data.activity.task.command, 256);
        if (typeof data.activity.task.exitCode === 'number') task.exitCode = data.activity.task.exitCode;
        act.task = task;
      }
      if (isPlainRecord(data.activity.command) && typeof data.activity.command.name === 'string') {
        act.command = { name: clip(data.activity.command.name, 128) };
      }
      shallow.activity = act;
    }
    preview.data = shallow;
  }
  preview.truncated = true;
  return preview;
}

export interface JournalOptions {
  /** Directory for Tier-2 immutable compressed blobs (>= `STORAGE_BUDGET.blobExternalBytes`). */
  blobsDir?: string;
  /**
   * Optional coordinator with an enclosing L0 store transaction: returns true only while a caller
   * explicitly opened `store.transaction(...)`, letting `journalDb` defer its commit/rollback until the
   * outer transaction settles without touching the L0 lock during normal standalone journal writes.
   */
  enclosingTransaction?: {
    active(): boolean;
    onSettle(fn: (committed: boolean) => void): void;
  };
}

export class Journal {
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;
  private savepointSeq = 0;
  private joinedEnclosing = false;
  private readonly settleHooks: Array<(committed: boolean) => void> = [];
  private readonly appendListeners = new Set<(change: JournalAppend) => void>();
  /** Changes of the open transaction, reported once it commits. */
  private pending: { changes: JournalAppend[]; last: Map<string, JournalAppend> } | undefined;
  readonly blobsDir: string | undefined;
  private readonly enclosing: JournalOptions['enclosingTransaction'];
  /** Legacy tables created `blobs.bytes BLOB NOT NULL`; external rows store empty buffer there instead of NULL. */
  private readonly bytesNotNull: boolean;
  private fallbackBlobResolver: FallbackBlobResolver | undefined;
  /** Reference count of active backup/snapshot readers holding off blob GC so referenced files are never unlinked mid-copy. */
  private blobGcHolds = 0;

  /**
   * `transaction` lets the owner of the database (the store) make journal writes join its own
   * transactions; without one, the journal manages its own. `afterTransaction` runs a callback once the owner's
   * open transaction has ended, saying whether it committed, so changes are reported only when they hold.
   */
  constructor(
    readonly db: DatabaseSync,
    private readonly transaction?: <T>(fn: () => T) => T,
    private readonly afterTransaction?: (fn: (committed: boolean) => void) => void,
    /** A deleted conversation: none of its logs is started again (a read or fold finishing late writes nothing). */
    private readonly deleted?: (sessionId: string) => boolean,
    options?: JournalOptions,
  ) {
    this.blobsDir = options?.blobsDir;
    this.enclosing = options?.enclosingTransaction;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal_heads (
        session_id TEXT PRIMARY KEY, generation TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, ingest_cursor TEXT,
        projection TEXT, projection_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, identity TEXT,
        compacted_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS journal_events (
        session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, native_id TEXT NOT NULL, rev INTEGER NOT NULL,
        turn_id TEXT, at TEXT NOT NULL, digest TEXT NOT NULL, blob_ref TEXT, payload TEXT NOT NULL,
        PRIMARY KEY (session_id, seq));
      CREATE UNIQUE INDEX IF NOT EXISTS journal_native ON journal_events(session_id, native_id, rev);
      -- Exclude compacted '{}' shells so superseded revisions and drained drafts do not bloat the turn index.
      CREATE INDEX IF NOT EXISTS journal_turn ON journal_events(session_id, turn_id) WHERE turn_id IS NOT NULL AND payload<>'{}';
      CREATE INDEX IF NOT EXISTS journal_blob_ref ON journal_events(blob_ref) WHERE blob_ref IS NOT NULL;
      -- Draft chunks not yet emptied (see compactDrafts): a handful, where the table holds every event ever logged.
      CREATE INDEX IF NOT EXISTS journal_open_drafts ON journal_events(kind) WHERE kind='draft' AND payload<>'{}';
      -- Session updates (system activities among them), which a writer reads back on start (see activityEntities): under 1% of the rows.
      CREATE INDEX IF NOT EXISTS journal_session_updates ON journal_events(session_id, seq) WHERE kind='${SESSION_UPDATE_KIND}';
      CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY, size INTEGER NOT NULL, stored_size INTEGER NOT NULL DEFAULT 0,
        codec TEXT NOT NULL DEFAULT 'raw', external INTEGER NOT NULL DEFAULT 0, bytes BLOB, created_at TEXT NOT NULL);
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
    const blobCols = this.db.prepare('PRAGMA table_info(blobs)').all() as Array<{ name: string; notnull: number }>;
    this.bytesNotNull = blobCols.some(col => col.name === 'bytes' && col.notnull === 1);
  }

  /**
   * Registers an on-demand resolver consulted by {@link sessionBlob} when a hash is not persisted in `blobs`
   * (e.g. truncated timeline rows reconstructed dynamically from the journal).
   */
  setFallbackBlobResolver(resolver: FallbackBlobResolver | undefined): void {
    this.fallbackBlobResolver = resolver;
  }

  /**
   * Brings an older shape up to this one. Every step checks before it alters, so a step that ran without
   * its marker being written is not run twice.
   * - v2 adds `journal_heads.identity`.
   * - v3 adds `journal_heads.compacted_seq` and compressed/external blob metadata columns on `blobs`.
   * - v4 narrows `journal_turn` to a partial index excluding compacted `{}` shells.
   */
  private migrate(from: number): void {
    const hasColumn = (table: string, name: string) =>
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(column => column.name === name);
    if (from < 2) {
      if (!hasColumn('journal_heads', 'identity')) this.db.exec('ALTER TABLE journal_heads ADD COLUMN identity TEXT');
    }
    if (from < 3) {
      if (!hasColumn('journal_heads', 'compacted_seq')) this.db.exec('ALTER TABLE journal_heads ADD COLUMN compacted_seq INTEGER NOT NULL DEFAULT 0');
      if (!hasColumn('blobs', 'stored_size')) this.db.exec('ALTER TABLE blobs ADD COLUMN stored_size INTEGER NOT NULL DEFAULT 0');
      if (!hasColumn('blobs', 'codec')) this.db.exec("ALTER TABLE blobs ADD COLUMN codec TEXT NOT NULL DEFAULT 'raw'");
      if (!hasColumn('blobs', 'external')) this.db.exec('ALTER TABLE blobs ADD COLUMN external INTEGER NOT NULL DEFAULT 0');
    }
    if (from < 4) {
      this.db.exec("DROP INDEX IF EXISTS journal_turn; CREATE INDEX IF NOT EXISTS journal_turn ON journal_events(session_id, turn_id) WHERE turn_id IS NOT NULL AND payload<>'{}';");
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
    if (this.depth) {
      // Inside a joined enclosing transaction, isolate nested calls with a SAVEPOINT so a caught inner
      // error rolls back its partial L1 writes instead of letting them commit with the outer L0 tx.
      if (!this.joinedEnclosing) return fn();
      const sp = `j_sp_${++this.savepointSeq}`;
      this.db.exec(`SAVEPOINT ${sp}`);
      try {
        const result = fn();
        this.db.exec(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (error) {
        try { this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`); } catch { /* connection closed */ }
        throw error;
      }
    }
    if (this.enclosing?.active()) {
      this.db.exec('BEGIN IMMEDIATE');
      this.depth += 1;
      this.joinedEnclosing = true;
      this.enclosing.onSettle(committed => {
        if (!this.joinedEnclosing) return;
        this.joinedEnclosing = false;
        this.depth = Math.max(0, this.depth - 1);
        let settled = committed;
        try {
          this.db.exec(committed ? 'COMMIT' : 'ROLLBACK');
        } catch (error) {
          settled = false;
          if (!/database is not open/i.test(String(error))) {
            console.error('[riffet] journal transaction settle failed; attempting rollback:', error);
            try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
          }
        }
        this.settle(settled);
      });
      const sp = `j_sp_${++this.savepointSeq}`;
      this.db.exec(`SAVEPOINT ${sp}`);
      try {
        const result = fn();
        this.db.exec(`RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (error) {
        try { this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`); } catch { /* connection closed */ }
        throw error;
      }
    }
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const result = fn(); this.db.exec('COMMIT'); this.depth--; this.settle(true); return result; }
    catch (error) { this.db.exec('ROLLBACK'); this.depth--; this.settle(false); throw error; }
  }

  private settle(committed: boolean): void { for (const hook of this.settleHooks.splice(0)) hook(committed); }

  /** Runs `fn` when the open transaction ends (at once, as committed, when none is open). */
  whenSettled(fn: (committed: boolean) => void): void {
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
      ...(row.identity !== null ? { identity: row.identity } : {}), projectionSeq: row.projection_seq,
      compactedSeq: row.compacted_seq ?? 0, updatedAt: row.updated_at,
    };
  }

  /** The log's head, or undefined when the session has never been written. */
  peek(sessionId: string): JournalHead | undefined {
    const row = this.sql('SELECT session_id,generation,last_seq,ingest_cursor,identity,projection_seq,compacted_seq,updated_at FROM journal_heads WHERE session_id=?').get(sessionId) as HeadRow | undefined;
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
   *
   * Serialization, hashing and Zstd compression run before the write transaction opens so CPU work
   * never holds the SQLite write lock.
   */
  append(sessionId: string, inputs: readonly JournalEventInput[], options: AppendOptions = {}): AppendResult {
    const prepared = inputs.map(input => {
      const json = JSON.stringify(input.payload);
      const digest = sha1(`${input.kind}\n${input.contentKey === undefined ? json : JSON.stringify(input.contentKey)}`);
      const limit = input.kind === 'user_message_chunk' || input.kind === 'agent_message_chunk' ? MESSAGE_INLINE_BYTES : JOURNAL_PAYLOAD_LIMIT;
      const oversized = Buffer.byteLength(json) > limit;
      if (!oversized) return { input, digest, payload: json, blob: undefined as PreparedBlob | undefined };
      const blob = prepareBlob(Buffer.from(json), { mimeType: 'application/json', blobsDir: this.blobsDir });
      return { input, digest, payload: JSON.stringify(previewOf(input.payload)), blob };
    });
    return this.tx(() => {
      const head = this.head(sessionId);
      if (options.generation !== undefined && options.generation !== head.generation) throw new JournalGenerationChanged();
      const rows: AppendedRow[] = [];
      let seq = head.lastSeq;
      const stamp = new Date().toISOString();
      const insert = this.sql('INSERT INTO journal_events(session_id,seq,kind,native_id,rev,turn_id,at,payload,blob_ref,digest) VALUES(?,?,?,?,?,?,?,?,?,?)');
      const latestOf = this.sql('SELECT seq,rev,kind,digest FROM journal_events WHERE session_id=? AND native_id=? ORDER BY rev DESC LIMIT 1');
      const firstOf = this.sql('SELECT seq FROM journal_events WHERE session_id=? AND native_id=? AND rev=1');
      for (const item of prepared) {
        const { input, digest, payload, blob } = item;
        const latest = latestOf.get(sessionId, input.nativeId) as { seq: number; rev: number; kind: string; digest: string } | undefined;
        if (latest && latest.digest === digest) {
          const identity = latest.rev === 1 ? latest.seq : (firstOf.get(sessionId, input.nativeId) as { seq: number }).seq;
          rows.push({ nativeId: input.nativeId, seq: latest.seq, identity, rev: latest.rev, written: false, created: false });
          continue;
        }
        seq += 1;
        const rev = latest ? latest.rev + 1 : 1;
        const identity = latest ? (latest.rev === 1 ? latest.seq : (firstOf.get(sessionId, input.nativeId) as { seq: number }).seq) : seq;
        let blobRef: string | null = null;
        if (blob) {
          this.storePreparedBlob(blob, stamp);
          blobRef = blob.hash;
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

  private storePreparedBlob(prepared: PreparedBlob, stamp = new Date().toISOString()): void {
    // Never write a mismatched external file if the same plaintext hash is already stored under another codec/tier.
    if (this.sql('SELECT 1 AS found FROM blobs WHERE hash=?').get(prepared.hash)) return;
    if (prepared.external && this.blobsDir) writeExternalBlob(this.blobsDir, prepared);
    const storedBytes = prepared.external ? (this.bytesNotNull ? Buffer.alloc(0) : null) : prepared.storedBytes;
    this.sql('INSERT OR IGNORE INTO blobs(hash,size,stored_size,codec,external,bytes,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(prepared.hash, prepared.size, prepared.storedSize, prepared.codec, prepared.external ? 1 : 0, storedBytes, stamp);
  }

  putBlob(bytes: Buffer, mimeType?: string): string {
    const prepared = prepareBlob(bytes, { mimeType, blobsDir: this.blobsDir });
    this.storePreparedBlob(prepared);
    return prepared.hash;
  }

  getBlob(hash: string): Buffer | undefined {
    const row = this.sql('SELECT hash,codec,external,bytes FROM blobs WHERE hash=?').get(hash) as StoredBlobRow | undefined;
    return row ? readStoredBlob(row, this.blobsDir) : undefined;
  }

  /** Uncompressed size of a stored blob without loading or decompressing its bytes. */
  blobSize(hash: string): number | undefined {
    const row = this.sql('SELECT size FROM blobs WHERE hash=?').get(hash) as { size: number } | undefined;
    return row?.size;
  }

  /** Stores `bytes` for a session to fetch later (`GET /api/sessions/:id/blobs/:hash`); returns the hash to put in a payload. */
  putSessionBlob(sessionId: string, bytes: Buffer, type = 'text/plain; charset=utf-8'): string {
    this.refuseDeleted(sessionId);
    const prepared = prepareBlob(bytes, { mimeType: type, blobsDir: this.blobsDir });
    return this.tx(() => {
      this.storePreparedBlob(prepared);
      this.sql('INSERT OR IGNORE INTO session_blobs(session_id,hash,type) VALUES(?,?,?)').run(sessionId, prepared.hash, type);
      return prepared.hash;
    });
  }

  /**
   * A blob as seen by one session: only if that session's log refers to it (an oversized payload, or a
   * blob it stored itself), falling back to dynamic reconstruction for unpersisted truncated timeline rows.
   * `size` is read first so a caller can refuse a large one without loading it.
   */
  sessionBlob(sessionId: string, hash: string): SessionBlobResult | undefined {
    const owned = this.sql('SELECT type FROM session_blobs WHERE session_id=? AND hash=?').get(sessionId, hash) as { type: string } | undefined;
    // Any log of the session counts: its lanes and their scratch windows (see `keysOf`).
    const payload = owned ? undefined : this.sql('SELECT 1 AS one FROM journal_events WHERE blob_ref=? AND (session_id=? OR (session_id>=? AND session_id<?)) LIMIT 1')
      .get(hash, sessionId, `${sessionId}#`, `${sessionId}$`);
    if (owned || payload) {
      const row = this.sql('SELECT size FROM blobs WHERE hash=?').get(hash) as { size: number } | undefined;
      if (row) return { size: row.size, type: owned?.type ?? 'application/json', bytes: () => this.getBlob(hash) ?? Buffer.alloc(0) };
    }
    return this.fallbackBlobResolver?.(sessionId, hash);
  }

  /**
   * The session no longer refers to these blobs (a row it stored one for was replaced). Its claim goes, so
   * the next sweep deletes the bytes unless a row or another session still refers to them.
   */
  releaseSessionBlobs(sessionId: string, hashes: Iterable<string>): void {
    const release = this.sql('DELETE FROM session_blobs WHERE session_id=? AND hash=?');
    this.tx(() => { for (const hash of hashes) release.run(sessionId, hash); });
  }

  /**
   * Acquires a GC fence preventing {@link sweepBlobs} and {@link sweepExternalFiles} from deleting
   * unreferenced blobs or external files while an online backup is snapshotting `journal.db` and `blobs/`.
   * Call the returned release function in a `finally` block.
   */
  holdBlobGc(): () => void {
    this.blobGcHolds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.blobGcHolds = Math.max(0, this.blobGcHolds - 1);
    };
  }

  /** Whether an active reader (such as an online backup) is holding off blob garbage collection. */
  isBlobGcHeld(): boolean {
    return this.blobGcHolds > 0;
  }

  /** Deletes blobs no row refers to any more (and removes any Tier-2 external files after commit); returns how many went. */
  sweepBlobs(): number {
    if (this.blobGcHolds > 0) return 0;
    const unreferenced = 'hash NOT IN (SELECT blob_ref FROM journal_events WHERE blob_ref IS NOT NULL) AND hash NOT IN (SELECT hash FROM session_blobs)';
    let externalRows: Array<{ hash: string; codec: string | null }> = [];
    const deleted = this.tx(() => {
      if (this.blobsDir) {
        externalRows = this.sql(`SELECT hash, codec FROM blobs WHERE external=1 AND ${unreferenced}`).all() as Array<{ hash: string; codec: string | null }>;
      }
      return Number(this.sql(`DELETE FROM blobs WHERE ${unreferenced}`).run().changes);
    });
    if (this.blobsDir && externalRows.length) {
      const dir = this.blobsDir;
      const toRemove = externalRows;
      this.whenSettled(committed => {
        if (!committed) return;
        for (const row of toRemove) {
          // Guard against a concurrent re-insert of the exact same hash before unlink.
          if (this.sql('SELECT 1 AS found FROM blobs WHERE hash=? AND external=1').get(row.hash)) continue;
          removeExternalBlob(dir, row.hash, row.codec);
        }
      });
    }
    return deleted;
  }

  /** Sweeps stale `.tmp` and unreferenced Tier-2 blob files on disk (matching both hash and codec). */
  sweepExternalFiles(): number {
    if (!this.blobsDir || this.blobGcHolds > 0) return 0;
    const exists = this.sql('SELECT 1 AS found FROM blobs WHERE hash=? AND codec=? AND external=1');
    return sweepOrphanExternalBlobs(this.blobsDir, (hash, codec) => Boolean(exists.get(hash, codec)));
  }

  /**
   * Upgrades legacy inline `raw`/`zstd` JSON object blobs (`<= STORAGE_BUDGET.blobDictMaxBytes`) to
   * dictionary-compressed `zstd-d1` in bounded batches when doing so saves space. Compression runs
   * strictly outside write locks. Progress is persisted in `settings` (`blob-dict-v1-cursor`) so
   * incompressible prefix rows never starve later blobs and steady-state calls do O(1) work once complete.
   */
  recompressSmallBlobs(options: { maxBlobs?: number; reset?: boolean } = {}): { recompressed: number; savedBytes: number } {
    const maxBlobs = options.maxBlobs ?? 1_000;
    if (maxBlobs <= 0) return { recompressed: 0, savedBytes: 0 };
    type Progress = { cursor?: string; done?: boolean };
    let progress: Progress = {};
    if (!options.reset) {
      const saved = this.sql('SELECT json FROM settings WHERE key=?').get(DICT_RECOMPRESS_MARKER) as { json: string } | undefined;
      if (saved) {
        try { progress = JSON.parse(saved.json) as Progress; } catch { progress = {}; }
      }
      if (progress.done) return { recompressed: 0, savedBytes: 0 };
    }
    const saveProgress = (next: Progress) => {
      this.sql('INSERT INTO settings(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json')
        .run(DICT_RECOMPRESS_MARKER, JSON.stringify(next));
    };
    const pick = this.sql(`SELECT hash, size, stored_size, codec, external, bytes FROM blobs
      WHERE external=0 AND codec IN ('raw','zstd') AND size>=? AND size<=? AND hash>?
      ORDER BY hash LIMIT ?`);
    const update = this.sql("UPDATE blobs SET stored_size=?, codec=?, bytes=? WHERE hash=? AND external=0 AND codec IN ('raw','zstd')");
    let cursor = progress.cursor ?? '';
    let scanned = 0;
    let recompressed = 0;
    let savedBytes = 0;
    let reachedEnd = false;
    while (scanned < maxBlobs) {
      const batchSize = Math.min(200, maxBlobs - scanned);
      const rows = pick.all(STORAGE_BUDGET.blobCompressMinBytes, STORAGE_BUDGET.blobDictMaxBytes, cursor, batchSize) as Array<{
        hash: string; size: number; stored_size: number; codec: string; external: number; bytes: Uint8Array | null;
      }>;
      if (!rows.length) { reachedEnd = true; break; }
      cursor = rows.at(-1)!.hash;
      scanned += rows.length;
      const upgrades: Array<{ hash: string; storedSize: number; codec: string; bytes: Buffer; saved: number }> = [];
      for (const row of rows) {
        try {
          const plain = readStoredBlob(row, this.blobsDir);
          if (!plain || plain[0] !== 0x7b) continue;
          const prepared = prepareBlob(plain, { mimeType: 'application/json' });
          const currentStored = row.stored_size > 0 ? row.stored_size : row.size;
          if (prepared.codec === 'zstd-d1' && prepared.storedSize + 16 < currentStored) {
            upgrades.push({
              hash: row.hash,
              storedSize: prepared.storedSize,
              codec: prepared.codec,
              bytes: prepared.storedBytes,
              saved: currentStored - prepared.storedSize,
            });
          }
        } catch { /* skip corrupt blob rather than aborting maintenance */ }
      }
      const batchEnd = rows.length < batchSize;
      this.tx(() => {
        for (const item of upgrades) {
          const changed = Number(update.run(item.storedSize, item.codec, item.bytes, item.hash).changes);
          if (changed) { recompressed += 1; savedBytes += item.saved; }
        }
        saveProgress(batchEnd ? { done: true } : { cursor });
      });
      if (batchEnd) { reachedEnd = true; break; }
    }
    if (reachedEnd && scanned === 0) {
      this.tx(() => saveProgress({ done: true }));
    }
    return { recompressed, savedBytes };
  }

  // ---- compaction & retention ---------------------------------------------------------------

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

  /**
   * Kafka MCCO-style head/tail compaction: scans only new `rev > 1` rows above each lane's `compacted_seq`
   * watermark and strips superseded older revisions (keeping `seq`, `native_id`, `rev`, `kind`, `digest`
   * intact for monotonic ordering and replay deduplication).
   *
   * Never strips `user_message_chunk` (needed for projection previews), `meta.*`, or `tombstone`.
   */
  compactSuperseded(options: { minAgeMs?: number; maxUpdates?: number } = {}): number {
    const minAgeMs = options.minAgeMs ?? STORAGE_BUDGET.supersededLagMs;
    const maxUpdates = options.maxUpdates ?? 2_000;
    const cutoff = minAgeMs > 0 ? new Date(Date.now() - minAgeMs).toISOString() : undefined;
    const heads = this.sql('SELECT session_id, last_seq, compacted_seq FROM journal_heads WHERE last_seq > compacted_seq').all() as Array<{ session_id: string; last_seq: number; compacted_seq: number }>;
    const pickNewer = this.sql(`SELECT seq, native_id, rev, at FROM journal_events
      WHERE session_id=? AND seq>? AND rev>1 AND kind<>'${DRAFT_KIND}' ORDER BY seq LIMIT ?`);
    const stripOlder = this.sql(`UPDATE journal_events SET payload='{}', blob_ref=NULL
      WHERE session_id=? AND native_id=? AND rev<? AND kind IN (${COMPACTABLE_KINDS_SQL}) AND (payload<>'{}' OR blob_ref IS NOT NULL)`);
    const advance = this.sql('UPDATE journal_heads SET compacted_seq=? WHERE session_id=? AND compacted_seq<?');
    let stripped = 0;
    for (const head of heads) {
      if (stripped >= maxUpdates) break;
      let cursor = head.compacted_seq;
      let blockedAt: number | undefined;
      for (;;) {
        const batch = pickNewer.all(head.session_id, cursor, COMPACT_BATCH) as Array<{ seq: number; native_id: string; rev: number; at: string }>;
        if (!batch.length) break;
        const eligible: Array<{ seq: number; native_id: string; rev: number }> = [];
        for (const row of batch) {
          if (cutoff && row.at > cutoff) { blockedAt = row.seq - 1; break; }
          eligible.push(row);
          cursor = row.seq;
        }
        if (eligible.length) {
          this.tx(() => {
            for (const row of eligible) stripped += Number(stripOlder.run(head.session_id, row.native_id, row.rev).changes);
            advance.run(cursor, head.session_id, cursor);
          });
        }
        if (blockedAt !== undefined || batch.length < COMPACT_BATCH || stripped >= maxUpdates) break;
      }
      if (blockedAt === undefined && stripped < maxUpdates && head.last_seq > cursor) {
        this.tx(() => { advance.run(head.last_seq, head.session_id, head.last_seq); });
      }
    }
    return stripped;
  }

  /**
   * Cold trimming for archived, inactive, or aged assistant conversations (tiered retention): keeps
   * all human/assistant text, thoughts, file paths and diffs intact, while head+tail truncating
   * oversized raw terminal/tool outputs (optionally restricted to events strictly before `beforeAt`).
   */
  trimArchivedToolBlobs(sessionIds: readonly string[], options: { keepBytes?: number; limit?: number; beforeAt?: string } = {}): number {
    const keepBytes = options.keepBytes ?? STORAGE_BUDGET.archivedTrimKeepBytes;
    const minBytes = keepBytes * 2;
    const limit = options.limit ?? 40;
    const beforeAt = options.beforeAt;
    if (!sessionIds.length || keepBytes <= 0) return 0;
    const find = this.sql(`SELECT e.session_id, e.seq, e.blob_ref, b.size FROM journal_events e
      JOIN blobs b ON b.hash = e.blob_ref
      WHERE (e.session_id=? OR (e.session_id>=? AND e.session_id<?))
        AND (e.session_id>? OR (e.session_id=? AND e.seq>?))
        AND e.kind IN ('tool_call','tool_call_update') AND e.blob_ref IS NOT NULL AND b.size > ?
        ${beforeAt ? 'AND e.at < ?' : ''}
      ORDER BY e.session_id ASC, e.seq ASC
      LIMIT ?`);
    const update = this.sql('UPDATE journal_events SET blob_ref=? WHERE session_id=? AND seq=? AND blob_ref=?');
    const batchSize = Math.max(limit, 40);
    let trimmed = 0;
    for (const sessionId of sessionIds) {
      let cursorSession = '';
      let cursorSeq = 0;
      while (trimmed < limit) {
        const args = beforeAt
          ? [sessionId, `${sessionId}#`, `${sessionId}$`, cursorSession, cursorSession, cursorSeq, minBytes, beforeAt, batchSize]
          : [sessionId, `${sessionId}#`, `${sessionId}$`, cursorSession, cursorSession, cursorSeq, minBytes, batchSize];
        const candidates = find.all(...args) as Array<{ session_id: string; seq: number; blob_ref: string; size: number }>;
        if (!candidates.length) break;
        const tail = candidates[candidates.length - 1]!;
        cursorSession = tail.session_id;
        cursorSeq = tail.seq;
        for (const candidate of candidates) {
          if (trimmed >= limit) break;
          const raw = this.getBlob(candidate.blob_ref);
          if (!raw) continue;
          let parsed: unknown;
          try { parsed = JSON.parse(raw.toString('utf8')); } catch { continue; }
          const shrunk = trimToolPayloadOutputs(parsed, keepBytes);
          if (!shrunk) continue;
          const nextBytes = Buffer.from(JSON.stringify(shrunk));
          if (nextBytes.length >= candidate.size) continue;
          const prepared = prepareBlob(nextBytes, { mimeType: 'application/json', blobsDir: this.blobsDir });
          this.tx(() => {
            this.storePreparedBlob(prepared);
            update.run(prepared.hash, candidate.session_id, candidate.seq, candidate.blob_ref);
          });
          trimmed += 1;
        }
        if (candidates.length < batchSize) break;
      }
      if (trimmed >= limit) break;
    }
    return trimmed;
  }

  /** Housekeeping the log needs now and then: superseded draft chunks first, so the blobs they referenced go with the sweep. */
  maintain(): { drafts: number; blobs: number } {
    const drafts = this.compactDrafts();
    return { drafts, blobs: this.sweepBlobs() };
  }

  /** Full background maintenance: drafts, superseded revisions, unreferenced blobs and orphan Tier-2 files. */
  maintainAll(options: { minAgeMs?: number; maxUpdates?: number } = {}): { drafts: number; superseded: number; blobs: number; externalFiles: number } {
    const drafts = this.compactDrafts();
    const superseded = this.compactSuperseded(options);
    const blobs = this.sweepBlobs();
    const externalFiles = this.sweepExternalFiles();
    return { drafts, superseded, blobs, externalFiles };
  }

  stats(sessionId?: string): { events: number; payloadBytes: number; blobs: number; blobBytes: number; storedBlobBytes: number } {
    const events = (sessionId
      ? this.sql('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)),0) AS bytes FROM journal_events WHERE session_id=?').get(sessionId)
      : this.sql('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(payload)),0) AS bytes FROM journal_events').get()) as { n: number; bytes: number };
    const blobs = this.sql('SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes, COALESCE(SUM(CASE WHEN stored_size>0 THEN stored_size ELSE size END),0) AS stored FROM blobs').get() as { n: number; bytes: number; stored: number };
    return { events: events.n, payloadBytes: events.bytes, blobs: blobs.n, blobBytes: blobs.bytes, storedBlobBytes: blobs.stored };
  }

  // ---- reads -------------------------------------------------------------------------------

  private rowOf(raw: RawRow): JournalRow {
    let payload: unknown;
    if (raw.blob_ref) {
      const blob = raw.blob_codec !== undefined || raw.blob_bytes !== undefined || raw.blob_external !== undefined
        ? readStoredBlob({ hash: raw.blob_ref, codec: raw.blob_codec, external: raw.blob_external, bytes: raw.blob_bytes }, this.blobsDir)
        : this.getBlob(raw.blob_ref);
      payload = blob ? JSON.parse(blob.toString('utf8')) : JSON.parse(raw.payload);
    } else payload = JSON.parse(raw.payload);
    return {
      seq: raw.seq, kind: raw.kind, nativeId: raw.native_id, rev: raw.rev, ...(raw.turn_id ? { turnId: raw.turn_id } : {}),
      at: raw.at, digest: raw.digest, ...(raw.blob_ref ? { blobRef: raw.blob_ref } : {}), payload,
    };
  }

  /** Raw rows by seq, oldest first: what a resuming subscriber replays. */
  range(sessionId: string, afterSeq: number, limit: number): JournalRow[] {
    return (this.sql(`SELECT ${SELECT_EVENT_COLS} FROM journal_events e ${EVENT_JOIN} WHERE e.session_id=? AND e.seq>? ORDER BY e.seq LIMIT ?`)
      .all(sessionId, afterSeq, limit) as unknown as RawRow[]).map(row => this.rowOf(row));
  }

  /** The latest version of an entity, with the seq of its first row. */
  entity(sessionId: string, nativeId: string): JournalEntity | undefined {
    const raw = this.sql(`SELECT ${SELECT_EVENT_COLS} FROM journal_events e ${EVENT_JOIN} WHERE e.session_id=? AND e.native_id=? ORDER BY e.rev DESC LIMIT 1`)
      .get(sessionId, nativeId) as unknown as RawRow | undefined;
    if (!raw) return undefined;
    const identity = raw.rev === 1 ? raw.seq : (this.sql('SELECT seq FROM journal_events WHERE session_id=? AND native_id=? AND rev=1').get(sessionId, nativeId) as { seq: number }).seq;
    return { ...this.rowOf(raw), identity };
  }

  /** The latest explicit retraction, retained even after a corrected entity supersedes it. */
  retraction(sessionId: string, nativeId: string): JournalRow | undefined {
    const raw = this.sql(`SELECT ${SELECT_EVENT_COLS} FROM journal_events e ${EVENT_JOIN}
      WHERE e.session_id=? AND e.native_id=? AND e.kind=? ORDER BY e.rev DESC LIMIT 1`).get(sessionId, nativeId, TOMBSTONE_KIND) as unknown as RawRow | undefined;
    return raw ? this.rowOf(raw) : undefined;
  }

  /** The oldest current entity of one kind, in original transcript order, with its latest payload. */
  firstEntity(sessionId: string, kind: string): JournalEntity | undefined {
    const first = this.sql(`SELECT e.native_id FROM journal_events e WHERE e.session_id=? AND e.rev=1
      AND (SELECT kind FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id ORDER BY rev DESC LIMIT 1)=?
      ORDER BY e.seq LIMIT 1`).get(sessionId, kind) as { native_id: string } | undefined;
    return first ? this.entity(sessionId, first.native_id) : undefined;
  }

  /** Current entities of one kind in a turn, newest transcript position first. */
  *turnEntitiesNewestFirst(sessionId: string, turnId: string, kind: string): Generator<JournalRow> {
    const rows = this.sql(`SELECT ${SELECT_EVENT_COLS} FROM journal_events e ${EVENT_JOIN}
      WHERE e.session_id=? AND e.turn_id=? AND e.payload<>'{}' AND e.kind=?
        AND e.rev=(SELECT MAX(rev) FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id)
      ORDER BY (SELECT seq FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id AND rev=1) DESC`)
      .iterate(sessionId, turnId, kind);
    for (const raw of rows) yield this.rowOf(raw as unknown as RawRow);
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
    const rows = this.sql(`SELECT ${SELECT_EVENT_COLS} FROM journal_events e ${EVENT_JOIN}
      WHERE e.session_id=? AND e.kind='${SESSION_UPDATE_KIND}' AND e.rev=(SELECT MAX(rev) FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id)
      ORDER BY e.seq`).all(sessionId) as unknown as RawRow[];
    const firstOf = this.sql('SELECT seq FROM journal_events WHERE session_id=? AND native_id=? AND rev=1');
    return rows.map(raw => ({ ...this.rowOf(raw), identity: raw.rev === 1 ? raw.seq : (firstOf.get(sessionId, raw.native_id) as { seq: number }).seq }));
  }

  /** Current child bindings, including children whose parent tool was already folded for good. */
  subagentEntities(sessionId: string): JournalRow[] {
    const rows = this.sql(`SELECT ${SELECT_EVENT_COLS} FROM journal_events e ${EVENT_JOIN}
      WHERE e.session_id=? AND e.native_id>='meta:subagent:' AND e.native_id<'meta:subagent;' AND e.kind='meta.subagent'
        AND e.rev=(SELECT MAX(rev) FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id)
      ORDER BY (SELECT seq FROM journal_events WHERE session_id=e.session_id AND native_id=e.native_id AND rev=1)`)
      .all(sessionId) as unknown as RawRow[];
    return rows.map(row => this.rowOf(row));
  }

  /** Current rows of a tool, used when retracting a duplicate child binding without rebuilding history. */
  toolEntities(sessionId: string, toolCallId: string): JournalRow[] {
    const rows = this.sql(`SELECT ${SELECT_EVENT_COLS} FROM journal_events e ${EVENT_JOIN}
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
    const latestOf = this.sql(`SELECT ${SELECT_EVENT_COLS} FROM journal_events e ${EVENT_JOIN} WHERE e.session_id=? AND e.native_id=? ORDER BY e.rev DESC LIMIT 1`);
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

  /** Newest visible text messages, in transcript order. Oversized payloads use their inline preview. */
  recentMessages(sessionId: string, limit: number, characters: number): Array<{ role: 'user' | 'assistant'; text: string; at: string }> {
    const rows = this.sql(`SELECT latest.kind, latest.at, substr(json_extract(latest.payload,'$.data.content.text'),1,?) AS text
      FROM journal_events first JOIN journal_events latest ON latest.session_id=first.session_id AND latest.seq=(
        SELECT seq FROM journal_events WHERE session_id=first.session_id AND native_id=first.native_id ORDER BY rev DESC LIMIT 1
      )
      WHERE first.session_id=? AND first.rev=1 AND first.kind IN ('user_message_chunk','agent_message_chunk','draft')
        AND latest.kind IN ('user_message_chunk','agent_message_chunk') AND json_extract(latest.payload,'$.data.content.type')='text'
        AND trim(json_extract(latest.payload,'$.data.content.text'))<>''
      ORDER BY first.seq DESC LIMIT ?`).all(characters, sessionId, limit) as Array<{ kind: string; at: string; text: string }>;
    return rows.reverse().map(row => ({ role: row.kind === 'user_message_chunk' ? 'user' : 'assistant', text: row.text.trim(), at: row.at }));
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

function headTailTrim(text: string, keepBytes: number): string | undefined {
  const total = Buffer.byteLength(text);
  if (total <= keepBytes) return undefined;
  const half = Math.max(256, Math.floor((keepBytes - Buffer.byteLength(ARCHIVED_TRIM_MARKER)) / 2));
  const buf = Buffer.from(text);
  const head = buf.subarray(0, half).toString('utf8').replace(/\uFFFD+$/, '');
  const tail = buf.subarray(Math.max(half, buf.length - half)).toString('utf8').replace(/^\uFFFD+/, '');
  return `${head}${ARCHIVED_TRIM_MARKER}${tail}`;
}

/** Head+tail trims large raw text outputs inside an archived tool payload while preserving diffs and metadata. */
function trimToolPayloadOutputs(payload: unknown, keepBytes: number): Record<string, unknown> | undefined {
  if (!isPlainRecord(payload) || !isPlainRecord(payload.data)) return undefined;
  let changed = false;
  const data: Record<string, unknown> = { ...payload.data };
  if (Array.isArray(data.content)) {
    data.content = data.content.map(block => {
      if (!isPlainRecord(block) || block.type === 'diff') return block;
      if (block.type === 'content' && isPlainRecord(block.content) && block.content.type === 'text' && typeof block.content.text === 'string') {
        const trimmed = headTailTrim(block.content.text, keepBytes);
        if (trimmed !== undefined) { changed = true; return { ...block, content: { ...block.content, text: trimmed } }; }
      }
      return block;
    });
  }
  if (typeof data.rawOutput === 'string') {
    const trimmed = headTailTrim(data.rawOutput, keepBytes);
    if (trimmed !== undefined) { changed = true; data.rawOutput = trimmed; }
  } else if (isPlainRecord(data.rawOutput)) {
    let rawChanged = false;
    const nextRaw: Record<string, unknown> = { ...data.rawOutput };
    for (const [key, value] of Object.entries(nextRaw)) {
      if (typeof value === 'string') {
        const trimmed = headTailTrim(value, keepBytes);
        if (trimmed !== undefined) { nextRaw[key] = trimmed; rawChanged = true; }
      }
    }
    if (rawChanged) { changed = true; data.rawOutput = nextRaw; }
  }
  return changed ? { ...payload, data } : undefined;
}
