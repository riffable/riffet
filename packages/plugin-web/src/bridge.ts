// The message bridge between the app and a plugin view that runs isolated (docs/design/plugin-system.md §4.4,
// docs/PLUGIN_ARCHITECTURE.md "自定义视图"): the protocol both ends speak. The web host (`apps/web/src/plugins/isolated`)
// and the macOS WebView host implement the serving side, `bridge-client.ts` the calling side, and a view
// reaches the app through nothing else.
//
// Types and constants only, with no runtime imports, so the client bundles on its own.

import type { SyncLane, TimelinePage, TurnOutlineV3 } from '@contracts';

export const BRIDGE_VERSION = 1;

/**
 * Posted to the window that embeds the page, to ask for the channel. The page the host builds posts it itself, first thing, before any
 * of the view's code exists; the host answers only the frame it embedded, and only the first time. The view does not send it.
 */
export const BRIDGE_READY = 'riffet-plugin:ready';
/** The host's answer: `{ type, version }` with the one `MessagePort` of the channel in `ports[0]`. The page keeps it for `connect()`. */
export const BRIDGE_INIT = 'riffet-plugin:init';
/** The property of the page's `window` that holds a `Promise<MessagePort>` for the host's answer; `connect()` reads it. */
export const BRIDGE_PORT = '__riffetPort';

/** What the view is mounted for. Fixed for the life of the channel except `visible` and `locale`, which arrive as `context` pushes. */
export interface BridgeViewContext {
  serviceId: string;
  projectId?: string;
  sessionId?: string;
  /** The project file a view located at `file` shows, relative to the project root. */
  path?: string;
  instanceId: string;
  visible: boolean;
  /** The app's language as a BCP-47 tag. */
  locale: string;
}

/** The colour roles of the palette in effect (`THEME_ROLES`): `vars` maps `--<role>` to a CSS colour, so a view can use `var(--fg)` after applying them. */
export interface BridgeTheme {
  scheme: 'light' | 'dark';
  vars: Record<string, string>;
}

