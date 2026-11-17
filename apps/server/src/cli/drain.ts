import { randomUUID } from 'node:crypto';
import { localServerUrl, type PairingDaemon } from './pair.js';

/** What `GET /api/service/restartable` answers (`NativeDispatcher.restartability`). */
interface Restartability { restartable: boolean; blockers: Array<{ sessionId: string; title: string; backendId: string; reason: string }> }

const REASONS: Record<string, string> = { delivery: 'message delivery unconfirmed', turn: 'turn running', background: 'background task running' };

const describeBlockers = (blockers: Restartability['blockers']): string =>
  blockers.map(item => `${item.title || item.sessionId} (${item.backendId}, ${REASONS[item.reason] ?? item.reason})`).join(', ');

/**
 * Holds new deliveries back on the running service and waits until a restart would end nothing
 * (docs/DELIVERY.md, restart). Resolves to the drain's release, or `undefined` when the service predates the
 * endpoints and the caller has to judge for itself. On timeout the drain is lifted and this throws,
 * naming the sessions in the way. The drain is a lease in the service's memory: a restart clears it, and it
 * lapses on its own if this process dies before the service stops.
 */
export async function drainForRestart(record: PairingDaemon, token: string, options: { waitSeconds: number; log?: (message: string) => void }): Promise<(() => Promise<void>) | undefined> {
  const base = localServerUrl(record);
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(3000) });
  if (!login.ok) throw new Error(`Could not sign in to the running service (HTTP ${login.status}). Check \`--state-dir\`.`);
  const { csrfToken } = await login.json() as { csrfToken?: string };
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).find(value => value.startsWith('cw_session='));
  if (!csrfToken || !cookie) throw new Error('The running service did not return a session.');
  const call = (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
  });
  const first = await call('GET', '/api/service/restartable');
  if (first.status === 404) return undefined;
  if (!first.ok) throw new Error(`Could not read whether the service can restart (HTTP ${first.status}).`);
  const holder = randomUUID();
  const release = async () => { try { await call('POST', '/api/service/drain', { on: false, holder }); } catch { /* the service is going away */ } };
  const deadline = Date.now() + options.waitSeconds * 1000;
  let announced = false;
  try {
    for (;;) {
      // The drain is a lease the service drops unless renewed; each renewal answers what still blocks.
      const renewed = await call('POST', '/api/service/drain', { on: true, holder });
      if (!renewed.ok) throw new Error('Could not pause new deliveries; the service was not stopped.');
      const state = await renewed.json() as Restartability;
      if (state.restartable) return release;
      if (Date.now() >= deadline) throw new Error(`These conversations would be interrupted: ${describeBlockers(state.blockers)}. Retry later, wait longer with \`riffet restart --wait-idle <seconds>\`, or use \`--force\`.`);
      if (!announced) { options.log?.(`Waiting up to ${options.waitSeconds}s for ${state.blockers.length} ${state.blockers.length === 1 ? 'conversation' : 'conversations'} to finish: ${describeBlockers(state.blockers)}`); announced = true; }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  } catch (error) { await release(); throw error; }
}
