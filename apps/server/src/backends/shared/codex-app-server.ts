import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { parsePsCommandLine } from '../../terminal/ps-argv.js';
import { SERVER_VERSION } from '../../version.js';

const execFileAsync = promisify(execFile);

export type JsonRpcId = string | number;
export interface JsonRpcServerRequest {
  id: JsonRpcId;
  method: string;
  params: Record<string, unknown>;
}

export const NO_SERVER_RESPONSE = Symbol('no Codex server response');

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface RpcEnvelope {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface CodexAppServerOptions {
  executable: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Connect to an existing, server-owned endpoint without spawning Codex: a Unix socket, or an
   * authenticated loopback listener (`ws://127.0.0.1:<port>`) whose token lives in `credentialDir`.
   */
  remoteAddress?: string;
  /** Spawn a loopback WebSocket listener instead of a Unix socket, for CLIs whose TUI only attaches over ws. */
  listen?: 'unix' | 'ws';
  /** Where loopback listeners keep their token files; required for `listen: 'ws'` and ws addresses. */
  credentialDir?: string;
  /** The client can present humanCommand approvals and return only a person's one-time decision. */
  requiredHumanApproval?: boolean;
  onNotification(method: string, params: Record<string, unknown>): void;
  onServerRequest(request: JsonRpcServerRequest): Promise<unknown>;
  onExit(error: Error): void;
}

export interface CodexAppServerClient {
  readonly remoteAddress: string;
  /** Verified owner, when known; companions may observe its lifetime without changing its process group. */
  readonly processId?: number;
  /** Identity reported by this connected server, which may predate the CLI now on disk. */
  readonly serverUserAgent?: string;
  /** Bearer token a TUI needs for a loopback listener; absent for Unix sockets. */
  readonly authToken?: string;
  readonly isOnline: boolean;
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  respond(id: JsonRpcId, result: unknown): void;
  detach?(): Promise<void>;
  dispose(): Promise<void>;
}

export type CodexAppServerFactory = (options: CodexAppServerOptions) => Promise<CodexAppServerClient>;

let ownerTag: string | undefined;
/**
 * Names this service's spawns — in their socket directory and token file — after its state
 * directory, so another workbench instance (a dev server, a test run) sharing the temp dir and
 * `~/.riffet` can tell them from its own and never sweep them. One service has one state directory,
 * so this is process-wide.
 */
export function setAppServerOwner(tag: string | undefined): void { ownerTag = tag; }
export function appServerOwner(): string | undefined { return ownerTag; }

/**
 * Owns one Codex app-server process and one protocol connection. A Codex TUI can
 * attach to the same Unix socket with `codex --remote unix://...`, so browser
 * input and the native TUI share one thread runtime and one provider writer.
 */
export class CodexAppServer implements CodexAppServerClient {
  readonly socketPath: string;
  readonly remoteAddress: string;
  readonly authToken?: string;
  private readonly process?: ChildProcess;
  private readonly socket: WebSocket;
  private readonly directory?: string;
  private readonly ownedFile?: string;
  private readonly ownerPid?: number;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private initializedServerUserAgent?: string;
  private closed = false;
  private connectionCloseTask?: Promise<void>;
  private detachTask?: Promise<void>;
  private disposeTask?: Promise<void>;
  private exitError?: Error;
  get processId(): number | undefined { return this.process?.pid ?? this.ownerPid; }
  private constructor(
    private readonly options: CodexAppServerOptions,
    endpoint: {
      socket: WebSocket;
      remoteAddress: string;
      socketPath?: string;
      process?: ChildProcess;
      /** Removed on dispose: the private socket directory, or a loopback listener's token file. */
      directory?: string;
      ownedFile?: string;
      /** A verified server this client reattached to, ended on dispose. */
      ownerPid?: number;
      authToken?: string;
    },
  ) {
    this.socketPath = endpoint.socketPath ?? '';
    this.remoteAddress = endpoint.remoteAddress;
    this.process = endpoint.process;
    this.socket = endpoint.socket;
    this.directory = endpoint.directory;
    this.ownedFile = endpoint.ownedFile;
    this.ownerPid = endpoint.ownerPid;
    if (endpoint.authToken) this.authToken = endpoint.authToken;
    this.socket.on('message', data => this.onMessage(data.toString()));
    this.socket.on('error', error => this.fail(error));
    this.socket.on('close', () => this.fail(new Error('Codex app-server connection closed')));
    this.process?.once('exit', (code, signal) => {
      const reason = new Error(`Codex app-server exited (${code === null ? signal ?? 'unknown' : code})`);
      this.fail(reason);
    });
    this.process?.once('error', error => this.fail(error));
  }

  static async start(options: CodexAppServerOptions): Promise<CodexAppServer> {
    if (options.remoteAddress?.startsWith('ws:')) return await CodexAppServer.attachLoopback(options, options.remoteAddress);
    if (options.remoteAddress === undefined && options.listen === 'ws') return await CodexAppServer.spawnLoopback(options);
    const attachedAddress = options.remoteAddress === undefined
      ? undefined
      : await resolveRemoteUnixAddress(options.remoteAddress);
    const directory = attachedAddress ? undefined : await mkdtemp(join(tmpdir(), ownerTag ? `cw-cx-${ownerTag}-` : 'cw-cx-'));
    if (directory) await chmod(directory, 0o700);
    const socketPath = attachedAddress?.socketPath ?? join(directory!, 's');
    const child = attachedAddress ? undefined : spawn(options.executable, [...(options.args ?? []), 'app-server', '--listen', `unix://${socketPath}`], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: 'ignore',
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let socket: WebSocket | undefined;
    try {
      const address = `ws+unix://${socketPath}:/`;
      socket = await connectWebSocket(address, child, 15_000);
      const canonicalSocketPath = attachedAddress?.socketPath ?? await realpath(socketPath);
      const server = new CodexAppServer(options, { socket, socketPath, directory, process: child, remoteAddress: `unix://${canonicalSocketPath}` });
      return await server.initialize();
    } catch (error) {
      if (socket) await closeWebSocket(socket);
      if (child) await stopProcess(child);
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Spawns an app-server on a loopback port that only answers a bearer token.
   *
   * The token is written to a 0600 file in a 0700 directory, which is the same reach as the Unix
   * socket in a 0700 directory Codex uses: this user only. The port is chosen here rather than read
   * from the server's banner, so the child's output can stay detached from this process — a server
   * that outlives the workbench must not die writing to a pipe nobody reads any more.
   */
  private static async spawnLoopback(options: CodexAppServerOptions, lookup: LoopbackLookup = systemLoopbackLookup): Promise<CodexAppServer> {
    const credentialDir = requireCredentialDir(options);
    await mkdir(credentialDir, { recursive: true, mode: 0o700 });
    await chmod(credentialDir, 0o700);
    let child: ChildProcess | undefined;
    let socket: WebSocket | undefined;
    let tokenFile: string | undefined;
    try {
      let lastError: unknown;
      let remoteAddress = '';
      let token = '';
      for (let attempt = 0; attempt < 3 && !socket; attempt += 1) {
        // A fresh token per attempt: an attempt that failed may have shown its listener to someone else.
        if (tokenFile) await rm(tokenFile, { force: true }).catch(() => undefined);
        token = randomBytes(32).toString('hex');
        tokenFile = join(credentialDir, `${ownerTag ? `${ownerTag}-` : ''}${randomUUID()}.token`);
        await writeFile(tokenFile, token, { mode: 0o600, flag: 'wx' });
        const port = await freeLoopbackPort();
        remoteAddress = `ws://127.0.0.1:${port}`;
        child = spawn(options.executable, [
          ...(options.args ?? []), 'app-server', '--listen', remoteAddress,
          '--ws-auth', 'capability-token', '--ws-token-file', tokenFile,
        ], { cwd: options.cwd, env: options.env ?? process.env, stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
        try {
          // The port was free a moment ago, not reserved: nothing is sent to it until the process
          // listening there is shown to be the child just started.
          await waitForOwnListener(port, child, lookup, 15_000);
          socket = await connectWebSocket(remoteAddress, child, 15_000, token);
        } catch (error) {
          lastError = error;
          // A child that exited (another process took the port) is retried on a new port; one that
          // is still running, or a listener that cannot be checked, is a real failure.
          const exited = child.exitCode !== null || child.signalCode !== null;
          await stopProcess(child);
          child = undefined;
          if (!exited || (error as NodeJS.ErrnoException | undefined)?.code === 'WS_UNVERIFIED') break;
        }
      }
      if (!socket || !child) throw lastError ?? new Error('Codex app-server did not open its loopback listener');
      if (!await rejectsAnonymous(remoteAddress)) {
        throw Object.assign(new Error('The app-server accepted a loopback connection without its token'), { code: 'WS_AUTH_NOT_ENFORCED' });
      }
      const server = new CodexAppServer(options, { socket, process: child, ownedFile: tokenFile, remoteAddress, authToken: token });
      socket = undefined;
      child = undefined;
      tokenFile = undefined;
      return await server.initialize();
    } catch (error) {
      if (socket) await closeWebSocket(socket);
      if (child) await stopProcess(child);
      if (tokenFile) await rm(tokenFile, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Reconnects to a loopback listener a previous workbench process spawned.
   *
   * A port is not an identity: once its server exits, any local process may bind it. So the token is
   * only read — and only sent — after the listener is shown to be this user's app-server started
   * with a token file from `credentialDir`. Anything else is reported as nothing listening.
   */
  private static async attachLoopback(options: CodexAppServerOptions, address: string): Promise<CodexAppServer> {
    const port = loopbackPort(address);
    if (port === undefined) throw new Error('Codex app-server remote address must be ws://127.0.0.1:<port>');
    const { tokenFile, pid } = await verifiedLoopbackCredential(port, requireCredentialDir(options));
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (!token) throw unavailable(`The app-server token for port ${port} is empty`);
    const socket = await connectWebSocket(address, undefined, 15_000, token);
    // The verified listener is one this workbench spawned (its token is in our directory), so an
    // explicit dispose may end it like an owned one; `detach` leaves it running for the next client.
    const server = new CodexAppServer(options, { socket, remoteAddress: `ws://127.0.0.1:${port}`, authToken: token, ownedFile: tokenFile, ownerPid: pid });
    return await server.initialize();
  }

  private async initialize(): Promise<CodexAppServer> {
    try {
      const initialized = await this.request<{ userAgent?: unknown }>('initialize', {
        clientInfo: { name: 'riffet', title: 'Riffet', version: SERVER_VERSION },
        capabilities: {
          experimentalApi: true, requestAttestation: false,
          ...(this.options.requiredHumanApproval ? { requiredHumanApproval: true } : {}),
        },
      });
      if (typeof initialized?.userAgent === 'string') this.initializedServerUserAgent = initialized.userAgent;
      this.notify('initialized');
      return this;
    } catch (error) {
      // A connection borrowed from another workbench is not ours to end: a failed handshake detaches
      // this client and leaves the process and its token for the next one.
      if (this.ownerPid && !this.process) await this.detach();
      else await this.dispose();
      throw error;
    }
  }

  get serverUserAgent(): string | undefined { return this.initializedServerUserAgent; }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    this.assertOpen();
    const id = this.nextId++;
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }), error => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(error);
        });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        rejectRequest(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.assertOpen();
    this.socket.send(JSON.stringify({ method, ...(params === undefined ? {} : { params }) }));
  }

  respond(id: JsonRpcId, result: unknown): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new Error('Codex app-server is offline');
    this.socket.send(JSON.stringify({ id, result }));
  }

  get isOnline(): boolean {
    return !this.closed && this.socket.readyState === WebSocket.OPEN && (!this.process || this.process.exitCode === null);
  }

  async detach(): Promise<void> {
    if (this.detachTask) return await this.detachTask;
    this.detachTask = this.closeConnection(new Error('Codex app-server detached')).then(() => {
      // The server keeps serving native turns after Riffet closes. Its child handle must not
      // keep a short-lived host process (such as a probe) alive after all work has finished.
      this.process?.unref();
    });
    await this.detachTask;
  }

  async dispose(): Promise<void> {
    if (this.disposeTask) return await this.disposeTask;
    this.disposeTask = (async () => {
      await this.closeConnection(new Error('Codex app-server disposed'));
      if (this.process) await stopProcess(this.process);
      else if (this.ownerPid && process.platform !== 'win32') await stopProcessGroup(this.ownerPid);
      if (this.directory) await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
      if (this.ownedFile) await rm(this.ownedFile, { force: true }).catch(() => undefined);
    })();
    await this.disposeTask;
  }

  private closeConnection(reason: Error): Promise<void> {
    if (this.connectionCloseTask) return this.connectionCloseTask;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.pending.delete(id);
    }
    this.connectionCloseTask = closeWebSocket(this.socket);
    return this.connectionCloseTask;
  }

  private assertOpen(): void {
    if (this.closed || !this.isOnline) throw this.exitError ?? new Error('Codex app-server is offline');
  }

  private onMessage(text: string): void {
    let message: RpcEnvelope;
    try { message = JSON.parse(text) as RpcEnvelope; }
    catch { return; }
    if (typeof message.method === 'string') {
      const params = isRecord(message.params) ? message.params : {};
      if (message.id !== undefined) {
        void Promise.resolve().then(() => this.options.onServerRequest({ id: message.id!, method: message.method!, params })).then(
          result => { if (result !== NO_SERVER_RESPONSE) this.respond(message.id!, result); },
          () => this.sendError(message.id!, 'Codex request could not be handled by the workbench.'),
        ).catch(error => this.fail(error instanceof Error ? error : new Error('Codex response could not be delivered.')));
      } else {
        try { this.options.onNotification(message.method, params); }
        catch { this.fail(new Error('Codex app-server notification handler failed.')); }
      }
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message ?? `Codex app-server error ${message.error.code ?? 'unknown'}`), { rpcError: true, rpcCode: message.error.code }));
    else pending.resolve(message.result);
  }

  private sendError(id: JsonRpcId, message: string): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ id, error: { code: -32603, message } }));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.exitError = error;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.options.onExit(error);
  }
}

