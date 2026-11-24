import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { BridgeViewContext, ViewContext } from '@riffet/plugin-web';
import { Spinner } from '@/components/ui/controls';
import { useDisplaySettings } from '@/lib/display-settings';
import { onPluginData } from '@/lib/plugin-data-events';
import { useTheme } from '@/lib/theme';
import { useStores } from '../../app/state/stores';
import type { IsolatedSource } from '../catalog';
import type { BridgeGrant } from './bridgeHost';
import { bootstrapStyle, pluginFrameUrl, pluginPolicy, readTheme } from './document';
import { loadEntryCode } from './entry';
import { attachFrame, type FrameChannel } from './frameHost';
import { ProjectFileOpener } from '../projectFileOpener';
import { createIsolatedServices } from './services';

/**
 * Runs a view of a development or installed package in a sandboxed frame (`sandbox="allow-scripts"`,
 * so an opaque origin: no cookies, no storage, no access to this page) and serves it the message
 * bridge. The frame lives and dies with the instance `PluginView` keys by context: another session or
 * project is a new frame, and the old channel closes, aborting what it had pending. `visible`, the
 * language and the palette change within an instance and arrive as pushes.
 */
export function IsolatedView({ source, context }: { source: IsolatedSource; context: ViewContext }) {
  const stores = useStores();
  const { i18n } = useLingui();
  const theme = useTheme();
  const { textSize } = useDisplaySettings();
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useRef<FrameChannel | undefined>(undefined);
  const loads = useRef(0);
  const [loadedEntry, setLoadedEntry] = useState<{ key: string; code: string }>();
  // A failure is thrown into the error boundary around the view.
  const [, fail] = useState();

  const current = useMemo<BridgeViewContext>(() => ({
    serviceId: context.serviceId, instanceId: context.instanceId, visible: context.visible, locale: i18n.locale,
    ...(context.projectId ? { projectId: context.projectId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), ...(context.path ? { path: context.path } : {}),
  }), [context.serviceId, context.instanceId, context.projectId, context.sessionId, context.path, context.visible, i18n.locale]);
  const latest = useRef(current);
  latest.current = current;
  const label = useRef(source.label);
  label.current = source.label;

  const network = source.capabilities.includes('network');
  const entryKey = JSON.stringify([source.pluginId, source.path, source.integrity, source.version]);
  const code = loadedEntry?.key === entryKey ? loadedEntry.code : undefined;
  const fileOpener = useContext(ProjectFileOpener);
  const opener = useRef(fileOpener);
  opener.current = fileOpener;
  const services = useMemo(() => createIsolatedServices({
    stores, context: () => latest.current, label: () => label.current, pluginId: source.pluginId, openPath: () => opener.current,
    // The frame has the keyboard focus only after the user clicked or tabbed into it.
    active: () => latest.current.visible && frame.current !== null && document.activeElement === frame.current,
  }), [stores, source.pluginId]);
  // A changed grant needs a fresh frame as well as a fresh channel: the old iframe already finished its handshake.
  const held = source.capabilities.join(',');
  const declared = source.commands.join(',');
  const declaredQueries = source.queries.join(',');
  const declaredViews = source.views.join(',');
  const frameKey = JSON.stringify([entryKey, held, declared, declaredQueries, declaredViews, source.externalLinks === true]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keys capture the content of the lists
  const grant = useMemo<BridgeGrant>(() => ({ capabilities: new Set(source.capabilities), commands: new Set(source.commands), queries: new Set(source.queries), views: new Set(source.views), externalLinks: source.externalLinks === true }), [held, declared, declaredQueries, declaredViews, source.externalLinks]);

  useEffect(() => {
    const controller = new AbortController();
    loadEntryCode(source, controller.signal).then(
      (code) => { if (!controller.signal.aborted) setLoadedEntry({ key: entryKey, code }); },
      (error: unknown) => { if (!controller.signal.aborted) fail(() => { throw error; }); },
    );
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- entryKey captures the fields the loader reads
  }, [entryKey]);

  // Before the frame is laid out: the page asks for its channel while it loads, and an effect that ran after that would miss it.
  useLayoutEffect(() => {
    if (code === undefined) return;
    loads.current = 0;
    const attached = attachFrame({
      frame: () => frame.current?.contentWindow ?? null, grant, services,
      bootstrap: () => ({ code, style: bootstrapStyle(readTheme()), locale: latest.current.locale }),
    });
    channel.current = attached;
    return () => { attached.dispose(); channel.current = undefined; };
  }, [frameKey, code, grant, services]);

  useEffect(() => { channel.current?.push('context', current); }, [current]);
  useEffect(() => {
    if (!source.capabilities.includes('sessions.read') || !context.projectId) return;
    const revision = () => stores.lists.get().sessions.filter(session => session.projectId === context.projectId).map(session => `${session.id}:${session.updatedAt}`).join('|');
    let previous = revision();
    return stores.lists.subscribe(() => { const next = revision(); if (next !== previous) { previous = next; channel.current?.push('data', { kind: 'sessions', projectId: context.projectId! }); } });
  }, [stores, source.capabilities, context.projectId]);
  useEffect(() => onPluginData((event) => {
    if (event === undefined || event.pluginId === source.pluginId) {
      channel.current?.push('plugin.data', event?.topic ? { topic: event.topic } : {});
    }
  }), [source.pluginId]);
  useEffect(() => {
    // The document has applied the new palette by the next frame.
    const id = requestAnimationFrame(() => channel.current?.push('theme', readTheme()));
    return () => cancelAnimationFrame(id);
  }, [theme.resolved, theme.themeId, theme.revision, theme.paletteKey, textSize]);

  if (code === undefined) return <div className="flex min-h-0 flex-1 items-center justify-center"><Spinner /></div>;
  return (
    <iframe
      key={frameKey}
      ref={frame} title={source.label} src={pluginFrameUrl(network)} sandbox="allow-scripts" referrerPolicy="no-referrer"
      // The page's own policy again, on the embedding side (embedded enforcement): a browser that supports it also refuses a page the frame is navigated to unless that page opts in. Others ignore the attribute.
      {...{ csp: pluginPolicy(network) }}
      className="min-h-0 w-full flex-1 border-0"
      // The document loads once. A later load means the script navigated its own frame, which no policy can stop: the view is dropped rather than left showing a page the package chose.
      onLoad={() => { loads.current += 1; if (loads.current > 1) fail(() => { throw new Error('The view left its page'); }); }}
    />
  );
}
