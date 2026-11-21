import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { PLUGIN_QUERY_BUDGET, type Project, type Session } from '../../../../packages/contracts/src/index.js';
import { AppError, requireString } from '../errors.js';
import { requireProjectVisibleToClient, requireSessionVisibleToClient } from '../native/client-features.js';
import type { RouteDeps } from '../routes/deps.js';
import type { PluginRegistry } from './registry.js';

// Read-only structured data queries served to a plugin's own views (`POST /api/integrations/:id/queries/:name`).

const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const describe = (error: unknown): string => (error instanceof Error && error.message ? error.message : String(error));

export interface QueryServiceOptions {
  registry: Pick<PluginRegistry, 'query'> & Partial<Pick<PluginRegistry, 'ensureContribution'>>;
  project(id: string): Project;
  session(id: string): Session;
  timeoutMs?: number;
}

export class QueryService {
  constructor(private readonly options: QueryServiceOptions) {}

  async run(
    pluginId: string,
    name: string,
    body: unknown,
    headers: IncomingHttpHeaders | undefined,
    requestSignal?: AbortSignal,
  ): Promise<string> {
    const queryId = `${pluginId}/${name}`;

    const payload = body === undefined || body === null ? {} : body;
    if (!isRecord(payload)) throw new AppError('INVALID_INPUT', 'Expected an object');
    const id = (value: unknown, field: string): string | undefined => value === undefined ? undefined : requireString(value, field, 200);
    let projectId = id(payload.projectId, 'projectId');
    const sessionId = id(payload.sessionId, 'sessionId');
    const locale = payload.locale == null ? undefined : requireString(payload.locale, 'locale', 35);
    if (locale !== undefined && !LOCALE.test(locale)) throw new AppError('INVALID_INPUT', 'locale must be a BCP-47 language tag');
    const params = payload.params === undefined ? {} : payload.params;
    if (!isRecord(params)) throw new AppError('INVALID_INPUT', 'params must be an object');

    if (sessionId) {
      const session = this.options.session(sessionId);
      requireSessionVisibleToClient(headers, session, project => this.options.project(project));
      if (projectId && projectId !== session.projectId) throw new AppError('INVALID_INPUT', 'sessionId does not belong to projectId');
      projectId = session.projectId;
    } else if (projectId) {
      requireProjectVisibleToClient(headers, this.options.project(projectId));
    }

    const cancelled = () => new AppError('QUERY_CANCELLED', `${queryId} was cancelled`, 499);
    if (requestSignal?.aborted) throw cancelled();
    await this.options.registry.ensureContribution?.('query', queryId).catch(() => undefined);
    const { handler, signal } = this.options.registry.query(pluginId, queryId);
    const timeoutMs = this.options.timeoutMs ?? PLUGIN_QUERY_BUDGET.timeoutMs;
    const deadline = AbortSignal.timeout(timeoutMs);
    const execution = AbortSignal.any(requestSignal ? [signal, requestSignal, deadline] : [signal, deadline]);
    const abortError = () => signal.aborted ? new AppError('QUERY_UNAVAILABLE', `${queryId} stopped because its plugin turned off`, 409)
      : requestSignal?.aborted ? cancelled()
        : new AppError('QUERY_TIMEOUT', `${queryId} did not finish within ${Math.round(timeoutMs / 1000)}s`, 504);

    let onAbort: (() => void) | undefined;
    let value: unknown;
    try {
      if (execution.aborted) throw abortError();
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortError());
        execution.addEventListener('abort', onAbort, { once: true });
      });
      value = await Promise.race([
        aborted,
        Promise.resolve().then(() => handler.run({
          ...(projectId ? { projectId } : {}),
          ...(sessionId ? { sessionId } : {}),
          params,
          ...(locale ? { locale } : {}),
          signal: execution,
        })),
      ]);
    } catch (error) {
      throw error instanceof AppError ? error : new AppError('QUERY_FAILED', describe(error), 502);
    } finally {
      if (onAbort) execution.removeEventListener('abort', onAbort);
    }

    let json: string | undefined;
    try { json = JSON.stringify(value ?? null); } catch { /* refuse non-JSON data */ }
    if (json === undefined) throw new AppError('QUERY_FAILED', `${queryId} returned non-JSON data`, 502);
    if (Buffer.byteLength(json, 'utf8') > PLUGIN_QUERY_BUDGET.resultBytes) throw new AppError('QUERY_TOO_LARGE', `${queryId} returned more than 1 MB`, 502);
    return json;
  }
}

/** `POST /api/integrations/:id/queries/:name`. */
export function registerQueryRoutes(app: FastifyInstance, deps: Pick<RouteDeps, 'plugins' | 'store'>): void {
  const queries = new QueryService({
    registry: deps.plugins,
    project: id => deps.store.getProject(id),
    session: id => deps.store.getSession(id),
  });
  app.post<{ Params: { id: string; name: string }; Body: unknown }>('/api/integrations/:id/queries/:name', { bodyLimit: PLUGIN_QUERY_BUDGET.requestBytes }, async (request, reply) => {
    const controller = new AbortController();
    const response = reply.raw;
    const onClose = () => { if (!response.writableFinished) controller.abort(); };
    if (response.destroyed) onClose();
    else response.once('close', onClose);
    try {
      const json = await queries.run(request.params.id, request.params.name, request.body, request.headers, controller.signal);
      return reply.type('application/json; charset=utf-8').send(json);
    } finally {
      response.off('close', onClose);
    }
  });
}