/** `token` is sent as a bearer credential; a listener that refuses it is a failure, not a retry. */
function connectWebSocket(address: string, child: ChildProcess | undefined, timeoutMs: number, token?: string): Promise<WebSocket> {
  return new Promise((resolveSocket, rejectSocket) => {
    let settled = false;
    let socket: WebSocket | undefined;
    let retryTimer: NodeJS.Timeout | undefined;
    const deadline = Date.now() + timeoutMs;
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(retryTimer);
      child?.off('error', finishError);
      child?.off('exit', onExit);
    };
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket?.terminate();
      rejectSocket(error);
    };
    const onExit = () => finishError(new Error('Codex app-server exited before opening its socket'));
    const timer = setTimeout(() => finishError(new Error('Timed out waiting for Codex app-server socket')), timeoutMs);
    timer.unref();
    child?.once('error', finishError);
    child?.once('exit', onExit);
    const tryConnect = () => {
      if (settled) return;
      if (child && (child.exitCode !== null || child.signalCode !== null)) {
        finishError(new Error('Codex app-server exited before opening its socket'));
        return;
      }
      if (Date.now() >= deadline) {
        finishError(new Error('Timed out waiting for Codex app-server socket'));
        return;
      }
      const current = new WebSocket(address, {
        handshakeTimeout: 1_000, perMessageDeflate: false,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
      socket = current;
      current.once('unexpected-response', (_request, response) => {
        finishError(new Error(`Codex app-server refused the connection (HTTP ${response.statusCode ?? 'unknown'})`));
      });
      current.once('open', () => {
        if (settled) { current.close(); return; }
        settled = true;
        cleanup();
        resolveSocket(current);
      });
      let retryScheduled = false;
      const retry = () => {
        if (settled || retryScheduled) return;
        retryScheduled = true;
        current.terminate();
        retryTimer = setTimeout(tryConnect, 80);
        retryTimer.unref();
      };
      const onConnectError = (error: Error) => {
        if (child === undefined && isErrnoException(error) && (error.code === 'ECONNREFUSED' || error.code === 'ENOENT')) {
          finishError(error);
          return;
        }
        retry();
      };
      current.once('error', onConnectError);
      current.once('close', retry);
    };
    tryConnect();
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const onExit = () => { clearTimeout(timer); resolveExit(); };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      rejectExit(new Error('Process did not exit before timeout'));
    }, timeoutMs);
    timer.unref();
    child.once('exit', onExit);
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform !== 'win32') {
    // `detached` in start() gives this app-server its own process group. Signal
    // that group even when the wrapper already exited: its native child may
    // still own the thread-writer lock and keep running as an orphan.
    await stopProcessGroup(pid);
    return;
  }

  // Windows does not use POSIX process groups here; retain direct-child
  // termination behavior.
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try { await waitForExit(child, 2_000); }
  catch {
    child.kill('SIGKILL');
    await waitForExit(child, 2_000);
  }
}

