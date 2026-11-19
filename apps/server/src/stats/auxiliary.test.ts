import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../store.js';
import { ensureStatsSchema } from './schema.js';
import { AuxiliaryStats } from './auxiliary.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function harness() {
  const store = new Store(':memory:');
  ensureStatsSchema(store.db);
  cleanups.push(() => store.close());
  let nowMs = 1_700_000_000_000;
  const stats = new AuxiliaryStats(store.db, { now: () => nowMs });
  const labels = {
    projectName: () => undefined,
    profileLabel: (_backendId: string, profileId: string) => (profileId === 'gw' ? 'Gateway' : profileId),
  };
  return { stats, labels, advance: (ms: number) => { nowMs += ms; } };
}

describe('AuxiliaryStats', () => {
  it('ranks short, stream and long models separately and filters live vs probe sources', () => {
    const { stats, labels } = harness();
    stats.record({
      kind: 'title', preset: 'short', source: 'live', backendId: 'claude', profileId: 'gw', model: 'fast-haiku',
      transport: 'http', protocol: 'anthropic', ok: true, authMs: 5, ttftMs: 180, durationMs: 320,
      inputTokens: 40, outputTokens: 10, reasoningTokens: 0, reasoningChars: 0, thinkingDetected: false, streaming: false,
    });
    stats.record({
      kind: 'probe', preset: 'short', source: 'probe', backendId: 'codex', profileId: 'local', model: 'slow-cli',
      transport: 'cli-process', protocol: 'responses', ok: true, authMs: 20, ttftMs: null, durationMs: 4_200,
      reasoningChars: 0, thinkingDetected: false, streaming: false,
    });
    stats.record({
      kind: 'plugin', preset: 'stream', source: 'live', backendId: 'dsh', profileId: 'gw', model: 'ds-flash',
      transport: 'http', protocol: 'chat', ok: true, authMs: 3, ttftMs: 250, durationMs: 1_250,
      outputTokens: 100, reasoningChars: 0, thinkingDetected: false, streaming: true,
    });
    stats.record({
      kind: 'chat', preset: 'stream', source: 'live', backendId: 'dsh', profileId: 'gw', model: 'ds-flash',
      transport: 'http', protocol: 'chat', ok: true, authMs: 3, ttftMs: 300, durationMs: 1_300,
      outputTokens: 100, reasoningChars: 50, thinkingDetected: true, streaming: true,
    });
    stats.record({
      kind: 'probe', preset: 'long', source: 'probe', backendId: 'claude', profileId: 'gw', model: 'fast-haiku',
      transport: 'http', protocol: 'anthropic', ok: true, authMs: 5, ttftMs: 520, durationMs: 2_100,
      outputTokens: 120, reasoningChars: 0, thinkingDetected: false, streaming: true,
    });

    const shortAll = stats.leaderboard({ category: 'short', source: 'all', days: 30, labels });
    expect(shortAll.rows.map(row => row.model)).toEqual(['fast-haiku', 'slow-cli']);
    expect(shortAll.rows[0]!.durationMs?.p50).toBe(320);
    expect(shortAll.rows[1]!.transport).toBe('cli-process');

    const shortProbe = stats.leaderboard({ category: 'short', source: 'probe', days: 30, labels });
    expect(shortProbe.rows.map(row => row.model)).toEqual(['slow-cli']);

    const streamAll = stats.leaderboard({ category: 'stream', source: 'all', days: 30, labels });
    expect(streamAll.rows).toHaveLength(1);
    expect(streamAll.rows[0]!.outputTokensPerSecond?.p50).toBeCloseTo(100, 1);
    // Quick chat with user-selected effort should not mark fast-mode thinking leak rate.
    expect(streamAll.rows[0]!.thinkingRate).toBe(0);

    const longProbe = stats.leaderboard({ category: 'long', source: 'probe', days: 30, labels });
    expect(longProbe.rows.map(row => row.model)).toEqual(['fast-haiku']);
  });
});
