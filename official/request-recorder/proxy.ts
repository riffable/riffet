// The forwarding proxy: every request goes to the upstream as it came, every response comes back as it came
// (server-sent events included), and a copy of both, cut at a fixed size, goes to the store.

import { request as httpRequest, type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate, type Gunzip } from 'node:zlib';
import { LIMITS, redactHeaders, redactTarget, type Recordings, type RecordedMessage } from './recorder.js';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

class Capture {
  private chunks: Buffer[] = [];
  private kept = 0;
  total = 0;
  add(chunk: Buffer, countTotal = true): void {
    if (countTotal) this.total += chunk.length;
    if (this.kept >= LIMITS.bodyBytes) return;
    const part = chunk.subarray(0, LIMITS.bodyBytes - this.kept);
    this.chunks.push(part);
    this.kept += part.length;
  }
  get full(): boolean { return this.kept >= LIMITS.bodyBytes; }
  text(): string { return Buffer.concat(this.chunks).toString('utf8'); }
}

function decoderFor(encoding: string | undefined): Gunzip | undefined {
  switch (encoding?.trim().toLowerCase()) {
    case 'gzip': return createGunzip();
    case 'deflate': return createInflate() as unknown as Gunzip;
    case 'br': return createBrotliDecompress() as unknown as Gunzip;
    default: return undefined;
  }
}

function forwardHeaders(headers: IncomingMessage['headers'], host: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) if (value !== undefined && !HOP_BY_HOP.has(name) && name !== 'host') result[name] = value;
  result.host = host;
  return result;
}

export interface ProxyOptions {
  /** The base the conversation would otherwise talk to, path prefix included. */
  upstream: URL;
  /** Only requests under this path are served: the capability that keeps other local processes out. */
  prefix: string;
  sessionId: string;
  store: Recordings;
  paused(): boolean;
  onRecorded?(): void;
}

export function createProxyHandler(options: ProxyOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const { upstream, prefix, sessionId, store } = options;
  const transport = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
  const basePath = upstream.pathname.replace(/\/+$/, '');
  return (req, res) => {
    const target = req.url ?? '/';
    if (target !== prefix && !target.startsWith(`${prefix}/`) && !target.startsWith(`${prefix}?`)) { res.writeHead(404).end(); return; }
    const rest = target.slice(prefix.length);
    const started = Date.now();
    const recording = !options.paused();
    const requestCapture = new Capture();
    const responseCapture = new Capture();
    let responseDecoder: Gunzip | undefined;
    let upstreamResponse: IncomingMessage | undefined;
    let status = 0;
    let finished = false;
    let error: string | undefined;
    let responseBytes = 0;

    const finish = (aborted: boolean) => {
      if (finished) return;
      finished = true;
      if (!recording) return;
      const request: RecordedMessage = { headers: redactHeaders(req.headers), body: requestCapture.text(), truncated: requestCapture.total > LIMITS.bodyBytes };
      const response: RecordedMessage | undefined = upstreamResponse
        ? { headers: redactHeaders(upstreamResponse.headers), body: responseCapture.text(), truncated: responseCapture.full }
        : undefined;
      const model = /"model"\s*:\s*"([^"]{1,200})"/.exec(request.body.slice(0, 16 * 1024))?.[1];
      void store.append(sessionId, {
        time: new Date(started).toISOString(), method: req.method ?? 'GET', path: redactTarget(rest.startsWith('/') ? rest : `/${rest}`), status,
        durationMs: Date.now() - started, requestBytes: requestCapture.total, responseBytes: upstreamResponse ? responseBytes : 0,
        ...(model ? { model } : {}), ...(aborted ? { aborted: true } : {}), ...(error ? { error } : {}), request, ...(response ? { response } : {}),
      }).then(() => options.onRecorded?.()).catch(() => undefined);
    };
    const outgoing: RequestOptions = {
      protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined, method: req.method,
      path: `${basePath}${rest.startsWith('/') || rest.startsWith('?') ? rest : `/${rest}`}`,
      headers: forwardHeaders(req.headers, upstream.host),
    };
    const forwarded = transport(outgoing, incoming => {
      upstreamResponse = incoming;
      status = incoming.statusCode ?? 0;
      const headers: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
      res.writeHead(status, incoming.statusMessage, headers);
      if (recording) {
        responseDecoder = decoderFor(incoming.headers['content-encoding'] as string | undefined);
        responseDecoder?.on('data', (chunk: Buffer) => { responseCapture.add(chunk, false); if (responseCapture.full) responseDecoder?.destroy(); });
        responseDecoder?.on('error', () => undefined);
      }
      incoming.on('data', (chunk: Buffer) => {
        responseBytes += chunk.length;
        if (!recording) return;
        if (responseDecoder) { if (!responseDecoder.destroyed) responseDecoder.write(chunk); } else responseCapture.add(chunk);
      });
      incoming.on('end', () => {
        if (!responseDecoder || responseDecoder.destroyed) { finish(false); return; }
        let settled = false;
        const settle = () => { if (!settled) { settled = true; finish(false); } };
        responseDecoder.once('end', settle).once('close', settle).once('error', settle);
        responseDecoder.end();
      });
      incoming.on('error', () => { error = 'response stream failed'; res.destroy(); finish(true); });
      incoming.pipe(res);
    });
    forwarded.on('error', cause => {
      if (!res.headersSent) { status = 502; error = (cause as NodeJS.ErrnoException).code ?? 'upstream unreachable'; res.writeHead(502, { 'content-type': 'text/plain' }); res.end('Bad gateway'); finish(false); }
      else { error = 'upstream failed mid-response'; res.destroy(); finish(true); }
    });
    // The client going away before the response ends ends the upstream request too.
    res.on('close', () => { if (!finished && !res.writableFinished) { forwarded.destroy(); finish(true); } });
    req.on('data', (chunk: Buffer) => { if (recording) requestCapture.add(chunk); });
    req.pipe(forwarded);
  };
}
