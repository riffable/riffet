import { afterEach, expect, it, vi } from 'vitest';
import type { NativeStatus, NativeWorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import { NativeEventLog } from '../journal/native-log.js';
import { assistantSearch } from '../search/assistant-search.js';
import { Store } from '../store.js';
import { AssistantBoard } from './assistant.js';
import { WorkItemService } from './service.js';

const stores: Store[] = [];
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const store = new Store(':memory:');
  stores.push(store);
  const workItems = new WorkItemService(store);
  const statuses = new Map<string, NativeStatus>();
  const transcript = vi.fn(async (): Promise<NativeWorkbenchEvent[] | undefined> => undefined);
  const board = new AssistantBoard({
    store, workItems, defaultBackend: () => 'codex', transcript, search: assistantSearch,
    runtimeSessionIds: () => statuses.keys(), runtimeStatus: id => statuses.get(id), backends: async () => [], automations: () => [],
  });
  const project = store.createProject('/tmp/riffet-assistant-tests', 'Work');
  const session = store.createSession({ projectId: project.id, kind: 'native', title: 'Work session', backendId: 'codex' });
  return { store, workItems, board, statuses, project, session, transcript };
}

it('pages every visible pending decision, merging a task question only with the same native interaction', () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-12-01T12:00:00.000Z'));
  const { store, workItems, board, statuses, project, session } = fixture();
  const item = workItems.create({ title: 'Blocked', projectId: project.id, status: 'doing' });
  workItems.attachSession(session.id, item.id);
  const asked = workItems.ask(session.id, { question: 'Choose a branch' });
  const other = store.createSession({ projectId: project.id, kind: 'native', title: 'Separate approval' });
  const hiddenProject = store.updateProject(store.createProject('/tmp/riffet-assistant-tests-archived', 'Archived').id, { archivedAt: asked.at });
  const hidden = store.createSession({ projectId: hiddenProject.id, kind: 'native', title: 'Hidden' });
  store.updateSession(hidden.id, { state: 'waiting' });
  const hiddenItem = workItems.create({ projectId: hiddenProject.id, title: 'Hidden task' });
  workItems.markStuck(hiddenItem.id, 'Do not include');
  const review = workItems.create({ title: 'Delivery' });
  workItems.patch(review.id, { status: 'review' });
  workItems.markStuck(item.id, 'The follow-up could not proceed');
  const interaction = { id: 'verified', revision: '1', requestId: asked.id, title: 'Choose', message: 'The actual waiting reason', options: [], actions: [] };
  statuses.set(session.id, { phase: 'attention', interaction: { ...interaction, kind: 'question' } });
  statuses.set(other.id, { phase: 'attention', interaction: { ...interaction, kind: 'permission' } });

  const seen: Array<{ id: string; kind: string }> = [];
  let cursor: string | undefined;
  do {
    const result = board.readAttention({ cursor, limit: 1 }) as { items: typeof seen; nextCursor?: string };
    expect(result.items).toHaveLength(1);
    seen.push(...result.items);
    cursor = result.nextCursor;
  } while (cursor && seen.length < 6);
  expect(seen.map(entry => entry.kind).sort()).toEqual(['session_waiting', 'task_question', 'task_review', 'task_stuck']);
  expect(new Set(seen.map(entry => entry.id)).size).toBe(seen.length);
  expect(seen.find(entry => entry.kind === 'session_waiting')).toMatchObject({ session: { id: other.id }, waiting: { kind: 'permission', message: interaction.message } });
  expect(seen.find(entry => entry.kind === 'task_question')).toMatchObject({ questionId: asked.id, session: { id: session.id } });

  statuses.set(session.id, { phase: 'attention', interaction: { ...interaction, kind: 'plan' } });
  expect(board.readAttention({}).items).toContainEqual(expect.objectContaining({ kind: 'session_waiting', session: expect.objectContaining({ id: session.id }), waiting: expect.objectContaining({ kind: 'plan' }) }));
  statuses.delete(session.id);
  expect(board.readAttention({}).items).toContainEqual(expect.objectContaining({ kind: 'task_question', questionId: asked.id }));
});

it('excludes hidden history before either search limit and reads only bounded transcript excerpts', async () => {
  const { store, board, project, session, transcript } = fixture();
  const quick = store.updateProject(store.createProject('/tmp/riffet-assistant-tests-quick', 'Quick').id, { system: 'quick-chat' });
  const chat = store.createSession({ projectId: quick.id, kind: 'native', backendId: 'codex' });
  const run = store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex' });
  store.updateSession(run.id, { origin: { kind: 'assistant' } });
  store.createRun(session.id, 'visible', 'searchneedle visible prompt');
  store.createRun(chat.id, 'chat', 'searchneedle hidden chat');
  store.createRun(run.id, 'assistant-run', 'searchneedle hidden assistant run');
  store.indexMessages([
    { sessionId: session.id, messageId: 'answer', kind: 'assistant', text: 'indexneedle visible answer', at: '2026-12-01T12:00:00.000Z' },
    { sessionId: chat.id, messageId: 'answer', kind: 'assistant', text: 'indexneedle hidden chat', at: '2026-12-01T12:01:00.000Z' },
    { sessionId: run.id, messageId: 'answer', kind: 'assistant', text: 'indexneedle hidden assistant run', at: '2026-12-01T12:02:00.000Z' },
  ]);
  for (const query of ['searchneedle', 'indexneedle']) {
    expect(await board.call('history_search', { query, limit: 1 })).toMatchObject({ hits: [{ session: session.id }] });
  }
  await expect(board.call('session_read', { session: chat.id })).rejects.toThrow('no readable conversation');
  expect(transcript).not.toHaveBeenCalled();

  const log = new NativeEventLog(store.journal, session.id);
  const event = (nativeId: string, text: string, type: 'user_message_chunk' | 'agent_message_chunk'): NativeWorkbenchEvent => ({
    type, sequence: 0, nativeId, sessionId: session.id, createdAt: '2026-12-01T12:00:00.000Z', data: { content: { type: 'text', text } },
  });
  log.assign(event('old', 'old message', 'user_message_chunk'));
  log.assign(event('new', 'a'.repeat(100_000), 'agent_message_chunk'));
  const getBlob = vi.spyOn(store.journal, 'getBlob');
  expect(await board.call('session_read', { session: session.id, limit: 1 })).toMatchObject({
    messages: [{ role: 'assistant', text: `${'a'.repeat(2000)}… [truncated]` }],
  });
  expect(getBlob).not.toHaveBeenCalled();
});
