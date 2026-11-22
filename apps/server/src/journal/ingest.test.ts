import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeWorkbenchEvent } from '../../../../packages/contracts/src/index.js';
import { Store } from '../store.js';
import { activityId } from './activity.js';
import { JOURNAL_PAYLOAD_LIMIT, Journal, type JournalAppend } from './journal.js';
import { hasTurnEnded, JournalLaneWriter, turnMetaId, type LaneBatch, type LaneWriter, type TranscriptSource, type TurnEndStatus } from './ingest.js';
import { JournalFeed, type TurnMark } from './feed.js';
import { runIngestContract, type IngestContractFixture } from './ingest-contract.js';

/*
 * A transcript shaped like the CLIs': lines appended to a file, a message streamed in chunks before it
 * settles, a tool whose result arrives later under the tool's id, background tasks, and subagents that
 * write a transcript of their own. The source reads it by line offset, the way a JSONL reader does.
 */
type Line =
  | { kind: 'user' | 'assistant' | 'partial'; id: string; turn: string; text: string }
  | { kind: 'tool'; id: string; turn: string; output?: string; agent?: string }
  | { kind: 'task'; id: string; turn: string; status: 'running' | 'completed'; started: number }
  | { kind: 'end'; turn: string; status: TurnEndStatus };

class FakeTranscript {
  identity = 'conv-1';
  lines: Line[] = [];
  readonly agents = new Map<string, Line[]>();
  private readonly watchers = new Set<() => void>();
  push(...lines: Line[]): void { this.lines.push(...lines); for (const wake of this.watchers) wake(); }
  watch(wake: () => void): () => void { this.watchers.add(wake); return () => { this.watchers.delete(wake); }; }
}

/** A long transcript opens with a tail window; reads are bounded so an import takes several. */
const TAIL_OVER = 30, TAIL_LINES = 12, PULL_LINES = 25, COMMIT_EVENTS = 7;
const stamp = (index: number) => new Date(Date.UTC(2026, 9, 1) + index * 1000).toISOString();

class FakeSource implements TranscriptSource {
  constructor(private readonly native: FakeTranscript, private readonly ids: (line: Line & { id: string }, index: number, from: number) => string = line => line.id) {}

  identity(): string { return this.native.identity; }

  async pull(w: LaneWriter): Promise<{ caughtUp: boolean }> {
    await Promise.resolve();
    const lines = this.native.lines;
    if (w.cursor === null && !w.scratch && lines.length > TAIL_OVER) {
      // The window starts at a turn's first line, so every turn in it is whole.
      let start = lines.length - TAIL_LINES;
      while (start > 0 && lines[start]!.kind !== 'user') start -= 1;
      this.read(w.openScratch(), lines, start, lines.length);
    } else if (w.scratch) this.read(w.scratch, lines, Number(w.scratch.cursor), lines.length);
    const from = Number(w.cursor ?? 0), to = Math.min(lines.length, from + PULL_LINES);
    this.read(w, lines, from, to);
    return { caughtUp: to >= lines.length };
  }

  watch(_w: LaneWriter, wake: () => void): () => void { return this.native.watch(wake); }

  async drain(w: LaneWriter): Promise<void> {
    const target = w.scratch ?? w;
    this.read(target, this.native.lines, Number(target.cursor ?? 0), this.native.lines.length);
  }

  protected event(line: Line & { id: string }, id: string, index: number): NativeWorkbenchEvent {
    const base = { sequence: 0, sessionId: 'unused', nativeId: id, nativeTurnId: line.turn, createdAt: stamp(index), raw: line };
    if (line.kind === 'tool') return { ...base, type: 'tool_call', data: { toolCallId: line.id, status: line.output === undefined ? 'pending' : 'completed', ...(line.output !== undefined ? { content: { type: 'text', text: line.output } } : {}) } };
    return { ...base, type: line.kind === 'user' ? 'user_message_chunk' : 'agent_message_chunk', data: { content: { type: 'text', text: 'text' in line ? line.text : '' } } };
  }

