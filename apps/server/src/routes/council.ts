import type { FastifyInstance } from 'fastify';
import type {
  CouncilAdvanceRequest,
  CouncilCreateRequest,
  CouncilExportRequest,
  CouncilPatchRequest,
  CouncilSteerRequest,
} from '../../../../packages/contracts/src/index.js';
import type { RouteDeps } from './deps.js';

export function registerCouncilRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { council, streams } = deps;

  app.get('/api/council', async () => ({ items: council.list() }));

  app.get<{ Params: { id: string } }>('/api/council/:id', async (request) => council.get(request.params.id));

  app.post<{ Body: CouncilCreateRequest }>('/api/council', async (request) => council.create(request.body));

  app.patch<{ Params: { id: string }; Body: CouncilPatchRequest }>('/api/council/:id', async (request) =>
    council.patch(request.params.id, request.body ?? {}));

  app.post<{ Params: { id: string }; Body?: CouncilAdvanceRequest }>('/api/council/:id/advance', async (request) =>
    council.advance(request.params.id, request.body?.action));

  app.post<{ Params: { id: string }; Body: CouncilSteerRequest }>('/api/council/:id/steer', async (request) =>
    council.steer(request.params.id, request.body?.text ?? ''));

  app.post<{ Params: { id: string } }>('/api/council/:id/cancel', async (request) =>
    council.cancel(request.params.id));

  app.delete<{ Params: { id: string } }>('/api/council/:id', async (request, reply) => {
    council.delete(request.params.id);
    reply.code(204);
  });

  app.post<{ Params: { id: string }; Body: CouncilExportRequest }>('/api/council/:id/export', async (request) =>
    council.exportDiscussion(request.params.id, request.body));

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
