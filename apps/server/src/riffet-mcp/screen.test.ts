import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.js';

const MASTER = 'screen-tools-test-master-token-with-more-than-24-characters';
const ANDROID = { platform: 'android', appVersion: '1.0', capabilities: ['screen.observe', 'screen.act', 'app.launch'], allowControl: true };
type Call = { callId: string; capability: string; args: Record<string, unknown> };

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), 'riffet-screen-'));
  const booted = await createApp({ stateDir: dir, token: MASTER, cliPath: '/nonexistent/cursor-agent' });
  await booted.dispatch.close();
  await booted.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (booted.app.server.address() as { port: number }).port;
  const host = `127.0.0.1:${port}`;
  const bearer = (token: string) => ({ host, authorization: `Bearer ${token}` });
  const streams: IncomingMessage[] = [];
  /** A paired device that reports `report` and answers each call it receives with `answer(call)`. */
  const device = async (report: object, answer?: (call: Call) => unknown) => {
    const issued = booted.auth.issueDevice('Phone');
    await booted.app.inject({ method: 'PUT', url: '/api/devices/me', headers: bearer(issued.token), payload: report });
    const calls: Call[] = [];
    if (answer) {
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/api/devices/me/stream', headers: bearer(issued.token) }, resolve); req.on('error', reject); req.end();
      });
      streams.push(response);
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        let split: number;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!/^event: call$/m.test(block) || !data) continue;
          const call = JSON.parse(data) as Call;
          calls.push(call);
          void booted.app.inject({ method: 'POST', url: `/api/devices/me/calls/${call.callId}/result`, headers: bearer(issued.token), payload: { ok: true, result: answer(call) as object } });
        }
      });
      response.on('error', () => undefined);
      const deadline = Date.now() + 3000;
      while (!booted.devices.online(issued.device.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    }
    return { id: issued.device.id, calls };
  };
  const project = booted.store.createProject(dir, 'screen');
  const mcp = (deviceId: string) => {
    const session = booted.store.createSession({ projectId: project.id, kind: 'native', toolGroups: ['riffet.core', `device:${deviceId}`] });
    const spec = booted.riffetMcp.server(session.id)!;
    const token = (JSON.parse(readFileSync(spec.args[spec.args.indexOf('--credential') + 1]!, 'utf8')) as { credential: string }).credential;
    const rpc = (method: string, params?: unknown) => booted.app.inject({ method: 'POST', url: '/api/riffet-mcp', headers: bearer(token), payload: { method, params } }).then(response => response.json().result);
    return { session, rpc };
  };
  const close = async () => { for (const stream of streams) stream.destroy(); await booted.app.close(); await rm(dir, { recursive: true, force: true }); };
  return { ...booted, host, device, mcp, close };
}

describe('screen tools (T1)', () => {
  // The device's gate is the boundary; the agent must not be able to smuggle a grant or an override past it.
  it('forwards only allowlisted fields and refuses to authorize a payment', async () => {
    const booted = await boot();
    try {
      const phone = await booted.device(ANDROID, call => call.args.authorize ? { grantId: 'g1', app: 'com.tencent.mm', action: 'send', expiresAt: '2026-11-05T00:00:00Z' } : { untrusted: true, snapshotId: 's2', steps: [{ action: 'tap', ok: true, effect: 'done' }] });
      const { rpc } = booted.mcp(phone.id);
      const acted = await rpc('tools/call', { name: 'device_act', arguments: {
        steps: [{ action: 'tap', ref: '@e8', authorizedBy: 'owner', force: true, category: null }, { action: 'type', text: 'hi', x: 5, y: 6, submit: true, grant: 'g0' }],
        observe: true, policy: 'allow', grant: 'g1', confirmed: true,
      } });
      expect(acted.isError).toBeUndefined();
      const authorized = await rpc('tools/call', { name: 'device_authorize', arguments: { app: 'com.tencent.mm', action: 'send', summary: 'Send', content: '晚上七点见', validMinutes: 60, confirmed: true, owner: true } });
      expect(authorized.isError).toBeUndefined();
      expect(phone.calls.map(call => call.args)).toEqual([
        { steps: [{ action: 'tap', ref: '@e8' }, { action: 'type', text: 'hi', submit: true }], observe: true },
        { authorize: { app: 'com.tencent.mm', action: 'send', summary: 'Send', content: '晚上七点见', validMinutes: 60 } },
      ]);
      const pay = await rpc('tools/call', { name: 'device_authorize', arguments: { app: 'com.tencent.mm', action: 'pay', summary: 'Pay 10', validMinutes: 5 } });
      expect(pay.isError).toBe(true);
      expect(pay.content[0].text).toMatch(/^INVALID_ARGUMENT: payments/);
      expect(Object.keys(booted.store.getSetting('riffet-mcp:device-calls', {}))).toHaveLength(2);
    } finally { await booted.close(); }
  });

  it('records a stopped batch as a failed device action and marks the MCP result as an error', async () => {
    const booted = await boot();
    try {
      const phone = await booted.device(ANDROID, () => ({
        untrusted: true, package: 'com.tencent.mm', snapshotId: 's3', stoppedAt: 1,
        steps: [{ action: 'tap', ok: true, effect: 'place_changed', target: '张三' }, { action: 'tap', ok: false, code: 'DEVICE_HANDOFF_REQUIRED', message: 'Payments are done by the owner', target: '转账', category: 'pay' }],
      }));
      const { session, rpc } = booted.mcp(phone.id);
      const result = await rpc('tools/call', { name: 'device_act', arguments: { steps: [{ action: 'tap', ref: '@e3' }, { action: 'tap', ref: '@e9' }, { action: 'back' }] } });
      expect(result.isError).toBe(true);
      expect(result.content[0].text.split('\n')[0]).toBe('DEVICE_HANDOFF_REQUIRED: Payments are done by the owner');
      expect(result.content[0].text).toContain('"untrusted":true');
      const login = await booted.app.inject({ method: 'POST', url: '/api/auth/login', headers: { host: booted.host }, payload: { token: MASTER } });
      const cookie = { host: booted.host, cookie: String(login.headers['set-cookie']).split(';')[0]! };
      const listed = await booted.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/device-actions`, headers: cookie });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual([expect.objectContaining({
        sessionId: session.id, deviceId: phone.id, kind: 'act', package: 'com.tencent.mm', ok: false, code: 'DEVICE_HANDOFF_REQUIRED', category: 'pay',
        steps: [{ action: 'tap', target: '张三', effect: 'place_changed' }, { action: 'tap', target: '转账', code: 'DEVICE_HANDOFF_REQUIRED' }],
      })]);
    } finally { await booted.close(); }
  });

  it('lists the screen tools for an Android phone only', async () => {
    const booted = await boot();
    try {
      const names = async (report: object) => ((await booted.mcp((await booted.device(report)).id).rpc('tools/list')).tools as Array<{ name: string }>).map(tool => tool.name);
      expect(await names({ ...ANDROID, capabilities: [], allowControl: false })).toEqual(expect.arrayContaining(['device_observe', 'device_act', 'device_authorize', 'device_launch_app', 'device_list_apps', 'device_help']));
      const ios = await names({ platform: 'ios', appVersion: '1.0', capabilities: ['notify'], allowControl: true });
      expect(ios).toContain('device_notify');
      expect(ios.filter(name => ['device_observe', 'device_act', 'device_authorize', 'device_help'].includes(name))).toEqual([]);
    } finally { await booted.close(); }
  });
});
