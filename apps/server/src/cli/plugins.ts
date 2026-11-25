import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { validatePackage, watchPlugin, type PluginBuildResult } from '../../../../packages/plugin-api/src/tooling.js';
import { claimStateDirectory } from '../compat.js';
import { PluginStore } from '../plugins/store.js';
import type { PluginDescriptor } from '../../../../packages/contracts/src/index.js';
import type { PairingDaemon } from './pair.js';
import { Api } from './api.js';
import { MARK, columns, out, spinning, tilde, type Status } from './ui.js';
import { AppError } from '../errors.js';
import { PackageStore, checkExpected, type PackageInput } from '../plugins-host/packages.js';
import { addMarketSource, checkMarketSource, checkSourceAddress, downloadMarketPackage, findMarketSource, installedPackages, listMarket, marketRecord, marketSourceId, marketSources, parseMarketReference, removeMarketSource, resolveMarketPackage, setMarketSourceEnabled, type MarketOptions, type MarketPackage, type MarketReference } from '../plugins-host/market.js';
import { buildRegistry, writeIndex } from '../plugins-host/index-builder.js';
import type { PluginMarketList, PluginSource } from '../../../../packages/contracts/src/index.js';
import { developmentDirectories, readPackage } from '../plugins/development.js';
import { PluginLogs } from '../plugins/logs.js';
import { PLUGIN_ID } from '../../../../packages/contracts/src/plugins.js';
import type { PluginLogEntry } from '../../../../packages/contracts/src/plugin-management.js';

// `riffet plugin ...`: installing and managing plugin packages from a terminal. A running server does
// the work (so the new version starts or is undone in the process that serves it); without one, the
// files and records are changed directly and take effect at the next start.

export interface PluginCliContext {
  stateDir: string;
  /** The running server, if there is one. */
  daemon?: PairingDaemon;
  token(): string;
}

/** A local developer explicitly trusts this directory; package code is never imported offline. */
export async function linkDevelopmentPlugin(context: PluginCliContext, directory: string): Promise<{ id: string; online: boolean }> {
  const path = realpathSync(resolve(directory));
  if (context.daemon) {
    const reply = await (await connect(context.daemon, context.token()))('POST', '/api/integrations/development', { path });
    if (reply.status !== 200) fail(reply);
    return { id: (reply.body as unknown as PluginDescriptor).id, online: true };
  }
  const { manifest } = await validatePackage(path);
  const id = String(manifest.id);
  if ((await import('../plugins/registry.js')).isBuiltinPlugin(id)) throw new AppError('PLUGIN_ID_TAKEN', `${id} is a built-in plugin`, 409);
  mkdirSync(context.stateDir, { recursive: true, mode: 0o700 });
  const release = claimStateDirectory(context.stateDir);
  try {
    if (new PackageStore(context.stateDir).record(id)) throw new AppError('PLUGIN_ID_TAKEN', `${id} is installed; remove its installed versions before linking development code`, 409);
    const store = new PluginStore(context.stateDir);
    const linked = store.developmentPackages();
    if ((linked[id] && linked[id] !== path) || Object.entries(linked).some(([otherId, root]) => otherId !== id && root === path)) throw new AppError('PLUGIN_ID_TAKEN', 'A different development package is already linked; unlink it first', 409);
    if (linked[id] !== path) store.setDevelopmentPackage(id, path);
  } finally { release(); }
  return { id, online: false };
}

export async function unlinkDevelopmentPlugin(context: PluginCliContext, id: string): Promise<string[]> {
  if (!PLUGIN_ID.test(id) || id.length > 64) throw new Error('Invalid plugin id.');
  if (context.daemon) {
    const reply = await (await connect(context.daemon, context.token()))('DELETE', `/api/integrations/development/${encodeURIComponent(id)}`);
    if (reply.status !== 200) fail(reply);
  } else {
    mkdirSync(context.stateDir, { recursive: true, mode: 0o700 });
    const release = claimStateDirectory(context.stateDir);
    try { new PluginStore(context.stateDir).setDevelopmentPackage(id, null); } finally { release(); }
  }
  return [done(`Unlinked ${out.bold(id)} ${out.dim('· settings and data are kept')}`)];
}

