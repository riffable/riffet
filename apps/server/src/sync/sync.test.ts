import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeInteraction, NativeStatus, NativeWorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import type { SyncLane, TimelineRow } from '../../../../packages/contracts/src/sync.js';
import { createApp } from '../app.js';
import type { LaneBatch, LaneWriter, TranscriptSource } from '../journal/ingest.js';
import { StatsLedger } from '../stats/ledger.js';
import type { TimelineSnapshot } from '../timeline/service.js';
import type { ControlMessage } from './service.js';

/*
 * The sync v3 protocol over HTTP (docs/SYNC-V3.md, 消息; 续传与缺口): a real app and its routes, a fake
 * transcript in place of a CLI and a fake control path in place of a provider.
 */

type Line =
  | { kind: 'user' | 'assistant'; id: string; turn: string; text: string }
  | { kind: 'agent'; id: string; turn: string; agent: string }
  | { kind: 'end'; turn: string };

const stamp = (index: number) => new Date(Date.UTC(2026, 9, 1) + index * 1000).toISOString();

/** What the CLI has written. `type` is a turn typed into the terminal: nothing is told. */
class NativeTranscript {
  identity = 'conv-1';
  lines: Line[] = [];
  readonly agents = new Map<string, Line[]>();
  failNext: Error | undefined;
  inFlight = 0;
  maxInFlight = 0;
  private readonly watchers = new Set<() => void>();
  type(...lines: Line[]): void { this.lines.push(...lines); }
  push(...lines: Line[]): void { this.lines.push(...lines); this.wake(); }
  wake(): void { for (const wake of this.watchers) wake(); }
  watch(wake: () => void): () => void { this.watchers.add(wake); return () => { this.watchers.delete(wake); }; }
}

const turn = (id: string, answer = `answer ${id}`): Line[] => [
  { kind: 'user', id: `u-${id}`, turn: id, text: `question ${id}` },
  { kind: 'assistant', id: `a-${id}`, turn: id, text: answer },
  { kind: 'end', turn: id },
];

/** Reads the transcript by line from the lane's cursor, as the JSONL readers do. */
class FakeSource implements TranscriptSource {
  constructor(private readonly native: NativeTranscript) {}
  identity(): string { return this.native.identity; }
  async pull(w: LaneWriter): Promise<{ caughtUp: boolean }> {
    const native = this.native;
    native.inFlight += 1;
    native.maxInFlight = Math.max(native.maxInFlight, native.inFlight);
    try {
      await new Promise(resolve => setTimeout(resolve, 5));
      const failure = native.failNext;
      native.failNext = undefined;
      if (failure) throw failure;
      this.read(w, native.lines, Number(w.cursor ?? 0));
      return { caughtUp: true };
    } finally { native.inFlight -= 1; }
  }
  watch(_w: LaneWriter, wake: () => void): () => void { return this.native.watch(wake); }
  async drain(w: LaneWriter): Promise<void> { this.read(w, this.native.lines, Number(w.cursor ?? 0)); }

  private read(w: LaneWriter, lines: readonly Line[], from: number): void {
    let batch: LaneBatch = { events: [], cursor: String(from) };
    const flush = (at: number) => {
      if (batch.events.length || String(at) !== w.cursor) w.commit({ ...batch, cursor: String(at) });
      batch = { events: [], cursor: String(at) };
    };
    for (let index = from; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.kind === 'end') { flush(index); w.turnEnded(line.turn, 'completed', stamp(index)); continue; }
      if (line.kind === 'user') { flush(index); w.turnStarted(line.turn, stamp(index)); }
      const base = { sequence: 0, sessionId: 'unused', nativeId: line.id, nativeTurnId: line.turn, createdAt: stamp(index) };
      const event: NativeWorkbenchEvent = line.kind === 'agent'
        ? { ...base, type: 'tool_call', data: { toolCallId: line.id, title: 'Task', kind: 'other', status: 'completed' } }
        : { ...base, type: line.kind === 'user' ? 'user_message_chunk' : 'agent_message_chunk', data: { content: { type: 'text', text: line.text } } };
      batch.events.push(event);
      if (line.kind === 'agent') {
        flush(index + 1);
        const child = w.child(line.id, line.agent);
        const agentLines = this.native.agents.get(line.agent) ?? [];
        this.read(child, agentLines, Number(child.cursor ?? 0));
      }
    }
    flush(lines.length);
  }
}

