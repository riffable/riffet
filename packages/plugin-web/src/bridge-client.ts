// The calling side of the message bridge (see `bridge.ts`): what a plugin's isolated view bundles. It has no
// dependency and no browser requirement beyond `window`, `MessageChannel` and `setTimeout`.
//
//   import { connect } from './bridge-client';
//   const bridge = await connect();
//   const session = await bridge.call('sessions.get', { sessionId: bridge.context.sessionId! });
//   bridge.on('context', (context) => { ... });
//
// `connect()` takes the channel the page asked the host for at its start (the page is built by the host and
// sends the request before any view code runs, see `BRIDGE_PORT`) and resolves once the host has answered the first
// `context.get` and `theme.get`. The theme's colour variables are applied to the document element as they
// arrive, so `var(--fg)` and `var(--bg)` in the view's CSS follow the app; pass `{ applyTheme: false }` to
// read them only.

import {
  BRIDGE_LIMITS, BRIDGE_PORT,
  type BridgeHostInfo, type BridgeErrorBody, type BridgeErrorCode, type BridgeEvent, type BridgeEvents, type BridgeMethod, type BridgeMethods, type BridgeTheme, type BridgeViewContext,
} from './bridge.js';

/** A call the host refused or could not complete. `code` is one of `BridgeErrorCode`. */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

export interface BridgeCallOptions { signal?: AbortSignal }
type CallArguments<M extends BridgeMethod> = BridgeMethods[M]['params'] extends undefined ? [params?: undefined, options?: BridgeCallOptions] : [params: BridgeMethods[M]['params'], options?: BridgeCallOptions];

export interface BridgeConnection {
  /** The latest `context`; replaced when a `context` push arrives. */
  readonly context: BridgeViewContext;
  /** The latest `theme`. */
  readonly theme: BridgeTheme;
  /** Absent only on a legacy host that predates capability negotiation. */
  readonly host: BridgeHostInfo | undefined;
  call<M extends BridgeMethod>(method: M, ...params: CallArguments<M>): Promise<BridgeMethods[M]['result']>;
  /** Listens to a push; returns the function that stops listening. */
  on<E extends BridgeEvent>(event: E, listener: (data: BridgeEvents[E]) => void): () => void;
  /** Ends the channel; pending calls reject with `closed`. The host ends it too when the view goes away. */
  close(): void;
}

export interface ConnectOptions {
  /** Apply the pushed colour variables and `color-scheme` to the document element. Default true. */
  applyTheme?: boolean;
  /** How long to wait for the host to answer, in milliseconds. */
  timeoutMs?: number;
  /** Refuse the connection if this UI host does not implement a required method. */
  requiredMethods?: readonly BridgeMethod[];
}

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; dispose?(): void }

function applyThemeVars(theme: BridgeTheme): void {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.vars)) root.style.setProperty(name, value);
  root.style.colorScheme = theme.scheme;
}

export function connect({ applyTheme = true, timeoutMs = 10_000, requiredMethods = [] }: ConnectOptions = {}): Promise<BridgeConnection> {
  // The page the host built asked for the channel before this code ran and keeps the port here; the view
  // never asks, so a page it navigates to has no way to.
  const hooked = (window as unknown as { [BRIDGE_PORT]?: Promise<MessagePort> })[BRIDGE_PORT];
  if (!hooked) return Promise.reject(new BridgeError('unsupported', 'This page was not started by Riffet'));
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BridgeError('timeout', 'The host did not answer')), timeoutMs); });
  return Promise.race([hooked, expired]).then((port) => open(port, applyTheme, requiredMethods)).finally(() => clearTimeout(timer));
}

async function open(port: MessagePort, apply: boolean, required: readonly BridgeMethod[]): Promise<BridgeConnection> {
  const pending = new Map<number, Pending>();
  const listeners = new Map<BridgeEvent, Set<(data: never) => void>>();
  let next = 0;
  let closed = false;
  let context!: BridgeViewContext;
  let theme!: BridgeTheme;
  let host: BridgeHostInfo | undefined;

  const settle = (id: number, finish: (entry: Pending) => void) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.dispose?.();
    finish(entry);
  };
  const call = (method: string, params?: unknown, options?: BridgeCallOptions): Promise<never> => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(new BridgeError('aborted', 'The call was cancelled')); return; }
    if (closed) { reject(new BridgeError('closed', 'The channel is closed')); return; }
    next += 1;
    const id = next;
    const timer = setTimeout(() => { port.postMessage({ cancel: id }); settle(id, entry => entry.reject(new BridgeError('timeout', `${method} timed out`))); }, BRIDGE_LIMITS.timeoutMs);
    const cancel = () => { port.postMessage({ cancel: id }); settle(id, entry => entry.reject(new BridgeError('aborted', 'The call was cancelled'))); };
    options?.signal?.addEventListener('abort', cancel, { once: true });
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, dispose: () => options?.signal?.removeEventListener('abort', cancel) });
    port.postMessage({ id, method, ...(params === undefined ? {} : { params }) });
  });

  port.onmessage = (event: MessageEvent) => {
    const data = event.data as { id?: unknown; result?: unknown; error?: BridgeErrorBody; event?: unknown; data?: unknown } | null;
    if (!data || typeof data !== 'object') return;
    if (typeof data.id === 'number') {
      const { error, result } = data;
      settle(data.id, (entry) => (error ? entry.reject(new BridgeError(error.code, error.message)) : entry.resolve(result)));
    } else if (data.event === 'context' || data.event === 'theme' || data.event === 'data' || data.event === 'plugin.data') {
      if (data.event === 'context') context = data.data as BridgeViewContext;
      else if (data.event === 'theme') { theme = data.data as BridgeTheme; if (apply) applyThemeVars(theme); }
      for (const listener of listeners.get(data.event) ?? []) (listener as (value: unknown) => void)(data.data);
    }
  };

  [context, theme, host] = await Promise.all([call('context.get'), call('theme.get'), call('host.info').catch(error => { if (error instanceof BridgeError && error.code === 'unknown_method') return undefined; throw error; })]) as [BridgeViewContext, BridgeTheme, BridgeHostInfo | undefined];
  if (required.some(method => !host?.methods.includes(method))) {
    port.postMessage({ close: true }); port.close(); closed = true;
    throw new BridgeError('unsupported', 'This UI host does not provide the required methods');
  }
  if (apply) applyThemeVars(theme);

  return {
    get context() { return context; },
    get theme() { return theme; },
    get host() { return host; },
    call: ((method: string, params?: unknown, options?: BridgeCallOptions) => call(method, params, options)) as BridgeConnection['call'],
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set.add(listener as (data: never) => void));
      return () => { set.delete(listener as (data: never) => void); };
    },
    close() {
      if (closed) return;
      closed = true;
      port.postMessage({ close: true });
      port.close();
      for (const id of [...pending.keys()]) settle(id, (entry) => entry.reject(new BridgeError('closed', 'The channel is closed')));
    },
  };
}
