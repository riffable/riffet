import { createHash } from 'node:crypto';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionCreateTarget, ExtensionKind, ExtensionScope } from '../../../../packages/contracts/src/extensions.js';
import { AppError } from '../errors.js';
import { runtimeSettings as dshRuntimeSettings } from '../backends/dsh/settings.js';
import { assertWithin, isWithin, projectRoot } from '../workspace/scope.js';
import { MAX_CONFIG_DOCUMENT_BYTES, readConfigDocumentBytes, redactSensitiveText } from '../settings/config-documents.js';
import type { AgentExtensionLayout } from '@riffet/plugin-api/experimental/agent';
import { standingCodexProject } from './riffet-skills.js';
import type { ExtensionContext, ExtensionDocumentDescriptor } from './types.js';

export const MAX_SCAN_DEPTH = 7;
export const MAX_SCAN_FILES = 1200;
/** An Agent's plugin manifest sits in a `.<agent>-plugin` directory beside the plugin's own files. */
export const MANIFEST_DIRECTORY = /^\.[a-z0-9]+-plugin$/;

export type SharedRoot = NonNullable<AgentExtensionLayout['sharedRoot']>;
/** `declared-shared-skills`: a root under the home directory a backend's layout (`sharedRoot`) also reads, held in `shared`. */
export interface SourceRoot { scope: 'user' | 'project'; root: string; displayRoot: string; role: 'agent' | 'claude-global' | 'declared-shared-skills' | 'codex-shared-skills' | 'pi-shared-skills'; shared?: SharedRoot; }
export interface PluginRoot { source: SourceRoot; root: string; itemId: string; }

export function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
export function errMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function normalizeItemName(value: string): string { return redactSensitiveText(value).trim().slice(0, 160) || 'Unnamed extension'; }

function configuredPath(profile: ExtensionContext['profile'], key: 'configDir' | 'sourceDir'): string | undefined {
  const value = profile.config[key];
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return undefined;
  return path.resolve(value.trim().replace(/^~(?=\/|$)/, os.homedir()));
}

export function userRootFor(ctx: ExtensionContext): string {
  const profile = ctx.profile;
  const configured = configuredPath(profile, 'configDir');
  const home = os.homedir();
  if (ctx.layout) return ctx.layout.userRoot(profile.config, configured);
  switch (ctx.backendId) {
    case 'codex': return path.resolve(configured ?? process.env.CODEX_HOME?.trim() ?? path.join(home, '.codex'));
    case 'traex': return path.resolve(configured ?? process.env.TRAE_HOME?.trim() ?? path.join(home, '.trae'));
    case 'claude': return path.resolve(configured ?? process.env.CLAUDE_CONFIG_DIR?.trim() ?? path.join(home, '.claude'));
    case 'droid':
      if (configured && configured !== path.join(home, '.factory')) throw new AppError('EXTENSION_PROFILE_UNSUPPORTED', 'The Droid native runtime does not support a custom configDir; clear it before managing extensions', 409);
      return path.join(home, '.factory');
    case 'dsh': return path.resolve(dshRuntimeSettings(profile).profileDir);
    case 'pi': return path.resolve(configured ?? process.env.PI_CODING_AGENT_DIR?.trim() ?? path.join(home, '.pi', 'agent'));
    default: throw new AppError('EXTENSION_BACKEND_UNSUPPORTED', 'This backend does not describe where its extensions live', 409);
  }
}

