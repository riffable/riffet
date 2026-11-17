import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeStatus, NativeWorkbenchEvent, Run, Session } from '../../../../packages/contracts/src/index.js';
import type { NativeBackendTraits, NativeDispatchBinding } from '../backends/types.js';
import { CODEX_TRAITS } from '../backends/codex/index.js';
import { CLAUDE_TRAITS } from '../backends/claude/index.js';
import { AppError } from '../errors.js';
import { SessionCommands } from '../orchestration/session-commands.js';
import { registerNativeRoutes } from '../routes/native.js';
import type { NativeMessageBody, RouteDeps } from '../routes/deps.js';
import { StatsLedger } from '../stats/ledger.js';
import { Store } from '../store.js';
import { NativeDispatcher, type DispatchObservation } from './dispatch.js';

/** The traits the Cursor plugin declares (`plugins/riffet/cursor/backend.ts`): the dispatcher reads traits, never a backend id. */
const CURSOR_TRAITS: NativeBackendTraits = { settlesSlashOnSubmit: true, untaggedEcho: true, reportsTurnOutcome: true, ownsSessionObservation: true, resumesByNativeId: true, terminalName: 'Cursor' };

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const input = (text: string) => ({ text, attachmentIds: [], context: [] });
const config = { mode: 'agent', model: 'original-model' };

