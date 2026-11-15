import type { ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { WorkItemAssignee, WorkItemStatus } from '@contracts';
import { AgentLogo } from '@/components/AgentLogo';
import { OwnerAvatar } from '@/components/OwnerAvatar';
import { StatusDot } from '@/components/ui/controls';
import { agentMarkStyle, useBackendLabel } from '@/lib/backends';
import { cn } from '@/lib/utils';
import { useLists } from '../state/stores';
import type { WorkItemLive } from './model';

export function useStatusLabel(): (status: WorkItemStatus) => string {
  const { t } = useLingui();
  return (status) => ({
    todo: t({ message: '待办', context: 'work-item-status' }),
    doing: t({ message: '进行中', context: 'work-item-status' }),
    review: t({ message: '待验收', context: 'work-item-status' }),
    done: t({ message: '完成', context: 'work-item-status' }),
    cancelled: t({ message: '已取消', context: 'work-item-status' }),
  })[status];
}

/**
 * A ring that fills as the work advances, each status in its own colour: blue while an agent works,
 * the warning amber while the owner is to review, green once done (docs/TASK-BOARD.md §9).
 */
export function StatusIcon({ status, className }: { status: WorkItemStatus; className?: string }) {
  const label = useStatusLabel()(status);
  const ring = (stroke: string, dashed?: boolean) => <circle cx="7" cy="7" r="5.5" fill="none" stroke={stroke} strokeWidth="1.25" strokeDasharray={dashed ? '1.4 2' : undefined} />;
  return (
    <svg viewBox="0 0 14 14" role="img" aria-label={label} className={cn('size-3.5 shrink-0', className)}>
      {status === 'todo' && ring('var(--fg-4)', true)}
      {status === 'doing' && <>{ring('var(--accent)')}<path d="M7 7V3.6A3.4 3.4 0 0 1 7 10.4Z" fill="var(--accent)" /></>}
      {status === 'review' && <>{ring('var(--warning)')}<path d="M7 7V3.6A3.4 3.4 0 1 1 3.6 7Z" fill="var(--warning)" /></>}
      {status === 'done' && <><circle cx="7" cy="7" r="6.1" fill="var(--success)" /><path d="M4.5 7.2 6.2 8.9 9.6 5.4" fill="none" stroke="var(--bg)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></>}
      {status === 'cancelled' && <>{ring('var(--fg-4)')}<path d="M4.6 9.4 9.4 4.6" stroke="var(--fg-4)" strokeWidth="1.25" /></>}
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
 * The sidebar's dots (`SessionIndicator`), so one state looks the same on both. Waiting and failed
 * also say their word, as the sidebar's 待确认 does; running and new results are a dot.
 */
export function LiveMark({ live, words = true, className }: { live: WorkItemLive | undefined; words?: boolean; className?: string }) {
  const label = useLiveLabel();
  if (!live) return null;
  const tone = live === 'waiting' ? 'warning' : live === 'failed' ? 'danger' : 'accent';
  const spoken = words && (live === 'waiting' || live === 'failed');
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 text-2xs', live === 'waiting' ? 'text-warning' : 'text-danger', className)}>
      <StatusDot tone={tone} pulse={live === 'running'} label={spoken ? undefined : label(live)} />
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
