import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Automation, AutomationRun } from '../../../../packages/contracts/src/index.js';

/** Runs kept per automation. */
export const RUNS_KEPT = 50;

interface Row { json: string }

/**
 * Automations and their runs in the workbench database, beside the journal and the other additive
 * tables: `CREATE TABLE IF NOT EXISTS`, no schema version. The columns beside `json` exist so the
 * scheduler can find what is due and a conversation's follow-ups without reading every record.
 * No foreign keys: a follow-up is removed with its conversation by `OrchestrationService.forgetSessions`.
 */
export class AutomationStore {
  private readonly statements = new Map<string, StatementSync>();

  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY, follow_up_session TEXT, last_session_id TEXT, next_run_at TEXT, enabled INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS automations_follow_up ON automations(follow_up_session) WHERE follow_up_session IS NOT NULL;
      CREATE INDEX IF NOT EXISTS automations_due ON automations(next_run_at) WHERE next_run_at IS NOT NULL;
      CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, at TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS automation_runs_automation ON automation_runs(automation_id, at);`);
  }

  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) this.statements.set(text, statement = this.db.prepare(text));
    return statement;
  }
  private parse<T>(rows: Row[]): T[] { return rows.map(row => JSON.parse(row.json) as T); }

  all(): Automation[] { return this.parse<Automation>(this.sql('SELECT json FROM automations').all() as unknown as Row[]); }
  get(id: string): Automation | undefined {
    const row = this.sql('SELECT json FROM automations WHERE id=?').get(id) as Row | undefined;
    return row ? JSON.parse(row.json) as Automation : undefined;
  }
  /** Enabled automations with a next time at or before `at`, earliest first. */
  due(at: string): Automation[] {
    return this.parse<Automation>(this.sql('SELECT json FROM automations WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at').all(at) as unknown as Row[]);
  }
  followUps(sessionId?: string): Automation[] {
    return sessionId === undefined
      ? this.parse<Automation>(this.sql('SELECT json FROM automations WHERE follow_up_session IS NOT NULL').all() as unknown as Row[])
      : this.parse<Automation>(this.sql('SELECT json FROM automations WHERE follow_up_session=?').all(sessionId) as unknown as Row[]);
  }
  usingSessions(ids: readonly string[]): Automation[] {
    return ids.flatMap(id => this.parse<Automation>(this.sql('SELECT json FROM automations WHERE last_session_id=?').all(id) as unknown as Row[]));
  }
  count(where: 'follow-up' | 'other' | 'created-by', value?: string): number {
    const row = where === 'follow-up' ? this.sql('SELECT COUNT(*) AS n FROM automations WHERE follow_up_session IS NOT NULL').get()
      : where === 'other' ? this.sql('SELECT COUNT(*) AS n FROM automations WHERE follow_up_session IS NULL').get()
        : this.sql("SELECT COUNT(*) AS n FROM automations WHERE json_extract(json,'$.createdBySessionId')=?").get(value ?? '');
    return (row as { n: number }).n;
  }
  /** The earliest next time of an enabled follow-up, for the exact timer. */
  nextFollowUp(): string | undefined {
    const row = this.sql('SELECT MIN(next_run_at) AS at FROM automations WHERE enabled=1 AND follow_up_session IS NOT NULL AND next_run_at IS NOT NULL').get() as { at: string | null };
    return row.at ?? undefined;
  }

  put(item: Automation): void {
    this.sql(`INSERT INTO automations(id,follow_up_session,last_session_id,next_run_at,enabled,json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET follow_up_session=excluded.follow_up_session, last_session_id=excluded.last_session_id, next_run_at=excluded.next_run_at, enabled=excluded.enabled, json=excluded.json`)
      .run(item.id, item.followUp?.sessionId ?? null, item.lastSessionId ?? null, item.nextRunAt ?? null, item.enabled ? 1 : 0, JSON.stringify(item));
  }
  remove(id: string): void {
    this.sql('DELETE FROM automations WHERE id=?').run(id);
    this.sql('DELETE FROM automation_runs WHERE automation_id=?').run(id);
  }

  addRun(run: AutomationRun): void {
    this.sql('INSERT INTO automation_runs(id,automation_id,at,json) VALUES(?,?,?,?)').run(run.id, run.automationId, run.at, JSON.stringify(run));
    this.sql('DELETE FROM automation_runs WHERE automation_id=? AND id NOT IN (SELECT id FROM automation_runs WHERE automation_id=? ORDER BY at DESC, rowid DESC LIMIT ?)').run(run.automationId, run.automationId, RUNS_KEPT);
  }
  run(id: string): AutomationRun | undefined {
    const row = this.sql('SELECT json FROM automation_runs WHERE id=?').get(id) as Row | undefined;
    return row ? JSON.parse(row.json) as AutomationRun : undefined;
  }
  /** Newest first. */
  runs(automationId: string): AutomationRun[] {
    return this.parse<AutomationRun>(this.sql('SELECT json FROM automation_runs WHERE automation_id=? ORDER BY at DESC, rowid DESC').all(automationId) as unknown as Row[]);
  }
  /** Newest first, of the given automations only; the filter is applied before `limit`. */
  allRuns(limit: number, automationIds: readonly string[]): AutomationRun[] {
    return this.parse<AutomationRun>(this.sql('SELECT json FROM automation_runs WHERE automation_id IN (SELECT value FROM json_each(?)) ORDER BY at DESC, rowid DESC LIMIT ?').all(JSON.stringify(automationIds), limit) as unknown as Row[]);
  }
}
