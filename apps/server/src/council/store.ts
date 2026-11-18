import type { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  COUNCIL_BUDGET,
  type CouncilDebateRound,
  type CouncilDebateSide,
  type CouncilDebateTurn,
  type CouncilDiscussion,
  type CouncilModelParticipant,
} from '../../../../packages/contracts/src/index.js';

interface LegacyDebateTurn {
  id: string;
  speaker: CouncilModelParticipant;
  text: string;
  replyTo?: CouncilDebateTurn['replyTo'];
  question?: CouncilDebateTurn['question'] | string;
}

interface LegacyDebateRound {
  num: number;
  stage: string;
  order?: Array<'pro' | 'con'>;
  proTurns?: LegacyDebateTurn[];
  conTurns?: LegacyDebateTurn[];
  turns?: CouncilDebateTurn[];
  ledger?: Record<string, { claim: string; weakness?: string }>;
  summary?: Record<string, { claim: string; weakness?: string }>;
}

/** Upgrades persisted discussions written before multi-stance debate normalization. */
function normalizeDiscussion(raw: CouncilDiscussion): CouncilDiscussion {
  if (!Array.isArray(raw.phases)) raw.phases = [];
  if (raw.mode === 'debate' && raw.debate) {
    const debate = raw.debate as CouncilDiscussion['debate'] & {
      proModel?: CouncilModelParticipant;
      conModel?: CouncilModelParticipant;
      proModels?: CouncilModelParticipant[];
      conModels?: CouncilModelParticipant[];
    };
    if (!Array.isArray(debate.sides)) {
      const proModels = Array.isArray(debate.proModels)
        ? debate.proModels
        : debate.proModel
        ? [debate.proModel]
        : [];
      const conModels = Array.isArray(debate.conModels)
        ? debate.conModels
        : debate.conModel
        ? [debate.conModel]
        : [];
      const sides: CouncilDebateSide[] = [
        { id: 'pro', label: '正方', models: proModels },
        { id: 'con', label: '反方', models: conModels },
      ];
      debate.sides = sides;
    }
    if (!Array.isArray(debate.hostTurns)) debate.hostTurns = [];
    if (!Array.isArray(debate.rounds)) {
      debate.rounds = [];
    } else {
      debate.rounds = (debate.rounds as unknown as LegacyDebateRound[]).map((r): CouncilDebateRound => {
        if (Array.isArray(r.turns)) return r as CouncilDebateRound;
        const order = Array.isArray(r.order) && r.order.length ? r.order : (['pro', 'con'] as const);
        const proList = Array.isArray(r.proTurns) ? r.proTurns : [];
        const conList = Array.isArray(r.conTurns) ? r.conTurns : [];
        const maxLen = Math.max(proList.length, conList.length);
        const turns: CouncilDebateTurn[] = [];
        for (let i = 0; i < maxLen; i += 1) {
          for (const sideId of order) {
            const src = sideId === 'pro' ? proList[i] : conList[i];
            if (!src) continue;
            const q = typeof src.question === 'string'
              ? { id: `${src.id}-q`, summary: '追问', text: src.question, status: 'pending' as const }
              : src.question;
            turns.push({
              id: src.id,
              sideId,
              sideLabel: sideId === 'pro' ? '正方' : '反方',
              speaker: src.speaker,
              text: src.text ?? '',
              ...(src.replyTo ? { replyTo: src.replyTo } : {}),
              ...(q ? { question: q } : {}),
            });
          }
        }
        return {
          num: r.num,
          stage: r.stage,
          turns,
          ...(r.summary ? { summary: r.summary } : r.ledger ? { summary: r.ledger } : {}),
        };
      });
    }
  }
  return raw;
}

export class CouncilStore {
  private readonly statements = new Map<string, StatementSync>();
  constructor(private readonly db: DatabaseSync) {}

  private sql(text: string): StatementSync {
    let stmt = this.statements.get(text);
    if (!stmt) this.statements.set(text, stmt = this.db.prepare(text));
    return stmt;
  }

  list(): CouncilDiscussion[] {
    const rows = this.sql('SELECT json FROM council_discussions ORDER BY updated_at DESC, id DESC LIMIT ?')
      .all(COUNCIL_BUDGET.keptDiscussions) as Array<{ json: string }>;
    return rows.map(row => normalizeDiscussion(JSON.parse(row.json) as CouncilDiscussion));
  }

  get(id: string): CouncilDiscussion | undefined {
    const row = this.sql('SELECT json FROM council_discussions WHERE id=?').get(id) as { json: string } | undefined;
    return row ? normalizeDiscussion(JSON.parse(row.json) as CouncilDiscussion) : undefined;
  }

  save(discussion: CouncilDiscussion): void {
    this.sql(`INSERT INTO council_discussions(id, created_at, updated_at, json) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, json=excluded.json`)
      .run(discussion.id, discussion.createdAt, discussion.updatedAt, JSON.stringify(discussion));
  }

  pruneOldest(): void {
    this.sql(`DELETE FROM council_discussions WHERE id NOT IN (
      SELECT id FROM council_discussions ORDER BY updated_at DESC, id DESC LIMIT ?
    )`).run(COUNCIL_BUDGET.keptDiscussions);
  }

  delete(id: string): boolean {
    const result = this.sql('DELETE FROM council_discussions WHERE id=?').run(id);
    return Number(result.changes) > 0;
  }
}
