import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Project, RunMetrics, Session } from '../../../../../packages/contracts/src/index.js';
import type { UsageRecord } from '../../stats/types.js';
import type { NativeBackendHost, NativeBackendProfileConfig } from '../types.js';
import { ClaudeBackendAdapter } from './index.js';

const nativeSessionId = '11111111-1111-4111-8111-111111111111';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function transcript(lines: unknown[]): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'claude-usage-'));
  dirs.push(dir);
  const root = join(dir, 'projects', 'demo');
  mkdirSync(root, { recursive: true });
  const file = join(root, `${nativeSessionId}.jsonl`);
  writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return { dir, file };
}

describe('Claude usage ledger', () => {
  it('recovers metrics by native receipt after pending delivery is gone and keeps repeated CLI turns separate', async () => {
    const { dir, file } = transcript([
      { type: 'user', uuid: 'u1', timestamp: '2026-10-04T05:00:00.000Z', message: { role: 'user', content: 'same prompt' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-10-04T05:00:02.000Z', message: { id: 'm1', role: 'assistant',
        content: [{ type: 'text', text: 'first answer' }], usage: { output_tokens: 90 } } },
      { type: 'assistant', isSidechain: true, uuid: 'child', timestamp: '2026-10-04T05:00:03.000Z', message: { id: 'child-m', role: 'assistant',
        content: [{ type: 'text', text: 'child answer' }], usage: { output_tokens: 9999 } } },
      { type: 'user', uuid: 'u2', timestamp: '2026-10-04T05:00:04.000Z', message: { role: 'user', content: 'same prompt' } },
      { type: 'assistant', uuid: 'a2', timestamp: '2026-10-04T05:00:06.000Z', message: { id: 'm2', role: 'assistant',
        content: [{ type: 'text', text: 'second answer' }], usage: { output_tokens: 180 } } },
    ]);
    utimesSync(file, new Date(0), new Date(0));
    const session = { id: 'claude-session', kind: 'native', backendId: 'claude', nativeSessionId, projectId: 'p' } as Session;
    const saved: Array<{ runId: string; metrics: RunMetrics }> = [];
    const host = {
      findRunIdByCommand: () => undefined,
      findRunIdByNativeMessage: (_sessionId: string, id: string) => id === `claude:${nativeSessionId}:u1:0` ? 'run-first' : undefined,
      saveRunMetrics: (runId: string, metrics: RunMetrics) => { saved.push({ runId, metrics }); },
    } as unknown as NativeBackendHost;
    const profile = { id: 'local', name: 'Claude', backendId: 'claude', config: { configDir: dir } } as NativeBackendProfileConfig;
    const result = await new ClaudeBackendAdapter().usageTranscript(host, session, profile);
    expect(saved.at(-1)).toMatchObject({ runId: 'run-first', metrics: { outputTokens: 90, durationMs: 2000, steps: 1, window: 'transcript' } });
    expect(result?.entries.map(entry => [entry.usage.stepId, entry.runId])).toEqual([['m1', 'run-first'], ['m2', undefined]]);
    expect(result?.entries[1]?.usage.nativeMessageId).toBe(`claude:${nativeSessionId}:u2:0`);
  });

  it('records a settled response and a subagent total, and skips the response still in progress', async () => {
    const usage: Array<{ sessionId: string; runId: string | undefined; usage: UsageRecord }> = [];
    transcript([
      { type: 'user', uuid: 'u1', timestamp: '2026-10-04T05:00:00.000Z', message: { role: 'user', content: 'go' } },
      {
        type: 'assistant', uuid: 'a1', timestamp: '2026-10-04T05:00:02.000Z',
        message: {
          id: 'msg_1', role: 'assistant', model: 'claude-sonnet-4-5',
          content: [
            { type: 'text', text: 'partial' },
            { type: 'tool_use', id: 'tool-1', name: 'Agent', input: { subagent_type: 'Explore', prompt: 'look' } },
          ],
          usage: { output_tokens: 10, input_tokens: 80, cache_creation_input_tokens: 5, cache_read_input_tokens: 10 },
        },
      },
      {
        type: 'assistant', uuid: 'a2', timestamp: '2026-10-04T05:00:03.000Z',
        message: {
          id: 'msg_1', role: 'assistant', model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'done' }],
          usage: { output_tokens: 50, input_tokens: 100, cache_creation_input_tokens: 30, cache_read_input_tokens: 20 },
        },
      },
      {
        type: 'user', uuid: 'n1', timestamp: '2026-10-04T05:00:06.000Z',
        message: {
          role: 'user',
          content: '<task-notification><tool-use-id>tool-1</tool-use-id><status>completed</status><summary>Agent "look" finished</summary><usage><subagent_tokens>900</subagent_tokens><duration_ms>3000</duration_ms></usage></task-notification>',
        },
      },
      {
        type: 'assistant', uuid: 'a3', timestamp: '2026-10-04T05:00:08.000Z',
        message: {
          id: 'msg_live', role: 'assistant', model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'still writing' }],
          usage: { output_tokens: 3, input_tokens: 999 },
        },
      },
    ]);
    const session = {
      id: 'session-claude', projectId: 'project-claude', kind: 'native', title: 'Claude', tags: [],
      state: 'running', mode: 'agent', backendId: 'claude', nativeSessionId, terminalId: 'term-1',
      createdAt: '', updatedAt: '',
    } as Session;
    const project = { id: 'project-claude', name: 'Project', cwd: '/repo', createdAt: '', updatedAt: '' } as Project;
    const profile = { id: 'local', backendId: 'claude', name: 'Claude', config: { configDir: dirs.at(-1) } } as NativeBackendProfileConfig;
    const host = {
      getSession: () => session,
      getProject: () => project,
      updateSession: (_id: string, patch: Partial<Session>) => Object.assign(session, patch),
      setNativeSessionId: (_id: string, id: string | undefined) => { session.nativeSessionId = id; return session; },
      findRunIdByCommand: () => undefined,
      stats: {
        recordUsage: (sessionId: string, runId: string | undefined, record: UsageRecord) => { usage.push({ sessionId, runId, usage: record }); },
        observeEvents: () => undefined,
      },
      terminal: { get: async () => { throw new Error('no terminal'); }, screen: async () => undefined },
    } as unknown as NativeBackendHost;
    const adapter = new ClaudeBackendAdapter();
    const stop = adapter.subscribe(host, session, profile, () => undefined);
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && usage.length < 2) await new Promise(resolve => setTimeout(resolve, 10));
    stop();
    await adapter.dispose(host, session.id);

    const parent = usage.find(item => item.usage.stepId === 'msg_1');
    const child = usage.find(item => item.usage.stepId === 'subagent:tool-1');
    expect(parent?.usage).toMatchObject({
      model: 'claude-sonnet-4-5',
      inputTokens: 100,
      cacheReadTokens: 20,
      cacheWriteTokens: 30,
      outputTokens: 50,
      tokenSource: 'provider',
      window: 'transcript',
    });
    expect(child?.usage).toMatchObject({
      agentKind: 'subagent',
      subagentType: 'Explore',
      parentStepId: 'msg_1',
      outputTokens: 900,
      tokenSource: 'provider',
    });
    expect(usage.some(item => item.usage.stepId === 'msg_live' || item.usage.inputTokens === 999)).toBe(false);
  });
});
