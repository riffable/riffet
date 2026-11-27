import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { Session } from '@contracts';
import { api, apiFor } from '@/lib/api';
import { serverOfObject } from '@/lib/server-routing';
import { comparePinnedSessions, sortSessionsByActivity } from '@/lib/session-order';
import { createStore } from '@/lib/store';
import { toast } from '@/lib/toast';
import { errorMessage, isRecord, readStored, writeStored } from '@/lib/utils';
import type { ListsStore } from '../state/listsStore';
import { NO_PAGE, type NavState, type NavStore } from '../state/navStore';
import type { UiStore } from '../state/uiStore';
import type { WorkbenchHandlers } from '../state/stores';

/**
 * Where the open tabs and the style are kept. `localStorage` is already scoped by the origin the
 * workbench is served from, which is the server's, so another server never sees these tabs.
 */
const TABS_STORAGE = { tabs: 'riffet.sessionTabs.v1', style: 'riffet.sessionTabStyle', openMode: 'riffet.sessionTabOpen', newMode: 'riffet.sessionTabNew' } as const;

/** 关闭: the classic title row. 标题栏: tabs replace it. 独立一行: tabs sit on the canvas above the panel. */
export type TabStyle = 'off' | 'inline' | 'strip';

const DEFAULT_TAB_STYLE: TabStyle = 'off';

/**
 * 打开会话时. `preview`: a newly opened conversation is a temporary tab, kept only by the reader's own
 * keep (double-click, ⌘-click, 加入标签栏); sending there, a run starting or a pin does not. `keep`: it is
 * kept at once.
 */
export type TabOpenMode = 'preview' | 'keep';

const DEFAULT_TAB_OPEN_MODE: TabOpenMode = 'preview';

/** 新建会话时: the tab of a conversation Riffet creates or forks. `keep`: kept as it opens. `preview`: a temporary tab. The `keep` open mode overrides it. */
export type TabNewMode = 'preview' | 'keep';

const DEFAULT_TAB_NEW_MODE: TabNewMode = 'keep';

export interface TabEntry {
  sessionId: string;
  /** The tab the next conversation opened from anywhere replaces. */
  preview: boolean;
}

export interface TabsState {
  style: TabStyle;
  openMode: TabOpenMode;
  newMode: TabNewMode;
  /** In the order the reader keeps them; which zone a tab shows in follows its session's pin. */
  tabs: TabEntry[];
  /** The conversation last selected: where the next tab opens, also while the project home is showing. */
  anchor: string;
}

interface ClosedTab { sessionId: string; index: number }

/** The tabs of conversations that exist, split into the pinned zone (server order) and the rest (the reader's order). */
export interface TabZones { pinned: TabEntry[]; normal: TabEntry[] }

export function tabZones(tabs: readonly TabEntry[], sessions: ReadonlyMap<string, Session>): TabZones {
  const pinned: { entry: TabEntry; session: Session }[] = [];
  const normal: TabEntry[] = [];
  for (const entry of tabs) {
    const session = sessions.get(entry.sessionId);
    if (!session || session.archivedAt) continue;
    if (session.pinnedAt) pinned.push({ entry, session }); else normal.push(entry);
  }
  pinned.sort((a, b) => comparePinnedSessions(a.session, b.session));
  return { pinned: pinned.map((item) => item.entry), normal };
}

/** Where a tab opened now goes in the normal zone: after the conversation last read, else at the end; first when that one is pinned. */
export function normalInsertIndex(zones: TabZones, anchor: string): number {
  const at = zones.normal.findIndex((entry) => entry.sessionId === anchor);
  if (at >= 0) return at + 1;
  return zones.pinned.some((entry) => entry.sessionId === anchor) ? 0 : zones.normal.length;
}

function insertNormal(tabs: readonly TabEntry[], normal: readonly TabEntry[], entry: TabEntry, index: number): TabEntry[] {
  const before = normal[index];
  const at = before ? tabs.findIndex((item) => item.sessionId === before.sessionId) : tabs.length;
  return [...tabs.slice(0, at), entry, ...tabs.slice(at)];
}