export function sourceRoots(ctx: ExtensionContext, diagnostics: string[]): Promise<SourceRoot[]> {
  return (async () => {
    const configuredUserRoot = userRootFor(ctx);
    let userPath = path.resolve(configuredUserRoot);
    try { userPath = await realpath(userPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        diagnostics.push(`User extension config directory is missing: ${userRootDisplay(userPath)}`);
        const missingParts: string[] = [];
        let ancestor = userPath;
        while (true) {
          try { userPath = path.join(await realpath(ancestor), ...missingParts.reverse()); break; }
          catch (nested) {
            if ((nested as NodeJS.ErrnoException).code !== 'ENOENT') break;
            const parent = path.dirname(ancestor);
            if (parent === ancestor) break;
            missingParts.push(path.basename(ancestor));
            ancestor = parent;
          }
        }
      } else diagnostics.push(`User config directory could not be resolved (${userRootDisplay(userPath)}): ${errMessage(error)}`);
    }
    const roots: SourceRoot[] = [{ scope: 'user', root: userPath, displayRoot: userRootDisplay(userPath), role: 'agent' }];
    const home = path.resolve(os.homedir());
    if (ctx.backendId === 'claude') {
      const globalRoot = path.resolve(configuredPath(ctx.profile, 'configDir') ?? process.env.CLAUDE_CONFIG_DIR?.trim() ?? home);
      let canonical = globalRoot;
      try { canonical = await realpath(globalRoot); }
      catch { /* the single-file target may not exist yet */ }
      roots.push({ scope: 'user', root: canonical, displayRoot: userRootDisplay(canonical), role: 'claude-global' });
    }
    if (ctx.layout?.sharedRoot) roots.push({ scope: 'user', root: home, displayRoot: userRootDisplay(home), role: 'declared-shared-skills', shared: ctx.layout.sharedRoot });
    if (ctx.backendId === 'codex') roots.push({ scope: 'user', root: home, displayRoot: userRootDisplay(home), role: 'codex-shared-skills' });
    if (ctx.backendId === 'pi') roots.push({ scope: 'user', root: home, displayRoot: userRootDisplay(home), role: 'pi-shared-skills' });
    if (ctx.project) {
      const root = await projectRoot(ctx.project);
      roots.push({ scope: 'project', root, displayRoot: '.', role: 'agent' });
    }
    return roots;
  })();
}

export function userRootDisplay(root: string): string {
  const home = path.resolve(os.homedir());
  return isWithin(home, root) ? `~/${path.relative(home, root).split(path.sep).join('/')}` : 'profile';
}

export function displayPath(source: SourceRoot['root'], absolute: string, scope: ExtensionScope): string {
  const relative = path.relative(source, absolute).split(path.sep).join('/');
  if (scope === 'project') return relative || '.';
  const prefix = userRootDisplay(source);
  return relative ? `${prefix.replace(/\/$/, '')}/${relative}` : prefix;
}

export async function hasSymlinkAncestor(root: string, target: string): Promise<boolean> {
  const relative = path.relative(root, target);
  if (!isWithin(root, target)) return true;
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false; throw error; }
  }
  return false;
}

export function createTargetDocumentDescriptor(ctx: ExtensionContext, root: string, scope: 'user' | 'project', relativePath: string, kind: ExtensionKind, projection?: ExtensionDocumentDescriptor['projection']): ExtensionDocumentDescriptor {
  const absolutePath = path.resolve(root, relativePath);
  if (!isWithin(root, absolutePath)) throw new AppError('INVALID_EXTENSION_PATH', 'Extension path must stay inside its selected root', 403);
  const id = sha([ctx.backendId, ctx.profile.id, scope, root, relativePath, kind].join('\0')).slice(0, 40);
  const display = scope === 'project'
    ? relativePath.split(path.sep).join('/')
    : `${userRootDisplay(root).replace(/\/$/, '')}/${relativePath.split(path.sep).join('/')}`;
  return { id, path: display, absolutePath, relativePath, root, scope, language: languageFor(absolutePath), editable: true, applyEffect: applyEffect(ctx), ...(projection ? { projection } : {}) };
}

