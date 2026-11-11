import { randomUUID } from 'node:crypto';
import type { RiffetNotice } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';

const NOTICES = 'riffet-mcp:notices';
/** Newest kept across all conversations; a notice is a prompt to look, not a record to keep. */
const MAX_NOTICES = 200;

/**
 * What agents asked to show the user (`notify_user`) and the workbench's own notes about wake-ups
 * that could not run. Kept in the settings table and announced on the lists stream as a `notice`
 * event, which clients that listen only for `changed` ignore (docs/DEVICES.md §2).
 */
export class NoticeLog {
  private readonly listeners = new Set<(notice: RiffetNotice) => void>();

  constructor(private readonly store: Store) {}

  private read(): RiffetNotice[] { return this.store.getSetting<RiffetNotice[]>(NOTICES, []); }

  add(input: Omit<RiffetNotice, 'id' | 'createdAt'>): RiffetNotice {
    const notice: RiffetNotice = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    this.store.setSetting(NOTICES, [...this.read(), notice].slice(-MAX_NOTICES));
    for (const listener of this.listeners) { try { listener(notice); } catch { /* a reader's failure is its own */ } }
    return notice;
  }

  /** The conversation's notices, newest first. */
  list(sessionId: string): RiffetNotice[] { return this.read().filter(notice => notice.sessionId === sessionId).reverse(); }

  /** Deleted conversations' notices. */
  forget(sessionIds: readonly string[]): void {
    const ids = new Set(sessionIds), all = this.read(), kept = all.filter(notice => !ids.has(notice.sessionId));
    if (kept.length !== all.length) this.store.setSetting(NOTICES, kept);
  }

  subscribe(listener: (notice: RiffetNotice) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
