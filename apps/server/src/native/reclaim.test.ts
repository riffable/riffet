import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { NativeStatus, Session } from '../../../../packages/contracts/src/index.js';
import { Store } from '../store.js';
import { AgentReclaimer, type AgentReclaimDeps } from './reclaim.js';

vi.mock('../backends/shared/app-server-daemons.js', () => ({
  sweepWorkbenchAppServers: async () => ({ stopped: [], live: [], removedArtifacts: 0 }),
}));

const HOUR = 60 * 60_000;
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function setup(settings: { idleReclaimMinutes?: number; maxLiveAgents?: number } = {}) {
  const store = new Store(':memory:');
  const project = store.createProject(`/tmp/reclaim-${randomUUID()}`, 'Reclaim test');
  const viewers = new Set<string>(), statuses = new Map<string, NativeStatus>(), drawn = new Map<string, number>(), screens = new Map<string, string>();
  const disposed: string[] = [], stopped: string[] = [];
  const agent = (patch: Partial<Session> & { idleFor: number }) => {
    const { idleFor, state, ...rest } = patch;
    const session = store.createSession({ projectId: project.id, kind: 'native', mode: 'agent', backendId: 'claude', nativeSessionId: randomUUID(), ...rest });
    const terminalId = `terminal-${session.id}`;
    store.saveTerminal({ id: terminalId, projectId: project.id, sessionId: session.id, title: 'claude', kind: 'native', state: 'running', persistent: true, epoch: 1, cols: 80, rows: 24, createdAt: ago(2 * 24 * HOUR) });
    return store.updateSession(session.id, { terminalId, lastActivityAt: ago(idleFor), ...(state ? { state } : {}) });
  };
  const deps: AgentReclaimDeps = {
    store,
    terminal: {
      hasViewer: (id: string) => viewers.has(id),
      paneActivity: async () => drawn,
      paneText: async (id: string) => screens.get(id),
      reapStraySessions: async () => [],
      stop: async (id: string) => { stopped.push(id); store.updateTerminal(id, { state: 'exited' }); },
    } as unknown as AgentReclaimDeps['terminal'],
    nativeBackends: {
      traits: (id: string) => ({ resumesByNativeId: id === 'claude' }),
      hasListeners: () => false,
      status: (id: string) => statuses.get(id) ?? { phase: 'offline' },
      dispose: async (id: string) => { disposed.push(id); },
    } as unknown as AgentReclaimDeps['nativeBackends'],
    runtime: { withDetachedSession: (_id: string, fn: () => Promise<unknown>) => fn() } as unknown as AgentReclaimDeps['runtime'],
    settings: () => settings,
    log: () => undefined,
  };
  return { store, agent, viewers, statuses, drawn, screens, disposed, stopped, reclaimer: new AgentReclaimer(deps) };
}

describe('AgentReclaimer', () => {
  it('stops only idle, resting, unviewed CLIs that can resume, once each', async () => {
    const { agent, viewers, statuses, drawn, disposed, stopped, reclaimer } = setup({ idleReclaimMinutes: 360, maxLiveAgents: 0 });
    const idle = agent({ idleFor: 7 * HOUR });
    const running = agent({ idleFor: 7 * HOUR, state: 'running' });
    const viewed = agent({ idleFor: 7 * HOUR });
    viewers.add(viewed.terminalId!);
    const background = agent({ idleFor: 7 * HOUR });
    statuses.set(background.id, { phase: 'idle', activity: { compacting: false, background: 1 } });
    const unresumable = agent({ idleFor: 7 * HOUR, nativeSessionId: undefined });
    const recent = agent({ idleFor: HOUR });
    // A turn the CLI took up on its own after a restart: nothing in the conversation, no loaded runtime, but its screen is live.
    const working = agent({ idleFor: 7 * HOUR });
    drawn.set(working.terminalId!, NOW - 60_000);

    expect((await reclaimer.tick(NOW)).reclaimed).toEqual([idle.id]);
    expect(disposed).toEqual([idle.id]);
    expect(stopped).toEqual([idle.terminalId]);
    // Its terminal has exited, so the next pass has nothing left to stop.
    expect((await reclaimer.tick(NOW + HOUR)).reclaimed).toEqual([]);
    expect(stopped).toHaveLength(1);
    for (const kept of [running, viewed, background, unresumable, recent, working]) expect(disposed).not.toContain(kept.id);
  });

  it('takes a CLI whose screen only animates, and keeps one whose screen moves on', async () => {
    const { agent, drawn, screens, stopped, reclaimer } = setup({ idleReclaimMinutes: 360, maxLiveAgents: 0 });
    const hung = agent({ idleFor: 7 * 24 * HOUR });
    const working = agent({ idleFor: 7 * 24 * HOUR });
    const frame = (spinner: string, elapsed: string, tokens = '8.72K') => `${spinner} Waiting for response… (${elapsed} • ↓ ${tokens} tokens • esc to interrupt)`;
    drawn.set(hung.terminalId!, NOW); screens.set(hung.terminalId!, frame('✦', '124h 21m 00s'));
    drawn.set(working.terminalId!, NOW); screens.set(working.terminalId!, frame('✦', '3m 10s', '1.2K'));
    expect((await reclaimer.tick(NOW)).reclaimed).toEqual([]);

    for (let hour = 1; hour <= 7; hour++) {
      const at = NOW + hour * HOUR;
      drawn.set(hung.terminalId!, at); screens.set(hung.terminalId!, frame(hour % 2 ? '◆' : '✦', `${124 + hour}h 21m 0${hour}s`));
      drawn.set(working.terminalId!, at); screens.set(working.terminalId!, frame('◆', `${hour}h 3m`, `${hour + 1}.2K`));
      await reclaimer.tick(at);
    }
    expect(stopped).toEqual([hung.terminalId]);
  });

  it('stops the CLI of a conversation archived without stopping it', async () => {
    const { agent, store, stopped, disposed, reclaimer } = setup();
    const discarded = agent({ idleFor: 0 });
    store.updateSession(discarded.id, { archivedAt: ago(0), state: 'archived' });

    await reclaimer.tick(NOW);
    expect(disposed).toEqual([discarded.id]);
    expect(stopped).toEqual([discarded.terminalId]);
  });

  it('enforces the live cap by stopping the least recently used resting CLIs', async () => {
    const { agent, stopped, reclaimer } = setup({ idleReclaimMinutes: 0, maxLiveAgents: 2 });
    const oldest = agent({ idleFor: 3 * HOUR });
    const older = agent({ idleFor: 2 * HOUR });
    agent({ idleFor: HOUR });
    // Used minutes ago: the cap never takes it even when it is over the limit.
    agent({ idleFor: 5 * 60_000 });

    expect((await reclaimer.tick(NOW)).reclaimed).toEqual([oldest.id, older.id]);
    expect(stopped).toEqual([oldest.terminalId, older.terminalId]);
  });
});
