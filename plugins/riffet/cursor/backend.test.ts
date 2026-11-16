import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { UsageObservation } from '@riffet/plugin-api/kit';
import type { AgentContext, AgentSessionView } from '@riffet/plugin-api/experimental/agent';
import { CursorBackend } from './backend.js';
import { CursorUsageIngest } from './backend/usage.js';
import { chatStorePath } from './native/chat-store.js';
import { CursorLive, type CursorUsageCapture } from './native/live.js';
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
