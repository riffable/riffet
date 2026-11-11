import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../../../packages/contracts/src/index.js';
import { ClaudeTranscript } from './history.js';
import { taskOutputPath } from './activity.js';

const session = { id: 'session', projectId: 'project', kind: 'native', title: 'Claude', tags: [], state: 'idle', mode: 'agent', createdAt: '', updatedAt: '' } as Session;

const dirs: string[] = [];
function transcriptFile(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-metrics-'));
  dirs.push(dir);
  const file = join(dir, 'transcript.jsonl');
  writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

/** A session file with Claude Code's real subagent layout: `<sessionId>/subagents/agent-*.{jsonl,meta.json}`. */
function subagentSession(parentLines: unknown[], children: Array<{ agentId: string; meta: Record<string, unknown>; lines: unknown[] }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-subagent-'));
  dirs.push(dir);
  const sessionId = 'native-session';
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, parentLines.map(line => JSON.stringify(line)).join('\n') + '\n');
  for (const child of children) {
    const root = join(dir, sessionId, 'subagents');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `agent-${child.agentId}.jsonl`), child.lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    writeFileSync(join(root, `agent-${child.agentId}.meta.json`), JSON.stringify(child.meta));
  }
  return file;
}

/** The parent's spawning call: Claude Code named this tool `Task` through 2.1.x and `Agent` after. */
const agentCall = (id: string, input: Record<string, unknown>, name = 'Agent') => ({
  type: 'assistant', uuid: `a-${id}`, timestamp: '2026-10-04T05:00:01.000Z',
  message: { id: `msg-${id}`, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id, name, input }] },
});

const childRow = (agentId: string, row: { type: 'user' | 'assistant'; uuid: string; text: string; at: string; content?: unknown }) => ({
  type: row.type, uuid: row.uuid, timestamp: row.at, isSidechain: true, agentId, sessionId: 'native-session', cwd: '/repo',
  message: row.type === 'assistant'
    ? { id: `m-${row.uuid}`, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: row.text }], stop_reason: 'end_turn' }
    : { role: 'user', content: row.content ?? row.text },
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('complete read-only Claude exports', () => {
  it('preserves a full answer and tool output while ordinary reads retain their payload limits', async () => {
    const text = '内容'.repeat(50_000);
    const file = transcriptFile([
      { type: 'user', uuid: 'user', timestamp: '2026-10-23T10:00:00Z', message: { role: 'user', content: 'Question' } },
      { type: 'assistant', uuid: 'call', timestamp: '2026-10-23T10:00:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'Other', input: {} }] } },
      { type: 'user', uuid: 'result', timestamp: '2026-10-23T10:00:02Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: text }] } },
      { type: 'assistant', uuid: 'answer', timestamp: '2026-10-23T10:00:03Z', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    ]);
    const full = new ClaudeTranscript(session, 'native-session', { unbounded: true });
    await full.setFile(file);
    expect(full.allEvents().find(event => event.type === 'agent_message_chunk')?.data.content).toEqual({ type: 'text', text });
    expect(full.allEvents().find(event => event.type === 'tool_call_update')?.data.content).toEqual([{ type: 'content', content: { type: 'text', text } }]);
    const ordinary = new ClaudeTranscript(session, 'native-session');
    await ordinary.setFile(file);
    expect((ordinary.allEvents().find(event => event.type === 'agent_message_chunk')?.data.content as { text: string }).text.length).toBeLessThan(text.length);
  });

  it('refuses an unavailable earlier transcript in a full export', async () => {
    const file = transcriptFile([{ type: 'user', uuid: 'user', message: { role: 'user', content: 'Latest' } }]);
    const transcript = new ClaudeTranscript({ ...session, previousNativeSessionIds: ['missing-earlier-session'] }, 'native-session', { unbounded: true, precedingConfigDir: join(file, 'absent') });
    await transcript.setFile(file);
    expect(transcript.state).toBe('unparsed');
    expect(transcript.allEvents()).toEqual([]);
  });
});

const assistant = (options: { id: string; uuid: string; at: string; outputTokens: number; text?: string; thinking?: string; model?: string; usage?: Record<string, unknown>; content?: unknown[] }) => ({
  type: 'assistant',
  uuid: options.uuid,
  timestamp: options.at,
  message: {
    id: options.id,
    role: 'assistant',
    model: options.model ?? 'claude-opus-5',
    content: options.content ?? [
      ...(options.thinking === undefined ? [] : [{ type: 'thinking', thinking: options.thinking }]),
      ...(options.text === undefined ? [] : [{ type: 'text', text: options.text }]),
    ],
    usage: options.usage ?? { output_tokens: options.outputTokens },
  },
});

const user = (options: { uuid: string; at: string; text: string }) => ({
  type: 'user',
  uuid: options.uuid,
  timestamp: options.at,
  message: { role: 'user', content: options.text },
});

async function measure(lines: unknown[]) {
  const transcript = new ClaudeTranscript(session, 'native-session');
  await transcript.setFile(transcriptFile(lines));
  return transcript.measurements();
}

describe('Claude turn ends', () => {
  const prompt = {
    type: 'user', uuid: 'u1', promptId: 'p1', timestamp: '2026-10-04T05:00:00.000Z',
    origin: { kind: 'human' }, message: { role: 'user', content: 'hi' },
  };
  const interrupted = {
    type: 'user', uuid: 'u2', promptId: 'p1', timestamp: '2026-10-04T05:00:02.000Z',
    message: { role: 'user', content: '[Request interrupted by user]' },
  };

  it('still synthesizes the cancellation from the file after a restart (nothing injected)', async () => {
    const transcript = new ClaudeTranscript(session, 'native-session');
    await transcript.setFile(transcriptFile([prompt, interrupted]));
    await transcript.refresh();
    expect(transcript.allEvents().filter(event => event.type === 'run_cancelled')).toHaveLength(1);
  });

});

describe('Claude skill invocations', () => {
  const command = (uuid: string, name: string, args: string) => ({
    type: 'user', uuid, timestamp: '2026-10-04T05:00:00.000Z', promptId: `p-${uuid}`,
    message: { role: 'user', content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>` },
  });
  const skillBody = (uuid: string) => ({
    type: 'user', uuid, timestamp: '2026-10-04T05:00:00.100Z', isMeta: true, promptId: 'p-u1',
    message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /skills/dataviz\n\n# Data Visualization' }] },
  });

  async function prompts(lines: unknown[], hooks: ConstructorParameters<typeof ClaudeTranscript>[2] = {}) {
    const transcript = new ClaudeTranscript(session, 'native-session', hooks);
    await transcript.setFile(transcriptFile(lines));
    return transcript.allEvents().filter(event => event.type === 'user_message_chunk').map(event => (event.data.content as { text: string }).text);
  }

  it('reads a skill invocation back as typed and hides the skill body Claude injects', async () => {
    expect(await prompts([command('u1', 'dataviz', 'chart this'), skillBody('u2'), assistant({ id: 'm1', uuid: 'a1', at: '2026-10-04T05:00:01.000Z', outputTokens: 1, text: 'ok' })]))
      .toEqual(['/dataviz chart this']);
  });

  it('reads a rewritten message back as the user wrote it only when the runtime says it rewrote it', async () => {
    const rows = [command('u1', 'dataviz', 'please use /dataviz for this'), skillBody('u2')];
    expect(await prompts(rows, { promptText: prompt => prompt === '/dataviz please use /dataviz for this' ? 'please use /dataviz for this' : undefined }))
      .toEqual(['please use /dataviz for this']);
    // A command the user typed that repeats its own name stays as typed.
    expect(await prompts(rows)).toEqual(['/dataviz please use /dataviz for this']);
  });

  it('shows a pasted prompt without the wrapper Claude Code 2.1.302 adds around it', async () => {
    const wrapped = (id: string, body: string) => `<pasted_content id="${id}">${body}</pasted_content id="${id}">`;
    expect(await prompts([
      user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: `\n${wrapped('1', 'line one\nline two')}` }),
      user({ uuid: 'u2', at: '2026-10-04T05:00:01.000Z', text: `before\n${wrapped('2', 'a\nb')}\nafter` }),
    ])).toEqual(['line one\nline two', 'before\na\nb\nafter']);
  });

  it('leaves a prompt that only quotes the markup as written', async () => {
    expect(await prompts([user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: 'what does <command-name>/x</command-name> mean?' })]))
      .toEqual(['what does <command-name>/x</command-name> mean?']);
  });
});

describe('Claude transcript title', () => {
  it('reads the title Claude Code writes, preferring a rename and the latest row', async () => {
    const lines: unknown[] = [user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: '帮我看一下统计页面' })];
    const file = transcriptFile(lines);
    const transcript = new ClaudeTranscript(session, 'native-session');
    await transcript.setFile(file);
    expect(transcript.title).toBeUndefined();
    appendFileSync(file, `${JSON.stringify({ type: 'ai-title', aiTitle: '统计页面样式', sessionId: 'native-session' })}\n${JSON.stringify({ type: 'ai-title', aiTitle: '优化统计页面样式', sessionId: 'native-session' })}\n`);
    await transcript.refresh();
    expect(transcript.title).toBe('优化统计页面样式');
    appendFileSync(file, `${JSON.stringify({ type: 'custom-title', customTitle: '我的统计页', sessionId: 'native-session' })}\n`);
    await transcript.refresh();
    expect(transcript.title).toBe('我的统计页');
  });
});

describe('Claude tool result images', () => {
  const toolUse = (id: string, name: string, input: unknown) => ({ type: 'assistant', uuid: `a-${id}`, timestamp: '2026-10-04T05:00:01.000Z', message: { id: `msg-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  const toolResult = (id: string, content: unknown) => ({ type: 'user', uuid: `r-${id}`, timestamp: '2026-10-04T05:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  async function update(lines: unknown[]) {
    const transcript = new ClaudeTranscript(session, 'native-session');
    await transcript.setFile(transcriptFile(lines));
    return transcript.allEvents().filter(event => event.type === 'tool_call_update').at(-1)!.data.content;
  }

  it('keeps a result in the turn its call was issued in when a later prompt arrives first', async () => {
    const transcript = new ClaudeTranscript(session, 'native-session');
    await transcript.setFile(transcriptFile([
      user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: 'first' }),
      toolUse('t1', 'Bash', { command: 'sleep 5' }),
      user({ uuid: 'u2', at: '2026-10-04T05:00:01.500Z', text: 'second' }),
      toolResult('t1', 'done'),
    ]));
    const pair = transcript.allEvents().filter(event => event.data.toolCallId === 't1');
    expect(pair.map(event => event.type)).toEqual(['tool_call', 'tool_call_update']);
    expect(pair[0]!.runId).toBeDefined();
    expect(pair[1]!.runId).toBe(pair[0]!.runId);
  });

  it('leads with the transcripts of earlier provider sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-chain-'));
    dirs.push(dir);
    const earlier = '11111111-1111-4111-8111-111111111111';
    mkdirSync(join(dir, 'projects', 'p'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'p', `${earlier}.jsonl`), JSON.stringify(user({ uuid: 'old-1', at: '2026-10-04T04:00:00.000Z', text: 'before the restart' })) + '\n');
    const transcript = new ClaudeTranscript({ ...session, previousNativeSessionIds: [earlier] }, 'native-session', { precedingConfigDir: dir });
    await transcript.setFile(transcriptFile([user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: 'after' })]));
    const texts = transcript.allEvents().filter(event => event.type === 'user_message_chunk').map(event => (event.data.content as { text: string }).text);
    expect(texts).toEqual(['before the restart', 'after']);
  });

  it('shows an image Read by its file path and keeps the text blocks', async () => {
    const content = await update([
      user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: 'look' }),
      toolUse('t1', 'Read', { file_path: '/repo/shot.png' }),
      toolResult('t1', [{ type: 'text', text: 'Image file' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(100_000) } }]),
    ]);
    expect(content).toEqual([
      { type: 'content', content: { type: 'text', text: 'Image file' } },
      { type: 'content', content: { type: 'image', path: '/repo/shot.png', mimeType: 'image/png' } },
    ]);
  });

  it('inlines a small image that has no file behind it', async () => {
    const content = await update([
      user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: 'snap' }),
      toolUse('t2', 'mcp__browser__screenshot', {}),
      toolResult('t2', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }]),
    ]);
    expect(content).toEqual([{ type: 'content', content: { type: 'image', data: 'iVBOR', mimeType: 'image/png' } }]);
  });
});

