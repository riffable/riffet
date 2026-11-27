import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cursorApiUpstream, cursorLaunchProfileOf } from '../cli-driver.js';
import { CursorApiCache, CursorApiFronts } from './api-cache.js';

const GET_ME = '/aiserver.v1.DashboardService/GetMe';
const EXCHANGE = '/auth/exchange_user_api_key';
const jwt = (id: number, ttlSeconds: number) => `h.${Buffer.from(JSON.stringify({ sub: 'user', randomness: id, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url')}.s`;

describe('CursorApiCache', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

  async function upstream(answer: (auth: string, calls: number, path: string) => { status: number; body: string }) {
    let calls = 0;
    const server: Server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const { status, body } = answer(req.headers.authorization ?? '', ++calls, req.url ?? '');
        res.writeHead(status, { 'content-type': 'application/proto' });
        res.end(body);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls: () => calls };
  }

  async function front(upstreamUrl: string) {
    const dir = await mkdtemp(join(tmpdir(), 'cursor-api-cache-'));
    const cache = new CursorApiCache(upstreamUrl, join(dir, 'port.json'));
    cleanups.push(async () => { await cache.close(); await rm(dir, { recursive: true, force: true }); });
    const base = await cache.start();
    return (auth: string, path = GET_ME) => fetch(`${base}${path}`, { method: 'POST', headers: { authorization: auth }, body: 'q' }).then(async res => ({ status: res.status, body: await res.text() }));
  }

  it('keeps each credential\'s answer to itself', async () => {
    const api = await upstream(auth => ({ status: 200, body: `me:${auth}` }));
    const ask = await front(api.url);
    expect(await ask('Bearer a')).toEqual({ status: 200, body: 'me:Bearer a' });
    expect(await ask('Bearer b')).toEqual({ status: 200, body: 'me:Bearer b' });
    // Served from memory now, still per credential.
    expect(await ask('Bearer a')).toEqual({ status: 200, body: 'me:Bearer a' });
  });

  it('does not replay an answer once the upstream stops giving a 200', async () => {
    const api = await upstream((_auth, calls) => calls === 1 ? { status: 200, body: 'ok' } : { status: 401, body: 'expired' });
    const ask = await front(api.url);
    expect(await ask('Bearer a')).toEqual({ status: 200, body: 'ok' });
    // Answered from memory while the refresh behind it gets the 401 and drops the entry.
    expect(await ask('Bearer a')).toEqual({ status: 200, body: 'ok' });
    await expect.poll(() => ask('Bearer a')).toEqual({ status: 401, body: 'expired' });
    expect(api.calls()).toBeGreaterThanOrEqual(2);
  });

  it('keeps a key\'s answers across the tokens traded for it here, and only for them', async () => {
    let traded = 0;
    // Each trade is a new token, short-lived enough that the next trade goes upstream again.
    const api = await upstream((auth, _calls, path) => path === EXCHANGE
      ? { status: 200, body: JSON.stringify({ accessToken: jwt(++traded, 60), refreshToken: 'r' }) }
      : { status: 200, body: `me:${auth}` });
    const ask = await front(api.url);
    const trade = async () => `Bearer ${(JSON.parse((await ask('Bearer key', EXCHANGE)).body) as { accessToken: string }).accessToken}`;
    const first = await trade();
    expect(await ask(first)).toEqual({ status: 200, body: `me:${first}` });
    const second = await trade();
    expect(second).not.toBe(first);
    // Same key, new token: answered from memory.
    expect(await ask(second)).toEqual({ status: 200, body: `me:${first}` });
    // A token not traded here is nobody's but its own.
    const foreign = `Bearer ${jwt(99, 3600)}`;
    expect(await ask(foreign)).toEqual({ status: 200, body: `me:${foreign}` });
  });

  it('hands a token out again while it has time left', async () => {
    let traded = 0;
    const api = await upstream(() => ({ status: 200, body: JSON.stringify({ accessToken: jwt(++traded, 3600), refreshToken: 'r' }) }));
    const ask = await front(api.url);
    const first = await ask('Bearer key', EXCHANGE);
    expect(await ask('Bearer key', EXCHANGE)).toEqual(first);
    expect(traded).toBe(1);
    // Another key trades for itself.
    expect(await ask('Bearer other', EXCHANGE)).not.toEqual(first);
  });

  it('brings every gateway\'s front back on its port after a restart, the one-front port included', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cursor-api-fronts-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const free = await new Promise<number>(resolve => {
      const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address() as AddressInfo; probe.close(() => resolve(port)); });
    });
    // What a version with a single front, for the default provider only, left behind.
    await writeFile(join(dir, 'cursor-api-front.json'), JSON.stringify({ port: free }));
    const gateway = (endpoint: string) => cursorLaunchProfileOf({ apiEndpoint: endpoint, configDir: join(dir, endpoint.replace(/\W/g, '')) });
    const start = async () => {
      const fronts = new CursorApiFronts(dir);
      cleanups.push(() => fronts.close());
      const [a, b] = [gateway('https://a.example'), gateway('https://b.example')];
      await Promise.all([fronts.serve(a), fronts.serve(b)]);
      return [cursorApiUpstream(a), cursorApiUpstream(b)];
    };
    const first = await start();
    // The first gateway served takes the old port over; the other gets one of its own.
    expect(first[0]).toBe(`http://127.0.0.1:${free}`);
    expect(first[1]).not.toBe(first[0]);
    await cleanups.pop()!();
    expect(await start()).toEqual(first);
  });
});
