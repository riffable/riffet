import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { assistantProject } from './index.js';
import type { Session, WorkItem, WorkItemEvent } from '../../../../packages/contracts/src/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function boot() {
  const stateDir = await mkdtemp(join(tmpdir(), 'riffet-work-items-'));
  const projectDir = await mkdtemp(join(tmpdir(), 'riffet-work-items-project-'));
  const { app, store, settings, dispatch, nativeBackends, workItems, riffetMcp, assistant } = await createApp({ stateDir, auth: false, cliPath: '/nonexistent/cursor-agent' });
  cleanups.push(async () => { await app.close(); await rm(stateDir, { recursive: true, force: true }); await rm(projectDir, { recursive: true, force: true }); });
  vi.spyOn(dispatch, 'kick').mockImplementation(() => undefined);
  vi.spyOn(nativeBackends, 'assertAvailable').mockImplementation(() => undefined);
  const status = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { host: '127.0.0.1:4317' } });
  const cookie = String(status.headers['set-cookie']).split(';')[0]!;
  const csrf = (status.json() as { csrfToken: string }).csrfToken;
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, extra: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { host: '127.0.0.1:4317', cookie, 'x-csrf-token': csrf, ...extra }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const project = store.createProject(projectDir, 'Tasks');
  const create = (id: string, text = 'Fix the login\nthen more', commandId = `c-${id}`, extra: object = {}) =>
    call('POST', '/api/sessions', { kind: 'native', projectId: project.id, backendId: 'cursor', clientSessionId: id, initialMessage: { commandId, text }, ...extra });
  const items = async () => (await call('GET', '/api/work-items')).json() as { items: WorkItem[] };
  return { store, settings, call, project, projectDir, create, items, workItems, riffetMcp, assistant: assistant!, stateDir };
}

