import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeStatus, Session } from '../../../../packages/contracts/src/index.js';
import { Store } from '../store.js';
import { AgentReclaimer, type AgentReclaimDeps } from './reclaim.js';

vi.mock('../backends/shared/app-server-daemons.js', () => ({
  sweepWorkbenchAppServers: async () => ({ stopped: [], live: [], removedArtifacts: 0 }),
}));

const MINUTE = 60_000, HOUR = 60 * MINUTE, GIB = 1024 ** 3;
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const PROMPT = '❯ \n  ⏵⏵ auto mode on';

function setup(settings: { idleReclaimMinutes?: number; maxAgentMemoryMb?: number } = {}, store = new Store(':memory:'), usageFile?: string) {
  const project = store.listProjects()[0] ?? store.createProject(`/tmp/reclaim-${randomUUID()}`, 'Reclaim test');
  const viewers = new Set<string>(), statuses = new Map<string, NativeStatus>(), drawn = new Map<string, number>(), screens = new Map<string, string>();
  const rss = new Map<string, number>();
  const disposed: string[] = [], stopped: string[] = [];
  /** Runs as a reclaim waits for the conversation's lock. */
  const hooks: { beforeLock?: () => void } = {};
  /** A CLI resting at its prompt; tmux last saw it draw an hour before `NOW`. */
  const agent = (patch: Partial<Session> & { idleFor: number }) => {
    const { idleFor, state, ...rest } = patch;
    const session = store.createSession({ projectId: project.id, kind: 'native', mode: 'agent', backendId: 'claude', nativeSessionId: randomUUID(), ...rest });
    const terminalId = `terminal-${session.id}`;
    store.saveTerminal({ id: terminalId, projectId: project.id, sessionId: session.id, title: 'claude', kind: 'native', state: 'running', persistent: true, epoch: 1, cols: 80, rows: 24, createdAt: ago(2 * 24 * HOUR) });
    drawn.set(terminalId, NOW - HOUR); screens.set(terminalId, PROMPT);
    return store.updateSession(session.id, { terminalId, lastActivityAt: ago(idleFor), ...(state ? { state } : {}) });
  };
  const deps: AgentReclaimDeps = {
    store,
    terminal: {
      hasViewer: (id: string) => viewers.has(id),
      paneActivity: async () => drawn,
      paneProcesses: async () => ({ panes: [] }),
      paneText: async (id: string) => screens.get(id),
      reapStraySessions: async () => [],
      stop: async (id: string) => { stopped.push(id); store.updateTerminal(id, { state: 'exited' }); },
    } as unknown as AgentReclaimDeps['terminal'],
    nativeBackends: {
      catalog: { traits: (id: string) => ({ resumesByNativeId: id === 'claude' }) },
      hasListeners: () => false,
      status: (id: string) => statuses.get(id) ?? { phase: 'offline' },
      dispose: async (id: string) => { disposed.push(id); },
    } as unknown as AgentReclaimDeps['nativeBackends'],
    runtime: { withDetachedSession: (_id: string, fn: () => Promise<unknown>) => { hooks.beforeLock?.(); return fn(); } } as unknown as AgentReclaimDeps['runtime'],
    settings: () => settings,
    log: () => undefined,
    memory: async (roots) => new Map([...roots.keys()].map(id => [id, rss.get(id) ?? 0])),
    pressure: async () => 'normal',
    ...(usageFile ? { usageFile } : {}),
  };
  return { store, agent, viewers, statuses, drawn, screens, rss, disposed, stopped, hooks, reclaimer: new AgentReclaimer(deps) };
}

