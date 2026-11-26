import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { NativeDeliveryState, NativeStatus, NativeWorkbenchEvent, Session, TerminalInfo } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { Store } from '../store.js';
import { NativeDispatcher, type DispatchObservation, type NativeDispatcherBackend } from './dispatch.js';
import { buildSessionControlSnapshot } from './control.js';
import type { NativeBackendTraits } from '../backends/types.js';
import { CLAUDE_TRAITS } from '../backends/claude/index.js';
import { CODEX_TRAITS } from '../backends/codex/index.js';
import { DSH_TRAITS } from '../backends/dsh/index.js';

/** The traits the Cursor plugin declares (`plugins/riffet/cursor/backend.ts`): the dispatcher reads traits, never a backend id. */
const CURSOR_TRAITS: NativeBackendTraits = { settlesSlashOnSubmit: true, untaggedEcho: true, reportsTurnOutcome: true, ownsSessionObservation: true, resumesByNativeId: true, terminalName: 'Cursor' };
const TRAITS: Record<string, NativeBackendTraits> = { cursor: CURSOR_TRAITS, claude: CLAUDE_TRAITS, codex: CODEX_TRAITS, dsh: DSH_TRAITS };

const input = (text: string) => ({ text, attachmentIds: [], context: [] });
const config = { model: 'gpt-5.6-luna', mode: 'agent' };
const pause = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, description: string, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await pause();
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeEvent(sessionId: string, sequence: number, type: string, text: string): NativeWorkbenchEvent {
  return {
    sequence,
    nativeId: `native-${sequence}`,
    sessionId,
    type,
    data: { content: { text } },
    createdAt: new Date(sequence).toISOString(),
  };
}

class FakeNative {
  readonly listeners = new Map<string, (message: DispatchObservation) => void>();
  readonly correctionListeners = new Set<(sessionId: string, message: DispatchObservation) => void>();
  readonly writes: Array<{ sessionId: string; text: string }> = [];
  deliverCalls: string[] = [];
  subscribeCalls = 0;
  events: NativeWorkbenchEvent[] = [];
  /**
   * Each conversation's CLI is idle until something is written to it, then working on it; a status it
   * emits is its status from then on. Setting `currentStatus` stages every conversation at once.
   */
  private defaultStatus: NativeStatus = { phase: 'idle' };
  private readonly statuses = new Map<string, NativeStatus>();
  get currentStatus(): NativeStatus { return this.defaultStatus; }
  set currentStatus(status: NativeStatus) { this.defaultStatus = status; this.statuses.clear(); }
  /** Stages one conversation's status. */
  setStatus(sessionId: string, status: NativeStatus) { this.statuses.set(sessionId, status); }
  /** Whether a write starts a turn the status then reports (`busy`). */
  busyOnWrite = true;
  initialStatus?: NativeStatus;
  statusCalls = 0;
  emittedStatusCount = 0;
  failBeforeWrite?: Error;
  failBeforeWriteOnce?: Error;
  failAfterWrite?: Error;
  echoOnWrite = false;
  echoDuringDelivery = false;
  interruptCalls = 0;
  interruptOptions: Array<{ clearPrompt?: boolean } | undefined> = [];
  interruptOperation?: () => Promise<void>;
  /** Mirrors the Cursor backend, the only one that declares `supportsInitialPromptArgs`. */
  argvInitialPrompt = true;
  /** Whether the backend replaces its turn itself (`deliverNow`), like Cursor's follow-up queue. */
  sendNow = false;
  readonly nowWrites: string[] = [];
  failNowBeforeWrite?: Error;

  constructor(private readonly store: Store) {}

  traits(backendId: string): NativeBackendTraits { return TRAITS[backendId] ?? {}; }
  /** True while the backend's plugin is still starting. */
  starting = false;
  pending(): boolean { return this.starting; }
  async supportsInitialPromptArgs(): Promise<boolean> { return this.argvInitialPrompt; }
  async supportsSendNow(): Promise<boolean> { return this.sendNow; }

  async deliverNow(session: Session, text: string, beforeWrite: Parameters<FakeNative['deliver']>[2]) {
    if (this.failNowBeforeWrite) throw this.failNowBeforeWrite;
    this.nowWrites.push(text);
    await this.deliver(session, text, beforeWrite);
  }

  subscribe(sessionId: string, listener: (message: DispatchObservation) => void) {
    this.subscribeCalls++;
    this.listeners.set(sessionId, listener);
    if (this.initialStatus) listener({ type: 'status', status: this.initialStatus });
    return () => this.listeners.delete(sessionId);
  }

  subscribeCorrections(listener: (sessionId: string, message: DispatchObservation) => void) {
    this.correctionListeners.add(listener);
    return () => { this.correctionListeners.delete(listener); };
  }

  async snapshot(sessionId: string) {
    const nativeSessionId = this.store.getSession(sessionId).cursorSessionId;
    return { events: [...this.events], status: this.statuses.get(sessionId) ?? this.currentStatus, ...(nativeSessionId ? { nativeSessionId } : {}) };
  }

  status(sessionId: string): NativeStatus {
    this.statusCalls++;
    return this.statuses.get(sessionId) ?? this.currentStatus;
  }

  async interrupt(_session: Session, options?: { clearPrompt?: boolean }): Promise<void> {
    this.interruptCalls++;
    this.interruptOptions.push(options);
    await this.interruptOperation?.();
  }

  async deliver(session: Session, text: string, beforeWrite: (info: { terminalId: string; epoch: number; chatId?: string; baselineSequence?: number }) => void) {
    this.deliverCalls.push(session.id);
    if (this.failBeforeWriteOnce) {
      const error = this.failBeforeWriteOnce;
      this.failBeforeWriteOnce = undefined;
      throw error;
    }
    if (this.failBeforeWrite) throw this.failBeforeWrite;
    const { nativeSessionId, events } = await this.snapshot(session.id);
    beforeWrite({ terminalId: session.terminalId!, epoch: 1, baselineSequence: events.at(-1)?.sequence ?? 0, ...(nativeSessionId ? { chatId: nativeSessionId } : {}) });
    this.writes.push({ sessionId: session.id, text });
    if (this.busyOnWrite) this.statuses.set(session.id, { phase: 'busy' });
    if (this.echoOnWrite) {
      const sequence = Math.max(0, ...this.events.map((event) => event.sequence)) + 1;
      const echo = makeEvent(session.id, sequence, 'user_message_chunk', text);
      this.events.push(echo);
      if (this.echoDuringDelivery) this.emit(session.id, { type: 'events', events: [echo] });
    }
    if (this.failAfterWrite) throw this.failAfterWrite;
  }

  /** A status heard is the provider's status from then on. */
  emit(sessionId: string, message: DispatchObservation) {
    if (message.type === 'status') { this.emittedStatusCount++; this.statuses.set(sessionId, message.status); }
    const direct = this.listeners.get(sessionId);
    if (direct) direct(message);
    else if (message.type === 'events') for (const listener of this.correctionListeners) listener(sessionId, message);
  }
}

class FakeProtocolBackend extends FakeNative {
  sendCount = 0;
  /** A protocol backend owns its own send path; it never takes a launch-argv prompt. */
  override argvInitialPrompt = false;

  async sendRun(session: Session, run: import('../../../../packages/contracts/src/index.js').Run, commitDispatchFence: (binding?: import('../backends/types.js').NativeDispatchBinding) => import('../../../../packages/contracts/src/index.js').Run): Promise<void> {
    this.sendCount++;
    const details = run.native!;
    commitDispatchFence({ backendId: 'codex', nativeSessionId: session.nativeSessionId ?? 'thread-protocol', baselineSequence: 0, renderedText: details.input.text, resolvedConfig: details.config });
    const user = { ...makeEvent(session.id, 1, 'user_message_chunk', details.input.text), data: { commandId: run.commandId, content: { text: details.input.text } } };
    const answer = makeEvent(session.id, 2, 'agent_message_chunk', 'Done');
    this.events = [user, answer];
    this.currentStatus = { phase: 'busy' };
    this.emit(session.id, { type: 'events', events: [user] });
    this.emit(session.id, { type: 'events', events: [answer] });
    this.emit(session.id, { type: 'status', status: this.currentStatus });
    this.currentStatus = { phase: 'idle' };
    this.emit(session.id, { type: 'status', status: this.currentStatus });
  }
}

/** What the Cursor plugin's runtime does with a launch hook: a refusal becomes `NATIVE_LAUNCH_ABORTED`. */
async function runBeforeSpawn(beforeSpawn: (() => void | Promise<void>) | undefined): Promise<void> {
  if (!beforeSpawn) return;
  try { await beforeSpawn(); }
  catch (error) { throw new AppError('NATIVE_LAUNCH_ABORTED', error instanceof Error ? error.message : 'Launch was aborted before the CLI started', 409, { reason: error instanceof AppError ? error.code : undefined }); }
}

class FakeRuntime {
  readonly ensureCalls: string[] = [];
  readonly ensureOptions: Array<{ initialPrompt?: string } | undefined> = [];
  activeCalls = 0;
  maxConcurrent = 0;
  blockedSessionId?: string;
  gate?: Promise<void>;
  ensureError?: Error;
  /**
   * Attach a terminal to the session on first ensure, mirroring the production side effect of
   * `NativeRuntimeManager.ensure`. Phase 1 added the argv initial-prompt branch which triggers
   * whenever the session has no live terminal; tests that exercise the paste path need a
   * terminal attached so they stay on the legacy branch. See
   * plans/replicated-gathering-hammock.md.
   */
  attachTerminal: ((session: Session) => void) | undefined;

  async withSession<T>(_sessionId: string, action: () => Promise<T>): Promise<T> {
    this.activeCalls++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.activeCalls);
    try { return await action(); }
    finally { this.activeCalls--; }
  }

  /** CLIs started with their prompt on argv, i.e. ones that got past `beforeSpawn`. */
  readonly argvSpawns: string[] = [];
  /** Holds the worker after the CLI has spawned, before `ensure` returns: a crash window. */
  afterSpawn?: Promise<void>;
  /** Thrown after the fence went down, as the terminal service refusing the launch before any process exists. */
  spawnError?: Error;

  async ensure(session: Session, options?: { initialPrompt?: string; beforeSpawn?: () => void | Promise<void> }): Promise<void> {
    this.ensureCalls.push(session.id);
    this.ensureOptions.push(options?.initialPrompt !== undefined ? { initialPrompt: options.initialPrompt } : options && {});
    if (this.blockedSessionId === session.id && this.gate) await this.gate;
    if (this.ensureError) throw this.ensureError;
    // Mirrors `NativeRuntimeManager.ensureLocked`: the fence hook runs right before the spawn.
    if (options?.initialPrompt !== undefined) {
      await runBeforeSpawn(options.beforeSpawn);
      if (this.spawnError) throw this.spawnError;
      this.argvSpawns.push(options.initialPrompt);
    }
    this.attachTerminal?.(session);
    if (this.afterSpawn) await this.afterSpawn;
  }
}

function setup() {
  const store = new Store(':memory:');
  const project = store.createProject(`/tmp/native-dispatch-${randomUUID()}`, 'Dispatcher test');
  const createSession = () => store.createSession({ projectId: project.id, kind: 'native', model: config.model, mode: config.mode, cursorSessionId: `chat-${randomUUID()}` });
  const accept = (sessionId: string, commandId: string, text: string) => store.acceptNativeRun(sessionId, commandId, input(text), config, 0);
  const workspace = { readAttachment: async () => { throw new Error('This test does not use attachments'); } };
  // Phase 1: production `runtime.ensure()` writes `session.terminalId` on first spawn. The
  // dispatcher's new argv initial-prompt branch triggers whenever the session has no live
  // terminal, so tests that exercise the paste path need a terminal attached. Default every
  // `FakeRuntime` instance here to the paste-path mode; tests that want to exercise the argv
  // branch call `runtime.attachTerminal = undefined` and read `runtime.ensureOptions`.
  const attachTerminal = (session: Session) => {
    const current = store.getSession(session.id);
    if (current.terminalId) return;
    const terminalId = `terminal-${session.id}`;
    store.updateSession(session.id, { terminalId });
    saveNativeTerminal(store, store.getSession(session.id));
  };
  const makeRuntime = () => {
    const runtime = new FakeRuntime();
    runtime.attachTerminal = attachTerminal;
    return runtime;
  };
  return { store, project, createSession, accept, workspace, makeRuntime };
}

function saveNativeTerminal(store: Store, session: Session, state: TerminalInfo['state'] = 'running', epoch = 12, kind: TerminalInfo['kind'] = 'cursor'): TerminalInfo {
  return store.saveTerminal({
    id: session.terminalId!, projectId: session.projectId, sessionId: session.id,
    title: 'Cursor Agent', kind, state, persistent: true, epoch, cols: 80, rows: 24,
    createdAt: new Date(0).toISOString(),
  });
}

function seedDeliveredRun(
  store: Store,
  session: Session,
  runId: string,
  delivery: Extract<NativeDeliveryState, 'input_sent' | 'observed' | 'uncertain'>,
  options: { terminalState?: TerminalInfo['state']; terminalKind?: TerminalInfo['kind']; receipt?: boolean; epoch?: number; timings?: Record<string, number> } = {},
) {
  const terminalId = `terminal-${session.id}`;
  const updatedSession = store.updateSession(session.id, { terminalId, state: 'running' });
  const terminal = saveNativeTerminal(store, updatedSession, options.terminalState, options.epoch, options.terminalKind);
  const run = store.getRun(runId);
  return store.transitionNativeRun(runId, ['queued'], {
    delivery,
    stage: delivery === 'uncertain' ? 'runtime_exit' : delivery === 'observed' ? 'executing' : 'confirmation',
    terminalId: terminal.id,
    terminalEpoch: 8,
    cursorSessionId: updatedSession.cursorSessionId,
    renderedText: run.native?.renderedText ?? run.prompt,
    baselineSequence: 0,
    ...(options.receipt === false ? {} : { nativeMessageId: 'native-receipt-1' }),
    timings: options.timings ?? { inputSentAt: nowForTest() - 1_000, ...(delivery === 'observed' ? { firstOutputAt: nowForTest() - 500 } : {}) },
  }, {
    state: delivery === 'observed' ? 'running' : delivery === 'uncertain' ? 'interrupted' : 'queued',
    ...(delivery === 'uncertain' ? { error: 'CLI 已退出，消息执行结果尚未确认。' } : {}),
  })!;
}

function dispatcher(store: Store, native: FakeNative, runtime: FakeRuntime, workspace: object, confirmationMs = 60_000) {
  // Runtime/workspace are intentionally narrow test doubles; Store and dispatcher transitions are real.
  return new NativeDispatcher(store, native as never, runtime as never, workspace as never, { intervalMs: 60_000, confirmationMs });
}

