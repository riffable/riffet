import type { FastifyInstance } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { CLIENT_FEATURES_HEADER, isPluginAgentId, type AppSettings, type NativeBackendId, type Project } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { LEGACY_DEFAULT_BACKEND_ID, savedDefaultBackendId } from '../session-identity.js';
import type { Store } from '../store.js';
import type { TimelineRow } from '../../../../packages/contracts/src/sync.js';

/*
 * Compatibility for clients that predate a negotiated backend. The server keeps every backend and
 * conversation; only what a client can decode is sent to it. `pi` and `antigravity` require
 * their corresponding Agent features (quick chats already negotiate `chat`), so an older client
 * cannot see them in lists, settings, search, statistics or nested conversation payloads. A plugin's Agent id
 * (`PluginAgentId`, always dotted) is negotiated the same way under `plugin-agents`: the ids are not
 * known to the client's enum, so the rule is by form instead of by an id list.
 *
 * The checks live here rather than in each route so the same rule covers a list and a direct id.
 * Internal bridge routes (provider hooks) are not API clients and never call these helpers.
 */

export const PI_AGENT_FEATURE = 'pi-agent';
export const PI_BACKEND_ID = 'pi';
export const ANTIGRAVITY_AGENT_FEATURE = 'antigravity-agent';
export const ANTIGRAVITY_BACKEND_ID = 'antigravity';
export const PLUGIN_AGENTS_FEATURE = 'plugin-agents';
/** What an old client gets when the saved default is a backend it cannot decode. */
export const COMPATIBLE_DEFAULT_BACKEND_ID = LEGACY_DEFAULT_BACKEND_ID;

function featureNames(headers?: IncomingHttpHeaders): Set<string> {
  const raw = headers?.[CLIENT_FEATURES_HEADER];
  const value = Array.isArray(raw) ? raw.join(',') : raw ?? '';
  return new Set(value.split(',').map(item => item.trim()).filter(Boolean));
}

export function clientSupportsFeature(headers: IncomingHttpHeaders | undefined, feature: string): boolean {
  // No headers means a server-side caller (orchestration, schedules, hooks), which is trusted with
  // every backend. HTTP routes always pass `request.headers`, an object even when empty.
  if (headers === undefined) return true;
  return featureNames(headers).has(feature);
}

/** An old reader still sees that a prompt carried sources, without changing persisted user text. */
export function sessionReferenceRowsForClient(rows: TimelineRow[], supported: boolean): TimelineRow[] {
  if (supported) return rows;
  return rows.map(row => {
    if (row.kind !== 'user' || !row.references?.length) return row;
    return { ...row, text: `${row.text}\n\n${row.references.map(ref => `@${ref.title.replace(/[\r\n]/g, ' ')} (${ref.capturedAt})`).join('\n')}` };
  });
}

export function clientSupportsPiAgent(headers?: IncomingHttpHeaders): boolean {
  return clientSupportsFeature(headers, PI_AGENT_FEATURE);
}

/** Backends this client cannot name in a strict enum, listed by id. Plugin Agents are by form: see {@link hidesPluginAgents}. */
export function hiddenBackendIds(headers?: IncomingHttpHeaders): readonly string[] {
  return [
    ...(!clientSupportsPiAgent(headers) ? [PI_BACKEND_ID] : []),
    ...(!clientSupportsFeature(headers, ANTIGRAVITY_AGENT_FEATURE) ? [ANTIGRAVITY_BACKEND_ID] : []),
  ];
}

/** Whether this client cannot decode an Agent id that is not built in. */
export function hidesPluginAgents(headers?: IncomingHttpHeaders): boolean {
  return !clientSupportsFeature(headers, PLUGIN_AGENTS_FEATURE);
}

export function backendVisibleToClient(headers: IncomingHttpHeaders | undefined, backendId: string | undefined): boolean {
  return backendId === undefined || !(hiddenBackendIds(headers).includes(backendId) || isPluginAgentId(backendId) && hidesPluginAgents(headers));
}

/** Rejects an explicit request for a backend the client cannot decode, without echoing the id. */
export function requireBackendVisibleToClient(headers: IncomingHttpHeaders | undefined, backendId: string | undefined): void {
  if (!backendVisibleToClient(headers, backendId)) throw new AppError('INVALID_BACKEND', 'Choose a supported native backend');
}

type ProjectLookup = (id: string) => Project;

