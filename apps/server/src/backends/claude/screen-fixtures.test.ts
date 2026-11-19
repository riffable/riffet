import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  claudeAgentRows, claudeBackgroundScreen, claudeComposerHoldsPrompt, claudeComposerText, claudeComposerVisible, claudeFooterFocused,
  claudeTasksEntryShown, claudeViewsSubagent,
} from '../../adapters/cli/claude-code.js';
import { parseDialog } from '../../agent-host/interaction-screen.js';
import { localRedactions } from '../../../../../scripts/terminal-fixture-guards.js';
import { screenMarkdown } from './live/markdown.js';
import { readScreenTurn } from './live/screen.js';
import { claudeScreenInteraction, parseClaudeScreenQuestion } from './screen-dialog.js';

/**
 * Real Claude Code screens, one directory per version (`scripts/probe-claude-e2e.ts --capture`). Every reader the
 * backend acts on is checked against every version captured, and a capture this table does not know fails, so a
 * new screen is never silently skipped.
 */
const root = fileURLToPath(new URL('./fixtures/screens/', import.meta.url));
const versions = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
const terminal = { id: 'term-1', epoch: 1 };

/** `live-*`: the pane's tail, scrollback included, while an answer streams (`live/screen.ts`); captured at 100 columns. */
const live = (screen: string) => {
  const turn = readScreenTurn(screen);
  expect(turn).toBeDefined();
  const last = turn!.blocks.at(-1);
  return { ...turn!, kinds: turn!.blocks.map(block => block.kind), draft: last?.kind === 'text' ? screenMarkdown(last.lines, 98) : undefined };
};

/** A screen with the input box up and nothing else asking for the keyboard. */
const atComposer = (screen: string) => {
  expect(claudeComposerVisible(screen)).toBe(true);
  expect(claudeBackgroundScreen(screen)).toBeUndefined();
  expect(claudeScreenInteraction(screen, terminal)).toBeUndefined();
  expect(parseDialog(screen, terminal)).toBeUndefined();
};

