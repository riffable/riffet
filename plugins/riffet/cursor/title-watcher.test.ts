import type { AgentSessionView, AgentTerminalObservation } from '@riffet/plugin-api/experimental/agent';
import { describe, expect, it } from 'vitest';
import { cursorPort } from './host-port.js';
import { FakeHost } from './testing/fake-host.js';
import { ResumeTitleWatcher } from './title-watcher.js';

/** The test decides exactly which terminal chunks arrive. */
function fixture(title: string) {
  const session: AgentSessionView = { id: 's1', projectId: 'p1', title, state: 'running', mode: 'agent', resumePicker: true };
  const host = new FakeHost({ sessions: [session] });
  let observer: ((observation: AgentTerminalObservation) => void) | undefined;
  host.terminals.observe = (_id, callback) => { observer = callback; return () => { observer = undefined; }; };
  const watcher = new ResumeTitleWatcher({ port: cursorPort(host) });
  watcher.watch({ terminalId: 't1', sessionId: session.id, projectId: session.projectId });
  return { host, watcher, push: (data: string) => observer?.({ type: 'output', terminalId: 't1', data, sequence: 1 }) };
}

describe('ResumeTitleWatcher', () => {
  it('learns a labeled session id and derives a display title from the picker text', () => {
    const { host, watcher, push } = fixture('Untitled');
    push('session id: 8f14e45fceea167a\nRefactor the payment gateway\nPress enter to resume\n');
    expect(host.sessions.get('s1')).toMatchObject({ nativeSessionId: '8f14e45fceea167a', title: 'Refactor the payment gateway' });
    // One write, so a reader never sees the id without the title (or the other way round).
    expect(host.updates).toEqual([expect.objectContaining({ nativeSessionId: '8f14e45fceea167a', title: 'Refactor the payment gateway' })]);
    watcher.disposeAll();
  });

  it('never overwrites a title the user already set', () => {
    const { host, watcher, push } = fixture('My own title');
    push('session id: 8f14e45fceea167a\nRefactor the payment gateway\n');
    expect(host.sessions.get('s1')).toMatchObject({ nativeSessionId: '8f14e45fceea167a', title: 'My own title' });
    watcher.disposeAll();
  });

  it('ignores a stray unlabeled id so a picker artifact is never persisted', () => {
    const { host, watcher, push } = fixture('Untitled');
    push('8f14e45f-ceea-167a-8f14-e45fceea167a\nRefactor the payment gateway\n');
    expect(host.sessions.get('s1')?.nativeSessionId).toBeUndefined();
    watcher.disposeAll();
  });
});
