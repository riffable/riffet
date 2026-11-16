import { createHash } from 'node:crypto';
import { readFileSync, renameSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import type { StorageDatabasePart, StorageFolderKind, StorageProjectUsage, StorageReport, StorageScan, StorageScanStep } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';
import { compactionState, databaseBytes } from './compaction.js';

/**
 * A page that opens with an older breakdown than this starts a new scan on its own, and keeps showing
 * the old one until the new one is done.
 */
const SCAN_STALE_MS = 24 * 60 * 60_000;
/** The last finished scan, as the worker measured it: names and titles are looked up when it is read. */
const SAVED = 'storage-scan.json';
const TOP_SESSIONS = 12;
const TOP_PROJECTS = 20;

/**
 * CommonJS, evaluated in the worker (see `wal-checkpoint.ts`). Everything here reads the whole database
 * or walks the whole state directory, which is why it never runs on the event loop. One worker per
 * step, run side by side: on a 6 GB database the folders took 4–10 s, the per-conversation sizes 12 s
 * and the page breakdown 18 s together, against 35 s one after the other (the two queries read the
 * same pages, so the second finds most of them cached). Each step's result is shown as it arrives.
 * Each query is its own statement, so no read transaction outlives it.
 */
const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { lstatSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function measure(path) {
  let bytes = 0, files = 0;
  const pending = [path];
  while (pending.length) {
    const next = pending.pop();
    let info;
    try { info = lstatSync(next); } catch { continue; }
    bytes += typeof info.blocks === 'number' ? info.blocks * 512 : info.size;
    if (!info.isDirectory()) { files += 1; continue; }
    let names;
    try { names = readdirSync(next); } catch { continue; }
    for (const name of names) pending.push(join(next, name));
  }
  return { bytes, files };
}

const { stateDir, database, split, step } = workerData;
if (step === 'folders') {
const entries = [];
const children = [];
for (const name of readdirSync(stateDir)) {
  if (name === database || name.startsWith(database + '-')) continue;
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
const db = new DatabaseSync(join(stateDir, database), { readOnly: true, timeout: 5000 });
// perf-rules: allow lives only as long as this one-shot worker
const sessions = new Map();
const add = (rows) => { for (const row of rows) sessions.set(row.id, (sessions.get(row.id) ?? 0) + Number(row.bytes)); };
add(db.prepare("SELECT session_id AS id, SUM(bytes) AS bytes FROM timeline_rows GROUP BY session_id").all());
add(db.prepare("SELECT session_id AS id, SUM(octet_length(payload)) AS bytes FROM journal_events GROUP BY session_id").all());
db.close();
parentPort.postMessage({ sessions: [...sessions].map(([id, bytes]) => ({ id, bytes })) });
} else {
const db = new DatabaseSync(join(stateDir, database), { readOnly: true, timeout: 5000 });
const pages = db.prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat WHERE aggregate=TRUE GROUP BY name").all();
db.close();
parentPort.postMessage({ pages: pages.map(row => ({ name: row.name, bytes: Number(row.bytes) })) });
}
`;

/** A scan as the worker reports it; a step it has not reached yet is absent. */
interface WorkerResult {
  entries?: Array<{ name: string; bytes: number; files: number }>;
  children?: Array<{ parent: string; name: string; bytes: number }>;
  pages?: Array<{ name: string; bytes: number }>;
  sessions?: Array<{ id: string; bytes: number }>;
}

interface Measured { at: string; durationMs: number; result: WorkerResult }

/** Per-project folders, named by a prefix of the project id's sha256 (`git/index.ts`). */
const PROJECT_FOLDERS = { checkpoints: 32, worktrees: 24, 'shadow-repos': 24 } as const;

function databasePart(name: string): StorageDatabasePart {
  const table = name.replace(/^sqlite_autoindex_/, '');
  if (table.startsWith('journal')) return 'journal';
  if (table.startsWith('timeline')) return 'timeline';
  if (table.startsWith('blobs')) return 'blobs';
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

  constructor(private readonly options: { stateDir: string; store: Pick<Store, 'listSessions' | 'listProjects'> }) {
    this.finished = readSaved(join(options.stateDir, SAVED));
  }

  report(): StorageReport {
    if (!this.current && (!this.finished || Date.now() - Date.parse(this.finished.at) > SCAN_STALE_MS)) this.scan();
    const { stateDir } = this.options;
    const disk = statfsSync(stateDir);
    const shown = this.finished ?? this.current;
    return {
      generatedAt: new Date().toISOString(),
      directory: stateDir,
      disk: { freeBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize },
      database: this.database(),
      ...(shown ? { scan: this.summarize(shown) } : {}),
      scanning: Boolean(this.current),
      compaction: compactionState(stateDir),
    };
  }

  /** Starts a scan unless one is running. A failed scan keeps the previous breakdown. */
  scan(): void {
    if (this.current || this.closed) return;
    const started = Date.now();
    const current: Measured = { at: new Date(started).toISOString(), durationMs: 0, result: {} };
    this.current = current;
    const steps: StorageScanStep[] = ['folders', 'sessions', 'parts'];
    for (const step of steps) {
      const worker = new Worker(WORKER, { eval: true, name: `riffet-storage-${step}`, workerData: { stateDir: this.options.stateDir, database: 'workbench.db', split: Object.keys(PROJECT_FOLDERS), step } });
      this.workers.add(worker);
      worker.unref();
      worker.on('message', (result: WorkerResult) => {
        Object.assign(current.result, result);
        current.durationMs = Date.now() - started;
        const { entries, sessions, pages } = current.result;
        if (!entries || !sessions || !pages || this.closed) return;
        this.finished = { ...current, at: new Date().toISOString() };
        try { writeJson(join(this.options.stateDir, SAVED), this.finished); } catch { /* Kept in memory; the next start scans again. */ }
      });
      worker.once('error', (error) => console.warn(`[riffet] storage scan (${step}) failed:`, error.message));
      worker.once('exit', () => {
        this.workers.delete(worker);
        if (this.workers.size === 0 && this.current === current) this.current = undefined;
      });
    }
  }

  close(): void {
    this.closed = true;
    for (const worker of this.workers) void worker.terminate();
  }

  private database(): StorageReport['database'] {
    const { stateDir } = this.options;
    const db = new DatabaseSync(join(stateDir, 'workbench.db'), { readOnly: true });
    try {
      const pragma = (name: string) => Number(Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0] ?? 0);
      return {
        bytes: databaseBytes(stateDir),
        walBytes: statSync(join(stateDir, 'workbench.db-wal'), { throwIfNoEntry: false })?.size ?? 0,
        freeBytes: pragma('page_size') * pragma('freelist_count'),
        incremental: pragma('auto_vacuum') === 2,
      };
    } finally { db.close(); }
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

/** Only a finished scan is saved; anything else (an older shape, a torn write) means none. */
function readSaved(path: string): Measured | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Measured;
    const { result } = value;
    if (typeof value.at !== 'string' || !Number.isFinite(value.durationMs) || !result || ![result.entries, result.children, result.pages, result.sessions].every(Array.isArray)) return undefined;
    return value;
  } catch { return undefined; }
}
