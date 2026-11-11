import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { CodexAppServer, loopbackPort, verifiedLoopbackCredential, waitForOwnListener, type LoopbackLookup } from './codex-app-server.js';

const wsModule = createRequire(import.meta.url).resolve('ws');
const supported = process.platform === 'darwin' || process.platform === 'linux';
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

/** A stand-in app-server: a loopback WebSocket that answers JSON-RPC only to its bearer token. */
const fakeServer = `#!/usr/bin/env node
const { WebSocketServer } = require(${JSON.stringify(wsModule)});
const args = process.argv.slice(2);
const port = Number(new URL(args[args.indexOf('--listen') + 1]).port);
const token = require('node:fs').readFileSync(args[args.indexOf('--ws-token-file') + 1], 'utf8').trim();
const open = process.env.FAKE_NO_AUTH === '1';
const failInitialize = process.env.FAKE_FAIL_INITIALIZE;
const server = new WebSocketServer({ host: '127.0.0.1', port, verifyClient: (info, done) => done(open || info.req.headers.authorization === 'Bearer ' + token, 401) });
server.on('connection', socket => socket.on('message', raw => {
  const message = JSON.parse(String(raw));
  if (message.id !== undefined && message.method) {
    if (message.method === 'initialize' && failInitialize && require('node:fs').existsSync(failInitialize)) {
      socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: 'initialize refused' } }));
      return;
    }
    socket.send(JSON.stringify({ id: message.id, result: { method: message.method } }));
  }
}));
setInterval(() => {}, 1000);
`;

async function fixture(): Promise<{ executable: string; credentialDir: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'riffet-loopback-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'fake-app-server');
  await writeFile(executable, fakeServer);
  await chmod(executable, 0o755);
  return { executable, credentialDir: join(root, 'endpoints'), root };
}

const noop = { onNotification: () => undefined, onServerRequest: async () => undefined, onExit: () => undefined };

describe.skipIf(!supported)('loopback app-server transport', () => {
  it('spawns a token-guarded listener, reattaches only through the verified owner, and removes its token', async () => {
    const { executable, credentialDir, root } = await fixture();
    const owner = await CodexAppServer.start({ ...noop, executable, cwd: root, listen: 'ws', credentialDir });
    cleanups.push(() => owner.dispose());
    expect(owner.remoteAddress).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(owner.authToken).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(credentialDir)).mode & 0o777).toBe(0o700);
    const [tokenName] = await readdir(credentialDir);
    expect((await stat(join(credentialDir, tokenName!))).mode & 0o777).toBe(0o600);
    await expect(owner.request('ping')).resolves.toEqual({ method: 'ping' });

    const attached = await CodexAppServer.start({ ...noop, executable, cwd: root, remoteAddress: owner.remoteAddress, credentialDir });
    expect(attached.authToken).toBe(owner.authToken);
    await expect(attached.request('ping')).resolves.toEqual({ method: 'ping' });
    await attached.detach!();
    expect(await readdir(credentialDir)).toEqual([tokenName]);

    const elsewhere = join(root, 'other-endpoints');
    await expect(CodexAppServer.start({ ...noop, executable, cwd: root, remoteAddress: owner.remoteAddress, credentialDir: elsewhere }))
      .rejects.toMatchObject({ code: 'ECONNREFUSED' });

    // A later process reattaching and then explicitly closing ends the server the first one spawned.
    await owner.detach!();
    const successor = await CodexAppServer.start({ ...noop, executable, cwd: root, remoteAddress: owner.remoteAddress, credentialDir });
    await successor.dispose();
    expect(await readdir(credentialDir)).toEqual([]);
    await expect(CodexAppServer.start({ ...noop, executable, cwd: root, remoteAddress: owner.remoteAddress, credentialDir }))
      .rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('refuses a listener that answers without its token and leaves nothing behind', async () => {
    const { executable, credentialDir, root } = await fixture();
    process.env.FAKE_NO_AUTH = '1';
    try {
      await expect(CodexAppServer.start({ ...noop, executable, cwd: root, listen: 'ws', credentialDir }))
        .rejects.toMatchObject({ code: 'WS_AUTH_NOT_ENFORCED' });
    } finally {
      delete process.env.FAKE_NO_AUTH;
    }
    expect(await readdir(credentialDir)).toEqual([]);
  });

  it('detaches a borrowed connection whose handshake fails, leaving the owner and its token running', async () => {
    const { executable, credentialDir, root } = await fixture();
    const failFlag = join(root, 'fail-initialize');
    process.env.FAKE_FAIL_INITIALIZE = failFlag;
    try {
      const owner = await CodexAppServer.start({ ...noop, executable, cwd: root, listen: 'ws', credentialDir });
      cleanups.push(() => owner.dispose());
      const [tokenName] = await readdir(credentialDir);
      await writeFile(failFlag, '1');
      await expect(CodexAppServer.start({ ...noop, executable, cwd: root, remoteAddress: owner.remoteAddress, credentialDir }))
        .rejects.toThrow('initialize refused');
      // The failed handshake closed only its own connection; the owner still answers and keeps its token.
      expect(owner.isOnline).toBe(true);
      await expect(owner.request('ping')).resolves.toEqual({ method: 'ping' });
      expect(await readdir(credentialDir)).toEqual([tokenName]);

      await rm(failFlag, { force: true });
      const attached = await CodexAppServer.start({ ...noop, executable, cwd: root, remoteAddress: owner.remoteAddress, credentialDir });
      await expect(attached.request('ping')).resolves.toEqual({ method: 'ping' });
      await attached.detach!();
    } finally {
      delete process.env.FAKE_FAIL_INITIALIZE;
    }
  });
});