/**
 * An edit is only readable when the call carries both sides of the change. `Edit` sends
 * `old_string`/`new_string` and `Write` sends the new file as `content`; the UI draws a diff from
 * the `diff` block alone, so a call without one renders as its title and nothing else.
 */
describe('Claude file edit diffs', () => {
  const toolUse = (id: string, name: string, input: unknown) => ({ type: 'assistant', uuid: `a-${id}`, timestamp: '2026-10-04T05:00:01.000Z', message: { id: `msg-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  async function call(name: string, input: Record<string, unknown>) {
    const transcript = new ClaudeTranscript(session, 'native-session');
    await transcript.setFile(transcriptFile([user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: 'go' }), toolUse('t1', name, input)]));
    return transcript.allEvents().find(event => event.type === 'tool_call')!.data;
  }

  it('carries both sides of an Edit as a diff', async () => {
    const data = await call('Edit', { file_path: '/repo/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' });
    expect(data).toMatchObject({
      kind: 'edit', title: 'Edit a.ts',
      content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'const a = 1;', newText: 'const a = 2;' }],
    });
  });

  it('carries a Write as a diff against an empty file', async () => {
    const data = await call('Write', { file_path: '/repo/b.ts', content: 'export const b = 2;\n' });
    expect(data).toMatchObject({
      kind: 'edit', title: 'Write b.ts',
      content: [{ type: 'diff', path: '/repo/b.ts', oldText: '', newText: 'export const b = 2;\n' }],
    });
  });

  it('leaves a call that carries no file text without a diff block', async () => {
    // `replace_all` alone is not a change to draw; a diff of two empty strings is worse than none.
    expect((await call('Edit', { file_path: '/repo/c.ts', replace_all: true })).content).toBeUndefined();
    expect((await call('Read', { file_path: '/repo/c.ts' })).content).toBeUndefined();
  });
});

describe('Claude task plan snapshots', () => {
  const taskCall = (id: string, name: 'TaskCreate' | 'TaskUpdate', input: Record<string, unknown>) => ({
    type: 'assistant', uuid: `a-${id}`, timestamp: '2026-10-04T05:00:01.000Z',
    message: { id: `msg-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
  const taskResult = (id: string, content: string, toolUseResult: unknown, isError = false) => ({
    type: 'user', uuid: `r-${id}`, timestamp: '2026-10-04T05:00:02.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
    toolUseResult,
  });

  it('projects committed TaskCreate and TaskUpdate rows into live and reopened snapshots', async () => {
    const file = transcriptFile([
      user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: 'Implement the fix' }),
      taskCall('create-1', 'TaskCreate', { subject: 'Add the mapper', description: 'Map task tools', activeForm: 'Mapping task tools' }),
      taskResult('create-1', 'Task #7 created successfully: Add the mapper', { task: { id: '7', subject: 'Add the mapper' } }),
      taskCall('update-1', 'TaskUpdate', { taskId: '7', status: 'in_progress' }),
      taskResult('update-1', 'Updated task #7 status', { success: true, taskId: '7', updatedFields: ['status'], statusChange: { from: 'pending', to: 'in_progress' } }),
    ]);
    const transcript = new ClaudeTranscript(session, 'native-session');
    await transcript.setFile(file);

    expect(transcript.allEvents().filter(event => event.type === 'plan').map(event => event.data.entries)).toEqual([
      [{ id: '7', content: 'Add the mapper', status: 'pending' }],
      [{ id: '7', content: 'Add the mapper', status: 'in_progress' }],
    ]);
    expect(transcript.allEvents().filter(event => event.type === 'tool_call' && ['TaskCreate', 'TaskUpdate'].includes(String(event.data.toolName)))).toHaveLength(2);
    expect(transcript.allEvents().filter(event => event.type === 'tool_call_update' && ['TaskCreate', 'TaskUpdate'].includes(String(event.data.toolName)))).toHaveLength(2);

    appendFileSync(file, `${JSON.stringify(taskCall('update-2', 'TaskUpdate', { taskId: '7', status: 'completed' }))}\n`);
    appendFileSync(file, `${JSON.stringify(taskResult('update-2', 'Updated task #7 status', { success: true, taskId: '7', updatedFields: ['status'], statusChange: { from: 'in_progress', to: 'completed' } }))}\n`);
    const live = await transcript.refresh();
    expect(live.events.filter(event => event.type === 'plan').at(-1)?.data.entries)
      .toEqual([{ id: '7', content: 'Add the mapper', status: 'completed' }]);

    const reopened = new ClaudeTranscript(session, 'native-session');
    await reopened.setFile(file);
    expect(reopened.allEvents().filter(event => event.type === 'plan').at(-1)?.data.entries)
      .toEqual([{ id: '7', content: 'Add the mapper', status: 'completed' }]);
  });

  it('does not apply a failed or mismatched update or invent a row without its create', async () => {
    const transcript = new ClaudeTranscript(session, 'native-session');
    const file = transcriptFile([
      taskCall('create-1', 'TaskCreate', { subject: 'Keep the task' }),
      taskResult('create-1', 'Task #3 created successfully: Keep the task', { task: { id: '3', subject: 'Keep the task' } }),
      taskCall('failed-update', 'TaskUpdate', { taskId: '3', status: 'completed' }),
      taskResult('failed-update', 'Could not update task #3', { success: false, taskId: '3' }, true),
      taskCall('unknown-update', 'TaskUpdate', { taskId: '3', status: 'completed' }),
      taskResult('unknown-update', 'Task operation finished', { taskId: '3', updatedFields: ['status'] }),
      taskCall('mismatched-update', 'TaskUpdate', { taskId: '3', status: 'completed' }),
      taskResult('mismatched-update', 'Updated task #99 status', { success: true, taskId: '99', updatedFields: ['status'], statusChange: { from: 'pending', to: 'completed' } }),
      taskCall('orphan-update', 'TaskUpdate', { taskId: '99', status: 'completed' }),
      taskResult('orphan-update', 'Updated task #99 status', { success: true, taskId: '99', updatedFields: ['status'], statusChange: { from: 'pending', to: 'completed' } }),
    ]);
    await transcript.setFile(file);
    const plans = transcript.allEvents().filter(event => event.type === 'plan');
    expect(plans).toHaveLength(1);
    expect(plans[0]!.data.entries).toEqual([{ id: '3', content: 'Keep the task', status: 'pending' }]);
    expect(transcript.allEvents().find(event => event.type === 'tool_call_update' && event.data.toolCallId === 'failed-update')?.data.status).toBe('failed');
    expect(transcript.allEvents().find(event => event.type === 'tool_call_update' && event.data.toolCallId === 'unknown-update')?.data.status).toBe('completed');
    expect(transcript.allEvents().find(event => event.type === 'tool_call_update' && event.data.toolCallId === 'mismatched-update')?.data.status).toBe('completed');
  });

  it('does not attach a row-level task result to the wrong tool result in a batch', async () => {
    const transcript = new ClaudeTranscript(session, 'native-session');
    await transcript.setFile(transcriptFile([
      {
        type: 'assistant', uuid: 'a-batch', timestamp: '2026-10-04T05:00:01.000Z',
        message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'create-8', name: 'TaskCreate', input: { subject: 'First task' } },
          { type: 'tool_use', id: 'create-9', name: 'TaskCreate', input: { subject: 'Second task' } },
        ] },
      },
      {
        type: 'user', uuid: 'r-batch', timestamp: '2026-10-04T05:00:02.000Z',
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'create-8', content: 'Task #8 created successfully: First task' },
          { type: 'tool_result', tool_use_id: 'create-9', content: 'Task #9 created successfully: Second task' },
        ] },
        toolUseResult: { task: { id: '9', subject: 'Second task' } },
      },
    ]));
    const plans = transcript.allEvents().filter(event => event.type === 'plan');
    expect(plans.at(-1)?.data.entries).toEqual([
      { id: '8', content: 'First task', status: 'pending' },
      { id: '9', content: 'Second task', status: 'pending' },
    ]);
  });
});

