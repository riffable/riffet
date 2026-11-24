import type { Contributions, DeviceFlow, Plugin, PluginHost, PluginManifest } from '@riffet/plugin-api';
import type { PluginDescriptor, PluginEnablement, PluginLogEntry, PluginStatus } from '../../../../packages/contracts/src/index.js';
import type { PluginActivationState } from '../../../../packages/contracts/src/plugin-management.js';
import { AppError } from '../errors.js';
import type { PackageStore } from '../plugins-host/packages.js';
import type { CallGuard } from './call-guard.js';
import { declaredIds } from './declarations.js';
import type { Flows } from './flows.js';
import type { PluginLogs } from './logs.js';
import type { Restarts } from './restarts.js';
import type { PluginStore } from './store.js';

export type Source = NonNullable<PluginDescriptor['source']>;
/** One activation: what `activate` opened, ended as a whole. */
export interface Activation {
  generation: number;
  controller: AbortController;
  /** Registered through `scope.onDispose`, run last first. */
  disposers: Array<() => void | Promise<void>>;
  ended: boolean;
  contributions?: Contributions;
  /** Set when the package's process failed before this activation was committed. */
  failed?: string;
  /** The last answer of `status()`, and the call still out: a list read never starts a second one. */
  statusLast?: PluginStatus;
  statusCall?: Promise<PluginStatus>;
  /** Timeouts in a row of calls through the guard (see `through`), and until when calls are refused because of them. */
  timeouts: number;
  openUntil: number;
  /** The `note` this activation put on its entry while calls are refused. */
  notice?: string;
}
export interface Entry {
  plugin: Plugin;
  host: PluginHost;
  source: Source;
  /** The real path of a development package's directory, or of the selected version of an installed one. */
  root?: string;
  /** The version an installed package runs. */
  version?: string;
  /** Explicit local-operator trust, separate from the installed source and package claims. */
  trusted?: boolean;
  /** The web entry of a development or installed package (`webEntry` on the descriptor). */
  web?: WebEntry;
  /** The server entry, which the files route never serves. */
  server?: string;
  /** Why this host can never run the package's server entry (`hostApi`); it keeps its declarations. */
  blocked?: string;
  /** A version switch that was undone, shown until the next one. */
  note?: string;
  /** What this host left out of the manifest as unknown to it (`loadableManifest`), once per load: shown in diagnostics; `ids` cannot be run. */
  skipped?: { notes: string[]; ids: string[] };
  /** Committed: lookups serve its contributions. */
  active?: Activation;
  /** Its enablement has been decided at least once, whichever way. */
  evaluated?: boolean;
  allowed?: boolean;
  demand?: string;
  demanding?: Promise<void>;
  runtime?: Omit<PluginActivationState, 'events' | 'state'>;
  /** Awaiting commit. `update()` aborts it, since the choice may have changed meanwhile. */
  starting?: Activation;
  generation: number;
  /** Why it is off although it should be on, or why detection could not answer. */
  problem?: string;
  /** What the last teardown could not release. It stays until a teardown ends cleanly or the plugin is on again. */
  cleanup?: string;
  /**
   * A turn-off or a switch to `version` that waits for the plugin's running tasks (design §8). The activation stays up and refuses
   * new tasks and commands; it goes ahead when the last task ends, or at once when an update says `force`.
   */
  waiting?: { kind: 'off' } | { kind: 'switch'; version: string };
  /** Set while an update with `force` evaluates, so a turn-off does not wait for tasks. */
  force?: boolean;
  /** Automatic restarts of an isolated package whose process died while it was live. */
  restarts?: { attempts: number; timer?: NodeJS.Timeout; stable?: NodeJS.Timeout };
  /** Lifecycle changes of this entry, one at a time. */
  tail: Promise<void>;
}
export type WebEntry = NonNullable<PluginDescriptor['webEntry']>;
export interface Flow { pluginId: string; flow: DeviceFlow; polling: boolean; /** The activation that started it: a flow outlives neither it nor the integration being on. */ activation: Activation }
export interface Rejected { id: string; vendor: string; name: string; reason: string; source?: Source; root?: string }
/** A package version read from disk, ready to be an entry. */
export interface LoadedVersion { manifest: PluginManifest; root: string; version: string; integrity: string; granted: string[]; trusted?: boolean; server?: string; web?: WebEntry }

