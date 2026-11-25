import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_BUDGET } from '../../../../packages/contracts/src/index.js';
import { stateDirectoryOwner } from '../compat.js';
import { STARTUP_PHASES, startupPhaseOf, type StartupPhase } from '../server-log.js';
import { COMPACTION_WAIT_MS, compactionRunning } from '../storage/compaction.js';
import { active, pidExists, type DaemonRecord } from './context.js';
import { CliError, err, tilde, type Spinner } from './ui.js';

/*
 * Waiting for a server to come up. A server writes daemon.json only once it listens, which on a large
 * state directory can take many seconds; until then it holds server.lock and reports its start-up
 * phases in server.log. Whoever waits (start, restart, stop, service install) follows that log, so a slow
 * start shows where it is and only a server that exited or stopped making progress counts as failed.
 */

/** Holds server.lock and runs `serve`, but has not written daemon.json yet. Callers check `active` first. */
export interface StartingServer { pid: number; since: number }

export function startingServer(dir: string): StartingServer | undefined {
  const pid = stateDirectoryOwner(dir);
  if (!pid) return undefined;
  // Offline plugin and storage commands take the same lock; only `serve` becomes a server.
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (ps.status !== 0 || !/\sserve(?:\s|$)/.test(ps.stdout)) return undefined;
  const since = statSync(join(dir, 'server.lock'), { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
  return { pid, since };
}

export const logSize = (log: string): number => statSync(log, { throwIfNoEntry: false })?.size ?? 0;

/** The tail a newly attached reader starts from; enough for the start-up lines of a server started moments ago. */
const ATTACH_WINDOW_BYTES = 256 * 1024;

/** Reads whole lines a server appends to its log; a rotation that shrank the file starts over at its beginning. */
class LogFollower {
  private partial = '';
  constructor(private readonly path: string, private offset: number) {}

  read(): string[] {
    let fd: number;
    try { fd = openSync(this.path, 'r'); } catch { return []; }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) { this.offset = 0; this.partial = ''; }
      if (size === this.offset) return [];
      const buffer = Buffer.alloc(size - this.offset);
      const read = readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += read;
      const lines = (this.partial + buffer.subarray(0, read).toString('utf8')).split('\n');
      this.partial = lines.pop() ?? '';
      return lines.filter(Boolean);
    } finally { closeSync(fd); }
  }
}

/** A log line's stamp (`stampServerOutput`), in milliseconds. */
const stampedAt = (line: string): number => Date.parse(line.slice(0, line.indexOf(' ')));

/** The phase a server that began at `since` last reported, read from the end of its log. */
export function currentStartupPhase(log: string, since: number): StartupPhase | undefined {
  let phase: StartupPhase | undefined;
  for (const line of new LogFollower(log, Math.max(0, logSize(log) - ATTACH_WINDOW_BYTES)).read()) {
    if (stampedAt(line) >= since - 1000) phase = startupPhaseOf(line) ?? phase;
  }
  return phase;
}

export const phaseLabel = (phase: StartupPhase | undefined): string => (phase ? STARTUP_PHASES[phase] : 'launching');

/** The server is still running but no longer making progress; it is left running. */
export class StartupStalled extends CliError {
  constructor(readonly summary: string, quoted: string) {
    super(`${summary}; it is still running${quoted}`, ['riffet logs -f', 'riffet stop']);
  }
}

export interface StartupWatch {
  dir: string;
  pid: number;
  /** When the server was launched; lines stamped before it belong to an earlier server. */
  since: number;
  /** The log offset to read from: its size at launch, or `undefined` to look back for a server started earlier. */
  offset?: number;
  /** The launched child's exit code, `null` while it runs; without it, the PID is watched. */
  exitCode?: () => number | null;
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const LOG_LINES_SHOWN = 12;

/**
 * Resolves to the server once it answers. Fails when the process exits, or when it logs nothing new for
 * `SERVER_BUDGET.startupStallMs`; a stuck server is left running so its state can be read. A compaction the
 * settings page asked for runs before the service listens: it counts as progress, up to its own limit.
 */
export async function waitForStartup(initial: StartupWatch, progress: Spinner): Promise<DaemonRecord> {
  let watch = initial;
  const log = join(watch.dir, 'server.log');
  const follower = new LogFollower(log, watch.offset ?? Math.max(0, logSize(log) - ATTACH_WINDOW_BYTES));
  const own: string[] = [];
  const began = Date.now();
  let phase: StartupPhase | undefined, compacting = false, progressAt = began;
  const show = () => progress.update(compacting ? 'Compacting the database before Riffet starts; this can take several minutes' : `Starting Riffet · ${phaseLabel(phase)}`);
  show();
  for (;;) {
    const record = await active(watch.dir);
    if (record) return record;
    for (const line of follower.read()) {
      if (watch.offset === undefined && stampedAt(line) < watch.since - 1000) continue;
      own.push(line); if (own.length > LOG_LINES_SHOWN) own.shift();
      phase = startupPhaseOf(line) ?? phase;
      progressAt = Date.now();
    }
    compacting = compactionRunning(watch.dir);
    if (compacting) progressAt = Date.now();
    show();
    const code = watch.exitCode?.();
    const exited = code !== undefined ? code !== null : !pidExists(watch.pid);
    // Two launches can race before either holds the lock; the one that lost exits, and the winner is the server.
    const winner = exited ? startingServer(watch.dir) : undefined;
    if (winner && winner.pid !== watch.pid) {
      watch = { dir: watch.dir, pid: winner.pid, since: watch.since, offset: watch.offset };
      progressAt = Date.now();
    } else if (exited) {
      // Its last words may land between the check above and the exit.
      for (const line of follower.read()) { own.push(line); if (own.length > LOG_LINES_SHOWN) own.shift(); }
      const how = code !== undefined && code !== null ? ` (exit code ${code})` : '';
      throw new CliError(`Riffet exited while ${phaseLabel(phase)}${how}${quote(own)}`, [`riffet logs  ${err.dim('(full log: ' + tilde(log) + ')')}`, 'riffet doctor']);
    }
    const quiet = Date.now() - progressAt;
    if (compacting ? Date.now() - began > COMPACTION_WAIT_MS : quiet > SERVER_BUDGET.startupStallMs) {
      throw new StartupStalled(`Riffet (pid ${watch.pid}) has logged nothing for ${Math.round(quiet / 1000)}s while ${phaseLabel(phase)}`, quote(own));
    }
    await sleep(150);
  }
}

const quote = (lines: string[]): string => (lines.length ? '\n' + err.dim(redactToken(lines.join('\n')).split('\n').map(line => '│ ' + line).join('\n')) : '');

export const redactToken = (text: string): string => text.replace(/([?&]token=)[^\s&#]+/g, '$1[REDACTED]');
