import { useMemo, useState } from 'react';
import { isDoneUnseen, type Session } from '@contracts';
import type { ProjectRecord } from '@/lib/api';
import { sessionBackend } from '@/lib/backends';
import { isAssistantProject, sidebarProjectMap } from '@/lib/project-family';
import { serverOfObject } from '@/lib/server-routing';
import { readStored, writeStored } from '@/lib/utils';
import { useLists } from './state/stores';

const SERVER_FILTER_KEY = 'riffet.sidebarServerFilter';

export function inSidebarServerScope(session: Session, serverFilter: string, selfServerId?: string): boolean {
  if (serverFilter === 'all') return true;
  const owner = serverOfObject(session.id);
  if (serverFilter === 'local') return !owner;
  if (serverFilter === 'relevant') return !owner || (selfServerId !== undefined && session.origin?.kind === 'link' && session.origin.serverId === selfServerId);
  return owner === serverFilter;
}

interface Filters {
  serverFilter: string;
  selfServerId?: string;
  selectedSessionId: string;
  showArchived: boolean;
  filterTag: string;
  unreadOnly: boolean;
}

/** The timeline and project groups show these same rows. Count unread before either layout folds its rows. */
export function selectSidebarSessions(sessions: readonly Session[], visibleProjects: ReadonlyMap<string, ProjectRecord>, filters: Filters) {
  const live = new Set(sessions.filter((session) => !session.archivedAt).map((session) => session.id));
  const rows: Session[] = [];
  const tags = new Set<string>();
  let unreadCount = 0;
  for (const session of sessions) {
    if (!visibleProjects.has(session.projectId) || sessionBackend(session) === 'chat') continue;
    const origin = session.origin;
    if (origin?.kind === 'assistant' || origin?.kind === 'council' || origin?.kind === 'discussion') continue;
    const selected = session.id === filters.selectedSessionId;
    // A called Agent is reached from its caller, except while the child itself is selected.
    if (!selected && origin?.kind === 'call' && origin.sessionId && live.has(origin.sessionId)) continue;
    const inScope = inSidebarServerScope(session, filters.serverFilter, filters.selfServerId);
    // Keep the open row reachable without admitting an out-of-scope session to the unread count.
    if (!inScope && !selected) continue;
    if (!session.archivedAt) {
      for (const tag of session.tags ?? []) tags.add(tag);
    }
    if ((!filters.showArchived && session.archivedAt) || (filters.filterTag && !session.tags?.includes(filters.filterTag))) continue;
    const unread = isDoneUnseen(session);
    if (inScope && unread) unreadCount++;
    if (!filters.unreadOnly || selected || unread) rows.push(session);
  }
  return { rows, tags: [...tags].sort(), unreadCount };
}

export function useSidebarSessions(projects: readonly ProjectRecord[], sessions: readonly Session[], selectedSessionId: string, projectlessName: string) {
  const [showArchived, setShowArchived] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [filterTag, setFilterTag] = useState('');
  const [storedFilter, setStoredFilter] = useState(() => readStored(SERVER_FILTER_KEY) || 'relevant');
  const servers = useLists((state) => state.servers);
  const selfServerId = servers.find((item) => item.self)?.id;
  const peerServers = useMemo(() => servers.filter((item) => !item.self && item.outbound && item.compatible), [servers]);
  const serverFilter = peerServers.length > 0 && (storedFilter === 'all' || storedFilter === 'local' || peerServers.some((item) => item.id === storedFilter))
    ? storedFilter : 'relevant';
  const setServerFilter = (value: string) => {
    writeStored(SERVER_FILTER_KEY, value === 'relevant' ? undefined : value);
    setStoredFilter(value);
  };
  const visibleProjects = useMemo(() => sidebarProjectMap(projects.filter((project) => !isAssistantProject(project)), showArchived, projectlessName), [projects, showArchived, projectlessName]);
  const result = useMemo(() => selectSidebarSessions(sessions, visibleProjects, {
    selectedSessionId, serverFilter, selfServerId, showArchived, filterTag, unreadOnly,
  }), [sessions, visibleProjects, selectedSessionId, serverFilter, selfServerId, showArchived, filterTag, unreadOnly]);
  return { ...result, visibleProjects, peerServers, selfServerId, serverFilter, setServerFilter, showArchived, setShowArchived, filterTag, setFilterTag, unreadOnly, setUnreadOnly };
}
