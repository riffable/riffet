import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeStatus, Run, Session } from '../../../../packages/contracts/src/index.js';
import { NativeBackendService } from './service.js';
import type { NativeBackendDriver, NativeBackendTraits, NativeControlMessage } from './types.js';
import { CodexBackendAdapter } from './codex/index.js';
import { codexFlavor, traexFlavor } from './codex/flavors.js';
import { DSH_TRAITS } from './dsh/index.js';

/** The traits the Cursor plugin declares (`plugins/riffet/cursor/backend.ts`); the service reads traits, never a backend id. */
const CURSOR_TRAITS: NativeBackendTraits = { settlesSlashOnSubmit: true, untaggedEcho: true, reportsTurnOutcome: true, ownsSessionObservation: true, resumesByNativeId: true, terminalName: 'Cursor' };

/**
 * The provider watch behind a conversation is what keeps a Codex app-server, Claude's pollers or
 * Cursor's transcript reader alive. Streams and unfinished runs hold it; an open or a send only borrows it.
 */

const services: NativeBackendService[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(services.splice(0).map(service => service.closeAll()));
});

const IDLE_MS = 1_000;

function harness(backendId: 'cursor' | 'codex' | 'traex' | 'dsh' = 'codex') {
  let session: Session = {
    id: 'session', projectId: 'project', backendId, kind: 'native', state: 'idle', title: 'Watch', tags: [],
    mode: 'agent', nativeSessionId: 'thread-1', createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z',
  };
  const unfinished: Run[] = [];
  const terminals = new Map<string, { state: 'running' | 'exited' }>();
  const counts = { subscribed: 0, released: 0 };
  const saved = new Map<string, unknown>();
  const pumps = new Set<(message: NativeControlMessage) => void>();
  const status: NativeStatus = { phase: 'idle', model: 'test-model', history: { state: 'ready' } };
  const driver = {
    id: backendId,
    traits: backendId === 'codex' || backendId === 'traex'
      ? new CodexBackendAdapter(undefined, backendId === 'traex' ? traexFlavor : codexFlavor).traits
      : { cursor: CURSOR_TRAITS, dsh: DSH_TRAITS }[backendId],
    profiles: () => [{ id: 'local', backendId, name: 'Local', isDefault: true, config: {} }],
    status: () => status,
    subscribe: (_host: unknown, _session: unknown, _profile: unknown, listener: (message: NativeControlMessage) => void) => {
      counts.subscribed += 1;
      pumps.add(listener);
      return () => { counts.released += 1; pumps.delete(listener); };
    },
    openOrResume: async () => ({ status }),
  } as unknown as NativeBackendDriver;
  const service = new NativeBackendService({
    store: {
      getSession: () => session, getProject: () => ({ id: 'project', cwd: '/workspace' }),
      updateSession: (_id: string, patch: Partial<Session>) => (session = { ...session, ...patch }),
      appendEvent: () => undefined,
      listTerminals: () => [],
      getTerminal: (id: string) => { const terminal = terminals.get(id); if (!terminal) throw new Error('no terminal'); return terminal; },
      listUnfinishedNativeRuns: () => unfinished,
      saveNativeContext: (id: string, chat: string, context: unknown) => { if (context) saved.set(id, { chat, context }); else saved.delete(id); },
      getNativeContext: (id: string, chat: string) => { const entry = saved.get(id) as { chat: string; context: unknown } | undefined; return entry?.chat === chat ? entry.context : undefined; },
    } as never,
    workspace: {} as never,
    terminal: {} as never,
    runtime: { withSession: (_id: string, operation: () => unknown) => operation() } as never,
    registry: { require: () => driver, list: () => [driver] } as never,
    watchIdleMs: IDLE_MS,
  });
  services.push(service);
  const live = () => counts.subscribed - counts.released;
  const patch = (values: Partial<Session>) => { session = { ...session, ...values }; };
  const emit = (message: NativeControlMessage) => { for (const pump of pumps) pump(message); };
  /** A one-shot use of the conversation (an open): it borrows the watch. */
  const borrow = () => service.ensure(service.host.getSession('session'));
  return { service, driver, counts, live, unfinished, terminals, patch, emit, status, borrow };
}

/** A reader on the control path: a sync stream, or the dispatcher's receipt observer. */
function listen(service: NativeBackendService) {
  const messages: NativeControlMessage[] = [];
  const control = service.watchControl('session', message => messages.push(message));
  return { messages, unsubscribe: () => control.close() };
}

