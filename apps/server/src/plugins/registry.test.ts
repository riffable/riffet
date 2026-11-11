import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionOutcome, ActivationScope, Contributions, Plugin, PluginHost, PluginManifest, SharePublisher } from '@riffet/plugin-api';
import { PluginRegistry } from './registry.js';
import { PluginStore } from './store.js';
import { migratePluginStorage } from '../compat.js';
import { PackageStore } from '../plugins-host/packages.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function stateDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'riffet-integrations-'));
  directories.push(directory);
  return directory;
}

function plugin(manifest: Partial<PluginManifest> & { id: PluginManifest['id'] }, options: { detect?: () => Promise<boolean>; contributions?: Contributions } = {}) {
  const activate = vi.fn(() => options.contributions ?? { modelSources: [{ id: manifest.id.replace('.', '-'), label: 'Source', backends: ['codex'] as const, resolve: () => ({}), catalog: async () => [] }] });
  const value: Plugin = { manifest: { vendor: 'Acme', name: manifest.id, apiVersion: 1, defaultEnabled: 'auto', ...manifest }, activate, ...(options.detect ? { detect: options.detect } : {}) };
  return { value, activate };
}

function custom(id: PluginManifest['id'], activate: Plugin['activate'], manifest: Partial<PluginManifest> = {}): Plugin {
  return { manifest: { vendor: 'Acme', name: id, apiVersion: 1, defaultEnabled: true, ...manifest, id }, activate };
}
const source = (id: string) => ({ id, label: id, backends: ['codex'] as const, resolve: () => ({}), catalog: async () => [] });
const byId = async (registry: PluginRegistry, id: string) => (await registry.descriptors()).find(item => item.id === id)!;

