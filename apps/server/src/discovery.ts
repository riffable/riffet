import Bonjour from 'bonjour-service';
import { hostname } from 'node:os';
import { mdnsNames } from './mdns-name.js';
import { isWildcardHost, normalizeConnectionHost } from './connection-addresses.js';

export interface DiscoveryOptions { port: number; host: string; name: string; version?: string }
export interface DiscoveryHandle { stop(): Promise<void> }

type PublishedService = ReturnType<Bonjour['publish']>;
/** Release callbacks may never fire once the socket is gone; bound the wait so shutdown cannot hang. */
const RELEASE_TIMEOUT_MS = 500;
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Advertise `_riffet._tcp` with bonjour-service so a phone can find the server without an
 * address. Returns `undefined` when discovery cannot run; it must never block server startup.
 */
export async function startDiscovery(options: DiscoveryOptions): Promise<DiscoveryHandle | undefined> {
  const host = normalizeConnectionHost(options.host);
  // bonjour-service 1.4 publishes A/AAAA records for every interface and exposes no address filter.
  // A specific-IP listener cannot answer all of them; offer its explicit address instead of an
  // mDNS service that randomly sends clients to another interface.
  if (!isWildcardHost(host)) return;
  let bonjour: Bonjour | undefined;
  let service: PublishedService | undefined;
  // `bonjour-service` defaults `host` to `os.hostname()` and writes that string verbatim into both
  // the SRV target and the A records. On macOS that is not the name mDNS answers for, so a phone that
  // discovers the service still cannot resolve it — publish the Bonjour name the OS already serves.
  const bonjourHost = mdnsNames()[0];
  try {
    bonjour = new Bonjour({}, (error: unknown) => console.warn(`[riffet] mDNS advertisement error: ${reason(error)}`));
    service = bonjour.publish({
      name: `${options.name} (${bonjourHost ? bonjourHost.replace(/\.local$/i, '') : hostname()})`,
      type: 'riffet',
      protocol: 'tcp',
      port: options.port,
      disableIPv6: host === '0.0.0.0',
      ...(bonjourHost ? { host: bonjourHost } : {}),
      txt: { version: options.version ?? '1', path: '/' },
    });
    service.on('error', (error: unknown) => console.warn(`[riffet] mDNS advertisement error: ${reason(error)}`));
  } catch (error) {
    try { service?.stop(); bonjour?.destroy(); } catch { /* Nothing to release when setup already failed. */ }
    console.warn(`[riffet] mDNS discovery is unavailable: ${reason(error)}`);
    return;
  }
  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      await settle(done => service!.stop(done));
      await settle(done => bonjour!.destroy(done));
    },
  };
}

function settle(release: (done: () => void) => void): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; resolve(); };
    const timer = setTimeout(finish, RELEASE_TIMEOUT_MS);
    timer.unref();
    try { release(() => { clearTimeout(timer); finish(); }); } catch { clearTimeout(timer); finish(); }
  });
}
