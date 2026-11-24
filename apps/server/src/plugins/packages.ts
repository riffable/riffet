import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Plugin } from '@riffet/plugin-api';
import type { PluginDescriptor } from '../../../../packages/contracts/src/index.js';
import { PLUGIN_ID } from '../../../../packages/contracts/src/plugins.js';
import { AppError } from '../errors.js';
import { referencedFiles, serverIncompatibility } from '../plugins-host/compat.js';
import { checkMarketSource } from '../plugins-host/market.js';
import { checkExpected, type PackageInput } from '../plugins-host/packages.js';
import { remotePlugin } from '../plugins-host/remote.js';
import { grantExecutables, grantModelSources } from './declarations.js';
import { describeEntry, describeId, descriptors, invalidManifest } from './descriptors.js';
import { developmentFile, fileIntegrity, loadDevelopmentPackage, packagePlugin } from './development.js';
import { claims, describeError, type Entry, type LoadedVersion, type RegistryContext } from './entry.js';
import { deactivate, deactivateDependents, dependents, evaluate, evaluateAll, rejectCycles, serial, wouldCycle } from './lifecycle.js';

/** Where a package ends up when a version is installed or removed: the list is what clients re-read. */
export interface InstallRequest {
  input: PackageInput; source: string; grant: unknown; trusted?: boolean;
  /** From the plugin index: the package must be this release with exactly this content. */
  expected?: { id: string; version: string; integrity: string };
}

function installedRecord(ctx: RegistryContext, id: string) {
  let record;
  try { record = ctx.packages.record(id); } catch (error) { throw error instanceof AppError ? error : new AppError('PLUGINS_STATE_CORRUPT', describeError(error), 500); }
  if (!record) throw new AppError('INTEGRATION_NOT_FOUND', 'No installed package has this id', 404);
  return record;
}

/** The selected files of an installed version, checked against what was installed. */
async function loadVersion(ctx: RegistryContext, id: string, version: string): Promise<LoadedVersion | { reason: string }> {
  const loaded = await ctx.packages.load(id, version);
  if ('reason' in loaded) return loaded;
  // The package's own integrity vouches for every file; the web entry also carries its own digest, so a page can check the script it was handed.
  const web = loaded.entries.web ? { path: loaded.entries.web, ...(await fileIntegrity(loaded.root, loaded.entries.web).then(value => ({ integrity: value }), () => ({}))) } : undefined;
  return { manifest: loaded.manifest, root: loaded.root, version, integrity: loaded.record.integrity, granted: loaded.record.capabilities, ...(loaded.record.trusted ? { trusted: true } : {}), ...(loaded.entries.server ? { server: loaded.entries.server } : {}), ...(web ? { web } : {}) };
}

/** Execution trust comes from the operator-approved version record, never its manifest. */
function installedPlugin(ctx: RegistryContext, loaded: LoadedVersion): Plugin {
  if (loaded.trusted) return packagePlugin(loaded.root, loaded.manifest, { ...(loaded.server ? { server: loaded.server } : {}) }, loaded.integrity);
  const id = loaded.manifest.id;
  return remotePlugin({
    manifest: loaded.manifest, root: loaded.root, granted: loaded.granted, ...(loaded.server ? { entry: loaded.server } : {}),
    settings: () => { try { return ctx.store.item(id).settings; } catch { return {}; } },
    secrets: () => { try { return ctx.store.item(id).secrets; } catch { return {}; } },
    serverPorts: ctx.serverPorts,
    onFailure: (generation, reason) => processFailed(ctx, id, generation, reason),
  });
}

/** The package's process ended or broke the protocol while its activation was live: the contributions are withdrawn and the reason shown. Management stays usable; the next refresh starts it again. */
export function processFailed(ctx: RegistryContext, id: string, generation: number, reason: string): void {
  const entry = ctx.entries.get(id);
  if (!entry || ctx.closed) return;
  if (entry.starting?.generation !== generation && entry.active?.generation !== generation) return;
  reason = ctx.journal.redact(id, reason);
  ctx.log(entry, 'error', 'runtime', reason);
  void serial(entry, async () => {
    if (entry.starting?.generation === generation) { entry.starting.failed = reason; return; }
    if (entry.active?.generation !== generation) return;
    entry.problem = reason;
    await deactivateDependents(ctx, entry, true, true);
    await deactivate(ctx, entry);
    entry.problem = reason;
    ctx.restarts.scheduleRestart(entry);
  }).catch((error: unknown) => console.warn(`[riffet] plugin ${id} could not be stopped after its process failed: ${describeError(error)}`));
}

