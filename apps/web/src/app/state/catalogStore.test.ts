import { afterEach, expect, it, vi } from 'vitest';
import { createCatalogStore } from './catalogStore';

afterEach(() => vi.unstubAllGlobals());

it.each(['', 'linked'])('reads the target again when its previous probe predates an install (%s)', async serverId => {
  const base = serverId ? '/api/servers/linked' : '/api';
  const entry = { backendId: 'pi', label: 'pi', profiles: [], models: [], capabilities: {} };
  let finishFirst!: (response: Response) => void;
  const stale = new Promise<Response>(resolve => { finishFirst = resolve; });
  const recheck = vi.fn()
    .mockReturnValueOnce(stale)
    .mockResolvedValueOnce(Response.json([{ ...entry, available: true }]));
  vi.stubGlobal('fetch', (path: string) => {
    if (path === base + '/backends?recheckMissing=1') return recheck();
    if (path === base + '/settings') return Promise.resolve(Response.json({}));
    throw new Error('Unexpected request ' + path);
  });
  const store = createCatalogStore({ offline: () => false });
  const first = store.recheckBackends(serverId);
  await vi.waitFor(() => expect(recheck).toHaveBeenCalledTimes(1));
  const reopened = store.recheckBackends(serverId);
  finishFirst(Response.json([{ ...entry, available: false, cliMissing: true }]));
  await Promise.all([first, reopened]);
  expect(recheck).toHaveBeenCalledTimes(2);
  const entries = serverId ? store.get().remoteBackends[serverId] : store.get().backends;
  expect(entries).toEqual([{ ...entry, available: true }]);
});
