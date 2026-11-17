import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM package source
import { usageFromKeyInfo } from './server/usage.mjs';

const now = Date.parse('2026-11-17T00:00:00Z');
describe('litellm usage', () => {
  it('maps a budgeted key to one window', () => {
    const usage = usageFromKeyInfo({ info: { spend: 12.5, max_budget: 50, budget_duration: '30d', budget_reset_at: '2026-12-01T00:00:00Z' } }, now);
    expect(usage.account).toEqual({ windows: [{ usedPercent: 25, windowMinutes: 43200, resetsAt: '2026-12-01T00:00:00.000Z' }] });
  });
  it('omits the window without a budget and rejects a foreign body', () => {
    expect(usageFromKeyInfo({ info: { spend: 3, max_budget: null } }, now).account).toBeUndefined();
    expect(() => usageFromKeyInfo({}, now)).toThrow();
  });
});
