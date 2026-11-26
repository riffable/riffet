import { useContext, useMemo, useState, useSyncExternalStore } from 'react';
import { msg } from '@lingui/core/macro';
import { i18n } from '@lingui/core';
import type { NativeActivity, NativeJob, WorkbenchEvent } from '@contracts';
import { IconCheck } from '@/components/icons';
import { formatDuration as formatElapsed } from '@/lib/format-duration';
import { Spinner, StatusDot } from '@/components/ui/controls';
import { InfoMore, InfoSection, infoRow } from '../SessionInfo';
import { BackgroundTaskItem } from './Activities';
import { JobRow } from './Timeline';
import { NativeJobStore, SubagentContext, SubagentStore, subagentTitle, type StoredSubagent, type SubagentBrief, type SubagentTarget } from './subagents';

function orderedJobs(jobs: readonly NativeJob[]): NativeJob[] {
  return [...jobs].sort((left, right) => {
    const leftRunning = left.status === 'running';
    const rightRunning = right.status === 'running';
    if (leftRunning !== rightRunning) return leftRunning ? -1 : 1;
    const leftStarted = Date.parse(left.startedAt ?? '') || 0;
    const rightStarted = Date.parse(right.startedAt ?? '') || 0;
    return leftRunning ? leftStarted - rightStarted : rightStarted - leftStarted;
  });
}

/**
 * The running background tasks that have no row of their own yet: a task the CLI started as a
 * subagent or as a watched shell is already listed as one, under the same tool call.
 */
export function unlistedTasks(tasks: readonly NativeActivity[], subagents: readonly StoredSubagent[], jobs: readonly NativeJob[]): NativeActivity[] {
  const listed = new Set([...subagents.map((entry) => entry.toolCallId), ...jobs.map((job) => job.toolCallId)]);
  return tasks.filter((task) => !task.toolCallId || !listed.has(task.toolCallId));
}

/** The status covers the full session; the lists may only have its most recent history page. */
export function backgroundTaskSummary(reported: number, tasks: readonly NativeActivity[], subagents: readonly StoredSubagent[], jobs: readonly NativeJob[]) {
  const others = unlistedTasks(tasks, subagents, jobs);
  const childCalls = new Set(subagents.map((entry) => entry.toolCallId));
  const listedChildren = tasks.filter((task) => task.toolCallId && childCalls.has(task.toolCallId)).length;
  return {
    tasks: others,
    // Only an explicit activity association proves that a child belongs to the reported total.
    // Jobs can be foreground calls too. Without identities for the unloaded activities, the two
    // counts may overlap, so their maximum is the number we can safely report, not their sum.
    count: Math.max(jobs.length + others.length, reported - listedChildren),
  };
}

const kindLabel = (kind: 'subagents' | 'jobs') => kind === 'subagents' ? i18n._(msg`子 Agent`) : i18n._(msg`后台任务`);

/**
 * How long the subagent has been working, from its own transcript's first to last event. It grows
 * while the subagent runs, so a busy child shows its elapsed time without extra bookkeeping.
 *
 * The CLI's store only timestamps messages at turn granularity, so a subagent read back after the
 * fact has every event on the same stamp. A span that small is reported as unknown rather than as
 * "0秒": only a child the app watched live carries per-message times.
 */
export function transcriptDuration(events: readonly WorkbenchEvent[]): string | undefined {
  const times = events.map((event) => Date.parse(event.createdAt)).filter((at) => Number.isFinite(at));
  if (times.length < 2) return undefined;
  const span = Math.max(...times) - Math.min(...times);
  return span >= 1_000 ? formatDuration(span) : undefined;
}

export function formatDuration(ms: number): string {
  return Number.isFinite(ms) && ms >= 0 ? formatElapsed(ms) : '';
}

// Shared with the tool row that spawned the child, so both name it the same way.
export { promptFromTranscript, subagentTitle, type SubagentBrief } from './subagents';