export function projectVisibleToClient(headers: IncomingHttpHeaders | undefined, project: Project): boolean {
  return project.system !== 'task-workspace' || clientSupportsFeature(headers, 'projectless-tasks');
}

export function requireProjectVisibleToClient(headers: IncomingHttpHeaders | undefined, project: Project): void {
  if (!projectVisibleToClient(headers, project)) throw new AppError('PROJECT_NOT_FOUND', 'Project does not exist', 404);
}

export function visibleProjectsForClient(headers: IncomingHttpHeaders | undefined, items: readonly Project[]): Project[] {
  return items.filter(project => projectVisibleToClient(headers, project));
}

export function visibleProjectItemsForClient<T extends { projectId?: string }>(headers: IncomingHttpHeaders | undefined, items: readonly T[], getProject: ProjectLookup): T[] {
  return items.filter(item => !item.projectId || projectVisibleToClient(headers, getProject(item.projectId)));
}

export function sessionVisibleToClient(headers: IncomingHttpHeaders | undefined, session: { backendId?: string; projectId?: string } | undefined, getProject?: ProjectLookup): boolean {
  return !session || (backendVisibleToClient(headers, session.backendId)
    && (!getProject || !session.projectId || projectVisibleToClient(headers, getProject(session.projectId))));
}

/** A cached id is not a capability: a client that never negotiated the backend sees no such conversation. */
export function requireSessionVisibleToClient(headers: IncomingHttpHeaders | undefined, session: { backendId?: string; projectId?: string } | undefined, getProject?: ProjectLookup): void {
  if (!sessionVisibleToClient(headers, session, getProject)) throw new AppError('SESSION_NOT_FOUND', 'Conversation does not exist', 404);
}

export function visibleSessionsForClient<T extends { backendId?: string; projectId?: string; origin?: { kind?: string } }>(headers: IncomingHttpHeaders | undefined, items: readonly T[], getProject?: ProjectLookup): T[] {
  return items.filter(item => item.origin?.kind !== 'council' && sessionVisibleToClient(headers, item, getProject));
}

export function visibleBackendsForClient<T extends { backendId: string }>(headers: IncomingHttpHeaders | undefined, items: readonly T[]): T[] {
  return items.filter(item => backendVisibleToClient(headers, item.backendId));
}

/**
 * The backend a new conversation starts on when none was chosen. The saved default is used while it is
 * offered (`offered`: the backends registered now, in registry order; omit to skip that check) and this
 * client can decode it. Otherwise Cursor, the default of every client before this setting existed, while
 * that is usable, else the first offered backend this client can decode: a plugin may be off, and an older
 * client must not be handed an id it cannot name.
 */
export function defaultBackendForClient(headers: IncomingHttpHeaders | undefined, backendId: NativeBackendId, offered?: readonly NativeBackendId[]): NativeBackendId {
  const usable = (id: NativeBackendId) => backendVisibleToClient(headers, id) && (offered === undefined || offered.includes(id));
  if (usable(backendId)) return backendId;
  if (usable(COMPATIBLE_DEFAULT_BACKEND_ID)) return COMPATIBLE_DEFAULT_BACKEND_ID;
  return offered?.find(id => id !== 'chat' && usable(id)) ?? COMPATIBLE_DEFAULT_BACKEND_ID;
}

/**
 * What a client is shown of the settings record; the stored record itself is untouched. `defaultBackendId`
 * is the effective one, as {@link defaultBackendForClient} resolves it.
 */
export function effectiveSettingsForClient(headers: IncomingHttpHeaders | undefined, settings: AppSettings, offered?: readonly NativeBackendId[]): AppSettings {
  const result = structuredClone(settings);
  if (!clientSupportsFeature(headers, 'projectless-tasks')) delete result.taskWorkspaceRoot;
  const effective = defaultBackendForClient(headers, savedDefaultBackendId(settings), offered);
  if (settings.defaultBackendId !== undefined || effective !== COMPATIBLE_DEFAULT_BACKEND_ID) result.defaultBackendId = effective;
  const hidden = (id: unknown) => typeof id === 'string' && !backendVisibleToClient(headers, id);
  if (result.nativeBackendDefaults) {
    const defaults = Object.fromEntries(Object.entries(result.nativeBackendDefaults).filter(([id]) => !hidden(id)));
    if (Object.keys(defaults).length) result.nativeBackendDefaults = defaults as AppSettings['nativeBackendDefaults'];
    else delete result.nativeBackendDefaults;
  }
  if (result.auxiliaryModels) {
    const models = Object.fromEntries(Object.entries(result.auxiliaryModels).filter(([, ref]) => !(ref && typeof ref === 'object' && hidden((ref as { backendId?: string }).backendId))));
    if (Object.keys(models).length) result.auxiliaryModels = models as AppSettings['auxiliaryModels'];
    else delete result.auxiliaryModels;
  }
  return result;
}

