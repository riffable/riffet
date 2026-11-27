import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentContext, AgentHost, AgentInteractionReceipt, AgentRunRef, AgentSendRequest } from '@riffet/plugin-api/experimental/agent';
import * as kit from '@riffet/plugin-api/kit';
import { AntigravityBackend } from './backend.js';
import { writeJson } from './bridge.js';
import { interactionOf } from './interactions.js';
import type { AgyRecord, AgySnapshot } from './protocol.js';
import { required } from './lifecycle.js';
import { mcpConfigPath, mcpReady, mcpServerName, validateMcp } from './mcp-scope.js';
import { poll } from './poll.js';
import { receipts } from './receipts.js';
import { foregroundIdle, idle, type Hub } from './runtime.js';
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

it('lists home skills only for the default Gemini root and gives its native skills precedence', async () => {
  const { backend, host, context, cwd, root, geminiDir } = await fixture();
  vi.stubEnv('HOME', cwd);
  try {
    for (const [root, name] of [['.agents/skills', 'shared'], ['.agents/skills', 'both'], ['.gemini/config/skills', 'both'], ['private/skills', 'private']] as const) {
      const dir = join(cwd, root, name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${root}\n---\n`);
    }
    const profile = context.profile;
    const privateProfile = { ...profile, config: { sourceDir: join(cwd, 'private') } };
    const skills = await backend.slashItems(host, undefined, profile);
    expect(skills.map(skill => skill.name)).toEqual(['both', 'shared']);
    expect(skills[0]?.description).toBe('.gemini/config/skills');
    expect((await backend.slashItems(host, undefined, privateProfile)).map(skill => skill.name)).toEqual(['private']);
    expect(backend.extensionLayout(privateProfile).sharedRoot).toBeUndefined();

    const legacySkill = join(geminiDir, 'skills', 'legacy');
    await mkdir(legacySkill, { recursive: true });
    await writeFile(join(legacySkill, 'SKILL.md'), '---\nname: legacy\ndescription: private copy\n---\n');
    await writeFile(join(root, 'initialized.json'), JSON.stringify({ version: 1 }));
    expect((await backend.slashItems(host, undefined, profile, context.session)).map(skill => skill.name)).toEqual(['legacy']);
  } finally {
    vi.unstubAllEnvs();
  }
});

it('opens a side chat in a private scope, refuses an unexpected native agent and removes its files', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'riffet-agy-side-test-'));
  directories.push(stateDir);
  const backend = new AntigravityBackend({ stateDir });
  const host = { modelSources: { resolve: async () => undefined }, error: (_code: string, message: string) => new Error(message) } as unknown as AgentHost;
  let native = '';
  const launch = vi.spyOn(kit, 'runProcess').mockImplementation(async (_file, args, options) => {
    native = args.find(arg => arg.startsWith('--gemini_dir='))!.slice('--gemini_dir='.length);
    expect(await readdir(options.cwd)).toEqual([]);
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!);
    expect(settings).toMatchObject({ toolPermission: 'strict', allowNonWorkspaceAccess: false });
    const hooks = JSON.parse(await readFile(join(native, 'config', 'hooks.json'), 'utf8'));
    expect(hooks.discussion.PreToolUse[0]).toMatchObject({ matcher: '*', hooks: [{ command: expect.stringContaining('"decision":"deny"') }] });
    expect(await readFile(join(native, 'config', 'agents', 'riffet-discussion.md'), 'utf8')).toContain('tools: []');
    options.onStdoutLine!(JSON.stringify({ event: 'init', init: { agent: 'default', permission_mode: 'strict' } }));
    throw new Error('Unexpected native agent was accepted');
  });
  const onDelta = vi.fn();
  const request = {
    model: '', system: 'side question', messages: [{ role: 'user', content: 'question' }],
    signal: new AbortController().signal, maxOutputTokens: 100, idleTimeoutMs: 1000, onDelta,
  } satisfies Parameters<AntigravityBackend['streamDiscussion']>[2];
  await expect(backend.streamDiscussion(host, { id: 'local', name: 'Account', config: {} }, request)).rejects.toThrow('Gemini API key');
  expect(launch).not.toHaveBeenCalled();
  await expect(backend.streamDiscussion(host, { id: 'p', name: 'Test', config: { sourceDir: stateDir, apiKey: 'test-key' } }, request)).rejects.toThrow('restricted side chat');
  expect(onDelta).not.toHaveBeenCalled();
  await expect(access(native)).rejects.toMatchObject({ code: 'ENOENT' });
});

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

it('re-presses Enter if Antigravity keeps the pasted prompt in the composer after the first Enter', async () => {
  const f = await fixture();
  const request = {
    context: f.context,
    runId: 'run-retry-enter',
    commandId: 'command-retry-enter',
    input: { text: 'Retry Enter prompt', context: [], attachmentIds: [] },
    config: { mode: 'agent' },
  } as AgentSendRequest;
  let screen = '────────\n>\n────────';
  let enters = 0;
  const paste = vi.fn(async (text: string) => { screen = `────────\n> ${text}\n────────`; });
  const keys = vi.fn(async (pressed: string[]) => {
    if (pressed.includes('Enter')) {
      enters += 1;
      if (enters >= 2) screen = '────────\n>\n────────';
    }
  });
  vi.mocked(f.host.terminals.interact).mockImplementation(async (_id, body) =>
    body({ screen: async () => screen, paste, keys } as any),
  );
  await f.backend.send(f.host, request);
  expect(paste).toHaveBeenCalledTimes(1);
  expect(keys.mock.calls).toEqual([[['Enter']], [['Enter']]]);
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

it('accepts Riffet MCP readiness for members with delegations disabled (without list_wakeups)', async () => {
  const f = await fixture();
  const name = mcpServerName('session');
  await writeJson(mcpConfigPath(f.runtime.launch), { mcpServers: { [name]: { command: 'node', args: [] } } });
  f.runtime.rpc.call.mockResolvedValueOnce({
    isLoading: false,
    states: [
      {
        spec: { serverName: name },
        status: 'MCP_SERVER_STATUS_READY',
        tools: [{ name: 'read_context' }, { name: 'notify_user' }],
      },
    ],
  });
  await expect(mcpReady(f.runtime, { screen: async () => '', paste: async () => {}, keys: async () => {} } as any)).resolves.toBeUndefined();
});

it('handles /new topic reset for standing conversations and archives the previous nativeSessionId', async () => {
  const f = await fixture();
  const stop = vi.fn(async () => {});
  const updateSession = vi.fn(async () => f.session);
  const setNativeSessionId = vi.fn(async () => f.session);
  f.host.session = vi.fn(async () => f.session) as any;
  f.host.terminals.stop = stop;
  f.host.updateSession = updateSession as any;
  f.host.setNativeSessionId = setNativeSessionId as any;
  f.host.withSessionLock = (async (_id: string, fn: () => Promise<unknown>) => fn()) as any;
  f.host.standing = { launch: () => undefined, newTopic: (_id: string, text: string) => text.trim() === '/new' };

  const result = await f.backend.send(f.host, {
    context: f.context,
    runId: 'run-new',
    commandId: 'cmd-new',
    input: { text: '/new', context: [], attachmentIds: [] },
    config: { mode: 'agent' },
  } as AgentSendRequest);

  expect(result).toEqual({ state: 'settled' });
  expect(f.host.commitDispatchFence).toHaveBeenCalledWith('run-new', {
    slashCommand: true,
    renderedText: '/new',
    nativeSessionId: conversationId,
  });
  expect(stop).toHaveBeenCalledWith('terminal');
  expect(updateSession).toHaveBeenCalledWith('session', { previousNativeSessionIds: [conversationId], terminalId: undefined });
  expect(setNativeSessionId).toHaveBeenCalledWith('session', undefined);
});

it('proves passive input release and later-turn release without launching or mutating the runtime', async () => {
  const f = await fixture();
  hub(f.backend).runtimes.set('session', f.runtime);
  f.host.transcript.drain = vi.fn(async () => {});
  f.host.terminals.screen = vi.fn(async () => '────────\n>\n────────');
  const boundary = JSON.stringify({
    version: 1,
    root: f.geminiDir,
    nonce: f.runtime.launch.nonce,
    id: conversationId,
    trajectoryId,
    users: [],
  });
  const droppedRun: AgentRunRef = {
    id: 'run-dropped',
    sessionId: 'session',
    commandId: 'cmd-dropped',
    state: 'interrupted',
    delivery: 'uncertain',
    nativeSessionId: conversationId,
    renderedText: 'Dropped prompt',
    inputSentAt: Date.parse('2026-11-13T00:00:00Z'),
    nativeInputBoundary: boundary,
  };

  expect(await f.backend.canReleaseInput(f.host, f.context, droppedRun)).toBe(true);
  expect(await f.backend.canReleaseAfterLaterTurn(f.host, f.context, droppedRun)).toBe(false);

  // Add a later completed turn with a different prompt: both release checks pass.
  const laterUser = {
    ...user('later-exec', 0, 'Later prompt'),
    metadata: {
      executionId: 'later-exec',
      createdAt: '2026-11-13T00:05:00Z',
      sourceTrajectoryStepInfo: { trajectoryId, stepIndex: 0, cascadeId: conversationId },
    },
  };
  f.runtime.snapshot = {
    ...snapshot([laterUser]),
    executors: [{ executionId: 'later-exec', terminationReason: 'TERMINATION_REASON_NO_TOOL_CALL', lastStepIdx: 0 }],
  };
  expect(await f.backend.canReleaseAfterLaterTurn(f.host, f.context, droppedRun)).toBe(true);

  // If the dropped prompt itself actually appears in the snapshot, release is refused.
  f.runtime.snapshot = snapshot([user('recorded-exec', 0, 'Dropped prompt')]);
  expect(await f.backend.canReleaseInput(f.host, f.context, droppedRun)).toBe(false);
});

it('matches image-only receipts and extracts sanitized startup errors', async () => {
  const f = await fixture();
  const boundary = JSON.stringify({ version: 1, root: f.geminiDir, id: conversationId, trajectoryId, users: [] });
  f.pending.push({
    id: 'run-img',
    sessionId: 'session',
    commandId: 'cmd-img',
    state: 'running',
    renderedText: '',
    nativeInputBoundary: boundary,
  });
  f.runtime.snapshot = snapshot([
    {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: {
        executionId: 'img-exec',
        createdAt: '2026-11-13T00:00:00Z',
        sourceTrajectoryStepInfo: { trajectoryId, stepIndex: 0, cascadeId: conversationId },
      },
      userInput: { userResponse: '', images: [{ mimeType: 'image/jpeg', base64Data: 'AAAA' }] },
    },
  ]);
  await receipts(f.runtime);
  expect(f.emitEvent).toHaveBeenCalledWith(
    'session',
    expect.objectContaining({ type: 'native_input_receipt', runId: 'run-img', nativeTurnId: 'img-exec' }),
  );

  expect(f.backend.terminal.startupError('Error: Authentication failed')).toContain('Authentication failed');
  expect(f.backend.terminal.startupError('Antigravity\n? for shortcuts')).toBeUndefined();
});

it('stays idle with background activity (never stuck in starting) when foreground finishes with a detached background task', async () => {
  const f = await fixture();
  f.runtime.snapshot = snapshot([]);
  f.runtime.rpc = {
    snapshot: async () => snapshot([]),
    call: async () => ({}),
    stream: async (_id: string, _onUpdate: unknown, signal: AbortSignal) =>
      await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    close() {},
  } as never;
  const status = { conversation_id: conversationId, agent_state: 'idle', task_count: 1 };
  expect(foregroundIdle(f.runtime, status)).toBe(true);
  expect(idle(f.runtime, status)).toBe(false);

  await f.status(status);
  await poll(hub(f.backend), f.runtime);
  expect(f.runtime.status.phase).toBe('idle');
  expect(f.runtime.status.activity).toEqual({ compacting: false, background: 1 });
  expect(f.runtime.status.runtimeControl?.actions?.map((action: { id: string }) => action.id)).toContain('stop-current');
  f.runtime.stream?.abort();
});
