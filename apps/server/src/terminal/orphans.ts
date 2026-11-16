import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { exec } from '../exec.js';

/**
 * Markers a Riffet tmux server carries on its command line (docs/guide/performance.md §3.10): the state
 * directory it serves and the process that started it. tmux keeps the argv of the command that started
 * the server, so `ps` shows them for as long as the server lives.
 */
export const TMUX_STATE_DIR_OPTION = '@riffet-state-dir';
export const TMUX_OWNER_PID_OPTION = '@riffet-owner-pid';

/** What only a Riffet terminal service starts its tmux server with. */
const SIGNATURE = /\bstart-server\b.*\bset-option -g remain-on-exit on\b/;

export interface TmuxServerProcess {
  pid: number;
  /** Seconds since it started. */
  ageSec: number;
  socket: string;
  stateDir?: string;
  ownerPid?: number;
}

export interface OrphanSweepOptions {
  /** The calling service's own socket: never touched. */
  ownSocket?: string;
  /** A server younger than this is left alone; it may be starting up for a test or a probe. */
  graceMs: number;
  /** Lists servers without ending any. */
  dryRun?: boolean;
}

/**
 * Ends the Riffet tmux servers nobody can reach again, with the CLIs in their panes. A server is kept
 * while anything still owns it: a client attached to its socket, the process that started or last
 * claimed it (`claimTmuxServer`), or the service holding its state directory's `server.lock`. Of the
 * rest, one is ended when:
 *
 * - its socket is gone: no client can ever attach again (a test removed its temp directory, say);
 * - its state directory is gone;
 * - its state directory is in the system temp directory. A temp instance is a test, a probe or a demo;
 *   nothing comes back for it.
 *
 * A server whose state directory is anywhere else stays while its socket does: a service restarting
 * there adopts it. Servers started before the markers existed are judged by their socket alone, plus,
 * for a socket inside a temp state directory that holds a workbench database, the absence of clients.
 */
export async function sweepOrphanTmuxServers(options: OrphanSweepOptions): Promise<TmuxServerProcess[]> {
  if (process.platform === 'win32') return [];
  const { servers, attached } = await listRiffetTmux();
  const temps = tempRoots();
  const own = options.ownSocket ? canonical(options.ownSocket) : undefined;
  const ended: TmuxServerProcess[] = [];
  for (const server of servers) {
    // A server that has just started may be one a test or a probe is still setting up; so may a short-lived
    // client starting a session, which `ps` lists with the same command line.
    if (!(server.ageSec * 1000 >= options.graceMs) || (own && canonical(server.socket) === own)) continue;
    if (attached.has(canonical(server.socket)) || !await unreachable(server, temps)) continue;
    if (!options.dryRun) {
      try { process.kill(server.pid, 'SIGTERM'); }
      catch { continue; }
    }
    ended.push(server);
  }
  return ended;
}

/**
 * Restates the markers on a server this service adopted from an earlier instance: its argv names the
 * process that started it, which may be long gone (docs/guide/performance.md §3.10).
 */
export function claimTmuxServerCommands(stateDir: string): string[] {
  return ['set-option', '-g', TMUX_STATE_DIR_OPTION, stateDir, ';', 'set-option', '-g', TMUX_OWNER_PID_OPTION, String(process.pid)];
}

async function unreachable(server: TmuxServerProcess, temps: readonly string[]): Promise<boolean> {
  const socketGone = !existsSync(server.socket);
  // What the server says now wins over its argv: a service that adopted it restated them.
  const current = socketGone ? {} : await serverMarkers(server.socket);
  const stateDir = current.stateDir ?? server.stateDir, ownerPid = current.ownerPid ?? server.ownerPid;
  if (alive(ownerPid) || alive(lockHolder(stateDir ?? dirname(server.socket)))) return false;
  if (socketGone) return true;
  if (stateDir) return !existsSync(stateDir) || inside(stateDir, temps);
  // Before the markers: only `<state dir>/tmux.sock` inside a temp directory says whose it was.
  const legacyDir = dirname(server.socket);
  if (!inside(legacyDir, temps) || !existsSync(join(legacyDir, 'workbench.db'))) return false;
  const clients = await exec('tmux', ['-S', server.socket, 'list-clients', '-F', '#{client_pid}'], { timeout: 2000 }).catch(() => undefined);
  return clients !== undefined && !clients.stdout.trim();
}

