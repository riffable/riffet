import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServer, NO_SERVER_RESPONSE } from './codex-app-server.js';

const processGroupsSupported = process.platform !== 'win32';
const clients: CodexAppServer[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.dispose().catch(() => undefined)));
});

describe.skipIf(!processGroupsSupported)('Codex app-server process group cleanup', () => {
  it('disposes both the Node wrapper and its inherited child process', async () => {
    const fixture = await createFixture('normal');
    try {
      const client = await startFixture(fixture);
      const [wrapperPid, childPid] = await fixture.pids();

      await client.dispose();
      await Promise.all([waitForPidExit(wrapperPid), waitForPidExit(childPid)]);
      expect(pidIsAlive(wrapperPid)).toBe(false);
      expect(pidIsAlive(childPid)).toBe(false);
      await expect(stat(dirname(client.socketPath))).rejects.toThrow();

      // Repeated disposal returns the same completed cleanup operation.
      await expect(client.dispose()).resolves.toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  });

  it('cleans up an inherited child after its wrapper has already exited', async () => {
    const fixture = await createFixture('normal');
    try {
      const client = await startFixture(fixture);
      const [wrapperPid, childPid] = await fixture.pids();

      process.kill(wrapperPid, 'SIGKILL');
      await waitForPidExit(wrapperPid);
      expect(pidIsAlive(childPid)).toBe(true);

      await client.dispose();
      await waitForPidExit(childPid);
      expect(pidIsAlive(childPid)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('escalates to SIGKILL when an inherited child ignores SIGTERM', async () => {
    const fixture = await createFixture('ignore-term');
    try {
      const client = await startFixture(fixture);
      const [, childPid] = await fixture.pids();

      // Wait for the handler, then observe a real ignored SIGTERM before
      // asking dispose to clean up the group.
      await waitForPid(join(fixture.directory, 'child.pid.ready'));
      process.kill(childPid, 'SIGTERM');
      expect(await waitForPid(join(fixture.directory, 'child.pid.term'))).toBe(childPid);
      expect(pidIsAlive(childPid)).toBe(true);

      await client.dispose();
      await waitForPidExit(childPid);
      expect(pidIsAlive(childPid)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('cleans up the process group when startup fails before the socket opens', async () => {
    const fixture = await createFixture('startup-fail');
    try {
      await expect(startFixture(fixture)).rejects.toThrow('before opening its socket');
      const [wrapperPid, childPid] = await fixture.pids();
      await Promise.all([waitForPidExit(wrapperPid), waitForPidExit(childPid)]);
      expect(pidIsAlive(wrapperPid)).toBe(false);
      expect(pidIsAlive(childPid)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reattaches to an existing canonicalized socket without spawning or owning its server', async () => {
    const fixture = await createFixture('normal');
    try {
      const owner = await startFixture(fixture);
      const [wrapperPid, childPid] = await fixture.pids();
      expect(owner.remoteAddress).toBe(`unix://${await realpath(owner.socketPath)}`);

      await owner.detach?.();
      expect(pidIsAlive(wrapperPid)).toBe(true);
      expect(pidIsAlive(childPid)).toBe(true);
      await expect(stat(dirname(owner.socketPath))).resolves.toBeDefined();

      const attached = await CodexAppServer.start({
        executable: '/riffet-test-executable-must-not-spawn',
        cwd: process.cwd(),
        remoteAddress: `unix://${owner.socketPath}`,
        onNotification: () => undefined,
        onServerRequest: async () => NO_SERVER_RESPONSE,
        onExit: () => undefined,
      });
      clients.push(attached);
      fixture.clients.push(attached);
      expect(attached.remoteAddress).toBe(owner.remoteAddress);
      await expect(attached.request('fixture/ping')).resolves.toEqual({ method: 'fixture/ping' });

      await attached.dispose();
      expect(pidIsAlive(wrapperPid)).toBe(true);
      expect(pidIsAlive(childPid)).toBe(true);

      await owner.dispose();
      await Promise.all([waitForPidExit(wrapperPid), waitForPidExit(childPid)]);
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves ECONNREFUSED when an attached Unix socket is stale', async () => {
    const fixture = await createFixture('normal');
    try {
      const owner = await startFixture(fixture);
      const [wrapperPid, childPid] = await fixture.pids();
      await owner.detach?.();

      // SIGKILL leaves the listening Unix socket entry behind, matching a
      // daemon that has stopped accepting connections without removing its path.
      process.kill(wrapperPid, 'SIGKILL');
      await waitForPidExit(wrapperPid);
      expect(pidIsAlive(childPid)).toBe(true);

      const attemptedAt = Date.now();
      let attachError: unknown;
      try {
        await CodexAppServer.start({
          executable: '/riffet-test-executable-must-not-spawn',
          cwd: process.cwd(),
          remoteAddress: owner.remoteAddress,
          onNotification: () => undefined,
          onServerRequest: async () => NO_SERVER_RESPONSE,
          onExit: () => undefined,
        });
      } catch (error) {
        attachError = error;
      }

      expect(attachError).toMatchObject({ code: 'ECONNREFUSED' });
      expect(Date.now() - attemptedAt).toBeLessThan(1_000);
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects remote addresses outside the absolute Unix socket URI form', async () => {
    await expect(CodexAppServer.start({
      executable: '/riffet-test-executable-must-not-spawn',
      cwd: process.cwd(),
      remoteAddress: 'https://example.test/socket',
      onNotification: () => undefined,
      onServerRequest: async () => NO_SERVER_RESPONSE,
      onExit: () => undefined,
    })).rejects.toThrow('must be a Unix socket URI');
  });
});

interface Fixture {
  directory: string;
  mode: 'normal' | 'ignore-term' | 'startup-fail';
  clients: CodexAppServer[];
  pids(): Promise<[number, number]>;
  cleanup(): Promise<void>;
}

async function createFixture(mode: 'normal' | 'ignore-term' | 'startup-fail'): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'riffet-codex-app-server-test-'));
  await writeFile(join(directory, 'wrapper.cjs'), wrapperScript);
  await writeFile(join(directory, 'child.cjs'), childScript);
  const fixture: Fixture = {
    directory,
    mode,
    clients: [],
    async pids() {
      const [wrapper, child] = await Promise.all([
        waitForPid(join(directory, 'wrapper.pid')),
        waitForPid(join(directory, 'child.pid')),
      ]);
      return [wrapper, child];
    },
    async cleanup() {
      await Promise.all(fixture.clients.map(client => client.dispose().catch(() => undefined)));
      await rm(directory, { recursive: true, force: true });
    },
  };
  return fixture;
}

async function startFixture(fixture: Fixture): Promise<CodexAppServer> {
  const client = await CodexAppServer.start({
    executable: process.execPath,
    args: [
      join(fixture.directory, 'wrapper.cjs'),
      join(fixture.directory, 'wrapper.pid'),
      join(fixture.directory, 'child.pid'),
      fixture.mode,
      createRequire(import.meta.url).resolve('ws'),
      join(fixture.directory, 'child.cjs'),
    ],
    cwd: process.cwd(),
    onNotification: () => undefined,
    onServerRequest: async () => NO_SERVER_RESPONSE,
    onExit: () => undefined,
  });
  clients.push(client);
  fixture.clients.push(client);
  return client;
}

const wrapperScript = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const wrapperPidFile = process.argv[2];
const http = require('node:http');
const { WebSocketServer } = require(process.argv[5]);
const childPidFile = process.argv[3];
const mode = process.argv[4];
const childScript = process.argv[6];
const args = process.argv.slice(7);
const listenIndex = args.indexOf('--listen');
const socketPath = args[listenIndex + 1].slice('unix://'.length);
fs.writeFileSync(wrapperPidFile, String(process.pid));
const child = spawn(process.execPath, [childScript, mode, childPidFile], { stdio: 'ignore' });
fs.writeFileSync(childPidFile, String(child.pid));
if (mode === 'startup-fail') process.exit(0);
const server = http.createServer();
const daemonSocketPath = socketPath + '.daemon';
fs.symlinkSync(daemonSocketPath, socketPath);
const wss = new WebSocketServer({ server });
wss.on('connection', socket => socket.on('message', data => {
  const request = JSON.parse(data.toString());
  if (request.id !== undefined) socket.send(JSON.stringify({ id: request.id, result: { method: request.method } }));
}));
server.listen(daemonSocketPath);
`;

const childScript = `
const fs = require('node:fs');
const pidFile = process.argv[3];
if (process.argv[2] === 'ignore-term') {
  process.on('SIGTERM', () => fs.writeFileSync(pidFile + '.term', String(process.pid)));
  fs.writeFileSync(pidFile + '.ready', String(process.pid));
}
setInterval(() => {}, 1000);
`;

async function waitForPid(file: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(file, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch { /* The fixture writes its PID files during startup. */ }
    await delay(20);
  }
  throw new Error(`Timed out waiting for fixture PID file: ${file}`);
}

async function waitForPidExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) return;
    await delay(20);
  }
  throw new Error(`Fixture process ${pid} did not exit`);
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return true;
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
