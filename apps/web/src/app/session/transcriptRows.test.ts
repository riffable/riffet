import { describe, expect, it } from 'vitest';
import type { TimelineItem } from './model';
import { heldFooterRow, transcriptTurns, type TranscriptRow } from './transcriptRows';

const TURN = 'run:turn-1';
const AT = '2026-11-22T05:39:00.000Z';

function projected(sequence: number, type: string, data: Record<string, unknown> = {}): TimelineItem['event'] {
  const base = { sequence, sessionId: 'session-1', runId: 'turn-1', type, data, createdAt: AT };
  return { ...base, projectionKey: `event:${sequence}`, sourceEvents: [base] };
}

function user(sequence: number, text: string): TimelineItem {
  return { kind: 'user', turn: TURN, key: `user:${sequence}`, text, attachments: [], event: projected(sequence, 'user_message_chunk') };
}

function assistant(sequence: number, text: string, phase?: 'commentary' | 'final_answer'): TimelineItem {
  return { kind: 'assistant', turn: TURN, key: `asst:${sequence}`, text, ...(phase ? { phase } : {}), event: projected(sequence, 'agent_message_chunk') };
}

function tool(sequence: number, kind: string, toolName: string, status = 'completed'): TimelineItem {
  return { kind: 'tool', turn: TURN, key: `tool:${sequence}`, event: projected(sequence, 'tool_call', { toolCallId: `call-${sequence}`, kind, toolName, status }) };
}

function describeRow(row: TranscriptRow): string {
  if (row.type === 'process') return `process(${row.items.map(item => item.key).join(',')})`;
  if (row.type === 'trigger') return `trigger(${row.notices.length})`;
  return `${row.item.kind}:${row.item.key}:${row.footer}`;
}

