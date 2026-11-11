import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { Session } from '@contracts';
import type { ProjectRecord } from '@/lib/api';
import { toast } from '@/lib/toast';
import { errorMessage, isRecord, readStored, writeStored } from '@/lib/utils';
import { readStatsSearch, type StatsUiState } from '@/lib/stats-query';
import type { MessageFocus } from '../session/focus-message';
import { createStore } from '@/lib/store';

export const STORAGE_KEYS = {
  project: 'riffet.selectedProjectId',
  projectVisits: 'riffet.projectVisits',
  taskProject: 'riffet.taskProject.v1',
  session: 'riffet.selectedSessionId',
  sidebar: 'riffet.sidebarCollapsed',
  dock: 'riffet.dockHeight',
  sidebarWidth: 'riffet.sidebarWidth',
  panelWidth: 'riffet.panelWidth',
  backend: 'riffet.selectedBackend',
};

export type PluginDetailTab = 'features' | 'configuration' | 'management' | 'diagnostics';

export interface NavState {
  projectId: string;
  /** Undefined until restored, null is an explicit projectless task. Scoped by the server origin. */
  taskProjectId: string | null | undefined;
  /** Recent directory visits in this browser; quick chats do not replace the last task directory. */
  projectVisits: Record<string, number>;
  sessionId: string;
  statsOpen: boolean;
  tasksOpen: boolean;
  extensionsOpen: boolean;
  marksOpen: boolean;
  pluginsOpen: boolean;
  pluginId: string;
  pluginViewId: string;
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

/** One way a conversation is shown, by view id: `chat`, `terminal`, or a plugin's `<pluginId>/<name>`. */
export type SessionView = string;

/**
 * The deep link the workbench mirrors its selection into: `#s=<sessionId>&p=<projectId>`. The app
 * deliberately has no router, so this is only a hash — read once at startup and rewritten with
 * `replaceState`, never `pushState`. Overlays keep their navigation state inside the page.
 */
type DeepLink = { sessionId?: string; projectId?: string; markId?: string };
type Selection = { projectId: string; sessionId: string };

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

function readDeepLink(): DeepLink | undefined {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const sessionId = params.get('s') ?? undefined;
  const projectId = params.get('p') ?? undefined;
  // `m=<markId>`: a 收藏 to locate and scroll to once its conversation is open.
  const markId = params.get('m') ?? undefined;
  return sessionId || projectId || markId ? { ...(sessionId ? { sessionId } : {}), ...(projectId ? { projectId } : {}), ...(markId ? { markId } : {}) } : undefined;
}

/**
 * Where the page opens: a link's conversation (it carries its own project, so `#s=` alone is enough)
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
export const NO_PAGE = { statsOpen: false, tasksOpen: false, marksOpen: false, pluginsOpen: false, attemptsGroupId: '' } as const satisfies Partial<NavState>;

/**
 * What is selected and which page is showing, and the gate every change of destination goes through.
 * The page opens where the URL points, resolved against [cachedLists] (the local copy) when there is
 * one, so a reload paints the linked conversation before anything is fetched.
 */
export function createNavStore(cachedLists?: { projects: ProjectRecord[]; sessions: Session[] }) {
  const search = new URLSearchParams(window.location.search);
  const view = search.get('view');
  const extensionsOpen = view === 'extensions';
  const stats = readStatsSearch(window.location.search);
  const link = readDeepLink();
  const stored = { projectId: readStored(STORAGE_KEYS.project), sessionId: readStored(STORAGE_KEYS.session) };
  const opened = startingSelection(link, cachedLists, stored);
  const store = createStore<NavState>({
    ...opened,
    taskProjectId: (() => {
      try { const value: unknown = JSON.parse(readStored(STORAGE_KEYS.taskProject)); return value === null || typeof value === 'string' ? value : undefined; }
      catch { return undefined; }
    })(),
    projectVisits: readProjectVisits(),
    statsOpen: stats.open,
    tasksOpen: view === 'tasks',
    extensionsOpen,
    extensionsMounted: extensionsOpen,
    marksOpen: view === 'marks',
    pluginsOpen: view === 'plugins',
    pluginId: search.get('plugin') ?? '',
    pluginViewId: '',
    attemptsGroupId: '',
    statsState: stats.state,
  });
  /**
   * The link is judged once, by the first bootstrap that gets the lists (an offline start keeps it
   * until then), and only if the reader is still where the page opened: a later reload, or one after
   * the reader moved on, must not yank them back to it.
   */
  let startingLink: StartingLink | undefined = link && { link, stored, opened };
  let beforeLeave: (() => Promise<boolean>) | undefined;
  let beforePluginLeave: (() => Promise<boolean>) | undefined;
  let pending = false;
  let navigationRevision = 0;
  let previousDestination = store.get();
  // Direct page closes and bootstrap reconciliation use set(), while guarded navigation records
  // intent before it awaits an editor. Both invalidate an older automatic navigation receipt.
  store.subscribe(() => {
    const current = store.get();
    if (current.projectId !== previousDestination.projectId || current.sessionId !== previousDestination.sessionId
      || current.statsOpen !== previousDestination.statsOpen || current.tasksOpen !== previousDestination.tasksOpen
      || current.extensionsOpen !== previousDestination.extensionsOpen || current.marksOpen !== previousDestination.marksOpen
      || current.pluginsOpen !== previousDestination.pluginsOpen || current.pluginId !== previousDestination.pluginId
      || current.pluginViewId !== previousDestination.pluginViewId || current.pluginDetailTab !== previousDestination.pluginDetailTab
      || current.pluginOpenRevision !== previousDestination.pluginOpenRevision
      || current.attemptsGroupId !== previousDestination.attemptsGroupId) navigationRevision += 1;
    previousDestination = current;
  });

  const actions = {
    getNavigationRevision: () => navigationRevision,
    rememberTaskProject(projectId: string | null) {
      writeStored(STORAGE_KEYS.taskProject, JSON.stringify(projectId));
      store.set({ taskProjectId: projectId });
    },
    rememberProjectVisit(projectId: string) {
      const projectVisits = Object.fromEntries(Object.entries({ ...store.get().projectVisits, [projectId]: Date.now() }).sort((a, b) => b[1] - a[1]).slice(0, 100));
      store.set({ projectVisits });
      writeStored(STORAGE_KEYS.projectVisits, JSON.stringify(projectVisits));
    },
    /** Hands the linked mark over once; later calls see nothing. */
    /** Hands the link over once, or nothing when the reader has left where the page opened at it. */
    takeStartingLink(): StartingLink | undefined {
      const start = startingLink;
      startingLink = undefined;
      const { projectId, sessionId } = store.get();
      return start && start.opened.projectId === projectId && start.opened.sessionId === sessionId ? start : undefined;
    },
    registerPluginBeforeLeave(guard: (() => Promise<boolean>) | undefined) { beforePluginLeave = guard; },
    registerBeforeLeave(guard: (() => Promise<boolean>) | undefined) { beforeLeave = guard; },
    /**
     * Every destination that changes the extension context goes through this one gate. It asks the
     * open editor whether it may be left, so notification and long-lived async callbacks are covered too.
     */
    async navigate(change: () => void): Promise<boolean> {
      navigationRevision += 1;
      if (pending) return false;
      pending = true;
      try {
        if (store.get().pluginsOpen && beforePluginLeave && !(await beforePluginLeave())) return false;
        if (store.get().extensionsOpen && beforeLeave && !(await beforeLeave())) return false;
        store.set({ extensionsOpen: false });
        change();
        return true;
      } catch (error) { toast.error(errorMessage(error, i18n._(msg`无法离开扩展管理页面`))); return false; }
      finally { pending = false; }
    },
    /** The page header and browser-back handler already checked the guard. */
    closeExtensions() { store.set({ extensionsOpen: false }); },
    openPage(page: 'stats' | 'tasks' | 'extensions' | 'marks' | 'plugins') {
      store.set({ pluginsOpen: page === 'plugins', statsOpen: page === 'stats', tasksOpen: page === 'tasks', marksOpen: page === 'marks', attemptsGroupId: '', ...(page === 'extensions' ? { extensionsMounted: true, extensionsOpen: true } : {}) });
    },
    openPlugins(pluginId = '', pluginViewId = '', pluginDetailTab: PluginDetailTab = 'features') { store.set({ ...NO_PAGE, extensionsOpen: false, pluginsOpen: true, pluginId, pluginViewId, pluginDetailTab, pluginOpenRevision: (store.get().pluginOpenRevision ?? 0) + 1 }); },
    openAttemptsGroup(groupId: string) {
      store.set({ ...NO_PAGE, attemptsGroupId: groupId });
    },
  };
  return { ...store, ...actions };
}

export type NavStore = ReturnType<typeof createNavStore>;
