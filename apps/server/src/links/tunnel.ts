import tls from 'node:tls';
import { Duplex, duplexPair } from 'node:stream';
import { LINK_BUDGET } from '../../../../packages/contracts/src/index.js';
import { sameFingerprint, type LinkIdentity } from './identity.js';

/**
 * The tunnel's layers below HTTP/2 (docs/SERVER-LINKS.md §6, measured in `scripts/probe-link-tunnel.ts`): TLS 1.3 over
 * whatever byte stream the transport gives, with both sides presenting their self-signed certificate.
 */

/**
 * Runs TLS over `stream` and resolves with the socket and the peer's certificate fingerprint. `pinned` refuses any
 * other certificate; without it the caller decides from the fingerprint (an acceptor looks it up among its links).
 */
/** The other end's certificate is not the one pinned at pairing: someone else answered for that server. */
export class PinMismatchError extends Error {}

export function secure(stream: Duplex, own: LinkIdentity, role: 'client' | 'server', pinned?: string): Promise<{ socket: tls.TLSSocket; fingerprint: string }> {
  const options = { key: own.key, cert: own.cert, minVersion: 'TLSv1.3' as const, rejectUnauthorized: false };
  const socket = role === 'server'
    ? new tls.TLSSocket(stream, { ...options, isServer: true, requestCert: true })
    : tls.connect({ ...options, socket: stream, checkServerIdentity: () => undefined });
  // A TLSSocket over a JS stream does not notice that stream closing; without this a handshake can hang forever.
  stream.once('close', () => socket.destroy());
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => { clearTimeout(timer); socket.destroy(); stream.destroy(); reject(error); };
    const timer = setTimeout(() => fail(new Error('The link handshake timed out')), LINK_BUDGET.handshakeMs);
    socket.once(role === 'server' ? 'secure' : 'secureConnect', () => {
      clearTimeout(timer);
      const fingerprint = socket.getPeerCertificate()?.fingerprint256;
      if (!fingerprint) { fail(new Error('The other server presented no certificate')); return; }
      if (pinned && !sameFingerprint(fingerprint, pinned)) { fail(new PinMismatchError('The other server\'s certificate does not match the one recorded at pairing')); return; }
      resolve({ socket, fingerprint });
    });
    socket.once('error', error => fail(error));
    socket.once('close', () => fail(new Error('The connection closed during the link handshake')));
  });
}

/**
 * A WebSocket carries the tunnel one message per write. The server's WebSocket plugin caps a message at 256 KB
 * (`app.ts`), so larger writes are split before they reach the socket.
 */
export function boundedWrites(stream: Duplex, maxBytes: number = LINK_BUDGET.tunnelFrameBytes): Duplex {
  const bounded = new Duplex({
    read() { stream.resume(); },
    write(chunk: Buffer, _encoding, callback) {
      let offset = 0;
      const next = (error?: Error | null) => {
        if (error) { callback(error); return; }
        if (offset >= chunk.length) { callback(); return; }
        const piece = chunk.subarray(offset, offset + maxBytes);
        offset += piece.length;
        if (stream.write(piece)) next(); else stream.once('drain', () => next());
      };
      next();
    },
    final(callback) { stream.end(); callback(); },
    destroy(error, callback) { stream.destroy(error ?? undefined); callback(error); },
  });
  stream.on('data', chunk => { if (!bounded.push(chunk)) stream.pause(); });
  stream.once('end', () => bounded.push(null));
  stream.once('close', () => bounded.destroy());
  stream.once('error', error => bounded.destroy(error));
  return bounded;
}

/**
 * Node's HTTP and HTTP/2 implementations take over a stream's native handle when it has one (a TLSSocket over a JS
 * stream, an Http2Stream) and then read or write the bytes of the wrong layer. Each layer gets one end of an in-memory
 * pair instead, with the real stream piped to the other end; it costs one copy.
 */
export function plain(stream: Duplex): Duplex {
  const [inner, outer] = duplexPair();
  stream.pipe(outer).pipe(stream);
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    inner.destroy(); outer.destroy(); stream.destroy();
  };
  stream.once('close', end);
  stream.once('error', end);
  inner.once('close', end);
  return inner;
}
