import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { WorkItem, WorkItemEvent } from '../../../../packages/contracts/src/index.js';

interface Row { json: string }
type StatusEvent = Extract<WorkItemEvent, { kind: 'status' }>;

/**
 * Work items (任务) and their activity in the workbench database, beside the other additive tables:
 * `CREATE TABLE IF NOT EXISTS`, no schema version. `origin_session_id` is the conversation an item was
 * created with and is never cleared: it is what makes creating an item from a composer idempotent.
 * No foreign keys: the service clears what points at a deleted item.
 */
export class WorkItemStore {
  private readonly statements = new Map<string, StatementSync>();

  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY, number INTEGER UNIQUE NOT NULL, status TEXT NOT NULL, project_id TEXT, parent_id TEXT, origin_session_id TEXT, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS work_items_attention ON work_items(id) WHERE status NOT IN ('done','cancelled')
        AND (status='review' OR json_array_length(json,'$.questions')>0 OR json_extract(json,'$.stuck.at') IS NOT NULL);
      CREATE INDEX IF NOT EXISTS work_items_parent ON work_items(parent_id) WHERE parent_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS work_items_origin ON work_items(origin_session_id) WHERE origin_session_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS work_items_project ON work_items(project_id) WHERE project_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS work_item_events (
        id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS work_item_events_item ON work_item_events(work_item_id, at);
      CREATE INDEX IF NOT EXISTS work_item_status_events ON work_item_events(work_item_id) WHERE json_extract(json,'$.kind')='status';`);
  }

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) this.statements.set(text, statement = this.db.prepare(text));
    return statement;
  }

  all(): WorkItem[] {
    return (this.sql('SELECT json FROM work_items ORDER BY number DESC').all() as unknown as Row[]).map(row => JSON.parse(row.json) as WorkItem);
  }
  *attentionCandidates(): Iterable<WorkItem> {
    const rows = this.sql(`SELECT json FROM work_items WHERE status NOT IN ('done','cancelled')
      AND (status='review' OR json_array_length(json,'$.questions')>0 OR json_extract(json,'$.stuck.at') IS NOT NULL)`).iterate();
    for (const row of rows) yield JSON.parse(row.json as string) as WorkItem;
  }
  get(id: string): WorkItem | undefined {
    const row = this.sql('SELECT json FROM work_items WHERE id=?').get(id) as Row | undefined;
    return row ? JSON.parse(row.json) as WorkItem : undefined;
  }
  byNumber(number: number): WorkItem | undefined {
    const row = this.sql('SELECT json FROM work_items WHERE number=?').get(number) as Row | undefined;
    return row ? JSON.parse(row.json) as WorkItem : undefined;
  }
  byOrigin(sessionId: string): WorkItem | undefined {
    const row = this.sql('SELECT json FROM work_items WHERE origin_session_id=? ORDER BY number LIMIT 1').get(sessionId) as Row | undefined;
    return row ? JSON.parse(row.json) as WorkItem : undefined;
  }
  hasChildren(id: string): boolean { return this.sql('SELECT 1 AS found FROM work_items WHERE parent_id=? LIMIT 1').get(id) !== undefined; }
  children(id: string): WorkItem[] {
    return (this.sql('SELECT json FROM work_items WHERE parent_id=?').all(id) as unknown as Row[]).map(row => JSON.parse(row.json) as WorkItem);
  }
  nextNumber(): number { return ((this.sql('SELECT MAX(number) AS n FROM work_items').get() as { n: number | null }).n ?? 0) + 1; }

  insert(item: WorkItem, originSessionId?: string): void {
    this.sql('INSERT INTO work_items(id,number,status,project_id,parent_id,origin_session_id,json) VALUES(?,?,?,?,?,?,?)')
      .run(item.id, item.number, item.status, item.projectId ?? null, item.parentId ?? null, originSessionId ?? null, JSON.stringify(item));
  }
  update(item: WorkItem): void {
    this.sql('UPDATE work_items SET status=?, project_id=?, parent_id=?, json=? WHERE id=?')
      .run(item.status, item.projectId ?? null, item.parentId ?? null, JSON.stringify(item), item.id);
  }
  remove(id: string): void {
    this.sql('DELETE FROM work_items WHERE id=?').run(id);
    this.sql('DELETE FROM work_item_events WHERE work_item_id=?').run(id);
  }

  addEvent(event: WorkItemEvent): void {
    this.sql('INSERT INTO work_item_events(id,work_item_id,at,json) VALUES(?,?,?,?)').run(event.id, event.workItemId, event.at, JSON.stringify(event));
  }
  event(id: string): WorkItemEvent | undefined {
    const row = this.sql('SELECT json FROM work_item_events WHERE id=?').get(id) as Row | undefined;
    return row ? JSON.parse(row.json) as WorkItemEvent : undefined;
  }
  events(workItemId: string): WorkItemEvent[] {
    return (this.sql('SELECT json FROM work_item_events WHERE work_item_id=? ORDER BY at, rowid').all(workItemId) as unknown as Row[]).map(row => JSON.parse(row.json) as WorkItemEvent);
  }

  latestEventId(workItemId: string): string | undefined {
    return (this.sql('SELECT id FROM work_item_events WHERE work_item_id=? ORDER BY rowid DESC LIMIT 1').get(workItemId) as { id: string } | undefined)?.id;
  }

  /** Resolve the persisted event id against the current database before comparing insertion order. */
  statusEventsAfter(workItemId: string, cursor: string, limit: number): StatusEvent[] | undefined {
    const boundary = this.sql('SELECT rowid AS seq FROM work_item_events WHERE id=? AND work_item_id=?').get(cursor, workItemId) as { seq: number } | undefined;
    if (!boundary) return undefined;
    return (this.sql("SELECT json FROM work_item_events WHERE work_item_id=? AND rowid>? AND json_extract(json,'$.kind')='status' ORDER BY rowid LIMIT ?")
      .all(workItemId, boundary.seq, limit) as unknown as Row[]).map(row => JSON.parse(row.json) as StatusEvent);
  }
}
