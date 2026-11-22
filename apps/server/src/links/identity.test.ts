import { X509Certificate } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createLinkIdentity } from './identity.js';

vi.mock('node:crypto', async importOriginal => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  randomBytes: (size: number) => Buffer.alloc(size),
}));

it('creates a certificate with a positive serial even when the random bytes begin with zeros', () => {
  const identity = createLinkIdentity('test');
  const cert = new X509Certificate(identity.cert);
  expect(BigInt(`0x${cert.serialNumber}`)).toBeGreaterThan(0n);
  expect(cert.verify(cert.publicKey)).toBe(true);
});
