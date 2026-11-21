/**
 * L0 probe for server links (docs/SERVER-LINKS.md §6, §12): does the tunnel stack work on this Node, and what does it
 * cost? Everything runs in one process on loopback; nothing touches the running Riffet service.
 *
 *   node --import tsx scripts/probe-link-tunnel.ts
 *
 * Stack under test, per direction: WebSocket (`ws`) → TLS 1.3 with both sides presenting self-signed Ed25519
 * certificates checked by pinned fingerprint → HTTP/2 → one classic CONNECT stream per forwarded connection, which the
 * peer hands to its ordinary Fastify server with `server.emit('connection', stream)`. The peer's routes therefore see
 * plain HTTP/1.1: JSON, SSE, a WebSocket upgrade and an upload, each tagged with the link that carried it.
 *
 * Checks: pinning (a wrong fingerprint is refused), each kind of request, a second HTTP/2 session in the opposite
 * direction over a second WebSocket, and timings against the same routes over direct loopback.
 */
import { once } from 'node:events';
import http from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';
import { Duplex, duplexPair } from 'node:stream';
import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import WebSocket, { WebSocketServer, createWebSocketStream } from 'ws';
import { createLinkIdentity, sameFingerprint, type LinkIdentity } from '../apps/server/src/links/identity.js';

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

/** The peer's ordinary server: routes know nothing about links except the tag on the socket. */
async function peerApp() {
  const app = Fastify();
  await app.register(websocketPlugin);
  const linkOf = (request: { raw: http.IncomingMessage }) => (request.raw.socket as { riffetLink?: string }).riffetLink ?? null;
  app.get('/api/json', async request => ({ hello: 'peer', link: linkOf(request) }));
  app.get('/api/blob', async (_request, reply) => reply.type('application/octet-stream').send(Buffer.alloc(32 * 1024 * 1024, 7)));
  app.post('/api/upload', { bodyLimit: 64 * 1024 * 1024 }, async request => ({ bytes: (request.body as Buffer).length, link: linkOf(request) }));
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 64 * 1024 * 1024 }, (_request, body, done) => done(null, body));
  app.get('/api/sse', (request, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    let sent = 0;
    const timer = setInterval(() => {
      reply.raw.write(`event: tick\ndata: ${JSON.stringify({ n: sent, link: linkOf(request) })}\n\n`);
      if (++sent === 3) { clearInterval(timer); reply.raw.end(); }
    }, 20);
    request.raw.on('close', () => clearInterval(timer));
  });
  app.get('/api/ws', { websocket: true }, (socket, request) => {
    socket.on('message', data => socket.send(`${data}|${linkOf(request) ?? 'direct'}`));
  });
  await app.ready();
  return app;
}

/** TLS over a byte stream; resolves once the peer's certificate matches the pinned fingerprint. */
function secure(stream: Duplex, own: LinkIdentity, pinned: string, isServer: boolean): Promise<tls.TLSSocket> {
  const options = { key: own.key, cert: own.cert, minVersion: 'TLSv1.3' as const, rejectUnauthorized: false };
  const socket = isServer
    ? new tls.TLSSocket(stream, { ...options, isServer: true, requestCert: true })
    : tls.connect({ ...options, socket: stream, checkServerIdentity: () => undefined });
  // A TLSSocket over a non-net stream does not notice the stream closing; tear it down explicitly.
  stream.once('close', () => socket.destroy());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('handshake timed out')); }, 10_000);
    socket.once(isServer ? 'secure' : 'secureConnect', () => {
      clearTimeout(timer);
      const peer = socket.getPeerCertificate();
      if (!sameFingerprint(peer?.fingerprint256, pinned)) { socket.destroy(); stream.destroy(); reject(new Error(`fingerprint mismatch (${peer?.fingerprint256 ?? 'none'})`)); return; }
      resolve(socket);
    });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('close', () => { clearTimeout(timer); reject(new Error('closed before the handshake finished')); });
  });
}

/**
 * Node's HTTP and HTTP/2 implementations take over a stream's native handle when it has one (a TLSSocket over a JS
 * stream, an Http2Stream) and then read or write the bytes of the wrong layer. Each layer is therefore handed one end
 * of an in-memory pair, with the real stream piped to the other end, at the cost of one copy.
 */
