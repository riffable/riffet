import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeWorkbenchEvent } from '@contracts';
import { AppError, parseSteerContexts, type AgentContext, type AgentRunRef, type AgentSendRequest, type AgentSessionView } from '@riffet/plugin-api';
import { CursorBackend } from '../backend.js';
import { cursorPort } from '../host-port.js';
import { cursorSteerContext } from '../native/chat-store.js';
import type { NativeService } from '../native/service.js';
import { FakeHost } from '../testing/fake-host.js';
import { CursorSteerBridge } from './steer.js';

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
  const native = { useTurnObserver: vi.fn(), notifyTurnChanged: vi.fn(), sessionForChat: (id: string) => id === 'chat' ? session() : undefined } as unknown as NativeService;
  const bridge = new CursorSteerBridge(host, port, native, stateDir, {} as never);
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
    bridge, native, host, port, stateDir, events, runs, hook, request, fenced, context, session,
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

  it('requires a real tool-generation handshake and rejects stale terminal epochs before writing', async () => {
    const f = await fixture(), request = f.request('one');
    await expect(f.bridge.enqueue(request, request.input.text)).rejects.toMatchObject({ code: 'STEER_TARGET_CHANGED' });
    await f.hook('preToolUse');
    expect(f.bridge.activeTurn(f.session())).toMatchObject({ turnId: 'generation', ownerRunId: 'owner' });
    f.setEpoch(2);
    await expect(f.bridge.enqueue(request, request.input.text)).rejects.toMatchObject({ code: 'STEER_TARGET_CHANGED' });
    expect(f.fenced('run-one')).toBe(0);
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
    f.bridge.answered(f.session(), { nativeSessionId: 'other-chat', turnId: 'generation' });
    expect(f.bridge.activeTurn(f.session())).toMatchObject({ turnId: 'generation' });
    f.bridge.answered(f.session(), { nativeSessionId: 'chat', turnId: 'generation' });
    f.bridge.answered(f.session(), { nativeSessionId: 'chat', turnId: 'generation' });
    expect(f.bridge.activeTurn(f.session())).toBeUndefined();
    expect(f.events().filter(event => event.type === 'run_completed')).toEqual([expect.objectContaining({ runId: 'owner', data: expect.objectContaining({ commandId: 'original' }) })]);
    expect(f.events().find(event => event.type === 'native_input_rejected')).toMatchObject({ data: { beforeWrite: true } });
    await f.hook('stop', { status: 'error' });
    expect(f.events().filter(event => ['run_completed', 'run_failed', 'run_cancelled'].includes(event.type))).toHaveLength(1);
    expect(f.fenced('run-pending')).toBe(0);
  });

  it('ends the tracked generation when the store answer has no turn id, and leaves a finished turn alone', async () => {
    const f = await fixture();
    await f.hook('preToolUse', { generation_id: 'auto-turn' });
    f.bridge.answered(f.session(), { nativeSessionId: 'chat' });
    expect(f.bridge.activeTurn(f.session())).toBeUndefined();
    expect(f.events().filter(event => event.type === 'run_completed').map(event => event.nativeTurnId)).toEqual(['auto-turn']);
    f.runs[0]!.state = 'completed';
    f.bridge.answered(f.session(), { nativeSessionId: 'chat', turnId: 'generation' });
    expect(f.events().filter(event => event.type === 'run_completed')).toHaveLength(1);
    f.runs[0]!.state = 'running';
    f.bridge.answered(f.session(), { nativeSessionId: 'chat', turnId: 'generation' });
    expect(f.events().filter(event => event.type === 'run_completed').map(event => event.runId)).toEqual([undefined, 'owner']);
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