/** Re-probe the daemon after each build so stopping/starting Riffet needs no watcher restart. */
export async function developPlugin(context: () => Promise<PluginCliContext>, directory: string, report: (message: string) => void, options: { entries?: string[] } = {}) {
  let first = true;
  return watchPlugin(directory, {
    entries: options.entries,
    onBuild: async (built: PluginBuildResult) => {
      const current = await context();
      if (!first && new PluginStore(current.stateDir).developmentPackages()[built.manifest.id] !== built.directory) throw new Error('The development link was removed; stop this watcher before linking again.');
      const linked = first ? await linkDevelopmentPlugin(current, built.directory) : { id: built.manifest.id, online: Boolean(current.daemon) };
      if (!first && current.daemon) await inspectPlugin(current, built.manifest.id, 'reload');
      report(`${linked.id}: rebuilt ${built.directory}${linked.online ? ' and reloaded in Riffet' : '; linked for the next Riffet start'}.`);
      if (first) report('Development links persist until `riffet plugin unlink <id>`; their code runs with Riffet\'s permissions.');
      first = false;
    },
    onError: error => report(`Plugin development failed: ${error instanceof Error ? error.message : String(error)}`),
  });
}

interface Reply { status: number; body: { error?: { code?: string; message?: string; details?: unknown } } & Record<string, unknown> }

async function connect(daemon: PairingDaemon, token: string): Promise<(method: string, path: string, body?: unknown) => Promise<Reply>> {
  const api = await Api.login(daemon, token);
  return (method, path, body) => api.request(method, path, body) as Promise<Reply>;
}

const done = (text: string) => `${out.ok(MARK.ok)} ${text}`;
const asks = (id: string, version: string, capabilities: string[]) => [
  `${out.warn(MARK.warn)} ${out.bold(id)} ${version} asks for ${capabilities.length ? capabilities.map(item => out.bold(item)).join(', ') : 'nothing'}`,
  `  ${out.dim(MARK.arrow)} Run again with ${out.cmd('--yes')} ${out.dim('(or --grant <list>)')} to grant exactly these`,
];

const fail = (reply: Reply): never => { throw new Error(reply.body.error?.message ?? `The server answered HTTP ${reply.status}.`); };

function parseGrant(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : value.split(',').map(item => item.trim()).filter(Boolean);
}

interface InstallOptions {
  grant?: string; yes?: boolean; trusted?: boolean; from?: string;
  /** Asked in a terminal when the package needs capabilities nobody granted yet. */
  confirm?: (id: string, version: string, capabilities: string[]) => Promise<boolean>;
}
type InstallTarget = { path: string } | { market: MarketReference };

/** What the offline commands read of the sources and of what is installed. */
const offlineMarket = (context: PluginCliContext): MarketOptions => ({
  sources: marketSources(new PluginStore(context.stateDir)),
  installed: installedPackages(new PackageStore(context.stateDir).records()),
});

/**
 * Installs the package at `path` (a directory, or a .tgz), or, when no such path exists, `<id>[@version]`
 * from a plugin index (`from` names the source). It asks for capabilities; `grant` or `yes` must accept
 * exactly those, otherwise nothing is installed and the list is printed.
 */
export async function installPlugin(context: PluginCliContext, path: string, options: InstallOptions): Promise<string[]> {
  const source = resolve(path);
  const exists = existsSync(source);
  const market = exists ? undefined : parseMarketReference(path);
  if (options.from !== undefined && !market) throw new Error('--from names a source for <id>[@version]; it cannot be used with a path.');
  return installTarget(context, market ? { market: { ...market, ...(options.from ? { source: options.from } : {}) } } : { path: source }, options);
}

