import { DatabaseSync, backup, type StatementSync } from 'node:sqlite';
import { mkdirSync, chmodSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { STORAGE_BUDGET, MESSAGE_SEARCH_BUDGET, type Project, type Session, type Run, type RunMetrics, type NativeBackendId, type NativeDeliveryState, type NativeRunConfig, type NativeRunDetails, type NativeRunInput, type CapturedSessionReference, type NativeSessionInput, type NativeContext, type NativeInteractionResult, type NativeTurnTarget, type TerminalInfo, type WorkbenchEvent, type AppSettings, type FolderFavorite, type TitleRule, type TitleRuleContext, matchTitleRule, renderDisplayTitle } from '../../../packages/contracts/src/index.js';
import { AppError } from './errors.js';
import { sessionReferenceInputs } from './context-references/input.js';
import { isNativeBackendId } from './backends/registry.js';
import { acceptedTitlePatch, firstHumanMessage, isPlaceholderTitle } from './session-title.js';
import type { IndexedMessage } from './search/messages.js';
import { Journal } from './journal/journal.js';
import { migrateStorageLayout, needsStorageLayoutMigration } from './journal/storage-migration.js';
import { LEGACY_DEFAULT_BACKEND_ID, applyNativeSessionIdPatch, restartObservation, legacyMirrorFields, normalizeRunIdentity, normalizeSessionIdentity, requestedNativeSessionId, type IdentifiedRun, type IdentifiedSession } from './session-identity.js';
import { eventLoopBusy } from './loop-health.js';
import { openSqliteDatabase, optimizeDatabase, quickCheckDatabase, reclaimFreePages, storageLayoutForControlDb, type StorageLayoutPaths } from './sqlite-storage.js';

const now = () => new Date().toISOString();
const SESSION_SNAPSHOTS_KEPT = STORAGE_BUDGET.sessionSnapshotsKept;
const SESSION_SNAPSHOT_PRUNE_EVERY = 10;
/** A retry id is only meaningful while its interaction can still be answered. */
const INTERACTION_RECEIPT_TTL_MS = 7 * 24 * 60 * 60_000;
const INTERACTION_RECEIPTS_PER_SESSION = 200;
/** A stored session's backend; rows written before `backendId` existed are Cursor's (see `session-identity.ts`). */
const STORED_BACKEND_ID_SQL = `COALESCE(json_extract(s.json,'$.backendId'),'${LEGACY_DEFAULT_BACKEND_ID}')`;
/** Narrows a prompt search to a conversation and can hide backends; nothing for a global one. */
function searchScope(sessionId?: string, excludedBackendIds?: readonly string[], excludeTaskWorkspaces = false, hidePluginAgents = false, assistantHistory = false): { clause: string; params: string[] } {
  const hidden = excludedBackendIds?.length ? excludedBackendIds : undefined;
  return {
    clause: (sessionId === undefined ? '' : ' AND s.id=?')
      + (hidden === undefined ? '' : ` AND ${STORED_BACKEND_ID_SQL} NOT IN (${hidden.map(() => '?').join(',')})`)
      + (hidePluginAgents ? ` AND ${STORED_BACKEND_ID_SQL} NOT LIKE '%.%'` : '')
      + (excludeTaskWorkspaces ? " AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id=s.project_id AND json_extract(p.json,'$.system')='task-workspace')" : '')
      + (assistantHistory ? " AND COALESCE(json_extract(s.json,'$.origin.kind'),'')<>'assistant' AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id=s.project_id AND json_extract(p.json,'$.system')='quick-chat')" : ''),
    params: [...(sessionId === undefined ? [] : [sessionId]), ...(hidden ?? [])],
  };
}
/** v4: spaces removed, plus project lifecycle rules; v5: deleted conversations (see the constructor). */
const SCHEMA_VERSION = 5;
/** A deleted conversation's id is kept here (settings key `session-deleted:<id>`), so no retried request recreates it. */
const DELETED_PREFIX = 'session-deleted:';
/** Settings a conversation owns outright, by key; removed with it. */
const SESSION_SETTING_PREFIXES = ['native-context:', 'native-interactions:', 'native-stops:', 'riffet-mcp:binding:', 'session-reference-creation:', 'task-workspace-creation:', 'terminal-hold:'];

/** What remains of a deleted conversation: no title, message or transcript, only enough to refuse its id. */
export interface DeletedSession {
  rootId: string;
  deletedAt: string;
  /** Files outside the database (chat log, context copies, plan mirrors) still to be removed. */
  cleanupPending: boolean;
  /** On the root only: every id deleted with it. */
  sessionIds?: string[];
}
function deepFreeze(value: object): void { Object.freeze(value); for (const inner of Object.values(value)) if (inner && typeof inner === 'object' && !Object.isFrozen(inner)) deepFreeze(inner); }
const ACTIVE_SESSION_STATES: ReadonlySet<Session['state']> = new Set(['starting', 'running', 'waiting', 'cancelling']);

/**
 * Provenance of a title a client supplied when it created the session. It is the client's own
 * wording rather than a provider's label, so it is marked `user`: the transcript rule must not
 * rewrite it later, and new clients leave the naming to the server instead (see `session-title.ts`).
 */
function clientTitleSource(title: string | undefined): Partial<Session> {
  return title && title.trim() && !isPlaceholderTitle(title) ? { titleSource: 'user' } : {};
}

/** One search result: a message, and enough about its conversation to open it. */
export interface MessageSearchHit {
  sessionId: string;
  projectId: string;
  sessionTitle: string;
  archived: boolean;
  backendId: NativeBackendId;
  messageId: string;
  kind: IndexedMessage['kind'];
  text: string;
  at: string;
  /**
   * The run a question came from, when it came from one. The client turns it into the timeline row
   * key it uses for that turn, which is how a result scrolls to the message it matched.
   */
  runId?: string;
}

function normalizeNativeInput(input: NativeRunInput): NativeRunInput {
  if (!input || typeof input.text !== 'string' || !Array.isArray(input.attachmentIds) || !Array.isArray(input.context)) {
    throw new AppError('INVALID_NATIVE_INPUT', 'Native input must include text, attachmentIds, and context');
  }
  if (input.attachmentIds.some((id) => typeof id !== 'string' || !id) || input.context.some((item) => !item || typeof item.path !== 'string' || !item.path || (item.line !== undefined && (!Number.isInteger(item.line) || item.line < 1)))) {
    throw new AppError('INVALID_NATIVE_INPUT', 'Native attachment and context references are invalid');
  }
  const references = sessionReferenceInputs(input.references);
  return {
    ...(references ? { references } : {}),
    text: input.text,
    attachmentIds: [...input.attachmentIds],
    context: input.context.map(({ path, line }) => ({ path, ...(line !== undefined ? { line } : {}) })),
  };
}

function normalizeNativeConfig(config: NativeRunConfig): NativeRunConfig {
  if (!config || typeof config.mode !== 'string' || !config.mode) throw new AppError('INVALID_NATIVE_CONFIG', 'Native run mode is required');
  if (config.mode.length > 100 || /[\0\r\n]/.test(config.mode)) throw new AppError('INVALID_NATIVE_CONFIG', 'Native run mode is invalid');
  if (config.model !== undefined && (typeof config.model !== 'string' || !config.model || config.model.length > 200 || /[\0\r\n]/.test(config.model))) throw new AppError('INVALID_NATIVE_CONFIG', 'Native run model is invalid');
  if (config.approval !== undefined && (typeof config.approval !== 'string' || !config.approval || config.approval.length > 100 || /[\0\r\n]/.test(config.approval))) throw new AppError('INVALID_NATIVE_CONFIG', 'Native run permission setting is invalid');
  return {
    ...(config.model !== undefined ? { model: config.model } : {}),
    mode: config.mode,
    ...(config.approval !== undefined ? { approval: config.approval } : {}),
  };
}

/** `details.sessionId` names the deleted id, which a creation retry's URL does not (it names the source). */
export function sessionDeleted(sessionId: string): AppError { return new AppError('SESSION_DELETED', 'This conversation was deleted', 410, { sessionId }); }

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Drops receipts past their TTL and the oldest beyond the per-session cap; `keepKey` always survives. */
export function retainedReceipts<T extends { createdAt: string }>(receipts: Record<string, T>, keepKey: string, nowMs = Date.now()): Record<string, T> {
  const age = (receipt: T) => { const at = Date.parse(receipt.createdAt); return Number.isFinite(at) ? at : nowMs; };
  const live = Object.entries(receipts).filter(([key, receipt]) => key === keepKey || nowMs - age(receipt) <= INTERACTION_RECEIPT_TTL_MS);
  const others = live.filter(([key]) => key !== keepKey).sort(([, a], [, b]) => age(b) - age(a)).slice(0, INTERACTION_RECEIPTS_PER_SESSION - 1);
  return Object.fromEntries([...others, ...live.filter(([key]) => key === keepKey)]);
}

function normalizedNativeSessionInput(input: NativeSessionInput) {
  if (!input || typeof input.projectId !== 'string' || !input.projectId) throw new AppError('INVALID_SESSION', 'A project is required');
  const backendId = input.backendId ?? LEGACY_DEFAULT_BACKEND_ID;
  if (!isNativeBackendId(backendId)) throw new AppError('INVALID_BACKEND', 'Choose a supported native backend');
  if (input.backendProfileId !== undefined && (typeof input.backendProfileId !== 'string' || !input.backendProfileId || input.backendProfileId.length > 200)) {
    throw new AppError('INVALID_BACKEND_PROFILE', 'Backend profile id is invalid');
  }
  const nativeSessionId = requestedNativeSessionId(input);
  if (nativeSessionId !== undefined && (typeof nativeSessionId !== 'string' || !nativeSessionId || nativeSessionId.length > 200 || /[\0\r\n]/.test(nativeSessionId))) throw new AppError('INVALID_NATIVE_SESSION_ID', 'Native session id is invalid');
  if (input.model !== undefined && (typeof input.model !== 'string' || !input.model || input.model.length > 200 || /[\0\r\n]/.test(input.model))) throw new AppError('INVALID_NATIVE_MODEL', 'Native model selection is invalid');
  if (input.mode !== undefined && (typeof input.mode !== 'string' || !input.mode || input.mode.length > 100 || /[\0\r\n]/.test(input.mode))) throw new AppError('INVALID_NATIVE_MODE', 'Native mode is invalid');
  if (input.approval !== undefined && (typeof input.approval !== 'string' || !input.approval || input.approval.length > 100 || /[\0\r\n]/.test(input.approval))) throw new AppError('INVALID_NATIVE_APPROVAL', 'Native permission setting is invalid');
  if (input.workItemId !== undefined && (typeof input.workItemId !== 'string' || !input.workItemId || input.workItemId.length > 100)) throw new AppError('INVALID_WORK_ITEM', 'workItemId must be a string of 1 to 100 characters');
  return {
    projectId: input.projectId,
    title: input.title || 'New conversation',
    tags: [...(input.tags ?? [])],
    ...(input.terminalAppearance ? { terminalAppearance: input.terminalAppearance } : {}),
    backendId: backendId as NativeBackendId,
    ...(input.backendProfileId ? { backendProfileId: input.backendProfileId } : {}),
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...legacyMirrorFields(backendId, nativeSessionId),
    ...(input.model !== undefined ? { model: input.model } : {}),
    mode: input.mode ?? 'agent',
    ...(input.approval !== undefined ? { approval: input.approval } : {}),
    resumePicker: Boolean(input.resumePicker),
    // Written only by the server's own launch paths; `POST /api/sessions` never passes one through.
    ...(input.origin ? { origin: { ...input.origin } } : {}),
    ...(input.toolGroups?.length ? { toolGroups: [...input.toolGroups] } : {}),
    ...(input.extensionsOff?.length ? { extensionsOff: [...input.extensionsOff] } : {}),
    ...(input.workItemId ? { workItemId: input.workItemId } : {}),
  };
}

/** A `FolderFavorite` as stored; `exists` is checked on every read. */
export type StoredFolderFavorite = Omit<FolderFavorite, 'exists'>;

export class Store {
  /** L0 authoritative control-plane database (`workbench.db`). */
  readonly db: DatabaseSync;
  /** L1 append-only session journal and compressed Tier-1 CAS database (`journal.db`). */
  readonly journalDb: DatabaseSync;
  /** L2 rebuildable derived views database (`derived.db`: timeline + FTS5 message search). */
  readonly derivedDb: DatabaseSync;
  /** Companion file paths for disk-backed stores; undefined for `:memory:`. */
  readonly layout: StorageLayoutPaths | undefined;
  /** Per-session append-only transcript log; see `journal/journal.ts`. */
  readonly journal: Journal;
  private listeners = new Map<string, Set<(event: WorkbenchEvent) => void>>();
  private depth = 0;
  private derivedDepth = 0;
  private pending: WorkbenchEvent[] = [];
  private runListeners = new Set<(run: Run) => void>();
  private pendingRuns = new Map<string, Run>();
  private listListeners = new Set<() => void>();
  private stateListeners = new Set<(session: Session, from: Session['state']) => void>();
  private deletionListeners = new Map<string, Set<() => void>>();
  private listsDirty = false;
  /** Told how the open transaction ended; see {@link afterTransaction}. */
  private settleHooks: Array<(committed: boolean) => void> = [];
  /** Companion DB transaction coordinators settled before listeners/hooks observe the commit. */
  private txCoordinators: Array<(committed: boolean) => void> = [];
  /**
   * Bumped by every change to a session (docs/LIST-SYNC.md); it is the validator behind the session
   * list ETag and the `changed` event's `revision`. Seeded from the clock so a restart never reissues
   * a revision a client may still hold.
   */
  private listRevisionValue = Date.now();
  /** The session revision this process started at: a `since` older than it may have missed changes. */
  private readonly listRevisionFloor = this.listRevisionValue;
  /** The session revision of each session's last change in this process, deleted ones included. */
  private readonly sessionRevisions = new Map<string, number>();
  /** Terminals move on their own, so a session change never re-reads them. */
  private terminalsRevisionValue = Date.now();
  /** Projects move independently of conversation activity, so clients can refresh workspaces without polling on every session event. */
  private projectRevisionValue = Date.now();
  /** The same for saved replies, behind the marks ETag; it moves without the list revision, so a mark never refetches the sidebar. */
  private marksRevisionValue = Date.now();
  /** Work items (任务), behind their own ETag like marks. */
  private workItemsRevisionValue = Date.now();
  /** Folder favorites (every scope); like marks it moves without the list revision. */
  private favoritesRevisionValue = Date.now();
  private sessionSnapshotAppends = new Map<string, number>();
  /** Every statement this store runs is one of a fixed set of texts, so each is compiled once. */
  private readonly statements = new Map<string, StatementSync>();
  private readonly derivedStatements = new Map<string, StatementSync>();
  constructor(readonly path: string) {
    this.layout = storageLayoutForControlDb(path);
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (needsStorageLayoutMigration(path)) {
        try { migrateStorageLayout(path); } catch (error) { console.error('[riffet] storage layout migration failed:', error); throw error; }
      }
    }
    this.db = openSqliteDatabase(path, { foreignKeys: true, role: 'control' });
    const schemaVersion=(this.sql('PRAGMA user_version').get() as {user_version:number}).user_version;
    if(schemaVersion>SCHEMA_VERSION){this.db.close();throw new AppError('DATABASE_VERSION_NEWER','This workbench database requires a newer Riffet version',409);}
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_waiting_owner ON sessions(id) WHERE json_extract(json,'$.state')='waiting' AND json_extract(json,'$.archivedAt') IS NULL;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), command_id TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(session_id,command_id));
      CREATE INDEX IF NOT EXISTS run_native_unfinished ON runs(session_id, json_extract(json,'$.native.delivery'))
        WHERE json_extract(json,'$.native.delivery') IN ('queued','preparing','dispatching','input_sent','observed','uncertain')
          AND json_extract(json,'$.state') NOT IN ('completed','failed','cancelled');
      CREATE INDEX IF NOT EXISTS run_native_turn ON runs(session_id,
        json_extract(json,'$.native.nativeSessionId'), json_extract(json,'$.native.nativeTurnId'));
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_session_seq ON events(session_id,sequence);
      CREATE TABLE IF NOT EXISTS terminals (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workbench_document_proofs (digest TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      -- Lets snapshot pruning find one session's events of one type without parsing every row.
      CREATE INDEX IF NOT EXISTS event_session_type ON events(session_id, json_extract(json,'$.type'), sequence);
      -- Saved replies (see marks.ts). Additive, and deliberately without a foreign key: a mark outlives
      -- its conversation, and reads as orphaned once the conversation is gone.
      CREATE TABLE IF NOT EXISTS marks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS marks_session ON marks(session_id);
      CREATE INDEX IF NOT EXISTS marks_created ON marks(created_at, id);
      -- Remote shares outlive their local conversation; no cascading foreign key.
      CREATE TABLE IF NOT EXISTS session_shares (id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, json TEXT NOT NULL);
      -- Folder favorites. Additive; project_id is '' for host-level ones so one folder is one row per scope.
      -- No foreign key: deleteProject removes a project's own favorites itself.
      CREATE TABLE IF NOT EXISTS folder_favorites (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(project_id, path));
      -- Multi-model discussions (council). Additive and unversioned.
      CREATE TABLE IF NOT EXISTS council_discussions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS council_updated ON council_discussions(updated_at DESC, id);`);
    // L1 journal database (independent write lock + optional Tier-2 external blobs directory).
    this.journalDb = openSqliteDatabase(this.layout?.journal ?? ':memory:', { role: 'journal' });
    this.journal = new Journal(
      this.journalDb,
      undefined,
      undefined,
      id => this.isSessionDeleted(id),
      {
        ...(this.layout ? { blobsDir: this.layout.blobsDir } : {}),
        enclosingTransaction: { active: () => this.depth > 0, onSettle: fn => { if (this.depth) this.txCoordinators.push(fn); else fn(true); } },
      },
    );
    // L2 derived database (timeline + FTS5 search). Pure materialized cache: recreate on corruption.
    this.derivedDb = this.openDerivedDatabase();
    try { this.ensureMessageSearchIndex(); } catch (error) { console.error('[riffet] message search index unavailable; search falls back to a table scan:', error); }
    // Schema v2 removed the ACP backend. `purgeAcpConversations` writes `user_version` only as part
    // of the transaction that commits the purge, so a failure leaves the database at v1 and the next
    // start retries. Like the activity backfill below, it must not stop the workbench from opening.
    if (schemaVersion < 2) {
      try { this.purgeAcpConversations(); } catch (error) { console.error('[riffet] store migration purge-acp (schema v2) failed; retrying on next start:', error); }
    }
    // Schema v3 added project lifecycle rules an older binary would not enforce (deleting a project
    // other projects are worktrees of). Recording v3 makes such a binary refuse this database instead
    // of bypassing it. Only a database that reached v2 moves on, so a failed v2 purge is still retried.
    // The project-level sharing tables of an unreleased build are dropped: they hold nothing but a
    // switch.
    const userVersion = () => (this.sql('PRAGMA user_version').get() as {user_version:number}).user_version;
    if (userVersion() === 2) this.db.exec('PRAGMA user_version=3;');
    this.db.exec('DROP TABLE IF EXISTS project_entry_revisions; DROP TABLE IF EXISTS project_entries; DROP TABLE IF EXISTS project_mutations; DROP TABLE IF EXISTS project_credentials; DROP TABLE IF EXISTS project_injections; DROP TABLE IF EXISTS project_messages; DROP TABLE IF EXISTS project_contexts;');
    // Schema v4 removes spaces. The version is recorded only after the tables are gone and the stored
    // references are stripped, so a failure leaves v3 and the next start retries; the feature itself
    // is already gone from this binary, so leaving the rows behind cannot affect it.
    const dropSpaceTables = `DROP TABLE IF EXISTS space_entry_revisions; DROP TABLE IF EXISTS space_entries; DROP TABLE IF EXISTS space_messages;
      DROP TABLE IF EXISTS space_injections; DROP TABLE IF EXISTS space_credentials; DROP TABLE IF EXISTS space_mutations;
      DROP INDEX IF EXISTS session_space; DROP TABLE IF EXISTS spaces;`;
    const scrubSpaceReferences = `UPDATE sessions SET json=json_remove(json,'$.spaceId') WHERE json_extract(json,'$.spaceId') IS NOT NULL;
      UPDATE runs SET json=json_remove(json,'$.native.spaceContext') WHERE json_extract(json,'$.native.spaceContext') IS NOT NULL;`;
    let spacesRemoved = false;
    if (userVersion() === 3) {
      try {
        this.transaction(() => {
          this.db.exec(dropSpaceTables);
          this.db.exec(scrubSpaceReferences);
          this.db.exec('PRAGMA user_version=4;');
        });
        spacesRemoved = true;
      } catch (error) { console.error('[riffet] store migration drop-spaces (schema v4) failed; retrying on next start:', error); }
    }
    // A database whose earlier migration kept failing can still carry the tables an older binary
    // created. Drop and scrub it in the same pass, so no start leaves the tables gone but the
    // stored references behind.
    if (!spacesRemoved) {
      try { this.db.exec(dropSpaceTables); this.db.exec(scrubSpaceReferences); } catch (error) { console.error('[riffet] store cleanup spaces failed; retrying on next start:', error); }
    }
    // Schema v5 deletes conversations and keeps their ids (`DELETED_PREFIX`). An older binary would not
    // check them and could recreate a deleted id from a retried request, so it must refuse this database.
    if (userVersion() === 4) this.db.exec('PRAGMA user_version=5;');
    // The backfill rewrites every session row inside one transaction. A failure here (lock timeout, a
    // legacy row whose JSON no longer parses) must not stop the workbench from opening: leaving the
    // marker unset means the next start retries, and until then activity order falls back to the
    // stored timestamps exactly as it did before the migration existed.
    if (!this.getSetting('session-last-activity-backfill-v1', false)) {
      try { this.backfillSessionActivity(); } catch (error) { console.error('[riffet] store migration session-last-activity-backfill-v1 failed; retrying on next start:', error); }
    }
    // Read state starts with everything already there seen, so an upgrade does not mark every old
    // conversation unread. Retried on the next start like the backfill above, and only after it: seen read
    // from a `lastActivityAt` that backfill later moves forward would turn old conversations unread.
    if (this.getSetting('session-last-activity-backfill-v1', false) && !this.getSetting('session-seen-backfill-v1', false)) {
      try {
        this.transaction(() => {
          this.db.exec(`UPDATE sessions SET json=json_set(json,'$.seenActivityAt',COALESCE(json_extract(json,'$.lastActivityAt'),json_extract(json,'$.createdAt')))
            WHERE json_extract(json,'$.seenActivityAt') IS NULL`);
          this.setSetting('session-seen-backfill-v1', true);
        });
      } catch (error) { console.error('[riffet] store migration session-seen-backfill-v1 failed; retrying on next start:', error); }
    }
    // The in-memory prune counter never reaches a conversation that is not written to after a
    // restart, so every start trims all of them once. Indexed per session, so a second start is cheap.
    try { this.pruneAllSnapshots(); } catch (error) { console.error('[riffet] startup snapshot pruning failed; retrying on next start:', error); }
  }
  private openDerivedDatabase(): DatabaseSync {
    const derivedPath = this.layout?.derived ?? ':memory:';
    const init = (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS message_index (
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          text TEXT NOT NULL,
          at TEXT NOT NULL,
          PRIMARY KEY (session_id, message_id));
        CREATE INDEX IF NOT EXISTS message_index_session ON message_index(session_id); CREATE INDEX IF NOT EXISTS message_index_at ON message_index(at);
        CREATE TABLE IF NOT EXISTS message_index_sessions (session_id TEXT PRIMARY KEY, indexed_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS derived_meta (key TEXT PRIMARY KEY, json TEXT NOT NULL);`);
      return db;
    };
    let opened: DatabaseSync | undefined;
    try {
      opened = openSqliteDatabase(derivedPath, { role: 'derived' });
      if (derivedPath !== ':memory:' && !quickCheckDatabase(opened)) {
        throw new Error('derived.db failed PRAGMA quick_check');
      }
      return init(opened);
    } catch (error) {
      if (opened) { try { opened.close(); } catch { /* ignore */ } }
      if (derivedPath === ':memory:') throw error;
      console.warn('[riffet] derived.db could not be opened or failed integrity check; recreating rebuildable cache:', error);
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${derivedPath}${suffix}`, { force: true });
      return init(openSqliteDatabase(derivedPath, { role: 'derived' }));
    }
  }
  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) this.statements.set(text, statement = this.db.prepare(text));
    return statement;
  }
  private derivedSql(text: string): StatementSync {
    let statement = this.derivedStatements.get(text);
    if (!statement) this.derivedStatements.set(text, statement = this.derivedDb.prepare(text));
    return statement;
  }
  private derivedTx<T>(fn: () => T): T {
    if (this.derivedDepth) return fn();
    this.derivedDb.exec('BEGIN IMMEDIATE');
    this.derivedDepth += 1;
    try { const result = fn(); this.derivedDb.exec('COMMIT'); this.derivedDepth -= 1; return result; }
    catch (error) { this.derivedDb.exec('ROLLBACK'); this.derivedDepth -= 1; throw error; }
  }
  private getDerivedMeta<T>(key: string, fallback: T): T {
    const row = this.derivedSql('SELECT json FROM derived_meta WHERE key=?').get(key) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as T : fallback;
  }
  private setDerivedMeta(key: string, value: unknown): void {
    this.derivedSql('INSERT INTO derived_meta(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run(key, JSON.stringify(value));
  }
  /**
   * Trigram index over `message_index.text`, so a substring search reads candidates instead of
   * every message. External content keeps the text stored once; `detail=none` keeps the index at
   * about the size of the text. The index only proposes rows: a search re-checks each candidate
   * against `message_index` itself, so a stale entry can hide nothing it should not, only miss.
   * Rows are linked by rowid, which a full VACUUM may renumber; the start-up check rebuilds then.
   */
  private ensureMessageSearchIndex(): void {
    const exists = this.derivedSql("SELECT 1 AS found FROM sqlite_master WHERE name='message_index_fts'").get();
    this.derivedDb.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS message_index_fts USING fts5(text, tokenize='trigram', detail=none, content='message_index', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS message_index_fts_insert AFTER INSERT ON message_index BEGIN
        INSERT INTO message_index_fts(rowid,text) VALUES (new.rowid,new.text); END;
      CREATE TRIGGER IF NOT EXISTS message_index_fts_update AFTER UPDATE OF text ON message_index WHEN old.text IS NOT new.text BEGIN
        INSERT INTO message_index_fts(message_index_fts,rowid,text) VALUES ('delete',old.rowid,old.text);
        INSERT INTO message_index_fts(rowid,text) VALUES (new.rowid,new.text); END;
      CREATE TRIGGER IF NOT EXISTS message_index_fts_delete AFTER DELETE ON message_index BEGIN
        INSERT INTO message_index_fts(message_index_fts,rowid,text) VALUES ('delete',old.rowid,old.text); END;`);
    const shape = this.derivedSql('SELECT COUNT(*) AS total, COALESCE(MAX(rowid),0) AS top FROM message_index').get() as { total: number; top: number };
    const marker = this.getDerivedMeta<{ total: number; top: number } | undefined>('message-index-fts-v1', undefined);
    if (exists && marker && marker.total === shape.total && marker.top === shape.top) return;
    if (exists && marker === undefined && shape.total === 0) { this.setDerivedMeta('message-index-fts-v1', shape); return; }
    this.derivedDb.exec("INSERT INTO message_index_fts(message_index_fts) VALUES('rebuild')");
    this.setDerivedMeta('message-index-fts-v1', shape);
  }
  /** Records the shape the search index was last known to match, for the next start's check. */
  private noteMessageIndexShape(): void {
    try { this.setDerivedMeta('message-index-fts-v1', this.derivedSql('SELECT COUNT(*) AS total, COALESCE(MAX(rowid),0) AS top FROM message_index').get()); } catch { /* checked again next start */ }
  }
  pruneAllSnapshots(): number {
    const ids = (this.sql('SELECT id FROM sessions').all() as Array<{ id: string }>).map(row => row.id);
    let removed = 0;
    this.transaction(() => {
      for (const id of ids) removed += this.pruneSessionSnapshots(id) + this.pruneRunSnapshots(id);
    });
    // Freed pages are reused by later writes either way; a database created with incremental
    // auto-vacuum can also give them back to the file system without a blocking full VACUUM.
    if (removed && (this.sql('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum === 2) this.db.exec('PRAGMA incremental_vacuum(5000)'); // bounded so a start never stalls on a large freed range; `riffet doctor --compact` reclaims the rest
    return removed;
  }
  private get<T>(table: string, id: string): T | undefined {
    const row = this.sql(`SELECT json FROM ${table} WHERE id=?`).get(id) as {json: string} | undefined;
    return row ? JSON.parse(row.json) as T : undefined;
  }
  private all<T>(table: string): T[] { return (this.sql(`SELECT json FROM ${table} ORDER BY rowid`).all() as {json: string}[]).map(row => JSON.parse(row.json) as T); }
  /*
   * The store is the compatibility boundary (`session-identity.ts`): every session and run leaves it
   * with its backend and provider chat resolved, whatever shape the row was written in.
   */
  private session(json: string): IdentifiedSession { return normalizeSessionIdentity(JSON.parse(json) as Session); }
  private run(json: string): IdentifiedRun { return this.identified(JSON.parse(json) as Run); }
  /** Also what every run write passes through, so a stored Cursor run keeps its `cursorSessionId` mirror. */
  private identified(run: Run): IdentifiedRun { return normalizeRunIdentity(run, () => this.ownerBackendId(run.sessionId)); }
  /**
   * Every session, parsed once and kept until a session write (`sessionsChanged`) or a rollback; docs/guide/performance.md §3.3.
   * The cache is never handed out: callers get top-level copies whose nested values are frozen, so a caller
   * that edits what it was given cannot corrupt the next caller's list.
   */
  private sessionCache: IdentifiedSession[] | undefined;
  private allSessions(): IdentifiedSession[] {
    this.sessionCache ??= (this.sql('SELECT json FROM sessions ORDER BY rowid').all() as {json: string}[]).map(row => {
      const session = this.session(row.json);
      for (const value of Object.values(session)) if (value && typeof value === 'object') deepFreeze(value);
      return session;
    });
    return this.sessionCache.map(session => ({...session}));
  }
  private ownerBackendId(sessionId: string): NativeBackendId | undefined {
    const row = this.sql("SELECT json_extract(json,'$.backendId') AS backendId FROM sessions WHERE id=?").get(sessionId) as { backendId: NativeBackendId | null } | undefined;
    return row?.backendId ?? undefined;
  }
  private replace(table: string, id: string, value: unknown) { this.sql(`UPDATE ${table} SET json=? WHERE id=?`).run(JSON.stringify(value), id); }
  private assertNativeIdentityAvailable(candidate: IdentifiedSession, ignoreSessionId?: string, ignoreRunSessionId?: string): void {
    if (candidate.kind !== 'native' || candidate.archivedAt || !candidate.nativeSessionId) return;
    const { backendId, nativeSessionId } = candidate;
    const sessions = this.allSessions();
    const activeRuns = this.listUnfinishedNativeRuns();
    for (const run of activeRuns) {
      if (run.sessionId === ignoreRunSessionId) continue;
      if (run.native?.backendId === backendId && run.native.nativeSessionId === nativeSessionId) {
        throw new AppError('NATIVE_SESSION_ID_IN_USE', 'This native session is still referenced by an unresolved run', 409, {
          backendId,
          ownerSessionId: run.sessionId,
          runId: run.id,
        });
      }
    }
    for (const owner of sessions) {
      if (owner.id === ignoreSessionId || owner.kind !== 'native') continue;
      if (owner.backendId !== backendId || owner.nativeSessionId !== nativeSessionId) continue;
      if (!owner.archivedAt || activeRuns.some(run => run.sessionId === owner.id)) {
        throw new AppError('NATIVE_SESSION_ID_IN_USE', 'This native session is already bound to another conversation', 409, {
          backendId,
          ownerSessionId: owner.id,
        });
      }
    }
  }
  private backfillSessionActivity(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const sessions = this.sql('SELECT id,json FROM sessions').all() as Array<{ id: string; json: string }>;
      const latestRun = new Map((this.sql("SELECT session_id,MAX(json_extract(json,'$.createdAt')) AS at FROM runs GROUP BY session_id").all() as Array<{ session_id: string; at: string | null }>).flatMap(row => row.at ? [[row.session_id, row.at] as const] : []));
      const latestMessage = new Map((this.sql(`SELECT session_id,MAX(json_extract(json,'$.createdAt')) AS at FROM events
        WHERE json_extract(json,'$.type') IN ('user_message_chunk','agent_message_chunk','agent_thought_chunk','tool_call','tool_call_update','plan','question_answer')
        GROUP BY session_id`).all() as Array<{ session_id: string; at: string | null }>).flatMap(row => row.at ? [[row.session_id, row.at] as const] : []));
      for (const row of sessions) {
        const session = JSON.parse(row.json) as Session;
        if (typeof session.lastActivityAt === 'string' && Number.isFinite(Date.parse(session.lastActivityAt))) continue;
        const candidates = [session.createdAt, latestRun.get(row.id), latestMessage.get(row.id)]
          .filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
          .map(value => new Date(value).toISOString());
        session.lastActivityAt = candidates.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? now();
        this.sql('UPDATE sessions SET json=? WHERE id=?').run(JSON.stringify(session), row.id);
      }
      this.sql('INSERT INTO settings(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run('session-last-activity-backfill-v1', JSON.stringify(true));
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /**
   * Schema v2 cleanup: drop the ACP-only `interactions` table and every non-native conversation
   * with its runs and events. The version bump is the last statement in the transaction, so the
   * migration is only recorded once it has actually committed; a failure rolls everything back and
   * leaves `user_version` at 1 for the next start to retry.
   */
  private purgeAcpConversations(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Drop the ACP-only table first: its foreign key would otherwise block the session delete.
      this.db.exec('DROP TABLE IF EXISTS interactions;');
      const acp = (this.sql("SELECT id FROM sessions WHERE json_extract(json,'$.kind') IS NOT 'native'").all() as Array<{ id: string }>).map(row => row.id);
      const removeEvents = this.sql('DELETE FROM events WHERE session_id=?');
      const removeRuns = this.sql('DELETE FROM runs WHERE session_id=?');
      const removeSession = this.sql('DELETE FROM sessions WHERE id=?');
      for (const id of acp) { removeEvents.run(id); removeRuns.run(id); removeSession.run(id); }
      this.db.exec('PRAGMA user_version=2;');
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try {
      const result = fn(); this.db.exec('COMMIT'); this.depth--;
      // Settle companion DB transactions (L1 journalDb) BEFORE broadcasting events or running hooks.
      for (const coord of this.txCoordinators.splice(0)) { try { coord(true); } catch (error) { console.error('[riffet] transaction coordinator failed:', error); } }
      const events = this.pending.splice(0); for (const event of events) this.broadcast(event);
      const runs = [...this.pendingRuns.values()]; this.pendingRuns.clear(); for (const run of runs) this.emitRun(run);
      if (this.listsDirty) { this.listsDirty = false; this.emitLists(); }
      for (const hook of this.settleHooks.splice(0)) { try { hook(true); } catch (error) { console.error('[riffet] afterTransaction hook failed:', error); } }
      return result;
    }
    catch (error) {
      this.sessionCache = undefined;
      this.db.exec('ROLLBACK'); this.depth--; this.pending.length = 0; this.pendingRuns.clear(); this.listsDirty = false;
      for (const coord of this.txCoordinators.splice(0)) { try { coord(false); } catch (coordError) { console.error('[riffet] transaction rollback coordinator failed:', coordError); } }
      for (const hook of this.settleHooks.splice(0)) { try { hook(false); } catch (hookError) { console.error('[riffet] afterTransaction rollback hook failed:', hookError); } }
      throw error;
    }
  }
  /** Runs `fn` once the open transaction has ended, with whether it committed; at once (committed) when none is open. */
  afterTransaction(fn: (committed: boolean) => void): void {
    if (this.depth) this.settleHooks.push(fn); else fn(true);
  }
  /** Committed run writes, for derived views such as the statistics ledger. Listener errors are swallowed. */
  onRunChanged(listener: (run: Run) => void): () => void {
    this.runListeners.add(listener);
    return () => { this.runListeners.delete(listener); };
  }
  private runChanged(run: Run) {
    if (!this.runListeners.size) return;
    if (this.depth) this.pendingRuns.set(run.id, run); else this.emitRun(run);
  }
  /**
   * A conversation's `state` changed, told inside the write that changed it so a listener's own
   * write commits or rolls back with it. Listener errors are swallowed.
   */
  onSessionState(listener: (session: Session, from: Session['state']) => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }
  /** Committed changes to projects, sessions, terminals or saved replies — what the sidebar lists. Listener errors are swallowed. */
  onListsChanged(listener: () => void): () => void {
    this.listListeners.add(listener);
    return () => { this.listListeners.delete(listener); };
  }
  /** The session list's revision; the name predates the per-list revisions. */
  get listRevision(): number { return this.listRevisionValue; }
  get terminalsRevision(): number { return this.terminalsRevisionValue; }
  get projectRevision(): number { return this.projectRevisionValue; }
  get marksRevision(): number { return this.marksRevisionValue; }
  get workItemsRevision(): number { return this.workItemsRevisionValue; }
  get favoritesRevision(): number { return this.favoritesRevisionValue; }
  /**
   * The sessions changed after [since], or undefined when this process cannot tell: [since] is from
   * before it started (a restart may have lost changes) or ahead of it (a restored backup). A
   * listed id may since have been deleted; a rolled-back write lists an unchanged one.
   */
  sessionsChangedSince(since: number): string[] | undefined {
    if (!Number.isSafeInteger(since) || since < this.listRevisionFloor || since > this.listRevisionValue) return undefined;
    return [...this.sessionRevisions].flatMap(([id, revision]) => revision > since ? [id] : []);
  }
  findSession(id: string): IdentifiedSession | undefined {
    const item = this.get<Session>('sessions', id);
    return item && normalizeSessionIdentity(item);
  }
  private sessionsChanged(ids: readonly string[]) {
    this.sessionCache = undefined;
    this.listRevisionValue += 1;
    for (const id of ids) this.sessionRevisions.set(id, this.listRevisionValue);
    this.notifyLists();
  }
  private terminalsChanged() {
    this.terminalsRevisionValue += 1;
    this.notifyLists();
  }
  /** A project's classification decides who sees its sessions and terminals, so those move with it. */
  private projectsChanged(classified?: string) {
    this.projectRevisionValue += 1;
    if (classified === undefined) { this.notifyLists(); return; }
    this.sessionsChanged((this.sql('SELECT id FROM sessions WHERE project_id=?').all(classified) as Array<{ id: string }>).map(row => row.id));
    this.terminalsChanged();
  }
  /** Called by every committed mark write, and when a conversation holding marks is renamed (marks show its current title). */
  marksChanged() {
    this.marksRevisionValue += 1;
    this.notifyLists();
  }
  /** Called by every committed work item write; the lists stream carries it as `workItems`. */
  workItemsChanged() {
    this.workItemsRevisionValue += 1;
    this.notifyLists();
  }
  /** Called by every committed folder-favorite write; the lists stream carries it as `favorites`. */
  private favoritesChanged() {
    this.favoritesRevisionValue += 1;
    this.notifyLists();
  }
  private notifyLists() {
    if (!this.listListeners.size) return;
    if (this.depth) this.listsDirty = true; else this.emitLists();
  }
  private emitLists() { for (const listener of this.listListeners) { try { listener(); } catch { /* derived views must not fail a committed write */ } } }
  private emitRun(run: Run) { for (const listener of this.runListeners) { try { listener(run); } catch { /* derived views must not fail a committed write */ } } }
  createProject(cwd: string, name: string, worktree?: Project['worktree']): Project {
    const existing = this.listProjects().find(project => project.cwd === cwd);
    // A directory added by hand before anyone linked it to its origin keeps its id and history;
    // only the missing relationship is filled in.
    if (existing) {
      if (!worktree || existing.worktree) return existing;
      // An origin that descends from this project would make the chain a loop.
      if (this.originChain(worktree.originProjectId).includes(existing.id)) throw new AppError('PROJECT_ORIGIN_CYCLE', 'This project is an origin of that worktree; linking it back would form a loop', 409);
      return this.updateProject(existing.id, {worktree});
    }
    const project: Project = {id: randomUUID(), cwd, name, ...(worktree?{worktree}:{}), createdAt: now(), updatedAt: now()};
    this.sql('INSERT INTO projects(id,json) VALUES(?,?)').run(project.id, JSON.stringify(project)); this.projectsChanged(); return project;
  }
  getProject(id: string): Project { const item = this.get<Project>('projects', id); if (!item) throw new AppError('PROJECT_NOT_FOUND', 'Project does not exist', 404); return item; }
  /** The reserved identity must be inserted with its first session and run, never exposed alone. */
  createTaskWorkspaceSubmission(project: Project, clientSessionId: string, sessionInput: NativeSessionInput, commandId: string, input: NativeRunInput, contextSnapshots?: CapturedSessionReference[]): { project: Project; session: Session; run: Run } {
    return this.transaction(() => {
      if(project.system!=='task-workspace'||sessionInput.projectId!==project.id)throw new AppError('TASK_WORKSPACE_CONFLICT','The reserved task and session must share a managed project identity',409);
      const existing = this.get<Project>('projects', project.id);
      if (existing && (existing.cwd !== project.cwd || existing.system !== 'task-workspace')) throw new AppError('TASK_WORKSPACE_CONFLICT', 'The reserved project identity has another directory or classification', 409);
      if (!existing) {
        if (this.listProjects().some(item => item.cwd === project.cwd)) throw new AppError('TASK_WORKSPACE_CONFLICT', 'The reserved directory already belongs to another project', 409);
        this.sql('INSERT INTO projects(id,json) VALUES(?,?)').run(project.id, JSON.stringify(project));
        this.projectsChanged();
      }
      const result = this.createNativeSubmission(clientSessionId, sessionInput, commandId, input, contextSnapshots);
      return { project: this.getProject(project.id), ...result };
    });
  }
  /** Saving changes classification only; the receipt makes concurrent and lost-response retries safe. */
  promoteTaskWorkspace(id: string, name: string): Project {
    return this.transaction(() => {
      const project = this.getProject(id);
      const key = `task-workspace-promotion:${id}`;
      const receipt = this.getSetting<{ name: string } | undefined>(key, undefined);
      if (receipt) {
        if (receipt.name !== name) throw new AppError('PROJECT_PROMOTION_CONFLICT', 'This task was already saved with another name', 409);
        return project;
      }
      if (project.system !== 'task-workspace') throw new AppError('INVALID_PROJECT_PROMOTION', 'Only a task workspace can be saved as a project', 409);
      const updated = this.updateProject(id, { name, system: undefined });
      // Older clients can now see replies saved in this project, including cached empty lists.
      this.marksChanged();
      this.setSetting(key, { name });
      return updated;
    });
  }
  listProjects(): Project[] { return this.all<Project>('projects'); }
  updateProject(id: string, patch: Partial<Project>): Project {
    return this.transaction(() => {
      const current = this.getProject(id), item = {...current, ...patch, id, updatedAt: now()};
      this.replace('projects', id, item); this.projectsChanged(current.system === item.system ? undefined : id);
      // A rule reads the project's directory and name, a worktree's included.
      if (current.name !== item.name || current.cwd !== item.cwd || current.system !== item.system) this.refreshDisplayTitles();
      return item;
    });
  }
  /**
   * 会话标题规则 (docs/SESSION-TITLES.md), read on every session write. `displayTitle` is derived: whatever a
   * writer passes for it is dropped and recomputed here, so no caller can store a stale one.
   */
  private titleRules: () => { rules?: readonly TitleRule[]; timeZone?: string } = () => ({});
  configureTitleRules(read: () => { rules?: readonly TitleRule[]; timeZone?: string }): void { this.titleRules = read; }
  private withDisplayTitle<T extends Session>(session: T): T {
    const { displayTitle: _derived, ...rest } = session;
    const { rules } = this.titleRules();
    if (!rules?.length) return rest as T;
    const displayTitle = renderDisplayTitle(rules, session, this.titleRuleContext(session));
    return (displayTitle ? { ...rest, displayTitle } : rest) as T;
  }
  /** The 会话标题规则 that names [session] now, if any. */
  titleRuleFor(session: Session): TitleRule | undefined {
    const { rules } = this.titleRules();
    return rules?.length ? matchTitleRule(rules, session, this.titleRuleContext(session)) : undefined;
  }
  /** The project a rule reads, the one a worktree came from, and the zone dates are told in. */
  private titleRuleContext(session: Pick<Session, 'projectId'>): TitleRuleContext {
    const project = this.get<Project>('projects', session.projectId);
    const originProject = project?.worktree ? this.get<Project>('projects', project.worktree.originProjectId) : undefined;
    const { timeZone } = this.titleRules();
    return { ...(project ? { project } : {}), ...(originProject ? { originProject } : {}), ...(timeZone ? { timeZone } : {}) };
  }
  /** Applies the current rules to every conversation that shows differently under them; resolves to how many changed. */
  refreshDisplayTitles(): number {
    return this.transaction(() => {
      let changed = 0;
      for (const session of this.allSessions()) {
        if (this.withDisplayTitle(session).displayTitle === session.displayTitle) continue;
        this.updateSession(session.id, {});
        changed++;
      }
      return changed;
    });
  }
  /** The project's worktree origins, nearest first. Throws on a missing origin or a loop. */
  originChain(projectId: string): string[] {
    const chain: string[] = [];
    const start = this.get<Project>('projects', projectId);
    if (!start) throw new AppError('PROJECT_NOT_FOUND', 'Project does not exist', 404);
    let current: Project = start;
    while (current.worktree) {
      const origin: string = current.worktree.originProjectId;
      if (origin === projectId || chain.includes(origin)) throw new AppError('PROJECT_ORIGIN_INVALID', 'This project\'s worktree origins form a loop', 409, { projectId, chain: [projectId, ...chain, origin] });
      const next: Project | undefined = this.get<Project>('projects', origin);
      if (!next) throw new AppError('PROJECT_ORIGIN_INVALID', 'This project\'s worktree origin no longer exists', 409, { projectId, chain: [projectId, ...chain], missing: origin });
      chain.push(origin);
      current = next;
    }
    return chain;
  }
  deleteProject(id: string) {
    this.getProject(id);
    if (this.listSessions().some(s => s.projectId === id)) throw new AppError('PROJECT_HAS_SESSIONS', 'This project has conversations. Archive the project to retain its history.', 409);
    // A worktree resolves its merge target through this project.
    if (this.listProjects().some(project => project.worktree?.originProjectId === id)) throw new AppError('PROJECT_HAS_WORKTREES', 'Other projects are worktrees of this one. Archive the project to retain them.', 409);
    this.transaction(() => { this.sql('DELETE FROM folder_favorites WHERE project_id=?').run(id); this.sql('DELETE FROM projects WHERE id=?').run(id); this.projectsChanged(); this.favoritesChanged(); }); }
  /** One scope's favorites (host-level without `projectId`) in display order; `exists` is the caller's to fill in. */
  listFolderFavorites(projectId?: string): StoredFolderFavorite[] {
    return (this.sql(`SELECT json FROM folder_favorites WHERE project_id=? ORDER BY json_extract(json,'$.sort'), json_extract(json,'$.createdAt')`).all(projectId ?? '') as {json: string}[]).map(row => JSON.parse(row.json) as StoredFolderFavorite);
  }
  getFolderFavorite(id: string): StoredFolderFavorite { const item = this.get<StoredFolderFavorite>('folder_favorites', id); if (!item) throw new AppError('FOLDER_FAVORITE_NOT_FOUND', 'Favorite does not exist', 404); return item; }
  /** Idempotent per scope and canonical `path`: an existing favorite is returned unchanged. */
  createFolderFavorite(path: string, projectId?: string, label?: string): StoredFolderFavorite {
    return this.transaction(() => {
      if (projectId) this.getProject(projectId);
      const existing = this.sql('SELECT json FROM folder_favorites WHERE project_id=? AND path=?').get(projectId ?? '', path) as {json: string} | undefined;
      if (existing) return JSON.parse(existing.json) as StoredFolderFavorite;
      const {top} = this.sql(`SELECT MAX(json_extract(json,'$.sort')) AS top FROM folder_favorites WHERE project_id=?`).get(projectId ?? '') as {top: number | null};
      const item: StoredFolderFavorite = {id: randomUUID(), path, ...(label ? {label} : {}), ...(projectId ? {projectId} : {}), sort: (top ?? -1) + 1, createdAt: now()};
      this.sql('INSERT INTO folder_favorites(id,project_id,path,json) VALUES(?,?,?,?)').run(item.id, projectId ?? '', path, JSON.stringify(item)); this.favoritesChanged(); return item;
    });
  }
  /** A key present with `undefined` clears it. */
  updateFolderFavorite(id: string, patch: Partial<Pick<StoredFolderFavorite, 'label' | 'lastUsedAt'>>): StoredFolderFavorite { const item = {...this.getFolderFavorite(id), ...patch, id}; this.replace('folder_favorites', id, item); this.favoritesChanged(); return JSON.parse(JSON.stringify(item)) as StoredFolderFavorite; }
  /** `ids` must name every favorite of the scope exactly once. */
  reorderFolderFavorites(ids: string[], projectId?: string): StoredFolderFavorite[] {
    return this.transaction(() => {
      if (projectId) this.getProject(projectId);
      const current = new Map(this.listFolderFavorites(projectId).map(item => [item.id, item]));
      if (ids.length !== current.size || new Set(ids).size !== ids.length || ids.some(id => !current.has(id))) throw new AppError('INVALID_FAVORITE_ORDER', 'List every favorite of this scope exactly once');
      ids.forEach((id, sort) => this.replace('folder_favorites', id, {...current.get(id)!, sort}));
      this.favoritesChanged();
      return this.listFolderFavorites(projectId);
    });
  }
  deleteFolderFavorite(id: string) { this.getFolderFavorite(id); this.sql('DELETE FROM folder_favorites WHERE id=?').run(id); this.favoritesChanged(); }
  createSession(input: Pick<Session,'projectId'|'kind'> & Partial<Session>): IdentifiedSession {
    return this.transaction(() => {
      this.getProject(input.projectId);
      const stamp = now();
      const item = normalizeSessionIdentity({...input, id: randomUUID(), title: input.title || 'New conversation', ...clientTitleSource(input.title), tags: input.tags ?? [], state: 'idle', mode: input.mode ?? 'agent', lastActivityAt: input.lastActivityAt ?? stamp, seenActivityAt: input.lastActivityAt ?? stamp, createdAt: stamp, updatedAt: stamp});
      this.assertNativeIdentityAvailable(item);
      const shown = this.withDisplayTitle(item);
      this.sql('INSERT INTO sessions(id,project_id,json) VALUES(?,?,?)').run(shown.id, shown.projectId, JSON.stringify(shown)); this.sessionsChanged([shown.id]);
      return shown;
    });
  }
  getSession(id: string): IdentifiedSession {
    const item = this.get<Session>('sessions', id);
    if (!item) throw this.isSessionDeleted(id) ? sessionDeleted(id) : new AppError('SESSION_NOT_FOUND', 'Conversation does not exist', 404);
    return normalizeSessionIdentity(item);
  }
  isSessionDeleted(id: string): boolean { return Boolean(this.sql('SELECT 1 AS found FROM settings WHERE key=?').get(`${DELETED_PREFIX}${id}`)); }
  deletedSession(id: string): DeletedSession | undefined { return this.getSetting<DeletedSession | undefined>(`${DELETED_PREFIX}${id}`, undefined); }
  /** Deleted conversations whose files are still to be removed. */
  pendingDeletionCleanups(): string[] {
    return (this.sql(`SELECT key FROM settings WHERE key LIKE '${DELETED_PREFIX}%' AND json_extract(json,'$.cleanupPending')=1`).all() as Array<{ key: string }>).map(row => row.key.slice(DELETED_PREFIX.length));
  }
  deletionCleaned(id: string): void {
    const record = this.deletedSession(id);
    if (record?.cleanupPending) this.setSetting(`${DELETED_PREFIX}${id}`, { ...record, cleanupPending: false });
  }
  /**
   * Removes the conversations' rows and records their ids as deleted in L0 first (so any concurrent
   * request immediately sees 410), then drops their L1 journal lanes and L2 search index entries.
   * Any crash between L0 commit and L1/L2 cleanup is retried idempotently by `purgeDeletedSessionArtifacts`.
   */
  deleteSessions(rootId: string, ids: readonly string[]): DeletedSession {
    const record = this.transaction(() => {
      const deletedAt = now();
      for (const id of ids) {
        this.getSession(id);
        this.sql('DELETE FROM events WHERE session_id=?').run(id);
        this.sql('DELETE FROM runs WHERE session_id=?').run(id);
        for (const prefix of SESSION_SETTING_PREFIXES) this.sql('DELETE FROM settings WHERE key=?').run(`${prefix}${id}`);
        this.sql('DELETE FROM sessions WHERE id=?').run(id);
        this.sessionSnapshotAppends.delete(id);
        this.setSetting(`${DELETED_PREFIX}${id}`, { rootId, deletedAt, cleanupPending: true, ...(id === rootId ? { sessionIds: [...ids] } : {}) } satisfies DeletedSession);
      }
      this.sessionsChanged(ids);
      this.afterTransaction(committed => {
        if (!committed) return;
        for (const id of ids) {
          this.purgeDeletedSessionArtifacts(id);
          this.listeners.delete(id);
          for (const listener of this.deletionListeners.get(id) ?? []) { try { listener(); } catch { /* a closing stream's failure is its own */ } }
        }
        this.noteMessageIndexShape();
      });
      return { rootId, deletedAt, cleanupPending: true, sessionIds: [...ids] };
    });
    return record;
  }
  /** Idempotently clears L1 journal and L2 search index artifacts for a deleted conversation. */
  purgeDeletedSessionArtifacts(id: string): void {
    for (const key of this.journal.keysOf(id)) this.journal.drop(key);
    this.journal.drop(id);
    this.derivedTx(() => {
      this.derivedSql('DELETE FROM message_index WHERE session_id=?').run(id);
      this.derivedSql('DELETE FROM message_index_sessions WHERE session_id=?').run(id);
    });
  }
  /** Activity timestamp and running flag for `TimelineService.sweepCold` without cross-DB queries. */
  sessionActivity(id: string): { at?: string; running: boolean } | undefined {
    const item = this.get<Session>('sessions', id);
    if (!item) return undefined;
    const times = [item.lastActivityAt, item.updatedAt].filter((value): value is string => typeof value === 'string').sort();
    return { ...(times.length ? { at: times.at(-1)! } : {}), running: ACTIVE_SESSION_STATES.has(item.state) };
  }
  private hotTimelineSessions(): Set<string> {
    const hot = new Set<string>();
    try {
      const hasTimeline = this.derivedSql("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='timeline_rows'").get();
      if (hasTimeline) {
        for (const row of this.derivedSql('SELECT DISTINCT session_id FROM timeline_rows').all() as Array<{ session_id: string }>) {
          hot.add(row.session_id);
        }
      }
    } catch { /* ignore */ }
    return hot;
  }
  /** Ids of cold conversations archived before `cutoffIso` (skipping any with live hot timeline rows). */
  archivedSessionsBefore(cutoffIso: string): string[] {
    const hot = this.hotTimelineSessions();
    return this.allSessions()
      .filter(session => typeof session.archivedAt === 'string' && session.archivedAt < cutoffIso && !hot.has(session.id))
      .map(session => session.id);
  }
  /**
   * Ids of cold conversations eligible for oversized tool output head+tail trimming:
   * - archived earlier than `STORAGE_BUDGET.archivedTrimDays`, OR
   * - unarchived, idle (not running), and last active earlier than `STORAGE_BUDGET.inactiveTrimDays`.
   * Sessions with hot `timeline_rows` are always skipped.
   */
  coldSessionsForTrimming(nowMs = Date.now()): string[] {
    const archivedCutoff = STORAGE_BUDGET.archivedTrimDays > 0
      ? new Date(nowMs - STORAGE_BUDGET.archivedTrimDays * 86_400_000).toISOString()
      : undefined;
    const inactiveCutoff = STORAGE_BUDGET.inactiveTrimDays > 0
      ? new Date(nowMs - STORAGE_BUDGET.inactiveTrimDays * 86_400_000).toISOString()
      : undefined;
    if (!archivedCutoff && !inactiveCutoff) return [];
    const hot = this.hotTimelineSessions();
    const ids: string[] = [];
    for (const session of this.allSessions()) {
      if (hot.has(session.id) || ACTIVE_SESSION_STATES.has(session.state)) continue;
      if (typeof session.archivedAt === 'string') {
        if (archivedCutoff && session.archivedAt < archivedCutoff) ids.push(session.id);
        continue;
      }
      if (!inactiveCutoff) continue;
      const latest = [session.lastActivityAt, session.updatedAt, session.createdAt]
        .filter((value): value is string => typeof value === 'string')
        .sort()
        .at(-1);
      if (latest && latest < inactiveCutoff) ids.push(session.id);
    }
    return ids;
  }
  /**
   * The active personal-assistant main conversation and an age cutoff (`beforeAt`) for trimming old
   * oversized tool outputs without touching recent turns or messages awaiting memory consolidation.
   */
  assistantMainForTrimming(nowMs = Date.now()): { sessionId: string; beforeAt: string } | undefined {
    if (STORAGE_BUDGET.assistantTrimDays <= 0) return undefined;
    const project = this.listProjects().find(item => item.system === 'assistant' && typeof item.mainSessionId === 'string');
    const mainId = project?.mainSessionId;
    if (!mainId) return undefined;
    const session = this.get<Session>('sessions', mainId);
    if (!session || typeof session.archivedAt === 'string' || ACTIVE_SESSION_STATES.has(session.state)) return undefined;
    let beforeAt = new Date(nowMs - STORAGE_BUDGET.assistantTrimDays * 86_400_000).toISOString();
    const settings = this.getSettings();
    if (settings.assistant?.consolidation !== false) {
      const consolidatedThrough = this.getSetting<string | undefined>('assistant-consolidated-through', undefined);
      if (consolidatedThrough && consolidatedThrough < beforeAt) beforeAt = consolidatedThrough;
    }
    return { sessionId: mainId, beforeAt };
  }
  /** Called once the conversation is deleted: its open streams end, and their clients learn it on reconnecting. */
  onSessionDeleted(id: string, listener: () => void): () => void {
    let group = this.deletionListeners.get(id);
    if (!group) this.deletionListeners.set(id, group = new Set());
    group.add(listener);
    return () => { group.delete(listener); if (!group.size) this.deletionListeners.delete(id); };
  }
  /** Original input from the real journal, never a search index or scratch window containing only the tail. */
  firstUserMessage(sessionId: string): string | undefined {
    const session = this.getSession(sessionId);
    const nativeId = session.nativeSessionId;
    const head = this.journal.peek(sessionId);
    let identity = head?.identity;
    if (!identity && head?.ingestCursor) {
      try { identity = (JSON.parse(head.ingestCursor) as { threadId?: string }).threadId; } catch { /* await the current transcript */ }
    }
    if (!nativeId || identity === nativeId) {
      const event = this.journal.firstEntity(sessionId, 'user_message_chunk')?.payload as { type: string; data: Record<string, unknown> } | undefined;
      const text = event && firstHumanMessage([event]);
      if (text) return text;
    }
    // Before a new thread is assigned, its accepted input is the only original message. A Run in
    // an existing thread may only be a continuation; wait for the original journal instead.
    if (!nativeId && !session.resumePicker) return this.listRuns(sessionId)[0]?.prompt;
    return undefined;
  }
  waitingSessionIds(): string[] {
    return (this.sql("SELECT id FROM sessions WHERE json_extract(json,'$.state')='waiting' AND json_extract(json,'$.archivedAt') IS NULL").all() as {id:string}[]).map(row=>row.id);
  }
  listSessions(): IdentifiedSession[] { return this.allSessions().sort((a,b) => (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt)); }
  updateSession(id: string, patch: Partial<Session>): IdentifiedSession {
    return this.transaction(() => {
      const current = this.getSession(id);
      const merged: Session = {...current, ...patch, id, updatedAt: now()};
      applyNativeSessionIdPatch(merged, patch, () => new AppError('INVALID_NATIVE_SESSION_ID', 'Cursor session id fields must agree'));
      const item = this.withDisplayTitle(normalizeSessionIdentity(merged));
      // Pollers re-write the same state every tick; bumping `updatedAt` for that would push a fresh
      // `session` frame to every open stream several times a second.
      if ([...new Set([...Object.keys(item), ...Object.keys(current)])].every(key => key === 'updatedAt' || JSON.stringify((current as unknown as Record<string, unknown>)[key]) === JSON.stringify((item as unknown as Record<string, unknown>)[key]))) return current;
      if (ACTIVE_SESSION_STATES.has(item.state) && !ACTIVE_SESSION_STATES.has(current.state)) item.activeSince = item.updatedAt;
      const identityChanged = current.kind !== item.kind || current.backendId !== item.backendId || current.nativeSessionId !== item.nativeSessionId;
      const restored = Boolean(current.archivedAt) && Object.prototype.hasOwnProperty.call(patch, 'archivedAt') && patch.archivedAt === undefined;
      if (item.kind === 'native' && !item.archivedAt && (identityChanged || restored)) {
        this.assertNativeIdentityAvailable(item, id, id);
      }
      this.replace('sessions', id, item);
      this.sessionsChanged([id]);
      if (item.state !== current.state) for (const listener of this.stateListeners) { try { listener(item, current.state); } catch { /* derived records must not fail the write */ } }
      if (item.title !== current.title && this.sql('SELECT 1 AS found FROM marks WHERE session_id=? LIMIT 1').get(id)) this.marksChanged();
      return item;
    });
  }
  /** Applies a change of meaning and moves `configRevision` past whatever is stored, in one write. */
  bumpConfig(id: string, patch: Partial<Session> = {}): IdentifiedSession {
    return this.transaction(() => {
      const { configRevision: _ignored, ...rest } = patch;
      return this.updateSession(id, { ...rest, configRevision: (this.getSession(id).configRevision ?? 0) + 1 });
    });
  }
  updateSessionActivity(id: string, activityAt = now()): IdentifiedSession | undefined {
    const stamp = Number.isFinite(Date.parse(activityAt)) ? new Date(activityAt).toISOString() : now();
    const current = this.getSession(id);
    if (current.lastActivityAt && Date.parse(current.lastActivityAt) >= Date.parse(stamp)) return undefined;
    const session = this.updateSession(id, { lastActivityAt: stamp });
    this.appendEvent(id, 'session', { session });
    return session;
  }
  /**
   * Records that the owner has seen the conversation up to `activityAt` (its `lastActivityAt` when
   * omitted). Max-merge: never moves back and never past the conversation's own activity, so retries
   * and late reports from another device write nothing. Returns the session only when it changed.
   */
  markSessionSeen(id: string, activityAt?: string): IdentifiedSession | undefined {
    return this.transaction(() => {
      const current = this.getSession(id);
      const latest = Date.parse(current.lastActivityAt ?? current.createdAt);
      const requested = activityAt === undefined ? latest : Date.parse(activityAt);
      if (!Number.isFinite(requested) || !Number.isFinite(latest)) return undefined;
      const target = Math.min(requested, latest);
      if (current.seenActivityAt && Date.parse(current.seenActivityAt) >= target) return undefined;
      const session = this.updateSession(id, { seenActivityAt: new Date(target).toISOString() });
      // Open views of the conversation hear of it like any other change to the record; activity is not moved.
      this.appendEvent(id, 'session', { session });
      return session;
    });
  }
  /**
   * Name a conversation after a message a client just accepted (see `session-title.ts`). Central
   * here because every backend accepts its messages through one of the two run paths above, so the
   * rule holds for every backend. A session that already has a name keeps
   * it, which makes this idempotent per session rather than per message.
   */
  private nameFromMessage(sessionId: string, prompt: string): void {
    const patch = acceptedTitlePatch(this.getSession(sessionId), prompt);
    if (!patch) return;
    const session = this.updateSession(sessionId, patch);
    this.appendEvent(sessionId, 'session', { session });
  }
  createRun(sessionId: string, commandId: string, prompt: string): Run {
    return this.transaction(() => {
      const duplicate = this.sql('SELECT json FROM runs WHERE session_id=? AND command_id=?').get(sessionId, commandId) as {json: string} | undefined;
      if (duplicate) return this.run(duplicate.json);
      this.getSession(sessionId);
      const stamp = now();
      const run: Run = {id: randomUUID(), sessionId, commandId, prompt, state:'queued', createdAt:stamp, updatedAt:stamp};
      this.sql('INSERT INTO runs(id,session_id,command_id,json) VALUES(?,?,?,?)').run(run.id, sessionId, commandId, JSON.stringify(run));
      this.updateSessionActivity(sessionId, stamp);
      this.nameFromMessage(sessionId, prompt);
      this.runChanged(run);
      return run;
    });
  }
  acceptNativeRun(sessionId: string, commandId: string, input: NativeRunInput, config: NativeRunConfig, expectedConfigRevision?: number, steer?: { target: NativeTurnTarget; ownerRunId?: string; sourceRunId?: string }, contextSnapshots?: CapturedSessionReference[]): IdentifiedRun {
    if (typeof commandId !== 'string' || !commandId || commandId.length > 200) throw new AppError('INVALID_COMMAND_ID', 'commandId must be a non-empty string up to 200 characters');
    const normalizedInput = normalizeNativeInput(input), normalizedConfig = normalizeNativeConfig(config);
    const idempotencyFingerprint = fingerprint(steer
      ? { input: normalizedInput, intent: 'steer', target: { nativeSessionId: steer.target.nativeSessionId, turnId: steer.target.turnId }, ...(steer.sourceRunId ? { sourceRunId: steer.sourceRunId } : {}) }
      : { input: normalizedInput, config: normalizedConfig });
    return this.transaction(() => {
      const session = this.getSession(sessionId);
      if (session.kind !== 'native') throw new AppError('NOT_NATIVE', 'Native submissions require a native conversation', 409);
      const duplicate = this.sql('SELECT json FROM runs WHERE session_id=? AND command_id=?').get(sessionId, commandId) as {json: string} | undefined;
      if (duplicate) {
        const existing = this.run(duplicate.json);
        if (existing.native?.fingerprint !== idempotencyFingerprint) throw new AppError('COMMAND_ID_CONFLICT', 'This commandId was already used for a different native submission', 409);
        return existing;
      }
      // A request may spend time validating/materializing attachments before it reaches this
      // transaction. Recheck the session lifecycle here so a concurrent archive cannot accept a
      // new durable command after the session has been archived. Exact retries above stay readable.
      if (session.archivedAt) throw new AppError('ARCHIVED_SESSION', 'Restore this conversation before sending a message', 409);
      if (steer && (!steer.target.nativeSessionId || !steer.target.turnId || session.nativeSessionId !== steer.target.nativeSessionId)) {
        throw new AppError('STEER_TARGET_CHANGED', 'The current task changed; the instruction was not sent', 409);
      }
      const configRevision = session.configRevision ?? 0;
      if (expectedConfigRevision !== undefined && expectedConfigRevision !== configRevision) {
        throw new AppError('NATIVE_CONFIG_CHANGED', 'Native conversation settings changed before this submission was accepted', 409, { expected: expectedConfigRevision, actual: configRevision });
      }
      const stamp = now();
      const run = this.identified({
        id: randomUUID(), sessionId, commandId, prompt: normalizedInput.text, state: 'queued', createdAt: stamp, updatedAt: stamp,
        native: {
          input: normalizedInput,
          ...(contextSnapshots?.length ? { contextSnapshots } : {}),
          config: normalizedConfig,
          fingerprint: idempotencyFingerprint,
          delivery: 'queued',
          attempt: 0,
          ...(session.terminalId ? { terminalId: session.terminalId } : {}),
          backendId: session.backendId,
          ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
          configRevision,
          ...(steer ? { intent: 'steer' as const, nativeSessionId: steer.target.nativeSessionId, nativeTurnId: steer.target.turnId,
            ...(steer.ownerRunId ? { ownerRunId: steer.ownerRunId } : {}), ...(steer.sourceRunId ? { sourceRunId: steer.sourceRunId } : {}), stage: 'steer_pending' } : {}),
        },
      });
      this.sql('INSERT INTO runs(id,session_id,command_id,json) VALUES(?,?,?,?)').run(run.id, sessionId, commandId, JSON.stringify(run));
      this.updateSessionActivity(sessionId, stamp);
      this.appendEvent(sessionId, 'run_updated', { run }, { runId: run.id });
      this.nameFromMessage(sessionId, normalizedInput.text);
      this.runChanged(run);
      return run;
    });
  }
  /** Accept a distinct steering command and cancel its queued source in the same durable write. */
  steerQueuedNativeRun(sessionId: string, sourceRunId: string, commandId: string, target: NativeTurnTarget, config: NativeRunConfig, ownerRunId?: string): IdentifiedRun {
    return this.transaction(() => {
      const existing = this.findRunByCommand(sessionId, commandId);
      if (existing) {
        if (!existing.native || existing.native.sourceRunId !== sourceRunId) throw new AppError('COMMAND_ID_CONFLICT', 'This request was already used for another message', 409);
        return this.acceptNativeRun(sessionId, commandId, existing.native.input, existing.native.config, undefined, { target, sourceRunId, ownerRunId: existing.native.ownerRunId });
      }
      const source = this.getRun(sourceRunId);
      if (source.sessionId !== sessionId || !source.native) throw new AppError('RUN_NOT_FOUND', 'The queued message does not exist', 404);
      if (source.native.intent || source.state !== 'queued' || source.native.delivery !== 'queued') throw new AppError('RUN_NOT_QUEUED', 'This message has left the queue; refresh and try again', 409);
      const run = this.acceptNativeRun(sessionId, commandId, source.native.input, config, undefined, { target, sourceRunId, ownerRunId }, source.native.contextSnapshots);
      const cancelled = this.transitionNativeRun(source.id, ['queued'], { delivery: 'cancelled', stage: 'steer_replaced' }, { state: 'cancelled' });
      if (!cancelled) throw new AppError('RUN_NOT_QUEUED', 'This message has left the queue; refresh and try again', 409);
      return run;
    });
  }
  /**
   * A steer that never reached its turn becomes the next message: the same row, out of steer mode, at the
   * head of the queue (`timings.fallbackAt`, which outlives the stages a send attempt writes), so it is sent
   * once and in the order it was written. Only a steer nothing was written for (`queued`, `preparing`) can
   * move; the caller has already let go of its inbox.
   */
  requeueSteer(id: string): IdentifiedRun | undefined {
    return this.transaction(() => {
      const native = this.getRun(id).native;
      if (native?.intent !== 'steer') return undefined;
      return this.transitionNativeRun(id, ['queued', 'preparing'], {
        intent: undefined, nativeTurnId: undefined, ownerRunId: undefined, renderedText: undefined, diagnostic: undefined,
        delivery: 'queued', stage: 'steer_fallback', timings: { ...native.timings, fallbackAt: native.timings?.fallbackAt ?? Date.now() },
      }, { state: 'queued', error: undefined });
    });
  }
  createNativeSubmission(clientSessionId: string, sessionInput: NativeSessionInput, commandId: string, input: NativeRunInput, contextSnapshots?: CapturedSessionReference[]): { session: IdentifiedSession; run: IdentifiedRun } {
    if (typeof clientSessionId !== 'string' || !clientSessionId || clientSessionId.length > 200) throw new AppError('INVALID_SESSION_ID', 'clientSessionId must be a non-empty string up to 200 characters');
    const normalized = normalizedNativeSessionInput(sessionInput);
    const normalizedInput = normalizeNativeInput(input);
    // Resolved from server settings, not the request: a retry after a settings change is the same creation.
    // The same goes for the task: a retry after it was detached or deleted must not conflict.
    const { terminalAppearance: _terminalAppearance, toolGroups: _toolGroups, extensionsOff: _extensionsOff, workItemId: _workItemId, ...creationIdentity } = normalized;
    const creationFingerprint = fingerprint({ session: creationIdentity, commandId, input: normalizedInput });
    const config = normalizeNativeConfig({
      ...(normalized.model !== undefined ? { model: normalized.model } : {}),
      mode: normalized.mode,
      ...(normalized.approval !== undefined ? { approval: normalized.approval } : {}),
    });
    return this.transaction(() => {
      // A retried creation of a deleted conversation must not bring it back (or send its first message again).
      if (this.isSessionDeleted(clientSessionId)) throw sessionDeleted(clientSessionId);
      const stored = this.get<Session>('sessions', clientSessionId);
      let session = stored && normalizeSessionIdentity(stored);
      if (session) {
        if (session.kind !== 'native' || session.creationFingerprint !== creationFingerprint) {
          throw new AppError('SESSION_ID_CONFLICT', 'This clientSessionId was already used for a different session creation request', 409);
        }
      } else {
        this.getProject(normalized.projectId);
        const stamp = now();
        // A handoff carries on the same work, so it stays on its source's task; not part of the creation identity.
        // A fork branches off: it gets a task of its own from whoever forks it (docs/TASK-BOARD.md §4.2).
        const originId = normalized.origin?.kind === 'handoff' ? normalized.origin.sessionId : undefined;
        const inherited = !normalized.workItemId && originId ? this.get<Session>('sessions', originId)?.workItemId : undefined;
        session = {
          ...normalized,
          ...(inherited ? { workItemId: inherited } : {}),
          ...clientTitleSource(normalized.title),
          id: clientSessionId,
          kind: 'native',
          state: 'idle',
          configRevision: 0,
          creationFingerprint,
          lastActivityAt: stamp,
          seenActivityAt: stamp,
          createdAt: stamp,
          updatedAt: stamp,
        };
        this.assertNativeIdentityAvailable(session);
        session = this.withDisplayTitle(session);
        this.sql('INSERT INTO sessions(id,project_id,json) VALUES(?,?,?)').run(session.id, session.projectId, JSON.stringify(session));
        this.sessionsChanged([session.id]);
      }
      // Derive the first Run's config from the immutable request, never the live Session model,
      // which may have been changed by the time an HTTP retry arrives.
      const run = this.acceptNativeRun(session.id, commandId, normalizedInput, config, session.configRevision ?? 0, undefined, contextSnapshots);
      // The owner wrote the first message of a conversation opened from the composer; one opened on
      // their behalf (an automation, a channel, an attempt) starts unseen.
      if (!stored && !normalized.origin) this.markSessionSeen(session.id);
      return { session: this.getSession(session.id), run };
    });
  }
  getRun(id: string): IdentifiedRun { const row = this.sql('SELECT json FROM runs WHERE id=?').get(id) as {json: string} | undefined; if (!row) throw new AppError('RUN_NOT_FOUND','Run does not exist',404); return this.run(row.json); }
  previousRunId(sessionId: string, runId: string): string | undefined {
    const row = this.sql('SELECT id FROM runs WHERE session_id=? AND rowid < (SELECT rowid FROM runs WHERE session_id=? AND id=?) ORDER BY rowid DESC LIMIT 1')
      .get(sessionId, sessionId, runId) as { id: string } | undefined;
    return row?.id;
  }
  findRunByCommand(sessionId: string, commandId: string): IdentifiedRun | undefined {
    const row = this.sql('SELECT json FROM runs WHERE session_id=? AND command_id=?').get(sessionId, commandId) as {json:string} | undefined;
    return row ? this.run(row.json) : undefined;
  }
  findRunsByNativeTurn(sessionId: string, nativeSessionId: string, turnId: string): IdentifiedRun[] {
    return (this.sql("SELECT json FROM runs WHERE session_id=? AND json_extract(json,'$.native.nativeSessionId')=? AND json_extract(json,'$.native.nativeTurnId')=? ORDER BY rowid")
      .all(sessionId, nativeSessionId, turnId) as { json: string }[]).map(row => this.run(row.json));
  }
  /** Exact native receipt identity; repeated prompt text is never a safe turn identifier. */
  findRunByNativeMessage(sessionId: string, nativeMessageId: string): IdentifiedRun | undefined {
    const row = this.sql("SELECT json FROM runs WHERE session_id=? AND json_extract(json,'$.native.nativeMessageId')=? ORDER BY rowid DESC LIMIT 1")
      .get(sessionId, nativeMessageId) as {json:string} | undefined;
    return row ? this.run(row.json) : undefined;
  }
  /** Metrics backfill must not change when the original run finished. */
  saveRunMetrics(id: string, metrics: RunMetrics): void {
    const current = this.getRun(id);
    if (!current.native || current.native.intent === 'steer' || JSON.stringify(current.native.metrics) === JSON.stringify(metrics)) return;
    const run = { ...current, native: { ...current.native, metrics } };
    this.replace('runs', id, run);
    this.runChanged(run);
  }
  listRuns(sessionId: string): IdentifiedRun[] { return (this.sql('SELECT json FROM runs WHERE session_id=? ORDER BY rowid').all(sessionId) as {json:string}[]).map(r => this.run(r.json)); }
  updateRun(id: string, patch: Partial<Run>): IdentifiedRun { const item = this.identified({...this.getRun(id), ...patch, id, updatedAt:now()}); this.replace('runs', id, item); this.runChanged(item); return item; }
  transitionNativeRun(id: string, expectedDelivery: NativeDeliveryState[], nativePatch: Partial<NativeRunDetails>, runPatch: Partial<Run> = {}): IdentifiedRun | undefined {
    return this.transaction(() => {
      const current = this.getRun(id);
      if (!current.native || !expectedDelivery.includes(current.native.delivery)) return undefined;
      const run = this.identified({
        ...current,
        ...runPatch,
        id: current.id,
        sessionId: current.sessionId,
        commandId: current.commandId,
        prompt: current.prompt,
        updatedAt: now(),
        native: { ...current.native, ...nativePatch },
      });
      this.replace('runs', id, run);
      this.appendEvent(run.sessionId, 'run_updated', { run }, { runId: run.id });
      // A settled run will not move again; its earlier snapshots are superseded for good.
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state) || ['failed', 'cancelled'].includes(run.native!.delivery)) this.pruneRunSnapshots(run.sessionId, run.id);
      this.runChanged(run);
      return run;
    });
  }
  listUnfinishedNativeRuns(sessionId?: string): IdentifiedRun[] {
    const sessionFilter = sessionId === undefined ? '' : 'AND r.session_id=?';
    const parameters = sessionId === undefined ? [] : [sessionId];
    // The dispatcher asks this twice a second. Left to itself SQLite scans (and JSON-parses) every
    // run ever recorded; the partial index holds only the unfinished ones.
    return (this.sql(`SELECT r.json FROM runs r INDEXED BY run_native_unfinished JOIN sessions s ON s.id=r.session_id
      WHERE json_extract(s.json,'$.kind')='native'
        ${sessionFilter}
        AND json_extract(r.json,'$.native.delivery') IN ('queued','preparing','dispatching','input_sent','observed','uncertain')
        AND json_extract(r.json,'$.state') NOT IN ('completed','failed','cancelled')
      ORDER BY r.rowid`).all(...parameters) as {json:string}[]).map(row => this.run(row.json));
  }
  listRecentNativeRuns(sessionId: string, limit = 100): IdentifiedRun[] {
    const boundedLimit = Number.isInteger(limit) ? Math.max(0, Math.min(limit, 1000)) : 100;
    return (this.sql(`SELECT r.json FROM runs r JOIN sessions s ON s.id=r.session_id
      WHERE r.session_id=? AND json_extract(s.json,'$.kind')='native'
      ORDER BY r.rowid DESC LIMIT ?`).all(sessionId, boundedLimit) as {json:string}[]).map(row => this.run(row.json));
  }
  /** Startup reconciliation only: exact turns whose provider end may have been corrected. */
  listProviderEndedNativeRuns(): IdentifiedRun[] {
    const candidates = (this.sql(`SELECT r.json FROM runs r JOIN sessions s ON s.id=r.session_id
      WHERE json_extract(s.json,'$.kind')='native'
        AND ((json_extract(r.json,'$.state')='interrupted'
          AND json_extract(r.json,'$.native.delivery')='cancelled'
          AND json_extract(r.json,'$.native.stage')='provider_cancelled')
        OR (json_extract(r.json,'$.state')='failed' AND json_extract(r.json,'$.native.delivery')='failed'
          AND json_extract(r.json,'$.native.stage')='provider_failed')
        OR (json_extract(r.json,'$.state')='completed' AND json_extract(r.json,'$.native.delivery')='observed'
          AND json_extract(r.json,'$.native.stage')='completed'))
        AND json_extract(r.json,'$.native.nativeSessionId') IS NOT NULL
        AND json_extract(r.json,'$.native.nativeTurnId') IS NOT NULL`).all() as { json: string }[]).map(row => this.run(row.json));
    return candidates.filter(run => {
      if (run.state === 'interrupted' && run.native?.delivery === 'cancelled' && run.native.stage === 'provider_cancelled') return true;
      const turnId = run.native?.nativeTurnId;
      return Boolean(turnId && this.journal.retraction(run.sessionId, `meta:turn:${turnId}:ended`));
    });
  }
  appendEvent(sessionId: string, type: string, data: Record<string,unknown>, extra: {runId?:string;raw?:unknown} = {}): WorkbenchEvent {
    this.getSession(sessionId);
    const base = {sessionId,type,data,...extra,createdAt:now()};
    const result = this.sql('INSERT INTO events(session_id,json) VALUES(?,?)').run(sessionId, JSON.stringify(base));
    const event: WorkbenchEvent = {...base,sequence:Number(result.lastInsertRowid)};
    if (type === 'session') {
      const count = (this.sessionSnapshotAppends.get(sessionId) ?? 0) + 1;
      this.sessionSnapshotAppends.set(sessionId, count % SESSION_SNAPSHOT_PRUNE_EVERY);
      if (count >= SESSION_SNAPSHOT_PRUNE_EVERY) this.pruneSessionSnapshots(sessionId);
    }
    if (this.depth) this.pending.push(event); else this.broadcast(event); return event;
  }
  /**
   * Each `session` event is a full snapshot that supersedes every earlier one, so a replay from any
   * sequence still ends on the current record. Only the newest `keep` are retained per session.
   */
  pruneSessionSnapshots(sessionId: string, keep: number = SESSION_SNAPSHOTS_KEPT): number {
    const cutoff = this.sql(`SELECT sequence FROM events WHERE session_id=? AND json_extract(json,'$.type')='session' ORDER BY sequence DESC LIMIT 1 OFFSET ?`).get(sessionId, Math.max(0, keep - 1)) as {sequence:number} | undefined;
    if (!cutoff) return 0;
    return Number(this.sql(`DELETE FROM events WHERE session_id=? AND sequence<? AND json_extract(json,'$.type')='session'`).run(sessionId, cutoff.sequence).changes);
  }
  /**
   * A `run_updated` event carries the whole run, so like a session snapshot it supersedes every
   * earlier one for the same run: a replay from any sequence still ends on each run's current
   * record. Only the newest per run is kept; `runId` narrows the work to one run.
   */
  pruneRunSnapshots(sessionId: string, runId?: string): number {
    if (runId !== undefined) {
      return Number(this.sql(`DELETE FROM events WHERE session_id=?1 AND json_extract(json,'$.type')='run_updated' AND json_extract(json,'$.runId')=?2
        AND sequence<(SELECT MAX(sequence) FROM events WHERE session_id=?1 AND json_extract(json,'$.type')='run_updated' AND json_extract(json,'$.runId')=?2)`).run(sessionId, runId).changes);
    }
    return Number(this.sql(`DELETE FROM events WHERE session_id=?1 AND json_extract(json,'$.type')='run_updated'
      AND sequence NOT IN (SELECT MAX(sequence) FROM events WHERE session_id=?1 AND json_extract(json,'$.type')='run_updated' GROUP BY json_extract(json,'$.runId'))`).run(sessionId).changes);
  }
  getEvents(sessionId: string, after = 0, limit = 5000): WorkbenchEvent[] {
    return (this.sql('SELECT sequence,json FROM events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(sessionId,after,limit) as {sequence:number;json:string}[]).map(r => ({...JSON.parse(r.json),sequence:r.sequence}));
  }
  /**
   * Replaces what is indexed for each message. A transcript window is authoritative for the
   * messages it contains, so storing it twice — a reconnect, a re-read — leaves the same rows.
   */
  /** `indexedAt` is when the transcript was read; activity after it makes the conversation stale again. */
  indexMessages(messages: readonly IndexedMessage[], indexedAt = now()): number {
    if (!messages.length) return 0;
    // L2 has no cross-database foreign key to L0 `sessions`; verify live ownership first.
    const liveIds = new Set(this.allSessions().map(session => session.id));
    const valid = messages.filter(message => liveIds.has(message.sessionId));
    if (!valid.length) return 0;
    return this.derivedTx(() => {
      // An unchanged message is left alone, so re-indexing a window rewrites only what moved.
      const statement = this.derivedSql(`INSERT INTO message_index(session_id,message_id,kind,text,at) VALUES(?,?,?,?,?) ON CONFLICT(session_id,message_id) DO UPDATE SET kind=excluded.kind,text=excluded.text,at=excluded.at
        WHERE kind IS NOT excluded.kind OR text IS NOT excluded.text OR at IS NOT excluded.at`);
      const mark = this.derivedSql('INSERT INTO message_index_sessions(session_id,indexed_at) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET indexed_at=MAX(indexed_at,excluded.indexed_at)');
      const sessions = new Set<string>();
      let written = 0;
      for (const message of valid) {
        try { statement.run(message.sessionId, message.messageId, message.kind, message.text, message.at); written += 1; sessions.add(message.sessionId); } catch { /* skipped */ }
      }
      for (const sessionId of sessions) mark.run(sessionId, indexedAt);
      return written;
    });
  }

  /** The earliest indexed message of one kind, if a transcript has been indexed for the session. */
  firstIndexedText(sessionId: string, kind: IndexedMessage['kind']): string | undefined {
    const row = this.derivedSql('SELECT text FROM message_index WHERE session_id=? AND kind=? AND text<>? ORDER BY at LIMIT 1').get(sessionId, kind, '') as {text:string} | undefined;
    return row?.text;
  }

  /** The latest indexed user prompt at or before `at` (seconds precision), for mark context lookup. */
  latestIndexedPromptBefore(sessionId: string, at: string): string | undefined {
    const row = this.derivedSql("SELECT text FROM message_index WHERE session_id=? AND kind='user' AND text<>'' AND substr(at,1,19)<=substr(?,1,19) ORDER BY at DESC, rowid DESC LIMIT 1")
      .get(sessionId, at) as { text: string } | undefined;
    return row?.text;
  }

  /** Indexed assistant (and optionally tool) rows of one conversation, for mark relocation. */
  indexedCandidatesForMark(sessionId: string, includeTools: boolean): Array<{ messageId: string; kind: IndexedMessage['kind']; text: string }> {
    return this.derivedSql(`SELECT message_id AS messageId, kind, text FROM message_index WHERE session_id=? AND (kind='assistant' OR (? AND kind='tool')) AND text<>'' ORDER BY at, rowid`)
      .all(sessionId, includeTools ? 1 : 0) as Array<{ messageId: string; kind: IndexedMessage['kind']; text: string }>;
  }

  /** Every indexed user and assistant message of a conversation, oldest first, with its tool calls when `tools` is set. */
  indexedMessages(sessionId: string, options: { tools?: boolean } = {}): Array<{ kind: 'user' | 'assistant' | 'tool'; text: string; at: string }> {
    return this.derivedSql(`SELECT kind,text,at FROM message_index WHERE session_id=? AND kind IN (${options.tools ? "'user','assistant','tool'" : "'user','assistant'"}) AND text<>'' ORDER BY at, rowid`).all(sessionId) as Array<{ kind: 'user' | 'assistant' | 'tool'; text: string; at: string }>;
  }

  /** A bounded tail from the search index, without loading earlier rows or tools. */
  recentIndexedMessages(sessionId: string, limit: number, characters: number): Array<{ role: 'user' | 'assistant'; text: string; at: string }> {
    const rows = this.derivedSql("SELECT kind AS role,substr(text,1,?) AS text,at FROM message_index WHERE session_id=? AND kind IN ('user','assistant') AND text<>'' ORDER BY at DESC,rowid DESC LIMIT ?")
      .all(characters, sessionId, limit) as Array<{ role: 'user' | 'assistant'; text: string; at: string }>;
    return rows.reverse();
  }

  private scopedSessions(sessionId?: string, excludedBackendIds?: readonly string[], excludeTaskWorkspaces = false, hidePluginAgents = false, assistantHistory = false): Map<string, IdentifiedSession> {
    const hidden = excludedBackendIds?.length ? new Set(excludedBackendIds) : undefined;
    const projectsById = excludeTaskWorkspaces || assistantHistory ? new Map(this.listProjects().map(project => [project.id, project])) : undefined;
    const allowed = new Map<string, IdentifiedSession>();
    for (const session of this.allSessions()) {
      if (sessionId !== undefined && session.id !== sessionId) continue;
      if (hidden?.has(session.backendId)) continue;
      if (hidePluginAgents && session.backendId.includes('.')) continue;
      const system = projectsById?.get(session.projectId)?.system;
      if (excludeTaskWorkspaces && system === 'task-workspace') continue;
      if (assistantHistory && (session.origin?.kind === 'assistant' || system === 'quick-chat')) continue;
      allowed.set(session.id, session);
    }
    return allowed;
  }

  /** Assistant and tool text, newest first. Prompts come from `searchPrompts`, which is complete. [sessionId] narrows it to one conversation; [excludedBackendIds] hides providers before the limit. */
  searchIndexedMessages(pattern: string, limit: number, sessionId?: string, excludedBackendIds?: readonly string[], excludeTaskWorkspaces = false, hidePluginAgents = false, assistantHistory = false): MessageSearchHit[] {
    if (limit <= 0) return [];
    const allowed = this.scopedSessions(sessionId, excludedBackendIds, excludeTaskWorkspaces, hidePluginAgents, assistantHistory);
    if (!allowed.size) return [];
    // The trigram index answers a plain substring of three characters or more; it cannot take an
    // ESCAPE clause, so a query holding a wildcard character keeps the scan. Either way the LIKE
    // on `message_index` decides; the scan (no index) reads only the newest `MESSAGE_SEARCH_BUDGET.scanRows` rows.
    const indexed = /^%[^%_\\]+%$/.test(pattern) && [...pattern.slice(1, -1)].length >= 3;
    const hits: MessageSearchHit[] = [];
    const pushRows = (rows: Array<{ sessionId: string; messageId: string; kind: MessageSearchHit['kind']; text: string; at: string }>) => {
      for (const row of rows) {
        const session = allowed.get(row.sessionId);
        if (!session) continue;
        hits.push(this.hitFromSession(session, row.messageId, row.kind, row.text, row.at));
        if (hits.length >= limit) break;
      }
    };
    if (sessionId !== undefined) {
      const rows = (indexed
        ? this.derivedSql(`SELECT m.session_id AS sessionId, m.message_id AS messageId, m.kind AS kind, m.text AS text, m.at AS at
          FROM message_index_fts f JOIN message_index m ON m.rowid = f.rowid
          WHERE f.text LIKE ? AND m.text LIKE ? ESCAPE '\\' AND m.session_id=? ORDER BY m.at DESC LIMIT ?`).all(pattern, pattern, sessionId, limit)
        : this.derivedSql(`SELECT m.session_id AS sessionId, m.message_id AS messageId, m.kind AS kind, m.text AS text, m.at AS at
          FROM message_index m
          WHERE m.text LIKE ? ESCAPE '\\' AND m.session_id=? ORDER BY m.at DESC LIMIT ?`).all(pattern, sessionId, limit)) as Array<{ sessionId: string; messageId: string; kind: MessageSearchHit['kind']; text: string; at: string }>;
      pushRows(rows);
      return hits;
    }
    // Stream rows in descending time order once (O(N)) rather than repeating LIMIT/OFFSET sorts.
    const iter = (indexed
      ? this.derivedSql(`SELECT m.session_id AS sessionId, m.message_id AS messageId, m.kind AS kind, m.text AS text, m.at AS at
        FROM message_index_fts f JOIN message_index m ON m.rowid = f.rowid
        WHERE f.text LIKE ? AND m.text LIKE ? ESCAPE '\\' ORDER BY m.at DESC`).iterate(pattern, pattern)
      : this.derivedSql(`SELECT m.session_id AS sessionId, m.message_id AS messageId, m.kind AS kind, m.text AS text, m.at AS at
        FROM (SELECT session_id, message_id, kind, text, at FROM message_index ORDER BY at DESC LIMIT ${MESSAGE_SEARCH_BUDGET.scanRows}) m
        WHERE m.text LIKE ? ESCAPE '\\' ORDER BY m.at DESC`).iterate(pattern)) as IterableIterator<{ sessionId: string; messageId: string; kind: MessageSearchHit['kind']; text: string; at: string }>;
    try {
      for (const row of iter) {
        const session = allowed.get(row.sessionId);
        if (!session) continue;
        hits.push(this.hitFromSession(session, row.messageId, row.kind, row.text, row.at));
        if (hits.length >= limit) break;
      }
    } finally {
      iter.return?.();
    }
    return hits;
  }

  /**
   * Questions, read straight out of the stored runs. Every submission is persisted there for every
   * backend, so this covers the whole history without reading any provider — which matters, because
   * reading an arbitrary conversation can start an agent.
   */
  searchPrompts(pattern: string, limit: number, sessionId?: string, excludedBackendIds?: readonly string[], excludeTaskWorkspaces = false, hidePluginAgents = false, assistantHistory = false): MessageSearchHit[] {
    const scope = searchScope(sessionId, excludedBackendIds, excludeTaskWorkspaces, hidePluginAgents, assistantHistory);
    const rows = this.sql(`SELECT r.command_id AS commandId, r.json AS runJson, s.json AS sessionJson
      FROM runs r JOIN sessions s ON s.id = r.session_id
      WHERE json_extract(r.json,'$.prompt') LIKE ? ESCAPE '\\'${scope.clause} ORDER BY r.rowid DESC LIMIT ?`).all(pattern, ...scope.params, limit) as Array<{commandId:string;runJson:string;sessionJson:string}>;
    return rows.map(row => {
      const run = JSON.parse(row.runJson) as Run;
      return { ...this.hit(row.sessionJson, `prompt:${row.commandId}`, 'user', run.prompt, run.createdAt), runId: run.id };
    });
  }

  private hit(sessionJson: string, messageId: string, kind: MessageSearchHit['kind'], text: string, at: string): MessageSearchHit {
    return this.hitFromSession(this.session(sessionJson), messageId, kind, text, at);
  }

  private hitFromSession(session: IdentifiedSession, messageId: string, kind: MessageSearchHit['kind'], text: string, at: string): MessageSearchHit {
    return {
      sessionId: session.id, projectId: session.projectId, sessionTitle: session.displayTitle ?? session.title,
      archived: Boolean(session.archivedAt), backendId: session.backendId,
      messageId, kind, text, at,
    };
  }

  private staleMessageSessions(backendIds: readonly string[], sessionId?: string, excludeTaskWorkspaces = false): IdentifiedSession[] {
    if (!backendIds.length) return [];
    const backends = new Set(backendIds);
    const allowed = this.scopedSessions(sessionId, undefined, excludeTaskWorkspaces);
    const indexedAt = new Map(
      (this.derivedSql('SELECT session_id, indexed_at FROM message_index_sessions').all() as Array<{ session_id: string; indexed_at: string }>)
        .map(row => [row.session_id, row.indexed_at] as const),
    );
    const hasMessage = new Set(
      (this.derivedSql('SELECT DISTINCT session_id FROM message_index').all() as Array<{ session_id: string }>)
        .map(row => row.session_id),
    );
    const stale: IdentifiedSession[] = [];
    for (const session of allowed.values()) {
      if (session.kind !== 'native' || !backends.has(session.backendId)) continue;
      const marked = indexedAt.get(session.id);
      const isStale = marked === undefined ? !hasMessage.has(session.id) : marked < (session.lastActivityAt ?? '');
      if (isStale) stale.push(session);
    }
    return stale;
  }

  /**
   * Conversations whose index may be behind, most recently active first, restricted to the
   * providers whose transcripts may be read without starting them: never indexed, or active since
   * they last were. A conversation indexed before that time was recorded counts as current.
   */
  sessionsMissingMessages(backendIds: readonly string[], limit: number, sessionId?: string, excludeTaskWorkspaces = false): IdentifiedSession[] {
    return this.staleMessageSessions(backendIds, sessionId, excludeTaskWorkspaces)
      .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
      .slice(0, limit);
  }

  /** How many of those conversations are still missing from the index. */
  countSessionsMissingMessages(backendIds: readonly string[], sessionId?: string, excludeTaskWorkspaces = false): number {
    return this.staleMessageSessions(backendIds, sessionId, excludeTaskWorkspaces).length;
  }

  /**
   * Attachments a message still points at: every unfinished run's, and every run's accepted since
   * `since`. Anything else on disk is only reachable from history older than that.
   */
  referencedAttachmentIds(since: string): Set<string> {
    const rows = this.sql(`SELECT DISTINCT a.value AS id FROM runs r, json_each(r.json,'$.native.input.attachmentIds') a
      WHERE json_extract(r.json,'$.createdAt')>=? OR json_extract(r.json,'$.state') NOT IN ('completed','failed','cancelled','interrupted')`).all(since) as Array<{ id: unknown }>;
    const terminalRows = this.sql(`SELECT DISTINCT a.value AS id FROM settings s, json_each(s.json,'$.attachmentIds') a
      WHERE s.key LIKE 'terminal-paste:%'`).all() as Array<{ id: unknown }>;
    // A user's follow-up keeps its attachments until it is removed, whether it is still waiting or has just settled.
    const followUpRows = this.sql("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='automations'").get()
      ? this.sql(`SELECT DISTINCT a.value AS id FROM automations f, json_each(f.json,'$.input.attachmentIds') a
        WHERE f.follow_up_session IS NOT NULL AND json_extract(f.json,'$.followUp.by')='user'`).all() as Array<{ id: unknown }> : [];
    return new Set([...rows, ...terminalRows, ...followUpRows].flatMap(row => typeof row.id === 'string' ? [row.id] : []));
  }

  /**
   * Drops exited terminal records created before `before` that nothing points at any more: no
   * conversation's `terminalId` and no unfinished run's. Running and detached ones always stay.
   */
  pruneExitedTerminals(before: string): number {
    const referenced = new Set<string>();
    for (const row of this.sql(`SELECT json_extract(json,'$.terminalId') AS id FROM sessions WHERE json_extract(json,'$.terminalId') IS NOT NULL`).all() as Array<{ id: string }>) referenced.add(row.id);
    for (const run of this.listUnfinishedNativeRuns()) if (run.native?.terminalId) referenced.add(run.native.terminalId);
    const remove = this.sql('DELETE FROM terminals WHERE id=?');
    let removed = 0;
    this.transaction(() => {
      for (const row of this.sql(`SELECT id FROM terminals WHERE json_extract(json,'$.state')='exited' AND json_extract(json,'$.createdAt')<?`).all(before) as Array<{ id: string }>) {
        if (referenced.has(row.id)) continue;
        removed += Number(remove.run(row.id).changes);
        this.sql("DELETE FROM settings WHERE key LIKE ?").run(`terminal-paste:${row.id}:%`);
      }
    });
    if (removed) this.terminalsChanged();
    return removed;
  }

  subscribe(sessionId: string, listener: (event: WorkbenchEvent) => void): () => void {
    let group = this.listeners.get(sessionId); if (!group) this.listeners.set(sessionId, group = new Set()); group.add(listener);
    return () => { group!.delete(listener); if (!group!.size) this.listeners.delete(sessionId); };
  }
  private broadcast(event: WorkbenchEvent) { for (const listener of this.listeners.get(event.sessionId) ?? []) { try { listener(event); } catch { /* A disconnected subscriber must not fail a committed event. */ } } }
  saveTerminal(item: TerminalInfo): TerminalInfo { this.sql('INSERT INTO terminals(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(item.id,JSON.stringify(item)); this.terminalsChanged(); return item; }
  getTerminal(id: string): TerminalInfo { const item=this.get<TerminalInfo>('terminals',id); if (!item) throw new AppError('TERMINAL_NOT_FOUND','Terminal does not exist',404); return item; }
  findTerminal(id: string): TerminalInfo | undefined { return this.get<TerminalInfo>('terminals',id); }
  listTerminals(): TerminalInfo[] { return this.all<TerminalInfo>('terminals'); }
  /** Unarchived sessions and all terminals per `state`, counted in SQL: the service monitor polls this and needs no rows. */
  stateCounts(): { sessions: Record<string, number>; terminals: Record<string, number> } {
    const count = (query: string) => Object.fromEntries((this.sql(query).all() as Array<{ state: string | null; n: number }>).map(row => [row.state ?? '', Number(row.n)]));
    return {
      sessions: count(`SELECT json_extract(json,'$.state') AS state, COUNT(*) AS n FROM sessions WHERE json_extract(json,'$.archivedAt') IS NULL GROUP BY 1`),
      terminals: count(`SELECT json_extract(json,'$.state') AS state, COUNT(*) AS n FROM terminals GROUP BY 1`),
    };
  }
  /** A stopped terminal's record and paste state, gone with the conversation it ran. */
  deleteTerminal(id: string): void {
    this.transaction(() => {
      this.sql('DELETE FROM terminals WHERE id=?').run(id);
      this.sql("DELETE FROM settings WHERE key LIKE ?").run(`terminal-paste:${id}:%`);
      this.terminalsChanged();
    });
  }
  updateTerminal(id: string, patch: Partial<TerminalInfo>): TerminalInfo { return this.saveTerminal({...this.getTerminal(id),...patch,id}); }
  /** Conversations holding at least one mark. */
  sessionsWithMarks(): Set<string> {
    return new Set((this.sql('SELECT DISTINCT session_id FROM marks').all() as Array<{ session_id: string }>).map(row => row.session_id));
  }
  getSetting<T>(key: string, fallback: T): T { const row=this.sql('SELECT json FROM settings WHERE key=?').get(key) as {json:string}|undefined; return row ? JSON.parse(row.json) : fallback; }
  deleteSetting(key: string): void { this.sql('DELETE FROM settings WHERE key=?').run(key); }
  setSetting(key: string, value: unknown) { this.sql('INSERT INTO settings(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run(key,JSON.stringify(value)); }
  saveWorkbenchDocumentProof(digest: string, expiresAt: number, nowMs: number, limit: number): void {
    this.transaction(() => {
      this.sql('DELETE FROM workbench_document_proofs WHERE expires_at<=?').run(nowMs);
      this.sql('INSERT INTO workbench_document_proofs(digest,expires_at) VALUES(?,?)').run(digest, expiresAt);
      this.sql('DELETE FROM workbench_document_proofs WHERE rowid IN (SELECT rowid FROM workbench_document_proofs ORDER BY rowid DESC LIMIT -1 OFFSET ?)').run(limit);
    });
  }
  takeWorkbenchDocumentProof(digest: string, nowMs: number): boolean {
    const row = this.sql('DELETE FROM workbench_document_proofs WHERE digest=? RETURNING expires_at').get(digest) as { expires_at: number } | undefined;
    return row !== undefined && row.expires_at > nowMs;
  }
  private interactionReceiptKey(requestId: string): string {
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200 || /[\0\r\n]/.test(requestId)) throw new AppError('INVALID_INTERACTION_REQUEST_ID', 'Interaction request id is invalid');
    return createHash('sha256').update(requestId).digest('hex');
  }
  /**
   * The context window the provider last reported for one provider chat, so a restarted server or a
   * reopened conversation shows it before the provider reports again. A different chat (the CLI
   * started over under a new id) has none.
   */
  getNativeContext(sessionId: string, nativeSessionId: string): NativeContext | undefined {
    const saved = this.getSetting<{ nativeSessionId: string; context: NativeContext } | undefined>(`native-context:${sessionId}`, undefined);
    return saved?.nativeSessionId === nativeSessionId ? saved.context : undefined;
  }
  /** No context withdraws the saved one: the provider said it has nothing to report for this chat. */
  saveNativeContext(sessionId: string, nativeSessionId: string, context: NativeContext | undefined) {
    if (context) this.setSetting(`native-context:${sessionId}`, { nativeSessionId, context });
    else this.sql('DELETE FROM settings WHERE key=?').run(`native-context:${sessionId}`);
  }
  getNativeInteractionReceipt(sessionId: string, requestId: string): { fingerprint: string; interactionId: string; revision: string; result: NativeInteractionResult; createdAt: string } | undefined {
    this.getSession(sessionId);
    const receipts = this.getSetting<Record<string, { fingerprint: string; interactionId: string; revision: string; result: NativeInteractionResult; createdAt: string }>>(`native-interactions:${sessionId}`, {});
    return receipts[this.interactionReceiptKey(requestId)];
  }
  saveNativeInteractionReceipt(sessionId: string, requestId: string, receipt: { fingerprint: string; interactionId: string; revision: string; result: NativeInteractionResult; createdAt: string }) {
    this.getSession(sessionId);
    const receiptKey = this.interactionReceiptKey(requestId);
    const key = `native-interactions:${sessionId}`;
    const receipts = this.getSetting<Record<string, typeof receipt>>(key, {});
    const existing = receipts[receiptKey];
    if (existing && (existing.fingerprint !== receipt.fingerprint || existing.interactionId !== receipt.interactionId || existing.revision !== receipt.revision)) {
      throw new AppError('NATIVE_INTERACTION_REQUEST_CONFLICT', 'This interaction retry id was already used for a different answer', 409);
    }
    if (existing?.result.status === 'completed' && receipt.result.status !== 'completed') return existing;
    receipts[receiptKey] = receipt;
    this.setSetting(key, retainedReceipts(receipts, receiptKey));
    return receipt;
  }
  getSettings(): AppSettings { return this.getSetting('app',{}); }
  async backup(destination: string) { mkdirSync(dirname(destination),{recursive:true,mode:0o700}); await backup(this.db,destination); chmodSync(destination,0o600); }
  async backupJournal(destination: string) { mkdirSync(dirname(destination),{recursive:true,mode:0o700}); await backup(this.journalDb,destination); chmodSync(destination,0o600); }
  /**
   * Keeps L2 search index bounded and low-fragmentation: trims any legacy oversized `tool` rows down to
   * `STORAGE_BUDGET.toolIndexChars` in bounded batches (persisting completion in `derived_meta` so
   * steady-state maintenance never full-scans `message_index`), and merges FTS5 segments incrementally.
   */
  maintainDerivedSearch(options: { maxToolTrims?: number; fullOptimize?: boolean } = {}): { trimmedTools: number } {
    const maxToolTrims = options.maxToolTrims ?? 2_000;
    const cap = STORAGE_BUDGET.toolIndexChars;
    let trimmedTools = 0;
    try {
      const doneCap = this.getDerivedMeta<number | undefined>('tool-index-trimmed-cap', undefined);
      if (maxToolTrims > 0 && cap > 0 && (doneCap === undefined || doneCap > cap)) {
        const rows = this.derivedSql(`SELECT rowid FROM message_index WHERE kind='tool' AND length(text)>? LIMIT ?`)
          .all(cap, maxToolTrims) as Array<{ rowid: number }>;
        if (rows.length) {
          const trim = this.derivedSql(`UPDATE message_index SET text=substr(text,1,?) WHERE rowid=?`);
          this.derivedTx(() => {
            for (const row of rows) trimmedTools += Number(trim.run(cap, row.rowid).changes);
          });
          this.noteMessageIndexShape();
        }
        if (rows.length < maxToolTrims) this.setDerivedMeta('tool-index-trimmed-cap', cap);
      }
      const hasFts = this.derivedSql("SELECT 1 AS found FROM sqlite_master WHERE name='message_index_fts'").get();
      if (hasFts) {
        if (options.fullOptimize) {
          this.derivedDb.exec("INSERT INTO message_index_fts(message_index_fts) VALUES('optimize')");
        } else {
          this.derivedDb.exec("INSERT INTO message_index_fts(message_index_fts, rank) VALUES('merge', 64)");
        }
      }
    } catch { /* derived search maintenance is best-effort */ }
    return { trimmedTools };
  }
  /** Bounded online incremental vacuum, planner stats refresh, and incremental maintenance across L0, L1 and L2. */
  reclaimSpace(options: { busy?: () => boolean; checkpoint?: boolean; vacuumOnly?: boolean } = {}): { control: number; journal: number; derived: number } {
    const isBusy = options.busy ?? eventLoopBusy;
    if (!options.vacuumOnly && !isBusy()) {
      let trimmedBlobs = 0;
      try {
        const coldIds = this.coldSessionsForTrimming();
        if (coldIds.length) trimmedBlobs = this.journal.trimArchivedToolBlobs(coldIds, { limit: 20 });
        const assistant = this.assistantMainForTrimming();
        if (assistant && trimmedBlobs < 20) {
          trimmedBlobs += this.journal.trimArchivedToolBlobs([assistant.sessionId], { limit: 20 - trimmedBlobs, beforeAt: assistant.beforeAt });
        }
      } catch { /* best-effort cold trimming */ }
      if (trimmedBlobs > 0 && !isBusy()) {
        try { this.journal.sweepBlobs(); } catch { /* best-effort immediate sweep of newly unreferenced blobs */ }
      }
      if (!isBusy()) {
        try { this.journal.recompressSmallBlobs({ maxBlobs: 200 }); } catch { /* best-effort dict upgrade */ }
      }
      if (!isBusy()) this.maintainDerivedSearch({ maxToolTrims: 500 });
    }
    const result = {
      control: reclaimFreePages(this.db, { ...options, busy: isBusy }),
      journal: reclaimFreePages(this.journalDb, { ...options, busy: isBusy }),
      derived: reclaimFreePages(this.derivedDb, { ...options, busy: isBusy }),
    };
    if ((!options.vacuumOnly || options.checkpoint) && !isBusy()) {
      optimizeDatabase(this.db);
      optimizeDatabase(this.journalDb);
      optimizeDatabase(this.derivedDb);
    }
    if (options.checkpoint) {
      for (const db of [this.db, this.journalDb, this.derivedDb]) {
        try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* ignore */ }
      }
    }
    return result;
  }
  recoverInterruptedRuns() {
    this.transaction(() => {
      for (const session of this.listSessions()) {
        for (const run of this.listRuns(session.id)) {
          if (session.kind === 'native' && run.native) {
            if (['completed', 'failed', 'cancelled'].includes(run.state) || ['failed', 'cancelled'].includes(run.native.delivery)) continue;
            const delivery = run.native.delivery;
            if (delivery === 'queued' || delivery === 'preparing') {
              // The pending inbox of a steer did not survive the restart, so it reaches no turn but the next.
              if (run.native.intent === 'steer') { this.requeueSteer(run.id); continue; }
              if (delivery !== 'queued' || run.state !== 'queued' || run.error) {
                this.transitionNativeRun(run.id, [delivery], { delivery: 'queued' }, { state: 'queued', error: undefined });
              }
            } else if (delivery === 'dispatching' || delivery === 'input_sent') {
              this.transitionNativeRun(run.id, [delivery], { delivery: 'uncertain' }, {
                state: 'interrupted',
                error: 'Local service restarted while native terminal delivery was in progress; the prompt was not resent.',
              });
            } else if (restartObservation(run.native.backendId) === 'hook'
              && (delivery === 'observed' || delivery === 'uncertain' && run.native.nativeMessageId
                && ['runtime_exit', 'turn_outcome_unknown'].includes(run.native.stage ?? ''))
              && (run.native.expectsTurnOutcome || run.native.intent === 'steer')
              || restartObservation(run.native.backendId) === 'daemon' && delivery === 'observed' && run.native.nativeTurnId && !run.native.queueReleasedAt) {
              // A missing Stop, or a turn end the daemon recorded while we were down, is an unknown outcome,
              // not an unknown send. Keep the durable receipt and wait for this turn's end; the provider's
              // record (transcript end rows, the daemon's turn status) or the current idle/exit closes it
              // without replaying it. Waiting for the outcome gives the first read of the thread the longer
              // idle grace. A Codex receipt already settled as uncertain stays as it was.
              this.transitionNativeRun(run.id, [delivery], { delivery: 'observed', stage: 'executing', expectsTurnOutcome: true }, {
                state: 'running', error: undefined,
              });
            }
          } else if (run.state === 'running') {
            this.updateRun(run.id, { state: 'interrupted', error: 'Local service restarted; prompt was not resubmitted.' });
          }
        }
      }
    });
  }
  close() {
    this.noteMessageIndexShape();
    optimizeDatabase(this.derivedDb);
    optimizeDatabase(this.journalDb);
    optimizeDatabase(this.db);
    this.listeners.clear(); this.runListeners.clear(); this.listListeners.clear(); this.deletionListeners.clear();
    this.statements.clear(); this.derivedStatements.clear();
    this.derivedDb.close(); this.journalDb.close(); this.db.close();
  }
}
