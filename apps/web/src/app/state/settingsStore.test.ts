import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, AppSettingsUpdate } from '@contracts';
import { api } from '@/lib/api';
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

afterEach(() => vi.restoreAllMocks());

describe('settings store write queue', () => {
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
});
