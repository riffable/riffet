import { memo, useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Notice } from '@/components/ui/notice';
import { IconArchive, IconArchiveRestore, IconBookmarkFilled, IconChevronRight, IconEllipsis, IconEye, IconFolderClosed, IconFolderOpen, IconFolderPlus, IconLaptop, IconLink, IconPanelLeft, IconMessageCirclePlus, IconPencilLine, IconPin, IconPinOff, IconPlus, IconSearch, IconServer, IconSquareKanban, IconSquarePen, IconSquareTerminal, IconTag, IconTrash2, IconX } from '@/components/icons';
import { isDoneUnseen, WORK_ITEM_STATUSES, type NativeBackendCatalogEntry, type Session, type WorkItemStatus } from '@contracts';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { Spinner, StatusDot } from '@/components/ui/controls';
import { BrandMark } from '@/components/BrandMark';
import { AgentLogo } from '@/components/AgentLogo';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger, MenuSub } from '@/components/ui/dropdown-menu';
import { ListRow, rowConceal, rowReveal } from '@/components/ui/list-row';
import { Tip } from '@/components/ui/tooltip';
import { api, apiFor, type ProjectRecord } from '@/lib/api';
import { serverOfObject } from '@/lib/server-routing';
import { ServerTag, useServerBadge } from './useServerLabel';
import { errorMessage } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { cn, isJustNow, readStored, relativeTime, writeStored } from '@/lib/utils';
import { isActiveSession, sessionActivityAt, sortSessionsByActivity } from '@/lib/session-order';
import { inSidebarServerScope, type useSidebarSessions } from './useSidebarSessions';
import { agentMarkStyle, sessionBackend, useBackendLabel } from '@/lib/backends';
import { useLocale } from '@/lib/i18n';
import { useShortcutHint } from './shortcuts';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { useListWindow } from '@/lib/use-list-window';
import { useDeletionLoading } from './SessionDeletion';
import { useHeld } from './session/sessionLayout';
import { useLists, useStores, useWorkItems } from './state/stores';
import { SIDEBAR_DESTINATION_META, WEB_SIDEBAR_DESTINATIONS, type WebSidebarDestination } from './sidebarDestinations';
import { SidebarDestinationRows, sidebarNavRow } from './SidebarDestinationRows';
import { useSidebarPinned } from './useSidebarPinned';
import type { ViewEntry } from '@/plugins/catalog';
import { viewIcon } from '@/plugins/viewIcons';
import { useTabs } from './tabs/useTabs';
import type { SettingsSection } from './settings/settingsSections';
import { SidebarUpdateButton } from './SidebarUpdateButton';
import { SidebarSettingsButton, SidebarUserMenu } from './SidebarUserMenu';
import { StatusIcon, useStatusLabel } from './work-items/parts';

export type EntityAction = 'rename' | 'tags' | 'archive';
export type SessionAction = EntityAction | 'pin' | 'delete' | 'work-item';

interface Props {
  projects: ProjectRecord[];
  sessions: Session[];
  sessionList: ReturnType<typeof useSidebarSessions>;
  selectedProjectId: string;
  selectedSessionId: string;
  backend?: NativeBackendCatalogEntry;
  onSelectProject: (project: ProjectRecord) => void;
  onSelectNoProject?: () => void;
  /** [keep] is a ⌘/Ctrl-click: the conversation opens as a kept tab. */
  onSelectSession: (session: Session, keep?: boolean) => void;
  onNewSession: () => void;
  onAddProject: () => void;
  onProjectAction: (project: ProjectRecord, action: EntityAction) => void;
  onSessionAction: (session: Session, action: SessionAction) => void;
  /** Opens settings, on `section` when given. */
  onOpenSettings: (section?: SettingsSection) => void;
  /** Opens the settings page that picks which destinations are rows and which sit under 更多. */
  onCustomizeSidebar: () => void;
  /** Opens settings on the personal info page. */
  onOpenProfile: () => void;
  onOpenStats: () => void;
  /** 任务 (docs/TASK-BOARD.md); absent on a server without work items. */
  onOpenTasks?: () => void;
  /** What the 任务 inbox holds, shown at the end of its row. */
  tasksCount?: number;
  tasksActive?: boolean;
  /** The 个人助理 page (docs/ASSISTANT.md), second in the navigation; absent while there is no 助理 project. */
  onOpenAssistant?: () => void;
  assistantActive?: boolean;
  /** Its main conversation, whose state the row shows: the sidebar's lists do not hold it. */
  assistantSession?: Session;
  onOpenAutomations: () => void;
  onOpenCouncil?: () => void;
  councilActive?: boolean;
  onOpenMarks: () => void;
  onOpenExtensions: () => void;
  onOpenPlugins: () => void;
  pluginsActive?: boolean;
  /** Top-level (`location: 'main'`) plugin views offered in the sidebar or 更多 menu. */
  mainViews?: readonly ViewEntry[];
  activeMainViewId?: string;
  onOpenMainView?: (viewId: string) => void;
  onOpenSearch: () => void;
  statsActive?: boolean;
  automationsActive?: boolean;
  marksActive?: boolean;
  extensionsActive?: boolean;
  onCollapse?: () => void;
  /** Offered while a collapsed sidebar is peeking over the conversation: keeps it open. */
  onPin?: () => void;
  onClose?: () => void;
  /**
   * Set while these lists are the local copy rather than the server's current answer. `syncing` is
   * the normal first paint after a reload and only tints the host button, since the answer usually
   * lands before anyone reads a banner; `offline` means the server could not be reached, so the
   * reader is told the list may be out of date instead of being shown it as fact.
   */
  stale?: { mode: 'syncing' | 'offline'; savedAt: number };
}