function harness(options: { idleReconcileMs?: number; idleOutcomeGraceMs?: number } = {}) {
  const store = new Store(':memory:');
  cleanups.push(() => store.close());
  const project = store.createProject('/tmp/riffet-steering-test', 'steering');
  const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex', nativeSessionId: 'thread-1', mode: 'agent' });
  const target = { nativeSessionId: 'thread-1', turnId: 'turn-1' };
  const owner = store.acceptNativeRun(session.id, 'original', input('original task'), config);
  store.transitionNativeRun(owner.id, ['queued'], { delivery: 'observed', nativeTurnId: target.turnId, nativeMessageId: 'original-user', timings: { busyAt: Date.now() - 1000, firstOutputAt: Date.now() - 500 } }, { state: 'running' });
  let listener: ((message: DispatchObservation) => void) | undefined;
  const events: NativeWorkbenchEvent[] = [];
  let status: NativeStatus = { phase: 'busy', activeTurn: { ...target, ownerRunId: owner.id } };
  let mode: 'echo' | 'silent' | 'reject' | 'unknown' | 'expire' | 'deferred' = 'echo';
  const deferredFences = new Map<string, () => void>();
  let supported = true, missingAttachment = false;
  const emit = (event: NativeWorkbenchEvent) => { events.push(event); listener?.({ type: 'events', events: [event] }); };
  const user = (run: Run) => emit({ sequence: events.length + 1, sessionId: session.id, nativeId: `user:${run.commandId}`, nativeTurnId: target.turnId, runId: run.id,
    type: 'user_message_chunk', data: { commandId: run.commandId, content: { text: run.prompt } }, createdAt: new Date().toISOString() });
  const native = {
    assertAvailable: () => undefined,
    traits: (backendId: string) => ({ codex: CODEX_TRAITS, cursor: CURSOR_TRAITS, claude: CLAUDE_TRAITS } as Record<string, object>)[backendId] ?? {},
    status: () => status,
    supportsSteer: vi.fn(async () => supported),
    subscribe: vi.fn((_id: string, fn: typeof listener) => { listener = fn; return () => { listener = undefined; }; }),
    snapshot: vi.fn(async () => ({ status, nativeSessionId: target.nativeSessionId, events: [...events] })),
    interrupt: vi.fn(async () => undefined),
    sendRun: vi.fn(async () => undefined),
    observeTranscripts: vi.fn(() => () => undefined),
    steerRun: vi.fn(async (_session: Session, run: Run, fence: (binding?: NativeDispatchBinding) => Run) => {
      const commit = () => fence({ backendId: 'codex', nativeSessionId: target.nativeSessionId, nativeTurnId: target.turnId, ownerRunId: owner.id, baselineSequence: events.length, renderedText: run.prompt, resolvedConfig: config });
      if (mode === 'deferred') { deferredFences.set(run.commandId, commit); return { deferred: true as const }; }
      if (mode === 'expire') status = { phase: 'idle' };
      commit();
      if (mode === 'reject') throw new AppError('STEER_TARGET_CHANGED', 'turn ended', 409);
      if (mode === 'unknown') throw new Error('connection lost after write');
      if (mode === 'echo') user(run);
    }),
  };
  let tail = Promise.resolve();
  const runtime = {
    ensure: vi.fn(async () => undefined),
    withSession<T>(_id: string, operation: () => Promise<T> | T): Promise<T> {
      const next = tail.then(operation);
      tail = next.then(() => undefined, () => undefined);
      return next;
    },
  };
  const dispatch = new NativeDispatcher(store, native, runtime, {} as never, { intervalMs: 60_000, ...options });
  cleanups.push(() => dispatch.close());
  const app = Fastify();
  app.setErrorHandler<Error>((error, _request, reply) => reply.code(error instanceof AppError ? error.statusCode : 500).send({ error: { code: error instanceof AppError ? error.code : 'INTERNAL_ERROR', message: error.message } }));
  cleanups.push(() => app.close());
  const readNativeInput = vi.fn(async (body: NativeMessageBody, options?: { validateAttachments?: boolean }) => {
    if (missingAttachment && body.attachments?.length && options?.validateAttachments !== false) throw new AppError('ATTACHMENT_NOT_FOUND', 'removed', 404);
    return { text: body.text.trim(), attachmentIds: body.attachments?.map(item => item.id!) ?? [], context: body.context?.map(item => ({ path: item.path!, ...(item.line ? { line: item.line } : {}) })) ?? [] };
  });
  // These messages name no other conversation: references pass straight through.
  const contextReferences = { requireFeature: () => undefined, validateSources: () => undefined, prepare: async () => [], commit: <T>(_recipient: string, _prepared: unknown, action: (snapshots: never[]) => T) => action([]) };
  registerNativeRoutes(app, { store, dispatch, nativeBackends: native, sessionCommands: new SessionCommands(), readNativeInput, contextReferences } as unknown as RouteDeps);
  const submit = (commandId = 'steer-1', extra: object = {}) => app.inject({ method: 'POST', url: `/api/sessions/${session.id}/native/steer`, payload: { commandId, text: 'focus on login', target, ...extra } });
  const acceptSteer = (commandId: string) => store.acceptNativeRun(session.id, commandId, input('focus on login'), config, undefined, { target, ownerRunId: owner.id });
  const internal = (run: Run, type: string, data: Record<string, unknown> = {}) => emit({ sequence: events.length + 1, sessionId: session.id,
    nativeId: `${type}:${run.commandId}`, nativeTurnId: target.turnId, runId: run.id, type, data: { commandId: run.commandId, ...data }, createdAt: new Date().toISOString() });
  const claim = (run: Run, receipt = true) => {
    deferredFences.get(run.commandId)!(); deferredFences.delete(run.commandId);
    internal(run, 'native_input_submitted');
    if (receipt) internal(run, 'native_input_receipt', { receiptKind: 'hook_context', content: { text: run.prompt }, sourceNativeId: 'real-tool-result' });
  };
  const steerQueued = (source: Run, commandId = 'queued-steer', extra: object = {}) => app.inject({ method: 'POST', url: `/api/sessions/${session.id}/native/runs/${source.id}/steer`, payload: { commandId, target, ...extra } });
  const finish = (type = 'run_completed') => {
    for (const run of store.listRuns(session.id).filter(run => run.id === owner.id || run.native?.intent === 'steer')) {
      emit({ sequence: events.length + 1, nativeId: `end:${run.commandId}`, nativeTurnId: target.turnId, runId: owner.id, sessionId: session.id, type,
        data: { commandId: run.commandId, ...(type === 'run_failed' ? { error: 'tool failed' } : {}) }, createdAt: new Date().toISOString() });
    }
    status = { phase: 'idle' };
    listener?.({ type: 'status', status });
  };
  return { app, store, session, owner, target, native, runtime, dispatch, readNativeInput, submit, acceptSteer, finish, user, internal, claim, steerQueued, emit,
    setMode: (next: typeof mode) => { mode = next; }, setStatus: (next: NativeStatus) => { status = next; listener?.({ type: 'status', status }); },
    setSupported: (next: boolean) => { supported = next; }, removeAttachment: () => { missingAttachment = true; } };
}

