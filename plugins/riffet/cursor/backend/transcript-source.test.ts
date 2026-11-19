import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatReader, TranscriptMapper, type ChatMessage } from '../native/chat-store.js';
import { digestIds } from '../native/transcript.js';
import { FakeLaneWriter, FakeLanes, pullLane } from '../testing/fake-lane-writer.js';
import { assertUnchanged, checkSession, rowsOf, runIngestContract, snapshot, visibleLanes, type IngestContractFixture } from '../testing/ingest-checks.js';
import type { CursorLiveStep } from '../native/live.js';
import { CursorTranscriptSource, type CursorTranscriptLimits, type CursorTranscriptSignals } from './transcript-source.js';

/*
 * Chat stores in the shape the chat-store tests write them (content-addressed blobs, a protobuf root
 * listing message ids, compaction archives in field 13, the step in flight in field 4), rewritten
 * the way the CLI rewrites its root as a conversation goes on.
 */
function varint(value: number): number[] {
  const bytes: number[] = [];
  while (value > 0x7f) { bytes.push((value & 0x7f) | 0x80); value = Math.floor(value / 128); }
  bytes.push(value);
  return bytes;
}
const field = (number: number, payload: Uint8Array) => Buffer.from([...varint(number * 8 + 2), ...varint(payload.length), ...payload]);

interface Chat { messages: ChatMessage[]; meta?: Record<string, unknown>; compactAt?: number; summary?: ChatMessage; pending?: ChatMessage }

/** Writes `chat` as its root says it now: messages before `compactAt` (after the first two) archived behind `summary`. */
function writeChat(dir: string, chatId: string, chat: Chat): string {
  mkdirSync(join(dir, chatId), { recursive: true });
  const db = new DatabaseSync(join(dir, chatId, 'store.db'));
  db.exec('CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);');
  const put = (data: Buffer) => {
    const id = createHash('sha256').update(data).digest('hex');
    db.prepare('INSERT OR IGNORE INTO blobs VALUES (?, ?)').run(id, data);
    return id;
  };
  const ref = (number: number, message: ChatMessage) => field(number, Buffer.from(put(Buffer.from(JSON.stringify(message))), 'hex'));
  const { messages, compactAt, summary } = chat;
  const live = compactAt && summary ? [...messages.slice(0, 2), summary, ...messages.slice(compactAt)] : messages;
  const archive = compactAt && summary ? [field(13, Buffer.from(put(Buffer.concat([...messages.slice(2, compactAt).map(message => ref(1, message)), ref(4, summary)])), 'hex'))] : [];
  const root = Buffer.concat([...live.map(message => ref(1, message)), ...(chat.pending ? [field(4, Buffer.from(JSON.stringify(chat.pending)))] : []), ...archive]);
  const rootId = put(root);
  db.prepare("INSERT OR REPLACE INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify({ agentId: chatId, latestRootBlobId: rootId, name: 'Probe', ...chat.meta })).toString('hex'));
  db.close();
  return rootId;
}

const query = (text: string) => `<timestamp>Thursday, Oct 1, 2026, 12:14 AM (UTC+8)</timestamp>\n<user_query>\n${text}\n</user_query>`;
const ask = (text: string, requestId?: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text: query(text) }], ...(requestId ? { providerOptions: { cursor: { requestId } } } : {}) });
const say = (text: string): ChatMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });
const call = (id: string, toolName: string, args: unknown): ChatMessage => ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, args }] });
const result = (id: string, toolName: string, value: unknown, output?: unknown): ChatMessage => ({
  role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName, result: value }],
  ...(output ? { providerOptions: { cursor: { highLevelToolCallResult: { output, isError: false } } } } : {}),
});
const todo = (id: string, args: unknown) => call(id, 'CallDynamicTool', { namespace: 'cursor', toolName: 'TodoWrite', arguments: args });
const notification = (taskId: string): ChatMessage => ({ role: 'user', content: [
  '<system_notification>The following task has finished. <task>', 'kind: shell', 'status: success', `task_id: ${taskId}`, 'title: npm test', 'detail: exit_code=0', '</task></system_notification>',
  '<user_query>Briefly inform the user about the task result.</user_query>',
].join('\n') });
const SYSTEM: ChatMessage[] = [{ role: 'system', content: 'You are an agent.' }, { role: 'user', content: '<user_info>\nOS Version: darwin\n</user_info>' }];
const questions = [{ id: 'q-color', prompt: 'Choose a color', options: [{ id: 'blue', label: 'Blue' }, { id: 'green', label: 'Green' }] }];

