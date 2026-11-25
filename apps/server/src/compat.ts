import { closeSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** DSH's isolated profile home, beside the other state Riffet keeps in the user's home. */
export const DEFAULT_DSH_CONFIG_DIR = join(homedir(), '.riffet', 'dsh');

/** `server.lock` is held: by a live process (`pid`), or by none that can be trusted (an interrupted write, no `pid`). */
export class StateDirectoryBusy extends Error {
  constructor(readonly pid?: number) {
    super(pid ? `This state directory is in use by another Riffet process (pid ${pid})` : 'The state directory lock has no valid owner; inspect server.lock before retrying');
    this.name = 'StateDirectoryBusy';
  }
}

/** The live process holding `server.lock`, if one does; read without claiming. */
export function stateDirectoryOwner(stateDir: string): number | undefined {
  let owner: number;
  try { owner = Number(readFileSync(join(stateDir, 'server.lock'), 'utf8')); } catch { return undefined; }
  if (!Number.isSafeInteger(owner) || owner < 1 || owner === process.pid) return undefined;
  try { process.kill(owner, 0); return owner; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' ? owner : undefined; }
}

/** Shared by the daemon and one-off storage migrations; a stopped owner's lock is recoverable. */
export function claimStateDirectory(stateDir: string): () => void {
  const path = join(stateDir, 'server.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return () => { try { if (Number(readFileSync(path, 'utf8')) === process.pid) unlinkSync(path); } catch { /* already released */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number(readFileSync(path, 'utf8'));
      // The daemon claims the state before createApp invokes the migration. Do not release its lock.
      if (owner === process.pid) return () => undefined;
      if (Number.isSafeInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(path); continue; } throw error; }
        throw new StateDirectoryBusy(owner);
      }
      // An interrupted lock write has no trustworthy owner. Leave it for inspection.
      throw new StateDirectoryBusy();
    }
  }
  throw new Error('Could not claim the state directory');
}

/**
 * Adopt the old plugin paths before any reader can create empty replacements. Each sibling rename
 * is atomic; an interruption between the two moves resumes on the next call. Existing destinations
 * are never merged or overwritten. The same server lock keeps an older running daemon from writing
 * a new legacy file while an offline CLI or doctor is migrating it.
 */
export function migratePluginStorage(stateDir: string): void {
  const paths = [
    { old: 'integrations.json', current: 'plugins.json', directory: false },
    { old: 'integrations', current: 'plugin-data', directory: true },
  ];
  const info = (path: string) => lstatSync(path, { throwIfNoEntry: false });
  if (!paths.some(item => info(join(stateDir, item.old)))) return;
  const release = claimStateDirectory(stateDir);
  try {
    const pending = paths.filter(item => info(join(stateDir, item.old)));
    // Check both pairs before moving either: an existing destination may contain independent data.
    for (const item of pending) {
      const source = join(stateDir, item.old), target = join(stateDir, item.current);
      const sourceInfo = info(source)!;
      if (sourceInfo.isSymbolicLink() || !(item.directory ? sourceInfo.isDirectory() : sourceInfo.isFile())) {
        throw new Error('Cannot migrate plugin storage: ' + source + ' is not a regular ' + (item.directory ? 'directory' : 'file'));
      }
      if (info(target)) throw new Error('Cannot migrate plugin storage: both ' + source + ' and ' + target + ' exist; resolve the conflict before restarting');
    }
    for (const item of pending) renameSync(join(stateDir, item.old), join(stateDir, item.current));
  } finally { release(); }
}
