import { randomUUID } from 'node:crypto';
import type { RiffetNotice } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';

const NOTICES = 'riffet-mcp:notices';
/** Newest kept across all conversations; a notice is a prompt to look, not a record to keep. */
const MAX_NOTICES = 200;

/**
 * What agents asked to show the user (`notify_user`) and the workbench's own notes about wake-ups
 * that could not run. Kept in the settings table and announced on the lists stream as `notice` and
 * `inbox` events (docs/DEVICES.md §2).
 */
export class NoticeLog {
  private readonly listeners = new Set<(notice: RiffetNotice) => void>();
  private readonly changeListeners = new Set<() => void>();

  constructor(private readonly store: Store) {}

  private read(): RiffetNotice[] { return this.store.getSetting<RiffetNotice[]>(NOTICES, []); }

  private write(items: RiffetNotice[]): void {
    this.store.setSetting(NOTICES, items);
    for (const listener of this.changeListeners) { try { listener(); } catch { /* a reader's failure is its own */ } }
  }

  add(input: Omit<RiffetNotice, 'id' | 'createdAt'>): RiffetNotice {
    const notice: RiffetNotice = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    this.write([...this.read(), notice].slice(-MAX_NOTICES));
    for (const listener of this.listeners) { try { listener(notice); } catch { /* a reader's failure is its own */ } }
    return notice;
  }

  /** Every inbox notice across conversations, newest first. */
  listAll(): RiffetNotice[] { return [...this.read()].reverse(); }

  /** The conversation's notices, newest first. */
  list(sessionId: string): RiffetNotice[] { return this.read().filter(notice => notice.sessionId === sessionId).reverse(); }

  /** Marks one notice read; returns the updated notice or undefined if absent. */
  markRead(id: string): RiffetNotice | undefined {
    const all = this.read();
    const index = all.findIndex(item => item.id === id);
    if (index < 0) return undefined;
    const current = all[index]!;
    if (current.readAt) return current;
    const updated: RiffetNotice = { ...current, readAt: new Date().toISOString() };
    const next = [...all];
    next[index] = updated;
    this.write(next);
    return updated;
  }

  /** Marks every unread notice read; returns how many changed. */
  markAllRead(): number {
    const all = this.read();
    const now = new Date().toISOString();
    let count = 0;
    const next = all.map(item => {
      if (item.readAt) return item;
      count += 1;
      return { ...item, readAt: now };
    });
    if (count > 0) this.write(next);
    return count;
  }

  /** Removes a single notice from the inbox. */
  remove(id: string): boolean {
    const all = this.read();
    const kept = all.filter(item => item.id !== id);
    if (kept.length === all.length) return false;
    this.write(kept);
    return true;
  }

  /** Deleted conversations' notices. */
  forget(sessionIds: readonly string[]): void {
    const ids = new Set(sessionIds), all = this.read(), kept = all.filter(notice => !ids.has(notice.sessionId));
    if (kept.length !== all.length) this.write(kept);
  }

  subscribe(listener: (notice: RiffetNotice) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }
}
