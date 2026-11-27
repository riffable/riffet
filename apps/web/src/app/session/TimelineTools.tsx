import { memo, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  IconArrowRightLeft, IconArrowUp, IconBot, IconBrain, IconEye, IconFilePenLine, IconFileText, IconGitBranch,
  IconGlobe, IconImage, IconListChecks, IconMessageCircleQuestion, IconRepeat, IconSearch,
  IconSend, IconSquareTerminal, IconTrash2, IconWrench,
} from '@/components/icons';
import type { NativeJob } from '@contracts';
import { CopyButton } from '@/components/ui/copy-button';
import { Spinner } from '@/components/ui/controls';
import { formatDuration } from '@/lib/format-duration';
import { useNow } from '@/lib/use-now';
import { cn, formatBytes, formatDateTime, isRecord, pixelEdge, str } from '@/lib/utils';
import { ActivityContext, ActivityDetails, BackgroundTaskMetadata, BackgroundTaskOutcome, BackgroundTaskStatus, finishedMs, RowOutcome, StopButton, TaskLaunchContext } from './Activities';
import { useImageSource } from './imageSource';
import { alignmentCached } from './lineDiff';
import { Markdown } from './Markdown';
import { MarkSourceContext } from './marks';
import type { TimelineItem } from './model';
import { RememberedScope, useRemembered } from './rememberedState';
import { promptFromTranscript, specificSubagentLabel, SubagentContext, useNativeJob, useSubagentRunning, useSubagentTranscript } from './subagents';
import {
  CodeBlock, compactDuration, compactTokens, DiffView, Disclosure, FileDownloadButton,
  pathActionClass, PathEditButton, PathLink, ToolPathText,
} from './TimelineBlocks';
import { activeToolStates, currentToolActivity, describeJobRow, isCommandTitle, stripRoot, taskLabel, toolDiffStats, toolRowPresentation, toolView, type ToolRowPresentation, type ToolView } from './toolView';
import { useTranscriptResources } from './transcriptResources';
import { ZoomableImage } from './ImageViewer';

export const toolIcons: Record<string, typeof IconWrench> = {
  read: IconFileText, edit: IconFilePenLine, delete: IconTrash2, move: IconArrowRightLeft, search: IconSearch,
  execute: IconSquareTerminal, git: IconGitBranch, mcp: IconWrench, think: IconBrain, fetch: IconGlobe, switch_mode: IconRepeat, image: IconImage, agent: IconBot, message: IconSend, question: IconMessageCircleQuestion,
  plan: IconListChecks,
};

/**
 * `stripRoot` rewrites in-project absolute paths to project-relative ones, so an absolute
 * path that survived means the file lives outside the project. Those are still previewable
 * (single file, read-only — see the `allowOutsideRead` setting), so they only get a hint.
 */