/** Development packages are registered after the built-in ones, so a built-in id cannot be taken over; installed ones after both. */
export async function loadPackages(ctx: RegistryContext, directories: readonly string[], includeSaved = false): Promise<void> {
  let saved: Record<string, string> = {};
  let excluded = new Set<string>();
  try {
    if (includeSaved) saved = ctx.store.developmentPackages();
    excluded = new Set(ctx.store.excludedDevelopmentDirectories());
  } catch (error) { ctx.storeProblem = describeError(error); }
  const seen = new Set<string>();
  const candidates = [...Object.entries(saved).map(([id, directory]) => ({ id, directory })), ...directories.map(directory => ({ directory, id: undefined }))];
  for (const { directory, id } of candidates) {
    let root = resolve(directory);
    try {
      if (excluded.has(resolve(directory))) continue;
      root = await realpath(directory).catch(() => root);
      if (excluded.has(root) || seen.has(root)) continue;
      seen.add(root);
      const loaded = await loadDevelopmentPackage(directory, { cacheDir: join(ctx.stateDir, 'plugin-cache') });
      if ('reason' in loaded) ctx.reject({ ...loaded, ...(id ? { id } : {}), source: 'development', root });
      else {
        if (id && loaded.plugin.manifest.id !== id) {
          seen.add(loaded.root);
          ctx.reject({ id, vendor: String(loaded.plugin.manifest.vendor), name: String(loaded.plugin.manifest.name), reason: 'A saved development directory cannot change plugin identity; unlink it first', source: 'development', root });
        } else {
          ctx.register(loaded.plugin, 'development', loaded.root, { ...(loaded.entries.web ? { web: { path: loaded.entries.web } } : {}), ...(loaded.entries.server ? { server: loaded.entries.server } : {}) });
        }
      }
    } catch (error) { ctx.reject({ id: id ?? directory, vendor: '', name: directory, reason: describeError(error), source: 'development', root }); }
  }
  let installed = 0;
  try {
    for (const record of ctx.packages.records()) {
      installed++;
      const loaded = await loadVersion(ctx, record.id, record.selected);
      if ('reason' in loaded) ctx.reject({ id: record.id, vendor: '', name: record.id, reason: loaded.reason, source: 'installed' });
      else ctx.register(installedPlugin(ctx, loaded), 'installed', loaded.root, { version: loaded.version, trusted: loaded.trusted, ...(loaded.web ? { web: loaded.web } : {}), ...(loaded.server ? { server: loaded.server } : {}) });
    }
    // Files of versions that were removed while in use, and what an interrupted install left, go once nothing needs them.
    ctx.schedulePrune(5_000);
  } catch (error) { ctx.packagesProblem = `${ctx.packages.file} is unreadable (${describeError(error)}), so no installed package is loaded`; console.warn(`[riffet] ${ctx.packagesProblem}`); }
  if (candidates.length || installed) rejectCycles(ctx);
}

