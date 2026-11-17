import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Project } from '../../../../packages/contracts/src/index.js';
import type { NativeBackendProfileConfig } from '../backends/types.js';
import type { AgentExtensionLayout } from '@riffet/plugin-api/experimental/agent';
import { ExtensionService } from './service.js';
import type { ExtensionContext } from './types.js';

const roots: string[] = [];
let tempRoot: string;

/** What a provider hands the service as its layout (the Cursor plugin's, in the parts these tests read); the service itself knows no Agent's directories. */
const SKILLS = ['.cursor/skills', '.agents/skills', '.claude/skills', '.codex/skills'];
const CURSOR_EXTENSION_LAYOUT: AgentExtensionLayout = {
  userRoot: (_config, configDir) => configDir ?? path.join(os.homedir(), '.cursor'),
  applyEffect: 'Cursor may need a reload or a new session to apply this change.',
  configFiles: {
    user: [{ relative: 'mcp.json', kind: 'mcp' }, { relative: 'hooks.json', kind: 'hook' }, { relative: 'hooks/hooks.json', kind: 'hook' }, { relative: 'cli.json', kind: 'config' }, { relative: 'cli-config.json', kind: 'config' }],
    project: [{ relative: '.cursor/mcp.json', kind: 'mcp' }, { relative: '.cursor/hooks.json', kind: 'hook' }, { relative: '.cursor/hooks/hooks.json', kind: 'hook' }, { relative: '.cursor/cli.json', kind: 'config' }],
  },
  directories: {
    user: { skill: [], rule: ['rules'], command: [], plugin: ['plugins'] },
    project: { skill: SKILLS, rule: ['.cursor/rules'], command: ['.cursor/commands'], plugin: ['.cursor/plugins'] },
  },
  ruleFiles: { user: [], project: ['.cursorrules'] },
  create: {
    user: [{ id: 'mcp', label: 'MCP configuration', kind: 'mcp', directory: '', fileName: 'mcp.json' }, { id: 'hook', label: 'Hook configuration', kind: 'hook', directory: '', fileName: 'hooks.json', template: '{\n  "version": 1,\n  "hooks": {}\n}\n' }],
    project: [
      { id: 'skill', label: 'Skill', kind: 'skill', directory: '.agents/skills' }, { id: 'rule', label: 'Rule', kind: 'rule', directory: '.cursor/rules' },
      { id: 'command', label: 'Command', kind: 'command', directory: '.cursor/commands' }, { id: 'mcp', label: 'MCP configuration', kind: 'mcp', directory: '.cursor', fileName: 'mcp.json' },
      { id: 'hook', label: 'Hook configuration', kind: 'hook', directory: '.cursor', fileName: 'hooks.json', template: '{\n  "version": 1,\n  "hooks": {}\n}\n' },
    ],
  },
  sharedRoot: {
    directories: { skill: SKILLS, command: ['.cursor/commands'] },
    create: [{ id: 'skill', label: 'Skill', kind: 'skill', directory: '.cursor/skills' }, { id: 'command', label: 'Command', kind: 'command', directory: '.cursor/commands' }],
  },
  skillsAlwaysEnabled: true,
};

async function makeRoot(label = 'fixture'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `riffet-extension-${label}-`));
  roots.push(root);
  return root;
}

function makeProject(root: string): Project {
  const now = new Date().toISOString();
  return { id: 'project-test', name: 'Extension test', cwd: root, createdAt: now, updatedAt: now };
}

function makeContext(backendId: ExtensionContext['backendId'], userDir: string, project?: Project): ExtensionContext {
  const profile: NativeBackendProfileConfig = {
    id: 'profile-test', backendId, name: 'Test profile', config: { configDir: userDir },
  };
  return { backendId, profile, ...(backendId === 'cursor' ? { layout: CURSOR_EXTENSION_LAYOUT } : {}), ...(project ? { project } : {}) };
}

async function put(root: string, relative: string, content: string): Promise<string> {
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
  return absolute;
}

