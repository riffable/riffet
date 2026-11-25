import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { SERVER_PROFILE_BUDGET } from '../../../packages/contracts/src/budgets.js';
import { eventLoopBusy } from './loop-health.js';

/** SQLite's own default: the connection that commits past this many WAL pages checkpoints them itself. */
const DEFAULT_PAGES = 1000;
/**
 * The serving connection's limit while the worker checkpoints for it: far enough out that it is never
 * reached in normal running, near enough that the log stays bounded (about 80 MB) if the worker stalls.
 */
const BACKSTOP_PAGES = 20_000;
const POLL_MS = 2_000;
const INLINE_POLL_MS = 10_000;
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
  try { db.exec('PRAGMA cache_size=-256; PRAGMA mmap_size=0;'); } catch {}
  return { path, db, checkpoint: db.prepare('PRAGMA wal_checkpoint(PASSIVE)'), seen: -1 };
});
let lastChangeAt = Date.now();
const stop = () => {
  clearInterval(timer);
  for (const target of targets) { try { target.db.close(); } catch {} }
  parentPort.close();
};
const timer = setInterval(() => {
  let changedAny = false;
  for (const target of targets) {
    let changed;
    try { changed = statSync(target.path + '-wal').mtimeMs; } catch { continue; }
    // The log's file only changes when a commit appends to it: an idle database is left alone.
    if (changed === target.seen) continue;
    try { target.checkpoint.get(); target.seen = changed; changedAny = true; } catch {}
  }
  if (changedAny) {
    lastChangeAt = Date.now();
  } else if (workerData.idleMs > 0 && Date.now() - lastChangeAt >= workerData.idleMs) {
    stop();
  }
}, workerData.pollMs);
parentPort.on('message', stop);
`;

export interface WalTarget { db: DatabaseSync; path: string }
export interface WalCheckpointOptions {
  /** `'worker'` runs checkpoints off the event loop (with idle auto-exit); `'inline'` avoids spawning a worker isolate (for `lite` profile). */
  mode?: 'worker' | 'inline';
  /** Idle period (ms) with no WAL writes before the background worker exits to free its V8 isolate (0 keeps it resident). */
  idleMs?: number;
}

/**
 * Moves write-ahead log checkpoints of one or more databases off commit paths. In `'worker'` mode,
 * a single worker checkpoints active databases and exits after `idleMs` of WAL calm (respawning
 * automatically when any `-wal` file changes). In `'inline'` mode (`lite` profile), passive
 * checkpoints run on the existing connections only when the event loop is not busy, saving an entire
 * V8 isolate (~30 MB).
 *
 * Returns how to stop, to be called before any watched database closes.
 */
export function startWalCheckpoints(
  targetOrTargets: DatabaseSync | readonly WalTarget[],
  singlePath?: string,
  options: WalCheckpointOptions = {},
): () => Promise<void> {
  const rawTargets: readonly WalTarget[] = Array.isArray(targetOrTargets)
    ? targetOrTargets
    : singlePath
      ? [{ db: targetOrTargets as DatabaseSync, path: singlePath }]
      : [];
  const targets = rawTargets.filter(target => target.path && target.path !== ':memory:');
  if (!targets.length) return async () => undefined;

  if (options.mode === 'inline') {
    const seen = new Map<string, number>();
    const timer = setInterval(() => {
      if (eventLoopBusy()) return;
      for (const target of targets) {
        let changed: number;
        try { changed = statSync(`${target.path}-wal`).mtimeMs; } catch { continue; }
        if (changed === seen.get(target.path)) continue;
        try {
          target.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
          seen.set(target.path, changed);
        } catch { /* database busy or closed */ }
      }
    }, INLINE_POLL_MS);
    timer.unref();
    return async () => { clearInterval(timer); };
  }

  const idleMs = options.idleMs ?? SERVER_PROFILE_BUDGET.full.walWorkerIdleMs;
  const setLimits = (pages: number): void => {
    for (const { db } of targets) {
      try { db.exec(`PRAGMA wal_autocheckpoint=${pages}`); } catch { /* The database is already closed. */ }
    }
  };

  let stopping = false;
  let worker: Worker | undefined;
  let workerExited: Promise<void> = Promise.resolve();
  let lastSeen = new Map<string, number>();
  const snapshotWal = (): boolean => {
    let changed = false;
    for (const target of targets) {
      let mtime = -1;
      try { mtime = statSync(`${target.path}-wal`).mtimeMs; } catch { /* no wal yet */ }
      if (mtime > 0 && lastSeen.get(target.path) !== mtime) {
        lastSeen.set(target.path, mtime);
        changed = true;
      }
    }
    return changed;
  };

  const spawnWorker = (): boolean => {
    if (stopping || worker) return Boolean(worker);
    let created: Worker;
    try {
      created = new Worker(WORKER, {
        eval: true,
        name: 'riffet-wal',
        workerData: { paths: targets.map(t => t.path), pollMs: POLL_MS, idleMs },
      });
    } catch {
      return false;
    }
    worker = created;
    setLimits(BACKSTOP_PAGES);
    created.on('error', () => undefined);
    created.unref();
    workerExited = new Promise<void>(resolve => {
      created.once('exit', () => {
        if (worker === created) {
          worker = undefined;
          snapshotWal();
          if (!stopping) setLimits(DEFAULT_PAGES);
        }
        resolve();
      });
    });
    return true;
  };

  if (!spawnWorker()) return async () => undefined;

  // Lightweight wake monitor: when the worker exited after an idle spell, watch `-wal` mtimes and
  // respawn it as soon as new writes land (zero memory cost while idle).
  const wakeTimer = idleMs > 0
    ? setInterval(() => {
      if (stopping || worker) return;
      if (snapshotWal()) spawnWorker();
    }, POLL_MS)
    : undefined;
  wakeTimer?.unref();

  return async () => {
    if (stopping) return workerExited;
    stopping = true;
    if (wakeTimer) clearInterval(wakeTimer);
    setLimits(DEFAULT_PAGES);
    const active = worker;
    if (!active) return;
    // Held until it has closed its connections, so a caller with nothing else pending still sees the stop finish.
    active.ref();
    try { active.postMessage('stop'); } catch { /* It has already exited. */ }
    const timer = setTimeout(() => { void active.terminate(); }, STOP_WAIT_MS);
    timer.unref();
    await workerExited;
    clearTimeout(timer);
  };
}