/** [graceMs] first waits for a group already told to stop (a hang-up, say) to exit on its own. */
export async function stopProcessGroup(pid: number, graceMs = 0): Promise<void> {
  if (graceMs > 0 && await waitForProcessGroupExit(pid, graceMs)) return;
  signalProcessGroup(pid, 'SIGTERM');
  if (await waitForProcessGroupExit(pid, 2_000)) return;
  signalProcessGroup(pid, 'SIGKILL');
  if (await waitForProcessGroupExit(pid, 2_000)) return;
  throw new Error(`Process group ${pid} did not exit after SIGKILL`);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (error) {
    if (isErrnoException(error) && error.code === 'ESRCH') return;
    throw error;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, remaining)));
  }
  return true;
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ESRCH') return false;
    if (isErrnoException(error) && error.code === 'EPERM') return true;
    throw error;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function resolveRemoteUnixAddress(address: string): Promise<{ socketPath: string }> {
  if (!address.startsWith('unix://') || address.includes('?') || address.includes('#')) {
    throw new Error('Codex app-server remote address must be a Unix socket URI');
  }
  let parsed: URL;
  try { parsed = new URL(address); }
  catch { throw new Error('Codex app-server remote address must be a valid Unix socket URI'); }
  if (parsed.protocol !== 'unix:' || parsed.hostname || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw new Error('Codex app-server remote address must contain only an absolute Unix socket path');
  }
  let socketPath: string;
  try { socketPath = decodeURIComponent(parsed.pathname); }
  catch { throw new Error('Codex app-server remote address contains an invalid socket path'); }
  if (!isAbsolute(socketPath)) throw new Error('Codex app-server remote socket path must be absolute');
  const canonicalPath = await realpath(socketPath);
  const details = await stat(canonicalPath);
  if (!details.isSocket()) throw new Error('Codex app-server remote address does not point to a Unix socket');
  return { socketPath: canonicalPath };
}