describe('NativeBackendService provider watch lifecycle', () => {
  it('reports provider status failures as connection diagnostics and withdraws them on recovery', () => {
    const h = harness();
    const control = h.service.watchControl('session', () => undefined);
    const status = vi.spyOn(h.driver, 'status').mockImplementation(() => { throw new Error('Provider unavailable'); });
    expect(control.status()).toMatchObject({ phase: 'offline', connection: { state: 'failed', message: 'Provider unavailable' } });
    expect(control.status().notice).toBeUndefined();
    status.mockReturnValue(h.status);
    expect(control.status()).toMatchObject({ phase: 'idle', history: { state: 'ready' } });
    expect(control.status().connection).toBeUndefined();
    control.close();
  });

  it('refreshes a saved profile without losing the existing control listeners', async () => {
    const h = harness();
    const reader = listen(h.service);
    const before = h.service.host.getProfile!(h.service.host.getSession('session'));
    h.emit({ type: 'subagent', toolCallId: 'child', agentId: 'child', running: true });
    const subscriptions = h.counts.subscribed;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    h.driver.openOrResume = async () => { entered(); await finish; return { status: h.status }; };
    const opening = h.borrow();
    await started;
    h.driver.profiles = () => [{ id: 'local', backendId: 'codex', name: 'Local', config: { apiEndpoint: 'https://new.example' } }];
    h.service.refreshProfile('codex', 'local');
    release();
    await opening;
    expect(h.service.host.getProfile!(h.service.host.getSession('session')).config.apiEndpoint).toBe('https://new.example');
    expect(before.config.apiEndpoint).toBeUndefined();
    expect(h.live()).toBe(1);
    expect(h.counts.subscribed).toBe(subscriptions);
    h.emit({ type: 'status', status: { phase: 'idle', profilePending: true } });
    expect(reader.messages.at(-1)).toMatchObject({ type: 'status', status: { profilePending: true } });
    expect(h.service.host.getSession('session').state).toBe('running');
    reader.unsubscribe();
  });

  it('lets a borrowed watch lapse after the idle TTL', async () => {
    vi.useFakeTimers();
    const { counts, live, borrow } = harness();
    await borrow();
    await borrow();
    expect(counts.subscribed).toBe(1);
    expect(live()).toBe(1);

    // Each one-shot use re-arms the TTL rather than pinning the watch.
    await vi.advanceTimersByTimeAsync(IDLE_MS - 10);
    await borrow();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 10);
    expect(live()).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(live()).toBe(0);

    // The next reader starts a fresh watch.
    await borrow();
    expect(counts.subscribed).toBe(2);
  });

  it('holds the watch while a reader listens, and releases it one TTL after it leaves', async () => {
    vi.useFakeTimers();
    const { service, live, borrow } = harness();
    await borrow();
    const stream = listen(service);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 5);
    expect(live()).toBeGreaterThanOrEqual(1);

    // A one-shot use while someone listens must not schedule a release under them.
    await borrow();
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(live()).toBeGreaterThanOrEqual(1);

    stream.unsubscribe();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 10);
    expect(live()).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(live()).toBe(0);
  });

  it('keeps the last reported context for its chat after the watch goes, and drops it when withdrawn', async () => {
    vi.useFakeTimers();
    const { service, emit, patch, live, borrow } = harness();
    await borrow();
    const context = { used: 1200, size: 200_000, breakdown: [] };
    emit({ type: 'context', context });
    await vi.advanceTimersByTimeAsync(IDLE_MS + 10);
    expect(live()).toBe(0);

    // A new watch (a restart, a reopened conversation) has heard nothing from the provider yet;
    // a provider that replays "nothing yet" on subscribe does not erase what was saved.
    const reopened = service.watchControl('session', () => undefined);
    emit({ type: 'context' });
    expect(reopened.context()).toEqual(context);
    patch({ nativeSessionId: 'thread-2' });
    expect(reopened.context()).toBeUndefined();
    patch({ nativeSessionId: 'thread-1' });
    emit({ type: 'context', context: { ...context, used: 1500 } });
    emit({ type: 'context' });
    expect(reopened.context()).toBeUndefined();
    reopened.close();
  });

  it('keeps the watch while the session has an unfinished run, then releases it', async () => {
    vi.useFakeTimers();
    const { live, unfinished, borrow } = harness();
    unfinished.push({ id: 'run' } as Run);
    await borrow();
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(live()).toBe(1);
    unfinished.length = 0;
    await vi.advanceTimersByTimeAsync(IDLE_MS + 10);
    expect(live()).toBe(0);
  });

  it('reads a running conversation into the journal for every reader, with no sync stream open, until its watch goes', async () => {
    vi.useFakeTimers();
    const { service, unfinished, borrow } = harness();
    const follows: string[] = [];
    let held = 0;
    service.attachIngest({ follow: (id: string) => { follows.push(id); held += 1; return () => { held -= 1; }; }, writer: () => ({ activities: { live: () => [] } }) } as never);
    // An idle conversation borrowed by a one-shot use is not followed.
    await borrow();
    expect(held).toBe(0);
    await vi.advanceTimersByTimeAsync(IDLE_MS + 10);
    unfinished.push({ id: 'run' } as Run);
    await borrow();
    expect(follows).toEqual(['session']);
    // Every reader of the same conversation shares the one follow.
    const stream = listen(service);
    const control = listen(service);
    expect(held).toBe(1);
    stream.unsubscribe();
    control.unsubscribe();
    unfinished.length = 0;
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(held).toBe(0);
  });

  it('does not release a watch whose session was disposed or rebound in the meantime', async () => {
    vi.useFakeTimers();
    const { service, counts, live, borrow } = harness();
    await borrow();
    await service.dispose('session');
    expect(live()).toBe(0);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(counts.released).toBe(1);
  });
  it('keeps the watch while a non-Cursor CLI still runs in its terminal or the session is busy', async () => {
    vi.useFakeTimers();
    const { live, terminals, patch, borrow } = harness();
    terminals.set('term-1', { state: 'running' });
    patch({ terminalId: 'term-1' });
    await borrow();
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(live()).toBe(1);

    terminals.set('term-1', { state: 'exited' });
    patch({ state: 'waiting' });
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(live()).toBe(1);

    patch({ state: 'idle' });
    await vi.advanceTimersByTimeAsync(IDLE_MS + 10);
    expect(live()).toBe(0);
  });

  it.each(['codex', 'traex'] as const)('keeps observing %s children without upgrading a detached foreground session to running', async backendId => {
    vi.useFakeTimers();
    const { service, live, emit, status, borrow } = harness(backendId);
    await borrow();
    const child = (toolCallId: string, running?: boolean): NativeControlMessage => ({
      type: 'subagent', toolCallId, agentId: toolCallId, ...(running !== undefined ? { running } : {}),
    });
    status.phase = 'busy';
    emit({ type: 'status', status });
    const follows: string[] = [];
    let held = 0;
    service.attachIngest({ follow: (id: string) => { follows.push(id); held += 1; return () => { held -= 1; }; }, writer: () => ({ activities: { live: () => [] } }) } as never);
    emit(child('child-1', true));
    emit(child('child-2', true));
    status.phase = 'idle';
    emit({ type: 'status', status });
    const foregroundState = backendId === 'traex' ? 'idle' : 'running';
    expect(service.host.getSession('session').state).toBe(foregroundState);
    expect(service.status('session').phase).toBe('idle');
    expect((await borrow()).session.state).toBe(foregroundState);
    expect(follows).toEqual(['session']);
    expect(held).toBe(1);

    // An update that says nothing of running cannot clear known child activity.
    emit(child('child-1'));
    emit(child('child-2', false));
    await vi.advanceTimersByTimeAsync(IDLE_MS * 3);
    expect(live()).toBe(1);
    expect(service.host.getSession('session').state).toBe(foregroundState);
    expect(held).toBe(1); // No listener, parent Run or terminal: the child independently holds it.

    emit(child('child-1', false));
    expect(service.host.getSession('session').state).toBe('idle');
    await vi.advanceTimersByTimeAsync(IDLE_MS + 10);
    expect(live()).toBe(0);
    expect(held).toBe(0);
  });

  it.each(['codex', 'traex'] as const)('retains %s main-agent busy and attention states while children settle, and forgets old children on rebind', async backendId => {
    const { service, emit, status, patch, borrow } = harness(backendId);
    await borrow();
    const child: NativeControlMessage = { type: 'subagent', toolCallId: 'call', agentId: 'child', running: true };
    emit(child);
    status.phase = 'attention';
    emit({ type: 'status', status });
    expect(service.host.getSession('session').state).toBe('waiting');
    status.phase = 'busy';
    emit({ type: 'status', status });
    emit({ ...child, running: false });
    expect(service.host.getSession('session').state).toBe('running');
    emit(child);
    patch({ nativeSessionId: 'thread-2' });
    status.phase = 'idle';
    emit({ type: 'status', status });
    expect(service.host.getSession('session').state).toBe('idle');
  });
});

