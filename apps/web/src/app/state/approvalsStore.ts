import type { PluginApproval } from '@contracts';
import { api } from '@/lib/api';
import { HttpError } from '@/lib/errors';
import { createStore } from '@/lib/store';
import type { ListsStore } from './listsStore';

/** A burst of pushes costs one read. */
const PUSH_DEBOUNCE_MS = 250;

export interface ApprovalsState {
  /** What plugins of the entry server ask the owner to approve, oldest first (docs/TASK-BOARD.md §7). */
  approvals: PluginApproval[];
}

const keyOf = (approval: Pick<PluginApproval, 'pluginId' | 'id'>) => `${approval.pluginId}\n${approval.id}`;

/**
 * The plugin approvals of the inbox. Read when the workbench opens and on every `plugin-approvals` push; an older server
 * answers 404 and leaves the list empty.
 */
export function createApprovalsStore(lists: Pick<ListsStore, 'onPluginApprovals'>) {
  const store = createStore<ApprovalsState>({ approvals: [] });
  let timer: number | undefined;
  let ticket = 0;

  const read = async () => {
    const begun = ++ticket;
    try {
      const { approvals } = await api.pluginApprovals();
      if (begun !== ticket) return;
      store.set({ approvals });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) store.set({ approvals: [] });
      /* otherwise keep what is shown; the next push reads again */
    }
  };
  const later = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void read(), PUSH_DEBOUNCE_MS); };

  lists.onPluginApprovals(later);
  void read();

  return {
    ...store,
    reload: read,
    /** The decision's result is shown by the caller; a decided approval leaves the list at once, a refused one stays. */
    async decide(approval: PluginApproval, actionId: string) {
      const result = await api.decidePluginApproval(approval.pluginId, approval.id, { actionId });
      ticket += 1;
      store.set((current) => ({ approvals: current.approvals.filter((entry) => keyOf(entry) !== keyOf(approval)) }));
      return result;
    },
  };
}

export type ApprovalsStore = ReturnType<typeof createApprovalsStore>;
