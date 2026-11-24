import { createHash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  STORAGE_BUDGET, type AppSettings, type CapturedSessionReference, type FolderFavorite, type NativeBackendId,
  type NativeRunConfig, type NativeRunDetails, type NativeRunInput, type NativeSessionInput, type Project,
  type Run, type Session, type TerminalInfo, type WorkbenchEvent,
} from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { isNativeBackendId } from '../backends/registry.js';
import type { Journal } from '../journal/journal.js';
import { LEGACY_DEFAULT_BACKEND_ID, legacyMirrorFields, requestedNativeSessionId, type IdentifiedRun, type IdentifiedSession } from '../session-identity.js';
import { isPlaceholderTitle } from '../session-title.js';
import type { StorageLayoutPaths } from '../sqlite-storage.js';

export const now = () => new Date().toISOString();
export const SESSION_SNAPSHOTS_KEPT = STORAGE_BUDGET.sessionSnapshotsKept;
export const SESSION_SNAPSHOT_PRUNE_EVERY = 10;
/** A retry id is only meaningful while its interaction can still be answered. */
export const INTERACTION_RECEIPT_TTL_MS = 7 * 24 * 60 * 60_000;
export const INTERACTION_RECEIPTS_PER_SESSION = 200;
/** A stored session's backend; rows written before `backendId` existed are Cursor's (see `session-identity.ts`). */
export const STORED_BACKEND_ID_SQL = `COALESCE(json_extract(s.json,'$.backendId'),'${LEGACY_DEFAULT_BACKEND_ID}')`;
/** A deleted conversation's id is kept here (settings key `session-deleted:<id>`), so no retried request recreates it. */
export const DELETED_PREFIX = 'session-deleted:';
/** Settings a conversation owns outright, by key; removed with it. */
export const SESSION_SETTING_PREFIXES = ['native-context:', 'native-interactions:', 'native-stops:', 'riffet-mcp:binding:', 'session-reference-creation:', 'task-workspace-creation:', 'terminal-hold:'];
export const ACTIVE_SESSION_STATES: ReadonlySet<Session['state']> = new Set(['starting', 'running', 'waiting', 'cancelling']);

/** What remains of a deleted conversation: no title, message or transcript, only enough to refuse its id. */
export interface DeletedSession {
  rootId: string;
  deletedAt: string;
  /** Files outside the database (chat log, context copies, plan mirrors) still to be removed. */
  cleanupPending: boolean;
  /** On the root only: every id deleted with it. */
  sessionIds?: string[];
}

/** One search result: a message, and enough about its conversation to open it. */
export interface MessageSearchHit {
  sessionId: string;
  projectId: string;
  sessionTitle: string;
  archived: boolean;
  backendId: NativeBackendId;
  messageId: string;
  kind: 'user' | 'assistant' | 'tool';
  text: string;
  at: string;
  /**
   * The run a question came from, when it came from one. The client turns it into the timeline row
   * key it uses for that turn, which is how a result scrolls to the message it matched.
   */
  runId?: string;
}

/** Structural match for `IndexedMessage` without importing `search/`. */
export interface IndexedMessageRow {
  sessionId: string;
  messageId: string;
  kind: 'user' | 'assistant' | 'tool';
  text: string;
  at: string;
}

/** A `FolderFavorite` as stored; `exists` is checked on every read. */
export type StoredFolderFavorite = Omit<FolderFavorite, 'exists'>;

export function deepFreeze(value: object): void {
  Object.freeze(value);
  for (const inner of Object.values(value)) if (inner && typeof inner === 'object' && !Object.isFrozen(inner)) deepFreeze(inner);
}

/**
 * Provenance of a title a client supplied when it created the session. It is the client's own
 * wording rather than a provider's label, so it is marked `user`: the transcript rule must not
 * rewrite it later, and new clients leave the naming to the server instead (see `session-title.ts`).
 */
export function clientTitleSource(title: string | undefined): Partial<Session> {
  return title && title.trim() && !isPlaceholderTitle(title) ? { titleSource: 'user' } : {};
}

