import Fastify from 'fastify';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StatsDashboard } from '../../../../packages/contracts/src/index.js';
import { Store } from '../store.js';
import { StatsLedger } from './ledger.js';
import { registerStatsRoutes, toCsv } from './routes.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function server() {
  const store = new Store(':memory:');
  const ledger = new StatsLedger(store);
  const app = Fastify();
  registerStatsRoutes(app, { store, auth:{onRevoke:()=>()=>undefined}, subscribe: listener => ledger.subscribe(listener) });
  await app.ready();
  cleanups.push(async () => { await app.close(); ledger.close(); store.close(); });
  const project = store.createProject('/tmp/routes', 'Routes');
  const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'codex', title: 'Chat, "quoted"' });
  for (let index = 0; index < 3; index += 1) {
    const run = store.acceptNativeRun(session.id, `c${index}`, { text: 'hi', attachmentIds: [], context: [] }, { mode: 'agent', model: 'gpt' });
    ledger.recordUsage(session.id, run.id, { stepId: `turn:${index}`, inputTokens: 10, cacheReadTokens: 5, outputTokens: 20, tokenSource: 'provider', startedAt: Date.now() });
    store.transitionNativeRun(run.id, ['queued'], { delivery: 'observed' }, { state: 'completed' });
  }
  return { app, store, project };
}

describe('stats routes', () => {
  it('notifies an open stats stream when a managed task becomes a visible project', async () => {
    const { app, store, project } = await server();
    store.updateProject(project.id, { system: 'task-workspace' });
    expect((await app.inject({ method: 'GET', url: '/api/stats/runs' })).json().rows).toEqual([]);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as import('node:net').AddressInfo;
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, path: '/api/stats/stream' }, resolve);
      request.on('error', reject);
      request.end();
    });
    cleanups.unshift(() => { response.destroy(); });
    expect(response.statusCode).toBe(200);
    let notifications = 0;
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      body += chunk;
      notifications = (body.match(/"type":"stats_changed"/g) ?? []).length;
    });
    await vi.waitFor(() => expect(notifications).toBe(1));
    store.promoteTaskWorkspace(project.id, 'Saved project');
    await vi.waitFor(() => expect(notifications).toBe(2));
    const rows = (await app.inject({ method: 'GET', url: '/api/stats/runs' })).json().rows;
    expect(rows).toHaveLength(3);
    expect(rows.every((row: { projectName: string }) => row.projectName === 'Saved project')).toBe(true);
  });

  it('serves a dashboard for the default window', async () => {
    const { app } = await server();
    const response = await app.inject({ method: 'GET', url: '/api/stats/dashboard?tz=Asia/Shanghai&backend=codex' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as StatsDashboard;
    expect(body.filter).toMatchObject({ tz: 'Asia/Shanghai', backends: ['codex'], includeArchived: true });
    expect(body.summary.current).toMatchObject({ runs: 3, sessions: 1, totalTokens: 105 });
    expect(body.summary.current.tokens).toMatchObject({ input: 30, cacheRead: 15, cacheWrite: null, output: 60 });
    expect(body.backends.rows[0]).toMatchObject({ key: 'codex', label: 'Codex', backendId: 'codex', count: 3 });
    expect(body.options.models.map(model => model.key)).toEqual(['gpt']);
    expect(body.series.split).toBe('backend');
  });

  it('rejects malformed filters with 400', async () => {
    const { app } = await server();
    expect((await app.inject({ method: 'GET', url: '/api/stats/dashboard?from=yesterday' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/stats/dashboard?from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/stats/series?metric=nope' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/stats/runs?cursor=garbage' })).statusCode).toBe(400);
  });

  it('pages runs with an opaque cursor', async () => {
    const { app } = await server();
    const first = (await app.inject({ method: 'GET', url: '/api/stats/runs?limit=2' })).json() as { rows: unknown[]; nextCursor?: string };
    expect(first.rows).toHaveLength(2);
    const second = (await app.inject({ method: 'GET', url: `/api/stats/runs?limit=2&cursor=${first.nextCursor}` })).json() as { rows: unknown[]; nextCursor?: string };
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
  });

  it('exports CSV as an attachment with escaped cells', async () => {
    const { app } = await server();
    const response = await app.inject({ method: 'GET', url: '/api/stats/export?format=csv' });
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('attachment');
    const [header, row] = response.body.split('\r\n');
    expect(header!.startsWith('run_id,session_id,session_title')).toBe(true);
    expect(row).toContain('"Chat, ""quoted"""');
  });

  it('writes empty CSV cells for unreported values', () => {
    const csv = toCsv([{ runId: 'r', sessionId: 's', sessionTitle: 't', projectId: 'p', projectName: 'P', backendId: 'cursor', state: 'completed', createdAt: 'x', durationMs: null, ttftMs: null, tokens: { input: null, cacheRead: null, cacheWrite: null, output: 3, reasoning: null, estimatedOutput: 3 }, totalTokens: 3, toolCalls: 0 }]);
    expect(csv.split('\r\n')[1]).toBe('r,s,t,P,cursor,,completed,x,,,,,,3,,3,0');
  });
});
