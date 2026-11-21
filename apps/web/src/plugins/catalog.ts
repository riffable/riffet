import type { ComponentType } from 'react';
import type { Condition, PluginDescriptor, ViewDeclaration, ViewInstancing, ViewLocation } from '@contracts';
import { satisfiesHostApi } from '@riffet/plugin-web';
import { PLUGIN_WEB_API_VERSION } from '@contracts';
import type { PluginAccess, PluginIconName, ViewContext, WebPlugin } from '@riffet/plugin-web';
import { UnavailableView } from './UnavailableView';
import { localizedText } from '@/lib/plugins';

/*
 * The catalog of views this web client can show: the app's own views plus the views plugins declare,
 * limited to what can be drawn here. Pure, so it is the same rule wherever it is read; the stateful
 * side (loading entries, the renderer table) is `registry.ts`.
 */

/** Ids a stored value may still carry from before views had stable ids. Applied wherever one is read. */
const LEGACY_VIEW_IDS: Readonly<Record<string, string>> = { git: 'changes', canvas: 'riffet.canvas/canvas' };

export const WEB_VIEW_CAPABILITIES = new Set(['renderer.tasks', 'renderer.list', 'renderer.form', 'renderer.detail', 'bridge.host.info', 'bridge.context.get', 'bridge.theme.get', 'bridge.projects.list', 'bridge.sessions.list', 'bridge.sessions.get', 'bridge.sessions.outline', 'bridge.sessions.turnSummary', 'bridge.sessions.turnSummaries', 'bridge.sessions.timeline', 'bridge.sessions.runs', 'bridge.commands.execute', 'bridge.navigation.openSession', 'bridge.navigation.openPath', 'bridge.navigation.openExternal', 'bridge.files.read', 'bridge.notify.info', 'bridge.notify.error']);

export const migrateViewId = (id: string): string => LEGACY_VIEW_IDS[id] ?? id;

/** Props of a host renderer that draws a view from its declaration (`ViewDeclaration.renderer`) instead of plugin code. */
export interface DeclarativeViewProps { declaration: ViewDeclaration; context: ViewContext }
export type DeclarativeRenderer = ComponentType<DeclarativeViewProps>;

/** What the host needs to run a view of a development or installed package: its entry script, and what the package holds. */
export interface IsolatedSource {
  pluginId: string;
  /** The package's name for the user, in notifications the view raises. */
  label: string;
  /** The entry script's path inside the package, and its recorded integrity. */
  path: string;
  integrity?: string;
  /** The package version: the cache key of the entry when it has no integrity. */
  version?: string;
  capabilities: readonly string[];
  /** The commands the package declares. */
  commands: readonly string[];
  /** The view lists `bridge.navigation.openExternal` in its `requires`: it may ask for an address to be opened in the browser. */
  externalLinks?: boolean;
}

export type ViewRender =
  | { kind: 'plugin'; component: ComponentType<{ context: ViewContext }>; access?: PluginAccess }
  | { kind: 'declarative'; declaration: ViewDeclaration; component: DeclarativeRenderer }
  /** A view of a package that is not built in: its script runs in a sandboxed frame and reaches the app through the message bridge only. */
  | { kind: 'isolated'; source: IsolatedSource };

export interface ViewEntry {
  /** Short for the app's own views (`chat`, `terminal`, `files`, `changes`); `<pluginId>/<name>` for a plugin's. */
  id: string;
  pluginId?: string;
  active?: boolean;
  activateOnView?: boolean;
  activationState?: string;
  unavailable?: boolean;
  location: ViewLocation;
  title: string;
  icon: PluginIconName;
  /** The view declares an outline at `icon.svg`, drawn by `viewIcon` in place of `icon` once it loads. */
  iconSvg?: boolean;
  instances: ViewInstancing;
  when?: Condition;
  /** For a view located at `file`: the extensions it shows. */
  extensions?: readonly string[];
  /** Set for a plugin's view; the app's own views are drawn by their layouts. */
  render?: ViewRender;
}

/** What a `Condition` is judged against. A key a client cannot judge fails the condition. */
export interface ViewFacts {
  hasProject: boolean;
  hasSession: boolean;
  projectType?: string;
  /** The types the project's task providers recognise it as (`GET /api/projects/:id/task-actions`); absent until read, which fails a `projectType` condition. */
  projectTypes?: ReadonlySet<string>;
  capabilities: ReadonlySet<string>;
}

