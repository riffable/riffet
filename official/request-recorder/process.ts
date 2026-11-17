// The proxy daemon's lifecycle. The CLI outlives a server restart and keeps the address it was launched with, so the proxy
// is a detached process of its own: `prepare` starts one, `recover` finds it again, and it ends itself when the CLI is gone.

import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile, lstat, chmod } from 'node:fs/promises';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PROTOCOL = 1;
/** Without `bindNative` the daemon has no process to follow, so it ends after this. */
export const BIND_GRACE_MS = 60_000;
/** A bound process whose pid is unknown is followed by traffic instead: no request for this long ends the daemon. */
export const IDLE_EXIT_MS = 12 * 60 * 60 * 1000;
export const LIVENESS_MS = 10_000;
const STATUS_POLL_MS = 5_000;
const STARTUP_MS = 15_000;

export interface Descriptor {
  version: number; id: string; bootId: string; sessionId: string; fingerprint: string;
  proxyToken: string; controlToken: string;
  /** The gateway the conversation would otherwise use. */
  upstream: string;
  recordDir: string;
  paused: boolean;
  port?: number; daemonPid?: number;
  native?: { address: string; pid?: number; identity?: string; nativeSessionId?: string };
}

export interface Status { paused: boolean; count: number }
type Reply = { version: number; id: string; bootId: string; sessionId: string; fingerprint: string; status: Status; nativeAddress?: string };

export async function writeDescriptor(path: string, descriptor: Descriptor): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/**
 * Start time of a process, so a recycled pid does not match: `null` when it is not running, `undefined` when that
 * cannot be told (`ps` timed out or failed to start). Read in C and UTC, so it reads the same after a restart.
 */
export async function processIdentity(pid: number): Promise<string | null | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 2_000, maxBuffer: 128 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } });
    return stdout.trim() || null;
  } catch (error) {
    // `ps` exits 1 when the process is not there.
    return (error as { code?: unknown }).code === 1 ? null : undefined;
  }
}

export async function assertPrivate(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) {
    throw new Error('Invalid request recorder private storage');
  }
}

