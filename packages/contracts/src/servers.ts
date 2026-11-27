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

/** Operating system and CPU architecture reported by a server during the link handshake. */
export interface ServerPlatform {
  os: string;
  arch: string;
}

/** This server's own identity as shown in 设置 › 互联 (`GET /api/links`). */
export interface LinkSelfInfo {
  serverId: string;
  name: string;
  /** The host-derived fallback name used when no custom name is set. */
  defaultName: string;
  platform: ServerPlatform;
}

/** `PATCH /api/links/self`. */
export interface LinkSelfUpdateRequest {
  /** Empty string clears the custom name and falls back to the host name. */
  name: string;
}

/** One link as this server sees it (`GET /api/links`). */
export interface LinkInfo {
  serverId: string;
  name: string;
  /** The name the peer reported itself, when this server uses a local custom name. */
  peerName?: string;
  /** Short local alias unique on this server (used for multi-server labels and CLI targeting). */
  alias: string;
  /** Optional local note describing the peer (e.g. "iOS build Mac"). */
  note?: string;
  platform?: ServerPlatform;
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
  /**
   * The other server's web app through the link's encrypted tunnel, on a loopback port of this server
   * (docs/TRANSPORT-SECURITY.md §3). Only a browser on this server's machine can open it.
   */
  localWebUrl?: string;
  /** Six digits both servers derive from their two certificates; equal on both ends unless someone joined in between. */
  verificationCode: string;
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
export interface LinkUpdateRequest {
  inbound?: boolean;
  /** Local display name; empty string restores the peer's reported name. */
  name?: string;
  /** Short local alias (`^[a-z0-9][a-z0-9._-]{0,31}$`), unique on this server. */
  alias?: string;
  /** Local one-line note; empty string clears it. */
  note?: string;
}

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
  /** Short local alias for linked servers (and optional derived alias for self). */
  alias?: string;
  note?: string;
  platform?: ServerPlatform;
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

/** `POST /api/remote/exec` (normally called through `/api/servers/:serverId/remote/exec`). */
export interface RemoteExecRequest {
  command: string;
  /** Working directory on the target machine; `~` expands to its home directory. Defaults to home. */
  cwd?: string;
  /** Wall-clock timeout in milliseconds, clamped to `LINK_BUDGET.execTimeoutMaxMs`. */
  timeoutMs?: number;
}

export interface RemoteExecResult {
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  cwd: string;
}