async function serverMarkers(socket: string): Promise<{ stateDir?: string; ownerPid?: number }> {
  const read = async (option: string) => (await exec('tmux', ['-S', socket, 'show-options', '-gqv', option], { timeout: 2000 }).catch(() => undefined))?.stdout.trim() || undefined;
  const [stateDir, owner] = await Promise.all([read(TMUX_STATE_DIR_OPTION), read(TMUX_OWNER_PID_OPTION)]);
  const ownerPid = Number(owner);
  return { ...(stateDir ? { stateDir } : {}), ...(ownerPid > 0 ? { ownerPid } : {}) };
}

/** Riffet tmux servers of this user, as `ps` lists them. */
export async function listRiffetTmuxServers(): Promise<TmuxServerProcess[]> {
  return (await listRiffetTmux()).servers;
}

/** Riffet tmux servers of this user, and the sockets a client process is attached to. */
async function listRiffetTmux(): Promise<{ servers: TmuxServerProcess[]; attached: Set<string> }> {
  const servers: TmuxServerProcess[] = [], attached = new Set<string>();
  // perf-rules: allow a one-off read of `ps`'s full command lines (a tmux server's runs to kilobytes), not a resident buffer
  const listed = await exec('ps', ['-A', '-ww', '-o', 'pid=,ppid=,uid=,etime=,command='], { timeout: 3000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }).catch(() => undefined);
  if (!listed) return { servers, attached };
  const uid = process.getuid?.();
  for (const line of listed.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match || (uid !== undefined && Number(match[3]) !== uid)) continue;
    const command = match[5]!;
    // A service's control client is its child; one whose service died is left to init and attaches nobody.
    const client = /^tmux -S (.+?) -C attach-session\b/.exec(command);
    if (client) { if (Number(match[2]) > 1) attached.add(canonical(client[1]!)); continue; }
    // A server shows the argv of the command that started it, `start-server` first.
    const head = /^tmux -S (.+?) start-server ;/.exec(command);
    if (!head || !SIGNATURE.test(command)) continue;
    const stateDir = new RegExp(`; set-option -g ${TMUX_STATE_DIR_OPTION} (.+?) ;`).exec(command)?.[1];
    const ownerPid = Number(new RegExp(`; set-option -g ${TMUX_OWNER_PID_OPTION} (\\d+) ;`).exec(command)?.[1]);
    servers.push({ pid: Number(match[1]), ageSec: elapsedSeconds(match[4]!), socket: head[1]!, ...(stateDir ? { stateDir } : {}), ...(ownerPid > 0 ? { ownerPid } : {}) });
  }
  return { servers, attached };
}

/** `ps`'s `[[dd-]hh:]mm:ss`. */
function elapsedSeconds(value: string): number {
  const [days, clock] = value.includes('-') ? value.split('-') as [string, string] : ['0', value];
  return clock.split(':').map(Number).reduce((total, part) => total * 60 + part, 0) + Number(days) * 86_400;
}

function lockHolder(stateDir: string): number | undefined {
  try { return Number(readFileSync(join(stateDir, 'server.lock'), 'utf8')) || undefined; } catch { return undefined; }
}

function alive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The system temp directory and `/tmp`, each by both of its paths (macOS links `/tmp` to `/private/tmp`). */
export function tempRoots(): string[] {
  const roots = [tmpdir(), '/tmp'].filter(root => existsSync(root));
  return [...new Set(roots.flatMap(root => [root, canonical(root)]))];
}

/** Whether a state directory is a temp instance's: a test's, a probe's or a demo's (docs/guide/performance.md §3.10). */
export function isTempStateDir(stateDir: string): boolean { return inside(stateDir, tempRoots()); }

/** Whether `path` lies inside one of `roots`, by either of its paths. */
export function inside(path: string, roots: readonly string[]): boolean {
  const paths = [path, canonical(path)];
  return roots.some(root => paths.some(candidate => candidate.startsWith(root.endsWith(sep) ? root : root + sep)));
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch {
    // A socket or directory that is gone: canonicalise what is left of it.
    try { return join(realpathSync(dirname(path)), path.slice(dirname(path).length + 1)); } catch { return path; }
  }
}
