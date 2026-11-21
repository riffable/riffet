import type { ProtocolInfo } from './protocol.js';

/** Server links (docs/SERVER-LINKS.md). How a tunnel reaches the other server. */
export type LinkTransportId = 'direct' | 'ssh';

/**
 * - `online`: both directions of the tunnel are up.
 * - `connecting`: this side is dialing, or waiting for the other side to dial back.
 * - `offline`: no tunnel; the dialing side keeps retrying.
 * - `removed`: the other server ended the link. Nothing is retried; removing it here clears it.
 */
export type LinkState = 'online' | 'connecting' | 'offline' | 'removed';

/** One link as this server sees it (`GET /api/links`). */
export interface LinkInfo {
  serverId: string;
  name: string;
  transport: LinkTransportId;
  /** `direct`: the other server's address. `ssh`: the SSH destination. Empty on the side that does not dial. */
  address: string;
  /** This server dials the tunnel. */
  dialer: boolean;
  /** The other server may operate this one. This server decides it. */
  inbound: boolean;
  /** This server may operate the other one, as the other one last reported. */
  outbound: boolean;
  state: LinkState;
  version?: string;
  protocol?: ProtocolInfo;
  /** Where a browser opens the other server's own web app, when known. */
  webUrl?: string;
  createdAt: string;
  lastConnectedAt?: string;
  /** Why the last attempt to reach the other server failed. */
  lastError?: string;
}

/** `POST /api/links/invites`. */
export interface LinkInviteRequest {
  /** The address the joining server dials, normally the one the browser used to reach this server. */
  url?: string;
  /** Whether the joining server may operate this one. */
  inbound: boolean;
}
export interface LinkInviteResult { link: string; expiresAt: number }

/** `POST /api/links/join`. */
export interface LinkJoinRequest {
  link: string;
  /** Whether the inviting server may operate this one. */
  inbound: boolean;
  transport?: LinkTransportId;
  /** `ssh`: the destination passed to `ssh`, and the remote command that runs Riffet there. */
  sshHost?: string;
  remoteCommand?: string;
}

/** `PATCH /api/links/:serverId`. */
export interface LinkUpdateRequest { inbound?: boolean }

/** One thing the other server did here through the link (`GET /api/links/:serverId/audit`). */
export interface LinkAuditEntry {
  at: string;
  method: string;
  /** Path without the query string. */
  path: string;
  status: number;
  /** The client of the other server that sent it, as that server reported it. */
  origin?: string;
}

/** `GET /api/servers`: this server first, then the linked ones that have not been removed. */
export interface ServerInfo {
  id: string;
  name: string;
  self?: true;
  online: boolean;
  version?: string;
  protocol?: ProtocolInfo;
  /** Its protocol version is one this server reads. */
  compatible: boolean;
  inbound: boolean;
  outbound: boolean;
  lastConnectedAt?: string;
}
