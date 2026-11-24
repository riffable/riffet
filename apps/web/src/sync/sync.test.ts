import { readFileSync } from 'node:fs';
import type { NativeInteraction, Run, SessionControlSnapshot, SyncFrame, TimelinePage, TimelineRow } from '@contracts';
import { transformSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxHandoff } from '@/app/session/nativeOutbox';
import { NativeJobStore, SubagentStore, type SubagentTranscript } from '@/app/session/subagents';
import { TurnCompletionNotifications } from '@/app/session/turnCompletionNotifications';
import { SyncCache, type CacheBackend, type CachedLane } from './cache';
import type { StreamListener, SyncTransport } from './protocol';
import { timelineItems, withLocalOutbox } from './rows';
import { HIDDEN_CLOSE_MS, SessionSync, type Visibility } from './session';

/** One SSE stream the fake server holds open. */
class FakeStream {
  closed = false;
  constructor(readonly url: string, private readonly listener: StreamListener) {}
  get query(): URLSearchParams { return new URL(this.url, 'http://local').searchParams; }
  open(): void { this.listener.open(); }
  send(frame: SyncFrame | { type: 'ping' }): void {
    if (this.closed) throw new Error(`frame on a closed stream: ${frame.type}`);
    const { type, ...body } = frame;
    this.listener.frame(type, JSON.stringify(body), undefined);
  }
  fail(closed = true): void { this.listener.error(closed); }
  close(): void { this.closed = true; }
}

/** The server side of the protocol: streams it was asked for, and answers for every JSON read. */
class FakeServer implements SyncTransport {
  streams: FakeStream[] = [];
  reads: string[] = [];
  protocol = 3;
  pages: Array<{ match: (path: string) => boolean; answer: () => unknown }> = [];
  stream(url: string, listener: StreamListener): FakeStream {
    const stream = new FakeStream(url, listener);
    this.streams.push(stream);
    return stream;
  }
  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    this.reads.push(path);
    if (path === '/health') return { ok: true, protocol: { version: this.protocol, features: [] } } as T;
    const route = this.pages.find((entry) => entry.match(path));
    if (!route) throw Object.assign(new Error('Not Found'), { status: 404 });
    const value = await route.answer();
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return value as T;
  }
  /** Answers the next read whose path contains [part]; the answer may be held back with [gate]. */
  answer(part: string, value: unknown, gate?: Promise<void>): void {
    const route = { match: (path: string) => path.includes(part), answer: async () => { await gate; this.pages.splice(this.pages.indexOf(route), 1); return value; } };
    this.pages.push(route);
  }
  get live(): FakeStream { return this.streams.filter((stream) => !stream.closed).at(-1)!; }
  liveFor(lane: string): FakeStream | undefined { return this.streams.find((stream) => !stream.closed && stream.query.get('lane') === lane); }
}

const row = (key: string, pos: number, seq: number, text = key): TimelineRow => ({
  key, pos, turn: 'turn:1', seq, rev: 1, kind: 'assistant', text,
  event: { type: 'agent_message_chunk', data: { sessionUpdate: 'agent_message_chunk', content: { type: 'text' } }, createdAt: '2026-10-25T00:00:00Z', lastAt: '2026-10-25T00:00:00Z', sourceIds: [key] },
});
const hello = (generation: string, headSeq: number, mode: 'delta' | 'snapshot', extra: Partial<Extract<SyncFrame, { type: 'hello' }>> = {}): SyncFrame => ({
  type: 'hello', protocol: 3, lane: 'main', generation, headSeq, mode,
  session: { id: 's1', projectId: 'p', kind: 'native', title: 't', tags: [], state: 'running', mode: 'default', createdAt: '', updatedAt: '' },
  status: { phase: 'idle' }, interaction: null, runs: [], activities: [], outline: { turnCount: 0, turns: [] }, ...extra,
});
const snapshot = (generation: string, asOfSeq: number, rows: TimelineRow[], hasBefore = false, part = 0, final = true): SyncFrame => ({ type: 'snapshot', generation, asOfSeq, part, final, rows, hasBefore });
const rowsFrame = (generation: string, from: number, to: number, upserts: TimelineRow[], deletes?: string[]): SyncFrame => ({ type: 'rows', generation, from, to, upserts, ...(deletes ? { deletes } : {}) });
const keys = (sync: SessionSync) => sync.rows().map((item) => item.key);
/** Lets [ms] pass with the server's heartbeat on every open stream, as a live server sends it. */
async function pinging(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 15_000) {
    await vi.advanceTimersByTimeAsync(Math.min(15_000, left));
    for (const stream of server.streams) if (!stream.closed) stream.send({ type: 'ping' });
  }
}

function memoryBackend(): CacheBackend & { records: Map<string, CachedLane> } {
  const records = new Map<string, CachedLane>();
  return {
    records,
    get: async (id) => records.get(id),
    put: async (record) => { records.set(record.sessionId, structuredClone(record)); },
    delete: async (id) => { records.delete(id); },
    list: async () => [...records.values()].map(({ sessionId, savedAt }) => ({ sessionId, savedAt })),
    clear: async () => { records.clear(); },
  };
}

class FakeVisibility implements Visibility {
  isHidden = false;
  private listeners = new Set<() => void>();
  hidden = () => this.isHidden;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  set(hidden: boolean): void { this.isHidden = hidden; for (const listener of this.listeners) listener(); }
}

let server: FakeServer;
const open: SessionSync[] = [];
async function started(options: Partial<ConstructorParameters<typeof SessionSync>[0]> = {}): Promise<SessionSync> {
  const sync = new SessionSync({ sessionId: 's1', transport: server, ...options });
  open.push(sync);
  await sync.start();
  return sync;
}
/** A session the server has brought to G1 through seq 3: rows a, b, c. */
async function synced(options: Partial<ConstructorParameters<typeof SessionSync>[0]> = {}): Promise<SessionSync> {
  const sync = await started(options);
  server.live.open();
  server.live.send(hello('G1', 3, 'snapshot'));
  server.live.send(snapshot('G1', 3, [row('a', 1024, 1), row('b', 2048, 2), row('c', 3072, 3)]));
  return sync;
}

beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeServer();
});
afterEach(() => {
  for (const sync of open.splice(0)) sync.close();
  vi.useRealTimers();
});