async function installTarget(context: PluginCliContext, target: InstallTarget, options: InstallOptions): Promise<string[]> {
  const given = parseGrant(options.grant);
  const market = 'market' in target ? target.market : undefined;
  const name = market ? `${market.id}${market.version ? '@' + market.version : ''}` : tilde((target as { path: string }).path);
  if (context.daemon) {
    const call = await connect(context.daemon, context.token());
    let reply = await spinning(`Installing ${name}`, () => call('POST', '/api/integrations/install', { ...target, grant: given ?? [], trusted: options.trusted === true }));
    const details = reply.body.error?.details as { id?: string; version?: string; sourceId?: string; capabilities?: string[] } | undefined;
    if (reply.status === 409 && reply.body.error?.code === 'PLUGIN_GRANT_REQUIRED' && details?.capabilities) {
      if (!options.yes && !await options.confirm?.(String(details.id), String(details.version), details.capabilities)) return asks(String(details.id), String(details.version), details.capabilities);
      // The release the user was shown, even if the index changed since.
      const confirmed = market && details.id && details.version ? { market: { ...(details.sourceId ? { source: details.sourceId } : {}), id: details.id, version: details.version } } : target;
      reply = await spinning(`Installing ${name}`, () => call('POST', '/api/integrations/install', { ...confirmed, grant: details.capabilities, trusted: options.trusted === true }));
    }
    if (reply.status !== 200) fail(reply);
    const installed = reply.body as unknown as PluginDescriptor;
    return [done(`Installed ${out.bold(installed.id)} ${installed.version ?? ''} ${out.dim('· ' + (installed.enabled ? 'running' : installed.status?.message ?? 'off'))}`), ...(options.trusted ? [`  ${out.dim('Trusted: its server code runs with Riffet\'s permissions')}`] : [])];
  }
  const store = new PackageStore(context.stateDir);
  let found: MarketPackage | undefined;
  let input: PackageInput;
  let origin: string;
  if (market) { found = await resolveMarketPackage(market, offlineMarket(context)); const release = found; input = { archive: await spinning(`Downloading ${name}`, () => downloadMarketPackage(release)) }; origin = marketRecord(found); }
  else { const { path } = target as { path: string }; input = { path }; origin = `path:${path}`; }
  const staged = await spinning(`Checking ${name}`, () => store.stage(input, { trusted: options.trusted === true }));
  if (found) {
    try { checkExpected(staged, found); } catch (error) { await store.discard(staged); throw error; }
  }
  // The server refuses a built-in id when it installs; without one running, the same refusal is made here (`stage` has refused the reserved `riffet.` namespace).
  if ((await import('../plugins/registry.js')).isBuiltinPlugin(String(staged.manifest.id))) {
    await store.discard(staged);
    throw new AppError('PLUGIN_ID_TAKEN', `${String(staged.manifest.id)} is a built-in plugin; an installed package cannot take its id`, 409);
  }
  if (new PluginStore(context.stateDir).developmentPackages()[String(staged.manifest.id)]) {
    await store.discard(staged);
    throw new AppError('PLUGIN_ID_TAKEN', `${String(staged.manifest.id)} is linked for development; unlink it before installing`, 409);
  }
  try { checkMarketSource(store.record(String(staged.manifest.id)), origin, String(staged.manifest.id)); } catch (error) { await store.discard(staged); throw error; }
  const confirmed = !options.yes && given === undefined && await options.confirm?.(String(staged.manifest.id), String(staged.manifest.version), staged.capabilities);
  const grant = options.yes || confirmed ? staged.capabilities : [...new Set(given ?? [])].sort();
  if (grant.length !== staged.capabilities.length || grant.some((item, index) => item !== staged.capabilities[index])) {
    await store.discard(staged);
    return asks(String(staged.manifest.id), String(staged.manifest.version), staged.capabilities);
  }
  const id = String(staged.manifest.id);
  const existing = store.record(id);
  const { status } = await spinning(`Installing ${name}`, () => store.commit(staged, origin, true));
  return [status === 'present' ? done(`${out.bold(id)} ${staged.manifest.version} is already installed`) : done(`Installed ${out.bold(id)} ${staged.manifest.version}${existing ? ' and selected it' : ''} ${out.dim('· takes effect when Riffet starts')}`), ...(options.trusted ? [`  ${out.dim('Trusted: its server code runs with Riffet\'s permissions')}`] : [])];
}