const agentId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
/** A subagent: its task prompt, a read, its answer. */
const subagentChat = (name: string): ChatMessage[] => [...SYSTEM, ask(`task ${name}`, `req-${name}`), call(`${name}-read`, 'Read', { path: '/p/a.ts' }), result(`${name}-read`, 'Read', 'file'), say(`found it (${name})`)];
const task = (id: string, agent: string): ChatMessage[] => [
  call(id, 'Task', { description: 'Look around', subagent_type: 'explore', prompt: 'list files' }),
  result(id, 'Task', 'This is the output of the subagent:\n\nfound', { success: { agentId: agent, durationMs: '1200' } }),
];

/** A conversation with a compaction archive, todos merged across turns, a subagent, a task notification and a question. */
function history(): ChatMessage[] {
  return [
    ...SYSTEM,
    ask('run echo hi', 'req-t1'), call('t1-shell', 'Shell', { command: 'echo hi' }), result('t1-shell', 'Shell', 'Exit code: 0', { success: { stdout: 'hi\n', interleavedOutput: 'hi\n' } }), say('Ran it.'),
    ask('plan it', 'req-t2'), todo('t2-todo', { todos: [{ id: 'a', content: 'First', status: 'in_progress' }, { id: 'b', content: 'Second', status: 'pending' }] }), result('t2-todo', 'CallDynamicTool', 'ok'), say('Planned.'),
    ask('go on', 'req-t3'), todo('t3-todo', { merge: true, todos: [{ id: 'a', status: 'completed' }] }), result('t3-todo', 'CallDynamicTool', 'ok'), say('First done.'),
    ask('look around', 'req-t4'), ...task('t4-task', agentId(1)), say('Looked.'),
    notification('534319'), say('The tests passed.'),
    ask('ask me', 'req-t5'), call('t5-ask', 'CallDynamicTool', { namespace: 'cursor', toolName: 'AskQuestion', arguments: { title: 'Clarify', questions } }),
    result('t5-ask', 'CallDynamicTool', 'success', { success: { answers: [{ questionId: 'q-color', selectedOptionIds: ['green'] }] } }), say('Green it is.'),
    ask('wrap up', 'req-t6'), say('Done.'),
  ];
}
/** The archive covers the first two turns, so it is long behind the tail window. */
const COMPACT_AT = 2 + 8;
const SUMMARY: ChatMessage = { role: 'user', content: `Your conversation was summarized.\n\n<summary_content>\nRan echo and planned.\n</summary_content>` };

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function cursorFixture(limits: Partial<CursorTranscriptLimits> = {}): IngestContractFixture {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-ingest-'));
  dirs.push(dir);
  const listeners = new Set<CursorTranscriptSignals>();
  let chatId = 'chat-1';
  const chat: Chat = { messages: history(), compactAt: COMPACT_AT, summary: SUMMARY };
  const write = () => { writeChat(dir, chatId, chat); for (const listener of listeners) listener.changed(); };
  writeChat(dir, agentId(1), { messages: subagentChat('a1'), meta: { subagentInfo: { parentAgentId: 'chat-1', toolCallId: 't4-task' } } });
  write();
  let appended = 0;
  return {
    scratch: true,
    source: () => new CursorTranscriptSource({
      chatsDir: () => dir, chatId: () => chatId, sessionId: 'contract-session',
      signals: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      limits: { stepMessages: 6, tailTurns: 2, ...limits },
    }),
    append: () => {
      appended += 1;
      chat.messages.push(ask(`more ${appended}`, `req-more-${appended}`), call(`more-${appended}-shell`, 'Shell', { command: 'ls' }), result(`more-${appended}-shell`, 'Shell', 'Exit code: 0'), say(`more ${appended} done`));
      write();
    },
    // `/rewind` to the last prompt and send it edited: the same places now hold other messages.
    update: () => {
      const last = chat.messages.findLastIndex(message => message.role === 'user');
      chat.messages.splice(last, chat.messages.length - last, ask('more, edited', 'req-edited'), say('edited answer'));
      write();
    },
    // Typed into the CLI: no request id is recorded for it.
    terminalTurn: () => { chat.messages.push(ask('typed in the terminal'), call('typed-grep', 'Grep', { pattern: 'x' }), result('typed-grep', 'Grep', 'none'), say('Nothing found.')); write(); },
    subagent: () => {
      writeChat(dir, agentId(2), { messages: subagentChat('a2'), meta: { subagentInfo: { parentAgentId: 'chat-1', toolCallId: 'sub-task' } } });
      chat.messages.push(ask('another look', 'req-sub'), ...task('sub-task', agentId(2)), say('Looked again.'));
      write();
    },
    changeIdentity: () => { chatId = 'chat-2'; writeChat(dir, chatId, { messages: [...SYSTEM, ask('new chat', 'req-n1'), say('Hello.')] }); },
  };
}

/** Pulls until caught up, as the ingest does. */
async function catchUp(source: CursorTranscriptSource, writer: FakeLaneWriter, signal = new AbortController().signal): Promise<void> {
  for (let pulls = 0; pulls < 100; pulls += 1) if ((await pullLane(source, writer, signal)).caughtUp) return;
  throw new Error('the source did not catch up');
}

