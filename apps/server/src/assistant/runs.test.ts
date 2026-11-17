import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
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

describe('assistant background runs', () => {
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
});