  private read(w: LaneWriter, lines: readonly Line[], from: number, to: number): void {
    let batch: LaneBatch = { events: [], drafts: [], cursor: String(from) };
    // Commits what was read before `at`; anything written outside a commit comes after it.
    const flush = (at: number) => {
      if (batch.events.length || batch.drafts!.length || String(at) !== w.cursor) w.commit({ ...batch, cursor: String(at) });
      batch = { events: [], drafts: [], cursor: String(at) };
    };
    for (let index = from; index < to; index += 1) {
      const line = lines[index]!;
      if (line.kind === 'end') { flush(index); w.turnEnded(line.turn, line.status, stamp(index)); continue; }
      if (line.kind === 'task') {
        flush(index);
        w.activities.apply({
          id: activityId('fake', line.id), kind: 'background_task', status: line.status, title: line.id, startedAt: stamp(line.started),
          ...(line.status === 'completed' ? { endedAt: stamp(index) } : {}), task: { kind: 'shell' },
        });
        continue;
      }
      if (line.kind === 'user') { flush(index); w.turnStarted(line.turn, stamp(index)); }
      const event = this.event(line, this.ids(line, index, from), index);
      if (line.kind === 'partial') batch.drafts!.push({ finalId: event.nativeId, event });
      else batch.events.push(event);
      if (line.kind === 'tool' && line.agent) {
        flush(index + 1);
        const child = w.child(line.id, line.agent);
        const agentLines = this.native.agents.get(line.agent) ?? [];
        this.read(child, agentLines, Number(child.cursor ?? 0), agentLines.length);
      } else if (batch.events.length + batch.drafts!.length >= COMMIT_EVENTS) flush(index + 1);
    }
    flush(to);
  }
}

/** A whole turn; with `streamed`, its answer was read once while still streaming. */
const turn = (id: string, extra: Line[] = [], streamed = false): Line[] => [
  { kind: 'user', id: `u-${id}`, turn: id, text: `question ${id}` },
  ...extra,
  ...(streamed ? [{ kind: 'partial' as const, id: `a-${id}`, turn: id, text: 'ans' }] : []),
  { kind: 'assistant', id: `a-${id}`, turn: id, text: `answer ${id}` },
  { kind: 'end', turn: id, status: 'completed' },
];

