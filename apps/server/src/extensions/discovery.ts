import { createHash } from 'node:crypto';
import { riffetSkillEntries, scopeInEffect } from './riffet-skills.js';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionCreateTarget, ExtensionDetail, ExtensionItem, ExtensionKind, ExtensionScope } from '../../../../packages/contracts/src/extensions.js';
import { AppError } from '../errors.js';
import { runtimeSettings as dshRuntimeSettings } from '../backends/dsh/settings.js';
import { assertWithin, isWithin, projectRoot } from '../workspace/scope.js';
import { MAX_CONFIG_DOCUMENT_BYTES, hashConfigContent, readConfigDocumentBytes, redactSensitiveText } from '../settings/config-documents.js';
import type { AgentExtensionLayout } from '@riffet/plugin-api/experimental/agent';
import type { ExtensionContext, ExtensionDocumentDescriptor, ExtensionSnapshot } from './types.js';
import { readSkillSettings } from './skill-settings.js';

const MAX_SCAN_DEPTH = 7;
const MAX_SCAN_FILES = 1200;
const JSON_FILE_NAMES = new Set(['settings.json', 'settings.local.json', 'mcp.json', '.mcp.json', 'hooks.json', 'config.json', 'plugin.json', 'manifest.json']);

type SharedRoot = NonNullable<AgentExtensionLayout['sharedRoot']>;
/** `declared-shared-skills`: a root under the home directory a backend's layout (`sharedRoot`) also reads, held in `shared`. */
interface SourceRoot { scope: 'user' | 'project'; root: string; displayRoot: string; role: 'agent' | 'claude-global' | 'declared-shared-skills' | 'codex-shared-skills' | 'pi-shared-skills'; shared?: SharedRoot; }
interface PluginRoot { source: SourceRoot; root: string; itemId: string; }

function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function errMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

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