describe('ExtensionService static discovery and documents', () => {
  beforeEach(async () => { tempRoot = await makeRoot(); });
  afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

  it('scans only the selected backend layout and keeps runtime state unknown', async () => {
    const user = path.join(tempRoot, 'claude-user');
    const projectRoot = path.join(tempRoot, 'project');
    await mkdir(user, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await put(projectRoot, '.claude/skills/review/SKILL.md', '---\nname: review\ndescription: Review changes\n---\nReview.\n');
    await put(projectRoot, '.mcp.json', JSON.stringify({ mcpServers: { docs: { command: 'docs-server', description: 'Project docs' } } }));
    await put(projectRoot, '.cursor/skills/ignore/SKILL.md', 'Cursor only\n');
    await put(projectRoot, '.cursor/mcp.json', JSON.stringify({ mcpServers: { cursorOnly: { command: 'cursor-server' } } }));
    await put(user, 'extensions/pi-only.ts', 'export default function () {}\n');

    const service = new ExtensionService(path.join(tempRoot, 'state'));
    const inventory = await service.list(makeContext('claude', user, makeProject(projectRoot)));
    expect(inventory.items.some(item => item.kind === 'skill' && item.name === 'review' && item.scope === 'project')).toBe(true);
    expect(inventory.items.some(item => item.kind === 'mcp' && item.nativeId === 'docs')).toBe(true);
    expect(inventory.items.some(item => item.kind === 'skill' && item.name === 'ignore')).toBe(false);
    expect(inventory.items.some(item => item.kind === 'mcp' && item.nativeId === 'cursorOnly')).toBe(false);
    expect(inventory.items.some(item => item.kind === 'plugin' && item.name === 'pi-only')).toBe(false);
    expect(inventory.items.every(item => item.runtimeState === 'unknown')).toBe(true);
  });

  it('lists Riffet skills read-only for the assistant project on Claude and Codex, and nowhere else', async () => {
    const user = path.join(tempRoot, 'claude-user');
    const projectRoot = path.join(tempRoot, 'assistant');
    await mkdir(path.join(user, 'skills', 'owner'), { recursive: true });
    await writeFile(path.join(user, 'skills', 'owner', 'SKILL.md'), '---\nname: owner\ndescription: The owner\'s own skill\n---\n');
    await mkdir(path.join(projectRoot, '.claude', 'skills', 'added'), { recursive: true });
    await writeFile(path.join(projectRoot, '.claude', 'skills', 'added', 'SKILL.md'), '---\nname: added\ndescription: Added for the assistant\n---\n');
    const service = new ExtensionService(path.join(tempRoot, 'state'));
    const assistant: Project = { ...makeProject(projectRoot), system: 'assistant' };
    const ctx = makeContext('claude', user, assistant);
    const items = (await service.list(ctx)).items.filter(item => item.scope === 'riffet');
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item).toMatchObject({ kind: 'skill', enabled: true, actions: [], readOnlyReason: 'Provided by Riffet. Updated with the server.' });
      expect(item.name.startsWith('riffet:')).toBe(true);
    }
    const document = await service.readDocument(ctx, items[0]!.documentId!);
    expect(document).toMatchObject({ editable: false, language: 'markdown' });
    expect(document.content.startsWith('---\n')).toBe(true);
    await expect(service.writeDocument(ctx, document.id, { content: 'x', expectedHash: document.hash })).rejects.toMatchObject({ code: 'EXTENSION_READ_ONLY' });
    // Its launch leaves the owner's configuration directory out, so only its own files and Riffet's are in effect.
    const listed = await service.list(ctx);
    expect(listed.items.filter(item => item.kind === 'skill' && item.scope !== 'riffet').map(item => [item.name, item.scope])).toEqual([['added', 'project']]);
    expect(listed.createTargets.every(target => target.scope === 'project')).toBe(true);
    const elsewhere = await service.list(makeContext('claude', user, makeProject(projectRoot)));
    // What it does not list it does not open either, by an id learnt elsewhere. (A second service: the two
    // contexts here share a project id, which a real project and the assistant's never do.)
    const owners = elsewhere.items.find(item => item.name === 'owner')!;
    const again = new ExtensionService(path.join(tempRoot, 'state'));
    await expect(again.readDocument(ctx, owners.documentId!)).rejects.toMatchObject({ code: 'EXTENSION_DOCUMENT_NOT_FOUND' });
    await expect(again.detail(ctx, owners.id)).rejects.toMatchObject({ code: 'EXTENSION_NOT_FOUND' });
    expect(elsewhere.items.some(item => item.scope === 'riffet')).toBe(false);
    expect(elsewhere.items.filter(item => item.kind === 'skill').map(item => item.name).sort()).toEqual(['added', 'owner']);
    expect((await service.list(makeContext('codex', user, assistant))).items.some(item => item.scope === 'riffet')).toBe(true);
    expect((await service.list(makeContext('cursor', user, assistant))).items.some(item => item.scope === 'riffet')).toBe(false);
  });

  it('discovers pi agent and project layouts without reading credentials', async () => {
    const user = path.join(tempRoot, 'pi-agent');
    const projectRoot = path.join(tempRoot, 'pi-project');
    await mkdir(user, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    const secret = 'pi-oauth-private-9931';
    await put(user, 'auth.json', JSON.stringify({ accessToken: secret }));
    await put(user, 'settings.json', JSON.stringify({ theme: 'dark' }));
    await put(user, 'mcp.json', JSON.stringify({ mcpServers: { docs: { command: 'docs-server' } } }));
    await put(user, 'skills/review/SKILL.md', '---\nname: review\n---\nUser review.\n');
    await put(user, 'prompts/plan.md', '# Plan\n');
    await put(user, 'extensions/hello.ts', 'export default function () {}\n');
    await put(user, 'extensions/pkg/package.json', JSON.stringify({ name: 'pkg', pi: { extensions: ['./entry.ts'] } }));
    await put(user, 'extensions/pkg/entry.ts', 'export default function () {}\n');
    await put(user, 'shared/linked.ts', 'export default function () {}\n');
    await symlink(path.join(user, 'shared/linked.ts'), path.join(user, 'extensions/linked.ts'));
    const outside = await put(tempRoot, 'outside.ts', 'export default function () {}\n');
    await symlink(outside, path.join(user, 'extensions/outside.ts'));
    await put(user, 'AGENTS.md', 'User instructions\n');
    await put(user, 'SYSTEM.md', 'User system prompt\n');
    await put(projectRoot, '.pi/settings.json', JSON.stringify({}));
    await put(projectRoot, '.pi/mcp.json', JSON.stringify({ mcpServers: { projectDocs: { command: 'project-docs' } } }));
    await put(projectRoot, '.pi/skills/review/SKILL.md', '---\nname: review\n---\nProject review.\n');
    await put(projectRoot, '.pi/prompts/deploy.md', '# Deploy\n');
    await put(projectRoot, '.pi/extensions/project.ts', 'export default function () {}\n');
    await put(projectRoot, '.agents/skills/shared/SKILL.md', '---\nname: shared\n---\nShared skill.\n');
    await put(projectRoot, 'AGENTS.md', 'Project instructions\n');
    await put(projectRoot, '.pi/SYSTEM.md', 'Project system prompt\n');

    const inventory = await new ExtensionService(path.join(tempRoot, 'state')).list(makeContext('pi', user, makeProject(projectRoot)));
    expect(inventory.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'skill', name: 'review', scope: 'user' }),
      expect.objectContaining({ kind: 'skill', name: 'review', scope: 'project' }),
      expect.objectContaining({ kind: 'skill', name: 'shared', scope: 'project' }),
      expect.objectContaining({ kind: 'command', name: 'plan', scope: 'user' }),
      expect.objectContaining({ kind: 'command', name: 'deploy', scope: 'project' }),
      expect.objectContaining({ kind: 'plugin', name: 'hello', scope: 'user' }),
      expect.objectContaining({ kind: 'plugin', name: 'pkg', scope: 'user' }),
      expect.objectContaining({ kind: 'plugin', name: 'linked', scope: 'managed' }),
      expect.objectContaining({ kind: 'plugin', name: 'project', scope: 'project' }),
      expect.objectContaining({ kind: 'rule', name: 'AGENTS.md', scope: 'user' }),
      expect.objectContaining({ kind: 'rule', name: 'SYSTEM.md', scope: 'user' }),
      expect.objectContaining({ kind: 'rule', name: 'AGENTS.md', scope: 'project' }),
      expect.objectContaining({ kind: 'rule', name: 'SYSTEM.md', scope: 'project' }),
      expect.objectContaining({ kind: 'mcp', nativeId: 'docs', scope: 'user' }),
      expect.objectContaining({ kind: 'mcp', nativeId: 'projectDocs', scope: 'project' }),
    ]));
    expect(inventory.items.every(item => item.runtimeState === 'unknown')).toBe(true);
    expect(inventory.items.find(item => item.kind === 'plugin' && item.name === 'linked')?.readOnlyReason).toBeTruthy();
    expect(inventory.items.some(item => item.kind === 'plugin' && item.name === 'outside')).toBe(false);
    expect(inventory.diagnostics.some(message => message.includes('outside.ts'))).toBe(true);
    expect(inventory.items.some(item => item.name === 'auth.json')).toBe(false);
    expect(JSON.stringify(inventory)).not.toContain(secret);
  });

  it('maps runtime paths only through documents discovered in the selected profile and project', async () => {
    const user = path.join(tempRoot, 'runtime-user');
    const projectRoot = path.join(tempRoot, 'runtime-project');
    const other = path.join(tempRoot, 'other-profile');
    const userPath = await put(user, 'skills/review/SKILL.md', '---\nname: review\n---\nUser skill.\n');
    const projectPath = await put(projectRoot, '.claude/skills/review/SKILL.md', '---\nname: review\n---\nProject skill.\n');
    const otherPath = await put(other, 'skills/review/SKILL.md', '---\nname: review\n---\nOther profile.\n');
    const ctx = makeContext('claude', user, makeProject(projectRoot));
    const service = new ExtensionService(path.join(tempRoot, 'state'));
    const inventory = await service.list(ctx);
    const report = await service.normalizeRuntimeReport(ctx, {
      entries: [userPath, projectPath, otherPath].map(sourcePath => ({ sessionId: 'session', kind: 'skill', name: 'review', sourcePath, state: 'unknown' })),
      diagnostics: [], checkedAt: '2026-10-18T00:00:00.000Z',
    });
    expect(report.entries.map(entry => entry.sourcePath)).toEqual([
      inventory.items.find(item => item.kind === 'skill' && item.scope === 'user')!.sourcePath,
      inventory.items.find(item => item.kind === 'skill' && item.scope === 'project')!.sourcePath,
      otherPath,
    ]);
    expect(report.entries.every(entry => entry.state === 'unknown')).toBe(true);
    const otherReport = await service.normalizeRuntimeReport(makeContext('claude', other), { ...report, entries: [{ sessionId: 'session', kind: 'skill', name: 'review', sourcePath: userPath, state: 'unknown' }] });
    expect(otherReport.entries[0].sourcePath).toBe(userPath);
  });

  it('creates a project skill under the selected target and rejects traversal', async () => {
    const user = path.join(tempRoot, 'cursor-user');
    const projectRoot = path.join(tempRoot, 'project');
    await mkdir(user, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    const service = new ExtensionService(path.join(tempRoot, 'state'));
    const ctx = makeContext('cursor', user, makeProject(projectRoot));
    const inventory = await service.list(ctx);
    const target = inventory.createTargets.find(item => item.id === 'project:skill');
    expect(target?.directory).toBe('.agents/skills');
    expect(JSON.parse(inventory.createTargets.find(item => item.id === 'project:hook')!.template!)).toEqual({ version: 1, hooks: {} });
    const document = await service.createDocument(ctx, {
      targetId: target!.id,
      path: '.agents/skills/my-skill/SKILL.md',
      content: '---\nname: my-skill\n---\nDo the work.\n',
    });
    expect(document.editable).toBe(true);
    expect(await readFile(path.join(projectRoot, '.agents/skills/my-skill/SKILL.md'), 'utf8')).toContain('Do the work');
    await expect(service.createDocument(ctx, {
      targetId: target!.id,
      path: '.agents/skills/../escaped/SKILL.md',
      content: 'unsafe',
    })).rejects.toMatchObject({ code: 'INVALID_EXTENSION_PATH' });
    await expect(readFile(path.join(projectRoot, 'escaped/SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects stale item identities when the same profile switches configuration roots', async () => {
    const originalRoot = path.join(tempRoot, 'original-profile');
    const replacementRoot = path.join(tempRoot, 'replacement-profile');
    const content = '---\nname: same\n---\nSame content.\n';
    await put(originalRoot, 'skills/same/SKILL.md', content);
    const replacementPath = await put(replacementRoot, 'skills/same/SKILL.md', content);
    const originalCtx = makeContext('traex', originalRoot);
    const replacementCtx = makeContext('traex', replacementRoot);
    const service = new ExtensionService(path.join(tempRoot, 'state'));
    const original = (await service.list(originalCtx)).items.find(item => item.kind === 'skill')!;
    const replacement = (await service.list(replacementCtx)).items.find(item => item.kind === 'skill')!;
    // Both roots use the same public "profile/..." path, but they are different resources.
    expect(original.sourcePath).toBe(replacement.sourcePath);
    expect(original.id).not.toBe(replacement.id);
    const document = await service.readDocument(originalCtx, original.documentId!);
    await expect(service.manageSkillFiles(replacementCtx, { action: 'uninstall', itemId: original.id, expectedHash: document.hash }, false)).rejects.toMatchObject({ code: 'EXTENSION_NOT_FOUND' });
    expect(await readFile(replacementPath, 'utf8')).toBe(content);
  });

  it('allows native toggles for discovered plugin skills without granting file deletion or builtin access', async () => {
    const user = path.join(tempRoot, 'native-state-user');
    const own = await put(user, 'skills/own/SKILL.md', '---\nname: own\n---\nOwn.');
    const builtin = await put(user, 'skills/.system/base/SKILL.md', '---\nname: base\n---\nBuiltin.');
    await put(user, 'plugins/cache/team/tool/.codex-plugin/plugin.json', '{"name":"tool"}');
    const plugin = await put(user, 'plugins/cache/team/tool/skills/nested/SKILL.md', '---\nname: nested\n---\nPlugin.');
    const ctx = makeContext('codex', user);
    const service = new ExtensionService(path.join(tempRoot, 'state'));
    const inventory = await service.list(ctx);
    const items = await service.applySkillStates(ctx, inventory.items, [{ path: own, enabled: false }, { path: builtin, enabled: false }, { path: plugin, enabled: true }]);
    const ownItem = items.find(item => item.kind === 'skill' && item.name === 'own')!;
    const builtinItem = items.find(item => item.kind === 'skill' && item.name === 'base')!;
    const pluginItem = items.find(item => item.kind === 'skill' && item.name === 'nested')!;
    expect(ownItem).toMatchObject({ enabled: false, actions: ['enable', 'disable', 'uninstall'] });
    expect(builtinItem).toMatchObject({ scope: 'builtin', actions: [] });
    expect(pluginItem).toMatchObject({ enabled: true, scope: 'managed', actions: ['enable', 'disable'] });
    expect(pluginItem.ownerPluginId).toBeTruthy();
    expect((await service.detail(ctx, pluginItem.id)).item.actions).toEqual([]);
    await expect(service.manageSkillFiles(ctx, { action: 'uninstall', itemId: pluginItem.id, expectedHash: '0'.repeat(64) }, false)).rejects.toMatchObject({ code: 'EXTENSION_READ_ONLY' });
    await expect(service.manageSkillFiles(ctx, { action: 'uninstall', itemId: builtinItem.id, expectedHash: '0'.repeat(64) }, false)).rejects.toMatchObject({ code: 'EXTENSION_READ_ONLY' });
    expect(await readFile(plugin, 'utf8')).toContain('Plugin.');
    expect(await readFile(builtin, 'utf8')).toContain('Builtin.');
  });

  it('uses agent-native TOML templates and discovers standalone hook event maps', async () => {
    const user = path.join(tempRoot, 'codex-user');
    await mkdir(user, { recursive: true });
    const service = new ExtensionService(path.join(tempRoot, 'state'));
    const ctx = makeContext('codex', user);
    const target = (await service.list(ctx)).createTargets.find(item => item.id === 'user:mcp')!;
    expect(target.fileName).toBe('config.toml');
    expect(target.template).toContain('[mcp_servers.example]');
    const created = await service.createDocument(ctx, { targetId: target.id, path: 'config.toml', content: target.template! });
    expect(created.language).toBe('toml');
    expect((await service.list(ctx)).createTargets.some(item => item.id === target.id)).toBe(false);
    const projectRoot = path.join(tempRoot, 'droid-project');
    await put(projectRoot, '.factory/hooks.json', JSON.stringify({ PreToolUse: [{ hooks: [{ type: 'command', command: 'echo check' }] }] }));
    const droid = makeContext('droid', path.join(tempRoot, 'unsupported'), makeProject(projectRoot));
    await expect(service.list(droid)).rejects.toMatchObject({ code: 'EXTENSION_PROFILE_UNSUPPORTED' });
    droid.profile.config = {};
    const inventory = await service.list(droid);
    expect(inventory.items.some(item => item.kind === 'hook' && item.nativeId === 'PreToolUse:0')).toBe(true);
  });

  it('preserves quoted raw credentials and refuses unsupported multiline secrets', async () => {
    const user = path.join(tempRoot, 'codex-secrets');
    const original = 'api_key = "secret with spaces"\nmodel = "before"\n';
    const file = await put(user, 'config.toml', original);
    const service = new ExtensionService(path.join(tempRoot, 'state'));
    const context = makeContext('codex', user);
    const item = (await service.list(context)).items.find(item => item.kind === 'config')!;
    const view = await service.readDocument(context, item.documentId!);
    expect(view.content).toContain('api_key = "[REDACTED]"');
    await service.writeDocument(context, view.id, { content: view.content.replace('before', 'after'), expectedHash: view.hash });
    expect(await readFile(file, 'utf8')).toBe(original.replace('before', 'after'));
    for (const content of ['private_key = """\nsynthetic-secret-material\n"""\n', 'private_key: |\n  synthetic-secret-material\n']) {
      await writeFile(file, content);
      await expect(service.readDocument(context, view.id)).rejects.toMatchObject({ code: 'EXTENSION_NATIVE_EDITOR_REQUIRED' });
      await expect(service.writeDocument(context, view.id, { content: 'model = "after"', expectedHash: view.hash })).rejects.toBeTruthy();
      expect(await readFile(file, 'utf8')).toBe(content);
    }
  });

  it('redacts secrets, restores placeholders, backs up writes, and detects stale hashes', async () => {
    const user = path.join(tempRoot, 'cursor-user');
    await mkdir(user, { recursive: true });
    const secret = 'do-not-leak-this-extension-token-731942';
    const configPath = await put(user, 'mcp.json', JSON.stringify({
      mcpServers: { docs: { command: 'docs-server', env: { API_TOKEN: secret } } },
      keepThis: 'preserved',
    }, null, 2) + '\n');
    const stateDir = path.join(tempRoot, 'state');
    const service = new ExtensionService(stateDir);
    const ctx = makeContext('cursor', user);
    const inventory = await service.list(ctx);
    const server = inventory.items.find(item => item.kind === 'mcp' && item.nativeId === 'docs');
    expect(server?.documentId).toBeTruthy();
    expect(JSON.stringify(inventory)).not.toContain(secret);
    const document = await service.readDocument(ctx, server!.documentId!);
    expect(document.content).not.toContain(secret);
    expect(document.content).toContain('[REDACTED]');
    const edited = JSON.parse(document.content) as Record<string, any>;
    edited.mcpServers.docs.name = 'Documentation';
    await service.writeDocument(ctx, document.id, { content: JSON.stringify(edited, null, 2), expectedHash: document.hash });
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>;
    expect(saved.mcpServers.docs.env.API_TOKEN).toBe(secret);
    expect(saved.mcpServers.docs.name).toBe('Documentation');
    expect(saved.keepThis).toBe('preserved');
    const backups = await readdir(path.join(stateDir, 'config-backups'), { recursive: true });
    expect(backups.some(file => file.endsWith('.bak'))).toBe(true);

    const fresh = await service.readDocument(ctx, document.id);
    await writeFile(configPath, '{"external":true}\n', 'utf8');
    await expect(service.writeDocument(ctx, document.id, { content: fresh.content, expectedHash: fresh.hash })).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' });
  });

  it('serializes simultaneous saves so a shared expected hash can succeed only once', async () => {
    const user = path.join(tempRoot, 'cursor-user');
    await mkdir(user, { recursive: true });
    await put(user, 'mcp.json', '{"mcpServers":{"docs":{"command":"docs-server"}}}\n');
    const service = new ExtensionService(path.join(tempRoot, 'state'));
    const ctx = makeContext('cursor', user);
    const item = (await service.list(ctx)).items.find(candidate => candidate.kind === 'config' && candidate.name === 'mcp.json')!;
    const document = await service.readDocument(ctx, item.documentId!);
    const first = JSON.parse(document.content) as Record<string, any>;
    const second = JSON.parse(document.content) as Record<string, any>;
    first.mcpServers.docs.name = 'first writer';
    second.mcpServers.docs.name = 'second writer';
    const results = await Promise.allSettled([
      service.writeDocument(ctx, document.id, { content: JSON.stringify(first), expectedHash: document.hash }),
      service.writeDocument(ctx, document.id, { content: JSON.stringify(second), expectedHash: document.hash }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const rejection = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ code: 'CONFIG_CONFLICT' });
  });

  it('rejects invalid JSON edits and allows raw TOML edits with an explicit validation note', async () => {
    const cursorUser = path.join(tempRoot, 'cursor-user');
    const codexUser = path.join(tempRoot, 'codex-user');
    await mkdir(cursorUser, { recursive: true });
    await mkdir(codexUser, { recursive: true });
    const jsonPath = await put(cursorUser, 'mcp.json', '{"mcpServers":{}}\n');
    const malformedSecret = 'malformed-json-secret-984211';
    await put(cursorUser, 'hooks.json', `{"api_token":"${malformedSecret}", broken}\n`);
    const service = new ExtensionService(path.join(tempRoot, 'state'));
    const cursor = makeContext('cursor', cursorUser);
    const cursorInventory = await service.list(cursor);
    expect(JSON.stringify(cursorInventory)).not.toContain(malformedSecret);
    expect(cursorInventory.diagnostics.some(message => message.includes('hooks.json') && message.includes(malformedSecret))).toBe(false);
    const malformedItem = cursorInventory.items.find(item => item.kind === 'config' && item.name === 'hooks.json')!;
    const malformedDocument = await service.readDocument(cursor, malformedItem.documentId!);
    expect(malformedDocument.content).not.toContain(malformedSecret);
    expect(malformedDocument.content).toContain('[REDACTED]');
    const jsonItem = cursorInventory.items.find(item => item.kind === 'config' && item.name === 'mcp.json')!;
    const jsonDocument = await service.readDocument(cursor, jsonItem.documentId!);
    const error = await service.writeDocument(cursor, jsonDocument.id, { content: `{"api_token":"${malformedSecret}", broken`, expectedHash: jsonDocument.hash }).catch(reason => reason);
    expect(error).toMatchObject({ code: 'INVALID_EXTENSION_JSON' });
    expect(String(error)).not.toContain(malformedSecret);
    expect(await readFile(jsonPath, 'utf8')).toBe('{"mcpServers":{}}\n');

    const tomlPath = await put(codexUser, 'config.toml', '[mcp_servers.docs]\ncommand = "docs-server"\n');
    const codex = makeContext('codex', codexUser);
    const codexInventory = await service.list(codex);
    expect(codexInventory.items.some(item => item.kind === 'mcp' && item.name.includes('raw TOML') === false)).toBe(true);
    expect(codexInventory.diagnostics.some(message => message.includes('TOML') && message.includes('不解析'))).toBe(true);
    expect(codexInventory.items.find(item => item.kind === 'mcp')?.nativeId).toBeUndefined();
    const configItem = codexInventory.items.find(item => item.kind === 'config' && item.name === 'config.toml')!;
    const toml = await service.readDocument(codex, configItem.documentId!);
    expect(toml.language).toBe('toml');
    expect(toml.validationNote).toContain('does not validate');
    await service.writeDocument(codex, toml.id, { content: 'raw, unparsed TOML text\n', expectedHash: toml.hash });
    expect(await readFile(tomlPath, 'utf8')).toBe('raw, unparsed TOML text\n');
  });

  it('shows shared in-root symlinks read-only and refuses edits through them', async () => {
    const user = path.join(tempRoot, 'cursor-user');
    const projectRoot = path.join(tempRoot, 'project');
    await mkdir(user, { recursive: true });
    await mkdir(path.join(projectRoot, 'shared'), { recursive: true });
    await put(projectRoot, 'shared/mcp.json', JSON.stringify({ mcpServers: { shared: { command: 'shared-server' } } }));
    await symlink(path.join(projectRoot, 'shared'), path.join(projectRoot, '.cursor'));
    const service = new ExtensionService(path.join(tempRoot, 'state'));
    const ctx = makeContext('cursor', user, makeProject(projectRoot));
    const inventory = await service.list(ctx);
    const item = inventory.items.find(candidate => candidate.kind === 'mcp' && candidate.nativeId === 'shared');
    expect(item?.scope).toBe('managed');
    expect(item?.readOnlyReason).toBeTruthy();
    await expect(service.writeDocument(ctx, item!.documentId!, { content: '{}', expectedHash: (await service.readDocument(ctx, item!.documentId!)).hash })).rejects.toMatchObject({ code: 'EXTENSION_READ_ONLY' });
    expect(inventory.diagnostics.some(message => message.includes('symlink') && message.includes('.cursor/mcp.json'))).toBe(true);
  });

  it('projects Claude global MCP settings and preserves private top-level state on write', async () => {
    const claudeConfig = path.join(tempRoot, 'claude-config');
    await mkdir(claudeConfig, { recursive: true });
    const secret = 'claude-oauth-private-value-88421';
    const filePath = await put(claudeConfig, '.claude.json', JSON.stringify({
      oauthAccount: { accessToken: secret },
      mcpServers: { docs: { command: 'docs-server', env: { API_KEY: 'server-secret-778899' } } },
      unrelatedState: { firstLaunch: false },
    }, null, 2) + '\n');
    const service = new ExtensionService(path.join(tempRoot, 'state'));
    const ctx = makeContext('claude', claudeConfig);
    const inventory = await service.list(ctx);
    const item = inventory.items.find(candidate => candidate.kind === 'mcp' && candidate.nativeId === 'docs')!;
    const document = await service.readDocument(ctx, item.documentId!);
    expect(document.content).not.toContain('oauthAccount');
    expect(document.content).not.toContain(secret);
    expect(document.content).not.toContain('server-secret-778899');
    const projected = JSON.parse(document.content) as Record<string, any>;
    projected.mcpServers.docs.description = 'Updated safely';
    await service.writeDocument(ctx, document.id, { content: JSON.stringify(projected, null, 2), expectedHash: document.hash });
    const saved = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, any>;
    expect(saved.oauthAccount.accessToken).toBe(secret);
    expect(saved.unrelatedState.firstLaunch).toBe(false);
    expect(saved.mcpServers.docs.env.API_KEY).toBe('server-secret-778899');
    expect(saved.mcpServers.docs.description).toBe('Updated safely');
  });

  it('lists DSH profile bundles by npm id while marking Riffet bundles managed', async () => {
    const profileHome = path.join(tempRoot, 'dsh-home');
    const ctx = makeContext('dsh', profileHome);
    // runtimeSettings derives this stable per-profile directory without invoking DSH.
    const { runtimeSettings } = await import('../backends/dsh/settings.js');
    const profileDir = runtimeSettings(ctx.profile).profileDir;
    await mkdir(profileDir, { recursive: true });
    await put(profileDir, 'package.json', JSON.stringify({
      name: 'riffet-dsh-profile',
      dependencies: { '@riffet/dsh-native-bridge': '0.2.0', '@user/example-bundle': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@user/example-bundle'] } },
    }));
    const inventory = await new ExtensionService(path.join(tempRoot, 'state')).list(ctx);
    const managed = inventory.items.find(item => item.kind === 'plugin' && item.nativeId === '@deepseek-ai/dsh-base');
    const userBundle = inventory.items.find(item => item.kind === 'plugin' && item.nativeId === '@user/example-bundle');
    const bridge = inventory.items.find(item => item.kind === 'plugin' && item.nativeId === '@riffet/dsh-native-bridge');
    expect(managed?.scope).toBe('managed');
    expect(userBundle).toMatchObject({ scope: 'user', enabled: true });
    expect(bridge?.readOnlyReason).toContain('Riffet');
  });

  it('never runs a configured executable during file discovery', async () => {
    const user = path.join(tempRoot, 'trae-user');
    const marker = path.join(tempRoot, 'executed');
    await mkdir(user, { recursive: true });
    const executable = path.join(tempRoot, 'fake-agent');
    await writeFile(executable, `#!/bin/sh\nprintf executed > '${marker}'\n`, 'utf8');
    await chmod(executable, 0o755);
    const profile: NativeBackendProfileConfig = { id: 'test', backendId: 'traex', name: 'test', config: { configDir: user, executable } };
    const service = new ExtensionService(path.join(tempRoot, 'state'));
    await service.list({ backendId: 'traex', profile });
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