describe('loopback listener ownership', () => {
  const child = { pid: 4242, exitCode: null, signalCode: null } as unknown as ChildProcess;
  const lookup = (listeners: () => Promise<Array<{ pid: number; uid: number }>>, group?: number): LoopbackLookup => ({
    listeners, argv: async () => undefined, processGroup: async () => group,
  });

  it('accepts the spawned child, or a process in its group, once it listens', async () => {
    let calls = 0;
    await expect(waitForOwnListener(9, child, lookup(async () => (++calls < 3 ? Promise.reject(Object.assign(new Error('none yet'), { code: 1 })) : [{ pid: 4242, uid: 0 }])), 2_000)).resolves.toBeUndefined();
    await expect(waitForOwnListener(9, child, lookup(async () => [{ pid: 777, uid: 0 }], 4242), 2_000)).resolves.toBeUndefined();
  });

  it('refuses a port someone else took before the child bound it, before any token is sent', async () => {
    await expect(waitForOwnListener(9, child, lookup(async () => [{ pid: 777, uid: 0 }], 777), 2_000)).rejects.toThrow('Another process');
  });

  it('reports a host where the listener cannot be checked at all', async () => {
    await expect(waitForOwnListener(9, child, lookup(async () => Promise.reject(Object.assign(new Error('no lsof'), { code: 'ENOENT' }))), 2_000))
      .rejects.toMatchObject({ code: 'WS_UNVERIFIED' });
  });
});

describe('loopback credential verification', () => {
  it('accepts only an exact 127.0.0.1 address', () => {
    expect(loopbackPort('ws://127.0.0.1:51688')).toBe(51688);
    expect(loopbackPort('ws://localhost:51688')).toBeUndefined();
    expect(loopbackPort('ws://127.0.0.1:51688/x')).toBeUndefined();
    expect(loopbackPort('wss://127.0.0.1:51688')).toBeUndefined();
  });

  it('trusts only this user\'s app-server whose private token file sits in the credential directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-loopback-verify-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, 'endpoints');
    await writeFile(join(root, 'outside.token'), 'x', { mode: 0o600 });
    await import('node:fs/promises').then(fs => fs.mkdir(dir, { mode: 0o700 }));
    const good = join(dir, 'good.token');
    const loose = join(dir, 'loose.token');
    await writeFile(good, 'x', { mode: 0o600 });
    await writeFile(loose, 'x', { mode: 0o644 });
    await chmod(loose, 0o644);
    const uid = process.getuid?.() ?? 0;
    const lookup = (entries: Array<{ uid: number; argv: string[] }>): LoopbackLookup => ({
      listeners: async () => entries.map((entry, index) => ({ pid: index + 1, uid: entry.uid })),
      argv: async pid => entries[pid - 1]?.argv,
      processGroup: async () => undefined,
    });
    const argv = (file: string) => ['traex', 'app-server', '--listen', 'ws://127.0.0.1:9', '--ws-auth', 'capability-token', '--ws-token-file', file];
    await expect(verifiedLoopbackCredential(9, dir, lookup([{ uid, argv: argv(good) }]))).resolves.toMatchObject({ tokenFile: expect.stringMatching(/good\.token$/), pid: 1 });
    await expect(verifiedLoopbackCredential(9, dir, lookup([{ uid: uid + 1, argv: argv(good) }]))).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await expect(verifiedLoopbackCredential(9, dir, lookup([{ uid, argv: argv(join(root, 'outside.token')) }]))).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await expect(verifiedLoopbackCredential(9, dir, lookup([{ uid, argv: argv(loose) }]))).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await expect(verifiedLoopbackCredential(9, dir, lookup([{ uid, argv: ['python', '-m', 'http.server', '--ws-token-file', good] }]))).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