function plain(stream: Duplex): Duplex {
  const [inner, outer] = duplexPair();
  stream.pipe(outer).pipe(stream);
  const end = () => { inner.destroy(); outer.destroy(); stream.destroy(); };
  stream.once('close', end);
  inner.once('close', end);
  stream.once('error', end);
  return inner;
}

/** The receiving end of one direction: every CONNECT stream becomes a connection of the peer's HTTP server. */
function serveInto(socket: tls.TLSSocket, server: http.Server, link: string) {
  // The default 10 MB session memory resets a stream mid-upload once a large body is in flight.
  const h2 = http2.createServer({ maxSessionMemory: 64 });
  h2.on('stream', (stream, headers) => {
    if (headers[':method'] !== 'CONNECT') { stream.respond({ ':status': 405 }); stream.end(); return; }
    stream.respond({ ':status': 200 });
    const connection = Object.assign(plain(stream), { riffetLink: link });
    server.emit('connection', connection);
  });
  h2.emit('connection', plain(socket));
}

/** The sending end: an HTTP/2 client whose streams are byte pipes to the peer's HTTP server. */
function connectThrough(socket: tls.TLSSocket) {
  const session = http2.connect('http://peer.link', { maxSessionMemory: 64, createConnection: () => plain(socket) });
  const open = () => plain(session.request({ ':method': 'CONNECT', ':authority': 'peer.link:80' }) as unknown as Duplex);
  return { session, open };
}

function viaHttp(open: (() => Duplex) | null, port: number, method: string, path: string, body?: Buffer): Promise<{ status: number; body: Buffer; ms: number }> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path, headers: body ? { 'content-type': 'application/octet-stream', 'content-length': body.length } : {}, ...(open ? { createConnection: () => open() } : { agent: false }) }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), ms: performance.now() - started }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function wsEcho(open: (() => Duplex) | null, port: number, rounds: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, open ? { createConnection: () => open() as never } : {});
  await once(socket, 'open');
  const samples: number[] = [];
  let tag = '';
  for (let round = 0; round < rounds; round++) {
    const started = performance.now();
    socket.send(`m${round}`);
    const [data] = await once(socket, 'message');
    tag = String(data).split('|')[1] ?? '';
    samples.push(performance.now() - started);
  }
  socket.close();
  samples.sort((a, b) => a - b);
  return { tag, p50: samples[Math.floor(rounds / 2)]!, p95: samples[Math.floor(rounds * 0.95)]! };
}

