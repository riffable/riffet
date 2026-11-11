import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { NativeBackendHost, NativeBackendProfileConfig } from '../types.js';
import type { Project, Session } from '../../../../../packages/contracts/src/index.js';
import { runtimeSettings } from './settings.js';
import { provisionBridgeProfile } from './bridge.js';
import { getDshProfileRuntime } from './runtime.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function profile(): Promise<NativeBackendProfileConfig> {
  const root = await mkdtemp(join(tmpdir(), 'riffet-dsh-profile-'));
  roots.push(root);
  return { id: 'work', backendId: 'dsh', name: 'DSH', config: { configDir: root } };
}

describe('DSH extension persistence', () => {
  it('reuses a busy runtime after changing only the default model or display metadata', async () => {
    const base = await profile();
    const host = {} as NativeBackendHost;
    const first = getDshProfileRuntime(base, host);
    const internal = first as unknown as { peer: unknown; byWorkbenchId: Map<string, unknown> };
    internal.peer = {};
    internal.byWorkbenchId.set('active', { status: { phase: 'busy' }, interactionRequests: new Map() });
    const updated = { ...base, name: 'Renamed', config: { ...base.config, defaultModel: 'new-default', name: 'Renamed', isDefault: true } };
    const reused = getDshProfileRuntime(updated, host);
    expect(reused).toBe(first);
    expect(reused.settings.defaultModel).toBe('new-default');
    expect(reused.profile).toBe(updated);
    expect(await readdir(base.config.configDir as string)).toEqual([]);
  });
  it('uses the refreshed default for a new conversation and preserves an existing selection', async () => {
    const base = await profile();
    base.config.defaultModel = 'old-default';
    const sessions = new Map<string, Session>();
    const host = {
      updateSession: (id: string, patch: Partial<Session>) => {
        const updated = { ...sessions.get(id)!, ...patch };
        sessions.set(id, updated);
        return updated;
      },
      emit: vi.fn(),
    } as unknown as NativeBackendHost;
    const runtime = getDshProfileRuntime(base, host);
    const request = vi.fn(async () => ({ status: 'idle' }));
    const internal = runtime as unknown as { ensureStarted: unknown; request: unknown; emitStatus: unknown };
    internal.ensureStarted = async () => true;
    internal.request = request;
    internal.emitStatus = () => undefined;
    const project = { id: 'project', cwd: '/tmp/dsh-preferences' } as Project;
    const existing = { id: 'existing', projectId: project.id, model: 'dsh:deepseek-official:old-default' } as Session;
    const added = { id: 'new', projectId: project.id } as Session;
    sessions.set(existing.id, existing);
    sessions.set(added.id, added);
    await runtime.open(existing, project, base);
    const updated = { ...base, config: { ...base.config, defaultModel: 'new-default' } };
    expect(getDshProfileRuntime(updated, host)).toBe(runtime);
    await runtime.open(added, project, updated);
    await runtime.open(sessions.get(existing.id)!, project, updated);
    const selections = request.mock.calls.map(call => (call as unknown as [string, { selection: { model: string } }])[1].selection.model);
    expect(selections).toEqual(['old-default', 'new-default', 'old-default']);
    expect(sessions.get(existing.id)?.model).toBe('dsh:deepseek-official:old-default');
    expect(sessions.get(added.id)?.model).toBe('dsh:deepseek-official:new-default');
  });
  it('keys catalog changes by the patch DSH actually loads', async () => {
    const base = await profile();
    const plain = runtimeSettings(base);
    expect(runtimeSettings({ ...base, config: { ...base.config, enabledModels: ['picker-only'] } }).key).toBe(plain.key);
    const endpoint = { ...base, config: { ...base.config, apiEndpoint: 'https://gateway.example', enabledModels: ['model-one'] } };
    const withoutDeclarations = runtimeSettings(endpoint);
    expect(runtimeSettings({ ...endpoint, config: { ...endpoint.config, enabledModels: ['model-two'] } }).key).toBe(withoutDeclarations.key);
    const declared = { ...endpoint, config: { ...endpoint.config, modelInputModalities: { 'model-one': ['text', 'image'] } } };
    const configured = runtimeSettings(declared);
    expect(configured.key).not.toBe(withoutDeclarations.key);
    expect(runtimeSettings({ ...declared, config: { ...declared.config, enabledModels: ['dsh:deepseek-official:model-one[effort=max]', 'model-one'] } }).key).toBe(configured.key);
    expect(runtimeSettings({ ...declared, config: { ...declared.config, enabledModels: ['model-one', 'model-two'] } }).key).not.toBe(configured.key);
    expect(runtimeSettings({ ...declared, config: { ...declared.config, modelInputModalities: { 'model-one': ['text'] } } }).key).not.toBe(configured.key);
  });
  it.each(['executable', 'sourceDir', 'configDir', 'apiEndpoint', 'apiKey'])('keeps %s changes in the launch identity', async field => {
    const base = await profile();
    expect(runtimeSettings({ ...base, config: { ...base.config, [field]: field === 'apiEndpoint' ? 'https://gateway.example' : '/different-value' } }).key)
      .not.toBe(runtimeSettings(base).key);
  });
  it('keeps the user profile stable while runtime connection settings change', async () => {
    const base = await profile();
    const first = runtimeSettings(base);
    const next = runtimeSettings({ ...base, config: { ...base.config, apiEndpoint: 'https://gateway.example', apiKey: 'private-key', defaultModel: 'another-model' } });
    expect(first.profileDir).toBe(next.profileDir);
    expect(first.key).not.toBe(next.key);
    expect(first.bridgePatchPath).not.toBe(next.bridgePatchPath);
    expect(runtimeSettings({ ...base, id: 'personal' }).profileDir).not.toBe(first.profileDir);
  });
  it('preserves native bundle changes and the user patch across provision and model changes', async () => {
    const base = await profile();
    const first = runtimeSettings(base);
    await provisionBridgeProfile(first);
    const manifestPath = join(first.profileDir, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.dsh.profile.bundles.push('example-user-bundle');
    manifest.dependencies['example-user-bundle'] = '1.2.3';
    manifest.userMetadata = { retain: true };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const userPatch = '- id: example-user-plugin\n  disabled: true\n';
    await writeFile(join(first.profileDir, 'cordis.patch.yml'), userPatch);
    await provisionBridgeProfile(runtimeSettings({ ...base, config: { ...base.config, apiEndpoint: 'https://other.example', apiKey: 'do-not-save-this', defaultModel: 'model-two' } }));
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual(manifest);
    expect(await readFile(join(first.profileDir, 'cordis.patch.yml'), 'utf8')).toBe(userPatch);
    const overlays = (await readdir(first.profileDir)).filter(name => name.startsWith('.riffet-bridge-'));
    expect(overlays).toHaveLength(2);
    for (const file of overlays) expect(await readFile(join(first.profileDir, file), 'utf8')).not.toContain('do-not-save-this');
  });
  it('does not take over a profile belonging to another application', async () => {
    const settings = runtimeSettings(await profile());
    await mkdir(settings.profileDir, { recursive: true });
    await writeFile(join(settings.profileDir, 'package.json'), '{"name":"other"}');
    await expect(provisionBridgeProfile(settings)).rejects.toThrow('Refusing to replace');
    expect(await readFile(join(settings.profileDir, 'package.json'), 'utf8')).toBe('{"name":"other"}');
  });
  it.each(['endpoint', 'apiKey', 'catalog'])('refuses a second %s configuration writer while the stable profile is busy', async change => {
    const base = await profile();
    if (change !== 'endpoint') base.config.apiEndpoint = 'https://new.example';
    const host = {} as NativeBackendHost;
    const old = getDshProfileRuntime(base, host);
    const state = old as unknown as { peer: unknown; byWorkbenchId: Map<string, unknown> };
    state.peer = {};
    state.byWorkbenchId.set('active', { status: { phase: 'busy' }, interactionRequests: new Map() });
    const config = { ...base.config, apiEndpoint: 'https://new.example', ...(change === 'apiKey' ? { apiKey: 'new-key' } : {}), ...(change === 'catalog' ? { modelInputModalities: { 'image-model': ['text', 'image'] } } : {}) };
    const next = getDshProfileRuntime({ ...base, config }, host);
    await expect(next.manageExtension('install', 'test-plugin')).rejects.toMatchObject({ code: 'DSH_PROFILE_BUSY' });
    expect(await readdir(base.config.configDir as string)).toEqual([]);
  });
});
