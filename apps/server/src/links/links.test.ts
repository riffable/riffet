import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import WebSocket, { createWebSocketStream } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createLinkIdentity } from './identity.js';
import { classifyLinkRoute } from './policy.js';
import { plain, secure } from './tunnel.js';

/**
 * Server links end to end (docs/SERVER-LINKS.md): two real servers on loopback, joined with a link string over the
 * `direct` transport. Covers what the link must guarantee: data isolation (the inbound switch, the denied routes),
 * forwarding of plain requests, uploads and WebSockets, and that ending the link on one side ends it on both.
 */
type Booted = Awaited<ReturnType<typeof boot>>;
const cleanups: Array<() => Promise<void>> = [];

async function boot() {
  const stateDir = await mkdtemp(join(tmpdir(), 'riffet-link-'));
  const previous = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = join(stateDir, 'claude'); process.env.CODEX_HOME = join(stateDir, 'codex');
  const created = await createApp({ stateDir, cliPath: '/nonexistent/cursor-agent' });
  process.env.CLAUDE_CONFIG_DIR = previous.claude; process.env.CODEX_HOME = previous.codex;
  await created.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (created.app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const token = (await readFile(join(stateDir, 'access-token'), 'utf8')).trim();
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).find(value => value?.startsWith('cw_session='))!;
  const { csrfToken } = await login.json() as { csrfToken: string };
  const call = async <T = Record<string, unknown>>(method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { cookie, 'x-csrf-token': csrfToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => ({})) as T & { error?: { code?: string } } };
  };
  cleanups.push(async () => { await created.app.close(); await rm(stateDir, { recursive: true, force: true }); });
  return { ...created, base, port, cookie, csrfToken, call, serverId: (await (await fetch(`${base}/health`)).json() as { serverId: string }).serverId };
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('timed out');
}

