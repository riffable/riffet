import { createContext, useContext, useEffect, useLayoutEffect, type ReactNode } from 'react';
import { isUnread, type AppSettings, type Session } from '@contracts';
import { api, type PromptContextReference } from '@/lib/api';
import { sessionActivityAt } from '@/lib/session-order';
import { loadCachedLists } from '@/lib/list-cache';
import { onSessionsDeleted } from '@/lib/session-deletion';
import { writeStored } from '@/lib/utils';
import { replacePageUrl } from '@/lib/overlay-navigation';
import { createCatalogStore, type CatalogState } from './catalogStore';
import { createServerLists, type ServerListsState } from './serverLists';
import { createMarksStore, type MarksState } from './marksStore';
import { createApprovalsStore, type ApprovalsState } from './approvalsStore';
import { createCouncilStore, type CouncilState } from './councilStore';
import { createWorkItemsStore, type WorkItemsState, type WorkItemsStore } from './workItemsStore';
import { createNavStore, STORAGE_KEYS, type NavState } from './navStore';
import { pageAddressUrl } from './page-url';
import { createSettingsStore } from './settingsStore';
import { createUiStore, paintPaneWidth, PANEL_DEFAULT, SIDEBAR_DEFAULT, type UiState } from './uiStore';
import { createTabsStore } from '../tabs/tabsStore';
import { useStore } from '@/lib/store';
import type { SessionAction } from '../Sidebar';

/**
 * Callbacks the workbench re-binds every render. Stores and long-lived effects call through this
 * bag, so they always reach the current selection rules without re-subscribing.
 */
export interface WorkbenchHandlers {
  selectSession: (session: Session) => void;
  reload: () => void;
  sessionAction: (session: Session, action: SessionAction) => void;
  /** Locates a 收藏 and opens its conversation at the message. */
  openMark: (id: string) => void;
  openAssistant: () => boolean;
  openMemberConfig: (memberId: string) => void;
  openPluginView: (id: string) => boolean;
  /** Puts a reference to a project file in a composer of that project: the conversation underneath when it is one, else a new conversation's. */
  quoteInProject: (projectId: string, reference: PromptContextReference) => boolean;
}

const SEEN_REPORT_DELAY_MS = 1000;

/** One workbench's state, split by what changes together. */
export function createWorkbenchStores() {
  const handlers: WorkbenchHandlers = { selectSession: () => {}, reload: () => {}, sessionAction: () => {}, openMark: () => {}, openAssistant: () => false, openMemberConfig: () => {}, openPluginView: () => false, quoteInProject: () => false };
  const cached = loadCachedLists()?.bootstrap;
  // `lists` is only read once a catalog request has answered, by which point it exists.
  const catalog = createCatalogStore({ offline: () => lists.get().status !== 'fresh' });
  const settings = createSettingsStore(cached?.settings ?? {}, {
    onDefaultBackend: (backendId, profileId) => { catalog.setHome(backendId, profileId); writeStored(STORAGE_KEYS.backend, backendId); },
  });
  const nav = createNavStore(cached);
  const ui = createUiStore();
  let workItemsRef: WorkItemsStore | undefined;
  const lists = createServerLists({
    settings,
    selectedSessionId: () => nav.get().sessionId,
    handlers,
    workItems: {
      ticket: () => workItemsRef?.ticket() ?? 0,
      absorb: (summaries, revision, requestedTicket) => workItemsRef?.absorbBootstrap(summaries, revision, requestedTicket),
      summaries: () => workItemsRef?.get().summaries,
    },
  });
  const marks = createMarksStore(lists);
  const workItems = createWorkItemsStore(lists, cached?.workItemSummaries, () => lists.refreshCache());
  workItemsRef = workItems;
  const approvals = createApprovalsStore(lists);
  const council = createCouncilStore(lists);
  const tabs = createTabsStore({ lists, nav, ui, handlers });
  return { handlers, catalog, settings, nav, ui, lists, marks, workItems, approvals, council, tabs };
}

export type WorkbenchStores = ReturnType<typeof createWorkbenchStores>;

const StoresContext = createContext<WorkbenchStores | undefined>(undefined);

export function StoresProvider({ stores, children }: { stores: WorkbenchStores; children: ReactNode }) {
  return <StoresContext.Provider value={stores}>{children}</StoresContext.Provider>;
}

