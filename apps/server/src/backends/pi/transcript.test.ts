import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { JournalLaneWriter, pullLane } from '../../journal/ingest.js';
import {
  assertUnchanged, runIngestContract, snapshot, visibleLanes, type IngestContractFixture,
} from '../../journal/ingest-contract.js';
import { DRAFT_KIND, Journal, TOMBSTONE_KIND } from '../../journal/journal.js';
import { parsePiTranscript } from './history.js';
import { projectPiChain } from './projection.js';
import { PiTranscriptSource, type PiLiveFeed, type PiStreamingBlock } from './transcript.js';

/** A pi session file: an append-only tree whose entries name the entry they continue. */
class SessionFile {
  leaf?: string;
  private seq = 0;

  constructor(readonly path: string, id: string) {
    writeFileSync(path, `${JSON.stringify({
      type: 'session', version: 3, id, timestamp: this.time(), cwd: '/repo',
    })}\n`);
  }

  private time(): string {
    return new Date(Date.UTC(2026, 9, 12) + this.seq * 1000).toISOString();
  }

  private add(id: string, type: string, fields: Record<string, unknown>): this {
    const parentId = this.leaf ?? null;
    const timestamp = this.time();
    this.seq += 1;
    this.leaf = id;
    appendFileSync(this.path, `${JSON.stringify({ type, id, parentId, timestamp, ...fields })}\n`);
    return this;
  }

  prompt(id: string): this {
    return this.add(id, 'message', { message: { role: 'user', content: [{ type: 'text', text: `question ${id}` }] } });
  }

  assistant(id: string, content: unknown[], stopReason = 'stop', messageAt?: number): this {
    const timestamp = messageAt ?? Date.parse(this.time());
    return this.add(id, 'message', {
      message: {
        role: 'assistant', content, stopReason, timestamp,
        provider: 'test', model: 'test-model',
      },
    });
  }

  toolResult(id: string, toolCallId: string, text: string): this {
    return this.add(id, 'message', {
      message: { role: 'toolResult', toolCallId, toolName: 'read', content: [{ type: 'text', text }], isError: false },
    });
  }
}

class FakeFeed implements PiLiveFeed {
  blocks: PiStreamingBlock[] = [];
  live?: string;
  commands?: (entryId: string) => { commandId?: string; runId?: string } | undefined;
  private readonly wakes = new Set<() => void>();

  signal(): void { for (const wake of this.wakes) wake(); }

  watch(wake: () => void): () => void {
    this.wakes.add(wake);
    return () => { this.wakes.delete(wake); };
  }

  streaming(): PiStreamingBlock[] { return this.blocks; }
  command(entryId: string): { commandId?: string; runId?: string } | undefined { return this.commands?.(entryId); }
  active(turnId: string): boolean { return turnId === this.live; }
  running(): boolean { return true; }
  superseded(): string[] { return []; }
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'riffet-pi-transcript-'));
  dirs.push(dir);
  return dir;
}

async function importAll(source: PiTranscriptSource, journal: Journal): Promise<JournalLaneWriter> {
  const writer = JournalLaneWriter.open(journal, 'wb');
  const signal = new AbortController().signal;
  for (let pulls = 0; !(await pullLane(source, writer, signal)).caughtUp; pulls += 1) expect(pulls).toBeLessThan(20);
  return writer;
}

