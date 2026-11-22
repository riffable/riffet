import { createContext, Fragment, useContext, useEffect, useState, type ReactNode } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import type { Session } from '@contracts';
import { IconBrain, IconCheck, IconChevronDown, IconChevronRight, IconCopy, IconFolder, IconGitCompare, IconFileText, IconMessageSquareText, IconRepeat, IconSettings2, IconShieldCheck, IconSparkles, IconSquareKanban, IconTerminal } from '@/components/icons';
import { ActionBar, ActionBarButton } from '@/components/ui/action-bar';
import { Badge, Spinner, StatusDot } from '@/components/ui/controls';
import { ListRow, listRowClass, rowReveal } from '@/components/ui/list-row';
import { AgentLogo } from '@/components/AgentLogo';
import { isAssistantProject, mainSessionIdOf } from '@/lib/project-family';
import { api, type ProjectRecord } from '@/lib/api';
import { agentMarkStyle, sessionBackend } from '@/lib/backends';
import { copyText } from '@/lib/files';
import { useFeedbackPulse } from '@/lib/feedback';
import { sessionActivityAt } from '@/lib/session-order';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { cn, formatDateTime, relativeTime, tildePath, timeAgo } from '@/lib/utils';
import { isSessionDeleted } from '@/lib/session-deletion';
import { compactTokens } from './session/Composer';
import type { ContextUsage } from './session/model';
import { useStores, useWorkItems } from './state/stores';
import { useServerBadge } from './useServerLabel';
import type { AssistantSetupState } from './work-items/AssistantSetup';
import { useStatusLabel } from './work-items/parts';
import { Progress } from '@/components/ui/progress';

export interface GitChanges { changes: number; added: number; removed: number }

const compactCount = (value: number) => value >= 10_000 ? `${Math.round(value / 1000)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);

/** "+12 −3" like a PR header, or a file count when no lines are countable. */
export function compactChanges(git?: GitChanges): ReactNode {
  if (!git?.changes) return '';
  return git.added || git.removed ? <><span className="text-success">+{compactCount(git.added)}</span>{' '}<span className="text-danger">−{compactCount(git.removed)}</span></> : i18n._(msg`${git.changes} 个文件`);
}

/** The standard row's classes at full text strength, for rows whose content `ListRow` cannot lay out. */
export const infoRow = cn(listRowClass, 'text-fg');

/**
 * A group in the session-info surface. Its owner decides whether there is anything to show and
 * renders nothing otherwise, so an empty group never leaves a heading or a seam behind.
 */
export function InfoSection({ title, summary, children }: { title: string; summary?: ReactNode; children: ReactNode }) {
  // The phone's sheet stacks its blocks as cards under a heading (mobile.md §10.4).
  if (useContext(InfoSheetContext)) {
    return (
      <section>
        <div className="flex h-7 items-center gap-2 text-xs text-fg-3">
          <h3 className="font-normal">{title}</h3>
          {summary && <span className="ml-auto tabular-nums text-fg-4">{summary}</span>}
        </div>
        <div className="rounded-xl border border-line p-1">{children}</div>
      </section>
    );
  }
  return (
    <section className="edge-t p-1.5">
      <div className="flex h-7 items-center gap-2 px-2.5 text-xs text-fg-3">
        <h3 className="font-normal">{title}</h3>
        {summary && <span className="ml-auto tabular-nums text-fg-4">{summary}</span>}
      </div>
      {children}
    </section>
  );
}

/** Set by the phone's sheet: its groups are cards, its places a bar. */
const InfoSheetContext = createContext(false);

/** The row standing in for `hidden` more; selecting it unfolds them in place. */
export function InfoMore({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  return (
    <ListRow onClick={onClick} className="text-fg-3 hover:text-fg-3" trailing={<IconChevronDown className="size-3.5 text-fg-4" />}>
      {i18n._(msg`其余 ${hidden} 个`)}
    </ListRow>
  );
}

/** A place this session can take you: changes, files, the terminal. A row, so the places stay lighter than the facts above them. */
function PlaceRow({ icon, label, hint, active, onClick }: { icon: ReactNode; label: string; hint?: ReactNode; active?: boolean; onClick: () => void }) {
  return (
    <ListRow aria-pressed={active} selected={active} onClick={onClick} className="text-fg" leading={icon} meta={hint} trailing={<IconChevronRight className="size-3.5 text-fg-4" />}>
      {label}
    </ListRow>
  );
}

/**
 * The 任务 this session belongs to, first among the places: its number and status, opening it on the
 * board. Nothing shows until the item list has it.
 */
function TaskPlaceRow({ workItemId, onNavigate }: { workItemId: string; onNavigate: () => void }) {
  const { t } = useLingui();
  const { workItems, nav } = useStores();
  const statusLabel = useStatusLabel();
  const item = useWorkItems((state) => state.summaries?.find((entry) => entry.id === workItemId));
  if (!item) return null;
  // Through `navigate`, as the sidebar's entry goes: a draft's discard guard still asks first.
  const open = () => { onNavigate(); void nav.navigate(() => { workItems.reveal(item.id); nav.openPage('tasks'); }); };
  return <PlaceRow icon={<IconSquareKanban />} label={t`任务 #${item.number}`} hint={statusLabel(item.status)} onClick={open} />;
}

