import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import type { LinkInviteRequest, LinkJoinRequest, LinkTransportId, LinkUpdateRequest } from '../../../../packages/contracts/src/index.js';
import type { Auth } from '../auth.js';
import { AppError } from '../errors.js';
import { forwardHttp, forwardWebSocket, peerPath } from '../links/forward.js';
import type { LinkService } from '../links/service.js';

/**
 * Server links (docs/SERVER-LINKS.md): managing links, the tunnel endpoint other servers dial, and forwarding
 * `/api/servers/<serverId>/…` to a linked server. Every route here is denied to requests that themselves came through
 * a link (`links/policy.ts`), so a peer can neither manage this server's links nor relay onward.
 */
export const LINK_TUNNEL_ROUTE = '/api/links/tunnel';

export function registerLinkRoutes(app: FastifyInstance, deps: { links: LinkService; auth: Auth; deviceName: (id: string) => string | undefined }) {
  const { links, auth } = deps;

  app.get('/api/servers', async () => ({ servers: links.servers() }));
  app.get('/api/links', async () => ({ links: links.list() }));

  app.post<{ Body: Partial<LinkInviteRequest> }>('/api/links/invites', async request => {
    const body = request.body ?? {};
    if (typeof body.inbound !== 'boolean') throw new AppError('INVALID_INPUT', 'inbound must be true or false', 400);
    if (body.url !== undefined && typeof body.url !== 'string') throw new AppError('INVALID_INPUT', 'url must be a string', 400);
    return links.createInvite({ inbound: body.inbound, ...(body.url ? { url: body.url } : {}) });
  });

  app.post<{ Body: Partial<LinkJoinRequest> }>('/api/links/join', async request => {
    const body = request.body ?? {};
    if (typeof body.link !== 'string' || !body.link.trim()) throw new AppError('INVALID_INPUT', 'link must be a link string', 400);
    if (typeof body.inbound !== 'boolean') throw new AppError('INVALID_INPUT', 'inbound must be true or false', 400);
    const transport = body.transport ?? 'direct';
    if (!(['direct', 'ssh'] as LinkTransportId[]).includes(transport)) throw new AppError('INVALID_INPUT', 'transport must be direct or ssh', 400);
    const optional = (value: unknown, name: string) => {
      if (value === undefined) return undefined;
      if (typeof value !== 'string' || value.length > 500) throw new AppError('INVALID_INPUT', `${name} must be a string`, 400);
      return value;
    };
    const sshHost = optional(body.sshHost, 'sshHost'), remoteCommand = optional(body.remoteCommand, 'remoteCommand');
    if (sshHost !== undefined && (sshHost.startsWith('-') || /\s/.test(sshHost.trim()))) throw new AppError('INVALID_INPUT', 'sshHost must be one SSH destination', 400);
    return { link: await links.join({ link: body.link, inbound: body.inbound, transport, ...(sshHost ? { sshHost } : {}), ...(remoteCommand ? { remoteCommand } : {}) }) };
  });

  app.patch<{ Params: { serverId: string }; Body: Partial<LinkUpdateRequest> }>('/api/links/:serverId', async request => {
    const inbound = request.body?.inbound;
    if (inbound !== undefined && typeof inbound !== 'boolean') throw new AppError('INVALID_INPUT', 'inbound must be true or false', 400);
    return { link: links.update(request.params.serverId, inbound === undefined ? {} : { inbound }) };
  });

  app.delete<{ Params: { serverId: string } }>('/api/links/:serverId', async request => {
    await links.remove(request.params.serverId);
    return { removed: true };
  });

  app.get<{ Params: { serverId: string } }>('/api/links/:serverId/audit', async request => ({ entries: links.audit(request.params.serverId) }));

  // Public: the TLS certificate inside the tunnel is the credential (`app.ts` lists the route in PUBLIC_API).
  app.get<{ Querystring: { role?: string; join?: string } }>(LINK_TUNNEL_ROUTE, { websocket: true }, (socket, request) => {
    void links.accept(socket, { role: request.query.role, join: request.query.join });
  });

  const origin = (request: FastifyRequest) => {
    try {
      const context = auth.authenticate(request);
      return context.deviceId ? deps.deviceName(context.deviceId) ?? context.deviceId : 'browser';
    } catch { return undefined; }
  };
  const target = (request: FastifyRequest<{ Params: { serverId: string } }>) => {
    const path = peerPath(request.raw.url ?? '', request.params.serverId);
    if (!path) throw new AppError('INVALID_PATH', 'Not a path on a linked server', 400);
    return path;
  };

  // The body is relayed as it arrives rather than parsed, so this scope takes every content type as a raw stream.
  void app.register(async scope => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    const url = '/api/servers/:serverId/*';
    scope.route<{ Params: { serverId: string } }>({
      method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], url,
      handler: (request, reply) => {
        const path = target(request);
        reply.hijack();
        forwardHttp(links, request.params.serverId, path, request.raw, request.body as Readable | undefined, reply.raw, origin(request));
      },
    });
    scope.route<{ Params: { serverId: string } }>({
      method: 'GET', url,
      handler: (request, reply) => {
        const path = target(request);
        reply.hijack();
        forwardHttp(links, request.params.serverId, path, request.raw, undefined, reply.raw, origin(request));
      },
      wsHandler: (socket, request) => {
        const path = peerPath(request.raw.url ?? '', (request.params as { serverId: string }).serverId);
        if (!path) { socket.close(1008, 'Not a path on a linked server'); return; }
        forwardWebSocket(links, (request.params as { serverId: string }).serverId, path, socket, request.raw, origin(request));
      },
    });
  });
}