describe('on-demand plugin execution', () => {
  it('discovers sources without probing and coalesces first use while respecting off', async () => {
    const detect = vi.fn(async () => true);
    const activate = vi.fn(async () => ({ modelSources: [source('lazy-source')] }));
    const value = custom('acme.lazy', activate, { activation: ['model-source'], defaultEnabled: 'auto', contributes: { modelSources: [{ id: 'lazy-source', title: { en: 'Lazy source' }, backends: ['codex'] }] } });
    value.detect = detect;
    const fail = vi.fn(async () => { throw new Error('initialization failed'); });
    const failing = custom('acme.lazy-failure', fail, { activation: ['model-source'], contributes: { modelSources: [{ id: 'failure-source', title: { en: 'Failure source' }, protocols: ['openai-responses'] }] } });
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [value, failing], developmentPackages: [] });
    try {
      await registry.refresh();
      expect(await byId(registry, 'acme.lazy')).toMatchObject({ enabled: true, active: false, activation: { state: 'idle' }, contributes: { modelSources: [{ id: 'lazy-source', protocols: ['openai-responses'] }] } });
      expect(detect).not.toHaveBeenCalled(); expect(activate).not.toHaveBeenCalled();
      await Promise.all([1, 2, 3].map(() => registry.ensureContribution('model-source', 'lazy-source')));
      expect(detect).toHaveBeenCalledTimes(1); expect(activate).toHaveBeenCalledTimes(1);
      const rejected = await Promise.allSettled([1, 2, 3].map(() => registry.ensureContribution('model-source', 'failure-source')));
      expect(rejected.every(result => result.status === 'rejected')).toBe(true); expect(fail).toHaveBeenCalledTimes(1);
      await expect(registry.ensureContribution('model-source', 'failure-source')).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_FAILED' });
      expect(fail).toHaveBeenCalledTimes(2);
      await registry.update('acme.lazy', { enablement: 'off' });
      await expect(registry.ensureContribution('model-source', 'lazy-source')).rejects.toMatchObject({ code: 'INTEGRATION_DISABLED' });
    } finally { await registry.close(); }
  });

  it('reloads a rebuilt development entry and its transitive modules from a fresh content path', async () => {
    const directory = await stateDir();
    await writeFile(join(directory, 'riffet-plugin.json'), JSON.stringify({ id: 'acme.reload', vendor: 'Acme', name: 'Reload', apiVersion: 1, defaultEnabled: true, entries: { server: 'index.mjs' } }));
    await writeFile(join(directory, 'index.mjs'), "import { value } from './helper.mjs'; export default { activate() { return { status: async () => ({state:'ready',message:value}) }; } };");
    await writeFile(join(directory, 'helper.mjs'), "export const value = 'before';");
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [], developmentPackages: [directory] });
    try {
      await registry.refresh();
      expect((await byId(registry, 'acme.reload')).status?.message).toBe('before');
      await writeFile(join(directory, 'helper.mjs'), "export const value = 'after';");
      expect((await registry.reload('acme.reload')).status?.message).toBe('after');
    } finally { await registry.close(); }
  });

  it('links development code, reloads the same directory, persists it, and unlinks without deleting its files or settings', async () => {
    vi.stubEnv('RIFFET_DEV_PLUGINS', '');
    const directory = await stateDir();
    const pkg = await stateDir();
    const manifest = { id: 'acme.linked', vendor: 'Acme', name: 'Linked', apiVersion: 1, defaultEnabled: true, entries: { server: 'index.mjs' } };
    await writeFile(join(pkg, 'riffet-plugin.json'), JSON.stringify(manifest));
    const entry = (message: string) => `export default { activate: () => ({ status: async () => ({ state: 'ready', message: ${JSON.stringify(message)} }) }) };`;
    await writeFile(join(pkg, 'index.mjs'), entry('first'));
    const first = new PluginRegistry({ stateDir: directory, plugins: [], developmentPackages: [] });
    try {
      expect(await first.linkDevelopment(pkg)).toMatchObject({ id: 'acme.linked', source: 'development', enabled: true, status: { message: 'first' } });
      first.store.update('acme.linked', { settings: { region: 'eu' } });
      await writeFile(join(pkg, 'index.mjs'), entry('second'));
      expect(await first.linkDevelopment(pkg)).toMatchObject({ status: { message: 'second' } });
      expect(first.store.developmentPackages()).toEqual({ 'acme.linked': await realpath(pkg) });
    } finally { await first.close(); }
    vi.stubEnv('RIFFET_DEV_PLUGINS', pkg);
    let running = true;
    const restarted = new PluginRegistry({ stateDir: directory, plugins: [], runningTasks: id => id === 'acme.linked' && running ? 1 : 0 });
    try {
      await restarted.refresh();
      expect((await restarted.descriptors()).filter(item => item.id === 'acme.linked')).toHaveLength(1);
      expect(await byId(restarted, 'acme.linked')).toMatchObject({ enabled: true, status: { message: 'second' } });
      await expect(restarted.unlinkDevelopment('acme.linked')).rejects.toMatchObject({ code: 'PLUGIN_TASKS_RUNNING' });
      running = false;
      expect(await restarted.unlinkDevelopment('acme.linked')).toEqual([]);
      expect(restarted.store.developmentPackages()).toEqual({});
      expect(restarted.store.item('acme.linked').settings).toEqual({ region: 'eu' });
      expect(await readFile(join(pkg, 'index.mjs'), 'utf8')).toBe(entry('second'));
    } finally { await restarted.close(); vi.unstubAllEnvs(); }
  });

  it('refuses occupied ids and failed activations before saving a development link', async () => {
    const directory = await stateDir();
    const registry = new PluginRegistry({ stateDir: directory, plugins: [custom('acme.builtin', () => ({}))], developmentPackages: [] });
    const marker = join(directory, 'executed');
    const candidate = async (id: string, broken = false, enabled = true) => {
      const pkg = await stateDir();
      await writeFile(join(pkg, 'riffet-plugin.json'), JSON.stringify({ id, vendor: 'Acme', name: id, apiVersion: 1, version: '1.0.0', defaultEnabled: enabled, entries: { server: 'index.mjs' } }));
      await writeFile(join(pkg, 'index.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(id)}); export default { activate() { ${broken ? "throw new Error('broken development activation');" : 'return {};'} } };`);
      return pkg;
    };
    try {
      await registry.refresh();
      await expect(registry.linkDevelopment(await candidate('acme.builtin'))).rejects.toMatchObject({ code: 'PLUGIN_ID_TAKEN' });
      const installed = await candidate('acme.installed', false, false);
      await registry.install({ input: { path: installed }, source: 'test', grant: [], trusted: true });
      await expect(registry.linkDevelopment(installed)).rejects.toMatchObject({ code: 'PLUGIN_ID_TAKEN' });
      expect(await stat(marker).catch(() => undefined)).toBeUndefined();
      await expect(registry.linkDevelopment(await candidate('acme.broken', true))).rejects.toMatchObject({ code: 'PLUGIN_ACTIVATION_FAILED' });
      expect(await readFile(marker, 'utf8')).toBe('acme.broken');
      expect(registry.store.developmentPackages()).toEqual({});
      expect(await byId(registry, 'acme.broken')).toBeUndefined();
      const linked = await candidate('acme.occupied');
      await registry.linkDevelopment(linked);
      await expect(registry.linkDevelopment(await candidate('acme.occupied'))).rejects.toMatchObject({ code: 'PLUGIN_ID_TAKEN' });
      expect(registry.store.developmentPackages()).toEqual({ 'acme.occupied': await realpath(linked) });
    } finally { await registry.close(); }
  });

  it.each([false, true])('uninstalls an environment development package persistently without deleting its source or configuration (saved link: %s)', async linked => {
    const directory = await stateDir(), pkg = await stateDir();
    const alias = join(directory, 'development-source');
    await symlink(pkg, alias, 'dir');
    const manifest = JSON.stringify({ id: 'acme.removable', vendor: 'Acme', name: 'Removable', apiVersion: 1, defaultEnabled: true });
    await writeFile(join(pkg, 'riffet-plugin.json'), manifest);
    const data = join(directory, 'plugin-data/acme.removable');
    await mkdir(data, { recursive: true });
    await writeFile(join(data, 'kept'), 'plugin data');
    vi.stubEnv('RIFFET_DEV_PLUGINS', alias);
    const disposed = vi.fn();
    const dependent = custom('acme.consumer', () => ({ modelSources: [source('consumer')], dispose: disposed }), { requires: [{ id: 'acme.removable' }] });
    let running = false;
    const first = new PluginRegistry({ stateDir: directory, plugins: [dependent], runningTasks: id => id === 'acme.consumer' && running ? 1 : 0 });
    try {
      await first.refresh();
      if (linked) await first.linkDevelopment(alias);
      first.store.update('acme.removable', { enablement: 'on', settings: { region: 'eu' }, secrets: { token: 'kept-secret' } });
      disposed.mockClear();
      expect(first.modelSources().map(item => item.id)).toContain('consumer');
      const saved = await readFile(first.store.path, 'utf8');
      await expect(first.uninstall('acme.removable', { allowDevelopment: false })).rejects.toMatchObject({ code: 'PLUGIN_DEVELOPMENT_LOCAL_ONLY' });
      expect(await readFile(first.store.path, 'utf8')).toBe(saved);
      running = true;
      await expect(first.uninstall('acme.removable')).rejects.toMatchObject({ code: 'PLUGIN_TASKS_RUNNING' });
      expect(disposed).not.toHaveBeenCalled();
      running = false;
      expect((await first.uninstall('acme.removable')).map(item => item.id)).not.toContain('acme.removable');
      expect(first.modelSources()).toEqual([]);
      expect(disposed).toHaveBeenCalledTimes(1);
      await first.refresh();
      expect(await byId(first, 'acme.removable')).toBeUndefined();
      expect(first.store.developmentPackages()).toEqual({});
      expect(first.store.excludedDevelopmentDirectories()).toEqual([await realpath(pkg)]);
      expect(first.store.item('acme.removable')).toEqual({ enablement: 'on', settings: { region: 'eu' }, secrets: { token: 'kept-secret' } });
      expect(await readFile(join(pkg, 'riffet-plugin.json'), 'utf8')).toBe(manifest);
      expect(await readFile(join(data, 'kept'), 'utf8')).toBe('plugin data');
    } finally { await first.close(); }
    const restarted = new PluginRegistry({ stateDir: directory, plugins: [dependent] });
    try {
      await restarted.refresh();
      expect(await byId(restarted, 'acme.removable')).toBeUndefined();
      expect(restarted.modelSources()).toEqual([]);
      expect(await restarted.linkDevelopment(alias)).toMatchObject({ id: 'acme.removable', enabled: true, developmentLinked: true });
      expect(restarted.store.excludedDevelopmentDirectories()).toEqual([]);
      expect(restarted.modelSources().map(item => item.id)).toContain('consumer');
    } finally { await restarted.close(); vi.unstubAllEnvs(); }
    vi.stubEnv('RIFFET_DEV_PLUGINS', '');
    const restored = new PluginRegistry({ stateDir: directory, plugins: [] });
    try {
      await restored.refresh();
      expect(await byId(restored, 'acme.removable')).toMatchObject({ enabled: true, developmentLinked: true });
    } finally { await restored.close(); vi.unstubAllEnvs(); }
  });

  it('keeps a development plugin active and linked when persisting its removal fails', async () => {
    const directory = await stateDir(), pkg = await stateDir();
    await writeFile(join(pkg, 'riffet-plugin.json'), JSON.stringify({ id: 'acme.kept', vendor: 'Acme', name: 'Kept', apiVersion: 1, defaultEnabled: true }));
    const disposed = vi.fn();
    const dependent = custom('acme.consumer', () => ({ modelSources: [source('consumer')], dispose: disposed }), { requires: [{ id: 'acme.kept' }] });
    const registry = new PluginRegistry({ stateDir: directory, plugins: [dependent], developmentPackages: [] });
    try {
      await registry.linkDevelopment(pkg);
      const saved = registry.store.path + '.saved';
      await rename(registry.store.path, saved);
      await mkdir(registry.store.path);
      await expect(registry.uninstall('acme.kept')).rejects.toMatchObject({ code: 'INTEGRATIONS_WRITE_FAILED' });
      expect(await byId(registry, 'acme.kept')).toMatchObject({ enabled: true, developmentLinked: true });
      expect(registry.modelSources().map(item => item.id)).toContain('consumer');
      expect(disposed).not.toHaveBeenCalled();
      expect(registry.store.excludedDevelopmentDirectories()).toEqual([]);
      await rm(registry.store.path, { recursive: true });
      await rename(saved, registry.store.path);
      expect(new PluginStore(directory).developmentPackages()).toEqual({ 'acme.kept': await realpath(pkg) });
    } finally { await registry.close(); }
  });

  it('removes only the selected source and development directory when ids overlap', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const directory = await stateDir(), installed = await stateDir(), firstRoot = await stateDir(), secondRoot = await stateDir();
    const id = 'acme.overlap';
    const manifest = { id, vendor: 'Acme', name: 'Overlap', apiVersion: 1, version: '1.0.0', defaultEnabled: true };
    for (const root of [installed, firstRoot, secondRoot]) await writeFile(join(root, 'riffet-plugin.json'), JSON.stringify(manifest));
    const seed = new PluginRegistry({ stateDir: directory, plugins: [], developmentPackages: [] });
    try { await seed.install({ input: { path: installed }, source: 'test', grant: [], trusted: true }); }
    finally { await seed.close(); }
    new PluginStore(directory).setDevelopmentPackage(id, await realpath(firstRoot));
    const disposed = vi.fn();
    const dependent = custom('acme.consumer', () => ({ modelSources: [source('consumer')], dispose: disposed }), { requires: [{ id }] });
    const registry = new PluginRegistry({ stateDir: directory, plugins: [dependent], developmentPackages: [firstRoot, secondRoot] });
    try {
      await registry.refresh();
      const roots = [await realpath(firstRoot), await realpath(secondRoot)];
      expect((await registry.descriptors()).filter(item => item.id === id && item.source === 'development').map(item => item.developmentPath)).toEqual(roots);
      await expect(registry.uninstall(id)).rejects.toMatchObject({ code: 'PLUGIN_TARGET_AMBIGUOUS' });
      await expect(registry.selectVersion(id, '1.0.0')).rejects.toMatchObject({ code: 'PLUGIN_ID_TAKEN' });
      await expect(registry.uninstall(id, { source: 'development' })).rejects.toMatchObject({ code: 'PLUGIN_TARGET_AMBIGUOUS' });
      await expect(registry.uninstall(id, { source: 'development', path: await stateDir() })).rejects.toMatchObject({ statusCode: 404 });
      await registry.uninstall(id, { source: 'installed' });
      expect(registry.packages.record(id)).toBeUndefined();
      expect(await byId(registry, id)).toMatchObject({ source: 'development', active: true, developmentPath: roots[0] });
      await registry.uninstall(id, { source: 'development', path: roots[1] });
      expect(registry.store.developmentPackages()).toEqual({ [id]: roots[0] });
      expect(registry.store.excludedDevelopmentDirectories()).toEqual([roots[1]]);
      expect((await registry.descriptors()).filter(item => item.id === id)).toEqual([expect.objectContaining({ active: true, developmentPath: roots[0] })]);
      expect(disposed).not.toHaveBeenCalled();
      expect(registry.modelSources().map(item => item.id)).toContain('consumer');
    } finally { await registry.close(); }
  });

  it('unlinks a rejected saved directory without stopping a healthy environment directory with the same id', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const directory = await stateDir(), saved = await stateDir(), healthy = await stateDir();
    const id = 'acme.link-overlap';
    const manifest = { id, vendor: 'Acme', name: 'Overlap', apiVersion: 1, defaultEnabled: true };
    await writeFile(join(saved, 'riffet-plugin.json'), JSON.stringify({ ...manifest, entries: { server: 'missing.mjs' } }));
    await writeFile(join(healthy, 'riffet-plugin.json'), JSON.stringify(manifest));
    new PluginStore(directory).setDevelopmentPackage(id, await realpath(saved));
    vi.stubEnv('RIFFET_DEV_PLUGINS', healthy);
    const registry = new PluginRegistry({ stateDir: directory, plugins: [] });
    try {
      await registry.refresh();
      expect((await registry.descriptors()).filter(item => item.id === id)).toHaveLength(2);
      const remaining = await registry.unlinkDevelopment(id);
      expect(remaining.filter(item => item.id === id)).toEqual([expect.objectContaining({ active: true, developmentPath: await realpath(healthy) })]);
      expect(registry.store.developmentPackages()).toEqual({});
      expect(await readFile(join(saved, 'riffet-plugin.json'), 'utf8')).toContain('missing.mjs');
    } finally { await registry.close(); vi.unstubAllEnvs(); }
  });

  it.each(['missing-entry', 'bad-manifest', 'missing-directory'] as const)('removes rejected development directories without requiring a valid manifest identity: %s', async failure => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const directory = await stateDir(), root = await stateDir();
    if (failure === 'missing-directory') await rm(root, { recursive: true });
    else await writeFile(join(root, 'riffet-plugin.json'), failure === 'bad-manifest' ? '{broken' : JSON.stringify({ id: 'acme.broken', vendor: 'Acme', name: 'Broken', apiVersion: 1, defaultEnabled: true, entries: { server: 'missing.mjs' } }));
    const registry = new PluginRegistry({ stateDir: directory, plugins: [], developmentPackages: [root] });
    try {
      await registry.refresh();
      const [item] = await registry.descriptors();
      expect(item).toMatchObject({ source: 'development', rejected: true, developmentPath: await realpath(root).catch(() => root) });
      await expect(registry.uninstall(item!.id, { source: 'development', path: item!.developmentPath, allowDevelopment: false })).rejects.toMatchObject({ statusCode: 403 });
      expect(await registry.uninstall(item!.id, { source: 'development', path: item!.developmentPath })).toEqual([]);
      expect(registry.store.excludedDevelopmentDirectories()).toEqual([item!.developmentPath]);
    } finally { await registry.close(); }
    const restarted = new PluginRegistry({ stateDir: directory, plugins: [], developmentPackages: [root] });
    try { await restarted.refresh(); expect(await restarted.descriptors()).toEqual([]); }
    finally { await restarted.close(); }
  });

  it('keeps installed code and its dependents active when persisting whole-plugin removal fails', async () => {
    const directory = await stateDir(), root = await stateDir();
    await writeFile(join(root, 'riffet-plugin.json'), JSON.stringify({ id: 'acme.installed-kept', vendor: 'Acme', name: 'Kept', apiVersion: 1, version: '1.0.0', defaultEnabled: true }));
    const disposed = vi.fn();
    const dependent = custom('acme.consumer', () => ({ modelSources: [source('consumer')], dispose: disposed }), { requires: [{ id: 'acme.installed-kept' }] });
    const registry = new PluginRegistry({ stateDir: directory, plugins: [dependent], developmentPackages: [] });
    try {
      await registry.install({ input: { path: root }, source: 'test', grant: [], trusted: true });
      const saved = registry.packages.file + '.saved';
      await rename(registry.packages.file, saved); await mkdir(registry.packages.file);
      await expect(registry.uninstall('acme.installed-kept', { source: 'installed' })).rejects.toMatchObject({ code: 'PLUGINS_WRITE_FAILED' });
      expect(await byId(registry, 'acme.installed-kept')).toMatchObject({ active: true, installed: { selected: '1.0.0' } });
      expect(registry.modelSources().map(item => item.id)).toContain('consumer');
      expect(disposed).not.toHaveBeenCalled();
      await rm(registry.packages.file, { recursive: true }); await rename(saved, registry.packages.file);
    } finally { await registry.close(); }
  });

  it('keeps saved development identities fixed even when an environment path names the same directory', async () => {
    const directory = await stateDir();
    const pkg = await stateDir();
    const marker = join(directory, 'executed');
    new PluginStore(directory).setDevelopmentPackage('acme.original', await realpath(pkg));
    await writeFile(join(pkg, 'riffet-plugin.json'), JSON.stringify({ id: 'acme.changed', vendor: 'Acme', name: 'Changed', apiVersion: 1, defaultEnabled: true, entries: { server: 'index.mjs' } }));
    await writeFile(join(pkg, 'index.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export default { activate: () => ({}) };`);
    vi.stubEnv('RIFFET_DEV_PLUGINS', pkg);
    const overridden = new PluginRegistry({ stateDir: directory, plugins: [], developmentPackages: [] });
    try { await overridden.refresh(); expect(await overridden.descriptors()).toEqual([]); }
    finally { await overridden.close(); }
    const registry = new PluginRegistry({ stateDir: directory, plugins: [] });
    try {
      await registry.refresh();
      expect(await registry.descriptors()).toEqual([expect.objectContaining({ id: 'acme.original', source: 'development', rejected: true, status: { state: 'unavailable', message: expect.stringContaining('identity') } })]);
      expect(await stat(marker).catch(() => undefined)).toBeUndefined();
      await registry.unlinkDevelopment('acme.original');
    } finally { await registry.close(); vi.unstubAllEnvs(); }
  });

  it('persists bounded attributed logs with secret redaction across a service restart', async () => {
    const directory = await stateDir();
    const value = custom('acme.logs', host => {
      host.logger?.info(`Starting token=${host.secrets.get('token')}`);
      for (let index = 0; index < 300; index++) host.logger?.debug(`entry ${index} ${'x'.repeat(1500)}`);
      throw new Error('activation failed with super-secret-value');
    }, { settings: [{ key: 'token', label: 'Token', kind: 'secret' }] });
    const disposing = custom('acme.disposes', () => ({ status: async () => ({ state: 'ready', message: 'super-secret-value' }), dispose: () => { throw new Error('dispose super-secret-value'); } }));
    const registry = new PluginRegistry({ stateDir: directory, plugins: [value, disposing], developmentPackages: [] });
    registry.store.update('acme.logs', { secrets: { token: 'super-secret-value' } });
    registry.store.update('acme.disposes', { secrets: { token: 'super-secret-value' } });
    await registry.refresh();
    expect(JSON.stringify(await registry.descriptors())).not.toContain('super-secret-value');
    await registry.close();
    expect(JSON.stringify(await registry.descriptors())).not.toContain('super-secret-value');
    const restarted = new PluginRegistry({ stateDir: directory, plugins: [value], developmentPackages: [] });
    try {
      const logs = await restarted.logs('acme.logs');
      expect(logs.length).toBeGreaterThan(0); expect(logs.length).toBeLessThanOrEqual(256);
      expect(logs.at(-1)).toMatchObject({ pluginId: 'acme.logs', generation: 1, level: 'error', phase: 'activate' });
      expect(JSON.stringify(logs)).not.toContain('super-secret-value');
      expect(await byId(registry, 'acme.logs')).toMatchObject({ status: { message: expect.not.stringContaining('super-secret-value') } });
    } finally { await restarted.close(); }
  });

  it('recovers the last successful lazy version when a deferred upgrade first fails after restart', async () => {
    const directory = await stateDir();
    const packageDirectory = async (version: string, broken: boolean) => {
      const root = await stateDir();
      await writeFile(join(root, 'riffet-plugin.json'), JSON.stringify({ id: 'acme.lazy-upgrade', vendor: 'Acme', name: 'Upgrade', apiVersion: 1, version, defaultEnabled: true, activation: ['model-source'], dataVersion: broken ? 2 : 1, capabilities: ['models.provide'], entries: { server: 'index.mjs' }, contributes: { modelSources: [{ id: 'legacy-upgrade-source', title: { en: 'Source' }, protocols: ['openai-responses'] }] } }));
      await writeFile(join(root, 'index.mjs'), `import { readFile, writeFile } from 'node:fs/promises'; import { join } from 'node:path'; export default { async activate(host) { const file=join(await host.stateDir(),'data'); ${broken ? "await writeFile(file,'broken'); throw new Error('broken lazy upgrade');" : "const previous=await readFile(file,'utf8').catch(()=>'stable'); if(previous!=='stable')throw new Error('bad data'); await writeFile(file,'stable'); return { modelSources:[{id:'legacy-upgrade-source',label:'Source',protocols:['openai-responses'],resolve:()=>({}),catalog:async()=>[]}] };"} } };`);
      return root;
    };
    const first = new PluginRegistry({ stateDir: directory, plugins: [], developmentPackages: [] });
    await first.install({ input: { path: await packageDirectory('1.0.0', false) }, source: 'test', grant: ['models.provide'], trusted: true });
    await first.ensureContribution('model-source', 'legacy-upgrade-source');
    await first.close();
    const restarted = new PluginRegistry({ stateDir: directory, plugins: [], developmentPackages: [] });
    try {
      await restarted.refresh();
      expect(await restarted.install({ input: { path: await packageDirectory('2.0.0', true) }, source: 'test', grant: ['models.provide'], trusted: true })).toMatchObject({ version: '2.0.0', active: false });
      await restarted.setRecovery(true);
      await expect(restarted.ensureContribution('model-source', 'legacy-upgrade-source')).rejects.toMatchObject({ code: 'INTEGRATION_DISABLED' });
      await restarted.setRecovery(false);
      await restarted.ensureContribution('model-source', 'legacy-upgrade-source');
      expect(await byId(restarted, 'acme.lazy-upgrade')).toMatchObject({ version: '1.0.0', active: true, installed: { selected: '1.0.0', dataVersion: 1 } });
      expect(await readFile(join(directory, 'plugin-data/acme.lazy-upgrade/data'), 'utf8')).toBe('stable');
    } finally { await restarted.close(); }
  });
});

