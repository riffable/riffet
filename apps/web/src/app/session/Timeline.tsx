import { createContext, memo, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconBot, IconBrain, IconChevronRight, IconCopy, IconCornerUpRight, IconEllipsis, IconGitFork, IconImageDown, IconRotateCcw, IconTextQuote } from '@/components/icons';
import type { AgentMember, CapturedSessionReference, NativeBackendId, NativeRunRecovery, Run, RunMetrics } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { OwnerAvatar } from '@/components/OwnerAvatar';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { ShimmerText } from '@/components/ui/controls';
import { CopyButton } from '@/components/ui/copy-button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { copyWithToast } from '@/lib/files';
import { cn, formatDateTime } from '@/lib/utils';
import { reasoningPreview } from '../../../../../packages/timeline/src/findText';
import { useAnswerShare } from '../marks/ShareImage';
import { MemberAvatar } from '../team/MemberAvatar';
import { MessageWithMentions, unwrittenMentions } from './agentMentions';
import { nativeDeliveryStatus, nativeTaskOutcome, sendPhase } from './delivery';
import { FailureDetails } from './FailureDetails';
import { Markdown } from './Markdown';
import { MarkedIndicator, MarkMenuItem, markBodies, type MarkTarget } from './marks';
import { MessageAttachments } from './MessageAttachments';
import { commandIcon, MessageCommandResults, useMessageCommandItems } from './messageCommands';
import { canRestoreUnsentRun, type ReasoningChannel, type UserAttachment } from './model';
import { quoteLabel, splitQuotes } from './quotes';
import { useRemembered } from './rememberedState';
import { revealOnOwnHover, useRestReveal } from './sessionLayout';
import { MentionedAgents, SessionReferences } from './SessionReferences';
import { tokensPerSecond, formatTokensPerSecond } from './speed';
import { Disclosure } from './TimelineBlocks';
import { ToolVerbLabel } from './TimelineTools';
import { useTranscriptResources } from './transcriptResources';

export { BackgroundWorkIndicator, CodeBlock, compactDuration, DiffView, Disclosure, ImageBlock, PlanBlock, PlanList, StatusRow, WorkingIndicator } from './TimelineBlocks';
export { MergedToolRow, TaskNotificationRow, ToolContents, toolIcons, ToolMetaSlot, ToolRow, ToolTargetSlot, ToolVerbLabel, TurnTriggerBlock, useItemsDiffStats, JobRow } from './TimelineTools';

/**
 * What a prompt says about its delivery. A turn stopped after the prompt arrived is the turn's
 * outcome, not the prompt's: `stopShown` false leaves 已停止 to the row that ends the turn.
 */
export function nativeDeliveryLabel(run: Run, stopShown = true, hasTurnOutput = false): string {
  switch (nativeDeliveryStatus(run, stopShown, hasTurnOutput)) {
    case '': return '';
    case 'sending': return i18n._(msg`发送中`);
    case 'resuming': return i18n._(msg`恢复中`);
    case 'outcome_unknown': return i18n._(msg`暂时无法获取任务状态`);
    case 'unconfirmed': return i18n._(msg`暂时无法确认是否已发送`);
    case 'task_failed': return i18n._(msg`任务失败`);
    case 'send_failed': return i18n._(msg`发送失败`);
    case 'stopped': return i18n._(msg`已停止`);
    case 'cancelled': return i18n._(msg`已取消`);
  }
}

/** What a finished turn can be taken back to: its code before it ran, or a new conversation from it. */
export type TurnAction = 'rewind' | 'fork';

/** An embedded discussion can return any finished reply to its parent's draft. */
export const AnswerBringBackContext = createContext<((text: string) => void) | undefined>(undefined);

/**
 * The actions under a finished answer. Copying is the common case; forking and rewinding are rare
 * and consequential, so instead of buttons of their own they share one quiet menu with copy, the
 * way ChatGPT keeps "branch in new chat" behind an answer's overflow. They belong to the answer
 * because that is where a turn ends: forking from it carries the turn along, rewinding returns the code to before it.
 * A turn Riffet did not send — a CLI-initiated follow-up such as a background task's completion,
 * another backend, or an archived conversation — has no Run to fork or rewind, but keeps the same
 * menu for the actions it does have: one transcript must not show two footer styles.
 */
