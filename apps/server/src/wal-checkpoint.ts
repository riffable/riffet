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
 */
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { statSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.path, { timeout: 0 });
const checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
let seen = -1;
const timer = setInterval(() => {
  let changed;
  try { changed = statSync(workerData.path + '-wal').mtimeMs; } catch { return; }
  // The log's file only changes when a commit appends to it: an idle database is left alone.
  if (changed === seen) return;
  try { checkpoint.get(); seen = changed; } catch {}
}, workerData.pollMs);
parentPort.on('message', () => { clearInterval(timer); try { db.close(); } catch {} parentPort.close(); });
`;

/**
 * Moves the write-ahead log's checkpoints of the database at `path` to a worker thread with a connection
 * of its own. Left to itself, the commit that crosses the page limit copies the log into the database file
 * and syncs it before it returns: on a database of several gigabytes with scattered pages that one commit
 * took about a second of the event loop in the served daemon's stall profiles (docs/DELIVERY.md §7).
 *
 * `db` is the serving connection; its own limit is raised while the worker runs and put back if the worker
 * ends on its own. Returns how to stop, to be called before `db` closes.
 */
export function startWalCheckpoints(db: DatabaseSync, path: string): () => Promise<void> {
  let worker: Worker;
  try { worker = new Worker(WORKER, { eval: true, name: 'riffet-wal', workerData: { path, pollMs: POLL_MS } }); }
  catch { return async () => undefined; }
  let stopping = false;
  const setLimit = (pages: number): void => { try { db.exec(`PRAGMA wal_autocheckpoint=${pages}`); } catch { /* The database is already closed. */ } };
  const exited = new Promise<void>(resolve => worker.once('exit', () => { if (!stopping) setLimit(DEFAULT_PAGES); resolve(); }));
  // Its exit is what restores the limit; an uncaught error in the worker always ends in one.
  worker.on('error', () => undefined);
  worker.unref();
  setLimit(BACKSTOP_PAGES);
  return async () => {
    if (stopping) return exited;
    stopping = true;
    setLimit(DEFAULT_PAGES);
    // Held until it has closed its connection, so a caller with nothing else pending still sees the stop finish.
    worker.ref();
    try { worker.postMessage('stop'); } catch { /* It has already exited. */ }
    const timer = setTimeout(() => { void worker.terminate(); }, STOP_WAIT_MS);
    timer.unref();
    await exited;
    clearTimeout(timer);
  };
}
