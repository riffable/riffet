import { describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import type { Project } from '../../../../../packages/contracts/src/index.js';
import type { NativeBackendHost, NativeBackendProfileConfig } from '../types.js';
import { CodexBackendAdapter } from './index.js';
import { codexFlavor, traexFlavor } from './flavors.js';
import { mcpRuntimeEntries, readMcpRuntime } from './extensions.js';
import type { CodexAppServerClient } from '../shared/codex-app-server.js';

describe('extension runtime observation', () => {
  it('does not equate a cached tool list with a live connection', () => {
    const rows = mcpRuntimeEntries({ data: [
      { name: 'cached', tools: { read: {} }, authStatus: 'oAuth' },
      { name: 'connected', runtimeStatus: 'connected', tools: {} },
      { name: 'expired', runtimeStatus: 'authenticationRequired', tools: { stale: {} } },
    ] }, 'session');
    expect(rows.map(row => row.state)).toEqual(['unknown', 'loaded', 'error']);
  });
  it('reads all MCP pages and bounds repeated cursors', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: [{ name: 'one' }], nextCursor: 'two' }).mockResolvedValueOnce({ data: [{ name: 'two' }], nextCursor: 'two' });
    const rows = await readMcpRuntime({ request } as unknown as CodexAppServerClient, 's', 'thread');
    expect(rows.map(row => row.name)).toEqual(['one', 'two']);
    expect(request).toHaveBeenLastCalledWith('mcpServerStatus/list', expect.objectContaining({ cursor: 'two', threadId: 'thread' }), 10_000);
  });
  it('never starts an agent for a status read or reload without an existing runtime', async () => {
    const start = vi.fn();
    const adapter = new CodexBackendAdapter(start);
    const profile = { id: 'local', backendId: 'codex', name: 'Codex', config: {} } as NativeBackendProfileConfig;
    const host = {} as NativeBackendHost;
    const project = { id: 'p', cwd: '/tmp' } as Project;
    expect((await adapter.extensions.runtime!(host, project, profile)).entries).toEqual([]);
    expect(await adapter.extensions.reload!(host, project, profile)).toBe(0);
    expect(start).not.toHaveBeenCalled();
  });
  it.each([
    { flavor: codexFlavor, project: undefined, config: { configDir: '/tmp/read-codex', apiEndpoint: 'https://gateway.example', apiKey: 'profile-private-value' }, homeKey: 'CODEX_HOME' },
    { flavor: traexFlavor, project: { id: 'p', cwd: '/tmp/read-workspace' } as Project, config: { configDir: '/tmp/read-trae' }, homeKey: 'TRAE_HOME' },
  ])('reads $flavor.id native skill states without creating a conversation', async ({ flavor, project, config, homeKey }) => {
    const request = vi.fn().mockResolvedValue({ data: [
      { skills: [{ path: '/native/skill/../skill/SKILL.md', enabled: false }, { path: '/native/enabled/SKILL.md', enabled: true }, { path: '/native/unknown/SKILL.md' }, { path: '/native/malformed/SKILL.md', enabled: 'false' }, null] },
      { skills: [{ path: '', enabled: true }, { enabled: true }] }, null,
    ] });
    const dispose = vi.fn();
    const start = vi.fn().mockResolvedValue({ request, dispose });
    const adapter = new CodexBackendAdapter(start, flavor);
    expect(await adapter.extensions.skillStates!({} as NativeBackendHost, project, { id: 'read', backendId: flavor.id, name: 'Read', config })).toEqual([
      { path: '/native/skill/../skill/SKILL.md', enabled: false }, { path: '/native/enabled/SKILL.md', enabled: true },
    ]);
    expect(request).toHaveBeenCalledExactlyOnceWith('skills/list', { cwds: [project?.cwd ?? homedir()], forceReload: true }, 15_000);
    expect(dispose).toHaveBeenCalledOnce();
    const spec = start.mock.calls[0]![0];
    // A projectless management read runs in its own query directory, never the home directory.
    if (project) expect(spec.cwd).toBe(project.cwd); else expect(spec.cwd).toMatch(/[\\/]riffet[\\/]queries[\\/][0-9a-f]{24}$/);
    expect(spec.args).toEqual([]);
    expect(spec.env[homeKey]).toBe(config.configDir);
    expect(JSON.stringify(spec)).not.toContain('profile-private-value');
    expect(JSON.stringify(spec)).not.toContain('https://gateway.example');
    await expect(spec.onServerRequest({ id: 1, method: 'requestApproval', params: {} })).rejects.toThrow('interactive authorization');
  });
  it('closes the skill state management connection when native listing fails', async () => {
    const dispose = vi.fn();
    const request = vi.fn().mockRejectedValue(new Error('unsupported skills/list'));
    const adapter = new CodexBackendAdapter(vi.fn().mockResolvedValue({ request, dispose }));
    await expect(adapter.extensions.skillStates!({} as NativeBackendHost, undefined, { id: 'local', backendId: 'codex', name: 'Codex', config: {} })).rejects.toThrow('unsupported skills/list');
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('uses only the skill config RPC and closes the management connection on failure', async () => {
    const request = vi.fn().mockRejectedValue(new Error('unsupported'));
    const dispose = vi.fn();
    const start = vi.fn().mockResolvedValue({ request, dispose });
    const adapter = new CodexBackendAdapter(start);
    await expect(adapter.extensions.setSkillEnabled!({} as NativeBackendHost, undefined, { id: 'local', backendId: 'codex', name: 'Codex', config: {} }, '/tmp/skill/SKILL.md', false)).rejects.toThrow('unsupported');
    expect(request).toHaveBeenCalledExactlyOnceWith('skills/config/write', { path: '/tmp/skill/SKILL.md', enabled: false }, 15_000);
    expect(dispose).toHaveBeenCalledOnce();
    expect(start.mock.calls[0]![0].args).not.toContain('--dangerously-bypass-hook-trust');
  });
  it('does not inject a model gateway credential into skill management', async () => {
    const start = vi.fn().mockResolvedValue({ request: vi.fn(), dispose: vi.fn() });
    const adapter = new CodexBackendAdapter(start);
    await adapter.extensions.setSkillEnabled!({} as NativeBackendHost, undefined, { id: 'work', backendId: 'codex', name: 'Work', config: { configDir: '/tmp/work-codex', apiEndpoint: 'https://gateway.example', apiKey: 'profile-private-value' } }, '/tmp/work-codex/skills/a/SKILL.md', true);
    const spec = start.mock.calls[0]![0];
    expect(spec.env.CODEX_HOME).toBe('/tmp/work-codex');
    expect(JSON.stringify(spec)).not.toContain('profile-private-value');
    expect(spec.args).toEqual([]);
  });
});
