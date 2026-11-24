import { Suspense, useContext, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { PluginHostContext, type ComposerSlotProps, type SettingsPageService, type ViewContext } from '@riffet/plugin-web';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { api } from '@/lib/api';
import { replacePlugin } from '@/lib/plugins';
import { Spinner } from '@/components/ui/controls';
import { useStores } from '../app/state/stores';
import type { ViewEntry } from './catalog';
import { createPluginHost } from './host';
import { IsolatedView } from './isolated/IsolatedView';
import { ProjectFileOpener } from './projectFileOpener';

/** Where a plugin view is mounted. `visible` is the one field that may change without a new instance. */
export interface PluginViewProps {
  entry: ViewEntry;
  projectId?: string | undefined;
  sessionId?: string | undefined;
  /** The project file a view located at `file` shows. */
  path?: string | undefined;
  visible?: boolean;
  /** Set where the view is a page of the settings dialog: how it reports unsaved edits and a save under way. Both reset when the instance goes. */
  settingsPage?: SettingsPageService | undefined;
  /** Drawn while the view's code loads. */
  fallback?: ReactNode;
  /** The conversation's composer, handed to a session view that draws it in place. Its identity must be stable. */
  composer?: ComponentType<ComposerSlotProps> | undefined;
  /** For a main view: draws into the page header after the title. Its identity must be stable. */
  header?: ComponentType<{ children: ReactNode }> | undefined;
}

/**
 * Draws a plugin's view (or a declarative one) and owns what a view may not: its lifetime and its
 * place. An instance is keyed by its context (service, project, session, instance id), so another
 * session or project is a fresh instance with fresh state, and the previous one's signal aborts,
 * cancelling its requests, before it unmounts.
 */
export function PluginView({ entry, projectId, sessionId, path, visible = true, settingsPage, fallback, composer, header }: PluginViewProps) {
  const serviceId = window.location.origin;
  // A file view is one instance per file, whatever it declares.
  const instanceId = path !== undefined ? `${entry.id}:${projectId ?? ''}:${path}` : entry.instances === 'per-session' ? `${entry.id}:${sessionId ?? ''}` : entry.instances === 'per-project' ? `${entry.id}:${projectId ?? ''}` : entry.id;
  const key = [serviceId, projectId ?? '', sessionId ?? '', path ?? '', instanceId].join('|');
  return <Instance key={key} entry={entry} serviceId={serviceId} instanceId={instanceId} projectId={projectId} sessionId={sessionId} path={path} visible={visible} settingsPage={settingsPage} fallback={fallback} composer={composer} header={header} />;
}

function Instance({ entry, serviceId, instanceId, projectId, sessionId, path, visible, settingsPage, fallback, composer, header }: Omit<PluginViewProps, 'visible'> & { serviceId: string; instanceId: string; visible: boolean }) {
  const stores = useStores();
  const { i18n } = useLingui();
  // Created in an effect, not in render: React may mount, unmount and mount an instance again, and each mount needs its own live signal.
  const [controller, setController] = useState<AbortController>();
  useEffect(() => {
    const next = new AbortController();
    setController(next);
    return () => next.abort();
  }, []);
  const [activated, setActivated] = useState(entry.active !== false || !entry.activateOnView);
  const [activationError, setActivationError] = useState<string>();
  useEffect(() => {
    if (!visible) return;
    setActivationError(undefined);
    if (entry.unavailable || !entry.activateOnView || !entry.pluginId || entry.active !== false) { setActivated(true); return; }
    setActivated(false);
    const abort = new AbortController();
    api.activatePluginView(entry.pluginId, entry.id, abort.signal).then(plugin => { if (!abort.signal.aborted) { replacePlugin(plugin); setActivated(true); } }, error => { if (!abort.signal.aborted) setActivationError(String(error.message ?? error)); });
    return () => abort.abort();
  }, [entry.pluginId, entry.id, entry.active, entry.unavailable, entry.activateOnView, entry.activationState, visible]);
  const render = entry.render;
  const access = render?.kind === 'plugin' ? render.access : undefined;
  const openPath = useContext(ProjectFileOpener);
  const host = useMemo(() => createPluginHost({ stores, pluginId: entry.pluginId, sessionId, locale: i18n.locale, access, openPath, ...(settingsPage ? { settingsPage } : {}) }), [stores, entry.pluginId, sessionId, i18n.locale, access, settingsPage, openPath]);
  // The page's flags belong to this instance: whatever it left set is cleared with it.
  useEffect(() => () => { settingsPage?.setDirty(false); settingsPage?.setBusy(false); }, [settingsPage]);
  const context = useMemo<ViewContext | undefined>(() => controller && ({
    serviceId, instanceId, visible, signal: controller.signal,
    ...(projectId ? { projectId } : {}), ...(sessionId ? { sessionId } : {}), ...(path !== undefined ? { path } : {}),
  }), [controller, serviceId, instanceId, projectId, sessionId, path, visible]);
  if (activationError) return <p className="p-3 text-sm text-fg-3" role="status">{activationError}</p>;
  if (!activated) return <div className="flex justify-center p-3"><Spinner /></div>;
  if (!context || !render) return null;
  return (
    <ErrorBoundary variant="surface" resetKey={instanceId}>
      <Suspense fallback={fallback ?? <div className="flex min-h-0 flex-1 items-center justify-center"><Spinner /></div>}>
        {render.kind === 'isolated' ? <IsolatedView source={render.source} context={context} /> : (
          <PluginHostContext.Provider value={host}>
            {render.kind === 'plugin' ? <render.component context={context} {...(composer ? { composer } : {})} {...(header ? { header } : {})} /> : <render.component declaration={render.declaration} context={context} />}
          </PluginHostContext.Provider>
        )}
      </Suspense>
    </ErrorBoundary>
  );
}
