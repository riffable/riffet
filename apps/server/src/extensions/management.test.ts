import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import type { NativeBackendDriver, NativeBackendHost } from '../backends/types.js';
import type { ExtensionContext } from './types.js';
import { ExtensionManagement, extensionCommand, pluginActionArgs, validateExtensionTarget } from './management.js';

describe('extension management boundaries', () => {
  it('never widens a project operation into a user operation', () => {
    expect(() => pluginActionArgs('codex', 'install', 'tools@team', 'project', 'Usage: plugin add')).toThrow('project-level');
    expect(pluginActionArgs('claude', 'install', 'tools@team', 'project', '  --scope <scope>')).toEqual(['plugin', 'install', '--scope', 'project', 'tools@team']);
    expect(() => pluginActionArgs('droid', 'enable', 'tools@team', 'user', '')).toThrow();
  });
  it('rejects paths, option injection and shell payloads', () => {
    for (const value of ['--scope', '../private', '/tmp/plugin', 'relative/plugin', 'foo;echo secret', 'foo\nbar', 'file:///secret', '$(touch x)']) expect(() => validateExtensionTarget(value)).toThrow();
    expect(validateExtensionTarget('@org/tools@team')).toBe('@org/tools@team');
  });
  it('protects managed resources before running a command', async () => {
    const run = vi.fn();
    const management = new ExtensionManagement(run);
    const context: ExtensionContext = { backendId: 'claude', profile: { id: 'local', backendId: 'claude', name: 'Claude', config: {} } };
    await expect(management.apply(context, {} as NativeBackendDriver, {} as NativeBackendHost, { action: 'uninstall', itemId: 'one' }, { id: 'one', kind: 'plugin', name: 'one', scope: 'managed', runtimeState: 'unknown' })).rejects.toThrow('managed configuration');
    expect(run).not.toHaveBeenCalled();
  });
  it('keeps native capabilities available when the optional plugin CLI is missing', async () => {
    const run = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const context: ExtensionContext = { backendId: 'codex', profile: { id: 'local', backendId: 'codex', name: 'Codex', config: {} } };
    const caps = await new ExtensionManagement(run).capabilities(context, { extensions: { setSkillEnabled: vi.fn(), reload: vi.fn() } } as unknown as NativeBackendDriver);
    expect(caps.kinds.skill).toEqual(['enable', 'disable']);
    expect(caps.actions).toEqual(['reload']);
    expect(caps.reason).toBeTruthy();
  });
  it('does not advertise undocumented commands or use a shell to install', async () => {
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', stdoutData: Buffer.from(stdout), stderrData: Buffer.alloc(0), timedOut: false, truncated: false });
    const run = vi.fn().mockResolvedValueOnce(ok('Commands:\n  install|i <plugin>\n  uninstall|remove <plugin>\n')).mockResolvedValueOnce(ok('Options:\n  --scope <scope>')).mockResolvedValueOnce(ok('Options:\n  --scope <scope>')).mockResolvedValueOnce(ok('done'));
    const management = new ExtensionManagement(run);
    const context: ExtensionContext = { backendId: 'droid', profile: { id: 'local', backendId: 'droid', name: 'Droid', config: { executable: '/usr/bin/droid' } } };
    const caps = await management.capabilities(context, {} as NativeBackendDriver);
    expect(caps.kinds.plugin).toEqual(['install', 'uninstall']);
    expect(caps.installScopes).toEqual(['user', 'project']);
    const result = await management.apply(context, {} as NativeBackendDriver, {} as NativeBackendHost, { action: 'install', target: 'tools@team', scope: 'user' });
    expect(result.success).toBe(true);
    expect(run.mock.calls[3]?.[1]).toEqual(['plugin', 'install', '--scope', 'user', 'tools@team']);
  });
  it('keeps pi package management unsupported and maps its agent directory', async () => {
    const run = vi.fn();
    const context: ExtensionContext = { backendId: 'pi', profile: { id: 'local', backendId: 'pi', name: 'pi', config: { executable: '/usr/bin/pi', configDir: '~/pi-agent' } } };
    const spec = extensionCommand(context, ['--version']);
    expect(spec.command).toBe('/usr/bin/pi');
    expect(spec.env.PI_CODING_AGENT_DIR).toBe(path.resolve(os.homedir(), 'pi-agent'));
    const management = new ExtensionManagement(run);
    const caps = await management.capabilities(context, {} as NativeBackendDriver);
    expect(caps.kinds.plugin).toBeUndefined();
    expect(caps.reason).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
    await expect(management.apply(context, {} as NativeBackendDriver, {} as NativeBackendHost, { action: 'install', target: 'pkg@market' })).rejects.toMatchObject({ code: 'EXTENSION_ACTION_UNSUPPORTED' });
    expect(run).not.toHaveBeenCalled();
  });
  it('uses installed JSON identities and keeps required or unknown-policy plugins read-only', async () => {
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', stdoutData: Buffer.from(stdout), stderrData: Buffer.alloc(0), timedOut: false, truncated: false });
    const run = vi.fn().mockResolvedValueOnce(ok('  --json')).mockResolvedValueOnce(ok(JSON.stringify({ installed: [
      { pluginId: 'tools@team', installed: true, enabled: false, installPolicy: 'AVAILABLE' },
      { pluginId: 'base@team', installed: true, enabled: true, installPolicy: 'REQUIRED' },
      { pluginId: 'uninstalled@team', installed: false, installPolicy: 'AVAILABLE' },
      { pluginId: 'unknown@team', installed: true },
    ] })));
    const context: ExtensionContext = { backendId: 'codex', profile: { id: 'local', backendId: 'codex', name: 'Codex', config: {} } };
    const management = new ExtensionManagement(run);
    const listing = await management.installedPlugins(context);
    expect(listing.items.map(item => [item.nativeId, item.scope, item.enabled])).toEqual([
      ['tools@team', 'user', false], ['base@team', 'managed', true], ['unknown@team', 'managed', undefined],
    ]);
    expect((await management.installedPlugins(context)).items).toEqual(listing.items);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[1]).toEqual(['plugin', 'list', '--json']);
  });
  it('coalesces native state reads and invalidates them after management', async () => {
    const skillStates = vi.fn().mockResolvedValue([{ path: '/profile/skills/a/SKILL.md', enabled: true }]);
    const setSkillEnabled = vi.fn().mockResolvedValue(undefined);
    const driver = { extensions: { skillStates, setSkillEnabled } } as unknown as NativeBackendDriver;
    const context: ExtensionContext = { backendId: 'codex', profile: { id: 'local', backendId: 'codex', name: 'Codex', config: {} } };
    const management = new ExtensionManagement(vi.fn());
    await Promise.all([management.skillStates(context, driver, {} as NativeBackendHost), management.skillStates(context, driver, {} as NativeBackendHost)]);
    expect(skillStates).toHaveBeenCalledOnce();
    await management.apply(context, driver, {} as NativeBackendHost, { action: 'disable', itemId: 'plugin-skill' }, {
      id: 'plugin-skill', name: 'a', kind: 'skill', scope: 'managed', ownerPluginId: 'plugin', sourcePath: '/profile/skills/a/SKILL.md', runtimeState: 'unknown', actions: ['enable', 'disable'],
    });
    expect(setSkillEnabled).toHaveBeenCalledWith(expect.anything(), undefined, context.profile, '/profile/skills/a/SKILL.md', false);
    await management.skillStates(context, driver, {} as NativeBackendHost);
    expect(skillStates).toHaveBeenCalledTimes(2);
  });
});
