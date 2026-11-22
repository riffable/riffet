import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type WebSocket from 'ws';
import { LINK_BUDGET, type RemoteExecRequest, type RemoteExecResult } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';

/**
 * Controlled remote command execution and interactive PTY shell for server links
 * (`POST /api/remote/exec` and `GET /api/remote/shell`). Every child is owned by its
 * request/socket, tracked against `LINK_BUDGET.execConcurrent`, and killed as a process
 * group on timeout, client disconnect, or link revocation.
 */

let activeExecs = 0;

function acquireSlot(): () => void {
  if (activeExecs >= LINK_BUDGET.execConcurrent) {
    throw new AppError('REMOTE_EXEC_BUSY', 'Too many concurrent remote commands on this server', 429);
  }
  activeExecs++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeExecs = Math.max(0, activeExecs - 1);
  };
}

function resolveCwd(raw?: string): string {
  const home = homedir();
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === '~') return home;
  const expanded = trimmed.startsWith('~/') ? resolve(home, trimmed.slice(2)) : isAbsolute(trimmed) ? resolve(trimmed) : resolve(home, trimmed);
  if (!existsSync(expanded) || !statSync(expanded).isDirectory()) {
    throw new AppError('INVALID_PATH', `Directory does not exist: ${expanded}`, 400);
  }
  return expanded;
}

function userShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  const env = process.env.SHELL?.trim();
  if (env && existsSync(env)) return env;
  return existsSync('/bin/zsh') ? '/bin/zsh' : existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

function terminateGroup(child: ChildProcess, graceMs = 2_000): NodeJS.Timeout | undefined {
  if (child.exitCode !== null || child.signalCode !== null) return undefined;
  const send = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* Process already exited. */ }
  };
  send('SIGTERM');
  const force = setTimeout(() => send('SIGKILL'), graceMs);
  force.unref();
  return force;
}

