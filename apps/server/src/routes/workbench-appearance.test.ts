import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { Auth } from '../auth.js';
import { WorkbenchAppearance } from '../riffet-mcp/workbench-appearance.js';
import { registerWorkbenchAppearanceRoutes } from './workbench-appearance.js';

const path = '/api/workbench/appearance';
const host = { host: 'localhost', origin: 'https://localhost' };
const run = { id: 'run', sessionId: 'assistant' };
const other = { id: 'other-run', sessionId: 'assistant' };

it('binds a Web setting only to the proven workbench of that run and waits for its receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'riffet-workbench-appearance-'));
  const app = Fastify();
  const auth = new Auth(dir);
  const channel = new WorkbenchAppearance(auth);
  const proofs = new Set<string>();
  const issue = () => { const id = randomUUID(); proofs.add(id); return id; };
  await app.register(websocket);
  app.addHook('onRequest', async request => auth.checkOrigin(request));
  registerWorkbenchAppearanceRoutes(app, {
    auth, workbenchAppearance: channel,
    documentProofs: { issue, consume: value => typeof value === 'string' && proofs.delete(value) },
  });
  app.post('/login', async (request, reply) => ({ csrf: auth.login(reply, request) }));
  app.post('/logout', async (request, reply) => { auth.logout(reply, request); return {}; });
  app.post<{ Params: { id: string } }>('/bind/:id', async request => {
    channel.bind(request, request.params.id === run.id ? run : other);
    return {};
  });
  const next = async (socket: Awaited<ReturnType<typeof app.injectWS>>) => {
    const [frame] = await once(socket, 'message');
    return JSON.parse(frame.toString());
  };
  const sockets: Array<Awaited<ReturnType<typeof app.injectWS>>> = [];
  const registered = async (headers: Record<string, string>) => {
    const socket = await app.injectWS(path, { headers });
    sockets.push(socket);
    const ready = next(socket);
    socket.send(JSON.stringify({ documentProof: issue() }));
    const { connectionId } = await ready;
    return { socket, connectionId };
  };
  try {
    await app.ready();
    const signIn = async () => {
      const response = await app.inject({ method: 'POST', url: '/login', headers: host });
      return { ...host, cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': response.json().csrf as string };
    };
    const headers = await signIn();
    const stranger = await signIn();
    await expect(app.injectWS(path, { headers: host })).rejects.toThrow('401');
    await expect(app.injectWS(path, { headers: { ...headers, origin: 'http://localhost', 'x-forwarded-for': '192.0.2.2' } })).rejects.toThrow('403');
    const device = auth.issueDevice('native');
    await expect(app.injectWS(path, { headers: { ...host, authorization: `Bearer ${device.token}` } })).rejects.toThrow('403');
    const unsupported = await app.injectWS(path, { headers });
    sockets.push(unsupported);
    const rejected = once(unsupported, 'close');
    unsupported.send(JSON.stringify({ documentProof: 'unproven document' }));
    expect((await rejected)[0]).toBe(1008);

    const source = await registered(headers);
    const otherTab = await registered(headers);
    const bind = (runId: string, inputHeaders: Record<string, string>, connectionId: string) => app.inject({
      method: 'POST', url: `/bind/${runId}`, headers: { ...inputHeaders, 'x-riffet-workbench': connectionId },
    });
    await bind(other.id, stranger, source.connectionId);
    await expect(channel.apply(other.sessionId, other.id, {})).rejects.toMatchObject({ code: 'WORKBENCH_UNAVAILABLE' });
    await bind(run.id, headers, source.connectionId);
    await bind(run.id, headers, otherTab.connectionId);
    await expect(channel.apply('some-project', run.id, {})).rejects.toMatchObject({ code: 'WORKBENCH_UNAVAILABLE' });

    const command = next(source.socket);
    const changed = channel.apply(run.sessionId, run.id, { themeId: 'solarized' });
    const sent = await command;
    expect(sent.change).toEqual({ themeId: 'solarized' });
    const result = { themeId: 'solarized', mode: 'system', themes: [{ id: 'solarized', name: 'Solarized' }] };
    otherTab.socket.send(JSON.stringify({ callId: sent.callId, error: 'unsupported' }));
    source.socket.send(JSON.stringify({ callId: sent.callId, result }));
    await expect(changed).resolves.toEqual(result);

    const nextChange = next(source.socket);
    const unchanged = channel.apply(run.sessionId, run.id, { mode: 'dark' });
    const unchangedReceipt = expect(unchanged).rejects.toMatchObject({ code: 'WORKBENCH_RESULT_UNKNOWN' });
    source.socket.send(JSON.stringify({ callId: (await nextChange).callId, result }));
    await unchangedReceipt;

    const pendingCommand = next(source.socket);
    const pending = channel.apply(run.sessionId, run.id, { mode: 'dark' });
    const pendingReceipt = expect(pending).rejects.toMatchObject({ code: 'WORKBENCH_RESULT_UNKNOWN' });
    await pendingCommand;
    await app.inject({ method: 'POST', url: '/logout', headers });
    await pendingReceipt;
    await expect(channel.apply(run.sessionId, run.id, {})).rejects.toMatchObject({ code: 'WORKBENCH_UNAVAILABLE' });
  } finally {
    for (const socket of sockets) socket.terminate();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
