import { execFile } from 'node:child_process';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { SERVER_BUDGET } from '../../../packages/contracts/src/budgets.js';

/**
 * One-shot commands (`tmux`, `ps`, `lsof`, `pgrep`) run from a worker thread, so creating the process and
 * killing one that timed out never hold the server's event loop. Both are synchronous calls in the thread
 * that makes them: stall profiles of the served daemon showed them as its largest single block (seconds per
 * half minute, a single `kill` over two seconds), and a blocked loop is what turns a delivery's short wait
 * into a wrong "not seen" (docs/DELIVERY.md §7).
 *
 * The command's output and failure are the same as `execFile` reports them.
 */
export interface ExecOptions {
  /** Milliseconds before the command is killed; `execFile`'s own default (none) when absent. */
  timeout?: number;
  maxBuffer?: number;
  /** The server's current environment when absent. */
  env?: NodeJS.ProcessEnv;
  /** Written to the command's stdin, which is then closed. */
  input?: string;
}

export interface ExecFailure {
  message: string;
  /** The exit code, or the system error name (`ENOENT`) when the command did not run. */
  code?: number | string;
  /** The command was killed by the timeout or for exceeding `maxBuffer`. */
  killed: boolean;
  signal?: string;
}

export class ExecError extends Error {
  readonly code?: number | string;
  readonly killed: boolean;
  readonly signal?: string;
  constructor(failure: ExecFailure, readonly stdout: string, readonly stderr: string) {
    super(failure.message);
    this.name = 'ExecError';
    this.code = failure.code;
    this.killed = failure.killed;
    this.signal = failure.signal;
  }
}

interface Reply { id: number; stdout: string; stderr: string; failure?: ExecFailure }
interface Waiting { resolve(output: { stdout: string; stderr: string }): void; reject(error: Error): void }

/** CommonJS, evaluated in the worker: it has no file of its own, so it runs the same from source, the bundle and tests. */
const WORKER = `
const { parentPort } = require('node:worker_threads');
const { execFile } = require('node:child_process');
parentPort.on('message', ({ id, command, args, options, input }) => {
  const fail = error => ({ message: String(error && error.message || error), code: error && error.code, killed: Boolean(error && error.killed), signal: error && error.signal || undefined });
  try {
    const child = execFile(command, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      parentPort.postMessage({ id, stdout, stderr, failure: error ? fail(error) : undefined });
    });
    if (input !== undefined && child.stdin) {
      // A command that exits without reading its input must not take the worker down with EPIPE.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  } catch (error) {
    parentPort.postMessage({ id, stdout: '', stderr: '', failure: fail(error) });
  }
});
`;

let worker: Worker | undefined;
/** Set once a worker could not be started; commands then run on the calling thread as before. */
let unavailable = false;
let lastId = 0;
let idleMs: number = SERVER_BUDGET.execWorkerIdleMs;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const waiting = new Map<number, Waiting>();

function clearIdleTimer(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
}

function scheduleIdleShutdown(): void {
  clearIdleTimer();
  if (!worker || waiting.size || idleMs <= 0) return;
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    trimExecWorker();
  }, idleMs);
  idleTimer.unref();
}

/** Configures how long an idle command worker stays resident before exiting to free its V8 isolate. */
export function configureExecWorker(options: { idleMs: number }): void {
  idleMs = Math.max(0, options.idleMs);
  if (!waiting.size) scheduleIdleShutdown();
}

/** Terminates the idle command worker immediately; safe no-op while commands are in flight. */
export function trimExecWorker(): void {
  clearIdleTimer();
  if (!worker || waiting.size) return;
  const target = worker;
  worker = undefined;
  void target.terminate().catch(() => undefined);
}

/** Observability stats for `ServerCacheRegistry`. */
export function execWorkerStats(): { count: number } {
  return { count: worker ? 1 : 0 };
}

function lost(from: Worker, error: Error): void {
  if (worker !== from) return;
  clearIdleTimer();
  worker = undefined;
  const pending = [...waiting.values()];
  waiting.clear();
  for (const entry of pending) entry.reject(error);
}

function ensureWorker(): Worker | undefined {
  if (worker || unavailable) return worker;
  let created: Worker;
  try { created = new Worker(WORKER, { eval: true, env: SHARE_ENV, name: 'riffet-exec' }); }
  catch { unavailable = true; return undefined; }
  created.on('message', (reply: Reply) => {
    const entry = waiting.get(reply.id);
    if (!entry) return;
    waiting.delete(reply.id);
    // An idle worker does not keep a one-shot CLI command alive; one with a command in flight does.
    if (!waiting.size) {
      created.unref();
      scheduleIdleShutdown();
    }
    if (reply.failure) entry.reject(new ExecError(reply.failure, reply.stdout, reply.stderr));
    else entry.resolve({ stdout: reply.stdout, stderr: reply.stderr });
  });
  created.on('error', error => lost(created, error));
  created.on('exit', () => lost(created, new Error('The command worker exited')));
  created.unref();
  worker = created;
  return created;
}

function onCallingThread(command: string, args: string[], options: ExecOptions): Promise<{ stdout: string; stderr: string }> {
  const { input, ...rest } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { ...rest, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new ExecError({ message: error.message, code: error.code ?? undefined, killed: Boolean(error.killed), signal: error.signal ?? undefined }, stdout, stderr));
      else resolve({ stdout, stderr });
    });
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

/** Runs `command` to completion and returns what it printed; rejects with `ExecError` as `execFile` would fail. */
export function exec(command: string, args: string[], options: ExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const target = ensureWorker();
  if (!target) return onCallingThread(command, args, options);
  clearIdleTimer();
  const { input, ...rest } = options;
  const id = ++lastId;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    target.ref();
    try { target.postMessage({ id, command, args, options: rest, input }); }
    catch (error) {
      waiting.delete(id);
      if (!waiting.size) { target.unref(); scheduleIdleShutdown(); }
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
