import type { AuthContext } from '../auth.js';
import { CAPABILITIES, type Capability } from './capabilities.js';

const ALL: ReadonlySet<Capability> = new Set(CAPABILITIES);
const LINK: ReadonlySet<Capability> = new Set<Capability>(['read', 'chat', 'exec']);
const READ_ONLY: ReadonlySet<Capability> = new Set<Capability>(['read']);
const READ_CHAT: ReadonlySet<Capability> = new Set<Capability>(['read', 'chat']);

/**
 * What a caller may do (docs/TRANSPORT-SECURITY.md §4, §6).
 *
 * - A linked server: everything but `admin`; `links/policy.ts` decides which routes it reaches at all.
 * - A paired device presenting its bearer token: everything, until devices carry their own grants.
 * - A browser on an encrypted connection: everything.
 * - A browser on an unencrypted, non-loopback connection: `read`, and `chat` only when the owner turned it on. Its
 *   page and its cookie travel in plain text, so whoever sits on the network can act as it.
 */
export function grantsFor(context: AuthContext, secure: boolean, options: { allowInsecureChat?: boolean }): ReadonlySet<Capability> {
  if (context.kind === 'link') return LINK;
  if (context.kind === 'device' || secure) return ALL;
  return options.allowInsecureChat ? READ_CHAT : READ_ONLY;
}
