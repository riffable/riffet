import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { mdnsNames } from './mdns-name.js';

export function normalizeConnectionHost(host: string): string {
  return host.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

export function isLoopbackHost(host: string): boolean {
  const value = normalizeConnectionHost(host);
  return value === 'localhost' || value === '::1'
    || (isIP(value) === 4 && value.startsWith('127.'))
    || (isIP(value) === 6 && /^::ffff:(?:127\.|7f[\da-f]{2}:)/i.test(value));
}

export function isWildcardHost(host: string): boolean {
  return ['0.0.0.0', '::'].includes(normalizeConnectionHost(host));
}

/** Addresses have to match the listener: an IPv4 wildcard does not accept native IPv6. */
export function listenerHosts(bindHost: string): string[] {
  const bind = normalizeConnectionHost(bindHost);
  if (!isWildcardHost(bind)) return [bind];
  const addresses = Object.values(networkInterfaces()).flatMap(items => items ?? [])
    .filter(item => !item.internal && !isLoopbackHost(item.address))
    .map(item => normalizeConnectionHost(item.address))
    // Scoped/link-local IPv6 cannot be represented by the clients' plain host field. IPv4
    // self-assigned interfaces also should not displace an address on the actual LAN.
    .filter(address => !address.includes('%') && !/^fe[89ab]/i.test(address)
      && !address.startsWith('169.254.') && (bind !== '0.0.0.0' || isIP(address) === 4))
    .sort((a, b) => (isIP(a) === 4 ? 0 : 1) - (isIP(b) === 4 ? 0 : 1));
  return [...new Set([...addresses, ...mdnsNames()])];
}

export interface ConnectionAddressOptions {
  bindHost: string;
  port: number;
  scheme: 'http' | 'https';
  /** An already Host-validated request authority; never X-Forwarded-Host. */
  authority?: string;
  /** The effective Host allowlist. Never advertise an address `checkOrigin` would reject. */
  allowedHosts?: ReadonlySet<string>;
}

/** One source for QR contents, manual connection details, and CLI output. */
export function connectionAddresses(options: ConnectionAddressOptions) {
  const candidates = listenerHosts(options.bindHost)
    .filter(host => !options.allowedHosts || options.allowedHosts.has(normalizeConnectionHost(host)));
  let host = candidates[0] ?? '127.0.0.1';
  let port = options.port;
  if (options.authority) {
    const origin = new URL(`${options.scheme}://${options.authority}`);
    const requestHost = normalizeConnectionHost(origin.hostname);
    // A non-local authority is the address this authenticated client actually reached. This also
    // preserves an operator-allowlisted TLS front door's name and port, without trusting a second
    // forwarded host supplied by the caller.
    if (!isLoopbackHost(requestHost) && !isWildcardHost(requestHost)) {
      host = requestHost;
      port = origin.port ? Number(origin.port) : options.scheme === 'https' ? 443 : 80;
    }
  }
  // Other listener addresses cannot share a front door's TLS scheme or remapped port.
  const direct = options.scheme === 'http' && port === options.port;
  const hosts = [...new Set([host, ...(direct ? candidates : [])])];
  const baseUrl = `${options.scheme}://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
  return { host, hosts, port, scheme: options.scheme, baseUrl, localOnly: isLoopbackHost(host) };
}
