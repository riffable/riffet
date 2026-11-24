import type { Contributions, DoctorCheck, PluginManifest } from '@riffet/plugin-api';
import { protocolBackends, sourceProtocols } from '@riffet/plugin-api/kit';
import { AGENT_PROTOCOL_VERSION } from '@riffet/plugin-api/experimental/agent';
import type { InstalledPluginInfo, ModelSourceDescriptor, PluginDescriptor, PluginEnablement, PluginStatus } from '../../../../packages/contracts/src/index.js';
import { PLUGIN_ID } from '../../../../packages/contracts/src/plugins.js';
import { AppError } from '../errors.js';
import { compatibility, requestedCapabilities } from '../plugins-host/compat.js';
import { MODEL_SOURCE_ID } from '../settings/index.js';
import { apiVersionProblem, checkManifest, grantExecutables, knownDeclarations, loadableManifest } from './declarations.js';
import {
  bounded, claimLabel, claims, describeError, ENABLEMENTS, MODEL_SOURCE_CLAIM,
  SERVICE_NAME, SERVICE_VERSION, type Activation, type Entry, type RegistryContext,
} from './entry.js';
import type { PluginItem, PluginItemPatch } from './store.js';

/** What is wrong with a manifest as a candidate for entry `own` (or a new one), before it is trusted with an id or a contribution. */
export function invalidManifest(ctx: RegistryContext, manifest: PluginManifest, own?: string): string | undefined {
  const id = String(manifest.id);
  const valid = apiVersionProblem(manifest.apiVersion)
    ?? (!PLUGIN_ID.test(id) || id.length > 64 ? 'invalid id' : checkManifest(manifest, 'load'));
  if (valid) return valid;
  // What this host leaves out of the manifest claims no id.
  const clash = claims(loadableManifest(manifest).manifest).find(declared => ctx.declared.has(declared) && ctx.declared.get(declared) !== own);
  return clash ? `${claimLabel(clash)} is already declared by ${ctx.declared.get(clash)}` : undefined;
}

