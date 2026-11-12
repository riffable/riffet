import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors.js';
import type { RouteDeps } from './deps.js';

/**
 * What a restart waits on (docs/DELIVERY.md, 重启): `drain` holds new deliveries back (messages are still accepted and
 * stay queued), `restartable` names the turns a restart would end. Each caller holds its own drain (`holder`); the drain lives in memory; the restart clears it.
 */
export function registerServiceRoutes(app: FastifyInstance, { dispatch }: Pick<RouteDeps, 'dispatch'>): void {
  app.get('/api/service/restartable', async () => dispatch.restartability());
  app.post<{ Body: { on?: unknown; holder?: unknown } }>('/api/service/drain', async (request) => {
    const on = request.body?.on;
    if (typeof on !== 'boolean') throw new AppError('INVALID_DRAIN', 'drain needs {"on": boolean}', 400);
    const holder = request.body?.holder;
    if (holder !== undefined && (typeof holder !== 'string' || !holder || holder.length > 100)) throw new AppError('INVALID_DRAIN', 'holder must be a short string', 400);
    dispatch.drain(on, holder);
    return dispatch.restartability();
  });
}
