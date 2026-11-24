import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { STORAGE_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import type { SyncLane } from '../../../../packages/contracts/src/sync.js';
import { AppError } from '../errors.js';

/** Largest payload kept inline in `journal_events`; anything bigger spills to CAS `blobs` (fits one 4 KiB page). */
export const JOURNAL_PAYLOAD_LIMIT = STORAGE_BUDGET.journalInlineBytes;
export const FOLD_BATCH = 2000;
export const COMPACT_BATCH = 500;
export const PREVIEW_TEXT = STORAGE_BUDGET.journalPreviewChars;
export const SCHEMA_MARKER = 'journal-schema';
export const SCHEMA_VERSION = 4;
export const DICT_RECOMPRESS_MARKER = 'blob-dict-v1-cursor';

/** Kinds that exist in the log but are not part of the transcript a client sees. */
export const DRAFT_KIND = 'draft';
export const TOMBSTONE_KIND = 'tombstone';
export const META_PREFIX = 'meta.';
export const isHiddenKind = (kind: string): boolean => kind === DRAFT_KIND || kind === TOMBSTONE_KIND || kind.startsWith(META_PREFIX);
export const SESSION_UPDATE_KIND = 'session/update';

export const COMPACTABLE_KINDS_SQL = "'tool_call','tool_call_update','agent_message_chunk','agent_thought_chunk','session/update'";
export const ARCHIVED_TRIM_MARKER = '\n... [archived tool output trimmed] ...\n';

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

export interface JournalAppend {
  sessionId: string;
  lane: SyncLane;
  scratch: boolean;
  generation?: string;
  fromSeq: number;
  toSeq: number;
  reset?: 'rebuilt' | 'dropped';
}

export interface JournalEventInput {
  kind: string;
  nativeId: string;
  turnId?: string;
  at?: string;
  payload: unknown;
  contentKey?: unknown;
}

export interface JournalHead {
  sessionId: string;
  generation: string;
  lastSeq: number;
  ingestCursor: string | null;
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
  payload: unknown;
}

export interface StoredJournalRow {
  seq: number;
  kind: string;
  nativeId: string;
  rev: number;
  turnId?: string;
  at: string;
  inline: string;
  blobRef?: string;
  blobSize?: number;
}

export interface JournalEntity extends JournalRow {
  identity: number;
}

export interface AppendOptions {
  cursor?: string | null;
  generation?: string;
}

export interface AppendedRow {
  nativeId: string;
  seq: number;
  identity: number;
  rev: number;
  written: boolean;
  created: boolean;
}

export interface AppendResult { head: JournalHead; rows: AppendedRow[]; }

export type SessionBlobResult = { size: number; type: string; bytes: () => Buffer };
export type FallbackBlobResolver = (sessionId: string, hash: string) => SessionBlobResult | undefined;

export class JournalGenerationChanged extends Error {
  constructor() { super('The session journal was rebuilt'); }
}

export class JournalSessionDeleted extends AppError {
  constructor(sessionId: string) { super('SESSION_DELETED', 'This conversation was deleted', 410, { sessionId }); }
}

export interface RawRow {
  seq: number; kind: string; native_id: string; rev: number; turn_id: string | null; at: string; payload: string; blob_ref: string | null; digest: string;
  blob_codec?: string | null; blob_external?: number | null; blob_bytes?: Uint8Array | null;
}

export interface HeadRow { session_id: string; generation: string; last_seq: number; ingest_cursor: string | null; identity: string | null; projection_seq: number; compacted_seq: number; updated_at: string }

export interface JournalOptions {
  blobsDir?: string;
  enclosingTransaction?: {
    active(): boolean;
    onSettle(fn: (committed: boolean) => void): void;
  };
}

export const SELECT_EVENT_COLS = `e.seq,e.kind,e.native_id,e.rev,e.turn_id,e.at,e.payload,e.blob_ref,e.digest,b.codec AS blob_codec,b.external AS blob_external,b.bytes AS blob_bytes`;
export const EVENT_JOIN = `LEFT JOIN blobs b ON b.hash=e.blob_ref`;

export const isPlainRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const MESSAGE_PREVIEW_BYTES = 2001;
export const MESSAGE_INLINE_BYTES = 3072;

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
    const isMessageChunk = payload.type === 'user_message_chunk' || payload.type === 'agent_message_chunk';
    const content = data.content;
    if (isPlainRecord(content)) {
      const text = content.text;
      if (typeof text === 'string') shallow.content = { type: typeof content.type === 'string' ? content.type : 'text', text: isMessageChunk ? clipUtf8(text, MESSAGE_PREVIEW_BYTES) : clip(text) };
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const inner = isPlainRecord(block) ? block.content : undefined;
        const text = isPlainRecord(inner) ? inner.text : undefined;
        if (typeof text === 'string' && text) {
          shallow.content = [{ type: 'content', content: { type: 'text', text: clip(text, 160) } }];
          break;
        }
      }
    }
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

