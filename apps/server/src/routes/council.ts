import type { FastifyInstance } from 'fastify';
import type {
  CouncilContinueRequest,
  CouncilCreateRequest,
  CouncilExportRequest,
  CouncilPatchRequest,
  CouncilSupplementRequest,
} from '../../../../packages/contracts/src/index.js';
import { visibleBackendsForClient } from '../native/client-features.js';
import type { RouteDeps } from './deps.js';

export function registerCouncilRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { council, streams, nativeBackends } = deps;

  app.get('/api/council', async () => ({ items: council.list() }));

  // What a seat can run on: every Agent the catalog offers this client, quick chat included (the Agents list leaves it out).
  app.get('/api/council/agents', async (request) => visibleBackendsForClient(request.headers, await nativeBackends.catalog.listBackends()));

  app.get<{ Params: { id: string } }>('/api/council/:id', async (request) => council.get(request.params.id));

  app.get<{ Params: { id: string; seatId: string }; Querystring: { speechId?: string } }>('/api/council/:id/seats/:seatId/prompts', async (request) =>
    council.prompts(request.params.id, request.params.seatId, request.query.speechId));

  app.post<{ Body: CouncilCreateRequest }>('/api/council', async (request) => council.create(request.body));

  app.patch<{ Params: { id: string }; Body: CouncilPatchRequest }>('/api/council/:id', async (request) =>
    council.patch(request.params.id, request.body ?? {}));

  app.post<{ Params: { id: string }; Body?: CouncilContinueRequest }>('/api/council/:id/continue', async (request) =>
    council.continue(request.params.id, request.body?.action === 'conclude' || request.body?.action === 'record' ? request.body.action : 'next', request.body?.speechId));

  app.post<{ Params: { id: string }; Body: CouncilSupplementRequest }>('/api/council/:id/supplement', async (request) =>
    council.supplement(request.params.id, request.body?.text ?? ''));

  app.post<{ Params: { id: string } }>('/api/council/:id/stop', async (request) =>
    council.stop(request.params.id));

  app.delete<{ Params: { id: string } }>('/api/council/:id', async (request, reply) => {
    council.delete(request.params.id);
    reply.code(204);
  });

  app.post<{ Params: { id: string }; Body: CouncilExportRequest }>('/api/council/:id/export', async (request) =>
    council.exportDiscussion(request.params.id, request.body));

  app.get<{ Params: { id: string; speechId: string } }>('/api/council/:id/speeches/:speechId/rows', async (request) =>
    council.speechRows(request.params.id, request.params.speechId));

  app.get<{ Params: { id: string } }>('/api/council/:id/stream', async (request, reply) => {
    const initial = council.get(request.params.id);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    streams.add(res);

    const writeEvent = (payload: unknown) => {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    writeEvent({ type: 'snapshot', discussion: initial });
    const off = council.subscribe(initial.id, writeEvent);
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 20_000);
    keepalive.unref?.();

    const cleanup = () => {
      clearInterval(keepalive);
      off();
      streams.delete(res);
    };
    request.raw.once('close', cleanup);
    res.once('close', cleanup);
  });
}
