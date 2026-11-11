import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import type { ExternalSession, ExternalSessionDirectory, ExternalSessionPage, NativeBackendId, Session } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import type { Store } from '../store.js';
import type { SettingsService } from '../settings/index.js';
import type { NativeBackendService } from '../backends/service.js';
import type { ExternalSessionEntry } from '../backends/types.js';
import { resolveNativeSessionInput } from './session-input.js';

/** A snapshot is reused for this long, so paging and the directory view read one listing. */
const SNAPSHOT_MS = 10_000;
/** The most conversations read from one provider. */
const SCAN_LIMIT = 5_000;
const SCAN_TIMEOUT_MS = 20_000;
const PAGE_LIMIT = 200;

export interface ExternalSessionQuery {
  /** `project`: the project's directory; `directory`: `cwd`; `all`: every directory. */
  scope: 'project' | 'directory' | 'all';
  projectId?: string;
  cwd?: string;
  backendId?: string;
  q?: string;
  cursor?: string;
  limit?: number;
  nonInteractive?: boolean;
  refresh?: boolean;
}

interface Found extends ExternalSessionEntry { backendId: NativeBackendId; backendProfileId: string }
interface Snapshot { at: number; items: Found[]; failures: Array<{ backendId: NativeBackendId; message: string }> }

export interface ExternalSessionDeps {
  store: Store;
  settings: SettingsService;
  nativeBackends: NativeBackendService;
  auth?: { device(id: string): unknown };
}

const bindingKey = (backendId: string, nativeSessionId: string) => `${backendId}\0${nativeSessionId}`;

/**
 * The provider conversations stored on this machine, for the import picker (docs/TERMINAL-SESSIONS.md).
 * Each backend reads its own files; this merges them, marks the ones a conversation here already
 * continues, and imports one as a conversation bound to the same provider thread.
 */
export class ExternalSessions {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly pending = new Map<string, Promise<Snapshot>>();

  constructor(private readonly deps: ExternalSessionDeps) {}