function SubagentRow({ entry, brief, onOpen }: { entry: StoredSubagent; brief?: SubagentBrief; onOpen?: (target: SubagentTarget) => void }) {
  const running = entry.transcript.running === true;
  const failed = entry.transcript.status === 'failed';
  // The Task tool's `description` is documented as the subagent's name in the UI, so that is the title.
  const title = subagentTitle(entry, brief);
  // A partial tail would under-report how long the child ran.
  const duration = entry.transcript.history?.hasMore ? undefined : transcriptDuration(entry.transcript.events);
  return (
    <li>
      <button
        type="button"
        data-closes-overlay
        disabled={!onOpen}
        onClick={() => onOpen?.({ toolCallId: entry.toolCallId, ...(entry.transcript.running !== undefined ? { running: entry.transcript.running } : {}) })}
        title={entry.transcript.agentId}
        className={infoRow}
      >
        <span className="grid size-3.5 place-items-center">{running ? <Spinner className="text-fg-3" /> : failed ? <StatusDot tone="danger" /> : <IconCheck className="size-3.5 text-fg-4" />}</span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {duration && <span className="text-xs tabular-nums text-fg-4">{duration}</span>}
      </button>
    </li>
  );
}

function SubagentsSection({ entries, briefs }: { entries: readonly StoredSubagent[]; briefs?: ReadonlyMap<string, SubagentBrief> }) {
  const subagents = useContext(SubagentContext);
  const [expanded, setExpanded] = useState(false);
  const ordered = useMemo(() => [...entries].sort((left, right) => Number(right.transcript.running === true) - Number(left.transcript.running === true)), [entries]);
  const running = ordered.filter((entry) => entry.transcript.running === true).length;
  const done = ordered.length - running;
  // Everything running stays in view; the finished ones fold after a few rows.
  const shown = expanded ? ordered.length : Math.max(3, running);
  return (
    <InfoSection title={kindLabel('subagents')} summary={running ? i18n._(msg`${running} 运行 · ${done} 完成`) : i18n._(msg`${done} 完成`)}>
      <ul>{ordered.slice(0, shown).map((entry) => <SubagentRow key={entry.toolCallId} entry={entry} brief={briefs?.get(entry.toolCallId)} onOpen={subagents?.open} />)}</ul>
      {ordered.length > shown && <InfoMore hidden={ordered.length - shown} onClick={() => setExpanded(true)} />}
    </InfoSection>
  );
}

function JobsSection({ jobs, tasks, active, onOpenPath }: { jobs: readonly NativeJob[]; tasks: readonly NativeActivity[]; active: number; onOpenPath?: (path: string, line?: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  // Running work first: the tasks have no other state, and the jobs are ordered running-first.
  const rows = useMemo(() => [
    ...tasks.map((task) => <BackgroundTaskItem key={task.id} activity={task} />),
    ...orderedJobs(jobs).map((job) => <li key={job.toolCallId} className="px-2.5 py-1"><JobRow job={job} onOpenPath={onOpenPath} /></li>),
  ], [tasks, jobs, onOpenPath]);
  const shown = expanded ? rows.length : Math.max(3, active);
  return (
    <InfoSection title={kindLabel('jobs')} summary={active ? i18n._(msg`${active} 运行`) : undefined}>
      <ul>{rows.slice(0, shown)}</ul>
      {rows.length > shown && <InfoMore hidden={rows.length - shown} onClick={() => setExpanded(true)} />}
    </InfoSection>
  );
}

/** The session-info groups for subagents and background tasks; each subscribes here so the header is not rebuilt as they change. */
export function SessionWorkActions({ subagentStore, jobStore, tasks, reportedBackground, onOpenPath, subagentBriefs }: {
  subagentStore: SubagentStore;
  jobStore: NativeJobStore;
  /** Running background tasks; those without a subagent or job row join the job list. */
  tasks: readonly NativeActivity[];
  reportedBackground: number;
  onOpenPath?: (path: string, line?: number) => void;
  /** What each Task call asked for, keyed by tool call id, so rows can name their subagent. */
  subagentBriefs?: ReadonlyMap<string, SubagentBrief>;
}) {
  const subagents = useSyncExternalStore(subagentStore.subscribeAll, subagentStore.getSnapshot, subagentStore.getSnapshot);
  const jobs = useSyncExternalStore(jobStore.subscribeAll, jobStore.getSnapshot, jobStore.getSnapshot);
  const summary = useMemo(() => backgroundTaskSummary(reportedBackground, tasks, subagents, jobs), [reportedBackground, tasks, subagents, jobs]);
  if (subagents.length === 0 && summary.count === 0) return null;
  const activeBackground = backgroundTaskSummary(reportedBackground, tasks, subagents, jobs.filter((job) => job.status === 'running')).count;
  return (
    <>
      {subagents.length > 0 && <SubagentsSection entries={subagents} briefs={subagentBriefs} />}
      {summary.count > 0 && <JobsSection jobs={jobs} tasks={summary.tasks} active={activeBackground} onOpenPath={onOpenPath} />}
    </>
  );
}
