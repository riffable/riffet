import { describe, expect, it } from 'vitest';
import type { WorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import { Store } from '../store.js';
import { EMPTY_INDEX_MARKER, extractIndexable, likePattern } from './messages.js';

const answer = (sessionId: string, sequence: number, nativeId: string, text: string): WorkbenchEvent => ({
  sequence, sessionId, type: 'agent_message_chunk', nativeId, createdAt: new Date(sequence * 1000).toISOString(),
  data: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
} as WorkbenchEvent);

function fixture() {
  const store = new Store(':memory:');
  const project = store.createProject('/tmp/riffet-search', 'riffet');
  const session = store.createSession({ projectId: project.id, kind: 'native', title: 'Build failing' });
  store.createRun(session.id, 'command-1', 'why does the build fail');
  return { store, project, session };
}

describe('message search', () => {
  it('finds a question from the persisted run, with enough to open it', () => {
    const { store, project, session } = fixture();
    const hits = store.searchPrompts(likePattern('build fail'), 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      sessionId: session.id, projectId: project.id, sessionTitle: 'Build failing',
      kind: 'user', text: 'why does the build fail', backendId: 'cursor', archived: false,
    });
  });

  it('treats the wildcards in a query as text, not as a pattern', () => {
    const { store } = fixture();
    store.createRun(store.listSessions()[0]!.id, 'command-2', 'raise the limit to 100%');
    expect(store.searchPrompts(likePattern('100%'), 10)).toHaveLength(1);
    // Only the run that really contains a `%` matches; an unescaped pattern would match every run.
    expect(store.searchPrompts(likePattern('%'), 10).map((hit) => hit.text)).toEqual(['raise the limit to 100%']);
  });

  it('finds an answer that was indexed, newest first', () => {
    const { store, session } = fixture();
    store.indexMessages(extractIndexable(session.id, [
      answer(session.id, 10, '10:answer:0', 'the bundler cache is stale'),
      answer(session.id, 11, '11:answer:0', 'the bundler config is wrong'),
    ]));
    const hits = store.searchIndexedMessages(likePattern('bundler'), 10);
    expect(hits.map((hit) => hit.text)).toEqual(['the bundler config is wrong', 'the bundler cache is stale']);
    expect(hits[0]).toMatchObject({ sessionId: session.id, kind: 'assistant', sessionTitle: 'Build failing' });
  });

  it('filters one conversation before limiting prompts and either index query path', () => {
    const { store, project, session } = fixture();
    const other = store.createSession({ projectId: project.id, kind: 'native', title: 'Other build' });
    store.createRun(other.id, 'command-other', 'why does the build fail elsewhere');
    store.indexMessages([
      ...extractIndexable(session.id, [answer(session.id, 10, '10:answer:0', 'the bundler cache is stale')]),
      ...extractIndexable(other.id, [answer(other.id, 20, '20:answer:0', 'the bundler config is wrong')]),
    ]);
    expect(store.searchPrompts(likePattern('build'), 1, session.id).map(hit => hit.sessionId)).toEqual([session.id]);
    for (const query of ['bundler', 'b']) {
      expect(store.searchIndexedMessages(likePattern(query), 1, session.id).map(hit => hit.sessionId)).toEqual([session.id]);
      expect(store.searchIndexedMessages(likePattern(query), 1, 'missing')).toEqual([]);
    }
  });

  it('replaces a message it indexes again instead of storing a second copy', () => {
    const { store, session } = fixture();
    store.indexMessages(extractIndexable(session.id, [answer(session.id, 10, '10:answer:0', 'first version of the answer')]));
    store.indexMessages(extractIndexable(session.id, [answer(session.id, 10, '10:answer:0', 'revised answer')]));
    expect(store.searchIndexedMessages(likePattern('answer'), 10)).toHaveLength(1);
    expect(store.searchIndexedMessages(likePattern('revised'), 10)[0]!.text).toBe('revised answer');
    expect(store.searchIndexedMessages(likePattern('first version'), 10)).toHaveLength(0);
  });

  it('reports which conversations still have nothing indexed, and only for providers it may read', () => {
    const { store, project, session } = fixture();
    const codex = store.createSession({ projectId: project.id, kind: 'native', title: 'Codex one', backendId: 'codex' });
    expect(store.countSessionsMissingMessages(['cursor'])).toBe(1);
    expect(store.countSessionsMissingMessages(['cursor', 'codex'], session.id)).toBe(1);
    expect(store.countSessionsMissingMessages(['cursor'], codex.id)).toBe(0);
    expect(store.sessionsMissingMessages(['cursor', 'codex'], 1, session.id).map((item) => item.id)).toEqual([session.id]);
    expect(store.sessionsMissingMessages(['cursor', 'codex'], 1, 'missing')).toEqual([]);
    expect(store.sessionsMissingMessages(['cursor'], 10).map((item) => item.id)).toEqual([session.id]);

    store.indexMessages(extractIndexable(session.id, [answer(session.id, 10, '10:answer:0', 'indexed now')]));
    expect(store.countSessionsMissingMessages(['cursor'])).toBe(0);
    expect(store.countSessionsMissingMessages(['cursor', 'codex'], session.id)).toBe(0);
    // A provider the index may not read is not reported as pending, so nothing waits on it forever.
    expect(store.countSessionsMissingMessages(['cursor', 'codex'])).toBe(1);
    expect(store.sessionsMissingMessages(['cursor', 'codex'], 10).map((item) => item.id)).toEqual([codex.id]);
  });

  it('keeps a hit for a conversation that was archived, and says so', () => {
    const { store, session } = fixture();
    store.updateSession(session.id, { archivedAt: new Date().toISOString() });
    expect(store.searchPrompts(likePattern('build fail'), 10)[0]).toMatchObject({ archived: true });
  });

  it('stops calling a conversation missing once it was read and had nothing to index', () => {
    const { store, session } = fixture();
    // What the endpoint records for a conversation whose transcript came back empty; without it the
    // conversation stays "missing" and every search keeps re-reading it.
    store.indexMessages([{ sessionId: session.id, messageId: EMPTY_INDEX_MARKER, kind: 'tool', text: '', at: new Date().toISOString() }]);
    expect(store.countSessionsMissingMessages(['cursor'])).toBe(0);
    // ...and the marker itself can never be returned as a result.
    expect(store.searchIndexedMessages(likePattern('riffet_none'), 10)).toEqual([]);
    expect(store.searchIndexedMessages(likePattern('a'), 10)).toEqual([]);
  });
});

describe('indexing a deleted conversation', () => {
  it('skips the row instead of failing the batch', () => {
    const { store, session } = fixture();
    const rows = extractIndexable(session.id, [answer(session.id, 10, '10:answer:0', 'answer')]);
    const orphan = { ...rows[0]!, sessionId: 'session-that-does-not-exist' };
    expect(() => store.indexMessages([orphan, ...rows])).not.toThrow();
    expect(store.searchIndexedMessages(likePattern('answer'), 10)).toHaveLength(1);
  });
});
