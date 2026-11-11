import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from './errors.js';

/** Two rolled 2 MB app logs plus headroom; anything larger is not a log this client wrote. */
export const CLIENT_LOG_MAX_BYTES = 6 * 1024 * 1024;
const KEEP = 20;

/**
 * Logs a client uploaded for debugging, kept on the machine that runs the server so whoever is
 * debugging can read them in place instead of having the user export and forward a file.
 */
export class ClientLogs {
  constructor(readonly dir: string, private readonly keep = KEEP) {}

  async save(name: unknown, content: unknown): Promise<{ path: string; bytes: number }> {
    if (typeof content !== 'string' || !content.length) throw new AppError('INVALID_LOG', 'Log content is required');
    const bytes = Buffer.byteLength(content);
    if (bytes > CLIENT_LOG_MAX_BYTES) throw new AppError('LOG_TOO_LARGE', 'Log is larger than 6 MB', 413);
    const label = typeof name === 'string' ? name.replace(/\.txt$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 80) : '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (let copy = 0; ; copy += 1) {
      const path = join(this.dir, `${stamp}${copy ? `-${copy}` : ''}${label ? `_${label}` : ''}.txt`);
      try {
        await writeFile(path, content, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST' && copy < 100) continue;
        throw error;
      }
      await this.prune();
      return { path, bytes };
    }
  }

  /** Names start with an ISO stamp, so name order is age order. */
  private async prune(): Promise<void> {
    const files = (await readdir(this.dir)).filter((file) => file.endsWith('.txt')).sort();
    for (const file of files.slice(0, Math.max(0, files.length - this.keep))) await rm(join(this.dir, file), { force: true });
  }
}
