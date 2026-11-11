/**
 * Manual real-CLI probe of the device channel (docs/DEVICES.md §3), driven through an in-process
 * server on a temp state dir. A fake phone pairs over HTTP, reports itself, opens its stream and
 * answers calls; a real Claude Code conversation uses it through the Riffet MCP shim. It never
 * touches the running Riffet service; the Claude profile is copied read-only into the temp dir.
 *
 *   node --import tsx scripts/probe-device-channel-e2e.ts --profile <name> [--model <id>] [--only a,b] [--keep]
 *
 * a. Created as `android` with `riffet.core` and `device:<phone>`: the agent reads the phone's
 *    clipboard and notifies on it; the phone answers both and the agent reports the clipboard text.
 * b. The same with a paired phone that is not connected: the agent sees DEVICE_UNREACHABLE.
 */
import type { DeviceCall, Run, Session } from '../packages/contracts/src/index.js';
import { createApp } from '../apps/server/src/app.js';
import { createPairingCode } from '../apps/server/src/pairing.js';
import { copyRiffetProfile, log, probeDirs, requireCli } from './probe-sync-e2e-lib.js';

for (const name of Object.keys(process.env)) {
  if (/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|RIFFET_CLAUDE_HOOK_.*|AI_AGENT|CODEX_.*)$/.test(name)) delete process.env[name];
}
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback;
const profileName = option('--profile', '');
if (!profileName) throw new Error('Pass --profile <name>: a Claude profile of your own Riffet to copy');
const modelOverride = option('--model', '');
const only = new Set(option('--only', 'a,b').split(',').map(item => item.trim()));
const keep = args.includes('--keep');
requireCli('claude', 'Claude Code', 'Install Claude Code');

const CLIPBOARD = 'PROBE-CLIP-7351 hello from the phone';
const dirs = await probeDirs('device-channel');
const services = await createApp({ stateDir: dirs.stateDir, auth: false, cliPath: 'cursor-agent' });
await services.app.listen({ host: '127.0.0.1', port: 0 });
const port = (services.app.server.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}`;
const origin = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
const status = await services.app.inject({ url: '/api/auth/status', headers: origin });
const base = { ...origin, cookie: String(status.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': String(status.json().csrfToken) };
async function call<T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const response = await services.app.inject({ method, url, headers: { ...base, ...extra }, ...(payload === undefined ? {} : { payload: payload as object }) });
  if (response.statusCode >= 400) throw new Error(`${method} ${url}: ${response.statusCode} ${response.body}`);
  return (response.body ? response.json() : undefined) as T;
}
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const checks: Array<{ scenario: string; name: string; ok: boolean; evidence: string }> = [];
const check = (scenario: string, name: string, ok: boolean, evidence: unknown) => {
  const text = typeof evidence === 'string' ? evidence : JSON.stringify(evidence);
  checks.push({ scenario, name, ok, evidence: text.slice(0, 600) });
  log(`${ok ? 'PASS' : 'FAIL'} [${scenario}] ${name} — ${text.slice(0, 300)}`);
};
const runs = (sessionId: string): Run[] => services.store.listRuns(sessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const settled = (run: Run) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.state);
async function until<T>(what: string, seconds: number, probe: () => T | undefined | false): Promise<T | undefined> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) { const value = probe(); if (value) return value; await sleep(1000); }
  log(`timed out waiting for ${what}`);
  return undefined;
}
async function transcript(sessionId: string): Promise<string[]> {
  try {
    const page = await call<{ rows?: Array<{ block?: Record<string, unknown> } & Record<string, unknown>> }>('GET', `/api/v3/sessions/${sessionId}/timeline?lane=main&rows=200&from=0`);
    return (page.rows ?? []).flatMap(row => {
      const block = (row.block ?? row) as Record<string, unknown>;
      if (block.kind === 'assistant') return [`assistant: ${String(block.text).slice(0, 300)}`];
      if (block.kind === 'tool') return [`tool: ${JSON.stringify(block.activity ?? block.job ?? block).slice(0, 300)}`];
      if (block.kind === 'user') return [`user: ${String(block.text).slice(0, 120)}`];
      return [];
    });
  } catch (error) { return [`timeline unavailable: ${error instanceof Error ? error.message : String(error)}`]; }
}

/** The phone: pairs with a code, reports itself and, when `connect` is called, serves calls over real HTTP. */
async function fakePhone(name: string) {
  const paired = await (await fetch(`${baseUrl}/api/devices/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: createPairingCode().code, name }) })).json() as { device: { id: string }; token: string };
  const headers = { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' };
  const report = await fetch(`${baseUrl}/api/devices/me`, { method: 'PUT', headers, body: JSON.stringify({ platform: 'android', appVersion: 'probe-1', capabilities: ['notify', 'clipboard.read', 'clipboard.write'], allowControl: true }) });
  if (!report.ok) throw new Error(`report failed: ${report.status} ${await report.text()}`);
  const calls: DeviceCall[] = [];
  const events: string[] = [];
  const abort = new AbortController();
  const answer = async (item: DeviceCall) => {
    const result = item.capability === 'clipboard.read' ? { text: CLIPBOARD } : {};
    const response = await fetch(`${baseUrl}/api/devices/me/calls/${item.callId}/result`, { method: 'POST', headers, body: JSON.stringify({ ok: true, result }) });
    events.push(`answered ${item.capability} -> ${response.status}`);
  };
  return {
    id: paired.device.id, calls, events,
    async connect() {
      const response = await fetch(`${baseUrl}/api/devices/me/stream`, { headers, signal: abort.signal });
      if (!response.ok || !response.body) throw new Error(`stream failed: ${response.status}`);
      void (async () => {
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            buffer += decoder.decode(chunk, { stream: true });
            let split: number;
            while ((split = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, split); buffer = buffer.slice(split + 2);
              const event = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
              if (!event || !data) continue;
              if (event !== 'ping') events.push(`${event} ${data.slice(0, 160)}`);
              if (event === 'call') {
                const item = JSON.parse(data) as DeviceCall;
                if (calls.some(known => known.callId === item.callId)) continue;
                calls.push(item);
                // A person takes a moment; the agent's call waits for it.
                setTimeout(() => { void answer(item); }, 800);
              }
            }
          }
        } catch { /* closed */ }
      })();
    },
    close() { abort.abort(); },
  };
}

