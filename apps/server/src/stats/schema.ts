import type { DatabaseSync } from 'node:sqlite';

/**
 * Statistics tables (docs/STATS.md §3.1). Additive and unversioned like `message_index`: a reader
 * that does not know them ignores them, so creating them never bumps `user_version` and a
 * downgrade keeps opening the database. Times are epoch milliseconds (UTC); every token column is
 * nullable and NULL means "not reported", never zero.
 */
export const STATS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS usage_steps (
    step_key TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT,
    project_id TEXT NOT NULL,
    backend_id TEXT NOT NULL,
    profile_id TEXT,
    model TEXT,
    requested_model TEXT,
    agent_kind TEXT NOT NULL DEFAULT 'main',
    subagent_type TEXT,
    parent_step_key TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    duration_ms REAL,
    native_message_id TEXT,
    at INTEGER NOT NULL,
    input_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    output_tokens INTEGER,
    reasoning_tokens INTEGER,
    token_source TEXT NOT NULL,
    window TEXT,
    ingest TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS usage_steps_at ON usage_steps(at);
  CREATE INDEX IF NOT EXISTS usage_steps_backend_at ON usage_steps(backend_id, at);
  CREATE INDEX IF NOT EXISTS usage_steps_model_at ON usage_steps(model, at);
  CREATE INDEX IF NOT EXISTS usage_steps_project_at ON usage_steps(project_id, at);
  CREATE INDEX IF NOT EXISTS usage_steps_run ON usage_steps(run_id);
  CREATE INDEX IF NOT EXISTS usage_steps_session_agent_at ON usage_steps(session_id, agent_kind, at);

  CREATE TABLE IF NOT EXISTS run_facts (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    backend_id TEXT NOT NULL,
    profile_id TEXT,
    model_requested TEXT,
    model_resolved TEXT,
    mode TEXT,
    approval TEXT,
    state TEXT NOT NULL,
    delivery TEXT,
    created_at INTEGER NOT NULL,
    queue_ms INTEGER,
    ttft_ms INTEGER,
    duration_ms INTEGER,
    input_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    output_tokens INTEGER,
    reasoning_tokens INTEGER,
    estimated_output_tokens INTEGER NOT NULL DEFAULT 0,
    measured_ms INTEGER,
    speed_output_tokens INTEGER,
    speed_estimated_output_tokens INTEGER,
    windows TEXT,
    steps INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    subagents INTEGER NOT NULL DEFAULT 0,
    attachments INTEGER NOT NULL DEFAULT 0,
    prompt_chars INTEGER NOT NULL DEFAULT 0,
    error_code TEXT);
  CREATE INDEX IF NOT EXISTS run_facts_created ON run_facts(created_at);
  CREATE INDEX IF NOT EXISTS run_facts_backend_created ON run_facts(backend_id, created_at);
  CREATE INDEX IF NOT EXISTS run_facts_session ON run_facts(session_id);

  CREATE TABLE IF NOT EXISTS tool_calls (
    session_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    run_id TEXT,
    backend_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    failed INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL,
    PRIMARY KEY (session_id, tool_call_id));
  CREATE INDEX IF NOT EXISTS tool_calls_at ON tool_calls(at);
  CREATE INDEX IF NOT EXISTS tool_calls_run ON tool_calls(run_id);

  CREATE TABLE IF NOT EXISTS stats_cursor (
    session_id TEXT PRIMARY KEY,
    generation TEXT,
    position TEXT,
    updated_at INTEGER NOT NULL);
`;

export function ensureStatsSchema(db: DatabaseSync): void {
  db.exec(STATS_SCHEMA);
  const columns = new Set((db.prepare('PRAGMA table_info(usage_steps)').all() as Array<{ name: string }>).map(column => column.name));
  if (!columns.has('duration_ms')) db.exec('ALTER TABLE usage_steps ADD COLUMN duration_ms REAL');
  if (!columns.has('native_message_id')) db.exec('ALTER TABLE usage_steps ADD COLUMN native_message_id TEXT');
  const facts = new Set((db.prepare('PRAGMA table_info(run_facts)').all() as Array<{ name: string }>).map(column => column.name));
  if (!facts.has('speed_output_tokens')) db.exec('ALTER TABLE run_facts ADD COLUMN speed_output_tokens INTEGER');
  if (!facts.has('speed_estimated_output_tokens')) db.exec('ALTER TABLE run_facts ADD COLUMN speed_estimated_output_tokens INTEGER');
}

/**
 * Column semantics the writer and the reader both rely on:
 *
 * - `usage_steps.step_key` is `backendId:sessionId:stepId`; a run-level migration row uses the
 *   stepId `migration:<runId>` and is deleted as soon as that run gets any non-migration row.
 * - `usage_steps.at` is the instant token metrics are bucketed by: `started_at ?? ended_at ??`
 *   the owning run's creation time.
 * - `run_facts` token columns are the sums over the run's `usage_steps` (NULL when no step reported
 *   that column). `measured_ms` is the summed step duration used for output speed, `windows` a
 *   comma-separated list of the step windows that contributed.
 * - `run_facts.created_at` is the instant run counts, session counts and latencies are bucketed by.
 */
export interface UsageStepRow {
  step_key: string; session_id: string; run_id: string | null; project_id: string;
  backend_id: string; profile_id: string | null; model: string | null; requested_model: string | null;
  agent_kind: 'main' | 'subagent'; subagent_type: string | null; parent_step_key: string | null;
  started_at: number | null; ended_at: number | null; at: number;
  duration_ms: number | null; native_message_id: string | null;
  input_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null;
  output_tokens: number | null; reasoning_tokens: number | null;
  token_source: 'provider' | 'estimated'; window: string | null; ingest: 'live' | 'backfill' | 'migration';
}

export interface RunFactRow {
  run_id: string; session_id: string; project_id: string; backend_id: string; profile_id: string | null;
  model_requested: string | null; model_resolved: string | null; mode: string | null; approval: string | null;
  state: 'completed' | 'failed' | 'cancelled' | 'interrupted'; delivery: string | null;
  created_at: number; queue_ms: number | null; ttft_ms: number | null; duration_ms: number | null;
  input_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null;
  output_tokens: number | null; reasoning_tokens: number | null; estimated_output_tokens: number;
  measured_ms: number | null; windows: string | null;
  speed_output_tokens: number | null; speed_estimated_output_tokens: number | null;
  steps: number; tool_calls: number; subagents: number; attachments: number; prompt_chars: number;
  error_code: string | null;
}

export interface ToolCallRow {
  session_id: string; tool_call_id: string; run_id: string | null; backend_id: string;
  tool_name: string; failed: 0 | 1; at: number;
}