describe('Claude readable thinking', () => {
  const envelope = (summary: unknown[], type = 'openai_responses_reasoning_item') => JSON.stringify({
    type, id: 'reasoning-1', encrypted_content: 'opaque-replay-state', summary,
  });

  it.each([
    ['empty envelope', envelope([]), ''],
    ['string summaries', envelope(['First thought', 'Second thought']), 'First thought\nSecond thought'],
    ['summary blocks', envelope([{ type: 'summary_text', text: 'Readable thought' }, { type: 'text', text: 'Not a summary' }]), 'Readable thought'],
    ['Responses reasoning', envelope([{ type: 'summary_text', text: 'Readable thought' }], 'reasoning'), 'Readable thought'],
    ['plain text', 'Considering encrypted_content', 'Considering encrypted_content'],
    ['ordinary JSON', '{"encrypted_content":"example","summary":[]}', '{"encrypted_content":"example","summary":[]}'],
    ['malformed JSON', '{"type":"openai_responses_reasoning_item"', '{"type":"openai_responses_reasoning_item"'],
  ])('projects %s consistently without changing provider usage', async (_name, thinking, expected) => {
    const transcript = new ClaudeTranscript(session, 'native-session');
    await transcript.setFile(transcriptFile([
      assistant({ id: 'msg_1', uuid: 'a1', at: '2026-10-04T05:00:01.000Z', outputTokens: 80, thinking,
        usage: { output_tokens: 80, output_tokens_details: { thinking_tokens: 60 } } }),
    ]));
    const thoughts = transcript.allEvents().filter(event => event.type === 'agent_thought_chunk');
    expect(thoughts.map(event => event.data)).toEqual(expected ? [{
      sessionUpdate: 'agent_thought_chunk', channel: 'thinking', content: { type: 'text', text: expected },
    }] : []);
    expect(transcript.measurements()).toMatchObject([{ text: expected, outputTokens: 80, reasoningTokens: 60 }]);
  });

  it('uses the same projection for live appends, reopened history, and child snapshots', async () => {
    const thought = assistant({ id: 'msg_1', uuid: 'a1', at: '2026-10-04T05:00:01.000Z', outputTokens: 80,
      content: [{ type: 'reasoning', text: envelope([{ type: 'summary_text', text: 'Readable thought' }]) }] });
    const file = subagentSession([], [{ agentId: 'child-1', meta: { toolUseId: 'tool-1' }, lines: [
      { ...thought, isSidechain: true, agentId: 'child-1' },
    ] }]);
    const transcript = new ClaudeTranscript(session, 'native-session');
    await transcript.setFile(file);
    appendFileSync(file, `${JSON.stringify(thought)}\n`);
    const live = await transcript.refresh();
    expect(live.events).toHaveLength(1);
    expect(live.events[0]?.data).toMatchObject({ channel: 'thinking', content: { text: 'Readable thought' } });
    const reopened = new ClaudeTranscript(session, 'native-session');
    await reopened.setFile(file);
    expect(reopened.allEvents()).toEqual(transcript.allEvents());
    expect(reopened.subagentFrames()[0]?.events[0]?.data).toEqual(live.events[0]?.data);
    appendFileSync(file, `${JSON.stringify(thought)}\n`);
    await transcript.refresh();
    appendFileSync(file, `${JSON.stringify({ ...thought, uuid: 'child-only', agentId: 'child-1', isSidechain: true })}\n`);
    await transcript.refresh();

    const toolCall = assistant({ id: 'tool-message', uuid: 'tool-call', at: '2026-10-04T05:00:02.000Z', outputTokens: 1,
      content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/tmp/example' } }] });
    const toolResult = { type: 'user', uuid: 'tool-result', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'read-1', content: 'first result' },
    ] } };
    appendFileSync(file, `${JSON.stringify(toolCall)}\n${JSON.stringify(toolResult)}\n`);
    const firstResult = await transcript.refresh();
    expect(firstResult.events.at(-1)?.data).toMatchObject({ toolName: 'Read' });
    appendFileSync(file, `${JSON.stringify(toolResult)}\n`);
    const repeatedResult = await transcript.refresh();
    expect(repeatedResult.events.at(-1)?.data).toMatchObject({ contextMissing: true });
    const changedResult = { ...toolResult, message: { ...toolResult.message, content: [
      { ...toolResult.message.content[0], content: 'updated result' },
    ] } };
    appendFileSync(file, `${JSON.stringify(changedResult)}\n`);
    await transcript.refresh();

    const emptyThought = { ...thought, message: { ...thought.message, content: [{ type: 'thinking', thinking: envelope([]) }] } };
    writeFileSync(file, `${JSON.stringify(emptyThought)}\n`);
    expect(await transcript.refresh()).toMatchObject({ reset: true, events: [] });
    expect(transcript.allEvents()).toEqual([]);
    expect(transcript.measurements()).toMatchObject([{ text: '', outputTokens: 80 }]);
  });
});

describe('Claude transcript measurements', () => {
  it('takes the exact provider token count and brackets the request with the record before it', async () => {
    const steps = await measure([
      user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: 'hello' }),
      assistant({ id: 'msg_1', uuid: 'a1', at: '2026-10-04T05:00:06.000Z', outputTokens: 413, text: 'hi there' }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ stepId: 'msg_1', outputTokens: 413, live: true });
    expect(steps[0]!.endedAt - steps[0]!.startedAt).toBe(6_000);
  });

  it('joins the content blocks of one response instead of counting the response once per block', async () => {
    const steps = await measure([
      user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: 'hello' }),
      assistant({ id: 'msg_1', uuid: 'a1', at: '2026-10-04T05:00:03.000Z', outputTokens: 434, thinking: 'let me think' }),
      assistant({ id: 'msg_1', uuid: 'a2', at: '2026-10-04T05:00:04.000Z', outputTokens: 434, text: 'the answer' }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.outputTokens).toBe(434);
    expect(steps[0]!.text).toContain('let me think');
    expect(steps[0]!.text).toContain('the answer');
    expect(steps[0]!.endedAt - steps[0]!.startedAt).toBe(4_000);
  });

  it('measures each response of a turn separately so tool time is excluded', async () => {
    const steps = await measure([
      user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: 'go' }),
      assistant({ id: 'msg_1', uuid: 'a1', at: '2026-10-04T05:00:02.000Z', outputTokens: 100, text: 'first' }),
      { type: 'user', uuid: 'u2', timestamp: '2026-10-04T05:00:20.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] } },
      assistant({ id: 'msg_2', uuid: 'a2', at: '2026-10-04T05:00:23.000Z', outputTokens: 200, text: 'second' }),
    ]);
    expect(steps.map(step => step.stepId)).toEqual(['msg_1', 'msg_2']);
    expect(steps[1]!.endedAt - steps[1]!.startedAt).toBe(3_000);
    // Only the response still at the end of the transcript is live.
    expect(steps.map(step => step.live)).toEqual([false, true]);
  });

  it('keeps the largest input and cache reading when one response is split, without subtracting cache from input', async () => {
    const steps = await measure([
      user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: 'hello' }),
      assistant({
        id: 'msg_1', uuid: 'a1', at: '2026-10-04T05:00:03.000Z', outputTokens: 10, model: 'claude-sonnet-4-5', text: 'partial',
        usage: { output_tokens: 10, input_tokens: 80, cache_creation_input_tokens: 5, cache_read_input_tokens: 10 },
      }),
      assistant({
        id: 'msg_1', uuid: 'a2', at: '2026-10-04T05:00:04.000Z', outputTokens: 50, model: 'claude-sonnet-4-5', text: 'done',
        usage: { output_tokens: 50, input_tokens: 100, cache_creation_input_tokens: 30, cache_read_input_tokens: 20 },
      }),
    ]);
    expect(steps[0]).toMatchObject({
      stepId: 'msg_1', model: 'claude-sonnet-4-5', inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 50,
    });
  });

  it('records a subagent total separately from the parent request that spawned it', async () => {
    const steps = await measure([
      user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: 'go' }),
      assistant({
        id: 'msg_parent', uuid: 'a1', at: '2026-10-04T05:00:02.000Z', outputTokens: 40,
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Agent', input: { subagent_type: 'Explore', prompt: 'look' } }],
        usage: { output_tokens: 40, input_tokens: 12 },
      }),
      {
        type: 'user', uuid: 'n1', timestamp: '2026-10-04T05:00:05.000Z',
        message: { role: 'user', content: [
          '<task-notification>',
          '<tool-use-id>tool-1</tool-use-id>',
          '<status>completed</status>',
          '<summary>Agent "look" finished</summary>',
          '<usage><subagent_tokens>900</subagent_tokens><duration_ms>3000</duration_ms></usage>',
          '</task-notification>',
        ].join('') },
      },
    ]);
    const parent = steps.find(step => step.stepId === 'msg_parent');
    const child = steps.find(step => step.stepId === 'subagent:tool-1');
    expect(parent).toMatchObject({ outputTokens: 40, inputTokens: 12, live: true });
    expect(child).toMatchObject({
      agentKind: 'subagent', subagentType: 'Explore', parentStepId: 'msg_parent', outputTokens: 900, live: false,
    });
    expect(child!.endedAt - child!.startedAt).toBe(3_000);
  });

  it('reports nothing for a response with no token count and no text', async () => {
    const steps = await measure([
      user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: 'hello' }),
      { type: 'assistant', uuid: 'a1', timestamp: '2026-10-04T05:00:02.000Z', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: '   ' }], usage: {} } },
    ]);
    expect(steps).toHaveLength(0);
  });

  it('reports nothing when the transcript gives no preceding record to start from', async () => {
    const steps = await measure([
      assistant({ id: 'msg_1', uuid: 'a1', at: '2026-10-04T05:00:02.000Z', outputTokens: 100, text: 'orphan' }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.endedAt).toBe(steps[0]!.startedAt);
  });
});