/** Runs one non-interactive command in the user's shell with bounded output and strict lifecycle cleanup. */
export async function runRemoteExec(input: Partial<RemoteExecRequest>, signal?: AbortSignal): Promise<RemoteExecResult> {
  if (typeof input.command !== 'string' || !input.command.trim()) {
    throw new AppError('INVALID_INPUT', 'command must be a non-empty string', 400);
  }
  if (input.command.length > LINK_BUDGET.execCommandChars) {
    throw new AppError('INVALID_INPUT', `command exceeds ${LINK_BUDGET.execCommandChars} characters`, 400);
  }
  if (input.cwd !== undefined && typeof input.cwd !== 'string') {
    throw new AppError('INVALID_INPUT', 'cwd must be a string', 400);
  }
  const cwd = resolveCwd(input.cwd);
  const rawTimeout = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)
    ? Math.trunc(input.timeoutMs)
    : LINK_BUDGET.execTimeoutDefaultMs;
  const timeoutMs = Math.max(1_000, Math.min(LINK_BUDGET.execTimeoutMaxMs, rawTimeout));
  const release = acquireSlot();
  const startedAt = Date.now();
  const shell = userShell();
  const args = process.platform === 'win32' ? ['/c', input.command] : ['-lc', input.command];

  return new Promise<RemoteExecResult>((resolveResult, rejectResult) => {
    let child: ChildProcess;
    try {
      child = spawn(shell, args, {
        cwd,
        env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      release();
      rejectResult(error);
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let collectedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const append = (target: Buffer[], chunk: Buffer) => {
      if (collectedBytes >= LINK_BUDGET.execOutputBytes) { truncated = true; return; }
      const remaining = LINK_BUDGET.execOutputBytes - collectedBytes;
      if (chunk.length <= remaining) {
        target.push(chunk);
        collectedBytes += chunk.length;
      } else {
        target.push(chunk.subarray(0, remaining));
        collectedBytes += remaining;
        truncated = true;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => append(stdoutChunks, chunk));
    child.stderr?.on('data', (chunk: Buffer) => append(stderrChunks, chunk));

    const finish = (err?: Error, exitCode: number | null = null, exitSignal?: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', onAbort);
      release();
      if (err) { rejectResult(err); return; }
      resolveResult({
        exitCode,
        ...(exitSignal ? { signal: exitSignal } : {}),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
        cwd,
      });
    };

    const onAbort = () => {
      forceKillTimer ??= terminateGroup(child);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      forceKillTimer ??= terminateGroup(child);
    }, timeoutMs);
    timer.unref();

    child.once('error', (error) => finish(error));
    child.once('close', (code, exitSignal) => finish(undefined, code, exitSignal));
  });
}

/**
 * Tiny Python PTY relay: gives macOS & Linux an authentic interactive TTY with TIOCSWINSZ resize
 * support and real exit codes without adding native bindings. Control frames arrive as JSON lines
 * on fd 3 (`{"t":"r","c":120,"r":36}`); raw stdin/stdout carry terminal bytes.
 */
const PTY_BRIDGE = `
import fcntl, json, os, pty, select, signal, struct, sys, termios
shell, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
pid, master = pty.fork()
if pid == 0:
    os.execvp(shell, [shell, '-l'])
def resize(c, r):
    try:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
    except OSError:
        pass
resize(cols, rows)
ctrl_buf = b''
open_stdin = True
open_ctrl = True
while True:
    rfds = [master]
    if open_stdin: rfds.append(0)
    if open_ctrl: rfds.append(3)
    try:
        ready, _, _ = select.select(rfds, [], [], 0.25)
    except InterruptedError:
        continue
    if master in ready:
        try:
            data = os.read(master, 8192)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in ready:
        try:
            data = os.read(0, 8192)
        except OSError:
            data = b''
        if not data:
            open_stdin = False
        else:
            os.write(master, data)
    if 3 in ready:
        try:
            chunk = os.read(3, 4096)
        except OSError:
            chunk = b''
        if not chunk:
            open_ctrl = False
        else:
            ctrl_buf += chunk
            while b'\\n' in ctrl_buf:
                line, ctrl_buf = ctrl_buf.split(b'\\n', 1)
                try:
                    msg = json.loads(line.decode('utf8'))
                    if msg.get('t') == 'r':
                        resize(int(msg['c']), int(msg['r']))
                except Exception:
                    pass
    done_pid, status = os.waitpid(pid, os.WNOHANG)
    if done_pid == pid:
        code = os.waitstatus_to_exitcode(status)
        sys.exit(code if code >= 0 else 128 - code)
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
`;

/** Bridges one interactive WebSocket (`GET /api/remote/shell`) to a login PTY on this machine. */
export function attachRemoteShell(
  socket: WebSocket,
  query: { cwd?: string; cols?: number; rows?: number },
  onRevoke: (cb: () => void) => () => void,
): void {
  let cwd: string;
  let release: () => void;
  try {
    cwd = resolveCwd(query.cwd);
    release = acquireSlot();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start remote shell';
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'error', message }));
    socket.close(1008, message.slice(0, 120));
    return;
  }

  const cols = Math.max(20, Math.min(400, Math.trunc(query.cols || 120)));
  const rows = Math.max(5, Math.min(200, Math.trunc(query.rows || 36)));
  const shell = userShell();

  if (process.platform === 'win32') {
    release();
    const message = 'Interactive remote shell is not yet supported on Windows; pass a command instead';
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'error', message }));
    socket.close(1008, message);
    return;
  }

  const child = spawn('python3', ['-u', '-c', PTY_BRIDGE, shell, String(cols), String(rows)], {
    cwd,
    env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    detached: true,
  });

  const ctrl = child.stdio[3] as NodeJS.WritableStream | null;
  child.stdin?.on('error', () => undefined);
  ctrl?.on('error', () => undefined);
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  let forceKillTimer: NodeJS.Timeout | undefined;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    unwatch();
    clearTimeout(forceKillTimer);
    forceKillTimer = terminateGroup(child);
    release();
  };

  const unwatch = onRevoke(() => {
    if (socket.readyState === 1) socket.close(4003, 'Link revoked');
    cleanup();
  });

  const send = (payload: Record<string, unknown>) => {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > LINK_BUDGET.relayBufferBytes) {
      socket.close(1013, 'Remote shell output exceeded buffer limit');
      cleanup();
      return;
    }
    socket.send(JSON.stringify(payload));
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = stdoutDecoder.write(chunk);
    if (text) send({ type: 'output', data: text });
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = stderrDecoder.write(chunk);
    if (text) send({ type: 'output', data: text });
  });

  child.once('error', (error) => {
    send({ type: 'error', message: error.message.includes('ENOENT') ? 'python3 is required on the target server for interactive riffet ssh' : error.message });
    if (socket.readyState === 1) socket.close(1011, 'Shell spawn failed');
    cleanup();
  });

  child.once('close', (exitCode) => {
    const tail = stdoutDecoder.end() + stderrDecoder.end();
    if (tail) send({ type: 'output', data: tail });
    send({ type: 'exit', exitCode: exitCode ?? 0 });
    if (socket.readyState === 1) socket.close(1000);
    cleanup();
  });

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as { type?: string; data?: string; cols?: number; rows?: number };
      if (msg.type === 'input' && typeof msg.data === 'string') {
        child.stdin?.write(msg.data);
      } else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        const c = Math.max(20, Math.min(400, Math.trunc(msg.cols)));
        const r = Math.max(5, Math.min(200, Math.trunc(msg.rows)));
        ctrl?.write(`${JSON.stringify({ t: 'r', c, r })}\n`);
      }
    } catch { /* Ignore malformed client frames. */ }
  });

  socket.once('close', cleanup);
  socket.once('error', cleanup);
}
