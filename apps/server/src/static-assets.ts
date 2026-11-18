import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { WORKBENCH_APPEARANCE_BUDGET } from '../../../packages/contracts/src/budgets.js';
import { isApiRequest, localRequest } from './auth.js';
import type { Store } from './store.js';

const gzipAsync = promisify(gzip), brotliAsync = promisify(brotliCompress);
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
// Lets Chrome attach the page's JS call stack to the crash report it sends when the user exits an unresponsive tab.
const CRASH_REPORTING = { 'Document-Policy': 'include-js-call-stacks-in-crash-reports', 'Reporting-Endpoints': 'crash-reporting="/api/client-reports", default="/api/client-reports"' };
type Encoding = 'br' | 'gzip' | 'identity';
interface Asset { stamp: string; body: Buffer; etag: string; encoded: Partial<Record<Encoding, Buffer>>; pending: Partial<Record<Encoding, Promise<Buffer>>>; bytes: number }

/** Single-use proofs for the main Web document and its reconnects across server restarts. */
export class WorkbenchDocumentProofs {
  constructor(private readonly store: Store) {}

  issue(): string {
    const proof = randomBytes(32).toString('base64url');
    const now = Date.now();
    const digest = createHash('sha256').update(proof).digest('hex');
    this.store.saveWorkbenchDocumentProof(digest, now + WORKBENCH_APPEARANCE_BUDGET.documentProofMs, now, WORKBENCH_APPEARANCE_BUDGET.documentProofs);
    return proof;
  }

  consume(proof: unknown): boolean {
    if (typeof proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(proof)) return false;
    const digest = createHash('sha256').update(proof).digest('hex');
    return this.store.takeWorkbenchDocumentProof(digest, Date.now());
  }
}

function isTopLevelDocument(request: FastifyRequest): boolean {
  return request.method === 'GET' && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
}

