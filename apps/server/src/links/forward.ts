import http from 'node:http';
import type { Readable } from 'node:stream';
import WebSocket from 'ws';
import { LINK_BUDGET } from '../../../../packages/contracts/src/index.js';
import type { LinkService } from './service.js';

/**
 * The entry server's side of `/api/servers/<serverId>/<path>` (docs/SERVER-LINKS.md §4): the request is replayed as
 * plain HTTP/1.1 on a fresh CONNECT stream through the link and the answer streamed back, so SSE and uploads pass
 * through unchanged. The browser's credentials stop here; the peer authenticates the tunnel, not the request.
 */

/** Request headers that never leave this server: credentials, hop-by-hop headers, and anything naming a proxy. */
const DROP_REQUEST = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'cookie', 'authorization', 'x-csrf-token', 'origin', 'referer', 'forwarded', 'x-forwarded-for', 'x-forwarded-host',
  'x-forwarded-proto', 'x-forwarded-prefix', 'x-real-ip', 'tailscale-user-login', 'tailscale-user-name', 'x-riffet-link', 'x-riffet-link-origin',
  'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-accept',
]);
/**
 * The only response headers that reach the browser. The answer is shown under this server's origin, so anything that
 * would act on the origin itself (cookies, HSTS, Alt-Svc, redirects, service workers, reporting) stays behind.
 */
const KEEP_RESPONSE = new Set([
  'content-type', 'content-length', 'content-encoding', 'content-disposition', 'content-range', 'content-language',
  'accept-ranges', 'cache-control', 'etag', 'last-modified', 'expires', 'vary', 'date', 'retry-after', 'content-security-policy',
]);
/**
 * Whatever the peer answers is shown under this server's origin. A document it returns runs sandboxed in an opaque
 * origin, so it cannot read this server's cookies or call its API (it is combined with any CSP the peer sent).
 */
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads';

export function forwardedHeaders(headers: http.IncomingHttpHeaders, origin: string | undefined): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) if (value !== undefined && !DROP_REQUEST.has(name.toLowerCase())) out[name] = value;
  out.host = 'riffet.link';
  if (origin) out['x-riffet-link-origin'] = origin.slice(0, 120);
  return out;
}

function answerHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value !== undefined && (KEEP_RESPONSE.has(key) || key.startsWith('x-riffet-'))) out[key] = value;
  }
  const csp = out['content-security-policy'];
  const policies: string[] = Array.isArray(csp) ? csp.map(String) : csp === undefined ? [] : [String(csp)];
  // Comma-separated policies are separate policies, each enforced (CSP3 §3.1).
  out['content-security-policy'] = [...policies, SANDBOX].join(', ');
  out['x-content-type-options'] = 'nosniff';
  return out;
}

/** The peer's path for `/api/servers/<serverId>/<rest>?<query>`, or undefined when the URL is not of that shape. */
export function peerPath(rawUrl: string, serverId: string): string | undefined {
  const prefix = `/api/servers/${serverId}/`;
  if (!rawUrl.startsWith(prefix)) return undefined;
  const rest = rawUrl.slice(prefix.length);
  if (!rest || rest.startsWith('/') || /(^|\/)\.\.?(\/|\?|$)/.test(rest.split('?')[0]!)) return undefined;
  return `/api/${rest}`;
}

function failure(response: http.ServerResponse, status: number, code: string, message: string, params?: unknown) {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: { code, message, ...(params ? { params } : {}) } }));
}

export function forwardHttp(links: LinkService, serverId: string, path: string, request: http.IncomingMessage, body: Readable | undefined, response: http.ServerResponse, origin?: string) {
  let connection;
  try { connection = links.open(serverId); }
  catch (error) {
    const appError = error as { statusCode?: number; code?: string; message?: string; params?: unknown };
    failure(response, appError.statusCode ?? 502, appError.code ?? 'LINK_FAILED', appError.message ?? 'The linked server could not be reached', appError.params);
    return;
  }
  const upstream = http.request({ method: request.method, path, headers: forwardedHeaders(request.headers, origin), createConnection: () => connection as never }, answer => {
    response.writeHead(answer.statusCode ?? 502, answerHeaders(answer.headers));
    answer.pipe(response);
    answer.once('error', () => response.destroy());
  });
  upstream.once('error', error => failure(response, 502, 'LINK_FAILED', `The linked server could not answer: ${error.message}`));
  response.once('close', () => { if (!response.writableFinished) upstream.destroy(); });
  if (body) body.pipe(upstream); else upstream.end();
}

/** Relays one WebSocket message by message; the peer's close code and reason come back unchanged. */
export function forwardWebSocket(links: LinkService, serverId: string, path: string, client: WebSocket, request: http.IncomingMessage, origin?: string) {
  let connection;
  try { connection = links.open(serverId); }
  catch (error) { client.close(1011, String((error as Error).message ?? 'Linked server unreachable').slice(0, 120)); return; }
  const protocols = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const headers = forwardedHeaders(request.headers, origin);
  delete headers['sec-websocket-protocol'];
  const upstream = new WebSocket(`ws://riffet.link${path}`, protocols, { headers: headers as Record<string, string>, createConnection: () => connection as never, maxPayload: LINK_BUDGET.relayMessageBytes });
  const pending: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
  let pendingBytes = 0;
  // A receiver that falls this far behind is closed with 1013, as a slow terminal socket is, instead of being buffered here.
  const relay = (to: WebSocket, from: WebSocket, data: WebSocket.RawData, binary: boolean) => {
    if (to.bufferedAmount > LINK_BUDGET.relayBufferBytes) { to.close(1013, 'Too far behind'); from.close(1013, 'Too far behind'); return; }
    to.send(data, { binary });
  };
  client.on('message', (data, binary) => {
    if (upstream.readyState === WebSocket.OPEN) { relay(upstream, client, data, binary); return; }
    pendingBytes += Buffer.isBuffer(data) ? data.length : 0;
    if (pendingBytes > LINK_BUDGET.relayPendingBytes) { client.close(1013, 'Linked server is not ready'); upstream.terminate(); return; }
    pending.push({ data, binary });
  });
  upstream.on('open', () => { for (const item of pending.splice(0)) upstream.send(item.data, { binary: item.binary }); });
  upstream.on('message', (data, binary) => { if (client.readyState === WebSocket.OPEN) relay(client, upstream, data, binary); });
  const closeCode = (code: number) => (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1011);
  upstream.on('close', (code, reason) => { if (client.readyState <= WebSocket.OPEN) client.close(closeCode(code), reason); });
  upstream.on('error', () => { if (client.readyState <= WebSocket.OPEN) client.close(1011, 'Linked server connection failed'); });
  upstream.on('unexpected-response', (_req, res) => { if (client.readyState <= WebSocket.OPEN) client.close(res.statusCode === 403 ? 1008 : 1011, `Linked server answered ${res.statusCode}`); upstream.terminate(); });
  client.on('close', () => { if (upstream.readyState <= WebSocket.OPEN) upstream.terminate(); });
}
