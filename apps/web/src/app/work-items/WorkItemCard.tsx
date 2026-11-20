import { useState, type DragEvent } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { IconCheck, IconEye, IconMessageSquareText, IconSlash } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/controls';
import { RowActions, rowConceal } from '@/components/ui/list-row';
import { Tip } from '@/components/ui/tooltip';
import { relativeTime } from '@/lib/i18n/format';
import { cn } from '@/lib/utils';
import { WORK_ITEM_DRAG_TYPE, type WorkItemView } from './model';
import { activateWorkItem, AssigneeMark, LiveMark, StatusIcon, useSubmissionClue, WorkItemNumber } from './parts';

export function WorkItemCard({
  entry, projectName, progress, parentNumber, selected, onDragStart, onDragEnd, onOpen, onOpenSession, onWatch, onDone, onDismiss,
}: {
  entry: WorkItemView;
  projectName: string | undefined;
  progress?: { done: number; total: number };
  parentNumber?: number;
  selected: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
  onOpenSession: (sessionId: string) => void;
  onWatch: () => void;
  onDone: () => void;
  onDismiss: () => void;
}) {
  const { t } = useLingui();
  const { item, sessions, title, live, latestFailed } = entry;
  const [dragging, setDragging] = useState(false);
  const closed = item.status === 'done' || item.status === 'cancelled';
  const latestSession = entry.liveSession ?? sessions[0];
  const reviewHint = useSubmissionClue(item);
  const showActions = Boolean(latestSession || !closed);

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      aria-pressed={selected}
      data-work-item=""
      onClick={onOpen}
      onKeyDown={activateWorkItem(onOpen)}
      onDragStart={(event: DragEvent) => { event.dataTransfer.setData(WORK_ITEM_DRAG_TYPE, item.id); event.dataTransfer.effectAllowed = 'move'; setDragging(true); onDragStart(); }}
      onDragEnd={() => { setDragging(false); onDragEnd(); }}
      className={cn(
        'group/row cursor-default select-none rounded-xl px-3 py-2.5 text-left outline-none transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus motion-safe:transition-[background-color,translate]',
        selected ? 'bg-active' : 'bg-subtle hover:bg-hover dark:bg-elevated [&:active:not(:has(button:active))]:bg-active',
        dragging ? 'opacity-40' : 'motion-safe:hover:-translate-y-0.5 motion-safe:active:translate-y-0',
      )}
    >
      <div className="flex h-4 min-w-0 items-center gap-1.5">
        {closed && <StatusIcon status={item.status} className="size-3.5" />}
        <WorkItemNumber number={item.number} />
        {projectName && <span className="min-w-0 truncate text-2xs text-fg-4">{projectName}</span>}
        {parentNumber !== undefined && <span className="shrink-0 text-2xs tabular-nums text-fg-4">· #{parentNumber}</span>}
        <LiveMark live={live} className="ml-auto" />
      </div>
      <p className={cn('mb-2 mt-1.5 line-clamp-2 text-sm leading-snug', closed ? 'text-fg-2' : 'font-medium text-fg')}>{title}</p>
      {item.labels.length > 0 && <div className="-mt-0.5 mb-2 flex flex-wrap gap-1">{item.labels.map((label) => <Badge key={label}>{label}</Badge>)}</div>}
      {reviewHint && <p className="-mt-0.5 mb-2 truncate text-2xs text-fg-3">{reviewHint}</p>}
      {!live && latestFailed && !closed && <p className="-mt-0.5 mb-2 truncate text-2xs text-fg-4"><Trans>上次会话失败</Trans></p>}
      <div className="flex min-h-6 items-center gap-x-2 gap-y-1 text-2xs text-fg-3 no-hover:flex-wrap">
        <AssigneeMark assignee={item.assignee} />
        {sessions.length > 1 && <span>{t`${sessions.length} 个会话`}</span>}
        {progress && <span className="tabular-nums">{progress.done}/{progress.total}</span>}
        <span className={cn('ml-auto grid shrink-0 items-center justify-items-end', showActions && 'no-hover:basis-full')}>
          <span className={cn('col-start-1 row-start-1 tabular-nums text-fg-4', showActions && rowConceal)}>{relativeTime(closed ? item.statusAt : item.updatedAt)}</span>
          {showActions && <RowActions className="col-start-1 row-start-1 gap-0.5" onClick={(event) => event.stopPropagation()}>
            {latestSession && (
              <Tip label={t`打开会话`}>
                <Button size="icon-xs" variant="quiet" aria-label={t`打开会话`} onClick={() => onOpenSession(latestSession.id)}><IconMessageSquareText /></Button>
              </Tip>
            )}
            {!closed && <>
              {item.status !== 'watching' && (
                <Tip label={t`转入观测`}>
                  <Button size="icon-xs" variant="quiet" aria-label={t`转入观测`} onClick={onWatch}><IconEye /></Button>
                </Tip>
              )}
              <Tip label={t`完成`}>
                <Button size="icon-xs" variant="quiet" aria-label={t`完成`} onClick={onDone}><IconCheck /></Button>
              </Tip>
              <Tip label={t`无需关注`}>
                <Button size="icon-xs" variant="quiet" aria-label={t`无需关注`} onClick={onDismiss}><IconSlash /></Button>
              </Tip>
            </>}
          </RowActions>}
        </span>
      </div>
    </div>
  );
}