function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise(resolveClose => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('close', finish);
      resolveClose();
    };
    const timer = setTimeout(() => {
      socket.terminate();
      finish();
    }, 1_000);
    socket.once('close', finish);
    try { socket.close(); }
    catch {
      socket.terminate();
      finish();
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requireCredentialDir(options: CodexAppServerOptions): string {
  const dir = options.credentialDir;
  if (!dir || !isAbsolute(dir)) throw new Error('A loopback app-server needs an absolute credential directory');
  return dir;
}

/** The kind of error the runtime treats as "no endpoint there", so it may start a fresh one. */
function unavailable(message: string): Error {
  return Object.assign(new Error(message), { code: 'ECONNREFUSED' });
}

/** Port of an exact `ws://127.0.0.1:<port>` address; any other host or a path is refused. */
export function loopbackPort(address: string): number | undefined {
  const match = /^ws:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(address);
  const port = match ? Number(match[1]) : Number.NaN;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => port ? resolvePort(port) : rejectPort(new Error('No loopback port was assigned')));
    });
  });
}

/**
 * Waits until the loopback port is listened on by `child` or a process in its group. A different
 * listener means another process took the port first; a lookup that cannot run means the listener
 * cannot be checked at all, which callers treat as "no private loopback on this host".
 */
