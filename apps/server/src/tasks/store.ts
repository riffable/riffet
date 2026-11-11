import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Task } from '../../../../packages/contracts/src/index.js';
import type { ProcessIdentity } from './process.js';

/** What the host keeps beyond the public task: the plan as fixed at start and the process to follow. */
export interface StoredTask {
  task: Omit<Task, 'logSize'>;
  /** Of the request (project, provider, action, params): a replay must match it. */
  fingerprint: string;
  /** Real paths of the project root and of the working directory at start. */
  root: string;
  cwd: string;
  plan: { file: string; args: string[]; lock?: string; artifacts?: string[] };
  process?: ProcessIdentity;
  /** The mtime of each registered artifact by id: a later build replaces the file, and then the record no longer describes it. */
  stamps?: Record<string, number>;
}

/** What an approval of a plan is for: one action of one provider of one version of a plugin. */
export interface ApprovalKey { pluginId: string; version: string; providerId: string; actionId: string }

export const isOpen = (state: Task['state']): boolean => state === 'running' || state === 'cancelling';

/**
 * Tasks in the workbench database, beside the journal and the other additive tables: `CREATE TABLE
 * IF NOT EXISTS`, no schema version, so an older binary ignores it. No foreign key either: a task and
 * its log outlive a deleted project until they age out.
 */
export class TaskStore {
  private readonly statements = new Map<string, StatementSync>();

  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, lock_key TEXT,
        state TEXT NOT NULL, started_at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id, started_at);
      CREATE INDEX IF NOT EXISTS tasks_open ON tasks(state) WHERE state IN ('running','cancelling');
      CREATE TABLE IF NOT EXISTS task_approvals (
        plugin_id TEXT NOT NULL, version TEXT NOT NULL, provider_id TEXT NOT NULL, action_id TEXT NOT NULL, fingerprint TEXT NOT NULL, approved_at TEXT NOT NULL,
        PRIMARY KEY (plugin_id, version, provider_id, action_id, fingerprint));`);
  }

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) this.statements.set(text, statement = this.db.prepare(text));
    return statement;
  }

  private parse(row: { json: string } | undefined): StoredTask | undefined { return row ? JSON.parse(row.json) as StoredTask : undefined; }

  insert(stored: StoredTask): void {
    const { task, plan } = stored;
    this.sql('INSERT INTO tasks(id,request_id,project_id,lock_key,state,started_at,json) VALUES(?,?,?,?,?,?,?)')
      .run(task.id, task.requestId, task.projectId, plan.lock ?? null, task.state, task.startedAt, JSON.stringify(stored));
  }

  save(stored: StoredTask): void {
    this.sql('UPDATE tasks SET state=?, json=? WHERE id=?').run(stored.task.state, JSON.stringify(stored), stored.task.id);
  }

  get(id: string): StoredTask | undefined { return this.parse(this.sql('SELECT json FROM tasks WHERE id=?').get(id) as { json: string } | undefined); }
  byRequest(requestId: string): StoredTask | undefined { return this.parse(this.sql('SELECT json FROM tasks WHERE request_id=?').get(requestId) as { json: string } | undefined); }

  /** Newest first. */
  list(projectId: string, limit: number): StoredTask[] {
    return (this.sql('SELECT json FROM tasks WHERE project_id=? ORDER BY started_at DESC, rowid DESC LIMIT ?').all(projectId, limit) as Array<{ json: string }>).map(row => JSON.parse(row.json) as StoredTask);
  }

  open(): StoredTask[] {
    return (this.sql("SELECT json FROM tasks WHERE state IN ('running','cancelling') ORDER BY started_at").all() as Array<{ json: string }>).map(row => JSON.parse(row.json) as StoredTask);
  }

  /** The task holding `lock` in the project, if one is running. */
  holder(projectId: string, lock: string): StoredTask | undefined {
    return this.parse(this.sql("SELECT json FROM tasks WHERE project_id=? AND lock_key=? AND state IN ('running','cancelling') ORDER BY started_at LIMIT 1").get(projectId, lock) as { json: string } | undefined);
  }

  /** Finished tasks that are older than `before` (ISO) or beyond the newest `keep` of their project. */
  expired(before: string, keep: number): string[] {
    return (this.sql(`SELECT id FROM tasks WHERE state NOT IN ('running','cancelling') AND (started_at < ? OR id IN (
        SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY started_at DESC, rowid DESC) AS n
          FROM tasks WHERE state NOT IN ('running','cancelling')) WHERE n > ?))`).all(before, keep) as Array<{ id: string }>).map(row => row.id);
  }

  delete(id: string): void { this.sql('DELETE FROM tasks WHERE id=?').run(id); }

  /** Whether the user approved this plan (its fingerprint) for this version of the plugin. */
  approved(key: ApprovalKey, fingerprint: string): boolean {
    return this.sql('SELECT 1 AS found FROM task_approvals WHERE plugin_id=? AND version=? AND provider_id=? AND action_id=? AND fingerprint=?')
      .get(key.pluginId, key.version, key.providerId, key.actionId, fingerprint) !== undefined;
  }

  /** Records an approval, and drops the plugin's approvals of any other version: a new version asks again. */
  approve(key: ApprovalKey, fingerprint: string): void {
    this.sql('DELETE FROM task_approvals WHERE plugin_id=? AND version<>?').run(key.pluginId, key.version);
    this.sql('INSERT OR IGNORE INTO task_approvals(plugin_id,version,provider_id,action_id,fingerprint,approved_at) VALUES(?,?,?,?,?,?)')
      .run(key.pluginId, key.version, key.providerId, key.actionId, fingerprint, new Date().toISOString());
  }

  close(): void { this.statements.clear(); }
}
