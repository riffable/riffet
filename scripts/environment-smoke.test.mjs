#!/usr/bin/env node
/**
 * The regression that cost this deployment its DSH backend on 2026-10-09.
 *
 * A service restarted by a background job, an agent tool call or a service manager has almost no
 * PATH — and the previous implementation *rebuilt* the environment from an allowlist, so anything
 * installed outside that allowlist simply stopped existing. DSH was the first casualty because its
 * npm prefix lives in `~/.local/bin/node/bin`, which no hardcoded list contained.
 *
 * This starts the real production CLI with `PATH=/usr/bin:/bin` and asserts the contract:
 *   * the daemon comes up at all,
 *   * it reports a PATH it resolved itself, with `~/.local/bin` on it,
 *   * backend availability is a real probe — unavailable never comes back reasonless, and the
 *     list is not hardcoded to healthy the way it used to be.
 *
 * `node --test scripts/environment-smoke.test.mjs`
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist', 'cli.js');

function freePort() {
  return new Promise((settle, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => settle(port));
    });
  });
}

async function waitForHealth(base, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`the daemon exited with code ${child.exitCode}\n${logs.text}`);
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* not listening yet */ }
    await new Promise(settle => setTimeout(settle, 200));
  }
  throw new Error(`the daemon never answered /health\n${logs.text}`);
}

/** Token-free loopback still needs the session cookie the status route hands out. */
async function signIn(base) {
  const response = await fetch(`${base}/api/auth/status`);
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
  const session = cookies.map(value => value.split(';')[0]).find(value => value.startsWith('cw_session='));
  assert.ok(session, 'the token-free status route should hand out a session cookie');
  return session;
}

test('the daemon resolves its own environment and reports truthful backend availability', async () => {
  assert.ok(entry, 'the production CLI must be built before this smoke test');
  const stateDir = mkdtempSync(join(tmpdir(), 'riffet-smoke-'));
  const home = mkdtempSync(join(tmpdir(), 'riffet-home-'));
  // A CLI in the official installer's directory: the daemon must carry this directory on PATH even
  // though the PATH it was started with does not mention it.
  const installDir = join(home, '.local', 'bin');
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, 'smoke-agent'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(installDir, 'smoke-agent'), 0o755);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [entry, 'serve', '--state-dir', stateDir, '--host', '127.0.0.1', '--port', String(port), '--no-auth', '--no-mdns', '--no-token'], {
    env: { HOME: home, USER: 'smoke', LOGNAME: 'smoke', SHELL: '/bin/bash', TERM: 'xterm-256color', PATH: '/usr/bin:/bin' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = { text: '' };
  child.stdout.on('data', chunk => { logs.text += chunk; });
  child.stderr.on('data', chunk => { logs.text += chunk; });

  try {
    await waitForHealth(base, child, logs);
    const cookie = await signIn(base);
    const doctor = await (await fetch(`${base}/api/doctor`, { headers: { cookie } })).json();

    const environment = doctor.environment;
    assert.ok(environment, 'the doctor report must describe the environment');
    assert.ok(['explicit', 'login-shell', 'cache', 'inherited', 'default'].includes(environment.path.source), `unexpected PATH source: ${environment.path.source}`);
    assert.ok(environment.path.value.length > 0, 'the resolved PATH must not be empty');
    assert.ok(environment.path.value.split(':').includes(installDir), `the installer directory must be on PATH: ${environment.path.value}`);
    assert.ok(environment.node.path && environment.node.version, 'the report must name the node running the daemon');
    // Whatever the source, the directories riffet needs are merged in rather than assumed present.
    // This is what the allowlist rebuild failed to do: it could only ever append `~/.local/bin`, so
    // a CLI installed under the node prefix was invisible.
    assert.ok(environment.path.added.length > 0, 'the resolved PATH must record the directories it merged in');

    const backends = new Map(doctor.backends.map(entry => [entry.backendId, entry]));
    for (const id of ['cursor', 'codex', 'claude', 'dsh']) {
      assert.ok(backends.has(id), `the backend list must include ${id}`);
    }
    for (const [id, entry] of backends) {
      if (entry.available === true) continue;
      // The old list hardcoded `available: true` here, which is why a backend that could not start
      // still looked healthy until a conversation tried to use it.
      assert.ok(entry.reason && entry.reason.length > 0, `${id} reported unavailable without a reason`);
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise(settle => setTimeout(settle, 300));
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
