import { Fragment, useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconArchive, IconArchiveRestore, IconCheck, IconEllipsis, IconGitBranch, IconInfoOutline, IconMenu, IconPanelRight, IconPencilLine, IconPin, IconPinOff, IconTag, IconTrash2 } from '@/components/icons';
import type { Session } from '@contracts';
import { Button } from '@/components/ui/button';
import { AgentLogo } from '@/components/AgentLogo';
import { Badge, Spinner, StatusDot, StatusPillActions } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tip } from '@/components/ui/tooltip';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '@/lib/use-media-query';
import type { ProjectRecord } from '@/lib/api';
import { agentMarkStyle, sessionBackend, useBackendLabel } from '@/lib/backends';
import { parseSelection } from '@/lib/models';
import { cleanLabel, closesOverlay, cn, tildePath } from '@/lib/utils';
import { useGitStatus, watchGitStatus } from './state/gitStatusStore';
import { SessionInfo } from './SessionInfo';
import type { ContextUsage } from './session/model';
import { TabChromeContext } from './tabs/chrome';
import { altShortcut } from './tabs/keys';
import { ExpandSidebarButton } from './ExpandSidebarButton';

/** A session-level command. Desktop lists it in the ⋯ menu; phones list it in the title sheet. */
export interface HeaderAction {
  id: string;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  /** Right-aligned hint, e.g. a change summary or a keyboard shortcut. */
  hint?: ReactNode;
  /** Marks the command as currently on. */
  active?: boolean;
  disabled?: boolean;
  /** A destructive command, drawn in the danger colour. */
  danger?: boolean;
}

export interface HeaderSlots {
  /** The session's own groups inside 会话信息 (subagents, background tasks, marks, side discussions). */
  info?: ReactNode;
  /** Transient status the reader can act on. It sits in the row only while it exists. */
  alerts?: ReactNode;
  /** A dot on the 会话信息 button: something in it is running. */
  infoBadge?: boolean;
  /** How the conversation is shown (对话 / 终端 / 画布): first in the row's actions, apart from the rest. */
  views?: ReactNode;
  /** The context window the agent reported, for 会话信息. */
  usage?: ContextUsage;
  /** The permission mode as the backend names it; the raw mode id when it has no name. */
  approval?: string;
  /** Undefined falls back to Session.state; null explicitly reports no foreground status. */
  status?: ReactNode;
  menu?: HeaderAction[];
}

export interface HeaderProps extends HeaderSlots {
  center?: ReactNode;
  project?: ProjectRecord;
  originProject?: ProjectRecord;
  session?: Session;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  onOpenMobileSidebar: () => void;
  /** The open context panel tab, or undefined when the panel is closed. */
  panelTab?: string | undefined;
  onTogglePanel: (tab: string) => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  /** Whether the 会话信息 popover is open; the state lives in the ui store so a shortcut can reach it. */
  infoOpen: boolean;
  onInfoOpenChange: (open: boolean) => void;
  onRename?: () => void;
  onEditTags?: () => void;
  onTogglePin?: () => void;
  onToggleArchive?: () => void;
  onDelete?: () => void;
  deleteDisabled?: boolean;
  /** A quick chat has no project, agent, directory, branch or permission chrome. */
  quickChat?: boolean;
}

const stateText = { accent: 'text-accent', warning: 'text-warning', danger: 'text-danger', idle: 'text-fg-3' } as const;

/** One ⋯-menu row. The hint is right-aligned so counts and shortcuts stay scannable. */
function ActionMenuItem({ action, onSelect }: { action: HeaderAction; onSelect: () => void }) {
  return (
    <DropdownMenuItem onSelect={onSelect} disabled={action.disabled} {...(action.danger ? { variant: 'danger' as const } : {})}>
      {action.icon}
      <span className="min-w-0 flex-1 truncate">{action.label}</span>
      {action.hint && <span className="shrink-0 text-xs tabular-nums text-fg-3">{action.hint}</span>}
      {action.active && <IconCheck className="size-4 shrink-0 text-fg" />}
    </DropdownMenuItem>
  );
}

