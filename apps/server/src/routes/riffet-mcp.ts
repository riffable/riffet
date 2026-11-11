import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './deps.js';

/**
 * The shim's entry. It takes only a conversation-bound Riffet MCP credential, checked by the
 * service, even on a loopback binding without a sign-in; that credential opens nothing else.
 */
export const RIFFET_MCP_ROUTE = '/api/riffet-mcp';

export function registerRiffetMcpRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, orchestration, riffetMcp, notices } = deps;
  app.post<{ Body: { method?: unknown; params?: unknown } }>(RIFFET_MCP_ROUTE, async (request, reply) => {
    // A device call waits for the device; the shim giving up (the agent was interrupted) cancels it.
    const aborted = new AbortController();
    reply.raw.once('close', () => { if (!reply.raw.writableFinished) aborted.abort(); });
    return { result: await riffetMcp.handle(request.headers.authorization, request.body?.method, request.body?.params, aborted.signal) };
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/wakeups', async request => {
    store.getSession(request.params.id);
    return orchestration.wakeups(request.params.id);
  });
  app.post<{ Params: { id: string; wakeupId: string } }>('/api/sessions/:id/wakeups/:wakeupId/cancel', async request => {
    store.getSession(request.params.id);
    return orchestration.cancelWakeup(request.params.wakeupId, request.params.id);
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/notices', async request => {
    store.getSession(request.params.id);
    return notices.list(request.params.id);
  });
}
