import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Whether `pid` names a running process of this user. EPERM means another user's process took the
 * number: every CLI Riffet hands a conversation to runs as the user the service runs as.
 */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * When each process started, as `ps` prints it in UTC (`Wed Nov 11 12:49:16 2026`, the form Claude Code
 * records as `procStart`), keyed by pid; missing for
 * one that is gone. With a pid it was told about earlier, this tells that process from a later one
 * reusing the number. `undefined` when `ps` could not be asked: nothing is known then, and a caller
 * guarding a single writer has to assume the process is still there.
 */
export async function processStarts(pids: readonly number[]): Promise<Map<number, string> | undefined> {
  const starts = new Map<number, string>();
  const wanted = [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  if (!wanted.length) return starts;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ps', ['-o', 'pid=,lstart=', '-p', wanted.join(',')], { timeout: 2_000, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } }));
  } catch (error) {
    // `ps` exits 1 when none of them runs; a timeout or a failed spawn says nothing about them.
    const failure = error as { code?: unknown; stdout?: unknown };
    if (failure.code !== 1) return undefined;
    stdout = typeof failure.stdout === 'string' ? failure.stdout : '';
  }
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) starts.set(Number(match[1]), match[2]!.replace(/\s+/g, ' '));
  }
  return starts;
}

/** Two `ps lstart` renderings of one moment, whatever the spacing. */
export function sameStart(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b) && a!.replace(/\s+/g, ' ').trim() === b!.replace(/\s+/g, ' ').trim();
}