/**
 * Installs the newest compatible release of each package that came from a source and has a newer one
 * there (all of them, or the ids given), through the same confirmation as `install`.
 */
export async function updatePlugins(context: PluginCliContext, ids: string[], options: InstallOptions): Promise<string[]> {
  for (const id of ids) if (!PLUGIN_ID.test(id) || id.length > 64) throw new Error(`${id} is not a plugin id.`);
  let list: Pick<PluginMarketList, 'plugins' | 'sources'>;
  if (context.daemon) {
    const call = await connect(context.daemon, context.token());
    const reply = await spinning('Checking sources for updates', () => call('GET', '/api/integrations/market?refresh=1'));
    if (reply.status !== 200) fail(reply);
    list = reply.body as unknown as PluginMarketList;
  } else list = await spinning('Checking sources for updates', () => listMarket({ ...offlineMarket(context), fresh: true }));
  const lines = list.sources.filter(source => source.enabled && source.error).map(source => `${out.fail(MARK.fail)} Source ${out.bold(source.id)} could not be read: ${source.error}`);
  const targets = list.plugins.filter(entry => entry.update && (!ids.length || ids.includes(entry.id)));
  for (const id of ids) {
    if (targets.some(entry => entry.id === id)) continue;
    const known = list.plugins.filter(entry => entry.id === id && entry.installed);
    lines.push(known.some(entry => entry.installed?.sameSource) ? done(`${out.bold(id)} is up to date`) : known.length ? `${out.dim(MARK.dot)} ${out.bold(id)} was installed from elsewhere; no update here` : `${out.dim(MARK.dot)} ${out.bold(id)} is not installed from a source`);
  }
  for (const entry of targets) lines.push(...await installTarget(context, { market: { source: entry.sourceId, id: entry.id, version: entry.version } }, options));
  return lines.length ? lines : [done('Everything installed from a source is up to date')];
}

const sourceRows = (sources: PluginSource[]) => columns(sources.map(source => [
  source.error && source.enabled ? out.fail(MARK.running) : source.enabled ? out.ok(MARK.running) : out.dim(MARK.stopped),
  out.bold(source.id), out.url(source.url),
  source.error && source.enabled ? out.fail(source.error) : out.dim([source.name, source.plugins !== undefined ? `${source.plugins} plugins` : undefined, source.enabled ? undefined : 'off'].filter(Boolean).join(' · ')),
]));

/** `riffet plugin source list|add|remove|enable|disable`. Offline, plugins.json is changed under the state-directory lock. */
export async function manageSources(context: PluginCliContext, action: 'list' | 'add' | 'remove' | 'enable' | 'disable', argument?: string): Promise<string[]> {
  if (action !== 'list' && !argument) throw new Error(action === 'add' ? 'Give the address of the plugin index.' : 'Give a source id' + (action === 'remove' ? ' or address.' : '.'));
  const idOf = (value: string) => /^[a-z0-9][a-z0-9-]*$/.test(value) ? value : marketSourceId(checkSourceAddress(value));
  if (context.daemon) {
    const call = await connect(context.daemon, context.token());
    const reply = action === 'list' ? await call('GET', '/api/integrations/market')
      : action === 'add' ? await call('POST', '/api/integrations/sources', { url: argument })
      : action === 'remove' ? await call('DELETE', `/api/integrations/sources/${encodeURIComponent(idOf(argument!))}`)
      : await call('PATCH', `/api/integrations/sources/${encodeURIComponent(argument!)}`, { enabled: action === 'enable' });
    if (reply.status !== 200) fail(reply);
    const sources = (reply.body as unknown as PluginMarketList).sources;
    return action === 'add' ? [done(`Added ${out.bold(idOf(argument!))}`), ...sourceRows(sources.filter(item => item.id === idOf(argument!)))] : sourceRows(sources);
  }
  if (action === 'list') return sourceRows(marketSources(new PluginStore(context.stateDir)).map(source => ({ ...source })));
  mkdirSync(context.stateDir, { recursive: true, mode: 0o700 });
  const release = claimStateDirectory(context.stateDir);
  try {
    const store = new PluginStore(context.stateDir);
    if (action === 'add') { const added = await addMarketSource(store, argument!); return [done(`Added ${out.bold(added.id)} ${out.url(added.url)}`)]; }
    const id = findMarketSource(store, argument!)?.id ?? argument!;
    if (action === 'remove') removeMarketSource(store, id); else setMarketSourceEnabled(store, id, action === 'enable');
    return [done(`${action === 'remove' ? 'Removed' : action === 'enable' ? 'Turned on' : 'Turned off'} ${out.bold(id)}${action === 'remove' ? out.dim(' · packages installed from it are kept') : ''}`)];
  } finally { release(); }
}