export function applyEffect(ctx: ExtensionContext): string {
  if (ctx.layout) return ctx.layout.applyEffect;
  switch (ctx.backendId) {
    case 'codex': return 'New Codex sessions read this file; a running app-server may need a restart.';
    case 'traex': return 'New TRAE CLI sessions read this file; a running app-server may need a restart.';
    case 'claude': return 'Claude Code may reload settings automatically; otherwise start a new session.';
    case 'droid': return 'New Droid sessions read this file.';
    case 'dsh': return 'DSH reads profile configuration when its runtime starts.';
    case 'pi': return 'New pi sessions read this file; a running session may need /reload or a restart.';
    default: return 'A new session may be needed to apply this change.';
  }
}

export function languageFor(filePath: string): ExtensionDocumentDescriptor['language'] {
  switch (path.extname(filePath).toLowerCase()) {
    case '.json': return 'json';
    case '.toml': return 'toml';
    case '.yaml': case '.yml': return 'yaml';
    case '.md': case '.mdc': case '.rules': return 'markdown';
    default: return 'text';
  }
}

export function managedPath(relativePath: string, backendId?: ExtensionContext['backendId']): boolean {
  const normalized = `/${relativePath.split(path.sep).join('/').toLowerCase()}/`;
  const base = path.basename(relativePath).toLowerCase();
  return normalized.includes('/plugins/cache/') || normalized.includes('/plugins/marketplaces/') || normalized.includes('/node_modules/')
    || /(?:^|\/)\.riffet-bridge[^/]*\.patch$/i.test(relativePath)
    || (backendId === 'dsh' && base === 'package.json');
}

export async function scanFiles(source: SourceRoot, relativeDir: string, matches: (base: string, relative: string) => boolean, diagnostics: string[], maxDepth = MAX_SCAN_DEPTH, realRoot?: string): Promise<Array<{ absolute: string; relative: string; symlink: boolean }>> {
  const result: Array<{ absolute: string; relative: string; symlink: boolean }> = [];
  const start = path.resolve(source.root, relativeDir);
  if (!isWithin(source.root, start)) return result;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth || result.length >= MAX_SCAN_FILES) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return;
      diagnostics.push(`Cannot read extension directory ${displayPath(source.root, directory, source.scope)}: ${errMessage(error)}`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (result.length >= MAX_SCAN_FILES) break;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(source.root, absolute);
      if (!isWithin(source.root, absolute)) continue;
      if (entry.isSymbolicLink()) {
        if (matches(entry.name, relative)) result.push({ absolute, relative, symlink: true });
        else diagnostics.push(`Skipped shared extension symlink ${displayPath(source.root, absolute, source.scope)}; linked content is read-only.`);
      } else if (entry.isDirectory()) {
        if (entry.name !== '.git' && entry.name !== 'node_modules') await walk(absolute, depth + 1);
      } else if (entry.isFile() && matches(entry.name, relative)) result.push({ absolute, relative, symlink: false });
    }
  };
  try {
    const rootReal = realRoot ?? await realpath(source.root);
    const startReal = await realpath(start);
    assertWithin(rootReal, startReal);
    if (!(await stat(startReal)).isDirectory()) return result;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') diagnostics.push(`Cannot scan extension path ${displayPath(source.root, start, source.scope)}: ${errMessage(error)}`);
    return result;
  }
  await walk(start, 0);
  return result;
}

export async function readCandidate(filePath: string, root: string, realRoot?: string, knownRegularFile = false): Promise<{ content: string; raw: Buffer; symlink: boolean }> {
  const info = knownRegularFile ? undefined : await lstat(filePath);
  const symlink = info ? info.isSymbolicLink() : false;
  const resolvedRoot = realRoot ?? await realpath(root);
  const target = symlink || !knownRegularFile ? await realpath(filePath) : filePath;
  assertWithin(resolvedRoot, target, 'EXTENSION_PATH_OUTSIDE_ROOT');
  if (symlink) {
    const targetInfo = await stat(target);
    if (!targetInfo.isFile()) throw new AppError('EXTENSION_NOT_FILE', 'Extension document is not a regular file', 409);
  } else if (info && !info.isFile()) {
    throw new AppError('EXTENSION_NOT_FILE', 'Extension document is not a regular file', 409);
  }
  const raw = await readConfigDocumentBytes(target, MAX_CONFIG_DOCUMENT_BYTES, 'EXTENSION_TOO_LARGE');
  return { content: raw.toString('utf8'), raw, symlink };
}

