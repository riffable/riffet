import type { SyncLane, TimelinePage, TurnOutlineV3 } from '@contracts';
import { HttpError } from '../../lib/errors';
import {
  BRIDGE_CAPABILITY, BRIDGE_LIMITS, BRIDGE_VERSION, PLUGIN_BASE_STYLE_VERSION,
  type BridgeFileBytes, type BridgeHostInfo, type BridgePage, type BridgeProject, type BridgeRun, type BridgeCommandResult, type BridgeErrorBody, type BridgeErrorCode, type BridgeEvent, type BridgeEvents, type BridgeMethod, type BridgeMethods, type BridgeSession, type BridgeTheme, type BridgeViewContext,
} from '@riffet/plugin-web';

/*
 * The serving side of the message bridge (packages/plugin-web/src/bridge.ts) for one isolated view. It
 * knows nothing of frames or React: it is handed the port of one channel, what the package holds, and the
 * app's side as `BridgeServices`. Who is calling is settled by the port (see `frameHost.ts`); nothing in a
 * request names a plugin. Every request is shape-checked, then checked against the package's
 * capabilities, then against its params, and only then reaches a service, which sees a signal that
 * aborts when the channel closes.
 */

/** The host's end of a channel: a `MessagePort`, or a stand-in in a test. */
export interface BridgePort {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

export interface BridgeServices {
  /** The context as it is now. */
  context(): BridgeViewContext;
  theme(): BridgeTheme;
  sessions?(): BridgeSession[];
  projects?(): BridgeProject[];
  runs?(sessionId: string, signal: AbortSignal): Promise<BridgeRun[]>;
  /** The conversation the app holds under this id, whichever project it belongs to. */
  session(sessionId: string): BridgeSession | undefined;
  outline(sessionId: string, lane: SyncLane, signal: AbortSignal): Promise<TurnOutlineV3[]>;
  timeline(sessionId: string, query: { lane: SyncLane; from: number; rows: number }, signal: AbortSignal): Promise<TimelinePage>;
  /** The summary of a finished turn of the main lane, written by the auxiliary model chosen for it; absent where the host has none. */
  turnSummary?(sessionId: string, turn: string, signal: AbortSignal): Promise<string | undefined>;
  turnSummaries?(): boolean;
  /** Whether the user is interacting with this view now: it has the keyboard focus. Navigation the view asks for is refused otherwise. */
  active(): boolean;
  openSession(sessionId: string): void;
  openPath(path: string): void;
  /** Opens a view of this package (a `main` page or a `sidebar` panel). */
  openView?(viewId: string): boolean;
  /** Navigates to the personal assistant conversation, when available. */
  openAssistant?(): boolean;
  /** Opens an `http(s)` address in a new browser tab; the bridge has checked the address and the user's action. */
  openExternal?(url: string): void;
  /** Bytes of a file of the view's project, read as the user reads it; absent where the host cannot read files. */
  readFile?(path: string, offset: number, length: number, signal: AbortSignal): Promise<BridgeFileBytes>;
  notify(tone: 'info' | 'error', text: string): void;
  /** Runs a command of the package through the server and answers what it answered; absent where the host has no command path, which answers `unsupported`. */
  execute?(commandId: string, args: Record<string, string | number | boolean> | undefined, signal: AbortSignal): Promise<BridgeCommandResult>;
  /** Runs a declared read-only query of the package through the server. */
  query?(queryId: string, params: Record<string, unknown> | undefined, signal: AbortSignal): Promise<unknown>;
}

/** What the package holds: the grant of the installed version, or what a trusted development package asks for, and what it declares. */
export interface BridgeGrant {
  capabilities: ReadonlySet<string>;
  commands: ReadonlySet<string>;
  queries?: ReadonlySet<string>;
  views?: ReadonlySet<string>;
  /** The view lists `bridge.navigation.openExternal` in its `requires`. */
  externalLinks?: boolean;
}

export interface Bridge {
  /** Sends a push to the view; nothing once closed. */
  push<E extends BridgeEvent>(event: E, data: BridgeEvents[E]): void;
  /** Aborts every pending call and ends the channel. Idempotent. */
  close(): void;
}

class Failure extends Error {
  readonly code: BridgeErrorCode;
  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const invalid = (message: string) => new Failure('invalid_params', message);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A required string of 1 to `max` characters with no control characters. */
function text(params: Record<string, unknown>, key: string, max: number): string {
  const value = params[key];
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw invalid(`${key} must be text of at most ${max} characters`);
  return value;
}

function lane(params: Record<string, unknown>): SyncLane {
  const value = params.lane;
  if (value === undefined) return 'main';
  if (value === 'main' || (typeof value === 'string' && value.startsWith('sub:') && value.length > 4 && value.length <= 204)) return value as SyncLane;
  throw invalid('lane must be main or sub:<id>');
}

function integer(params: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(`${key} must be an integer from ${min} to ${max}`);
  return value;
}

/** Only the named keys may be present. */
function only(params: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(params)) throw invalid('params must be an object');
  const extra = Object.keys(params).find((key) => !keys.includes(key));
  if (extra !== undefined) throw invalid(`unknown param ${extra}`);
  return params;
}

/** A path inside the project: relative, no `..`, no drive letter, no home folder (the server expands `~`). Returns it without a leading `./`. */
function projectPath(params: Record<string, unknown>): string {
  const value = text(params, 'path', BRIDGE_LIMITS.text);
  if (value.startsWith('/') || value.startsWith('\\') || value.startsWith('~') || /^[a-zA-Z]:/.test(value) || value.includes('\\') || value.split('/').some((part) => part === '..')) throw invalid('path must be relative to the project root');
  return value.replace(/^(?:\.\/)+/, '') || '.';
}

/** An `http:` or `https:` address without credentials, as the browser will open it. */
function externalUrl(params: Record<string, unknown>): string {
  const value = text(params, 'url', BRIDGE_LIMITS.url);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw invalid('url must be an http or https address'); }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) throw invalid('url must be an http or https address without credentials');
  return parsed.toString();
}

