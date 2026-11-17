import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ActionHandler, ActionOutcome, AvatarStyleProvider, CommandHandler, Contributions, DoctorCheck, Plugin, PluginHost, GatewayProtocol, PluginManifest, PluginStatus,
  ModelSourceBackend, ModelSourceProvider, PluginCommandResult, ResolvedSource, SourceEndpoint, SourceOverrides, TaskDiagnostic, TaskProvider,
} from '@riffet/plugin-api';
import type { ChildContributions, ChildDeviceFlow, HostToChild } from '../../../../packages/plugin-api/src/runtime/protocol.js';
import type { ModelStatus, NativeBackendUsage, UsageWindow } from '@riffet/contracts';
import { confined } from '../plugins/development.js';
import { HostService } from './host-service.js';
import { PluginProcess } from './process.js';
import { requireIsolation } from './sandbox.js';
import { installedModelSourceProblem } from './compat.js';
import { SourceAddresses } from './addresses.js';

// An installed package as an `Plugin`: its server entry runs in a separate process
// (`process.ts`), and what it contributes reaches the registry as proxies that call into it. Only
// what can cross a process boundary as data is supported: model sources, task providers, actions,
// status, doctor checks, commands and avatar styles. Anything else the package returns is refused with its name.

/** Every call to the child ends in failure if it takes longer. */
export const TIMEOUTS = {
  load: 15_000, activate: 30_000, dispose: 8_000, status: 8_000, doctor: 30_000, action: 60_000, poll: 30_000,
  catalog: 60_000, prepare: 30_000, task: 30_000, command: 60_000, avatar: 8_000,
};
/** A resolved model source is fetched again, in the background, once it is this old. */
const RESOLVE_REFRESH_MS = 60_000;
const MAX_RESOLVED = 16;
/** The child aborts a command's `signal` this long before the call's own limit, so a handler that honours it fails cleanly instead of failing the plugin. */
const COMMAND_GRACE_MS = 5_000;

const here = fileURLToPath(new URL('.', import.meta.url));
/** A bundle sits in `dist/` beside the copy `scripts/build.ts` makes; source runs find the file in the package. */
const runtimeCandidates = [resolve(here, 'plugin-runtime.mjs'), resolve(here, '../../../../packages/plugin-api/src/runtime/child.mjs')];

export function runtimeFile(): string {
  for (const candidate of runtimeCandidates) {
    try { return realpathSync(candidate); } catch { /* try the next layout */ }
  }
  throw new Error('the plugin runtime file is missing from this build');
}

type Call = <M extends keyof HostToChild>(method: M, params: HostToChild[M]['params'], timeoutMs: number) => Promise<HostToChild[M]['result']>;

export interface RemoteOptions {
  manifest: PluginManifest;
  /** The selected version's directory. */
  root: string;
  /** The server entry, relative to `root`. A package without one only declares. */
  entry?: string;
  /** What the user granted for the version that runs. */
  granted: readonly string[];
  settings(): Readonly<Record<string, string>>;
  secrets(): Readonly<Record<string, string>>;
  /** The loopback ports the server answers on: a package with `network` may reach every other one, but not these. */
  serverPorts?(): readonly number[];
  /** The process failed while this activation was the live one. */
  onFailure(generation: number, reason: string): void;
}

const stable = (overrides: SourceOverrides): string => JSON.stringify([overrides.apiEndpoint ?? null, overrides.apiKey ?? null]);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
/** A gateway protocol name (`GatewayProtocol`). */
const PROTOCOL = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const line = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\0\r\n]/.test(value);
const httpUrl = (value: unknown): value is string => {
  if (!line(value, 2048)) return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
};

/**
 * What the child's `resolve` may hand the drivers, field by field. A `command` credential is accepted only for a package holding
 * `process.exec` and only naming one of its declared executables (`HostService.credentialCommand`): the Agent CLI itself runs it later,
 * outside the sandbox (Claude Code's `apiKeyHelper`, Codex's `auth.command`, the side-chat key refresh), as the user who runs Riffet.
 */
