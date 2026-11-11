import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeInteraction, NativeInteractionResponse, Session } from '../../../../packages/contracts/src/index.js';
import type { TerminalInteractionControl, TerminalService } from '../terminal/service.js';
import { NativeInteractions } from './interactions.js';

const session: Session = {
  id: 'session-1', projectId: 'project-1', kind: 'native', title: 'Conversation', tags: [],
  state: 'running', backendId: 'cursor', mode: 'agent', terminalId: 'terminal-1',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

/** Cursor's bordered AskQuestion layout, including the actual CJK/English wrap boundary. */
function question(index: 1 | 2, state: { focus?: number; selected?: number; other?: string[] } = {}): string {
  const choices = index === 1
    ? ['Rename the module to feed (Recommended)', 'Keep the current names for now']
    : ['Proceed with the implementation (Recommended)', 'Only prepare the design'];
  const lines = [
    'Arch Lab next steps',
    `Question ${index} of 2`,
    `${index}. ${index === 1 ? 'Should the Feed-specific parts be renamed?' : 'What should happen next?'}`,
    ...choices.map((label, row) => `${(state.focus ?? 0) === row ? '› ' : '  '}[${state.selected === row ? 'x' : ' '}] ${label}`),
    `${state.focus === 2 ? '› ' : '  '}[${state.other ? 'x' : ' '}] Other: ${state.other?.[0] ?? '(type to answer)'}`,
    ...(state.other?.slice(1) ?? []),
    '↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip',
  ];
  const width = Math.max(...lines.map(line => line.length));
  return [
    `┌${'─'.repeat(width + 2)}┐`,
    ...lines.map(line => `│ ${line.padEnd(width)} │`),
    `└${'─'.repeat(width + 2)}┘`,
  ].join('\n');
}

/** TRAE command authorization, including command context and the CLI's numbered choices. */
function commandPermission(focus = 0, wrapFirst = false): string {
  const choices = [
    wrapFirst ? ['1. Yes, proceed', '(y)'] : ['1. Yes, proceed (y)'],
    ['2. Yes, switch this session to auto mode (r)'],
    ['3. Yes, switch this session to full access mode (f)'],
    ['4. No, and tell TRAE CLI what to do differently (esc)'],
  ];
  return [
    '  Would you like to run the following command?',
    '  Thread: Inspect workspace',
    '  Reason: Check the working tree before making changes.',
    '',
    '  cd /tmp/example-workspace &&',
    '  git status --short',
    '',
    ...choices.flatMap(([label, ...continuation], index) => [
      `${focus === index ? '❯ ' : '  '}${label}`,
      // Terminal wrapping can put continuation text at column zero.
      ...continuation,
    ]),
    '',
    '  enter confirm | esc cancel | o open thread',
  ].join('\n');
}

type Input = { keys: string[] } | { paste: string; submit: boolean };
type Step = Input & { screen: string };

/** Each input advances to one explicit fixture; this is not a second implementation of the CLI. */
function harness(initial: string, steps: Step[]) {
  let screen = initial;
  const calls: Input[] = [];
  const remaining = [...steps];
  const write = async (input: Input) => {
    calls.push(input);
    const step = remaining.shift();
    expect(step, 'unexpected terminal input').toBeDefined();
    const { screen: next, ...expected } = step!;
    expect(input).toEqual(expected);
    screen = next;
  };
  const control: TerminalInteractionControl = {
    screen: async () => screen,
    keys: async keys => write({ keys }),
    paste: async (paste, submit) => write({ paste, submit }),
  };
  const terminal = {
    get: async () => ({ id: 'terminal-1', epoch: 1, state: 'running' }),
    screen: control.screen,
    withInteraction: async <T>(_id: string, task: (control: TerminalInteractionControl) => Promise<T>) => task(control),
  } as unknown as TerminalService;
  const interactions = new NativeInteractions(terminal);
  return { interactions, calls, remaining, repaint: (next: string) => { screen = next; } };
}

function response(interaction: NativeInteraction, requestId: string, input: Partial<NativeInteractionResponse> = {}): NativeInteractionResponse {
  return { requestId, interactionId: interaction.id, revision: interaction.revision, action: 'answer', ...input };
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('NativeInteractions TRAE command permission execution', () => {
  const traeSession: Session = { ...session, backendId: 'traex' };
  const contentChanges = [
    { label: 'command', before: 'git status --short', after: 'git diff --stat' },
    { label: 'reason', before: 'Check the working tree before making changes.', after: 'Inspect changes before continuing.' },
    { label: 'option', before: 'Yes, proceed (y)', after: 'Yes, proceed once (y)' },
  ];

  it.each([
    { label: 'proceed once', target: 0, moves: [] },
    { label: 'auto mode', target: 1, moves: [{ keys: ['Down'], screen: commandPermission(1) }] },
    { label: 'full access mode', target: 2, moves: [
      { keys: ['Down'], screen: commandPermission(1) },
      { keys: ['Down'], screen: commandPermission(2) },
    ] },
    { label: 'decline', target: 3, moves: [
      { keys: ['Down'], screen: commandPermission(1) },
      { keys: ['Down'], screen: commandPermission(2) },
      { keys: ['Down'], screen: commandPermission(3) },
    ] },
  ])('selects $label using only verified movement and one Enter', async ({ target, moves }) => {
    const h = harness(commandPermission(), [...moves, { keys: ['Enter'], screen: 'Continuing…' }]);
    const current = (await h.interactions.current(traeSession))!;
    expect(current).toMatchObject({ kind: 'permission', title: 'Would you like to run the following command?' });
    expect(current.actions.map(action => action.id)).toEqual([
      'option:option-0', 'option:option-1', 'option:option-2', 'option:option-3',
    ]);
    const request = response(current, 'command-choice', { action: `option:option-${target}` });

    const completed = await settle(h.interactions.respond(traeSession, request));

    expect(completed.status).toBe('completed');
    expect(h.calls).toEqual([...moves.map(({ keys }) => ({ keys })), { keys: ['Enter'] }]);
    expect(h.remaining).toEqual([]);
    expect(await h.interactions.respond(traeSession, request)).toEqual(completed);
    expect(h.calls).toHaveLength(moves.length + 1);
    expect(await h.interactions.current(traeSession)).toBeNull();
  });

  it('moves backward from decline to proceed once without granting auto or full access', async () => {
    const h = harness(commandPermission(3), [
      { keys: ['Up'], screen: commandPermission(2) },
      { keys: ['Up'], screen: commandPermission(1) },
      { keys: ['Up'], screen: commandPermission(0) },
      { keys: ['Enter'], screen: 'Continuing…' },
    ]);
    const current = (await h.interactions.current(traeSession))!;
    const result = await settle(h.interactions.respond(traeSession, response(current, 'backward-choice', { action: 'option:option-0' })));
    expect(result.status).toBe('completed');
    expect(h.remaining).toEqual([]);
  });

  it('keeps the preceding column-zero wrapped choice when moving to a later choice', async () => {
    const h = harness(commandPermission(0, true), [
      { keys: ['Down'], screen: commandPermission(1, true) },
      { keys: ['Down'], screen: commandPermission(2, true) },
      { keys: ['Enter'], screen: 'Continuing…' },
    ]);
    const current = (await h.interactions.current(traeSession))!;
    expect(current.options).toHaveLength(4);
    expect(current.options[0]?.label).toBe('1. Yes, proceed (y)');
    const result = await settle(h.interactions.respond(traeSession, response(current, 'wrapped-choice', { action: 'option:option-2' })));
    expect(result.status).toBe('completed');
    expect(h.remaining).toEqual([]);
  });

  it.each(contentChanges)('rejects a changed $label before sending any keys', async ({ before, after }) => {
    const h = harness(commandPermission(), []);
    const current = (await h.interactions.current(traeSession))!;
    h.repaint(commandPermission().replace(before, after));
    await expect(h.interactions.respond(traeSession, response(current, 'stale-command', { action: 'option:option-0' })))
      .rejects.toMatchObject({ code: 'NATIVE_INTERACTION_STALE' });
    expect(h.calls).toEqual([]);
  });

  it.each(contentChanges)('stops without Enter if the $label changes while moving', async ({ before, after }) => {
    const h = harness(commandPermission(), [
      { keys: ['Down'], screen: commandPermission(1).replace(before, after) },
    ]);
    const current = (await h.interactions.current(traeSession))!;
    const request = response(current, 'changed-command', { action: 'option:option-3' });
    const result = await settle(h.interactions.respond(traeSession, request));
    expect(result.status).toBe('uncertain');
    expect(h.calls).toEqual([{ keys: ['Down'] }]);
    expect(h.remaining).toEqual([]);
    expect(await h.interactions.respond(traeSession, request)).toEqual(result);
    expect(h.calls).toHaveLength(1);
  });

  it('reports advanced when confirming reveals a different command authorization', async () => {
    const next = commandPermission().replace('git status --short', 'git diff --stat');
    const h = harness(commandPermission(), [{ keys: ['Enter'], screen: next }]);
    const current = (await h.interactions.current(traeSession))!;
    const result = await settle(h.interactions.respond(traeSession, response(current, 'next-command', { action: 'option:option-0' })));
    expect(result.status).toBe('advanced');
    expect(result.interaction?.kind).toBe('permission');
    expect(result.interaction?.id).not.toBe(current.id);
    expect(result.interaction?.message).toContain('git diff --stat');
    expect(h.calls).toEqual([{ keys: ['Enter'] }]);
    expect(h.remaining).toEqual([]);
  });

  it('reports uncertain without resubmitting when Enter leaves the authorization unchanged', async () => {
    const h = harness(commandPermission(), [{ keys: ['Enter'], screen: commandPermission() }]);
    const current = (await h.interactions.current(traeSession))!;
    const request = response(current, 'unconfirmed-command', { action: 'option:option-0' });
    const result = await settle(h.interactions.respond(traeSession, request));
    expect(result.status).toBe('uncertain');
    expect(result.interaction?.id).toBe(current.id);
    expect(await h.interactions.respond(traeSession, request)).toEqual(result);
    expect(h.calls).toEqual([{ keys: ['Enter'] }]);
    expect(h.remaining).toEqual([]);
  });
});

describe('NativeInteractions Cursor question execution', () => {
  it.each([
    { label: 'CJK and English', other: '只跟 feed 场景相关，如果不只是服务于 feed，那就改名', wrapped: ['只跟 feed 场景相关，如果不只是服务于', 'feed，那就改名'] },
    { label: 'a URL after CJK punctuation', other: '请先确认 arch lab 的目标是什么？ https://example.invalid/docx/ExampleLink123', wrapped: ['请先确认 arch lab 的目标是什么？', 'https://example.invalid/docx/ExampleLink123'] },
  ])('commits wrapped Other text ($label), advances to question two, and submits an ordinary answer', async ({ other, wrapped }) => {
    const h = harness(question(1), [
      { keys: ['Down'], screen: question(1, { focus: 1 }) },
      { keys: ['Down'], screen: question(1, { focus: 2 }) },
      { keys: ['End', 'C-u'], screen: question(1, { focus: 2 }) },
      { paste: other, submit: false, screen: question(1, { focus: 2, other: wrapped }) },
      { keys: ['Enter'], screen: question(2) },
      { keys: ['Space'], screen: question(2, { selected: 0 }) },
      { keys: ['Enter'], screen: 'Working on the implementation…' },
    ]);
    const first = (await h.interactions.current(session))!;
    const request = response(first, 'other-answer', { otherText: other });

    const advanced = await settle(h.interactions.respond(session, request));

    expect(advanced.status).toBe('advanced');
    expect(advanced.interaction).toMatchObject({ questionIndex: 2, questionCount: 2 });
    expect(advanced.interaction!.id).not.toBe(first.id);
    expect(h.calls).toHaveLength(5);
    expect(await h.interactions.respond(session, request)).toEqual(advanced);
    expect(h.calls).toHaveLength(5);

    const completed = await settle(h.interactions.respond(session, response(advanced.interaction!, 'last-answer', { selectedIds: ['option-0'] })));
    expect(completed.status).toBe('completed');
    expect(h.remaining).toEqual([]);
    expect(await h.interactions.current(session)).toBeNull();
    expect(h.interactions.isResponding('terminal-1')).toBe(false);
  });

  it('answers two ordinary questions consecutively', async () => {
    const h = harness(question(1), [
      { keys: ['Down'], screen: question(1, { focus: 1 }) },
      { keys: ['Space'], screen: question(1, { focus: 1, selected: 1 }) },
      { keys: ['Enter'], screen: question(2) },
      { keys: ['Space'], screen: question(2, { selected: 0 }) },
      { keys: ['Enter'], screen: 'Working on the implementation…' },
    ]);
    const first = (await h.interactions.current(session))!;
    const next = await settle(h.interactions.respond(session, response(first, 'first-answer', { selectedIds: ['option-1'] })));
    expect(next.status).toBe('advanced');
    expect(next.interaction?.questionIndex).toBe(2);
    const completed = await settle(h.interactions.respond(session, response(next.interaction!, 'second-answer', { selectedIds: ['option-0'] })));
    expect(completed.status).toBe('completed');
    expect(h.remaining).toEqual([]);
  });

  it('navigates back from the Other editor, preserves the previous answer, and skips the group', async () => {
    const h = harness(question(2, { focus: 2 }), [
      { keys: ['BTab'], screen: question(1, { selected: 1 }) },
      { keys: ['Right'], screen: question(2, { focus: 2 }) },
      { keys: ['Escape'], screen: 'Questions skipped. Continuing…' },
    ]);
    const second = (await h.interactions.current(session))!;
    const previous = await settle(h.interactions.respond(session, response(second, 'previous', { action: 'previous' })));
    expect(previous.status).toBe('advanced');
    expect(previous.interaction).toMatchObject({ questionIndex: 1, options: [{ selected: false }, { selected: true }] });
    const next = await settle(h.interactions.respond(session, response(previous.interaction!, 'next', { action: 'next' })));
    expect(next.status).toBe('advanced');
    const skipped = await settle(h.interactions.respond(session, response(next.interaction!, 'skip', { action: 'skip' })));
    expect(skipped.status).toBe('completed');
    expect(h.remaining).toEqual([]);
  });

  it.each([
    ['truncated text', ['只跟 feed 场景相关，如果不只是服务于', 'feed，那就改']],
    ['missing character', ['只跟 feed 场景相关，如果不只是服务于', 'fed，那就改名']],
    ['changed whitespace inside a line', ['只跟feed 场景相关，如果不只是服务于', 'feed，那就改名']],
  ])('never submits an unverified Other answer (%s), including a repeated request', async (_name, visible) => {
    const other = '只跟 feed 场景相关，如果不只是服务于 feed，那就改名';
    const h = harness(question(1, { focus: 2 }), [
      { keys: ['End', 'C-u'], screen: question(1, { focus: 2 }) },
      { paste: other, submit: false, screen: question(1, { focus: 2, other: visible }) },
    ]);
    const current = (await h.interactions.current(session))!;
    const request = response(current, 'unverified-answer', { otherText: other });
    const uncertain = await settle(h.interactions.respond(session, request));
    expect(uncertain.status).toBe('uncertain');
    expect(h.calls).toEqual([{ keys: ['End', 'C-u'] }, { paste: other, submit: false }]);
    expect(await h.interactions.respond(session, request)).toEqual(uncertain);
    expect(h.calls).toHaveLength(2);
    expect(h.remaining).toEqual([]);
    expect(h.interactions.isResponding('terminal-1')).toBe(false);
  });

  it('stops immediately if the CLI changes question during input', async () => {
    const h = harness(question(1, { focus: 2 }), [
      { keys: ['End', 'C-u'], screen: question(2) },
    ]);
    const first = (await h.interactions.current(session))!;
    const request = response(first, 'question-changed', { otherText: '只跟 feed 场景相关' });
    const uncertain = await settle(h.interactions.respond(session, request));
    expect(uncertain.status).toBe('uncertain');
    expect(h.calls).toEqual([{ keys: ['End', 'C-u'] }]);
    expect(await h.interactions.respond(session, request)).toEqual(uncertain);
    expect(h.calls).toHaveLength(1);
    expect(h.remaining).toEqual([]);
    expect((await h.interactions.current(session))?.questionIndex).toBe(2);
  });

  it('rejects a stale question before sending any keys', async () => {
    const h = harness(question(1), []);
    const first = (await h.interactions.current(session))!;
    h.repaint(question(2));
    await expect(h.interactions.respond(session, response(first, 'stale-answer', { selectedIds: ['option-0'] })))
      .rejects.toMatchObject({ code: 'NATIVE_INTERACTION_STALE' });
    expect(h.calls).toEqual([]);
    expect(h.interactions.isResponding('terminal-1')).toBe(false);
  });
});
