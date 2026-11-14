import { IconCopy, IconCornerUpRight, IconEllipsis, IconGitFork, IconImageDown, IconRotateCcw } from '@/components/icons';
import { createContext, memo, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconArrowRightLeft, IconBot, IconBrain, IconMessageCircleQuestion, IconChevronRight, IconCircle, IconCircleAlert, IconCircleCheck, IconCircleDashed, IconDownload, IconFilePenLine, IconFileText, IconGlobe, IconImage, IconListChecks, IconListTodo, IconRepeat, IconSearch, IconSquareArrowOutUpRight, IconSquareTerminal, IconTrash2, IconWrench, IconX } from '@/components/icons';
import { ZoomableImage } from './ImageViewer';
import { useImageSource } from './imageSource';
import { revealOnOwnHover, useRestReveal } from './sessionLayout';
import { useTranscriptResources } from './transcriptResources';
import { previewOnPlainClick, useFileAccess } from './fileAccess';
import type { CapturedSessionReference, NativeJob, NativeRunRecovery, OutputRate, Run, RunMetrics } from '@contracts';
import { Collapse } from '@/components/ui/collapse';
import { Spinner } from '@/components/ui/controls';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { copyWithToast, downloadProjectFile, projectFileUrl } from '@/lib/files';
import { formatDuration } from '@/lib/format-duration';
import { useNow } from '@/lib/use-now';
import { formatNumber } from '@/lib/i18n/format';
import { cleanLabel, cn, formatBytes, formatDateTime, isRecord, pixelEdge, str } from '@/lib/utils';
import { CopyButton } from '@/components/ui/copy-button';
import { CODE_PADDING, CODE_TEXT } from './codeSurface';
import { Markdown } from './Markdown';
import { lineDiff } from './lineDiff';
import { inQueue, nativeTaskOutcome, sendPhase } from './delivery';
import { canRestoreUnsentRun, type ReasoningChannel, type TimelineItem, type UserAttachment } from './model';
import { activeToolStates, currentToolActivity, stripRoot, toolAction, toolDetail, toolDiffStats, toolView, type ToolView } from './toolView';
import { promptFromTranscript, SubagentContext, specificSubagentLabel, useNativeJob, useSubagentRunning, useSubagentTranscript } from './subagents';
import { ActivityContext, BackgroundTaskMetadata, BackgroundTaskOutcome, BackgroundTaskStatus, RowOutcome, StopButton } from './Activities';
import { formatTokensPerSecond, outputRateDescription, outputTokensPerSecond, tokensPerSecond } from './speed';
import { MessageAttachments } from './MessageAttachments';
import { MarkedIndicator, MarkMenuItem, markBodies, type MarkTarget } from './marks';
import { useAnswerShare } from '../marks/ShareImage';
import { RememberedScope, useRemembered } from './rememberedState';
import { FailureDetails } from './FailureDetails';
import { reasoningPreview } from '../../../../../packages/timeline/src/findText';
import { SessionReferences } from './SessionReferences';

export const toolIcons: Record<string, typeof IconWrench> = {
  read: IconFileText, edit: IconFilePenLine, delete: IconTrash2, move: IconArrowRightLeft, search: IconSearch,
  execute: IconSquareTerminal, think: IconBrain, fetch: IconGlobe, switch_mode: IconRepeat, agent: IconBot, question: IconMessageCircleQuestion,
  plan: IconListChecks,
};

/**
 * What a prompt says about its delivery. A turn stopped after the prompt arrived is the turn's
 * outcome, not the prompt's: `stopShown` false leaves 已停止 to the row that ends the turn.
 */
