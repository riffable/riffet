import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { TaskActionsResponse, TasksResponse } from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import { requireProjectVisibleToClient } from '../native/client-features.js';
import type { RouteDeps } from '../routes/deps.js';
import { contentDisposition } from '../workspace/download.js';
import { MAX_LOG_BYTES } from './service.js';

/** Project tasks (docs/TASKS.md). Nothing here ties a task to the request that asked for it. */
export function registerTaskRoutes(app: FastifyInstance, deps: Pick<RouteDeps, 'tasks' | 'store'>): void {
  const { tasks, store } = deps;
  const integer = (value: unknown, name: string, fallback: number, max: number): number => {
    if (value === undefined) return fallback;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0 || number > max) throw new AppError('INVALID_INPUT', `${name} must be an integer from 0 to ${max}`);
    return number;
  };
  /** A task of a project this client may not see is not found; one whose project is gone is not served either. */
  const visible = async (request: { headers: import('node:http').IncomingHttpHeaders }, id: string) => {
    const task = await tasks.get(id);
    requireProjectVisibleToClient(request.headers, store.getProject(task.projectId));
    return task;
  };

  // The `:id` is the project's, so the project visibility hook covers it.
  app.get<{ Params: { id: string } }>('/api/projects/:id/task-actions', async (request): Promise<TaskActionsResponse> => tasks.actions(request.params.id));

  app.post('/api/tasks', { bodyLimit: 16 * 1024 }, async request => {
    const projectId = (request.body as { projectId?: unknown } | null | undefined)?.projectId;
    if (typeof projectId === 'string') requireProjectVisibleToClient(request.headers, store.getProject(projectId));
    return tasks.start(request.body);
  });
  app.get<{ Querystring: { projectId?: string; limit?: string } }>('/api/tasks', async (request): Promise<TasksResponse> => {
    if (typeof request.query.projectId !== 'string' || !request.query.projectId) throw new AppError('INVALID_INPUT', 'projectId is required');
    return { tasks: await tasks.list(request.query.projectId, integer(request.query.limit, 'limit', 20, 100)) };
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async request => visible(request, request.params.id));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', { bodyLimit: 4096 }, async request => {
    await visible(request, request.params.id);
    return tasks.cancel(request.params.id);
  });
  app.get<{ Params: { id: string }; Querystring: { from?: string; limit?: string } }>('/api/tasks/:id/log', async request => {
    await visible(request, request.params.id);
    return tasks.log(request.params.id, integer(request.query.from, 'from', 0, Number.MAX_SAFE_INTEGER), Math.max(1, Math.min(integer(request.query.limit, 'limit', 64 * 1024, Number.MAX_SAFE_INTEGER), MAX_LOG_BYTES)));
  });
  app.get<{ Params: { id: string; artifactId: string } }>('/api/tasks/:id/artifacts/:artifactId', async (request, reply) => {
    await visible(request, request.params.id);
    const { file, name, size } = await tasks.artifact(request.params.id, request.params.artifactId);
    return reply.type('application/octet-stream').header('Content-Disposition', contentDisposition('attachment', name)).header('Content-Length', size).send(createReadStream(file));
  });
}
