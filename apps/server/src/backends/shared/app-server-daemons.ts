import { readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { runProcess } from '../../git/exec.js';
import { loopbackPort, stopProcessGroup } from './codex-app-server.js';

/** A private socket directory or token file younger than this may belong to a spawn still under way. */
const ARTIFACT_GRACE_MS = 10 * 60_000;
const SOCKET_DIR_PREFIX = 'cw-cx-';

/**
 * An app-server some workbench process spawned: `CodexAppServer.start()` runs it `detached`, so its
 * process group is its own and outlives the server that started it.
 */
export interface WorkbenchAppServer {
  /** The process group the spawn created; signalling it also reaches the native child of a wrapper. */
  pgid: number;
  /** A live member of the group as listed: the leader may have exited while its native child serves. */
  pid: number;
  ppid: number;
  /** The address sessions store as `nativeRuntime.address`; absent once a Unix socket is gone. */
  address?: string;
  /** What `CodexAppServer.dispose()` removes for its own spawn. */
  directory?: string;
  tokenFile?: string;
  /** The spawning service's `setAppServerOwner` tag; absent on spawns from before tags existed. */
  owner?: string;
}

interface Row { pid: number; ppid: number; pgid: number; uid: number; command: string }

/**
 * Lists them from `ps`. Only listeners this workbench can have started count: a Unix socket in a
 * `cw-cx-*` directory under the temp dir, or a loopback listener whose token file is in one of the
 * credential directories. An app-server the user runs themselves never matches either.
 */
export async function listWorkbenchAppServers(credentialDirs: readonly string[]): Promise<WorkbenchAppServer[]> {
  const table = await processTable();
  if (!table) return [];
  return await appServersIn(table.rows, credentialDirs);
}

/**
 * Ends the app-server at a session's stored address. `dispose()` can only end what its own client
 * spawned or verified; this covers a daemon an earlier service instance left behind, which a
 * conversation that is archived or deleted before anyone reopens it still owns. A no-op when nothing
 * listens there any more.
 */
export async function stopWorkbenchAppServerAt(address: string, credentialDirs: readonly string[]): Promise<boolean> {
  const target = (await listWorkbenchAppServers(credentialDirs)).find(server => server.address === address);
  if (!target) return false;
  await stopWorkbenchAppServer(target);
  return true;
}

export interface AppServerSweep {
  stopped: WorkbenchAppServer[];
  /** The workbench app-servers still running after the sweep. */
  live: WorkbenchAppServer[];
  removedArtifacts: number;
}

export interface AppServerSweepScope {
  /** This service's owner tag: an orphan carrying it and bound to nothing here is unreachable. */
  owner?: string;
  /** Bindings of this store's conversations that are not archived: always kept. */
  bound: ReadonlySet<string>;
  /** Bindings of archived conversations: unreachable whoever spawned them. */
  archived: ReadonlySet<string>;
}

/**
 * Ends the app-servers no conversation can reach again and removes leftover socket directories and
 * token files.
 *
 * Only orphans are considered: a daemon whose parent is still alive belongs to a running service
 * whose binding may not be written yet. One a running TUI names with `--remote` is in use. Of the
 * rest, only what this service can prove is its own goes — its owner tag, or a binding of one of its
 * archived conversations — since another workbench instance on this machine binds its daemons in a
 * store this one cannot read.
 */
export async function sweepWorkbenchAppServers(scope: AppServerSweepScope, credentialDirs: readonly string[]): Promise<AppServerSweep> {
  const table = await processTable();
  if (!table) return { stopped: [], live: [], removedArtifacts: 0 };
  const servers = await appServersIn(table.rows, credentialDirs);
  const remotes = await remoteAddresses(table.rows);
  const stopped: WorkbenchAppServer[] = [];
  for (const server of servers) {
    if (server.ppid !== 1) continue;
    if (server.address && (scope.bound.has(server.address) || remotes.has(server.address))) continue;
    const ours = (scope.owner !== undefined && server.owner === scope.owner) || Boolean(server.address && scope.archived.has(server.address));
    if (!ours) continue;
    try { await stopWorkbenchAppServer(server); stopped.push(server); }
    catch { /* the next sweep retries */ }
  }
  const live = servers.filter(server => !stopped.includes(server));
  // By name: the temp dir is reachable through two paths, and a command line may use either.
  const liveDirectories = new Set(live.flatMap(server => server.directory ? [basename(server.directory)] : []));
  const liveTokens = new Set(live.flatMap(server => server.tokenFile ? [basename(server.tokenFile)] : []));
  let removedArtifacts = 0;
  const remove = async (path: string, name: string, liveNames: Set<string>) => {
    if (liveNames.has(name) || table.commands.includes(name) || !await stale(path)) return;
    await rm(path, { recursive: true, force: true }).then(() => { removedArtifacts++; }, () => undefined);
  };
  const temp = tmpdir();
  for (const name of await readdir(temp).catch(() => [] as string[])) {
    if (name.startsWith(SOCKET_DIR_PREFIX)) await remove(join(temp, name), name, liveDirectories);
  }
  for (const root of await credentialRoots(credentialDirs)) {
    for (const name of await readdir(root).catch(() => [] as string[])) {
      if (name.endsWith('.token')) await remove(join(root, name), name, liveTokens);
    }
  }
  return { stopped, live, removedArtifacts };
}

async function stopWorkbenchAppServer(server: WorkbenchAppServer): Promise<void> {
  await stopProcessGroup(server.pgid);
  if (server.directory) await rm(server.directory, { recursive: true, force: true }).catch(() => undefined);
  if (server.tokenFile) await rm(server.tokenFile, { force: true }).catch(() => undefined);
}

async function processTable(): Promise<{ rows: Row[]; commands: string } | undefined> {
  if (process.platform === 'win32') return undefined;
  const result = await runProcess('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,uid=,command='], { cwd: process.cwd(), timeoutMs: 3000, env: { ...process.env, LC_ALL: 'C' } });
  if (result.code !== 0 || result.timedOut) return undefined;
  const uid = process.getuid?.();
  const rows: Row[] = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const row = { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), uid: Number(match[4]), command: match[5]! };
    if (uid === undefined || row.uid === uid) rows.push(row);
  }
  return { rows, commands: rows.map(row => row.command).join('\n') };
}

