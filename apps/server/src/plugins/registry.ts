import { setTimeout as sleep } from 'node:timers/promises';
import {
  type Contributions, type DoctorCheck, type Plugin, type PluginHost, type PluginManifest, type AgentToolGroup, type ImChannelProvider,
  type AvatarStyleProvider, type PluginChannelHandler, type CommandHandler, type ModelSourceProvider, type NativeRuntimeHook, type PluginApprovalHandler, type PluginQueryHandler, type SharePublisher, type SpeechRecognizer, type TaskProvider,
} from '@riffet/plugin-api';
import { AGENT_PROTOCOL_VERSION, type AgentBackend } from '@riffet/plugin-api/experimental/agent';
import type { ActionStep, AppearanceDeclarations, PluginPageExtraKind, PluginPageResponse, PluginReadmeResponse, CommandDeclaration, QueryDeclaration, PluginDeclarations, LocalizedText, PluginDescriptor, PluginStatus, ModelSourceDescriptor, NativeBackendId, Task, TaskParams } from '../../../../packages/contracts/src/index.js';
// The core's only import of the built-in list (`pnpm check:plugins`), so a build can swap it here.
import { builtinPlugins } from '../../../../plugins/index.js';
import { AppError } from '../errors.js';
import { loadableManifest } from './declarations.js';
import { developmentDirectories, loadDevelopmentPackage, readPackage } from './development.js';
import { createPluginHost } from './host.js';
import { builtinPackageRoot } from './package-root.js';
import { CallGuard, FAIL_FAST_MS } from './call-guard.js';
import {
  ACTIVATION_TIMEOUT_MS, claims, describeError, MODEL_SOURCE_CLAIM, START_GRACE_MS,
  STATUS_TIMEOUT_MS, type Entry, type RegistryContext, type Rejected, type Source, type WebEntry,
} from './entry.js';
import * as descriptorsApi from './descriptors.js';
import * as lifecycle from './lifecycle.js';
import * as packagesApi from './packages.js';
import { Flows } from './flows.js';
import { Pages } from './pages.js';
import { RESTART_DELAYS_MS, RESTART_STABLE_MS, Restarts } from './restarts.js';
import { PluginStore } from './store.js';
import { PluginLogs } from './logs.js';
import type { PluginActivationState, PluginLogEntry } from '../../../../packages/contracts/src/plugin-management.js';
import { serverIncompatibility } from '../plugins-host/compat.js';
import { PackageStore } from '../plugins-host/packages.js';
import { satisfies } from '../plugins-host/semver.js';

export type { InstallRequest } from './packages.js';

/** The built-in list without one integration: what a build that leaves it out starts from, and what a test of that build passes as `plugins`. */
export const builtinPluginsWithout = (id: string): Plugin[] => builtinPlugins.filter(plugin => plugin.manifest.id !== id);
/** The built-in list with one plugin changed (made slow or failing, say), for a test of the server around it. */
export const builtinPluginsChanging = (id: string, change: (plugin: Plugin) => Plugin): Plugin[] => builtinPlugins.map(plugin => plugin.manifest.id === id ? change(plugin) : plugin);

/** Whether this build ships a built-in plugin under `id`, which an installed package may not take (also checked by `riffet plugin install` when no server runs). */
export const isBuiltinPlugin = (id: string): boolean => builtinPlugins.some(plugin => plugin.manifest.id === id);

