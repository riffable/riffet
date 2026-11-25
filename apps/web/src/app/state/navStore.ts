import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { Session } from '@contracts';
import type { ProjectRecord } from '@/lib/api';
import { toast } from '@/lib/toast';
import { errorMessage, isRecord, readStored, writeStored } from '@/lib/utils';
import type { StatsUiState } from '@/lib/stats-query';
import type { MessageFocus } from '../session/focus-message';
import { createStore } from '@/lib/store';
import { DEFAULT_SETTINGS_SECTION, resolveSettingsSection, type SettingsSection } from '../settings/settingsSections';
import { readPageAddress, type DesignPlatform, type PageAddress } from './page-url';

export const STORAGE_KEYS = {
  project: 'riffet.selectedProjectId',
  projectVisits: 'riffet.projectVisits',
  taskProject: 'riffet.taskProject.v1',
  session: 'riffet.selectedSessionId',
  sidebar: 'riffet.sidebarCollapsed',
  dock: 'riffet.dockHeight',
  sidebarWidth: 'riffet.sidebarWidth.v1',
  panelWidth: 'riffet.panelWidth',
  backend: 'riffet.selectedBackend',
  settingsSection: 'riffet.settingsSection.v1',
  councilDiscussion: 'riffet.councilDiscussion.v1',
  councilAside: 'riffet.councilAside.v1',
};

/** 介绍, the plugin's own page (its settings), and 管理 with 诊断. */
export type PluginDetailTab = 'overview' | 'page' | 'management';

export interface NavState {
  projectId: string;
  /** Standing team member currently open (`''` when viewing regular projects/sessions). */
  memberId: string;
  /** Undefined until restored, null is an explicit projectless task. Scoped by the server origin. */
  taskProjectId: string | null | undefined;
  /** Recent directory visits in this browser; quick chats do not replace the last task directory. */
  projectVisits: Record<string, number>;
  sessionId: string;
  statsOpen: boolean;
  /** 任务 (docs/TASK-BOARD.md). */
  tasksOpen: boolean;
  /** 自动化. */
  automationsOpen: boolean;
  /** 多模型讨论. */
  councilOpen: boolean;
  /** The selected local discussion. Null remembers the launch screen. */
  councilDiscussionId: string | null;
  councilAsideOpen: boolean;
  councilExpandedSpeeches: ReadonlySet<string>;
  extensionsOpen: boolean;
  marksOpen: boolean;
  /** The platform that the design system section shows; kept while closed, so reopening returns to it. */
  designPlatform: DesignPlatform;
  /** The design system section's chapter id; empty is its overview. */
  designChapter: string;
  /** The settings page; covers the active conversation or page without losing what was underneath. */
  settingsOpen: boolean;
  /** The active settings section (reflected in `/settings/<section>`). */
  settingsSection: SettingsSection;
  /** On phones, whether the section detail is open instead of the root category list. */
  settingsMobileDetail: boolean;
  /** Incremented on fresh entries or discarded drafts to remount stateful forms cleanly. */
  settingsVisit: number;
  pluginsOpen: boolean;
  pluginId: string;
  pluginViewId: string;
  /** The `main` plugin view showing as a top-level page; empty when none is. */
  mainViewId: string;
  pluginDetailTab?: PluginDetailTab;
  /** Each explicit opening re-applies its destination, even when the same deep link is repeated. */
  pluginOpenRevision?: number;
  /** The parallel-attempt group whose comparison page is showing; empty when none is. */
  attemptsGroupId: string;
  /** The directory belongs to this workbench/login and survives visits to other pages. */
  extensionsMounted: boolean;
  statsState: StatsUiState;
  /** The message a search result asked to see, until the reader picks another conversation. */
  focusMessage?: { sessionId: string; focus: MessageFocus };
  /** The view a conversation opens in, when something other than its transcript asked for it. */
  sessionView?: { sessionId: string; view: SessionView };
}

/** The pages that cover the conversation. */
export type NavPage = 'stats' | 'tasks' | 'automations' | 'council' | 'extensions' | 'marks' | 'plugins';

/** One way a conversation is shown, by view id: `chat`, `terminal`, or a plugin's `<pluginId>/<name>`. */
export type SessionView = string;