/**
 * Keeps settings a client cannot see when it saves the record. A visible fallback is ambiguous:
 * an old client reads `cursor` because the stored default is hidden, so saving that same value
 * must not replace the hidden default. An explicit hidden key is a request for a backend the
 * client cannot decode and is refused.
 */
export function preserveInvisibleSettingsForClient(headers: IncomingHttpHeaders | undefined, stored: AppSettings, patch: Record<string, unknown>, offered?: readonly NativeBackendId[]): Record<string, unknown> {
  if (!clientSupportsFeature(headers, 'projectless-tasks') && Object.prototype.hasOwnProperty.call(patch, 'taskWorkspaceRoot')) throw new AppError('FEATURE_REQUIRED', 'Update the client to change the task workspace location', 409);
  if (!hiddenBackendIds(headers).length && !hidesPluginAgents(headers)) return patch;
  const hidden = (id: unknown) => typeof id === 'string' && !backendVisibleToClient(headers, id);
  const refuse = () => new AppError('INVALID_BACKEND', 'Choose a supported native backend');
  const next = { ...patch };
  if (hidden(next.defaultBackendId)) throw refuse();
  if (stored.defaultBackendId !== undefined && hidden(stored.defaultBackendId) && next.defaultBackendId === defaultBackendForClient(headers, stored.defaultBackendId, offered)) next.defaultBackendId = stored.defaultBackendId;
  if (next.nativeBackendDefaults !== undefined) {
    // `null` would replace the record wholesale in `setSettings`; an older client cannot see the
    // hidden defaults it would erase, so it must not be able to clear them.
    if (next.nativeBackendDefaults === null) throw new AppError('INVALID_SETTINGS', 'Settings for a newer client cannot be cleared from this client');
    if (typeof next.nativeBackendDefaults !== 'object' || Array.isArray(next.nativeBackendDefaults)) return next;
    const defaults = { ...(next.nativeBackendDefaults as Record<string, unknown>) };
    if (Object.keys(defaults).some(hidden)) throw refuse();
    for (const [id, value] of Object.entries(stored.nativeBackendDefaults ?? {})) if (hidden(id) && value) defaults[id] = value;
    next.nativeBackendDefaults = defaults;
  }
  if (next.auxiliaryModels !== undefined) {
    // Auxiliary purposes merge in `setSettings`; only the record as a whole can replace every purpose.
    if (next.auxiliaryModels === null) throw new AppError('INVALID_SETTINGS', 'Settings for a newer client cannot be cleared from this client');
    if (typeof next.auxiliaryModels !== 'object' || Array.isArray(next.auxiliaryModels)) return next;
    const models = { ...(next.auxiliaryModels as Record<string, unknown>) };
    for (const ref of Object.values(models)) {
      if (ref && typeof ref === 'object' && hidden((ref as { backendId?: string }).backendId)) throw refuse();
    }
    for (const [purpose, ref] of Object.entries(stored.auxiliaryModels ?? {})) {
      if (hidden(ref?.backendId) && Object.prototype.hasOwnProperty.call(models, purpose)) models[purpose] = ref;
    }
    next.auxiliaryModels = models;
  }
  return next;
}

/**
 * Direct API routes that name a conversation in the path are covered by one hook, so a cached id
 * cannot read a conversation its list no longer shows. Register this after the app's authentication
 * hook and before the routes: the share-preview route is not under `/api/sessions/:id`.
 */
export function registerSessionVisibilityHook(app: FastifyInstance, getSession: (id: string) => { backendId?: string }): void {
  app.addHook('onRequest', async request => {
    const route = request.routeOptions?.url;
    if (!route) return;
    if (!route.startsWith('/api/sessions/:id') && !route.startsWith('/api/v3/sessions/:id')) return;
    // Browser EventSource cannot set request headers. Only the two authenticated GET streams
    // accept the same explicit capability declaration in their URL; normal API calls use headers.
    if (request.method === 'GET' && (route === '/api/v3/sessions/:id/sync' || route === '/api/sessions/:id/stream') &&
        request.headers[CLIENT_FEATURES_HEADER] === undefined) {
      const features = (request.query as { features?: unknown }).features;
      if (typeof features === 'string' && features.length <= 1024) request.headers[CLIENT_FEATURES_HEADER] = features;
    }
    const id = (request.params as { id?: string } | undefined)?.id;
    if (!id) return;
    requireSessionVisibleToClient(request.headers, getSession(id));
  });
}

