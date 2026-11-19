import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { STORAGE_BUDGET, STORAGE_SCAN_MS } from '../../../../packages/contracts/src/budgets.js';
import type { StorageDatabasePart, StorageFolderKind, StorageMaintenanceResult, StorageProjectUsage, StorageReport, StorageScan, StorageScanStep, StorageStoreUsage } from '../../../../packages/contracts/src/index.js';
import { storageLayoutForStateDir } from '../sqlite-storage.js';
import type { Store } from '../store.js';
import { deduplicateCheckpoints } from './checkpoints-dedup.js';
import { compactionState, databaseBytes, databaseFiles, directoryBytes } from './compaction.js';

/** The last finished scan, as the worker measured it: names and titles are looked up when it is read. */
const SAVED = 'storage-scan.json';
/** Bumped when the database layout changes so stale pre-migration scans are automatically discarded. */
const SCAN_VERSION = 2;
const MAINTENANCE_RESULT = 'storage-maintenance.json';
const TOP_SESSIONS = 12;
const TOP_PROJECTS = 20;
const MAX_ONLINE_VACUUM_ROUNDS = 32;

/**
 * CommonJS, evaluated in the worker (see `wal-checkpoint.ts`). Everything here reads the databases
 * or walks the state directory, which is why it never runs on the event loop. One worker per step,
 * run side by side. Each query is its own statement, so no read transaction outlives it.
 */
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { existsSync, lstatSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function measure(path) {
  let bytes = 0, files = 0;
  const seen = new Set();
  const pending = [path];
  while (pending.length) {
    const next = pending.pop();
    let info;
    try { info = lstatSync(next); } catch { continue; }
    if (!info.isDirectory()) {
      if (info.nlink > 1) {
        const key = info.dev + ':' + info.ino;
        if (seen.has(key)) continue;
        seen.add(key);
      }
      bytes += typeof info.blocks === 'number' ? info.blocks * 512 : info.size;
      files += 1;
      continue;
    }
    bytes += typeof info.blocks === 'number' ? info.blocks * 512 : info.size;
    let names;
    try { names = readdirSync(next); } catch { continue; }
    for (const name of names) pending.push(join(next, name));
  }
  return { bytes, files };
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

const { stateDir, databases, split, step } = workerData;
const isDbEntry = (name) => name === 'blobs' || databases.some(db => name === db || name.startsWith(db + '-'));

if (step === 'folders') {
  const entries = [];
  const children = [];
  for (const name of readdirSync(stateDir)) {
    if (isDbEntry(name)) continue;
    const path = join(stateDir, name);
    entries.push({ name, ...measure(path) });
    if (split.includes(name)) {
      let names = [];
      try { names = readdirSync(path); } catch {}
      for (const child of names) children.push({ parent: name, name: child, bytes: measure(join(path, child)).bytes });
    }
  }
  parentPort.postMessage({ entries, children });
} else if (step === 'sessions') {
  // perf-rules: allow lives only as long as this one-shot worker
  const sessions = new Map();
  const add = (rows) => {
    for (const row of rows) {
      const root = row.id.includes('#') ? row.id.slice(0, row.id.indexOf('#')) : row.id;
      sessions.set(root, (sessions.get(root) ?? 0) + Number(row.bytes));
    }
  };
  for (const file of databases) {
    const full = join(stateDir, file);
    if (!existsSync(full)) continue;
    const db = new DatabaseSync(full, { readOnly: true, timeout: 5000 });
    try {
      if (hasTable(db, 'timeline_rows')) {
        add(db.prepare("SELECT session_id AS id, SUM(bytes) AS bytes FROM timeline_rows GROUP BY session_id").all());
      }
      if (hasTable(db, 'journal_events')) {
        add(db.prepare("SELECT session_id AS id, SUM(octet_length(payload)) AS bytes FROM journal_events GROUP BY session_id").all());
        if (hasTable(db, 'blobs')) {
          add(db.prepare("SELECT e.session_id AS id, SUM(CASE WHEN b.stored_size>0 THEN b.stored_size ELSE b.size END) AS bytes FROM journal_events e JOIN blobs b ON b.hash=e.blob_ref WHERE e.blob_ref IS NOT NULL GROUP BY e.session_id").all());
        }
      }
    } finally { db.close(); }
  }
  parentPort.postMessage({ sessions: [...sessions].map(([id, bytes]) => ({ id, bytes })) });
} else {
  const pages = [];
  for (const file of databases) {
    const full = join(stateDir, file);
    if (!existsSync(full)) continue;
    const db = new DatabaseSync(full, { readOnly: true, timeout: 5000 });
    try {
      const rows = db.prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat WHERE aggregate=TRUE GROUP BY name").all();
      for (const row of rows) pages.push({ name: row.name, bytes: Number(row.bytes) });
    } finally { db.close(); }
  }
  const externalBlobs = join(stateDir, 'blobs');
  if (existsSync(externalBlobs)) {
    const { bytes } = measure(externalBlobs);
    if (bytes > 0) pages.push({ name: 'blobs_external', bytes });
  }
  parentPort.postMessage({ pages });
}
`;

/** A scan as the worker reports it; a step it has not reached yet is absent. */
interface WorkerResult {
  entries?: Array<{ name: string; bytes: number; files: number }>;
  children?: Array<{ parent: string; name: string; bytes: number }>;
  pages?: Array<{ name: string; bytes: number }>;
  sessions?: Array<{ id: string; bytes: number }>;
}

interface Measured { version?: number; at: string; durationMs: number; result: WorkerResult }

/** Per-project folders, named by a prefix of the project id's sha256 (`git/index.ts`). */
const PROJECT_FOLDERS = { checkpoints: 32, worktrees: 24, 'shadow-repos': 24 } as const;
const DATABASE_NAMES = ['workbench.db', 'journal.db', 'derived.db'] as const;

function databasePart(name: string): StorageDatabasePart {
  const table = name.replace(/^sqlite_autoindex_/, '');
  if (table.startsWith('journal')) return 'journal';
  if (table.startsWith('timeline')) return 'timeline';
  if (table.startsWith('blobs') || table.startsWith('session_blobs')) return 'blobs';
  if (table.startsWith('message_index')) return 'search';
  if (/^(events|tool_calls|usage_steps|runs)(_|$)/.test(table)) return 'records';
  return 'other';
}

function folderKind(name: string): StorageFolderKind {
  if (name === 'checkpoints') return 'checkpoints';
  if (name === 'worktrees' || name === 'shadow-repos') return 'worktrees';
  if (name === 'attachments') return 'attachments';
  if (name === 'tasks') return 'tasks';
  if (/^(plugins|plugin-data|plugin-cache|plugin-logs|integrations)$/.test(name)) return 'plugins';
  if (/^(client-logs|diagnostics)$/.test(name) || /\.log(\.\d+)?$/.test(name)) return 'logs';
  return 'other';
}

const sum = <K extends string>(items: Array<{ key: K; bytes: number; files?: number }>) => {
  const totals = new Map<K, { bytes: number; files: number }>();
  for (const item of items) {
    const total = totals.get(item.key) ?? { bytes: 0, files: 0 };
    total.bytes += item.bytes;
    total.files += item.files ?? 0;
    totals.set(item.key, total);
  }
  return [...totals].sort(([, a], [, b]) => b.bytes - a.bytes);
};

function fileSize(path: string): number {
  return statSync(path, { throwIfNoEntry: false })?.size ?? 0;
}

/**
 * The storage page's report (`GET /api/system/storage`): cheap figures on every read, the breakdown
 * from the last finished scan, which is saved in the state directory so a restart does not cost another
 * one. One scan runs at a time. Until a first scan finishes, the steps it has done are shown instead.
 */
export class StorageInspector {
  private finished?: Measured;
  private current?: Measured;
  private workers = new Set<Worker>();
  private closed = false;
  /** The last scan that did not finish, and why; it holds off the next automatic one (`STORAGE_SCAN_MS.retry`). */
  private failed?: { at: number; message: string; measured: Measured };
  private maintaining?: Promise<StorageReport>;
  /** Cached Tier-2 `blobs/` size so 2s polling of `GET /api/system/storage` avoids recursive sync FS walks. */
  private externalBlobsCache?: { bytes: number; at: number };

  constructor(private readonly options: {
    stateDir: string;
    store: Pick<Store, 'listSessions' | 'listProjects' | 'archivedSessionsBefore' | 'journal' | 'reclaimSpace'>;
    sweepColdTimeline?: () => Promise<number>;
  }) {
    this.finished = readSaved(join(options.stateDir, SAVED));
    const savedExt = this.finished?.result.pages?.find(page => page.name === 'blobs_external')?.bytes;
    if (typeof savedExt === 'number') this.externalBlobsCache = { bytes: savedExt, at: Date.parse(this.finished!.at) || Date.now() };
  }

  report(): StorageReport {
    const stale = !this.finished || Date.now() - Date.parse(this.finished.at) > STORAGE_SCAN_MS.stale;
    const backingOff = this.failed && Date.now() - this.failed.at < STORAGE_SCAN_MS.retry;
    if (!this.current && stale && !backingOff) this.scan();
    const { stateDir } = this.options;
    const disk = statfsSync(stateDir);
    // A failed first scan still shows the steps it finished.
    const shown = this.finished ?? this.current ?? this.failed?.measured;
    const maintenance = readMaintenance(join(stateDir, MAINTENANCE_RESULT));
    return {
      generatedAt: new Date().toISOString(),
      directory: stateDir,
      disk: { freeBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize },
      database: this.database(),
      ...(shown ? { scan: this.summarize(shown) } : {}),
      scanning: Boolean(this.current),
      ...(this.failed && !this.current ? { scanError: this.failed.message } : {}),
      compaction: compactionState(stateDir),
      ...(maintenance ? { maintenance } : {}),
    };
  }

  /**
   * Non-disruptive online maintenance (`POST /api/system/storage/maintain`): sweeps cold timeline
   * lanes, strips superseded journal revisions, trims old archived tool outputs, reclaims freed
   * SQLite pages incrementally, and hard-link deduplicates legacy checkpoints.
   */
  maintain(): Promise<StorageReport> {
    if (this.maintaining) return this.maintaining;
    const run = (async () => {
      const { stateDir, store, sweepColdTimeline } = this.options;
      const started = Date.now();
      const beforeDb = databaseBytes(stateDir);
      let coldSessionsDropped = 0;
      if (sweepColdTimeline) coldSessionsDropped = await sweepColdTimeline();
      if (STORAGE_BUDGET.archivedTrimDays > 0) {
        const archivedBefore = new Date(Date.now() - STORAGE_BUDGET.archivedTrimDays * 86_400_000).toISOString();
        const archivedIds = store.archivedSessionsBefore(archivedBefore);
        if (archivedIds.length) {
          store.journal.trimArchivedToolBlobs(archivedIds, { limit: 40 });
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      }
      store.journal.maintainAll({ minAgeMs: 0, maxUpdates: 5_000 });
      await new Promise<void>(resolve => setImmediate(resolve));
      for (let round = 0; round < MAX_ONLINE_VACUUM_ROUNDS && !this.closed; round += 1) {
        // Explicit user-triggered maintenance bypasses the idle lag gate so just-freed pages are reclaimed.
        const reclaimed = store.reclaimSpace({ busy: () => false });
        if (reclaimed.control + reclaimed.journal + reclaimed.derived === 0) break;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      // Checkpoint WALs so reclaimed pages show up accurately in `afterBytes`.
      store.reclaimSpace({ busy: () => false, checkpoint: true });
      const dedup = await deduplicateCheckpoints(stateDir);
      this.externalBlobsCache = undefined;
      const afterDb = databaseBytes(stateDir);
      const result: StorageMaintenanceResult = {
        at: new Date().toISOString(),
        beforeBytes: beforeDb + dedup.savedBytes,
        afterBytes: afterDb,
        durationMs: Date.now() - started,
        ...(dedup.savedBytes > 0 ? { checkpointsSavedBytes: dedup.savedBytes } : {}),
        ...(coldSessionsDropped > 0 ? { coldSessionsDropped } : {}),
      };
      try { writeJson(join(stateDir, MAINTENANCE_RESULT), result); } catch { /* best effort */ }
      this.invalidateScan();
      this.scan();
      return this.report();
    })();
    this.maintaining = run;
    void run.finally(() => { if (this.maintaining === run) this.maintaining = undefined; });
    return run;
  }

  /** Drops the cached scan file and aborts any in-flight scan so stale results cannot overwrite fresh ones. */
  invalidateScan(): void {
    this.current = undefined;
    for (const worker of this.workers) void worker.terminate();
    this.workers.clear();
    this.finished = undefined;
    this.failed = undefined;
    this.externalBlobsCache = undefined;
    rmSync(join(this.options.stateDir, SAVED), { force: true });
  }

  /** Starts a scan unless one is running. A failed scan keeps the previous breakdown. */
  scan(): void {
    if (this.current || this.closed) return;
    const started = Date.now();
    const current: Measured = { version: SCAN_VERSION, at: new Date(started).toISOString(), durationMs: 0, result: {} };
    this.current = current;
    let error: string | undefined;
    const steps: StorageScanStep[] = ['folders', 'sessions', 'parts'];
    const settle = () => {
      if (this.workers.size > 0 || this.current !== current) return;
      this.current = undefined;
      const { entries, sessions, pages } = current.result;
      if (entries && sessions && pages) this.failed = undefined;
      else this.failed = { at: Date.now(), message: error ?? 'The scan stopped before it finished', measured: current };
    };
    for (const step of steps) {
      let worker: Worker;
      try {
        worker = new Worker(WORKER, { eval: true, name: `riffet-storage-${step}`, workerData: { stateDir: this.options.stateDir, databases: [...DATABASE_NAMES], split: Object.keys(PROJECT_FOLDERS), step } });
      } catch (reason) {
        // The steps already started are stopped; their exits settle the scan as failed.
        error = (reason as Error).message;
        for (const started of this.workers) void started.terminate();
        settle();
        return;
      }
      this.workers.add(worker);
      worker.unref();
      worker.on('message', (result: WorkerResult) => {
        if (this.current !== current) return;
        Object.assign(current.result, result);
        const extBytes = result.pages?.find(page => page.name === 'blobs_external')?.bytes;
        if (typeof extBytes === 'number') this.externalBlobsCache = { bytes: extBytes, at: Date.now() };
        current.durationMs = Date.now() - started;
        const { entries, sessions, pages } = current.result;
        if (!entries || !sessions || !pages || this.closed) return;
        this.finished = { ...current, version: SCAN_VERSION, at: new Date().toISOString() };
        try { writeJson(join(this.options.stateDir, SAVED), this.finished); } catch { /* Kept in memory; the next start scans again. */ }
      });
      worker.once('error', (reason) => {
        error ??= reason.message;
        console.warn(`[riffet] storage scan (${step}) failed:`, reason.message);
      });
      worker.once('exit', () => {
        this.workers.delete(worker);
        settle();
      });
    }
  }

  close(): void {
    this.closed = true;
    for (const worker of this.workers) void worker.terminate();
  }

  private externalBlobsBytes(): number {
    const now = Date.now();
    if (this.externalBlobsCache && now - this.externalBlobsCache.at < 60_000) return this.externalBlobsCache.bytes;
    const bytes = directoryBytes(storageLayoutForStateDir(this.options.stateDir).blobsDir);
    this.externalBlobsCache = { bytes, at: now };
    return bytes;
  }

  private database(): StorageReport['database'] {
    const { stateDir } = this.options;
    const layout = storageLayoutForStateDir(stateDir);
    const defs: Array<{ kind: StorageStoreUsage['kind']; path: string; extraBytes?: number; rebuildable?: boolean }> = [
      { kind: 'control', path: layout.control },
      { kind: 'journal', path: layout.journal, extraBytes: this.externalBlobsBytes() },
      { kind: 'derived', path: layout.derived, rebuildable: true },
    ];
    let totalBytes = 0;
    let walBytes = 0;
    let freeBytes = 0;
    let incremental = true;
    const stores: StorageStoreUsage[] = [];
    const files = databaseFiles(stateDir);
    for (const def of defs) {
      if (!existsSync(def.path)) continue;
      const wal = fileSize(`${def.path}-wal`);
      walBytes += wal;
      let storeFree = 0;
      const db = new DatabaseSync(def.path, { readOnly: true, timeout: 5000 });
      try {
        const pragma = (name: string) => Number(Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0] ?? 0);
        storeFree = pragma('page_size') * pragma('freelist_count');
        freeBytes += storeFree;
        if (pragma('auto_vacuum') !== 2) incremental = false;
      } finally { db.close(); }
      const storeBytes = fileSize(def.path) + wal + (def.extraBytes ?? 0);
      totalBytes += storeBytes;
      stores.push({
        kind: def.kind,
        bytes: storeBytes,
        freeBytes: storeFree,
        ...(def.rebuildable ? { rebuildable: true } : {}),
      });
    }
    return {
      bytes: totalBytes,
      walBytes,
      freeBytes,
      incremental: files.length > 0 && incremental,
      ...(stores.length > 1 ? { stores } : {}),
    };
  }

  /** Names and titles come from the store as it is now, so a renamed or deleted conversation reads right. */
  private summarize({ at, durationMs, result }: Measured): StorageScan {
    const { store } = this.options;
    const projects = new Map(store.listProjects().map((item) => [item.id, item]));
    const sessions = new Map(store.listSessions().map((session) => [session.id, session]));
    const usage = new Map<string, StorageProjectUsage>();
    const project = (key: string, projectId?: string) => {
      let entry = usage.get(key);
      if (!entry) {
        const known = projectId ? projects.get(projectId) : undefined;
        entry = { ...(known ? { projectId: known.id, name: known.name } : {}), sessionBytes: 0, checkpointBytes: 0, worktreeBytes: 0 };
        usage.set(key, entry);
      }
      return entry;
    };
    const digests = [...projects.keys()].map((id) => [createHash('sha256').update(id).digest('hex'), id] as const);
    const byPrefix = (prefix: string) => digests.find(([digest]) => digest.startsWith(prefix))?.[1];
    for (const child of result.children ?? []) {
      const length = PROJECT_FOLDERS[child.parent as keyof typeof PROJECT_FOLDERS];
      const projectId = byPrefix(child.name.replace(/\.git$/, '').slice(0, length));
      // Whatever a deleted project left behind is counted together, under no project.
      const entry = project(projectId ?? '', projectId);
      if (child.parent === 'checkpoints') entry.checkpointBytes += child.bytes;
      else entry.worktreeBytes += child.bytes;
    }
    const named = [];
    for (const { id, bytes } of result.sessions ?? []) {
      const session = sessions.get(id);
      if (!session) continue;
      project(session.projectId, session.projectId).sessionBytes += bytes;
      named.push({ session, bytes });
    }
    const total = (item: StorageProjectUsage) => item.sessionBytes + item.checkpointBytes + item.worktreeBytes;
    const pending: StorageScanStep[] = [
      ...(result.entries ? [] : ['folders' as const]),
      ...(result.sessions ? [] : ['sessions' as const]),
      ...(result.pages ? [] : ['parts' as const]),
    ];
    return {
      at,
      durationMs,
      ...(pending.length ? { pending } : {}),
      parts: sum((result.pages ?? []).map((page) => ({ key: databasePart(page.name), bytes: page.bytes }))).map(([part, { bytes }]) => ({ part, bytes })),
      folders: sum((result.entries ?? []).map((entry) => ({ key: folderKind(entry.name), bytes: entry.bytes, files: entry.files }))).map(([kind, { bytes, files }]) => ({ kind, bytes, files })),
      projects: [...usage.values()].filter((item) => total(item) > 0).sort((a, b) => total(b) - total(a)).slice(0, TOP_PROJECTS),
      sessions: named.sort((a, b) => b.bytes - a.bytes).slice(0, TOP_SESSIONS).map(({ session, bytes }) => ({
        sessionId: session.id,
        title: session.title,
        projectId: session.projectId,
        ...(projects.get(session.projectId)?.name ? { projectName: projects.get(session.projectId)!.name } : {}),
        bytes,
        ...(session.lastActivityAt ? { lastActivityAt: session.lastActivityAt } : {}),
      })),
    };
  }
}

function writeJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}

/** Only a finished scan matching the current storage layout version is reused; older scans rescan automatically. */
function readSaved(path: string): Measured | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Measured;
    const { result } = value;
    if (value.version !== SCAN_VERSION || typeof value.at !== 'string' || !Number.isFinite(value.durationMs) || !result || ![result.entries, result.children, result.pages, result.sessions].every(Array.isArray)) return undefined;
    return value;
  } catch { return undefined; }
}

function readMaintenance(path: string): StorageMaintenanceResult | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as StorageMaintenanceResult;
    if (typeof value.at !== 'string' || !Number.isFinite(value.beforeBytes) || !Number.isFinite(value.afterBytes)) return undefined;
    return value;
  } catch { return undefined; }
}