describe('NativeDispatcher durable delivery', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  it.each([false, true])('retains an offline session message through recovery (fails: %s)', async fails => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = store.updateSession(createSession().id, { nativeSessionId: 'saved-conversation' });
    const run = accept(session.id, 'recover-and-send', 'continue the task');
    const runtime = makeRuntime(), backend = new FakeNative(store), gate = deferred();
    backend.currentStatus = { phase: 'offline' };
    backend.argvInitialPrompt = false;
    runtime.blockedSessionId = session.id;
    runtime.gate = gate.promise;
    if (fails) runtime.ensureError = new Error('Saved conversation could not be restored');
    const send = dispatcher(store, backend, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());
    send.kick();
    await until(() => runtime.ensureCalls.length === 1, 'pending recovery');
    expect(store.getRun(run.id)).toMatchObject({
      commandId: 'recover-and-send', prompt: 'continue the task',
      native: { delivery: 'preparing', stage: 'resuming', input: input('continue the task') },
    });
    expect(backend.writes).toEqual([]);
    gate.resolve();
    await until(() => store.getRun(run.id).native?.delivery === (fails ? 'failed' : 'input_sent'), 'recovery result');
    const retained = accept(session.id, 'recover-and-send', 'continue the task');
    expect(retained.id).toBe(run.id);
    send.kick();
    await pause();
    expect(runtime.ensureCalls).toEqual([session.id]);
    expect(backend.writes).toEqual(fails ? [] : [{ sessionId: session.id, text: 'continue the task' }]);
    expect(store.getRun(run.id)).toMatchObject({
      commandId: 'recover-and-send', prompt: 'continue the task',
      native: { input: input('continue the task'), stage: fails ? 'prepare' : 'confirmation' },
      ...(fails ? { state: 'failed', error: 'Saved conversation could not be restored' } : {}),
    });
  });

  it('keeps a message sent to an offline session inline while only its own delivery holds it (A6)', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = store.updateSession(createSession().id, { nativeSessionId: 'saved-conversation' });
    const run = accept(session.id, 'resume-and-send', 'continue the task');
    const runtime = makeRuntime(), backend = new FakeNative(store), lock = deferred();
    backend.currentStatus = { phase: 'offline' };
    backend.argvInitialPrompt = false;
    runtime.ensureError = new AppError('CLI_BUSY', 'Try again later', 409);
    const locked = runtime.withSession.bind(runtime);
    runtime.withSession = async (id, action) => { await lock.promise; return locked(id, action); };
    const send = dispatcher(store, backend, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());
    const seen = () => {
      const status = backend.status(session.id), queue = send.queue(session.id, status);
      const entry = buildSessionControlSnapshot({ revision: 1, session: store.getSession(session.id), status, queue, taken: send.taken(session.id), runs: store.listUnfinishedNativeRuns(session.id) }).inbox.find(item => item.id === run.id);
      return [queue.held?.reason, entry?.placement];
    };
    expect(seen()).toEqual([undefined, 'sending']);
    send.kick();
    // Its worker waits for the session lock (a resume holds it) before the run leaves `queued`.
    await until(() => send.taken(session.id) === run.id, 'worker took the run');
    expect(store.getRun(run.id).native?.delivery).toBe('queued');
    expect(seen()).toEqual(['sending', 'sending']);
    // The CLI refuses it while it comes up; the run backs off in `queued`.
    lock.resolve();
    await until(() => store.getRun(run.id).native?.attempt === 1 && store.getRun(run.id).native?.delivery === 'queued', 'refused and backing off');
    expect(seen()).toEqual(['retrying', 'sending']);
    // A second message waits behind it.
    const later = accept(session.id, 'after-resume', 'and then this');
    const status = backend.status(session.id);
    expect(buildSessionControlSnapshot({ revision: 2, session: store.getSession(session.id), status, queue: send.queue(session.id, status), runs: store.listUnfinishedNativeRuns(session.id) }).inbox.find(item => item.id === later.id)?.placement).toBe('queued');
  });

  it.each(['running', 'cold'] as const)('sends to a %s CLI without waiting for a checkpoint that never finishes', async cli => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    let session = createSession();
    if (cli === 'running') session = store.updateSession(session.id, { terminalId: `terminal-${session.id}` }), saveNativeTerminal(store, session);
    const run = accept(session.id, 'checkpoint-pending', 'inspect once');
    const runtime = makeRuntime(), backend = new FakeNative(store);
    let since: number | undefined;
    const send = new NativeDispatcher(store, backend, runtime as never, workspace as never, {
      intervalMs: 60_000,
      beforeTurn: async (_session, _run, at) => { since = at; await new Promise(() => {}); },
    });
    cleanups.push(() => store.close(), () => send.close());
    send.kick();
    await until(() => store.getRun(run.id).native?.delivery === 'input_sent', 'dispatch with the checkpoint pending');
    // The checkpoint tells the turn's changes apart by the time the turn was claimed, before anything was sent.
    expect(since).toBe(store.getRun(run.id).native?.timings?.prepareAt);
    expect(cli === 'running' ? backend.writes : runtime.argvSpawns).toEqual(cli === 'running' ? [{ sessionId: session.id, text: 'inspect once' }] : ['inspect once']);
  });

  it('does not retake a failed checkpoint when a preparing run retries after restart', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'checkpoint-retry', 'inspect once');
    const runtime = makeRuntime(), backend = new FakeNative(store);
    runtime.ensureError = new AppError('CLI_BUSY', 'Try again later', 409);
    let checkpoints = 0;
    const options = { intervalMs: 60_000, beforeTurn: async () => { checkpoints++; throw new Error('snapshot failed'); } };
    const send = new NativeDispatcher(store, backend, runtime as never, workspace as never, options);
    cleanups.push(() => store.close(), () => send.close());
    send.kick();
    await until(() => store.getRun(run.id).native?.attempt === 1 && store.getRun(run.id).native?.delivery === 'queued', 'busy retry queued');
    expect(store.getRun(run.id).native?.checkpointAttempted).toBe(true);
    await send.close();
    const restarted = new NativeDispatcher(store, backend, makeRuntime() as never, workspace as never, options);
    cleanups.push(() => restarted.close());
    restarted.kick();
    await until(() => store.getRun(run.id).native?.delivery === 'input_sent', 'retry dispatch after restart');
    expect(checkpoints).toBe(1);
  });

  it('fails a message that a wedged CLI has refused for too long, and never offers one to a CLI running a turn', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const wedgedSession = createSession(), turnSession = createSession();
    const wedged = accept(wedgedSession.id, 'wedged', 'hello'), behindTurn = accept(turnSession.id, 'behind-turn', 'hello');
    // Both have been bouncing off a busy CLI for longer than the limit; only one CLI is running a turn.
    for (const run of [wedged, behindTurn]) {
      store.transitionNativeRun(run.id, ['queued'], { timings: { blockedAt: Date.now() - 10 * 60_000 } });
    }
    const runtime = makeRuntime(), backend = new FakeNative(store);
    runtime.ensureError = new AppError('CLI_BUSY', 'Try again later', 409);
    backend.status = (sessionId: string) => ({ phase: sessionId === turnSession.id ? 'busy' : 'starting' });
    const send = new NativeDispatcher(store, backend, runtime as never, workspace as never, { intervalMs: 60_000 });
    cleanups.push(() => store.close(), () => send.close());
    send.kick();
    await until(() => store.getRun(wedged.id).state === 'failed', 'wedged run failed');
    expect(store.getRun(wedged.id).native).toMatchObject({ delivery: 'failed', attempt: 1 });
    // Held behind the live turn: never prepared, so it neither counts as wedged nor takes a checkpoint early.
    expect(store.getRun(behindTurn.id)).toMatchObject({ state: 'queued', native: { delivery: 'queued', attempt: 0 } });
    expect(backend.writes).toEqual([]);
    expect(runtime.ensureCalls).toEqual([wedgedSession.id]);
  });

  it('holds a message for a pending relaunch while background work runs, and never fails it as a wedged CLI', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession();
    store.updateSession(session.id, { backendId: 'claude', configPending: true });
    const run = accept(session.id, 'pending-relaunch', 'hello');
    store.transitionNativeRun(run.id, ['queued'], { timings: { blockedAt: Date.now() - 10 * 60_000 } });
    const runtime = makeRuntime(), backend = new FakeNative(store);
    runtime.ensureError = new AppError('CLI_BUSY', 'Finish background work first', 409);
    backend.status = () => ({ phase: 'idle', activity: { compacting: false, background: 1 } });
    const send = new NativeDispatcher(store, backend, runtime as never, workspace as never, { intervalMs: 60_000 });
    cleanups.push(() => store.close(), () => send.close());
    send.kick();
    await pause(50);
    expect(store.getRun(run.id)).toMatchObject({ state: 'queued', native: { delivery: 'queued', attempt: 0 } });
    expect(runtime.ensureCalls).toEqual([]);
    expect(send.queue(session.id, backend.status(session.id)).held?.reason).toBe('turn_running');
  });

  it('keeps a DSH message in the cancellable Riffet queue while autonomous native work is busy', async () => {
    const { store, project, workspace } = setup();
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'dsh', nativeSessionId: 'dsh-chat', mode: 'agent' });
    const run = store.acceptNativeRun(session.id, 'queued-once', input('next task'), config, 0);
    const backend = new FakeProtocolBackend(store);
    const send = dispatcher(store, backend, new FakeRuntime(), workspace);
    cleanups.push(() => store.close(), () => send.close());
    for (const phase of ['busy', 'attention', 'starting'] as const) {
      backend.currentStatus = { phase };
      send.kick();
      await pause();
      expect(store.getRun(run.id).native?.delivery).toBe('queued');
      expect(backend.sendCount).toBe(0);
    }
    backend.currentStatus = { phase: 'idle' };
    send.kick();
    await until(() => store.getRun(run.id).state === 'completed', 'idle DSH dispatch');
    send.kick();
    expect(backend.sendCount).toBe(1);
  });

  it('waits for a busy RPC receipt without a terminal and never releases the next queued message early', async () => {
    const { store, project, workspace } = setup();
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'dsh', nativeSessionId: 'dsh-chat', mode: 'agent' });
    const first = store.acceptNativeRun(session.id, 'already-sent', input('inspect once'), config, 0);
    const next = store.acceptNativeRun(session.id, 'queued-next', input('next task'), config, 0);
    store.transitionNativeRun(first.id, ['queued'], {
      delivery: 'input_sent', stage: 'confirmation', backendId: 'dsh', nativeSessionId: 'dsh-chat',
      baselineSequence: 0, timings: { inputSentAt: Date.now() - 60_000 },
    });
    const backend = new FakeProtocolBackend(store);
    const send = dispatcher(store, backend, new FakeRuntime(), workspace, 10);
    cleanups.push(() => store.close(), () => send.close());
    for (const phase of ['busy', 'attention'] as const) {
      backend.currentStatus = { phase };
      send.kick();
      await pause();
      expect(store.getRun(first.id).native?.delivery).toBe('input_sent');
      expect(store.getRun(first.id).native?.nativeMessageId).toBeUndefined();
      expect(store.getRun(next.id).native?.delivery).toBe('queued');
      expect(backend.sendCount).toBe(0);
    }
    const receipt = makeEvent(session.id, 1, 'user_message_chunk', first.prompt);
    receipt.data.commandId = first.commandId;
    backend.emit(session.id, { type: 'events', events: [receipt] });
    expect(store.getRun(first.id)).toMatchObject({ state: 'running', native: { delivery: 'observed', nativeMessageId: receipt.nativeId } });
    expect(backend.sendCount).toBe(0);
  });

  it.each(['idle', 'wrong-chat'] as const)('keeps an unconfirmed RPC write fenced when %s cannot prove it is live', async (scenario) => {
    const { store, project, workspace } = setup();
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'dsh', nativeSessionId: 'dsh-chat', mode: 'agent' });
    const first = store.acceptNativeRun(session.id, 'already-sent', input('inspect once'), config, 0);
    const next = store.acceptNativeRun(session.id, 'queued-next', input('next task'), config, 0);
    store.transitionNativeRun(first.id, ['queued'], {
      delivery: 'input_sent', stage: 'confirmation', backendId: 'dsh',
      nativeSessionId: scenario === 'wrong-chat' ? 'old-chat' : 'dsh-chat',
      baselineSequence: 0, timings: { inputSentAt: Date.now() - 60_000 },
    });
    const backend = new FakeProtocolBackend(store);
    backend.currentStatus = { phase: scenario === 'idle' ? 'idle' : 'busy' };
    const send = dispatcher(store, backend, new FakeRuntime(), workspace, 10);
    cleanups.push(() => store.close(), () => send.close());
    send.kick();
    await pause();
    expect(store.getRun(first.id).native?.delivery).toBe('uncertain');
    send.kick();
    expect(store.getRun(next.id).native?.delivery).toBe('queued');
    expect(backend.sendCount).toBe(0);
  });

  it('dispatches a durable run with no browser subscriber and does not resend an idempotent retry', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession();
    const first = accept(session.id, 'command-once', '/clear');
    const retry = accept(session.id, 'command-once', '/clear');
    expect(retry.id).toBe(first.id);
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => store.getRun(first.id).state === 'completed', 'slash command completion');
    expect(native.writes).toEqual([{ sessionId: session.id, text: '/clear' }]);
    expect(native.subscribeCalls).toBe(1); // The dispatcher owns this observer; no browser is connected.
    expect(store.listRuns(session.id)).toHaveLength(1);
    expect(store.findRunByCommand(session.id, 'command-once')?.id).toBe(first.id);
    expect(store.findRunByCommand(session.id, 'missing-command')).toBeUndefined();
  });

  it('unsubscribes the observer and drops the session actor once its run completes', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'actor-evict', '/clear');
    const native = new FakeNative(store), runtime = makeRuntime();
    let unsubscribed = 0;
    const subscribe = native.subscribe.bind(native);
    native.subscribe = (sessionId, listener) => {
      const unsubscribe = subscribe(sessionId, listener);
      return () => { unsubscribed += 1; return unsubscribe(); };
    };
    const send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());
    const actors = () => Reflect.get(send, 'actors') as Map<string, { timer?: NodeJS.Timeout }>;

    send.kick();
    await until(() => store.getRun(run.id).state === 'completed', 'slash command completion');
    await until(() => unsubscribed === 1 && actors().size === 0, 'actor eviction');
    expect(native.listeners.has(session.id)).toBe(false);
    expect(native.subscribeCalls).toBe(1);
    expect([...actors().values()].every(actor => actor.timer === undefined)).toBe(true);
    await pause(40);
    expect(unsubscribed).toBe(1);
    expect(native.subscribeCalls).toBe(1);
    expect(actors().size).toBe(0);
  });

  it('applies a confirmation timeout and a retry delay from per-session deadlines, with no periodic kick', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const confirmSession = createSession(), retrySession = createSession();
    const confirm = accept(confirmSession.id, 'confirm-timeout', 'inspect once');
    const sentAt = Date.now();
    store.transitionNativeRun(confirm.id, ['queued'], {
      delivery: 'input_sent', stage: 'confirmation', timings: { inputSentAt: sentAt },
    }, { state: 'queued' });
    const retry = accept(retrySession.id, 'retry-delay', '/clear');
    const native = new FakeNative(store), runtime = makeRuntime();
    runtime.ensureError = new AppError('CLI_BUSY', 'Try again later', 409);
    const send = new NativeDispatcher(store, native as never, runtime as never, workspace as never, { intervalMs: 60_000, confirmationMs: 200, busyLimitMs: 60_000 });
    cleanups.push(() => store.close(), () => send.close());

    // Nothing calls kick() again. A 60s poll cannot be what moves either run.
    await until(() => store.getRun(confirm.id).native?.delivery === 'uncertain', 'confirmation timeout', 5_000);
    expect(Date.now() - sentAt).toBeLessThan(10_000);
    expect(store.getRun(retry.id)).toMatchObject({ state: 'queued', native: { delivery: 'queued' } });
    expect(runtime.ensureCalls).toEqual([retrySession.id]);
    await until(() => runtime.ensureCalls.length >= 2, 'retry after its delay', 5_000);
    expect(runtime.ensureCalls).toEqual([retrySession.id, retrySession.id]);
    expect(store.getRun(confirm.id).native?.delivery).toBe('uncertain');
  });

  it('leaves a run queued while its backend\'s plugin is still starting, and delivers it once the backend is there', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'waits-for-plugin', '/clear');
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());
    native.starting = true;
    send.kick();
    await pause(30);
    expect(store.getRun(run.id).native?.delivery).toBe('queued');
    expect(runtime.ensureCalls).toEqual([]);
    native.starting = false;
    send.kick();
    await until(() => store.getRun(run.id).state === 'completed', 'the run delivered after the plugin started');
  });

  // A queued message is delivered under the settings in effect when it starts, the way DSH resolves
  // a selection at step assembly. A switch made while it waited must neither fail the message nor be
  // ignored: `sendRun` reads the live session (see `service-config.test.ts`), and the run keeps what
  // it was accepted with as its own record.
  it('delivers a run whose configuration changed while it waited in the queue', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'adopted-config', 'switch the model');
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    store.updateSession(session.id, { model: 'gpt-5.6-luna[effort=high]', configRevision: (session.configRevision ?? 0) + 1 });

    send.kick();
    await until(() => store.getRun(run.id).native?.delivery === 'input_sent', 'the queued run to be delivered');
    // Delivered, not refused — and the accepted snapshot is still on the run as its own record.
    expect(store.getRun(run.id).error).toBeUndefined();
    expect(store.getRun(run.id).native?.config.model).toBe('gpt-5.6-luna');
  });

  // A switch asked for mid-turn is not the dispatcher's business any more: `configureNative` no longer
  // refuses one, and the backends that cannot apply it without killing the turn record it and apply it
  // at the next idle moment (`native/service-configure.test.ts` pins that for Cursor).

  it('uses protocol command receipts to complete a non-TTY backend run', async () => {
    const { store, project, workspace } = setup();
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex', backendProfileId: 'local', nativeSessionId: 'thread-1', model: 'codex', mode: 'default', approval: 'on-request' });
    const run = store.acceptNativeRun(session.id, 'protocol-command', input('inspect this workspace'), { model: 'codex', mode: 'default', approval: 'on-request' }, 0);
    const backend = new FakeProtocolBackend(store), runtime = new FakeRuntime(), send = dispatcher(store, backend, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => store.getRun(run.id).state === 'completed', 'protocol run completion');
    expect(backend.sendCount).toBe(1);
    expect(store.getRun(run.id)).toMatchObject({ state: 'completed', native: { backendId: 'codex', nativeSessionId: 'thread-1', nativeMessageId: 'native-1' } });
  });

  it('tracks a leading /skill as a turn when the provider says it is not a slash command', async () => {
    const { store, project, workspace } = setup();
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'claude', backendProfileId: 'local', nativeSessionId: 'claude-1', model: 'haiku', mode: 'agent', approval: 'default' });
    const run = store.acceptNativeRun(session.id, 'skill-turn', input('/dataviz chart this'), { model: 'haiku', mode: 'agent', approval: 'default' }, 0);
    class SkillBackend extends FakeProtocolBackend {
      override async sendRun(target: Session, accepted: Parameters<FakeProtocolBackend['sendRun']>[1], commit: Parameters<FakeProtocolBackend['sendRun']>[2]): Promise<void> {
        await super.sendRun(target, accepted, binding => commit({ ...binding, backendId: 'claude', slashCommand: false }));
      }
    }
    const backend = new SkillBackend(store), runtime = new FakeRuntime(), send = dispatcher(store, backend, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => store.getRun(run.id).state === 'completed', 'skill turn completion');
    // Observed through its transcript echo, not closed at the PTY write like a command.
    expect(store.getRun(run.id).native).toMatchObject({ slashCommand: false, delivery: 'observed', nativeMessageId: 'native-1' });
  });

  it('keeps a handed-over protocol send pending when the provider cannot list its brand-new thread yet', async () => {
    const { store, project, workspace } = setup();
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex', backendProfileId: 'local', nativeSessionId: 'thread-1', model: 'codex', mode: 'default', approval: 'on-request' });
    const run = store.acceptNativeRun(session.id, 'first-turn', input('plan the extension manager'), { model: 'codex', mode: 'default', approval: 'on-request' }, 0);
    class UnmaterializedBackend extends FakeProtocolBackend {
      override async sendRun(target: Session, accepted: Parameters<FakeProtocolBackend['sendRun']>[1], commit: Parameters<FakeProtocolBackend['sendRun']>[2]): Promise<void> {
        this.sendCount++;
        commit({ backendId: 'codex', nativeSessionId: target.nativeSessionId!, baselineSequence: 0, renderedText: accepted.native!.input.text, resolvedConfig: accepted.native!.config });
      }
      override async snapshot(): Promise<never> { throw new Error('thread history is not available yet'); }
    }
    const backend = new UnmaterializedBackend(store), runtime = new FakeRuntime(), send = dispatcher(store, backend, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => store.getRun(run.id).native?.delivery === 'input_sent', 'the handed-over send');
    await pause(20);
    expect(store.getRun(run.id)).toMatchObject({ state: 'queued', native: { delivery: 'input_sent' } });
    expect(store.getRun(run.id).error).toBeUndefined();

    const user = { ...makeEvent(session.id, 1, 'user_message_chunk', 'plan the extension manager'), data: { commandId: run.commandId, content: { text: 'plan the extension manager' } } };
    backend.emit(session.id, { type: 'events', events: [user] });
    expect(store.getRun(run.id)).toMatchObject({ state: 'running', native: { delivery: 'observed', nativeMessageId: user.nativeId } });
  });

  it.each([
    { baselineSequence: 0, receiptType: 'user_message_chunk' },
    { baselineSequence: 1316, receiptType: 'user_message_chunk' },
    { baselineSequence: 1316, receiptType: 'native_input_receipt' },
  ])('takes an uncertain run back to running for $receiptType after baseline $baselineSequence', async ({ baselineSequence, receiptType }) => {
    const { store, project, workspace } = setup();
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex', backendProfileId: 'local', nativeSessionId: 'thread-1', model: 'codex', mode: 'default', approval: 'on-request' });
    const run = store.acceptNativeRun(session.id, 'late-receipt', input('apply a change'), { model: 'codex', mode: 'default', approval: 'on-request' }, 0);
    store.transitionNativeRun(run.id, ['queued'], { delivery: 'uncertain', stage: 'confirmation', backendId: 'codex', nativeSessionId: 'thread-1', baselineSequence }, { state: 'interrupted', error: 'unconfirmed' });
    const backend = new FakeProtocolBackend(store), runtime = new FakeRuntime(), send = dispatcher(store, backend, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => backend.listeners.has(session.id), 'the dispatcher observer');
    const user = { ...makeEvent(session.id, 1, receiptType, 'apply a change'), data: { commandId: run.commandId, content: { text: 'apply a change' } } };
    backend.emit(session.id, { type: 'events', events: [{ ...user, data: { ...user.data, commandId: 'another-submission' } }] });
    expect(store.getRun(run.id).native?.delivery).toBe('uncertain');
    backend.emit(session.id, { type: 'events', events: [user] });
    expect(store.getRun(run.id)).toMatchObject({ state: 'running', native: { delivery: 'observed', nativeMessageId: user.nativeId } });
    expect(store.getRun(run.id).error).toBeUndefined();
    expect(backend.sendCount).toBe(0);

    // Resolving an unknown input is a durable user decision. A late queued-input receipt
    // may supply its exact native id, but neither that receipt nor its outcome can restart it.
    const resolved = store.acceptNativeRun(session.id, 'resolved-late-input', input('another change'), config, 0);
    store.transitionNativeRun(resolved.id, ['queued'], { delivery: 'uncertain', nativeSessionId: 'thread-1' }, { state: 'interrupted' });
    // Persisted by an older client/server: keep its historical explicit resolution terminal.
    store.transitionNativeRun(resolved.id, ['uncertain'], { delivery: 'cancelled', stage: 'acknowledged' }, { state: 'cancelled' });
    const late = { ...makeEvent(session.id, 2, receiptType, resolved.prompt), data: { commandId: resolved.commandId } };
    backend.emit(session.id, { type: 'events', events: [late, { ...makeEvent(session.id, 3, 'run_completed', ''), data: { commandId: resolved.commandId } }] });
    expect(store.getRun(resolved.id)).toMatchObject({ state: 'cancelled', native: { delivery: 'cancelled', stage: 'acknowledged', nativeMessageId: late.nativeId } });
    expect(backend.sendCount).toBe(0);
  });

  it('discards obsolete turn and steer outcomes before receipts, preserving explicit resolutions and other turns', () => {
    const { store, project, workspace } = setup();
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex', nativeSessionId: 'thread-1', mode: 'agent' });
    const target = { nativeSessionId: 'thread-1', turnId: 'turn-1' };
    const owner = store.acceptNativeRun(session.id, 'owner', input('build it'), config, 0);
    store.transitionNativeRun(owner.id, ['queued'], { delivery: 'observed', stage: 'executing', nativeSessionId: target.nativeSessionId, nativeTurnId: target.turnId, nativeMessageId: 'owner-receipt', attempt: 1 }, { state: 'running' });
    const steer = store.acceptNativeRun(session.id, 'steer', input('focus here'), config, 0, { target, ownerRunId: owner.id });
    store.transitionNativeRun(steer.id, ['queued'], { delivery: 'input_sent', stage: 'steer_confirmation', attempt: 1 }, { state: 'running' });
    const preserved = [
      { stage: 'acknowledged', state: 'cancelled', delivery: 'cancelled' },
      { stage: 'cancelled', state: 'cancelled', delivery: 'cancelled' },
      { stage: 'steer_stopped', state: 'interrupted', delivery: 'uncertain' },
      { stage: 'interrupted', state: 'interrupted', delivery: 'cancelled' },
    ] as const;
    const resolved = preserved.map(({ stage, state, delivery }) => {
      const run = store.acceptNativeRun(session.id, stage, input(stage), config, 0, { target, ownerRunId: owner.id });
      return store.transitionNativeRun(run.id, ['queued'], {
        delivery, stage, nativeMessageId: `receipt:${stage}`,
        ...(stage === 'steer_stopped' ? { queueReleasedAt: new Date(0).toISOString() } : {}),
      }, { state })!;
    });
    const other = store.acceptNativeRun(session.id, 'other-turn', input('other'), config, 0);
    resolved.push(store.transitionNativeRun(other.id, ['queued'], { delivery: 'cancelled', stage: 'provider_cancelled', nativeSessionId: target.nativeSessionId, nativeTurnId: 'other-turn', nativeMessageId: 'other-receipt' }, { state: 'interrupted' })!);
    const backend = new FakeProtocolBackend(store), runtime = new FakeRuntime(), send = dispatcher(store, backend, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());
    send.kick();
    const outcome = (type: string, revision: number, commandId?: string): NativeWorkbenchEvent => ({
      ...makeEvent(session.id, revision, type, ''), nativeTurnId: target.turnId,
      data: { nativeSessionId: target.nativeSessionId, outcomeRevision: revision, ...(commandId ? { commandId } : {}) },
    });
    backend.emit(session.id, { type: 'events', events: [outcome('run_cancelled', 1, steer.commandId), outcome('run_cancelled', 1)] });
    expect(store.getRun(owner.id)).toMatchObject({ state: 'interrupted', native: { stage: 'provider_cancelled' } });
    const receipt = { ...makeEvent(session.id, 4, 'user_message_chunk', steer.prompt), nativeTurnId: target.turnId, data: { commandId: steer.commandId } };
    // Reopen follows the receipt in the delivered batch, while the old steer outcome is cached.
    backend.emit(session.id, { type: 'events', events: [receipt, outcome('native_turn_reopened', 2)] });
    for (const run of [owner, steer]) expect(store.getRun(run.id)).toMatchObject({ state: 'running', native: { delivery: 'observed', stage: 'executing', attempt: 1 } });
    backend.emit(session.id, { type: 'events', events: [outcome('run_failed', 1), outcome('run_cancelled', 1, steer.commandId)] });
    for (const run of [owner, steer]) expect(store.getRun(run.id).state).toBe('running');
    backend.emit(session.id, { type: 'events', events: [outcome('run_completed', 3)] });
    for (const run of [owner, steer]) expect(store.getRun(run.id).state).toBe('completed');
    // A restart replays a corrected end that is still a cancellation: the cancelled Run stays as it is.
    backend.emit(session.id, { type: 'events', events: [{ ...outcome('run_cancelled', 2), nativeTurnId: 'other-turn' }] });
    for (const before of resolved) expect(store.getRun(before.id)).toEqual(before);
    expect(backend.sendCount).toBe(0);
  });

  it.each([
    { type: 'run_failed', state: 'failed', delivery: 'failed', stage: 'provider_failed' },
    { type: 'run_completed', state: 'completed', delivery: 'observed', stage: 'completed' },
  ] as const)('restores a retracted $type without resending or overriding a user stop', ({ type, state, delivery, stage }) => {
    const { store, project, workspace } = setup();
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'claude', nativeSessionId: 'chat-1', mode: 'agent' });
    const target = { nativeSessionId: 'chat-1', turnId: 'turn-1' };
    const run = store.acceptNativeRun(session.id, 'owner', input('work'), config, 0);
    store.transitionNativeRun(run.id, ['queued'], { delivery: 'observed', stage: 'executing', nativeSessionId: target.nativeSessionId, nativeTurnId: target.turnId,
      nativeMessageId: 'receipt', attempt: 1, timings: { inputSentAt: 1, observedAt: 2, completedAt: 3, interruptedAt: 4 } }, { state: 'running' });
    const backend = new FakeProtocolBackend(store), runtime = new FakeRuntime(), send = dispatcher(store, backend, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());
    send.kick();
    const outcome = (eventType: string, revision: number, turnId = target.turnId): NativeWorkbenchEvent => ({
      ...makeEvent(session.id, revision, eventType, ''), nativeTurnId: turnId,
      data: { nativeSessionId: target.nativeSessionId, outcomeRevision: revision, error: 'old failure' },
    });
    // A newer ordinary result cannot undo a settled run; only a scoped, newer retraction can.
    backend.emit(session.id, { type: 'events', events: [outcome(type, 1)] });
    expect(store.getRun(run.id)).toMatchObject({ state, native: { delivery, stage } });
    backend.emit(session.id, { type: 'events', events: [outcome('run_completed', 2), outcome('native_turn_reopened', 1)] });
    expect(store.getRun(run.id).state).toBe(state);
    backend.emit(session.id, { type: 'events', events: [{ ...outcome('native_turn_reopened', 3), data: { nativeSessionId: 'other-chat', outcomeRevision: 3 } }] });
    expect(store.getRun(run.id).state).toBe(state);
    backend.emit(session.id, { type: 'events', events: [outcome('native_turn_reopened', 3)] });
    expect(store.getRun(run.id)).toMatchObject({ state: 'running', native: { delivery: 'observed', stage: 'executing', attempt: 1,
      timings: { inputSentAt: 1, observedAt: 2 } } });
    expect(store.getRun(run.id).native!.timings?.completedAt).toBeUndefined();
    expect(store.getRun(run.id).native!.timings?.interruptedAt).toBeUndefined();
    expect(store.getRun(run.id).error).toBeUndefined();
    const reopened = store.getRun(run.id);
    backend.emit(session.id, { type: 'events', events: [outcome('native_turn_reopened', 3), outcome(type, 1)] });
    expect(store.getRun(run.id)).toEqual(reopened);
    backend.emit(session.id, { type: 'events', events: [outcome('run_completed', 4)] });
    expect(store.getRun(run.id)).toMatchObject({ state: 'completed', native: { delivery: 'observed', stage: 'completed' } });
    // A caught-up journal batch can contain both the retraction and its corrected final result.
    backend.emit(session.id, { type: 'events', events: [outcome('run_failed', 6), outcome('native_turn_reopened', 5)] });
    expect(store.getRun(run.id)).toMatchObject({ state: 'failed', native: { delivery: 'failed', stage: 'provider_failed' } });

    const stopped = store.acceptNativeRun(session.id, 'stopped', input('stopped work'), config, 0);
    store.transitionNativeRun(stopped.id, ['queued'], { delivery, stage, nativeSessionId: target.nativeSessionId, nativeTurnId: 'stopped-turn', nativeMessageId: 'stopped-receipt' }, { state });
    store.setSetting(`native-stops:${session.id}`, { '"stop-1"': { request: { requestId: 'stop-1', nativeSessionId: target.nativeSessionId, turnId: 'stopped-turn' }, operation: 'stop', state: 'completed', createdAt: '', runId: stopped.id } });
    const beforeStop = store.getRun(stopped.id);
    backend.emit(session.id, { type: 'events', events: [outcome('native_turn_reopened', 2, 'stopped-turn')] });
    expect(store.getRun(stopped.id)).toEqual(beforeStop);
    expect(backend.sendCount).toBe(0);
  });

  it('keeps an unconfirmed protocol delivery fenced after restart without replay', async () => {
    const { store, project, workspace } = setup();
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex', backendProfileId: 'local', nativeSessionId: 'thread-1', model: 'codex', mode: 'default', approval: 'on-request' });
    const run = store.acceptNativeRun(session.id, 'unknown-protocol-command', input('apply a change'), { model: 'codex', mode: 'default', approval: 'on-request' }, 0);
    store.transitionNativeRun(run.id, ['queued'], { delivery: 'dispatching', backendId: 'codex', nativeSessionId: 'thread-1' }, { state: 'interrupted' });
    store.recoverInterruptedRuns();
    expect(store.getRun(run.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'uncertain' } });
    const backend = new FakeProtocolBackend(store), runtime = new FakeRuntime(), send = dispatcher(store, backend, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await pause(20);
    expect(backend.sendCount).toBe(0);
    expect(store.getRun(run.id).native?.delivery).toBe('uncertain');
  });

  it('holds new deliveries while draining and blocks a restart only on turns it would end', async () => {
    const { store, project, createSession, accept, workspace, makeRuntime } = setup();
    const runtime = makeRuntime(), native = new FakeNative(store), send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());
    const running = (backendId: 'codex' | 'dsh') => {
      const session = store.createSession({ projectId: project.id, kind: 'native', backendId, nativeSessionId: `${backendId}-chat`, model: config.model, mode: config.mode });
      const run = accept(session.id, `${backendId}-turn`, 'keep working');
      store.transitionNativeRun(run.id, ['queued'], { delivery: 'observed', stage: 'executing', nativeMessageId: `${backendId}-receipt`, nativeTurnId: `${backendId}-turn` }, { state: 'running' });
      return session;
    };
    running('codex');
    const dsh = running('dsh');
    expect(send.restartability()).toMatchObject({ restartable: false, blockers: [{ sessionId: dsh.id, backendId: 'dsh', reason: 'turn' }] });

    send.drain(true);
    const session = createSession(), held = accept(session.id, 'held-by-drain', '/clear');
    send.kick();
    await pause(20);
    expect(store.getRun(held.id)).toMatchObject({ state: 'queued', native: { delivery: 'queued' } });
    expect(native.writes).toEqual([]);
    send.drain(false);
    await until(() => store.getRun(held.id).state === 'completed', 'delivery once the drain is lifted');
    expect(native.writes).toEqual([{ sessionId: session.id, text: '/clear' }]);

    // Drains are per holder: one holder letting go leaves the other's in place.
    send.drain(true, 'a'); send.drain(true, 'b');
    send.drain(false, 'a');
    expect(send.restartability().draining).toBe(true);
    send.drain(false, 'b');
    expect(send.restartability().draining).toBe(false);

    // An archived session's write in flight still blocks a restart.
    const archived = createSession(), inFlight = accept(archived.id, 'archived-in-flight', 'hello');
    store.transitionNativeRun(inFlight.id, ['queued'], { delivery: 'dispatching', stage: 'sending' }, { state: 'running' });
    store.updateSession(archived.id, { archivedAt: new Date().toISOString() });
    expect(send.restartability().blockers.some(item => item.sessionId === archived.id && item.reason === 'delivery')).toBe(true);

    // Admitted before the drain, still waiting for the conversation's lock when it began: not written.
    const lock = deferred(), locked = runtime.withSession.bind(runtime);
    runtime.withSession = async (id, action) => { await lock.promise; return locked(id, action); };
    const waiting = createSession(), admitted = accept(waiting.id, 'admitted-before-drain', '/compact');
    send.kick();
    send.drain(true);
    lock.resolve();
    await pause(20);
    expect(store.getRun(admitted.id)).toMatchObject({ state: 'queued', native: { delivery: 'queued' } });
    expect(native.writes).toHaveLength(1);
    send.drain(false);
    await until(() => store.getRun(admitted.id).state === 'completed', 'the admitted run once the drain is lifted');
    expect(native.writes.at(-1)).toEqual({ sessionId: waiting.id, text: '/compact' });
  });

  it('completes slash commands when the CLI echoes them before the PTY write promise resolves', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'slash-echo-race', '/clear');
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    native.echoOnWrite = true;
    native.echoDuringDelivery = true;
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => store.getRun(run.id).state === 'completed', 'slash command completion after early transcript echo');
    expect(store.getRun(run.id).native).toMatchObject({ delivery: 'input_sent', stage: 'command_sent' });
    expect(native.writes).toEqual([{ sessionId: session.id, text: '/clear' }]);
  });

  it('fails a pre-write delivery without pasting any text', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'command-before-write', 'inspect the project');
    // Pre-seed a live terminal so the dispatcher stays on the paste path (Phase 1's argv branch
    // is skipped when `session.terminalId` is already set to a non-exited terminal).
    const terminalId = `terminal-${session.id}`;
    store.updateSession(session.id, { terminalId, state: 'running' });
    saveNativeTerminal(store, store.getSession(session.id));
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    native.failBeforeWrite = new AppError('TERMINAL_NOT_RUNNING', 'terminal is unavailable', 409);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => store.getRun(run.id).state === 'failed', 'pre-write failure');
    expect(store.getRun(run.id).native?.delivery).toBe('failed');
    expect(native.deliverCalls).toEqual([session.id]);
    expect(native.writes).toEqual([]);
    send.kick();
    await pause();
    expect(native.writes).toEqual([]);
  });

  it('fails a queued run whose profile is no longer configured instead of throwing out of the timer', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'profile-gone', 'inspect the project');
    store.updateSession(session.id, { terminalId: `terminal-${session.id}`, state: 'running' });
    saveNativeTerminal(store, store.getSession(session.id));
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    const gone = new AppError('NATIVE_PROFILE_NOT_FOUND', 'Profile removed is not configured for Claude', 404);
    native.subscribe = () => { throw gone; };
    native.failBeforeWrite = gone;
    cleanups.push(() => store.close(), () => send.close());

    expect(() => send.kick()).not.toThrow();
    await until(() => store.getRun(run.id).state === 'failed', 'run failed for its missing profile');
    expect(native.writes).toEqual([]);
  });

  it('requeues a stale pre-write terminal lease and succeeds after the lease settles', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'retry-stale-lease', '/clear');
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    native.failBeforeWriteOnce = new AppError('TERMINAL_INTERACTION_STALE', 'Terminal interaction lost control', 409);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => store.getRun(run.id).native?.delivery === 'queued', 'stale lease to return to queue');
    expect(store.getRun(run.id)).toMatchObject({ state: 'queued', native: { delivery: 'queued', stage: 'waiting' } });
    expect(native.writes).toEqual([]);
    const actor = (Reflect.get(send, 'actors') as Map<string, { nextAttempt: Map<string, number> }>).get(session.id);
    actor!.nextAttempt.set(run.id, 0);

    send.kick();
    await until(() => store.getRun(run.id).state === 'completed', 'retry after the terminal lease settles');
    expect(native.deliverCalls).toEqual([session.id, session.id]);
    expect(native.writes).toEqual([{ sessionId: session.id, text: '/clear' }]);
  });

  it('routes a brand-new session\'s first message through the positional argv path', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'first-message', 'inspect the project');
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => store.getRun(run.id).native?.delivery === 'input_sent', 'argv-path input_sent transition');
    // The CLI accepted the prompt via argv; the dispatcher must not have called `deliver`.
    expect(native.deliverCalls).toEqual([]);
    expect(native.writes).toEqual([]);
    // The runtime must have been asked to spawn with the message as the initial prompt.
    expect(runtime.ensureOptions).toEqual([{ initialPrompt: 'inspect the project' }]);
    // The run owns a baseline fence rooted at the attached terminal so a later echo can bind.
    expect(store.getRun(run.id).native?.terminalId).toBe(`terminal-${session.id}`);
  });

  it('fails a first message, restorably, when the launch is refused before any process exists', async () => {
    // The fence goes down before the spawn; an argv over the terminal service's limit is then refused
    // without a process. Nothing reached a CLI, so the message is a failure to send again, not unconfirmed.
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'refused-launch', 'who are you');
    const native = new FakeNative(store), runtime = makeRuntime();
    runtime.attachTerminal = undefined;
    runtime.spawnError = new AppError('NATIVE_LAUNCH_INVALID', 'Native terminal launch command is invalid', 400);
    const send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => store.getRun(run.id).native?.delivery === 'failed', 'refused launch to fail the run');
    expect(store.getRun(run.id)).toMatchObject({ state: 'failed', native: { delivery: 'failed', stage: 'prepare', diagnostic: { code: 'NATIVE_LAUNCH_INVALID' } } });
    expect(store.getRun(run.id).native?.timings?.dispatchAt).toBeUndefined();
    expect(runtime.argvSpawns).toEqual([]);
    expect(native.writes).toEqual([]);
  });

  it('fails fast when the CLI exits immediately after an argv-path spawn', async () => {
    // Mirrors the "bad --model" or "bad --context" failure mode: `runtime.ensure` returns, but
    // the terminal row is already `exited` before the dispatcher reads the snapshot. The run
    // must fail cleanly instead of parking in `input_sent` for the 30s watchdog.
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'bad-model', 'hello');
    const error = 'Cursor 启动失败：Cannot use this model: retired-model.';
    const runtime = makeRuntime();
    runtime.attachTerminal = (s: Session) => {
      const terminalId = `terminal-${s.id}`;
      store.updateSession(s.id, { terminalId, state: 'failed', error });
      saveNativeTerminal(store, store.getSession(s.id), 'exited');
    };
    const native = new FakeNative(store), send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => store.getRun(run.id).native?.delivery === 'failed', 'argv-path exited failure');
    expect(store.getRun(run.id).error).toBe(error);
    expect(native.deliverCalls).toEqual([]);
  });

  it('falls back to the paste path when the initial prompt exceeds the argv length cap', async () => {
    // Linux execve rejects args larger than MAX_ARG_STRLEN (128 KiB). The gate caps at 64 KiB
    // and routes large drafts through the paste path, which has no comparable limit.
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'huge-draft', 'x'.repeat(65 * 1024));
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => native.deliverCalls.length === 1, 'paste-path fallback for oversize draft');
    expect(runtime.ensureOptions).toEqual([{}]);
  });

  it('marks a write-then-error uncertain and fences all retries', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'command-after-write', 'inspect the project');
    // Pre-seed a live terminal so the dispatcher stays on the paste path (Phase 1's argv branch
    // is skipped when `session.terminalId` is already set to a non-exited terminal).
    const terminalId = `terminal-${session.id}`;
    store.updateSession(session.id, { terminalId, state: 'running' });
    saveNativeTerminal(store, store.getSession(session.id));
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    native.failAfterWrite = new Error('connection closed after PTY write');
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => store.getRun(run.id).native?.delivery === 'uncertain', 'uncertain delivery');
    expect(store.getRun(run.id).state).toBe('interrupted');
    expect(native.writes).toHaveLength(1);
    send.kick();
    await pause();
    expect(native.writes).toHaveLength(1);
    expect(native.deliverCalls).toHaveLength(1);
  });

  it.each([
    { delivery: 'input_sent' as const, terminalState: 'running' as const },
    { delivery: 'observed' as const, terminalState: 'detached' as const },
  ])('does not treat initial offline observer status as a runtime exit for a $delivery run with a $terminalState terminal', ({ delivery, terminalState }) => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, `offline-${delivery}`, 'continue the task');
    seedDeliveredRun(store, session, run.id, delivery, { terminalState });
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    native.initialStatus = { phase: 'offline' };
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    expect(store.getRun(run.id).native?.delivery).toBe(delivery);
    expect(store.getRun(run.id).native?.stage).not.toBe('runtime_exit');
  });

  it.each(['cursor', 'claude'] as const)('closes a receipted %s run after restart when its chat terminal exits, without fencing the next message', async backendId => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const original = createSession();
    const session = store.updateSession(original.id, { backendId });
    const run = accept(session.id, 'confirmed-exit', 'continue the task');
    const next = accept(session.id, 'after-confirmed-exit', '/clear');
    seedDeliveredRun(store, session, run.id, 'observed', { terminalState: 'exited' });
    store.transitionNativeRun(run.id, ['observed'], { backendId, expectsTurnOutcome: true });
    store.recoverInterruptedRuns();
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    native.emit(session.id, { type: 'status', status: { phase: 'offline' } });

    expect(store.getRun(run.id)).toMatchObject({ state: 'interrupted', error: 'CLI 在回复过程中退出，这条回复可能不完整。', native: { delivery: 'cancelled', stage: 'runtime_exit', nativeMessageId: 'native-receipt-1' } });
    send.kick();
    await until(() => store.getRun(next.id).state === 'completed', 'the next message after the exited turn');
    expect(native.writes).toEqual([{ sessionId: session.id, text: '/clear' }]);
  });

  it('still fences later messages when a run was written but never echoed before its terminal exited', () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'unechoed-exit', 'continue the task');
    seedDeliveredRun(store, session, run.id, 'input_sent', { terminalState: 'exited', receipt: false });
    const error = 'Cursor 启动失败：Cannot use this model: retired-model.';
    store.updateSession(session.id, { state: 'failed', error });
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    native.emit(session.id, { type: 'status', status: { phase: 'offline' } });

    expect(store.getRun(run.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'uncertain', stage: 'runtime_exit' } });
    expect(store.getRun(run.id).error).toContain(error);
    expect(store.getRun(run.id).error).toContain('不会自动重发');
  });

  it('keeps a Claude receipt observed on connection loss while its PTY lives, then completes its legacy turn once idle', async () => {
    const { store, createSession, accept, workspace } = setup();
    const initial = createSession();
    const session = store.updateSession(initial.id, { backendId: 'claude', backendProfileId: 'local', nativeSessionId: 'claude-thread-1', cursorSessionId: undefined });
    const run = accept(session.id, 'claude-live-offline', 'continue the task');
    seedDeliveredRun(store, session, run.id, 'observed', { terminalState: 'running', terminalKind: 'native' });
    store.updateSession(session.id, { state: 'idle' });
    const queuedSession = createSession(), queued = accept(queuedSession.id, 'after-claude-offline', '/clear');
    const native = new FakeNative(store), runtime = new FakeRuntime(), send = dispatcher(store, native, runtime, workspace);
    native.currentStatus = { phase: 'offline' };
    native.initialStatus = { phase: 'offline' };
    cleanups.push(() => store.close(), () => send.close());

    send.kick();

    expect(store.getRun(run.id)).toMatchObject({ state: 'running', native: { delivery: 'observed', stage: 'executing' } });
    // The unresolved run fences its own conversation only; the neighbour never waited on it.
    await until(() => store.getRun(queued.id).state === 'completed', 'neighbour dispatch beside the unresolved run');

    native.currentStatus = { phase: 'idle' };
    native.emit(session.id, { type: 'status', status: { phase: 'idle' } });
    send.kick();
    await until(() => store.getRun(run.id).state === 'completed', 'the original run after its provider reports idle');
    expect(store.getRun(run.id)).toMatchObject({ state: 'completed', native: { delivery: 'observed' } });
    expect(native.deliverCalls).toEqual([queuedSession.id]);
  });

  it.each([
    { phase: 'busy' as const, expectedState: 'running' as const },
    { phase: 'attention' as const, expectedState: 'running' as const },
    { phase: 'idle' as const, expectedState: 'completed' as const },
  ])('recovers a runtime_exit run with an exact receipt on matching $phase status despite a terminal epoch change', ({ phase, expectedState }) => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, `recover-${phase}`, 'continue the task');
    seedDeliveredRun(store, session, run.id, 'uncertain', {
      terminalState: 'running', epoch: 12,
      timings: { inputSentAt: nowForTest() - 10_000, observedAt: nowForTest() - 9_000, firstOutputAt: nowForTest() - 2_000 },
    });
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    // The new reset may no longer include the original user row; its persisted nativeMessageId is
    // already the exact receipt. Status is valid only while terminal/session/chat identity matches.
    native.emit(session.id, { type: 'status', status: { phase } });

    if (expectedState === 'completed') {
      expect(store.getRun(run.id)).toMatchObject({ state: 'completed', native: { delivery: 'observed', stage: 'completed' } });
    } else {
      expect(store.getRun(run.id)).toMatchObject({ state: 'running', native: { delivery: 'observed', stage: 'executing', nativeMessageId: 'native-receipt-1' } });
    }
    expect(native.writes).toEqual([]);
    expect(native.deliverCalls).toEqual([]);
  });

  it.each([
    { label: 'without a stored receipt', receipt: false },
    { label: 'after the session switches chats', receipt: true, switchChat: true },
  ])('does not recover runtime_exit $label', ({ receipt, switchChat }) => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, `no-recover-${receipt}-${switchChat}`, 'continue the task');
    seedDeliveredRun(store, session, run.id, 'uncertain', { terminalState: 'running', receipt });
    if (switchChat) store.updateSession(session.id, { cursorSessionId: 'different-chat' });
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    native.emit(session.id, { type: 'status', status: { phase: 'busy' } });

    expect(store.getRun(run.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'uncertain', stage: 'runtime_exit' } });
    expect(native.writes).toEqual([]);
    expect(native.deliverCalls).toEqual([]);
  });

  it('does not use an exited terminal linked to another session as runtime_exit evidence', () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), otherSession = createSession();
    const run = accept(session.id, 'foreign-terminal-exit', 'continue the task');
    seedDeliveredRun(store, session, run.id, 'observed', { terminalState: 'exited' });
    store.updateTerminal(store.getRun(run.id).native!.terminalId!, { sessionId: otherSession.id });
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    native.emit(session.id, { type: 'status', status: { phase: 'offline' } });

    expect(store.getRun(run.id)).toMatchObject({ state: 'running', native: { delivery: 'observed', stage: 'executing' } });
  });

  it.each(['busy', 'attention'] as const)('keeps a long-running input_sent task and queue fence on valid %s terminal status without resending', (phase) => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), active = accept(session.id, `long-task-${phase}`, 'continue the long task');
    const queued = accept(session.id, `queued-after-long-task-${phase}`, '/clear');
    seedDeliveredRun(store, session, active.id, 'input_sent', {
      terminalState: 'running', receipt: false, timings: { inputSentAt: nowForTest() - 31_000 },
    });
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace, 30_000);
    native.currentStatus = { phase };
    cleanups.push(() => store.close(), () => send.close());

    send.kick();

    expect(store.getRun(active.id)).toMatchObject({ state: 'queued', native: { delivery: 'input_sent', stage: 'confirmation' } });
    expect(store.getRun(active.id).native?.nativeMessageId).toBeUndefined();
    expect(store.getRun(queued.id)).toMatchObject({ state: 'queued', native: { delivery: 'queued' } });
    expect(native.writes).toEqual([]);
    expect(native.deliverCalls).toEqual([]);
  });

  it('marks a timed-out input_sent run uncertain when there is no valid live terminal evidence', () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), active = accept(session.id, 'long-task-no-terminal', 'continue the long task');
    const queued = accept(session.id, 'queued-after-no-terminal', '/clear');
    seedDeliveredRun(store, session, active.id, 'input_sent', {
      terminalState: 'exited', receipt: false, timings: { inputSentAt: nowForTest() - 31_000 },
    });
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace, 30_000);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();

    expect(store.getRun(active.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'uncertain', stage: 'confirmation' } });
    expect(store.getRun(queued.id)).toMatchObject({ state: 'queued', native: { delivery: 'queued' } });
    expect(native.writes).toEqual([]);
    expect(native.deliverCalls).toEqual([]);
  });

  it.each([
    { label: 'paste', argv: false },
    { label: 'argv initial-prompt', argv: true },
  ])('cancels a queued run while runtime preparation is waiting, before the $label write fence', async ({ argv }) => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, `command-cancel-${argv}`, 'please inspect');
    const native = new FakeNative(store), runtime = makeRuntime(), gate = deferred();
    native.argvInitialPrompt = argv;
    runtime.blockedSessionId = session.id;
    runtime.gate = gate.promise;
    const send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => runtime.ensureCalls.includes(session.id), 'runtime preparation');
    expect(runtime.ensureOptions).toEqual([argv ? { initialPrompt: 'please inspect' } : {}]);
    expect(store.getRun(run.id).native?.delivery).toBe('preparing');
    expect(send.cancel(session.id, run.id).native?.delivery).toBe('cancelled');
    gate.resolve();
    await until(() => runtime.activeCalls === 0, 'cancelled worker exit');
    expect(store.getRun(run.id).state).toBe('cancelled');
    // Neither delivery channel ran: no CLI was spawned carrying the prompt and nothing was pasted
    // (the paste path may still reach `deliver`, whose pre-write fence refuses the cancelled run).
    expect(runtime.argvSpawns).toEqual([]);
    expect(native.writes).toEqual([]);
    if (argv) {
      expect(native.deliverCalls).toEqual([]);
      expect(store.getSession(session.id).terminalId).toBeUndefined();
    }
  });

  it('never pastes an argv prompt again when the launch skipped the fence hook', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'argv-unfenced', 'inspect the project');
    const native = new FakeNative(store), runtime = makeRuntime();
    const ensure = runtime.ensure.bind(runtime);
    // A runtime that spawns with the prompt but drops the hook on the way.
    runtime.ensure = (target, options) => ensure(target, options && { initialPrompt: options.initialPrompt });
    const send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => store.getRun(run.id).native?.delivery === 'uncertain', 'the unfenced launch to be held as uncertain');
    expect(store.getRun(run.id).state).toBe('interrupted');
    expect(native.deliverCalls).toEqual([]);
    expect(native.writes).toEqual([]);
  });

  it('fences an argv prompt before its CLI is spawned, so a crash before confirmation is never replayed or cancelled', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'argv-crash', 'inspect the project');
    const native = new FakeNative(store), runtime = makeRuntime(), crash = deferred();
    runtime.afterSpawn = crash.promise; // The process dies between the spawn and the confirmation.
    const send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close());

    send.kick();
    await until(() => runtime.argvSpawns.length === 1, 'the argv spawn');
    expect(store.getRun(run.id)).toMatchObject({ native: { delivery: 'dispatching', stage: 'input', renderedText: 'inspect the project', baselineSequence: 0 } });
    expect(() => send.cancel(session.id, run.id)).toThrow(expect.objectContaining({ code: 'RUN_ALREADY_DISPATCHED' }));

    // Restart: a fresh store reading the same rows recovers, then a new dispatcher runs.
    store.recoverInterruptedRuns();
    expect(store.getRun(run.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'uncertain' } });
    const restartedNative = new FakeNative(store), restartedRuntime = makeRuntime(), restarted = dispatcher(store, restartedNative, restartedRuntime, workspace);
    cleanups.push(() => restarted.close());
    restarted.kick();
    await pause(20);
    expect(restartedRuntime.ensureCalls).toEqual([]);
    expect(restartedRuntime.argvSpawns).toEqual([]);
    expect(restartedNative.deliverCalls).toEqual([]);
    expect(store.getRun(run.id).native?.delivery).toBe('uncertain');
    crash.resolve();
    await send.close();
  });

  it('keeps a receipted Claude queue input until native consumption or removal confirms its outcome', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const initial = createSession();
    const session = store.updateSession(initial.id, { backendId: 'claude', nativeSessionId: 'claude-queue', cursorSessionId: undefined });
    const run = accept(session.id, 'queued-receipt-stop', 'follow up');
    seedDeliveredRun(store, session, run.id, 'input_sent', { receipt: false, terminalKind: 'native' });
    store.transitionNativeRun(run.id, ['input_sent'], { backendId: 'claude', nativeSessionId: session.nativeSessionId });
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());
    send.kick();
    const receipt = { ...makeEvent(session.id, 1, 'native_input_receipt', run.prompt), data: { commandId: run.commandId } };
    native.emit(session.id, { type: 'events', events: [receipt] });
    expect(store.getRun(run.id)).toMatchObject({ state: 'running', native: { delivery: 'observed', nativeMessageId: receipt.nativeId } });
    expect(store.getRun(run.id).native?.nativeTurnId).toBeUndefined();

    await send.interrupt(session.id);
    expect(store.getRun(run.id)).toMatchObject({ state: 'running', native: { delivery: 'observed', nativeMessageId: receipt.nativeId } });
    native.emit(session.id, { type: 'events', events: [{ ...makeEvent(session.id, 2, 'run_completed', ''), data: { commandId: run.commandId, nativeMessageId: receipt.nativeId } }] });
    expect(store.getRun(run.id)).toMatchObject({ state: 'completed', native: { delivery: 'observed', stage: 'completed' } });
    expect(native.writes).toEqual([]);
  });

  it('releases a pending receipt before Stop queues for the same session lock without replaying input', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const created = createSession();
    const session = store.updateSession(created.id, { backendId: 'claude', nativeSessionId: 'claude-chat', terminalId: `terminal-${created.id}` });
    saveNativeTerminal(store, session, 'running', 1, 'native');
    const run = accept(session.id, 'receipt-before-stop', 'submit only once');
    const receipt = deferred(), confirmed = deferred();
    const notified: string[] = [];
    const native = Object.assign(new FakeNative(store), {
      requestInterrupt(id: string) { notified.push(id); receipt.resolve(); },
      async sendRun(current: Session, _run: unknown, fence: Parameters<NonNullable<NativeDispatcherBackend['sendRun']>>[2]) {
        fence({ backendId: 'claude', nativeSessionId: 'claude-chat', terminalId: current.terminalId, terminalEpoch: 1 });
        native.writes.push({ sessionId: current.id, text: run.prompt });
        native.currentStatus = { phase: 'busy' };
        await receipt.promise;
        // Ending the read wait establishes no delivery receipt and no stop confirmation.
        throw new Error('Receipt wait yielded to Stop');
      },
    });
    native.currentStatus = { phase: 'idle' };
    native.interruptOperation = async () => {
      await confirmed.promise;
      native.currentStatus = { phase: 'idle' };
      native.emit(session.id, { type: 'status', status: native.currentStatus });
    };
    const runtime = makeRuntime();
    // Unlike the ordinary fake, this serializes the send and Stop as production does. Without the
    // lock-free notice Stop cannot enter, since the send owns the lock while awaiting its receipt.
    let tail = Promise.resolve();
    runtime.withSession = async <T>(_id: string, action: () => Promise<T>): Promise<T> => {
      const previous = tail, released = deferred();
      tail = released.promise;
      await previous;
      try { return await action(); }
      finally { released.resolve(); }
    };
    const send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close(), () => { receipt.resolve(); confirmed.resolve(); });
    send.kick();
    await until(() => native.writes.length === 1, 'the fenced send waiting for its receipt');
    const stopping = send.interrupt(session.id);
    await until(() => native.interruptCalls === 1, 'Stop acquiring the session lock before the receipt timeout');
    expect(notified).toEqual([session.id]);
    expect(store.getRun(run.id)).toMatchObject({ native: { delivery: 'uncertain' } });
    expect(native.writes).toHaveLength(1);
    confirmed.resolve();
    await stopping;
    // Claude may still hold unreceipted input in its own queue. A stopped active turn is not a
    // receipt that this input was removed, so keep its original no-replay fence until native evidence.
    expect(store.getRun(run.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'uncertain', stage: 'confirmation' } });
    await send.interrupt(session.id);
    expect(store.getRun(run.id).native?.delivery).toBe('uncertain');
    send.kick();
    expect(native.writes).toHaveLength(1);
    native.emit(session.id, { type: 'events', events: [{
      ...makeEvent(session.id, 1, 'run_cancelled', ''),
      data: { commandId: run.commandId, reason: 'Claude confirmed input removal' },
    }] });
    expect(store.getRun(run.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'cancelled', stage: 'provider_cancelled' } });
  });

  it('waits for a confirmed stop before accepting a priority follow-up, then runs it before older queued input', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const created = createSession(), session = store.updateSession(created.id, { terminalId: 'terminal-interrupt' });
    const active = accept(session.id, 'active-before-interrupt', 'old current task');
    store.transitionNativeRun(active.id, ['queued'], { delivery: 'observed', stage: 'executing', timings: { busyAt: nowForTest() } }, { state: 'running' });
    const queued = accept(session.id, 'older-queued-input', '/clear');
    const native = new FakeNative(store), runtime = makeRuntime(), gate = deferred();
    native.busyOnWrite = false; // `/clear` is answered at the prompt: the CLI stays idle.
    native.interruptOperation = async () => {
      await gate.promise;
      native.currentStatus = { phase: 'idle' };
      native.emit(session.id, { type: 'status', status: native.currentStatus });
    };
    const send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    let submissions = 0;
    const first = send.interruptAndSend(session.id, 'follow-up', () => {
      submissions++;
      return accept(session.id, 'follow-up', '/clear');
    });
    await until(() => native.interruptCalls === 1, 'CLI interrupt start');
    send.kick();
    expect(submissions).toBe(0);
    expect(native.writes).toEqual([]);
    expect(store.getRun(active.id).state).toBe('running'); // An idle paint is not accepted before the stop receipt.
    await expect(send.interruptAndSend(session.id, 'other-follow-up', () => accept(session.id, 'other-follow-up', '/clear')))
      .rejects.toMatchObject({ code: 'NATIVE_INTERRUPT_IN_PROGRESS', statusCode: 409 });
    const duplicate = send.interruptAndSend(session.id, 'follow-up', () => accept(session.id, 'follow-up', '/clear'));

    gate.resolve();
    const accepted = await first;
    expect((await duplicate).id).toBe(accepted.id);
    expect(accepted.commandId).toBe('follow-up');
    expect(submissions).toBe(1);
    expect(store.getRun(active.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'cancelled', stage: 'interrupted' } });
    await until(() => store.getRun(accepted.id).state === 'completed', 'priority follow-up');
    await until(() => runtime.activeCalls === 0, 'priority worker exit');
    const queueDeadline = Date.now() + 1500;
    while (store.getRun(queued.id).state !== 'completed' && Date.now() < queueDeadline) { send.kick(); await pause(5); }
    expect(store.getRun(queued.id).state).toBe('completed');
    expect(native.writes).toEqual([
      { sessionId: session.id, text: '/clear' }, // The follow-up jumps ahead of the older queue.
      { sessionId: session.id, text: '/clear' },
    ]);
    expect(native.interruptCalls).toBe(1);
    expect(native.interruptOptions).toEqual([{ clearPrompt: true }]);
  });

  it('promotes the same queued run for immediate insert, coalesces duplicate requests, and preserves the rest of the queue', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const created = createSession(), session = store.updateSession(created.id, { terminalId: `terminal-${created.id}` });
    const active = accept(session.id, 'four-digit-task', 'four digits currently running');
    seedDeliveredRun(store, session, active.id, 'observed', { timings: { busyAt: nowForTest() } });
    const queued = accept(session.id, 'five-digit-task', 'five digits queued');
    const older = accept(session.id, 'later-queue-item', '/older');
    const native = new FakeNative(store), runtime = makeRuntime(), gate = deferred();
    native.currentStatus = { phase: 'busy' };
    native.echoOnWrite = true;
    native.echoDuringDelivery = true;
    native.interruptOperation = async () => {
      await gate.promise;
      native.currentStatus = { phase: 'idle' };
      native.emit(session.id, { type: 'status', status: native.currentStatus });
    };
    const send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    const first = send.sendQueuedNow(session.id, queued.id);
    await until(() => native.interruptCalls === 1, 'priority stop before the queued run is promoted');
    const duplicate = send.sendQueuedNow(session.id, queued.id);
    send.kick();
    expect(native.writes).toEqual([]);
    expect(store.listRuns(session.id)).toHaveLength(3);

    gate.resolve();
    const [promoted, same] = await Promise.all([first, duplicate]);
    expect(promoted.id).toBe(queued.id);
    expect(same.id).toBe(queued.id);
    expect(store.getRun(active.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'cancelled' } });

    await until(() => store.getRun(queued.id).native?.delivery === 'observed', 'promoted prompt receipt');
    expect(native.writes).toEqual([{ sessionId: session.id, text: 'five digits queued' }]);
    const sequence = Math.max(0, ...native.events.map(event => event.sequence)) + 1;
    native.emit(session.id, { type: 'events', events: [makeEvent(session.id, sequence, 'agent_message_chunk', 'five digits answer')] });
    native.emit(session.id, { type: 'status', status: { phase: 'idle' } });
    await until(() => store.getRun(queued.id).state === 'completed', 'promoted prompt completion');
    const remainingDeadline = Date.now() + 1500;
    while (store.getRun(older.id).state !== 'completed' && Date.now() < remainingDeadline) { send.kick(); await pause(5); }
    expect(store.getRun(older.id).state).toBe('completed');
    expect(native.writes).toEqual([
      { sessionId: session.id, text: 'five digits queued' },
      { sessionId: session.id, text: '/older' },
    ]);
    expect(store.listRuns(session.id)).toHaveLength(3);
    expect(native.interruptCalls).toBe(1);

    const repeated = await send.sendQueuedNow(session.id, queued.id);
    expect(repeated.id).toBe(queued.id);
    expect(repeated.native?.timings?.promotedAt).toEqual(expect.any(Number));
    expect(native.interruptCalls).toBe(1);

    // The promotion receipt remains durable when the dispatcher is reconstructed from Store.
    const afterRestart = new FakeNative(store), restarted = dispatcher(store, afterRestart, runtime, workspace);
    cleanups.push(() => restarted.close());
    expect((await restarted.sendQueuedNow(session.id, queued.id)).id).toBe(queued.id);
    expect(afterRestart.interruptCalls).toBe(0);
  });

  it('hands a follow-up to a backend that replaces its turn itself, without a separate stop', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const created = createSession(), session = store.updateSession(created.id, { terminalId: `terminal-${created.id}` });
    const active = accept(session.id, 'running-task', 'long running task');
    seedDeliveredRun(store, session, active.id, 'observed', { timings: { busyAt: nowForTest() } });
    const native = new FakeNative(store), runtime = makeRuntime();
    native.sendNow = true;
    native.echoOnWrite = true;
    native.echoDuringDelivery = true;
    const send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    const followUp = await send.interruptAndSend(session.id, 'replacement', () => accept(session.id, 'replacement', 'do this instead'));
    expect(native.interruptCalls).toBe(0);
    expect(native.nowWrites).toEqual(['do this instead']);
    expect(followUp).toMatchObject({ commandId: 'replacement', native: { delivery: 'observed', stage: 'executing' } });
    expect(store.getRun(active.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'cancelled', stage: 'interrupted' } });
  });

  it('stops the turn first when the backend could not hand the follow-up over, keeping it first in line', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const created = createSession(), session = store.updateSession(created.id, { terminalId: `terminal-${created.id}` });
    const active = accept(session.id, 'running-task', 'long running task');
    seedDeliveredRun(store, session, active.id, 'observed', { timings: { busyAt: nowForTest() } });
    const native = new FakeNative(store), runtime = makeRuntime();
    native.sendNow = true;
    native.failNowBeforeWrite = new AppError('CLI_BUSY', 'CLI 尚未能接收补充消息，消息继续排队', 409);
    native.interruptOperation = async () => {
      native.currentStatus = { phase: 'idle' };
      native.emit(session.id, { type: 'status', status: native.currentStatus });
    };
    const send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    const followUp = await send.interruptAndSend(session.id, 'replacement', () => accept(session.id, 'replacement', 'please clear'));
    expect(native.interruptCalls).toBe(1);
    expect(native.interruptOptions).toEqual([{ clearPrompt: true }]);
    expect(followUp).toMatchObject({ state: 'queued', native: { delivery: 'queued', stage: 'interrupt_followup' } });
    expect(store.getRun(active.id)).toMatchObject({ state: 'interrupted' });
    const deadline = Date.now() + 1500;
    while (store.getRun(followUp.id).native?.delivery === 'queued' && Date.now() < deadline) { send.kick(); await pause(5); }
    expect(native.writes).toEqual([{ sessionId: session.id, text: 'please clear' }]);
  });

  it('keeps the stop-then-send order for a slash command follow-up', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const created = createSession(), session = store.updateSession(created.id, { terminalId: `terminal-${created.id}` });
    const native = new FakeNative(store), runtime = makeRuntime();
    native.sendNow = true;
    const send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    await send.interruptAndSend(session.id, 'slash', () => accept(session.id, 'slash', '/clear'));
    expect(native.interruptCalls).toBe(1);
    expect(native.nowWrites).toEqual([]);
  });

  it('does not report a preparing prompt as a send failure when an atomic interrupt supersedes it', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const created = createSession(), session = store.updateSession(created.id, { terminalId: 'terminal-preparing-interrupt' });
    const preparing = accept(session.id, 'preparing-before-interrupt', 'old unsent prompt');
    const native = new FakeNative(store), runtime = makeRuntime(), gate = deferred();
    runtime.blockedSessionId = session.id;
    runtime.gate = gate.promise;
    const send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());
    send.kick();
    await until(() => store.getRun(preparing.id).native?.delivery === 'preparing', 'preparing old prompt');

    const stopped = send.interruptAndSend(session.id, 'replacement', () => accept(session.id, 'replacement', '/clear'));
    gate.resolve();
    const replacement = await stopped;
    expect(store.getRun(preparing.id)).toMatchObject({ state: 'cancelled', native: { delivery: 'cancelled', stage: 'cancelled' } });
    await until(() => runtime.activeCalls === 0, 'superseded worker exit');
    const replacementDeadline = Date.now() + 1500;
    while (store.getRun(replacement.id).state !== 'completed' && Date.now() < replacementDeadline) { send.kick(); await pause(5); }
    expect(store.getRun(replacement.id).state).toBe('completed');
    expect(native.writes).toEqual([{ sessionId: session.id, text: '/clear' }]);
  });

  it('runs two native sessions in the same workspace concurrently', async () => {
    const { store, project, createSession, accept, workspace, makeRuntime } = setup();
    const firstSession = createSession(), secondSession = createSession();
    const first = accept(firstSession.id, 'first-command', '/clear');
    const second = accept(secondSession.id, 'second-command', '/clear');
    const native = new FakeNative(store), runtime = makeRuntime(), gate = deferred();
    // The first session is held mid-dispatch: sharing a directory must not make the second wait.
    runtime.blockedSessionId = firstSession.id;
    runtime.gate = gate.promise;
    const send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => store.getRun(second.id).state === 'completed', 'second command completion while the first is held');
    expect(store.getRun(first.id).state).not.toBe('completed');
    expect(() => send.reserveWorkspace([project.id])).toThrow(expect.objectContaining({ code: 'PROJECT_BUSY' }));
    gate.resolve();
    await until(() => store.getRun(first.id).state === 'completed', 'first command completion');
    expect(native.deliverCalls.sort()).toEqual([firstSession.id, secondSession.id].sort());
  });

  it('reserves a start against the same session only, not against its neighbours', async () => {
    const { store, project, createSession, accept, workspace } = setup();
    const opening = createSession(), peer = createSession();
    const native = new FakeNative(store), runtime = new FakeRuntime(), send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());

    const release = send.reserveSessionStart(opening.id);
    expect(() => send.reserveSessionStart(opening.id)).toThrow(expect.objectContaining({ code: 'NATIVE_SESSION_BUSY' }));
    expect(() => send.reserveWorkspace([project.id])).toThrow(expect.objectContaining({ code: 'PROJECT_BUSY' }));
    // A different conversation in the same directory opens and dispatches regardless.
    const peerRelease = send.reserveSessionStart(peer.id);
    peerRelease();
    const run = accept(peer.id, 'queued-under-start-reservation', '/clear');
    send.kick();
    await until(() => store.getRun(run.id).state === 'completed', 'peer dispatch during another start reservation');

    release();
  });

  it('holds new turns and starts in a reserved workspace and its nested projects until release', async () => {
    const { store, project, createSession, accept, workspace, makeRuntime } = setup();
    const nested = store.createProject(join(project.cwd, 'nested'), 'Nested');
    const sibling = store.createProject(`${project.cwd}-sibling`, 'Sibling');
    const session = createSession();
    const child = store.createSession({ projectId: nested.id, kind: 'native' });
    const peer = store.createSession({ projectId: sibling.id, kind: 'native' });
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());
    const release = send.reserveWorkspace([project.id]);
    expect(() => send.reserveWorkspace([nested.id])).toThrow(expect.objectContaining({ code: 'PROJECT_BUSY' }));
    expect(() => send.reserveSessionStart(child.id)).toThrow(expect.objectContaining({ code: 'PROJECT_BUSY' }));
    const run = accept(session.id, 'during-restore', '/clear');
    const childRun = accept(child.id, 'nested-during-restore', '/clear');
    const peerRun = accept(peer.id, 'sibling-during-restore', '/clear');
    await expect(send.steer(session.id, run.id)).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
    await expect(send.interruptAndSend(session.id, 'replace-during-restore', () => { throw new Error('must not submit'); })).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
    send.kick();
    await until(() => store.getRun(peerRun.id).state === 'completed', 'unrelated workspace dispatch');
    expect(store.getRun(run.id).native?.delivery).toBe('queued');
    expect(store.getRun(childRun.id).native?.delivery).toBe('queued');
    release();
    release();
    await until(() => store.getRun(run.id).state === 'completed' && store.getRun(childRun.id).state === 'completed', 'reserved queued turns after release');
    expect(native.writes).toHaveLength(3);
  });

  it.each(['close', 'archive'] as const)('does not dispatch queued turns when a workspace reservation releases after %s', async action => {
    const { store, project, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), native = new FakeNative(store), runtime = makeRuntime();
    const send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => store.close(), () => send.close());
    const release = send.reserveWorkspace([project.id]);
    const run = accept(session.id, 'restore-while-closing', 'inspect once');
    if (action === 'close') await send.close();
    else {
      store.updateProject(project.id, { archivedAt: new Date().toISOString() });
      expect(() => send.reserveSessionStart(session.id)).toThrow(expect.objectContaining({ code: 'ARCHIVED_PROJECT' }));
    }
    release();
    if (action === 'archive') await until(() => store.getRun(run.id).native?.delivery === 'failed', 'archived project run rejected');
    else expect(store.getRun(run.id).native?.delivery).toBe('queued');
    expect(runtime.ensureCalls).toEqual([]);
  });

  it('refuses to bind a second conversation to one CLI chat', () => {
    // The case that genuinely corrupts a transcript is two conversations driving one CLI chat,
    // and it is refused at the store rather than fenced at dispatch.
    const { store, createSession } = setup();
    const owner = createSession(), second = createSession();
    cleanups.push(() => store.close());

    expect(() => store.updateSession(second.id, { cursorSessionId: store.getSession(owner.id).cursorSessionId! }))
      .toThrow(expect.objectContaining({ code: 'NATIVE_SESSION_ID_IN_USE' }));
  });

  it.each([
    { label: 'a confirmed idle CLI', terminalState: 'running' as const, phase: 'idle' as const },
    { label: 'the same exited terminal', terminalState: 'exited' as const, phase: 'offline' as const },
  ])('lets an unrelated idle session send while another session has an uncertain receipt and $label', async ({ terminalState, phase }) => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const oldSession = createSession();
    const uncertain = accept(oldSession.id, `ambiguous-${terminalState}`, 'may still be running');
    seedDeliveredRun(store, oldSession, uncertain.id, 'uncertain', { terminalState, receipt: false });
    store.transitionNativeRun(uncertain.id, ['uncertain'], { stage: 'confirmation' });
    store.updateSession(oldSession.id, { state: 'idle' });

    const waitingSession = createSession();
    const linkedWaitingSession = store.updateSession(waitingSession.id, { terminalId: `terminal-${waitingSession.id}`, state: 'idle' });
    saveNativeTerminal(store, linkedWaitingSession);
    const waiting = accept(waitingSession.id, `unblocked-${terminalState}`, '/clear');
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    native.currentStatus = { phase };
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => store.getRun(waiting.id).state === 'completed', 'idle peer queue to proceed');

    expect(store.getRun(uncertain.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'uncertain', stage: 'confirmation' } });
    expect(native.deliverCalls).toEqual([waitingSession.id]);
    expect(native.writes).toEqual([{ sessionId: waitingSession.id, text: '/clear' }]);
  });

  it.each([
    { label: 'busy CLI', phase: 'busy' as const },
    { label: 'attention screen', phase: 'attention' as const },
    { label: 'offline observer', phase: 'offline' as const },
    { label: 'session still starting', phase: 'idle' as const, sessionState: 'starting' as const },
    { label: 'unverified chat identity', phase: 'idle' as const, switchChat: true },
  ])('lets another session in the same workspace send while uncertain delivery is $label', async ({ phase, switchChat, sessionState }) => {
    // An unresolved peer used to fence the directory in every one of these states. It no longer
    // does: only the peer's own conversation waits on it.
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const oldSession = createSession();
    const uncertain = accept(oldSession.id, `blocked-${phase}-${switchChat}`, 'may still be running');
    seedDeliveredRun(store, oldSession, uncertain.id, 'uncertain', { terminalState: 'running', receipt: false });
    store.transitionNativeRun(uncertain.id, ['uncertain'], { stage: 'confirmation' });
    store.updateSession(oldSession.id, {
      state: sessionState ?? 'idle',
      ...(switchChat ? { cursorSessionId: 'different-chat' } : {}),
    });
    const waitingSession = createSession();
    const linkedWaitingSession = store.updateSession(waitingSession.id, { terminalId: `terminal-${waitingSession.id}`, state: 'idle' });
    saveNativeTerminal(store, linkedWaitingSession);
    const waiting = accept(waitingSession.id, `unblocked-${phase}-${switchChat}`, '/clear');
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    native.setStatus(oldSession.id, { phase });
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await until(() => store.getRun(waiting.id).state === 'completed', 'neighbour dispatch beside an unresolved peer');

    expect(store.getRun(uncertain.id).native?.delivery).toBe('uncertain');
    expect(native.deliverCalls).toEqual([waitingSession.id]);
    expect(native.writes).toEqual([{ sessionId: waitingSession.id, text: '/clear' }]);
  });

  it('keeps an idle uncertain run as a same-session resend and queue fence', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession();
    const uncertain = accept(session.id, 'same-chat-uncertain', 'may still be running');
    seedDeliveredRun(store, session, uncertain.id, 'uncertain', { terminalState: 'running', receipt: false });
    store.transitionNativeRun(uncertain.id, ['uncertain'], { stage: 'confirmation' });
    store.updateSession(session.id, { state: 'idle' });
    const queued = accept(session.id, 'same-chat-queued', '/clear');
    const native = new FakeNative(store), runtime = makeRuntime(), send = dispatcher(store, native, runtime, workspace);
    native.currentStatus = { phase: 'idle' };
    cleanups.push(() => store.close(), () => send.close());

    send.kick();
    await pause(20);

    expect(store.getRun(uncertain.id).native?.delivery).toBe('uncertain');
    expect(store.getRun(queued.id)).toMatchObject({ state: 'queued', native: { delivery: 'queued' } });
    expect(runtime.ensureCalls).toEqual([]);
    expect(native.writes).toEqual([]);
  });

  it('binds a unique post-baseline user echo and completes only after output then idle', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'command-observe', 'inspect the project');
    // Pre-seed a live terminal so the dispatcher stays on the paste path.
    const terminalId = `terminal-${session.id}`;
    store.updateSession(session.id, { terminalId, state: 'running' });
    saveNativeTerminal(store, store.getSession(session.id));
    const native = new FakeNative(store), runtime = makeRuntime();
    native.events = [makeEvent(session.id, 10, 'agent_message_chunk', 'previous turn')];
    native.echoOnWrite = true;
    const send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => send.close(), () => store.close());

    send.kick();
    await until(() => store.getRun(run.id).native?.delivery === 'observed', 'transcript echo binding');
    expect(store.getRun(run.id)).toMatchObject({ state: 'running', native: { nativeMessageId: 'native-11', baselineSequence: 10, cursorSessionId: session.cursorSessionId } });
    expect(store.getRun(run.id).native?.timings?.firstOutputAt).toBeUndefined();

    native.emit(session.id, { type: 'events', events: [makeEvent(session.id, 12, 'agent_message_chunk', 'new answer')] });
    expect(store.getRun(run.id).native?.timings?.firstOutputAt).toEqual(expect.any(Number));
    expect(store.getRun(run.id).state).toBe('running');
    native.emit(session.id, { type: 'status', status: { phase: 'idle' } });
    expect(store.getRun(run.id)).toMatchObject({ state: 'completed', native: { delivery: 'observed', stage: 'completed' } });
  });

  it('closes an observed run as unconfirmed once the provider stays idle with no turn, and sends the next message without resending it', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'command-lost-completion', 'inspect the project');
    const terminalId = `terminal-${session.id}`;
    store.updateSession(session.id, { terminalId, state: 'running' });
    saveNativeTerminal(store, store.getSession(session.id));
    const native = new FakeNative(store), runtime = makeRuntime();
    native.echoOnWrite = true;
    const send = new NativeDispatcher(store, native as never, runtime as never, workspace as never, { intervalMs: 60_000, idleReconcileMs: 20, idleOutcomeGraceMs: 20 });
    cleanups.push(() => send.close(), () => store.close());

    send.kick();
    await until(() => store.getRun(run.id).native?.delivery === 'observed', 'transcript echo binding');
    // The hook-reported turn never delivers its Stop, so idle alone cannot complete this run.
    // The status keeps claiming that same turn (only the lost Stop would clear the claim); the
    // idle screen must still settle the run once it has stayed idle past the reconcile window.
    store.transitionNativeRun(run.id, ['observed'], { expectsTurnOutcome: true, nativeTurnId: 'turn-lost-stop' });
    const next = accept(session.id, 'command-after-lost-completion', 'and the tests');
    const idle: NativeStatus = { phase: 'idle', activeTurn: { nativeSessionId: session.cursorSessionId!, turnId: 'turn-lost-stop' } };
    native.emit(session.id, { type: 'status', status: idle });
    expect(store.getRun(run.id).state).toBe('running');
    expect(store.getRun(next.id).native?.delivery).toBe('queued');
    await pause(40);
    native.emit(session.id, { type: 'status', status: idle });
    expect(store.getRun(run.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'cancelled', stage: 'turn_outcome_unknown' } });
    await until(() => native.writes.length === 2, 'the queued message to be sent');
    expect(native.writes.filter(write => write.text === 'inspect the project')).toHaveLength(1);
    expect(native.writes[1]!.text).toBe('and the tests');
  });

  it('keeps waiting past the idle window while another Stop hook is still running, then takes the late outcome', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'command-slow-stop-hooks', 'inspect the project');
    const terminalId = `terminal-${session.id}`;
    store.updateSession(session.id, { terminalId, state: 'running' });
    saveNativeTerminal(store, store.getSession(session.id));
    const native = new FakeNative(store), runtime = makeRuntime();
    native.echoOnWrite = true;
    const send = new NativeDispatcher(store, native as never, runtime as never, workspace as never, { intervalMs: 60_000, idleReconcileMs: 20, idleOutcomeGraceMs: 200 });
    cleanups.push(() => send.close(), () => store.close());

    send.kick();
    await until(() => store.getRun(run.id).native?.delivery === 'observed', 'transcript echo binding');
    store.transitionNativeRun(run.id, ['observed'], { expectsTurnOutcome: true, nativeTurnId: 'turn-slow-stop' });
    const idle: NativeStatus = { phase: 'idle', activeTurn: { nativeSessionId: session.cursorSessionId!, turnId: 'turn-slow-stop' } };
    native.emit(session.id, { type: 'status', status: idle });
    await pause(60);
    native.emit(session.id, { type: 'status', status: idle });
    // Longer than the plain idle window but inside the outcome grace: the Stop hook chain is still
    // running, so the run must not be shown as unconfirmed and corrected a moment later.
    expect(store.getRun(run.id)).toMatchObject({ state: 'running' });
    // The turn duration only reaches the transcript once the other hooks finish.
    native.emit(session.id, { type: 'events', events: [{
      ...makeEvent(session.id, 20, 'run_completed', ''),
      nativeTurnId: 'turn-slow-stop',
      data: { commandId: run.commandId },
    }] });
    expect(store.getRun(run.id)).toMatchObject({ state: 'completed', native: { stage: 'completed' } });
  });

  it('reconciles an idle status that arrived before the transcript echo without requiring another status event', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'command-idle-before-echo', 'inspect the project');
    const native = new FakeNative(store), runtime = makeRuntime();
    native.events = [makeEvent(session.id, 10, 'agent_message_chunk', 'previous turn')];
    const send = dispatcher(store, native, runtime, workspace);
    cleanups.push(() => send.close(), () => store.close());

    send.kick();
    await until(() => store.getRun(run.id).native?.delivery === 'input_sent', 'input written before delayed transcript echo');
    await until(() => runtime.activeCalls === 0, 'initial post-send snapshot to finish');

    // The CLI finishes before its transcript echo is persisted. Its idle event therefore cannot
    // complete the run yet because the run is still input_sent and has not bound a native message.
    native.currentStatus = { phase: 'idle' };
    native.emit(session.id, { type: 'status', status: native.currentStatus });
    expect(store.getRun(run.id).state).toBe('queued');

    native.emit(session.id, { type: 'events', events: [
      makeEvent(session.id, 11, 'user_message_chunk', 'inspect the project'),
      makeEvent(session.id, 12, 'agent_message_chunk', 'answer already finished'),
    ] });
    expect(store.getRun(run.id)).toMatchObject({ state: 'running', native: { delivery: 'observed' } });
    expect(store.getRun(run.id).native?.timings?.firstOutputAt).toEqual(expect.any(Number));

    const emittedStatuses = native.emittedStatusCount;
    await pause(520); // Dispatcher reconciliation is intentionally delayed to avoid per-tick status reads.
    expect(store.getRun(run.id).state).toBe('running');
    expect(native.emittedStatusCount).toBe(emittedStatuses); // No new stream status event arrived.
    const reads = native.statusCalls;
    send.kick();

    expect(native.statusCalls).toBe(reads + 1);
    expect(store.getRun(run.id)).toMatchObject({ state: 'completed', native: { delivery: 'observed', stage: 'completed' } });
  });

  it('queries only unfinished native runs from the indexed JSON state', () => {
    const { store, createSession, accept } = setup();
    const session = createSession(), otherSession = createSession();
    const done = accept(session.id, 'finished-command', '/clear');
    store.transitionNativeRun(done.id, ['queued'], { delivery: 'input_sent' }, { state: 'completed' });
    const pending = accept(session.id, 'pending-command', 'wait for me');
    const latest = accept(session.id, 'latest-command', 'latest request');
    const other = accept(otherSession.id, 'other-session-command', 'other session');
    const result = store.listUnfinishedNativeRuns();
    expect(result.map((run) => run.id)).toEqual([pending.id, latest.id, other.id]);
    expect(store.listUnfinishedNativeRuns(session.id).map((run) => run.id)).toEqual([pending.id, latest.id]);
    expect(store.findRunByCommand(session.id, 'pending-command')?.id).toBe(pending.id);
    expect(store.listRecentNativeRuns(session.id, 2).map((run) => run.id)).toEqual([latest.id, pending.id]);
    expect(store.listRecentNativeRuns(otherSession.id).map((run) => run.id)).toEqual([other.id]);
    const indexes = store.db.prepare("PRAGMA index_list('runs')").all() as Array<{ name: string }>;
    expect(indexes.some((index) => index.name === 'run_native_unfinished')).toBe(true);

    const unfinishedPlan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT r.json FROM runs r JOIN sessions s ON s.id=r.session_id
      WHERE json_extract(s.json,'$.kind')='native' AND r.session_id=?
        AND json_extract(r.json,'$.native.delivery') IN ('queued','preparing','dispatching','input_sent','observed','uncertain')
        AND json_extract(r.json,'$.state') NOT IN ('completed','failed','cancelled') ORDER BY r.rowid`).all(session.id) as Array<{ detail: string }>;
    expect(unfinishedPlan.some((step) => step.detail.includes('run_native_unfinished'))).toBe(true);
    const recentPlan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT r.json FROM runs r JOIN sessions s ON s.id=r.session_id
      WHERE r.session_id=? AND json_extract(s.json,'$.kind')='native' ORDER BY r.rowid DESC LIMIT ?`).all(session.id, 100) as Array<{ detail: string }>;
    expect(recentPlan.some((step) => step.detail.includes('session_id=?'))).toBe(true);
    store.close();
  });

  it('does not turn a completed native command into uncertain during restart recovery', () => {
    const { store, createSession, accept } = setup();
    const session = createSession(), run = accept(session.id, 'completed-before-restart', '/clear');
    store.transitionNativeRun(run.id, ['queued'], { delivery: 'input_sent' }, { state: 'completed' });
    store.recoverInterruptedRuns();
    expect(store.getRun(run.id)).toMatchObject({ state: 'completed', native: { delivery: 'input_sent' } });
    store.close();
  });
});

