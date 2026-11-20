import { useEffect, useMemo } from 'react';
import type { Task, TaskActionsResponse, TaskConfirmation, TaskCreate, TaskLogChunk, TasksResponse } from '@contracts';
import { request } from '@/lib/api';
import { HttpError } from '@/lib/errors';
import { usePlugins } from '@/lib/plugins';
import { createStore, useStore } from '@/lib/store';

/** Project tasks (docs/TASKS.md). A task is the server's, so nothing here ties one to the view that asked for it. */
const enc = encodeURIComponent;

export const tasksApi = {
  list: async (projectId: string, limit: number, signal?: AbortSignal): Promise<Task[]> =>
    (await request<TasksResponse>(`/api/tasks?projectId=${enc(projectId)}&limit=${limit}`, { ...(signal ? { signal } : {}) })).tasks,
  /** One plugin's recent tasks across projects, newest first. */
  listByPlugin: async (pluginId: string, limit: number, signal?: AbortSignal): Promise<Task[]> =>
    (await request<TasksResponse>(`/api/tasks?pluginId=${enc(pluginId)}&limit=${limit}`, { ...(signal ? { signal } : {}) })).tasks,
  get: (id: string, signal?: AbortSignal) => request<Task>(`/api/tasks/${enc(id)}`, { ...(signal ? { signal } : {}) }),
  start: (body: TaskCreate) => request<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(body) }),
  cancel: (id: string) => request<Task>(`/api/tasks/${enc(id)}/cancel`, { method: 'POST' }),
  log: (id: string, from: number, limit: number, signal?: AbortSignal) =>
    request<TaskLogChunk>(`/api/tasks/${enc(id)}/log?from=${from}&limit=${limit}`, { ...(signal ? { signal } : {}) }),
  artifactUrl: (id: string, artifactId: string) => `/api/tasks/${enc(id)}/artifacts/${enc(artifactId)}`,
};

/** The actions each project's task providers offer now, and the project types they imply; one read per project at a time. */
const actions = createStore<{ byProject: Readonly<Record<string, TaskActionsResponse>> }>({ byProject: {} });
const reading = new Map<string, Promise<void>>();

/**
 * Reads `GET /api/projects/:id/task-actions` into the cache. A failure keeps what is cached, and
 * with nothing cached no project type is known, which leaves every view that asks for one hidden.
 */
export function refreshTaskActions(projectId: string): Promise<void> {
  let pending = reading.get(projectId);
  if (!pending) {
    pending = request<TaskActionsResponse>(`/api/projects/${enc(projectId)}/task-actions`).then(
      (response) => actions.set((current) => {
        const known = current.byProject[projectId];
        return known && JSON.stringify(known) === JSON.stringify(response) ? {} : { byProject: { ...current.byProject, [projectId]: response } };
      }),
      () => undefined,
    ).finally(() => reading.delete(projectId));
    reading.set(projectId, pending);
  }
  return pending;
}

/** The cached answer for the project, read again when the project or the set of plugins changes. */
export function useTaskActions(projectId: string | undefined): TaskActionsResponse | undefined {
  const plugins = usePlugins();
  const cached = useStore(actions, (state) => (projectId ? state.byProject[projectId] : undefined));
  useEffect(() => { if (projectId) void refreshTaskActions(projectId); }, [projectId, plugins]);
  return cached;
}

const NO_TYPES: ReadonlySet<string> = new Set();

/** What a view's `when.projectType` is judged against for this project: the types its task providers report. */
export function useProjectTypes(projectId: string | undefined): ReadonlySet<string> {
  const cached = useTaskActions(projectId);
  return useMemo(() => (cached?.projectTypes.length ? new Set(cached.projectTypes) : NO_TYPES), [cached]);
}

/** The confirmation `error` asks for, or `undefined` when it is any other failure. */
export function taskConfirmation(error: unknown): TaskConfirmation | undefined {
  if (!(error instanceof HttpError) || error.code !== 'TASK_CONFIRM_REQUIRED') return undefined;
  const { fingerprint, plan } = (error.details ?? {}) as Partial<TaskConfirmation>;
  if (typeof fingerprint !== 'string' || !plan || typeof plan.file !== 'string' || !Array.isArray(plan.args)) return undefined;
  return { fingerprint, plan: { file: plan.file, args: plan.args.map(String), cwd: typeof plan.cwd === 'string' ? plan.cwd : '', env: plan.env && typeof plan.env === 'object' ? plan.env : {} } };
}

/** `file` and `args` as one shell line, quoting what a shell would split or expand, for the user to read. */
export function commandLine(plan: Pick<TaskConfirmation['plan'], 'file' | 'args'>): string {
  const quote = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);
  return [plan.file, ...plan.args].map(quote).join(' ');
}

/** The task a command started and the tasks view should select once it is shown; the view consumes it. */
const focused = createStore<{ taskId: string | undefined }>({ taskId: undefined });

export const focusTask = (taskId: string): void => focused.set({ taskId });
export const useFocusedTask = (): string | undefined => useStore(focused, (state) => state.taskId);
export const clearFocusedTask = (taskId: string): void => { if (focused.get().taskId === taskId) focused.set({ taskId: undefined }); };
