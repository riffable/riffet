import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentContext, AgentHost, AgentInteractionReceipt, AgentRunRef, AgentSendRequest } from '@riffet/plugin-api/experimental/agent';
import { AntigravityBackend } from './backend.js';
import { writeJson } from './bridge.js';
import { interactionOf } from './interactions.js';
import type { AgyRecord, AgySnapshot } from './protocol.js';
import { required } from './lifecycle.js';
import { validateMcp } from './mcp-scope.js';
import { poll } from './poll.js';
import { receipts } from './receipts.js';
import type { Hub } from './runtime.js';
import { agyStepIdentity } from './transcript.js';

vi.mock('./lifecycle.js', async importOriginal => ({ ...(await importOriginal<typeof import('./lifecycle.js')>()), required: vi.fn() }));

const hub = (backend: AntigravityBackend) => (backend as unknown as { hub: Hub }).hub;

const conversationId = '11111111-1111-1111-1111-111111111111';
const trajectoryId = '22222222-2222-2222-2222-222222222222';
const otherId = '33333333-3333-3333-3333-333333333333';
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
function user(executionId: string, stepIndex: number, text: string): AgyRecord {
  return {
    type: 'CORTEX_STEP_TYPE_USER_INPUT',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      executionId,
      createdAt: '2026-11-13T00:00:00Z',
      sourceTrajectoryStepInfo: { trajectoryId, stepIndex, cascadeId: conversationId },
    },
    userInput: { userResponse: text },
  };
}
function snapshot(steps: AgyRecord[] = []): AgySnapshot {
  return { conversationId, trajectoryId, steps, executors: [], status: 'CASCADE_RUN_STATUS_IDLE' };
}
/** Narrow test host: only the external contract boundaries exercised below exist. */
async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'riffet-agy-backend-'));
  directories.push(stateDir);
  const root = join(stateDir, 'sessions', 'session'),
    geminiDir = join(root, 'native'),
    bridgeDir = join(root, 'workspace');
  const cwd = join(stateDir, 'project');
  await mkdir(cwd, { recursive: true });
  const session = {
    id: 'session',
    projectId: 'project',
    backendId: 'antigravity',
    nativeSessionId: conversationId,
    terminalId: 'terminal',
    configPending: false,
  };
  const context = { session, project: { id: 'project', cwd }, profile: { id: 'default', config: {} } } as unknown as AgentContext;
  const saved = new Map<string, AgentInteractionReceipt>(),
    pending: AgentRunRef[] = [];
  const inspect = vi.fn(async () => [12345]),
    emitEvent = vi.fn(),
    emit = vi.fn();
  const host = {
    error: (code: string, message: string) => Object.assign(new Error(message), { code }),
    view: { session: () => session, terminal: () => ({ state: 'running' }) },
    terminals: { inspect, get: vi.fn(async () => ({ id: 'terminal', epoch: 1 })), interact: vi.fn() },
    transcript: { wake: vi.fn() },
    emitEvent,
    emit,
    runs: { find: vi.fn(async () => pending) },
    commitDispatchFence: vi.fn(async () => {}),
    dialogs: { owns: () => false },
    interactionReceipts: {
      get: vi.fn(async (_id: string, requestId: string) => saved.get(requestId)),
      save: vi.fn(async (_id: string, requestId: string, receipt: AgentInteractionReceipt) => {
        saved.set(requestId, receipt);
        return receipt;
      }),
    },
  } as unknown as AgentHost;
  const runtime = {
    host,
    context,
    launch: {
      root,
      geminiDir,
      bridgeDir,
      command: 'agy',
      args: [],
      marker: 'test-marker',
      nonce: 'test-nonce',
      terminalId: 'terminal',
      epoch: 1,
      startedAt: 1,
    },
    rpc: { snapshot: vi.fn(async () => runtime.snapshot), call: vi.fn(), stream: vi.fn(() => new Promise<void>(() => {})) },
    snapshot: snapshot(),
    status: { phase: 'idle', connection: { state: 'connected' } },
    models: [],
    stopped: false,
    stream: new AbortController(),
    streamId: conversationId,
    verifiedAt: Date.now(),
  } as any;
  const backend = new AntigravityBackend({ stateDir });
  vi.mocked(required).mockResolvedValue(runtime);
  const status = async (payload: AgyRecord) =>
    writeJson(join(root, 'bridge', 'status.json'), { nonce: runtime.launch.nonce, at: 10, payload });
  await status({ conversation_id: conversationId, agent_state: 'idle' });
  const hook = async (payload: AgyRecord) =>
    writeJson(join(root, 'bridge', `${conversationId}.json`), { nonce: runtime.launch.nonce, at: 10, payload });
  return { backend, runtime, host, context, session, root, geminiDir, bridgeDir, cwd, pending, saved, emitEvent, emit, status, hook };
}

