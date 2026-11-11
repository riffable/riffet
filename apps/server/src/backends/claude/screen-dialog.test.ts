import { describe, expect, it } from 'vitest';
import { claudeScreenInteraction, isClaudeScreenInteraction, parseClaudeScreenDialog, parseClaudeScreenQuestion } from './screen-dialog.js';

const rule = '─'.repeat(100);
const billingNotice = [
  '● Listing top processes by CPU usage',
  '  ⎿  $ ps aux --sort=-%cpu | head -30',
  '',
  '',
  rule,
  "  We're changing auto mode to no longer charge for classifier requests in Claude Code.",
  '',
  "  However, this session isn't eligible because your requests go through",
  "  gateway.example:48080, which isn't compatible with this update.",
  '',
  '  Nothing breaks: auto mode keeps working, and its classifier requests are billed as before.',
  '',
  '  Enter to continue · Esc to cancel',
  '',
  '',
].join('\n');

// Captured from the real CLI (v2.1.302): the auto-mode setup frame puts the hints for the controls
// a card cannot press in front of the Enter/Esc pair.
const autoModeSetup = [
  rule,
  ' Teach auto mode about your environment?',
  '',
  ' Claude Code reads this project, your recent Claude sessions, and optionally your shell history and other repositories. Claude analyzes this data and customizes auto mode to make better decisions.',
  '',
  '   How you use Claude here    Mixed',
  ' > Also scan shell history    true',
  '   Also scan your other repos false',
  '',
  '   Continue',
  '',
  ' ←/→ to change · Enter to continue · Esc to cancel',
].join('\n');

// Captured from the real CLI (v2.1.302) in fullscreen mode: the conversation, the dialog included,
// sits in a scroll viewport, so the frame draws no rule and the transcript ends right above the title.
const autoModeProposal = [
  '读一下这篇文档：https://docs.example.com/wiki/example ，然后看看有没有能改进的地方',
  '',
  'Review proposed auto-mode setup',
  'Environment',
  '  Org-wide',
  '  · **Organization**: Acme — inferred from the internal remote host.',
  '  · **Cloud provider(s)**: None configured.',
  '',
  'Allow carve-outs',
  '  · Bash(riffet:*)',
  '',
  'Extra soft blocks',
  '  · Bash(killall:*)',
  '',
  'Extra hard blocks',
  '  none suggested',
  '',
  'Notes',
  '  · Repository visibility and branch protection were not gathered.',
  '',
  '❯ Looks good — save it',
  '  Discard and exit',
  '',
  'Enter to confirm · Esc to cancel',
].join('\n');

// Redacted native AskUserQuestion screen, including controls that are not answer options.
const nativeQuestion = [
  rule,
  'Planning: /workspace/.claude/plans/example.md',
  rule,
  '□ 确认后现象',
  '',
  '│ 你点击计划审批的 Allow 后，具体是哪一种情况？',
  '',
  '❯ 1. 审批卡片一直还在',
  '     同一张 ExitPlanMode 卡片没有消失，或按钮一直处于提交中。',
  '  2. 卡片消失，但一直处理中',
  '     看起来已确认，随后没有新内容，状态一直是运行中。',
  '  3. 又出现新的提问或错误',
  '     终端或 Riffet 出现另一张权限卡片、提问、错误信息。',
  '  4. 没注意卡片变化',
  '     先按现有截图和代码证据查，不需要现在重试审批。',
  '  5. Type something.',
  rule,
  '  6. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
  '',
].join('\n');

