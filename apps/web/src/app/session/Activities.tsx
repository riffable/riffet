import { useTranscriptResources } from './transcriptResources';
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { NativeActivity } from '@contracts';
import { IconBot, IconCompress, IconEye, IconRepeat, IconSquare, IconSquareTerminal, IconTerminal } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/controls';
import { api, HttpError } from '@/lib/api';
import { confirmDialog } from '@/lib/dialogs';
import { formatNumber } from '@/lib/i18n/format';
import { toast } from '@/lib/toast';
import { useNow } from '@/lib/use-now';
import { cn, formatDateTime } from '@/lib/utils';
import { CodeBlock, compactDuration, Disclosure } from './Timeline';
import { useRemembered } from './rememberedState';
import type { TimelineItem } from './model';
import { taskLabel } from './toolView';

type ActivityItem = Extract<TimelineItem, { kind: 'activity' }>;

/**
 * What an activity row needs from its session: which activities the reader has asked to stop (shown
 * as 停止中 until the server's own states say otherwise) and the request itself.
 */
export interface ActivityControls {
  sessionId: string;
  stopping: ReadonlySet<string>;
  stop: (activity: NativeActivity) => void;
}
export const ActivityContext = createContext<ActivityControls | undefined>(undefined);

const noneStopping: ReadonlySet<string> = new Set();
/** How long the optimistic 停止中 mark outlives its request when the server never says anything. */
const STOPPING_MARK_MS = 30_000;

/**
 * Stopping is a request: the row turns to 停止中 at once and only the activity's later states (the
 * server's, from the CLI's own evidence) decide the outcome. A failed request takes the mark back and
 * says so quietly. A stop with `via: 'session'` ends every background task of the conversation, so it
 * asks first and marks all of them. A mark the server never answers lapses after `STOPPING_MARK_MS`,
 * so a stop that went nowhere does not leave the row stuck on 停止中.
 */
export function useActivityControls(sessionId: string, running: () => NativeActivity[]): ActivityControls {
  const { t } = useLingui();
  const [stopping, setStopping] = useState<ReadonlySet<string>>(noneStopping);
  const timers = useRef(new Set<number>());
  useEffect(() => {
    setStopping(noneStopping);
    const held = timers.current;
    return () => { held.forEach((timer) => window.clearTimeout(timer)); held.clear(); };
  }, [sessionId]);
  const latest = useRef(running);
  latest.current = running;
  const stop = useCallback(async (activity: NativeActivity) => {
    const all = activity.stop?.via === 'session';
    if (all && !await confirmDialog({
      title: t`停止全部后台任务？`,
      description: t`将停止全部后台任务：这个会话不能单独停止其中一个。`,
      confirmLabel: t`停止全部`,
      destructive: true,
    })) return;
    const ids = new Set([activity.id, ...(all ? latest.current().filter((item) => item.stop?.via === 'session').map((item) => item.id) : [])]);
    setStopping((held) => new Set([...held, ...ids]));
    const lapse = window.setTimeout(() => {
      timers.current.delete(lapse);
      setStopping((held) => new Set([...held].filter((id) => !ids.has(id))));
    }, STOPPING_MARK_MS);
    timers.current.add(lapse);
    try {
      await api.stopNativeActivity(sessionId, activity.id);
    } catch (error) {
      setStopping((held) => new Set([...held].filter((id) => !ids.has(id))));
      toast.error(t`停止失败：${error instanceof HttpError || error instanceof Error ? error.message : t`请求未完成`}`);
    }
  }, [sessionId]);
  return useMemo(() => ({ sessionId, stopping, stop: (activity) => void stop(activity) }), [sessionId, stopping, stop]);
}

