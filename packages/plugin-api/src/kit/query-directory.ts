import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Project } from '@riffet/contracts';
import { AppError } from './errors.js';

/** A CLI management read needs a cwd, but must not borrow a task or the last selected project. */
export async function queryDirectory(project: Pick<Project, 'cwd'> | undefined, profile: { backendId: string; id: string }): Promise<string> {
  if (project) return project.cwd;
  const cache = process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches')
    : process.env.XDG_CACHE_HOME?.startsWith('/') ? process.env.XDG_CACHE_HOME : join(homedir(), '.cache');
  const identity = createHash('sha256').update(JSON.stringify([profile.backendId, profile.id])).digest('hex').slice(0, 24);
  const directory = join(cache, 'riffet', 'queries', identity);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // realpath can restore an existing name's case (e.g. Riffet on macOS). Check the
  // components themselves for symlinks rather than treating every spelling change as one.
  for (let current = directory; ; current = dirname(current)) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new AppError('NATIVE_QUERY_DIRECTORY_UNAVAILABLE', 'The native catalog directory is unavailable', 503);
    }
    if (dirname(current) === current) break;
  }
  return await realpath(directory);
}