export async function waitForOwnListener(port: number, child: ChildProcess, lookup: LoopbackLookup, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Codex app-server exited before opening its socket');
    let listeners: Array<{ pid: number; uid: number }>;
    try { listeners = await lookup.listeners(port); }
    catch (error) {
      // `lsof` exits 1 when nothing listens yet; only a lookup that could not run at all is fatal.
      if ((error as { code?: unknown } | undefined)?.code !== 1) {
        throw Object.assign(new Error('The loopback listener could not be verified on this host'), { code: 'WS_UNVERIFIED' });
      }
      listeners = [];
    }
    if (listeners.length) {
      for (const listener of listeners) {
        if (listener.pid === child.pid || await lookup.processGroup(listener.pid).catch(() => undefined) === child.pid) return;
      }
      throw new Error(`Another process is listening on 127.0.0.1:${port}`);
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Codex app-server socket');
    await new Promise(resolveWait => setTimeout(resolveWait, 80));
  }
}

/** True when the listener turns away a handshake that carries no token. */
function rejectsAnonymous(address: string): Promise<boolean> {
  return new Promise(resolveCheck => {
    const socket = new WebSocket(address, { handshakeTimeout: 2_000, perMessageDeflate: false });
    let settled = false;
    const finish = (rejected: boolean) => {
      if (settled) return;
      settled = true;
      socket.terminate();
      resolveCheck(rejected);
    };
    socket.once('unexpected-response', (_request, response) => finish(response.statusCode === 401 || response.statusCode === 403));
    // Only an explicit refusal proves the token is required; anything else is not proof.
    socket.once('open', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * The token file of the app-server listening on a loopback port, once the listener is proven to be
 * this user's app-server started with a token from `credentialDir`.
 *
 * The listener's own argv names the file (`--ws-token-file`), so this works for an endpoint read
 * from a TUI's command line as well as for a saved binding, without the workbench storing secrets.
 */
export async function verifiedLoopbackCredential(port: number, credentialDir: string, lookup: LoopbackLookup = systemLoopbackLookup): Promise<{ tokenFile: string; pid: number }> {
  const uid = process.getuid?.();
  const listeners = await lookup.listeners(port).catch(() => []);
  const root = await realpath(credentialDir).catch(() => undefined);
  if (!root) throw unavailable(`No app-server credentials exist for port ${port}`);
  for (const listener of listeners) {
    if (uid !== undefined && listener.uid !== uid) continue;
    const argv = await lookup.argv(listener.pid).catch(() => undefined);
    if (!argv?.includes('app-server')) continue;
    const auth = argv.indexOf('--ws-auth');
    const file = argv.indexOf('--ws-token-file');
    if (auth < 0 || argv[auth + 1] !== 'capability-token' || file < 0 || !argv[file + 1]) continue;
    const tokenFile = await realpath(argv[file + 1]!).catch(() => undefined);
    if (!tokenFile || !tokenFile.startsWith(`${root}${sep}`)) continue;
    const details = await stat(tokenFile).catch(() => undefined);
    if (!details?.isFile() || (uid !== undefined && details.uid !== uid) || (details.mode & 0o077) !== 0) continue;
    return { tokenFile, pid: listener.pid };
  }
  throw unavailable(`No verified app-server is listening on 127.0.0.1:${port}`);
}

export interface LoopbackLookup {
  listeners(port: number): Promise<Array<{ pid: number; uid: number }>>;
  argv(pid: number): Promise<string[] | undefined>;
  processGroup(pid: number): Promise<number | undefined>;
}

const systemLoopbackLookup: LoopbackLookup = {
  async listeners(port) {
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-Fpu'], { timeout: 2_000, encoding: 'utf8' });
    const found: Array<{ pid: number; uid: number }> = [];
    let pid: number | undefined;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('u') && pid !== undefined) found.push({ pid, uid: Number(line.slice(1)) });
    }
    return found.filter(entry => Number.isSafeInteger(entry.pid) && entry.pid > 0 && Number.isSafeInteger(entry.uid));
  },
  async argv(pid) {
    if (process.platform === 'linux') {
      const bytes = await readFile(`/proc/${pid}/cmdline`);
      return bytes.toString('utf8').split('\0').filter(Boolean);
    }
    const { stdout } = await execFileAsync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { timeout: 2_000, encoding: 'utf8' });
    return parsePsCommandLine(stdout);
  },
  async processGroup(pid) {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'pgid='], { timeout: 2_000, encoding: 'utf8' });
    const group = Number(stdout.trim());
    return Number.isSafeInteger(group) && group > 0 ? group : undefined;
  },
};
