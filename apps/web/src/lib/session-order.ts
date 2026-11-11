import type { Session } from '@contracts';

/** The conversation's activity time is separate from metadata edits and session views. */
export function sessionActivityAt(session: Pick<Session, 'createdAt' | 'lastActivityAt'>): string {
  return session.lastActivityAt ?? session.createdAt;
}

/** Epoch millis for a timestamp, or 0 when a peer sends something unparsable. */
function instant(value: string | undefined): number {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
}

const ACTIVE_STATES: ReadonlySet<Session['state']> = new Set(['starting', 'running', 'waiting', 'cancelling']);

/** Starting, running, waiting on the reader or being cancelled: a turn is still open. */
export function isActiveSession(session: Pick<Session, 'state'>): boolean {
  return ACTIVE_STATES.has(session.state);
}

/** A conversation's ordering inputs, with every timestamp parsed once rather than per comparison. */
interface ActivityKey {
  pinnedAt: string | undefined;
  pinRank: number | undefined;
  active: boolean;
  activeSince: number;
  activity: number;
  created: number;
}

function activityKey(session: Session): ActivityKey {
  return {
    pinnedAt: session.pinnedAt || undefined,
    pinRank: session.pinRank,
    active: isActiveSession(session),
    // A server that predates `activeSince` falls back to creation, which is at least stable.
    activeSince: instant(session.activeSince ?? session.createdAt),
    activity: instant(sessionActivityAt(session)),
    created: instant(session.createdAt),
  };
}

/** Pinned order by `pinRank` ascending; an unranked pin (newer than any rank) goes first, unranked pins by newest pin. */
export function comparePinnedSessions(a: Session, b: Session): number {
  return comparePins(a.pinRank, a.pinnedAt, b.pinRank, b.pinnedAt);
}

function comparePins(aRank: number | undefined, aPinnedAt: string | undefined, bRank: number | undefined, bPinnedAt: string | undefined): number {
  if (aRank !== undefined && bRank !== undefined) return aRank - bRank;
  if (aRank !== undefined || bRank !== undefined) return aRank === undefined ? -1 : 1;
  return (bPinnedAt ?? '').localeCompare(aPinnedAt ?? '');
}

function compareKeys(a: ActivityKey, b: ActivityKey, pinned: 'time' | 'rank' = 'time'): number {
  if (Boolean(a.pinnedAt) !== Boolean(b.pinnedAt)) return a.pinnedAt ? -1 : 1;

  if (a.pinnedAt && b.pinnedAt) {
    const pinTime = pinned === 'rank' ? comparePins(a.pinRank, a.pinnedAt, b.pinRank, b.pinnedAt) : b.pinnedAt.localeCompare(a.pinnedAt);
    if (pinTime) return pinTime;
  }

  // Timestamps are compared as instants: string order breaks as soon as two records carry different
  // precision (`...:00Z` vs `...:00.000Z`), which the CLI's own values do.
  if (!a.pinnedAt && !b.pinnedAt) {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.active) return b.activeSince - a.activeSince || b.created - a.created;
  }

  return b.activity - a.activity || b.created - a.created;
}

/**
 * Pinned conversations first, then active ones, then the rest by actual conversation activity.
 * Active conversations sort by when they became active rather than by their latest output, so
 * several streaming turns keep their places instead of trading the top row on every update.
 */
export function compareSessionsByActivity(a: Session, b: Session): number {
  return compareKeys(activityKey(a), activityKey(b));
}

/** `pinned: 'rank'` orders the pinned block by `comparePinnedSessions`; the default keeps newest pin first. */
export function sortSessionsByActivity(sessions: readonly Session[], options?: { pinned?: 'time' | 'rank' }): Session[] {
  const pinned = options?.pinned ?? 'time';
  return sessions
    .map((session) => ({ session, key: activityKey(session) }))
    .sort((a, b) => compareKeys(a.key, b.key, pinned))
    .map(({ session }) => session);
}
