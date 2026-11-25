import { chmodSync, copyFileSync, fstatSync, ftruncateSync, renameSync, statSync } from 'node:fs';

/** Past this the log moves to `server.log.1`, replacing the previous one: two files at most. */
const LOG_LIMIT_BYTES = 10 * 1024 * 1024;
const LOG_CHECK_MS = 60_000;

/*
 * Serve mode's log is its stdout and stderr, opened for append by whoever launched it (`riffet
 * start`, launchd, systemd, the App's launcher). None of them timestamps or rotates it, so the
 * process does both itself.
 */

/** Stamps everything the process prints from here on, unless it prints to a terminal. */
export function stampServerOutput(): void {
  for (const stream of [process.stdout, process.stderr]) if (!stream.isTTY) stampLines(stream);
}

/** Keeps `path` under the size limit, now and then; only for the process that owns the state directory. */
export function rotateServerLog(path: string): void {
  // A terminal, or output redirected somewhere else, is not this process's file to truncate.
  const fd = [1, 2].find(fd => sameFile(fd, path));
  if (fd === undefined) return;
  try { chmodSync(path, 0o600); } catch { /* the size limit still applies */ }
  const timer = setInterval(() => { if (!rotate(fd, path)) clearInterval(timer); }, LOG_CHECK_MS);
  timer.unref();
  if (!rotate(fd, path)) clearInterval(timer);
}

/** Every line starts with the time it was written; a write that ends mid-line is continued unstamped. */
function stampLines(stream: NodeJS.WriteStream): void {
  const write = stream.write.bind(stream) as (chunk: string, callback?: (error?: Error | null) => void) => boolean;
  let lineStart = true;
  stream.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    const text = typeof chunk !== 'string' ? Buffer.from(chunk).toString() : typeof encoding === 'string' ? Buffer.from(chunk, encoding).toString() : chunk;
    const at = new Date().toISOString();
    const stamped = text.split('\n').map((line, index) => line && (index || lineStart) ? `${at} ${line}` : line).join('\n');
    if (text) lineStart = text.endsWith('\n');
    return write(stamped, typeof encoding === 'function' ? encoding : callback);
  }) as typeof stream.write;
}

function rotate(fd: number, path: string): boolean {
  try {
    const { size } = fstatSync(fd);
    if (size < LOG_LIMIT_BYTES || !sameFile(fd, path)) return true;
    // Copy, then truncate in place: every writer (this process, its children, the launcher) keeps its
    // descriptor, and append mode puts the next line at the new end. Writes here are synchronous.
    const temp = `${path}.1.${process.pid}.tmp`;
    copyFileSync(path, temp); chmodSync(temp, 0o600); renameSync(temp, `${path}.1`);
    ftruncateSync(fd, 0);
    (fd === 1 ? process.stdout : process.stderr).write(`[riffet] log rotated; earlier lines are in ${path}.1\n`);
    // Without O_APPEND the descriptor keeps its offset and the file would only turn sparse.
    if (fstatSync(fd).size < size) return true;
    console.warn('[riffet] server.log is not opened for append; rotation stopped');
    return false;
  } catch (error) {
    console.warn('[riffet] log rotation failed:', error instanceof Error ? error.message : error);
    return true;
  }
}

function sameFile(fd: number, path: string): boolean {
  try { const open = fstatSync(fd), named = statSync(path); return open.isFile() && open.dev === named.dev && open.ino === named.ino; }
  catch { return false; }
}

/*
 * Start-up progress. A launcher (`riffet start`, `service install`) follows the log it opened to tell
 * the person waiting where a slow start is, and to tell a start that is still working from one that
 * stopped; the line is the only channel, so its shape is shared here.
 */

/** What a starting server does, in order; `storage` migrates or compacts only when one is due. */
export const STARTUP_PHASES = {
  storage: 'checking storage',
  environment: 'reading the login environment',
  databases: 'opening databases',
  plugins: 'loading plugins',
  tasks: 'recovering tasks',
  services: 'starting services',
  listening: 'listening',
} as const;
export type StartupPhase = keyof typeof STARTUP_PHASES;

const PHASE_PREFIX = '[riffet] starting: ';

export const startupPhaseLine = (phase: StartupPhase): string => PHASE_PREFIX + phase;

/** The phase a log line announces, if it is one (stamped or not). */
export function startupPhaseOf(line: string): StartupPhase | undefined {
  const at = line.indexOf(PHASE_PREFIX);
  if (at < 0) return undefined;
  const name = line.slice(at + PHASE_PREFIX.length).trim();
  return Object.hasOwn(STARTUP_PHASES, name) ? name as StartupPhase : undefined;
}
