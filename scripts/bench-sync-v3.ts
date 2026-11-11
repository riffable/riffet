/**
 * Benchmark for the sync v3 stream (docs/SYNC-V3.md, U11): time to `hello` and to the final snapshot
 * part for a session of 6,844 entries in one long open turn (the case U2 measured the fold on), over a
 * real HTTP connection with gzip. Reported for
 *
 * - a cold open: the lane was never folded, so `hello` waits for the fold of the open turn;
 * - a warm open: the lane is folded and held;
 * - a resume of a client that holds the lane (`delta`);
 * - an open after a restart: the rows are stored, only the open turn is folded again.
 *
 * The journal is written straight into a temporary state directory; no CLI runs and nothing outside it is read.
 * Run: node --import tsx scripts/bench-sync-v3.ts [--entries N] [--runs N]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { createGunzip } from 'node:zlib';
import type { NativeWorkbenchEvent } from '../packages/contracts/src/index.js';
import { createApp } from '../apps/server/src/app.js';
import { JournalLaneWriter, type TranscriptSource } from '../apps/server/src/journal/ingest.js';
import { Journal } from '../apps/server/src/journal/journal.js';

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const ENTRIES = Number(option('--entries') ?? 6844);
const RUNS = Number(option('--runs') ?? 5);
const host = '127.0.0.1:4317';
const ms = (value: number) => `${value.toFixed(1)}ms`;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

const dir = mkdtempSync(join(tmpdir(), 'riffet-bench-sync-'));
const stateDir = join(dir, 'state');

/** An app over the bench's state, reading no transcript and reporting an idle provider. */
async function boot() {
  const services = await createApp({ stateDir, auth: false, cliPath: '/nonexistent/cursor-agent' });
  // The journal already holds the whole conversation: a read finds nothing new.
  const source: TranscriptSource = { identity: () => undefined, pull: async () => ({ caughtUp: true }), drain: async () => undefined };
  services.nativeBackends.transcriptSource = () => source;
  services.nativeBackends.watchControl = () => ({ status: () => ({ phase: 'idle' }), context: () => undefined, close: () => undefined });
  const status = await services.app.inject({ method: 'GET', url: '/api/auth/status', headers: { host } });
  const cookie = String(status.headers['set-cookie']).split(';')[0]!;
  await services.app.listen({ host: '127.0.0.1', port: 0 });
  return { ...services, cookie, port: (services.app.server.address() as { port: number }).port };
}

/** Opens the stream and times `hello` and the end of what it was sent first. */
function open(app: Awaited<ReturnType<typeof boot>>, sessionId: string, query = ''): Promise<{ hello: number; done: number; frames: number; rows: number; rawKB: number; wireKB: number; generation: string; headSeq: number; mode: string }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let hello: { at: number; generation: string; headSeq: number; mode: string } | undefined;
    let frames = 0, rows = 0, raw = 0, wire = 0, buffer = '';
    const request = httpRequest({ host: '127.0.0.1', port: app.port, path: `/api/v3/sessions/${sessionId}/sync${query}`, headers: { host, cookie: app.cookie, 'accept-encoding': 'gzip' } }, response => {
      response.on('data', (chunk: Buffer) => { wire += chunk.length; });
      const body = response.pipe(createGunzip());
      body.setEncoding('utf8');
      body.on('data', (chunk: string) => {
        buffer += chunk;
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const data = block.split('\n').find(line => line.startsWith('data: '));
          if (!data) continue;
          frames += 1;
          raw += data.length;
          const frame = JSON.parse(data.slice(6));
          if (frame.type === 'snapshot' || frame.type === 'rows') rows += (frame.rows ?? frame.upserts).length;
          if (frame.type === 'hello') {
            hello = { at: performance.now() - started, generation: frame.generation, headSeq: frame.headSeq, mode: frame.mode };
            if (frame.mode === 'delta' && frame.headSeq === Number(new URLSearchParams(query.slice(1)).get('after'))) finish();
          }
          if (frame.type === 'snapshot' && frame.final) finish();
        }
      });
    });
    const finish = () => { request.destroy(); resolve({ hello: hello!.at, done: performance.now() - started, frames, rows, rawKB: raw / 1024, wireKB: wire / 1024, generation: hello!.generation, headSeq: hello!.headSeq, mode: hello!.mode }); };
    request.on('error', error => { if (!hello) reject(error); });
    request.end();
  });
}