describe('work items', () => {
  it('starts only the task a new conversation names; a composer conversation opens none', async () => {
    const { store, call, create, items, workItems } = await boot();
    const first = await create('s1');
    expect(first.statusCode, first.body).toBe(202);
    expect((await items()).items).toHaveLength(0);
    expect(store.getSession('s1').workItemId).toBeUndefined();

    // Tasks composer conversations opened before go at startup, unless something happened on them.
    const idle = workItems.create({ title: 'Idle', status: 'doing' }, { source: 'composer', originSessionId: 's1' });
    workItems.attachSession('s1', idle.id);
    const discussed = workItems.create({ title: 'Discussed', status: 'doing' }, { source: 'composer' });
    workItems.addComment(discussed.id, 'keep this');
    workItems.dropComposerItems();
    expect((await items()).items.map(entry => entry.id)).toEqual([discussed.id]);
    expect(store.getSession('s1').workItemId).toBeUndefined();
    workItems.delete(discussed.id);

    // 开始 on the board: a conversation named for an item joins it and moves it to doing.
    const todo = (await call('POST', '/api/work-items', { id: 'w-todo', title: 'Later', assignee: { kind: 'agent', backendId: 'cursor' } })).json() as WorkItem;
    expect((await create('s3', 'Later', 'c-s3', { workItemId: todo.id })).statusCode).toBe(202);
    expect(store.getSession('s3').workItemId).toBe(todo.id);
    expect((await items()).items.find(entry => entry.id === todo.id)?.status).toBe('doing');
    expect((await items()).items).toHaveLength(1);

    // A quick chat never belongs to a task.
    const chat = store.updateProject(store.createProject('/tmp/riffet-work-items-chat', 'Chat').id, { system: 'quick-chat' });
    const quick = store.createSession({ projectId: chat.id, kind: 'native', backendId: 'cursor', title: 'Chat' });
    expect((await call('POST', `/api/sessions/${quick.id}/work-item`, { workItemId: 'new' })).statusCode).toBe(409);
    expect((await items()).items).toHaveLength(1);
  });

  it('attaches a conversation, moving todo to doing with its events, and a fork inherits the task', async () => {
    const { store, call, project } = await boot();
    const item = (await call('POST', '/api/work-items', { id: 'w1', title: '  Ship it  ', labels: ['a', 'a', 'b'] })).json() as WorkItem;
    expect(item).toMatchObject({ title: 'Ship it', status: 'todo', labels: ['a', 'b'], number: 1 });
    expect((await call('POST', '/api/work-items', { id: 'w1', title: 'other' })).json()).toMatchObject({ title: 'Ship it' });
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor', title: 'Work' });
    const attached = (await call('POST', `/api/sessions/${session.id}/work-item`, { workItemId: 'w1' })).json() as { session: Session; workItem: WorkItem };
    expect(attached.session.workItemId).toBe('w1');
    expect(attached.workItem.status).toBe('doing');
    const events = (await call('GET', '/api/work-items/w1/events')).json() as WorkItemEvent[];
    expect(events.map(event => event.kind)).toEqual(['created', 'session', 'status']);
    expect((await call('PATCH', '/api/work-items/w1', { title: 'Renamed', status: 'review' })).json()).toMatchObject({ title: 'Renamed', status: 'review' });
    expect((await call('POST', '/api/work-items/w1/comments', { id: 'k1', text: 'hi' })).statusCode).toBe(200);
    expect((await call('POST', '/api/work-items/w1/comments', { id: 'k1', text: 'hi' })).statusCode).toBe(200);
    expect((await call('GET', '/api/work-items/w1/events')).json()).toHaveLength(5);

    const fork = store.createNativeSubmission('fork-1', { projectId: project.id, backendId: 'cursor', origin: { kind: 'fork', sessionId: session.id } }, 'c1', { text: 'go', attachmentIds: [], context: [] });
    expect(fork.session.workItemId).toBe('w1');

    expect((await call('DELETE', '/api/work-items/w1')).statusCode).toBe(204);
    expect(store.getSession(session.id).workItemId).toBeUndefined();
    expect((await call('GET', '/api/work-items/w1/events')).statusCode).toBe(404);
  });

  it('answers 304 for a matching ETag and moves the revision on writes', async () => {
    const { store, call } = await boot();
    const first = await call('GET', '/api/work-items');
    const etag = String(first.headers.etag);
    expect((await call('GET', '/api/work-items', undefined, { 'if-none-match': etag })).statusCode).toBe(304);
    const before = store.workItemsRevision;
    await call('POST', '/api/work-items', { title: 'One' });
    expect(store.workItemsRevision).toBeGreaterThan(before);
    expect((await call('GET', '/api/work-items', undefined, { 'if-none-match': etag })).statusCode).toBe(200);
  });

  it('takes a submission with evidence read from the conversation, and sends an answer once', async () => {
    const { store, call, create, projectDir, workItems, riffetMcp } = await boot();
    const id = ((await call('POST', '/api/work-items', { id: 'w-login', title: 'Fix the login', assignee: { kind: 'agent', backendId: 'cursor' } })).json() as WorkItem).id;
    expect((await create('s1', 'Fix the login', 'c-s1', { workItemId: id })).statusCode).toBe(202);
    expect((await call('PATCH', `/api/work-items/${id}`, { criteria: ['Tests pass', '  Lint is clean '] })).json()).toMatchObject({ criteria: ['Tests pass', 'Lint is clean'] });
    expect(riffetMcp.tools(store.getSession('s1')).map(tool => tool.name)).toContain('task_submit');

    // What the conversation ran and edited, as its CLI recorded it.
    // A call's start says what it was, its update how it ended; a subagent's lane counts as the conversation's own.
    const iso = (offset: number) => new Date(Date.now() + 1000 + offset).toISOString();
    const tool = (lane: string, callId: string, offset: number, start: object, end: object) => store.journal.append(lane, [
      { kind: 'tool_call', nativeId: `${callId}:start`, at: iso(offset), payload: { type: 'tool_call', data: { toolCallId: callId, status: 'in_progress', ...start } } },
      { kind: 'tool_call_update', nativeId: `${callId}:end`, at: iso(offset + 1), payload: { type: 'tool_call_update', data: { toolCallId: callId, ...end } } },
    ]);
    tool('s1', 't1', 0, { kind: 'execute', command: 'pnpm test' }, { status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Exit code 1\nfail' } }] });
    tool('s1#sub:agent-1', 't2', 2, { kind: 'edit', locations: [{ path: join(projectDir, 'src/login.ts') }] }, { status: 'completed' });
    tool('s1', 't3', 4, { kind: 'execute', command: 'pnpm test' }, { status: 'completed', exitCode: 0 });

    // The agent's word is recorded beside the evidence, not instead of it.
    const submitted = workItems.submit('s1', { summary: 'Fixed it; all green', criteria: [{ met: true, note: 'pnpm test' }] });
    expect(submitted.status).toBe('review');
    expect(submitted.submission).toMatchObject({
      summary: 'Fixed it; all green',
      criteria: [{ text: 'Tests pass', met: true, note: 'pnpm test' }, { text: 'Lint is clean' }],
      evidence: { files: ['src/login.ts'], commands: [{ command: 'pnpm test', result: 'ok', exitCode: 0, sessionId: 's1' }] },
    });

    // An answer reaches the conversation once, however often it is retried.
    const question = workItems.ask('s1', { question: 'Keep the old endpoint?', options: ['Yes', 'No'] });
    const runs = store.listRuns('s1').length;
    for (let i = 0; i < 2; i++) expect((await call('POST', `/api/work-items/${id}/questions/${question.id}/answer`, { text: 'No', commandId: 'a1' })).statusCode).toBe(200);
    expect(store.listRuns('s1')).toHaveLength(runs + 1);
    expect((await call('GET', '/api/work-items')).json().items[0].questions).toBeUndefined();

    // Rework goes back to doing and sends the reasons once.
    for (let i = 0; i < 2; i++) expect((await call('POST', `/api/work-items/${id}/rework`, { text: 'Lint still fails', commandId: 'r1' })).json()).toMatchObject({ status: 'doing' });
    expect(store.listRuns('s1')).toHaveLength(runs + 2);
    expect((await call('GET', `/api/work-items/${id}/brief`)).json().text).toContain('Fixed it; all green');
  });

  it('records what held the owner up, from the conversations\' own state changes', async () => {
    const { store, call, project, workItems } = await boot();
    const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'cursor', title: 'Work' });
    const task = workItems.create({ title: 'Work', projectId: project.id });
    workItems.attachSession(session.id, task.id);
    const at = (iso: string, state: Session['state']) => { vi.setSystemTime(new Date(iso)); store.updateSession(session.id, { state }); };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      at('2026-11-10T02:00:00Z', 'running');
      at('2026-11-10T02:01:00Z', 'waiting'); // an approval
      at('2026-11-10T02:03:00Z', 'running');
      at('2026-11-10T02:10:00Z', 'idle'); // the turn ends
      at('2026-11-10T02:40:00Z', 'running'); // the owner comes back half an hour later
      at('2026-11-10T02:50:00Z', 'idle');
      vi.setSystemTime(new Date('2026-11-10T03:00:00Z'));
      workItems.patch(task.id, { status: 'done' }); // the owner settles it ten minutes later
      at('2026-11-13T09:00:00Z', 'running'); // coming back days later is not a wait
    } finally { vi.useRealTimers(); }
    const report = (await call('GET', '/api/work-items/north-star?from=2026-11-10T00:00:00Z&to=2026-11-11T00:00:00Z&tz=UTC')).json() as { days: Array<{ date: string; decisions: number; waitMs: number }> };
    expect(report.days.find(day => day.date === '2026-11-10')).toMatchObject({ decisions: 1, waitMs: 2 * 60_000 + 30 * 60_000 + 10 * 60_000 });
  });

  it('lets the assistant plan and start tasks, each start opening one conversation', async () => {
    const { store, call, project, items, riffetMcp, assistant } = await boot();
    const home = store.listProjects().find(entry => entry.system === 'assistant')!;
    // The assistant's own conversation is not a task, and only it is given the board tools.
    expect((await call('POST', '/api/sessions', { kind: 'native', projectId: home.id, backendId: 'cursor', clientSessionId: 'a1', initialMessage: { commandId: 'c-a1', text: 'Fix the login and add a test' } })).statusCode).toBe(202);
    expect(store.getSession('a1').workItemId).toBeUndefined();
    expect(riffetMcp.tools(store.getSession('a1')).map(tool => tool.name)).toContain('task_create');
    expect((await call('POST', '/api/sessions', { kind: 'native', projectId: project.id, backendId: 'cursor', clientSessionId: 's1', initialMessage: { commandId: 'c-s1', text: 'Other work' } })).statusCode).toBe(202);
    expect(riffetMcp.tools(store.getSession('s1')).map(tool => tool.name)).not.toContain('task_create');

    // A planned change waits for the owner; starting it opens one conversation that carries the brief.
    const planned = await assistant.call('task_create', { title: 'Fix the login', criteria: ['Tests pass'], project: 'Tasks', agent: 'cursor', start: false }) as { created: { task: number; status: string } };
    expect(planned.created).toMatchObject({ status: 'todo' });
    const item = (await items()).items.find(entry => entry.number === planned.created.task)!;
    expect(item).toMatchObject({ source: 'assistant', projectId: project.id, assignee: { kind: 'agent', backendId: 'cursor' } });
    const before = store.listSessions().length;
    const [first, second] = await Promise.allSettled([call('POST', `/api/work-items/${item.id}/start`), assistant.call('task_start', { task: `#${item.number}` })]);
    expect([first, second].filter(result => result.status === 'fulfilled' && (!('statusCode' in result.value) || (result.value as { statusCode: number }).statusCode === 200))).toHaveLength(1);
    const opened = store.listSessions().filter(session => session.workItemId === item.id);
    expect(store.listSessions()).toHaveLength(before + 1);
    expect(opened).toHaveLength(1);
    expect(store.listRuns(opened[0]!.id)[0]!.prompt).toContain('Fix the login');
    expect(opened[0]!.title).toBe('Fix the login');
    expect((await items()).items.find(entry => entry.id === item.id)!.status).toBe('doing');
  });

  it("keeps the owner's edit of the assistant's instructions across restarts, and restores Riffet's own on request", async () => {
    const { store, call, stateDir } = await boot();
    const read = async () => (await call('GET', '/api/assistant/instructions')).json() as { text: string; custom: boolean };
    const builtIn = await read();
    expect(builtIn.custom).toBe(false);
    expect(readFileSync(join(stateDir, 'assistant', 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
    expect((await call('PUT', '/api/assistant/instructions', { text: 'Answer in one line.' })).json()).toEqual({ text: 'Answer in one line.\n', custom: true });
    assistantProject(store, stateDir);
    expect(readFileSync(join(stateDir, 'assistant', 'AGENTS.md'), 'utf8')).toBe('Answer in one line.\n');
    expect((await call('PUT', '/api/assistant/instructions', { text: null })).json()).toEqual(builtIn);
  });
});
