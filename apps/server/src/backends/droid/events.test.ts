import { describe, expect, it } from 'vitest';
import {
  describeDroidToolCall,
  droidSubagentReport,
  droidToolResultEvent,
  messageFromJsonl,
  messageFromProtocol,
  parseDroidQuestionnaire,
  parseDroidTodos,
  projectDroidMessage,
  projectDroidTurnEnd,
  stripDroidSystemNotifications,
} from './events.js';
import { droidSlashItems } from './runtime.js';

describe('Droid slash catalog', () => {
  it('lists custom commands and user-invocable, enabled skills', () => {
    expect(droidSlashItems([
      { name: 'supaterm', description: 'Control Supaterm', filePath: '/skills/supaterm/SKILL.md', enabled: true, userInvocable: true },
      { name: 'model-only', description: 'x', enabled: true, userInvocable: false },
      { name: 'off', description: 'x', enabled: false, userInvocable: true },
    ], [{ name: '/ship', description: 'Ship it', argumentHint: '<branch>' }])).toEqual([
      { name: 'ship', kind: 'command', description: 'Ship it', hint: '<branch>' },
      { name: 'supaterm', kind: 'skill', description: 'Control Supaterm', path: '/skills/supaterm/SKILL.md' },
    ]);
  });
});

const options = { sessionId: 'wb-1' };

