import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STORAGE_BUDGET } from '../../../packages/contracts/src/budgets.js';
import { eventLoopBusy } from './loop-health.js';

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

/** Opens a SQLite database with incremental auto-vacuum, WAL mode and NORMAL durability. */
export function openSqliteDatabase(path: string, options: { foreignKeys?: boolean; timeout?: number } = {}): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { timeout: options.timeout ?? 5000 });
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec(`PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;${options.foreignKeys ? ' PRAGMA foreign_keys=ON;' : ''}`);
  return db;
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
