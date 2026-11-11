import { appendFile, mkdir, mkdtemp, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../../../packages/contracts/src/index.js';
import { projectShareRollout, readCodexShare } from './share-read.js';
import { shareRolloutReader } from './share-rollout.js';
import { Store } from '../../store.js';
import { NativeEventLog } from '../../journal/native-log.js';
import { CodexBackendAdapter } from './index.js';

const at = '2026-10-23T10:00:00.000Z';
const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload, timestamp: at });
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('complete Codex share reads', () => {
  it.each(['app-server', 'native-item', 'legacy-event', 'native-empty'] as const)('preserves review-only %s output through cold shares, selection and context reads', async form => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-review-')); dirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
    const id = '01a11b9b-9b5d-7303-8091-b6e4d2afeb02';
    const hint = 'current changes', explanation = 'Review found a persistence issue.';
    const output = form === 'native-empty' ? null : {
      findings: [{ title: '[P1] Persist the result', body: 'The result is lost after restart.', confidence_score: 0.95, priority: 1,
        code_location: { absolute_file_path: '/repo/share.ts', line_range: { start: 12, end: 14 } } }],
      overall_correctness: 'patch is incorrect', overall_explanation: explanation, overall_confidence_score: 0.95,
    };
    const text = output ? `${explanation}\n\nReview comment:\n\n- [P1] Persist the result — /repo/share.ts:12-14\n  The result is lost after restart.` : 'Reviewer failed to output a response.';
    const legacyIdentity = form === 'legacy-event' ? {} : { turn_id: 'review-turn', item_id: 'review-turn' };
    const legacy = [
      line('event_msg', { type: 'entered_review_mode', ...legacyIdentity, target: { type: 'uncommittedChanges' }, user_facing_hint: hint }),
      line('event_msg', { type: 'exited_review_mode', ...legacyIdentity, review_output: output }),
    ];
    const canonical = form === 'legacy-event' ? [] : [
      line('event_msg', { type: 'item_completed', turn_id: 'review-turn', item: form === 'app-server'
        ? { type: 'enteredReviewMode', id: 'review-turn', review: hint }
        : { type: 'EnteredReviewMode', id: 'review-turn', target: { type: 'uncommittedChanges' }, user_facing_hint: hint } }),
      line('event_msg', { type: 'item_completed', turn_id: 'review-turn', item: form === 'app-server'
        ? { type: 'exitedReviewMode', id: 'review-turn', review: text }
        : { type: 'ExitedReviewMode', id: 'review-turn', review_output: output } }),
    ];
    await writeFile(join(day, `rollout-${at}-${id}.jsonl`), [
      line('session_meta', { id }),
      line('event_msg', { type: 'task_started', turn_id: 'old' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Old question' }] }),
      line('event_msg', { type: 'task_started', turn_id: 'review-turn' }),
      // Review has no user item; both the raw answer and legacy fanout may precede its canonical items.
      ...(form === 'app-server' ? [line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })] : []),
      ...legacy, ...canonical, '',
    ].join('\n'));
    const session = { id: 'session', nativeSessionId: id } as Session;
    const catalog = await readCodexShare({} as never, session, root, { catalogOnly: true, messagesOnly: true });
    expect(catalog.turns?.map(turn => [turn.id, turn.text])).toEqual([['old', 'Old question'], ['review-turn', text.replace(/\s+/g, ' ')]]);
    const selected = await readCodexShare({} as never, session, root, { selection: { mode: 'selected', turnIds: ['review-turn'] } });
    const resultId = `${id}:review-turn:review-turn:review:result`;
    expect(selected.events.filter(event => event.type === 'agent_message_chunk')).toMatchObject([
      { nativeId: resultId, nativeTurnId: 'review-turn', data: { phase: 'final_answer', content: { text } } },
    ]);
    expect(selected.events.filter(event => event.type === 'agent_thought_chunk')).toMatchObject([
      { nativeId: `${id}:review-turn:review-turn:review:entered`, data: { channel: 'narration', content: { text: hint } } },
    ]);
    expect(selected.events.every(event => !event.raw)).toBe(true);
    const messages = await readCodexShare({} as never, session, root, { messagesOnly: true, selection: { mode: 'recent', count: 1 } });
    expect(messages.selectedTurnIds).toEqual(['review-turn']);
    expect(messages.events.filter(event => event.type === 'agent_message_chunk')).toMatchObject([{ nativeId: resultId, data: { phase: 'final_answer', content: { text } } }]);
    expect(messages.events.every(event => ['agent_message_chunk', 'share_process'].includes(event.type))).toBe(true);
    const adapter = new CodexBackendAdapter(() => { throw new Error('Cold reads must not start a provider'); });
    const context = await adapter.readContextTranscript({} as never, session, { config: { configDir: root } } as never,
      { maxBytes: 1024 * 1024, signal: new AbortController().signal });
    expect(context.filter(event => event.type === 'agent_message_chunk')).toMatchObject([{ nativeId: resultId, data: { phase: 'final_answer', content: { text } } }]);
  });

  it('retains only selected historical models when messages-only projection removes turn context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-models-')); dirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
    const id = '01a11b9b-9b5d-7303-8091-b6e4d2afeb01';
    await writeFile(join(day, `rollout-${at}-${id}.jsonl`), [
      line('session_meta', { id }),
      ...['old', 'new'].flatMap(turn => [
        line('turn_context', { turn_id: turn, model: `${turn}-model`, effort: 'high', service_tier: 'priority', api_key: 'secret' }),
        line('event_msg', { type: 'item_completed', turn_id: turn, item: { type: 'UserMessage', id: `${turn}-u`, content: [{ type: 'text', text: 'Question' }] } }),
        line('event_msg', { type: 'item_completed', turn_id: turn, item: { type: 'AgentMessage', id: `${turn}-a`, text: 'Answer' } }),
      ]),
    ].join('\n'));
    const result = await readCodexShare({} as never, { id: 'session', nativeSessionId: id } as Session, root, { messagesOnly: true, selection: { mode: 'recent', count: 1 } });
    expect(result.turnModels).toEqual({ new: { model: 'new-model', reasoningEffort: 'high', serviceTier: 'priority', source: 'history' } });
    expect(JSON.stringify(result.events)).not.toMatch(/model|secret/);
  });

  it('preserves reading text and selection when a complete journal outlives the rollout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-journal-')); dirs.push(root);
    const store = new Store(':memory:');
    try {
      const session = { id: 'session', nativeSessionId: '01a11b9b-9b5d-7303-8091-b6e4d2afea95' } as Session;
      const log = new NativeEventLog(store.journal, session.id);
      for (const [turn, question, answer] of [['old', 'Old question', 'Old answer'], ['new', 'Question', 'Final answer']]) {
        for (const [type, text] of [['user_message_chunk', question], ['agent_message_chunk', answer]]) log.assign({
          sequence: 0, sessionId: session.id, nativeId: `${turn}:${type}`, nativeTurnId: turn,
          type: type!, data: { content: { type: 'text', text }, ...(type === 'agent_message_chunk' ? { phase: 'final_answer' } : {}) }, createdAt: at,
        });
      }
      store.journal.setCursor(session.id, JSON.stringify({ v: 1, phase: 'ready', threadId: session.nativeSessionId }));
      const result = await readCodexShare({ journal: store.journal } as never, session, root, { messagesOnly: true, selection: { mode: 'recent', count: 1 } });
      expect(result.events.map(event => event.data.content)).toEqual([{ type: 'text', text: 'Question' }, { type: 'text', text: 'Final answer' }]);
      expect(result.turns?.map(turn => turn.text)).toEqual(['Old question', 'Question']);
    } finally { store.close(); }
  });

  it('uses Codex content origins to hide injected context while keeping the same words from a user', () => {
    const instructions = '# AGENTS.md instructions for /repo\n<INSTRUCTIONS>Keep modules separate.</INSTRUCTIONS>';
    const environment = '<environment_context><cwd>/repo</cwd></environment_context>';
    const message = (texts: string[], kinds: string[]) => line('response_item', {
      type: 'message', role: 'user', content: texts.map(text => ({ type: 'input_text', text })),
      internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
    });
    const content = [
      message([instructions, environment], ['agents_md.instructions', 'environments.environment_context']),
      // The exact injected text is also a valid user request; text matching would erase it.
      message([instructions, environment], ['user.text', 'user.text']),
      message([environment, 'Please explain these instructions.'], ['environments.environment_context', 'user.text']),
    ].join('\n');
    const users = projectShareRollout(content, 'session', 'thread').events.filter(event => event.type === 'user_message_chunk');
    expect(users.map(event => event.data.content)).toEqual([
      { type: 'text', text: instructions + environment },
      { type: 'text', text: 'Please explain these instructions.' },
    ]);
  });

  it('matches normalized user messages against user-origin content without duplicating mixed context rows', () => {
    const content = [
      line('response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Injected context' }, { type: 'input_text', text: 'Question' }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ['environments.environment_context', 'user.text'] },
      }),
      line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: 'Question' }] } }),
    ].join('\n');
    const users = projectShareRollout(content, 'session', 'thread').events.filter(event => event.type === 'user_message_chunk');
    expect(users).toHaveLength(1);
    expect(users[0]?.data.content).toEqual({ type: 'text', text: 'Question' });
  });

  it('uses normalized completed items once and preserves full content without provider metadata', () => {
    const answer = 'x'.repeat(100_000);
    const content = [
      line('event_msg', { type: 'task_started', turn_id: 'turn' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Question' }] }),
      line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'u', client_id: 'command', content: [{ type: 'text', text: 'Question' }] } }),
      line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }),
      line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: 'a', content: [{ type: 'text', text: answer }], phase: 'final_answer' } }),
      line('response_item', { type: 'custom_tool_call', call_id: 'wrapper', name: 'exec', input: 'await tools.exec_command({cmd:"cat README.md"})' }),
      line('event_msg', { type: 'item_completed', turn_id: 'turn', item: {
        type: 'CommandExecution', id: 'tool', command: ['/bin/zsh', '-lc', 'cat README.md'], cwd: 'file:///repo',
        parsed_cmd: [{ type: 'read', cmd: 'cat README.md', path: '/repo/README.md', name: 'README.md' }],
        aggregated_output: 'output', status: 'completed', exit_code: 0,
      } }),
      line('response_item', { type: 'custom_tool_call_output', call_id: 'wrapper', output: 'output' }),
      line('event_msg', { type: 'task_complete', turn_id: 'turn' }),
    ].join('\n');
    const { events } = projectShareRollout(content, 'session', 'thread');
    expect(events.filter(event => event.type === 'user_message_chunk')).toHaveLength(1);
    expect(events.filter(event => event.type === 'agent_message_chunk')).toHaveLength(1);
    expect(events.find(event => event.type === 'agent_message_chunk')?.data.content).toEqual({ type: 'text', text: answer });
    expect(events.find(event => event.type === 'tool_call_update')?.data).toMatchObject({ toolCallId: 'tool', status: 'completed', exitCode: 0 });
    expect(events.filter(event => event.type === 'tool_call')).toHaveLength(1);
    expect(events.find(event => event.type === 'tool_call')?.data).toMatchObject({
      toolCallId: 'tool', toolName: 'Read', kind: 'read', rawInput: { command: 'cat README.md', cwd: '/repo' },
    });
    expect(events.find(event => event.type === 'user_message_chunk')?.nativeId).toBe('thread:turn:web:command:user');
    expect(events.every(event => !event.raw)).toBe(true);
  });

  it('uses canonical multimodal inputs instead of publishing the model image envelope twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-rollout-')); dirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
    const id = '01a11b9b-9b5d-7303-8091-b6e4d2afea95';
    const content = [
      line('session_meta', { id }),
      line('event_msg', { type: 'task_started', turn_id: 'turn' }),
      line('response_item', { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'Repository context' },
      ], internal_chat_message_metadata_passthrough: { content_item_kinds: ['agents_md.instructions'] } }),
      line('response_item', { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'Question' }, { type: 'input_text', text: '<image path="/image.bin">' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }, { type: 'input_text', text: '</image>' },
      ], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text', 'user.text', 'user.image', 'user.text'] } }),
      line('event_msg', { type: 'item_completed', turn_id: 'turn', item: { type: 'UserMessage', id: 'u', client_id: 'command', content: [
        { type: 'text', text: 'Question' }, { type: 'local_image', path: '/image.bin' },
      ] } }),
    ].join('\n');
    await writeFile(join(day, `rollout-${at}-${id}.jsonl`), content);
    const result = await readCodexShare({} as never, { id: 'session', nativeSessionId: id } as Session, root);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      nativeId: `${id}:turn:web:command:user`, nativeTurnId: 'turn',
      data: { commandId: 'command', content: { type: 'text', text: 'Question' }, attachments: [{ type: 'image', path: '/image.bin' }] },
    });
  });

  it('reads a fork only through its saved parent byte boundary without launching a runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-rollout-')); dirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
    const parent = '01a11b9b-9b5d-7303-8091-b6e4d2afea96', child = '01a11b9b-9b5d-7303-8091-b6e4d2afea97';
    const prefix = `${line('session_meta', { id: parent })}\n${line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inherited' }] })}\n`;
    await writeFile(join(day, `rollout-${at}-${parent}.jsonl`), `${prefix}${line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Excluded' }] })}\n`);
    await writeFile(join(day, `rollout-${at}-${child}.jsonl`), `${line('session_meta', { id: child, history_base: { thread_id: parent, end_byte_offset: Buffer.byteLength(prefix) } })}\n${line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Child' }] })}\n`);
    const result = await readCodexShare({} as never, { id: 'session', nativeSessionId: child } as Session, root);
    expect(result.events.map(event => (event.data.content as { text?: string } | undefined)?.text).filter(Boolean)).toEqual(['Inherited', 'Child']);
  });

  it('keeps repeated text in another turn when only an earlier turn has a normalized item', () => {
    const content = [
      line('event_msg', { type: 'task_started', turn_id: 'one' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Again' }] }),
      line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'first', content: [{ type: 'text', text: 'Again' }] } }),
      line('event_msg', { type: 'task_started', turn_id: 'two' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Again' }] }),
    ].join('\n');
    expect(projectShareRollout(content, 'session', 'thread').events.filter(event => event.type === 'user_message_chunk')).toHaveLength(2);
  });

  it('preserves older message categories when only tools have canonical items', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-rollout-')); dirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
    const id = '01a11b9b-9b5d-7303-8091-b6e4d2afeaa9';
    const content = [
      line('session_meta', { id }),
      line('event_msg', { type: 'task_started', turn_id: 'legacy-mixed' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Injected instruction' }, { type: 'input_text', text: 'Visible user question' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['agents_md.instructions', 'user.text'] } }),
      line('response_item', { type: 'custom_tool_call', call_id: 'wrapper', name: 'exec', input: 'encoded wrapper' }),
      line('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'command', command: ['pwd'], aggregated_output: '/repo', status: 'completed' } }),
      line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Visible assistant answer' }] }),
    ].join('\n');
    await writeFile(join(day, `rollout-${at}-${id}.jsonl`), content);
    const session = { id: 'session', nativeSessionId: id } as Session;
    const catalog = await readCodexShare({} as never, session, root, { catalogOnly: true });
    expect(catalog.turns?.map(turn => turn.text)).toEqual(['Visible user question']);
    const result = await readCodexShare({} as never, session, root, { selection: { mode: 'recent', count: 1 } });
    expect(result.events.filter(event => event.type.endsWith('message_chunk')).map(event => (event.data.content as { text?: string })?.text)).toEqual(['Visible user question', 'Visible assistant answer']);
    expect(result.events.filter(event => event.type === 'tool_call')).toHaveLength(1);
  });

  it('exports only message data and process boundaries without child execution or provider metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-rollout-')); dirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
    const id = '01a11b9b-9b5d-7303-8091-b6e4d2afeab0';
    await writeFile(join(day, `rollout-${at}-${id}.jsonl`), [
      line('session_meta', { id }),
      line('event_msg', { type: 'task_started', turn_id: 'tool-only' }),
      line('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', command: ['secret-command'], aggregated_output: 'secret-output' } }),
      line('event_msg', { type: 'task_started', turn_id: 'conversation' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hidden repository instructions' }, { type: 'input_text', text: 'Question' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['agents_md.instructions', 'user.text'] } }),
      line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'u', client_id: 'cmd', content: [{ type: 'text', text: 'Question', provider: 'secret-provider' }, { type: 'local_image', path: '/question.png', raw: 'secret-image-envelope' }], raw: 'secret-user' } }),
      line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'reply', content: [{ type: 'text', text: `<send_user_message_question_reply>${JSON.stringify([{ question: 'Proceed?', answer: 'Yes', questionItemId: JSON.stringify(['request_user_input_async', 'question', 0]) }])}</send_user_message_question_reply>` }] } }),
      line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: 'progress', text: 'secret-progress', phase: 'commentary' } }),
      line('event_msg', { type: 'item_completed', item: { type: 'Reasoning', summary_text: ['secret-reasoning'] } }),
      line('response_item', { type: 'function_call', name: 'update_plan', call_id: 'plan', arguments: '{"secret-plan":true}' }),
      line('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'child', kind: 'started', agent_thread_id: 'missing-child', prompt: 'secret-prompt' } }),
      line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: 'final', text: 'Final answer', phase: 'final_answer', raw: 'secret-agent' } }),
      line('event_msg', { type: 'task_complete', turn_id: 'conversation', metrics: { private: 'secret-metrics' } }),
      line('event_msg', { type: 'task_started', turn_id: 'assistant-only' }),
      line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Legacy final answer' }], provider: 'secret-provider' }),
    ].join('\n'));
    const session = { id: 'session', nativeSessionId: id } as Session;
    const catalog = await readCodexShare({} as never, session, root, { messagesOnly: true, catalogOnly: true });
    expect(catalog.turns?.map(turn => turn.id)).toEqual(['conversation', 'assistant-only']);
    const result = await readCodexShare({} as never, session, root, { messagesOnly: true, selection: { mode: 'all' } });
    expect(result.subagents).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.events.map(event => event.type)).toEqual(['user_message_chunk', 'user_message_chunk', 'share_process', 'agent_message_chunk', 'run_completed', 'agent_message_chunk']);
    expect(result.events[0]?.data).toMatchObject({ content: { text: 'Question' }, attachments: [{ type: 'image', path: '/question.png' }] });
    expect(result.events[1]?.data.content).toEqual({ type: 'text', text: '> Proceed?\n\nYes' });
    expect(result.events.filter(event => event.type === 'agent_message_chunk').map(event => event.data.content)).toEqual([{ type: 'text', text: 'Final answer' }, { type: 'text', text: 'Legacy final answer' }]);
    expect(JSON.stringify(result)).not.toContain('secret-');
    expect(JSON.stringify(result)).not.toContain('Hidden repository instructions');
    expect(JSON.stringify(result)).not.toContain('missing-child');
  });

  it('finds legacy and current child starts using the live transcript contract', () => {
    const content = [
      line('event_msg', { type: 'item_completed', item: { type: 'CollabAgentToolCall', id: 'legacy', prompt: 'Review files', receiver_thread_ids: ['child-one'], status: 'completed' } }),
      line('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'current', kind: 'started', agent_thread_id: 'child-two', agent_path: '/root/fix_share' } }),
      line('event_msg', { type: 'item_completed', item: { type: 'CollabAgentToolCall', id: 'followup', tool: 'sendInput', prompt: 'More detail', receiver_thread_ids: ['child-one'] } }),
    ].join('\n');
    const { events, children } = projectShareRollout(content, 'session', 'thread');
    expect(children).toEqual([
      { toolCallId: 'legacy', agentId: 'child-one', prompt: 'Review files', title: 'Review files' },
      { toolCallId: 'current', agentId: 'child-two', title: 'fix_share' },
    ]);
    expect(events.find(event => event.type === 'tool_call' && event.data.toolCallId === 'legacy')?.data).toMatchObject({
      toolName: 'Subagent', kind: 'agent', subagent: { prompt: 'Review files', description: 'Review files' },
    });
  });

  it('refuses corrupt committed records rather than reporting an incomplete log as complete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-rollout-')); dirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
    const id = '01a11b9b-9b5d-7303-8091-b6e4d2afea98';
    await writeFile(join(day, `rollout-${at}-${id}.jsonl`), `${line('session_meta', { id })}\n{broken}\n`);
    await expect(readCodexShare({} as never, { id: 'session', nativeSessionId: id } as Session, root)).rejects.toMatchObject({ code: 'SHARE_HISTORY_UNAVAILABLE' });
  });

  it('catalogs files above 64 MiB and reads only the selected recent turn and its own children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-rollout-')); dirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
    const id = '01a11b9b-9b5d-7303-8091-b6e4d2afea99', path = join(day, `rollout-${at}-${id}.jsonl`);
    await writeFile(path, [
      line('session_meta', { id }),
      line('event_msg', { type: 'task_started', turn_id: 'old' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Old question' }] }),
      line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'old-u', content: [{ type: 'text', text: 'Old question' }] } }),
      line('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'old-child', kind: 'started', agent_thread_id: 'missing-excluded-child' } }),
      '',
    ].join('\n'));
    const large = `${line('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'old-tool', command: ['cat', 'large.txt'], aggregated_output: 'x'.repeat(7 * 1024 * 1024), status: 'completed' } })}\n`;
    for (let index = 0; index < 10; index++) await appendFile(path, large);
    await appendFile(path, [
      line('event_msg', { type: 'task_started', turn_id: 'recent' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hidden model wrapper' }] }),
      line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'new-u', content: [{ type: 'text', text: 'Recent question' }] } }),
      line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'steer-u', content: [{ type: 'text', text: 'Same-turn steering' }] } }),
      line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: 'new-a', text: 'Recent answer' } }),
      '',
    ].join('\n'));
    const envelope = `${line('response_item', { type: 'function_call_output', call_id: 'model-envelope', output: 'x'.repeat(7 * 1024 * 1024) })}\n`;
    // Model protocol duplicates would exceed the cap even for this tiny recent canonical turn.
    for (let index = 0; index < 10; index++) await appendFile(path, envelope);
    const session = { id: 'session', nativeSessionId: id } as Session;
    const catalog = await readCodexShare({} as never, session, root, { catalogOnly: true });
    expect(catalog.events).toEqual([]);
    expect(catalog.subagents).toEqual([]);
    expect(catalog.turns?.map(turn => [turn.id, turn.text])).toEqual([['old', 'Old question'], ['recent', 'Recent question']]);
    const recent = await readCodexShare({} as never, session, root, { selection: { mode: 'recent', count: 1 } });
    expect(recent.selectedTurnIds).toEqual(['recent']);
    expect(recent.events.every(event => event.nativeTurnId === 'recent')).toBe(true);
    expect(recent.events.map(event => (event.data.content as { text?: string })?.text)).toEqual(['Recent question', 'Same-turn steering', 'Recent answer']);
    expect(recent.warnings).toEqual([]);
    await expect(readCodexShare({} as never, session, root, { selection: { mode: 'all' } })).rejects.toMatchObject({ code: 'SHARE_HISTORY_TOO_LARGE' });
    const messages = await readCodexShare({} as never, session, root, { messagesOnly: true, selection: { mode: 'all' } });
    expect(messages.selectedTurnIds).toEqual(['old', 'recent']);
    expect(messages.subagents).toEqual([]);
    expect(messages.warnings).toEqual([]);
    expect(messages.events.filter(event => event.type.endsWith('message_chunk'))).toHaveLength(4);
    expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(6000);
    expect(messages.events.every(event => ['user_message_chunk', 'agent_message_chunk', 'share_process'].includes(event.type))).toBe(true);
  }, 15_000);

  it('selects legacy history_mutation user turns without retaining unrelated model history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-rollout-')); dirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
    const id = '01a11b9b-9b5d-7303-8091-b6e4d2afeaa0';
    await writeFile(join(day, `rollout-${at}-${id}.jsonl`), [
      line('session_meta', { id }),
      line('history_mutation', { operation: 'append', items: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'First legacy question' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First legacy answer' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Second legacy question' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Second legacy answer' }] },
      ] }),
    ].join('\n'));
    const session = { id: 'session', nativeSessionId: id } as Session;
    const catalog = await readCodexShare({} as never, session, root, { catalogOnly: true });
    const selected = await readCodexShare({} as never, session, root, { selection: { mode: 'selected', turnIds: [catalog.turns![1]!.id], nativeChatId: id } });
    expect(selected.events.map(event => (event.data.content as { text?: string })?.text)).toEqual(['Second legacy question', 'Second legacy answer']);
    await expect(readCodexShare({} as never, session, root, { selection: { mode: 'selected', turnIds: ['other-turn'] } })).rejects.toMatchObject({ code: 'SHARE_SELECTION_INVALID' });
    await expect(readCodexShare({} as never, session, root, { selection: { mode: 'selected', turnIds: [catalog.turns![1]!.id], nativeChatId: 'other-thread' } })).rejects.toMatchObject({ code: 'SHARE_SELECTION_INVALID' });
  });

  it('keeps a selected fork within the saved inherited prefix and rejects unavailable turn IDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-rollout-')); dirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
    const parent = '01a11b9b-9b5d-7303-8091-b6e4d2afeaa1', child = '01a11b9b-9b5d-7303-8091-b6e4d2afeaa2';
    const user = (turn: string, text: string) => `${line('event_msg', { type: 'task_started', turn_id: turn })}\n${line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] })}\n`;
    const prefix = `${line('session_meta', { id: parent })}\n${user('inherited', 'Allowed inherited question')}`;
    await writeFile(join(day, `rollout-${at}-${parent}.jsonl`), `${prefix}${user('future', 'Private parent future')}`);
    await writeFile(join(day, `rollout-${at}-${child}.jsonl`), `${line('session_meta', { id: child, history_base: { thread_id: parent, end_byte_offset: Buffer.byteLength(prefix) } })}\n${user('child', 'Child question')}`);
    const session = { id: 'session', nativeSessionId: child } as Session;
    const catalog = await readCodexShare({} as never, session, root, { catalogOnly: true });
    expect(catalog.turns?.map(turn => turn.id)).toEqual(['inherited', 'child']);
    const selected = await readCodexShare({} as never, session, root, { selection: { mode: 'selected', turnIds: ['inherited'] } });
    expect(selected.events.map(event => (event.data.content as { text?: string })?.text)).toEqual(['Allowed inherited question']);
    await expect(readCodexShare({} as never, session, root, { selection: { mode: 'selected', turnIds: ['future'] } })).rejects.toMatchObject({ code: 'SHARE_SELECTION_INVALID' });
  });

  it('fixes the scan byte boundary and rejects truncation between catalog and content passes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-rollout-')); dirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
    const id = '01a11b9b-9b5d-7303-8091-b6e4d2afeaa3', path = join(day, `rollout-${at}-${id}.jsonl`);
    const original = `${line('session_meta', { id })}\n${line('turn_context', { turn_id: 'original' })}\n`;
    await writeFile(path, original);
    const reader = await shareRolloutReader(root, id);
    await appendFile(path, `${line('turn_context', { turn_id: 'later-append' })}\n`);
    const seen: unknown[] = [];
    await reader.scan(row => seen.push((row.payload as Record<string, unknown>).turn_id));
    expect(seen).toEqual([undefined, 'original']);
    await truncate(path, Buffer.byteLength(original) - 2);
    await expect(reader.scan(() => undefined)).rejects.toMatchObject({ code: 'SHARE_HISTORY_CHANGED' });
  });

  it('rejects a fork boundary in the middle of a committed parent JSON record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-rollout-')); dirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
    const parent = '01a11b9b-9b5d-7303-8091-b6e4d2afeaa4', child = '01a11b9b-9b5d-7303-8091-b6e4d2afeaa5';
    const header = `${line('session_meta', { id: parent })}\n`;
    await writeFile(join(day, `rollout-${at}-${parent}.jsonl`), `${header}${line('turn_context', { turn_id: 'excluded-partial-turn' })}\n`);
    await writeFile(join(day, `rollout-${at}-${child}.jsonl`), `${line('session_meta', { id: child, history_base: { thread_id: parent, end_byte_offset: Buffer.byteLength(header) + 12 } })}\n`);
    await expect(readCodexShare({} as never, { id: 'session', nativeSessionId: child } as Session, root, { catalogOnly: true })).rejects.toMatchObject({ code: 'SHARE_HISTORY_UNAVAILABLE' });
  });

  it('rejects a same-length in-place rewrite between passes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-rollout-')); dirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
    const id = '01a11b9b-9b5d-7303-8091-b6e4d2afeaa6', path = join(day, `rollout-${at}-${id}.jsonl`);
    const original = `${line('session_meta', { id })}\n${line('turn_context', { turn_id: 'original' })}\n`;
    await writeFile(path, original);
    const info = await stat(path), reader = await shareRolloutReader(root, id);
    await reader.scan(() => undefined);
    await writeFile(path, original.replace('original', 'modified'));
    await utimes(path, info.atime, new Date(info.mtimeMs + 1000));
    await expect(reader.scan(() => undefined)).rejects.toMatchObject({ code: 'SHARE_HISTORY_CHANGED' });
  });

  it('does not reintroduce unselected parent turns through a selected forked child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-rollout-')); dirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
    const id = '01a11b9b-9b5d-7303-8091-b6e4d2afeaa7', child = '01a11b9b-9b5d-7303-8091-b6e4d2afeaa8';
    const prefix = [
      line('session_meta', { id }),
      line('event_msg', { type: 'task_started', turn_id: 'private' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Unselected parent question' }] }),
      '',
    ].join('\n');
    await writeFile(join(day, `rollout-${at}-${id}.jsonl`), prefix + [
      line('event_msg', { type: 'task_started', turn_id: 'selected' }),
      line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'selected-u', content: [{ type: 'text', text: 'Selected question' }] } }),
      line('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'selected-child', kind: 'started', agent_thread_id: child } }),
      '',
    ].join('\n'));
    await writeFile(join(day, `rollout-${at}-${child}.jsonl`), [
      line('session_meta', { id: child, history_base: { thread_id: id, end_byte_offset: Buffer.byteLength(prefix) } }),
      line('event_msg', { type: 'task_started', turn_id: 'child-own' }),
      line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: 'child-a', text: 'Own child answer' } }),
      '',
    ].join('\n'));
    const result = await readCodexShare({} as never, { id: 'session', nativeSessionId: id } as Session, root, { selection: { mode: 'selected', turnIds: ['selected'] } });
    expect(result.subagents).toHaveLength(1);
    expect(result.subagents[0]!.events.map(event => (event.data.content as { text?: string })?.text)).toEqual(['Own child answer']);
    expect(result.warnings).toEqual([]);
  });

  it('filters parent history copied inside child files before recursively discovering children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-rollout-')); dirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
    const id = '01a11b9b-9b5d-7303-8091-b6e4d2afeab2', child = '01a11b9b-9b5d-7303-8091-b6e4d2afeab3', grandchild = '01a11b9b-9b5d-7303-8091-b6e4d2afeab4';
    const copied = [
      line('event_msg', { type: 'task_started', turn_id: 'private-parent' }),
      line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'private-u', content: [{ type: 'text', text: 'Unselected copied parent input' }] } }),
      line('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'private-spawn', kind: 'started', agent_thread_id: 'must-not-be-read' } }),
    ];
    const own = (turn: string, text: string) => [
      line('event_msg', { type: 'task_started', turn_id: turn }),
      line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: `${turn}-a`, text } }),
    ];
    await writeFile(join(day, `rollout-${at}-${id}.jsonl`), [
      line('session_meta', { id }), ...copied,
      line('event_msg', { type: 'task_started', turn_id: 'selected-parent' }),
      line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'selected-u', content: [{ type: 'text', text: 'Selected input' }] } }),
      line('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'selected-spawn', kind: 'started', agent_thread_id: child } }),
      '',
    ].join('\n'));
    await writeFile(join(day, `rollout-${at}-${child}.jsonl`), [
      line('session_meta', { id: child }), ...copied, ...own('child-own', 'Child own answer'),
      line('event_msg', { type: 'item_completed', item: { type: 'SubAgentActivity', id: 'own-spawn', kind: 'started', agent_thread_id: grandchild } }),
      '',
    ].join('\n'));
    await writeFile(join(day, `rollout-${at}-${grandchild}.jsonl`), [
      line('session_meta', { id: grandchild }), ...copied, ...own('grandchild-own', 'Grandchild own answer'), '',
    ].join('\n'));
    const result = await readCodexShare({} as never, { id: 'session', nativeSessionId: id } as Session, root, { selection: { mode: 'selected', turnIds: ['selected-parent'] } });
    expect(result.subagents.map(agent => agent.agentId)).toEqual([child, grandchild]);
    expect(result.subagents.flatMap(agent => agent.events).some(event => event.nativeTurnId === 'private-parent')).toBe(false);
    expect(result.subagents.map(agent => agent.events.find(event => event.type === 'agent_message_chunk')?.data.content)).toEqual([{ type: 'text', text: 'Child own answer' }, { type: 'text', text: 'Grandchild own answer' }]);
    expect(result.warnings).toEqual([]);
  });

  it('retains the selected canonical turn structured plan while discarding its model wrappers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-rollout-')); dirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
    const id = '01a11b9b-9b5d-7303-8091-b6e4d2afeab0';
    await writeFile(join(day, `rollout-${at}-${id}.jsonl`), [
      line('session_meta', { id }),
      line('event_msg', { type: 'task_started', turn_id: 'planned' }),
      line('event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: 'Make a plan' }] } }),
      line('response_item', { type: 'function_call', call_id: 'plan', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'Selected step', status: 'in_progress' }] }) }),
      line('response_item', { type: 'function_call_output', call_id: 'plan', output: 'Plan updated' }),
      line('response_item', { type: 'custom_tool_call', call_id: 'wrapper', name: 'exec', input: 'model wrapper' }),
      line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: 'a', text: 'The plan is ready' } }),
      '',
    ].join('\n'));
    const result = await readCodexShare({} as never, { id: 'session', nativeSessionId: id } as Session, root, { selection: { mode: 'recent', count: 1 } });
    expect(result.events.find(event => event.type === 'plan')).toMatchObject({ nativeTurnId: 'planned', data: { entries: [{ content: 'Selected step', status: 'in_progress' }] } });
    expect(result.events.some(event => event.data.toolCallId === 'wrapper')).toBe(false);
  });

  it('selects assistant-only and tool-only turns without exposing injected context or inventing user messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-share-rollout-')); dirs.push(root);
    const day = join(root, 'sessions', '2026', '10', '23'); await mkdir(day, { recursive: true });
    const id = '01a11b9b-9b5d-7303-8091-b6e4d2afeab1';
    await writeFile(join(day, `rollout-${at}-${id}.jsonl`), [
      line('session_meta', { id }),
      line('event_msg', { type: 'task_started', turn_id: 'assistant-only' }),
      line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Private injected context' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['agents_md.instructions'] } }),
      line('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'first-tool', command: ['pwd'], status: 'completed' } }),
      line('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: 'a', text: 'Assistant-only summary' } }),
      line('event_msg', { type: 'task_started', turn_id: 'tool-only' }),
      line('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'second-tool', command: ['ls'], status: 'completed' } }),
      '',
    ].join('\n'));
    const session = { id: 'session', nativeSessionId: id } as Session;
    const catalog = await readCodexShare({} as never, session, root, { catalogOnly: true });
    expect(catalog.turns?.map(turn => [turn.id, turn.text])).toEqual([['assistant-only', 'Assistant-only summary'], ['tool-only', '工具记录']]);
    const recent = await readCodexShare({} as never, session, root, { selection: { mode: 'recent', count: 2 } });
    expect(recent.events.some(event => event.type === 'user_message_chunk')).toBe(false);
    expect(recent.events.some(event => event.type === 'agent_message_chunk')).toBe(true);
    expect(recent.events.filter(event => event.type === 'tool_call')).toHaveLength(2);
    expect(recent.selectedTurnIds).toEqual(['assistant-only', 'tool-only']);
  });
});
