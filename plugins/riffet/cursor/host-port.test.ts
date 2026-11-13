import type { AgentSessionView } from '@riffet/plugin-api/experimental/agent';
import { describe, expect, it } from 'vitest';
import { cursorPort } from './host-port.js';
import { FakeHost } from './testing/fake-host.js';

describe('cursorPort.runIdForMessage', () => {
  it('asks the host once while a lookup is pending, then answers from what it found', async () => {
    const host = new FakeHost();
    let lookups = 0;
    host.runs.find = async () => { lookups += 1; return [{ id: 'run-1', sessionId: 'session-1', commandId: 'command-1', state: 'running', nativeMessageId: 'message-1' }]; };
    const port = cursorPort(host);

    expect(port.runIdForMessage('session-1', 'message-1')).toBeUndefined();
    expect(port.runIdForMessage('session-1', 'message-1')).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(port.runIdForMessage('session-1', 'message-1')).toBe('run-1');
    expect(lookups).toBe(1);
  });
});

describe('cursorPort.setNativeSessionId', () => {
  const session = (id: string, extra: Partial<AgentSessionView> = {}): AgentSessionView => ({ id, projectId: 'project-1', title: id, state: 'idle', mode: 'agent', ...extra });

  it('refuses a chat another live conversation owns before any write, and lets an archived owner go', () => {
    const host = new FakeHost({ sessions: [session('a', { nativeSessionId: 'chat-1' }), session('b'), session('c', { nativeSessionId: 'chat-2', archivedAt: '2026-01-01T00:00:00.000Z' })] });
    const port = cursorPort(host);

    expect(() => port.setNativeSessionId('b', 'chat-1')).toThrow(expect.objectContaining({ code: 'NATIVE_SESSION_ID_IN_USE' }));
    expect(host.sessions.get('b')?.nativeSessionId).toBeUndefined();
    expect(port.setNativeSessionId('b', 'chat-2').nativeSessionId).toBe('chat-2');
  });
});