/** Statistics, tasks, marks, design, extensions, plugins and attempt pages cover the conversation; the selection underneath stays. */
export function isPageOpen(state: Pick<NavState, 'pluginsOpen' | 'statsOpen' | 'tasksOpen' | 'automationsOpen' | 'councilOpen' | 'marksOpen' | 'designOpen' | 'settingsOpen' | 'extensionsOpen' | 'mainViewId' | 'attemptsGroupId'>): boolean {
  return state.pluginsOpen || state.statsOpen || state.tasksOpen || state.automationsOpen || state.councilOpen || state.marksOpen || state.designOpen || state.settingsOpen || state.extensionsOpen || Boolean(state.mainViewId) || Boolean(state.attemptsGroupId);
}

const LAUNCH_WINDOW_MS = 10_000;
const CLOSED_LIMIT = 30;
const TAB_LIMIT = 100;

function readStyle(): TabStyle {
  const value = readStored(TABS_STORAGE.style);
  return value === 'off' || value === 'inline' || value === 'strip' ? value : DEFAULT_TAB_STYLE;
}

function readOpenMode(): TabOpenMode {
  const value = readStored(TABS_STORAGE.openMode);
  // `manual` was a third mode that now is what `preview` does.
  return value === 'keep' ? value : DEFAULT_TAB_OPEN_MODE;
}

function readNewMode(): TabNewMode {
  return readStored(TABS_STORAGE.newMode) === 'preview' ? 'preview' : DEFAULT_TAB_NEW_MODE;
}

function readTabs(): TabEntry[] {
  try {
    const value: unknown = JSON.parse(readStored(TABS_STORAGE.tabs));
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const tabs: TabEntry[] = [];
    for (const item of value) {
      if (!isRecord(item) || typeof item.sessionId !== 'string' || !item.sessionId || seen.has(item.sessionId)) continue;
      seen.add(item.sessionId);
      tabs.push({ sessionId: item.sessionId, preview: item.preview === true });
      if (tabs.length >= TAB_LIMIT) break;
    }
    // At most one preview: the rest were kept.
    let previewSeen = false;
    return tabs.map((tab) => {
      if (!tab.preview) return tab;
      if (previewSeen) return { sessionId: tab.sessionId, preview: false };
      previewSeen = true;
      return tab;
    });
  } catch { return []; }
}

export interface TabsDeps {
  lists: ListsStore;
  nav: NavStore;
  ui: UiStore;
  handlers: WorkbenchHandlers;
}

/**
 * The open conversations as tabs. It follows the navigation store instead of asking every caller
 * to open a tab: a conversation that becomes the selection and has no tab gets a preview tab, and
 * the few ways a reader (or the workbench) commits to it keep that tab.
 */