function resolvedFromChild(value: unknown, label: string, service: HostService): ResolvedSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { reason: `${label}：没有返回结果` };
  const { reason, endpoints, claudeBaseUrl, codexBaseUrl, credential, headers, disableWebsockets } = value as Record<string, unknown>;
  if (typeof reason === 'string' && reason) return { reason: reason.slice(0, 500) };
  const result: ResolvedSource = {};
  if (endpoints && typeof endpoints === 'object' && !Array.isArray(endpoints)) {
    // Where each protocol is reached: the same rules as the older members below, for at most eight protocols.
    const kept = Object.entries(endpoints as Record<string, unknown>).slice(0, 8).flatMap(([protocol, endpoint]): Array<[string, SourceEndpoint]> => {
      if (!PROTOCOL.test(protocol) || !isRecord(endpoint) || !httpUrl(endpoint.baseUrl)) return [];
      const named = isRecord(endpoint.headers)
        ? Object.entries(endpoint.headers).filter(([name, item]) => HEADER_NAME.test(name) && line(item, 4096)).slice(0, 32) as Array<[string, string]>
        : [];
      return [[protocol, { baseUrl: endpoint.baseUrl, ...(named.length ? { headers: Object.fromEntries(named) } : {}) }]];
    });
    if (kept.length) result.endpoints = Object.fromEntries(kept) as ResolvedSource['endpoints'];
  }
  if (httpUrl(claudeBaseUrl)) result.claudeBaseUrl = claudeBaseUrl;
  if (httpUrl(codexBaseUrl)) result.codexBaseUrl = codexBaseUrl;
  if (credential !== undefined) {
    const { kind, key, command, args } = (credential ?? {}) as { kind?: unknown; key?: unknown; command?: unknown; args?: unknown };
    if (kind === 'command') {
      const resolved = service.credentialCommand(command, args);
      if (!resolved) return { reason: `${label}：安装的包只能提供静态密钥` };
      result.credential = resolved;
    } else if (kind !== 'static' || !line(key, 64 * 1024) || !key) return { reason: `${label}：安装的包只能提供静态密钥` };
    else result.credential = { kind: 'static', key };
  }
  if (headers && typeof headers === 'object') {
    for (const backend of ['claude', 'codex'] as const) {
      const set = (headers as Record<string, unknown>)[backend];
      if (!set || typeof set !== 'object') continue;
      const entries = Object.entries(set as Record<string, unknown>).filter(([name, item]) => HEADER_NAME.test(name) && line(item, 4096)).slice(0, 32) as Array<[string, string]>;
      if (entries.length) (result.headers ??= {})[backend] = Object.fromEntries(entries);
    }
  }
  if (disableWebsockets === true) result.disableWebsockets = true;
  return result;
}

// What the child describes and answers reaches the registry, `/api/plugins` and the clients as it is, so
// every shape is checked here: one malformed row must not break the listing a user turns the package off from.
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const optional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value);
const malformed = (what: string) => new Error(`protocol error: ${what} is malformed`);

function describedByChild(raw: unknown): ChildContributions {
  if (!isRecord(raw)) throw malformed('the activation');
  const list = (value: unknown, what: string): unknown[] => { if (!Array.isArray(value) || value.length > 64) throw malformed(what); return value; };
  const hint = (value: unknown) => isRecord(value) && text(value.text, 2000) && optional(value.command, item => text(item, 2000));
  for (const item of list(raw.modelSources, 'a model source')) {
    if (!isRecord(item) || !text(item.id, 64) || !text(item.label, 200) || (item.protocols === undefined && item.backends === undefined)
      || !optional(item.protocols, value => Array.isArray(value) && value.length <= 8 && value.every(protocol => typeof protocol === 'string' && PROTOCOL.test(protocol)))
      || !optional(item.backends, value => Array.isArray(value) && value.every(backend => backend === 'claude' || backend === 'codex'))
      || !optional(item.role, value => value === 'source' || value === 'adapter')
      || !optional(item.defaultEndpoint, httpUrl) || !optional(item.overridable, value => Array.isArray(value) && value.every(key => key === 'apiEndpoint' || key === 'apiKey'))
      || !optional(item.loginAction, value => text(value, 64)) || !optional(item.hint, hint)
      || !optional(item.usage, value => typeof value === 'boolean')) throw malformed('a model source');
  }
  for (const item of list(raw.taskProviders, 'a task provider')) if (!isRecord(item) || !text(item.id, 200) || typeof item.diagnostics !== 'boolean') throw malformed('a task provider');
  for (const item of list(raw.commands, 'a command')) if (!text(item, 200)) throw malformed('a command');
  // Absent from a child written before avatar styles existed.
  for (const item of list(raw.avatarStyles ?? [], 'an avatar style')) if (!text(item, 200)) throw malformed('an avatar style');
  for (const item of list(raw.actions, 'an action')) if (!isRecord(item) || !text(item.id, 64) || !text(item.label, 200) || (item.kind !== 'run' && item.kind !== 'device-flow')) throw malformed('an action');
  if (!list(raw.unsupported, 'the unsupported list').every(item => text(item, 64))) throw malformed('the unsupported list');
  if (typeof raw.status !== 'boolean' || typeof raw.doctorChecks !== 'boolean' || !optional(raw.page, value => typeof value === 'boolean')) throw malformed('the activation');
  return raw as unknown as ChildContributions;
}

