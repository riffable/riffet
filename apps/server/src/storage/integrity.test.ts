import { mkdtempSync, openSync, rmSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { runIntegrityChecks } from './integrity.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('reports a database whose pages were overwritten as failed, and a sound one as ok', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'riffet-integrity-'));
  dirs.push(dir);
  for (const name of ['workbench.db', 'journal.db']) {
    const db = new DatabaseSync(join(dir, name));
    db.exec('CREATE TABLE t (v TEXT, PRIMARY KEY (v)) ; CREATE INDEX i ON t(v)');
    const insert = db.prepare('INSERT INTO t VALUES (?)');
    for (let i = 0; i < 3000; i++) insert.run(`row-${i}-${'x'.repeat(40)}`);
    db.close();
  }
  const fd = openSync(join(dir, 'journal.db'), 'r+');
  writeSync(fd, Buffer.alloc(8192, 0xff), 0, 8192, 4096);
  closeSync(fd);
  const results = await runIntegrityChecks(dir, ['workbench', 'journal']);
  expect(results.find(result => result.id === 'workbench')?.status).toBe('ok');
  expect(results.find(result => result.id === 'journal')?.status).toBe('fail');
});