export function configTargets(ctx: ExtensionContext, scope: SourceRoot['scope'], role: SourceRoot['role']): Array<{ relative: string; kind: ExtensionKind }> {
  if (role === 'claude-global') return [{ relative: '.claude.json', kind: 'mcp' }];
  if (role !== 'agent') return [];
  const standing = scope === 'project' ? standingCodexProject(ctx) : undefined;
  if (standing) return [{ relative: standing.mcp, kind: 'mcp' }];
  if (ctx.layout) return ctx.layout.configFiles[scope];
  switch (ctx.backendId) {
    case 'codex': return scope === 'project' ? [{ relative: '.codex/config.toml', kind: 'config' }, { relative: '.codex/hooks.json', kind: 'hook' }] : [{ relative: 'config.toml', kind: 'config' }, { relative: 'hooks.json', kind: 'hook' }];
    case 'claude': return scope === 'project'
      ? [{ relative: '.mcp.json', kind: 'mcp' }, { relative: '.claude/settings.json', kind: 'hook' }, { relative: '.claude/settings.local.json', kind: 'hook' }]
      : [{ relative: 'settings.json', kind: 'hook' }, { relative: 'settings.local.json', kind: 'hook' }];
    case 'dsh': return scope === 'user' ? [{ relative: 'package.json', kind: 'config' }, { relative: 'cordis.patch.yml', kind: 'config' }] : [];
    case 'droid': return scope === 'project'
      ? [{ relative: '.factory/settings.json', kind: 'config' }, { relative: '.factory/mcp.json', kind: 'mcp' }, { relative: '.factory/hooks.json', kind: 'hook' }, { relative: '.factory/hooks/hooks.json', kind: 'hook' }]
      : [{ relative: 'settings.json', kind: 'config' }, { relative: 'mcp.json', kind: 'mcp' }, { relative: 'hooks.json', kind: 'hook' }, { relative: 'hooks/hooks.json', kind: 'hook' }];
    case 'traex': return scope === 'user' ? [{ relative: 'traecli.toml', kind: 'config' }] : [];
    case 'pi': return scope === 'user'
      ? [{ relative: 'settings.json', kind: 'config' }, { relative: 'mcp.json', kind: 'mcp' }]
      : [{ relative: '.pi/settings.json', kind: 'config' }, { relative: '.pi/mcp.json', kind: 'mcp' }];
    default: return [];
  }
}

export function markdownDirectories(ctx: ExtensionContext, source: Pick<SourceRoot, 'scope' | 'role' | 'shared'>, kind: 'skill' | 'rule' | 'command'): string[] {
  const { scope, role } = source;
  if (role === 'declared-shared-skills') return source.shared?.directories[kind] ?? [];
  if (role === 'codex-shared-skills') return kind === 'skill' ? ['.agents/skills'] : [];
  if (role === 'pi-shared-skills') return kind === 'skill' ? ['.agents/skills'] : [];
  if (role !== 'agent') return [];
  const standing = scope === 'project' ? standingCodexProject(ctx) : undefined;
  if (standing) return kind === 'skill' ? [standing.skill] : [];
  if (ctx.layout) return ctx.layout.directories[scope][kind];
  const layouts: Partial<Record<ExtensionContext['backendId'], Record<'user' | 'project', Record<'skill' | 'rule' | 'command', string[]>>>> = {
    codex: {
      user: { skill: ['skills'], rule: ['rules'], command: ['prompts'] },
      project: { skill: ['.agents/skills'], rule: ['.codex/rules'], command: ['.codex/prompts'] },
    },
    claude: {
      user: { skill: ['skills'], rule: ['rules'], command: ['commands'] },
      project: { skill: ['.claude/skills'], rule: ['.claude/rules'], command: ['.claude/commands'] },
    },
    dsh: { user: { skill: [], rule: [], command: [] }, project: { skill: [], rule: [], command: [] } },
    droid: {
      user: { skill: ['skills'], rule: ['rules'], command: ['commands'] },
      project: { skill: ['.factory/skills'], rule: ['.factory/rules'], command: ['.factory/commands'] },
    },
    traex: {
      user: { skill: ['skills'], rule: ['rules'], command: [] },
      project: { skill: ['.trae/skills', '.agents/skills'], rule: ['.trae/rules'], command: [] },
    },
    pi: {
      user: { skill: ['skills'], rule: [], command: ['prompts'] },
      project: { skill: ['.pi/skills', '.agents/skills'], rule: [], command: ['.pi/prompts'] },
    },
  };
  return layouts[ctx.backendId]?.[scope][kind] ?? [];
}