// Captured from the real CLI (v2.1.302) after its hook timed out: the header glyph is ☐, the prompt is not quoted,
// and the footer gains `ctrl+g to edit in Vim` while the free-text row has focus.
const captured = (focus: number, typed?: string) => {
  const row = (index: number, label: string) => `${focus === index ? '❯' : ' '} ${index}. ${label}`;
  return [
    '❯ Call the AskUserQuestion tool exactly once with one single-select question (header "Letter",',
    '  followed by the chosen label.',
    rule,
    ' ☐ Letter',
    '',
    'Which letter do you pick?',
    '',
    row(1, 'Alpha'), '     Pick the first option.',
    row(2, 'Beta'), '     Pick the second option.',
    row(3, typed ?? 'Type something.'),
    rule,
    row(4, 'Chat about this'),
    '',
    focus >= 3 ? 'Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel' : 'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
};

describe('Claude Code screen dialogs', () => {
  it('reads a notice the TUI draws on its own', () => {
    expect(parseClaudeScreenDialog(billingNotice)).toEqual({
      body: [
        "We're changing auto mode to no longer charge for classifier requests in Claude Code.",
        '',
        "However, this session isn't eligible because your requests go through",
        "gateway.example:48080, which isn't compatible with this update.",
        '',
        'Nothing breaks: auto mode keeps working, and its classifier requests are billed as before.',
      ].join('\n'),
      confirm: 'continue',
      cancel: 'cancel',
    });
  });

  it('offers the footer keys as a confirmation that survives a change of terminal owner', () => {
    const interaction = claudeScreenInteraction(billingNotice, { id: 'term-1', epoch: 3 });
    expect(interaction).toMatchObject({
      transport: 'terminal', terminalId: 'term-1', epoch: 3, kind: 'confirmation', options: [],
      actions: [{ id: 'continue', label: '继续', tone: 'primary' }, { id: 'cancel', label: '取消' }],
    });
    expect(isClaudeScreenInteraction(interaction)).toBe(true);
    expect(claudeScreenInteraction(billingNotice, { id: 'term-1', epoch: 4 })?.id).toBe(interaction?.id);
    expect(claudeScreenInteraction(billingNotice.replace('48080', '48081'), { id: 'term-1', epoch: 3 })?.id).not.toBe(interaction?.id);
  });

  it('reads a frame dialog whose own field hints come before the Enter/Esc pair', () => {
    expect(parseClaudeScreenDialog(autoModeSetup)).toEqual({
      body: [
        'Teach auto mode about your environment?',
        '',
        'Claude Code reads this project, your recent Claude sessions, and optionally your shell history and other repositories. Claude analyzes this data and customizes auto mode to make better decisions.',
        '',
        '  How you use Claude here    Mixed',
        '> Also scan shell history    true',
        '  Also scan your other repos false',
        '',
        '  Continue',
      ].join('\n'),
      confirm: 'continue',
      cancel: 'cancel',
    });
    expect(claudeScreenInteraction(autoModeSetup, { id: 'term-1', epoch: 3 })).toMatchObject({
      kind: 'confirmation', actions: [{ id: 'continue', label: '继续', tone: 'primary' }, { id: 'cancel', label: '取消' }],
    });
    // A screen that only navigates has no action a card could take.
    expect(parseClaudeScreenDialog(autoModeSetup.replace('· Enter to continue', ''))).toBeUndefined();
    expect(parseClaudeScreenDialog(autoModeSetup.replace('←/→ to change', '←/→ change'))).toBeUndefined();
    // `Enter to select` would press whatever a list or tab surface has highlighted.
    const sandbox = autoModeSetup.replace('←/→ to change · Enter to continue', '←/→ to switch · ↑/↓ to navigate · Enter to select').replace('Esc to cancel', 'Esc to close');
    expect(parseClaudeScreenDialog(sandbox)).toBeUndefined();
  });

  it('reads a fullscreen dialog the frame draws without its rule', () => {
    expect(parseClaudeScreenDialog(autoModeProposal)).toMatchObject({
      body: expect.stringContaining('Review proposed auto-mode setup'),
      confirm: 'confirm',
      cancel: 'cancel',
    });
    expect(parseClaudeScreenDialog(autoModeProposal)?.body).toContain('❯ Looks good — save it');
    expect(claudeScreenInteraction(autoModeProposal, { id: 'term-1', epoch: 3 })).toMatchObject({
      kind: 'confirmation', actions: [{ id: 'continue', label: '确认', tone: 'primary' }, { id: 'cancel', label: '取消' }],
    });
  });

  it('lifts the native question into an answerable card whose identity ignores the cursor and typed text', () => {
    const interaction = claudeScreenInteraction(nativeQuestion, { id: 'term-1', epoch: 3 });
    expect(interaction).toMatchObject({
      kind: 'question', transport: 'terminal', allowOther: true, actions: [{ id: 'answer', label: 'Submit', tone: 'primary' }],
      options: [{ id: 'option-0', label: '审批卡片一直还在' }, { id: 'option-1' }, { id: 'option-2' }, { id: 'option-3', label: '没注意卡片变化' }],
    });
    expect(isClaudeScreenInteraction(interaction)).toBe(true);
    expect(interaction?.message).toContain('你点击计划审批的 Allow 后');
    expect(parseClaudeScreenDialog(nativeQuestion)).toBeUndefined();
    const unfocused = nativeQuestion.replace('❯ 1.', '  1.');
    for (const row of [2, 5, 6]) {
      const moved = unfocused.replace(`  ${row}.`, `❯ ${row}.`);
      expect(claudeScreenInteraction(moved, { id: 'term-1', epoch: 4 })?.id).toBe(interaction?.id);
    }
    expect(claudeScreenInteraction(nativeQuestion.replace('一直处理中', '后来完成了'), { id: 'term-1', epoch: 3 })?.id).not.toBe(interaction?.id);
  });

  it('reads the real CLI layout: options with descriptions, cursor row and typed free text', () => {
    expect(parseClaudeScreenQuestion(captured(1))).toMatchObject({
      header: 'Letter', question: 'Which letter do you pick?', focus: 0,
      options: [{ label: 'Alpha', description: 'Pick the first option.' }, { label: 'Beta', description: 'Pick the second option.' }],
    });
    expect(parseClaudeScreenQuestion(captured(2))?.focus).toBe(1);
    expect(parseClaudeScreenQuestion(captured(3))).toMatchObject({ focus: 2 });
    expect(parseClaudeScreenQuestion(captured(3))?.typed).toBeUndefined();
    expect(parseClaudeScreenQuestion(captured(4))?.focus).toBe(3);
    expect(parseClaudeScreenQuestion(captured(3, 'my own words'))).toMatchObject({ focus: 2, typed: 'my own words' });
    const terminal = { id: 'term-1', epoch: 1 };
    const id = claudeScreenInteraction(captured(1), terminal)?.id;
    expect(id).toBeDefined();
    for (const screen of [captured(2), captured(3), captured(4), captured(3, 'my own words')]) expect(claudeScreenInteraction(screen, terminal)?.id).toBe(id);
    // Typed text on a row that no longer has the cursor is not a free-text row.
    expect(parseClaudeScreenQuestion(captured(1, 'my own words'))).toBeUndefined();
    // The tabbed multi-question and checkbox multi-select layouts are not read.
    expect(parseClaudeScreenQuestion(captured(1).replace(' ☐ Letter', '←  ☐ One  ☐ Two  ✔ Submit  →'))).toBeUndefined();
    expect(parseClaudeScreenQuestion(captured(1).replace('1. Alpha', '1. [ ] Alpha'))).toBeUndefined();
  });

  it('does not infer a native question from clipped, quoted, historical or ambiguous screens', () => {
    const screens = [
      `${nativeQuestion}\n● Still working`,
      nativeQuestion.replace('❯ 1.', '  1.'),
      nativeQuestion.replace('  2.', '❯ 2.'),
      nativeQuestion.replace('  3.', '  4.'),
      nativeQuestion.replace('5. Type something.', '5. Something else'),
      nativeQuestion.replace('6. Chat about this', '6. Continue'),
      nativeQuestion.replace('6. Chat about this', '7. Chat about this'),
      nativeQuestion.replace('□ 确认后现象\n', ''),
      nativeQuestion.slice(nativeQuestion.indexOf('□ 确认后现象')),
      nativeQuestion.slice(nativeQuestion.indexOf('❯ 1.')),
      nativeQuestion.replace('Enter to select · ↑/↓ to navigate · Esc to cancel', 'Enter to select'),
      nativeQuestion.split('\n').map(line => `> ${line}`).join('\n'),
      nativeQuestion.replace('│ 你点击', '● 你点击'),
      nativeQuestion.replace('     同一张', '同一张'),
    ];
    for (const screen of screens) {
      expect(parseClaudeScreenQuestion(screen)).toBeUndefined();
      expect(claudeScreenInteraction(screen, { id: 'term-1', epoch: 3 })).toBeUndefined();
    }
  });

  it('leaves alone screens where Enter would do something else', () => {
    const numbered = [rule, '  Do you want to proceed?', '  ❯ 1. Yes', '    2. No', '', '  Enter to confirm · Esc to cancel'].join('\n');
    const footerScrolledAway = `${billingNotice}\n● Still working\n`;
    const noRule = '  Something happened\n\n  Enter to continue · Esc to cancel\n';
    const idle = `${rule}\n> \n${rule}\n  ? for shortcuts\n`;
    for (const screen of [numbered, footerScrolledAway, noRule, idle]) expect(parseClaudeScreenDialog(screen)).toBeUndefined();
  });
});
