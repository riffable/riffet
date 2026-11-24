import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeStatus, NativeWorkbenchEvent, Session } from '../../../../packages/contracts/src/index.js';
import { JournalFeed } from '../journal/feed.js';
import { JournalLaneWriter, type TranscriptSource } from '../journal/ingest.js';
import { NativeDispatcher } from '../native/dispatch.js';
import { Store } from '../store.js';
import { TranscriptIngest } from '../sync/ingest.js';
import { CLAUDE_TRAITS } from './claude/index.js';
import { CODEX_TRAITS } from './codex/index.js';
import { DispatchFeed } from './dispatch-feed.js';
import { NativeBackendService } from './service.js';
import type { NativeBackendDriver, NativeBackendHost, NativeBackendSendRequest, NativeBackendTraits, NativeControlMessage } from './types.js';

/** The traits the Cursor plugin declares (`plugins/riffet/cursor/backend.ts`); the service reads traits, never a backend id. */
const CURSOR_TRAITS: NativeBackendTraits = { settlesSlashOnSubmit: true, untaggedEcho: true, reportsTurnOutcome: true, ownsSessionObservation: true, resumesByNativeId: true, terminalName: 'Cursor' };

/*
 * The dispatcher reading the journal instead of the v2 pump (docs/SYNC-V3.md, 接线): a real store, journal,
 * backend service and dispatcher; a driver whose transcript only ever reaches the journal.
 */

const input = (text: string) => ({ text, attachmentIds: [], context: [] });
const at = (index: number) => new Date(Date.UTC(2026, 9, 1) + index * 1000).toISOString();
const row = (sessionId: string, id: string, type: string, turn: string, data: Record<string, unknown>): NativeWorkbenchEvent => ({ sequence: 0, sessionId, type, nativeId: id, nativeTurnId: turn, createdAt: at(1), data });

function setup(backendId: 'claude' | 'codex' | 'cursor', send: (request: NativeBackendSendRequest, w: JournalLaneWriter, host: NativeBackendHost) => void | Promise<void> = () => undefined) {
  const store = new Store(':memory:');
  const project = store.createProject('/tmp/dispatch-feed', 'feed');
  const session = store.createSession({ projectId: project.id, kind: 'native', backendId, mode: 'agent', nativeSessionId: 'chat-1', ...(backendId === 'cursor' ? { cursorSessionId: 'chat-1' } : {}) });
  const writer = JournalLaneWriter.open(store.journal, session.id);
  /** At its prompt until a send starts a turn. */
  let status: NativeStatus = { phase: 'idle' };
  /** What the CLI has written that no read has taken in yet: a drain does. */
  const unread: Array<() => void> = [];
  const pumps = new Set<(message: NativeControlMessage) => void>();
  const source: TranscriptSource = { identity: () => 'chat-1', pull: async () => ({ caughtUp: true }), drain: async () => { for (const write of unread.splice(0)) write(); } };
  const driver = {
    id: backendId, label: backendId, traits: { claude: CLAUDE_TRAITS, codex: CODEX_TRAITS, cursor: CURSOR_TRAITS }[backendId],
    profiles: () => [{ id: 'local', backendId, name: 'Local', isDefault: true, config: {} }],
    capabilities: () => ({ supportsInitialPromptArgs: false, supportsSteer: false }),
    status: () => status,
    subscribe: (_host: unknown, _session: unknown, _profile: unknown, listener: (message: NativeControlMessage) => void) => { pumps.add(listener); return () => { pumps.delete(listener); }; },
    snapshot: async () => ({ events: [], status }),
    transcript: () => source,
    send: async (host: NativeBackendHost, request: NativeBackendSendRequest) => { status = { phase: 'busy' }; await send(request, writer, host); },
  } as unknown as NativeBackendDriver;
  const service = new NativeBackendService({
    store, workspace: {} as never, terminal: { get: async () => { throw new Error('none'); }, screen: async () => undefined } as never,
    runtime: { withSession: async <T>(_id: string, operation: () => Promise<T> | T) => await operation() } as never,
    registry: { require: () => driver, list: () => [driver], isPending: () => false } as never,
  });
  const ingest = new TranscriptIngest({ journal: store.journal, source: id => service.transcriptSource(id) });
  service.attachIngest(ingest);
  const feed = new JournalFeed(store.journal);
  const runtime = { withSession: async <T>(_id: string, operation: () => Promise<T>) => await operation(), ensure: async () => undefined };
  const dispatcher = () => new NativeDispatcher(store, new DispatchFeed({ service, feed, store }).backend(), runtime, { readAttachment: async () => { throw new Error('none'); } } as never, { intervalMs: 60_000 });
  const close = async () => { ingest.close(); feed.close(); await service.closeAll().catch(() => undefined); store.close(); };
  const setStatus = (next: NativeStatus) => { status = next; for (const pump of pumps) pump({ type: 'status', status: next }); };
  return { store, session: session as Session, writer, dispatcher, close, setStatus, unread, driver, host: service.host };
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 2_000, interval: 5 });