describe('sync v3 stream', () => {
  it('shows a snapshot only once all its parts are in, then applies rows in lane seq order', async () => {
    const onUpserts = vi.fn();
    const sync = await started({ onUpserts });
    const stream = server.live;
    expect(stream.query.get('lane')).toBe('main');
    expect(stream.query.has('after')).toBe(false);
    stream.open();
    stream.send(hello('G1', 3, 'snapshot'));
    stream.send(snapshot('G1', 3, [row('a', 1024, 1), row('b', 2048, 2)], false, 0, false));
    expect(keys(sync)).toEqual([]);
    stream.send(snapshot('G1', 3, [row('c', 3072, 3)], false, 1, true));
    expect(keys(sync)).toEqual(['a', 'b', 'c']);
    expect(sync.store.get()).toMatchObject({ synced: true, loaded: true, generation: 'G1', resetVersion: 1 });

    stream.send(rowsFrame('G1', 4, 5, [row('b', 2048, 5, 'b2'), row('d', 4096, 4)], ['a']));
    expect(keys(sync)).toEqual(['b', 'c', 'd']);
    expect(sync.rows().find((item) => item.key === 'b')).toMatchObject({ text: 'b2', seq: 5 });
    expect(sync.main.held).toBe(5);
    // A frame wholly at or below what is held is a repeat.
    stream.send(rowsFrame('G1', 3, 5, [row('x', 9216, 5)]));
    expect(keys(sync)).not.toContain('x');
    expect(onUpserts).toHaveBeenCalledTimes(1);
    expect(onUpserts.mock.calls[0]![0].map((item: TimelineRow) => item.key)).toEqual(['b', 'd']);
    // Valid frame seq does not make a malformed row safe for either the window or its consumers.
    const malformed = ['key', 'pos', 'kind'].map((field) => ({ ...row('bad', 5120, 6), [field]: null })) as unknown as TimelineRow[];
    stream.send(rowsFrame('G1', 6, 6, [...malformed, row('e', 5120, 6)]));
    expect(onUpserts.mock.calls[1]![0].map((item: TimelineRow) => item.key)).toEqual(['e']);
    expect(keys(sync)).toEqual(['b', 'c', 'd', 'e']);
    expect(sync.main.held).toBe(6);
    expect(server.streams).toHaveLength(1);
  });

  it('redials from what it holds when a rows frame does not follow on, and never fetches the gap', async () => {
    const sync = await synced();
    server.live.send(rowsFrame('G1', 5, 6, [row('e', 5120, 6)]));
    expect(keys(sync)).toEqual(['a', 'b', 'c']);
    expect(server.streams[0]!.closed).toBe(true);
    expect(server.live.query.get('generation')).toBe('G1');
    expect(server.live.query.get('after')).toBe('3');
    expect(server.reads.filter((path) => path !== '/health')).toEqual([]);
    // A gap the server keeps reproducing backs off rather than looping.
    server.live.send(rowsFrame('G1', 5, 6, [row('e', 5120, 6)]));
    expect(server.streams.filter((stream) => !stream.closed)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.live.query.get('after')).toBe('3');
  });

  it('resumes a reopened conversation from its saved copy with a delta', async () => {
    const backend = memoryBackend();
    const first = await synced({ cache: new SyncCache(backend) });
    server.live.send(rowsFrame('G1', 4, 4, [row('d', 4096, 4)]));
    first.close();
    expect(backend.records.get('s1')).toMatchObject({ generation: 'G1', seq: 4 });

    // A reloaded page: only the stored copy survives.
    const cache = new SyncCache(backend);
    const reopened = await started({ cache });
    expect(keys(reopened)).toEqual(['a', 'b', 'c', 'd']);
    expect(reopened.store.get()).toMatchObject({ loaded: true, synced: false });
    const stream = server.live;
    expect([stream.query.get('generation'), stream.query.get('after')]).toEqual(['G1', '4']);
    stream.open();
    stream.send(hello('G1', 5, 'delta'));
    // A hello that is not catching up is current once its own rows are in.
    expect(reopened.store.get().catchingUp).toBe(true);
    stream.send(rowsFrame('G1', 5, 5, [row('c', 3072, 5, 'c2')]));
    expect(reopened.store.get().catchingUp).toBe(false);
    expect(keys(reopened)).toEqual(['a', 'b', 'c', 'd']);
    expect(reopened.rows()[2]).toMatchObject({ text: 'c2' });
    expect(reopened.store.get().synced).toBe(true);
    expect(server.reads.filter((path) => path.includes('/timeline'))).toEqual([]);
  });

  it('is caught up only once it holds the seq the server named, whichever of the two arrives first', async () => {
    const sync = await started();
    server.live.open();
    server.live.send(hello('G1', 3, 'snapshot', { catchingUp: true }));
    server.live.send(snapshot('G1', 3, [row('a', 1024, 1), row('b', 2048, 2), row('c', 3072, 3)]));
    expect(sync.store.get().catchingUp).toBe(true);
    // Control frames go out ahead of queued rows: the read's end can arrive before what it found.
    server.live.send({ type: 'caughtUp', generation: 'G1', headSeq: 5 });
    server.live.send(rowsFrame('G1', 4, 4, [row('d', 4096, 4)]));
    expect(sync.store.get().catchingUp).toBe(true);
    server.live.send(rowsFrame('G1', 5, 5, [row('e', 5120, 5)]));
    expect(sync.store.get().catchingUp).toBe(false);
    server.live.send(rowsFrame('G1', 6, 6, [row('f', 6144, 6)]));
    expect(sync.store.get().catchingUp).toBe(false);
    // A redialed stream catches up again.
    server.live.send(hello('G1', 6, 'delta', { catchingUp: true }));
    expect(sync.store.get().catchingUp).toBe(true);
    server.live.send({ type: 'caughtUp', generation: 'G1', headSeq: 6 });
    expect(sync.store.get().catchingUp).toBe(false);
  });

  it('on reset keeps the rows on screen until the snapshot replaces them, and drops the saved copy', async () => {
    const backend = memoryBackend();
    const cache = new SyncCache(backend);
    const sync = await synced({ cache });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(backend.records.has('s1')).toBe(true);
    const resets = sync.store.get().resetVersion;
    const heldRows = sync.rows();

    server.live.send({ type: 'reset', generation: 'G2', reason: 'rebuilt' });
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.records.has('s1')).toBe(false);
    expect(keys(sync)).toEqual(['a', 'b', 'c']);
    // The old generation's rows stay on screen as the same window until its snapshot: a view can
    // tell them from the new generation's rows by that, and not seed the old children again.
    expect(sync.rows()).toBe(heldRows);
    // Nothing of the old generation may be resumed from, and nothing is applied before the snapshot.
    server.live.send(rowsFrame('G2', 1, 1, [row('z', 1024, 1)]));
    expect(keys(sync)).toEqual(['a', 'b', 'c']);
    expect(await sync.pageUp()).toBe('none');
    server.live.fail(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.live.query.has('after')).toBe(false);

    server.live.open();
    server.live.send(hello('G2', 2, 'snapshot'));
    server.live.send(snapshot('G2', 2, [row('x', 1024, 1), row('y', 2048, 2)]));
    expect(keys(sync)).toEqual(['x', 'y']);
    expect(sync.rows()).not.toBe(heldRows);
    expect(sync.store.get()).toMatchObject({ generation: 'G2', resetVersion: resets + 1 });
  });

  it('keeps the window within its limit, giving up the end away from the reader', async () => {
    const sync = await started({ limit: { rows: 4, bytes: Number.MAX_SAFE_INTEGER } });
    server.live.open();
    server.live.send(hello('G1', 4, 'snapshot'));
    server.live.send(snapshot('G1', 4, [row('c', 3072, 1), row('d', 4096, 2), row('e', 5120, 3), row('f', 6144, 4)], true));
    server.live.send(rowsFrame('G1', 5, 6, [row('g', 7168, 5), row('h', 8192, 6)]));
    expect(keys(sync)).toEqual(['e', 'f', 'g', 'h']);
    expect(sync.store.get()).toMatchObject({ hasBefore: true, hasAfter: false });

    // A prefetch of older rows while the reader is at the end: the full window keeps the end, the page does not fit.
    server.answer('before=5120', { generation: 'G1', rows: [row('c', 3072, 1), row('d', 4096, 2)], hasBefore: true, hasAfter: true } satisfies TimelinePage);
    expect(await sync.pageUp()).toBe('none');
    expect(keys(sync)).toEqual(['e', 'f', 'g', 'h']);
    expect(sync.store.get()).toMatchObject({ hasBefore: true, hasAfter: false });

    // The reader at the top pages up: the page goes in at the top and the bottom gives way, so the window leaves the lane's end.
    sync.readerAtEnd(false);
    server.answer('before=5120', { generation: 'G1', rows: [row('c', 3072, 1), row('d', 4096, 2)], hasBefore: true, hasAfter: true } satisfies TimelinePage);
    expect(await sync.pageUp()).toBe('progress');
    expect(server.reads.at(-1)).toContain('/api/v3/sessions/s1/timeline?lane=main&generation=G1&before=5120');
    expect(keys(sync)).toEqual(['c', 'd', 'e', 'f']);
    expect(sync.store.get()).toMatchObject({ hasBefore: true, hasAfter: true });
    // Away from the end, a new row past the window is left out; a change to a row in it still applies.
    server.live.send(rowsFrame('G1', 7, 8, [row('i', 9216, 7), row('d', 4096, 8, 'd2')]));
    expect(keys(sync)).toEqual(['c', 'd', 'e', 'f']);
    expect(sync.rows()[1]).toMatchObject({ text: 'd2' });

    // Coming back down pages from the bottom edge until the lane's end is reached again.
    sync.readerAtEnd(true);
    server.answer('from=6144', { generation: 'G1', rows: [row('f', 6144, 4), row('g', 7168, 5), row('h', 8192, 6), row('i', 9216, 7)], hasBefore: true, hasAfter: false } satisfies TimelinePage);
    expect(await sync.pageDown()).toBe('progress');
    expect(keys(sync)).toEqual(['f', 'g', 'h', 'i']);
    expect(sync.store.get()).toMatchObject({ hasAfter: false });
  });

  it('delivers a completed tool summary after its row has left the window without bringing the row back', async () => {
    const onUpserts = vi.fn();
    const sync = await started({ limit: { rows: 2, bytes: Number.MAX_SAFE_INTEGER }, onUpserts });
    const tool: Extract<TimelineRow, { kind: 'tool' }> = {
      ...row('tool:call_1', 1024, 1), kind: 'tool',
      subagent: { lane: 'sub:call_1', agentId: 'agent-1', running: true, status: 'running', rows: 0 },
      job: { id: 'job-1', toolCallId: 'call_1', title: 'Work', command: 'work', status: 'running', startedAt: '2026-10-25T00:00:00Z' },
    };
    server.live.open();
    server.live.send(hello('G1', 2, 'snapshot'));
    server.live.send(snapshot('G1', 2, [tool, row('b', 2048, 2)]));
    server.live.send(rowsFrame('G1', 3, 3, [row('c', 3072, 3)]));
    expect(keys(sync)).toEqual(['b', 'c']);
    const heldRows = sync.rows();

    server.live.send(rowsFrame('G1', 4, 4, [{
      ...tool, seq: 4, rev: 2,
      subagent: { ...tool.subagent!, running: false, status: 'completed', endedAt: '2026-10-25T00:01:00Z' },
      job: { ...tool.job!, status: 'succeeded', exitCode: 0 },
    }]));
    expect(onUpserts).toHaveBeenCalledTimes(2);
    expect(onUpserts.mock.calls[1]![0]).toEqual([expect.objectContaining({
      key: tool.key, subagent: expect.objectContaining({ running: false, status: 'completed' }), job: expect.objectContaining({ status: 'succeeded' }),
    })]);
    expect(sync.rows()).toBe(heldRows);
    expect(keys(sync)).toEqual(['b', 'c']);
    expect(sync.main.held).toBe(4);
    expect(sync.store.get()).toMatchObject({ hasBefore: true, hasAfter: false });
  });

  it('lays the stream changes made while a page was on its way over that page', async () => {
    const sync = await started();
    server.live.open();
    server.live.send(hello('G1', 2, 'snapshot'));
    server.live.send(snapshot('G1', 2, [row('c', 3072, 1), row('d', 4096, 2)], true));
    let land!: () => void;
    server.answer('before=3072', { generation: 'G1', rows: [row('a', 1024, 1), row('b', 2048, 1)], hasBefore: false, hasAfter: true } satisfies TimelinePage, new Promise((resolve) => { land = resolve; }));
    const paging = sync.pageUp();
    // The page was cut before these: `a` was deleted and `b` changed meanwhile, both outside the window.
    server.live.send(rowsFrame('G1', 3, 4, [row('b', 2048, 4, 'b2')], ['a']));
    land();
    expect(await paging).toBe('progress');
    expect(keys(sync)).toEqual(['b', 'c', 'd']);
    expect(sync.rows()[0]).toMatchObject({ text: 'b2', seq: 4 });
  });

  it('drops an outline turn the server announces with no rows', async () => {
    const sync = await synced();
    const turn = (id: string, rows: number) => ({ turn: `run:${id}`, turnId: id, runId: id, startPos: 2 ** 52, rows, at: '', status: 'running' as const, hasUserMessage: true, preview: 'again' });
    server.live.send({ type: 'outline', turnCount: 2, turns: [turn('q0', 1), turn('q1', 1)] });
    server.live.send({ type: 'outline', turnCount: 1, turns: [turn('q0', 0)] });
    expect(sync.store.get().outline.turns.map(item => item.turn)).toEqual(['run:q1']);
  });

  it('jumps to an outline position and comes back to the live end', async () => {
    const sync = await synced();
    server.answer('around=40960', { generation: 'G1', rows: [row('old1', 40000, 1), row('old2', 41000, 1)], hasBefore: true, hasAfter: true } satisfies TimelinePage);
    expect(await sync.jump(40960)).toBe('progress');
    expect(keys(sync)).toEqual(['old1', 'old2']);
    // A jump stands in for a page still on its way at either end.
    server.answer('from=41000', { generation: 'G1', rows: [row('stale', 42000, 1)], hasBefore: true, hasAfter: true } satisfies TimelinePage, new Promise(() => undefined));
    const stale = sync.pageDown();
    server.answer('around=40960', { generation: 'G1', rows: [row('old1', 40000, 1), row('old2', 41000, 1)], hasBefore: true, hasAfter: true } satisfies TimelinePage);
    expect(await sync.jump(40960)).toBe('progress');
    void stale;
    expect(sync.store.get().hasAfter).toBe(true);
    server.answer('before=9007199254740991', { generation: 'G1', rows: [row('b', 2048, 2), row('c', 3072, 3)], hasBefore: true, hasAfter: false } satisfies TimelinePage);
    expect(await sync.latest()).toBe('progress');
    expect(keys(sync)).toEqual(['b', 'c']);
    expect(sync.store.get().hasAfter).toBe(false);
  });

  it.each(['around', 'latest'] as const)('keeps the loaded window when a %s navigation is cancelled before its answer arrives', async (mode) => {
    const sync = await synced();
    if (mode === 'latest') {
      server.answer('around=40960', { generation: 'G1', rows: [row('old', 40960, 1)], hasBefore: true, hasAfter: true } satisfies TimelinePage);
      expect(await sync.jump(40960)).toBe('progress');
    }
    const beforeKeys = keys(sync);
    const resetVersion = sync.store.get().resetVersion;
    const cancelled = new AbortController();
    cancelled.abort();
    const reads = server.reads.length;
    expect(await sync.jump(40960, cancelled.signal)).toBe('none');
    expect(await sync.latest(cancelled.signal)).toBe('none');
    expect(server.reads).toHaveLength(reads);

    // An uncooperative transport may still deliver the cancelled answer; the lane must reject it.
    const get = server.get.bind(server);
    vi.spyOn(server, 'get').mockImplementation(<T>(path: string) => get<T>(path));
    let land!: () => void;
    server.answer(mode === 'around' ? 'around=40960' : 'before=9007199254740991', {
      generation: 'G1', rows: [row('late', 8192, 3)], hasBefore: true, hasAfter: false,
    } satisfies TimelinePage, new Promise((resolve) => { land = resolve; }));
    const controller = new AbortController();
    const pending = mode === 'around' ? sync.jump(40960, controller.signal) : sync.latest(controller.signal);
    controller.abort();
    land();
    expect(await pending).toBe('none');
    expect(keys(sync)).toEqual(beforeKeys);
    expect(sync.store.get().resetVersion).toBe(resetVersion);
  });

  it('fetches the whole of a truncated row from its blob when asked', async () => {
    const sync = await started();
    server.live.open();
    server.live.send(hello('G1', 1, 'snapshot'));
    server.live.send(snapshot('G1', 1, [{ ...row('a', 1024, 1, 'preview'), truncated: { blobRef: 'hash1', bytes: 90_000 } }]));
    server.answer('/blobs/hash1', { ...row('a', 1024, 0, 'the whole text'), seq: undefined, rev: undefined });
    expect(await sync.expand('a')).toBe(true);
    expect(server.reads.at(-1)).toBe('/api/sessions/s1/blobs/hash1');
    expect(sync.rows()[0]).toMatchObject({ text: 'the whole text', seq: 1, rev: 1 });
    expect(sync.rows()[0]!.truncated).toBeUndefined();
  });
});

