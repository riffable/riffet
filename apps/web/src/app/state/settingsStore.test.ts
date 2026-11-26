import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, AppSettingsUpdate } from '@contracts';
import { api } from '@/lib/api';
import { moveSidebarPinned, toggleSidebarPinned } from '../sidebarDestinations';
import { createSettingsStore } from './settingsStore';

/** A server that applies each PATCH to what it holds, one request at a time. */
function fakeServer(initial: AppSettings) {
  let server = initial;
  const bodies: AppSettingsUpdate[] = [];
  vi.spyOn(api, 'updateSettings').mockImplementation(async (body) => {
    bodies.push(body);
    await Promise.resolve();
    server = { ...server, ...(body as AppSettings) };
    return server;
  });
  return { bodies, current: () => server };
}

function pendingResponse() {
  let resolve!: (value: AppSettings) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<AppSettings>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.restoreAllMocks());

describe('settings store write queue', () => {
  it('marks settings loaded only after the server provides them', () => {
    const store = createSettingsStore({ sidebarPinned: ['assistant'] });
    expect(store.get().loaded).toBe(false);
    const settings = { sidebarPinned: ['tasks'] };
    store.absorb(settings, store.bootstrapRevision());
    expect(store.get()).toMatchObject({ settings, loaded: true });
  });

  it('builds each backend-defaults write from the latest defaults, so quick saves do not overwrite each other', async () => {
    const server = fakeServer({});
    const store = createSettingsStore({});
    await Promise.all([
      store.updateBackendDefaults('claude', (current) => ({ ...current, approval: 'auto' })),
      store.updateBackendDefaults('codex', (current) => ({ ...current, approval: 'ask' })),
    ]);
    expect(server.current().nativeBackendDefaults).toEqual({ claude: { approval: 'auto' }, codex: { approval: 'ask' } });
    expect(store.current().nativeBackendDefaults).toEqual(server.current().nativeBackendDefaults);
  });

  it('coalesces rapid optimistic selections into the newest write without losing earlier ones', async () => {
    const server = fakeServer({});
    const store = createSettingsStore({});
    store.remember('claude', { model: 'opus[effort=high,fast=true]' }, true);
    store.remember('codex', { model: 'gpt-6[effort=high,fast=false]' });
    store.remember('codex', { model: 'gpt-6[effort=xhigh,fast=false]' });
    await vi.waitFor(() => expect(server.bodies.length).toBeGreaterThan(0));
    const expected = { defaultBackendId: 'claude', nativeBackendDefaults: { claude: { model: 'opus[effort=high,fast=true]' }, codex: { model: 'gpt-6[effort=xhigh,fast=false]' } } };
    expect(server.bodies.at(-1)).toMatchObject(expected);
    expect(createSettingsStore(server.current()).current()).toMatchObject(expected);
  });

  it('combines sidebar changes, retains unavailable slots, and skips unchanged drops', async () => {
    const initial = { sidebarPinned: ['assistant', 'activity', 'tasks', 'plugins', 'other/hidden'] };
    const { bodies, current } = fakeServer(initial);
    const store = createSettingsStore(initial);
    const offered = ['assistant', 'tasks', 'plugins', 'studio/workbench'];

    expect(await store.updateSidebarPinned((saved) => moveSidebarPinned(saved, offered, 'assistant', 'assistant'))).toBe(false);
    await store.updateSidebarPinned((saved) => moveSidebarPinned(saved, offered, 'assistant', 'tasks'));
    await store.updateSidebarPinned((saved) => moveSidebarPinned(saved, offered, 'plugins', null));
    expect(bodies).toEqual([]);

    const pin = store.updateSidebarPinned((saved) => moveSidebarPinned(saved, offered, 'studio/workbench', 'assistant'));
    const reorder = store.updateSidebarPinned((saved) => moveSidebarPinned(saved, offered, 'tasks', 'studio/workbench'));
    const unpin = store.updateSidebarPinned((saved) => toggleSidebarPinned(saved, 'plugins', false));
    const expected = ['tasks', 'activity', 'studio/workbench', 'assistant', 'other/hidden'];
    expect(store.get().sidebarPinnedDraft).toEqual(expected);
    expect(store.current()).toBe(initial);
    expect(await Promise.all([pin, reorder, unpin])).toEqual([false, false, true]);
    expect(bodies).toEqual([{ sidebarPinned: expected }]);
    expect(store.current()).toEqual(current());
    expect(store.get().sidebarPinnedDraft).toBeUndefined();
  });

  it('restores the last saved sidebar order after a later write fails and ignores stale bootstrap reads', async () => {
    const initial = { sidebarPinned: ['assistant', 'tasks'] };
    const store = createSettingsStore(initial);
    const firstResponse = pendingResponse();
    const secondResponse = pendingResponse();
    const update = vi.spyOn(api, 'updateSettings')
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);

    const beforeWrites = store.bootstrapRevision();
    const first = store.updateSidebarPinned(() => ['tasks', 'assistant']);
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const second = store.updateSidebarPinned(() => ['tasks', 'assistant', 'plugins']);
    const whileWriting = store.bootstrapRevision();
    store.absorb(initial, beforeWrites);
    expect(store.get().sidebarPinnedDraft).toEqual(['tasks', 'assistant', 'plugins']);

    const committed = { sidebarPinned: ['tasks', 'assistant'] };
    firstResponse.resolve(committed);
    await first;
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    const rejected = expect(second).rejects.toThrow('save failed');
    secondResponse.reject(new Error('save failed'));
    await rejected;
    expect(store.get().sidebarPinnedDraft).toBeUndefined();
    expect(store.current()).toEqual(committed);

    store.absorb(initial, whileWriting);
    expect(store.current()).toEqual(committed);
    const external = { sidebarPinned: ['plugins'] };
    store.absorb(external, store.bootstrapRevision());
    expect(store.current()).toEqual(external);
  });

  it('coalesces team member reorder writes and ignores stale bootstrap reads', async () => {
    const initial = { teamMemberOrder: ['a', 'b', 'c'] };
    const { bodies, current } = fakeServer(initial);
    const store = createSettingsStore(initial);
    const beforeWrites = store.bootstrapRevision();

    const first = store.updateTeamMemberOrder(() => ['b', 'a', 'c']);
    const second = store.updateTeamMemberOrder(() => ['c', 'b', 'a']);
    expect(store.get().teamMemberOrderDraft).toEqual(['c', 'b', 'a']);
    store.absorb(initial, beforeWrites);
    expect(store.current().teamMemberOrder).toEqual(['a', 'b', 'c']);
    expect(store.get().teamMemberOrderDraft).toEqual(['c', 'b', 'a']);

    expect(await Promise.all([first, second])).toEqual([false, true]);
    expect(bodies).toEqual([{ teamMemberOrder: ['c', 'b', 'a'] }]);
    expect(store.current()).toEqual(current());
    expect(store.get().teamMemberOrderDraft).toBeUndefined();
  });
});
