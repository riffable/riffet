import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_BUSY_PATTERN, CLAUDE_CODE_READY_PATTERN, claudeComposer, claudeComposerHoldsPrompt, claudeFooterFocused, claudeScreenBusy, claudeViewsSubagent } from './claude-code.js';

const rule = '─'.repeat(100);

/** The last lines of a real `tmux capture-pane`. */
function pane(composer: string, footer: string): string {
  return ['', '● The History of the Terminal Emulator', '', rule, composer, rule, `  ⏸ manual mode on · ${footer} · ← for agents`].join('\n');
}

const idle = (screen: string) => !CLAUDE_CODE_BUSY_PATTERN.test(screen) && CLAUDE_CODE_READY_PATTERN.test(screen);

describe('claude code screen markers', () => {
  it('reads a freshly launched composer as ready despite its suggestion text', () => {
    // Claude fills an empty composer with a hint, so the prompt is never alone on its line.
    expect(idle(pane('❯ Try "write a test for Timeline.tsx"', '? for shortcuts'))).toBe(true);
  });

  it('reads a used composer as ready', () => {
    expect(idle(pane('❯ ', '? for shortcuts'))).toBe(true);
  });

  it('reads a composer as busy while a turn runs', () => {
    // The box stays drawn during a turn; older CLIs show an interrupt hint in the footer.
    expect(idle(pane('❯ ', 'esc to interrupt'))).toBe(false);
    expect(claudeScreenBusy(pane('❯ ', 'esc to interrupt'))).toBe(true);
    // Since 2.1.302 the footer no longer prints `esc to interrupt`; busy turns draw a spinner above the box.
    const withSpinner = (above: string[]) => [...above, '', rule, '❯ ', rule, '  ⏵⏵ auto mode on'].join('\n');
    expect(claudeScreenBusy(withSpinner(['✽ Noodling… (6m 22s · ↓ 21.2k tokens)', '  ⎿ \u00a0Tip: Use /btw']))).toBe(true);
    expect(claudeScreenBusy(withSpinner(['✶ Recombobulating…']))).toBe(true);
    expect(claudeScreenBusy(withSpinner(['⏺ Streaming answer line']))).toBe(true);
    expect(claudeScreenBusy(withSpinner(['⏺ Done.', '', '✻ Worked for 17s · done 11:25 PM']))).toBe(false);
    expect(claudeScreenBusy(withSpinner(['⏺ Bash(sleep 120)', '  ⎿ \u00a0Interrupted · What should Claude do instead?']))).toBe(false);
  });

  it('does not mistake a quoted prompt character in transcript text for the composer', () => {
    const screen = ['● It printed:', '', '> some quoted output', '', '  and then stopped.'].join('\n');
    expect(CLAUDE_CODE_READY_PATTERN.test(screen)).toBe(false);
  });
});

// `send` presses Enter once, 80 ms after the paste, and that press is the whole submission. When the
// TUI swallows it the pane is the only witness that the message never went out, so the check has to
// read the box itself — a prompt Claude has taken is echoed above the box with the same `❯` prefix.
describe('reading whether the composer still holds a pasted prompt', () => {
  const prompt = '还有，cursor 的 plan 模式无法被识别为web 卡，第二张图也是另一个 case';

  it('reads the lines between the composer’s own rules, not the transcript above them', () => {
    const screen = ['● Ready to help.', '', `❯ ${prompt}`, '', '⏺ working on it', '', rule, '❯ ', rule, '  ⏵⏵ auto mode on'];
    expect(claudeComposer(screen.join('\n'))).toBe('❯ ');
    expect(claudeComposerHoldsPrompt(screen.join('\n'), prompt)).toBe(false);
  });

  it('sees a paste the CLI never submitted', () => {
    expect(claudeComposerHoldsPrompt(pane(`❯ ${prompt}`, '⏵⏵ auto mode on'), prompt)).toBe(true);
  });

  it('sees a multi-line paste, which the CLI collapses into its own placeholder', () => {
    // Verified against Claude Code 2.1.252: a three-line paste renders as this placeholder and the
    // text itself never reaches the composer, so the text comparison above cannot catch it.
    const pasted = `${prompt}\n\n/var/folders/probe/image.png`;
    expect(claudeComposerHoldsPrompt(pane('❯ [Pasted text #1 +3 lines]', '⏵⏵ auto mode on · paste again to expand'), pasted)).toBe(true);
  });

  it('sees a long single-line paste, whose placeholder carries no line count', () => {
    expect(claudeComposerHoldsPrompt(pane('❯ [Pasted text #2]', '⏵⏵ auto mode on · paste again to expand'), 'w'.repeat(900))).toBe(true);
  });

  it('ignores where the TUI wrapped the paste and what the paste ended with', () => {
    // The pane is narrower than the message, so Claude re-wraps it and shows only its first line.
    const rendered = ['❯ 还有，cursor 的 plan 模式无法被', '  识别为web 卡，第二张图也是另一个 case', '', '  /var/folders/probe/image.png'];
    const pasted = `${prompt}\n\n/var/folders/probe/image.png`;
    expect(claudeComposerHoldsPrompt(pane(rendered.join('\n'), '⏵⏵ auto mode on'), pasted)).toBe(true);
  });

  it('reads a prompt whose attached image paths the CLI turned into [Image #N]', () => {
    const pasted = `${prompt}\n\n/var/folders/probe/a.png\n/var/folders/probe/b.png`;
    expect(claudeComposerHoldsPrompt(pane(`❯ ${prompt}\n\n  [Image #1]\n  [Image #2]`, '⏵⏵ auto mode on'), pasted)).toBe(true);
    expect(claudeComposerHoldsPrompt(pane('❯ [Image #1]', '⏵⏵ auto mode on'), pasted)).toBe(false);
  });

  it('does not claim a prompt that is simply not there', () => {
    expect(claudeComposerHoldsPrompt(pane('❯ ', '⏵⏵ auto mode on'), prompt)).toBe(false);
    expect(claudeComposerHoldsPrompt(pane('❯ Try "write a test"', '? for shortcuts'), prompt)).toBe(false);
  });
});

