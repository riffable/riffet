import { describe, expect, it } from 'vitest';
import type { NativeWorkbenchEvent } from '../../../../../packages/contracts/src/index.js';
import { makePendingInteraction } from './interactions.js';
import { projectCodexItem } from './project-item.js';
import { CodexQuestionHistory, codexQuestionReply } from './question-history.js';
import type { RpcItem } from './types.js';

const question = '如何管理 token 额度？';
const options = ['用户总额度', '每个模型分别设置'];
const answer = '用户总额度，并可对单个模型单独限额';
const reply = (callId = 'call-question', index = 0, value: string | string[] = answer) => ({
  questionItemId: JSON.stringify(['request_user_input_asynch', callId, index]), question, answer: value,
});
const message = (rows = [reply()]): RpcItem => ({ type: 'userMessage', id: 'reply-message',
  content: [{ type: 'text', text: `<send_user_message_question_reply>\n${JSON.stringify(rows)}\n</send_user_message_question_reply>` }] });
const call: RpcItem = { type: 'dynamicToolCall', id: 'call-question', tool: 'request_user_input_asynch', status: 'completed',
  arguments: { questions: [{ header: '额度管理', question, options: options.map(label => ({ label })) }] } };

function projection() {
  const history = new CodexQuestionHistory();
  let sequence = 0;
  const project = (item: RpcItem, runId = 'original-turn', threadId = 'thread') => history.project(item, threadId, `${threadId}:${runId}:${item.id}`,
    (nativeId, type, data): NativeWorkbenchEvent => ({ sequence: ++sequence, sessionId: 'session', runId, nativeId, type, data,
      raw: item, createdAt: new Date(sequence * 1000).toISOString() }));
  return { project, history };
}

