import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatReader, cursorSteerContext, decodeRoot, mapTranscript, parsePromptTimestamp, reasoningChannel, TranscriptMapper, userQuery, type ChatMessage } from './chat-store.js';
import { parseScreen, turnControls } from './screen.js';
import { readCompleteTranscript, Transcript } from './transcript.js';

function varint(value: number): number[] {
  const bytes: number[] = [];
  while (value > 0x7f) { bytes.push((value & 0x7f) | 0x80); value = Math.floor(value / 128); }
  bytes.push(value);
  return bytes;
}
const field = (number: number, payload: Uint8Array) => Buffer.from([...varint(number * 8 + 2), ...varint(payload.length), ...payload]);
const intField = (number: number, value: number) => Buffer.from([...varint(number * 8), ...varint(value)]);
const text = (value: string) => Buffer.from(value, 'utf8');

const blobId = (message: ChatMessage) => createHash('sha256').update(JSON.stringify(message)).digest('hex');

/**
 * Writes, or rewrites, a chat store; `pending` is the step the CLI has not committed yet, and each
 * archive is a compaction whose summary `messages` must hold.
 */
function writeChat(path: string, messages: ChatMessage[], meta: Record<string, unknown> = {}, pending?: ChatMessage & { id?: string }, archives: { messages: ChatMessage[]; summary: ChatMessage }[] = []) {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);');
  const put = (data: Buffer) => {
    const id = createHash('sha256').update(data).digest('hex');
    db.prepare('INSERT OR IGNORE INTO blobs VALUES (?, ?)').run(id, data);
    return id;
  };
  const ref = (number: number, message: ChatMessage) => field(number, Buffer.from(put(Buffer.from(JSON.stringify(message))), 'hex'));
  const compactions = archives.map((archive) => field(13, Buffer.from(put(Buffer.concat([...archive.messages.map((message) => ref(1, message)), ref(4, archive.summary)])), 'hex')));
  const category = Buffer.concat([field(1, text('conversation')), field(2, text('Conversation')), intField(3, 1200), intField(4, 4800)]);
  const usage = field(5, Buffer.concat([intField(1, 1200), intField(2, 200000), field(3, Buffer.concat([intField(1, 1200), intField(2, 200000), field(3, category)]))]));
  const draft = pending ? [field(4, text(JSON.stringify(pending)))] : [];
  const root = Buffer.concat([...messages.map((message) => ref(1, message)), ...draft, usage, field(9, text('file:///tmp/x')), ...compactions]);
  const rootId = put(root);
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify({ agentId: 'chat-1', latestRootBlobId: rootId, name: 'Probe', ...meta })).toString('hex'));
  db.close();
}

const query = (value: string) => `<timestamp>Thursday, Oct 1, 2026, 12:14 AM (UTC+8)</timestamp>\n<user_query>\n${value}\n</user_query>`;

