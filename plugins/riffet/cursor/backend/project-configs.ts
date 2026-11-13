import { createHash } from 'node:crypto';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConfigFile } from '@contracts';
import {
  AppError, MAX_CONFIG_DOCUMENT_BYTES, assertWithin, atomicWriteConfigDocument, hashConfigContent as hash, isWithin, projectDirectory as projectRoot,
  readConfigDocumentBytes as readConfigBytes, redactConfigDocument as redactConfig, resolveScopedPath, restoreConfigDocumentSecrets as mergeRedactedContent,
} from '@riffet/plugin-api/kit';

type ProjectRef = { cwd: string };

const MAX_CONFIG_BYTES = MAX_CONFIG_DOCUMENT_BYTES;

interface ConfigDescriptor { id: string; label: string; relativePath: string; path: string; displayPath: string; scope: ConfigFile['scope']; kind: ConfigFile['kind']; root: string; writable: boolean; }
interface ConfigResult extends ConfigDescriptor { exists: boolean; content?: string; hash?: string; }

function configId(scope: ConfigFile['scope'], kind: ConfigFile['kind'], visiblePath: string): string {
  return createHash('sha256').update(`${scope}\0${kind}\0${visiblePath}`).digest('hex').slice(0, 32);
}

/**
 * The files cursor-agent reads its rules, skills, commands, MCP servers and hooks from, in a project (`.cursor/*`)
 * and in the user's Cursor directory (read-only). A config's id hashes its scope, kind and visible path, so a
 * descriptor is found again from the id alone.
 */
export class CursorProjectConfigs {
  constructor(private readonly stateDir: string, private readonly userRoot: string) {}

  private makeDescriptor(scope: ConfigFile['scope'], kind: ConfigFile['kind'], root: string, relativePath: string, writable: boolean): ConfigDescriptor {
    const absolutePath = path.resolve(root, relativePath);
    const relativeToHome = path.relative(path.resolve(os.homedir()), absolutePath);
    const userPath = isWithin(path.resolve(os.homedir()), absolutePath) ? `~/${relativeToHome.split(path.sep).join('/')}` : absolutePath;
    const visiblePath = scope === 'project' ? relativePath.split(path.sep).join('/') : userPath;
    return {
      id: configId(scope, kind, visiblePath),
      label: path.basename(relativePath) || kind,
      relativePath,
      path: absolutePath,
      displayPath: scope === 'project' ? relativePath.split(path.sep).join('/') : userPath,
      scope,
      kind,
      root,
      writable,
    };
  }

