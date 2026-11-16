import { isDoneUnseen, isRunningSession, needsYou, type Session, type WorkItem, type WorkItemQuestion, type WorkItemStatus } from '@contracts';
import { sessionActivityAt } from '@/lib/session-order';

/**
 * What a work item's conversations are doing now (docs/TASK-BOARD.md §4.1). Derived, never stored:
 * the same rules and dots as the sidebar's conversation rows, first match wins.
 */
export type WorkItemLive = 'waiting' | 'failed' | 'running' | 'unseen';

/** The board's columns, left to right; `cancelled` has none. */
export const BOARD_STATUSES = ['todo', 'doing', 'review', 'done'] as const satisfies readonly WorkItemStatus[];
/** The list view's groups: what needs the reader first. */
export const LIST_STATUSES = ['review', 'doing', 'todo', 'done'] as const satisfies readonly WorkItemStatus[];
const LIVE_RANK: Record<WorkItemLive, number> = { waiting: 0, failed: 1, running: 2, unseen: 3 };
/** 完成 shows this far back on the board; older ones stay in the list view. */
export const DONE_SHOWN_MS = 7 * 24 * 60 * 60_000;

export interface WorkItemView {
  item: WorkItem;
  /** Its conversations, most recent first. */
  sessions: Session[];
  title: string;
  live: WorkItemLive | undefined;
  /** The conversation the live mark comes from, which the inbox row opens. */
  liveSession: Session | undefined;
  /** The oldest question its conversations asked that nobody has answered. */
  question: WorkItemQuestion | undefined;
  inInbox: boolean;
}

export function liveOf(sessions: readonly Session[]): { live: WorkItemLive | undefined; session: Session | undefined } {
  const waiting = sessions.find(needsYou);
  if (waiting) return { live: 'waiting', session: waiting };
  const latest = sessions[0];
  if (latest && (latest.state === 'failed' || latest.state === 'interrupted')) return { live: 'failed', session: latest };
  const running = sessions.find(isRunningSession);
  if (running) return { live: 'running', session: running };
  const unseen = sessions.find(isDoneUnseen);
  return unseen ? { live: 'unseen', session: unseen } : { live: undefined, session: undefined };
}

/** Every item with what the conversations on this client say about it. */
export function viewWorkItems(items: readonly WorkItem[], sessions: readonly Session[]): WorkItemView[] {
  const byItem = new Map<string, Session[]>();
  const byId = new Map<string, Session>();
  for (const session of sessions) {
    byId.set(session.id, session);
    if (!session.workItemId) continue;
    const list = byItem.get(session.workItemId);
    if (list) list.push(session); else byItem.set(session.workItemId, [session]);
  }
  return items.map((item) => {
    const own = (byItem.get(item.id) ?? []).sort((a, b) => sessionActivityAt(b).localeCompare(sessionActivityAt(a)));
    // A closed item shows no live mark: what its conversations still do is not this item's news.
    const closed = item.status === 'done' || item.status === 'cancelled';
    const derived = closed ? { live: undefined, session: undefined } : liveOf(own);
    const question = closed ? undefined : item.questions?.[0];
    // An open question waits on the owner as an approval does.
    const { live, session } = question && derived.live !== 'waiting' ? { live: 'waiting' as const, session: own.find((entry) => entry.id === question.sessionId) } : derived;
    const followed = item.titleSessionId ? byId.get(item.titleSessionId) : undefined;
    return {
      item,
      sessions: own,
      title: followed?.title || item.title,
      live,
      liveSession: session,
      question,
      // 推不动: the 助理's supervision could not move it on (docs/TASK-BOARD.md §7).
      inInbox: !closed && (live === 'waiting' || live === 'failed' || item.status === 'review' || Boolean(item.stuck)),
    };
  });
}

/** Within a column: waiting first, then failed, running, new results, then the most recently changed. */
export function byAttention(a: WorkItemView, b: WorkItemView): number {
  return (a.live ? LIVE_RANK[a.live] : 9) - (b.live ? LIVE_RANK[b.live] : 9) || b.item.updatedAt.localeCompare(a.item.updatedAt);
}

/** The inbox: what needs the reader, waiting before failed before stuck before review. */
export function byInbox(a: WorkItemView, b: WorkItemView): number {
  const rank = (view: WorkItemView) => view.live === 'waiting' ? 0 : view.live === 'failed' ? 1 : view.item.stuck ? 2 : 3;
  return rank(a) - rank(b) || b.item.updatedAt.localeCompare(a.item.updatedAt);
}
