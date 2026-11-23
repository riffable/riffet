import { expect, it, vi } from 'vitest';
import type { Session } from '@contracts';
import { createListsStore } from '@/app/state/listsStore';
import { createSettingsStore } from '@/app/state/settingsStore';
import type { ListCache } from './list-cache';
import { api, type Bootstrap } from './api';
import { countAttention } from './document-title';

const start = '2026-11-23T08:00:00.000Z';
const end = '2026-11-23T08:01:00.000Z';
const read = '2026-11-23T08:02:00.000Z';
const finished: Session = {
  id: 'conversation', projectId: 'project', kind: 'native', title: 'Task', tags: [], mode: 'agent', state: 'idle',
  createdAt: start, lastActivityAt: end, seenActivityAt: start, updatedAt: end,
};
const snapshot: Bootstrap = { sessions: [finished], projects: [], terminals: [], settings: {}, csrfToken: '' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function createTestLists(cache?: ListCache) {
  return createListsStore({
    settings: createSettingsStore({}), selectedSessionId: () => '', handlers: { selectSession() {}, reload() {} },
    cache: cache ?? { load: () => undefined, save() {}, refresh() {}, clear() {}, retire() {} },
  });
}

it('counts a missed completion on sync and keeps a pending question after its messages have been read', () => {
  const waiting: Session = { ...finished, id: 'question', state: 'waiting', seenActivityAt: end };
  expect(countAttention([waiting])).toBe(1);
  expect(countAttention([waiting, finished])).toBe(2);
  expect(countAttention([waiting, { ...finished, seenActivityAt: end }])).toBe(1);
  expect(countAttention([{ ...waiting, state: 'running' }, { ...finished, seenActivityAt: end }])).toBe(0);
  expect(countAttention([
    { ...waiting, archivedAt: read },
    { ...finished, id: 'background', origin: { kind: 'assistant' } },
    { ...finished, id: 'seat', origin: { kind: 'council' } },
    { ...finished, id: 'discussion', origin: { kind: 'discussion' } },
    { ...finished, id: 'legacy', seenActivityAt: undefined },
  ])).toBe(0);
});

it('keeps the latest result and read position when session frames race a read on another device', () => {
  const lists = createTestLists();
  lists.set({ loaded: true, sessions: [finished] });
  const count = () => countAttention(lists.get().sessions);
  expect(count()).toBe(1);
  lists.upsertSession({ ...finished, seenActivityAt: end, updatedAt: read });
  lists.upsertSession({ ...finished, state: 'waiting' });
  expect(count()).toBe(0);
  lists.upsertSession({ ...finished, updatedAt: read });
  expect(count()).toBe(0);
  lists.upsertSession({ ...finished, lastActivityAt: read, updatedAt: read });
  expect(count()).toBe(1);
  expect(lists.get().sessions[0]?.seenActivityAt).toBe(end);
});

it('keeps a read received during bootstrap and takes visibility and unchanged rows from the server', async () => {
  const stale: Session = { ...finished, id: 'stale', state: 'waiting', updatedAt: read };
  const hidden: Session = { ...finished, id: 'hidden' };
  const pending = deferred<Bootstrap>();
  const bootstrap = vi.spyOn(api, 'bootstrap').mockReturnValue(pending.promise);
  const save = vi.fn();
  try {
    const lists = createTestLists({ load: () => undefined, save, refresh() {}, clear() {}, retire() {} });
    lists.set({ loaded: true, sessions: [finished, stale, hidden] });
    const loading = lists.load();
    lists.upsertSession({ ...finished, seenActivityAt: end, updatedAt: read });
    lists.upsertSession({ ...hidden, state: 'waiting', updatedAt: read });
    pending.resolve({ ...snapshot, sessions: [finished, { ...stale, state: 'idle', updatedAt: start }] });

    const loaded = await loading;
    const sessions = lists.get().sessions;
    expect(sessions).toEqual([
      { ...finished, seenActivityAt: end, updatedAt: read },
      { ...stale, state: 'idle', updatedAt: start },
    ]);
    expect(loaded.sessions).toBe(sessions);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ sessions }));
  } finally {
    bootstrap.mockRestore();
  }
});

it('ignores superseded bootstrap and delta responses after a fresh bootstrap has been applied', async () => {
  const staleBootstrap = deferred<Bootstrap>();
  const staleDelta = deferred<Awaited<ReturnType<typeof api.sessionsSince>>>();
  const sync = (revision: number): Bootstrap => ({
    ...snapshot, protocol: { version: 1, features: ['list-delta'] }, revisions: { sessions: revision, projects: 1, terminals: 1 },
  });
  vi.spyOn(api, 'bootstrap').mockResolvedValueOnce(sync(1)).mockReturnValueOnce(staleBootstrap.promise).mockResolvedValueOnce(sync(3));
  const sessionsSince = vi.spyOn(api, 'sessionsSince').mockReturnValueOnce(staleDelta.promise).mockResolvedValue({ unchanged: true });
  const stream = Object.assign(new EventTarget(), { close() {} });
  vi.stubGlobal('EventSource', function () { return stream; });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setInterval, clearInterval, setTimeout, clearTimeout }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));

  const lists = createTestLists();
  let disconnect: (() => void) | undefined;
  try {
    await lists.load();
    disconnect = lists.connect();
    stream.dispatchEvent(new MessageEvent('changed', { data: JSON.stringify({ revision: 2, terminals: 1 }) }));
    expect(sessionsSince).toHaveBeenCalledWith(1, 'W/"1"');

    const older = lists.load();
    const latest = await lists.load();
    staleBootstrap.resolve({ ...sync(2), sessions: [] });
    expect(await older).toBe(latest);
    staleDelta.resolve({ unchanged: false, etag: 'W/"2"', data: { revision: 2, sessions: [], removed: [finished.id] } });
    await vi.waitFor(() => expect(sessionsSince).toHaveBeenCalledWith(3, 'W/"3"'));
    expect(lists.get().sessions).toEqual([finished]);
  } finally {
    disconnect?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
