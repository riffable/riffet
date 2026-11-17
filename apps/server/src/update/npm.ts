import type { BuildInfo, UpdateCheck } from '@contracts';
import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareReleaseTags, parseReleaseTag } from './git.js';

/**
 * Whether this program was installed from the npm package: the published manifest next to dist/
 * is not private, unlike a checkout's and the App payload's. Under tsx it resolves to nothing.
 */
export function isNpmInstall(from: URL = new URL('../package.json', import.meta.url)): boolean {
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(from), 'utf8')) as { name?: unknown; private?: unknown };
    return manifest.name === 'riffet' && manifest.private !== true;
  } catch { return false; }
}

/**
 * Release check for an npm install, which has no Git clone to inspect. The registry only names a
 * version, so `latest` stays null rather than inventing a commit and `latestVersion` carries it.
 */
export async function checkNpmUpdate(current: BuildInfo): Promise<UpdateCheck> {
  try {
    const response = await fetch('https://registry.npmjs.org/riffet/latest', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    const version = response.ok ? (await response.json() as { version?: unknown }).version : undefined;
    // Only a stable x.y.z goes any further; anything else from the network is dropped.
    if (typeof version !== 'string' || !parseReleaseTag(`v${version}`)) throw new Error('Unexpected registry response.');
    // A prerelease or local version is not something the registry's release can be ordered against.
    if (!parseReleaseTag(`v${current.version}`)) return { status: 'development', current, latest: null, source: null, latestVersion: version };
    const order = compareReleaseTags(`v${current.version}`, `v${version}`);
    return { status: order < 0 ? 'available' : order > 0 ? 'ahead' : 'current', current, latest: null, source: null, latestVersion: version };
  } catch {
    return { status: 'unavailable', current, latest: null, source: null, message: 'Could not reach the npm registry from this computer.' };
  }
}

/**
 * The path to `real` (a file in this package, symlinks resolved) that still leads to the installed version
 * after an update. pnpm keeps each version in its own store directory
 * (`…/node_modules/.pnpm/riffet@0.7.0/node_modules/riffet`) and points `…/node_modules/riffet` at the
 * current one; a server, a login service or a restart started from the store path would run the old
 * version, or a directory pnpm has pruned. Other managers replace the package in place.
 */
export function stablePath(real: string): string {
  const marker = `${sep}node_modules${sep}.pnpm${sep}`;
  const at = real.indexOf(marker);
  if (at < 0) return real;
  const rest = real.slice(at + marker.length).split(sep); // riffet@0.7.0, node_modules, riffet, dist, cli.js
  if (rest[1] !== 'node_modules' || rest[2] !== 'riffet') return real;
  const candidate = join(real.slice(0, at), 'node_modules', ...rest.slice(2));
  try { return realpathSync(candidate) === real ? candidate : real; } catch { return real; }
}

/** The package manager that owns a global install, and the command that replaces it with `version`. */
export interface NpmInstaller { manager: 'npm' | 'pnpm' | 'bun' | 'yarn'; command: string; args: string[]; root: string; writable: boolean }

/**
 * Which tool installed this package globally, read off where it lives: pnpm, bun and Yarn keep their
 * global packages in directories of their own; anything else is npm's (`<prefix>/lib/node_modules`).
 */
export function npmInstaller(version: string, from: URL = new URL('..', import.meta.url)): NpmInstaller {
  const real = realpathSync(fileURLToPath(from)).replace(/[\\/]$/, '');
  const root = stablePath(real);
  const spec = `riffet@${version}`;
  const parts = real.split(sep);
  const manager: NpmInstaller['manager'] = parts.includes('pnpm') || parts.some(part => part.startsWith('.pnpm')) ? 'pnpm'
    : parts.includes('.bun') ? 'bun'
    : parts.includes('.yarn') || parts.includes('yarn') ? 'yarn'
    : 'npm';
  const args = manager === 'npm' ? ['install', '-g', spec] : manager === 'pnpm' ? ['add', '-g', spec] : manager === 'bun' ? ['add', '-g', spec] : ['global', 'add', spec];
  // The package directory and the directory holding it are replaced; both have to be writable.
  // `root` is where the next version will be found, so a restart runs `root/dist/cli.js`.
  let writable = true;
  try { accessSync(root, constants.W_OK); accessSync(dirname(root), constants.W_OK); } catch { writable = false; }
  return { manager, command: manager, args, root, writable };
}
