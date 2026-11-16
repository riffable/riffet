import { existsSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StorageCompaction, StorageCompactionResult } from '../../../../packages/contracts/src/index.js';
import { claimStateDirectory } from '../compat.js';

/*
 * Compacting `workbench.db` (docs/guide/performance.md §3.7). Rows dropped by retention only return disk
 * space after a VACUUM, which rewrites the whole file and holds every writer off while it runs, so it
 * never runs beside a serving connection: either `riffet doctor --compact` with the service stopped, or
 * at the service's next start, before anything opens the database (`runRequestedCompaction`). The
 * settings page asks for the latter by leaving a request in the state directory.
 */

/** Left by the settings page; read and removed at the next start, so a crash in the middle is not retried forever. */
const REQUEST = 'compact-on-start.json';
/** The last attempt, for the settings page. */
const RESULT = 'compaction.json';
/**
 * Present while a compaction runs, with the running process's pid: the Mac app keeps waiting for a
 * service that has not started listening yet, instead of calling the start failed.
 */
const MAINTENANCE = 'maintenance.json';

const databasePath = (stateDir: string) => join(stateDir, 'workbench.db');

/** How long anything waiting for a start gives a compaction before calling the start failed. */
export const COMPACTION_WAIT_MS = 30 * 60_000;

interface Maintenance { task?: string; pid?: number; startedAt?: string; bytes?: number }

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** A compaction is holding the service's start: what `riffet start` keeps waiting for. */
export function compactionRunning(stateDir: string): boolean {
  const record = readJson<Maintenance>(join(stateDir, MAINTENANCE));
  return Number.isSafeInteger(record?.pid) && record!.pid! > 0 && alive(record!.pid!);
}

/** The database file plus its write-ahead log. */
export function databaseBytes(stateDir: string): number {
  const path = databasePath(stateDir);
  const size = (file: string) => statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  return size(path) + size(`${path}-wal`);
}

/** A rebuilt copy plus the log the rebuild writes. */
const requiredBytes = (bytes: number) => 2 * bytes;

const writeJson = (path: string, value: unknown) => {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
};

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; }
}

export function compactionState(stateDir: string): StorageCompaction {
  const scheduledAt = readJson<{ requestedAt?: unknown }>(join(stateDir, REQUEST))?.requestedAt;
  const last = readJson<StorageCompactionResult>(join(stateDir, RESULT));
  return {
    ...(typeof scheduledAt === 'string' ? { scheduledAt } : {}),
    ...(last && typeof last.at === 'string' ? { last } : {}),
    requiredBytes: requiredBytes(databaseBytes(stateDir)),
  };
}

export function scheduleCompaction(stateDir: string, scheduled: boolean): StorageCompaction {
  if (scheduled) writeJson(join(stateDir, REQUEST), { requestedAt: new Date().toISOString() });
  else rmSync(join(stateDir, REQUEST), { force: true });
  return compactionState(stateDir);
}

/**
 * Rebuilds the database with VACUUM and switches it to incremental auto-vacuum, so pages freed later can
 * be given back without another rebuild. Refuses while another live process holds the state directory;
 * the process that already holds it (the service at its start) may run it.
 */
export function compactDatabase(stateDir: string, log: (line: string) => void = console.log): { before: number; after: number } {
  const path = databasePath(stateDir);
  if (!existsSync(path)) throw new Error(`No database at ${path}`);
  let release: () => void;
  try { release = claimStateDirectory(stateDir); } catch (error) {
    // Only a held lock means "stop the server"; any other failure (permissions, a missing directory) keeps its own message.
    if (/already in use by a live server|lock has no valid owner/.test((error as Error).message)) throw new Error('Stop the server before compacting: server.lock in the state directory is held by a running process, or has no valid owner.');
    throw error;
  }
  try {
    const before = databaseBytes(stateDir);
    const free = statfsSync(stateDir);
    const available = free.bavail * free.bsize;
    if (available < requiredBytes(before)) throw new Error(`Not enough free disk space: VACUUM needs about ${mib(requiredBytes(before))} (a rebuilt copy plus journal growth) and ${mib(available)} is available`);
    // VACUUM builds its copy in SQLite's temp directory, which may be a small tmpfs: keep it beside the
    // database. SQLite reads the variable once, when it first initializes, and keeps the pointer it got,
    // so it is set before the first connection of the process and never put back.
    process.env.SQLITE_TMPDIR ??= stateDir;
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA temp_store=FILE');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.exec('PRAGMA auto_vacuum=INCREMENTAL');
      log(`Compacting ${path} (${mib(before)}); this can take several minutes.`);
      db.exec('VACUUM');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { db.close(); }
    const after = databaseBytes(stateDir);
    log(`Done: ${mib(before)} -> ${mib(after)}`);
    return { before, after };
  } finally { release(); }
}

/** Records the outcome where the settings page reads it; the CLI's own runs are shown there too. */
export function recordCompaction(stateDir: string, run: () => { before: number; after: number }): StorageCompactionResult {
  const started = Date.now();
  const beforeBytes = databaseBytes(stateDir);
  let result: StorageCompactionResult;
  try {
    const { after } = run();
    result = { at: new Date().toISOString(), beforeBytes, afterBytes: after, durationMs: Date.now() - started };
  } catch (error) {
    result = { at: new Date().toISOString(), beforeBytes, durationMs: Date.now() - started, error: (error as Error).message };
  }
  try { writeJson(join(stateDir, RESULT), result); } catch { /* The page simply shows no last run. */ }
  return result;
}

/**
 * Called by the service at its start, holding the state directory and before the store opens. Never
 * throws: a compaction that cannot run leaves its reason for the settings page, and the service starts.
 */
export function runRequestedCompaction(stateDir: string, log: (line: string) => void = console.log): void {
  const maintenance = join(stateDir, MAINTENANCE);
  // The caller holds the state directory, so a record left here is from a run that was killed (a stop
  // or a kickstart during the rebuild, which SQLite rolls back). Say so on the page, and let the Mac
  // app stop waiting for it.
  const left = readJson<Maintenance>(maintenance);
  if (left) {
    const startedAt = typeof left.startedAt === 'string' ? Date.parse(left.startedAt) : NaN;
    const interrupted: StorageCompactionResult = { at: new Date().toISOString(), beforeBytes: typeof left.bytes === 'number' ? left.bytes : databaseBytes(stateDir), durationMs: Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0, error: 'The service stopped before the rebuild finished; the database was left as it was.' };
    try { writeJson(join(stateDir, RESULT), interrupted); } catch { /* The page simply shows no last run. */ }
  }
  rmSync(maintenance, { force: true });
  const request = join(stateDir, REQUEST);
  if (!existsSync(request)) return;
  rmSync(request, { force: true });
  try { writeJson(maintenance, { task: 'compact', pid: process.pid, startedAt: new Date().toISOString(), bytes: databaseBytes(stateDir) }); } catch { /* Only the Mac app's patience depends on it. */ }
  try {
    const result = recordCompaction(stateDir, () => compactDatabase(stateDir, log));
    if (result.error) log(`Compaction skipped: ${result.error}`);
  } finally { rmSync(maintenance, { force: true }); }
}

const mib = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MiB`;
