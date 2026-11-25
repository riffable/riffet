import { DatabaseSync, backup, type StatementSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  type Project, type Session, type Run, type RunMetrics, type NativeBackendId,
  type NativeDeliveryState, type NativeRunConfig, type NativeRunDetails, type NativeRunInput,
  type CapturedSessionReference, type NativeSessionInput, type NativeContext,
  type NativeInteractionResult, type NativeTurnTarget, type TerminalInfo,
  type WorkbenchEvent, type AppSettings, type TitleRule, type TitleRuleContext,
  matchTitleRule, renderDisplayTitle,
} from '../../../packages/contracts/src/index.js';
import { AppError } from './errors.js';
import { sessionReferenceInputs } from './context-references/input.js';
import { agentMentionInputs } from './native/agent-mentions.js';
import { acceptedTitlePatch, firstHumanMessage } from './session-title.js';
import type { IndexedMessage } from './search/messages.js';
import { Journal } from './journal/journal.js';
import { migrateStorageLayout, needsStorageLayoutMigration } from './journal/storage-migration.js';
import {
  applyNativeSessionIdPatch, normalizeRunIdentity, normalizeSessionIdentity,
  type IdentifiedRun, type IdentifiedSession,
} from './session-identity.js';
import { openSqliteDatabase, optimizeDatabase, storageLayoutForControlDb, type StorageLayoutPaths } from './sqlite-storage.js';
import * as derivedSearch from './store/derived-search.js';
import * as maintenance from './store/maintenance.js';
import * as runsApi from './store/runs.js';
import {
  ACTIVE_SESSION_STATES, clientTitleSource, deepFreeze, DELETED_PREFIX,
  fingerprint, normalizeNativeConfig, normalizedNativeSessionInput, now,
  SESSION_SETTING_PREFIXES, SESSION_SNAPSHOT_PRUNE_EVERY, SESSION_SNAPSHOTS_KEPT,
  sessionDeleted, type DeletedSession, type MessageSearchHit, type StoredFolderFavorite, type StorePort,
} from './store/shared.js';
import * as workspaceRecords from './store/workspace-records.js';

export type { DeletedSession, MessageSearchHit, StoredFolderFavorite } from './store/shared.js';
export { retainedReceipts, sessionDeleted } from './store/shared.js';

/** v4: spaces removed, plus project lifecycle rules; v5: deleted conversations (see the constructor). */
const SCHEMA_VERSION = 5;