describe('Claude subagent transcripts', () => {
  const at = (seconds: number) => new Date(Date.parse('2026-10-04T05:00:00.000Z') + seconds * 1000).toISOString();

  async function open(file: string) {
    const transcript = new ClaudeTranscript(session, 'native-session');
    await transcript.setFile(file);
    return transcript;
  }

  it('opens the child its meta names as the tool call that spawned it', async () => {
    const file = subagentSession(
      [user({ uuid: 'u1', at: at(0), text: 'go' }), agentCall('tool-1', { description: 'Research Cline UI', prompt: 'Look at Cline', subagent_type: 'general-purpose' })],
      [{ agentId: 'child-1', meta: { toolUseId: 'tool-1', agentType: 'general-purpose', description: 'Research Cline UI', spawnDepth: 1 }, lines: [childRow('child-1', { type: 'user', uuid: 'cu1', text: 'Look at Cline', at: at(1) }), childRow('child-1', { type: 'assistant', uuid: 'ca1', text: 'Cline uses a chat transcript', at: at(2) })] }],
    );
    const transcript = await open(file);
    const call = transcript.allEvents().find(event => event.type === 'tool_call' && event.data.toolCallId === 'tool-1');
    expect(call?.data).toMatchObject({ kind: 'agent', title: 'Research Cline UI', subagent: { description: 'Research Cline UI', prompt: 'Look at Cline', type: 'general-purpose' } });

    const [frame] = transcript.subagentFrames();
    expect(frame).toMatchObject({ type: 'subagent', toolCallId: 'tool-1', agentId: 'child-1', subagentType: 'general-purpose', reset: true, running: false });
    expect(frame!.events.map(event => event.type)).toEqual(['user_message_chunk', 'agent_message_chunk']);
    expect(frame!.events.at(-1)!.data).toMatchObject({ content: { type: 'text', text: 'Cline uses a chat transcript' } });
    expect(frame!.history).toMatchObject({ generation: 'claude-sub:child-1', hasMore: false });
  });

  it('keeps sidechain rows out of the parent and reads them from the child', async () => {
    const file = subagentSession(
      [agentCall('tool-1', { description: 'Child', prompt: 'Do it' }, 'Task')],
      [{ agentId: 'child-1', meta: { toolUseId: 'tool-1', agentType: 'Explore', spawnDepth: 1 }, lines: [childRow('child-1', { type: 'assistant', uuid: 'ca1', text: 'child-only answer', at: at(2) })] }],
    );
    const transcript = await open(file);
    expect(transcript.allEvents().some(event => JSON.stringify(event.data).includes('child-only answer'))).toBe(false);
    expect(JSON.stringify(transcript.subagentFrames()[0]!.events)).toContain('child-only answer');
  });

  it('attaches a nested child to the agent transcript that spawned it', async () => {
    const nestedCall = agentCall('tool-2', { description: 'Nested', prompt: 'Go deeper', subagent_type: 'Explore' });
    const file = subagentSession(
      [agentCall('tool-1', { description: 'Parent agent', prompt: 'Coordinate' })],
      [
        { agentId: 'child-1', meta: { toolUseId: 'tool-1', agentType: 'general-purpose', description: 'Parent agent', spawnDepth: 1 }, lines: [childRow('child-1', { type: 'user', uuid: 'cu1', text: 'Coordinate', at: at(1) }), nestedCall] },
        { agentId: 'child-2', meta: { toolUseId: 'tool-2', agentType: 'Explore', description: 'Nested', parentAgentId: 'child-1', spawnDepth: 2 }, lines: [childRow('child-2', { type: 'assistant', uuid: 'ca2', text: 'nested answer', at: at(3) })] },
      ],
    );
    const transcript = await open(file);
    expect(transcript.subagentFrames().map(frame => frame.toolCallId).sort()).toEqual(['tool-1', 'tool-2']);
    const parentChild = transcript.subagentFrames().find(frame => frame.toolCallId === 'tool-1')!;
    const nested = parentChild.events.find(event => event.type === 'tool_call' && event.data.toolCallId === 'tool-2');
    expect(nested?.data).toMatchObject({ kind: 'agent', subagent: { description: 'Nested', type: 'Explore' } });
    const nestedChild = transcript.subagentFrames().find(frame => frame.toolCallId === 'tool-2')!;
    expect(nestedChild.agentId).toBe('child-2');
  });

  it('ignores a child whose meta names no tool call', async () => {
    const file = subagentSession(
      [agentCall('tool-1', { description: 'Known', prompt: 'x' })],
      [
        { agentId: 'child-1', meta: { toolUseId: 'tool-1', agentType: 'Explore', spawnDepth: 1 }, lines: [childRow('child-1', { type: 'assistant', uuid: 'ca1', text: 'one', at: at(2) })] },
        { agentId: 'child-2', meta: { agentType: 'Explore', description: 'Unlinked', spawnDepth: 1 }, lines: [childRow('child-2', { type: 'assistant', uuid: 'ca2', text: 'two', at: at(2) })] },
      ],
    );
    const transcript = await open(file);
    expect(transcript.subagentFrames().map(frame => frame.toolCallId)).toEqual(['tool-1']);
  });

  it('sends only what a child committed after the first snapshot', async () => {
    const file = subagentSession(
      [agentCall('tool-1', { description: 'Grow', prompt: 'x' })],
      [{ agentId: 'child-1', meta: { toolUseId: 'tool-1', agentType: 'Explore', spawnDepth: 1 }, lines: [childRow('child-1', { type: 'assistant', uuid: 'ca1', text: 'first', at: at(2) })] }],
    );
    const transcript = await open(file);
    expect(transcript.subagentFrames()[0]!.events).toHaveLength(1);
    appendFileSync(join(file.replace(/\.jsonl$/, ''), 'subagents', 'agent-child-1.jsonl'), JSON.stringify(childRow('child-1', { type: 'assistant', uuid: 'ca2', text: 'second', at: at(4) })) + '\n');
    const grown = await transcript.refresh();
    expect(grown.subagents).toHaveLength(1);
    expect(grown.subagents[0]).toMatchObject({ toolCallId: 'tool-1', reset: false, running: false });
    expect(grown.subagents[0]!.events.map(event => event.data.content)).toEqual([{ type: 'text', text: 'second' }]);
    expect(transcript.subagentFrames()[0]!.events).toHaveLength(2);
  });

  it('starts a woken child’s next round as its own live turn, and keeps a mid-work message in the round it joins', async () => {
    const wake = (uuid: string, text: string, time: string) => ({ ...childRow('child-1', { type: 'user', uuid, text, at: time }), isMeta: true, promptId: 'parent-prompt', origin: { kind: 'coordinator' } });
    const call = (uuid: string, time: string) => ({ ...childRow('child-1', { type: 'assistant', uuid, text: '', at: time }), message: { id: `m-${uuid}`, role: 'assistant', content: [{ type: 'tool_use', id: `t-${uuid}`, name: 'Bash', input: { command: 'ls' } }], stop_reason: 'tool_use' } });
    const file = subagentSession(
      [agentCall('tool-1', { description: 'Rounds', prompt: 'x' })],
      [{ agentId: 'child-1', meta: { toolUseId: 'tool-1', agentType: 'Explore', requestShape: 'background' }, lines: [
        { ...childRow('child-1', { type: 'user', uuid: 'cu1', text: 'first task', at: at(1) }), promptId: 'parent-prompt' },
        childRow('child-1', { type: 'assistant', uuid: 'ca1', text: 'first answer', at: at(2) }),
        wake('cw1', 'second task', at(3)),
        call('ca2', at(4)),
        wake('cw2', 'also check the tests', at(5)),
        call('ca3', at(6)),
      ] }],
    );
    const transcript = await open(file);
    const frame = transcript.subagentFrames()[0]!;
    const turns = [...new Set(frame.events.map(event => event.runId))];
    expect(turns).toEqual(['claude-turn:cu1', 'claude-turn:cw1']);
    expect(frame.events.some(event => event.nativeTurnId !== undefined)).toBe(false);
    expect(frame).toMatchObject({ running: true, activeTurnId: 'claude-turn:cw1' });
  });

  it('pages older child history from the snapshot cursor', async () => {
    const lines = Array.from({ length: 600 }, (_, index) => childRow('child-1', { type: 'assistant', uuid: `ca${index}`, text: `answer ${index}`, at: at(index + 2) }));
    const file = subagentSession(
      [agentCall('tool-1', { description: 'Long', prompt: 'x' })],
      [{ agentId: 'child-1', meta: { toolUseId: 'tool-1', agentType: 'Explore', spawnDepth: 1 }, lines }],
    );
    const transcript = await open(file);
    const [frame] = transcript.subagentFrames();
    // The opening snapshot is bounded — here by bytes, since 600 of these run past 96 KiB — so it
    // carries a tail rather than the whole child, and says where the rest continues.
    const windowStart = 600 - frame!.events.length;
    expect(frame!.events.length).toBeGreaterThan(0);
    expect(frame!.events.length).toBeLessThan(600);
    const windowBytes = frame!.events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0);
    expect(windowBytes).toBeLessThanOrEqual(96 * 1024);
    expect(frame!.history).toMatchObject({ hasMore: true });

    const page = transcript.subagentHistory('tool-1', frame!.history!.cursor!, frame!.history!.generation);
    expect(page.events).toHaveLength(100);
    expect(page.history.hasMore).toBe(windowStart > 100);
    expect(page.events[0]!.data).toMatchObject({ content: { type: 'text', text: `answer ${windowStart - 100}` } });
  });

  const toolUse = (uuid: string, at: string) => {
    const row = childRow('child-1', { type: 'assistant', uuid, text: '', at });
    return { ...row, message: { ...row.message, content: [{ type: 'tool_use', id: `tu-${uuid}`, name: 'Bash', input: { command: 'sleep 300' } }], stop_reason: 'tool_use' } };
  };

  it('reads a child the user stopped as finished even while it is fresh', async () => {
    const now = new Date().toISOString();
    const file = subagentSession(
      [agentCall('tool-1', { description: 'Stopped', prompt: 'x' })],
      [{ agentId: 'child-1', meta: { toolUseId: 'tool-1', agentType: 'Explore', description: 'Stopped', spawnDepth: 1, stoppedByUser: true }, lines: [toolUse('ca1', now)] }],
    );
    const transcript = await open(file);
    expect(transcript.subagentFrames()[0]!.running).toBe(false);
  });

  it('reports an unknown child as not ready instead of paging nothing', async () => {
    const file = subagentSession([agentCall('tool-1', { description: 'x', prompt: 'y' })], []);
    const transcript = await open(file);
    expect(() => transcript.subagentHistory('tool-9', 'cursor', 'claude-sub:child-9')).toThrowError(/not ready/);
  });

  it('keeps a child running through a long quiet tool call', async () => {
    vi.useFakeTimers();
    try {
      const file = subagentSession(
        [agentCall('tool-1', { description: 'Quiet', prompt: 'x' })],
        [{ agentId: 'child-1', meta: { toolUseId: 'tool-1', agentType: 'Explore', spawnDepth: 1 }, lines: [toolUse('ca1', new Date().toISOString())] }],
      );
      const transcript = await open(file);
      expect(transcript.subagentFrames()[0]!.running).toBe(true);
      vi.advanceTimersByTime(5 * 60_000);
      expect((await transcript.refresh()).subagents).toEqual([]);
      expect(transcript.subagentFrames()[0]!.running).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('says a child that owes a step is gone once it has been quiet past the stall window', async () => {
    vi.useFakeTimers();
    try {
      const file = subagentSession(
        [agentCall('tool-1', { description: 'Quiet', prompt: 'x' })],
        [{ agentId: 'child-1', meta: { toolUseId: 'tool-1', agentType: 'Explore', spawnDepth: 1 }, lines: [toolUse('ca1', new Date().toISOString())] }],
      );
      const transcript = await open(file);
      vi.advanceTimersByTime(10 * 60_000 + 1_000);
      const settled = await transcript.refresh();
      expect(settled.subagents).toHaveLength(1);
      expect(settled.subagents[0]).toMatchObject({ toolCallId: 'tool-1', reset: false, running: false });
      expect(settled.subagents[0]!.events).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('reads a child as finished as soon as it gives its final answer or is interrupted', async () => {
    const now = new Date().toISOString();
    const final = childRow('child-1', { type: 'assistant', uuid: 'ca2', text: 'done', at: now });
    const finished = await open(subagentSession(
      [agentCall('tool-1', { description: 'Done', prompt: 'x' })],
      [{ agentId: 'child-1', meta: { toolUseId: 'tool-1', agentType: 'Explore', spawnDepth: 1 }, lines: [toolUse('ca1', now), { ...final, message: { ...final.message, stop_reason: 'end_turn' } }] }],
    ));
    expect(finished.subagentFrames()[0]!.running).toBe(false);
    const interrupted = await open(subagentSession(
      [agentCall('tool-1', { description: 'Halted', prompt: 'x' })],
      [{ agentId: 'child-1', meta: { toolUseId: 'tool-1', agentType: 'Explore', spawnDepth: 1 }, lines: [toolUse('ca1', now), childRow('child-1', { type: 'user', uuid: 'cu1', text: '', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }], at: now })] }],
    ));
    expect(interrupted.subagentFrames()[0]!.running).toBe(false);
  });

  it('counts a background agent over once the main agent stopped it after a SendMessage resume, until it is resumed again', async () => {
    const now = new Date().toISOString();
    const use = (id: string, name: string, input: Record<string, unknown>) => ({
      type: 'assistant', uuid: `a-${id}`, timestamp: now, message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    });
    const returned = (id: string, toolUseResult: Record<string, unknown>) => ({
      type: 'user', uuid: `r-${id}`, timestamp: now, toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    });
    const killed = '<task-notification>\n<task-id>child-1</task-id>\n<tool-use-id>call_send</tool-use-id>\n<status>killed</status>\n<summary>stopped</summary>\n</task-notification>';
    const launch = [
      use('call_ag', 'Agent', { description: 'dig', prompt: 'x', run_in_background: true }),
      returned('call_ag', { isAsync: true, status: 'async_launched', agentId: 'child-1' }),
    ];
    const resume = [use('call_send', 'SendMessage', { to: 'child-1', message: 'again' }), returned('call_send', { resumedAgentId: 'child-1', revivedAgentId: 'child-1' })];
    const stop = [
      use('call_stop', 'TaskStop', { task_id: 'child-1' }),
      returned('call_stop', { message: 'Successfully stopped task: child-1 (dig)', task_id: 'child-1' }),
      { type: 'queue-operation', operation: 'enqueue', timestamp: now, content: killed },
    ];
    const child = { agentId: 'child-1', meta: { toolUseId: 'call_ag', agentType: 'Explore', requestShape: 'background' }, lines: [
      childRow('child-1', { type: 'user', uuid: 'cu1', text: 'go', at: now }),
      { ...childRow('child-1', { type: 'assistant', uuid: 'ca1', text: '', at: now }), message: { id: 'm-ca1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], stop_reason: 'tool_use' } },
    ] };
    const resumed = await open(subagentSession([...launch, ...resume], [child]));
    expect(resumed.backgroundAgents().map(agent => agent.agentId)).toEqual(['child-1']);
    const stopped = await open(subagentSession([...launch, ...resume, ...stop], [child]));
    expect(stopped.backgroundAgents()).toEqual([]);
    expect(stopped.subagentFrames()[0]!.running).toBe(false);
    // A later resume is a new execution: the earlier stop does not end it.
    const again = [use('call_send2', 'SendMessage', { to: 'child-1', message: 'once more' }), returned('call_send2', { resumedAgentId: 'child-1' })];
    const relaunched = await open(subagentSession([...launch, ...resume, ...stop, ...again], [child]));
    expect(relaunched.backgroundAgents().map(agent => agent.agentId)).toEqual(['child-1']);
  });
});

describe('Claude subagent notifications', () => {
  const noticeRow = (content: string, uuid = 'n1') => ({
    type: 'user', uuid, timestamp: '2026-10-04T05:00:05.000Z', isSidechain: false,
    promptId: 'notify', queueSkipAttachments: true, message: { role: 'user', content },
  });
  const notice = (fields: { taskId?: string; toolUseId?: string; status?: string; summary?: string; note?: string; result?: string; tokens?: number; durationMs?: number } = {}) => [
    '<task-notification>',
    `<task-id>${fields.taskId ?? 'a9f4ad73eb6bcb9f6'}</task-id>`,
    `<tool-use-id>${fields.toolUseId ?? 'tool-1'}</tool-use-id>`,
    '<output-file>/private/tmp/claude-501/-repo/tasks/a9f4ad73eb6bcb9f6.output</output-file>',
    `<status>${fields.status ?? 'completed'}</status>`,
    `<summary>${fields.summary ?? 'Agent “生成随机成语” finished'}</summary>`,
    `<note>${fields.note ?? 'A task-notification fires each time this agent stops with no live background children.'}</note>`,
    `<result>${fields.result ?? '成语：抛砖引玉\n含义：用自己粗浅意见引出他人高见。'}</result>`,
    `<usage><subagent_tokens>${fields.tokens ?? 26169}</subagent_tokens><tool_uses>0</tool_uses><duration_ms>${fields.durationMs ?? 4370}</duration_ms></usage>`,
    '</task-notification>',
  ].join('\n');

  async function open(lines: unknown[]) {
    const transcript = new ClaudeTranscript(session, 'native-session');
    await transcript.setFile(transcriptFile(lines));
    return transcript;
  }

  it('renders a subagent completion as a notice rather than a user turn', async () => {
    const transcript = await open([
      user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: '我需要测试你的能力，其两个 subagent 生成随机成语' }),
      noticeRow(notice()),
      assistant({ id: 'msg_1', uuid: 'a1', at: '2026-10-04T05:00:06.000Z', outputTokens: 20, text: '两个 subagent 都完成了。' }),
    ]);
    const events = transcript.allEvents();
    expect(events.filter((event) => event.type === 'user_message_chunk').map((event) => event.data.content)).toEqual([
      { type: 'text', text: '我需要测试你的能力，其两个 subagent 生成随机成语' },
    ]);
    const row = events.find((event) => event.type === 'task_notification')!;
    expect(row.data).toMatchObject({
      sessionUpdate: 'task_notification', kind: 'subagent', status: 'completed', sourceStatus: 'completed',
      title: '生成随机成语', taskId: 'a9f4ad73eb6bcb9f6', subagentToolCallId: 'tool-1',
      detail: '成语：抛砖引玉\n含义：用自己粗浅意见引出他人高见。', tokens: 26169, durationMs: 4370,
    });
    // The CLI's own explanation of the notification protocol is internal, not part of the notice.
    expect(JSON.stringify(row.data)).not.toContain('task-notification fires');
    // The notice opens the reply that answered it, so the turn reads as triggered rather than orphaned.
    expect(events.find((event) => event.type === 'agent_message_chunk')?.runId).toBe(row.runId);
    expect(transcript.measurements().find(step => step.stepId === 'msg_1')).toMatchObject({ nativeMessageId: row.nativeId });
    expect(transcript.measurements().find(step => step.stepId === 'msg_1')?.commandId).toBeUndefined();
  });

  it('keeps a prompt that quotes the same tag as an ordinary user turn', async () => {
    const transcript = await open([
      user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: 'Please inspect this literal tag: <task-notification>oops</task-notification>' }),
    ]);
    expect(transcript.allEvents().map((event) => event.type)).toEqual(['user_message_chunk']);
  });

  it('keeps a hand-back receipt out of a task report without dropping real output', async () => {
    const taskId = 'a9f4ad73eb6bcb9f6';
    const receipt = `This agent's report was delivered to you as a message from "${taskId}" (its SubagentHandback call). Read it there; it is not repeated here.`;
    const output = `${receipt}\n\nThe actual report follows: the native clients share the same failure.`;
    const transcript = await open([
      noticeRow(notice({ result: receipt })),
      { ...noticeRow(notice({ toolUseId: 'tool-2', result: output })), uuid: 'notice-with-report' },
    ]);
    const reports = transcript.allEvents().filter(event => event.type === 'task_notification');
    expect(reports[0]?.data).toMatchObject({ status: 'completed', taskId, subagentToolCallId: 'tool-1' });
    expect(reports[0]?.data.detail).toBeUndefined();
    expect(reports[1]?.data.detail).toBe(output);
  });

  it('keeps a transcript-only completion on its existing turn and preserves response attribution', async () => {
    const transcript = await open([
      user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: 'finish the work' }),
      assistant({ id: 'msg_1', uuid: 'a1', at: '2026-10-04T05:00:04.000Z', outputTokens: 20, text: 'done' }),
      { ...noticeRow(notice()), queueTranscriptOnly: true, origin: { kind: 'task-notification', producer: 'session-task' } },
      assistant({ id: 'msg_2', uuid: 'a2', at: '2026-10-04T05:00:06.000Z', outputTokens: 10, text: 'same turn' }),
    ]);
    const events = transcript.allEvents();
    const prompt = events.find(event => event.type === 'user_message_chunk')!;
    const report = events.find(event => event.type === 'task_notification')!;
    expect(report.runId).toBe(prompt.runId);
    expect(report.data).toMatchObject({ status: 'completed', subagentToolCallId: 'tool-1' });
    expect(transcript.measurements().find(step => step.stepId === 'msg_2')).toMatchObject({ nativeMessageId: prompt.nativeId });
  });

  it('keeps a notification the CLI changed shape for, as a readable notice', async () => {
    const transcript = await open([noticeRow('<task-notification>The CLI changed format\nwithout any fields')]);
    const [row] = transcript.allEvents();
    expect(row!.type).toBe('task_notification');
    expect(row!.data).toMatchObject({ kind: 'subagent', status: 'unknown', title: '子 Agent' });
  });

  it('maps a failed status and decodes the escaped answer', async () => {
    const transcript = await open([noticeRow(notice({ status: 'failed', summary: 'Agent “查错” failed: stalled', result: 'look at &lt;div&gt; &amp; retry' }))]);
    const [row] = transcript.allEvents();
    expect(row!.data).toMatchObject({ status: 'failed', sourceStatus: 'failed', title: '查错', detail: 'look at <div> & retry' });
  });
});