/** Called under the management lock, also by an idempotent development link. */
export async function reloadEntry(ctx: RegistryContext, id: string): Promise<PluginDescriptor> {
  await ctx.loading();
  const entry = ctx.require(id);
  const development = entry.source === 'development' && entry.root ? await loadDevelopmentPackage(entry.root, { cacheDir: join(ctx.stateDir, 'plugin-cache') }) : undefined;
  if (development) {
    if ('reason' in development) throw new AppError('PLUGIN_PACKAGE_INVALID', development.reason, 422);
    if (development.plugin.manifest.id !== id) throw new AppError('PLUGIN_PACKAGE_INVALID', 'A development reload cannot change plugin identity', 422);
    const invalid = invalidManifest(ctx, development.plugin.manifest, id);
    if (invalid) throw new AppError('PLUGIN_PACKAGE_INVALID', invalid, 422);
    if (wouldCycle(ctx, id, development.plugin.manifest.requires)) throw new AppError('PLUGIN_DEPENDENCY_CYCLE', 'Its requirements would make a dependency cycle', 409);
  }
  if ([id, ...dependents(ctx, id)].some(pluginId => ctx.runningTasks(pluginId))) throw new AppError('PLUGIN_TASKS_RUNNING', 'Wait for running tasks before reloading this plugin', 409);
  await serial(entry, async () => {
    entry.starting?.controller.abort();
    await deactivateDependents(ctx, entry, true, true);
    if (entry.active) await deactivate(ctx, entry);
    if (development && !('reason' in development)) {
      for (const [declared, owner] of ctx.declared) if (owner === id) ctx.declared.delete(declared);
      const admitted = ctx.admit(development.plugin);
      for (const declared of claims(admitted.plugin.manifest)) ctx.declared.set(declared, id);
      entry.plugin = admitted.plugin;
      entry.skipped = admitted.skipped;
      entry.host = ctx.createHost(admitted.plugin.manifest, 'development');
      entry.server = development.entries.server;
      entry.web = development.entries.web ? { path: development.entries.web, integrity: await fileIntegrity(development.root, development.entries.web) } : undefined;
      entry.blocked = serverIncompatibility(development.plugin.manifest);
      entry.problem = undefined;
    }
  });
  ctx.log(entry, 'info', 'reload', 'Plugin reloaded from current package files');
  await evaluateAll(ctx, [id, ...dependents(ctx, id)]);
  return describeEntry(ctx, entry);
}

/** A local operator's explicit trust decision: link a built package without installing a version. */
export function linkDevelopment(ctx: RegistryContext, directory: string): Promise<PluginDescriptor> {
  return ctx.exclusive(async () => {
    await ctx.loading();
    if (ctx.closed) throw new AppError('SERVER_CLOSING', 'The server is shutting down', 503);
    const loaded = await loadDevelopmentPackage(directory, { cacheDir: join(ctx.stateDir, 'plugin-cache') });
    if ('reason' in loaded) throw new AppError('PLUGIN_PACKAGE_INVALID', loaded.reason, 422);
    const id = String(loaded.plugin.manifest.id);
    const existing = ctx.entries.get(id);
    const registered = ctx.store.developmentPackages();
    if (ctx.packages.record(id)
      || (existing && (existing.source !== 'development' || existing.root !== loaded.root))
      || (registered[id] && registered[id] !== loaded.root)
      || Object.entries(registered).some(([owner, root]) => owner !== id && root === loaded.root)
      || [...ctx.entries].some(([owner, entry]) => owner !== id && entry.source === 'development' && entry.root === loaded.root)) {
      throw new AppError('PLUGIN_ID_TAKEN', `${id} already belongs to another plugin or development directory`, 409);
    }
    const invalid = invalidManifest(ctx, loaded.plugin.manifest, id);
    if (invalid) throw new AppError('PLUGIN_PACKAGE_INVALID', invalid, 422);
    if (wouldCycle(ctx, id, loaded.plugin.manifest.requires)) throw new AppError('PLUGIN_DEPENDENCY_CYCLE', 'Its requirements would make a dependency cycle', 409);
    if (existing) {
      const descriptor = await reloadEntry(ctx, id);
      ctx.store.setDevelopmentPackage(id, loaded.root);
      return descriptor;
    }
    ctx.register(loaded.plugin, 'development', loaded.root, { ...(loaded.entries.web ? { web: { path: loaded.entries.web } } : {}), ...(loaded.entries.server ? { server: loaded.entries.server } : {}) });
    const entry = ctx.require(id);
    try {
      await evaluateAll(ctx, [id, ...dependents(ctx, id)]);
      if (entry.runtime?.failedPhase) throw new AppError('PLUGIN_ACTIVATION_FAILED', entry.problem ?? 'The development plugin could not start', 409);
      ctx.store.setDevelopmentPackage(id, loaded.root);
    } catch (error) {
      await removeDevelopmentEntry(ctx, entry);
      throw error;
    }
    ctx.rejected.splice(0, ctx.rejected.length, ...ctx.rejected.filter(item => !(item.id === id && item.source === 'development')));
    ctx.log(entry, 'info', 'reload', 'Development package linked');
    ctx.changed();
    return describeEntry(ctx, entry);
  });
}

