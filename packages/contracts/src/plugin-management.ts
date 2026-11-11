// Plugin management descriptors for built-in, development and installed packages
// (docs/PLUGIN_ARCHITECTURE.md). Clients consume these without knowing individual plugins.

import type { InstalledPluginInfo, PluginCompatibility } from './plugin-packages.js';
import type { LocalizedText, PluginDeclarations, PluginRequirement } from './plugins.js';

/** The user's choice. `auto` leaves it to the plugin's default or its detection. */
export type PluginEnablement = 'auto' | 'on' | 'off';

export interface PluginStatus { state: 'ready' | 'attention' | 'unavailable'; message?: string }

export interface PluginLogEntry {
  pluginId: string;
  version?: string;
  generation: number;
  at: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  phase: string;
  message: string;
}

export interface PluginActivationState {
  events: Array<'startup' | 'command' | 'model-source' | 'task' | 'view'>;
  state: 'idle' | 'activating' | 'active' | 'failed';
  trigger?: string;
  durationMs?: number;
  activatedAt?: string;
  failedPhase?: string;
}

/** A setting. A secret's value never leaves the server; `set` says whether one is saved. */
export interface PluginField { key: string; label: string; kind: 'text' | 'secret'; value?: string; set?: boolean }

export interface PluginAction { id: string; label: string; kind: 'run' | 'device-flow' }

/**
 * What a model gateway speaks. Open: a plugin may name a protocol of its own, and a client keeps one it does not know.
 * A source serves protocols and an Agent consumes them (`NativeBackendCapabilities.consumesProtocols`); the two are matched
 * by intersection, never by Agent id.
 */
export type GatewayProtocol = 'anthropic-messages' | 'openai-responses' | 'openai-chat' | (string & {});

export interface ModelSourceDescriptor {
  id: string;
  label: string;
  /** The compat form of `protocols` for clients that match by backend: `anthropic-messages` is `claude`, `openai-responses` is `codex`. */
  backends: Array<'claude' | 'codex'>;
  /** Absent from a server that predates it; match by `backends` then. */
  protocols?: GatewayProtocol[];
  defaultEndpoint?: string;
  /** The profile fields that may override the source's own; a client hides the others. */
  overridable: Array<'apiEndpoint' | 'apiKey'>;
  /** The id of the providing plugin's action that signs in to this source. */
  loginAction?: string;
  /** Shown with the source in a profile editor, such as how to sign in outside Riffet. */
  hint?: { text: string; command?: string };
}

export interface PluginDescriptor {
  id: string;
  vendor: string;
  name: string;
  enabled: boolean;
  /** Runtime code is loaded; an enabled plugin may wait for its first activation event. */
  active?: boolean;
  activation?: PluginActivationState;
  execution?: { location: 'server'; mode: 'in-process' | 'isolated' | 'resources'; platform: string };
  enablement: PluginEnablement;
  status?: PluginStatus;
  settings: PluginField[];
  /** Opaque revision for optimistic configuration edits; never derived from secret values. */
  configRevision?: string;
  /** Empty while the plugin is off. */
  actions: PluginAction[];
  /** What the enabled plugin provides now; static declarations are in `declared`. */
  contributes: { modelSources?: ModelSourceDescriptor[]; sharePublisher?: { label: string; audience: string } };
  /** Package version. */
  version?: string;
  /** Clients pick a language with a fallback chain and fall back to `name`. */
  title?: LocalizedText;
  description?: LocalizedText;
  source?: 'builtin' | 'development' | 'installed';
  /** A persisted local development link can be removed independently of its source files. */
  developmentLinked?: boolean;
  /** Canonical directory identifying this development package, including a rejected one. */
  developmentPath?: string;
  /** From the manifest, so it is present while the plugin is off. */
  declared?: PluginDeclarations;
  requires?: PluginRequirement[];
  /** A package that was not loaded (invalid, or its id is taken): listed with its reason, without controls. */
  rejected?: true;
  /** Per entry, whether the package's `hostApi` ranges match this host; a client skips an entry whose `ok` is false. */
  compatibility?: PluginCompatibility;
  /** Installed packages only: versions, grants and data. */
  installed?: InstalledPluginInfo;
  /** A development or installed package's web entry: a script bundled to run on its own, at `GET /api/integrations/:id/files/<path>`, drawn in an isolated frame (docs/PLUGIN_ARCHITECTURE.md "自定义视图"). `integrity` is `sha256-<hex>` of the file. */
  webEntry?: { path: string; integrity?: string };
  /** What the package holds: the selected version's grant for an installed package, what the manifest asks for a development one (trusted, so no grant). Absent for built-in plugins. */
  capabilities?: string[];
  /**
   * Set while turning it off, or switching to `version`, waits for its running tasks: it stays on and refuses new tasks and
   * commands (409), and `status` says so. `PATCH` with `force: true` proceeds at once; the tasks keep running either way.
   */
  stopping?: { running: number; version?: string };
}

/** The HTTP field stays `integrations` for existing clients; only source names changed. */
export interface PluginsResponse { integrations: PluginDescriptor[]; recovery?: boolean }
/** `null` clears the choice, leaving new shares to the first enabled publisher. */
export interface PluginDiagnostic { id: string; label: string; status: 'ok' | 'warn' | 'fail'; detail: string; fix?: string }
export interface PluginDefaultsUpdate { defaultSharePublisher?: string | null }
/** `null` clears a setting. `force` completes a turn-off or version switch that is waiting for running tasks (alone, or together with `enablement`); the tasks are not stopped. */
export interface PluginUpdate { configRevision?: string; enablement?: PluginEnablement; settings?: Record<string, string | null>; force?: boolean }

/**
 * One step of a plugin action. `show-code` starts a device-code login: show the code, then
 * poll `flows/:flowId/poll` every `intervalMs` (longer after `slow_down`) until another step.
 */
export type ActionStep =
  | { kind: 'done' }
  | { kind: 'show-code'; flowId: string; userCode?: string; verificationUri: string; qrSvg?: string; intervalMs: number; expiresAt: number }
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'failed'; message: string }
  | { kind: 'hint'; text: string; command?: string };
