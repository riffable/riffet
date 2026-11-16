import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeContext } from '../../../../../packages/contracts/src/index.js';
import type { UsageRecord } from '../../stats/types.js';
import { codexTokenBreakdown } from './transcript.js';

const USAGE_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'] as const;
type UsageField = typeof USAGE_FIELDS[number];
type Usage = Partial<Record<UsageField, number>>;

interface RolloutTurn {
  model?: string;
  startedAt?: number;
  /** The turn's own running total from `token_usage_record`. */
  recorded?: Usage;
  /** Thread total when the turn started and the latest one seen inside it, from `token_count`. */
  baseline?: Usage;
  latest?: Usage;
  settled: boolean;
}

const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function usageOf(value: unknown): Usage | undefined {
  const source = record(value);
  if (!source) return undefined;
  const usage: Usage = {};
  for (const field of USAGE_FIELDS) {
    const amount = count(source[field]);
    if (amount !== undefined) usage[field] = amount;
  }
  return usage.output_tokens === undefined && usage.input_tokens === undefined ? undefined : usage;
}

function minus(total: Usage, baseline: Usage | undefined): Usage {
  const result: Usage = {};
  for (const field of USAGE_FIELDS) {
    const amount = total[field];
    if (amount !== undefined) result[field] = Math.max(0, amount - (baseline?.[field] ?? 0));
  }
  return result;
}

/** Only these rows carry usage; any other line is passed over without being parsed. */
const USAGE_MARKERS = ['"turn_context"', '"token_usage_record"', '"task_started"', '"token_count"', '"task_complete"', '"turn_aborted"'];

/**
 * [parseRolloutUsage] one line at a time, so a long rollout can be read as a stream: the reader
 * holds the per-turn totals, never the file (docs/guide/performance.md §3.8).
 */
export class RolloutUsageReader {
  private readonly turns = new Map<string, RolloutTurn>();
  private current: string | undefined;
  private threadTotal: Usage | undefined;

  constructor(private readonly threadId: string) {}

  private turnFor(id: string): RolloutTurn {
    let turn = this.turns.get(id);
    if (!turn) { turn = { settled: false }; this.turns.set(id, turn); }
    return turn;
  }

  line(line: string): void {
    if (!line.trim() || !USAGE_MARKERS.some((marker) => line.includes(marker))) return;
    let row: Record<string, unknown> | undefined;
    try { row = record(JSON.parse(line)); } catch { return; }
    const payload = record(row?.payload);
    if (!row || !payload) return;
    const at = Date.parse(String(row.timestamp ?? ''));
    if (row.type === 'turn_context') {
      const id = text(payload.turn_id);
      const model = text(payload.model);
      if (id && model) this.turnFor(id).model = model;
      return;
    }
    if (row.type === 'token_usage_record') {
      const id = text(payload.turn_id);
      const thread = text(payload.thread_id);
      const usage = usageOf(payload.turn_token_usage);
      if (id && usage && (!thread || thread === this.threadId)) this.turnFor(id).recorded = usage;
      return;
    }
    if (row.type !== 'event_msg') return;
    const kind = payload.type;
    if (kind === 'task_started') {
      const id = text(payload.turn_id);
      if (!id) return;
      this.current = id;
      const turn = this.turnFor(id);
      // `started_at` is whole seconds and can read earlier than the run that sent the prompt.
      const startedSeconds = count(payload.started_at);
      turn.startedAt = Number.isFinite(at) ? at : startedSeconds !== undefined ? startedSeconds * 1000 : undefined;
      turn.baseline = this.threadTotal;
    } else if (kind === 'token_count') {
      const total = usageOf(record(payload.info)?.total_token_usage);
      if (!total) return;
      this.threadTotal = total;
      if (this.current) this.turnFor(this.current).latest = total;
    } else if (kind === 'task_complete' || kind === 'turn_aborted') {
      const id = text(payload.turn_id) ?? this.current;
      if (id) this.turnFor(id).settled = true;
      if (id === this.current) this.current = undefined;
    }
  }