  async list(query: ExternalSessionQuery): Promise<ExternalSessionPage> {
    const snapshot = await this.snapshot(Boolean(query.nonInteractive), Boolean(query.refresh));
    const cwd = this.scopeDirectory(query);
    const terms = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const context = this.annotation();
    // A conversation one here already continues is opened from the sidebar, not imported again.
    const unbound = (item: Found) => !context.bindings.has(bindingKey(item.backendId, item.nativeSessionId));
    const matched = snapshot.items.filter(item => unbound(item) && (!query.backendId || item.backendId === query.backendId)
      && (cwd === undefined || item.cwd === cwd)
      && (!terms.length || terms.every(term => [item.title, item.preview, item.nativeSessionId, item.gitBranch, item.cwd].some(field => field?.toLowerCase().includes(term)))));
    const offset = query.cursor ? Number.parseInt(query.cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AppError('INVALID_CURSOR', 'cursor is invalid');
    const limit = Math.min(Math.max(query.limit ?? 50, 1), PAGE_LIMIT);
    const page = matched.slice(offset, offset + limit);
    return {
      items: page.map(item => this.annotate(item, context)),
      ...(offset + limit < matched.length ? { nextCursor: String(offset + limit) } : {}),
      ...(snapshot.failures.length ? { failures: snapshot.failures } : {}),
    };
  }

  async directories(query: Pick<ExternalSessionQuery, 'backendId' | 'nonInteractive' | 'refresh'>): Promise<ExternalSessionDirectory[]> {
    const snapshot = await this.snapshot(Boolean(query.nonInteractive), Boolean(query.refresh));
    const byCwd = new Map<string, { count: number; updatedAt: number }>();
    const { bindings } = this.annotation();
    for (const item of snapshot.items) {
      if (query.backendId && item.backendId !== query.backendId) continue;
      if (bindings.has(bindingKey(item.backendId, item.nativeSessionId))) continue;
      const entry = byCwd.get(item.cwd);
      if (entry) { entry.count += 1; entry.updatedAt = Math.max(entry.updatedAt, item.updatedAt); }
      else byCwd.set(item.cwd, { count: 1, updatedAt: item.updatedAt });
    }
    const projects = this.projectsByCwd();
    return [...byCwd].sort(([, a], [, b]) => b.updatedAt - a.updatedAt).map(([cwd, entry]) => ({
      cwd, count: entry.count, updatedAt: new Date(entry.updatedAt).toISOString(),
      ...(projects.get(cwd) ? { projectId: projects.get(cwd)!.id } : {}),
      exists: isDirectory(cwd),
    }));
  }

  /**
   * A conversation bound to the provider thread, in the project whose directory it ran in (created when
   * there is none: Claude Code finds a transcript by the directory it was started in). Importing one a
   * conversation here already continues returns that conversation. Starts nothing.
   */
  async import(input: { backendId?: unknown; backendProfileId?: unknown; nativeSessionId?: unknown }, headers?: IncomingHttpHeaders): Promise<{ session: Session; created: boolean }> {
    if (typeof input.backendId !== 'string' || typeof input.nativeSessionId !== 'string') throw new AppError('INVALID_IMPORT', 'backendId and nativeSessionId are required');
    const find = (snapshot: Snapshot) => snapshot.items.find(item => item.backendId === input.backendId && item.nativeSessionId === input.nativeSessionId
      && (typeof input.backendProfileId !== 'string' || item.backendProfileId === input.backendProfileId));
    const bound = this.annotation().bindings.get(bindingKey(input.backendId, input.nativeSessionId));
    if (bound) return { session: bound, created: false };
    const entry = find(await this.snapshot(true, false)) ?? find(await this.snapshot(true, true));
    if (!entry) throw new AppError('EXTERNAL_SESSION_NOT_FOUND', 'This conversation is no longer stored on this machine', 404);
    if (!isDirectory(entry.cwd)) throw new AppError('EXTERNAL_SESSION_DIRECTORY_MISSING', 'The directory this conversation ran in no longer exists', 409, { cwd: entry.cwd });
    const cwd = entry.cwd;
    if (this.deps.store.listProjects().some(project => project.cwd === cwd && project.system)) {
      throw new AppError('SYSTEM_PROJECT', 'This conversation ran in a directory Riffet keeps for itself', 409);
    }
    const project = this.projectsByCwd().get(cwd) ?? this.deps.store.createProject(cwd, basename(cwd) || cwd);
    const resolved = await resolveNativeSessionInput(this.deps, {
      projectId: project.id, backendId: entry.backendId, backendProfileId: entry.backendProfileId,
      nativeSessionId: entry.nativeSessionId, title: entry.title,
    } as Parameters<typeof resolveNativeSessionInput>[1], headers);
    let created: Session;
    try { created = this.deps.store.createSession({ ...resolved, kind: 'native' }); }
    catch (error) {
      // A second import of the same conversation that got here first.
      const winner = error instanceof AppError && error.code === 'NATIVE_SESSION_ID_IN_USE' ? this.annotation().bindings.get(bindingKey(entry.backendId, entry.nativeSessionId)) : undefined;
      if (winner) return { session: winner, created: false };
      throw error;
    }
    const session = this.deps.store.updateSession(created.id, { titleSource: 'provider', lastActivityAt: new Date(entry.updatedAt).toISOString() });
    return { session, created: true };
  }

  private scopeDirectory(query: ExternalSessionQuery): string | undefined {
    if (query.scope === 'all') return undefined;
    if (query.scope === 'project') {
      if (!query.projectId) throw new AppError('INVALID_SCOPE', 'projectId is required');
      return this.deps.store.getProject(query.projectId).cwd;
    }
    if (query.scope === 'directory') {
      if (!query.cwd) throw new AppError('INVALID_SCOPE', 'cwd is required');
      return query.cwd;
    }
    throw new AppError('INVALID_SCOPE', 'scope must be project, directory or all');
  }

  private async snapshot(nonInteractive: boolean, refresh: boolean): Promise<Snapshot> {
    const key = nonInteractive ? 'all' : 'interactive';
    const cached = this.snapshots.get(key);
    if (!refresh && cached && Date.now() - cached.at < SNAPSHOT_MS) return cached;
    const running = this.pending.get(key);
    if (running) return running;
    const next = this.scan(nonInteractive).then(snapshot => { this.snapshots.set(key, snapshot); return snapshot; })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, next);
    return next;
  }