function canIsolateOpener(request: FastifyRequest): boolean {
  if (localRequest(request) || request.protocol === 'https') return true;
  return String(request.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim().toLowerCase() === 'https';
}

function compress(body: Buffer, encoding: Exclude<Encoding, 'identity'>): Promise<Buffer> {
  return encoding === 'br'
    ? brotliAsync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
    : gzipAsync(body);
}

export function encodingFor(header: string | undefined, supported: readonly Encoding[] = ['br', 'gzip', 'identity']): Encoding | undefined {
  const accepted = new Map((header ?? '').split(',').map((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.find((param) => param.trim().startsWith('q='));
    const value = q ? Number(q.trim().slice(2)) : 1;
    return [name, Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0] as const;
  }));
  const quality = (encoding: Encoding) => accepted.get(encoding) ?? (encoding === 'identity' ? (accepted.get('*') === 0 ? 0 : 1) : accepted.get('*') ?? 0);
  return supported.filter((encoding) => quality(encoding) > 0).sort((a, b) => quality(b) - quality(a))[0];
}

/** Cache is scoped to one server, revalidated by file metadata, and bounded in bytes and entries. */
export function registerWebAssets(app: FastifyInstance, root?: string, documentProofs?: WorkbenchDocumentProofs) {
  const webRoot = root ? resolve(root) : undefined;
  const index = webRoot ? join(webRoot, 'index.html') : undefined;
  if (documentProofs && !webRoot) {
    // The Vite middleware renders the development document. A tab navigating to this loopback
    // route receives an empty response, so no HTML or script exposes the proof to its opener.
    app.get('/__riffet/workbench-document-proof', (request, reply) => {
      if (!localRequest(request) || !isTopLevelDocument(request)) return reply.code(404).send();
      return reply.header('Cache-Control', 'no-store').header('X-Riffet-Workbench-Document-Proof', documentProofs.issue()).code(204).send();
    });
  }
  const cache = new Map<string, Asset>();
  const loading = new Map<string, Promise<Asset>>();
  let bytes = 0;
  const trim = () => {
    while (bytes > 32 * 1024 * 1024 || cache.size > 128) {
      const key = cache.keys().next().value;
      if (key === undefined) break;
      bytes -= cache.get(key)!.bytes; cache.delete(key);
    }
  };
  const load = async (path: string): Promise<Asset> => {
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Not a file');
    const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    const current = cache.get(path);
    if (current?.stamp === stamp) { cache.delete(path); cache.set(path, current); return current; }
    const key = `${path}:${stamp}`;
    const pending = loading.get(key);
    if (pending) return pending;
    const task = readFile(path).then((body) => {
      const asset: Asset = { stamp, body, etag: createHash('sha256').update(body).digest('base64url'), encoded: {}, pending: {}, bytes: body.length };
      bytes -= cache.get(path)?.bytes ?? 0;
      cache.delete(path); cache.set(path, asset); bytes += asset.bytes; trim();
      return asset;
    }).finally(() => loading.delete(key));
    loading.set(key, task);
    return task;
  };

  app.setNotFoundHandler(async (request, reply) => {
    if (!webRoot || isApiRequest(request) || !['GET', 'HEAD'].includes(request.method)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
    let path: string;
    try { path = resolve(webRoot, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname)); }
    catch { return reply.code(400).send({ error: { code: 'INVALID_PATH', message: 'Invalid path' } }); }
    if (path !== webRoot && !path.startsWith(webRoot + sep)) return reply.code(404).send();
    let asset: Asset;
    try { asset = await load(path); }
    catch {
      if (extname(path)) return reply.code(404).send();
      path = join(webRoot, 'index.html');
      try { asset = await load(path); }
      catch { return reply.code(503).send({ error: { code: 'WEB_NOT_BUILT', message: 'Run pnpm build before starting the production server' } }); }
    }
    const encoding = encodingFor(request.headers['accept-encoding']);
    if (!encoding) return reply.code(406).send();
    const compressible = /\.(html|js|css|svg|json)$/.test(path);
    // Small assets need no compression, unless identity was explicitly rejected.
    const identityAllowed = encodingFor(request.headers['accept-encoding'], ['identity']) === 'identity';
    const selected = (asset.body.length < 1024 || !compressible) && identityAllowed ? 'identity' : encoding;
    const vary = path === index ? 'Accept-Encoding, Sec-Fetch-Mode, Sec-Fetch-Dest' : 'Accept-Encoding';
    if (documentProofs && path === index && isTopLevelDocument(request) && canIsolateOpener(request)) {
      const html = asset.body.toString('utf8').replace(/<head(?:\s[^>]*)?>/i, head =>
        `${head}<meta name="riffet-workbench-proof" content="${documentProofs.issue()}">`);
      const document = Buffer.from(html);
      const body = selected === 'identity' ? document : await compress(document, selected);
      reply.headers(CRASH_REPORTING).header('Content-Type', mime['.html'])
        .header('Content-Security-Policy', CSP).header('Cross-Origin-Opener-Policy', 'same-origin')
        .header('Vary', vary).header('Cache-Control', 'private, no-store').header('Content-Length', body.length);
      if (selected !== 'identity') reply.header('Content-Encoding', selected);
      return reply.send(body);
    }
    const etag = `"${asset.etag}-${selected}"`;
    reply.header('Content-Type', mime[extname(path)] ?? 'application/octet-stream')
      .header('Content-Security-Policy', CSP).header('Vary', vary).header('ETag', etag)
      .header('Cache-Control', path.startsWith(join(webRoot, 'assets') + sep) && /-[\w-]{8,}\.[^.]+$/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (selected !== 'identity') reply.header('Content-Encoding', selected);
    if (extname(path) === '.html') reply.headers(CRASH_REPORTING);
    if (request.headers['if-none-match']?.split(',').some((value) => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)) return reply.code(304).send();
    let body = asset.body;
    if (selected !== 'identity') {
      asset.pending[selected] ??= asset.encoded[selected] ? Promise.resolve(asset.encoded[selected]!) : compress(asset.body, selected).then((encoded) => {
          asset.encoded[selected] = encoded; asset.bytes += encoded.length;
          if (cache.get(path) === asset) { bytes += encoded.length; trim(); }
          return encoded;
        }).finally(() => { delete asset.pending[selected]; });
      body = await asset.pending[selected]!;
    }
    reply.header('Content-Length', body.length);
    return reply.send(request.method === 'HEAD' ? undefined : body);
  });
  app.addHook('onClose', async () => { cache.clear(); loading.clear(); bytes = 0; });
}
