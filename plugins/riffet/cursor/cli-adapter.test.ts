import { describe, expect, it } from 'vitest';
import { cursorAgentAdapter, cursorAgentProjectSlug, cursorAgentTranscriptPath, cursorComposerHoldsPrompt, cursorPromptBar, cursorPromptBarEmpty, CURSOR_AGENT_BUSY_PATTERN, CURSOR_AGENT_READY_PATTERN } from './cli-adapter.js';

describe('cursor-agent adapter', () => {
  it('slugs the project directory the way the CLI does', () => {
    expect(cursorAgentProjectSlug('/srv/home/alice/project')).toBe('srv-home-alice-project');
    expect(cursorAgentProjectSlug('/')).toBe('');
    expect(cursorAgentProjectSlug('srv/home/alice/project')).toBe('srv-home-alice-project');
  });

  it('resolves the transcript JSONL path under ~/.cursor', () => {
    const path = cursorAgentTranscriptPath('/srv/home/alice/project', '29846c62-123d-4c49-bddc-7da93361b97a');
    expect(path.endsWith('/srv-home-alice-project/agent-transcripts/29846c62-123d-4c49-bddc-7da93361b97a/29846c62-123d-4c49-bddc-7da93361b97a.jsonl')).toBe(true);
  });

  it('builds a bare launch argv with the required trust flag', () => {
    // `allowlist` is the CLI's own default, so an unset approval adds no autorun flag.
    expect(cursorAgentAdapter.buildArgs({})).toEqual(['--trust']);
  });

  it('bakes in an initial prompt behind a `--` guard', () => {
    expect(cursorAgentAdapter.buildArgs({ initialPrompt: 'hello world' })).toEqual(['--trust', '--', 'hello world']);
  });

  it('encodes mode, approval and model in the CLI launch order', () => {
    expect(cursorAgentAdapter.buildArgs({ mode: 'plan', approval: 'unrestricted', model: 'claude-opus-5-5' }))
      .toEqual(['--trust', '--mode', 'plan', '--force', '--model', 'claude-opus-5-5']);
    expect(cursorAgentAdapter.buildArgs({ mode: 'agent', approval: 'auto-review' })).toEqual(['--trust', '--auto-review']);
  });

  it('opens the resume picker only when no stored session id exists', () => {
    // TerminalService emits `--resume <id>` itself, so the adapter must not add a second one.
    expect(cursorAgentAdapter.buildArgs({ resumePicker: true, model: 'claude-opus-5-5' })).toEqual(['--resume', '--trust']);
    expect(cursorAgentAdapter.buildArgs({ resumePicker: true, hasStoredSession: true })).toEqual(['--trust']);
  });

  it('recognises the ready footer in a terminal frame', () => {
    const footer = '  → Add a follow-up                      ctrl+c to stop';
    expect(CURSOR_AGENT_READY_PATTERN.test(footer)).toBe(true);
  });

  it('recognises a busy frame by the ctrl+c hint', () => {
    expect(CURSOR_AGENT_BUSY_PATTERN.test('  Working... ctrl+c to stop')).toBe(true);
    expect(CURSOR_AGENT_BUSY_PATTERN.test('  → Add a follow-up')).toBe(false);
  });
});

