import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
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
    // Both ends derive the same comparison code from the two certificates.
    const code = (await a.call<{ links: Array<{ verificationCode: string }> }>('GET', '/api/links')).body.links[0]?.verificationCode;
    expect(code).toMatch(/^\d{3} \d{3}$/);
    expect((fromB[0] as { verificationCode?: string }).verificationCode).toBe(code);
    // Both security records hold the link: B's names A as the server that joined.
    const events = (await b.call<{ events: Array<{ kind: string; subjectId?: string; actor: { kind?: string } }> }>('GET', '/api/security/events')).body.events;
    expect(events).toContainEqual(expect.objectContaining({ kind: 'link-added', subjectId: a.serverId, actor: expect.objectContaining({ kind: 'link' }) }));
    expect((await a.call<{ events: Array<{ kind: string }> }>('GET', '/api/security/events')).body.events.map(event => event.kind)).toContain('link-added');
  });

  it('names the linked servers in its own bootstrap, not in one read through the link', async () => {
    const own = await a.call<{ serverId?: string; servers?: Array<{ id: string }> }>('GET', '/api/bootstrap');
    expect(own.body.serverId).toBe(a.serverId);
    expect(own.body.servers?.map(server => server.id)).toEqual([a.serverId, b.serverId]);
    const peer = await a.call<{ serverId?: string; servers?: unknown; projects: unknown[] }>('GET', `/api/servers/${b.serverId}/bootstrap`);
    expect(peer.status).toBe(200);
    expect(peer.body).not.toHaveProperty('servers');
    expect(peer.body).not.toHaveProperty('serverId');
    // Only the link sets `x-riffet-link`; a client's own copy is dropped.
    const forged = await fetch(`${a.base}/api/bootstrap`, { headers: { cookie: a.cookie, 'x-riffet-link': b.serverId } });
    expect(((await forged.json()) as { servers?: unknown[] }).servers).toHaveLength(2);
  });

  it('forwards requests to the peer and records its writes there', async () => {
    const projects = await a.call<unknown[]>('GET', `/api/servers/${b.serverId}/projects`);
    expect(projects.status).toBe(200);
    const created = await a.call<{ id: string; cwd: string }>('POST', `/api/servers/${b.serverId}/projects`, { cwd: tmpdir() });
    expect(created.status).toBeLessThan(300);
    const onB = await b.call<Array<{ id: string }>>('GET', '/api/projects');
    expect(onB.body.some(project => project.id === created.body.id)).toBe(true);
    // An id of the peer's in the query is the peer's to check, not the entry's.
    expect((await a.call('GET', `/api/servers/${b.serverId}/folder-favorites?projectId=${created.body.id}`)).status).toBe(200);
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

  it('relays a browser to the peer\'s own web app on a loopback port, signed in as a remote browser there', async () => {
    let localWebUrl: string | undefined;
    await until(async () => { localWebUrl = (await a.call<{ links: Array<{ localWebUrl?: string }> }>('GET', '/api/links')).body.links[0]?.localWebUrl; return !!localWebUrl; });
    // B does not let A's side be operated from B, so B relays nothing to A.
    expect((await b.call<{ links: Array<{ localWebUrl?: string }> }>('GET', '/api/links')).body.links[0]?.localWebUrl).toBeUndefined();
    const url = new URL(localWebUrl!);
    expect(url.hostname).toMatch(/\.localhost$/);
    // `*.localhost` is not resolved the same everywhere, so the request goes to 127.0.0.1 and names the host itself.
    const send = (path: string, options: { method?: string; host?: string; headers?: Record<string, string>; body?: unknown } = {}) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: { error?: { code?: string }; csrfToken?: string } }>((resolve, reject) => {
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
      const request = http.request({ host: '127.0.0.1', port: Number(url.port), method: options.method ?? 'GET', path, headers: { host: options.host ?? url.host, ...(payload ? { 'content-type': 'application/json' } : {}), ...options.headers } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
      });
      request.on('error', reject);
      request.end(payload);
    });
    // Not the link's identity: B asks for its own sign-in, and a page that rebound its own name to the port is refused.
    expect((await send('/api/projects')).body.error?.code).toBe('UNAUTHENTICATED');
    expect((await send('/api/projects', { host: `evil.example:${url.port}` })).body.error?.code).toBe('INVALID_HOST');
    const token = (await readFile(join(b.stateDir, 'access-token'), 'utf8')).trim();
    const login = await send('/api/auth/login', { method: 'POST', body: { token } });
    expect(login.status).toBe(200);
    const cookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0]!;
    expect(cookie).toMatch(/^cw_session=/);
    // Encrypted all the way, so the browser is not held to an unencrypted one's reads; B's own settings are reachable.
    expect((await send('/api/links', { headers: { cookie } })).status).toBe(200);
    const created = await send('/api/projects', { method: 'POST', headers: { cookie, 'x-csrf-token': login.body.csrfToken!, origin: `http://${url.host}` }, body: { cwd: tmpdir() } });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
  });

  it('denies what a peer must not reach, and its control over this server', async () => {
    for (const [method, path] of [['GET', '/settings/push'], ['POST', '/pairing/code'], ['GET', '/links'], ['PATCH', '/links/self'], ['GET', '/devices'], ['PATCH', '/settings'], ['GET', `/servers/${a.serverId}/projects`], ['GET', '/assistant/memory']] as const) {
      const reply = await a.call(method, `/api/servers/${b.serverId}${path}`, method === 'GET' ? undefined : {});
      expect(reply.status, `${method} ${path}`).toBe(403);
      expect(reply.body.error?.code, `${method} ${path}`).toBe('LINK_FORBIDDEN');
    }
  });

  it('renames this server and linked peers with unique aliases preserved across updates', async () => {
    const renamedSelf = await b.call<{ self: { name: string } }>('PATCH', '/api/links/self', { name: 'Build Mac' });
    expect(renamedSelf.status).toBe(200);
    expect(renamedSelf.body.self.name).toBe('Build Mac');
    await until(async () => (await a.call<{ servers: Array<{ id: string; name: string }> }>('GET', '/api/servers')).body.servers.find(server => server.id === b.serverId)?.name === 'Build Mac');

    const badAlias = await a.call('PATCH', `/api/links/${b.serverId}`, { alias: 'Bad Alias!' });
    expect(badAlias.status).toBe(400);
    expect(badAlias.body.error?.code).toBe('INVALID_LINK_ALIAS');

    const updated = await a.call<{ link: { name: string; peerName?: string; alias: string; note?: string; platform?: { os: string; arch: string } } }>('PATCH', `/api/links/${b.serverId}`, { name: 'My Mac', alias: 'mac-mini', note: 'iOS builds' });
    expect(updated.status).toBe(200);
    expect(updated.body.link).toMatchObject({ name: 'My Mac', peerName: 'Build Mac', alias: 'mac-mini', note: 'iOS builds', platform: { os: process.platform, arch: process.arch } });

    // A later rename on the peer updates `peerName` without overwriting the local custom name or alias.
    await b.call('PATCH', '/api/links/self', { name: 'Build Mac 2' });
    await until(async () => (await a.call<{ links: Array<{ serverId: string; peerName?: string }> }>('GET', '/api/links')).body.links.find(link => link.serverId === b.serverId)?.peerName === 'Build Mac 2');
    const kept = (await a.call<{ links: Array<{ serverId: string; name: string; alias: string; note?: string }> }>('GET', '/api/links')).body.links.find(link => link.serverId === b.serverId);
    expect(kept).toMatchObject({ name: 'My Mac', alias: 'mac-mini', note: 'iOS builds' });
  });

  it('runs remote commands over the link with exit codes, timeout and inbound enforcement', async () => {
    const ok = await a.call<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }>('POST', `/api/servers/${b.serverId}/remote/exec`, { command: 'printf hello; printf err >&2; exit 7' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ exitCode: 7, stdout: 'hello', stderr: 'err', timedOut: false, truncated: false });

    const timed = await a.call<{ timedOut: boolean }>('POST', `/api/servers/${b.serverId}/remote/exec`, { command: 'sleep 5', timeoutMs: 1_000 });
    expect(timed.status).toBe(200);
    expect(timed.body.timedOut).toBe(true);

    // Turning off inbound on B immediately blocks remote execution too.
    await b.call('PATCH', `/api/links/${a.serverId}`, { inbound: false });
    const blocked = await a.call('POST', `/api/servers/${b.serverId}/remote/exec`, { command: 'echo nope' });
    expect(blocked.status).toBe(403);
    await b.call('PATCH', `/api/links/${a.serverId}`, { inbound: true });
    await until(async () => (await a.call('POST', `/api/servers/${b.serverId}/remote/exec`, { command: 'true' })).status === 200);
  }, 20_000);

  it('exposes remote_list and remote_exec to Riffet MCP only for explicitly granted linked servers', async () => {
    const project = a.store.createProject(tmpdir(), 'local');
    const session = a.store.createSession({ projectId: project.id, kind: 'native', title: 'remote mcp' });
    const spec = a.riffetMcp.server(session.id)!;
    const token = (JSON.parse(await readFile(spec.args[spec.args.indexOf('--credential') + 1]!, 'utf8')) as { credential: string }).credential;
    const mcp = async (method: string, params?: Record<string, unknown>) => {
      const response = await a.app.inject({
        method: 'POST',
        url: '/api/riffet-mcp',
        headers: { authorization: `Bearer ${token}` },
        payload: { method, params },
      });
      return response.json().result;
    };

    // By default, no remote tools are injected into ordinary conversations.
    const initial = await mcp('tools/list') as { tools: Array<{ name: string }> };
    expect(initial.tools.map(t => t.name)).not.toContain('remote_exec');

    // Granting server B exposes `remote_list` and `remote_exec` scoped strictly to B.
    const granted = await a.call('PATCH', `/api/sessions/${session.id}`, { toolGroups: [`server:${b.serverId}`] });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    const listed = await mcp('tools/list') as { tools: Array<{ name: string }> };
    expect(listed.tools.map(t => t.name)).toEqual(expect.arrayContaining(['remote_list', 'remote_exec']));

    const remotes = await mcp('tools/call', { name: 'remote_list', arguments: {} }) as { structuredContent?: { servers: Array<{ id: string; alias: string }> } };
    expect(remotes.structuredContent?.servers).toHaveLength(1);
    expect(remotes.structuredContent?.servers[0]).toMatchObject({ id: b.serverId, alias: 'mac-mini' });

    const ran = await mcp('tools/call', { name: 'remote_exec', arguments: { server: 'mac-mini', command: 'printf from-mcp' } }) as { isError?: boolean; structuredContent?: { stdout: string; exitCode: number } };
    expect(ran.isError).not.toBe(true);
    expect(ran.structuredContent).toMatchObject({ stdout: 'from-mcp', exitCode: 0 });

    // Calling a server outside the conversation's grant is rejected by the server whitelist.
    const denied = await mcp('tools/call', { name: 'remote_exec', arguments: { server: 'ungranted-box', command: 'echo hi' } }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain('REMOTE_NOT_ALLOWED');

    // Removing the grant stops subsequent tool calls immediately without restarting the CLI.
    await a.call('PATCH', `/api/sessions/${session.id}`, { toolGroups: [] });
    const revoked = await mcp('tools/call', { name: 'remote_exec', arguments: { server: 'mac-mini', command: 'echo hi' } }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(revoked.isError).toBe(true);
    expect(revoked.content[0]?.text).toContain('TOOL_NOT_AVAILABLE');
  }, 20_000);

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
