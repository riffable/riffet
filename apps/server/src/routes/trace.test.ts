import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TracePage, TraceRowDetail, TraceSummary } from '../../../../packages/contracts/src/trace.js';
import { createApp } from '../app.js';

// The trace routes (docs/TRACE.md) as a client reads them: the index never resolves a blob, pages chain by `next`,
// a row read resolves its blob, and a generation the lane no longer has is refused.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe('session trace routes', () => {
  it('pages the journal as written, resolves one row whole, and refuses a stale generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'riffet-trace-'));
    const { app, store } = await createApp({ stateDir: join(root, 'state'), auth: false, cliPath: '/nonexistent/cursor-agent' });
    cleanups.push(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
    const auth = await app.inject({ url: '/api/auth/status', headers: { host: '127.0.0.1:4317' } });
    const headers = { host: '127.0.0.1:4317', cookie: String(auth.headers['set-cookie']).split(';')[0]! };
    const project = store.createProject(root, 'Trace');
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor', title: 'Traced' });
    const output = 'x'.repeat(10_000);
    const call = (status: string, content?: string) => ({
      type: status === 'in_progress' ? 'tool_call' : 'tool_call_update', runId: 'run-1',
      data: { toolCallId: 'call-1', toolName: 'Bash', status, kind: 'execute', rawInput: { command: 'ls' }, ...(content ? { content: [{ type: 'content', content: { type: 'text', text: content } }] } : {}) },
    });
    store.journal.append(session.id, [
      { kind: 'meta.turn_started', nativeId: 'meta:turn:t1:started', turnId: 't1', at: '2026-11-21T00:00:00.000Z', payload: { turnId: 't1', runId: 'run-1' } },
      { kind: 'tool_call', nativeId: 'call-1', turnId: 't1', at: '2026-11-21T00:00:01.000Z', payload: call('in_progress') },
      { kind: 'tool_call_update', nativeId: 'call-1:result', turnId: 't1', at: '2026-11-21T00:00:03.000Z', payload: call('completed', output) },
      { kind: 'meta.turn_ended', nativeId: 'meta:turn:t1:ended', turnId: 't1', at: '2026-11-21T00:00:04.000Z', payload: { turnId: 't1', status: 'failed', error: 'quota' } },
    ]);
    const get = <T>(path: string) => app.inject({ url: `/api/sessions/${session.id}/trace${path}`, headers }).then((response) => ({ status: response.statusCode, body: response.json() as T }));

    const summary = await get<TraceSummary>('');
    expect(summary.status).toBe(200);
    expect(summary.body.lanes).toEqual([expect.objectContaining({ lane: 'main', lastSeq: 4, rows: 4 })]);
    const generation = summary.body.lanes[0]!.generation;

    const first = await get<TracePage>('/rows?lane=main&after=0&limit=2');
    expect(first.body.rows.map((row) => row.seq)).toEqual([1, 2]);
    expect(first.body.next).toBe(2);
    const rest = await get<TracePage>(`/rows?lane=main&after=2&limit=2&generation=${generation}`);
    expect(rest.body.next).toBeUndefined();
    const [result, ended] = rest.body.rows;
    // Hidden rows are listed, and a spilled payload is indexed from its inline preview alone.
    expect(ended).toMatchObject({ kind: 'meta.turn_ended', status: 'failed', error: true, text: 'quota' });
    expect(result).toMatchObject({ kind: 'tool_call_update', blob: true, toolCallId: 'call-1', status: 'completed', name: 'Bash' });
    expect(result!.bytes).toBeGreaterThan(output.length);

    const detail = await get<TraceRowDetail>(`/rows/3?lane=main&generation=${generation}`);
    expect(detail.status).toBe(200);
    expect((detail.body.payload as ReturnType<typeof call>).data.content![0]!.content.text).toBe(output);
    expect(detail.body.blobRef).toMatch(/^[0-9a-f]{64}$/);

    expect((await get('/rows?lane=main&generation=stale')).status).toBe(409);
    expect((await get('/rows/99?lane=main')).status).toBe(404);
    expect((await get('/rows?lane=sub:nothing')).status).toBe(404);

    // The request context is read from the agent's own transcript; a conversation without one says so rather than failing.
    const requests = await get<{ status: string; prompts: unknown[] }>('/requests?lane=main');
    expect(requests.status).toBe(200);
    expect(['unsupported', 'missing']).toContain(requests.body.status);
    expect(requests.body.prompts).toEqual([]);
  });
});
