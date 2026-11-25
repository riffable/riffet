/**
 * The security record (docs/TRANSPORT-SECURITY.md §7): who was let in, what changed who may do what, and what was
 * refused. Append-only; the oldest entries drop beyond `SECURITY_AUDIT_BUDGET.entries`.
 */
export type SecurityEventKind =
  | 'device-paired'
  | 'device-revoked'
  | 'pairing-failed'
  | 'login-failed'
  | 'sessions-revoked'
  | 'link-added'
  | 'link-removed'
  | 'link-inbound-changed'
  | 'link-mismatch'
  | 'setting-changed'
  | 'access-denied'
  | 'terminal-opened'
  | 'remote-exec';

/** Who did it, as far as the server could tell. */
export interface SecurityActor {
  /** `cookie`: a browser; `device`: a paired app; `link`: a linked server; absent before anyone signed in. */
  kind?: 'cookie' | 'device' | 'link';
  /** A paired device's or linked server's id. */
  id?: string;
  /** Its name at the time. */
  name?: string;
  /** The network address the request came from; a front door's when it relayed one. */
  address?: string;
  /** The connection was encrypted (docs/TRANSPORT-SECURITY.md §4). */
  secure?: boolean;
}

export interface SecurityEvent {
  id: string;
  at: string;
  kind: SecurityEventKind;
  actor: SecurityActor;
  /** What it was about: a device or server name, a setting key, a route. */
  subject?: string;
  /** The device or server id the event is about, when it differs from the actor's. */
  subjectId?: string;
  /** A short value: the new setting, the capability refused, the command run. */
  detail?: string;
}

/** `GET /api/security/events`, newest first. */
export interface SecurityEventsResponse {
  events: SecurityEvent[];
}
