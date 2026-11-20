import type { KeyboardEvent, ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { WorkItem, WorkItemAssignee, WorkItemStatus } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { OwnerAvatar } from '@/components/OwnerAvatar';
import { Spinner, StatusDot } from '@/components/ui/controls';
import { agentMarkStyle, useBackendLabel } from '@/lib/backends';
import { cn } from '@/lib/utils';
import { useLists } from '../state/stores';
import type { WorkItemLive } from './model';

export function useStatusLabel(): (status: WorkItemStatus) => string {
  const { t } = useLingui();
  return (status) => ({
    todo: t({ message: '待办', context: 'work-item-status' }),
    doing: t({ message: '进行中', context: 'work-item-status' }),
    watching: t({ message: '观测中', context: 'work-item-status' }),
    review: t({ message: '待验收', context: 'work-item-status' }),
    done: t({ message: '完成', context: 'work-item-status' }),
    cancelled: t({ message: '无需关注', context: 'work-item-status' }),
  })[status];
}

/**
 * A ring that fills as the work advances, each status in its own colour: blue while an agent works,
 * neutral ink while watching, amber while the owner is to review, green once done, grey slash once dismissed.
 */
export const STATUS_TONE: Record<WorkItemStatus, string> = {
  todo: 'var(--fg-4)',
  doing: 'var(--accent)',
  watching: 'var(--fg-3)',
  review: 'var(--warning)',
  done: 'var(--success)',
  cancelled: 'var(--fg-4)',
};

/**
 * `running`: a conversation of the task is running, and the ring itself is the spinner, an open arc
 * turning around the still fill, so a list row needs no second mark beside it.
 */
export function StatusIcon({ status, running, className }: { status: WorkItemStatus; running?: boolean; className?: string }) {
  const { t } = useLingui();
  const statusLabel = useStatusLabel()(status);
  const tone = STATUS_TONE[status];
  const ring = (dashArray?: string) => <circle cx="7" cy="7" r="5.5" fill="none" stroke={tone} strokeWidth="1.25" strokeLinecap={running ? 'round' : undefined} strokeDasharray={dashArray} />;
  const check = 'M4.5 7.2 6.2 8.9 9.6 5.4';
  return (
    <svg viewBox="0 0 14 14" role="img" aria-label={running ? `${statusLabel} · ${t`运行中`}` : statusLabel} className={cn('size-3.5 shrink-0', className)}>
      {/* motion-loop: the spinner's rotation, on the ring; `ui-spinner` fades it instead under reduced motion */}
      {running
        ? <g className="ui-spinner animate-spin" style={{ transformBox: 'view-box', transformOrigin: 'center' }}>{ring('24 10.6')}</g>
        : status !== 'done' && ring(status === 'todo' ? '1.4 2' : undefined)}
      {status === 'doing' && <path d="M7 7V3.6A3.4 3.4 0 0 1 7 10.4Z" fill={tone} />}
      {status === 'watching' && <circle cx="7" cy="7" r="2" fill={tone} />}
      {status === 'review' && <path d="M7 7V3.6A3.4 3.4 0 1 1 3.6 7Z" fill={tone} />}
      {status === 'done' && (running
        ? <path d={check} fill="none" stroke={tone} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        : <><circle cx="7" cy="7" r="6.1" fill={tone} /><path d={check} fill="none" stroke="var(--bg)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></>)}
      {status === 'cancelled' && <path d="M4.6 9.4 9.4 4.6" stroke={tone} strokeWidth="1.25" strokeLinecap="round" />}
    </svg>
  );
}

export function useLiveLabel(): (live: WorkItemLive) => string {
  const { t } = useLingui();
  return (live) => ({
    waiting: t({ message: '待确认', context: 'workbench-session-pending' }),
    failed: t`失败`,
    running: t`运行中`,
    unseen: t`有新结果`,
  })[live];
}

/**
 * The sidebar's marks (`SessionIndicator`), so one state looks the same on both. Waiting and failed
 * also say their word, as the sidebar's 待确认 does; running is a spinner, a new result a dot.
 */
export function LiveMark({ live, words = true, className }: { live: WorkItemLive | undefined; words?: boolean; className?: string }) {
  const label = useLiveLabel();
  if (!live) return null;
  const tone = live === 'waiting' ? 'warning' : live === 'failed' ? 'danger' : 'accent';
  const spoken = words && (live === 'waiting' || live === 'failed');
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 text-2xs', live === 'waiting' ? 'text-warning' : 'text-danger', className)}>
      {live === 'running'
        ? <span role="img" aria-label={label(live)} title={label(live)} className="inline-flex"><Spinner className="size-3 text-accent" /></span>
        : <StatusDot tone={tone} label={spoken ? undefined : label(live)} />}
      {spoken && label(live)}
    </span>
  );
}

/** Who works on it: the agent's mark, or the owner's avatar. */
export function AssigneeMark({ assignee, size = 14 }: { assignee: WorkItemAssignee; size?: number }) {
  const label = useAssigneeLabel()(assignee);
  const owner = useLists((state) => state.owner);
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex shrink-0">
      {assignee.kind === 'owner' ? <OwnerAvatar owner={owner} size={size} /> : <AgentLogo backend={assignee.backendId} size={size} style={agentMarkStyle(assignee.backendId)} />}
    </span>
  );
}

export function useAssigneeLabel(): (assignee: WorkItemAssignee) => string {
  const { t } = useLingui();
  const label = useBackendLabel();
  return (assignee) => assignee.kind === 'owner' ? t({ message: '我', context: 'work-item-assignee' }) : label(assignee.backendId);
}

export const WorkItemNumber = ({ number, className }: { number: number; className?: string }) =>
  <span className={cn('shrink-0 font-mono text-2xs tabular-nums text-fg-4', className)}>#{number}</span>;

/** A section heading inside the page or the panel: text-xs medium, 28 high, a count after it. */
export function SectionHeading({ icon, children, count, className }: { icon?: ReactNode; children: ReactNode; count?: ReactNode; className?: string }) {
  return (
    <h2 className={cn('flex h-7 items-center gap-1.5 px-0.5 text-xs font-medium text-fg-3 [&_svg]:size-3.5', className)}>
      {icon}{children}{count !== undefined && <span className="font-normal tabular-nums text-fg-4">{count}</span>}
    </h2>
  );
}

/** Enter and Space open a row that is a `div` (it holds its own buttons). */
export const activateWorkItem = (open: () => void) => (event: KeyboardEvent<HTMLElement>) => {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  open();
};

export function useSubmissionClue(item: WorkItem): string | undefined {
  const { t } = useLingui();
  const submission = item.submission;
  if (item.status !== 'review' || !submission) return undefined;
  const parts: string[] = [];
  const total = submission.criteria.length;
  const count = submission.evidence.files.length;
  if (total) {
    const met = submission.criteria.filter((entry) => entry.met === true).length;
    parts.push(t`标准 ${met}/${total}`);
  }
  if (count) parts.push(t`改动 ${count} 个文件`);
  if (parts.length) return parts.join(' · ');
  const summaryLine = submission.summary.split('\n').map((line) => line.trim()).find(Boolean);
  return summaryLine;
}