export function AnswerActions({ text, runId, onTurnAction, mark, at, pluginItems: offerPlugins = false }: { text?: string; runId?: string; onTurnAction?: (action: TurnAction, runId: string) => void; mark?: MarkTarget; at?: string; /** Plugin commands of the message menu: only where their result is drawn under the answer (`MessageCommandResults`). */ pluginItems?: boolean }) {
  const { t } = useLingui();
  const bringBack = useContext(AnswerBringBackContext);
  const share = useAnswerShare(text, at ?? mark?.at);
  const pluginItems = useMessageCommandItems(offerPlugins ? text : undefined, runId);
  const resources = useTranscriptResources();
  if (resources) return text ? <CopyButton text={text} label={t`复制回答`} className="no-hover:h-11 no-hover:px-3" /> : null;
  const turn = runId && onTurnAction ? { runId, onTurnAction } : undefined;
  // Nothing to offer an empty, unmarkable follow-up: the timestamp keeps the footer on its own.
  if (!text && !mark && !turn) return null;
  return (<>
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={t`回答操作`} title={t`更多`} className="inline-flex h-6 items-center rounded-md px-1.5 text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus data-[state=open]:bg-hover data-[state=open]:text-fg no-hover:h-11 no-hover:px-3">
        <IconEllipsis className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        {text && <DropdownMenuItem onSelect={() => void copyWithToast(text)}><IconCopy /><Trans>复制</Trans></DropdownMenuItem>}
        {text && bringBack && <DropdownMenuItem onSelect={() => bringBack(text)}><IconCornerUpRight /><Trans>带回主会话</Trans></DropdownMenuItem>}
        <MarkMenuItem target={mark} />
        {share.available && <DropdownMenuItem onSelect={share.open}><IconImageDown /><Trans>导出为图片</Trans></DropdownMenuItem>}
        {pluginItems.map(({ command, run }) => { const Icon = commandIcon(command.icon); return <DropdownMenuItem key={command.id} onSelect={run}><Icon />{command.title}</DropdownMenuItem>; })}
        {turn && (text || mark) && <DropdownMenuSeparator />}
        {turn && <DropdownMenuItem onSelect={() => turn.onTurnAction('fork', turn.runId)}><IconGitFork /><Trans>从此处另开会话</Trans></DropdownMenuItem>}
        {turn && <DropdownMenuItem onSelect={() => turn.onTurnAction('rewind', turn.runId)}><IconRotateCcw /><Trans>回退代码到本轮开始前</Trans></DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
    {share.dialog}
  </>);
}

/**
 * The meta row is always one text line tall, or a finger's height where the pointer is a finger
 * (the copy button there is already that tall), so a message gaining 取消 and
 * losing it once it is sent changes what the row says, never its height. The actions stay inside
 * that height: a target reaching past it would overlap the next action when the row wraps.
 */
const statusRow = 'min-h-lh no-hover:min-h-11';
const statusAction = 'no-hover:min-h-11';

/** The quotes a message starts with (quotes.ts), as chips under it; one opens to the whole quote. */
function MessageQuotes({ quotes }: { quotes: string[] }) {
  if (!quotes.length) return null;
  return (
    <div className="flex max-w-[82%] flex-wrap justify-end gap-1.5">
      {quotes.map((quote, index) => (
        <Popover key={index}>
          <PopoverTrigger asChild>
            <button type="button" className="inline-flex min-h-11 max-w-64 items-center gap-1.5 rounded-md bg-subtle px-2 text-xs text-fg-2 hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus data-[state=open]:bg-hover md:min-h-7">
              <IconTextQuote className="size-3 shrink-0 text-fg-3" /><span className="truncate">{quoteLabel(quote)}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="max-h-80 w-96 overflow-y-auto px-4 py-3"><Markdown text={quote} /></PopoverContent>
        </Popover>
      ))}
    </div>
  );
}

export const TopicDivider = memo(function TopicDivider({ time, collapsible, collapsed, onToggle }: {
  time?: string;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const { t } = useLingui();
  return (
    <div className="flex items-center gap-3 py-1 select-none" role="separator" aria-label={t`新话题`}>
      <span aria-hidden className="h-px flex-1 bg-line" />
      <div className="flex shrink-0 items-center gap-2 text-2xs text-fg-3">
        <span><Trans>新话题</Trans></span>
        {time && <time dateTime={time} className="tabular-nums text-fg-4">{formatDateTime(time)}</time>}
        {collapsible && onToggle && (
          <Button size="xs" variant="quiet" aria-expanded={!collapsed} className="max-md:min-h-11 no-hover:min-h-11 text-2xs text-fg-3 hover:text-fg-2" onClick={onToggle}>
            <IconChevronRight className={cn('size-3 transition-transform duration-[var(--duration-fast)] motion-reduce:transition-none', !collapsed && 'rotate-90')} />
            {collapsed ? <Trans>显示更早话题</Trans> : <Trans>收起更早话题</Trans>}
          </Button>
        )}
      </div>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </div>
  );
});

export interface CallSenderInfo {
  kind: 'member' | 'agent';
  name: string;
  member?: AgentMember;
  backendId?: NativeBackendId;
  sessionId?: string;
}

export type MessageSender =
  | { kind: 'owner'; owner?: { name?: string; avatar?: { url: string } } }
  | CallSenderInfo;

export const UserMessage = memo(function UserMessage({ stopShown = true, hasTurnOutput = false, progressShown = false, from, sender, branch, markdown = false, text, attachments, references, recipientSessionId, onOpenSession, time, footerPinned, run, failureShown = false, runActionPending, onOpenTerminal, onRetryNativeRun, onCancelNativeRun, onCheckNativeRun, onContinueNativeRun, nativeRecoveries, onRestoreNativeRun }: {
  /** The turn stopped with nothing after this prompt, so the prompt is where 已停止 is told. */
  stopShown?: boolean;
  /** Same-turn agent output already follows this prompt, proving the CLI received it. */
  hasTurnOutput?: boolean;
  /** The transcript's bottom `WorkingIndicator` is already showing this prompt's sending/resuming state. */
  progressShown?: boolean;
  /** Written by another agent, not the reader: the conversation leading a subagent, or a peer agent. */
  from?: 'coordinator' | 'peer';
  /** Identifies who sent this turn in multi-party/called conversations (avatar + restrained low-saturation bubble tint). */
  sender?: MessageSender;
  /** Optional git branch reported alongside an agent call result. */
  branch?: string;
  /** Renders the bubble body as Markdown (used for async call-result deliveries from another Agent). */
  markdown?: boolean;
  text: string;
  attachments: UserAttachment[];
  references?: CapturedSessionReference[];
  recipientSessionId?: string;
  onOpenSession?: (id: string) => void;
  time?: string;
  footerPinned?: boolean;
  run?: Run;
  failureShown?: boolean;
  runActionPending?: boolean;
  onOpenTerminal?: () => void;
  onRetryNativeRun?: (run: Run) => void;
  onCancelNativeRun?: (run: Run) => void;
  onCheckNativeRun?: (run: Run) => void;
  onContinueNativeRun?: (run: Run) => void;
  nativeRecoveries?: Record<string, NativeRunRecovery>;
  onRestoreNativeRun?: (run: Run) => void;
}) {
  const { t } = useLingui();
  const resources = useTranscriptResources();
  const taskOutcome = run ? nativeTaskOutcome(run) : undefined;
  const indicatorOwnsSend = progressShown && run?.native?.intent !== 'steer' && ['queued', 'preparing', 'dispatching', 'input_sent'].includes(run?.native?.delivery ?? '');
  const delivery = run?.native && !taskOutcome && !failureShown && !indicatorOwnsSend ? nativeDeliveryLabel(run, stopShown, hasTurnOutput) : '';
  const rest = useRestReveal();
  // A message that is nothing but a quote stays as it was written: there would be no bubble to hang the chip from.
  const quoted = useMemo(() => {
    if (markdown) return { quotes: [], body: text };
    const split = splitQuotes(text);
    return split.body.trim() ? split : { quotes: [], body: text };
  }, [markdown, text]);
  const [errorOpen, setErrorOpen] = useRemembered(`delivery-error:${run?.id ?? ''}`, false);
  // While it is on its way the status says enough; the time returns once it has arrived or settled.
  const sending = Boolean(delivery && run && ['submitting', 'queued', 'starting', 'sent'].includes(sendPhase(run) ?? ''));
  const recovery = run ? nativeRecoveries?.[run.id] : undefined;
  const diagnostic = run?.native?.diagnostic;
  const deliveryError = !failureShown && run?.native && (run.native.delivery === 'failed' || run.native.delivery === 'uncertain' || run.native.stage === 'turn_outcome_unknown') ? diagnostic ? [diagnostic.message, diagnostic.code, diagnostic.stage, diagnostic.at].filter(Boolean).join('\n') : run.error : undefined;
  const needsCheck = run?.native && (run.native.delivery === 'uncertain' || run.native.stage === 'turn_outcome_unknown' || run.native.stage === 'acknowledged');
  const openTerminal = needsCheck && onOpenTerminal && <button type="button" onClick={onOpenTerminal} className={cn(statusAction, 'text-fg underline underline-offset-2')}><Trans>打开终端</Trans></button>;
  const continueAction = run && recovery?.canContinue && !run.native?.queueReleasedAt && onContinueNativeRun
    ? <button type="button" disabled={runActionPending} onClick={() => onContinueNativeRun(run)} className={cn(statusAction, 'text-fg-3 underline underline-offset-2 hover:text-fg disabled:opacity-50')}>{recovery.queuedRunIds.length ? <Trans>继续发送 {recovery.queuedRunIds.length} 条消息</Trans> : <Trans>继续对话</Trans>}</button>
    : null;
  const peerSender = sender && sender.kind !== 'owner' ? sender : undefined;
  const senderAvatar = !sender ? null
    : sender.kind === 'owner'
      ? <OwnerAvatar owner={sender.owner} size={16} className="shrink-0" />
      : sender.kind === 'member' && sender.member
        ? <MemberAvatar member={sender.member} size={16} className="shrink-0" />
        : (
          <span className="grid size-4 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
            {sender.backendId ? <AgentLogo backend={sender.backendId} size={11} /> : <IconBot aria-hidden className="size-3" />}
          </span>
        );
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className={cn(
        'min-w-0 break-words rounded-3xl px-4 py-2.5 text-base text-fg',
        markdown ? 'max-w-[min(88%,640px)]' : 'max-w-[min(82%,560px)] whitespace-pre-wrap',
        peerSender ? 'bg-accent-soft ring-1 ring-inset ring-accent/15' : 'bg-bubble',
      )}>
        {markdown ? (
          <Markdown text={quoted.body} />
        ) : (
          <MessageWithMentions
            text={quoted.body}
            agents={run?.native?.input.agents}
            files={run?.native?.input.context}
            sessions={references ?? run?.native?.contextSnapshots}
          />
        )}
      </div>
      <MessageQuotes quotes={quoted.quotes} />
      <MessageAttachments attachments={attachments} />
      {recipientSessionId && !resources && <SessionReferences references={references ?? run?.native?.contextSnapshots} recipientSessionId={recipientSessionId} onOpenSession={onOpenSession} />}
      {!resources && <MentionedAgents agents={unwrittenMentions(quoted.body, run?.native?.input.agents)} />}
      {(text || time || delivery || sender) && (
        <div data-slot="message-meta" {...rest} className={cn('message-meta-band flex max-w-[82%] cursor-default select-none flex-wrap items-center justify-end gap-x-2 gap-y-1 px-1 text-2xs text-fg-3 transition-opacity', statusRow, !footerPinned && !delivery && !from && !sender && !resources && revealOnOwnHover)}>
          {peerSender && (
            peerSender.sessionId && onOpenSession
              ? <button type="button" onClick={() => onOpenSession(peerSender.sessionId!)} className="inline-flex items-center gap-1.5 text-fg-2 underline-offset-2 hover:text-fg hover:underline">{senderAvatar}{peerSender.name}</button>
              : <span className="inline-flex items-center gap-1.5 text-fg-2">{senderAvatar}{peerSender.name}</span>
          )}
          {!peerSender && sender?.kind === 'owner' && (
            <span className="inline-flex items-center gap-1.5 text-fg-2">{senderAvatar}{sender.owner?.name}</span>
          )}
          {branch && <span className="font-mono text-fg-4">{branch}</span>}
          {!peerSender && from && <span className="inline-flex items-center gap-1"><IconBot aria-hidden className="size-3" />{from === 'coordinator' ? <Trans>主对话</Trans> : <Trans>另一个 Agent</Trans>}</span>}
          {run?.native?.intent === 'steer' && <span className="inline-flex items-center gap-1"><IconCornerUpRight aria-hidden className="size-3" /><Trans>补充</Trans></span>}
          {delivery && (deliveryError ? <button type="button" aria-expanded={errorOpen} onClick={() => setErrorOpen(!errorOpen)} className={cn(statusAction, 'inline-flex items-center gap-0.5 text-fg-3 hover:text-fg')}>{delivery}<IconChevronRight aria-hidden className={cn('size-3 transition-transform', errorOpen && 'rotate-90')} /></button> : <span role="status" className="min-w-0 [overflow-wrap:anywhere]">{delivery}</span>)}
          {!taskOutcome && openTerminal}
          {run?.native?.delivery === 'uncertain' && run.native.stage === 'http_unknown' && onRetryNativeRun && <button type="button" disabled={runActionPending} onClick={() => onRetryNativeRun(run)} className={cn(statusAction, 'text-fg-3 underline underline-offset-2 hover:text-fg disabled:opacity-50')}><Trans>重试发送</Trans></button>}
          {!taskOutcome && needsCheck && run && onCheckNativeRun && <button type="button" disabled={runActionPending} onClick={() => onCheckNativeRun(run)} className={cn(statusAction, 'text-fg-3 underline underline-offset-2 hover:text-fg disabled:opacity-50')}><Trans>检查状态</Trans></button>}
          {!taskOutcome && continueAction}
          {(run?.native?.delivery === 'queued' || run?.native?.delivery === 'preparing') && run.native.stage !== 'http_pending' && onCancelNativeRun && <button type="button" disabled={runActionPending} onClick={() => onCancelNativeRun(run)} className={cn(statusAction, 'text-fg-3 underline underline-offset-2 hover:text-danger disabled:opacity-50')}><Trans>取消</Trans></button>}
          {run && canRestoreUnsentRun(run) && onRestoreNativeRun && <button type="button" disabled={runActionPending} onClick={() => onRestoreNativeRun(run)} className={cn(statusAction, 'text-fg-3 underline underline-offset-2 hover:text-fg disabled:opacity-50')}><Trans>恢复到输入框</Trans></button>}
          {time && !sending && <time dateTime={time} className="shrink-0 tabular-nums">{formatDateTime(time)}</time>}
          {text && <CopyButton text={text} label={t`复制消息`} />}
        </div>
      )}
      {!taskOutcome && deliveryError && <Collapse open={errorOpen} className="w-full max-w-[82%]"><FailureDetails text={deliveryError} className="rounded-lg bg-subtle p-3 text-xs text-fg-3" /></Collapse>}
      {taskOutcome && run && (!failureShown || continueAction) && <div className="flex max-w-full flex-col gap-2 self-start text-xs text-fg-3">
        <div className="flex flex-wrap items-center gap-3">
          {!failureShown && <span role="status">{taskOutcome === 'failed' ? <Trans>任务失败</Trans> : <Trans>暂时无法获取任务状态</Trans>}</span>}
          {taskOutcome === 'unknown' && openTerminal}
          {taskOutcome === 'unknown' && onCheckNativeRun && <button type="button" disabled={runActionPending} onClick={() => onCheckNativeRun(run)} className={cn(statusAction, 'underline underline-offset-2 hover:text-fg disabled:opacity-50')}><Trans>检查状态</Trans></button>}
          {continueAction}
          {deliveryError && <button type="button" aria-expanded={errorOpen} onClick={() => setErrorOpen(!errorOpen)} className={cn(statusAction, 'underline underline-offset-2 hover:text-fg')}><Trans>查看详情</Trans></button>}
        </div>
        {deliveryError && <Collapse open={errorOpen}><FailureDetails text={deliveryError} className="rounded-lg bg-subtle p-3 text-xs text-fg-3" /></Collapse>}
      </div>}

    </div>
  );
});

/**
 * [mark] makes an answer markable: its body carries the ids a highlight is resolved against
 * (see `MarkLayer`), and its actions offer 收藏回复.
 */
export const AssistantMessage = memo(function AssistantMessage({ text, showActions, streaming, time, modelLabel, footerPinned, metrics, runId, onTurnAction, mark, progress, chapters = false, stopped = false }: {
  text: string; showActions: boolean; stopped?: boolean; streaming?: boolean; time?: string; modelLabel?: string; metrics?: RunMetrics; runId?: string; onTurnAction?: (action: TurnAction, runId: string) => void; mark?: MarkTarget;
  footerPinned?: boolean;
  chapters?: boolean;
  /**
   * The latest answer of a turn still running: the footer's place is held, showing this (the working
   * line, or nothing) until the actions take it, so the turn ending does not move the answer. Left
   * out, an answer that is not settled has no footer.
   */
  progress?: ReactNode;
}) {
  const resources = useTranscriptResources();
  const markBody = useCallback((element: HTMLDivElement | null) => { if (element && mark) markBodies.set(element, mark); }, [mark]);
  return (
    // The 36px slot stays reserved while the turn runs; its transparent hover padding borrows
    // the surrounding whitespace without moving the prose or the next row.
    <div className="group/message flex flex-col gap-2.5">
      {/* Always wrapped, so the body does not remount (and lose its open blocks) when the turn settles. */}
      <div ref={markBody} data-mark-ids={mark?.ids.join(' ')} data-chapter-body={chapters ? '' : undefined} className="min-w-0"><Markdown text={text} streaming={streaming} chapters={chapters} /></div>
      <MessageFooter text={text} showActions={showActions} time={time} modelLabel={modelLabel} stopped={stopped} footerPinned={footerPinned} metrics={metrics} runId={runId} onTurnAction={onTurnAction} mark={mark} progress={progress} pluginItems={!resources} />
      {showActions && !resources && <MessageCommandResults text={text} {...(runId ? { runId } : {})} />}
    </div>
  );
});

/** The same turn actions and timestamp belong under an answer or the result that ended it. */
export function MessageFooter({ text, showActions, time, modelLabel, footerPinned, metrics, runId, onTurnAction, mark, progress, stopped = false, pluginItems = false }: {
  text?: string; showActions: boolean; time?: string; modelLabel?: string; footerPinned?: boolean; pluginItems?: boolean;
  /** The answer ends a stopped turn: 已停止 leads the time and keeps the line on screen. */
  stopped?: boolean; metrics?: RunMetrics;
  runId?: string; onTurnAction?: (action: TurnAction, runId: string) => void; mark?: MarkTarget; progress?: ReactNode;
}) {
  const { t } = useLingui();
  const resources = useTranscriptResources();
  const rate = tokensPerSecond(metrics);
  const rest = useRestReveal();
  if (!showActions && !time && progress === undefined) return null;
  return <div data-slot="message-meta" {...rest} className={cn('turn-footer -ml-1.5 flex min-h-7 cursor-default select-none flex-wrap items-center gap-1 transition-opacity can-hover:-ml-5.5 no-hover:min-h-11', (showActions || time) && !footerPinned && !stopped && !resources && revealOnOwnHover)}>
    {!showActions && !time && progress && <div className="ml-1.5 min-w-0">{progress}</div>}
    {showActions && <AnswerActions text={text} runId={runId} onTurnAction={onTurnAction} mark={mark} pluginItems={pluginItems} {...(time ? { at: time } : {})} />}
    <MarkedIndicator target={mark} />
    {stopped && <span role="status" className="shrink-0 px-1 text-2xs text-fg-3">{t`已停止`}</span>}
    {time && <time dateTime={time} className="shrink-0 px-1 text-2xs tabular-nums text-fg-3">{formatDateTime(time)}</time>}
    {modelLabel && <span className="shrink-0 px-1 text-2xs text-fg-3">{modelLabel}</span>}
    {time && metrics && rate !== undefined && (
      <span className={cn('shrink-0 px-1 text-2xs tabular-nums', metrics.tokens === 'provider' ? 'text-fg-3' : 'text-fg-4')}>
        {metrics.tokens === 'provider' ? '' : '~'}{formatTokensPerSecond(rate)} tok/s
      </span>
    )}
  </div>;
}

/**
 * Narration — the short summary the CLI shows in the user's language — is rendered as plain
 * content with no icon/label row above it; the muted typography (`md-muted`) is what marks it as
 * reasoning rather than the answer, and folding a finished turn away is `TurnProcess`'s job.
 *
 * Raw thinking is long, English, and rarely what anyone came to read, so it collapses to a single
 * row like a tool call. It stays expandable because for models that never narrate it is the only
 * reasoning there is.
 */
export const ThoughtRow = memo(function ThoughtRow({ text, channel, running }: { text: string; channel: ReasoningChannel; running?: boolean }) {
  const [open, setOpen] = useRemembered('thought', false);
  // `data-narration` lets the selection toolbar act on it (MarkLayer); it has no anchor for highlights.
  if (channel === 'narration') return <div data-narration className="min-w-0"><Markdown text={text} className="md-muted" streaming={running} /></div>;
  return (
    // Uses the same fixed-width verb column (`Think`) and `text-xs` height as tool rows so
    // thought rows inside a `ToolRun` or `TurnProcess` share one visual rhythm with actions.
    <Disclosure
      touchCompact
      icon={<IconBrain />}
      title={<ToolVerbLabel verb="Think" />}
      detail={open ? undefined : <ShimmerText active={running} className="min-w-0 truncate font-sans text-xs text-fg-3">{reasoningPreview(text, running)}</ShimmerText>}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <Markdown text={text} className="md-muted md-thought" streaming={running} />
    </Disclosure>
  );
});
