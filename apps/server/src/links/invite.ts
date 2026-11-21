import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors.js';

/**
 * A link string (docs/SERVER-LINKS.md §7): `riffet-link:v1:<base64url JSON>`. It carries the inviter's address and
 * certificate fingerprint, so the joiner pins the inviter from its first connection, and a one-time key that never
 * crosses the network: the joiner proves it holds the key with an HMAC over both fingerprints.
 */
export interface LinkInvite {
  /** Where the joiner dials, for the `direct` transport. Empty when only SSH can reach the inviter. */
  url: string;
  serverId: string;
  name: string;
  fingerprint: string;
  inviteId: string;
  /** base64url of 32 random bytes. */
  key: string;
  expiresAt: number;
}

const PREFIX = 'riffet-link:v1:';

export function encodeInvite(invite: LinkInvite): string {
  return PREFIX + Buffer.from(JSON.stringify(invite)).toString('base64url');
}

export function decodeInvite(text: string): LinkInvite {
  const value = text.trim();
  if (!value.startsWith(PREFIX)) throw new AppError('INVALID_LINK', 'This is not a Riffet link string', 400);
  let parsed: Partial<LinkInvite>;
  try { parsed = JSON.parse(Buffer.from(value.slice(PREFIX.length), 'base64url').toString('utf8')) as Partial<LinkInvite>; }
  catch { throw new AppError('INVALID_LINK', 'The link string is damaged; copy it again', 400); }
  const { url, serverId, name, fingerprint, inviteId, key, expiresAt } = parsed;
  if (typeof url !== 'string' || typeof serverId !== 'string' || typeof name !== 'string' || typeof fingerprint !== 'string'
    || typeof inviteId !== 'string' || typeof key !== 'string' || typeof expiresAt !== 'number') {
    throw new AppError('INVALID_LINK', 'The link string is damaged; copy it again', 400);
  }
  if (expiresAt <= Date.now()) throw new AppError('LINK_EXPIRED', 'The link string has expired; make a new one', 400);
  return { url, serverId, name, fingerprint, inviteId, key, expiresAt };
}

export function newInviteSecret(): { inviteId: string; key: string } {
  return { inviteId: randomBytes(12).toString('base64url'), key: randomBytes(32).toString('base64url') };
}

/** What the joiner sends: an HMAC under the invite key over the invite and both certificate fingerprints. */
export function inviteProof(key: string, inviteId: string, inviterFingerprint: string, joinerFingerprint: string): string {
  return createHmac('sha256', Buffer.from(key, 'base64url'))
    .update(`riffet-link-join\n${inviteId}\n${normal(inviterFingerprint)}\n${normal(joinerFingerprint)}`)
    .digest('base64url');
}

export function proofMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const left = Buffer.from(expected), right = Buffer.from(given);
  return left.length === right.length && timingSafeEqual(left, right);
}

const normal = (fingerprint: string) => fingerprint.replace(/[^0-9a-f]/gi, '').toUpperCase();