/** A conversation as a view may read it: enough to name and place it, nothing that routes or resumes it. */
export interface BridgeSession {
  id: string;
  projectId: string;
  title: string;
  state: string;
  backendId?: string;
  model?: string;
  mode: string;
  tags: string[];
  archivedAt?: string;
  lastActivityAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** What a command answers (`CommandResult`): the view acts on it, the host does not. */
export type BridgeCommandResult =
  | { kind: 'done'; message?: Record<string, string> }
  | { kind: 'open'; view?: string; sessionId?: string; path?: string }
  | { kind: 'task'; taskId: string };

export interface BridgeHostInfo {
  platform: 'web' | 'macos';
  webApiVersion: number;
  bridgeVersion: number;
  /** `PLUGIN_BASE_STYLE_VERSION` of the page's base stylesheet. Absent from an older host. */
  baseStyleVersion?: number;
  renderers: string[];
  methods: string[];
  /** Service code runs on this server; this host describes only the current UI client. */
  execution: { server: string; client: 'web' | 'macos' };
}
export interface BridgePage<T> { items: T[]; next?: number }
/** Bytes of a project file, base64: `size` is the whole file's, `offset` where these start; fewer than asked for at its end, none past it (`size` is then at most `offset`). */
export interface BridgeFileBytes { path: string; size: number; offset: number; data: string }
export interface BridgeProject { id: string; name: string }
export interface BridgeRun { id: string; state: string; startedAt?: string; endedAt?: string; outputTokens?: number }

export interface BridgeMethods {
  /** The context as it is now. */
  'host.info': { params: undefined; result: BridgeHostInfo };
  'projects.list': { params: { offset?: number; limit?: number }; result: BridgePage<BridgeProject> };
  'sessions.list': { params: { offset?: number; limit?: number }; result: BridgePage<BridgeSession> };
  'sessions.runs': { params: { sessionId: string; offset?: number; limit?: number }; result: BridgePage<BridgeRun> };
  'context.get': { params: undefined; result: BridgeViewContext };
  /** The current palette. */
  'theme.get': { params: undefined; result: BridgeTheme };
  /** `sessions.read`; a conversation of the view's own project. */
  'sessions.get': { params: { sessionId: string }; result: BridgeSession };
  /** `sessions.read`; the turns of one lane, oldest first. */
  'sessions.outline': { params: { sessionId: string; lane?: SyncLane }; result: { turns: TurnOutlineV3[] } };
  /** `sessions.read`; one sentence on what a finished turn came to, as the outline's `turn` names it. Empty when no model is chosen for canvas summaries, the turn has no finished answer, or writing failed. Written on the first ask, which can take seconds. */
  'sessions.turnSummary': { params: { sessionId: string; turn: string }; result: { summary?: string } };
  /** `sessions.read`; whether a model is chosen for canvas summaries, as of now. */
  'sessions.turnSummaries': { params: undefined; result: { enabled: boolean } };
  /** `sessions.read`; up to `rows` (at most 200) rows of one lane from row position `from`, as the outline's `startPos` gives it. */
  'sessions.timeline': { params: { sessionId: string; lane?: SyncLane; from: number; rows?: number }; result: TimelinePage };
  /** Selects a conversation of the view's own project. */
  'navigation.openSession': { params: { sessionId: string }; result: null };
  /**
   * Up to `length` (at most `BRIDGE_LIMITS.fileBytes`, the default) bytes of a file of the view's own project from `offset`. `path`
   * defaults to the context's; the view's own file needs nothing, any other file `projects.read`. Read as the user reads it, under the
   * same limits on what is outside the project or holds credentials.
   */
  'files.read': { params: { path?: string; offset?: number; length?: number }; result: BridgeFileBytes };
  /** Previews a file of the view's own project; `path` is relative to the project root. */
  'navigation.openPath': { params: { path: string }; result: null };
  /** Opens another declared view (`main` or `sidebar`) of this package, after a user action in the view. */
  'navigation.openView': { params: { viewId: string }; result: null };
  /** Opens the personal assistant page, after a user action in the view. */
  'navigation.openAssistant': { params: undefined; result: null };
  /**
   * Opens an `http:` or `https:` address (at most `BRIDGE_LIMITS.url` characters, no credentials in it) in the user's browser: a
   * new tab on the web, the default browser on the Mac. After a user action in the view, and only for a view whose `requires` lists
   * `bridge.navigation.openExternal`; `forbidden` otherwise.
   */
  'navigation.openExternal': { params: { url: string }; result: null };
  'notify.info': { params: { text: string }; result: null };
  'notify.error': { params: { text: string }; result: null };
  /** Runs a command the package declares (`contributes.commands`) and answers what the server did: `{ kind: 'done', message? }`, `{ kind: 'open', ... }` or `{ kind: 'task', taskId }` (`CommandResult`). The host takes no action of its own from it. */
  'commands.execute': { params: { id: string; args?: Record<string, string | number | boolean> }; result: BridgeCommandResult };
  /** Calls a read-only structured query declared by this package (`contributes.queries`). */
  'plugin.query': { params: { id: string; params?: Record<string, unknown> }; result: unknown };
}

export type BridgeMethod = keyof BridgeMethods;

/** Pushed without a request. A push is the new value, never a delta. */
export interface BridgeEvents {
  context: BridgeViewContext;
  theme: BridgeTheme;
  /** Data in this view's project changed; reread only the pages in use. */
  data: { kind: 'sessions'; projectId: string };
  /** This plugin's server invalidated cached query data (`host.views.invalidate`). */
  'plugin.data': { topic?: string };
}

export type BridgeEvent = keyof BridgeEvents;

/** The capability a method needs; none means any view may call it. The host refuses the call before it reads the params. */
export const BRIDGE_CAPABILITY: Readonly<Record<BridgeMethod, string | undefined>> = {
  'host.info': undefined,
  'projects.list': 'projects.read',
  'sessions.list': 'sessions.read',
  'sessions.runs': 'sessions.read',
  'context.get': undefined,
  'theme.get': undefined,
  'sessions.get': 'sessions.read',
  'sessions.outline': 'sessions.read',
  'sessions.turnSummary': 'sessions.read',
  'sessions.turnSummaries': 'sessions.read',
  'sessions.timeline': 'sessions.read',
  // Checked against the path: the view's own file needs nothing, another `projects.read`.
  'files.read': undefined,
  'navigation.openSession': undefined,
  'navigation.openPath': undefined,
  'navigation.openView': undefined,
  'navigation.openAssistant': undefined,
  'navigation.openExternal': undefined,
  'notify.info': undefined,
  'notify.error': undefined,
  'commands.execute': undefined,
  'plugin.query': undefined,
};

export type BridgeErrorCode =
  | 'invalid_request' | 'unknown_method' | 'invalid_params' | 'denied' | 'forbidden' | 'not_found'
  | 'rate_limited' | 'too_large' | 'unsupported' | 'failed' | 'aborted' | 'timeout' | 'closed';

export interface BridgeErrorBody { code: BridgeErrorCode; message: string }

/** View to host. `id` is the caller's own counter; the reply carries it back. */
export interface BridgeRequest { id: number; method: string; params?: unknown }
export type BridgeReply = { id: number; result: unknown } | { id: number; error: BridgeErrorBody };
export interface BridgePush { event: BridgeEvent; data: unknown }

export const BRIDGE_LIMITS = {
  /** Serialized size of one request. */
  requestBytes: 64 * 1024,
  /** Serialized size of one result. */
  replyBytes: 1024 * 1024,
  /** Requests answered at once. */
  pending: 16,
  /** A token bucket: a burst this large, refilled at `perSecond`. */
  burst: 60,
  perSecond: 30,
  /** Characters of a notification or a path. */
  text: 500,
  /** Characters of an address `navigation.openExternal` opens. */
  url: 2000,
  /** Bytes of one `files.read`, before base64. */
  fileBytes: 512 * 1024,
  rows: 200,
  /** How long the client waits for a reply. */
  timeoutMs: 30_000,
} as const;
