import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuildInfo } from '../../../../packages/contracts/src/index.js';
import { stablePath } from '../update/npm.js';
import { CliError } from './ui.js';

/*
 * What every command knows about the installation: the state directory, the server running on it and
 * how to reach that server. Nothing here starts or stops anything.
 */

export const DEFAULT_STATE_DIR = join(homedir(), '.local/share/riffet');
export const DEFAULT_PORT = '4337';
export const DEFAULT_HOST = '127.0.0.1';

/**
 * The file the server process runs. Bundled, everything is in `dist/cli.js`; from source it is
 * `apps/server/src/cli.ts`, one level up from this module. A pnpm global install is reached through its
 * `node_modules/riffet` link rather than the versioned store, so what it starts survives an update.
 */
export const entry = import.meta.url.endsWith('.ts')
  ? resolve(dirname(fileURLToPath(import.meta.url)), '../cli.ts')
  : stablePath(fileURLToPath(import.meta.url));

/** The checkout or package root: `dist/..` when bundled, `apps/server/src/../../..` from source. */
export const installRoot = entry.endsWith('.ts') ? resolve(dirname(entry), '../../..') : resolve(dirname(entry), '..');

export interface DaemonRecord { pid: number; port: number; host: string; instanceId: string; startedAt: string; args: string[] }
export interface Health { ok?: boolean; version?: string; build?: BuildInfo; instanceId?: string; managedBy?: 'cli' | 'launchd' | 'app' | string }

export function stateDir(path: string): string {
  const dir = resolve(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readDaemon(dir: string): DaemonRecord | undefined {
  try { return JSON.parse(readFileSync(join(dir, 'daemon.json'), 'utf8')) as DaemonRecord; } catch { return undefined; }
}

export function pidExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The PID still runs this CLI's `serve`, not an unrelated process that inherited the number. */
export function ownsPid(record: DaemonRecord): boolean {
  if (!pidExists(record.pid)) return false;
  const ps = spawnSync('ps', ['-p', String(record.pid), '-o', 'command='], { encoding: 'utf8' });
  return ps.status === 0 && ps.stdout.includes(entry) && ps.stdout.includes('serve');
}

export const isLoopback = (host: string): boolean => ['127.0.0.1', 'localhost', '::1'].includes(host.replace(/^\[|\]$/g, '').toLowerCase());
export const isWildcard = (host: string): boolean => ['0.0.0.0', '::'].includes(host);

/** How this machine reaches the server: a wildcard listener is reached on loopback. */
export function serverUrl(record: Pick<DaemonRecord, 'host' | 'port'>): string {
  const host = isWildcard(record.host) ? '127.0.0.1' : record.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${record.port}`;
}

export async function health(record: DaemonRecord, timeoutMs = 1500): Promise<Health | undefined> {
  try {
    const response = await fetch(serverUrl(record) + '/health', { signal: AbortSignal.timeout(timeoutMs) });
    return await response.json() as Health;
  } catch { return undefined; }
}

/** The server running on this state directory, if any: it answers as the recorded instance, or its PID still runs `serve`. */
export async function active(dir: string): Promise<DaemonRecord | undefined> {
  const record = readDaemon(dir);
  if (!record || !pidExists(record.pid)) return undefined;
  if ((await health(record))?.instanceId === record.instanceId) return record;
  return ownsPid(record) ? record : undefined;
}

export async function requireActive(dir: string): Promise<DaemonRecord> {
  const record = await active(dir);
  if (!record) throw new CliError('Riffet is not running', ['riffet start']);
  return record;
}

export function accessToken(dir: string): string {
  const file = join(dir, 'access-token');
  let value = '';
  try { value = readFileSync(file, 'utf8').trim(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new CliError(`Could not read the access token at ${file}: ${(error as Error).message}`);
  }
  if (!value) throw new CliError('No access token yet; it is created the first time Riffet starts', ['riffet start']);
  return value;
}

export const APP_MANAGED_HINT = 'Stop or restart it in Riffet.app → Settings → Server';
export const APP_AGENT_LABEL = 'io.github.riffable.mac.server';

/** Riffet.app's own login service is registered (it may be running a server on the same state directory). */
export function appAgentLoaded(): boolean {
  return process.platform === 'darwin' && spawnSync('launchctl', ['print', `gui/${process.getuid!()}/${APP_AGENT_LABEL}`], { stdio: 'ignore' }).status === 0;
}

export const managerLabel = (manager: string | undefined): string | undefined =>
  manager === 'app' ? 'Riffet.app' : manager === 'launchd' ? 'login service' : manager === 'cli' ? 'riffet start' : manager;