function control(descriptor: Descriptor, method: string, input?: unknown): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = input === undefined ? undefined : JSON.stringify(input);
    const req = request({ host: '127.0.0.1', port: descriptor.port, path: `/__control/${method}`, method: 'POST',
      headers: { authorization: `Bearer ${descriptor.controlToken}`, 'content-type': 'application/json', 'x-riffet-recorder-boot': descriptor.bootId },
    }, res => {
      let response = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { response += chunk; if (response.length > 64 * 1024) req.destroy(new Error('Invalid recorder control response')); });
      res.on('end', () => {
        try {
          const value = JSON.parse(response) as Reply;
          if (res.statusCode !== 200) throw new Error('Recorder request failed');
          if (value.version !== PROTOCOL || value.id !== descriptor.id || value.bootId !== descriptor.bootId || value.sessionId !== descriptor.sessionId || value.fingerprint !== descriptor.fingerprint) {
            throw new Error('Recorder identity changed');
          }
          resolve(value);
        } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.setTimeout(10_000, () => req.destroy(new Error('Recorder control timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

/** The daemon as the plugin holds it. */
export interface RecorderHandle {
  readonly id: string;
  /** The address the CLI is launched with: the daemon and its secret path. */
  readonly baseUrl: string;
  status(): Status;
  setPaused(paused: boolean): Promise<void>;
  bindNative(input: { address: string; pid?: number; nativeSessionId?: string }): Promise<void>;
  detach(): void;
  stop(): Promise<void>;
}

interface Options { sessionId: string; fingerprint: string; directory: string; onStatus?: (status: Status) => void }

function makeHandle(descriptor: Descriptor, options: Options, initial: Status): RecorderHandle {
  let detached = false;
  let polling = false;
  let last = initial;
  const update = (reply: Reply) => {
    const changed = reply.status.paused !== last.paused || reply.status.count !== last.count;
    last = reply.status;
    if (changed && !detached) options.onStatus?.(last);
  };
  const timer = setInterval(() => {
    if (polling || detached) return;
    polling = true;
    void control(descriptor, 'status').then(update).catch(() => undefined).finally(() => { polling = false; });
  }, STATUS_POLL_MS);
  timer.unref();
  const detach = () => { detached = true; clearInterval(timer); };
  return {
    id: descriptor.id,
    baseUrl: `http://127.0.0.1:${descriptor.port}/${descriptor.proxyToken}`,
    status: () => last,
    setPaused: async paused => { update(await control(descriptor, 'pause', { paused })); },
    bindNative: async input => { update(await control(descriptor, 'bind', input)); },
    detach,
    stop: async () => { detach(); await control(descriptor, 'stop').catch(() => undefined); },
  };
}

/** A daemon whose process is gone leaves its directory behind; any directory idle for a day with no live daemon is removed. */
async function sweep(parent: string): Promise<void> {
  const names = await readdir(parent).catch(() => [] as string[]);
  for (const name of names) {
    const file = join(parent, name, 'descriptor.json');
    try {
      const info = await stat(file);
      if (Date.now() - info.mtimeMs < 24 * 60 * 60 * 1000) continue;
      const descriptor = JSON.parse(await readFile(file, 'utf8')) as Descriptor;
      let alive = false;
      if (descriptor.daemonPid) try { process.kill(descriptor.daemonPid, 0); alive = true; } catch { /* gone */ }
      if (!alive) await rm(join(parent, name), { recursive: true, force: true });
    } catch { /* not ours to judge */ }
  }
}

export async function prepareRecorder(options: Options & { upstream: string; recordDir: string }): Promise<RecorderHandle> {
  const parent = options.directory;
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  await assertPrivate(parent, true);
  void sweep(parent);
  const id = randomBytes(16).toString('hex');
  const directory = join(parent, id);
  await mkdir(directory, { mode: 0o700 });
  const descriptor: Descriptor = { version: PROTOCOL, id, bootId: randomUUID(), sessionId: options.sessionId, fingerprint: options.fingerprint,
    proxyToken: randomBytes(24).toString('hex'), controlToken: randomBytes(32).toString('hex'), upstream: options.upstream, recordDir: options.recordDir, paused: false };
  const path = join(directory, 'descriptor.json');
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await writeDescriptor(path, descriptor);
    const own = fileURLToPath(import.meta.url);
    const built = /\.m?js$/.test(own);
    const args = built ? [join(dirname(own), 'daemon.mjs'), path]
      : ['--import', createRequire(import.meta.url).resolve('tsx'), fileURLToPath(new URL('./daemon.ts', import.meta.url)), path];
    child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
    let spawnError: Error | undefined;
    child.once('error', error => { spawnError = error; });
    child.unref();
    const deadline = Date.now() + STARTUP_MS;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Request recorder process exited during startup');
      try {
        const current = JSON.parse(await readFile(path, 'utf8')) as Descriptor;
        if (current.port) {
          const reply = await control(current, 'status');
          return makeHandle(current, options, reply.status);
        }
      } catch { /* The port is published asynchronously. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Request recorder process startup timed out');
  } catch (error) {
    child?.kill('SIGTERM');
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function recoverRecorder(options: Options & { id: string; address: string }): Promise<RecorderHandle | undefined> {
  if (!/^[a-f0-9]{32}$/.test(options.id)) return undefined;
  const directory = join(options.directory, options.id);
  try {
    await assertPrivate(options.directory, true);
    await assertPrivate(directory, true);
    await assertPrivate(join(directory, 'descriptor.json'), false);
    const descriptor = JSON.parse(await readFile(join(directory, 'descriptor.json'), 'utf8')) as Descriptor;
    if (descriptor.version !== PROTOCOL || descriptor.id !== options.id || descriptor.sessionId !== options.sessionId || descriptor.fingerprint !== options.fingerprint ||
        descriptor.native?.address !== options.address || !descriptor.port || !descriptor.bootId || !descriptor.controlToken || !descriptor.proxyToken) return undefined;
    if (descriptor.native.identity) {
      const identity = await processIdentity(descriptor.native.pid ?? 0);
      if (identity !== undefined && identity !== descriptor.native.identity) return undefined;
    }
    const reply = await control(descriptor, 'status');
    if (reply.nativeAddress !== options.address) return undefined;
    return makeHandle(descriptor, options, reply.status);
  } catch { return undefined; }
}
