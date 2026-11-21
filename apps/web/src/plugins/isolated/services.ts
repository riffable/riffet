import type { Run, Session, TimelinePage, TurnOutlineV3 } from '@contracts';
import { PLUGIN_QUERY_ROUTE } from '@contracts';
import type { BridgeCommandResult, BridgeSession, BridgeViewContext } from '@riffet/plugin-web';
import { request } from '@/lib/api';
import { HttpError } from '@/lib/errors';
import { projectFileUrl, readFileRange } from '@/lib/files';
import { serverOfObject } from '@/lib/server-routing';
import { toast } from '@/lib/toast';
import type { WorkbenchStores } from '../../app/state/stores';
import { readTheme } from './document';
import type { BridgeServices } from './bridgeHost';

/** Largest page a view may ask for, in bytes. */
const PAGE_BYTES = 128 * 1024;

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

/** A conversation reduced to what a view may read (see `BridgeSession`); nothing that routes or resumes it. */
export function bridgeSession(session: Session): BridgeSession {
  return {
    id: session.id, projectId: session.projectId, title: session.title, state: session.state, mode: session.mode, tags: [...session.tags],
    ...(session.backendId ? { backendId: session.backendId } : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}),
    ...(session.lastActivityAt ? { lastActivityAt: session.lastActivityAt } : {}),
    createdAt: session.createdAt, updatedAt: session.updatedAt,
  };
}

/**
 * The app's side of the bridge for one view: reads go through the user's own session via `request`,
 * navigation through the workbench's handlers, and nothing returns a store or a credential. The
 * bridge host has already settled who may ask and for which project; these only do the work.
 */
export function createIsolatedServices({ stores, context, label, pluginId, active }: {
  stores: WorkbenchStores;
  /** The view's context as it is now. */
  context: () => BridgeViewContext;
  /** Names the package in what it shows the user. */
  label: () => string;
  /** The package the view belongs to: the only one whose commands it can run. */
  pluginId: string;
  /** Whether the user is working in the view now. */
  active: () => boolean;
}): BridgeServices {
  const { lists, nav, ui, handlers } = stores;
  const find = (id: string) => lists.get().sessions.find((item) => item.id === id);
  return {
    context,
    active,
    theme: () => readTheme(),
    projects: () => lists.get().projects.map(project => ({ id: project.id, name: project.name })),
    sessions: () => lists.get().sessions.map(bridgeSession),
    runs: async (id, signal) => (await request<Run[]>(`/api/sessions/${encodeURIComponent(id)}/runs`, { signal })).map(run => ({ id: run.id, state: run.state, startedAt: run.createdAt, ...(run.state === 'completed' || run.state === 'failed' || run.state === 'cancelled' ? { endedAt: run.updatedAt } : {}), ...(run.native?.metrics?.outputTokens !== undefined ? { outputTokens: run.native.metrics.outputTokens } : {}) })),
    session: (id) => {
      const session = find(id);
      return session ? bridgeSession(session) : undefined;
    },
    outline: async (id, lane, signal) =>
      (await request<{ turns: TurnOutlineV3[] }>(`/api/v3/sessions/${encodeURIComponent(id)}/outline?lane=${encodeURIComponent(lane)}`, { signal })).turns,
    turnSummary: async (id, turn, signal) =>
      (await request<{ summary?: string }>(`/api/sessions/${encodeURIComponent(id)}/turns/${encodeURIComponent(turn)}/summary`, { signal })).summary,
    turnSummaries: () => Boolean(stores.settings.current().auxiliaryModels?.summary),
    timeline: (id, { lane, from, rows }, signal) => {
      const query = new URLSearchParams({ lane, from: String(from), rows: String(rows), budget: String(PAGE_BYTES) });
      return request<TimelinePage>(`/api/v3/sessions/${encodeURIComponent(id)}/timeline?${query.toString()}`, { signal });
    },
    openSession: (id) => {
      const target = find(id);
      if (target) handlers.selectSession(target);
    },
    openPath: (path) => {
      // The files panel shows the project that is open; a view of another project does not steer it.
      if (nav.get().projectId === context().projectId) ui.preview(path);
    },
    openView: (viewId) => handlers.openPluginView(viewId),
    // The user's click in the frame is what lets the browser open a tab; no opener, no referrer.
    openExternal: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
    openAssistant: () => handlers.openAssistant(),
    readFile: async (path, offset, length, signal) => {
      const projectId = context().projectId!;
      const read = await readFileRange(projectFileUrl(projectId, path), offset, offset + length - 1, signal);
      if (read === 'past-end') return { path, size: offset, offset, data: '' };
      return { path, size: read.size, offset, data: base64(read.bytes) };
    },
    notify: (tone, text) => (tone === 'error' ? toast.error : toast.info)(`${label()}: ${text}`),
    execute: (commandId, args, signal) => {
      // The id is `<pluginId>/<name>`; the route takes the name, and the package is the view's own.
      const name = commandId.startsWith(`${pluginId}/`) ? commandId.slice(pluginId.length + 1) : '';
      if (!name || name.includes('/')) return Promise.reject(Object.assign(new Error('Not a command of this package'), { status: 403 }));
      const { projectId, sessionId } = context();
      return request<BridgeCommandResult>(`/api/integrations/${encodeURIComponent(pluginId)}/commands/${encodeURIComponent(name)}`, {
        method: 'POST', signal,
        body: JSON.stringify({ requestId: crypto.randomUUID(), ...(projectId ? { projectId } : {}), ...(sessionId ? { sessionId } : {}), ...(args === undefined ? {} : { args }) }),
      });
    },
    query: (queryId, params, signal) => {
      const name = queryId.startsWith(`${pluginId}/`) ? queryId.slice(pluginId.length + 1) : '';
      if (!name || name.includes('/')) return Promise.reject(Object.assign(new Error('Not a query of this package'), { status: 403 }));
      const { projectId, sessionId, locale } = context();
      // The entry's catalog carries its own plugin packages. A grant from it cannot authorize a query about a linked server's objects.
      if (serverOfObject(projectId) || serverOfObject(sessionId)) {
        return Promise.reject(new HttpError(403, 'Queries for this view are unavailable on a linked server'));
      }
      return request<unknown>(PLUGIN_QUERY_ROUTE(pluginId, name), {
        method: 'POST', signal,
        body: JSON.stringify({ ...(projectId ? { projectId } : {}), ...(sessionId ? { sessionId } : {}), ...(locale ? { locale } : {}), ...(params === undefined ? {} : { params }) }),
      });
    },
  };
}
