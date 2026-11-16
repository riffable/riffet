/**
 * What the service keeps on disk, for the storage page in settings (`GET /api/system/storage`). The
 * cheap figures (file sizes, free pages, free disk) are read on every request; the breakdown needs a
 * full read of the database and the state directory, so it comes from a scan that runs in the
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
  compaction: StorageCompaction;
}

export interface StorageDatabase {
  /** `workbench.db` plus its write-ahead log. */
  bytes: number;
  walBytes: number;
  /** Pages SQLite has freed and will reuse; only a compaction returns them to the disk. */
  freeBytes: number;
  /** `auto_vacuum=INCREMENTAL`: the service gives freed pages back on its own, a little at a time. */
  incremental: boolean;
}

/** How the database's used pages divide up. */
export type StorageDatabasePart = 'journal' | 'timeline' | 'blobs' | 'search' | 'records' | 'other';

/** Top-level entries of the state directory, grouped by what they hold. The database is not one. */
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
  /** A compaction waits for the service's next start, which it delays: the database is rebuilt before anything opens it. */
  scheduledAt?: string;
  last?: StorageCompactionResult;
  /** Free disk the rebuild needs: a full copy of the database, plus the log it writes on the way. */
  requiredBytes: number;
}

export interface StorageCompactionResult {
  at: string;
  beforeBytes: number;
  afterBytes?: number;
  durationMs: number;
  /** Why it did not run or did not finish; the database is left as it was. */
  error?: string;
}