/** Narrows a prompt search to a conversation and can hide backends; nothing for a global one. */
export function searchScope(sessionId?: string, excludedBackendIds?: readonly string[], excludeTaskWorkspaces = false, hidePluginAgents = false, assistantHistory = false): { clause: string; params: string[] } {
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

/** `details.sessionId` names the deleted id, which a creation retry's URL does not (it names the source). */
export function sessionDeleted(sessionId: string): AppError { return new AppError('SESSION_DELETED', 'This conversation was deleted', 410, { sessionId }); }

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Drops receipts past their TTL and the oldest beyond the per-session cap; `keepKey` always survives. */
export function retainedReceipts<T extends { createdAt: string }>(receipts: Record<string, T>, keepKey: string, nowMs = Date.now()): Record<string, T> {
  const age = (receipt: T) => { const at = Date.parse(receipt.createdAt); return Number.isFinite(at) ? at : nowMs; };
  const live = Object.entries(receipts).filter(([key, receipt]) => key === keepKey || nowMs - age(receipt) <= INTERACTION_RECEIPT_TTL_MS);
  const others = live.filter(([key]) => key !== keepKey).sort(([, a], [, b]) => age(b) - age(a)).slice(0, INTERACTION_RECEIPTS_PER_SESSION - 1);
  return Object.fromEntries([...others, ...live.filter(([key]) => key === keepKey)]);
}

export function normalizeNativeConfig(config: NativeRunConfig): NativeRunConfig {
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

export function normalizedNativeSessionInput(input: NativeSessionInput) {
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

export function interactionReceiptKey(requestId: string): string {
  if (typeof requestId !== 'string' || !requestId || requestId.length > 200 || /[\0\r\n]/.test(requestId)) throw new AppError('INVALID_INTERACTION_REQUEST_ID', 'Interaction request id is invalid');
  return createHash('sha256').update(requestId).digest('hex');
}

/** Shared SQLite access and store notifications passed from `Store` to its sub-modules. */
export interface StorePort {
  readonly db: DatabaseSync;
  readonly journalDb: DatabaseSync;
  readonly derivedDb: DatabaseSync;
  readonly layout: StorageLayoutPaths | undefined;
  readonly journal: Journal;
  sql(text: string): StatementSync;
  derivedSql(text: string): StatementSync;
  derivedTx<T>(fn: () => T): T;
  transaction<T>(fn: () => T): T;
  get<T>(table: string, id: string): T | undefined;
  all<T>(table: string): T[];
  replace(table: string, id: string, value: unknown): void;
  session(json: string): IdentifiedSession;
  run(json: string): IdentifiedRun;
  identified(run: Run): IdentifiedRun;
  allSessions(): IdentifiedSession[];
  listProjects(): Project[];
  getProject(id: string): Project;
  listSessions(): IdentifiedSession[];
  getSession(id: string): IdentifiedSession;
  listRuns(sessionId: string): IdentifiedRun[];
  getRun(id: string): IdentifiedRun;
  findRunByCommand(sessionId: string, commandId: string): IdentifiedRun | undefined;
  listUnfinishedNativeRuns(sessionId?: string): IdentifiedRun[];
  getTerminal(id: string): TerminalInfo;
  getSetting<T>(key: string, fallback: T): T;
  setSetting(key: string, value: unknown): void;
  getSettings(): AppSettings;
  updateRun(id: string, patch: Partial<Run>): IdentifiedRun;
  transitionNativeRun(id: string, expectedDelivery: NativeRunDetails['delivery'][], nativePatch: Partial<NativeRunDetails>, runPatch?: Partial<Run>): IdentifiedRun | undefined;
  markSteerMissed(id: string): IdentifiedRun | undefined;
  isSteerTargetTurnEnded(run: Run): boolean;
  createNativeSubmission(clientSessionId: string, sessionInput: NativeSessionInput, commandId: string, input: NativeRunInput, contextSnapshots?: CapturedSessionReference[]): { session: IdentifiedSession; run: IdentifiedRun };
  normalizeNativeInput(input: NativeRunInput): NativeRunInput;
  acceptNativeRun(sessionId: string, commandId: string, input: NativeRunInput, config: NativeRunConfig, expectedConfigRevision?: number, steer?: { target: { nativeSessionId: string; turnId: string }; ownerRunId?: string; sourceRunId?: string }, contextSnapshots?: CapturedSessionReference[]): IdentifiedRun;
  updateSessionActivity(id: string, activityAt?: string): IdentifiedSession | undefined;
  appendEvent(sessionId: string, type: string, data: Record<string, unknown>, extra?: { runId?: string; raw?: unknown }): WorkbenchEvent;
  nameFromMessage(sessionId: string, prompt: string): void;
  runChanged(run: Run): void;
  projectsChanged(classified?: string): void;
  terminalsChanged(): void;
  marksChanged(): void;
  favoritesChanged(): void;
  refreshDisplayTitles(): number;
  pruneRunSnapshots(sessionId: string, runId?: string): number;
  pruneSessionSnapshots(sessionId: string, keep?: number): number;
  noteMessageIndexShape(): void;
  hotTimelineSessions(): Set<string>;
}