describe('integration store', () => {
  it('persists privately and atomically, keeping entries this build does not know', async () => {
    const dir = await stateDir();
    const file = join(dir, 'plugins.json');
    await writeFile(file, JSON.stringify({ version: 1, items: { 'other.thing': { enablement: 'off', future: true } } }), { mode: 0o644 });
    new PluginStore(dir).update('acme.demo', { enablement: 'on', settings: { region: 'eu' }, secrets: { token: 't' } });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['plugins.json']);
    const reread = new PluginStore(dir);
    expect(reread.item('acme.demo')).toEqual({ enablement: 'on', settings: { region: 'eu' }, secrets: { token: 't' } });
    expect(JSON.parse(await readFile(file, 'utf8')).items['other.thing']).toEqual({ enablement: 'off', future: true });
    reread.update('acme.demo', { secrets: { token: null } });
    expect(new PluginStore(dir).item('acme.demo').secrets).toEqual({});
    reread.setDevelopmentPackage('acme.demo', dir);
    const links = reread.developmentPackages(); links['acme.demo'] = '/changed';
    expect(new PluginStore(dir).developmentPackages()).toEqual({ 'acme.demo': dir });
    expect(() => reread.setDevelopmentPackage('acme.demo', 'relative')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    reread.setDevelopmentPackage('acme.demo', null);
    expect(new PluginStore(dir).developmentPackages()).toEqual({});
  });

  it('never overwrites a file it cannot read', async () => {
    const dir = await stateDir();
    const file = join(dir, 'plugins.json');
    await writeFile(file, '{"version":2}', { mode: 0o600 });
    const store = new PluginStore(dir);
    expect(() => store.update('acme.demo', { enablement: 'on' })).toThrow(expect.objectContaining({ code: 'INTEGRATIONS_STATE_CORRUPT' }));
    expect(await readFile(file, 'utf8')).toBe('{"version":2}');
  });
});

