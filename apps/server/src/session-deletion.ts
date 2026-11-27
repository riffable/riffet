import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import type { NativeStatus, Session, SessionDeletionPreview, SessionDeletionReceipt } from '../../../packages/contracts/src/index.js';
import { AppError } from './errors.js';
import { workspaceObserver } from './backends/shared/workspace-observer.js';
import type { Store } from './store.js';
import type { SessionCommands } from './orchestration/session-commands.js';
import type { SessionLock } from './agent-host/session-lock.js';
import { sessionVisibleToClient } from './native/client-features.js';
import { isAgentTerminal } from './terminal/kinds.js';

/**
 * Deleting a conversation (docs/design/session-deletion.md): the conversation and its side chats go
 * together, in one transaction, and their ids are kept so no retried request recreates them. Only an
 * idle conversation is deleted; nothing is stopped or cancelled on the user's behalf.
 *
 * Order matters: what produces new data (the runtime, its terminal, the transcript reader) is stopped
 * while the rows still exist, since stopping reads them; then the rows go; then the files. A late
 * writer finds the conversation deleted (`Store.isSessionDeleted`) and writes nothing.
 */
export interface SessionDeletionDeps {
  store: Store;
  stateDir: string;
  sessionCommands: SessionCommands;
  sessionLock: SessionLock;
  dispatch: { busy(sessionId: string): boolean; forget?(sessionId: string): Promise<void> };
  nativeBackends: { status(sessionId: string): NativeStatus; dispose(sessionId: string): Promise<void> };
  terminal: { stop(id: string): Promise<void> };
  ingest: { forget(sessionId: string): void };
  liveIndex: { forget(sessionId: string): void };
  timeline: { drop(sessionId: string): void };
  turnSummaries: { forget(sessionId: string): void };
  shares: { busy(sessionId: string): boolean };
  orchestration: { schedulesUsing(ids: readonly string[]): number; cancelWakeupsOf(ids: readonly string[]): void; forgetSessions(ids: readonly string[]): void };
  notices: { forget(ids: readonly string[]): void };
  /** The Agent calls the conversations made or were (docs/AGENT-CALLS.md §7). */
  agentCalls?: { forget(ids: readonly string[]): void };
  riffetMcp: { revoke(sessionId: string): void };
  planFiles: { remove(sessionId: string): Promise<void> };
  /** A file cleanup that failed; it is retried at the next start. */
  onCleanupError?(sessionId: string, error: unknown): void;
}

const ACTIVE_STATES: ReadonlySet<Session['state']> = new Set(['starting', 'running', 'waiting', 'cancelling']);
const blocked = (reason: 'running' | 'share') => new AppError('SESSION_DELETE_BLOCKED', reason === 'share' ? 'A share operation of this conversation is in progress' : 'Stop or finish the conversation’s tasks before deleting it', 409, undefined, { reason });

export class SessionDeletion {
  private readonly deleting = new Set<string>();

  constructor(private readonly deps: SessionDeletionDeps) {}

  preview(rootId: string, headers?: IncomingHttpHeaders): SessionDeletionPreview {
    const sessionIds = this.scope(rootId, headers);
    let blocker: SessionDeletionPreview['blocker'];
    try { this.assertIdle(sessionIds); } catch (error) {
      if (!(error instanceof AppError)) throw error;
      blocker = { code: error.code, message: error.message, ...(error.params ? { params: error.params } : {}) };
    }
    return { sessionIds, ...(blocker ? { blocker } : {}), effects: { discussions: sessionIds.length - 1, schedules: this.deps.orchestration.schedulesUsing(sessionIds) } };
  }

  /** `expected` is the set the user confirmed; a different set now is confirmed again rather than widened. */
  async delete(rootId: string, expected: unknown, headers?: IncomingHttpHeaders): Promise<SessionDeletionReceipt> {
    if (!Array.isArray(expected) || !expected.length || expected.some(id => typeof id !== 'string')) throw new AppError('INVALID_SUBMISSION', 'sessionIds must list the conversations confirmed for deletion');
    const { store, sessionCommands, sessionLock } = this.deps;
    const confirmed = new Set(expected as string[]);
    const check = () => {
      const ids = this.scope(rootId, headers);
      if (ids.length !== confirmed.size || ids.some(id => !confirmed.has(id))) throw new AppError('SESSION_DELETE_SCOPE_CHANGED', 'The conversation changed; confirm the deletion again', 409);
      return ids;
    };
    let ids = check();
    if (ids.some(id => this.deleting.has(id))) throw new AppError('SESSION_DELETING', 'Conversation is being deleted', 409);
    this.assertIdle(ids);
    for (const id of ids) this.deleting.add(id);
    const fences = ids.map(id => sessionCommands.beginDelete(id));
    try {
      // One fixed order for every lock, so two operations on overlapping sets cannot wait on each other.
      const locked = [...ids].sort();
      const withLocks = (index: number, fn: () => Promise<SessionDeletionReceipt>): Promise<SessionDeletionReceipt> =>
        index === locked.length ? fn() : sessionLock.withSession(locked[index]!, () => withLocks(index + 1, fn));
      return await withLocks(0, async () => {
        ids = check();
        this.assertIdle(ids);
        for (const id of ids) await this.stop(id);
        // Anything started or opened while the runtime was being stopped keeps the conversation.
        check();
        this.assertIdle(ids);
        const record = store.transaction(() => {
          check();
          // A message accepted since the last check (its admission passed before the fence went up) keeps the conversation.
          if (ids.some(id => store.listUnfinishedNativeRuns(id).some(run => !run.native?.queueReleasedAt))) throw blocked('running');
          // Past every check, so a refused deletion leaves them pending; the rows still exist for the devices' lease cancels.
          this.deps.orchestration.cancelWakeupsOf(ids);
          for (const id of ids) {
            this.deps.timeline.drop(id);
            this.deps.turnSummaries.forget(id);
            if (this.hasStatsCursor()) store.db.prepare('DELETE FROM stats_cursor WHERE session_id=?').run(id);
            this.forgetTerminals(id);
          }
          this.deps.orchestration.forgetSessions(ids);
          this.deps.notices.forget(ids);
          this.deps.agentCalls?.forget(ids);
          // Marks outlive their conversation and now read as orphaned; clients re-read them.
          const marked = store.sessionsWithMarks();
          if (ids.some(id => marked.has(id))) store.marksChanged();
          return store.deleteSessions(rootId, ids);
        });
        for (const id of ids) this.deps.riffetMcp.revoke(id);
        await this.cleanup(ids);
        return { sessionIds: record.sessionIds ?? ids, deletedAt: record.deletedAt };
      });
    } finally {
      for (const release of fences) release();
      for (const id of ids) this.deleting.delete(id);
    }
  }

