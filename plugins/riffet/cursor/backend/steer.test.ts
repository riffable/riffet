import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeWorkbenchEvent } from '@contracts';
import { AppError, parseSteerContexts } from '@riffet/plugin-api/kit';
import { type AgentContext, type AgentRunRef, type AgentSendRequest, type AgentSessionView } from '@riffet/plugin-api/experimental/agent';
import { CursorBackend } from '../backend.js';
import { cursorPort } from '../host-port.js';
import { cursorSteerContext } from '../native/chat-store.js';
import type { NativeService } from '../native/service.js';
import { FakeHost } from '../testing/fake-host.js';
import { CursorSteerBridge } from './steer.js';
import { CursorTranscriptSource } from './transcript-source.js';

vi.mock('./launch-plugin.js', async importOriginal => ({ ...await importOriginal<typeof import('./launch-plugin.js')>(), probeCursorHookSteer: async () => true }));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

const project = { id: 'p', name: 'project', cwd: '/tmp/project' };
const profile = { id: 'default', name: 'Cursor CLI', config: {} };

async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'cursor-steer-test-'));
  const host = new FakeHost({
    sessions: [{ id: 's', projectId: 'p', title: 'session', state: 'running', mode: 'agent', nativeSessionId: 'chat', terminalId: 'pty' }],
    terminals: [{ id: 'pty', projectId: 'p', sessionId: 's', title: '', kind: 'cursor', state: 'running', persistent: true, epoch: 1, cols: 80, rows: 24, createdAt: new Date(0).toISOString() }],
  });
  const runs = host.runRefs;
  runs.push({ id: 'owner', sessionId: 's', commandId: 'original', state: 'running', nativeTurnId: 'generation', nativeSessionId: 'chat', config: { mode: 'agent', model: 'original' } } as AgentRunRef);
  // The core's fence records what the binding says on the run.
  host.onFence = (runId, binding) => {
    const run = runs.find(candidate => candidate.id === runId)!;
    Object.assign(run, { delivery: 'dispatching', ...(binding?.renderedText !== undefined ? { renderedText: binding.renderedText } : {}), ...(binding?.ownerRunId ? { ownerRunId: binding.ownerRunId } : {}) });
  };
  const session = () => host.sessions.get('s')!;
  const port = cursorPort(host);
  const native = { useTurnObserver: vi.fn(), notifyTurnChanged: vi.fn(), turnState: vi.fn(() => undefined), sessionForChat: (id: string) => id === 'chat' ? session() : undefined } as unknown as NativeService;
  const bridge = new CursorSteerBridge(host, port, native, stateDir, {} as never);
  const source = new CursorTranscriptSource({ chatId: () => session().nativeSessionId, chatsDir: () => stateDir });
  const endTurn = vi.spyOn(source, 'endTurn').mockImplementation(async (_w, { stillCurrent }) => stillCurrent?.() ?? true);
  vi.spyOn(host.transcript, 'withSource').mockImplementation(async (_id, task) => task(source, undefined as never));
  cleanup.push(() => bridge.close());
  bridge.bind('s');
  await bridge.launchArgs();
  const config = JSON.parse(await readFile(join(stateDir, 'cursor-hook/bridge.json'), 'utf8'));
  const hook = async (event: string, extra: object = {}) => {
    const response = await fetch(`${config.url}/hook`, { method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryId: crypto.randomUUID(), payload: { hook_event_name: event, conversation_id: 'chat', generation_id: 'generation', ...extra } }) });
    return await response.json() as { additional_context?: string };
  };
  function request(commandId: string, text = 'guide this tool result') {
    runs.push({ id: `run-${commandId}`, sessionId: 's', commandId, state: 'queued', intent: 'steer', nativeSessionId: 'chat', nativeTurnId: 'generation', inputText: text, delivery: 'preparing' });
    return { context: { session: session(), project, profile }, commandId, runId: `run-${commandId}`, target: { nativeSessionId: 'chat', turnId: 'generation' }, input: { text, attachmentIds: [], context: [] }, config: {} } as unknown as AgentSendRequest & { target: { nativeSessionId: string; turnId: string } };
  }
  const events = () => host.events as NativeWorkbenchEvent[];
  const fenced = (runId: string) => host.fences.filter(fence => fence.runId === runId).length;
  const context = (): AgentContext => ({ session: session(), project, profile });
  return {
    bridge, native, host, port, stateDir, events, runs, hook, request, fenced, context, session, endTurn,
    answer: (turnId?: string, nativeSessionId = 'chat', error?: string) => bridge.answered(session(), { nativeSessionId, turnId, rootId: `root-of-${turnId}`, error }, () => true),
    setSession: (patch: Partial<AgentSessionView>) => { host.sessions.set('s', { ...session(), ...patch }); },
    setEpoch: (value: number) => { host.terminalRecords.set('pty', { ...host.terminalRecords.get('pty')!, epoch: value }); },
  };
}