// A written prompt is submitted by an Enter pressed into a tmux pane, and a press the CLI drops
// leaves the message sitting in the prompt bar while the run waits for a transcript echo that never
// comes. The bar is the only thing that can tell "taken" from "still there", so it is read the way
// `native/screen.ts` reads it: the last `→` line above the model/permission footer.
describe('reading whether the cursor prompt bar still holds a written prompt', () => {
  const prompt = '还有，cursor 的 plan 模式无法被识别为web 卡';
  const footer = [
    '  Claude Opus 5.5 1M High Fast · MAX                                                                                           Run Everything',
    '  /private/tmp/cursor-paste-probe',
  ];
  /** A real frame from cursor-agent 2026.09.28: the bar above the footer, the transcript above it. */
  const pane = (bar: string) => ['  Cursor Agent', '  v2026.09.28-64d2043', '  ● previous answer', '', bar, ...footer].join('\n');

  it('reads the bar itself, not the transcript line above it', () => {
    expect(cursorPromptBar(pane('  → Add a follow-up'))).toBe('  → Add a follow-up');
    expect(cursorPromptBarEmpty(pane('  → Add a follow-up'))).toBe(true);
    expect(cursorPromptBarEmpty(pane('  → Add a follow-up — /plan to review and build'))).toBe(true);
    expect(cursorPromptBarEmpty(pane('  → Add a follow-up\n    ctrl+r to review changed files'))).toBe(true);
    expect(cursorPromptBarEmpty(pane('  → Add a follow-up feature'))).toBe(false);
    expect(cursorComposerHoldsPrompt(pane('  → Add a follow-up'), prompt)).toBe(false);
  });

  it('sees a write the CLI never took', () => {
    const bar = [`  → ${prompt}`, '    /var/folders/probe/image.png'].join('\n');
    expect(cursorComposerHoldsPrompt(pane(bar), `${prompt}\n\n/var/folders/probe/image.png`)).toBe(true);
  });

  it('sees a short first line followed by an attachment path on the continuation row', () => {
    const bar = ['  → 进一步优化，比如这种细节：', '    /tmp/riffet-attachments/01506fe2/image.png'].join('\n');
    expect(cursorComposerHoldsPrompt(pane(bar), '进一步优化，比如这种细节：\n\n/tmp/riffet-attachments/01506fe2/image.png')).toBe(true);
    expect(cursorComposerHoldsPrompt(pane('  → 进一步优化 [Image #1]'), '进一步优化\n\n/tmp/riffet-attachments/01506fe2/image.png')).toBe(true);
  });

  it('reads a taken prompt as gone, placeholder or busy footer', () => {
    const running = pane('  → Add a follow-up                                                                  ctrl+c to stop');
    expect(cursorComposerHoldsPrompt(running, prompt)).toBe(false);
  });

  it('matches on the opening characters, so a bar that wrapped still counts', () => {
    // A narrow pane shows the first line of the draft and wraps the rest below it.
    expect(cursorComposerHoldsPrompt(pane(`  → ${prompt.slice(0, 20)}`), prompt)).toBe(true);
  });

  it('sees a draft taller than the bar, which the CLI scrolls to its end', () => {
    // cursor-agent 2026.10.01 at 182 columns: the bar keeps four rows of a long draft, the last ones.
    const draft = [
      '1 发起运行，修改为 发起，搜索修改为图标入口即可。',
      '2 图一的卡片太素了，表格头加个背景也好啊，太素了可读性就差。',
      '3 在性能优化中，问题是什么，解法是什么，好好呈现 trace 或者代码逻辑，他就是主题呢？比如你的解法，是不是可以把代码前后 diff，把方案展示出来呢',
      '',
      '/var/folders/probe/image.png',
    ].join('\n');
    const bar = ['  → 或者代码逻辑，他就是主题呢？比如你的解法，是不是可以把代码前后 diff，把方案展示出来呢', '    /var/folders/probe/image.png'].join('\n');
    expect(cursorComposerHoldsPrompt(pane(bar), draft)).toBe(true);
    expect(cursorComposerHoldsPrompt(pane('  → Add a follow-up'), draft)).toBe(false);
  });

  it('recognizes cursor-agent collapsed multi-line paste placeholders in the prompt bar', () => {
    const multiLine = '<riffet-member>\nrules\n</riffet-member>\n\n你是谁';
    expect(cursorComposerHoldsPrompt(pane('  → [Pasted text #1 +145 lines]'), multiLine)).toBe(true);
    expect(cursorComposerHoldsPrompt(pane('  → [Pasted text #1 +145 lines]'), '短单行')).toBe(false);
  });
});
