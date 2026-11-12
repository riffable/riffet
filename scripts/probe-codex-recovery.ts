/**
 * Exercise writer ownership and read-only history against the installed Codex CLI.
 * Uses an isolated CODEX_HOME and a loopback provider that always fails: no credentials,
 * user conversations, inference service, or existing daemon are touched.
 * Run: node --import tsx scripts/probe-codex-recovery.ts
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServer, NO_SERVER_RESPONSE } from '../apps/server/src/backends/shared/codex-app-server.js';
import { stopWorkbenchAppServerAt } from '../apps/server/src/backends/shared/app-server-daemons.js';
import { requireCli } from './probe-sync-e2e-lib.js';

requireCli(process.env.CODEX_CLI ?? 'codex', 'Codex', 'Install the Codex CLI (`npm i -g @openai/codex`), or set CODEX_CLI.');

const directory = await mkdtemp(join(tmpdir(), 'riffet-recovery-probe-'));
const probeHome = join(directory, 'codex');
const workspace = join(directory, 'workspace');
const clients: CodexAppServer[] = [];
const provider = createServer((_request, response) => {
  response.writeHead(503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: { message: 'Intentional local recovery probe failure' } }));
});
try {
  await mkdir(probeHome);
  await mkdir(workspace);
  await new Promise<void>((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.address();
  assert(address && typeof address !== 'string');
  await writeFile(join(probeHome, 'config.toml'), [
    'model = "recovery-probe"',
    'model_provider = "recovery_probe"',
    'approval_policy = "never"',
    '[model_providers.recovery_probe]',
    'name = "Isolated recovery probe"',
    `base_url = "http://127.0.0.1:${address.port}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    'supports_websockets = false',
  ].join('\n'));

  const start = async (effort: string, remoteAddress?: string) => {
    const client = await CodexAppServer.start({
      executable: process.env.CODEX_CLI ?? 'codex',
      args: ['-c', `model_reasoning_effort="${effort}"`],
      cwd: workspace,
      requiredHumanApproval: true,
      // Isolated configuration intentionally excludes user authentication and plugins.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CODEX_HOME: probeHome },
      ...(remoteAddress ? { remoteAddress } : {}),
      onNotification: () => undefined,
      onServerRequest: async () => NO_SERVER_RESPONSE,
      onExit: () => undefined,
    });
    clients.push(client);
    return client;
  };
  const owner = await start('low');
  const { thread } = await owner.request<{ thread: { id: string } }>('thread/start', {
    cwd: workspace, model: 'recovery-probe', approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false,
  });
  // Persist one harmless user item. The loopback provider cannot run a model or a tool.
  await owner.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Isolated recovery history probe.', text_elements: [] }] });
  const deadline = Date.now() + 20_000;
  let stored = false;
  while (Date.now() < deadline) {
    try {
      const result = await owner.request<{ thread: { turns?: unknown[]; status?: { type: string } } }>('thread/read', { threadId: thread.id, includeTurns: true });
      if (result.thread.turns?.length && result.thread.status?.type !== 'active') { stored = true; break; }
    } catch { /* Initial persistence can trail turn/start. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(stored, 'The isolated failed turn must become readable before the ownership probe');
  const reader = await start('medium');
  assert.notEqual(reader.remoteAddress, owner.remoteAddress, 'Probe requires two distinct endpoints');
  const history = await reader.request<{ thread: { id: string; turns?: unknown[] } }>('thread/read', { threadId: thread.id, includeTurns: true });
  assert.equal(history.thread.id, thread.id);
  assert(history.thread.turns?.length, 'A different endpoint must read stored history without resuming');
  const loadedBefore = await reader.request<{ data: string[] }>('thread/loaded/list', {});
  assert(!loadedBefore.data.includes(thread.id), 'Reading history must not load the thread');
  await assert.rejects(reader.request('thread/resume', { threadId: thread.id, excludeTurns: true }), /active writer/i);
  const attached = await start('low', owner.remoteAddress);
  const resumed = await attached.request<{ thread: { id: string } }>('thread/resume', { threadId: thread.id, excludeTurns: true });
  assert.equal(resumed.thread.id, thread.id);
  await attached.detach();
  const loadedAfter = await owner.request<{ data: string[] }>('thread/loaded/list', {});
  assert(loadedAfter.data.includes(thread.id), 'Detaching a borrowed connection must preserve the owner');
  const metadata = await owner.request<{ thread: { cwd?: string } }>('thread/read', { threadId: thread.id, includeTurns: false });
  assert.equal(metadata.thread.cwd, await realpath(workspace), 'Legacy ownership recovery requires protocol workspace evidence');
  assert(await stopWorkbenchAppServerAt(owner.remoteAddress, []), 'Explicit replacement must stop the verified old process group');
  const replacement = await start('high');
  const reopened = await replacement.request<{ thread: { id: string } }>('thread/resume', { threadId: thread.id, excludeTurns: true });
  assert.equal(reopened.thread.id, thread.id);
  console.log(JSON.stringify({ result: 'passed', checks: ['read-history-without-resume', 'read-does-not-load-thread', 'exclusive-writer', 'reattach-original-endpoint', 'detach-preserves-owner', 'workspace-evidence', 'stop-old-owner-and-resume-same-thread'] }));
} finally {
  // Reverse order detaches borrowed readers before stopping the servers owned by this probe.
  const cleanup = await Promise.allSettled(clients.reverse().map(client => client.dispose()));
  provider.closeAllConnections();
  await new Promise<void>(resolve => provider.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
  const failure = cleanup.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
