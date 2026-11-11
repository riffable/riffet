import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { AppError } from '../errors.js';
import type { HostToChild, RpcError } from '../../../../packages/plugin-api/src/runtime/protocol.js';
import { SANDBOX_EXEC, sandboxArguments } from './sandbox.js';

// The process an installed package runs in. It is a separate Node process under the permission model
// (`--permission`): it may read the runtime shim, the package directory and the plugin's own state
// directory, write only the latter, and start no process, worker, addon or WASI instance. That model
// does not restrict signals (or the network on Node 24), so on macOS the process also runs under a Seatbelt profile
// (`sandbox.ts`) that does; elsewhere it is refused unless the operator accepts the gap
// (docs/PLUGIN_ARCHITECTURE.md). A crash, a protocol error or a call that does not answer in time ends the
// process and reports the plugin as failed; nothing here can take the server down.

const MAX_INCOMING = 64;
/** The longest message the child may send; a longer one is a protocol error rather than memory the server keeps growing. */
const MAX_MESSAGE_CHARS = 8 * 1024 * 1024;
const TAIL_BYTES = 2000;
const DEFAULT_MEMORY_MB = 256;

export interface PluginProcessOptions {
  /** The real path of the shim (`child.mjs`). */
  runtime: string;
  /** Real paths: the permission model matches them literally, and a symlinked prefix would not match. */
  packageRoot: string;
  stateDir: string;
  /** Answers a request the child makes; a rejection is sent back as an error. */
  serve(method: string, params: unknown): Promise<unknown>;
  /** The process ended or broke the protocol without being asked to stop. Called once. */
  onFailure(reason: string): void;
  onLog?(message: string): void;
  maxMemoryMb?: number;
  /** Whether the package has the network capability. Node 25+ enforces it as well as the OS sandbox. */
  network?: boolean;
  /** Run under the operating system's sandbox (`requireIsolation`); without it only Node's permission model applies. */
  sandbox?: { node: string; libraries: readonly string[]; network: boolean; withhold?: readonly number[] };
}

interface Waiting { method: string; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

/**
 * What the permission model is told: exactly these and nothing else. Exported so a test can show what an
 * installed package gets. `node:sqlite` is removed from the process because it opens database files
 * outside the granted paths (a documented gap of the permission model).
 */
export function permissionArguments(options: Pick<PluginProcessOptions, 'runtime' | 'packageRoot' | 'stateDir' | 'maxMemoryMb' | 'network'>): string[] {
  return [
    '--permission', '--no-experimental-sqlite', '--enable-source-maps',
    `--allow-fs-read=${options.runtime}`, `--allow-fs-read=${options.packageRoot}`, `--allow-fs-read=${options.stateDir}`,
    `--allow-fs-write=${options.stateDir}`,
    `--max-old-space-size=${options.maxMemoryMb ?? DEFAULT_MEMORY_MB}`,
    ...(options.network && process.allowedNodeEnvironmentFlags.has('--allow-net') ? ['--allow-net'] : []),
  ];
}

/**
 * Statuses an error from the child may carry on to a client. The status is the child's to choose, so it must not be able
 * to pass for a verdict of the server's own (a 401 or 403 would read as the session or its rights failing): any other
 * status, and an error with none, is the child failing, a 502.
 */
const CHILD_STATUSES: ReadonlySet<number> = new Set([400, 404, 409, 422]);
const CHILD_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

function childError(body: RpcError): AppError {
  const message = (typeof body.message === 'string' && body.message ? body.message : 'the plugin reported an error').slice(0, 2000);
  const code = typeof body.code === 'string' && CHILD_CODE.test(body.code) ? body.code : 'INTEGRATION_ACTION_FAILED';
  return new AppError(code, message, typeof body.statusCode === 'number' && CHILD_STATUSES.has(body.statusCode) ? body.statusCode : 502);
}

function toRpcError(error: unknown): RpcError {
  if (error instanceof AppError) return { code: error.code, message: error.message, statusCode: error.statusCode };
  return { message: error instanceof Error && error.message ? error.message : String(error) };
}

let signalGuarded = false;
/**
 * The permission model does not restrict signals, and SIGUSR1 makes a Node process open its inspector
 * on a local port, which an unrestricted network lets the package connect to: that would be code
 * execution in the server. A JS listener keeps Node from starting the inspector (verified on 24.19);
 * a server started with `--disable-sigusr1` is covered too.
 */
function guardServerFromSignal(): void {
  if (signalGuarded) return;
  signalGuarded = true;
  if (process.listenerCount('SIGUSR1') === 0) process.on('SIGUSR1', () => undefined);
}

export class PluginProcess {
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private readonly waiting = new Map<number, Waiting>();
  private nextId = 1;
  private incoming = 0;
  private tail = '';
  private partial = '';
  private logPartial = '';
  private logDiscarding = false;
  private stopping = false;
  private ended = false;
  private failure?: string;
  private readonly exited: Promise<void>;

