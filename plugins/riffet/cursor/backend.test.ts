import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { UsageObservation } from '@riffet/plugin-api/kit';
import type { AgentContext, AgentRunRef, AgentSessionView, AgentStatus } from '@riffet/plugin-api/experimental/agent';
import { CursorBackend } from './backend.js';
import { CursorTranscriptSource } from './backend/transcript-source.js';
import { CursorUsageIngest } from './backend/usage.js';
import { chatStorePath } from './native/chat-store.js';
import { CursorLive, type CursorLiveStep, type CursorUsageCapture } from './native/live.js';
import { cursorPort } from './host-port.js';
import type { NativeService } from './native/service.js';
import type { WatchMessage } from './native/watch.js';
import { FakeHost } from './testing/fake-host.js';

const session: AgentSessionView = {
  id: 'session-1', projectId: 'project-1', title: 'Conversation', state: 'idle', model: 'gpt-5', mode: 'agent', approval: 'allowlist', terminalId: 'terminal-1',
};
const project = { id: 'project-1', name: 'Project', cwd: '/srv/home/alice/project' };
const context: AgentContext = { session, project, profile: { id: 'default', name: 'Cursor CLI', config: {} } };

/** The backend builds its runtime from the first launch profile; a test hands it one already built. */
function harness(configure: NativeService['configure'] = async (current, patch) => ({ ...current, ...patch })) {
  const nativeConfigure = vi.fn(configure);
  const host = new FakeHost({ sessions: [session], projects: [project] });
  const order: string[] = [];
  const read = host.view.session;
  host.view.session = id => { order.push(`read:${id}`); return read(id); };
  const lock = host.withSessionLock.bind(host);
  host.withSessionLock = async (sessionId, operation) => {
    order.push(`lock:${sessionId}`);
    try { return await lock(sessionId, operation); } finally { order.push('release'); }
  };
  const backend = new CursorBackend({ stateDir: '' });
  Object.assign(backend, { built: { native: { configure: nativeConfigure }, port: cursorPort(host), runtime: {}, profile: {} } });
  return { backend, host, order, nativeConfigure };
}

describe('CursorBackend.configure', () => {
  it('holds the session lock across the switch, like the other backends do', async () => {
    const { backend, host, order, nativeConfigure } = harness();
    const result = await backend.configure(host, context, { approval: 'unrestricted' });
    // The lock has to cover reading the row, the restart decision and the record write together.
    expect(order).toEqual(['lock:session-1', 'read:session-1', 'release']);
    expect(nativeConfigure).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ approval: 'unrestricted', terminalId: 'terminal-1' });
  });

  it('re-reads the session inside the lock and lets a refusal propagate', async () => {
    const refused = Object.assign(new Error('Cursor 正在处理这一轮'), { code: 'CLI_BUSY' });
    const { backend, host, order, nativeConfigure } = harness(async () => { throw refused; });
    await expect(backend.configure(host, context, { approval: 'unrestricted' })).rejects.toBe(refused);
    expect(order).toEqual(['lock:session-1', 'read:session-1', 'release']);
    // A backend that swallowed the refusal would leave the caller believing the switch happened.
    expect(nativeConfigure).toHaveBeenCalledWith(session, { approval: 'unrestricted' });
  });
});

describe('CursorBackend.interrupt', () => {
  it('keeps the successor’s pending steer when the stop was addressed to the previous turn', async () => {
    const host = new FakeHost({ sessions: [session], projects: [project] });
    const backend = new CursorBackend({ stateDir: '' });
    let turnId = 'previous';
    const expectedStop = { requestId: 'stop-previous', nativeSessionId: 'chat', turnId };
    const native = { refreshTurnIdentity: () => { turnId = 'successor'; }, interrupt: vi.fn() };
    const steering = { activeTurn: () => ({ nativeSessionId: 'chat', turnId }), rejectPending: vi.fn() };
    Object.assign(backend, { built: { native, port: cursorPort(host), steering, runtime: {}, profile: {} } });
    host.checkStopTarget = async () => {
      if (turnId !== expectedStop.turnId) throw Object.assign(new Error('target changed'), { code: 'NATIVE_STOP_TARGET_CHANGED' });
    };
    await expect(backend.interrupt(host, context, { expectedStop })).rejects.toMatchObject({ code: 'NATIVE_STOP_TARGET_CHANGED' });
    expect(steering.rejectPending).not.toHaveBeenCalled();
    expect(native.interrupt).not.toHaveBeenCalled();
  });
});

