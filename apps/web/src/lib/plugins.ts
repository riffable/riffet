import type { CommandRunRequest, PluginAction, PluginDescriptor, LocalizedText, ModelSourceDescriptor, NativeBackendId, PluginCommandResult } from '@contracts';
import { i18n } from '@lingui/core';
import { api, request } from './api';
import { createStore, useStore } from './store';
import { readStored, writeStored } from './utils';

/**
 * The server's built-in plugins (docs/PLUGIN_ARCHITECTURE.md), shared by the settings pages that read
 * them. The last list is kept for the page's lifetime, so reopening settings draws it at once while
 * a fresh one loads; `undefined` means none has loaded yet, which is not the same as an empty list.
 *
 * The last list this browser read from this server is also kept in localStorage, so the first frame
 * already knows which plugin views are on instead of adding them once the request returns. Like the
 * other caches, the network only ever corrects it and a failed read keeps it.
 */
// Retained across the Plugin source rename, as are the HTTP and SSE names.
const CACHE_KEY = 'riffet.integrations.v1:';
const cacheKey = () => CACHE_KEY + (globalThis.location?.origin ?? '');

function isDescriptor(value: unknown): value is PluginDescriptor {
  const item = value as Partial<PluginDescriptor> | null;
  return Boolean(item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.enabled === 'boolean'
    && Array.isArray(item.settings) && Array.isArray(item.actions) && item.contributes && typeof item.contributes === 'object');
}

function readCache(): PluginDescriptor[] | undefined {
  try {
    const raw = readStored(cacheKey());
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    return Array.isArray(parsed) && parsed.every(isDescriptor) ? parsed : undefined;
  } catch { return undefined; }
}

/** The list is a server-wide fact, but a sign-out takes it with the rest of what this browser kept. */
export function clearCachedPlugins(): void { generation += 1; loading = undefined; store.set({ list: undefined, recovery: false }); writeStored(cacheKey(), undefined); }

const store = createStore<{ list?: PluginDescriptor[]; recovery: boolean }>({ list: readCache(), recovery: false });
export const usePluginRecovery = () => useStore(store, value => value.recovery);
let loading: Promise<PluginDescriptor[]> | undefined;
let reread = false;
let generation = 0;

function setList(list: PluginDescriptor[]): void {
  store.set({ list });
  writeStored(cacheKey(), JSON.stringify(list));
}

/** The server's last evaluation. Concurrent callers share one request. */
export function loadPlugins(): Promise<PluginDescriptor[]> {
  const current = generation;
  loading ??= (async () => {
    try {
      let list: PluginDescriptor[];
      do {
        reread = false;
        const response = await api.plugins();
        list = response.integrations;
        if (current !== generation) return [];
        store.set({ recovery: response.recovery === true });
        setList(list);
      } while (reread);
      return list;
    } finally { if (current === generation) loading = undefined; }
  })();
  return loading;
}

/** Reads again after a change was made. A read already running may have been answered before it, so another follows it. */
export function reloadPlugins(): Promise<PluginDescriptor[]> {
  if (loading) reread = true;
  return loadPlugins();
}

/** Makes the server detect again; for the page that shows what is detected. */
export async function refreshPlugins(): Promise<PluginDescriptor[]> {
  const { integrations: plugins } = await api.refreshPlugins();
  setList(plugins);
  return plugins;
}

/**
 * The text for the first of `locales` the map has: an exact tag, then its language, then Simplified
 * Chinese, then English, then whatever there is. `undefined` when the map is absent or empty.
 */
export function localizedText(text: LocalizedText | undefined, locales: readonly string[] = [i18n.locale]): string | undefined {
  const entries = Object.entries(text ?? {});
  if (!entries.length) return undefined;
  const table = new Map(entries.map(([tag, value]) => [tag.toLowerCase(), value]));
  for (const locale of locales) {
    const tag = locale.toLowerCase().replaceAll('_', '-');
    for (let length = tag.split('-').length; length > 0; length -= 1) {
      const found = table.get(tag.split('-').slice(0, length).join('-'));
      if (found !== undefined) return found;
    }
  }
  return table.get('zh-hans') ?? table.get('en') ?? entries[0]![1];
}

/** A plugin's name for the user: its title, else its name, else the id. */
export function pluginTitle(list: readonly PluginDescriptor[] | undefined, id: string, locales?: readonly string[]): string {
  const descriptor = list?.find((item) => item.id === id);
  return (descriptor && (localizedText(descriptor.title, locales) ?? descriptor.name)) ?? id;
}

/** Applies a descriptor the server returned for one plugin, such as after a change. */
export function replacePlugin(next: PluginDescriptor): void {
  const list = store.get().list?.map((item) => item.id === next.id && item.source === next.source ? next : item);
  if (list) setList(list);
}

/** Applies the whole list the server returned, such as after a version was uninstalled. */
export const replacePlugins = setList;

export function usePlugins(): PluginDescriptor[] | undefined {
  return useStore(store, (state) => state.list);
}

/** The list now, for code that is not a component. */
export const currentPlugins = (): PluginDescriptor[] | undefined => store.get().list;

/** A model source with the plugin that provides it, and the action that signs in to it. */
export interface ModelSourceEntry { pluginId: string; source: ModelSourceDescriptor; login?: PluginAction }

/**
 * The sources a CLI can name, in plugin order and then each plugin's own order. A source is offered when it serves
 * a gateway protocol the backend consumes (`consumes`, from its catalog entry); a server that predates `protocols` is matched by `backends`.
 */
export function modelSourcesFor(list: PluginDescriptor[] | undefined, backendId: NativeBackendId, consumes?: readonly string[]): ModelSourceEntry[] {
  return (list ?? []).filter((plugin) => plugin.enabled).flatMap((plugin) => (plugin.contributes.modelSources ?? [])
    .filter((source) => consumes && source.protocols ? source.protocols.some((protocol) => consumes.includes(protocol)) : (source.backends as string[]).includes(backendId))
    .map((source) => ({
      pluginId: plugin.id,
      source,
      login: source.loginAction ? plugin.actions.find((action) => action.id === source.loginAction) : undefined,
    })));
}

/** Runs the command `<pluginId>/<name>`. A failure keeps the server's error: 409 `TASK_CONFIRM_REQUIRED` carries the plan a task of the command needs approved, and `confirm` sends it back. */
export function runPluginCommand(commandId: string, body: CommandRunRequest & { confirm?: string }, signal?: AbortSignal): Promise<PluginCommandResult> {
  const slash = commandId.indexOf('/');
  const path = `/api/integrations/${encodeURIComponent(commandId.slice(0, slash))}/commands/${encodeURIComponent(commandId.slice(slash + 1))}`;
  return request<PluginCommandResult>(path, { method: 'POST', body: JSON.stringify(body), ...(signal ? { signal } : {}) });
}