async function main() {
  console.log(`node ${process.version}, ${process.platform}/${process.arch}`);
  const a = createLinkIdentity('probe-a');
  const b = createLinkIdentity('probe-b');
  check('identity: self-signed Ed25519 certificates parse', /^[0-9A-F:]{95}$/.test(a.fingerprint) && a.fingerprint !== b.fingerprint, a.fingerprint.slice(0, 23) + '…');

  // Peer B: an ordinary app, its HTTP server never listens for the tunnel; a second copy listens for the baseline.
  const peer = await peerApp();
  const direct = await peerApp();
  await direct.listen({ host: '127.0.0.1', port: 0 });
  const directPort = (direct.server.address() as AddressInfo).port;

  // B accepts tunnels on a WebSocket endpoint (standing in for GET /api/links/tunnel).
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const tunnelPort = (wss.address() as AddressInfo).port;
  const accepted: Promise<tls.TLSSocket>[] = [];
  wss.on('connection', ws => { accepted.push(secure(createWebSocketStream(ws), b, a.fingerprint, true)); });

  // Pinning: A dials with the wrong expected fingerprint.
  {
    const ws = new WebSocket(`ws://127.0.0.1:${tunnelPort}`);
    await once(ws, 'open');
    const wrong = createLinkIdentity('impostor');
    const refused = await secure(createWebSocketStream(ws), a, wrong.fingerprint, false).then(() => false, () => true);
    check('pinning: a certificate that does not match the pinned fingerprint is refused', refused);
    await accepted.shift()?.catch(() => undefined);
  }

  // Direction A → B: A dials, A is the HTTP/2 client, B serves into its app.
  const wsAB = new WebSocket(`ws://127.0.0.1:${tunnelPort}`);
  await once(wsAB, 'open');
  const [clientAB, serverAB] = await Promise.all([secure(createWebSocketStream(wsAB), a, b.fingerprint, false), accepted.shift()!]);
  check('TLS 1.3 with both certificates pinned', clientAB.getProtocol() === 'TLSv1.3' && serverAB.getProtocol() === 'TLSv1.3', clientAB.getProtocol() ?? '');
  serveInto(serverAB, peer.server, 'probe-a');
  const ab = connectThrough(clientAB);

  const json = await viaHttp(ab.open, 80, 'GET', '/api/json');
  check('JSON route over the tunnel, tagged with the link', json.status === 200 && JSON.parse(json.body.toString()).link === 'probe-a', json.body.toString());

  const sse = await viaHttp(ab.open, 80, 'GET', '/api/sse');
  const events = sse.body.toString().split('\n\n').filter(Boolean);
  check('SSE streams through', sse.status === 200 && events.length === 3 && events[2]!.includes('"link":"probe-a"'), `${events.length} events`);

  const echo = await wsEcho(ab.open, 80, 200);
  check('WebSocket upgrade reaches the peer\'s websocket route', echo.tag === 'probe-a', `tag ${echo.tag}`);

  const upload = Buffer.alloc(20 * 1024 * 1024, 3);
  const up = await viaHttp(ab.open, 80, 'POST', '/api/upload', upload);
  check('20 MB upload', up.status === 200 && JSON.parse(up.body.toString()).bytes === upload.length, `${up.ms.toFixed(0)} ms`);

  const parallel = await Promise.all(Array.from({ length: 20 }, () => viaHttp(ab.open, 80, 'GET', '/api/json')));
  check('20 concurrent requests multiplex on one session', parallel.every(result => result.status === 200));

  const blob = await viaHttp(ab.open, 80, 'GET', '/api/blob');
  const blobDirect = await viaHttp(null, directPort, 'GET', '/api/blob');
  check('32 MB download', blob.body.length === 32 * 1024 * 1024, `${blob.ms.toFixed(0)} ms tunnel, ${blobDirect.ms.toFixed(0)} ms direct`);

  const echoDirect = await wsEcho(null, directPort, 200);
  console.log(`     WebSocket round trip p50/p95: tunnel ${echo.p50.toFixed(2)}/${echo.p95.toFixed(2)} ms, direct ${echoDirect.p50.toFixed(2)}/${echoDirect.p95.toFixed(2)} ms`);
  const small = await Promise.all(Array.from({ length: 50 }, (_, index) => index).map(async () => (await viaHttp(ab.open, 80, 'GET', '/api/json')).ms));
  small.sort((x, y) => x - y);
  console.log(`     small request p50 over the tunnel: ${small[25]!.toFixed(2)} ms (new CONNECT stream + HTTP/1.1 request each)`);

  // Direction B → A over a second WebSocket that A also dialed: the roles flip at the HTTP/2 layer only.
  const appA = await peerApp();
  const wsBA = new WebSocket(`ws://127.0.0.1:${tunnelPort}`);
  await once(wsBA, 'open');
  const [dialerSide, acceptorSide] = await Promise.all([secure(createWebSocketStream(wsBA), a, b.fingerprint, false), accepted.shift()!]);
  serveInto(dialerSide, appA.server, 'probe-b');
  const ba = connectThrough(acceptorSide);
  const reverse = await viaHttp(ba.open, 80, 'GET', '/api/json');
  check('reverse direction: the accepting side sends requests to the dialer', reverse.status === 200 && JSON.parse(reverse.body.toString()).link === 'probe-b', reverse.body.toString());

  // Teardown: closing the WebSocket ends the session; a later request fails rather than hanging.
  wsAB.terminate();
  await new Promise(resolve => setTimeout(resolve, 50));
  const after = await Promise.race([viaHttp(ab.open, 80, 'GET', '/api/json').then(() => 'answered', () => 'failed'), new Promise(resolve => setTimeout(() => resolve('hung'), 2000))]);
  check('a dropped tunnel fails new requests promptly', after === 'failed', String(after));

  ba.session.close(); wsBA.terminate(); wss.close();
  await Promise.all([peer.close(), direct.close(), appA.close()]);
  const failed = checks.filter(entry => !entry.ok);
  console.log(failed.length ? `\n${failed.length} check(s) failed` : `\nall ${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