  constructor(private readonly options: PluginProcessOptions) {
    guardServerFromSignal();
    // Messages are JSON lines: to the child on its stdin, from it on its stdout. Not Node's IPC channel, whose parser
    // throws a malformed line (which the child can write to the channel's descriptor) at the server's top level and
    // buffers a line without an end for as long as it grows.
    this.child = spawn(options.sandbox ? SANDBOX_EXEC : process.execPath, [
      // `sandbox-exec` applies the profile and then becomes the interpreter, so the pid, the pipes and signals are the same.
      ...(options.sandbox ? sandboxArguments({
        node: options.sandbox.node, libraries: options.sandbox.libraries, network: options.sandbox.network, withhold: options.sandbox.withhold,
        read: [options.runtime, options.packageRoot, options.stateDir], write: [options.stateDir],
      }) : []),
      ...permissionArguments(options),
      options.runtime,
    ], {
      cwd: options.stateDir,
      // Nothing of the server's environment: no PATH, no tokens. OpenSSL reads no configuration file.
      env: { NODE_ENV: process.env.NODE_ENV ?? 'production', OPENSSL_CONF: '/dev/null', ...(process.env.LANG ? { LANG: process.env.LANG } : {}), ...(process.env.TZ ? { TZ: process.env.TZ } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.unref();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.read(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.tail = (this.tail + chunk).slice(-TAIL_BYTES);
      this.readLog(chunk);
    });
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      // A pipe the child closed or broke must not raise an unhandled `error` in the server.
      stream.on('error', () => undefined);
      (stream as unknown as { unref?: () => void }).unref?.();
    }
    this.exited = new Promise(resolve => {
      this.child.once('exit', (code, signal) => {
        this.ended = true;
        resolve();
        if (!this.stopping) this.fail(`the process ended unexpectedly (${signal ?? `exit code ${code}`})${this.lastLine()}`);
        else this.rejectAll(new Error('the process was stopped'));
      });
    });
    this.child.once('error', error => this.fail(`the process could not run: ${error.message}`));
  }

  get alive(): boolean { return !this.ended && !this.failure && !this.stopping; }
  get failed(): string | undefined { return this.failure; }

  private readLog(chunk: string): void {
    if (this.logDiscarding) {
      const end = chunk.indexOf('\n');
      if (end < 0) return;
      chunk = chunk.slice(end + 1); this.logDiscarding = false;
    }
    const lines = (this.logPartial + chunk).split('\n');
    this.logPartial = lines.pop() ?? '';
    for (const line of lines) if (line) this.options.onLog?.(line.length > 64 * 1024 ? '[oversized plugin log line omitted]' : line);
    if (this.logPartial.length > 64 * 1024) {
      this.options.onLog?.('[oversized plugin log line omitted]');
      this.logPartial = ''; this.logDiscarding = true;
    }
  }

  /** A request to the child. A timeout or a dead process fails the plugin; the caller sees the same error. */
  call<M extends keyof HostToChild>(method: M, params: HostToChild[M]['params'], timeoutMs: number): Promise<HostToChild[M]['result']> {
    if (this.failure) return Promise.reject(new Error(this.failure));
    if (this.ended || this.stopping) return Promise.reject(new Error('the process is not running'));
    return new Promise<HostToChild[M]['result']>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => this.fail(`${method} did not answer within ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
      this.waiting.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ id, method, params });
    });
  }

  /** Asks the child to finish (its stdin closes), then ends it if it has not gone within `graceMs`. */
  async stop(graceMs = 1000): Promise<void> {
    if (!this.ended) {
      this.stopping = true;
      this.rejectAll(new Error('the process was stopped'));
      this.child.stdin.end();
      const timer = setTimeout(() => this.child.kill('SIGKILL'), graceMs);
      timer.unref();
      await this.exited;
      clearTimeout(timer);
    }
  }

  private send(message: unknown): void {
    if (this.ended || !this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`, error => { if (error) this.fail(`the process could not be reached: ${error.message}`); });
  }

  /** Splits the child's stdout into messages; an over-long or malformed one fails the plugin. */
  private read(chunk: string): void {
    if (this.failure || this.stopping) return;
    // Only the new chunk is searched for line ends, so a long message costs its length once.
    const lines = chunk.split('\n');
    lines[0] = this.partial + lines[0];
    this.partial = lines.pop()!;
    if (this.partial.length > MAX_MESSAGE_CHARS) return this.fail('protocol error: a message that is too long');
    for (const line of lines) {
      if (this.failure || this.stopping) return;
      if (line.length > MAX_MESSAGE_CHARS) return this.fail('protocol error: a message that is too long');
      let message: unknown;
      try { message = JSON.parse(line); } catch { return this.fail('protocol error: a message that is not JSON'); }
      this.receive(message);
    }
  }

  private receive(message: unknown): void {
    if (this.failure || this.stopping) return;
    if (!message || typeof message !== 'object' || typeof (message as { id?: unknown }).id !== 'number') return this.fail('protocol error: a message without an id');
    const { id, method, params, result, error } = message as { id: number; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    if (method === undefined) {
      const entry = this.waiting.get(id);
      if (!entry) return this.fail(`protocol error: an answer to request ${id}, which nobody asked`);
      this.waiting.delete(id);
      clearTimeout(entry.timer);
      if (error && typeof error === 'object') entry.reject(childError(error as RpcError));
      else entry.resolve(result ?? null);
      return;
    }
    if (typeof method !== 'string') return this.fail('protocol error: a request without a method');
    if (this.incoming >= MAX_INCOMING) return this.fail('the plugin sent too many requests at once');
    this.incoming++;
    void this.options.serve(method, params).then(
      value => this.send({ id, result: value ?? null }),
      (reason: unknown) => this.send({ id, error: toRpcError(reason) }),
    ).finally(() => { this.incoming--; });
  }

  private lastLine(): string {
    const line = this.tail.trim().split('\n').filter(Boolean).at(-1);
    return line ? `: ${line.slice(0, 200)}` : '';
  }

  private rejectAll(error: Error): void {
    for (const [id, entry] of this.waiting) { clearTimeout(entry.timer); entry.reject(error); this.waiting.delete(id); }
  }

  private fail(reason: string): void {
    if (this.failure || this.stopping) return;
    this.failure = reason;
    this.rejectAll(new Error(reason));
    if (!this.ended) this.child.kill('SIGKILL');
    this.options.onFailure(reason);
  }
}
