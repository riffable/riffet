import type { Server } from 'node:http';
import { Socket } from 'node:net';
import { TLSSocket, createSecureContext, type SecureContext } from 'node:tls';
import { TRANSPORT_BUDGET } from '../../../../packages/contracts/src/index.js';
import { loadIdentity, type LinkIdentity } from '../links/identity.js';

/**
 * What a device's comparison code is computed under: `sha256("riffet-device-sas\n" ‖ the two certificate fingerprints,
 * hex, sorted, newline-separated)`, its first four bytes as a big-endian number mod 10⁶ (docs/TRANSPORT-SECURITY.md §5).
 */
export const DEVICE_SAS_LABEL = 'riffet-device-sas';

/** The TLS record type of a ClientHello; an HTTP request starts with a method name in ASCII instead. */
const HANDSHAKE = 0x16;

/**
 * The server's own TLS identity (docs/TRANSPORT-SECURITY.md §2): a P-256 key and a self-signed certificate, kept in
 * `server-tls-key.pem` and `server-tls-cert.pem` (0600). Apps pin its fingerprint from the pairing code, so losing it
 * means pairing them again.
 */
/** The SHA-256 of the certificate the client presented on this TLS connection, if any. */
export function peerCertificateFingerprint(socket: unknown): string | undefined {
  if (!(socket instanceof TLSSocket)) return undefined;
  return socket.getPeerCertificate()?.fingerprint256 || undefined;
}

export function loadServerTlsIdentity(stateDir: string, name: string): LinkIdentity {
  return loadIdentity(stateDir, 'server-tls', name, 'p256');
}

/**
 * Serves TLS and plain HTTP on the same port (docs/TRANSPORT-SECURITY.md §3): each new connection's first byte says
 * which. A TLS client may present a certificate of its own; nothing is refused for lacking one, and the request
 * handler reads it from the socket. Streams this server hands itself (a link's tunnel) are not network sockets and pass
 * straight through.
 */
export function acceptTlsOnSamePort(server: Server, identity: Pick<LinkIdentity, 'key' | 'cert'>): void {
  const handlers = server.listeners('connection') as Array<(socket: unknown) => void>;
  server.removeAllListeners('connection');
  const deliver = (socket: unknown) => { for (const handler of handlers) handler.call(server, socket); };
  const context: SecureContext = createSecureContext({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.2' });
  server.on('connection', (socket: unknown) => {
    if (!(socket instanceof Socket) || socket instanceof TLSSocket) { deliver(socket); return; }
    const timer = setTimeout(() => socket.destroy(), TRANSPORT_BUDGET.handshakeMs);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
    socket.once('readable', () => {
      const first = socket.read(1) as Buffer | null;
      if (!first) { clearTimeout(timer); socket.destroy(); return; }
      socket.unshift(first);
      if (first[0] !== HANDSHAKE) { clearTimeout(timer); deliver(socket); return; }
      const secure = new TLSSocket(socket, { isServer: true, secureContext: context, requestCert: true, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
      secure.once('secure', () => { clearTimeout(timer); deliver(secure); });
      secure.on('error', () => { clearTimeout(timer); secure.destroy(); });
    });
  });
}