  private async scan(includeNonInteractive: boolean): Promise<Snapshot> {
    const sources = this.deps.nativeBackends.externalSessionSources();
    const results = await Promise.allSettled(sources.map(source => source.list({ includeNonInteractive, limit: SCAN_LIMIT, signal: AbortSignal.timeout(SCAN_TIMEOUT_MS) })));
    const seen = new Set<string>();
    const items: Found[] = [];
    // Projects keep resolved paths, so a conversation started under a symlink still matches its project.
    const resolved = new Map<string, string>();
    const real = (path: string) => {
      let value = resolved.get(path);
      if (value === undefined) { try { value = realpathSync(path); } catch { value = path; } resolved.set(path, value); }
      return value;
    };
    const failures: Snapshot['failures'] = [];
    results.forEach((result, index) => {
      const source = sources[index]!;
      if (result.status === 'rejected') {
        if (!failures.some(item => item.backendId === source.backendId)) failures.push({ backendId: source.backendId, message: result.reason instanceof Error ? result.reason.message : String(result.reason) });
        return;
      }
      for (const entry of result.value) {
        const key = bindingKey(source.backendId, entry.nativeSessionId);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ ...entry, cwd: real(entry.cwd), backendId: source.backendId, backendProfileId: source.profileId });
      }
    });
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return { at: Date.now(), items, failures };
  }

  private projectsByCwd() {
    const map = new Map<string, ReturnType<Store['listProjects']>[number]>();
    // Archived and Riffet's own directories last: an active project of the same directory wins.
    const projects = this.deps.store.listProjects().filter(project => !project.system)
      .sort((a, b) => Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)));
    for (const project of projects) if (!map.has(project.cwd)) map.set(project.cwd, project);
    return map;
  }

  private annotation() {
    const bindings = new Map<string, Session>();
    for (const session of this.deps.store.listSessions()) {
      if (session.kind !== 'native' || !session.backendId) continue;
      for (const id of [session.nativeSessionId, ...(session.previousNativeSessionIds ?? [])]) {
        if (!id) continue;
        const key = bindingKey(session.backendId, id);
        const existing = bindings.get(key);
        // A live conversation over an archived one that once continued the same thread.
        if (!existing || existing.archivedAt && !session.archivedAt) bindings.set(key, session);
      }
    }
    return { bindings, projects: this.projectsByCwd(), dirs: new Map<string, boolean>() };
  }

  /** `list` and `directories` leave out what a conversation here continues, so every item is unbound. */
  private annotate(item: Found, context: ReturnType<ExternalSessions['annotation']>): ExternalSession {
    const project = context.projects.get(item.cwd);
    let exists = context.dirs.get(item.cwd);
    if (exists === undefined) context.dirs.set(item.cwd, exists = isDirectory(item.cwd));
    const live = item.live ? (item.live.ours ? 'riffet' : 'terminal') : undefined;
    return {
      backendId: item.backendId, backendProfileId: item.backendProfileId, nativeSessionId: item.nativeSessionId,
      cwd: item.cwd, title: item.title,
      ...(item.preview ? { preview: item.preview } : {}),
      ...(item.gitBranch ? { gitBranch: item.gitBranch } : {}),
      updatedAt: new Date(item.updatedAt).toISOString(),
      source: item.source,
      ...(live ? { live } : {}),
      ...(live === 'terminal' && item.live?.status ? { liveStatus: item.live.status } : {}),
      ...(project ? { projectId: project.id } : {}),
      cwdExists: exists,
    };
  }
}

function isDirectory(path: string): boolean {
  try { return existsSync(path) && statSync(path).isDirectory(); } catch { return false; }
}