const COLLAPSED_KEY = 'riffet.collapsedProjects';
const LAYOUT_KEY = 'riffet.sidebarLayout';
const SORT_KEY = 'riffet.sidebarSort';
const PROJECT_SESSION_LIMIT = 5;

type SidebarLayout = 'project' | 'time';
/** 按标签页顺序 orders the pinned conversations as the tab bar's pinned zone does. */
type SidebarSort = 'activity' | 'tabs';
export function timeBucket(session: Session, now: Date): string {
  if (session.pinnedAt) return i18n._(msg`置顶`);
  if (isActiveSession(session)) return i18n._(msg({ message: '进行中', context: 'workbench-session-status-active' }));
  const at = new Date(sessionActivityAt(session));
  if (Number.isNaN(at.getTime())) return i18n._(msg`更早`);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  if (at.getTime() >= today) return i18n._(msg`今天`);
  if (at.getTime() >= today - day) return i18n._(msg`昨天`);
  if (at.getTime() >= today - 6 * day) return i18n._(msg`近 7 天`);
  if (at.getTime() >= today - 29 * day) return i18n._(msg`近 30 天`);
  return i18n._(msg`更早`);
}

/** "离线 · 显示 5 分钟前保存的列表"; an age under a minute reads as 刚刚 rather than 0 分钟. */
function offlineLabel(savedAt: number): string {
  if (!savedAt) return i18n._(msg`离线 · 显示上次保存的列表`);
  const age = relativeTime(new Date(savedAt).toISOString());
  return isJustNow(new Date(savedAt).toISOString()) ? i18n._(msg`离线 · 显示刚刚保存的列表`) : i18n._(msg`离线 · 显示 ${age} 前保存的列表`);
}

/**
 * Leading status slot of a conversation row. One mark occupies the 16px icon column so titles stay
 * vertically aligned with the sidebar's navigation labels: terminal hold, running (task ring turns
 * in place of a separate spinner), waiting, unread, or the task's status ring.
 */
export function SessionIndicator({ session, mobile, selected, taskStatus }: { session: Session; mobile: boolean; selected: boolean; taskStatus?: WorkItemStatus }) {
  const { t } = useLingui();
  const running = session.state === 'running' || session.state === 'starting';
  // Finished while nobody looked; the open conversation is being read. A failure once read is shown
  // in the conversation itself, so the row drops its mark like any other read one.
  const unread = !selected && isDoneUnseen(session);
  if (session.terminalHold) return <span role="img" aria-label={t`在终端中`} title={t`在终端中`} className="inline-flex text-fg-3"><IconSquareTerminal className="size-3.5" /></span>;
  if (running) {
    if (taskStatus) return <StatusIcon status={taskStatus} running />;
    return mobile
      ? <><Spinner className="size-3.5 text-accent" /><span className="sr-only">{t`运行中`}</span></>
      : <span role="img" aria-label={t`运行中`} title={t`运行中`} className="inline-flex"><Spinner className="size-3 text-accent" /></span>;
  }
  if (session.state === 'waiting') {
    return mobile
      ? <StatusDot tone="warning" shape="ring" pulse label={t`等待处理`} className="size-2" />
      : <StatusDot tone="warning" label={t`等待处理`} />;
  }
  if (unread && session.state === 'failed') return <StatusDot tone="danger" label={t`运行失败`} className={mobile ? 'size-2' : undefined} />;
  if (unread) return <StatusDot tone="accent" label={t`未读`} className={mobile ? 'size-2' : undefined} />;
  if (taskStatus) return <StatusIcon status={taskStatus} />;
  return null;
}

/** A `role="button"` row answers Enter and Space like a native button; keys pressed on the controls inside it stay theirs. */
function activateOnKey(event: KeyboardEvent<HTMLElement>, run: () => void): void {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  run();
}