const report = (label: string, samples: Array<Awaited<ReturnType<typeof open>>>) => {
  const last = samples.at(-1)!;
  console.log(`${label}: hello ${ms(median(samples.map(sample => sample.hello)))}, first frames done ${ms(median(samples.map(sample => sample.done)))} (median of ${samples.length}); mode ${last.mode}, ${last.frames} frames, ${last.rows} rows, ${last.rawKB.toFixed(0)}KB JSON, ${last.wireKB.toFixed(0)}KB gzip`);
};

try {
  // The conversation, written into the journal while no server runs.
  const first = await boot();
  const sessionId = first.store.createSession({ projectId: first.store.createProject(dir, 'bench').id, kind: 'native' }).id;
  await first.app.close();
  const db = new DatabaseSync(join(stateDir, 'workbench.db'));
  const journal = new Journal(db);
  const writer = JournalLaneWriter.open(journal, sessionId);
  let tick = 0, cursor = 0;
  const at = () => new Date(Date.UTC(2026, 9, 1) + ++tick * 1000).toISOString();
  const event = (nativeId: string, type: string, data: Record<string, unknown>): NativeWorkbenchEvent => ({ sequence: 0, sessionId, type, data, createdAt: at(), nativeId, nativeTurnId: 'turn-open' });
  const text = (value: string) => ({ content: { type: 'text', text: value } });
  const prose = (index: number) => `Step ${index}: ${'reading the code and deciding what to change next. '.repeat(4)}`;
  writer.turnStarted('turn-open', at());
  writer.commit({ events: [event('user', 'user_message_chunk', text('The long task'))], cursor: String(++cursor) });
  for (let offset = 1; offset < ENTRIES; offset += 500) {
    const events: NativeWorkbenchEvent[] = [];
    for (let index = offset; index < Math.min(ENTRIES, offset + 500); index += 1) {
      const kind = index % 4;
      if (kind === 0) events.push(event(`th${index}`, 'agent_thought_chunk', text(prose(index))));
      else if (kind === 1) events.push(event(`as${index}`, 'agent_message_chunk', text(prose(index))));
      else events.push(event(`tool${index}`, 'tool_call', { toolCallId: `call-${index}`, title: `Read file ${index}`, kind: 'read', status: 'completed', rawInput: { path: `src/file-${index}.ts` }, content: [{ type: 'content', content: { type: 'text', text: prose(index).repeat(3) } }] }));
    }
    writer.commit({ events, cursor: String(++cursor) });
  }
  db.close();
  console.log(`session: one open turn of ${ENTRIES} entries`);

  let app = await boot();
  const cold = await open(app, sessionId);
  report('cold open (lane never folded)', [cold]);
  const warm = [];
  for (let run = 0; run < RUNS; run += 1) warm.push(await open(app, sessionId));
  report('warm open', warm);
  const { generation, headSeq } = cold;
  const resumed = [];
  for (let run = 0; run < RUNS; run += 1) resumed.push(await open(app, sessionId, `?generation=${generation}&after=${headSeq}`));
  report('resume, client current', resumed);
  await app.app.close();

  app = await boot();
  const restarted = await open(app, sessionId, `?generation=${generation}&after=${headSeq}`);
  report('resume after a restart', [restarted]);
  const reopened = await open(app, sessionId);
  report('open after a restart (open turn folded again)', [reopened]);
  await app.app.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