describe('plugin storage migration', () => {
  it.each(['none', 'settings', 'data'])('preserves settings, secrets, data and backups after a partial move (%s)', async (moved) => {
    const dir = await stateDir();
    const content = JSON.stringify({ version: 1, defaultSharePublisher: 'acme.demo', items: { 'acme.demo': { enablement: 'off', settings: { region: 'eu' }, secrets: { token: 'private-token' }, future: true } } });
    await writeFile(join(dir, 'integrations.json'), content, { mode: 0o600 });
    await mkdir(join(dir, 'integrations/acme.demo'), { recursive: true });
    await mkdir(join(dir, 'integrations/acme.demo.backup-v1'));
    await writeFile(join(dir, 'integrations/acme.demo/data'), 'current');
    await writeFile(join(dir, 'integrations/acme.demo.backup-v1/data'), 'backup');
    await mkdir(join(dir, 'plugins'));
    await writeFile(join(dir, 'plugins/installed.json'), '{"version":1,"plugins":[]}');
    if (moved === 'settings') await rename(join(dir, 'integrations.json'), join(dir, 'plugins.json'));
    if (moved === 'data') await rename(join(dir, 'integrations'), join(dir, 'plugin-data'));
    const store = new PluginStore(dir);
    const packages = new PackageStore(dir);
    migratePluginStorage(dir); // A later start has no legacy path left to move.
    expect(store.item('acme.demo')).toEqual({ enablement: 'off', settings: { region: 'eu' }, secrets: { token: 'private-token' } });
    expect(store.defaultSharePublisher()).toBe('acme.demo');
    expect(await readFile(join(dir, 'plugins.json'), 'utf8')).toBe(content);
    expect((await stat(join(dir, 'plugins.json'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(packages.dataDirectory('acme.demo'), 'data'), 'utf8')).toBe('current');
    expect(await readFile(join(dir, 'plugin-data/acme.demo.backup-v1/data'), 'utf8')).toBe('backup');
    expect(await readFile(join(dir, 'plugins/installed.json'), 'utf8')).toBe('{"version":1,"plugins":[]}');
    expect((await readdir(dir)).sort()).toEqual(['plugin-data', 'plugins', 'plugins.json']);
  });

  it.each(['settings', 'data'])('does not move either path when %s has a conflicting destination', async (conflict) => {
    const dir = await stateDir();
    await writeFile(join(dir, 'integrations.json'), 'legacy');
    await mkdir(join(dir, 'integrations'));
    await writeFile(join(dir, 'integrations/keep'), 'legacy-data');
    if (conflict === 'settings') await writeFile(join(dir, 'plugins.json'), 'independent');
    else { await mkdir(join(dir, 'plugin-data')); await writeFile(join(dir, 'plugin-data/keep'), 'independent'); }
    expect(() => migratePluginStorage(dir)).toThrow('both');
    expect(await readFile(join(dir, 'integrations.json'), 'utf8')).toBe('legacy');
    expect(await readFile(join(dir, 'integrations/keep'), 'utf8')).toBe('legacy-data');
    expect(await readFile(join(dir, conflict === 'settings' ? 'plugins.json' : 'plugin-data/keep'), 'utf8')).toBe('independent');
    expect(await readdir(dir)).not.toContain('server.lock');
  });

  it('refuses to migrate while another live process owns the state, and retains the daemon own lock', async () => {
    const dir = await stateDir();
    await writeFile(join(dir, 'integrations.json'), '{}');
    await writeFile(join(dir, 'server.lock'), String(process.ppid));
    expect(() => migratePluginStorage(dir)).toThrow('live server');
    expect(await readFile(join(dir, 'integrations.json'), 'utf8')).toBe('{}');
    await writeFile(join(dir, 'server.lock'), String(process.pid));
    migratePluginStorage(dir);
    expect(await readFile(join(dir, 'server.lock'), 'utf8')).toBe(String(process.pid));
    expect(await readFile(join(dir, 'plugins.json'), 'utf8')).toBe('{}');
  });

  it('does not follow a legacy settings symlink', async () => {
    const dir = await stateDir(), outside = await stateDir();
    await writeFile(join(outside, 'settings'), 'private');
    await symlink(join(outside, 'settings'), join(dir, 'integrations.json'));
    expect(() => migratePluginStorage(dir)).toThrow('not a regular file');
    expect(await readFile(join(outside, 'settings'), 'utf8')).toBe('private');
    await expect(stat(join(dir, 'plugins.json'))).rejects.toThrow();
  });
});

describe('integration registry', () => {
  it('recovery mode persists without executing external detection and restores the requested policy', async () => {
    const dir = await stateDir(), pkg = await stateDir();
    await writeFile(join(pkg, 'riffet-plugin.json'), JSON.stringify({ id: 'acme.recover', vendor: 'Acme', name: 'Recover', apiVersion: 1, defaultEnabled: 'auto', entries: { server: 'main.mjs' } }));
    await writeFile(join(pkg, 'main.mjs'), "import { writeFileSync } from 'node:fs'; export default { detect() { writeFileSync(new URL('./detected', import.meta.url), 'yes'); return true; }, activate() { return {}; } }");
    new PluginStore(dir).setRecovery(true);
    const registry = new PluginRegistry({ stateDir: dir, plugins: [], developmentPackages: [pkg] });
    await registry.refresh();
    expect(await byId(registry, 'acme.recover')).toMatchObject({ enabled: false, enablement: 'auto' });
    await expect(stat(join(pkg, 'detected'))).rejects.toThrow();
    await registry.setRecovery(false);
    expect(await byId(registry, 'acme.recover')).toMatchObject({ enabled: true, enablement: 'auto' });
    await registry.setRecovery(true);
    await registry.close();
    const restarted = new PluginRegistry({ stateDir: dir, plugins: [], developmentPackages: [pkg] });
    await restarted.refresh();
    expect(await byId(restarted, 'acme.recover')).toMatchObject({ enabled: false, enablement: 'auto' });
    await restarted.close();
  });

  it('does not reload a provider while a dependent has running tasks', async () => {
    let running = 1;
    const activate = vi.fn(() => ({}));
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [custom('acme.busy', activate), custom('acme.consumer', () => ({}), { requires: [{ id: 'acme.busy' }] })], runningTasks: id => id === 'acme.consumer' ? running : 0 });
    await registry.refresh();
    await expect(registry.reload('acme.busy')).rejects.toMatchObject({ code: 'PLUGIN_TASKS_RUNNING' });
    expect(activate).toHaveBeenCalledTimes(1);
    running = 0;
    await registry.reload('acme.busy');
    expect(activate).toHaveBeenCalledTimes(2);
    await registry.close();
  });

  it('runs diagnostics only for the requested plugin without detecting again', async () => {
    const detect = vi.fn(async () => true);
    const wanted = vi.fn(async () => [{ id: 'health', label: 'Health', status: 'ok' as const, detail: 'ready' }]);
    const unrelated = vi.fn(async () => []);
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [
      { ...custom('acme.checked', () => ({ doctorChecks: wanted }), { defaultEnabled: 'auto' }), detect },
      custom('acme.other', () => ({ doctorChecks: unrelated })),
    ] });
    await registry.refresh();
    detect.mockClear();
    expect(await registry.diagnostics('acme.checked')).toEqual([{ id: 'health', label: 'Health', status: 'ok', detail: 'ready' }]);
    expect(wanted).toHaveBeenCalledTimes(1);
    expect(unrelated).not.toHaveBeenCalled();
    expect(detect).not.toHaveBeenCalled();
    await registry.close();
  });

  it('rejects stale configuration edits without exposing secrets in the revision', async () => {
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [custom('acme.config', () => ({}), { settings: [{ key: 'token', label: 'Token', kind: 'secret' }] })] });
    await registry.refresh();
    const before = await byId(registry, 'acme.config');
    const saved = await registry.update('acme.config', { configRevision: before.configRevision, settings: { token: 'private-value' } });
    expect(saved.configRevision).not.toBe(before.configRevision);
    expect(JSON.stringify(saved)).not.toContain('private-value');
    await expect(registry.update('acme.config', { configRevision: before.configRevision, settings: { token: 'stale' } })).rejects.toMatchObject({ statusCode: 409, code: 'PLUGIN_CONFIG_CONFLICT' });
    expect(registry.store.item('acme.config').secrets.token).toBe('private-value');
    await registry.close();
  });

  it('contributes nothing without integrations', async () => {
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [] });
    await registry.refresh();
    expect([registry.modelSources(), registry.sharePublishers(), registry.runtimeHooks('traex'), await registry.descriptors(), await registry.doctorChecks()]).toEqual([[], [], [], [], []]);
  });

  it('rejects another API version and resolves enablement as explicit choice, then default, then detection', async () => {
    const dir = await stateDir();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const future = plugin({ id: 'acme.future', apiVersion: 2 as 1, defaultEnabled: true });
    const detected = plugin({ id: 'acme.detected' }, { detect: async () => true });
    const absent = plugin({ id: 'acme.absent' }, { detect: async () => false });
    const off = plugin({ id: 'acme.off' }, { detect: vi.fn(async () => true) });
    const on = plugin({ id: 'acme.on', defaultEnabled: false });
    new PluginStore(dir).update('acme.off', { enablement: 'off' });
    new PluginStore(dir).update('acme.on', { enablement: 'on' });
    const invalidate = vi.fn();
    const registry = new PluginRegistry({ stateDir: dir, plugins: [future.value, detected.value, absent.value, off.value, on.value], invalidateModelCatalogs: invalidate });
    await registry.refresh();
    expect(future.activate).not.toHaveBeenCalled();
    expect(off.value.detect).not.toHaveBeenCalled();
    expect(registry.modelSources().map(source => source.id)).toEqual(['acme-detected', 'acme-on']);
    const descriptors = await registry.descriptors();
    expect(descriptors.map(item => [item.id, item.enabled])).toEqual([['acme.detected', true], ['acme.absent', false], ['acme.off', false], ['acme.on', true], ['acme.future', false]]);
    expect(descriptors.at(-1)!.status).toMatchObject({ state: 'unavailable', message: expect.stringContaining('v2') });
    expect(detected.activate).toHaveBeenCalledTimes(1);

    invalidate.mockClear();
    expect(await registry.update('acme.detected', { enablement: 'off' })).toMatchObject({ enabled: false, enablement: 'off', contributes: {} });
    expect(registry.modelSources().map(source => source.id)).toEqual(['acme-on']);
    expect(invalidate).toHaveBeenCalledTimes(1);
    await expect(registry.update('acme.future', { enablement: 'on' })).rejects.toMatchObject({ statusCode: 404 });
    expect(new PluginStore(dir).item('acme.detected').enablement).toBe('off');
  });

  it('keeps device codes server-side and completes a sign-in once', async () => {
    let finish!: (step: ActionOutcome) => void;
    const poll = vi.fn(() => new Promise<ActionOutcome>(resolve => { finish = resolve; }));
    const { value } = plugin({ id: 'acme.login', defaultEnabled: true }, { contributions: { actions: {
      login: { label: 'Sign in', kind: 'device-flow', run: async () => ({ kind: 'device-flow', verificationUri: 'https://sso.example/device?code=ABCD', userCode: 'ABCD', intervalMs: 5000, expiresAt: Date.now() + 60_000, poll }) },
    } } });
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [value] });
    await registry.refresh();
    const shown = await registry.runAction('acme.login', 'login');
    if (shown.kind !== 'show-code') throw new Error(`unexpected ${shown.kind}`);
    expect(shown).toMatchObject({ userCode: 'ABCD', intervalMs: 5000, qrSvg: expect.stringContaining('<svg') });
    await expect(registry.pollFlow('acme.other', shown.flowId)).rejects.toMatchObject({ statusCode: 404 });
    const first = registry.pollFlow('acme.login', shown.flowId);
    expect(await registry.pollFlow('acme.login', shown.flowId)).toEqual({ kind: 'pending' });
    finish({ kind: 'done' });
    expect(await first).toEqual({ kind: 'done' });
    expect(poll).toHaveBeenCalledTimes(1);
    await expect(registry.pollFlow('acme.login', shown.flowId)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('integration lifecycle', () => {
  it('discards a failed activation, runs what it registered, keeps the diagnostic and recovers on the next evaluation', async () => {
    const disposed = vi.fn();
    let fail = true;
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [custom('acme.flaky', async (_host, scope) => {
      scope.onDispose(disposed);
      if (fail) throw new Error('boom');
      return { modelSources: [source('flaky')] };
    })] });
    await registry.refresh();
    expect(disposed).toHaveBeenCalledOnce();
    expect(registry.modelSources()).toEqual([]);
    expect(await byId(registry, 'acme.flaky')).toMatchObject({ enabled: false, status: { state: 'unavailable', message: 'activation failed: boom' } });
    fail = false;
    await registry.refresh();
    expect(registry.modelSources().map(item => item.id)).toEqual(['flaky']);
    expect((await byId(registry, 'acme.flaky')).status).toBeUndefined();
  });

  it('commits a staged activation only while it is still wanted, and numbers each activation', async () => {
    const generations: number[] = [];
    const signals: AbortSignal[] = [];
    const disposed = vi.fn();
    let release!: (value: Contributions) => void;
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [custom('acme.slow', (_host, scope) => {
      generations.push(scope.generation); signals.push(scope.signal); scope.onDispose(disposed);
      return new Promise<Contributions>(resolve => { release = resolve; });
    })] });
    const pass = registry.refresh();
    await vi.waitFor(() => expect(generations).toEqual([1]));
    expect(registry.modelSources()).toEqual([]);
    await registry.update('acme.slow', { enablement: 'off' });
    expect(signals[0]!.aborted).toBe(true);
    expect(disposed).toHaveBeenCalledOnce();
    const late = { modelSources: [source('slow')], dispose: vi.fn() };
    release(late);
    await pass;
    await vi.waitFor(() => expect(late.dispose).toHaveBeenCalledOnce());
    expect(registry.modelSources()).toEqual([]);

    const on = registry.update('acme.slow', { enablement: 'on' });
    await vi.waitFor(() => expect(generations).toEqual([1, 2]));
    release({ modelSources: [source('slow')] });
    await on;
    expect(registry.modelSources().map(item => item.id)).toEqual(['slow']);
  });

  it('turns off in order: lookups, flows, signal, then disposers last registered first, recording what fails', async () => {
    const order: string[] = [];
    let registry!: PluginRegistry;
    let scope!: ActivationScope;
    registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [custom('acme.order', (_host, given) => {
      scope = given;
      given.onDispose(() => { order.push('first'); });
      given.onDispose(() => { order.push(`second: ${registry.modelSources().length} sources, aborted ${given.signal.aborted}`); throw new Error('stuck'); });
      return {
        modelSources: [source('order')],
        dispose: () => { order.push('dispose'); },
        actions: { login: { label: 'Sign in', kind: 'device-flow', run: async () => ({ kind: 'device-flow', verificationUri: 'https://sso.example/', intervalMs: 1000, expiresAt: Date.now() + 60_000, poll: async () => ({ kind: 'done' }) }) } },
      };
    })] });
    await registry.refresh();
    const shown = await registry.runAction('acme.order', 'login');
    if (shown.kind !== 'show-code') throw new Error(`unexpected ${shown.kind}`);
    await registry.update('acme.order', { enablement: 'off' });
    expect(order).toEqual(['dispose', 'second: 0 sources, aborted true', 'first']);
    await expect(registry.pollFlow('acme.order', shown.flowId)).rejects.toMatchObject({ statusCode: 404 });
    expect(await byId(registry, 'acme.order')).toMatchObject({ enabled: false, status: { state: 'unavailable', message: expect.stringContaining('stuck') } });
    // Something registered after the end has nothing left to wait for.
    const late = vi.fn();
    scope.onDispose(late);
    await vi.waitFor(() => expect(late).toHaveBeenCalledOnce());
  });

  it('detects on refresh and after a change, not when the list is read', async () => {
    const detect = vi.fn(async () => true);
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [plugin({ id: 'acme.probe' }, { detect }).value] });
    await registry.refresh();
    await registry.descriptors();
    await registry.descriptors();
    expect(detect).toHaveBeenCalledTimes(1);
    await registry.refresh();
    expect(detect).toHaveBeenCalledTimes(2);
    await registry.update('acme.probe', { enablement: 'auto' });
    expect(detect).toHaveBeenCalledTimes(3);
  });

  it('activates a required integration first, and keeps dependents off while it is missing or off; a cycle is rejected', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const order: string[] = [];
    const run = (name: string) => () => { order.push(name); return {}; };
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [
      custom('acme.app', run('app'), { requires: [{ id: 'acme.base' }] }),
      custom('acme.orphan', run('orphan'), { requires: [{ id: 'acme.absent' }] }),
      custom('acme.lenient', run('lenient'), { requires: [{ id: 'acme.absent', optional: true }] }),
      custom('acme.base', run('base'), { defaultEnabled: false }),
      custom('acme.a', run('a'), { requires: [{ id: 'acme.b' }] }),
      custom('acme.b', run('b'), { requires: [{ id: 'acme.a' }] }),
    ] });
    await registry.refresh();
    expect(order).toEqual(['lenient']);
    expect(await byId(registry, 'acme.app')).toMatchObject({ enabled: false, status: { message: 'requires acme.base' } });
    expect(await byId(registry, 'acme.orphan')).toMatchObject({ enabled: false, status: { message: 'requires acme.absent' } });
    expect(await byId(registry, 'acme.a')).toMatchObject({ enabled: false, status: { message: expect.stringContaining('dependency cycle') } });

    await registry.update('acme.base', { enablement: 'on' });
    expect(order).toEqual(['lenient', 'base', 'app']);
    expect((await byId(registry, 'acme.app')).enabled).toBe(true);
    await registry.update('acme.base', { enablement: 'off' });
    expect(await byId(registry, 'acme.app')).toMatchObject({ enabled: false, status: { message: 'requires acme.base' } });
  });

  it('lets a plugin hold a long-lived resource through its scope: turning it off detaches, it does not stop', async () => {
    const attachment = { detach: vi.fn(), stop: vi.fn(async () => undefined) };
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [custom('acme.sidecar', (_host, scope) => {
      scope.onDispose(() => attachment.detach());
      return {};
    })] });
    await registry.refresh();
    await registry.update('acme.sidecar', { enablement: 'off' });
    expect([attachment.detach.mock.calls.length, attachment.stop.mock.calls.length]).toEqual([1, 0]);
  });
});