/** Unlinking retains the directory, data, settings and secrets. Environment-only packages stay managed by their environment. */
export function unlinkDevelopment(ctx: RegistryContext, id: string): Promise<PluginDescriptor[]> {
  return ctx.exclusive(async () => {
    await ctx.loading();
    const root = ctx.store.developmentPackages()[id];
    if (!root) throw new AppError('PLUGIN_DEVELOPMENT_NOT_LINKED', 'This plugin has no saved development link', 404);
    const current = ctx.entries.get(id);
    const entry = current?.source === 'development' && current.root === root ? current : undefined;
    if (entry && [id, ...dependents(ctx, id)].some(pluginId => ctx.runningTasks(pluginId))) throw new AppError('PLUGIN_TASKS_RUNNING', 'Wait for running tasks before unlinking this plugin', 409);
    ctx.store.setDevelopmentPackage(id, null);
    if (entry) await removeDevelopmentEntry(ctx, entry);
    ctx.rejected.splice(0, ctx.rejected.length, ...ctx.rejected.filter(item => !(item.id === id && item.source === 'development' && item.root === root)));
    ctx.changed();
    return descriptors(ctx);
  });
}

async function removeDevelopmentEntry(ctx: RegistryContext, entry: Entry): Promise<void> {
  const id = entry.plugin.manifest.id;
  const downstream = dependents(ctx, id);
  await serial(entry, async () => {
    entry.starting?.controller.abort();
    await deactivateDependents(ctx, entry, true, true);
    if (entry.active) await deactivate(ctx, entry);
  });
  ctx.entries.delete(id);
  for (const [declared, owner] of ctx.declared) if (owner === id) ctx.declared.delete(declared);
  await evaluateAll(ctx, downstream);
  ctx.invalidate();
  ctx.changed();
}

/** The file of a development package that `GET /api/integrations/:id/files/*` serves. */
export async function readDevelopmentFile(ctx: RegistryContext, id: string, path: string): Promise<{ file: string; type: string }> {
  const entry = ctx.entries.get(id);
  const found = entry?.root ? await developmentFile(entry.root, path, { ...(entry.web ? { web: entry.web.path } : {}), ...(entry.server ? { server: entry.server } : {}), declared: referencedFiles(entry.plugin.manifest) }) : undefined;
  if (!found) throw new AppError('INTEGRATION_FILE_NOT_FOUND', 'The file does not exist', 404);
  return found;
}

/**
 * Installs a package from an archive or a directory. Its content is validated and hashed in a temporary
 * directory first; `grant` must equal the capabilities the package asks for, so an update that asks
 * for more needs a new grant. A built-in or development package's id is never taken. A version already
 * installed with the same content is left as it is; the same version with other content is refused.
 * A new version of an installed plugin becomes the selected one, and is undone if it does not start.
 */