const project = await call<{ id: string }>('POST', '/api/projects', { cwd: dirs.project });
const claude = await copyRiffetProfile((url, body) => call('POST', url, body), 'claude', profileName);
const model = modelOverride || claude.model;
async function create(id: string, text: string, toolGroups: string[]): Promise<Session> {
  const created = await call<{ session: Session }>('POST', '/api/sessions', {
    kind: 'native', projectId: project.id, clientSessionId: id, backendId: 'claude', backendProfileId: claude.backendProfileId, model, approval: 'bypassPermissions', toolGroups,
    initialMessage: { commandId: `${id}-1`, text },
  });
  return created.session;
}
const phone = await fakePhone('Probe Phone');
await phone.connect();
const offline = await fakePhone('Offline Phone');
const devices = await call<{ devices: Array<{ id: string; online: boolean; capabilities: string[]; allowControl: boolean }> }>('GET', '/api/devices');
check('setup', 'GET /api/devices shows presence and the reports', devices.devices.find(item => item.id === phone.id)?.online === true && devices.devices.find(item => item.id === offline.id)?.online === false
  && devices.devices.every(item => item.allowControl && item.capabilities.includes('clipboard.read')), devices.devices);

try {
  if (only.has('a')) {
    const prompt = [
      'You have Riffet MCP tools (server "riffet"). Do exactly these steps, without running any shell command:',
      '1. Call device_clipboard_read to read the clipboard of the phone.',
      '2. Call device_notify with body "PROBE-DEVICE-NOTIFY".',
      '3. Reply with exactly: CLIPBOARD=<the clipboard text you read>',
    ].join('\n');
    const session = await create('probe-device-a', prompt, ['riffet.core', `device:${phone.id}`]);
    check('a', 'session snapshot from android', JSON.stringify(services.store.getSession(session.id).toolGroups) === JSON.stringify(['riffet.core', `device:${phone.id}`]), { toolGroups: services.store.getSession(session.id).toolGroups });
    const first = await until('first turn', 300, () => runs(session.id).find(run => settled(run)));
    check('a', 'turn completed', first?.state === 'completed', { state: first?.state, error: first?.error });
    check('a', 'the phone received clipboard.read and notify', ['clipboard.read', 'notify'].every(capability => phone.calls.some(item => item.capability === capability && item.sessionId === session.id)), phone.calls);
    check('a', 'the notify call carried the body', phone.calls.some(item => item.capability === 'notify' && item.args.body === 'PROBE-DEVICE-NOTIFY'), phone.calls.map(item => item.args));
    const lines = await transcript(session.id);
    check('a', 'the agent reported the clipboard text', lines.some(line => line.startsWith('assistant:') && line.includes('PROBE-CLIP-7351')), lines.filter(line => line.startsWith('assistant:')));
    log(`a transcript:\n  ${lines.join('\n  ')}`);
  }
  if (only.has('b')) {
    const prompt = [
      'You have Riffet MCP tools (server "riffet"). Do exactly these steps, without running any shell command:',
      '1. Call device_clipboard_read with timeoutSeconds 5.',
      '2. If it failed, reply with exactly: ERROR=<the error code at the start of the error text>. Otherwise reply with exactly OK.',
    ].join('\n');
    const session = await create('probe-device-b', prompt, ['riffet.core', `device:${offline.id}`]);
    const first = await until('offline turn', 300, () => runs(session.id).find(run => settled(run)));
    check('b', 'turn completed', first?.state === 'completed', { state: first?.state, error: first?.error });
    const lines = await transcript(session.id);
    check('b', 'the agent saw DEVICE_UNREACHABLE', lines.some(line => line.startsWith('assistant:') && line.includes('DEVICE_UNREACHABLE')), lines.filter(line => line.startsWith('assistant:')));
    const stored = Object.values(services.store.getSetting<Record<string, { deviceId: string; status: string; error?: { code: string } }>>('riffet-mcp:device-calls', {})).filter(item => item.deviceId === offline.id);
    check('b', 'the offline call expired unanswered', stored.length === 1 && stored[0]!.status === 'expired' && stored[0]!.error?.code === 'DEVICE_UNREACHABLE', stored);
    log(`b transcript:\n  ${lines.join('\n  ')}`);
  }
} finally {
  log(`phone events:\n  ${phone.events.join('\n  ')}`);
  phone.close();
  const failed = checks.filter(item => !item.ok);
  console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
  for (const session of services.store.listSessions()) await call('PATCH', `/api/sessions/${session.id}`, { archived: true }).catch(() => undefined);
  await services.app.close().catch(() => undefined);
  if (!keep) await dirs.remove().catch(() => undefined);
  else log(`kept ${dirs.root}`);
  process.exit(failed.length ? 1 : 0);
}
