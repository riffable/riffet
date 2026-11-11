import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { GitStatus } from '@contracts';
import { api, HttpError } from '@/lib/api';
import { createStore, useStore } from '@/lib/store';
import { errorMessage, singleFlight } from '@/lib/utils';

/** A project's last answer: its status, or why there is none (`code` NOT_A_GIT_REPOSITORY, say). */
export interface GitStatusEntry { status?: GitStatus; error?: string; code?: string }

/**
 * `git status` per project, shared by the header's change count and the changes panel: both show
 * the same answer, and one read serves both.
 */
const store = createStore<Record<string, GitStatusEntry>>({});
/** One shared read per project (see `singleFlight`). */
const reads = new Map<string, (fresh?: boolean) => Promise<void>>();

/**
 * Reads [projectId]'s status. A read already running is shared. `fresh` (after a write) waits for
 * it and reads once more, since that answer may predate the write; fresh callers share that read.
 */
export function refreshGitStatus(projectId: string, fresh = false): Promise<void> {
  let read = reads.get(projectId);
  if (!read) {
    read = singleFlight(() => api.gitStatus(projectId).then(
      (status) => store.set({ [projectId]: { status } }),
      (error) => store.set({ [projectId]: { error: errorMessage(error, i18n._(msg`无法读取 Git 状态`)), ...(error instanceof HttpError && error.code ? { code: error.code } : {}) } }),
    ));
    reads.set(projectId, read);
  }
  return read(fresh);
}

/**
 * Reads [projectId]'s status now and whenever the page comes back into view. Returns the teardown.
 * `fresh` makes the first read a later answer than one already running (a turn just ended).
 */
export function watchGitStatus(projectId: string, fresh = false): () => void {
  const read = (later: boolean) => { if (document.visibilityState === 'visible') void refreshGitStatus(projectId, later); };
  const refresh = () => read(false);
  read(fresh);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
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
