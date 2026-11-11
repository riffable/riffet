import { lazy, useEffect, useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import { satisfiesHostApi } from '@riffet/plugin-web';
import { PLUGIN_WEB_API_VERSION } from '@contracts';
import type { PluginIconName, WebPlugin } from '@riffet/plugin-web';
import { builtinWebPlugins } from '../../../../plugins/web';
import { loadPlugins, usePlugins } from '@/lib/plugins';
import { createStore, useStore } from '@/lib/store';
import { readStored, writeStored } from '@/lib/utils';
import { buildCatalog, buildSettingsPages, type DeclarativeRenderer, type ViewEntry } from './catalog';
import { hostViews } from './hostViews';

/*
 * The web client's view registry: the one place that reads `plugins/web.ts`. It loads the
 * client entry of each plugin that is on and declares a web view, holds the host renderers of
 * declarative views by `kind`, and combines them with the server's descriptors into the catalog
 * every layout, switch and settings page reads. Layouts never import a plugin or name a view.
 */

interface RegistryState {
  plugins: ReadonlyMap<string, WebPlugin>;
  /** Plugins whose client entry failed to load; their views are left out until a later attempt succeeds. */
  failed: ReadonlySet<string>;
  renderers: ReadonlyMap<string, DeclarativeRenderer>;
}
const state = createStore<RegistryState>({ plugins: new Map(), failed: new Set(), renderers: new Map() });
const loaders = new Map(builtinWebPlugins.map((plugin) => [plugin.id, plugin.load]));
/** Loads begun per plugin, and those running now. A failed load is tried once more, on the next descriptor refresh. */
const attempts = new Map<string, number>();
const running = new Set<string>();
const MAX_ATTEMPTS = 2;

/** The icon of each plugin view as its entry last reported it, so a slot kept before the entry loads draws the right one. */
const ICONS_KEY = 'riffet.plugins.icons.v1';
function readIcons(): Record<string, PluginIconName> {
  try { const parsed: unknown = JSON.parse(readStored(ICONS_KEY) || 'null'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, PluginIconName> : {}; } catch { return {}; }
}
let knownIcons = readIcons();

/** Teaches the host to draw views declared with `renderer: { kind }`. Registering a kind again replaces it. */
export function registerDeclarativeRenderer(kind: string, renderer: DeclarativeRenderer): void {
  state.set((current) => ({ renderers: new Map(current.renderers).set(kind, renderer) }));
}

/** Reads a plugin's client entry; a failure is logged and the plugin's views stay out of the catalog until a retry succeeds. */
function loadEntry(pluginId: string): void {
  const load = loaders.get(pluginId);
  if (!load || running.has(pluginId) || state.get().plugins.has(pluginId) || (attempts.get(pluginId) ?? 0) >= MAX_ATTEMPTS) return;
  attempts.set(pluginId, (attempts.get(pluginId) ?? 0) + 1);
  running.add(pluginId);
  load().then(
    (module) => {
      const learned = Object.entries(module.default.icons ?? {}).filter(([view, icon]) => knownIcons[view] !== icon);
      if (learned.length) { knownIcons = { ...knownIcons, ...Object.fromEntries(learned) }; writeStored(ICONS_KEY, JSON.stringify(knownIcons)); }
      state.set((current) => ({ plugins: new Map(current.plugins).set(pluginId, module.default), failed: new Set([...current.failed].filter((id) => id !== pluginId)) }));
    },
    (error) => {
      console.error(`[riffet] could not load the web entry of ${pluginId}`, error);
      state.set((current) => ({ failed: new Set(current.failed).add(pluginId) }));
    },
  ).finally(() => running.delete(pluginId));
}

/** The cached descriptors painted the first frame; one read per page load corrects them. */
let revalidated = false;
function revalidate(): void {
  if (revalidated) return;
  revalidated = true;
  void loadPlugins().catch(() => { revalidated = false; });
}

/** What both catalogs are built from; reading it also starts loading the entries of plugins that are on. */
function useRegistryInputs() {
  const { i18n } = useLingui();
  const descriptors = usePlugins();
  const plugins = useStore(state, (current) => current.plugins);
  const failed = useStore(state, (current) => current.failed);
  const renderers = useStore(state, (current) => current.renderers);
  useEffect(revalidate, []);
  // Each new list of descriptors is also the moment a failed entry gets its second try.
  useEffect(() => {
    for (const descriptor of descriptors ?? []) {
      if (descriptor.enabled && (!descriptor.compatibility?.web || satisfiesHostApi(PLUGIN_WEB_API_VERSION, descriptor.compatibility.web.range)) && descriptor.declared?.views?.some((view) => view.clients.includes('web') && !view.renderer)) loadEntry(descriptor.id);
    }
  }, [descriptors]);
  const pending = useMemo(() => new Set([...loaders.keys()].filter((id) => !plugins.has(id) && !failed.has(id))), [plugins, failed]);
  return { descriptors, plugins, pending, renderers, locale: i18n.locale };
}

/** Every view this client can show now, the app's own first. Re-reads when plugins, entries, renderers or the language change. */
export function useViewCatalog(): ViewEntry[] {
  const { descriptors, plugins, pending, renderers, locale } = useRegistryInputs();
  return useMemo(
    () => buildCatalog({ descriptors, plugins, pending, icons: knownIcons, renderers, host: hostViews(), locale }),
    // `knownIcons` is replaced as entries load, which also replaces `plugins`.
    [descriptors, plugins, pending, renderers, locale],
  );
}

/** The settings pages plugins contribute, hosted by plugin management. */
export function useSettingsPages(): ViewEntry[] {
  const { descriptors, plugins, pending, locale } = useRegistryInputs();
  return useMemo(() => buildSettingsPages({ descriptors, plugins, pending, icons: knownIcons, locale }), [descriptors, plugins, pending, locale]);
}

// The host's own renderers of declarative views, loaded when a view of that kind is first shown.
registerDeclarativeRenderer('tasks', lazy(() => import('./TasksView').then((module) => ({ default: module.TasksView }))));

for (const kind of ['list', 'form', 'detail']) registerDeclarativeRenderer(kind, lazy(() => import('./DeclarativeView').then(module => ({ default: module.DeclarativeView }))));