function metric(now: number): NativeControlMessage {
  return { type: 'metrics', metrics: {
    stepId: 'response', outputTokens: 1_800, durationMs: 60_000, startedAt: now - 60_000, endedAt: now,
    tokens: 'provider', window: 'stream', live: false,
  } };
}

describe('NativeBackendService recent output rate', () => {
  it.each(['cursor', 'codex', 'dsh'] as const)('samples %s without a run id', async backendId => {
    vi.useFakeTimers();
    const { service, emit } = harness(backendId);
    const first = listen(service);
    const second = listen(service);
    await vi.advanceTimersByTimeAsync(0);
    emit(metric(Date.now()));
    await vi.advanceTimersByTimeAsync(1_000);
    for (const stream of [first, second]) {
      expect(stream.messages.filter(message => message.type === 'status').at(-1)).toMatchObject({
        status: { phase: 'idle', model: 'test-model', history: { state: 'ready' }, outputRate: { tokensPerSecond: 30, outputTokens: 1_800, durationMs: 60_000 } },
      });
      stream.unsubscribe();
    }
  });

  it('adds the same sample to status, ensure and the control path', async () => {
    vi.useFakeTimers();
    const { service, emit, status, borrow } = harness('cursor');
    await borrow();
    emit(metric(Date.now()));
    const stream = listen(service);
    expect(service.watchControl('session', () => undefined).status().outputRate?.tokensPerSecond).toBe(30);
    expect(service.status('session').outputRate?.tokensPerSecond).toBe(30);
    expect((await borrow()).status?.outputRate?.tokensPerSecond).toBe(30);
    emit({ type: 'status', status });
    expect(stream.messages.find(message => message.type === 'status')).toMatchObject({ status: { outputRate: { tokensPerSecond: 30 } } });
    stream.unsubscribe();
  });

  it('retains measured speed during silence, expires to zero then stale and stops the timer when closed', async () => {
    vi.useFakeTimers();
    const { service, emit } = harness();
    const stream = listen(service);
    await vi.advanceTimersByTimeAsync(0);
    emit(metric(Date.now()));
    await vi.advanceTimersByTimeAsync(150_000);
    expect(stream.messages.filter(message => message.type === 'status').at(-1)).toMatchObject({ status: { outputRate: { state: 'live', tokensPerSecond: 30, outputTokens: 900, durationMs: 30_000 } } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stream.messages.filter(message => message.type === 'status').at(-1)).toMatchObject({ status: { outputRate: { state: 'zero', tokensPerSecond: 0 } } });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(stream.messages.filter(message => message.type === 'status').at(-1)).toMatchObject({ status: { outputRate: { state: 'stale' } } });
    stream.unsubscribe();
    await service.closeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains recent samples after an idle watch release, then expires unwatched state', async () => {
    vi.useFakeTimers();
    const { service, emit, live, borrow } = harness();
    await borrow();
    emit(metric(Date.now()));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(live()).toBe(0);
    expect((await borrow()).status?.outputRate?.tokensPerSecond).toBe(30);
    await vi.advanceTimersByTimeAsync(241_000);
    expect(service.status('session').outputRate?.state).toBe('no_data');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets on a new native binding and dispose, and never treats old history as current output', async () => {
    vi.useFakeTimers();
    const { service, emit, patch, borrow } = harness();
    await borrow();
    emit(metric(Date.now() - 600_000));
    expect(service.status('session').outputRate?.state).toBe('no_data');
    emit(metric(Date.now()));
    expect(service.status('session').outputRate?.state).toBe('live');
    patch({ nativeSessionId: 'thread-2' });
    expect((await borrow()).status?.outputRate?.state).toBe('no_data');
    emit(metric(Date.now()));
    expect(service.status('session').outputRate?.state).toBe('live');
    await service.dispose('session');
    expect(service.status('session').outputRate?.state).toBe('no_data');
    expect(vi.getTimerCount()).toBe(0);
  });
});
