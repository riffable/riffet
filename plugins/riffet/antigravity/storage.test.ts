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
it('reads embedded permissions when the SQLite column is NULL and rejects a conflicting copy', () => {
  const f = fixture();
  // agy 1.5.10: a completed generic tool step has a permission grant in fields 133 → 2, with a NULL permissions column.
  const resource = Buffer.concat([bytes(1, 'command'), bytes(2, 'pwd')]);
  const grant = Buffer.concat([bytes(1, resource), scalar(2, 1), bytes(5, 'command'), bytes(6, 'pwd')]);
  const payload = Buffer.concat([scalar(1, 132), scalar(4, 3), bytes(133, bytes(2, grant)), bytes(140, Buffer.alloc(0))]);
  f.db.prepare('INSERT INTO steps (idx,step_type,status,has_subtrajectory,step_format,step_payload) VALUES(1,132,3,0,0,?)').run(payload);
  expect(readAgySnapshot(f.root, cid)?.steps[1].type).toBe('CORTEX_STEP_TYPE_GENERIC');
  f.db.prepare('UPDATE steps SET permissions=? WHERE idx=1').run(Buffer.alloc(0));
  expect(() => readAgySnapshot(f.root, cid)).toThrow('permissions disagrees with payload');
});
it('reads native visibility and only the presentation fields of a notification', () => {
  const f = fixture();
  const insert = f.db.prepare('INSERT INTO steps (idx,step_type,status,has_subtrajectory,step_format,step_payload) VALUES(?,?,3,0,0,?)');
  const add = (idx: number, kind: number, field: number, body: Buffer) =>
    insert.run(idx, kind, Buffer.concat([scalar(1, kind), scalar(4, 3), bytes(field, body)]));
  // agy 1.5.10 keeps the restart notice's render info inside its system message, including both hide flags.
  const render = Buffer.concat([
    bytes(1, 'System Message'), bytes(2, 'Summary'), scalar(4, 1), scalar(11, 1),
    bytes(10, bytes(1, 'Display text')), bytes(10, bytes(3, bytes(4, 'Terminal output'))),
  ]);
  add(1, 101, 114, Buffer.concat([bytes(1, '[Message] internal'), bytes(2, render), bytes(4, scalar(11, 1))]));
  add(2, 82, 94, Buffer.concat([bytes(2, 'Please review'), bytes(5, 'Internal justification')]));
  const error = bytes(3, bytes(1, 'Operation failed'));
  add(3, 17, 24, Buffer.concat([error, scalar(5, 1)]));
  add(4, 17, 24, Buffer.concat([error, scalar(4, 1)]));
  add(5, 17, 24, Buffer.concat([error, scalar(5, 0)]));

  const { steps } = readAgySnapshot(f.root, cid)!;
  expect(steps[1].systemMessage).toEqual({
    message: '[Message] internal',
    renderInfo: { title: 'System Message', markdown: 'Summary', hidden: true, contentBlocks: [{ markdown: 'Display text' }] },
    agentMessage: { hideFromUser: true },
  });
  expect(steps[2].notifyUser).toEqual({ notificationContent: 'Please review' });
  expect(steps[3].errorMessage.shouldShowUser).toBe(true);
  expect(steps[4].errorMessage).toEqual({ error: { userErrorMessage: 'Operation failed' }, shouldShowModel: true });
  expect(steps[5].errorMessage.shouldShowUser).toBe(false);
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
it('keeps GENERIC step type and leaves missing RunCommand exitCode undefined', () => {
  const f = fixture();
  const insert = f.db.prepare('INSERT INTO steps (idx,step_type,status,has_subtrajectory,step_format,step_payload) VALUES(?,132,3,0,0,?)');
  const genericStep = (typeUrl: string, inner: Buffer, output = 'ok') => {
    const any = Buffer.concat([bytes(1, typeUrl), bytes(2, inner)]);
    const result = Buffer.concat([bytes(1, output), bytes(6, any)]);
    return Buffer.concat([scalar(1, 132), scalar(4, 3), bytes(140, bytes(2, result))]);
  };
  // Missing exitCode (field 1 omitted) -> exitCode must be undefined, not 0.
  insert.run(1, genericStep('type.googleapis.com/exa.cortex.core.tools.RunCommand', Buffer.concat([bytes(6, 'sleep 1'), bytes(7, '/tmp')])));
  // Explicit exitCode 0 -> exitCode is 0.
  insert.run(2, genericStep('type.googleapis.com/exa.cortex.core.tools.RunCommand', Buffer.concat([scalar(1, 0), bytes(6, 'true')])));
  // Field 8 set (running/background) -> exitCode is undefined even if field 1 is present.
  insert.run(3, genericStep('type.googleapis.com/exa.cortex.core.tools.RunCommand', Buffer.concat([scalar(1, 0), bytes(6, 'bg'), scalar(8, 1)])));
  // InvokeSubagent inside GENERIC keeps type CORTEX_STEP_TYPE_GENERIC while exposing invokeSubagent.
  const childId = '44444444-4444-4444-4444-444444444444';
  const invokeBody = Buffer.concat([bytes(1, bytes(2, 'Explorer')), bytes(2, bytes(1, childId))]);
  insert.run(4, genericStep('type.googleapis.com/exa.cortex.core.tools.InvokeSubagent', invokeBody));

  const { steps } = readAgySnapshot(f.root, cid)!;
  expect(steps[1].type).toBe('CORTEX_STEP_TYPE_GENERIC');
  expect(steps[1].runCommand).toMatchObject({ commandLine: 'sleep 1', cwd: '/tmp', combinedOutput: { full: 'ok' } });
  expect(steps[1].runCommand.exitCode).toBeUndefined();
  expect(steps[2].type).toBe('CORTEX_STEP_TYPE_GENERIC');
  expect(steps[2].runCommand.exitCode).toBe(0);
  expect(steps[3].type).toBe('CORTEX_STEP_TYPE_GENERIC');
  expect(steps[3].runCommand.exitCode).toBeUndefined();
  expect(steps[4].type).toBe('CORTEX_STEP_TYPE_GENERIC');
  expect(steps[4].invokeSubagent.results).toEqual([{ conversationId: childId, workspaceUris: [] }]);
});
