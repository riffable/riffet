import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../store.js';
import { JOURNAL_PAYLOAD_LIMIT, Journal, JournalGenerationChanged } from './journal.js';
import { OUTLINE_TURNS, projectedActivity } from './projection.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function dbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'riffet-journal-'));
  dirs.push(dir);
  return join(dir, 'workbench.db');
}
const event = (nativeId: string, text: string, extra: Record<string, unknown> = {}) => ({
  kind: 'agent_message_chunk', nativeId, turnId: 't1', payload: { type: 'agent_message_chunk', nativeId, data: { content: { type: 'text', text } } }, ...extra,
});

describe('session journal', () => {
  it('subtracts a retired turn outside the outline window once, including after a projection rebuild', () => {
    const db = new DatabaseSync(':memory:');
    const journal = new Journal(db);
    try {
      const count = OUTLINE_TURNS + 2;
      journal.append('s', Array.from({ length: count }, (_, index) => [
        { kind: 'meta.turn_started', nativeId: `meta:turn:t${index}:started`, turnId: `t${index}`, payload: { turnId: `t${index}` } },
        { kind: 'meta.turn_ended', nativeId: `meta:turn:t${index}:ended`, turnId: `t${index}`, payload: { turnId: `t${index}`, status: 'completed' } },
      ]).flat());
      expect(journal.projection('s')).toMatchObject({ turnCount: count, state: 'idle' });
      journal.append('s', [{ kind: 'tombstone', nativeId: 'meta:turn:t0:started', payload: {} }]);
      const repaired = journal.projection('s');
      expect(repaired).toMatchObject({ turnCount: count - 1, state: 'idle' });
      expect(journal.rebuildProjection('s')).toEqual(repaired);
      journal.append('s', [{ kind: 'tombstone', nativeId: 'meta:turn:t0:started', payload: { retired: true } }]);
      expect(journal.projection('s').turnCount).toBe(count - 1);
    } finally { db.close(); }
  });

  it('commits a batch with its cursor atomically, and a failed batch leaves neither rows nor cursor', async () => {
    const journal = new Journal(new DatabaseSync(':memory:'));
    journal.append('s', [event('a', 'one')], { cursor: 'c1' });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => journal.append('s', [event('b', 'two'), { kind: 'x', nativeId: 'bad', payload: circular }], { cursor: 'c2' })).toThrow();
    const head = journal.peek('s')!;
    expect(head.ingestCursor).toBe('c1');
    expect(head.lastSeq).toBe(1);
    expect(journal.range('s', 0, 10).map(row => row.nativeId)).toEqual(['a']);
    // Re-running the failed read after the fault writes b once, and a (already logged) not at all.
    journal.append('s', [event('a', 'one'), event('b', 'two')], { cursor: 'c2' });
    expect(journal.range('s', 0, 10).map(row => [row.seq, row.nativeId])).toEqual([[1, 'a'], [2, 'b']]);
    expect(journal.peek('s')!.ingestCursor).toBe('c2');
  });

  it('numbers rows from 1 without gaps, and keeps both numbers and generation across a reopen', async () => {
    const path = await dbPath();
    let store = new Store(path);
    const first = store.journal.append('s', [event('a', '1'), event('b', '2'), event('c', '3')]);
    expect(first.rows.map(row => row.seq)).toEqual([1, 2, 3]);
    const generation = store.journal.peek('s')!.generation;
    store.close();
    store = new Store(path);
    const more = store.journal.append('s', [event('d', '4'), event('a', '1')]);
    // `a` is unchanged and writes nothing; `d` continues the numbering.
    expect(more.rows.map(row => [row.nativeId, row.seq, row.written])).toEqual([['d', 4, true], ['a', 1, false]]);
    expect(store.journal.peek('s')!.generation).toBe(generation);
    expect(store.journal.range('s', 0, 10).map(row => row.seq)).toEqual([1, 2, 3, 4]);
    // The only way to change the generation is to rebuild, which starts numbering over.
    expect(store.journal.rebuild('s').generation).not.toBe(generation);
    expect(() => store.journal.append('s', [event('z', 'z')], { generation })).toThrow(JournalGenerationChanged);
    store.close();
  });

  it('records an update as a new version of the same entity and never rewrites the old row', () => {
    const journal = new Journal(new DatabaseSync(':memory:'));
    journal.append('s', [event('tool', 'running'), event('next', 'after')]);
    journal.append('s', [event('tool', 'done')]);
    const rows = journal.range('s', 0, 10);
    expect(rows.map(row => [row.seq, row.nativeId, row.rev])).toEqual([[1, 'tool', 1], [2, 'next', 1], [3, 'tool', 2]]);
    expect((rows[0]!.payload as { data: { content: { text: string } } }).data.content.text).toBe('running');
    // A transcript shows the latest version where the entity first appeared.
    const view = journal.tail('s', 10);
    expect(view.map(entity => [entity.identity, entity.nativeId, (entity.payload as { data: { content: { text: string } } }).data.content.text])).toEqual([[1, 'tool', 'done'], [2, 'next', 'after']]);
    expect(journal.locate('s', 'tool')).toMatchObject({ identity: 1, rev: 2, seq: 3 });
  });

  it('retains unsynced child data when removing a duplicate log', () => {
    const journal = new Journal(new DatabaseSync(':memory:'));
    journal.setIdentity('alias', 'child-1');
    journal.setIdentity('canonical', 'child-1');
    journal.append('alias', [event('known', 'First result'), event('missing', 'Later result')]);
    journal.append('canonical', [event('known', 'First result')]);
    journal.dropIfCopied('alias', 'canonical');
    expect(journal.entity('alias', 'missing')?.payload).toMatchObject({ data: { content: { text: 'Later result' } } });
    journal.append('canonical', [event('missing', 'Later result')]);
    journal.dropIfCopied('alias', 'canonical');
    expect(journal.peek('alias')).toBeUndefined();
    expect(journal.tail('canonical', 10)).toHaveLength(2);
  });

  it('stores an oversized payload once, as a blob, and reads it back whole', () => {
    const journal = new Journal(new DatabaseSync(':memory:'));
    const big = 'x'.repeat(JOURNAL_PAYLOAD_LIMIT + 1000);
    journal.append('s', [event('one', big), event('two', big)]);
    // The same content in another log (a fork, or this log after a rebuild) shares the stored bytes.
    journal.append('other', [event('one', big)]);
    expect(journal.stats().blobs).toBe(2);
    const generation = journal.peek('s')!.generation;
    journal.rebuild('s');
    journal.append('s', [event('one', big)]);
    expect(journal.peek('s')!.generation).not.toBe(generation);
    expect(journal.stats().blobs).toBe(2);
    const [row] = journal.range('s', 0, 1);
    expect(row!.blobRef).toBeDefined();
    expect((row!.payload as { data: { content: { text: string } } }).data.content.text).toBe(big);
    // Rows keep only a bounded preview inline.
    expect(journal.stats('s').payloadBytes).toBeLessThan(10_000);
    journal.drop('s'); journal.drop('other');
    expect(journal.sweepBlobs()).toBe(2);
  });

  it('empties superseded draft chunks and their blobs without moving any number, and pages deep history by cursor', () => {
    const journal = new Journal(new DatabaseSync(':memory:'));
    const big = 'x'.repeat(JOURNAL_PAYLOAD_LIMIT + 10);
    journal.append('s', [{ ...event('m', big), kind: 'draft' }]);
    journal.append('s', [{ ...event('m', big + 'y'), kind: 'draft' }]);
    const before = journal.range('s', 0, 10).map(row => [row.seq, row.rev, row.digest]);
    // Still streaming: the newest chunk is the draft, nothing is superseded by a committed version yet.
    expect(journal.maintain().drafts).toBe(0);
    expect(journal.tail('s', 10)).toEqual([]);
    expect(journal.tail('s', 10, true)).toMatchObject([{ kind: 'draft', identity: 1, seq: 2, payload: { data: { content: { text: big + 'y' } } } }]);
    journal.append('s', [event('m', 'final')]);
    expect(journal.maintain()).toEqual({ drafts: 2, blobs: 2 });
    const rows = journal.range('s', 0, 10);
    expect(rows.slice(0, 2).map(row => [row.seq, row.rev, row.digest])).toEqual(before);
    expect(rows.map(row => row.seq)).toEqual([1, 2, 3]);
    expect(journal.entity('s', 'm')).toMatchObject({ identity: 1, seq: 3 });
    for (let index = 0; index < 150; index += 1) {
      journal.append('s', [event(`h${index}`, 'x'), { kind: 'meta.turn_started', nativeId: `meta${index}`, payload: {} }]);
    }
    const page = journal.entitiesBefore('s', Number.MAX_SAFE_INTEGER, 100);
    expect(page).toHaveLength(100);
    expect(page.at(-1)!.nativeId).toBe('h149');
    expect(journal.entitiesBefore('s', 2, 10).map(entity => entity.nativeId)).toEqual(['m']);
    expect(journal.hasEntitiesBefore('s', 1)).toBe(false);
  });

  it('folds a projection as of a seq, catches it up from the log, and rebuilds one the log does not support', () => {
    const journal = new Journal(new DatabaseSync(':memory:'));
    const turn = (id: string, text: string) => [
      { kind: 'meta.turn_started', nativeId: `s:${id}`, turnId: id, payload: { turnId: id } },
      { kind: 'user_message_chunk', nativeId: `u:${id}`, turnId: id, payload: { type: 'user_message_chunk', data: { content: { type: 'text', text } } } },
    ];
    journal.append('s', turn('t1', 'first question'));
    const open = journal.projection('s');
    expect(open).toMatchObject({ asOfSeq: 2, state: 'running', activeTurnId: 't1', turnCount: 1 });
    journal.append('s', [{ kind: 'meta.turn_ended', nativeId: 'e:t1', turnId: 't1', payload: { turnId: 't1', status: 'completed' } }, ...turn('t2', 'second')]);
    // The stored projection trails the head by three rows and is brought forward, not recomputed.
    expect(journal.peek('s')!.projectionSeq).toBe(2);
    const caught = journal.projection('s');
    expect(caught).toMatchObject({ asOfSeq: 5, state: 'running', activeTurnId: 't2' });
    expect(caught.turns.map(item => [item.turnId, item.status, item.preview])).toEqual([['t1', 'completed', 'first question'], ['t2', 'running', 'second']]);
    expect(journal.peek('s')!.projectionSeq).toBe(5);
    // A cache that claims more than the log holds, or was built from other rows, is discarded.
    const db = (journal as unknown as { db: DatabaseSync }).db;
    db.prepare('UPDATE journal_heads SET projection_seq=99, projection=? WHERE session_id=?').run(JSON.stringify({ ...caught, asOfSeq: 99, check: '99:x' }), 's');
    expect(journal.projection('s')).toEqual(caught);
    db.prepare('UPDATE journal_heads SET projection=? WHERE session_id=?').run(JSON.stringify({ ...caught, turnCount: 7 }), 's');
    db.prepare("UPDATE journal_events SET digest='tampered' WHERE session_id='s' AND seq=5").run();
    expect(journal.projection('s').turnCount).toBe(2);
  });

  it('upgrades a database that predates the journal in place', async () => {
    const path = await dbPath();
    const old = new Store(path);
    old.journal.append('s', [event('a', 'kept')]);
    old.journalDb.exec('DROP TABLE journal_events; DROP TABLE journal_heads; DROP TABLE blobs; DELETE FROM settings WHERE key=\'journal-schema\'');
    old.close();
    const upgraded = new Store(path);
    upgraded.journal.append('s', [event('a', 'again')]);
    expect(upgraded.journal.range('s', 0, 5)).toHaveLength(1);
    expect((upgraded.journalDb.prepare("SELECT json FROM settings WHERE key='journal-schema'").get() as { json: string }).json).toBe('3');
    upgraded.close();
  });

  it('appends each state of an activity as a new version, and the projection counts what is live', () => {
    const journal = new Journal(new DatabaseSync(':memory:'));
    const activity = (id: string, kind: 'compaction' | 'background_task', status: string, turnId?: string) => ({
      kind: 'session/update', nativeId: id, ...(turnId ? { turnId } : {}),
      payload: { type: 'session/update', nativeId: id, data: { sessionUpdate: 'activity', activity: { id, kind, status, title: id } } },
    });
    journal.append('s', [activity('a:compact', 'compaction', 'running', 't1'), activity('a:bg1', 'background_task', 'running'), activity('a:bg2', 'background_task', 'running')]);
    expect(projectedActivity(journal.projection('s'))).toEqual({ compacting: true, background: 2 });
    journal.append('s', [activity('a:bg1', 'background_task', 'stopping')]);
    expect(projectedActivity(journal.projection('s'))).toEqual({ compacting: true, background: 2 });
    journal.append('s', [activity('a:bg1', 'background_task', 'stopped'), activity('a:compact', 'compaction', 'completed', 't1')]);
    expect(projectedActivity(journal.projection('s'))).toEqual({ compacting: false, background: 1 });
    // One entity, four versions, one place in the transcript.
    expect(journal.entity('s', 'a:bg1')).toMatchObject({ rev: 3, identity: 2 });
    // A compaction whose own end was never logged ends with its turn.
    journal.append('s', [activity('a:c2', 'compaction', 'running', 't2')]);
    expect(projectedActivity(journal.projection('s')).compacting).toBe(true);
    journal.append('s', [{ kind: 'meta.turn_ended', nativeId: 'end-t2', turnId: 't2', payload: { turnId: 't2', status: 'completed' } }]);
    expect(projectedActivity(journal.projection('s'))).toEqual({ compacting: false, background: 1 });
    // The cached projection and a fold from scratch agree.
    expect(journal.projection('s')).toEqual(journal.rebuildProjection('s'));
  });

  it('compresses JSON blobs transparently with Zstd and spills large compressed blobs to Tier-2 external files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'riffet-blobs-'));
    dirs.push(dir);
    const db = new DatabaseSync(':memory:');
    const blobsDir = join(dir, 'blobs');
    const journal = new Journal(db, undefined, undefined, undefined, { blobsDir });
    try {
      // Compressible text > 2 KiB stays inline in `blobs` (Tier-1) as zstd.
      const medium = 'hello world repeated line\n'.repeat(400);
      journal.append('s', [event('m1', medium)]);
      const [mRow] = journal.range('s', 0, 5);
      expect(mRow!.blobRef).toBeDefined();
      expect((mRow!.payload as { data: { content: { text: string } } }).data.content.text).toBe(medium);
      const mMeta = db.prepare('SELECT size, stored_size, codec, external FROM blobs WHERE hash=?').get(mRow!.blobRef!) as { size: number; stored_size: number; codec: string; external: number };
      expect(mMeta.codec).toBe('zstd');
      expect(mMeta.external).toBe(0);
      expect(mMeta.stored_size).toBeLessThan(mMeta.size / 4);

      // High-entropy payload whose compressed size >= 128 KiB spills to Tier-2 `blobs/aa/<hash>.raw`.
      const incompressible = Buffer.alloc(160 * 1024);
      for (let i = 0; i < incompressible.length; i++) incompressible[i] = (i * 131 + (i >> 3) * 17 + (i * i)) & 0xff;
      const extHash = journal.putSessionBlob('s', incompressible, 'application/octet-stream');
      const extMeta = db.prepare('SELECT size, stored_size, codec, external, bytes FROM blobs WHERE hash=?').get(extHash) as { size: number; stored_size: number; codec: string; external: number; bytes: Uint8Array | null };
      expect(extMeta.external).toBe(1);
      expect(extMeta.bytes).toBeNull();
      expect(journal.sessionBlob('s', extHash)?.bytes().equals(incompressible)).toBe(true);

      // Sweeping drops both the SQLite row and the external file.
      journal.drop('s');
      expect(journal.sweepBlobs()).toBe(2);
      expect(journal.getBlob(extHash)).toBeUndefined();
      expect(journal.sweepExternalFiles()).toBe(0);
    } finally { db.close(); }
  });

  it('strips superseded non-draft revisions monotonically via compacted_seq while preserving seq, digest and user previews', () => {
    const db = new DatabaseSync(':memory:');
    const journal = new Journal(db);
    try {
      const toolPayload = (status: string, out: string) => ({
        kind: 'tool_call_update', nativeId: 'call-1', turnId: 't1',
        payload: { type: 'tool_call_update', nativeId: 'call-1', data: { toolCallId: 'call-1', status, content: [{ type: 'content', content: { type: 'text', text: out } }] } },
      });
      const userPayload = (text: string) => ({
        kind: 'user_message_chunk', nativeId: 'u1', turnId: 't1',
        payload: { type: 'user_message_chunk', nativeId: 'u1', data: { content: { type: 'text', text } } },
      });
      journal.append('s', [userPayload('initial question'), toolPayload('in_progress', 'step 1 '.repeat(600))]);
      journal.append('s', [userPayload('edited question'), toolPayload('completed', 'final output')]);
      const beforeDigests = (db.prepare('SELECT seq, rev, digest FROM journal_events WHERE session_id=? ORDER BY seq').all('s') as Array<{ seq: number; rev: number; digest: string }>);

      const stripped = journal.compactSuperseded({ minAgeMs: 0 });
      expect(stripped).toBe(1);
      expect(journal.sweepBlobs()).toBe(1);
      expect(journal.peek('s')!.compactedSeq).toBe(4);

      // seq, rev and digest are untouched; old tool_call_update rev=1 is stripped while user_message_chunk rev=1 stays for projection previews.
      const after = db.prepare('SELECT seq, kind, rev, digest, payload, blob_ref FROM journal_events WHERE session_id=? ORDER BY seq').all('s') as Array<{ seq: number; kind: string; rev: number; digest: string; payload: string; blob_ref: string | null }>;
      expect(after.map(r => ({ seq: r.seq, rev: r.rev, digest: r.digest }))).toEqual(beforeDigests);
      expect(after[0]!.payload).toContain('initial question');
      expect(after[1]!.payload).toBe('{}');
      expect(after[1]!.blob_ref).toBeNull();
      expect((journal.entity('s', 'call-1')!.payload as { data: { status: string } }).data.status).toBe('completed');
      expect(journal.rebuildProjection('s').turns[0]?.preview).toBe('initial question');
    } finally { db.close(); }
  });

  it('head+tail trims oversized archived tool stdout blobs while keeping diffs intact', () => {
    const db = new DatabaseSync(':memory:');
    const journal = new Journal(db);
    try {
      const hugeStdout = `HEAD-MARK\n${'line of build log\n'.repeat(6_000)}TAIL-MARK`;
      const diffBlock = { type: 'diff', path: 'src/app.ts', oldText: 'old', newText: 'new' };
      journal.append('archived-1', [{
        kind: 'tool_call_update', nativeId: 'tc-1', turnId: 't1',
        payload: { type: 'tool_call_update', nativeId: 'tc-1', data: { toolCallId: 'tc-1', status: 'completed', content: [diffBlock, { type: 'content', content: { type: 'text', text: hugeStdout } }] } },
      }]);
      const beforeSize = journal.stats().blobBytes;
      expect(journal.trimArchivedToolBlobs(['archived-1'])).toBe(1);
      expect(journal.sweepBlobs()).toBe(1);
      expect(journal.stats().blobBytes).toBeLessThan(beforeSize / 2);
      const restored = journal.entity('archived-1', 'tc-1')!.payload as { data: { content: Array<Record<string, unknown>> } };
      expect(restored.data.content[0]).toEqual(diffBlock);
      const trimmedText = (restored.data.content[1]!.content as { text: string }).text;
      expect(trimmedText).toContain('HEAD-MARK');
      expect(trimmedText).toContain('TAIL-MARK');
      expect(trimmedText).toContain('archived tool output trimmed');
    } finally { db.close(); }
  });
});