/** The provider's status as a test sets it. */
class FakeControl {
  status: NativeStatus = { phase: 'idle' };
  private readonly listeners = new Set<(message: ControlMessage) => void>();
  watch(listener: (message: ControlMessage) => void) {
    this.listeners.add(listener);
    return { status: () => this.status, context: () => undefined, close: () => { this.listeners.delete(listener); } };
  }
  set(status: NativeStatus): void { this.status = status; for (const listener of this.listeners) listener({ type: 'status', status }); }
  get watching(): number { return this.listeners.size; }
}

interface Frame { event: string; id?: string; data: any }

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'riffet-sync-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const host = '127.0.0.1:4317';

/** An app over `dir`, its transcript and status faked, listening on a free port. */
async function boot(dir: string, native: NativeTranscript, control = new FakeControl()) {
  const services = await createApp({ stateDir: dir, auth: false, cliPath: '/nonexistent/cursor-agent' });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await services.app.close(); } };
  cleanups.push(close);
  vi.spyOn(services.nativeBackends, 'transcriptSource').mockImplementation(() => new FakeSource(native));
  vi.spyOn(services.nativeBackends, 'watchControl').mockImplementation((_id, listener) => control.watch(listener));
  const status = await services.app.inject({ method: 'GET', url: '/api/auth/status', headers: { host } });
  const cookie = String(status.headers['set-cookie']).split(';')[0]!;
  await services.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (services.app.server.address() as { port: number }).port;
  const streams: ClientRequest[] = [];
  /** Opens the sync stream and collects its frames. */
  const open = (sessionId: string, query = '', headers: Record<string, string> = {}) => {
    const frames: Frame[] = [];
    let ended = false;
    let statusCode = 0;
    // A bearer credential stands in for the cookie.
    const credential = headers.authorization ? {} : { cookie };
    const request = httpRequest({ host: '127.0.0.1', port, path: `/api/v3/sessions/${sessionId}/sync${query}`, headers: { host, ...credential, 'accept-encoding': 'gzip', ...headers } }, response => {
      statusCode = response.statusCode ?? 0;
      const body = response.headers['content-encoding'] === 'gzip' ? response.pipe(createGunzip()) : response;
      body.setEncoding('utf8');
      let buffer = '';
      body.on('data', (chunk: string) => {
        buffer += chunk;
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const fields = new Map(block.split('\n').filter(line => !line.startsWith(':')).map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
          if (fields.has('data')) frames.push({ event: fields.get('event') ?? 'message', ...(fields.has('id') ? { id: fields.get('id') } : {}), data: JSON.parse(fields.get('data')!) });
        }
      });
      body.on('end', () => { ended = true; });
      body.on('error', () => { ended = true; });
      response.on('close', () => { ended = true; });
    });
    request.on('error', () => { ended = true; });
    request.end();
    streams.push(request);
    return { frames, close: () => request.destroy(), get ended() { return ended; }, get statusCode() { return statusCode; } };
  };
  cleanups.push(() => { for (const stream of streams) stream.destroy(); });
  return { ...services, cookie, port, control, open, close };
}

function newSession(app: Awaited<ReturnType<typeof boot>>, dir: string): string {
  return app.store.createSession({ projectId: app.store.createProject(dir, 'sync').id, kind: 'native' }).id;
}

const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 5_000, interval: 10 });
const of = (frames: Frame[], event: string) => frames.filter(frame => frame.event === event);
const finalPart = (frames: Frame[]) => frames.find(frame => frame.event === 'snapshot' && frame.data.final);
const holds = (rows: Map<string, TimelineRow>, text: string) => [...rows.values()].some(row => 'text' in row && row.text === text);

