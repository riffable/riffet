import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { CURSOR_API_CACHE_BUDGET } from '@contracts';
import { decodeAvailableModels, type CursorParameterizedModel } from './model-parameters.js';

const AVAILABLE_MODELS = '/aiserver.v1.AiService/AvailableModels';

function decompress(body: Buffer, encoding: string | undefined): Buffer {
  switch (encoding?.trim().toLowerCase()) {
    case 'gzip': return gunzipSync(body);
    case 'br': return brotliDecompressSync(body);
    case 'deflate': return inflateSync(body);
    default: return body;
  }
}

/**
 * Runs one `--list-models` behind a loopback pass-through that keeps the `AvailableModels` answer the
 * CLI fetches and does not print. The CLI's unary API client speaks HTTP/1.1, so this works for
 * Cursor's own endpoint as well as a gateway. The server lives only as long as `run`.
 *
 * `unreachable` is set when the front could not reach `upstream`, so the caller can retry directly
 * instead of reporting the front's own failure as the CLI's.
 */
export async function withAvailableModelsTap<T>(upstream: string, run: (endpoint: string) => Promise<T>): Promise<{ result: T; models?: CursorParameterizedModel[]; unreachable: boolean }> {
  const target = new URL(upstream);
  const prefix = target.pathname.replace(/\/$/, '');
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  let models: CursorParameterizedModel[] | undefined;
  let unreachable = false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    const keep = req.method === 'POST' && path === AVAILABLE_MODELS;
    const upstreamRequest = send({
      host: target.hostname, port: target.port || undefined, method: req.method, path: `${prefix}${req.url ?? '/'}`,
      headers: { ...req.headers, host: target.host },
    }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      if (!keep || response.statusCode !== 200) { response.pipe(res); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        res.write(chunk);
        // Past the cache's per-answer bound the answer is only passed on, not kept.
        bytes += chunk.length;
        if (bytes <= CURSOR_API_CACHE_BUDGET.maxBytes) chunks.push(chunk); else chunks.length = 0;
      });
      response.on('end', () => {
        res.end();
        if (bytes > CURSOR_API_CACHE_BUDGET.maxBytes) return;
        try {
          const decoded = decodeAvailableModels(decompress(Buffer.concat(chunks), response.headers['content-encoding']));
          if (decoded.length) models = decoded;
        } catch { /* an answer this reader does not understand leaves the flat list as it is */ }
      });
      response.on('error', () => res.destroy());
    });
    upstreamRequest.on('error', () => { unreachable = true; res.destroy(); });
    res.on('close', () => { if (!res.writableFinished) upstreamRequest.destroy(); });
    req.pipe(upstreamRequest);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  try {
    const result = await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return { result, ...(models ? { models } : {}), unreachable };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
