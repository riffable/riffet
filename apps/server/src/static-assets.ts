import type { FastifyInstance } from 'fastify';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { isApiRequest } from './auth.js';

const gzipAsync = promisify(gzip), brotliAsync = promisify(brotliCompress);
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
// Lets Chrome attach the page's JS call stack to the crash report it sends when the user exits an unresponsive tab.
const CRASH_REPORTING = { 'Document-Policy': 'include-js-call-stacks-in-crash-reports', 'Reporting-Endpoints': 'crash-reporting="/api/client-reports", default="/api/client-reports"' };
type Encoding = 'br' | 'gzip' | 'identity';
interface Asset { stamp: string; body: Buffer; etag: string; encoded: Partial<Record<Encoding, Buffer>>; pending: Partial<Record<Encoding, Promise<Buffer>>>; bytes: number }

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
export function registerWebAssets(app: FastifyInstance, root?: string) {
  const webRoot = root ? resolve(root) : undefined;
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
    const etag = `"${asset.etag}-${selected}"`;
    reply.header('Content-Type', mime[extname(path)] ?? 'application/octet-stream')
      .header('Content-Security-Policy', CSP).header('Vary', 'Accept-Encoding').header('ETag', etag)
      .header('Cache-Control', path.startsWith(join(webRoot, 'assets') + sep) && /-[\w-]{8,}\.[^.]+$/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (selected !== 'identity') reply.header('Content-Encoding', selected);
    if (extname(path) === '.html') reply.headers(CRASH_REPORTING);
    if (request.headers['if-none-match']?.split(',').some((value) => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)) return reply.code(304).send();
    let body = asset.body;
    if (selected !== 'identity') {
      asset.pending[selected] ??= asset.encoded[selected] ? Promise.resolve(asset.encoded[selected]!) : (selected === 'br'
        ? brotliAsync(asset.body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }) : gzipAsync(asset.body)).then((encoded) => {
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
