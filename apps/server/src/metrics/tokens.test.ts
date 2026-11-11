import { describe, expect, it } from 'vitest';
import { estimateTokens } from './tokens.js';

describe('token estimation', () => {
  it('scales ASCII text at roughly three characters per token', () => {
    // The coefficient is fitted, not derived, so this pins the calibration rather than a rule.
    expect(estimateTokens('a'.repeat(300))).toBeGreaterThan(80);
    expect(estimateTokens('a'.repeat(300))).toBeLessThan(110);
  });

  it('charges non-ASCII far more per character than ASCII', () => {
    expect(estimateTokens('中'.repeat(100))).toBeGreaterThan(estimateTokens('a'.repeat(100)) * 3);
  });

  it('counts a surrogate pair once instead of twice', () => {
    expect(estimateTokens('😀')).toBeCloseTo(estimateTokens('中'), 5);
  });
});
