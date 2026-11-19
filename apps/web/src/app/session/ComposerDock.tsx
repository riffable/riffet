import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { InboxAction, Run, SessionGoal } from '@contracts';
import { IconArrowUp, IconCornerUpRight, IconChevronDown, IconCircle, IconCircleCheck, IconCircleDashed, IconEllipsis, IconListTodo, IconMessagesSquare, IconMinus, IconPencilLine, IconTarget, IconTrash2 } from '@/components/icons';
import { Tip } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { formatTokens } from '@/lib/stats-format';
import { MOBILE_LAYOUT_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { Collapse } from '@/components/ui/collapse';
import { useHeld } from './sessionLayout';

/**
 * Dock cards attached above the composer: the agent's todo list and the outgoing queue.
 *
 * Both follow the DeepSeek Harness pattern — one card that lives directly above the input card
 * instead of inline entries in the transcript: a single header row that expands, todo items that
 * collapse once the work is finished, and queue rows with compact actions beside the message.
 */

export interface TodoEntry { content: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled'; }

export const todoSettled = (todo: TodoEntry): boolean => todo.status === 'completed' || todo.status === 'cancelled';

/** Normalize the raw `plan` payload into renderable todo rows. */
export function todoEntries(entries: Record<string, unknown>[]): TodoEntry[] {
  return entries.flatMap((entry) => {
    const content = typeof entry.content === 'string' ? entry.content : typeof entry.title === 'string' ? entry.title : '';
    if (!content) return [];
    const status = entry.status === 'completed' ? 'completed' : entry.status === 'in_progress' ? 'in_progress' : entry.status === 'cancelled' ? 'cancelled' : 'pending';
    return [{ content, status }];
  });
}

/** Keep empty plan snapshots in the transcript instead of treating them as dock-owned work. */
export function todoPlanForDock(entries: Record<string, unknown>[], laterTurn: boolean): Record<string, unknown>[] | undefined {
  const todos = todoEntries(entries);
  if (!todos.length || (todos.every(todoSettled) && laterTurn)) return undefined;
  return entries;
}

/** Return an automatic expansion state only for a new list or a settled list becoming active. */
export function todoDockAutoOpen(
  previous: { signature: string; allDone: boolean } | undefined,
  current: { signature: string; allDone: boolean },
  mobile: boolean,
): boolean | undefined {
  if (!previous || previous.signature !== current.signature) return !current.allDone && !mobile;
  if (current.allDone) return false;
  if (previous.allDone) return !mobile;
  return undefined;
}

/** `2 已完成 · 1 进行中 · 3 待处理`, omitting empty segments. */
export function todoProgress(entries: TodoEntry[]): string {
  const done = entries.filter((entry) => entry.status === 'completed').length;
  const active = entries.filter((entry) => entry.status === 'in_progress').length;
  const cancelled = entries.filter((entry) => entry.status === 'cancelled').length;
  const pending = entries.length - done - active - cancelled;
  const segments: [number, string][] = [[done, i18n._(msg({ message: '已完成', context: 'session-status-finished' }))], [active, i18n._(msg({ message: '进行中', context: 'session-status-in-progress' }))], [pending, i18n._(msg`待处理`)], [cancelled, i18n._(msg`已取消`)]];
  return segments
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(' · ');
}

const planIcon = (status: TodoEntry['status'], running: boolean) => status === 'completed'
  ? <IconCircleCheck className="size-3.5 shrink-0 text-success" />
  : status === 'cancelled'
    ? <IconMinus className="size-3.5 shrink-0 text-fg-4" />
    : status === 'in_progress'
      ? <IconCircleDashed className={cn('size-3.5 shrink-0 text-accent', running && 'animate-[spin_3s_linear_infinite]')} />
      : <IconCircle className="size-3.5 shrink-0 text-fg-4" />;

/** The status words; a status this build does not know reads as an active goal. */
const goalStatuses: Record<SessionGoal['status'], MessageDescriptor> = {
  active: msg({ message: '进行中', context: 'session-status-in-progress' }),
  paused: msg`已暂停`,
  blocked: msg`受阻`,
  usage_limited: msg`用量已达上限`,
  budget_limited: msg`预算已用完`,
  complete: msg({ message: '已完成', context: 'session-status-finished' }),
};

/**
 * What the goal's status reads as. A goal stopped by a limit also says how many tokens it used (against
 * its budget when it has one): that is what the reader decides on next.
 */
export function goalStatusLabel(goal: SessionGoal): string {
  const label = i18n._(goalStatuses[goal.status] ?? goalStatuses.active);
  const limited = goal.status === 'usage_limited' || goal.status === 'budget_limited';
  if (!limited || goal.tokensUsed === undefined) return label;
  const used = formatTokens(goal.tokensUsed);
  const budget = goal.tokenBudget === undefined ? undefined : formatTokens(goal.tokenBudget);
  const tokens = budget ? i18n._(msg`${used} / ${budget} token`) : i18n._(msg`${used} token`);
  return `${label} · ${tokens}`;
}

/** The goal, above the input card: one row, no expansion — a goal is a sentence plus a phase. */
export function GoalDock({ goal }: { goal: SessionGoal }) {
  const { t } = useLingui();
  const blocked = goal.status === 'blocked';
  return (
    <div className={cn('flex flex-col gap-0.5 rounded-2xl px-3 py-2', dockSurface)}>
      <div className="flex items-center gap-2">
        <IconTarget aria-hidden className={cn('size-4 shrink-0', blocked ? 'text-warning' : 'text-fg-3')} />
        <span className="text-xs font-medium text-fg">{t`目标`}</span>
        <span className={cn('text-xs', blocked ? 'text-warning' : 'text-fg-3')}>{goalStatusLabel(goal)}</span>
      </div>
      {goal.objective && <p className="line-clamp-2 text-sm text-fg-2">{goal.objective}</p>}
      {blocked && goal.reason && <p className="line-clamp-2 text-2xs text-warning">{goal.reason}</p>}
    </div>
  );
}

/** The card surface shared by both docks; the last dock squares off against the composer card. */
const dockSurface = 'bg-elevated max-md:border max-md:border-line-strong md:shadow-composer';

export function TodoDock({ entries, running }: { entries: Record<string, unknown>[]; running: boolean }) {
  const { t } = useLingui();
  const todos = useMemo(() => todoEntries(entries), [entries]);
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const [open, setOpen] = useState(!mobile);
  const signature = useMemo(() => todos.map((todo) => todo.content).join('\u0000'), [todos]);
  const allDone = todos.length > 0 && todos.every(todoSettled);
  const previous = useRef<{ signature: string; allDone: boolean } | undefined>(undefined);
  // New lists open, finished lists fold away, and a finished list becoming active opens again.
  // Ordinary progress updates leave the panel alone so a manual collapse is preserved.
  useEffect(() => {
    if (!todos.length) return;
    const current = { signature, allDone };
    const nextOpen = todoDockAutoOpen(previous.current, current, mobile);
    previous.current = current;
    if (nextOpen !== undefined) setOpen(nextOpen);
  }, [signature, todos.length, allDone, mobile]);

  if (!todos.length) return null;
  return (
    <section className={cn(dockSurface, 'rounded-2xl px-3 py-1.5 max-md:rounded-3xl max-md:shadow-soft')} aria-label={t`待办`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex h-11 w-full items-center gap-2 text-left md:h-8">
        <IconListTodo className="size-4 shrink-0 text-fg-3" />
        <span className="shrink-0 text-sm font-medium text-fg">{t`待办`}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-fg-3">{!running && !allDone ? t`上次记录 · ` : ''}{todoProgress(todos)}</span>
        <IconChevronDown className={cn('size-3.5 shrink-0 text-fg-4 transition-transform duration-[var(--duration-base)] ease-[var(--ease-standard)]', open && 'rotate-180')} />
      </button>
      <Collapse open={open}>
        <ul className="mb-1 flex max-h-[180px] flex-col gap-1.5 overflow-y-auto pt-0.5">
          {todos.map((todo, index) => (
            <li key={`${todo.content}:${index}`} className="flex min-w-0 items-start gap-2 text-sm">
              <span className="mt-0.5">{planIcon(todo.status, running)}</span>
              <span className={cn('min-w-0 flex-1 text-fg', todoSettled(todo) && 'text-fg-3 line-through decoration-fg-4')}>{todo.content}</span>
            </li>
          ))}
        </ul>
      </Collapse>
    </section>
  );
}

const queueAction = 'grid size-11 shrink-0 place-items-center rounded-full text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:opacity-50 md:size-6.5';

/** Whether one queue action is offered. A server entry decides; a run it has not listed keeps the callback. */
function offersQueueAction(actions: readonly InboxAction[] | undefined, name: InboxAction, fallback: boolean): boolean {
  return actions ? actions.includes(name) : fallback;
}

export function QueueDock({ runs, running, unconfirmed, onRevealUnconfirmed, pending, onSendNow, onSteer, steerDisabled, onEdit, onRemove, inboxActions, steerUnlisted, sendUnlisted }: {
  runs: Run[];
  running: boolean;
  /** An earlier message whose delivery is unconfirmed holds the queue; it is settled on that message. */
  unconfirmed?: boolean;
  /** Scroll to that message, where it is checked. */
  onRevealUnconfirmed?: () => void;
  pending?: (runId: string) => boolean;
  onSendNow?: (runId: string) => void;
  onSteer?: (runId: string) => void;
  steerDisabled?: boolean;
  onEdit?: (runId: string) => void;
  onRemove?: (runId: string) => void;
  /** Server actions keyed by run id. No entry keeps the unlisted offer below, or `onSteer` / `onSendNow` when those are omitted. */
  inboxActions?: ReadonlyMap<string, readonly InboxAction[]>;
  /** Steer for a run `inboxActions` does not list. Omit to follow whether `onSteer` was passed. */
  steerUnlisted?: boolean;
  /** Stop-and-send for a run `inboxActions` does not list. Omit to follow whether `onSendNow` was passed. */
  sendUnlisted?: boolean;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  if (!runs.length) return null;
  const expandable = runs.length > 1;
  const visible = !expandable || open;
  const row = (run: Run, showLead: boolean) => {
    const blocked = pending?.(run.id) ?? false;
    const attachments = run.native?.input.attachmentIds.slice(0, 3) ?? [];
    const listed = inboxActions?.get(run.id);
    // A listed action is the server's decision, so the local phase guess does not disable it.
    const steerOn = offersQueueAction(listed, 'steer', steerUnlisted ?? Boolean(onSteer));
    const sendOn = offersQueueAction(listed, 'send_now', sendUnlisted ?? Boolean(onSendNow));
    const serverSteer = Boolean(listed?.includes('steer'));
    const serverSend = Boolean(listed?.includes('send_now'));
    const steerLocked = blocked || Boolean(steerDisabled) || (serverSteer ? false : !running);
    const sendLocked = blocked || (serverSend ? false : !running);
    const steerPrimary = steerOn && !steerDisabled;
    const hasMore = Boolean(onEdit || onRemove || (steerPrimary ? sendOn : steerOn));
    return (
      <li key={run.id} className="flex min-h-11 min-w-0 shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 md:min-h-9 md:gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {showLead && <IconMessagesSquare className="size-3.5 shrink-0 text-fg-4" />}
          {attachments.length > 0 && <span className="flex min-w-0 max-w-[35%] items-center gap-1 overflow-hidden md:max-w-none md:gap-2">
            {attachments.map((id) => (
              <img key={id} src={`/api/attachments/${encodeURIComponent(id)}`} alt="" className="size-6 min-w-0 rounded-sm border border-line object-cover" />
            ))}
          </span>}
          <span className="min-w-0 flex-1 text-sm text-fg-2 max-md:line-clamp-2 max-md:break-words md:truncate">{run.prompt}</span>
        </div>
        {(steerOn || sendOn || onEdit || onRemove) && <span className="flex shrink-0 items-center justify-end">
          {mobile ? <>
            {steerPrimary && onSteer ? <Tip label={t`补充到当前任务`}><button type="button" aria-label={t`补充到当前任务`} disabled={steerLocked} onClick={() => onSteer(run.id)} className={queueAction}><IconCornerUpRight className="size-3.5" /></button></Tip>
              : sendOn && onSendNow && <Tip label={t`停止并发送`}><button type="button" aria-label={t`停止并发送`} disabled={sendLocked} onClick={() => onSendNow(run.id)} className={queueAction}><IconArrowUp className="size-3.5" strokeWidth={2.2} /></button></Tip>}
            {hasMore && <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" aria-label={t`更多`} disabled={blocked} className={queueAction}><IconEllipsis className="size-3.5" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!steerPrimary && steerOn && onSteer && <DropdownMenuItem disabled={steerLocked} onSelect={() => onSteer(run.id)}><IconCornerUpRight /><Trans>补充到当前任务</Trans></DropdownMenuItem>}
                {steerPrimary && sendOn && onSendNow && <DropdownMenuItem disabled={sendLocked} onSelect={() => onSendNow(run.id)}><IconArrowUp /><Trans>停止并发送</Trans></DropdownMenuItem>}
                {onEdit && <DropdownMenuItem disabled={blocked} onSelect={() => onEdit(run.id)}><IconPencilLine /><Trans>移回输入框编辑</Trans></DropdownMenuItem>}
                {onRemove && <DropdownMenuItem disabled={blocked} variant="danger" onSelect={() => onRemove(run.id)}><IconTrash2 /><Trans>移出队列</Trans></DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>}
          </> : <>
            {steerOn && onSteer && <Tip label={t`补充到当前任务`}><button type="button" aria-label={t`补充到当前任务`} disabled={steerLocked} onClick={() => onSteer(run.id)} className={queueAction}><IconCornerUpRight className="size-3.5" /></button></Tip>}
            {sendOn && onSendNow && <Tip label={t`停止并发送`}><button type="button" aria-label={t`停止并发送`} disabled={sendLocked} onClick={() => onSendNow(run.id)} className={queueAction}><IconArrowUp className="size-3.5" strokeWidth={2.2} /></button></Tip>}
            {onEdit && <Tip label={t`移回输入框编辑`}><button type="button" aria-label={t`编辑`} disabled={blocked} onClick={() => onEdit(run.id)} className={queueAction}><IconPencilLine className="size-3.5" /></button></Tip>}
            {onRemove && <Tip label={t`移出队列`}><button type="button" aria-label={t`移出队列`} disabled={blocked} onClick={() => onRemove(run.id)} className={cn(queueAction, 'hover:text-danger')}><IconTrash2 className="size-3.5" /></button></Tip>}
          </>}
        </span>}
      </li>
    );
  };
  return (
    <section className={cn(dockSurface, 'rounded-t-2xl px-2 py-1.5 max-md:rounded-t-3xl max-md:border-b-0')} aria-label={t`排队消息`}>
      {expandable && (
        <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex h-11 w-full items-center gap-2 px-1 text-left md:h-8">
          <IconMessagesSquare className="size-3.5 shrink-0 text-fg-4" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg"><Trans>{runs.length} 条排队消息</Trans></span>
          <IconChevronDown className={cn('size-3.5 shrink-0 text-fg-4 transition-transform duration-[var(--duration-base)] ease-[var(--ease-standard)]', open && 'rotate-180')} />
        </button>
      )}
      <Collapse open={visible}><ul className="flex max-h-[180px] flex-col overflow-y-auto">{runs.map((run) => row(run, !expandable))}</ul></Collapse>
      {unconfirmed && (onRevealUnconfirmed
        ? <button type="button" onClick={onRevealUnconfirmed} className="block px-1.5 pb-1 text-left text-xs text-fg-3 underline-offset-2 transition-colors hover:text-fg hover:underline"><Trans>等待上一条消息确认</Trans></button>
        : <p className="px-1.5 pb-1 text-xs text-fg-3"><Trans>等待上一条消息确认</Trans></p>)}
    </section>
  );
}

/** Everything rendered above the composer card, in dock order: the goal, the todos, then the queue. */
export const ComposerDock = memo(function ComposerDock({ planInAside, goal, todos, runs, running, unconfirmed, onRevealUnconfirmed, pending, onSendQueuedNow, onSteerQueued, steerDisabled, onEditQueued, onRemoveQueued, onQueueShown, followUps, plans, inboxActions, steerUnlisted, sendUnlisted }: {
  /** The session's side column lists the goal and todos whenever it is on screen, so these stand down then. */
  planInAside?: boolean;
  goal?: SessionGoal;
  todos?: Record<string, unknown>[];
  runs?: Run[];
  running: boolean;
  unconfirmed?: boolean;
  onRevealUnconfirmed?: () => void;
  pending?: (runId: string) => boolean;
  onSendQueuedNow?: (runId: string) => void;
  onSteerQueued?: (runId: string) => void;
  steerDisabled?: boolean;
  onEditQueued?: (runId: string) => void;
  onRemoveQueued?: (runId: string) => void;
  /** Server actions keyed by run id. No entry keeps `onSteerQueued` / `onSendQueuedNow`, unless the unlisted flags say otherwise. */
  inboxActions?: ReadonlyMap<string, readonly InboxAction[]>;
  /** Steer for a queued run absent from `inboxActions`. Omit to follow whether `onSteerQueued` was passed. */
  steerUnlisted?: boolean;
  /** Stop-and-send for a queued run absent from `inboxActions`. Omit to follow whether `onSendQueuedNow` was passed. */
  sendUnlisted?: boolean;
  /** Whether the queue card is on screen, from when it starts opening until it has finished closing. */
  onQueueShown?: (shown: boolean) => void;
  /** The conversation's pending send-later messages, drawn above the queue. */
  followUps?: ReactNode;
  /** The 助理's tasks waiting for 开始, drawn first; the card decides by itself whether it shows. */
  plans?: ReactNode;
}): ReactNode {
  const queue = runs ?? [];
  // The side column lists the plan whenever it is on screen; here it would only repeat it.
  const showGoal = !planInAside && goal ? goal : undefined;
  const showTodos = !planInAside && todos && todos.length > 0 ? todos : undefined;
  const heldGoal = useHeld(showGoal);
  const heldTodos = useHeld(showTodos);
  const heldQueue = useHeld(queue.length > 0 && queue);
  const heldFollowUps = useHeld(followUps);
  // The collapse mounts the queue for as long as it shows, closing included.
  const queueRef = useCallback((element: HTMLDivElement | null) => onQueueShown?.(Boolean(element)), [onQueueShown]);
  // Each card carries the space below it, so the space leaves with the card instead of after it.
  return (
    <div className="flex max-h-[min(calc(var(--app-height,100dvh)*0.22),180px)] flex-col overflow-y-auto md:max-h-none md:overflow-visible">
      {plans && <div className="empty:hidden [&>*]:mb-1.5">{plans}</div>}
      <Collapse open={Boolean(showGoal)}>{heldGoal && <div className="pb-1.5"><GoalDock goal={heldGoal} /></div>}</Collapse>
      <Collapse open={Boolean(showTodos)}>{heldTodos && <div className="pb-1.5"><TodoDock entries={heldTodos} running={running} /></div>}</Collapse>
      <Collapse open={Boolean(followUps)}>{heldFollowUps && <div className="pb-1.5">{heldFollowUps}</div>}</Collapse>
      <Collapse open={queue.length > 0}>{heldQueue && <div ref={queueRef}><QueueDock runs={queue.length ? queue : heldQueue} running={running} unconfirmed={unconfirmed} onRevealUnconfirmed={onRevealUnconfirmed} pending={pending} onSendNow={onSendQueuedNow} onSteer={onSteerQueued} steerDisabled={steerDisabled} onEdit={onEditQueued} onRemove={onRemoveQueued} inboxActions={inboxActions} steerUnlisted={steerUnlisted} sendUnlisted={sendUnlisted} /></div>}</Collapse>
    </div>
  );
});