export function install(ctx: RegistryContext, request: InstallRequest): Promise<PluginDescriptor> {
  return ctx.exclusive(async () => {
    await ctx.loading();
    if (ctx.closed) throw new AppError('SERVER_CLOSING', 'The server is shutting down', 503);
    const staged = await ctx.packages.stage(request.input, { trusted: request.trusted === true });
    try {
      if (request.expected) checkExpected(staged, request.expected);
      const { manifest } = staged;
      const id = String(manifest.id);
      const version = manifest.version!;
      const existing = ctx.entries.get(id);
      if (existing && existing.source !== 'installed') throw new AppError('PLUGIN_ID_TAKEN', `${id} is ${existing.source === 'builtin' ? 'a built-in plugin' : 'a development package'}; an installed package cannot take its id`, 409);
      checkMarketSource(ctx.packages.record(id), request.source, id);
      const clash = invalidManifest(ctx, manifest, id);
      if (clash) throw new AppError('PLUGIN_PACKAGE_INVALID', clash, 422);
      if (wouldCycle(ctx, id, manifest.requires)) throw new AppError('PLUGIN_DEPENDENCY_CYCLE', 'Its requirements would make a dependency cycle', 409);
      const grant = Array.isArray(request.grant) && request.grant.every(item => typeof item === 'string') ? [...new Set(request.grant as string[])].sort() : undefined;
      if (!grant || grant.length !== staged.capabilities.length || grant.some((item, index) => item !== staged.capabilities[index])) {
        throw new AppError('PLUGIN_GRANT_REQUIRED', `${id} ${version} asks for ${staged.capabilities.length ? staged.capabilities.join(', ') : 'no capabilities'}; grant exactly these to install it`, 409, { id, version, capabilities: staged.capabilities, ...(grantModelSources(manifest.contributes) ? { modelSources: grantModelSources(manifest.contributes) } : {}), ...(grantExecutables(manifest) ? { executables: grantExecutables(manifest) } : {}) });
      }
      const select = !existing;
      // The same version that is recorded but no longer loads (its files were damaged): the upload puts it right.
      if (!existing && !(await ctx.packages.load(id, version).then(found => !('reason' in found), () => true))) await ctx.packages.restore(staged).catch(() => false);
      const committed = await ctx.packages.commit(staged, request.source, select);
      if (committed.status === 'present') {
        if (!existing) await adoptInstalled(ctx, id);
        return describeId(ctx, id);
      }
      ctx.rejected.splice(0, ctx.rejected.length, ...ctx.rejected.filter(item => !(item.id === id && item.source === 'installed')));
      if (existing) {
        const result = await switchVersion(ctx, existing, version);
        if (result) throw result;
        return describeEntry(ctx, existing);
      }
      await adoptInstalled(ctx, id, true);
      return describeId(ctx, id);
    } finally { await ctx.packages.discard(staged).catch(() => undefined); }
  });
}

/** Loads the selected version of an installed plugin that has no entry (new, or rejected before) and evaluates it. */
async function adoptInstalled(ctx: RegistryContext, id: string, required = false): Promise<void> {
  const record = ctx.packages.record(id);
  if (!record || ctx.entries.has(id)) return;
  const loaded = await loadVersion(ctx, id, record.selected);
  if ('reason' in loaded) {
    if (required) throw new AppError('PLUGIN_PACKAGE_INVALID', loaded.reason, 422);
    return;
  }
  ctx.rejected.splice(0, ctx.rejected.length, ...ctx.rejected.filter(item => !(item.id === id && item.source === 'installed')));
  ctx.register(installedPlugin(ctx, loaded), 'installed', loaded.root, { version: loaded.version, trusted: loaded.trusted, ...(loaded.web ? { web: loaded.web } : {}), ...(loaded.server ? { server: loaded.server } : {}) });
  // What waited on it (`requires <id>`) starts now, not at the next refresh.
  await evaluateAll(ctx, [id, ...dependents(ctx, id)]);
}

/** Makes `version` the one that runs: off, swap, on. If it does not start, the previous one runs again and the failure stays on the row. */
export function selectVersion(ctx: RegistryContext, id: string, version: string): Promise<PluginDescriptor> {
  return ctx.exclusive(async () => {
    await ctx.loading();
    const record = installedRecord(ctx, id);
    if (!record.versions.some(item => item.version === version)) throw new AppError('PLUGIN_VERSION_NOT_FOUND', 'That version is not installed', 404);
    const entry = ctx.entries.get(id);
    if (entry && entry.source !== 'installed') throw new AppError('PLUGIN_ID_TAKEN', 'Another plugin source owns this id; remove that source before selecting an installed version', 409);
    if (!entry) {
      // The selected version could not be loaded at all: this one is loaded in its place.
      const loaded = await loadVersion(ctx, id, version);
      if ('reason' in loaded) throw new AppError('PLUGIN_VERSION_INVALID', loaded.reason, 409);
      const problem = invalidManifest(ctx, loaded.manifest) ?? serverIncompatibility(loaded.manifest);
      if (problem) throw new AppError('PLUGIN_VERSION_INVALID', problem, 409);
      ctx.rejected.splice(0, ctx.rejected.length, ...ctx.rejected.filter(item => !(item.id === id && item.source === 'installed')));
      ctx.register(installedPlugin(ctx, loaded), 'installed', loaded.root, { version, trusted: loaded.trusted, ...(loaded.web ? { web: loaded.web } : {}), ...(loaded.server ? { server: loaded.server } : {}) });
      ctx.packages.select(id, version);
      await evaluateAll(ctx, [id, ...dependents(ctx, id)]);
      return describeId(ctx, id);
    }
    if (record.selected === version && entry.version === version) {
      if (entry.waiting?.kind === 'switch') entry.waiting = undefined;
      return describeEntry(ctx, entry);
    }
    const failure = await switchVersion(ctx, entry, version);
    if (failure) throw failure;
    return describeEntry(ctx, entry);
  });
}