describe('Cursor strict tool-boundary steering', () => {
  it.each([false, true])('keeps the stop target through its write and guards cleanup after turn end (successor: %s)', async successor => {
    const f = await fixture();
    await f.hook('preToolUse');
    const writes: string[] = [];
    const status = () => ({ phase: 'busy', activeTurn: f.bridge.activeTurn(f.session()) });
    // The core's guard for an expected stop (`NativeBackendService.interrupt`), as `host.checkStopTarget` reaches it.
    const expected = { nativeSessionId: 'chat', turnId: 'generation' };
    f.host.checkStopTarget = async (_id, allowEnded = false) => {
      const current = status().activeTurn;
      if (f.session().nativeSessionId !== expected.nativeSessionId || current?.turnId !== expected.turnId && !(allowEnded && !current)
        || current !== undefined && current.nativeSessionId !== expected.nativeSessionId) throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'The original task changed before stopping', 409);
    };
    f.native.interrupt = async (_session, options) => {
      await options?.beforeWrite?.();
      writes.push('C-c');
      await f.hook('stop', { status: 'completed' });
      if (successor) await f.hook('preToolUse', { generation_id: 'successor' });
      await options?.beforeWrite?.(true);
      writes.push('C-u');
    };
    const backend = new CursorBackend({ stateDir: f.stateDir });
    // Use this fixture's real hooked bridge, without starting a second hook server.
    Object.assign(backend, { built: { port: f.port, native: f.native, runtime: {}, profile: {}, steering: f.bridge } });
    const stopped = backend.interrupt(f.host, f.context(), { clearPrompt: true, expectedStop: { requestId: 'stop-once', ...expected } });
    if (successor) {
      await expect(stopped).rejects.toMatchObject({ code: 'NATIVE_STOP_TARGET_CHANGED' });
      expect(writes).toEqual(['C-c']);
      expect(f.bridge.activeTurn(f.session())?.turnId).toBe('successor');
    } else {
      await stopped;
      expect(writes).toEqual(['C-c', 'C-u']);
      expect(f.bridge.activeTurn(f.session())).toBeUndefined();
    }
  });

  it('does not leave a hook server running when close races asynchronous plugin preparation', async () => {
    const host = new FakeHost();
    const native = { useTurnObserver: vi.fn() } as unknown as NativeService;
    const bridge = new CursorSteerBridge(host, cursorPort(host), native, await mkdtemp(join(tmpdir(), 'cursor-close-test-')), {} as never);
    const preparing = bridge.launchArgs();
    await bridge.close();
    expect(await preparing).toEqual([]);
    expect(await bridge.launchArgs()).toEqual([]);
  });

  it('requires a real turn handshake, survives terminal epoch lease bumps, and rejects exited terminals', async () => {
    const f = await fixture(), request = f.request('one');
    await expect(f.bridge.enqueue(request, request.input.text)).rejects.toMatchObject({ code: 'STEER_TARGET_CHANGED' });
    await f.hook('preToolUse');
    expect(f.bridge.activeTurn(f.session())).toMatchObject({ turnId: 'generation', ownerRunId: 'owner' });
    // Opening/closing the terminal drawer bumps epoch without changing process identity.
    f.setEpoch(2);
    expect(await f.bridge.enqueue(request, request.input.text)).toEqual({ deferred: true });
    const hookResult = await f.hook('postToolUse');
    expect(hookResult.additional_context).toContain('guide this tool result');
    expect(f.fenced('run-one')).toBe(1);
    // An exited terminal genuinely ends the target.
    f.host.terminalRecords.set('pty', { ...f.host.terminalRecords.get('pty')!, state: 'exited' });
    const second = f.request('two');
    await expect(f.bridge.enqueue(second, second.input.text)).rejects.toMatchObject({ code: 'STEER_TARGET_CHANGED' });
    expect(f.fenced('run-two')).toBe(0);
  });

  it('claims equal-text commands once across parallel hooks and confirms only actual persisted carriers', async () => {
    const f = await fixture();
    await f.hook('preToolUse');
    const first = f.request('one'), second = f.request('two');
    await f.bridge.enqueue(first, first.input.text);
    await f.bridge.enqueue(second, second.input.text);
    expect(f.fenced('run-one')).toBe(0);
    const outputs = await Promise.all([f.hook('postToolUse'), f.hook('postToolUse')]);
    const contexts = outputs.flatMap(output => output.additional_context ? parseSteerContexts(output.additional_context) : []);
    expect(contexts.map(context => context.commandId)).toEqual(['one', 'two']);
    expect(f.fenced('run-one')).toBe(1);
    expect(f.fenced('run-two')).toBe(1);
    expect(f.events().filter(event => event.type === 'native_input_receipt')).toHaveLength(0);
    const text = `<system_reminder>\n${outputs.find(output => output.additional_context)!.additional_context}\n</system_reminder>`;
    const context = cursorSteerContext({ type: 'tool-result', result: text, experimental_content: [{ type: 'text', text }] });
    expect(parseSteerContexts(context!).map(value => value.commandId)).toEqual(['one', 'two']);
    await f.hook('stop', { status: 'completed' });
    const source = { type: 'cursor_tool_context', sequence: 11, nativeId: 'actual-native-tool-result', data: { text: context }, createdAt: new Date().toISOString() } as unknown as NativeWorkbenchEvent;
    const receiptEvents = f.bridge.receiptEvents(f.session(), [source]);
    expect(receiptEvents.filter(event => event.type === 'native_input_receipt')).toHaveLength(2);
    expect(receiptEvents.filter(event => event.type === 'run_completed').map(event => event.runId)).toEqual(['run-one', 'run-two']);
    expect(f.events().find(event => event.runId === 'owner' && event.type === 'run_completed')).toMatchObject({ data: { commandId: 'original' } });
  });

  it('rejects an unclaimed input on stop and never consumes it in a new generation', async () => {
    const f = await fixture();
    await f.hook('preToolUse');
    const request = f.request('old');
    await f.bridge.enqueue(request, request.input.text);
    await f.hook('stop', { status: 'completed' });
    expect(f.events().find(event => event.type === 'native_input_rejected')).toMatchObject({ data: { beforeWrite: true } });
    await f.hook('preToolUse', { generation_id: 'new-generation' });
    expect(await f.hook('postToolUse', { generation_id: 'new-generation' })).toEqual({});
    expect(await f.hook('postToolUse')).toEqual({});
    expect(f.fenced('run-old')).toBe(0);
    expect(f.bridge.activeTurn(f.session())).toMatchObject({ turnId: 'new-generation' });
  });

  it('moves to another generation only once the store shows the tracked turn over', async () => {
    const f = await fixture();
    const turnState = vi.mocked(f.native.turnState);
    await f.hook('preToolUse');
    const request = f.request('kept');
    await f.bridge.enqueue(request, request.input.text);
    // A hook outside the turn's request, while the store still has the turn waiting on a tool.
    turnState.mockReturnValue('open');
    expect(await f.hook('preToolUse', { generation_id: 'stray' })).toEqual({});
    expect(f.bridge.activeTurn(f.session())).toMatchObject({ turnId: 'generation' });
    expect(f.events().find(event => event.type === 'native_input_rejected')).toBeUndefined();
    expect((await f.hook('postToolUse')).additional_context).toBeTruthy();
    // The store ends the turn on its answer and the CLI goes straight on with the next one.
    turnState.mockReturnValue('answered');
    await f.hook('preToolUse', { generation_id: 'next' });
    expect(f.events().filter(event => event.type === 'run_completed')).toEqual([expect.objectContaining({ runId: 'owner', nativeTurnId: 'generation' })]);
    expect(f.bridge.activeTurn(f.session())).toMatchObject({ turnId: 'next' });
    // Without a readable store, another generation still replaces the tracked one, leaving its outcome to the core.
    turnState.mockReturnValue(undefined);
    await f.hook('preToolUse', { generation_id: 'after-next' });
    expect(f.bridge.activeTurn(f.session())).toMatchObject({ turnId: 'after-next' });
    expect(f.events().filter(event => event.type === 'run_completed')).toHaveLength(1);
  });

  it('rejects and retires an interrupted tool instead of injecting into its failed result', async () => {
    const f = await fixture();
    await f.hook('preToolUse');
    const request = f.request('cancelled-tool');
    await f.bridge.enqueue(request, request.input.text);
    expect(await f.hook('postToolUseFailure', { is_interrupt: true })).toEqual({});
    expect(f.bridge.activeTurn(f.session())).toBeUndefined();
    expect(f.fenced('run-cancelled-tool')).toBe(0);
    expect(f.events().find(event => event.type === 'native_input_rejected')).toMatchObject({ data: { beforeWrite: true } });
    expect(f.events().find(event => event.type === 'run_cancelled')).toMatchObject({ runId: 'owner', data: { commandId: 'original' } });
    expect(await f.hook('postToolUse')).toEqual({});
  });

  it('does not let a child hook consume or terminate the parent generation', async () => {
    const child = { parent_tool_call_id: 'parent-task' };
    const f = await fixture();
    await f.hook('preToolUse');
    const request = f.request('parent-input');
    await f.bridge.enqueue(request, request.input.text);
    expect(await f.hook('postToolUse', child)).toEqual({});
    expect(await f.hook('postToolUseFailure', { ...child, is_interrupt: true })).toEqual({});
    expect(await f.hook('stop', { ...child, status: 'completed' })).toEqual({});
    expect(f.fenced('run-parent-input')).toBe(0);
    expect(f.bridge.activeTurn(f.session())).toMatchObject({ turnId: 'generation' });
    expect((await f.hook('postToolUse')).additional_context).toBeTruthy();
  });

  it('refuses a steer whose fence the host refuses, and never injects it', async () => {
    const f = await fixture();
    await f.hook('preToolUse');
    const request = f.request('cancelled-run');
    await f.bridge.enqueue(request, request.input.text);
    f.host.onFence = () => { throw new AppError('AGENT_RUN_CANCELLED', 'The run was cancelled', 409); };
    expect(await f.hook('postToolUse')).toEqual({});
    expect(f.events().find(event => event.type === 'native_input_rejected')).toMatchObject({ runId: 'run-cancelled-run', data: { beforeWrite: true } });
    expect(f.events().filter(event => event.type === 'native_input_submitted')).toHaveLength(0);
  });

  it('ends a turn whose Stop hook never comes from the store answer, once, and ignores a late Stop', async () => {
    const f = await fixture();
    await f.hook('preToolUse');
    const request = f.request('pending');
    await f.bridge.enqueue(request, request.input.text);
    await f.answer('generation', 'other-chat');
    expect(f.bridge.activeTurn(f.session())).toMatchObject({ turnId: 'generation' });
    await Promise.all([f.answer('generation'), f.answer('generation')]);
    expect(f.bridge.activeTurn(f.session())).toBeUndefined();
    expect(f.events().filter(event => event.type === 'run_completed')).toEqual([expect.objectContaining({ runId: 'owner', data: expect.objectContaining({ commandId: 'original' }) })]);
    expect(f.events().find(event => event.type === 'native_input_rejected')).toMatchObject({ data: { beforeWrite: true } });
    await f.hook('stop', { status: 'error' });
    await f.answer('generation');
    expect(f.events().filter(event => ['run_completed', 'run_failed', 'run_cancelled'].includes(event.type))).toHaveLength(1);
    expect(f.endTurn).toHaveBeenCalledTimes(1);
    expect(f.fenced('run-pending')).toBe(0);
  });

  it('ends the tracked generation when the store answer has no turn id, and leaves a finished turn alone', async () => {
    const f = await fixture();
    await f.hook('preToolUse', { generation_id: 'auto-turn' });
    await f.answer();
    expect(f.bridge.activeTurn(f.session())).toBeUndefined();
    expect(f.events().filter(event => event.type === 'run_completed').map(event => event.nativeTurnId)).toEqual(['auto-turn']);
    f.runs[0]!.state = 'completed';
    await f.answer('generation');
    expect(f.events().filter(event => event.type === 'run_completed')).toHaveLength(1);
    f.runs[0]!.state = 'running';
    await f.bridge.answered(f.session(), { nativeSessionId: 'chat', turnId: 'generation', rootId: 'later-root' }, () => true);
    expect(f.events().filter(event => event.type === 'run_completed').map(event => event.runId)).toEqual([undefined, 'owner']);
  });

  it('settles the journal and run with the same provider failure', async () => {
    const f = await fixture();
    const error = 'Network Error: Unable to connect to the model provider';
    await f.hook('preToolUse');
    await f.answer('generation', 'chat', error);
    expect(f.events()).toMatchObject([{ type: 'run_failed', nativeTurnId: 'generation', data: { error } }]);
    expect(f.endTurn.mock.calls[0]?.[1]).toMatchObject({ status: 'failed', turnId: 'generation', error, at: f.events()[0]!.createdAt });
  });

  it.each([['error', 'run_failed'], ['aborted', 'run_cancelled']])('keeps a %s Stop that arrives while idle completion is reading', async (status, eventType) => {
    const f = await fixture();
    await f.hook('preToolUse');
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    f.endTurn.mockImplementationOnce(async (_w, { stillCurrent }) => {
      await gate;
      return stillCurrent?.() ?? true;
    });
    const answer = f.answer('generation');
    await f.hook('stop', { status });
    resume();
    await answer;
    await f.answer('generation');
    expect(f.events().map(event => event.type)).toEqual([eventType]);
    expect(f.endTurn.mock.calls.map(([, result]) => result.status)).toEqual(['completed', status === 'error' ? 'failed' : 'cancelled']);
  });

  it('retries a Stop whose first journal read found no store, then applies it once to each new idle root', async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      f.endTurn.mockResolvedValueOnce(false);
      await f.hook('stop', { status: 'error' });
      Object.assign(f.runs[0]!, { state: 'failed', error: 'Native backend reported that this run failed.' });
      expect(f.bridge.recordedOutcome('s', { nativeSessionId: 'chat', turnId: 'generation' })?.status).toBe('failed');
      expect(f.bridge.recordedOutcome('s', { nativeSessionId: 'other-chat', turnId: 'generation' })).toBeUndefined();
      await vi.advanceTimersByTimeAsync(3000);
      expect(f.endTurn).toHaveBeenCalledTimes(1);
      const hookAt = f.endTurn.mock.calls[0]![1].at;

      await f.answer('generation');
      await f.answer('generation', 'chat', 'gateway timeout');
      await f.bridge.answered(f.session(), { nativeSessionId: 'chat', turnId: 'generation', rootId: 'later-root' }, () => true);
      expect(f.endTurn.mock.calls.map(([, { status, at, turnId, expectedRoot, error }]) => [status, at, turnId, expectedRoot, error])).toEqual([
        ['failed', hookAt, 'generation', undefined, undefined],
        ['failed', hookAt, 'generation', 'root-of-generation', undefined],
        ['failed', hookAt, 'generation', 'root-of-generation', 'gateway timeout'],
        ['failed', hookAt, 'generation', 'later-root', 'gateway timeout'],
      ]);
      expect(f.events().map(event => event.type)).toEqual(['run_failed']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the successor open when idle evidence and a late Stop name its predecessor', async () => {
    const f = await fixture();
    await f.hook('preToolUse', { generation_id: 'successor' });
    await f.answer('generation');
    expect(f.endTurn).not.toHaveBeenCalled();
    expect(f.events()).toHaveLength(0);
    await f.hook('stop', { status: 'aborted' });
    expect(f.bridge.activeTurn(f.session())?.turnId).toBe('successor');
    expect(f.events()).toMatchObject([{ nativeTurnId: 'generation', type: 'run_cancelled' }]);
  });

  it('publishes a terminal target even when the original native echo is not yet associated', async () => {
    const f = await fixture();
    f.runs.splice(0);
    await f.hook('stop', { status: 'completed' });
    expect(f.events().find(event => event.type === 'run_completed')).toMatchObject({ nativeTurnId: 'generation', data: { nativeSessionId: 'chat', nativeTurnId: 'generation' } });
    await f.hook('sessionEnd');
    expect(f.events().filter(event => event.type === 'run_cancelled')).toHaveLength(0);
  });
});

