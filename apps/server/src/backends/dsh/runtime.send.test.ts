import { describe, expect, it, vi } from 'vitest';
import type { NativeRunConfig, Project, Session } from '../../../../../packages/contracts/src/index.js';
import type { NativeBackendHost, NativeBackendProfileConfig } from '../types.js';
import type { DshConversation, DshSessionReadResult } from './types.js';
import { DshProfileRuntime } from './runtime.js';

const session = {
  id: 'session-send', projectId: 'project-send', kind: 'native', title: 'DSH', tags: [], state: 'running',
  backendId: 'dsh', backendProfileId: 'local', nativeSessionId: 'native-send', mode: 'agent', createdAt: '', updatedAt: '',
} as Session;
const project = { id: 'project-send', name: 'Project', cwd: '/tmp/dsh-send', createdAt: '', updatedAt: '' } as Project;
const profile = { id: 'local', backendId: 'dsh', name: 'DSH', config: { defaultModel: 'deepseek-flash' } } as NativeBackendProfileConfig;

type RuntimeInternals = {
  peer?: unknown;
  byWorkbenchId: Map<string, DshConversation>;
  request<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  readPage(state: DshConversation, before: number | undefined, limit: number): Promise<DshSessionReadResult>;
  cacheEvents(state: DshConversation, events: unknown[], before: number, total: number): unknown;
  generation(state: DshConversation, result: DshSessionReadResult): string;
  emitStatus(state: DshConversation): void;
};

function makeState(phase: 'offline' | 'idle' | 'busy' | 'attention', active = true): DshConversation {
  return {
    workbenchSessionId: session.id,
    nativeSessionId: session.nativeSessionId!,
    session,
    project,
    profile,
    host: {} as NativeBackendHost,
    listeners: new Set(),
    events: new Map(),
    recentStreamSequences: new Set(),
    pendingAssistantFlushes: new Map(),
    streamBuffer: [],
    interactionQueue: [],
    interactionRequests: new Map(),
    status: { phase },
    active,
    historyBefore: 0,
    historyTotal: 0,
    turnCommands: new Map(),
    commandMap: new Map(),
    metrics: new Map(),
    attempts: new Map(),
    contextFacts: {} as DshConversation['contextFacts'],
    subagents: new Map(),
  } as unknown as DshConversation;
}

function baseline(status?: 'busy' | 'idle', found = false): DshSessionReadResult {
  return {
    found,
    nativeSessionId: session.nativeSessionId!,
    events: [],
    start: 0,
    before: 0,
    total: 0,
    hasMore: false,
    ...(status ? { status: { status } } : {}),
  };
}

function createHarness(phase: 'offline' | 'idle' | 'busy' | 'attention' = 'idle', active = true, peer = true) {
  const runtime = new DshProfileRuntime(profile, {} as NativeBackendHost);
  const state = makeState(phase, active);
  const internal = runtime as unknown as RuntimeInternals;
  internal.byWorkbenchId.set(session.id, state);
  if (peer) internal.peer = {};
  const calls: string[] = [];
  const request = vi.fn(async (method: string, _params: Record<string, unknown>, _timeoutMs?: number) => {
    calls.push(method);
    return method === 'session/send' ? { accepted: true } : {};
  });
  internal.request = async <T>(method: string, params: Record<string, unknown>, timeoutMs?: number) => await request(method, params, timeoutMs) as T;
  internal.readPage = async () => baseline();
  internal.cacheEvents = () => undefined;
  internal.generation = () => 'generation';
  internal.emitStatus = () => undefined;
  const fence = vi.fn();
  const input: Parameters<DshProfileRuntime['send']>[0] = {
    session,
    project,
    profile,
    commandId: 'command-send',
    runId: 'run-send',
    config: { mode: 'agent' } as NativeRunConfig,
    content: [{ type: 'text', text: 'hello' }],
    attachments: [],
    renderedText: 'hello',
    isCancelled: () => false,
    commitDispatchFence: fence,
  };
  return { runtime, state, internal, calls, request, fence, input };
}

describe('DshProfileRuntime.send queue admission', () => {
  it.each(['busy', 'attention'] as const)('does not fence or enqueue while DSH is %s', async (phase) => {
    const h = createHarness(phase);

    await expect(h.runtime.send(h.input)).rejects.toMatchObject({ code: 'CLI_BUSY' });

    expect(h.fence).not.toHaveBeenCalled();
    expect(h.calls).toContain('session/validate-content');
    expect(h.calls).not.toContain('session/send');
  });

  it('sends an idle prompt exactly once', async () => {
    const h = createHarness('idle');

    expect(await h.runtime.send(h.input)).toBeUndefined();

    expect(h.fence).toHaveBeenCalledTimes(1);
    expect(h.calls.filter(method => method === 'session/send')).toHaveLength(1);
  });

  it('honors a fresh busy phase from the latest baseline', async () => {
    const h = createHarness('idle');
    h.internal.readPage = async () => baseline('busy', true);

    await expect(h.runtime.send(h.input)).rejects.toMatchObject({ code: 'CLI_BUSY' });

    expect(h.fence).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('session/send');
  });

  it('uses the live baseline phase but does not overwrite a newer busy notification', async () => {
    const h = createHarness('idle');
    let releaseBaseline!: (value: DshSessionReadResult) => void;
    let baselineStarted!: () => void;
    const started = new Promise<void>(resolve => { baselineStarted = resolve; });
    const pendingBaseline = new Promise<DshSessionReadResult>(resolve => { releaseBaseline = resolve; });
    h.internal.readPage = async () => {
      baselineStarted();
      return await pendingBaseline;
    };

    const send = h.runtime.send(h.input);
    await started;
    h.state.status = { phase: 'busy' };
    releaseBaseline(baseline('idle', true));

    await expect(send).rejects.toMatchObject({ code: 'CLI_BUSY' });
    expect(h.fence).not.toHaveBeenCalled();
    expect(h.calls).not.toContain('session/send');
  });

  it('does not reject the initial offline placeholder before opening an idle DSH session', async () => {
    const h = createHarness('offline', false, false);
    const open = vi.fn(async () => {
      h.state.active = true;
      h.state.status = { phase: 'idle' };
      h.internal.peer = {};
      return { nativeSessionId: session.nativeSessionId!, status: h.state.status };
    });
    h.runtime.open = open;

    await h.runtime.send(h.input);

    expect(open).toHaveBeenCalledTimes(1);
    expect(h.fence).toHaveBeenCalledTimes(1);
    expect(h.calls.filter(method => method === 'session/send')).toHaveLength(1);
  });
});
