import { X509Certificate, createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A server's long-lived link identity: an Ed25519 key and a self-signed certificate over it. Peers do not trust
 * the certificate through any CA; each side pins the other's SHA-256 fingerprint at pairing (docs/SERVER-LINKS.md §6).
 * Node can parse certificates but not make them, so the certificate is encoded here: only DER framing, the signature
 * is Node's Ed25519.
 */
export interface LinkIdentity {
  /** PEM private key (PKCS#8). */
  key: string;
  /** PEM certificate. */
  cert: string;
  /** Uppercase colon-separated SHA-256 of the certificate, as `X509Certificate.fingerprint256` reports it. */
  fingerprint: string;
}

export function createLinkIdentity(name: string, now = new Date()): LinkIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const cert = selfSignedCertificate(name, privateKey, publicKey, now);
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert, fingerprint: new X509Certificate(cert).fingerprint256 };
}

/**
 * This server's identity, made once and kept in `<stateDir>/link-key.pem` and `link-cert.pem` (0600). Losing it ends
 * every link: peers pinned the old certificate.
 */
export function loadLinkIdentity(stateDir: string, name: string): LinkIdentity {
  const keyPath = join(stateDir, 'link-key.pem'), certPath = join(stateDir, 'link-cert.pem');
  try {
    const key = readFileSync(keyPath, 'utf8'), cert = readFileSync(certPath, 'utf8');
    return { key, cert, fingerprint: certificateFingerprint(cert) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const made = createLinkIdentity(name);
  for (const [path, text] of [[keyPath, made.key], [certPath, made.cert]] as const) {
    writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  return made;
}

export function certificateFingerprint(cert: string | Buffer): string {
  return new X509Certificate(cert).fingerprint256;
}

/** Constant-shape comparison of two fingerprints; tolerates case and separators. */
export function sameFingerprint(left: string | undefined, right: string | undefined): boolean {
  const normal = (value: string) => value.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return !!left && !!right && normal(left).length === 64 && normal(left) === normal(right);
}

/**
 * Six digits both ends of a link compute from the two certificates (docs/TRANSPORT-SECURITY.md §5). The operator
 * compares them after pairing: a server that intercepted the link string and joined in between holds a different
 * certificate, so the two ends show different codes.
 */
export function linkVerificationCode(own: string, peer: string): string {
  const normal = (value: string) => value.replace(/[^0-9a-f]/gi, '').toUpperCase();
  const [first, second] = [normal(own), normal(peer)].sort();
  const digest = createHash('sha256').update(`riffet-link-sas\n${first}\n${second}`).digest();
  const code = String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

const ED25519 = Buffer.from([0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70]);
const COMMON_NAME = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);

function selfSignedCertificate(name: string, privateKey: KeyObject, publicKey: KeyObject, now: Date): string {
  const serial = randomBytes(16);
  // Start with 01xxxxxx: a positive 16-byte DER INTEGER needs neither a sign byte nor trimming.
  serial[0] = (serial[0]! & 0x3f) | 0x40;
  const subject = der(0x30, der(0x31, der(0x30, COMMON_NAME, der(0x0c, Buffer.from(name.slice(0, 64) || 'Riffet', 'utf8')))));
  const notBefore = new Date(now.getTime() - 24 * 3600_000);
  const tbs = der(0x30,
    der(0xa0, der(0x02, Buffer.from([2]))), // v3
    der(0x02, serial),
    ED25519,
    subject,
    der(0x30, utcTime(notBefore), utcTime(new Date(Date.UTC(2049, 11, 31, 23, 59, 59)))),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const signature = sign(null, tbs, privateKey);
  const body = der(0x30, tbs, ED25519, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const lines = body.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

function utcTime(date: Date): Buffer {
  const two = (value: number) => String(value).padStart(2, '0');
  const text = `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(text, 'ascii'));
}

function der(tag: number, ...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts);
  const length = content.length;
  const head = length < 0x80 ? Buffer.from([tag, length])
    : length < 0x100 ? Buffer.from([tag, 0x81, length])
      : length < 0x10000 ? Buffer.from([tag, 0x82, length >> 8, length & 0xff])
        : Buffer.from([tag, 0x83, length >> 16, (length >> 8) & 0xff, length & 0xff]);
  return Buffer.concat([head, content]);
}
