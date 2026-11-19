import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StorageCompaction, StorageCompactionResult } from '../../../../packages/contracts/src/index.js';
import { claimStateDirectory } from '../compat.js';
import { Journal } from '../journal/journal.js';
import { migrateStorageLayout, needsStorageLayoutMigration } from '../journal/storage-migration.js';
import { storageLayoutForStateDir } from '../sqlite-storage.js';
import { deduplicateCheckpointsSync } from './checkpoints-dedup.js';

/*
 * Compacting and migrating the Riffet databases (docs/guide/performance.md §3.7).
 *
 * Rows dropped by retention only return disk space on demand (via incremental_vacuum for databases
 * in `auto_vacuum=INCREMENTAL` mode) or via a full VACUUM, which rewrites each file while no other
 * connection is open: either `riffet doctor --compact` with the service stopped, or at the service's
 * next start, before anything opens the databases (`runRequestedCompaction`).
 */

/** Left by the settings page; read and removed at the next start, so a crash in the middle is not retried forever. */
const REQUEST = 'compact-on-start.json';
/** The last attempt, for the settings page. */
const RESULT = 'compaction.json';
/**
 * Present while a compaction or layout migration runs, with the running process's pid: the Mac app
 * and `riffet start` keep waiting for a service that has not started listening yet.
 */
const MAINTENANCE = 'maintenance.json';

/** How long anything waiting for a start gives a compaction or migration before calling the start failed. */
export const COMPACTION_WAIT_MS = 30 * 60_000;

interface Maintenance { task?: string; pid?: number; startedAt?: string; bytes?: number }

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** A compaction or migration is holding the service's start: what `riffet start` keeps waiting for. */
export function compactionRunning(stateDir: string): boolean {
  const record = readJson<Maintenance>(join(stateDir, MAINTENANCE));
  return Number.isSafeInteger(record?.pid) && record!.pid! > 0 && alive(record!.pid!);
}

function fileSize(path: string): number {
  return statSync(path, { throwIfNoEntry: false })?.size ?? 0;
}

/** Total size of a directory tree on disk (used for the Tier-2 `blobs/` pool). */
export function directoryBytes(root: string): number {
  if (!existsSync(root)) return 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length) {
    const next = pending.pop()!;
    let info;
    try { info = lstatSync(next); } catch { continue; }
    if (!info.isDirectory()) { bytes += info.size; continue; }
    let names: string[];
    try { names = readdirSync(next); } catch { continue; }
    for (const name of names) pending.push(join(next, name));
  }
  return bytes;
}

/** Existing SQLite database files belonging to this state directory (L0 + L1 + L2). */
export function databaseFiles(stateDir: string): string[] {
  const layout = storageLayoutForStateDir(stateDir);
  return [layout.control, layout.journal, layout.derived].filter(path => existsSync(path));
}

/** Bytes of SQLite database files plus their write-ahead logs (excluding external `blobs/`). */
export function sqliteFilesBytes(stateDir: string): number {
  let total = 0;
  for (const path of databaseFiles(stateDir)) total += fileSize(path) + fileSize(`${path}-wal`);
  return total;
}

/** Total storage held by the databases (`workbench.db`, `journal.db`, `derived.db`, WALs) plus Tier-2 `blobs/`. */
export function databaseBytes(stateDir: string): number {
  const layout = storageLayoutForStateDir(stateDir);
  return sqliteFilesBytes(stateDir) + directoryBytes(layout.blobsDir);
}

/** Space required to safely VACUUM the largest SQLite file (a rebuilt copy plus its journal). */
const requiredBytes = (stateDir: string) => {
  let largest = 0;
  for (const path of databaseFiles(stateDir)) {
    largest = Math.max(largest, fileSize(path) + fileSize(`${path}-wal`));
  }
  return 2 * largest;
};

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
    requiredBytes: requiredBytes(stateDir),
  };
}

export function scheduleCompaction(stateDir: string, scheduled: boolean): StorageCompaction {
  if (scheduled) writeJson(join(stateDir, REQUEST), { requestedAt: new Date().toISOString() });
  else rmSync(join(stateDir, REQUEST), { force: true });
  return compactionState(stateDir);
}