/** Compact context sizes in the active locale: `43.5万` in Chinese, `43.5K` in English. */
export function compactCount(value: number): string {
  if (value >= 10_000) return formatNumber(value, { notation: 'compact', maximumFractionDigits: 1 });
  return formatNumber(Math.round(value));
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

function startOf(activity: NativeActivity, fallback: string): number {
  const at = Date.parse(activity.startedAt ?? fallback);
  return Number.isFinite(at) ? at : Number.NaN;
}

/** How long it took once it is over, or `undefined` when nothing says. */
function finishedMs(activity: NativeActivity, fallbackStart: string): number | undefined {
  if (typeof activity.durationMs === 'number' && Number.isFinite(activity.durationMs)) return activity.durationMs;
  const span = Date.parse(activity.endedAt ?? '') - startOf(activity, fallbackStart);
  return Number.isFinite(span) && span >= 0 ? span : undefined;
}

/** Counts up while the activity runs; split out so only this label re-renders each second. */
function Elapsed({ since }: { since: number }) {
  const elapsed = useNow() - since;
  return Number.isFinite(elapsed) ? <span className="tabular-nums">{clock(elapsed)}</span> : null;
}

const taskKinds: Record<string, { label: MessageDescriptor; Icon: typeof IconSquareTerminal }> = {
  shell: { label: msg`后台命令`, Icon: IconSquareTerminal },
  terminal: { label: msg`终端任务`, Icon: IconSquareTerminal },
  monitor: { label: msg`监控`, Icon: IconEye },
  agent: { label: msg`后台 Agent`, Icon: IconBot },
  workflow: { label: msg`工作流`, Icon: IconRepeat },
};

/** Only show a stop button when it applies to this task. */
export function StopButton({ activity, className }: { activity: NativeActivity; className?: string }) {
  const { t } = useLingui();
  const controls = useContext(ActivityContext);
  if (!controls || !activity.stop || activity.stop.via === 'session') return null;
  const label = t`停止任务`;
  return (
    <Button size="xs" variant="quiet" aria-label={label} title={label} onClick={() => controls.stop(activity)} className={cn('h-7 shrink-0 gap-1 px-1.5 font-normal no-hover:h-11', className)}>
      <IconSquare className="size-3 fill-current" />
      <span>{t`停止`}</span>
    </Button>
  );
}

/** The state to show: the server's, except that a stop the reader asked for reads as stopping first. */
function effectiveStatus(activity: NativeActivity, stopping: ReadonlySet<string>): NativeActivity['status'] {
  return activity.status === 'running' && stopping.has(activity.id) ? 'stopping' : activity.status;
}

/**
 * A task's state on its row, shared by a standalone activity and the tool row that carries it. The
 * row's end holds only what is live and the reader's doing: a stop under way. Running needs no
 * word (the icon spins), a settled task none either; the expansion keeps its clock and exit code.
 */
export function BackgroundTaskStatus({ activity, status: reported }: { activity: NativeActivity; status?: NativeActivity['status'] }) {
  const controls = useContext(ActivityContext);
  const status = reported ?? effectiveStatus(activity, controls?.stopping ?? noneStopping);
  return status === 'stopping' ? <span className="text-xs text-fg-4"><Trans>停止中</Trans></span> : null;
}

/** What went wrong, after the title: a failed task, or one whose state never arrived. */
export function BackgroundTaskOutcome({ activity, status: reported }: { activity: NativeActivity; status?: NativeActivity['status'] }) {
  const controls = useContext(ActivityContext);
  const status = reported ?? effectiveStatus(activity, controls?.stopping ?? noneStopping);
  const exitCode = activity.task?.exitCode;
  if (status === 'failed' || (status === 'completed' && exitCode !== undefined && exitCode !== 0)) return <RowOutcome failed />;
  return status === 'unknown' ? <RowOutcome /> : null;
}

/** The one word a row adds after its title when it did not end well. */
export function RowOutcome({ failed = false }: { failed?: boolean }) {
  return <span className={cn('shrink-0 text-xs', failed ? 'text-danger' : 'text-fg-4')}>{failed ? <Trans>失败</Trans> : <Trans>未完成</Trans>}</span>;
}

/** Task metadata belongs in the expansion, shared by standalone activities and their tool rows. */
export function BackgroundTaskMetadata({ activity, status: reported, fallbackStart }: { activity: NativeActivity; status?: NativeActivity['status']; fallbackStart: string }) {
  const controls = useContext(ActivityContext);
  const status = reported ?? effectiveStatus(activity, controls?.stopping ?? noneStopping);
  const live = status === 'running' || status === 'stopping';
  const time = activity.endedAt || activity.startedAt || fallbackStart;
  const since = startOf(activity, fallbackStart);
  const duration = finishedMs(activity, fallbackStart);
  const exitCode = activity.task?.exitCode;
  return <div className="flex flex-wrap items-center gap-2 text-2xs tabular-nums text-fg-3">
    {time && <time dateTime={time}>{formatDateTime(time)}</time>}
    {live && Number.isFinite(since) && <Elapsed since={since} />}
    {!live && duration !== undefined && duration >= 1000 && <span>{compactDuration(duration)}</span>}
    {exitCode !== undefined && !live && <span>exit {exitCode}</span>}
  </div>;
}

/** Full text on request: the preview stays until the reader asks, and a failed fetch can be retried. */
function Details({ activity }: { activity: NativeActivity }) {
  const { t } = useLingui();
  const sessionId = useContext(ActivityContext)?.sessionId;
  const resources = useTranscriptResources();
  const frozenText = activity.blobRef ? resources?.blobs[activity.blobRef] : undefined;
  const blobRef = !resources && sessionId ? activity.blobRef : undefined;
  const [state, setState] = useState<{ phase: 'idle' | 'loading' | 'failed' } | { phase: 'done'; text: string }>({ phase: 'idle' });
  const aborter = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => aborter.current?.abort(), []);
  useEffect(() => { aborter.current?.abort(); setState({ phase: 'idle' }); }, [sessionId, blobRef]);
  const load = () => {
    aborter.current?.abort();
    const controller = new AbortController();
    aborter.current = controller;
    setState({ phase: 'loading' });
    api.sessionBlob(sessionId!, blobRef!, controller.signal).then(
      (text) => { if (!controller.signal.aborted) setState({ phase: 'done', text }); },
      () => { if (!controller.signal.aborted) setState({ phase: 'failed' }); },
    );
  };
  if (frozenText !== undefined) return <CodeBlock maxHeight="max-h-96" copy={frozenText}>{frozenText}</CodeBlock>;
  if (state.phase === 'done') return <CodeBlock maxHeight="max-h-96" copy={state.text}>{state.text}</CodeBlock>;
  return (
    <>
      {activity.detail && <CodeBlock copy={activity.detail}>{activity.detail}</CodeBlock>}
      {blobRef && (state.phase === 'loading'
        ? <span className="flex items-center gap-1.5 text-xs text-fg-3"><Spinner /><Trans>正在加载全文…</Trans></span>
        : (
          <div className="flex items-center gap-2 text-xs">
            {state.phase === 'failed' && <span className="text-danger"><Trans>全文加载失败</Trans></span>}
            <button type="button" onClick={load} className="rounded-md px-1.5 py-0.5 text-fg-3 transition-colors hover:bg-hover hover:text-fg-2 no-hover:min-h-11">{state.phase === 'failed' ? <Trans>重试</Trans> : <Trans>查看全文</Trans>}</button>
          </div>
        ))}
    </>
  );
}

