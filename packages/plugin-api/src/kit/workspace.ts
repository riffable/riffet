import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from './errors.js';

/** The project's directory, resolved: absolute, existing, a directory. */
export async function projectDirectory(project: { cwd: string } | string): Promise<string> {
  const cwd = typeof project === 'string' ? project : project.cwd;
  if (!path.isAbsolute(cwd)) throw new AppError('INVALID_PROJECT_PATH', 'Project path must be absolute');
  let root: string;
  try {
    root = await realpath(cwd);
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new AppError('PROJECT_PATH_UNAVAILABLE', 'Project directory is unavailable', 404);
  }
  return root;
}

export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function assertWithin(root: string, target: string, code = 'PATH_OUTSIDE_PROJECT'): void {
  if (!isWithin(root, target)) throw new AppError(code, 'Path must stay inside the project directory', 403);
}

/** Resolve an API-supplied path while checking both lexical traversal and existing symlinks. */
export async function resolveScopedPath(root: string, input: string, allowRoot = false): Promise<string> {
  if (typeof input !== 'string' || input.includes('\0')) throw new AppError('INVALID_PATH', 'Path is invalid');
  if (!input && !allowRoot) throw new AppError('INVALID_PATH', 'Path is required');
  const target = path.resolve(root, input || '.');
  assertWithin(root, target, 'INVALID_PATH');

  let probe = target;
  while (true) {
    try {
      const resolved = await realpath(probe);
      assertWithin(root, resolved);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
        const parent = path.dirname(probe);
        if (parent === probe) throw new AppError('INVALID_PATH', 'Path has no existing project parent');
        probe = parent;
        continue;
      }
      if (error instanceof AppError) throw error;
      throw new AppError('INVALID_PATH', 'Path cannot be accessed', 400);
    }
  }

  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      const resolved = await realpath(target);
      assertWithin(root, resolved);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  return target;
}
