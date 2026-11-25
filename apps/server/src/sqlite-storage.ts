import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SERVER_PROFILE_BUDGET, STORAGE_BUDGET } from '../../../packages/contracts/src/budgets.js';
import { eventLoopBusy } from './loop-health.js';
import type { ServerProfile } from './memory/profile.js';

/**
 * Physical layout of the three SQLite databases and external Tier-2 blob pool rooted beside `workbench.db`:
 * - `workbench.db` (L0): authoritative control plane (sessions, projects, runs, work items, settings, stats).
 * - `journal.db` (L1): append-only event envelopes and compressed Tier-1 CAS blobs.
 * - `derived.db` (L2): rebuildable materialized views (timeline rows/turns/heads, message_index + FTS5).
 * - `blobs/` (L1 Tier-2): immutable sharded files for large compressed blobs (>= `STORAGE_BUDGET.blobExternalBytes`).
 */
export interface StorageLayoutPaths {
  stateDir: string;
  control: string;
  journal: string;
  derived: string;
  blobsDir: string;
}

export function storageLayoutForStateDir(stateDir: string): StorageLayoutPaths {
  return {
    stateDir,
    control: join(stateDir, 'workbench.db'),
    journal: join(stateDir, 'journal.db'),
    derived: join(stateDir, 'derived.db'),
    blobsDir: join(stateDir, 'blobs'),
  };
}

/** Derives the companion L1/L2/blobs paths for a `Store` path, or undefined for an in-memory store. */
export function storageLayoutForControlDb(controlDbPath: string): StorageLayoutPaths | undefined {
  if (controlDbPath === ':memory:') return undefined;
  const stateDir = dirname(controlDbPath);
  return {
    stateDir,
    control: controlDbPath,
    journal: join(stateDir, 'journal.db'),
    derived: join(stateDir, 'derived.db'),
    blobsDir: join(stateDir, 'blobs'),
  };
}

export type SqliteStoreRole = 'control' | 'journal' | 'derived';

/** Per-role page cache (KiB, negative for SQLite PRAGMA cache_size) and mmap ceiling (bytes), sized from `SERVER_PROFILE_BUDGET`. */
function roleTuning(role: SqliteStoreRole, profile: ServerProfile): { cacheKiB: number; mmapBytes: number } {
  const budget = SERVER_PROFILE_BUDGET[profile];
  if (role === 'control') return { cacheKiB: Math.floor(budget.controlCacheBytes / 1024), mmapBytes: budget.controlMmapBytes };
  if (role === 'journal') return { cacheKiB: Math.floor(budget.journalCacheBytes / 1024), mmapBytes: budget.journalMmapBytes };
  return { cacheKiB: Math.floor(budget.derivedCacheBytes / 1024), mmapBytes: budget.derivedMmapBytes };
}

/** Opens a SQLite database with incremental auto-vacuum, WAL mode, NORMAL durability, and role/profile-tuned cache/mmap settings. */
export function openSqliteDatabase(
  path: string,
  options: { foreignKeys?: boolean; timeout?: number; role?: SqliteStoreRole; profile?: ServerProfile } = {},
): DatabaseSync {
  const isDisk = path !== ':memory:';
  const profile = options.profile ?? 'full';
  if (isDisk) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { timeout: options.timeout ?? 5000 });
  if (isDisk) chmodSync(path, 0o600);
  const tuning = options.role ? roleTuning(options.role, profile) : undefined;
  const cachePragma = tuning ? ` PRAGMA cache_size=-${tuning.cacheKiB};` : '';
  const mmapPragma = isDisk && tuning ? ` PRAGMA mmap_size=${tuning.mmapBytes};` : '';
  const tempStore = profile === 'lite' ? 'FILE' : 'MEMORY';
  db.exec(
    `PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=${tempStore};${cachePragma}${mmapPragma}${options.foreignKeys ? ' PRAGMA foreign_keys=ON;' : ''}`,
  );
  return db;
}

/** Releases as much non-essential SQLite page cache memory as possible back to the OS allocator. */
export function shrinkSqliteMemory(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA shrink_memory');
  } catch { /* connection closed or read-only */ }
}

/** Runs SQLite's lightweight planner statistics refresh (`PRAGMA optimize`); safe to call on idle maintenance and before close. */
export function optimizeDatabase(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA optimize');
  } catch { /* connection closed or read-only */ }
}

/** Lightweight structural integrity check (`PRAGMA quick_check(1)`): catches corrupt pages eagerly on startup. */
export function quickCheckDatabase(db: DatabaseSync): boolean {
  try {
    const row = db.prepare('PRAGMA quick_check(1)').get() as Record<string, unknown> | undefined;
    const value = row ? Object.values(row)[0] : undefined;
    return value === 'ok';
  } catch {
    return false;
  }
}

/**
 * Gives freed pages back to the OS in bounded steps without blocking the event loop.
 * Only runs on databases in `auto_vacuum=INCREMENTAL` mode (2) when free pages pass `minFreePages`.
 * Returns how many pages were reclaimed.
 */
export function reclaimFreePages(
  db: DatabaseSync,
  options: { minFreePages?: number; maxPages?: number; busy?: () => boolean } = {},
): number {
  const minFreePages = options.minFreePages ?? STORAGE_BUDGET.vacuumMinFreePages;
  const maxPages = options.maxPages ?? STORAGE_BUDGET.vacuumStepPages;
  const busy = options.busy ?? eventLoopBusy;
  if (busy()) return 0;
  try {
    const mode = Number((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum?: number } | undefined)?.auto_vacuum ?? 0);
    if (mode !== 2) return 0;
    const before = Number((db.prepare('PRAGMA freelist_count').get() as { freelist_count?: number } | undefined)?.freelist_count ?? 0);
    if (before < minFreePages) return 0;
    const step = Math.min(before, maxPages);
    db.exec(`PRAGMA incremental_vacuum(${step})`);
    const after = Number((db.prepare('PRAGMA freelist_count').get() as { freelist_count?: number } | undefined)?.freelist_count ?? 0);
    return Math.max(0, before - after);
  } catch {
    return 0;
  }
}
