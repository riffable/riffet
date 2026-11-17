import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareRecorder, recoverRecorder } from './process.js';
import { createProxyHandler } from './proxy.js';
import { LIMITS, Recordings, redactHeaders, redactTarget } from './recorder.js';

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
function send(port: number, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function upstream() {
  const seen: Array<{ url?: string; auth?: string }> = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    req.resume();
    req.on('end', () => {
      if (req.url?.endsWith('/stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => res.end('data: two\n\n'), 30);
      } else if (req.url?.endsWith('/gzip')) {
        res.writeHead(200, { 'content-encoding': 'gzip', 'set-cookie': 'a=b' });
        res.end(gzipSync('{"ok":true}'));
      } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
    });
  });
  const port = await listen(server);
  closers.push(() => new Promise(resolve => server.close(() => resolve())));
  return { port, seen };
}
const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 100 && !await check(); i++) await new Promise(r => setTimeout(r, 20)); };

describe('request recorder', () => {
  it('redacts credentials in headers and query', () => {
    expect(redactHeaders({ authorization: 'Bearer x', 'x-api-key': 'k', 'x-custom-token': 't', accept: 'a', cookie: ['c'] }))
      .toEqual({ authorization: '[redacted]', 'x-api-key': '[redacted]', 'x-custom-token': '[redacted]', accept: 'a', cookie: '[redacted]' });
    expect(redactTarget('/v1/x?key=abc&alt=sse')).toBe('/v1/x?key=%5Bredacted%5D&alt=sse');
  });

  it('forwards unchanged, streams, and records without credentials', async () => {
    const gateway = await upstream();
    const dir = await mkdtemp(join(tmpdir(), 'recorder-'));
    closers.push(() => rm(dir, { recursive: true, force: true }));
    const store = new Recordings(dir);
    const proxy = createServer(createProxyHandler({ upstream: new URL(`http://127.0.0.1:${gateway.port}/base`), prefix: '/tok', sessionId: 's1', store, paused: () => false }));
    const port = await listen(proxy);
    closers.push(() => new Promise(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()); }));
    const headers = { authorization: 'Bearer secret', 'content-type': 'application/json' };
    expect((await send(port, '/other/v1/messages', headers, '{}')).status).toBe(404);
    expect(await send(port, '/tok/v1/messages', headers, '{"model":"m-1"}')).toEqual({ status: 200, body: '{"ok":true}' });
    expect((await send(port, '/tok/stream', headers, '{}')).body).toBe('data: one\n\ndata: two\n\n');
    await send(port, '/tok/gzip', headers, '{}');
    expect(gateway.seen[0]).toEqual({ url: '/base/v1/messages', auth: 'Bearer secret' });
    await until(async () => (await store.list())[0]?.bytes > 0 && (await readFile(join(dir, 's1', '000001.jsonl'), 'utf8')).split('\n').length > 3);
    const lines = (await readFile(join(dir, 's1', '000001.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(lines.map(line => line.path).sort()).toEqual(['/gzip', '/stream', '/v1/messages']);
    const first = lines.find(line => line.path === '/v1/messages');
    expect(first).toMatchObject({ method: 'POST', status: 200, model: 'm-1', requestBytes: 15, responseBytes: 11 });
    expect(first.request.headers.authorization).toBe('[redacted]');
    expect(lines.find(line => line.path === '/stream').response.body).toBe('data: one\n\ndata: two\n\n');
    const gzip = lines.find(line => line.path === '/gzip').response;
    expect(gzip.body).toBe('{"ok":true}');
    expect(gzip.headers['set-cookie']).toBe('[redacted]');
    expect(JSON.stringify(lines)).not.toContain('secret');
  });

  it('cuts bodies, and drops the oldest segments past the caps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recorder-'));
    closers.push(() => rm(dir, { recursive: true, force: true }));
    const store = new Recordings(dir, { segmentBytes: 2_000, conversationBytes: 5_000, totalBytes: 8_000, staleMs: LIMITS.staleMs });
    const entry = (n: number) => ({ time: 't', method: 'POST', path: `/${n}`, status: 200, durationMs: 1, requestBytes: 1, responseBytes: 1, request: { headers: {}, body: 'x'.repeat(900), truncated: false } });
    for (let n = 0; n < 12; n++) await store.append('a', entry(n));
    for (let n = 0; n < 12; n++) await store.append('b', entry(n));
    await store.enforce();
    const sizes = (await store.list()).map(item => item.bytes);
    expect(sizes.every(size => size <= 5_000 + 2_000)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(8_000 + 2_000);
    const a = await readdir(join(dir, 'a'));
    expect(a).not.toContain('000001.jsonl');
    await store.clear('a');
    expect((await store.list()).map(item => item.name)).toEqual(['b']);
  });

  it('runs as a daemon that is recovered, pausable and stopped', async () => {
    const gateway = await upstream();
    const root = await mkdtemp(join(tmpdir(), 'recorder-'));
    closers.push(() => rm(root, { recursive: true, force: true }));
    const options = { sessionId: 's2', fingerprint: 'f', directory: join(root, 'routes') };
    const handle = await prepareRecorder({ ...options, upstream: `http://127.0.0.1:${gateway.port}`, recordDir: join(root, 'rec') });
    closers.push(() => handle.stop());
    await handle.bindNative({ address: 'unix:/x', pid: process.pid });
    const url = new URL(handle.baseUrl);
    await send(Number(url.port), `${url.pathname}/v1/a`, {}, '{}');
    await handle.setPaused(true);
    await send(Number(url.port), `${url.pathname}/v1/b`, {}, '{}');
    handle.detach();
    const again = await recoverRecorder({ ...options, id: handle.id, address: 'unix:/x' });
    expect(again?.baseUrl).toBe(handle.baseUrl);
    expect(again?.status().paused).toBe(true);
    expect(await recoverRecorder({ ...options, id: handle.id, address: 'unix:/other' })).toBeUndefined();
    await until(async () => (await readFile(join(root, 'rec', 's2', '000001.jsonl'), 'utf8').catch(() => '')).length > 0);
    expect((await readFile(join(root, 'rec', 's2', '000001.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
    await again!.stop();
    await until(async () => (await readdir(join(root, 'routes'))).length === 0);
    expect(await readdir(join(root, 'routes'))).toEqual([]);
  }, 30_000);
});