describe('registry hardening', () => {
  it('ends an activation that never resolves as a problem, without holding the queue', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const disposed = vi.fn();
    const registry = new PluginRegistry({ stateDir: await stateDir(), activationTimeoutMs: 40, plugins: [custom('acme.stuck', (_host, scope) => { scope.onDispose(disposed); return new Promise<Contributions>(() => undefined); })] });
    await registry.refresh();
    expect(await byId(registry, 'acme.stuck')).toMatchObject({ enabled: false, status: { state: 'unavailable', message: expect.stringContaining('did not finish within') } });
    expect(disposed).toHaveBeenCalledOnce();
    // The next change on the same plugin is not stuck behind it.
    expect(await registry.update('acme.stuck', { enablement: 'off' })).toMatchObject({ enabled: false, enablement: 'off' });
  });

  it('turns dependents off before what they depend on, on a change and on close', async () => {
    const order: string[] = [];
    const watching = (name: string, requires?: string) => custom(`acme.${name}` as PluginManifest['id'], (_host, scope) => { scope.onDispose(() => { order.push(name); }); return {}; }, requires ? { requires: [{ id: requires }] } : {});
    const make = async () => new PluginRegistry({ stateDir: await stateDir(), plugins: [watching('top', 'acme.middle'), watching('middle', 'acme.base'), watching('base')] });
    const first = await make();
    await first.refresh();
    await first.update('acme.base', { enablement: 'off' });
    expect(order).toEqual(['top', 'middle', 'base']);
    order.length = 0;
    const second = await make();
    await second.refresh();
    await second.close();
    expect(order).toEqual(['top', 'middle', 'base']);
  });

  it('registers no sign-in for an integration that was turned off meanwhile, and refuses to poll one that is off', async () => {
    let finish!: () => void;
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [custom('acme.late', () => ({ actions: {
      login: { label: 'Sign in', kind: 'device-flow', run: () => new Promise(resolve => { finish = () => resolve({ kind: 'device-flow', verificationUri: 'https://sso.example/', intervalMs: 1000, expiresAt: Date.now() + 60_000, poll: async () => ({ kind: 'done' }) }); }) },
    } }))] });
    await registry.refresh();
    const started = registry.runAction('acme.late', 'login');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await registry.update('acme.late', { enablement: 'off' });
    finish();
    await expect(started).rejects.toMatchObject({ statusCode: 409 });
    await expect(registry.pollFlow('acme.late', 'anything')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('records what a failed activation could not release', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [custom('acme.messy', (_host, scope) => {
      scope.onDispose(() => { throw new Error('socket still open'); });
      throw new Error('boom');
    })] });
    await registry.refresh();
    expect(await byId(registry, 'acme.messy')).toMatchObject({ enabled: false, status: { message: 'activation failed: boom' } });
    expect((await registry.doctorChecks()).map(check => check.detail)).toEqual(expect.arrayContaining([expect.stringContaining('socket still open')]));
  });

  it('marks an unloaded entry that shares an id rejected, and drops members of a declaration this version does not know', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const view = { id: 'acme.shown/view', title: { en: 'View' }, locations: ['sidebar'], clients: ['web'], instances: 'single', when: { hasProject: true }, extra: 1, icon: { sfSymbol: 'star', hidden: true } };
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [
      custom('acme.shown', () => ({}), { contributes: { views: [view as never], commands: [{ id: 'acme.shown/run', title: { en: 'Run' }, secret: true } as never] } }),
      custom('acme.shown', () => ({}), { contributes: { views: [{ ...view, id: 'acme.shown/other' } as never] } }),
    ] });
    await registry.refresh();
    const rows = await registry.descriptors();
    expect(rows.filter(item => item.rejected).map(item => [item.id, item.enabled])).toEqual([['acme.shown', false]]);
    expect(rows.find(item => !item.rejected)!.declared).toEqual({
      views: [{ id: 'acme.shown/view', title: { en: 'View' }, locations: ['sidebar'], clients: ['web'], instances: 'single', when: { hasProject: true }, icon: { sfSymbol: 'star' } }],
      commands: [{ id: 'acme.shown/run', title: { en: 'Run' } }],
    });
  });

  it('answers agentProfiles for the Agents a plugin declares only', async () => {
    const profiles = vi.fn((backendId: string) => [{ id: 'p', name: backendId, isDefault: true, config: { apiKey: 'secret' } }]);
    let seen: PluginManifest['id'] | undefined;
    const own = custom('acme.agentic', host => { seen = host.id; return {}; }, { contributes: { agentBackends: [{ id: 'acme.agentic', title: { en: 'Agentic' } }] } });
    const other = custom('acme.plain', () => ({}));
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [own, other], agentProfiles: profiles as never });
    await registry.refresh();
    expect(seen).toBe('acme.agentic');
    const hostOf = (id: string) => (registry as unknown as { entries: Map<string, { host: PluginHost }> }).entries.get(id)!.host;
    expect(hostOf('acme.agentic').agentProfiles?.('acme.agentic' as never)).toHaveLength(1);
    expect(hostOf('acme.agentic').agentProfiles?.('claude')).toEqual([]);
    expect(hostOf('acme.plain').agentProfiles?.('claude')).toBeUndefined();
    expect(profiles).toHaveBeenCalledTimes(1);
  });
});

