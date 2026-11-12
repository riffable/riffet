import type { FastifyInstance } from 'fastify';
import type { ApnsClient } from './apns.js';
import type { PushService } from './service.js';

/** The APNs auth key this server pushes with (docs/DEVICES.md §3「后台推送」). The key is accepted, never returned. */
export function registerPushRoutes(app: FastifyInstance, deps: { apns: ApnsClient; push: PushService }): void {
  app.get('/api/settings/push', async () => deps.apns.status());
  app.put('/api/settings/push', async request => {
    const status = deps.apns.save(request.body);
    deps.push.keyChanged();
    return status;
  });
  app.delete('/api/settings/push', async () => {
    const status = deps.apns.remove();
    deps.push.keyChanged();
    return status;
  });
}