/** Visible ids of `lines` in transcript order: where each entity first appears. */
function orderOf(lines: readonly Line[]): string[] {
  const ids: string[] = [];
  for (const line of lines) {
    const id = line.kind === 'end' ? undefined : line.kind === 'task' ? activityId('fake', line.id) : line.id;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function fakeFixture(native = new FakeTranscript(), make: (native: FakeTranscript) => TranscriptSource = value => new FakeSource(value)): IngestContractFixture {
  native.agents.set('agent-1', turn('agent-1:t1', [{ kind: 'tool', id: 'agent-1:read', turn: 'agent-1:t1', output: 'file' }]));
  for (let index = 1; index <= 9; index += 1) {
    const id = `t${index}`;
    const extra: Line[] = [];
    if (index === 2) extra.push({ kind: 'tool', id: 'tool-t2', turn: id });
    if (index === 3) extra.push({ kind: 'tool', id: 'tool-big', turn: id, output: 'x'.repeat(JOURNAL_PAYLOAD_LIMIT + 100) }, { kind: 'task', id: 'job', turn: id, status: 'running', started: 0 });
    if (index === 5) extra.push({ kind: 'task', id: 'job', turn: id, status: 'completed', started: 0 });
    if (index === 8) extra.push({ kind: 'tool', id: 'tool-agent-1', turn: id, agent: 'agent-1' });
    native.lines.push(...turn(id, extra, index % 2 === 0));
  }
  let appended = 0;
  return {
    scratch: true,
    source: () => make(native),
    append: () => { appended += 1; native.push(...turn(`more${appended}`)); },
    update: () => native.push({ kind: 'tool', id: 'tool-t2', turn: 't2', output: 'settled' }, { kind: 'assistant', id: 'a-t1', turn: 't1', text: 'edited' }),
    terminalTurn: () => native.push(...turn('typed')),
    subagent: () => {
      native.agents.set('agent-2', turn('agent-2:t1'));
      native.push(...turn('t-sub', [{ kind: 'tool', id: 'tool-agent-2', turn: 't-sub', agent: 'agent-2' }]));
    },
    changeIdentity: () => { native.identity = 'conv-2'; native.lines = turn('n1'); native.agents.clear(); },
    order: () => {
      const lanes: Record<string, string[]> = { main: orderOf(native.lines) };
      for (const line of native.lines) if (line.kind === 'tool' && line.agent) lanes[`sub:${line.id}`] = orderOf(native.agents.get(line.agent) ?? []);
      return lanes;
    },
  };
}

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('ingest contract', () => {
  it('holds for a source that keys rows by native ids and reads from the committed cursor', async () => {
    const report = await runIngestContract(fakeFixture());
    expect(report.served.map(item => item.scratch)).toEqual([true, false]);
    expect(Object.keys(report.lanes)).toEqual(['main']);
  });

  it('rejects ids taken from read positions, which move when a read starts somewhere else', async () => {
    const positional = (native: FakeTranscript) => new FakeSource(native, (_line, index, from) => `row:${index - from}`);
    // Without the fixture's own expectations: the comparison with a fresh import alone has to catch it.
    await expect(runIngestContract({ ...fakeFixture(new FakeTranscript(), positional), order: undefined })).rejects.toThrow(/G2\/G7/);
  });

  it('rejects an event outside any turn', async () => {
    class Turnless extends FakeSource {
      protected override event(line: Line & { id: string }, id: string, index: number): NativeWorkbenchEvent {
        const event = super.event(line, id, index);
        return line.kind === 'assistant' ? { ...event, nativeTurnId: undefined } : event;
      }
    }
    await expect(runIngestContract(fakeFixture(new FakeTranscript(), native => new Turnless(native)))).rejects.toThrow(/G3/);
  });

  it('rejects an unexpected rebuild during normal non-identity steps even when rows match a fresh import', async () => {
    class RebuildingDrain extends FakeSource {
      override async drain(w: LaneWriter): Promise<void> {
        w.rebuild('identity-changed');
        await super.drain(w);
      }
    }
    await expect(runIngestContract(fakeFixture(new FakeTranscript(), native => new RebuildingDrain(native)))).rejects.toThrow(/G8/);
  });
});

describe('lane writer', () => {
  const event = (id: string, turnId = 't1'): NativeWorkbenchEvent => ({ sequence: 0, sessionId: 's', type: 'agent_message_chunk', nativeId: id, nativeTurnId: turnId, createdAt: stamp(0), data: { content: { type: 'text', text: id } } });

  it('persists a retracted end and replays only the latest outcome across a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'riffet-ingest-'));
    dirs.push(dir);
    const path = join(dir, 'workbench.db');
    let store = new Store(path);
    let main = JournalLaneWriter.open(store.journal, 's');
    let feed = new JournalFeed(store.journal);
    const marks: TurnMark[] = [];
    feed.subscribe(() => true, batch => marks.push(...batch.items.flatMap(item => 'mark' in item ? [item.mark] : [])));
    main.turnReopened('t1', stamp(0));
    expect(store.journal.peek('s')).toBeUndefined();
    main.turnStarted('t1', stamp(0));
    main.turnStarted('t1', stamp(0), 'r1');
    main.turnStarted('t1', stamp(0));
    main.commit({ events: [event('a1')], cursor: 'closed' });
    main.turnEnded('t1', 'interrupted', stamp(1));
    const generation = main.generation;
    expect(store.journal.projection('s').turns[0]?.status).toBe('cancelled');
    main.turnReopened('t1', stamp(2), 'open');
    const lastSeq = store.journal.peek('s')!.lastSeq;
    main.turnReopened('t1', stamp(3), 'open');
    expect(store.journal.peek('s')).toMatchObject({ generation, lastSeq, ingestCursor: 'open' });
    expect(store.journal.entity('s', turnMetaId('t1', 'ended'))).toMatchObject({ kind: 'tombstone', turnId: 't1', at: stamp(2), rev: 2 });
    expect(main.turnEndStatus('t1')).toBeUndefined();
    expect(hasTurnEnded(store.journal, 's', 't1')).toBe(false);
    main.commit({ events: [], retire: ['a1'], cursor: 'open' });
    await feed.delivered();
    expect(marks.map(mark => [mark.edge, mark.revision, mark.runId])).toEqual([['started', 2, 'r1'], ['reopened', 2, undefined]]);
    const projection = store.journal.projection('s');
    expect(projection).toMatchObject({ state: 'running', activeTurnId: 't1', turns: [{ turnId: 't1', status: 'running' }] });
    expect(projection.turns[0]).not.toHaveProperty('endSeq');
    expect(projection.turns[0]).not.toHaveProperty('endedAt');
    feed.close();
    store.close();

    store = new Store(path);
    main = JournalLaneWriter.open(store.journal, 's');
    feed = new JournalFeed(store.journal);
    expect(main.cursor).toBe('open');
    expect(main.generation).toBe(generation);
    expect(store.journal.rebuildProjection('s')).toEqual(projection);
    expect(feed.recent('s', 'main', 100).items.filter(item => 'mark' in item).map(item => item.mark.edge)).toEqual(['started', 'reopened']);
    main.turnEnded('t1', 'completed', stamp(4));
    expect(main.turnEndStatus('t1')).toBe('completed');
    expect(feed.recent('s', 'main', 100).items.filter(item => 'mark' in item).map(item => [item.mark.edge, item.mark.revision, item.mark.status])).toEqual([['started', 2, undefined], ['ended', 3, 'completed']]);
    expect(store.journal.projection('s').turns[0]).toMatchObject({ status: 'completed', endedAt: stamp(4) });
    feed.close();
    store.close();
  });

  it('reports what each lane gained once the transaction commits, and nothing of one that rolled back', () => {
    const store = new Store(':memory:');
    const changes: JournalAppend[] = [];
    store.journal.onAppend(change => changes.push(change));
    const main = JournalLaneWriter.open(store.journal, 's');
    store.transaction(() => {
      main.commit({ events: [event('a'), event('b')], cursor: '1' });
      main.child('call/1', 'agent').commit({ events: [event('c', 'sub-t1')], cursor: '1' });
      main.commit({ events: [event('d')], cursor: '2' });
      expect(changes).toEqual([]);
    });
    const generation = main.generation;
    // turn_started, a, b, meta.subagent, d in one range; the subagent's own lane numbers from 1.
    expect(changes).toEqual([
      { sessionId: 's', lane: 'main', scratch: false, generation, fromSeq: 1, toSeq: 5 },
      { sessionId: 's', lane: 'sub:call/1', scratch: false, generation: store.journal.peek('s#sub:call%2F1')!.generation, fromSeq: 1, toSeq: 2 },
    ]);
    changes.length = 0;
    expect(() => store.transaction(() => { main.commit({ events: [event('e')], cursor: '3' }); throw new Error('fault'); })).toThrow('fault');
    expect(changes).toEqual([]);
    expect(main.cursor).toBe('2');
    // Replaying what is committed writes nothing and reports nothing.
    main.commit({ events: [event('a'), event('d')], cursor: '2' });
    expect(changes).toEqual([]);
    main.rebuild('identity-changed');
    expect(changes.map(change => [change.lane, change.reset])).toEqual([['sub:call/1', 'dropped'], ['main', 'rebuilt']]);
    expect(main.generation).not.toBe(generation);
    store.close();
  });

  it('discards uncommitted activity and turn caches when an enclosing store transaction rolls back', () => {
    const store = new Store(':memory:');
    const writer = JournalLaneWriter.open(store.journal, 's');
    writer.turnStarted('original', stamp(0));
    const activity = { id: 'claude:review', kind: 'background_task', task: { kind: 'agent' }, title: 'Review', status: 'completed', startedAt: stamp(1), endedAt: stamp(2) } as const;
    expect(() => store.transaction(() => {
      writer.transaction(() => { writer.turnStarted('uncommitted', stamp(1)); writer.activities.apply(activity); });
      throw new Error('outer rollback');
    })).toThrow('outer rollback');
    expect(writer.activities.get(activity.id)).toBeUndefined();
    expect(store.journal.entity('s', activity.id)).toBeUndefined();
    writer.transaction(() => writer.activities.apply(activity));
    expect(store.journal.entity('s', activity.id)?.turnId).toBe('original');
    expect(store.journal.entity('s', activity.id)?.rev).toBe(1);
    store.close();
  });

  it('carries live activities, compaction evidence and subagent bindings across a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'riffet-ingest-'));
    dirs.push(dir);
    const path = join(dir, 'workbench.db');
    const task = { id: activityId('fake', 'job'), kind: 'background_task' as const, status: 'running' as const, title: 'job', startedAt: stamp(0), stop: { via: 'protocol' as const } };
    let store = new Store(path);
    let main = JournalLaneWriter.open(store.journal, 's');
    main.commit({ events: [event('a')], cursor: '1' });
    main.activities.apply(task);
    main.activities.apply({ id: activityId('fake', 'done'), kind: 'background_task', status: 'completed', title: 'done', startedAt: stamp(0) });
    const compacted = main.activities.apply({ id: activityId('fake', 'compaction'), kind: 'compaction', status: 'completed', title: 'compaction', startedAt: stamp(0), endedAt: stamp(2), detail: 'Durable summary', compaction: { trigger: 'auto', preTokens: 100, postTokens: 40 } });
    const uncertain = main.activities.apply({ id: activityId('fake', 'uncertain'), kind: 'compaction', status: 'unknown', title: 'compaction', startedAt: stamp(0), endedAt: stamp(2), detail: 'Retained summary' });
    main.child('call-1', 'agent-1', { title: 'Explore the repo', subagentType: 'Explore' });
    store.close();

    store = new Store(path);
    main = JournalLaneWriter.open(store.journal, 's');
    // Ended compactions retain their evidence without becoming live or being written again.
    const lastSeq = store.journal.head('s').lastSeq;
    expect(main.activities.get(compacted.id)).toEqual(compacted);
    expect(store.journal.head('s').lastSeq).toBe(lastSeq);
    // A stop and an end apply to the live execution as they would have before.
    expect(main.activities.live().map(activity => activity.id)).toEqual([task.id]);
    expect(main.activities.get(uncertain.id)).toEqual(uncertain);
    const recovered = main.activities.apply({ ...uncertain, status: 'running', endedAt: undefined, durationMs: undefined });
    expect(recovered).toMatchObject({ status: 'running', startedAt: stamp(0), detail: 'Retained summary' });
    expect(recovered.endedAt).toBeUndefined();
    expect(recovered.durationMs).toBeUndefined();
    main.activities.apply({ ...recovered, status: 'completed' }, new Date(stamp(7)));
    expect(main.activities.get(uncertain.id)).toMatchObject({ endedAt: stamp(7), durationMs: 7000 });
    expect(main.activities.beginStop(task.id).activity.status).toBe('stopping');
    main.activities.apply({ id: task.id, status: 'stopped' } as never, new Date(stamp(5)));
    const ended = store.journal.entity('s', task.id)!.payload as { data: { activity: Record<string, unknown> } };
    expect(ended.data.activity).toMatchObject({ title: 'job', status: 'stopped', startedAt: stamp(0), endedAt: stamp(5), durationMs: 5000 });
    // Evict the old in-memory evidence without discarding its durable confirmation.
    for (let index = 0; index < 501; index++) main.activities.apply({ id: `later-compact-${index}`, kind: 'compaction', title: 'compact', status: 'completed', startedAt: stamp(0), endedAt: stamp(1) });
    expect(main.activities.list().some(activity => activity.id === compacted.id)).toBe(false);
    const afterEviction = store.journal.head('s').lastSeq;
    expect(main.activities.get(compacted.id)).toEqual(compacted);
    expect(store.journal.head('s').lastSeq).toBe(afterEviction);
    // A reader that only knows the ids keeps what was recorded of the subagent; one that knows more adds it.
    main.child('call-1', 'agent-1');
    main.child('call-1', 'agent-1', { model: 'fast' });
    expect(store.journal.entity('s', 'meta:subagent:call-1')!.payload).toEqual({ toolCallId: 'call-1', agentId: 'agent-1', lane: 'sub:call-1', title: 'Explore the repo', subagentType: 'Explore', model: 'fast' });
    store.close();
  });

  it('adds the head identity to a v1 journal in place, keeping its rows and generation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'riffet-ingest-'));
    dirs.push(dir);
    const path = join(dir, 'workbench.db');
    let db = new DatabaseSync(path);
    new Journal(db).append('s', [{ kind: 'x', nativeId: 'a', payload: {} }], { cursor: 'c' });
    db.exec(`ALTER TABLE journal_heads DROP COLUMN identity; UPDATE settings SET json='1' WHERE key='journal-schema'`);
    const { generation } = db.prepare('SELECT generation FROM journal_heads WHERE session_id=?').get('s') as { generation: string };
    db.close();
    for (let open = 0; open < 2; open += 1) {
      db = new DatabaseSync(path);
      const journal = new Journal(db);
      const writer = JournalLaneWriter.open(journal, 's');
      // A log written before identities were recorded adopts the first one without starting over.
      writer.bindIdentity('thread-1');
      expect(journal.peek('s')).toMatchObject({ generation, lastSeq: 1, ingestCursor: 'c', identity: 'thread-1' });
      db.close();
    }
  });
});