const conversation: ChatMessage[] = [
  { role: 'system', content: 'You are an agent.' },
  { role: 'user', content: '<user_info>\nOS Version: darwin\n</user_info>' },
  { role: 'user', content: [{ type: 'text', text: query('run echo hi') }] },
  { role: 'assistant', content: [{ type: 'reasoning', text: 'Plan it.' }, { type: 'tool-call', toolCallId: 't1', toolName: 'Shell', args: { command: 'echo hi' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Shell', result: 'Exit code: 0' }], providerOptions: { cursor: { highLevelToolCallResult: { output: { success: { command: 'echo hi', stdout: 'hi\n', interleavedOutput: 'hi\n' } }, isError: false } } } },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't2', toolName: 'CallDynamicTool', args: { namespace: 'cursor', toolName: 'TodoWrite', arguments: { todos: [{ id: 'a', content: 'First', status: 'in_progress' }, { id: 'b', content: 'Second', status: 'pending' }] } } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't2', toolName: 'CallDynamicTool', result: 'ok' }] },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't3', toolName: 'CallDynamicTool', args: { namespace: 'cursor', toolName: 'TodoWrite', arguments: { merge: true, todos: [{ id: 'a', status: 'completed' }] } } }] },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't4', toolName: 'StrReplace', args: { path: '/p/a.ts', old_string: 'a', new_string: 'b' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't4', toolName: 'StrReplace', result: 'ok' }], providerOptions: { cursor: { highLevelToolCallResult: { output: { success: { path: '/p/a.ts', beforeFullFileContent: 'x\na\n', afterFullFileContent: 'x\nb\n' } }, isError: false } } } },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't5', toolName: 'Task', args: { description: 'Look around', subagent_type: 'explore', prompt: 'list files' } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't5', toolName: 'Task', result: 'This is the output of the subagent:\n\nfound 2 files' }], providerOptions: { cursor: { highLevelToolCallResult: { output: { success: { agentId: '69f2a12f-63b2-4602-9948-5308d8a425ff', durationMs: '1200' } }, isError: false } } } },
  { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
];

  it('preserves Cursor generation and first-turn ownership when a native in-flight input is appended', () => {
  const records = [
    { id: 'first', message: { role: 'user', content: query('first'), providerOptions: { cursor: { requestId: 'generation-1' } } } },
    { id: 'steer', message: { role: 'user', content: query('in-flight input'), providerOptions: { cursor: { requestId: 'generation-1' } } } },
    { id: 'answer', message: { role: 'assistant', content: 'final' } },
    { id: 'next', message: { role: 'user', content: query('next'), providerOptions: { cursor: { requestId: 'generation-2' } } } },
  ];
  const events = mapTranscript(records);
  expect(events.slice(0, 3).map(event => event.runId)).toEqual(['turn:first', 'turn:first', 'turn:first']);
  expect(events.slice(0, 3).map(event => event.nativeTurnId)).toEqual(['generation-1', 'generation-1', 'generation-1']);
  expect(events[3]).toMatchObject({ runId: 'turn:next', nativeTurnId: 'generation-2' });
});

it('extracts Cursor steer context receipts even when tool output exceeds 20KB after the carrier', () => {
  const meta = Buffer.from(JSON.stringify({
    backendId: 'cursor',
    sessionId: 'sess-1',
    commandId: 'steer-25k',
    nonce: '0123456789abcdef0123456789abcdef',
    target: { nativeSessionId: 'chat-1', turnId: 'gen-1' },
  })).toString('base64url');
  const carrier = `<riffet-steer v="1" data="${meta}">\nnarrow the scope\n</riffet-steer>`;
  const largeResult = `${carrier}\n${'x'.repeat(25_000)}`;
  const extracted = cursorSteerContext({ type: 'tool-result', toolCallId: 't1', toolName: 'Shell', result: largeResult });
  expect(extracted).toBe(carrier);
});

describe('chat store', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

  it('reads meta, ordered messages and the context breakdown', () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-store-'));
    const path = join(dir, 'store.db');
    writeChat(path, conversation);
    const reader = new ChatReader(path);
    const snapshot = reader.snapshot()!;
    expect(snapshot.meta.name).toBe('Probe');
    expect(snapshot.messageIds).toHaveLength(conversation.length);
    expect(snapshot.context).toEqual({ used: 1200, size: 200000, breakdown: [{ id: 'conversation', label: 'Conversation', tokens: 1200 }] });
    expect(reader.message(snapshot.messageIds[2]!)?.role).toBe('user');
    reader.close();
  });

  it('prefers outer token counts and drops stale inner breakdown snapshots', () => {
    const category = Buffer.concat([field(1, text('conversation')), field(2, text('Conversation')), intField(3, 20_294), intField(4, 80_000)]);
    const staleInner = Buffer.concat([intField(1, 20_294), intField(2, 300_000), field(3, category)]);
    // Outer updated after compaction while inner breakdown snapshot still holds pre-compaction total.
    const divergedRoot = field(5, Buffer.concat([intField(1, 18_962), intField(2, 300_000), field(3, staleInner)]));
    expect(decodeRoot(divergedRoot).context).toEqual({ used: 18_962, size: 300_000, breakdown: [] });
    // Outer cleared to proto3 zero (omitted on wire) while stale inner snapshot lingers: publish nothing.
    const clearedOuterRoot = field(5, field(3, staleInner));
    expect(decodeRoot(clearedOuterRoot).context).toBeUndefined();
  });

  it('returns nothing for a chat that does not exist yet', () => {
    expect(new ChatReader(join(tmpdir(), 'missing-chat', 'store.db')).snapshot()).toBeUndefined();
  });

  it('exports every stored message and full payload without advancing a live reader', () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-store-'));
    const path = join(dir, 'store.db'), large = 'x'.repeat(100_000);
    const messages: ChatMessage[] = Array.from({ length: 520 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: index % 2 ? [{ type: 'text', text: `answer-${index}` }] : query(`question-${index}`) }));
    messages.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call', toolName: 'Other', args: {} }] }, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call', toolName: 'Other', result: large }] }, { role: 'assistant', content: [{ type: 'text', text: large }] });
    writeChat(path, messages);
    const live = new Transcript('chat-1', path, 'session');
    live.refresh();
    const before = live.events.map(event => event.nativeId);
    const snapshot = readCompleteTranscript(path, 'session');
    expect(snapshot.filter(event => event.type === 'user_message_chunk')).toHaveLength(260);
    expect(snapshot.at(-1)?.data.content).toEqual({ type: 'text', text: large });
    expect(snapshot.find(event => event.type === 'tool_call_update')?.data.content).toEqual([{ type: 'content', content: { type: 'text', text: large } }]);
    expect(live.events.map(event => event.nativeId)).toEqual(before);
    expect(live.refresh()).toBeUndefined();
    live.close();
  });

  it('keeps a compacted turn where it was sent when the CLI re-states its prompt ahead of the summary', () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-store-'));
    const path = join(dir, 'store.db');
    const [system, info] = conversation as [ChatMessage, ChatMessage];
    const said = (value: string): ChatMessage => ({ role: 'assistant', content: [{ type: 'text', text: value }] });
    const summary = (value: string): ChatMessage => ({ role: 'user', content: query(`Your conversation was summarized. ${value}`) });
    const first: ChatMessage = { role: 'user', content: query('first') };
    const second: ChatMessage = { role: 'user', content: query('second') };
    const history = [system, info, first, said('one'), second, said('step')];
    writeChat(path, history);
    expect(new ChatReader(path).snapshot()!.messageIds).toEqual(history.map(blobId));

    // Compacting as the second turn starts archives through its prompt and re-states it.
    const opening = { messages: [first, said('one'), second], summary: summary('1') };
    writeChat(path, [system, info, second, opening.summary, said('step'), said('more')], {}, undefined, [opening]);
    expect(new ChatReader(path).snapshot()!.messageIds).toEqual([...history, said('more')].map(blobId));

    // Compacting again within that turn archives the re-stated copy as well.
    const within = { messages: [second, said('step'), said('more')], summary: summary('2') };
    writeChat(path, [system, info, second, within.summary, said('last')], {}, undefined, [opening, within]);
    expect(new ChatReader(path).snapshot()!.messageIds).toEqual([...history, said('more'), said('last')].map(blobId));
  });

  it('exposes each compaction at the end of the prefix its archive replaced, with the summary text', () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-store-'));
    const path = join(dir, 'store.db');
    const [system, info] = conversation as [ChatMessage, ChatMessage];
    const said = (value: string): ChatMessage => ({ role: 'assistant', content: [{ type: 'text', text: value }] });
    const summary = (value: string): ChatMessage => ({
      role: 'user',
      content: `Your conversation was summarized due to context constraints.\n\n<summary_content>\n${value}\n</summary_content>\n\nContinue.`,
    });
    const first: ChatMessage = { role: 'user', content: query('first') };
    const second: ChatMessage = { role: 'user', content: query('second') };
    const history = [system, info, first, said('one'), second, said('step')];
    const opening = { messages: [first, said('one'), second], summary: summary('Summary one.') };
    writeChat(path, [system, info, second, opening.summary, said('step'), said('more')], {}, undefined, [opening]);

    const reader = new ChatReader(path);
    expect(reader.snapshot()!.compactions).toEqual([{ summaryId: blobId(opening.summary), boundary: 5, summary: 'Summary one.' }]);

    reader.close();
  });

  it('keeps an unarchived message after archived prefix items instead of hoisting it to index 0', () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-store-'));
    const path = join(dir, 'store.db');
    const [system, info] = conversation as [ChatMessage, ChatMessage];
    const said = (value: string): ChatMessage => ({ role: 'assistant', content: [{ type: 'text', text: value }] });
    const summary = (value: string): ChatMessage => ({ role: 'user', content: query(`Your conversation was summarized. ${value}`) });
    const first: ChatMessage = { role: 'user', content: query('first') };
    const notice: ChatMessage = { role: 'user', content: '<task_notification>done</task_notification>' };
    const second: ChatMessage = { role: 'user', content: query('second') };
    const opening = { messages: [system, info, first, said('one')], summary: summary('1') };
    // Root retains archived system/info followed by an unarchived notice right before summary.
    writeChat(path, [system, info, notice, opening.summary, second, said('two')], {}, undefined, [opening]);

    const snap = new ChatReader(path).snapshot()!;
    expect(snap.messageIds).toEqual([system, info, first, said('one'), notice, second, said('two')].map(blobId));
    expect(snap.compactions).toMatchObject([{ summaryId: blobId(opening.summary), boundary: 4 }]);
  });

  it('shares the underlying read-only store safely across concurrent readers and after one closes', () => {
    dir = mkdtempSync(join(tmpdir(), 'chat-store-'));
    const path = join(dir, 'store.db');
    writeChat(path, conversation);
    const first = new ChatReader(path);
    const second = new ChatReader(path);
    try {
      const snap1 = first.snapshot()!;
      expect(snap1.messageIds.map(id => first.message(id))).toHaveLength(conversation.length);
      first.close();
      const snap2 = second.snapshot()!;
      expect(snap2.messageIds.map(id => second.message(id))).toEqual(conversation);
    } finally {
      first.close();
      second.close();
    }
  });

  describe('the step in flight', () => {
    const asking = { id: 'step-1', role: 'assistant', content: [{ type: 'text', text: 'Two ways to go.' }, { type: 'tool-call', toolCallId: 'q1', toolName: 'AskQuestion', args: { questions: [] } }] };
    const answer: ChatMessage = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'q1', toolName: 'AskQuestion', result: 'A' }] };

    it('reads an assistant step from the root and ignores anything else there', () => {
      dir = mkdtempSync(join(tmpdir(), 'chat-store-'));
      const path = join(dir, 'store.db');
      writeChat(path, conversation, {}, asking);
      expect(new ChatReader(path).snapshot()?.pending).toEqual(asking);
      writeChat(path, conversation, {}, { role: 'user', content: 'not a step' });
      expect(new ChatReader(path).snapshot()?.pending).toBeUndefined();
    });

    it('shows the step behind the transcript at the place its message will take, until it is committed', () => {
      dir = mkdtempSync(join(tmpdir(), 'chat-store-'));
      const path = join(dir, 'store.db');
      writeChat(path, conversation, {}, asking);
      const chat = new Transcript('chat-1', path, 'session-1');
      const first = chat.refresh()!;
      expect(first.draftChanged).toBe(true);
      expect(chat.events.some((event) => event.data.toolCallId === 'q1')).toBe(false);
      expect(chat.draft.map((event) => [event.type, event.nativeId])).toEqual([
        ['agent_message_chunk', `${conversation.length}:draft:0`],
        ['tool_call', `${conversation.length}:draft:1`],
      ]);
      expect(chat.draft[0]!.data.content).toEqual({ type: 'text', text: 'Two ways to go.' });

      writeChat(path, [...conversation, asking], {}, asking);
      const committing = chat.refresh()!;
      expect(committing.draftChanged).toBe(true);
      expect(chat.draft).toEqual([]);
      expect(committing.events.map((event) => event.nativeId.split(':')[0])).toEqual([String(conversation.length), String(conversation.length)]);

      writeChat(path, [...conversation, asking, answer]);
      expect(chat.refresh()?.draftChanged).toBe(false);
      expect(chat.draft).toEqual([]);
    });

    it('does not take an earlier step with the same id for the committed copy', () => {
      dir = mkdtempSync(join(tmpdir(), 'chat-store-'));
      const path = join(dir, 'store.db');
      writeChat(path, [...conversation, { ...asking, content: [{ type: 'text', text: 'Earlier.' }] } as ChatMessage], {}, asking);
      const chat = new Transcript('chat-1', path, 'session-1');
      chat.refresh();
      expect(chat.draft.map((event) => event.type)).toEqual(['agent_message_chunk', 'tool_call']);
    });
  });
});