/** The phone sheet's fact row for the same 任务: its number and status, opening it on the board. */
function TaskFact({ workItemId, onNavigate }: { workItemId: string; onNavigate: () => void }) {
  const { t } = useLingui();
  const { workItems, nav } = useStores();
  const statusLabel = useStatusLabel();
  const item = useWorkItems((state) => state.summaries?.find((entry) => entry.id === workItemId));
  if (!item) return null;
  const open = () => { onNavigate(); void nav.navigate(() => { workItems.reveal(item.id); nav.openPage('tasks'); }); };
  return <>
    <dt className="min-w-0 text-xs leading-5 text-fg-3">{t({ message: '任务', context: 'session-info-task' })}</dt>
    <dd className="flex min-h-5 min-w-0 items-center text-sm leading-5 text-fg">
      <button type="button" onClick={open} className="-mx-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 text-left hover:bg-hover">
        <span className="tabular-nums">#{item.number}</span>
        <span className="min-w-0 truncate text-fg-3">{statusLabel(item.status)}</span>
        <IconChevronRight className="size-3.5 shrink-0 text-fg-4" />
      </button>
    </dd>
  </>;
}

/** A value that copies itself: a path or a branch. The icon only shows once it has something to say. */
function CopyValue({ value, display, label }: { value: string; display?: ReactNode; label: string }) {
  const { t } = useLingui();
  const copied = useFeedbackPulse<HTMLButtonElement>(value);
  return (
    <button
      type="button"
      ref={copied.ref}
      title={t`复制${label}`}
      aria-label={t`复制${label}`}
      onClick={() => void copyText(value).then((done) => {
        if (!done) return;
        copied.show();
      })}
      className="group/row -mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-center gap-1.5 rounded-md px-1 text-left hover:bg-hover"
    >
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{display ?? value}</span>
      {copied.shown
        ? <IconCheck className="size-3 shrink-0 text-success" />
        : <IconCopy className={cn('size-3 shrink-0 text-fg-4', rowReveal)} />}
    </button>
  );
}

/** The window the agent reported, as a thin bar: the composer's ring shows the same number at a glance. */
function ContextValue({ usage }: { usage: ContextUsage }) {
  const { t } = useLingui();
  const limitLabel = usage.limitKind === 'compaction' ? t`自动压缩阈值` : t`上下文长度`;
  const ratio = Math.min(1, Math.max(0, usage.used / usage.size));
  const percent = Math.round(usage.used / usage.size * 100);
  const tone = ratio >= 0.9 ? 'danger' : ratio >= 0.75 ? 'warning' : 'neutral';
  return (
    <span className="flex min-w-0 items-center gap-2" title={`${limitLabel} ${compactTokens(usage.size)} tokens`}>
      <Progress role="meter" value={ratio} tone={tone} label={limitLabel} className="h-1 w-16 shrink-0" />
      <span className="min-w-0 truncate text-xs tabular-nums text-fg-2">
        {percent}% · {compactTokens(usage.used)} / {compactTokens(usage.size)}
        {usage.cost && <span className="text-fg-3"> · {usage.cost.currency} {usage.cost.amount.toFixed(2)}</span>}
      </span>
    </span>
  );
}