export function matches(when: Condition | undefined, facts: ViewFacts): boolean {
  if (!when) return true;
  if (when.hasProject && !facts.hasProject) return false;
  if (when.hasSession && !facts.hasSession) return false;
  if (when.projectType !== undefined && when.projectType !== facts.projectType && !facts.projectTypes?.has(when.projectType)) return false;
  if (when.capability !== undefined && !facts.capabilities.has(when.capability)) return false;
  return true;
}

/** The entry of a development or installed package that has a web script, with what its views may do; undefined for a built-in plugin or a package without one. */
function isolatedSource(descriptor: PluginDescriptor, locale: string): IsolatedSource | undefined {
  if ((descriptor.source !== 'development' && descriptor.source !== 'installed') || !descriptor.webEntry) return undefined;
  return {
    pluginId: descriptor.id,
    label: localizedText(descriptor.title, [locale]) ?? descriptor.name,
    path: descriptor.webEntry.path,
    ...(descriptor.webEntry.integrity ? { integrity: descriptor.webEntry.integrity } : {}),
    ...(descriptor.version ? { version: descriptor.version } : {}),
    capabilities: descriptor.capabilities ?? [],
    commands: (descriptor.declared?.commands ?? []).map((command) => command.id),
  };
}

export interface CatalogInput {
  /** The server's plugins; `undefined` until they load. */
  descriptors: readonly PluginDescriptor[] | undefined;
  /** Client entries loaded so far, by plugin id. */
  plugins: ReadonlyMap<string, WebPlugin>;
  /** Plugins whose client entry is still to load. Their views keep their slot and draw nothing until it has. */
  pending?: ReadonlySet<string>;
  /** The icon each plugin view had when its entry last loaded, for the slot before it loads again. */
  icons?: Readonly<Record<string, PluginIconName>>;
  /** Host renderers of declarative views, by `renderer.kind`. */
  renderers: ReadonlyMap<string, DeclarativeRenderer>;
  /** The app's own views. */
  host: readonly ViewEntry[];
  locale: string;
}

/**
 * Host views, then each plugin's views in plugin order. A plugin view is offered only while its
 * plugin is on, it declares the web client, and something here can draw it: a loaded entry that
 * registers it, or a renderer for its declared `kind`. While the entry is still to load (the
 * descriptors came from the cache) the view is offered without `render`, so the switch and the
 * shortcuts do not move when it arrives; a view whose entry failed to load is not offered.
 */
export function buildCatalog({ descriptors, plugins, pending, icons, renderers, host, locale }: CatalogInput): ViewEntry[] {
  const entries = [...host];
  for (const descriptor of descriptors ?? []) {
    // A package that needs another web SDK than this client's is listed in plugin management as unavailable, and offers no view here.
    if (!descriptor.enabled) continue;
    const compatible = !descriptor.compatibility?.web || satisfiesHostApi(PLUGIN_WEB_API_VERSION, descriptor.compatibility.web.range);
    if (!compatible) continue;
    const isolated = isolatedSource(descriptor, locale);
    for (const view of descriptor.declared?.views ?? []) {
      if (!view.clients.includes('web')) continue;
      const kind = view.renderer?.kind;
      let render: ViewRender | undefined;
      if (!compatible || view.requires?.some(capability => !WEB_VIEW_CAPABILITIES.has(capability))) {
        render = { kind: 'declarative', declaration: view, component: UnavailableView };
      } else if (kind !== undefined) {
        const component = renderers.get(kind);
        if (!component) continue;
        render = { kind: 'declarative', declaration: view, component };
      } else if (isolated) {
        // Whatever is not built in runs isolated, development packages included; the in-app SDK is for bundled code.
        render = { kind: 'isolated', source: view.requires?.includes('bridge.navigation.openExternal') ? { ...isolated, externalLinks: true } : isolated };
      } else if (descriptor.source === 'development' || descriptor.source === 'installed') {
        continue;
      } else {
        const entry = plugins.get(descriptor.id);
        const component = entry?.views[view.id];
        if (component) render = { kind: 'plugin', component, ...(entry?.access ? { access: entry.access } : {}) };
        else if (!pending?.has(descriptor.id)) continue;
      }
      for (const location of view.locations) {
        if (location !== 'session-view' && location !== 'sidebar' && location !== 'file') continue;
        if (location === 'file' && !view.files?.extensions.length) continue;
        entries.push({
          id: view.id, pluginId: descriptor.id, active: descriptor.active, activateOnView: descriptor.activation?.events.includes('view'), activationState: descriptor.activation?.state, unavailable: !compatible || Boolean(view.requires?.some(capability => !WEB_VIEW_CAPABILITIES.has(capability))), location, instances: view.instances,
          ...(render ? { render } : {}),
          title: localizedText(view.title, [locale]) ?? view.id,
          icon: plugins.get(descriptor.id)?.icons?.[view.id] ?? icons?.[view.id] ?? 'square-terminal',
          // A bundled entry that names its icon keeps it; otherwise the declared outline is drawn.
          ...(view.icon?.svg && !plugins.get(descriptor.id)?.icons?.[view.id] && !icons?.[view.id] ? { iconSvg: true } : {}),
          ...(view.when ? { when: view.when } : {}),
          ...(location === 'file' ? { extensions: view.files!.extensions } : {}),
        });
      }
    }
  }
  return entries;
}

