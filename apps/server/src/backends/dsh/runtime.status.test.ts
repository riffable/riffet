import { describe, expect, it } from 'vitest';
import type { NativeInteraction, Project, Session } from '../../../../../packages/contracts/src/index.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativeControlMessage } from '../types.js';
import { DshProfileRuntime } from './runtime.js';
import type { DshConversation, DshSessionReadResult } from './types.js';

type RuntimeInternals = {
  peer?: unknown;
  conversation(session: Session, project: Project, profile: NativeBackendProfileConfig, nativeSessionId: string): DshConversation;
  ensureStarted(create: boolean): Promise<boolean>;
  readPage(state: DshConversation, before: number | undefined, limit: number): Promise<DshSessionReadResult>;
  refreshSubagents(state: DshConversation): Promise<void>;
  poll(state: DshConversation): Promise<void>;
  refresh(state: DshConversation): Promise<void>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(phase: 'busy' | 'idle' | 'attention' = 'idle') {
  const session = {
    id: 'status-session', projectId: 'status-project', kind: 'native', title: 'DSH', tags: [], state: 'running',
    nativeSessionId: 'status-native', mode: 'agent', createdAt: '', updatedAt: '',
  } as Session;
  const project = { id: 'status-project', name: 'Project', cwd: '/tmp/dsh-status', createdAt: '', updatedAt: '' } as Project;
  const profile = { id: 'local', backendId: 'dsh', name: 'DSH', config: { defaultModel: 'deepseek-flash' } } as NativeBackendProfileConfig;
  const host = {
    getSession: () => session,
    updateSession: (_id: string, patch: Partial<Session>) => Object.assign(session, patch),
  } as unknown as NativeBackendHost;
  const runtime = new DshProfileRuntime(profile, host);
  const internal = runtime as unknown as RuntimeInternals;
  const state = internal.conversation(session, project, profile, session.nativeSessionId!);
  state.active = true;
  state.status = { phase };
  const messages: NativeControlMessage[] = [];
  state.listeners.add(message => { messages.push(message); });
  internal.peer = {};
  internal.ensureStarted = async () => true;
  internal.refreshSubagents = async () => undefined;
  const page = (status: 'busy' | 'idle'): DshSessionReadResult => ({
    found: true, nativeSessionId: session.nativeSessionId!, events: [], start: 0, before: 0, total: 0,
    hasMore: false, status: { status },
  });
  internal.readPage = async () => page('idle');
  const notify = (status: 'running' | 'idle') => runtime.handleNotification('agent/status', { nativeSessionId: state.nativeSessionId, status });
  return { runtime, internal, state, session, messages, page, notify, read: () => internal.refresh(state) };
}

describe('DSH live activity status', () => {
  it('rechecks a targeted stop after connection preparation and before its RPC write', async () => {
    const h = harness('busy');
    const gate = deferred<void>();
    let changed = false, writes = 0;
    h.internal.ensureStarted = async () => { await gate.promise; return true; };
    h.internal.peer = { request: async () => { writes += 1; return { interrupted: true }; } };
    const stopping = h.runtime.interrupt(h.session, () => {
      if (changed) throw new Error('stop target changed');
    });
    changed = true;
    gate.resolve();
    await expect(stopping).rejects.toThrow('stop target changed');
    expect(writes).toBe(0);
  });

  it('keeps a newer running notification when an older idle read completes', async () => {
    const h = harness();
    const started = deferred<void>();
    const page = deferred<DshSessionReadResult>();
    h.internal.readPage = async () => { started.resolve(); return await page.promise; };
    const read = h.read();
    await started.promise;
    h.notify('running');
    page.resolve(h.page('idle'));

    await read;
    expect(h.state.status.phase).toBe('busy');
  });

  it.each(['read', 'poll'] as const)('keeps a newer notification while %s awaits subagents', async (operation) => {
    const h = harness();
    const refreshing = deferred<void>();
    const refreshed = deferred<void>();
    h.internal.refreshSubagents = async () => { refreshing.resolve(); await refreshed.promise; };
    const pending = operation === 'read' ? h.read() : h.internal.poll(h.state);
    await refreshing.promise;
    h.notify('running');
    refreshed.resolve();
    await pending;

    expect(h.state.status.phase).toBe('busy');
  });

  it.each([
    { cached: 'idle', live: 'busy' },
    { cached: 'busy', live: 'idle' },
  ] as const)('poll repairs $cached to $live even without new transcript records', async ({ cached, live }) => {
    const h = harness(cached);
    h.internal.readPage = async () => h.page(live);

    await h.internal.poll(h.state);

    expect(h.state.status.phase).toBe(live);
    expect(h.messages).toContainEqual(expect.objectContaining({ type: 'status', status: expect.objectContaining({ phase: live }) }));
  });

  it('does not adopt stale idle from a poll when running arrives during the read', async () => {
    const h = harness();
    const page = deferred<DshSessionReadResult>();
    h.internal.readPage = async () => await page.promise;
    const poll = h.internal.poll(h.state);
    h.notify('running');
    page.resolve(h.page('idle'));
    await poll;

    expect(h.state.status.phase).toBe('busy');
  });

  it('keeps a goal agent busy between turns until the live agent reports idle', () => {
    const h = harness('busy');
    const event = (type: string, turn: number) => h.runtime.handleNotification('session/event', {
      nativeSessionId: h.state.nativeSessionId, event: { type, seq: turn * 2 + (type === 'turn/end' ? 1 : 0), data: { turn } },
    });
    h.notify('running');
    event('turn/end', 1);
    expect(h.state.status.phase).toBe('busy');
    event('turn/start', 2);
    event('turn/end', 2);
    expect(h.state.status.phase).toBe('busy');
    h.notify('idle');
    expect(h.state.status.phase).toBe('idle');
  });

  it.each(['busy', 'idle'] as const)('preserves attention when live phase is %s', async (live) => {
    const h = harness('attention');
    h.state.interaction = { kind: 'permission', requestId: 'request-1' } as NativeInteraction;
    h.internal.readPage = async () => h.page(live);
    await h.internal.poll(h.state);
    expect(h.state.status).toMatchObject({ phase: 'attention', interaction: h.state.interaction });
    await h.read();
    expect(h.state.status).toMatchObject({ phase: 'attention', interaction: h.state.interaction });
  });
});
