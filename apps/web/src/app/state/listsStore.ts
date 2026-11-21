import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { SYNC_BUDGET, type OwnerInfo, type Session, type SessionListDelta, type TaskEvent, type TerminalInfo, type WorkItemSummary } from '@contracts';
import { api, etagRevision, isUnreachable, listsStreamUrl, type Bootstrap, type ConditionalList, type ProjectRecord } from '@/lib/api';
import { loadCachedLists, refreshCachedLists, saveCachedLists } from '@/lib/list-cache';
import { reconcileById, sameRecord } from '@/lib/reconcile';
import { confirmSessionGone, isSessionDeleted } from '@/lib/session-deletion';
import { reconnectDelay } from '@/lib/utils';
import { withShownTitle } from '@/lib/shown-title';
import type { SettingsStore } from './settingsStore';
import { createStore } from '@/lib/store';

/** How often the session list is re-read while the tab is hidden; see the notification poll. */
const HIDDEN_POLL_MS = 15_000;
/** A stream open this long counts as recovered, and its retry backoff starts over. */
const STREAM_STABLE_MS = 10_000;
const RECONNECT_COALESCE_MS = 1000;
const REFRESH_DEDUPE_MS = 1500;
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
  /** The server saves, creates, moves and deletes project files (`file-write-v1`). */
  fileWrites: boolean;
  sessions: Session[];
  terminals: TerminalInfo[];
  /** The workbench owner's personal info (docs/OWNER.md); absent until a server that has one has answered. */
  owner: OwnerInfo | undefined;
  status: ListsStatus;
  savedAt: number;
  bootError: string;
  /** The failed load could not reach the server at all, as opposed to the server refusing it. */
  bootUnreachable: boolean;
}

