import { describe, expect, it } from 'vitest';
import { claudeRowSignals } from './rows.js';
import { activeTurnOf, initialState, phaseOf, reduce, replay, type ClaudeSessionState, type ClaudeSignal } from './session-state.js';

/**
 * Transcript rows as Claude Code 2.1.302 wrote them in the real-CLI probe (`scripts/probe-claude-e2e.ts`),
 * trimmed to the fields the state machine reads. The point is the contract between the records and
 * the state, so every case below folds rows (and hooks) through the same path the runtime uses.
 */
const human = (promptId: string, text = 'work', extra: Record<string, unknown> = {}) => ({ type: 'user', promptId, origin: { kind: 'human' }, message: { role: 'user', content: text }, ...extra });
const duration = { type: 'system', subtype: 'turn_duration', durationMs: 1900 };
const stopSummary = { type: 'system', subtype: 'stop_hook_summary' };
const assistant = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
const interrupted = (promptId: string) => ({ type: 'user', promptId, message: { role: 'user', content: '[Request interrupted by user]' } });
const queue = (operation: string, content?: string, reason?: string) => ({ type: 'queue-operation', operation, ...(content ? { content } : {}), ...(reason ? { reason } : {}) });
const notification = (toolUseId: string, status = 'completed') => `<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>Agent "Run sleeper agent" finished</summary>\n</task-notification>`;

const hook = {
  prompt: (promptId?: string, compact = false): ClaudeSignal => ({ type: 'prompt', source: 'hook', ...(promptId ? { promptId } : {}), origin: 'human', ...(compact ? { compact } : {}) }),
  stop: (promptId?: string): ClaudeSignal => ({ type: 'turn_end', source: 'hook', reason: 'stop', ...(promptId ? { promptId } : {}) }),
};

function fold(state: ClaudeSessionState, ...inputs: Array<Record<string, unknown> | ClaudeSignal>): ClaudeSessionState {
  for (const input of inputs) {
    const signals = 'source' in input || ['compact_start', 'compact_boundary', 'agents_killed', 'background', 'attention'].includes(String(input.type)) ? [input as ClaudeSignal] : claudeRowSignals(input);
    for (const signal of signals) state = reduce(state, signal).state;
  }
  return state;
}
const alive = () => initialState('alive');
const phase = (state: ClaudeSessionState) => phaseOf(state);

