import { memo, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Notice } from '@/components/ui/notice';
import { IconArchive, IconArchiveRestore, IconBookmark, IconBookmarkFilled, IconCalendarClock, IconChartColumn, IconChevronRight, IconCopy, IconEllipsis, IconEye, IconFolderClosed, IconFolderOpen, IconFolderPlus, IconLaptop, IconPuzzle, IconMonitor, IconMoon, IconPanelLeft, IconMessageCirclePlus, IconPencilLine, IconPin, IconPinOff, IconPlus, IconSearch, IconServer, IconSettings, IconSquarePen, IconSquareTerminal, IconSun, IconTag, IconTrash2, IconX } from '@/components/icons';
import { isDoneUnseen, type NativeBackendCatalogEntry, type Session } from '@contracts';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { Spinner, StatusDot } from '@/components/ui/controls';
import { BrandMark } from '@/components/BrandMark';
import { OwnerAvatar } from '@/components/OwnerAvatar';
import { AgentLogo } from '@/components/AgentLogo';
import { ThemeSwatch } from '@/components/theme-swatch';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger, MenuSub } from '@/components/ui/dropdown-menu';
import { ListRow, rowConceal, rowReveal } from '@/components/ui/list-row';
import { Tip } from '@/components/ui/tooltip';
import { api, type ProjectRecord } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { copyWithToast } from '@/lib/files';
import { palettesOf, selectAppearanceItem, useAppearance } from '@/lib/appearance';
import { localizedText } from '@/lib/plugins';
import { setThemeId, setThemeMode, useTheme, type ThemeMode } from '@/lib/theme';
import { useThemeOptions } from '@/lib/theme-library';
import { cn, isJustNow, readStored, relativeTime, writeStored } from '@/lib/utils';
import { isActiveSession, sessionActivityAt, sortSessionsByActivity } from '@/lib/session-order';
import { sidebarProjectMap } from '@/lib/project-family';
import { agentMarkStyle, sessionBackend, useBackendLabel } from '@/lib/backends';
import { useLocale } from '@/lib/i18n';
import { hostInfo, shortcutLabel } from '@/lib/platform';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { useDeletionLoading } from './SessionDeletion';
import { useHeld } from './session/sessionLayout';
import { useLists, useStores } from './state/stores';
import { useTabs } from './tabs/useTabs';

export type EntityAction = 'rename' | 'tags' | 'archive';
export type SessionAction = EntityAction | 'pin' | 'delete';