it('persists the dispatch fence before the first paste and never retries terminal writes after failure', async () => {
  const f = await fixture(),
    operations: string[] = [];
  const request = {
    context: f.context,
    runId: 'run',
    commandId: 'command',
    input: { text: 'Hello', context: [], attachmentIds: [] },
    config: { mode: 'agent' },
  } as AgentSendRequest;
  vi.mocked(f.host.commitDispatchFence).mockImplementation(async () => {
    operations.push('fence');
  });
  const paste = vi.fn(async () => {
      operations.push('paste');
      throw new Error('terminal disconnected');
    }),
    keys = vi.fn();
  vi.mocked(f.host.terminals.interact).mockImplementation(async (_id, body) =>
    body({ screen: async () => '────────\n>\n────────', paste, keys } as any),
  );
  await expect(f.backend.send(f.host, request)).rejects.toThrow('terminal disconnected');
  expect(operations).toEqual(['fence', 'paste']);
  expect(keys).not.toHaveBeenCalled();
  const binding = vi.mocked(f.host.commitDispatchFence).mock.calls[0][1]!;
  expect(binding.terminal).toEqual({ id: 'terminal', epoch: 1 });
  expect(JSON.parse(binding.nativeInputBoundary!)).toMatchObject({ root: f.geminiDir, id: conversationId, trajectoryId, users: [] });
  f.pending.push({
    id: 'run',
    sessionId: 'session',
    commandId: 'command',
    state: 'interrupted',
    delivery: 'uncertain',
    renderedText: 'Hello',
    nativeInputBoundary: binding.nativeInputBoundary,
  });
  f.runtime.snapshot = snapshot([user('native-run', 0, 'Hello')]);
  await receipts(f.runtime);
  await receipts(f.runtime);
  expect(paste).toHaveBeenCalledTimes(1);
  expect(keys).not.toHaveBeenCalled();
  vi.mocked(f.host.commitDispatchFence).mockRejectedValueOnce(new Error('fence unavailable'));
  await expect(f.backend.send(f.host, request)).rejects.toThrow('fence unavailable');
  expect(paste).toHaveBeenCalledTimes(1);
});

it('rejects diverged input branches and duplicate candidates while confirming large inputs by native identity', async () => {
  const f = await fixture(),
    large = 'x'.repeat(50_000),
    ancestor = user('ancestor', 0, 'One'),
    previous = user('previous', 1, 'Two');
  const baseline = snapshot([ancestor, previous]);
  f.pending.push({
    id: 'run',
    sessionId: 'session',
    commandId: 'command',
    state: 'interrupted',
    delivery: 'uncertain',
    renderedText: large,
    nativeInputBoundary: JSON.stringify({
      version: 1,
      root: f.geminiDir,
      id: conversationId,
      trajectoryId,
      users: baseline.steps.map((step, i) => agyStepIdentity(baseline, step, i)),
    }),
  });
  f.runtime.snapshot = snapshot([ancestor, user('replacement', 1, large)]);
  await receipts(f.runtime);
  expect(f.emitEvent).not.toHaveBeenCalled();
  f.runtime.snapshot = snapshot([ancestor, previous, user('new-execution', 2, large)]);
  await receipts(f.runtime);
  expect(f.emitEvent).toHaveBeenCalledTimes(1);
  expect(f.emitEvent.mock.calls[0][1]).toMatchObject({
    type: 'native_input_receipt',
    nativeTurnId: 'new-execution',
    runId: 'run',
    data: { commandId: 'command' },
  });
  f.emitEvent.mockClear();
  // A new frame is a new snapshot; the runtime never edits one in place.
  f.runtime.snapshot = { ...f.runtime.snapshot, steps: [...f.runtime.snapshot.steps, user('duplicate-execution', 3, large)] };
  await receipts(f.runtime);
  expect(f.emitEvent).not.toHaveBeenCalled();
  f.runtime.snapshot = { ...snapshot([ancestor, previous, user('new-execution', 2, large)]), trajectoryId: otherId };
  await receipts(f.runtime);
  expect(f.emitEvent).not.toHaveBeenCalled();
});