describe('dispatcher fed by the journal', () => {
  it.each(['journal', 'driver'] as const)('corrects a released input by command id after its provider watch closes (%s)', async source => {
    const env = setup('cursor');
    cleanups.push(env.close);
    const id = env.session.id;
    const run = env.store.acceptNativeRun(id, 'released', input('same words'), { mode: 'agent' }, 0);
    env.store.transitionNativeRun(run.id, ['queued'], { delivery: 'uncertain', stage: 'confirmation', backendId: 'cursor',
      nativeSessionId: 'chat-1', queueReleasedAt: at(0), baselineSequence: 0 }, { state: 'interrupted' });
    const dispatcher = env.dispatcher();
    cleanups.push(() => dispatcher.close());
    dispatcher.kick(id);
    const publish = (event: NativeWorkbenchEvent) => {
      if (source === 'journal') env.writer.commit({ events: [event], cursor: event.nativeId });
      else env.host.emitEvent(id, event);
    };
    publish(row(id, 'other-user', 'user_message_chunk', 'other-turn', { content: { type: 'text', text: 'same words' } }));
    publish(row(id, 'other-chat-user', 'native_input_receipt', 'other-turn', { commandId: run.commandId, nativeSessionId: 'other-chat' }));
    publish(row(id, 'original-user', 'native_input_receipt', 'original-turn', { commandId: run.commandId }));
    await waitFor(() => expect(env.store.getRun(run.id)).toMatchObject({
      state: 'interrupted', native: { delivery: 'observed', nativeMessageId: 'original-user', nativeTurnId: 'original-turn', queueReleasedAt: at(0) },
    }));
    if (source === 'journal') env.writer.turnEnded('original-turn', 'completed', at(2));
    else publish(row(id, 'end', 'run_completed', 'original-turn', { commandId: run.commandId }));
    await waitFor(() => expect(env.store.getRun(run.id).state).toBe('completed'));
  });

  it('stops the targeted known turn without cancelling an earlier unbound native command', async () => {
    const env = setup('codex');
    cleanups.push(env.close);
    const unknown = env.store.acceptNativeRun(env.session.id, 'unbound-command', input('/review'), { mode: 'agent' }, 0);
    env.store.transitionNativeRun(unknown.id, ['queued'], { delivery: 'uncertain', stage: 'confirmation', backendId: 'codex', nativeSessionId: 'chat-1', slashCommand: true }, { state: 'interrupted' });
    const known = env.store.acceptNativeRun(env.session.id, 'known-command', input('known turn'), { mode: 'agent' }, 0);
    env.store.transitionNativeRun(known.id, ['queued'], { delivery: 'observed', stage: 'executing', backendId: 'codex', nativeSessionId: 'chat-1', nativeTurnId: 'known-turn', nativeMessageId: 'known-user' }, { state: 'running' });
    env.writer.turnStarted('known-turn', at(0), known.id);
    env.setStatus({ phase: 'busy', activeTurn: { nativeSessionId: 'chat-1', turnId: 'known-turn' } });
    env.driver.interrupt = async () => { env.writer.turnEnded('known-turn', 'interrupted', at(2)); env.setStatus({ phase: 'idle' }); };
    const dispatcher = env.dispatcher();
    cleanups.push(() => dispatcher.close());
    dispatcher.kick();
    await dispatcher.interrupt(env.session.id, { requestId: 'stop-known', nativeSessionId: 'chat-1', turnId: 'known-turn' });
    expect(env.store.getRun(known.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'cancelled' } });
    expect(env.store.getRun(unknown.id)).toMatchObject({ state: 'interrupted', native: { delivery: 'uncertain', stage: 'confirmation' } });
  });

  it.each(['immediate', 'after-local-wait'] as const)('settles a command rejection without a provider turn (%s)', async ordering => {
    let reject!: (threadId?: string) => void;
    let sends = 0;
    const env = setup('codex', (request, _writer, host) => {
      sends++;
      request.commitDispatchFence({ backendId: 'codex', nativeSessionId: 'chat-1', slashCommand: true, renderedText: request.input.text });
      reject = (nativeSessionId = 'chat-1') => host.emitEvent(request.session.id, {
        sequence: 1, sessionId: request.session.id, runId: request.runId, type: 'native_input_rejected',
        nativeId: 'command-rejection', createdAt: at(1),
        data: { commandId: request.commandId, nativeSessionId, receiptKind: 'native_command', error: 'method not found' },
      });
      if (ordering === 'immediate') reject();
      throw new Error('local wait ended');
    });
    cleanups.push(env.close);
    const run = env.store.acceptNativeRun(env.session.id, 'rejected-command', input('/review'), { mode: 'agent' }, 0);
    const dispatcher = env.dispatcher();
    cleanups.push(() => dispatcher.close());
    dispatcher.kick();
    if (ordering === 'after-local-wait') {
      await waitFor(() => expect(env.store.getRun(run.id).native?.delivery).toBe('uncertain'));
      reject('other-thread');
      expect(env.store.getRun(run.id).native?.delivery).toBe('uncertain');
      reject();
    }
    await waitFor(() => expect(env.store.getRun(run.id)).toMatchObject({ state: 'failed', error: 'method not found', native: { delivery: 'failed' } }));
    expect(env.store.getRun(run.id).native?.nativeTurnId).toBeUndefined();
    expect(sends).toBe(1);
  });

  it.each(['before-receipt', 'after-restart'] as const)('settles a native command without a user message when its turn ends %s', async ordering => {
    let sends = 0;
    let receipt!: () => void;
    const env = setup('codex', (request, writer, host) => {
      sends++;
      request.commitDispatchFence({ backendId: 'codex', nativeSessionId: 'chat-1', baselineSequence: 0, renderedText: '/compact' });
      writer.turnStarted('compact-turn', at(0));
      receipt = () => host.emitEvent(request.session.id, row(request.session.id, 'compact-receipt', 'native_input_receipt', 'compact-turn', {
        commandId: request.commandId, nativeSessionId: 'chat-1', receiptKind: 'native_command',
      }));
    });
    cleanups.push(env.close);
    const run = env.store.acceptNativeRun(env.session.id, 'compact-command', input('/compact'), { mode: 'agent' }, 0);
    const dispatcher = env.dispatcher();
    cleanups.push(() => dispatcher.close());
    dispatcher.kick();
    await waitFor(() => expect(env.store.getRun(run.id).native?.delivery).toBe('input_sent'));
    expect(env.store.getRun(run.id).state).not.toBe('completed');
    if (ordering === 'before-receipt') env.writer.turnEnded('compact-turn', 'completed', at(2));
    receipt();
    if (ordering === 'after-restart') {
      await waitFor(() => expect(env.store.getRun(run.id)).toMatchObject({ state: 'running', native: { delivery: 'observed', nativeTurnId: 'compact-turn' } }));
      dispatcher.close();
      env.writer.turnEnded('compact-turn', 'completed', at(2));
      const restarted = env.dispatcher();
      cleanups.push(() => restarted.close());
      restarted.kick();
    }
    await waitFor(() => expect(env.store.getRun(run.id)).toMatchObject({ state: 'completed', native: { delivery: 'observed', nativeTurnId: 'compact-turn', nativeMessageId: 'compact-receipt' } }));
    expect(sends).toBe(1);
  });

  it('applies a late first completion after the ordinary observer closed on an unknown outcome', async () => {
    const sent = vi.fn();
    const env = setup('codex', sent);
    cleanups.push(env.close);
    const run = env.store.acceptNativeRun(env.session.id, 'late-first-end', input('finish it'), { mode: 'agent' }, 0);
    env.store.transitionNativeRun(run.id, ['queued'], {
      delivery: 'cancelled', stage: 'turn_outcome_unknown', backendId: 'codex', nativeSessionId: 'chat-1', nativeTurnId: 'late-turn', nativeMessageId: 'late-user',
    }, { state: 'interrupted' });
    env.writer.turnStarted('late-turn', at(0), run.id);
    const send = env.dispatcher();
    cleanups.push(() => send.close());
    send.kick();
    env.writer.turnEnded('late-turn', 'completed', at(3));
    await waitFor(() => expect(env.store.getRun(run.id)).toMatchObject({ state: 'completed', native: { delivery: 'observed', stage: 'completed' } }));
    expect(sent).not.toHaveBeenCalled();
  });

  it('reopens an erroneously ended turn before a delayed receipt can replay its old outcome, without sending twice', async () => {
    let sends = 0;
    const env = setup('codex', (request, writer) => {
      sends++;
      request.commitDispatchFence({ backendId: 'codex', nativeSessionId: 'chat-1', baselineSequence: 0, renderedText: request.input.text });
      writer.turnStarted('turn-1', at(0), request.runId);
      writer.turnEnded('turn-1', 'interrupted', at(1));
    });
    cleanups.push(env.close);
    const run = env.store.acceptNativeRun(env.session.id, 'cmd-1', input('build it'), { mode: 'agent' }, 0);
    const send = env.dispatcher();
    cleanups.push(() => send.close());
    send.kick();
    await waitFor(() => expect(env.store.getRun(run.id)).toMatchObject({ state: 'interrupted', native: { stage: 'provider_cancelled' } }));
    const before = env.store.getRun(run.id).native!;
    send.kick(); // The ordinary live observer has now been released.

    // Feed chunks are bounded at 500 rows. The recovered receipt is in the first chunk,
    // but the tombstone is after it: the current journal authority must still win first.
    env.writer.commit({ events: [
      row(env.session.id, 'u1', 'user_message_chunk', 'turn-1', { commandId: run.commandId, content: { type: 'text', text: run.prompt } }),
      ...Array.from({ length: 501 }, (_, i) => row(env.session.id, `a${i}`, 'agent_message_chunk', 'turn-1', { content: { type: 'text', text: 'working' } })),
    ], cursor: '2' });
    env.writer.turnReopened('turn-1', at(2));
    await waitFor(() => expect(env.store.getRun(run.id)).toMatchObject({ state: 'running', native: { delivery: 'observed', stage: 'executing', nativeMessageId: 'u1' } }));
    const reopened = env.store.getRun(run.id).native!;
    expect(reopened.attempt).toBe(before.attempt);
    expect(reopened.baselineSequence).toBe(before.baselineSequence);
    send.kick();
    expect(sends).toBe(1);
    env.writer.turnEnded('turn-1', 'completed', at(3));
    await waitFor(() => expect(env.store.getRun(run.id)).toMatchObject({ state: 'completed', native: { stage: 'completed', nativeMessageId: 'u1' } }));
    expect(sends).toBe(1);
  });

  it('recovers a persisted corrected end at startup when no live run observer remains', async () => {
    const sent = vi.fn();
    const env = setup('codex', sent);
    cleanups.push(env.close);
    const run = env.store.acceptNativeRun(env.session.id, 'cmd-restart', input('build it'), { mode: 'agent' }, 0);
    env.store.transitionNativeRun(run.id, ['queued'], {
      delivery: 'cancelled', stage: 'provider_cancelled', backendId: 'codex', nativeSessionId: 'chat-1', nativeTurnId: 'turn-1', nativeMessageId: 'u1', attempt: 1,
    }, { state: 'interrupted' });
    env.writer.turnStarted('turn-1', at(0), run.id);
    env.writer.turnEnded('turn-1', 'interrupted', at(1));
    env.writer.turnReopened('turn-1', at(2));
    env.writer.turnEnded('turn-1', 'failed', at(3), 'actual provider failure');
    const send = env.dispatcher();
    cleanups.push(() => send.close());
    await waitFor(() => expect(env.store.getRun(run.id)).toMatchObject({ state: 'failed', error: 'actual provider failure', native: { stage: 'provider_failed', attempt: 1, nativeMessageId: 'u1' } }));
    expect(sent).not.toHaveBeenCalled();
  });

  it.each(['failed', 'completed'] as const)('recovers a persisted retraction of %s followed by a corrected end at startup', async state => {
    const sent = vi.fn();
    const env = setup('claude', sent);
    cleanups.push(env.close);
    const run = env.store.acceptNativeRun(env.session.id, `cmd-restart-${state}`, input('build it'), { mode: 'agent' }, 0);
    env.store.transitionNativeRun(run.id, ['queued'], {
      delivery: state === 'failed' ? 'failed' : 'observed', stage: state === 'failed' ? 'provider_failed' : 'completed',
      backendId: 'claude', nativeSessionId: 'chat-1', nativeTurnId: 'turn-1', nativeMessageId: 'u1', attempt: 1,
    }, { state, error: state === 'failed' ? 'mistaken failure' : undefined });
    env.writer.turnStarted('turn-1', at(0), run.id);
    env.writer.turnEnded('turn-1', state, at(1), state === 'failed' ? 'mistaken failure' : undefined);
    env.writer.turnReopened('turn-1', at(2));
    env.writer.turnEnded('turn-1', state === 'failed' ? 'completed' : 'failed', at(3), state === 'completed' ? 'actual provider failure' : undefined);
    const sibling = env.store.acceptNativeRun(env.session.id, `settled-${state}`, input('already settled'), { mode: 'agent' }, 0,
      { target: { nativeSessionId: 'chat-1', turnId: 'turn-1' }, ownerRunId: run.id });
    env.store.transitionNativeRun(sibling.id, ['queued'], { delivery: state === 'failed' ? 'observed' : 'failed',
      stage: state === 'failed' ? 'completed' : 'provider_failed', nativeMessageId: 'sibling', timings: { completedAt: 123 } },
    { state: state === 'failed' ? 'completed' : 'failed', error: state === 'completed' ? 'actual provider failure' : undefined });
    const settledSibling = env.store.getRun(sibling.id);
    const send = env.dispatcher();
    cleanups.push(() => send.close());
    await waitFor(() => expect(env.store.getRun(run.id)).toMatchObject({
      state: state === 'failed' ? 'completed' : 'failed',
      native: { stage: state === 'failed' ? 'completed' : 'provider_failed', attempt: 1, nativeMessageId: 'u1' },
    }));
    expect(env.store.getRun(run.id).error).toBe(state === 'failed' ? undefined : 'actual provider failure');
    expect(env.store.getRun(sibling.id)).toEqual(settledSibling);
    const settled = env.store.getRun(run.id);
    send.close();
    const restarted = env.dispatcher();
    cleanups.push(() => restarted.close());
    await new Promise(resolve => setImmediate(resolve));
    expect(env.store.getRun(run.id)).toEqual(settled);
    expect(sent).not.toHaveBeenCalled();
  });

  it('does not recover a revised failure at startup without an explicit retraction or across a user stop', async () => {
    const sent = vi.fn();
    const env = setup('claude', sent);
    cleanups.push(env.close);
    const persisted = ['unchanged', 'user-stopped'].map((commandId, index) => {
      const turnId = `turn-${index}`;
      const run = env.store.acceptNativeRun(env.session.id, commandId, input('work'), { mode: 'agent' }, 0);
      env.store.transitionNativeRun(run.id, ['queued'], { delivery: 'failed', stage: 'provider_failed', backendId: 'claude',
        nativeSessionId: 'chat-1', nativeTurnId: turnId, nativeMessageId: `u${index}`, attempt: 1 }, { state: 'failed', error: 'failed' });
      env.writer.turnStarted(turnId, at(0), run.id);
      env.writer.turnEnded(turnId, 'failed', at(1), 'failed');
      if (index === 1) {
        env.store.setSetting(`native-stops:${env.session.id}`, { stop: { request: { requestId: 'stop', nativeSessionId: 'chat-1', turnId },
          operation: 'stop', state: 'completed', createdAt: at(2) } });
        env.writer.turnReopened(turnId, at(2));
      }
      env.writer.turnEnded(turnId, 'completed', at(3));
      return env.store.getRun(run.id);
    });
    const send = env.dispatcher();
    cleanups.push(() => send.close());
    await new Promise(resolve => setImmediate(resolve));
    expect(persisted.map(run => env.store.getRun(run.id))).toEqual(persisted);
    expect(sent).not.toHaveBeenCalled();
  });

  it('takes the receipt from the echoed command id and the outcome from the turn end, and after a restart from the rows already logged', async () => {
    let commandId = '';
    const env = setup('codex', (request, w) => {
      commandId = request.commandId;
      request.commitDispatchFence({ backendId: 'codex', nativeSessionId: 'chat-1', baselineSequence: 12345, renderedText: request.input.text, resolvedConfig: request.config });
      w.turnStarted('turn-1', at(0), request.runId);
      w.commit({ events: [row(request.session.id, 'u1', 'user_message_chunk', 'turn-1', { commandId: request.commandId, content: { type: 'text', text: 'build it' } })], cursor: '1' });
    });
    cleanups.push(env.close);
    const run = env.store.acceptNativeRun(env.session.id, 'cmd-1', input('build it'), { mode: 'agent' }, 0);
    const send = env.dispatcher();
    cleanups.push(() => send.close());
    send.kick();
    await waitFor(() => expect(env.store.getRun(run.id)).toMatchObject({ state: 'running', native: { delivery: 'observed', nativeMessageId: 'u1', nativeTurnId: 'turn-1' } }));
    expect(commandId).toBe('cmd-1');
    // The fence counts from the journal, not from the provider's own numbering.
    expect(env.store.getRun(run.id).native?.baselineSequence).toBe(0);
    env.writer.commit({ events: [row(env.session.id, 'a1', 'agent_message_chunk', 'turn-1', { content: { type: 'text', text: 'done' } })], cursor: '2' });
    env.writer.turnEnded('turn-1', 'failed', at(3), 'quota exceeded');
    await waitFor(() => expect(env.store.getRun(run.id)).toMatchObject({ state: 'failed', error: 'quota exceeded', native: { delivery: 'failed', stage: 'provider_failed' } }));
    send.close();

    // A turn that ended while nothing listened: the next dispatcher reads it from the log.
    const second = env.store.acceptNativeRun(env.session.id, 'cmd-2', input('again'), { mode: 'agent' }, 0);
    env.store.transitionNativeRun(second.id, ['queued'], { delivery: 'observed', stage: 'executing', backendId: 'codex', nativeSessionId: 'chat-1', nativeMessageId: 'u2', nativeTurnId: 'turn-2', baselineSequence: 0 }, { state: 'running' });
    env.writer.turnStarted('turn-2', at(4), second.id);
    env.writer.commit({ events: [row(env.session.id, 'u2', 'user_message_chunk', 'turn-2', { commandId: 'cmd-2', content: { type: 'text', text: 'again' } })], cursor: '3' });
    env.writer.turnEnded('turn-2', 'completed', at(5));
    const restarted = env.dispatcher();
    cleanups.push(() => restarted.close());
    restarted.kick();
    await waitFor(() => expect(env.store.getRun(second.id)).toMatchObject({ state: 'completed', native: { delivery: 'observed', stage: 'completed' } }));
  });

  it('settles a run by its own turn end when a status names the next turn before the end was read', async () => {
    const env = setup('claude', (request, w) => {
      request.commitDispatchFence({ backendId: 'claude', nativeSessionId: 'chat-1', baselineSequence: 0, renderedText: request.input.text });
      w.commit({ events: [row(request.session.id, 'u1', 'user_message_chunk', 'turn-1', { commandId: request.commandId, content: { type: 'text', text: 'launch it' } })], cursor: '1' });
    });
    cleanups.push(env.close);
    const run = env.store.acceptNativeRun(env.session.id, 'cmd-1', input('launch it'), { mode: 'agent' }, 0);
    const send = env.dispatcher();
    cleanups.push(() => send.close());
    send.kick();
    await waitFor(() => expect(env.store.getRun(run.id).native).toMatchObject({ delivery: 'observed', nativeTurnId: 'turn-1' }));
    env.setStatus({ phase: 'busy', activeTurn: { nativeSessionId: 'chat-1', turnId: 'turn-1' } });
    await waitFor(() => expect(env.store.getRun(run.id).native?.expectsTurnOutcome).toBe(true));
    // The CLI ended turn-1 and began turn-2 (a background task's notification); the end is on disk, not read yet.
    env.unread.push(() => env.writer.turnEnded('turn-1', 'completed', at(3)));
    env.setStatus({ phase: 'busy', activeTurn: { nativeSessionId: 'chat-1', turnId: 'turn-2' } });
    await waitFor(() => expect(env.store.getRun(run.id)).toMatchObject({ state: 'completed', native: { delivery: 'observed', stage: 'completed' } }));
  });

  it('waits a moment for the end of the last turn when the status naming the next one comes before it reaches the disk', async () => {
    const env = setup('claude', (request, w) => {
      request.commitDispatchFence({ backendId: 'claude', nativeSessionId: 'chat-1', baselineSequence: 0, renderedText: request.input.text });
      w.commit({ events: [row(request.session.id, 'u1', 'user_message_chunk', 'turn-1', { commandId: request.commandId, content: { type: 'text', text: 'launch it' } })], cursor: '1' });
    });
    cleanups.push(env.close);
    const run = env.store.acceptNativeRun(env.session.id, 'cmd-1', input('launch it'), { mode: 'agent' }, 0);
    const send = env.dispatcher();
    cleanups.push(() => send.close());
    send.kick();
    await waitFor(() => expect(env.store.getRun(run.id).native).toMatchObject({ delivery: 'observed', nativeTurnId: 'turn-1' }));
    env.setStatus({ phase: 'busy', activeTurn: { nativeSessionId: 'chat-1', turnId: 'turn-1' } });
    await waitFor(() => expect(env.store.getRun(run.id).native?.expectsTurnOutcome).toBe(true));
    // Claude Code runs the next turn's hook at once and writes the rows ending this one a little later.
    env.setStatus({ phase: 'busy', activeTurn: { nativeSessionId: 'chat-1', turnId: 'turn-2' } });
    setTimeout(() => env.unread.push(() => env.writer.turnEnded('turn-1', 'completed', at(3))), 150);
    await waitFor(() => expect(env.store.getRun(run.id)).toMatchObject({ state: 'completed', native: { delivery: 'observed', stage: 'completed' } }));
  });

  it('matches an untagged echo by its text only among rows logged after the fence', async () => {
    const env = setup('cursor', (request, w) => {
      request.commitDispatchFence({ backendId: 'cursor', nativeSessionId: 'chat-1', baselineSequence: 99_000_000, renderedText: request.input.text });
      w.commit({ events: [row(request.session.id, '7:0', 'user_message_chunk', 'req-2', { content: { type: 'text', text: 'run the tests' } })], cursor: '2' });
    });
    cleanups.push(env.close);
    // The same words, asked before: logged ahead of the fence, so never this message's echo.
    env.writer.commit({ events: [row(env.session.id, '3:0', 'user_message_chunk', 'req-1', { content: { type: 'text', text: 'run the tests' } })], cursor: '1' });
    const run = env.store.acceptNativeRun(env.session.id, 'cmd-1', input('run the tests'), { mode: 'agent' }, 0);
    const send = env.dispatcher();
    cleanups.push(() => send.close());
    send.kick();
    await waitFor(() => expect(env.store.getRun(run.id).native).toMatchObject({ delivery: 'observed', nativeMessageId: '7:0', nativeTurnId: 'req-2' }));
    expect(env.store.getRun(run.id).native?.baselineSequence).toBe(2);
  });
});
