import { describe, expect, it } from 'vitest';
import { escapeCurrencyDollars } from './dollarMath';

describe('dollars that are money, not math', () => {
  it('escapes a span whose closing dollar follows a digit or a space', () => {
    expect(escapeCurrencyDollars('价格 $5 到 $10 之间')).toBe('价格 \\$5 到 \\$10 之间');
    expect(escapeCurrencyDollars('成本 $10/月，收益 $20/月')).toBe('成本 \\$10/月，收益 \\$20/月');
  });

  it('leaves real math, display math, destinations and code alone', () => {
    expect(escapeCurrencyDollars('公式 $a$ 和 $b$')).toBe('公式 $a$ 和 $b$');
    expect(escapeCurrencyDollars('$$E=mc^2$$')).toBe('$$E=mc^2$$');
    expect(escapeCurrencyDollars('[x](https://a.com/$5$10)')).toBe('[x](https://a.com/$5$10)');
    expect(escapeCurrencyDollars('`$5 到 $10`')).toBe('`$5 到 $10`');
  });
});