describe('sync v3 subagent lanes', () => {
  const child = async () => {
    const sync = await synced();
    const sub = sync.openLane('sub:call_1', () => undefined);
    const stream = server.liveFor('sub:call_1')!;
    stream.open();
    stream.send(hello('C1', 1, 'snapshot', { lane: 'sub:call_1' }));
    stream.send(snapshot('C1', 1, [row('child', 1024, 1)]));
    return { sync, sub, stream };
  };

  it('publishes a child lane on its own generation, apart from the main lane', async () => {
    const { sub } = await child();
    expect(sub.lane.synced).toBe(true);
    expect(sub.lane.generation).toBe('C1');
    expect(sub.lane.window.rows().map((item) => item.key)).toEqual(['child']);
  });

  it('clears the child when its new generation is empty, once the snapshot replaces the window', async () => {
    const { sub, stream } = await child();
    const held = sub.lane.window.rows();
    stream.send({ type: 'reset', generation: 'C2', reason: 'rebuilt' });
    // The reset alone leaves the old rows up until the snapshot that replaces them.
    expect(sub.lane.window.rows()).toBe(held);
    expect(sub.lane.synced).toBe(true);
    stream.send(snapshot('C2', 0, []));
    expect(sub.lane.window.rows()).toEqual([]);
    expect(sub.lane.window.rows()).not.toBe(held);
    expect(sub.lane.generation).toBe('C2');
  });
});

