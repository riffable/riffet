import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
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
});