function statusFromChild(raw: unknown): PluginStatus {
  if (!isRecord(raw) || !['ready', 'attention', 'unavailable'].includes(raw.state as string) || !optional(raw.message, value => typeof value === 'string')) throw malformed('the status');
  return { state: raw.state as PluginStatus['state'], ...(raw.message ? { message: (raw.message as string).slice(0, 2000) } : {}) };
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const nonnegativeInt = (value: unknown): value is number => nonnegative(value) && Number.isInteger(value) && value <= 2_147_483_647;
const timestamp = (value: unknown): value is string => text(value, 64) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));

/** Quota is data from an installed package, not trusted host state; only the public contract crosses back to clients. */
function usageWindowFromChild(raw: unknown): UsageWindow {
  if (!isRecord(raw) || !nonnegativeInt(raw.usedPercent)
    || !optional(raw.windowMinutes, value => nonnegativeInt(value) && value > 0)
    || !optional(raw.resetsAt, timestamp)) throw malformed('a usage window');
  return {
    usedPercent: raw.usedPercent,
    ...(raw.windowMinutes !== undefined ? { windowMinutes: raw.windowMinutes as number } : {}),
    ...(raw.resetsAt !== undefined ? { resetsAt: new Date(raw.resetsAt as string).toISOString() } : {}),
  };
}

function modelQuotaFromChild(raw: unknown, amount = nonnegativeInt): NonNullable<ModelStatus['quota']> {
  const window = usageWindowFromChild(raw);
  const quota = raw as Record<string, unknown>;
  if (!optional(quota.remaining, amount) || !optional(quota.limit, amount)
    || !optional(quota.depleted, value => typeof value === 'boolean')) throw malformed('a model quota');
  return {
    ...window,
    ...(quota.remaining !== undefined ? { remaining: quota.remaining as number } : {}),
    ...(quota.limit !== undefined ? { limit: quota.limit as number } : {}),
    ...(quota.depleted !== undefined ? { depleted: quota.depleted as boolean } : {}),
  };
}

function usageFromChild(raw: unknown): NativeBackendUsage {
  if (!isRecord(raw) || !timestamp(raw.fetchedAt) || !isRecord(raw.models) || Object.keys(raw.models).length > 4096) throw malformed('the usage');
  let account: NativeBackendUsage['account'];
  if (raw.account !== undefined) {
    const value = raw.account;
    if (!isRecord(value) || !optional(value.plan, item => text(item, 256)) || !Array.isArray(value.windows) || value.windows.length > 64
      || !optional(value.limitReached, item => typeof item === 'boolean')) throw malformed('the account usage');
    let credits: NonNullable<NativeBackendUsage['account']>['credits'];
    if (value.credits !== undefined) {
      const credit = value.credits;
      if (!isRecord(credit) || !optional(credit.balance, finite) || !optional(credit.unlimited, item => typeof item === 'boolean')) throw malformed('the account credits');
      credits = {
        ...(credit.balance !== undefined ? { balance: credit.balance as number } : {}),
        ...(credit.unlimited !== undefined ? { unlimited: credit.unlimited as boolean } : {}),
      };
    }
    account = {
      ...(value.plan !== undefined ? { plan: value.plan as string } : {}),
      windows: value.windows.map(usageWindowFromChild),
      ...(credits !== undefined ? { credits } : {}),
      ...(value.limitReached !== undefined ? { limitReached: value.limitReached as boolean } : {}),
    };
  }
  const models = Object.fromEntries(Object.entries(raw.models).map(([id, value]): [string, ModelStatus] => {
    if (!text(id, 512) || !isRecord(value) || !optional(value.loadPercent, nonnegativeInt)
      || !optional(value.quotaLimited, item => typeof item === 'boolean') || !optional(value.dailyQuotaKey, item => text(item, 256))) throw malformed('a model usage');
    const quota = value.quota === undefined ? undefined : modelQuotaFromChild(value.quota);
    const daily = value.dailyQuota === undefined ? undefined : modelQuotaFromChild(value.dailyQuota, nonnegative);
    if (daily && (daily.remaining === undefined || daily.limit === undefined)) throw malformed('a daily model quota');
    return [id, {
      ...(value.loadPercent !== undefined ? { loadPercent: value.loadPercent as number } : {}),
      ...(quota !== undefined ? { quota } : {}),
      ...(value.quotaLimited !== undefined ? { quotaLimited: value.quotaLimited as boolean } : {}),
      ...(value.dailyQuotaKey !== undefined ? { dailyQuotaKey: value.dailyQuotaKey as string } : {}),
      ...(daily !== undefined ? { dailyQuota: { ...daily, remaining: daily.remaining!, limit: daily.limit! } } : {}),
    }];
  }));
  return { ...(account ? { account } : {}), models, fetchedAt: new Date(raw.fetchedAt).toISOString() };
}