interface Props {
  projects: ProjectRecord[];
  sessions: Session[];
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
  onOpenSettings: () => void;
  /** Opens settings on the personal info page. */
  onOpenProfile: () => void;
  onOpenStats: () => void;
  onOpenTasks: () => void;
  onOpenMarks: () => void;
  onOpenExtensions: () => void;
  onOpenPlugins: () => void;
  pluginsActive?: boolean;
  onOpenSearch: () => void;
  statsActive?: boolean;
  tasksActive?: boolean;
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

function SessionIndicator({ session, mobile, selected }: { session: Session; mobile: boolean; selected: boolean }) {
  const { t } = useLingui();
  // Finished while nobody looked; the open conversation is being read.
  const unread = !selected && isDoneUnseen(session);
  if (session.terminalHold) return <span role="img" aria-label={t`在终端中`} title={t`在终端中`} className="inline-flex text-fg-3"><IconSquareTerminal className="size-3.5" /></span>;
  if (mobile) {
    if (session.state === 'running' || session.state === 'starting') return <><Spinner className="size-3.5 text-accent" /><span className="sr-only">{t`运行中`}</span></>;
    if (session.state === 'waiting') return <StatusDot tone="warning" shape="ring" pulse label={t`等待处理`} className="size-2" />;
    if (session.state === 'failed') return <StatusDot tone="danger" label={t`运行失败`} className="size-2" />;
    if (unread) return <StatusDot tone="accent" label={t`未读`} className="size-2" />;
    return null;
  }
  if (session.state === 'running' || session.state === 'starting') return <StatusDot tone="accent" pulse label={t`运行中`} />;
  if (session.state === 'waiting') return <StatusDot tone="warning" label={t`等待处理`} />;
  if (session.state === 'failed') return <StatusDot tone="danger" label={t`运行失败`} />;
  if (unread) return <StatusDot tone="accent" label={t`未读`} />;
  return null;
}

/** Fetches the settings chunk while the pointer is on its button, so the first open is not a blank wait. */
const preloadSettings = () => void import('./settings/SettingsDialog');

const navRow = 'flex h-8 w-full items-center gap-[9px] rounded-lg px-2 text-sm text-fg-2 transition-colors hover:bg-hover hover:text-fg';
const mobileNavRow = 'flex h-10 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-fg transition-colors hover:bg-hover';

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
  return (
    <ListRow
      title={`${label} · ${session.title}`}
      onClick={(event) => onSelect(session, event.metaKey || event.ctrlKey)}
      selected={selected}
      aria-current={selected ? 'page' : undefined}
      leading={<SessionIndicator session={session} mobile={mobile} selected={selected} />}
      // The others recede a step so the selected row reads first.
      className={cn('cursor-default', mobile && 'text-fg hover:text-fg', session.archivedAt && 'opacity-60')}
      actions={<>
      {marked && <span role="img" aria-label={t`已收藏`} title={t`已收藏`} className="inline-flex shrink-0 text-accent"><IconBookmarkFilled className="size-3.5" /></span>}
      {/* Idle, a row is a title and its time: which agent ran it and which directory it belongs to
          are only worth the width once the pointer is on the row (or the keyboard is inside it),
          and on a touch screen there is no hover to wait for, so they simply stay. */}
      <span role="img" aria-label={label} className="inline-flex shrink-0 items-center text-fg-4 can-hover:hidden can-hover:group-hover/row:inline-flex can-hover:group-focus-within/row:inline-flex">
        <AgentLogo backend={backend} size={11} style={agentMarkStyle(backend)} />
      </span>
      {projectName && <span className="max-w-[40%] shrink-0 truncate text-2xs text-fg-4 can-hover:hidden can-hover:group-hover/row:block can-hover:group-focus-within/row:block">{projectName}</span>}
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

/**
 * The machine behind this page, told as a glyph: a laptop for the reader's own, a rack for one
 * reached over the network. The footer says nothing else about it — the address is on the tooltip,
 * and one click away in the menu for a pointer that cannot hover. A connection that is not healthy
 * only tints the glyph, since the sidebar already carries the sentence for that.
 */
function HostButton({ stale }: { stale?: Props['stale'] }) {
  const { t } = useLingui();
  const { local, address } = hostInfo();
  const offline = stale?.mode === 'offline';
  // A healthy connection to this computer's own server is the normal case and shows nothing.
  if (local && !offline) return null;
  const label = [offline ? t`无法连接服务器` : stale ? t`正在同步` : undefined, local ? t`本机` : t({ message: '远端', context: 'workbench-remote-host' }), address].filter(Boolean).join(' · ');
  const Icon = local ? IconLaptop : IconServer;
  return (
    <DropdownMenu>
      <Tip label={label} side="top">
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="quiet" aria-label={label} className={cn(offline && 'text-warning hover:text-warning')}>
            <Icon />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel className="flex items-center gap-1.5"><Icon className="size-3.5" />{local ? t`本机` : t({ message: '远端', context: 'workbench-remote-host' })}</DropdownMenuLabel>
        <p className="px-2 pb-1 font-mono text-xs text-fg-2 wrap-anywhere">{address}</p>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void copyWithToast(window.location.origin, t`已复制地址`)}><IconCopy /><Trans>复制地址</Trans></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Sidebar(props: Props) {
  const { t } = useLingui();
  // `timeBucket` reads the active catalog directly, so the timeline must recompute on a switch.
  const locale = useLocale();
  const themeOptions: { value: ThemeMode; label: string; icon: typeof IconSun }[] = [
    { value: 'system', label: t`跟随系统`, icon: IconMonitor },
    { value: 'light', label: t`浅色`, icon: IconSun },
    { value: 'dark', label: t`深色`, icon: IconMoon },
  ];
  const { projects, sessions, selectedProjectId, selectedSessionId } = props;
  // The phone drawer keeps its own established look; the desktop restyle stops at the breakpoint.
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const [showArchived, setShowArchived] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [filterTag, setFilterTag] = useState('');
  const [layout, setLayoutState] = useState<SidebarLayout>(() => readStored(LAYOUT_KEY) === 'time' ? 'time' : 'project');
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
  const { mode, themeId, resolved, paletteKey } = useTheme();
  const themes = useThemeOptions();
  const pluginPalettes = palettesOf(useAppearance().catalog);

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

  // Quick chats live on their own page; the sidebar lists only the ordinary conversations.
  const listedSessions = useMemo(() => sessions.filter((session) => sessionBackend(session) !== 'chat'), [sessions]);
  const tags = useMemo(() => [...new Set(listedSessions.filter((session) => !session.archivedAt).flatMap((session) => session.tags ?? []))].sort(), [listedSessions]);
  const visibleProjects = useMemo(() => sidebarProjectMap(projects, showArchived, t`未关联项目`), [projects, showArchived, t]);
  const selectedSidebarProjectId = visibleProjects.get(selectedProjectId)?.id;
  const groups = useMemo(() => {
    if (layout !== 'project') return [];
    const byProject = new Map<string, Session[]>();
    for (const session of listedSessions) {
      if ((!showArchived && session.archivedAt) || (filterTag && !session.tags?.includes(filterTag)) || (unreadOnly && session.id !== selectedSessionId && !isDoneUnseen(session))) continue;
      const projectId = visibleProjects.get(session.projectId)?.id;
      if (!projectId) continue;
      const bucket = byProject.get(projectId) ?? [];
      bucket.push(session);
      byProject.set(projectId, bucket);
    }
    for (const [projectId, bucket] of byProject) byProject.set(projectId, sortSessionsByActivity(bucket, { pinned: pinnedOrder }));
    return [...new Set(visibleProjects.values())]
      .map((project) => ({ project, sessions: byProject.get(project.id) ?? [] }))
      .filter((group) => ((!filterTag && !unreadOnly) || group.sessions.length) && (!group.project.system || group.sessions.length));
  }, [layout, visibleProjects, listedSessions, showArchived, filterTag, unreadOnly, selectedSessionId, pinnedOrder]);

  const timeline = useMemo(() => {
    if (layout !== 'time') return [];
    const matches = listedSessions.filter((session) => {
      const project = visibleProjects.get(session.projectId);
      if (!project || (!showArchived && session.archivedAt) || (filterTag && !session.tags?.includes(filterTag)) || (unreadOnly && session.id !== selectedSessionId && !isDoneUnseen(session))) return false;
      return true;
    });
    const now = new Date();
    const buckets: { label: string; items: { session: Session; project: ProjectRecord }[] }[] = [];
    for (const session of sortSessionsByActivity(matches, { pinned: pinnedOrder })) {
      const label = timeBucket(session, now);
      let bucket = buckets.at(-1);
      if (bucket?.label !== label) buckets.push(bucket = { label, items: [] });
      bucket.items.push({ session, project: visibleProjects.get(session.projectId)! });
    }
    return buckets;
  }, [layout, visibleProjects, listedSessions, showArchived, filterTag, unreadOnly, selectedSessionId, locale, pinnedOrder]);

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

  const theme = themeOptions.find((option) => option.value === mode) ?? themeOptions[0]!;
  const ThemeIcon = mode === 'system' ? (resolved === 'dark' ? IconMoon : IconSun) : theme.icon;
  /**
   * Backend health beside the settings button, and only when there is something to act on: a CLI
   * that is missing or one that is not signed in. The happy path (a backend's name) said nothing
   * the reader could use and turned the settings row into a status bar.
   */
  const backendNotice = props.backend?.needsLogin
    ? { tone: 'warning' as const, label: t`${props.backend.label} 未登录`, title: props.backend.reason }
    : props.backend && !props.backend.available
      ? { tone: 'warning' as const, label: t`${props.backend.label} 不可用`, title: props.backend.reason }
      : undefined;
  const owner = useLists((state) => state.owner);
  const ownerLabel = owner?.name || t`个人资料`;
  // Icon-only settings buttons carry the backend notice in their tooltip and warning dot.
  const settingsLabel = backendNotice ? t`设置 · ${[backendNotice.label, backendNotice.title].filter(Boolean).join(' · ')}` : t`设置`;

  // Both footers offer theme choices from their page menu.
  const themeItems = <>
    {/* Mode first, palette second, and neither writes the other: "跟随系统" stays a mode. */}
    <DropdownMenuLabel><Trans>明暗</Trans></DropdownMenuLabel>
    <DropdownMenuRadioGroup value={mode} onValueChange={(value) => setThemeMode(value as ThemeMode)}>
      {themeOptions.map((option) => <DropdownMenuRadioItem key={option.value} value={option.value}><option.icon />{option.label}</DropdownMenuRadioItem>)}
    </DropdownMenuRadioGroup>
    <DropdownMenuSeparator />
    <DropdownMenuLabel><Trans>主题</Trans></DropdownMenuLabel>
    <DropdownMenuRadioGroup value={paletteKey ?? themeId} onValueChange={(value) => {
      const plugin = pluginPalettes.find((item) => item.key === value);
      if (plugin) selectAppearanceItem('palette', plugin.palette.id); else setThemeId(value);
    }}>
      {themes.map((theme) => (
        <DropdownMenuRadioItem key={theme.id} value={theme.id}>
          <ThemeSwatch id={theme.id} className="h-4 w-6 rounded-sm" />{theme.name}
        </DropdownMenuRadioItem>
      ))}
      {pluginPalettes.map(({ palette, key }) => (
        <DropdownMenuRadioItem key={key} value={key}>
          <ThemeSwatch id={key} className="h-4 w-6 rounded-sm" />{localizedText(palette.title) ?? palette.id}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  </>;

  const offlineBanner = props.stale?.mode === 'offline' && (
    <Notice tone="warning" className="mx-2 mb-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs">{offlineLabel(props.stale.savedAt)}</Notice>
  );
  // A network blip folds the banner away; it keeps its text until it has.
  const heldOfflineBanner = useHeld(offlineBanner);

  return (
    <nav className={cn('mobile-sidebar flex h-full min-h-0 w-full flex-col', mobile ? 'bg-sidebar' : 'bg-canvas')} aria-label={t`工作区导航`}>
      <div data-touch-bar className={cn('flex shrink-0 items-center gap-2', mobile ? 'h-12 px-3' : 'h-13 pl-4 pr-2')}>
        <BrandMark className="size-5 shrink-0 text-fg" />
        <span className="text-base font-semibold tracking-tight text-fg">Riffet</span>
        <div className="ml-auto flex items-center">
          {props.onCollapse && <Tip label={t`收起侧边栏`} kbd={shortcutLabel('B')}><Button size="icon-sm" variant="quiet" aria-label={t`收起侧边栏`} onClick={props.onCollapse}><IconPanelLeft /></Button></Tip>}
          {props.onPin && <Tip label={t`固定侧边栏`} kbd={shortcutLabel('B')}><Button size="icon-sm" variant="quiet" aria-label={t`固定侧边栏`} onClick={props.onPin}><IconPanelLeft /></Button></Tip>}
          {props.onClose && <Button size="icon-sm" variant="quiet" aria-label={t`关闭侧边栏`} onClick={props.onClose}><IconX /></Button>}
        </div>
      </div>

      <div data-primary-nav className={cn('flex flex-col px-2', mobile ? 'gap-0 pb-1' : 'gap-px pb-2')}>
        {/* New Session is a page, not a dialog: it opens the selected directory's empty composer and
            the directory itself is chosen there, on the composer (see ProjectHome), so that clicking
            "new session" never intercepts someone who only wanted to reach that page. */}
        {mobile ? (
          <button type="button" onClick={props.onNewSession} disabled={!selectedProjectId && !props.onSelectNoProject} className={cn(mobileNavRow, 'disabled:opacity-50')}>
            <IconMessageCirclePlus className="size-4 text-fg-2" /><Trans context="workbench-sidebar-new-action">新建会话</Trans>
          </button>
        ) : (
          <button type="button" onClick={props.onNewSession} disabled={!selectedProjectId && !props.onSelectNoProject} className={cn(navRow, 'disabled:opacity-50')}>
            <IconSquarePen className="size-[15px] shrink-0" /><Trans context="workbench-sidebar-new-action">新会话</Trans>
          </button>
        )}
        <button type="button" data-touch-row onClick={props.onOpenSearch} className={mobile ? mobileNavRow : navRow}>
          <IconSearch className={cn('shrink-0', mobile ? 'size-4 text-fg-2' : 'size-[15px]')} />
          <span><Trans>搜索内容</Trans></span>
          <span aria-hidden="true" className="ml-auto hidden text-2xs text-fg-4 md:block">{shortcutLabel('K')}</span>
        </button>
        {/* A destination like a conversation, not a tool like the footer's stats: templates and
            schedules are where work starts, so the row sits with 新会话 and search. */}
        <button
          type="button"
          aria-current={props.tasksActive ? 'page' : undefined}
          onClick={props.onOpenTasks}
          className={mobile
            ? cn(mobileNavRow, props.tasksActive && 'bg-active')
            : cn(navRow, props.tasksActive && 'bg-active text-fg')}
        >
          <IconCalendarClock className={cn('shrink-0', mobile ? 'size-4 text-fg-2' : 'size-[15px]')} /><Trans>定时任务</Trans>
        </button>
        <button
          type="button"
          aria-current={props.marksActive ? 'page' : undefined}
          onClick={props.onOpenMarks}
          className={mobile
            ? cn(mobileNavRow, props.marksActive && 'bg-active')
            : cn(navRow, props.marksActive && 'bg-active text-fg')}
        >
          <IconBookmark className={cn('shrink-0', mobile ? 'size-4 text-fg-2' : 'size-[15px]')} /><Trans>收藏夹</Trans>
        </button>
        {!mobile && (
          <button type="button" aria-current={props.pluginsActive ? 'page' : undefined} onClick={props.onOpenPlugins} className={cn(navRow, props.pluginsActive && 'bg-active text-fg')}>
            <IconPuzzle className="size-[15px] shrink-0" /><Trans>插件</Trans>
          </button>
        )}
      </div>

      <Collapse open={Boolean(offlineBanner)}>{heldOfflineBanner}</Collapse>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
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
                <DropdownMenuItem onSelect={() => void api.markAllSessionsSeen().catch((error) => toast.error(errorMessage(error)))}><Trans>全部标为已读</Trans></DropdownMenuItem>
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

        {filterTag && (
          <div className="mb-1 flex items-center gap-1 px-2">
            <span className="inline-flex h-6 items-center gap-1 rounded-md bg-accent-soft pl-2 pr-1 text-xs text-accent"><IconTag className="size-3" />{filterTag}<button type="button" aria-label={t({ message: '清除筛选', context: 'workbench-clear-filter' })} onClick={() => setFilterTag('')} className="grid size-4 place-items-center rounded hover:bg-accent/15"><IconX className="size-3" /></button></span>
          </div>
        )}

        {layout === 'time' ? (
          <div className="flex flex-col gap-px">
            {timeline.map((bucket, index) => (
              <div key={bucket.label} className="flex flex-col gap-px">
                {/* The first group's name is the section header above: two labels never stack. */}
                {index > 0 && <div className={cn('flex h-7 items-end px-2 pb-1 font-medium', mobile ? 'text-xs text-fg-3' : 'text-2xs text-fg-4')}>{bucket.label}</div>}
                {bucket.items.map(({ session, project }) => renderSession(session, project))}
              </div>
            ))}
            {!timeline.length && <p className="px-3 py-8 text-center text-sm text-fg-3">{filterTag ? t`没有匹配的结果` : t`还没有会话`}</p>}
          </div>
        ) : (
        <div className="flex flex-col gap-px">
          {groups.map(({ project, sessions: list }) => {
            const open = !collapsed.has(project.id);
            const activeProject = project.id === selectedSidebarProjectId;
            const activeOrPinned = list.filter((session) => session.pinnedAt || isActiveSession(session)).length;
            const limit = Math.max(PROJECT_SESSION_LIMIT, activeOrPinned);
            const showAll = list.length <= limit || expandedProjects.has(project.id);
            const visibleList = showAll ? list : (() => {
              const head = list.slice(0, limit);
              const current = selectedSessionId ? list.find((session) => session.id === selectedSessionId) : undefined;
              return current && !head.some((session) => session.id === current.id) ? [...head, current] : head;
            })();
            const hiddenCount = list.length - visibleList.length;
            const canCollapse = list.length > limit && expandedProjects.has(project.id);
            return (
              <div key={project.id} className={cn('flex flex-col gap-px', !mobile && '[&+&]:mt-2')}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => { if (project.system === 'task-workspace') props.onSelectNoProject?.(); else props.onSelectProject(project); if (!open) toggleProject(project.id); }}
                  onKeyDown={(event) => activateOnKey(event, () => project.system === 'task-workspace' ? props.onSelectNoProject?.() : props.onSelectProject(project))}
                  className={cn(
                    'group/project flex h-8 cursor-default items-center gap-2 rounded-lg px-2 outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus',
                    mobile ? cn('text-sm text-fg-2', activeProject && !selectedSessionId && 'bg-active text-fg') : cn('text-xs font-medium text-fg-3 hover:text-fg-2', activeProject && !selectedSessionId && 'bg-active text-fg hover:text-fg'),
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
                {open && visibleList.map((session) => renderSession(session))}
                {open && hiddenCount > 0 && (
                  <button
                    type="button"
                    onClick={() => toggleShowAll(project.id)}
                    className="flex h-7 items-center gap-2 rounded-lg px-2 text-xs text-fg-3 transition-colors hover:bg-hover hover:text-fg-2"
                  >
                    <span className="grid size-4 shrink-0 place-items-center text-fg-4"><IconEllipsis className="size-3.5" /></span>
                    <span><Trans>展开其余 {hiddenCount} 个会话</Trans></span>
                  </button>
                )}
                {open && canCollapse && (
                  <button
                    type="button"
                    onClick={() => toggleShowAll(project.id)}
                    className="flex h-7 items-center gap-2 rounded-lg px-2 text-xs text-fg-3 transition-colors hover:bg-hover hover:text-fg-2"
                  >
                    <span className="grid size-4 shrink-0 place-items-center text-fg-4"><IconChevronRight className="-rotate-90 size-3.5" /></span>
                    <span><Trans>收起历史会话</Trans></span>
                  </button>
                )}
                {open && !list.length && <div className="flex h-7 items-center pl-8 text-xs text-fg-3"><Trans>暂无会话</Trans></div>}
              </div>
            );
          })}
          {!groups.length && (
            <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
              <p className="text-sm text-fg-3">{filterTag ? t`没有匹配的结果` : t`还没有项目`}</p>
              {!filterTag && <Button size="sm" onClick={props.onAddProject}><IconFolderPlus /><Trans>添加项目</Trans></Button>}
            </div>
          )}
        </div>
        )}

      </div>

      <div data-touch-bar className={cn('flex h-12 shrink-0 items-center gap-1 px-2', mobile && 'edge-t')}>
        <Tip label={ownerLabel} side="top">
          <Button size="icon-sm" variant="quiet" aria-label={ownerLabel} onClick={props.onOpenProfile} onPointerEnter={preloadSettings} onFocus={preloadSettings} className="rounded-full"><OwnerAvatar owner={owner} size={24} /></Button>
        </Tip>
        <div className="ml-auto flex items-center gap-1">
          {!mobile && <HostButton stale={props.stale} />}
          {/* The pages visited now and then, and the theme. */}
          <DropdownMenu>
            <Tip label={t`更多`} side="top">
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="quiet" aria-label={t`更多`} className={cn((props.extensionsActive || props.statsActive || (mobile && props.pluginsActive)) && 'bg-active text-fg')}><IconEllipsis /></Button>
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent side="top" align="end" className="w-52">
              <DropdownMenuItem aria-current={props.extensionsActive ? 'page' : undefined} onSelect={props.onOpenExtensions}><IconPuzzle /><Trans>Agent 扩展</Trans></DropdownMenuItem>
              {mobile && <DropdownMenuItem aria-current={props.pluginsActive ? 'page' : undefined} onSelect={props.onOpenPlugins}><IconPuzzle /><Trans>插件</Trans></DropdownMenuItem>}
              <DropdownMenuItem aria-current={props.statsActive ? 'page' : undefined} onSelect={props.onOpenStats}><IconChartColumn /><Trans>数据统计</Trans></DropdownMenuItem>
              <DropdownMenuSeparator />
              <MenuSub icon={<ThemeIcon />} label={t`主题`} className="w-52">{themeItems}</MenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* The gear is a glyph: what it opens onto, and how the backend is doing, are in its
              tooltip, and a warning dot is what keeps the second one visible without hovering. */}
          <Tip label={settingsLabel} side="top">
            <Button size="icon-sm" variant="quiet" aria-label={settingsLabel} onClick={props.onOpenSettings} onPointerEnter={preloadSettings} onFocus={preloadSettings} className="relative">
              <IconSettings />
              {backendNotice && <StatusDot tone={backendNotice.tone} className={cn('absolute right-0.5 bottom-0.5 ring-2', mobile ? 'ring-sidebar' : 'ring-canvas')} />}
            </Button>
          </Tip>
        </div>
      </div>
    </nav>
  );
}