describe('Droid message projection', () => {
  it('retains native budget notices as provider notices in live and persisted history without treating them as user prompts', () => {
    const content = [{ type: 'text', text: 'Your standard model budget is exhausted. You have been switched to kimi-k3 (Droid Core).' }];
    const live = messageFromProtocol({ id: 'budget', role: 'user', visibility: 'user_only', seq: 10, createdAt: '2026-10-17T00:00:00Z', content })!;
    const stored = messageFromJsonl({ type: 'message', id: 'budget', seq: 10, timestamp: '2026-10-17T00:00:00Z', message: { role: 'user', visibility: 'user_only', content } })!;
    const projected = projectDroidMessage(live, options);
    expect(projectDroidMessage(stored, options)).toEqual(projected);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ type: 'task_notification', data: { kind: 'provider', title: 'Droid 通知', detail: content[0]!.text } });
    expect(projectDroidMessage({ ...live, visibility: undefined }, options)[0]?.type).toBe('user_message_chunk');
  });

  it('reads the same message from a protocol frame and a JSONL line', () => {
    const live = messageFromProtocol({ id: 'u1', role: 'user', parentId: 'context-u1', seq: 1, createdAt: 1791774798208, content: [{ type: 'text', text: 'hi' }] });
    const stored = messageFromJsonl({ type: 'message', id: 'u1', parentId: 'context-u1', seq: 1, timestamp: '2026-10-12T03:13:18.208Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
    expect(stored).toEqual(live);
  });

  it('hides context reminders and model-only notes', () => {
    expect(projectDroidMessage({ id: 'context-u1', role: 'user', seq: 0, createdAt: '', content: [{ type: 'text', text: '<system-reminder>' }] }, options)).toEqual([]);
    expect(projectDroidMessage({ id: 'n1', role: 'user', seq: 4, visibility: 'llm_only', createdAt: '', content: [{ type: 'text', text: 'cancelled' }] }, options)).toEqual([]);
  });

  it('shows a skill invocation as typed, without the skill body Droid appends to it', () => {
    const text = 'please use /supaterm now\n\n<system-notification>\nSkills provide specialized capabilities.\n<skill name="supaterm"># body</skill>\n</system-notification>';
    const [event] = projectDroidMessage({ id: 'u1', role: 'user', seq: 1, createdAt: '', content: [{ type: 'text', text }] }, options);
    expect(event?.data.content).toEqual({ type: 'text', text: 'please use /supaterm now' });
    expect(stripDroidSystemNotifications('quote <system-notification> mid-text and go on')).toBe('quote <system-notification> mid-text and go on');
  });

  it('tags a user message with the command that sent it', () => {
    const [event] = projectDroidMessage({ id: 'u1', role: 'user', seq: 1, createdAt: '', content: [{ type: 'text', text: 'hi' }] }, { ...options, commandId: 'cmd-1', runId: 'run-1' });
    expect(event).toMatchObject({ nativeId: 'msg:u1', nativeAliases: ['cmd-1'], runId: 'run-1', type: 'user_message_chunk', data: { commandId: 'cmd-1', content: { text: 'hi' } } });
  });

  it('identifies assistant blocks by index and derives a plan from TodoWrite', () => {
    const events = projectDroidMessage({ id: 'a1', role: 'assistant', seq: 2, createdAt: '', content: [
      { type: 'thinking', thinking: 'plan' },
      { type: 'text', text: 'ok' },
      { type: 'tool_use', id: 'toolu_1', name: 'TodoWrite', input: { todos: '1. [in_progress] Read notes\n2. [pending] Write summary' } },
    ] }, options);
    expect(events.map(event => [event.type, event.nativeId])).toEqual([
      ['agent_thought_chunk', 'msg:a1:0'],
      ['agent_message_chunk', 'msg:a1:1'],
      ['tool_call', 'tool:toolu_1'],
      ['plan', 'todo:toolu_1'],
    ]);
    expect(events[3]?.data.entries).toEqual([{ content: 'Read notes', status: 'in_progress' }, { content: 'Write summary', status: 'pending' }]);
  });

  it('projects stored tool results (role user) and live ones (role tool) the same way', () => {
    const content = [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Error: Tool execution cancelled by user', is_error: true }];
    const stored = projectDroidMessage({ id: 't1', role: 'user', seq: 3, createdAt: '', content }, options);
    const live = droidToolResultEvent({ seq: 3, createdAt: '' }, { toolUseId: 'toolu_1', content: 'Error: Tool execution cancelled by user', isError: true }, options);
    expect(stored).toEqual([live]);
    expect(live).toMatchObject({ nativeId: 'tool:toolu_1:result', data: { status: 'failed' } });
  });

  it('shows a Task result as its report and links the child session', () => {
    const content = 'session_id: 87bb7851-a78a-4d59-98a0-b3d9e5614956\nUse this report as the source of record. Continue from it.\n## Report\n\n**Total count of files:** 0';
    const event = droidToolResultEvent({ seq: 3, createdAt: '' }, { toolUseId: 'toolu_1', content, isError: false }, options);
    expect(event?.data).toMatchObject({ subagentResult: { agentId: '87bb7851-a78a-4d59-98a0-b3d9e5614956' }, content: [{ content: { text: '**Total count of files:** 0' } }] });
    expect(droidSubagentReport('session_id: ../x\nhi')).toBeUndefined();
  });

  it('keeps the diff of a file change by dropping its success receipt', () => {
    const event = droidToolResultEvent({ seq: 3, createdAt: '' }, { toolUseId: 'toolu_1', content: '{"success":true,"file_path":"/repo/a.ts"}', isError: false }, options);
    expect(event?.data.content).toBeUndefined();
    expect(event?.data.status).toBe('completed');
  });
});

describe('Droid turn outcomes', () => {
  it('maps reasons to run outcomes carrying the command', () => {
    const at = (reason: string) => projectDroidTurnEnd({ turnId: 'u1', reason }, 3, '', { ...options, commandId: 'cmd-1' });
    expect(at('completed')).toMatchObject({ type: 'run_completed', nativeId: 'turn:u1:end', data: { commandId: 'cmd-1' } });
    expect(at('cancelled')?.type).toBe('run_cancelled');
    expect(at('model_refusal')).toMatchObject({ type: 'run_failed', data: { error: 'The model ended this turn (model_refusal).' } });
    expect(projectDroidTurnEnd({ turnId: 'u1', reason: 'completed' }, undefined, '', options)).toBeUndefined();
  });
});

describe('Droid tool inputs', () => {
  it('parses a todo list only when every line parses', () => {
    expect(parseDroidTodos('1. [completed] A\n2. [in progress] B')).toEqual([{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }]);
    expect(parseDroidTodos('1. [pending] A\nstray line')).toBeUndefined();
    expect(parseDroidTodos([{ content: 'A', status: 'done' }])).toEqual([{ content: 'A', status: 'completed' }]);
  });

  it('parses an AskUser questionnaire', () => {
    expect(parseDroidQuestionnaire('1. [question] Which color?\n[topic] Color\n[option] Red\n[option] Blue\n2. [question] Size?\n[option] S')).toEqual([
      { question: 'Which color?', topic: 'Color', options: ['Red', 'Blue'] },
      { question: 'Size?', options: ['S'] },
    ]);
  });

  it('describes edits as diffs and patches by the files they touch', () => {
    expect(describeDroidToolCall('Edit', { file_path: '/repo/a.ts', old_str: 'a', new_str: 'b' })).toMatchObject({ kind: 'edit', content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'a', newText: 'b' }] });
    const patch = describeDroidToolCall('ApplyPatch', { input: '*** Begin Patch\n*** Update File: /repo/a.ts\n*** Add File: /repo/b.ts\n*** End Patch' });
    expect(patch.locations).toEqual([{ path: '/repo/a.ts' }, { path: '/repo/b.ts' }]);
    expect(describeDroidToolCall('Execute', { command: 'ls' })).toMatchObject({ kind: 'execute' });
  });

  it('describes a Task call as a subagent the row can open', () => {
    expect(describeDroidToolCall('Task', { subagent_type: 'worker', description: 'List files', prompt: 'Use LS', await: true })).toEqual({
      kind: 'agent', title: 'List files', subagent: { description: 'List files', prompt: 'Use LS', type: 'worker', background: false },
    });
  });

  it('decides Task background like the CLI: run_in_background wins, otherwise only await:true is foreground', () => {
    const background = (input: Record<string, unknown>) => (describeDroidToolCall('Task', input).subagent as { background: boolean }).background;
    expect(background({ run_in_background: true, await: true })).toBe(true);
    expect(background({ run_in_background: false, await: false })).toBe(false);
    expect(background({ await: true })).toBe(false);
    expect(background({ await: false })).toBe(true);
    expect(background({})).toBe(true);
  });
});