export interface SessionStateMeta { label: string; tone: 'accent' | 'warning' | 'danger' | 'idle'; pulse?: boolean }

export interface SessionInfoProps {
  session: Session;
  /** A quick chat has no agent mark, project or directory. */
  quickChat?: boolean;
  project?: ProjectRecord;
  /** The project's name; empty for a workspace that belongs to no project. */
  projectName?: string;
  model?: string;
  /** The selection's parameters as the composer shows them, e.g. the reasoning effort. */
  modelDetail?: string;
  branch?: string;
  changes?: GitChanges;
  changesVisible: boolean;
  /** What the session is doing, when it is doing something; undefined reads as idle. */
  state?: SessionStateMeta;
  usage?: ContextUsage;
  /** The permission mode's name from the backend; falls back to its id. */
  approval?: string;
  /** The open context panel tab, or undefined when the panel is closed. */
  panelTab?: string | undefined;
  terminalOpen: boolean;
  onTogglePanel: (tab: string) => void;
  onToggleTerminal: () => void;
  /** Called when a place row leaves for its target, so the surface hosting this can close. */
  onNavigate: () => void;
  /** The 助理's main conversation: its instructions, skills, MCP servers and plugins, which its page no longer shows. */
  assistant?: AssistantSetupState;
  /** The title and status. The phone's sheet already has its own. */
  head?: boolean;
  /** The session's own groups: side discussions, subagents, background tasks, marks. */
  children?: ReactNode;
  /** The phone sheet's last cell in its bar: 更多, the session's commands. */
  barEnd?: ReactNode;
}

/**
 * 会话信息: the desktop popover and the phone sheet render this one component. The weight sits at
 * the top — who is working, on what, and how it is going — then the facts as a labelled list, the
 * places it can take you, and what is running in it.
 */