/**
 * The swap behind `selectVersion` and an update: returns the error to report when the new version did not start. While the
 * plugin has running tasks the switch waits for them instead (`entry.waiting`; no error) unless `force`: its activation stays up
 * for the tasks' diagnostics, and `tasksChanged` runs the switch once none is left.
 */
export async function switchVersion(ctx: RegistryContext, entry: Entry, version: string, force = false): Promise<AppError | undefined> {
  const id = entry.plugin.manifest.id;
  const loaded = await loadVersion(ctx, id, version);
  if ('reason' in loaded) return new AppError('PLUGIN_VERSION_INVALID', loaded.reason, 409);
  const problem = invalidManifest(ctx, loaded.manifest, id) ?? serverIncompatibility(loaded.manifest) ?? (wouldCycle(ctx, id, loaded.manifest.requires) ? 'its requirements would make a dependency cycle' : undefined);
  if (problem) return new AppError('PLUGIN_VERSION_INVALID', problem, 409);
  let failure: AppError | undefined;
  await ctx.loading();
  await serial(entry, async () => {
    if (!force && entry.active && ctx.runningTasks(id) > 0) { entry.waiting = { kind: 'switch', version }; return; }
    entry.waiting = undefined;
    const before = { plugin: entry.plugin, host: entry.host, trusted: entry.trusted, root: entry.root, version: entry.version, web: entry.web, server: entry.server, blocked: entry.blocked, active: Boolean(entry.active), demand: entry.demand, declared: [...ctx.declared].filter(([, owner]) => owner === id).map(([declared]) => declared) };
    const dataBefore = await ctx.packages.dataVersion(id);
    entry.starting?.controller.abort();
    await deactivateDependents(ctx, entry, true, true);
    if (entry.active) await deactivate(ctx, entry);
    swap(ctx, entry, installedPlugin(ctx, loaded), loaded);
    if (before.active && !entry.demand) entry.demand = 'version-switch';
    const error = await evaluate(ctx, entry);
    if (error) {
      if (entry.active) await deactivate(ctx, entry);
      for (const [declared, owner] of ctx.declared) if (owner === id) ctx.declared.delete(declared);
      Object.assign(entry, { plugin: before.plugin, host: before.host, trusted: before.trusted, version: before.version, demand: before.demand });
      if (before.root) entry.root = before.root; else delete entry.root;
      if (before.web) entry.web = before.web; else delete entry.web;
      if (before.server) entry.server = before.server; else delete entry.server;
      if (before.blocked) entry.blocked = before.blocked; else delete entry.blocked;
      for (const declared of before.declared) ctx.declared.set(declared, id);
      // The new version may already have moved the data to its format (after backing it up): put the backup back, or the previous version could not start on it.
      await ctx.packages.rollbackData(id, dataBefore);
      const fallback = await evaluate(ctx, entry);
      const previous = before.version ?? 'the previous version';
      entry.note = fallback
        ? `version ${version} could not start (${error}); ${previous} could not start either (${fallback})`
        : `version ${version} could not start (${error}); still using ${previous}`;
      failure = new AppError('PLUGIN_ACTIVATION_FAILED', entry.note, 409, { version, previous: before.version, reason: error });
    } else {
      entry.note = undefined;
      ctx.packages.select(id, version);
    }
  });
  await evaluateAll(ctx, dependents(ctx, id));
  return failure;
}

