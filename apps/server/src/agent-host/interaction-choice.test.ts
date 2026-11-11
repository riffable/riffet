import { describe, expect, it } from 'vitest';
import { parseChoiceDialog } from './interaction-choice.js';

const terminal = { id: 'terminal-a', epoch: 1 };
const rule = '  ──────────────────────────────────────────────────';

const writeOptions = [
  '   → Proceed (y)',
  '     Reject & propose changes (esc or n or p)',
  '     Add Write(/home/me/proj/src/a.ts) to allowlist? (tab)',
  '     Run Everything (shift+tab)',
];

const writeLabels = ['Proceed', 'Reject & propose changes', 'Add Write(/home/me/proj/src/a.ts) to allowlist?', 'Run Everything'];

function parse(lines: string[]) {
  return parseChoiceDialog(lines.join('\n'), terminal);
}

function labelsOf(lines: string[]): string[] | undefined {
  return parse(lines)?.interaction.options.map(option => option.label);
}

describe('native choice dialog parser', () => {
  it('parses a write approval that previews a diff', () => {
    const parsed = parse([
      '  Read .../providers/claudeSdkInteractions.ts',
      '',
      '  /home/me/proj/src/a.ts  +2 -0',
      rule,
      '  + const a = 1;',
      '  + const b = 2;',
      '',
      '  Write to this file?',
      '  in /home/me/proj/src/a.ts',
      ...writeOptions,
      '',
    ]);

    expect(parsed?.interaction).toMatchObject({ kind: 'permission', title: 'Write to this file?' });
    expect(parsed?.interaction.options.map(option => option.label)).toEqual(writeLabels);
    expect(parsed?.focus).toBe(0);
    // The title already heads the card; repeating it in the body only wastes a line.
    expect(parsed?.interaction.message).toBe([
      '/home/me/proj/src/a.ts  +2 -0',
      '+ const a = 1;',
      '+ const b = 2;',
      'in /home/me/proj/src/a.ts',
    ].join('\n'));
  });

  it('parses a write approval for a binary file, which previews a path and no diff', () => {
    expect(labelsOf([
      rule,
      '  /home/me/proj/assets/image-0.jpg',
      rule,
      '',
      '  Write to this file?',
      '  in /home/me/proj/assets/image-0.jpg',
      ...writeOptions,
      '',
    ])).toEqual(writeLabels);
  });

  it('rejoins option labels that Ink wrapped at a narrow pane width', () => {
    expect(labelsOf([
      '  /home/me/proj/src/a.ts  +2 -0',
      '  ──────────────────────────────────',
      '  + const a = 1;',
      '',
      '  Write to this file?',
      '  in /home/me/proj/src/a.ts',
      '   → Proceed (y)',
      '     Reject & propose changes (esc or',
      'n or p)',
      '     Add Write(/home/me/proj/src/a.ts) to',
      'allowlist? (tab)',
      '     Run Everything (shift+tab)',
      '',
    ])).toEqual(writeLabels);
  });

  it('keeps the trailing approval switcher out of the options', () => {
    const parsed = parse([
      rule,
      '  $ git status --porcelain',
      '  in .',
      '',
      '  Run this command?',
      '  Not in allowlist: git status',
      '   → Run (once)',
      '     Add Shell(git status) to allowlist?',
      '     Run Everything',
      '     Skip & tell the agent what to do instead',
      '',
      '  ←/→ to switch approval',
    ]);

    expect(parsed?.interaction.options.map(option => option.label)).toEqual([
      'Run (once)',
      'Add Shell(git status) to allowlist?',
      'Run Everything',
      'Skip & tell the agent what to do instead',
    ]);
    expect(parsed?.interaction.message).toBe('$ git status --porcelain\nin .\nNot in allowlist: git status');
  });

  /**
   * Claude Code closes its read approval with a key hint that *names the dismiss key first* —
   * `Esc to cancel · Tab to amend` — and draws the option preview between two dashed rules rather
   * than inside the one rule the other surfaces use. Both differ from every shape above, and the
   * screen was reaching the terminal unread because of it.
   */
  it('lifts Claude Code’s read approval, whose key hint leads with Esc', () => {
    const dashed = `  ${'╌'.repeat(60)}`;
    const parsed = parse([
      rule,
      ' Read outside the working directories',
      dashed,
      ' Read(/tmp/tw-shot/beliefs_crop.png)',
      dashed,
      ' Auto mode and the sandbox read outside the working directories without asking.',
      ' file tools refuse reads outside the working directories in every project.',
      '',
      ' Allow this read outside the working directories?',
      ' ❯ 1. Yes, and keep allowing any reads outside the working directories',
      '   2. No, and block reads outside the working directories from now on',
      '   3. No, and ask again next time',
      '   4. Yes, but ask again next time',
      '',
      ' Esc to cancel · Tab to amend',
    ]);

    expect(parsed?.interaction).toMatchObject({
      kind: 'permission',
      title: 'Allow this read outside the working directories?',
    });
    // The key hint is not an option: it must not be wrapped onto the last row.
    expect(parsed?.interaction.options.map(option => option.label)).toEqual([
      '1. Yes, and keep allowing any reads outside the working directories',
      '2. No, and block reads outside the working directories from now on',
      '3. No, and ask again next time',
      '4. Yes, but ask again next time',
    ]);
    expect(parsed?.focus).toBe(0);
    expect(parsed?.interaction.message).toContain('Read(/tmp/tw-shot/beliefs_crop.png)');
  });

  it('still refuses a screen whose option list is followed by real output', () => {
    // The hint allowance is narrow on purpose: anything below the options that is not the CLI's own
    // key hint means the list is not the bottom of the screen.
    for (const trailing of ['  ⏺ Done', '  Opus 5 · 12s', '  Esc to cancel · then keep going']) {
      expect(parse([
        rule,
        '  $ rm -rf /',
        '',
        '  Run this command?',
        '   → Run (once)',
        '     Skip',
        '',
        trailing,
      ])).toBeUndefined();
    }
  });

  // The CLI renames prompts and adds permission kinds between versions. Matching the shape rather
  // than the wording is what keeps those from silently stranding the user in the terminal.
  it('lifts a decision surface whose wording it has never seen', () => {
    const parsed = parse([
      rule,
      '  🔐 Credential: GITHUB_TOKEN',
      '',
      '  Share this secret with the agent?',
      '   → Share once (y)',
      '     Never share (n)',
      '',
    ]);

    expect(parsed?.interaction).toMatchObject({
      kind: 'permission',
      title: 'Share this secret with the agent?',
      message: '🔐 Credential: GITHUB_TOKEN',
      options: [{ label: 'Share once', selected: true }, { label: 'Never share', selected: false }],
    });
  });

  it.each([
    ['a sandbox escape', '$ rm -rf build', 'Run this command outside the sandbox?', ['Run outside sandbox (once)', 'Skip & tell the agent what to do instead']],
    ['an MCP tool', 'MCP: linear/create_issue', 'Run this MCP tool?', ['Run (once)', 'Reject & propose changes', 'Skip']],
    ['a delete', 'Delete file: /home/me/proj/src/a.ts', 'Delete this file?', ['Delete', 'Keep']],
    ['a read', '/home/me/proj/.env', 'Read this file?', ['Allow once', 'Skip']],
    ['a web search', '🔍 Web Search: tailwind v4 variants', 'Allow this web search?', ['Allow search', 'Skip']],
    ['a web fetch', '🌐 Web Fetch: https://example.com', 'Allow this web fetch?', ['Fetch', 'Always allow example.com', 'Skip']],
  ])('parses the %s surface', (_name, preview, title, labels) => {
    const rows = labels.map((label, index) => `  ${index === 0 ? ' →' : '  '} ${label}`);

    expect(labelsOf([rule, `  ${preview}`, '', `  ${title}`, ...rows, ''])).toEqual(labels);
  });

  it.each([
    ['no focus glyph, so the surface is transcript text rather than a live prompt', [
      rule,
      '  $ rm -rf /',
      '',
      '  Run this command?',
      '     Run (once)',
      '     Skip',
      '',
    ]],
    ['two focus glyphs, so two frames are overlapping mid-repaint', [
      rule,
      '  $ rm -rf /',
      '',
      '  Run this command?',
      '   → Run (once)',
      '   → Skip',
      '',
    ]],
    ['no preview, so nothing describes what is being approved', [
      rule,
      '  Run this command?',
      '   → Run (once)',
      '     Skip',
      '',
    ]],
    ['no question line above the options', [
      rule,
      '  $ rm -rf /',
      '',
      '  Running the command.',
      '   → Run (once)',
      '     Skip',
      '',
    ]],
    ['live screen content below the options', [
      rule,
      '  $ rm -rf /',
      '',
      '  Run this command?',
      '   → Run (once)',
      '     Skip',
      '',
      '  → Add a follow-up',
    ]],
    ['a single option, which no decision surface renders', [
      rule,
      '  $ rm -rf /',
      '',
      '  Run this command?',
      '   → Run (once)',
      '',
    ]],
  ])('leaves it in the terminal: %s', (_name, lines) => {
    expect(parse(lines)).toBeUndefined();
  });

  it('does not lift a plan the strict parser turned down for being truncated', () => {
    const truncated = [
      '  ╭────────────────────────────────────╮',
      '  │ Suggested Plan                     │',
      '  │ 1. Rewrite the parser              │',
      '  │ … (truncated)                      │',
      '  │ Ready to build?                    │',
      '  │  ▶ 1. Yes, build locally (b)       │',
      '  │    2. No, propose changes (p or Esc)│',
      '  ╰────────────────────────────────────╯',
    ];

    expect(parse(truncated)).toBeUndefined();
  });
});