describe('CursorBackend.transcriptSource', () => {
  it('wakes the journal reader when the CLI rewrites the step it has not committed yet', () => {
    let listen: ((message: WatchMessage) => void) | undefined;
    const host = new FakeHost({ sessions: [session], projects: [project] });
    const backend = new CursorBackend({ stateDir: '' });
    const native = { subscribe: (_sessionId: string, listener: (message: WatchMessage) => void) => { listen = listener; return () => {}; } };
    Object.assign(backend, { built: { native, port: cursorPort(host), runtime: {}, profile: { configDir: '/tmp/cursor' } } });
    const wake = vi.fn();
    const stop = backend.transcriptSource(host, context).watch!({} as never, wake);
    // The in-flight step lives only in the store until it commits; without this wake the
    // conversation stays empty for as long as the CLI holds it (a long tool call, say).
    listen!({ type: 'draft' });
    expect(wake).toHaveBeenCalledTimes(1);
    // Control news reaches the client on its own; it must not read the transcript again.
    listen!({ type: 'status', status: { phase: 'busy' } });
    expect(wake).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('CursorBackend.start', () => {
  it('builds the runtime once, as soon as it is registered, and builds no other after it was closed', async () => {
    const host = new FakeHost({ sessions: [session], projects: [project] });
    const backend = new CursorBackend({ stateDir: '' });
    const built = () => (backend as unknown as { built?: unknown }).built;
    expect(built()).toBeUndefined();
    backend.start(host, context.profile);
    const runtime = built();
    expect(runtime).toBeDefined();
    backend.start(host, context.profile);
    expect(built()).toBe(runtime);
    // A call that outlives the activation must not leave a second sweep and hook server behind.
    const closed = new CursorBackend({ stateDir: '' });
    await closed.close();
    expect(() => closed.start(host, context.profile)).toThrow(expect.objectContaining({ code: 'AGENT_BACKEND_CLOSED' }));
    await backend.close();
  });
});

describe('Cursor durable usage ingestion', () => {
  it('retries storage and late child ownership without transcript subscribers, and never guesses across workspaces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-cursor-usage-'));
    const configDir = join(dir, 'config');
    const nativeSessionId = 'root-chat';
    const host = new FakeHost({ sessions: [{ ...session, nativeSessionId }], projects: [project] });
    const saved: UsageObservation[] = [];
    let writable = false;
    host.stats.recordObservation = (_sessionId, _runId, value) => {
      if (!writable) return false;
      saved.push(value);
      return true;
    };
    const live = new CursorLive(join(dir, 'cursor-live'));
    live.launchEnv();
    const put = (chat: string, turn: string) => {
      const capture: CursorUsageCapture = {
        v: 1, nativeSessionId: chat, nativeTurnId: turn, requestId: turn,
        startedAt: 1000, endedAt: 2000, requestedModel: 'requested-model',
        rawUsage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 10 },
      };
      const bytes = JSON.stringify(capture);
      writeFileSync(join(live.usageDir, `${createHash('sha256').update(bytes).digest('hex')}.json`), bytes);
    };
    put(nativeSessionId, 'turn-1');
    put('child-chat', 'turn-2');
    put('foreign-chat', 'turn-3');
    const ingest = new CursorUsageIngest(host, live, configDir);
    try {
      await ingest.drain();
      expect(live.readUsage()).toHaveLength(3);
      writable = true;
      await ingest.drain();
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ agentKind: 'main', usage: { inputTokens: 30, outputTokens: 20 }, requestedModel: 'requested-model' });
      expect(saved[0]!.model).toBeUndefined();
      expect(saved[0]!.usage.reasoningTokens).toBeUndefined();
      expect(live.readUsage()).toHaveLength(2);

      const meta = (cwd: string, child: string) => {
        const path = chatStorePath(configDir, cwd, child);
        mkdirSync(dirname(path), { recursive: true });
        const db = new DatabaseSync(path);
        db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
        db.prepare('INSERT INTO meta VALUES (?, ?)').run('0', JSON.stringify({ agentId: child, subagentInfo: { parentAgentId: nativeSessionId, typeName: 'explore' } }));
        db.close();
      };
      meta(project.cwd, 'child-chat');
      meta('/another-workspace', 'foreign-chat');
      await ingest.drain();
      expect(saved).toHaveLength(2);
      expect(saved[1]).toMatchObject({ agentKind: 'subagent', parentNativeSessionId: nativeSessionId, subagentType: 'explore' });
      expect(live.readUsage().map(item => item.observation.nativeSessionId)).toEqual(['foreign-chat']);
    } finally {
      await ingest.close();
      live.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Cursor usageService.subscribeLive', () => {
  it('streams estimated step output tokens with requested or session model and cleans up on unsubscribe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'riffet-cursor-live-usage-'));
    const host = new FakeHost({ sessions: [{ ...session, nativeSessionId: 'chat-live', model: 'fallback-model' }], projects: [project] });
    const backend = new CursorBackend({ stateDir: dir });
    try {
      backend.start(host, context.profile);
      const events: Array<{ nativeSessionId: string; nativeTurnId: string; stepId: string; model?: string; outputTokens: number; sealed: boolean }> = [];
      const unsubscribe = backend.usageService.subscribeLive(event => events.push(event));
      const liveDir = join(dir, 'cursor-live');
      mkdirSync(liveDir, { recursive: true });
      const writeStep = (text: string, sealed: boolean, requestedModel?: string, run?: string) => {
        writeFileSync(join(liveDir, 'chat-live.json'), JSON.stringify({
          v: 1, pid: process.pid, turn: 'turn-1', at: new Date().toISOString(),
          ...(run ? { run } : {}),
          ...(requestedModel ? { requestedModel } : {}),
          step: 'req-1:1', sealed, parts: [{ type: 'text', text }],
        }));
      };
      writeStep('a'.repeat(40), false, 'gemini-4-hydrogen', 'run-1');
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(events[0]).toMatchObject({ nativeSessionId: 'chat-live', nativeTurnId: 'run-1', stepId: 'req-1:1', model: 'gemini-4-hydrogen', sealed: false });
      expect(events[0]!.outputTokens).toBeGreaterThan(0);

      writeStep('a'.repeat(40), true);
      await vi.waitFor(() => expect(events).toHaveLength(2));
      expect(events[1]).toMatchObject({ nativeTurnId: 'turn-1', model: 'fallback-model', sealed: true, outputTokens: events[0]!.outputTokens });

      unsubscribe();
      writeStep('a'.repeat(120), true, 'gemini-4-hydrogen');
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(events).toHaveLength(2);
    } finally {
      await backend.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CursorBackend.canReleaseInput', () => {
  const IDLE_SCREEN = [
    'Previous reply finished.',
    '→ Add a follow-up',
    '  Gemini 4 Neon High · 12%       Run Everything',
    '  /srv/home/alice/project · main',
  ].join('\n');

  const runRef: AgentRunRef = {
    id: 'run-1', sessionId: 'session-1', commandId: 'cmd-1', state: 'interrupted',
    delivery: 'uncertain', stage: 'confirmation', nativeSessionId: 'chat-1',
  };

  function setupRelease(options: {
    screen?: string;
    status?: AgentStatus;
    cursor?: string | null;
    liveSealed?: boolean;
    step?: CursorLiveStep;
    chatsDir?: string;
    endStatus?: 'completed' | 'interrupted';
    ownerId?: string;
    epochDrift?: boolean;
    dialog?: boolean;
    activeSteerTurn?: boolean;
    terminalKind?: 'cursor' | 'shell';
    drainError?: boolean;
  } = {}) {
    const sess: AgentSessionView = { ...session, nativeSessionId: 'chat-1', terminalId: 'terminal-1' };
    const ctx: AgentContext = { ...context, session: sess };
    const host = new FakeHost({ sessions: [sess], projects: [project] });
    let epoch = 1;
    const termView = {
      id: 'terminal-1', projectId: project.id, sessionId: sess.id, title: 'cursor',
      kind: options.terminalKind ?? 'cursor', state: 'running' as const, epoch: 1, ownerId: options.ownerId,
      persistent: true, cols: 100, rows: 30, createdAt: '2026-11-24T00:00:00.000Z',
    };
    host.view.terminal = (id) => id === 'terminal-1' ? { ...termView, epoch } : undefined;
    host.terminals.get = async () => ({
      id: 'terminal-1', state: 'running', epoch: options.epochDrift ? epoch++ : epoch,
    });
    host.terminals.screen = async () => options.screen ?? IDLE_SCREEN;
    if (options.dialog) host.dialogs.current = async () => ({ id: 'dlg-1', kind: 'approval', revision: 1, title: 'Approve', options: [], actions: [], transport: 'terminal' } as never);
    const source = new CursorTranscriptSource({ sessionId: sess.id, chatsDir: () => options.chatsDir ?? '/nonexistent', chatId: () => 'chat-1' });
    const closedCursor = JSON.stringify({ v: 1, mapping: 3, from: 0, root: 'current-root', n: 2, len: 2, digest: '', mapper: {}, turn: { id: 't1', at: '2026-11-24T00:00:00.000Z', ended: true }, recent: ['t1'], placed: {}, children: [] });
    source.identity();
    const writer = { cursor: options.cursor === undefined ? closedCursor : options.cursor, turnEndStatus: () => options.endStatus } as never;
    host.transcript.drain = vi.fn(async () => { if (options.drainError) throw new Error('store busy'); });
    host.transcript.withSource = async (_sid, task) => await task(source, writer);
    const backend = new CursorBackend({ stateDir: '' });
    const status = options.status ?? { phase: 'idle' };
    const liveStep = options.step ?? (options.liveSealed === undefined ? undefined : { turn: 't2', at: '2026-11-24T00:00:01.000Z', step: 's1', sealed: options.liveSealed, parts: [] });
    Object.assign(backend, {
      built: {
        native: { status: () => status, refreshStatus: vi.fn(async () => undefined) },
        steering: { activeTurn: () => options.activeSteerTurn ? { nativeSessionId: 'chat-1', turnId: 't2' } : undefined },
        live: { read: () => liveStep },
        port: cursorPort(host),
        runtime: {},
        profile: {},
      },
    });
    return { backend, host, ctx };
  }

  it('allows releasing an uncertain run when Cursor is idle with an empty prompt bar and no open turn', async () => {
    const { backend, host, ctx } = setupRelease();
    expect(await backend.canReleaseInput(host, ctx, runRef)).toBe(true);
  });

  it('requires the same completed native request in the tap and serving lane after the old input was written', async () => {
    const run = { ...runRef, inputSentAt: Date.parse('2026-11-24T00:00:00.000Z'), inputText: 'old question', renderedText: 'old question with an attachment' };
    const step = { turn: 't1', at: '2026-11-24T00:01:00.000Z', step: 's1', prompt: 'later question', sealed: true, parts: [] };
    const dir = mkdtempSync(join(tmpdir(), 'riffet-cursor-recovery-'));
    const check = async (opts: Parameters<typeof setupRelease>[0]) => {
      const { backend, host, ctx } = setupRelease({ chatsDir: dir, ...opts });
      return backend.canReleaseAfterLaterTurn(host, ctx, run);
    };
    mkdirSync(join(dir, 'chat-1'));
    const db = new DatabaseSync(join(dir, 'chat-1', 'store.db'));
    try {
      db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
      const put = (root: string) => db.prepare("INSERT OR REPLACE INTO meta VALUES ('0', ?)").run(JSON.stringify({ agentId: 'chat-1', latestRootBlobId: root }));
      const proof = { step, endStatus: 'completed' as const };
      put('current-root');
      expect(await check(proof)).toBe(true);
      for (const incomplete of [
        { endStatus: proof.endStatus }, { ...proof, step: { ...step, at: new Date(run.inputSentAt).toISOString() } },
        { ...proof, step: { ...step, turn: 'another-request' } }, { ...proof, step: { ...step, prompt: run.inputText } },
        { ...proof, step: { ...step, prompt: run.renderedText } }, { ...proof, endStatus: 'interrupted' as const },
        { ...proof, ownerId: 'browser' }, { ...proof, epochDrift: true }, { ...proof, cursor: null },
        { ...proof, screen: IDLE_SCREEN.replace('→ Add a follow-up', '→ queued draft') },
      ]) expect(await check(incomplete)).toBe(false);
      // A browser may claim or release the terminal, or leave a draft, while the journal lane is busy.
      for (const change of ['claim', 'release', 'draft']) {
        const { backend, host, ctx } = setupRelease({ chatsDir: dir, ...proof });
        const readLane = host.transcript.withSource;
        host.transcript.withSource = async (id, read) => {
          const settled = await readLane(id, read);
          if (change === 'draft') {
            host.terminals.screen = async () => IDLE_SCREEN.replace('Add a follow-up', 'unfinished draft');
          } else {
            const view = host.view.terminal('terminal-1')!;
            const changed = { ...view, epoch: view.epoch + 1, ownerId: change === 'claim' ? 'browser' : undefined };
            host.view.terminal = id => id === changed.id ? changed : undefined;
            host.terminals.get = async () => changed;
          }
          return settled;
        };
        expect(await backend.canReleaseAfterLaterTurn(host, ctx, run), change).toBe(false);
      }
      put('newer-root-after-drain');
      expect(await check(proof)).toBe(false);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses release when the prompt bar still holds unsent draft text', async () => {
    const { backend, host, ctx } = setupRelease({
      screen: [
        '→ unsent prompt still sitting in composer',
        '  Gemini 4 Neon High · 12%       Run Everything',
        '  /srv/home/alice/project · main',
      ].join('\n'),
    });
    expect(await backend.canReleaseInput(host, ctx, runRef)).toBe(false);
  });

  it('refuses release when Cursor displays a follow-up queue, busy hint, or subagent subview', async () => {
    const withFollowUps = setupRelease({
      screen: [
        '┌─ follow-ups ──────────────────────────────────────┐',
        '│○ queued message waiting in CLI                    │',
        '│ enter interrupt and send · ↑ select/edit          │',
        '└───────────────────────────────────────────────────┘',
        '→ Add a follow-up',
        '  Gemini 4 Neon High · 12%       Run Everything',
        '  /srv/home/alice/project · main',
      ].join('\n'),
    });
    expect(await withFollowUps.backend.canReleaseInput(withFollowUps.host, withFollowUps.ctx, runRef)).toBe(false);

    const busy = setupRelease({
      screen: [
        '→ Add a follow-up                      ctrl+c to stop',
        '  Gemini 4 Neon High · 12%       Run Everything',
        '  /srv/home/alice/project · main',
      ].join('\n'),
    });
    expect(await busy.backend.canReleaseInput(busy.host, busy.ctx, runRef)).toBe(false);
  });

  it('refuses release when transcript has an open turn, live step is unsealed, dialog is open, terminal drifts, or drain fails', async () => {
    const openCursor = JSON.stringify({ v: 1, mapping: 3, from: 0, n: 1, len: 1, digest: '', mapper: {}, turn: { id: 't2', at: '2026-11-24T00:00:01.000Z' }, recent: ['t2'], placed: {}, children: [] });
    for (const opts of [{ cursor: openCursor }, { cursor: '{"v":999}' }, { liveSealed: false }, { dialog: true }, { epochDrift: true }, { activeSteerTurn: true }, { terminalKind: 'shell' as const }, { drainError: true }]) {
      const { backend, host, ctx } = setupRelease(opts);
      expect(await backend.canReleaseInput(host, ctx, runRef)).toBe(false);
    }
  });
});
