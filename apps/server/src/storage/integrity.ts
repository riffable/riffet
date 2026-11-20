import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { INTEGRITY_BUDGET } from '../../../../packages/contracts/src/budgets.js';
import { storageLayoutForStateDir } from '../sqlite-storage.js';

export type IntegrityStatus = 'ok' | 'warn' | 'fail';
export type IntegrityCheckId = 'workbench' | 'journal' | 'derived' | 'blob-refs' | 'blob-orphans' | 'journal-sessions' | 'derived-watermark';
export interface IntegrityResult { id: IntegrityCheckId; status: IntegrityStatus; detail: string; ms: number }

/**
 * CommonJS, evaluated in the worker (see `wal-checkpoint.ts`). Every connection is read-only and every
 * query is bounded: `PRAGMA quick_check` of a multi-gigabyte `journal.db` takes seconds, so none of this
 * runs on the event loop.
 */
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { existsSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { paths, checks, budget } = workerData;
const open = path => new DatabaseSync(path, { readOnly: true });
const report = (id, started, status, detail) => parentPort.postMessage({ id, status, detail, ms: Date.now() - started });
const one = (db, sql, ...args) => Object.values(db.prepare(sql).get(...args) ?? {})[0];
const message = error => String(error && error.message || error).split('\\n')[0].slice(0, 300);

function quick(id, path, damaged) {
  const started = Date.now();
  if (!existsSync(path)) return report(id, started, 'ok', 'not created yet');
  let db;
  try {
    db = open(path);
    const value = one(db, 'PRAGMA quick_check(1)');
    if (value === 'ok') report(id, started, 'ok', 'quick_check passed');
    else report(id, started, damaged, 'quick_check: ' + String(value).slice(0, 300));
  } catch (error) { report(id, started, damaged, 'quick_check could not run: ' + message(error)); }
  finally { try { db && db.close(); } catch {} }
}

function guarded(id, run) {
  const started = Date.now();
  try { const [status, detail] = run(); report(id, started, status, detail); }
  catch (error) { report(id, started, 'warn', 'could not be checked: ' + message(error)); }
}

for (const check of checks) {
  if (check === 'workbench') quick(check, paths.control, 'fail');
  else if (check === 'journal') quick(check, paths.journal, 'fail');
  else if (check === 'derived') quick(check, paths.derived, 'warn');
}

if (checks.includes('blob-refs') || checks.includes('blob-orphans') || checks.includes('journal-sessions') || checks.includes('derived-watermark')) {
  let journal;
  try { journal = open(paths.journal); } catch (error) { journal = undefined; }
  if (journal) {
    try {
      if (checks.includes('blob-refs')) guarded('blob-refs', () => {
        // Walks the partial index journal_blob_ref; the lookup in blobs is by primary key.
        const row = journal.prepare('SELECT count(*) AS refs, coalesce(sum(missing), 0) AS missing FROM (SELECT r.blob_ref, NOT EXISTS (SELECT 1 FROM blobs b WHERE b.hash = r.blob_ref) AS missing FROM (SELECT DISTINCT blob_ref FROM journal_events WHERE blob_ref IS NOT NULL LIMIT ?) r)').get(budget.maxBlobRefs);
        return row.missing > 0
          ? ['fail', row.missing + ' of ' + row.refs + ' referenced blobs are missing from journal.db']
          : ['ok', row.refs + ' referenced blobs present'];
      });
      if (checks.includes('blob-orphans')) guarded('blob-orphans', () => {
        // session_blobs has no index on hash: IN (subquery) builds one temporary index instead of one scan per blob.
        const row = journal.prepare('SELECT count(*) AS rows, coalesce(sum(orphan), 0) AS orphans FROM (SELECT NOT EXISTS (SELECT 1 FROM journal_events e WHERE e.blob_ref = b.hash) AND b.hash NOT IN (SELECT hash FROM session_blobs) AS orphan FROM (SELECT hash FROM blobs LIMIT ?) b)').get(budget.maxBlobRows);
        return row.orphans > 0
          ? ['warn', row.orphans + ' of ' + row.rows + ' blobs are not referenced by any conversation']
          : ['ok', 'every one of ' + row.rows + ' blobs is referenced'];
      });
      if (checks.includes('journal-sessions')) guarded('journal-sessions', () => {
        if (!existsSync(paths.control)) return ['ok', 'workbench.db not created yet'];
        const control = open(paths.control);
        try {
          const known = new Set(control.prepare('SELECT id FROM sessions LIMIT ?').all(budget.maxSessionIds).map(row => row.id));
          const heads = journal.prepare('SELECT session_id FROM journal_heads LIMIT ?').all(budget.maxSessionIds);
          const orphans = heads.filter(row => !known.has(row.session_id.split('#')[0])).length; // a subagent's log is 'id#sub:...'
          return orphans > 0
            ? ['warn', orphans + ' of ' + heads.length + ' conversation logs have no conversation in workbench.db']
            : ['ok', 'all ' + heads.length + ' conversation logs belong to a conversation'];
        } finally { try { control.close(); } catch {} }
      });
      if (checks.includes('derived-watermark')) guarded('derived-watermark', () => {
        if (!existsSync(paths.derived)) return ['ok', 'derived.db not created yet'];
        const derived = open(paths.derived);
        try {
          const last = new Map(journal.prepare('SELECT session_id, generation, last_seq FROM journal_heads LIMIT ?').all(budget.maxSessionIds).map(row => [row.session_id, row]));
          const heads = derived.prepare('SELECT session_id, journal_generation, journal_seq FROM timeline_heads LIMIT ?').all(budget.maxSessionIds);
          // A head folded from another generation of the log restarts from its own numbering, so only the same generation compares.
          const ahead = heads.filter(row => { const head = last.get(row.session_id); return head && head.generation === row.journal_generation && row.journal_seq > head.last_seq; }).length;
          return ahead > 0
            ? ['warn', ahead + ' of ' + heads.length + ' timelines in derived.db are ahead of their conversation log']
            : ['ok', 'all ' + heads.length + ' timelines are within their conversation log'];
        } finally { try { derived.close(); } catch {} }
      });
    } finally { try { journal.close(); } catch {} }
  } else {
    for (const id of ['blob-refs', 'blob-orphans', 'journal-sessions', 'derived-watermark']) if (checks.includes(id)) report(id, Date.now(), 'warn', 'journal.db could not be opened');
  }
}
`;

/** Runs the named checks in a worker with read-only connections; `onResult` sees each as it finishes. */
export function runIntegrityChecks(stateDir: string, checks: readonly IntegrityCheckId[], onResult?: (result: IntegrityResult) => void, background = false): Promise<IntegrityResult[]> {
  const results: IntegrityResult[] = [];
  return new Promise(resolve => {
    let worker: Worker;
    try { worker = new Worker(WORKER, { eval: true, name: 'riffet-integrity', workerData: { paths: storageLayoutForStateDir(stateDir), checks, budget: INTEGRITY_BUDGET } }); }
    catch { resolve(results); return; }
    const timer = setTimeout(() => { void worker.terminate(); }, INTEGRITY_BUDGET.timeoutMs);
    timer.unref();
    // A caller that awaits keeps the process alive; a background run must not delay its exit.
    if (background) worker.unref();
    worker.on('message', (result: IntegrityResult) => { results.push(result); onResult?.(result); });
    worker.on('error', () => undefined);
    worker.once('exit', () => { clearTimeout(timer); resolve(results); });
  });
}

export const RESTORE_HINT = 'Stop Riffet and run `riffet restore --backup <dir> --state-dir <empty dir>`, then start with that state directory.';

/**
 * Checks `workbench.db` and `journal.db` once, a while after start. A failure is only logged: neither file is
 * touched, because a partly readable database still holds more than an empty one would.
 * Returns how to cancel the wait.
 */
export function startIntegrityCheck(stateDir: string, options: { enabled?: boolean } = {}): () => void {
  if (options.enabled === false) return () => undefined;
  const layout = storageLayoutForStateDir(stateDir);
  if (!existsSync(layout.control)) return () => undefined;
  const timer = setTimeout(() => {
    void runIntegrityChecks(stateDir, ['workbench', 'journal'], result => {
      if (result.status === 'fail') console.error(`[riffet] ${result.id}.db failed its integrity check (${result.detail}). ${RESTORE_HINT}`);
    }, true);
  }, INTEGRITY_BUDGET.startDelayMs);
  timer.unref();
  return () => clearTimeout(timer);
}