function RowMenu({ children, label }: { children: ReactNode; label: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={label} onClick={(event) => event.stopPropagation()} className="grid size-6 shrink-0 place-items-center rounded-md text-fg-3 hover:bg-active hover:text-fg data-[state=open]:bg-active data-[state=open]:text-fg">
          <IconEllipsis className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44" onClick={(event) => event.stopPropagation()}>{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A task conversation's 修改状态 ▸, in place of 转为任务. Absent until the task is loaded. */
function TaskStatusSub({ workItemId }: { workItemId: string }) {
  const { t } = useLingui();
  const { workItems } = useStores();
  const statusLabel = useStatusLabel();
  const status = useWorkItems((state) => state.summaries?.find((entry) => entry.id === workItemId)?.status);
  if (!status) return null;
  return (
    <MenuSub icon={<StatusIcon status={status} className="size-4" />} label={t`修改状态`} value={statusLabel(status)}>
      <DropdownMenuRadioGroup value={status} onValueChange={(value) => { if (value !== status) void workItems.update(workItemId, { status: value as WorkItemStatus }); }}>
        {WORK_ITEM_STATUSES.map((entry) => <DropdownMenuRadioItem key={entry} value={entry}><StatusIcon status={entry} className="size-4" />{statusLabel(entry)}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </MenuSub>
  );
}

/**
 * One conversation row. It takes plain values and the sidebar's stable callbacks, so a list update
 * re-renders only the rows whose conversation (or label) actually changed.
 */
export const SessionRow = memo(function SessionRow({ session, selected, mobile, projectName, time, marked, hideTags, onSelect, onAction }: {
  session: Session;
  selected: boolean;
  mobile: boolean;
  /** Set in the time layout, where conversations of different projects share one list. */
  projectName: string | undefined;
  /** Recomputed by the sidebar on each render, so the label ages with it as it always did. */
  time: string;
  /** Shows the bookmark beside a conversation that has a saved reply. */
  marked?: boolean;
  /** Quick chats are listed without the tag action the sidebar's conversations carry. */
  hideTags?: boolean;
  onSelect: (session: Session, keep?: boolean) => void;
  onAction: (session: Session, action: SessionAction) => void;
}) {
  const { t } = useLingui();
  const { tabs } = useStores();
  const tabsOn = useTabs((state) => state.style !== 'off');
  const kept = useTabs((state) => state.tabs.some((tab) => tab.sessionId === session.id && !tab.preview));
  const deletable = useLists((state) => state.sessionDelete);
  const deleting = useDeletionLoading(session.id);
  const backend = sessionBackend(session);
  const label = useBackendLabel()(backend);
  const taskStatus = useWorkItems((state) => session.workItemId ? state.summaries?.find((entry) => entry.id === session.workItemId)?.status : undefined);
  // Remote conversations carry a quiet link icon with 1 peer, or its short alias when 2+ peers exist.
  const server = useServerBadge(session.id);
  const place = projectName;
  return (
    <ListRow
      title={`${label}${server ? ` · ${server.label}` : ''} · ${session.title}`}
      onClick={(event) => onSelect(session, event.metaKey || event.ctrlKey)}
      selected={selected}
      aria-current={selected ? 'page' : undefined}
      leading={<SessionIndicator session={session} mobile={mobile} selected={selected} taskStatus={taskStatus} />}
      // The others recede a step so the selected row reads first. On desktop `px-2` matches the
      // primary nav and project rows so titles align on the same vertical axis.
      className={cn('cursor-default', mobile ? 'text-fg hover:text-fg' : 'px-2', session.archivedAt && 'opacity-60')}
      // Decoration, not controls: in `actions` a click on them would stay theirs and never open the row.
      trailing={<>
      {marked && <span role="img" aria-label={t`已收藏`} title={t`已收藏`} className="inline-flex shrink-0 text-accent"><IconBookmarkFilled className="size-3.5" /></span>}
      {server && (
        <Tip label={server.label}>
          {server.multiPeer ? (
            <span aria-label={server.label} className={cn('max-w-16 shrink-0 truncate rounded bg-subtle px-1 py-px font-mono text-2xs', server.offline ? 'text-warning' : 'text-fg-4')}>
              {server.alias}
            </span>
          ) : (
            <span role="img" aria-label={server.label} className={cn('inline-flex shrink-0', server.offline ? 'text-warning' : 'text-fg-4')}>
              <IconLink className="size-3" />
            </span>
          )}
        </Tip>
      )}
      {/* Idle, a row is a title and its time: which agent ran it and which directory it belongs to
          are only worth the width once the pointer is on the row (or the keyboard is inside it),
          and on a touch screen there is no hover to wait for, so they simply stay. */}
      <span role="img" aria-label={label} className="inline-flex shrink-0 items-center text-fg-4 can-hover:hidden can-hover:group-hover/row:inline-flex can-hover:group-focus-within/row:inline-flex">
        <AgentLogo backend={backend} size={11} style={agentMarkStyle(backend)} />
      </span>
      {place && <span className="max-w-[40%] shrink-0 truncate text-2xs text-fg-4 can-hover:hidden can-hover:group-hover/row:block can-hover:group-focus-within/row:block">{place}</span>}
      </>}
      actions={<>
      {/* The time and the ⋯ button share one grid cell so the trigger keeps a stable box while
          the menu plays its exit animation. Toggling `display` here would collapse the popper
          anchor to 0×0 and make the closing menu jump to the viewport corner.
          Both must also stay clickable: an `opacity: 0` sibling creates a stacking context, which
          paints (and hit-tests) ABOVE in-flow content, so the faded time would swallow clicks on
          the ⋯ button. `z-10` keeps the actions on top and the faded time stops taking pointers.
          `items-center` is what centers the time: the cell is as tall as the 24px ⋯ button, and a
          stretched 16px line box would otherwise sit 4px above the row's center. */}
      <span className="grid shrink-0 items-center justify-items-end">
        <span className={cn('col-start-1 row-start-1 text-2xs tabular-nums', rowConceal, mobile ? 'text-fg-3 opacity-70' : session.state === 'waiting' ? 'text-warning' : 'text-fg-4')}>{!mobile && session.state === 'waiting' ? t({ message: '待确认', context: 'workbench-session-pending' }) : time}</span>
        <span className={cn('col-start-1 row-start-1 z-10 flex shrink-0', rowReveal)}>
        <RowMenu label={t`会话操作`}>
          <DropdownMenuItem onSelect={() => onAction(session, 'rename')}><IconPencilLine /><Trans>重命名</Trans></DropdownMenuItem>
          {!hideTags && <DropdownMenuItem onSelect={() => onAction(session, 'tags')}><IconTag /><Trans>编辑标签</Trans></DropdownMenuItem>}
          {!hideTags && (session.workItemId
            ? <TaskStatusSub workItemId={session.workItemId} />
            : <DropdownMenuItem onSelect={() => onAction(session, 'work-item')}><IconSquareKanban /><Trans>转为任务</Trans></DropdownMenuItem>)}
          <DropdownMenuItem onSelect={() => onAction(session, 'pin')}>{session.pinnedAt ? <><IconPinOff /><Trans>取消置顶</Trans></> : <><IconPin /><Trans>置顶会话</Trans></>}</DropdownMenuItem>
          {tabsOn && !mobile && !session.archivedAt && (kept
            ? <DropdownMenuItem onSelect={() => tabs.close(session.id)}><IconX /><Trans>移出标签栏</Trans></DropdownMenuItem>
            : <DropdownMenuItem onSelect={() => tabs.add(session.id)}><IconPlus /><Trans>加入标签栏</Trans></DropdownMenuItem>)}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onAction(session, 'archive')}>{session.archivedAt ? <><IconArchiveRestore /><Trans context="workbench-restore-session">恢复会话</Trans></> : <><IconArchive /><Trans>归档会话</Trans></>}</DropdownMenuItem>
          {deletable && <DropdownMenuItem variant="danger" disabled={deleting} onSelect={() => onAction(session, 'delete')}><IconTrash2 /><Trans>删除…</Trans></DropdownMenuItem>}
        </RowMenu>
        </span>
      </span>
      </>}
    >
      {session.title}
    </ListRow>
  );
});

/** One line of the sidebar's conversation section. */
type SidebarEntry =
  | { kind: 'label'; key: string; label: string }
  | { kind: 'session'; key: string; session: Session; project?: ProjectRecord }
  | { kind: 'project'; key: string; project: ProjectRecord; open: boolean; spaced: boolean }
  | { kind: 'more'; key: string; projectId: string; hidden: number }
  | { kind: 'less'; key: string; projectId: string }
  | { kind: 'empty'; key: string };

export function Sidebar(props: Props) {
  const { t } = useLingui();
  const sidebarHint = useShortcutHint('toggleSidebar');
  const searchHint = useShortcutHint('search');
  // `timeBucket` reads the active catalog directly, so the timeline must recompute on a switch.
  const locale = useLocale();
  const { projects, sessions, selectedProjectId, selectedSessionId } = props;
  // The phone drawer keeps its own established look; the desktop restyle stops at the breakpoint.
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const { rows, tags, visibleProjects, peerServers, selfServerId, serverFilter, setServerFilter,
    showArchived, setShowArchived, filterTag, setFilterTag, unreadOnly, setUnreadOnly } = props.sessionList;
  const hasLinkedServers = peerServers.length > 0;
  const [layout, setLayoutState] = useState<SidebarLayout>(() => readStored(LAYOUT_KEY) === 'project' ? 'project' : 'time');
  const setLayout = (value: string) => {
    const next: SidebarLayout = value === 'time' ? 'time' : 'project';
    writeStored(LAYOUT_KEY, next);
    setLayoutState(next);
  };
  const tabStyle = useTabs((state) => state.style);
  const [storedSort, setStoredSort] = useState<SidebarSort>(() => readStored(SORT_KEY) === 'tabs' ? 'tabs' : 'activity');
  const setSort = (value: string) => {
    const next: SidebarSort = value === 'tabs' ? 'tabs' : 'activity';
    writeStored(SORT_KEY, next === 'tabs' ? next : undefined);
    setStoredSort(next);
  };
  // Without tabs there is no tab order to follow.
  const sort: SidebarSort = tabStyle === 'off' ? 'activity' : storedSort;
  const pinnedOrder = sort === 'tabs' ? 'rank' : 'time';
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(readStored(COLLAPSED_KEY).split(',').filter(Boolean)));
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());

  const toggleProject = (id: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    writeStored(COLLAPSED_KEY, [...next].join(','));
    return next;
  });

  const toggleShowAll = (id: string) => setExpandedProjects((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const selectedSidebarProjectId = visibleProjects.get(selectedProjectId)?.id;
  const canStartSession = Boolean(selectedProjectId || props.onSelectNoProject || projects.some((project) => !project.system && !project.archivedAt));
  const groups = useMemo(() => {
    if (layout !== 'project') return [];
    const byProject = new Map<string, Session[]>();
    for (const session of rows) {
      const projectId = visibleProjects.get(session.projectId)?.id;
      if (!projectId) continue;
      const bucket = byProject.get(projectId) ?? [];
      bucket.push(session);
      byProject.set(projectId, bucket);
    }
    for (const [projectId, bucket] of byProject) byProject.set(projectId, sortSessionsByActivity(bucket, { pinned: pinnedOrder }));
    return [...new Set(visibleProjects.values())]
      .map((project) => ({ project, sessions: byProject.get(project.id) ?? [] }))
      .filter((group) => {
        // The shared selector already admitted these rows, including the open conversation.
        if (group.sessions.length) return true;
        if (filterTag || unreadOnly || group.project.system) return false;
        if (!hasLinkedServers || serverFilter === 'all') return true;
        const ownerServer = serverOfObject(group.project.id);
        if (serverFilter === 'local') return !ownerServer;
        if (serverFilter === 'relevant') return !ownerServer || group.project.id === selectedSidebarProjectId;
        return ownerServer === serverFilter;
      });
  }, [layout, visibleProjects, rows, filterTag, unreadOnly, pinnedOrder, hasLinkedServers, serverFilter, selectedSidebarProjectId]);

  const timeline = useMemo(() => {
    if (layout !== 'time') return [];
    const now = new Date();
    const buckets: { label: string; items: { session: Session; project: ProjectRecord }[] }[] = [];
    for (const session of sortSessionsByActivity(rows, { pinned: pinnedOrder })) {
      const label = timeBucket(session, now);
      let bucket = buckets.at(-1);
      if (bucket?.label !== label) buckets.push(bucket = { label, items: [] });
      bucket.items.push({ session, project: visibleProjects.get(session.projectId)! });
    }
    return buckets;
  }, [layout, visibleProjects, rows, locale, pinnedOrder]);

  const renderSession = (session: Session, project?: ProjectRecord) => (
    <SessionRow
      key={session.id}
      session={session}
      selected={session.id === selectedSessionId}
      mobile={mobile}
      projectName={project?.name}
      time={relativeTime(sessionActivityAt(session))}
      onSelect={props.onSelectSession}
      onAction={props.onSessionAction}
    />
  );

  // One flat list of what the section shows, so a long one mounts only what is near the viewport.
  const entries = useMemo<SidebarEntry[]>(() => {
    const list: SidebarEntry[] = [];
    if (layout === 'time') {
      timeline.forEach((bucket, index) => {
        // The first group's name is the section header above: two labels never stack.
        if (index > 0) list.push({ kind: 'label', key: `label:${bucket.label}`, label: bucket.label });
        for (const { session, project } of bucket.items) list.push({ kind: 'session', key: session.id, session, project });
      });
      return list;
    }
    groups.forEach(({ project, sessions: sessionsOfProject }, index) => {
      const open = !collapsed.has(project.id);
      list.push({ kind: 'project', key: `project:${project.id}`, project, open, spaced: index > 0 && !mobile });
      if (!open) return;
      const activeOrPinned = sessionsOfProject.filter((session) => session.pinnedAt || isActiveSession(session)).length;
      const limit = Math.max(PROJECT_SESSION_LIMIT, activeOrPinned);
      const expanded = expandedProjects.has(project.id);
      let shown = sessionsOfProject;
      if (sessionsOfProject.length > limit && !expanded) {
        shown = sessionsOfProject.slice(0, limit);
        const current = selectedSessionId ? sessionsOfProject.find((session) => session.id === selectedSessionId) : undefined;
        if (current && !shown.includes(current)) shown = [...shown, current];
      }
      for (const session of shown) list.push({ kind: 'session', key: session.id, session });
      const hidden = sessionsOfProject.length - shown.length;
      if (hidden > 0) list.push({ kind: 'more', key: `more:${project.id}`, projectId: project.id, hidden });
      if (sessionsOfProject.length > limit && expanded) list.push({ kind: 'less', key: `less:${project.id}`, projectId: project.id });
      if (!sessionsOfProject.length) list.push({ kind: 'empty', key: `empty:${project.id}` });
    });
    return list;
  }, [layout, timeline, groups, collapsed, expandedProjects, selectedSessionId, mobile]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const kindOf = useCallback((index: number) => {
    const entry = entries[index]!;
    return entry.kind === 'project' && entry.spaced ? 'project-spaced' : entry.kind;
  }, [entries]);
  const estimate = useCallback((kind: string) => ({ session: mobile ? 45 : 33, label: 29, project: mobile ? 45 : 33, 'project-spaced': 41 } as Record<string, number>)[kind] ?? 29, [mobile]);
  const listWindow = useListWindow({ count: entries.length, kindOf, estimate, scroller: scrollRef, list: listRef });

  const renderEntry = (entry: SidebarEntry) => {
    switch (entry.kind) {
      case 'label':
        return <div className={cn('flex h-7 items-end px-2 pb-1 font-medium', mobile ? 'text-xs text-fg-3' : 'text-2xs text-fg-4')}>{entry.label}</div>;
      case 'session':
        return renderSession(entry.session, entry.project);
      case 'more': {
        const hiddenCount = entry.hidden;
        return (
          <button
            type="button"
            onClick={() => toggleShowAll(entry.projectId)}
            className={cn('flex h-7 w-full items-center gap-2 rounded-lg text-xs text-fg-3 transition-colors hover:bg-hover hover:text-fg-2', mobile ? 'px-2.5' : 'px-2')}
          >
            <span className="grid size-4 shrink-0 place-items-center text-fg-4"><IconEllipsis className="size-3.5" /></span>
            <span><Trans>展开其余 {hiddenCount} 个会话</Trans></span>
          </button>
        );
      }
      case 'less':
        return (
          <button
            type="button"
            onClick={() => toggleShowAll(entry.projectId)}
            className={cn('flex h-7 w-full items-center gap-2 rounded-lg text-xs text-fg-3 transition-colors hover:bg-hover hover:text-fg-2', mobile ? 'px-2.5' : 'px-2')}
          >
            <span className="grid size-4 shrink-0 place-items-center text-fg-4"><IconChevronRight className="-rotate-90 size-3.5" /></span>
            <span><Trans>收起历史会话</Trans></span>
          </button>
        );
      case 'empty':
        return <div className="flex h-7 items-center pl-8 text-xs text-fg-3"><Trans>暂无会话</Trans></div>;
      case 'project': {
        const { project, open } = entry;
        const activeProject = project.id === selectedSidebarProjectId;
        return (
          <div
            role="button"
            tabIndex={0}
            onClick={() => { if (project.system === 'task-workspace') props.onSelectNoProject?.(); else props.onSelectProject(project); if (!open) toggleProject(project.id); }}
            onKeyDown={(event) => activateOnKey(event, () => project.system === 'task-workspace' ? props.onSelectNoProject?.() : props.onSelectProject(project))}
            className={cn(
              'group/project flex h-8 cursor-default items-center gap-2 rounded-lg outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus',
              mobile ? cn('px-2.5 text-sm text-fg-2', activeProject && !selectedSessionId && 'bg-active text-fg') : cn('px-2 text-xs font-medium text-fg-3 hover:text-fg-2', activeProject && !selectedSessionId && 'bg-active text-fg hover:text-fg'),
              project.archivedAt && 'opacity-60',
            )}
          >
            {/* The phone's touch target widens the toggle to 44px; the negative margin keeps that
                width out of the layout, so the name starts where its conversations' titles do. */}
            <button type="button" aria-label={open ? t`折叠` : t`展开`} onClick={(event) => { event.stopPropagation(); toggleProject(project.id); }} className={cn('relative grid size-4 shrink-0 place-items-center', mobile ? '-mx-3.5 text-fg-3' : 'text-fg-4')}>
              <span className="group-hover/project:opacity-0">{open ? <IconFolderOpen className={mobile ? 'size-4' : 'size-3.5'} /> : <IconFolderClosed className={mobile ? 'size-4' : 'size-3.5'} />}</span>
              <IconChevronRight className={cn('absolute size-3.5 opacity-0 transition-transform group-hover/project:opacity-100', open && 'rotate-90')} />
            </button>
            <span className={cn('min-w-0 flex-1 truncate', mobile && 'font-medium')}>{project.name}</span>
            <ServerTag objectId={project.id} className="max-w-[40%] shrink-0 truncate font-normal text-fg-4" />
            <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/project:opacity-100 has-[[data-state=open]]:opacity-100 focus-within:opacity-100 no-hover:opacity-100">
              {!project.system && <RowMenu label={t`项目操作`}>
                <DropdownMenuItem onSelect={() => props.onProjectAction(project, 'rename')}><IconPencilLine /><Trans>重命名</Trans></DropdownMenuItem>
                <DropdownMenuItem onSelect={() => props.onProjectAction(project, 'tags')}><IconTag /><Trans>编辑标签</Trans></DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => props.onProjectAction(project, 'archive')}>{project.archivedAt ? <><IconArchiveRestore /><Trans>恢复项目</Trans></> : <><IconArchive /><Trans>归档项目</Trans></>}</DropdownMenuItem>
              </RowMenu>}
              <Tip label={t`在此目录新建会话`}><button type="button" aria-label={t`在“${project.name}”中新建会话`} onClick={(event) => { event.stopPropagation(); if (project.system === 'task-workspace') props.onSelectNoProject?.(); else props.onSelectProject(project); }} className="grid size-6 place-items-center rounded-md text-fg-3 hover:bg-active hover:text-fg"><IconPlus className="size-4" /></button></Tip>
            </span>
          </div>
        );
      }
    }
  };

  const owner = useLists((state) => state.owner);
  const linkedStatus = useLists((state) => state.linkedStatus);
  const markAllSeen = async () => {
    const requests: Promise<unknown>[] = [];
    if (serverFilter === 'all' || serverFilter === 'local' || serverFilter === 'relevant') {
      requests.push(api.markAllSessionsSeen());
    }
    const targets = peerServers.filter((peer) => peer.online && linkedStatus[peer.id] !== 'offline'
      && (serverFilter === 'all' || serverFilter === 'relevant' || serverFilter === peer.id));
    if (targets.length) {
      const idsByServer = new Map<string, string[]>(targets.map((peer) => [peer.id, []]));
      // Only sessions shared with this workbench. Each peer's assistant and quick chats stay private to it.
      for (const session of sessions) {
        if (!inSidebarServerScope(session, serverFilter, selfServerId)) continue;
        const serverId = serverOfObject(session.id);
        if (serverId) idsByServer.get(serverId)?.push(session.id);
      }
      for (const [serverId, ids] of idsByServer) {
        if (ids.length) requests.push(apiFor(serverId).markSessionsSeen(ids));
      }
    }
    await Promise.all(requests);
  };
  const { saved, save, canEdit } = useSidebarPinned();
  const mainViews = props.mainViews ?? [];
  const mainViewMap = useMemo(() => new Map(mainViews.map((view) => [view.id, view])), [mainViews]);
  const destinations: Partial<Record<WebSidebarDestination, { open: () => void; active?: boolean | undefined; trailing?: ReactNode }>> = {
    ...(props.onOpenAssistant ? { assistant: {
      open: props.onOpenAssistant, active: props.assistantActive,
      trailing: props.assistantSession && <span className="ml-auto inline-flex"><SessionIndicator session={props.assistantSession} mobile={mobile} selected={Boolean(props.assistantActive)} /></span>,
    } } : {}),
    ...(props.onOpenTasks ? { tasks: {
      open: props.onOpenTasks, active: props.tasksActive,
      trailing: props.tasksCount ? <span className="ml-auto text-2xs tabular-nums text-fg-4">{props.tasksCount}</span> : null,
    } } : {}),
    automations: { open: props.onOpenAutomations, active: props.automationsActive },
    ...(props.onOpenCouncil ? { council: { open: props.onOpenCouncil, active: props.councilActive } } : {}),
    marks: { open: props.onOpenMarks, active: props.marksActive },
    plugins: { open: props.onOpenPlugins, active: props.pluginsActive },
    extensions: { open: props.onOpenExtensions, active: props.extensionsActive },
    stats: { open: props.onOpenStats, active: props.statsActive },
  };
  const offeredIds: string[] = [
    ...WEB_SIDEBAR_DESTINATIONS.filter((id) => destinations[id]),
    ...(props.onOpenMainView ? mainViews.map((view) => view.id) : []),
  ];
  const destinationOf = (id: string) => {
    if (id in SIDEBAR_DESTINATION_META) {
      const meta = SIDEBAR_DESTINATION_META[id as WebSidebarDestination];
      const entry = destinations[id as WebSidebarDestination]!;
      return { icon: meta.icon, label: t(meta.label), open: entry.open, active: entry.active, trailing: entry.trailing };
    }
    const view = mainViewMap.get(id)!;
    return { icon: viewIcon(view), label: view.title, open: () => props.onOpenMainView?.(view.id), active: props.activeMainViewId === view.id, trailing: undefined };
  };
  const offlineBanner = props.stale?.mode === 'offline' && (
    <Notice tone="warning" className="mx-2 mb-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs">{offlineLabel(props.stale.savedAt)}</Notice>
  );
  // A network blip folds the banner away; it keeps its text until it has.
  const heldOfflineBanner = useHeld(offlineBanner);

  return (
    <nav className={cn('mobile-sidebar flex h-full min-h-0 w-full flex-col', mobile ? 'bg-canvas' : 'bg-transparent')} aria-label={t`工作区导航`}>
      <div data-touch-bar className={cn('flex shrink-0 items-center gap-2', mobile ? 'h-12 px-3' : 'h-13 pl-4 pr-2')}>
        <BrandMark className="size-5 shrink-0 text-fg" />
        <span className="text-base font-semibold tracking-tight text-fg">Riffet</span>
        <div className="ml-auto flex items-center">
          {props.onCollapse && <Tip label={t`收起侧边栏`} kbd={sidebarHint}><Button size="icon-sm" variant="quiet" aria-label={t`收起侧边栏`} onClick={props.onCollapse}><IconPanelLeft /></Button></Tip>}
          {props.onPin && <Tip label={t`固定侧边栏`} kbd={sidebarHint}><Button size="icon-sm" variant="quiet" aria-label={t`固定侧边栏`} onClick={props.onPin}><IconPanelLeft /></Button></Tip>}
          {props.onClose && <Button size="icon-sm" variant="quiet" aria-label={t`关闭侧边栏`} onClick={props.onClose}><IconX /></Button>}
        </div>
      </div>

      <div data-primary-nav className={cn('flex flex-col px-2', mobile ? 'gap-0 pb-1' : 'max-h-3/5 gap-px pb-2 [&>button]:shrink-0')}>
        {/* New Session is a page, not a dialog: it opens the selected directory's empty composer and
            the directory itself is chosen there, on the composer (see ProjectHome), so that clicking
            "new session" never intercepts someone who only wanted to reach that page. */}
        {mobile ? (
          <button type="button" onClick={props.onNewSession} disabled={!canStartSession} className={cn(sidebarNavRow(true), 'disabled:opacity-50')}>
            <IconMessageCirclePlus className="size-4 text-fg-2" /><Trans context="workbench-sidebar-new-action">新建会话</Trans>
          </button>
        ) : (
          <button type="button" onClick={props.onNewSession} disabled={!canStartSession} className={cn(sidebarNavRow(false), 'disabled:opacity-50')}>
            <IconSquarePen className="size-[15px] shrink-0" /><Trans context="workbench-sidebar-new-action">新会话</Trans>
          </button>
        )}
        <button type="button" data-touch-row onClick={props.onOpenSearch} className={sidebarNavRow(mobile)}>
          <IconSearch className={cn('shrink-0', mobile ? 'size-4 text-fg-2' : 'size-[15px]')} />
          <span><Trans>搜索内容</Trans></span>
          <span aria-hidden="true" className="ml-auto hidden text-2xs text-fg-4 md:block">{searchHint}</span>
        </button>
        <SidebarDestinationRows mobile={mobile} saved={saved} save={canEdit ? save : undefined} offered={offeredIds}
          destinationOf={destinationOf} onCustomize={props.onCustomizeSidebar} />
      </div>

      <Collapse open={Boolean(offlineBanner)}>{heldOfflineBanner}</Collapse>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <div data-touch-row className={cn('group/section flex items-center px-2', mobile ? 'h-8 pt-1' : 'mt-3 h-7')}>
          <span className={cn('font-medium', mobile ? 'text-xs text-fg-3' : 'text-2xs text-fg-4')}>{layout === 'time' ? timeline[0]?.label ?? t({ message: '会话', context: 'workbench-session-noun' }) : t`项目`}</span>
          <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/section:opacity-100 has-[[data-state=open]]:opacity-100 focus-within:opacity-100 no-hover:opacity-100">
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" aria-label={t`显示选项`} className="grid size-6 place-items-center rounded-md text-fg-3 hover:bg-hover hover:text-fg"><IconEye className="size-3.5" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel><Trans>排列方式</Trans></DropdownMenuLabel>
                <DropdownMenuRadioGroup value={layout} onValueChange={setLayout}>
                  <DropdownMenuRadioItem value="project"><Trans>按项目分组</Trans></DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="time"><Trans>按时间平铺</Trans></DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                {tabStyle !== 'off' && <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel><Trans>排序</Trans></DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
                    <DropdownMenuRadioItem value="activity"><Trans>最近活动</Trans></DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="tabs"><Trans>按标签页顺序</Trans></DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </>}
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem checked={showArchived} onCheckedChange={(value) => setShowArchived(value === true)}><Trans>显示已归档</Trans></DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={unreadOnly} onCheckedChange={(value) => setUnreadOnly(value === true)}><Trans>只看未读</Trans></DropdownMenuCheckboxItem>
                <DropdownMenuItem onSelect={() => { void markAllSeen().catch((error) => toast.error(errorMessage(error))); }}><Trans>全部标为已读</Trans></DropdownMenuItem>
                {hasLinkedServers && <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel><Trans>服务器范围</Trans></DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={serverFilter} onValueChange={setServerFilter}>
                    <DropdownMenuRadioItem value="relevant"><Trans>本机与本机发起</Trans></DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="all"><Trans>全部服务器</Trans></DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="local"><Trans>仅本机</Trans></DropdownMenuRadioItem>
                    {peerServers.map((peer) => <DropdownMenuRadioItem key={peer.id} value={peer.id}>{peer.name}</DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </>}
                {tags.length > 0 && <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel><Trans>按标签筛选</Trans></DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={filterTag} onValueChange={setFilterTag}>
                    <DropdownMenuRadioItem value=""><Trans>全部</Trans></DropdownMenuRadioItem>
                    {tags.map((tag) => <DropdownMenuRadioItem key={tag} value={tag}>{tag}</DropdownMenuRadioItem>)}
                  </DropdownMenuRadioGroup>
                </>}
              </DropdownMenuContent>
            </DropdownMenu>
            <Tip label={t`添加项目`}><button type="button" aria-label={t`添加项目`} onClick={props.onAddProject} className="grid size-6 place-items-center rounded-md text-fg-3 hover:bg-hover hover:text-fg"><IconFolderPlus className="size-3.5" /></button></Tip>
          </div>
        </div>

        {(filterTag || (hasLinkedServers && serverFilter !== 'relevant')) && (
          <div className="mb-1 flex flex-wrap items-center gap-1 px-2">
            {hasLinkedServers && serverFilter !== 'relevant' && (
              <span className="inline-flex h-6 items-center gap-1 rounded-md bg-accent-soft pl-2 pr-1 text-xs text-accent">
                {serverFilter === 'all' ? <IconLink className="size-3" /> : serverFilter === 'local' ? <IconLaptop className="size-3" /> : <IconServer className="size-3" />}
                {serverFilter === 'all' ? <Trans>全部服务器</Trans> : serverFilter === 'local' ? <Trans>仅本机</Trans> : peerServers.find((item) => item.id === serverFilter)?.name}
                <button type="button" aria-label={t`恢复默认服务器范围`} onClick={() => setServerFilter('relevant')} className="grid size-4 place-items-center rounded hover:bg-accent/15"><IconX className="size-3" /></button>
              </span>
            )}
            {filterTag && (
              <span className="inline-flex h-6 items-center gap-1 rounded-md bg-accent-soft pl-2 pr-1 text-xs text-accent"><IconTag className="size-3" />{filterTag}<button type="button" aria-label={t({ message: '清除筛选', context: 'workbench-clear-filter' })} onClick={() => setFilterTag('')} className="grid size-4 place-items-center rounded hover:bg-accent/15"><IconX className="size-3" /></button></span>
            )}
          </div>
        )}

        <div ref={listRef} style={{ paddingTop: listWindow.padTop, paddingBottom: listWindow.padBottom }}>
          {entries.slice(listWindow.from, listWindow.to).map((entry, offset) => (
            <div key={entry.key} ref={listWindow.measure(listWindow.from + offset)} className={cn('pb-px', entry.kind === 'project' && entry.spaced && 'pt-2')}>
              {renderEntry(entry)}
            </div>
          ))}
        </div>
        {layout === 'time' && !timeline.length && <p className="px-3 py-8 text-center text-sm text-fg-3">{filterTag || (hasLinkedServers && serverFilter !== 'relevant') ? t`没有匹配的结果` : t`还没有会话`}</p>}
        {layout === 'project' && !groups.length && (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
            <p className="text-sm text-fg-3">{filterTag || (hasLinkedServers && serverFilter !== 'relevant') ? t`没有匹配的结果` : t`还没有项目`}</p>
            {!filterTag && serverFilter === 'relevant' && <Button size="sm" onClick={props.onAddProject}><IconFolderPlus /><Trans>添加项目</Trans></Button>}
          </div>
        )}

      </div>

      <div data-touch-bar className={cn('flex h-12 shrink-0 items-center gap-1 px-2', mobile && 'edge-t')}>
        <SidebarUserMenu
          owner={owner}
          backend={props.backend}
          stale={props.stale}
          mobile={mobile}
          onOpenProfile={props.onOpenProfile}
          onOpenSettings={() => props.onOpenSettings()}
          onOpenTheme={() => props.onOpenSettings('appearance')}
        />
        <div className="ml-auto flex items-center gap-1">
          <SidebarUpdateButton onOpen={() => props.onOpenSettings('about')} />
          {!mobile && <SidebarSettingsButton backend={props.backend} onOpen={() => props.onOpenSettings()} />}
        </div>
      </div>
    </nav>
  );
}
