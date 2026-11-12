import { memo, useContext, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { NativeActivity, NativeJob, SessionGoal } from '@contracts';
import { IconCheck } from '@/components/icons';
import { Spinner, StatusDot } from '@/components/ui/controls';
import { projectFileUrl } from '@/lib/files';
import { cn } from '@/lib/utils';
import { BackgroundTaskItem, BackgroundTasksNotLoaded } from './Activities';
import { goalStatusLabel, todoEntries, todoSettled, type TodoEntry } from './ComposerDock';
import { previewOnPlainClick } from './fileAccess';
import type { TimelineItem } from './model';
import { formatDuration, subagentTitle, transcriptDuration, backgroundTaskSummary, type SubagentBrief } from './SessionWorkActions';
import { sessionOutputs, type EditRecord } from './sessionAsideModel';
import { SubagentContext, type NativeJobStore, type SubagentStore } from './subagents';

function Section({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-1.5 flex items-center px-2 text-2xs font-medium text-fg-4">{title}{meta !== undefined && <span className="ml-auto tabular-nums">{meta}</span>}</h2>
      {children}
    </section>
  );
}

function TodoMark({ status }: { status: TodoEntry['status'] }) {
  if (status === 'completed') return <span className="grid size-3.5 place-items-center rounded-full bg-fg-4 text-bg"><IconCheck className="size-2.5" strokeWidth={3} /></span>;
  if (status === 'in_progress') return <span className="grid size-3.5 place-items-center rounded-full border-[1.5px] border-accent"><span className="size-1.5 rounded-full bg-accent" /></span>;
  return <span className="size-3.5 rounded-full border-[1.5px] border-fg-4/70" />;
}

/** A list longer than this folds: settled items into one line, and the rest after this many. */
const PLAN_LIMIT = 6;

const foldButton = 'flex h-7 w-full items-center gap-2.5 rounded-lg px-2 text-left text-2xs text-fg-4 transition-colors hover:bg-hover hover:text-fg-3';

const Plan = memo(function Plan({ goal, todos }: { goal?: SessionGoal; todos: TodoEntry[] }) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const settled = todos.filter(todoSettled);
  const open = todos.filter((todo) => !todoSettled(todo));
  const folds = todos.length > PLAN_LIMIT && !expanded;
  // Folded, the list leads with the work still ahead, the current item first among it.
  const visible = folds ? open.slice(0, PLAN_LIMIT - (settled.length ? 1 : 0)) : todos;
  const hiddenOpen = folds ? open.length - visible.length : 0;
  return (
    <Section title={t`计划`} meta={todos.length ? `${done} / ${todos.length}` : goal ? goalStatusLabel(goal) : undefined}>
      {goal?.objective && <p className={cn('mb-2 line-clamp-4 px-2 text-sm text-fg-2 wrap-anywhere', goal.status === 'blocked' && 'text-warning')} title={goal.objective}>{goal.objective}</p>}
      {goal?.status === 'blocked' && goal.reason && <p className="mb-2 line-clamp-3 px-2 text-2xs text-warning">{goal.reason}</p>}
      {todos.length > 0 && (
        <ul className="flex flex-col">
          {folds && settled.length > 0 && (
            <li><button type="button" onClick={() => setExpanded(true)} className={foldButton}><span className="flex h-5 shrink-0 items-center"><TodoMark status="completed" /></span><Trans>已完成 {settled.length} 项</Trans></button></li>
          )}
          {visible.map((todo, index) => (
            <li key={`${todo.content}:${index}`} className="flex min-w-0 items-start gap-2.5 px-2 py-1 text-sm" title={todo.content}>
              <span className="flex h-5 shrink-0 items-center"><TodoMark status={todo.status} /></span>
              <span className={cn('min-w-0 flex-1 wrap-anywhere', todo.status === 'in_progress' ? 'line-clamp-4 font-medium text-fg' : 'line-clamp-2', todo.status === 'pending' ? 'text-fg-2' : todo.status !== 'in_progress' && 'text-fg-4', todo.status === 'cancelled' && 'line-through')}>{todo.content}</span>
            </li>
          ))}
          {hiddenOpen > 0 && <li><button type="button" onClick={() => setExpanded(true)} className={cn(foldButton, 'pl-8')}><Trans>还有 {hiddenOpen} 项</Trans></button></li>}
          {expanded && todos.length > PLAN_LIMIT && <li><button type="button" onClick={() => setExpanded(false)} className={cn(foldButton, 'pl-8')}><Trans>收起</Trans></button></li>}
        </ul>
      )}
    </Section>
  );
});