describe('transcript mapping', () => {
  const events = mapTranscript(conversation.map((message, index) => ({ id: `m${index}`, message })));

  it('keeps only the visible user query and stamps the turn with its prompt time', () => {
    const users = events.filter((event) => event.type === 'user_message_chunk');
    expect(users).toHaveLength(1);
    expect(users[0]!.data.content).toEqual({ type: 'text', text: 'run echo hi' });
    expect(users[0]!.createdAt).toBe('2026-09-30T16:14:00.000Z');
    expect(new Set(events.map((event) => event.runId))).toEqual(new Set(['turn:m2']));
  });

  it('drops raw thinking from any message that narrates, tags the channel, and keeps thinking when nothing narrates', () => {
    const signed = (channel: string) => {
      const name = Buffer.from(channel);
      const header = Buffer.from([0x08, 0x12, 0x18, 0x02, 0x38, 0x01, 0x42, name.length, ...name]);
      const envelope = Buffer.from([0x0a, header.length, ...header, 0x12, 0x02, 0xaa, 0xbb]);
      return Buffer.from([0x08, 0x04, 0x12, envelope.length, ...envelope]).toString('base64');
    };
    expect(reasoningChannel(signed('narration'))).toBe('narration');
    expect(reasoningChannel('not a signature')).toBeUndefined();
    const reasoning = (text: string, channel: string) => ({ type: 'reasoning', text, signature: signed(channel) });
    const records = (messages: ChatMessage[]) => messages.map((message, index) => ({ id: `r${index}`, message }));
    const thoughtsOf = (events: ReturnType<typeof mapTranscript>) => events
      .filter((event) => event.type === 'agent_thought_chunk')
      .map((event) => [(event.data.content as { text: string }).text, event.data.channel]);

    const narrating = records([
      { role: 'user', content: [{ type: 'text', text: query('go') }] },
      { role: 'assistant', content: [reasoning('Early plan.', 'thinking'), reasoning('先看代码。', 'narration')] },
      { role: 'assistant', content: [reasoning('Long English detail.', 'thinking'), { type: 'reasoning', text: 'Unsigned.' }, reasoning('改好了。', 'narration')] },
    ]);
    // The first message's thinking used to leak because the old flag only latched once the
    // narration part had been reached, and an unreadable signature leaked on every message.
    expect(thoughtsOf(mapTranscript(narrating))).toEqual([['先看代码。', 'narration'], ['改好了。', 'narration']]);

    // Each message decides on its own, so resuming mid-chat with a fresh mapper — which is what
    // `Transcript` does on open, on branch switch and for older history — cannot change a row.
    const resumed = new TranscriptMapper();
    expect(thoughtsOf(narrating.slice(2).flatMap((record) => resumed.map(record)))).toEqual([['改好了。', 'narration']]);

    expect(thoughtsOf(mapTranscript(records([
      { role: 'user', content: [{ type: 'text', text: query('go') }] },
      { role: 'assistant', content: [reasoning('Only thinking.', 'thinking'), { type: 'reasoning', text: 'Unsigned.' }] },
    ])))).toEqual([['Only thinking.', 'thinking'], ['Unsigned.', 'thinking']]);
  });

  it('maps tools to tool_call / tool_call_update pairs', () => {
    const shell = events.filter((event) => event.data.toolCallId === 't1');
    expect(shell.map((event) => event.type)).toEqual(['tool_call', 'tool_call_update']);
    expect(shell[0]!.data).toMatchObject({ kind: 'execute', title: 'echo hi', status: 'in_progress' });
    expect(shell[1]!.data).toMatchObject({ status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'hi' } }] });
    const edit = events.filter((event) => event.data.toolCallId === 't4').at(-1)!;
    expect(edit.data.content).toEqual([{ type: 'diff', path: '/p/a.ts', oldText: 'x\na\n', newText: 'x\nb\n', status: 'modified', created: false }]);
  });

  it('gives a tool result the run its call was issued with, even when no turn existed yet', () => {
    const events = mapTranscript([
      { id: 'c', message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'early', toolName: 'Shell', args: { command: 'ls' } }] } },
      { id: 'u', message: { role: 'user', content: [{ type: 'text', text: query('next') }] } },
      { id: 'r', message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'early', toolName: 'Shell', result: 'Exit code: 0' }] } },
    ]);
    const pair = events.filter((event) => event.data.toolCallId === 'early');
    expect(pair.map((event) => event.type)).toEqual(['tool_call', 'tool_call_update']);
    expect(pair[0]!.runId).toBeUndefined();
    expect(pair[1]!.runId).toBe(pair[0]!.runId);
  });

  it('keeps a long in-progress Shell call identifiable as a task before its result is persisted', () => {
    const command = './arch test --affected 2>&1 | tail -30';
    const call = mapTranscript([
      { id: 'prompt', message: { role: 'user', content: query('run the focused tests') } },
      { id: 'shell', message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'shell-long', toolName: 'Shell', args: { command, block_until_ms: 600000 } }] } },
    ]).find((event) => event.type === 'tool_call');

    expect(call).toMatchObject({
      type: 'tool_call',
      runId: 'turn:prompt',
      data: { toolCallId: 'shell-long', toolName: 'Shell', kind: 'execute', title: command, rawInput: { command } },
    });
  });

  it('uses CLI shellId/backgroundReason metadata to keep a background shell running', () => {
    const command = 'run long tests';
    const events = mapTranscript([
      { id: 'prompt', message: { role: 'user', content: query('run tests') } },
      { id: 'shell', message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'shell-bg', toolName: 'Shell', args: { command, block_until_ms: 600000 } }] } },
      { id: 'shell-result', message: {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'shell-bg', toolName: 'Shell', result: 'Shell ID: 12345' }],
        providerOptions: { cursor: { highLevelToolCallResult: { output: { success: { command, shellId: 12345, backgroundReason: 'maximum wait reached', executionTime: 600000 } }, isError: false } } },
      } },
    ]);

    expect(events.at(-1)?.data).toMatchObject({ status: 'completed', hidden: true, job: { id: '12345', status: 'running' } });
  });

  it('extracts background shell log paths from timeout wording and terminalsFolder fallback', () => {
    const logPath = '/home/dev/.cursor/projects/my-repo/terminals/16926.txt';
    const fromText = mapTranscript([
      { id: 'p1', message: { role: 'user', content: query('count lines') } },
      { id: 'c1', message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'sh-timeout', toolName: 'Shell', args: { command: 'wc -l' } }] } },
      { id: 'r1', message: {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'sh-timeout', toolName: 'Shell', result: `The command did not complete in 30000ms and was sent to the background.\nShell ID: 16926\nThe output is being written to ${logPath}. Don't mention Shell ID to the user.` }],
        providerOptions: { cursor: { highLevelToolCallResult: { output: { success: { command: 'wc -l', shellId: 16926, backgroundReason: 'SHELL_BACKGROUND_REASON_TIMEOUT' } }, isError: false } } },
      } },
    ]);
    expect(fromText.at(-1)?.data).toMatchObject({ status: 'completed', hidden: true, job: { id: '16926', status: 'running', outputPath: logPath } });

    const fromFolder = mapTranscript([
      { id: 'p2', message: { role: 'user', content: query('count lines') } },
      { id: 'c2', message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'sh-folder', toolName: 'Shell', args: { command: 'wc -l' } }] } },
      { id: 'r2', message: {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'sh-folder', toolName: 'Shell', result: 'Sent to background.' }],
        providerOptions: { cursor: { highLevelToolCallResult: { output: { success: { command: 'wc -l', shellId: 16926, backgroundReason: 'SHELL_BACKGROUND_REASON_TIMEOUT' }, terminalsFolder: '/home/dev/.cursor/projects/my-repo/terminals' }, isError: false } } },
      } },
    ]);
    expect(fromFolder.at(-1)?.data).toMatchObject({ status: 'completed', hidden: true, job: { id: '16926', status: 'running', outputPath: logPath } });
  });

  it('keeps normal Shell output visible while recording its completion state', () => {
    const events = mapTranscript([
      { id: 'prompt', message: { role: 'user', content: query('run a command') } },
      { id: 'shell', message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'shell-ok', toolName: 'Shell', args: { command: 'printf ok' } }] } },
      { id: 'shell-result', message: {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'shell-ok', toolName: 'Shell', result: 'Exit code: 0' }],
        providerOptions: { cursor: { highLevelToolCallResult: { output: { success: { stdout: 'ok', interleavedOutput: 'ok', localExecutionTimeMs: 45 } }, isError: false } } },
      } },
    ]);

    expect(events.at(-1)?.data).toMatchObject({
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      jobResult: { status: 'succeeded', runningMs: 45 },
    });
    expect(events.at(-1)?.data.hidden).toBeUndefined();
  });

  it('settles a failed Shell task without hiding its error output', () => {
    const events = mapTranscript([
      { id: 'prompt', message: { role: 'user', content: query('run tests') } },
      { id: 'shell', message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'shell-failed', toolName: 'Shell', args: { command: 'run tests' } }] } },
      { id: 'shell-result', message: {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'shell-failed', toolName: 'Shell', result: 'Exit code: 2' }],
        providerOptions: { cursor: { highLevelToolCallResult: { output: { failure: { exitCode: 2, stderr: 'failed' } }, isError: true } } },
      } },
    ]);

    expect(events.at(-1)?.data).toMatchObject({ status: 'failed', jobResult: { status: 'failed', exitCode: 2 }, content: [{ type: 'content' }] });
    expect(events.at(-1)?.data.hidden).toBeUndefined();
  });

  it('keeps the reported todo state through a final answer, cancellation, and explicit clearing', () => {
    const mapper = new TranscriptMapper();
    const todo = (id: string, input: unknown) => mapper.map({ id, message: {
      role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'CallDynamicTool',
        args: { namespace: 'cursor', toolName: 'TodoWrite', arguments: JSON.stringify(input) } }],
    } });
    expect(todo('create', { todos: [{ id: 'a', content: 'First', status: 'in_progress' }] })[0]?.data.entries)
      .toEqual([{ id: 'a', content: 'First', status: 'in_progress' }]);
    const answer = mapper.map({ id: 'answer', message: { role: 'assistant', content: 'Finished.' } });
    expect(answer.some(event => event.type === 'plan')).toBe(false);
    expect(todo('cancel', { merge: true, todos: [{ id: 'a', status: 'cancelled' }] })[0]?.data.entries)
      .toEqual([{ id: 'a', content: 'First', status: 'cancelled' }]);
    expect(todo('clear', { merge: false, todos: [] })[0]?.data.entries).toEqual([]);
  });

  it('tracks whether the transcript tail still owes the model a step', () => {
    const mapper = new TranscriptMapper();
    expect(mapper.awaitingReply).toBe(false);
    mapper.map({ id: 'u', message: { role: 'user', content: '<user_query>\nreview it\n</user_query>' } });
    expect(mapper.awaitingReply).toBe(true);
    mapper.map({ id: 'call', message: { role: 'assistant', content: [{ type: 'reasoning', text: 'Look first.' }, { type: 'tool-call', toolCallId: 'c1', toolName: 'Read', args: { path: 'a.ts' } }] } });
    expect(mapper.awaitingReply).toBe(true);
    mapper.map({ id: 'result', message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'Read', result: 'ok' }] } });
    expect(mapper.awaitingReply).toBe(true);
    mapper.map({ id: 'answer', message: { role: 'assistant', content: [{ type: 'reasoning', text: 'Done.' }, { type: 'text', text: 'All good.' }] } });
    expect(mapper.awaitingReply).toBe(false);
    mapper.map({ id: 'system', message: { role: 'system', content: 'You are…' } });
    expect(mapper.awaitingReply).toBe(false);
    // Prompts the CLI writes for itself map to nothing visible, yet still start a step.
    mapper.map({ id: 'summary', message: { role: 'user', content: '\n\n<summary>\nEarlier work.\n</summary>' } });
    expect(mapper.awaitingReply).toBe(true);
  });

  it('marks Task calls as subagents and keeps the child agent id', () => {
    const task = events.filter((event) => event.data.toolCallId === 't5');
    expect(task[0]!.data).toMatchObject({ kind: 'agent', title: 'Look around', subagent: { type: 'explore' } });
    expect(task[1]!.data.subagentResult).toMatchObject({ agentId: '69f2a12f-63b2-4602-9948-5308d8a425ff', durationMs: 1200 });
    expect(task[1]!.data.content).toEqual([{ type: 'content', content: { type: 'text', text: 'found 2 files' } }]);
  });

  it.each(['Task', 'Subagent'])('reads a dynamic %s whose arguments the CLI recorded as JSON text', (toolName) => {
    const args = { namespace: 'cursor', toolName, arguments: JSON.stringify({ description: 'Port the emulator', subagent_type: 'generalPurpose', prompt: 'Read the Java source', run_in_background: true }) };
    const [call] = mapTranscript([{ id: 'm1', message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'd1', toolName: 'CallDynamicTool', args }] } }]);
    expect(call!.data).toMatchObject({
      toolName, kind: 'agent', title: 'Port the emulator',
      subagent: { type: 'generalPurpose', description: 'Port the emulator', prompt: 'Read the Java source', background: true },
    });

    // As the CLI recorded it: the model's text with a stray brace after the object.
    const stray = { ...args, arguments: `${args.arguments}}` };
    const [strayCall] = mapTranscript([{ id: 'm1', message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'd2', toolName: 'CallDynamicTool', args: stray }] } }]);
    expect(strayCall!.data).toMatchObject({ title: 'Port the emulator', subagent: { description: 'Port the emulator', background: true } });
    const mapper = new TranscriptMapper();
    mapper.map({ id: 'call', message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'd3', toolName, args: JSON.parse(args.arguments) }] } });
    const [outcome] = mapper.map({ id: 'result', message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'd3', toolName, result: 'This is the output of the subagent: found files' }], providerOptions: { cursor: { highLevelToolCallResult: { output: { success: { agentId: '69f2a12f-63b2-4602-9948-5308d8a425ff', durationMs: 1200, isBackground: true } }, isError: false } } } } });
    expect(outcome!.data.subagentResult).toEqual({ agentId: '69f2a12f-63b2-4602-9948-5308d8a425ff', durationMs: 1200, background: true });
  });

  it('maps successful AskQuestion option ids and freeform answers into the original tool result', () => {
    const questions = [
      { id: 'q-color', prompt: 'Choose a test color', options: [{ id: 'blue', label: 'Blue' }, { id: 'green', label: 'Green' }] },
      { id: 'q-reason', prompt: 'Why?', options: [{ id: 'speed', label: 'Fast' }, { id: 'quality', label: 'Reliable' }] },
      { id: 'q-skipped', prompt: 'Anything else?', options: [{ id: 'yes', label: 'Yes' }] },
    ];
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: query('ask a question') }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'Ask before continuing.' }, { type: 'tool-call', toolCallId: 'question-1', toolName: 'CallDynamicTool', args: { namespace: 'cursor', toolName: 'AskQuestion', arguments: { title: 'Clarify', questions } } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'question-1', toolName: 'CallDynamicTool', result: 'success' }], providerOptions: { cursor: { highLevelToolCallResult: { output: { success: { answers: [
        { questionId: 'q-reason', selectedOptionIds: ['quality'], freeformText: 'Because of the constraints' },
        { questionId: 'q-color', selectedOptionIds: ['green', 'blue'] },
      ] } }, isError: false } } } },
    ];

    const mapped = mapTranscript(messages.map((message, index) => ({ id: `question-${index}`, message }))).find((event) => event.type === 'tool_call_update');
    expect(mapped?.data).toMatchObject({
      toolCallId: 'question-1',
      status: 'completed',
      content: [
        { type: 'question_answer', question: 'Choose a test color', answers: ['Green', 'Blue'] },
        { type: 'question_answer', question: 'Why?', answers: ['Reliable', 'Because of the constraints'] },
        { type: 'question_answer', question: 'Anything else?', answers: [] },
      ],
    });
  });

  it('keeps failed or unresolvable AskQuestion results in generic output', () => {
    const question = { id: 'q1', prompt: 'Choose', options: [{ id: 'a', label: 'Alpha' }] };
    const call: ChatMessage = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'q1-call', toolName: 'AskQuestion', args: { questions: [question] } }] };
    const result = (answers: unknown, isError: boolean): ChatMessage => ({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'q1-call', toolName: 'AskQuestion', result: 'opaque AskQuestion result' }],
      providerOptions: { cursor: { highLevelToolCallResult: { output: { success: { answers } }, isError } } },
    });
    const eventsFor = (message: ChatMessage) => mapTranscript([{ id: 'user', message: { role: 'user', content: [{ type: 'text', text: 'question' }] } }, { id: 'call', message: call }, { id: 'result', message }]).find((event) => event.type === 'tool_call_update')!;

    expect(eventsFor(result([{ questionId: 'q1', selectedOptionIds: ['a'] }], true)).data).toMatchObject({
      status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'opaque AskQuestion result' } }],
    });
    expect(eventsFor(result([{ questionId: 'missing-question', selectedOptionIds: ['a'] }], false)).data).toMatchObject({
      status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'opaque AskQuestion result' } }],
    });
  });

  it('produces the same events incrementally as in one pass', () => {
    const mapper = new TranscriptMapper();
    const incremental = conversation.flatMap((message, index) => mapper.map({ id: `m${index}`, message }));
    expect(incremental).toEqual(events);
  });

  it('parses prompt timestamps and ignores injected context', () => {
    expect(parsePromptTimestamp('Monday, Jan 5, 2026, 9:03 PM (UTC-5)')).toBe('2026-01-06T02:03:00.000Z');
    expect(parsePromptTimestamp('yesterday')).toBeUndefined();
    expect(userQuery({ role: 'user', content: '<user_info>x</user_info>' })).toBeUndefined();
    expect(userQuery({ role: 'user', content: [{ type: 'text', text: 'plain question' }], providerOptions: { cursor: { requestId: 'r1' } } })).toEqual({ text: 'plain question' });
    // The agent's own continuation after a broken stream carries no request id: not a person's prompt.
    expect(userQuery({ role: 'user', content: 'Your previous response was interrupted. Continue from where you left off.' })).toBeUndefined();
  });

  it('maps structural CLI task notifications without inventing a user turn and starts a new assistant boundary', () => {
    const command = "cd /tmp/project && cat > cw.mjs <<'EOF'\ndetail: this is part of the script\nstatus: still script content\ntitle: a literal title\nEOF\nnode cw.mjs";
    const notification = [
      '<timestamp>Thursday, Oct 1, 2026, 10:28 PM (UTC+8)</timestamp>',
      '<system_notification>The following task has finished. If you were already aware, ignore this notification and do not restate prior responses. <task>',
      'kind: shell',
      'status: error',
      'task_id: 534319',
      `title: ${command.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}`,
      'detail: exit_code=1',
      '</task></system_notification>',
      '<user_query>Briefly inform the user about the task result and perform any follow-up actions (if needed).</user_query>',
    ].join('\n');
    expect(userQuery({ role: 'user', content: notification })).toBeUndefined();
    const events = mapTranscript([
      { id: 'human-prompt', message: { role: 'user', content: query('work on the project') } },
      { id: 'human-answer', message: { role: 'assistant', content: [{ type: 'text', text: 'The requested work is done.' }] } },
      { id: 'notification-occurrence', message: { role: 'user', content: notification } },
      { id: 'notification-followup', message: { role: 'assistant', content: [{ type: 'text', text: 'The command failed with exit code 1.' }] } },
    ]);

    expect(events.map((event) => event.type)).toEqual(['user_message_chunk', 'agent_message_chunk', 'task_notification', 'agent_message_chunk']);
    expect(events[1]!.runId).toBe('turn:human-prompt');
    expect(events[2]).toMatchObject({
      type: 'task_notification', runId: 'turn:notification-occurrence', createdAt: '2026-10-01T14:28:00.000Z',
      data: {
        sessionUpdate: 'task_notification', taskId: '534319', kind: 'shell', status: 'failed', sourceStatus: 'error',
        title: command, command, detail: 'exit_code=1', jobResult: { id: '534319', status: 'failed', exitCode: 1 },
      },
    });
    expect(events[3]!.runId).toBe('turn:notification-occurrence');
    expect(events.some((event) => {
      const content = event.data.content;
      return event.type === 'user_message_chunk' && typeof content === 'object' && content !== null
        && 'text' in content && content.text === 'Briefly inform the user about the task result and perform any follow-up actions (if needed).';
    })).toBe(false);
  });

  it('keeps quoted notification markup as a real user query and preserves unreadable notifications', () => {
    const quoted = query('Please inspect these literal tags: <system_notification><task>status: error</task></system_notification>');
    expect(userQuery({ role: 'user', content: quoted })).toEqual({
      text: 'Please inspect these literal tags: <system_notification><task>status: error</task></system_notification>',
      at: '2026-09-30T16:14:00.000Z',
    });
    const userEvents = mapTranscript([{ id: 'quoted-user', message: { role: 'user', content: quoted } }]);
    expect(userEvents).toHaveLength(1);
    expect(userEvents[0]!.type).toBe('user_message_chunk');
    expect(userEvents[0]!.data.content).toEqual({ type: 'text', text: 'Please inspect these literal tags: <system_notification><task>status: error</task></system_notification>' });

    const malformed = '<timestamp>Thursday, Oct 1, 2026, 10:28 PM (UTC+8)</timestamp><system_notification>The CLI task changed format';
    const malformedEvents = mapTranscript([{ id: 'malformed-notice', message: { role: 'user', content: malformed } }]);
    expect(malformedEvents).toHaveLength(1);
    expect(malformedEvents[0]!.data).toMatchObject({ status: 'unknown', title: 'CLI task notification' });
    expect(malformedEvents[0]!.data.detail).toContain('The CLI task changed format');

    const unknownStatus = '<timestamp>Thursday, Oct 1, 2026, 10:28 PM (UTC+8)</timestamp><system_notification><task>kind: shell\nstatus: new-status\ntask_id: 9\ntitle: echo retained</task></system_notification><user_query>Do not show this.</user_query>';
    const unknownEvents = mapTranscript([
      { id: 'unknown-notice', message: { role: 'user', content: unknownStatus } },
      { id: 'after-unknown', message: { role: 'assistant', content: [{ type: 'text', text: 'Still retained.' }] } },
    ]);
    expect(unknownEvents.map((event) => event.type)).toEqual(['task_notification', 'agent_message_chunk']);
    expect(unknownEvents[0]!.data).toMatchObject({ status: 'unknown', sourceStatus: 'new-status', taskId: '9', command: 'echo retained' });
    expect(unknownEvents[1]!.runId).toBe('turn:unknown-notice');

    const missingMetadata = '<timestamp>Thursday, Oct 1, 2026, 10:28 PM (UTC+8)</timestamp><system_notification><task>kind: shell\nnew_field: retained command metadata</task></system_notification>';
    const missingMetadataEvent = mapTranscript([{ id: 'missing-metadata', message: { role: 'user', content: missingMetadata } }])[0]!;
    expect(missingMetadataEvent.data).toMatchObject({ kind: 'shell', status: 'unknown', title: 'CLI task (shell)' });
    expect(missingMetadataEvent.data.detail).toContain('new_field: retained command metadata');

    const withOutputPath = [
      '<timestamp>Monday, Nov 23, 2026, 11:55 AM (UTC+8)</timestamp>',
      '<system_notification>',
      '<task>',
      'kind: shell',
      'status: success',
      'task_id: 16926',
      'title: Count LOC across all platforms',
      'output_path: /home/dev/.cursor/projects/my-repo/agent-tools/25c622ba-5a68-4093-b322-a8aab377f2c5.txt',
      '</task>',
      '</system_notification>',
    ].join('\n');
    const outputPathEvent = mapTranscript([{ id: 'with-output-path', message: { role: 'user', content: withOutputPath } }])[0]!;
    expect(outputPathEvent.data).toMatchObject({
      taskId: '16926', kind: 'shell', status: 'completed', sourceStatus: 'success',
      title: 'Count LOC across all platforms', command: 'Count LOC across all platforms',
      jobResult: { id: '16926', status: 'succeeded' },
    });
    expect((outputPathEvent.data.jobResult as Record<string, unknown>).outputPath).toBeUndefined();

    const withTerminalLogPath = withOutputPath.replace('agent-tools/25c622ba-5a68-4093-b322-a8aab377f2c5.txt', 'terminals/16926.txt');
    const terminalLogEvent = mapTranscript([{ id: 'with-terminal-log', message: { role: 'user', content: withTerminalLogPath } }])[0]!;
    expect(terminalLogEvent.data).toMatchObject({
      title: 'Count LOC across all platforms',
      jobResult: { id: '16926', status: 'succeeded', outputPath: '/home/dev/.cursor/projects/my-repo/terminals/16926.txt' },
    });
  });
});

