import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as droidHistory from '../droid/history.js';
import * as claudeHistory from '../claude/history.js';
import { readContextFile } from '../../context-references/read-file.js';
import { readClaudeShare, readDroidShare } from './share-read.js';
import { ClaudeBackendAdapter } from '../claude/index.js';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe('strict static Droid history', () => {
  it('reads only the committed native prefix and checks the byte budget before allocating', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'riffet-reference-read-')); directories.push(directory);
    const file = join(directory, 'history.jsonl');
    await writeFile(file, '{"saved":true}\n{"pending":');
    const signal = new AbortController().signal;
    expect(await readContextFile(file, 100, signal)).toBe('{"saved":true}\n');
    await expect(readContextFile(file, 3, signal)).rejects.toMatchObject({ code: 'SESSION_REFERENCE_TOO_LARGE' });
    const stopped = new AbortController(); stopped.abort();
    await expect(readContextFile(file, 100, stopped.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('associates each Claude response model with its own messages without exporting raw configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'riffet-share-claude-')); directories.push(directory);
    const file = join(directory, 'session.jsonl');
    await writeFile(file, ['one', 'two'].flatMap((id, index) => [
      JSON.stringify({ type: 'user', uuid: `${id}-u`, timestamp: '2026-10-23T10:00:00Z', message: { role: 'user', content: `Question ${index}` } }),
      JSON.stringify({ type: 'assistant', uuid: `${id}-a`, timestamp: '2026-10-23T10:00:01Z', message: { model: `model-${index}`, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `Answer ${index}` }], apiKey: 'secret' } }),
    ]).join('\n') + '\n');
    vi.spyOn(claudeHistory, 'findClaudeTranscript').mockResolvedValue(file);
    const result = await readClaudeShare({ id: 'session', nativeSessionId: 'native-session' } as never, directory, { messagesOnly: true });
    const answers = result.events.filter(event => event.type === 'agent_message_chunk');
    expect(answers.map(event => result.modelInfo?.[event.nativeId]?.model)).toEqual(['model-0', 'model-1']);
    expect(JSON.stringify(result)).not.toContain('secret');
    const adapter = new ClaudeBackendAdapter();
    const original = await readFile(file, 'utf8');
    await writeFile(file, original + [
      { type: 'user', uuid: 'summary', isCompactSummary: true, message: { role: 'user', content: 'Synthetic compaction summary' } },
      { type: 'user', uuid: 'output', message: { role: 'user', content: '<local-command-stdout>Local output</local-command-stdout>' } },
    ].map(row => JSON.stringify({ ...row, timestamp: '2026-10-23T10:01:00Z' })).join('\n') + '\n');
    const reference = await adapter.stored.context!({} as never, { id: 'session', nativeSessionId: 'native-session' } as never,
      { config: {} } as never, { maxBytes: 1024 * 1024, signal: new AbortController().signal });
    expect(reference.filter(event => event.type === 'user_message_chunk').map(event => (event.data.content as { text: string }).text)).toEqual(['Question 0', 'Question 1']);
  });

  it.each([
    ['corrupt committed record', '{broken}\n'],
    ['missing parent', `${JSON.stringify({ type: 'message', id: 'child', parentId: 'absent', timestamp: '2026-10-23T10:00:00Z', message: { id: 'child', role: 'user', content: [{ type: 'text', text: 'Question' }] }, seq: 1 })}\n`],
  ])('refuses %s without mutating a native runtime', async (_label, content) => {
    const directory = await mkdtemp(join(tmpdir(), 'riffet-share-droid-')); directories.push(directory);
    const file = join(directory, 'session.jsonl'); await writeFile(file, content);
    vi.spyOn(droidHistory, 'findDroidTranscript').mockResolvedValue(file);
    await expect(readDroidShare({ getProject: () => ({ cwd: directory }) } as never, { id: 'session', projectId: 'project', nativeSessionId: 'native-session' } as never)).rejects.toMatchObject({ code: 'SHARE_HISTORY_UNAVAILABLE' });
  });

  it('reads the parent without opening unavailable child histories in messages-only mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'riffet-share-droid-')); directories.push(directory);
    const file = join(directory, 'session.jsonl');
    const row = (id: string, parentId: string, role: string, content: unknown[], seq: number) => JSON.stringify({ type: 'message', id, parentId, seq, timestamp: '2026-10-23T10:00:00Z', message: { role, content } });
    await writeFile(file, [
      row('user', '', 'user', [{ type: 'text', text: 'Question' }], 1),
      row('assistant', 'user', 'assistant', [{ type: 'tool_use', id: 'task', name: 'Task', input: { prompt: 'Investigate' } }], 2),
      row('result', 'assistant', 'user', [{ type: 'tool_result', tool_use_id: 'task', content: 'session_id: broken-child\n## Report\nResult' }], 3),
    ].join('\n') + '\n');
    const find = vi.spyOn(droidHistory, 'findDroidTranscript').mockImplementation(async id => id === 'native-session' ? file : undefined);
    const host = { getProject: () => ({ cwd: directory }), findRunIdByNativeMessage: () => undefined } as never;
    const session = { id: 'session', projectId: 'project', nativeSessionId: 'native-session' } as never;
    const reading = await readDroidShare(host, session, { messagesOnly: true });
    expect(reading.events.some(event => event.data.subagentResult)).toBe(true);
    expect(reading.subagents).toEqual([]);
    expect(find).toHaveBeenCalledTimes(1);
    expect((await readDroidShare(host, session)).warnings).toEqual(['子 Agent broken-child 的历史不可用']);
    const controller = new AbortController();
    find.mockImplementation(async id => {
      if (id !== 'native-session') controller.abort();
      return file;
    });
    await expect(readDroidShare(host, session, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
