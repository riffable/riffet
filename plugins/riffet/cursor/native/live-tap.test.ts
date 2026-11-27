import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { CURSOR_LIVE_TAP, CursorLive } from './live.js';

// The Cursor agent stream as the CLI's live tap reads it: a fake CLI (`index.js`, with the launcher's
// CURSOR_INVOKED_AS) talks Connect to a local server, over HTTP/2 and over the HTTP/1.1 split.

function varint(value: number): number[] {
  const bytes: number[] = [];
  while (value > 0x7f) { bytes.push((value & 0x7f) | 0x80); value = Math.floor(value / 128); }
  bytes.push(value);
  return bytes;
}
const field = (number: number, payload: Uint8Array) => Buffer.from([...varint(number * 8 + 2), ...varint(payload.length), ...payload]);
const flag = (number: number) => Buffer.from([...varint(number * 8), 1]);
const count = (number: number, value: number) => Buffer.from([...varint(number * 8), ...varint(value)]);
const str = (number: number, value: string) => field(number, Buffer.from(value, 'utf8'));
const envelope = (payload: Buffer, compressed = false) => {
  const body = compressed ? gzipSync(payload) : payload;
  const head = Buffer.alloc(5);
  head[0] = compressed ? 1 : 0;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
};
const END = Buffer.concat([Buffer.from([2, 0, 0, 0, 2]), Buffer.from('{}')]);

const update = (number: number, payload: Buffer) => field(1, field(number, payload));
const textDelta = (text: string) => update(1, str(1, text));
const thinkingDelta = (text: string) => update(4, str(1, text));
const notice = (text: string) => update(1, Buffer.concat([str(1, text), flag(2)]));
const CHECKPOINT = field(3, Buffer.from([0x0a, 0]));
const TURN_ENDED = update(14, Buffer.alloc(0));
const runRequest = (conversation: string, run: string, prompt: string) =>
  field(1, Buffer.concat([field(2, field(1, field(1, str(1, prompt)))), str(5, conversation), field(9, str(1, 'example-model')), str(25, run)]));

const CLI = String.raw`
const http = require('node:http'), http2 = require('node:http2'), zlib = require('node:zlib');
const [mode, port, conversation] = process.argv.slice(2);
const envelope = (payload, compressed) => { const body = compressed ? zlib.gzipSync(payload) : payload; const head = Buffer.alloc(5); head[0] = compressed ? 1 : 0; head.writeUInt32BE(body.length, 1); return Buffer.concat([head, body]); };
const request = Buffer.from(process.env.RUN_REQUEST, 'base64');
// Stays up until the test closes stdin, so the sealed step can be read before the CLI exits.
const done = () => { process.stdout.write(JSON.stringify({ nodeOptions: process.env.NODE_OPTIONS ?? null, live: process.env.RIFFET_CURSOR_LIVE ?? null, usage: process.env.RIFFET_CURSOR_USAGE ?? null })); process.stdin.on('end', () => process.exit(0)).resume(); };
if (mode === 'h2') {
  const session = http2.connect('http://127.0.0.1:' + port);
  const requests = process.env.RUN_REQUESTS ? JSON.parse(process.env.RUN_REQUESTS) : [{ id: 'req-2', request: request.toString('base64') }];
  Promise.all(requests.map(item => new Promise(resolve => {
    const stream = session.request({ ':method': 'POST', ':path': '/agent.v1.AgentService/Run', 'x-request-id': item.id, 'connect-content-encoding': 'gzip' });
    stream.write(envelope(Buffer.from(item.request, 'base64'), true));
    stream.on('data', () => {});
    stream.on('end', resolve);
  }))).then(() => { session.close(); done(); });
} else {
  const headers = { 'x-request-id': 'req-1', 'x-original-request-id': 'turn-1' };
  const sse = http.request({ port, method: 'POST', path: '/agent.v1.AgentService/RunSSE', headers }, response => { response.on('data', () => {}); response.on('end', done); });
  sse.end(envelope(Buffer.from('id'), false));
  const appendRequest = () => {
  const hex = Buffer.from(request).toString('hex');
  const append = http.request({ port, method: 'POST', path: '/aiserver.v1.BidiService/BidiAppend', headers: { ...headers, 'content-encoding': 'gzip' } }, response => response.resume());
  const len = n => n < 128 ? [n] : [(n & 0x7f) | 0x80, n >> 7];
  const field = (number, bytes) => Buffer.concat([Buffer.from([number * 8 + 2, ...len(bytes.length)]), bytes]);
  append.write(zlib.gzipSync(Buffer.concat([field(1, Buffer.from(hex)), field(2, field(1, Buffer.from('req-1')))])));
  append.end();
  };
  if (process.env.APPEND_DELAY_MS) setTimeout(appendRequest, Number(process.env.APPEND_DELAY_MS));
  else appendRequest();
}
`;

