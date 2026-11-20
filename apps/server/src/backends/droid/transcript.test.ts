import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { activityOfEvent } from '../../journal/activity.js';
import { JournalLaneWriter, pullLane } from '../../journal/ingest.js';
import { checkSession, runIngestContract, visibleLanes, type IngestContractFixture } from '../../journal/ingest-contract.js';
import { DRAFT_KIND, Journal, laneKey } from '../../journal/journal.js';
import { parseDroidTranscript, projectDroidChain } from './history.js';
import { DroidTranscriptSource, type DroidLiveFeed, type DroidStreamingBlock } from './transcript.js';

/** A Droid session file as Droid writes it: one record per line, each message naming its parent. */
class SessionFile {
  private seq = 0;
  leaf?: string;

  constructor(readonly path: string, id: string, start: Record<string, unknown> = {}) {
    writeFileSync(path, `${JSON.stringify({ type: 'session_start', id, title: 'Fixture', cwd: '/repo', ...start })}\n`);
  }

  write(...records: unknown[]): this {
    appendFileSync(this.path, records.map(item => `${JSON.stringify(item)}\n`).join(''));
    return this;
  }

  message(id: string, role: string, content: unknown[], visibility?: string): this {
    const seq = this.seq++;
    const parentId = this.leaf;
    this.leaf = id;
    return this.write({ type: 'message', id, ...(parentId ? { parentId } : {}), seq, timestamp: new Date(Date.UTC(2026, 9, 12) + seq * 1000).toISOString(), message: { role, content, ...(visibility ? { visibility } : {}) } });
  }

  prompt(id: string): this {
    return this.message(`context-${id}`, 'user', [{ type: 'text', text: '<system-reminder>' }], 'llm_only').message(id, 'user', [{ type: 'text', text: `question ${id}` }]);
  }

  tool(id: string, name: string, input: Record<string, unknown>, result: unknown): this {
    return this.message(`${id}-call`, 'assistant', [{ type: 'tool_use', id, name, input }])
      .message(`${id}-result`, 'user', [{ type: 'tool_result', tool_use_id: id, content: result }]);
  }

  outcome(turnId: string, reason = 'completed'): this {
    return this.write({ type: 'agent_turn_outcome', turnId, reason });
  }

  turn(id: string, work: (file: this) => void = () => undefined): this {
    this.prompt(id);
    work(this);
    return this.message(`${id}-answer`, 'assistant', [{ type: 'thinking', thinking: 'so' }, { type: 'text', text: `answer ${id}` }]).outcome(id);
  }
}

