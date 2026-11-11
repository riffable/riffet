import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';
import { RIFFET_PACKAGES } from '../riffet-mcp/adb.js';
import type { RouteDeps } from './deps.js';

/**
 * A paired device's own side of the device channel (docs/DEVICES.md §3). Every `/api/devices/me` route
 * takes only the device's bearer token: a browser cookie, even a paired browser's, is not a device that
 * can serve calls. The conversation's device-action log is an ordinary signed-in route.
 */
export function registerDeviceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { auth, devices, adb, streams, store } = deps;
  const me = (request: FastifyRequest) => {
    const context = auth.authenticate(request, true);
    if (context.kind !== 'device' || !context.deviceId) throw new AppError('DEVICE_TOKEN_REQUIRED', 'Only a paired device can use this route', 403);
    return context.deviceId;
  };
  app.put('/api/devices/me', async request => devices.report(me(request), request.body));
  const packageName = (value: unknown) => {
    if (typeof value !== 'string' || !RIFFET_PACKAGES.has(value)) throw new AppError('INVALID_PACKAGE_NAME', 'packageName must name the Riffet app', 400);
    return value;
  };
  // Optional shortcut: the phone is also on this Mac's adb. Identified by the installation id it wrote to its app files, never by model.
  app.get<{ Querystring: { package?: string } }>('/api/devices/me/adb', async request => {
    const deviceId = me(request);
    return adb.status(auth.installationIdOf(deviceId), packageName(request.query.package));
  });
  app.post('/api/devices/me/adb/grant', async request => {
    const deviceId = me(request);
    return adb.grant(auth.installationIdOf(deviceId), packageName((request.body as { packageName?: unknown } | null)?.packageName));
  });
  app.get('/api/devices/me/stream', async (request, reply) => {
    const deviceId = me(request);
    // Revoking the device ends its stream at once, not at its next reconnect.
    const unwatch = auth.onRevoke(request, () => reply.raw.destroy());
    reply.raw.once('close', unwatch);
    reply.hijack(); streams.add(reply.raw);
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    reply.raw.write(': connected\n\n');
    const disconnect = devices.connect(deviceId, (event, data) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      // A device that stopped reading is dropped; it replays what it missed when it reconnects.
      if (reply.raw.writableLength > 4 * 1024 * 1024) { reply.raw.end(); return; }
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    reply.raw.on('close', () => { disconnect(); streams.delete(reply.raw); });
  });
  app.post<{ Params: { callId: string } }>('/api/devices/me/calls/:callId/result', async request => devices.answer(me(request), request.params.callId, request.body));
  app.post<{ Params: { callId: string } }>('/api/devices/me/calls/:callId/files', async request => devices.attach(me(request), request.params.callId, request.body));
  // A conversation's record of what it did on device screens, read like its notices: not a device route.
  app.get<{ Params: { id: string } }>('/api/sessions/:id/device-actions', async request => {
    store.getSession(request.params.id);
    return devices.audit.list(request.params.id);
  });
}