function sourceRoots(ctx: ExtensionContext, diagnostics: string[]): Promise<SourceRoot[]> {
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

function userRootDisplay(root: string): string {
  const home = path.resolve(os.homedir());
  return isWithin(home, root) ? `~/${path.relative(home, root).split(path.sep).join('/')}` : 'profile';
}

function displayPath(source: SourceRoot['root'], absolute: string, scope: ExtensionScope): string {
  const relative = path.relative(source, absolute).split(path.sep).join('/');
  if (scope === 'project') return relative || '.';
  const prefix = userRootDisplay(source);
  return relative ? `${prefix.replace(/\/$/, '')}/${relative}` : prefix;
}

async function hasSymlinkAncestor(root: string, target: string): Promise<boolean> {
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

function applyEffect(ctx: ExtensionContext): string {
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

function languageFor(filePath: string): ExtensionDocumentDescriptor['language'] {
  switch (path.extname(filePath).toLowerCase()) {
    case '.json': return 'json';
    case '.toml': return 'toml';
    case '.yaml': case '.yml': return 'yaml';
    case '.md': case '.mdc': case '.rules': return 'markdown';
    default: return 'text';
  }
}

function managedPath(relativePath: string, backendId?: ExtensionContext['backendId']): boolean {
  const normalized = `/${relativePath.split(path.sep).join('/').toLowerCase()}/`;
  const base = path.basename(relativePath).toLowerCase();
  return normalized.includes('/plugins/cache/') || normalized.includes('/plugins/marketplaces/') || normalized.includes('/node_modules/')
    || /(?:^|\/)\.riffet-bridge[^/]*\.patch$/i.test(relativePath)
    || (backendId === 'dsh' && base === 'package.json');
}

function normalizeItemName(value: string): string { return redactSensitiveText(value).trim().slice(0, 160) || 'Unnamed extension'; }

function markdownDescription(content: string): { name?: string; description?: string; invalidFrontmatter?: boolean } {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end < 0) return { invalidFrontmatter: true };
  const front = content.slice(3, end).split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;
  for (const line of front) {
    const match = line.match(/^\s*(name|description)\s*:\s*(.*?)\s*$/i);
    if (!match) continue;
    const value = match[2].replace(/^(?:"(.*)"|'(.*)')$/, (_all, double?: string, single?: string) => double ?? single ?? '').trim();
    if (match[1].toLowerCase() === 'name') name = redactSensitiveText(value);
    else description = redactSensitiveText(value);
  }
  return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
}

async function scanFiles(source: SourceRoot, relativeDir: string, matches: (base: string, relative: string) => boolean, diagnostics: string[], maxDepth = MAX_SCAN_DEPTH, realRoot?: string): Promise<Array<{ absolute: string; relative: string; symlink: boolean }>> {
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

async function readCandidate(filePath: string, root: string, realRoot?: string, knownRegularFile = false): Promise<{ content: string; raw: Buffer; symlink: boolean }> {
  const info = knownRegularFile ? undefined : await lstat(filePath);
  const symlink = info ? info.isSymbolicLink() : false;
  const resolvedRoot = realRoot ?? await realpath(root);
  const target = symlink ? await realpath(filePath) : filePath;
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

function configTargets(ctx: ExtensionContext, scope: SourceRoot['scope'], role: SourceRoot['role']): Array<{ relative: string; kind: ExtensionKind }> {
  if (role === 'claude-global') return [{ relative: '.claude.json', kind: 'mcp' }];
  if (role !== 'agent') return [];
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

function markdownDirectories(ctx: ExtensionContext, source: Pick<SourceRoot, 'scope' | 'role' | 'shared'>, kind: 'skill' | 'rule' | 'command'): string[] {
  const { scope, role } = source;
  if (role === 'declared-shared-skills') return kind === 'rule' ? [] : source.shared?.directories[kind] ?? [];
  if (role === 'codex-shared-skills') return kind === 'skill' ? ['.agents/skills'] : [];
  if (role === 'pi-shared-skills') return kind === 'skill' ? ['.agents/skills'] : [];
  if (role !== 'agent') return [];
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
      user: { skill: ['skills'], rule: [], command: ['commands'] },
      project: { skill: ['.factory/skills'], rule: [], command: ['.factory/commands'] },
    },
    traex: {
      user: { skill: ['skills'], rule: [], command: [] },
      project: { skill: [], rule: [], command: [] },
    },
    pi: {
      user: { skill: ['skills'], rule: [], command: ['prompts'] },
      project: { skill: ['.pi/skills', '.agents/skills'], rule: [], command: ['.pi/prompts'] },
    },
  };
  return layouts[ctx.backendId]?.[scope][kind] ?? [];
}

function pluginDirectories(ctx: ExtensionContext, scope: SourceRoot['scope'], role: SourceRoot['role']): string[] {
  if (role !== 'agent') return [];
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

function createTargetList(ctx: ExtensionContext, source: SourceRoot): ExtensionCreateTarget[] {
  const scope = source.scope, backendId = ctx.backendId;
  if (source.role === 'claude-global') return [{ id: 'user:mcp', label: 'Global MCP servers', kind: 'mcp', scope: 'user', directory: '', fileName: '.claude.json' }];
  if (source.role === 'declared-shared-skills') return (source.shared?.create ?? []).map(target => ({ ...target, id: `user:${target.id}`, scope: 'user' as const }));
  if (source.role === 'pi-shared-skills') return [];
  if (source.role !== 'agent') return [];
  if (ctx.layout) return ctx.layout.create[scope].map(target => ({ ...target, id: `${scope}:${target.id}`, scope, directory: target.directory === '.' ? '' : target.directory }));
  const skillDir: Partial<Record<ExtensionContext['backendId'], string>> = scope === 'project'
    ? { codex: '.agents/skills', claude: '.claude/skills', droid: '.factory/skills', pi: '.pi/skills' }
    : { codex: 'skills', claude: 'skills', droid: 'skills', traex: 'skills', pi: 'skills' };
  const ruleDir: Partial<Record<ExtensionContext['backendId'], string>> = { codex: scope === 'project' ? '.codex/rules' : 'rules', claude: scope === 'project' ? '.claude/rules' : 'rules' };
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

function isMarkdown(name: string): boolean { return /\.(?:md|mdc|rules)$/i.test(name); }
function isSkill(name: string): boolean { return name === 'SKILL.md' || name === 'SKILL.md.riffet-disabled'; }
function builtinSkillPath(relative: string): boolean { return /(?:^|\/)skills\/\.system(?:\/|$)/.test(relative.split(path.sep).join('/')); }
function skillIdentityPath(relative: string): string { return relative.replace(/SKILL\.md\.riffet-disabled$/, 'SKILL.md'); }
/** An Agent's plugin manifest sits in a `.<agent>-plugin` directory beside the plugin's own files. */
const MANIFEST_DIRECTORY = /^\.[a-z0-9]+-plugin$/;
function pluginManifest(name: string, relative: string): boolean {
  return name === 'plugin.json'
    || name === 'manifest.json' && /(?:^|\/)\.[a-z0-9]+-plugin\//.test(relative)
    || name === 'package.json' && /(?:^|\/)plugins\//.test(`/${relative.split(path.sep).join('/')}`);
}

export async function discoverExtensions(ctx: ExtensionContext): Promise<ExtensionSnapshot> {
  if (ctx.profile.backendId !== ctx.backendId) throw new AppError('EXTENSION_BACKEND_MISMATCH', 'Extension backend and profile do not match', 400);
  const diagnostics: string[] = [];
  const sources = await sourceRoots(ctx, diagnostics);
  const skillSettings = ['claude', 'droid'].includes(ctx.backendId)
    ? await readSkillSettings(ctx, sources.find(source => source.scope === 'user' && source.role === 'agent')!.root)
    : undefined;
  const docs = new Map<string, ExtensionDocumentDescriptor>();
  const items = new Map<string, ExtensionItem>();
  const details = new Map<string, ExtensionDetail>();
  const createTargets = new Map<string, { contract: ExtensionCreateTarget; root: string }>();
  const pluginRoots: PluginRoot[] = [];
  const configFiles: Array<{ source: SourceRoot; absolute: string; relative: string; descriptor: ExtensionDocumentDescriptor; kind: ExtensionKind; content: string }> = [];
  const realRoots = new Map<string, string>();
  const resolveRealRoot = async (root: string): Promise<string> => {
    const cached = realRoots.get(root);
    if (cached !== undefined) return cached;
    const resolved = await realpath(root);
    realRoots.set(root, resolved);
    return resolved;
  };
  const symlinkDirs = new Map<string, boolean>();
  const dirHasSymlinkAncestor = async (root: string, directory: string): Promise<boolean> => {
    const key = `${root}\0${directory}`;
    const cached = symlinkDirs.get(key);
    if (cached !== undefined) return cached;
    const result = await hasSymlinkAncestor(root, directory);
    symlinkDirs.set(key, result);
    return result;
  };

  const itemId = (scope: ExtensionScope, kind: ExtensionKind, absolutePath: string, suffix = ''): string => sha([ctx.backendId, ctx.profile.id, scope, absolutePath, kind, suffix].join('\0')).slice(0, 40);
  const fileDescriptor = (source: SourceRoot, absolute: string, relative: string, scope: ExtensionScope, kind: ExtensionKind, symlink = false): ExtensionDocumentDescriptor => {
    const id = sha([ctx.backendId, ctx.profile.id, scope, source.root, kind === 'skill' ? skillIdentityPath(relative) : relative, kind].join('\0')).slice(0, 40);
    const managed = scope === 'managed' || managedPath(relative, ctx.backendId);
    const effectiveScope: ExtensionScope = managed ? 'managed' : scope;
    const reason = symlink ? '共享链接的内容只读，不能在此删除链接目标。' : scope === 'builtin' ? 'Agent 内置 Skill，随 Agent 安装维护。' : managed ? '此文件由 Agent 或所属插件维护。' : undefined;
    return {
      id,
      path: displayPath(source.root, absolute, source.scope),
      absolutePath: absolute,
      relativePath: relative,
      root: source.root,
      scope: effectiveScope,
      language: kind === 'skill' && isSkill(path.basename(absolute)) ? 'markdown' : languageFor(absolute),
      editable: !reason && (scope === 'project' || scope === 'user'),
      ...(reason ? { reason } : {}),
      applyEffect: applyEffect(ctx),
    };
  };
  const addDoc = (source: SourceRoot, absolute: string, relative: string, kind: ExtensionKind, symlink = false): ExtensionDocumentDescriptor => {
    const scope: ExtensionScope = builtinSkillPath(relative) ? 'builtin' : symlink || managedPath(relative, ctx.backendId) ? 'managed' : source.scope;
    const probe = fileDescriptor(source, absolute, relative, scope, kind, symlink);
    const existing = docs.get(probe.id);
    if (existing) return existing;
    docs.set(probe.id, probe);
    return probe;
  };
  const addItem = (item: ExtensionItem, files: ExtensionDocumentDescriptor[] = []): void => {
    if (items.has(item.id)) return;
    items.set(item.id, item);
    const unique = new Map(files.map(file => [file.id, file]));
    details.set(item.id, { item, files: [...unique.values()].map(({ id, path: filePath, editable, reason }) => ({ id, path: filePath, editable, ...(reason ? { reason } : {}) })) });
  };
  const ownerFor = (source: SourceRoot, relative: string): string | undefined => {
    const absolute = path.resolve(source.root, relative);
    const match = pluginRoots.filter(plugin => isWithin(plugin.root, absolute)).sort((a, b) => b.root.length - a.root.length)[0];
    return match?.itemId;
  };

  const addDocumentItem = async (input: { source: SourceRoot; absolute: string; relative: string; kind: ExtensionKind; name: string; description?: string; ownerPluginId?: string; nativeId?: string; enabled?: boolean; symlink?: boolean; content?: string }): Promise<ExtensionItem | undefined> => {
    const sourceScope = builtinSkillPath(input.relative) ? 'builtin' : input.symlink || managedPath(input.relative, ctx.backendId) ? 'managed' : input.source.scope;
    const descriptor = addDoc(input.source, input.absolute, input.relative, input.kind, input.symlink);
    let description = input.description;
    let name = input.name;
    if (input.kind === 'skill' && input.content !== undefined) {
      const metadata = markdownDescription(input.content);
      name = metadata.name ?? name;
      description = metadata.description ?? description;
      if (metadata.invalidFrontmatter) diagnostics.push(`Skill metadata has an unterminated frontmatter block: ${descriptor.path}`);
    }
    const id = itemId(sourceScope, input.kind, input.kind === 'skill' ? skillIdentityPath(descriptor.absolutePath) : descriptor.absolutePath, input.nativeId ?? '');
    const item: ExtensionItem = {
      id,
      kind: input.kind,
      name: normalizeItemName(name),
      ...(description ? { description: redactSensitiveText(description).slice(0, 1000) } : {}),
      scope: sourceScope,
      sourcePath: descriptor.path,
      ...(input.ownerPluginId ? { ownerPluginId: input.ownerPluginId } : {}),
      ...(input.nativeId ? { nativeId: input.nativeId } : {}),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      runtimeState: 'unknown',
      ...(descriptor.reason ? { readOnlyReason: descriptor.reason } : {}),
      documentId: descriptor.id,
      ...(input.kind === 'skill' ? { actions: [] } : {}),
    };
    descriptor.itemId = id;
    addItem(item, [descriptor]);
    return item;
  };

  const scanConfig = async (source: SourceRoot): Promise<void> => {
    const seen = new Set<string>();
    for (const candidate of configTargets(ctx, source.scope, source.role)) {
      const absolute = path.resolve(source.root, candidate.relative);
      if (!isWithin(source.root, absolute) || seen.has(absolute)) continue;
      seen.add(absolute);
      let info;
      try { info = await lstat(absolute); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
        diagnostics.push(`Cannot inspect extension config ${displayPath(source.root, absolute, source.scope)}: ${errMessage(error)}`);
        continue;
      }
      if (!info.isFile() && !info.isSymbolicLink()) continue;
      let data: { content: string; raw: Buffer; symlink: boolean };
      try { data = await readCandidate(absolute, source.root); }
      catch (error) {
        diagnostics.push(`Cannot read extension config ${displayPath(source.root, absolute, source.scope)}: ${errMessage(error)}`);
        continue;
      }
      const relative = path.relative(source.root, absolute);
      const sharedSymlink = info.isSymbolicLink() || await hasSymlinkAncestor(source.root, absolute);
      if (sharedSymlink) diagnostics.push(`Extension config is reached through a shared symlink and is read-only: ${displayPath(source.root, absolute, source.scope)}`);
      const descriptor = addDoc(source, absolute, relative, candidate.kind, sharedSymlink);
      if (source.role === 'claude-global' && relative === '.claude.json') descriptor.projection = 'claudeMcpServers';
      configFiles.push({ source, absolute, relative, descriptor, kind: candidate.kind, content: data.content });
      const name = path.basename(relative);
      const id = itemId(descriptor.scope, 'config', descriptor.absolutePath, candidate.kind);
      const item: ExtensionItem = {
        id, kind: 'config', name,
        scope: descriptor.scope, sourcePath: descriptor.path, runtimeState: 'unknown',
        ...(descriptor.reason ? { readOnlyReason: descriptor.reason } : {}), documentId: descriptor.id,
      };
      descriptor.itemId ??= id;
      addItem(item, [descriptor]);
      if (ctx.backendId === 'dsh' && relative === 'package.json') {
        let parsed: unknown;
        try { parsed = JSON.parse(data.content); }
        catch { diagnostics.push(`Invalid DSH profile package manifest JSON: ${descriptor.path}`); continue; }
        if (!record(parsed)) { diagnostics.push(`DSH profile package manifest is not a JSON object: ${descriptor.path}`); continue; }
        const dsh = record(parsed.dsh) ? parsed.dsh : undefined;
        const profileSection = dsh && record(dsh.profile) ? dsh.profile : undefined;
        const bundles = Array.isArray(profileSection?.bundles) ? profileSection.bundles.filter((value): value is string => typeof value === 'string') : [];
        const dependencies = record(parsed.dependencies) ? parsed.dependencies : {};
        const names = new Set([...bundles, ...Object.keys(dependencies)]);
        const managedBundles = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-auto-review', '@riffet/dsh-native-bridge']);
        for (const nativeId of names) {
          const isManaged = managedBundles.has(nativeId);
          const pluginScope: ExtensionScope = isManaged ? 'managed' : 'user';
          const pluginId = itemId(pluginScope, 'plugin', descriptor.absolutePath, nativeId);
          addItem({
            id: pluginId, kind: 'plugin', name: normalizeItemName(nativeId), scope: pluginScope,
            sourcePath: descriptor.path, nativeId, enabled: bundles.includes(nativeId), runtimeState: 'unknown',
            ...(isManaged ? { readOnlyReason: 'This bundle is managed by DSH or Riffet.' } : {}), documentId: descriptor.id,
          }, [descriptor]);
        }
      }
    }
  };

  const scanPlugins = async (source: SourceRoot): Promise<void> => {
    const dirs = pluginDirectories(ctx, source.scope, source.role);
    const rootReal = await resolveRealRoot(source.root).catch(() => undefined);
    for (const directory of dirs) {
      const manifests = await scanFiles(source, directory, (base, relative) => pluginManifest(base, relative), diagnostics, 8, rootReal);
      try {
        const base = path.resolve(source.root, directory);
        const entries = await readdir(base, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const candidateRoot = path.join(base, entry.name);
          if (!manifests.some(file => isWithin(candidateRoot, file.absolute))) diagnostics.push(`Plugin directory has no plugin manifest: ${displayPath(source.root, candidateRoot, source.scope)}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') diagnostics.push(`Cannot inspect plugin directory ${directory}: ${errMessage(error)}`);
      }
      for (const file of manifests) {
        let data: { content: string; symlink: boolean };
        try { const read = await readCandidate(file.absolute, source.root, rootReal, !file.symlink); data = { content: read.content, symlink: read.symlink }; }
        catch (error) { diagnostics.push(`Cannot read plugin manifest ${displayPath(source.root, file.absolute, source.scope)}: ${errMessage(error)}`); continue; }
        let parsed: unknown;
        try { parsed = JSON.parse(data.content); }
        catch { diagnostics.push(`Invalid plugin manifest JSON: ${displayPath(source.root, file.absolute, source.scope)}`); parsed = undefined; }
        const rel = path.relative(source.root, file.absolute);
        const manifestDirectory = path.basename(path.dirname(file.absolute));
        const pluginRelativeRoot = MANIFEST_DIRECTORY.test(manifestDirectory)
          ? path.dirname(path.dirname(file.absolute))
          : path.dirname(file.absolute);
        const pluginRoot = path.resolve(pluginRelativeRoot);
        const descriptor = addDoc(source, file.absolute, rel, 'plugin', file.symlink);
        const pluginName = (record(parsed) ? text(parsed.name) : undefined) ?? path.basename(pluginRoot);
        const id = itemId(descriptor.scope, 'plugin', pluginRoot);
        const item: ExtensionItem = {
          id, kind: 'plugin', name: normalizeItemName(pluginName),
          ...(record(parsed) && text(parsed.description) ? { description: redactSensitiveText(text(parsed.description)!).slice(0, 1000) } : {}),
          scope: descriptor.scope, sourcePath: displayPath(source.root, pluginRoot, source.scope), runtimeState: 'unknown',
          ...(descriptor.reason ? { readOnlyReason: descriptor.reason } : {}), documentId: descriptor.id,
        };
        descriptor.itemId = id;
        if (!items.has(item.id)) {
          addItem(item, [descriptor]);
          pluginRoots.push({ source, root: pluginRoot, itemId: id });
        }
        if (!record(parsed)) diagnostics.push(`Plugin manifest does not contain a JSON object: ${displayPath(source.root, file.absolute, source.scope)}`);
        else if (!text(parsed.name)) diagnostics.push(`Plugin manifest is missing a name: ${displayPath(source.root, file.absolute, source.scope)}`);
      }
    }
  };

  const scanPiExtensions = async (source: SourceRoot): Promise<void> => {
    if (ctx.backendId !== 'pi' || source.role !== 'agent') return;
    const directory = source.scope === 'project' ? '.pi/extensions' : 'extensions';
    const base = path.resolve(source.root, directory);
    if (!isWithin(source.root, base)) return;
    let entries;
    try { entries = await readdir(base, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') diagnostics.push(`Cannot read pi extension directory ${displayPath(source.root, base, source.scope)}: ${errMessage(error)}`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const rootReal = await resolveRealRoot(source.root).catch(() => undefined);
    const addExtension = async (absolute: string, name: string, description?: string): Promise<void> => {
      if (rootReal) {
        try {
          const target = await realpath(absolute);
          if (!isWithin(rootReal, target)) { diagnostics.push(`Pi extension entry resolves outside its configuration root: ${displayPath(source.root, absolute, source.scope)}`); return; }
        } catch (error) {
          diagnostics.push(`Cannot inspect pi extension entry ${displayPath(source.root, absolute, source.scope)}: ${errMessage(error)}`);
          return;
        }
      }
      const relative = path.relative(source.root, absolute);
      const symlink = (await lstat(absolute)).isSymbolicLink() || await hasSymlinkAncestor(source.root, absolute);
      const descriptor = addDoc(source, absolute, relative, 'plugin', symlink);
      const id = itemId(descriptor.scope, 'plugin', descriptor.absolutePath);
      const item: ExtensionItem = {
        id, kind: 'plugin', name: normalizeItemName(name),
        ...(description ? { description: redactSensitiveText(description).slice(0, 1000) } : {}),
        scope: descriptor.scope, sourcePath: descriptor.path, runtimeState: 'unknown',
        ...(descriptor.reason ? { readOnlyReason: descriptor.reason } : {}), documentId: descriptor.id,
      };
      descriptor.itemId ??= id;
      addItem(item, [descriptor]);
    };
    for (const entry of entries) {
      const absolute = path.resolve(base, entry.name);
      if (!isWithin(source.root, absolute)) continue;
      if (entry.isSymbolicLink() && rootReal) {
        try {
          if (!isWithin(rootReal, await realpath(absolute))) { diagnostics.push(`Pi extension symlink resolves outside its configuration root: ${displayPath(source.root, absolute, source.scope)}`); continue; }
        } catch (error) {
          diagnostics.push(`Cannot inspect pi extension symlink ${displayPath(source.root, absolute, source.scope)}: ${errMessage(error)}`);
          continue;
        }
      }
      if ((entry.isFile() || entry.isSymbolicLink()) && /\.(?:ts|js)$/.test(entry.name)) {
        await addExtension(absolute, entry.name.replace(/\.(?:ts|js)$/, ''));
        continue;
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      let packageName: string | undefined;
      let packageDescription: string | undefined;
      const declared: string[] = [];
      let manifestRaw: string | undefined;
      try { manifestRaw = (await readCandidate(path.join(absolute, 'package.json'), source.root, rootReal, false)).content; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') diagnostics.push(`Cannot read pi extension manifest ${displayPath(source.root, absolute, source.scope)}: ${errMessage(error)}`);
      }
      if (manifestRaw !== undefined) {
        let parsed: unknown;
        try { parsed = JSON.parse(manifestRaw); }
        catch { diagnostics.push(`Invalid pi extension manifest JSON: ${displayPath(source.root, absolute, source.scope)}`); }
        if (record(parsed)) {
          packageName = text(parsed.name);
          packageDescription = text(parsed.description);
          const pi = record(parsed.pi) ? parsed.pi : undefined;
          const declaredPaths = Array.isArray(pi?.extensions) ? pi.extensions.filter((value): value is string => typeof value === 'string') : [];
          for (const declaredPath of declaredPaths) {
            const resolved = path.resolve(absolute, declaredPath);
            if (!isWithin(source.root, resolved)) { diagnostics.push(`Pi extension path escapes its configuration root: ${displayPath(source.root, resolved, source.scope)}`); continue; }
            try {
              if ((await stat(resolved)).isFile()) declared.push(resolved);
              else diagnostics.push(`Pi extension entry is not a file: ${displayPath(source.root, resolved, source.scope)}`);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') diagnostics.push(`Pi extension entry is missing: ${displayPath(source.root, resolved, source.scope)}`);
              else diagnostics.push(`Cannot inspect pi extension entry ${displayPath(source.root, resolved, source.scope)}: ${errMessage(error)}`);
            }
          }
        }
      }
      if (declared.length) {
        for (const file of [...new Set(declared)]) await addExtension(file, packageName ?? path.basename(file, path.extname(file)), packageDescription);
        continue;
      }
      let found = false;
      for (const index of ['index.ts', 'index.js']) {
        const candidate = path.join(absolute, index);
        try {
          if (!(await stat(candidate)).isFile()) continue;
          await addExtension(candidate, packageName ?? path.basename(absolute), packageDescription);
          found = true;
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') diagnostics.push(`Cannot inspect pi extension entry ${displayPath(source.root, candidate, source.scope)}: ${errMessage(error)}`);
        }
      }
      if (!found) diagnostics.push(`Pi extension directory has no entry point: ${displayPath(source.root, absolute, source.scope)}`);
    }
  };

  const seenMarkdown = new Set<string>();
  const scanMarkdownKind = async (source: SourceRoot, kind: 'skill' | 'rule' | 'command', directory: string, matcher: (name: string) => boolean): Promise<void> => {
    const rootReal = await resolveRealRoot(source.root).catch(() => undefined);
    for (const file of await scanFiles(source, directory, base => matcher(base), diagnostics, MAX_SCAN_DEPTH, rootReal)) {
      if (kind === 'skill' && file.absolute.endsWith('.riffet-disabled')) {
        try {
          await lstat(skillIdentityPath(file.absolute));
          diagnostics.push(`Skill 同时存在启用与停用入口，请先检查冲突：${displayPath(source.root, file.absolute, source.scope)}`);
          continue;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const visitKey = `${source.scope}:${kind}:${file.absolute}`;
      if (seenMarkdown.has(visitKey)) continue;
      seenMarkdown.add(visitKey);
      let data: { content: string; symlink: boolean };
      try { data = await readCandidate(file.absolute, source.root, rootReal, !file.symlink); }
      catch (error) { diagnostics.push(`Cannot read ${kind} ${displayPath(source.root, file.absolute, source.scope)}: ${errMessage(error)}`); continue; }
      const pluginId = ownerFor(source, file.relative);
      const fallback = kind === 'skill' ? path.basename(path.dirname(file.absolute)) : path.basename(file.absolute, path.extname(file.absolute));
      const item = await addDocumentItem({ source, absolute: file.absolute, relative: file.relative, kind, name: fallback, ownerPluginId: pluginId, symlink: file.symlink || await dirHasSymlinkAncestor(source.root, path.dirname(file.absolute)), content: data.content });
      if (kind === 'skill' && item) {
        const descriptor = docs.get(item.documentId!)!;
        const disabled = file.absolute.endsWith('.riffet-disabled');
        if (disabled) item.enabled = false;
        else if (ctx.layout?.skillsAlwaysEnabled) item.enabled = true;
        else if (skillSettings && !item.ownerPluginId && item.scope !== 'builtin') item.enabled = skillSettings.enabled(fallback, data.content);
        if (descriptor.editable && !item.ownerPluginId) {
          item.actions = ['enable', 'disable', 'uninstall'];
          item.managementNote = ['codex', 'traex'].includes(ctx.backendId)
            ? '开关写入当前 Agent 配置，其他项目也可能受影响。删除会移走整个 Skill 目录，并保留备份。'
            : '开关按当前 Agent 的能力应用。文件停用或删除会影响共用此目录的 Agent；删除会保留整个目录的备份。';
        } else if (item.ownerPluginId) item.managementNote = '由插件提供；可通过所属插件统一启停和卸载。';
        const skillDirectory = path.dirname(file.absolute);
        const skillRelative = path.relative(source.root, skillDirectory).split(path.sep).join('/');
        const supportFiles = await scanFiles(source, skillRelative, (base, relative) => !isSkill(base)
          && /\.(?:md|mdc|txt|json|toml|ya?ml|py|sh|js|mjs|cjs|ts|tsx|jsx|html|css|xml|svg)$/i.test(base)
          && !/(?:^|\/)(?:\.git|node_modules)(?:\/|$)/i.test(relative), diagnostics, 5, rootReal);
        const detail = details.get(item.id);
        if (detail) {
          const files = new Map(detail.files.map(existing => [existing.id, existing]));
          const skillDirSymlink = file.symlink || await dirHasSymlinkAncestor(source.root, skillDirectory);
          for (const support of supportFiles) {
            if (support.symlink) {
              try {
                const target = await realpath(support.absolute);
                const resolvedRoot = rootReal ?? await resolveRealRoot(source.root);
                assertWithin(resolvedRoot, target, 'EXTENSION_PATH_OUTSIDE_ROOT');
                if (!(await stat(target)).isFile()) continue;
              } catch (error) { diagnostics.push(`Cannot read skill support file ${displayPath(source.root, support.absolute, source.scope)}: ${errMessage(error)}`); continue; }
            }
            const sharedLink = skillDirSymlink || support.symlink || await dirHasSymlinkAncestor(source.root, path.dirname(support.absolute));
            const descriptor = addDoc(source, support.absolute, support.relative, 'skill', sharedLink);
            descriptor.itemId = item.id;
            files.set(descriptor.id, { id: descriptor.id, path: descriptor.path, editable: descriptor.editable, ...(descriptor.reason ? { reason: descriptor.reason } : {}) });
          }
          details.set(item.id, { ...detail, files: [...files.values()] });
        }
      }
    }
  };

  const addKnownRuleFiles = async (source: SourceRoot): Promise<void> => {
    if (source.role !== 'agent') return;
    const fixedByBackend: Partial<Record<ExtensionContext['backendId'], { user: string[]; project: string[] }>> = {
      codex: { user: ['AGENTS.md'], project: ['AGENTS.md'] },
      claude: { user: ['CLAUDE.md'], project: ['CLAUDE.md', 'CLAUDE.local.md'] },
      dsh: { user: [], project: [] },
      droid: { user: [], project: ['AGENTS.md'] },
      traex: { user: [], project: [] },
      pi: {
        user: ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'SYSTEM.md', 'APPEND_SYSTEM.md'],
        project: ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', '.pi/SYSTEM.md', '.pi/APPEND_SYSTEM.md'],
      },
    };
    const fixed = ctx.layout?.ruleFiles[source.scope] ?? fixedByBackend[ctx.backendId]?.[source.scope] ?? [];
    for (const relative of fixed) {
      const absolute = path.resolve(source.root, relative);
      try { await lstat(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; diagnostics.push(`Cannot inspect rule ${relative}: ${errMessage(error)}`); continue; }
      let data: { content: string; symlink: boolean };
      try { data = await readCandidate(absolute, source.root); } catch (error) { diagnostics.push(`Cannot read rule ${relative}: ${errMessage(error)}`); continue; }
      const symlink = data.symlink || await hasSymlinkAncestor(source.root, absolute);
      await addDocumentItem({ source, absolute, relative, kind: 'rule', name: path.basename(relative), ownerPluginId: ownerFor(source, relative), content: data.content, symlink });
    }
    for (const directory of markdownDirectories(ctx, source, 'rule')) {
      await scanMarkdownKind(source, 'rule', directory, isMarkdown);
    }
  };

  const scanJsonResources = async (): Promise<void> => {
    for (const file of configFiles) {
      if (file.descriptor.language !== 'json') continue;
      let parsed: unknown;
      try { parsed = JSON.parse(file.content); }
      catch { diagnostics.push(`Invalid JSON extension config: ${file.descriptor.path}`); continue; }
      if (!record(parsed)) continue;
      const mcpValue = parsed.mcpServers ?? parsed.mcp_servers ?? (file.kind === 'mcp' ? parsed.servers : undefined);
      if (record(mcpValue)) {
        for (const [nativeId, config] of Object.entries(mcpValue)) {
          if (!record(config)) { diagnostics.push(`MCP server “${nativeId}” is not a JSON object in ${file.descriptor.path}`); continue; }
          const enabled = typeof config.enabled === 'boolean' ? config.enabled : typeof config.disabled === 'boolean' ? !config.disabled : undefined;
          const id = itemId(file.descriptor.scope, 'mcp', file.descriptor.absolutePath, nativeId);
          const item: ExtensionItem = {
            id, kind: 'mcp', name: normalizeItemName(text(config.name) ?? nativeId),
            ...(text(config.description) ? { description: redactSensitiveText(text(config.description)!).slice(0, 1000) } : {}),
            scope: file.descriptor.scope, sourcePath: file.descriptor.path,
            ...(ownerFor(file.source, file.relative) ? { ownerPluginId: ownerFor(file.source, file.relative) } : {}),
            nativeId, ...(enabled === undefined ? {} : { enabled }), runtimeState: 'unknown',
            ...(file.descriptor.reason ? { readOnlyReason: file.descriptor.reason } : {}), documentId: file.descriptor.id,
          };
          addItem(item, [file.descriptor]);
        }
      }
      const hookMap = record(parsed.hooks) ? parsed.hooks : ctx.backendId === 'droid' && file.kind === 'hook' ? parsed : undefined;
      if (record(hookMap)) {
        for (const [event, value] of Object.entries(hookMap)) {
          const hooks = Array.isArray(value) ? value : record(value) && Array.isArray(value.hooks) ? value.hooks : undefined;
          if (!hooks) { diagnostics.push(`Hook event “${event}” is not an array in ${file.descriptor.path}`); continue; }
          hooks.forEach((hook, index) => {
            const hookRecord = record(hook) ? hook : {};
            const nativeId = `${event}:${index}`;
            const id = itemId(file.descriptor.scope, 'hook', file.descriptor.absolutePath, nativeId);
            const item: ExtensionItem = {
              id, kind: 'hook', name: `${event} · ${index + 1}`,
              ...(text(hookRecord.name) ? { description: redactSensitiveText(text(hookRecord.name)!).slice(0, 1000) } : {}),
              scope: file.descriptor.scope, sourcePath: file.descriptor.path,
              ...(ownerFor(file.source, file.relative) ? { ownerPluginId: ownerFor(file.source, file.relative) } : {}),
              nativeId, ...(typeof hookRecord.enabled === 'boolean' ? { enabled: hookRecord.enabled } : {}),
              runtimeState: 'unknown', ...(file.descriptor.reason ? { readOnlyReason: file.descriptor.reason } : {}), documentId: file.descriptor.id,
            };
            addItem(item, [file.descriptor]);
          });
        }
      }
      const enabledPlugins = parsed.enabledPlugins ?? parsed.plugins;
      if (record(enabledPlugins)) {
        for (const [nativeId, state] of Object.entries(enabledPlugins)) {
          const enabled = typeof state === 'boolean' ? state : record(state) && typeof state.enabled === 'boolean' ? state.enabled : undefined;
          const id = itemId(file.descriptor.scope, 'plugin', file.descriptor.absolutePath, nativeId);
          addItem({ id, kind: 'plugin', name: normalizeItemName(nativeId), scope: file.descriptor.scope, sourcePath: file.descriptor.path, nativeId, ...(enabled === undefined ? {} : { enabled }), runtimeState: 'unknown', ...(file.descriptor.reason ? { readOnlyReason: file.descriptor.reason } : {}), documentId: file.descriptor.id }, [file.descriptor]);
        }
      }
    }
  };

  const scanPluginConfigFiles = async (source: SourceRoot): Promise<void> => {
    const rootReal = await resolveRealRoot(source.root).catch(() => undefined);
    for (const plugin of pluginRoots.filter(item => item.source === source)) {
      const relativeRoot = path.relative(source.root, plugin.root).split(path.sep).join('/');
      for (const file of await scanFiles(source, relativeRoot, base => ['hooks.json', 'mcp.json', '.mcp.json'].includes(base), diagnostics, 2, rootReal)) {
        let data: { content: string; symlink: boolean };
        try { const read = await readCandidate(file.absolute, source.root, rootReal, !file.symlink); data = { content: read.content, symlink: read.symlink }; }
        catch (error) { diagnostics.push(`Cannot read plugin extension config ${displayPath(source.root, file.absolute, source.scope)}: ${errMessage(error)}`); continue; }
        const kind: ExtensionKind = path.basename(file.absolute) === 'hooks.json' ? 'hook' : 'mcp';
        const descriptor = addDoc(source, file.absolute, file.relative, kind, data.symlink);
        configFiles.push({ source, absolute: file.absolute, relative: file.relative, descriptor, kind, content: data.content });
        const id = itemId(descriptor.scope, 'config', descriptor.absolutePath, kind);
        const configItem: ExtensionItem = {
          id, kind: 'config', name: path.basename(file.absolute), scope: descriptor.scope,
          sourcePath: descriptor.path, ownerPluginId: plugin.itemId, runtimeState: 'unknown',
          ...(descriptor.reason ? { readOnlyReason: descriptor.reason } : {}), documentId: descriptor.id,
        };
        descriptor.itemId = id;
        addItem(configItem, [descriptor]);
      }
    }
  };

  for (const source of sources) {
    await scanConfig(source);
    await scanPlugins(source);
    await scanPiExtensions(source);
  }
  if (ctx.backendId === 'codex' || ctx.backendId === 'traex') {
    for (const file of configFiles.filter(item => ['config.toml', 'traecli.toml'].includes(path.basename(item.absolute)))) {
      for (const kind of ['mcp', 'hook'] as const) {
        const nativeId = `${kind}:config.toml`;
        const id = itemId(file.descriptor.scope, kind, file.descriptor.absolutePath, nativeId);
        addItem({ id, kind, name: `${kind === 'mcp' ? 'MCP' : 'Hooks'} · ${path.basename(file.absolute)}`, description: '此视图提供 TOML 配置文件；具体条目请查看原生运行状态。', scope: file.descriptor.scope, sourcePath: file.descriptor.path, runtimeState: 'unknown', ...(file.descriptor.reason ? { readOnlyReason: file.descriptor.reason } : {}), documentId: file.descriptor.id }, [file.descriptor]);
        diagnostics.push(`${file.descriptor.path} 以 TOML 原文编辑，不解析具体条目；MCP 和 Hook 条目可在有在线会话时查询原生目录。`);
      }
    }
  }
  // Scan component files only after plugin manifests are known so each component can link to its owner.
  for (const source of sources) {
    for (const directory of markdownDirectories(ctx, source, 'skill')) await scanMarkdownKind(source, 'skill', directory, isSkill);
    await addKnownRuleFiles(source);
    for (const directory of markdownDirectories(ctx, source, 'command')) await scanMarkdownKind(source, 'command', directory, name => /\.md$/i.test(name));
    for (const plugin of pluginRoots.filter(item => item.source === source)) {
      const relative = path.relative(source.root, plugin.root);
      for (const directory of ['skills', 'commands', 'rules']) {
        await scanMarkdownKind(source, directory === 'skills' ? 'skill' : directory === 'commands' ? 'command' : 'rule', path.posix.join(relative.split(path.sep).join('/'), directory), directory === 'skills' ? isSkill : directory === 'commands' ? name => /\.md$/i.test(name) : isMarkdown);
      }
    }
  }
  for (const source of sources) await scanPluginConfigFiles(source);
  await scanJsonResources();

  for (const item of items.values()) {
    if (!item.ownerPluginId || !item.documentId) continue;
    const owner = details.get(item.ownerPluginId);
    const component = docs.get(item.documentId);
    if (!owner || !component) continue;
    const files = new Map(owner.files.map(file => [file.id, file]));
    files.set(component.id, { id: component.id, path: component.path, editable: component.editable, ...(component.reason ? { reason: component.reason } : {}) });
    details.set(owner.item.id, { ...owner, files: [...files.values()] });
  }

  for (const source of sources) {
    for (const target of createTargetList(ctx, source)) {
      if (target.fileName) {
        const absolute = path.resolve(source.root, target.directory, target.fileName);
        try { await lstat(absolute); continue; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') {
            diagnostics.push(`Cannot inspect create target ${displayPath(source.root, absolute, source.scope)}: ${errMessage(error)}`);
            continue;
          }
        }
      }
      createTargets.set(target.id, { contract: target, root: source.root });
    }
  }

  if (skillSettings) diagnostics.push(...skillSettings.diagnostics);
  for (const { item, document } of riffetSkillEntries(ctx)) {
    docs.set(document.id, document);
    addItem(item, [document]);
  }
  // An isolated launch reads the project's own files whatever scope they were filed under (a linked skill is
  // `managed`), and nothing of the owner's: what it does not read is not listed, opened or written from here.
  const projectRoots = new Set(sources.filter(source => source.scope === 'project').map(source => source.root));
  const read = (scope: ExtensionScope, root?: string) => scopeInEffect(ctx, scope) || (root !== undefined && projectRoots.has(root));
  for (const [id, item] of items) if (!read(item.scope, item.documentId ? docs.get(item.documentId)?.root : undefined)) { items.delete(id); details.delete(id); }
  for (const [id, document] of docs) if (!read(document.scope, document.root)) docs.delete(id);
  for (const [id, target] of createTargets) if (!scopeInEffect(ctx, target.contract.scope)) createTargets.delete(id);
  const inventory = {
    backendId: ctx.backendId,
    profileId: ctx.profile.id,
    items: [...items.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'en') || a.id.localeCompare(b.id)),
    diagnostics: [...new Set(diagnostics)].slice(0, 400),
    createTargets: [...createTargets.values()].map(value => value.contract),
    checkedAt: new Date().toISOString(),
  };
  return { inventory, items, details, documents: docs, createTargets };
}
