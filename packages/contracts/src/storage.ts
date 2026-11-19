/**
 * What the service keeps on disk, for the storage page in settings (`GET /api/system/storage`). The
 * cheap figures (file sizes, free pages, free disk) are read on every request; the breakdown needs a
 * full read of the databases and the state directory, so it comes from a scan that runs in the
 * background. The last finished scan is saved and shown until the next one finishes (`scan`).
 */
export interface StorageReport {
  generatedAt: string;
  /** The state directory, as the server sees it. */
  directory: string;
  disk: { freeBytes: number; totalBytes: number };
  database: StorageDatabase;
  /** Absent until a first scan has finished a step. */
  scan?: StorageScan;
  scanning: boolean;
  /**
   * Why the last scan did not finish. Opening the page does not start another for a while
   * (`STORAGE_SCAN_MS.retry`); a rescan by hand does.
   */
  scanError?: string;
  compaction: StorageCompaction;
  /** The last online maintenance run (`POST /api/system/storage/maintain`), if any. */
  maintenance?: StorageMaintenanceResult;
}

/** The three physical database layers of the state directory. */
export type StorageStoreKind = 'control' | 'journal' | 'derived';

export interface StorageStoreUsage {
  kind: StorageStoreKind;
  /** Bytes on disk (SQLite file + WAL, plus Tier-2 `blobs/` for `journal`). */
  bytes: number;
  /** Freed pages inside this SQLite file. */
  freeBytes: number;
  /** True for pure materialized caches (`derived.db`) that can be dropped and rebuilt from L0/L1. */
  rebuildable?: boolean;
}

export interface StorageDatabase {
  /** Total bytes across `workbench.db`, `journal.db` (+ `blobs/`), `derived.db`, and their WALs. */
  bytes: number;
  walBytes: number;
  /** Pages SQLite has freed; returned automatically in small steps when `incremental` is true, or all at once via VACUUM. */
  freeBytes: number;
  /** `auto_vacuum=INCREMENTAL` across all databases: the service gives freed pages back on its own, a little at a time. */
  incremental: boolean;
  /** Breakdown across the three physical layers (control, journal, derived cache). */
  stores?: StorageStoreUsage[];
}

/** How the databases' used pages divide up. */
export type StorageDatabasePart = 'journal' | 'timeline' | 'blobs' | 'search' | 'records' | 'other';

/** Top-level entries of the state directory, grouped by what they hold. The databases and `blobs/` are excluded. */
export type StorageFolderKind = 'checkpoints' | 'worktrees' | 'attachments' | 'tasks' | 'plugins' | 'logs' | 'other';

/** The steps of a scan, which finish in this order. */
export type StorageScanStep = 'folders' | 'sessions' | 'parts';

export interface StorageScan {
  at: string;
  durationMs: number;
  /**
   * Only while a first scan is still running: the steps it has not finished, whose lists are empty
   * until then. Once a scan has finished, a later one runs behind it and this is absent.
   */
  pending?: StorageScanStep[];
  parts: Array<{ part: StorageDatabasePart; bytes: number }>;
  folders: Array<{ kind: StorageFolderKind; bytes: number; files: number }>;
  /**
   * Largest first. `projectId` is absent for what a deleted project left behind (checkpoints,
   * worktrees); `sessionBytes` counts its conversations' history and timeline.
   */
  projects: StorageProjectUsage[];
  /** The conversations with the most stored history, largest first. */
  sessions: StorageSessionUsage[];
}

export interface StorageProjectUsage {
  projectId?: string;
  name?: string;
  sessionBytes: number;
  checkpointBytes: number;
  worktreeBytes: number;
}

export interface StorageSessionUsage {
  sessionId: string;
  title: string;
  projectId: string;
  projectName?: string;
  bytes: number;
  lastActivityAt?: string;
}

export interface StorageCompaction {
  /** A full rebuild waits for the service's next start, which it delays: each database is vacuumed before anything opens it. */
  scheduledAt?: string;
  last?: StorageCompactionResult;
  /** Free disk the rebuild needs: twice the largest SQLite file. */
  requiredBytes: number;
}

export interface StorageCompactionResult {
  at: string;
  beforeBytes: number;
  afterBytes?: number;
  durationMs: number;
  /** Why it did not run or did not finish; the databases were left as they were. */
  error?: string;
}

/** Outcome of an online maintenance pass (cold timeline sweep, journal compaction, incremental vacuum, checkpoint dedup). */
export interface StorageMaintenanceResult {
  at: string;
  beforeBytes: number;
  afterBytes: number;
  durationMs: number;
  checkpointsSavedBytes?: number;
  coldSessionsDropped?: number;
}