function normalizeNativeInput(input: NativeRunInput): NativeRunInput {
  if (!input || typeof input.text !== 'string' || !Array.isArray(input.attachmentIds) || !Array.isArray(input.context)) {
    throw new AppError('INVALID_NATIVE_INPUT', 'Native input must include text, attachmentIds, and context');
  }
  if (input.attachmentIds.some((id) => typeof id !== 'string' || !id) || input.context.some((item) => !item || typeof item.path !== 'string' || !item.path || (item.line !== undefined && (!Number.isInteger(item.line) || item.line < 1)))) {
    throw new AppError('INVALID_NATIVE_INPUT', 'Native attachment and context references are invalid');
  }
  const references = sessionReferenceInputs(input.references);
  const agents = agentMentionInputs(input.agents);
  return {
    ...(references ? { references } : {}),
    ...(agents ? { agents } : {}),
    text: input.text,
    attachmentIds: [...input.attachmentIds],
    context: input.context.map(({ path, line }) => ({ path, ...(line !== undefined ? { line } : {}) })),
  };
}

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
  private readonly port: StorePort;
  /**
   * Every session, parsed once and kept until a session write (`sessionsChanged`) or a rollback; docs/guide/performance.md §3.3.
   * The cache is never handed out: callers get top-level copies whose nested values are frozen, so a caller
   * that edits what it was given cannot corrupt the next caller's list.
   */
  private sessionCache: IdentifiedSession[] | undefined;
  /**
   * Every terminal, parsed once and kept until a terminal write (`terminalsChanged`) or a rollback;
   * docs/guide/performance.md §3.3. Callers get top-level copies with frozen nested values.
   */
  private terminalCache: TerminalInfo[] | undefined;
  /** Every project indexed by id, parsed once and kept until a project write (`projectsChanged`) or rollback. */
  private projectCache: Map<string, Project> | undefined;
  /**
   * 会话标题规则 (docs/SESSION-TITLES.md), read on every session write. `displayTitle` is derived: whatever a
   * writer passes for it is dropped and recomputed here, so no caller can store a stale one.
   */
  private titleRules: () => { rules?: readonly TitleRule[]; timeZone?: string } = () => ({});

  constructor(readonly path: string) {
    this.layout = storageLayoutForControlDb(path);
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (needsStorageLayoutMigration(path)) {
        try { migrateStorageLayout(path); } catch (error) { console.error('[riffet] storage layout migration failed:', error); throw error; }
      }
    }
    this.db = openSqliteDatabase(path, { foreignKeys: true, role: 'control' });
    const schemaVersion = (this.sql('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (schemaVersion > SCHEMA_VERSION) { this.db.close(); throw new AppError('DATABASE_VERSION_NEWER', 'This workbench database requires a newer Riffet version', 409); }
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
      CREATE INDEX IF NOT EXISTS event_session_type ON events(session_id, json_extract(json,'$.type'), sequence);
      CREATE TABLE IF NOT EXISTS marks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS marks_session ON marks(session_id);
      CREATE INDEX IF NOT EXISTS marks_created ON marks(created_at, id);
      CREATE TABLE IF NOT EXISTS session_shares (id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS folder_favorites (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(project_id, path));
      CREATE TABLE IF NOT EXISTS council_discussions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS council_updated ON council_discussions(updated_at DESC, id);
      CREATE TABLE IF NOT EXISTS agent_call_turns (run_id TEXT PRIMARY KEY, call_id TEXT NOT NULL, caller_session_id TEXT NOT NULL, caller_run_id TEXT,
        prompt TEXT NOT NULL, mode TEXT NOT NULL, background INTEGER NOT NULL DEFAULT 0, delivered_at TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_call_turns_call ON agent_call_turns(call_id, created_at);
      CREATE INDEX IF NOT EXISTS agent_call_turns_caller ON agent_call_turns(caller_session_id, created_at);
      CREATE INDEX IF NOT EXISTS agent_call_turns_pending ON agent_call_turns(background) WHERE delivered_at IS NULL;`);
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
    this.derivedDb = derivedSearch.openDerivedDatabase(this.layout);
    this.port = {
      db: this.db, journalDb: this.journalDb, derivedDb: this.derivedDb, layout: this.layout, journal: this.journal,
      sql: text => this.sql(text),
      derivedSql: text => this.derivedSql(text),
      derivedTx: fn => this.derivedTx(fn),
      transaction: fn => this.transaction(fn),
      get: (table, id) => this.get(table, id),
      all: table => this.all(table),
      replace: (table, id, value) => this.replace(table, id, value),
      session: json => this.session(json),
      run: json => this.run(json),
      identified: run => this.identified(run),
      allSessions: () => this.allSessions(),
      listProjects: () => this.listProjects(),
      getProject: id => this.getProject(id),
      listSessions: () => this.listSessions(),
      getSession: id => this.getSession(id),
      listRuns: sessionId => this.listRuns(sessionId),
      getRun: id => this.getRun(id),
      findRunByCommand: (sessionId, commandId) => this.findRunByCommand(sessionId, commandId),
      listUnfinishedNativeRuns: sessionId => this.listUnfinishedNativeRuns(sessionId),
      getTerminal: id => this.getTerminal(id),
      getSetting: (key, fallback) => this.getSetting(key, fallback),
      setSetting: (key, value) => this.setSetting(key, value),
      deleteSetting: key => this.deleteSetting(key),
      getSettings: () => this.getSettings(),
      updateRun: (id, patch) => this.updateRun(id, patch),
      transitionNativeRun: (id, expectedDelivery, nativePatch, runPatch) => this.transitionNativeRun(id, expectedDelivery, nativePatch, runPatch),
      requeueSteer: id => this.requeueSteer(id),
      isSteerTargetTurnEnded: run => this.isSteerTargetTurnEnded(run),
      createNativeSubmission: (clientSessionId, sessionInput, commandId, input, contextSnapshots) => this.createNativeSubmission(clientSessionId, sessionInput, commandId, input, contextSnapshots),
      normalizeNativeInput,
      acceptNativeRun: (sessionId, commandId, input, config, expectedConfigRevision, steer, contextSnapshots) => this.acceptNativeRun(sessionId, commandId, input, config, expectedConfigRevision, steer, contextSnapshots),
      updateSessionActivity: (id, activityAt) => this.updateSessionActivity(id, activityAt),
      appendEvent: (sessionId, type, data, extra) => this.appendEvent(sessionId, type, data, extra),
      nameFromMessage: (sessionId, prompt) => this.nameFromMessage(sessionId, prompt),
      runChanged: run => this.runChanged(run),
      projectsChanged: classified => this.projectsChanged(classified),
      terminalsChanged: () => this.terminalsChanged(),
      marksChanged: () => this.marksChanged(),
      favoritesChanged: () => this.favoritesChanged(),
      refreshDisplayTitles: () => this.refreshDisplayTitles(),
      pruneRunSnapshots: (sessionId, runId) => this.pruneRunSnapshots(sessionId, runId),
      pruneSessionSnapshots: (sessionId, keep) => this.pruneSessionSnapshots(sessionId, keep),
      noteMessageIndexShape: () => derivedSearch.noteMessageIndexShape(this.port),
      hotTimelineSessions: () => derivedSearch.hotTimelineSessions(this.port),
    };
    try { derivedSearch.ensureMessageSearchIndex(this.port); } catch (error) { console.error('[riffet] message search index unavailable; search falls back to a table scan:', error); }
    maintenance.runStartupMigrations(this.port, schemaVersion);
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
  private get<T>(table: string, id: string): T | undefined {
    const row = this.sql(`SELECT json FROM ${table} WHERE id=?`).get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as T : undefined;
  }
  private all<T>(table: string): T[] { return (this.sql(`SELECT json FROM ${table} ORDER BY rowid`).all() as { json: string }[]).map(row => JSON.parse(row.json) as T); }
  private session(json: string): IdentifiedSession { return normalizeSessionIdentity(JSON.parse(json) as Session); }
  private run(json: string): IdentifiedRun { return this.identified(JSON.parse(json) as Run); }
  private identified(run: Run): IdentifiedRun { return normalizeRunIdentity(run, () => this.ownerBackendId(run.sessionId)); }
  private allSessions(): IdentifiedSession[] {
    this.sessionCache ??= (this.sql('SELECT json FROM sessions ORDER BY rowid').all() as { json: string }[]).map(row => {
      const session = this.session(row.json);
      for (const value of Object.values(session)) if (value && typeof value === 'object') deepFreeze(value);
      return session;
    });
    return this.sessionCache.map(session => ({ ...session }));
  }
  private allProjects(): Map<string, Project> {
    if (!this.projectCache) {
      const map = new Map<string, Project>();
      for (const row of this.sql('SELECT json FROM projects ORDER BY rowid').all() as { json: string }[]) {
        const project = JSON.parse(row.json) as Project;
        for (const value of Object.values(project)) if (value && typeof value === 'object') deepFreeze(value);
        map.set(project.id, project);
      }
      this.projectCache = map;
    }
    return this.projectCache;
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
          backendId, ownerSessionId: run.sessionId, runId: run.id,
        });
      }
    }
    for (const owner of sessions) {
      if (owner.id === ignoreSessionId || owner.kind !== 'native') continue;
      if (owner.backendId !== backendId || owner.nativeSessionId !== nativeSessionId) continue;
      if (!owner.archivedAt || activeRuns.some(run => run.sessionId === owner.id)) {
        throw new AppError('NATIVE_SESSION_ID_IN_USE', 'This native session is already bound to another conversation', 409, {
          backendId, ownerSessionId: owner.id,
        });
      }
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try {
      const result = fn(); this.db.exec('COMMIT'); this.depth--;
      for (const coord of this.txCoordinators.splice(0)) { try { coord(true); } catch (error) { console.error('[riffet] transaction coordinator failed:', error); } }
      const events = this.pending.splice(0); for (const event of events) this.broadcast(event);
      const runs = [...this.pendingRuns.values()]; this.pendingRuns.clear(); for (const run of runs) this.emitRun(run);
      if (this.listsDirty) { this.listsDirty = false; this.emitLists(); }
      for (const hook of this.settleHooks.splice(0)) { try { hook(true); } catch (error) { console.error('[riffet] afterTransaction hook failed:', error); } }
      return result;
    }
    catch (error) {
      this.sessionCache = undefined;
      this.terminalCache = undefined;
      this.projectCache = undefined;
      this.db.exec('ROLLBACK'); this.depth--; this.pending.length = 0; this.pendingRuns.clear(); this.listsDirty = false;
      for (const coord of this.txCoordinators.splice(0)) { try { coord(false); } catch (coordError) { console.error('[riffet] transaction rollback coordinator failed:', coordError); } }
      for (const hook of this.settleHooks.splice(0)) { try { hook(false); } catch (hookError) { console.error('[riffet] afterTransaction rollback hook failed:', hookError); } }
      throw error;
    }
  }
  afterTransaction(fn: (committed: boolean) => void): void { if (this.depth) this.settleHooks.push(fn); else fn(true); }
  onRunChanged(listener: (run: Run) => void): () => void { this.runListeners.add(listener); return () => { this.runListeners.delete(listener); }; }
  private runChanged(run: Run) {
    if (!this.runListeners.size) return;
    if (this.depth) this.pendingRuns.set(run.id, run); else this.emitRun(run);
  }
  onSessionState(listener: (session: Session, from: Session['state']) => void): () => void { this.stateListeners.add(listener); return () => { this.stateListeners.delete(listener); }; }
  onListsChanged(listener: () => void): () => void { this.listListeners.add(listener); return () => { this.listListeners.delete(listener); }; }
  get listRevision(): number { return this.listRevisionValue; }
  get terminalsRevision(): number { return this.terminalsRevisionValue; }
  get projectRevision(): number { return this.projectRevisionValue; }
  get marksRevision(): number { return this.marksRevisionValue; }
  get workItemsRevision(): number { return this.workItemsRevisionValue; }
  get favoritesRevision(): number { return this.favoritesRevisionValue; }
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
  private terminalsChanged() { this.terminalCache = undefined; this.terminalsRevisionValue += 1; this.notifyLists(); }
  private projectsChanged(classified?: string) {
    this.projectCache = undefined;
    this.projectRevisionValue += 1;
    if (classified === undefined) { this.notifyLists(); return; }
    this.sessionsChanged((this.sql('SELECT id FROM sessions WHERE project_id=?').all(classified) as Array<{ id: string }>).map(row => row.id));
    this.terminalsChanged();
  }
  marksChanged() { this.marksRevisionValue += 1; this.notifyLists(); }
  workItemsChanged() { this.workItemsRevisionValue += 1; this.notifyLists(); }
  private favoritesChanged() { this.favoritesRevisionValue += 1; this.notifyLists(); }
  private notifyLists() {
    if (!this.listListeners.size) return;
    if (this.depth) this.listsDirty = true; else this.emitLists();
  }
  private emitLists() { for (const listener of this.listListeners) { try { listener(); } catch { /* derived views must not fail a committed write */ } } }
  private emitRun(run: Run) { for (const listener of this.runListeners) { try { listener(run); } catch { /* derived views must not fail a committed write */ } } }

  createProject(cwd: string, name: string, worktree?: Project['worktree']): Project { return workspaceRecords.createProject(this.port, cwd, name, worktree); }
  getProject(id: string): Project {
    const item = this.allProjects().get(id);
    if (!item) throw new AppError('PROJECT_NOT_FOUND', 'Project does not exist', 404);
    return { ...item };
  }
  createTaskWorkspaceSubmission(project: Project, clientSessionId: string, sessionInput: NativeSessionInput, commandId: string, input: NativeRunInput, contextSnapshots?: CapturedSessionReference[]): { project: Project; session: Session; run: Run } {
    return workspaceRecords.createTaskWorkspaceSubmission(this.port, project, clientSessionId, sessionInput, commandId, input, contextSnapshots);
  }
  promoteTaskWorkspace(id: string, name: string): Project { return workspaceRecords.promoteTaskWorkspace(this.port, id, name); }
  listProjects(): Project[] { return [...this.allProjects().values()].map(project => ({ ...project })); }
  updateProject(id: string, patch: Partial<Project>): Project { return workspaceRecords.updateProject(this.port, id, patch); }
  originChain(projectId: string): string[] { return workspaceRecords.originChain(this.port, projectId); }
  deleteProject(id: string) { workspaceRecords.deleteProject(this.port, id); }
  listFolderFavorites(projectId?: string) { return workspaceRecords.listFolderFavorites(this.port, projectId); }
  getFolderFavorite(id: string) { return workspaceRecords.getFolderFavorite(this.port, id); }
  createFolderFavorite(path: string, projectId?: string, label?: string) { return workspaceRecords.createFolderFavorite(this.port, path, projectId, label); }
  updateFolderFavorite(id: string, patch: Partial<Pick<StoredFolderFavorite, 'label' | 'lastUsedAt'>>) { return workspaceRecords.updateFolderFavorite(this.port, id, patch); }
  reorderFolderFavorites(ids: string[], projectId?: string) { return workspaceRecords.reorderFolderFavorites(this.port, ids, projectId); }
  deleteFolderFavorite(id: string) { workspaceRecords.deleteFolderFavorite(this.port, id); }

  configureTitleRules(read: () => { rules?: readonly TitleRule[]; timeZone?: string }): void { this.titleRules = read; }
  private withDisplayTitle<T extends Session>(session: T): T {
    const { displayTitle: _derived, ...rest } = session;
    const { rules } = this.titleRules();
    if (!rules?.length) return rest as T;
    const displayTitle = renderDisplayTitle(rules, session, this.titleRuleContext(session));
    return (displayTitle ? { ...rest, displayTitle } : rest) as T;
  }
  titleRuleFor(session: Session): TitleRule | undefined {
    const { rules } = this.titleRules();
    return rules?.length ? matchTitleRule(rules, session, this.titleRuleContext(session)) : undefined;
  }
  private titleRuleContext(session: Pick<Session, 'projectId'>): TitleRuleContext {
    const projects = this.allProjects();
    const project = projects.get(session.projectId);
    const originProject = project?.worktree ? projects.get(project.worktree.originProjectId) : undefined;
    const { timeZone } = this.titleRules();
    return { ...(project ? { project } : {}), ...(originProject ? { originProject } : {}), ...(timeZone ? { timeZone } : {}) };
  }
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

  createSession(input: Pick<Session, 'projectId' | 'kind'> & Partial<Session>): IdentifiedSession {
    return this.transaction(() => {
      this.getProject(input.projectId);
      const stamp = now();
      const item = normalizeSessionIdentity({ ...input, id: randomUUID(), title: input.title || 'New conversation', ...clientTitleSource(input.title), tags: input.tags ?? [], state: 'idle', mode: input.mode ?? 'agent', lastActivityAt: input.lastActivityAt ?? stamp, seenActivityAt: input.lastActivityAt ?? stamp, createdAt: stamp, updatedAt: stamp });
      this.assertNativeIdentityAvailable(item);
      const shown = this.withDisplayTitle(item);
      this.sql('INSERT INTO sessions(id,project_id,json) VALUES(?,?,?)').run(shown.id, shown.projectId, JSON.stringify(shown));
      this.sessionsChanged([shown.id]);
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
  pendingDeletionCleanups(): string[] {
    return (this.sql(`SELECT key FROM settings WHERE key LIKE '${DELETED_PREFIX}%' AND json_extract(json,'$.cleanupPending')=1`).all() as Array<{ key: string }>).map(row => row.key.slice(DELETED_PREFIX.length));
  }
  deletionCleaned(id: string): void {
    const record = this.deletedSession(id);
    if (record?.cleanupPending) this.setSetting(`${DELETED_PREFIX}${id}`, { ...record, cleanupPending: false });
  }
  deleteSessions(rootId: string, ids: readonly string[]): DeletedSession {
    return this.transaction(() => {
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
        derivedSearch.noteMessageIndexShape(this.port);
      });
      return { rootId, deletedAt, cleanupPending: true, sessionIds: [...ids] };
    });
  }
  purgeDeletedSessionArtifacts(id: string): void {
    for (const key of this.journal.keysOf(id)) this.journal.drop(key);
    this.journal.drop(id);
    this.derivedTx(() => {
      this.derivedSql('DELETE FROM message_index WHERE session_id=?').run(id);
      this.derivedSql('DELETE FROM message_index_sessions WHERE session_id=?').run(id);
    });
  }
  sessionActivity(id: string): { at?: string; running: boolean } | undefined {
    const item = this.get<Session>('sessions', id);
    if (!item) return undefined;
    const times = [item.lastActivityAt, item.updatedAt].filter((value): value is string => typeof value === 'string').sort();
    return { ...(times.length ? { at: times.at(-1)! } : {}), running: ACTIVE_SESSION_STATES.has(item.state) };
  }
  onSessionDeleted(id: string, listener: () => void): () => void {
    let group = this.deletionListeners.get(id);
    if (!group) this.deletionListeners.set(id, group = new Set());
    group.add(listener);
    return () => { group!.delete(listener); if (!group!.size) this.deletionListeners.delete(id); };
  }
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
    if (!nativeId && !session.resumePicker) return this.listRuns(sessionId)[0]?.prompt;
    return undefined;
  }
  waitingSessionIds(): string[] {
    return (this.sql("SELECT id FROM sessions WHERE json_extract(json,'$.state')='waiting' AND json_extract(json,'$.archivedAt') IS NULL").all() as { id: string }[]).map(row => row.id);
  }
  listSessions(): IdentifiedSession[] { return this.allSessions().sort((a, b) => (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt)); }
  updateSession(id: string, patch: Partial<Session>): IdentifiedSession {
    return this.transaction(() => {
      const current = this.getSession(id);
      const merged: Session = { ...current, ...patch, id, updatedAt: now() };
      applyNativeSessionIdPatch(merged, patch, () => new AppError('INVALID_NATIVE_SESSION_ID', 'Cursor session id fields must agree'));
      const item = this.withDisplayTitle(normalizeSessionIdentity(merged));
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
  markSessionSeen(id: string, activityAt?: string): IdentifiedSession | undefined {
    return this.transaction(() => {
      const current = this.getSession(id);
      const latest = Date.parse(current.lastActivityAt ?? current.createdAt);
      const requested = activityAt === undefined ? latest : Date.parse(activityAt);
      if (!Number.isFinite(requested) || !Number.isFinite(latest)) return undefined;
      const target = Math.min(requested, latest);
      if (current.seenActivityAt && Date.parse(current.seenActivityAt) >= target) return undefined;
      const session = this.updateSession(id, { seenActivityAt: new Date(target).toISOString() });
      this.appendEvent(id, 'session', { session });
      return session;
    });
  }
  private nameFromMessage(sessionId: string, prompt: string): void {
    const patch = acceptedTitlePatch(this.getSession(sessionId), prompt);
    if (!patch) return;
    const session = this.updateSession(sessionId, patch);
    this.appendEvent(sessionId, 'session', { session });
  }
  createIdleNativeSession(clientSessionId: string, sessionInput: NativeSessionInput, creationFingerprint: string): { session: IdentifiedSession; created: boolean } {
    if (typeof clientSessionId !== 'string' || !clientSessionId || clientSessionId.length > 200) throw new AppError('INVALID_SESSION_ID', 'clientSessionId must be a non-empty string up to 200 characters');
    const normalized = normalizedNativeSessionInput(sessionInput);
    return this.transaction(() => {
      if (this.isSessionDeleted(clientSessionId)) throw sessionDeleted(clientSessionId);
      const stored = this.get<Session>('sessions', clientSessionId);
      const existing = stored && normalizeSessionIdentity(stored);
      if (existing) {
        if (existing.kind !== 'native' || existing.creationFingerprint !== creationFingerprint) {
          throw new AppError('SESSION_ID_CONFLICT', 'This clientSessionId was already used for a different session creation request', 409);
        }
        return { session: existing, created: false };
      }
      this.getProject(normalized.projectId);
      const stamp = now();
      let session: IdentifiedSession = {
        ...normalized,
        ...clientTitleSource(normalized.title),
        id: clientSessionId, kind: 'native', state: 'idle', configRevision: 0, creationFingerprint,
        lastActivityAt: stamp, seenActivityAt: stamp, createdAt: stamp, updatedAt: stamp,
      };
      this.assertNativeIdentityAvailable(session);
      session = this.withDisplayTitle(session);
      this.sql('INSERT INTO sessions(id,project_id,json) VALUES(?,?,?)').run(session.id, session.projectId, JSON.stringify(session));
      this.sessionsChanged([session.id]);
      return { session, created: true };
    });
  }
  createNativeSubmission(clientSessionId: string, sessionInput: NativeSessionInput, commandId: string, input: NativeRunInput, contextSnapshots?: CapturedSessionReference[]): { session: IdentifiedSession; run: IdentifiedRun } {
    if (typeof clientSessionId !== 'string' || !clientSessionId || clientSessionId.length > 200) throw new AppError('INVALID_SESSION_ID', 'clientSessionId must be a non-empty string up to 200 characters');
    const normalized = normalizedNativeSessionInput(sessionInput);
    const normalizedInput = normalizeNativeInput(input);
    const { terminalAppearance: _terminalAppearance, toolGroups: _toolGroups, extensionsOff: _extensionsOff, workItemId: _workItemId, ...creationIdentity } = normalized;
    const creationFingerprint = fingerprint({ session: creationIdentity, commandId, input: normalizedInput });
    const config = normalizeNativeConfig({
      ...(normalized.model !== undefined ? { model: normalized.model } : {}),
      mode: normalized.mode,
      ...(normalized.approval !== undefined ? { approval: normalized.approval } : {}),
    });
    return this.transaction(() => {
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
        const originId = normalized.origin?.kind === 'handoff' ? normalized.origin.sessionId : undefined;
        const inherited = !normalized.workItemId && originId ? this.get<Session>('sessions', originId)?.workItemId : undefined;
        session = {
          ...normalized,
          ...(inherited ? { workItemId: inherited } : {}),
          ...clientTitleSource(normalized.title),
          id: clientSessionId, kind: 'native', state: 'idle', configRevision: 0, creationFingerprint,
          lastActivityAt: stamp, seenActivityAt: stamp, createdAt: stamp, updatedAt: stamp,
        };
        this.assertNativeIdentityAvailable(session);
        session = this.withDisplayTitle(session);
        this.sql('INSERT INTO sessions(id,project_id,json) VALUES(?,?,?)').run(session.id, session.projectId, JSON.stringify(session));
        this.sessionsChanged([session.id]);
      }
      const run = this.acceptNativeRun(session.id, commandId, normalizedInput, config, session.configRevision ?? 0, undefined, contextSnapshots);
      if (!stored && !normalized.origin) this.markSessionSeen(session.id);
      return { session: this.getSession(session.id), run };
    });
  }

  appendEvent(sessionId: string, type: string, data: Record<string, unknown>, extra: { runId?: string; raw?: unknown } = {}): WorkbenchEvent {
    this.getSession(sessionId);
    const base = { sessionId, type, data, ...extra, createdAt: now() };
    const result = this.sql('INSERT INTO events(session_id,json) VALUES(?,?)').run(sessionId, JSON.stringify(base));
    const event: WorkbenchEvent = { ...base, sequence: Number(result.lastInsertRowid) };
    if (type === 'session') {
      const count = (this.sessionSnapshotAppends.get(sessionId) ?? 0) + 1;
      this.sessionSnapshotAppends.set(sessionId, count % SESSION_SNAPSHOT_PRUNE_EVERY);
      if (count >= SESSION_SNAPSHOT_PRUNE_EVERY) this.pruneSessionSnapshots(sessionId);
    }
    if (this.depth) this.pending.push(event); else this.broadcast(event);
    return event;
  }
  getEvents(sessionId: string, after = 0, limit = 5000): WorkbenchEvent[] {
    return (this.sql('SELECT sequence,json FROM events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(sessionId, after, limit) as { sequence: number; json: string }[]).map(r => ({ ...JSON.parse(r.json), sequence: r.sequence }));
  }

  subscribe(sessionId: string, listener: (event: WorkbenchEvent) => void): () => void {
    let group = this.listeners.get(sessionId); if (!group) this.listeners.set(sessionId, group = new Set()); group.add(listener);
    return () => { group!.delete(listener); if (!group!.size) this.listeners.delete(sessionId); };
  }
  private broadcast(event: WorkbenchEvent) { for (const listener of this.listeners.get(event.sessionId) ?? []) { try { listener(event); } catch { /* A disconnected subscriber must not fail a committed event. */ } } }
  saveTerminal(item: TerminalInfo): TerminalInfo { this.sql('INSERT INTO terminals(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(item.id, JSON.stringify(item)); this.terminalsChanged(); return item; }
  getTerminal(id: string): TerminalInfo { const item = this.get<TerminalInfo>('terminals', id); if (!item) throw new AppError('TERMINAL_NOT_FOUND', 'Terminal does not exist', 404); return item; }
  findTerminal(id: string): TerminalInfo | undefined { return this.get<TerminalInfo>('terminals', id); }
  listTerminals(): TerminalInfo[] {
    this.terminalCache ??= this.all<TerminalInfo>('terminals').map(terminal => {
      for (const value of Object.values(terminal)) if (value && typeof value === 'object') deepFreeze(value);
      return terminal;
    });
    return this.terminalCache.map(terminal => ({ ...terminal }));
  }
  updateTerminal(id: string, patch: Partial<TerminalInfo>): TerminalInfo { return this.saveTerminal({ ...this.getTerminal(id), ...patch, id }); }
  sessionsWithMarks(): Set<string> { return new Set((this.sql('SELECT DISTINCT session_id FROM marks').all() as Array<{ session_id: string }>).map(row => row.session_id)); }
  getSetting<T>(key: string, fallback: T): T { const row = this.sql('SELECT json FROM settings WHERE key=?').get(key) as { json: string } | undefined; return row ? JSON.parse(row.json) : fallback; }
  deleteSetting(key: string): void { this.sql('DELETE FROM settings WHERE key=?').run(key); }
  setSetting(key: string, value: unknown) { this.sql('INSERT INTO settings(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run(key, JSON.stringify(value)); }
  getSettings(): AppSettings { return this.getSetting('app', {}); }
  async backup(destination: string) { mkdirSync(dirname(destination), { recursive: true, mode: 0o700 }); await backup(this.db, destination); chmodSync(destination, 0o600); }
  async backupJournal(destination: string) { mkdirSync(dirname(destination), { recursive: true, mode: 0o700 }); await backup(this.journalDb, destination); chmodSync(destination, 0o600); }

  // ── Delegations to store sub-modules ─────────────────────────────────────────
  createRun(sessionId: string, commandId: string, prompt: string): Run { return runsApi.createRun(this.port, sessionId, commandId, prompt); }
  acceptNativeRun(sessionId: string, commandId: string, input: NativeRunInput, config: NativeRunConfig, expectedConfigRevision?: number, steer?: { target: NativeTurnTarget; ownerRunId?: string; sourceRunId?: string }, contextSnapshots?: CapturedSessionReference[]): IdentifiedRun {
    return runsApi.acceptNativeRun(this.port, sessionId, commandId, input, config, expectedConfigRevision, steer, contextSnapshots);
  }
  steerQueuedNativeRun(sessionId: string, sourceRunId: string, commandId: string, target: NativeTurnTarget, config: NativeRunConfig, ownerRunId?: string): IdentifiedRun {
    return runsApi.steerQueuedNativeRun(this.port, sessionId, sourceRunId, commandId, target, config, ownerRunId);
  }
  requeueSteer(id: string): IdentifiedRun | undefined { return runsApi.requeueSteer(this.port, id); }
  getRun(id: string): IdentifiedRun { return runsApi.getRun(this.port, id); }
  previousRunId(sessionId: string, runId: string): string | undefined { return runsApi.previousRunId(this.port, sessionId, runId); }
  findRunByCommand(sessionId: string, commandId: string): IdentifiedRun | undefined { return runsApi.findRunByCommand(this.port, sessionId, commandId); }
  findRunsByNativeTurn(sessionId: string, nativeSessionId: string, turnId: string): IdentifiedRun[] { return runsApi.findRunsByNativeTurn(this.port, sessionId, nativeSessionId, turnId); }
  isSteerTargetTurnEnded(run: Run): boolean { return runsApi.isSteerTargetTurnEnded(this.port, run); }
  findRunByNativeMessage(sessionId: string, nativeMessageId: string): IdentifiedRun | undefined { return runsApi.findRunByNativeMessage(this.port, sessionId, nativeMessageId); }
  saveRunMetrics(id: string, metrics: RunMetrics): void { runsApi.saveRunMetrics(this.port, id, metrics); }
  listRuns(sessionId: string): IdentifiedRun[] { return runsApi.listRuns(this.port, sessionId); }
  updateRun(id: string, patch: Partial<Run>): IdentifiedRun { return runsApi.updateRun(this.port, id, patch); }
  transitionNativeRun(id: string, expectedDelivery: NativeDeliveryState[], nativePatch: Partial<NativeRunDetails>, runPatch: Partial<Run> = {}): IdentifiedRun | undefined {
    return runsApi.transitionNativeRun(this.port, id, expectedDelivery, nativePatch, runPatch);
  }
  listUnfinishedNativeRuns(sessionId?: string): IdentifiedRun[] { return runsApi.listUnfinishedNativeRuns(this.port, sessionId); }
  listRecentNativeRuns(sessionId: string, limit = 100): IdentifiedRun[] { return runsApi.listRecentNativeRuns(this.port, sessionId, limit); }
  listProviderEndedNativeRuns(): IdentifiedRun[] { return runsApi.listProviderEndedNativeRuns(this.port); }
  searchPrompts(pattern: string, limit: number, sessionId?: string, excludedBackendIds?: readonly string[], excludeTaskWorkspaces = false, hidePluginAgents = false, assistantHistory = false): MessageSearchHit[] {
    return runsApi.searchPrompts(this.port, pattern, limit, sessionId, excludedBackendIds, excludeTaskWorkspaces, hidePluginAgents, assistantHistory);
  }

  indexMessages(messages: readonly IndexedMessage[], indexedAt = now()): number { return derivedSearch.indexMessages(this.port, messages, indexedAt); }
  firstIndexedText(sessionId: string, kind: IndexedMessage['kind']): string | undefined { return derivedSearch.firstIndexedText(this.port, sessionId, kind); }
  latestIndexedPromptBefore(sessionId: string, at: string): string | undefined { return derivedSearch.latestIndexedPromptBefore(this.port, sessionId, at); }
  indexedCandidatesForMark(sessionId: string, includeTools: boolean) { return derivedSearch.indexedCandidatesForMark(this.port, sessionId, includeTools); }
  indexedMessages(sessionId: string, options: { tools?: boolean } = {}) { return derivedSearch.indexedMessages(this.port, sessionId, options); }
  recentIndexedMessages(sessionId: string, limit: number, characters: number) { return derivedSearch.recentIndexedMessages(this.port, sessionId, limit, characters); }
  searchIndexedMessages(pattern: string, limit: number, sessionId?: string, excludedBackendIds?: readonly string[], excludeTaskWorkspaces = false, hidePluginAgents = false, assistantHistory = false): MessageSearchHit[] {
    return derivedSearch.searchIndexedMessages(this.port, pattern, limit, sessionId, excludedBackendIds, excludeTaskWorkspaces, hidePluginAgents, assistantHistory);
  }
  sessionsMissingMessages(backendIds: readonly string[], limit: number, sessionId?: string, excludeTaskWorkspaces = false): IdentifiedSession[] {
    return derivedSearch.sessionsMissingMessages(this.port, backendIds, limit, sessionId, excludeTaskWorkspaces);
  }
  countSessionsMissingMessages(backendIds: readonly string[], sessionId?: string, excludeTaskWorkspaces = false): number {
    return derivedSearch.countSessionsMissingMessages(this.port, backendIds, sessionId, excludeTaskWorkspaces);
  }
  maintainDerivedSearch(options: { maxToolTrims?: number; fullOptimize?: boolean } = {}): { trimmedTools: number } {
    return derivedSearch.maintainDerivedSearch(this.port, options);
  }

  pruneAllSnapshots(): number { return maintenance.pruneAllSnapshots(this.port); }
  pruneSessionSnapshots(sessionId: string, keep: number = SESSION_SNAPSHOTS_KEPT): number { return maintenance.pruneSessionSnapshots(this.port, sessionId, keep); }
  pruneRunSnapshots(sessionId: string, runId?: string): number { return maintenance.pruneRunSnapshots(this.port, sessionId, runId); }
  archivedSessionsBefore(cutoffIso: string): string[] { return maintenance.archivedSessionsBefore(this.port, cutoffIso); }
  coldSessionsForTrimming(nowMs = Date.now()): string[] { return maintenance.coldSessionsForTrimming(this.port, nowMs); }
  assistantMainForTrimming(nowMs = Date.now()) { return maintenance.assistantMainForTrimming(this.port, nowMs); }
  referencedAttachmentIds(since: string): Set<string> { return maintenance.referencedAttachmentIds(this.port, since); }
  pruneExitedTerminals(before: string): number { return maintenance.pruneExitedTerminals(this.port, before); }
  reclaimSpace(options: { busy?: () => boolean; checkpoint?: boolean; vacuumOnly?: boolean } = {}) { return maintenance.reclaimSpace(this.port, options); }
  recoverInterruptedRuns() { maintenance.recoverInterruptedRuns(this.port); }

  stateCounts() { return workspaceRecords.stateCounts(this.port); }
  deleteTerminal(id: string): void { workspaceRecords.deleteTerminal(this.port, id); }
  saveWorkbenchDocumentProof(digest: string, expiresAt: number, nowMs: number, limit: number): void { workspaceRecords.saveWorkbenchDocumentProof(this.port, digest, expiresAt, nowMs, limit); }
  takeWorkbenchDocumentProof(digest: string, nowMs: number): boolean { return workspaceRecords.takeWorkbenchDocumentProof(this.port, digest, nowMs); }
  getNativeContext(sessionId: string, nativeSessionId: string): NativeContext | undefined { return workspaceRecords.getNativeContext(this.port, sessionId, nativeSessionId); }
  saveNativeContext(sessionId: string, nativeSessionId: string, context: NativeContext | undefined) { workspaceRecords.saveNativeContext(this.port, sessionId, nativeSessionId, context); }
  getNativeInteractionReceipt(sessionId: string, requestId: string) { return workspaceRecords.getNativeInteractionReceipt(this.port, sessionId, requestId); }
  saveNativeInteractionReceipt(sessionId: string, requestId: string, receipt: { fingerprint: string; interactionId: string; revision: string; result: NativeInteractionResult; createdAt: string }) {
    return workspaceRecords.saveNativeInteractionReceipt(this.port, sessionId, requestId, receipt);
  }

  close() {
    derivedSearch.noteMessageIndexShape(this.port);
    optimizeDatabase(this.derivedDb);
    optimizeDatabase(this.journalDb);
    optimizeDatabase(this.db);
    this.listeners.clear(); this.runListeners.clear(); this.listListeners.clear(); this.deletionListeners.clear();
    this.statements.clear(); this.derivedStatements.clear();
    this.derivedDb.close(); this.journalDb.close(); this.db.close();
  }
}
