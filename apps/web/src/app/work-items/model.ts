import { isDoneUnseen, isRunningSession, needsYou, openPrerequisites, type Session, type WorkItem, type WorkItemQuestion, type WorkItemStatus, type WorkItemSummary } from '@contracts';
import { sessionActivityAt } from '@/lib/session-order';

/**
 * What a work item's conversations are doing now (docs/TASK-BOARD.md §4.1). Derived, never stored:
 * the same rules and dots as the sidebar's conversation rows, first match wins.
 */
export type WorkItemLive = 'waiting' | 'failed' | 'running' | 'unseen';

export const WORK_ITEM_DRAG_TYPE = 'application/x-riffet-work-item';

/** The board's columns, left to right; `watching` is its own strip and `cancelled` merges into the final column. */
export const BOARD_STATUSES = ['todo', 'doing', 'review', 'done'] as const satisfies readonly WorkItemStatus[];
/** The list view's groups: what needs the reader first. */
export const LIST_STATUSES = ['review', 'doing', 'watching', 'todo', 'done', 'cancelled'] as const satisfies readonly WorkItemStatus[];
const LIVE_RANK: Record<WorkItemLive, number> = { waiting: 0, failed: 1, running: 2, unseen: 3 };
/** 完成 shows this far back on the board; older ones stay in the list view. */
export const DONE_SHOWN_MS = 7 * 24 * 60 * 60_000;

export interface WorkItemView {
  item: WorkItem;
  /** Its conversations, most recent first. */
  sessions: Session[];
  title: string;
  live: WorkItemLive | undefined;
  /** True when the latest session failed/interrupted even after the reader saw it. */
  latestFailed: boolean;
  /** True when a watching task's scheduled resurface time has arrived. */
  watchDue: boolean;
  /** The conversation the live mark comes from, which the inbox row opens. */
  liveSession: Session | undefined;
  /** The oldest question its conversations asked that nobody has answered. */
  question: WorkItemQuestion | undefined;
  inInbox: boolean;
  /** Prerequisites not done yet, while the task waits to start (`startQueued`, docs/TASK-BOARD.md §4.4). */
  waitingOn: WorkItem[];
}

export function isWatchDue(until: string | undefined, now = Date.now()): boolean {
  if (!until) return false;
  const at = Date.parse(until);
  return Number.isFinite(at) && at <= now;
}

export function liveOf(sessions: readonly Session[]): { live: WorkItemLive | undefined; session: Session | undefined; latestFailed: boolean } {
  const waiting = sessions.find(needsYou);
  if (waiting) return { live: 'waiting', session: waiting, latestFailed: false };
  const latest = sessions[0];
  const latestFailed = Boolean(latest && (latest.state === 'failed' || latest.state === 'interrupted'));
  // Matches the sidebar rule ("失败点看过即消失"): only an unseen failure alerts in the inbox and pins above running work.
  if (latestFailed && isDoneUnseen(latest!)) return { live: 'failed', session: latest, latestFailed: true };
  const running = sessions.find(isRunningSession);
  if (running) return { live: 'running', session: running, latestFailed: false };
  const unseen = sessions.find(isDoneUnseen);
  return unseen ? { live: 'unseen', session: unseen, latestFailed } : { live: undefined, session: undefined, latestFailed };
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
  const now = Date.now();
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return items.map((item) => {
    const own = (byItem.get(item.id) ?? []).sort((a, b) => sessionActivityAt(b).localeCompare(sessionActivityAt(a)));
    // A closed item shows no live mark: what its conversations still do is not this item's news.
    const closed = item.status === 'done' || item.status === 'cancelled';
    const derived = closed ? { live: undefined, session: undefined, latestFailed: false } : liveOf(own);
    const question = closed ? undefined : item.questions?.[0];
    // An open question waits on the owner as an approval does.
    const { live, session, latestFailed } = question && derived.live !== 'waiting'
      ? { live: 'waiting' as const, session: own.find((entry) => entry.id === question.sessionId), latestFailed: derived.latestFailed }
      : derived;
    const watchDue = item.status === 'watching' && isWatchDue(item.watch?.until, now);
    const followed = item.titleSessionId ? byId.get(item.titleSessionId) : undefined;
    return {
      item,
      sessions: own,
      title: followed?.title || item.title,
      live,
      latestFailed,
      watchDue,
      liveSession: session,
      question,
      waitingOn: item.startQueued && item.status === 'doing' && own.length === 0 ? openPrerequisites(item, itemsById) : [],
      // 推不动: the 助理's supervision could not move it on (docs/TASK-BOARD.md §7).
      inInbox: !closed && (live === 'waiting' || live === 'failed' || item.status === 'review' || Boolean(item.stuck) || watchDue),
    };
  });
}

