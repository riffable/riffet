import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

// The pure PATH helpers of the daemon's environment module (apps/server/src/environment.ts); the
// login-shell capture and scrubbing stay in the core.

/** Directories that belong to the running node install: global npm packages commonly live there. */
export function nodeDirectories(executablePath = process.execPath): string[] {
  const bin = dirname(executablePath);
  const prefix = dirname(bin);
  const directories = [bin];
  // A version-managed node (`~/.nvm/versions/node/v22/bin/node`) keeps global bins in the same
  // directory as the binary, so `bin` already covers it. A stock prefix additionally exposes
  // `<prefix>/bin`; Windows keeps global shims in `<prefix>` itself.
  if (process.platform === 'win32') directories.push(prefix, join(prefix, 'node_modules', '.bin'));
  else directories.push(join(prefix, 'bin'), join(homedir(), '.local', 'bin'));
  return directories;
}

/** Drop empty and duplicate entries while preserving order. */
export function mergePath(entries: Array<string | undefined>, sep = delimiter): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    for (const part of entry.split(sep)) {
      const value = part.trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      merged.push(value);
    }
  }
  return merged.join(sep);
}

export function pathEntries(value: string | undefined, sep = delimiter): string[] {
  return (value ?? '').split(sep).map(entry => entry.trim()).filter(Boolean);
}

/** True when a directory is on PATH and executable, used by the CLI resolver's diagnostics. */
export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform === 'win32') return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Expand a leading `~` so a configured executable behaves like every other path in settings. */
export function expandHome(value: string, home = homedir()): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return resolve(join(home, value.slice(2)));
  return value;
}