export function SessionInfo({ session, quickChat, project, projectName, model, modelDetail, branch, changes, changesVisible, state, usage, approval, panelTab, terminalOpen, onTogglePanel, onToggleTerminal, onNavigate, assistant, head = true, children, barEnd }: SessionInfoProps) {
  const { t } = useLingui();
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const title = mainSessionIdOf(project) === session.id ? t`个人助理` : session.title;
  const go = (action: () => void) => () => { onNavigate(); action(); };
  const backend = sessionBackend(session);
  const tags = session.tags.filter(Boolean);
  // A turn in progress says how long it has been going; otherwise, when the session last did anything.
  const busy = state?.tone === 'accent' || state?.tone === 'warning';
  const since = busy ? relativeTime(session.activeSince ?? sessionActivityAt(session)) : '';
  const activityAt = sessionActivityAt(session);
  const activity = timeAgo(activityAt);
  const server = useServerBadge(session.id);
  const facts: [label: string, value: ReactNode][] = [
    ...(server ? [[t`服务器`, <span key="server" className="flex min-w-0 flex-wrap items-baseline gap-x-1.5"><span className={cn('min-w-0 break-words', server.offline && 'text-warning')}>{server.label}</span>{server.alias !== server.name && <span className="font-mono text-xs text-fg-3">{server.alias}</span>}</span>] as [string, ReactNode]] : []),
    ...(model ? [[t`模型`, <span key="model" className="flex min-w-0 flex-wrap items-baseline gap-x-1.5"><span className="min-w-0 break-words font-mono text-xs">{model}</span>{modelDetail && <span className="min-w-0 text-xs text-fg-3">{modelDetail}</span>}</span>] as [string, ReactNode]] : []),
    ...(session.approval && !quickChat ? [[t`权限`, approval || session.approval] as [string, ReactNode]] : []),
    // The phone's composer carries the context ring; its sheet skips the row.
    ...(head && usage && usage.size > 0 ? [[t`上下文用量`, <ContextValue key="usage" usage={usage} />] as [string, ReactNode]] : []),
    ...(project && !quickChat ? [[t`目录`, <CopyValue key="cwd" value={project.cwd} display={<>{projectName && <span className="font-sans text-fg">{projectName} </span>}<span className="text-fg-3">{tildePath(project.cwd)}</span></>} label={t`目录`} />] as [string, ReactNode]] : []),
    ...(branch ? [[t`分支`, <CopyValue key="branch" value={branch} label={t`分支`} />] as [string, ReactNode]] : []),
    ...(!head && tags.length > 0 ? [[t({ message: '标签', context: 'session-info-tags' }), <span key="tags" className="flex flex-wrap gap-1">{tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}</span>] as [string, ReactNode]] : []),
    ...(head ? [[t({ message: '创建', context: 'workbench-created-at' }), <span key="created" className="tabular-nums">{formatDateTime(session.createdAt)}</span>] as [string, ReactNode]] : []),
  ];
  const factList = (
    <dl className={cn('grid grid-cols-[fit-content(40%)_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5', head ? 'px-4 pb-3' : 'rounded-xl border border-line px-3 py-2.5')}>
      {!head && session.workItemId && <TaskFact workItemId={session.workItemId} onNavigate={onNavigate} />}
      {facts.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="min-w-0 text-xs leading-5 text-fg-3 [overflow-wrap:anywhere]">{label}</dt>
          <dd className="flex min-h-5 min-w-0 items-center text-sm leading-5 text-fg [overflow-wrap:anywhere]">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
  const assistantRows = assistant && <>
    <PlaceRow icon={<IconBrain />} label={t`记忆`} hint={assistant.memoryNote} onClick={go(() => assistant.setMemoryOpen(true))} />
    <PlaceRow icon={<IconShieldCheck />} label={t`规则`} hint={assistant.instructionsNote} onClick={go(assistant.openRules)} />
    <PlaceRow icon={<IconSparkles />} label={t`能力`} hint={assistant.abilitiesNote} onClick={go(assistant.openAbilities)} />
    {assistant.hasFiles && <PlaceRow icon={<IconFileText />} label={t`文件`} hint={assistant.filesNote} onClick={go(() => assistant.setFilesOpen(true))} />}
    {assistant.hasDelegations && <PlaceRow icon={<IconRepeat />} label={t`委托`} hint={assistant.delegationsNote} onClick={go(() => assistant.setDelegationsOpen(true))} />}
    <PlaceRow icon={<IconSettings2 />} label={t`设置`} onClick={go(assistant.openSettings)} />
  </>;
  const projectPlaces = Boolean(project && (changesVisible || !isAssistantProject(project)));

  // The phone's sheet (mobile.md §10.4): one bar of places ending in the sheet's 更多, then what runs, then the facts.
  if (!head) {
    return (
      <InfoSheetContext.Provider value>
        <div className="flex flex-col gap-4 *:shrink-0">
          {(projectPlaces || barEnd) && (
            <ActionBar>
              {project && changesVisible && <ActionBarButton icon={<IconGitCompare />} label={t`变更`} active={panelTab === 'changes'} aria-pressed={panelTab === 'changes'} onClick={go(() => onTogglePanel('changes'))} />}
              {project && !isAssistantProject(project) && <>
                <ActionBarButton icon={<IconFolder />} label={t({ message: '文件', context: 'workbench-files-panel' })} active={panelTab === 'files'} aria-pressed={panelTab === 'files'} onClick={go(() => onTogglePanel('files'))} />
                <ActionBarButton icon={<IconTerminal />} label={t`终端`} active={terminalOpen} aria-pressed={terminalOpen} onClick={go(onToggleTerminal)} />
              </>}
              {barEnd}
            </ActionBar>
          )}
          {/* Six places with their own values: rows, not cells. */}
          {assistant && <div className="rounded-xl border border-line p-1">{assistantRows}</div>}
          {children}
          {(facts.length > 0 || session.workItemId) && factList}
        </div>
      </InfoSheetContext.Provider>
    );
  }
  return (
    <div>
      {head && (
        <div className="flex gap-3 px-4 pb-3 pt-4">
          {!quickChat && (
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-subtle">
              <AgentLogo backend={backend} size={18} style={agentMarkStyle(backend)} />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 break-words text-(length:--text-h3) font-semibold leading-[22px] text-fg" title={title}>{title}</div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-fg-3" role="status">
              {state?.tone === 'accent' ? <Spinner className="size-3 text-accent" /> : state && <StatusDot tone={state.tone} pulse={state.pulse} />}
              <span className={cn('min-w-0 truncate', state?.tone === 'warning' && 'text-warning', state?.tone === 'danger' && 'text-danger')}>
                {state ? state.label : t({ message: '空闲', context: 'session-info-idle' })}
                <span className="text-fg-4"> · </span>
                {busy ? since : activity}
              </span>
            </div>
            {tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}</div>}
          </div>
        </div>
      )}
      {factList}
      {(project || session.workItemId) && (
        <section className="edge-t p-1.5">
          {session.workItemId && <TaskPlaceRow workItemId={session.workItemId} onNavigate={onNavigate} />}
          {project && changesVisible && <PlaceRow icon={<IconGitCompare />} label={t`变更`} hint={compactChanges(changes)} active={panelTab === 'changes'} onClick={go(() => onTogglePanel('changes'))} />}
          {project && !isAssistantProject(project) && <>
            <PlaceRow icon={<IconFolder />} label={t({ message: '文件', context: 'workbench-files-panel' })} active={panelTab === 'files'} onClick={go(() => onTogglePanel('files'))} />
            <PlaceRow icon={<IconTerminal />} label={t`终端`} hint={mobile ? undefined : '⌃`'} active={terminalOpen} onClick={go(onToggleTerminal)} />
          </>}
          {/* What the 个人助理 is made of, in place of a project's changes, files and terminal (docs/ASSISTANT.md §3). */}
          {assistantRows}
        </section>
      )}
      {children}
    </div>
  );
}

/** The conversations this one's Agent called (docs/AGENT-CALLS.md §6): the sidebar leaves them out while this one is listed. */
export function SessionCalls({ calls, onOpen }: { calls: readonly Session[]; onOpen: (id: string) => void }) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  if (calls.length === 0) return null;
  const sorted = [...calls].sort((left, right) => Date.parse(sessionActivityAt(right)) - Date.parse(sessionActivityAt(left)));
  const shown = expanded ? sorted : sorted.slice(0, 3);
  return (
    <InfoSection title={t({ message: '调用', context: 'session-origin' })} summary={calls.length}>
      <ul>
        {shown.map((call) => (
          <li key={call.id}>
            <ListRow data-closes-overlay onClick={() => onOpen(call.id)} className="text-fg" leading={<AgentLogo backend={sessionBackend(call)} size={14} />} meta={relativeTime(sessionActivityAt(call))}>
              {call.title}
            </ListRow>
          </li>
        ))}
      </ul>
      {sorted.length > shown.length && <InfoMore hidden={sorted.length - shown.length} onClick={() => setExpanded(true)} />}
    </InfoSection>
  );
}

/**
 * The side discussions of this session. They are listed here from the same endpoint the panel
 * uses, fetched when the surface opens, so the header carries no list of its own.
 */
export function SessionDiscussions({ parentId, onOpen }: { parentId: string; onOpen: (discussion: Session) => void }) {
  const { t } = useLingui();
  const [threads, setThreads] = useState<Session[]>([]);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setThreads([]);
    // A supplementary list: when it cannot load, the section is simply absent.
    api.discussions(parentId, controller.signal).then(
      (sessions) => setThreads(sessions.filter((item) => !isSessionDeleted(item.id)).sort((left, right) => Date.parse(sessionActivityAt(right)) - Date.parse(sessionActivityAt(left)))),
      () => undefined,
    );
    return () => controller.abort();
  }, [parentId]);
  if (threads.length === 0) return null;
  const shown = expanded ? threads : threads.slice(0, 3);
  return (
    <InfoSection title={t`侧边聊天`} summary={threads.length}>
      <ul>
        {shown.map((thread) => (
          <li key={thread.id}>
            <ListRow data-closes-overlay onClick={() => onOpen(thread)} className="text-fg" leading={<IconMessageSquareText />} meta={relativeTime(sessionActivityAt(thread))}>
              {thread.origin?.discussion?.quote.exact || thread.title}
            </ListRow>
          </li>
        ))}
      </ul>
      {threads.length > shown.length && <InfoMore hidden={threads.length - shown.length} onClick={() => setExpanded(true)} />}
    </InfoSection>
  );
}
