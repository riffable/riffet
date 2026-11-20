import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { BridgeViewContext, ViewContext } from '@riffet/plugin-web';
import { Spinner } from '@/components/ui/controls';
import { useDisplaySettings } from '@/lib/display-settings';
import { useTheme } from '@/lib/theme';
import { useStores } from '../../app/state/stores';
import type { IsolatedSource } from '../catalog';
import type { BridgeGrant } from './bridgeHost';
import { bootstrapDocument, pluginPolicy, readTheme } from './document';
import { loadEntryCode } from './entry';
import { attachFrame, type FrameChannel } from './frameHost';
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
  const [page, setPage] = useState<string>();
  // A failure is thrown into the error boundary around the view.
  const [, fail] = useState();

  const current = useMemo<BridgeViewContext>(() => ({
    serviceId: context.serviceId, instanceId: context.instanceId, visible: context.visible, locale: i18n.locale,
    ...(context.projectId ? { projectId: context.projectId } : {}), ...(context.sessionId ? { sessionId: context.sessionId } : {}), ...(context.path ? { path: context.path } : {}),
  }), [context.serviceId, context.instanceId, context.projectId, context.sessionId, context.path, context.visible, i18n.locale]);
  const latest = useRef(current);
  latest.current = current;

  const network = source.capabilities.includes('network');
  const services = useMemo(() => createIsolatedServices({
    stores, context: () => latest.current, label: source.label, pluginId: source.pluginId,
    // The frame has the keyboard focus only after the user clicked or tabbed into it.
    active: () => frame.current !== null && document.activeElement === frame.current,
  }), [stores, source.label, source.pluginId]);
  // By content: a descriptor refresh gives `source` a new identity, and a new grant would close a channel the page cannot ask for again.
  const held = source.capabilities.join(',');
  const declared = source.commands.join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `held` and `declared` are the content of the two lists
  const grant = useMemo<BridgeGrant>(() => ({ capabilities: new Set(source.capabilities), commands: new Set(source.commands) }), [held, declared]);

  useEffect(() => {
    const controller = new AbortController();
    loadEntryCode(source, controller.signal).then(
      (code) => { if (!controller.signal.aborted) setPage(bootstrapDocument({ code, network, theme: readTheme(), locale: latest.current.locale })); },
      (error: unknown) => { if (!controller.signal.aborted) fail(() => { throw error; }); },
    );
    return () => controller.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the entry is read again for another file or content, not for a new object
  }, [source.pluginId, source.path, source.integrity, source.version, network]);

  // Before the frame is laid out: the page asks for its channel while it loads, and an effect that ran after that would miss it.
  useLayoutEffect(() => {
    if (page === undefined) return;
    const attached = attachFrame({ frame: () => frame.current?.contentWindow ?? null, grant, services });
    channel.current = attached;
    return () => { attached.dispose(); channel.current = undefined; };
  }, [page, grant, services]);

  useEffect(() => { channel.current?.push('context', current); }, [current]);
  useEffect(() => {
    if (!source.capabilities.includes('sessions.read') || !context.projectId) return;
    const revision = () => stores.lists.get().sessions.filter(session => session.projectId === context.projectId).map(session => `${session.id}:${session.updatedAt}`).join('|');
    let previous = revision();
    return stores.lists.subscribe(() => { const next = revision(); if (next !== previous) { previous = next; channel.current?.push('data', { kind: 'sessions', projectId: context.projectId! }); } });
  }, [stores, source.capabilities, context.projectId]);
  useEffect(() => {
    // The document has applied the new palette by the next frame.
    const id = requestAnimationFrame(() => channel.current?.push('theme', readTheme()));
    return () => cancelAnimationFrame(id);
  }, [theme.resolved, theme.themeId, theme.revision, theme.paletteKey, textSize]);

  if (page === undefined) return <div className="flex min-h-0 flex-1 items-center justify-center"><Spinner /></div>;
  return (
    <iframe
      ref={frame} title={source.label} srcDoc={page} sandbox="allow-scripts" referrerPolicy="no-referrer"
      // The page's own policy again, on the embedding side (embedded enforcement): a browser that supports it also refuses a page the frame is navigated to unless that page opts in. Others ignore the attribute.
      {...{ csp: pluginPolicy(network) }}
      className="min-h-0 w-full flex-1 border-0"
      // The document loads once. A later load means the script navigated its own frame, which no policy can stop: the view is dropped rather than left showing a page the package chose.
      onLoad={() => { loads.current += 1; if (loads.current > 1) fail(() => { throw new Error('The view left its page'); }); }}
    />
  );
}