export interface OwnedRuntimeHook { owner: PluginManifest['id']; hook: NativeRuntimeHook }
/** An Agent backend of an enabled integration. */
export interface OwnedAgentBackend { owner: PluginManifest['id']; backend: AgentBackend }
export interface OwnedSharePublisher { owner: PluginManifest['id']; publisher: SharePublisher }
/** `version` and `projectType` come from the manifest, so the host can record what a task started under. `source` is where the code runs from: an installed package's plans are confirmed before they run. */
export interface OwnedTaskProvider { owner: PluginManifest['id']; version?: string; projectType?: string; source?: Source; provider: TaskProvider }
/** A generated avatar style of an enabled plugin: its declaration and the provider that draws it. */
/** `signal` is the activation's: it aborts when the plugin is turned off. */
/** An IM platform of an enabled plugin: `id` is its declaration id, the `ChannelKind` of the accounts it connects. */
export interface OwnedImChannel { owner: PluginManifest['id']; id: string; provider: ImChannelProvider; signal: AbortSignal }
export interface OwnedAgentTools { owner: PluginManifest['id']; declaration: NonNullable<PluginDeclarations['agentTools']>[number]; group: AgentToolGroup; signal: AbortSignal }
export interface OwnedAvatarStyle { owner: PluginManifest['id']; declaration: NonNullable<PluginDeclarations['avatarStyles']>[number]; provider: AvatarStyleProvider }
/** A command ready to run: the declaration, the handler, and the signal that aborts with the activation. */
export interface ResolvedCommand { declaration: CommandDeclaration; handler: CommandHandler; signal: AbortSignal }
/** A read-only query ready to run for a plugin's views. */
export interface ResolvedQuery { declaration: QueryDeclaration; handler: PluginQueryHandler; signal: AbortSignal }

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
  /** `host.code` of an in-process plugin that declares agent tools. */
  code?: PluginHost['code'];
  /** `host.models.complete` of an in-process plugin, given its own declared model uses. */
  completeModel?: Parameters<typeof createPluginHost>[1]['completeModel'];
  /** `host.models.stream` of an in-process plugin, given its own declared model uses. */
  streamModel?: Parameters<typeof createPluginHost>[1]['streamModel'];
  /** `host.assistant.emit` of an in-process plugin that declares `assistantEvents`: hands the event to the 助理's delegations. */
  emitAssistantEvent?: Parameters<typeof createPluginHost>[1]['emitAssistantEvent'];
  /** `host.approvals` of an in-process plugin: the inbox's approvals, keyed by plugin. */
  approvals?: Parameters<typeof createPluginHost>[1]['approvals'];
}

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
  private readonly viewDataListeners = new Set<(event: { pluginId: string; topic?: string }) => void>();
  private readonly hostOptions: Parameters<typeof createPluginHost>[1];
  private readonly emitAssistantEvent?: Parameters<typeof createPluginHost>[1]['emitAssistantEvent'];
  private readonly approvals?: Parameters<typeof createPluginHost>[1]['approvals'];
  /** Why a plugin's capability pack is not installed, by plugin id; set by whoever installs packs (`setAssistantPackProblem`). */
  private readonly packProblems = new Map<string, string>();
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
  private readonly ctx: RegistryContext;

  constructor(options: PluginRegistryOptions) {
    this.store = new PluginStore(options.stateDir);
    this.journal = new PluginLogs(options.stateDir, id => {
      try { const item = this.store.item(id); return [...Object.values(item.settings), ...Object.values(item.secrets)]; } catch { return []; }
    });
    this.invalidate = options.invalidateModelCatalogs ?? (() => undefined);
    this.agentBackendProvided = options.agentBackendProvided ?? (() => false);
    this.hostOptions = { stateDir: options.stateDir, store: this.store, invalidateModelCatalogs: this.invalidate, savedModelSources: options.savedModelSources ?? (() => []), ...(options.agentProfiles ? { agentProfiles: options.agentProfiles } : {}), ...(options.startTask ? { startTask: options.startTask } : {}), ...(options.sessions ? { sessions: options.sessions } : {}), ...(options.code ? { code: options.code } : {}), ...(options.completeModel ? { completeModel: options.completeModel } : {}), ...(options.streamModel ? { streamModel: options.streamModel } : {}) };
    if (options.emitAssistantEvent) this.emitAssistantEvent = options.emitAssistantEvent;
    if (options.approvals) this.approvals = options.approvals;
    this.runningTasks = options.runningTasks ?? (() => 0);
    this.statusTimeoutMs = options.statusTimeoutMs ?? STATUS_TIMEOUT_MS;
    this.packages = new PackageStore(options.stateDir);
    this.activationTimeoutMs = options.activationTimeoutMs ?? ACTIVATION_TIMEOUT_MS;
    this.versionInUse = options.versionInUse ?? (() => false);
    this.serverPorts = options.serverPorts ?? (() => []);

    const self = this;
    this.ctx = {
      store: this.store, journal: this.journal, entries: this.entries, rejected: this.rejected, declared: this.declared,
      packProblems: this.packProblems, packages: this.packages, stateDir: options.stateDir,
      activationTimeoutMs: this.activationTimeoutMs, statusTimeoutMs: this.statusTimeoutMs,
      versionInUse: this.versionInUse, runningTasks: this.runningTasks, serverPorts: this.serverPorts,
      agentBackendProvided: this.agentBackendProvided, endListeners: this.endListeners,
      get guard() { return self.guard; },
      get restarts() { return self.restarts; },
      get flows() { return self.flows; },
      get closed() { return self.closed; },
      set closed(value: boolean) { self.closed = value; },
      get storeProblem() { return self.storeProblem; },
      set storeProblem(value: string | undefined) { self.storeProblem = value; },
      get packagesProblem() { return self.packagesProblem; },
      set packagesProblem(value: string | undefined) { self.packagesProblem = value; },
      loading: () => this.loading,
      refresh: () => this.refresh(),
      invalidate: () => this.invalidate(),
      changed: () => this.changed(),
      log: (entry, level, phase, message) => this.log(entry, level, phase, message),
      require: id => this.require(id),
      reject: item => this.reject(item),
      admit: plugin => this.admit(plugin),
      createHost: (manifest, source, trusted) => this.createHost(manifest, source, trusted),
      register: (plugin, source, root, extra) => this.register(plugin, source, root, extra),
      events: entry => this.events(entry),
      isLazy: entry => this.isLazy(entry),
      permitted: (entry, visited) => this.permitted(entry, visited),
      active: () => this.active(),
      agentBackends: () => this.agentBackends(),
      modelSources: () => this.modelSources(),
      exclusive: change => this.exclusive(change),
      schedulePrune: ms => this.schedulePrune(ms),
      switchVersion: (entry, version, force) => packagesApi.switchVersion(this.ctx, entry, version, force),
    };

    for (const plugin of options.plugins ?? builtinPlugins) this.register(plugin, 'builtin');
    lifecycle.rejectCycles(this.ctx);
    this.restarts = new Restarts({
      closed: () => this.closed, recovery: () => this.store.recovery(), evaluateAll: ids => lifecycle.evaluateAll(this.ctx, ids), dependents: id => lifecycle.dependents(this.ctx, id),
      log: (entry, level, phase, message) => this.log(entry, level, phase, message), entry: id => this.entries.get(id),
      restartDelaysMs: options.restartDelaysMs ?? RESTART_DELAYS_MS, restartStableMs: options.restartStableMs ?? RESTART_STABLE_MS,
    });
    this.guard = new CallGuard({
      log: (entry, level, phase, message) => this.log(entry, level, phase, message), changed: () => this.changed(),
      callTimeoutMs: options.callTimeoutMs, failFastMs: options.failFastMs ?? FAIL_FAST_MS,
    });
    this.flows = new Flows({
      require: id => this.require(id), entry: id => this.entries.get(id), events: entry => this.events(entry),
      ensureContribution: (kind, contributionId) => this.ensureContribution(kind, contributionId), ensureEntry: (entry, trigger) => lifecycle.ensureEntry(this.ctx, entry, trigger),
      guarded: (entry, run, failureCode) => this.guarded(entry, run, failureCode),
    });
    this.pages = new Pages({
      loading: () => this.loading, require: id => this.require(id), events: entry => this.events(entry), ensureEntry: (entry, trigger) => lifecycle.ensureEntry(this.ctx, entry, trigger),
      guarded: (entry, run, failureCode) => this.guarded(entry, run, failureCode), update: (id, input) => this.update(id, input),
      redact: (id, text) => this.journal.redact(id, text), item: id => this.store.item(id),
    });
    this.loading = packagesApi.loadPackages(this.ctx, options.developmentPackages ?? developmentDirectories(), options.developmentPackages === undefined);
  }

  /** Re-evaluates every plugin's enablement. Concurrent callers share one pass. */
  refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try { await this.loading; await lifecycle.evaluateAll(this.ctx, [...this.entries.keys()]); this.passed = true; }
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
      return lifecycle.serial(entry, async () => {
        await lifecycle.deactivateDependents(this.ctx, entry, false, false);
        if (entry.active) await lifecycle.deactivate(this.ctx, entry, false);
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

  async ensureContribution(kind: 'command' | 'model-source' | 'query' | 'task' | 'view', contributionId: string): Promise<void> {
    await this.loading;
    const entry = [...this.entries.values()].find(item => {
      const declared = item.plugin.manifest.contributes;
      return (kind === 'command' ? declared?.commands : kind === 'model-source' ? declared?.modelSources : kind === 'query' ? declared?.queries : kind === 'task' ? declared?.tasks : declared?.views)?.some(value => value.id === contributionId)
        || kind === 'model-source' && item.active?.contributions?.modelSources?.some(source => source.id === contributionId);
    });
    if (!entry) throw new AppError('PLUGIN_CONTRIBUTION_NOT_FOUND', 'Plugin contribution not found', 404);
    const events = this.events(entry);
    const allowed = kind === 'query' ? (events.includes('view') || events.includes('command') || events.includes('startup')) : (events.includes(kind) || events.includes('startup'));
    if (!entry.active && !allowed) throw new AppError('PLUGIN_ACTIVATION_UNSUPPORTED', `This plugin does not activate on ${kind}`, 409);
    await lifecycle.ensureEntry(this.ctx, entry, `${kind}:${contributionId}`);
  }

  async activateView(id: string, input: unknown): Promise<PluginDescriptor> {
    await this.loading;
    const entry = this.require(id);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('INVALID_INPUT', 'Expected an activation event');
    const event = input as Record<string, unknown>;
    if (event.kind !== 'view' || typeof event.id !== 'string' || !entry.plugin.manifest.contributes?.views?.some(view => view.id === event.id)) throw new AppError('INVALID_INPUT', 'Expected a declared view activation');
    await this.ensureContribution('view', event.id);
    return descriptorsApi.describeEntry(this.ctx, entry);
  }

  async activateTaskProviders(): Promise<void> {
    await this.loading;
    await Promise.all([...this.entries.values()].filter(entry => this.permitted(entry) && this.events(entry).includes('task') && entry.plugin.manifest.contributes?.tasks?.length).map(entry => lifecycle.ensureEntry(this.ctx, entry, 'task:project').catch(() => undefined)));
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

  /**
   * The approval handler of plugin `pluginId` (`Contributions.approvals`), turning the plugin on first when it is lazy or
   * has not started yet: an approval outlives the server run that asked for it.
   */
  async approvalHandler(pluginId: string): Promise<{ handler: PluginApprovalHandler; signal: AbortSignal }> {
    await this.loading;
    const entry = this.entries.get(pluginId);
    if (!entry) throw new AppError('PLUGIN_NOT_FOUND', 'Unknown plugin', 404);
    await lifecycle.ensureEntry(this.ctx, entry, 'approvals');
    const handler = entry.active?.contributions?.approvals;
    if (!entry.active || typeof handler?.decide !== 'function') throw new AppError('PLUGIN_APPROVALS_UNAVAILABLE', `${entry.plugin.manifest.name} cannot decide approvals now`, 409);
    return { handler: { decide: (id, actionId, context) => this.guarded(entry, () => handler.decide(id, actionId, context), 'APPROVAL_FAILED') }, signal: entry.active.controller.signal };
  }

  /** Of [ids], the plugins that are gone from this build or turned off, so what they left in the inbox is stale. One that is merely not started yet is not off. */
  async offPlugins(ids: readonly string[]): Promise<string[]> {
    await this.loading;
    return ids.filter(id => {
      const entry = this.entries.get(id);
      return !entry || (Boolean(entry.evaluated) && entry.allowed === false && !entry.active);
    });
  }

  /** The display name of plugin `pluginId`, when it is in this build. */
  pluginName(pluginId: string): string | undefined { return this.entries.get(pluginId)?.plugin.manifest.name; }

  /** The assistant event topics the enabled plugins declare, with their plugin, for the 助理 to find (`workbench.assistant_events`). */
  assistantEvents(): Array<{ id: string; plugin: string; title: LocalizedText; description: LocalizedText }> {
    return [...this.entries.values()].flatMap(entry => this.servesAssistant(entry)
      ? (entry.plugin.manifest.contributes?.assistantEvents ?? []).map(({ id, title, description }) => ({ id, plugin: String(entry.plugin.manifest.id), title, description })) : []);
  }

  /** Whether an enabled plugin declares [topic] as an assistant event. */
  assistantEventDeclared(topic: string): boolean { return this.assistantEvents().some(event => event.id === topic); }

  /** The capability packs of the enabled plugins, with the directory each `path` is relative to. Disabled and uninstalled plugins have none, which is how their packs are removed. */
  assistantPackSources(): Array<{ pluginId: string; version: string; root: string; path: string }> {
    return [...this.entries.values()].flatMap(entry => {
      const { id, contributes } = entry.plugin.manifest;
      const root = entry.root ?? (entry.source === 'builtin' ? builtinPackageRoot(id) : undefined);
      return this.servesAssistant(entry) && contributes?.assistantPack && root ? [{ pluginId: String(id), version: entry.version ?? entry.plugin.manifest.version ?? '0.0.0', root, path: contributes.assistantPack.path }] : [];
    });
  }

  /**
   * Whether a plugin's assistant events and capability pack count: it runs in-process (an isolated installed package gets
   * neither, as it gets no `host.assistant`; a pack's hooks and MCP servers would run outside its sandbox), and it is on,
   * including a lazy one that has not been started and one still on its way at startup, so neither loses its pack.
   */
  private servesAssistant(entry: Entry): boolean {
    if (entry.source === 'installed' && !entry.trusted) return false;
    if (entry.active) return true;
    if (!this.permitted(entry) || entry.allowed === false) return false;
    return this.isLazy(entry) || !entry.evaluated || Boolean(entry.starting);
  }

  /** Records, or with `undefined` clears, why a plugin's capability pack is not installed; shown with its diagnostics. */
  setAssistantPackProblem(pluginId: string, problem: string | undefined): void {
    if (problem === undefined) this.packProblems.delete(pluginId); else this.packProblems.set(pluginId, problem);
  }

  /** The `icon.svg` of every Agent a loaded plugin declares, enabled or not, with the directory its path is relative to. */
  agentIconSources(): Array<{ agentId: string; svg: string; root: string }> {
    return [...this.entries.values()].flatMap(entry => {
      const { id, contributes } = entry.plugin.manifest;
      const root = entry.root ?? (entry.source === 'builtin' ? builtinPackageRoot(id) : undefined);
      return root ? (contributes?.agentBackends ?? []).flatMap(agent => agent.icon?.svg ? [{ agentId: agent.id, svg: agent.icon.svg, root }] : []) : [];
    });
  }

  /** The `icon.svg` of every view a loaded plugin declares, with the directory its path is relative to. */
  viewIconSources(): Array<{ viewId: string; svg: string; root: string }> {
    return [...this.entries.values()].flatMap(entry => {
      const { id, contributes } = entry.plugin.manifest;
      const root = entry.root ?? (entry.source === 'builtin' ? builtinPackageRoot(id) : undefined);
      return root ? (contributes?.views ?? []).flatMap(view => view.icon?.svg ? [{ viewId: view.id, svg: view.icon.svg, root }] : []) : [];
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
  onChange(listener: () => void): () => void { this.changeListeners.add(listener); return () => { this.changeListeners.delete(listener); }; }
  /** Called when a plugin invalidates its views' cached data via `host.views.invalidate`. A listener must not throw. */
  onViewData(listener: (event: { pluginId: string; topic?: string }) => void): () => void { this.viewDataListeners.add(listener); return () => { this.viewDataListeners.delete(listener); }; }
  /** Called when a turned-off activation has been released, disposers included, with what it contributed: nothing of it may be used after this. A listener must not throw. */
  onEnded(listener: (contributions: Contributions | undefined) => void): () => void { this.endListeners.add(listener); return () => { this.endListeners.delete(listener); }; }

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

  /** The IM platforms of the enabled plugins: declared in the manifest and provided by the committed activation. */
  imChannels(): OwnedImChannel[] {
    return [...this.entries.values()].filter(entry => !entry.waiting).flatMap(entry => {
      const providers = entry.active?.contributions?.imChannels;
      return (entry.plugin.manifest.contributes?.imChannels ?? []).flatMap(declaration => {
        const provider = providers && Object.hasOwn(providers, declaration.id) ? providers[declaration.id] : undefined;
        return provider && entry.active ? [{ owner: entry.plugin.manifest.id, id: declaration.id, provider, signal: entry.active.controller.signal }] : [];
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
        ? lifecycle.evaluateAll(this.ctx, [id, ...lifecycle.dependents(this.ctx, id)])
        : this.exclusive(async () => { if (entry.waiting === waiting) await packagesApi.switchVersion(this.ctx, entry, waiting.version); });
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

  /** The read-only query `queryId` of plugin `pluginId`, ready to run for its views. */
  query(pluginId: string, queryId: string): ResolvedQuery {
    const entry = this.entries.get(pluginId);
    const unknown = () => new AppError('QUERY_NOT_FOUND', 'Unknown query', 404);
    const declaration = entry?.plugin.manifest.contributes?.queries?.find(declared => declared.id === queryId);
    if (!entry || !declaration) throw unknown();
    const unavailable = (reason: string) => new AppError('QUERY_UNAVAILABLE', `${queryId} is unavailable: ${reason}`, 409, { reason });
    if (!entry.active) throw unavailable(entry.problem ?? 'its plugin is off');
    if (entry.waiting) throw unavailable(`its plugin is turning off after ${this.runningTasks(pluginId)} running task(s)`);
    const queries = entry.active.contributions?.queries;
    const handler = queries && Object.hasOwn(queries, queryId) ? queries[queryId] : undefined;
    if (!handler) throw unknown();
    return { declaration, handler: { run: context => this.guarded(entry, () => Promise.resolve(handler.run(context)), 'QUERY_FAILED') }, signal: entry.active.controller.signal };
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

  reload(id: string): Promise<PluginDescriptor> { return this.exclusive(() => packagesApi.reloadEntry(this.ctx, id)); }
  linkDevelopment(directory: string): Promise<PluginDescriptor> { return packagesApi.linkDevelopment(this.ctx, directory); }
  unlinkDevelopment(id: string): Promise<PluginDescriptor[]> { return packagesApi.unlinkDevelopment(this.ctx, id); }
  descriptors(): Promise<PluginDescriptor[]> { return descriptorsApi.descriptors(this.ctx); }
  workbenchSettingFields(id: string, offset: number, limit: number) { return descriptorsApi.workbenchSettingFields(this.ctx, id, offset, limit); }
  workbenchInventory() { return descriptorsApi.workbenchInventory(this.ctx); }
  developmentFile(id: string, path: string): Promise<{ file: string; type: string }> { return packagesApi.readDevelopmentFile(this.ctx, id, path); }
  install(request: packagesApi.InstallRequest): Promise<PluginDescriptor> { return packagesApi.install(this.ctx, request); }
  selectVersion(id: string, version: string): Promise<PluginDescriptor> { return packagesApi.selectVersion(this.ctx, id, version); }
  uninstallVersion(id: string, version: string): Promise<PluginDescriptor[]> { return packagesApi.uninstallVersion(this.ctx, id, version); }
  uninstall(id: string, options?: { source?: 'installed' | 'development'; path?: string; allowDevelopment?: boolean }): Promise<PluginDescriptor[]> { return packagesApi.uninstall(this.ctx, id, options); }
  deleteData(id: string): Promise<PluginDescriptor[]> { return packagesApi.deleteData(this.ctx, id); }
  runAction(id: string, actionId: string): Promise<ActionStep> { return this.flows.runAction(id, actionId); }
  pollFlow(id: string, flowId: string): Promise<ActionStep> { return this.flows.pollFlow(id, flowId); }
  diagnostics(id: string): Promise<DoctorCheck[]> { return descriptorsApi.diagnostics(this.ctx, id); }
  doctorChecks(): Promise<DoctorCheck[]> { return descriptorsApi.doctorChecks(this.ctx); }

  async update(id: string, input: unknown): Promise<PluginDescriptor> {
    const entry = this.require(id);
    const { patch, force } = descriptorsApi.patchInput(this.ctx, entry, input);
    if (patch.enablement || patch.settings || patch.secrets) this.store.update(id, patch);
    await this.loading;
    // An activation still starting was begun on the old choice.
    if (patch.enablement) entry.starting?.controller.abort();
    // `force` does not wait for running tasks: the turn-off goes ahead now (the tasks carry on), and so does a waiting switch.
    if (force) entry.force = true;
    try { await lifecycle.evaluateAll(this.ctx, [id, ...lifecycle.dependents(this.ctx, id)]); }
    finally { entry.force = false; }
    const switching = entry.waiting?.kind === 'switch' ? entry.waiting : undefined;
    if (force && switching) {
      const failure = await this.exclusive(() => packagesApi.switchVersion(this.ctx, entry, switching.version, true));
      if (failure) throw failure;
    }
    // A setting a source reads can change its catalog without changing whether it is on.
    if (patch.settings || patch.secrets) { if (entry.active) this.invalidate(); this.changed(); }
    return descriptorsApi.describeEntry(this.ctx, entry);
  }

  /** One management change at a time: installs, version switches and removals never interleave. */
  private exclusive<T>(change: () => Promise<T>): Promise<T> {
    const done = this.management.then(change);
    this.management = done.then(() => undefined, () => undefined);
    return done;
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

  private active(): Contributions[] { return [...this.entries.values()].flatMap(entry => (entry.active?.contributions ? [entry.active.contributions] : [])); }
  private require(id: string): Entry { const entry = this.entries.get(id); if (!entry) throw new AppError('INTEGRATION_NOT_FOUND', 'Plugin not found', 404); return entry; }
  private reject(item: Rejected): void { this.rejected.push(item); console.warn(`[riffet] plugin ${item.id} not loaded: ${item.reason}`); }
  private admit(plugin: Plugin): { plugin: Plugin; skipped: { notes: string[]; ids: string[] } } {
    const { manifest, notes, skipped } = loadableManifest(plugin.manifest);
    return { plugin: manifest === plugin.manifest ? plugin : { ...plugin, manifest }, skipped: { notes, ids: skipped } };
  }

  private createHost(manifest: PluginManifest, source: Source, trusted = false): PluginHost {
    const invalidateViews = (topic?: string) => this.emitViewData(manifest.id, topic);
    const host = createPluginHost(manifest.id, source === 'installed' && !trusted ? { ...this.hostOptions, agentProfiles: undefined, completeModel: undefined, streamModel: undefined, ownTaskProviders: (manifest.contributes?.tasks ?? []).map(declared => declared.id), invalidateViews } : {
      ...this.hostOptions, ownAgentBackends: (manifest.contributes?.agentBackends ?? []).map(declared => declared.id),
      ownTaskProviders: (manifest.contributes?.tasks ?? []).map(declared => declared.id),
      ownsSessionSurfaces: Boolean(manifest.contributes?.agentTools?.length || manifest.contributes?.channels?.length),
      ownsAgentTools: Boolean(manifest.contributes?.agentTools?.length),
      ownModelUses: manifest.contributes?.modelUses ?? [],
      invalidateViews,
      ...(this.approvals ? { approvals: this.approvals } : {}),
      ...(this.emitAssistantEvent ? { emitAssistantEvent: this.emitAssistantEvent, ownAssistantEvents: (manifest.contributes?.assistantEvents ?? []).map(declared => declared.id) } : {}),
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
    const reason = taken ?? descriptorsApi.invalidManifest(this.ctx, manifest);
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

  private processFailed(id: string, generation: number, reason: string): void {
    packagesApi.processFailed(this.ctx, id, generation, reason);
  }

  private changed(): void {
    for (const listener of this.changeListeners) {
      try { listener(); } catch (error) { console.warn('[riffet] plugin change listener failed:', describeError(error)); }
    }
  }

  private emitViewData(pluginId: string, topic?: string): void {
    const payload = topic ? { pluginId, topic } : { pluginId };
    for (const listener of this.viewDataListeners) {
      try { listener(payload); } catch (error) { console.warn('[riffet] plugin view-data listener failed:', describeError(error)); }
    }
  }
}
