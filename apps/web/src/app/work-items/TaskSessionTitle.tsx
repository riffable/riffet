import { useWorkItems } from '../state/stores';
import { StatusIcon } from './parts';

/** A task conversation's title in a list, after the task's status ring. Without the item (not loaded, or deleted) the title alone. */
export function TaskSessionTitle({ workItemId, title }: { workItemId: string; title: string }) {
  const status = useWorkItems((state) => state.items?.find((entry) => entry.id === workItemId)?.status);
  return <>{status && <StatusIcon status={status} className="-mt-0.5 mr-1.5 inline-block align-middle" />}{title}</>;
}