function isOutsideProject(path: string, root?: string): boolean {
  return Boolean(root) && (path.startsWith('/') || path === '~' || path.startsWith('~/'));
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
  const uri = str(content.uri);
  const name = str(content.name);
  const mimeType = str(content.mimeType);
  const data = str(content.data);
  const bytes = typeof content.bytes === 'number' ? content.bytes : undefined;
  const width = pixelEdge(content.width);
  const height = pixelEdge(content.height);
  const src = path ? imageSource(path) : uri ? uri : data && mimeType?.startsWith('image/') ? `data:${mimeType};base64,${data}` : undefined;
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
    if (content?.type === 'image' && (str(content.path) || str(content.uri) || content.omitted === true || str(content.data) && str(content.mimeType)?.startsWith('image/'))) return <ToolImage key={index} content={content} root={root} />;
    return null;
  }).filter(Boolean);
  const diffPaths = new Set(view.contents.flatMap(item => item.type === 'diff' && str(item.path) ? [stripRoot(str(item.path)!, root)] : []));
  const locations = view.locations.filter(location => !diffPaths.has(stripRoot(location.path, root)));
  if (!blocks.length && !view.command && !locations.length) return null;
  const hasDiff = diffPaths.size > 0 || view.contents.some(item => item.type === 'diff');
  return (
    <>
      {view.command && <CodeBlock className="text-fg" maxHeight={hasDiff ? 'max-h-40' : 'max-h-72'} copy={view.command} remember="command"><span className="select-none text-fg-4">$ </span>{view.command}</CodeBlock>}
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
export function JobRow({ job, onOpenPath, root, more }: { job: NativeJob; onOpenPath?: (path: string, line?: number) => void; root?: string; more?: ReactNode }) {
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
  const presentation = useMemo(() => describeJobRow(job.title, job.command, root), [job.title, job.command, root]);
  const Icon = toolIcons[presentation.icon] ?? IconSquareTerminal;
  return (
    <Disclosure
      touchCompact
      failed={failed}
      icon={running ? <Spinner className="size-3.5" /> : <Icon className={cn(failed && 'text-danger')} />}
      title={<ToolVerbLabel verb={presentation.verb} />}
      detail={<ToolTargetSlot presentation={presentation} />}
      inline={<ToolMetaSlot presentation={presentation} failed={failed} dangling={unknown} />}
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
  if (job) return <JobRow job={job} onOpenPath={onOpenPath} root={root} more={more} />;
  return <RegularToolRow item={item} onOpenPath={onOpenPath} onOpenInEditor={onOpenInEditor} root={root} stale={stale} more={more} />;
});

/** Fixed-width monospace verb column (`Read`, `Edit`, `Search`, `Git`, `Run`, `Think`, …). */
export function ToolVerbLabel({ verb }: { verb: string }) {
  return <span className="inline-block min-w-12 font-mono text-xs font-medium text-fg-3">{verb}</span>;
}

/** Core object slot: left-dark primary (`fg-2`) + right-muted context/dir/arg (`fg-4`). */
export function ToolTargetSlot({ presentation, merged = false }: { presentation: ToolRowPresentation; merged?: boolean }) {
  const secondary = merged ? (presentation.mergedSecondary ?? presentation.secondary) : presentation.secondary;
  return (
    <>
      <span className={cn('flex min-w-0 items-center gap-1.5', secondary && 'max-w-full shrink-0')}>
        {presentation.prefix && <span className="shrink-0 font-mono text-xs text-fg-2">{presentation.prefix}</span>}
        {presentation.primaryKind === 'path' ? (
          <span className="flex min-w-0 font-mono text-xs text-fg-2"><ToolPathText path={presentation.primary} /></span>
        ) : presentation.primaryKind === 'prose' ? (
          <span className="min-w-0 truncate font-sans text-xs text-fg-2">{presentation.primary}</span>
        ) : (
          <span className="min-w-0 truncate font-mono text-xs text-fg-2">{presentation.primary}</span>
        )}
      </span>
      {secondary && <span className="min-w-0 truncate font-mono text-xs text-fg-4">{secondary}</span>}
    </>
  );
}

/** Lightweight metadata slot: line range/count, chained count, merged count, diff stats, or incomplete state. */
export function ToolMetaSlot({ presentation, stats, mergedCount, failed, dangling, outcome }: {
  presentation: ToolRowPresentation;
  stats?: ReturnType<typeof toolDiffStats>;
  mergedCount?: number;
  failed?: boolean;
  dangling?: boolean;
  outcome?: ReactNode;
}) {
  const isMerged = mergedCount !== undefined && mergedCount > 1;
  const lineRange = isMerged ? undefined : presentation.lineRange;
  const lineCount = isMerged ? undefined : presentation.lineCount;
  const hasStats = Boolean(!failed && stats && (stats.added > 0 || stats.removed > 0 || stats.files > 1));
  const showFileCount = Boolean(hasStats && stats && stats.files > 1 && !presentation.extraFiles);
  if (!lineRange && lineCount === undefined && !presentation.extraFiles && !presentation.extraCommands && !isMerged && !hasStats && !dangling && !outcome) {
    return undefined;
  }
  return (
    <span className="flex max-w-[50%] shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
      {lineRange && <span className="shrink-0 text-2xs text-fg-4">{lineRange}</span>}
      {lineCount !== undefined && <span className="shrink-0 text-2xs text-fg-4"><Trans>{lineCount} 行</Trans></span>}
      {presentation.extraFiles !== undefined && <span className="shrink-0 rounded-sm bg-subtle px-1.5 text-2xs text-fg-3">+{presentation.extraFiles}</span>}
      {presentation.extraCommands !== undefined && <span className="shrink-0 rounded-sm bg-subtle px-1.5 text-2xs text-fg-3">+{presentation.extraCommands}</span>}
      {isMerged && <span className="shrink-0 rounded-sm bg-subtle px-1.5 text-2xs text-fg-3">×{mergedCount}</span>}
      {hasStats && stats && (
        <span className="flex shrink-0 items-center gap-1.5">
          {showFileCount && <span className="font-sans text-xs text-fg-4"><Trans>{stats.files} 个文件</Trans></span>}
          {stats.added > 0 && <span className="text-[var(--diff-add-marker)]">+{stats.added}</span>}
          {stats.removed > 0 && <span className="text-[var(--diff-del-marker)]">−{stats.removed}</span>}
        </span>
      )}
      {outcome ?? (dangling ? <RowOutcome /> : null)}
    </span>
  );
}

/** Combine diff stats across multiple tool views without blocking the frame when uncached. */
function aggregateViewsDiffStats(views: readonly ToolView[]): ReturnType<typeof toolDiffStats> {
  let added = 0;
  let removed = 0;
  let unkeyedFiles = 0;
  const keyedFiles = new Set<string>();
  let any = false;
  for (const view of views) {
    const diffs = view.contents.filter(entry => entry.type === 'diff');
    if (!diffs.length) continue;
    const one = toolDiffStats(view);
    if (!one) continue;
    any = true;
    added += one.added;
    removed += one.removed;
    for (const diff of diffs) {
      const path = str(diff.path);
      if (path) keyedFiles.add(path);
      else unkeyedFiles += 1;
    }
  }
  return any ? { added, removed, files: keyedFiles.size + unkeyedFiles } : undefined;
}

/**
 * The +N −M across a list of tool views (a single row, a merged row, or a whole `ToolRun`).
 * Computes immediately when every diff alignment is already cached or one-sided, else in idle time.
 */
function useViewsDiffStats(views: readonly ToolView[]): ReturnType<typeof toolDiffStats> {
  const cheap = useMemo(() => {
    let hasDiff = false;
    for (const view of views) {
      for (const entry of view.contents) {
        if (entry.type !== 'diff') continue;
        hasDiff = true;
        if (entry.oldText && entry.newText && !alignmentCached(String(entry.oldText), String(entry.newText))) return null;
      }
    }
    return hasDiff ? aggregateViewsDiffStats(views) : undefined;
  }, [views]);
  const [late, setLate] = useState<ReturnType<typeof toolDiffStats>>();
  useEffect(() => {
    if (cheap !== null) return;
    const compute = () => setLate(aggregateViewsDiffStats(views));
    if (typeof requestIdleCallback !== 'function') { const timer = window.setTimeout(compute, 50); return () => window.clearTimeout(timer); }
    const handle = requestIdleCallback(compute, { timeout: 1_000 });
    return () => cancelIdleCallback(handle);
  }, [cheap, views]);
  return cheap !== null ? cheap : late;
}

/** Aggregate +N −M across a `ToolRun`'s items for its group header. */
export function useItemsDiffStats(items: readonly Extract<TimelineItem, { kind: 'tool' }>[], root?: string): ReturnType<typeof toolDiffStats> {
  const views = useMemo(() => items.map(item => toolView(item.event, root)), [items, root]);
  return useViewsDiffStats(views);
}

/**
 * The +N −M of a call's diffs. Aligning an edit is O(n·m), and every tool row asks, folded or not,
 * so an edit with lines on both sides is counted when the browser is idle; a new file or a deletion
 * has one side empty and is counted at once. The previous counts stay until the new ones arrive.
 */
function useDiffStats(view: ToolView): ReturnType<typeof toolDiffStats> {
  const views = useMemo(() => [view], [view]);
  return useViewsDiffStats(views);
}

const RegularToolRow = memo(function RegularToolRow({ item, onOpenPath, onOpenInEditor, root, stale, more }: { item: Extract<TimelineItem, { kind: 'tool' }>; onOpenPath?: (path: string, line?: number) => void; onOpenInEditor?: (path: string, line?: number) => void; root?: string; stale?: boolean; more?: ReactNode }) {
  const { t } = useLingui();
  const view = useMemo(() => toolView(item.event, root), [item.event, root]);
  const presentation = useMemo(() => toolRowPresentation(item.event, root), [item.event, root]);
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
  const activity = currentToolActivity(item);
  const activityFailed = activity?.status === 'failed'
    || (activity?.status === 'completed' && activity.task?.exitCode != null && activity.task.exitCode !== 0);
  const failed = (progress?.status ? progress.status === 'failed' : !running && view.status === 'failed') || activityFailed;
  const [open, setOpen] = useRemembered('tool', false);
  const subagents = useContext(SubagentContext);
  const controls = useContext(ActivityContext);
  const backgroundTask = activity?.kind === 'background_task';
  const isCommand = isCommandTitle(view.title, view.command);
  const title = agentCall
    ? specificSubagentLabel(str(subagent?.description))
      || specificSubagentLabel(progress?.title)
      || specificSubagentLabel(subagentTranscript?.title)
      || specificSubagentLabel(promptFromTranscript(subagentTranscript?.events ?? []))
      || specificSubagentLabel(subagentTranscript?.subagentType)
      || specificSubagentLabel(view.title)
      || t`子 Agent`
    : view.title;
  const taskView = backgroundTask && !view.command && activity.task?.command ? { ...view, command: activity.task.command } : view;
  // The call's own description, else its command; the activity's title is only a clipped copy of either.
  const taskName = backgroundTask ? taskLabel(isCommand ? activity.title : title, taskView.command, root) : undefined;
  const taskTitle = taskName?.text ?? title;
  const taskIsCommand = backgroundTask ? taskName?.mono ?? isCommandTitle(taskTitle, taskView.command) : isCommand;
  const effectivePresentation = useMemo(
    () => backgroundTask ? describeJobRow(isCommand ? activity.title : title, taskView.command, root) : presentation,
    [backgroundTask, isCommand, activity?.title, title, taskView.command, root, presentation],
  );
  const Icon = toolIcons[agentCall ? view.kind : effectivePresentation.icon] ?? IconWrench;
  const activityStopping = activity?.status === 'stopping' || Boolean(activity && controls?.stopping.has(activity.id));
  const stats = useDiffStats(view);
  const images = failed ? [] : view.contents.flatMap(entry => isRecord(entry.content) && entry.content.type === 'image' ? [entry.content] : []);
  // Every agent call leads to its own transcript page, the way the aside's subagent rows do —
  // even when the backend sent no `subagent` record to identify it by.
  const opensPage = Boolean(subagents && agentCall);
  const contents = toolContents(taskView, t`、`, root, onOpenPath, onOpenInEditor);
  const expandable = Boolean(contents || backgroundTask || more);
  const rowTitle = agentCall ? title : <ToolVerbLabel verb={effectivePresentation.verb} />;
  const rowDetail = agentCall
    ? specificSubagentLabel(str(subagent?.type) ?? subagentTranscript?.subagentType)
    : <ToolTargetSlot presentation={effectivePresentation} />;
  const rowInline = agentCall
    ? (activity?.status === 'unknown' ? <BackgroundTaskOutcome activity={activity} /> : dangling ? <RowOutcome /> : undefined)
    : <ToolMetaSlot presentation={effectivePresentation} stats={backgroundTask ? undefined : stats} failed={failed} dangling={dangling} outcome={activity?.status === 'unknown' ? <BackgroundTaskOutcome activity={activity} /> : undefined} />;
  const row = (
    <Disclosure
      touchCompact
      opensPage={opensPage}
      expandable={expandable}
      failed={failed}
      icon={running ? <Spinner className="size-3.5" /> : <Icon className={cn(failed && 'text-danger')} />}
      title={rowTitle}
      detail={rowDetail}
      inline={rowInline}
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
  const generated = view.kind === 'image_generation';
  return (
    <div className="flex min-w-0 flex-col">
      {controlled}
      <div className={cn('mb-1.5 flex min-w-0 flex-wrap gap-2', generated ? 'mt-2' : 'ml-6')}>
        {images.map((content, index) => <ToolImage key={index} content={content} root={root} maxHeight={generated ? 448 : 192} />)}
      </div>
    </div>
  );
});

function MergedToolBody({ items, views, onOpenPath, onOpenInEditor, root, moreOf }: {
  items: Extract<TimelineItem, { kind: 'tool' }>[];
  views: readonly ToolView[];
  onOpenPath?: (path: string, line?: number) => void;
  onOpenInEditor?: (path: string, line?: number) => void;
  root?: string;
  moreOf?: (item: Extract<TimelineItem, { kind: 'tool' }>) => ReactNode;
}) {
  const { t } = useLingui();
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {items.map((subItem, idx) => {
        const subView = views[idx]!;
        const subFailed = !activeToolStates.has(subView.status) && subView.status === 'failed';
        const body = toolContents(subView, t`、`, root, onOpenPath, onOpenInEditor);
        const subMore = moreOf?.(subItem);
        return (
          <RememberedScope.Provider key={subItem.key} value={subItem.key}>
            <MarkSourceContext.Provider value={subItem.event}>
              <div data-item-key={subItem.key} className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center gap-2 font-mono text-2xs tabular-nums text-fg-4">
                  <span>#{idx + 1}</span>
                  {subFailed && <RowOutcome failed />}
                </div>
                {body}
                {subMore}
              </div>
            </MarkSourceContext.Provider>
          </RememberedScope.Provider>
        );
      })}
    </div>
  );
}

/**
 * Adjacent completed tool calls that targeted the same resource or polling endpoint, collapsed to
 * one scannable row with `×N`. Expanding reveals every individual call's command, diffs, and output.
 */
export const MergedToolRow = memo(function MergedToolRow({ items, presentation, onOpenPath, onOpenInEditor, root, moreOf, reveal }: {
  items: Extract<TimelineItem, { kind: 'tool' }>[];
  presentation: ToolRowPresentation;
  onOpenPath?: (path: string, line?: number) => void;
  onOpenInEditor?: (path: string, line?: number) => void;
  root?: string;
  moreOf?: (item: Extract<TimelineItem, { kind: 'tool' }>) => ReactNode;
  reveal?: number;
}) {
  const views = useMemo(() => items.map(item => toolView(item.event, root)), [items, root]);
  const stats = useViewsDiffStats(views);
  const failed = views.some(view => !activeToolStates.has(view.status) && view.status === 'failed');
  const [open, setOpen] = useRemembered('tool', false);
  useLayoutEffect(() => { if (reveal !== undefined) setOpen(true); }, [reveal, setOpen]);
  const Icon = toolIcons[presentation.icon] ?? IconWrench;
  return (
    <Disclosure
      touchCompact
      expandable
      failed={failed}
      icon={<Icon className={cn(failed && 'text-danger')} />}
      title={<ToolVerbLabel verb={presentation.verb} />}
      detail={<ToolTargetSlot presentation={presentation} merged />}
      inline={<ToolMetaSlot presentation={presentation} stats={stats} mergedCount={items.length} failed={failed} />}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <MergedToolBody items={items} views={views} onOpenPath={onOpenPath} onOpenInEditor={onOpenInEditor} root={root} moreOf={moreOf} />
    </Disclosure>
  );
});

/** Each trigger keeps its own task row; an aggregate heading would repeat its state and time. */
export const TurnTriggerBlock = memo(function TurnTriggerBlock({ notices, moreOf, root }: { notices: Extract<TimelineItem, { kind: 'task_notification' }>[]; moreOf?: (notice: TimelineItem) => ReactNode; root?: string }) {
  return <section className="flex flex-col gap-1.5">{notices.map((notice) => <NoticeItem key={notice.key} notice={notice} more={moreOf?.(notice)} root={root} />)}</section>;
});

/** One notice of several in a row: findable by its own key, and remembering its own state. */
function NoticeItem({ notice, more, root }: { notice: Extract<TimelineItem, { kind: 'task_notification' }>; more?: ReactNode; root?: string }) {
  return <div data-item-key={notice.key} className="min-w-0"><RememberedScope.Provider value={notice.key}><TaskNotificationRow item={notice} more={more} root={root} /></RememberedScope.Provider></div>;
}

export const TaskNotificationRow = memo(function TaskNotificationRow({ item, more, root }: { item: Extract<TimelineItem, { kind: 'task_notification' }>; more?: ReactNode; root?: string }) {
  const { t } = useLingui();
  const [open, setOpen] = useRemembered('notice', false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useRemembered('notice-diagnostics', false);
  const subagents = useContext(SubagentContext);
  const launches = useContext(TaskLaunchContext);
  // Kinds this row can say the outcome of; any other notice (a peer's message, a worktree entered, a provider's note) keeps its own title.
  const kind = item.taskKind === 'subagent' || item.taskKind === 'monitor' || item.taskKind === 'workflow' || item.taskKind === 'shell' ? item.taskKind : 'other';
  const subagent = kind === 'subagent';
  const running = item.status === 'running';
  // The call that started the task: the reader can go back to it, and its row holds the task's exit code and output.
  // That row holds the call's latest run, so only the latest notice about the call reads from it.
  const launch = item.subagentToolCallId ? launches?.find(item.subagentToolCallId) : undefined;
  const activity = launch?.latestNotice === item.key ? launch.activity : undefined;
  const exitCode = item.jobResult?.exitCode ?? activity?.task?.exitCode;
  const failed = item.status === 'failed' || (item.status === 'completed' && exitCode !== undefined && exitCode !== 0);
  const duration = item.jobResult?.runningMs ?? item.durationMs ?? (activity && !running ? finishedMs(activity, item.event.createdAt) : undefined);
  const command = item.command ?? activity?.task?.command;
  const openSubagent = subagent && item.subagentToolCallId && subagents
    ? () => subagents.open({ toolCallId: item.subagentToolCallId! })
    : undefined;
  // Named the way its launching row names it: the call's description, else the gist of its command.
  const name = useMemo<ToolRowPresentation | undefined>(() => {
    if (kind === 'other') return undefined;
    // i18n-ignore: the server's placeholder title for an unnamed subagent, which the headline already says
    if (subagent) return item.title && item.title !== '子 Agent' ? { icon: 'execute', verb: 'Run', primary: item.title, primaryKind: 'prose' } : undefined;
    return item.title || command ? describeJobRow(item.title, command, root) : undefined;
  }, [kind, subagent, item.title, command, root]);
  const outcome = failed ? 'failed' : item.status;
  const headline = kind === 'other' ? <span className="text-fg-2">{item.title || t`后台任务`}</span> : kind === 'subagent'
    ? outcome === 'completed' ? t`子 Agent 已完成` : outcome === 'failed' ? t`子 Agent 失败` : outcome === 'cancelled' ? t`子 Agent 已停止` : t`子 Agent`
    : kind === 'monitor'
      ? outcome === 'completed' ? t`监控已结束` : outcome === 'failed' ? t`监控失败` : outcome === 'cancelled' ? t`监控已停止` : outcome === 'running' ? t`监控事件` : t`监控`
      : kind === 'workflow'
        ? outcome === 'completed' ? t`工作流已完成` : outcome === 'failed' ? t`工作流失败` : outcome === 'cancelled' ? t`工作流已停止` : t`工作流`
        : outcome === 'completed' ? t`后台命令已完成` : outcome === 'failed' ? t`后台命令失败` : outcome === 'cancelled' ? t`后台命令已停止` : t`后台命令`;
  const figures = [
    duration !== undefined && duration >= 1000 ? compactDuration(duration) : undefined,
    exitCode !== undefined && exitCode !== 0 ? t`退出码 ${exitCode}` : undefined,
  ].filter(Boolean).join(' · ');
  const Icon = subagent ? IconBot : kind === 'monitor' ? IconEye : kind === 'workflow' ? IconRepeat : IconSquareTerminal;
  // A shell task's output is on its launching row once the task ended; a monitor's notice carries its own event.
  const output = activity && (kind === 'shell' || kind === 'workflow') && (activity.detail || activity.blobRef) ? activity : undefined;
  const time = item.event.createdAt;
  return (
    <Disclosure
      icon={running ? <Spinner className="size-3.5" /> : <Icon className={cn(failed && 'text-danger')} />}
      failed={failed}
      title={headline}
      detail={name ? <ToolTargetSlot presentation={name} /> : undefined}
      inline={(name?.extraCommands !== undefined || figures || item.status === 'unknown') && (
        <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-fg-4">
          {name?.extraCommands !== undefined && <span className="rounded-sm bg-subtle px-1.5 font-mono text-2xs text-fg-3">+{name.extraCommands}</span>}
          {figures && <span>{figures}</span>}
          {item.status === 'unknown' && <RowOutcome />}
        </span>
      )}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      {name?.primaryKind === 'prose' && <p className="whitespace-pre-wrap break-words text-sm text-fg-2">{name.primary}</p>}
      {command && <CodeBlock className="text-fg" copy={command} remember="command"><span className="select-none text-fg-4">$ </span>{command}</CodeBlock>}
      {output
        ? <ActivityDetails activity={output} />
        : item.detail && (subagent ? <Markdown text={item.detail} /> : <CodeBlock copy={item.detail} remember="detail">{item.detail}</CodeBlock>)}
      {more}
      <div className="flex flex-wrap items-center gap-2 text-2xs text-fg-3">
        <time dateTime={time} className="tabular-nums">{formatDateTime(time)}</time>
        {item.tokens !== undefined && <span className="tabular-nums">{compactTokens(item.tokens)} tok</span>}
        {openSubagent && (
          <button type="button" onClick={openSubagent} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-fg-2 transition-colors hover:bg-hover hover:text-fg no-hover:min-h-11">
            <IconBot className="size-3" /><Trans>查看子 Agent 对话</Trans>
          </button>
        )}
        {launch && launches && (
          <button type="button" onClick={() => launches.jump(launch.key)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-fg-2 transition-colors hover:bg-hover hover:text-fg no-hover:min-h-11">
            <IconArrowUp className="size-3" /><Trans>跳到启动处</Trans>
          </button>
        )}
      </div>
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
