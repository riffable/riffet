import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { GitStatus } from '@contracts';
import { api, gitStatusStreamUrl, HttpError } from '@/lib/api';
import { createStore, useStore } from '@/lib/store';
import { errorMessage, reconnectDelay, singleFlight } from '@/lib/utils';

/** A project's last answer: its status, or why there is none (`code` NOT_A_GIT_REPOSITORY, say). */
export interface GitStatusEntry { status?: GitStatus; error?: string; code?: string }

/**
 * `git status` per project, shared by the header's change count and the changes panel: both show
 * the same answer, and one read serves both.
 */
const store = createStore<Record<string, GitStatusEntry>>({});
/** One shared read per project (see `singleFlight`). */
const reads = new Map<string, (fresh?: boolean) => Promise<void>>();
/** How many statuses each project's stream has delivered: a read that started before the latest one is older news. */
const pushes = new Map<string, number>();

/** One shared read per project and kind: an ordinary one, and one that makes the server look again. */
function reader(projectId: string, fresh: boolean): (later?: boolean) => Promise<void> {
  const key = `${projectId}:${fresh}`;
  let read = reads.get(key);
  if (!read) {
    read = singleFlight(() => {
      const before = pushes.get(projectId) ?? 0;
      return api.gitStatus(projectId, fresh).then(
        (status) => { if ((pushes.get(projectId) ?? 0) === before) store.set({ [projectId]: { status } }); },
        (error) => store.set({ [projectId]: { error: errorMessage(error, i18n._(msg`Couldn't read Git status`)), ...(error instanceof HttpError && error.code ? { code: error.code } : {}) } }),
      );
    });
    reads.set(key, read);
  }
  return read;
}

/**
 * Reads [projectId]'s status. A read already running is shared. `fresh` (after a write, or when
 * asked to refresh) waits for it and reads once more, since that answer may predate the write.
 */
export function refreshGitStatus(projectId: string, fresh = false): Promise<void> {
  return reader(projectId, fresh)(fresh);
}

/** The open status stream of each project being watched, shared by everything on the page that watches it. */
const streams = new Map<string, { watchers: number; close: () => void }>();

/**
 * Follows [projectId]'s status as the server pushes it: once now, then whenever the working tree or
 * the index changes. Where the stream cannot be held (an older server, a proxy that drops it) the
 * status is read on focus and when the page comes back into view instead.
 */
function openStream(projectId: string): () => void {
  let source: EventSource | undefined;
  let retryTimer: number | undefined;
  let retries = 0;
  let live = false;
  let closed = false;
  const connect = () => {
    retryTimer = undefined;
    if (closed) return;
    const current = new EventSource(gitStatusStreamUrl(projectId));
    source = current;
    current.addEventListener('status', (event) => {
      live = true; retries = 0;
      try { store.set({ [projectId]: { status: JSON.parse((event as MessageEvent<string>).data) as GitStatus } }); pushes.set(projectId, (pushes.get(projectId) ?? 0) + 1); } catch { /* A frame cut short; the next one replaces it. */ }
    });
    // Not a repository, say: the ordinary read carries the reason, and nothing more will come from here.
    current.addEventListener('unavailable', () => { live = false; current.close(); void refreshGitStatus(projectId); });
    current.onerror = () => {
      live = false;
      if (closed || source !== current || current.readyState !== EventSource.CLOSED || retryTimer !== undefined) return;
      current.close();
      retries += 1;
      void refreshGitStatus(projectId);
      retryTimer = window.setTimeout(connect, reconnectDelay(retries));
    };
  };
  connect();
  const refresh = () => { if (!live && document.visibilityState === 'visible') void refreshGitStatus(projectId); };
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  return () => {
    closed = true;
    source?.close();
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    window.removeEventListener('focus', refresh);
    document.removeEventListener('visibilitychange', refresh);
  };
}

/**
 * Keeps [projectId]'s status current for as long as something on the page shows it. Returns the
 * teardown. `fresh` also asks for a read now (a turn just ended).
 */
export function watchGitStatus(projectId: string, fresh = false): () => void {
  let stream = streams.get(projectId);
  if (!stream) { stream = { watchers: 0, close: openStream(projectId) }; streams.set(projectId, stream); }
  stream.watchers += 1;
  if (fresh) void refreshGitStatus(projectId, true);
  const held = stream;
  return () => {
    held.watchers -= 1;
    // Left open for a moment: a watcher that re-subscribes on every render-driven change would otherwise redial each time.
    window.setTimeout(() => { if (!held.watchers && streams.get(projectId) === held) { streams.delete(projectId); held.close(); } }, 2000);
  };
}

/** Whether the project can show changes. An unread status is pending, not "no repository": only a task workspace with a settled answer without one cannot. */
export function useHasGit(project: { id: string; system?: string } | undefined): boolean {
  return useStore(store, (state) => {
    const entry = project ? state[project.id] : undefined;
    return !project || project.system !== 'task-workspace' || !entry || Boolean(entry.status);
  });
}

export function useGitStatus(projectId: string | undefined): GitStatusEntry | undefined {
  return useStore(store, (state) => (projectId ? state[projectId] : undefined));
}
