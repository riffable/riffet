import { describe, expect, it } from 'vitest';
import { dialogLines, matchesOtherValue, parseDialog } from './interaction-screen.js';

function box(content: string[], border: 'square' | 'round' = 'square'): string {
  const width = Math.max(...content.map(line => line.length));
  const [topLeft, topRight, bottomLeft, bottomRight] = border === 'square'
    ? ['┌', '┐', '└', '┘']
    : ['╭', '╮', '╰', '╯'];
  return [
    `${topLeft}${'─'.repeat(width + 2)}${topRight}`,
    ...content.map(line => `│ ${line.padEnd(width)} │`),
    `${bottomLeft}${'─'.repeat(width + 2)}${bottomRight}`,
  ].join('\n');
}

function questionScreen(overrides: {
  title?: string;
  question?: string[];
  rows?: string[];
  footer?: string;
  border?: 'square' | 'round';
} = {}): string {
  return box([
    overrides.title ?? 'Clarifying Questions',
    'Question 1 of 2',
    ...(overrides.question ?? ['1. Choose a format']),
    ...(overrides.rows ?? ['› [ ] Compact', '  [ ] Detailed', '  [ ] Other: (type to answer)']),
    overrides.footer ?? '↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip',
  ], overrides.border);
}

describe('native interaction screen parser', () => {
  it('parses a complete AskQuestion box into visible choices, current focus, and answer actions', () => {
    const screen = questionScreen({
      question: ['1. Preferred season?'],
      rows: ['  [x] Spring', '› [ ] Summer', '  [ ] Winter', '  [ ] Other: (type to answer)'],
      border: 'round',
    });

    const parsed = parseDialog(screen, { id: 'terminal-a', epoch: 7 });
    expect(parsed).toBeDefined();
    expect(parsed?.interaction).toMatchObject({
      kind: 'question',
      title: 'Clarifying Questions',
      message: 'Preferred season?',
      multiple: false,
      allowOther: true,
      otherValue: '',
      otherSelected: false,
      questionIndex: 1,
      questionCount: 2,
      options: [
        { id: 'option-0', label: 'Spring', selected: true },
        { id: 'option-1', label: 'Summer', selected: false },
        { id: 'option-2', label: 'Winter', selected: false },
      ],
      actions: [
        { id: 'next', label: '下一题（保留当前答案）' },
        { id: 'answer', label: '保存并下一题', tone: 'primary' },
        { id: 'skip', label: '跳过整组问题' },
      ],
    });
    expect(parsed?.focus).toBe(1);
    expect(parsed?.rows).toEqual([
      { id: 'option-0', label: 'Spring', selected: true, other: false },
      { id: 'option-1', label: 'Summer', selected: false, other: false },
      { id: 'option-2', label: 'Winter', selected: false, other: false },
      { id: 'other', label: 'Other: (type to answer)', selected: false, other: true },
    ]);
  });

  it('preserves wrapped multiline prompts and option labels and recognizes multi-select', () => {
    const screen = questionScreen({
      question: ['1. Select every platform that should be', 'supported (multi-select)'],
      rows: ['› [x] Desktop application', 'and companion shell', '  [ ] Mobile application', '  [ ] Other: iPad and tablet'],
    });

    const parsed = parseDialog(screen, { id: 'terminal-a', epoch: 7 });
    expect(parsed?.interaction).toMatchObject({
      message: 'Select every platform that should be supported',
      multiple: true,
      options: [
        { label: 'Desktop application and companion shell', selected: true },
        { label: 'Mobile application', selected: false },
      ],
      otherValue: 'iPad and tablet',
      otherSelected: false,
    });
    expect(parsed?.focus).toBe(0);
  });

  it.each([
    [['只跟 feed 场景相关，如果不只是服务于', 'feed，那就改名'], '只跟 feed 场景相关，如果不只是服务于 feed，那就改名'],
    [['还是叫', 'feed，后面再说'], '还是叫feed，后面再说'],
    [['use feed_', 'measure for this'], 'use feed_measure for this'],
    [['use the', 'feed module'], 'use the feed module'],
    [['请先确认 arch lab 的目标是什么？', 'https://example.invalid/docx/ExampleLink123'], '请先确认 arch lab 的目标是什么？ https://example.invalid/docx/ExampleLink123'],
    [['参考 https://example.invalid/docx/Example', 'Link123'], '参考 https://example.invalid/docx/ExampleLink123'],
  ])('confirms Other text against visible lines without guessing wrap-boundary spaces (%j)', (lines, answer) => {
    const parsed = parseDialog(questionScreen({ rows: ['  [ ] Compact', `› [x] Other: ${lines[0]}`, ...lines.slice(1)] }), { id: 'terminal-a', epoch: 1 })!;

    expect(matchesOtherValue(parsed, answer)).toBe(true);
    expect(matchesOtherValue(parsed, `${answer} extra`)).toBe(false);
    expect(matchesOtherValue(parsed, answer.slice(0, -1))).toBe(false);
  });

  it('requires the exact characters and spaces within each visible Other line', () => {
    const parsed = parseDialog(questionScreen({ rows: ['  [ ] Compact', '› [x] Other: keep  feed', '工具不改名'] }), { id: 'terminal-a', epoch: 1 })!;

    expect(matchesOtherValue(parsed, 'keep  feed 工具不改名')).toBe(true);
    expect(matchesOtherValue(parsed, 'keep feed 工具不改名')).toBe(false);
    expect(matchesOtherValue(parsed, 'keep  facets 工具不改名')).toBe(false);
  });

  it('recognizes an empty Other editor without treating its placeholder as answer text', () => {
    const parsed = parseDialog(questionScreen(), { id: 'terminal-a', epoch: 1 })!;

    expect(matchesOtherValue(parsed, '')).toBe(true);
    expect(matchesOtherValue(parsed, 'answer')).toBe(false);
  });

  it('parses a question rendered on a narrow phone-sized pane', () => {
    const screen = [
      '  I\'m sending it again.',
      '',
      ' ┌──────────────────────────────────────┐',
      ' │ 精简测试                             │',
      ' │                                      │',
      ' │ Question 1 of 1                      │',
      ' │                                      │',
      ' │ 1. 你说的只保留非常必要的测试，指的  │',
      ' │ 是哪一种？                           │',
      ' │                                      │',
      ' │   › [ ] 测试文件都保留，但加一个只跑 │',
      ' │         核心测试的快速命令（推荐）   │',
      ' │     [ ] 先不动测试                   │',
      ' │     [ ] Other: (type to answer)      │',
      ' │                                      │',
      ' │ ↑/↓ option · ←/→ question · Space    │',
      ' │ select · Enter next/submit · Esc to  │',
      ' │ skip                                 │',
      ' └──────────────────────────────────────┘',
      '',
    ].join('\n');

    expect(parseDialog(screen, { id: 'terminal-a', epoch: 1 })?.interaction).toMatchObject({
      title: '精简测试',
      message: '你说的只保留非常必要的测试，指的是哪一种？',
      options: [{ label: '测试文件都保留，但加一个只跑核心测试的快速命令（推荐）' }, { label: '先不动测试' }],
    });
  });

  it('strips ANSI color sequences and accepts a complete dialog after transcript output', () => {
    const screen = [
      'old transcript: Question 4 of 4',
      box([
        '\u001b[36mClarifying Questions\u001b[0m',
        'Question 1 of 1',
        '1. Continue?',
        '› [ ] Yes',
        '  [ ] Other: (type to answer)',
        '↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip',
      ]),
      '',
    ].join('\n');

    expect(dialogLines(screen)).toBeDefined();
    expect(parseDialog(screen, { id: 'terminal-a', epoch: 1 })?.interaction.message).toBe('Continue?');
  });

  it('changes interaction identity when the terminal epoch changes and revision when visible state changes', () => {
    const initial = questionScreen();
    const changedSelection = questionScreen({ rows: ['› [x] Compact', '  [ ] Detailed', '  [ ] Other: (type to answer)'] });
    const first = parseDialog(initial, { id: 'terminal-a', epoch: 3 })!.interaction;
    const nextRevision = parseDialog(changedSelection, { id: 'terminal-a', epoch: 3 })!.interaction;
    const nextEpoch = parseDialog(initial, { id: 'terminal-a', epoch: 4 })!.interaction;

    expect(nextRevision.id).toBe(first.id);
    expect(nextRevision.revision).not.toBe(first.revision);
    expect(nextEpoch.id).not.toBe(first.id);
    expect(nextEpoch.revision).not.toBe(first.revision);
  });

  it.each([
    ['missing opening edge', '│ Question 1 of 1 │\n│ 1. Continue? │\n│ › [ ] Yes │\n│   [ ] Other: (type to answer) │\n│ ↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip │\n└────────┘'],
    ['clipped bottom edge', '┌────────────────┐\n│ Clarifying     │\n│ Question 1 of 1│\n│ 1. Continue?   │\n│ › [ ] Yes      │\n│   [ ] Other: (type to answer) │\n│ ↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip │'],
    ['trailing screen content after the box', `${questionScreen()}\nlogin prompt`],
  ])('rejects clipped or non-foreground frames (%s)', (_name, screen) => {
    expect(dialogLines(screen)).toBeUndefined();
    expect(parseDialog(screen, { id: 'terminal-a', epoch: 1 })).toBeUndefined();
  });

  it.each([
    'ordinary terminal output with no bordered dialog',
    box(['Are you sure?', '▶ [y] Yes', '  [n] No']),
  ])('does not reinterpret an unknown prompt as AskQuestion', screen => {
    expect(parseDialog(screen, { id: 'terminal-a', epoch: 1 })).toBeUndefined();
  });

  it('offers an unknown prompt as a plain choice rather than as a question', () => {
    const screen = box(['Unrecognized Device Login', 'Open the device page to continue?', '▶ [a] Open browser', '  [q] Exit'], 'round');

    expect(parseDialog(screen, { id: 'terminal-a', epoch: 1 })?.interaction).toMatchObject({
      kind: 'permission',
      title: 'Open the device page to continue?',
      message: 'Unrecognized Device Login',
      options: [{ label: '[a] Open browser', selected: true }, { label: '[q] Exit', selected: false }],
    });
  });

  it('rejects incomplete, ambiguous, or oversized question layouts', () => {
    const noFocus = questionScreen({ rows: ['  [ ] Compact', '  [ ] Other: (type to answer)'] });
    const twoFocus = questionScreen({ rows: ['› [ ] Compact', '› [ ] Detailed', '  [ ] Other: (type to answer)'] });
    const noOther = questionScreen({ rows: ['› [ ] Compact', '  [ ] Detailed'] });
    const badIndex = box(['Clarifying Questions', 'Question 3 of 2', '3. Continue?', '› [ ] Yes', '  [ ] Other: (type to answer)', '↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip']);

    for (const screen of [noFocus, twoFocus, noOther, badIndex]) {
      expect(parseDialog(screen, { id: 'terminal-a', epoch: 1 })).toBeUndefined();
    }
  });
});
