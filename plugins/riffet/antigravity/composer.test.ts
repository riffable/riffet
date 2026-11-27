import { expect, it } from 'vitest';
import { composerHolds, composerText, emptyComposer } from './composer.js';

const rule = '─'.repeat(176);
// agy 1.5.18 with a background command running: the task list sits in its own bordered block under the composer.
const withTasks = (prompt: string) =>
  [
    '● ! sleep 120 && echo done (run in background)',
    rule,
    prompt,
    rule,
    '  ● [23:22:10] ! sleep 120 && echo done running',
    rule,
    '                                    auto · Gemini 3.8 Flash · high · 1 task(s) · /tasks',
  ].join('\n');

it('reads the composer above the background task list', () => {
  expect(composerHolds(composerText(withTasks('> hello there')), 'hello there')).toBe(true);
  expect(composerText(withTasks('>'))).toBe('');
  expect(emptyComposer(withTasks('>'))).toBe(true);
  expect(emptyComposer(withTasks('> hello there'))).toBe(false);
});

it('does not take an earlier prompt in the transcript for the composer when a dialog sits at the bottom', () => {
  const screen = [rule, '> hello there', '▸ Thought for 2s', rule, 'Allow this command?', '> Yes', '  No', rule].join('\n');
  expect(composerHolds(composerText(screen), 'hello there')).toBe(false);
});
