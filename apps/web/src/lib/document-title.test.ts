import { expect, it, vi } from 'vitest';
import type { Session } from '@contracts';
import { createListsStore } from '@/app/state/listsStore';
import { createSettingsStore } from '@/app/state/settingsStore';
import { selectSidebarSessions } from '@/app/useSidebarSessions';
import type { ListCache } from './list-cache';
import { api, type Bootstrap, type ProjectRecord } from './api';
import { sidebarProjectMap } from './project-family';
import { forgetServer, locate } from './server-routing';

const start = '2026-11-23T08:00:00.000Z';
const end = '2026-11-23T08:01:00.000Z';
const read = '2026-11-23T08:02:00.000Z';
const finished: Session = {
  id: 'conversation', projectId: 'project', kind: 'native', title: 'Task', tags: [], mode: 'agent', state: 'idle',
  createdAt: start, lastActivityAt: end, seenActivityAt: start, updatedAt: end,
};
const snapshot: Bootstrap = { sessions: [finished], projects: [], terminals: [], settings: {}, csrfToken: '' };
const project: ProjectRecord = { id: finished.projectId, name: 'Project', cwd: '/project', createdAt: start, updatedAt: start };
const selection = { serverFilter: 'relevant', selfServerId: 'devbox', selectedSessionId: '', showArchived: false, filterTag: '', unreadOnly: true };
const visibleProjects = sidebarProjectMap([project], false);

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

it('scopes unread results to the selected server filter and includes work launched from this server by default', () => {
  const macProject = { ...project, id: 'mac-project' };
  const peerProject = { ...project, id: 'peer-project' };
  const fromMac: Session = { ...finished, id: 'mac-conversation', projectId: macProject.id };
  const fromDevbox: Session = { ...fromMac, id: 'devbox-launch', origin: { kind: 'link', serverId: 'devbox' } };
  const fromPeer: Session = {
    ...finished, id: 'peer-conversation', projectId: peerProject.id, origin: { kind: 'link', serverId: 'mac' },
  };
  const sessions = [finished, fromMac, fromDevbox, fromPeer];
  const projects = sidebarProjectMap([project, macProject, peerProject], false);
  locate([macProject.id, fromMac.id, fromDevbox.id], 'mac');
  locate([peerProject.id, fromPeer.id], 'peer');
  try {
    for (const [serverFilter, expected] of [
      ['relevant', [finished, fromDevbox]],
      ['local', [finished]],
      ['mac', [fromMac, fromDevbox]],
      ['all', sessions],
    ] as const) {
      const result = selectSidebarSessions(sessions, projects, { ...selection, serverFilter });
      expect(result.rows).toEqual(expected);
      expect(result.unreadCount).toBe(expected.length);
    }
    const opened = selectSidebarSessions([fromMac], projects, { ...selection, selectedSessionId: fromMac.id });
    expect(opened.rows).toEqual([fromMac]);
    expect(opened.unreadCount).toBe(0);
  } finally {
    forgetServer('mac');
    forgetServer('peer');
  }
});

it('counts only unread results within the sidebar filters', () => {
  const waiting: Session = { ...finished, id: 'question', state: 'waiting', tags: ['one'] };
  const tagged: Session = { ...finished, id: 'tagged', tags: ['one'] };
  const hiddenProject = { ...project, id: 'archived-project', archivedAt: read };
  const checkout = { ...project, id: 'checkout', worktree: { originProjectId: hiddenProject.id, branch: 'task' } };
  const sessions: Session[] = [
    finished,
    tagged,
    waiting,
    { ...finished, id: 'archived', archivedAt: read, tags: ['one'] },
    { ...finished, id: 'hidden-project-result', projectId: checkout.id, tags: ['one'] },
    { ...finished, id: 'legacy', seenActivityAt: undefined, tags: ['one'] },
    { ...finished, id: 'discussion', backendId: 'chat', origin: { kind: 'discussion' }, tags: ['one'] },
    { ...finished, id: 'called-agent', origin: { kind: 'call', sessionId: finished.id }, tags: ['one'] },
  ];
  const projects = sidebarProjectMap([project, hiddenProject, checkout], false);
  const allRows = selectSidebarSessions(sessions, projects, { ...selection, filterTag: 'one', unreadOnly: false });
  expect(allRows.rows).toContain(waiting);
  expect(allRows.unreadCount).toBe(1);
  const onlyUnread = selectSidebarSessions(sessions, projects, { ...selection, filterTag: 'one' });
  expect(onlyUnread.rows).toEqual([tagged]);
  expect(onlyUnread.unreadCount).toBe(1);
  const includingArchivedProjects = selectSidebarSessions(sessions, sidebarProjectMap([project, hiddenProject, checkout], true), {
    ...selection, filterTag: 'one', showArchived: true,
  });
  expect(includingArchivedProjects.rows.map((session) => session.id)).toEqual(['tagged', 'hidden-project-result']);
  expect(includingArchivedProjects.unreadCount).toBe(2);
});

it('keeps the latest result and read position when session frames race a read on another device', () => {
  const lists = createTestLists();
  lists.set({ loaded: true, sessions: [finished] });
  const count = () => selectSidebarSessions(lists.get().sessions, visibleProjects, selection).unreadCount;
  expect(count()).toBe(1);
  lists.upsertSession({ ...finished, seenActivityAt: end, updatedAt: read });
  lists.upsertSession({ ...finished, state: 'waiting' });
  expect(lists.get().sessions[0]?.state).toBe('idle');
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