/** Steering the app (selecting a conversation, previewing a file) follows the user's own action in the view, never a script on its own. */
function interacting({ services }: Call): void {
  if (!services.active()) throw new Failure('denied', 'Click in the view first');
}

type Methods = { [M in BridgeMethod]: (params: unknown, call: Call) => BridgeMethods[M]['result'] | Promise<BridgeMethods[M]['result']> };

interface Call {
  signal: AbortSignal;
  services: BridgeServices;
  grant: BridgeGrant;
  /** The conversation of the view's own project, or a refusal. */
  ownSession(sessionId: string): BridgeSession;
}

function page<T>(params: unknown, keys: string[], values: readonly T[]): BridgePage<T> {
  const input = only(params ?? {}, [...keys, 'offset', 'limit']);
  const offset = input.offset === undefined ? 0 : integer(input, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const limit = input.limit === undefined ? 50 : integer(input, 'limit', 1, BRIDGE_LIMITS.rows);
  const end = offset + limit;
  return { items: values.slice(offset, end), ...(end < values.length ? { next: end } : {}) };
}
function hostInfo(services: BridgeServices): BridgeHostInfo {
  const methods = Object.keys(BRIDGE_CAPABILITY)
    .filter(method => method !== 'projects.list' || services.projects)
    .filter(method => method !== 'sessions.list' || services.sessions)
    .filter(method => method !== 'sessions.runs' || services.runs)
    .filter(method => !method.startsWith('sessions.turnSummar') || services.turnSummary)
    .filter(method => method !== 'files.read' || services.readFile)
    .filter(method => method !== 'plugin.query' || services.query)
    .filter(method => method !== 'navigation.openView' || services.openView)
    .filter(method => method !== 'navigation.openAssistant' || services.openAssistant)
    .filter(method => method !== 'navigation.openExternal' || services.openExternal);
  return { platform: 'web', webApiVersion: 1, bridgeVersion: BRIDGE_VERSION, baseStyleVersion: PLUGIN_BASE_STYLE_VERSION, renderers: ['tasks', 'list', 'form', 'detail'], methods, execution: { server: services.context().serviceId, client: 'web' } };
}

const methods: Methods = {
  'host.info': (params, { services }) => { if (params !== undefined && !(isRecord(params) && !Object.keys(params).length)) throw invalid('takes no params'); return hostInfo(services); },
  'projects.list': (params, { services }) => {
    if (!services.projects) throw new Failure('unsupported', 'This host has no project directory');
    const projectId = services.context().projectId;
    return page(params, [], services.projects().filter(project => project.id === projectId));
  },
  'sessions.list': (params, { services }) => {
    if (!services.sessions) throw new Failure('unsupported', 'This host has no conversation directory');
    const projectId = services.context().projectId;
    return page(params, [], services.sessions().filter(session => session.projectId === projectId));
  },
  'sessions.runs': async (params, call) => {
    if (!call.services.runs) throw new Failure('unsupported', 'This host has no run directory');
    const input = only(params, ['sessionId', 'offset', 'limit']);
    const id = text(input, 'sessionId', 200);
    call.ownSession(id);
    return page(input, ['sessionId'], await call.services.runs(id, call.signal));
  },
  'context.get': (params, { services }) => { if (params !== undefined && !(isRecord(params) && Object.keys(params).length === 0)) throw invalid('takes no params'); return services.context(); },
  'theme.get': (params, { services }) => { if (params !== undefined && !(isRecord(params) && Object.keys(params).length === 0)) throw invalid('takes no params'); return services.theme(); },
  'sessions.get': (params, call) => call.ownSession(text(only(params, ['sessionId']), 'sessionId', 200)),
  'sessions.outline': async (params, call) => {
    const input = only(params, ['sessionId', 'lane']);
    const id = text(input, 'sessionId', 200), selected = lane(input);
    call.ownSession(id);
    return { turns: await call.services.outline(id, selected, call.signal) };
  },
  'sessions.turnSummary': async (params, call) => {
    if (!call.services.turnSummary) throw new Failure('unsupported', 'This host writes no turn summaries');
    const input = only(params, ['sessionId', 'turn']);
    const id = text(input, 'sessionId', 200), turn = text(input, 'turn', 300);
    call.ownSession(id);
    const summary = await call.services.turnSummary(id, turn, call.signal);
    return summary ? { summary } : {};
  },
  'sessions.turnSummaries': (params, { services }) => {
    if (!services.turnSummaries) throw new Failure('unsupported', 'This host writes no turn summaries');
    if (params !== undefined && !(isRecord(params) && Object.keys(params).length === 0)) throw invalid('takes no params');
    return { enabled: services.turnSummaries() };
  },
  'sessions.timeline': async (params, call) => {
    const input = only(params, ['sessionId', 'lane', 'from', 'rows']);
    const id = text(input, 'sessionId', 200), selected = lane(input), from = integer(input, 'from', 0, Number.MAX_SAFE_INTEGER);
    const rows = input.rows === undefined ? BRIDGE_LIMITS.rows : integer(input, 'rows', 1, BRIDGE_LIMITS.rows);
    call.ownSession(id);
    return call.services.timeline(id, { lane: selected, from, rows }, call.signal);
  },
  'navigation.openSession': (params, call) => {
    const sessionId = text(only(params, ['sessionId']), 'sessionId', 200);
    interacting(call);
    call.services.openSession(call.ownSession(sessionId).id);
    return null;
  },
  'files.read': (params, { services, grant, signal }) => {
    const input = only(params ?? {}, ['path', 'offset', 'length']);
    const own = services.context();
    if (!services.readFile) throw new Failure('unsupported', 'This host cannot read files');
    if (!own.projectId) throw new Failure('forbidden', 'This view has no project');
    const path = input.path === undefined ? own.path : projectPath(input);
    if (path === undefined) throw invalid('path is required: this view shows no file');
    // The file the view was opened for is what it is for; reading others is reading the project.
    if (path !== own.path && !grant.capabilities.has('projects.read')) throw new Failure('denied', 'This package does not hold projects.read');
    const offset = input.offset === undefined ? 0 : integer(input, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const length = input.length === undefined ? BRIDGE_LIMITS.fileBytes : integer(input, 'length', 1, BRIDGE_LIMITS.fileBytes);
    return services.readFile(path, offset, length, signal);
  },
  'navigation.openPath': (params, call) => {
    const path = projectPath(only(params, ['path']));
    interacting(call);
    // A file of the project the view belongs to; a view with no project has none.
    if (!call.services.context().projectId) throw new Failure('forbidden', 'This view has no project');
    call.services.openPath(path);
    return null;
  },
  'navigation.openView': (params, call) => {
    const viewId = text(only(params, ['viewId']), 'viewId', 200);
    interacting(call);
    if (!call.grant.views?.has(viewId)) throw new Failure('forbidden', 'The package does not declare this view');
    if (!call.services.openView) throw new Failure('unsupported', 'This host cannot open views');
    if (!call.services.openView(viewId)) throw new Failure('not_found', 'This view is not available here');
    return null;
  },
  'navigation.openAssistant': (params, call) => {
    if (params !== undefined && !(isRecord(params) && Object.keys(params).length === 0)) throw invalid('takes no params');
    interacting(call);
    if (!call.services.openAssistant) throw new Failure('unsupported', 'This host has no assistant surface');
    if (!call.services.openAssistant()) throw new Failure('not_found', 'No assistant is available here');
    return null;
  },
  'navigation.openExternal': (params, call) => {
    const url = externalUrl(only(params, ['url']));
    interacting(call);
    if (!call.grant.externalLinks) throw new Failure('forbidden', 'The view does not require bridge.navigation.openExternal');
    if (!call.services.openExternal) throw new Failure('unsupported', 'This host cannot open addresses');
    call.services.openExternal(url);
    return null;
  },
  'notify.info': (params, { services }) => { services.notify('info', text(only(params, ['text']), 'text', BRIDGE_LIMITS.text)); return null; },
  'notify.error': (params, { services }) => { services.notify('error', text(only(params, ['text']), 'text', BRIDGE_LIMITS.text)); return null; },
  'commands.execute': (params, { services, grant, signal }) => {
    const input = only(params, ['id', 'args']);
    const id = text(input, 'id', 200);
    if (!grant.commands.has(id)) throw new Failure('forbidden', 'The package does not declare this command');
    if (!services.execute) throw new Failure('unsupported', 'This host has no command path');
    const args = input.args;
    if (args !== undefined && !(isRecord(args) && Object.values(args).every((value) => ['string', 'number', 'boolean'].includes(typeof value)))) throw invalid('args must map names to text, numbers or booleans');
    return services.execute(id, args as Record<string, string | number | boolean> | undefined, signal);
  },
  'plugin.query': (params, { services, grant, signal }) => {
    const input = only(params, ['id', 'params']);
    const id = text(input, 'id', 200);
    if (!grant.queries?.has(id)) throw new Failure('forbidden', 'The package does not declare this query');
    if (!services.query) throw new Failure('unsupported', 'This host has no query path');
    const queryParams = input.params;
    if (queryParams !== undefined && !isRecord(queryParams)) throw invalid('params must be an object');
    return services.query(id, queryParams as Record<string, unknown> | undefined, signal);
  },
};

const failure = (error: unknown): BridgeErrorBody => {
  if (error instanceof Failure) return { code: error.code, message: error.message };
  if (error instanceof Error && error.name === 'AbortError') return { code: 'aborted', message: 'The call was cancelled' };
  const status = (error as { status?: unknown } | null)?.status;
  // A refusal of the view's own request (4xx: the plugin's `host.error`, a validation failure) carries a reason the view
  // can show; server failures stay generic so host internals don't reach the package.
  if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.message) return { code: 'failed', message: error.message };
  return { code: 'failed', message: typeof status === 'number' && status > 0 ? `The request failed (${status})` : 'The request failed' };
};

/** Serves one channel until `close()`. */
export function serveBridge({ port, grant, services, now = Date.now }: { port: BridgePort; grant: BridgeGrant; services: BridgeServices; now?: () => number }): Bridge {
  let closed = false;
  const requests = new Map<number, AbortController>();
  let pending = 0;
  let tokens: number = BRIDGE_LIMITS.burst;
  let refilled = now();

  const send = (message: unknown) => { if (!closed) port.postMessage(message); };
  const take = (): boolean => {
    const at = now();
    tokens = Math.min(BRIDGE_LIMITS.burst, tokens + ((at - refilled) / 1000) * BRIDGE_LIMITS.perSecond);
    refilled = at;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
  const ownSession = (sessionId: string): BridgeSession => {
    const session = services.session(sessionId);
    // The project is the one the view was mounted for, not one the request names. Another project's
    // conversation reads as absent, so a view cannot probe which ids exist.
    const projectId = services.context().projectId;
    if (!session || !projectId || session.projectId !== projectId) throw new Failure('not_found', 'No such conversation in this project');
    return session;
  };

  async function handle(id: number, method: string, params: unknown): Promise<void> {
    const reply = (message: { result: unknown } | { error: BridgeErrorBody }) => send({ id, ...message });
    if (!Object.hasOwn(BRIDGE_CAPABILITY, method)) return reply({ error: { code: 'unknown_method', message: 'Unknown method' } });
    const needed = BRIDGE_CAPABILITY[method as BridgeMethod];
    if (needed && !grant.capabilities.has(needed)) return reply({ error: { code: 'denied', message: `This package does not hold ${needed}` } });
    const request = new AbortController();
    requests.set(id, request);
    pending += 1;
    try {
      const result = await methods[method as BridgeMethod](params, { signal: request.signal, services, grant, ownSession });
      if (closed) return;
      if (request.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const size = JSON.stringify(result ?? null).length;
      if (size > BRIDGE_LIMITS.replyBytes) return reply({ error: { code: 'too_large', message: 'The result is too large' } });
      reply({ result: result ?? null });
    } catch (error) {
      if (!closed) reply({ error: failure(error) });
    } finally {
      requests.delete(id);
      pending -= 1;
    }
  }

  port.onmessage = ({ data }) => {
    if (!closed && isRecord(data) && data.close === true) {
      closed = true;
      for (const request of requests.values()) request.abort();
      requests.clear(); port.onmessage = null; port.close(); return;
    }
    if (!closed && isRecord(data) && Number.isSafeInteger(data.cancel)) { requests.get(data.cancel as number)?.abort(); return; }
    if (closed || !isRecord(data) || typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || data.id < 0) return;
    const id = data.id;
    if (requests.has(id)) { send({ id, error: { code: 'invalid_request', message: 'Request id is already pending' } }); return; }
    if (pending >= BRIDGE_LIMITS.pending || !take()) { send({ id, error: { code: 'rate_limited', message: 'Too many requests' } }); return; }
    let size: number;
    try { size = JSON.stringify(data).length; } catch { send({ id, error: { code: 'invalid_request', message: 'The request is not plain data' } }); return; }
    if (size > BRIDGE_LIMITS.requestBytes) { send({ id, error: { code: 'too_large', message: 'The request is too large' } }); return; }
    if (typeof data.method !== 'string') { send({ id, error: { code: 'invalid_request', message: 'method must be text' } }); return; }
    void handle(id, data.method, data.params);
  };

  return {
    push(event, data) { send({ event, data }); },
    close() {
      if (closed) return;
      closed = true;
      for (const request of requests.values()) request.abort();
      requests.clear();
      port.onmessage = null;
      port.close();
    },
  };
}
