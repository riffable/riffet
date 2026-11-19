import { useMemo, type CSSProperties } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { isBuiltinBackendId, type PluginDescriptor, type ModelInfo, type NativeBackendCapabilities, type NativeBackendCatalogEntry, type NativeBackendId, type Session, type TerminalInfo } from '@contracts';
import { currentPlugins, localizedText, usePlugins } from './plugins';
import { LEGACY_DEFAULT_BACKEND_ID } from './legacy-identity';
import { catalogEntry, catalogSelection, normalizeNativeFastSelection, parseSelection, serializeSelection } from './models';
import { nativeCatalogSelection } from './native-models';
import { createStore, useStore } from './store';

const builtinLabels: Partial<Record<NativeBackendId, string>> = {
  cursor: 'Cursor', codex: 'Codex', claude: 'Claude Code', dsh: 'DeepSeek Harness', droid: 'Droid', traex: 'TRAE CLI', pi: 'pi', antigravity: 'Antigravity',
  // Read through the catalog rather than frozen at import, so a locale switch renames it too.
  get chat() { return i18n._(msg`快速对话`); },
};

/** The labels `/api/backends` last answered with, for an Agent a plugin provides. */
const served = createStore<{ labels: ReadonlyMap<string, string> }>({ labels: new Map() });

export function publishBackendLabels(entries: readonly Pick<NativeBackendCatalogEntry, 'backendId' | 'label'>[]): void {
  const current = served.get().labels;
  if (entries.length === current.size && entries.every((entry) => current.get(entry.backendId) === entry.label)) return;
  served.set({ labels: new Map(entries.map((entry) => [entry.backendId, entry.label])) });
}

function labelOf(id: NativeBackendId, labels: ReadonlyMap<string, string>, plugins: readonly PluginDescriptor[] | undefined): string {
  return builtinLabels[id]
    ?? labels.get(id)
    // Declared titles outlive the plugin being off, so a conversation of an Agent whose plugin is off keeps its name.
    ?? localizedText(plugins?.flatMap((item) => item.declared?.agentBackends ?? []).find((item) => item.id === id)?.title)
    ?? id.slice(id.lastIndexOf('.') + 1);
}

/** The name of an Agent: its built-in name, else the server's, else the one its plugin declares, else the id's last segment. */
export const backendLabel = (id: NativeBackendId): string => labelOf(id, served.get().labels, currentPlugins());

/** [backendLabel] for a component, drawn again when a label arrives. */
export function useBackendLabel(): (id: NativeBackendId) => string {
  const labels = useStore(served, (state) => state.labels);
  const plugins = usePlugins();
  return useMemo(() => (id) => labelOf(id, labels, plugins), [labels, plugins]);
}

/** A row or request without a backend is a legacy-identity one (`legacy-identity.ts`). */
export const sessionBackend = (session: Pick<Session, 'backendId'>): NativeBackendId => session.backendId ?? LEGACY_DEFAULT_BACKEND_ID;

/** Droid and pi keep their own fills; TRAE uses its brand green until it has a palette variable; a plugin's Agent is neutral. */
export function agentMarkStyle(backend: NativeBackendId): CSSProperties | undefined {
  if (backend === 'antigravity' || !isBuiltinBackendId(backend)) return { color: 'var(--fg-3)' };
  if (backend === 'droid' || backend === 'pi') return undefined;
  if (backend === 'traex') return { color: '#00A862' };
  return { color: `var(--agent-${backend})` };
}

/**
 * The colour light cast from an Agent's mark takes (a council seat's halo): the mark's own colour. The Codex mark is a
 * gradient; its middle stop stands for it. A mark without a colour of its own casts the neutral ink.
 */
export function agentTint(backend: NativeBackendId): string {
  // design-rules: allow the Codex mark's middle gradient stop, from agent-marks.tsx
  if (backend === 'codex') return '#7a9dff';
  if (backend === 'chat') return 'var(--fg-3)';
  return agentMarkStyle(backend)?.color ?? 'var(--fg-3)';
}

/** A catalog whose models group their exact CLI ids under `nativeVariants` is restored and launched by those ids. */
const groupsVariants = (catalog: ModelInfo[]): boolean => catalog.some((item) => item.nativeVariants?.length);

export function backendSelection(backend: NativeBackendId, catalog: ModelInfo[], value?: string): string {
  if (groupsVariants(catalog)) return nativeCatalogSelection(catalog, value) ?? value ?? '';
  if (!value) return '';
  let { model, params } = parseSelection(value);
  if (backend === 'claude' && /\[1m\]$/i.test(model)) {
    const base = model.replace(/(?:\[1m\])+$/i, '');
    const context = catalog.find(entry => entry.value === base)?.configOptions.find(option => option.id === 'context');
    if (context?.options.some(option => option.value === '1m')) {
      model = base;
      params = { context: '1m', ...params };
    }
  }
  const entry = catalogEntry(catalog, model);
  if (!entry) return value;
  if (!entry.configOptions.length) return model === entry.value ? value : serializeSelection(entry.value, params);
  return catalogSelection(catalog, model, params) || value;
}

/** What a launch is given for a selection: a variant-grouped catalog pins a fixed Fast to `false` explicitly. */
export const launchSelection = (catalog: ModelInfo[], selection: string): string => (groupsVariants(catalog) ? normalizeNativeFastSelection(catalog, selection) : undefined) ?? selection;

/** A terminal that is not an Agent's CLI: a shell, or the one a login runs in. */
export const isShellTerminal = (terminal: Pick<TerminalInfo, 'kind'>): boolean => terminal.kind === 'shell' || terminal.kind === 'login';

export function hasNativeTerminal(capabilities?: NativeBackendCapabilities): boolean {
  return capabilities?.supportsTerminal ?? (capabilities?.interactionTransport === 'terminal' || capabilities?.interactionTransport === 'both');
}