describe('native steering through HTTP and durable dispatch', () => {
  it('injects multiple distinct inputs into the active turn without starting or interrupting it', async () => {
    const h = harness();
    const queued = h.store.acceptNativeRun(h.session.id, 'next-task', input('next task'), config);
    const first = await h.submit(), second = await h.submit('steer-2');
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ state: 'running', native: { intent: 'steer', delivery: 'observed', nativeTurnId: 'turn-1', ownerRunId: h.owner.id } });
    expect(h.native.steerRun).toHaveBeenCalledTimes(2);
    expect(h.native.sendRun).not.toHaveBeenCalled();
    expect(h.native.interrupt).not.toHaveBeenCalled();
    expect(h.runtime.ensure).not.toHaveBeenCalled();
    expect(h.store.getRun(queued.id).native?.delivery).toBe('queued');
    h.setStatus({ phase: 'idle' });
    expect(h.store.getRun(h.owner.id).state).toBe('running');
    h.finish();
    expect(h.store.getRun(first.json<Run>().id).state).toBe('completed');
    expect(h.store.getRun(second.json<Run>().id).state).toBe('completed');
  });

  it('holds a steer while draining for a restart and sends it to its turn once the drain ends', async () => {
    const h = harness();
    h.dispatch.drain(true);
    const held = (await h.submit()).json<Run>();
    expect(held).toMatchObject({ state: 'queued', native: { intent: 'steer', delivery: 'queued' } });
    expect(h.native.steerRun).not.toHaveBeenCalled();
    expect(h.dispatch.restartability().restartable).toBe(true);
    h.dispatch.drain(false);
    await vi.waitFor(() => expect(h.store.getRun(held.id)).toMatchObject({ native: { intent: 'steer', delivery: 'observed', nativeTurnId: 'turn-1' } }));
    expect(h.native.steerRun).toHaveBeenCalledTimes(1);
  });

  it('returns one receipt for concurrent retries and still retrieves it after the target and attachment disappear', async () => {
    const h = harness();
    const extra = { attachments: [{ id: 'attachment-1' }] };
    const [a, b] = await Promise.all([h.submit('same-id', extra), h.submit('same-id', extra)]);
    expect(a.statusCode).toBe(202); expect(b.json<Run>().id).toBe(a.json<Run>().id);
    expect(h.native.steerRun).toHaveBeenCalledTimes(1);
    h.removeAttachment(); h.setStatus({ phase: 'idle' }); h.setSupported(false);
    expect((await h.submit('same-id', extra)).json<Run>().id).toBe(a.json<Run>().id);
    expect(h.readNativeInput).toHaveBeenLastCalledWith(expect.anything(), { validateAttachments: false });
    expect(h.native.steerRun).toHaveBeenCalledTimes(1);
  });

  it('rejects changed targets, configuration overrides, and reuse across ordinary send endpoints', async () => {
    const h = harness();
    const accepted = await h.submit();
    expect(accepted.statusCode).toBe(202);
    expect((await h.submit('steer-1', { target: { ...h.target, turnId: 'turn-2' } })).statusCode).toBe(409);
    expect((await h.submit('new', { expectedConfigRevision: 0 })).statusCode).toBe(400);
    const normal = await h.app.inject({ method: 'POST', url: `/api/sessions/${h.session.id}/native/send`, payload: { commandId: 'steer-1', text: 'focus on login' } });
    expect(normal.statusCode).toBe(409);
    expect(h.native.steerRun).toHaveBeenCalledTimes(1);
  });

  it('rechecks expiry at the write fence and sends what missed the turn once, as the next message', async () => {
    const h = harness(); h.setMode('expire');
    const response = await h.submit();
    expect(response.statusCode).toBe(202);
    const run = response.json<Run>();
    expect(run).toMatchObject({ state: 'queued', native: { delivery: 'queued', stage: 'steer_fallback' } });
    expect(run.native?.intent).toBeUndefined();
    // It waits for the turn it missed to close, then goes out once.
    h.dispatch.kick();
    expect(h.native.sendRun).not.toHaveBeenCalled();
    h.finish();
    h.dispatch.kick();
    await vi.waitFor(() => expect(h.native.sendRun).toHaveBeenCalledTimes(1));
    expect(h.native.sendRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: run.id }), expect.any(Function), undefined);
    h.dispatch.kick();
    expect(h.native.sendRun).toHaveBeenCalledTimes(1);
    expect(h.native.steerRun).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a definite provider rejection from a lost result and never retries a fenced input', async () => {
    const h = harness(); h.setMode('reject');
    expect((await h.submit('rejected')).json()).toMatchObject({ state: 'failed', native: { delivery: 'failed' } });
    h.setMode('unknown');
    const unknown = (await h.submit('unknown')).json<Run>();
    expect(unknown).toMatchObject({ state: 'interrupted', native: { delivery: 'uncertain' } });
    expect((await h.submit('unknown')).json<Run>().id).toBe(unknown.id);
    h.dispatch.kick();
    expect(h.native.steerRun).toHaveBeenCalledTimes(2);
    expect(h.native.sendRun).not.toHaveBeenCalled();
  });

  it('keeps an uncertain stopped input interrupted when its native receipt arrives late', async () => {
    const mode = 'unknown';
    const h = harness(); h.setMode(mode);
    const run = (await h.submit()).json<Run>();
    await h.dispatch.interrupt(h.session.id);
    expect(h.store.getRun(h.owner.id).state).toBe('interrupted');
    expect(h.store.getRun(run.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'uncertain', stage: 'steer_stopped' } });
    h.user(run);
    expect(h.store.getRun(run.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'cancelled', nativeMessageId: 'user:steer-1' } });
    h.finish('run_cancelled');
    expect(h.store.getRun(run.id).state).toBe('interrupted');
  });

  it('protects steering from old queue and resolve actions while allowing pre-write cancellation', async () => {
    const h = harness(); const pending = h.acceptSteer('pending');
    const sendNow = await h.app.inject({ method: 'POST', url: `/api/sessions/${h.session.id}/native/runs/${pending.id}/send-now`, payload: { stop: { requestId: 'stop-pending', ...h.target } } });
    expect(sendNow.statusCode).toBe(409);
    expect(h.native.interrupt).not.toHaveBeenCalled();
    expect((await h.app.inject({ method: 'POST', url: `/api/sessions/${h.session.id}/native/runs/${pending.id}/cancel` })).statusCode).toBe(200);
    const unknown = h.acceptSteer('uncertain');
    h.store.transitionNativeRun(unknown.id, ['queued'], { delivery: 'uncertain' }, { state: 'interrupted' });
    const resolve = (target?: object) => h.app.inject({ method: 'POST', url: `/api/sessions/${h.session.id}/native/runs/${unknown.id}/resolve`, payload: { outcome: 'discard', ...(target ? { target } : {}) } });
    expect((await resolve()).statusCode).toBe(409);
    expect((await resolve({ ...h.target, turnId: 'different' })).statusCode).toBe(409);
    expect((await resolve(h.target)).statusCode).toBe(409);
    expect(h.store.getRun(h.owner.id).state).toBe('running');
    expect(h.store.getRun(unknown.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'uncertain' } });
  });

  it('recovers pre-write steers as unsent and post-write steers as uncertain', () => {
    const h = harness();
    const queued = h.acceptSteer('queued'), preparing = h.acceptSteer('preparing'), sent = h.acceptSteer('sent');
    h.store.transitionNativeRun(preparing.id, ['queued'], { delivery: 'preparing' });
    h.store.transitionNativeRun(sent.id, ['queued'], { delivery: 'dispatching' });
    h.store.recoverInterruptedRuns();
    // A restart loses the inbox that held them for the turn: they wait to be sent as the next message.
    for (const run of [queued, preparing]) expect(h.store.getRun(run.id)).toMatchObject({ state: 'queued', native: { delivery: 'queued', stage: 'steer_fallback' } });
    expect(h.store.getRun(sent.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'uncertain' } });
  });

  it('observes receipted hook turns through restart and accepts their real late outcome without resending', async () => {
    for (const backendId of ['cursor', 'claude'] as const) {
      const h = harness(), steer = (await h.submit()).json<Run>();
      h.store.updateSession(h.session.id, { backendId });
      h.store.transitionNativeRun(h.owner.id, ['observed'], { backendId, expectsTurnOutcome: true });
      h.store.transitionNativeRun(steer.id, ['observed'], { backendId });
      const queued = h.store.acceptNativeRun(h.session.id, 'after-recovery', input('next task'), config);
      // Repair rows parked by older service versions as well as already-observed rows.
      h.store.transitionNativeRun(steer.id, ['observed'], { delivery: 'uncertain', stage: 'turn_outcome_unknown' }, { state: 'interrupted', error: 'old recovery fence' });
      h.store.recoverInterruptedRuns();
      h.setStatus({ phase: 'busy', activeTurn: h.target });
      h.dispatch.kick();
      for (const run of [h.owner, steer]) expect(h.store.getRun(run.id)).toMatchObject({
        state: 'running', native: { delivery: 'observed', expectsTurnOutcome: true },
      });
      expect(h.store.getRun(steer.id).error).toBeUndefined();
      expect(h.native.sendRun).not.toHaveBeenCalled();
      expect(h.native.steerRun).toHaveBeenCalledTimes(1);
      h.finish('run_failed');
      for (const run of [h.owner, steer]) expect(h.store.getRun(run.id).state).toBe('failed');
      h.dispatch.kick();
      await vi.waitFor(() => expect(h.native.sendRun).toHaveBeenCalledTimes(1));
      expect(h.native.sendRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: queued.id }), expect.any(Function), undefined);
      expect(h.native.interrupt).not.toHaveBeenCalled();
    }
  });

  it.each(['idle', 'superseded'] as const)('closes receipted hook turns after restart as interrupted when %s, without a manual resend check', async end => {
    const h = harness({ idleReconcileMs: 0, idleOutcomeGraceMs: 0 }), steer = (await h.submit()).json<Run>();
    h.store.updateSession(h.session.id, { backendId: 'claude' });
    h.store.transitionNativeRun(h.owner.id, ['observed'], { backendId: 'claude', expectsTurnOutcome: true });
    h.store.transitionNativeRun(steer.id, ['observed'], { backendId: 'claude' });
    const queued = h.store.acceptNativeRun(h.session.id, 'after-idle-recovery', input('next task'), config);
    h.store.recoverInterruptedRuns();
    h.setStatus(end === 'idle' ? { phase: 'idle' } : { phase: 'busy', activeTurn: { ...h.target, turnId: 'newer-turn' } });
    for (const run of [h.owner, steer]) expect(h.store.getRun(run.id)).toMatchObject({
      state: 'interrupted', native: { delivery: 'cancelled', stage: 'turn_outcome_unknown' },
    });
    if (end === 'superseded') {
      // The newer turn is the CLI's own: the next message waits for it to end.
      h.dispatch.kick();
      expect(h.native.sendRun).not.toHaveBeenCalled();
      h.setStatus({ phase: 'idle' });
    }
    h.dispatch.kick();
    await vi.waitFor(() => expect(h.native.sendRun).toHaveBeenCalledTimes(1));
    expect(h.native.sendRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: queued.id }), expect.any(Function), undefined);
    expect(h.native.steerRun).toHaveBeenCalledTimes(1);
    expect(h.native.interrupt).not.toHaveBeenCalled();
    // A real late outcome can still refine the interrupted result; it does not resend anything.
    h.emit({ sequence: 99, nativeId: 'replayed-failed-outcome', nativeTurnId: h.target.turnId, sessionId: h.session.id,
      type: 'run_failed', data: { nativeSessionId: h.target.nativeSessionId, error: 'replayed native failure' }, createdAt: new Date().toISOString() });
    for (const run of [h.owner, steer]) expect(h.store.getRun(run.id).state).toBe('failed');
  });

  it.each(['completed', 'failed', 'acknowledged'] as const)('keeps a %s owner settled while replayed outcomes finish eligible steers only', async ownerState => {
    const h = harness(), steer = (await h.submit()).json<Run>();
    h.store.transitionNativeRun(h.owner.id, ['observed'], {
      delivery: ownerState === 'completed' ? 'observed' : ownerState === 'failed' ? 'failed' : 'cancelled',
      stage: ownerState === 'acknowledged' ? 'acknowledged' : ownerState,
    }, { state: ownerState === 'acknowledged' ? 'cancelled' : ownerState });
    const manual = h.acceptSteer('manually-closed');
    h.store.transitionNativeRun(manual.id, ['queued'], { delivery: 'cancelled', stage: 'acknowledged', nativeMessageId: 'manual-receipt' }, { state: 'cancelled' });
    const before = h.store.getRun(h.owner.id), manualBefore = h.store.getRun(manual.id);
    h.emit({ sequence: 99, nativeId: 'replayed-complete-outcome', nativeTurnId: h.target.turnId, sessionId: h.session.id,
      type: 'run_completed', data: { nativeSessionId: h.target.nativeSessionId }, createdAt: new Date().toISOString() });
    expect(h.store.getRun(h.owner.id)).toEqual(before);
    expect(h.store.getRun(manual.id)).toEqual(manualBefore);
    expect(h.store.getRun(steer.id)).toMatchObject({ state: 'completed', native: { delivery: 'observed' } });
    expect(h.native.steerRun).toHaveBeenCalledTimes(1);
    expect(h.native.sendRun).not.toHaveBeenCalled();
    expect(h.native.interrupt).not.toHaveBeenCalled();
  });

  it('counts a steered turn once and attributes its usage to the stable execution owner', async () => {
    const h = harness(), ledger = new StatsLedger(h.store);
    cleanups.push(() => ledger.close());
    const steer = (await h.submit()).json<Run>();
    ledger.recordUsage(h.session.id, steer.id, { stepId: 'step-1', outputTokens: 42, tokenSource: 'provider' });
    h.finish();
    const facts = h.store.db.prepare('SELECT * FROM run_facts').all() as Array<{ run_id: string; output_tokens: number }>;
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ run_id: h.owner.id, output_tokens: 42 });
    expect(h.store.db.prepare('SELECT run_id FROM usage_steps').get()).toMatchObject({ run_id: h.owner.id });
    expect(h.store.getRun(steer.id).native?.metrics).toBeUndefined();
  });

  it('releases the session lock while a deferred input waits and records only a native receipt as accepted', async () => {
    const h = harness(); h.setMode('deferred');
    const run = (await h.submit()).json<Run>();
    expect(run.native).toMatchObject({ delivery: 'preparing', stage: 'steer_waiting_boundary' });
    expect(run.native?.timings?.inputSentAt).toBeUndefined();
    await expect(h.runtime.withSession(h.session.id, async () => 'lock released')).resolves.toBe('lock released');
    h.claim(run, false);
    expect(h.store.getRun(run.id).native).toMatchObject({ delivery: 'input_sent', stage: 'steer_confirmation' });
    expect(h.store.getRun(run.id).native?.timings?.providerAcceptedAt).toBeUndefined();
    h.internal(run, 'native_input_receipt', { receiptKind: 'hook_context' });
    expect(h.store.getRun(run.id)).toMatchObject({ state: 'running', native: { delivery: 'observed', nativeMessageId: 'native_input_receipt:steer-1' } });
    expect(h.store.getRun(run.id).native?.timings?.providerAcceptedAt).toBeTypeOf('number');
    h.finish();
    expect(h.store.getRun(run.id).state).toBe('completed');
    expect(h.native.sendRun).not.toHaveBeenCalled(); expect(h.native.interrupt).not.toHaveBeenCalled();
  });

  it('queues a deferred input its turn ended before, without treating a late pre-write rejection as proof after the fence', async () => {
    const h = harness(); h.setMode('deferred');
    h.store.acceptNativeRun(h.session.id, 'queued-before-steer', input('older task'), config);
    const unsent = (await h.submit('unsent')).json<Run>();
    h.internal(unsent, 'native_input_rejected', { beforeWrite: true, reason: 'turn ended' });
    expect(h.store.getRun(unsent.id)).toMatchObject({ state: 'queued', native: { delivery: 'queued', stage: 'steer_fallback' } });
    expect(() => h.claim(unsent)).toThrow('sent on as the next message');
    // The refused claim's own rejection speaks for the old turn: it must not bind the message to it.
    h.internal(unsent, 'native_input_rejected', { beforeWrite: true, reason: 'claim refused' });
    expect(h.store.getRun(unsent.id).native?.nativeTurnId).toBeUndefined();
    // Still ahead of what was queued before it, after an attempt rewrote its stage.
    h.store.transitionNativeRun(unsent.id, ['queued'], { stage: 'waiting' });
    expect(h.dispatch.queue(h.session.id, h.native.status()).next).toBe(unsent.id);
    const sent = (await h.submit('sent')).json<Run>(); h.claim(sent, false);
    h.internal(sent, 'native_input_rejected', { beforeWrite: true, reason: 'late rejection' });
    expect(h.store.getRun(sent.id).native?.delivery).toBe('input_sent');
    expect(h.native.sendRun).not.toHaveBeenCalled();
  });

  it('takes a hook receipt for the turn it names, whatever turn its transcript row was grouped into', async () => {
    const h = harness(); h.setMode('deferred');
    const run = (await h.submit()).json<Run>(); h.claim(run, false);
    // An answered question reopens the turn in the journal under a key of its own.
    h.emit({ sequence: 50, sessionId: h.session.id, nativeId: 'steer:receipt', nativeTurnId: 'claude-turn:reopened', runId: run.id, type: 'native_input_receipt',
      data: { commandId: run.commandId, receiptKind: 'hook_context', content: { text: run.prompt }, sourceNativeId: 'tool-result', targetTurnId: h.target.turnId }, createdAt: new Date().toISOString() });
    expect(h.store.getRun(run.id)).toMatchObject({ state: 'running', native: { delivery: 'observed', nativeMessageId: 'steer:receipt' } });
  });

  it('holds the next message behind an unconfirmed steer only while its turn runs', async () => {
    const h = harness(); h.setMode('unknown');
    const steer = (await h.submit()).json<Run>();
    expect(steer).toMatchObject({ state: 'interrupted', native: { delivery: 'uncertain' } });
    const queued = h.store.acceptNativeRun(h.session.id, 'after-steer', input('next task'), config);
    h.dispatch.kick();
    expect(h.dispatch.queue(h.session.id, h.native.status())).toMatchObject({ next: queued.id, held: { reason: 'unconfirmed', runId: steer.id } });
    h.finish();
    expect(h.store.getRun(steer.id).native?.delivery).toBe('uncertain');
    expect(h.dispatch.queue(h.session.id, h.native.status()).held?.reason).not.toBe('unconfirmed');
    h.dispatch.kick();
    await vi.waitFor(() => expect(h.native.sendRun).toHaveBeenCalledTimes(1));
    expect(h.native.sendRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: queued.id }), expect.any(Function), undefined);
  });

  it('keeps deferred cancellation and stop cancellable before the provider fence', async () => {
    const h = harness(); h.setMode('deferred');
    const cancelled = (await h.submit('cancelled')).json<Run>();
    expect(h.dispatch.cancel(h.session.id, cancelled.id).native?.delivery).toBe('cancelled');
    expect(() => h.claim(cancelled)).toThrow('The steer message was cancelled');
    const stopped = (await h.submit('stopped')).json<Run>(); await h.dispatch.interrupt(h.session.id);
    // A stop keeps it as it keeps the messages queued behind it; the CLI is still busy, so nothing is sent yet.
    expect(h.store.getRun(stopped.id)).toMatchObject({ state: 'queued', native: { delivery: 'queued', stage: 'steer_fallback' } });
    expect(() => h.claim(stopped)).toThrow('sent on as the next message');
    expect(h.native.sendRun).not.toHaveBeenCalled();
  });

  it('atomically steers a queued message with a new command identity and preserves all original input', async () => {
    const h = harness();
    const original = { text: 'review login', attachmentIds: ['file-1'], context: [{ path: 'src/login.ts', line: 42 }] };
    const source = h.store.acceptNativeRun(h.session.id, 'queued-source', original, { mode: 'plan', model: 'next-model' });
    const [a, b] = await Promise.all([h.steerQueued(source), h.steerQueued(source)]);
    expect(a.statusCode).toBe(202); expect(b.json<Run>().id).toBe(a.json<Run>().id);
    const run = a.json<Run>();
    expect(run.id).not.toBe(source.id);
    expect(run.native).toMatchObject({ input: original, config, intent: 'steer', sourceRunId: source.id, ownerRunId: h.owner.id });
    expect(h.store.getRun(source.id)).toMatchObject({ state: 'cancelled', native: { delivery: 'cancelled', stage: 'steer_replaced' } });
    expect(h.native.steerRun).toHaveBeenCalledTimes(1);
    expect(h.native.sendRun).not.toHaveBeenCalled(); expect(h.native.interrupt).not.toHaveBeenCalled();
    h.removeAttachment(); h.setStatus({ phase: 'idle' }); h.setSupported(false);
    h.store.db.prepare('DELETE FROM runs WHERE id=?').run(source.id);
    expect((await h.steerQueued(source)).json<Run>().id).toBe(run.id);
    expect(h.native.steerRun).toHaveBeenCalledTimes(1);
    expect((await h.submit('queued-steer', { text: original.text, attachments: [{ id: 'file-1' }], context: original.context })).statusCode).toBe(409);
  });

  it('leaves the queue unchanged on a rejected conversion and refuses changed source or target retries', async () => {
    const h = harness();
    const source = h.store.acceptNativeRun(h.session.id, 'queued-source', input('next task'), config);
    h.setSupported(false);
    expect((await h.steerQueued(source)).json()).toMatchObject({ error: { code: 'STEER_UNSUPPORTED' } });
    expect(h.store.getRun(source.id).native?.delivery).toBe('queued');
    h.setSupported(true);
    expect((await h.steerQueued(source, source.commandId)).statusCode).toBe(409);
    expect(h.store.getRun(source.id).native?.delivery).toBe('queued');
    expect((await h.steerQueued(source)).json()).toMatchObject({ error: { code: 'STEER_UNSUPPORTED' } });
    expect((await h.steerQueued(source, 'queued-steer-retry')).statusCode).toBe(202);
    const other = h.store.acceptNativeRun(h.session.id, 'other-source', input('another task'), config);
    expect((await h.steerQueued(other)).statusCode).toBe(409);
    expect(h.store.getRun(other.id).native?.delivery).toBe('queued');
    expect((await h.steerQueued(source, 'queued-steer-retry', { target: { ...h.target, turnId: 'new-turn' } })).statusCode).toBe(409);
    expect((await h.steerQueued(other, 'other-steer', { model: 'override' })).statusCode).toBe(400);
    expect(h.native.steerRun).toHaveBeenCalledTimes(1);
  });

  it('binds Cursor native turn identity from its unique untagged echo and backfills it by native message identity', async () => {
    const h = harness(); h.store.updateSession(h.session.id, { backendId: 'cursor' });
    // Establish the durable observer without invoking a new ordinary task.
    await h.submit();
    h.store.transitionNativeRun(h.owner.id, ['observed'], { nativeTurnId: undefined });
    h.emit({ sequence: 50, sessionId: h.session.id, nativeId: 'original-user', nativeTurnId: h.target.turnId,
      type: 'user_message_chunk', data: { content: { text: h.owner.prompt } }, createdAt: new Date().toISOString() });
    expect(h.store.getRun(h.owner.id).native?.nativeTurnId).toBe(h.target.turnId);
    const run = h.store.acceptNativeRun(h.session.id, 'tolerant-owner', input('check the repository'), config);
    h.store.transitionNativeRun(run.id, ['queued'], { delivery: 'input_sent', baselineSequence: 50, renderedText: run.prompt });
    h.emit({ sequence: 51, sessionId: h.session.id, nativeId: 'next-original-user', nativeTurnId: 'next-generation',
      type: 'user_message_chunk', data: { content: { text: run.prompt } }, createdAt: new Date().toISOString() });
    expect(h.store.getRun(run.id).native).toMatchObject({ delivery: 'observed', nativeMessageId: 'next-original-user', nativeTurnId: 'next-generation' });
  });

  it('recovers a steering owner when the original native echo becomes visible after acceptance', async () => {
    const h = harness(); h.setMode('silent');
    const steer = (await h.submit()).json<Run>();
    h.store.transitionNativeRun(steer.id, ['input_sent'], { ownerRunId: undefined });
    h.store.transitionNativeRun(h.owner.id, ['observed'], { nativeTurnId: undefined });
    h.emit({ sequence: 50, sessionId: h.session.id, nativeId: 'original-user', nativeTurnId: h.target.turnId,
      type: 'user_message_chunk', data: { content: { text: h.owner.prompt } }, createdAt: new Date().toISOString() });
    h.internal(steer, 'native_input_receipt', { receiptKind: 'hook_context' });
    expect(h.store.getRun(steer.id)).toMatchObject({ state: 'running', native: { ownerRunId: h.owner.id, delivery: 'observed' } });
  });

  it('settles a failed Cursor owner when its native outcome precedes the original transcript echo', async () => {
    const type = 'run_failed';
    const h = harness(), steer = (await h.submit()).json<Run>(); h.store.updateSession(h.session.id, { backendId: 'cursor' });
    h.store.transitionNativeRun(h.owner.id, ['observed'], { delivery: 'input_sent', nativeTurnId: undefined, nativeMessageId: undefined,
      baselineSequence: 1, renderedText: h.owner.prompt }, { state: 'queued' });
    h.emit({ sequence: 2, sessionId: h.session.id, nativeId: 'stop-before-echo', nativeTurnId: h.target.turnId, type,
      data: { nativeSessionId: h.target.nativeSessionId, error: 'native failed' }, createdAt: new Date().toISOString() });
    expect(h.store.getRun(h.owner.id).state).toBe('queued');
    h.emit({ sequence: 3, sessionId: h.session.id, nativeId: 'real-late-original', nativeTurnId: h.target.turnId,
      type: 'user_message_chunk', data: { content: { text: h.owner.prompt } }, createdAt: new Date().toISOString() });
    expect(h.store.getRun(h.owner.id)).toMatchObject({ state: 'failed',
      native: { nativeTurnId: h.target.turnId, nativeMessageId: 'real-late-original' } });
    expect(h.store.getRun(steer.id).state).toBe('failed');
    h.setStatus({ phase: 'idle' });
    expect(h.store.getRun(h.owner.id).state).toBe('failed');
  });

  it('does not apply an untagged terminal notification to a different native target', async () => {
    const h = harness(); await h.submit(); h.store.updateSession(h.session.id, { backendId: 'cursor' });
    h.emit({ sequence: 2, sessionId: h.session.id, nativeId: 'foreign-stop', nativeTurnId: h.target.turnId, type: 'run_failed',
      data: { nativeSessionId: 'another-native-session' }, createdAt: new Date().toISOString() });
    h.emit({ sequence: 3, sessionId: h.session.id, nativeId: 'previous-stop', nativeTurnId: 'previous-generation', type: 'run_failed',
      data: { nativeSessionId: h.target.nativeSessionId }, createdAt: new Date().toISOString() });
    h.emit({ sequence: 4, sessionId: h.session.id, nativeId: 'original-user', nativeTurnId: h.target.turnId, type: 'user_message_chunk',
      data: { content: { text: h.owner.prompt } }, createdAt: new Date().toISOString() });
    expect(h.store.getRun(h.owner.id).state).toBe('running');
  });

  it('keeps legacy idle reconciliation until a live Cursor hook target is observed', () => {
    const backendId = 'cursor';
    const h = harness();
    h.store.updateSession(h.session.id, { backendId });
    h.store.transitionNativeRun(h.owner.id, ['observed'], { backendId });
    h.setStatus({ phase: 'idle' });
    h.dispatch.kick();
    expect(h.store.getRun(h.owner.id).state).toBe('completed');
    h.store.transitionNativeRun(h.owner.id, ['observed'], { stage: 'executing' }, { state: 'running' });
    h.setStatus({ phase: 'busy', activeTurn: { ...h.target, ownerRunId: h.owner.id } });
    expect(h.store.getRun(h.owner.id).native?.expectsTurnOutcome).toBe(true);
    h.setStatus({ phase: 'idle' });
    expect(h.store.getRun(h.owner.id).state).toBe('running');
    h.finish('run_failed');
    expect(h.store.getRun(h.owner.id).state).toBe('failed');
  });
});