function swap(ctx: RegistryContext, entry: Entry, plugin: Plugin, loaded: LoadedVersion): void {
  const id = plugin.manifest.id;
  for (const [declared, owner] of ctx.declared) if (owner === id) ctx.declared.delete(declared);
  const admitted = ctx.admit(plugin);
  for (const declared of claims(admitted.plugin.manifest)) ctx.declared.set(declared, id);
  const blocked = serverIncompatibility(loaded.manifest);
  entry.plugin = admitted.plugin;
  entry.skipped = admitted.skipped;
  entry.root = loaded.root;
  entry.version = loaded.version;
  entry.trusted = loaded.trusted === true;
  entry.host = ctx.createHost(admitted.plugin.manifest, 'installed', entry.trusted);
  if (loaded.web) entry.web = loaded.web; else delete entry.web;
  if (loaded.server) entry.server = loaded.server; else delete entry.server;
  if (blocked) entry.blocked = blocked; else delete entry.blocked;
}

/**
 * Removes one version's files. The selected version stays while others exist; the last version takes
 * the plugin with it. Data and settings stay. Files something still uses are removed once nothing does.
 */
export function uninstallVersion(ctx: RegistryContext, id: string, version: string): Promise<PluginDescriptor[]> {
  return ctx.exclusive(async () => {
    await ctx.loading();
    const record = installedRecord(ctx, id);
    if (!record.versions.some(item => item.version === version)) throw new AppError('PLUGIN_VERSION_NOT_FOUND', 'That version is not installed', 404);
    const current = ctx.entries.get(id);
    const entry = current?.source === 'installed' ? current : undefined;
    if (entry && record.selected === version && record.versions.length > 1) throw new AppError('PLUGIN_VERSION_SELECTED', 'Select another version before removing this one', 409);
    const downstream = entry ? dependents(ctx, id) : [];
    ctx.packages.forget(id, version);
    if (entry && record.versions.length === 1) {
      await serial(entry, async () => {
        entry.starting?.controller.abort();
        await deactivateDependents(ctx, entry, true, true);
        if (entry.active) await deactivate(ctx, entry);
      });
      ctx.entries.delete(id);
      for (const [declared, owner] of ctx.declared) if (owner === id) ctx.declared.delete(declared);
    }
    if (record.versions.length === 1) ctx.rejected.splice(0, ctx.rejected.length, ...ctx.rejected.filter(item => !(item.id === id && item.source === 'installed')));
    if (!await ctx.packages.retire(id, version, ctx.versionInUse)) ctx.schedulePrune();
    // A plugin that could not load now runs another version, if there is one.
    if (!entry && record.versions.length > 1) await adoptInstalled(ctx, id);
    await evaluateAll(ctx, downstream);
    return descriptors(ctx);
  });
}