async function appServersIn(rows: readonly Row[], credentialDirs: readonly string[]): Promise<WorkbenchAppServer[]> {
  const temps = new Set(await tempRoots());
  const credentials = await credentialRoots(credentialDirs);
  const found = new Map<number, WorkbenchAppServer>();
  for (const row of rows) {
    // A wrapper and its native child share the group; either may be the one still alive.
    if (found.has(row.pgid) || row.pgid <= 1 || !/(?:^|\s)app-server(?:\s|$)/.test(row.command)) continue;
    const listen = flag(row.command, '--listen');
    if (listen?.startsWith('unix://')) {
      const socketPath = listen.slice('unix://'.length), directory = dirname(socketPath);
      if (basename(socketPath) !== 's' || !basename(directory).startsWith(SOCKET_DIR_PREFIX) || !temps.has(dirname(directory))) continue;
      const canonical = await realpath(socketPath).catch(() => undefined);
      const owner = /^cw-cx-([0-9a-f]{12})-/.exec(basename(directory))?.[1];
      found.set(row.pgid, { pgid: row.pgid, pid: row.pid, ppid: row.ppid, directory, ...(canonical ? { address: `unix://${canonical}` } : {}), ...(owner ? { owner } : {}) });
    } else if (listen && loopbackPort(listen) !== undefined) {
      const named = flag(row.command, '--ws-token-file');
      const tokenFile = named ? await realpath(named).catch(() => undefined) : undefined;
      if (!tokenFile || !credentials.some(root => dirname(tokenFile) === root)) continue;
      const owner = /^([0-9a-f]{12})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.token$/.exec(basename(tokenFile))?.[1];
      found.set(row.pgid, { pgid: row.pgid, pid: row.pid, ppid: row.ppid, tokenFile, address: `ws://127.0.0.1:${loopbackPort(listen)}`, ...(owner ? { owner } : {}) });
    }
  }
  return [...found.values()];
}

/** Endpoints running TUIs are attached to, in the canonical form sessions store. */
async function remoteAddresses(rows: readonly Row[]): Promise<Set<string>> {
  const addresses = new Set<string>();
  for (const row of rows) {
    const remote = flag(row.command, '--remote');
    if (!remote) continue;
    if (remote.startsWith('unix://')) {
      const canonical = await realpath(remote.slice('unix://'.length)).catch(() => undefined);
      if (canonical) addresses.add(`unix://${canonical}`);
    } else {
      const port = loopbackPort(remote);
      if (port !== undefined) addresses.add(`ws://127.0.0.1:${port}`);
    }
  }
  return addresses;
}

/** The value after a flag in a `ps` command line; the paths compared here never contain spaces. */
function flag(command: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}(?:=|\\s+)(\\S+)`).exec(command);
  return match?.[1];
}

/** `tmpdir()` as spawned (`/var/folders/…`) and resolved (`/private/var/folders/…`). */
async function tempRoots(): Promise<string[]> {
  const root = tmpdir();
  return [...new Set([root, await realpath(root).catch(() => root)])];
}

async function credentialRoots(credentialDirs: readonly string[]): Promise<string[]> {
  return (await Promise.all(credentialDirs.map(dir => realpath(dir).catch(() => undefined)))).filter((dir): dir is string => Boolean(dir));
}

async function stale(path: string): Promise<boolean> {
  const details = await stat(path).catch(() => undefined);
  return Boolean(details && Date.now() - details.mtimeMs > ARTIFACT_GRACE_MS);
}
