import { describe, expect, it } from 'vitest';
import { samePromptText } from './prompt-match';

// The CLI's stored copy of a prompt can differ from what was sent: characters typed into the terminal can
// arrive as U+FFFD, which also changes the length. These cases pin both halves of the rule: a mangled
// receipt must still be recognised (otherwise the run stays uncertain and every later message queues), and
// a different prompt must never be (otherwise a late receipt is bound to the wrong message).
// `PromptMatchTest.kt` holds the same cases for the phones' copy of the rule.

/** Replace the character at each index with `replacement` U+FFFD characters, as the terminal does. */
function mangle(text: string, sites: Array<[number, number]>): string {
  let out = '';
  let cursor = 0;
  for (const [index, replacement] of sites) {
    out += text.slice(cursor, index) + '�'.repeat(replacement);
    cursor = index + 1;
  }
  return out + text.slice(cursor);
}

describe('samePromptText', () => {
  it('accepts an identical prompt', () => {
    expect(samePromptText('inspect the project', 'inspect the project')).toBe(true);
  });

  it('recognises a receipt mangled the way the terminal mangles long CJK prompts', () => {
    // Shaped after a real one: four sites, each replacing one character with two or three U+FFFD,
    // which leaves the stored copy five code units longer than what was sent.
    const sent = `${'股票分析流程与风控规则。'.repeat(300)}请给出建议。`;
    const stored = mangle(sent, [[390, 2], [809, 2], [1630, 2], [2030, 3]]);
    expect(stored.length - sent.length).toBe(5);
    expect(samePromptText(sent, stored)).toBe(true);
    expect(samePromptText(stored, sent)).toBe(true);
  });

  it('recognises a short prompt that lost one character', () => {
    expect(samePromptText('继续', '��续')).toBe(true);
    expect(samePromptText('好的，继续吧', '好的�继续吧')).toBe(true);
    // The last character, and two adjacent ones behind a single run.
    expect(samePromptText('提交代码', '提交代���')).toBe(true);
    expect(samePromptText('提交代码吧', '提���码吧')).toBe(true);
    expect(samePromptText('查看😀日志', '查看�日志')).toBe(true);
    expect(samePromptText('提交代码', '提�码')).toBe(false);
  });

  it('recognises two copies of one prompt mangled at different places', () => {
    expect(samePromptText('先看日志�再重启服务', '先��日志，再重启服务')).toBe(true);
  });

  it('refuses a different short prompt', () => {
    expect(samePromptText('继续', '好的')).toBe(false);
    expect(samePromptText('hi', '你好')).toBe(false);
    expect(samePromptText('好', '清理吧')).toBe(false);
    expect(samePromptText('message 1', 'message 2')).toBe(false);
  });

  it('refuses a prompt that differs in a word, a suffix or a prefix', () => {
    expect(samePromptText('inspect the project', 'delete the project')).toBe(false);
    expect(samePromptText('stock analysis plan', 'stock analysis report')).toBe(false);
    const long = '请检查部署脚本在预发环境的执行结果，并把失败的步骤列出来。'.repeat(8);
    expect(samePromptText(`${long}方案一`, `${long}方案二`)).toBe(false);
    expect(samePromptText(long, `${long}。`)).toBe(false);
    expect(samePromptText(long, `继续，${long}`)).toBe(false);
  });

  it('refuses a copy with no character left to agree on', () => {
    expect(samePromptText('继续', '��')).toBe(false);
    expect(samePromptText('好的', '����')).toBe(false);
    expect(samePromptText('查看 日志', '�� ��')).toBe(false);
  });

  it('compares whitespace by position, not by kind or count', () => {
    expect(samePromptText('a\tb\n\nc', 'a        b c')).toBe(true);
    expect(samePromptText('  inspect the project \n', 'inspect the project')).toBe(true);
    expect(samePromptText('ab c', 'a bc')).toBe(false);
  });

  it('refuses a prompt whose length drifted past the budget', () => {
    const sent = 'a'.repeat(200);
    expect(samePromptText(sent, `${sent}${'b'.repeat(40)}`)).toBe(false);
  });

  it('refuses more mangled places than the rate observed', () => {
    const sent = '股票分析流程与风控规则。'.repeat(20);
    expect(samePromptText(sent, mangle(sent, [[10, 1], [50, 1], [90, 1]]))).toBe(true);
    expect(samePromptText(sent, mangle(sent, [[10, 1], [50, 1], [90, 1], [130, 1]]))).toBe(false);
    expect(samePromptText('查�看�日�志', '查��看��日��志')).toBe(true);
    expect(samePromptText('查�看�日�志�', '查��看��日��志��')).toBe(false);
  });

  it('compares empty sides only with each other', () => {
    expect(samePromptText('', '')).toBe(true);
    expect(samePromptText('', 'inspect the project')).toBe(false);
    expect(samePromptText('inspect the project', '')).toBe(false);
  });
});