function checksFromChild(raw: unknown): DoctorCheck[] {
  if (!Array.isArray(raw) || raw.length > 64) throw malformed('the doctor checks');
  return raw.map(item => {
    if (!isRecord(item) || !text(item.id, 200) || !text(item.label, 200) || !['ok', 'warn', 'fail'].includes(item.status as string) || typeof item.detail !== 'string' || !optional(item.fix, value => typeof value === 'string')) throw malformed('a doctor check');
    return { id: item.id, label: item.label, status: item.status as DoctorCheck['status'], detail: item.detail.slice(0, 2000), ...(item.fix ? { fix: (item.fix as string).slice(0, 2000) } : {}) };
  });
}

function outcomeFromChild(raw: unknown): ActionOutcome {
  if (isRecord(raw)) {
    if (raw.kind === 'done' || raw.kind === 'pending' || raw.kind === 'slow_down') return { kind: raw.kind };
    if (raw.kind === 'failed' && typeof raw.message === 'string') return { kind: 'failed', message: raw.message.slice(0, 2000) };
    if (raw.kind === 'hint' && typeof raw.text === 'string' && optional(raw.command, value => typeof value === 'string')) return { kind: 'hint', text: raw.text.slice(0, 2000), ...(raw.command ? { command: (raw.command as string).slice(0, 2000) } : {}) };
  }
  throw malformed('an action outcome');
}

/** What a command's `open` may name: a view or conversation id, or a path inside the project (never absolute, never leaving it). */
const projectRelative = (value: unknown): value is string => text(value, 1024) && !/[\0\\]/.test(value) && !value.startsWith('/') && !/^[a-zA-Z]:/.test(value) && !value.split('/').includes('..');

function commandResultFromChild(raw: unknown): PluginCommandResult {
  if (isRecord(raw)) {
    if (raw.kind === 'done') {
      const message = raw.message;
      if (message === undefined) return { kind: 'done' };
      if (isRecord(message)) {
        const entries = Object.entries(message);
        if (entries.length <= 16 && entries.every(([tag, value]) => tag.length > 0 && tag.length <= 35 && typeof value === 'string' && value.length <= 500)) return { kind: 'done', message: Object.fromEntries(entries) as Record<string, string> };
      }
    }
    if (raw.kind === 'open' && optional(raw.view, value => text(value, 200)) && optional(raw.sessionId, value => text(value, 200)) && optional(raw.path, projectRelative) && (raw.view ?? raw.sessionId ?? raw.path) !== undefined) {
      return { kind: 'open', ...(raw.view ? { view: raw.view as string } : {}), ...(raw.sessionId ? { sessionId: raw.sessionId as string } : {}), ...(raw.path ? { path: raw.path as string } : {}) };
    }
    if (raw.kind === 'task' && text(raw.taskId, 200)) return { kind: 'task', taskId: raw.taskId };
    // The length and title are checked again by the command service, as for an in-process plugin.
    if (raw.kind === 'text' && typeof raw.text === 'string' && optional(raw.title, isRecord)) return { kind: 'text', text: raw.text, ...(raw.title ? { title: raw.title as Record<string, string> } : {}) };
  }
  throw malformed('a command result');
}