describe('Codex question history', () => {
  it('merges a reply into its original tool across turns and preserves it when the call is replayed', () => {
    const { project } = projection();
    expect(project(call)?.[0]?.data.status).toBe('in_progress');
    const replied = project(message(), 'woken-turn')!;
    expect(replied).toMatchObject([{ type: 'tool_call_update', runId: 'original-turn', data: {
      toolCallId: 'call-question', status: 'completed',
      content: [{ type: 'question_answer', question, options, answers: [answer] }],
    } }]);
    expect(project(call)?.[0]?.data).toEqual(replied[0]?.data);
  });

  it('preserves answers from provider history when the original questions are unavailable', () => {
    const { project } = projection();
    expect(project(message(), 'woken-turn')).toMatchObject([{ type: 'tool_call_update', runId: 'woken-turn', data: {
      toolCallId: 'call-question', status: 'completed', content: [{ question, answers: [answer] }],
    } }]);
    const output = JSON.stringify({ answers: { internal_question_id: { answers: ['Per user'] } } });
    expect(project({ type: 'functionCallOutput', id: 'blocking', name: 'request_user_input',
      output: [{ type: 'input_text', text: output }] })?.[0]?.data).toMatchObject({ status: 'completed', content: [
      { type: 'question_answer', question: '问题 1', answers: ['Per user'] },
    ] });
  });

  it('accumulates answers by index until all questions are answered or skipped, without duplicates', () => {
    const { project } = projection();
    project({ ...call, arguments: { questions: [{ question }, { question }] } });
    expect(project(message([reply('call-question', 1, '')]))?.[0]?.data.status).toBe('in_progress');
    const completed = project(message())!;
    expect(completed[0]?.data).toMatchObject({ status: 'completed', content: [
      { type: 'question_answer', question, answers: [answer] },
      { type: 'question_answer', question, answers: [] },
    ] });
    expect(project(message([reply('call-question', 1, '')]))?.[0]?.data).toEqual(completed[0]?.data);
  });

  it('associates answers by call and thread ids rather than question text', () => {
    const { project } = projection();
    project(call, 'first-turn');
    project({ ...call, id: 'second-call' }, 'second-turn');
    const child = project(message(), 'child-turn', 'child-thread')!;
    expect(child[0]?.runId).toBe('child-turn');
    expect(project(call, 'first-turn')?.[0]?.data.status).toBe('in_progress');
    const replied = project(message([reply(), reply('second-call', 0, 'another answer')]), 'reply-turn')!;
    expect(replied.map(row => [row.runId, row.data.toolCallId])).toEqual([
      ['first-turn', 'call-question'], ['second-turn', 'second-call'],
    ]);
  });

  it.each(['Token?', ''])('omits identifiable secret answers with question %j from raw and local answer envelopes', secretQuestion => {
    const { project, history } = projection();
    const secret = 'private-token-never-store';
    const params = { threadId: 'thread', itemId: 'secret-call', questions: [{ id: 'token', header: 'Token', question: secretQuestion, isSecret: true, isOther: true }] };
    project(history.request(params)!);
    const pending = makePendingInteraction({ id: 'secret-request', method: 'item/tool/requestUserInput', params })!;
    pending.candidateSent = true;
    pending.answers = { token: { answers: [secret] } };
    expect(history.answered(pending)).toBeUndefined();

    const restored = project({ type: 'functionCallOutput', id: 'secret-call', name: 'request_user_input',
      output: JSON.stringify({ answers: { token: { answers: [secret] } } }) })!;
    expect(restored[0]?.data.status).toBe('completed');
    expect(restored[0]?.raw).toBeUndefined();
    expect(JSON.stringify(restored)).not.toContain(secret);
    const dynamic = project({ type: 'dynamicToolCall', id: 'secret-call', tool: 'request_user_input',
      arguments: { questions: params.questions }, contentItems: [{ type: 'inputText',
        text: JSON.stringify({ answers: { token: { answers: [secret] } } }) }] })!;
    expect(dynamic[0]?.data.status).toBe('completed');
    expect(JSON.stringify(dynamic)).not.toContain(secret);
    // Replaying a native copy without the metadata must not undo the known secret classification.
    project(history.request({ ...params, questions: [{ id: 'token', question: secretQuestion }] })!);
    project(call);
    const merged = project(message([{ ...reply('secret-call', 0, secret), question: secretQuestion }, reply()]))!;
    expect(merged).toHaveLength(2);
    expect(merged.every(event => event.raw === undefined)).toBe(true);
    expect(JSON.stringify(merged)).not.toContain(secret);
    expect(merged[1]?.data.content).toMatchObject([{ answers: [answer] }]);
    const unstructured = project({ type: 'functionCallOutput', id: 'secret-call', name: 'request_user_input', output: secret })!;
    expect(JSON.stringify(unstructured)).not.toContain(secret);
  });

  it('replays request metadata without answers and keeps secret question ids isolated within a thread/call', () => {
    const { history } = projection();
    const secret = 'native-secret-not-in-metadata';
    const params = { threadId: 'child', itemId: 'shared-call', questions: [{ id: 'token', header: 'Token', question: '', isSecret: true }] };
    history.request(params);
    // A later copy of the same id cannot downgrade it, even with different text or explicit false.
    history.request({ ...params, questions: [{ id: 'token', question: 'Old copy', isSecret: false }] });
    const { project, history: replay } = projection();
    const metadata = history.requests('child');
    expect(JSON.stringify(metadata)).not.toContain(secret);
    for (const item of metadata) replay.request({ itemId: item.id, questions: (item.arguments as Record<string, unknown>).questions }, 'child');
    const output: RpcItem = { type: 'functionCallOutput', id: 'shared-call', name: 'request_user_input', output: JSON.stringify({ answers: { token: { answers: [secret] } } }) };
    const redacted = project(output, 'reply', 'child')!;
    expect(redacted[0]?.data.content).toMatchObject([{ answers: ['[REDACTED]'] }]);
    expect(redacted[0]?.raw).toBeUndefined();
    expect(JSON.stringify(history.requests('child'))).not.toContain(secret);
    // Neither another thread nor a new question id at the same index inherits secret=true.
    expect(project(output, 'reply', 'parent')?.[0]?.data.content).toMatchObject([{ answers: [secret] }]);
    replay.request({ ...params, questions: [{ id: 'public', question: 'Public?' }] });
    const publicOutput = { ...output, output: JSON.stringify({ answers: { public: { answers: ['public answer'] } } }) };
    expect(project(publicOutput, 'reply', 'child')?.[0]?.data.content).toMatchObject([{ question: 'Public?', answers: ['public answer'] }]);
    // The omitted secret identity remains known for output-only copies with its native answer key.
    expect(JSON.stringify(project(output, 'later', 'child'))).not.toContain(secret);
  });

  it.each(['plain', 'image', 'ide-context'])('redacts a complete secret reply in %s UserInput without losing public content', kind => {
    const { history } = projection();
    const secret = 'secret-only-in-native-answer';
    const context = { sessionId: 'session', threadId: 'thread', runId: 'turn', createdAt: new Date(0).toISOString(), questions: history };
    projectCodexItem(history.request({ itemId: 'secret-call', questions: [{ id: 'token', question: 'Token?', isSecret: true }] })!, { id: 'ask' }, context);
    const envelope = `<send_user_message_question_reply>${JSON.stringify([reply('secret-call', 0, secret)])}</send_user_message_question_reply>`;
    const prefix = '# Context from my IDE setup:\nSelected file: public.ts\n\n## My request for Codex:\n';
    const item: RpcItem = { type: 'userMessage', id: 'native-reply', content: [
      { type: 'text', text: kind === 'ide-context' ? prefix + envelope : envelope, text_elements: [] },
      ...(kind === 'image' ? [{ type: 'localImage', path: '/tmp/public.png' }, { type: 'image', url: 'https://example.test/public.png' },
        { type: 'skill', name: 'public-skill', path: '/repo/skill.md' }, { type: 'mention', name: 'public-file', path: '/repo/public.ts' },
        { type: 'text', text: 'This attachment is public.' }] : []),
    ] };
    const events = projectCodexItem(item, { id: 'answer' }, context);
    expect(events.find(row => row.type === 'tool_call_update')?.data).toMatchObject({ status: 'completed', content: [{ answers: ['[REDACTED]'] }] });
    expect(events.every(row => row.raw === undefined)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(secret);
    if (kind !== 'plain') expect(events.find(row => row.type === 'user_message_chunk')?.data).toMatchObject(kind === 'image'
      ? { content: { text: 'This attachment is public.' }, attachments: [{ path: '/tmp/public.png' }, { path: 'https://example.test/public.png' },
        { type: 'file', name: 'skill: public-skill', path: '/repo/skill.md' }, { type: 'file', name: 'mention: public-file', path: '/repo/public.ts' }] }
      : { content: { text: prefix } });
    // Metadata belongs to one thread/call, not to every message containing this protocol.
    const unrelated = projectCodexItem(item, { id: 'answer' }, { ...context, threadId: 'different-thread' });
    expect(unrelated.find(row => row.type === 'tool_call_update')?.data.content).toMatchObject([{ answers: [secret] }]);
  });

  it('preserves ordinary messages and incomplete or malformed protocol lookalikes', () => {
    const { project } = projection();
    for (const text of ['ordinary answer', '<send_user_message_question_reply>[]</send_user_message_question_reply>',
      '<send_user_message_question_reply>not JSON</send_user_message_question_reply>',
      'Here is an example: <send_user_message_question_reply>[]</send_user_message_question_reply>',
      `Example:\n\`\`\`xml\n<send_user_message_question_reply>${JSON.stringify([reply()])}</send_user_message_question_reply>\n\`\`\``]) {
      expect(codexQuestionReply(text)).toBeUndefined();
      expect(project({ type: 'userMessage', id: 'user', content: [{ type: 'text', text }] })).toBeUndefined();
    }
    for (const identity of ['broken', '["tool","call",-1]', '["tool","call"]', '["ordinary_tool","call",0]']) {
      const item = message([{ ...reply(), questionItemId: identity }]);
      expect(project(item)).toBeUndefined();
    }
    expect(project({ ...message(), clientId: 'user-submission' })).toBeUndefined();
  });
});
