import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ShareDraftEvent } from '../../../../packages/contracts/src/index.js';
import { AppError, requireString } from '../errors.js';
import { ShareService } from '../shares/service.js';
import type { RouteDeps } from './deps.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
};
const PREVIEW_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob: data:; worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'none'";

export function registerShareRoutes(app: FastifyInstance, deps: RouteDeps, service = new ShareService(deps)): void {
  app.get<{ Querystring: { fresh?: string; publisher?: string } }>('/api/shares/capability', request => service.capability(request.query.fresh === 'true', request.query.publisher));
  app.get('/api/shares', async () => service.list());
  app.get<{ Params: { id: string }; Querystring: { fresh?: string } }>('/api/sessions/:id/share/status', request => service.status(request.params.id, request.query.fresh === 'true'));
  app.get<{ Params: { id: string } }>('/api/sessions/:id/share', async request => service.get(request.params.id));
  app.get<{ Params: { id: string } }>('/api/sessions/:id/share/turns', async (request, reply) => {
    const controller = new AbortController();
    const close = () => controller.abort();
    reply.raw.once('close', close);
    try { return await service.turns(request.params.id, controller.signal); }
    finally { reply.raw.off('close', close); }
  });
  for (const [path, localOnly] of [['draft', false], ['print', true]] as const) app.post<{ Params: { id: string }; Body: { selection?: unknown; appearance?: unknown; author?: unknown } | undefined }>(`/api/sessions/:id/share/${path}`, async (request, reply) => {
    const allowOutsideRead = deps.allowOutsideRead(request.headers);
    const selection = request.body?.selection;
    const appearance = request.body?.appearance;
    const author = request.body?.author;
    if (!request.headers.accept?.includes('application/x-ndjson')) return service.draft(request.params.id, allowOutsideRead, { selection, appearance, author, localOnly });
    // Keep progress on the authenticated mutation itself: no separate job, polling or replay.
    const controller = new AbortController();
    const send = (event: ShareDraftEvent) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`${JSON.stringify(event)}\n`);
    };
    const unwatch = deps.auth.onRevoke(request, () => reply.raw.destroy());
    reply.hijack();
    deps.streams.add(reply.raw);
    reply.raw.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write('\n');
    }, 10_000);
    const close = () => { controller.abort(); clearInterval(heartbeat); deps.streams.delete(reply.raw); unwatch(); };
    reply.raw.once('close', close);
    try {
      const draft = await service.draft(request.params.id, allowOutsideRead, { selection, appearance, author, localOnly, signal: controller.signal, onProgress: progress => send({ type: 'progress', progress }) });
      send({ type: 'ready', draft });
    } catch (error) {
      if (!controller.signal.aborted) send({ type: 'error', message: error instanceof AppError ? error.message : '无法生成分享预览',
        ...(error instanceof AppError ? { messageRef: { code: error.code, ...(error.params ? { params: error.params } : {}) } } : {}) });
    } finally {
      clearInterval(heartbeat);
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
  });
  app.post<{ Params: { id: string }; Body: { draftId?: unknown; expiryDays?: unknown } }>('/api/sessions/:id/share', async (request, reply) => {
    const days = request.body?.expiryDays ?? 30;
    if (typeof days !== 'number') throw new AppError('INVALID_SHARE_EXPIRY', 'The share expiry is invalid');
    const share = await service.publish(request.params.id, requireString(request.body?.draftId, 'draftId', 32), days);
    return reply.code(share.operation ? 202 : 200).send(share);
  });
  app.delete<{ Params: { id: string } }>('/api/shares/:id', async (request, reply) => {
    const share = await service.remove(request.params.id);
    return reply.code(share.operation ? 202 : 200).send(share);
  });
  app.post<{ Params: { id: string } }>('/api/shares/:id/reconcile', request => service.reconcile(request.params.id));
  app.post<{ Params: { id: string } }>('/api/shares/:id/retry', async (request, reply) => {
    const share = await service.retry(request.params.id);
    return reply.code(share.operation ? 202 : 200).send(share);
  });
  app.get<{ Params: { id: string; '*': string } }>('/api/shares/drafts/:id/files/*', async (request, reply) => {
    const root = await realpath(await service.previewDirectory(request.params.id));
    const path = resolve(root, request.params['*']);
    if (!path.startsWith(root + sep)) throw new AppError('SHARE_ASSET_NOT_FOUND', 'The resource does not exist', 404);
    const file = await realpath(path).catch(() => undefined);
    if (!file || !file.startsWith(root + sep) || !(await stat(file)).isFile()) throw new AppError('SHARE_ASSET_NOT_FOUND', 'The resource does not exist', 404);
    reply.type(MIME[extname(file)] ?? 'application/octet-stream').header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    if (extname(file) === '.html') reply.header('Content-Security-Policy', request.params['*'] === 'index.html' ? PREVIEW_CSP : "sandbox allow-scripts allow-downloads; frame-ancestors 'self'");
    if (extname(file) === '.bin') reply.header('Content-Disposition', 'attachment');
    if (request.params['*'] === 'index.html') {
      deps.auth.issueSharePreview(reply, request, request.params.id, await service.previewExpiresAt(request.params.id));
      const html = await readFile(file, 'utf8');
      return reply.send(html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}<meta name="riffet-share-preview" content="true">`));
    }
    return reply.send(createReadStream(file));
  });
  const sweep = () => { void service.sweepDrafts().catch(error => app.log.warn({ err: error }, 'share draft cleanup failed')); };
  const cleanup = setInterval(sweep, 60 * 60 * 1000);
  cleanup.unref();
  app.addHook('preClose', async () => { clearInterval(cleanup); service.close(); });
  sweep();
  void service.recover().catch(error => app.log.warn({ err: error }, 'share recovery failed'));
}