describe('pi transcript source', () => {
  it('holds the journal write contract across replay, append, update, terminal drain and identity change', async () => {
    const dir = workspace();
    const feed = new FakeFeed();
    let native = 's1';
    const main = new SessionFile(join(dir, 's1.jsonl'), 's1');
    main.prompt('u1')
      .assistant('a1', [
        { type: 'thinking', thinking: 'plan' },
        { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/repo/a.ts' } },
      ], 'toolUse')
      .toolResult('tr1', 'tc1', 'first')
      .assistant('a1b', [{ type: 'text', text: 'one' }], 'stop')
      .prompt('u2')
      .assistant('a2', [{ type: 'toolCall', id: 'tc2', name: 'read', arguments: { path: '/repo/b.ts' } }], 'toolUse');
    feed.live = 'u2';

    let appended = 0;
    const source = () => new PiTranscriptSource({
      sessionId: 'wb',
      nativeSessionId: () => native,
      locate: async id => join(dir, `${id}.jsonl`),
      live: feed,
    });
    const fixture: IngestContractFixture = {
      source,
      append: () => {
        appended += 1;
        if (appended === 1) {
          main.assistant('a2b', [{ type: 'text', text: 'two' }], 'stop')
            .prompt('u3')
            .assistant('a3', [{ type: 'toolCall', id: 'tc3', name: 'read', arguments: { path: '/repo/c.ts' } }], 'toolUse');
          feed.live = 'u3';
        } else {
          main.assistant('a3b', [{ type: 'text', text: 'three' }], 'stop')
            .prompt('u5')
            .assistant('a5', [{ type: 'text', text: 'five' }], 'stop');
          feed.live = 'u5';
        }
        feed.signal();
      },
      update: () => { main.toolResult('upd', 'tc1', 'updated'); },
      terminalTurn: () => {
        feed.live = undefined;
        main.prompt('u6').assistant('a6', [{ type: 'text', text: 'six' }], 'stop');
      },
      changeIdentity: () => {
        native = 's2';
        new SessionFile(join(dir, 's2.jsonl'), 's2').prompt('n1').assistant('n1a', [{ type: 'text', text: 'native' }], 'stop');
      },
    };

    const report = await runIngestContract(fixture, { sessionId: 'wb', openLastTurn: true });
    expect(report.served.map(item => item.scratch)).toEqual([false]);
    expect(report.lanes.main).toBeGreaterThan(0);
  });

  it('serves the active branch after a rewind and retires the branch it left, with stable native ids', async () => {
    const dir = workspace();
    const feed = new FakeFeed();
    const main = new SessionFile(join(dir, 's1.jsonl'), 's1');
    main.prompt('u1').assistant('a1', [{ type: 'text', text: 'one' }], 'stop')
      .prompt('u2').assistant('a2', [{ type: 'text', text: 'two' }], 'stop');
    const source = () => new PiTranscriptSource({
      sessionId: 'wb',
      nativeSessionId: () => 's1',
      locate: async id => join(dir, `${id}.jsonl`),
      live: feed,
    });

    const db = new DatabaseSync(':memory:');
    const journal = new Journal(db);
    const writer = await importAll(source(), journal);
    expect(visibleLanes(journal, 'wb').main!.map(entity => entity.nativeId))
      .toEqual(['msg:u1', 'msg:a1:0', 'turn:u1:end', 'msg:u2', 'msg:a2:0', 'turn:u2:end']);

    // An edited prompt continues from a1, so u2 and its answer leave the active branch.
    main.leaf = 'a1';
    main.prompt('u3').assistant('a3', [{ type: 'text', text: 'three' }], 'stop');
    await pullLane(source(), writer, new AbortController().signal);

    const transcript = parsePiTranscript(readFileSync(main.path, 'utf8'), main.path, 's1');
    const expected = projectPiChain(transcript, { sessionId: 'wb' }, () => ({})).map(event => event.nativeId);
    expect(visibleLanes(journal, 'wb').main!.map(entity => entity.nativeId)).toEqual(expected);
    expect(journal.locate('wb', 'msg:u2')?.kind).toBe(TOMBSTONE_KIND);
    expect(journal.locate('wb', 'turn:u2:end')?.kind).toBe(TOMBSTONE_KIND);

    const before = snapshot(journal, 'wb');
    await importAll(source(), journal);
    assertUnchanged(before, snapshot(journal, 'wb'), 'a replay after a rewind');
    db.close();
  });

  it('streams before the file or prompt exists, replaces the draft from the assistant message time, and keeps a partial line out', async () => {
    const dir = workspace();
    const feed = new FakeFeed();
    const file = join(dir, 's1.jsonl');
    const block: PiStreamingBlock = {
      key: 'wb:live:0:0:text', contentIndex: 0, thought: false, text: 'Hel',
      at: '2026-10-12T00:00:05.000Z', messageTimestamp: Date.parse('2026-10-12T00:00:04.000Z'),
    };
    feed.blocks = [block];
    const source = new PiTranscriptSource({
      sessionId: 'wb',
      nativeSessionId: () => 's1',
      locate: async () => file,
      live: feed,
    });
    feed.commands = entryId => entryId === 'u1' ? { commandId: 'c1', runId: 'run-1' } : undefined;

    const db = new DatabaseSync(':memory:');
    const journal = new Journal(db);
    const writer = JournalLaneWriter.open(journal, 'wb');
    const signal = new AbortController().signal;

    // pi streams before it writes a session file.
    await pullLane(source, writer, signal);
    expect(journal.locate('wb', 'draft:wb:live:0:0:text')?.kind).toBe(DRAFT_KIND);

    const session = new SessionFile(file, 's1');
    feed.live = 'u1';
    session.prompt('u1');
    await pullLane(source, writer, signal);
    expect(journal.locate('wb', 'draft:wb:live:0:0:text')).toMatchObject({ kind: DRAFT_KIND, turnId: 'u1' });

    // The final entry may reach the file before the runtime tags the block with its entry id; the
    // assistant message time still retires the draft, and a stale block must not republish it.
    session.assistant('a1', [{ type: 'text', text: 'Hello' }], 'stop', block.messageTimestamp);
    await pullLane(source, writer, signal);
    expect(journal.locate('wb', 'draft:wb:live:0:0:text')?.kind).toBe(TOMBSTONE_KIND);
    expect(visibleLanes(journal, 'wb').main!.some(entity => entity.nativeId.startsWith('draft:'))).toBe(false);
    expect(journal.entity('wb', 'msg:a1:0')).toMatchObject({ kind: 'agent_message_chunk', payload: { data: { content: { type: 'text', text: 'Hello' } } } });

    // A line pi is still writing is not an entry until its newline reaches the file.
    feed.blocks = [];
    appendFileSync(file, JSON.stringify({
      type: 'message', id: 'a2', parentId: 'a1', timestamp: '2026-10-12T00:00:06.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'stop', timestamp: Date.parse('2026-10-12T00:00:06.000Z') },
    }));
    await pullLane(source, writer, signal);
    expect(journal.entity('wb', 'msg:a2:0')).toBeUndefined();
    appendFileSync(file, '\n');
    await pullLane(source, writer, signal);
    expect(journal.entity('wb', 'msg:a2:0')).toBeDefined();

    // The prompt's command survives the open turn ending: its outcome names the run it belongs to.
    expect(await source.endOpenTurns(writer, 'failed', '2026-10-12T00:01:00.000Z', 'pi exited')).toEqual(['u1']);
    expect(journal.entity('wb', 'turn:u1:end')?.payload).toMatchObject({
      runId: 'run-1', data: { commandId: 'c1', error: 'pi exited' },
    });
    db.close();
  });
});