/** Removes exactly the external source selected by the operator, retaining sources, configuration and data. */
export function uninstall(ctx: RegistryContext, id: string, options: { source?: 'installed' | 'development'; path?: string; allowDevelopment?: boolean } = {}): Promise<PluginDescriptor[]> {
  return ctx.exclusive(async () => {
    await ctx.loading();
    if (options.source !== undefined && options.source !== 'installed' && options.source !== 'development') throw new AppError('INVALID_INPUT', 'source must be installed or development');
    if (options.path !== undefined && (options.source !== 'development' || typeof options.path !== 'string' || !options.path)) throw new AppError('INVALID_INPUT', 'A development path requires source=development');
    const current = ctx.entries.get(id);
    const record = options.source === 'development' ? undefined : ctx.packages.record(id);
    const roots = new Set<string>();
    if (current?.source === 'development' && current.root) roots.add(current.root);
    for (const rejected of ctx.rejected) if (rejected.id === id && rejected.source === 'development' && rejected.root) roots.add(rejected.root);
    const saved = options.source === 'installed' ? undefined : ctx.store.developmentPackages()[id];
    if (saved) roots.add(saved);
    if (!options.source && (roots.size > 1 || roots.size > 0 && (record || current?.source === 'builtin'))) throw new AppError('PLUGIN_TARGET_AMBIGUOUS', 'Several plugin sources have this id; specify source and the development path', 409);
    const source = options.source ?? (roots.size ? 'development' : 'installed');
    if (source === 'development') {
      if (options.allowDevelopment === false) throw new AppError('PLUGIN_DEVELOPMENT_LOCAL_ONLY', 'Development plugins can only be managed from the server device', 403);
      const root = options.path === undefined ? roots.size === 1 ? [...roots][0] : undefined : resolve(options.path);
      if (!root || !roots.has(root)) throw new AppError(roots.size > 1 && !options.path ? 'PLUGIN_TARGET_AMBIGUOUS' : 'INTEGRATION_NOT_FOUND', 'Choose a known development package directory', roots.size > 1 && !options.path ? 409 : 404);
      const entry = current?.source === 'development' && current.root === root ? current : undefined;
      if (entry && [id, ...dependents(ctx, id)].some(pluginId => ctx.runningTasks(pluginId))) throw new AppError('PLUGIN_TASKS_RUNNING', 'Wait for running tasks before uninstalling this plugin', 409);
      // Save discovery removal first: a failed write must leave the live plugin usable.
      ctx.store.removeDevelopmentPackage(id, root);
      if (entry) await removeDevelopmentEntry(ctx, entry);
      ctx.rejected.splice(0, ctx.rejected.length, ...ctx.rejected.filter(item => !(item.id === id && item.source === 'development' && item.root === root)));
      ctx.changed();
      return descriptors(ctx);
    }
    if (!record) throw new AppError('INTEGRATION_NOT_FOUND', 'No installed package has this id', 404);
    const entry = current?.source === 'installed' ? current : undefined;
    const downstream = entry ? dependents(ctx, id) : [];
    if (entry && [id, ...downstream].some(pluginId => ctx.runningTasks(pluginId))) throw new AppError('PLUGIN_TASKS_RUNNING', 'Wait for running tasks before uninstalling this plugin', 409);
    // Commit first, as development removal does: a failed installed.json write has no runtime effects.
    ctx.packages.forget(id);
    if (entry) {
      await serial(entry, async () => {
        entry.starting?.controller.abort();
        await deactivateDependents(ctx, entry, true, true);
        if (entry.active) await deactivate(ctx, entry);
      });
      ctx.entries.delete(id);
      for (const [declared, owner] of ctx.declared) if (owner === id) ctx.declared.delete(declared);
    }
    ctx.rejected.splice(0, ctx.rejected.length, ...ctx.rejected.filter(item => !(item.id === id && item.source === 'installed')));
    for (const version of record.versions) if (!await ctx.packages.retire(id, version.version, ctx.versionInUse)) ctx.schedulePrune();
    await evaluateAll(ctx, downstream);
    ctx.invalidate(); ctx.changed();
    return descriptors(ctx);
  });
}

/** Removes the plugin's data directory and its backups (settings and secrets stay). The plugin is stopped while it goes and starts again if it is on. */
export function deleteData(ctx: RegistryContext, id: string): Promise<PluginDescriptor[]> {
  return ctx.exclusive(async () => {
    await ctx.loading();
    if (!PLUGIN_ID.test(id) || id.length > 64) throw new AppError('INTEGRATION_NOT_FOUND', 'Plugin not found', 404);
    const entry = ctx.entries.get(id);
    if (entry && entry.source !== 'installed') throw new AppError('PLUGIN_DATA_PROTECTED', 'Only an installed package\'s data can be deleted here', 409);
    if (!entry && !(await ctx.packages.hasData(id))) throw new AppError('INTEGRATION_NOT_FOUND', 'Plugin not found', 404);
    if (entry) {
      await serial(entry, async () => {
        entry.starting?.controller.abort();
        await deactivateDependents(ctx, entry, true, true);
        if (entry.active) await deactivate(ctx, entry);
        await ctx.packages.deleteData(id);
      });
      await evaluateAll(ctx, [id, ...dependents(ctx, id)]);
    } else await ctx.packages.deleteData(id);
    return descriptors(ctx);
  });
}