  private async scanFiles(root: string, relativeDir: string, matches: (name: string, relative: string) => boolean, maxDepth = 4): Promise<string[]> {
    const result: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > maxDepth || result.length >= 200) return;
      const names = await readdir(dir, { withFileTypes: true }).catch(() => []);
      names.sort((a, b) => a.name.localeCompare(b.name, 'en'));
      for (const entry of names) {
        if (result.length >= 200 || entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        const relative = path.relative(root, full);
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.isFile() && matches(entry.name, relative)) result.push(relative);
      }
    };
    const start = path.resolve(root, relativeDir);
    try {
      const realRoot = await realpath(root);
      const realStart = await realpath(start);
      assertWithin(realRoot, realStart);
    } catch { return result; }
    await walk(start, 0);
    return result;
  }

  private async descriptors(project: ProjectRef): Promise<ConfigDescriptor[]> {
    const root = await projectRoot(project);
    const userConfig = this.userRoot;
    const values: ConfigDescriptor[] = [];
    const add = (scope: ConfigFile['scope'], kind: ConfigFile['kind'], base: string, relative: string, writable = scope === 'project') => {
      values.push(this.makeDescriptor(scope, kind, base, relative, writable));
    };
    const addScanned = async (scope: ConfigFile['scope'], kind: ConfigFile['kind'], base: string, dir: string, matcher: (name: string, relative: string) => boolean) => {
      for (const file of await this.scanFiles(base, dir, matcher)) add(scope, kind, base, file);
    };

    add('project', 'rules', root, '.cursorrules');
    await addScanned('project', 'rules', root, '.cursor/rules', name => /\.(?:mdc|md)$/i.test(name));
    await addScanned('project', 'skills', root, '.cursor/skills', name => name === 'SKILL.md');
    await addScanned('project', 'skills', root, '.agents/skills', name => name === 'SKILL.md');
    await addScanned('project', 'commands', root, '.cursor/commands', name => /\.md$/i.test(name));
    add('project', 'mcp', root, '.cursor/mcp.json');
    add('project', 'hooks', root, '.cursor/hooks.json');
    add('project', 'hooks', root, path.join('.cursor', 'hooks', 'hooks.json'));
    add('project', 'cli', root, path.join('.cursor', 'cli.json'));
    add('project', 'worktrees', root, path.join('.cursor', 'worktrees.json'));

    add('user', 'mcp', userConfig, 'mcp.json', false);
    add('user', 'hooks', userConfig, 'hooks.json', false);
    add('user', 'hooks', userConfig, path.join('hooks', 'hooks.json'), false);
    add('user', 'cli', userConfig, 'cli-config.json', false);
    add('user', 'cli', userConfig, 'cli.json', false);
    add('user', 'worktrees', userConfig, 'worktrees.json', false);
    await addScanned('user', 'rules', userConfig, 'rules', name => /\.(?:mdc|md)$/i.test(name));
    await addScanned('user', 'skills', userConfig, 'skills', name => name === 'SKILL.md');
    await addScanned('user', 'commands', userConfig, 'commands', name => /\.md$/i.test(name));

    const unique = new Map<string, ConfigDescriptor>();
    for (const item of values) unique.set(item.id, item);
    return [...unique.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path));
  }

  private async descriptorResult(descriptor: ConfigDescriptor): Promise<ConfigResult> {
    let exists = false;
    let content: string | undefined;
    let contentHash: string | undefined;
    try {
      const target = await realpath(descriptor.path);
      const root = await realpath(descriptor.root);
      assertWithin(root, target);
      const info = await stat(target);
      if (!info.isFile()) return { ...descriptor, exists: false };
      if (info.size > MAX_CONFIG_BYTES) throw new AppError('CONFIG_TOO_LARGE', 'Config exceeds the 1 MB read limit', 413, { path: descriptor.path });
      const raw = (await readConfigBytes(target)).toString('utf8');
      exists = true;
      content = redactConfig(raw);
      contentHash = hash(raw);
    } catch (error) {
      if (error instanceof AppError) throw error;
    }
    return { ...descriptor, exists, ...(content === undefined ? {} : { content }), ...(contentHash === undefined ? {} : { hash: contentHash }) };
  }

  /** The Cursor config files of the project and of the user's Cursor directory. */
  async list(project: ProjectRef): Promise<ConfigFile[]> {
    const list = await this.descriptors(project);
    const result: ConfigFile[] = [];
    for (const item of list) {
      const entry = await this.descriptorResult(item);
      result.push({ id: entry.id, label: entry.label, path: entry.scope === 'project' ? path.relative(item.root, item.path).split(path.sep).join('/') : entry.displayPath, scope: entry.scope, kind: entry.kind, exists: entry.exists });
    }
    return result;
  }

  private async findDescriptor(project: ProjectRef, id: string): Promise<ConfigDescriptor> {
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new AppError('CONFIG_NOT_FOUND', 'Config does not exist', 404);
    const descriptor = (await this.descriptors(project)).find(item => item.id === id);
    if (!descriptor) throw new AppError('CONFIG_NOT_FOUND', 'Config does not exist for this project', 404);
    return descriptor;
  }

  async read(project: ProjectRef, id: string): Promise<ConfigFile> {
    const descriptor = await this.findDescriptor(project, id);
    const result = await this.descriptorResult(descriptor);
    const content = result.content ?? '';
    return { id: descriptor.id, label: descriptor.label, path: descriptor.scope === 'project' ? path.relative(descriptor.root, descriptor.path).split(path.sep).join('/') : descriptor.displayPath, scope: descriptor.scope, kind: descriptor.kind, exists: result.exists, content, hash: result.hash ?? hash('') };
  }

  private async atomicConfigWrite(descriptor: ConfigDescriptor, content: string, previous: Buffer | undefined, expectedHash: string): Promise<void> {
    await atomicWriteConfigDocument({ stateDir: this.stateDir, root: descriptor.root, filePath: descriptor.path, content, previous, expectedHash, maxBytes: MAX_CONFIG_BYTES });
  }

  async write(project: ProjectRef, id: string, content: string, expectedHash: string): Promise<ConfigFile> {
    const descriptor = await this.findDescriptor(project, id);
    if (!descriptor.writable || descriptor.scope !== 'project') throw new AppError('CONFIG_READ_ONLY', 'User-level Cursor config files are read-only', 403);
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_CONFIG_BYTES) throw new AppError('INVALID_CONFIG', 'Config content is invalid or exceeds the 1 MB limit', 413);
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new AppError('EXPECTED_HASH_REQUIRED', 'A SHA-256 expectedHash is required');
    const target = await resolveScopedPath(descriptor.root, path.relative(descriptor.root, descriptor.path), true);
    let previous: Buffer | undefined;
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new AppError('CONFIG_SYMLINK_UNSUPPORTED', 'Config symlinks cannot be edited', 409);
      if (!info.isFile() || info.size > MAX_CONFIG_BYTES) throw new AppError('CONFIG_TOO_LARGE', 'Config file cannot be edited safely', 413);
      previous = await readConfigBytes(target);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const actualHash = hash(previous ?? Buffer.alloc(0));
    if (actualHash !== expectedHash) throw new AppError('CONFIG_CONFLICT', 'Config changed since it was read; reload before editing', 409, { expectedHash, actualHash });
    let safeContent = content;
    if (previous) safeContent = mergeRedactedContent(previous.toString('utf8'), content);
    await this.atomicConfigWrite(descriptor, safeContent, previous, expectedHash);
    return this.read(project, id);
  }

  async create(project: ProjectRef, input: { kind: ConfigFile['kind']; path: string; content: string }): Promise<ConfigFile> {
    const root = await projectRoot(project);
    if (!input || !['rules', 'skills', 'commands'].includes(input.kind) || typeof input.path !== 'string' || input.path.length > 1024 || typeof input.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > MAX_CONFIG_BYTES) {
      throw new AppError('INVALID_CONFIG', 'A rules, skills, or commands config path and content are required');
    }
    const relativePath = input.path.replace(/\\/g, '/');
    const segments = relativePath.split('/');
    if (relativePath.startsWith('/') || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\0'))) throw new AppError('INVALID_CONFIG_PATH', 'Config path must be a normalized project-relative path');
    const validPath = input.kind === 'rules'
      ? relativePath === '.cursorrules' || /^\.cursor\/rules\/(?:[^/]+\/){0,4}[^/]+\.(?:mdc|md)$/i.test(relativePath)
      : input.kind === 'skills'
        ? /^(?:\.cursor|\.agents)\/skills\/(?:[^/]+\/){1,4}SKILL\.md$/.test(relativePath)
        : /^\.cursor\/commands\/(?:[^/]+\/){0,4}[^/]+\.md$/i.test(relativePath);
    if (!validPath) throw new AppError('INVALID_CONFIG_PATH', 'Config path does not match the selected config kind');
    const target = await resolveScopedPath(root, relativePath, true);
    try { await lstat(target); throw new AppError('CONFIG_EXISTS', 'Config already exists; reload it before editing', 409); }
    catch (error) { if (error instanceof AppError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const descriptor = this.makeDescriptor('project', input.kind, root, relativePath.split('/').join(path.sep), true);
    await this.atomicConfigWrite(descriptor, input.content, undefined, hash(''));
    return this.read(project, descriptor.id);
  }
}