export const ENABLEMENTS: readonly PluginEnablement[] = ['auto', 'on', 'off'];
/** What one disposer gets: the wait ends then, though code that never yields cannot be interrupted. */
export const DISPOSE_TIMEOUT_MS = 5_000;
/** How long `activate` may take before the activation ends as a problem, so one that never resolves cannot hold the plugin's queue. */
export const ACTIVATION_TIMEOUT_MS = 30_000;
/** How long a list read waits for a plugin's `status()`; the last answer it gave stands in after that. */
export const STATUS_TIMEOUT_MS = 2_000;
export const SERVICE_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/;
export const SERVICE_VERSION = /^\d+\.\d+\.\d+$/;
/** How long after the registry is made an Agent that has not been evaluated yet still counts as on its way (`agentBackendPending`): an activation, once begun, is bounded by its own timeout. */
export const START_GRACE_MS = 45_000;
export const MODEL_SOURCE_CLAIM = 'model-source:';
export const TOOL_PREFIX_CLAIM = 'tool-prefix:';

/** What a manifest takes from the shared namespaces at load: contribution ids, model source ids and agent tool prefixes. */
export function claims(manifest: PluginManifest): string[] {
  return [
    ...declaredIds(manifest.contributes),
    ...(manifest.contributes?.modelSources ?? []).map(source => MODEL_SOURCE_CLAIM + source.id),
    ...(manifest.contributes?.agentTools ?? []).map(group => TOOL_PREFIX_CLAIM + group.toolPrefix),
  ];
}

export function claimLabel(claim: string): string {
  return claim.startsWith(MODEL_SOURCE_CLAIM) ? `model source "${claim.slice(MODEL_SOURCE_CLAIM.length)}"`
    : claim.startsWith(TOOL_PREFIX_CLAIM) ? `agent tool prefix "${claim.slice(TOOL_PREFIX_CLAIM.length)}"` : `contribution "${claim}"`;
}

export class Superseded extends Error { constructor() { super('activation superseded'); } }

export function describeError(error: unknown): string { return error instanceof Error && error.message ? error.message : String(error); }

/** Ends the wait after `ms`; the code itself cannot be stopped, only no longer waited for. */
export async function bounded(run: () => void | Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`did not finish within ${ms / 1000}s`)), ms); timer.unref(); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Shared internal state and callbacks connecting `registry.ts` with `descriptors.ts`, `lifecycle.ts`, and `packages.ts`. */
export interface RegistryContext {
  readonly store: PluginStore;
  readonly journal: PluginLogs;
  readonly entries: Map<string, Entry>;
  readonly rejected: Rejected[];
  readonly declared: Map<string, string>;
  readonly guard: CallGuard;
  readonly restarts: Restarts;
  readonly flows: Flows;
  readonly packProblems: Map<string, string>;
  readonly packages: PackageStore;
  readonly stateDir: string;
  readonly activationTimeoutMs: number;
  readonly statusTimeoutMs: number;
  readonly versionInUse: (pluginId: string, version: string) => boolean;
  readonly runningTasks: (pluginId: string) => number;
  readonly serverPorts: () => readonly number[];
  readonly agentBackendProvided: (id: string) => boolean;
  readonly endListeners: Set<(contributions: Contributions | undefined) => void>;
  closed: boolean;
  storeProblem?: string;
  packagesProblem?: string;
  loading(): Promise<void>;
  refresh(): Promise<void>;
  invalidate(): void;
  changed(): void;
  log(entry: Entry, level: PluginLogEntry['level'], phase: string, message: string): void;
  require(id: string): Entry;
  reject(item: Rejected): void;
  admit(plugin: Plugin): { plugin: Plugin; skipped: { notes: string[]; ids: string[] } };
  createHost(manifest: PluginManifest, source: Source, trusted?: boolean): PluginHost;
  register(plugin: Plugin, source: Source, root?: string, extra?: { version?: string; trusted?: boolean; web?: WebEntry; server?: string }): void;
  events(entry: Entry): PluginActivationState['events'];
  isLazy(entry: Entry): boolean;
  permitted(entry: Entry, visited?: Set<string>): boolean;
  active(): Contributions[];
  agentBackends(): Array<{ owner: PluginManifest['id']; backend: NonNullable<Contributions['agentBackends']>[number] }>;
  modelSources(): NonNullable<Contributions['modelSources']>;
  exclusive<T>(change: () => Promise<T>): Promise<T>;
  schedulePrune(ms?: number): void;
  switchVersion(entry: Entry, version: string, force?: boolean): Promise<AppError | undefined>;
}