// The composer is located by its pair of rules; where a turn stands is read from the transcript and
// hooks, never from the pane. Frames below are real captures.
describe('locating the composer', () => {
  it('locates the Fast composer while a turn runs, including a narrow multiline input', () => {
    for (const width of [157, 12]) {
      const box = width < 30 ? '❯ first part\n  more input' : '❯ [Pasted text #1 +3 lines]\n  continued input';
      const screen = [
        '  ● Earlier answer', '', '· Gitifying… (3m 1s · ↓ 8.0k tokens)',
        '  ⎿  Tip: Ask a quick side question', '',
        `${'─'.repeat(width - 4)} ↯ ─`, box, '─'.repeat(width),
        '  Opus 5.5 · ctx 53%', '  ⏵⏵ auto mode on',
      ].join('\n');
      expect(claudeComposer(screen)).toBe(box);
      expect(claudeComposerHoldsPrompt(screen, width < 30 ? 'first part\nmore input' : 'a pasted multiline request')).toBe(true);
    }
  });

  it('locates a composer whose top rule carries the session name (2.1.252+)', () => {
    for (const title of ['fix-transcript-runtime-state', '修复会话状态']) {
      const top = `${'─'.repeat(4)} ${title} ─`;
      const width = [...top].reduce((sum, char) => sum + (/[\u4e00-\u9fff]/.test(char) ? 2 : 1), 0);
      const screen = ['  ● earlier answer', '', top, '❯ ', '─'.repeat(width), '  Opus 5.5 · ctx 12%'].join('\n');
      expect(claudeComposer(screen)).toBe('❯ ');
    }
    // Prose that merely contains a dashed heading is not a composer.
    expect(claudeComposer(['──── Results ─', '> quoted', '', 'text'].join('\n'))).toBeUndefined();
  });

  it('does not find a missing or incomplete composer', () => {
    for (const screen of ['', '❯ ', `${rule}\n❯ `, `❯ \n${rule}`, `${rule}\nquoted output\n${rule}`]) {
      expect(claudeComposer(screen)).toBeUndefined();
    }
  });
});

describe('reading which agent the composer talks to', () => {
  /** Captured from Claude Code 2.1.302 with two background agents running. */
  const agents = (composer: string, hint: string, rows: string[]) => [
    '⏺ Both agents are still running their sleep.', `${'─'.repeat(80)} Sleep 600 seconds ─`, composer, rule, `  ${hint}`, ...rows,
  ].join('\n');
  const row = (name: string) => `${name}  Sleep 600 seconds                       12s · ↓ 243 tokens`;

  it('sees the view of a background agent the reader opened', () => {
    const screen = agents('❯ Message @general-purpose…', '⏵⏵ auto mode on · 2 shells · ↓ to manage', ['  ◯ main', `  ⏺ ${row('general-purpose')}`, `  └ ◯ ${row('general-purpose')}`]);
    expect(claudeViewsSubagent(screen)).toBe(true);
    expect(claudeFooterFocused(screen)).toBe(false);
  });

  it('sees it from the list alone once the box holds a draft', () => {
    expect(claudeViewsSubagent(agents('❯ z', '⏵⏵ auto mode on · 2 shells', ['  ◯ main', `  └ ⏺ ${row('general-purpose')}`]))).toBe(true);
  });

  it('reads the main agent with the keyboard still on the list', () => {
    const screen = [rule, '❯ ', rule, '  ↑/↓ to select', '❯ ⏺ main', `  ◯ ${row('general-purpose')}`].join('\n');
    expect(claudeViewsSubagent(screen)).toBe(false);
    expect(claudeFooterFocused(screen)).toBe(true);
  });

  it('does not take the footer’s effort badge for an agent', () => {
    const screen = [rule, '❯ ', rule, '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents', '                                      ● high · /effort'].join('\n');
    expect(claudeViewsSubagent(screen)).toBe(false);
    expect(claudeFooterFocused(screen)).toBe(false);
  });
});