describe('share publisher selection', () => {
  const publisher = (label: string): SharePublisher => ({ label, audience: 'Anyone', capability: async () => ({ available: true, username: 'owner' }), deploy: vi.fn(), find: vi.fn(), remove: vi.fn(), verify: vi.fn() });

  it('lists the enabled publishers in precedence order, finds one by owner, and uses the saved default only while it is enabled', async () => {
    const dir = await stateDir();
    const registry = new PluginRegistry({ stateDir: dir, plugins: [
      plugin({ id: 'acme.first', defaultEnabled: true }, { contributions: { sharePublisher: publisher('First') } }).value,
      plugin({ id: 'acme.second', defaultEnabled: true }, { contributions: { sharePublisher: publisher('Second') } }).value,
      plugin({ id: 'acme.plain', defaultEnabled: true }).value,
    ] });
    await registry.refresh();
    expect(registry.sharePublishers().map(item => item.owner)).toEqual(['acme.first', 'acme.second']);
    expect(registry.defaultSharePublisher()?.owner).toBe('acme.first');

    registry.setDefaultSharePublisher('acme.second');
    expect(registry.defaultSharePublisher()?.owner).toBe('acme.second');
    // An existing share keeps asking its own publisher, whatever new shares use.
    expect(registry.sharePublisher('acme.first')?.publisher.label).toBe('First');
    expect(new PluginStore(dir).defaultSharePublisher()).toBe('acme.second');

    await registry.update('acme.second', { enablement: 'off' });
    expect(registry.sharePublisher('acme.second')).toBeUndefined();
    expect(registry.defaultSharePublisher()?.owner).toBe('acme.first');
    await registry.update('acme.second', { enablement: 'on' });
    expect(registry.defaultSharePublisher()?.owner).toBe('acme.second');

    expect(() => registry.setDefaultSharePublisher('acme.unknown')).toThrow(expect.objectContaining({ statusCode: 404 }));
    registry.setDefaultSharePublisher(null);
    expect(new PluginStore(dir).defaultSharePublisher()).toBeUndefined();
    expect(registry.defaultSharePublisher()?.owner).toBe('acme.first');
  });
});

