import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { SETTING_DEFAULTS, type NativeBackendId, type Session, type StatsRunRow, type Task, type WorkItem } from '@contracts';
import { focusTask } from '@/lib/tasks';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ResizeHandle } from '@/components/ui/resize-handle';
import { EmptyState, UnderlineTabs } from '@/components/ui/controls';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { IconArchive, IconSquareKanban, IconBookmark, IconBot, IconBrain, IconCalendarClock, IconChartColumn, IconFolder, IconGitCompare, IconMessagesSquare, IconPuzzle, IconMessageCirclePlus, IconMoon, IconPanelLeft, IconPencilLine, IconSettings, IconSquare, IconTerminal, IconWrench } from '@/components/icons';
import { MOBILE_LAYOUT_QUERY, useMediaQuery, useMobileViewport } from '@/lib/use-media-query';
import { BrandMark, LiveBrandMark } from '@/components/BrandMark';
import { RunnerGame } from '@/components/runner/RunnerGame';
import { runnerFits } from '@/components/runner/RunnerDock';
import { openRunner } from '@/components/runner/store';
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
import { councilAttention } from './state/councilStore';
import { readDraft, writeDraft } from './session/Composer';
import { joinQuotes, splitQuotes } from './session/quotes';
import { useSidebarSessions } from './useSidebarSessions';
import { MobileSidebar } from './MobileSidebar';
import { NativeSession } from './terminal/NativeSession';
import { AttemptGroupPage } from './session/Attempts';
import { SessionFrame } from './session/sessionFrame';
import { SidebarPeekTrigger, useSidebarPeek } from './use-sidebar-peek';
import { useWorkbenchBootstrap } from './use-workbench-bootstrap';
import { useGlobalShortcuts } from './use-global-shortcuts';
import { usePluginCommands } from './usePluginCommands';
import { clearContext, useSessionActions } from './use-session-actions';
import { useProjectActions } from './use-project-actions';
import { useTerminalActions } from './use-terminal-actions';
import { useHomeServerOptions } from './useServerLabel';
import { settingsSections, type SettingsSection } from './settings/settingsSections';
import { SettingsSidebar } from './settings/SettingsSidebar';
import { runSettingsTransition } from '@/lib/view-transition';
import { createWorkbenchStores, StoresProvider, useCatalog, useLists, useNav, useSettings, useStores, useApprovals, useCouncil, useUi, useWorkItems, WorkbenchEffects } from './state/stores';
import { countWorkItemInbox } from './work-items/model';
import { NO_PAGE, STORAGE_KEYS, type NavPage } from './state/navStore';
import { paintPaneWidth, panelDockMinWidth, SIDEBAR_DEFAULT, SIDEBAR_MIN, sidebarMaxWidth } from './state/uiStore';
import { togglePanelTab, WorkbenchHeader } from './WorkbenchHeader';
import { useSessionViews, setViewVisible } from './session/viewPrefs';
import { shownView, useSidebarViews } from './panels/useSidebarViews';
import { DockHost, loadingPanel, PanelHost } from './WorkbenchPanels';
import { PageScaffold } from './PageScaffold';
import { PluginView } from '@/plugins/PluginView';
import { viewIcon } from '@/plugins/viewIcons';
import { useViewCatalog } from '@/plugins/registry';
import { mainViewsIn } from '@/plugins/catalog';
import { serverOfObject } from '@/lib/server-routing';
import { TabChromeContext } from './tabs/chrome';
import { TabBar } from './tabs/TabBar';
import { useTabs } from './tabs/useTabs';
import { AppearanceBackdrop } from '@/components/appearance-backdrop';
import { WorkbenchOverlays } from './WorkbenchOverlays';
import { Onboarding } from './onboarding/Onboarding';
import { useFirstRun } from './onboarding/useFirstRun';
import { isAssistantProject, isQuickChatProject, mainSessionIdOf, regularProjects, sortProjectsByRecentUse } from '@/lib/project-family';
import { assistantChoice, isAssistantBackend, withAssistantDefaults } from './work-items/assistant';
const StatsPage = lazy(() => import('./stats/StatsPage').then((module) => ({ default: module.StatsPage })));
const WorkItemsPage = lazy(() => import('./work-items/WorkItemsPage').then((module) => ({ default: module.WorkItemsPage })));
const AutomationsPage = lazy(() => import('./automations/AutomationsPage').then((module) => ({ default: module.AutomationsPage })));
const CouncilPage = lazy(() => import('./council/CouncilPage').then((module) => ({ default: module.CouncilPage })));
const ExtensionsPage = lazy(() => import('./extensions/ExtensionsPage').then((module) => ({ default: module.ExtensionsPage })));
const PluginsPage = lazy(() => import('./plugins/PluginsPage').then((module) => ({ default: module.PluginsPage })));
const MarksPage = lazy(() => import('./marks/MarksPage').then((module) => ({ default: module.MarksPage })));
const SettingsPage = lazy(() => import('./settings/SettingsPage').then((module) => ({ default: module.SettingsPage })));

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
  const { lists, nav, ui, tabs, catalog, settings: settingsStore, handlers, workItems } = useStores();
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
  const bootUnreachable = useLists((state) => state.bootUnreachable);
  const firstRun = useFirstRun({ fresh: loaded && listsState === 'fresh', hasSessions: sessions.length > 0 });
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
  const councilOpen = useNav((state) => state.councilOpen);
  const councilState = useCouncil((state) => councilAttention(state.items));
  const workItemSummaries = useWorkItems((state) => state.summaries);
  const workItemsSupported = useWorkItems((state) => state.supported);
  const extensionsOpen = useNav((state) => state.extensionsOpen);
  const extensionsMounted = useNav((state) => state.extensionsMounted);
  const marksOpen = useNav((state) => state.marksOpen);
  const settingsOpen = useNav((state) => state.settingsOpen);
  const settingsSection = useNav((state) => state.settingsSection);
  const mainViewId = useNav((state) => state.mainViewId);
  const attemptsGroupId = useNav((state) => state.attemptsGroupId);
  const sessionView = useNav((state) => state.sessionView);
  const statsState = useNav((state) => state.statsState);
  const focusMessage = useNav((state) => state.focusMessage);
  const sidebarCollapsed = useUi((state) => state.sidebarCollapsed);
  const mobileSidebar = useUi((state) => state.mobileSidebar);
  const panelFullscreen = useUi((state) => state.panelFullscreen);
  const references = useUi((state) => state.references);
  const extensionsFocus = useUi((state) => state.extensionsFocus);
  const pendingProviderTarget = useUi((state) => state.pendingProviderTarget);
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
  const remoteBackendsMap = useCatalog((state) => state.remoteBackends);
  const remoteSettingsMap = useCatalog((state) => state.remoteSettings);
  const remoteHomeMap = useCatalog((state) => state.remoteHome);

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
  // Stable between list updates, so the sidebar's grouping does not rerun on every render of the page.
  const sidebarProjects = useMemo(() => projects.filter((item) => !isQuickChatProject(item)), [projects]);
  const assistantProject = useMemo(() => projects.find((item) => isAssistantProject(item) && !item.archivedAt), [projects]);
  // The 助理's directory has extensions of its own, reached from its page.
  const extensionProjects = useMemo(() => assistantProject ? [{ ...assistantProject, name: t`个人助理` }, ...regular] : regular, [regular, assistantProject, t]);
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
  const homeServerOptions = useHomeServerOptions();
  /** Only set when the reader picked a linked server that has no registered projects yet. */
  const [pickedServerId, setPickedServerId] = useState('');
  const homeServerId = project && !project.system
    ? (serverOfObject(project.id) ?? '')
    : (pickedServerId && homeServerOptions.some((item) => item.id === pickedServerId && item.usable) ? pickedServerId : '');
  useEffect(() => { if (project && !project.system && pickedServerId) setPickedServerId(''); }, [project, pickedServerId]);
  useEffect(() => { if (pickedServerId && !homeServerOptions.some((item) => item.id === pickedServerId && item.usable)) setPickedServerId(''); }, [pickedServerId, homeServerOptions]);
  // The 助理 page's composer starts with the 助理's own agent and model, and a pick made there is the
  // 助理's, not the composer's everywhere else (docs/ASSISTANT.md).
  const assistantHome = isAssistantProject(project) && !session;
  // On the new-session page targeting a linked server, the agent list, providers and read-only
  // defaults come from that server so the conversation starts with what can actually run there.
  const remoteHomeServerId = !session && !quickChat && !assistantHome ? homeServerId : '';
  useEffect(() => { if (remoteHomeServerId) void catalog.loadRemote(remoteHomeServerId); }, [remoteHomeServerId, catalog]);
  const remoteBackendsLoaded = !remoteHomeServerId || remoteBackendsMap[remoteHomeServerId] !== undefined;
  const remoteBackends = remoteHomeServerId ? (remoteBackendsMap[remoteHomeServerId] ?? []) : undefined;
  const remoteSettings = remoteHomeServerId ? remoteSettingsMap[remoteHomeServerId] : undefined;
  const remoteHomeChoice = remoteHomeServerId ? remoteHomeMap[remoteHomeServerId] : undefined;
  const assistantPick = useMemo(() => assistantHome ? assistantChoice(settings.assistant, backends) : undefined, [assistantHome, settings.assistant, backends]);
  // The 助理 runs only on the agents that isolate it (docs/ASSISTANT.md §4).
  const homeBackends = useMemo(() => remoteBackends ?? (assistantHome ? backends.filter((entry) => isAssistantBackend(entry.backendId)) : backends), [remoteBackends, assistantHome, backends]);
  const homeBackendId = remoteHomeServerId ? (remoteHomeChoice?.backendId ?? pickedBackendId) : (assistantPick?.backendId ?? pickedBackendId);
  const homeProfileId = remoteHomeServerId
    ? (remoteHomeChoice?.profileId ?? remoteSettings?.nativeBackendDefaults?.[homeBackendId]?.profileId)
    : (assistantPick ? assistantPick.profileId : pickedProfileId);
  /** The model the composer opens with: under a linked server, its read-only defaults with this browser's composer UI prefs; under the 助理, its own. */
  const composerSettings = useMemo(() => {
    if (remoteHomeServerId) {
      return remoteSettings
        ? { ...remoteSettings, composerEnterBehavior: settings.composerEnterBehavior, composerRunningBehavior: settings.composerRunningBehavior, composerSendLater: settings.composerSendLater }
        : settings;
    }
    return assistantPick ? withAssistantDefaults(settings, assistantPick) : settings;
  }, [remoteHomeServerId, remoteSettings, settings, assistantPick]);
  const sidebarViews = useSidebarViews(project, session?.id);
  const sessionViews = useSessionViews({ hasProject: Boolean(project), hasSession: Boolean(session), projectSystem: project?.system, capabilities: new Set() });
  const catalogProject = project;
  const catalogSession = session;
  const catalogServerId = catalogSession ? (serverOfObject(catalogSession.id) ?? '') : remoteHomeServerId;
  const catalogBackends = remoteBackends ?? backends;
  const catalogBackendId = catalogSession ? sessionBackend(catalogSession) : quickChat ? 'chat' : homeBackendId;
  const catalogProfileId = catalogSession ? catalogSession.backendProfileId : quickChat ? undefined : homeProfileId;
  const defaultProfileId = catalogBackends.find((entry) => entry.backendId === catalogBackendId)?.profiles.find((entry) => entry.isDefault)?.id ?? 'default';
  const recentModel = useMemo(() => {
    const preferred = quickChat ? settings.auxiliaryModels?.chat : undefined;
    const preferredValue = preferred ? `${preferred.backendId}:${preferred.profileId}:${preferred.model}` : '';
    let latest: Session | undefined;
    let matching: Session | undefined;
    for (const item of sessions) {
      if (!item.model || sessionBackend(item) !== catalogBackendId) continue;
      if (!catalogSession && !quickChat && (serverOfObject(item.id) ?? '') !== remoteHomeServerId) continue;
      if (!quickChat && (item.backendProfileId ?? defaultProfileId) !== (catalogProfileId ?? defaultProfileId)) continue;
      if (!latest || Date.parse(sessionActivityAt(item)) > Date.parse(sessionActivityAt(latest))) latest = item;
      if (preferredValue && parseSelection(item.model).model === preferredValue && (!matching || Date.parse(sessionActivityAt(item)) > Date.parse(sessionActivityAt(matching)))) matching = item;
    }
    return matching?.model ?? latest?.model;
  }, [sessions, quickChat, settings.auxiliaryModels?.chat, catalogSession, remoteHomeServerId, catalogBackendId, catalogProfileId, defaultProfileId]);
  const catalogKey = `${catalogServerId}@${catalogProject?.id ?? ''}:${catalogSession?.id ?? ''}:${catalogBackendId}:${catalogProfileId ?? 'default'}:${catalogSession?.nativeSessionId ?? ''}${catalogBackendId === 'chat' ? `:${JSON.stringify(settings.quickChat?.presets)}` : ''}`;
  // The key also moves when nothing a picker shows has (the first message writes the native id
  // back, a quick chat preset is saved). The last catalog of the same project, agent and provider
  // stays on screen until the new one lands, so a refresh never empties the pickers for a frame.
  // Catalogs can differ per session, so the hold never crosses from one session to another: only
  // within a session, or from the new-conversation composer to the session it just created.
  const catalogAgent = `${catalogServerId}@${catalogBackendId}:${catalogProfileId ?? 'default'}`;
  const catalogFamily = `${catalogProject?.id ?? ''}:${catalogAgent}`;
  const catalogSessionId = catalogSession?.id ?? '';
  const heldCatalog = useRef<{ family: string; agent: string; sessionId: string; result: NonNullable<typeof catalogResult> } | undefined>(undefined);
  if (catalogResult?.key === catalogKey) heldCatalog.current = { family: catalogFamily, agent: catalogAgent, sessionId: catalogSessionId, result: catalogResult };
  const held = heldCatalog.current;
  const holds = held?.family === catalogFamily && (held.sessionId === catalogSessionId || (!held.sessionId && nativeRunSeed?.sessionId === catalogSessionId));
  // A key the store has not loaded yet (another project, say) still has its last known catalog in
  // the cache; `load` would paint it, but only after this render has painted a frame of loading.
  const peekedCatalog = catalogResult?.key !== catalogKey && !holds && (catalogProject?.id || projectlessTasks || Boolean(remoteHomeServerId))
    ? catalog.peek({ projectId: catalogProject?.id ?? '', sessionId: catalogSessionId, backendId: catalogBackendId, profileId: catalogProfileId, ...(catalogServerId ? { serverId: catalogServerId } : {}) })
    : undefined;
  const currentCatalog = catalogResult?.key === catalogKey ? catalogResult : holds ? held.result : peekedCatalog ? { key: catalogKey, entry: peekedCatalog } : undefined;
  // A project with no catalog loaded or cached yet is unknown, not empty. Until its own lands, the
  // new-conversation composer resolves its model against the last catalog of the same agent and
  // provider, so the picker keeps saying which model it holds; it is still loading, so sending
  // waits for the real one. A session's own pickers never borrow another catalog, and a read that
  // failed says so on an empty picker rather than behind a borrowed list.
  const catalogLoading = !remoteBackendsLoaded || (!currentCatalog && (nativeCatalogLoading || catalogLoadedKey !== catalogKey));
  const standInCatalog = catalogLoading && !catalogSession && held?.agent === catalogAgent ? held.result.entry.models : undefined;
  const backend = currentCatalog ? currentCatalog.entry : catalogBackends.find((entry) => entry.backendId === catalogBackendId);
  const nativeCatalog = currentCatalog ? currentCatalog.entry.models : [];
  const viewCatalog = useViewCatalog();
  const mainViews = useMemo(() => mainViewsIn(viewCatalog), [viewCatalog]);
  const activeMainView = mainViewId ? mainViews.find((view) => view.id === mainViewId) : undefined;
  const openMainView = (viewId: string) => {
    void nav.navigate(() => { nav.openMainView(viewId); ui.setMobileSidebar(false); });
  };
  const pageOpen = settingsOpen || pluginsOpen || statsOpen || tasksOpen || automationsOpen || councilOpen || extensionsOpen || marksOpen || Boolean(mainViewId);
  /** Every page that covers the conversation, the attempts comparison included. */
  const anyPageOpen = pageOpen || Boolean(attemptsGroupId);
  const sidebarSelectedSessionId = anyPageOpen ? '' : session?.id ?? '';
  const sidebarSessions = useSidebarSessions(sidebarProjects, sessions, sidebarSelectedSessionId, t`未关联项目`);
  /** On the 助理 page: its project, with no page over it, showing its main conversation or the empty state. Derived, so it has no address of its own. */
  const assistantPage = isAssistantProject(project) && !anyPageOpen && (!session || session.id === mainSessionIdOf(project));
  // On the 助理 page the inline style has no tab bar to host the header's actions, so the header keeps its own row.
  const tabChrome = useMemo(() => tabbed && !(tabStyle === 'inline' && assistantPage) ? { actions: tabActions } : null, [tabbed, tabStyle, assistantPage, tabActions]);
  useDocumentTitle(pageOpen ? undefined : assistantPage && session ? { ...session, title: t`个人助理` } : session, sidebarSessions.unreadCount, settingsOpen ? (settingsSection === 'design' ? t`设计规范` : t`设置`) : mainViewId ? (activeMainView?.title ?? t`插件`) : pluginsOpen ? t`插件` : extensionsOpen ? t`扩展管理` : statsOpen ? t`统计` : tasksOpen ? t`任务看板` : automationsOpen ? t`自动化` : councilOpen ? t`模型协作` : marksOpen ? t`收藏夹` : quickChat ? t`快速对话` : assistantPage ? t`个人助理` : project?.name);

  const upsertSession = lists.upsertSession;
  const upsertTerminal = lists.upsertTerminal;

  const openPage = useCallback((page: NavPage) => {
    if (page === 'extensions' && nav.get().extensionsOpen && !nav.get().settingsOpen || page === 'plugins' && nav.get().pluginsOpen && !nav.get().settingsOpen) { ui.setMobileSidebar(false); return; }
    void nav.navigate(() => { nav.openPage(page); ui.setMobileSidebar(false); });
  }, [nav, ui]);
  const openSettingsAt = useCallback((section?: SettingsSection) => {
    if (section === 'integrations') { openPage('plugins'); return; }
    if (section?.includes('/')) { void nav.navigate(() => nav.openPlugins(section.split('/')[0], section)); return; }
    if (nav.get().settingsOpen && section && section === nav.get().settingsSection) { ui.setMobileSidebar(false); return; }
    void nav.navigate(() => { ui.clearProviderTarget(); nav.openSettings(section); ui.setMobileSidebar(false); }, { keepUnderlying: true });
  }, [nav, ui, openPage]);
  const selectSettingsSection = useCallback(async (next: SettingsSection) => {
    const current = nav.get().settingsSection;
    if (next === current) return;
    await nav.navigate(() => {
      void runSettingsTransition({ from: current, to: next, mobile: false }, () => {
        nav.setSettingsSection(next, { mobileDetail: true });
      });
    }, { keepUnderlying: true });
  }, [nav]);
  const closeSettings = useCallback(() => {
    void nav.navigate(() => { nav.closeSettings(); ui.clearProviderTarget(); }, { keepUnderlying: true });
  }, [nav, ui]);
  const { loadBootstrap, bootstrapFailed, refreshBackends, homeProfilesKey, loadCatalog } = useWorkbenchBootstrap({ loaded, project: catalogProject, session: catalogSession, backends: catalogBackends, homeBackendId, homeProfileId, catalogRevision, catalogBackendId, catalogProfileId, catalogKey, ...(catalogServerId ? { catalogServerId } : {}) });
  // The same for the per-provider lists, while `loadProfiles` has not published this key yet.
  const profilesCurrent = profileCatalogs?.key === homeProfilesKey;
  const peekedProfiles = useMemo(() => {
    const profiles = catalogBackends.find((entry) => entry.backendId === homeBackendId)?.profiles ?? [];
    if (profilesCurrent || session || quickChat || (!project && !projectlessTasks && !remoteHomeServerId) || profiles.length < 2) return undefined;
    const entries = catalog.peekProfiles(project?.id ?? '', homeBackendId, profiles, remoteHomeServerId || undefined);
    return entries.length ? entries : undefined;
  }, [profilesCurrent, session, quickChat, project, projectlessTasks, remoteHomeServerId, catalogBackends, homeBackendId, catalog]);
  const { creationRestore, pendingCreations, recoverCreation, newSession, selectProject, selectNoProject, acknowledgeCreation, selectSession, openMessageHit, openMark, openLaunched, findSession, openSessionById, openImported, onAttemptsStarted, createNative, reopenNative, sessionAction } = useSessionActions({ loaded, project, session, sessions, terminals, nativeRunSeed, homeBackendId, homeProfileId, loadBootstrap });
  useGlobalShortcuts(desktop, newSession);
  // A new conversation that starts from a quote (a collaboration's conclusion): added to the new-session draft, kept with
  // what was already written there, and the reader says what to do with it.
  const draftSessionWithQuote = useCallback((quote: string) => {
    const key = 'riffet.draft.new:home';
    const draft = readDraft(key);
    const { quotes, body } = splitQuotes(draft.text);
    if (!writeDraft(key, { ...draft, text: joinQuotes([...quotes, quote], body) })) pushError(t`草稿无法保存到浏览器，刷新后会丢失`);
    newSession();
  }, [newSession, t]);
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
    if (!assistantProject) return false;
    void nav.navigate(() => {
      nav.set({ projectId: assistantProject.id, sessionId: assistantMain?.id ?? '', ...NO_PAGE });
      ui.set({ previewTarget: undefined });
      ui.setMobileSidebar(false);
    });
    return true;
  };
  // Every way onto the 助理 with no conversation selected (a restored position, a link, the sidebar's
  // group) lands on its main conversation instead of a page that would start a second one.
  useEffect(() => {
    if (loaded && assistantMain && selectedProjectId === assistantMain.projectId && !selectedSessionId) nav.set({ sessionId: assistantMain.id });
  }, [loaded, assistantMain, selectedProjectId, selectedSessionId, nav]);
  const onAssistantMain = Boolean(assistantMain && session?.id === assistantMain.id);
  useEffect(() => { if (onAssistantMain) settingsStore.syncAssistantTimeZone(); }, [onAssistantMain, settings.assistant?.timeZone]);
  const approvalCount = useApprovals((state) => state.approvals.length);
  const inboxCount = useMemo(() => (workItemSummaries ? countWorkItemInbox(workItemSummaries, sessions) : 0) + approvalCount, [workItemSummaries, sessions, approvalCount]);
  /** 开始 on a 任务: its first conversation, with its assignee's defaults, while the reader stays on the board. */
  const startWorkItem = async (item: WorkItem): Promise<boolean> => {
    if (item.assignee.kind !== 'agent') return false;
    // With prerequisites the server decides: it opens the first conversation now, or queues the task until they are done.
    if (item.blockedBy?.length && !sessions.some((entry) => entry.workItemId === item.id)) {
      try { workItems.accept((await api.startWorkItem(item.id)).item); return true; }
      catch (error) { toast.error(errorMessage(error, t`无法开始这个任务`)); return false; }
    }
    const target = item.projectId ? regular.find((entry) => entry.id === item.projectId && !entry.archivedAt) : undefined;
    if (item.projectId && !target) { toast.error(t`这个任务的项目已移除或归档`); return false; }
    if (!target && !projectlessTasks) { toast.error(t`先为这个任务选一个项目`); return false; }
    // The server writes the first message: what the task is, what done means, what came before (docs/TASK-BOARD.md §6).
    // A provider removed since the task was planned: the agent's default, and its model with it.
    const run = ({ backendId, profileId, model }: { backendId: string; profileId?: string; model?: string }) =>
      profileId && !backends.find((entry) => entry.backendId === backendId)?.profiles.some((profile) => profile.id === profileId) ? {} : { ...(profileId ? { backendProfileId: profileId } : {}), ...(model ? { model } : {}) };
    let prompt: string;
    try { prompt = (await api.workItemBrief(item.id)).text; }
    catch (error) { toast.error(errorMessage(error, t`无法开始这个任务`)); return false; }
    return Boolean(await createNative({ ...(target ? { projectId: target.id } : { projectless: true }), title: item.title, prompt, attachments: [], context: [], backendId: item.assignee.backendId, ...run(item.assignee), workItemId: item.id, follow: false }));
  };
  const { projectAction, addProject, startSessionInDirectory, startIsolatedDirectory, openWorktreeProject, onWorktreeMerged, chooseSessionDirectory, openInEditor } = useProjectActions({ project, loadBootstrap, selectProject });
  const selectHomeServer = useCallback((targetServerId: string) => {
    if (targetServerId === homeServerId) return;
    const owned = recentDirectories.filter((item) => !item.archivedAt && (serverOfObject(item.id) ?? '') === targetServerId);
    if (owned.length > 0) {
      setPickedServerId('');
      void selectProject(owned[0]!);
      return;
    }
    if (!targetServerId) {
      setPickedServerId('');
      if (projectlessTasks) selectNoProject();
      else void chooseSessionDirectory('');
      return;
    }
    void nav.navigate(() => {
      clearContext(ui);
      nav.set({ projectId: '', sessionId: '', ...NO_PAGE });
      setPickedServerId(targetServerId);
      ui.set({ sessionDirectoryOpen: true, sessionDirectoryServer: targetServerId, mobileSidebar: false });
    });
  }, [homeServerId, recentDirectories, selectProject, projectlessTasks, selectNoProject, chooseSessionDirectory, nav, ui]);
  /** Opens a plugin task from its details page: its project, then the sidebar view that lists that provider's tasks (as a command's `task` result does). */
  const openPluginTask = useCallback((task: Task) => {
    const target = projects.find((entry) => entry.id === task.projectId);
    if (!target) return;
    const view = viewCatalog.find((entry) => entry.location === 'sidebar' && entry.render?.kind === 'declarative' && entry.render.declaration.renderer?.provider === task.providerId);
    void selectProject(target).then((moved) => {
      if (!moved) return;
      focusTask(task.id);
      if (view) { ui.set({ panelTab: view.id }); ui.setPanelOpen(true); }
    });
  }, [projects, viewCatalog, selectProject, ui]);
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
    if (remoteHomeServerId) { catalog.setRemoteHomeProfile(remoteHomeServerId, profileId); return; }
    if (assistantHome) { settingsStore.rememberAssistant({ backendId: homeBackendId, profileId, model }); return; }
    catalog.setHomeProfile(profileId);
    settingsStore.remember(homeBackendId, { profileId, model });
  };
  /** `model` comes with an agent picked through one of its models; without one a new provider clears the old model. */
  const chooseBackend = (backendId: NativeBackendId, profileId?: string, model?: string) => {
    if (remoteHomeServerId) {
      catalog.setRemoteHome(remoteHomeServerId, backendId, profileId ?? remoteSettings?.nativeBackendDefaults?.[backendId]?.profileId);
      return;
    }
    if (assistantHome) { settingsStore.rememberAssistant({ backendId, profileId: profileId ?? null, model: model || null }); return; }
    catalog.setHome(backendId, profileId ?? settings.nativeBackendDefaults?.[backendId]?.profileId);
    writeStored(STORAGE_KEYS.backend, backendId);
    const savedProfile = settings.nativeBackendDefaults?.[backendId]?.profileId ?? backends.find((entry) => entry.backendId === backendId)?.profiles.find((entry) => entry.isDefault)?.id;
    settingsStore.remember(backendId, { ...(profileId ? { profileId } : {}), ...(model !== undefined ? { model } : profileId && profileId !== savedProfile ? { model: '' } : {}) }, true);
  };
  const rememberModel = (model: string) => {
    if (remoteHomeServerId) return;
    if (assistantHome) { settingsStore.rememberAssistant({ backendId: homeBackendId, profileId: homeProfileId ?? null, model: model || null }); return; }
    settingsStore.remember(homeBackendId, { model });
  };

  // The stores, the notification click and the header reach these through the handlers bag.
  useEffect(() => {
    handlers.selectSession = selectSession;
    handlers.reload = () => void loadBootstrap().catch(bootstrapFailed);
    handlers.sessionAction = (target, action) => void sessionAction(target, action);
    handlers.openMark = (id) => void openMark(id);
    handlers.openAssistant = openAssistant;
    handlers.quoteInProject = (projectId, reference) => {
      const target = projects.find((item) => item.id === projectId);
      if (!target) return false;
      // The conversation under the page reads its project's files; one of another project cannot, so a new conversation takes the reference there.
      const move = session?.projectId === projectId ? nav.navigate(() => nav.set({ ...NO_PAGE })) : selectProject(target);
      void move.then((moved) => { if (moved) ui.addReference(reference); });
      return true;
    };
    handlers.openPluginView = (id) => {
      if (mainViews.some((view) => view.id === id && !view.unavailable)) { openMainView(id); return true; }
      if (!project || quickChat || serverOfObject(project.id) || !sidebarViews.some((view) => view.id === id && !view.unavailable)) return false;
      void nav.navigate(() => {
        nav.set({ ...NO_PAGE, extensionsOpen: false });
        ui.set({ panelTab: id });
        ui.setPanelOpen(true);
        ui.setMobileSidebar(false);
      });
      return true;
    };
  });

  /** Stable per conversation, so the conversation's header memo is not rebuilt as the page re-renders. */
  const sessionHeaderId = session?.id;
  const renderSessionHeader = useMemo(() => (slots: HeaderSlots) => <WorkbenchHeader sessionId={sessionHeaderId} slots={slots} />, [sessionHeaderId]);

  if (!loaded) {
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg px-6 text-center">
        {bootError ? (
          <>
            {/* Unreachable, the page keeps retrying by itself; meanwhile the horse runs, as the browser's dinosaur does. */}
            {!bootUnreachable && <BrandMark className="size-9 text-fg" />}
            <div className="flex max-w-sm flex-col gap-1"><p className="text-base font-medium text-fg"><Trans>无法加载工作台</Trans></p><p className="text-sm text-fg-3">{bootError}</p></div>
            <Button onClick={() => void loadBootstrap().catch(bootstrapFailed)}><Trans>重试</Trans></Button>
            {bootUnreachable && <RunnerGame globalKeys className="mt-6 max-w-2xl" />}
          </>
        ) : <LiveBrandMark fixed="run" className="size-12 text-fg" />}
      </main>
    );
  }

  const sidebar = (mobile: boolean) => (
    <Sidebar
      sessionList={sidebarSessions}
      projects={sidebarProjects}
      onSelectNoProject={projectlessTasks ? selectNoProject : undefined}
      sessions={sessions}
      selectedProjectId={anyPageOpen ? '' : selectedProjectId}
      selectedSessionId={sidebarSelectedSessionId}
      backend={backend}
      onSelectProject={selectProject}
      onSelectSession={selectFromSidebar}
      onNewSession={newSession}
      onAddProject={() => { void nav.navigate(() => { ui.set({ addProjectOpen: true }); ui.setMobileSidebar(false); }); }}
      onProjectAction={(target, action) => void projectAction(target, action)}
      onSessionAction={onSessionAction}
      onOpenSettings={openSettingsAt}
      onCustomizeSidebar={() => openSettingsAt('sidebar')}
      onOpenProfile={() => openSettingsAt('profile')}
      onOpenStats={() => openPage('stats')}
      {...(assistantProject ? { onOpenAssistant: openAssistant, assistantActive: assistantPage, ...(assistantMain ? { assistantSession: assistantMain } : {}) } : {})}
      {...(workItemsSupported ? { onOpenTasks: () => openPage('tasks'), tasksActive: tasksOpen, tasksCount: inboxCount } : {})}
      onOpenAutomations={() => openPage('automations')}
      onOpenCouncil={() => openPage('council')}
      councilActive={councilOpen}
      {...(councilState ? { councilState } : {})}
      onOpenExtensions={() => openPage('extensions')}
      onOpenPlugins={() => openPage('plugins')}
      pluginsActive={pluginsOpen}
      mainViews={mainViews}
      activeMainViewId={mainViewId}
      onOpenMainView={openMainView}
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
    backends: homeBackends,
    backendId: homeBackendId,
    profileId: homeProfileId,
    backend,
    profileCatalogs: profileCatalogs?.key === homeProfilesKey ? profileCatalogs.entries : peekedProfiles,
    onBackendChange: chooseBackend,
    onProfileChange: chooseHomeProfile,
    ...homeCatalogState,
    onRetryCatalog: loadCatalog,
    onAgentPickerOpen: () => { void catalog.recheckBackends(remoteHomeServerId); },
    onRefreshCatalog: () => {
      const projectId = project?.id ?? '';
      const profiles = backend?.profiles ?? [];
      if ((projectId || projectlessTasks || Boolean(remoteHomeServerId)) && profiles.length > 1) void catalog.loadProfiles(projectId, homeBackendId, profiles, homeProfilesKey, true, remoteHomeServerId || undefined);
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
  if (settingsOpen) {
    content = (
      <SettingsPage
        project={quickChat ? undefined : project}
        settings={settings}
        desktop={desktop}
        sidebarCollapsed={desktop && sidebarCollapsed}
        onExpandSidebar={expandSidebar}
        onOpenSidebar={openMobileSidebar}
        onClose={closeSettings}
        onSelectSection={selectSettingsSection}
        onRefreshBackends={async () => { await refreshBackends(); await loadCatalog(); }}
        onSettingsChanged={settingsStore.applySaved}
        onLogout={onLogout ? () => { void nav.navigate(onLogout); } : undefined}
        onError={pushError}
        {...(pendingProviderTarget ? { providerTarget: pendingProviderTarget } : {})}
        onProviderTargetHandled={(token) => ui.clearProviderTarget(token)}
      />
    );
  } else if (pluginsOpen) {
    content = <PluginsPage availableViewIds={[...sidebarViews, ...sessionViews, ...mainViews].map(view => view.id)} onOpenModels={() => openSettingsAt('providers')} onOpenProviderSettings={(target) => { void nav.navigate(() => { ui.setProviderTarget(target); nav.openSettings('providers'); ui.setMobileSidebar(false); }, { keepUnderlying: true }); }} commandActions={pluginCommands.actions()} rejectedKeybindings={pluginCommands.rejectedKeybindings} onOpenAppearance={() => openSettingsAt('appearance')} onOpenSettings={openSettingsAt} onOpenTask={openPluginTask} selectedId={pluginId} selectedViewId={pluginViewId} initialTab={pluginDetailTab} openRevision={pluginOpenRevision} projectId={project?.id} sessionId={session?.id}
      onSelect={(id, tab = 'overview') => nav.set({ pluginId: id, pluginViewId: '', pluginDetailTab: tab })}
      onClose={() => { void nav.navigate(() => nav.set({ pluginsOpen: false })); }}
      onBeforeLeaveChange={nav.registerPluginBeforeLeave}
      sidebarCollapsed={desktop && sidebarCollapsed}
      onOpenSidebar={openMobileSidebar}
      onExpandSidebar={expandSidebar}
      onOpenFeature={(view) => {
        if (mainViews.some((entry) => entry.id === view.id)) { openMainView(view.id); return; }
        void nav.navigate(() => {
          nav.set({ pluginsOpen: false });
          if (view.locations.includes('session-view') && session) { setViewVisible(view.id, true); nav.set({ sessionView: { sessionId: session.id, view: view.id } }); }
          else { ui.set({ panelTab: view.id }); ui.setPanelOpen(true); }
        });
      }} />;
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
  } else if (mainViewId) {
    content = (
      <PageScaffold
        column="none"
        divided
        title={activeMainView?.title ?? mainViewId}
        sidebarCollapsed={desktop && sidebarCollapsed}
        onClose={() => nav.set({ mainViewId: '' })}
        onOpenSidebar={openMobileSidebar}
        onExpandSidebar={expandSidebar}
        actions={activeMainView?.pluginId ? <Button size="sm" variant="quiet" onClick={() => { void nav.navigate(() => nav.openPlugins(activeMainView.pluginId!)); }}><Trans>管理插件</Trans></Button> : undefined}
      >
        <div className="flex h-full min-h-0 flex-col">
          {activeMainView ? <PluginView entry={activeMainView} /> : <EmptyState title={t`这个插件视图当前不可用`} />}
        </div>
      </PageScaffold>
    );
  } else if (marksOpen) {
    content = (
      <MarksPage
        projects={projects}
        backends={backends}
        sidebarCollapsed={desktop && sidebarCollapsed}
        onClose={() => nav.set({ marksOpen: false })}
        onOpenSidebar={openMobileSidebar}
        onExpandSidebar={expandSidebar}
        onOpenMark={(id) => void openMark(id)}
        onOpenMarkFile={(mark) => void openMark(mark.id).then(() => { if (mark.asset?.path) ui.preview(mark.asset.path); })}
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
  } else if (councilOpen) {
    content = (
      <CouncilPage
        projects={recentDirectories}
        backends={backends}
        sidebarCollapsed={desktop && sidebarCollapsed}
        onClose={() => nav.set({ councilOpen: false })}
        onOpenSidebar={openMobileSidebar}
        onExpandSidebar={expandSidebar}
        onDraftSession={draftSessionWithQuote}
        onOpenTasks={() => openPage('tasks')}
        onOpenProviderSettings={() => openSettingsAt('providers')}
      />
    );
  } else if ((!project && !projectlessTasks && !homeServerId) || (selectedSessionId && !project)) {
    content = <NoProjects onAddProject={() => ui.set({ addProjectOpen: true })} header={homeHeader} />;
  } else if (session?.kind === 'native') {
    // The frame stays across conversations; `SessionFrame` mounts each one afresh under its id.
    content = (
      <SessionFrame sessionId={session.id}>
        <NativeSession
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
          {...(quickChat || serverOfObject(session.id) ? {} : { onRememberModel: (model: string) => settingsStore.remember(sessionBackend(session), { model, ...(session.backendProfileId ? { profileId: session.backendProfileId } : {}) }) })}
          onError={pushError}
          notificationsEnabled={settings.notifications === true}
          enterBehavior={settings.composerEnterBehavior}
          runningBehavior={settings.composerRunningBehavior}
          sendLaterEnabled={settings.composerSendLater ?? SETTING_DEFAULTS.composerSendLater}
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
      </SessionFrame>
    );
  } else {
    content = (
      <NewSessionHome
        {...composerProps}
        serverId={homeServerId}
        serverOptions={homeServerOptions}
        onSelectServer={selectHomeServer}
        onOpenLinksSettings={() => openSettingsAt('links')}
        backendId={quickChat ? 'chat' : homeBackendId}
        profileId={quickChat ? undefined : homeProfileId}
        profileCatalogs={quickChat ? undefined : composerProps.profileCatalogs}
        recentModel={recentModel}
        project={project}
        referenceProjectId={quickChat ? taskProjectId ?? '' : project?.id ?? ''}
        sessions={sessions.filter((item) => project ? item.projectId === project.id : projects.some((target) => target.id === item.projectId && target.system === 'task-workspace'))}
        onSelectProject={selectProject}
        onChooseDirectory={() => void chooseSessionDirectory(homeServerId)}
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
    // i18n-ignore: search keywords in both languages, not interface text
    { id: 'open-council', label: t`打开模型协作`, keywords: 'council debate prism insight 模型协作 讨论 辩论 审阅', icon: <IconMessagesSquare className="size-4 shrink-0 text-fg-3" />, run: () => openPage('council') },
    { id: 'open-marks', label: t`打开收藏夹`, keywords: 'marks bookmarks highlights saved 收藏 收藏夹 高亮 书签', icon: <IconBookmark className="size-4 shrink-0 text-fg-3" />, run: () => openPage('marks') },
    { id: 'open-plugins', label: t`管理插件`, keywords: 'plugins install packages', icon: <IconPuzzle className="size-4 shrink-0 text-fg-3" />, run: () => openPage('plugins') },
    ...mainViews.map((view) => {
      const Icon = viewIcon(view);
      return { id: `open-view:${view.id}`, label: view.title, keywords: `plugin view ${view.id} ${view.title}`, icon: <Icon className="size-4 shrink-0 text-fg-3" />, run: () => openMainView(view.id) };
    }),
    { id: 'open-extensions', label: t`打开扩展管理`, keywords: 'extensions skills mcp plugins hooks rules commands 拓展 扩展 管理', icon: <IconWrench className="size-4 shrink-0 text-fg-3" />, run: () => openPage('extensions') },
    { id: 'toggle-sidebar', label: desktop ? (sidebarCollapsed ? t`展开侧栏` : t`收起侧栏`) : t`打开侧栏`, keywords: 'sidebar 侧栏', icon: <IconPanelLeft className="size-4 shrink-0 text-fg-3" />, run: () => { if (desktop) ui.setSidebarCollapsed((value) => !value); else ui.setMobileSidebar((value) => !value); } },
    ...(quickChat || isAssistantProject(project) ? [] : [{ id: 'toggle-terminal', label: ui.get().dockOpen ? t`隐藏终端` : t`显示终端`, keywords: 'terminal 终端', icon: <IconTerminal className="size-4 shrink-0 text-fg-3" />, run: () => { void nav.navigate(() => ui.setDockOpen((value) => !value)); } }]),
    ...(project && !quickChat && !pageOpen ? [
      ...(sidebarViews.some((view) => view.id === 'changes') ? [{ id: 'toggle-changes', label: panelShows('changes') ? t`收起变更面板` : t`打开变更面板`, keywords: 'git diff changes panel 变更 改动 差异', icon: <IconGitCompare className="size-4 shrink-0 text-fg-3" />, run: () => togglePanelTab(ui, 'changes', shownTab()) }] : []),
      ...(sidebarViews.some((view) => view.id === 'files') ? [{ id: 'toggle-files', label: panelShows('files') ? t`收起文件面板` : t`打开文件面板`, keywords: 'files explorer panel 文件 目录', icon: <IconFolder className="size-4 shrink-0 text-fg-3" />, run: () => togglePanelTab(ui, 'files', shownTab()) }] : []),
    ] : []),
    // i18n-ignore: search keywords in both languages, not interface text
    ...(!pageOpen && !attemptsGroupId && !session?.archivedAt && runnerFits() ? [{ id: 'open-runner', label: t`黑马跑酷`, keywords: 'game runner horse dino 游戏 小游戏 跑酷 黑马', icon: <BrandMark forceDefault className="size-4 shrink-0 text-fg-3" />, takesFocus: true, run: () => openRunner() }] : []),
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
    // The palette and the settings navigation list the same pages, matching section keywords too.
    ...settingsSections.map(({ id, label, keywords, icon: Icon }) => ({ id: `settings:${id}`, label: t`设置：${label}`, keywords: `settings 设置 ${label} ${keywords}`, icon: <Icon className="size-4 shrink-0 text-fg-3" />, run: () => openSettingsAt(id) })),
  ];

  // Phones already show the panel over the whole screen, so fullscreen is a desktop affordance.
  const panelMaximized = panelFullscreen && desktop;
  const peeking = sidebarPeek.peek;
  const stripTabs = tabbed && tabStyle === 'strip';
  // The first-run guide stands in for the whole window until it is finished or skipped (patterns §1.5).
  if (firstRun.open) return <Onboarding loadBootstrap={loadBootstrap} onSelectProject={selectProject} onSelectNoProject={selectNoProject} onFinish={firstRun.finish} />;
  return (
    // Clip, not hide: the context panel and sidebar wait off-screen before they slide in, and a
    // hidden overflow still scrolls, so a `scrollIntoView` inside them would shove the whole window.
    <div className={cn('workbench-viewport relative flex h-dvh overflow-clip text-fg', desktop ? 'bg-canvas' : 'bg-bg')}>
      <AppearanceBackdrop placement="underlay" />
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
                : cn('absolute inset-y-0 left-0 z-(--z-panel) transition-[translate] duration-[var(--duration-slow)] ease-out-soft', sidebarCollapsed ? '-translate-x-full bg-canvas' : 'translate-x-0', leavingPeek && 'transition-none'),
            )}
          >
            {settingsOpen ? (
              <SettingsSidebar
                section={settingsSection}
                onSelect={(next) => void selectSettingsSection(next)}
                onClose={closeSettings}
                {...(sidebarCollapsed ? { onPin: () => ui.setSidebarCollapsed(false) } : { onCollapse: () => ui.setSidebarCollapsed(true) })}
              />
            ) : sidebar(false)}
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
      <div className="relative flex min-w-0 flex-1 flex-col">
      {tabbed && tabStyle === 'strip' && (
        // Stats, tasks, marks and extensions carry their own expand button under the strip.
        <TabBar variant="strip" activeId={anyPageOpen || assistantPage ? '' : session?.id ?? ''} sidebarCollapsed={sidebarCollapsed && !pageOpen} onExpandSidebar={expandSidebar} onNewSession={newSession} actionsRef={setTabActions} />
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
      <main
        className={cn('flex min-w-0 flex-1 flex-col', desktop && 'mb-2 mr-2 overflow-hidden rounded-xl bg-card', desktop && !stripTabs && 'mt-2', desktop && sidebarCollapsed && 'ml-2')}
        aria-hidden={(panelMaximized && wide) || undefined}
        inert={panelMaximized && wide}
      >
        {tabbed && tabStyle === 'inline' && !anyPageOpen && !assistantPage && (
          <TabBar variant="inline" activeId={session?.id ?? ''} sidebarCollapsed={sidebarCollapsed} onExpandSidebar={expandSidebar} onNewSession={newSession} actionsRef={setTabActions} />
        )}
        {/* Scoped to the conversation/home region so a bad row cannot take the sidebar or the
            terminal dock down with it, and so switching sessions clears the failure. */}
        {extensionsMounted && <div className={cn('min-h-0 flex-1 flex-col', extensionsOpen && !settingsOpen ? 'flex' : 'hidden')} aria-hidden={(!extensionsOpen || settingsOpen) || undefined} inert={!extensionsOpen || settingsOpen}>
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
        <DockHost mode="desktop" show={desktop && Boolean(project) && !pageOpen && !quickChat && !isAssistantProject(project)} onCreate={createShell} onChanged={upsertTerminal} onClose={(terminal) => void closeTerminal(terminal)} onError={pushError} />
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
      <DockHost mode="mobile" show={!desktop && Boolean(project) && !pageOpen && !quickChat && !isAssistantProject(project)} onCreate={createShell} onChanged={upsertTerminal} onClose={(terminal) => void closeTerminal(terminal)} onError={pushError} />

      <WorkbenchOverlays
        addProject={addProject}
        paletteActions={paletteActions}
        startSessionInDirectory={startSessionInDirectory}
        onSelectSession={selectSession}
        onSelectProject={selectProject}
        onOpenMessage={openMessageHit}
        onImported={openImported}
        onError={pushError}
      />
      {pluginCommands.dialogs}
      <AppearanceBackdrop placement="overlay" />
    </div>
  );
}
