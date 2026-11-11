import { describe, expect, it } from 'vitest';
import { normalizePlanEntries, parseRolloutPlan } from './rollout-plan.js';

const row = (type: string, timestamp: string, payload: Record<string, unknown>, ordinal?: number) => JSON.stringify({
  type, timestamp, ...(ordinal === undefined ? {} : { ordinal }), payload,
});

describe('Codex rollout plans', () => {
  it('recovers the latest successful update_plan call with its turn and source position', () => {
    const content = [
      row('event_msg', '2026-10-10T10:00:00.000Z', { type: 'task_started', turn_id: 'turn-1' }),
      row('response_item', '2026-10-10T10:01:00.000Z', {
        type: 'function_call', name: 'update_plan', call_id: 'plan-1',
        arguments: JSON.stringify({ plan: [{ step: 'Old snapshot', status: 'in_progress' }] }),
      }, 4),
      row('response_item', '2026-10-10T10:01:01.000Z', { type: 'function_call_output', call_id: 'plan-1', output: 'Plan updated' }),
      row('response_item', '2026-10-10T10:02:00.000Z', {
        type: 'function_call', name: 'update_plan', call_id: 'plan-2',
        arguments: JSON.stringify({ plan: [
          { step: 'Finished task', status: 'completed' },
          { step: 'Current task', status: 'in_progress' },
          { step: 'Later task', status: 'pending' },
        ] }),
      }, 7),
      row('response_item', '2026-10-10T10:02:01.000Z', { type: 'function_call_output', call_id: 'plan-2', output: 'Plan updated' }),
      row('response_item', '2026-10-10T10:03:00.000Z', {
        type: 'function_call', name: 'update_plan', call_id: 'plan-3',
        arguments: JSON.stringify({ plan: [{ step: 'Rejected task', status: 'completed' }] }),
      }, 10),
      row('response_item', '2026-10-10T10:03:01.000Z', { type: 'function_call_output', call_id: 'plan-3', output: 'Error: invalid plan' }),
      row('response_item', '2026-10-10T10:04:00.000Z', {
        type: 'function_call', name: 'update_plan', call_id: 'plan-unpaired',
        arguments: JSON.stringify({ plan: [{ step: 'Unpaired task', status: 'completed' }] }),
      }, 13),
      row('event_msg', '2026-10-10T10:05:00.000Z', { type: 'task_complete', turn_id: 'turn-1' }),
    ].join('\n');

    expect(parseRolloutPlan(content)).toEqual({
      entries: [
        { content: 'Finished task', status: 'completed' },
        { content: 'Current task', status: 'in_progress' },
        { content: 'Later task', status: 'pending' },
      ],
      timestamp: '2026-10-10T10:02:00.000Z',
      ordinal: 7,
      callId: 'plan-2',
      turnId: 'turn-1',
    });
  });

  it('keeps an explicit empty snapshot and maps app-server status casing', () => {
    expect(normalizePlanEntries([])).toEqual([]);
    expect(normalizePlanEntries([{ step: 'Valid', status: 'pending' }, { step: 'Bad row' }])).toBeUndefined();
    expect(normalizePlanEntries([
      { step: 'Working', status: 'inProgress' },
      { step: 'Done', status: 'completed' },
      { step: 'Waiting', status: 'pending' },
    ])).toEqual([
      { content: 'Working', status: 'in_progress' },
      { content: 'Done', status: 'completed' },
      { content: 'Waiting', status: 'pending' },
    ]);
  });

  it('reads TRAE CLI history_mutation rows like response items, through a compaction', () => {
    const mutation = (timestamp: string, operation: string, items: Array<Record<string, unknown>>) => JSON.stringify({ type: 'history_mutation', timestamp, payload: { version: 1, operation, items } });
    const content = [
      row('event_msg', '2026-10-12T08:00:00.000Z', { type: 'task_started', turn_id: 'turn-1' }),
      mutation('2026-10-12T08:00:01.000Z', 'append', [{ type: 'function_call', name: 'update_plan', call_id: 'p1', arguments: JSON.stringify({ plan: [{ step: 'Read', status: 'in_progress' }] }) }]),
      mutation('2026-10-12T08:00:02.000Z', 'append', [{ type: 'function_call_output', call_id: 'p1', output: 'Plan updated' }]),
      mutation('2026-10-12T08:00:03.000Z', 'replace', [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'summary' }] }]),
    ].join('\n');
    expect(parseRolloutPlan(content)).toEqual({ entries: [{ content: 'Read', status: 'in_progress' }], timestamp: '2026-10-12T08:00:01.000Z', callId: 'p1', turnId: 'turn-1' });
  });

  it('builds the todo list from TaskCreate and TaskUpdate, in task order, only from calls that succeeded', () => {
    const call = (id: string, name: string, args: Record<string, unknown>, at: string) => row('response_item', at, { type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) });
    const output = (id: string, text: string, at: string) => row('response_item', at, { type: 'function_call_output', call_id: id, output: text });
    const content = [
      row('event_msg', '2026-10-12T09:00:00.000Z', { type: 'task_started', turn_id: 'turn-7' }),
      call('c1', 'TaskCreate', { subject: 'First' }, '2026-10-12T09:00:01.000Z'),
      call('c2', 'TaskCreate', { subject: 'Second' }, '2026-10-12T09:00:01.000Z'),
      output('c2', 'Task 2 created (status: pending).', '2026-10-12T09:00:02.000Z'),
      output('c1', 'Task 1 created (status: pending).', '2026-10-12T09:00:02.000Z'),
      call('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }, '2026-10-12T09:00:03.000Z'),
      output('u1', 'Task 1 updated (status: completed).', '2026-10-12T09:00:04.000Z'),
      call('u2', 'TaskUpdate', { taskId: '2', status: 'in_progress' }, '2026-10-12T09:00:05.000Z'),
      output('u2', 'Error: task not found', '2026-10-12T09:00:06.000Z'),
    ].join('\n');
    expect(parseRolloutPlan(content)).toEqual({
      entries: [{ content: 'First', status: 'completed' }, { content: 'Second', status: 'pending' }],
      timestamp: '2026-10-12T09:00:03.000Z', callId: 'u1', turnId: 'turn-7',
    });
  });
});