/** A profile names a source by id alone, so two providers of one id would be ambiguous. */
export function checkedContributions(ctx: RegistryContext, contributions: Contributions, manifest: PluginManifest, skipped: readonly string[] = []): void {
  const taken = new Set(ctx.active().flatMap(contribution => contribution.modelSources ?? []).map(source => source.id));
  for (const source of contributions.modelSources ?? []) {
    // A plugin that declares the id statically owns it, whether or not it is active yet.
    const owner = ctx.declared.get(MODEL_SOURCE_CLAIM + source.id);
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
  if (contributions.approvals !== undefined && typeof contributions.approvals?.decide !== 'function') throw new Error('approvals has no decide()');
  // A command is run by its id from the declaration: each handler must be declared by this integration.
  for (const [commandId, handler] of Object.entries(contributions.commands ?? {})) {
    // A command this host left out of the manifest stays unrunnable (`command()` finds no declaration); its handler is not an error.
    if (skipped.includes(commandId)) continue;
    if (!manifest.contributes?.commands?.some(declared => declared.id === commandId) || typeof handler?.run !== 'function') throw new Error(`command "${commandId}" is not declared in contributes.commands or has no run()`);
  }
  for (const [queryId, handler] of Object.entries(contributions.queries ?? {})) {
    if (skipped.includes(queryId)) continue;
    if (!manifest.contributes?.queries?.some(declared => declared.id === queryId) || typeof handler?.run !== 'function') throw new Error(`query "${queryId}" is not declared in contributes.queries or has no run()`);
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
  for (const [channelId, provider] of Object.entries(contributions.imChannels ?? {})) {
    if (!manifest.contributes?.imChannels?.some(declared => declared.id === channelId) || typeof provider?.connect !== 'function' || typeof provider.links !== 'function') throw new Error(`IM channel "${channelId}" is not declared in contributes.imChannels or has no connect() and links()`);
  }
  for (const [name, service] of Object.entries(contributions.services ?? {})) {
    if (!SERVICE_NAME.test(name) || !service || typeof service !== 'object' || typeof service.version !== 'string' || !SERVICE_VERSION.test(service.version)) throw new Error(`service "${name}" needs a name like "scan" and a version like "1.0.0"`);
  }
  // An Agent is a persisted identity: each must be declared by this plugin, versioned for this host, and neither provided by the core nor by another integration.
  const agents = new Set(ctx.agentBackends().map(({ backend }) => String(backend.id)));
  for (const backend of contributions.agentBackends ?? []) {
    const id = String(backend.id);
    if (backend.protocolVersion !== AGENT_PROTOCOL_VERSION) throw new Error(`agent backend "${id}" was written for agent protocol v${String(backend.protocolVersion)}; this Riffet provides v${AGENT_PROTOCOL_VERSION}`);
    if (!manifest.contributes?.agentBackends?.some(declared => declared.id === id)) throw new Error(`agent backend "${id}" is not declared in contributes.agentBackends`);
    if (agents.has(id) || ctx.agentBackendProvided(id)) throw new Error(`agent backend "${id}" is already provided`);
    agents.add(id);
  }
}

export function developmentLinked(ctx: RegistryContext, id: string, root?: string): boolean {
  try { const saved = ctx.store.developmentPackages()[id]; return Boolean(saved && (!root || saved === root)); } catch { return false; }
}

export async function installedInfo(ctx: RegistryContext, id: string): Promise<InstalledPluginInfo | undefined> {
  let record;
  try { record = ctx.packages.record(id); } catch { return undefined; }
  if (!record) return undefined;
  const [dataVersion, backups, hasData] = await Promise.all([ctx.packages.dataVersion(id), ctx.packages.backups(id), ctx.packages.hasData(id)]);
  return {
    selected: record.selected, hasData,
    versions: [...record.versions].sort((a, b) => (a.installedAt < b.installedAt ? 1 : -1)).map(item => ({ ...item, selected: item.version === record.selected })),
    ...(dataVersion !== undefined ? { dataVersion } : {}),
    ...(backups.length ? { backups: backups.map(item => item.name) } : {}),
  };
}

export function available(ctx: RegistryContext, entry: Entry): boolean {
  return Boolean(entry.active) || (ctx.isLazy(entry) && ctx.permitted(entry) && entry.allowed !== false);
}

/**
 * The plugin's `status()`, which a list read must not wait on for long: after the timeout the last answer stands in (or a note that
 * there is none yet), and the call is not made again while it is still out.
 */
async function statusOf(ctx: RegistryContext, activation: Activation): Promise<PluginStatus | undefined> {
  const contributions = activation.contributions;
  if (!contributions?.status) return undefined;
  const call = activation.statusCall ??= Promise.resolve().then(() => contributions.status!())
    .then(status => { activation.statusLast = status; return status; })
    .finally(() => { activation.statusCall = undefined; });
  let timer: NodeJS.Timeout | undefined;
  const timedOut = Symbol('timeout');
  try {
    const answer = await Promise.race([call, new Promise<typeof timedOut>(resolve => { timer = setTimeout(() => resolve(timedOut), ctx.statusTimeoutMs); timer.unref(); })]);
    return answer === timedOut ? activation.statusLast ?? { state: 'attention', message: 'status timed out' } : answer;
  } catch (error) { return { state: 'unavailable', message: describeError(error) }; }
  finally { clearTimeout(timer); }
}

export async function describeEntry(ctx: RegistryContext, entry: Entry): Promise<PluginDescriptor> {
  const { manifest } = entry.plugin;
  let item: PluginItem | undefined;
  try { item = ctx.store.item(manifest.id); } catch { /* reported through `storeProblem` */ }
  const contributions = entry.active?.contributions;
  const problem = ctx.storeProblem ?? entry.problem ?? entry.cleanup;
  const waiting = entry.active ? entry.waiting : undefined;
  const running = waiting ? ctx.runningTasks(manifest.id) : 0;
  const rawStatus: PluginStatus | undefined = problem ? { state: 'unavailable', message: problem }
    : waiting ? { state: 'attention', message: `Waiting for ${running} running task${running === 1 ? '' : 's'} to end before ${waiting.kind === 'off' ? 'turning off' : `switching to version ${waiting.version}`}` }
    : entry.note ? { state: 'attention', message: entry.note }
    : entry.active ? await statusOf(ctx, entry.active) : undefined;
  const status = rawStatus?.message ? { ...rawStatus, message: ctx.journal.redact(manifest.id, rawStatus.message) } : rawStatus;
  const isAvailable = available(ctx, entry);
  const declaredSources = entry.plugin.manifest.contributes?.modelSources ?? [];
  // Static metadata survives disablement so a saved profile can still identify its gateway type.
  // These descriptors do not register a usable provider: modelSources() and enabled keep that boundary.
  const sourceProviders = contributions?.modelSources
    ?? (isAvailable ? ctx.modelSources().filter(source => declaredSources.some(declared => declared.id === source.id)) : undefined)
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
  const installed = entry.source === 'installed' ? await installedInfo(ctx, manifest.id) : undefined;
  const compat = compatibility(manifest);
  // What a view of this package may ask of the web bridge: the grant of the selected version, or for a trusted development package what it asks for.
  const held = installed ? installed.versions.find(version => version.selected)?.capabilities : entry.source === 'development' ? requestedCapabilities(manifest) : undefined;
  return {
    id: manifest.id, vendor: manifest.vendor, name: manifest.name, enabled: isAvailable, active: Boolean(entry.active), enablement: item?.enablement ?? 'auto',
    activation: { events: ctx.events(entry), state: entry.starting ? 'activating' : entry.active ? 'active' : entry.problem ? 'failed' : 'idle', ...entry.runtime },
    execution: { location: 'server', mode: entry.server || (entry.source === 'builtin' && manifest.contributes?.agentBackends?.length) ? entry.source !== 'installed' || entry.trusted ? 'in-process' : 'isolated' : 'resources', platform: process.platform },
    source: entry.source,
    ...(entry.source === 'development' && entry.root ? { developmentPath: entry.root } : {}),
    ...(entry.source === 'development' && developmentLinked(ctx, manifest.id, entry.root) ? { developmentLinked: true } : {}),
    ...(item ? { configRevision: ctx.store.revision(manifest.id) } : {}),
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
    actions: contributions?.actions ? Object.entries(contributions.actions).map(([id, action]) => ({ id, label: action.label, kind: action.kind })) : isAvailable ? manifest.contributes?.actions ?? [] : [],
    contributes: { ...(sources?.length ? { modelSources: sources } : {}), ...(publisher ? { sharePublisher: { label: publisher.label, audience: publisher.audience } } : {}) },
  };
}

/** The last evaluation: nothing is detected here. */
export async function descriptors(ctx: RegistryContext): Promise<PluginDescriptor[]> {
  await ctx.loading();
  const loaded = await Promise.all([...ctx.entries.values()].map(entry => describeEntry(ctx, entry)));
  const rejected = await Promise.all(ctx.rejected.map(async (item): Promise<PluginDescriptor> => {
    const installed = item.source === 'installed' ? await installedInfo(ctx, item.id) : undefined;
    return {
      id: item.id, vendor: item.vendor, name: item.name, enabled: false, enablement: 'auto', rejected: true,
      status: { state: 'unavailable', message: item.reason }, settings: [], actions: [], contributes: {},
      ...(item.source ? { source: item.source } : {}),
      ...(item.source === 'development' && developmentLinked(ctx, item.id, item.root) ? { developmentLinked: true } : {}),
      ...(item.source === 'development' && item.root ? { developmentPath: item.root } : {}),
      ...(installed ? { installed } : {}),
    };
  }));
  return [...loaded, ...rejected];
}

export async function describeId(ctx: RegistryContext, id: string): Promise<PluginDescriptor> {
  const entry = ctx.entries.get(id);
  if (entry) return describeEntry(ctx, entry);
  return (await descriptors(ctx)).find(item => item.id === id) ?? (() => { throw new AppError('INTEGRATION_NOT_FOUND', 'Plugin not found', 404); })();
}

/** Read the committed workbench inventory without asking plugins for their status or opening their files. */
export async function workbenchSettingFields(ctx: RegistryContext, id: string, offset: number, limit: number) {
  await ctx.loading();
  const entry = ctx.entries.get(id);
  if (!entry) throw new AppError('PLUGIN_NOT_FOUND', 'There is no installed plugin with this ID', 404);
  const fields = entry.plugin.manifest.settings ?? [];
  const page = fields.slice(offset, offset + limit).map(({ key, label, kind }) => ({ key, label: label.slice(0, 160), kind }));
  return { pluginId: id, section: id, fields: page, total: fields.length, ...(offset + page.length < fields.length ? { nextOffset: offset + page.length } : {}) };
}

export async function workbenchInventory(ctx: RegistryContext) {
  await ctx.loading();
  const plugins = [...ctx.entries.values()].map(entry => {
    const { manifest } = entry.plugin;
    const id: string = manifest.id;
    let enablement: PluginEnablement | 'unknown' = 'unknown';
    try { enablement = ctx.store.enablement(id); } catch { /* an unreadable store has no known choice */ }
    const active = Boolean(entry.active);
    const isAvailable = available(ctx, entry);
    const dependency = entry.problem && entry.allowed
      ? (manifest.requires ?? []).find(requirement => !requirement.optional && !ctx.entries.get(requirement.id)?.active)
      : undefined;
    return {
      id, name: manifest.name, source: entry.source, enablement, active, enabled: isAvailable,
      labels: Object.values(manifest.title ?? {}),
      version: entry.version ?? manifest.version,
      activation: entry.starting ? 'activating' : active ? 'active' : entry.problem ? 'failed' : 'idle',
      reason: entry.waiting ? 'waiting_for_tasks' : enablement === 'unknown' ? 'configuration_unavailable' : entry.blocked ? 'unsupported_host'
        : entry.starting ? 'activating' : dependency ? 'dependency_unavailable' : entry.problem ? 'activation_failed'
          : active ? null : isAvailable ? 'not_activated' : entry.evaluated || enablement === 'off' ? 'disabled' : 'not_evaluated',
      activatedAt: entry.runtime?.activatedAt,
      health: entry.active?.statusLast?.state,
      toolGroups: (manifest.contributes?.agentTools ?? []).map(({ id }) => id),
    };
  });
  const ids = new Set<string>(plugins.map(plugin => plugin.id));
  for (const item of ctx.rejected) {
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

/** Notes for a plugin whose runtime hook for a backend is tried after another enabled plugin's. */
function hookNotes(ctx: RegistryContext, id: string): DoctorCheck[] {
  const entry = ctx.entries.get(id);
  const hooked = (item: Entry) => (item.active?.contributions?.runtimeHooks ?? []).map(hook => hook.backendId);
  if (!entry) return [];
  const notes: DoctorCheck[] = [];
  for (const backendId of new Set(hooked(entry))) {
    const first = [...ctx.entries.values()].find(item => hooked(item).includes(backendId));
    if (first && first !== entry) notes.push({ id: `${id}:hook:${backendId}`, label: entry.plugin.manifest.name, status: 'warn', detail: `runtime hook for ${backendId} is tried after ${first.plugin.manifest.id}` });
  }
  return notes;
}

/** Explicit per-plugin diagnostics never probe or activate other packages. */
export async function diagnostics(ctx: RegistryContext, id: string): Promise<DoctorCheck[]> {
  await ctx.loading();
  const rejected = ctx.rejected.find(item => item.id === id);
  if (!ctx.entries.has(id) && rejected) return [{ id, label: rejected.name, status: 'fail', detail: rejected.reason }];
  const entry = ctx.require(id);
  const checks: DoctorCheck[] = [
    ...[entry.problem, entry.cleanup, entry.note, ...(entry.skipped?.notes ?? []), ctx.packProblems.get(id)].filter((value): value is string => Boolean(value)).map((detail, index) => ({ id: id + ':' + index, label: entry.plugin.manifest.name, status: 'warn' as const, detail })),
  ];
  checks.push(...hookNotes(ctx, id));
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

export async function doctorChecks(ctx: RegistryContext): Promise<DoctorCheck[]> {
  await ctx.refresh();
  const checks: DoctorCheck[] = ctx.rejected.map(item => ({ id: `integration:${item.id}`, label: `${item.name} (${item.id})`, status: 'warn', detail: `not loaded: ${item.reason}` }));
  if (ctx.packagesProblem) checks.push({ id: 'integrations:packages', label: 'Installed packages', status: 'warn', detail: ctx.packagesProblem, fix: `Fix or remove ${ctx.packages.file}.` });
  if (ctx.storeProblem) checks.push({ id: 'integrations', label: 'Plugins', status: 'warn', detail: `${ctx.store.path} is unreadable, so every plugin is off`, fix: `Fix or remove ${ctx.store.path}.` });
  for (const entry of ctx.entries.values()) {
    const { manifest } = entry.plugin;
    const label = `${manifest.name} (${manifest.id})`;
    for (const detail of [entry.problem, entry.cleanup, entry.note, ...(entry.skipped?.notes ?? []), ctx.packProblems.get(manifest.id)]) if (detail) checks.push({ id: `integration:${manifest.id}`, label, status: 'warn', detail });
    for (const note of hookNotes(ctx, manifest.id)) checks.push({ ...note, id: `integration:${manifest.id}`, label });
    const run = entry.active?.contributions?.doctorChecks;
    if (!run) continue;
    try { for (const check of await run()) checks.push({ ...check, id: `integration:${manifest.id}:${check.id}` }); }
    catch (error) { checks.push({ id: `integration:${manifest.id}`, label, status: 'warn', detail: `checks failed: ${describeError(error)}` }); }
  }
  return checks;
}

export function patchInput(ctx: RegistryContext, entry: Entry, input: unknown): { patch: PluginItemPatch; force: boolean } {
  const invalid = (message: string) => new AppError('INVALID_INTEGRATION_UPDATE', message);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Expected an object');
  const { enablement, settings, force, configRevision, ...rest } = input as Record<string, unknown>;
  if (Object.keys(rest).length) throw invalid(`Unknown field ${Object.keys(rest)[0]}`);
  if (force !== undefined && typeof force !== 'boolean') throw invalid('force must be true or false');
  if (configRevision !== undefined && (typeof configRevision !== 'string' || configRevision !== ctx.store.revision(entry.plugin.manifest.id))) throw new AppError('PLUGIN_CONFIG_CONFLICT', 'Plugin configuration changed; reload it before saving', 409);
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
