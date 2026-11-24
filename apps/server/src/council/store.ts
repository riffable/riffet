import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { COUNCIL_BUDGET, type CouncilDiscussion, type CouncilSeat, type CouncilSummary } from '../../../../packages/contracts/src/index.js';

export class CouncilStore {
  private readonly statements = new Map<string, StatementSync>();

  constructor(private readonly db: DatabaseSync) {
    // Rows of the unreleased first version (no `format`) cannot be read as discussions.
    this.sql(`DELETE FROM council_discussions WHERE json_extract(json, '$.format') IS NULL`).run();
  }

  private sql(text: string): StatementSync {
    let stmt = this.statements.get(text);
    if (!stmt) this.statements.set(text, stmt = this.db.prepare(text));
    return stmt;
  }

  list(): CouncilSummary[] {
    const rows = this.sql(`SELECT id, json_extract(json, '$.format') AS format, json_extract(json, '$.title') AS title,
      json_extract(json, '$.status') AS status, json_extract(json, '$.maxRounds') AS maxRounds, json_extract(json, '$.rhythm') AS rhythm,
      json_extract(json, '$.settledAt') AS settledAt, json_extract(json, '$.seenAt') AS seenAt,
      json_extract(json, '$.seats') AS seats, created_at AS createdAt, updated_at AS updatedAt
      FROM council_discussions ORDER BY updated_at DESC, id DESC LIMIT ?`).all(COUNCIL_BUDGET.keptDiscussions) as Array<Omit<CouncilSummary, 'seats' | 'settledAt' | 'seenAt'> & { seats: string; settledAt: string | null; seenAt: string | null }>;
    return rows.map(({ seats, settledAt, seenAt, ...row }) => ({
      ...row,
      ...(settledAt ? { settledAt } : {}),
      ...(seenAt ? { seenAt } : {}),
      seats: (JSON.parse(seats) as CouncilSeat[]).map(seat => ({ role: seat.role, model: seat.model, ...(seat.task ? { task: seat.task } : {}) })),
    }));
  }

  /** Discussions a server stop left running. */
  running(): CouncilDiscussion[] {
    const rows = this.sql(`SELECT json FROM council_discussions WHERE json_extract(json, '$.status') = 'running'`).all() as Array<{ json: string }>;
    return rows.map(row => JSON.parse(row.json) as CouncilDiscussion);
  }

  get(id: string): CouncilDiscussion | undefined {
    const row = this.sql('SELECT json FROM council_discussions WHERE id=?').get(id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as CouncilDiscussion : undefined;
  }

  save(discussion: CouncilDiscussion): void {
    this.sql(`INSERT INTO council_discussions(id, created_at, updated_at, json) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, json=excluded.json`)
      .run(discussion.id, discussion.createdAt, discussion.updatedAt, JSON.stringify(discussion));
  }

  /** Deletes the discussions beyond the kept count, oldest first out, and returns them so their seats can be removed. */
  pruneOldest(): CouncilDiscussion[] {
    const rows = this.sql(`SELECT json FROM council_discussions WHERE id NOT IN (
      SELECT id FROM council_discussions ORDER BY updated_at DESC, id DESC LIMIT ?
    )`).all(COUNCIL_BUDGET.keptDiscussions) as Array<{ json: string }>;
    const pruned = rows.map(row => JSON.parse(row.json) as CouncilDiscussion);
    for (const d of pruned) this.delete(d.id);
    return pruned;
  }

  delete(id: string): boolean {
    return Number(this.sql('DELETE FROM council_discussions WHERE id=?').run(id).changes) > 0;
  }
}