/**
 * `ExitPlanMode` is Claude Code asking the reader to approve a plan, and the plan is the whole of
 * what it says. It used to be projected as a `plan` event carrying `content`, which no client reads:
 * that channel is the todo dock, whose readers want `entries`, so the body was dropped on arrival
 * and the only trace of a plan was a bare "Review plan" row. It is a tool call carrying its own
 * Markdown instead — the same shape Cursor's `CreatePlan` uses, so one renderer serves both.
 */
describe('Claude plan review', () => {
  const planBody = '## Relay web redesign\n\n1. Split the stylesheet into tokens and layout.\n2. Rebuild the three pages.';

  it('keeps the plan body on the tool call instead of losing it to the todo channel', async () => {
    const file = transcriptFile([
      user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: 'plan the redesign' }),
      {
        type: 'assistant', uuid: 'a1', timestamp: '2026-10-04T05:00:01.000Z',
        message: { id: 'msg-1', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'plan-1', name: 'ExitPlanMode', input: { plan: planBody } }] },
      },
    ]);
    const transcript = new ClaudeTranscript(session, 'native-session');
    await transcript.setFile(file);

    // No `plan` event: a todo snapshot is the only thing that channel's readers project.
    expect(transcript.allEvents().filter(event => event.type === 'plan')).toEqual([]);
    const call = transcript.allEvents().find(event => event.data.toolName === 'ExitPlanMode');
    expect(call).toMatchObject({ type: 'tool_call', data: { kind: 'plan', title: 'Review plan', content: [{ type: 'markdown', text: planBody }] } });
  });

  it('still describes a plan call that arrives without a body', async () => {
    const file = transcriptFile([
      user({ uuid: 'u1', at: '2026-10-04T05:00:00.000Z', text: 'plan it' }),
      {
        type: 'assistant', uuid: 'a1', timestamp: '2026-10-04T05:00:01.000Z',
        message: { id: 'msg-1', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'plan-1', name: 'ExitPlanMode', input: {} }] },
      },
    ]);
    const transcript = new ClaudeTranscript(session, 'native-session');
    await transcript.setFile(file);
    const call = transcript.allEvents().find(event => event.data.toolName === 'ExitPlanMode');
    expect(call?.data).toMatchObject({ kind: 'plan', title: 'Review plan' });
    expect(call?.data.content).toBeUndefined();
  });
});