function CompactionRow({ item, status }: { item: ActivityItem; status: NativeActivity['status'] }) {
  const { t } = useLingui();
  const { activity } = item;
  const [open, setOpen] = useRemembered('activity', false);
  if (status === 'running' || status === 'stopping') {
    const since = startOf(activity, item.event.createdAt);
    return (
      <div role="status" className="flex h-7 min-w-0 items-center gap-2 text-sm text-fg-3 no-hover:h-9">
        <span className="grid size-4 shrink-0 place-items-center"><Spinner className="size-3.5" /></span>
        <span className="text-shimmer font-medium"><Trans>正在压缩上下文</Trans></span>
        {Number.isFinite(since) && <span aria-live="off" className="text-xs">· <Elapsed since={since} /></span>}
      </div>
    );
  }
  const { preTokens, postTokens } = activity.compaction ?? {};
  const duration = finishedMs(activity, item.event.createdAt);
  const parts = [
    preTokens !== undefined && postTokens !== undefined ? `${compactCount(preTokens)} → ${compactCount(postTokens)}`
      : postTokens !== undefined ? t`压缩后 ${compactCount(postTokens)}` : preTokens !== undefined ? t`压缩前 ${compactCount(preTokens)}` : undefined,
    duration !== undefined ? compactDuration(duration) : undefined,
  ].filter(Boolean);
  const failed = status === 'failed';
  const headline = failed ? t`上下文压缩失败` : status === 'stopped' ? t`上下文压缩已中止` : status === 'unknown' ? t`上下文压缩` : t`上下文已压缩`;
  return (
    <Disclosure
      icon={<IconCompress />}
      title={<span className="flex min-w-0 items-center gap-1.5"><span className="shrink-0">{headline}</span>{parts.length > 0 && <span className="min-w-0 truncate font-normal text-fg-3">· {parts.join(' · ')}</span>}</span>}
      tone={failed ? 'danger' : undefined}
      open={open}
      onToggle={() => setOpen(!open)}
      expandable={Boolean(activity.detail || activity.blobRef)}
    >
      <Details activity={activity} />
    </Disclosure>
  );
}

