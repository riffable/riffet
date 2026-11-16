import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { NativeBackendId, Session, StatsRunRow, WorkItem } from '@contracts';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ResizeHandle } from '@/components/ui/resize-handle';
import { UnderlineTabs } from '@/components/ui/controls';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { IconArchive, IconSquareKanban, IconBookmark, IconBot, IconBrain, IconCalendarClock, IconChartColumn, IconFolder, IconGitCompare, IconPuzzle, IconMessageCirclePlus, IconMoon, IconPanelLeft, IconPencilLine, IconSettings, IconSquare, IconTerminal } from '@/components/icons';
import { MOBILE_LAYOUT_QUERY, useMediaQuery, useMobileViewport } from '@/lib/use-media-query';
import { BrandMark, LiveBrandMark } from '@/components/BrandMark';
import { api, type PromptContextReference } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn, errorMessage, writeStored } from '@/lib/utils';
import { isShellTerminal, sessionBackend } from '@/lib/backends';
import { parseSelection } from '@/lib/models';
import { sessionActivityAt } from '@/lib/session-order';
import { setThemeMode } from '@/lib/theme';
import { useDocumentTitle } from '@/lib/document-title';
import type { PaletteAction } from './CommandPalette';
import { sendSessionCommand } from '@/lib/session-commands';
import type { HeaderSlots } from './Header';
import { NoProjects, NewSessionHome } from './ProjectHome';
import { Sidebar, type SessionAction } from './Sidebar';
import { MobileSidebar } from './MobileSidebar';
import { NativeSession } from './terminal/NativeSession';
import { AttemptGroupPage } from './session/Attempts';
import { SidebarPeekTrigger, useSidebarPeek } from './use-sidebar-peek';
import { useWorkbenchBootstrap } from './use-workbench-bootstrap';
import { useGlobalShortcuts } from './use-global-shortcuts';
import { usePluginCommands } from './usePluginCommands';
import { useSessionActions } from './use-session-actions';
import { useProjectActions } from './use-project-actions';
import { useTerminalActions } from './use-terminal-actions';
import { settingsSections, type SettingsSection } from './settings/settingsSections';
import { createWorkbenchStores, StoresProvider, useCatalog, useLists, useNav, useSettings, useStores, useUi, useWorkItems, WorkbenchEffects } from './state/stores';
import { viewWorkItems } from './work-items/model';
import { NO_PAGE, STORAGE_KEYS, type NavPage } from './state/navStore';
import { paintPaneWidth, panelDockMinWidth, SIDEBAR_DEFAULT, SIDEBAR_MIN, sidebarMaxWidth } from './state/uiStore';
import { togglePanelTab, WorkbenchHeader } from './WorkbenchHeader';
import { useSessionViews, setViewVisible } from './session/viewPrefs';
import { shownView, useSidebarViews } from './panels/useSidebarViews';
import { DockHost, loadingPanel, PanelHost } from './WorkbenchPanels';
import { TabChromeContext } from './tabs/chrome';
import { TabBar } from './tabs/TabBar';
import { useTabs } from './tabs/useTabs';
import { AppearanceBackdrop } from '@/components/appearance-backdrop';
import { WorkbenchOverlays } from './WorkbenchOverlays';
import { isAssistantProject, isQuickChatProject, mainSessionIdOf, regularProjects, sortProjectsByRecentUse } from '@/lib/project-family';
import { assistantChoice, withAssistantDefaults } from './work-items/assistant';
const StatsPage = lazy(() => import('./stats/StatsPage').then((module) => ({ default: module.StatsPage })));
const WorkItemsPage = lazy(() => import('./work-items/WorkItemsPage').then((module) => ({ default: module.WorkItemsPage })));
const AutomationsPage = lazy(() => import('./automations/AutomationsPage').then((module) => ({ default: module.AutomationsPage })));
const ExtensionsPage = lazy(() => import('./extensions/ExtensionsPage').then((module) => ({ default: module.ExtensionsPage })));
const PluginsPage = lazy(() => import('./plugins/PluginsPage').then((module) => ({ default: module.PluginsPage })));
const MarksPage = lazy(() => import('./marks/MarksPage').then((module) => ({ default: module.MarksPage })));
const DesignPage = lazy(() => import('./design/DesignPage').then((module) => ({ default: module.DesignPage })));

const pushError = (message: string) => toast.error(message);

/** A quick chat has no project files, so it neither reads nor writes the shared reference list. */
const NO_REFERENCES: PromptContextReference[] = [];
const noReferences = () => undefined;

/**
 * The workbench's state lives in external stores (`./state`), created once per mount. This
 * component wires them to the server and to the pages; panels, dock and dialogs read their own
 * slices, so toggling one does not re-render the page.
 */
/** The new-conversation page's two targets: a task in a project, a quick chat. */
type HomeTab = 'task' | 'chat';

export function Workbench({ onLogout }: { onLogout?: () => void }) {
  const [stores] = useState(createWorkbenchStores);
  return <StoresProvider stores={stores}><WorkbenchShell onLogout={onLogout} /><WorkbenchEffects /></StoresProvider>;
}

