import type { IncomingMessage } from 'node:http';

/**
 * The mark a connection carried in through a link's tunnel has (docs/SERVER-LINKS.md §6). It lives on the connection
 * object the link service hands to the HTTP server, never in a header, so nothing sent through the tunnel can forge it.
 */
export const LINK_SOCKET = Symbol('riffet.link');

/**
 * The mark of a browser's connection the peer relayed from a loopback port on its machine (docs/TRANSPORT-SECURITY.md
 * §3). It carries no link identity: the browser signs in as any remote one does, over a tunnel that is encrypted.
 */
export const LINK_WEB_SOCKET = Symbol('riffet.link.web');

export type LinkedSocket = { [LINK_SOCKET]?: string; [LINK_WEB_SOCKET]?: string };

/** The peer's server id when the request came through a link, otherwise undefined. */
export function linkOfRequest(raw: Pick<IncomingMessage, 'socket'> | undefined): string | undefined {
  const socket = raw?.socket as LinkedSocket | undefined;
  return socket?.[LINK_SOCKET];
}

/** The server id of the peer whose machine the browser is on, when its connection came through that link's tunnel. */
export function linkWebOfRequest(raw: { socket?: unknown } | undefined): string | undefined {
  const socket = raw?.socket as LinkedSocket | undefined;
  return socket?.[LINK_WEB_SOCKET];
}

/** Host names a relayed browser may address: only loopback ones, so a page that rebinds its own name cannot use the port. */
export function loopbackWebHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
}