/** The conversation or project an address names (`page-url.ts`), and a 收藏 to locate in it. */
type DeepLink = { sessionId?: string; projectId?: string; markId?: string };
type Selection = { projectId: string; sessionId: string };
type CouncilReadingPosition = { top: number; following: boolean };

function readProjectVisits(): Record<string, number> {
  try {
    const value: unknown = JSON.parse(readStored(STORAGE_KEYS.projectVisits));
    return isRecord(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0)) : {};
  } catch { return {}; }
}

/**
 * A link as the page opened at it: the link, the selection the last visit stored (its fallback when
 * the link names nothing live), and where the page opened, so the first bootstrap can tell whether
 * the reader has since moved.
 */
export interface StartingLink { link: DeepLink; stored: Selection; opened: Selection }

function deepLink({ sessionId, projectId, markId }: PageAddress): DeepLink | undefined {
  return sessionId || projectId ? { ...(sessionId ? { sessionId } : {}), ...(projectId ? { projectId } : {}), ...(markId ? { markId } : {}) } : undefined;
}

/**
 * Where the page opens: a link's conversation (it carries its own project)
 * or project, judged against [lists] when there are any; else the selection the last visit stored.
 * A link the lists do not hold is kept as given, for the bootstrap to check against the server's lists.
 */
function startingSelection(link: DeepLink | undefined, lists: { projects: ProjectRecord[]; sessions: Session[] } | undefined, stored: Selection): Selection {
  if (!link?.sessionId && !link?.projectId) return stored;
  const session = link.sessionId ? lists?.sessions.find((item) => item.id === link.sessionId && !item.archivedAt) : undefined;
  const project = lists?.projects.find((item) => item.id === (session?.projectId ?? link.projectId) && !item.archivedAt);
  if (project) return { projectId: project.id, sessionId: session?.id ?? '' };
  return { projectId: link.projectId ?? stored.projectId, sessionId: link.sessionId ?? '' };
}

/** Closes every page that covers the conversation, for a destination that is a conversation or project. */
export const NO_PAGE = { statsOpen: false, tasksOpen: false, automationsOpen: false, councilOpen: false, marksOpen: false, settingsOpen: false, pluginsOpen: false, mainViewId: '', attemptsGroupId: '' } as const satisfies Partial<NavState>;

/**
 * What is selected and which page is showing, and the gate every change of destination goes through.
 * The page opens where the URL points, resolved against [cachedLists] (the local copy) when there is
 * one, so a reload paints the linked conversation before anything is fetched.
 */
