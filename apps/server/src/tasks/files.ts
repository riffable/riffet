import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DiagnosticsContext, ProjectContext } from '@riffet/plugin-api';
import { AppError } from '../errors.js';
import { isWithin, resolveReadablePath, resolveScopedPath } from '../workspace/scope.js';

const MAX_READ_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 5000;
const MAX_ARTIFACTS = 20;
const MAX_GLOBS = 20;
const MAX_WALK_ENTRIES = 50_000;
const MAX_WALK_DEPTH = 16;
/** Never searched through `**`: a dependency or tool cache, not project output. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.gradle', '.idea']);

const MISSING = new Set(['ENOENT', 'ENOTDIR']);
const missing = (error: unknown): boolean => MISSING.has((error as NodeJS.ErrnoException).code ?? '');

/** The project as a provider sees it: every path is relative and is resolved against the real root with the workbench's own scope checks. */
export function projectContext(project: { id: string; name: string }, root: string, stateDir: string): ProjectContext {
  return {
    id: project.id,
    name: project.name,
    async exists(relPath) {
      const target = await resolveScopedPath(root, relPath, true);
      return stat(target).then(() => true, () => false);
    },
    async readText(relPath, maxBytes) {
      const target = await resolveReadablePath(root, relPath, false, [stateDir]);
      let handle;
      try { handle = await open(target, 'r'); } catch (error) { if (missing(error) || (error as NodeJS.ErrnoException).code === 'EISDIR') return undefined; throw error; }
      try {
        const info = await handle.stat();
        if (!info.isFile()) return undefined;
        const buffer = Buffer.alloc(Math.max(0, Math.min(Math.floor(maxBytes) || 0, MAX_READ_BYTES, info.size)));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.toString('utf8', 0, bytesRead);
      } finally { await handle.close(); }
    },
    async list(relDir) {
      const target = await resolveScopedPath(root, relDir, true);
      const names: string[] = [];
      try {
        for await (const entry of await opendir(target)) { names.push(entry.name); if (names.length >= MAX_LIST_ENTRIES) break; }
      } catch (error) { if (missing(error)) return []; throw error; }
      return names;
    },
  };
}

/** Maps a path from a log onto the project without saying where the project is. Textual: a log's paths are what the process saw, which began at the real root. */
export function diagnosticsContext(roots: readonly string[]): DiagnosticsContext {
  return {
    relativize(value) {
      if (typeof value !== 'string' || !value || value.includes('\0')) return undefined;
      if (!path.isAbsolute(value)) {
        const normal = path.posix.normalize(value.replaceAll('\\', '/'));
        return normal === '.' || normal === '..' || normal.startsWith('../') ? undefined : normal;
      }
      for (const root of roots) {
        if (!isWithin(root, value) || path.resolve(value) === root) continue;
        return path.relative(root, path.resolve(value)).split(path.sep).join('/');
      }
      return undefined;
    },
  };
}

const invalid = (message: string): AppError => new AppError('TASK_PLAN_INVALID', message, 502);

/** The working directory a plan names, as a real directory inside the project. */
export async function resolveWorkingDirectory(root: string, relative: string | undefined): Promise<string> {
  if (relative !== undefined && (typeof relative !== 'string' || path.isAbsolute(relative))) throw invalid('The plan\'s cwd must be a project-relative path');
  let target: string;
  try {
    target = await realpath(await resolveScopedPath(root, relative ?? '', true));
    if (!isWithin(root, target)) throw new Error('outside');
    if (!(await stat(target)).isDirectory()) throw new Error('not a directory');
  } catch { throw invalid('The plan\'s cwd is not a directory inside the project'); }
  return target;
}

/** A bare command (looked up on PATH) or `./path` inside the project; the shell is never involved in finding it. */
export async function checkCommand(root: string, cwd: string, file: unknown): Promise<string> {
  if (typeof file !== 'string' || !file || file.length > 256 || /[\0\n\r]/.test(file) || file.startsWith('-') || path.isAbsolute(file) || file.split('/').includes('..')) throw invalid('The plan\'s file must be a command name or a ./path inside the project');
  if (!file.includes('/')) return file;
  if (!file.startsWith('./')) throw invalid('The plan\'s file must be a command name or a ./path inside the project');
  try {
    const real = await realpath(path.resolve(cwd, file));
    if (!isWithin(root, real)) throw new Error('outside');
  } catch (error) {
    // A command that is not there fails when it runs, with the shell's own message in the log.
    if (!missing(error)) throw invalid('The plan\'s file leaves the project');
  }
  return file;
}