export function Header({ project, originProject, session, sidebarCollapsed, onExpandSidebar, onOpenMobileSidebar, panelTab, onTogglePanel, terminalOpen, onToggleTerminal, infoOpen, onInfoOpenChange, onRename, onEditTags, onTogglePin, onToggleArchive, onDelete, deleteDisabled, quickChat = false, center, info, alerts, infoBadge = false, views, usage, approval, status, menu = [] }: HeaderProps) {
  const { t } = useLingui();
  const label = useBackendLabel();
  const stateMeta: Partial<Record<Session['state'], { label: string; tone: 'accent' | 'warning' | 'danger' | 'idle'; pulse?: boolean }>> = {
    starting: { label: t`连接中`, tone: 'accent', pulse: true },
    running: { label: t`运行中`, tone: 'accent', pulse: true },
    waiting: { label: t({ message: '等待确认', context: 'workbench-awaiting-confirmation' }), tone: 'warning', pulse: true },
    cancelling: { label: t`正在停止`, tone: 'warning' },
    interrupted: { label: t`已中断`, tone: 'idle' },
    failed: { label: t`出错`, tone: 'danger' },
  };
  const state = session ? stateMeta[session.state] : undefined;
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // While session tabs are on (desktop only) the tab bar owns the top row and hosts this header's actions.
  const chrome = useContext(TabChromeContext);
  const tabbed = Boolean(chrome) && !mobile;
  const projectId = project?.id;
  const gitEntry = useGitStatus(projectId);
  const git = gitEntry?.status;
  const current = git && { changes: git.entries.length, added: git.added ?? 0, removed: git.removed ?? 0 };
  const hasGit = Boolean(git);
  const managedWorkspace = project?.system === 'task-workspace';
  // An unread status is pending rather than "no repository".
  const changesVisible = !managedWorkspace || hasGit || !gitEntry;
  const branch = session ? git?.branch ?? '' : '';

  // Shared with the changes panel. A turn ending or the panel opening is when the count most likely moved.
  useEffect(() => (projectId ? watchGitStatus(projectId, true) : undefined), [projectId, session?.id, session?.state, panelTab]);

  const sessionActions: HeaderAction[] = session ? [
    ...(onRename ? [{ id: 'rename', icon: <IconPencilLine />, label: t`重命名`, onSelect: onRename }] : []),
    ...(onEditTags ? [{ id: 'tags', icon: <IconTag />, label: t`编辑标签`, onSelect: onEditTags }] : []),
    ...(onTogglePin ? [{ id: 'pin', icon: session.pinnedAt ? <IconPinOff /> : <IconPin />, label: session.pinnedAt ? t`取消置顶` : t`置顶会话`, onSelect: onTogglePin }] : []),
  ] : [];
  const archiveAction: HeaderAction | undefined = session && onToggleArchive
    ? { id: 'archive', icon: session.archivedAt ? <IconArchiveRestore /> : <IconArchive />, label: session.archivedAt ? t({ message: '恢复会话', context: 'workbench-restore-session' }) : t`归档会话`, onSelect: onToggleArchive }
    : undefined;
  const deleteAction: HeaderAction | undefined = session && onDelete
    ? { id: 'delete', icon: <IconTrash2 />, label: t`删除…`, onSelect: onDelete, disabled: Boolean(deleteDisabled), danger: true }
    : undefined;
  // Where to go (changes, files, terminal) lives in 会话信息; this menu is only what can be done to the session.
  const desktopGroups: HeaderAction[][] = [menu, sessionActions, [...(archiveAction ? [archiveAction] : []), ...(deleteAction ? [deleteAction] : [])]].filter((group) => group.length > 0);
  // The phone's sheet lists the same commands; archive stays apart from the rest.
  const sheetActions: HeaderAction[] = [...menu, ...sessionActions];
  const selection = parseSelection(session?.model);
  const modelLabel = cleanLabel(selection.model);
  // Switches (fast=true) are the composer's icons, not words; only valued parameters such as effort read here.
  const modelDetail = Object.values(selection.params).filter((value) => value !== 'true' && value !== 'false').join(' · ');
  const projectName = managedWorkspace ? t`未关联项目` : originProject?.name ?? project?.name;
  const worktreeBadge = project?.worktree && (
    <Badge className="min-w-0 max-w-32 shrink rounded-full md:max-w-48">
      <IconGitBranch className="shrink-0" aria-hidden="true" />
      <span className="truncate" title={project.worktree.branch}>{project.worktree.branch}</span>
    </Badge>
  );

  const sessionInfo = (onNavigate: () => void, sheet: boolean) => session && (
    <SessionInfo
      session={session}
      quickChat={quickChat}
      project={project}
      projectName={managedWorkspace ? undefined : projectName}
      model={modelLabel}
      modelDetail={modelDetail}
      branch={branch}
      changes={current}
      changesVisible={changesVisible}
      state={state}
      usage={usage}
      approval={approval}
      panelTab={panelTab}
      terminalOpen={terminalOpen}
      onTogglePanel={onTogglePanel}
      onToggleTerminal={onToggleTerminal}
      onNavigate={onNavigate}
      head={!sheet}
    >
      {info}
    </SessionInfo>
  );
  // Right end of the row, or of the tab bar when tabs are on: alerts, 会话信息, side panel, ⋯.
  const actions = !mobile && (
    <div className="flex shrink-0 items-center justify-self-end gap-0.5">
      {/* Alerts arrive with the session's data; each fades in where it lands instead of popping into the row. */}
      {views && <>{views}<span aria-hidden className="mx-1.5 h-4 w-px shrink-0 bg-line-strong" /></>}
      {alerts && <div className="contents [&>*]:animate-in [&>*]:fade-in-0 [&>*]:duration-[var(--duration-base)]">{alerts}</div>}
      {session && (
        <Popover open={infoOpen} onOpenChange={onInfoOpenChange}>
          <Tip label={t`会话信息`} kbd={altShortcut('I')} disabled={infoOpen}>
            <PopoverTrigger asChild>
              <Button size="icon-sm" variant="quiet" aria-label={t`会话信息`} aria-pressed={infoOpen} className={cn('relative size-7', infoOpen && 'bg-active text-fg')}>
                <IconInfoOutline />
                {infoBadge && <span aria-hidden className="absolute right-1 top-1 size-1.5 rounded-full bg-accent ring-2 ring-bg" />}
              </Button>
            </PopoverTrigger>
          </Tip>
          <PopoverContent align="end" className="w-[380px] p-0" onClickCapture={(event) => { if (closesOverlay(event.target)) onInfoOpenChange(false); }}>
            <div className="max-h-[min(80vh,40rem)] overflow-y-auto">{sessionInfo(() => onInfoOpenChange(false), false)}</div>
          </PopoverContent>
        </Popover>
      )}
      {project && (
        <Tip label={panelTab ? t`收起侧板` : t`变更与文件`}>
          <Button size="icon-sm" variant="quiet" aria-label={panelTab ? t`收起侧板` : t`变更与文件`} aria-pressed={Boolean(panelTab)} className={cn('size-7', panelTab && 'bg-active text-fg')} onClick={() => onTogglePanel(panelTab ?? (changesVisible ? 'changes' : 'files'))}><IconPanelRight /></Button>
        </Tip>
      )}
      {desktopGroups.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="icon-sm" variant="quiet" aria-label={t`更多操作`} className="size-7"><IconEllipsis /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {desktopGroups.map((group, index) => (
              <Fragment key={`${index}:${group[0]!.id}`}>
                {index > 0 && <DropdownMenuSeparator />}
                {group.map((action) => <ActionMenuItem key={action.id} action={action} onSelect={action.onSelect} />)}
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );

  // The tab bar stands in for the title row: only the project home's centered switcher keeps one.
  if (tabbed) {
    return (
      <>
        {center && <header className="workbench-header flex min-h-12 shrink-0 items-center justify-center bg-bg px-3 md:h-13">{center}</header>}
        {chrome?.actions && createPortal(actions, chrome.actions)}
      </>
    );
  }

  return (
    <header className={cn('workbench-header flex min-h-12 shrink-0 items-center gap-1 bg-bg px-1.5 max-md:edge-b md:h-13 md:pl-4 md:pr-3', center && 'grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]')}>
      <div className={center ? 'flex min-w-0 items-center gap-1' : 'contents'}>
        <Button size="icon-sm" variant="quiet" className="size-11 md:hidden" aria-label={t`打开侧边栏`} onClick={onOpenMobileSidebar}><IconMenu /></Button>
        {sidebarCollapsed && (
          <ExpandSidebarButton onClick={onExpandSidebar} />
        )}

        <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-1 text-sm">
          {project && !session && !(center && mobile) && <><span className="min-w-0 truncate font-medium text-fg">{projectName}</span>{worktreeBadge}</>}
          {project && session && !mobile && (
            <>
              <span className="max-w-48 shrink truncate text-fg-3" title={tildePath(project.cwd)}>{projectName}</span>
              <span aria-hidden className="shrink-0 text-fg-4">/</span>
            </>
          )}
          {session && mobile && (
            <button type="button" onClick={() => setDetailsOpen(true)} className="flex min-h-11 min-w-0 max-w-full flex-1 items-center gap-1.5 overflow-hidden rounded-md px-1 text-left hover:bg-hover" aria-label={t`会话信息与操作`}>
              <span className="min-w-0 truncate font-medium leading-5 text-fg" title={session.title}>{session.title}</span>
              {worktreeBadge}
              {state && status === undefined && <span className="flex shrink-0" role="status" aria-label={state.label} title={state.label}>{state.tone === 'accent' ? <Spinner className="size-3 text-accent" /> : <StatusDot tone={state.tone} pulse={state.pulse} />}</span>}
              {/* Inside this button a status pill stays a badge: the phone keeps its own row for the
                  action in the conversation, or the sheet this opens lists it. */}
              {status && <span className="flex shrink-0" role="status"><StatusPillActions.Provider value={false}>{status}</StatusPillActions.Provider></span>}
            </button>
          )}
          {session && !mobile && (
            <>
              <button type="button" onClick={onRename} disabled={!onRename} className="-mx-1 min-w-0 truncate rounded-md px-1 py-0.5 font-medium text-fg hover:bg-hover disabled:hover:bg-transparent" title={session.title} aria-label={t`重命名会话`}>
                {session.title}
              </button>
              {worktreeBadge}
            </>
          )}
          {/* One status indicator, not two: the live native status (`status`) describes the same
              wait as `state` — "等待确认" next to a badge that also says "等待确认" — so it replaces
              the state label instead of sitting beside it, exactly as the phone row already does. */}
          {session && !mobile && <div className="flex min-w-0 shrink-0 items-center gap-1.5 pl-1 text-xs text-fg-3">
            {!quickChat && <Tip label={label(sessionBackend(session))}>
              <span role="img" aria-label={label(sessionBackend(session))} tabIndex={0} className="inline-flex shrink-0 items-center rounded-sm focus-visible:outline-2 focus-visible:outline-focus">
                <AgentLogo backend={sessionBackend(session)} size={14} style={agentMarkStyle(sessionBackend(session))} />
              </span>
            </Tip>}
            {/* Running is a spinner alone, its word in the tooltip; anything else keeps its label. */}
            {state && status === undefined && (state.tone === 'accent'
              ? <span className="flex shrink-0" role="status" aria-label={state.label} title={state.label}><Spinner className="size-3 text-accent" /></span>
              : <span className={cn('flex shrink-0 items-center gap-1.5', stateText[state.tone])} role="status"><StatusDot tone={state.tone} />{state.label}</span>)}
            {status && <span className="shrink-0" role="status">{status}</span>}
          </div>}
        </div>
      </div>

      {center && <div className="flex h-full min-h-12 min-w-0 items-center justify-center">{center}</div>}
      {actions}
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent mobileSheet>
          <DialogHeader className="gap-2">
            <DialogTitle className="break-words">{session?.title}</DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {state && <Badge tone={state.tone === 'idle' ? 'neutral' : state.tone}><StatusDot tone={state.tone} pulse={state.pulse} />{state.label}</Badge>}
              {!quickChat && <span>{session ? label(sessionBackend(session)) : 'Agent'}</span>}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4 pb-6">
            {/* Closes the sheet when a row opens something of its own, such as a subagent. */}
            <div className="space-y-3" onClickCapture={(event) => { if (closesOverlay(event.target)) setDetailsOpen(false); }}>
              {alerts && <div className="flex flex-wrap items-center gap-2">{alerts}</div>}
              {sessionInfo(() => setDetailsOpen(false), true)}
            </div>

            {sheetActions.length > 0 && (
              <section className="-mx-2">
                <h3 className="px-2 pb-1 text-xs font-medium text-fg-3"><Trans context="workbench-session-noun">会话</Trans></h3>
                {sheetActions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    disabled={action.disabled}
                    onClick={() => { setDetailsOpen(false); action.onSelect(); }}
                    className="flex h-12 w-full items-center gap-3 rounded-lg px-2 text-left text-base text-fg hover:bg-hover active:bg-active disabled:opacity-45 [&_svg]:size-4.5 [&_svg]:shrink-0 [&_svg]:text-fg-3"
                  >
                    {action.icon}<span className="min-w-0 flex-1 truncate">{action.label}</span>
                    {action.hint && <span className="shrink-0 text-sm tabular-nums text-fg-3">{action.hint}</span>}
                    {action.active && <IconCheck className="size-4 shrink-0 text-fg" />}
                  </button>
                ))}
              </section>
            )}

            {archiveAction && (
              <div className="-mx-2 edge-t pt-1">
                <button
                  type="button"
                  onClick={() => { setDetailsOpen(false); archiveAction.onSelect(); }}
                  className="flex h-12 w-full items-center gap-3 rounded-lg px-2 text-left text-base text-fg-2 hover:bg-hover active:bg-active [&_svg]:size-4.5 [&_svg]:shrink-0 [&_svg]:text-fg-3"
                >
                  {archiveAction.icon}<span className="min-w-0 flex-1 truncate">{archiveAction.label}</span>
                </button>
                {deleteAction && (
                  <button
                    type="button"
                    disabled={deleteAction.disabled}
                    onClick={() => { setDetailsOpen(false); deleteAction.onSelect(); }}
                    className="flex h-12 w-full items-center gap-3 rounded-lg px-2 text-left text-base text-danger hover:bg-danger-soft active:bg-danger-soft disabled:opacity-45 [&_svg]:size-4.5 [&_svg]:shrink-0 [&_svg]:text-danger"
                  >
                    {deleteAction.icon}<span className="min-w-0 flex-1 truncate">{deleteAction.label}</span>
                  </button>
                )}
              </div>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </header>
  );
}
