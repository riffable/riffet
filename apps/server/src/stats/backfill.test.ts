import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../store.js';
import { StatsBackfill } from './backfill.js';
import { StatsLedger } from './ledger.js';
import type { UsageTranscript } from './types.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function setup() {
  const store = new Store(':memory:');
  const ledger = new StatsLedger(store);
  cleanups.push(() => { ledger.close(); store.close(); });
  const project = store.createProject('/tmp/backfill', 'backfill');
  const codex = store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex', nativeSessionId: 'thread-a' });
  const claude = store.createSession({ projectId: project.id, kind: 'native', backendId: 'claude', nativeSessionId: 'claude-a' });
  store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex' });
  store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor', nativeSessionId: 'cursor-a' });
  return { store, ledger, codex, claude };
}

const rows = (store: Store) => store.db.prepare('SELECT step_key, output_tokens, ingest FROM usage_steps ORDER BY step_key').all() as Array<{ step_key: string; output_tokens: number; ingest: string }>;

describe('StatsBackfill', () => {
  it('writes transcript usage once and skips an unchanged transcript by generation', async () => {
    const { store, ledger, codex, claude } = setup();
    const transcripts: Record<string, UsageTranscript> = {
      [codex.id]: { generation: 'g1', entries: [{ usage: { stepId: 'turn:1', outputTokens: 10, tokenSource: 'provider', startedAt: Date.now() } }] },
      [claude.id]: { generation: 'none', entries: [] },
    };
    const read = vi.fn(async (sessionId: string, known?: string) => transcripts[sessionId]!.generation === known ? undefined : transcripts[sessionId]);
    const backfill = new StatsBackfill({ store, ledger, backendIds: () => ['codex', 'claude'], read });

    expect(await backfill.runOnce()).toBe(1);
    expect(read.mock.calls.map(call => call[0]).sort()).toEqual([codex.id, claude.id].sort());
    expect(rows(store)).toEqual([{ step_key: `codex:${codex.id}:turn:1`, output_tokens: 10, ingest: 'backfill' }]);
    expect(ledger.getCursor(codex.id)).toEqual({ generation: 'g1' });

    read.mockClear();
    expect(await backfill.runOnce()).toBe(0);
    expect(read).toHaveBeenCalledWith(codex.id, 'g1');
  });

  it('retries a failed read later without losing its previous generation', async () => {
    const { store, ledger, codex } = setup();
    ledger.setCursor(codex.id, { generation: 'g0' });
    const read = vi.fn(async (sessionId: string) => {
      if (sessionId === codex.id) throw new Error('locked');
      return null;
    });
    const backfill = new StatsBackfill({ store, ledger, backendIds: () => ['codex', 'claude'], read });
    await backfill.runOnce();
    await backfill.runOnce();
    expect(read.mock.calls.filter(call => call[0] === codex.id)).toEqual([[codex.id, 'g0'], [codex.id, 'g0']]);
    expect(ledger.getCursor(codex.id)).toEqual({ generation: 'g0' });
  });

  it('does nothing when no backend can backfill', async () => {
    const { store, ledger } = setup();
    const read = vi.fn();
    expect(await new StatsBackfill({ store, ledger, backendIds: () => [], read }).runOnce()).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });
});