/** `riffet plugin index build`: a static plugin index any server can add as a source (docs/PLUGINS.md「插件市场」). */
export async function buildPluginIndex(registryDirectory: string, options: { out: string; name?: string; published?: string }): Promise<string[]> {
  const registry = resolve(registryDirectory);
  const destination = resolve(options.out);
  if (!existsSync(registry)) throw new Error(`${registry} does not exist.`);
  if (destination === registry) throw new Error('--out must be a different directory from the registry.');
  const published = options.published ?? 'none';
  const plugins = await buildRegistry({ registry, out: destination, ...(published !== 'none' ? { published, carryForward: true, strictPublished: true } : {}), warn: message => console.warn(message) });
  await writeIndex(destination, { plugins, ...(options.name ? { name: options.name } : {}) });
  return [done(`${tilde(join(destination, 'index.json'))} ${out.dim(`· ${plugins.length} plugins`)}`), ...columns(plugins.map(entry => [out.bold(entry.id), out.dim(entry.versions.map(item => item.version).join(', '))]), { indent: 2 })];
}

interface ListedVersion { version: string; selected: boolean; trusted?: boolean; capabilities: string[]; source: string }
interface Listed { id: string; state?: Status | 'off'; message?: string; versions: ListedVersion[] }

/** Where a version came from, short enough for one line: a source id, or the end of a path. */
function shortSource(source: string): string {
  const path = tilde(source.replace(/^path:/, ''));
  return path.length <= 40 ? path : '…/' + path.split('/').slice(-2).join('/');
}

/** One line per package, its installed versions below it, columns aligned across the whole list. */
function renderPlugins(items: Listed[]): string[] {
  if (!items.length) return [`${out.dim(MARK.dot)} No plugin packages are installed`];
  const versionRows = items.flatMap(item => item.versions.map(version => [
    version.selected ? out.accent(MARK.running) : ' ',
    version.selected ? out.bold(version.version) : out.dim(version.version),
    version.trusted ? 'trusted' : out.dim('isolated'),
    version.capabilities.length ? version.capabilities.join(', ') : out.dim('—'),
    out.dim(shortSource(version.source)),
  ]));
  const aligned = columns(versionRows, { indent: 4 });
  const lines: string[] = [];
  let row = 0;
  for (const item of items) {
    const marker = item.state === undefined ? out.dim(MARK.dot) : item.state === 'off' ? out.dim(MARK.stopped) : item.state === 'ok' ? out.ok(MARK.running) : item.state === 'warn' ? out.warn(MARK.running) : out.fail(MARK.running);
    const message = item.message ? item.message.split(homedir()).join('~') : '';
    lines.push(`${marker} ${out.bold(item.id)}${message ? '  ' + (item.state === 'fail' ? out.fail(message) : out.dim(message)) : ''}`);
    for (let index = 0; index < item.versions.length; index++) lines.push(aligned[row++]!);
  }
  return lines;
}