it('recovers a saved uncertain interaction after restart through reads without repeating its native write', async () => {
  const f = await fixture(),
    request = { permission: { actionDescription: 'Run command', resource: { action: 'command', target: 'echo hello' } } };
  const waiting = snapshot([
    {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: { executionId: 'execution' },
      requestedInteraction: request,
    },
  ]);
  const target = interactionOf(waiting)!;
  const response = { interactionId: target.view.id, revision: target.view.revision, requestId: 'answer', action: 'deny' };
  f.runtime.rpc.snapshot.mockResolvedValueOnce(waiting).mockRejectedValueOnce(new Error('reader disconnected'));
  f.runtime.rpc.call.mockRejectedValueOnce(new Error('reply lost'));
  await expect(f.backend.respond(f.host, f.context, response)).rejects.toThrow('reader disconnected');
  expect(f.saved.get('answer')?.result.status).toBe('uncertain');
  expect(f.runtime.rpc.call).toHaveBeenCalledTimes(1);
  const restarted = new AntigravityBackend({ stateDir: join(f.root, '..', '..') });
  const complete = snapshot([
    {
      ...waiting.steps[0],
      status: 'CORTEX_STEP_STATUS_ERROR',
      completedInteractions: [{ request, response: { trajectoryId, stepIndex: 0, permission: {} } }],
    },
  ]);
  f.runtime.rpc.snapshot.mockResolvedValue({ ...complete, trajectoryId: otherId });
  expect(await restarted.respond(f.host, f.context, response)).toEqual({ status: 'uncertain' });
  f.runtime.rpc.snapshot.mockResolvedValue(complete);
  expect(await restarted.respond(f.host, f.context, response)).toEqual({ status: 'completed' });
  expect(f.saved.get('answer')?.result.status).toBe('completed');
  expect(f.runtime.rpc.call).toHaveBeenCalledTimes(1);
  await expect(restarted.respond(f.host, f.context, { ...response, action: 'allow' })).rejects.toMatchObject({
    code: 'INTERACTION_REQUEST_CONFLICT',
  });
});

it('checks per-call MCP namespace, root and workspace and fences the binding when the TUI clears its conversation', async () => {
  const f = await fixture(),
    metadata = {
      'antigravity.google/conversation_id': conversationId,
      'antigravity.google/root_conversation_id': conversationId,
      'antigravity.google/artifacts_dir': join(f.geminiDir, 'antigravity-cli', 'brain', conversationId),
    };
  await f.hook({ conversationId, workspacePaths: [f.cwd], cwd: f.bridgeDir });
  await expect(validateMcp(hub(f.backend), f.runtime, metadata)).resolves.toBeUndefined();
  await expect(
    validateMcp(hub(f.backend), f.runtime, {
      conversation_id: conversationId,
      root_conversation_id: conversationId,
      artifacts_dir: metadata['antigravity.google/artifacts_dir'],
    }),
  ).rejects.toThrow('scope');
  await expect(validateMcp(hub(f.backend), f.runtime, { ...metadata, 'antigravity.google/root_conversation_id': otherId })).rejects.toThrow(
    'scope',
  );
  await expect(validateMcp(hub(f.backend), f.runtime, { ...metadata, 'antigravity.google/artifacts_dir': f.cwd })).rejects.toThrow(
    'artifacts',
  );
  await f.hook({ conversationId, workspacePaths: [f.cwd], cwd: '/outside' });
  await expect(validateMcp(hub(f.backend), f.runtime, metadata)).rejects.toThrow('workspace');
  await f.hook({ conversationId, workspacePaths: [f.cwd], cwd: f.bridgeDir });
  await f.status({ conversation_id: '', agent_state: 'idle' });
  await poll(hub(f.backend), f.runtime);
  expect(f.runtime.status.connection.state).toBe('conflict');
  expect(f.session.nativeSessionId).toBe(conversationId);
  expect(f.runtime.stream.signal.aborted).toBe(true);
  await expect(validateMcp(hub(f.backend), f.runtime, metadata)).rejects.toThrow('offline');
});