function jobElapsed(job: NativeJob): string | undefined {
  const started = Date.parse(job.startedAt ?? '');
  if (!Number.isFinite(started) || job.status !== 'running') return undefined;
  return formatDuration(Date.now() - started) || undefined;
}

const WORK_LIMIT = 5;

/** Subagents and background tasks, the work running beside the conversation rather than in it, each in its own section. */
const Work = memo(function Work({ subagentStore, jobStore, tasks, reportedBackground, briefs }: { subagentStore: SubagentStore; jobStore: NativeJobStore; tasks: readonly NativeActivity[]; reportedBackground: number; briefs?: ReadonlyMap<string, SubagentBrief> }) {
  const { t } = useLingui();
  const subagents = useSyncExternalStore(subagentStore.subscribeAll, subagentStore.getSnapshot, subagentStore.getSnapshot);
  const jobs = useSyncExternalStore(jobStore.subscribeAll, jobStore.getSnapshot, jobStore.getSnapshot);
  const opener = useContext(SubagentContext);
  const [expanded, setExpanded] = useState(false);
  const runningJobs = jobs.filter((job) => job.status === 'running');
  const summary = backgroundTaskSummary(reportedBackground, tasks, subagents, runningJobs);
  if (!subagents.length && !summary.count) return null;
  const ordered = [...subagents].sort((left, right) => Number(right.transcript.running === true) - Number(left.transcript.running === true));
  const running = ordered.filter((entry) => entry.transcript.running === true).length;
  // Running children always show; finished ones fill what is left of the limit.
  const shown = expanded ? ordered : ordered.slice(0, Math.max(running, WORK_LIMIT));
  const hidden = ordered.length - shown.length;
  const background = summary.count;
  return (
    <>
      {ordered.length > 0 && (
        <Section title={t`子 Agent`} meta={running ? t`${running} 进行中` : undefined}>
          <ul className="flex flex-col">
            {shown.map((entry) => {
              const running = entry.transcript.running === true;
              const title = subagentTitle(entry, briefs?.get(entry.toolCallId));
              const duration = entry.transcript.history?.hasMore ? undefined : transcriptDuration(entry.transcript.events);
              return (
                <li key={entry.toolCallId}>
                  <button
                    type="button"
                    disabled={!opener}
                    onClick={() => opener?.open({ toolCallId: entry.toolCallId, ...(entry.transcript.running !== undefined ? { running: entry.transcript.running } : {}) })}
                    className="flex h-7 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-sm transition-colors hover:bg-hover"
                  >
                    <span className="grid size-3.5 shrink-0 place-items-center">{running ? <Spinner className="size-3.5 text-accent" /> : <StatusDot tone={entry.transcript.status === 'failed' ? 'danger' : entry.transcript.running === false ? 'success' : 'idle'} />}</span>
                    <span className={cn('min-w-0 flex-1 truncate', running ? 'text-fg' : 'text-fg-3')}>{title}</span>
                    {duration && <span className="shrink-0 text-2xs tabular-nums text-fg-4">{duration}</span>}
                  </button>
                </li>
              );
            })}
            {hidden > 0 && <li><button type="button" onClick={() => setExpanded(true)} className={cn(foldButton, 'pl-8')}><Trans>还有 {hidden} 个已结束</Trans></button></li>}
            {expanded && ordered.length > WORK_LIMIT && <li><button type="button" onClick={() => setExpanded(false)} className={cn(foldButton, 'pl-8')}><Trans>收起</Trans></button></li>}
          </ul>
        </Section>
      )}
      {background > 0 && (
        <Section title={t`后台任务`} meta={t`${background} 进行中`}>
          <ul className="flex flex-col">
            {summary.tasks.map((task) => <BackgroundTaskItem key={task.id} activity={task} />)}
            {runningJobs.map((job) => (
              <li key={job.toolCallId} className="flex h-7 min-w-0 items-center gap-2.5 px-2 text-sm" title={job.command}>
                <span className="grid size-3.5 shrink-0 place-items-center"><Spinner className="size-3.5" /></span>
                <span className="min-w-0 flex-1 truncate text-fg-2">{job.title}</span>
                <span className="shrink-0 text-2xs tabular-nums text-fg-4">{jobElapsed(job) ?? t`后台`}</span>
              </li>
            ))}
          </ul>
          {summary.unloaded > 0 && <BackgroundTasksNotLoaded count={reportedBackground} />}
        </Section>
      )}
    </>
  );
});