describe('Claude session state', () => {
  // Claude Code runs every Stop hook side by side and is done once the slowest returns, which its summary records;
  // `turn_duration` may be held back while background work runs. A hook that blocks sends the model on first.
  it('ends a turn at its Stop summary, except the round a Stop hook blocked or handed back context', () => {
    let state = fold(alive(), human('p1'), assistant, stopSummary);
    expect(phase(state)).toBe('idle');
    const feedback = { type: 'user', isMeta: true, promptId: 'p2', message: { role: 'user', content: 'Stop hook feedback:\nRun the tests first.' } };
    const withContext = { ...stopSummary, hookAdditionalContext: ['more'] };
    for (const blocked of [[feedback, stopSummary], [withContext]]) {
      state = fold(alive(), human('p2'), assistant, ...blocked);
      expect(phase(state)).toBe('busy');
      state = fold(state, assistant, stopSummary);
      expect(phase(state)).toBe('idle');
    }
  });

  it('ends a turn at the first end record from either channel, and never reopens it from the other', () => {
    // The Stop hook arrives first; the rows of the same turn are read afterwards.
    let state = fold(alive(), hook.prompt('p1'));
    expect(phase(state)).toBe('busy');
    state = fold(state, hook.stop('p1'));
    expect(phase(state)).toBe('idle');
    state = fold(state, human('p1'), assistant, stopSummary, duration);
    expect(phase(state)).toBe('idle');
    // The rows alone (hooks lost) open and close it just the same.
    state = fold(alive(), human('p2'), assistant);
    expect(phase(state)).toBe('busy');
    state = fold(state, duration);
    expect(phase(state)).toBe('idle');
  });

  it('does not let the previous turn’s end close the turn that follows it', () => {
    let state = fold(alive(), hook.prompt('p2'));
    // A late Stop of p1, and p1's turn_duration read before p2's own row, belong to p1.
    state = fold(state, hook.stop('p1'), duration);
    expect(phase(state)).toBe('busy');
    state = fold(state, human('p2'), assistant, duration);
    expect(phase(state)).toBe('idle');
  });

  it('closes an interrupted turn by the marker that names its prompt', () => {
    let state = fold(alive(), human('p1', 'sleep 30'));
    state = fold(state, interrupted('p0'));
    expect(phase(state)).toBe('busy');
    state = fold(state, interrupted('p1'));
    expect(phase(state)).toBe('idle');
  });

  it('keeps background agents apart from the main turn', () => {
    const agent = { toolUseId: 'call_bg', agentId: 'a1', agentType: 'sleeper' };
    let state = fold(alive(), human('p1', 'launch'), assistant, duration);
    state = fold(state, { type: 'background', agents: [agent] });
    // The launching turn is over although the agent still works: the main agent is free.
    expect(phase(state)).toBe('idle');
    expect(state.background).toHaveLength(1);
    // The CLI's report of the stop (`queue-operation` + `agents_killed`) ends them, for good.
    state = fold(state, queue('enqueue', 'Background agent "Run sleeper agent" was stopped by the user.'), { type: 'system', subtype: 'agents_killed' });
    expect(state.background).toEqual([]);
    expect(state.cliQueue).toEqual([{ kind: 'notification', text: 'Background agent "Run sleeper agent" was stopped by the user.' }]);
    state = fold(state, { type: 'background', agents: [agent] });
    expect(state.background).toEqual([]);
    // The queued report is taken in by whatever turn comes next, with a reason; it never makes one.
    state = fold(state, queue('remove', 'Background agent "Run sleeper agent" was stopped by the user.', 'absorbed_mid_turn'));
    expect(state.cliQueue).toEqual([]);
    expect(phase(state)).toBe('idle');
  });

  // Rows from a 2026-11-11 session: an agent's reply queued 20 s after a shell's report was taken first, and the report
  // was removed by name later. Taking the oldest left the reply in the queue, holding the conversation busy for good.
  it('takes a queued message before an earlier task report on a dequeue that names nothing', () => {
    const reply = '<agent-message from="aa43a8edfd0052751">\n[Subagent hand-back] done\n</agent-message>';
    const report = notification('call_sh');
    const state = fold(alive(), queue('enqueue', report), queue('enqueue', reply), queue('dequeue'), queue('remove', report));
    expect(state.cliQueue).toEqual([]);
  });

  it('opens a turn for a finished agent’s report taken off the CLI queue', () => {
    const agent = { toolUseId: 'call_bg' };
    let state = fold(alive(), { type: 'background', agents: [agent] });
    state = fold(state, queue('enqueue', notification('call_bg')), queue('dequeue'));
    expect(state.cliQueue).toEqual([]);
    state = fold(state, { type: 'user', promptId: 'p-note', origin: { kind: 'task-notification', producer: 'session-task' }, message: { role: 'user', content: notification('call_bg') } });
    expect(phase(state)).toBe('busy');
    expect(activeTurnOf(state.mainTurn)).toMatchObject({ origin: 'task-notification', promptId: 'p-note' });
    expect(state.background).toEqual([]);
    state = fold(state, assistant, stopSummary, duration);
    expect(phase(state)).toBe('idle');
  });

  it.each([
    { hookFirst: false, wake: { origin: { kind: 'peer' } } },
    { hookFirst: true, wake: { origin: { kind: 'peer' } } },
    // A wake-up the agent scheduled for itself (`/loop`, ScheduleWakeup) names no origin.
    { hookFirst: false, wake: { origin: undefined, turnOrigin: 'scheduled', wakeupSource: 'loop_wakeup' } },
  ])('tracks a hidden wake through replay and hook-first delivery: %j', ({ hookFirst, wake }) => {
    const peer = { ...human('peer-prompt', 'Another session reported back'), uuid: 'peer', isMeta: true, ...wake };
    const finished = fold(alive(), human('human-prompt'), assistant, duration);
    let state = hookFirst ? fold(finished, hook.prompt('peer-prompt')) : finished;
    state = fold(state, peer, assistant);
    expect(phase(state)).toBe('busy');
    expect(activeTurnOf(state.mainTurn)).toMatchObject({ promptId: 'peer-prompt', transcriptSeen: true });
    const duplicate = claudeRowSignals({ ...peer, uuid: 'peer-again' }).map(signal => reduce(state, signal));
    expect(duplicate.every(transition => transition.started === undefined && transition.ended === undefined)).toBe(true);
    state = fold(state, hook.stop('human-prompt'));
    expect(phase(state)).toBe('busy');
    state = fold(state, duration);
    expect(phase(state)).toBe('idle');
    expect(phase(fold(state, peer))).toBe('idle');
    const signals = [human('human-prompt'), duration, peer, assistant].flatMap(row => claudeRowSignals(row));
    expect(activeTurnOf(replay(alive(), signals).mainTurn)?.promptId).toBe('peer-prompt');
  });

  it.each([
    { origin: { kind: 'human' } },
    { promptId: undefined },
    { isCompactSummary: true },
    { queueTranscriptOnly: true },
    { isVisibleInTranscriptOnly: true },
    { isSidechain: true },
    { agentId: 'child' },
    { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'ok' }] } },
  ])('does not open a peer turn for non-executing context: %j', fields => {
    const row = { ...human('peer-prompt', 'internal context'), isMeta: true, origin: { kind: 'peer' }, ...fields };
    expect(claudeRowSignals(row).some(signal => signal.type === 'prompt')).toBe(false);
    expect(phase(fold(alive(), row))).toBe('idle');
  });

  it.each(['queueTranscriptOnly', 'isVisibleInTranscriptOnly'])('settles a %s task report without opening or replacing a turn', flag => {
    const agent = { toolUseId: 'call_bg' };
    const report = {
      type: 'user', promptId: 'p-note', [flag]: true,
      origin: { kind: 'task-notification', producer: 'session-task' },
      message: { role: 'user', content: notification('call_bg') },
    };
    const finished = fold(alive(), human('p1'), assistant, duration, { type: 'background', agents: [agent] });
    const state = fold(finished, report, { type: 'background', agents: [agent] });
    expect(phase(state)).toBe('idle');
    expect(state.background).toEqual([]);

    const running = fold(finished, human('p2'));
    const notified = fold(running, report);
    expect(notified.mainTurn).toEqual(running.mainTurn);
    expect(notified.background).toEqual([]);
  });

  it('keeps /compact as one turn from the command to the compact boundary', () => {
    let state = fold(alive(), human('p-greet'), assistant, duration);
    // The command row carries no origin; the CLI queues what is typed while it compacts.
    state = fold(state, { type: 'user', promptId: 'p-compact', message: { role: 'user', content: '/compact' } });
    expect(state.mainTurn.kind).toBe('compacting');
    expect(phase(state)).toBe('busy');
    state = fold(state, queue('enqueue'));
    expect(state.cliQueue).toEqual([{ kind: 'input' }]);
    // Nothing between the command and the boundary ends it — not a stale Stop, not a turn_duration.
    state = fold(state, hook.stop('p-greet'), duration);
    expect(state.mainTurn.kind).toBe('compacting');
    // The summary and the command's echo are furniture of the compaction, not prompts.
    state = fold(state, queue('dequeue'), { type: 'system', subtype: 'compact_boundary' },
      { type: 'user', promptId: 'p-after', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued…' } },
      { type: 'user', promptId: 'p-after', isMeta: true, message: { role: 'user', content: '<local-command-caveat>…' } },
      { type: 'user', promptId: 'p-after', message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' } });
    expect(phase(state)).toBe('idle');
    // The message that waited in the CLI queue then runs as an ordinary turn.
    state = fold(state, human('p-after', 'after compact', { promptSource: 'queued' }));
    expect(phase(state)).toBe('busy');
    state = fold(state, assistant, duration);
    expect(phase(state)).toBe('idle');
    // 2.1.322 writes no row before the boundary: its PreCompact hook alone says a compaction runs, until the boundary.
    state = fold(state, { type: 'compact_start', origin: 'human' });
    expect(state.mainTurn.kind).toBe('compacting');
    state = fold(state, { type: 'system', subtype: 'compact_boundary' },
      { type: 'user', promptId: 'p-late', message: { role: 'user', content: '<command-name>/compact</command-name>\n <command-message>compact</command-message>\n <command-args></command-args>' } },
      { type: 'user', promptId: 'p-late', message: { role: 'user', content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' } });
    expect(phase(state)).toBe('idle');
    // An auto-compaction inside a running turn leaves that turn running.
    state = fold(state, hook.prompt('p-long'), { type: 'compact_start', origin: 'other' }, { type: 'system', subtype: 'compact_boundary' });
    expect(activeTurnOf(state.mainTurn)).toMatchObject({ kind: 'running', promptId: 'p-long' });
  });

  it('holds attention for a participating request and returns to the turn it interrupted', () => {
    let state = fold(alive(), hook.prompt('p1'));
    state = fold(state, { type: 'attention', requestId: 'tool-1' });
    expect(phase(state)).toBe('attention');
    // A turn end while a request waits closes both.
    expect(phase(fold(state, hook.stop('p1')))).toBe('idle');
    state = fold(state, { type: 'attention' });
    expect(phase(state)).toBe('busy');
    expect(activeTurnOf(state.mainTurn)?.promptId).toBe('p1');
  });

  it('re-derives its state from a whole transcript, ending where the CLI is', () => {
    const rows = [human('p1'), assistant, duration, human('p2', '/compact'), human('p3', 'still running'), assistant];
    const state = fold(initialState('alive'), ...rows);
    expect(phase(state)).toBe('busy');
    expect(activeTurnOf(state.mainTurn)?.promptId).toBe('p3');
    expect(phase(reduce(state, { type: 'process', process: 'exited' }).state)).toBe('offline');
  });

  it('keeps hook-confirmed ends and newer prompts through transcript rewrites and late rows', () => {
    const stopped = fold(alive(), hook.prompt('p1'), hook.stop('p1'));
    // A rewrite can happen even before the closed prompt's own row exists.
    const emptyReplay = replay(stopped, []);
    expect(phase(fold(emptyReplay, human('p1')))).toBe('idle');
    const rows = claudeRowSignals(human('p1'));
    expect(phase(replay(stopped, rows))).toBe('idle');
    // A current prompt not written yet stays active; an actual new transcript prompt still opens.
    const next = fold(stopped, hook.prompt('p2'));
    expect(activeTurnOf(replay(next, rows).mainTurn)?.promptId).toBe('p2');
    expect(activeTurnOf(replay(stopped, [...rows, ...claudeRowSignals(human('p3'))]).mainTurn)?.promptId).toBe('p3');
  });

  it('lets a child agent’s request be raised and answered while the main agent is idle, without inventing a main turn', () => {
    let state = fold(alive(), { type: 'attention', requestId: 'child-1', mainThread: false });
    expect(phase(state)).toBe('attention');
    state = fold(state, { type: 'attention' });
    expect(phase(state)).toBe('idle');
    // The main agent's own request outside a turn still proves a turn it missed.
    state = fold(alive(), { type: 'attention', requestId: 'main-1' }, { type: 'attention' });
    expect(phase(state)).toBe('busy');
  });

  it('ends a compaction that failed (no boundary) by its error output or a StopFailure', () => {
    let state = fold(alive(), human('p1', '/compact'));
    expect(phase(state)).toBe('busy');
    state = fold(state, { type: 'user', promptId: 'p1', message: { role: 'user', content: '<local-command-stdout>Error: Conversation too long</local-command-stdout>' } });
    expect(phase(state)).toBe('idle');
    state = fold(alive(), human('p2', '/compact'), { type: 'turn_end', source: 'hook', reason: 'stop_failure' });
    expect(phase(state)).toBe('idle');
  });

  it('keeps no background work for a CLI that is not running, whatever the metadata says', () => {
    const agents = [{ toolUseId: 'call_bg' }];
    expect(fold(initialState('exited'), { type: 'background', agents }).background).toEqual([]);
    expect(fold(alive(), { type: 'background', agents }).background).toEqual(agents);
    // The CLI stops its agents; a shell it left running is stopped on its own report.
    const mixed = fold(alive(), { type: 'background', agents: [{ toolUseId: 'call_agent', kind: 'agent' }, { toolUseId: 'call_sh', kind: 'shell' }] }, { type: 'agents_killed' });
    expect(mixed.background.map(task => task.toolUseId)).toEqual(['call_sh']);
  });
});
