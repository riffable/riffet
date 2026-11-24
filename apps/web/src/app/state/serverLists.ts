import { LINK_BUDGET, type ServerInfo, type Session, type TerminalInfo } from '@contracts';
import { api, isUnreachable, type Bootstrap, type ProjectRecord } from '@/lib/api';
import { entryListCache, linkedListCache, type ListCache } from '@/lib/list-cache';
import { forgetServer, locate, serverOfObject } from '@/lib/server-routing';
import { createStore, type Store } from '@/lib/store';
import { errorMessage } from '@/lib/utils';
import { createListsStore, type ListsDeps, type ListsState, type ListsStore } from './listsStore';

export interface ServerListsState extends ListsState {
  /** This server first, then the servers linked with it (`server-links-v1`); empty on a server without links. */
  servers: ServerInfo[];
  /** Each linked server's lists: read (`fresh`), being read, or not reachable (`offline`). */
  linkedStatus: Readonly<Record<string, ListsState['status']>>;
}

interface Linked { store: ListsStore; cache: ListCache; workOnly: (state: ListsState) => ListsState; unsubscribe: () => void; disconnect?: () => void }

/**
 * The lists of every server this workbench reaches (docs/SERVER-LINKS.md §5). Each server's lists are kept by
 * their own `createListsStore`, which reads that server through the entry and follows its lists stream; this
 * merges them into the one set of lists the workbench shows. With no linked server it passes the entry's
 * lists through unchanged.
 *
 * A write goes to the store of the server the object lives on: its own id, then its project's, then the server
 * the caller names (a conversation or project just created on a linked server is in no list yet).
 */
