import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { AgentCallMode } from '../../../../packages/contracts/src/index.js';

/** One turn a caller asked of a called conversation (`agent_call_turns`, docs/AGENT-CALLS.md §7). */
export interface CallTurnRow {
  runId: string;
  callId: string;
  callerSessionId: string;
  callerRunId?: string;
  prompt: string;
  mode: AgentCallMode;
  /** The caller stopped waiting: the answer is sent to it as a message when the turn ends (§4.1). */
  background: boolean;
  /** Handed back (as a tool result or a message) or given up on; nothing more is sent. */
  deliveredAt?: string;
  createdAt: string;
}

interface Raw {
  run_id: string; call_id: string; caller_session_id: string; caller_run_id: string | null; prompt: string;
  mode: string; background: number; delivered_at: string | null; created_at: string;
}

const row = (raw: Raw): CallTurnRow => ({
  runId: raw.run_id, callId: raw.call_id, callerSessionId: raw.caller_session_id,
  ...(raw.caller_run_id ? { callerRunId: raw.caller_run_id } : {}),
  prompt: raw.prompt, mode: raw.mode === 'work' ? 'work' : 'consult', background: raw.background === 1,
  ...(raw.delivered_at ? { deliveredAt: raw.delivered_at } : {}), createdAt: raw.created_at,
});

export class AgentCallStore {
  private readonly statements = new Map<string, StatementSync>();

  constructor(private readonly db: DatabaseSync) {}

  private sql(text: string): StatementSync {
    let stmt = this.statements.get(text);
    if (!stmt) this.statements.set(text, stmt = this.db.prepare(text));
    return stmt;
  }

  insert(turn: Omit<CallTurnRow, 'background' | 'deliveredAt'>): void {
    this.sql(`INSERT OR IGNORE INTO agent_call_turns(run_id, call_id, caller_session_id, caller_run_id, prompt, mode, background, delivered_at, created_at)
      VALUES(?,?,?,?,?,?,0,NULL,?)`).run(turn.runId, turn.callId, turn.callerSessionId, turn.callerRunId ?? null, turn.prompt, turn.mode, turn.createdAt);
  }

  get(runId: string): CallTurnRow | undefined {
    const raw = this.sql('SELECT * FROM agent_call_turns WHERE run_id=?').get(runId) as Raw | undefined;
    return raw ? row(raw) : undefined;
  }

  /** A call's turns, oldest first. */
  turns(callId: string): CallTurnRow[] {
    return (this.sql('SELECT * FROM agent_call_turns WHERE call_id=? ORDER BY created_at, rowid').all(callId) as unknown as Raw[]).map(row);
  }

  /** The calls a conversation made, by the time of their first turn. */
  callIds(callerSessionId: string): string[] {
    return (this.sql(`SELECT call_id FROM agent_call_turns WHERE caller_session_id=? GROUP BY call_id ORDER BY MIN(created_at), MIN(rowid)`)
      .all(callerSessionId) as Array<{ call_id: string }>).map(item => item.call_id);
  }

  /** Calls and follow-ups one turn of the caller made. */
  countForCallerRun(callerRunId: string): number {
    return Number((this.sql('SELECT COUNT(*) AS n FROM agent_call_turns WHERE caller_run_id=?').get(callerRunId) as { n: number }).n);
  }

  /** Turns in the background whose answer has not been handed back. */
  pending(): CallTurnRow[] {
    return (this.sql('SELECT * FROM agent_call_turns WHERE background=1 AND delivered_at IS NULL ORDER BY created_at').all() as unknown as Raw[]).map(row);
  }

  /** Every turn not yet handed back goes to the background: at a start no tool call is waiting on one. */
  backgroundAll(): void {
    this.sql('UPDATE agent_call_turns SET background=1 WHERE background=0 AND delivered_at IS NULL').run();
  }

  background(runId: string): void {
    this.sql('UPDATE agent_call_turns SET background=1 WHERE run_id=? AND delivered_at IS NULL').run(runId);
  }

  /** True when this call marked it: the one that hands the answer back. */
  deliver(runId: string, at: string): boolean {
    return Number(this.sql('UPDATE agent_call_turns SET delivered_at=? WHERE run_id=? AND delivered_at IS NULL').run(at, runId).changes) > 0;
  }

  /** Forgets the turns of deleted conversations, called or calling. */
  forget(sessionIds: readonly string[]): void {
    if (!sessionIds.length) return;
    const ids = JSON.stringify(sessionIds);
    this.sql(`DELETE FROM agent_call_turns WHERE call_id IN (SELECT value FROM json_each(?))`).run(ids);
    // A deleted caller has nothing to be sent to; its calls stay readable as conversations of their own.
    this.sql(`UPDATE agent_call_turns SET delivered_at=COALESCE(delivered_at, ?) WHERE caller_session_id IN (SELECT value FROM json_each(?))`).run(new Date().toISOString(), ids);
  }
}
