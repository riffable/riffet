import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNavStore, NO_PAGE, STORAGE_KEYS } from './navStore';

beforeEach(() => {
  vi.stubGlobal('window', { location: { pathname: '/', search: '', hash: '' } });
});
afterEach(() => vi.unstubAllGlobals());

describe('automatic navigation receipt', () => {
  it('records a fresh opening intent when the same plugin configuration link is repeated', async () => {
    const nav = createNavStore();
    await nav.navigate(() => nav.openPlugins('riffet.cursor', 'riffet.cursor/providers'));
    const first = nav.get();
    const revision = nav.getNavigationRevision();
    await nav.navigate(() => nav.openPlugins('riffet.cursor', 'riffet.cursor/providers'));
    expect(nav.get()).toMatchObject({ pluginId: first.pluginId, pluginViewId: first.pluginViewId });
    expect(nav.get().pluginOpenRevision).toBeGreaterThan(first.pluginOpenRevision!);
    expect(nav.getNavigationRevision()).toBeGreaterThan(revision);
    nav.registerPluginBeforeLeave(async () => false);
    const refused = nav.get().pluginOpenRevision;
    expect(await nav.navigate(() => nav.openPlugins('riffet.cursor', 'riffet.cursor/providers'))).toBe(false);
    expect(nav.get().pluginOpenRevision).toBe(refused);
  });

  it('restores an explicit projectless choice independently from the selected conversation project', () => {
    const values = new Map<string, string>([[STORAGE_KEYS.project, 'conversation-project']]);
    vi.stubGlobal('window', { location: { pathname: '/', search: '', hash: '' }, localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } });
    const nav = createNavStore();
    expect(nav.get().taskProjectId).toBeUndefined();
    nav.rememberTaskProject('chosen-project');
    expect(createNavStore().get().taskProjectId).toBe('chosen-project');
    nav.rememberTaskProject(null);
    expect(createNavStore().get()).toMatchObject({ taskProjectId: null, projectId: 'conversation-project' });
  });

  it('cannot supersede a round trip through another page even when conversation IDs are unchanged', async () => {
    const nav = createNavStore();
    const started = nav.getNavigationRevision();
    const origin = { projectId: nav.get().projectId, sessionId: nav.get().sessionId };
    await nav.navigate(() => nav.openPage('stats'));
    nav.set(NO_PAGE);
    expect({ projectId: nav.get().projectId, sessionId: nav.get().sessionId }).toEqual(origin);
    expect(nav.getNavigationRevision()).toBeGreaterThan(started);
  });

  it('records newer intent while an editor declines leaving, without treating metadata as navigation', async () => {
    const nav = createNavStore();
    const baseline = nav.getNavigationRevision();
    nav.set({ projectVisits: { project: 1 } });
    expect(nav.getNavigationRevision()).toBe(baseline);
    nav.openPage('extensions');
    nav.registerBeforeLeave(async () => false);
    const started = nav.getNavigationRevision();
    const destination = vi.fn();
    expect(await nav.navigate(destination)).toBe(false);
    expect(destination).not.toHaveBeenCalled();
    expect(nav.get().extensionsOpen).toBe(true);
    expect(nav.getNavigationRevision()).toBeGreaterThan(started);
  });
});