describe('Claude native hook guidance projection', () => {
  const receiptRow = (attachment: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    type: 'attachment', uuid: 'context-uuid', timestamp: '2026-10-16T01:00:02.000Z', attachment, ...extra,
  });
  const attachment = { type: 'hook_additional_context', content: ['bounded native context'], hookEvent: 'PostToolUse', hookName: 'PostToolUse:Bash', toolUseID: 'tool-1' };

  it('replays exact turn outcomes without hooks and never turns an interruption into success', async () => {
    const prompt = (id: string) => ({ ...user({ uuid: `user-${id}`, at: '2026-10-16T01:00:00Z', text: 'work' }), promptId: id, origin: { kind: 'human' } });
    const duration = { type: 'system', subtype: 'turn_duration', timestamp: '2026-10-16T01:00:02Z' };
    const summary = { type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-10-16T01:00:02Z' };
    const file = transcriptFile([
      // 2.1.302 writes the summary of a turn's Stop hooks right before its duration.
      prompt('finished'), summary, duration,
      prompt('stopped'),
      { ...user({ uuid: 'interrupted', at: '2026-10-16T01:00:01Z', text: '[Request interrupted by user]' }), promptId: 'stopped' },
      duration,
      prompt('current'),
      // An old interruption cannot close the current task.
      { ...user({ uuid: 'old-interruption', at: '2026-10-16T01:00:01Z', text: '[Request interrupted by user]' }), promptId: 'stopped' },
    ]);
    const read = async () => {
      const transcript = new ClaudeTranscript({ ...session, nativeSessionId: 'native-session' }, 'native-session');
      await transcript.setFile(file);
      return transcript.allEvents().filter(event => ['run_completed', 'run_cancelled'].includes(event.type));
    };
    const first = await read();
    expect(first.map(event => [event.type, event.nativeTurnId, event.data.nativeSessionId])).toEqual([
      ['run_completed', 'finished', 'native-session'], ['run_cancelled', 'stopped', 'native-session'],
    ]);
    expect(await read()).toEqual(first);
    // Dispatch observers must recover an old result even after it leaves the browser's tail.
    appendFileSync(file, Array.from({ length: 501 }, (_, index) => JSON.stringify(assistant({
      id: `m-${index}`, uuid: `a-${index}`, at: '2026-10-16T01:00:03Z', outputTokens: 1, text: 'continuing',
    }))).join('\n') + '\n');
    const restored = new ClaudeTranscript({ ...session, nativeSessionId: 'native-session' }, 'native-session');
    await restored.setFile(file);
    expect(restored.allEvents().filter(event => ['run_completed', 'run_cancelled'].includes(event.type))).toEqual(first);
  });

  it('only offers a main-thread native additional-context attachment as receipt evidence', async () => {
    const read = vi.fn(() => []);
    const transcript = new ClaudeTranscript(session, 'native-session', { additionalContext: read });
    await transcript.setFile(transcriptFile([
      receiptRow({ ...attachment, type: 'hook_success' }),
      receiptRow({ ...attachment, hookEvent: 'PreToolUse' }),
      receiptRow({ ...attachment, toolUseID: undefined }),
      receiptRow(attachment, { isSidechain: true }),
      receiptRow(attachment, { agentId: 'subagent' }),
      user({ uuid: 'user', at: '2026-10-16T01:00:00Z', text: 'bounded native context' }),
      receiptRow(attachment),
    ]));
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith('bounded native context', 'claude:session:context-uuid:hook-context', '2026-10-16T01:00:02.000Z');
  });

  it('keeps the original prompt identity around native context and later assistant output', async () => {
    const prompt = { ...user({ uuid: 'u1', at: '2026-10-16T01:00:00Z', text: 'original task' }), promptId: 'real-prompt-id' };
    const file = transcriptFile([prompt, receiptRow(attachment), assistant({ id: 'm1', uuid: 'a1', at: '2026-10-16T01:00:03Z', outputTokens: 3, text: 'final answer' })]);
    const read = vi.fn(() => [{
      sequence: 0, sessionId: session.id, runId: 'steer-run', nativeTurnId: 'real-prompt-id', nativeId: 'steer-receipt',
      type: 'native_input_receipt', createdAt: '2026-10-16T01:00:02Z', data: { commandId: 'steer-command', content: { type: 'text', text: 'guidance' } },
    }]);
    const transcript = new ClaudeTranscript(session, 'native-session', { additionalContext: read });
    await transcript.setFile(file);
    const events = transcript.allEvents();
    expect(events.filter(event => event.type === 'user_message_chunk')).toHaveLength(1);
    expect(events.filter(event => event.type === 'native_input_receipt')).toHaveLength(1);
    expect(events.filter(event => ['user_message_chunk', 'agent_message_chunk'].includes(event.type))).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'claude-turn:u1', nativeTurnId: 'real-prompt-id', type: 'user_message_chunk' }),
      expect.objectContaining({ runId: 'claude-turn:u1', nativeTurnId: 'real-prompt-id', type: 'agent_message_chunk' }),
    ]));
    appendFileSync(file, JSON.stringify(assistant({ id: 'm2', uuid: 'a2', at: '2026-10-16T01:00:04Z', outputTokens: 1, text: 'later' })) + '\n');
    await transcript.refresh();
    expect(transcript.allEvents().filter(event => event.type === 'native_input_receipt')).toHaveLength(1);
    // An append maps only its new rows: the receipt row is not asked about again.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps a hidden peer wake and its guidance on their own execution turn through live and cold reads', async () => {
    const prompt = { ...user({ uuid: 'human', at: '2026-10-16T01:00:00Z', text: 'original task' }), promptId: 'human-prompt', origin: { kind: 'human' } };
    const file = transcriptFile([
      prompt,
      assistant({ id: 'human-answer', uuid: 'human-answer', at: '2026-10-16T01:00:01Z', outputTokens: 3, text: 'done' }),
      { type: 'system', subtype: 'turn_duration', uuid: 'human-end', timestamp: '2026-10-16T01:00:02Z' },
    ]);
    const hooks = {
      commandForUserMessage: vi.fn((_message: { uuid: string }) => 'human-command'),
      additionalContext: () => [{
        sequence: 0, sessionId: session.id, runId: 'steer-run', nativeTurnId: 'peer-prompt', nativeId: 'steer-receipt',
        type: 'native_input_receipt', createdAt: '2026-10-16T01:00:05Z', data: { commandId: 'steer-command', content: { type: 'text', text: 'guidance' } },
      }],
    };
    const transcript = new ClaudeTranscript(session, 'native-session', hooks);
    await transcript.setFile(file);
    await transcript.refresh();
    const peer = { ...user({ uuid: 'peer', at: '2026-10-16T01:00:03Z', text: 'Another session reported back' }), promptId: 'peer-prompt', isMeta: true, origin: { kind: 'peer' } };
    const later = [
      peer,
      assistant({ id: 'peer-first', uuid: 'peer-first', at: '2026-10-16T01:00:04Z', outputTokens: 4, text: 'continuing' }),
      receiptRow(attachment),
      { ...peer, uuid: 'same-peer' },
      assistant({ id: 'peer-tool', uuid: 'peer-tool', at: '2026-10-16T01:00:06Z', outputTokens: 4, content: [{ type: 'tool_use', id: 'peer-call', name: 'Bash', input: { command: 'pwd' } }] }),
      { type: 'user', uuid: 'peer-result', timestamp: '2026-10-16T01:00:07Z', promptId: 'peer-prompt', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'peer-call', content: 'ok' }] } },
      assistant({ id: 'peer-later', uuid: 'peer-later', at: '2026-10-16T01:00:08Z', outputTokens: 4, text: 'still working' }),
    ];
    appendFileSync(file, later.map(row => JSON.stringify(row)).join('\n') + '\n');
    const live = await transcript.refresh();
    expect(live.lifecycle.signals).toContainEqual(expect.objectContaining({ type: 'prompt', promptId: 'peer-prompt', origin: 'peer' }));
    const events = transcript.allEvents();
    const output = events.filter(event => ['agent_message_chunk', 'tool_call', 'tool_call_update'].includes(event.type) && event.createdAt >= '2026-10-16T01:00:03Z');
    expect(output).toHaveLength(4);
    expect(output.every(event => event.runId === 'claude-turn:peer' && event.nativeTurnId === 'peer-prompt')).toBe(true);
    expect(events.filter(event => event.type === 'user_message_chunk')).toHaveLength(1);
    expect(events.filter(event => event.type === 'native_input_receipt')).toHaveLength(1);
    expect(events.filter(event => event.type === 'run_completed').map(event => event.nativeTurnId)).toEqual(['human-prompt']);
    const steps = transcript.measurements();
    expect(steps.find(step => step.stepId === 'human-answer')).toMatchObject({ commandId: 'human-command' });
    const peerSteps = steps.filter(step => step.stepId.startsWith('peer-'));
    expect(peerSteps).toHaveLength(3);
    expect(peerSteps.every(step => step.runId === 'claude-turn:peer' && step.commandId === undefined && step.nativeMessageId === undefined)).toBe(true);
    expect((await transcript.refresh()).events).toEqual([]);
    const restored = new ClaudeTranscript(session, 'native-session', hooks);
    await restored.setFile(file);
    expect(restored.allEvents()).toEqual(events);
    expect(restored.measurements()).toEqual(steps);
    expect(hooks.commandForUserMessage.mock.calls.every(([message]) => message.uuid === 'human')).toBe(true);
  });

  it('keeps both tool identities with the call when a hidden peer prompt arrives before its result', async () => {
    const file = transcriptFile([
      { ...user({ uuid: 'human', at: '2026-10-16T01:00:00Z', text: 'task' }), promptId: 'human-prompt' },
      { ...agentCall('old-call', {}), timestamp: '2026-10-16T01:00:01Z' },
      { ...user({ uuid: 'peer', at: '2026-10-16T01:00:03Z', text: 'report' }), promptId: 'peer-prompt', isMeta: true, origin: { kind: 'peer' } },
      { type: 'user', uuid: 'old-result', timestamp: '2026-10-16T01:00:04Z', promptId: 'peer-prompt', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old-call', content: 'ok' }] } },
      assistant({ id: 'new-answer', uuid: 'new-answer', at: '2026-10-16T01:00:05Z', outputTokens: 2, text: 'continuing' }),
    ]);
    const transcript = new ClaudeTranscript(session, 'native-session');
    await transcript.setFile(file);
    expect(transcript.allEvents().find(event => event.type === 'tool_call_update')).toMatchObject({ runId: 'claude-turn:human', nativeTurnId: 'human-prompt' });
    expect(transcript.allEvents().find(event => event.type === 'agent_message_chunk')).toMatchObject({ runId: 'claude-turn:peer', nativeTurnId: 'peer-prompt' });
  });

  it('reports a native interruption against the prompt it names, and each row once', async () => {
    const transcript = new ClaudeTranscript(session, 'native-session');
    const file = transcriptFile([
      { ...user({ uuid: 'u1', at: '2026-10-16T01:00:00Z', text: 'task' }), promptId: 'prompt-1' },
      { ...user({ uuid: 'cancel', at: '2026-10-16T01:00:01Z', text: '[Request interrupted by user for tool use]' }), promptId: 'prompt-1' },
    ]);
    await transcript.setFile(file);
    const first = await transcript.refresh();
    expect(first.lifecycle.replay).toBe(true);
    expect(first.lifecycle.signals.filter(signal => signal.type === 'turn_end')).toEqual([{ type: 'turn_end', source: 'transcript', reason: 'interrupted', promptId: 'prompt-1' }]);
    // The marker ends the turn but is not a message: nobody sent it, and the run reports the stop.
    expect(transcript.allEvents().filter(event => event.type === 'user_message_chunk').map(event => (event.data.content as { text: string }).text)).toEqual(['task']);
    appendFileSync(file, JSON.stringify({ ...user({ uuid: 'u2', at: '2026-10-16T01:00:02Z', text: 'next task' }), promptId: 'prompt-2' }) + '\n');
    const next = await transcript.refresh();
    expect(next.lifecycle.replay).toBe(false);
    expect(next.lifecycle.signals.filter(signal => signal.type === 'turn_end')).toEqual([]);
  });
});

