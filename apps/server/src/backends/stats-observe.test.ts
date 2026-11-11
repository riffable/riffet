import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeWorkbenchEvent, Session } from '../../../../packages/contracts/src/index.js';
import { JournalFeed } from '../journal/feed.js';
import { JournalLaneWriter } from '../journal/ingest.js';
import { Journal } from '../journal/journal.js';
import type { Store } from '../store.js';
import type { NativeBackendDriver, NativeBackendTraits } from './types.js';
import { NativeBackendService } from './service.js';
import { CLAUDE_TRAITS } from './claude/index.js';

/** The traits the Cursor plugin declares (`plugins/riffet/cursor/backend.ts`); the service reads traits, never a backend id. */
const CURSOR_TRAITS: NativeBackendTraits = { settlesSlashOnSubmit: true, untaggedEcho: true, reportsTurnOutcome: true, ownsSessionObservation: true, resumesByNativeId: true, terminalName: 'Cursor' };

const at = '2026-10-04T05:00:00.000Z';
const call = (id: string, status: string, turn = 't1'): NativeWorkbenchEvent => ({ sequence: 0, sessionId: 'session-a', type: 'tool_call', nativeId: id, nativeTurnId: turn, data: { toolCallId: id, status }, createdAt: at });

/** A service whose transcript reaches it only through the journal, and whose v2 pump a test drives. */
function harness(backendId: 'claude' | 'cursor') {
  const observed: NativeWorkbenchEvent[][] = [];
  let failObserve = false;
  const current = { id: 'session-a', projectId: 'project-a', kind: 'native', backendId, state: 'running', title: 'session', tags: [] } as unknown as Session;
  const driver = {
    id: backendId,
    traits: backendId === 'cursor' ? CURSOR_TRAITS : CLAUDE_TRAITS,
    profiles: () => [{ id: 'local', backendId, name: 'Local', isDefault: true, config: {} }],
    status: () => ({ phase: 'idle' as const }),
    subscribe: (_host: unknown, _session: Session) => () => undefined,
  } as unknown as NativeBackendDriver;
  const journal = new Journal(new DatabaseSync(':memory:'));
  const feed = new JournalFeed(journal);
  const service = new NativeBackendService({
    store: { getSession: () => current, updateSession: () => current, appendEvent: () => undefined, listTerminals: () => [], getProject: () => ({ id: 'project-a', cwd: '/repo', name: 'project' }) } as unknown as Store,
    workspace: {} as never,
    terminal: { get: async () => { throw new Error('none'); }, screen: async () => undefined } as never,
    runtime: { withSession: async <T>(_id: string, operation: () => Promise<T> | T) => await operation() } as never,
    registry: { require: () => driver, list: () => [driver] } as never,
    stats: {
      recordUsage: () => undefined,
      observeEvents: (_sessionId, events) => {
        if (failObserve) throw new Error('sink failed');
        observed.push([...events]);
      },
    },
  });
  const off = service.readJournal(feed);
  return { service, observed, journal, feed, writer: JournalLaneWriter.open(journal, 'session-a'), fail: () => { failObserve = true; }, close: () => { off(); feed.close(); } };
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('statistics read from the journal', () => {
  it('observes the tool calls every lane serves, each new version once', async () => {
    const built = harness('claude');
    cleanups.push(built.close, () => built.service.closeAll().catch(() => undefined));
    built.writer.commit({ events: [call('tool-1', 'in_progress')], cursor: '1' });
    built.writer.child('tool-1', 'agent-1').commit({ events: [call('child-tool', 'completed', 'c1')], cursor: '1' });
    // A replay writes nothing, so nothing is observed again; a new state is a new version.
    built.writer.commit({ events: [call('tool-1', 'in_progress')], cursor: '1' });
    built.writer.commit({ events: [call('tool-1', 'failed')], cursor: '2' });
    await settle();
    const seen = built.observed.flat().map(event => `${event.nativeId}:${String(event.data.status)}`);
    expect(seen.filter(id => id.startsWith('tool-1'))).toEqual(['tool-1:in_progress', 'tool-1:failed']);
    expect(seen.filter(id => !id.startsWith('tool-1'))).toEqual(['child-tool:completed']);
  });

  it('skips history imported beneath a scratch window: only what the lane serves', async () => {
    const built = harness('claude');
    cleanups.push(built.close);
    built.writer.openScratch().commit({ events: [call('tail-tool', 'completed', 't9')], cursor: 'tail' });
    built.writer.commit({ events: [call('old-tool', 'completed')], cursor: '1' });
    await settle();
    expect(built.observed.flat().map(event => event.nativeId)).toEqual(['tail-tool']);
  });

  it('leaves Cursor to its own service, and a failing sink to itself', async () => {
    const cursor = harness('cursor');
    cleanups.push(cursor.close);
    cursor.writer.commit({ events: [call('tool-1', 'completed')], cursor: '1' });
    await settle();
    expect(cursor.observed).toEqual([]);

    const claude = harness('claude');
    cleanups.push(claude.close);
    claude.fail();
    const heard: string[] = [];
    cleanups.push(claude.feed.subscribe(() => true, batch => heard.push(batch.lane)));
    expect(() => claude.writer.commit({ events: [call('tool-1', 'completed')], cursor: '1' })).not.toThrow();
    await settle();
    expect(heard).toEqual(['main']);
  });
});
