import type { IncomingMessage } from 'node:http';

/**
 * The mark a connection carried in through a link's tunnel has (docs/SERVER-LINKS.md §6). It lives on the connection
 * object the link service hands to the HTTP server, never in a header, so nothing sent through the tunnel can forge it.
 */
export const LINK_SOCKET = Symbol('riffet.link');

export type LinkedSocket = { [LINK_SOCKET]?: string };

/** The peer's server id when the request came through a link, otherwise undefined. */
export function linkOfRequest(raw: Pick<IncomingMessage, 'socket'> | undefined): string | undefined {
  const socket = raw?.socket as LinkedSocket | undefined;
  return socket?.[LINK_SOCKET];
}