/** Each rows frame starts where the one before ended, the first right after `held`. */
function expectContiguous(frames: Frame[], held: number): number {
  for (const frame of of(frames, 'rows')) {
    expect(frame.data.from).toBe(held + 1);
    expect(frame.id).toBe(`${frame.data.generation}:${frame.data.to}`);
    held = frame.data.to;
  }
  return held;
}

/** What a client holds after the frames, starting from `rows`. */
function apply(frames: Frame[], rows = new Map<string, TimelineRow>()): Map<string, TimelineRow> {
  for (const { event, data } of frames) {
    if (event === 'reset' || (event === 'snapshot' && data.part === 0)) rows.clear();
    if (event === 'snapshot') for (const row of data.rows) rows.set(row.key, row);
    if (event === 'rows') {
      for (const row of data.upserts) rows.set(row.key, row);
      for (const key of data.deletes ?? []) rows.delete(key);
    }
  }
  return rows;
}

/** The lane as the server holds it, compared by key and seq. */
function expectSameRows(app: Awaited<ReturnType<typeof boot>>, sessionId: string, held: Map<string, TimelineRow>, lane: SyncLane = 'main'): void {
  const truth = app.timeline.page(sessionId, lane, { from: 0, rows: 500, bytes: 1024 * 1024 }).rows;
  expect(truth.length).toBeGreaterThan(0);
  expect([...held.values()].sort((left, right) => left.pos - right.pos).map(row => [row.key, row.seq])).toEqual(truth.map(row => [row.key, row.seq]));
}

