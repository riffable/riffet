import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../store.js';
import { OrchestrationService } from './service.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

describe('migrating templates, schedules and wake-ups', () => {
  it('turns the old settings keys into automations once, keeping wake-up ids', async () => {
    const store = new Store(':memory:');
    const project = store.createProject('/tmp', 'old');
    const session = store.createSession({ projectId: project.id, kind: 'native' });
    const stamp = '2026-01-01T00:00:00.000Z';
    store.setSetting('orchestration:templates', {
      used: { id: 'used', name: 'Nightly', prompt: 'check', backendId: 'claude', isolate: true, createdAt: stamp, updatedAt: stamp },
      loose: { id: 'loose', name: 'Loose', prompt: 'by hand', createdAt: stamp, updatedAt: stamp },
    });
    store.setSetting('orchestration:schedules', {
      plan: { id: 'plan', name: 'Plan', templateId: 'used', projectId: project.id, cron: '0 3 * * *', enabled: true, target: 'same', lastSessionId: session.id, createdAt: stamp, updatedAt: stamp },
    });
    const wakeup = (id: string, status: string, extra: object = {}) => ({ id, sessionId: session.id, dueAt: '2026-01-02T00:00:00.000Z', note: `note ${id}`, createdAt: stamp, status, ...extra });
    store.setSetting('orchestration:wakeups', {
      w1: wakeup('w1', 'pending'), w2: wakeup('w2', 'fired', { firedAt: '2026-01-02T00:00:01.000Z', runId: 'run-2' }),
      w3: wakeup('w3', 'failed', { firedAt: '2026-01-02T00:00:01.000Z', error: 'archived' }), w4: wakeup('w4', 'cancelled'),
    });
    const service = new OrchestrationService({ store, schedulerIntervalMs: 3_600_000 } as unknown as ConstructorParameters<typeof OrchestrationService>[0]);
    cleanup.push(async () => { await service.close(); store.close(); });

    const byId = Object.fromEntries(service.automations().map(item => [item.id, item]));
    expect(Object.keys(byId).sort()).toEqual(['loose', 'plan', 'w1', 'w2', 'w3', 'w4']);
    expect(byId.loose).toMatchObject({ triggers: [], delivery: 'new' });
    expect(byId.plan).toMatchObject({ prompt: 'check', backendId: 'claude', isolate: true, projectId: project.id, delivery: 'same', catchUp: 'latest', lastSessionId: session.id, triggers: [{ kind: 'cron', cron: '0 3 * * *' }] });
    expect(byId.w1).toMatchObject({ enabled: true, nextRunAt: '2026-01-02T00:00:00.000Z', followUp: { sessionId: session.id, by: 'agent' }, triggers: [{ kind: 'once', at: '2026-01-02T00:00:00.000Z' }] });
    expect(service.wakeups(session.id).map(item => [item.id, item.status])).toEqual([['w1', 'pending'], ['w2', 'fired'], ['w3', 'failed'], ['w4', 'cancelled']]);
    expect(service.wakeups(session.id).find(item => item.id === 'w2')).toMatchObject({ runId: 'run-2' });
    expect(service.runs('w3')).toEqual([expect.objectContaining({ result: 'failed', error: 'archived' })]);
    for (const key of ['templates', 'schedules', 'wakeups']) expect(store.getSetting(`orchestration:${key}`, null)).toBeNull();
  });
});
