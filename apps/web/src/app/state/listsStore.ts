import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { OwnerInfo, Session, TaskEvent, TerminalInfo } from '@contracts';
import { api, etagRevision, listsStreamUrl, type Bootstrap, type ProjectRecord } from '@/lib/api';
import { loadCachedLists, refreshCachedLists, saveCachedLists } from '@/lib/list-cache';
import { reconcileById, sameRecord } from '@/lib/reconcile';
import { confirmSessionGone, isSessionDeleted } from '@/lib/session-deletion';
import { reconnectDelay } from '@/lib/utils';
import type { SettingsStore } from './settingsStore';
import { createStore } from '@/lib/store';

/** How often the session list is re-read while the tab is hidden; see the notification poll. */
const HIDDEN_POLL_MS = 15_000;
/** While the server pushes list changes the poll is only a safety net. */
const PUSHED_POLL_MS = 30_000;
/** A running turn moves the session list every few hundred milliseconds; the local copy follows at this pace. */
const SAVE_DEBOUNCE_MS = 2_000;

/**
 * Whether the lists on screen are the server's current answer. A reload starts `syncing` while the
 * cached copy is painted, and a load that fails becomes `offline` rather than an empty workbench.
 */
export type ListsStatus = 'fresh' | 'syncing' | 'offline';

/** Revisions a `changed` push carries for data outside the session and terminal lists. */
export interface ChangeRevisions { marks?: number; favorites?: number; workItems?: number }

export interface ListsState {
  /** False until the first lists (cached or fetched) exist; the workbench shows a spinner until then. */
  loaded: boolean;
  projectlessTasks: boolean;
  sessionReferences: boolean;
  /** The server can delete conversations (`session-delete-v1`); older ones only archive. */
  sessionDelete: boolean;
  projects: ProjectRecord[];
  sessions: Session[];
  terminals: TerminalInfo[];
  /** The workbench owner's personal info (docs/OWNER.md); absent until a server that has one has answered. */
  owner: OwnerInfo | undefined;
  status: ListsStatus;
  savedAt: number;
  bootError: string;
}

export interface ListsDeps {
  settings: SettingsStore;
  selectedSessionId: () => string;
  /** Late-bound by the workbench, which owns the selection rules. */
  handlers: { selectSession: (session: Session) => void; reload: () => void };
}

/**
 * Projects, sessions and terminals: the bootstrap read, local patches, and the push/poll loop that
 * keeps the session and terminal lists current.
 */