/** Rows as Claude Code 2.1.302 writes them (see docs/SESSION-JOURNAL.md, 系统活动). */
describe('Claude system activities', () => {
  const at = (second: number) => `2026-10-19T05:00:${String(second).padStart(2, '0')}.000Z`;
  const row = (fields: Record<string, unknown>) => ({ isSidechain: false, ...fields });
  const text = (uuid: string, second: number, content: string, fields: Record<string, unknown> = {}) => row({ type: 'user', uuid, timestamp: at(second), message: { role: 'user', content }, ...fields });
  const activitiesOf = (transcript: ClaudeTranscript) => transcript.allEvents().flatMap(event => event.data.sessionUpdate === 'activity' ? [event.data.activity as import('../../../../../packages/contracts/src/index.js').NativeActivity] : []);
  async function open(lines: unknown[], hooks: ConstructorParameters<typeof ClaudeTranscript>[2] = {}) {
    const transcript = new ClaudeTranscript(session, 'native-session', hooks);
    await transcript.setFile(transcriptFile(lines));
    return transcript;
  }

  it('turns /compact into one user bubble and one compaction, keeping its summary and output out of the conversation', async () => {
    const stored: string[] = [];
    const summary = `This session is being continued from a previous conversation.\n\n${'detail '.repeat(600)}`;
    const transcript = await open([
      text('u1', 1, '/compact', { promptId: 'p1' }),
      row({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', timestamp: at(7), content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 36965, postTokens: 1778, durationMs: 6000 } }),
      text('u2', 7, summary, { promptId: 'p1', isCompactSummary: true, isVisibleInTranscriptOnly: true }),
      text('u3', 1, '<local-command-caveat>Caveat: do not respond</local-command-caveat>', { promptId: 'p1', isMeta: true }),
      text('u4', 1, '<command-name>/compact</command-name>\n <command-message>compact</command-message>\n <command-args></command-args>', { promptId: 'p9' }),
      text('u5', 8, '<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>', { promptId: 'p1' }),
    ], { putBlob: value => { stored.push(value); return `blob-${stored.length}`; } });
    const events = transcript.allEvents();
    expect(events.filter(event => event.type === 'user_message_chunk').map(event => (event.data.content as { text: string }).text)).toEqual(['/compact']);
    const states = activitiesOf(transcript);
    expect(new Set(states.map(state => state.id)).size).toBe(1);
    expect(states.map(state => state.status)).toEqual(['running', 'completed', 'completed']);
    expect(states.at(-1)).toMatchObject({
      kind: 'compaction', compaction: { trigger: 'manual', preTokens: 36965, postTokens: 1778 }, durationMs: 6000, endedAt: at(7), blobRef: 'blob-1',
    });
    expect(states.at(-1)!.detail!.length).toBeLessThanOrEqual(2048);
    expect(stored).toEqual([summary.trim()]);
    expect(JSON.stringify(events.filter(event => event.data.sessionUpdate !== 'activity'))).not.toMatch(/local-command|Compacted|continued from a previous/);
  });

  it('maps background shells, monitors and agents from their launch results and reports, and counts what still runs', async () => {
    const call = (id: string, name: string, input: Record<string, unknown>) => row({ type: 'assistant', uuid: `a-${id}`, timestamp: at(2), message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    const result = (id: string, uuid: string, toolUseResult: Record<string, unknown>, output = 'ok') => row({ type: 'user', uuid, timestamp: at(3), toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] } });
    const output = '/private/tmp/claude-501/-repo/sess/tasks/bshell1.output';
    const notice = (fields: string) => `<task-notification>\n${fields}\n</task-notification>`;
    const transcript = await open([
      text('u0', 1, 'go', { origin: { kind: 'human' } }),
      call('call_sh', 'Bash', { command: 'make test', description: 'run tests', run_in_background: true }),
      result('call_sh', 'r1', { backgroundTaskId: 'bshell1' }, `Command running in background with ID: bshell1. Output is being written to: ${output}. You will be notified`),
      call('call_mon', 'Monitor', { command: 'tail -f log', description: 'watch log' }),
      result('call_mon', 'r2', { taskId: 'bmon1', timeoutMs: 60000 }),
      call('call_ag', 'Agent', { description: 'dig', prompt: 'x', run_in_background: true }),
      result('call_ag', 'r3', { isAsync: true, status: 'async_launched', agentId: 'agent1' }),
      // The CLI queues a report before any row exists for it; the row, when it comes, is the same report.
      row({ type: 'queue-operation', operation: 'enqueue', timestamp: at(4), content: notice('<task-id>bmon1</task-id>\n<summary>Monitor event: "watch log"</summary>\n<event>line 1</event>') }),
      text('n1', 4, notice('<task-id>bmon1</task-id>\n<summary>Monitor event: "watch log"</summary>\n<event>line 1</event>'), { origin: { kind: 'task-notification' } }),
      row({ type: 'queue-operation', operation: 'enqueue', timestamp: at(5), content: notice('<task-id>bmon1</task-id>\n<summary>Monitor event: "watch log"</summary>\n<event>line 2</event>') }),
      row({ type: 'queue-operation', operation: 'remove', timestamp: at(5), content: notice('<task-id>bmon1</task-id>\n<summary>Monitor event: "watch log"</summary>\n<event>line 2</event>') }),
      text('n2', 6, notice(`<task-id>bshell1</task-id>\n<tool-use-id>call_sh</tool-use-id>\n<output-file>${output}</output-file>\n<status>failed</status>\n<summary>Background command "run tests" failed with exit code 2</summary>`), { origin: { kind: 'task-notification' } }),
      // A stop is reported only in the queue.
      row({ type: 'queue-operation', operation: 'enqueue', timestamp: at(8), content: notice('<task-id>bmon1</task-id>\n<tool-use-id>call_mon</tool-use-id>\n<status>killed</status>\n<summary>Task "watch log" was stopped by the user</summary>') }),
    ]);
    const states = activitiesOf(transcript);
    const latest = (id: string) => states.filter(state => state.id === `claude:${id}`).at(-1)!;
    expect(latest('bshell1')).toMatchObject({ status: 'failed', title: 'run tests', toolCallId: 'call_sh', stop: { via: 'session' }, task: { kind: 'shell', command: 'make test', exitCode: 2 } });
    expect(latest('bmon1')).toMatchObject({ status: 'stopped', toolCallId: 'call_mon', task: { kind: 'monitor' } });
    expect(latest('agent1')).toMatchObject({ status: 'running', task: { kind: 'agent' }, toolCallId: 'call_ag' });
    // Each Monitor event is one more state of the same activity, counted once even though it was queued and then shown.
    expect(states.filter(state => state.id === 'claude:bmon1').map(state => state.detail)).toEqual([undefined, 'line 1', 'line 1\nline 2', 'line 1\nline 2']);
    expect(transcript.activities().filter(state => state.status === 'running').map(state => state.id)).toEqual(['claude:agent1']);
    expect(transcript.backgroundAgents().map(task => `${task.kind}:${task.toolUseId}`)).toEqual(['agent:call_ag']);
    const kinds = transcript.allEvents().filter(event => event.type === 'task_notification').map(event => event.data.kind);
    expect(kinds).toEqual(['monitor', 'shell']);
  });

  it('hangs a Monitor whose first event is queued before its launch result on the call that launched it', async () => {
    const notice = '<task-notification>\n<task-id>bmon1</task-id>\n<summary>Monitor event: "ticker"</summary>\n<event>tick1</event>\n</task-notification>';
    const transcript = await open([
      text('u0', 1, 'go', { origin: { kind: 'human' } }),
      row({ type: 'assistant', uuid: 'a1', timestamp: at(2), message: { id: 'm1', role: 'assistant', content: [
        { type: 'tool_use', id: 'call_other', name: 'Monitor', input: { command: 'tail -f b', description: 'other' } },
        { type: 'tool_use', id: 'call_mon', name: 'Monitor', input: { command: 'tail -f a', description: 'ticker' } },
      ] } }),
      row({ type: 'queue-operation', operation: 'enqueue', timestamp: at(3), content: notice }),
      row({ type: 'user', uuid: 'r1', timestamp: at(4), toolUseResult: { taskId: 'bmon1', timeoutMs: 60000 }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_mon', content: 'Monitor started' }] } }),
    ]);
    const states = activitiesOf(transcript).filter(state => state.id === 'claude:bmon1');
    expect(states.map(state => state.toolCallId)).toEqual(['call_mon', 'call_mon']);
  });

  it('ends a task its TaskStop returned for, which no report follows', async () => {
    const transcript = await open([
      text('u0', 1, 'go', { origin: { kind: 'human' } }),
      row({ type: 'assistant', uuid: 'a1', timestamp: at(2), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'call_sh', name: 'Bash', input: { command: 'make', run_in_background: true } }] } }),
      row({ type: 'user', uuid: 'r1', timestamp: at(3), toolUseResult: { backgroundTaskId: 'bshell1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_sh', content: 'Command running in background with ID: bshell1.' }] } }),
      row({ type: 'assistant', uuid: 'a2', timestamp: at(4), message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 'call_stop', name: 'TaskStop', input: { task_id: 'bshell1' } }] } }),
      row({ type: 'user', uuid: 'r2', timestamp: at(5), toolUseResult: { message: 'Successfully stopped task: bshell1 (make)', task_id: 'bshell1', task_type: 'local_bash' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_stop', content: '{"message":"Successfully stopped task: bshell1 (make)","task_id":"bshell1"}' }] } }),
    ]);
    expect(activitiesOf(transcript).filter(state => state.id === 'claude:bshell1').at(-1)).toMatchObject({ status: 'stopped', endedAt: at(5) });
    expect(transcript.backgroundAgents()).toEqual([]);
  });

  it('maps a workflow, an automatic compaction and a local command’s output', async () => {
    const notice = (fields: string) => `<task-notification>\n${fields}\n</task-notification>`;
    const transcript = await open([
      row({ type: 'assistant', uuid: 'a1', timestamp: at(1), message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'call_wf', name: 'Workflow', input: { script: 'export const meta = {}' } }] } }),
      row({ type: 'user', uuid: 'r1', timestamp: at(2), toolUseResult: { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow', workflowName: 'review-changes' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_wf', content: 'Workflow launched in background. Task ID: wf1' }] } }),
      text('n1', 3, notice('<task-id>wf1</task-id>\n<tool-use-id>call_wf</tool-use-id>\n<status>completed</status>\n<summary>Dynamic workflow "review-changes" completed</summary>\n<result>all clear</result>'), { origin: { kind: 'task-notification' } }),
      row({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', timestamp: at(30), compactMetadata: { trigger: 'auto', preTokens: 250000, postTokens: 14000, durationMs: 20000 } }),
      text('u1', 31, '<command-name>/cost</command-name>\n <command-message>cost</command-message>\n <command-args></command-args>', { promptId: 'p2' }),
      text('u2', 31, '<local-command-stdout>\u001b[1mTotal cost:\u001b[22m $0.12</local-command-stdout>', { promptId: 'p2' }),
    ]);
    const latest = new Map(activitiesOf(transcript).map(state => [state.id, state]));
    expect(latest.get('claude:wf1')).toMatchObject({ status: 'completed', title: 'review-changes', task: { kind: 'workflow' }, detail: 'all clear', toolCallId: 'call_wf' });
    const compaction = [...latest.values()].find(state => state.kind === 'compaction')!;
    expect(compaction).toMatchObject({ status: 'completed', durationMs: 20000, compaction: { trigger: 'auto', preTokens: 250000, postTokens: 14000 }, startedAt: at(10) });
    const local = [...latest.values()].find(state => state.kind === 'local_command')!;
    expect(local).toMatchObject({ status: 'completed', title: '/cost', command: { name: 'cost' }, detail: 'Total cost: $0.12' });
    expect(transcript.allEvents().filter(event => event.type === 'user_message_chunk').map(event => (event.data.content as { text: string }).text)).toEqual(['/cost']);
    expect(transcript.allEvents().find(event => event.type === 'task_notification')!.data).toMatchObject({ kind: 'workflow', status: 'completed', detail: 'all clear' });
  });

  it('reads a `!` command and its output as one command row, not two prompts', async () => {
    const transcript = await open([
      text('u1', 1, '<bash-input> xcodebuild build -quiet</bash-input>', { promptId: 'p1' }),
      text('u2', 12, '<bash-stdout></bash-stdout><bash-stderr>error: database is locked\n** BUILD FAILED **\n</bash-stderr>', { promptId: 'p1' }),
      text('u3', 20, '<bash-input>sleep 600</bash-input>', { promptId: 'p2' }),
      text('u4', 21, 'next', { promptId: 'p3', origin: { kind: 'human' } }),
    ]);
    const latest = new Map(activitiesOf(transcript).map(state => [state.id, state]));
    expect(latest.get('claude:shell:u1')).toMatchObject({
      kind: 'local_command', status: 'completed', title: 'xcodebuild build -quiet', task: { kind: 'shell', command: 'xcodebuild build -quiet' },
      detail: 'error: database is locked\n** BUILD FAILED **', durationMs: 11000,
    });
    expect(latest.get('claude:shell:u3')).toMatchObject({ status: 'unknown', task: { command: 'sleep 600' } });
    expect(transcript.allEvents().filter(event => event.type === 'user_message_chunk').map(event => (event.data.content as { text: string }).text)).toEqual(['next']);
  });

  it('only reads task output from the CLI’s own task directory', () => {
    expect(taskOutputPath('/private/tmp/claude-501/-repo/sess/tasks/b1.output')).toBeDefined();
    expect(taskOutputPath('/tmp/claude-1000/p/s/tasks/b1.output')).toBeDefined();
    for (const bad of ['/etc/passwd', '/private/tmp/claude-501/../../etc/passwd', '/private/tmp/other/s/tasks/b1.output', '/private/tmp/claude-501/s/notes/b1.output', 'tasks/b1.output']) {
      expect(taskOutputPath(bad)).toBeUndefined();
    }
  });
});
