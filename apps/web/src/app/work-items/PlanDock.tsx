import { useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { toast } from '@/lib/toast';
import { useLists, useStores, useWorkItems } from '../state/stores';
import { AssigneeMark, StatusIcon, WorkItemNumber } from './parts';

/**
 * The 助理's plan, above its composer (docs/TASK-BOARD.md §5.1): tasks it made that wait for 开始.
 * A task leaves once it starts; its title opens it on the board.
 */
export function PlanDock() {
  const { t } = useLingui();
  const { workItems, nav } = useStores();
  const items = useWorkItems((state) => state.items);
  useEffect(() => { workItems.ensureLoaded(); }, [workItems]);
  const planned = useMemo(() => items?.filter((item) => item.source === 'assistant' && item.status === 'todo'), [items]);
  const projects = useLists((state) => state.projects);
  const [starting, setStarting] = useState<string>();
  if (!planned?.length) return null;
  const start = async (id: string) => {
    setStarting(id);
    try { await api.startWorkItem(id); }
    catch (error) { toast.error(errorMessage(error, t`无法开始这个任务`)); }
    finally { setStarting(undefined); }
  };
  const open = (id: string) => { void nav.navigate(() => { workItems.reveal(id); nav.openPage('tasks'); }); };
  return (
    <ul className="flex flex-col rounded-2xl bg-elevated px-2 py-1 max-md:border max-md:border-line-strong md:shadow-composer" aria-label={t`待开始的任务`}>
      {planned.map((item) => (
        <li key={item.id} className="flex min-h-11 min-w-0 items-center gap-2 px-1.5 md:min-h-8">
          <StatusIcon status={item.status} />
          <button type="button" onClick={() => open(item.id)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <WorkItemNumber number={item.number} />
            <span className="min-w-0 truncate text-fg hover:underline">{item.title}</span>
            <span className="shrink-0 truncate text-xs text-fg-3">{projects.find((project) => project.id === item.projectId)?.name}</span>
          </button>
          <AssigneeMark assignee={item.assignee} />
          <Button size="xs" variant="primary" busy={starting === item.id} disabled={Boolean(starting)} onClick={() => void start(item.id)}><Trans>开始</Trans></Button>
        </li>
      ))}
    </ul>
  );
}