  /** The settled turns read so far; `quiet` settles the last one too. */
  records(quiet: boolean): UsageRecord[] {
    if (this.current && quiet) this.turnFor(this.current).settled = true;
    const records: UsageRecord[] = [];
    for (const [id, turn] of this.turns) {
      if (!turn.settled) continue;
      const usage = turn.recorded ?? (turn.latest ? minus(turn.latest, turn.baseline) : undefined);
      if (!usage || usage.output_tokens === undefined) continue;
      const input = usage.input_tokens;
      const cached = usage.cached_input_tokens;
      records.push({
        stepId: `turn:${id}`,
        ...(turn.model ? { model: turn.model } : {}),
        ...(turn.startedAt !== undefined ? { startedAt: turn.startedAt } : {}),
        ...(input === undefined ? {} : { inputTokens: Math.max(0, input - (cached ?? 0)) }),
        ...(cached === undefined ? {} : { cacheReadTokens: cached }),
        ...(usage.cache_write_input_tokens === undefined ? {} : { cacheWriteTokens: usage.cache_write_input_tokens }),
        outputTokens: usage.output_tokens,
        ...(usage.reasoning_output_tokens === undefined ? {} : { reasoningTokens: usage.reasoning_output_tokens }),
        tokenSource: 'provider',
      });
    }
    return records;
  }
}

/**
 * Settled per-turn usage from a Codex rollout, as the ledger records it live: `stepId` is
 * `turn:<turn id>` and the counts are the turn's own totals. Codex counts cached input inside
 * `input_tokens`, so the cached part is subtracted to leave the cache miss.
 *
 * A turn is settled once its `task_complete` or `turn_aborted` landed. The last turn of a
 * transcript that stopped being written (`quiet`) is taken as settled too: its process is gone.
 * Records of other threads in the same file are ignored.
 */
export function parseRolloutUsage(content: string, threadId: string, quiet: boolean): UsageRecord[] {
  const reader = new RolloutUsageReader(threadId);
  for (const line of content.split('\n')) reader.line(line);
  return reader.records(quiet);
}

/**
 * Context occupancy as Codex itself reports it: how much of the model's window the last request
 * held.
 *
 * `last_token_usage.total_tokens` is that request's whole prompt plus its output — what the next
 * request will carry — and `model_context_window` is the provider's own window, so the ratio is the
 * one Codex's status line shows. Both are provider-reported: when either is missing this returns
 * nothing rather than inventing a window from a model name.
 *
 * The caller reads the tail of a rollout, so the last complete `token_count` line wins.
 */
export interface RolloutContext { used: number; size: number; breakdown?: NativeContext['breakdown'] }

export function parseRolloutContext(content: string): RolloutContext | undefined {
  let found: RolloutContext | undefined;
  for (const line of content.split('\n')) {
    // A cheap pre-filter: a rollout is mostly message text, and parsing every line would cost more
    // than the tail read that produced this string.
    if (!line.includes('token_count')) continue;
    let row: Record<string, unknown> | undefined;
    try { row = record(JSON.parse(line)); } catch { continue; }
    const payload = record(row?.payload);
    if (!payload || payload.type !== 'token_count') continue;
    const info = record(payload.info);
    const last = record(info?.last_token_usage);
    const used = count(last?.total_tokens);
    const size = count(info?.model_context_window);
    if (used === undefined || size === undefined || size <= 0) continue;
    const breakdown = codexTokenBreakdown(last);
    found = { used, size, ...(breakdown.length ? { breakdown } : {}) };
  }
  return found;
}

const rolloutPaths = new Map<string, string>();/**
 * The rollout file of one thread under `<codex home>/sessions/YYYY/MM/DD/`, newest day first.
 * Found paths are remembered: a rollout never moves while its thread is in use.
 */
export async function findCodexRollout(codexHome: string, threadId: string): Promise<string | undefined> {
  if (!/^[0-9a-f-]{16,64}$/i.test(threadId)) return undefined;
  const cacheKey = `${codexHome}\u0000${threadId}`;
  const cached = rolloutPaths.get(cacheKey);
  if (cached) return cached;
  const suffix = `-${threadId}.jsonl`;
  const list = async (path: string) => {
    try { return (await readdir(path)).filter(name => !name.startsWith('.')).sort().reverse(); } catch { return []; }
  };
  const root = join(codexHome, 'sessions');
  for (const year of await list(root)) {
    for (const month of await list(join(root, year))) {
      for (const day of await list(join(root, year, month))) {
        const name = (await list(join(root, year, month, day))).find(file => file.startsWith('rollout-') && file.endsWith(suffix));
        if (!name) continue;
        const path = join(root, year, month, day, name);
        rolloutPaths.set(cacheKey, path);
        if (rolloutPaths.size > 512) rolloutPaths.delete(rolloutPaths.keys().next().value!);
        return path;
      }
    }
  }
  return undefined;
}
