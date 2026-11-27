import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agyProfileEnvironment, agySelection, agySessionGeminiDir, agyToolPermission, parseAgyProfile, prepareAgySession } from './config.js';
import { agyLaunchModel, parseAgyModels } from './models.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'riffet-agy-config-'));
  roots.push(root);
  const source = join(root, 'source');
  const project = join(root, 'project');
  await mkdir(source);
  await mkdir(project);
  const put = async (name: string, value: unknown) => {
    const path = join(source, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  return {
    root,
    source,
    project,
    put,
    input: () => ({
      stateDir: join(root, 'state'),
      projectCwd: project,
      sessionId: 'session-1',
      profile: parseAgyProfile({ sourceDir: source }),
    }),
  };
}
describe('Antigravity launch configuration', () => {
  it('keeps profile credentials out of serialization and rejects ambiguous provider settings', () => {
    const profile = parseAgyProfile({
      apiEndpoint: 'http://127.0.0.1:18080/prefix/',
      apiProtocol: 'google-generative-ai',
      apiKey: 'fixture-private-key',
    });
    expect(JSON.stringify(profile)).not.toContain('fixture-private-key');
    expect(profile.apiEndpoint).toBe('http://127.0.0.1:18080/prefix');
    expect(agyProfileEnvironment(profile)).toEqual({
      env: { GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:18080/prefix', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
      secretEnv: { GEMINI_API_KEY: 'fixture-private-key' },
    });
    expect(agyProfileEnvironment(parseAgyProfile({ disableAutoUpdate: false }))).toEqual({ env: {}, secretEnv: {} });
    for (const config of [
      { apiProtocol: 'openai' },
      { apiEndpoint: 'http://127.0.0.1:18080' },
      { apiKey: 'a\nb' },
      { apiEndpoint: 'https://u:p@host', apiKey: 'key' },
      { apiEndpoint: 'https://host?key=secret', apiKey: 'key' },
      { sourceDir: '../native' },
    ])
      expect(() => parseAgyProfile(config)).toThrow();
    expect(() => agySelection('custom[effort=extreme]')).toThrow();
    expect(() => agySelection('custom[speed=fast]')).toThrow();
  });
  it('starts agy on the selected model: a built-in variant, or a gateway id registered as a custom model', () => {
    const native = parseAgyModels(
      'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n',
    );
    const key = { hasApiKey: true };
    // agy refuses --effort next to a variant id, so the effort picks the variant.
    expect(agyLaunchModel(agySelection('gemini-3.8-flash-high[effort=medium]'), native, key)).toEqual({
      model: 'gemini-3.8-flash-medium',
      labels: ['Gemini 3.8 Flash (Medium)'],
    });
    // An id agy does not know would make it fall back to its default model; xhigh is refused for custom models.
    expect(agyLaunchModel(agySelection('gemini-4-hydrogen-sonar[effort=high]'), native, key)).toEqual({
      model: 'gemini-4-hydrogen-sonar',
      effort: 'high',
      custom: 'gemini-4-hydrogen-sonar',
      labels: ['gemini-4-hydrogen-sonar'],
    });
    expect(agyLaunchModel(agySelection('gemini-4-hydrogen-sonar[effort=xhigh]'), native, key).effort).toBeUndefined();
    expect(agyLaunchModel(agySelection('gemini-4-hydrogen-sonar'), native, { hasApiKey: false }).custom).toBeUndefined();
  });
  it('runs new sessions on the provider data root without writing the user settings', async () => {
    const f = await fixture();
    await f.put('antigravity-cli/settings.json', {
      colorScheme: 'dark',
      model: 'Saved model',
      trustedWorkspaces: ['/elsewhere'],
      customModelsConfig: { customModels: { mine: { modelName: 'mine' } } },
    });
    const original = await readFile(join(f.source, 'antigravity-cli/settings.json'), 'utf8');
    const first = await prepareAgySession({ ...f.input(), mode: 'plan', approval: 'allowlist', customModel: 'gateway-model' });
    expect(first.geminiDir).toBe(f.source);
    expect(first.trustAdded).toBe(true);
    const overlay = JSON.parse(await readFile(first.settingsPath, 'utf8'));
    // Only Riffet's own choices: everything else, including a model saved by /model, stays agy's to read.
    expect(overlay).toEqual({
      trustedWorkspaces: ['/elsewhere', f.project, await realpath(f.project)],
      customModelsConfig: { customModels: { mine: { modelName: 'mine' }, 'gateway-model': { modelName: 'gateway-model' } } },
      queuedMessages: 'queue',
      altScreenMode: 'always',
      agentMode: 'plan',
      toolPermission: 'request-review',
    });
    expect((await stat(first.settingsPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(f.source, 'antigravity-cli', 'settings.json'), 'utf8')).toBe(original);
    await expect(stat(join(first.root, 'native'))).rejects.toMatchObject({ code: 'ENOENT' });
    const second = await prepareAgySession(f.input());
    expect(second.geminiDir).toBe(f.source);
    expect(second.bridgeDir).toBe(first.bridgeDir);
    expect(second.settingsPath).not.toBe(first.settingsPath);
    expect(agySessionGeminiDir(f.input().stateDir, 'session-1')).toBe(f.source);
  });
  it('resumes a session started before native history on its private root', async () => {
    const f = await fixture();
    const state = join(f.root, 'state');
    const root = join(state, 'sessions', 'session-1');
    await mkdir(join(root, 'native', 'antigravity-cli'), { recursive: true });
    await writeFile(join(root, 'initialized.json'), JSON.stringify({ version: 1, projectCwd: await realpath(f.project), sourceDir: f.source }));
    await writeFile(join(root, 'native', 'antigravity-cli', 'settings.json'), JSON.stringify({ colorScheme: 'light', model: 'Private model' }));
    const prepared = await prepareAgySession(f.input());
    expect(prepared.geminiDir).toBe(join(await realpath(state), 'sessions', 'session-1', 'native'));
    expect(JSON.parse(await readFile(prepared.settingsPath, 'utf8'))).toMatchObject({ colorScheme: 'light', model: 'Private model' });
    expect(JSON.parse(await readFile(join(prepared.geminiDir, 'antigravity-cli', 'settings.json'), 'utf8')).trustedWorkspaces).toContain(
      await realpath(f.project),
    );
    expect(agySessionGeminiDir(state, 'session-1')).toBe(join(state, 'sessions', 'session-1', 'native'));
  });
  it('enables the terminal sandbox for a Sandbox launch and restores the native setting on later launches', async () => {
    const f = await fixture();
    await f.put('antigravity-cli/settings.json', { enableTerminalSandbox: false, permissions: { ask: ['command(git push)'] } });
    for (const approval of ['proceed-in-sandbox', 'auto-review', 'request-review']) {
      const launch = await prepareAgySession({ ...f.input(), mode: 'agent', approval });
      const settings = JSON.parse(await readFile(launch.settingsPath, 'utf8'));
      expect(settings).toMatchObject({
        agentMode: '',
        toolPermission: approval === 'request-review' ? 'request-review' : 'proceed-in-sandbox',
      });
      expect(settings.enableTerminalSandbox).toBe(approval === 'request-review' ? undefined : true);
    }
  });
  it('refuses linked session state', async () => {
    const f = await fixture();
    const sessionParent = join(f.root, 'state', 'sessions');
    await mkdir(sessionParent, { recursive: true });
    await rm(sessionParent, { recursive: true });
    await symlink(f.project, sessionParent);
    await expect(prepareAgySession(f.input())).rejects.toThrow('unsafe');
  });
  it('binds session state to the original workspace', async () => {
    const f = await fixture();
    await prepareAgySession(f.input());
    const other = join(f.root, 'other');
    await mkdir(other);
    await expect(prepareAgySession({ ...f.input(), projectCwd: other })).rejects.toThrow('another');
    await expect(prepareAgySession({ ...f.input(), sessionId: '../escape' })).rejects.toThrow('identity');
    await expect(prepareAgySession({ ...f.input(), stateDir: join(f.project, 'state') })).rejects.toThrow('outside');
  });
  it('maps dontAsk approval, isolates standing geminiDirOverride, and prunes stale launches', async () => {
    expect(agyToolPermission('dontAsk')).toBe('always-proceed');
    const f = await fixture();
    await f.put('antigravity-cli/settings.json', {
      trustedWorkspaces: ['/owner-only'],
      statusLine: { command: 'echo owner' },
      useG1Credits: true,
    });
    const standingDir = join(f.root, 'standing-member');
    await mkdir(join(standingDir, 'antigravity-cli'), { recursive: true });
    const prepared = await prepareAgySession({
      ...f.input(),
      geminiDirOverride: standingDir,
      approval: 'dontAsk',
    });
    expect(prepared.geminiDir).toBe(await realpath(standingDir));
    const settings = JSON.parse(await readFile(prepared.settingsPath, 'utf8'));
    expect(settings.toolPermission).toBe('always-proceed');
    expect(settings.trustedWorkspaces).not.toContain('/owner-only');
    expect(settings.statusLine).toBeUndefined();
    expect(settings.useG1Credits).toBe(true);
    expect(agySessionGeminiDir(f.input().stateDir, 'session-1')).toBe(await realpath(standingDir));

    // Create 10 launches in sequence and verify stale launch dirs are pruned to 8.
    for (let i = 0; i < 10; i++) {
      await prepareAgySession({ ...f.input(), geminiDirOverride: standingDir });
    }
    const launches = await readdir(join(prepared.root, 'launches'));
    expect(launches.length).toBeLessThanOrEqual(8);
  });
});
