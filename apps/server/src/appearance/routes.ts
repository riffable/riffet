import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppearanceService } from './index.js';

/** The catalog of enabled plugins' appearance and the files behind it. Authentication is the global `onRequest` hook's job. */
export function registerAppearanceRoutes(app: FastifyInstance, deps: { appearance: AppearanceService }): void {
  app.get('/api/appearance', async () => deps.appearance.catalog());
  // The hash is in the address, so the bytes at it never change: clients may keep them for good.
  app.get<{ Params: { pluginId: string; sha256: string } }>('/api/appearance/assets/:pluginId/:sha256', async (request, reply) => {
    const { file, type, size, sha256 } = await deps.appearance.asset(request.params.pluginId, request.params.sha256);
    reply.header('ETag', `"${sha256}"`).header('Cache-Control', 'private, max-age=31536000, immutable').header('X-Content-Type-Options', 'nosniff');
    if (type === 'image/svg+xml') reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (request.headers['if-none-match']?.split(',').some(value => value.trim() === `"${sha256}"`)) return reply.code(304).send();
    return reply.type(type).header('Content-Length', size).send(createReadStream(file));
  });
  // Not content-addressed (the file behind an id may be replaced), so keep a short TTL with ETag revalidation
  // instead of forcing a blocking round-trip on every popover mount.
  const icon = (find: (id: string) => ReturnType<AppearanceService['agentIcon']>) => async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { file, type, size, sha256 } = await find(request.params.id);
    // Drawn as an image; if the address is opened as a document instead, nothing in the file may run.
    reply.header('ETag', `"${sha256}"`).header('Cache-Control', 'private, max-age=300, stale-while-revalidate=86400').header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (request.headers['if-none-match']?.split(',').some(value => value.trim() === `"${sha256}"`)) return reply.code(304).send();
    return reply.type(type).header('Content-Length', size).send(createReadStream(file));
  };
  app.get<{ Params: { id: string } }>('/api/agent-icons/:id', icon(id => deps.appearance.agentIcon(id)));
  app.get<{ Params: { id: string } }>('/api/view-icons/:id', icon(id => deps.appearance.viewIcon(id)));
}