function vacuumOne(path: string, log: (line: string) => void): void {
  const before = fileSize(path) + fileSize(`${path}-wal`);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA temp_store=FILE');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA auto_vacuum=INCREMENTAL');
    log(`Compacting ${path} (${mib(before)})...`);
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  const after = fileSize(path) + fileSize(`${path}-wal`);
  log(`Done ${path}: ${mib(before)} -> ${mib(after)}`);
}

/**
 * Rebuilds the databases with VACUUM and switches each to incremental auto-vacuum, so pages freed later
 * can be given back without another rebuild. Also runs full journal compaction (stripping superseded
 * revisions and sweeping unreferenced blobs) before vacuuming `journal.db`.
 * Refuses while another live process holds the state directory.
 */
export function compactDatabase(stateDir: string, log: (line: string) => void = console.log): { before: number; after: number } {
  const layout = storageLayoutForStateDir(stateDir);
  if (!existsSync(layout.control)) throw new Error(`No database at ${layout.control}`);
  let release: () => void;
  try { release = claimStateDirectory(stateDir); } catch (error) {
    // Only a held lock means "stop the server"; any other failure (permissions, a missing directory) keeps its own message.
    if (/already in use by a live server|lock has no valid owner/.test((error as Error).message)) throw new Error('Stop the server before compacting: server.lock in the state directory is held by a running process, or has no valid owner.');
    throw error;
  }
  try {
    const before = databaseBytes(stateDir);
    const needed = requiredBytes(stateDir);
    const free = statfsSync(stateDir);
    const available = free.bavail * free.bsize;
    if (available < needed) throw new Error(`Not enough free disk space: VACUUM needs about ${mib(needed)} (a rebuilt copy plus journal growth) and ${mib(available)} is available`);
    // VACUUM builds its copy in SQLite's temp directory, which may be a small tmpfs: keep it beside the
    // database. SQLite reads the variable once, when it first initializes, and keeps the pointer it got,
    // so it is set before the first connection of the process and never put back.
    process.env.SQLITE_TMPDIR ??= stateDir;

    if (needsStorageLayoutMigration(layout.control)) {
      migrateStorageLayout(layout.control, log);
    }

    // Strip any pending superseded revisions and unreferenced blobs in `journal.db` before vacuuming.
    if (existsSync(layout.journal)) {
      const jdb = new DatabaseSync(layout.journal);
      try {
        const journal = new Journal(jdb, undefined, undefined, undefined, { blobsDir: layout.blobsDir });
        const stats = journal.maintainAll({ minAgeMs: 0, maxUpdates: 200_000 });
        if (stats.drafts || stats.superseded || stats.blobs || stats.externalFiles) {
          log(`Journal housekeeping: ${stats.drafts} drafts, ${stats.superseded} superseded revisions, ${stats.blobs} blobs, ${stats.externalFiles} orphan files removed.`);
        }
      } finally { jdb.close(); }
    }

    for (const file of databaseFiles(stateDir)) vacuumOne(file, log);
    const dedup = deduplicateCheckpointsSync(stateDir);
    if (dedup.linkedFiles || dedup.prunedObjects) {
      log(`Checkpoints: deduplicated ${dedup.linkedFiles} files (${mib(dedup.savedBytes)} saved), pruned ${dedup.prunedObjects} orphan objects.`);
    }
    rmSync(join(stateDir, 'storage-scan.json'), { force: true });
    const after = databaseBytes(stateDir);
    log(`Total: ${mib(before)} -> ${mib(after)}`);
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
 * Called by the service at its start (while holding the state directory, before opening `Store`):
 * migrates a legacy single-file `workbench.db` into the three-database layout while signalling
 * `maintenance.json` so `riffet start` and the Mac app keep waiting cleanly.
 */
export function runStorageMigrationIfNeeded(stateDir: string, log: (line: string) => void = console.log): void {
  const layout = storageLayoutForStateDir(stateDir);
  if (!needsStorageLayoutMigration(layout.control)) return;
  const maintenance = join(stateDir, MAINTENANCE);
  try { writeJson(maintenance, { task: 'migrate', pid: process.pid, startedAt: new Date().toISOString(), bytes: databaseBytes(stateDir) }); } catch { /* best effort */ }
  try {
    migrateStorageLayout(layout.control, log);
  } finally {
    rmSync(maintenance, { force: true });
  }
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
  if (left && left.task === 'compact') {
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