describe('AgentReclaimer', () => {
  it('stops only idle CLIs nothing retains, once each, and only after comparing their pane', async () => {
    const { agent, viewers, statuses, drawn, screens, disposed, stopped, reclaimer } = setup({ idleReclaimMinutes: 360, maxAgentMemoryMb: 0 });
    const idle = agent({ idleFor: 7 * HOUR });
    const running = agent({ idleFor: 7 * HOUR, state: 'running' });
    const viewed = agent({ idleFor: 7 * HOUR });
    viewers.add(viewed.terminalId!);
    const background = agent({ idleFor: 7 * HOUR });
    statuses.set(background.id, { phase: 'idle', activity: { compacting: false, background: 1 } });
    const unresumable = agent({ idleFor: 7 * HOUR, nativeSessionId: undefined });
    const recent = agent({ idleFor: HOUR });
    // A turn the CLI took up on its own: nothing in the conversation, no loaded runtime, but its screen moves on.
    const working = agent({ idleFor: 7 * HOUR });

    // Nothing to compare a pane with yet.
    expect((await reclaimer.tick(NOW)).reclaimed).toEqual([]);
    expect(reclaimer.report()?.agents.find(entry => entry.sessionId === idle.id)?.retainedBy).toEqual(['unobserved']);

    drawn.set(working.terminalId!, NOW + MINUTE); screens.set(working.terminalId!, `${PROMPT}\n⏺ Reading 3 files…`);
    expect((await reclaimer.tick(NOW + 5 * MINUTE)).reclaimed).toEqual([idle.id]);
    expect(disposed).toEqual([idle.id]);
    expect(stopped).toEqual([idle.terminalId]);
    // Its terminal has exited, so the next pass has nothing left to stop.
    expect((await reclaimer.tick(NOW + HOUR)).reclaimed).toEqual([]);
    expect(stopped).toHaveLength(1);
    for (const kept of [running, viewed, background, unresumable, recent, working]) expect(disposed).not.toContain(kept.id);
    const report = reclaimer.report()!;
    expect(report.agents.find(entry => entry.sessionId === viewed.id)?.retainedBy).toEqual(['subscribed']);
    expect(report.agents.find(entry => entry.sessionId === recent.id)?.reclaimAt).toBe(new Date(NOW - HOUR + 6 * HOUR).toISOString());
  });

  it('takes a CLI whose screen only animates, and keeps one whose screen moves on', async () => {
    const { agent, drawn, screens, stopped, reclaimer } = setup({ idleReclaimMinutes: 360, maxAgentMemoryMb: 0 });
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

  it('keeps a CLI whose pane moves on, or cannot be read, while the pass waits for its lock', async () => {
    const { agent, screens, stopped, hooks, reclaimer } = setup({ idleReclaimMinutes: 360, maxAgentMemoryMb: 0 });
    const busy = agent({ idleFor: 7 * HOUR });
    await reclaimer.tick(NOW);

    hooks.beforeLock = () => { screens.set(busy.terminalId!, `${PROMPT}\n⏺ Running tests…`); };
    expect((await reclaimer.tick(NOW + 5 * MINUTE)).reclaimed).toEqual([]);
    hooks.beforeLock = () => { screens.delete(busy.terminalId!); };
    expect((await reclaimer.tick(NOW + 7 * HOUR)).reclaimed).toEqual([]);
    expect(stopped).toEqual([]);
  });

  it('keeps when a CLI was last used across a restart, though tmux marks every pane drawn', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'riffet-reclaim-'));
    try {
      const usageFile = join(directory, 'agent-usage.json');
      const store = new Store(':memory:');
      const before = setup({ idleReclaimMinutes: 360, maxAgentMemoryMb: 0 }, store, usageFile);
      const idle = before.agent({ idleFor: 5 * HOUR });
      await before.reclaimer.tick(NOW);
      await before.reclaimer.stop();

      // The new service's first look: tmux says every window drew just now, the text is what it was.
      const after = setup({ idleReclaimMinutes: 360, maxAgentMemoryMb: 0 }, store, usageFile);
      after.drawn.set(idle.terminalId!, NOW + 2 * HOUR - MINUTE); after.screens.set(idle.terminalId!, PROMPT);
      expect((await after.reclaimer.tick(NOW + 2 * HOUR)).reclaimed).toEqual([idle.id]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('stops the CLI of a conversation archived without stopping it', async () => {
    const { agent, store, stopped, disposed, reclaimer } = setup();
    const discarded = agent({ idleFor: 0 });
    store.updateSession(discarded.id, { archivedAt: ago(0), state: 'archived' });

    await reclaimer.tick(NOW);
    expect(disposed).toEqual([discarded.id]);
    expect(stopped).toEqual([discarded.terminalId]);
  });

  it('keeps CLIs within the memory budget by stopping the least recently used ones nothing retains', async () => {
    const { agent, rss, stopped, reclaimer } = setup({ idleReclaimMinutes: 0, maxAgentMemoryMb: 2 * 1024 });
    const oldest = agent({ idleFor: 3 * HOUR });
    const older = agent({ idleFor: 2 * HOUR });
    const newer = agent({ idleFor: HOUR });
    // Used minutes ago: the budget never takes it even when it is over the limit.
    const fresh = agent({ idleFor: 5 * MINUTE });
    for (const session of [oldest, older, newer, fresh]) rss.set(session.id, GIB);
    await reclaimer.tick(NOW);

    expect((await reclaimer.tick(NOW + MINUTE)).reclaimed).toEqual([oldest.id, older.id]);
    expect(stopped).toEqual([oldest.terminalId, older.terminalId]);
    expect(reclaimer.report()).toMatchObject({ memoryBytes: 2 * GIB, memoryLimitBytes: 2 * GIB, idleMinutes: 0 });
  });
});
