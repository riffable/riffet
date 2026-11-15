import { useLingui } from '@lingui/react/macro';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useStores, useWorkItems } from '../state/stores';
import { StatusIcon } from './parts';

/**
 * The task a conversation belongs to, beside its title in the header: its status ring and number.
 * Opens the item on the board. Nothing shows until the item list has it.
 */
export function TaskMark({ workItemId, className }: { workItemId: string; className?: string }) {
  const { t } = useLingui();
  const { workItems, nav } = useStores();
  const item = useWorkItems((state) => state.items?.find((entry) => entry.id === workItemId));
  if (!item) return null;
  // Through `navigate`, as the sidebar's entry goes: a draft's discard guard still asks first.
  const open = () => { void nav.navigate(() => { workItems.reveal(item.id); nav.openPage('tasks'); }); };
  return (
    <Tip label={item.title}>
      <button
        type="button"
        onClick={open}
        aria-label={t`打开任务 #${item.number}`}
        className={cn('inline-flex h-6 no-hover:min-h-11 shrink-0 items-center gap-1 rounded-md px-1.5 text-fg-3 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus', className)}
      >
        <StatusIcon status={item.status} />
        <span className="font-mono text-2xs tabular-nums">#{item.number}</span>
      </button>
    </Tip>
  );
}

/** A task conversation's title in a list, after the task's status ring. Without the item (not loaded, or deleted) the title alone. */
export function TaskSessionTitle({ workItemId, title }: { workItemId: string; title: string }) {
  const status = useWorkItems((state) => state.items?.find((entry) => entry.id === workItemId)?.status);
  return <>{status && <StatusIcon status={status} className="-mt-0.5 mr-1.5 inline-block align-middle" />}{title}</>;
}