const expectations: Record<string, (screen: string) => void> = {
  'composer-idle': screen => {
    atComposer(screen);
    expect(claudeComposerText(screen)).toBe('');
    expect(claudeComposerHoldsPrompt(screen, 'anything typed')).toBe(false);
    expect(claudeFooterFocused(screen)).toBe(false);
    expect(claudeViewsSubagent(screen)).toBe(false);
  },
  'composer-paste': screen => {
    atComposer(screen);
    expect(claudeComposerHoldsPrompt(screen, 'line one\nline two')).toBe(true);
  },
  'agent-list': screen => {
    atComposer(screen);
    const [main, ...agents] = claudeAgentRows(screen);
    expect(main).toMatchObject({ name: 'main', focused: true });
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.every(row => !row.focused)).toBe(true);
    expect(claudeViewsSubagent(screen)).toBe(false);
    expect(claudeFooterFocused(screen)).toBe(false);
  },
  // The input box with background shells running: the footer's entry into the "Background" list.
  'composer-tasks': screen => {
    atComposer(screen);
    expect(claudeTasksEntryShown(screen)).toBe(true);
    expect(claudeFooterFocused(screen)).toBe(false);
  },
  // `/autocompact` opened while a shell runs: the panel is stacked over a box that stays drawn but has lost the keyboard.
  'composer-panel': screen => {
    expect(claudeComposerVisible(screen)).toBe(true);
    expect(parseDialog(screen, terminal)).toBeUndefined();
    const card = claudeScreenInteraction(screen, terminal);
    expect(card).toMatchObject({ kind: 'confirmation', transport: 'terminal' });
    expect(card?.actions.map(action => action.label)).toEqual(['应用', '取消']);
    expect(card?.message).toMatch(/^Auto-compact window\n/);
    expect(card?.message).toMatch(/Select auto-compact window: auto$/);
  },
  'agent-view': screen => {
    atComposer(screen);
    expect(claudeViewsSubagent(screen)).toBe(true);
    expect(claudeAgentRows(screen).find(row => row.name === 'main')?.focused).toBe(false);
  },
  'permission-dialog': screen => {
    expect(claudeComposerVisible(screen)).toBe(false);
    // The dialog the CLI draws beside a held hook; seen again after the hook answers, it is the CLI asking again.
    expect(parseDialog(screen, terminal)?.interaction).toMatchObject({ kind: 'permission', title: 'Do you want to proceed?' });
    expect(parseDialog(screen, terminal)?.rows.every(row => !/\n/.test(row.label))).toBe(true);
    // Plain Yes and No are the quick answers; the rows that grant more are not. The dashed rules framing the command are not content.
    const interaction = parseDialog(screen, terminal)!.interaction;
    expect(interaction.actions.map(action => action.tone)).toEqual(['primary', undefined, undefined, 'danger']);
    expect(interaction.message).not.toContain('╌');
    expect(interaction.message).toContain('touch approved.txt');
  },
  question: screen => {
    expect(claudeComposerVisible(screen)).toBe(false);
    expect(parseClaudeScreenQuestion(screen)?.options.length).toBeGreaterThanOrEqual(2);
    expect(claudeScreenInteraction(screen, terminal)).toMatchObject({ kind: 'question', transport: 'terminal' });
  },
  'background-list': screen => {
    expect(claudeComposerText(screen)).toBeUndefined();
    expect(claudeBackgroundScreen(screen)).toMatchObject({ kind: 'list', active: expect.any(Number), closable: true });
    expect(claudeAgentRows(screen)).toEqual([]);
  },
  'background-task': screen => {
    expect(claudeComposerText(screen)).toBeUndefined();
    expect(claudeBackgroundScreen(screen)).toEqual({ kind: 'task', closable: true });
  },
  // A tool running under the spinner: nothing to draft.
  'live-tool-running': screen => {
    const turn = live(screen);
    expect(turn.prompt).toMatch(/^First run the shell command ls -la with the Bash tool\. .* some inline code\.$/);
    expect(turn.kinds).toEqual(['tool', 'other']);
    expect(turn.draft).toBeUndefined();
  },
  // Prose, a heading and a list item cut mid-stream, under a folded tool group.
  'live-text': screen => {
    const turn = live(screen);
    expect(turn.kinds).toEqual(['other', 'text']);
    expect(turn.draft).toMatch(/^The directory contains only a \.git folder — an empty repo\.\n\nWhat a Resilient Job Queue Needs\n\nA job queue is easy to write and hard to make trustworthy\. The naive version — push a job ID into Redis, pop it/);
    expect(turn.draft).toMatch(/\n\n- At-least-once delivery with idempotent handlers\. The queue should re-deliver on failure, and every handler must/);
    expect(turn.draft).toMatch(/actually enforce\.$/);
  },
  // A repaint left a copy of the conversation above; the second text block streams after a tool. Code keeps its lines.
  'live-after-tool': screen => {
    const turn = live(screen);
    expect(turn.kinds).toEqual(['other', 'text', 'tool', 'text']);
    expect(screenMarkdown(turn.blocks[1]!.lines, 98)).toContain('\n\n```\ntype Job<T> = { id: string; payload: T; attempts: number };\n\nasync function process<T>(job: Job<T>, run: (p: T) => Promise<void>) {\n  if (job.attempts >= 5)');
    expect(turn.draft).toMatch(/^Now the closing paragraph:\n\nReliability is ultimately a property of the whole pipeline, not just the queue software\. The broker/);
  },
  // Wide characters wrap between characters, and at a space before a Latin word.
  'live-cjk': screen => {
    const turn = live(screen);
    expect(turn.kinds).toEqual(['text']);
    expect(turn.draft).toContain('所以设计的起点不是"怎么派发"');
    expect(turn.draft).toContain('列表、由 worker 弹出执行');
    expect(turn.draft).toMatch(/\n1\. 至少一次投递，消费端按业务键去重，保证重复执行不产生重复副作用。\n2\. /);
    expect(turn.draft).toMatch(/\n4\. 超过上限的任务进入死信队列，保留原始载荷和最后一次错误，供人工排查。$/);
  },
  // A finished answer: the repaint's copy of two code lines is dropped, the table kept as drawn.
  'live-seam': screen => {
    const turn = live(screen);
    expect(turn.kinds).toEqual(['text', 'other']);
    const text = screenMarkdown(turn.blocks[0]!.lines, 98);
    expect(text.match(/\} catch \(err\) \{/g)).toHaveLength(1);
    expect(text).toContain('```\n┌──────────────────┬');
    expect(turn.draft).toBeUndefined();
  },
  // A monitor's page whose output box pushed the hints below a short pane.
  'background-task-cut': screen => {
    expect(claudeComposerText(screen)).toBeUndefined();
    expect(claudeBackgroundScreen(screen)).toEqual({ kind: 'task', closable: true });
  },
};

describe.each(versions)('Claude Code %s screens', version => {
  const files = readdirSync(`${root}${version}`).filter(name => name.endsWith('.txt')).sort();

  it.each(files)('%s', file => {
    const name = file.slice(0, -'.txt'.length);
    const screen = readFileSync(`${root}${version}/${file}`, 'utf8');
    expect(expectations[name], `no expectation for ${version}/${file}`).toBeDefined();
    // Committed with the source: no machine path or model route, nor a name from the local redactions file.
    expect(screen).not.toMatch(/\/Users\/|\/home\/|\/var\/folders\/|deepseek/i);
    for (const [from] of localRedactions) expect(screen.toLowerCase()).not.toContain(from.toLowerCase());
    expectations[name]!(screen);
  });
});

// What the TUI draws of an answer it could not fully parse: a line the answer broke, a soft wrap at a space before a
// Latin word, and a bold pair touching CJK punctuation left as asterisks. It reads as prose, not as a code block.
it('keeps a CJK answer\'s own line breaks and its unparsed bold as prose', () => {
  const text = screenMarkdown([
    '我的立场:**最重要的是 A。**但我先质疑一下“重要”的框架。',
    '',
    '读法二:技术史层面。',
    'Transformer 的论文标题是 Attention Is All You',
    'Need。过去近十年的大模型几乎都建立在注意力机制上,所以"A"是现代 AI 的技术核心。其他候选各有短板:',
    '- X:XLA、XGBoost 之类,不是范式级。',
    '- W:权重 weights 很重要,但每个参数化模型都有,区分度低。',
  ], 98);
  expect(text).not.toContain('```');
  expect(text).toContain('我的立场:**最重要的是 A。**但');
  expect(text).toContain('读法二:技术史层面。\\\nTransformer 的论文标题是 Attention Is All You Need。过去近十年');
  expect(text).toMatch(/短板:\n- X:XLA、XGBoost 之类,不是范式级。\n- W:/);
});
