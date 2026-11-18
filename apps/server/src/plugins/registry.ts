import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type ActivationScope, type Contributions, type DoctorCheck, type Plugin, type PluginHost, type PluginManifest, type AgentToolGroup,
  type AvatarStyleProvider, type PluginChannelHandler, type CommandHandler, type ModelSourceProvider, type NativeRuntimeHook, type SharePublisher, type SpeechRecognizer, type TaskProvider,
} from '@riffet/plugin-api';
import { protocolBackends, sourceProtocols } from '@riffet/plugin-api/kit';
import { AGENT_PROTOCOL_VERSION, type AgentBackend } from '@riffet/plugin-api/experimental/agent';
import type { ActionStep, AppearanceDeclarations, PluginPageExtraKind, PluginPageResponse, PluginReadmeResponse, CommandDeclaration, PluginDeclarations, InstalledPluginInfo, PluginDescriptor, PluginEnablement, PluginStatus, ModelSourceDescriptor, NativeBackendId, Task, TaskParams } from '../../../../packages/contracts/src/index.js';
import { PLUGIN_ID } from '../../../../packages/contracts/src/plugins.js';
// The core's only import of the built-in list (`pnpm check:plugins`), so a build can swap it here.
import { builtinPlugins } from '../../../../plugins/index.js';
import { AppError } from '../errors.js';
import { MODEL_SOURCE_ID } from '../settings/index.js';
import { apiVersionProblem, checkManifest, declaredIds, grantExecutables, grantModelSources, knownDeclarations, loadableManifest } from './declarations.js';
import { developmentDirectories, developmentFile, fileIntegrity, loadDevelopmentPackage, packagePlugin, readPackage } from './development.js';
import { createPluginHost } from './host.js';
import { builtinPackageRoot } from './package-root.js';
import { CallGuard, FAIL_FAST_MS } from './call-guard.js';
import { describeError, bounded, type Activation, type Entry, type Source, type WebEntry } from './entry.js';
import { Flows } from './flows.js';
import { Pages } from './pages.js';
import { RESTART_DELAYS_MS, RESTART_STABLE_MS, Restarts } from './restarts.js';
import { PluginStore, type PluginItem, type PluginItemPatch } from './store.js';
import { PluginLogs } from './logs.js';
import type { PluginActivationState, PluginLogEntry } from '../../../../packages/contracts/src/plugin-management.js';
import { compatibility, referencedFiles, requestedCapabilities, serverIncompatibility } from '../plugins-host/compat.js';
import { PackageStore, checkExpected, type PackageInput } from '../plugins-host/packages.js';
import { checkMarketSource } from '../plugins-host/market.js';
import { remotePlugin } from '../plugins-host/remote.js';
import { satisfies } from '../plugins-host/semver.js';

/** The built-in list without one integration: what a build that leaves it out starts from, and what a test of that build passes as `plugins`. */
export const builtinPluginsWithout = (id: string): Plugin[] => builtinPlugins.filter(plugin => plugin.manifest.id !== id);
/** The built-in list with one plugin changed (made slow or failing, say), for a test of the server around it. */
export const builtinPluginsChanging = (id: string, change: (plugin: Plugin) => Plugin): Plugin[] => builtinPlugins.map(plugin => plugin.manifest.id === id ? change(plugin) : plugin);

/** Whether this build ships a built-in plugin under `id`, which an installed package may not take (also checked by `riffet plugin install` when no server runs). */
export const isBuiltinPlugin = (id: string): boolean => builtinPlugins.some(plugin => plugin.manifest.id === id);

const ENABLEMENTS: readonly PluginEnablement[] = ['auto', 'on', 'off'];
/** What one disposer gets: the wait ends then, though code that never yields cannot be interrupted. */
const DISPOSE_TIMEOUT_MS = 5_000;
/** How long `activate` may take before the activation ends as a problem, so one that never resolves cannot hold the plugin's queue. */
const ACTIVATION_TIMEOUT_MS = 30_000;
/** How long a list read waits for a plugin's `status()`; the last answer it gave stands in after that. */
const STATUS_TIMEOUT_MS = 2_000;
const SERVICE_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const SERVICE_VERSION = /^\d+\.\d+\.\d+$/;
/** How long after the registry is made an Agent that has not been evaluated yet still counts as on its way (`agentBackendPending`): an activation, once begun, is bounded by its own timeout. */
const START_GRACE_MS = 45_000;

/** Where a package ends up when a version is installed or removed: the list is what clients re-read. */
export interface InstallRequest {
  input: PackageInput; source: string; grant: unknown; trusted?: boolean;
  /** From the plugin index: the package must be this release with exactly this content. */
  expected?: { id: string; version: string; integrity: string };
}

interface Rejected { id: string; vendor: string; name: string; reason: string; source?: Source; root?: string }
/** A package version read from disk, ready to be an entry. */
interface LoadedVersion { manifest: PluginManifest; root: string; version: string; integrity: string; granted: string[]; trusted?: boolean; server?: string; web?: WebEntry }
export interface OwnedRuntimeHook { owner: PluginManifest['id']; hook: NativeRuntimeHook }
/** An Agent backend of an enabled integration. */
export interface OwnedAgentBackend { owner: PluginManifest['id']; backend: AgentBackend }
export interface OwnedSharePublisher { owner: PluginManifest['id']; publisher: SharePublisher }
/** `version` and `projectType` come from the manifest, so the host can record what a task started under. `source` is where the code runs from: an installed package's plans are confirmed before they run. */
export interface OwnedTaskProvider { owner: PluginManifest['id']; version?: string; projectType?: string; source?: Source; provider: TaskProvider }
/** A generated avatar style of an enabled plugin: its declaration and the provider that draws it. */
/** `signal` is the activation's: it aborts when the plugin is turned off. */
export interface OwnedAgentTools { owner: PluginManifest['id']; declaration: NonNullable<PluginDeclarations['agentTools']>[number]; group: AgentToolGroup; signal: AbortSignal }
export interface OwnedAvatarStyle { owner: PluginManifest['id']; declaration: NonNullable<PluginDeclarations['avatarStyles']>[number]; provider: AvatarStyleProvider }
/** A command ready to run: the declaration, the handler, and the signal that aborts with the activation. */
export interface ResolvedCommand { declaration: CommandDeclaration; handler: CommandHandler; signal: AbortSignal }

export interface PluginRegistryOptions {
  stateDir: string;
  /** Defaults to the built-in list. */
  plugins?: readonly Plugin[];
  invalidateModelCatalogs?: () => void;
  /** Model source ids saved in profiles, for `host.modelSourceInUse`. */
  savedModelSources?: () => Iterable<string>;
  /** The profiles the user keeps for an Agent, `config` included, for `host.agentProfiles`. */
  agentProfiles?: PluginHost['agentProfiles'];
  /** Whether the core itself already provides this Agent backend, so a plugin cannot take it over. */
  agentBackendProvided?: (id: string) => boolean;
  /** Directories of trusted development packages. Defaults to `RIFFET_DEV_PLUGINS`. */
  developmentPackages?: readonly string[];
  /** Whether something still uses the files of an installed version (a running task started under it), so removing it waits. */
  versionInUse?: (pluginId: string, version: string) => boolean;
  /** How many tasks of a plugin are open. Turning it off, or switching its version, waits for them (design §8); without this nothing waits. */
  runningTasks?: (pluginId: string) => number;
  /** Starts a task for `host.tasks.start` of a built-in or development plugin. */
  startTask?: (input: { requestId: string; projectId: string; providerId: string; actionId: string; params?: TaskParams; confirm?: string }) => Promise<Task>;
  /** Defaults to 30 s. */
  activationTimeoutMs?: number;
  /** Defaults to 2 s. */
  statusTimeoutMs?: number;
  /** Replaces every limit in `CALL_LIMITS_MS`. */
  callTimeoutMs?: number;
  /** How long calls are refused after three timeouts in a row. Defaults to 60 s. */
  failFastMs?: number;
  /** Pauses before each automatic restart of an isolated package. Defaults to 2 s, 10 s, 60 s. */
  restartDelaysMs?: readonly number[];
  /** How long a restarted process stays up before its attempts are forgotten. Defaults to 10 minutes. */
  restartStableMs?: number;
  /** The loopback ports the server answers on, closed to installed packages even when they may use the network. */
  serverPorts?: () => readonly number[];
  /** `host.sessions` of an in-process plugin that declares agent tools or channels. */
  sessions?: NonNullable<PluginHost['sessions']>;
  /** `host.models.complete` of an in-process plugin, given its own declared model uses. */
  completeModel?: Parameters<typeof createPluginHost>[1]['completeModel'];
}

const MODEL_SOURCE_CLAIM = 'model-source:';
const TOOL_PREFIX_CLAIM = 'tool-prefix:';
/** What a manifest takes from the shared namespaces at load: contribution ids, model source ids and agent tool prefixes. */
function claims(manifest: PluginManifest): string[] {
  return [
    ...declaredIds(manifest.contributes),
    ...(manifest.contributes?.modelSources ?? []).map(source => MODEL_SOURCE_CLAIM + source.id),
    ...(manifest.contributes?.agentTools ?? []).map(group => TOOL_PREFIX_CLAIM + group.toolPrefix),
  ];
}
function claimLabel(claim: string): string {
  return claim.startsWith(MODEL_SOURCE_CLAIM) ? `model source "${claim.slice(MODEL_SOURCE_CLAIM.length)}"`
    : claim.startsWith(TOOL_PREFIX_CLAIM) ? `agent tool prefix "${claim.slice(TOOL_PREFIX_CLAIM.length)}"` : `contribution "${claim}"`;
}
class Superseded extends Error { constructor() { super('activation superseded'); } }

/**
 * Plugins and what the enabled ones contribute.
 *
 * Enablement, in order: one that is not loaded is absent; an explicit `on` or `off` in
 * plugins.json is final; `auto` takes the manifest's default, asking `detect()` when that is
 * `auto` too. A required plugin that is not on keeps this one off. Detection runs on start,
 * after `update()` and on `refresh()`, never when the list is read, so `descriptors()` and the
 * lookups answer from the last evaluation and stay synchronous over the committed state.
 *
 * Each turn-on is one activation with its own generation, scope and disposers. Its contributions are
 * staged until `activate` resolves and are committed only if the activation is still wanted; a
 * turn-off stops the lookups first, then ends the scope. Lifecycle changes of one plugin run
 * one at a time.
 */
export class PluginRegistry {
  readonly store: PluginStore;
  private readonly journal: PluginLogs;
  private readonly entries = new Map<string, Entry>();
  private readonly rejected: Rejected[] = [];
  /** Contribution id -> the plugin that declares it. */
  private readonly declared = new Map<string, string>();
  private readonly guard: CallGuard;
  private readonly restarts: Restarts;
  private readonly flows: Flows;
  private readonly pages: Pages;
  private readonly invalidate: () => void;
  private readonly agentBackendProvided: (id: string) => boolean;
  private readonly changeListeners = new Set<() => void>();
  private readonly hostOptions: Parameters<typeof createPluginHost>[1];
  /** Development and installed packages are loaded once, before anything evaluates. */
  private readonly loading: Promise<void>;
  readonly packages: PackageStore;
  private readonly activationTimeoutMs: number;
  private readonly versionInUse: (pluginId: string, version: string) => boolean;
  private readonly runningTasks: (pluginId: string) => number;
  private readonly statusTimeoutMs: number;
  /** The loopback ports this server answers on. */
  readonly serverPorts: () => readonly number[];
  /** Installs, version switches and removals, one at a time. */
  private management: Promise<unknown> = Promise.resolve();
  private storeProblem?: string;
  private packagesProblem?: string;
  private pruneTimer?: NodeJS.Timeout;
  private refreshing?: Promise<void>;
  private closed = false;
  private readonly startedAt = Date.now();
  /** The first pass over every plugin has finished. */
  private passed = false;
  private readonly endListeners = new Set<(contributions: Contributions | undefined) => void>();

  constructor(options: PluginRegistryOptions) {
    this.store = new PluginStore(options.stateDir);
    this.journal = new PluginLogs(options.stateDir, id => {
      try { const item = this.store.item(id); return [...Object.values(item.settings), ...Object.values(item.secrets)]; } catch { return []; }
    });
    this.invalidate = options.invalidateModelCatalogs ?? (() => undefined);
    this.agentBackendProvided = options.agentBackendProvided ?? (() => false);
    this.hostOptions = { stateDir: options.stateDir, store: this.store, invalidateModelCatalogs: this.invalidate, savedModelSources: options.savedModelSources ?? (() => []), ...(options.agentProfiles ? { agentProfiles: options.agentProfiles } : {}), ...(options.startTask ? { startTask: options.startTask } : {}), ...(options.sessions ? { sessions: options.sessions } : {}), ...(options.completeModel ? { completeModel: options.completeModel } : {}) };
    this.runningTasks = options.runningTasks ?? (() => 0);
    this.statusTimeoutMs = options.statusTimeoutMs ?? STATUS_TIMEOUT_MS;
    for (const plugin of options.plugins ?? builtinPlugins) this.register(plugin, 'builtin');
    this.rejectCycles();
    this.packages = new PackageStore(options.stateDir);
    this.activationTimeoutMs = options.activationTimeoutMs ?? ACTIVATION_TIMEOUT_MS;
    this.restarts = new Restarts({
      closed: () => this.closed, recovery: () => this.store.recovery(), evaluateAll: ids => this.evaluateAll(ids), dependents: id => this.dependents(id),
      log: (entry, level, phase, message) => this.log(entry, level, phase, message), entry: id => this.entries.get(id),
      restartDelaysMs: options.restartDelaysMs ?? RESTART_DELAYS_MS, restartStableMs: options.restartStableMs ?? RESTART_STABLE_MS,
    });
    this.guard = new CallGuard({
      log: (entry, level, phase, message) => this.log(entry, level, phase, message), changed: () => this.changed(),
      callTimeoutMs: options.callTimeoutMs, failFastMs: options.failFastMs ?? FAIL_FAST_MS,
    });
    this.flows = new Flows({
      require: id => this.require(id), entry: id => this.entries.get(id), events: entry => this.events(entry),
      ensureContribution: (kind, contributionId) => this.ensureContribution(kind, contributionId), ensureEntry: (entry, trigger) => this.ensureEntry(entry, trigger),
      guarded: (entry, run, failureCode) => this.guarded(entry, run, failureCode),
    });
    this.pages = new Pages({
      loading: () => this.loading, require: id => this.require(id), events: entry => this.events(entry), ensureEntry: (entry, trigger) => this.ensureEntry(entry, trigger),
      guarded: (entry, run, failureCode) => this.guarded(entry, run, failureCode), update: (id, input) => this.update(id, input),
      redact: (id, text) => this.journal.redact(id, text), item: id => this.store.item(id),
    });
    this.versionInUse = options.versionInUse ?? (() => false);
    this.serverPorts = options.serverPorts ?? (() => []);
    this.loading = this.loadPackages(options.developmentPackages ?? developmentDirectories(), options.developmentPackages === undefined);
  }