describe('sync v3 session state', () => {
  const pending: NativeInteraction = {
    id: 'A', revision: 'z:submitted', transport: 'protocol', kind: 'plan', title: 'Plan', options: [], actions: [{ id: 'approve', label: 'Approve' }],
  };

  it('shares manual snapshots with the live consumer and rejects snapshots superseded by newer observations', async () => {
    let consumer: NativeInteraction | null = null;
    const sync = await started({ onControl: (frame) => {
      if (frame.type === 'hello' || frame.type === 'interaction' || frame.type === 'status') consumer = sync.store.get().interaction;
    } });
    server.live.open();
    server.live.send(hello('G1', 0, 'snapshot', { interaction: pending }));
    server.live.send(snapshot('G1', 0, []));

    const read = sync.interactionVersion;
    server.live.send({ type: 'status', status: { phase: 'busy' } });
    expect(sync.updateInteraction(null, read)).toBe(true);
    expect(sync.store.get().interaction).toBeNull();
    expect(consumer).toBeNull();
    // A subsequent status must not resurrect the engine's previously held card.
    server.live.send({ type: 'status', status: { phase: 'idle' } });
    expect(consumer).toBeNull();
    expect(sync.updateInteraction(pending, read)).toBe(false);

    server.live.send({ type: 'interaction', interaction: pending });
    const oldRead = sync.interactionVersion;
    const next = { ...pending, id: 'B', revision: 'a:live' };
    server.live.send({ type: 'interaction', interaction: next });
    expect(sync.updateInteraction(pending, oldRead)).toBe(false);
    expect(sync.updateInteraction(null, oldRead)).toBe(false);
    expect(sync.store.get().interaction).toEqual(next);
    expect(consumer).toEqual(next);

    const beforeReset = sync.interactionVersion;
    server.live.send({ type: 'reset', generation: 'G2', reason: 'rebuilt' });
    expect(sync.updateInteraction(null, beforeReset)).toBe(false);
    expect(consumer).toEqual(next);
  });

  it('applies receipts only to the submitted revision before any newer interaction observation', async () => {
    const sync = await synced();
    const submitted = { interactionId: pending.id, revision: pending.revision };
    server.live.send({ type: 'interaction', interaction: pending });
    // A reconnect repeating this exact request is not a newer decision. Its in-flight completion
    // must still clear the card, even if both hello and interaction repeat before the POST returns.
    const terminalPost = sync.interactionVersion;
    server.live.send(hello('G1', 3, 'delta', { interaction: pending }));
    server.live.send({ type: 'interaction', interaction: { actions: pending.actions, options: pending.options, title: pending.title, kind: pending.kind, transport: pending.transport, revision: pending.revision, id: pending.id } });
    expect(sync.interactionVersion).toBe(terminalPost);
    // A completed receipt has no next card and clears the submitted one without changing phase.
    expect(sync.updateInteraction(null, terminalPost, submitted)).toBe(true);
    expect(sync.store.get()).toMatchObject({ interaction: null, status: { phase: 'idle' } });

    server.live.send({ type: 'interaction', interaction: pending });
    const firstPost = sync.interactionVersion;
    const advanced = { ...pending, revision: 'm:receipt' };
    expect(sync.updateInteraction(advanced, firstPost, submitted)).toBe(true);
    expect(sync.store.get().interaction).toEqual(advanced);

    server.live.send({ type: 'interaction', interaction: pending });
    const delayedPost = sync.interactionVersion;
    const live = { ...pending, revision: 'a:live' };
    server.live.send({ type: 'interaction', interaction: live });
    // Revisions are opaque: a delayed intermediate revision cannot overwrite the newest same-id card.
    expect(sync.updateInteraction(advanced, delayedPost, submitted)).toBe(false);
    expect(sync.updateInteraction(null, delayedPost, submitted)).toBe(false);
    // The observation fence is not a substitute for identifying the actual submitted revision.
    expect(sync.updateInteraction(null, sync.interactionVersion, submitted)).toBe(false);
    expect(sync.store.get().interaction).toEqual(live);

    const post = sync.interactionVersion;
    const next = { ...pending, id: 'B' };
    server.live.send({ type: 'interaction', interaction: next });
    expect(sync.updateInteraction(null, post, { interactionId: live.id, revision: live.revision })).toBe(false);
    expect(sync.store.get().interaction).toEqual(next);

    // Fixed-revision providers can still update the actual request content; that is not a repeat.
    const beforeContent = sync.interactionVersion;
    const changed = { ...next, options: [{ id: 'new-scope', label: 'Different permission scope', selected: false }] };
    server.live.send({ type: 'interaction', interaction: changed });
    expect(sync.updateInteraction(null, beforeContent, { interactionId: next.id, revision: next.revision })).toBe(false);

    const oldThreadPost = sync.interactionVersion;
    const sameCardNewThread = { ...sync.store.get().session!, nativeSessionId: 'replacement-thread' };
    server.live.send(hello('G1', 3, 'delta', { interaction: changed, session: sameCardNewThread }));
    expect(sync.updateInteraction(null, oldThreadPost, { interactionId: next.id, revision: next.revision })).toBe(false);
    const beforeGeneration = sync.interactionVersion;
    server.live.send(hello('G2', 0, 'snapshot', { interaction: changed, session: sameCardNewThread }));
    expect(sync.updateInteraction(null, beforeGeneration, { interactionId: next.id, revision: next.revision })).toBe(false);
    const beforeReset = sync.interactionVersion;
    server.live.send({ type: 'reset', generation: 'G3', reason: 'rebuilt' });
    expect(sync.updateInteraction(null, beforeReset, { interactionId: next.id, revision: next.revision })).toBe(false);
  });

  it('takes control state only from control frames and the hello', async () => {
    const run: Run = { id: 'r1', sessionId: 's1', commandId: 'c1', prompt: 'hi', state: 'running', createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z' };
    const frames: string[] = [];
    const sync = await started({ onControl: (frame) => frames.push(frame.type) });
    server.live.open();
    server.live.send(hello('G1', 0, 'snapshot', { status: { phase: 'busy' }, runs: [run], activities: [] }));
    server.live.send(snapshot('G1', 0, []));
    expect(sync.store.get()).toMatchObject({ statusKnown: true, status: { phase: 'busy' }, runs: [run], loaded: true });
    // A transcript that says the turn ended changes none of it.
    server.live.send(rowsFrame('G1', 1, 1, [{ ...row('done', 1024, 1), kind: 'status', tone: 'muted', text: 'ended' } as TimelineRow]));
    expect(sync.store.get().status.phase).toBe('busy');
    server.live.send({ type: 'status', status: { phase: 'idle' } });
    server.live.send({ type: 'run', run: { ...run, state: 'completed' } });
    server.live.send({ type: 'metrics', metrics: { outputTokens: 5, durationMs: 1000 } as never, runId: 'r1', run: { outputTokens: 5, durationMs: 1000, steps: 1 } as never });
    server.live.send({ type: 'interaction', interaction: null });
    expect(sync.store.get()).toMatchObject({ status: { phase: 'idle' }, runs: [{ id: 'r1', state: 'completed' }] });
    expect(sync.store.get().metrics.get('r1')).toMatchObject({ outputTokens: 5 });
    expect(frames).toEqual(['hello', 'status', 'run', 'metrics', 'interaction']);
  });

  it('replaces control from hello and ignores a control frame whose revision went backwards', async () => {
    const frames: string[] = [];
    const sync = await started({ onControl: (frame) => frames.push(frame.type) });
    const control = (revision: number, runtime: SessionControlSnapshot['runtime'] = 'ready'): SessionControlSnapshot => ({
      revision, runtime, activeTurn: null, inbox: [], interaction: null, activity: { compacting: false, background: 0 },
      capabilities: { canStop: false, canSteer: false, canSendNow: false },
    });
    server.live.open();
    // No baseline yet: the first control frame is kept, and it is not a transcript delta.
    server.live.send({ type: 'control', control: control(4) });
    expect(sync.store.get().control).toMatchObject({ revision: 4, runtime: 'ready' });
    expect(keys(sync)).toEqual([]);
    // A hello is the baseline for this connection, even when its revision is older.
    server.live.send(hello('G1', 1, 'snapshot', { control: control(1), runs: [] }));
    expect(sync.store.get().control?.revision).toBe(1);
    server.live.send(snapshot('G1', 1, [row('a', 1024, 1)]));
    // Equal revision still carries a newer body. An older one does not move the snapshot.
    server.live.send({ type: 'control', control: control(1, 'failed') });
    expect(sync.store.get().control).toMatchObject({ revision: 1, runtime: 'failed' });
    server.live.send({ type: 'control', control: control(0) });
    expect(sync.store.get().control?.revision).toBe(1);
    server.live.send({ type: 'control', control: control(2) });
    expect(sync.store.get().control?.revision).toBe(2);
    // The next hello clears a snapshot it does not repeat, and live rows still apply.
    server.live.send(hello('G1', 1, 'delta'));
    expect(sync.store.get().control).toBeUndefined();
    server.live.send(rowsFrame('G1', 2, 2, [row('b', 2048, 2)]));
    expect(keys(sync)).toEqual(['a', 'b']);
    expect(sync.store.get().status.phase).toBe('idle');
    expect(frames).toEqual(['control', 'hello', 'control', 'control', 'control', 'hello']);
  });

  it('closes the streams after the tab has been hidden a minute and resumes from what it holds', async () => {
    const visibility = new FakeVisibility();
    const sync = await synced({ visibility });
    const sub = sync.openLane('sub:t1', () => undefined);
    server.liveFor('sub:t1')!.open();
    visibility.set(true);
    await pinging(HIDDEN_CLOSE_MS - 1_000);
    expect(server.streams.every((stream) => !stream.closed)).toBe(true);
    await pinging(1_000);
    expect(server.streams.every((stream) => stream.closed)).toBe(true);
    expect(sync.store.get().connection).toBe('suspended');
    visibility.set(false);
    const main = server.liveFor('main')!;
    expect([main.query.get('generation'), main.query.get('after')]).toEqual(['G1', '3']);
    expect(server.liveFor('sub:t1')).toBeDefined();
    // Shown again before the minute was up: nothing closes.
    main.open();
    visibility.set(true);
    await pinging(30_000);
    visibility.set(false);
    await pinging(HIDDEN_CLOSE_MS);
    expect(server.liveFor('main')).toBe(main);
    sub.release();
  });

  it('subscribes to a subagent lane only while a panel holds it', async () => {
    const sync = await synced();
    const first = sync.openLane('sub:call_1', () => undefined);
    const second = sync.openLane('sub:call_1', () => undefined);
    expect(server.streams.filter((stream) => stream.query.get('lane') === 'sub:call_1')).toHaveLength(1);
    first.release();
    expect(server.liveFor('sub:call_1')).toBeDefined();
    second.release();
    expect(server.liveFor('sub:call_1')).toBeUndefined();
  });

  it('reports a server that speaks no v3 as outdated, and tries again when asked', async () => {
    server.protocol = 2;
    const sync = await started();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.store.get().connection).toBe('outdated');
    expect(server.streams.every((stream) => stream.closed)).toBe(true);
    server.protocol = 3;
    sync.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.live.closed).toBe(false);
    expect(sync.store.get().connection).toBe('connecting');
  });

  it('reports a missing v3 route as outdated', async () => {
    const sync = await started();
    server.live.open();
    server.live.send(hello('G1', 1, 'snapshot'));
    server.live.send(snapshot('G1', 1, [row('a', 1024, 1)], true));
    // No page route answers: the server's framework says 404 without an app error code.
    expect(await sync.pageUp()).toBe('none');
    expect(sync.store.get().connection).toBe('outdated');
    // A stream that gave up on an old server finds out the same way.
    server.protocol = 2;
    const other = new SessionSync({ sessionId: 's2', transport: server });
    open.push(other);
    await other.start();
    server.live.fail(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(other.store.get().connection).toBe('outdated');
  });

  it('shows a retryable error on a stream that goes on, and stops on one that is not', async () => {
    const sync = await synced();
    const stream = server.live;
    server.live.send({ type: 'error', code: 'TRANSCRIPT_READ_FAILED', message: 'unreadable', retryable: true });
    expect(stream.closed).toBe(false);
    expect(sync.store.get()).toMatchObject({ connection: 'open', error: { code: 'TRANSCRIPT_READ_FAILED' } });
    // A read can recover without producing another transcript row.
    stream.send({ type: 'status', status: { phase: 'idle', history: { state: 'loading' } } });
    expect(sync.store.get().error?.code).toBe('TRANSCRIPT_READ_FAILED');
    stream.send({ type: 'status', status: { phase: 'idle', history: { state: 'ready' } } });
    expect(sync.store.get().error).toBeUndefined();
    stream.send({ type: 'error', code: 'TRANSCRIPT_READ_FAILED', message: 'unreadable', retryable: true });
    stream.send(hello('G1', 3, 'snapshot'));
    expect(sync.store.get().error?.code).toBe('TRANSCRIPT_READ_FAILED');
    stream.send(snapshot('G1', 3, []));
    expect(sync.store.get().error).toBeUndefined();
    stream.send({ type: 'error', code: 'TRANSCRIPT_READ_FAILED', message: 'unreadable', retryable: true });
    stream.send(rowsFrame('G1', 4, 4, [row('d', 4096, 4)]));
    expect(sync.store.get().error).toBeUndefined();
    stream.send({ type: 'error', code: 'OTHER_FAILURE', message: 'unrelated', retryable: true });
    stream.send({ type: 'status', status: { phase: 'idle', history: { state: 'ready' } } });
    stream.send(rowsFrame('G1', 5, 5, [row('e', 5120, 5)]));
    expect(sync.store.get().error?.code).toBe('OTHER_FAILURE');
    // The server repeats a failure that still holds after its hello; one it does not repeat is over.
    stream.send(hello('G1', 5, 'delta'));
    expect(sync.store.get().error).toBeUndefined();
    stream.send({ type: 'error', code: 'SESSION_NOT_FOUND', message: 'gone', retryable: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.streams.filter((each) => !each.closed)).toHaveLength(0);
    expect(sync.store.get()).toMatchObject({ connection: 'failed', error: { code: 'SESSION_NOT_FOUND' } });
    sync.retry();
    expect(server.live.query.get('after')).toBe('5');
  });

  it('replaces a stream that went silent past two pings', async () => {
    await synced();
    const stream = server.live;
    await vi.advanceTimersByTimeAsync(30_000);
    stream.send({ type: 'ping' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.live).toBe(stream);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stream.closed).toBe(true);
    expect(server.live.query.get('after')).toBe('3');
  });
});

describe('sync v3 cache', () => {
  const lane = (seq: number) => ({ generation: 'G', seq, rows: [row('a', 1024, seq)], hasBefore: false });

  it('keeps the eight most recently saved conversations', async () => {
    const backend = memoryBackend();
    const cache = new SyncCache(backend);
    for (let index = 1; index <= 9; index += 1) await cache.save(`s${index}`, lane(index));
    expect([...backend.records.keys()].sort()).toEqual(['s2', 's3', 's4', 's5', 's6', 's7', 's8', 's9']);
    await cache.save('s2', lane(20));
    await cache.save('s10', lane(10));
    expect(backend.records.has('s2')).toBe(true);
    expect(backend.records.has('s3')).toBe(false);
    expect(await new SyncCache(backend).load('s2')).toEqual(lane(20));
    expect(new SyncCache(backend).peek('s2')).toBeUndefined();
  });

  it('saves only the newest rows of a long window', async () => {
    const backend = memoryBackend();
    const sync = await started({ cache: new SyncCache(backend) });
    server.live.open();
    server.live.send(hello('G1', 700, 'snapshot'));
    const long = 'x'.repeat(4000);
    server.live.send(snapshot('G1', 700, Array.from({ length: 700 }, (_, index) => row(`r${index}`, 1024 * (index + 1), index + 1, long)), false));
    sync.close();
    await vi.advanceTimersByTimeAsync(0);
    const saved = backend.records.get('s1')!;
    expect(saved.hasBefore).toBe(true);
    expect(saved.rows.length).toBeLessThan(700);
    expect(saved.rows.map((item) => JSON.stringify(item).length).reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(1024 * 1024);
    expect(saved.rows.at(-1)!.key).toBe('r699');
  });

  it('writes nothing back for a view opened before signing out', async () => {
    const backend = memoryBackend();
    const cache = new SyncCache(backend);
    const epoch = cache.epoch;
    await cache.clear();
    await cache.save('s1', lane(1), epoch);
    expect(backend.records.size).toBe(0);
    expect(await cache.load('s1')).toBeUndefined();
  });
});

describe('sync v3 summary consistency', () => {
  // Exercise the hook's actual private callbacks without rendering UI or adding test-only exports.
  // These are the same read-only production slices used by the two reported defect reproducers.
  const source = readFileSync(new URL('../app/session/useSessionSync.ts', import.meta.url), 'utf8');
  const section = (start: string, end: string, bodyOnly = false): string => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    if (from < 0 || to < 0) throw new Error(`Missing summary callback: ${start}`);
    return source.slice(from + (bodyOnly ? start.length : 0), to);
  };
  const compile = (text: string) => transformSync(text, { loader: 'ts', format: 'cjs' }).code;
  const writer = new Function(`${compile(section('function writeToolSummaries(', '\nfunction historyLoad'))}\nreturn writeToolSummaries;`)();
  // Bind the shared identity boundary and notification eligibility without rendering UI.
  const bind = new Function('sync', 'nativeThread', 'subagents', 'jobs', 'identityEpoch', 'watchedPanels', 'writeToolSummaries', 'completions', `${compile(`
    ${section('    let summaryGeneration:', '\n    const notify')}
    const onUpserts = (rows) => {${section('      onUpserts: (rows) => {', '\n      },', true)}\n};
    const onControl = (frame) => {${section("      if (frame.type === 'hello' || frame.type === 'session') {", '\n      if (completed) {')}\nreturn completed;\n};
  `)}\nreturn { onUpserts, onControl, hydrateSummaries };`);
  const bindLanes = new Function('sync', 'subagents', 'watchedPanels', 'identityEpoch', 'session', 'store', 'timelineItems', 'coalesced', compile(section('    const watched = new Map<string, LaneSync>();', '\n    syncToolSummaries.current')));
  const tool = (call: string, seq: number, running: boolean, agentId = 'same-agent'): Extract<TimelineRow, { kind: 'tool' }> => ({
    ...row(`tool:${call}`, seq * 1024, seq), kind: 'tool',
    event: { ...row(call, 0, seq).event, type: 'tool_call', data: { toolCallId: call } },
    subagent: { lane: `sub:${call}`, agentId, running, status: running ? 'running' : 'completed', rows: 0 },
    job: { id: `job:${call}`, toolCallId: call, title: 'Work', command: 'work', status: running ? 'running' : 'succeeded', startedAt: '' },
  });
  const consumer = async (panels = new Set<{ attach(): void; detach(): void }>()) => {
    const subagents = new SubagentStore();
    const jobs = new NativeJobStore();
    let callbacks!: { onUpserts(rows: readonly TimelineRow[]): void; onControl(frame: SyncFrame): boolean; hydrateSummaries(): void };
    const completions: boolean[] = [];
    const sync = await started({ limit: { rows: 2, bytes: Number.MAX_SAFE_INTEGER }, onUpserts: rows => callbacks.onUpserts(rows), onControl: frame => { completions.push(Boolean(callbacks.onControl(frame))); } });
    const epoch = { current: 0 };
    const watchedPanels = { current: panels };
    callbacks = bind(sync, { current: { prop: 'T1', current: 'T1' } }, subagents, jobs, epoch, watchedPanels, writer, new TurnCompletionNotifications());
    // Lane watches are transport subscriptions, not rendered UI; advance them through fake timers.
    bindLanes(sync, subagents, watchedPanels, epoch, thread('T1'), { get: () => ({ runs: [] }) }, timelineItems, (run: () => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return { schedule: () => { timer ??= setTimeout(() => { timer = undefined; run(); }, 0); }, cancel: () => { clearTimeout(timer); timer = undefined; } };
    });
    const stop = sync.store.subscribe(callbacks.hydrateSummaries);
    return { sync, subagents, jobs, stop, completions, stream: server.liveFor('main')! };
  };
  const thread = (id: string) => ({ ...(hello('G1', 0, 'snapshot') as Extract<SyncFrame, { type: 'hello' }>).session, nativeSessionId: id });

  it('resumes completion notifications after session-only identity changes and ignores old-generation outlines', async () => {
    const { stream, stop, completions } = await consumer();
    const outline = (status: 'running' | 'completed', endedAt?: string): SyncFrame => ({
      type: 'outline', turnCount: 1, turns: [{ turn: 'native:turn', turnId: 'turn', startPos: 1024, rows: 1, at: '', status, ...(endedAt ? { endedAt } : {}) }],
    });
    try {
      stream.open();
      stream.send(hello('G1', 1, 'snapshot', { session: thread('T1') }));
      stream.send(snapshot('G1', 1, [row('old', 1024, 1)]));
      stream.send(outline('running'));
      stream.send({ type: 'session', session: thread('T2') });
      stream.send(outline('completed', new Date().toISOString()));
      stream.send({ type: 'reset', generation: 'G2', reason: 'rebuilt' });
      stream.send(snapshot('G2', 1, [row('new', 1024, 1)]));
      stream.send(outline('running'));
      expect(completions.some(Boolean)).toBe(false);
      stream.send(outline('completed', new Date().toISOString()));
      stream.send(outline('completed', new Date().toISOString()));
      expect(completions.filter(Boolean)).toHaveLength(1);
    } finally { stop(); }
  });

  it('shares summary ordering across a resumed child and its older aliases, then forgets it on generation reset', async () => {
    const { sync, subagents, stream, stop } = await consumer();
    try {
      stream.open();
      const old = tool('call-1', 10, false);
      stream.send(hello('G1', 11, 'snapshot', { session: thread('T1') }));
      stream.send(snapshot('G1', 11, [old, row('b', 11 * 1024, 11)]));
      stream.send(rowsFrame('G1', 12, 20, [tool('call-9', 20, true)]));
      expect(subagents.canonical('call-9')).toBe('call-1');
      expect(subagents.get('call-9')).toMatchObject({ lane: 'sub:call-9', running: true });
      // Paging the canonical call back in, plus a previously unseen old alias, only joins identities.
      server.answer('around=10240', { generation: 'G1', rows: [tool('call-0', 5, false), old], hasBefore: false, hasAfter: true } satisfies TimelinePage);
      expect(await sync.jump(10240)).toBe('progress');
      expect(subagents.canonical('call-0')).toBe('call-1');
      expect(subagents.getSnapshot()).toHaveLength(1);
      expect(subagents.get('call-1')).toMatchObject({ lane: 'sub:call-9', running: true });
      stream.send(rowsFrame('G1', 21, 21, [{ ...tool('call-9', 21, false), pos: 20 * 1024 }]));
      expect(subagents.get('call-1')).toMatchObject({ lane: 'sub:call-9', running: false });
      // A newer claim for the same agent is not pinned to the former call/lane or terminal state.
      stream.send(rowsFrame('G1', 22, 22, [tool('call-20', 22, true)]));
      expect(subagents.get('call-1')).toMatchObject({ lane: 'sub:call-20', running: true });
      stream.send({ type: 'reset', generation: 'G2', reason: 'rebuilt' });
      expect(subagents.getSnapshot()).toEqual([]);
      stream.send(snapshot('G2', 1, [tool('call-1', 1, false)]));
      expect(subagents.get('call-1')).toMatchObject({ lane: 'sub:call-1', running: false });
      expect(subagents.get('call-9')).toBeUndefined();
      // A hello can publish generation before its consumer observes the thread in that same frame.
      stream.send(hello('G3', 1, 'snapshot', { session: thread('T3') }));
      stream.send(snapshot('G3', 1, [tool('call-1', 1, true)]));
      expect(subagents.get('call-1')).toMatchObject({ lane: 'sub:call-1', running: true });
    } finally { stop(); }
  });

  it('separates a reclaimed alias from its old agent and follows its lane again after reset and rebinding', async () => {
    const { subagents, stream, stop } = await consumer();
    let unwatch: (() => void) | undefined;
    try {
      stream.open();
      stream.send(hello('G1', 1, 'snapshot', { session: thread('T1') }));
      stream.send(snapshot('G1', 1, [tool('call-1', 1, true, 'agent-A')]));
      stream.send(rowsFrame('G1', 2, 2, [tool('call-9', 2, true, 'agent-A')]));
      unwatch = subagents.lanes!.watch('call-9');
      const oldLane = server.liveFor('sub:call-9')!;
      oldLane.open();
      oldLane.send(hello('CA', 1, 'snapshot', { lane: 'sub:call-9' }));
      oldLane.send(snapshot('CA', 1, [row('history-A', 1024, 1)]));
      await vi.advanceTimersByTimeAsync(0);
      expect(subagents.get('call-1')?.events).toHaveLength(1);

      stream.send(rowsFrame('G1', 3, 3, [tool('call-9', 3, true, 'agent-B')]));
      expect(subagents.getSnapshot()).toHaveLength(2);
      expect(subagents.get('call-1')).toMatchObject({ agentId: 'agent-A', events: [expect.objectContaining({ projectionKey: 'history-A' })] });
      expect(subagents.get('call-9')).toMatchObject({ agentId: 'agent-B', lane: 'sub:call-9', events: [] });
      expect(subagents.get('call-9')?.timeline).toBeUndefined();
      expect(subagents.get('call-9')?.history).toBeUndefined();
      expect(oldLane.closed).toBe(true);
      expect(server.liveFor('sub:call-9')).not.toBe(oldLane);
      // Reclaiming another old alias also joins an already-held B rather than replacing A.
      stream.send(rowsFrame('G1', 4, 4, [tool('call-11', 4, true, 'agent-A')]));
      stream.send(rowsFrame('G1', 5, 5, [tool('call-11', 5, true, 'agent-B')]));
      expect(subagents.canonical('call-11')).toBe('call-9');
      expect(subagents.get('call-11')).toMatchObject({ agentId: 'agent-B', lane: 'sub:call-11', events: [] });
      expect(subagents.get('call-1')?.events).toHaveLength(1);
      expect(subagents.getSnapshot()).toHaveLength(2);

      stream.send({ type: 'reset', generation: 'G2', reason: 'rebuilt' });
      stream.send(snapshot('G2', 1, [tool('call-9', 1, true, 'agent-B')]));
      const resumed = server.liveFor('sub:call-9')!;
      expect(resumed).toBeDefined();
      // The watch was created while call-9 resolved to call-1. It must now follow call-9, not
      // remain subscribed to that forgotten canonical id or wait for the old child lane to answer.
      stream.send(rowsFrame('G2', 2, 2, [tool('call-20', 2, true, 'agent-B')]));
      expect(subagents.get('call-9')).toMatchObject({ lane: 'sub:call-20', agentId: 'agent-B' });
      expect(resumed.closed).toBe(true);
      const repaired = server.liveFor('sub:call-20')!;
      expect(repaired).toBeDefined();
      repaired.open();
      repaired.send(hello('CB', 1, 'snapshot', { lane: 'sub:call-20' }));
      repaired.send(snapshot('CB', 1, [row('history-B', 1024, 1)]));
      await vi.advanceTimersByTimeAsync(0);
      expect(subagents.get('call-9')?.events).toEqual([expect.objectContaining({ projectionKey: 'history-B' })]);
    } finally { unwatch?.(); stop(); }
    expect(server.liveFor('sub:call-20')).toBeUndefined();
  });

  it('isolates consecutive old-thread upserts and pages, then recovers new-generation summaries outside the window', async () => {
    const panel = { attach: vi.fn(), detach: vi.fn() };
    const panels = new Set<typeof panel>();
    const { sync, subagents, jobs, stream, stop } = await consumer(panels);
    try {
      stream.open();
      stream.send(hello('G1', 1, 'snapshot', { session: thread('T1') }));
      stream.send(snapshot('G1', 1, [tool('old-call', 1, true)]));
      panels.add(panel);
      stream.send({ type: 'session', session: thread('T2') });
      for (const seq of [2, 3]) stream.send(rowsFrame('G1', seq, seq, [tool('old-call', seq, true)]));
      // Even a replacement window in the old generation is not evidence of the new thread.
      server.answer('around=1024', { generation: 'G1', rows: [tool('old-call', 3, true)], hasBefore: false, hasAfter: false } satisfies TimelinePage);
      expect(await sync.jump(1024)).toBe('progress');
      stream.send(rowsFrame('G1', 4, 4, [tool('old-call', 4, true)]));
      expect(subagents.getSnapshot()).toEqual([]);
      expect(jobs.getSnapshot()).toEqual([]);
      expect(panel.detach).toHaveBeenCalledTimes(1);
      expect(panel.attach).not.toHaveBeenCalled();

      stream.send({ type: 'reset', generation: 'G2', reason: 'rebuilt' });
      stream.send(hello('G2', 2, 'snapshot', { session: thread('T2') }));
      stream.send(snapshot('G2', 2, [tool('new-call', 1, true), row('b', 2048, 2)]));
      expect(subagents.get('new-call')).toMatchObject({ lane: 'sub:new-call', running: true });
      expect(jobs.get('new-call')).toMatchObject({ status: 'running' });
      expect(panel.attach).toHaveBeenCalledTimes(1);
      stream.send(rowsFrame('G2', 3, 3, [row('c', 3072, 3)]));
      const held = sync.rows();
      stream.send(rowsFrame('G2', 4, 4, [{ ...tool('new-call', 4, false), pos: 1024 }]));
      expect(sync.rows()).toBe(held);
      expect(subagents.get('new-call')).toMatchObject({ running: false, status: 'completed' });
      expect(jobs.get('new-call')).toMatchObject({ status: 'succeeded' });
      expect(subagents.get('old-call')).toBeUndefined();
    } finally { stop(); }
  });
});

describe('sync v3 subagent store', () => {
  const transcript = (agentId: string, over: Partial<SubagentTranscript> = {}): SubagentTranscript => ({ agentId, events: [], ...over });

  it('keeps one entry for a child announced under two call ids, and its spawn lane', () => {
    const store = new SubagentStore();
    store.set('subagent-activity:call_1', transcript('agent-1', { lane: 'sub:subagent-activity:call_1', running: true }));
    store.set('call_1', transcript('agent-1', { lane: 'sub:call_1', running: false, title: 'Explore' }));
    expect(store.getSnapshot()).toEqual([{ toolCallId: 'call_1', transcript: expect.objectContaining({ agentId: 'agent-1', lane: 'sub:call_1', title: 'Explore' }) }]);
    // A later activity announcement of the same spawn leaves the lane the spawn's row named.
    store.set('subagent-activity:call_1', { ...store.get('call_1')!, lane: 'sub:subagent-activity:call_1' });
    expect(store.get('subagent-activity:call_1')).toMatchObject({ lane: 'sub:call_1', title: 'Explore' });
  });

  it('clears the transcript a child lane answered empty, keeping only a merge across call ids', () => {
    const store = new SubagentStore();
    store.set('call_1', transcript('agent-1', { lane: 'sub:call_1' }));
    const items = timelineItems([row('child', 1024, 1)], 's1', []);
    store.set('call_1', transcript('agent-1', { lane: 'sub:call_1', events: items.map((item) => item.event), timeline: items, synced: true }));
    store.set('call_1', transcript('agent-1', { lane: 'sub:call_1', synced: true }));
    expect(store.get('call_1')).toMatchObject({ events: [], synced: true });
    expect(store.get('call_1')?.timeline).toBeUndefined();
    // The same child under another call id joins the entry and keeps what it already showed.
    store.set('call_9', transcript('agent-1', { lane: 'sub:call_9', running: true }));
    expect(store.getSnapshot().map((entry) => entry.toolCallId)).toEqual(['call_1']);
    expect(store.get('call_9')).toMatchObject({ lane: 'sub:call_9', running: true });
  });

  it('retires an existing unidentified entry when its summary identifies an already known child', () => {
    const store = new SubagentStore();
    const items = timelineItems([row('child', 1024, 1)], 's1', []);
    const unidentified = transcript('', { lane: 'sub:call_9', events: items.map(item => item.event), timeline: items });
    store.set('call_9', unidentified);
    store.set('call_1', transcript('agent-1', { lane: 'sub:call_1' }));
    let updates = 0;
    const release = store.subscribe('call_9', () => { updates += 1; });
    store.set('call_9', { ...unidentified, agentId: 'agent-1' });
    expect(store.getSnapshot().map(entry => entry.toolCallId)).toEqual(['call_1']);
    expect(store.get('call_9')).toBe(store.get('call_1'));
    expect(store.get('call_9')?.events).toEqual(unidentified.events);
    expect(updates).toBe(1);
    store.set('call_1', { ...store.get('call_1')!, running: false });
    expect(updates).toBe(2);
    release();
  });

  it('keeps the other children when a trimmed window re-announces only some of them', () => {
    const store = new SubagentStore();
    store.set('call_1', transcript('agent-1', { lane: 'sub:call_1' }));
    store.set('call_2', transcript('agent-2', { lane: 'sub:call_2' }));
    store.set('call_1', transcript('agent-1', { lane: 'sub:call_1', running: true }));
    expect(store.getSnapshot().map((entry) => entry.toolCallId)).toEqual(['call_1', 'call_2']);
    expect(store.get('call_1')?.running).toBe(true);
    store.clear();
    expect(store.getSnapshot()).toEqual([]);
  });
});

describe('sync v3 outbox', () => {
  const nativeRun = (id: string, commandId: string, state: Run['state'], native: Partial<NonNullable<Run['native']>> = {}): Run => ({
    id, sessionId: 's1', commandId, prompt: 'hello', state, createdAt: '2026-10-25T00:00:01Z', updatedAt: '2026-10-25T00:00:01Z',
    native: {
      input: { text: 'hello', attachmentIds: [], context: [] },
      config: { mode: 'agent' },
      fingerprint: 'server',
      delivery: 'queued',
      attempt: 1,
      configRevision: 1,
      ...native,
    },
  });

  it('shows a local send under the key the server will use and drops it when the server row arrives', () => {
    const local: Run = { id: 'cmd1', sessionId: 's1', commandId: 'cmd1', prompt: 'hello', state: 'queued', createdAt: '2026-10-25T00:00:01Z', updatedAt: '2026-10-25T00:00:01Z' };
    const rows = [row('a', 1024, 1)];
    const withLocal = withLocalOutbox(rows, [local]);
    expect(withLocal.map((item) => item.key)).toEqual(['a', 'user:cmd1']);
    expect(withLocalOutbox(rows, [local])).toEqual(withLocal);
    const items = timelineItems(withLocal, 's1', [local]);
    expect(items[1]).toMatchObject({ kind: 'user', key: 'user:cmd1', text: 'hello', run: local });
    // A non-user row carrying the same runId must not hide the user placeholder.
    const statusForRun: TimelineRow[] = [...rows, { ...row('status:1', 2048, 2), kind: 'status', tone: 'danger', text: 'boom', runId: 'cmd1' } as TimelineRow];
    expect(withLocalOutbox(statusForRun, [local]).map((item) => item.key)).toEqual(['a', 'status:1', 'user:cmd1']);
    const server = [...rows, { ...row('user:cmd1', 2 ** 52, 2), kind: 'user', text: 'hello', attachments: [], runId: 'cmd1', pending: 'queued' } as TimelineRow];
    expect(withLocalOutbox(server, [local]).map((item) => item.key)).toEqual(['a', 'user:cmd1']);
    expect(withLocalOutbox(server, [local])).toBe(server);
  });

  it('keeps a local send through fast control transitions until the server user row lands, then retires it permanently', () => {
    const handoff = new OutboxHandoff();
    const baseRows = [row('a', 1024, 1)];
    const local = nativeRun('cmd1', 'cmd1', 'queued', { fingerprint: 'client-pending', delivery: 'queued', stage: 'http_pending' });
    expect(withLocalOutbox(baseRows, handoff.reconcile([local], baseRows, { hasAfter: false, generation: 'g1' })).map((item) => item.key)).toEqual(['a', 'user:cmd1']);

    // Control plane races ahead of timeline folding: input_sent -> observed -> completed.
    for (const advanced of [
      nativeRun('r1', 'cmd1', 'running', { delivery: 'input_sent' }),
      nativeRun('r1', 'cmd1', 'running', { delivery: 'observed', nativeMessageId: 'native-u1' }),
      nativeRun('r1', 'cmd1', 'completed', { delivery: 'observed', nativeMessageId: 'native-u1' }),
    ]) {
      const outbox = handoff.reconcile([advanced], baseRows, { hasAfter: false, generation: 'g1' });
      expect(withLocalOutbox(baseRows, outbox).map((item) => item.key)).toEqual(['a', 'user:cmd1']);
      // Idempotent under StrictMode double-invocation.
      expect(handoff.reconcile([advanced], baseRows, { hasAfter: false, generation: 'g1' })).toEqual(outbox);
    }

    // Server user row finally arrives -> handoff completes.
    const completed = nativeRun('r1', 'cmd1', 'completed', { delivery: 'observed', nativeMessageId: 'native-u1' });
    const withServerUser: TimelineRow[] = [...baseRows, { ...row('user:cmd1', 2048, 2), kind: 'user', text: 'hello', attachments: [], runId: 'r1' } as TimelineRow];
    expect(handoff.reconcile([completed], withServerUser, { hasAfter: false, generation: 'g1' })).toEqual([]);

    // Later the old row scrolls out of the top of the sliding window: must not be re-appended.
    const newerWindow = [row('later', 4096, 3)];
    expect(handoff.reconcile([completed], newerWindow, { hasAfter: false, generation: 'g1' })).toEqual([]);
  });

  it('keeps a steer on its original turn through a rejection before its server row arrives', () => {
    const handoff = new OutboxHandoff();
    const target = { intent: 'steer', ownerRunId: 'owner' } as const;
    const rows = [row('a', 1024, 1)];
    for (const run of [
      nativeRun('cmd1', 'cmd1', 'queued', { ...target, fingerprint: 'client-pending', stage: 'http_pending' }),
      nativeRun('r1', 'cmd1', 'failed', { ...target, delivery: 'failed', stage: 'steer_missed' }),
    ]) {
      const pending = handoff.reconcile([run], rows, { hasAfter: false, generation: 'g1' });
      const visible = timelineItems(withLocalOutbox(rows, pending), 's1', [run]);
      expect(visible.at(-1)).toMatchObject({ kind: 'user', key: 'user:cmd1', turn: 'run:owner', run });
    }
  });

  it('drops a tracked handoff on cancellation, confirmed generation change, or when scrolled off the top', () => {
    const handoff = new OutboxHandoff();
    const baseRows = [row('a', 1024, 1)];
    const local1 = nativeRun('cmd1', 'cmd1', 'queued', { fingerprint: 'client-pending', stage: 'http_pending' });
    const local2 = nativeRun('cmd2', 'cmd2', 'queued', { fingerprint: 'client-pending', stage: 'http_pending' });
    const local3 = nativeRun('cmd3', 'cmd3', 'queued', { fingerprint: 'client-pending', stage: 'http_pending' });
    expect(handoff.reconcile([local1, local2, local3], baseRows, { hasAfter: false, generation: 'g1' }).map((run) => run.commandId)).toEqual(['cmd1', 'cmd2', 'cmd3']);

    const cancelled = nativeRun('r1', 'cmd1', 'cancelled', { delivery: 'cancelled' });
    const stillRunning = nativeRun('r2', 'cmd2', 'running', { delivery: 'observed', nativeMessageId: 'm2' });
    const scrolledOld = nativeRun('r3', 'cmd3', 'completed', { delivery: 'observed', nativeMessageId: 'm3' });
    expect(handoff.reconcile([cancelled, stillRunning, scrolledOld], baseRows, { hasAfter: false, generation: 'g1' }).map((run) => run.commandId)).toEqual(['cmd2', 'cmd3']);

    // While a reset snapshot is still pending (`windowReady: false`), a new generation does not retire runs early.
    expect(handoff.reconcile([cancelled, stillRunning, scrolledOld], baseRows, { hasAfter: false, generation: 'g2', windowReady: false }).map((run) => run.commandId)).toEqual(['cmd2', 'cmd3']);

    // Once the new generation's snapshot lands (`windowReady: true`), a run that settles later still retires against its origin generation.
    expect(handoff.reconcile([cancelled, stillRunning], baseRows, { hasAfter: false, generation: 'g2', windowReady: true }).map((run) => run.commandId)).toEqual(['cmd2']);
    const settledLater = nativeRun('r2', 'cmd2', 'completed', { delivery: 'observed', nativeMessageId: 'm2' });
    expect(handoff.reconcile([cancelled, settledLater], baseRows, { hasAfter: false, generation: 'g2', windowReady: true })).toEqual([]);

    // Same generation, but the window moved past a terminal run's timestamp (`hasBefore: true`): retires instead of pinning at the foot.
    const handoff2 = new OutboxHandoff();
    expect(handoff2.reconcile([local3], baseRows, { hasAfter: false, generation: 'g1' }).map((run) => run.commandId)).toEqual(['cmd3']);
    const newerPlaced: TimelineRow[] = [{ ...row('later', 4096, 3), event: { ...row('later', 4096, 3).event, createdAt: '2026-10-25T00:05:00Z' } }];
    expect(handoff2.reconcile([scrolledOld], newerPlaced, { hasBefore: true, hasAfter: false, generation: 'g1' })).toEqual([]);
  });
});