  private hasStatsCursor(): boolean {
    return Boolean(this.deps.store.db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='stats_cursor'").get());
  }

  /** Files and companion L1/L2 rows of conversations deleted before a crash or a failed cleanup; run at start-up. */
  async resumeCleanup(): Promise<void> {
    const pending = this.deps.store.pendingDeletionCleanups();
    for (const id of pending) {
      try {
        this.deps.timeline.drop(id);
        this.deps.store.purgeDeletedSessionArtifacts(id);
      } catch (error) { this.deps.onCleanupError?.(id, error); }
    }
    await this.cleanup(pending);
  }

  /** The conversation and its side chats, root first, refused whole if the client cannot see one of them. */
  private scope(rootId: string, headers?: IncomingHttpHeaders): string[] {
    const { store } = this.deps;
    const root = store.getSession(rootId);
    const discussions = root.origin?.kind === 'discussion' ? [] : store.listSessions().filter(item => item.origin?.kind === 'discussion' && item.origin.sessionId === root.id);
    const members = [root, ...discussions];
    if (headers && members.some(item => !sessionVisibleToClient(headers, item, id => store.getProject(id)))) throw new AppError('FEATURE_REQUIRED', 'Update the client to delete this conversation', 409);
    return members.map(item => item.id);
  }

  private assertIdle(ids: readonly string[]): void {
    const { store, dispatch, nativeBackends, sessionCommands, shares } = this.deps;
    for (const id of ids) {
      const session = store.getSession(id);
      if (ACTIVE_STATES.has(session.state) || dispatch.busy(id) || sessionCommands.isArchiving(id) || sessionCommands.isConfiguring(id)) throw blocked('running');
      const status = nativeBackends.status(id);
      if (['starting', 'busy', 'attention'].includes(status.phase) || status.activity?.compacting || (status.activity?.background ?? 0) > 0) throw blocked('running');
      if (shares.busy(id)) throw blocked('share');
    }
  }

  /** What could still write: the runtime (which reads its address from the row), its terminal and the transcript reader. */
  private async stop(id: string): Promise<void> {
    const { store, dispatch, nativeBackends, terminal, ingest } = this.deps;
    await dispatch.forget?.(id);
    await nativeBackends.dispose(id);
    for (const item of store.listTerminals()) if (item.sessionId === id && isAgentTerminal(item) && item.state !== 'exited') await terminal.stop(item.id);
    ingest.forget(id);
    this.deps.liveIndex.forget(id);
  }

  /** An agent's terminal goes with its conversation; a shell opened from it stays, no longer tied to it. */
  private forgetTerminals(id: string): void {
    const { store } = this.deps;
    for (const item of store.listTerminals()) {
      if (item.sessionId !== id) continue;
      if (isAgentTerminal(item)) store.deleteTerminal(item.id);
      else { const { sessionId: _sessionId, ...unlinked } = item; store.saveTerminal(unlinked); }
    }
  }

  /** Files outside the database; a failure leaves the record pending, retried at the next start. Paths come from the id, never the client. */
  private async cleanup(ids: readonly string[]): Promise<void> {
    const { store, stateDir, planFiles } = this.deps;
    for (const id of ids) {
      try {
        await rm(join(stateDir, 'chat', `${encodeURIComponent(id)}.jsonl`), { force: true });
        if (id && id !== '.' && id !== '..') {
          await rm(join(stateDir, 'chat', 'wire', encodeURIComponent(id)), { recursive: true, force: true });
        }
        // What its commands were seen to change holds the contents of the files they changed.
        workspaceObserver(stateDir).forget(id);
        // A client-chosen id is only ever a single path segment here; anything else is left to the context sweep.
        if (/^[\w.-]+$/.test(id) && id !== '.' && id !== '..') await rm(join(stateDir, 'contexts', id), { recursive: true, force: true });
        await planFiles.remove(id);
        store.deletionCleaned(id);
      } catch (error) { this.deps.onCleanupError?.(id, error); }
    }
  }
}