export interface ListsDeps {
  settings: SettingsStore;
  selectedSessionId: () => string;
  /** Late-bound by the workbench, which owns the selection rules. */
  handlers: { selectSession: (session: Session) => void; reload: () => void };
  /** Shell work-item summaries hydrated from bootstrap and saved alongside the list cache. */
  workItems?: {
    ticket: () => number;
    absorb: (summaries: WorkItemSummary[] | undefined, revision: number | undefined, requestedTicket: number) => void;
    summaries: () => WorkItemSummary[] | undefined;
  };
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
    fileWrites: cached?.bootstrap.protocol?.features.includes('file-write-v1') ?? false,
    sessions: cached?.bootstrap.sessions ?? [],
    terminals: cached?.bootstrap.terminals ?? [],
    owner: cached?.bootstrap.owner,
    status: cached ? 'syncing' : 'fresh',
    savedAt: cached?.savedAt ?? 0,
    bootError: '',
    bootUnreachable: false,
  });
  /** Bumped by every local write and around every bootstrap read; an in-flight poll that straddles one is dropped. */
  let revision = 0;
  let negotiatedProtocol = cached?.bootstrap.protocol;
  /** Projects have their own write generation: session updates must not invalidate their reads. */
  let projectsGeneration = 0;
  /** Terminals' own write generation: a terminal read is stale only across a terminal write, not any write. */
  let terminalsGeneration = 0;
  /** The project revision the held projects were read at, when known. */
  let projectsVersion: number | undefined;
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
  /** The ids a delta took out of the list: deleted, or no longer shown here; only a 410 says which. */
  const confirmGone = (removed: readonly string[], present: readonly Session[]) => {
    if (!store.get().sessionDelete) return;
    for (const item of present) unconfirmed.delete(item.id);
    for (const id of removed) if (!isSessionDeleted(id)) unconfirmed.set(id, true);
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
      const requestedWorkItemsTicket = deps.workItems?.ticket() ?? 0;
      const requestedProjectsGeneration = ++projectsGeneration;
      revision += 1;
      const pending = api.bootstrap();
      pendingBootstrap = pending;
      try {
        const data = await pending;
        negotiatedProtocol = data.protocol;
        revision += 1;
        terminalsGeneration += 1;
        const next = { ...data, settings: deps.settings.absorb(data.settings, requestedRevision) };
        deps.workItems?.absorb(data.workItemSummaries, data.revisions?.workItems, requestedWorkItemsTicket);
        saveCachedLists(next);
        // The reads that follow start where these lists stand; an older server names no revisions, so they start over.
        etags.sessions = data.revisions ? `W/"${data.revisions.sessions}"` : undefined;
        etags.terminals = data.revisions ? `W/"${data.revisions.terminals}"` : undefined;
        const current = store.get();
        const applyProjects = requestedProjectsGeneration === projectsGeneration;
        const previousSessions = current.sessions;
        if (applyProjects) { projectsGeneration += 1; projectsVersion = data.revisions?.projects; }
        // The baseline a later delta's state changes are told against.
        sessionStates = new Map(data.sessions.map((item) => [item.id, item.state]));
        store.set({
          loaded: true,
          projectlessTasks: data.protocol?.features.includes('projectless-tasks') ?? false,
          sessionReferences: data.protocol?.features.includes('session-references-v1') ?? false,
          sessionDelete: data.protocol?.features.includes('session-delete-v1') ?? false,
          projects: applyProjects ? reconcileById(current.projects, data.projects) : current.projects,
          fileWrites: data.protocol?.features.includes('file-write-v1') ?? false,
          sessions: reconcileById(current.sessions, data.sessions.filter((item) => !isSessionDeleted(item.id)).map(withShownTitle)),
          terminals: reconcileById(current.terminals, data.terminals),
          // A full read is the server's word: its revision can go down (a restored backup, a fresh state directory).
          ...(data.owner ? { owner: data.owner } : {}),
          status: 'fresh',
          savedAt: Date.now(),
          bootError: '',
          bootUnreachable: false,
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
    fail(message: string, unreachable = false) { store.set({ bootError: message, bootUnreachable: unreachable, status: 'offline' }); },

    /** Updates the local list copy after an out-of-band shell change (e.g. a work-item status change). */
    refreshCache() {
      const { projects, sessions, terminals, owner, loaded } = store.get();
      if (!loaded) return;
      const workItemSummaries = deps.workItems?.summaries();
      refreshCachedLists({
        projects, sessions, terminals,
        ...(workItemSummaries !== undefined ? { workItemSummaries } : {}),
        ...(owner ? { owner } : {}),
        settings: deps.settings.current(),
        csrfToken: '',
        protocol: negotiatedProtocol,
      });
    },

    /** Takes deleted conversations out of the lists and of the copy the next visit paints from. */
    removeSessions(ids: readonly string[]) {
      const gone = new Set(ids);
      mutate((current) => current.sessions.some((item) => gone.has(item.id)) ? { sessions: current.sessions.filter((item) => !gone.has(item.id)) } : current);
      const { projects, sessions, terminals, owner, loaded } = store.get();
      const workItemSummaries = deps.workItems?.summaries();
      if (loaded) refreshCachedLists({ projects, sessions, terminals, ...(workItemSummaries !== undefined ? { workItemSummaries } : {}), ...(owner ? { owner } : {}), settings: deps.settings.current(), csrfToken: '', protocol: negotiatedProtocol });
    },
    upsertSession(incoming: Session) {
      // A late write for a deleted conversation (a stream frame, a slow response) must not bring it back.
      if (isSessionDeleted(incoming.id)) return;
      const updated = withShownTitle(incoming);
      mutate((current) => {
        const previous = current.sessions.find((item) => item.id === updated.id);
        if (previous && sameRecord(previous, updated)) return current;
        return { sessions: previous ? current.sessions.map((item) => item.id === updated.id ? updated : item) : [...current.sessions, updated] };
      });
    },
    upsertTerminal(updated: TerminalInfo) {
      terminalsGeneration += 1;
      mutate((current) => {
        const previous = current.terminals.find((item) => item.id === updated.id);
        if (previous && sameRecord(previous, updated)) return current;
        return { terminals: previous ? current.terminals.map((item) => item.id === updated.id ? updated : item) : [...current.terminals, updated] };
      });
    },
    removeTerminal(id: string) {
      terminalsGeneration += 1;
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
      terminalsGeneration += 1;
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
      // The bootstrap just read the lists; the safety-net poll counts from now.
      let active = true, lastHiddenPoll = 0, lastPoll = Date.now(), pushed = false, opened = false, missed = false;
      let saveTimer: number | undefined;
      /** Lists read after the bootstrap update the local copy too, so the next visit paints them. */
      const saveSoon = () => {
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => {
          const { projects, sessions, terminals, owner } = store.get();
          const workItemSummaries = deps.workItems?.summaries();
          refreshCachedLists({ projects, sessions, terminals, ...(workItemSummaries !== undefined ? { workItemSummaries } : {}), ...(owner ? { owner } : {}), settings: deps.settings.current(), csrfToken: '', protocol: negotiatedProtocol });
        }, SAVE_DEBOUNCE_MS);
      };
      let wantedProjectsVersion: number | undefined, requestedProjectsVersion: number | undefined;
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
          // The bootstrap may have read this very revision.
          if (!force && version !== undefined && version === projectsVersion) return;
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
      const noticeBackground = (incoming: Session[], complete: boolean, removed: readonly string[] = []) => {
        const previous = sessionStates;
        const next = complete ? new Map<string, Session['state']>() : new Map(previous);
        for (const id of removed) next.delete(id);
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
            const notification = new Notification('Riffet', { body: i18n._(msg`「${item.displayTitle ?? item.title}」${body}`), tag: item.id });
            notification.onclick = () => { window.focus(); deps.handlers.selectSession(item); };
          } catch { /* ignore */ }
        }
        sessionStates = next;
      };
      const hasDelta = () => negotiatedProtocol?.features.includes('list-delta') === true;
      let sessionsInFlight = false, sessionsAgain = false, terminalsInFlight = false, terminalsAgain = false;
      /** A whole list dropped for a local write is read once more at once; a stream writing on every frame must not keep it reading. */
      let fullRetried = false;
      const onReadError = (error: unknown) => {
        if (active && isUnreachable(error)) store.set({ status: 'offline' });
      };
      const readSessions = () => {
        if (sessionsInFlight) { sessionsAgain = true; return; }
        sessionsInFlight = true;
        const startedAt = revision;
        const since = hasDelta() ? etagRevision(etags.sessions) : undefined;
        const read: Promise<ConditionalList<Pick<SessionListDelta, 'full' | 'sessions' | 'removed'>>> = since === undefined
          ? api.sessionsIfChanged(etags.sessions).then((answer) => answer.unchanged ? answer : { ...answer, data: { full: true, sessions: answer.data } })
          : api.sessionsSince(since, etags.sessions);
        void read
          .then((answer) => {
            if (!active) return;
            if (store.get().status === 'offline') deps.handlers.reload();
            else store.set({ status: 'fresh' });
            if (answer.unchanged) return;
            const current = store.get();
            const { full, sessions: incoming, removed = [] } = answer.data;
            if (full) {
              // A whole list read across a local write may hold an older copy of what it changed.
              if (startedAt !== revision) { if (!fullRetried) { fullRetried = true; sessionsAgain = true; } return; }
              fullRetried = false;
              etags.sessions = answer.etag;
              const sessions = reconcileById(current.sessions, incoming.filter((item) => !isSessionDeleted(item.id)).map(withShownTitle));
              noticeBackground(incoming, true);
              confirmMissing(current.sessions, incoming);
              if (sessions !== current.sessions) { store.set({ sessions }); saveSoon(); }
              return;
            }
            etags.sessions = answer.etag;
            noticeBackground(incoming, false, removed);
            confirmGone(removed, incoming);
            const sessions = mergeDelta(current.sessions, incoming.map(withShownTitle), removed);
            if (sessions !== current.sessions) { store.set({ sessions }); saveSoon(); }
          })
          .catch(onReadError)
          .finally(() => { sessionsInFlight = false; if (sessionsAgain) { sessionsAgain = false; readSessions(); } });
      };
      const readTerminals = () => {
        if (terminalsInFlight) { terminalsAgain = true; return; }
        terminalsInFlight = true;
        const startedAt = terminalsGeneration;
        void api.terminalsIfChanged(etags.terminals)
          .then((answer) => {
            if (!active || answer.unchanged) return;
            if (startedAt !== terminalsGeneration) { terminalsAgain = true; return; }
            etags.terminals = answer.etag;
            const current = store.get();
            const terminals = reconcileById(current.terminals, answer.data);
            if (terminals !== current.terminals) { store.set({ terminals }); saveSoon(); }
          })
          .catch(onReadError)
          .finally(() => { terminalsInFlight = false; if (terminalsAgain) { terminalsAgain = false; readTerminals(); } });
      };
      const poll = (lists: { sessions: boolean; terminals: boolean } = { sessions: true, terminals: true }) => {
        if (!active) return;
        if (document.visibilityState !== 'visible') {
          const now = Date.now();
          // A change pushed while throttled is remembered, so the interval fetches it once allowed.
          if (now - lastHiddenPoll < HIDDEN_POLL_MS) { missed = true; return; }
          lastHiddenPoll = now;
        }
        missed = false;
        lastPoll = Date.now();
        if (lists.sessions) readSessions();
        if (lists.terminals) readTerminals();
      };
      /** Each domain advances separately; legacy servers may omit some or all revisions. */
      const changed = (event: Event) => {
        const data = (event as MessageEvent<string>).data;
        let pushedRevision: number | undefined;
        let marksRevision: number | undefined;
        let favoritesRevision: number | undefined;
        let workItemsRevision: number | undefined;
        let projectsRevision: number | undefined;
        let terminalsRevision: number | undefined;
        try {
          const parsed: unknown = data ? JSON.parse(data) : undefined;
          if (parsed && typeof (parsed as { revision?: unknown }).revision === 'number') pushedRevision = (parsed as { revision: number }).revision;
          if (parsed && typeof (parsed as { marks?: unknown }).marks === 'number') marksRevision = (parsed as { marks: number }).marks;
          if (parsed && typeof (parsed as { favorites?: unknown }).favorites === 'number') favoritesRevision = (parsed as { favorites: number }).favorites;
          if (parsed && typeof (parsed as { workItems?: unknown }).workItems === 'number') workItemsRevision = (parsed as { workItems: number }).workItems;
          if (parsed && typeof (parsed as { projects?: unknown }).projects === 'number') projectsRevision = (parsed as { projects: number }).projects;
          if (parsed && typeof (parsed as { terminals?: unknown }).terminals === 'number') terminalsRevision = (parsed as { terminals: number }).terminals;
        } catch { /* legacy payload */ }
        if (projectsRevision !== undefined) { wantedProjectsVersion = projectsRevision; refreshProjects(); }
        const readMoved = () => {
          // Compare against what the bootstrap in flight just delivered, not the cached copy on screen.
          announce({ ...(marksRevision === undefined ? {} : { marks: marksRevision }), ...(favoritesRevision === undefined ? {} : { favorites: favoritesRevision }), ...(workItemsRevision === undefined ? {} : { workItems: workItemsRevision }) });
          const sessions = pushedRevision === undefined || pushedRevision !== etagRevision(etags.sessions);
          // An older server moves terminals with the session revision.
          const terminalsPushed = terminalsRevision ?? pushedRevision;
          const terminals = terminalsPushed === undefined || terminalsPushed !== etagRevision(etags.terminals);
          if (sessions || terminals) poll({ sessions, terminals });
        };
        if (pendingBootstrap) void pendingBootstrap.then(readMoved, readMoved); else readMoved();
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
      const reconnected = () => {
        refreshOwner(); announceTask(undefined); announcePlugins(); announceDevices(); announceChannels();
        // A `list-delta` server opens the stream with a `changed` naming every list's revision; an older one is read again.
        if (hasDelta()) return;
        announce({}); refreshProjects(true); poll();
      };
      let closeStream: (() => void) | undefined;
      let retryTimer: number | undefined;
      let retries = 0;
      let nextSocketAttempt = 0;
      let usingSse = false;
      const supportsWebSocket = () => negotiatedProtocol?.features.includes('list-stream-ws') === true;
      let stableTimer: number | undefined;
      let reconnectedTimer: number | undefined;
      const streamOpened = () => {
        // A flapping stream keeps its backoff; the counter resets only once it has stayed open.
        window.clearTimeout(stableTimer);
        stableTimer = window.setTimeout(() => { retries = 0; }, STREAM_STABLE_MS);
        pushed = true;
        if (opened) {
          // One catch-up per flap burst, on the trailing edge.
          window.clearTimeout(reconnectedTimer);
          reconnectedTimer = window.setTimeout(() => { if (active) reconnected(); }, RECONNECT_COALESCE_MS);
        } else if (!hasDelta()) refreshProjects(true);
        opened = true;
      };
      const events: Record<string, (event: Event) => void> = {
        changed, task, owner, integrations: announcePlugins, devices: announceDevices, channels: announceChannels,
      };
      const retry = () => {
        pushed = false;
        window.clearTimeout(stableTimer);
        closeStream?.();
        closeStream = undefined;
        if (active) retryTimer = window.setTimeout(connect, reconnectDelay(++retries));
      };
      const connect = () => {
        retryTimer = undefined;
        if (!active) return;
        // WebSockets leave the browser's limited HTTP/1.1 connections for sync and commands.
        usingSse = false;
        if (supportsWebSocket() && Date.now() >= nextSocketAttempt) {
          const url = new URL(listsStreamUrl(), window.location.href);
          url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
          try {
            const socket = new WebSocket(url);
            let established = false;
            const disconnected = () => {
              // A proxy may block upgrades. Keep its SSE stream until a later
              // foreground activity or a reconnect can try WebSocket again.
              if (!established) nextSocketAttempt = Date.now() + PUSHED_POLL_MS;
              retry();
            };
            const handshakeTimer = window.setTimeout(disconnected, SYNC_BUDGET.pingMs);
            closeStream = () => {
              window.clearTimeout(handshakeTimer);
              socket.onclose = null;
              socket.onmessage = null;
              socket.close();
            };
            socket.onmessage = ({ data }) => {
              if (!active || typeof data !== 'string') return;
              let frame: { event?: unknown; data?: unknown } | null;
              try { frame = JSON.parse(data); } catch { return; }
              if (!frame || typeof frame.event !== 'string' || !Object.hasOwn(events, frame.event)) return;
              if (!established) {
                if (frame.event !== 'changed') return;
                established = true;
                window.clearTimeout(handshakeTimer);
                streamOpened();
              }
              events[frame.event]!(new MessageEvent(frame.event, { data: JSON.stringify(frame.data) }));
            };
            socket.onclose = disconnected;
            return;
          } catch { nextSocketAttempt = Date.now() + PUSHED_POLL_MS; }
        }
        usingSse = true;
        const source = new EventSource(listsStreamUrl());
        closeStream = () => { source.onerror = null; source.close(); };
        source.onopen = streamOpened;
        source.onerror = () => {
          pushed = false;
          if (active && source.readyState === EventSource.CLOSED) retry();
        };
        for (const [type, listener] of Object.entries(events)) source.addEventListener(type, listener);
      };
      if (pendingBootstrap) void pendingBootstrap.then(connect, connect);
      else connect();
      const timer = window.setInterval(() => { if (missed || !pushed || Date.now() - lastPoll >= PUSHED_POLL_MS) poll(); }, 5000);
      // While the stream is up it has told every project change; without it the projects are read again.
      let lastRefresh = 0;
      const refresh = () => {
        // focus, visibilitychange and online arrive together on a tab switch.
        const now = Date.now();
        if (now - lastRefresh < REFRESH_DEDUPE_MS) return;
        lastRefresh = now;
        poll();
        if (!pushed) refreshProjects(true);
        if (usingSse && supportsWebSocket() && Date.now() >= nextSocketAttempt) {
          closeStream?.();
          closeStream = undefined;
          pushed = false;
          window.clearTimeout(retryTimer);
          connect();
        }
      };
      const onVisibility = () => { if (document.visibilityState === 'visible') refresh(); };
      // Coming back online is news even right after a focus whose read failed offline.
      const onOnline = () => { lastRefresh = 0; refresh(); };
      window.addEventListener('focus', refresh);
      window.addEventListener('online', onOnline);
      document.addEventListener('visibilitychange', onVisibility);
      return () => {
        active = false; closeStream?.(); window.clearTimeout(retryTimer); window.clearTimeout(stableTimer); window.clearTimeout(reconnectedTimer); window.clearTimeout(saveTimer); window.clearInterval(timer);
        window.removeEventListener('focus', refresh); window.removeEventListener('online', onOnline);
        document.removeEventListener('visibilitychange', onVisibility);
      };
    },
  };
  return { ...store, ...actions };
}

export type ListsStore = ReturnType<typeof createListsStore>;

/**
 * [held] with a delta applied (docs/LIST-SYNC.md): a changed session replaces its copy unless the copy
 * is newer (a stream frame landed meanwhile), removed ones go, and the order is the server's.
 */
function mergeDelta(held: Session[], changed: readonly Session[], removed: readonly string[]): Session[] {
  if (!changed.length && !removed.length) return held;
  const gone = new Set(removed);
  const incoming = new Map(changed.filter((item) => !isSessionDeleted(item.id)).map((item) => [item.id, item]));
  const next = held.flatMap((item) => {
    if (gone.has(item.id)) return [];
    const update = incoming.get(item.id);
    if (!update) return [item];
    incoming.delete(item.id);
    return [update.updatedAt < item.updatedAt ? item : update];
  });
  next.push(...incoming.values());
  next.sort((a, b) => (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt));
  return reconcileById(held, next);
}