const cleanup: Array<() => void> = [];
afterEach(() => { for (const step of cleanup.splice(0)) step(); });

/** A server that streams `before`, waits for `resume`, then streams `after`. */
function scripted(mode: 'h1' | 'h2', before: Buffer[], after: Buffer[]) {
  let resume!: () => void;
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  const stream = async (write: (chunk: Buffer) => void, end: () => void) => {
    for (const chunk of before) write(chunk);
    await resumed;
    for (const chunk of after) write(chunk);
    end();
  };
  const server = mode === 'h2'
    ? http2.createServer().on('stream', s => {
      s.on('data', () => {});
      s.respond({ ':status': 200, 'content-type': 'application/connect+proto', 'connect-content-encoding': 'gzip' });
      void stream(chunk => s.write(chunk), () => s.end());
    })
    : http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        if (request.url!.endsWith('BidiAppend')) { response.end(); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'connect-content-encoding': 'gzip' });
        void stream(chunk => response.write(chunk), () => response.end());
      });
    });
  cleanup.push(() => server.close());
  return { server, resume };
}

async function until<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('Cursor live tap', () => {
  for (const mode of ['h1', 'h2'] as const) {
    it(`follows a step over ${mode === 'h1' ? 'RunSSE + BidiAppend' : 'HTTP/2 Run'}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'cursor-live-'));
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      const dir = join(root, 'live'), cli = join(root, 'cli'), liveReader = new CursorLive(dir);
      cleanup.push(() => liveReader.close());
      mkdirSync(dir); mkdirSync(cli);
      writeFileSync(join(cli, 'index.js'), CLI);
      const conversation = mode === 'h1' ? 'chat-h1' : 'chat-h2';
      const rawUsage = mode === 'h1'
        ? { inputTokens: 450, outputTokens: 70, cacheReadTokens: 100, cacheWriteTokens: 25, reasoningTokens: 0 }
        : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      const terminal = envelope(update(14, Buffer.concat(Object.values(rawUsage).map((value, index) => count(index + 1, value)))), true);
      // Protobuf field order has no meaning: a replay in another order is the same terminal.
      const reorderedTerminal = envelope(update(14, Buffer.concat(Object.values(rawUsage).map((value, index) => count(index + 1, value)).reverse())), true);
      const { server, resume } = scripted(mode,
        [envelope(thinkingDelta('Let me ')), envelope(thinkingDelta('think.'), true), envelope(notice('Model switched')), envelope(textDelta('Hello '), true), envelope(textDelta('wor'))],
        [envelope(textDelta('ld'), true), envelope(CHECKPOINT, true), terminal.subarray(0, 3), terminal.subarray(3), terminal, reorderedTerminal, END]);
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      const child = spawn(process.execPath, [join(cli, 'index.js'), mode, String(port), conversation], {
        env: {
          ...process.env, CURSOR_INVOKED_AS: 'agent', RIFFET_CURSOR_LIVE: dir,
          RIFFET_CURSOR_USAGE: liveReader.usageDir,
          NODE_OPTIONS: `--max-old-space-size=2048 --require "${CURSOR_LIVE_TAP}"`,
          RUN_REQUEST: runRequest(conversation, 'run-2', 'say hello').toString('base64'),
        },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      cleanup.push(() => child.kill());
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
      const file = join(dir, `${conversation}.json`);
      const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined);

      const live = await until(() => { const value = read(); return value?.parts?.at(-1)?.text === 'Hello wor' ? value : undefined; });
      expect(CURSOR_LIVE_TAP).toBeDefined();
      expect(live).toMatchObject({
        v: 1, pid: child.pid, turn: mode === 'h1' ? 'turn-1' : 'run-2', run: 'run-2', prompt: 'say hello', requestedModel: 'example-model', sealed: false,
        parts: [{ type: 'reasoning', text: 'Let me think.' }, { type: 'text', text: 'Hello wor' }],
      });
      resume();
      const sealed = await until(() => { const value = read(); return value?.sealed ? value : undefined; });
      expect(sealed).toMatchObject({ step: live.step, parts: [{ type: 'reasoning', text: 'Let me think.' }, { type: 'text', text: 'Hello world' }] });
      // The server's turn_ended is the run's end; the stream closing after it does not break it.
      const ended = await until(() => { const value = read(); return value?.ended ? value : undefined; });
      expect(ended).toMatchObject({ turnEnds: true, ended: expect.any(Number) });
      expect(ended.broken).toBeUndefined();
      expect(liveReader.read(conversation)).toMatchObject({ turnEnds: true, ended: ended.ended });
      const observations = await until(() => { const values = liveReader.readUsage(); return values.length ? values : undefined; });
      expect(observations).toHaveLength(1);
      expect(observations[0]!.observation).toEqual({
        v: 1, nativeSessionId: conversation, nativeTurnId: 'run-2', requestId: mode === 'h1' ? 'req-1' : 'req-2',
        startedAt: expect.any(Number), endedAt: expect.any(Number), requestedModel: 'example-model', rawUsage,
      });
      expect(observations[0]!.observation.endedAt).toBeGreaterThanOrEqual(observations[0]!.observation.startedAt);
      expect(readFileSync(observations[0]!.file, 'utf8')).not.toMatch(/say hello|Hello|Let me|prompt|parts/);

      child.stdin.end();
      expect(await exited).toBe(0);
      // The CLI's own children see neither the module nor its directory; other options stay.
      expect(JSON.parse(output)).toEqual({ nodeOptions: '--max-old-space-size=2048', live: null, usage: null });
      expect(existsSync(file)).toBe(false);
      expect(liveReader.readUsage()).toEqual(observations);
    });
  }

  it('marks a run whose stream closes without turn_ended as broken, not ended', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-live-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const dir = join(root, 'live'), cli = join(root, 'cli'), liveReader = new CursorLive(dir);
    cleanup.push(() => liveReader.close());
    mkdirSync(dir); mkdirSync(cli);
    writeFileSync(join(cli, 'index.js'), CLI);
    const conversation = 'chat-broken';
    const { server, resume } = scripted('h2', [envelope(textDelta('Working'))], [END]);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const child = spawn(process.execPath, [join(cli, 'index.js'), 'h2', String(port), conversation], {
      env: { ...process.env, CURSOR_INVOKED_AS: 'agent', RIFFET_CURSOR_LIVE: dir, RIFFET_CURSOR_USAGE: liveReader.usageDir,
        NODE_OPTIONS: `--require "${CURSOR_LIVE_TAP}"`, RUN_REQUEST: runRequest(conversation, 'run-9', 'go').toString('base64') },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    cleanup.push(() => child.kill());
    const file = join(dir, `${conversation}.json`);
    const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined);
    const open = await until(() => { const value = read(); return value?.parts?.length ? value : undefined; });
    expect(open).toMatchObject({ turnEnds: true, turn: 'run-9' });
    expect(open.ended ?? open.broken).toBeUndefined();
    resume();
    const broken = await until(() => { const value = read(); return value?.broken ? value : undefined; });
    expect(broken.ended).toBeUndefined();
    child.stdin.end();
  });

  it('captures concurrent streams independently of live text ownership, including a child conversation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-usage-streams-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const live = new CursorLive(join(root, 'live')), cli = join(root, 'cli');
    cleanup.push(() => live.close());
    mkdirSync(live.dir); mkdirSync(cli);
    writeFileSync(join(cli, 'index.js'), CLI);
    const { server, resume } = scripted('h2', [], [envelope(TURN_ENDED), END]);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const child = spawn(process.execPath, [join(cli, 'index.js'), 'h2', String((server.address() as AddressInfo).port)], {
      env: {
        ...process.env, CURSOR_INVOKED_AS: 'agent', ...live.launchEnv(), RUN_REQUEST: '',
        RUN_REQUESTS: JSON.stringify([
          { id: 'root-first', request: runRequest('root-chat', 'root-run-1', 'private first prompt').toString('base64') },
          { id: 'root-second', request: runRequest('root-chat', 'root-run-2', 'private second prompt').toString('base64') },
          { id: 'child', request: runRequest('child-chat', 'child-run', 'private child prompt').toString('base64') },
        ]),
      }, stdio: ['pipe', 'pipe', 'inherit'],
    });
    cleanup.push(() => child.kill());
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    resume();
    const observations = await until(() => { const values = live.readUsage(); return values.length === 3 ? values : undefined; });
    expect(observations.map(value => value.observation.requestId).sort()).toEqual(['child', 'root-first', 'root-second']);
    expect(observations.every(value => Object.keys(value.observation.rawUsage).length === 0)).toBe(true);
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(live.readUsage()).toHaveLength(3);
  });

  it('recovers a terminal received before its HTTP/1 request identity, even after the response closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-usage-late-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const live = new CursorLive(join(root, 'live')), cli = join(root, 'cli');
    cleanup.push(() => live.close());
    mkdirSync(live.dir); mkdirSync(cli);
    writeFileSync(join(cli, 'index.js'), CLI);
    // Signed negative int64s arrive as a ten-byte varint; neither that nor unsafe positive counts
    // become a rounded usage value. Other valid optional fields still survive.
    const negative = Buffer.from([2 * 8, 255, 255, 255, 255, 255, 255, 255, 255, 255, 1]);
    const terminal = update(14, Buffer.concat([count(1, Number.MAX_SAFE_INTEGER + 1), negative, count(5, 4)]));
    const { server, resume } = scripted('h1', [], [envelope(terminal), END]);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const child = spawn(process.execPath, [join(cli, 'index.js'), 'h1', String((server.address() as AddressInfo).port)], {
      env: {
        ...process.env, CURSOR_INVOKED_AS: 'agent', ...live.launchEnv(), APPEND_DELAY_MS: '150',
        RUN_REQUEST: runRequest('late-chat', 'late-run', 'private late prompt').toString('base64'),
      }, stdio: ['pipe', 'pipe', 'inherit'],
    });
    cleanup.push(() => child.kill());
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    resume();
    const observations = await until(() => { const values = live.readUsage(); return values.length ? values : undefined; });
    expect(observations[0]!.observation).toMatchObject({ nativeSessionId: 'late-chat', nativeTurnId: 'late-run', requestId: 'req-1' });
    expect(observations[0]!.observation.rawUsage).toEqual({ reasoningTokens: 4 });
    expect(existsSync(join(live.dir, 'late-chat.json'))).toBe(false);
    child.stdin.end();
    expect(await exited).toBe(0);
  });
});
