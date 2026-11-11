import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';
import { isLoopbackHost } from '../connection-addresses.js';
import { proxiedRequest } from '../auth.js';
import { requireSessionVisibleToClient } from '../native/client-features.js';
import type { ExternalSessionQuery } from '../native/external-sessions.js';
import type { RouteDeps } from './deps.js';

type ListQuery = { scope?: string; projectId?: string; cwd?: string; backendId?: string; q?: string; cursor?: string; limit?: string; nonInteractive?: string; refresh?: string };

const flag = (value: string | undefined) => value === '1' || value === 'true';

/**
 * Provider conversations stored on this machine, their import, and handing a conversation to a
 * terminal (docs/TERMINAL-SESSIONS.md).
 */
export function registerExternalSessionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, externalSessions, terminalHolds } = deps;

  app.get<{ Querystring: ListQuery }>('/api/external-sessions', async request => {
    const query = request.query ?? {};
    const scope = (query.scope ?? 'all') as ExternalSessionQuery['scope'];
    return externalSessions.list({
      scope, projectId: query.projectId, cwd: query.cwd, backendId: query.backendId, q: query.q?.slice(0, 200), cursor: query.cursor,
      limit: query.limit ? Number.parseInt(query.limit, 10) || undefined : undefined,
      nonInteractive: flag(query.nonInteractive), refresh: flag(query.refresh),
    });
  });

  app.get<{ Querystring: ListQuery }>('/api/external-sessions/directories', async request => {
    const query = request.query ?? {};
    return { directories: await externalSessions.directories({ backendId: query.backendId, nonInteractive: flag(query.nonInteractive), refresh: flag(query.refresh) }) };
  });

  app.post<{ Body: { backendId?: unknown; backendProfileId?: unknown; nativeSessionId?: unknown } }>('/api/external-sessions/import', async request => {
    const result = await externalSessions.import(request.body ?? {}, request.headers);
    requireSessionVisibleToClient(request.headers, result.session, id => store.getProject(id));
    return result;
  });

  app.get<{ Params: { id: string } }>('/api/sessions/:id/resume-command', async request => {
    const session = store.getSession(request.params.id);
    requireSessionVisibleToClient(request.headers, session, id => store.getProject(id));
    return deps.nativeBackends.resumeCommand(session);
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/release-cli', async request => {
    requireSessionVisibleToClient(request.headers, store.getSession(request.params.id), id => store.getProject(id));
    return { session: await terminalHolds.releaseCli(request.params.id) };
  });

  // The launch carries the profile's credentials and runs on this machine: only `riffet resume`, beside the server, asks for it.
  const local = (request: FastifyRequest) => {
    if (!isLoopbackHost(request.ip) || proxiedRequest(request.headers)) throw new AppError('LOCAL_ONLY', 'Run `riffet resume` on the machine Riffet runs on', 403);
  };

  app.post<{ Params: { id: string } }>('/api/sessions/:id/terminal-hold', async request => {
    local(request);
    return terminalHolds.hold(request.params.id);
  });

  app.patch<{ Params: { id: string }; Body: { pid?: unknown; token?: unknown } }>('/api/sessions/:id/terminal-hold', async request => {
    local(request);
    return { session: await terminalHolds.claim(request.params.id, request.body ?? {}) };
  });

  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>('/api/sessions/:id/terminal-hold', async request => {
    requireSessionVisibleToClient(request.headers, store.getSession(request.params.id), id => store.getProject(id));
    return { session: await terminalHolds.release(request.params.id, { force: flag(request.query?.force) }) };
  });
}