export function createTabsStore({ lists, nav, ui, handlers }: TabsDeps) {
  const store = createStore<TabsState>({ style: readStyle(), openMode: readOpenMode(), newMode: readNewMode(), tabs: readTabs(), anchor: nav.get().sessionId });
  const closedStack: ClosedTab[] = [];
  /** A sidebar ⌘-click names the conversation it is about to select, which the navigation gate may delay. */
  let pendingKeep = '';
  /** The conversation the workbench itself just created or launched, until it is selected. */
  let launched: { sessionId: string; at: number } | undefined;
  /** The conversation on screen whose tab another window closed: it is not given a new one until the reader opens it again. */
  let detached = '';

  const sessionMap = () => new Map(lists.get().sessions.map((session) => [session.id, session]));
  const sessionOf = (id: string) => lists.get().sessions.find((session) => session.id === id);
  /** The 助理's and team members' conversations are their own pages, never tabs (docs/ASSISTANT.md, docs/TEAM.md). */
  const isMain = (id: string) => {
    const state = lists.get();
    if (state.projects.some((project) => project.mainSessionId === id)) return true;
    const session = state.sessions.find((item) => item.id === id);
    if (!session) return false;
    return Boolean(session.agentMemberId) || state.projects.some((project) => project.id === session.projectId && project.system === 'assistant');
  };
  const ofAssistant = (projectId: string) => lists.get().projects.some((project) => project.id === projectId && project.system === 'assistant');
  const zonesNow = () => tabZones(store.get().tabs, sessionMap());
  const orderedIds = () => { const zones = zonesNow(); return [...zones.pinned, ...zones.normal].map((entry) => entry.sessionId); };
  /** Whether [sessionId] is one Riffet just created and 新建会话时 keeps its tab. */
  const takeLaunched = (sessionId: string): boolean => {
    const hit = launched?.sessionId === sessionId && Date.now() - launched.at < LAUNCH_WINDOW_MS;
    if (!hit) return false;
    launched = undefined;
    return store.get().newMode === 'keep';
  };
  /** Makes sure [sessionId] has a tab, as a preview unless [wantKeep] (or the reader keeps every opened one). */
  const select = (sessionId: string, wantKeep: boolean) => {
    const sessions = sessionMap();
    const session = sessions.get(sessionId);
    if (!session || session.archivedAt || isMain(sessionId)) return;
    const keep = wantKeep || store.get().openMode === 'keep';
    store.set((state) => {
      const existing = state.tabs.find((tab) => tab.sessionId === sessionId);
      if (existing) {
        const tabs = keep && existing.preview ? state.tabs.map((tab) => tab === existing ? { sessionId, preview: false } : tab) : state.tabs;
        return { tabs, anchor: sessionId };
      }
      const entry: TabEntry = { sessionId, preview: !keep };
      const previewAt = keep ? -1 : state.tabs.findIndex((tab) => tab.preview);
      if (previewAt >= 0) return { tabs: state.tabs.map((tab, index) => index === previewAt ? entry : tab), anchor: sessionId };
      const zones = tabZones(state.tabs, sessions);
      return { tabs: insertNormal(state.tabs, zones.normal, entry, normalInsertIndex(zones, state.anchor)), anchor: sessionId };
    });
  };

  const keepTab = (sessionId: string) => {
    store.set((state) => state.tabs.some((tab) => tab.sessionId === sessionId && tab.preview)
      ? { tabs: state.tabs.map((tab) => tab.sessionId === sessionId ? { sessionId, preview: false } : tab) }
      : state);
  };

  const remove = (ids: ReadonlySet<string>) => {
    store.set((state) => ({ tabs: state.tabs.filter((tab) => !ids.has(tab.sessionId)) }));
  };

  // The selection drives the tabs.
  let lastSelected = nav.get().sessionId;
  nav.subscribe(() => {
    const { sessionId } = nav.get();
    if (sessionId === lastSelected) return;
    lastSelected = sessionId;
    detached = '';
    if (!sessionId || store.get().style === 'off') return;
    const keep = takeLaunched(sessionId) || pendingKeep === sessionId;
    pendingKeep = '';
    select(sessionId, keep);
  });

  let lastSeed = ui.get().nativeRunSeed;
  ui.subscribe(() => {
    const seed = ui.get().nativeRunSeed;
    if (seed === lastSeed) return;
    lastSeed = seed;
    if (seed) launched = { sessionId: seed.sessionId, at: Date.now() };
  });

  let pinnedBefore = new Set<string>();
  const onLists = () => {
    const { loaded, status, sessions } = lists.get();
    if (!loaded) return;
    const pinnedNow = new Set<string>();
    const selected = isPageOpen(nav.get()) ? '' : nav.get().sessionId;
    const unpinned: string[] = [];
    const tabbed = new Set(store.get().tabs.map((tab) => tab.sessionId));
    for (const session of sessions) {
      if (session.pinnedAt) pinnedNow.add(session.id);
      else if (pinnedBefore.has(session.id) && tabbed.has(session.id)) unpinned.push(session.id);
    }
    pinnedBefore = pinnedNow;
    // Tabs stored before the main conversation became a page.
    const mainTabs = store.get().tabs.filter((tab) => isMain(tab.sessionId)).map((tab) => tab.sessionId);
    if (mainTabs.length) remove(new Set(mainTabs));
    if (store.get().style === 'off') return;
    if (unpinned.length) {
      // An unpinned conversation returns to the front of the normal zone, where it is easy to find.
      store.set((state) => {
        const moved = state.tabs.filter((tab) => unpinned.includes(tab.sessionId));
        return { tabs: [...moved, ...state.tabs.filter((tab) => !unpinned.includes(tab.sessionId))] };
      });
    }
    // An archived conversation leaves at once; only a fresh answer says one is gone, since the cached copy may predate it.
    const known = new Map(sessions.map((session) => [session.id, session]));
    const dropped = new Set(store.get().tabs.filter((tab) => { const session = known.get(tab.sessionId); return session ? Boolean(session.archivedAt) : status === 'fresh'; }).map((tab) => tab.sessionId));
    if (dropped.size) remove(dropped);
    if (selected && selected !== detached && !store.get().tabs.some((tab) => tab.sessionId === selected)) select(selected, takeLaunched(selected));
  };
  lists.subscribe(onLists);
  onLists();

  let persisted = { tabs: store.get().tabs, style: store.get().style, openMode: store.get().openMode, newMode: store.get().newMode };
  // Every window writes the whole list, so each takes in the others' writes: a window left open since
  // yesterday would otherwise put its old tabs back. A tab another window closed stays closed here too.
  window.addEventListener('storage', (event) => {
    if (event.storageArea !== window.localStorage) return;
    const all = event.key === null;
    const next = {
      ...(all || event.key === TABS_STORAGE.tabs ? { tabs: readTabs() } : {}),
      ...(all || event.key === TABS_STORAGE.style ? { style: readStyle() } : {}),
      ...(all || event.key === TABS_STORAGE.openMode ? { openMode: readOpenMode() } : {}),
      ...(all || event.key === TABS_STORAGE.newMode ? { newMode: readNewMode() } : {}),
    };
    if (!Object.keys(next).length) return;
    const selected = nav.get().sessionId;
    if (next.tabs && selected && !next.tabs.some((tab) => tab.sessionId === selected)) detached = selected;
    persisted = { ...persisted, ...next };
    store.set(next);
  });
  store.subscribe(() => {
    const { tabs, style, openMode, newMode } = store.get();
    if (tabs !== persisted.tabs) writeStored(TABS_STORAGE.tabs, JSON.stringify(tabs));
    if (style !== persisted.style) writeStored(TABS_STORAGE.style, style === DEFAULT_TAB_STYLE ? undefined : style);
    if (openMode !== persisted.openMode) writeStored(TABS_STORAGE.openMode, openMode === DEFAULT_TAB_OPEN_MODE ? undefined : openMode);
    if (newMode !== persisted.newMode) writeStored(TABS_STORAGE.newMode, newMode === DEFAULT_TAB_NEW_MODE ? undefined : newMode);
    persisted = { tabs, style, openMode, newMode };
  });

  /** Moves the selection off a closing conversation, to [next] or else the project home of the one that closed. */
  const leave = (closing: Pick<Session, 'projectId'>, next: Session | undefined) => {
    const pageOpen = isPageOpen(nav.get());
    if (next) {
      if (pageOpen) nav.set({ projectId: next.projectId, sessionId: next.id }); else handlers.selectSession(next);
      return;
    }
    const show = () => {
      ui.set((current) => ({ ...(current.references.length ? { references: [] } : {}), previewTarget: undefined }));
      nav.set({ projectId: closing.projectId, sessionId: '', ...(pageOpen ? {} : NO_PAGE) });
    };
    if (pageOpen) show(); else void nav.navigate(show);
  };

  const rememberClosed = (ids: readonly string[], zones: TabZones) => {
    for (const id of ids) {
      closedStack.push({ sessionId: id, index: Math.max(0, zones.normal.findIndex((entry) => entry.sessionId === id)) });
    }
    if (closedStack.length > CLOSED_LIMIT) closedStack.splice(0, closedStack.length - CLOSED_LIMIT);
  };

  const activate = (sessionId: string) => {
    const session = sessionOf(sessionId);
    if (session && !session.archivedAt) handlers.selectSession(session);
  };

  const actions = {
    setStyle(style: TabStyle) {
      store.set({ style });
      if (style !== 'off') {
        const { sessionId } = nav.get();
        if (sessionId) select(sessionId, false);
      }
    },
    setOpenMode(openMode: TabOpenMode) { store.set({ openMode }); },
    setNewMode(newMode: TabNewMode) { store.set({ newMode }); },
    /** 加入标签栏: a kept tab for [sessionId], without opening it. */
    add(sessionId: string) {
      const session = sessionOf(sessionId);
      if (store.get().style === 'off' || !session || session.archivedAt || isMain(sessionId)) return;
      if (store.get().tabs.some((tab) => tab.sessionId === sessionId)) { keepTab(sessionId); return; }
      const sessions = sessionMap();
      store.set((state) => {
        const zones = tabZones(state.tabs, sessions);
        return { tabs: insertNormal(state.tabs, zones.normal, { sessionId, preview: false }, normalInsertIndex(zones, state.anchor)) };
      });
    },
    /** A sidebar ⌘-click: the conversation about to open keeps its tab. */
    keepOnOpen(sessionId: string) {
      if (store.get().style === 'off') return;
      if (store.get().tabs.some((tab) => tab.sessionId === sessionId)) keepTab(sessionId);
      else if (nav.get().sessionId === sessionId) select(sessionId, true);
      else pendingKeep = sessionId;
    },
    keep: keepTab,
    activate,
    close(sessionId: string) {
      const zones = zonesNow();
      const ordered = [...zones.pinned, ...zones.normal].map((entry) => entry.sessionId);
      const at = ordered.indexOf(sessionId);
      const closing = sessionOf(sessionId);
      if (at < 0 || !closing) { remove(new Set([sessionId])); return; }
      rememberClosed([sessionId], zones);
      remove(new Set([sessionId]));
      if (nav.get().sessionId !== sessionId) return;
      const neighbour = ordered[at + 1] ?? ordered[at - 1];
      leave(closing, neighbour ? sessionOf(neighbour) : undefined);
    },
    /**
     * Conversations the server deleted: their tabs go, and a selection among them moves to its
     * neighbour as the sidebar lists it (as after an archive), else to its project.
     */
    retire(ids: readonly string[]) {
      const gone = new Set(ids);
      const selectedId = nav.get().sessionId;
      const hit = gone.has(selectedId);
      const selected = hit ? sessionOf(selectedId) : undefined;
      const projectId = selected?.projectId ?? nav.get().projectId;
      const siblings = sortSessionsByActivity(lists.get().sessions.filter((item) => item.projectId === projectId && !item.agentMemberId && (item.id === selectedId || (!item.archivedAt && !gone.has(item.id)))));
      const at = siblings.findIndex((item) => item.id === selectedId);
      // Any of the 助理's or a team member's conversations leaves you on its page, not on one that no list shows.
      const next = hit && !selected?.agentMemberId && !ofAssistant(projectId) ? siblings[at + 1] ?? siblings[at - 1] : undefined;
      for (let index = closedStack.length - 1; index >= 0; index -= 1) if (gone.has(closedStack[index]!.sessionId)) closedStack.splice(index, 1);
      remove(gone);
      if (hit) leave({ projectId }, next);
    },
    /** Pinned tabs stay, as in a browser; the clicked tab becomes the current one. */
    closeOthers(sessionId: string) {
      const zones = zonesNow();
      const closing = zones.normal.filter((entry) => entry.sessionId !== sessionId).map((entry) => entry.sessionId);
      rememberClosed(closing, zones);
      remove(new Set(closing));
      activate(sessionId);
    },
    closeRight(sessionId: string) {
      const zones = zonesNow();
      const ordered = [...zones.pinned, ...zones.normal];
      const at = ordered.findIndex((entry) => entry.sessionId === sessionId);
      const closing = ordered.slice(at + 1).filter((entry) => zones.normal.includes(entry)).map((entry) => entry.sessionId);
      if (at < 0 || !closing.length) return;
      rememberClosed(closing, zones);
      remove(new Set(closing));
      if (closing.includes(nav.get().sessionId)) activate(sessionId);
    },
    /** Reopens the last closed tab at the place it had. */
    reopen() {
      for (let closed = closedStack.pop(); closed; closed = closedStack.pop()) {
        const session = sessionOf(closed.sessionId);
        if (!session || session.archivedAt || isMain(closed.sessionId)) continue;
        if (!store.get().tabs.some((tab) => tab.sessionId === closed.sessionId)) {
          const sessions = sessionMap();
          store.set((state) => {
            const zones = tabZones(state.tabs, sessions);
            return { tabs: insertNormal(state.tabs, zones.normal, { sessionId: closed.sessionId, preview: false }, Math.min(closed.index, zones.normal.length)) };
          });
        }
        activate(closed.sessionId);
        return;
      }
    },
    /** The normal zone's new order after a drag; [ids] is every tab in that zone. */
    reorderNormal(ids: readonly string[]) {
      store.set((state) => {
        const current = tabZones(state.tabs, sessionMap()).normal;
        if (ids.length !== current.length || !ids.every((id) => current.some((entry) => entry.sessionId === id))) return state;
        const byId = new Map(current.map((entry) => [entry.sessionId, entry]));
        let next = 0;
        const tabs = state.tabs.map((tab) => byId.has(tab.sessionId) ? byId.get(ids[next++]!)! : tab);
        return tabs.every((tab, index) => tab === state.tabs[index]) ? state : { tabs };
      });
    },
    /**
     * The pinned zone's new order after a drag; [ids] is every open pinned tab. The server keeps one
     * order for all pinned conversations, so pinned conversations without a tab hold their slots.
     */
    reorderPinned(ids: readonly string[]) {
      const pinned = lists.get().sessions.filter((session) => session.pinnedAt && !session.archivedAt).sort(comparePinnedSessions);
      const open = new Set(ids);
      let next = 0;
      const order = pinned.map((session) => open.has(session.id) ? ids[next++]! : session.id);
      if (next !== ids.length) return;
      // Each server keeps the order of its own pinned conversations (docs/SERVER-LINKS.md §5).
      const parts = new Map<string | undefined, string[]>();
      for (const id of order) { const server = serverOfObject(id); parts.set(server, [...(parts.get(server) ?? []), id]); }
      const rankOf = new Map([...parts.values()].flatMap((part) => part.map((id, rank) => [id, rank] as const)));
      const before = new Map(pinned.map((session) => [session.id, session]));
      const changed = order.flatMap((id) => { const session = before.get(id)!; const rank = rankOf.get(id)!; return session.pinRank === rank ? [] : [{ ...session, pinRank: rank }]; });
      if (!changed.length) return;
      for (const session of changed) lists.upsertSession(session);
      Promise.all([...parts].map(([server, part]) => apiFor(server).setPinOrder(part)))
        .then((answers) => { for (const session of answers.flat()) lists.upsertSession(session); })
        .catch((error) => {
          // Only the rank goes back: the rest of a session may have moved on while the request ran.
          for (const { id } of changed) {
            const current = sessionOf(id);
            if (current) lists.upsertSession({ ...current, pinRank: before.get(id)!.pinRank });
          }
          toast.error(errorMessage(error, i18n._(msg({ message: '操作失败', context: 'workbench-action-failed' }))));
        });
    },
    /** The tab [delta] places from the current one, wrapping; from the home or a page it is the first or last. */
    step(delta: 1 | -1) {
      const ordered = orderedIds();
      if (!ordered.length) return;
      const at = isPageOpen(nav.get()) ? -1 : ordered.indexOf(nav.get().sessionId);
      const target = at < 0 ? (delta > 0 ? 0 : ordered.length - 1) : (at + delta + ordered.length) % ordered.length;
      activate(ordered[target]!);
    },
    /** 1–8 are the nth tab; 9 is the last. */
    goTo(position: number) {
      const ordered = orderedIds();
      const id = position >= 9 ? ordered.at(-1) : ordered[position - 1];
      if (id) activate(id);
    },
  };
  return { ...store, ...actions };
}

export type TabsStore = ReturnType<typeof createTabsStore>;