/**
 * Claude Code and Codex draw their startup dialogs without a border or a rule, and close them with
 * their own key hint. These are the two dialogs from the terminal-only report, verbatim from the
 * screenshots (one leading space is the pane's own margin).
 */
describe('hint-closed startup dialogs', () => {
  const trustDialog = [
    ' Accessing workspace:',
    '',
    ' /Users/dev/workspace/relay-service',
    '',
    " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.",
    '',
    " Claude Code'll be able to read, edit, and execute files here.",
    '',
    ' Security guide',
    '',
    ' ❯ No, exit',
    '   Yes, I trust this folder',
    '',
    ' Enter to confirm · Esc to cancel',
  ];
  const hooksDialog = [
    ' Hooks need review',
    ' 14 hooks are new or changed.',
    ' Hooks can run outside the sandbox after you trust them.',
    '',
    ' › 1. Review hooks',
    '   2. Trust all and continue',
    "   3. Continue without trusting (hooks won't run)",
    '',
    ' enter confirm · esc skip',
  ];
  const autoModeInvitation = [
    '❯ Earlier request',
    '● An upstream request failed.',
    '─'.repeat(60),
    ' Teach auto mode about your environment?',
    '',
    ' Auto mode works better when it knows your environment. Takes about a minute.',
    '',
    ' ❯ 1. Yes',
    '   2. Not now',
    "   3. Don't show again",
    '',
    ' Enter to confirm · Esc to cancel',
    '',
    `${'─'.repeat(56)} ↯ ─`,
    '❯ pending message',
    '─'.repeat(60),
    '    Opus · ctx 100% · /tmp/project',
    '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ];

  it('lifts the inline auto-mode invitation with stable option identities above a separate composer', () => {
    const parsed = parse(autoModeInvitation);
    expect(parsed?.interaction).toMatchObject({ kind: 'confirmation', title: 'Teach auto mode about your environment?' });
    expect(parsed?.interaction.actions).toEqual([
      { id: 'option:option-0', label: '1. Yes' },
      { id: 'option:option-1', label: '2. Not now' },
      { id: 'option:option-2', label: "3. Don't show again" },
    ]);
    const moved = autoModeInvitation.map(line => line.replace(' ❯ 1.', '   1.').replace('   2.', ' ❯ 2.').replace('❯ pending message', '❯ another draft'));
    expect(parse(moved)?.focus).toBe(1);
    expect(parse(moved)?.interaction.id).toBe(parsed?.interaction.id);
    expect(parse(moved)?.interaction.revision).toBe(parsed?.interaction.revision);
  });

  it('does not borrow an inline invitation from quoted, clipped or superseded terminal content', () => {
    const title = autoModeInvitation.indexOf(' Teach auto mode about your environment?');
    const hint = autoModeInvitation.indexOf(' Enter to confirm · Esc to cancel');
    for (const lines of [
      autoModeInvitation.slice(title),
      autoModeInvitation.map(line => line === ' Teach auto mode about your environment?' ? ' An unknown question?' : line),
      [...autoModeInvitation.slice(0, title), '● Here is a quoted dialog:', ...autoModeInvitation.slice(title)],
      [...autoModeInvitation.slice(0, hint + 1), '● The dialog has closed.', ...autoModeInvitation.slice(hint + 1)],
      autoModeInvitation.filter((_, index) => index !== autoModeInvitation.length - 3),
    ]) expect(parse(lines)).toBeUndefined();
  });

  it('lifts the workspace trust dialog, focus included', () => {
    const parsed = parse(trustDialog);
    expect(parsed?.interaction).toMatchObject({ kind: 'confirmation', title: 'Accessing workspace:' });
    expect(parsed?.interaction.options.map(option => option.label)).toEqual(['No, exit', 'Yes, I trust this folder']);
    expect(parsed?.focus).toBe(0);
    expect(parsed?.interaction.message).toContain('/Users/dev/workspace/relay-service');
    expect(parsed?.interaction.actions.map(action => action.id)).toEqual(['option:option-0', 'option:option-1']);
  });

  it('lifts the Codex hook review, keeping the CLI’s own numbering', () => {
    const parsed = parse(hooksDialog);
    expect(parsed?.interaction).toMatchObject({ kind: 'confirmation', title: 'Hooks need review' });
    expect(parsed?.interaction.options.map(option => option.label)).toEqual([
      '1. Review hooks',
      '2. Trust all and continue',
      "3. Continue without trusting (hooks won't run)",
    ]);
    expect(parsed?.interaction.message).toContain('14 hooks are new or changed.');
  });

  it('lifts the TRAE CLI hook review, whose focus glyph and footer differ from Codex', () => {
    const parsed = parse([
      '  Hooks need review',
      '  1 hook is new or changed.',
      '  Hooks can run outside the sandbox after you trust them.',
      '❯ 1. Review hooks',
      '  2. Trust all and continue',
      "  3. Continue without trusting (hooks won't run)",
      '  enter confirm  |  esc go back',
    ]);
    expect(parsed?.interaction).toMatchObject({ kind: 'confirmation', title: 'Hooks need review' });
    expect(parsed?.interaction.options.map(option => option.label)).toEqual([
      '1. Review hooks', '2. Trust all and continue', "3. Continue without trusting (hooks won't run)",
    ]);
    expect(parsed?.focus).toBe(0);
  });

  it('leaves a transcript that merely quotes the labels in the terminal', () => {
    // Same words, no focus glyph: this is a message, not a live control.
    expect(parse(trustDialog.filter(line => !line.startsWith(' ❯')))).toBeUndefined();
  });

  it('refuses a screen with two focus glyphs or trailing text after the hint', () => {
    expect(parse([...trustDialog.slice(0, -2), ' ❯ Yes, I trust this folder', '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel'])).toBeUndefined();
    expect(parse([...trustDialog, ' stray output'])).toBeUndefined();
  });

  it('recognizes an unknown hint-closed dialog by shape alone', () => {
    const parsed = parse([
      ' Some new gate',
      ' It changes what runs here.',
      '',
      ' ❯ Allow it',
      '   Refuse',
      '',
      ' Enter to confirm · Esc to cancel',
    ]);
    // Shape alone is not proof the CLI is blocked: a transcript that quotes a dialog looks the same,
    // and answering it would press real keys into a CLI showing no dialog. Unknown titles stay in the
    // terminal until they are named in `HINTED_TITLES`.
    expect(parsed).toBeUndefined();
  });

  it('refuses a transcript that quotes a known dialog', () => {
    expect(parse([
      ' Done. Here is the dialog Claude Code shows:',
      '',
      '   No, exit',
      ' ❯ Yes, I trust this folder',
      '',
      ' Enter to confirm · Esc to cancel',
    ])).toBeUndefined();
    // …while the same rows under a title the CLI actually prints are lifted.
    expect(parse([' Accessing workspace:', '', '   No, exit', ' ❯ Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel']))
      .toMatchObject({ interaction: { kind: 'confirmation', title: 'Accessing workspace:' } });
  });

  it('lifts an arrow-led hint as well as a word one', () => {
    expect(parse([' Hooks need review', '', ' ❯ Review hooks', '   Trust all and continue', '', ' ↑/↓ to select · Enter to confirm']))
      .toMatchObject({ interaction: { title: 'Hooks need review' } });
    expect(parse([' Claude wants to exit plan mode', '', ' ❯ Approve', '   Keep planning', '', ' shift+tab to approve with this feedback']))
      .toMatchObject({ interaction: { kind: 'plan' } });
  });

  it('lifts the Codex update screen, which is what a stale CLI prints at startup', () => {
    expect(parse([
      ' Update available · 0.160.0 → 0.161.0',
      '',
      ' Release notes: https://github.com/openai/codex/releases/latest',
      '',
      ' › 1. Update now (runs `npm install -g @openai/codex`)',
      '   2. Skip',
      '   3. Skip until next version',
      '',
      ' enter confirm · esc skip',
    ])).toMatchObject({ interaction: { title: 'Update available · 0.160.0 → 0.161.0' } });
  });

  /**
   * Claude Code 2.1.x asks for plan approval with its own key hint — `shift+tab to approve with this
   * feedback` — and titles the surface `Claude wants to exit plan mode` rather than with a question
   * mark. Reading that as a `plan` is what gives the reader an approval instead of a bare list.
   */
  const planDialog = [
    ' Claude wants to exit plan mode',
    '',
    ' ## Relay web redesign',
    ' 1. Split the stylesheet into tokens and layout.',
    ' 2. Rebuild the three pages on the new skeleton.',
    '',
    ' ❯ Yes, auto-accept edits',
    '   Yes, manually approve edits',
    '   No, keep planning',
    '   Tell Claude what to change',
    '',
    ' shift+tab to approve with this feedback',
  ];

  it('lifts the plan consent as a plan, keeping the CLI’s own rows', () => {
    const parsed = parse(planDialog);
    expect(parsed?.interaction).toMatchObject({ kind: 'plan', title: 'Claude wants to exit plan mode' });
    expect(parsed?.interaction.options.map(option => option.label)).toEqual([
      'Yes, auto-accept edits',
      'Yes, manually approve edits',
      'No, keep planning',
      'Tell Claude what to change',
    ]);
    expect(parsed?.interaction.message).toContain('## Relay web redesign');
  });

  it('reads the newer plan title too, and still refuses a screen ending on a bare cancel hint', () => {
    expect(parse([...planDialog.slice(0, 1), ' Ready to code?', ...planDialog.slice(2)]))
      .toMatchObject({ interaction: { kind: 'plan', title: 'Ready to code?' } });
    // `Esc to cancel` alone is not an action hint: many screens end with it, including transcripts.
    expect(parse([...planDialog.slice(0, -1), ' Esc to cancel'])).toBeUndefined();
  });
});

describe('TRAE command permission and numbered hint-closed dialogs', () => {
  const title = 'Would you like to run the following command?';
  const body = [
    '  Thread: parser-maintenance',
    '  Reason: Inspect the current working tree before making changes.',
    '  $ git -C /workspace/sample status --short',
  ];
  const labels = [
    '1. Yes, proceed (y)',
    '2. Yes, switch this session to auto mode (r)',
    '3. Yes, switch this session to full access mode (f)',
    '4. No, and tell TRAE CLI what to do differently (esc)',
  ];
  const footer = '  enter confirm | esc cancel | o open thread';
  const options = (focused: number, rows = labels) => rows.map((label, index) => `${index === focused ? '❯' : ' '} ${label}`);
  const dialog = (focused: number, detail = body, rows = labels) => [
    `  ${title}`, ...detail, '', ...options(focused, rows), footer,
  ];
  const wrappedDialog = (focused: number) => [
    `  ${title}`, ...body, '',
    `${focused === 0 ? '❯' : ' '} 1. Yes,`,
    'proceed (y)',
    `${focused === 1 ? '❯' : ' '} 2. Yes, switch this session to`,
    'auto mode (r)',
    `${focused === 2 ? '❯' : ' '} 3. Yes, switch this session to full access mode (f)`,
    `${focused === 3 ? '❯' : ' '} 4. No, and tell TRAE CLI what to do`,
    'differently (esc)',
    footer,
  ];

  it.each([0, 1, 2, 3])('lifts all four command permissions with focus on option %i', (focused) => {
    const parsed = parse(dialog(focused));
    expect(parsed?.interaction).toMatchObject({ kind: 'permission', title, message: body.map(line => line.trim()).join('\n') });
    expect(parsed?.interaction.options.map(option => option.label)).toEqual(labels);
    expect(parsed?.interaction.options.map(option => option.selected)).toEqual(labels.map((_, index) => index === focused));
    expect(parsed?.interaction.actions.map(action => action.id)).toEqual([
      'option:option-0', 'option:option-1', 'option:option-2', 'option:option-3',
    ]);
    expect(parsed?.focus).toBe(focused);
  });

  it.each([0, 1, 2, 3])('keeps numbered first, preceding and final wraps with focus on option %i', (focused) => {
    const baseline = parse(wrappedDialog(0))!;
    const parsed = parse(wrappedDialog(focused))!;
    expect(parsed).toBeDefined();
    expect(parsed.interaction.options.map(option => option.label)).toEqual(labels);
    expect(parsed.interaction.message).toBe(body.map(line => line.trim()).join('\n'));
    expect(parsed.focus).toBe(focused);
    expect(parsed.interaction.id).toBe(baseline.interaction.id);
    expect(parsed.interaction.revision).toBe(baseline.interaction.revision);
  });

  it.each(['→', '▶', '❯', '›'])('ignores ANSI styling and %s focus movement when identifying the command', (glyph) => {
    const baseline = parse(dialog(0))!;
    for (let focused = 0; focused < labels.length; focused++) {
      const esc = String.fromCharCode(27);
      const parsed = parse(dialog(focused).map(line => `${esc}[32m${line.replace('❯', glyph)}${esc}[0m`))!;
      expect(parsed).toBeDefined();
      expect(parsed.focus).toBe(focused);
      expect(parsed.interaction.id).toBe(baseline.interaction.id);
      expect(parsed.interaction.revision).toBe(baseline.interaction.revision);
    }
  });

  it('retains every line of a long visible command without a title lookback limit', () => {
    const detail = [...body.slice(0, 2), ...Array.from({ length: 60 }, (_, index) => `  command argument-${index}`)];
    const parsed = parse(dialog(2, detail));
    expect(parsed?.interaction).toMatchObject({ kind: 'permission', title, message: detail.map(line => line.trim()).join('\n') });
    expect(parsed?.interaction.options.map(option => option.label)).toEqual(labels);
  });

  it('retains a long visible plan and does not confuse numbered plan prose with options', () => {
    const detail = Array.from({ length: 60 }, (_, index) => `  ${index + 1}. Implement step ${index + 1}.`);
    const parsed = parse(['  Ready to code?', ...detail, '', '❯ Approve', '  Keep planning', '  shift+tab to approve with this feedback']);
    expect(parsed?.interaction).toMatchObject({ kind: 'plan', title: 'Ready to code?', message: detail.map(line => line.trim()).join('\n') });
    expect(parsed?.interaction.options.map(option => option.label)).toEqual(['Approve', 'Keep planning']);
  });

  it.each([0, 1, 2])('changes identity and revision when command context line %i changes', (index) => {
    const baseline = parse(dialog(0))!;
    const changed = parse(dialog(0, body.map((line, at) => at === index ? `${line} changed` : line)))!;
    expect(changed).toBeDefined();
    expect(changed.interaction.id).not.toBe(baseline.interaction.id);
    expect(changed.interaction.revision).not.toBe(baseline.interaction.revision);
  });

  it('changes identity and revision when an option changes', () => {
    const baseline = parse(dialog(0))!;
    const changed = parse(dialog(0, body, labels.map((label, index) => index === 2 ? `${label} changed` : label)))!;
    expect(changed).toBeDefined();
    expect(changed.interaction.id).not.toBe(baseline.interaction.id);
    expect(changed.interaction.revision).not.toBe(baseline.interaction.revision);
  });

  it.each([
    ['a title that is no longer visible', dialog(0).slice(1)],
    ['a prefixed title', dialog(0).map((line, index) => index === 0 ? `  Previous: ${title}` : line)],
    ['a suffixed title', dialog(0).map((line, index) => index === 0 ? `  ${title} Previously shown` : line)],
    ['an unknown question', dialog(0).map((line, index) => index === 0 ? '  Should this other operation proceed?' : line)],
    ['no focus', dialog(-1)],
    ['two current focuses', dialog(0).map(line => line.startsWith('  2.') ? line.replace('  2.', '❯ 2.') : line)],
    ['a historical focus, even above a separator', ['❯ Old choice', rule, ...dialog(0)]],
    ['body text after the footer', [...dialog(0), '  More output']],
    ['only one option', dialog(0, body, labels.slice(0, 1))],
    ['a missing final option', dialog(0, body, labels.slice(0, 3))],
    ['a missing first option', dialog(0, body, labels.slice(1))],
    ['a missing middle option', dialog(0, body, [labels[0]!, labels[2]!, labels[3]!])],
    ['duplicated option numbering', dialog(0, body, [labels[0]!, labels[1]!, labels[1]!, labels[3]!])],
    ['mixed numbered and unnumbered rows', dialog(0, body, [labels[0]!, 'Yes, auto mode', labels[2]!, labels[3]!])],
    ['a wrapped title', ['  Would you like to run the', 'following command?', ...dialog(0).slice(1)]],
    ['a wrapped footer', [...dialog(0).slice(0, -1), '  enter confirm |', 'esc cancel | o open thread']],
  ])('leaves an incomplete or ambiguous command surface in the terminal: %s', (_name, lines) => {
    expect(parse(lines)).toBeUndefined();
  });

  it.each([
    ['a completed select hint', footer],
    ['an arrow navigation hint', '  ↑/↓ to select · Enter to confirm'],
    ['a cancel-only hint', '  Esc to cancel'],
    ['a horizontal separator', rule],
    ['a box edge', '  ╰────────────────────────────────────╯'],
    ['a new input prompt', '  > Inspect another task'],
    ['a new user turn', '  User: Inspect another task'],
    ['an unknown question', '  Should this unrelated operation proceed?'],
  ])('does not borrow an old title across %s, even with a long intervening body', (_name, boundary) => {
    for (const length of [0, 60]) {
      expect(parse([
        `  ${title}`, ...body, boundary,
        ...Array.from({ length }, (_, index) => `  unrelated detail ${index}`),
        '', ...options(0), footer,
      ])).toBeUndefined();
    }
  });

  it('does not borrow a historical startup title for an unknown question', () => {
    expect(parse([
      '  Hooks need review', '  1 hook is new or changed.', '',
      '  Is this unrelated operation allowed?', '', ...options(0), footer,
    ])).toBeUndefined();
  });
});

/**
 * `NativeInteractions` answers a card by moving the CLI's own focus and then pressing a key. Every
 * step of that is checked against the interaction's identity and revision, so both have to describe
 * the *question* — not the cursor sitting on one of its rows, and not the rest of the pane.
 */
describe('dialog identity across the CLI moving its own cursor', () => {
  const dialog = (glyph: string, focused: number, above: string[] = []) => [
    ...above,
    ' Accessing workspace:',
    '',
    ' /repo',
    '',
    ...['No, exit', 'Yes, I trust this folder'].map((label, index) => `${index === focused ? ` ${glyph}` : '  '} ${label}`),
    '',
    ' Enter to confirm · Esc to cancel',
  ];

  it.each([['→'], ['▶'], ['❯'], ['›']])('keeps one identity and revision with the %s glyph', (glyph) => {
    const first = parse(dialog(glyph, 0))!;
    const second = parse(dialog(glyph, 1))!;

    expect(first.focus).toBe(0);
    expect(second.focus).toBe(1);
    expect(second.interaction.id).toBe(first.interaction.id);
    expect(second.interaction.revision).toBe(first.interaction.revision);
  });

  it('ignores what the screen prints outside the dialog', () => {
    const quiet = parse(dialog('›', 0))!;
    // A status line above the dialog repaints constantly on Codex; it is not a change to the question.
    const busy = parse(dialog('›', 0, [' Working · 0.161.0', ' npm install -g @openai/codex', '']))!;

    expect(busy.interaction.id).toBe(quiet.interaction.id);
    expect(busy.interaction.revision).toBe(quiet.interaction.revision);
  });
});
