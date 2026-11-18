import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from '@riffet/plugin-api';
import { createApp } from '../app.js';
import { builtinPluginsChanging } from '../plugins/registry.js';
import { assertUnchanged, checkSession, runIngestContract, snapshot } from '../journal/ingest-contract.js';
import { laneKey } from '../journal/journal.js';

/** Terminals need a tmux that can start a session; skipped where it cannot (see terminal/history.test.ts). */
const tmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    const directory = mkdtempSync(join(tmpdir(), 'riffet-tmux-probe-'));
    const socket = join(directory, 'probe.sock');
    try { execFileSync('tmux', ['-S', socket, 'new-session', '-d', '-s', 'probe', '/bin/true'], { stdio: 'ignore' }); return true; }
    finally { try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ } rmSync(directory, { recursive: true, force: true }); }
  } catch { return false; }
})();

/** A cursor-agent that answers the probes the server makes and then shows the prompt and footer the terminal host waits for. It notes its argv in its working directory. */
const SCRIPT = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs'), { randomUUID } = require('node:crypto');
const args = process.argv.slice(2);
if (args[0] === 'create-chat') { console.log(randomUUID()); process.exit(0); }
if (args.includes('--version')) { console.log('2026.10.01-abcdef0'); process.exit(0); }
if (args.includes('--help')) { console.log('--plugin-dir <dir>'); process.exit(0); }
if (args[0] === 'status') { console.log('{"authenticated":true}'); process.exit(0); }
if (args.includes('--list-models')) { console.log('auto - Auto'); process.exit(0); }
appendFileSync('argv.log', JSON.stringify(args) + '\\n');
process.stdout.write('\\n  → Plan, search, build anything\\n\\n  Auto · 0% context\\n  ' + process.cwd() + ' · main\\n');
process.stdin.resume(); setInterval(() => {}, 1000);
`;

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** `directory` reuses a state of an earlier boot (a second server); `chats` points the plugin at a config directory of its own, where the chat stores are written. */
async function boot(cli?: string, options: { directory?: string; chats?: boolean; plugins?: Plugin[] } = {}) {
  const directory = options.directory ?? realpathSync(mkdtempSync(join(tmpdir(), 'riffet-cursor-plugin-')));
  const projectDir = join(directory, 'project');
  if (!existsSync(projectDir)) await mkdir(projectDir);
  const executable = cli ?? join(directory, 'cursor-agent');
  if (!cli && !existsSync(executable)) writeFileSync(executable, SCRIPT, { mode: 0o700 });
  const stateDir = join(directory, 'state');
  const configDir = join(directory, 'cursor-home');
  if (options.chats) { await mkdir(stateDir, { recursive: true }); writeFileSync(join(stateDir, 'cursor-cli.json'), JSON.stringify({ configDir }), { mode: 0o600 }); }
  const services = await createApp({ stateDir, auth: false, cliPath: executable, ...(options.plugins ? { plugins: options.plugins } : {}) });
  cleanups.push(async () => {
    // The panes outlive the server by design; a test must not leave its CLI and tmux server behind.
    try { for (const item of services.store.listTerminals()) if (item.state !== 'exited') await services.terminal.stop(item.id).catch(() => undefined); }
    catch { /* a test that closed the server itself */ }
    await services.app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const origin = { host: '127.0.0.1:4337', origin: 'http://127.0.0.1:4337' };
  const auth = await services.app.inject({ url: '/api/auth/status', headers: origin });
  const headers = { ...origin, cookie: String(auth.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': auth.json().csrfToken as string };
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: Record<string, unknown>) => services.app.inject({ url, method, headers, ...(payload ? { payload } : {}) });
  const project = services.store.listProjects().find(item => item.cwd === projectDir) ?? services.store.createProject(projectDir, 'cursor plugin');
  return { ...services, call, directory, projectDir, configDir, executable, project };
}

describe('Cursor as the official plugin', () => {
  it('reports the launch values it resolved and the cause of an unreadable catalog, as the core did', async () => {
    const { call, executable } = await boot('/nonexistent/cursor-agent');
    expect((await call('GET', '/api/backends/cursor/profiles')).json().profiles[0]).toMatchObject({ id: 'default', executable, disableAutoUpdate: false });
    const models = await call('GET', '/api/cursor/models');
    expect([models.statusCode, models.json().error]).toEqual([503, { code: 'MODEL_CATALOG_UNAVAILABLE', message: 'The CLI model catalog could not be read; check the CLI and try again shortly' }]);
  });

  it('is withdrawn with the reason when its integration is off', async () => {
    const { call, plugins, store, project } = await boot('/nonexistent/cursor-agent');
    await plugins.update('riffet.cursor', { enablement: 'off' });
    const refused = await call('GET', '/api/cursor/capabilities');
    expect([refused.statusCode, refused.json().error.code, refused.json().error.details]).toEqual([503, 'NATIVE_BACKEND_UNAVAILABLE', { backendId: 'cursor', reason: 'plugin riffet.cursor is off' }]);

    // A backend that is off, or keeps no warm CLI, answers a prewarm before the workspace is looked at, as it always did.
    const busy = store.createSession({ projectId: project.id, kind: 'native', backendId: 'claude', mode: 'agent' });
    store.updateSession(busy.id, { state: 'running' });
    for (const backendId of ['cursor', 'droid']) {
      const skipped = await call('POST', '/api/native/prewarm', { projectId: project.id, backendId, model: 'auto', mode: 'agent' });
      expect([backendId, skipped.statusCode, skipped.json()]).toEqual([backendId, 200, { state: 'skipped', reason: 'backend_unsupported' }]);
    }

    // Project configs: the list is empty, and everything else says why there is nothing to read or change.
    expect((await call('GET', `/api/projects/${project.id}/configs`)).json()).toEqual([]);
    const reason = { backendId: 'cursor', reason: 'plugin riffet.cursor is off' };
    for (const [method, url, payload] of [
      ['GET', `/api/projects/${project.id}/configs/any`],
      ['POST', `/api/projects/${project.id}/configs`, { kind: 'rules', path: '.cursor/rules/a.mdc', content: 'x' }],
    ] as const) {
      const answer = await call(method, url, payload);
      expect([method, answer.statusCode, answer.json().error.code, answer.json().error.details]).toEqual([method, 503, 'NATIVE_BACKEND_UNAVAILABLE', reason]);
    }
  });

  it('keeps a run queued before a restart waiting while the plugin is still starting, and does not fail it for the backend\'s absence', async () => {
    const first = await boot('/nonexistent/cursor-agent');
    const session = first.store.createSession({ projectId: first.project.id, kind: 'native', backendId: 'cursor', mode: 'agent', model: 'auto' });
    const run = first.store.acceptNativeRun(session.id, 'queued-before-restart', { text: '/clear', attachmentIds: [], context: [] }, { model: 'auto', mode: 'agent' });
    await first.app.close();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow = builtinPluginsChanging('riffet.cursor', item => ({ ...item, activate: async (host, scope) => { await gate; return item.activate(host, scope); } }));
    const second = await boot('/nonexistent/cursor-agent', { directory: first.directory, plugins: slow });
    // The server is up (its start gave up waiting for the plugin) and the dispatcher has been looking at the run since.
    expect(second.nativeBackends.backendPending('cursor')).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1_200));
    expect(second.store.getRun(run.id)).toMatchObject({ state: 'queued', native: { delivery: 'queued' } });
    release();
    await vi.waitFor(() => expect(second.store.getRun(run.id).native?.delivery).not.toBe('queued'), { timeout: 10_000, interval: 100 });
    expect(second.store.getRun(run.id).error ?? '').not.toContain('not available');
  }, 30_000);

  it.skipIf(!tmux)('starts a conversation on a prewarmed CLI whose hook plugin lives in the state directory', async () => {
    const { call, store, stateDir, projectDir, project } = await boot();
    const config = { projectId: project.id, model: 'auto', mode: 'agent' };
    await vi.waitFor(async () => expect((await call('POST', '/api/native/prewarm', config)).json().state).toBe('ready'), { timeout: 15_000, interval: 250 });
    const created = await call('POST', '/api/sessions', { ...config, kind: 'native', clientSessionId: '11111111-1111-4111-8111-111111111111' });
    expect((await call('POST', `/api/sessions/${created.json().id}/start`)).statusCode).toBe(200);
    const session = store.getSession(created.json().id);
    expect(session).toMatchObject({ backendId: 'cursor', state: 'running', terminalId: expect.any(String), nativeSessionId: expect.any(String) });
    // The warm process was claimed, not launched again, and was resumed on the chat the session now follows.
    expect((await call('GET', '/api/native/runtime/stats')).json()).toMatchObject({ warmHits: 1, warmMisses: 0 });
    const launches = readFileSync(join(projectDir, 'argv.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toEqual(expect.arrayContaining(['--resume', session.nativeSessionId, '--plugin-dir', join(stateDir, 'cursor-hook', 'plugin')]));
    expect(existsSync(join(stateDir, 'cursor-hook', 'bridge.json'))).toBe(true);
  }, 60_000);

  it.skipIf(!tmux)('hands a new conversation\'s first message to the prewarmed CLI instead of launching one with it', async () => {
    const { call, store, projectDir, project } = await boot();
    const config = { projectId: project.id, model: 'auto', mode: 'agent' };
    await vi.waitFor(async () => expect((await call('POST', '/api/native/prewarm', config)).json().state).toBe('ready'), { timeout: 15_000, interval: 250 });
    const created = await call('POST', '/api/sessions', { ...config, kind: 'native', clientSessionId: '33333333-3333-4333-8333-333333333333', initialMessage: { commandId: 'first', text: 'hello warm', attachmentIds: [], context: [] } });
    expect(created.statusCode).toBe(202);
    const sessionId = '33333333-3333-4333-8333-333333333333';
    await vi.waitFor(() => expect(store.findRunByCommand(sessionId, 'first')?.native?.delivery).not.toMatch(/^(queued|preparing)$/), { timeout: 15_000, interval: 100 });
    expect((await call('GET', '/api/native/runtime/stats')).json()).toMatchObject({ warmHits: 1 });
    // One CLI, the warm one, and the prompt was not on its command line.
    const launches = readFileSync(join(projectDir, 'argv.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(launches).toHaveLength(1);
    expect(launches[0]).not.toContain('hello warm');
    // Fenced before the paste, on the warm CLI's chat.
    const chatId = store.getSession(sessionId).nativeSessionId;
    expect(launches[0]).toEqual(expect.arrayContaining(['--resume', chatId]));
    expect(store.findRunByCommand(sessionId, 'first')?.native).toMatchObject({ renderedText: 'hello warm', nativeSessionId: chatId });
  }, 60_000);

  it.skipIf(!tmux)('stops a released warm CLI, and keeps one a conversation has claimed', async () => {
    const { call, store, terminal, project } = await boot();
    const config = { projectId: project.id, model: 'auto', mode: 'agent' };
    const warmTerminal = () => store.listTerminals().find(item => item.state !== 'exited' && !item.sessionId);
    let first = '';
    await vi.waitFor(async () => { const result = (await call('POST', '/api/native/prewarm', config)).json(); first = result.claimId; expect(result.state).toBe('ready'); }, { timeout: 15_000, interval: 250 });
    const released = warmTerminal()!.id;
    // Another page's renewal, for other settings, does not take the one slot over.
    expect((await call('POST', '/api/native/prewarm', { ...config, mode: 'plan', claimId: 'another-page' })).json()).toMatchObject({ state: 'skipped', reason: 'held_elsewhere' });
    expect((await terminal.get(released)).state).toBe('running');
    expect((await call('POST', '/api/native/prewarm/release', { claimId: first })).statusCode).toBe(204);
    expect((await terminal.get(released)).state).toBe('exited');

    let second = '';
    await vi.waitFor(async () => { const result = (await call('POST', '/api/native/prewarm', config)).json(); second = result.claimId; expect(result.state).toBe('ready'); }, { timeout: 15_000, interval: 250 });
    const created = await call('POST', '/api/sessions', { ...config, kind: 'native', clientSessionId: '44444444-4444-4444-8444-444444444444' });
    expect((await call('POST', `/api/sessions/${created.json().id}/start`)).statusCode).toBe(200);
    const claimed = store.getSession(created.json().id).terminalId!;
    // The page that asked for it closes after the send: the conversation's CLI is not its to stop.
    expect((await call('POST', '/api/native/prewarm/release', { claimId: second })).statusCode).toBe(204);
    expect((await terminal.get(claimed)).state).toBe('running');
  }, 60_000);

  it.skipIf(!tmux)('turned off while a conversation runs, refuses new work with the reason and leaves the conversation and its terminal alone', async () => {
    const { call, store, terminal, project } = await boot();
    const created = await call('POST', '/api/sessions', { projectId: project.id, model: 'auto', mode: 'agent', kind: 'native', clientSessionId: '22222222-2222-4222-8222-222222222222' });
    expect((await call('POST', `/api/sessions/${created.json().id}/start`)).statusCode).toBe(200);
    const id = created.json().id as string;
    const live = store.getSession(id).terminalId!;
    expect(store.listTerminals().find(item => item.id === live)).toMatchObject({ kind: 'cursor', state: 'running' });
    const stop = vi.spyOn(terminal, 'stop');

    expect((await call('PATCH', '/api/integrations/riffet.cursor', { enablement: 'off' })).statusCode).toBe(200);
    const reason = { backendId: 'cursor', reason: 'plugin riffet.cursor is off' };
    for (const [method, url, payload] of [
      ['POST', '/api/sessions', { projectId: project.id, kind: 'native', backendId: 'cursor' }],
      ['GET', '/api/cursor/capabilities'], ['GET', '/api/cursor/models'], ['POST', '/api/cursor/command', { operation: 'status' }],
    ] as const) {
      const refused = await call(method, url, payload);
      expect([url, refused.statusCode, refused.json().error.code, refused.json().error.details]).toEqual([url, 503, 'NATIVE_BACKEND_UNAVAILABLE', reason]);
    }
    // A send is refused with the reason before it is queued; the conversation still lists and reads.
    const refusedSend = await call('POST', `/api/sessions/${id}/native/send`, { commandId: 'c1', text: 'hello' });
    expect([refusedSend.statusCode, refusedSend.json().error.code, refusedSend.json().error.details]).toEqual([503, 'NATIVE_BACKEND_UNAVAILABLE', reason]);
    expect(store.findRunByCommand(id, 'c1')).toBeUndefined();
    expect((await call('GET', '/api/sessions')).json()).toContainEqual(expect.objectContaining({ id, backendId: 'cursor' }));
    expect((await call('GET', `/api/v3/sessions/${id}/timeline?lane=main&before=999999999`)).statusCode).toBe(200);
    // The CLI is the terminal service's: it was neither stopped nor marked exited.
    expect(stop).not.toHaveBeenCalled();
    expect(store.listTerminals().find(item => item.id === live)).toMatchObject({ state: 'running' });
    expect((await terminal.get(live)).state).toBe('running');

    expect((await call('PATCH', '/api/integrations/riffet.cursor', { enablement: 'auto' })).statusCode).toBe(200);
    expect((await call('GET', '/api/cursor/capabilities')).statusCode).toBe(200);
    expect(((await call('GET', '/api/backends')).json() as Array<{ backendId: string }>).map(item => item.backendId)).toContain('cursor');
    expect(store.listTerminals().find(item => item.id === live)).toMatchObject({ state: 'running' });
  }, 60_000);
});

/*
 * Chat stores as the CLI writes them (content-addressed message blobs, a protobuf root listing their ids, a
 * subagent's own store naming its parent), read through the real journal.
 */
const varint = (value: number): number[] => { const bytes: number[] = []; while (value > 0x7f) { bytes.push((value & 0x7f) | 0x80); value = Math.floor(value / 128); } bytes.push(value); return bytes; };
const field = (number: number, payload: Uint8Array) => Buffer.from([...varint(number * 8 + 2), ...varint(payload.length), ...payload]);
type Message = Record<string, unknown>;

function writeChat(dir: string, chatId: string, messages: Message[], meta: Record<string, unknown> = {}): void {
  mkdirSync(join(dir, chatId), { recursive: true });
  const db = new DatabaseSync(join(dir, chatId, 'store.db'));
  db.exec('CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);');
  const put = (data: Buffer) => { const id = createHash('sha256').update(data).digest('hex'); db.prepare('INSERT OR IGNORE INTO blobs VALUES (?, ?)').run(id, data); return id; };
  const root = Buffer.concat(messages.map(message => field(1, Buffer.from(put(Buffer.from(JSON.stringify(message))), 'hex'))));
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify({ agentId: chatId, latestRootBlobId: put(root), name: 'Probe', ...meta })).toString('hex'));
  db.close();
}

const ask = (text: string, requestId?: string): Message => ({ role: 'user', content: [{ type: 'text', text: `<timestamp>Thursday, Oct 1, 2026, 12:14 AM (UTC+8)</timestamp>\n<user_query>\n${text}\n</user_query>` }], ...(requestId ? { providerOptions: { cursor: { requestId } } } : {}) });
const say = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] });
const shell = (id: string): Message[] => [
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'Shell', args: { command: 'ls' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'Shell', result: 'Exit code: 0' }] },
];
const turn = (name: string, requestId?: string): Message[] => [ask(`work on ${name}`, requestId), ...shell(`${name}-shell`), say(`${name} done`)];
const SYSTEM: Message[] = [{ role: 'system', content: 'You are an agent.' }, { role: 'user', content: '<user_info>\nOS Version: darwin\n</user_info>' }];
/** Past the 512 messages a first import reads in one step, so it is served from a tail window first. */
const longChat = (): Message[] => [...SYSTEM, ...Array.from({ length: 150 }, (_, index) => turn(`t${index}`, `req-${index}`)).flat()];
const agentId = '00000000-0000-4000-8000-000000000001';
const chatsOf = (configDir: string, cwd: string) => join(configDir, 'chats', createHash('md5').update(cwd).digest('hex'));

describe('Cursor chat stores through the core journal', () => {
  it('holds the ingest contract for the plugin source of a long store', async () => {
    const { store, nativeBackends, project, configDir, projectDir } = await boot('/nonexistent/cursor-agent', { chats: true });
    const dir = chatsOf(configDir, projectDir);
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor', nativeSessionId: 'chat-1' });
    const chat = longChat();
    writeChat(dir, 'chat-1', chat);
    let appended = 0;
    const report = await runIngestContract({
      scratch: true,
      source: () => nativeBackends.transcriptSource(session.id)!,
      append: () => { appended += 1; chat.push(...turn(`more${appended}`, `req-more-${appended}`)); writeChat(dir, 'chat-1', chat); },
      // `/rewind` to the last prompt and send it edited: the same places now hold other messages.
      update: () => { chat.splice(chat.findLastIndex(message => message.role === 'user'), Infinity, ask('edited', 'req-edited'), say('edited answer')); writeChat(dir, 'chat-1', chat); },
      // Typed into the CLI itself: no workbench run started it, so no request id.
      terminalTurn: () => { chat.push(...turn('typed')); writeChat(dir, 'chat-1', chat); },
      subagent: () => {
        writeChat(dir, agentId, [...SYSTEM, ask('look around', 'req-sub'), say('found it')], { subagentInfo: { parentAgentId: 'chat-1', toolCallId: 'sub-task' } });
        chat.push(ask('delegate', 'req-delegate'),
          { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'sub-task', toolName: 'Task', args: { description: 'Look around', subagent_type: 'explore', prompt: 'list files' } }] },
          { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'sub-task', toolName: 'Task', result: 'This is the output of the subagent:\n\nfound' }], providerOptions: { cursor: { highLevelToolCallResult: { output: { success: { agentId, durationMs: '1200' } }, isError: false } } } },
          say('delegated'));
        writeChat(dir, 'chat-1', chat);
      },
    }, { sessionId: session.id });
    // A scratch window for the tail, then the lane under its own generation; the subagent has the lane its call names.
    expect(report.served.map(item => item.scratch)).toEqual([true, false]);
    expect(Object.keys(report.lanes).sort()).toEqual(['main', 'sub:sub-task']);
  }, 60_000);

  it('replays nothing when a second server starts over the same state, and starts a lane over only for another chat', async () => {
    const first = await boot('/nonexistent/cursor-agent', { chats: true });
    const dir = chatsOf(first.configDir, first.projectDir);
    const session = first.store.createSession({ projectId: first.project.id, kind: 'native', backendId: 'cursor', nativeSessionId: 'chat-1' });
    const other = first.store.createSession({ projectId: first.project.id, kind: 'native', backendId: 'cursor', nativeSessionId: 'chat-other' });
    writeChat(dir, 'chat-1', longChat());
    const release = first.ingest.follow(session.id);
    await first.ingest.read(session.id);
    release();
    const before = snapshot(first.store.journal, session.id);
    expect(before.size).toBeGreaterThan(0);
    await first.app.close();
    const second = await boot('/nonexistent/cursor-agent', { directory: first.directory, chats: true });
    second.ingest.follow(session.id);
    await second.ingest.read(session.id);
    assertUnchanged(before, snapshot(second.store.journal, session.id), 'a second server');
    checkSession(second.store.journal, session.id);

    // The plugin follows the CLI onto another chat: the lane starts over under a new generation, and the store keeps both id fields as one.
    const main = laneKey(session.id, 'main');
    const generation = second.store.journal.peek(main)!.generation;
    writeChat(dir, 'chat-2', [...SYSTEM, ask('a new chat', 'req-n1'), say('Hello.')]);
    second.nativeBackends.host.setNativeSessionId(session.id, 'chat-2');
    expect(second.store.getSession(session.id)).toMatchObject({ nativeSessionId: 'chat-2', cursorSessionId: 'chat-2' });
    second.ingest.follow(session.id);
    await second.ingest.read(session.id);
    expect(second.store.journal.peek(main)!.generation).not.toBe(generation);
    checkSession(second.store.journal, session.id);
    // A chat another conversation holds cannot be taken.
    expect(() => second.nativeBackends.host.setNativeSessionId(other.id, 'chat-2')).toThrow(expect.objectContaining({ code: 'NATIVE_SESSION_ID_IN_USE' }));
    expect(second.store.getSession(other.id)).toMatchObject({ nativeSessionId: 'chat-other', cursorSessionId: 'chat-other' });
  }, 60_000);
});
