import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { reclaimFreePages } from '../sqlite-storage.js';
import { Store } from '../store.js';
import { deduplicateCheckpoints } from './checkpoints-dedup.js';
import { compactionRunning, compactionState, runRequestedCompaction, scheduleCompaction } from './compaction.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function stateWithFreedPages(): string {
  const dir = mkdtempSync(join(tmpdir(), 'riffet-compact-'));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, 'workbench.db'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT)');
  const insert = db.prepare('INSERT INTO t VALUES (?)');
  for (let i = 0; i < 2000; i++) insert.run('x'.repeat(2000));
  db.exec('DELETE FROM t WHERE rowid % 2 = 0; PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return dir;
}

describe('a compaction asked for on the settings page', () => {
  it('runs once at the next start, keeps the rows, records the result and leaves the file incremental', () => {
    const dir = stateWithFreedPages();
    expect(scheduleCompaction(dir, true).scheduledAt).toBeTruthy();
    runRequestedCompaction(dir, () => undefined);
    const state = compactionState(dir);
    expect(state.scheduledAt).toBeUndefined();
    expect(state.last?.error).toBeUndefined();
    expect(state.last!.afterBytes!).toBeLessThan(state.last!.beforeBytes);
    expect(existsSync(join(dir, 'maintenance.json'))).toBe(false);
    const db = new DatabaseSync(join(dir, 'workbench.db'));
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1000 });
    expect(db.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 2 });
    db.close();
    // Consumed: the next start does not compact again.
    const before = state.last!.at;
    runRequestedCompaction(dir, () => undefined);
    expect(compactionState(dir).last!.at).toBe(before);
  });

  it('a run killed mid-rebuild is recorded as interrupted at the next start, and stops holding the start', () => {
    const dir = stateWithFreedPages();
    // A pid that cannot be alive: the run that wrote this was killed before its cleanup.
    writeFileSync(join(dir, 'maintenance.json'), JSON.stringify({ task: 'compact', pid: 2 ** 22 + 1, startedAt: new Date(Date.now() - 5000).toISOString(), bytes: 123 }));
    expect(compactionRunning(dir)).toBe(false);
    runRequestedCompaction(dir, () => undefined);
    expect(existsSync(join(dir, 'maintenance.json'))).toBe(false);
    const last = compactionState(dir).last!;
    expect(last.error).toBeTruthy();
    expect(last.beforeBytes).toBe(123);
  });

  it('migrates a legacy single-file workbench.db atomically into L0 + journal.db + derived.db while compacting history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-migrate-'));
    dirs.push(dir);
    const controlPath = join(dir, 'workbench.db');
    const nowIso = new Date().toISOString();
    const coldIso = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const legacy = new DatabaseSync(controlPath);
    legacy.exec(`
      PRAGMA user_version=5;
      CREATE TABLE projects (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, command_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE terminals (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE journal_heads (session_id TEXT PRIMARY KEY, generation TEXT NOT NULL, last_seq INTEGER NOT NULL, ingest_cursor TEXT, projection TEXT, projection_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, identity TEXT);
      CREATE TABLE journal_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, native_id TEXT NOT NULL, rev INTEGER NOT NULL, turn_id TEXT, at TEXT NOT NULL, payload TEXT NOT NULL, blob_ref TEXT, digest TEXT NOT NULL, PRIMARY KEY (session_id, seq));
      CREATE TABLE blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE session_blobs (session_id TEXT NOT NULL, hash TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (session_id, hash));
      CREATE TABLE timeline_heads (session_id TEXT NOT NULL, lane TEXT NOT NULL, generation TEXT NOT NULL, journal_generation TEXT, scratch INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0, head_seq INTEGER NOT NULL DEFAULT 0, fold_version INTEGER NOT NULL, folded_through INTEGER NOT NULL DEFAULT 0, journal_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (session_id, lane));
      CREATE TABLE timeline_rows (session_id TEXT NOT NULL, lane TEXT NOT NULL, key TEXT NOT NULL, pos INTEGER NOT NULL, turn TEXT NOT NULL, seq INTEGER NOT NULL, rev INTEGER NOT NULL, run_id TEXT, deleted INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (session_id, lane, key));
      CREATE TABLE timeline_turns (session_id TEXT NOT NULL, lane TEXT NOT NULL, turn TEXT NOT NULL, start_pos INTEGER NOT NULL, cut INTEGER, payload TEXT NOT NULL, PRIMARY KEY (session_id, lane, turn));
      CREATE TABLE message_index (session_id TEXT NOT NULL, message_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (session_id, message_id));
      CREATE TABLE message_index_sessions (session_id TEXT PRIMARY KEY, indexed_at TEXT NOT NULL);
    `);
    legacy.prepare('INSERT INTO projects VALUES (?, ?)').run('p1', JSON.stringify({ id: 'p1', name: 'Repo', cwd: '/tmp/repo', createdAt: nowIso }));
    legacy.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('cold-s', 'p1', JSON.stringify({ id: 'cold-s', projectId: 'p1', kind: 'native', backendId: 'codex', title: 'Cold', state: 'idle', tags: [], createdAt: coldIso, updatedAt: coldIso, lastActivityAt: coldIso }));
    legacy.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('hot-s', 'p1', JSON.stringify({ id: 'hot-s', projectId: 'p1', kind: 'native', backendId: 'codex', title: 'Hot', state: 'idle', tags: [], createdAt: nowIso, updatedAt: nowIso, lastActivityAt: nowIso }));
    legacy.prepare('INSERT INTO journal_heads VALUES (?, ?, 2, NULL, NULL, 0, ?, NULL)').run('cold-s', 'gen-1', coldIso);
    const bigTool = JSON.stringify({ type: 'tool_call_update', nativeId: 'tc1', data: { toolCallId: 'tc1', status: 'completed', output: 'z'.repeat(20_000) } });
    legacy.prepare('INSERT INTO journal_events VALUES (?, 1, ?, ?, 1, ?, ?, ?, NULL, ?)').run('cold-s', 'tool_call_update', 'tc1', 't1', coldIso, JSON.stringify({ type: 'tool_call_update', nativeId: 'tc1', data: { toolCallId: 'tc1', status: 'in_progress', output: 'old '.repeat(1000) } }), 'd1');
    legacy.prepare('INSERT INTO journal_events VALUES (?, 2, ?, ?, 2, ?, ?, ?, NULL, ?)').run('cold-s', 'tool_call_update', 'tc1', 't1', coldIso, bigTool, 'd2');
    legacy.prepare('INSERT INTO timeline_heads VALUES (?, ?, ?, ?, 0, 0, 1, 11, 0, 2, ?)').run('cold-s', 'main', 'g1', 'gen-1', coldIso);
    legacy.prepare('INSERT INTO timeline_rows VALUES (?, ?, ?, 512, ?, 1, 1, NULL, 0, ?, ?, 100, ?)').run('cold-s', 'main', 'tool:tc1', 'turn:1', 'tool', 'dig', JSON.stringify({ key: 'tool:tc1', kind: 'tool', truncated: { blobRef: 'a'.repeat(64), bytes: 20_000 } }));
    // Hot session with a soft-deleted empty-payload row and a live truncated row (regression for sqlite json_extract on '').
    legacy.prepare('INSERT INTO timeline_heads VALUES (?, ?, ?, ?, 0, 0, 2, 11, 0, 2, ?)').run('hot-s', 'main', 'g-hot', 'gen-hot', nowIso);
    legacy.prepare('INSERT INTO timeline_rows VALUES (?, ?, ?, 512, ?, 1, 1, NULL, 1, ?, ?, 0, ?)').run('hot-s', 'main', 'event:gone', 'turn:1', 'assistant', '', '');
    legacy.prepare('INSERT INTO timeline_rows VALUES (?, ?, ?, 1024, ?, 2, 1, NULL, 0, ?, ?, 120, ?)').run('hot-s', 'main', 'event:live', 'turn:1', 'assistant', 'dig2', JSON.stringify({ key: 'event:live', kind: 'assistant', truncated: { blobRef: 'b'.repeat(64), bytes: 40_000 } }));
    legacy.prepare('INSERT INTO blobs VALUES (?, 20000, ?, ?)').run('a'.repeat(64), Buffer.from('x'.repeat(20_000)), coldIso);
    legacy.prepare('INSERT INTO session_blobs VALUES (?, ?, ?)').run('cold-s', 'a'.repeat(64), 'application/json');
    legacy.prepare('INSERT INTO message_index VALUES (?, ?, ?, ?, ?)').run('cold-s', 'tc1', 'tool', `Bash ${'arg '.repeat(500)}`, coldIso);
    legacy.close();

    // Opening Store migrates transparently and shrinks L0.
    const store = new Store(controlPath);
    try {
      expect(existsSync(join(dir, 'journal.db'))).toBe(true);
      expect(existsSync(join(dir, 'derived.db'))).toBe(true);
      // L0 no longer carries L1/L2 tables.
      expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('journal_events','timeline_rows','message_index','blobs')").all()).toEqual([]);
      // Superseded rev=1 was stripped; rev=2 spilled into a Zstd-compressed blob and reads back intact.
      const rows = store.journal.range('cold-s', 0, 10);
      expect(rows[0]!.payload).toEqual({});
      expect((rows[1]!.payload as { data: { output: string } }).data.output).toBe('z'.repeat(20_000));
      expect(store.journalDb.prepare('SELECT codec FROM blobs WHERE hash=?').get(rows[1]!.blobRef!)).toEqual({ codec: 'zstd' });
      // Redundant legacy fitRow JSON blob was not carried forward.
      expect(store.journal.getBlob('a'.repeat(64))).toBeUndefined();
      // Cold timeline rows were dropped during migration; hot rows (including soft-deleted '') were preserved with truncated_hash indexed.
      expect(store.derivedDb.prepare("SELECT COUNT(*) AS n FROM timeline_rows WHERE session_id='cold-s'").get()).toEqual({ n: 0 });
      expect(store.derivedDb.prepare("SELECT truncated_hash FROM timeline_rows WHERE session_id='hot-s' AND key='event:live'").get()).toEqual({ truncated_hash: 'b'.repeat(64) });
      const indexedTool = store.derivedDb.prepare('SELECT text FROM message_index WHERE session_id=?').get('cold-s') as { text: string };
      expect(indexedTool.text.length).toBeLessThanOrEqual(256);
    } finally {
      store.close();
    }
  });

  it('reclaims freed pages online via bounded incremental_vacuum without a full rebuild', () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-incvac-'));
    dirs.push(dir);
    const dbPath = join(dir, 'inc.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT)');
      const ins = db.prepare('INSERT INTO t VALUES (?)');
      db.exec('BEGIN IMMEDIATE');
      for (let i = 0; i < 600; i++) ins.run('x'.repeat(4000));
      db.exec('COMMIT');
      db.exec('DELETE FROM t; PRAGMA wal_checkpoint(TRUNCATE)');
      const beforeBytes = statSync(dbPath).size;
      const reclaimed = reclaimFreePages(db, { minFreePages: 10, maxPages: 5000, busy: () => false });
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      expect(reclaimed).toBeGreaterThan(100);
      expect(statSync(dbPath).size).toBeLessThan(beforeBytes);
    } finally {
      db.close();
    }
  });

  it('deduplicates legacy independent checkpoint blobs via atomic hard links while keeping content intact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-cp-dedup-'));
    dirs.push(dir);
    const projectDir = join(dir, 'checkpoints', 'a'.repeat(32));
    const cp1 = join(projectDir, '11111111-1111-4111-8111-111111111111');
    const cp2 = join(projectDir, '22222222-2222-4222-8222-222222222222');
    const cpUnfinished = join(projectDir, '33333333-3333-4333-8333-333333333333');
    mkdirSync(cp1, { recursive: true });
    mkdirSync(cp2, { recursive: true });
    mkdirSync(cpUnfinished, { recursive: true });
    writeFileSync(join(cp1, 'manifest.json'), '{}');
    writeFileSync(join(cp2, 'manifest.json'), '{}');
    const blobName = `blob-${'b'.repeat(64)}`;
    const content = Buffer.from('duplicate dirty file snapshot\n'.repeat(500));
    writeFileSync(join(cp1, blobName), content);
    writeFileSync(join(cp2, blobName), content);
    writeFileSync(join(cpUnfinished, blobName), content);
    expect(lstatSync(join(cp1, blobName)).ino).not.toBe(lstatSync(join(cp2, blobName)).ino);

    const first = await deduplicateCheckpoints(dir);
    expect(first.linkedFiles).toBe(1);
    expect(first.savedBytes).toBeGreaterThan(0);
    expect(lstatSync(join(cp1, blobName)).ino).toBe(lstatSync(join(cp2, blobName)).ino);
    // Unfinished checkpoint (no manifest.json) is left untouched.
    expect(lstatSync(join(cpUnfinished, blobName)).ino).not.toBe(lstatSync(join(cp1, blobName)).ino);
    expect(readFileSync(join(cp2, blobName)).equals(content)).toBe(true);

    // Idempotent second pass does nothing.
    const second = await deduplicateCheckpoints(dir);
    expect(second.linkedFiles).toBe(0);
  });
});
