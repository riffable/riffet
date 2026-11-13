import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { readAgySnapshot } from './storage.js';
const cid = '11111111-1111-1111-1111-111111111111',
  tid = '22222222-2222-2222-2222-222222222222';
const roots: string[] = [],
  databases: DatabaseSync[] = [];
afterEach(() => {
  databases.splice(0).forEach(db => db.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
function vi(n: number): Buffer {
  const bytes: number[] = [];
  do {
    bytes.push((n & 127) | (n > 127 ? 128 : 0));
    n = Math.floor(n / 128);
  } while (n);
  return Buffer.from(bytes);
}
function scalar(n: number, value: number): Buffer {
  return Buffer.concat([vi(n * 8), vi(value)]);
}
function bytes(n: number, value: string | Buffer): Buffer {
  const b = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([vi(n * 8 + 2), vi(b.length), b]);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'riffet-agy-storage-'));
  roots.push(root);
  const dir = join(root, 'antigravity-cli/conversations');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${cid}.db`),
    db = new DatabaseSync(path);
  databases.push(db);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=1;
    CREATE TABLE trajectory_meta(trajectory_id TEXT,cascade_id TEXT);
    CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,has_subtrajectory INTEGER,metadata BLOB,error_details BLOB,permissions BLOB,task_details BLOB,render_info BLOB,step_payload BLOB,step_format INTEGER);
    CREATE TABLE executor_metadata(idx INTEGER PRIMARY KEY,data BLOB);
    CREATE TABLE trajectory_metadata_blob(id TEXT,data BLOB);`);
  db.prepare('INSERT INTO trajectory_meta VALUES(?,?)').run(tid, cid);
  const md = bytes(12, tid),
    payload = Buffer.concat([scalar(1, 14), scalar(4, 3), bytes(5, md), bytes(19, bytes(2, 'Hello'))]);
  const insert = (idx: number) => db.prepare('INSERT INTO steps VALUES(?,14,3,0,?,NULL,NULL,NULL,NULL,?,0)').run(idx, md, payload);
  insert(0);
  return { root, path, db, insert };
}
it('reads committed WAL content in a private read-only snapshot without changing the store', () => {
  const f = fixture();
  f.insert(1);
  const before = f.db.prepare('PRAGMA data_version').get(),
    s = readAgySnapshot(f.root, cid)!;
  expect(s.steps).toHaveLength(2);
  expect(s.steps[1].userInput.userResponse).toBe('Hello');
  expect(f.db.prepare('PRAGMA data_version').get()).toEqual(before);
  expect(readAgySnapshot(f.root, '33333333-3333-3333-3333-333333333333')).toBeUndefined();
});
it('refuses corrupt redundant metadata, sparse branches, unsupported formats and identity escapes', () => {
  const f = fixture();
  f.db.prepare('UPDATE steps SET metadata=?').run(bytes(12, 'wrong'));
  expect(() => readAgySnapshot(f.root, cid)).toThrow('metadata disagrees');
  f.db.exec('DELETE FROM steps');
  f.insert(2);
  expect(() => readAgySnapshot(f.root, cid)).toThrow('noncontiguous');
  f.db.exec('DELETE FROM steps');
  f.insert(0);
  f.db.exec('UPDATE steps SET step_format=1');
  expect(() => readAgySnapshot(f.root, cid)).toThrow('step format');
  expect(() => readAgySnapshot(f.root, '../x')).toThrow('invalid conversation');
  const other = fixture(),
    link = join(f.root, 'antigravity-cli/conversations/33333333-3333-3333-3333-333333333333.db');
  symlinkSync(other.path, link);
  expect(() => readAgySnapshot(f.root, '33333333-3333-3333-3333-333333333333')).toThrow('escapes session root');
});
it('rejects malformed protobuf without returning a partial conversation', () => {
  const f = fixture();
  f.insert(1);
  f.db.prepare('UPDATE steps SET step_payload=? WHERE idx=1').run(Buffer.from([0x0a, 0xff, 0xff]));
  expect(() => readAgySnapshot(f.root, cid)).toThrow('protobuf');
});