describe('screen status', () => {
  const footer = (prompt: string) => [
    '  Cursor Agent', '', prompt, '', '',
    '  Claude Opus 5.5 300K High Fast · MAX · 7.4%                          Run Everything',
    '  /private/tmp/probe · master', '', '',
  ].join('\n');

  it('recognises idle, busy and dialog screens', () => {
    expect(parseScreen(footer('  → Add a follow-up'))).toEqual({ phase: 'idle', footer: true, model: 'Claude Opus 5.5 300K High Fast · MAX', permission: 'Run Everything' });
    const picker = ['    Auto                     Balance', ' →  Composer 2.5             (Tab to modify)', '    Claude Opus 5.5          300K High Fast', ' 1-10 of 40', ' Type to filter • Enter to select • Tab to edit'].join('\n');
    expect(parseScreen(picker)).toEqual({ phase: 'attention', footer: false });
    expect(parseScreen(footer('  → Add a follow-up                           ctrl+c to stop')).phase).toBe('busy');
    expect(parseScreen(' ┌──────┐\n │ Question 1 of 1 │\n │ ↑/↓ option · Esc to skip │\n └──────┘\n').phase).toBe('attention');
  });

  it('reads the prompt bar while the exit hint covers the footer after a Ctrl+C', () => {
    const hinted = (...above: string[]) => ['  再运行 shell 命令。', ...above, '  Press Ctrl+C again to exit'].join('\n');
    expect(parseScreen(hinted(' ⠘⠆ Working', '  → Add a follow-up                           ctrl+c to stop'))).toEqual({ phase: 'busy', footer: false });
    expect(parseScreen(hinted('    Edit c.txt Cancelled', '  → Add a follow-up'))).toEqual({ phase: 'idle', footer: false });
    expect(parseScreen(['  Pick a model', '  Press Ctrl+C again to exit'].join('\n')).phase).toBe('attention');
  });

  it('reads the spinner as a turn before the stop hint shows, and while a draft hides it', () => {
    expect(parseScreen(footer(' ⠘⠆ Working\n  → Add a follow-up')).phase).toBe('busy');
    expect(parseScreen(footer(' ⠰⠳ Running  66 tokens\n    Tip: Use /plan to plan execution.\n  → fix the tests')).phase).toBe('busy');
    // A spinner further up belongs to the transcript, not to a turn.
    expect(parseScreen(footer([' ⠘⠆ Working', '  line 1', '  line 2', '  line 3', '  → Add a follow-up'].join('\n'))).phase).toBe('idle');
  });

  it('tells whether a Ctrl+C would stop the turn, and what the follow-up queue holds', () => {
    const processing = footer(' ⠘⠆ Working\n  → Add a follow-up                           ctrl+c to stop');
    expect(turnControls(processing)).toEqual({ stoppable: true, exitArmed: false });
    expect(turnControls(footer(' ⠘⠆ Working\n  → Add a follow-up')).stoppable).toBe(false);
    const armed = [' ⠘⠆ Working', '  → Add a follow-up                           ctrl+c to stop', '  Press Ctrl+C again to exit'].join('\n');
    expect(turnControls(armed)).toEqual({ stoppable: false, exitArmed: true });
    const box = (item: string, hint: string) => footer([
      ' ┌─ follow-ups ───────────────────────────────────────┐',
      ` │○ ${item}                                           │`,
      ` │ ${hint} · ↑ select/edit · esc cancel                │`,
      ' └────────────────────────────────────────────────────┘',
      ' ⠘⠤ Running  66 tokens',
      '  → Add a follow-up                           ctrl+c to stop',
    ].join('\n'));
    expect(turnControls(box('改为创建 z.txt', 'enter steer')).followUps).toEqual({ text: '改为创建 z.txt', next: 'steer' });
    expect(turnControls(box('改为创建 z.txt · steering', 'enter interrupt and send')).followUps).toEqual({ text: '改为创建 z.txt · steering', next: 'interrupt' });
    expect(turnControls(box('改为创建 z.txt', 'enter send now')).followUps?.next).toBe('send');
    expect(turnControls(processing).followUps).toBeUndefined();
  });

  it('reads the error a failed turn leaves under the footer', () => {
    const screen = [footer('  → Add a follow-up'), '  Error: Something went wrong. Please try again.', '  [deadline_exceeded] bidi_append_deadline_exceeded: append seqno=0 (33932 bytes) exceeded 60518ms', '  deadline'].join('\n');
    expect(parseScreen(screen)).toMatchObject({ phase: 'idle', model: 'Claude Opus 5.5 300K High Fast · MAX', error: 'Something went wrong. Please try again. [deadline_exceeded] bidi_append_deadline_exceeded: append seqno=0 (33932 bytes) exceeded 60518ms deadline' });
    const edited = footer('  → Add a follow-up').replace('· 7.4%', '· 59.5% · 14 files edited');
    expect(parseScreen(edited).model).toBe('Claude Opus 5.5 300K High Fast · MAX');
    // The same words in the transcript above the footer are not the CLI's own error.
    expect(parseScreen(['  Error: from a test run', footer('  → Add a follow-up')].join('\n')).error).toBeUndefined();
    // A wrapped error line that starts with a path is not the workspace line.
    const wrapped = [footer('  → Add a follow-up'), '  Error: could not write', '  /tmp/out.txt: permission denied'].join('\n');
    expect(parseScreen(wrapped)).toMatchObject({ phase: 'idle', model: 'Claude Opus 5.5 300K High Fast · MAX', error: 'could not write /tmp/out.txt: permission denied' });
  });

  it('ignores transcript text above the footer', () => {
    const screen = ['  the agent said: press ctrl+c to stop', ...Array.from({ length: 20 }, (_, index) => `  line ${index}`), footer('  → Add a follow-up')].join('\n');
    expect(parseScreen(screen).phase).toBe('idle');
    const nearTail = ['  the agent said: press ctrl+c to stop', '  line 1', '  line 2', '  line 3', footer('  → Add a follow-up')].join('\n');
    expect(parseScreen(nearTail).phase).toBe('idle');
    const commentLines = ['  ctrl+c to stop', '  const x = 1;', '  // a code comment in transcript'].join('\n');
    expect(parseScreen(commentLines)).toEqual({ phase: 'attention', footer: false });
  });

  it('recognises the subagent view opened from the TUI, wrapped title included', () => {
    const body = ['    Read 2 files', '    Read tests/test_runs.py lines 185-209'];
    const working = [...body, '  ⠠⠛ Working', '  Subagent · 先读取 ~/.cursor/plugins/local/personal/agents/implementer.md，严格按其中的原则和输出', '  格式执行。例外：本任  ·  esc to go back'].join('\n');
    expect(parseScreen(working)).toEqual({ phase: 'attention', footer: false, subview: { working: true } });
    const narrow = [...body, '  ⠠⠛ Working', '  Subagent · a prompt long enough', '  to wrap over', '  three lines  ·  esc to go back'].join('\n');
    expect(parseScreen(narrow).subview).toEqual({ working: true });
    const quiet = [...body, '  Subagent · Explore the repo  ·  esc to go back'].join('\n');
    expect(parseScreen(quiet)).toEqual({ phase: 'attention', footer: false, subview: { working: false } });
    const gone = [...body, "  This subagent's live transcript is no longer available.", '  esc to go back'].join('\n');
    expect(parseScreen(gone).subview).toEqual({ working: false });
    // A dialog that mentions going back is not the subagent view.
    expect(parseScreen(['  Pick a model', '  → Composer 2.5', '  Enter to select · esc to go back'].join('\n')).subview).toBeUndefined();
  });
});
