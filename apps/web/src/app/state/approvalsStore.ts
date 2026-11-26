import type { PluginApproval, RiffetNotice } from '@contracts';
import { api } from '@/lib/api';
import { HttpError } from '@/lib/errors';
import { createStore } from '@/lib/store';
import type { ListsStore } from './listsStore';

/** A burst of pushes costs one read. */
const PUSH_DEBOUNCE_MS = 250;

export interface ApprovalsState {
  /** Actionable write approvals plugins ask the owner to confirm (`host.approvals`). */
  approvals: PluginApproval[];
  /** Explicit messages sent to the owner's Inbox (team members' `notify_user`, wake-ups, plugin notices). */
  notices: RiffetNotice[];
  /** True once the initial read has completed, so clients only alert on items arriving afterwards. */
  loaded: boolean;
}

const keyOf = (approval: Pick<PluginApproval, 'pluginId' | 'id'>) => `${approval.pluginId}\n${approval.id}`;

/**
 * The Riffet Inbox store: actionable plugin approvals + explicit user-facing messages (`notices`).
 * Deliberately excludes work-item board status transitions so the Inbox stays high-signal.
 */
export function createApprovalsStore(lists: Pick<ListsStore, 'onPluginApprovals' | 'onInbox'>) {
  const store = createStore<ApprovalsState>({ approvals: [], notices: [], loaded: false });
  let timer: number | undefined;
  let ticket = 0;

  const read = async () => {
    const begun = ++ticket;
    const [approvalsResult, noticesResult] = await Promise.allSettled([
      api.pluginApprovals(),
      api.inboxNotices(),
    ]);
    if (begun !== ticket) return;
    const current = store.get();
    const approvals = approvalsResult.status === 'fulfilled'
      ? approvalsResult.value.approvals
      : approvalsResult.reason instanceof HttpError && approvalsResult.reason.status === 404
        ? []
        : current.approvals;
    const notices = noticesResult.status === 'fulfilled'
      ? noticesResult.value.notices
      : noticesResult.reason instanceof HttpError && noticesResult.reason.status === 404
        ? []
        : current.notices;
    store.set({ approvals, notices, loaded: true });
  };
  const later = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void read(), PUSH_DEBOUNCE_MS); };

  lists.onPluginApprovals(later);
  lists.onInbox(later);
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
    async markNoticeRead(id: string) {
      const now = new Date().toISOString();
      store.set((current) => ({
        notices: current.notices.map((entry) => (entry.id === id && !entry.readAt ? { ...entry, readAt: now } : entry)),
      }));
      try {
        const { notice } = await api.markInboxNoticeRead(id);
        store.set((current) => ({
          notices: current.notices.map((entry) => (entry.id === id ? notice : entry)),
        }));
      } catch {
        void read();
      }
    },
    async markAllNoticesRead() {
      const now = new Date().toISOString();
      store.set((current) => ({
        notices: current.notices.map((entry) => (entry.readAt ? entry : { ...entry, readAt: now })),
      }));
      try { await api.markAllInboxNoticesRead(); } catch { void read(); }
    },
    async deleteNotice(id: string) {
      store.set((current) => ({ notices: current.notices.filter((entry) => entry.id !== id) }));
      try { await api.deleteInboxNotice(id); } catch { void read(); }
    },
  };
}