  /** Re-evaluates every plugin's enablement. Concurrent callers share one pass. */
  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try { await this.loading; await this.evaluateAll([...this.entries.keys()]); this.passed = true; }
      finally { this.refreshing = undefined; }
    })();
    return this.refreshing;
  }

  /**
   * A refresh that returns after `waitMs` at most. Each plugin takes effect as soon as its own
   * detection answers, so a slow detector (a CLI's `--help`) finishes in the background instead of
   * holding the server's start past what `riffet start` waits for.
   */
  async refreshWithin(waitMs: number): Promise<void> {
    const pass = this.refresh().catch((error: unknown) => console.warn('[riffet] plugin refresh failed:', describeError(error)));
    await Promise.race([pass, sleep(waitMs, undefined, { ref: false })]);
  }

  /** Turns every plugin off, ending its scope. The server's shutdown. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.pruneTimer);
    for (const entry of this.entries.values()) this.restarts.clearRestarts(entry);
    await this.loading;
    // Dependents go before what they depend on, whichever entry's turn comes first.
    await Promise.all([...this.entries.values()].map(entry => {
      entry.starting?.controller.abort();
      return this.serial(entry, async () => {
        await this.deactivateDependents(entry, false, false);
        if (entry.active) await this.deactivate(entry, false);
      }).catch(() => undefined);
    }));
  }

  /** The validated declaration's identity, including when its owner is disabled; never runs plugin code. */
  modelSourceRole(id: string): ModelSourceProvider['role'] {
    const owner = this.declared.get(MODEL_SOURCE_CLAIM + id);
    const declaration = owner ? this.entries.get(owner)?.plugin.manifest.contributes?.modelSources?.find(source => source.id === id) : undefined;
    return declaration ? declaration.role ?? 'source' : undefined;
  }

  modelSources(): ModelSourceProvider[] {
    return [...this.entries.values()].flatMap(entry => {
      if (entry.active) return entry.active.contributions?.modelSources ?? [];
      if (!this.isLazy(entry) || !this.permitted(entry)) return [];
      return (entry.plugin.manifest.contributes?.modelSources ?? []).map(declared => ({
        id: declared.id, label: declared.title.en ?? Object.values(declared.title)[0] ?? declared.id,
        ...(declared.role ? { role: declared.role } : {}),
        protocols: declared.protocols,
        backends: declared.backends,
        ...(declared.defaultEndpoint ? { defaultEndpoint: declared.defaultEndpoint } : {}),
        ...(declared.overridable ? { overridable: declared.overridable } : {}),
        ...(declared.loginAction ? { loginAction: declared.loginAction } : {}),
        ...(declared.hint ? { hint: declared.hint } : {}),
        resolve: () => ({ reason: `Model source ${declared.id} is awaiting activation` }),
        prepare: async () => { await this.ensureContribution('model-source', declared.id); },
        catalog: async (backend, overrides, protocol) => {
          await this.ensureContribution('model-source', declared.id);
          const provider = entry.active?.contributions?.modelSources?.find(source => source.id === declared.id);
          if (!provider) throw new AppError('PLUGIN_CONTRIBUTION_UNAVAILABLE', 'This model source is unavailable', 409);
          await provider.prepare?.(overrides);
          return provider.catalog(backend, overrides, protocol);
        },
      }));
    });
  }

  private events(entry: Entry): PluginActivationState['events'] { return entry.plugin.manifest.activation ?? ['startup']; }
  private isLazy(entry: Entry): boolean { return !this.events(entry).includes('startup'); }

  /** Policy only: no imports or probes while painting a static catalog. */
  private permitted(entry: Entry, visited = new Set<string>()): boolean {
    const { manifest } = entry.plugin;
    if (this.closed || entry.blocked || visited.has(manifest.id)) return false;
    visited.add(manifest.id);
    try {
      if (entry.source !== 'builtin' && this.store.recovery()) return false;
      const enabled = this.store.enablement(manifest.id);
      if (enabled === 'off' || (enabled === 'auto' && manifest.defaultEnabled === false)) return false;
      return !(manifest.requires ?? []).some(requirement => !requirement.optional && (!this.entries.get(requirement.id) || !this.permitted(this.entries.get(requirement.id)!, new Set(visited))));
    } catch { return false; }
  }

  async ensureContribution(kind: 'command' | 'model-source' | 'task' | 'view', contributionId: string): Promise<void> {
    await this.loading;
    const entry = [...this.entries.values()].find(item => {
      const declared = item.plugin.manifest.contributes;
      return (kind === 'command' ? declared?.commands : kind === 'model-source' ? declared?.modelSources : kind === 'task' ? declared?.tasks : declared?.views)?.some(value => value.id === contributionId)
        || kind === 'model-source' && item.active?.contributions?.modelSources?.some(source => source.id === contributionId);
    });
    if (!entry) throw new AppError('PLUGIN_CONTRIBUTION_NOT_FOUND', 'Plugin contribution not found', 404);
    if (!entry.active && !this.events(entry).includes(kind) && !this.events(entry).includes('startup')) throw new AppError('PLUGIN_ACTIVATION_UNSUPPORTED', `This plugin does not activate on ${kind}`, 409);
    await this.ensureEntry(entry, `${kind}:${contributionId}`);
  }

  private async ensureEntry(entry: Entry, trigger: string): Promise<void> {
    if (!this.permitted(entry)) throw new AppError('INTEGRATION_DISABLED', 'This plugin is off or paused', 409);
    if (entry.active) return;
    if (entry.demanding) return entry.demanding;
    const pending = this.demandEntry(entry, trigger);
    entry.demanding = pending;
    try { await pending; } finally { if (entry.demanding === pending) entry.demanding = undefined; }
  }

  private async demandEntry(entry: Entry, trigger: string): Promise<void> {
    for (const requirement of entry.plugin.manifest.requires ?? []) {
      const dependency = this.entries.get(requirement.id);
      if (dependency && (!requirement.optional || this.permitted(dependency))) await this.ensureEntry(dependency, `dependency:${entry.plugin.manifest.id}`);
    }
    const previous = entry.source === 'installed' ? this.packages.record(entry.plugin.manifest.id)?.lastActivated : undefined;
    const previousData = previous && previous !== entry.version ? await this.packages.dataVersion(entry.plugin.manifest.id) : undefined;
    await this.serial(entry, async () => {
      if (!this.permitted(entry)) throw new AppError('INTEGRATION_DISABLED', 'This plugin is off or paused', 409);
      if (!entry.active) { entry.demand = trigger; await this.evaluate(entry); }
    });
    if (!entry.active && previous && previous !== entry.version && this.permitted(entry)) {
      const failedVersion = entry.version;
      const failure = entry.problem ?? 'Activation did not complete';
      await this.exclusive(async () => {
        // A concurrent activation may already have recovered the same plugin.
        if (entry.active) return;
        await this.packages.rollbackData(entry.plugin.manifest.id, previousData);
        const error = await this.switchVersion(entry, previous, true);
        if (!error && entry.active) {
          entry.note = `version ${failedVersion} could not start (${failure}); still using ${previous}`;
          this.log(entry, 'warn', 'rollback', entry.note);
          this.changed();
        }
      });
    }
    if (!entry.active) throw new AppError('PLUGIN_ACTIVATION_FAILED', entry.problem ?? 'This plugin is unavailable', 409);
  }

  async activateView(id: string, input: unknown): Promise<PluginDescriptor> {
    await this.loading;
    const entry = this.require(id);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('INVALID_INPUT', 'Expected an activation event');
    const event = input as Record<string, unknown>;
    if (event.kind !== 'view' || typeof event.id !== 'string' || !entry.plugin.manifest.contributes?.views?.some(view => view.id === event.id)) throw new AppError('INVALID_INPUT', 'Expected a declared view activation');
    await this.ensureContribution('view', event.id);
    return this.describe(entry);
  }

  async activateTaskProviders(): Promise<void> {
    await this.loading;
    await Promise.all([...this.entries.values()].filter(entry => this.permitted(entry) && this.events(entry).includes('task') && entry.plugin.manifest.contributes?.tasks?.length).map(entry => this.ensureEntry(entry, 'task:project').catch(() => undefined)));
  }

  // ── The plugin's page and README (docs/PLUGIN_ARCHITECTURE.md「插件页」) ──────

  page(id: string, locale: string | undefined, kinds?: ReadonlySet<PluginPageExtraKind>): Promise<PluginPageResponse> { return this.pages.page(id, locale, kinds); }

  changePage(id: string, input: unknown, kinds?: ReadonlySet<PluginPageExtraKind>): Promise<PluginPageResponse> { return this.pages.changePage(id, input, kinds); }

  readme(id: string, locale: string | undefined): Promise<PluginReadmeResponse> { return this.pages.readme(id, locale); }


  async logs(id: string): Promise<PluginLogEntry[]> { await this.loading; this.require(id); return this.journal.read(id); }

  private log(entry: Entry, level: PluginLogEntry['level'], phase: string, message: string): void {
    this.journal.append({ pluginId: entry.plugin.manifest.id, ...(entry.plugin.manifest.version ? { version: entry.plugin.manifest.version } : {}), generation: entry.starting?.generation ?? entry.active?.generation ?? entry.generation, level, phase, message });
  }

  private async guarded<T>(entry: Entry, run: () => Promise<T>, failureCode = 'INTEGRATION_ACTION_FAILED'): Promise<T> {
    try { return await run(); }
    catch (error) {
      this.log(entry, 'error', 'runtime', error instanceof Error ? error.stack ?? error.message : String(error));
      const redact = (value: unknown, depth = 0): unknown => {
        if (typeof value === 'string') return this.journal.redact(entry.plugin.manifest.id, value);
        if (depth > 8) return '[truncated]';
        if (Array.isArray(value)) return value.slice(0, 1000).map(item => redact(item, depth + 1));
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 1000).map(([key, item]) => [key, redact(item, depth + 1)]));
        return value;
      };
      const message = this.journal.redact(entry.plugin.manifest.id, error instanceof AppError ? error.message : describeError(error));
      const params = error instanceof AppError
        ? (redact(error.params) as AppError['params']) ?? (error.statusCode >= 500 && error.code === 'COMMAND_FAILED' ? { message } : undefined)
        : failureCode === 'COMMAND_FAILED' ? { message } : undefined;
      throw error instanceof AppError
        ? new AppError(error.code, message, error.statusCode, redact(error.details), params)
        : new AppError(failureCode, message, 502, undefined, params);
    }
  }

  /** Each enabled plugin's publisher under its id, in `plugins/index.ts` order: what a share records as its publisher. */
  sharePublishers(): OwnedSharePublisher[] {
    return [...this.entries.values()].flatMap(entry => {
      const publisher = entry.active?.contributions?.sharePublisher;
      return publisher ? [{ owner: entry.plugin.manifest.id, publisher }] : [];
    });
  }
  /** The recognizer of plugin `pluginId` while it is on, with the signal of the activation that gave it (docs/VOICE.md §3). */
  speechRecognizer(pluginId: string): { recognizer: SpeechRecognizer; signal: AbortSignal } | undefined {
    const entry = this.entries.get(pluginId);
    const recognizer = entry && !entry.waiting ? entry.active?.contributions?.speechRecognizer : undefined;
    return recognizer && entry?.active ? { recognizer, signal: entry.active.controller.signal } : undefined;
  }
  /** Whether plugin `pluginId` is in this build and declares a recognizer, on or off. */
  declaresSpeechRecognizer(pluginId: string): boolean { return Boolean(this.entries.get(pluginId)?.plugin.manifest.contributes?.speechRecognizer); }
  /** The enabled publisher of plugin `owner`: what an existing share must use, whatever the default is. */
  sharePublisher(owner: string): OwnedSharePublisher | undefined { return this.sharePublishers().find(item => item.owner === owner); }
  /** For a new share: the user's choice while it is enabled, else the first enabled publisher. */
  defaultSharePublisher(): OwnedSharePublisher | undefined {
    let chosen: string | undefined;
    try { chosen = this.store.defaultSharePublisher(); } catch { /* nothing is enabled while the file is unreadable */ }
    const publishers = this.sharePublishers();
    return publishers.find(item => item.owner === chosen) ?? publishers[0];
  }
  setDefaultSharePublisher(id: unknown): void {
    if (id !== null && typeof id !== 'string') throw new AppError('INVALID_INTEGRATION_UPDATE', 'defaultSharePublisher must be a plugin id or null');
    if (id !== null) this.require(id);
    this.store.setDefaultSharePublisher(id);
  }
  /** Each enabled plugin's hook for the backend, under its id: what a persisted attachment names to be recovered. */
  runtimeHooks(backendId: NativeBackendId): OwnedRuntimeHook[] {
    return [...this.entries.values()].flatMap(entry => {
      const hook = entry.active?.contributions?.runtimeHooks?.find(item => item.backendId === backendId);
      return hook ? [{ owner: entry.plugin.manifest.id, hook }] : [];
    });
  }

  /** The enabled plugins' appearance declarations, each with the directory its asset paths are relative to. */
  appearanceSources(): Array<{ id: string; appearance: AppearanceDeclarations; root: string }> {
    return [...this.entries.values()].flatMap(entry => {
      const { id, contributes } = entry.plugin.manifest;
      const root = entry.root ?? (entry.source === 'builtin' ? builtinPackageRoot(id) : undefined);
      return entry.active && contributes?.appearance && root ? [{ id, appearance: contributes.appearance, root }] : [];
    });
  }

  /**
   * The appearance declarations of an enabled installed plugin's other versions that are still on disk: the asset addresses a client
   * holds from before an upgrade keep serving until their version is removed.
   */
  async retainedAppearanceSources(pluginId: string): Promise<Array<{ id: string; appearance: AppearanceDeclarations; root: string }>> {
    const entry = this.entries.get(pluginId);
    const record = entry?.active && entry.source === 'installed' ? this.packages.record(pluginId) : undefined;
    const kept: Array<{ id: string; appearance: AppearanceDeclarations; root: string }> = [];
    for (const { version } of record?.versions ?? []) {
      if (version === entry?.version) continue;
      const read = await readPackage(this.packages.versionDirectory(pluginId, version)).catch(() => undefined);
      if (read && !('reason' in read) && read.manifest.contributes?.appearance) kept.push({ id: pluginId, appearance: read.manifest.contributes.appearance, root: read.root });
    }
    return kept;
  }

  /** The `icon.svg` of every Agent a loaded plugin declares, enabled or not, with the directory its path is relative to. */
  agentIconSources(): Array<{ agentId: string; svg: string; root: string }> {
    return [...this.entries.values()].flatMap(entry => {
      const { id, contributes } = entry.plugin.manifest;
      const root = entry.root ?? (entry.source === 'builtin' ? builtinPackageRoot(id) : undefined);
      return root ? (contributes?.agentBackends ?? []).flatMap(agent => agent.icon?.svg ? [{ agentId: agent.id, svg: agent.icon.svg, root }] : []) : [];
    });
  }

  /** The Agent backends of the enabled plugins, in `plugins/index.ts` order. */
  agentBackends(): OwnedAgentBackend[] {
    return [...this.entries.values()].flatMap(entry => (entry.active?.contributions?.agentBackends ?? []).map(backend => ({ owner: entry.plugin.manifest.id, backend })));
  }

  /** Every Agent backend a loaded plugin declares, enabled or not, with why a disabled one is unavailable. */
  declaredAgentBackends(): Array<{ id: string; owner: PluginManifest['id']; enabled: boolean; reason?: string }> {
    return [...this.entries.values()].flatMap(entry => (entry.plugin.manifest.contributes?.agentBackends ?? []).map(declared => ({
      id: declared.id, owner: entry.plugin.manifest.id, enabled: Boolean(entry.active),
      ...(entry.active ? {} : { reason: entry.problem ?? `plugin ${entry.plugin.manifest.id} is off` }),
    })));
  }

  /** Called after a plugin's contributions were committed or withdrawn, before its disposers run. A listener must not throw. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  /** Called when a turned-off activation has been released, disposers included, with what it contributed: nothing of it may be used after this. A listener must not throw. */
  onEnded(listener: (contributions: Contributions | undefined) => void): () => void {
    this.endListeners.add(listener);
    return () => { this.endListeners.delete(listener); };
  }

  /**
   * Whether an Agent a plugin may yet provide is on its way: the plugin that declares it is being started, or has not
   * been evaluated at all yet (an id nothing loaded declares counts the same until the first pass over every plugin
   * has finished, since a package may still be loading). Work queued for it waits instead of failing as unavailable. The wait
   * ends with the activation (bounded by its timeout) and, before evaluation, with the start-up grace.
   */
  agentBackendPending(id: string): boolean {
    if (this.closed) return false;
    const graceful = Date.now() - this.startedAt < START_GRACE_MS;
    const entry = [...this.entries.values()].find(item => item.plugin.manifest.contributes?.agentBackends?.some(declared => declared.id === id));
    if (!entry) return !this.passed && graceful;
    return !entry.active && (Boolean(entry.starting) || (!entry.evaluated && graceful));
  }

  /** The avatar styles of the enabled plugins: declared in the manifest and provided by the committed activation, in `plugins/index.ts` order. */
  avatarStyles(): OwnedAvatarStyle[] {
    return [...this.entries.values()].filter(entry => !entry.waiting).flatMap(entry => {
      const styles = entry.active?.contributions?.avatarStyles;
      return (entry.plugin.manifest.contributes?.avatarStyles ?? []).flatMap(declaration => {
        const provider = styles && Object.hasOwn(styles, declaration.id) ? styles[declaration.id] : undefined;
        return provider ? [{ owner: entry.plugin.manifest.id, declaration, provider }] : [];
      });
    });
  }

  /** The agent tool groups of the enabled plugins: declared in the manifest and provided by the committed activation. */
  agentToolGroups(): OwnedAgentTools[] {
    return [...this.entries.values()].filter(entry => !entry.waiting).flatMap(entry => {
      const groups = entry.active?.contributions?.agentTools;
      return (entry.plugin.manifest.contributes?.agentTools ?? []).flatMap(declaration => {
        const group = groups && Object.hasOwn(groups, declaration.id) ? groups[declaration.id] : undefined;
        return group && entry.active ? [{ owner: entry.plugin.manifest.id, declaration, group, signal: entry.active.controller.signal }] : [];
      });
    });
  }

  /** The declared tool groups of every plugin, on or off, so a selected group of a plugin that is off is known as such. */
  declaredAgentTools(): Array<{ owner: PluginManifest['id']; declaration: NonNullable<PluginDeclarations['agentTools']>[number] }> {
    return [...this.entries.values()].flatMap(entry => (entry.plugin.manifest.contributes?.agentTools ?? []).map(declaration => ({ owner: entry.plugin.manifest.id, declaration })));
  }

  /** The handler of an enabled plugin's declared channel `<pluginId>/<name>`, with the signal of the activation that gave it. */
  channel(pluginId: string, name: string): { handler: PluginChannelHandler; signal: AbortSignal } | undefined {
    const entry = this.entries.get(pluginId);
    const id = `${pluginId}/${name}`;
    if (!entry || entry.waiting || !entry.active || !entry.plugin.manifest.contributes?.channels?.some(declared => declared.id === id)) return undefined;
    const channels = entry.active.contributions?.channels;
    const handler = channels && Object.hasOwn(channels, id) ? channels[id] : undefined;
    return handler ? { handler, signal: entry.active.controller.signal } : undefined;
  }

  /**
   * Each enabled plugin's task providers. A disabled one has none, so it can start no task, and neither has one that is
   * turning off after its running tasks (`stopping`); tasks already started are the host's and keep running.
   */
  taskProviders(): OwnedTaskProvider[] {
    return [...this.entries.values()].filter(entry => !entry.waiting).flatMap(entry => this.ownedProviders(entry));
  }

  private ownedProviders(entry: Entry): OwnedTaskProvider[] {
    return (entry.active?.contributions?.taskProviders ?? []).map(provider => {
      const { manifest } = entry.plugin;
      const projectType = manifest.contributes?.tasks?.find(declared => declared.id === provider.id)?.projectType;
      return { owner: manifest.id, provider, source: entry.source, ...(manifest.version ? { version: manifest.version } : {}), ...(projectType ? { projectType } : {}) };
    });
  }

  /**
   * The provider that started a task, to read its log: the one of `pluginId` that is still up, even while it waits for its tasks to
   * end, and only when it is the `version` the task started under (`unversioned` for a built-in without one). Otherwise `undefined`.
   */
  taskProviderFor(pluginId: string, providerId: string, version: string): OwnedTaskProvider | undefined {
    const entry = this.entries.get(pluginId);
    return entry ? this.ownedProviders(entry).find(owned => owned.provider.id === providerId && (owned.version ?? 'unversioned') === version) : undefined;
  }

  /** Whether the plugin is turning off, or switching version, after its running tasks: it accepts no new task or command meanwhile. */
  isStopping(pluginId: string): boolean {
    const entry = this.entries.get(pluginId);
    return Boolean(entry?.active && entry.waiting);
  }

  /** A task ended: a turn-off or version switch that waited for the plugin's tasks goes ahead once none is left. */
  tasksChanged(): void {
    if (this.closed) return;
    for (const entry of this.entries.values()) {
      const { waiting } = entry;
      const id = entry.plugin.manifest.id;
      if (!waiting || this.runningTasks(id) > 0) continue;
      const done = waiting.kind === 'off'
        ? this.evaluateAll([id, ...this.dependents(id)])
        : this.exclusive(async () => { if (entry.waiting === waiting) await this.switchVersion(entry, waiting.version); });
      void done.catch((error: unknown) => console.warn(`[riffet] plugin ${id} could not finish waiting for its tasks: ${describeError(error)}`));
    }
  }

  /** The command `commandId` of plugin `pluginId`, ready to run, or the 404 or 409 that says why not (design §4.3). */
  command(pluginId: string, commandId: string): ResolvedCommand {
    const entry = this.entries.get(pluginId);
    const unknown = () => new AppError('COMMAND_NOT_FOUND', 'Unknown command', 404);
    if (!entry) throw unknown();
    const unavailable = (reason: string) => new AppError('COMMAND_UNAVAILABLE', `${commandId} is unavailable: ${reason}`, 409, { reason });
    if (!entry.active) throw unavailable(entry.problem ?? 'its plugin is off');
    if (entry.waiting) throw unavailable(`its plugin is turning off after ${this.runningTasks(pluginId)} running task(s)`);
    const declaration = entry.plugin.manifest.contributes?.commands?.find(declared => declared.id === commandId);
    const commands = entry.active.contributions?.commands;
    const handler = declaration && commands && Object.hasOwn(commands, commandId) ? commands[commandId] : undefined;
    if (!declaration || !handler) throw unknown();
    return { declaration, handler: { run: context => this.guarded(entry, () => handler.run(context), 'COMMAND_FAILED') }, signal: entry.active.controller.signal };
  }

  /** `host.services.get` of `consumerId`: the object of another plugin's service, see `PluginHost.services`. */
  private serviceOf(consumerId: string, pluginId: string, name: string, range: string): unknown {
    const consumer = this.entries.get(consumerId);
    if (!consumer?.plugin.manifest.requires?.some(item => item.id === pluginId)) throw new AppError('PLUGIN_SERVICE_NOT_REQUIRED', `${consumerId} must list ${pluginId} in requires to use its services`, 403);
    const provider = this.entries.get(pluginId);
    // Isolated package processes cannot share service objects with the server, on either side.
    if ((consumer.source === 'installed' && !consumer.trusted) || !provider?.active || (provider.source === 'installed' && !provider.trusted)) return undefined;
    const services = provider.active.contributions?.services;
    const service = services && Object.hasOwn(services, name) ? services[name] : undefined;
    return service && satisfies(service.version, range) ? service : undefined;
  }

  /** Recovery retains each plugin's requested enablement; turning it off restores those choices. */
  async setRecovery(enabled: boolean): Promise<void> {
    await this.exclusive(async () => { this.store.setRecovery(enabled); await this.refresh(); this.changed(); });
  }

  async reload(id: string): Promise<PluginDescriptor> {
    return this.exclusive(() => this.reloadEntry(id));
  }

  /** Called under the management lock, also by an idempotent development link. */
  private async reloadEntry(id: string): Promise<PluginDescriptor> {
    await this.loading;
    const entry = this.require(id);
    const development = entry.source === 'development' && entry.root ? await loadDevelopmentPackage(entry.root, { cacheDir: join(this.hostOptions.stateDir, 'plugin-cache') }) : undefined;
    if (development) {
      if ('reason' in development) throw new AppError('PLUGIN_PACKAGE_INVALID', development.reason, 422);
      if (development.plugin.manifest.id !== id) throw new AppError('PLUGIN_PACKAGE_INVALID', 'A development reload cannot change plugin identity', 422);
      const invalid = this.invalidManifest(development.plugin.manifest, id);
      if (invalid) throw new AppError('PLUGIN_PACKAGE_INVALID', invalid, 422);
      if (this.wouldCycle(id, development.plugin.manifest.requires)) throw new AppError('PLUGIN_DEPENDENCY_CYCLE', 'Its requirements would make a dependency cycle', 409);
    }
    if ([id, ...this.dependents(id)].some(pluginId => this.runningTasks(pluginId))) throw new AppError('PLUGIN_TASKS_RUNNING', 'Wait for running tasks before reloading this plugin', 409);
    await this.serial(entry, async () => {
      entry.starting?.controller.abort();
      await this.deactivateDependents(entry, true, true);
      if (entry.active) await this.deactivate(entry);
      if (development && !('reason' in development)) {
        for (const [declared, owner] of this.declared) if (owner === id) this.declared.delete(declared);
        const admitted = this.admit(development.plugin);
        for (const declared of claims(admitted.plugin.manifest)) this.declared.set(declared, id);
        entry.plugin = admitted.plugin;
        entry.skipped = admitted.skipped;
        entry.host = this.createHost(admitted.plugin.manifest, 'development');
        entry.server = development.entries.server;
        entry.web = development.entries.web ? { path: development.entries.web, integrity: await fileIntegrity(development.root, development.entries.web) } : undefined;
        entry.blocked = serverIncompatibility(development.plugin.manifest);
        entry.problem = undefined;
      }
    });
    this.log(entry, 'info', 'reload', 'Plugin reloaded from current package files');
    await this.evaluateAll([id, ...this.dependents(id)]);
    return this.describe(entry);
  }

  /** A local operator's explicit trust decision: link a built package without installing a version. */
  linkDevelopment(directory: string): Promise<PluginDescriptor> {
    return this.exclusive(async () => {
      await this.loading;
      if (this.closed) throw new AppError('SERVER_CLOSING', 'The server is shutting down', 503);
      const loaded = await loadDevelopmentPackage(directory, { cacheDir: join(this.hostOptions.stateDir, 'plugin-cache') });
      if ('reason' in loaded) throw new AppError('PLUGIN_PACKAGE_INVALID', loaded.reason, 422);
      const id = String(loaded.plugin.manifest.id);
      const existing = this.entries.get(id);
      const registered = this.store.developmentPackages();
      if (this.packages.record(id)
        || (existing && (existing.source !== 'development' || existing.root !== loaded.root))
        || (registered[id] && registered[id] !== loaded.root)
        || Object.entries(registered).some(([owner, root]) => owner !== id && root === loaded.root)
        || [...this.entries].some(([owner, entry]) => owner !== id && entry.source === 'development' && entry.root === loaded.root)) {
        throw new AppError('PLUGIN_ID_TAKEN', `${id} already belongs to another plugin or development directory`, 409);
      }
      const invalid = this.invalidManifest(loaded.plugin.manifest, id);
      if (invalid) throw new AppError('PLUGIN_PACKAGE_INVALID', invalid, 422);
      if (this.wouldCycle(id, loaded.plugin.manifest.requires)) throw new AppError('PLUGIN_DEPENDENCY_CYCLE', 'Its requirements would make a dependency cycle', 409);
      if (existing) {
        const descriptor = await this.reloadEntry(id);
        this.store.setDevelopmentPackage(id, loaded.root);
        return descriptor;
      }
      this.register(loaded.plugin, 'development', loaded.root, { ...(loaded.entries.web ? { web: { path: loaded.entries.web } } : {}), ...(loaded.entries.server ? { server: loaded.entries.server } : {}) });
      const entry = this.require(id);
      try {
        await this.evaluateAll([id, ...this.dependents(id)]);
        if (entry.runtime?.failedPhase) throw new AppError('PLUGIN_ACTIVATION_FAILED', entry.problem ?? 'The development plugin could not start', 409);
        this.store.setDevelopmentPackage(id, loaded.root);
      } catch (error) {
        await this.removeDevelopmentEntry(entry);
        throw error;
      }
      this.rejected.splice(0, this.rejected.length, ...this.rejected.filter(item => !(item.id === id && item.source === 'development')));
      this.log(entry, 'info', 'reload', 'Development package linked');
      this.changed();
      return this.describe(entry);
    });
  }

  /** Unlinking retains the directory, data, settings and secrets. Environment-only packages stay managed by their environment. */
  unlinkDevelopment(id: string): Promise<PluginDescriptor[]> {
    return this.exclusive(async () => {
      await this.loading;
      const root = this.store.developmentPackages()[id];
      if (!root) throw new AppError('PLUGIN_DEVELOPMENT_NOT_LINKED', 'This plugin has no saved development link', 404);
      const current = this.entries.get(id);
      const entry = current?.source === 'development' && current.root === root ? current : undefined;
      if (entry && [id, ...this.dependents(id)].some(pluginId => this.runningTasks(pluginId))) throw new AppError('PLUGIN_TASKS_RUNNING', 'Wait for running tasks before unlinking this plugin', 409);
      this.store.setDevelopmentPackage(id, null);
      if (entry) await this.removeDevelopmentEntry(entry);
      this.rejected.splice(0, this.rejected.length, ...this.rejected.filter(item => !(item.id === id && item.source === 'development' && item.root === root)));
      this.changed();
      return this.descriptors();
    });
  }

  private async removeDevelopmentEntry(entry: Entry): Promise<void> {
    const id = entry.plugin.manifest.id;
    const dependents = this.dependents(id);
    await this.serial(entry, async () => {
      entry.starting?.controller.abort();
      await this.deactivateDependents(entry, true, true);
      if (entry.active) await this.deactivate(entry);
    });
    this.entries.delete(id);
    for (const [declared, owner] of this.declared) if (owner === id) this.declared.delete(declared);
    await this.evaluateAll(dependents);
    this.invalidate();
    this.changed();
  }

  /** The last evaluation: nothing is detected here. */
  async descriptors(): Promise<PluginDescriptor[]> {
    await this.loading;
    const loaded = await Promise.all([...this.entries.values()].map(entry => this.describe(entry)));
    const rejected = await Promise.all(this.rejected.map(async (item): Promise<PluginDescriptor> => {
      const installed = item.source === 'installed' ? await this.installedInfo(item.id) : undefined;
      return {
        id: item.id, vendor: item.vendor, name: item.name, enabled: false, enablement: 'auto', rejected: true,
        status: { state: 'unavailable', message: item.reason }, settings: [], actions: [], contributes: {},
        ...(item.source ? { source: item.source } : {}),
        ...(item.source === 'development' && this.developmentLinked(item.id, item.root) ? { developmentLinked: true } : {}),
        ...(item.source === 'development' && item.root ? { developmentPath: item.root } : {}),
        ...(installed ? { installed } : {}),
      };
    }));
    return [...loaded, ...rejected];
  }

  /** Read the committed workbench inventory without asking plugins for their status or opening their files. */
  async workbenchSettingFields(id: string, offset: number, limit: number) {
    await this.loading;
    const entry = this.entries.get(id);
    if (!entry) throw new AppError('PLUGIN_NOT_FOUND', 'There is no installed plugin with this ID',404);
    const fields = entry.plugin.manifest.settings ?? [];
    const page = fields.slice(offset, offset + limit).map(({key,label,kind}) => ({key,label:label.slice(0,160),kind}));
    return { pluginId:id, section:id, fields:page, total:fields.length, ...(offset + page.length < fields.length ? {nextOffset:offset + page.length} : {}) };
  }

  async workbenchInventory() {
    await this.loading;
    const plugins = [...this.entries.values()].map(entry => {
      const { manifest } = entry.plugin;
      const id: string = manifest.id;
      let enablement: PluginEnablement | 'unknown' = 'unknown';
      try { enablement = this.store.enablement(id); } catch { /* an unreadable store has no known choice */ }
      const active = Boolean(entry.active);
      const available = this.available(entry);
      const dependency = entry.problem && entry.allowed
        ? (manifest.requires ?? []).find(requirement => !requirement.optional && !this.entries.get(requirement.id)?.active)
        : undefined;
      return {
        id, name: manifest.name, source: entry.source, enablement, active, enabled: available,
        labels: Object.values(manifest.title ?? {}),
        version: entry.version ?? manifest.version,
        activation: entry.starting ? 'activating' : active ? 'active' : entry.problem ? 'failed' : 'idle',
        reason: entry.waiting ? 'waiting_for_tasks' : enablement === 'unknown' ? 'configuration_unavailable' : entry.blocked ? 'unsupported_host'
          : entry.starting ? 'activating' : dependency ? 'dependency_unavailable' : entry.problem ? 'activation_failed'
            : active ? null : available ? 'not_activated' : entry.evaluated || enablement === 'off' ? 'disabled' : 'not_evaluated',
        activatedAt: entry.runtime?.activatedAt,
        health: entry.active?.statusLast?.state,
        toolGroups: (manifest.contributes?.agentTools ?? []).map(({ id }) => id),
      };
    });
    const ids = new Set<string>(plugins.map(plugin => plugin.id));
    for (const item of this.rejected) {
      if (!PLUGIN_ID.test(item.id) || ids.has(item.id) || !item.source) continue;
      ids.add(item.id);
      plugins.push({
        id: item.id, name: item.name || item.id, source: item.source, enablement: 'unknown',
        labels: [], version: undefined, active: false, enabled: false, activation: 'failed',
        reason: 'package_rejected', activatedAt: undefined, health: undefined, toolGroups: [],
      });
    }
    return plugins;
  }

  async update(id: string, input: unknown): Promise<PluginDescriptor> {
    const entry = this.require(id);
    const { patch, force } = this.patch(entry, input);
    if (patch.enablement || patch.settings || patch.secrets) this.store.update(id, patch);
    await this.loading;
    // An activation still starting was begun on the old choice.
    if (patch.enablement) entry.starting?.controller.abort();
    // `force` does not wait for running tasks: the turn-off goes ahead now (the tasks carry on), and so does a waiting switch.
    if (force) entry.force = true;
    try { await this.evaluateAll([id, ...this.dependents(id)]); }
    finally { entry.force = false; }
    const switching = entry.waiting?.kind === 'switch' ? entry.waiting : undefined;
    if (force && switching) {
      const failure = await this.exclusive(() => this.switchVersion(entry, switching.version, true));
      if (failure) throw failure;
    }
    // A setting a source reads can change its catalog without changing whether it is on.
    if (patch.settings || patch.secrets) { if (entry.active) this.invalidate(); this.changed(); }
    return this.describe(entry);
  }

  /** The file of a development package that `GET /api/integrations/:id/files/*` serves. */
  async developmentFile(id: string, path: string): Promise<{ file: string; type: string }> {
    const entry = this.entries.get(id);
    const found = entry?.root ? await developmentFile(entry.root, path, { ...(entry.web ? { web: entry.web.path } : {}), ...(entry.server ? { server: entry.server } : {}), declared: referencedFiles(entry.plugin.manifest) }) : undefined;
    if (!found) throw new AppError('INTEGRATION_FILE_NOT_FOUND', 'The file does not exist', 404);
    return found;
  }

  // ── Installed packages ─────────────────────────────────────────────────────

  /** One management change at a time: installs, version switches and removals never interleave. */
  private exclusive<T>(change: () => Promise<T>): Promise<T> {
    const done = this.management.then(change);
    this.management = done.then(() => undefined, () => undefined);
    return done;
  }

  /**
   * Installs a package from an archive or a directory. Its content is validated and hashed in a temporary
   * directory first; `grant` must equal the capabilities the package asks for, so an update that asks
   * for more needs a new grant. A built-in or development package's id is never taken. A version already
   * installed with the same content is left as it is; the same version with other content is refused.
   * A new version of an installed plugin becomes the selected one, and is undone if it does not start.
   */
  install(request: InstallRequest): Promise<PluginDescriptor> {
    return this.exclusive(async () => {
      await this.loading;
      if (this.closed) throw new AppError('SERVER_CLOSING', 'The server is shutting down', 503);
      const staged = await this.packages.stage(request.input, { trusted: request.trusted === true });
      try {
        if (request.expected) checkExpected(staged, request.expected);
        const { manifest } = staged;
        const id = String(manifest.id);
        const version = manifest.version!;
        const existing = this.entries.get(id);
        if (existing && existing.source !== 'installed') throw new AppError('PLUGIN_ID_TAKEN', `${id} is ${existing.source === 'builtin' ? 'a built-in plugin' : 'a development package'}; an installed package cannot take its id`, 409);
        checkMarketSource(this.packages.record(id), request.source, id);
        const clash = this.invalidManifest(manifest, id);
        if (clash) throw new AppError('PLUGIN_PACKAGE_INVALID', clash, 422);
        if (this.wouldCycle(id, manifest.requires)) throw new AppError('PLUGIN_DEPENDENCY_CYCLE', 'Its requirements would make a dependency cycle', 409);
        const grant = Array.isArray(request.grant) && request.grant.every(item => typeof item === 'string') ? [...new Set(request.grant as string[])].sort() : undefined;
        if (!grant || grant.length !== staged.capabilities.length || grant.some((item, index) => item !== staged.capabilities[index])) {
          throw new AppError('PLUGIN_GRANT_REQUIRED', `${id} ${version} asks for ${staged.capabilities.length ? staged.capabilities.join(', ') : 'no capabilities'}; grant exactly these to install it`, 409, { id, version, capabilities: staged.capabilities, ...(grantModelSources(manifest.contributes) ? { modelSources: grantModelSources(manifest.contributes) } : {}), ...(grantExecutables(manifest) ? { executables: grantExecutables(manifest) } : {}) });
        }
        const select = !existing;
        // The same version that is recorded but no longer loads (its files were damaged): the upload puts it right.
        if (!existing && !(await this.packages.load(id, version).then(found => !('reason' in found), () => true))) await this.packages.restore(staged).catch(() => false);
        const committed = await this.packages.commit(staged, request.source, select);
        if (committed.status === 'present') {
          if (!existing) await this.adoptInstalled(id);
          return this.describeId(id);
        }
        this.rejected.splice(0, this.rejected.length, ...this.rejected.filter(item => !(item.id === id && item.source === 'installed')));
        if (existing) {
          const result = await this.switchVersion(existing, version);
          if (result) throw result;
          return this.describe(existing);
        }
        await this.adoptInstalled(id, true);
        return this.describeId(id);
      } finally { await this.packages.discard(staged).catch(() => undefined); }
    });
  }

  /** Loads the selected version of an installed plugin that has no entry (new, or rejected before) and evaluates it. */
  private async adoptInstalled(id: string, required = false): Promise<void> {
    const record = this.packages.record(id);
    if (!record || this.entries.has(id)) return;
    const loaded = await this.loadVersion(id, record.selected);
    if ('reason' in loaded) {
      if (required) throw new AppError('PLUGIN_PACKAGE_INVALID', loaded.reason, 422);
      return;
    }
    this.rejected.splice(0, this.rejected.length, ...this.rejected.filter(item => !(item.id === id && item.source === 'installed')));
    this.register(this.installedPlugin(loaded), 'installed', loaded.root, { version: loaded.version, trusted: loaded.trusted, ...(loaded.web ? { web: loaded.web } : {}), ...(loaded.server ? { server: loaded.server } : {}) });
    // What waited on it (`requires <id>`) starts now, not at the next refresh.
    await this.evaluateAll([id, ...this.dependents(id)]);
  }

  /** Makes `version` the one that runs: off, swap, on. If it does not start, the previous one runs again and the failure stays on the row. */
  selectVersion(id: string, version: string): Promise<PluginDescriptor> {
    return this.exclusive(async () => {
      await this.loading;
      const record = this.installedRecord(id);
      if (!record.versions.some(item => item.version === version)) throw new AppError('PLUGIN_VERSION_NOT_FOUND', 'That version is not installed', 404);
      const entry = this.entries.get(id);
      if (entry && entry.source !== 'installed') throw new AppError('PLUGIN_ID_TAKEN', 'Another plugin source owns this id; remove that source before selecting an installed version', 409);
      if (!entry) {
        // The selected version could not be loaded at all: this one is loaded in its place.
        const loaded = await this.loadVersion(id, version);
        if ('reason' in loaded) throw new AppError('PLUGIN_VERSION_INVALID', loaded.reason, 409);
        const problem = this.invalidManifest(loaded.manifest) ?? serverIncompatibility(loaded.manifest);
        if (problem) throw new AppError('PLUGIN_VERSION_INVALID', problem, 409);
        this.rejected.splice(0, this.rejected.length, ...this.rejected.filter(item => !(item.id === id && item.source === 'installed')));
        this.register(this.installedPlugin(loaded), 'installed', loaded.root, { version, trusted: loaded.trusted, ...(loaded.web ? { web: loaded.web } : {}), ...(loaded.server ? { server: loaded.server } : {}) });
        this.packages.select(id, version);
        await this.evaluateAll([id, ...this.dependents(id)]);
        return this.describeId(id);
      }
      if (record.selected === version && entry.version === version) {
        if (entry.waiting?.kind === 'switch') entry.waiting = undefined;
        return this.describe(entry);
      }
      const failure = await this.switchVersion(entry, version);
      if (failure) throw failure;
      return this.describe(entry);
    });
  }

  /**
   * The swap behind `selectVersion` and an update: returns the error to report when the new version did not start. While the
   * plugin has running tasks the switch waits for them instead (`entry.waiting`; no error) unless `force`: its activation stays up
   * for the tasks' diagnostics, and `tasksChanged` runs the switch once none is left.
   */
  private async switchVersion(entry: Entry, version: string, force = false): Promise<AppError | undefined> {
    const id = entry.plugin.manifest.id;
    const loaded = await this.loadVersion(id, version);
    if ('reason' in loaded) return new AppError('PLUGIN_VERSION_INVALID', loaded.reason, 409);
    const problem = this.invalidManifest(loaded.manifest, id) ?? serverIncompatibility(loaded.manifest) ?? (this.wouldCycle(id, loaded.manifest.requires) ? 'its requirements would make a dependency cycle' : undefined);
    if (problem) return new AppError('PLUGIN_VERSION_INVALID', problem, 409);
    let failure: AppError | undefined;
    await this.loading;
    await this.serial(entry, async () => {
      if (!force && entry.active && this.runningTasks(id) > 0) { entry.waiting = { kind: 'switch', version }; return; }
      entry.waiting = undefined;
      const before = { plugin: entry.plugin, host: entry.host, trusted: entry.trusted, root: entry.root, version: entry.version, web: entry.web, server: entry.server, blocked: entry.blocked, active: Boolean(entry.active), demand: entry.demand, declared: [...this.declared].filter(([, owner]) => owner === id).map(([declared]) => declared) };
      const dataBefore = await this.packages.dataVersion(id);
      entry.starting?.controller.abort();
      await this.deactivateDependents(entry, true, true);
      if (entry.active) await this.deactivate(entry);
      this.swap(entry, this.installedPlugin(loaded), loaded);
      if (before.active && !entry.demand) entry.demand = 'version-switch';
      const error = await this.evaluate(entry);
      if (error) {
        if (entry.active) await this.deactivate(entry);
        for (const [declared, owner] of this.declared) if (owner === id) this.declared.delete(declared);
        Object.assign(entry, { plugin: before.plugin, host: before.host, trusted: before.trusted, version: before.version, demand: before.demand });
        if (before.root) entry.root = before.root; else delete entry.root;
        if (before.web) entry.web = before.web; else delete entry.web;
        if (before.server) entry.server = before.server; else delete entry.server;
        if (before.blocked) entry.blocked = before.blocked; else delete entry.blocked;
        for (const declared of before.declared) this.declared.set(declared, id);
        // The new version may already have moved the data to its format (after backing it up): put the backup back, or the previous version could not start on it.
        await this.packages.rollbackData(id, dataBefore);
        const fallback = await this.evaluate(entry);
        const previous = before.version ?? 'the previous version';
        entry.note = fallback
          ? `version ${version} could not start (${error}); ${previous} could not start either (${fallback})`
          : `version ${version} could not start (${error}); still using ${previous}`;
        failure = new AppError('PLUGIN_ACTIVATION_FAILED', entry.note, 409, { version, previous: before.version, reason: error });
      } else {
        entry.note = undefined;
        this.packages.select(id, version);
      }
    });
    await this.evaluateAll(this.dependents(id));
    return failure;
  }

  private swap(entry: Entry, plugin: Plugin, loaded: LoadedVersion): void {
    const id = plugin.manifest.id;
    for (const [declared, owner] of this.declared) if (owner === id) this.declared.delete(declared);
    const admitted = this.admit(plugin);
    for (const declared of claims(admitted.plugin.manifest)) this.declared.set(declared, id);
    const blocked = serverIncompatibility(loaded.manifest);
    entry.plugin = admitted.plugin;
    entry.skipped = admitted.skipped;
    entry.root = loaded.root;
    entry.version = loaded.version;
    entry.trusted = loaded.trusted === true;
    entry.host = this.createHost(admitted.plugin.manifest, 'installed', entry.trusted);
    if (loaded.web) entry.web = loaded.web; else delete entry.web;
    if (loaded.server) entry.server = loaded.server; else delete entry.server;
    if (blocked) entry.blocked = blocked; else delete entry.blocked;
  }

  /**
   * Removes one version's files. The selected version stays while others exist; the last version takes
   * the plugin with it. Data and settings stay. Files something still uses are removed once nothing does.
   */
  uninstallVersion(id: string, version: string): Promise<PluginDescriptor[]> {
    return this.exclusive(async () => {
      await this.loading;
      const record = this.installedRecord(id);
      if (!record.versions.some(item => item.version === version)) throw new AppError('PLUGIN_VERSION_NOT_FOUND', 'That version is not installed', 404);
      const current = this.entries.get(id);
      const entry = current?.source === 'installed' ? current : undefined;
      if (entry && record.selected === version && record.versions.length > 1) throw new AppError('PLUGIN_VERSION_SELECTED', 'Select another version before removing this one', 409);
      const dependents = entry ? this.dependents(id) : [];
      this.packages.forget(id, version);
      if (entry && record.versions.length === 1) {
        await this.serial(entry, async () => {
          entry.starting?.controller.abort();
          await this.deactivateDependents(entry, true, true);
          if (entry.active) await this.deactivate(entry);
        });
        this.entries.delete(id);
        for (const [declared, owner] of this.declared) if (owner === id) this.declared.delete(declared);
      }
      if (record.versions.length === 1) this.rejected.splice(0, this.rejected.length, ...this.rejected.filter(item => !(item.id === id && item.source === 'installed')));
      if (!await this.packages.retire(id, version, this.versionInUse)) this.schedulePrune();
      // A plugin that could not load now runs another version, if there is one.
      if (!entry && record.versions.length > 1) await this.adoptInstalled(id);
      await this.evaluateAll(dependents);
      return this.descriptors();
    });
  }

  /** Removes exactly the external source selected by the operator, retaining sources, configuration and data. */
  uninstall(id: string, options: { source?: 'installed' | 'development'; path?: string; allowDevelopment?: boolean } = {}): Promise<PluginDescriptor[]> {
    return this.exclusive(async () => {
      await this.loading;
      if (options.source !== undefined && options.source !== 'installed' && options.source !== 'development') throw new AppError('INVALID_INPUT', 'source must be installed or development');
      if (options.path !== undefined && (options.source !== 'development' || typeof options.path !== 'string' || !options.path)) throw new AppError('INVALID_INPUT', 'A development path requires source=development');
      const current = this.entries.get(id);
      const record = options.source === 'development' ? undefined : this.packages.record(id);
      const roots = new Set<string>();
      if (current?.source === 'development' && current.root) roots.add(current.root);
      for (const rejected of this.rejected) if (rejected.id === id && rejected.source === 'development' && rejected.root) roots.add(rejected.root);
      const saved = options.source === 'installed' ? undefined : this.store.developmentPackages()[id];
      if (saved) roots.add(saved);
      if (!options.source && (roots.size > 1 || roots.size > 0 && (record || current?.source === 'builtin'))) throw new AppError('PLUGIN_TARGET_AMBIGUOUS', 'Several plugin sources have this id; specify source and the development path', 409);
      const source = options.source ?? (roots.size ? 'development' : 'installed');
      if (source === 'development') {
        if (options.allowDevelopment === false) throw new AppError('PLUGIN_DEVELOPMENT_LOCAL_ONLY', 'Development plugins can only be managed from the server device', 403);
        const root = options.path === undefined ? roots.size === 1 ? [...roots][0] : undefined : resolve(options.path);
        if (!root || !roots.has(root)) throw new AppError(roots.size > 1 && !options.path ? 'PLUGIN_TARGET_AMBIGUOUS' : 'INTEGRATION_NOT_FOUND', 'Choose a known development package directory', roots.size > 1 && !options.path ? 409 : 404);
        const entry = current?.source === 'development' && current.root === root ? current : undefined;
        if (entry && [id, ...this.dependents(id)].some(pluginId => this.runningTasks(pluginId))) throw new AppError('PLUGIN_TASKS_RUNNING', 'Wait for running tasks before uninstalling this plugin', 409);
        // Save discovery removal first: a failed write must leave the live plugin usable.
        this.store.removeDevelopmentPackage(id, root);
        if (entry) await this.removeDevelopmentEntry(entry);
        this.rejected.splice(0, this.rejected.length, ...this.rejected.filter(item => !(item.id === id && item.source === 'development' && item.root === root)));
        this.changed();
        return this.descriptors();
      }
      if (!record) throw new AppError('INTEGRATION_NOT_FOUND', 'No installed package has this id', 404);
      const entry = current?.source === 'installed' ? current : undefined;
      const dependents = entry ? this.dependents(id) : [];
      if (entry && [id, ...dependents].some(pluginId => this.runningTasks(pluginId))) throw new AppError('PLUGIN_TASKS_RUNNING', 'Wait for running tasks before uninstalling this plugin', 409);
      // Commit first, as development removal does: a failed installed.json write has no runtime effects.
      this.packages.forget(id);
      if (entry) {
        await this.serial(entry, async () => {
          entry.starting?.controller.abort();
          await this.deactivateDependents(entry, true, true);
          if (entry.active) await this.deactivate(entry);
        });
        this.entries.delete(id);
        for (const [declared, owner] of this.declared) if (owner === id) this.declared.delete(declared);
      }
      this.rejected.splice(0, this.rejected.length, ...this.rejected.filter(item => !(item.id === id && item.source === 'installed')));
      for (const version of record.versions) if (!await this.packages.retire(id, version.version, this.versionInUse)) this.schedulePrune();
      await this.evaluateAll(dependents);
      this.invalidate(); this.changed();
      return this.descriptors();
    });
  }

  private developmentLinked(id: string, root?: string): boolean {
    try { const saved = this.store.developmentPackages()[id]; return Boolean(saved && (!root || saved === root)); } catch { return false; }
  }

  /** Removes the plugin's data directory and its backups (settings and secrets stay). The plugin is stopped while it goes and starts again if it is on. */
  deleteData(id: string): Promise<PluginDescriptor[]> {
    return this.exclusive(async () => {
      await this.loading;
      if (!PLUGIN_ID.test(id) || id.length > 64) throw new AppError('INTEGRATION_NOT_FOUND', 'Plugin not found', 404);
      const entry = this.entries.get(id);
      if (entry && entry.source !== 'installed') throw new AppError('PLUGIN_DATA_PROTECTED', 'Only an installed package\'s data can be deleted here', 409);
      if (!entry && !(await this.packages.hasData(id))) throw new AppError('INTEGRATION_NOT_FOUND', 'Plugin not found', 404);
      if (entry) {
        await this.serial(entry, async () => {
          entry.starting?.controller.abort();
          await this.deactivateDependents(entry, true, true);
          if (entry.active) await this.deactivate(entry);
          await this.packages.deleteData(id);
        });
        await this.evaluateAll([id, ...this.dependents(id)]);
      } else await this.packages.deleteData(id);
      return this.descriptors();
    });
  }

  private installedRecord(id: string) {
    let record;
    try { record = this.packages.record(id); } catch (error) { throw error instanceof AppError ? error : new AppError('PLUGINS_STATE_CORRUPT', describeError(error), 500); }
    if (!record) throw new AppError('INTEGRATION_NOT_FOUND', 'No installed package has this id', 404);
    return record;
  }

  /** Whether `id` requiring `requires` would close a cycle through the plugins that are loaded. */
  private wouldCycle(id: string, requires: PluginManifest['requires']): boolean {
    const seen = new Set<string>();
    const reaches = (from: string): boolean => {
      if (from === id) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (this.entries.get(from)?.plugin.manifest.requires ?? []).some(item => reaches(item.id));
    };
    return (requires ?? []).some(item => reaches(item.id));
  }

  private async installedInfo(id: string): Promise<InstalledPluginInfo | undefined> {
    let record;
    try { record = this.packages.record(id); } catch { return undefined; }
    if (!record) return undefined;
    const [dataVersion, backups, hasData] = await Promise.all([this.packages.dataVersion(id), this.packages.backups(id), this.packages.hasData(id)]);
    return {
      selected: record.selected, hasData,
      versions: [...record.versions].sort((a, b) => (a.installedAt < b.installedAt ? 1 : -1)).map(item => ({ ...item, selected: item.version === record.selected })),
      ...(dataVersion !== undefined ? { dataVersion } : {}),
      ...(backups.length ? { backups: backups.map(item => item.name) } : {}),
    };
  }

  private async describeId(id: string): Promise<PluginDescriptor> {
    const entry = this.entries.get(id);
    if (entry) return this.describe(entry);
    return (await this.descriptors()).find(item => item.id === id) ?? (() => { throw new AppError('INTEGRATION_NOT_FOUND', 'Plugin not found', 404); })();
  }

  runAction(id: string, actionId: string): Promise<ActionStep> { return this.flows.runAction(id, actionId); }

  pollFlow(id: string, flowId: string): Promise<ActionStep> { return this.flows.pollFlow(id, flowId); }

  /** Explicit per-plugin diagnostics never probe or activate other packages. */
  async diagnostics(id: string): Promise<DoctorCheck[]> {
    await this.loading;
    const rejected = this.rejected.find(item => item.id === id);
    if (!this.entries.has(id) && rejected) return [{ id, label: rejected.name, status: 'fail', detail: rejected.reason }];
    const entry = this.require(id);
    const checks: DoctorCheck[] = [
      ...[entry.problem, entry.cleanup, entry.note, ...(entry.skipped?.notes ?? [])].filter((value): value is string => Boolean(value)).map((detail, index) => ({ id: id + ':' + index, label: entry.plugin.manifest.name, status: 'warn' as const, detail })),
    ];
    checks.push(...this.hookNotes(id));
    const activation = entry.active;
    const run = activation?.contributions?.doctorChecks;
    let ended = false;
    try {
      if (run) await bounded(async () => { const result = await run(); if (!ended && entry.active === activation) checks.push(...result); }, 30_000);
    } catch (error) { checks.push({ id, label: entry.plugin.manifest.name, status: 'fail', detail: describeError(error) }); }
    finally { ended = true; }
    if (!checks.length) checks.push({ id, label: entry.plugin.manifest.name, status: activation ? 'ok' : 'warn', detail: activation ? 'Plugin is active; no additional checks reported.' : 'Plugin is inactive; no runtime checks executed.' });
    return checks;
  }

  /** Notes for a plugin whose runtime hook for a backend is tried after another enabled plugin's. */
  private hookNotes(id: string): DoctorCheck[] {
    const entry = this.entries.get(id);
    const hooked = (item: Entry) => (item.active?.contributions?.runtimeHooks ?? []).map(hook => hook.backendId);
    if (!entry) return [];
    const notes: DoctorCheck[] = [];
    for (const backendId of new Set(hooked(entry))) {
      const first = [...this.entries.values()].find(item => hooked(item).includes(backendId));
      if (first && first !== entry) notes.push({ id: `${id}:hook:${backendId}`, label: entry.plugin.manifest.name, status: 'warn', detail: `runtime hook for ${backendId} is tried after ${first.plugin.manifest.id}` });
    }
    return notes;
  }

  async doctorChecks(): Promise<DoctorCheck[]> {
    await this.refresh();
    const checks: DoctorCheck[] = this.rejected.map(item => ({ id: `integration:${item.id}`, label: `${item.name} (${item.id})`, status: 'warn', detail: `not loaded: ${item.reason}` }));
    if (this.packagesProblem) checks.push({ id: 'integrations:packages', label: 'Installed packages', status: 'warn', detail: this.packagesProblem, fix: `Fix or remove ${this.packages.file}.` });
    if (this.storeProblem) checks.push({ id: 'integrations', label: 'Plugins', status: 'warn', detail: `${this.store.path} is unreadable, so every plugin is off`, fix: `Fix or remove ${this.store.path}.` });
    for (const entry of this.entries.values()) {
      const { manifest } = entry.plugin;
      const label = `${manifest.name} (${manifest.id})`;
      for (const detail of [entry.problem, entry.cleanup, entry.note, ...(entry.skipped?.notes ?? [])]) if (detail) checks.push({ id: `integration:${manifest.id}`, label, status: 'warn', detail });
      for (const note of this.hookNotes(manifest.id)) checks.push({ ...note, id: `integration:${manifest.id}`, label });
      const run = entry.active?.contributions?.doctorChecks;
      if (!run) continue;
      try { for (const check of await run()) checks.push({ ...check, id: `integration:${manifest.id}:${check.id}` }); }
      catch (error) { checks.push({ id: `integration:${manifest.id}`, label, status: 'warn', detail: `checks failed: ${describeError(error)}` }); }
    }
    return checks;
  }

  private active(): Contributions[] {
    return [...this.entries.values()].flatMap(entry => (entry.active?.contributions ? [entry.active.contributions] : []));
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new AppError('INTEGRATION_NOT_FOUND', 'Plugin not found', 404);
    return entry;
  }

  private reject(item: Rejected): void {
    this.rejected.push(item);
    console.warn(`[riffet] plugin ${item.id} not loaded: ${item.reason}`);
  }

  /** The plugin as this host reads it: what its manifest says that this version does not know is left out, so every later reader, the claims and the routes see only the rest. */
  private admit(plugin: Plugin): { plugin: Plugin; skipped: { notes: string[]; ids: string[] } } {
    const { manifest, notes, skipped } = loadableManifest(plugin.manifest);
    return { plugin: manifest === plugin.manifest ? plugin : { ...plugin, manifest }, skipped: { notes, ids: skipped } };
  }

  /** What is wrong with a manifest as a candidate for entry `own` (or a new one), before it is trusted with an id or a contribution. */
  private invalidManifest(manifest: PluginManifest, own?: string): string | undefined {
    const id = String(manifest.id);
    const valid = apiVersionProblem(manifest.apiVersion)
      ?? (!PLUGIN_ID.test(id) || id.length > 64 ? 'invalid id' : checkManifest(manifest, 'load'));
    if (valid) return valid;
    // What this host leaves out of the manifest claims no id.
    const clash = claims(loadableManifest(manifest).manifest).find(declared => this.declared.has(declared) && this.declared.get(declared) !== own);
    return clash ? `${claimLabel(clash)} is already declared by ${this.declared.get(clash)}` : undefined;
  }

  private createHost(manifest: PluginManifest, source: Source, trusted = false): PluginHost {
    const host = createPluginHost(manifest.id, source === 'installed' && !trusted ? { ...this.hostOptions, agentProfiles: undefined, completeModel: undefined, ownTaskProviders: (manifest.contributes?.tasks ?? []).map(declared => declared.id) } : {
      ...this.hostOptions, ownAgentBackends: (manifest.contributes?.agentBackends ?? []).map(declared => declared.id),
      ownTaskProviders: (manifest.contributes?.tasks ?? []).map(declared => declared.id),
      ownsSessionSurfaces: Boolean(manifest.contributes?.agentTools?.length || manifest.contributes?.channels?.length),
      ownModelUses: manifest.contributes?.modelUses ?? [],
      service: (pluginId, name, range) => this.serviceOf(manifest.id, pluginId, name, range),
    });
    host.logger = Object.fromEntries((['debug', 'info', 'warn', 'error'] as const).map(level => [level, (message: string) => {
      const entry = this.entries.get(manifest.id);
      if (entry) this.log(entry, level, 'runtime', String(message));
    }])) as NonNullable<PluginHost['logger']>;
    return host;
  }

  private register(plugin: Plugin, source: Source, root?: string, extra?: { version?: string; trusted?: boolean; web?: WebEntry; server?: string }): void {
    const { manifest } = plugin;
    const id = String(manifest.id);
    const existing = this.entries.get(id);
    const taken = existing ? (existing.source === 'builtin' && source !== 'builtin' ? 'a built-in plugin has this id' : existing.source === 'development' && source === 'installed' ? 'a development package has this id' : 'duplicate id') : undefined;
    const reason = taken ?? this.invalidManifest(manifest);
    if (reason) return this.reject({ id, vendor: String(manifest.vendor), name: String(manifest.name), reason, source, ...(source === 'development' && root ? { root } : {}) });
    const admitted = this.admit(plugin);
    for (const declared of claims(admitted.plugin.manifest)) this.declared.set(declared, id);
    const blocked = serverIncompatibility(manifest);
    this.entries.set(id, {
      plugin: admitted.plugin, skipped: admitted.skipped, source, generation: 0, tail: Promise.resolve(),
      host: this.createHost(admitted.plugin.manifest, source, extra?.trusted),
      ...(extra?.trusted ? { trusted: true } : {}),
      ...(root ? { root } : {}), ...(extra?.version ? { version: extra.version } : {}), ...(extra?.web ? { web: extra.web } : {}), ...(extra?.server ? { server: extra.server } : {}), ...(blocked ? { blocked } : {}),
    });
  }

  /** Development packages are registered after the built-in ones, so a built-in id cannot be taken over; installed ones after both. */
  private async loadPackages(directories: readonly string[], includeSaved = false): Promise<void> {
    let saved: Record<string, string> = {};
    let excluded = new Set<string>();
    try {
      if (includeSaved) saved = this.store.developmentPackages();
      excluded = new Set(this.store.excludedDevelopmentDirectories());
    } catch (error) { this.storeProblem = describeError(error); }
    const seen = new Set<string>();
    const candidates = [...Object.entries(saved).map(([id, directory]) => ({ id, directory })), ...directories.map(directory => ({ directory, id: undefined }))];
    for (const { directory, id } of candidates) {
      let root = resolve(directory);
      try {
        if (excluded.has(resolve(directory))) continue;
        root = await realpath(directory).catch(() => root);
        if (excluded.has(root) || seen.has(root)) continue;
        seen.add(root);
        const loaded = await loadDevelopmentPackage(directory, { cacheDir: join(this.hostOptions.stateDir, 'plugin-cache') });
        if ('reason' in loaded) this.reject({ ...loaded, ...(id ? { id } : {}), source: 'development', root });
        else {
          if (id && loaded.plugin.manifest.id !== id) {
            seen.add(loaded.root);
            this.reject({ id, vendor: String(loaded.plugin.manifest.vendor), name: String(loaded.plugin.manifest.name), reason: 'A saved development directory cannot change plugin identity; unlink it first', source: 'development', root });
          } else {
            this.register(loaded.plugin, 'development', loaded.root, { ...(loaded.entries.web ? { web: { path: loaded.entries.web } } : {}), ...(loaded.entries.server ? { server: loaded.entries.server } : {}) });
          }
        }
      } catch (error) { this.reject({ id: id ?? directory, vendor: '', name: directory, reason: describeError(error), source: 'development', root }); }
    }
    let installed = 0;
    try {
      for (const record of this.packages.records()) {
        installed++;
        const loaded = await this.loadVersion(record.id, record.selected);
        if ('reason' in loaded) this.reject({ id: record.id, vendor: '', name: record.id, reason: loaded.reason, source: 'installed' });
        else this.register(this.installedPlugin(loaded), 'installed', loaded.root, { version: loaded.version, trusted: loaded.trusted, ...(loaded.web ? { web: loaded.web } : {}), ...(loaded.server ? { server: loaded.server } : {}) });
      }
      // Files of versions that were removed while in use, and what an interrupted install left, go once nothing needs them.
      this.schedulePrune(5_000);
    } catch (error) { this.packagesProblem = `${this.packages.file} is unreadable (${describeError(error)}), so no installed package is loaded`; console.warn(`[riffet] ${this.packagesProblem}`); }
    if (candidates.length || installed) this.rejectCycles();
  }

  /** Cleans up after installs and removals, one management change at a time, and again later while something is still waiting on a task. */
  private schedulePrune(ms = 60_000): void {
    if (this.pruneTimer || this.closed) return;
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = undefined;
      void this.exclusive(() => this.packages.prune(this.versionInUse))
        .catch((error: unknown) => console.warn('[riffet] pruning installed packages failed:', describeError(error)))
        .finally(() => { if (this.packages.hasDeferred) this.schedulePrune(); });
    }, ms);
    this.pruneTimer.unref();
  }

  /** The selected files of an installed version, checked against what was installed. */
  private async loadVersion(id: string, version: string): Promise<LoadedVersion | { reason: string }> {
    const loaded = await this.packages.load(id, version);
    if ('reason' in loaded) return loaded;
    // The package's own integrity vouches for every file; the web entry also carries its own digest, so a page can check the script it was handed.
    const web = loaded.entries.web ? { path: loaded.entries.web, ...(await fileIntegrity(loaded.root, loaded.entries.web).then(value => ({ integrity: value }), () => ({}))) } : undefined;
    return { manifest: loaded.manifest, root: loaded.root, version, integrity: loaded.record.integrity, granted: loaded.record.capabilities, ...(loaded.record.trusted ? { trusted: true } : {}), ...(loaded.entries.server ? { server: loaded.entries.server } : {}), ...(web ? { web } : {}) };
  }

  /** Execution trust comes from the operator-approved version record, never its manifest. */
  private installedPlugin(loaded: LoadedVersion): Plugin {
    if (loaded.trusted) return packagePlugin(loaded.root, loaded.manifest, { ...(loaded.server ? { server: loaded.server } : {}) }, loaded.integrity);
    const id = loaded.manifest.id;
    return remotePlugin({
      manifest: loaded.manifest, root: loaded.root, granted: loaded.granted, ...(loaded.server ? { entry: loaded.server } : {}),
      settings: () => { try { return this.store.item(id).settings; } catch { return {}; } },
      secrets: () => { try { return this.store.item(id).secrets; } catch { return {}; } },
      serverPorts: this.serverPorts,
      onFailure: (generation, reason) => this.processFailed(id, generation, reason),
    });
  }

  /** The package's process ended or broke the protocol while its activation was live: the contributions are withdrawn and the reason shown. Management stays usable; the next refresh starts it again. */
  private processFailed(id: string, generation: number, reason: string): void {
    const entry = this.entries.get(id);
    if (!entry || this.closed) return;
    if (entry.starting?.generation !== generation && entry.active?.generation !== generation) return;
    reason = this.journal.redact(id, reason);
    this.log(entry, 'error', 'runtime', reason);
    void this.serial(entry, async () => {
      if (entry.starting?.generation === generation) { entry.starting.failed = reason; return; }
      if (entry.active?.generation !== generation) return;
      entry.problem = reason;
      await this.deactivateDependents(entry, true, true);
      await this.deactivate(entry);
      entry.problem = reason;
      this.restarts.scheduleRestart(entry);
    }).catch((error: unknown) => console.warn(`[riffet] plugin ${id} could not be stopped after its process failed: ${describeError(error)}`));
  }

  /** A cycle has no activation order: every plugin on one is rejected, naming the path. */
  private rejectCycles(): void {
    const cycleFrom = (start: string): string[] | undefined => {
      const walk = (id: string, path: string[]): string[] | undefined => {
        for (const dependency of this.entries.get(id)?.plugin.manifest.requires ?? []) {
          if (dependency.id === start) return [...path, start];
          if (!this.entries.has(dependency.id) || path.includes(dependency.id)) continue;
          const found = walk(dependency.id, [...path, dependency.id]);
          if (found) return found;
        }
        return undefined;
      };
      return walk(start, [start]);
    };
    const cyclic = [...this.entries.keys()].flatMap(id => { const path = cycleFrom(id); return path ? [{ id, path }] : []; });
    for (const { id, path } of cyclic) {
      const { plugin: { manifest }, source } = this.entries.get(id)!;
      this.entries.delete(id);
      for (const [declared, owner] of this.declared) if (owner === id) this.declared.delete(declared);
      this.reject({ id, vendor: String(manifest.vendor), name: String(manifest.name), reason: `dependency cycle: ${path.join(' -> ')}`, source });
    }
  }

  /** The plugins that name `id` among their requirements, directly or through others. */
  private dependents(id: string): string[] {
    const found = new Set<string>();
    const visit = (target: string) => {
      for (const [other, entry] of this.entries) {
        if (found.has(other) || !entry.plugin.manifest.requires?.some(item => item.id === target)) continue;
        found.add(other);
        visit(other);
      }
    };
    visit(id);
    return [...found];
  }

  /** Evaluates `ids`, each after the plugins it requires that are part of the same pass. */
  private evaluateAll(ids: readonly string[]): Promise<unknown> {
    const wanted = new Set(ids.filter(id => this.entries.has(id)));
    const started = new Map<string, Promise<void>>();
    const run = (id: string): Promise<void> => {
      let promise = started.get(id);
      if (!promise) {
        const entry = this.entries.get(id)!;
        started.set(id, promise = (async () => {
          await Promise.all((entry.plugin.manifest.requires ?? []).filter(item => wanted.has(item.id)).map(item => run(item.id)));
          await this.serial(entry, () => this.evaluate(entry));
        })());
      }
      return promise;
    };
    return Promise.all([...wanted].map(run));
  }

  private serial<T>(entry: Entry, change: () => Promise<T>): Promise<T> {
    const done = entry.tail.then(change);
    entry.tail = done.then(() => undefined, () => undefined);
    return done;
  }

  /** Returns why activation failed, when it was tried and did not succeed. */
  private async evaluate(entry: Entry): Promise<string | undefined> {
    try { return await this.decide(entry); }
    finally { entry.evaluated = true; }
  }

  private async decide(entry: Entry): Promise<string | undefined> {
    if (this.closed) return undefined;
    const { manifest } = entry.plugin;
    let enablement: PluginEnablement;
    try { enablement = this.store.enablement(manifest.id); this.storeProblem = undefined; }
    catch (error) {
      // Nothing runs on a guess: an `off` the file can no longer say must not become an `auto` that detects on.
      this.storeProblem = describeError(error);
      return this.settle(entry, false);
    }
    entry.problem = undefined;
    // This host can never run the entry: the declarations stay, the code does not start.
    if (entry.blocked) { entry.problem = entry.blocked; return this.settle(entry, false); }
    if (this.isLazy(entry) && !entry.demand && !entry.active) {
      entry.allowed = this.permitted(entry);
      return undefined;
    }
    let enabled: boolean;
    if (entry.source !== 'builtin' && this.store.recovery()) { entry.problem = 'External plugins are paused by recovery mode'; enabled = false; }
    else if (enablement !== 'auto') enabled = enablement === 'on';
    else if (manifest.defaultEnabled !== 'auto') enabled = manifest.defaultEnabled;
    else {
      const started = Date.now();
      try {
        let detected = false;
        await bounded(async () => { detected = await entry.plugin.detect?.(entry.host) ?? false; }, this.activationTimeoutMs);
        enabled = detected;
        this.log(entry, 'debug', 'detect', `Detection ${enabled ? 'matched' : 'did not match'} in ${Date.now() - started} ms`);
      }
      catch (error) {
        enabled = false; entry.problem = `detection failed: ${this.journal.redact(manifest.id, describeError(error))}`;
        entry.runtime = { trigger: entry.demand ?? 'startup', failedPhase: 'detect', durationMs: Date.now() - started };
        this.log(entry, 'error', 'detect', error instanceof Error ? error.stack ?? error.message : String(error));
      }
    }
    if (enabled) {
      for (const required of manifest.requires ?? []) {
        const dependency = this.entries.get(required.id);
        if (!required.optional && dependency && !dependency.active && this.permitted(dependency)) {
          dependency.demand = `dependency:${manifest.id}`;
          await this.serial(dependency, () => this.evaluate(dependency));
        }
      }
    }
    entry.allowed = enabled;
    if (!enabled) entry.demand = undefined;
    const missing = enabled ? manifest.requires?.find(item => !item.optional && !this.entries.get(item.id)?.active) : undefined;
    if (missing) { entry.problem = `requires ${missing.id}`; enabled = false; }
    // Turned off by choice while it has running tasks: it stays up for them, refusing new ones, until they end (design §8).
    if (!enabled && !missing && entry.active && !entry.force && !this.closed && this.runningTasks(manifest.id) > 0) {
      if (entry.waiting?.kind !== 'switch') entry.waiting = { kind: 'off' };
      return undefined;
    }
    if (entry.waiting?.kind === 'off') entry.waiting = undefined;
    return this.settle(entry, enabled);
  }

  private async settle(entry: Entry, enabled: boolean): Promise<string | undefined> {
    if (enabled && !entry.active) return this.activate(entry);
    if (!enabled) this.restarts.clearRestarts(entry);
    if (!enabled && entry.active) {
      await this.deactivateDependents(entry, true, true);
      await this.deactivate(entry);
    }
    return undefined;
  }

  /**
   * Turns off what is on and needs `entry` (`requiredOnly`), or everything that names it (a shutdown), the
   * ones furthest from it first, so nothing runs without what it depends on.
   */
  private async deactivateDependents(entry: Entry, notify: boolean, requiredOnly: boolean): Promise<void> {
    const id = entry.plugin.manifest.id;
    const direct = [...this.entries.values()].filter(other => other !== entry && other.plugin.manifest.requires?.some(item => item.id === id && (!requiredOnly || !item.optional)));
    await Promise.all(direct.map(other => this.serial(other, async () => {
      await this.deactivateDependents(other, notify, requiredOnly);
      if (!other.active) return;
      if (requiredOnly) other.problem = `requires ${id}`;
      await this.deactivate(other, notify);
    })));
  }

  private async activate(entry: Entry): Promise<string | undefined> {
    const started = Date.now();
    entry.runtime = { trigger: entry.demand ?? 'startup' };
    const activation: Activation = { generation: ++entry.generation, controller: new AbortController(), disposers: [], ended: false, timeouts: 0, openUntil: 0 };
    const { signal } = activation.controller;
    const id = entry.plugin.manifest.id;
    const version = entry.plugin.manifest.version;
    const host: PluginHost = { ...entry.host, logger: Object.fromEntries((['debug', 'info', 'warn', 'error'] as const).map(level => [level, (message: string) => {
      this.journal.append({ pluginId: id, ...(version ? { version } : {}), generation: activation.generation, level, phase: 'runtime', message: String(message) });
    }])) as NonNullable<PluginHost['logger']> };
    const scope: ActivationScope = {
      generation: activation.generation, signal,
      onDispose: fn => {
        if (!activation.ended) activation.disposers.push(fn);
        else void bounded(fn, DISPOSE_TIMEOUT_MS).catch((error: unknown) => console.warn(`[riffet] plugin ${id} late disposer failed: ${describeError(error)}`));
      },
    };
    entry.starting = activation;
    this.log(entry, 'info', 'activate', `Activation started (${entry.runtime.trigger})`);
    const { dataVersion } = entry.plugin.manifest;
    // Data is made ready for this version first; an older version than the data refuses to start.
    const result = Promise.resolve().then(async () => {
      if (dataVersion !== undefined) await this.packages.prepareData(id, dataVersion);
      return entry.plugin.activate(host, scope);
    });
    let staged: Contributions | undefined;
    let timer: NodeJS.Timeout | undefined;
    let problem: string | undefined;
    try {
      // The wait ends when the activation is superseded or takes too long; whatever the code returns later is released.
      if (signal.aborted) throw new Superseded();
      staged = await Promise.race([
        result,
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Superseded()), { once: true })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`did not finish within ${this.activationTimeoutMs / 1000}s`)), this.activationTimeoutMs); timer.unref(); }),
      ]);
      if (signal.aborted) throw new Superseded();
      if (activation.failed) throw new Error(activation.failed);
      this.checked(staged, entry.plugin.manifest, entry.skipped?.ids ?? []);
      if (entry.source === 'installed' && entry.version) this.packages.markActivated(id, entry.version);
      activation.contributions = this.guard.guardContributions(entry, activation, staged);
      entry.active = activation;
      entry.cleanup = undefined;
      entry.runtime = { ...entry.runtime, activatedAt: new Date().toISOString(), durationMs: Date.now() - started };
      this.log(entry, 'info', 'activate', `Activation completed in ${Date.now() - started} ms`);
      this.restarts.armStable(entry);
    } catch (error) {
      if (!(error instanceof Superseded)) {
        entry.problem = problem = `activation failed: ${this.journal.redact(id, describeError(error))}`;
        entry.runtime = { ...entry.runtime, failedPhase: 'activate', durationMs: Date.now() - started };
        this.log(entry, 'error', 'activate', error instanceof Error ? error.stack ?? error.message : String(error));
      }
      const failures = await this.end(activation, staged);
      if (failures.length) entry.cleanup = `a failed activation left something behind: ${failures.join('; ')}`;
      // A result that arrives after the wait ended is released the same way.
      if (!staged) void result.then(late => this.end(activation, late), () => [] as string[]).then(late => { if (late.length) entry.cleanup = `a late activation left something behind: ${late.join('; ')}`; });
    } finally { clearTimeout(timer); if (entry.starting === activation) entry.starting = undefined; }
    // Outside the try: a failing host callback must not dispose contributions that stay committed.
    if (entry.active === activation) { this.invalidate(); this.changed(); await this.refreshOptionalDependents(entry); }
    return problem;
  }

  /** Lookups stop first, then flows are dropped and the scope ends. */
  private async deactivate(entry: Entry, notify = true): Promise<void> {
    const started = Date.now();
    const activation = entry.active!;
    entry.active = undefined;
    entry.waiting = undefined;
    this.restarts.clearRestarts(entry, false);
    if (activation.notice && entry.note === activation.notice) entry.note = undefined;
    const id = entry.plugin.manifest.id;
    this.flows.forget(id);
    if (notify) { this.invalidate(); this.changed(); }
    const failures = await this.end(activation, activation.contributions);
    this.log(entry, failures.length ? 'warn' : 'info', 'dispose', `Deactivation completed in ${Date.now() - started} ms${failures.length ? `: ${failures.join('; ')}` : ''}`);
    entry.cleanup = failures.length ? `turning off left something behind: ${failures.join('; ')}` : undefined;
    for (const listener of this.endListeners) {
      try { listener(activation.contributions); } catch (error) { console.warn('[riffet] plugin end listener failed:', describeError(error)); }
    }
    if (notify) await this.refreshOptionalDependents(entry);
  }

  /**
   * A plugin came on or went off: the ones that are on and name it as an optional dependency are turned off and on again,
   * so what they built from it is revoked or built anew. (A required dependency that goes off takes its dependents with it.) A
   * dependent first turned on after it, or evaluated in the same pass, is not on yet and needs nothing.
   */
  private async refreshOptionalDependents(entry: Entry): Promise<void> {
    if (this.closed) return;
    const id = entry.plugin.manifest.id;
    const users = [...this.entries.values()].filter(other => other !== entry && other.active && !other.waiting && other.plugin.manifest.requires?.some(item => item.id === id && item.optional));
    await Promise.all(users.map(other => this.serial(other, async () => {
      if (!other.active || this.closed) return;
      const otherId = other.plugin.manifest.id;
      await this.deactivateDependents(other, true, true);
      await this.deactivate(other);
      await this.evaluate(other);
      await this.evaluateAll(this.dependents(otherId));
    })));
  }

  /** Aborts the signal, then runs `contributions.dispose` and the scope's disposers, last registered first. Returns what failed. */
  private async end(activation: Activation, contributions?: Contributions): Promise<string[]> {
    const disposers = [...activation.disposers].reverse();
    activation.disposers.length = 0;
    if (!activation.ended) { activation.ended = true; activation.controller.abort(); }
    const failures: string[] = [];
    for (const dispose of [...(contributions?.dispose ? [() => contributions.dispose!()] : []), ...disposers]) {
      try { await bounded(dispose, DISPOSE_TIMEOUT_MS); }
      catch (error) { failures.push(describeError(error)); }
    }
    return failures;
  }

  private changed(): void {
    for (const listener of this.changeListeners) {
      try { listener(); } catch (error) { console.warn('[riffet] plugin change listener failed:', describeError(error)); }
    }
  }

  /** A profile names a source by id alone, so two providers of one id would be ambiguous. */
  private checked(contributions: Contributions, manifest: PluginManifest, skipped: readonly string[] = []): void {
    const taken = new Set(this.active().flatMap(contribution => contribution.modelSources ?? []).map(source => source.id));
    for (const source of contributions.modelSources ?? []) {
      // A plugin that declares the id statically owns it, whether or not it is active yet.
      const owner = this.declared.get(MODEL_SOURCE_CLAIM + source.id);
      if (owner !== undefined && owner !== manifest.id) throw new Error(`model source "${source.id}" is declared by ${owner}`);
      if (!MODEL_SOURCE_ID.test(source.id) || taken.has(source.id)) throw new Error(`model source "${source.id}" is invalid or already provided`);
      taken.add(source.id);
    }
    // A task names its provider, so each must be a declared contribution of this plugin and appear once.
    const providers = new Set<string>();
    for (const provider of contributions.taskProviders ?? []) {
      if (!manifest.contributes?.tasks?.some(declared => declared.id === provider.id) || providers.has(provider.id)) throw new Error(`task provider "${provider.id}" is not declared in contributes.tasks or is provided twice`);
      providers.add(provider.id);
    }
    for (const declared of manifest.contributes?.modelSources ?? []) {
      if (!contributions.modelSources?.some(source => source.id === declared.id)) throw new Error('Declared model source is not provided: ' + declared.id);
    }
    if (manifest.contributes?.sharePublisher && !contributions.sharePublisher) throw new Error('Declared share publisher is not provided');
    if (contributions.speechRecognizer !== undefined && (!manifest.contributes?.speechRecognizer || typeof contributions.speechRecognizer?.open !== 'function' || typeof contributions.speechRecognizer.status !== 'function')) throw new Error('speechRecognizer is not declared in contributes.speechRecognizer or has no open() and status()');
    if (manifest.contributes?.speechRecognizer && !contributions.speechRecognizer) throw new Error('Declared speech recognizer is not provided');
    // A command is run by its id from the declaration: each handler must be declared by this integration.
    for (const [commandId, handler] of Object.entries(contributions.commands ?? {})) {
      // A command this host left out of the manifest stays unrunnable (`command()` finds no declaration); its handler is not an error.
      if (skipped.includes(commandId)) continue;
      if (!manifest.contributes?.commands?.some(declared => declared.id === commandId) || typeof handler?.run !== 'function') throw new Error(`command "${commandId}" is not declared in contributes.commands or has no run()`);
    }
    for (const [styleId, provider] of Object.entries(contributions.avatarStyles ?? {})) {
      if (!manifest.contributes?.avatarStyles?.some(declared => declared.id === styleId) || typeof provider?.generate !== 'function') throw new Error(`avatar style "${styleId}" is not declared in contributes.avatarStyles or has no generate()`);
    }
    for (const [groupId, group] of Object.entries(contributions.agentTools ?? {})) {
      const declared = manifest.contributes?.agentTools?.find(item => item.id === groupId);
      if (!declared || !Array.isArray(group?.tools) || typeof group.call !== 'function') throw new Error(`agent tools "${groupId}" are not declared in contributes.agentTools or have no call()`);
      const names = new Set<string>();
      for (const tool of group.tools) {
        if (typeof tool?.name !== 'string' || !tool.name.startsWith(declared.toolPrefix) || !/^[a-z][a-z0-9_]{1,63}$/.test(tool.name) || names.has(tool.name)) throw new Error(`agent tool "${String(tool?.name)}" must be named "${declared.toolPrefix}<name>" and appear once`);
        names.add(tool.name);
      }
    }
    if (contributions.page !== undefined && (!manifest.contributes?.page || typeof contributions.page?.read !== 'function')) throw new Error('page is not declared in contributes.page or has no read()');
    if (manifest.contributes?.page && !contributions.page) throw new Error('Declared page is not provided');
    for (const [channelId, handler] of Object.entries(contributions.channels ?? {})) {
      if (!manifest.contributes?.channels?.some(declared => declared.id === channelId) || typeof handler?.open !== 'function') throw new Error(`channel "${channelId}" is not declared in contributes.channels or has no open()`);
    }
    for (const [name, service] of Object.entries(contributions.services ?? {})) {
      if (!SERVICE_NAME.test(name) || !service || typeof service !== 'object' || typeof service.version !== 'string' || !SERVICE_VERSION.test(service.version)) throw new Error(`service "${name}" needs a name like "scan" and a version like "1.0.0"`);
    }
    // An Agent is a persisted identity: each must be declared by this plugin, versioned for this host, and neither provided by the core nor by another integration.
    const agents = new Set(this.agentBackends().map(({ backend }) => String(backend.id)));
    for (const backend of contributions.agentBackends ?? []) {
      const id = String(backend.id);
      if (backend.protocolVersion !== AGENT_PROTOCOL_VERSION) throw new Error(`agent backend "${id}" was written for agent protocol v${String(backend.protocolVersion)}; this Riffet provides v${AGENT_PROTOCOL_VERSION}`);
      if (!manifest.contributes?.agentBackends?.some(declared => declared.id === id)) throw new Error(`agent backend "${id}" is not declared in contributes.agentBackends`);
      if (agents.has(id) || this.agentBackendProvided(id)) throw new Error(`agent backend "${id}" is already provided`);
      agents.add(id);
    }
  }

  /**
   * The plugin's `status()`, which a list read must not wait on for long: after the timeout the last answer stands in (or a note that
   * there is none yet), and the call is not made again while it is still out.
   */
  private async statusOf(activation: Activation): Promise<PluginStatus | undefined> {
    const contributions = activation.contributions;
    if (!contributions?.status) return undefined;
    const call = activation.statusCall ??= Promise.resolve().then(() => contributions.status!())
      .then(status => { activation.statusLast = status; return status; })
      .finally(() => { activation.statusCall = undefined; });
    let timer: NodeJS.Timeout | undefined;
    const timedOut = Symbol('timeout');
    try {
      const answer = await Promise.race([call, new Promise<typeof timedOut>(resolve => { timer = setTimeout(() => resolve(timedOut), this.statusTimeoutMs); timer.unref(); })]);
      return answer === timedOut ? activation.statusLast ?? { state: 'attention', message: 'status timed out' } : answer;
    } catch (error) { return { state: 'unavailable', message: describeError(error) }; }
    finally { clearTimeout(timer); }
  }

  private async describe(entry: Entry): Promise<PluginDescriptor> {
    const { manifest } = entry.plugin;
    let item: PluginItem | undefined;
    try { item = this.store.item(manifest.id); } catch { /* reported through `storeProblem` */ }
    const contributions = entry.active?.contributions;
    const problem = this.storeProblem ?? entry.problem ?? entry.cleanup;
    const waiting = entry.active ? entry.waiting : undefined;
    const running = waiting ? this.runningTasks(manifest.id) : 0;
    const rawStatus: PluginStatus | undefined = problem ? { state: 'unavailable', message: problem }
      : waiting ? { state: 'attention', message: `Waiting for ${running} running task${running === 1 ? '' : 's'} to end before ${waiting.kind === 'off' ? 'turning off' : `switching to version ${waiting.version}`}` }
      : entry.note ? { state: 'attention', message: entry.note }
      : entry.active ? await this.statusOf(entry.active) : undefined;
    const status = rawStatus?.message ? { ...rawStatus, message: this.journal.redact(manifest.id, rawStatus.message) } : rawStatus;
    const available = this.available(entry);
    const declaredSources = entry.plugin.manifest.contributes?.modelSources ?? [];
    // Static metadata survives disablement so a saved profile can still identify its gateway type.
    // These descriptors do not register a usable provider: modelSources() and enabled keep that boundary.
    const sourceProviders = contributions?.modelSources
      ?? (available ? this.modelSources().filter(source => declaredSources.some(declared => declared.id === source.id)) : undefined)
      ?? declaredSources.map(source => ({ ...source, label: source.title.en ?? Object.values(source.title)[0] ?? source.id }));
    const sources = sourceProviders.map((source): ModelSourceDescriptor => ({
      id: source.id, label: source.label,
      ...(source.role ? { role: source.role } : {}),
      ...(source.usage || declaredSources.find(declared => declared.id === source.id)?.usage ? { usage: true } : {}),
      backends: protocolBackends(sourceProtocols(source)), protocols: sourceProtocols(source),
      ...(source.defaultEndpoint ? { defaultEndpoint: source.defaultEndpoint } : {}),
      overridable: [...(source.overridable ?? ['apiEndpoint', 'apiKey'])],
      ...(source.loginAction && (contributions?.actions && Object.hasOwn(contributions.actions, source.loginAction) || manifest.contributes?.actions?.some(action => action.id === source.loginAction)) ? { loginAction: source.loginAction } : {}),
      ...(source.hint ? { hint: { text: source.hint.text, ...(source.hint.command ? { command: source.hint.command } : {}) } } : {}),
    }));
    const publisher = contributions?.sharePublisher;
    const declared = knownDeclarations(manifest.contributes);
    const installed = entry.source === 'installed' ? await this.installedInfo(manifest.id) : undefined;
    const compat = compatibility(manifest);
    // What a view of this package may ask of the web bridge: the grant of the selected version, or for a trusted development package what it asks for.
    const held = installed ? installed.versions.find(version => version.selected)?.capabilities : entry.source === 'development' ? requestedCapabilities(manifest) : undefined;
    return {
      id: manifest.id, vendor: manifest.vendor, name: manifest.name, enabled: available, active: Boolean(entry.active), enablement: item?.enablement ?? 'auto',
      activation: { events: this.events(entry), state: entry.starting ? 'activating' : entry.active ? 'active' : entry.problem ? 'failed' : 'idle', ...entry.runtime },
      execution: { location: 'server', mode: entry.server || (entry.source === 'builtin' && manifest.contributes?.agentBackends?.length) ? entry.source !== 'installed' || entry.trusted ? 'in-process' : 'isolated' : 'resources', platform: process.platform },
      source: entry.source,
      ...(entry.source === 'development' && entry.root ? { developmentPath: entry.root } : {}),
      ...(entry.source === 'development' && this.developmentLinked(manifest.id, entry.root) ? { developmentLinked: true } : {}),
      ...(item ? { configRevision: this.store.revision(manifest.id) } : {}),
      ...(compat ? { compatibility: compat } : {}),
      ...(installed ? { installed } : {}),
      ...(held ? { capabilities: held } : {}),
      ...(held?.includes('process.exec') && grantExecutables(manifest) ? { executables: grantExecutables(manifest) } : {}),
      ...(entry.web ? { webEntry: entry.web } : {}),
      ...(manifest.version ? { version: manifest.version } : {}),
      ...(manifest.title ? { title: manifest.title } : {}),
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.requires?.length ? { requires: manifest.requires.map(({ id, optional }) => ({ id, ...(optional ? { optional } : {}) })) } : {}),
      ...(declared ? { declared } : {}),
      ...(status ? { status } : {}),
      ...(waiting ? { stopping: { running, ...(waiting.kind === 'switch' ? { version: waiting.version } : {}) } } : {}),
      settings: (manifest.settings ?? []).map(({ key, label, kind }) => kind === 'secret'
        ? { key, label, kind, set: Boolean(item?.secrets[key]) }
        : { key, label, kind, ...(item?.settings[key] !== undefined ? { value: item.settings[key] } : {}) }),
      actions: contributions?.actions ? Object.entries(contributions.actions).map(([id, action]) => ({ id, label: action.label, kind: action.kind })) : available ? manifest.contributes?.actions ?? [] : [],
      contributes: { ...(sources?.length ? { modelSources: sources } : {}), ...(publisher ? { sharePublisher: { label: publisher.label, audience: publisher.audience } } : {}) },
    };
  }

  private available(entry: Entry): boolean {
    return Boolean(entry.active) || (this.isLazy(entry) && this.permitted(entry) && entry.allowed !== false);
  }

  private patch(entry: Entry, input: unknown): { patch: PluginItemPatch; force: boolean } {
    const invalid = (message: string) => new AppError('INVALID_INTEGRATION_UPDATE', message);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Expected an object');
    const { enablement, settings, force, configRevision, ...rest } = input as Record<string, unknown>;
    if (Object.keys(rest).length) throw invalid(`Unknown field ${Object.keys(rest)[0]}`);
    if (force !== undefined && typeof force !== 'boolean') throw invalid('force must be true or false');
    if (configRevision !== undefined && (typeof configRevision !== 'string' || configRevision !== this.store.revision(entry.plugin.manifest.id))) throw new AppError('PLUGIN_CONFIG_CONFLICT', 'Plugin configuration changed; reload it before saving', 409);
    const patch: PluginItemPatch = {};
    if (enablement !== undefined) {
      if (!ENABLEMENTS.includes(enablement as PluginEnablement)) throw invalid('enablement must be auto, on or off');
      patch.enablement = enablement as PluginEnablement;
    }
    if (settings !== undefined) {
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw invalid('settings must be an object');
      const fields = new Map((entry.plugin.manifest.settings ?? []).map(field => [field.key, field]));
      for (const [key, value] of Object.entries(settings)) {
        const field = fields.get(key);
        if (!field) throw invalid(`Unknown setting ${key}`);
        if (value !== null && (typeof value !== 'string' || value.length > 64 * 1024 || /[\0\r\n]/.test(value.trim()))) throw invalid(`${key} must be a single line`);
        const target = field.kind === 'secret' ? (patch.secrets ??= {}) : (patch.settings ??= {});
        // An empty value clears, as `null` does.
        target[key] = typeof value === 'string' && value.trim() ? value.trim() : null;
      }
    }
    return { patch, force: force === true };
  }
}