export async function listPlugins(context: PluginCliContext): Promise<string[]> {
  if (context.daemon) {
    const reply = await (await connect(context.daemon, context.token()))('GET', '/api/integrations');
    if (reply.status !== 200) fail(reply);
    return renderPlugins(((reply.body.integrations ?? []) as PluginDescriptor[]).filter(item => item.source === 'installed').map(item => ({
      id: item.id,
      state: !item.enabled ? 'off' as const : item.status?.state === 'unavailable' ? 'fail' as const : item.status?.state === 'attention' ? 'warn' as const : 'ok' as const,
      message: [item.enabled ? undefined : 'off', item.status?.message].filter(Boolean).join(' · '),
      versions: item.installed?.versions ?? [],
    })));
  }
  return renderPlugins(new PackageStore(context.stateDir).records().map(record => ({
    id: record.id,
    message: 'Riffet is not running',
    versions: record.versions.map(version => ({ ...version, selected: version.version === record.selected })),
  })));
}

export async function selectPlugin(context: PluginCliContext, id: string, version: string): Promise<string[]> {
  if (context.daemon) {
    const reply = await (await connect(context.daemon, context.token()))('POST', `/api/integrations/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/select`, {});
    if (reply.status !== 200) fail(reply);
    return [done(`${out.bold(id)} now runs ${version}`)];
  }
  new PackageStore(context.stateDir).select(id, version);
  return [done(`${out.bold(id)} will run ${version} ${out.dim('· when Riffet starts')}`)];
}

export async function uninstallPlugin(context: PluginCliContext, id: string, version?: string, target: { source?: 'installed' | 'development'; path?: string } = {}): Promise<string[]> {
  if (version !== undefined && !version) throw new Error('version must not be empty.');
  if (target.path !== undefined && !target.path) throw new Error('path must not be empty.');
  if (target.source !== undefined && target.source !== 'installed' && target.source !== 'development') throw new Error('source must be installed or development.');
  if (target.path !== undefined && target.source !== 'development') throw new Error('--path requires --source development.');
  if (version !== undefined && (target.source === 'development' || target.path !== undefined)) throw new Error('A development package has no installed versions.');
  if (context.daemon) {
    const query = new URLSearchParams({ ...(target.source ? { source: target.source } : {}), ...(target.path ? { path: resolve(target.path) } : {}) });
    const reply = await (await connect(context.daemon, context.token()))('DELETE', `/api/integrations/${encodeURIComponent(id)}${version ? `/versions/${encodeURIComponent(version)}` : query.size ? '?' + query.toString() : ''}`);
    if (reply.status !== 200) fail(reply);
    return [done(`Removed ${out.bold(id)}${version ? ` ${version}` : ''} ${out.dim('· settings and data are kept')}`)];
  }
  mkdirSync(context.stateDir, { recursive: true, mode: 0o700 });
  const release = claimStateDirectory(context.stateDir);
  try {
    const store = new PackageStore(context.stateDir);
    const record = store.record(id);
    const settings = new PluginStore(context.stateDir);
    const linked = settings.developmentPackages();
    const roots = new Set<string>();
    for (const directory of [...(linked[id] ? [linked[id]!] : []), ...developmentDirectories()]) {
      const read = await readPackage(directory);
      const owner = linked[id] === directory ? id : 'reason' in read ? read.id : read.manifest.id;
      if (owner !== id) continue;
      let root: string;
      try { root = realpathSync(directory); } catch { root = resolve(directory); }
      if (!settings.excludedDevelopmentDirectories().includes(root)) roots.add(root);
    }
    if (!version && !target.source && (roots.size > 1 || roots.size > 0 && record)) throw new AppError('PLUGIN_TARGET_AMBIGUOUS', 'Several plugin sources have this id; use --source and --path to select one', 409);
    const source = version ? 'installed' : target.source ?? (roots.size ? 'development' : 'installed');
    if (source === 'development') {
      const root = target.path === undefined ? roots.size === 1 ? [...roots][0] : undefined : resolve(target.path);
      if (!root || !roots.has(root)) throw new AppError('INTEGRATION_NOT_FOUND', 'Choose a known development package directory', 404);
      settings.removeDevelopmentPackage(id, root);
    } else {
      if (version && record?.selected === version && record.versions.length > 1) throw new Error('Select another version before removing this one.');
      store.forget(id, version);
      for (const entry of record?.versions ?? []) if (!version || version === entry.version) await store.retire(id, entry.version, () => false);
    }
  } finally { release(); }
  return [done(`Removed ${out.bold(id)}${version ? ` ${version}` : ''} ${out.dim('· settings and data are kept')}`)];
}