export function createServerLists(deps: ListsDeps) {
  const entry = createListsStore(deps);
  const linked = new Map<string, Linked>();
  let connected = false;
  const initialServers = entryListCache.load()?.bootstrap.servers ?? [];
  const store = createStore<ServerListsState>({ ...entry.get(), servers: initialServers, linkedStatus: {} });
  const statuses = (): ServerListsState['linkedStatus'] => {
    const next = Object.fromEntries([...linked].map(([id, item]) => [id, item.store.get().status]));
    const held = store.get().linkedStatus;
    const same = Object.keys(next).length === Object.keys(held).length && Object.entries(next).every(([id, status]) => held[id] === status);
    return same ? held : next;
  };

  /** Merged arrays are rebuilt only when one of their inputs changed, so selectors see stable references. */
  let lastInputs: unknown[] = [];
  let lastMerged: Pick<ListsState, 'sessions' | 'projects' | 'terminals'> | undefined;
  const merge = () => {
    const base = entry.get();
    const others = [...linked.values()].filter((item) => item.store.get().loaded).map((item) => item.workOnly(item.store.get()));
    if (!others.length) { store.set({ ...base, linkedStatus: statuses() }); return; }
    const inputs = [base.sessions, base.projects, base.terminals, ...others.flatMap((state) => [state.sessions, state.projects, state.terminals])];
    if (!lastMerged || inputs.length !== lastInputs.length || inputs.some((value, index) => value !== lastInputs[index])) {
      lastInputs = inputs;
      lastMerged = {
        sessions: [base.sessions, ...others.map((state) => state.sessions)].flat()
          .sort((a, b) => (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt)),
        projects: [base.projects, ...others.map((state) => state.projects)].flat(),
        terminals: [base.terminals, ...others.map((state) => state.terminals)].flat(),
      };
    }
    store.set({ ...base, ...lastMerged, linkedStatus: statuses() });
  };

  /** Records where a linked server's objects are, so requests about them reach it (`server-routing.ts`). */
  const located = new Map<string, unknown[]>();
  const record = (serverId: string, state: ListsState) => {
    const seen = located.get(serverId);
    if (seen && seen[0] === state.sessions && seen[1] === state.projects && seen[2] === state.terminals) return;
    located.set(serverId, [state.sessions, state.projects, state.terminals]);
    locate(state.projects.map((item) => item.id), serverId);
    locate(state.sessions.map((item) => item.id), serverId);
    locate(state.terminals.map((item) => item.id), serverId);
    // An attempt group is reached by its own id (`/api/attempts/<groupId>`); its conversations name it.
    locate(state.sessions.flatMap((item) => item.origin?.groupId ? [item.origin.groupId] : []), serverId);
  };

  const open = (serverId: string) => {
    let held: Linked | undefined;
    const reload = () => { if (held) void loadLinked(held.store); };
    const cache = linkedListCache(serverId);
    const linkedStore = createListsStore({
      settings: deps.settings,
      selectedSessionId: deps.selectedSessionId,
      handlers: { selectSession: (session) => deps.handlers.selectSession(session), reload },
      server: serverId,
      cache,
    });
    record(serverId, linkedStore.get());
    const unsubscribe = linkedStore.subscribe(() => { record(serverId, linkedStore.get()); merge(); });
    held = { store: linkedStore, cache, workOnly: createWorkOnly(), unsubscribe };
    linked.set(serverId, held);
    if (connected) { void loadLinked(linkedStore); held.disconnect = linkedStore.connect(); }
  };
  const close = (serverId: string, forget: boolean) => {
    const held = linked.get(serverId);
    if (!held) return;
    held.disconnect?.();
    held.unsubscribe();
    linked.delete(serverId);
    located.delete(serverId);
    forgetServer(serverId);
    // A read still in flight, or a write already scheduled, must not bring the kept copy back.
    held.cache.retire();
    if (forget) held.cache.clear();
  };
  /** A linked server that cannot be reached keeps its last lists on screen, marked offline. */
  const loadLinked = (target: ListsStore) => target.load().catch((error: unknown) => {
    target.fail(errorMessage(error, ''), isUnreachable(error));
  });

  /**
   * Opens a store for each linked server this one may operate and whose protocol it speaks, and closes the rest.
   * A server that left the list takes its kept copy with it.
   */
  const adopt = (servers: ServerInfo[]) => {
    const wanted = new Set(servers.filter((item) => !item.self && item.outbound && item.compatible).map((item) => item.id));
    const listed = new Set(servers.map((item) => item.id));
    for (const id of [...linked.keys()]) if (!wanted.has(id)) close(id, !listed.has(id));
    for (const id of wanted) if (!linked.has(id)) open(id);
    store.set({ servers });
    merge();
  };
  adopt(initialServers);

  const refreshServers = () => {
    void api.servers().then(({ servers }) => adopt(servers)).catch(() => { /* the next push or reconnect retries */ });
  };

  /** The store holding an object, found by the first of `ids` some server is known to hold; the entry's by default. */
  const holder = (serverId: string | undefined, ...ids: Array<string | undefined>): ListsStore | undefined => {
    const server = serverId ?? ids.map((id) => serverOfObject(id)).find(Boolean);
    if (!server) return entry;
    // A server whose store is closed (no longer linked, or no longer allowed) takes no writes.
    return linked.get(server)?.store;
  };
  const every = (): ListsStore[] => [entry, ...[...linked.values()].map((item) => item.store)];

  entry.subscribe(merge);

  return {
    get: store.get,
    subscribe: store.subscribe,
    /** Writes the entry server's own fields; the merged lists follow from each server's store. */
    set: ((update) => entry.set(update as Parameters<ListsStore['set']>[0])) as Store<ServerListsState>['set'],
    /**
     * The entry's bootstrap with every server's lists, which the selection is judged against. A linked server already
     * kept is not waited for; one read for the first time is, up to `LINK_BUDGET.firstListWaitMs`.
     */
    async load(): Promise<Bootstrap> {
      const data = await entry.load();
      adopt(data.servers ?? []);
      const first: Array<Promise<unknown>> = [];
      for (const item of linked.values()) {
        const loading = loadLinked(item.store);
        if (!item.store.get().loaded) first.push(loading);
      }
      if (first.length) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.all(first), new Promise((resolve) => { timer = setTimeout(resolve, LINK_BUDGET.firstListWaitMs); })]);
        clearTimeout(timer);
      }
      const merged = store.get();
      return { ...data, projects: merged.projects, sessions: merged.sessions, terminals: merged.terminals };
    },
    connect(): () => void {
      connected = true;
      const stopEntry = entry.connect();
      for (const item of linked.values()) item.disconnect ??= item.store.connect();
      const stopServers = entry.onServers(refreshServers);
      return () => {
        connected = false;
        stopEntry();
        stopServers();
        for (const item of linked.values()) { item.disconnect?.(); item.disconnect = undefined; }
      };
    },
    // A new worktree's project is on its origin's server.
    upsertProject(project: ProjectRecord, serverId?: string) { holder(serverId, project.id, project.worktree?.originProjectId)?.upsertProject(project); },
    replaceProject(project: ProjectRecord) { holder(undefined, project.id)?.replaceProject(project); },
    upsertSession(session: Session, serverId?: string) { holder(serverId, session.id, session.projectId)?.upsertSession(session); },
    upsertTerminal(terminal: TerminalInfo, serverId?: string) { holder(serverId, terminal.id, terminal.projectId)?.upsertTerminal(terminal); },
    removeTerminal(id: string) { holder(undefined, id)?.removeTerminal(id); },
    markHandedOff(sessionId: string, to: string) { holder(undefined, sessionId)?.markHandedOff(sessionId, to); },
    adoptTerminal(found: TerminalInfo, sessionId: string) { holder(undefined, sessionId)?.adoptTerminal(found, sessionId); },
    removeSessions(ids: readonly string[]) { for (const target of every()) target.removeSessions(ids); },
    refreshCache() { for (const target of every()) target.refreshCache(); },
    // The entry's own: personal info, 收藏, tasks, plugins, devices, channels and approvals are not merged.
    setOwner: entry.setOwner,
    fail: entry.fail,
    onChanged: entry.onChanged,
    onTask: entry.onTask,
    onPlugins: entry.onPlugins,
    onDevices: entry.onDevices,
    onChannels: entry.onChannels,
    onPluginApprovals: entry.onPluginApprovals,
    onCouncil: entry.onCouncil,
    onServers: entry.onServers,
  };
}

export type ServerLists = ReturnType<typeof createServerLists>;

/**
 * A linked server's lists without its own system projects: its personal assistant and quick chats stay in its own
 * workbench (docs/SERVER-LINKS.md §3), and its projectless tasks would merge with the entry's. Kept per server and
 * rebuilt only when one of its lists changed, so the merged lists keep their references across status changes.
 */
function createWorkOnly(): (state: ListsState) => ListsState {
  let last: { from: unknown[]; kept: Pick<ListsState, 'projects' | 'sessions' | 'terminals'> } | undefined;
  return (state) => {
    const from = [state.projects, state.sessions, state.terminals];
    if (!last || from.some((value, index) => value !== last!.from[index])) {
      const system = new Set(state.projects.filter((item) => item.system).map((item) => item.id));
      last = {
        from,
        kept: system.size ? {
          projects: state.projects.filter((item) => !system.has(item.id)),
          sessions: state.sessions.filter((item) => !system.has(item.projectId)),
          terminals: state.terminals.filter((item) => !system.has(item.projectId)),
        } : { projects: state.projects, sessions: state.sessions, terminals: state.terminals },
      };
    }
    return { ...state, ...last.kept };
  };
}