export function pluginDirectories(ctx: ExtensionContext, scope: SourceRoot['scope'], role: SourceRoot['role']): string[] {
  if (role !== 'agent') return [];
  if (scope === 'project' && standingCodexProject(ctx)) return [];
  if (ctx.layout) return ctx.layout.directories[scope].plugin;
  switch (ctx.backendId) {
    case 'codex': return scope === 'project' ? ['.codex/plugins'] : ['plugins'];
    case 'claude': return scope === 'project' ? ['.claude/plugins'] : ['plugins'];
    case 'dsh': return scope === 'user' ? ['plugins'] : [];
    case 'droid': return scope === 'project' ? ['.factory/plugins'] : ['plugins'];
    case 'traex': return scope === 'user' ? ['plugins'] : [];
    default: return [];
  }
}

export function createTargetList(ctx: ExtensionContext, source: SourceRoot): ExtensionCreateTarget[] {
  const scope = source.scope, backendId = ctx.backendId;
  if (source.role === 'claude-global') return [{ id: 'user:mcp', label: 'Global MCP servers', kind: 'mcp', scope: 'user', directory: '', fileName: '.claude.json' }];
  if (source.role === 'declared-shared-skills') return (source.shared?.create ?? []).map(target => ({ ...target, id: `user:${target.id}`, scope: 'user' as const }));
  if (source.role === 'pi-shared-skills') return [];
  if (source.role !== 'agent') return [];
  const standing = scope === 'project' ? standingCodexProject(ctx) : undefined;
  if (standing) return [
    { id: 'project:skill', label: 'Skill', kind: 'skill', scope, directory: standing.skill },
    { id: 'project:mcp', label: 'Project MCP servers', kind: 'mcp', scope, directory: '', fileName: standing.mcp },
  ];
  if (ctx.layout) return ctx.layout.create[scope].map(target => ({ ...target, id: `${scope}:${target.id}`, scope, directory: target.directory === '.' ? '' : target.directory }));
  const skillDir: Partial<Record<ExtensionContext['backendId'], string>> = scope === 'project'
    ? { codex: '.agents/skills', claude: '.claude/skills', droid: '.factory/skills', pi: '.pi/skills' }
    : { codex: 'skills', claude: 'skills', droid: 'skills', traex: 'skills', pi: 'skills' };
  const ruleDir: Partial<Record<ExtensionContext['backendId'], string>> = {
    codex: scope === 'project' ? '.codex/rules' : 'rules',
    claude: scope === 'project' ? '.claude/rules' : 'rules',
    droid: scope === 'project' ? '.factory/rules' : 'rules',
    traex: scope === 'project' ? '.trae/rules' : 'rules',
  };
  const commandDir: Partial<Record<ExtensionContext['backendId'], string>> = { codex: scope === 'project' ? '.codex/prompts' : 'prompts', claude: scope === 'project' ? '.claude/commands' : 'commands', droid: scope === 'project' ? '.factory/commands' : 'commands', pi: scope === 'project' ? '.pi/prompts' : 'prompts' };
  const targets: Array<{ id: string; label: string; kind: ExtensionCreateTarget['kind']; directory: string; fileName?: string }> = [];
  const add = (target: { id: string; label: string; kind: ExtensionCreateTarget['kind']; directory: string; fileName?: string }) => targets.push(target);
  if (skillDir[backendId] && markdownDirectories(ctx, source, 'skill').includes(skillDir[backendId]!)) add({ id: 'skill', label: 'Skill', kind: 'skill', directory: skillDir[backendId]! });
  if (ruleDir[backendId] && markdownDirectories(ctx, source, 'rule').includes(ruleDir[backendId]!)) add({ id: 'rule', label: 'Rule', kind: 'rule', directory: ruleDir[backendId]! });
  if (commandDir[backendId] && markdownDirectories(ctx, source, 'command').includes(commandDir[backendId]!)) add({ id: 'command', label: 'Command', kind: 'command', directory: commandDir[backendId]! });
  if (backendId === 'codex') add({ id: 'hook', label: 'Hook configuration', kind: 'hook', directory: scope === 'project' ? '.codex' : '', fileName: 'hooks.json' });
  if (backendId === 'codex') add({ id: 'mcp', label: 'MCP configuration', kind: 'mcp', directory: scope === 'project' ? '.codex' : '', fileName: 'config.toml' });
  if (backendId === 'traex' && scope === 'user') add({ id: 'mcp', label: 'MCP configuration', kind: 'mcp', directory: '', fileName: 'traecli.toml' });
  if (backendId === 'claude') {
    if (scope === 'project') add({ id: 'mcp', label: 'Project MCP servers', kind: 'mcp', directory: '', fileName: '.mcp.json' });
    add({ id: 'hook', label: 'Hook configuration', kind: 'hook', directory: scope === 'project' ? '.claude' : '', fileName: scope === 'project' ? 'settings.json' : 'settings.json' });
  }
  if (backendId === 'droid') {
    add({ id: 'mcp', label: 'MCP configuration', kind: 'mcp', directory: scope === 'project' ? '.factory' : '', fileName: 'mcp.json' });
    add({ id: 'hook', label: 'Hook configuration', kind: 'hook', directory: scope === 'project' ? '.factory' : '', fileName: 'hooks.json' });
  }
  if (backendId === 'pi') add({ id: 'mcp', label: 'MCP configuration', kind: 'mcp', directory: scope === 'project' ? '.pi' : '', fileName: 'mcp.json' });
  return targets.map(target => ({ ...target, id: `${scope}:${target.id}`, scope, directory: target.directory === '.' ? '' : target.directory,
    ...(target.fileName?.endsWith('.toml') ? { template: '# MCP servers\n# [mcp_servers.example]\n# command = "your-server-command"\n' } : {}),
    ...(target.kind === 'hook' ? { template: backendId === 'droid' ? '{}\n' : '{\n  "hooks": {}\n}\n' } : {}),
  }));
}

export function isMarkdown(name: string): boolean { return /\.(?:md|mdc|rules)$/i.test(name); }
export function isSkill(name: string): boolean { return name === 'SKILL.md' || name === 'SKILL.md.riffet-disabled'; }
export function builtinSkillPath(relative: string): boolean { return /(?:^|\/)skills\/\.system(?:\/|$)/.test(relative.split(path.sep).join('/')); }
export function skillIdentityPath(relative: string): string { return relative.replace(/SKILL\.md\.riffet-disabled$/, 'SKILL.md'); }
export function pluginManifest(name: string, relative: string): boolean {
  return name === 'plugin.json'
    || name === 'manifest.json' && /(?:^|\/)\.[a-z0-9]+-plugin\//.test(relative)
    || name === 'package.json' && /(?:^|\/)plugins\//.test(`/${relative.split(path.sep).join('/')}`);
}