class RemoteModelSource implements ModelSourceProvider {
  readonly role?: 'source' | 'adapter';
  readonly id: string;
  readonly label: string;
  readonly protocols?: readonly GatewayProtocol[];
  readonly backends?: readonly ModelSourceBackend[];
  readonly defaultEndpoint?: string;
  readonly overridable?: ReadonlyArray<keyof SourceOverrides>;
  readonly loginAction?: string;
  readonly hint?: { text: string; command?: string };
  readonly usage?: ModelSourceProvider['usage'];
  private readonly resolved = new Map<string, { value: ResolvedSource; at: number }>();
  private readonly preparing = new Map<string, Promise<void>>();

  constructor(description: ChildContributions['modelSources'][number], private readonly call: Call, private readonly addresses: SourceAddresses, private readonly service: HostService) {
    this.id = description.id; this.label = description.label;
    if (description.role) this.role = description.role;
    if (description.defaultEndpoint && !addresses.allows(description.id, description.defaultEndpoint, {})) throw new Error(`model source ${description.id}: its default endpoint is not among the hosts it declares`);
    if (description.protocols) this.protocols = description.protocols;
    if (description.backends) this.backends = description.backends;
    if (description.defaultEndpoint) this.defaultEndpoint = description.defaultEndpoint;
    if (description.overridable) this.overridable = description.overridable;
    if (description.loginAction) this.loginAction = description.loginAction;
    if (description.hint) this.hint = description.hint;
    if (description.usage) this.usage = async overrides => usageFromChild(await this.addresses.during(overrides, () => this.call('modelSource.usage', { id: this.id, overrides }, TIMEOUTS.catalog)));
  }

  /** Synchronous, so it answers from the last `prepare` for these overrides; a miss starts one and says the source is not ready. */
  resolve(overrides: SourceOverrides): ResolvedSource {
    const hit = this.resolved.get(stable(overrides));
    if (!hit || Date.now() - hit.at > RESOLVE_REFRESH_MS) void this.prepare(overrides).catch(() => undefined);
    if (!hit) return { reason: `${this.label}：尚未准备好` };
    // Checked on every answer, not once when fetched: the settings an address may come from change while the answer is cached.
    return this.declaredOnly(hit.value, overrides);
  }

  /** A source that declares hosts is held to them (and to what the user typed): an address outside never reaches a driver. */
  private declaredOnly(value: ResolvedSource, overrides: SourceOverrides): ResolvedSource {
    const addresses = [...Object.values(value.endpoints ?? {}).map(endpoint => endpoint?.baseUrl), value.claudeBaseUrl, value.codexBaseUrl];
    const outside = addresses.find(address => address !== undefined && !this.addresses.allows(this.id, address, overrides));
    return outside === undefined ? value : { reason: `${this.label}：地址不在插件声明的主机内` };
  }

  prepare(overrides: SourceOverrides): Promise<void> {
    const key = stable(overrides);
    let running = this.preparing.get(key);
    if (!running) {
      running = this.addresses.during(overrides, () => this.call('modelSource.prepare', { id: this.id, overrides }, TIMEOUTS.prepare))
        .then(value => {
          this.resolved.delete(key);
          this.resolved.set(key, { value: resolvedFromChild(value, this.label, this.service), at: Date.now() });
          while (this.resolved.size > MAX_RESOLVED) this.resolved.delete(this.resolved.keys().next().value!);
        })
        .finally(() => { this.preparing.delete(key); });
      this.preparing.set(key, running);
    }
    return running;
  }

  async catalog(backend: ModelSourceBackend, overrides: SourceOverrides) {
    await this.prepare(overrides).catch(() => undefined);
    return this.addresses.during(overrides, () => this.call('modelSource.catalog', { id: this.id, backend, overrides }, TIMEOUTS.catalog));
  }
}

function mapDiagnostics(raw: unknown, relativize: (path: string) => string | undefined): TaskDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): TaskDiagnostic[] => {
    if (!item || typeof item !== 'object') return [];
    const { severity, message, file, line, column } = item as Record<string, unknown>;
    if ((severity !== 'error' && severity !== 'warning') || typeof message !== 'string') return [];
    // The child cannot know where the project is: it reports the path as the log printed it, and only a path inside the project survives.
    const inside = typeof file === 'string' ? relativize(file) : undefined;
    return [{ severity, message, ...(inside ? { file: inside, ...(typeof line === 'number' ? { line } : {}), ...(typeof column === 'number' ? { column } : {}) } : {}) }];
  });
}