export function useStores(): WorkbenchStores {
  const stores = useContext(StoresContext);
  if (!stores) throw new Error('StoresProvider is missing');
  return stores;
}

export const useLists = <S,>(selector: (state: ServerListsState) => S, isEqual?: (a: S, b: S) => boolean): S => useStore(useStores().lists, selector, isEqual);
export const useNav = <S,>(selector: (state: NavState) => S, isEqual?: (a: S, b: S) => boolean): S => useStore(useStores().nav, selector, isEqual);
export const useUi = <S,>(selector: (state: UiState) => S, isEqual?: (a: S, b: S) => boolean): S => useStore(useStores().ui, selector, isEqual);
export const useMarks = <S,>(selector: (state: MarksState) => S, isEqual?: (a: S, b: S) => boolean): S => useStore(useStores().marks, selector, isEqual);
export const useWorkItems = <S,>(selector: (state: WorkItemsState) => S, isEqual?: (a: S, b: S) => boolean): S => useStore(useStores().workItems, selector, isEqual);
export const useCatalog = <S,>(selector: (state: CatalogState) => S, isEqual?: (a: S, b: S) => boolean): S => useStore(useStores().catalog, selector, isEqual);
/** The server's settings; `{}` until they have loaded. */
export const useSettings = <S,>(selector: (settings: AppSettings) => S): S => useStore(useStores().settings, (state) => selector(state.settings));

/**
 * Mirrors the destination into the URL without adding history entries, and persists the
 * selection and layout. Renders nothing; it exists so these effects subscribe on their own and
 * the workbench does not re-render for them.
 */