function WorkbenchShell({ onLogout }: { onLogout?: (() => void) | undefined }) {
  const { t } = useLingui();
  const { lists, nav, ui, tabs, catalog, settings: settingsStore, handlers } = useStores();
  const loaded = useLists((state) => state.loaded);
  const projectlessTasks = useLists((state) => state.projectlessTasks);
  const sessionReferences = useLists(state => state.sessionReferences);
  const taskProjectId = useNav((state) => state.taskProjectId);
  const projects = useLists((state) => state.projects);
  const sessions = useLists((state) => state.sessions);
  const terminals = useLists((state) => state.terminals);
  const listsState = useLists((state) => state.status);
  const listsSavedAt = useLists((state) => state.savedAt);
  const bootError = useLists((state) => state.bootError);
  // Whole, because the new-conversation composer takes the settings object; it changes only on save.
  const settings = useSettings((value) => value);
  const selectedProjectId = useNav((state) => state.projectId);
  const projectVisits = useNav((state) => state.projectVisits);
  const selectedSessionId = useNav((state) => state.sessionId);
  const pluginsOpen = useNav((state) => state.pluginsOpen);
  const pluginId = useNav((state) => state.pluginId);
  const pluginViewId = useNav((state) => state.pluginViewId);
  const pluginDetailTab = useNav((state) => state.pluginDetailTab);
  const pluginOpenRevision = useNav((state) => state.pluginOpenRevision);
  const statsOpen = useNav((state) => state.statsOpen);
  const tasksOpen = useNav((state) => state.tasksOpen);
  const automationsOpen = useNav((state) => state.automationsOpen);
  const workItemList = useWorkItems((state) => state.items);
  const workItemsSupported = useWorkItems((state) => state.supported);
  const extensionsOpen = useNav((state) => state.extensionsOpen);
  const extensionsMounted = useNav((state) => state.extensionsMounted);
  const marksOpen = useNav((state) => state.marksOpen);
  const designOpen = useNav((state) => state.designOpen);
  const attemptsGroupId = useNav((state) => state.attemptsGroupId);
  const sessionView = useNav((state) => state.sessionView);
  const statsState = useNav((state) => state.statsState);
  const focusMessage = useNav((state) => state.focusMessage);
  const sidebarCollapsed = useUi((state) => state.sidebarCollapsed);
  const mobileSidebar = useUi((state) => state.mobileSidebar);
  const panelFullscreen = useUi((state) => state.panelFullscreen);
  const references = useUi((state) => state.references);
  const extensionsFocus = useUi((state) => state.extensionsFocus);
  const creating = useUi((state) => state.creating);
  const creatingWorktree = useUi((state) => state.creatingWorktree);
  const startingNativeId = useUi((state) => state.startingNativeId);
  const nativeRunSeed = useUi((state) => state.nativeRunSeed);
  const backends = useCatalog((state) => state.backends);
  const pickedBackendId = useCatalog((state) => state.homeBackendId);
  // Until the first bootstrap hands it to the store (`initHome`), the agent's saved provider: the
  // first frames then read that provider's cached catalog instead of painting the default model.
  const storedHomeProfileId = useCatalog((state) => state.homeProfileId);
  const pickedProfileId = storedHomeProfileId ?? settings.nativeBackendDefaults?.[pickedBackendId]?.profileId;
  const catalogResult = useCatalog((state) => state.result);
  const profileCatalogs = useCatalog((state) => state.profileCatalogs);
  const nativeCatalogLoading = useCatalog((state) => state.loading);
  const nativeCatalogError = useCatalog((state) => state.error);
  const catalogLoadedKey = useCatalog((state) => state.loadedKey);
  const catalogRevision = useCatalog((state) => state.revision);

  const desktop = !useMediaQuery(MOBILE_LAYOUT_QUERY);
  const tabStyle = useTabs((state) => state.style);
  const tabbed = desktop && tabStyle !== 'off';
  /** The slot at the right end of the tab bar, where the page header puts its actions once the bar has mounted. */
  const [tabActions, setTabActions] = useState<HTMLDivElement | null>(null);
  const sidebarWidth = useUi((state) => state.sidebarWidth);
  const panelDockMin = useUi((state) => panelDockMinWidth(state.sidebarCollapsed ? undefined : state.sidebarWidth, state.panelWidth));
  const wideViewport = useMediaQuery(`(min-width: ${panelDockMin}px)`);
  const wide = desktop && wideViewport;
  const sidebarPeek = useSidebarPeek(desktop && sidebarCollapsed);
  // A peek that ends just goes away: sliding it out would first snap the floating card to the docked
  // panel's full height, then sweep that across the conversation. Only ⌘B slides.
  const peeked = useRef(sidebarPeek.peek);
  const leavingPeek = peeked.current && !sidebarPeek.peek;
  useEffect(() => { peeked.current = sidebarPeek.peek; }, [sidebarPeek.peek]);
  useMobileViewport();
  useEffect(() => { ui.layoutChanged(desktop); }, [desktop, ui]);

  const regular = useMemo(() => regularProjects(projects), [projects]);
  const recentDirectories = useMemo(() => sortProjectsByRecentUse(regular, sessions, projectVisits), [regular, sessions, projectVisits]);
  const lastTaskProject = useMemo(() => recentDirectories.filter((item) => !item.archivedAt).sort((a, b) => (projectVisits[b.id] ?? 0) - (projectVisits[a.id] ?? 0))[0], [recentDirectories, projectVisits]);
  const quickChatProject = useMemo(() => projects.find((item) => isQuickChatProject(item)), [projects]);
  const assistantProject = useMemo(() => projects.find((item) => isAssistantProject(item) && !item.archivedAt), [projects]);
  // The 助理's directory has extensions of its own, reached from its page.
  const extensionProjects = useMemo(() => assistantProject ? [...regular, { ...assistantProject, name: t`个人助理` }] : regular, [regular, assistantProject, t]);
  const project = projects.find((item) => item.id === selectedProjectId);
  const quickChat = isQuickChatProject(project);
  // The 助理 is one long conversation: once it exists, its page is that conversation (docs/ASSISTANT.md).
  const assistantMain = useMemo(() => {
    const id = mainSessionIdOf(assistantProject);
    const found = id ? sessions.find((item) => item.id === id && item.projectId === assistantProject?.id) : undefined;
    return found && !found.archivedAt ? found : undefined;
  }, [assistantProject, sessions]);
  const homeTab: HomeTab = quickChat ? 'chat' : 'task';
  const session = sessions.find((item) => item.id === selectedSessionId && item.projectId === selectedProjectId);
  // Each conversation keeps its own side panel; swapped before paint so the one entered never shows the last one's.
  const panelSession = useRef(selectedSessionId);
  useLayoutEffect(() => {
    if (panelSession.current === selectedSessionId) return;
    ui.switchSession(panelSession.current, selectedSessionId);
    panelSession.current = selectedSessionId;
  }, [selectedSessionId, ui]);
  useEffect(() => { if (loaded) ui.keepSessionPanels(new Set(sessions.map((item) => item.id))); }, [loaded, sessions, ui]);
  // The 助理 page's composer starts with the 助理's own agent and model, and a pick made there is the
  // 助理's, not the composer's everywhere else (docs/ASSISTANT.md).
  const assistantHome = isAssistantProject(project) && !session;
  const assistantPick = useMemo(() => assistantHome ? assistantChoice(settings.assistant, backends) : undefined, [assistantHome, settings.assistant, backends]);
  const homeBackendId = assistantPick?.backendId ?? pickedBackendId;
  const homeProfileId = assistantPick ? assistantPick.profileId : pickedProfileId;
  /** The model the composer opens with: under the 助理, its own. */
  const composerSettings = useMemo(() => assistantPick ? withAssistantDefaults(settings, assistantPick) : settings, [settings, assistantPick]);
  const sidebarViews = useSidebarViews(project, session?.id);
  const sessionViews = useSessionViews({ hasProject: Boolean(project), hasSession: Boolean(session), capabilities: new Set() });
  const catalogProject = project;
  const catalogSession = session;
  const catalogBackendId = catalogSession ? sessionBackend(catalogSession) : quickChat ? 'chat' : homeBackendId;
  const catalogProfileId = catalogSession ? catalogSession.backendProfileId : quickChat ? undefined : homeProfileId;
  const defaultProfileId = backends.find((entry) => entry.backendId === catalogBackendId)?.profiles.find((entry) => entry.isDefault)?.id ?? 'default';
  const recentModel = useMemo(() => {
    const preferred = quickChat ? settings.auxiliaryModels?.chat : undefined;
    const preferredValue = preferred ? `${preferred.backendId}:${preferred.profileId}:${preferred.model}` : '';
    let latest: Session | undefined;
    let matching: Session | undefined;
    for (const item of sessions) {
      if (!item.model || sessionBackend(item) !== catalogBackendId) continue;
      if (!quickChat && (item.backendProfileId ?? defaultProfileId) !== (catalogProfileId ?? defaultProfileId)) continue;
      if (!latest || Date.parse(sessionActivityAt(item)) > Date.parse(sessionActivityAt(latest))) latest = item;
      if (preferredValue && parseSelection(item.model).model === preferredValue && (!matching || Date.parse(sessionActivityAt(item)) > Date.parse(sessionActivityAt(matching)))) matching = item;
    }
    return matching?.model ?? latest?.model;
  }, [sessions, quickChat, settings.auxiliaryModels?.chat, catalogBackendId, catalogProfileId, defaultProfileId]);
  const catalogKey = `${catalogProject?.id ?? ''}:${catalogSession?.id ?? ''}:${catalogBackendId}:${catalogProfileId ?? 'default'}:${catalogSession?.nativeSessionId ?? ''}${catalogBackendId === 'chat' ? `:${JSON.stringify(settings.quickChat?.presets)}` : ''}`;
  // The key also moves when nothing a picker shows has (the first message writes the native id
  // back, a quick chat preset is saved). The last catalog of the same project, agent and provider
  // stays on screen until the new one lands, so a refresh never empties the pickers for a frame.
  // Catalogs can differ per session, so the hold never crosses from one session to another: only
  // within a session, or from the new-conversation composer to the session it just created.
  const catalogAgent = `${catalogBackendId}:${catalogProfileId ?? 'default'}`;
  const catalogFamily = `${catalogProject?.id ?? ''}:${catalogAgent}`;
  const catalogSessionId = catalogSession?.id ?? '';
  const heldCatalog = useRef<{ family: string; agent: string; sessionId: string; result: NonNullable<typeof catalogResult> } | undefined>(undefined);
  if (catalogResult?.key === catalogKey) heldCatalog.current = { family: catalogFamily, agent: catalogAgent, sessionId: catalogSessionId, result: catalogResult };
  const held = heldCatalog.current;
  const holds = held?.family === catalogFamily && (held.sessionId === catalogSessionId || (!held.sessionId && nativeRunSeed?.sessionId === catalogSessionId));
  // A key the store has not loaded yet (another project, say) still has its last known catalog in
  // the cache; `load` would paint it, but only after this render has painted a frame of loading.
  const peekedCatalog = catalogResult?.key !== catalogKey && !holds && (catalogProject?.id || projectlessTasks)
    ? catalog.peek({ projectId: catalogProject?.id ?? '', sessionId: catalogSessionId, backendId: catalogBackendId, profileId: catalogProfileId })
    : undefined;
  const currentCatalog = catalogResult?.key === catalogKey ? catalogResult : holds ? held.result : peekedCatalog ? { key: catalogKey, entry: peekedCatalog } : undefined;
  // A project with no catalog loaded or cached yet is unknown, not empty. Until its own lands, the
  // new-conversation composer resolves its model against the last catalog of the same agent and
  // provider, so the picker keeps saying which model it holds; it is still loading, so sending
  // waits for the real one. A session's own pickers never borrow another catalog, and a read that
  // failed says so on an empty picker rather than behind a borrowed list.
  const catalogLoading = !currentCatalog && (nativeCatalogLoading || catalogLoadedKey !== catalogKey);
  const standInCatalog = catalogLoading && !catalogSession && held?.agent === catalogAgent ? held.result.entry.models : undefined;
  const backend = currentCatalog ? currentCatalog.entry : backends.find((entry) => entry.backendId === catalogBackendId);
  const nativeCatalog = currentCatalog ? currentCatalog.entry.models : [];
  const pageOpen = pluginsOpen || statsOpen || tasksOpen || automationsOpen || extensionsOpen || marksOpen || designOpen;
  /** Every page that covers the conversation, the attempts comparison included. */
  const anyPageOpen = pageOpen || Boolean(attemptsGroupId);
  /** On the 助理 page: its project, with no page over it, showing its main conversation or the empty state. Derived, so it has no address of its own. */
  const assistantPage = isAssistantProject(project) && !anyPageOpen && (!session || session.id === mainSessionIdOf(project));
  // On the 助理 page the inline style has no tab bar to host the header's actions, so the header keeps its own row.
  const tabChrome = useMemo(() => tabbed && !(tabStyle === 'inline' && assistantPage) ? { actions: tabActions } : null, [tabbed, tabStyle, assistantPage, tabActions]);
  useDocumentTitle(pageOpen ? undefined : assistantPage && session ? { ...session, title: t`个人助理` } : session, sessions, pluginsOpen ? t`插件` : extensionsOpen ? t`扩展管理` : statsOpen ? t`统计` : tasksOpen ? t`任务看板` : automationsOpen ? t`自动化` : marksOpen ? t`收藏夹` : designOpen ? t`设计规范` : quickChat ? t`快速对话` : assistantPage ? t`个人助理` : project?.name);

  const upsertSession = lists.upsertSession;
  const upsertTerminal = lists.upsertTerminal;

  const openPage = useCallback((page: NavPage) => {
    if (page === 'extensions' && nav.get().extensionsOpen || page === 'plugins' && nav.get().pluginsOpen) { ui.setMobileSidebar(false); return; }
    void nav.navigate(() => { nav.openPage(page); ui.setMobileSidebar(false); });
  }, [nav, ui]);
  const openSettingsAt = useCallback((section?: SettingsSection) => {
    if (section === 'integrations') { openPage('plugins'); return; }
    if (section === 'design') { openPage('design'); return; }
    if (section?.includes('/')) { void nav.navigate(() => nav.openPlugins(section.split('/')[0], section)); return; }
    void nav.navigate(() => { ui.openSettings(section); ui.setMobileSidebar(false); });
  }, [nav, ui]);
  const { loadBootstrap, bootstrapFailed, refreshBackends, homeProfilesKey, loadCatalog } = useWorkbenchBootstrap({ loaded, project: catalogProject, session: catalogSession, backends, homeBackendId, homeProfileId, catalogRevision, catalogBackendId, catalogProfileId, catalogKey });
  // The same for the per-provider lists, while `loadProfiles` has not published this key yet.
  const profilesCurrent = profileCatalogs?.key === homeProfilesKey;
  const peekedProfiles = useMemo(() => {
    const profiles = backends.find((entry) => entry.backendId === homeBackendId)?.profiles ?? [];
    if (profilesCurrent || session || quickChat || (!project && !projectlessTasks) || profiles.length < 2) return undefined;
    const entries = catalog.peekProfiles(project?.id ?? '', homeBackendId, profiles);
    return entries.length ? entries : undefined;
  }, [profilesCurrent, session, quickChat, project, projectlessTasks, backends, homeBackendId, catalog]);
  const { creationRestore, pendingCreations, recoverCreation, newSession, selectProject, selectNoProject, acknowledgeCreation, selectSession, openMessageHit, openMark, openLaunched, findSession, openSessionById, openImported, onAttemptsStarted, createNative, reopenNative, sessionAction } = useSessionActions({ loaded, project, session, sessions, terminals, nativeRunSeed, homeBackendId, homeProfileId, loadBootstrap });
  useGlobalShortcuts(desktop, newSession);
  const pluginCommands = usePluginCommands({ project: quickChat ? undefined : project, sessionId: session?.id, openSession: openSessionById });
  const selectHomeTab = (tab: HomeTab) => {
    if (tab === homeTab) return;
    const target = tab === 'chat' ? quickChatProject : projectlessTasks ? regular.find((item) => item.id === taskProjectId && !item.archivedAt) : lastTaskProject;
    // These are two launch targets for one draft. Task references stay parked while chat is active.
    void nav.navigate(() => {
      nav.set({ projectId: target?.id ?? '', sessionId: '', ...NO_PAGE });
      ui.set({ previewTarget: undefined });
    });
  };
  /** Its page: sidebar row, then the main conversation or, before there is one, the empty state (docs/ASSISTANT.md). */
  const openAssistant = () => {
    if (!assistantProject) return;
    void nav.navigate(() => {
      nav.set({ projectId: assistantProject.id, sessionId: assistantMain?.id ?? '', ...NO_PAGE });
      ui.set({ previewTarget: undefined });
      ui.setMobileSidebar(false);
    });
  };
  // Every way onto the 助理 with no conversation selected (a restored position, a link, the sidebar's
  // group) lands on its main conversation instead of a page that would start a second one.
  useEffect(() => {
    if (loaded && assistantMain && selectedProjectId === assistantMain.projectId && !selectedSessionId) nav.set({ sessionId: assistantMain.id });
  }, [loaded, assistantMain, selectedProjectId, selectedSessionId, nav]);
  const onAssistantMain = Boolean(assistantMain && session?.id === assistantMain.id);
  useEffect(() => { if (onAssistantMain) settingsStore.syncAssistantTimeZone(); }, [onAssistantMain, settings.assistant?.timeZone]);
  const inboxCount = useMemo(() => workItemList ? viewWorkItems(workItemList, sessions).filter((entry) => entry.inInbox).length : 0, [workItemList, sessions]);
  /** 开始 on a 任务: its first conversation, with its assignee's defaults, while the reader stays on the board. */
  const startWorkItem = async (item: WorkItem): Promise<boolean> => {
    if (item.assignee.kind !== 'agent') return false;
    const target = item.projectId ? regular.find((entry) => entry.id === item.projectId && !entry.archivedAt) : undefined;
    if (item.projectId && !target) { toast.error(t`这个任务的项目已移除或归档`); return false; }
    if (!target && !projectlessTasks) { toast.error(t`先为这个任务选一个项目`); return false; }
    // The server writes the first message: what the task is, what done means, what came before (docs/TASK-BOARD.md §6).
    let prompt: string;
    try { prompt = (await api.workItemBrief(item.id)).text; }
    catch (error) { toast.error(errorMessage(error, t`无法开始这个任务`)); return false; }
    return Boolean(await createNative({ ...(target ? { projectId: target.id } : { projectless: true }), title: item.title, prompt, attachments: [], context: [], backendId: item.assignee.backendId, workItemId: item.id, follow: false }));
  };
  const { projectAction, addProject, startSessionInDirectory, startIsolatedDirectory, openWorktreeProject, onWorktreeMerged, chooseSessionDirectory, openInEditor } = useProjectActions({ project, loadBootstrap, selectProject });
  const { createShell, closeTerminal } = useTerminalActions();

  // Stable, so the memoized sidebar rows and pages are not re-rendered by the shell's own renders.
  const onSessionAction = useCallback((target: Session, action: SessionAction) => handlers.sessionAction(target, action), [handlers]);
  const openMobileSidebar = useCallback(() => ui.setMobileSidebar(true), [ui]);
  /** A ⌘/Ctrl-click opens the conversation as a kept tab rather than a preview. */
  const selectFromSidebar = useCallback((target: Session, keep?: boolean) => {
    if (keep) tabs.keepOnOpen(target.id);
    selectSession(target);
  }, [tabs, selectSession]);
  const expandSidebar = useCallback(() => ui.setSidebarCollapsed(false), [ui]);
  const setStatsState = useCallback((next: typeof statsState) => nav.set({ statsState: next }), [nav]);
  const closeStats = useCallback(() => nav.set({ statsOpen: false }), [nav]);
  const closeDesign = useCallback(() => nav.set({ designOpen: false }), [nav]);
  const openStatsSession = useCallback((row: StatsRunRow) => {
    const target = lists.get().sessions.find((item) => item.id === row.sessionId);
    if (target) handlers.selectSession(target);
    else nav.set({ statsOpen: false });
  }, [lists, nav, handlers]);

  const addReference = useCallback((reference: PromptContextReference) => {
    ui.addReference(reference);
    if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches) ui.setPanelOpen(false);
  }, [ui]);

  /**
   * Switches provider because a model belonging to it was chosen, so the model is saved in the
   * same write; `chooseBackend` deliberately clears the model instead, having no replacement.
   */
  const chooseHomeProfile = (profileId: string, model: string) => {
    if (assistantHome) { settingsStore.rememberAssistant({ backendId: homeBackendId, profileId, model }); return; }
    catalog.setHomeProfile(profileId);
    settingsStore.remember(homeBackendId, { profileId, model });
  };
  /** `model` comes with an agent picked through one of its models; without one a new provider clears the old model. */
  const chooseBackend = (backendId: NativeBackendId, profileId?: string, model?: string) => {
    if (assistantHome) { settingsStore.rememberAssistant({ backendId, profileId: profileId ?? null, model: model || null }); return; }
    catalog.setHome(backendId, profileId ?? settings.nativeBackendDefaults?.[backendId]?.profileId);
    writeStored(STORAGE_KEYS.backend, backendId);
    const savedProfile = settings.nativeBackendDefaults?.[backendId]?.profileId ?? backends.find((entry) => entry.backendId === backendId)?.profiles.find((entry) => entry.isDefault)?.id;
    settingsStore.remember(backendId, { ...(profileId ? { profileId } : {}), ...(model !== undefined ? { model } : profileId && profileId !== savedProfile ? { model: '' } : {}) }, true);
  };
  const rememberModel = (model: string) => assistantHome
    ? settingsStore.rememberAssistant({ backendId: homeBackendId, profileId: homeProfileId ?? null, model: model || null })
    : settingsStore.remember(homeBackendId, { model });

  // The stores, the notification click and the header reach these through the handlers bag.
  useEffect(() => {
    handlers.selectSession = selectSession;
    handlers.reload = () => void loadBootstrap().catch(bootstrapFailed);
    handlers.sessionAction = (target, action) => void sessionAction(target, action);
    handlers.openMark = (id) => void openMark(id);
  });

  /** Stable per conversation, so the conversation's header memo is not rebuilt as the page re-renders. */
  const sessionHeaderId = session?.id;
  const renderSessionHeader = useMemo(() => (slots: HeaderSlots) => <WorkbenchHeader sessionId={sessionHeaderId} slots={slots} />, [sessionHeaderId]);

  if (!loaded) {
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg px-6 text-center">
        {bootError ? (
          <>
            <BrandMark className="size-9 text-fg" />
            <div className="flex max-w-sm flex-col gap-1"><p className="text-base font-medium text-fg"><Trans>无法加载工作台</Trans></p><p className="text-sm text-fg-3">{bootError}</p></div>
            <Button onClick={() => void loadBootstrap().catch(bootstrapFailed)}><Trans>重试</Trans></Button>
          </>
        ) : <LiveBrandMark fixed="run" className="size-12 text-fg" />}
      </main>
    );
  }

  const sidebar = (mobile: boolean) => (
    <Sidebar
      projects={projects.filter((item) => !isQuickChatProject(item))}
      onSelectNoProject={projectlessTasks ? selectNoProject : undefined}
      sessions={sessions}
      selectedProjectId={selectedProjectId}
      selectedSessionId={session?.id ?? ''}
      backend={backend}
      onSelectProject={selectProject}
      onSelectSession={selectFromSidebar}
      onNewSession={newSession}
      onAddProject={() => { void nav.navigate(() => { ui.set({ addProjectOpen: true }); ui.setMobileSidebar(false); }); }}
      onProjectAction={(target, action) => void projectAction(target, action)}
      onSessionAction={onSessionAction}
      onOpenSettings={() => openSettingsAt()}
      onOpenProfile={() => openSettingsAt('profile')}
      onOpenStats={() => openPage('stats')}
      {...(assistantProject ? { onOpenAssistant: openAssistant, assistantActive: assistantPage, ...(assistantMain ? { assistantSession: assistantMain } : {}) } : {})}
      {...(workItemsSupported ? { onOpenTasks: () => openPage('tasks'), tasksActive: tasksOpen, tasksCount: inboxCount } : {})}
      onOpenAutomations={() => openPage('automations')}
      onOpenExtensions={() => openPage('extensions')}
      onOpenPlugins={() => openPage('plugins')}
      pluginsActive={pluginsOpen}
      onOpenMarks={() => openPage('marks')}
      onOpenSearch={ui.openSearch}
      statsActive={statsOpen}
      automationsActive={automationsOpen}
      extensionsActive={extensionsOpen}
      marksActive={marksOpen}
      {...(listsState === 'fresh' ? {} : { stale: { mode: listsState, savedAt: listsSavedAt } })}
      {...(mobile ? { onClose: () => ui.setMobileSidebar(false) } : sidebarCollapsed ? { onPin: () => ui.setSidebarCollapsed(false) } : { onCollapse: () => ui.setSidebarCollapsed(true) })}
    />
  );

  const nativeTerminal = session?.kind === 'native' ? terminals.find((item) => item.id === session.terminalId) ?? terminals.find((item) => item.sessionId === session.id && !isShellTerminal(item)) : undefined;
  const homeCatalogState = { catalog: standInCatalog ?? nativeCatalog, catalogLoading, catalogError: nativeCatalogError };
  /** What every new-conversation composer shares: the project page's. */
  const composerProps = {
    directories: recentDirectories,
    settings: composerSettings,
    backends,
    backendId: homeBackendId,
    profileId: homeProfileId,
    backend,
    profileCatalogs: profileCatalogs?.key === homeProfilesKey ? profileCatalogs.entries : peekedProfiles,
    onBackendChange: chooseBackend,
    onProfileChange: chooseHomeProfile,
    ...homeCatalogState,
    onRetryCatalog: loadCatalog,
    onRefreshCatalog: () => {
      const projectId = project?.id ?? '';
      const profiles = backend?.profiles ?? [];
      if ((projectId || projectlessTasks) && profiles.length > 1) void catalog.loadProfiles(projectId, homeBackendId, profiles, homeProfilesKey, true);
      void loadCatalog();
    },
    busy: creating,
    references,
    sessionReferences,
    referenceSessions: sessions,
    onOpenReferenceSession: openSessionById,
    onReferencesChange: ui.setReferences,
    onCreate: createNative,
    onCreationPersisted: acknowledgeCreation,
    creationRestore,
    pendingCreations,
    onRecoverCreation: recoverCreation,
    onSelectNoProject: projectlessTasks ? selectNoProject : undefined,
    onError: pushError,
    onRememberModel: rememberModel,
  };

  // The 助理's empty state is its page, not the new-session page: its header is the 助理 title row.
  const homeHeader = <WorkbenchHeader center={quickChatProject && !assistantPage && <UnderlineTabs
    value={homeTab}
    onChange={selectHomeTab}
    ariaLabel={t`新建会话`}
    className="h-9"
    options={[
      { value: 'task' as const, label: t`新建任务` },
      ...(quickChatProject ? [{ value: 'chat' as const, label: t`快速对话` }] : []),
    ]}
  />} />;

  let content: ReactNode;
  if (pluginsOpen) {
    content = <PluginsPage availableViewIds={[...sidebarViews, ...sessionViews].map(view => view.id)} onOpenModels={() => openSettingsAt('providers')} commandActions={pluginCommands.actions()} rejectedKeybindings={pluginCommands.rejectedKeybindings} onOpenAppearance={() => openSettingsAt('appearance')} selectedId={pluginId} selectedViewId={pluginViewId} initialTab={pluginDetailTab} openRevision={pluginOpenRevision} projectId={project?.id} sessionId={session?.id}
      onSelect={(id, tab = 'overview') => nav.set({ pluginId: id, pluginViewId: '', pluginDetailTab: tab })}
      onClose={() => { void nav.navigate(() => nav.set({ pluginsOpen: false })); }}
      onBeforeLeaveChange={nav.registerPluginBeforeLeave}
      sidebarCollapsed={desktop && sidebarCollapsed}
      onOpenSidebar={openMobileSidebar}
      onExpandSidebar={expandSidebar}
      onOpenFeature={(view) => { void nav.navigate(() => {
        nav.set({ pluginsOpen: false });
        if (view.locations.includes('session-view') && session) { setViewVisible(view.id, true); nav.set({ sessionView: { sessionId: session.id, view: view.id } }); }
        else { ui.set({ panelTab: view.id }); ui.setPanelOpen(true); }
      }); }} />;
  } else if (extensionsOpen) {
    content = null;
  } else if (statsOpen) {
    content = (
      <StatsPage
        state={statsState}
        sidebarCollapsed={desktop && sidebarCollapsed}
        onStateChange={setStatsState}
        onClose={closeStats}
        onOpenSidebar={openMobileSidebar}
        onExpandSidebar={expandSidebar}
        onOpenSession={openStatsSession}
      />
    );
  } else if (marksOpen) {
    content = (
      <MarksPage
        projects={projects}
        sidebarCollapsed={desktop && sidebarCollapsed}
        onClose={() => nav.set({ marksOpen: false })}
        onOpenSidebar={openMobileSidebar}
        onExpandSidebar={expandSidebar}
        onOpenMark={(id) => void openMark(id)}
        onOpenMarkFile={(mark) => void openMark(mark.id).then(() => { if (mark.asset?.path) ui.preview(mark.asset.path); })}
      />
    );
  } else if (designOpen) {
    content = (
      <DesignPage
        sidebarCollapsed={desktop && sidebarCollapsed}
        onClose={closeDesign}
        onOpenSidebar={openMobileSidebar}
        onExpandSidebar={expandSidebar}
      />
    );
  } else if (attemptsGroupId) {
    content = (
      <AttemptGroupPage
        groupId={attemptsGroupId}
        findSession={findSession}
        onOpenSession={openSessionById}
        onAdopted={onWorktreeMerged}
        onError={pushError}
        onClose={() => nav.set({ attemptsGroupId: '' })}
      />
    );
  } else if (tasksOpen) {
    content = (
      <WorkItemsPage
        projects={regular}
        sessions={sessions}
        backends={backends}
        sidebarCollapsed={desktop && sidebarCollapsed}
        onClose={() => nav.set({ tasksOpen: false })}
        onOpenSidebar={openMobileSidebar}
        onExpandSidebar={expandSidebar}
        onOpenSession={openSessionById}
        onStart={startWorkItem}
      />
    );
  } else if (automationsOpen) {
    content = (
      <AutomationsPage
        projects={regular}
        project={project && !project.system ? project : undefined}
        sessions={sessions}
        backends={backends}
        enterBehavior={settings.composerEnterBehavior}
        sidebarCollapsed={desktop && sidebarCollapsed}
        onClose={() => nav.set({ automationsOpen: false })}
        onOpenSidebar={openMobileSidebar}
        onExpandSidebar={expandSidebar}
        onOpenSession={openSessionById}
        onError={pushError}
      />
    );
  } else if ((!project && !projectlessTasks) || (selectedSessionId && !project)) {
    content = <NoProjects onAddProject={() => ui.set({ addProjectOpen: true })} header={homeHeader} />;
  } else if (session?.kind === 'native') {
    content = (
      <NativeSession
        key={session.id}
        session={session}
        {...(focusMessage?.sessionId === session.id ? { focus: focusMessage.focus } : {})}
        initialRun={nativeRunSeed?.sessionId === session.id ? nativeRunSeed.run : undefined}
        terminal={quickChat ? undefined : nativeTerminal}
        root={quickChat ? undefined : project?.cwd}
        reopening={startingNativeId === session.id}
        sendingInitial={false}
        catalog={nativeCatalog}
        {...(currentCatalog?.entry.continuations ? { continuations: currentCatalog.entry.continuations } : {})}
        backendCapabilities={backend?.capabilities}
        catalogLoading={homeCatalogState.catalogLoading}
        catalogError={nativeCatalogError}
        onRetryCatalog={loadCatalog}
        onReopen={() => void reopenNative(session)}
        onTerminalChanged={upsertTerminal}
        onSessionChanged={upsertSession}
        {...(quickChat ? {} : { onRememberModel: (model: string) => settingsStore.remember(sessionBackend(session), { model, ...(session.backendProfileId ? { profileId: session.backendProfileId } : {}) }) })}
        onError={pushError}
        notificationsEnabled={settings.notifications === true}
        enterBehavior={settings.composerEnterBehavior}
        runningBehavior={settings.composerRunningBehavior}
        sendLaterEnabled={settings.composerSendLater === true}
        sessionReferences={sessionReferences}
        referenceSessions={sessions}
        referenceProjects={projects}
        references={quickChat ? NO_REFERENCES : references}
        onReferencesChange={quickChat ? noReferences : ui.setReferences}
        // The 个人助理's files are not read through the workspace routes, so a path in its conversation is plain text.
        {...(isAssistantProject(project) ? {} : { onOpenPath: ui.preview })}
        onOpenInEditor={openInEditor}
        renderHeader={renderSessionHeader}
        onLaunched={openLaunched}
        backends={quickChat ? [] : backends}
        findSession={findSession}
        onOpenSession={openSessionById}
        onAttemptAdopted={onWorktreeMerged}
        onOpenAttemptGroup={(group) => nav.openAttemptsGroup(group.id)}
        {...(sessionView?.sessionId === session.id ? { initialView: sessionView.view } : {})}
        onViewChange={(view) => nav.set({ sessionView: { sessionId: session.id, view } })}
        quickChat={quickChat}
      />
    );
  } else {
    content = (
      <NewSessionHome
        {...composerProps}
        backendId={quickChat ? 'chat' : homeBackendId}
        profileId={quickChat ? undefined : homeProfileId}
        profileCatalogs={quickChat ? undefined : composerProps.profileCatalogs}
        recentModel={recentModel}
        project={project}
        referenceProjectId={quickChat ? taskProjectId ?? '' : project?.id ?? ''}
        sessions={sessions.filter((item) => project ? item.projectId === project.id : projects.some((target) => target.id === item.projectId && target.system === 'task-workspace'))}
        onSelectProject={selectProject}
        onChooseDirectory={() => void chooseSessionDirectory()}
        onOpenDirectory={(path) => void startSessionInDirectory(path)}
        onCreateWorktree={project && !project.system ? () => void startIsolatedDirectory() : undefined}
        isolating={creatingWorktree}
        onOpenShell={() => void createShell()}
        onAttemptsStarted={onAttemptsStarted}
        onOpenAttemptGroup={(group) => nav.openAttemptsGroup(group.id)}
        onSelectSession={selectSession}
        onSessionAction={onSessionAction}
        header={homeHeader}
      />
    );
  }

  const shownTab = () => shownView(sidebarViews, ui.get().panelTab)?.id;
  const panelShows = (tab: string) => ui.get().panelOpen && shownTab() === tab;
  const composerShown = !attemptsGroupId && !pageOpen && Boolean(project) && !session?.archivedAt;
  /** Built when the palette opens, so the labels describe the workbench as it is then. */
  const paletteActions = (): PaletteAction[] => [
    { id: 'new-session', label: t`新建会话`, keywords: 'new conversation', icon: <IconMessageCirclePlus className="size-4 shrink-0 text-fg-3" />, run: newSession },
    ...(assistantProject ? [{ id: 'open-assistant', label: t`打开个人助理`, keywords: 'assistant', icon: <IconBot className="size-4 shrink-0 text-fg-3" />, run: openAssistant }] : []),
    { id: 'open-stats', label: t`打开统计`, keywords: 'stats statistics 统计 用量', icon: <IconChartColumn className="size-4 shrink-0 text-fg-3" />, run: () => openPage('stats') },
    // i18n-ignore: search keywords in both languages, not interface text
    ...(workItemsSupported ? [{ id: 'open-work-items', label: t`打开任务看板`, keywords: 'tasks board kanban inbox 任务 看板 收件箱', icon: <IconSquareKanban className="size-4 shrink-0 text-fg-3" />, run: () => openPage('tasks') }] : []),
    { id: 'open-automations', label: t`打开自动化`, keywords: 'automations templates schedules cron 模板 定时', icon: <IconCalendarClock className="size-4 shrink-0 text-fg-3" />, run: () => openPage('automations') },
    { id: 'open-marks', label: t`打开收藏夹`, keywords: 'marks bookmarks highlights saved 收藏 收藏夹 高亮 书签', icon: <IconBookmark className="size-4 shrink-0 text-fg-3" />, run: () => openPage('marks') },
    { id: 'open-plugins', label: t`管理插件`, keywords: 'plugins install packages', icon: <IconPuzzle className="size-4 shrink-0 text-fg-3" />, run: () => openPage('plugins') },
    { id: 'open-extensions', label: t`打开扩展管理`, keywords: 'extensions skills mcp plugins hooks rules commands 拓展 扩展 管理', icon: <IconPuzzle className="size-4 shrink-0 text-fg-3" />, run: () => openPage('extensions') },
    { id: 'toggle-sidebar', label: desktop ? (sidebarCollapsed ? t`展开侧栏` : t`收起侧栏`) : t`打开侧栏`, keywords: 'sidebar 侧栏', icon: <IconPanelLeft className="size-4 shrink-0 text-fg-3" />, run: () => { if (desktop) ui.setSidebarCollapsed((value) => !value); else ui.setMobileSidebar((value) => !value); } },
    ...(quickChat || isAssistantProject(project) ? [] : [{ id: 'toggle-terminal', label: ui.get().dockOpen ? t`隐藏终端` : t`显示终端`, keywords: 'terminal 终端', icon: <IconTerminal className="size-4 shrink-0 text-fg-3" />, run: () => { void nav.navigate(() => ui.setDockOpen((value) => !value)); } }]),
    ...(project && !quickChat && !pageOpen ? [
      ...(sidebarViews.some((view) => view.id === 'changes') ? [{ id: 'toggle-changes', label: panelShows('changes') ? t`收起变更面板` : t`打开变更面板`, keywords: 'git diff changes panel 变更 改动 差异', icon: <IconGitCompare className="size-4 shrink-0 text-fg-3" />, run: () => togglePanelTab(ui, 'changes', shownTab()) }] : []),
      ...(sidebarViews.some((view) => view.id === 'files') ? [{ id: 'toggle-files', label: panelShows('files') ? t`收起文件面板` : t`打开文件面板`, keywords: 'files explorer panel 文件 目录', icon: <IconFolder className="size-4 shrink-0 text-fg-3" />, run: () => togglePanelTab(ui, 'files', shownTab()) }] : []),
    ] : []),
    { id: 'toggle-color-mode', label: t`切换浅色 / 深色`, keywords: 'theme dark light appearance 主题 明暗 深色 浅色', icon: <IconMoon className="size-4 shrink-0 text-fg-3" />, run: () => setThemeMode(document.documentElement.classList.contains('dark') ? 'light' : 'dark') },
    ...(session && !session.archivedAt ? [{ id: 'focus-composer', label: t`聚焦输入框`, keywords: 'composer input focus 输入 消息', icon: <IconPencilLine className="size-4 shrink-0 text-fg-3" />, takesFocus: true, run: () => document.querySelector<HTMLTextAreaElement>('textarea[data-composer-input]')?.focus() }] : []),
    // Opens the composer's model list; `ModelPicker` has no handle on it other than its trigger.
    ...(composerShown ? [{ id: 'choose-model', label: t({ message: '选择模型', context: 'workbench-choose-model-action' }), keywords: 'model 模型 切换', icon: <IconBrain className="size-4 shrink-0 text-fg-3" />, takesFocus: true, run: () => {
      const trigger = document.querySelector<HTMLButtonElement>('main button[data-model-picker]:not(:disabled)');
      trigger?.focus();
      trigger?.click();
    } }] : []),
    ...(session && ['starting', 'running', 'waiting'].includes(session.state) ? [{ id: 'stop-run', label: t`停止当前运行`, keywords: 'stop cancel interrupt 停止 中断', icon: <IconSquare className="size-4 shrink-0 text-fg-3" />, run: () => { if (!sendSessionCommand(session.id, 'stop')) void api.cancelSession(session.id).catch((error) => pushError(errorMessage(error, t({ message: '无法停止', context: 'workbench-stop-failed' })))); } }] : []),
    ...(session ? [{ id: 'archive-session', label: session.archivedAt ? t`恢复当前会话` : t`归档当前会话`, keywords: 'archive restore 归档 恢复', icon: <IconArchive className="size-4 shrink-0 text-fg-3" />, run: () => void sessionAction(session, 'archive') }] : []),
    ...pluginCommands.actions(),
    { id: 'open-settings', label: t`打开设置`, keywords: 'settings preferences', icon: <IconSettings className="size-4 shrink-0 text-fg-3" />, run: () => openSettingsAt() },
    // The palette and the settings dialog list the same pages, the plugins' included.
    ...settingsSections.map(({ id, label, icon: Icon }) => ({ id: `settings:${id}`, label: t`设置：${label}`, keywords: `settings 设置 ${label}`, icon: <Icon className="size-4 shrink-0 text-fg-3" />, run: () => openSettingsAt(id) })),
  ];

  // Phones already show the panel over the whole screen, so fullscreen is a desktop affordance.
  const panelMaximized = panelFullscreen && desktop;
  const peeking = sidebarPeek.peek;
  const stripTabs = tabbed && tabStyle === 'strip';
  return (
    // Clip, not hide: the context panel and sidebar wait off-screen before they slide in, and a
    // hidden overflow still scrolls, so a `scrollIntoView` inside them would shove the whole window.
    <div className={cn('workbench-viewport relative flex h-dvh overflow-clip text-fg', desktop ? 'bg-canvas' : 'bg-bg')}>
      {desktop && (
        // ⌘B reserves the sidebar's room in one layout pass and slides the sidebar over it, like the
        // context panel: animating this width reflowed the conversation every frame and crossed the
        // session's own layout step mid-way. The conversation slides its columns to the new axis
        // itself (`useSessionLayout`).
        <aside
          className={cn('shrink-0', sidebarCollapsed ? 'w-0' : 'w-(--sidebar-w)')}
          aria-hidden={(sidebarCollapsed && !peeking) || undefined}
          inert={sidebarCollapsed && !peeking}
        >
          <div
            ref={sidebarPeek.panelRef}
            {...(peeking ? sidebarPeek.panelProps : {})}
            className={cn(
              'flex w-(--sidebar-w)',
              peeking
                ? 'fixed inset-y-2 left-2 z-(--z-panel) overflow-hidden rounded-xl bg-canvas shadow-peek animate-in fade-in-0 slide-in-from-left-3 duration-[var(--duration-base)] ease-[var(--ease-decelerate)]'
                : cn('absolute inset-y-0 left-0 z-(--z-panel) transition-[translate] duration-[var(--duration-slow)] ease-out-soft', sidebarCollapsed ? '-translate-x-full' : 'translate-x-0', leavingPeek && 'transition-none'),
            )}
          >
            {sidebar(false)}
            {!sidebarCollapsed && !peeking && (
              <ResizeHandle
                axis="x"
                grow={1}
                value={sidebarWidth}
                min={SIDEBAR_MIN}
                // A docked context panel keeps its place: the sidebar stops before the window would
                // have to turn the panel into an overlay.
                max={() => {
                  const { panelOpen, panelWidth } = ui.get();
                  const docked = wide && panelOpen && !pageOpen && !quickChat;
                  return Math.min(sidebarMaxWidth(), docked ? window.innerWidth - panelDockMinWidth(0, panelWidth) : Infinity);
                }}
                label={t`调整侧栏宽度`}
                onPreview={(width) => paintPaneWidth('sidebar', width)}
                onChange={(width) => ui.set({ sidebarWidth: width })}
                onReset={() => ui.set({ sidebarWidth: SIDEBAR_DEFAULT })}
                onCollapse={() => {
                  ui.setSidebarCollapsed(true);
                  // It slides away at the drag's minimum, then takes back its width out of sight.
                  window.setTimeout(() => paintPaneWidth('sidebar', ui.get().sidebarWidth), 300);
                }}
                // Level with the conversation's card, not the window's edges.
                className={cn('absolute bottom-2 -right-1 w-2', stripTabs ? 'top-11' : 'top-2')}
              />
            )}
          </div>
        </aside>
      )}
      {desktop && sidebarCollapsed && <div aria-hidden className="fixed inset-y-0 left-0 z-(--z-panel) w-2" {...sidebarPeek.edgeProps} />}
      {!desktop && (
        <MobileSidebar open={mobileSidebar} onOpenChange={ui.setMobileSidebar}>
          {sidebar(true)}
        </MobileSidebar>
      )}

      <SidebarPeekTrigger.Provider value={desktop && sidebarCollapsed ? sidebarPeek.triggerProps : null}>
      <TabChromeContext.Provider value={tabChrome}>
      <div className="flex min-w-0 flex-1 flex-col">
      {tabbed && tabStyle === 'strip' && (
        // Stats, tasks, marks and extensions carry their own expand button under the strip.
        <TabBar variant="strip" activeId={anyPageOpen || assistantPage ? '' : session?.id ?? ''} sidebarCollapsed={sidebarCollapsed && !pageOpen} onExpandSidebar={expandSidebar} onNewSession={newSession} actionsRef={setTabActions} />
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
      <main
        className={cn('flex min-w-0 flex-1 flex-col', desktop && 'mb-2 mr-2 overflow-hidden rounded-xl bg-bg', desktop && !stripTabs && 'mt-2', desktop && sidebarCollapsed && 'ml-2')}
        aria-hidden={(panelMaximized && wide) || undefined}
        inert={panelMaximized && wide}
      >
        {tabbed && tabStyle === 'inline' && !anyPageOpen && !assistantPage && (
          <TabBar variant="inline" activeId={session?.id ?? ''} sidebarCollapsed={sidebarCollapsed} onExpandSidebar={expandSidebar} onNewSession={newSession} actionsRef={setTabActions} />
        )}
        {/* Scoped to the conversation/home region so a bad row cannot take the sidebar or the
            terminal dock down with it, and so switching sessions clears the failure. */}
        {extensionsMounted && <div className={cn('min-h-0 flex-1 flex-col', extensionsOpen ? 'flex' : 'hidden')} aria-hidden={!extensionsOpen || undefined} inert={!extensionsOpen}>
          <ErrorBoundary resetKey={String(extensionsOpen)}><Suspense fallback={loadingPanel}><ExtensionsPage
            active={extensionsOpen}
            projects={extensionProjects}
            backends={backends}
            initialBackend={catalogBackendId}
            focus={extensionsFocus}
            sidebarCollapsed={desktop && sidebarCollapsed}
            onClose={nav.closeExtensions}
            onOpenSidebar={openMobileSidebar}
            onExpandSidebar={expandSidebar}
            onError={pushError}
            onBeforeLeaveChange={nav.registerBeforeLeave}
          /></Suspense></ErrorBoundary>
        </div>}
        <ErrorBoundary resetKey={`${project?.id ?? ''}:${session?.id ?? ''}`}>
          <Suspense fallback={loadingPanel}>{content}</Suspense>
        </ErrorBoundary>
        <DockHost mode="desktop" show={desktop && Boolean(project) && !pageOpen && !quickChat && !isAssistantProject(project)} onCreate={() => void createShell()} onChanged={upsertTerminal} onClose={(terminal) => void closeTerminal(terminal)} onError={pushError} />
      </main>

      <PanelHost
        project={project}
        sessionId={session?.id}
        desktop={desktop}
        wide={wide}
        pageOpen={pageOpen || quickChat}
        belowTabStrip={stripTabs}
        onReference={addReference}
        onOpenWorktree={(path) => void openWorktreeProject(path)}
        onWorktreeMerged={onWorktreeMerged}
        onError={pushError}
      />
      </div>
      </div>
      </TabChromeContext.Provider>
      </SidebarPeekTrigger.Provider>
      <DockHost mode="mobile" show={!desktop && Boolean(project) && !pageOpen && !quickChat && !isAssistantProject(project)} onCreate={() => void createShell()} onChanged={upsertTerminal} onClose={(terminal) => void closeTerminal(terminal)} onError={pushError} />

      <WorkbenchOverlays
        addProject={addProject}
        paletteActions={paletteActions}
        startSessionInDirectory={startSessionInDirectory}
        onRefreshBackends={async () => { await refreshBackends(); await loadCatalog(); }}
        onLogout={onLogout ? () => { void nav.navigate(onLogout); } : undefined}
        onSelectSession={selectSession}
        onSelectProject={selectProject}
        onOpenMessage={openMessageHit}
        onImported={openImported}
        onError={pushError}
      />
      {pluginCommands.dialogs}
      <AppearanceBackdrop />
    </div>
  );
}
