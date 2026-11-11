import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { OWNER_AVATAR_MAX_BYTES, type OwnerAvatarGenerateRequest, type OwnerAvatarRestore } from '../../../../packages/contracts/src/index.js';
import type { OwnerService } from './index.js';

/** 1 MiB of image is 1.4 MiB of base64; the rest is slack for the JSON around it. */
const AVATAR_BODY_LIMIT = Math.ceil(OWNER_AVATAR_MAX_BYTES / 3) * 4 + 64 * 1024;

/** The owner's name and avatar (docs/OWNER.md). Authentication is the global `onRequest` hook's job; none of these routes is public. */
export function registerOwnerRoutes(app: FastifyInstance, deps: { owner: OwnerService }): void {
  const { owner } = deps;
  app.get('/api/owner', async () => owner.get());
  app.patch<{ Body: { name?: string | null } | undefined }>('/api/owner', async request => owner.update(request.body as { name?: string | null }));
  app.put<{ Body: { type?: unknown; data?: unknown } | undefined }>('/api/owner/avatar', { bodyLimit: AVATAR_BODY_LIMIT }, async request => owner.setAvatar(request.body as { type: unknown; data: unknown }));
  app.delete('/api/owner/avatar', async () => owner.removeAvatar());
  app.post<{ Body: OwnerAvatarRestore | undefined }>('/api/owner/avatar/restore', async request => owner.restoreAvatar(request.body));
  app.delete<{ Params: { sha256: string } }>('/api/owner/avatar/history/:sha256', async request => owner.removeHistory(request.params.sha256));
  // The hash is in the address, so the bytes at it never change. Drawn as an image; opened as a document, nothing in it may run.
  app.get<{ Params: { sha256: string } }>('/api/owner/avatar/:sha256', async (request, reply) => {
    const { file, type, size } = owner.avatar(request.params.sha256);
    return reply.type(type).header('Content-Length', size).header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'").send(createReadStream(file));
  });
  // Generated avatars (docs/OWNER.md「随机头像」): the styles are the enabled plugins', the pictures are drawn here.
  app.get('/api/owner/avatar-styles', async () => ({ styles: owner.avatarStyles() }));
  app.get<{ Params: { pluginId: string; name: string }; Querystring: { seed?: string; ink?: string; paper?: string } }>('/api/owner/avatar-styles/:pluginId/:name/preview', async (request, reply) => {
    const style = `${request.params.pluginId}/${request.params.name}`;
    const png = await owner.previewAvatar(style, request.query);
    // Revalidated rather than cached for good: the same address draws another picture after a rename (a style that
    // draws the name) or after the plugin that draws it is updated.
    const etag = `"${createHash('sha256').update(png).digest('hex').slice(0, 32)}"`;
    reply.type('image/png').header('Cache-Control', 'private, no-cache').header('ETag', etag)
      .header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'");
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.header('Content-Length', png.length).send(png);
  });
  app.post<{ Body: OwnerAvatarGenerateRequest | undefined }>('/api/owner/avatar/generate', async request => owner.generateAvatar(request.body));
}
