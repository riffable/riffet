/**
 * What a conversation asks of its reader, one definition for every client's lists and filters. The
 * Kotlin client (Android, iOS and the Mac through RiffetKit) mirrors these in `ui/sessionlist/SidebarModel.kt`.
 */
import type { Session } from './index.js';

type AttentionFields = Pick<Session, 'state' | 'archivedAt' | 'createdAt' | 'lastActivityAt' | 'seenActivityAt'>;

function instant(value: string | undefined): number {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
}

/** Waiting on the reader: a permission, a question or a plan to approve. */
export function needsYou(session: Pick<Session, 'state'>): boolean {
  return session.state === 'waiting';
}

/** A turn is underway and nothing is asked of the reader. */
export function isRunningSession(session: Pick<Session, 'state'>): boolean {
  return session.state === 'starting' || session.state === 'running' || session.state === 'cancelling';
}

/**
 * Activity arrived after the owner last saw the conversation. A missing `seenActivityAt` comes from a
 * server without read state and reads as seen; archived conversations are never unread.
 */
export function isUnread(session: AttentionFields): boolean {
  if (session.seenActivityAt === undefined || session.archivedAt) return false;
  return instant(session.lastActivityAt ?? session.createdAt) > instant(session.seenActivityAt);
}

/** Finished, failed or stopped with output the owner has not seen yet: the rows the Unread filter lists. */
export function isDoneUnseen(session: AttentionFields): boolean {
  return (session.state === 'idle' || session.state === 'failed' || session.state === 'interrupted') && isUnread(session);
}