function BackgroundTaskRow({ item, status, root }: { item: ActivityItem; status: NativeActivity['status']; root?: string }) {
  const { activity } = item;
  const [open, setOpen] = useRemembered('activity', false);
  const running = status === 'running';
  const stopping = status === 'stopping';
  const live = running || stopping;
  const kind = taskKinds[activity.task?.kind ?? 'shell'];
  const command = activity.task?.command;
  const label = taskLabel(activity.title, command, root);
  const title = label?.text ?? i18n._(kind.label);
  return (
    <div className="flex min-w-0 items-start gap-1">
      <div className="min-w-0 flex-1">
        <Disclosure
          icon={live ? <Spinner className="size-3.5" /> : <kind.Icon />}
          title={<span className={cn('min-w-0 truncate text-fg-2', label?.mono && 'font-mono text-xs')}>{title}</span>}
          inline={<BackgroundTaskOutcome activity={activity} status={status} />}
          status={<BackgroundTaskStatus activity={activity} status={status} />}
          open={open}
          onToggle={() => setOpen(!open)}
        >
          {label && !label.mono && <p className="whitespace-pre-wrap break-words text-sm text-fg-2">{title}</p>}
          <BackgroundTaskMetadata activity={activity} status={status} fallbackStart={item.event.createdAt} />
          {command && <CodeBlock className="text-fg" copy={command} remember="command"><span className="select-none text-fg-4">$ </span>{command}</CodeBlock>}
          <Details activity={activity} />
        </Disclosure>
      </div>
      {running && <StopButton activity={activity} />}
    </div>
  );
}

/** A `!cmd` the reader ran in Claude Code: the command as the title, the tail of its output under it until opened. */
function ShellCommandRow({ activity, status }: { activity: NativeActivity; status: NativeActivity['status'] }) {
  const [open, setOpen] = useRemembered('activity', false);
  const running = status === 'running';
  const command = activity.task?.command?.split(/\r?\n/, 1)[0] ?? '';
  const tail = !running && !open && activity.detail?.trim() ? activity.detail.replace(/\s+$/, '').split('\n').slice(-6).join('\n') : '';
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Disclosure
        icon={running ? <Spinner className="size-3.5" /> : <IconSquareTerminal />}
        title={<span className="min-w-0 truncate font-mono text-xs text-fg-2"><span className="select-none text-fg-4">! </span>{command}</span>}
        inline={status === 'unknown' ? <RowOutcome /> : null}
        open={open}
        onToggle={() => setOpen(!open)}
        expandable={Boolean(activity.detail || activity.blobRef)}
      >
        <Details activity={activity} />
      </Disclosure>
      {tail && <div className="ml-6 min-w-0"><CodeBlock>{tail}</CodeBlock></div>}
    </div>
  );
}