export function WorkbenchEffects() {
  const { lists, nav, ui, tabs } = useStores();
  const loaded = useStore(lists, (state) => state.loaded);
  // A conversation the server deleted (here or on another device) leaves the tabs, the selection and the lists.
  useEffect(() => {
    return onSessionsDeleted((ids) => { tabs.retire(ids); lists.removeSessions(ids); });
  }, [tabs, lists]);
  const { projectId, taskProjectId, sessionId, statsOpen, extensionsOpen, marksOpen, designPlatform, designChapter, settingsOpen, settingsSection, tasksOpen, automationsOpen, councilOpen, pluginsOpen, pluginId, mainViewId, statsState } = useStore(nav, (state) => state, (a, b) => a.designPlatform === b.designPlatform && a.designChapter === b.designChapter && a.settingsOpen === b.settingsOpen && a.settingsSection === b.settingsSection && a.projectId === b.projectId && a.taskProjectId === b.taskProjectId && a.sessionId === b.sessionId && a.statsOpen === b.statsOpen && a.extensionsOpen === b.extensionsOpen && a.marksOpen === b.marksOpen && a.tasksOpen === b.tasksOpen && a.automationsOpen === b.automationsOpen && a.councilOpen === b.councilOpen && a.statsState === b.statsState && a.pluginsOpen === b.pluginsOpen && a.pluginId === b.pluginId && a.mainViewId === b.mainViewId);
  const sidebarCollapsed = useStore(ui, (state) => state.sidebarCollapsed);
  const dockHeight = useStore(ui, (state) => state.dockHeight);
  const sidebarWidth = useStore(ui, (state) => state.sidebarWidth);
  const panelWidth = useStore(ui, (state) => state.panelWidth);

  // The conversation on screen while the window is visible and focused: what arrived in it is seen, on every device.
  // Activity comes in many small steps, so one report a second carries the latest.
  useEffect(() => {
    if (!loaded) return;
    let timer: number | undefined;
    const unseenOnScreen = () => {
      const state = nav.get();
      if (document.visibilityState !== 'visible' || !document.hasFocus() || !state.sessionId || state.settingsOpen || state.pluginsOpen || state.statsOpen || state.tasksOpen || state.automationsOpen || state.councilOpen || state.extensionsOpen || state.marksOpen || state.mainViewId || state.attemptsGroupId) return undefined;
      const session = lists.get().sessions.find((item) => item.id === state.sessionId);
      return session && isUnread(session) ? session : undefined;
    };
    const report = () => {
      timer = undefined;
      const session = unseenOnScreen();
      if (!session) return;
      // Only the seen mark: the rest of this copy may be older than a frame that arrived meanwhile.
      void api.markSessionSeen(session.id, sessionActivityAt(session)).then((seen) => {
        const current = lists.get().sessions.find((item) => item.id === seen.id);
        if (current && seen.seenActivityAt && !(Date.parse(current.seenActivityAt ?? '') >= Date.parse(seen.seenActivityAt))) lists.upsertSession({ ...current, seenActivityAt: seen.seenActivityAt });
      }, () => {});
    };
    const schedule = () => { if (timer === undefined && unseenOnScreen()) timer = window.setTimeout(report, SEEN_REPORT_DELAY_MS); };
    schedule();
    const unsubscribeLists = lists.subscribe(schedule);
    const unsubscribeNav = nav.subscribe(schedule);
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('focus', schedule);
    return () => { window.clearTimeout(timer); unsubscribeLists(); unsubscribeNav(); document.removeEventListener('visibilitychange', schedule); window.removeEventListener('focus', schedule); };
  }, [loaded, lists, nav]);
  useEffect(() => { if (loaded) writeStored(STORAGE_KEYS.project, projectId); }, [loaded, projectId]);
  useEffect(() => { if (loaded) writeStored(STORAGE_KEYS.session, sessionId); }, [loaded, sessionId]);
  useEffect(() => { if (loaded && taskProjectId !== undefined) writeStored(STORAGE_KEYS.taskProject, JSON.stringify(taskProjectId)); }, [loaded, taskProjectId]);
  useEffect(() => {
    if (!loaded) return;
    const project = lists.get().projects.find((item) => item.id === projectId);
    if (project && !project.system && !project.archivedAt) nav.rememberProjectVisit(project.id);
  }, [loaded, projectId, sessionId, lists, nav]);
  useEffect(() => { writeStored(STORAGE_KEYS.sidebar, sidebarCollapsed ? '1' : undefined); }, [sidebarCollapsed]);
  useEffect(() => {
    const timer = window.setTimeout(() => writeStored(STORAGE_KEYS.dock, String(dockHeight)), 200);
    return () => window.clearTimeout(timer);
  }, [dockHeight]);
  // Before the first paint, which lays the panes out from these variables.
  useLayoutEffect(() => { paintPaneWidth('sidebar', sidebarWidth); }, [sidebarWidth]);
  useLayoutEffect(() => { paintPaneWidth('panel', panelWidth); }, [panelWidth]);
  useEffect(() => { writeStored(STORAGE_KEYS.sidebarWidth, sidebarWidth === SIDEBAR_DEFAULT ? undefined : String(sidebarWidth)); }, [sidebarWidth]);
  useEffect(() => { writeStored(STORAGE_KEYS.panelWidth, panelWidth === PANEL_DEFAULT ? undefined : String(panelWidth)); }, [panelWidth]);

  /**
   * Mirror page destinations; transient dialogs and menus do not participate in the URL. The nav
   * store started from the link, so there is nothing left in the URL to wait for.
   */
  useEffect(() => {
    if (!loaded) return;
    const page = settingsOpen ? (settingsSection === 'design' ? 'design' : 'settings') : mainViewId ? 'view' : pluginsOpen ? 'plugins' : extensionsOpen ? 'extensions' : statsOpen ? 'stats' : marksOpen ? 'marks' : tasksOpen ? 'tasks' : automationsOpen ? 'automations' : councilOpen ? 'council' : undefined;
    replacePageUrl(pageAddressUrl({ page, sessionId, projectId, pluginId, ...(mainViewId ? { mainViewId } : {}), stats: statsState, designPlatform, designChapter, settingsSection }));
  }, [loaded, projectId, sessionId, statsOpen, extensionsOpen, marksOpen, designPlatform, designChapter, settingsOpen, settingsSection, tasksOpen, automationsOpen, councilOpen, pluginsOpen, pluginId, mainViewId, statsState]);

  return null;
}
export const useCouncil = <S,>(selector: (state: CouncilState) => S, isEqual?: (a: S, b: S) => boolean): S => useStore(useStores().council, selector, isEqual);
export const useApprovals = <S,>(selector: (state: ApprovalsState) => S, isEqual?: (a: S, b: S) => boolean): S => useStore(useStores().approvals, selector, isEqual);
