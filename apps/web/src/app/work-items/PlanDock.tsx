import { useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { HttpError, errorMessage } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { readStored, writeStored } from '@/lib/utils';
import { useLists, useStores, useWorkItems } from '../state/stores';
import { AssigneeMark, StatusIcon, WorkItemNumber } from './parts';

const DISMISSED_KEY = 'riffet.assistant.dismissedPlans';
const MAX_DISMISSED = 200;

function readDismissed(): ReadonlySet<string> {
  try {
    const raw = readStored(DISMISSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch { return new Set(); }
}

function writeDismissed(ids: ReadonlySet<string>): void {
  writeStored(DISMISSED_KEY, ids.size ? JSON.stringify([...ids].slice(-MAX_DISMISSED)) : undefined);
}

/**
 * The 助理's plan, above its composer (docs/TASK-BOARD.md §5.1): tasks it made that wait for 开始.
 * A task leaves once started, opened on the board, or dismissed here (staying in 待办 on the board).
 */
export function PlanDock() {
  const { t } = useLingui();
  const { workItems, nav } = useStores();
  const items = useWorkItems((state) => state.items);
  useEffect(() => { workItems.ensureLoaded(); }, [workItems]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(readDismissed);
  const planned = useMemo(() => items?.filter((item) => item.source === 'assistant' && item.status === 'todo' && !dismissed.has(item.id)), [items, dismissed]);
  const projects = useLists((state) => state.projects);
  const [starting, setStarting] = useState<string>();
  if (!planned?.length) return null;

  const dismiss = (id: string) => setDismissed((current) => {
    if (current.has(id)) return current;
    const next = new Set(current);
    next.add(id);
    writeDismissed(next);
    return next;
  });

  const undismiss = (id: string) => setDismissed((current) => {
    if (!current.has(id)) return current;
    const next = new Set(current);
    next.delete(id);
    writeDismissed(next);
    return next;
  });

  const start = async (id: string) => {
    setStarting(id);
    dismiss(id);
    try {
      const { item } = await api.startWorkItem(id);
      workItems.accept(item);
    } catch (error) {
      const settled = error instanceof HttpError && (error.code === 'WORK_ITEM_STARTED' || error.code === 'WORK_ITEM_DONE' || error.code === 'WORK_ITEM_NOT_FOUND');
      if (!settled) undismiss(id);
      toast.error(errorMessage(error, t`无法开始这个任务`));
    } finally {
      setStarting(undefined);
    }
  };

  const open = (id: string) => {
    dismiss(id);
    void nav.navigate(() => { workItems.reveal(id); nav.openPage('tasks'); });
  };

  return (
    <ul className="flex flex-col rounded-2xl bg-elevated px-2 py-1 max-md:border max-md:border-line-strong md:shadow-composer" aria-label={t`待开始的任务`}>
      {planned.map((item) => (
        <li key={item.id} className="flex min-h-11 min-w-0 items-center gap-2 px-1.5 md:min-h-8">
          <StatusIcon status={item.status} />
          <button type="button" onClick={() => open(item.id)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <WorkItemNumber number={item.number} />
            <AssigneeMark assignee={item.assignee} />
            <span className="min-w-0 truncate text-fg hover:underline">{item.title}</span>
            <span className="shrink-0 truncate text-xs text-fg-3">{projects.find((project) => project.id === item.projectId)?.name}</span>
          </button>
          <span className="flex shrink-0 items-center gap-1.5">
            <Button size="xs" variant="secondary" busy={starting === item.id} onClick={() => void start(item.id)}><Trans>开始</Trans></Button>
            <Button size="xs" variant="secondary" onClick={() => dismiss(item.id)}><Trans>移除</Trans></Button>
          </span>
        </li>
      ))}
    </ul>
  );
}