function nowForTest(): number { return Date.now(); }

describe('message recovery and targeted stop', () => {
  it('checks late evidence without another write and does not offer release without provider proof', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'late-check', 'one message');
    store.updateSession(session.id, { nativeSessionId: session.cursorSessionId });
    store.transitionNativeRun(run.id, ['queued'], { delivery: 'uncertain', nativeSessionId: session.cursorSessionId, baselineSequence: 0 }, { state: 'interrupted' });
    const backend = new FakeNative(store); backend.currentStatus = { phase: 'idle' };
    const dispatcher = new NativeDispatcher(store, backend, makeRuntime(), workspace as never);
    try {
      expect((await dispatcher.check(session.id, run.id)).canContinue).toBe(false);
      backend.events = [{ ...makeEvent(session.id, 1, 'user_message_chunk', run.prompt), data: { commandId: run.commandId } }];
      expect((await dispatcher.check(session.id, run.id)).run.native?.delivery).toBe('observed');
      expect(backend.writes).toEqual([]);
    } finally { await dispatcher.close(); store.close(); }
  });

  it('requires the reviewed queue and preserves late receipt correction after releasing an unknown input', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), run = accept(session.id, 'release-original', 'old input');
    store.updateSession(session.id, { nativeSessionId: session.cursorSessionId });
    store.transitionNativeRun(run.id, ['queued'], { delivery: 'uncertain', nativeSessionId: session.cursorSessionId, baselineSequence: 0 }, { state: 'interrupted' });
    const backend = Object.assign(new FakeNative(store), { canReleaseInput: async () => true });
    backend.currentStatus = { phase: 'idle' };
    const dispatcher = new NativeDispatcher(store, backend, makeRuntime(), workspace as never);
    try {
      await expect(dispatcher.continue(session.id, run.id, ['not-the-current-queue'])).rejects.toMatchObject({ code: 'NATIVE_QUEUE_CHANGED' });
      const released = await dispatcher.continue(session.id, run.id, []);
      expect(released.native?.queueReleasedAt).toBeTruthy();
      expect(released).toMatchObject({ state: 'interrupted', native: { delivery: 'uncertain' } });
      dispatcher.kick();
      backend.emit(session.id, { type: 'events', events: [{ ...makeEvent(session.id, 1, 'native_input_receipt', run.prompt), data: { commandId: run.commandId } }] });
      expect(store.getRun(run.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'observed', queueReleasedAt: released.native?.queueReleasedAt } });
      backend.emit(session.id, { type: 'events', events: [{ ...makeEvent(session.id, 2, 'run_completed', ''), data: { commandId: run.commandId } }] });
      expect(store.getRun(run.id).state).toBe('completed');
      expect(backend.writes).toEqual([]);
    } finally { await dispatcher.close(); store.close(); }
  });

  it('admits a queued message when the CLI is offline despite earlier released uncertain history', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), old = accept(session.id, 'released-old', 'old input');
    store.transitionNativeRun(old.id, ['queued'], {
      delivery: 'uncertain', stage: 'confirmation', queueReleasedAt: new Date(0).toISOString(),
    }, { state: 'interrupted' });
    const next = accept(session.id, 'next-after-offline', 'new input');
    const backend = new FakeNative(store), runtime = makeRuntime();
    backend.argvInitialPrompt = false;
    backend.currentStatus = { phase: 'offline' };
    const dispatcher = new NativeDispatcher(store, backend, runtime, workspace as never);
    try {
      expect(dispatcher.queue(session.id, backend.currentStatus)).toEqual({ next: next.id });
      expect(dispatcher.busy(session.id)).toBe(true);
      dispatcher.kick();
      await until(() => backend.writes.length === 1, 'offline released history admits next run');
      expect(runtime.ensureCalls).toEqual([session.id]);
      expect(backend.writes).toEqual([{ sessionId: session.id, text: 'new input' }]);
    } finally { await dispatcher.close(); store.close(); }
  });

  it('requeues without writing when reconnecting an offline session reveals an active turn', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), old = accept(session.id, 'released-before-reconnect', 'old input');
    store.transitionNativeRun(old.id, ['queued'], {
      delivery: 'uncertain', stage: 'confirmation', queueReleasedAt: new Date(0).toISOString(),
    }, { state: 'interrupted' });
    const next = accept(session.id, 'wait-for-reconnected-turn', 'new input');
    const backend = new FakeNative(store), runtime = makeRuntime();
    backend.argvInitialPrompt = false;
    backend.currentStatus = { phase: 'offline' };
    const baseEnsure = runtime.ensure.bind(runtime);
    runtime.ensure = async (targetSession, options) => {
      await baseEnsure(targetSession, options);
      backend.currentStatus = { phase: 'busy', activeTurn: { nativeSessionId: session.cursorSessionId!, turnId: 'live-turn' } };
    };
    const dispatcher = new NativeDispatcher(store, backend, runtime, workspace as never);
    try {
      dispatcher.kick();
      await until(() => runtime.ensureCalls.length === 1 && store.getRun(next.id).native?.stage === 'waiting', 'reconnected busy session requeues run');
      expect(backend.writes).toEqual([]);
      expect(store.getRun(next.id)).toMatchObject({ state: 'queued', native: { delivery: 'queued', stage: 'waiting' } });
    } finally { await dispatcher.close(); store.close(); }
  });

  it('persists stop identity and refuses a delayed request for a different task', async () => {
    const { store, createSession, workspace, makeRuntime } = setup();
    const session = createSession();
    const backend = new FakeNative(store);
    const stop = { requestId: 'stop-once', nativeSessionId: session.cursorSessionId!, turnId: 'first' };
    backend.currentStatus = { phase: 'busy', activeTurn: { nativeSessionId: stop.nativeSessionId, turnId: 'first' } };
    let dispatcher = new NativeDispatcher(store, backend, makeRuntime(), workspace as never);
    try {
      await dispatcher.interrupt(session.id, stop);
      expect(backend.interruptCalls).toBe(1);
      await dispatcher.close();
      dispatcher = new NativeDispatcher(store, backend, makeRuntime(), workspace as never);
      backend.currentStatus = { phase: 'busy', activeTurn: { nativeSessionId: stop.nativeSessionId, turnId: 'second' } };
      await dispatcher.interrupt(session.id, stop);
      expect(backend.interruptCalls).toBe(1);
      await expect(dispatcher.interrupt(session.id, { ...stop, requestId: 'delayed-first' })).rejects.toMatchObject({ code: 'NATIVE_STOP_TARGET_CHANGED' });
      await expect(dispatcher.interrupt(session.id, { ...stop, turnId: 'second' })).rejects.toMatchObject({ code: 'NATIVE_STOP_CONFLICT' });
      expect(backend.interruptCalls).toBe(1);
    } finally { await dispatcher.close(); store.close(); }
  });

  it('rejects conflicting in-flight stop identities before the durable receipt is written', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), backend = new FakeNative(store), gate = deferred();
    const runtime = makeRuntime();
    runtime.withSession = async (_id, action) => { await gate.promise; return await action(); };
    const stop = { requestId: 'inflight-stop', nativeSessionId: session.cursorSessionId!, turnId: 'original' };
    backend.currentStatus = { phase: 'busy', activeTurn: { nativeSessionId: stop.nativeSessionId, turnId: stop.turnId } };
    const dispatcher = new NativeDispatcher(store, backend, runtime, workspace as never);
    const submit = () => accept(session.id, 'followup-one', '/clear');
    try {
      const first = dispatcher.interruptAndSend(session.id, 'followup-one', submit, stop, 'payload-one');
      await expect(dispatcher.interruptAndSend(session.id, 'followup-two', () => accept(session.id, 'followup-two', 'other'), stop, 'payload-two')).rejects.toMatchObject({ code: 'NATIVE_STOP_CONFLICT' });
      await expect(dispatcher.interruptAndSend(session.id, 'followup-one', submit, { ...stop, turnId: 'different' }, 'payload-one')).rejects.toMatchObject({ code: 'NATIVE_STOP_CONFLICT' });
      await expect(dispatcher.interruptAndSend(session.id, 'followup-one', submit, stop, 'changed-payload')).rejects.toMatchObject({ code: 'NATIVE_STOP_CONFLICT' });
      const duplicate = dispatcher.interruptAndSend(session.id, 'followup-one', submit, stop, 'payload-one');
      gate.resolve();
      expect((await duplicate).id).toBe((await first).id);
      expect(backend.interruptCalls).toBe(1);
      expect(store.findRunByCommand(session.id, 'followup-two')).toBeUndefined();
    } finally { gate.resolve(); await dispatcher.close(); store.close(); }
  });

  it('settles only the stopped turn and keeps released or other-turn unknown messages unchanged', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), backend = new FakeNative(store);
    store.updateSession(session.id, { terminalId: `terminal-${session.id}` });
    saveNativeTerminal(store, store.getSession(session.id));
    const stop = { requestId: 'precise-stop', nativeSessionId: session.cursorSessionId!, turnId: 'current' };
    const current = accept(session.id, 'current', 'current input');
    const other = accept(session.id, 'other', 'other input');
    const released = accept(session.id, 'released', 'released input');
    for (const run of [current, other, released]) store.transitionNativeRun(run.id, ['queued'], {
      delivery: 'uncertain', nativeSessionId: stop.nativeSessionId, nativeTurnId: run === current ? stop.turnId : 'older',
      ...(run === released ? { queueReleasedAt: new Date().toISOString() } : {}),
    }, { state: 'interrupted' });
    backend.currentStatus = { phase: 'busy', activeTurn: { nativeSessionId: stop.nativeSessionId, turnId: stop.turnId } };
    const dispatcher = new NativeDispatcher(store, backend, makeRuntime(), workspace as never);
    try {
      await dispatcher.interrupt(session.id, stop);
      expect(store.getRun(current.id).native?.delivery).toBe('cancelled');
      expect(store.getRun(other.id).native?.delivery).toBe('uncertain');
      expect(store.getRun(released.id).native).toMatchObject({ delivery: 'uncertain', queueReleasedAt: expect.any(String) });
      expect(backend.interruptCalls).toBe(1);
    } finally { await dispatcher.close(); store.close(); }
  });

  it('recovers an exact stopped target after restart before accepting its immutable replacement once', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const session = createSession(), old = accept(session.id, 'original', 'original input');
    store.updateSession(session.id, { terminalId: `terminal-${session.id}` });
    saveNativeTerminal(store, store.getSession(session.id));
    const stop = { requestId: 'persistent-followup-stop', nativeSessionId: session.cursorSessionId!, turnId: 'original-turn' };
    store.transitionNativeRun(old.id, ['queued'], { delivery: 'uncertain', nativeSessionId: stop.nativeSessionId, nativeTurnId: stop.turnId }, { state: 'interrupted' });
    let safe = false;
    const backend = Object.assign(new FakeNative(store), { canReleaseInput: async () => safe });
    backend.currentStatus = { phase: 'busy', activeTurn: { nativeSessionId: stop.nativeSessionId, turnId: stop.turnId } };
    backend.interruptOperation = async () => { throw new Error('response lost after Stop'); };
    let dispatcher = new NativeDispatcher(store, backend, makeRuntime(), workspace as never);
    const submit = () => accept(session.id, 'replacement', '/clear');
    try {
      await expect(dispatcher.interruptAndSend(session.id, 'replacement', submit, stop, 'original-payload')).rejects.toMatchObject({ code: 'NATIVE_STOP_UNCONFIRMED' });
      await dispatcher.close();
      dispatcher = new NativeDispatcher(store, backend, makeRuntime(), workspace as never);
      await expect(dispatcher.interruptAndSend(session.id, 'replacement', submit, stop, 'changed-payload')).rejects.toMatchObject({ code: 'NATIVE_STOP_CONFLICT' });
      backend.currentStatus = { phase: 'idle' };
      await expect(dispatcher.interruptAndSend(session.id, 'replacement', submit, stop, 'original-payload')).rejects.toMatchObject({ code: 'NATIVE_STOP_UNCONFIRMED' });
      // Even a precise end does not prove the composer/CLI queue is empty.
      backend.events = [{ ...makeEvent(session.id, 1, 'run_cancelled', ''), nativeTurnId: stop.turnId, data: { nativeSessionId: stop.nativeSessionId } }];
      await expect(dispatcher.interruptAndSend(session.id, 'replacement', submit, stop, 'original-payload')).rejects.toMatchObject({ code: 'NATIVE_STOP_UNCONFIRMED' });
      expect(store.findRunByCommand(session.id, 'replacement')).toBeUndefined();
      safe = true;
      const result = await dispatcher.interruptAndSend(session.id, 'replacement', submit, stop, 'original-payload');
      const duplicate = await dispatcher.interruptAndSend(session.id, 'replacement', submit, stop, 'original-payload');
      expect(duplicate.id).toBe(result.id);
      expect(store.getRun(old.id).native?.delivery).toBe('cancelled');
      expect(backend.interruptCalls).toBe(1);
      await until(() => backend.writes.length === 1, 'the replacement to run after the old target settled');
      expect(backend.writes).toEqual([{ sessionId: session.id, text: '/clear' }]);
    } finally { await dispatcher.close(); store.close(); }
  });

  it('does not recover a pending stop against a replacement terminal epoch', async () => {
    const { store, createSession, workspace, makeRuntime } = setup();
    let session = createSession();
    session = store.updateSession(session.id, { terminalId: 'original-terminal' });
    const terminal = saveNativeTerminal(store, session);
    const stop = { requestId: 'old-process-stop', nativeSessionId: session.cursorSessionId!, turnId: 'original-turn', terminalId: terminal.id, terminalEpoch: terminal.epoch };
    const backend = new FakeNative(store);
    backend.currentStatus = { phase: 'busy', activeTurn: { nativeSessionId: stop.nativeSessionId, turnId: stop.turnId } };
    backend.interruptOperation = async () => { throw new Error('stop result lost'); };
    let dispatcher = new NativeDispatcher(store, backend, makeRuntime(), workspace as never);
    try {
      await expect(dispatcher.interrupt(session.id, stop)).rejects.toMatchObject({ code: 'NATIVE_STOP_UNCONFIRMED' });
      await dispatcher.close();
      dispatcher = new NativeDispatcher(store, backend, makeRuntime(), workspace as never);
      store.updateTerminal(terminal.id, { epoch: terminal.epoch + 1 });
      backend.currentStatus = { phase: 'idle' };
      backend.events = [{ ...makeEvent(session.id, 1, 'run_cancelled', ''), nativeTurnId: stop.turnId, data: { nativeSessionId: stop.nativeSessionId } }];
      await expect(dispatcher.interrupt(session.id, stop)).rejects.toMatchObject({ code: 'NATIVE_STOP_TARGET_CHANGED' });
      expect(backend.interruptCalls).toBe(1);
    } finally { await dispatcher.close(); store.close(); }
  });

  it('never repeats a stop whose provider response was lost', async () => {
    const { store, createSession, workspace, makeRuntime } = setup();
    const session = createSession(), backend = new FakeNative(store);
    const stop = { requestId: 'stop-unknown', nativeSessionId: session.cursorSessionId!, turnId: 'original' };
    backend.currentStatus = { phase: 'busy', activeTurn: { nativeSessionId: stop.nativeSessionId, turnId: stop.turnId } };
    backend.interruptOperation = async () => { throw new Error('connection lost after stop'); };
    const dispatcher = new NativeDispatcher(store, backend, makeRuntime(), workspace as never);
    try {
      await expect(dispatcher.interrupt(session.id, stop)).rejects.toMatchObject({ code: 'NATIVE_STOP_UNCONFIRMED' });
      await expect(dispatcher.interrupt(session.id, stop)).rejects.toMatchObject({ code: 'NATIVE_STOP_UNCONFIRMED' });
      backend.currentStatus = { phase: 'idle' };
      await expect(dispatcher.interrupt(session.id, stop)).rejects.toMatchObject({ code: 'NATIVE_STOP_UNCONFIRMED' });
      backend.events = [{ ...makeEvent(session.id, 1, 'run_cancelled', ''), nativeTurnId: stop.turnId, data: { nativeSessionId: stop.nativeSessionId } }];
      await dispatcher.interrupt(session.id, stop);
      expect(backend.interruptCalls).toBe(1);
    } finally { await dispatcher.close(); store.close(); }
  });

  it('settles a running turn and dispatches the queue when the stop has no turn id and a newer terminal epoch', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const created = createSession();
    const session = store.updateSession(created.id, { terminalId: `terminal-${created.id}` });
    const active = accept(session.id, 'running-task', 'still running');
    seedDeliveredRun(store, session, active.id, 'observed', { timings: { busyAt: nowForTest(), firstOutputAt: nowForTest() } });
    store.transitionNativeRun(active.id, ['observed'], { nativeTurnId: 'live-turn', expectsTurnOutcome: true, terminalEpoch: 8 });
    const bound = store.getSession(session.id);
    const terminal = store.getTerminal(bound.terminalId!);
    const live = store.updateTerminal(terminal.id, { epoch: terminal.epoch + 9 });
    const queued = accept(session.id, 'queued-next', 'send the next one');
    const stop = { requestId: 'stop-without-turn', nativeSessionId: bound.nativeSessionId!, terminalId: live.id, terminalEpoch: live.epoch };
    const ended: Array<{ turnId: string; status: string }> = [];
    const native = Object.assign(new FakeNative(store), {
      endTurn: async (_sessionId: string, turnId: string, status: string) => { ended.push({ turnId, status }); },
    });
    native.setStatus(session.id, { phase: 'busy' });
    native.interruptOperation = async () => { native.setStatus(session.id, { phase: 'idle' }); };
    const send = dispatcher(store, native, makeRuntime(), workspace);
    try {
      expect(store.getRun(active.id).native?.terminalEpoch).toBe(8);
      expect(live.epoch).toBeGreaterThan(8);
      await send.sendQueuedNow(session.id, queued.id, stop);
      expect(store.getRun(active.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'cancelled', stage: 'interrupted' } });
      expect(ended).toEqual([{ turnId: 'live-turn', status: 'interrupted' }]);
      await until(() => native.writes.some(write => write.text === 'send the next one'), 'queued run dispatched');
    } finally { await send.close(); store.close(); }
  });

  it('sends a targeted stop through send-now and only settles the old turn once replacement is observed on a new turn', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const created = createSession();
    const session = store.updateSession(created.id, { terminalId: `terminal-${created.id}` });
    const active = accept(session.id, 'running-task', 'still running');
    seedDeliveredRun(store, session, active.id, 'observed', { timings: { busyAt: nowForTest() } });
    const bound = store.getSession(session.id);
    store.transitionNativeRun(active.id, ['observed'], { nativeTurnId: 'running-turn', terminalEpoch: 8 });
    const live = store.updateTerminal(bound.terminalId!, { epoch: store.getTerminal(bound.terminalId!).epoch + 4 });
    const queued = accept(session.id, 'replacement', 'do this instead');
    const stop = { requestId: 'send-now-stop', nativeSessionId: bound.nativeSessionId!, turnId: 'running-turn', terminalId: live.id, terminalEpoch: live.epoch };
    const sends: Array<{ now?: boolean; expectedStop?: { requestId: string } } | undefined> = [];
    const ended: Array<{ turnId: string; status: string }> = [];
    const native = Object.assign(new FakeNative(store), {
      async sendRun(current: Session, run: { id: string; commandId: string; native?: { input: { text: string } } }, fence: (binding?: object) => unknown, options?: { now?: boolean; expectedStop?: { requestId: string } }) {
        sends.push(options);
        fence({ backendId: 'cursor', nativeSessionId: current.nativeSessionId, terminalId: current.terminalId, terminalEpoch: live.epoch, baselineSequence: 0, renderedText: run.native?.input.text });
        store.transitionNativeRun(run.id, ['dispatching'], { delivery: 'observed', stage: 'executing', nativeMessageId: 'msg-replacement', nativeTurnId: 'replacement-turn' }, { state: 'running' });
        native.setStatus(current.id, { phase: 'busy', activeTurn: { nativeSessionId: stop.nativeSessionId, turnId: 'replacement-turn' } });
      },
      endTurn: async (_sessionId: string, turnId: string, status: string) => { ended.push({ turnId, status }); },
    });
    native.sendNow = true;
    native.setStatus(session.id, { phase: 'busy', activeTurn: { nativeSessionId: stop.nativeSessionId, turnId: stop.turnId } });
    const send = dispatcher(store, native, makeRuntime(), workspace);
    try {
      const promoted = await send.sendQueuedNow(session.id, queued.id, stop);
      expect(sends).toEqual([{ now: true, expectedStop: stop }]);
      expect(native.interruptCalls).toBe(0);
      expect(promoted.native?.delivery).toBe('observed');
      expect(store.getRun(active.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'cancelled', stage: 'interrupted' } });
      expect(ended).toEqual([{ turnId: 'running-turn', status: 'interrupted' }]);
    } finally { await send.close(); store.close(); }
  });

  it('refuses to settle the old turn when send-now only leaves the replacement unconfirmed in input_sent', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const created = createSession();
    const session = store.updateSession(created.id, { terminalId: `terminal-${created.id}` });
    const active = accept(session.id, 'running-task', 'still running');
    seedDeliveredRun(store, session, active.id, 'observed', { timings: { busyAt: nowForTest() } });
    const bound = store.getSession(session.id);
    store.transitionNativeRun(active.id, ['observed'], { nativeTurnId: 'running-turn', terminalEpoch: 8 });
    const live = store.updateTerminal(bound.terminalId!, { epoch: store.getTerminal(bound.terminalId!).epoch + 1 });
    const queued = accept(session.id, 'replacement-unconfirmed', 'do this instead');
    const stop = { requestId: 'send-now-unconfirmed', nativeSessionId: bound.nativeSessionId!, turnId: 'running-turn', terminalId: live.id, terminalEpoch: live.epoch };
    const native = Object.assign(new FakeNative(store), {
      async sendRun(current: Session, run: { native?: { input: { text: string } } }, fence: (binding?: object) => unknown) {
        fence({ backendId: 'cursor', nativeSessionId: current.nativeSessionId, terminalId: current.terminalId, terminalEpoch: live.epoch, baselineSequence: 0, renderedText: run.native?.input.text });
      },
    });
    native.sendNow = true;
    native.setStatus(session.id, { phase: 'busy', activeTurn: { nativeSessionId: stop.nativeSessionId, turnId: stop.turnId } });
    const send = dispatcher(store, native, makeRuntime(), workspace);
    try {
      await expect(send.sendQueuedNow(session.id, queued.id, stop)).rejects.toMatchObject({ code: 'NATIVE_STOP_UNCONFIRMED' });
      expect(store.getRun(active.id)).toMatchObject({ state: 'running', native: { delivery: 'observed' } });
    } finally { await send.close(); store.close(); }
  });

  it('auto-releases an uncertain run after a later turn completes (even after terminal recreation) and dispatches queued messages', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const created = createSession();
    const session = store.updateSession(created.id, { terminalId: 'terminal-new', nativeSessionId: created.cursorSessionId });
    const old = accept(session.id, 'old-uncertain', 'stuck prompt');
    store.transitionNativeRun(old.id, ['queued'], {
      delivery: 'uncertain', stage: 'runtime_exit', backendId: session.backendId,
      nativeSessionId: created.cursorSessionId, terminalId: 'terminal-old',
      timings: { dispatchAt: nowForTest() - 60_000 },
    }, { state: 'interrupted', error: '暂时无法确认是否已发送' });
    const queued = accept(session.id, 'next-queued', 'follow-up prompt');
    let probeCount = 0;
    let allowRelease = false;
    const native = Object.assign(new FakeNative(store), {
      canReleaseAfterLaterTurn: async () => { probeCount += 1; return allowRelease; },
    });
    native.argvInitialPrompt = false;
    native.currentStatus = { phase: 'idle' };
    const send = dispatcher(store, native, makeRuntime(), workspace);
    try {
      send.kick(session.id);
      await until(() => probeCount === 1, 'initial later-turn probe runs once');
      // Repeated settle/wake without a state change must not spam probes.
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(probeCount).toBe(1);
      expect(native.writes).toEqual([]);

      // When a later turn completes or terminal input becomes available (kick), the probe runs again and unblocks the queue.
      allowRelease = true;
      send.kick(session.id);
      await until(() => Boolean(store.getRun(old.id).native?.queueReleasedAt) && native.writes.length === 1, 'auto-release unblocks queued send');
      expect(native.writes).toEqual([{ sessionId: session.id, text: 'follow-up prompt' }]);
      expect(store.getRun(queued.id).native?.delivery).not.toBe('queued');
    } finally { await send.close(); store.close(); }
  });

  it('keeps the queued run when send-now rejects a changed stop target before the write', async () => {
    const { store, createSession, accept, workspace, makeRuntime } = setup();
    const created = createSession();
    const session = store.updateSession(created.id, { terminalId: `terminal-${created.id}` });
    const active = accept(session.id, 'running-task', 'still running');
    seedDeliveredRun(store, session, active.id, 'observed', { timings: { busyAt: nowForTest() } });
    const bound = store.getSession(session.id);
    store.transitionNativeRun(active.id, ['observed'], { nativeTurnId: 'running-turn' });
    const queued = accept(session.id, 'replacement', 'do this instead');
    const stop = { requestId: 'send-now-moved', nativeSessionId: bound.nativeSessionId!, turnId: 'running-turn', terminalId: bound.terminalId, terminalEpoch: store.getTerminal(bound.terminalId!).epoch };
    let sends = 0;
    const native = Object.assign(new FakeNative(store), {
      sendRun: async () => {
        sends += 1;
        throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'The original task changed before stopping', 409);
      },
    });
    native.sendNow = true;
    native.setStatus(session.id, { phase: 'busy', activeTurn: { nativeSessionId: stop.nativeSessionId, turnId: stop.turnId } });
    const send = dispatcher(store, native, makeRuntime(), workspace);
    try {
      await expect(send.sendQueuedNow(session.id, queued.id, stop)).rejects.toMatchObject({ code: 'NATIVE_STOP_TARGET_CHANGED' });
      expect(sends).toBe(1);
      expect(native.interruptCalls).toBe(0);
      expect(store.getRun(queued.id)).toMatchObject({ state: 'queued', native: { delivery: 'queued' } });
      expect(store.getRun(queued.id).state).not.toBe('failed');
      expect(store.getRun(active.id)).toMatchObject({ state: 'running', native: { delivery: 'observed' } });
    } finally { await send.close(); store.close(); }
  });
});
