// Static declarations of a plugin package (docs/design/plugin-system.md §3, §4). Read from the
// manifest without running plugin code, so a plugin that is off still lists its views and commands.
// New contribution kinds (`appearance`, `tasks`, `agentBackends`) are added to `PluginDeclarations`
// as optional keys: a client ignores a key it does not know.

import type { AppearanceDeclarations } from './appearance.js';
import type { TaskParamField } from './tasks.js';

/** Display text by BCP-47 tag, such as `{ 'zh-Hans': '画布', en: 'Canvas' }`. Clients pick one with a fallback chain. */
export type LocalizedText = Record<string, string>;

export const VIEW_LOCATIONS = ['session-view', 'sidebar', 'panel', 'main', 'navigation', 'settings'] as const;
/**
 * Semantic places a view may live, not pixel positions: the workbench decides sizes and order. `settings` is a
 * page of the settings dialog, listed under the plugin's own group while the plugin is on.
 */
export type ViewLocation = typeof VIEW_LOCATIONS[number];

export const PLUGIN_CLIENTS = ['web', 'macos'] as const;
export type PluginClient = typeof PLUGIN_CLIENTS[number];

export const VIEW_INSTANCES = ['single', 'per-session', 'per-project'] as const;
export type ViewInstancing = typeof VIEW_INSTANCES[number];

/**
 * When a view or command is offered. A structured form the host can validate and evaluate, never an
 * expression: it decides visibility only and grants no permission to run anything.
 */
export interface Condition {
  hasProject?: true;
  hasSession?: true;
  /** A project type the host recognises, such as `android`. */
  projectType?: string;
  /** A host capability that must be available. */
  capability?: string;
}

export interface ViewDeclaration {
  /** `<pluginId>/<name>`; what layouts and preferences persist. */
  id: string;
  title: LocalizedText;
  /** `svg` is a path inside the package; `sfSymbol` is for the Mac. */
  icon?: { svg?: string; sfSymbol?: string };
  locations: ViewLocation[];
  defaultLocation?: ViewLocation;
  clients: PluginClient[];
  instances: ViewInstancing;
  when?: Condition;
  /** Drawn by the host from a declaration instead of plugin code; clients dispatch on `kind`. `provider` is one of this plugin's task providers. */
  renderer?: DeclarativeViewRenderer;
  /** Client capabilities required to draw this view, e.g. renderer.form or bridge.sessions.list. */
  requires?: string[];
}

/** Actions are commands of this plugin; the server remains authoritative for context and arguments. */
export interface DeclarativeViewAction {
  id: string;
  title: LocalizedText;
  command: string;
  args?: Record<string, string | number | boolean>;
}
export interface DeclarativeListItem {
  id: string;
  title: LocalizedText;
  description?: LocalizedText;
  command?: string;
  args?: Record<string, string | number | boolean>;
}
export type DeclarativeViewRenderer =
  | { kind: 'tasks'; provider: string }
  | { kind: 'list'; provider?: never; items: DeclarativeListItem[] }
  | { kind: 'form'; provider?: never; command: string; fields?: TaskParamField[]; submit?: LocalizedText }
  | { kind: 'detail'; provider?: never; fields: Array<{ label: LocalizedText; value: LocalizedText }>; actions?: DeclarativeViewAction[] };

/** What context a command needs; the server checks it again when the command runs. Absent means `project`. */
export const COMMAND_SCOPES = ['global', 'project', 'session'] as const;
export type CommandScope = typeof COMMAND_SCOPES[number];

export interface CommandDeclaration {
  /** `<pluginId>/<name>`; the run route is `POST /api/integrations/<pluginId>/commands/<name>`. */
  id: string;
  title: LocalizedText;
  /** Visibility only: it never authorises running the command, which the server re-checks. */
  when?: Condition;
  /** A default binding, such as `Mod+Shift+K`; it never overrides a host or user binding. */
  keybinding?: string;
  scope?: CommandScope;
  /** The arguments the command takes, validated by the server before it runs; may be empty. */
  params?: TaskParamField[];
}

/** The body of `POST /api/integrations/:id/commands/:name`. The same `requestId` with the same body within 10 minutes returns the same result and runs the command once. */
export interface CommandRunRequest {
  requestId: string;
  projectId?: string;
  sessionId?: string;
  args?: Record<string, string | number | boolean>;
  /** The `fingerprint` of a plan the user approved after a 409 `TASK_CONFIRM_REQUIRED` from a task the command starts: post again, with a fresh `requestId`, to run it. */
  confirm?: string;
}

