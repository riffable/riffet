import { createHash } from 'node:crypto';
import { statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import type { StorageDatabasePart, StorageFolderKind, StorageProjectUsage, StorageReport, StorageScan } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';
import { compactionState, databaseBytes } from './compaction.js';

/** A page that opens with an older breakdown than this starts a new scan on its own. */
const SCAN_STALE_MS = 60 * 60_000;
const TOP_SESSIONS = 12;
const TOP_PROJECTS = 20;

/**
 * CommonJS, evaluated in the worker (see `wal-checkpoint.ts`). Everything here reads the whole database
 * or walks the whole state directory: on a 6 GB database the page breakdown alone took 30 s, which is
 * why it never runs on the event loop. Each query is its own statement, so no read transaction outlives it.
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

const { stateDir, database, split } = workerData;
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

const db = new DatabaseSync(join(stateDir, database), { readOnly: true, timeout: 5000 });
const pages = db.prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat WHERE aggregate=TRUE GROUP BY name").all();
// perf-rules: allow lives only as long as this one-shot worker
const sessions = new Map();
const add = (rows) => { for (const row of rows) sessions.set(row.id, (sessions.get(row.id) ?? 0) + Number(row.bytes)); };
add(db.prepare("SELECT session_id AS id, SUM(length(payload)) AS bytes FROM journal_events GROUP BY session_id").all());
add(db.prepare("SELECT session_id AS id, SUM(bytes) AS bytes FROM timeline_rows GROUP BY session_id").all());
db.close();
parentPort.postMessage({ entries, children, pages: pages.map(row => ({ name: row.name, bytes: Number(row.bytes) })), sessions: [...sessions].map(([id, bytes]) => ({ id, bytes })) });
`;

interface WorkerResult {
  entries: Array<{ name: string; bytes: number; files: number }>;
  children: Array<{ parent: string; name: string; bytes: number }>;
  pages: Array<{ name: string; bytes: number }>;
  sessions: Array<{ id: string; bytes: number }>;
}

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
 * from the last background scan. One scan runs at a time; the result is kept in memory until the next.
 */
export class StorageInspector {
  private last?: StorageScan;
  private running?: Promise<void>;
  private worker?: Worker;
  private closed = false;

  constructor(private readonly options: { stateDir: string; store: Pick<Store, 'listSessions' | 'listProjects'> }) {}

  report(): StorageReport {
    if (!this.running && (!this.last || Date.now() - Date.parse(this.last.at) > SCAN_STALE_MS)) this.scan();
    const { stateDir } = this.options;
    const disk = statfsSync(stateDir);
    return {
      generatedAt: new Date().toISOString(),
      directory: stateDir,
      disk: { freeBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize },
      database: this.database(),
      ...(this.last ? { scan: this.last } : {}),
      scanning: Boolean(this.running),
      compaction: compactionState(stateDir),
    };
  }

  /** Starts a scan unless one is running. A failed scan keeps the previous breakdown. */
  scan(): void {
    if (this.running || this.closed) return;
    const started = Date.now();
    this.running = this.runWorker()
      .then((result) => { if (!this.closed) this.last = this.summarize(result, started); })
      .catch((error: unknown) => console.warn('[riffet] storage scan failed:', (error as Error).message))
      .finally(() => { this.running = undefined; this.worker = undefined; });
  }

  close(): void {
    this.closed = true;
    void this.worker?.terminate();
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

  private runWorker(): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER, { eval: true, name: 'riffet-storage', workerData: { stateDir: this.options.stateDir, database: 'workbench.db', split: Object.keys(PROJECT_FOLDERS) } });
      this.worker = worker;
      worker.unref();
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`storage scan ended with code ${code}`)));
    });
  }

  private summarize(result: WorkerResult, started: number): StorageScan {
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
    for (const child of result.children) {
      const length = PROJECT_FOLDERS[child.parent as keyof typeof PROJECT_FOLDERS];
      const projectId = byPrefix(child.name.replace(/\.git$/, '').slice(0, length));
      // Whatever a deleted project left behind is counted together, under no project.
      const entry = project(projectId ?? '', projectId);
      if (child.parent === 'checkpoints') entry.checkpointBytes += child.bytes;
      else entry.worktreeBytes += child.bytes;
    }
    const named = [];
    for (const { id, bytes } of result.sessions) {
      const session = sessions.get(id);
      if (!session) continue;
      project(session.projectId, session.projectId).sessionBytes += bytes;
      named.push({ session, bytes });
    }
    const total = (item: StorageProjectUsage) => item.sessionBytes + item.checkpointBytes + item.worktreeBytes;
    return {
      at: new Date().toISOString(),
      durationMs: Date.now() - started,
      parts: sum(result.pages.map((page) => ({ key: databasePart(page.name), bytes: page.bytes }))).map(([part, { bytes }]) => ({ part, bytes })),
      folders: sum(result.entries.map((entry) => ({ key: folderKind(entry.name), bytes: entry.bytes, files: entry.files }))).map(([kind, { bytes, files }]) => ({ kind, bytes, files })),
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
