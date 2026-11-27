import { describe, expect, it } from 'vitest';
import { SESSION_MESSAGE_BUDGET, SESSION_MESSAGE_TOOL_GROUP, type NativeRunInput, type Session } from '../../../../packages/contracts/src/index.js';
import { Store } from '../store.js';
import { SessionMessageService } from './service.js';

const input = (text: string, references?: string[]): NativeRunInput => ({
  text, attachmentIds: [], context: [], ...(references ? { references: references.map(sessionId => ({ kind: 'session' as const, sessionId })) } : {}),
});

/** Conversations over an in-memory store; a message is queued in the receiver as the composer's send would. */
function harness() {
  const store = new Store(':memory:');
  const project = store.createProject('/tmp/session-messages', 'Example');
  const service = new SessionMessageService({
    store,
    directory: () => ({
      listedConversation: id => { try { return store.getSession(id); } catch { return undefined; } },
      messageList: (_args, keep) => ({ sessions: store.listSessions().filter(keep).map(session => session.id) }),
    }),
    deliver: async (sessionId, text, commandId) => ({ run: store.acceptNativeRun(sessionId, commandId, input(text), { mode: 'default' }), steered: false }),
    takesTools: async () => true,
  });
  const conversation = (title: string, extra: Partial<Session> = {}): Session => {
    const { session, run } = store.createNativeSubmission(crypto.randomUUID(), { projectId: project.id, title, backendId: 'claude', ...extra }, crypto.randomUUID(), input('hello'));
    store.updateRun(run.id, { state: 'completed' });
    return store.updateSession(session.id, { state: 'idle' });
  };
  /** The owner sends another message in `session`. */
  const owner = (session: Session, references?: string[]) => store.acceptNativeRun(session.id, crypto.randomUUID(), input('from the owner', references), { mode: 'default' });
  const send = (from: Session, to: Session, message = 'hold off main') => service.send(store.getSession(from.id), { session: to.id, message });
  return { store, service, conversation, owner, send };
}

describe('session messages', () => {
  it('reaches only conversations the owner referenced, granted, or that wrote first', async () => {
    const h = harness();
    const a = h.conversation('A'), b = h.conversation('B'), c = h.conversation('C');
    await expect(h.send(a, b)).rejects.toMatchObject({ code: 'SESSION_MESSAGE_NOT_ALLOWED' });
    h.owner(a, [b.id]);
    await expect(h.send(a, b)).resolves.toMatchObject({ delivery: 'queued', session: b.id });
    // B may answer A, which wrote to it, but not C.
    await expect(h.send(b, a, 'done')).resolves.toMatchObject({ delivery: 'queued' });
    await expect(h.send(b, c)).rejects.toMatchObject({ code: 'SESSION_MESSAGE_NOT_ALLOWED' });
    expect((h.service.list(h.store.getSession(b.id), {}) as { sessions: string[] }).sessions).toEqual([a.id]);
    // The grant opens every conversation; never itself, and never from a conversation a call opened.
    h.store.updateSession(c.id, { toolGroups: [SESSION_MESSAGE_TOOL_GROUP] });
    await expect(h.send(c, b)).resolves.toMatchObject({ delivery: 'queued' });
    await expect(h.send(c, c)).rejects.toMatchObject({ code: 'INVALID_SESSION_MESSAGE' });
    const called = h.conversation('Called', { origin: { kind: 'call', sessionId: a.id }, toolGroups: [SESSION_MESSAGE_TOOL_GROUP] });
    await expect(h.send(called, a)).rejects.toMatchObject({ code: 'TOOL_NOT_AVAILABLE' });
    // What B received names its sender, so its reply is addressed and the web client can show who wrote.
    const received = h.store.listRuns(b.id).filter(run => run.commandId.startsWith('peer-'));
    expect(received.map(run => run.commandId.endsWith(a.id) || run.commandId.endsWith(c.id))).toEqual([true, true]);
    expect(received[0]!.native!.input.text).toMatch(new RegExp(`^\\[Riffet 会话消息\\] 来自 claude 会话「A」（id ${a.id}）。`));
  });

  it('stops two Agents answering each other until the owner writes again', async () => {
    const h = harness();
    const a = h.conversation('A', { toolGroups: [SESSION_MESSAGE_TOOL_GROUP] }), b = h.conversation('B');
    for (let sent = 0; sent < SESSION_MESSAGE_BUDGET.autonomous; sent++) await h.send(a, b);
    await expect(h.send(a, b)).rejects.toMatchObject({ code: 'SESSION_MESSAGE_LIMIT' });
    // A turn a reply started is not the owner's: the count goes on.
    await h.send(b, a, 'ok');
    await expect(h.send(a, b)).rejects.toMatchObject({ code: 'SESSION_MESSAGE_LIMIT' });
    h.owner(a);
    await expect(h.send(a, b)).resolves.toMatchObject({ remaining: SESSION_MESSAGE_BUDGET.autonomous - 1 });
  });
});