function localMidnight(value: string): number {
  return new Date(value).setHours(0, 0, 0, 0);
}

export function summarizeWorkItems(entries: readonly WorkItemView[], today: number) {
  const statuses: Record<WorkItemStatus, number> = { todo: 0, doing: 0, watching: 0, review: 0, done: 0, cancelled: 0 };
  const date = new Date(today);
  const days = Array.from({ length: 14 }, (_, index) => ({
    date: new Date(date.getFullYear(), date.getMonth(), date.getDate() - 13 + index).getTime(),
    created: 0,
    done: 0,
  }));
  const byDate = new Map(days.map((day) => [day.date, day]));
  let inbox = 0;
  let running = 0;
  let conversations = 0;
  for (const entry of entries) {
    const { item } = entry;
    statuses[item.status] += 1;
    if (entry.inInbox) inbox += 1;
    if (entry.live === 'running') running += 1;
    conversations += entry.sessions.length;
    const created = byDate.get(localMidnight(item.createdAt));
    if (created) created.created += 1;
    // The list records a task's latest status. Reopened tasks count in the trend once completed again.
    const done = item.status === 'done' ? byDate.get(localMidnight(item.statusAt)) : undefined;
    if (done) done.done += 1;
  }
  return { total: entries.length, statuses, inbox, running, conversations, days };
}

export function countWorkItemInbox(summaries: readonly WorkItemSummary[], sessions: readonly Session[]): number {
  const byItem = new Map<string, Session[]>();
  for (const session of sessions) {
    if (!session.workItemId) continue;
    const list = byItem.get(session.workItemId);
    if (list) list.push(session); else byItem.set(session.workItemId, [session]);
  }
  const now = Date.now();
  let count = 0;
  for (const item of summaries) {
    if (item.status === 'done' || item.status === 'cancelled') continue;
    if (item.status === 'review' || item.stuck || item.hasQuestion || (item.status === 'watching' && isWatchDue(item.watchUntil, now))) { count += 1; continue; }
    const own = (byItem.get(item.id) ?? []).sort((a, b) => sessionActivityAt(b).localeCompare(sessionActivityAt(a)));
    const live = liveOf(own).live;
    if (live === 'waiting' || live === 'failed') count += 1;
  }
  return count;
}

/** Within a column: waiting first, then unseen failed, running, new results, then the most recently changed. */
export function byAttention(a: WorkItemView, b: WorkItemView): number {
  return (a.live ? LIVE_RANK[a.live] : 9) - (b.live ? LIVE_RANK[b.live] : 9) || b.item.updatedAt.localeCompare(a.item.updatedAt);
}

/** Within the terminal column: most recently settled first. */
export function bySettled(a: WorkItemView, b: WorkItemView): number {
  return b.item.statusAt.localeCompare(a.item.statusAt) || b.item.updatedAt.localeCompare(a.item.updatedAt);
}

/** The inbox: waiting before unseen failed before stuck before due watch before review. */
export function byInbox(a: WorkItemView, b: WorkItemView): number {
  const rank = (view: WorkItemView) => view.live === 'waiting' ? 0 : view.live === 'failed' ? 1 : view.item.stuck ? 2 : view.watchDue ? 3 : 4;
  return rank(a) - rank(b) || b.item.updatedAt.localeCompare(a.item.updatedAt);
}
