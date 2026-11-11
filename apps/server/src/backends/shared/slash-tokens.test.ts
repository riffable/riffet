import { describe, expect, it } from 'vitest';
import { referencedSkills, slashTokens } from './slash-tokens.js';

describe('slashTokens', () => {
  it('finds whitespace-bounded tokens anywhere and skips paths, fractions and trailing punctuation', () => {
    expect(slashTokens('/plan then /arc:dev\nand /x.y but not a/b, /usr/bin, 5/8 or /plan。').map(token => token.name))
      .toEqual(['plan', 'arc:dev', 'x.y']);
  });

  it('reports where each token starts and ends', () => {
    expect(slashTokens('use /dataviz now')).toEqual([{ name: 'dataviz', start: 4, end: 12 }]);
  });
});

describe('referencedSkills', () => {
  it('keeps known names in first-seen order, once each', () => {
    const skills = [{ name: 'a' }, { name: 'b' }];
    expect(referencedSkills('/b and /a and /b and /c', skills)).toEqual([{ name: 'b' }, { name: 'a' }]);
  });
});