export async function deletePluginData(context: PluginCliContext, id: string): Promise<string[]> {
  if (context.daemon) {
    const reply = await (await connect(context.daemon, context.token()))('DELETE', `/api/integrations/${encodeURIComponent(id)}/data`);
    if (reply.status !== 200) fail(reply);
  } else await new PackageStore(context.stateDir).deleteData(id);
  return [done(`Deleted the data of ${out.bold(id)}`)];
}

/** Recovery also works with the daemon stopped, without importing any plugin code. */
export async function recoverPlugins(context: PluginCliContext, mode: string): Promise<string[]> {
  if (mode !== 'on' && mode !== 'off') throw new Error('Recovery must be on or off.');
  const enabled = mode === 'on';
  if (context.daemon) {
    const reply = await (await connect(context.daemon, context.token()))('POST', '/api/integrations/recovery', { enabled });
    if (reply.status !== 200) fail(reply);
  } else {
    mkdirSync(context.stateDir, { recursive: true });
    const release = claimStateDirectory(context.stateDir);
    try { new PluginStore(context.stateDir).setRecovery(enabled); } finally { release(); }
  }
  return [done(enabled ? `External plugins are paused ${out.dim('· `riffet plugin recovery off` restores them')}` : 'Plugins are back to their own on/off settings')];
}

export async function inspectPlugin(context: PluginCliContext, id: string, action: 'reload' | 'diagnostics'): Promise<string[]> {
  if (!context.daemon) throw new Error('Riffet is stopped. Start the server before running plugin diagnostics or reload.');
  const reply = await (await connect(context.daemon, context.token()))('POST', '/api/integrations/' + encodeURIComponent(id) + '/' + action);
  if (reply.status !== 200) fail(reply);
  return [JSON.stringify(reply.body, null, 2)];
}

/** Read-only even while the service is stopped; no package code is imported. */
export async function readPluginLogs(context: PluginCliContext, id: string, options: { limit?: number } = {}): Promise<string[]> {
  if (!PLUGIN_ID.test(id) || id.length > 64) throw new Error('Invalid plugin id.');
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error('limit must be between 1 and 256.');
  let logs: PluginLogEntry[];
  if (context.daemon) {
    const reply = await (await connect(context.daemon, context.token()))('GET', `/api/integrations/${encodeURIComponent(id)}/logs`);
    if (reply.status !== 200) fail(reply);
    logs = reply.body.logs as PluginLogEntry[];
  } else {
    const store = new PluginStore(context.stateDir);
    logs = new PluginLogs(context.stateDir, pluginId => {
      try { const item = store.item(pluginId); return [...Object.values(item.settings), ...Object.values(item.secrets)]; } catch { return []; }
    }).read(id);
  }
  const level = (value: string) => value === 'error' ? out.fail(value.padEnd(5)) : value === 'warn' ? out.warn(value.padEnd(5)) : out.dim(value.padEnd(5));
  return logs.slice(-limit).map(entry => `${out.dim(entry.at)} ${level(entry.level)} ${out.dim(`${entry.version ?? 'unversioned'} #${entry.generation}`)} ${out.tag(entry.phase)} ${entry.message}`);
}