export function createNavStore(cachedLists?: { projects: ProjectRecord[]; sessions: Session[] }) {
  const address = readPageAddress(window.location);
  const view = address.page;
  const extensionsOpen = view === 'extensions';
  const settingsOpen = view === 'settings' || view === 'design';
  const initialSettingsSection = view === 'design' ? 'design' : resolveSettingsSection(address.settingsSection);
  const storedSettingsSection = resolveSettingsSection(readStored(STORAGE_KEYS.settingsSection));
  const link = deepLink(address);
  const stored = { projectId: readStored(STORAGE_KEYS.project), sessionId: readStored(STORAGE_KEYS.session) };
  const opened = startingSelection(link, cachedLists, stored);
  const store = createStore<NavState>({
    ...opened,
    memberId: '',
    taskProjectId: (() => {
      try { const value: unknown = JSON.parse(readStored(STORAGE_KEYS.taskProject)); return value === null || typeof value === 'string' ? value : undefined; }
      catch { return undefined; }
    })(),
    projectVisits: readProjectVisits(),
    statsOpen: view === 'stats',
    tasksOpen: view === 'tasks',
    automationsOpen: view === 'automations',
    councilOpen: view === 'council',
    councilDiscussionId: readStored(STORAGE_KEYS.councilDiscussion) || null,
    councilAsideOpen: readStored(STORAGE_KEYS.councilAside) !== 'closed',
    councilExpandedSpeeches: new Set(),
    extensionsOpen,
    extensionsMounted: extensionsOpen,
    marksOpen: view === 'marks',
    designPlatform: address.designPlatform ?? 'web',
    designChapter: address.designChapter ?? '',
    settingsOpen,
    settingsSection: initialSettingsSection ?? storedSettingsSection ?? DEFAULT_SETTINGS_SECTION,
    settingsMobileDetail: Boolean(initialSettingsSection),
    settingsVisit: 0,
    pluginsOpen: view === 'plugins',
    pluginId: address.pluginId ?? '',
    pluginViewId: '',
    mainViewId: view === 'view' ? (address.mainViewId ?? '') : '',
    attemptsGroupId: '',
    statsState: address.stats,
  });
  /**
   * The link is judged once, by the first bootstrap that gets the lists (an offline start keeps it
   * until then), and only if the reader is still where the page opened: a later reload, or one after
   * the reader moved on, must not yank them back to it.
   */
  let startingLink: StartingLink | undefined = link && { link, stored, opened };
  let beforeLeave: (() => Promise<boolean>) | undefined;
  let beforePluginLeave: (() => Promise<boolean>) | undefined;
  let beforeSettingsLeave: (() => Promise<boolean>) | undefined;
  let pending = false;
  let navigationRevision = 0;
  let councilReadingPosition: CouncilReadingPosition | undefined;
  let previousDestination = store.get();
  // Direct page closes and bootstrap reconciliation use set(), while guarded navigation records
  // intent before it awaits an editor. Both invalidate an older automatic navigation receipt.
  store.subscribe(() => {
    const current = store.get();
    if (current.projectId !== previousDestination.projectId || current.memberId !== previousDestination.memberId || current.sessionId !== previousDestination.sessionId
      || current.statsOpen !== previousDestination.statsOpen || current.tasksOpen !== previousDestination.tasksOpen || current.automationsOpen !== previousDestination.automationsOpen || current.councilOpen !== previousDestination.councilOpen
      || current.councilDiscussionId !== previousDestination.councilDiscussionId
      || current.extensionsOpen !== previousDestination.extensionsOpen || current.marksOpen !== previousDestination.marksOpen
      || current.settingsOpen !== previousDestination.settingsOpen || current.settingsSection !== previousDestination.settingsSection
      || current.pluginsOpen !== previousDestination.pluginsOpen || current.pluginId !== previousDestination.pluginId
      || current.pluginViewId !== previousDestination.pluginViewId || current.pluginDetailTab !== previousDestination.pluginDetailTab
      || current.pluginOpenRevision !== previousDestination.pluginOpenRevision
      || current.mainViewId !== previousDestination.mainViewId
      || current.attemptsGroupId !== previousDestination.attemptsGroupId) navigationRevision += 1;
    previousDestination = current;
  });

  const actions = {
    getNavigationRevision: () => navigationRevision,
    selectCouncilDiscussion(id: string | null) {
      if (store.get().councilDiscussionId === id) return;
      councilReadingPosition = undefined;
      writeStored(STORAGE_KEYS.councilDiscussion, id ?? undefined);
      store.set({ councilDiscussionId: id, councilExpandedSpeeches: new Set() });
    },
    setCouncilAsideOpen(open: boolean) {
      writeStored(STORAGE_KEYS.councilAside, open ? undefined : 'closed');
      store.set({ councilAsideOpen: open });
    },
    setCouncilSpeechExpanded(discussionId: string, speechId: string, expanded: boolean) {
      const { councilDiscussionId, councilExpandedSpeeches } = store.get();
      if (councilDiscussionId !== discussionId || councilExpandedSpeeches.has(speechId) === expanded) return;
      const next = new Set(councilExpandedSpeeches);
      if (expanded) next.add(speechId);
      else next.delete(speechId);
      store.set({ councilExpandedSpeeches: next });
    },
    /** Reading geometry only belongs to this workbench and the selected discussion. */
    getCouncilReadingPosition: () => councilReadingPosition,
    rememberCouncilReadingPosition(id: string, position: CouncilReadingPosition) {
      if (store.get().councilDiscussionId === id) councilReadingPosition = position;
    },
    rememberTaskProject(projectId: string | null) {
      writeStored(STORAGE_KEYS.taskProject, JSON.stringify(projectId));
      store.set({ taskProjectId: projectId });
    },
    rememberProjectVisit(projectId: string) {
      const projectVisits = Object.fromEntries(Object.entries({ ...store.get().projectVisits, [projectId]: Date.now() }).sort((a, b) => b[1] - a[1]).slice(0, 100));
      store.set({ projectVisits });
      writeStored(STORAGE_KEYS.projectVisits, JSON.stringify(projectVisits));
    },
    /** Hands the link over once, or nothing when the reader has left where the page opened at it. */
    takeStartingLink(): StartingLink | undefined {
      const start = startingLink;
      startingLink = undefined;
      const { projectId, sessionId } = store.get();
      return start && start.opened.projectId === projectId && start.opened.sessionId === sessionId ? start : undefined;
    },
    registerPluginBeforeLeave(guard: (() => Promise<boolean>) | undefined) { beforePluginLeave = guard; },
    registerSettingsBeforeLeave(guard: (() => Promise<boolean>) | undefined) { beforeSettingsLeave = guard; },
    registerBeforeLeave(guard: (() => Promise<boolean>) | undefined) { beforeLeave = guard; },
    /**
     * Every destination that changes the active editor context goes through this one gate. It asks
     * the open editor whether it may be left, so notification and long-lived async callbacks are
     * covered too. Pass `keepUnderlying: true` when opening settings on top of plugins/extensions.
     */
    async navigate(change: () => void, options?: { keepUnderlying?: boolean }): Promise<boolean> {
      navigationRevision += 1;
      if (pending) return false;
      pending = true;
      try {
        if (store.get().settingsOpen && beforeSettingsLeave && !(await beforeSettingsLeave())) return false;
        if (!options?.keepUnderlying) {
          if (store.get().pluginsOpen && beforePluginLeave && !(await beforePluginLeave())) return false;
          if (store.get().extensionsOpen && beforeLeave && !(await beforeLeave())) return false;
          store.set({ extensionsOpen: false });
        }
        change();
        return true;
      } catch (error) { toast.error(errorMessage(error, i18n._(msg`无法离开当前页面`))); return false; }
      finally { pending = false; }
    },
    /** The page header and browser-back handler already checked the guard. */
    closeExtensions() { store.set({ extensionsOpen: false }); },
    /** Opens settings over whatever is currently shown, keeping the underlying page or session intact. */
    openSettings(section?: SettingsSection) {
      const resolved = resolveSettingsSection(section);
      const current = store.get();
      const target = resolved ?? resolveSettingsSection(current.settingsSection) ?? DEFAULT_SETTINGS_SECTION;
      if (resolved) writeStored(STORAGE_KEYS.settingsSection, resolved);
      store.set({
        settingsOpen: true,
        settingsSection: target,
        settingsMobileDetail: Boolean(resolved),
        settingsVisit: current.settingsOpen ? current.settingsVisit : current.settingsVisit + 1,
      });
    },
    setSettingsSection(section: SettingsSection, options?: { mobileDetail?: boolean; bumpVisit?: boolean }) {
      const current = store.get();
      if (resolveSettingsSection(section)) writeStored(STORAGE_KEYS.settingsSection, section);
      store.set({
        settingsSection: section,
        ...(options?.mobileDetail !== undefined ? { settingsMobileDetail: options.mobileDetail } : {}),
        ...(options?.bumpVisit ? { settingsVisit: current.settingsVisit + 1 } : {}),
      });
    },
    /** Closes settings without disturbing the page or conversation underneath. */
    closeSettings() { store.set({ settingsOpen: false }); },
    openPage(page: NavPage) {
      store.set({ settingsOpen: false, pluginsOpen: page === 'plugins', statsOpen: page === 'stats', tasksOpen: page === 'tasks', automationsOpen: page === 'automations', councilOpen: page === 'council', marksOpen: page === 'marks', mainViewId: '', attemptsGroupId: '', ...(page === 'extensions' ? { extensionsMounted: true, extensionsOpen: true } : {}) });
    },
    openMainView(viewId: string) {
      store.set({ ...NO_PAGE, extensionsOpen: false, mainViewId: viewId });
    },
    openPlugins(pluginId = '', pluginViewId = '', pluginDetailTab: PluginDetailTab = 'overview') { store.set({ ...NO_PAGE, extensionsOpen: false, pluginsOpen: true, pluginId, pluginViewId, pluginDetailTab, pluginOpenRevision: (store.get().pluginOpenRevision ?? 0) + 1 }); },
    openAttemptsGroup(groupId: string) {
      store.set({ ...NO_PAGE, attemptsGroupId: groupId });
    },
  };
  return { ...store, ...actions };
}

export type NavStore = ReturnType<typeof createNavStore>;