describe('plugin manifests', () => {
  const title = { en: 'View' };
  const view = (id: string, extra: Record<string, unknown> = {}) => ({ id, title, locations: ['sidebar'], clients: ['web'], instances: 'single', ...extra });

  it('lists declarations while the plugin is off and rejects invalid ones with a reason', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad: Array<[string, unknown]> = [
      ['acme.b1', { views: [view('other.plugin/x')] }],
      ['acme.b2', { views: [view('acme.b2/x', { locations: ['nowhere'] })] }],
      ['acme.b3', { views: [view('acme.b3/x', { clients: ['ios'] })] }],
      ['acme.b4', { views: [view('acme.b4/x'), view('acme.b4/x')] }],
      ['acme.b5', { commands: [{ id: 'acme.b5/run', title, when: { script: 'true' } }] }],
    ];
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [
      custom('acme.good', () => ({}), { defaultEnabled: false, version: '1.2.3', title: { 'zh-Hans': '画布', en: 'Canvas' }, contributes: { views: [view('acme.good/flow', { locations: ['session-view'], defaultLocation: 'session-view' }) as never] } }),
      ...bad.map(([id, contributes]) => custom(id as PluginManifest['id'], () => ({}), { contributes: contributes as never })),
    ] });
    await registry.refresh();
    expect(await byId(registry, 'acme.good')).toMatchObject({ enabled: false, source: 'builtin', version: '1.2.3', title: { en: 'Canvas' }, declared: { views: [{ id: 'acme.good/flow' }] } });
    expect(registry.modelSources()).toEqual([]);
    const reasons = (await registry.descriptors()).filter(item => item.id !== 'acme.good').map(item => item.status?.message ?? '');
    expect(reasons).toEqual([expect.stringContaining('acme.b1/<name>'), expect.stringContaining('unknown location'), expect.stringContaining('unknown client'), expect.stringContaining('declared twice'), expect.stringContaining('unknown condition')]);
  });

  it('loads a trusted development package without letting it take a built-in id, and serves only its allowed files from inside it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outside = await stateDir();
    await writeFile(join(outside, 'secret.js'), 'secret');
    const base = { vendor: 'Acme', apiVersion: 1, defaultEnabled: true };
    const pkg = await stateDir();
    await mkdir(join(pkg, 'server')); await mkdir(join(pkg, 'web'));
    await writeFile(join(pkg, 'riffet-plugin.json'), JSON.stringify({ ...base, id: 'acme.dev', name: 'Dev', version: '0.1.0', capabilities: ['sessions.read'], entries: { server: 'server/index.mjs', web: 'web/index.js' } }));
    await writeFile(join(pkg, 'server/index.mjs'), `export default { activate: () => ({ modelSources: [{ id: 'dev-source', label: 'Dev', backends: ['codex'], resolve: () => ({}), catalog: async () => [] }] }) };`);
    await writeFile(join(pkg, 'web/index.js'), 'export {};');
    await writeFile(join(pkg, 'server/helper.js'), 'export const secret = 1;');
    await writeFile(join(pkg, 'notes.txt'), 'private');
    await symlink(join(outside, 'secret.js'), join(pkg, 'web/leak.js'));
    const clash = await stateDir();
    await writeFile(join(clash, 'riffet-plugin.json'), JSON.stringify({ ...base, id: 'acme.builtin', name: 'Impostor' }));
    const escaping = await stateDir();
    await writeFile(join(escaping, 'riffet-plugin.json'), JSON.stringify({ ...base, id: 'acme.escape', name: 'Escape', entries: { server: '../outside.mjs' } }));

    // A web entry that is a module file outside web/: served as that entry and nothing beside it; a server entry that is a .js file never.
    const alt = await stateDir();
    await mkdir(join(alt, 'ui'));
    await writeFile(join(alt, 'riffet-plugin.json'), JSON.stringify({ ...base, id: 'acme.alt', name: 'Alt', entries: { server: 'index.js', web: 'ui/app.mjs' }, contributes: { views: [{ id: 'acme.alt/v', title: { en: 'V' }, icon: { svg: 'ui/icon.svg' }, locations: ['sidebar'], clients: ['web'], instances: 'single' }] } }));
    await writeFile(join(alt, 'index.js'), 'export default { activate: () => ({}) };');
    await writeFile(join(alt, 'ui/app.mjs'), 'export {};');
    await writeFile(join(alt, 'ui/other.mjs'), 'export {};');
    await writeFile(join(alt, 'ui/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [plugin({ id: 'acme.builtin', defaultEnabled: true }).value], developmentPackages: [pkg, clash, escaping, alt] });
    await registry.refresh();
    expect(registry.modelSources().map(item => item.id)).toContain('dev-source');
    expect(await byId(registry, 'acme.dev')).toMatchObject({ source: 'development', enabled: true, version: '0.1.0', webEntry: { path: 'web/index.js' }, capabilities: ['sessions.read'] });
    expect(await byId(registry, 'acme.builtin')).toMatchObject({ source: 'builtin', name: 'acme.builtin' });
    expect((await registry.descriptors()).filter(item => item.source === 'development' && !item.enabled).map(item => item.status?.message)).toEqual([
      'a built-in plugin has this id', expect.stringContaining('entries.server'),
    ]);

    expect(await registry.developmentFile('acme.dev', 'web/index.js')).toMatchObject({ type: 'text/javascript; charset=utf-8' });
    for (const [id, path] of [['acme.dev', 'web/leak.js'], ['acme.dev', 'notes.txt'], ['acme.dev', 'server/index.mjs'], ['acme.dev', 'server/helper.js'], ['acme.dev', './server/index.mjs'], ['acme.dev', '../web/index.js'], ['acme.dev', 'web/missing.js'], ['acme.builtin', 'web/index.js']]) {
      await expect(registry.developmentFile(id!, path!)).rejects.toMatchObject({ statusCode: 404 });
    }
    expect(await registry.developmentFile('acme.alt', 'ui/app.mjs')).toMatchObject({ type: 'text/javascript; charset=utf-8' });
    expect(await registry.developmentFile('acme.alt', 'ui/icon.svg')).toMatchObject({ type: 'image/svg+xml' });
    for (const path of ['index.js', 'ui/other.mjs']) await expect(registry.developmentFile('acme.alt', path)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('plugin dependencies and services', () => {
  it('turns a dependent off and on again when an optional dependency comes or goes', async () => {
    const used: boolean[] = [];
    const disposed = vi.fn();
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [
      custom('acme.base', () => ({ services: { scan: { version: '1.2.0' } } }), { defaultEnabled: false }),
      custom('acme.app', (host, scope) => { scope.onDispose(disposed); used.push(Boolean(host.services!.get('acme.base', 'scan', '^1'))); return {}; }, { requires: [{ id: 'acme.base', optional: true }] }),
    ] });
    await registry.refresh();
    expect(used).toEqual([false]);
    await registry.update('acme.base', { enablement: 'on' });
    expect(used).toEqual([false, true]);
    expect(disposed).toHaveBeenCalledTimes(1);
    await registry.update('acme.base', { enablement: 'off' });
    expect(used).toEqual([false, true, false]);
    expect((await byId(registry, 'acme.app')).enabled).toBe(true);
  });

  it('hands a service only to a plugin that requires its provider, for a matching version, while the provider is on', async () => {
    const scan = { version: '1.2.0', run: (value: string) => `scanned ${value}` };
    const hosts: Record<string, PluginHost> = {};
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [
      custom('acme.base', () => ({ services: { scan } })),
      custom('acme.app', host => { hosts.app = host; return {}; }, { requires: [{ id: 'acme.base' }] }),
      custom('acme.other', host => { hosts.other = host; return {}; }),
    ] });
    await registry.refresh();
    const get = (range: string, name = 'scan') => hosts.app!.services!.get('acme.base', name, range);
    expect(get('^1')).toBe(scan);
    expect([get('^2'), get('>=1.3'), get('^1', 'missing')]).toEqual([undefined, undefined, undefined]);
    expect(() => hosts.other!.services!.get('acme.base', 'scan', '^1')).toThrow(expect.objectContaining({ code: 'PLUGIN_SERVICE_NOT_REQUIRED' }));
    await registry.update('acme.base', { enablement: 'off' });
    expect(get('^1')).toBeUndefined();
  });

  it('refuses an activation whose services have no valid version', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const registry = new PluginRegistry({ stateDir: await stateDir(), plugins: [custom('acme.bad', () => ({ services: { scan: { version: 'latest' } } }))] });
    await registry.refresh();
    expect(await byId(registry, 'acme.bad')).toMatchObject({ enabled: false, status: { message: expect.stringContaining('service "scan"') } });
  });
});

