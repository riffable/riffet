import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findCodexRollout, parseRolloutContext, parseRolloutUsage } from './rollout-usage.js';

const THREAD = '01a11b9b-9b5d-7303-8091-b6e4d2afea96';
const usage = (input: number, cached: number, output: number, reasoning = 0) => ({
  input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output,
});
const line = (timestamp: string, type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp, type, payload });
const started = (turn: string, at: string) => line(at, 'event_msg', { type: 'task_started', turn_id: turn, started_at: Date.parse(at) / 1000 });
const context = (turn: string, model: string) => line('2026-10-08T13:02:30.000Z', 'turn_context', { turn_id: turn, model });
const recorded = (turn: string, turnUsage: object, thread = THREAD) => line('2026-10-08T13:02:40.000Z', 'token_usage_record', { thread_id: thread, turn_id: turn, turn_token_usage: turnUsage });
const complete = (turn: string) => line('2026-10-08T13:04:10.000Z', 'event_msg', { type: 'task_complete', turn_id: turn });
const tokenCount = (total: object) => line('2026-10-08T13:02:42.000Z', 'event_msg', { type: 'token_count', info: { total_token_usage: total } });

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe('parseRolloutUsage', () => {
  it('keeps the latest turn total, subtracts cached input and ignores other threads', () => {
    const content = [
      started('t1', '2026-10-08T13:02:25.000Z'),
      context('t1', 'gpt-6-astra'),
      recorded('t1', usage(19686, 0, 135)),
      recorded('t1', usage(39899, 19456, 184, 12)),
      recorded('t1', usage(1, 0, 999), 'another-thread'),
      complete('t1'),
      '{not json',
    ].join('\n');
    expect(parseRolloutUsage(content, THREAD, false)).toEqual([{
      stepId: 'turn:t1', model: 'gpt-6-astra', startedAt: Date.parse('2026-10-08T13:02:25.000Z'),
      inputTokens: 39899 - 19456, cacheReadTokens: 19456, cacheWriteTokens: 0, outputTokens: 184, reasoningTokens: 12, tokenSource: 'provider',
    }]);
  });

  it('holds an unfinished turn back until the rollout has gone quiet', () => {
    const content = [started('t1', '2026-10-08T13:02:25.000Z'), recorded('t1', usage(10, 0, 5))].join('\n');
    expect(parseRolloutUsage(content, THREAD, false)).toEqual([]);
    expect(parseRolloutUsage(content, THREAD, true)).toMatchObject([{ stepId: 'turn:t1', outputTokens: 5 }]);
  });

  it('falls back to thread totals for rollouts without per-turn records', () => {
    const content = [
      started('t1', '2026-10-08T13:00:00.000Z'), tokenCount(usage(100, 0, 10)), complete('t1'),
      started('t2', '2026-10-08T13:05:00.000Z'), tokenCount(usage(150, 40, 18)), tokenCount(usage(300, 140, 30)), complete('t2'),
    ].join('\n');
    expect(parseRolloutUsage(content, THREAD, false)).toMatchObject([
      { stepId: 'turn:t1', inputTokens: 100, cacheReadTokens: 0, outputTokens: 10 },
      { stepId: 'turn:t2', inputTokens: 200 - 140, cacheReadTokens: 140, outputTokens: 20 },
    ]);
  });
});

describe('findCodexRollout', () => {
  it('finds a thread rollout under the dated session folders', async () => {
    const home = await mkdtemp(join(tmpdir(), 'riffet-codex-home-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const day = join(home, 'sessions', '2026', '10', '08');
    await mkdir(day, { recursive: true });
    await mkdir(join(home, 'sessions', '2026', '10', '09'), { recursive: true });
    await writeFile(join(day, `rollout-2026-10-08T21-02-25-${THREAD}.jsonl`), '');
    expect(await findCodexRollout(home, THREAD)).toBe(join(day, `rollout-2026-10-08T21-02-25-${THREAD}.jsonl`));
    expect(await findCodexRollout(home, '01a11b9b-0000-0000-0000-000000000000')).toBeUndefined();
    expect(await findCodexRollout(home, '../escape')).toBeUndefined();
  });
});

describe('the context meter reads a rollout, not a guess', () => {
  const count = (last: object, window: unknown) => line('2026-10-08T13:02:42.000Z', 'event_msg', { type: 'token_count', info: { last_token_usage: last, model_context_window: window } });

  it('takes the last request together with the reported window', () => {
    const content = [
      count({ total_tokens: 10_000 }, 200_000),
      count({ total_tokens: 31_669 }, 486_400),
    ].join('\n');
    expect(parseRolloutContext(content)).toEqual({ used: 31_669, size: 486_400 });
  });

  it('invents nothing when the window is missing or unusable', () => {
    expect(parseRolloutContext(count({ total_tokens: 31_669 }, null))).toBeUndefined();
    expect(parseRolloutContext(count({ total_tokens: 31_669 }, 0))).toBeUndefined();
    expect(parseRolloutContext(count({ input_tokens: 5 }, 200_000))).toBeUndefined();
    expect(parseRolloutContext('')).toBeUndefined();
  });
});