/** The views located at `file` that show [path], by its extension, and whose conditions hold. */
export function fileViewsFor(entries: readonly ViewEntry[], path: string, facts: ViewFacts): ViewEntry[] {
  const name = path.split('/').at(-1) ?? path;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return extension ? entries.filter((entry) => entry.location === 'file' && entry.extensions?.includes(extension) && matches(entry.when, facts)) : [];
}

/**
 * The settings pages plugins contribute (views located at `settings`): the same rule as `buildCatalog`
 * for what is offered, in plugin order, hosted by plugin management. Only a plugin's own
 * code can draw one.
 */
export function buildSettingsPages({ descriptors, plugins, pending, icons, locale }: Pick<CatalogInput, 'descriptors' | 'plugins' | 'pending' | 'icons' | 'locale'>): ViewEntry[] {
  const pages: ViewEntry[] = [];
  for (const descriptor of descriptors ?? []) {
    // A package that needs another web SDK than this client's is listed in plugin management as unavailable, and offers no view here.
    if (!descriptor.enabled || (descriptor.compatibility?.web && !satisfiesHostApi(PLUGIN_WEB_API_VERSION, descriptor.compatibility.web.range))) continue;
    for (const view of descriptor.declared?.views ?? []) {
      if (!view.clients.includes('web') || !view.locations.includes('settings') || view.renderer) continue;
      const entry = plugins.get(descriptor.id);
      const component = entry?.views[view.id];
      if (!component && !pending?.has(descriptor.id)) continue;
      pages.push({
        id: view.id, pluginId: descriptor.id, active: descriptor.active, activateOnView: descriptor.activation?.events.includes('view'), activationState: descriptor.activation?.state, location: 'settings', instances: view.instances,
        ...(component ? { render: { kind: 'plugin', component, ...(entry?.access ? { access: entry.access } : {}) } as const } : {}),
        title: localizedText(view.title, [locale]) ?? view.id,
        icon: entry?.icons?.[view.id] ?? icons?.[view.id] ?? 'square-terminal',
        ...(view.when ? { when: view.when } : {}),
      });
    }
  }
  return pages;
}

/** The settings pages of the Agent `backendId`: those of the plugin whose declared Agents include it. */
export function settingsPagesOf(descriptors: readonly PluginDescriptor[] | undefined, pages: readonly ViewEntry[], backendId: string, category?: 'agent' | 'providers'): ViewEntry[] {
  const owner = descriptors?.find((descriptor) => descriptor.enabled && descriptor.declared?.agentBackends?.some((agent) => agent.id === backendId));
  return owner ? pages.filter((page) => {
    if (!page.id.startsWith(`${owner.id}/`)) return false;
    const declared = owner.declared?.views?.find((view) => view.id === page.id);
    return !category || !declared?.settingsCategory || declared.settingsCategory === category;
  }) : [];
}
