import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { Store } from '../store.js';
import { AssistantDelegations } from './delegations.js';
import { assistantProject } from '../work-items/index.js';

/*
 * The 助理's background runs (docs/ASSISTANT.md §7): one run per piece of work, and what a run found reaches the
 * owner once, across a restart.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });

async function boot(stateDir: string) {
  const booted = await createApp({ stateDir, auth: false, cliPath: '/nonexistent/cursor-agent' });
  vi.spyOn(booted.dispatch, 'kick').mockImplementation(() => undefined);
  vi.spyOn(booted.nativeBackends, 'assertAvailable').mockImplementation(() => undefined);
  const backends = await booted.nativeBackends.catalog.listBackends();
  vi.spyOn(booted.nativeBackends.catalog, 'listBackends').mockResolvedValue(backends.map(entry => entry.backendId === 'claude' ? { ...entry, available: true } : entry));
  const pushes: string[] = [];
  vi.spyOn(booted.push, 'notice').mockImplementation(async (_sessionId, body) => { pushes.push(body); return true; });
  return { ...booted, pushes };
}

async function settled(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100 && !check(); tries++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

async function mcpOf(server: Awaited<ReturnType<typeof boot>>, sessionId: string) {
  const { credential } = JSON.parse(await readFile(server.riffetMcp.server(sessionId)!.args.at(-1)!, 'utf8')) as { credential: string };
  return async (method: 'tools/list' | 'tools/call', params?: { name: string; arguments: Record<string, unknown> }) => {
    const response = await server.app.inject({
      method: 'POST', url: '/api/riffet-mcp', headers: { host: '127.0.0.1:4317', authorization: `Bearer ${credential}` },
      payload: { method, params },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().result;
  };
}

describe('assistant background runs', () => {
  it('keeps an ended or replaced delegation when its old fetch fails', async () => {
    const store = new Store(':memory:');
    let failFetch: ((error: Error) => void) | undefined;
    const fire = vi.fn();
    const delegations = new AssistantDelegations({
      store, nextCron: () => undefined, timeZone: () => 'UTC', fire, expired: vi.fn(),
      taskStatuses: {
        baseline: () => ({ workItemId: 'task-id', taskNumber: 1, cursor: 'new-baseline' }),
        events: () => [], subscribe: () => () => {},
      },
      fetch: () => new Promise<Response>((_resolve, reject) => { failFetch = reject; }),
    });
    try {
      for (const change of [
        (id: string) => delegations.end(id, 'assistant'),
        (id: string) => delegations.update(id, { trigger: { kind: 'task-status', task: 1, status: 'review' } }),
      ]) {
        const watch = delegations.create({ goal: 'Watch page', attention: 'Notice changes', trigger: { kind: 'page', url: 'https://example.invalid' } });
        const check = delegations.tick();
        const updated = change(watch.id);
        failFetch!(new Error('Old source unavailable'));
        await check;
        expect(delegations.get(watch.id)).toEqual(updated);
      }
      expect(fire).not.toHaveBeenCalled();
    } finally { store.close(); }
  });


  it('starts one run per key, writes its note with its outcome, and pushes an ask once across a restart', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-assistant-runs-'));
    cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
    const first = await boot(stateDir);
    const runs = first.assistantRuns!;
    const brief = { goal: 'Watch releases', attention: 'Anything', trigger: '{}', until: '2027-01-01', cursor: 'v1', reason: 'v2 is out.', payload: 'notes' };
    // A run starts only while what it is for is still there.
    const d1 = first.assistantDelegations.create({ goal: 'Watch releases', attention: 'Anything', trigger: { kind: 'schedule', cron: '0 9 * * 5' } }).id;
    const run = runs.enqueue('delegation', `delegation:${d1}:v2`, brief, d1);
    // The same change again starts nothing new.
    expect(runs.enqueue('delegation', `delegation:${d1}:v2`, brief, d1).id).toBe(run.id);
    const made = () => { const id = runs.get(run.id)?.sessionId; try { return Boolean(id && first.store.getSession(id)); } catch { return false; } };
    for (let tries = 0; tries < 300 && !made() && runs.get(run.id)?.state === 'running'; tries++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(runs.get(run.id)?.error).toBeUndefined();
    expect(made()).toBe(true);
    const sessionId = runs.get(run.id)!.sessionId!;
    const session = first.store.getSession(sessionId);
    expect(session.origin).toMatchObject({ kind: 'assistant', job: 'delegation', assistantRunId: run.id });
    expect(session.projectId).toBe(assistantProject(first.store, stateDir).id);
    expect(session.approval).toBe('dontAsk');

    // A main conversation for the note to reach, opened as a client opens it.
    const status = await first.app.inject({ method: 'GET', url: '/api/auth/status', headers: { host: '127.0.0.1:4317' } });
    const headers = { host: '127.0.0.1:4317', cookie: String(status.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': (status.json() as { csrfToken: string }).csrfToken };
    // Not on an agent that does not isolate it: it would run with the owner's own configuration.
    const elsewhere = await first.app.inject({ method: 'POST', url: '/api/sessions', headers, payload: { kind: 'native', projectId: session.projectId, backendId: 'cursor', clientSessionId: 'elsewhere', initialMessage: { commandId: 'e1', text: 'hello' } } });
    expect(elsewhere.json()).toMatchObject({ error: { code: 'ASSISTANT_BACKEND_UNSUPPORTED' } });
    const opened = await first.app.inject({ method: 'POST', url: '/api/sessions', headers, payload: { kind: 'native', projectId: session.projectId, backendId: 'claude', clientSessionId: 'main', initialMessage: { commandId: 'm1', text: 'hello' } } });
    expect(opened.statusCode, opened.body).toBe(202);
    expect(assistantProject(first.store, stateDir).mainSessionId).toBe('main');
    // The push is held back, as if the server stopped before it went out.
    let releasePush!: (value: boolean) => void;
    vi.mocked(first.push.notice).mockImplementationOnce(() => new Promise(resolve => { releasePush = resolve; }));
    const reported = await first.assistant!.call('run_report', { outcome: 'ask', text: 'v2 changes the parser API.' }, { sessionId });
    expect(reported).toMatchObject({ reported: 'ask' });
    // A second report of the same run changes nothing.
    await first.assistant!.call('run_report', { outcome: 'silent' }, { sessionId });
    expect(runs.get(run.id)).toMatchObject({ outcome: 'ask', text: 'v2 changes the parser API.', pushed: false });
    expect(runs.offerPending().map(note => note.text)).toEqual(['v2 changes the parser API.']);
    runs.settlePending(false);
    await first.app.close();
    releasePush(false);

    const second = await boot(stateDir);
    await second.assistantRuns!.sweep();
    expect(second.pushes).toEqual(['v2 changes the parser API.']);
    expect(second.assistantRuns!.get(run.id)?.pushed).toBe(true);
    await second.assistantRuns!.sweep();
    expect(second.pushes).toHaveLength(1);
    // The note was never carried by a turn that ended well, so it is still there.
    expect(second.assistantRuns!.offerPending()).toHaveLength(1);
    second.assistantRuns!.settlePending(true);
    expect(second.assistantRuns!.offerPending()).toHaveLength(0);
    await second.app.close();
  // Two servers boot here, and each first catalog read probes the agents' CLIs.
  }, 60_000);

  it('replays a committed task transition once when delegation consumption rolled back before restart', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-assistant-task-watch-'));
    let first: Awaited<ReturnType<typeof boot>> | undefined;
    let second: Awaited<ReturnType<typeof boot>> | undefined;
    cleanups.push(async () => {
      await first?.app.close();
      await second?.app.close();
      await rm(stateDir, { recursive: true, force: true });
    });
    first = await boot(stateDir);
    const task = first.workItems.create({ title: 'Review deployment' });
    const other = first.workItems.create({ title: 'Unrelated task' });
    first.workItems.patch(task.id, { status: 'review' });
    const assistant = assistantProject(first.store, stateDir);
    const status = await first.app.inject({ method: 'GET', url: '/api/auth/status', headers: { host: '127.0.0.1:4317' } });
    const headers = { host: '127.0.0.1:4317', cookie: String(status.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': (status.json() as { csrfToken: string }).csrfToken };
    const opened = await first.app.inject({ method: 'POST', url: '/api/sessions', headers, payload: {
      kind: 'native', projectId: assistant.id, backendId: 'claude', clientSessionId: 'main',
      initialMessage: { commandId: 'subscribe', text: 'Notify me when this task is ready for review' },
    } });
    expect(opened.statusCode, opened.body).toBe(202);
    const ownerMcp = await mcpOf(first, 'main');
    const create = await ownerMcp('tools/call', { name: 'delegation_create', arguments: {
      goal: 'Review deployment', attention: 'Notify me every time it enters review',
      trigger: { kind: 'task-status', task: `#${task.number}`, status: 'review' },
    } });
    const { id } = create.structuredContent.created as { id: string };
    expect(first.assistantDelegations.get(id).trigger).toEqual({ kind: 'task-status', workItemId: task.id, taskNumber: task.number, status: 'review' });
    await first.assistantDelegations.tick(new Date(), true);
    first.workItems.patch(other.id, { status: 'review' });
    first.workItems.patch(task.id, { status: 'doing' });
    expect(first.assistantRuns!.recent()).toEqual([]);

    const baseline = first.assistantDelegations.get(id).cursor;
    const enqueue = first.assistantRuns!.enqueue.bind(first.assistantRuns!);
    vi.spyOn(first.assistantRuns!, 'enqueue').mockImplementationOnce((...args) => {
      enqueue(...args);
      throw new Error('Simulated failure before consumption commits');
    });
    first.workItems.patch(task.id, { status: 'review' });
    const event = first.workItems.events(task.id).at(-1)!;
    expect(event).toMatchObject({ kind: 'status', from: 'doing', to: 'review' });
    expect(first.assistantDelegations.get(id).cursor).toBe(baseline);
    expect(first.assistantRuns!.recent()).toEqual([]);
    await first.app.close();
    first = undefined;

    second = await boot(stateDir);
    await second.assistantDelegations.tick(new Date(), true);
    const restored = second;
    await settled(() => {
      const current = restored.assistantRuns!.recent()[0];
      if (!current?.sessionId) return false;
      try { restored.store.getSession(current.sessionId); return true; } catch { return false; }
    });
    const [run] = second.assistantRuns!.recent();
    expect(run).toMatchObject({ subject: id, key: `delegation-task-status:${id}:${event.id}`, brief: { payload: expect.stringContaining(event.id) } });
    expect(second.assistantDelegations.get(id).cursor).toBe(event.id);

    const project = second.store.createProject(stateDir, 'Work');
    const taskSession = second.store.createSession({ projectId: project.id, kind: 'native', backendId: 'claude', workItemId: task.id });
    const otherSession = second.store.createSession({ projectId: project.id, kind: 'native', backendId: 'claude', workItemId: other.id });
    const watchMcp = await mcpOf(second, run!.sessionId!);
    const watchTools = (await watchMcp('tools/list')).tools.map((tool: { name: string }) => tool.name);
    expect(watchTools).toEqual(expect.arrayContaining(['task_get', 'session_read', 'run_report']));
    for (const name of ['task_list', 'session_list', 'history_search', 'task_continue']) expect(watchTools).not.toContain(name);
    const call = (name: string, args: Record<string, unknown>) => watchMcp('tools/call', { name, arguments: args });
    expect(await call('task_get', { task: `#${task.number}` })).toMatchObject({ structuredContent: { task: task.number, title: task.title, status: 'review' } });
    expect(await call('task_get', { task: other.id })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^WORK_ITEM_NOT_FOUND:/) }] });
    expect(await call('session_read', { session: taskSession.id })).toMatchObject({ structuredContent: { id: taskSession.id, task: task.number } });
    const deniedSession = await call('session_read', { session: otherSession.id });
    expect(deniedSession).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^INVALID_ARGUMENT:/) }] });
    const unknownSessionId = '00000000-0000-4000-8000-000000000000';
    const deniedUnknown = await call('session_read', { session: unknownSessionId });
    expect(deniedUnknown).toEqual({ isError: true, content: [{ type: 'text', text: deniedSession.content[0].text.replace(otherSession.id, unknownSessionId) }] });
    expect(await call('task_continue', { text: 'Continue' })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^TOOL_NOT_AVAILABLE:/) }] });

    second.assistantRuns!.report(run!.sessionId!, 'ask', 'Task ready for review.', 'main');
    second.assistantRuns!.report(run!.sessionId!, 'ask', 'Repeated result.', 'main');
    await second.assistantDelegations.tick(new Date(), true);
    second.workItems.patch(task.id, { status: 'review' });
    expect(second.assistantRuns!.recent()).toHaveLength(1);
    expect(second.notices.list('main').map(notice => notice.body)).toEqual(['Task ready for review.']);

    const orphan = second.store.createSession({ projectId: assistant.id, kind: 'native', backendId: 'claude', origin: { kind: 'assistant', job: 'supervise' } });
    const orphanMcp = await mcpOf(second, orphan.id);
    expect((await orphanMcp('tools/list')).tools).not.toContainEqual(expect.objectContaining({ name: 'task_continue' }));

    second.settings.setSettings({ assistant: { supervision: true } });
    const supervised = second.assistantRuns!.enqueue('supervise', `supervise:${task.id}:${taskSession.updatedAt}`, {
      number: task.number, title: task.title, status: 'review', criteria: 'Check the deployment', submission: '',
      sessionId: taskSession.id, agent: 'Claude', state: taskSession.state, stopNote: '', messages: '',
    }, task.id);
    await settled(() => {
      const sessionId = restored.assistantRuns!.get(supervised.id)?.sessionId;
      if (!sessionId) return false;
      try { restored.store.getSession(sessionId); return true; } catch { return false; }
    });
    expect(second.assistantRuns!.get(supervised.id)?.error).toBeUndefined();
    const supervisionMcp = await mcpOf(second, second.assistantRuns!.get(supervised.id)!.sessionId!);
    expect((await supervisionMcp('tools/list')).tools).toContainEqual(expect.objectContaining({ name: 'task_continue' }));
    expect(await supervisionMcp('tools/call', { name: 'task_continue', arguments: { text: 'Continue the deployment review.' } })).toMatchObject({ structuredContent: { sent: task.number } });
  }, 60_000);
});
