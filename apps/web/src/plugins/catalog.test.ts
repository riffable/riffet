import { describe, expect, it } from 'vitest';
import type { PluginDescriptor, ViewDeclaration } from '@contracts';
import { buildCatalog, matches, type DeclarativeRenderer } from './catalog';

const Canvas = () => null;
const Tasks: DeclarativeRenderer = () => null;
const view = (patch: Partial<ViewDeclaration> = {}): ViewDeclaration => ({ id: 'riffet.canvas/canvas', title: { en: 'Canvas' }, locations: ['session-view'], clients: ['web'], instances: 'per-session', ...patch });
const plugin = (views: ViewDeclaration[], enabled = true): PluginDescriptor => ({
  id: 'riffet.canvas', vendor: 'riffet', name: 'canvas', enabled, enablement: 'auto', settings: [], actions: [], contributes: {}, declared: { views },
});
const loaded = new Map([['riffet.canvas', { views: { 'riffet.canvas/canvas': Canvas }, icons: { 'riffet.canvas/canvas': 'graph' as const } }]]);
const ids = (descriptors: PluginDescriptor[], renderers = new Map<string, DeclarativeRenderer>(), plugins = loaded) =>
  buildCatalog({ descriptors, plugins, renderers, host: [], locale: 'en' }).map((entry) => entry.id);

describe('view catalog', () => {
  it('offers a plugin view only while its plugin is on, declares web, and something here draws it', () => {
    expect(ids([plugin([view()])])).toEqual(['riffet.canvas/canvas']);
    expect(ids([plugin([view()], false)])).toEqual([]);
    expect(ids([plugin([view({ clients: ['macos'] })])])).toEqual([]);
    expect(ids([plugin([view()])], new Map(), new Map())).toEqual([]);
  });

  it('keeps the slot of a view whose entry is still to load, drawing nothing and with the icon it last had', () => {
    const catalog = buildCatalog({ descriptors: [plugin([view()])], plugins: new Map(), pending: new Set(['riffet.canvas']), icons: { 'riffet.canvas/canvas': 'graph' }, renderers: new Map(), host: [], locale: 'en' });
    expect(catalog.map((entry) => [entry.id, entry.icon, entry.render])).toEqual([['riffet.canvas/canvas', 'graph', undefined]]);
    expect(buildCatalog({ descriptors: [plugin([view()])], plugins: new Map(), pending: new Set(), renderers: new Map(), host: [], locale: 'en' })).toEqual([]);
  });

  it('draws a declarative view by its renderer kind and leaves it out when no renderer is registered', () => {
    const tasks = view({ id: 'riffet.canvas/build', locations: ['sidebar'], renderer: { kind: 'tasks', provider: 'riffet.canvas/x' } });
    expect(ids([plugin([tasks])], new Map([['tasks', Tasks]]), new Map())).toEqual(['riffet.canvas/build']);
    expect(ids([plugin([tasks])], new Map(), new Map())).toEqual([]);
  });

  it('draws the views of a package that is not built in in an isolated frame, whatever the in-app entries hold', () => {
    const stats = view({ id: 'acme.stats/stats', locations: ['sidebar'] });
    const pack = (patch: Partial<PluginDescriptor>): PluginDescriptor => ({ ...plugin([stats]), id: 'acme.stats', source: 'development', webEntry: { path: 'web/index.js', integrity: 'sha256-aa' }, capabilities: ['sessions.read'], ...patch });
    const renders = (descriptor: PluginDescriptor, entries = new Map([['acme.stats', { views: { 'acme.stats/stats': Canvas } }]])) =>
      buildCatalog({ descriptors: [descriptor], plugins: entries, renderers: new Map(), host: [], locale: 'en' }).map((entry) => entry.render);
    expect(renders(pack({}))).toEqual([{ kind: 'isolated', source: expect.objectContaining({ pluginId: 'acme.stats', path: 'web/index.js', integrity: 'sha256-aa', capabilities: ['sessions.read'] }) }]);
    expect(renders(pack({ source: 'installed' }))[0]).toMatchObject({ kind: 'isolated' });
    // No script, no view; a package cannot reach the in-app SDK by being loaded; an unsupported SDK or an off plugin offers nothing.
    expect(renders(pack({ webEntry: undefined }))).toEqual([]);
    expect(renders(pack({ enabled: false }))).toEqual([]);
    expect(renders(pack({ compatibility: { web: { range: '>=9', ok: false } } }))).toEqual([]);
    expect(renders({ ...pack({}), source: 'builtin' })[0]).toMatchObject({ kind: 'plugin' });
  });

  it('judges a condition by the facts it is given, and fails one it cannot judge', () => {
    const facts = { hasProject: true, hasSession: false, capabilities: new Set(['git']) };
    expect(matches({ hasProject: true, capability: 'git' }, facts)).toBe(true);
    expect(matches({ hasSession: true }, facts)).toBe(false);
    expect(matches({ projectType: 'android' }, facts)).toBe(false);
    expect(matches({ projectType: 'android' }, { ...facts, projectTypes: new Set(['android']) })).toBe(true);
    expect(matches({ projectType: 'android' }, { ...facts, projectTypes: new Set(['node']) })).toBe(false);
  });
});
