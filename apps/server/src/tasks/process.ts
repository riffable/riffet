import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { constants } from 'node:os';

/**
 * Runs `"$@"` and records its exit code in `$1` by rename, so a reader sees all of it or none. The
 * trap keeps the wrapper alive when the process group is signalled: it waits for the command to
 * finish, which is what makes "the exit file exists" mean "the command has exited". A trap with a
 * command (unlike an ignore) is reset in the command, so it still receives the signal.
 */
const WRAPPER = `trap : TERM INT HUP
exit_file=$1; shift
"$@"
code=$?
printf '%s\\n' "$code" > "$exit_file.tmp" && mv -f "$exit_file.tmp" "$exit_file"
`;

export interface SpawnRequest { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; logPath: string; exitPath: string }

/**
 * Starts the command in its own process group with stdout and stderr on the log file itself: no
 * pipe to this server, so the output survives its restart and the process never blocks on it.
 */
export function spawnTask(request: SpawnRequest): ChildProcess {
  const log = openSync(request.logPath, 'a', 0o600);
  try {
    const child = spawn('/bin/sh', ['-c', WRAPPER, 'riffet-task', request.exitPath, request.file, ...request.args], {
      cwd: request.cwd, env: request.env, detached: true, stdio: ['ignore', log, log],
    });
    child.unref();
    return child;
  } finally { closeSync(log); }
}

/** The exit code in `exitPath`, once the wrapper has written it. */
export async function readExitCode(exitPath: string): Promise<number | undefined> {
  let text: string;
  try { text = await readFile(exitPath, 'utf8'); } catch { return undefined; }
  return /^\d{1,3}\s*$/.test(text) ? Number(text.trim()) : undefined;
}

/** The exit code a shell reports for a process killed by `signal`. */
export function signalExitCode(signal: NodeJS.Signals | null): number | undefined {
  const number = signal ? constants.signals[signal] : undefined;
  return number === undefined ? undefined : 128 + number;
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** When the process began, as `ps` prints it: with the pid, what tells this process from a later one that reused the id. */
export function processStart(pid: number): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 }, (error, stdout) => {
      const start = error ? undefined : stdout.trim();
      resolve(start || undefined);
    });
  });
}

export interface ProcessIdentity { pid: number; pgid: number; start?: string }

/** `other` is a live process that cannot be shown to be the task's: it is never signalled. */
export async function identify(identity: ProcessIdentity | undefined): Promise<'same' | 'gone' | 'other'> {
  if (!identity || !isAlive(identity.pid)) return 'gone';
  if (!identity.start) return 'other';
  const start = await processStart(identity.pid);
  if (start === undefined) return 'gone';
  return start === identity.start ? 'same' : 'other';
}

/** Signals the task's whole process group: the command and everything it started. */
export function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') console.warn(`[riffet] signalling task process group ${pgid} failed:`, error); }
}
