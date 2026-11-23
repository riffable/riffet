import { describe, expect, it } from 'vitest';
import type { CouncilSeat } from '@contracts';
import { readableCouncilText } from './model';

const seat = (id: string, model: string): CouncilSeat => ({
  id, role: 'debater', model: { backendId: 'codex', profileId: 'default', model }, profileName: 'Codex',
});
const seats = [seat('s1', 'gpt-6.2-sol'), seat('s2', 'claude-sonnet-5-5'), seat('s3', 'gpt-6.2-sol')];

describe('readableCouncilText', () => {
  it('names historical speaker aliases consistently without repeating the model name', () => {
    const source = '- **[s1] gpt-6.2-sol：** 第一种说法\n- **[s2] claude-sonnet-5-5：** 第二种说法\n- [s3] gpt-6.2-sol.\n\ns1 和 s2 只论证了一半。s3 认为还不够。第二种比喻和 s1 几乎一样。';
    expect(readableCouncilText(source, seats)).toBe(
      '- **gpt-6.2-sol #1：** 第一种说法\n- **claude-sonnet-5-5：** 第二种说法\n- gpt-6.2-sol #2.\n\ngpt-6.2-sol #1 和 claude-sonnet-5-5 只论证了一半。gpt-6.2-sol #2 认为还不够。第二种比喻和 gpt-6.2-sol #1 几乎一样。',
    );
  });

  it('preserves Markdown links, code, math and unrelated uses of the same characters', () => {
    const literals = [
      '用 [s1] 作为正则表达式里的字符类。文献 [s2] 指出该定理有一个额外前提。',
      '我注意到 [s1] 这个字符类也能匹配数字。',
      '第二种拼写和 s2 几乎一样。',
      '<kbd>[s1] 提出</kbd>、<em>**[s2] 认为**</em>。',
      '`s1`、[s1](https://example.com/s1)、<https://example.com/s1>、https://example.com/s1。',
      '$s1$、\\(s1\\)、\\[s1 + 2\\]、s1 = 0.5、s1.txt、s1-stage、版本 s1。',
      '\\[s1]、[s2][ref]、[ref]。',
      '',
      '[ref]: https://example.com/s1',
      '',
      '```text',
      '[s1] and s2',
      '```',
    ].join('\n');
    expect(readableCouncilText(`[s1] 提出了一点。\n\n${literals}`, seats)).toBe(`gpt-6.2-sol #1 提出了一点。\n\n${literals}`);
  });

  it('keeps real speaker references next to literal markup and in historical questions', () => {
    const source = '<kbd>[s1] 认为</kbd><br> s2 认为还有分歧。\n\nI notice [s3] 用了另一个例子。';
    expect(readableCouncilText(source, seats)).toBe(
      '<kbd>[s1] 认为</kbd><br> claude-sonnet-5-5 认为还有分歧。\n\nI notice gpt-6.2-sol #2 用了另一个例子。',
    );
  });
});