const OUTPUT_LIMIT = 8;

function Outputs({ projectId, timeline, timelineVersion, root, onOpenPath }: { projectId: string; timeline: readonly TimelineItem[]; timelineVersion: number; root?: string; onOpenPath?: (path: string) => void }) {
  const { t } = useLingui();
  const cache = useRef(new WeakMap<object, EditRecord>());
  const outputs = useMemo(() => sessionOutputs(timeline, root, cache.current), [timeline, timelineVersion, root]);
  const [expanded, setExpanded] = useState(false);
  if (!outputs.length) return null;
  const shown = expanded ? outputs : outputs.slice(0, OUTPUT_LIMIT);
  return (
    <Section title={t`产出`} meta={outputs.length > 1 ? t`${outputs.length} 个文件` : undefined}>
      <ul className="flex flex-col">
        {shown.map((output) => {
          const name = output.path.split('/').at(-1) ?? output.path;
          return (
            <li key={output.path}>
              <a href={projectFileUrl(projectId, output.path)} target="_blank" rel="noopener" onClick={onOpenPath && previewOnPlainClick(onOpenPath, output.path)} title={output.path} className="flex h-7 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-hover">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-2">{name}</span>
                <span className="flex shrink-0 items-center gap-1.5 font-mono text-2xs tabular-nums">
                  {output.created && !output.removed ? <span className="font-sans text-fg-4"><Trans>新建</Trans></span> : null}
                  {output.added > 0 && <span className="text-[var(--diff-add-marker)]">+{output.added}</span>}
                  {output.removed > 0 && <span className="text-[var(--diff-del-marker)]">−{output.removed}</span>}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      {outputs.length > OUTPUT_LIMIT && <button type="button" onClick={() => setExpanded((value) => !value)} className={foldButton}>{expanded ? <Trans>收起</Trans> : <Trans>还有 {outputs.length - OUTPUT_LIMIT} 个文件</Trans>}</button>}
    </Section>
  );
}

/**
 * The wide layout's side column: what the agent set out to do, where the conversation has been,
 * what is running beside it and what it has produced. None of it repeats the composer's model or
 * permission controls; narrower sessions keep the plan above the composer instead. Whether it is
 * on screen is `useSessionLayout`'s call, never its contents': an empty column stays a column.
 */
/** Streamed frames only reach `Outputs`: the plan and the work list keep their memo while the timeline moves. */
export const SessionAside = memo(function SessionAside({ projectId, outlineRef, goal, todos, subagentStore, jobStore, backgroundTasks, reportedBackground, subagentBriefs, timeline, timelineVersion, root, onOpenPath }: {
  projectId: string;
  outlineRef: Ref<HTMLDivElement>;
  goal?: SessionGoal;
  todos?: Record<string, unknown>[];
  subagentStore: SubagentStore;
  jobStore: NativeJobStore;
  backgroundTasks: readonly NativeActivity[];
  reportedBackground: number;
  subagentBriefs?: ReadonlyMap<string, SubagentBrief>;
  timeline: readonly TimelineItem[];
  timelineVersion: number;
  root?: string;
  onOpenPath?: (path: string) => void;
}) {
  const { t } = useLingui();
  const entries = useMemo(() => todoEntries(todos ?? []), [todos]);
  return (
    // 14px + half the 16px heading line centres the first heading on the subagent page's 44px header.
    <aside aria-label={t`会话概览`} className="flex w-[248px] shrink-0 flex-col gap-7 overflow-y-auto pt-3.5 pr-4 pb-6 pl-1 scrollbar-none animate-in fade-in-0 duration-[var(--duration-slow)] ease-[var(--ease-decelerate)]">
      {(goal || entries.length > 0) && <Plan goal={goal} todos={entries} />}
      <div ref={outlineRef} className="contents" />
      <Work subagentStore={subagentStore} jobStore={jobStore} tasks={backgroundTasks} reportedBackground={reportedBackground} briefs={subagentBriefs} />
      <Outputs projectId={projectId} timeline={timeline} timelineVersion={timelineVersion} root={root} onOpenPath={onOpenPath} />
    </aside>
  );
});