describe('transcriptTurns interaction tool boundaries', () => {
  it('keeps unphased prose and AskQuestion outside TurnProcess when skipped and followed by a closing line', () => {
    const timeline: TimelineItem[] = [
      user(1, 'Unified tool calls?'),
      assistant(2, 'Checking files first.'),
      tool(3, 'read', 'Read'),
      assistant(4, 'Full design proposal with 4 layers of changes.'),
      tool(5, 'question', 'AskQuestion'),
      assistant(6, 'Let me know your preference.'),
    ];
    const [turn] = transcriptTurns(timeline, false, undefined);
    expect(turn?.rows.map(describeRow)).toEqual([
      'user:user:1:none',
      'process(asst:2,tool:3)',
      'assistant:asst:4:none',
      'tool:tool:5:none',
      'assistant:asst:6:shown',
    ]);
    const process = turn!.rows[1]!;
    expect(process.type === 'process' && process.canAutoFold).toBe(true);
  });

  it('prevents post-answer tools from swallowing pre-question prose in the same turn', () => {
    const timeline: TimelineItem[] = [
      user(1, 'Review and fix'),
      tool(2, 'read', 'Read'),
      assistant(3, 'Detailed analysis before asking.'),
      tool(4, 'question', 'AskQuestion'),
      assistant(5, 'Applying your chosen option.'),
      tool(6, 'edit', 'StrReplace'),
      assistant(7, 'All edits completed.'),
    ];
    const [turn] = transcriptTurns(timeline, false, undefined);
    expect(turn?.rows.map(describeRow)).toEqual([
      'user:user:1:none',
      'process(tool:2)',
      'assistant:asst:3:none',
      'tool:tool:4:none',
      'process(asst:5,tool:6)',
      'assistant:asst:7:shown',
    ]);
    const firstProcess = turn!.rows[1]!;
    const secondProcess = turn!.rows[4]!;
    expect(firstProcess.type === 'process' && firstProcess.canAutoFold).toBe(true);
    expect(secondProcess.type === 'process' && secondProcess.canAutoFold).toBe(true);
  });

  it('keeps plan review tools outside TurnProcess and carries the turn footer when the turn ends on the plan', () => {
    const timeline: TimelineItem[] = [
      user(1, 'Make a plan'),
      tool(2, 'read', 'Read'),
      assistant(3, 'Summary before plan review.'),
      tool(4, 'plan', 'ExitPlanMode'),
    ];
    const [turn] = transcriptTurns(timeline, false, undefined);
    expect(turn?.rows.map(describeRow)).toEqual([
      'user:user:1:none',
      'process(tool:2)',
      'assistant:asst:3:none',
      'tool:tool:4:shown',
    ]);
    const process = turn!.rows[1]!;
    expect(process.type === 'process' && process.canAutoFold).toBe(true);
    const planRow = turn!.rows[3]!;
    expect(planRow.type === 'item' && planRow.answerText).toBe('Summary before plan review.');
  });

  it('marks pre-Ask process blocks as finished while post-Ask work is still running in the same turn', () => {
    const timeline: TimelineItem[] = [
      user(1, 'Coloring rules feel off'),
      { kind: 'thought', turn: TURN, key: 'thought:2', text: 'Checking rules.', channel: 'thinking', event: projected(2, 'agent_thought_chunk') },
      assistant(3, 'Here are the two directions. Which do you prefer?'),
      tool(4, 'question', 'AskQuestion', 'completed'),
      tool(5, 'search', 'Grep', 'completed'),
      assistant(6, 'Applying the unified rule.'),
      tool(7, 'edit', 'StrReplace', 'in_progress'),
    ];
    const [turn] = transcriptTurns(timeline, true, undefined);
    expect(turn?.rows.map(describeRow)).toEqual([
      'user:user:1:none',
      'process(thought:2)',
      'assistant:asst:3:none',
      'tool:tool:4:none',
      'process(tool:5,asst:6,tool:7)',
    ]);
    const beforeAsk = turn!.rows[1]!;
    const afterAsk = turn!.rows[4]!;
    expect(beforeAsk.type === 'process' && beforeAsk.running).toBe(false);
    expect(beforeAsk.type === 'process' && beforeAsk.canAutoFold).toBe(true);
    expect(afterAsk.type === 'process' && afterAsk.running).toBe(true);
    expect(afterAsk.type === 'process' && afterAsk.canAutoFold).toBe(false);
  });

  it('keeps the running process block active when an unreceived steer sits at the end of the turn', () => {
    const unreceivedSteer: TimelineItem = {
      kind: 'user',
      turn: TURN,
      key: 'user:steer-pending',
      text: 'also check edge cases',
      attachments: [],
      event: projected(3, 'user_message_chunk'),
      run: {
        id: 'run-steer',
        sessionId: 's1',
        commandId: 'cmd-steer',
        prompt: 'also check edge cases',
        state: 'queued',
        createdAt: '2026-01-01T00:00:03.000Z',
        updatedAt: '2026-01-01T00:00:03.000Z',
        native: {
          delivery: 'preparing',
          intent: 'steer',
          ownerRunId: 'run-1',
          nativeTurnId: 'turn-1',
          input: { text: 'also check edge cases', attachmentIds: [], context: [] },
          attempt: 1,
        },
      } as never,
    };
    const timeline: TimelineItem[] = [
      user(1, 'Run checks'),
      tool(2, 'shell', 'Shell', 'in_progress'),
      unreceivedSteer,
    ];
    const [turn] = transcriptTurns(timeline, true, undefined);
    const process = turn!.rows.find(row => row.type === 'process');
    expect(process && process.type === 'process' && process.running).toBe(true);
    expect(process && process.type === 'process' && process.interrupted).toBe(false);
  });

  it('moves the held footer to trailing work after a mid-turn final_answer and settles on the true end', () => {
    const runningTimeline: TimelineItem[] = [
      user(1, 'Build and deploy'),
      tool(2, 'execute', 'Run', 'completed'),
      assistant(3, 'Please push the wrapper branch.', 'final_answer'),
      tool(4, 'execute', 'Run', 'in_progress'),
    ];
    const [runningTurn] = transcriptTurns(runningTimeline, true, undefined);
    const runningRows = runningTurn!.rows;
    expect(runningRows.map(describeRow)).toEqual([
      'user:user:1:none',
      'process(tool:2)',
      'assistant:asst:3:none',
      'process(tool:4)',
    ]);
    const firstProcess = runningRows[1]!;
    const trailingProcess = runningRows[3]!;
    expect(firstProcess.type === 'process' && !firstProcess.running && firstProcess.canAutoFold && firstProcess.footer === 'none').toBe(true);
    expect(trailingProcess.type === 'process' && trailingProcess.running && trailingProcess.footer === 'held').toBe(true);
    expect(heldFooterRow(runningRows)).toBe(trailingProcess.key);

    // Settling without another reply puts the footer on the trailing process block, copying the earlier prose.
    const endedOnProcess: TimelineItem[] = [
      runningTimeline[0]!,
      runningTimeline[1]!,
      runningTimeline[2]!,
      tool(4, 'execute', 'Run', 'completed'),
    ];
    const [endedTurn] = transcriptTurns(endedOnProcess, false, undefined);
    const endedTrailing = endedTurn!.rows[3]!;
    expect(endedTurn!.rows[2]!.type === 'item' && endedTurn!.rows[2]!.footer === 'none').toBe(true);
    expect(endedTrailing.type === 'process' && endedTrailing.footer === 'shown' && endedTrailing.answerText === 'Please push the wrapper branch.').toBe(true);

    // A later final_answer takes back the turn footer and allows the trailing process to fold.
    const settledTimeline: TimelineItem[] = [
      ...endedOnProcess,
      assistant(5, 'Package built and uploaded.', 'final_answer'),
    ];
    const [settledTurn] = transcriptTurns(settledTimeline, false, undefined);
    expect(settledTurn!.rows.map(describeRow)).toEqual([
      'user:user:1:none',
      'process(tool:2)',
      'assistant:asst:3:none',
      'process(tool:4)',
      'assistant:asst:5:shown',
    ]);
    expect(settledTurn!.rows[3]!.type === 'process' && settledTurn!.rows[3]!.canAutoFold).toBe(true);
  });

  it('keeps the footer on a final_answer when only a same-turn task_notification follows it', () => {
    const timeline: TimelineItem[] = [
      user(1, 'Run in background'),
      assistant(2, 'Started in background.', 'final_answer'),
      { kind: 'task_notification', turn: TURN, key: 'notice:3', taskKind: 'shell', status: 'completed', title: 'build', event: projected(3, 'task_notification') },
    ];
    const [turn] = transcriptTurns(timeline, false, undefined);
    expect(turn!.rows[1]!.type === 'item' && turn!.rows[1]!.footer === 'shown').toBe(true);
  });
});