/** The `Plugin` that starts a process for the selected version of an installed package. Trust is decided by the registry, which is the only caller. */
export function remotePlugin(options: RemoteOptions): Plugin {
  const { manifest } = options;
  return {
    manifest,
    async activate(host: PluginHost, scope): Promise<Contributions> {
      const entry = options.entry ? await confined(await realpath(options.root), options.entry) : undefined;
      if (!entry) return {};
      const packageRoot = await realpath(options.root);
      const stateDir = await realpath(await host.stateDir());
      // Refuses here, before any process exists, when this machine cannot isolate one and the operator has not accepted that.
      const isolation = await requireIsolation();
      const addresses = new SourceAddresses(manifest, options.settings, () => options.serverPorts?.() ?? []);
      const service = new HostService(host, new Set(options.granted), addresses, {
        executables: options.granted.includes('process.exec') ? manifest.executables ?? [] : [], roots: [packageRoot, stateDir], stateDir,
        modelSources: (manifest.contributes?.modelSources ?? []).map(source => source.id),
      });
      const child = new PluginProcess({
        runtime: runtimeFile(), packageRoot, stateDir, network: options.granted.includes('network'),
        ...(isolation.kind === 'os' ? { sandbox: { node: isolation.node, libraries: isolation.libraries, network: options.granted.includes('network'), withhold: options.serverPorts?.() ?? [] } } : {}),
        serve: (method, params) => service.serve(method, params),
        onFailure: reason => options.onFailure(scope.generation, reason),
        onLog: message => host.logger?.info(message),
      });
      // Registered first, so it runs last: after `dispose` has had its say, whatever is left of the process goes.
      scope.onDispose(() => child.stop());

      let sent = '';
      const call: Call = async (method, params, timeoutMs) => {
        // Settings and secrets change while it runs; the child is told before the call that may read them.
        const facts = service.facts();
        const state = JSON.stringify([options.settings(), options.secrets(), facts]);
        if (state !== sent && method !== 'load') {
          sent = state;
          await child.call('state', { settings: { ...options.settings() }, secrets: { ...options.secrets() }, ...facts }, TIMEOUTS.status);
        }
        return child.call(method, params, timeoutMs);
      };

      const facts = service.facts();
      sent = JSON.stringify([options.settings(), options.secrets(), facts]);
      await child.call('load', { entry, pluginId: manifest.id, stateDir, settings: { ...options.settings() }, secrets: { ...options.secrets() }, ...facts, granted: [...options.granted] }, TIMEOUTS.load);
      const description = describedByChild(await child.call('activate', { generation: scope.generation }, TIMEOUTS.activate));

      // A profile names a model source by id alone, and these hold a profile's API key: an installed package may only provide ids in its own namespace (`<pluginId>.<name>`), never one a built-in source has or could have (those have no dot), whether or not that built-in is on.
      for (const { id } of description.modelSources) {
        const problem = installedModelSourceProblem(manifest.id, id);
        if (problem) throw new Error(problem);
      }
      if (description.unsupported.length) throw new Error(`${description.unsupported.join(', ')} cannot be provided by an installed package in this version (agent backends and share publishers need a trusted package)`);
      if (description.modelSources.length) service.need('models.provide');
      if (description.taskProviders.length) service.need('tasks.run');

      const contributions: Contributions = {
        dispose: async () => {
          if (!child.alive) return;
          const { failures } = await child.call('dispose', {}, TIMEOUTS.dispose);
          if (failures.length) throw new Error(failures.join('; '));
        },
      };
      if (description.modelSources.length) {
        const sources = description.modelSources.map(item => new RemoteModelSource(item, call, addresses, service));
        contributions.modelSources = sources;
        // The defaults every profile without overrides resolves with.
        for (const source of sources) void source.prepare({}).catch(() => undefined);
      }
      if (description.taskProviders.length) {
        contributions.taskProviders = description.taskProviders.map((item): TaskProvider => ({
          id: item.id,
          detect: async project => (await service.withProject(project, handle => call('task.detect', { provider: item.id, project: handle }, TIMEOUTS.task))) === true,
          actions: async project => service.withProject(project, handle => call('task.actions', { provider: item.id, project: handle }, TIMEOUTS.task)),
          plan: async (action, taskParams, project) => service.withProject(project, handle => call('task.plan', { provider: item.id, action, taskParams, project: handle }, TIMEOUTS.task)),
          ...(item.diagnostics ? {
            diagnostics: async (logTail, context) => mapDiagnostics(await call('task.diagnostics', { provider: item.id, logTail }, TIMEOUTS.task), path => context.relativize(path)),
          } : {}),
        }));
      }
      if (description.actions.length) {
        contributions.actions = Object.fromEntries(description.actions.map((item): [string, ActionHandler] => [item.id, {
          label: item.label, kind: item.kind,
          async run() {
            const outcome: unknown = await call('action.run', { id: item.id }, TIMEOUTS.action);
            if (!isRecord(outcome) || outcome.kind !== 'device-flow') return outcomeFromChild(outcome);
            const started = outcome as unknown as ChildDeviceFlow;
            if (!text(started.verificationUri, 2048) || !optional(started.userCode, value => text(value, 200)) || !Number.isFinite(started.intervalMs) || !Number.isFinite(started.expiresAt) || !text(started.flow, 64)) throw malformed('a sign-in');
            return {
              kind: 'device-flow', verificationUri: started.verificationUri, ...(started.userCode ? { userCode: started.userCode } : {}), intervalMs: started.intervalMs, expiresAt: started.expiresAt,
              poll: async () => outcomeFromChild(await call('flow.poll', { flow: started.flow }, TIMEOUTS.poll)),
            };
          },
        }]));
      }
      if (description.commands.length) {
        contributions.commands = Object.fromEntries(description.commands.map((id): [string, CommandHandler] => [id, {
          async run(context) {
            const { projectId, sessionId, args, message, locale } = context;
            return commandResultFromChild(await call('command.run', {
              id, ...(projectId ? { projectId } : {}), ...(sessionId ? { sessionId } : {}), args: { ...args }, ...(message ? { message: { ...message } } : {}), ...(locale ? { locale } : {}), timeoutMs: TIMEOUTS.command - COMMAND_GRACE_MS,
            }, TIMEOUTS.command));
          },
        }]));
      }
      if (description.avatarStyles?.length) {
        contributions.avatarStyles = Object.fromEntries(description.avatarStyles.map((id): [string, AvatarStyleProvider] => [id, {
          async generate(request) {
            const svg: unknown = await call('avatar.generate', { id, request }, TIMEOUTS.avatar);
            if (typeof svg !== 'string') throw malformed('an avatar');
            return svg;
          },
        }]));
      }
      if (description.status) contributions.status = async () => statusFromChild(await call('status', {}, TIMEOUTS.status));
      if (description.doctorChecks) contributions.doctorChecks = async () => checksFromChild(await call('doctorChecks', {}, TIMEOUTS.doctor));
      // The registry checks the page, for every package alike.
      if (description.page) {
        contributions.page = {
          read: async ({ locale }) => await call('page.read', { locale }, TIMEOUTS.status) as never,
          run: async ({ locale }, action, item) => {
            const outcome: unknown = await call('page.run', { locale, action, ...(item !== undefined ? { item } : {}) }, TIMEOUTS.action);
            return isRecord(outcome) && typeof outcome.message === 'string' ? { message: outcome.message } : {};
          },
        };
      }
      if (isolation.kind === 'none') {
        // Shown for as long as the package runs: its own status can add to the warning, never hide it.
        const own = contributions.status;
        const ownChecks = contributions.doctorChecks;
        contributions.status = async () => {
          // A status that fails is left out, so a package cannot replace the warning with an error of its own.
          const reported = await own?.().catch(() => undefined);
          return { state: reported?.state === 'unavailable' ? 'unavailable' : 'attention', message: [isolation.warning, reported?.message].filter(Boolean).join(' · ') };
        };
        contributions.doctorChecks = async () => [
          { id: 'isolation', label: 'Process isolation', status: 'warn', detail: isolation.warning, fix: 'Run Riffet on macOS to isolate installed packages.' },
          ...(await ownChecks?.().catch(() => undefined) ?? []),
        ];
      }
      return contributions;
    },
  };
}