const GLOB_SEGMENT = /^[^\0\\/]+$/;

/** Project-relative globs of `*`, `?` and `**`; nothing absolute and no `..`. */
export function checkGlobs(globs: unknown): string[] {
  if (globs === undefined) return [];
  if (!Array.isArray(globs) || globs.length > MAX_GLOBS) throw invalid('The plan\'s artifacts must be a short list of globs');
  for (const glob of globs) {
    if (typeof glob !== 'string' || !glob || glob.length > 200 || !glob.split('/').every(part => GLOB_SEGMENT.test(part) && part !== '.' && part !== '..')) throw invalid('An artifact glob must be project-relative without . or .. segments');
  }
  return [...new Set(globs as string[])];
}

const segmentPattern = (segment: string): RegExp | undefined => segment.includes('*') || segment.includes('?')
  ? new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '[^/]*').replace(/\?/g, '[^/]')}$`, 's')
  : undefined;

export interface ArtifactFile { path: string; absolute: string; name: string; size: number; mtimeMs: number; sha256: string }

/**
 * The regular files `globs` match under `root`: found by walking the project, never by following a
 * link, then each confirmed with its real path. Bounded in entries read, depth and results, so an
 * odd pattern cannot make the server scan a disk.
 */
export async function expandArtifacts(root: string, globs: readonly string[]): Promise<ArtifactFile[]> {
  const found = new Map<string, string>();
  let budget = MAX_WALK_ENTRIES;
  for (const glob of globs) {
    const segments = glob.split('/');
    const visit = async (directory: string, relative: string, index: number, depth: number): Promise<void> => {
      if (found.size >= MAX_ARTIFACTS || budget <= 0 || index >= segments.length) return;
      const segment = segments[index]!;
      if (segment === '**') {
        await visit(directory, relative, index + 1, depth);
        if (depth >= MAX_WALK_DEPTH) return;
        // `**/build/outputs/*`: a `build` directory is where the pattern continues, not somewhere to search again.
        const next = segments[index + 1];
        let entries;
        try { entries = await opendir(directory); } catch { return; }
        for await (const entry of entries) {
          if (--budget <= 0) break;
          if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name) || entry.name === next) continue;
          await visit(path.join(directory, entry.name), relative + entry.name + '/', index, depth + 1);
        }
        return;
      }
      const last = index === segments.length - 1;
      const pattern = segmentPattern(segment);
      let names: string[];
      if (!pattern) names = [segment];
      else {
        names = [];
        try { for await (const entry of await opendir(directory)) { if (--budget <= 0) break; if (pattern.test(entry.name)) names.push(entry.name); } } catch { return; }
      }
      for (const name of names.sort()) {
        const absolute = path.join(directory, name);
        let info;
        try { info = await lstat(absolute); } catch { continue; }
        if (last) { if (info.isFile()) found.set(relative + name, absolute); }
        else if (info.isDirectory() && depth < MAX_WALK_DEPTH) await visit(absolute, relative + name + '/', index + 1, depth + 1);
      }
    };
    await visit(root, '', 0, 0);
  }
  const files: ArtifactFile[] = [];
  for (const [relative, candidate] of [...found].sort(([a], [b]) => a.localeCompare(b)).slice(0, MAX_ARTIFACTS)) {
    try {
      const real = await realpath(candidate);
      if (!isWithin(root, real)) continue;
      const info = await stat(real);
      if (!info.isFile()) continue;
      files.push({ path: relative, absolute: real, name: path.basename(relative), size: info.size, mtimeMs: info.mtimeMs, sha256: await hashFile(real) });
    } catch { /* gone since it was found: not an artifact */ }
  }
  return files;
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
