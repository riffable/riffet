import { describe, expect, it } from 'vitest';
import { relaxUnderscoreEmphasis } from './cjkEmphasis.js';

describe('underscore emphasis beside CJK', () => {
  it('reads a paired run the way asterisks are read', () => {
    expect(relaxUnderscoreEmphasis('__加粗__中文')).toBe('**加粗**中文');
    expect(relaxUnderscoreEmphasis('_斜体_中文')).toBe('*斜体*中文');
    expect(relaxUnderscoreEmphasis('中文_斜体_')).toBe('中文*斜体*');
  });

  it('leaves identifiers, unmatched runs, code and links alone', () => {
    expect(relaxUnderscoreEmphasis('snake_case_name')).toBe('snake_case_name');
    expect(relaxUnderscoreEmphasis('`__x__中文`')).toBe('`__x__中文`');
    expect(relaxUnderscoreEmphasis('https://x.dev/_a_中文')).toBe('https://x.dev/_a_中文');
  });
});