describe('sync v3 stream', () => {
  it('opens with hello and a snapshot, then sends every change as rows contiguous in seq', async () => {
    const dir = await stateDir();
    const native = new NativeTranscript();
    // Typed into the CLI before anyone opened the conversation: only the read on open finds them.
    native.type(...turn('t1'), ...turn('t2'));
    const app = await boot(dir, native);
    const sessionId = newSession(app, dir);
    const stream = app.open(sessionId);
    await waitFor(() => expect(finalPart(stream.frames)).toBeDefined());
    await waitFor(() => expect(holds(apply(stream.frames), 'answer t2')).toBe(true));
    const [hello] = stream.frames;
    expect(hello!.event).toBe('hello');
    expect(hello!.data).toMatchObject({ protocol: 3, lane: 'main', mode: 'snapshot', session: { id: sessionId }, status: { phase: 'idle' }, interaction: null, runs: [], activities: [] });
    const snapshot = finalPart(stream.frames)!;
    expect(snapshot.data).toMatchObject({ generation: hello!.data.generation, asOfSeq: hello!.data.headSeq, hasBefore: false });
    expect(snapshot.id).toBe(`${hello!.data.generation}:${hello!.data.headSeq}`);
    expect(of(stream.frames, 'snapshot').slice(0, -1).every(frame => frame.id === undefined)).toBe(true);
    // The read on open is announced, then its end, by when the lane up to `headSeq` holds what it found.
    expect(hello!.data.catchingUp).toBe(true);
    await waitFor(() => expect(of(stream.frames, 'caughtUp')).toHaveLength(1));
    const caughtUp = of(stream.frames, 'caughtUp')[0]!.data;
    expect(caughtUp.generation).toBe(hello!.data.generation);
    expect(holds(new Map([...apply(stream.frames)].filter(([, row]) => row.seq <= caughtUp.headSeq)), 'answer t2')).toBe(true);

    native.push(...turn('t3'));
    native.push(...turn('t4'));
    await waitFor(() => expect(holds(apply(stream.frames), 'answer t4')).toBe(true));
    const held = expectContiguous(stream.frames, hello!.data.headSeq);
    expect(held).toBe(app.timeline.head(sessionId, 'main')!.headSeq);
    expectSameRows(app, sessionId, apply(stream.frames));
    expect(of(stream.frames, 'outline').length).toBeGreaterThan(0);
    // One read of a session at a time, however many wakes came.
    expect(native.maxInFlight).toBe(1);
    // Live rows after it are not announced again.
    expect(of(stream.frames, 'caughtUp')).toHaveLength(1);

    // A question the provider waits on travels as its own frame, and goes when the status no longer holds it.
    const question: NativeInteraction = { id: 'ia-1', revision: 'r1', kind: 'question', title: 'Keep the cache?', options: [{ id: 'option:0', label: 'Yes', selected: false }], actions: [] };
    app.control.set({ phase: 'attention', interaction: question });
    await waitFor(() => expect(of(stream.frames, 'interaction').at(-1)?.data.interaction).toEqual(question));
    app.control.set({ phase: 'busy' });
    // The status carries where the queue stands under it: nothing starts while the CLI works.
    await waitFor(() => expect(of(stream.frames, 'status').at(-1)?.data.status).toEqual({ phase: 'busy', queue: { held: { reason: 'turn_running' } } }));
    expect(of(stream.frames, 'interaction').at(-1)?.data.interaction).toBeNull();
    // A negotiated reader keeps original text; older readers see the frozen source identity.
    const queued = app.store.acceptNativeRun(sessionId, 'referenced-input', { text: 'Use the source', attachmentIds: [], context: [] }, { mode: 'agent' });
    app.store.updateRun(queued.id, { native: { ...queued.native!, contextSnapshots: [{ sessionId: 'source', title: 'Source title', backendId: 'codex', projectName: 'Project', capturedAt: stamp(1), snapshotRef: 'a'.repeat(64), excerpt: 'Excerpt', coverage: { source: 'journal', completeness: 'partial', messages: 1, bytes: 7 } }] } });
    await waitFor(() => expect([...apply(stream.frames).values()].some(row => row.kind === 'user' && row.text.includes('@Source title'))).toBe(true));
    const modern = app.open(sessionId, '', { 'x-riffet-features': 'session-references-v1' });
    await waitFor(() => expect(finalPart(modern.frames)).toBeDefined());
    expect([...apply(modern.frames).values()].find(row => row.runId === queued.id)).toMatchObject({ text: 'Use the source', references: [{ title: 'Source title' }] });
    const legacyPage = await app.app.inject({ method: 'GET', url: `/api/v3/sessions/${sessionId}/timeline?before=${Number.MAX_SAFE_INTEGER}`, headers: { host, cookie: app.cookie } });
    expect(legacyPage.json().rows.find((row: TimelineRow) => row.runId === queued.id).text).toContain('@Source title');
    expect(app.store.getRun(queued.id).prompt).toBe('Use the source');
    modern.close();
    stream.close();
    await waitFor(() => expect(app.control.watching).toBe(0));
  });

  it('resumes under the same generation with only the rows it misses, from the query or Last-Event-ID', async () => {
    const dir = await stateDir();
    const native = new NativeTranscript();
    native.type(...turn('t1'));
    const app = await boot(dir, native);
    const sessionId = newSession(app, dir);
    const first = app.open(sessionId);
    await waitFor(() => expect(holds(apply(first.frames), 'answer t1')).toBe(true));
    await waitFor(() => expect(finalPart(first.frames)).toBeDefined());
    const generation = first.frames[0]!.data.generation as string;
    const held = expectContiguous(first.frames, first.frames[0]!.data.headSeq);
    const state = apply(first.frames);
    first.close();

    // The session stays followed for a while after its last stream: a turn now is read and folded.
    native.push(...turn('t2'));
    await waitFor(() => expect(app.timeline.head(sessionId, 'main')!.headSeq).toBeGreaterThan(held));
    const head = app.timeline.head(sessionId, 'main')!.headSeq;
    for (const resume of [app.open(sessionId, `?generation=${generation}&after=${held}`), app.open(sessionId, '?generation=stale&after=0', { 'last-event-id': `${generation}:${held}` })]) {
      await waitFor(() => expect(of(resume.frames, 'rows').at(-1)?.data.to).toBe(head));
      expect(resume.frames[0]!.data).toMatchObject({ mode: 'delta', generation, headSeq: head });
      expect(of(resume.frames, 'snapshot')).toEqual([]);
      expectContiguous(resume.frames, held);
      expectSameRows(app, sessionId, apply(resume.frames, new Map(state)));
      resume.close();
    }
    // A client that holds everything gets a hello and nothing else.
    const current = app.open(sessionId, `?generation=${generation}&after=${head}`);
    await waitFor(() => expect(current.frames[0]?.data).toMatchObject({ mode: 'delta', headSeq: head }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(current.frames.filter(frame => ['rows', 'snapshot', 'reset'].includes(frame.event))).toEqual([]);
  });

  it('resumes across a restart with only the delta, the lane seq unchanged', async () => {
    const dir = await stateDir();
    const native = new NativeTranscript();
    native.type(...turn('t1'), ...turn('t2'));
    const before = await boot(dir, native);
    const sessionId = newSession(before, dir);
    const first = before.open(sessionId);
    await waitFor(() => expect(holds(apply(first.frames), 'answer t2')).toBe(true));
    await waitFor(() => expect(finalPart(first.frames)).toBeDefined());
    const generation = first.frames[0]!.data.generation as string;
    const held = expectContiguous(first.frames, first.frames[0]!.data.headSeq);
    const state = apply(first.frames);
    first.close();
    await before.close();

    const after = await boot(dir, native);
    expect(after.timeline.head(sessionId, 'main')).toEqual({ generation, headSeq: held });
    // Written while the server was down, and found by the read on open.
    native.type(...turn('t3'));
    let releaseRead!: () => void;
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    cleanups.push(releaseRead);
    const read = FakeSource.prototype.pull;
    const pull = vi.spyOn(FakeSource.prototype, 'pull').mockImplementation(async function (this: FakeSource, writer: LaneWriter) {
      await readGate;
      return read.call(this, writer);
    });
    const resumed = after.open(sessionId, `?generation=${generation}&after=${held}`);
    await waitFor(() => expect(pull).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(resumed.frames[0]?.data).toMatchObject({ mode: 'delta', generation, headSeq: held }));
    expect(of(resumed.frames, 'rows')).toEqual([]);
    const retained = after.open(sessionId);
    await waitFor(() => expect(finalPart(retained.frames)).toBeDefined());
    expect(retained.frames[0]!.data).toMatchObject({ mode: 'snapshot', generation, headSeq: held });
    expect(holds(apply(retained.frames), 'answer t2')).toBe(true);
    expect(holds(apply(retained.frames), 'answer t3')).toBe(false);
    expect(pull).toHaveBeenCalledTimes(1);
    releaseRead();
    await waitFor(() => expect(holds(apply(resumed.frames, new Map(state)), 'answer t3')).toBe(true));
    await waitFor(() => expect(holds(apply(retained.frames), 'answer t3')).toBe(true));
    expect(resumed.frames[0]!.data).toMatchObject({ mode: 'delta', generation });
    expect(of(resumed.frames, 'snapshot')).toEqual([]);
    expect(of(resumed.frames, 'reset')).toEqual([]);
    expectContiguous(resumed.frames, held);
    expectContiguous(retained.frames, held);
    expectSameRows(after, sessionId, apply(resumed.frames, new Map(state)));
    expectSameRows(after, sessionId, apply(retained.frames));
  });

  it('sends a snapshot to a client of another generation, and reset then a snapshot when the lane starts over', async () => {
    const dir = await stateDir();
    const native = new NativeTranscript();
    native.type(...turn('t1'));
    const app = await boot(dir, native);
    const sessionId = newSession(app, dir);
    const stream = app.open(sessionId, '?generation=stale&after=3');
    await waitFor(() => expect(finalPart(stream.frames)).toBeDefined());
    await waitFor(() => expect(holds(apply(stream.frames), 'answer t1')).toBe(true));
    const generation = stream.frames[0]!.data.generation as string;
    expect(stream.frames[0]!.data.mode).toBe('snapshot');

    // The session now follows another native conversation: the lane is rebuilt under a new generation.
    native.identity = 'conv-2';
    native.lines = turn('n1');
    native.wake();
    await waitFor(() => expect(of(stream.frames, 'reset')).toHaveLength(1));
    await waitFor(() => expect(of(stream.frames, 'snapshot').filter(frame => frame.data.final && frame.data.generation !== generation).length).toBeGreaterThan(0));
    const reset = of(stream.frames, 'reset')[0]!;
    expect(reset.data).toMatchObject({ reason: 'rebuilt' });
    expect(reset.data.generation).not.toBe(generation);
    // The snapshot paired with `reset` must already carry the rebuilt transcript rather than flashing empty during async re-import.
    const resetAt = stream.frames.indexOf(reset);
    const rebuiltSnapshots = stream.frames.slice(resetAt + 1).filter(frame => frame.event === 'snapshot' && frame.data.generation === reset.data.generation);
    expect(holds(apply(rebuiltSnapshots), 'answer n1')).toBe(true);
    await waitFor(() => expect(holds(apply(stream.frames), 'answer n1')).toBe(true));
    const rows = apply(stream.frames);
    expect(holds(rows, 'answer t1')).toBe(false);
    const latest = [...stream.frames].reverse().find(frame => frame.event === 'snapshot' && frame.data.final)!;
    expectContiguous(stream.frames.slice(stream.frames.indexOf(latest)), latest.data.asOfSeq);
    expectSameRows(app, sessionId, rows);
  });

  it('closes a gap: a client that missed rows reconnects with after=held and gets exactly what follows it', async () => {
    const dir = await stateDir();
    const native = new NativeTranscript();
    native.type(...turn('t1'));
    const app = await boot(dir, native);
    const sessionId = newSession(app, dir);
    const stream = app.open(sessionId);
    await waitFor(() => expect(finalPart(stream.frames)).toBeDefined());
    await waitFor(() => expect(holds(apply(stream.frames), 'answer t1')).toBe(true));
    native.push(...turn('t2'));
    await waitFor(() => expect(holds(apply(stream.frames), 'answer t2')).toBe(true));
    native.push(...turn('t3'));
    await waitFor(() => expect(holds(apply(stream.frames), 'answer t3')).toBe(true));
    const generation = stream.frames[0]!.data.generation as string;
    const rowsFrames = of(stream.frames, 'rows');
    expect(rowsFrames.length).toBeGreaterThan(1);
    // The client applied the snapshot and the first rows frame, then saw `from` jump past what it held.
    const upTo = stream.frames.indexOf(rowsFrames[0]!);
    const held = rowsFrames[0]!.data.to as number;
    const kept = apply(stream.frames.slice(0, upTo + 1));
    const head = app.timeline.head(sessionId, 'main')!.headSeq;
    const again = app.open(sessionId, `?generation=${generation}&after=${held}`);
    await waitFor(() => expect(of(again.frames, 'rows').at(-1)?.data.to).toBe(head));
    expect(again.frames[0]!.data.mode).toBe('delta');
    expectContiguous(again.frames, held);
    expectSameRows(app, sessionId, apply(again.frames, kept));
  });

  it('sends a status change made while a 4 MB snapshot is written after at most one part', async () => {
    const dir = await stateDir();
    const app = await boot(dir, new NativeTranscript());
    const sessionId = newSession(app, dir);
    const PARTS = 16;
    const text = 'x'.repeat(250 * 1024);
    const row = (index: number) => ({ key: `assistant:${index}`, pos: index, turn: 't', seq: index + 1, rev: 1, kind: 'assistant', text, event: { type: 'agent_message_chunk', data: {}, createdAt: stamp(0), lastAt: stamp(0), sourceIds: [] } }) as TimelineRow;
    vi.spyOn(app.timeline, 'snapshot').mockImplementation((): TimelineSnapshot => ({
      generation: 'g', asOfSeq: PARTS, hasBefore: false,
      *parts() {
        for (let part = 0; part < PARTS; part += 1) {
          // The status changes as the first part goes out, from outside the writer.
          if (part === 0) setImmediate(() => app.control.set({ phase: 'busy' }));
          yield { part, final: part === PARTS - 1, rows: [row(part)] };
        }
      },
    }));
    const stream = app.open(sessionId);
    await waitFor(() => expect(finalPart(stream.frames)).toBeDefined());
    const order = stream.frames.filter(frame => frame.event === 'snapshot' || frame.event === 'status').map(frame => frame.event === 'status' ? 'status' : frame.data.part as number);
    expect(order).toHaveLength(PARTS + 1);
    expect(order.indexOf('status')).toBeGreaterThan(0);
    expect(order.indexOf('status')).toBeLessThanOrEqual(2);
    expect(stream.frames[0]!.event).toBe('hello');
  });

  it('follows a main hello with each measured turn, a turn typed in the CLI named by its receipt', async () => {
    const dir = await stateDir();
    const native = new NativeTranscript();
    native.type(...turn('t1'));
    const app = await boot(dir, native);
    const sessionId = newSession(app, dir);
    const ledger = new StatsLedger(app.store);
    ledger.recordUsage(sessionId, undefined, { stepId: 'cli-1', nativeMessageId: 'receipt-cli', outputTokens: 90, startedAt: 1_000, endedAt: 3_000, tokenSource: 'provider', window: 'transcript' });
    ledger.close();
    const stream = app.open(sessionId);
    await waitFor(() => expect(finalPart(stream.frames)).toBeDefined());
    await waitFor(() => expect(of(stream.frames, 'metrics')).toHaveLength(1));
    const [metrics] = of(stream.frames, 'metrics');
    expect(metrics!.data).toMatchObject({ nativeMessageId: 'receipt-cli', run: { outputTokens: 90, durationMs: 2_000, steps: 1 } });
    expect(metrics!.data.runId).toBeUndefined();
  });

  it('streams a subagent lane of its own', async () => {
    const dir = await stateDir();
    const native = new NativeTranscript();
    native.agents.set('agent-1', [{ kind: 'assistant', id: 'sub-a1', turn: 'st1', text: 'from the subagent' }, { kind: 'end', turn: 'st1' }]);
    native.type({ kind: 'user', id: 'u-t1', turn: 't1', text: 'delegate' }, { kind: 'agent', id: 'call-1', turn: 't1', agent: 'agent-1' }, { kind: 'end', turn: 't1' });
    const app = await boot(dir, native);
    const sessionId = newSession(app, dir);
    const main = app.open(sessionId);
    await waitFor(() => expect([...apply(main.frames).values()].some(row => row.kind === 'tool' && row.subagent?.lane === 'sub:call-1')).toBe(true));
    const sub = app.open(sessionId, `?lane=${encodeURIComponent('sub:call-1')}`);
    await waitFor(() => expect(holds(apply(sub.frames), 'from the subagent')).toBe(true));
    expect(sub.frames[0]!.data).toMatchObject({ lane: 'sub:call-1', mode: 'snapshot' });
    expect([...apply(sub.frames).values()].some(row => row.kind === 'tool')).toBe(false);
    expectSameRows(app, sessionId, apply(sub.frames), 'sub:call-1');
    // Status belongs to the main lane's stream.
    app.control.set({ phase: 'busy' });
    await waitFor(() => expect(of(main.frames, 'status')).toHaveLength(1));
    expect(of(sub.frames, 'status')).toEqual([]);
  });

  it('reports a failed read as a retryable error and keeps the stream', async () => {
    const dir = await stateDir();
    const native = new NativeTranscript();
    native.type(...turn('t1'));
    native.failNext = new Error('transcript is locked');
    const app = await boot(dir, native);
    const sessionId = newSession(app, dir);
    const stream = app.open(sessionId);
    await waitFor(() => expect(of(stream.frames, 'error')).toHaveLength(1));
    expect(of(stream.frames, 'error')[0]!.data).toEqual({ type: 'error', code: 'TRANSCRIPT_READ_FAILED', message: 'transcript is locked', retryable: true });
    native.push(...turn('t2'));
    await waitFor(() => expect(holds(apply(stream.frames), 'answer t2')).toBe(true));
    expect(stream.ended).toBe(false);
  });

  it('reads what a conversation wrote last before its runtime is disposed, and nothing through it after', async () => {
    const dir = await stateDir();
    const native = new NativeTranscript();
    native.type(...turn('t1'));
    const app = await boot(dir, native);
    const sessionId = newSession(app, dir);
    const stream = app.open(sessionId);
    await waitFor(() => expect(holds(apply(stream.frames), 'answer t1')).toBe(true));
    // The last turn reached the disk without a wake: disposing reads it first.
    native.type(...turn('t2'));
    await app.nativeBackends.dispose(sessionId);
    await waitFor(() => expect(holds(apply(stream.frames), 'answer t2')).toBe(true));
    native.push(...turn('t3'));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(holds(apply(stream.frames), 'answer t3')).toBe(false);
    expect(native.inFlight).toBe(0);
  });

  it('serves the timeline by place, by seq and by turn', async () => {
    const dir = await stateDir();
    const native = new NativeTranscript();
    native.type(...turn('t1'), ...turn('t2'));
    const app = await boot(dir, native);
    const sessionId = newSession(app, dir);
    const stream = app.open(sessionId);
    await waitFor(() => expect(holds(apply(stream.frames), 'answer t2')).toBe(true));
    const { generation, headSeq } = app.timeline.head(sessionId, 'main')!;
    const get = (url: string) => app.app.inject({ method: 'GET', url, headers: { host, cookie: app.cookie } });
    const page = (await get(`/api/v3/sessions/${sessionId}/timeline?from=0&rows=2`)).json();
    expect(page).toMatchObject({ generation, hasBefore: false, hasAfter: true });
    expect(page.rows).toHaveLength(2);
    const changes = (await get(`/api/v3/sessions/${sessionId}/timeline/changes?generation=${generation}&after=${headSeq - 1}`)).json();
    expect(changes).toMatchObject({ generation, headSeq, mode: 'delta', from: headSeq, to: headSeq });
    expect((await get(`/api/v3/sessions/${sessionId}/timeline/changes`)).json()).toMatchObject({ mode: 'snapshot', hasBefore: false });
    expect((await get(`/api/v3/sessions/${sessionId}/outline?generation=${generation}`)).json()).toMatchObject({ generation, turnCount: 2 });
    expect((await get(`/api/v3/sessions/${sessionId}/timeline?from=0&generation=stale`)).statusCode).toBe(409);
    expect((await get(`/api/v3/sessions/${sessionId}/timeline?from=0&before=4`)).statusCode).toBe(400);
    expect((await get(`/api/v3/sessions/${sessionId}/sync?lane=side`)).statusCode).toBe(400);
  });

  it('requires a credential, checks the host and closes the stream when the device is revoked', async () => {
    const dir = await stateDir();
    const native = new NativeTranscript();
    native.type(...turn('t1'));
    const app = await boot(dir, native);
    const sessionId = newSession(app, dir);
    for (const path of ['sync', 'timeline?from=0', 'timeline/changes', 'outline']) {
      const anonymous = await app.app.inject({ method: 'GET', url: `/api/v3/sessions/${sessionId}/${path}`, headers: { host } });
      expect([path, anonymous.statusCode, anonymous.json().error.code]).toEqual([path, 401, 'UNAUTHENTICATED']);
      const foreign = await app.app.inject({ method: 'GET', url: `/api/v3/sessions/${sessionId}/${path}`, headers: { host: 'attacker.example', cookie: app.cookie } });
      expect([path, foreign.statusCode]).toEqual([path, 403]);
    }
    const device = app.auth.issueDevice('Phone');
    const stream = app.open(sessionId, '', { authorization: `Bearer ${device.token}` });
    await waitFor(() => expect(finalPart(stream.frames)).toBeDefined());
    app.auth.revokeDevice(device.device.id);
    await waitFor(() => expect(stream.ended).toBe(true));
  });
});