export function createListsStore(deps: ListsDeps) {
  /**
   * The lists the last visit ended with. Read once during creation, so a reload paints the
   * workbench instead of a spinner and keeps painting it if the server cannot be reached.
   */
  const cached = loadCachedLists();
  const store = createStore<ListsState>({
    loaded: Boolean(cached),
    projectlessTasks: cached?.bootstrap.protocol?.features.includes('projectless-tasks') ?? false,
    sessionReferences: cached?.bootstrap.protocol?.features.includes('session-references-v1') ?? false,
    sessionDelete: cached?.bootstrap.protocol?.features.includes('session-delete-v1') ?? false,
    projects: cached?.bootstrap.projects ?? [],
    sessions: cached?.bootstrap.sessions ?? [],
    terminals: cached?.bootstrap.terminals ?? [],
    owner: cached?.bootstrap.owner,
    status: cached ? 'syncing' : 'fresh',
    savedAt: cached?.savedAt ?? 0,
    bootError: '',
  });
  /** Bumped by every local write and around every bootstrap read; an in-flight poll that straddles one is dropped. */
  let revision = 0;
  let negotiatedProtocol = cached?.bootstrap.protocol;
  /** Projects have their own write generation: session updates must not invalidate their reads. */
  let projectsGeneration = 0;
  let pendingBootstrap: Promise<Bootstrap> | undefined;
  /** The `ETag` each list was last applied with. Absent means the server sent none, so every poll reads in full. */
  const etags: { sessions?: string; terminals?: string } = {};
  /** The state the list last reported per conversation, so a transition can be told from a re-read. */
  let sessionStates = new Map<string, Session['state']>();
  /**
   * Told about every `changed` push and reconnect, for data that rides the same stream: 收藏
   * and folder favorites, whose own revisions the push carries as `marks` and `favorites`
   * (absent on a reconnect, or from an older server).
   */
  const changeListeners = new Set<(revisions: ChangeRevisions) => void>();
  const announce = (revisions: ChangeRevisions) => { for (const listener of [...changeListeners]) listener(revisions); };
  /** Told about every `task` push (docs/TASKS.md), and with `undefined` after a reconnect, which may have missed some. */
  const taskListeners = new Set<(event: TaskEvent | undefined) => void>();
  const announceTask = (event: TaskEvent | undefined) => { for (const listener of [...taskListeners]) listener(event); };
  /** Told when a plugin is turned on or off, here or in another client, and after a reconnect, which may have missed it. */
  const pluginListeners = new Set<() => void>();
  const announcePlugins = () => { for (const listener of [...pluginListeners]) listener(); };
  /** Told when a device came online, went offline, reported or was unpaired, and after a reconnect. */
  const deviceListeners = new Set<() => void>();
  const announceDevices = () => { for (const listener of [...deviceListeners]) listener(); };
  /** Told when IM channel accounts, bindings or chats changed, and after a reconnect. */
  const channelListeners = new Set<() => void>();
  const announceChannels = () => { for (const listener of [...channelListeners]) listener(); };

  const mutate = (update: (current: ListsState) => Partial<ListsState>) => {
    revision += 1;
    store.set((current) => current.loaded ? update(current) : current);
  };

  /** The revision both lists were last read at, when they agree. */
  const knownRevision = () => {
    const sessions = etagRevision(etags.sessions);
    return sessions !== undefined && sessions === etagRevision(etags.terminals) ? sessions : undefined;
  };

  /**
   * A fresh full list that lacks a conversation the previous one held is evidence it was deleted
   * elsewhere, but only the server's `410 SESSION_DELETED` settles it; a cached list or a failed read never reaches here.
   */
  const confirmMissing = (previous: Session[], incoming: Session[]) => {
    if (!store.get().sessionDelete) return;
    const present = new Set(incoming.map((item) => item.id));
    for (const item of previous) if (!present.has(item.id) && !isSessionDeleted(item.id)) unconfirmed.set(item.id, true);
    for (const id of [...unconfirmed.keys()]) if (present.has(id)) unconfirmed.delete(id);
    drainUnconfirmed();
  };
  /** Missing ids still to be asked about; a few per round so a large removal does not flood the server. */
  const unconfirmed = new Map<string, true>();
  let draining = false;
  const drainUnconfirmed = () => {
    if (draining) return;
    draining = true;
    void (async () => {
      while (unconfirmed.size) {
        const batch = [...unconfirmed.keys()].slice(0, 10);
        for (const id of batch) unconfirmed.delete(id);
        // A failed check proves nothing and cleans nothing up.
        await Promise.all(batch.map((id) => confirmSessionGone(id)));
      }
    })().finally(() => { draining = false; });
  };

  const actions = {
    upsertProject(project: ProjectRecord) {
      projectsGeneration += 1;
      mutate((current) => ({ projects: reconcileById(current.projects, current.projects.some((item) => item.id === project.id) ? current.projects.map((item) => item.id === project.id ? project : item) : [...current.projects, project]) }));
    },
    /**
     * The full read. Settings are folded in by the settings store; the caller applies the selection.
     * Resolves with the bootstrap as the server sent it (settings after the merge).
     */
    async load(): Promise<Bootstrap> {
      const requestedRevision = deps.settings.revision();
      const requestedProjectsGeneration = ++projectsGeneration;
      revision += 1;
      const pending = api.bootstrap();
      pendingBootstrap = pending;
      try {
        const data = await pending;
        negotiatedProtocol = data.protocol;
        revision += 1;
        const next = { ...data, settings: deps.settings.absorb(data.settings, requestedRevision) };
        saveCachedLists(next);
        // The lists just read may be newer than the ETags held; start the conditional reads over.
        etags.sessions = undefined;
        etags.terminals = undefined;
        const current = store.get();
        const applyProjects = requestedProjectsGeneration === projectsGeneration;
        const previousSessions = current.sessions;
        if (applyProjects) projectsGeneration += 1;
        store.set({
          loaded: true,
          projectlessTasks: data.protocol?.features.includes('projectless-tasks') ?? false,
          sessionReferences: data.protocol?.features.includes('session-references-v1') ?? false,
          sessionDelete: data.protocol?.features.includes('session-delete-v1') ?? false,
          projects: applyProjects ? reconcileById(current.projects, data.projects) : current.projects,
          sessions: reconcileById(current.sessions, data.sessions.filter((item) => !isSessionDeleted(item.id))),
          terminals: reconcileById(current.terminals, data.terminals),
          // A full read is the server's word: its revision can go down (a restored backup, a fresh state directory).
          ...(data.owner ? { owner: data.owner } : {}),
          status: 'fresh',
          savedAt: Date.now(),
          bootError: '',
        });
        confirmMissing(previousSessions, data.sessions);
        return next;
      } finally {
        if (pendingBootstrap === pending) pendingBootstrap = undefined;
      }
    },
    /**
     * Calls [listener] whenever the server pushes `changed` or the stream reconnects. The push
     * carries no detail about what changed, so a listener re-reads its own data conditionally.
     */
    onChanged(listener: (revisions: ChangeRevisions) => void): () => void {
      changeListeners.add(listener);
      return () => { changeListeners.delete(listener); };
    },
    /** Calls [listener] for each project task that starts, is asked to stop or ends, and with `undefined` when the stream reconnects. */
    onTask(listener: (event: TaskEvent | undefined) => void): () => void {
      taskListeners.add(listener);
      return () => { taskListeners.delete(listener); };
    },
    /** Calls [listener] when the plugins that are on may have changed. */
    onPlugins(listener: () => void): () => void {
      pluginListeners.add(listener);
      return () => { pluginListeners.delete(listener); };
    },
    /** Calls [listener] when the paired devices may read differently (online, allowed, capabilities). */
    onDevices(listener: () => void): () => void {
      deviceListeners.add(listener);
      return () => { deviceListeners.delete(listener); };
    },
    /** Calls [listener] when the IM channels' accounts, bound users or chats may read differently. */
    onChannels(listener: () => void): () => void {
      channelListeners.add(listener);
      return () => { channelListeners.delete(listener); };
    },
    /** Adopts the owner a write answered with, unless a newer one has already arrived over the stream. */
    setOwner(owner: OwnerInfo) {
      store.set((current) => current.owner && current.owner.revision > owner.revision ? current : { owner });
    },
    /** A failed load keeps whatever lists are on screen and labels them as offline. */
    fail(message: string) { store.set({ bootError: message, status: 'offline' }); },

    /** Takes deleted conversations out of the lists and of the copy the next visit paints from. */
    removeSessions(ids: readonly string[]) {
      const gone = new Set(ids);
      mutate((current) => current.sessions.some((item) => gone.has(item.id)) ? { sessions: current.sessions.filter((item) => !gone.has(item.id)) } : current);
      const { projects, sessions, terminals, owner, loaded } = store.get();
      if (loaded) refreshCachedLists({ projects, sessions, terminals, ...(owner ? { owner } : {}), settings: deps.settings.current(), csrfToken: '', protocol: negotiatedProtocol });
    },
    upsertSession(updated: Session) {
      // A late write for a deleted conversation (a stream frame, a slow response) must not bring it back.
      if (isSessionDeleted(updated.id)) return;
      mutate((current) => {
        const previous = current.sessions.find((item) => item.id === updated.id);
        if (previous && sameRecord(previous, updated)) return current;
        return { sessions: previous ? current.sessions.map((item) => item.id === updated.id ? updated : item) : [...current.sessions, updated] };
      });
    },
    upsertTerminal(updated: TerminalInfo) {
      mutate((current) => {
        const previous = current.terminals.find((item) => item.id === updated.id);
        if (previous && sameRecord(previous, updated)) return current;
        return { terminals: previous ? current.terminals.map((item) => item.id === updated.id ? updated : item) : [...current.terminals, updated] };
      });
    },
    removeTerminal(id: string) {
      mutate((current) => ({ terminals: current.terminals.filter((item) => item.id !== id), sessions: current.sessions.map((item) => item.terminalId === id ? { ...item, terminalId: undefined } : item) }));
    },
    replaceProject(updated: ProjectRecord) {
      projectsGeneration += 1;
      mutate((current) => ({ projects: current.projects.map((item) => item.id === updated.id ? updated : item) }));
    },
    markHandedOff(sessionId: string, to: string) {
      mutate((current) => ({ sessions: current.sessions.map((item) => item.id === sessionId ? { ...item, handedOffTo: to } : item) }));
    },
    /** A native session's terminal, once the session reports it, unless the lists already hold it or a newer one. */
    adoptTerminal(found: TerminalInfo, sessionId: string) {
      mutate((current) => {
        if (current.sessions.find((item) => item.id === sessionId)?.terminalId !== found.id) return current;
        const existing = current.terminals.find((item) => item.id === found.id);
        if (existing && existing.epoch >= found.epoch) return current;
        return { terminals: existing ? current.terminals.map((item) => item.id === found.id ? found : item) : [...current.terminals, found] };
      });
    },

    /**
     * Keeps sessions and terminals current: the server pushes `changed` over a stream, a poll covers
     * the gaps, and both read conditionally so an unchanged list costs a 304. Returns the teardown.
     */
    connect(): () => void {
      let active = true, inFlight = false, again = false, lastHiddenPoll = 0, lastPoll = 0, pushed = false, opened = false, missed = false;
      let saveTimer: number | undefined;
      /** Lists read after the bootstrap update the local copy too, so the next visit paints them. */
      const saveSoon = () => {
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => {
          const { projects, sessions, terminals, owner } = store.get();
          refreshCachedLists({ projects, sessions, terminals, ...(owner ? { owner } : {}), settings: deps.settings.current(), csrfToken: '', protocol: negotiatedProtocol });
        }, SAVE_DEBOUNCE_MS);
      };
      let projectsVersion: number | undefined, wantedProjectsVersion: number | undefined, requestedProjectsVersion: number | undefined;
      let projectsInFlight = false, projectsAgain = false;
      const refreshProjects = (force = false) => {
        if (!active) return;
        if (projectsInFlight) {
          if (force || requestedProjectsVersion !== wantedProjectsVersion) projectsAgain = true;
          return;
        }
        if (!force && wantedProjectsVersion !== undefined && wantedProjectsVersion === projectsVersion) return;
        projectsInFlight = true;
        requestedProjectsVersion = wantedProjectsVersion;
        const version = requestedProjectsVersion;
        void (async () => {
          // A bootstrap owns the full snapshot; read projects after it instead of racing its write.
          while (pendingBootstrap) {
            try { await pendingBootstrap; } catch { /* The project read can still recover independently. */ }
            if (!active) return;
          }
          const startedAt = projectsGeneration;
          const incoming = await api.projects();
          if (!active) return;
          if (startedAt !== projectsGeneration || version !== wantedProjectsVersion) { projectsAgain = true; return; }
          const current = store.get();
          if (!current.loaded) return;
          const projects = reconcileById(current.projects, incoming);
          if (projects !== current.projects) { store.set({ projects }); saveSoon(); }
          projectsVersion = version;
        })()
          // Keep the previous snapshot and version; another push or focus retries a failed read.
          .catch(() => {})
          .finally(() => {
            projectsInFlight = false;
            if (active && projectsAgain) { projectsAgain = false; refreshProjects(true); }
          });
      };
      /**
       * The per-session stream only covers the conversation on screen, so a background one that
       * finished, failed or started waiting used to go unnoticed. This list is the only place its
       * state moves, which is also why the poll keeps running while the tab is hidden — just far
       * less often, since nothing is being painted.
       */
      const noticeBackground = (incoming: Session[]) => {
        const previous = sessionStates;
        const next = new Map<string, Session['state']>();
        for (const item of incoming) {
          next.set(item.id, item.state);
          const before = previous.get(item.id);
          if (before === undefined || before === item.state || item.archivedAt) continue;
          if (item.id === deps.selectedSessionId()) continue;
          if (document.visibilityState !== 'hidden') continue;
          if (deps.settings.current().notifications !== true) continue;
          if (!('Notification' in window) || Notification.permission !== 'granted') continue;
          const finished = (before === 'running' || before === 'starting' || before === 'cancelling') && item.state === 'idle';
          const body = item.state === 'waiting' ? i18n._(msg`需要你确认`) : item.state === 'failed' ? i18n._(msg`运行失败`) : finished ? i18n._(msg({ message: '已完成', context: 'workbench-item-status-completed' })) : '';
          if (!body) continue;
          try {
            // Clicking brings the window back and opens that conversation; `tag` replaces the previous
            // notification for the same one instead of stacking another.
            const notification = new Notification('Riffet', { body: i18n._(msg`「${item.title}」${body}`), tag: item.id });
            notification.onclick = () => { window.focus(); deps.handlers.selectSession(item); };
          } catch { /* ignore */ }
        }
        sessionStates = next;
      };
      const poll = () => {
        if (!active || inFlight) return;
        if (document.visibilityState !== 'visible') {
          const now = Date.now();
          // A change pushed while throttled is remembered, so the interval fetches it once allowed.
          if (now - lastHiddenPoll < HIDDEN_POLL_MS) { missed = true; return; }
          lastHiddenPoll = now;
        }
        inFlight = true;
        missed = false;
        lastPoll = Date.now();
        const startedAt = revision;
        void Promise.all([api.sessionsIfChanged(etags.sessions), api.terminalsIfChanged(etags.terminals)])
          .then(([incomingSessions, incomingTerminals]) => {
            if (!active || startedAt !== revision) return;
            // Only now that the answer is being applied is its ETag worth remembering.
            if (!incomingSessions.unchanged) etags.sessions = incomingSessions.etag;
            if (!incomingTerminals.unchanged) etags.terminals = incomingTerminals.etag;
            if (store.get().status === 'offline') deps.handlers.reload();
            else store.set({ status: 'fresh' });
            const current = store.get();
            const sessions = incomingSessions.unchanged ? current.sessions : reconcileById(current.sessions, incomingSessions.data.filter((item) => !isSessionDeleted(item.id)));
            const terminals = incomingTerminals.unchanged ? current.terminals : reconcileById(current.terminals, incomingTerminals.data);
            if (!incomingSessions.unchanged) { noticeBackground(incomingSessions.data); confirmMissing(current.sessions, incomingSessions.data); }
            if (sessions !== current.sessions || terminals !== current.terminals) { store.set({ sessions, terminals }); saveSoon(); }
          })
          .catch(() => store.set({ status: 'offline' }))
          .finally(() => { inFlight = false; if (again) { again = false; poll(); } });
      };
      /** Each domain advances separately; legacy servers may omit some or all revisions. */
      const changed = (event: Event) => {
        const data = (event as MessageEvent<string>).data;
        let pushedRevision: number | undefined;
        let marksRevision: number | undefined;
        let favoritesRevision: number | undefined;
        let workItemsRevision: number | undefined;
        let projectsRevision: number | undefined;
        try {
          const parsed: unknown = data ? JSON.parse(data) : undefined;
          if (parsed && typeof (parsed as { revision?: unknown }).revision === 'number') pushedRevision = (parsed as { revision: number }).revision;
          if (parsed && typeof (parsed as { marks?: unknown }).marks === 'number') marksRevision = (parsed as { marks: number }).marks;
          if (parsed && typeof (parsed as { favorites?: unknown }).favorites === 'number') favoritesRevision = (parsed as { favorites: number }).favorites;
          if (parsed && typeof (parsed as { workItems?: unknown }).workItems === 'number') workItemsRevision = (parsed as { workItems: number }).workItems;
          if (parsed && typeof (parsed as { projects?: unknown }).projects === 'number') projectsRevision = (parsed as { projects: number }).projects;
        } catch { /* legacy payload */ }
        // Before the list check: a mark change pushes without moving the lists' revision.
        announce({ ...(marksRevision === undefined ? {} : { marks: marksRevision }), ...(favoritesRevision === undefined ? {} : { favorites: favoritesRevision }), ...(workItemsRevision === undefined ? {} : { workItems: workItemsRevision }) });
        if (projectsRevision !== undefined) { wantedProjectsVersion = projectsRevision; refreshProjects(); }
        if (pushedRevision !== undefined && pushedRevision === knownRevision()) return;
        if (inFlight) again = true; else poll();
      };
      const task = (event: Event) => {
        try { const parsed = JSON.parse((event as MessageEvent<string>).data) as Partial<TaskEvent>; if (typeof parsed.id === 'string' && typeof parsed.projectId === 'string') announceTask(parsed as TaskEvent); } catch { /* not a task event */ }
      };
      /** The push is the whole record, so it replaces the one held. */
      const owner = (event: Event) => {
        try {
          const parsed = JSON.parse((event as MessageEvent<string>).data) as Partial<OwnerInfo>;
          if (typeof parsed.revision === 'number') { store.set({ owner: parsed as OwnerInfo }); saveSoon(); }
        } catch { /* not an owner event */ }
      };
      /** A reconnect may have missed an owner push. */
      const refreshOwner = () => {
        void api.owner().then((incoming) => {
          if (active && store.get().loaded && incoming.revision !== store.get().owner?.revision) { store.set({ owner: incoming }); saveSoon(); }
        }).catch(() => {});
      };
      const reconnected = () => { announce({}); refreshOwner(); announceTask(undefined); announcePlugins(); announceDevices(); announceChannels(); refreshProjects(true); if (inFlight) again = true; else poll(); };
      let source: EventSource | undefined;
      let retryTimer: number | undefined;
      let retries = 0;
      const connect = () => {
        retryTimer = undefined;
        if (!active) return;
        const current = new EventSource(listsStreamUrl());
        source = current;
        // A reconnect may have missed changes made while the stream was down.
        current.onopen = () => { retries = 0; pushed = true; if (opened) reconnected(); else refreshProjects(true); opened = true; };
        current.onerror = () => {
          pushed = false;
          // The browser retries a dropped stream by itself, but gives up for good on an HTTP error,
          // which a proxy or a restarting server can return. The poll covers the gap meanwhile.
          if (!active || source !== current || current.readyState !== EventSource.CLOSED || retryTimer !== undefined) return;
          current.close();
          retries += 1;
          retryTimer = window.setTimeout(connect, reconnectDelay(retries));
        };
        current.addEventListener('changed', changed);
        current.addEventListener('task', task);
        current.addEventListener('owner', owner);
        current.addEventListener('integrations', announcePlugins);
        current.addEventListener('devices', announceDevices);
        current.addEventListener('channels', announceChannels);
      };
      connect();
      const timer = window.setInterval(() => { if (missed || !pushed || Date.now() - lastPoll >= PUSHED_POLL_MS) poll(); }, 5000);
      const onFocus = () => { poll(); refreshProjects(true); };
      const onVisibility = () => { poll(); if (document.visibilityState === 'visible') refreshProjects(true); };
      window.addEventListener('focus', onFocus);
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        active = false; source?.close(); window.clearTimeout(retryTimer); window.clearTimeout(saveTimer); window.clearInterval(timer);
        window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisibility);
      };
    },
  };
  return { ...store, ...actions };
}

export type ListsStore = ReturnType<typeof createListsStore>;