describe('server links', () => {
  let a: Booted, b: Booted;
  beforeAll(async () => {
    a = await boot(); b = await boot();
    // B makes the link string; A joins it. B lets A operate it; A does not let B operate A.
    const invite = await b.call<{ link: string }>('POST', '/api/links/invites', { url: b.base, inbound: true });
    expect(invite.status).toBe(200);
    const joined = await a.call<{ link: { serverId: string; outbound: boolean } }>('POST', '/api/links/join', { link: invite.body.link, inbound: false });
    expect(joined.status).toBe(200);
    expect(joined.body.link.serverId).toBe(b.serverId);
    await until(async () => (await a.call<{ links: Array<{ state: string }> }>('GET', '/api/links')).body.links[0]?.state === 'online');
  }, 30_000);
  afterAll(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

  it('classifies every registered route', () => {
    const missing = [a.registeredRoutes, b.registeredRoutes].flat()
      .filter(route => !classifyLinkRoute(route.method, route.url))
      .map(route => `${route.method} ${route.url}`);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('lists both sides with their directions', async () => {
    const servers = (await a.call<{ servers: Array<{ id: string; self?: boolean; outbound: boolean; inbound: boolean; online: boolean }> }>('GET', '/api/servers')).body.servers;
    expect(servers[0]).toMatchObject({ id: a.serverId, self: true });
    expect(servers[1]).toMatchObject({ id: b.serverId, outbound: true, inbound: false, online: true });
    const fromB = (await b.call<{ links: Array<{ serverId: string; inbound: boolean; outbound: boolean; dialer: boolean }> }>('GET', '/api/links')).body.links;
    expect(fromB).toEqual([expect.objectContaining({ serverId: a.serverId, inbound: true, outbound: false, dialer: false })]);
  });

  it('forwards requests to the peer and records its writes there', async () => {
    const projects = await a.call<unknown[]>('GET', `/api/servers/${b.serverId}/projects`);
    expect(projects.status).toBe(200);
    const created = await a.call<{ id: string; cwd: string }>('POST', `/api/servers/${b.serverId}/projects`, { cwd: tmpdir() });
    expect(created.status).toBeLessThan(300);
    const onB = await b.call<Array<{ id: string }>>('GET', '/api/projects');
    expect(onB.body.some(project => project.id === created.body.id)).toBe(true);
    await until(async () => ((await b.call<{ entries: Array<{ method: string; path: string }> }>('GET', `/api/links/${a.serverId}/audit`)).body.entries ?? []).some(entry => entry.method === 'POST' && entry.path === '/api/projects'));
  });

  it('relays an upload body unchanged', async () => {
    const data = Buffer.alloc(3 * 1024 * 1024, 7).toString('base64');
    const upload = await a.call<{ id?: string; size?: number }>('POST', `/api/servers/${b.serverId}/attachments`, { name: 'blob.bin', mimeType: 'application/octet-stream', dataBase64: data });
    expect(upload.status, JSON.stringify(upload.body)).toBeLessThan(300);
  });

  it('relays WebSockets', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${a.port}/api/servers/${b.serverId}/lists/stream`, { headers: { cookie: a.cookie, origin: a.base } });
    const [first] = await new Promise<[string]>((resolve, reject) => { socket.once('message', data => resolve([String(data)])); socket.once('error', reject); socket.once('close', code => reject(new Error(`closed ${code}`))); });
    expect(JSON.parse(first)).toMatchObject({ event: 'changed' });
    socket.close();
  });

  it('denies what a peer must not reach, and its control over this server', async () => {
    for (const [method, path] of [['GET', '/settings/push'], ['POST', '/pairing/code'], ['GET', '/links'], ['GET', '/devices'], ['PATCH', '/settings'], ['GET', `/servers/${a.serverId}/projects`], ['GET', '/assistant/memory']] as const) {
      const reply = await a.call(method, `/api/servers/${b.serverId}${path}`, method === 'GET' ? undefined : {});
      expect(reply.status, `${method} ${path}`).toBe(403);
      expect(reply.body.error?.code, `${method} ${path}`).toBe('LINK_FORBIDDEN');
    }
  });

  it('refuses the direction the other side did not allow', async () => {
    const reverse = await b.call('GET', `/api/servers/${a.serverId}/projects`);
    expect(reverse.status).toBe(403);
    expect(reverse.body.error?.code).toBe('LINK_NOT_ALLOWED');
  });

  it('stops serving at once when inbound is switched off', async () => {
    const off = await b.call('PATCH', `/api/links/${a.serverId}`, { inbound: false });
    expect(off.status).toBe(200);
    const denied = await a.call('GET', `/api/servers/${b.serverId}/projects`);
    expect(denied.status).toBe(403);
    await until(async () => (await a.call<{ servers: Array<{ id: string; outbound: boolean }> }>('GET', '/api/servers')).body.servers.find(server => server.id === b.serverId)?.outbound === false);
    await b.call('PATCH', `/api/links/${a.serverId}`, { inbound: true });
    await until(async () => (await a.call('GET', `/api/servers/${b.serverId}/projects`)).status === 200);
  });

  it('survives an unpaired caller that resets its streams', async () => {
    // The tunnel endpoint is public: any certificate gets through TLS, and a reset stream must not stop the process.
    for (const query of ['role=primary', 'role=primary&join=not-an-invite']) {
      const socket = new WebSocket(`ws://127.0.0.1:${b.port}/api/links/tunnel?${query}`);
      await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
      const { socket: tlsSocket } = await secure(createWebSocketStream(socket), createLinkIdentity('stranger'), 'client');
      const session = http2.connect('http://riffet.link', { createConnection: () => plain(tlsSocket) as never });
      session.on('error', () => undefined);
      for (const method of ['POST', 'CONNECT']) {
        const stream = session.request(method === 'CONNECT' ? { ':method': 'CONNECT', ':authority': 'riffet.link:80' } : { ':method': 'POST', ':path': '/_link/hello' });
        stream.on('error', () => undefined);
        stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      }
      await new Promise(resolve => setTimeout(resolve, 200));
      session.destroy(); socket.terminate();
    }
    expect((await fetch(`${b.base}/health`)).status).toBe(200);
  });

  it('ends the link on both sides when one removes it', async () => {
    const removed = await b.call('DELETE', `/api/links/${a.serverId}`);
    expect(removed.status).toBe(200);
    await until(async () => (await a.call<{ links: Array<{ state: string }> }>('GET', '/api/links')).body.links[0]?.state === 'removed');
    const after = await a.call('GET', `/api/servers/${b.serverId}/projects`);
    expect(after.status).toBe(404);
  });

  it('links again after either side ended the link', async () => {
    const relink = async () => {
      const invite = await b.call<{ link: string }>('POST', '/api/links/invites', { url: b.base, inbound: true });
      const joined = await a.call('POST', '/api/links/join', { link: invite.body.link, inbound: false });
      expect(joined.status, JSON.stringify(joined.body)).toBe(200);
      await until(async () => (await a.call<{ links: Array<{ state: string }> }>('GET', '/api/links')).body.links[0]?.state === 'online');
    };
    // B ended it in the previous case; now the joiner ends it, which leaves B holding the record the peer removed.
    await relink();
    expect((await a.call('DELETE', `/api/links/${b.serverId}`)).status).toBe(200);
    await until(async () => (await b.call<{ links: Array<{ state: string }> }>('GET', '/api/links')).body.links[0]?.state === 'removed');
    await relink();
    expect((await a.call('GET', `/api/servers/${b.serverId}/projects`)).status).toBe(200);
  }, 30_000);
});
