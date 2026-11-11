import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectCodexItem } from './project-item.js';
import { rolloutItemSpans } from './item-spans.js';

const THREAD = '01a11b9b-9b5d-7303-8091-b6e4d2afea97';
const completed = (at: string, item: Record<string, unknown>) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'item_completed', turn_id: 't1', item } });
const command = { type: 'CommandExecution', id: 'exec-1', duration: { secs: 2, nanos: 500_000_000 } };

let home: string | undefined;
afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); home = undefined; });

describe('rolloutItemSpans', () => {
  it('stamps a command with its own start and end, and reads only what a growing rollout gained', async () => {
    home = await mkdtemp(join(tmpdir(), 'riffet-spans-'));
    const dir = join(home, 'sessions', '2026', '11', '08');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `rollout-2026-11-08T00-00-00-${THREAD}.jsonl`);
    // The second line is still being written.
    await writeFile(file, `${completed('2026-11-08T10:00:10.500Z', command)}\n${completed('2026-11-08T10:00:20.000Z', { type: 'AgentMessage', id: 'msg_1' }).slice(0, 40)}`);
    const first = await rolloutItemSpans(home, THREAD);
    expect(first?.({ type: 'commandExecution', id: 'exec-1' })).toEqual({ startedAt: '2026-11-08T10:00:08.000Z', completedAt: '2026-11-08T10:00:10.500Z' });
    expect(first?.({ type: 'agentMessage', id: 'msg_1' })).toBeUndefined();

    await appendFile(file, `${completed('2026-11-08T10:00:20.000Z', { type: 'AgentMessage', id: 'msg_1' }).slice(40)}\n`);
    const second = await rolloutItemSpans(home, THREAD);
    expect(second?.({ type: 'agentMessage', id: 'msg_1' })).toEqual({ startedAt: '2026-11-08T10:00:20.000Z', completedAt: '2026-11-08T10:00:20.000Z' });

    const span = second?.({ type: 'commandExecution', id: 'exec-1' });
    const events = projectCodexItem({ type: 'commandExecution', id: 'exec-1', command: 'ls', status: 'completed', aggregatedOutput: '' }, { id: 't1' } as never, {
      sessionId: 's', threadId: 'th', runId: 'r', createdAt: '2026-11-08T10:00:00.000Z', ...(span ? { span } : {}),
    });
    expect(events.map(event => [event.type, event.createdAt])).toEqual([
      ['tool_call', '2026-11-08T10:00:08.000Z'], ['tool_call_update', '2026-11-08T10:00:10.500Z'],
    ]);
  });
});
