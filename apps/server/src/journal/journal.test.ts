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
    expect((upgraded.journalDb.prepare("SELECT json FROM settings WHERE key='journal-schema'").get() as { json: string }).json).toBe('4');
    upgraded.close();
  });

  describe('upgrading a journal database from each earlier schema version', () => {
    // Markers: absent (0, the shape before any marker was written), then 1..3. Each has the tables as that release created them.
    const HEADS = { 0: 'session_id TEXT PRIMARY KEY, generation TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, ingest_cursor TEXT, projection TEXT, projection_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL',
      2: ', identity TEXT', 3: ', compacted_seq INTEGER NOT NULL DEFAULT 0' };
    const big = 'a line of transcript text\n'.repeat(200);
    const seeded = () => {
      const source = new Journal(new DatabaseSync(':memory:'));
      source.append('s', [event('a', 'small'), event('big', big), { kind: 'meta.turn_ended', nativeId: 'end', turnId: 't1', payload: { turnId: 't1', status: 'completed' } }], { cursor: 'c1' });
      const db = source.db;
      return {
        heads: db.prepare('SELECT * FROM journal_heads').all() as Array<Record<string, unknown>>,
        events: db.prepare('SELECT * FROM journal_events').all() as Array<Record<string, unknown>>,
        blobs: db.prepare('SELECT * FROM blobs').all() as Array<{ hash: string; size: number; stored_size: number; codec: string; external: number; bytes: Uint8Array; created_at: string }>,
        range: source.range('s', 0, 10), projection: source.projection('s'), blob: (hash: string) => source.getBlob(hash),
      };
    };
    const insert = (db: DatabaseSync, table: string, rows: Array<Record<string, unknown>>) => {
      for (const row of rows) {
        const keys = Object.keys(row);
        db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key] as never));
      }
    };
    /** Writes the database as `version` left it, holding the seeded session. */
    const writeOld = (path: string, version: 0 | 1 | 2 | 3, data: ReturnType<typeof seeded>) => {
      const db = new DatabaseSync(path);
      const columns = (version >= 2 ? HEADS[0] + HEADS[2] : HEADS[0]) + (version >= 3 ? HEADS[3] : '');
      db.exec(`CREATE TABLE journal_heads (${columns});
        CREATE TABLE journal_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, native_id TEXT NOT NULL, rev INTEGER NOT NULL, turn_id TEXT, at TEXT NOT NULL, digest TEXT NOT NULL, blob_ref TEXT, payload TEXT NOT NULL, PRIMARY KEY (session_id, seq));
        CREATE UNIQUE INDEX journal_native ON journal_events(session_id, native_id, rev);
        CREATE INDEX journal_turn ON journal_events(session_id, turn_id) WHERE turn_id IS NOT NULL;
        CREATE INDEX journal_blob_ref ON journal_events(blob_ref) WHERE blob_ref IS NOT NULL;
        CREATE TABLE settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);`);
      db.exec(version >= 3
        ? "CREATE TABLE blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, stored_size INTEGER NOT NULL DEFAULT 0, codec TEXT NOT NULL DEFAULT 'raw', external INTEGER NOT NULL DEFAULT 0, bytes BLOB, created_at TEXT NOT NULL)"
        : 'CREATE TABLE blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL)');
      const head = (row: Record<string, unknown>) => ({ ...row, ...(version >= 2 ? { identity: 'native-1' } : {}) });
      const drop = (row: Record<string, unknown>, ...names: string[]) => Object.fromEntries(Object.entries(row).filter(([key]) => !names.includes(key)));
      insert(db, 'journal_heads', data.heads.map(row => head(version >= 3 ? row : drop(row, 'identity', 'compacted_seq'))));
      insert(db, 'journal_events', data.events);
      // Before v3 every blob was stored whole; from v3 on the row carries its codec.
      insert(db, 'blobs', data.blobs.map(blob => version >= 3 ? blob : { hash: blob.hash, size: blob.size, bytes: data.blob(blob.hash)!, created_at: blob.created_at }));
      if (version > 0) db.prepare('INSERT INTO settings(key,json) VALUES(?,?)').run('journal-schema', JSON.stringify(version));
      db.close();
    };

    for (const version of [0, 1, 2, 3] as const) {
      it(`keeps the log, cursor and blobs of a v${version} database readable and records v4, once`, async () => {
        const path = (await dbPath()).replace('workbench.db', 'journal.db');
        const data = seeded();
        expect(data.blobs.length).toBeGreaterThan(0);
        writeOld(path, version, data);

        for (const pass of [1, 2]) {
          const db = new DatabaseSync(path);
          const journal = new Journal(db);
          try {
            expect(JSON.parse((db.prepare("SELECT json FROM settings WHERE key='journal-schema'").get() as { json: string }).json)).toBe(4);
            const turnIndex = (db.prepare("SELECT sql FROM sqlite_master WHERE name='journal_turn'").get() as { sql: string }).sql;
            expect(turnIndex).toContain("payload<>'{}'");
            expect(journal.range('s', 0, 3)).toEqual(data.range);
            expect(data.blobs.every(blob => journal.getBlob(blob.hash)?.equals(data.blob(blob.hash)!))).toBe(true);
            expect(journal.peek('s')).toMatchObject({ ingestCursor: 'c1', lastSeq: pass === 1 ? 3 : 4, ...(version >= 2 ? { identity: 'native-1' } : {}) });
            if (pass === 1) expect(journal.projection('s')).toEqual(data.projection);
            if (pass === 1) expect(journal.append('s', [event('b', 'after upgrade')]).rows).toHaveLength(1);
            else expect(journal.range('s', 0, 10).map(row => row.nativeId)).toEqual(['a', 'big', 'end', 'b']);
          } finally { db.close(); }
        }
      });
    }
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

  it('compresses JSON blobs transparently with Zstd (dictionary for small JSON, plain for large) and spills large blobs to Tier-2', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'riffet-blobs-'));
    dirs.push(dir);
    const db = new DatabaseSync(':memory:');
    const blobsDir = join(dir, 'blobs');
    const journal = new Journal(db, undefined, undefined, undefined, { blobsDir });
    try {
      // Small/medium JSON object (<= 16 KiB) uses static Zstd dictionary (`zstd-d1`).
      const medium = 'hello world repeated line\n'.repeat(300);
      journal.append('s', [event('m1', medium)]);
      const [mRow] = journal.range('s', 0, 5);
      expect(mRow!.blobRef).toBeDefined();
      expect((mRow!.payload as { data: { content: { text: string } } }).data.content.text).toBe(medium);
      const mMeta = db.prepare('SELECT size, stored_size, codec, external FROM blobs WHERE hash=?').get(mRow!.blobRef!) as { size: number; stored_size: number; codec: string; external: number };
      expect(mMeta.codec).toBe('zstd-d1');
      expect(mMeta.external).toBe(0);
      expect(mMeta.stored_size).toBeLessThan(mMeta.size / 4);

      // Large JSON (> 16 KiB) uses standard Zstd (`zstd`).
      const large = 'larger payload chunk line\n'.repeat(1200);
      journal.append('s', [event('m2', large)]);
      const rows = journal.range('s', 0, 5);
      const lMeta = db.prepare('SELECT codec, external FROM blobs WHERE hash=?').get(rows[1]!.blobRef!) as { codec: string; external: number };
      expect(lMeta.codec).toBe('zstd');
      expect(lMeta.external).toBe(0);
      expect((rows[1]!.payload as { data: { content: { text: string } } }).data.content.text).toBe(large);

      // High-entropy payload whose compressed size >= 128 KiB spills to Tier-2 `blobs/aa/<hash>.raw`.
      const incompressible = Buffer.alloc(160 * 1024);
      for (let i = 0; i < incompressible.length; i++) incompressible[i] = (i * 131 + (i >> 3) * 17 + (i * i)) & 0xff;
      const extHash = journal.putSessionBlob('s', incompressible, 'application/octet-stream');
      const extMeta = db.prepare('SELECT size, stored_size, codec, external, bytes FROM blobs WHERE hash=?').get(extHash) as { size: number; stored_size: number; codec: string; external: number; bytes: Uint8Array | null };
      expect(extMeta.external).toBe(1);
      expect(extMeta.bytes).toBeNull();
      expect(journal.sessionBlob('s', extHash)?.bytes().equals(incompressible)).toBe(true);

      // GC fence prevents sweeping referenced/unreferenced blobs while a backup snapshot is running.
      journal.drop('s');
      const releaseFence = journal.holdBlobGc();
      try {
        expect(journal.isBlobGcHeld()).toBe(true);
        expect(journal.sweepBlobs()).toBe(0);
        expect(journal.getBlob(extHash)?.equals(incompressible)).toBe(true);
      } finally {
        releaseFence();
      }
      expect(journal.isBlobGcHeld()).toBe(false);
      // Once the fence is released, sweeping drops both the SQLite rows and the external file.
      expect(journal.sweepBlobs()).toBe(3);
      expect(journal.getBlob(extHash)).toBeUndefined();
      expect(journal.sweepExternalFiles()).toBe(0);
    } finally { db.close(); }
  });

  it('upgrades legacy raw/zstd small JSON blobs to dictionary-compressed zstd-d1 losslessly', () => {
    const db = new DatabaseSync(':memory:');
    const journal = new Journal(db);
    try {
      const legacyJson = Buffer.from(JSON.stringify({
        type: 'tool_call_update',
        nativeId: 'claude:abc:1',
        runId: 'claude-turn:1',
        createdAt: '2026-11-16T00:00:00.000Z',
        data: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'toolu_123',
          kind: 'read',
          status: 'completed',
          rawInput: { file_path: 'apps/server/src/store.ts', offset: 1, limit: 200 },
          content: [{ type: 'content', content: { type: 'text', text: 'export function example() { return 1; }\n'.repeat(25) } }],
        },
      }));
      // Insert a non-JSON prefix blob, a corrupt zstd blob, and a legacy raw JSON blob to verify cursor progress & resilience.
      const nonJsonHash = '0'.repeat(64);
      const corruptHash = '1'.repeat(64);
      const hash = 'f'.repeat(64);
      db.prepare("INSERT INTO blobs(hash,size,stored_size,codec,external,bytes,created_at) VALUES(?,?,?,'raw',0,?,?)")
        .run(nonJsonHash, 1024, 1024, Buffer.alloc(1024, 0x41), '2026-01-01T00:00:00.000Z');
      db.prepare("INSERT INTO blobs(hash,size,stored_size,codec,external,bytes,created_at) VALUES(?,?,?,'zstd',0,?,?)")
        .run(corruptHash, 1024, 16, Buffer.from('not-valid-zstd!!'), '2026-01-01T00:00:00.000Z');
      db.prepare("INSERT INTO blobs(hash,size,stored_size,codec,external,bytes,created_at) VALUES(?,?,?,'raw',0,?,?)")
        .run(hash, legacyJson.length, legacyJson.length, legacyJson, '2026-01-01T00:00:00.000Z');
      // Small batch limit=2 stops after non-JSON + corrupt rows, persisting cursor so the next pass reaches `hash`.
      const firstPass = journal.recompressSmallBlobs({ maxBlobs: 2 });
      expect(firstPass.recompressed).toBe(0);
      const secondPass = journal.recompressSmallBlobs({ maxBlobs: 10 });
      expect(secondPass.recompressed).toBe(1);
      expect(secondPass.savedBytes).toBeGreaterThan(200);
      expect(db.prepare('SELECT codec FROM blobs WHERE hash=?').get(hash)).toEqual({ codec: 'zstd-d1' });
      expect(journal.getBlob(hash)?.equals(legacyJson)).toBe(true);
      // Steady-state call after reaching end is an O(1) no-op.
      expect(journal.recompressSmallBlobs({ maxBlobs: 10 })).toEqual({ recompressed: 0, savedBytes: 0 });
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

  it('respects beforeAt when cold trimming tool blobs on an active conversation', () => {
    const db = new DatabaseSync(':memory:');
    const journal = new Journal(db);
    try {
      const huge = `HEAD-MARK\n${'line of build log\n'.repeat(6_000)}TAIL-MARK`;
      const makePayload = (id: string, at: string) => ({
        kind: 'tool_call_update', nativeId: id, turnId: id, at,
        payload: { type: 'tool_call_update', nativeId: id, data: { toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: huge } }] } },
      });
      journal.append('main-1', [
        makePayload('old-tc', '2026-10-01T00:00:00.000Z'),
        makePayload('new-tc', '2026-11-20T00:00:00.000Z'),
      ]);
      expect(journal.trimArchivedToolBlobs(['main-1'], { beforeAt: '2026-11-01T00:00:00.000Z' })).toBe(1);
      const oldPayload = journal.entity('main-1', 'old-tc')!.payload as { data: { content: Array<{ content: { text: string } }> } };
      const newPayload = journal.entity('main-1', 'new-tc')!.payload as { data: { content: Array<{ content: { text: string } }> } };
      expect(oldPayload.data.content[0]!.content.text).toContain('archived tool output trimmed');
      expect(newPayload.data.content[0]!.content.text).not.toContain('archived tool output trimmed');
    } finally { db.close(); }
  });

  it('advances past oversized non-trimmable tool blobs when scanning batches', () => {
    const db = new DatabaseSync(':memory:');
    const journal = new Journal(db);
    try {
      const largeDiff = 'diff-line\n'.repeat(8_000);
      const hugeStdout = `HEAD-MARK\n${'line of build log\n'.repeat(6_000)}TAIL-MARK`;
      const inputs = [
        ...Array.from({ length: 45 }, (_, index) => ({
          kind: 'tool_call_update' as const,
          nativeId: `diff-${index}`,
          turnId: `t-${index}`,
          at: '2026-10-01T00:00:00.000Z',
          payload: { type: 'tool_call_update', nativeId: `diff-${index}`, data: { toolCallId: `diff-${index}`, status: 'completed', content: [{ type: 'diff', path: 'a.ts', oldText: largeDiff, newText: largeDiff }] } },
        })),
        {
          kind: 'tool_call_update' as const,
          nativeId: 'stdout-after-diffs',
          turnId: 't-tail',
          at: '2026-10-01T00:00:00.000Z',
          payload: { type: 'tool_call_update', nativeId: 'stdout-after-diffs', data: { toolCallId: 'stdout-after-diffs', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: hugeStdout } }] } },
        },
      ];
      journal.append('main-cursor', inputs);
      expect(journal.trimArchivedToolBlobs(['main-cursor'], { limit: 10 })).toBe(1);
      const trimmed = journal.entity('main-cursor', 'stdout-after-diffs')!.payload as { data: { content: Array<{ content: { text: string } }> } };
      expect(trimmed.data.content[0]!.content.text).toContain('archived tool output trimmed');
    } finally { db.close(); }
  });
});