class FakeFeed implements DroidLiveFeed {
  blocks: DroidStreamingBlock[] = [];
  private readonly wakes = new Set<() => void>();
  signal(): void { for (const wake of this.wakes) wake(); }
  watch(wake: () => void): () => void { this.wakes.add(wake); return () => { this.wakes.delete(wake); }; }
  streaming(): DroidStreamingBlock[] { return this.blocks; }
  running(): Array<{ toolCallId: string; childId: string }> { return []; }
  command(): undefined { return undefined; }
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function scenario() {
  const dir = mkdtempSync(join(tmpdir(), 'riffet-droid-transcript-'));
  dirs.push(dir);
  const feed = new FakeFeed();
  let native = 's1';
  const source = () => new DroidTranscriptSource({ sessionId: 'wb', nativeSessionId: () => native, locate: async id => join(dir, `${id}.jsonl`), live: feed });
  const subagent = (file: SessionFile, toolId: string, childId: string) => {
    new SessionFile(join(dir, `${childId}.jsonl`), childId, { callingSessionId: native, callingToolUseId: toolId })
      .turn(`${childId}-p`, child => child.tool(`${childId}-read`, 'Read', { file_path: '/repo/a.ts' }, 'file'));
    file.tool(toolId, 'Task', { description: 'Explore', prompt: 'Look around', subagent_type: 'worker', await: true }, `session_id: ${childId}\nUse this report.\n## Report\n\nDone`);
  };
  const main = new SessionFile(join(dir, 's1.jsonl'), 's1')
    .turn('u1', file => file.tool('toolu_ls', 'Execute', { command: 'ls' }, 'a.ts'))
    .turn('u2', file => file
      .tool('toolu_todo', 'TodoWrite', { todos: '1. [in_progress] Read notes\n2. [pending] Write summary' }, 'ok')
      .message('notice-1', 'user', [{ type: 'text', text: 'Your standard model budget is exhausted.' }], 'user_only'));
  // Past one pull of bytes, so the first import serves a tail window meanwhile.
  for (let index = 0; index < 10; index += 1) main.turn(`big${index}`, file => file.tool(`toolu_big${index}`, 'Read', { file_path: `/repo/big${index}` }, 'x'.repeat(450 * 1024)));
  // A pid that has exited: the command it started is over.
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  main.turn('u3', file => file
    .tool('toolu_ff', 'Execute', { command: 'npm run dev', fireAndForget: true }, `Background process started (PID: ${pid})\nCommand: npm run dev\nOutput: /tmp/droid-bg-1.out\nStatus: Running in background`)
    .write({ type: 'compaction_state', id: 'compact-1', timestamp: '2026-10-12T01:00:00.000Z', removedCount: 3 }));
  main.turn('u4', file => subagent(file, 'toolu_task1', 'child-1'));
  // A prompt sent while the turn before it still ran; Droid ends both, the older first.
  main.prompt('p1').message('p1-a', 'assistant', [{ type: 'text', text: 'working' }])
    .message('p2', 'user', [{ type: 'text', text: 'also this' }]).message('p2-a', 'assistant', [{ type: 'text', text: 'both done' }])
    .outcome('p1').outcome('p2');
  // A turn Droid died in: no outcome ever names it, and the next one that ends ends it too.
  main.prompt('lost').message('lost-a', 'assistant', [{ type: 'text', text: 'halfway' }]);
  main.turn('after');
  // A run nobody prompted, started by a note only the model sees and named after it.
  main.message('wake-1', 'user', [{ type: 'text', text: 'background finished' }], 'llm_only').message('wake-1-a', 'assistant', [{ type: 'text', text: 'noted' }]).outcome('wake-1');
  // A rewind: the edited prompt continues from where the first one did.
  const fork = main.leaf;
  main.turn('r1');
  main.leaf = fork;
  main.turn('r1b');
  // Droid is in the middle of writing the next line.
  appendFileSync(main.path, '{"type":"session_title_upd');

  let appended = 0;
  const fixture: IngestContractFixture = {
    scratch: true,
    source,
    append: () => {
      appended += 1;
      if (appended === 1) appendFileSync(main.path, 'ated","title":"Renamed"}\n');
      main.turn(`more${appended}`);
      feed.signal();
    },
    // Droid reports a result for a call again; the row is a new version.
    update: () => { main.turn('upd', file => file.message('upd-result', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_ls', content: 'a.ts\nb.ts' }])); },
    terminalTurn: () => { main.turn('typed'); },
    subagent: () => { main.turn('t-sub', file => subagent(file, 'toolu_task2', 'child-2')); },
    changeIdentity: () => { native = 's2'; new SessionFile(join(dir, 's2.jsonl'), 's2').turn('n1'); },
  };
  return { dir, feed, fixture, main, source, pid };
}

async function importAll(source: DroidTranscriptSource, journal: Journal, sessionId = 'wb'): Promise<JournalLaneWriter> {
  const writer = JournalLaneWriter.open(journal, sessionId);
  for (let pulls = 0; !(await pullLane(source, writer, new AbortController().signal)).caughtUp; pulls += 1) expect(pulls).toBeLessThan(20);
  return writer;
}

/** What the v2 history read of the same file shows: each entity once, where it first appears. */
function historyIds(path: string, id: string, main: boolean): string[] {
  const transcript = parseDroidTranscript(readFileSync(path, 'utf8'), path, id);
  return [...new Set(projectDroidChain(transcript, { sessionId: 'wb' }, main ? () => undefined : false).map(event => event.nativeId))];
}

describe('Droid transcript source', () => {
  it('holds the journal write contract', async () => {
    const report = await runIngestContract(scenario().fixture, { sessionId: 'wb' });
    expect(report.served.map(item => item.scratch)).toEqual([true, false]);
    expect(Object.keys(report.lanes).sort()).toEqual(['main']);
  });

  it('writes what the history read shows, in its order, with subagents on their own lanes and activities from the file', async () => {
    const { dir, pid } = scenario();
    const db = new DatabaseSync(':memory:');
    const journal = new Journal(db);
    await importAll(new DroidTranscriptSource({ sessionId: 'wb', nativeSessionId: () => 's1', locate: async id => join(dir, `${id}.jsonl`) }), journal);
    checkSession(journal, 'wb');
    const lanes = visibleLanes(journal, 'wb');
    const activities = journal.entitiesBefore('wb', Number.MAX_SAFE_INTEGER, 10_000).flatMap(entity => activityOfEvent(entity.payload) ?? []);
    expect(activities.map(activity => [activity.id, activity.status])).toEqual([[`droid:bg:${pid}`, 'completed'], ['droid:compaction:compact-1', 'completed']]);
    expect(lanes.main!.map(entity => entity.nativeId).filter(id => !id.startsWith('droid:'))).toEqual(historyIds(join(dir, 's1.jsonl'), 's1', true));
    expect(lanes['sub:toolu_task1']!.map(entity => entity.nativeId)).toEqual(historyIds(join(dir, 'child-1.jsonl'), 'child-1', false));
    // Turns typed while another ran, an unprompted run and a rewound one all end; the rewound one leaves the transcript.
    const ends = journal.range('wb', 0, 100_000).filter(row => row.kind === 'meta.turn_ended').map(row => [row.turnId, (row.payload as { status: string }).status]);
    expect(ends).toEqual(expect.arrayContaining([['p1', 'completed'], ['p2', 'completed'], ['lost', 'interrupted'], ['wake-1', 'completed'], ['r1', 'completed'], ['r1b', 'completed']]));
    expect(lanes.main!.some(entity => entity.nativeId === 'msg:r1' || entity.nativeId === 'turn:r1:end')).toBe(false);
    db.close();
  });

  it('drafts the text Droid is streaming under the id its block commits with', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-droid-transcript-'));
    dirs.push(dir);
    const feed = new FakeFeed();
    const file = new SessionFile(join(dir, 's1.jsonl'), 's1').prompt('u1');
    const source = new DroidTranscriptSource({ sessionId: 'wb', nativeSessionId: () => 's1', locate: async id => join(dir, `${id}.jsonl`), live: feed });
    const db = new DatabaseSync(':memory:');
    const journal = new Journal(db);
    feed.blocks = [{ messageId: 'a1', blockIndex: 1, thought: false, text: 'Hel', at: '2026-10-12T00:00:05.000Z' }];
    const writer = await importAll(source, journal);
    const draft = journal.locate('wb', 'msg:a1:1');
    expect(draft).toMatchObject({ kind: DRAFT_KIND, turnId: 'u1' });
    feed.blocks = [];
    file.message('a1', 'assistant', [{ type: 'thinking', thinking: 'so' }, { type: 'text', text: 'Hello' }]).outcome('u1');
    await pullLane(source, writer, new AbortController().signal);
    expect(journal.entity('wb', 'msg:a1:1')).toMatchObject({ kind: 'agent_message_chunk', identity: draft!.identity, payload: { data: { content: { text: 'Hello' } } } });
    checkSession(journal, 'wb');
    expect(journal.peek(laneKey('wb', 'main'))?.ingestCursor).toContain('"o":');
    db.close();
  });

  it('stamps every event of a turn a workbench run prompted with that run, the streamed text too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-droid-transcript-'));
    dirs.push(dir);
    const feed = new FakeFeed();
    feed.command = ((messageId: string) => messageId === 'u1' ? { commandId: 'c1', runId: 'run-1' } : undefined) as FakeFeed['command'];
    const file = new SessionFile(join(dir, 's1.jsonl'), 's1').prompt('u1').tool('toolu_ls', 'Execute', { command: 'ls' }, 'a.ts');
    const source = new DroidTranscriptSource({ sessionId: 'wb', nativeSessionId: () => 's1', locate: async id => join(dir, `${id}.jsonl`), live: feed });
    const db = new DatabaseSync(':memory:');
    const journal = new Journal(db);
    feed.blocks = [{ messageId: 'a1', blockIndex: 0, thought: false, text: 'Do', at: '2026-10-12T00:00:05.000Z' }];
    const writer = await importAll(source, journal);
    expect(journal.entity('wb', 'msg:a1:0')).toMatchObject({ kind: DRAFT_KIND, payload: { runId: 'run-1' } });
    feed.blocks = [];
    file.message('a1', 'assistant', [{ type: 'text', text: 'Done' }]).outcome('u1').turn('typed');
    await pullLane(source, writer, new AbortController().signal);
    const runOf = (nativeId: string) => (journal.entity('wb', nativeId)?.payload as { runId?: string } | undefined)?.runId;
    expect(['msg:u1', 'tool:toolu_ls', 'tool:toolu_ls:result', 'msg:a1:0', 'turn:u1:end'].map(runOf)).toEqual(['run-1', 'run-1', 'run-1', 'run-1', 'run-1']);
    // A turn typed in Droid itself has no run.
    expect(runOf('msg:typed-answer:1')).toBeUndefined();
    db.close();
  });

  it('ends the turn a Droid process exited in once what it wrote is read, for good across a restart of the reader', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-droid-transcript-'));
    dirs.push(dir);
    const file = new SessionFile(join(dir, 's1.jsonl'), 's1').turn('u1').prompt('u2');
    const source = () => new DroidTranscriptSource({ sessionId: 'wb', nativeSessionId: () => 's1', locate: async id => join(dir, `${id}.jsonl`) });
    const db = new DatabaseSync(':memory:');
    const journal = new Journal(db);
    const writer = await importAll(source(), journal);
    // What the process wrote before it died is read first, then the turn it was in ends with the reason.
    file.message('u2-a', 'assistant', [{ type: 'text', text: 'halfway' }]);
    expect(await source().endOpenTurns(writer, 'failed', '2026-10-12T02:00:00.000Z', 'Droid exited during this turn (1)')).toEqual(['u2']);
    expect(journal.entity('wb', 'msg:u2-a:0')).toBeDefined();
    expect(journal.entity('wb', 'meta:turn:u2:ended')?.payload).toEqual({ turnId: 'u2', status: 'failed', error: 'Droid exited during this turn (1)' });
    // A restarted reader finds nothing open, and an outcome Droid writes later changes nothing.
    const head = journal.peek('wb')!.lastSeq;
    expect(await source().endOpenTurns(JournalLaneWriter.open(journal, 'wb'), 'failed', '2026-10-12T02:00:01.000Z')).toEqual([]);
    file.outcome('u2', 'error');
    await importAll(source(), journal);
    expect(journal.peek('wb')!.lastSeq).toBe(head);
    checkSession(journal, 'wb');
    db.close();
  });

