import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  claudeAgentRows, claudeBackgroundScreen, claudeComposerHoldsPrompt, claudeComposerText, claudeComposerVisible, claudeFooterFocused,
  claudeTasksEntryShown, claudeViewsSubagent,
} from '../../adapters/cli/claude-code.js';
import { parseDialog } from '../../agent-host/interaction-screen.js';
import { localRedactions } from '../../../../../scripts/terminal-fixture-guards.js';
import { claudeScreenInteraction, parseClaudeScreenQuestion } from './screen-dialog.js';

/**
 * Real Claude Code screens, one directory per version (`scripts/probe-claude-e2e.ts --capture`). Every reader the
 * backend acts on is checked against every version captured, and a capture this table does not know fails, so a
 * new screen is never silently skipped.
 */
const root = fileURLToPath(new URL('./fixtures/screens/', import.meta.url));
const versions = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
const terminal = { id: 'term-1', epoch: 1 };

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
