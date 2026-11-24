import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agyProfileEnvironment, agySelection, parseAgyProfile, prepareAgySession } from './config.js';
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
describe('Antigravity private launch configuration', () => {
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
  it('snapshots customization privately and preserves native edits on resume', async () => {
    const f = await fixture();
    await f.put('AGENTS.md', 'global rule');
    await f.put('config/skills/example/SKILL.md', 'skill');
    await f.put('config/plugins/example/plugin.json', { name: 'example', skills: ['skills'] });
    await f.put('config/plugins/example/skills/local/SKILL.md', 'plugin skill');
    await f.put('config/skills.json', { entries: [{ path: join(f.source, 'config', 'skills') }] });
    await f.put('config/mcp_config.json', { mcpServers: { fixture: { command: 'node', env: { KEY: 'user-mcp-secret' } } } });
    await f.put('antigravity-cli/settings.json', {
      colorScheme: 'dark',
      toolPermission: 'strict',
      trustedWorkspaces: [],
      apiKey: 'native-secret',
    });
    await f.put('antigravity-cli/cache/onboarding.json', {
      consumerOnboardingComplete: true,
      enterpriseOnboardingComplete: false,
      onboardingComplete: true,
      token: 'oauth-secret',
    });
    await f.put('oauth_creds.json', 'oauth-secret');
    await f.put('config/skills/example/.env', 'secret file');
    const original = await readFile(join(f.source, 'antigravity-cli/settings.json'), 'utf8');
    const first = await prepareAgySession({ ...f.input(), mode: 'plan', approval: 'allowlist' });
    expect(await readFile(join(first.geminiDir, 'AGENTS.md'), 'utf8')).toBe('global rule');
    expect(await readdir(first.geminiDir)).not.toContain('oauth_creds.json');
    expect(await readdir(join(first.geminiDir, 'config', 'skills', 'example'))).not.toContain('.env');
    expect(JSON.parse(await readFile(join(first.geminiDir, 'config', 'skills.json'), 'utf8')).entries[0].path).toBe(
      join(first.geminiDir, 'config', 'skills'),
    );
    const overlay = JSON.parse(await readFile(first.settingsPath, 'utf8'));
    expect(overlay).toMatchObject({
      colorScheme: 'dark',
      toolPermission: 'request-review',
      agentMode: 'plan',
      queuedMessages: 'queue',
      altScreenMode: 'always',
    });
    expect(overlay.trustedWorkspaces).toEqual(expect.arrayContaining([await realpath(f.project)]));
    expect(overlay).not.toHaveProperty('apiKey');
    expect(overlay).not.toHaveProperty('modelProvider');
    expect(JSON.parse(await readFile(join(first.geminiDir, 'antigravity-cli', 'cache', 'onboarding.json'), 'utf8'))).toEqual({
      consumerOnboardingComplete: true,
      onboardingComplete: true,
    });
    expect((await stat(first.geminiDir)).mode & 0o777).toBe(0o700);
    expect((await stat(first.settingsPath)).mode & 0o777).toBe(0o600);
    await writeFile(
      join(first.geminiDir, 'antigravity-cli', 'settings.json'),
      JSON.stringify({
        colorScheme: 'light',
        model: 'Native edited model',
        toolPermission: 'strict',
        customModelsConfig: { customModels: { mine: { modelName: 'mine' } } },
      }),
    );
    await f.put('AGENTS.md', 'changed donor');
    const second = await prepareAgySession({ ...f.input(), customModel: 'gateway-model' });
    expect(second.geminiDir).toBe(first.geminiDir);
    expect(second.bridgeDir).toBe(first.bridgeDir);
    expect(second.settingsPath).not.toBe(first.settingsPath);
    expect(JSON.parse(await readFile(second.settingsPath, 'utf8'))).toMatchObject({
      colorScheme: 'light',
      model: 'Native edited model',
      toolPermission: 'strict',
      customModelsConfig: { customModels: { mine: { modelName: 'mine' }, 'gateway-model': { modelName: 'gateway-model' } } },
    });
    expect(JSON.parse(await readFile(join(second.geminiDir, 'antigravity-cli', 'settings.json'), 'utf8')).customModelsConfig.customModels).not.toHaveProperty(
      'gateway-model',
    );
    expect(await readFile(join(second.geminiDir, 'AGENTS.md'), 'utf8')).toBe('global rule');
    expect(await readFile(join(f.source, 'antigravity-cli', 'settings.json'), 'utf8')).toBe(original);
    expect(process.env.HOME).toBeTruthy();
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
        enableTerminalSandbox: approval !== 'request-review',
        permissions: { ask: ['command(git push)'] },
      });
    }
  });
  it('refuses linked state, linked customizations and external discovery references', async () => {
    const f = await fixture();
    await f.put('config/rules/rule.md', 'rule');
    await symlink(join(f.source, 'config', 'rules', 'rule.md'), join(f.source, 'config', 'rules', 'linked.md'));
    await expect(prepareAgySession(f.input())).rejects.toThrow('symbolic link');
    await rm(join(f.source, 'config', 'rules', 'linked.md'));
    await f.put('config/skills.json', { entries: [{ path: '/external/team/skills' }] });
    await expect(prepareAgySession(f.input())).rejects.toThrow('unsupported customization');
    await rm(join(f.source, 'config', 'skills.json'));
    const sessionParent = join(f.root, 'state', 'sessions');
    await rm(sessionParent, { recursive: true });
    await symlink(f.project, sessionParent);
    await expect(prepareAgySession(f.input())).rejects.toThrow('unsafe');
  });
  it('does not fabricate onboarding and binds private roots to the original workspace', async () => {
    const f = await fixture();
    const prepared = await prepareAgySession(f.input());
    await expect(stat(join(prepared.geminiDir, 'antigravity-cli', 'cache', 'onboarding.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const other = join(f.root, 'other');
    await mkdir(other);
    await expect(prepareAgySession({ ...f.input(), projectCwd: other })).rejects.toThrow('another');
    await expect(prepareAgySession({ ...f.input(), sessionId: '../escape' })).rejects.toThrow('identity');
    await expect(prepareAgySession({ ...f.input(), stateDir: join(f.project, 'state') })).rejects.toThrow('outside');
  });
});