function openLanes() {
  const lanes = new FakeLanes();
  return { lanes, writer: FakeLaneWriter.open(lanes) };
}

const turnEnds = (lanes: FakeLanes) => rowsOf(lanes).filter(row => row.kind === 'meta.turn_ended').map(row => [row.turnId, (row.payload as { status: string }).status]);

describe('Cursor transcript source', () => {
  it('upgrades a pending child call without resurrecting a retired draft', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-draft-upgrade-'));
    dirs.push(dir);
    writeChat(dir, 'chat-1', { messages: [...SYSTEM, ask('explore', 'req-1')], pending: {
      role: 'assistant', content: [
        { type: 'tool-call', toolCallId: 'active-child', toolName: 'Subagent', args: { description: 'Explore files', subagent_type: 'explore' } },
        { type: 'tool-call', toolCallId: 'retired-child', toolName: 'Subagent', args: { description: 'Old task', subagent_type: 'explore' } },
      ],
    } });
    const { lanes, writer } = openLanes();
    const source = () => new CursorTranscriptSource({ chatsDir: () => dir, chatId: () => 'chat-1' });
    await catchUp(source(), writer);
    const active = writer.entity('3:0')!;
    const payload = active.payload as { data: Record<string, unknown> };
    const { subagent: _subagent, ...data } = payload.data;
    lanes.append('main', [{ kind: 'draft', nativeId: '3:0', turnId: active.turnId, at: active.at, payload: { ...payload, data: { ...data, kind: 'other', title: 'Subagent' } } }]);
    const legacy = JSON.parse(writer.cursor!);
    delete legacy.mapping;
    writer.commit({ events: [], retire: ['3:1'], cursor: JSON.stringify(legacy) });
    await catchUp(source(), writer);
    expect(writer.entity('3:0')!.payload).toMatchObject({ data: { kind: 'agent', subagent: { type: 'explore' } } });
    expect(writer.entity('3:1')?.kind).toBe('tombstone');
    expect(turnEnds(lanes)).toEqual([]);
  });
  it('repairs legacy payloads across restarted pulls without changing receipts or terminal turn outcomes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-upgrade-'));
    dirs.push(dir);
    const childId = agentId(9);
    const prompt: ChatMessage = { ...ask('look at this image', 'req-image'), content: [
      { type: 'image', image: { type: 'Buffer', data: [1] }, mimeType: 'image/png' },
      { type: 'text', text: '<image_files>\n1. /tmp/cursor assets/example.png\n</image_files>' },
      { type: 'text', text: query('look at this image') },
    ] };
    const messages = [...SYSTEM, prompt,
      call('child-call', 'CallDynamicTool', { namespace: 'cursor', toolName: 'Subagent', arguments: { description: 'Explore images', subagent_type: 'explore', prompt: 'Find the picture' } }),
      result('child-call', 'CallDynamicTool', 'This is the output of the subagent: Found it', { success: { agentId: childId, durationMs: 1200 } }),
      call('glob-call', 'Glob', { glob_pattern: '**/*.png', target_directory: '/tmp/cursor assets' }), result('glob-call', 'Glob', 'example.png'), say('Found it.'),
      ask('run a build', 'req-cancelled'), call('build', 'Shell', { command: 'build' }), result('build', 'Shell', 'Aborted'),
    ];
    writeChat(dir, 'chat-1', { messages });
    writeChat(dir, childId, { messages: subagentChat('image'), meta: { subagentInfo: { parentAgentId: 'chat-1', toolCallId: 'child-call', typeName: 'explore' } } });
    const { lanes, writer } = openLanes();
    const reader = new ChatReader(join(dir, 'chat-1', 'store.db'));
    const snapshot = reader.snapshot()!;
    const mapper = new TranscriptMapper();
    const legacyEvents = snapshot.messageIds.flatMap((blob, position) => mapper.map({ id: `${position}:${blob}`, message: reader.message(blob)! }).map((event, part) => {
      const data = { ...event.data };
      if (data.toolName === 'Subagent') { data.kind = 'other'; data.title = 'Subagent'; delete data.subagent; }
      if (data.toolCallId === 'child-call') delete data.subagentResult;
      if (data.toolName === 'Glob') delete data.locations;
      delete data.attachments;
      return { ...event, data, sequence: 0, sessionId: 's', nativeId: `${position}:${part}`, nativeAliases: [`${position}:${blob}:${part}`], createdAt: '2026-10-25T08:00:00.000Z' };
    }));
    writer.commit({ events: legacyEvents, cursor: JSON.stringify({ v: 1, from: 0, n: snapshot.messageIds.length, len: snapshot.messageIds.length, root: snapshot.meta.latestRootBlobId, digest: digestIds(snapshot.messageIds), mapper: mapper.state(), turn: { id: 'req-cancelled', run: mapper.run, ended: true, at: '2026-10-25T08:00:00.000Z' }, recent: ['req-image', 'req-cancelled'], placed: {}, children: [] }) });
    writer.turnEnded('req-image', 'failed', '2026-10-25T08:00:01.000Z', 'original failure');
    writer.turnEnded('req-cancelled', 'cancelled', '2026-10-25T08:00:02.000Z');
    const original = rowsOf(lanes);
    const generation = writer.generation;
    const originalEnds = original.filter(row => row.kind === 'meta.turn_ended');
    reader.close();
    // The old root can be pruned while its complete prefix survives in the current root.
    writeChat(dir, 'chat-1', { messages: [...messages, ask('another question', 'req-new'), say('A new answer.')] });
    const store = new DatabaseSync(join(dir, 'chat-1', 'store.db'));
    store.prepare('DELETE FROM blobs WHERE id=?').run(snapshot.meta.latestRootBlobId!);
    store.close();
    const source = () => new CursorTranscriptSource({ chatsDir: () => dir, chatId: () => 'chat-1', sessionId: 's', limits: { stepMessages: 3, sliceMs: 40 } });
    // An unavailable old root waits for another observation instead of causing an immediate pull loop.
    const unavailable = vi.spyOn(ChatReader.prototype, 'snapshot').mockImplementationOnce(() => undefined).mockImplementationOnce(() => undefined);
    expect((await pullLane(source(), writer, new AbortController().signal)).caughtUp).toBe(true);
    unavailable.mockRestore();
    const bindChild = writer.child.bind(writer);
    writer.child = () => { throw new Error('binding interrupted'); };
    await expect(catchUp(source(), writer)).rejects.toThrow('binding interrupted');
    expect(JSON.parse(writer.cursor!).reproject.n).toBeLessThanOrEqual(4);
    writer.child = bindChild;
    for (let tries = 0; tries < 100; tries++) if ((await pullLane(source(), writer, new AbortController().signal)).caughtUp) break;
    expect(JSON.parse(writer.cursor!).mapping).toBe(3);
    expect(writer.generation).toBe(generation);
    expect(rowsOf(lanes).filter(row => row.kind === 'meta.turn_ended' && ['req-image', 'req-cancelled'].includes(row.turnId!))).toEqual(originalEnds);
    const repaired = rowsOf(lanes);
    const user = repaired.findLast(row => row.kind === 'user_message_chunk' && row.turnId === 'req-image')!;
    expect((user.payload as { data: Record<string, unknown> }).data.attachments).toEqual([{ type: 'image', name: 'example.png', path: '/tmp/cursor assets/example.png', mimeType: 'image/png' }]);
    const child = repaired.find(row => row.kind === 'meta.subagent')!;
    expect(child.turnId).toBe('req-image');
    expect(child.payload).toMatchObject({ toolCallId: 'child-call', agentId: childId, title: 'Explore images', subagentType: 'explore' });
    const repairedCall = repaired.findLast(row => (row.payload as { data?: { toolName?: string } }).data?.toolName === 'Subagent')!;
    expect(repairedCall.payload).toMatchObject({ data: { kind: 'agent', title: 'Explore images' } });
    for (const row of original.filter(row => !row.kind.startsWith('meta.'))) {
      const current = writer.entity(row.nativeId)!;
      expect(current.identity).toBe(row.seq);
      expect(current.turnId).toBe(row.turnId);
      expect(current.at).toBe(row.at);
      expect((current.payload as { nativeAliases?: unknown }).nativeAliases).toEqual((row.payload as { nativeAliases?: unknown }).nativeAliases);
    }
    const settled = snapshotJournal();
    await catchUp(source(), writer);
    expect(snapshotJournal()).toEqual(settled);
    function snapshotJournal() { return rowsOf(lanes).length; }
  });
  it('does not restore a child binding retired before an adapter upgrade', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-retired-upgrade-'));
    dirs.push(dir);
    const childId = agentId(8);
    writeChat(dir, 'chat-1', { messages: [...SYSTEM, ask('look', 'req-1'),
      call('retired', 'Subagent', { description: 'Old task', subagent_type: 'explore' }),
      result('retired', 'Subagent', 'Done', { success: { agentId: childId } }), say('Done.'),
    ] });
    writeChat(dir, childId, { messages: subagentChat('old') });
    const { lanes, writer } = openLanes();
    const source = () => new CursorTranscriptSource({ chatsDir: () => dir, chatId: () => 'chat-1' });
    await catchUp(source(), writer);
    writer.commit({ events: [], cursor: writer.cursor, retire: [
      'meta:subagent:retired', ...writer.toolEntities('retired').map(row => row.nativeId),
    ] });
    const legacy = JSON.parse(writer.cursor!);
    delete legacy.mapping;
    writer.commit({ events: [], cursor: JSON.stringify(legacy) });
    await catchUp(source(), writer);
    expect(writer.entity('meta:subagent:retired')?.kind).toBe('tombstone');
    expect(writer.toolEntities('retired')).toEqual([]);
  });
  it('holds the ingest contract over a chat store', async () => {
    const report = await runIngestContract(cursorFixture());
    expect(report.served.map(item => item.scratch)).toEqual([true, false]);
    expect(report.lanes.main).toBeGreaterThan(0);
  });

  it('holds the ingest contract when every read lets the event loop turn after each message', async () => {
    const report = await runIngestContract(cursorFixture({ sliceMs: 0 }));
    expect(report.served.map(item => item.scratch)).toEqual([true, false]);
  });

  it('reads a slice at a time into the same lanes as one read, and a read stopped mid-rewind commits nothing', async () => {
    const run = async (sliceMs: number) => {
      const fixture = cursorFixture({ sliceMs });
      const { lanes, writer } = openLanes();
      await catchUp(fixture.source() as CursorTranscriptSource, writer);
      fixture.update();
      if (sliceMs === 0) {
        // Stopped at its first turn of the event loop, inside the rewind: nothing it held in memory is committed.
        const before = snapshot(lanes);
        const controller = new AbortController();
        const stopped = pullLane(fixture.source() as CursorTranscriptSource, writer, controller.signal);
        controller.abort();
        expect(await stopped).toEqual({ caughtUp: false });
        assertUnchanged(before, snapshot(lanes), 'a read stopped mid-rewind');
      }
      await catchUp(fixture.source() as CursorTranscriptSource, writer);
      fixture.append();
      fixture.subagent!();
      await catchUp(fixture.source() as CursorTranscriptSource, writer);
      checkSession(lanes);
      const rows = new Map([...snapshot(lanes)].map(([key, log]) => [key, log.rows]));
      const visible = visibleLanes(lanes);
      const subagents = rowsOf(lanes).filter(row => row.kind === 'meta.subagent').map(row => row.payload);
      return { rows, lanes: visible, subagents };
    };
    const sliced = await run(0), whole = await run(60_000);
    expect(sliced.rows).toEqual(whole.rows);
    expect(sliced.lanes).toEqual(whole.lanes);
    // What the `Task` call asked for reaches the subagent's row.
    expect(whole.subagents).toContainEqual(expect.objectContaining({ toolCallId: 't4-task', title: 'Look around', subagentType: 'explore' }));
  });

  it('ends a stopped foreground subagent at its failed Task result, and leaves a background one running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-stopped-child-'));
    dirs.push(dir);
    const stopped = agentId(5), background = agentId(6);
    const listeners = new Set<CursorTranscriptSignals>();
    const source = () => new CursorTranscriptSource({
      chatsDir: () => dir, chatId: () => 'chat-1', sessionId: 's',
      signals: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    });
    // Both subagents are cut off after a tool result: the CLI writes no end to a subagent's store.
    const cutOff = (name: string) => [...SYSTEM, ask(`task ${name}`, `req-${name}`), call(`${name}-read`, 'Read', { path: '/p/a.ts' }), result(`${name}-read`, 'Read', 'file')];
    writeChat(dir, stopped, { messages: cutOff('stopped') });
    writeChat(dir, background, { messages: cutOff('background') });
    const messages = [...SYSTEM, ask('split the work', 'req-1'),
      call('bg-task', 'Task', { description: 'Watch', subagent_type: 'explore', prompt: 'watch', run_in_background: true }),
      result('bg-task', 'Task', 'Started', { success: { agentId: background, isBackground: true } }),
      call('fg-task', 'Task', { description: 'Refactor', subagent_type: 'generalPurpose', prompt: 'refactor' })];
    writeChat(dir, 'chat-1', { messages });
    const { lanes, writer } = openLanes();
    const first = source();
    const unwatch = first.watch(writer, () => undefined);
    // The CLI holds the running subagent's store open; that names it before any result does.
    for (const listener of listeners) listener.subagent('fg-task', stopped);
    await catchUp(first, writer);
    unwatch();
    expect(turnEnds(lanes)).toEqual([]);

    messages.push(result('fg-task', 'Task', 'Error: CallDynamicTool was interrupted by the user before it completed.', { error: { message: 'interrupted' } }), say('Stopped.'));
    writeChat(dir, 'chat-1', { messages });
    await catchUp(source(), writer);
    const childEnds = (toolCallId: string) => rowsOf(lanes, `sub:${toolCallId}`).filter(row => row.kind === 'meta.turn_ended').map(row => (row.payload as { status: string }).status);
    expect(childEnds('fg-task')).toEqual(['interrupted']);
    expect(childEnds('bg-task')).toEqual([]);
    expect(JSON.parse(writer.cursor!).children.map(([toolCallId]: [string]) => toolCallId)).toEqual(['bg-task']);
  });

  it('ends a turn whose last step never returns after reading what is on disk, once, and later rows open a turn of their own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-ingest-'));
    dirs.push(dir);
    const messages = [...SYSTEM, ask('run the tests', 'req-1'), call('t1-shell', 'Shell', { command: 'npm test' })];
    writeChat(dir, 'chat-1', { messages });
    const { lanes, writer } = openLanes();
    const source = () => new CursorTranscriptSource({ chatsDir: () => dir, chatId: () => 'chat-1', sessionId: 's' });
    await catchUp(source(), writer);
    checkSession(lanes, { openLastTurn: true });
    expect(turnEnds(lanes)).toEqual([]);

    // Interrupted: the CLI commits the call it cut short, and its hook says the turn is over before anything reads it.
    messages.push(result('t1-shell', 'Shell', 'Aborted'));
    writeChat(dir, 'chat-1', { messages });
    await source().endTurn(writer, { status: 'cancelled', at: '2026-10-25T08:00:00.000Z', turnId: 'another-turn' });
    expect(turnEnds(lanes)).toEqual([]);
    await source().endTurn(writer, { status: 'cancelled', at: '2026-10-25T08:00:00.000Z', turnId: 'req-1' });
    expect(turnEnds(lanes)).toEqual([['req-1', 'cancelled']]);
    const rows = rowsOf(lanes);
    expect(rows.findIndex(row => row.kind === 'tool_call_update')).toBeLessThan(rows.findIndex(row => row.kind === 'meta.turn_ended'));
    expect(rows.find(row => row.kind === 'meta.turn_ended')?.at).toBe('2026-10-25T08:00:00.000Z');
    checkSession(lanes);

    // The hook again, a restarted service, a replay from the cursor: nothing new.
    const ended = snapshot(lanes);
    await source().endTurn(writer, { status: 'cancelled', at: '2026-10-25T08:00:01.000Z', turnId: 'req-1' });
    await source().endTurn(writer, { status: 'completed', at: '2026-10-25T08:00:01.000Z' });
    await catchUp(source(), writer);
    assertUnchanged(ended, snapshot(lanes), 'ending an ended turn and reading on');

    // A resumed CLI writes a continuation with the old request id; its own end must survive a reopen.
    messages.push(say('Stopped.'));
    writeChat(dir, 'chat-1', { messages });
    const resumed = new CursorTranscriptSource({ chatsDir: () => dir, chatId: () => 'chat-1', tailState: () => 'live' });
    await catchUp(resumed, writer);
    const continuation = rowsOf(lanes).findLast(row => row.kind === 'agent_message_chunk')!.turnId!;
    expect(continuation).not.toBe('req-1');
    expect(await resumed.endTurn(writer, { status: 'completed', at: '2026-10-25T08:01:00.000Z', turnId: 'req-1' })).toBe(true);
    expect(writer.turnEndStatus(continuation)).toBe('completed');
    expect(writer.turnEndStatus('req-1')).toBe('cancelled');
    messages.push(ask('go on', 'req-2'), say('Done.'));
    writeChat(dir, 'chat-1', { messages });
    await catchUp(source(), writer);
    checkSession(lanes);
    const ends = turnEnds(lanes);
    expect(ends).toHaveLength(3);
    expect(ends[0]).toEqual(['req-1', 'cancelled']);
    expect(ends.at(-1)).toEqual(['req-2', 'completed']);
    expect(rowsOf(lanes).filter(row => row.turnId === 'req-1' && row.kind === 'agent_message_chunk')).toEqual([]);
  });

  it('keeps reasoning and later output in the live turn until its matching end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-ingest-'));
    dirs.push(dir);
    const thought: ChatMessage = { role: 'assistant', content: [{ type: 'reasoning', text: 'Plan the work.' }] };
    const messages = [...SYSTEM, ask('run the tests', 'req-1'), thought];
    const thoughtRoot = writeChat(dir, 'chat-1', { messages });
    const { lanes, writer } = openLanes();
    let live: CursorLiveStep | undefined;
    const source = new CursorTranscriptSource({
      chatsDir: () => dir, chatId: () => 'chat-1', tailState: () => 'live',
      live: { read: () => live, watch: () => () => {} },
    });
    const at = '2026-11-18T06:48:08.000Z';
    await catchUp(source, writer);
    expect(turnEnds(lanes)).toEqual([]);

    messages.push(call('tests', 'Shell', { command: 'npm test' }), result('tests', 'Shell', 'Running...'));
    writeChat(dir, 'chat-1', { messages });
    await catchUp(source, writer);
    expect(turnEnds(lanes)).toEqual([]);
    // Cursor rewrites a tool-result blob in place (such as an inspected image) as the turn continues.
    messages.splice(messages.length - 1, 1, result('tests', 'Shell', 'Passed'), say('The tests passed.'));
    writeChat(dir, 'chat-1', { messages });
    await source.endTurn(writer, { status: 'completed', at, turnId: 'req-1', expectedRoot: thoughtRoot });
    expect(turnEnds(lanes)).toEqual([]);
    await source.endTurn(writer, { status: 'completed', at, turnId: 'req-1' });
    const rows = rowsOf(lanes);
    expect(rows.filter(row => !row.kind.startsWith('meta.')).map(row => [row.kind, row.turnId])).toEqual([
      ['user_message_chunk', 'req-1'],
      ['agent_thought_chunk', 'req-1'],
      ['tool_call', 'req-1'],
      ['tool_call_update', 'req-1'],
      ['tool_call_update', 'req-1'],
      ['agent_message_chunk', 'req-1'],
    ]);
    expect(rows.at(-1)?.kind).toBe('meta.turn_ended');

    messages.push(ask('check again', 'req-2'), thought);
    const nextRoot = writeChat(dir, 'chat-1', { messages });
    await catchUp(source, writer);
    await source.endTurn(writer, { status: 'completed', at, turnId: 'req-1' });
    expect(turnEnds(lanes)).toEqual([['req-1', 'completed']]);
    // Another model step starts after the idle observation, before either its text or checkpoint lands.
    live = { turn: 'req-2', at, step: 'retry', prompt: 'check again', sealed: false, parts: [] };
    expect(await source.endTurn(writer, { status: 'completed', at, turnId: 'req-2', expectedRoot: nextRoot })).toBe(false);
    expect(writer.turnEndStatus('req-2')).toBeUndefined();
    live = undefined;
    await source.endTurn(writer, { status: 'completed', at, turnId: 'req-2', expectedRoot: nextRoot });
    expect(turnEnds(lanes)).toEqual([['req-1', 'completed'], ['req-2', 'completed']]);
    checkSession(lanes);
  });

  it('records an interrupted live turn when the terminal exits without another checkpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-ingest-'));
    dirs.push(dir);
    writeChat(dir, 'chat-1', { messages: [...SYSTEM, ask('check the file', 'req-1'), call('tool', 'Read', { path: 'file' })] });
    const { lanes, writer } = openLanes();
    const source = (state: 'live' | 'exited') => new CursorTranscriptSource({ chatsDir: () => dir, chatId: () => 'chat-1', tailState: () => state });
    await catchUp(source('live'), writer);
    expect(turnEnds(lanes)).toEqual([]);
    await catchUp(source('exited'), FakeLaneWriter.open(lanes));
    expect(turnEnds(lanes)).toEqual([['req-1', 'interrupted']]);
  });

  it('retains an explicit failure when the import replaces its scratch transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-ingest-'));
    dirs.push(dir);
    const messages = [...SYSTEM, ask('check the files', 'req-1'), say('Checked.'), ask('build it', 'req-2'), say('The build failed.')];
    const root = writeChat(dir, 'chat-1', { messages });
    const { lanes, writer } = openLanes();
    const source = () => new CursorTranscriptSource({
      chatsDir: () => dir, chatId: () => 'chat-1', tailState: () => 'live', limits: { stepMessages: 2 },
    });
    await pullLane(source(), writer, new AbortController().signal);
    expect(writer.scratch).toBeDefined();
    expect(writer.scratch?.turnEndStatus('req-2')).toBeUndefined();
    const at = '2026-11-18T06:48:08.000Z';
    const error = 'Network Error: Unable to connect to the model provider';
    await source().endTurn(writer, { status: 'failed', at, turnId: 'req-2' });
    // Stop reported just the outcome. The settled footer supplies its reason later.
    await source().endTurn(writer, { status: 'failed', at: '2026-11-18T06:48:13.000Z', turnId: 'req-2', expectedRoot: root, error });
    expect(writer.scratch?.turnEnd('req-2')).toEqual({ status: 'failed', at, error });

    const restarted = FakeLaneWriter.open(lanes);
    await catchUp(source(), restarted);
    expect(restarted.scratch).toBeUndefined();
    expect(turnEnds(lanes)).toEqual([['req-1', 'completed'], ['req-2', 'failed']]);
    expect(restarted.turnEnd('req-2')).toEqual({ status: 'failed', at, error });
    checkSession(lanes);
  });

  it('writes the step in flight as drafts under the ids its message takes, and retires what it did not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-ingest-'));
    dirs.push(dir);
    const chat: Chat = { messages: [...SYSTEM, ask('ask me', 'req-1')] };
    const step: ChatMessage = { role: 'assistant', content: [{ type: 'text', text: 'Two ways to go.' }, { type: 'tool-call', toolCallId: 'q1', toolName: 'AskQuestion', args: { questions: [] } }] };
    writeChat(dir, 'chat-1', { ...chat, pending: step });
    const { lanes, writer } = openLanes();
    const pull = () => pullLane(new CursorTranscriptSource({ chatsDir: () => dir, chatId: () => 'chat-1' }), writer, new AbortController().signal);
    await pull();
    expect(rowsOf(lanes).filter(row => row.kind === 'draft').map(row => row.nativeId)).toEqual(['3:0', '3:1']);
    checkSession(lanes, { openLastTurn: true });

    // The CLI commits the step as only its text: the text replaces its draft, the call's draft goes.
    writeChat(dir, 'chat-1', { messages: [...chat.messages, say('Two ways to go.'), say('Picked one.')] });
    await pull();
    const latest = (id: string) => writer.entity(id)?.kind;
    expect([latest('3:0'), latest('3:1'), latest('4:0')]).toEqual(['agent_message_chunk', 'tombstone', 'agent_message_chunk']);
    checkSession(lanes);
  });

  it('drafts the live step with the prompt the store has not recorded until the store takes both over, and ends a turn it never records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-ingest-'));
    dirs.push(dir);
    const before = [...SYSTEM, ask('hi', 'req-0'), say('Hello.')];
    writeChat(dir, 'chat-1', { messages: before });
    let live: CursorLiveStep | undefined;
    const source = new CursorTranscriptSource({ chatsDir: () => dir, chatId: () => 'chat-1', live: { read: () => live, watch: () => () => {} } });
    const { lanes, writer } = openLanes();
    const pull = () => pullLane(source, writer, new AbortController().signal);
    const shown = () => rowsOf(lanes).filter(row => row.kind === 'draft').map(row => row.nativeId);
    const latest = (id: string) => writer.entity(id);
    await pull();

    // Mid-step the store still ends on the last answer: the prompt opens the turn, the step follows it.
    const at = '2026-11-11T09:00:00.000Z';
    live = { turn: 'req-1', at, prompt: 'explain', step: 'r1:1', sealed: false, parts: [{ type: 'reasoning', text: 'Think' }, { type: 'text', text: 'Pelicans ' }] };
    await pull();
    expect(shown()).toEqual(['4:0', '5:0', '5:1']);
    expect(['4:0', '5:0', '5:1'].map(id => (latest(id)?.payload as { type?: string; nativeTurnId?: string }))).toMatchObject([
      { type: 'user_message_chunk', nativeTurnId: 'req-1' }, { type: 'agent_thought_chunk', nativeTurnId: 'req-1' }, { type: 'agent_message_chunk', nativeTurnId: 'req-1' },
    ]);
    // The run's receipt names the prompt by its request id, which the draft and the stored copy both carry.
    const aliases = () => (latest('4:0')?.payload as { nativeAliases?: string[] }).nativeAliases;
    expect(aliases()).toContain('request:req-1');
    live = { ...live, sealed: true, parts: [{ type: 'reasoning', text: 'Think' }, { type: 'text', text: 'Pelicans fly.' }] };
    await pull();
    expect((latest('5:1')?.payload as { data: { content: { text: string } } }).data.content.text).toBe('Pelicans fly.');

    // The checkpoint lands: the prompt and the step are the store's under the same ids, the turn its own.
    const step: ChatMessage = { role: 'assistant', content: [{ type: 'reasoning', text: 'Think' }, { type: 'text', text: 'Pelicans fly.' }] };
    writeChat(dir, 'chat-1', { messages: [...before, ask('explain', 'req-1')], pending: step });
    await pull();
    expect(latest('4:0')?.kind).toBe('user_message_chunk');
    expect(aliases()).toContain('request:req-1');
    writeChat(dir, 'chat-1', { messages: [...before, ask('explain', 'req-1'), step] });
    await pull();
    expect(['5:0', '5:1'].map(id => latest(id)?.kind)).toEqual(['agent_thought_chunk', 'agent_message_chunk']);
    expect(turnEnds(lanes)).toEqual([['req-0', 'completed'], ['req-1', 'completed']]);
    checkSession(lanes);

    // A CLI stopped before the step's checkpoint: its drafts go and the turn it opened ends.
    live = { turn: 'req-2', at, prompt: 'again', step: 'r2:1', sealed: false, parts: [{ type: 'text', text: 'Half' }] };
    await pull();
    expect(shown().slice(-2)).toEqual(['6:0', '7:0']);
    live = undefined;
    await pull();
    expect(['6:0', '7:0'].map(id => latest(id)?.kind)).toEqual(['tombstone', 'tombstone']);
    expect(turnEnds(lanes).at(-1)).toEqual(['req-2', 'interrupted']);
    checkSession(lanes);
  });
});