export function initJournalSchema(db: DatabaseSync, sql: (text: string) => StatementSync): { bytesNotNull: boolean } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal_heads (
      session_id TEXT PRIMARY KEY, generation TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, ingest_cursor TEXT,
      projection TEXT, projection_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, identity TEXT,
      compacted_seq INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS journal_events (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, native_id TEXT NOT NULL, rev INTEGER NOT NULL,
      turn_id TEXT, at TEXT NOT NULL, digest TEXT NOT NULL, blob_ref TEXT, payload TEXT NOT NULL,
      PRIMARY KEY (session_id, seq));
    CREATE UNIQUE INDEX IF NOT EXISTS journal_native ON journal_events(session_id, native_id, rev);
    CREATE INDEX IF NOT EXISTS journal_turn ON journal_events(session_id, turn_id) WHERE turn_id IS NOT NULL AND payload<>'{}';
    CREATE INDEX IF NOT EXISTS journal_blob_ref ON journal_events(blob_ref) WHERE blob_ref IS NOT NULL;
    CREATE INDEX IF NOT EXISTS journal_open_drafts ON journal_events(kind) WHERE kind='draft' AND payload<>'{}';
    CREATE INDEX IF NOT EXISTS journal_session_updates ON journal_events(session_id, seq) WHERE kind='${SESSION_UPDATE_KIND}';
    CREATE TABLE IF NOT EXISTS blobs (
      hash TEXT PRIMARY KEY, size INTEGER NOT NULL, stored_size INTEGER NOT NULL DEFAULT 0,
      codec TEXT NOT NULL DEFAULT 'raw', external INTEGER NOT NULL DEFAULT 0, bytes BLOB, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_blobs (session_id TEXT NOT NULL, hash TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (session_id, hash));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);`);
  const marker = sql('SELECT json FROM settings WHERE key=?').get(SCHEMA_MARKER) as { json: string } | undefined;
  const version = marker ? Number(JSON.parse(marker.json)) : 0;
  if (version < SCHEMA_VERSION) {
    migrateJournalSchema(db, version);
    sql('INSERT INTO settings(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run(SCHEMA_MARKER, JSON.stringify(SCHEMA_VERSION));
  }
  const blobCols = db.prepare('PRAGMA table_info(blobs)').all() as Array<{ name: string; notnull: number }>;
  return { bytesNotNull: blobCols.some(col => col.name === 'bytes' && col.notnull === 1) };
}

function migrateJournalSchema(db: DatabaseSync, from: number): void {
  const hasColumn = (table: string, name: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(column => column.name === name);
  if (from < 2) {
    if (!hasColumn('journal_heads', 'identity')) db.exec('ALTER TABLE journal_heads ADD COLUMN identity TEXT');
  }
  if (from < 3) {
    if (!hasColumn('journal_heads', 'compacted_seq')) db.exec('ALTER TABLE journal_heads ADD COLUMN compacted_seq INTEGER NOT NULL DEFAULT 0');
    if (!hasColumn('blobs', 'stored_size')) db.exec('ALTER TABLE blobs ADD COLUMN stored_size INTEGER NOT NULL DEFAULT 0');
    if (!hasColumn('blobs', 'codec')) db.exec("ALTER TABLE blobs ADD COLUMN codec TEXT NOT NULL DEFAULT 'raw'");
    if (!hasColumn('blobs', 'external')) db.exec('ALTER TABLE blobs ADD COLUMN external INTEGER NOT NULL DEFAULT 0');
  }
  if (from < 4) {
    db.exec("DROP INDEX IF EXISTS journal_turn; CREATE INDEX IF NOT EXISTS journal_turn ON journal_events(session_id, turn_id) WHERE turn_id IS NOT NULL AND payload<>'{}';");
  }
}