export function nativeDeliveryLabel(run: Run, stopShown = true): string {
  if (!run.native) return '';
  const native = run.native;
  const received = Boolean(native.nativeMessageId || native.timings?.observedAt || native.timings?.providerAcceptedAt) || native.delivery === 'observed' || native.stage === 'provider_failed' || native.stage === 'turn_outcome_unknown';
  switch (native.delivery) {
    case 'queued': return native.stage === 'http_pending' || native.intent === 'steer' ? i18n._(msg`发送中`) : i18n._(msg`排队中`);
    case 'preparing': return native.stage === 'resuming' ? i18n._(msg`恢复中`) : i18n._(msg`发送中`);
    case 'dispatching': return i18n._(msg`发送中`);
    case 'input_sent': return received || run.state === 'completed' ? '' : i18n._(msg`发送中`);
    case 'observed': return '';
    case 'uncertain': return received ? i18n._(msg`暂时无法获取任务状态`) : i18n._(msg`暂时无法确认是否已发送`);
    case 'failed': return received ? i18n._(msg`任务失败`) : i18n._(msg`发送失败`);
    case 'cancelled': return native.stage === 'acknowledged' ? received ? i18n._(msg`暂时无法获取任务状态`) : i18n._(msg`暂时无法确认是否已发送`) : native.stage === 'turn_outcome_unknown' ? i18n._(msg`暂时无法获取任务状态`) : native.nativeMessageId || run.state === 'interrupted' ? stopShown ? i18n._(msg`已停止`) : '' : i18n._(msg`已取消`);
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
export function AnswerActions({ text, runId, onTurnAction, mark, at }: { text?: string; runId?: string; onTurnAction?: (action: TurnAction, runId: string) => void; mark?: MarkTarget; at?: string }) {
  const { t } = useLingui();
  const bringBack = useContext(AnswerBringBackContext);
  const share = useAnswerShare(text, at ?? mark?.at);
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
 * (the copy button there is already that tall), so a queued message gaining 停止并发送 / 取消 and
 * losing them once it is sent changes what the row says, never its height. The actions stay inside
 * that height: a target reaching past it would overlap the next action when the row wraps.
 */
const statusRow = 'min-h-lh no-hover:min-h-11';
const statusAction = 'no-hover:min-h-11';

export const UserMessage = memo(function UserMessage({ stopShown = true, text, attachments, references, recipientSessionId, onOpenSession, time, footerPinned, run, failureShown = false, runActionPending, onOpenTerminal, onRetryNativeRun, onCancelNativeRun, onCheckNativeRun, onContinueNativeRun, nativeRecoveries, onSendQueuedNow, onRestoreNativeRun }: {
  /** The turn stopped with nothing after this prompt, so the prompt is where 已停止 is told. */
  stopShown?: boolean;
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
  onSendQueuedNow?: (run: Run) => void;
  onRestoreNativeRun?: (run: Run) => void;
}) {
  const { t } = useLingui();
  const resources = useTranscriptResources();
  const taskOutcome = run ? nativeTaskOutcome(run) : undefined;
  const delivery = run?.native && !taskOutcome && !failureShown ? nativeDeliveryLabel(run, stopShown) : '';
  const rest = useRestReveal();
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
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex max-w-[min(82%,560px)] items-start gap-1">
        <div className="min-w-0 whitespace-pre-wrap break-words rounded-3xl bg-bubble px-4 py-2.5 text-base text-fg">{text}</div>
      </div>
      <MessageAttachments attachments={attachments} />
      {recipientSessionId && !resources && <SessionReferences references={references ?? run?.native?.contextSnapshots} recipientSessionId={recipientSessionId} onOpenSession={onOpenSession} />}
      {(text || time || delivery) && (
        <div data-slot="message-meta" {...rest} className={cn('flex max-w-[82%] cursor-default select-none flex-wrap items-center justify-end gap-x-2 gap-y-1 px-1 text-2xs text-fg-3 transition-opacity', statusRow, !footerPinned && !delivery && !resources && revealOnOwnHover)}>
          {run?.native?.intent === 'steer' && <span className="inline-flex items-center gap-1"><IconCornerUpRight aria-hidden className="size-3" /><Trans>补充</Trans></span>}
          {delivery && (deliveryError ? <button type="button" aria-expanded={errorOpen} onClick={() => setErrorOpen(!errorOpen)} className={cn(statusAction, 'inline-flex items-center gap-0.5 text-fg-3 hover:text-fg')}>{delivery}<IconChevronRight aria-hidden className={cn('size-3 transition-transform', errorOpen && 'rotate-90')} /></button> : <span role="status" className="min-w-0 [overflow-wrap:anywhere]">{delivery}</span>)}
          {!taskOutcome && openTerminal}
          {run?.native?.delivery === 'uncertain' && run.native.stage === 'http_unknown' && onRetryNativeRun && <button type="button" disabled={runActionPending} onClick={() => onRetryNativeRun(run)} className={cn(statusAction, 'text-fg-3 underline underline-offset-2 hover:text-fg disabled:opacity-50')}><Trans>重试发送</Trans></button>}
          {!taskOutcome && needsCheck && run && onCheckNativeRun && <button type="button" disabled={runActionPending} onClick={() => onCheckNativeRun(run)} className={cn(statusAction, 'text-fg-3 underline underline-offset-2 hover:text-fg disabled:opacity-50')}><Trans>检查状态</Trans></button>}
          {!taskOutcome && continueAction}
          {run && inQueue(run) && onSendQueuedNow && <button type="button" disabled={runActionPending} title={t`停止并发送`} onClick={() => onSendQueuedNow(run)} className={cn(statusAction, 'text-fg-3 underline underline-offset-2 hover:text-fg disabled:opacity-50')}><Trans>停止并发送</Trans></button>}
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
export const AssistantMessage = memo(function AssistantMessage({ text, showActions, streaming, time, footerPinned, metrics, runId, onTurnAction, mark, progress, chapters = false, stopped = false }: {
  text: string; showActions: boolean; stopped?: boolean; streaming?: boolean; time?: string; metrics?: RunMetrics; runId?: string; onTurnAction?: (action: TurnAction, runId: string) => void; mark?: MarkTarget;
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
      <div ref={markBody} data-mark-ids={mark?.ids.join(' ')} data-chapter-body={chapters && !resources ? '' : undefined} className="min-w-0"><Markdown text={text} streaming={streaming} chapters={chapters && !resources} /></div>
      <MessageFooter text={text} showActions={showActions} time={time} stopped={stopped} footerPinned={footerPinned} metrics={metrics} runId={runId} onTurnAction={onTurnAction} mark={mark} progress={progress} />
    </div>
  );
});

/** The same turn actions and timestamp belong under an answer or the result that ended it. */
export function MessageFooter({ text, showActions, time, footerPinned, metrics, runId, onTurnAction, mark, progress, stopped = false }: {
  text?: string; showActions: boolean; time?: string; footerPinned?: boolean;
  /** The answer ends a stopped turn: 已停止 leads the time and keeps the line on screen. */
  stopped?: boolean; metrics?: RunMetrics;
  runId?: string; onTurnAction?: (action: TurnAction, runId: string) => void; mark?: MarkTarget; progress?: ReactNode;
}) {
  const { t } = useLingui();
  const resources = useTranscriptResources();
  const rate = tokensPerSecond(metrics);
  const rest = useRestReveal();
  if (!showActions && !time && progress === undefined) return null;
  return <div data-slot="message-meta" {...rest} className={cn('turn-footer -ml-1.5 flex min-h-9 cursor-default select-none flex-wrap items-center gap-1 transition-opacity can-hover:-ml-5.5 no-hover:min-h-11', (showActions || time) && !footerPinned && !stopped && !resources && revealOnOwnHover)}>
    {!showActions && !time && progress && <div className="ml-1.5 min-w-0">{progress}</div>}
    {showActions && <AnswerActions text={text} runId={runId} onTurnAction={onTurnAction} mark={mark} {...(time ? { at: time } : {})} />}
    <MarkedIndicator target={mark} />
    {stopped && <span role="status" className="shrink-0 px-1 text-2xs text-fg-3">{t`已停止`}</span>}
    {time && <time dateTime={time} className="shrink-0 px-1 text-2xs tabular-nums text-fg-3">{formatDateTime(time)}</time>}
    {time && metrics && rate !== undefined && (
      <span className={cn('shrink-0 px-1 text-2xs tabular-nums', metrics.tokens === 'provider' ? 'text-fg-3' : 'text-fg-4')}>
        {metrics.tokens === 'provider' ? '' : '~'}{formatTokensPerSecond(rate)} tok/s
      </span>
    )}
  </div>;
}

export function Disclosure({ icon, title, detail, inline, status, open, onToggle, children, expandable = true, tone, opensPage, touchCompact = false }: {
  icon: ReactNode; title: ReactNode; detail?: ReactNode;
  /** Content that belongs with the title (a tool's diff counts): after the detail, ahead of the chevron. The row's state stays in `status`, at the right edge. */
  inline?: ReactNode;
  status?: ReactNode; open: boolean; onToggle: () => void; children?: ReactNode; expandable?: boolean; tone?: 'danger';
  /** The row leads to its own page (a subagent's transcript) instead of folding out. */
  opensPage?: boolean;
  touchCompact?: boolean;
}) {
  if (opensPage) {
    return (
      <button
        type="button"
        data-slot="disclosure"
        onClick={onToggle}
        className={cn('group/row flex min-h-[calc(24px*var(--text-scale))] w-full min-w-0 items-center gap-2 rounded-md text-left text-sm text-fg-3 transition-colors hover:text-fg-2', touchCompact ? 'no-hover:min-h-9' : 'no-hover:min-h-11', tone === 'danger' && 'text-danger hover:text-danger')}
      >
        <span className="grid size-4 shrink-0 place-items-center text-fg-4 [&_svg]:size-[15px]">{icon}</span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn('min-w-0 truncate', detail && 'max-w-[70%] shrink-0')}>{title}</span>
            {detail && <span className="min-w-0 truncate font-mono text-xs text-fg-3">{detail}</span>}
          </span>
          {inline}
          <IconChevronRight className="size-3.5 shrink-0 text-fg-4 transition-[opacity,transform] duration-[var(--duration-base)] can-hover:opacity-0 can-hover:group-hover/row:translate-x-0.5 can-hover:group-hover/row:opacity-100" />
        </span>
        {status && <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">{status}</span>}
      </button>
    );
  }
  const Header = expandable ? 'button' : 'div';
  return (
    <div className="flex min-w-0 flex-col">
      <Header
        {...(expandable ? { type: 'button' as const, 'aria-expanded': open, onClick: onToggle } : {})}
        data-slot="disclosure"
        className={cn('group/row flex min-h-[calc(24px*var(--text-scale))] min-w-0 items-center gap-2 rounded-md text-left text-sm text-fg-3 transition-colors', touchCompact ? 'no-hover:min-h-9' : 'no-hover:min-h-11', expandable && 'hover:text-fg-2', tone === 'danger' && 'text-danger hover:text-danger')}
      >
        {/* On a pointer device the leading icon swaps to the chevron on hover, which keeps an idle
            row down to one glyph. A touch screen never reaches that state, so there the chevron is
            permanent instead — and it follows the content (title, detail, inline counts) rather
            than pinning to the right edge, the way the Mac row's hover chevron does. The row's
            state in `status` keeps the right edge. */}
        <span className="relative grid size-4 shrink-0 place-items-center [&_svg]:size-[15px]">
          <span className={cn('grid place-items-center text-fg-4 transition-opacity', expandable && 'can-hover:group-hover/row:opacity-0', open && expandable && 'can-hover:opacity-0')}>{icon}</span>
          {expandable && <IconChevronRight className={cn('absolute hidden opacity-0 transition-[opacity,transform] duration-[var(--duration-base)] ease-out-soft can-hover:block group-hover/row:opacity-100', open && 'rotate-90 opacity-100')} />}
        </span>
        {/* Budget text after the fixed icon and status, then share that space with the chevron.
            A title's 70% cap must use this remainder, not the width of the whole row. */}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn('min-w-0 truncate', detail && 'max-w-[70%] shrink-0')}>{title}</span>
            {detail && <span className="min-w-0 truncate font-mono text-xs text-fg-3">{detail}</span>}
          </span>
          {inline}
          {expandable && <IconChevronRight className={cn('hidden size-3.5 shrink-0 text-fg-4 transition-transform duration-[var(--duration-base)] ease-out-soft no-hover:block', open && 'rotate-90')} />}
        </span>
        {status && <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">{status}</span>}
      </Header>
      {expandable && children && (
        <Collapse open={open}>
          <div className="ml-2 mt-0.5 mb-1.5 flex min-w-0 flex-col gap-2 edge-l pl-4 pt-0.5">{children}</div>
        </Collapse>
      )}
    </div>
  );
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
  if (channel === 'narration') return <Markdown text={text} className="md-muted" streaming={running} />;
  return (
    // The brain icon already says what this row is, so the preview itself is the title — and it
    // reads as prose rather than as the bold label the other collapsed rows use for a tool name.
    // Folded, the preview is one line; opened, the body says it in full under a plain title.
    <Disclosure icon={<IconBrain />} title={open ? <Trans>思考</Trans> : <span className={cn(running && 'text-shimmer')}>{reasoningPreview(text, running)}</span>} open={open} onToggle={() => setOpen(!open)}>
      <Markdown text={text} className="md-muted md-thought" streaming={running} />
    </Disclosure>
  );
});

const CLIP_EDGE_LINES = 200;
const CLIP_EDGE_CHARS = 40_000;

/**
 * The head and tail of an output too long to lay out whole. The box only shows a few hundred
 * pixels of it anyway, and a log of tens of thousands of lines costs the whole transcript its
 * layout; the middle stays one click away.
 */
function clipOutput(text: string): { head: string; tail: string; hiddenLines: number } | undefined {
  let lines = 1;
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lines += 1;
  if (lines > CLIP_EDGE_LINES * 2 + 50) {
    let headEnd = 0;
    for (let count = 0; count < CLIP_EDGE_LINES; count += 1) headEnd = text.indexOf('\n', headEnd) + 1;
    let tailStart = text.length;
    for (let count = 0; count < CLIP_EDGE_LINES; count += 1) tailStart = text.lastIndexOf('\n', tailStart - 1);
    const head = text.slice(0, headEnd).slice(0, CLIP_EDGE_CHARS);
    const tail = text.slice(tailStart + 1).slice(-CLIP_EDGE_CHARS);
    return { head, tail, hiddenLines: lines - CLIP_EDGE_LINES * 2 };
  }
  if (text.length > CLIP_EDGE_CHARS * 2 + 10_000) return { head: text.slice(0, CLIP_EDGE_CHARS), tail: text.slice(-CLIP_EDGE_CHARS), hiddenLines: 0 };
  return undefined;
}

/**
 * [copy] is the whole text the block stands for, offered from its corner: an output too long to lay
 * out shows only its ends, and a command block starts with a prompt sign that is not the command.
 * [remember] names the block's expansion within its row, so two blocks in one row need two names.
 */
export function CodeBlock({ children, className, maxHeight = 'max-h-72', copy, remember = 'code' }: { children: ReactNode; className?: string; maxHeight?: string; copy?: string; remember?: string }) {
  const { t } = useLingui();
  const [full, setFull] = useRemembered(`${remember}:full`, false);
  const clip = useMemo(() => (typeof children === 'string' ? clipOutput(children) : undefined), [children]);
  // The copy button keeps a corner of its own rather than covering the end of the first line.
  const pre = cn('overflow-auto rounded-lg bg-subtle text-fg-2 whitespace-pre-wrap break-words', CODE_PADDING, CODE_TEXT, copy && 'pr-9 no-hover:min-h-11 no-hover:pr-12', maxHeight, className);
  const block = !clip || full ? <pre className={pre}>{children}</pre> : (
    <pre className={pre}>
      {clip.head}
      <button type="button" onClick={() => setFull(true)} className="my-1 block rounded-md bg-hover px-2 py-0.5 font-sans text-2xs text-fg-3 hover:text-fg-2 no-hover:min-h-11">
        {clip.hiddenLines > 0 ? t`省略 ${formatNumber(clip.hiddenLines)} 行 · 展开全部` : t`中间部分已省略 · 展开全部`}
      </button>
      {clip.tail}
    </pre>
  );
  if (!copy) return block;
  return (
    <div className="group/codeblock relative min-w-0">
      {block}
      <CopyButton text={copy} className="absolute right-1 top-1 opacity-0 group-hover/codeblock:opacity-100 focus-visible:opacity-100 no-hover:right-0 no-hover:top-0 no-hover:opacity-100" />
    </div>
  );
}

const DIFF_ROW: Record<'same' | 'add' | 'del', { row: string; gutter: string; sign: string }> = {
  same: { row: '', gutter: 'text-fg-4', sign: 'text-fg-4' },
  add: { row: 'bg-[var(--diff-add)]', gutter: 'bg-[var(--diff-add-gutter)] text-[var(--diff-add-marker)]', sign: 'text-[var(--diff-add-marker)]' },
  del: { row: 'bg-[var(--diff-del)]', gutter: 'bg-[var(--diff-del-gutter)] text-[var(--diff-del-marker)]', sign: 'text-[var(--diff-del-marker)]' },
};

/**
 * Rows a diff card lays out before it folds the rest. The card scrolls inside a few hundred pixels,
 * and a rewrite of a long file would otherwise mount every row into the transcript at once.
 */
const DIFF_PREVIEW_LINES = 300;

export function DiffView({ path, nameOnly, before, after, lineOffset, newLineOffset, trailingLines, onOpenPath, onOpenInEditor, outside, remember = 'diff' }: { path?: string; /** The row above already spells the path out; the card names the file alone. */ nameOnly?: boolean; before: string; after: string; lineOffset?: number; newLineOffset?: number; trailingLines?: number; onOpenPath?: (path: string) => void; onOpenInEditor?: (path: string) => void; outside?: boolean; remember?: string }) {
  const { t } = useLingui();
  const resources = useTranscriptResources();
  const canOpen = !resources || Boolean(path && resources.resources[path]);
  const diff = useMemo(() => lineDiff(before, after, 3, lineOffset, trailingLines, newLineOffset ?? lineOffset), [before, after, lineOffset, newLineOffset, trailingLines]);
  const [expanded, setExpanded] = useRemembered(`${remember}:all`, false);
  const hiddenLines = diff && !expanded ? Math.max(0, diff.lines.length - DIFF_PREVIEW_LINES) : 0;
  const shownLines = diff ? (hiddenLines ? diff.lines.slice(0, DIFF_PREVIEW_LINES) : diff.lines) : [];
  // Prose is read, not scanned by column: its lines run to a paragraph each, so they fold instead of scrolling sideways.
  const wrap = Boolean(path && /\.(md|mdx|markdown|txt|rst)$/i.test(path));
  // A file that did not exist has no old line numbers to show.
  const created = !before;
  const stats = (diff || created) && (
    <span className="ml-1 flex shrink-0 items-center gap-1.5 font-mono tabular-nums">
      {created && <span className="font-sans text-fg-3"><Trans>新文件</Trans></span>}
      {diff && diff.added > 0 && <span className="text-[var(--diff-add-marker)]">+{diff.added}</span>}
      {diff && diff.removed > 0 && <span className="text-[var(--diff-del-marker)]">−{diff.removed}</span>}
    </span>
  );
  return (
    <div className="overflow-hidden rounded-lg bg-subtle">
      <div className="flex min-h-8 items-center gap-2 edge-b bg-subtle px-3 text-xs no-hover:min-h-11">
        {path ? (
          <span className="group/diffpath flex min-w-0 flex-1 items-center gap-1 max-md:flex-wrap">
            <PathLink path={path} canOpen={canOpen} onOpenPath={onOpenPath} className="flex min-h-8 min-w-0 items-center font-mono text-fg-2 max-md:w-full max-md:text-left no-hover:min-h-11" title={canOpen ? outside ? t`项目目录之外，只读预览 ${path}` : t`在右侧预览 ${path}` : path}><PathText path={nameOnly ? path.slice(path.lastIndexOf('/') + 1) : path} /></PathLink>
            {stats}
            <CopyButton text={path} label={t`复制路径`} className={cn(pathActionClass, 'opacity-0 group-hover/diffpath:opacity-100')} />
            <FileDownloadButton path={path} className="opacity-0 group-hover/diffpath:opacity-100" />
            {onOpenInEditor && <PathEditButton onClick={() => onOpenInEditor(path)} className="opacity-0 group-hover/diffpath:opacity-100 focus-visible:opacity-100" />}
          </span>
        ) : <span className="flex items-center gap-1 text-fg-3"><Trans>文件变更</Trans>{stats}</span>}
      </div>
      {diff ? (
        <div className="max-h-80 overflow-auto py-1 font-mono text-xs leading-[18px]">
          {/* One box as wide as the longest line, so every row's tint runs the full scroll width. */}
          <div className={wrap ? undefined : 'w-max min-w-full'}>
            {shownLines.map((line, index) => line.type === 'gap' ? (
              <div key={index} className="my-0.5 bg-subtle px-3 py-0.5 font-sans text-2xs text-fg-3">{line.text}</div>
            ) : (
              <div key={index} className={cn('flex', DIFF_ROW[line.type].row)}>
                <span className={cn('sticky left-0 flex shrink-0 select-none', line.type === 'same' ? 'bg-subtle' : DIFF_ROW[line.type].row)}>
                  {!created && <span className={cn('w-9 shrink-0 pr-2 text-right', DIFF_ROW[line.type].gutter)}>{line.type === 'add' ? '' : line.oldNo}</span>}
                  <span className={cn('w-9 shrink-0 pr-2 text-right', DIFF_ROW[line.type].gutter)}>{line.type === 'del' ? '' : line.newNo}</span>
                  <span className={cn('w-5 shrink-0 text-center', DIFF_ROW[line.type].sign)}>{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}</span>
                </span>
                <span className={cn('pr-4', wrap ? 'min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre', line.type === 'same' ? 'text-fg-2' : 'text-fg')}>{line.text || ' '}</span>
              </div>
            ))}
          </div>
          {hiddenLines > 0 && (
            <button type="button" onClick={() => setExpanded(true)} className="mx-3 my-1 block rounded-md bg-hover px-2 py-0.5 font-sans text-2xs text-fg-3 hover:text-fg-2 no-hover:min-h-11">
              {t`省略 ${formatNumber(hiddenLines)} 行 · 展开全部`}
            </button>
          )}
        </div>
      ) : <CodeBlock className="rounded-none border-0" maxHeight="max-h-80" copy={after} remember={`${remember}:file`}>{after}</CodeBlock>}
    </div>
  );
}

/**
 * A path set so the file it names is never the part that gets cut: the directory steps back and
 * gives up its tail when the row is short.
 */
function PathText({ path }: { path: string }) {
  const slash = path.lastIndexOf('/');
  if (slash <= 0) return <span className="min-w-0 truncate">{path}</span>;
  return <><span className="min-w-0 truncate text-fg-4">{path.slice(0, slash)}</span><span className="shrink-0 text-fg-4">/</span><span className="max-w-full shrink-0 truncate">{path.slice(slash + 1)}</span></>;
}

/**
 * A path in a tool row. In a project it links to the file itself, so a plain click previews it on the
 * right and a modified or middle click opens it in a tab; a shared transcript keeps a plain button.
 */
function PathLink({ path, line, canOpen = true, onOpenPath, className, quiet = false, title, children }: {
  path: string; line?: number | undefined; canOpen?: boolean;
  onOpenPath?: ((path: string, line?: number) => void) | undefined;
  className: string; quiet?: boolean; title?: string; children: ReactNode;
}) {
  const files = useFileAccess();
  const resources = useTranscriptResources();
  if (files && !resources && onOpenPath) {
    return <a href={projectFileUrl(files.projectId, path)} target="_blank" rel="noopener" onClick={previewOnPlainClick(onOpenPath, path, line)} className={cn(className, quiet ? 'hover:text-fg-2' : 'hover:text-accent')} title={title}>{children}</a>;
  }
  return <button type="button" disabled={!canOpen} onClick={() => onOpenPath?.(path, line)} className={cn(className, quiet ? 'enabled:hover:text-fg-2' : 'enabled:hover:text-accent', 'disabled:cursor-text')} title={title}>{children}</button>;
}

/** Copy, download and open-in-editor beside a path: one size, one colour. */
const pathActionClass = 'grid size-5 shrink-0 place-items-center rounded-md px-0 text-fg-3 transition-colors hover:bg-hover hover:text-fg focus-visible:opacity-100 no-hover:size-11 no-hover:opacity-100 [&_svg]:size-3.5';

function FileDownloadButton({ path, className }: { path: string; className?: string }) {
  const { t } = useLingui();
  const files = useFileAccess();
  const resources = useTranscriptResources();
  const resource = resources?.resources[path];
  if (resources) return resource ? <a href={resource.url} download={resource.name} aria-label={t`下载文件`} title={t`下载文件`} className={cn(pathActionClass, className)}><IconDownload /></a> : null;
  if (!files) return null;
  return (
    <button
      type="button"
      aria-label={t`下载文件`}
      title={t`下载文件`}
      onClick={() => downloadProjectFile(files.projectId, path)}
      className={cn(pathActionClass, className)}
    >
      <IconDownload />
    </button>
  );
}

function PathEditButton({ onClick, className }: { onClick: () => void; className?: string }) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      aria-label={t`在编辑器中打开`}
      title={t`在编辑器中打开`}
      onClick={onClick}
      className={cn(pathActionClass, className)}
    >
      <IconSquareArrowOutUpRight />
    </button>
  );
}

/**
 * `stripRoot` rewrites in-project absolute paths to project-relative ones, so an absolute
 * path that survived means the file lives outside the project. Those are still previewable
 * (single file, read-only — see the `allowOutsideRead` setting), so they only get a hint.
 */
function isOutsideProject(path: string, root?: string): boolean {
  return Boolean(root) && path.startsWith('/');
}

function LocationChip({ path, line, outside, onOpenPath, onOpenInEditor }: {
  path: string; line?: number; outside: boolean;
  onOpenPath?: ((path: string, line?: number) => void) | undefined;
  onOpenInEditor?: ((path: string, line?: number) => void) | undefined;
}) {
  const { t } = useLingui();
  const label = `${path}${line ? `:${line}` : ''}`;
  const resources = useTranscriptResources();
  const canOpen = !resources || Boolean(resources.resources[path]);
  return (
    <span className="group/loc inline-flex min-h-6 max-w-full items-center gap-0.5 rounded-md bg-muted pl-2 pr-1 font-mono text-2xs text-fg-2 max-md:flex-wrap no-hover:min-h-11">
      <PathLink path={path} line={line} canOpen={canOpen} onOpenPath={onOpenPath} className="inline-flex min-h-6 min-w-0 items-center gap-1 max-md:w-full no-hover:min-h-11" title={canOpen ? outside ? t`项目目录之外，只读预览 ${path}` : t`在右侧预览 ${path}` : path}>
        <IconFileText className="size-3 shrink-0" /><span className="truncate">{label}</span>
      </PathLink>
      <CopyButton text={path} label={t`复制路径`} className={cn(pathActionClass, 'opacity-0 group-hover/loc:opacity-100')} />
      <FileDownloadButton path={path} className="opacity-0 group-hover/loc:opacity-100" />
      {onOpenInEditor && <PathEditButton onClick={() => onOpenInEditor(path, line)} className="opacity-0 group-hover/loc:opacity-100" />}
    </span>
  );
}

/** Tool images name a file the server can read, or carry small inline bytes; larger inline images are left out upstream. */
function ToolImage({ content, root, maxHeight }: { content: Record<string, unknown>; root?: string; maxHeight?: number }) {
  const { t } = useLingui();
  const imageSource = useImageSource();
  const path = str(content.path);
  const name = str(content.name);
  const mimeType = str(content.mimeType);
  const data = str(content.data);
  const bytes = typeof content.bytes === 'number' ? content.bytes : undefined;
  const width = pixelEdge(content.width);
  const height = pixelEdge(content.height);
  const src = path ? imageSource(path) : data && mimeType?.startsWith('image/') ? `data:${mimeType};base64,${data}` : undefined;
  const label = name ?? (path ? stripRoot(path, root) : undefined);
  if (src) return <ZoomableImage src={src} name={name ?? (path ? path.split('/').pop() || path : t`工具返回的图片`)} {...(label ? { label } : {})} {...(path ? { path } : {})} {...(width && height ? { size: { width, height } } : {})} {...(maxHeight ? { maxHeight } : {})} placeholder="large" />;
  if (!path && content.omitted !== true) return null;
  // An image left out upstream still says which one it was and how big: `图片未在此展示 · wk-hero.png · 820×520 · 196 KB`.
  const parts = [name ?? label, width && height ? `${width}×${height}` : undefined, bytes && bytes > 0 ? formatBytes(bytes) : undefined].filter(Boolean);
  const text = path ? t`图片 · ${label}` : parts.length ? t`图片未在此展示 · ${parts.join(' · ')}` : t`工具返回了一张图片，未在此展示`;
  return (
    <div className="flex items-center gap-1.5 text-xs text-fg-3">
      <IconImage className="size-3.5 shrink-0" />
      <span className="truncate">{text}</span>
    </div>
  );
}

export function ToolContents({ view, onOpenPath, onOpenInEditor, root }: { view: ToolView; onOpenPath?: (path: string, line?: number) => void; onOpenInEditor?: (path: string, line?: number) => void; root?: string }) {
  const { t } = useLingui();
  return toolContents(view, t`、`, root, onOpenPath, onOpenInEditor);
}

/** Build the body once; a null body means there is nothing for the row to disclose. */
function toolContents(view: ToolView, listSeparator: string, root?: string, onOpenPath?: (path: string, line?: number) => void, onOpenInEditor?: (path: string, line?: number) => void) {
  const soleDiff = view.contents.filter(item => item.type === 'diff').length === 1;
  const blocks = view.contents.map((item, index) => {
    if (item.type === 'question_answer' && typeof item.question === 'string' && Array.isArray(item.answers)) {
      const answers = item.answers.filter((answer): answer is string => typeof answer === 'string');
      const options = Array.isArray(item.options) ? item.options.filter((option): option is string => typeof option === 'string') : [];
      return <div key={index} className="space-y-1 text-sm"><div className="text-fg-3">{item.question}</div>{options.length > 0 && <div className="text-xs text-fg-3"><Trans>选项：{options.join(listSeparator)}</Trans></div>}<div className="whitespace-pre-wrap text-fg">{answers.join(listSeparator) || <Trans>已跳过</Trans>}</div></div>;
    }
    const diffPath = str(item.path) ? stripRoot(str(item.path)!, root) : undefined;
    if (item.type === 'diff') return <DiffView key={index} remember={`diff:${index}`} path={diffPath} nameOnly={soleDiff} outside={diffPath ? isOutsideProject(diffPath, root) : false} before={typeof item.oldText === 'string' ? item.oldText : ''} after={String(item.newText ?? '')} {...(typeof item.lineOffset === 'number' ? { lineOffset: item.lineOffset } : {})} {...(typeof item.newLineOffset === 'number' ? { newLineOffset: item.newLineOffset } : {})} {...(typeof item.trailingLines === 'number' ? { trailingLines: item.trailingLines } : {})} onOpenPath={(path) => onOpenPath?.(path)} {...(onOpenInEditor ? { onOpenInEditor: (path: string) => onOpenInEditor(path) } : {})} />;
    if (item.type === 'terminal') return <div key={index} className="text-xs text-fg-3"><Trans>终端输出 · {String(item.terminalId ?? '')}</Trans></div>;
    // Prose a tool wrote for the reader (a plan body, for one) is Markdown, not output to
    // read as a code block — at a few thousand characters the difference decides whether it is read.
    if (item.type === 'markdown' && typeof item.text === 'string' && item.text.trim()) return <Markdown key={index} text={item.text} />;
    const content = isRecord(item.content) ? item.content : undefined;
    if (content?.type === 'text' && typeof content.text === 'string' && content.text.trim()) return <CodeBlock key={index} copy={content.text} remember={`output:${index}`}>{content.text}</CodeBlock>;
    if (content?.type === 'image' && (str(content.path) || content.omitted === true || str(content.data) && str(content.mimeType)?.startsWith('image/'))) return <ToolImage key={index} content={content} root={root} />;
    return null;
  }).filter(Boolean);
  const diffPaths = new Set(view.contents.flatMap(item => item.type === 'diff' && str(item.path) ? [stripRoot(str(item.path)!, root)] : []));
  const locations = view.locations.filter(location => !diffPaths.has(stripRoot(location.path, root)));
  if (!blocks.length && !view.command && !locations.length) return null;
  return (
    <>
      {view.command && <CodeBlock className="text-fg" copy={view.command} remember="command"><span className="select-none text-fg-4">$ </span>{view.command}</CodeBlock>}
      {locations.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {locations.map((location, index) => (
            <LocationChip key={index} path={location.path} line={location.line} outside={isOutsideProject(location.path, root)} onOpenPath={onOpenPath} onOpenInEditor={onOpenInEditor} />
          ))}
        </div>
      )}
      {blocks}
    </>
  );
}

/**
 * A background shell job. The CLI starts these with `block_until_ms: 0` and streams their output to
 * a log of its own, so the row is driven by the job's live state rather than by the tool call's:
 * it keeps ticking after the turn that started it, and it is the same one row whether or not the
 * agent ever awaited it.
 */
export function JobRow({ job, onOpenPath, more }: { job: NativeJob; onOpenPath?: (path: string, line?: number) => void; more?: ReactNode }) {
  const { t } = useLingui();
  const [open, setOpen] = useRemembered('job', false);
  const resources = useTranscriptResources();
  const running = job.status === 'running' && !resources;
  const failed = job.status === 'failed';
  const unknown = job.status === 'unknown' || Boolean(resources && job.status === 'running');
  const now = useNow(running && Boolean(job.startedAt));
  const startedAt = job.startedAt ? Date.parse(job.startedAt) : Number.NaN;
  const elapsedMs = Math.max(job.runningMs ?? 0, Number.isFinite(startedAt) && running ? now - startedAt : 0);
  const elapsed = elapsedMs < 1000 ? undefined : formatDuration(elapsedMs);
  return (
    <Disclosure
      touchCompact
      icon={running ? <Spinner className="size-3.5" /> : <IconSquareTerminal />}
      title={<span className="truncate">{job.title}</span>}
      inline={failed ? <RowOutcome failed /> : unknown ? <RowOutcome /> : undefined}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      {job.title.trim() !== job.command.trim() && <p className="whitespace-pre-wrap break-words text-sm text-fg-2">{job.title}</p>}
      {job.command && <CodeBlock className="text-fg" copy={job.command} remember="command"><span className="select-none text-fg-4">$ </span>{job.command}</CodeBlock>}
      {job.output ? <CodeBlock maxHeight="max-h-96" copy={job.output} remember="job">{job.output}</CodeBlock> : <span className="text-xs text-fg-3">{running ? t`还没有输出…` : t`没有输出`}</span>}
      <div className="flex flex-wrap items-center gap-2">
        {job.startedAt && <time dateTime={job.startedAt} className="text-2xs tabular-nums text-fg-3">{formatDateTime(job.startedAt)}</time>}
        {elapsed && <span className="text-2xs tabular-nums text-fg-3">{elapsed}</span>}
        {job.id && <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-2xs text-fg-3">shell {job.id}</span>}
        {job.exitCode !== undefined && job.exitCode !== 0 && <span className="text-2xs tabular-nums text-fg-3">exit {job.exitCode}</span>}
        {job.matched && <span className="min-w-0 truncate font-mono text-2xs text-fg-3"><Trans>匹配 {job.matched}</Trans></span>}
        {job.truncated && <span className="text-2xs text-fg-3"><Trans>输出过大，只显示末尾</Trans></span>}
        {job.outputPath && onOpenPath && <PathLink path={job.outputPath} onOpenPath={onOpenPath} className="text-xs text-fg-3 no-hover:min-h-11" quiet><Trans>查看完整日志</Trans></PathLink>}
      </div>
      {more}
    </Disclosure>
  );
}

export const ToolRow = memo(function ToolRow({ item, onOpenPath, onOpenInEditor, root, stale, more }: { item: Extract<TimelineItem, { kind: 'tool' }>; onOpenPath?: (path: string, line?: number) => void; onOpenInEditor?: (path: string, line?: number) => void; root?: string; stale?: boolean; more?: ReactNode }) {
  const toolCallId = typeof item.event.data.toolCallId === 'string' ? item.event.data.toolCallId : '';
  const liveJob = useNativeJob(toolCallId);
  const job = liveJob ?? item.job;
  if (job) return <JobRow job={job} onOpenPath={onOpenPath} more={more} />;
  return <RegularToolRow item={item} onOpenPath={onOpenPath} onOpenInEditor={onOpenInEditor} root={root} stale={stale} more={more} />;
});

const RegularToolRow = memo(function RegularToolRow({ item, onOpenPath, onOpenInEditor, root, stale, more }: { item: Extract<TimelineItem, { kind: 'tool' }>; onOpenPath?: (path: string, line?: number) => void; onOpenInEditor?: (path: string, line?: number) => void; root?: string; stale?: boolean; more?: ReactNode }) {
  const { t } = useLingui();
  const view = useMemo(() => toolView(item.event, root), [item.event, root]);
  const subagent = view.kind === 'agent' && isRecord(item.event.data.subagent) ? item.event.data.subagent : undefined;
  // Every agent call can have a transcript: some backends send no `subagent` record, and a Task
  // whose description was generic still has its own first prompt to be named by.
  const agentCall = view.kind === 'agent';
  const subagentTranscript = useSubagentTranscript(agentCall ? view.id : '');
  // A subagent's own state outranks its tool call's: a backgrounded Task answers at once and keeps
  // working, and a foreground one can finish before the turn that waits on it does.
  const subagentRunning = useSubagentRunning(agentCall ? view.id : '');
  const progress = item.subagent;
  const active = activeToolStates.has(view.status);
  // A tool can be left pending/in_progress when its turn ends on a transport error: the agent
  // streams the failure as plain message text and never sends a terminal tool_call_update, so
  // the run completes with the tool still open. With nothing running any more it will never
  // finish, so say so instead of spinning forever.
  const running = progress?.running ?? subagentRunning ?? (active && !stale);
  const dangling = active && Boolean(stale) && !running && !progress?.status;
  const failed = progress?.status ? progress.status === 'failed' : !running && view.status === 'failed';
  const [open, setOpen] = useRemembered('tool', false);
  const subagents = useContext(SubagentContext);
  const Icon = toolIcons[view.kind] ?? IconWrench;
  // Compare whitespace-normalized: a multi-line command's title is collapsed, so an exact string
  // compare would leave the collapsed title AND the raw command in the row — the same text twice.
  const isCommand = Boolean(view.command) && cleanLabel(view.title) === cleanLabel(view.command!);
  const detail = agentCall ? specificSubagentLabel(str(subagent?.type) ?? subagentTranscript?.subagentType) : toolDetail(view);
  const title = agentCall
    ? specificSubagentLabel(str(subagent?.description))
      || specificSubagentLabel(progress?.title)
      || specificSubagentLabel(subagentTranscript?.title)
      || specificSubagentLabel(promptFromTranscript(subagentTranscript?.events ?? []))
      || specificSubagentLabel(subagentTranscript?.subagentType)
      || specificSubagentLabel(view.title)
      || t`子 Agent`
    : view.title;
  const controls = useContext(ActivityContext);
  const activity = currentToolActivity(item);
  const backgroundTask = activity?.kind === 'background_task';
  const taskTitle = backgroundTask ? activity.title || title : title;
  const taskView = backgroundTask && !view.command && activity.task?.command ? { ...view, command: activity.task.command } : view;
  const taskIsCommand = backgroundTask ? Boolean(taskView.command && cleanLabel(taskTitle) === cleanLabel(taskView.command)) : isCommand;
  const activityStopping = activity?.status === 'stopping' || Boolean(activity && controls?.stopping.has(activity.id));
  const stats = useMemo(() => toolDiffStats(view), [view]);
  const images = failed ? [] : view.contents.flatMap(entry => isRecord(entry.content) && entry.content.type === 'image' ? [entry.content] : []);
  // Every agent call leads to its own transcript page, the way the aside's subagent rows do —
  // even when the backend sent no `subagent` record to identify it by.
  const opensPage = Boolean(subagents && agentCall);
  const contents = toolContents(taskView, t`、`, root, onOpenPath, onOpenInEditor);
  const expandable = Boolean(contents || backgroundTask || more);
  // A call reads in one type, whatever its title: a command, `Read` and its path, a compound title.
  // Only a path's directory steps back, so the file it names stands out.
  const action = agentCall || backgroundTask || taskIsCommand ? undefined : toolAction(view);
  const mono = !agentCall && (!backgroundTask || taskIsCommand);
  const row = (
    <Disclosure
      touchCompact
      opensPage={opensPage}
      expandable={expandable}
      icon={running ? <Spinner className="size-3.5" /> : <Icon />}
      title={mono ? <span className="font-mono text-xs">{action ? action.verb : taskTitle}</span> : taskTitle}
      detail={backgroundTask ? undefined : action ? action.path ? <span className="flex min-w-0"><PathText path={action.object} /></span> : action.object : detail}
      inline={activity ? <BackgroundTaskOutcome activity={activity} /> : failed ? <RowOutcome failed /> : dangling ? <RowOutcome /> : !backgroundTask && !failed && stats ? (
        <span className="flex max-w-[50%] shrink-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-xs tabular-nums [overflow-wrap:anywhere]">
          {stats.files > 1 && <span className="font-sans text-fg-3"><Trans>{stats.files} 个文件</Trans></span>}
          {stats.added > 0 && <span className="text-[var(--diff-add-marker)]">+{stats.added}</span>}
          {stats.removed > 0 && <span className="text-[var(--diff-del-marker)]">−{stats.removed}</span>}
        </span>
      ) : undefined}
      status={activity ? <BackgroundTaskStatus activity={activity} /> : undefined}
      open={open}
      onToggle={() => opensPage ? subagents!.open({ toolCallId: view.id, running, event: item.event }) : setOpen(!open)}
    >
      {backgroundTask && <>
        {!taskIsCommand && <p className="whitespace-pre-wrap break-words text-sm text-fg-2">{taskTitle}</p>}
        <BackgroundTaskMetadata activity={activity} fallbackStart={item.event.createdAt} />
      </>}
      {contents}
      {more}
    </Disclosure>
  );
  const controlled = activity?.status === 'running' && !activityStopping
    ? <div className="flex min-w-0 items-start gap-1"><div className="min-w-0 flex-1">{row}</div><StopButton activity={activity} /></div>
    : row;
  if (backgroundTask || !images.length || open) return controlled;
  return (
    <div className="flex min-w-0 flex-col">
      {controlled}
      <div className="mb-1.5 ml-6 flex min-w-0 flex-wrap gap-2">
        {images.map((content, index) => <ToolImage key={index} content={content} root={root} maxHeight={192} />)}
      </div>
    </div>
  );
});

// motion-loop: the step in progress turns; the global reduced-motion rule stops it
const planIcon = (status: unknown) => status === 'completed' ? <IconCircleCheck className="size-4 text-success" /> : status === 'cancelled' ? <IconX className="size-4 text-fg-4" /> : status === 'in_progress' ? <IconCircleDashed className="size-4 animate-[spin_3s_linear_infinite] text-accent" /> : <IconCircle className="size-4 text-fg-4" />;

export function PlanList({ entries }: { entries: Record<string, unknown>[] }) {
  const { t } = useLingui();
  return (
    <ul className="flex flex-col gap-1.5">
      {entries.map((entry, index) => (
        <li key={String(entry.id ?? index)} className="flex min-w-0 items-start gap-2 text-sm">
          <span className="mt-0.5 shrink-0">{planIcon(entry.status)}</span>
          <span className={cn('min-w-0 flex-1 text-fg [overflow-wrap:anywhere]', (entry.status === 'completed' || entry.status === 'cancelled') && 'text-fg-3 line-through decoration-fg-4')}>{String(entry.content ?? entry.title ?? t`任务 ${index + 1}`)}</span>
        </li>
      ))}
    </ul>
  );
}

export const PlanBlock = memo(function PlanBlock({ entries }: { entries: Record<string, unknown>[] }) {
  const { t } = useLingui();
  if (!entries.length) return null;
  const done = entries.filter((entry) => entry.status === 'completed').length;
  return (
    <div className="rounded-xl bg-subtle px-4 py-3">
      <div className="mb-2.5 flex items-center gap-2 text-sm">
        <IconListTodo className="size-4 text-fg-3" />
        <span className="font-medium text-fg">{t`待办`}</span>
        <span className="text-fg-3">{done}/{entries.length}</span>
        <div className="ml-auto h-1 w-20 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-success transition-[width]" style={{ width: `${entries.length ? (done / entries.length) * 100 : 0}%` }} /></div>
      </div>
      <PlanList entries={entries} />
    </div>
  );
});

export const StatusRow = memo(function StatusRow({ tone, text, detail, reveal, footer }: { tone: 'danger' | 'muted'; text: string; detail?: string; reveal?: number; footer?: ReactNode }) {
  return (
    <div className="group/message flex min-w-0 flex-col gap-2.5">
      <FailureDetails text={text} detail={detail} reveal={reveal}
        className={cn('text-sm', tone === 'danger' ? 'text-danger' : 'text-fg-3')}
        leading={tone === 'danger' ? <IconCircleAlert className="size-3.5" /> : <IconX className="size-3.5" />}
      />
      {footer}
    </div>
  );
});

/** Each trigger keeps its own task row; an aggregate heading would repeat its state and time. */
export const TurnTriggerBlock = memo(function TurnTriggerBlock({ notices }: { notices: Extract<TimelineItem, { kind: 'task_notification' }>[] }) {
  return <section className="flex flex-col gap-1.5">{notices.map((notice) => <NoticeItem key={notice.key} notice={notice} />)}</section>;
});

/** One notice of several in a row: findable by its own key, and remembering its own state. */
function NoticeItem({ notice }: { notice: Extract<TimelineItem, { kind: 'task_notification' }> }) {
  return <div data-item-key={notice.key} className="min-w-0"><RememberedScope.Provider value={notice.key}><TaskNotificationRow item={notice} /></RememberedScope.Provider></div>;
}

/** A notice's own numbers, in the same compact shape the subagent list uses. */
const compactTokens = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M`
  : value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
    : String(Math.round(value));
/** Under ten seconds a tenth still says something; past that it is the transcript's one duration shape. */
export const compactDuration = (ms: number) => ms > 0 && ms < 10_000 ? `${(ms / 1_000).toFixed(1)}s` : formatDuration(ms);

export const TaskNotificationRow = memo(function TaskNotificationRow({ item }: { item: Extract<TimelineItem, { kind: 'task_notification' }> }) {
  const { t } = useLingui();
  const [open, setOpen] = useRemembered('notice', false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useRemembered('notice-diagnostics', false);
  const subagents = useContext(SubagentContext);
  const subagent = item.taskKind === 'subagent';
  const running = item.status === 'running';
  const duration = item.jobResult?.runningMs ?? item.durationMs;
  // A notice about a subagent can lead to that subagent's own transcript, which is where the process
  // behind the result lives; the result text itself stays readable in the expansion.
  const openSubagent = subagent && item.subagentToolCallId && subagents
    ? () => subagents.open({ toolCallId: item.subagentToolCallId! })
    : undefined;
  const titleIsCommand = Boolean(item.command && item.title.trim() === item.command.trim());
  const title = item.title || item.command || (subagent ? t`子 Agent` : t`后台任务`);
  const Icon = subagent ? IconBot : IconSquareTerminal;
  return (
    <Disclosure
      icon={running ? <Spinner className="size-3.5" /> : <Icon />}
      title={<span className={cn('min-w-0 text-fg-2', open ? 'whitespace-normal break-words' : 'truncate', titleIsCommand && 'font-mono text-xs')}>{title}</span>}
      inline={item.status === 'failed' ? <RowOutcome failed /> : item.status === 'unknown' ? <RowOutcome /> : undefined}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <time dateTime={item.event.createdAt} className="text-2xs tabular-nums text-fg-3">{formatDateTime(item.event.createdAt)}</time>
      {item.command && <CodeBlock className="text-fg" copy={item.command} remember="command"><span className="select-none text-fg-4">$ </span>{item.command}</CodeBlock>}
      {item.detail && (subagent ? <Markdown text={item.detail} /> : <CodeBlock copy={item.detail} remember="detail">{item.detail}</CodeBlock>)}
      {(item.jobResult || duration !== undefined || item.tokens !== undefined || openSubagent) && (
        <div className="flex flex-wrap items-center gap-2 text-2xs text-fg-3">
          {item.jobResult?.exitCode !== undefined && <span className="tabular-nums"><Trans>退出码 {item.jobResult.exitCode}</Trans></span>}
          {duration !== undefined && duration > 0 && <span className="tabular-nums">{compactDuration(duration)}</span>}
          {item.tokens !== undefined && <span className="tabular-nums">{compactTokens(item.tokens)} tok</span>}
          {openSubagent && (
            <button type="button" onClick={openSubagent} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-fg-2 transition-colors hover:bg-hover hover:text-fg no-hover:min-h-11">
              <IconBot className="size-3" /><Trans>查看子 Agent 对话</Trans>
            </button>
          )}
        </div>
      )}
      {(item.taskId || item.sourceStatus) && <Disclosure
        icon={<IconWrench className="size-3.5" />}
        title={t`诊断信息`}
        open={diagnosticsOpen}
        onToggle={() => setDiagnosticsOpen(!diagnosticsOpen)}
      >
        {item.taskId && <CodeBlock copy={item.taskId} remember="task-id"><Trans>任务 ID：{item.taskId}</Trans></CodeBlock>}
        {item.sourceStatus && <span className="text-xs text-fg-3"><Trans>CLI 状态：{item.sourceStatus}</Trans></span>}
      </Disclosure>}
    </Disclosure>
  );
});

export const ImageBlock = memo(function ImageBlock({ src }: { src: string }) {
  const { t } = useLingui();
  const resources = useTranscriptResources();
  const source = resources ? resources.resources[src]?.url ?? (/^(?:https?:|data:image\/)/i.test(src) ? src : undefined) : src;
  if (!source) return <span className="text-xs text-fg-3"><Trans>图片不可用</Trans></span>;
  return <ZoomableImage src={source} name={t`Agent 附加的图片`} maxHeight={448} className="rounded-xl" placeholder="large" />;
});

/** Split out so only the label re-renders each second, and only when there is a start to count from. */
function ElapsedSince({ startedAt }: { startedAt: number }) {
  const elapsed = useNow() - startedAt;
  // The slot holds a minute's worth (`59s`) and exists from the start, so the clock growing
  // (and the first second passing) does not move the rate beside it.
  return <span className="min-w-[3ch] text-xs tabular-nums text-fg-3">{elapsed >= 1000 ? formatDuration(elapsed) : null}</span>;
}

/**
 * `startedAt` (epoch ms) is when the run in progress began; without it no elapsed time is shown.
 * `outputRate` is the server's rolling wall-clock output window for this session.
 */
export function WorkingIndicator({ startedAt, outputRate, connected = true, label }: { startedAt?: number; outputRate?: OutputRate; connected?: boolean; label?: string }) {
  const { t } = useLingui();
  const shownLabel = label ?? t`正在处理`;
  const rate = outputTokensPerSecond(outputRate, connected);
  const estimated = outputRate?.tokens === 'estimated' || outputRate?.tokens === 'mixed';
  return (
    // The clock and the rate tick every second; `aria-live="off"` keeps a screen reader from
    // reading them out each time while the status itself is still announced once.
    <div role="status" className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {/* motion-loop: liveness dot while the run is working */}
      <span className="grid size-4 shrink-0 place-items-center"><span className="size-2 rounded-full bg-accent animate-pulse-dot" /></span>
      <span className="text-shimmer font-medium">{shownLabel}</span>
      {startedAt !== undefined && Number.isFinite(startedAt) && <span aria-live="off" className="contents"><ElapsedSince startedAt={startedAt} /></span>}
      {rate !== undefined && outputRate && (
        // An estimate is dimmed and marked `~`, so it never reads as a measurement even in a screenshot.
        <span aria-live="off" title={outputRateDescription(outputRate)} className={cn('text-xs tabular-nums', estimated ? 'text-fg-4' : 'text-fg-3')}>
          {estimated ? '~' : ''}{formatTokensPerSecond(rate)} tok/s
        </span>
      )}
    </div>
  );
}