/** Apply the same project capability to direct URLs, input references and session-owned terminals. */
export function registerProjectVisibilityHook(app: FastifyInstance, store: Pick<Store, 'getProject' | 'getSession' | 'getTerminal'>): void {
  const checkProject = (headers: IncomingHttpHeaders, id: unknown): Project | undefined => {
    if (typeof id !== 'string' || !id) return undefined;
    const project = store.getProject(id);
    requireProjectVisibleToClient(headers, project);
    return project;
  };
  const checkSession = (headers: IncomingHttpHeaders, id: unknown): void => {
    if (typeof id === 'string' && id) requireSessionVisibleToClient(headers, store.getSession(id), value => store.getProject(value));
  };
  app.addHook('onRequest', async request => {
    const route = request.routeOptions?.url;
    if (!route?.startsWith('/api/')) return;
    // File links, previews, WebSockets and EventSource cannot all set custom headers.
    const query = request.query as { features?: unknown; projectId?: unknown; sessionId?: unknown };
    if (request.method === 'GET' && request.headers[CLIENT_FEATURES_HEADER] === undefined
      && typeof query.features === 'string' && query.features.length <= 1024) request.headers[CLIENT_FEATURES_HEADER] = query.features;
    if (route.startsWith('/api/task-workspaces/') && !clientSupportsFeature(request.headers, 'projectless-tasks')) throw new AppError('FEATURE_REQUIRED', 'Update the client to use task workspaces', 409);
    const id = (request.params as { id?: string })?.id;
    let project: Project | undefined;
    if (id && route.startsWith('/api/projects/:id')) project = checkProject(request.headers, id);
    if (id && (route.startsWith('/api/sessions/:id') || route.startsWith('/api/v3/sessions/:id'))) checkSession(request.headers, id);
    if (id && route.startsWith('/api/terminals/:id')) {
      const terminal = store.getTerminal(id);
      checkProject(request.headers, terminal.projectId);
      checkSession(request.headers, terminal.sessionId);
    }
    checkProject(request.headers, query.projectId);
    if (route === '/api/search/messages' && typeof query.sessionId === 'string') {
      // A missing search scope has always returned an empty page; an existing hidden task is denied.
      let scoped;
      try { scoped = store.getSession(query.sessionId); }
      catch (error) { if (!(error instanceof AppError) || error.code !== 'SESSION_NOT_FOUND') throw error; }
      if (scoped) requireSessionVisibleToClient(request.headers, scoped, value => store.getProject(value));
    } else checkSession(request.headers, query.sessionId);
    if (project?.system === 'task-workspace' && request.method !== 'GET'
      && (/\/worktrees(?:\/|$)/.test(route) || /\/worktree-projects(?:\/|$)/.test(route) || /\/attempts(?:\/|$)/.test(route))) throw new AppError('TASK_WORKSPACE_SAVE_REQUIRED', 'Save this task as a project before creating worktrees', 409);
  });
  app.addHook('preValidation', async request => {
    const route = request.routeOptions?.url;
    if (!route?.startsWith('/api/')) return;
    const body = request.body as { projectId?: unknown; sessionId?: unknown; isolate?: unknown } | undefined;
    if (!body || typeof body !== 'object') return;
    checkProject(request.headers, body.projectId);
    checkSession(request.headers, body.sessionId);
    if (route === '/api/sessions/:id/fork' && body.isolate === true) {
      const session = store.getSession((request.params as { id: string }).id);
      if (store.getProject(session.projectId).system === 'task-workspace') throw new AppError('TASK_WORKSPACE_SAVE_REQUIRED', 'Save this task as a project before creating worktrees', 409);
    }
  });
}

/** A launch target may name the backend explicitly; the same rule as a new conversation applies. */
export function visibleLaunchTargetForClient<T extends { backendId?: string }>(headers: IncomingHttpHeaders | undefined, target: T): T {
  if (target?.backendId !== undefined) requireBackendVisibleToClient(headers, target.backendId);
  return target;
}