const observedRun = (turnId = 'generation', extra: Record<string, unknown> = {}) => ({
  id: 'owner', sessionId: 's', commandId: 'original', state: 'running', delivery: 'observed',
  nativeSessionId: 'chat', nativeTurnId: turnId, ...extra,
}) as AgentRunRef;

describe('Cursor active turn lifecycle', () => {
  it('adopts the generation when the prompt is submitted, before any tool hook', async () => {
    const f = await fixture();
    expect(f.bridge.activeTurn(f.session())).toBeUndefined();
    await f.hook('beforeSubmitPrompt');
    expect(f.bridge.activeTurn(f.session())).toMatchObject({ nativeSessionId: 'chat', turnId: 'generation', ownerRunId: 'owner' });
    expect(f.native.notifyTurnChanged).toHaveBeenCalledWith('s');
    const request = f.request('one');
    await f.bridge.enqueue(request, request.input.text);
    expect(f.fenced('run-one')).toBe(0);
  });

  it('replaces a different generation at submit time and does not revive one a stop retired', async () => {
    const f = await fixture();
    vi.mocked(f.native.turnState).mockReturnValue('open');
    await f.hook('beforeSubmitPrompt');
    const request = f.request('kept');
    await f.bridge.enqueue(request, request.input.text);
    await f.hook('beforeSubmitPrompt', { generation_id: 'next' });
    expect(f.bridge.activeTurn(f.session())?.turnId).toBe('next');
    expect(f.events().find(event => event.type === 'native_input_rejected')).toMatchObject({ data: { beforeWrite: true } });
    expect(f.fenced('run-kept')).toBe(0);
    await f.hook('stop', { generation_id: 'next', status: 'completed' });
    await f.hook('beforeSubmitPrompt', { generation_id: 'next' });
    expect(f.bridge.activeTurn(f.session())).toBeUndefined();
  });

  it('ignores a prompt hook from a child or a terminal that has exited', async () => {
    const f = await fixture();
    await f.hook('beforeSubmitPrompt', { parent_tool_call_id: 'parent-task' });
    expect(f.bridge.activeTurn(f.session())).toBeUndefined();
    f.host.terminalRecords.set('pty', { ...f.host.terminalRecords.get('pty')!, state: 'exited' });
    await f.hook('beforeSubmitPrompt');
    expect(f.bridge.activeTurn(f.session())).toBeUndefined();
  });

  it('restores the running turn after a restart when the store is open or not yet read', async () => {
    const f = await fixture();
    f.host.unfinished = [observedRun()];
    await f.bridge.hydrate(f.session());
    expect(f.bridge.activeTurn(f.session())).toMatchObject({ turnId: 'generation', ownerRunId: 'owner' });
    expect(f.native.notifyTurnChanged).toHaveBeenCalledWith('s');

    const again = await fixture();
    again.host.unfinished = [observedRun()];
    vi.mocked(again.native.turnState).mockReturnValue('open');
    await again.bridge.hydrate(again.session());
    expect(again.bridge.activeTurn(again.session())).toMatchObject({ turnId: 'generation' });
  });

  it('does not restore a turn the store has finished, or one this bridge already ended', async () => {
    for (const state of ['answered', 'superseded'] as const) {
      const f = await fixture();
      f.host.unfinished = [observedRun()];
      vi.mocked(f.native.turnState).mockReturnValue(state);
      await f.bridge.hydrate(f.session());
      expect(f.bridge.activeTurn(f.session())).toBeUndefined();
    }
    const ended = await fixture();
    await ended.hook('beforeSubmitPrompt');
    await ended.hook('stop', { status: 'completed' });
    ended.host.unfinished = [observedRun()];
    await ended.bridge.hydrate(ended.session());
    expect(ended.bridge.activeTurn(ended.session())).toBeUndefined();
  });

  it('does not restore a steer, another terminal, or a session that is no longer running that turn', async () => {
    const cases: Array<(f: Awaited<ReturnType<typeof fixture>>) => void> = [
      f => { f.host.unfinished = [observedRun('generation', { intent: 'steer' })]; },
      f => { f.host.unfinished = [observedRun('generation', { terminalId: 'other-pty' })]; },
      f => { f.host.unfinished = [observedRun('generation', { delivery: 'dispatching' })]; },
      f => { f.host.unfinished = [observedRun()]; f.host.terminalRecords.set('pty', { ...f.host.terminalRecords.get('pty')!, state: 'exited' }); },
      f => { f.host.unfinished = [observedRun()]; f.setSession({ state: 'interrupted' }); },
      f => { f.host.unfinished = [observedRun()]; f.setSession({ archivedAt: '2026-01-01T00:00:00.000Z' }); },
      f => { f.host.unfinished = [observedRun()]; f.setSession({ terminalId: undefined }); },
    ];
    for (const prepare of cases) {
      const f = await fixture();
      prepare(f);
      await f.bridge.hydrate(f.session());
      expect(f.bridge.activeTurn(f.session())).toBeUndefined();
    }
  });

  it('keeps the turn already tracked instead of replacing it from the run record', async () => {
    const f = await fixture();
    await f.hook('beforeSubmitPrompt');
    f.host.unfinished = [observedRun('other-turn')];
    vi.mocked(f.native.notifyTurnChanged).mockClear();
    await f.bridge.hydrate(f.session());
    expect(f.bridge.activeTurn(f.session())?.turnId).toBe('generation');
    expect(f.native.notifyTurnChanged).not.toHaveBeenCalled();
  });
});