function LocalCommandRow({ activity }: { activity: NativeActivity }) {
  const name = activity.command?.name;
  const text = activity.detail || (name ? '' : activity.title);
  return (
    <div className="flex min-w-0 items-start gap-2 py-0.5 text-xs text-fg-3">
      <span className="mt-[2px] grid size-4 shrink-0 place-items-center"><IconTerminal className="size-3.5" /></span>
      <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] line-clamp-3">
        {name && <span className="mr-1.5 font-mono text-fg-2">/{name}</span>}
        {text}
      </span>
    </div>
  );
}

/** One system activity in the transcript. It is not a message: no bubble, no author, no turn header. */
export const ActivityRow = memo(function ActivityRow({ item, root }: { item: ActivityItem; root?: string }) {
  const controls = useContext(ActivityContext);
  const resources = useTranscriptResources();
  const live = effectiveStatus(item.activity, controls?.stopping ?? noneStopping);
  const status = resources && (live === 'running' || live === 'stopping') ? 'unknown' : live;
  if (item.activity.kind === 'compaction') return <CompactionRow item={item} status={status} />;
  if (item.activity.kind === 'background_task') return <BackgroundTaskRow item={item} status={status} root={root} />;
  if (item.activity.kind === 'local_command' && item.activity.task?.command) return <ShellCommandRow activity={item.activity} status={status} />;
  return <LocalCommandRow activity={item.activity} />;
});

/** Whether the transcript already shows a compaction in progress, so the working line need not repeat it. */
export function showsRunningCompaction(timeline: readonly TimelineItem[]): boolean {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index]!;
    if (item.kind === 'activity' && item.activity.kind === 'compaction') return item.activity.status === 'running' || item.activity.status === 'stopping';
  }
  return false;
}

/** The background tasks still going, oldest first, for the session's 子任务 lists. */
export function liveBackgroundActivities(timeline: readonly TimelineItem[]): NativeActivity[] {
  const live: NativeActivity[] = [];
  for (const item of timeline) {
    if (item.kind === 'activity' && item.activity.kind === 'background_task' && (item.activity.status === 'running' || item.activity.status === 'stopping')) live.push(item.activity);
  }
  return live;
}

/** A running background task among the session's subagents and jobs, with its stop button. */
export function BackgroundTaskItem({ activity, root }: { activity: NativeActivity; root?: string }) {
  const { t } = useLingui();
  const controls = useContext(ActivityContext);
  const status = effectiveStatus(activity, controls?.stopping ?? noneStopping);
  const kind = taskKinds[activity.task?.kind ?? 'shell'];
  const since = startOf(activity, '');
  const label = taskLabel(activity.title, activity.task?.command, root);
  const name = label?.text ?? i18n._(kind.label);
  return (
    <li className="flex min-h-7 min-w-0 items-center gap-2.5 px-2 text-sm no-hover:min-h-11" title={activity.task?.command || name}>
      <span className="grid size-3.5 shrink-0 place-items-center"><Spinner className="size-3.5" /></span>
      <span className={cn('min-w-0 flex-1 truncate text-fg-2', label?.mono && 'font-mono text-xs')}>{name}</span>
      {status === 'stopping' ? <span className="shrink-0 text-2xs text-fg-4">{t`停止中`}</span> : Number.isFinite(since) && <span className="shrink-0 text-2xs text-fg-4"><Elapsed since={since} /></span>}
      {status === 'running' && <StopButton activity={activity} className="-mr-1.5 h-6 text-xs" />}
    </li>
  );
}