describe('what a list read waits for', () => {
  it('answers from the last known status when a plugin\'s status() is slow, without piling up calls', async () => {
    let slow = false;
    const status = vi.fn((): Promise<{ state: 'ready'; message: string }> => (slow ? new Promise(() => undefined) : Promise.resolve({ state: 'ready', message: 'fine' })));
    const registry = new PluginRegistry({ stateDir: await stateDir(), statusTimeoutMs: 30, plugins: [
      custom('acme.flaky', () => ({ status })),
      custom('acme.mute', () => ({ status: () => new Promise(() => undefined) })),
    ] });
    await registry.refresh();
    expect(await byId(registry, 'acme.flaky')).toMatchObject({ status: { state: 'ready', message: 'fine' } });
    slow = true;
    expect(await byId(registry, 'acme.flaky')).toMatchObject({ status: { state: 'ready', message: 'fine' } });
    await byId(registry, 'acme.flaky');
    expect(status).toHaveBeenCalledTimes(2);
    expect(await byId(registry, 'acme.mute')).toMatchObject({ enabled: true, status: { state: 'attention', message: 'status timed out' } });
  });

  it('does not run a development package while it is off', async () => {
    const dir = await stateDir();
    const pkg = await stateDir();
    const marker = join(pkg, 'ran');
    await writeFile(join(pkg, 'riffet-plugin.json'), JSON.stringify({ vendor: 'Acme', apiVersion: 1, defaultEnabled: true, id: 'acme.lazy', name: 'Lazy', entries: { server: 'server.mjs' } }));
    await writeFile(join(pkg, 'server.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran'); export default { activate: () => ({}) };`);
    new PluginStore(dir).update('acme.lazy', { enablement: 'off' });
    const registry = new PluginRegistry({ stateDir: dir, plugins: [], developmentPackages: [pkg] });
    await registry.refresh();
    expect(await byId(registry, 'acme.lazy')).toMatchObject({ source: 'development', enabled: false, enablement: 'off' });
    expect(await stat(marker).catch(() => undefined)).toBeUndefined();
    expect(await registry.update('acme.lazy', { enablement: 'on' })).toMatchObject({ enabled: true });
    expect(await readFile(marker, 'utf8')).toBe('ran');
  });
});

describe('turning off or switching with running tasks', () => {
  const task = { id: 'acme.build/run', detect: async () => true, actions: async () => [], plan: async () => ({ file: 'sh', args: [] }) };
  const build = () => custom('acme.build', () => ({ taskProviders: [task], commands: { 'acme.build/go': { run: async () => ({ kind: 'done' as const }) } } }), {
    version: '1.0.0', contributes: { tasks: [{ id: 'acme.build/run', title: { en: 'Run' } }], commands: [{ id: 'acme.build/go', title: { en: 'Go' } }] },
  });

  it('waits for them, refuses new tasks and commands meanwhile, and goes ahead when the last one ends or the update is forced', async () => {
    let running = 1;
    const registry = new PluginRegistry({ stateDir: await stateDir(), runningTasks: () => running, plugins: [build()] });
    await registry.refresh();
    expect(registry.command('acme.build', 'acme.build/go').declaration.id).toBe('acme.build/go');

    expect(await registry.update('acme.build', { enablement: 'off' })).toMatchObject({
      enabled: true, enablement: 'off', stopping: { running: 1 }, status: { state: 'attention', message: expect.stringContaining('1 running task') },
    });
    expect(registry.isStopping('acme.build')).toBe(true);
    expect(registry.taskProviders()).toEqual([]);
    expect(() => registry.command('acme.build', 'acme.build/go')).toThrow(expect.objectContaining({ code: 'COMMAND_UNAVAILABLE', statusCode: 409 }));
    // What the running task is read with is the version that started it, which is still up.
    expect(registry.taskProviderFor('acme.build', 'acme.build/run', '1.0.0')?.provider).toBe(task);
    expect(registry.taskProviderFor('acme.build', 'acme.build/run', '0.9.0')).toBeUndefined();

    running = 0;
    registry.tasksChanged();
    await vi.waitFor(async () => expect((await byId(registry, 'acme.build')).enabled).toBe(false));
    expect(registry.taskProviderFor('acme.build', 'acme.build/run', '1.0.0')).toBeUndefined();

    // Chosen on again while it waits: nothing stops.
    running = 2;
    await registry.update('acme.build', { enablement: 'on' });
    await registry.update('acme.build', { enablement: 'off' });
    expect((await byId(registry, 'acme.build')).stopping).toBeDefined();
    expect(await registry.update('acme.build', { enablement: 'on' })).toMatchObject({ enabled: true });
    expect((await byId(registry, 'acme.build')).stopping).toBeUndefined();
    expect(registry.taskProviders()).toHaveLength(1);

    // Forced: now, with the tasks still running.
    expect(await registry.update('acme.build', { enablement: 'off', force: true })).toMatchObject({ enabled: false });
    expect((await byId(registry, 'acme.build')).stopping).toBeUndefined();
    await registry.update('acme.build', { enablement: 'on' });
    await registry.update('acme.build', { enablement: 'off' });
    expect(await registry.update('acme.build', { force: true })).toMatchObject({ enabled: false });
  });

  it('switches an installed package to another version once its tasks end, or at once when forced', async () => {
    let running = 1;
    const packageDirectory = async (version: string) => {
      const directory = await stateDir();
      await mkdir(join(directory, 'server'));
      await writeFile(join(directory, 'riffet-plugin.json'), JSON.stringify({ id: 'acme.swap', vendor: 'Acme', name: 'Swap', apiVersion: 1, version, defaultEnabled: true, entries: { server: 'server/index.mjs' } }));
      await writeFile(join(directory, 'server/index.mjs'), 'export default { activate: () => ({}) };');
      return directory;
    };
    const registry = new PluginRegistry({ stateDir: await stateDir(), runningTasks: () => running, plugins: [], developmentPackages: [] });
    const install = async (version: string) => registry.install({ input: { path: await packageDirectory(version) }, source: 'test', grant: [] });
    expect(await install('1.0.0')).toMatchObject({ enabled: true, version: '1.0.0' });
    try {
      expect(await install('2.0.0')).toMatchObject({ enabled: true, version: '1.0.0', stopping: { running: 1, version: '2.0.0' }, installed: { selected: '1.0.0' } });
      running = 0;
      registry.tasksChanged();
      await vi.waitFor(async () => expect(await byId(registry, 'acme.swap')).toMatchObject({ version: '2.0.0', installed: { selected: '2.0.0' } }));
      expect((await byId(registry, 'acme.swap')).stopping).toBeUndefined();

      running = 1;
      expect(await registry.selectVersion('acme.swap', '1.0.0')).toMatchObject({ version: '2.0.0', stopping: { version: '1.0.0' } });
      expect(await registry.update('acme.swap', { force: true })).toMatchObject({ version: '1.0.0', installed: { selected: '1.0.0' } });
    } finally { await registry.close(); }
  });
});