  it('rebuilds and restores retired ancestors when rewinding back onto an earlier branch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-droid-transcript-'));
    dirs.push(dir);
    const file = new SessionFile(join(dir, 's1.jsonl'), 's1').turn('u1');
    const fork = file.leaf;
    file.turn('u2');
    const branchALeaf = file.leaf;
    const source = () => new DroidTranscriptSource({ sessionId: 'wb', nativeSessionId: () => 's1', locate: async id => join(dir, `${id}.jsonl`) });
    const db = new DatabaseSync(':memory:');
    const journal = new Journal(db);
    const writer = await importAll(source(), journal);

    // First rewind: branch B retires u2 in place without rebuilding.
    const gen1 = writer.generation;
    file.leaf = fork;
    file.turn('u3');
    await pullLane(source(), writer, new AbortController().signal);
    expect(writer.generation).toBe(gen1);
    expect(journal.entity('wb', 'msg:u2')?.kind).toBe('tombstone');

    // Second rewind: return to branch A after u2 -> rebuilds cleanly, restores u2 before u4, and stays stable.
    file.leaf = branchALeaf;
    file.turn('u4');
    await pullLane(source(), writer, new AbortController().signal);
    expect(writer.generation).not.toBe(gen1);
    const promptIds = visibleLanes(journal, 'wb').main!.filter(row => row.kind === 'user_message_chunk').map(row => row.nativeId);
    expect(promptIds).toEqual(['msg:u1', 'msg:u2', 'msg:u4']);
    const head = journal.peek('wb')!.lastSeq;
    await pullLane(source(), writer, new AbortController().signal);
    expect(journal.peek('wb')!.lastSeq).toBe(head);
    checkSession(journal, 'wb');
    db.close();
  });
});
