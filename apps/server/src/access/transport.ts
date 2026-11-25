import { BlockList, isIPv4 } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import type { TLSSocket } from 'node:tls';

/**
 * Whether the connection a request came on is encrypted end to end (docs/TRANSPORT-SECURITY.md §4). A browser on a
 * connection that is not gets only what `access/grants.ts` allows an unencrypted browser.
 *
 * - TLS terminated by this server.
 * - A loopback peer: this machine itself, or a front door on it that served the client over HTTPS (`X-Forwarded-Proto:
 *   https`) or is `tailscale serve`. Only a loopback peer is believed about this: from anyone else the header is the
 *   client's own claim, and a man in the middle could add it.
 * - A peer inside an encrypted overlay: Tailscale's ranges, and the networks the operator names (`--trust-network`).
 */
export function secureTransport(request: { ip: string; headers: IncomingHttpHeaders; raw: { socket?: unknown } }, trusted: BlockList | undefined): boolean {
  if ((request.raw.socket as Partial<TLSSocket> | undefined)?.encrypted) return true;
  // No socket at all is an in-process injection (`app.injectWS`); a connection from the network always has one. A
  // stream this server hands its HTTP server itself (a link's tunnel) has a socket without an address, and is marked.
  if (!request.raw.socket) return true;
  if (!request.ip) return false;
  const peer = request.ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  if (peer === '127.0.0.1' || peer === '::1') {
    const { headers } = request;
    const relayed = headers['x-forwarded-for'] || headers.forwarded || headers['x-real-ip'] || headers['x-forwarded-proto'];
    if (!relayed) return true;
    // A front door on this machine: encrypted only when it says it served HTTPS, or it is Tailscale's.
    const proto = String(headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim().toLowerCase();
    return proto === 'https' || Boolean(headers['tailscale-user-login']);
  }
  const family = isIPv4(peer) ? 'ipv4' : 'ipv6';
  return OVERLAY.check(peer, family) || Boolean(trusted?.check(peer, family));
}

/** Tailscale's CGNAT range and its IPv6 ULA prefix: traffic between nodes is WireGuard. */
const OVERLAY = new BlockList();
OVERLAY.addSubnet('100.64.0.0', 10, 'ipv4'); // privacy: allow Tailscale's published range
OVERLAY.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

/** Parses `--trust-network` values (`10.8.0.0/24`, `fd00::/8`, or a single address; privacy: allow example). Throws on anything else. */
export function trustedNetworks(values: readonly string[] | undefined): BlockList | undefined {
  if (!values?.length) return undefined;
  const list = new BlockList();
  for (const value of values) {
    const [address, bits] = value.trim().split('/');
    if (!address) throw new Error(`Invalid network: ${value}`);
    const family = isIPv4(address) ? 'ipv4' : 'ipv6';
    if (bits === undefined) { list.addAddress(address, family); continue; }
    const prefix = Number(bits);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 'ipv4' ? 32 : 128)) throw new Error(`Invalid network: ${value}`);
    list.addSubnet(address, prefix, family);
  }
  return list;
}