/** What a plugin command answers (not the shell `CommandResult`); a client acts on `kind`. */
export type PluginCommandResult =
  | { kind: 'done'; message?: LocalizedText }
  /** Open a sidebar view by id, a session, or the preview of a file (`path` is project-relative). */
  | { kind: 'open'; view?: string; sessionId?: string; path?: string }
  /** A task the command started through the task service: open its view and select it. */
  | { kind: 'task'; taskId: string };

/** A provider of project tasks (docs/TASKS.md); the code behind it is `Contributions.taskProviders`. */
export interface TaskProviderDeclaration {
  /** `<pluginId>/<name>`. */
  id: string;
  title: LocalizedText;
  /** What a view's `when.projectType` is matched against for a project this provider recognises. */
  projectType?: string;
}

/**
 * An Agent a plugin provides (docs/design/plugin-system.md §5.1), listed while the plugin is off. The id
 * is the persisted backend id: a built-in id for the official `riffet` plugins (Cursor keeps `cursor`),
 * otherwise `<pluginId>` or `<pluginId>.<name>` (`isAgentOfPlugin`). The code behind it is
 * `Contributions.agentBackends`. A client names and draws an Agent from this entry, so a conversation of
 * an Agent whose plugin is off or gone keeps its name and mark.
 */
export interface AgentBackendDeclaration {
  id: string;
  title: LocalizedText;
  /**
   * `svg` is a package path to a small SVG, served at `AGENT_ICON_ROUTE(id)`; `sfSymbol` is for the Mac.
   * A built-in id keeps its generated mark (`gen:marks`) and a client falls back to a generic glyph.
   */
  icon?: ViewDeclaration['icon'];
}

/** Where a client reads the declared `icon.svg` of an Agent, whether or not its plugin is on. */
export const AGENT_ICON_ROUTE = (agentId: string): string => `/api/agent-icons/${encodeURIComponent(agentId)}`;

export interface PluginDeclarations {
  /** Discovery metadata remains visible while the provider is disabled; it grants no capability. */
  modelSources?: Array<{ id: string; title: LocalizedText; protocols?: string[]; backends?: Array<'claude' | 'codex'>; defaultEndpoint?: string; overridable?: Array<'apiEndpoint' | 'apiKey'>; loginAction?: string; hint?: { text: string; command?: string } }>;
  sharePublisher?: { title: LocalizedText };
  actions?: Array<{ id: string; label: string; kind: 'run' | 'device-flow' }>;
  views?: ViewDeclaration[];
  commands?: CommandDeclaration[];
  agentBackends?: AgentBackendDeclaration[];
  tasks?: TaskProviderDeclaration[];
  appearance?: AppearanceDeclarations;
  /** Generated avatar styles for 个人资料 (docs/OWNER.md「随机头像」). `id` is a contribution id; `needsName` styles draw the owner's name and are offered only when there is one. */
  avatarStyles?: Array<{ id: string; title: LocalizedText; credit?: string; needsName?: boolean }>;
  /** Tool groups an Agent can be given through Riffet MCP (docs/BROWSER.md §2). `id` is a contribution id and the `ToolGroupId` a conversation keeps in `toolGroups`. */
  agentTools?: AgentToolsDeclaration[];
  /** Per-session WebSockets at `PLUGIN_CHANNEL_ROUTE(pluginId, name)`, for a plugin's own live views. */
  channels?: Array<{ id: string; scope: 'session' }>;
  /** The plugin's own page in its details (`plugin-page.ts`), built while it is on; `title` names its tab, 设置 when absent. */
  page?: { title?: LocalizedText };
}

export interface AgentToolsDeclaration {
  /** `<pluginId>/<name>`. */
  id: string;
  title: LocalizedText;
  description?: LocalizedText;
  /** Every tool of the group is named `<prefix><name>`, e.g. `browser_open`; lowercase, ends with `_`. */
  toolPrefix: string;
  icon?: ViewDeclaration['icon'];
}

/** Where a client opens a plugin's declared channel `<pluginId>/<name>`; the session goes in `?sessionId=`. */
export const PLUGIN_CHANNEL_ROUTE = (pluginId: string, name: string): string => `/api/integrations/${encodeURIComponent(pluginId)}/channels/${encodeURIComponent(name)}`;

export interface PluginRequirement { id: string; optional?: boolean }

/** `<vendor>.<name>`, lowercase: the plugin id, also its key in `plugins.json`. */
export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*$/;
const CONTRIBUTION_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/** Whether `id` is `<pluginId>/<name>`: contribution ids carry the owning plugin's namespace, so two plugins cannot collide. */
export function isContributionOf(pluginId: string, id: unknown): id is string {
  if (typeof id !== 'string' || !id.startsWith(`${pluginId}/`)) return false;
  return CONTRIBUTION_NAME.test(id.slice(pluginId.length + 1));
}
