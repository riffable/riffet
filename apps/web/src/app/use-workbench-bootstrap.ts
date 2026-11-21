import { useCallback, useEffect, useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { NativeBackendCatalogEntry, NativeBackendId, Session } from '@contracts';
import { isUnreachable, type ProjectRecord } from '@/lib/api';
import { syncAppearance } from '@/lib/appearance';
import { reloadPlugins } from '@/lib/plugins';
import { useStore } from '@/lib/store';
import { errorMessage, reconnectDelay } from '@/lib/utils';
import { useStores } from './state/stores';

/**
 * Loads the workbench's lists, capabilities, backends and model catalogs, and keeps the live
 * connection open once the lists are in.
 */
export function useWorkbenchBootstrap({ loaded, project, session, backends, homeBackendId, homeProfileId, catalogRevision, catalogBackendId, catalogProfileId, catalogKey }: {
  loaded: boolean;
  project: ProjectRecord | undefined;
  session: Session | undefined;
  backends: NativeBackendCatalogEntry[];
  homeBackendId: NativeBackendId;
  homeProfileId: string | undefined;
  catalogRevision: number;
  catalogBackendId: NativeBackendId;
  catalogProfileId: string | undefined;
  catalogKey: string;
}) {
  const { t } = useLingui();
  const { lists, nav, catalog, handlers } = useStores();
  const projectlessTasks = useStore(lists, (state) => state.projectlessTasks);

  const loadBootstrap = useCallback(async () => {
    const next = await lists.load();
    // The nav store opened at the link already; the first successful read judges it against the
    // server's lists, as long as the reader has not moved since.
    const start = nav.takeStartingLink();
    catalog.initHome(next.settings);
    // A reconnect: whatever the first reads could not fetch while the server was away.
    catalog.refreshMissing();
    // Checks the selection against the lists of every server shown (`serverLists.ts`). A linked conversation carries its own project,
    // so the conversation alone is enough; a link that names nothing live (gone, archived) is ignored and the
    // stored selection gets its usual chance. A selection the reader made is kept while it is live.
    nav.set((now) => {
      const live = (id: string | undefined) => next.projects.some((item) => item.id === id && !item.archivedAt);
      if (start) {
        const linked = start.link.sessionId ? next.sessions.find((item) => item.id === start.link.sessionId && !item.archivedAt) : undefined;
        const project = next.projects.find((item) => item.id === (linked?.projectId ?? start.link.projectId) && !item.archivedAt);
        if (project) return { projectId: project.id, sessionId: linked?.projectId === project.id ? linked.id : '', ...(!linked && !project.system ? { taskProjectId: project.id } : {}) };
      }
      const current = start ? start.stored : now;
      const selected = next.sessions.find((item) => item.id === current.sessionId);
      const supported = next.protocol?.features.includes('projectless-tasks') ?? false;
      const remembered = now.taskProjectId;
      const taskProjectId = remembered && next.projects.some((item) => item.id === remembered && !item.system && !item.archivedAt) ? remembered : null;
      const currentProject = next.projects.find((item) => item.id === current.projectId && !item.archivedAt);
      const projectId = selected && live(selected.projectId) ? selected.projectId : currentProject?.system === 'quick-chat' ? currentProject.id : supported ? taskProjectId ?? '' : currentProject && !currentProject.system ? currentProject.id : next.projects.find((item) => !item.archivedAt && !item.system)?.id ?? next.projects.find((item) => !item.archivedAt)?.id ?? '';
      return { ...(supported ? { taskProjectId } : {}), projectId, sessionId: selected?.projectId === projectId ? selected.id : '' };
    });
    // Bound by the time the lists have loaded; the link's conversation is open underneath meanwhile.
    if (start?.link.markId) handlers.openMark(start.link.markId);
    return next;
  }, [lists, catalog, nav, handlers]);
  const bootstrapFailed = useCallback((error: unknown) => {
    const unreachable = isUnreachable(error);
    lists.fail(unreachable ? t`无法连接 Riffet 服务器` : errorMessage(error, t`请稍后重试`), unreachable);
  }, [lists, t]);

  // For settings, after a write: a read already on its way may predate it.
  const refreshBackends = useCallback(() => catalog.refreshBackends(true), [catalog]);

  // Every provider configured for the agent being started, so the model picker can group by
  // provider and the agent picker can stay a plain list of agents. Cached per project/provider
  // because switching agents back and forth is a normal way to compare what each one offers.
  const homeProfiles = useMemo(() => backends.find((entry) => entry.backendId === homeBackendId)?.profiles ?? [], [backends, homeBackendId]);
  useEffect(() => {
    if (homeProfileId && homeProfiles.length && !homeProfiles.some((profile) => profile.id === homeProfileId)) {
      catalog.setHomeProfile(homeProfiles.find((profile) => profile.isDefault)?.id);
    }
  }, [homeProfileId, homeProfiles, catalog]);
  const homeProfilesKey = `${project?.id ?? ''}:${homeBackendId}:${homeProfiles.map((entry) => entry.id).join(',')}:${catalogRevision}`;
  useEffect(() => {
    // One provider needs no grouping, and the single-catalog load below already covers it.
    if (session?.id || project?.system === 'quick-chat' || (!project?.id && !projectlessTasks) || homeProfiles.length < 2) { catalog.clearProfileCatalogs(); return; }
    return catalog.loadProfiles(project?.id ?? '', homeBackendId, homeProfiles, homeProfilesKey);
  }, [session?.id, project?.id, projectlessTasks, homeBackendId, homeProfiles, homeProfilesKey, catalog]);

  const loadCatalog = useCallback(() => {
    if (!project?.id && !projectlessTasks) return Promise.resolve();
    return catalog.load({ projectId: project?.id ?? '', sessionId: session?.id ?? '', backendId: catalogBackendId, profileId: catalogProfileId, key: catalogKey });
  },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a re-read backend list (`catalogRevision`) must reload the catalog
    [catalog, project?.id, session?.id, projectlessTasks, catalogBackendId, catalogProfileId, catalogKey, catalogRevision]);

  useEffect(() => {
    void loadBootstrap().catch(bootstrapFailed);
    void catalog.refreshBackends();
  }, [loadBootstrap, bootstrapFailed, catalog]);
  useEffect(() => { void loadCatalog(); return () => catalog.abortLoad(); }, [loadCatalog, catalog]);
  useEffect(() => (loaded ? lists.connect() : undefined), [lists, loaded]);
  // A plugin turned on or off in any client: the views and the appearance it contributes follow without a reload.
  useEffect(() => lists.onPlugins(() => { void reloadPlugins().catch(() => undefined); void syncAppearance(); void catalog.refreshBackends(true); }), [lists, catalog]);

  /**
   * With no local copy a failed bootstrap leaves only the error page, and the live connection only
   * starts once lists exist; so the bootstrap retries itself, backing off, and at once when the
   * device comes back online or the page is shown again. A local copy has the poll for this.
   */
  const failed = useStore(lists, (state) => !state.loaded && Boolean(state.bootError));
  useEffect(() => {
    if (!failed) return;
    let active = true, attempt = 0, inFlight = false, timer: number | undefined;
    const retry = () => {
      window.clearTimeout(timer);
      if (!active || inFlight) return;
      inFlight = true;
      void loadBootstrap().catch((error: unknown) => {
        if (!active) return;
        bootstrapFailed(error);
        timer = window.setTimeout(retry, reconnectDelay(++attempt));
      }).finally(() => { inFlight = false; });
    };
    const onVisible = () => { if (document.visibilityState === 'visible') retry(); };
    timer = window.setTimeout(retry, reconnectDelay(++attempt));
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false; window.clearTimeout(timer);
      window.removeEventListener('online', retry); document.removeEventListener('visibilitychange', onVisible);
    };
  }, [failed, loadBootstrap, bootstrapFailed]);

  return { loadBootstrap, bootstrapFailed, refreshBackends, homeProfilesKey, loadCatalog };
}
