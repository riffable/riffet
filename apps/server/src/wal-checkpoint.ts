import type { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

/** SQLite's own default: the connection that commits past this many WAL pages checkpoints them itself. */
const DEFAULT_PAGES = 1000;
/**
 * The serving connection's limit while the worker checkpoints for it: far enough out that it is never
 * reached in normal running, near enough that the log stays bounded (about 80 MB) if the worker stalls.
 */
const BACKSTOP_PAGES = 20_000;
const POLL_MS = 2_000;
const STOP_WAIT_MS = 2_000;

/**
 * CommonJS, evaluated in the worker (see `exec.ts`). A passive checkpoint never waits for a reader or the
 * writer and never makes them wait; it copies what it can and leaves the rest for the next round.
 * One worker watches every SQLite database file of the instance so companion databases cost no extra threads.
 */
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { statSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const targets = workerData.paths.map(path => {
  const db = new DatabaseSync(path, { timeout: 0 });
  return { path, db, checkpoint: db.prepare('PRAGMA wal_checkpoint(PASSIVE)'), seen: -1 };
});
const timer = setInterval(() => {
  for (const target of targets) {
    let changed;
    try { changed = statSync(target.path + '-wal').mtimeMs; } catch { continue; }
    // The log's file only changes when a commit appends to it: an idle database is left alone.
    if (changed === target.seen) continue;
    try { target.checkpoint.get(); target.seen = changed; } catch {}
  }
}, workerData.pollMs);
parentPort.on('message', () => {
  clearInterval(timer);
  for (const target of targets) { try { target.db.close(); } catch {} }
  parentPort.close();
});
`;

export interface WalTarget { db: DatabaseSync; path: string }

/**
 * Moves write-ahead log checkpoints of one or more databases to a single worker thread with connections
 * of its own. Left to itself, the commit that crosses the page limit copies the log into the database file
 * and syncs it before it returns: on a database of several gigabytes with scattered pages that one commit
 * took about a second of the event loop in the served daemon's stall profiles (docs/DELIVERY.md §7).
 *
 * Returns how to stop, to be called before any watched database closes.
 */
export function startWalCheckpoints(
  targetOrTargets: DatabaseSync | readonly WalTarget[],
  singlePath?: string,
): () => Promise<void> {
  const rawTargets: readonly WalTarget[] = Array.isArray(targetOrTargets)
    ? targetOrTargets
    : singlePath
      ? [{ db: targetOrTargets as DatabaseSync, path: singlePath }]
      : [];
  const targets = rawTargets.filter(target => target.path && target.path !== ':memory:');
  if (!targets.length) return async () => undefined;
  let worker: Worker;
  try { worker = new Worker(WORKER, { eval: true, name: 'riffet-wal', workerData: { paths: targets.map(t => t.path), pollMs: POLL_MS } }); }
  catch { return async () => undefined; }
  let stopping = false;
  const setLimits = (pages: number): void => {
    for (const { db } of targets) {
      try { db.exec(`PRAGMA wal_autocheckpoint=${pages}`); } catch { /* The database is already closed. */ }
    }
  };
  const exited = new Promise<void>(resolve => worker.once('exit', () => { if (!stopping) setLimits(DEFAULT_PAGES); resolve(); }));
  // Its exit is what restores the limit; an uncaught error in the worker always ends in one.
  worker.on('error', () => undefined);
  worker.unref();
  setLimits(BACKSTOP_PAGES);
  return async () => {
    if (stopping) return exited;
    stopping = true;
    setLimits(DEFAULT_PAGES);
    // Held until it has closed its connections, so a caller with nothing else pending still sees the stop finish.
    worker.ref();
    try { worker.postMessage('stop'); } catch { /* It has already exited. */ }
    const timer = setTimeout(() => { void worker.terminate(); }, STOP_WAIT_MS);
    timer.unref();
    await exited;
    clearTimeout(timer);
  };
}
