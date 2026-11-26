import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  NativeStatus, NativeWorkbenchEvent, Project, Run, Session, TerminalInfo,
} from '../../../../../packages/contracts/src/index.js';
import type {
  NativeBackendHost, NativeBackendProfileConfig, NativeBackendSendRequest, NativeControlMessage, NativeDispatchBinding, NativeInteractionReceipt, NativePtyLaunchSpec,
} from '../types.js';
import { activityOfEvent } from '../../journal/activity.js';
import { rowsOf } from '../../journal/ingest-contract.js';
import { Journal } from '../../journal/journal.js';
import { TranscriptIngest } from '../../sync/ingest.js';
import { CLAUDE_CONFIG_SETTLE_MS, ClaudeBackendAdapter } from './index.js';
import { claudeScreenInteraction } from './screen-dialog.js';
import type { ClaudeTranscript } from './history.js';
import { ClaudeTranscriptSource } from './transcript-source.js';
import type { ModelSourceProvider } from '@riffet/plugin-api';
import { fetchGatewayModels } from '../shared/gateway-models.js';
import { provideModelSources } from '../shared/model-source.js';

/**
 * What a drawn input box looks like. The screen only says whether the box is there to type into;
 * whether a turn runs comes from the transcript and the hooks.
 */
// Full-height tmux captures retain blank rows below the composer, including on first launch.
const IDLE_SCREEN = ['Welcome back', '', '─'.repeat(60), '❯ ', '─'.repeat(60), '    Opus 5 · ctx 30% · /tmp/project', '  ⏵⏵ auto mode on'].join('\n') + '\n'.repeat(40);
/** A pane whose input box has not been drawn: nothing to type into yet. */
const BARE_SCREEN = 'Welcome to Claude Code\nloading…';

/**
 * A CLI stand-in for the two probes `available()` runs. The adapter launches `claude` for real even
 * in a test, so the only honest way to make it reach the launch path is an executable that answers
 * `--version` / `--help` the way the driver reads them.
 */
const STUB_CLI = `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "2.1.252 (Claude Code)"
  exit 0
fi
echo "Usage: claude [options]"
echo "  --settings --session-id --resume --model --permission-mode"
`;

let root = '';
let stubCli = '';
let deliveries = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'riffet-claude-test-'));
  stubCli = join(root, 'claude-stub');
  await writeFile(stubCli, STUB_CLI, { mode: 0o755 });
  await chmod(stubCli, 0o755);
});

const cleaning: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const clean of cleaning.splice(0)) await clean();
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

/** Record of a session as the store keeps it: every read is a fresh object, never a live reference. */
class FakeStore {
  readonly patches: Array<Partial<Session>> = [];
  private record: Session;

  constructor(record: Session) { this.record = record; }

  get(): Session { return structuredClone(this.record); }

  update(patch: Partial<Session>): Session {
    this.patches.push({ ...patch });
    this.record = { ...this.record, ...patch };
    return this.get();
  }
}

class FakeTerminals {
  /** Ids passed to `stop`, in call order. */
  readonly stopped: string[] = [];
  readonly screens = new Map<string, string | undefined>();
  private readonly byId = new Map<string, TerminalInfo>();
  private readonly observers = new Map<string, Set<(observation: { type: 'exit' | 'state'; terminal: TerminalInfo }) => void>>();
  private next = 1;

  create(projectId: string, sessionId: string, screen: string | undefined, id = `terminal-${this.next++}`): TerminalInfo {
    const terminal: TerminalInfo = {
      id, projectId, sessionId, title: 'Claude Agent', kind: 'native',
      state: 'running', persistent: true, epoch: 1, cols: 120, rows: 40, createdAt: '',
    };
    this.byId.set(terminal.id, terminal);
    this.screens.set(terminal.id, screen);
    return { ...terminal };
  }

  async get(id: string): Promise<TerminalInfo> {
    const terminal = this.byId.get(id);
    if (!terminal) throw new Error(`Terminal ${id} does not exist`);
    return { ...terminal };
  }

  async screen(id: string): Promise<string | undefined> {
    if (this.byId.get(id)?.state !== 'running') return undefined;
    return this.screens.get(id);
  }

  async stop(id: string): Promise<void> {
    this.stopped.push(id);
    const terminal = this.byId.get(id);
    if (terminal) this.byId.set(id, { ...terminal, state: 'exited' });
    for (const observer of this.observers.get(id) ?? []) {
      // TerminalService publishes both state and exit for the same process termination.
      observer({ type: 'state', terminal: { ...terminal!, state: 'exited' } });
      observer({ type: 'exit', terminal: { ...terminal!, state: 'exited' } });
    }
  }

  observe(id: string, callback: (observation: { type: 'exit' | 'state'; terminal: TerminalInfo }) => void): () => void {
    const group = this.observers.get(id) ?? new Set();
    group.add(callback);
    this.observers.set(id, group);
    return () => group.delete(callback);
  }
}

interface FakeHarness {
  adapter: ClaudeBackendAdapter;
  host: NativeBackendHost;
  store: FakeStore;
  profile: NativeBackendProfileConfig;
  terminals: FakeTerminals;
  launches: NativePtyLaunchSpec[];
  savedTerminalId: string;
  transcriptPath: string;
  /** What one terminal transaction observes and writes; the test owns the screens it hands out. */
  control: FakeControl;
  getSession(): Session;
  /** What the control path reports from here on, and the events the driver sends outside its transcript (as `append`). */
  listen(): Heard[];
  /** Reads what the CLI has written, as the runtime's poll does. */
  read(): Promise<void>;
  /** The bridge a launched CLI is handed, exactly as `hook-cli.mjs` reads it. */
  deliver(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  deliverSessionStart(permissionMode: unknown): Promise<void>;
  /** Rebuild a runtime around a *saved* terminal the way `subscribe` does after a restart. */
  attachColdRuntime(expected: NativeStatus['phase']): Promise<void>;
  /**
   * Open the conversation the way the service does: launch, then bind the result to the record. A live
   * terminal left from an earlier run is taken over, so a test that wants a launch opens a session
   * whose saved terminal has gone (`fresh`, the default) — pass `takeover` to keep it.
   */
  open(options?: { takeover?: boolean }): Promise<{ nativeSessionId: string; terminalId?: string }>;
  holdNextLaunch(): { started: Promise<void>; release: () => void };
}

/**
 * The terminal transaction a send runs inside. `screens` is what successive `control.screen()` reads
 * return — the guard reads once before the paste, and every verification read after it takes the next
 * entry, repeating the last one — so a test can show the composer going from idle to stuck.
 */
interface FakeControl {
  screens: string[];
  reads: number;
  /** Pasted and not yet submitted. */
  typed?: string;
  /** What a styled capture returns, in order (the plain screen once exhausted). */
  styled?: string[];
  /** A surface holds the keyboard and drops pastes. */
  dropPastes?: boolean;
  readonly keys: string[][];
  readonly pastes: string[];
}

/** What a test hears: the control path, and the driver's events outside its transcript as `append`. */
type Heard = NativeControlMessage | { type: 'append'; events: NativeWorkbenchEvent[] };

async function makeHarness(options: { savedTerminal?: 'live' | 'exited'; screen?: string; stateDir?: string } = {}): Promise<FakeHarness> {
  const listeners: Heard[][] = [];
  const id = `session-${randomUUID()}`;
  const nativeSessionId = randomUUID();
  const configDir = join(root, `config-${randomUUID()}`);
  const workspace = join(root, `workspace-${randomUUID()}`);
  await mkdir(workspace, { recursive: true });
  // A saved conversation always has a transcript on disk; `--resume` is refused without one, and the
  // SessionStart hook is only trusted when it names this session's own file.
  const transcriptPath = join(configDir, 'projects', '-riffet-test', `${nativeSessionId}.jsonl`);
  await mkdir(join(configDir, 'projects', '-riffet-test'), { recursive: true });
  await writeFile(transcriptPath, '');

  const project: Project = { id: `project-${id}`, name: 'Project', cwd: workspace, createdAt: '', updatedAt: '' };
  const store = new FakeStore({
    id, projectId: project.id, kind: 'native', title: 'Claude', tags: [], state: 'idle',
    mode: 'agent', model: 'sonnet', approval: 'default', backendId: 'claude', backendProfileId: 'local',
    nativeSessionId, configRevision: 4, createdAt: '', updatedAt: '',
  });
  const profile: NativeBackendProfileConfig = {
    id: 'local', backendId: 'claude', name: 'Claude Code CLI',
    config: { executable: stubCli, configDir },
  };

  const terminals = new FakeTerminals();
  const savedTerminalId = 'terminal-saved';
  // A live terminal can be inspected and stopped; an exited one only proves the CLI is gone.
  terminals.create(project.id, id, options.savedTerminal === 'exited' ? undefined : options.screen ?? IDLE_SCREEN, savedTerminalId);
  if (options.savedTerminal === 'exited') await terminals.stop(savedTerminalId);
  else store.update({ terminalId: savedTerminalId });
  terminals.stopped.length = 0;

  const launches: NativePtyLaunchSpec[] = [];
  let held: { started: Promise<void>; gate: Promise<void>; markStarted: () => void } | undefined;
  const control: FakeControl = { screens: [IDLE_SCREEN], reads: 0, keys: [], pastes: [] };

  const requireSession = (sessionId: string): void => {
    if (sessionId !== id) throw new Error(`Unknown session ${sessionId}`);
  };
  const receipts = new Map<string, NativeInteractionReceipt>();
  const host = {
    getSession: (sessionId: string) => { requireSession(sessionId); return store.get(); },
    getProject: () => project,
    updateSession: (sessionId: string, patch: Partial<Session>) => { requireSession(sessionId); return store.update(patch); },
    bumpConfig: (sessionId: string, patch: Partial<Session>) => { requireSession(sessionId); return store.update({ ...patch, configRevision: (store.get().configRevision ?? 0) + 1 }); },
    setNativeSessionId: (sessionId: string, value: string | undefined) => {
      requireSession(sessionId);
      return store.update({ nativeSessionId: value, cursorSessionId: value });
    },
    emit: (sessionId: string, _message: NativeControlMessage) => { requireSession(sessionId); },
    emitEvent: (_sessionId: string, event: NativeWorkbenchEvent) => { for (const heard of listeners) heard.push({ type: 'append', events: [event] }); },
    saveRunMetrics: () => undefined,
    findRunIdByCommand: () => undefined,
    findRunIdByNativeMessage: () => undefined,
    stats: { recordUsage: () => undefined, observeEvents: () => undefined },
    getInteractionReceipt: (_sessionId: string, requestId: string) => receipts.get(requestId),
    saveInteractionReceipt: (_sessionId: string, requestId: string, receipt: NativeInteractionReceipt) => { receipts.set(requestId, receipt); return receipt; },
    readAttachment: async () => { throw new Error('No attachments in this test'); },
    commitDispatchFence: (_runId: string, _binding?: NativeDispatchBinding) => ({}),
    isRunCancelled: () => false,
    launchPty: async (_session: Session, launchProject: Project, spec: NativePtyLaunchSpec) => {
      launches.push(spec);
      const terminal = terminals.create(launchProject.id, id, IDLE_SCREEN);
      if (held) { held.markStarted(); await held.gate; }
      return terminal;
    },
    terminal: {
      get: (terminalId: string) => terminals.get(terminalId),
      screen: (terminalId: string) => terminals.screen(terminalId),
      paste: async () => undefined,
      sendKeys: async () => undefined,
      stop: (terminalId: string) => terminals.stop(terminalId),
      observe: (terminalId: string, callback: never) => terminals.observe(terminalId, callback),
      subscribe: () => () => undefined,
      withInteraction: async (_terminalId: string, task: (control: never) => Promise<unknown>) => task({
        // A paste sits in an empty box until Enter takes it, the way the CLI draws it.
        screen: async (options?: { styled?: boolean }) => {
          if (options?.styled && control.styled?.length) return control.styled.shift();
          const screen = control.screens[Math.min(control.reads++, control.screens.length - 1)] ?? IDLE_SCREEN;
          const typed = control.typed?.includes('\n') ? `[Pasted text #1 +${control.typed.split('\n').length - 1} lines]` : control.typed;
          return typed === undefined ? screen : screen.replace(/^❯ $/m, `❯ ${typed}`);
        },
        keys: async (keys: string[]) => { control.keys.push(keys); if (keys.includes('Enter')) control.typed = undefined; },
        paste: async (text: string) => { control.pastes.push(text); if (!control.dropPastes) control.typed = text; },
      } as never),
    },
    withSessionLock: async <T>(_sessionId: string, operation: () => Promise<T> | T) => await operation(),
  } as unknown as NativeBackendHost;

  const adapter = new ClaudeBackendAdapter(options.stateDir ? { stateDir: options.stateDir } : undefined);
  cleaning.push(async () => { await adapter.close().catch(() => undefined); });

  const deliver = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const spec = launches.at(-1);
    const url = spec?.env?.RIFFET_CLAUDE_HOOK_URL;
    const token = spec?.env?.RIFFET_CLAUDE_HOOK_TOKEN;
    if (!url || !token) throw new Error('The fake CLI was not handed a hook bridge');
    deliveries += 1;
    const response = await fetch(`${url}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ deliveryId: `delivery-${deliveries}`, payload }),
    });
    expect(response.status).toBe(200);
    return await response.json() as Record<string, unknown>;
  };

  return {
    adapter, host, store, profile, terminals, launches, savedTerminalId, transcriptPath, control,
    getSession: () => store.get(),
    listen: () => {
      const messages: Heard[] = [];
      listeners.push(messages);
      adapter.subscribe(host, store.get(), profile, message => messages.push(message));
      return messages;
    },
    read: async () => {
      const runtime = await (adapter as unknown as { ensureRuntime(...args: unknown[]): Promise<{ monitor(): Promise<void>; refreshTranscript(): Promise<void> }> })
        .ensureRuntime(host, store.get(), project, profile, false);
      await runtime.monitor();
      await runtime.refreshTranscript();
    },
    deliver,
    deliverSessionStart: async (permissionMode: unknown) => {
      await deliver({
        hook_event_name: 'SessionStart', session_id: nativeSessionId,
        transcript_path: transcriptPath, permission_mode: permissionMode,
      });
    },
    attachColdRuntime: async (expected: NativeStatus['phase']) => {
      adapter.subscribe(host, store.get(), profile, () => undefined);
      await waitFor(() => (adapter.status(host, store.get()).phase === expected ? true : undefined));
    },
    open: async (openOptions: { takeover?: boolean } = {}) => {
      if (!openOptions.takeover) {
        const saved = store.get().terminalId;
        if (saved && (await terminals.get(saved).catch(() => undefined))?.state === 'running') {
          const recorded = [...terminals.stopped];
          await terminals.stop(saved);
          terminals.stopped.splice(0, terminals.stopped.length, ...recorded);
        }
      }
      const opened = await adapter.openOrResume(host, store.get(), project, profile);
      if (opened.terminalId) store.update({ terminalId: opened.terminalId, nativeSessionId: opened.nativeSessionId });
      return { nativeSessionId: opened.nativeSessionId ?? nativeSessionId, ...(opened.terminalId ? { terminalId: opened.terminalId } : {}) };
    },
    holdNextLaunch: () => {
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      held = { started, gate, markStarted };
      return { started, release: () => { held = undefined; release(); } };
    },
  };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the Claude runtime to settle');
}

/**
 * A setting picked in a client: the driver records it, the service writes it to the session, and the
 * idle CLI is relaunched for it once the picks stop.
 */
async function pick(h: FakeHarness, patch: { model?: string; approval?: string }, profile: NativeBackendProfileConfig = h.profile): Promise<Awaited<ReturnType<ClaudeBackendAdapter["configure"]>>> {
  const launched = h.launches.length;
  const result = await h.adapter.configure(h.host, h.getSession(), profile, patch);
  h.store.update(result);
  await waitFor(() => (h.launches.length > launched ? true : undefined), CLAUDE_CONFIG_SETTLE_MS + 3_000);
  return result;
}

/** Appends transcript rows the way Claude Code writes them: one JSON line each. */
async function appendRows(h: { transcriptPath: string; getSession(): Session }, ...rows: Array<Record<string, unknown>>): Promise<void> {
  const stamp = new Date().toISOString();
  await appendFile(h.transcriptPath, rows.map(row => `${JSON.stringify({ uuid: `row-${randomUUID()}`, timestamp: stamp, sessionId: h.getSession().nativeSessionId, ...row })}\n`).join(''));
}
const humanRow = (promptId: string, text = 'work') => ({ type: 'user', promptId, origin: { kind: 'human' }, message: { role: 'user', content: text } });
const durationRow = () => ({ type: 'system', subtype: 'turn_duration', durationMs: 5 });
const stopSummaryRow = () => ({ type: 'system', subtype: 'stop_hook_summary', hookCount: 2, hookErrors: [], hookAdditionalContext: [], preventedContinuation: false });

/**
 * A background agent the way Claude Code lays it out beside the session file: a `.meta.json` naming the
 * `Agent` call that launched it (`requestShape: background`) and the agent's own transcript.
 */
async function backgroundAgentFiles(h: { transcriptPath: string }, update: Record<string, unknown> = {}): Promise<void> {
  const directory = join(h.transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'agent-bg1.meta.json'), JSON.stringify({ agentType: 'sleeper', description: 'Sleeps', toolUseId: 'tool-bg-1', spawnDepth: 1, requestShape: 'background', ...update }));
  await writeFile(join(directory, 'agent-bg1.jsonl'), `${JSON.stringify({ type: 'user', uuid: 'bg-1', isSidechain: true, timestamp: new Date().toISOString(), message: { role: 'user', content: 'go' } })}\n`);
}
/** The rows the runtime has read of its transcript. */
const rows = (h: FakeHarness): NativeWorkbenchEvent[] => (h.adapter as unknown as { runtimes: Map<string, { transcript: { allEvents(): NativeWorkbenchEvent[] } }> }).runtimes.get(h.getSession().id)?.transcript.allEvents() ?? [];
/** How many background agents the runtime holds as running. */
const runningAgents = (h: FakeHarness): number => (h.adapter as unknown as { runtimes: Map<string, { state: { background: unknown[] } }> }).runtimes.get(h.getSession().id)?.state.background.length ?? 0;
/** Starts one and waits until the runtime has taken it into its state (the subagent directory is scanned once a second). */
async function startBackgroundAgent(h: FakeHarness): Promise<void> {
  await backgroundAgentFiles(h);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await h.read();
    if (runningAgents(h) > 0) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The background agent never showed as running');
}
async function finishBackgroundAgent(h: FakeHarness): Promise<void> {
  await backgroundAgentFiles(h, { finished: true });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await h.read();
    if (!runningAgents(h)) { await new Promise(resolve => setTimeout(resolve, 400)); return; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The background agent never finished');
}

/** The value of a launch flag, which is how a change reaches the CLI at all. */
function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function watchNativeId(h: FakeHarness): NativeControlMessage[] {
  const messages: NativeControlMessage[] = [];
  const subscribe = (session: Session) => h.adapter.subscribe(h.host, session, h.profile, message => messages.push(message));
  let stop = subscribe(h.getSession());
  const setNativeSessionId = h.host.setNativeSessionId;
  h.host.setNativeSessionId = (sessionId, nativeSessionId) => {
    const previousId = h.getSession().nativeSessionId;
    const session = setNativeSessionId(sessionId, nativeSessionId);
    // Publishing a new id synchronously rebinds the service's existing watcher.
    if (nativeSessionId && nativeSessionId !== previousId) {
      stop();
      stop = subscribe(session);
    }
    return session;
  };
  cleaning.push(async () => { stop(); });
  return messages;
}

describe('Claude launch with an existing watcher', () => {
  it('starts once with a new id and reports startup to the rebound watcher', async () => {
    const h = await makeHarness({ savedTerminal: 'exited' });
    h.store.update({ nativeSessionId: undefined });
    const messages = watchNativeId(h);

    const opened = await h.open();

    expect(h.launches).toHaveLength(1);
    expect(opened.terminalId).toBeDefined();
    expect(h.getSession().nativeSessionId).toBe(opened.nativeSessionId);
    expect(flagValue(h.launches[0]!.args, '--session-id')).toBe(opened.nativeSessionId);
    expect(h.launches[0]!.args).not.toContain('--resume');
    expect(messages).toContainEqual(expect.objectContaining({ type: 'status', status: expect.objectContaining({ phase: 'starting' }) }));
  });

  it.each(['first launch', 'crash recovery'])('can retry %s after failing to create a terminal', async attempt => {
    const h = await makeHarness({ savedTerminal: 'exited' });
    const previousTerminalId = attempt === 'crash recovery' ? h.savedTerminalId : undefined;
    if (previousTerminalId) h.store.update({ terminalId: previousTerminalId, quickExitCount: 2 });
    else h.store.update({ nativeSessionId: undefined });
    watchNativeId(h);
    const launch = vi.spyOn(h.host, 'launchPty').mockRejectedValueOnce(new Error('Terminal unavailable'));

    await expect(h.open()).rejects.toThrow('Terminal unavailable');
    expect(h.getSession().nativeSessionId).toBeUndefined();
    expect(h.getSession().terminalId).toBe(previousTerminalId);

    const opened = await h.open();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(h.launches).toHaveLength(1);
    expect(opened.terminalId).toBeDefined();
    expect(opened.terminalId).not.toBe(previousTerminalId);
    expect(flagValue(h.launches[0]!.args, '--session-id')).toBe(opened.nativeSessionId);
    expect(h.getSession().nativeSessionId).toBe(opened.nativeSessionId);
  });

  it('keeps a saved session id when its history is missing', async () => {
    const h = await makeHarness({ savedTerminal: 'exited' });
    const nativeSessionId = h.getSession().nativeSessionId;
    await rm(h.transcriptPath);
    watchNativeId(h);

    await expect(h.open()).rejects.toMatchObject({ code: 'CLAUDE_SESSION_NOT_FOUND' });
    expect(h.getSession().nativeSessionId).toBe(nativeSessionId);
    expect(h.launches).toHaveLength(0);
  });
});

describe('Claude transcript titles', () => {
  it('checks a provider title against the complete first prompt after the title stand-in is clipped', async () => {
    const h = await makeHarness();
    await h.open();
    const prompt = `${'A'.repeat(48)} 请总结这个中文项目`;
    const nativeSessionId = h.getSession().nativeSessionId;
    await appendFile(h.transcriptPath, `${JSON.stringify({
      type: 'user', uuid: 'first-user', timestamp: '2026-10-09T12:00:00.000Z',
      sessionId: nativeSessionId, message: { role: 'user', content: prompt },
    })}\n${JSON.stringify({ type: 'ai-title', aiTitle: 'Summarize Chinese project', sessionId: nativeSessionId })}\n`);

    await h.read();

    expect(h.getSession().title).toBe(`${'A'.repeat(48)}…`);
    expect(h.getSession().titleSource).toBe('prompt');
  });
});

// Every poll hands the runtime all of the transcript's steps. A long conversation must still reach the
// ledger once per response, not once per response per poll.
describe('Claude usage of a long transcript', () => {
  it('records each settled response once however often the transcript is polled', async () => {
    const h = await makeHarness();
    const responses = 600;
    const rows: Array<Record<string, unknown>> = [humanRow('p-long')];
    for (let index = 0; index < responses; index += 1) {
      rows.push({ type: 'assistant', message: { id: `msg_${index}`, role: 'assistant', content: [{ type: 'text', text: `part ${index}` }], usage: { output_tokens: 10 }, stop_reason: index === responses - 1 ? 'end_turn' : 'tool_use' } });
    }
    await appendRows(h, ...rows, durationRow());
    const recorded = vi.spyOn(h.host.stats!, 'recordUsage');
    await h.attachColdRuntime('idle');
    await waitFor(() => (recorded.mock.calls.length >= responses ? true : undefined));
    const settled = recorded.mock.calls.length;
    // Several 300ms polls of an unchanged file.
    await new Promise(resolve => setTimeout(resolve, 1_200));
    expect(recorded.mock.calls.length).toBe(settled);
    expect(new Set(recorded.mock.calls.map(call => call[2].stepId)).size).toBe(settled);
  });
});

// `started` only records that *this process* launched a TUI. A runtime rebuilt around a saved
// terminal is not started and yet the CLI behind it is running, so a change that trusted `started`
// was written to the record and never reached the process the user is actually talking to.
describe('Claude configure against a CLI this process did not launch', () => {
  it('restarts the CLI still running behind a saved terminal and launches it with the new model', async () => {
    const h = await makeHarness();
    await h.attachColdRuntime('idle');
    expect(h.launches).toHaveLength(0);

    const result = await pick(h, { model: 'opus' });

    // The still-running TUI has to go first: two Claudes on one transcript would both write it.
    expect(h.terminals.stopped).toContain(h.savedTerminalId);
    expect(flagValue(h.launches.at(-1)!.args, '--resume')).toBe(h.getSession().nativeSessionId);
    expect(flagValue(h.launches.at(-1)!.args, '--model')).toBe('opus');
    expect(result).toMatchObject({ model: 'opus' });
  });

  // Each relaunch is a stop and a `--resume`. Adjusting model, effort and Fast in a row must cost one,
  // with the last of them, and must not hold the picker while it happens.
  it('answers each pick at once and relaunches once, with the last pick, after they stop', async () => {
    const h = await makeHarness();
    await h.attachColdRuntime('idle');
    for (const model of ['opus', 'opus[effort=high]', 'opus[effort=low]']) {
      h.store.update(await h.adapter.configure(h.host, h.getSession(), h.profile, { model }));
      expect(h.launches).toHaveLength(0);
    }
    expect(h.getSession().configPending).toBe(true);

    await waitFor(() => (h.launches.length ? true : undefined), CLAUDE_CONFIG_SETTLE_MS + 3_000);
    await waitFor(() => (h.getSession().configPending === false ? true : undefined));
    expect(h.launches).toHaveLength(1);
    expect(flagValue(h.launches[0]!.args, '--resume')).toBe(h.getSession().nativeSessionId);
    expect(flagValue(h.launches[0]!.args, '--effort')).toBe('low');
  });

  // A provider whose quota ran out is left for another that shares its config directory: the same
  // transcript is resumed, and only the endpoint and credential of the launch change.
  it('resumes the same conversation on another profile, and launches with that profile\'s endpoint', async () => {
    const h = await makeHarness();
    await h.attachColdRuntime('idle');
    const other: NativeBackendProfileConfig = { ...h.profile, id: 'relay', name: 'Relay', config: { ...h.profile.config, apiEndpoint: 'https://relay.example.test' } };
    expect(h.adapter.continuationKey(other)).toBe(h.adapter.continuationKey(h.profile));

    // The model stays: moving to the other profile alone has to relaunch.
    await pick(h, {}, other);

    expect(h.terminals.stopped).toContain(h.savedTerminalId);
    const launched = h.launches.at(-1)!;
    expect(flagValue(launched.args, '--resume')).toBe(h.getSession().nativeSessionId);
    const overlay = JSON.parse(await readFile(flagValue(launched.args, '--settings')!, 'utf8'));
    expect(overlay.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://relay.example.test' });
  });

  // "working" and "thinking" are ordinary words in a reply and in a path; only the status slot and
  // the interrupt hint may say a turn is running.
  it('reads a live terminal as idle when the transcript has no open turn, whatever the pane says', async () => {
    const screen = ['  ● Everything is working now.', '', '· Computing…', '', '─'.repeat(60), '❯ ', '─'.repeat(60), '    Opus 5 · ctx 30% · /tmp/working-copy', '  ⏵⏵ auto mode on'].join('\n') + '\n'.repeat(40);
    const h = await makeHarness({ screen });
    await appendRows(h, humanRow('p-done'), durationRow());
    await h.attachColdRuntime('idle');
  });

  // The CLI's own question dialog is a card only while a question it asked is waiting. The same menu on
  // the screen with no such call behind it (a suggested reply at the end of a turn) blocks nothing.
  describe('with a menu drawn on its screen', () => {
    const rule = '─'.repeat(100);
    const menu = [rule, ' ☐ Check', '', 'Shall I verify the long session from the logs?', '', '❯ 1. Yes, verify', '     Read the logs now.', '  2. Later', '     Ask again afterwards.', '  3. Type something.', rule, '  4. Chat about this', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
    const call = (input: Record<string, unknown>) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ask-1', name: 'AskUserQuestion', input }], stop_reason: 'tool_use' } });
    const asked = { questions: [{ header: 'Check', question: 'Shall I verify the long session from the logs?', options: [{ label: 'Yes, verify' }, { label: 'Later' }] }] };

    it('shows nothing for a menu after a finished turn', async () => {
      const h = await makeHarness({ screen: menu });
      await appendRows(h, humanRow('p-done'), { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Shall I verify the long session from the logs?' }], stop_reason: 'end_turn' } }, durationRow());
      await h.attachColdRuntime('idle');
      expect(h.adapter.status(h.host, h.getSession()).interaction).toBeUndefined();
    });

    it('shows nothing for a menu during a turn when the question was never asked through the tool', async () => {
      const h = await makeHarness({ screen: menu });
      await appendRows(h, humanRow('p-open'), call({ questions: [{ question: 'Something else?', options: [{ label: 'A' }, { label: 'B' }] }] }));
      await h.attachColdRuntime('busy');
      expect(h.adapter.status(h.host, h.getSession()).interaction).toBeUndefined();
    });

    it('lifts the menu while the question it shows is an open AskUserQuestion call, and drops it once the call returns', async () => {
      const h = await makeHarness({ screen: menu });
      await appendRows(h, humanRow('p-open'), call(asked));
      await h.attachColdRuntime('attention');
      expect(h.adapter.status(h.host, h.getSession()).interaction).toMatchObject({ kind: 'question', title: 'Check', options: [{ label: 'Yes, verify' }, { label: 'Later' }] });
      await appendRows(h, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ask-1', content: 'answered' }] } });
      await waitFor(() => (h.adapter.status(h.host, h.getSession()).interaction === undefined ? true : undefined));
    });
  });

  it('keeps the change in the record when the saved terminal has exited', async () => {
    const h = await makeHarness({ savedTerminal: 'exited' });
    await h.attachColdRuntime('offline');

    const result = await h.adapter.configure(h.host, h.getSession(), h.profile, { model: 'opus' });

    // Nothing can be shown to the CLI, so the intent waits for the next start/send — and nothing is
    // launched behind the user's back either.
    expect(result).toEqual({ model: 'opus' });
    expect(h.launches).toHaveLength(0);
    expect(h.terminals.stopped).toEqual([]);
  });

  // The other half of "the change takes effect": the record it waits in has to be what the next start
  // reads. A change that only reached the picker would look identical here and be lost at launch.
  it('carries a change recorded while nothing was running into the next start', async () => {
    const h = await makeHarness({ savedTerminal: 'exited' });
    const recorded = await h.adapter.configure(h.host, h.getSession(), h.profile, { model: 'opus', approval: 'plan' });
    h.store.update({ model: recorded.model, approval: recorded.approval });

    await h.open();

    expect(flagValue(h.launches.at(-1)!.args, '--model')).toBe('opus');
    expect(flagValue(h.launches.at(-1)!.args, '--permission-mode')).toBe('plan');
  });

  // A turn in flight keeps the settings it started with. Relaunching the CLI would kill the turn, so
  // the change is *recorded* instead: the next launch reads the record, which is exactly what the
  // reader asked for by moving the picker mid-turn. Refusing would leave them with a dead control.
  it('records a change asked for mid-turn instead of refusing it', async () => {
    const h = await makeHarness();
    await appendRows(h, humanRow('p-running'));
    await h.attachColdRuntime('busy');

    const result = await h.adapter.configure(h.host, h.getSession(), h.profile, { model: 'opus', approval: 'plan' });

    expect(result).toEqual({ model: 'opus', approval: 'plan' });
    h.store.update(result);
    await expect(h.open({ takeover: true })).rejects.toMatchObject({ code: 'CLI_BUSY' });
    expect(h.launches).toHaveLength(0);
    expect(h.terminals.stopped).toEqual([]);
  });

  // The cold-start window is the same story one step earlier: the runtime knows a terminal exists but
  // has not confirmed what it is doing, so the change waits for the next launch as well.
  it('records a change asked for while the saved terminal is still reconnecting', async () => {
    const h = await makeHarness();
    h.adapter.subscribe(h.host, h.getSession(), h.profile, () => undefined);

    const result = await h.adapter.configure(h.host, h.getSession(), h.profile, { model: 'opus' });

    expect(result).toEqual({ model: 'opus' });
    expect(h.terminals.stopped).toEqual([]);
  });
});

/** Runs a hook the way Claude Code does: a shell command with the payload on stdin. */
async function runHook(command: string, payload: Record<string, unknown>, env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { env: { ...process.env, RIFFET_CLAUDE_HOOK_URL: '', RIFFET_CLAUDE_HOOK_TOKEN: '', ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(payload));
  });
}

// The server's address changes with every restart, while the CLI it launched keeps running. Hooks
// find the new one through the descriptor file instead of the address the CLI was born with.
describe('Claude hooks across a server restart', () => {
  it('reaches the runtime of a CLI that outlived the server, with and without a descriptor argument', async () => {
    const stateDir = await mkdtemp(join(root, 'state-'));
    const descriptorPath = join(stateDir, 'claude-hook.json');
    const h = await makeHarness({ stateDir });
    await h.open();
    const launched = h.launches.at(-1)!;
    const overlay = JSON.parse(await readFile(flagValue(launched.args, '--settings')!, 'utf8'));
    const hookCommand: string = overlay.hooks.PreToolUse[0].hooks[0].command;
    expect(hookCommand).toContain(`--descriptor '${descriptorPath}'`);
    const first = JSON.parse(await readFile(descriptorPath, 'utf8'));
    expect((await stat(descriptorPath)).mode & 0o777).toBe(0o600);
    expect(first).toMatchObject({ version: 1, pid: process.pid });
    // The endpoint's token speaks as any conversation: a CLI that finds the server through the descriptor is not handed it.
    expect(launched.env).not.toHaveProperty('RIFFET_CLAUDE_HOOK_URL');
    expect(launched.env).not.toHaveProperty('RIFFET_CLAUDE_HOOK_TOKEN');
    // What a CLI started before descriptors existed still carries: the address and token of the first server.
    const legacyEnv = { ...launched.env!, RIFFET_CLAUDE_HOOK_URL: first.url, RIFFET_CLAUDE_HOOK_TOKEN: first.token };

    // The server goes away (descriptor removed) and a new one starts: new port, new boot.
    await h.adapter.close();
    expect(existsSync(descriptorPath)).toBe(false);
    const restarted = new ClaudeBackendAdapter({ stateDir });
    cleaning.push(async () => { await restarted.close(); });
    const contexts: number[] = [];
    restarted.subscribe(h.host, h.getSession(), h.profile, message => { if (message.type === 'context' && message.context) contexts.push(message.context.used); });
    await waitFor(() => (existsSync(descriptorPath) && restarted.status(h.host, h.getSession()).phase === 'idle' ? true : undefined));
    const second = JSON.parse(await readFile(descriptorPath, 'utf8'));
    expect(second.url).not.toBe(first.url);
    expect(second.bootInstanceId).not.toBe(first.bootInstanceId);

    // The status line frame is the one hook with a visible effect on a settled runtime.
    const nativeSessionId = h.getSession().nativeSessionId!;
    const frame = (used: number, sessionId = nativeSessionId) => ({ session_id: sessionId, context_window: { context_window_size: 200_000, total_input_tokens: used } });
    // A CLI started by this build names the descriptor in its command.
    expect((await runHook(hookCommand, frame(111), launched.env!)).code).toBe(0);
    await waitFor(() => (contexts.includes(111) ? true : undefined));
    // One started before descriptors existed has only the dead address and finds the default file.
    expect((await runHook(hookCommand.split(' --descriptor')[0]!, frame(222), { ...legacyEnv, RIFFET_STATE_DIR: stateDir })).code).toBe(0);
    await waitFor(() => (contexts.includes(222) ? true : undefined));
    // A conversation this server does not manage is not served, whoever presents the token.
    await runHook(hookCommand, frame(333, randomUUID()), legacyEnv);
    expect(contexts).not.toContain(333);
  });
});

describe('Claude per-session Fast and gateway compatibility', () => {
  const overlay = async (h: FakeHarness): Promise<Record<string, any>> => JSON.parse(await readFile(flagValue(h.launches.at(-1)!.args, '--settings')!, 'utf8'));

  it('writes the conversation\'s switched-off skills and MCP servers into the launch overlay', async () => {
    const h = await makeHarness();
    h.store.update({ extensionsOff: ['skill:review', 'mcp:docs'] });
    await h.open();
    await h.deliverSessionStart('default');
    expect(await overlay(h)).toMatchObject({ skillOverrides: { review: 'off' }, deniedMcpServers: [{ serverName: 'docs' }], skipAutoPermissionPrompt: true });
  });

  it('preserves effort, Fast and native 1M context across configuration changes without interrupting background work', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    expect(await overlay(h)).not.toHaveProperty('fastMode');
    expect(await overlay(h)).not.toHaveProperty('enableArtifact');
    const models = await h.adapter.listModels(h.host, h.host.getProject(h.getSession().projectId), h.profile, h.getSession());
    expect(models.find(model => model.value === 'opus')?.configOptions.find(option => option.id === 'fast')?.options.map(option => option.value)).toEqual(['default', 'true', 'false']);
    expect(models.find(model => model.value === 'opus')?.configOptions.find(option => option.id === 'fast')).toHaveProperty('category', 'model_config');
    expect(models.find(model => model.value === 'sonnet')?.configOptions.some(option => option.id === 'fast')).toBe(false);
    const legacy = await h.adapter.listModels(h.host, h.host.getProject(h.getSession().projectId), h.profile, { ...h.getSession(), model: 'opus[1m][effort=high,fast=true]' });
    expect(h.adapter.normalizeModel('opus[1m][effort=high,fast=true]')).toBe('opus[context=1m,effort=high,fast=true]');
    expect(h.adapter.normalizeModel('opus[1m][context=default,extra=keep]')).toBe('opus[context=default,extra=keep]');
    expect(legacy.filter(model => model.value === 'opus')).toHaveLength(1);
    expect(legacy.find(model => model.value === 'opus')?.configOptions.find(option => option.id === 'context')).toMatchObject({ category: 'model_config', currentValue: '1m', options: [{ value: 'default' }, { value: '1m' }] });
    const exact = await h.adapter.listModels(h.host, h.host.getProject(h.getSession().projectId), h.profile, { ...h.getSession(), model: 'claude-opus-5-5[1m][effort=high,fast=true]' });
    expect(exact.find(model => model.value === 'claude-opus-5-5')).toMatchObject({ name: 'Opus 5.5' });

    await pick(h, { model: 'claude-opus-5-5[1m][effort=high,fast=true,context=1m]' });
    expect(await overlay(h)).toHaveProperty('fastMode', true);
    expect(flagValue(h.launches.at(-1)!.args, '--model')).toBe('claude-opus-5-5[1m]');
    expect(flagValue(h.launches.at(-1)!.args, '--effort')).toBe('high');
    await h.deliverSessionStart('default');
    // A background agent is still working: relaunching the CLI would kill it, so the change waits.
    await startBackgroundAgent(h);
    const disabled = await h.adapter.configure(h.host, h.getSession(), h.profile, { model: 'claude-opus-5-5[effort=high,fast=false,context=1m]' });
    h.store.update(disabled);
    const stops = h.terminals.stopped.length;
    await expect(h.open({ takeover: true })).rejects.toMatchObject({ code: 'CLI_BUSY' });
    expect(h.terminals.stopped).toHaveLength(stops);
    expect(h.launches).toHaveLength(2);
    expect(h.control.pastes).toHaveLength(0);

    await finishBackgroundAgent(h);
    await h.open({ takeover: true });
    await h.deliverSessionStart('default');
    expect(await overlay(h)).toHaveProperty('fastMode', false);
    expect(flagValue(h.launches.at(-1)!.args, '--model')).toBe('claude-opus-5-5[1m]');
    await pick(h, { model: 'claude-opus-5-5[1m][effort=high,fast=default,context=default]' });
    expect(await overlay(h)).not.toHaveProperty('fastMode');
    expect(flagValue(h.launches.at(-1)!.args, '--model')).toBe('claude-opus-5-5');
    expect(flagValue(h.launches.at(-1)!.args, '--effort')).toBe('high');
  });

  // A dev server started in the background never ends, so a pick waiting on it would hold the queue for good.
  it('offers a pick that waits on background work to be applied now, ending that work with one relaunch', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    await startBackgroundAgent(h);
    h.store.update(await h.adapter.configure(h.host, h.getSession(), h.profile, { model: 'opus' }));
    const control = h.adapter.status(h.host, h.getSession()).runtimeControl;
    expect(control?.notice?.action?.id).toBe('apply-config');
    const launches = h.launches.length, stops = h.terminals.stopped.length;

    await expect(h.adapter.runtimeAction!(h.host, h.getSession(), h.profile, { action: 'apply-config', revision: 'stale' })).rejects.toMatchObject({ code: 'RUNTIME_CONTROL_UNAVAILABLE' });
    expect(h.launches).toHaveLength(launches);

    await h.adapter.runtimeAction!(h.host, h.getSession(), h.profile, { action: 'apply-config', revision: control!.revision });
    expect(h.terminals.stopped).toHaveLength(stops + 1);
    expect(h.launches).toHaveLength(launches + 1);
    expect(flagValue(h.launches.at(-1)!.args, '--model')).toBe('opus');
    expect(h.getSession().configPending).toBe(false);
    expect(h.adapter.status(h.host, h.getSession()).runtimeControl).toBeUndefined();
  });

  it('rejects unverified Fast selections before touching a live terminal', async () => {
    const h = await makeHarness();
    for (const [model, name] of [
      ['claude-opus-5-5', 'Opus 5.5'],
      ['claude-opus-5-20261001', 'Opus 5'],
      ['gateway/claude-opus-5-20261001', 'gateway/claude-opus-5-20261001'],
      ['namespace/CLAUDE-OPUS-4-8', 'namespace/CLAUDE-OPUS-4-8'],
      ['claude-opus-5-5-fast', 'claude-opus-5-5-fast'],
    ]) {
      const selection = `${model}[effort=high,fast=true]`;
      const catalog = await h.adapter.listModels(h.host, h.host.getProject(h.getSession().projectId), h.profile, { ...h.getSession(), model: selection });
      expect(catalog.find(item => item.value === model)?.name).toBe(name);
      expect(catalog.find(item => item.value === model)?.configOptions.find(option => option.id === 'fast')).toMatchObject({ currentValue: 'true', category: 'model_config' });
      await expect(h.adapter.configure(h.host, h.getSession(), h.profile, { model: selection })).resolves.toMatchObject({ model: selection });
    }
    for (const model of ['sonnet', 'claude-opus-4-6', 'claude-opus-4-7']) {
      const selection = `${model}[fast=true]`;
      const catalog = await h.adapter.listModels(h.host, h.host.getProject(h.getSession().projectId), h.profile, { ...h.getSession(), model: selection });
      expect(catalog.find(item => item.value === model)?.configOptions.some(option => option.id === 'fast')).toBe(false);
      await expect(h.adapter.configure(h.host, h.getSession(), h.profile, { model: selection })).rejects.toMatchObject({ code: 'INVALID_MODEL_PARAMETER' });
    }
    for (const model of ['haiku[context=1m]', 'claude-opus-4-5[context=1m]', 'unknown[1m]', 'opus[context=max]']) {
      await expect(h.adapter.configure(h.host, h.getSession(), h.profile, { model })).rejects.toMatchObject({ code: 'INVALID_MODEL_PARAMETER' });
    }
    await expect(h.adapter.configure(h.host, h.getSession(), h.profile, { model: 'opus[fast=maybe]' })).rejects.toMatchObject({ code: 'INVALID_MODEL_PARAMETER' });
    const oldCli = join(root, `claude-old-${randomUUID()}`);
    await writeFile(oldCli, STUB_CLI.replace('2.1.252', '2.1.200'), { mode: 0o755 });
    h.profile.config.executable = oldCli;
    await expect(h.adapter.configure(h.host, h.getSession(), h.profile, { model: 'opus[fast=true]' })).rejects.toMatchObject({ code: 'INVALID_MODEL_PARAMETER' });
    expect(h.launches).toHaveLength(0);
    expect(h.terminals.stopped).toHaveLength(0);
  });

  it('isolates gateway credentials from saved login keys and disables account-only artifacts', async () => {
    const gateway = await makeHarness();
    gateway.profile.config.apiEndpoint = 'http://127.0.0.1:12345';
    gateway.profile.config.apiKey = 'fake-gateway-token';
    await gateway.open();
    expect(await overlay(gateway)).toMatchObject({ enableArtifact: false, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:12345', ANTHROPIC_AUTH_TOKEN: '', RIFFET_CLAUDE_API_KEY: 'fake-gateway-token' } });
    const gatewaySettings = await overlay(gateway);
    expect(gatewaySettings.env.ANTHROPIC_API_KEY).toBe('');
    expect(gatewaySettings.apiKeyHelper).not.toContain('fake-gateway-token');
    const helperKey = await new Promise<string>((resolve, reject) => execFile('/bin/sh', ['-c', gatewaySettings.apiKeyHelper], { env: { ...process.env, ...gatewaySettings.env } }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
    expect(helperKey).toBe('fake-gateway-token');
    expect((await overlay(gateway)).env).not.toHaveProperty('CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK');
    for (const fast of ['true', 'false', 'default']) {
      await gateway.deliverSessionStart('default');
      await pick(gateway, { model: `opus[fast=${fast}]` });
      if (fast === 'true') expect((await overlay(gateway)).env).toHaveProperty('CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK', '1');
      else expect((await overlay(gateway)).env).not.toHaveProperty('CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK');
    }
    const direct = await makeHarness();
    direct.profile.config.apiEndpoint = 'https://api.anthropic.com';
    direct.profile.config.apiKey = 'fake-api-key';
    direct.store.update({ model: 'opus[fast=true]' });
    await direct.open();
    expect(await overlay(direct)).not.toHaveProperty('enableArtifact');
    expect((await overlay(direct)).env).not.toHaveProperty('CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK');
    const keyOnly = await makeHarness();
    keyOnly.profile.config.apiKey = 'fake-key-only';
    await keyOnly.open();
    expect(await overlay(keyOnly)).toMatchObject({ env: { ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '', RIFFET_CLAUDE_API_KEY: 'fake-key-only' } });
    expect((await overlay(keyOnly)).apiKeyHelper).toContain('process.env.RIFFET_CLAUDE_API_KEY');
  });

  /** Sources as plugins provide them; the driver sees only what they resolve to. */
  const sources: ModelSourceProvider[] = [
    {
      id: 'acme-gateway', label: 'Acme', backends: ['claude'],
      resolve: overrides => ({ claudeBaseUrl: overrides.apiEndpoint?.replace(/\/v1$/, ''), ...(overrides.apiKey ? { credential: { kind: 'static', key: overrides.apiKey } } : {}) }),
      catalog: async (_backend, overrides) => await fetchGatewayModels({ baseUrl: overrides.apiEndpoint!, apiKey: overrides.apiKey!, reasoningLevels: true }),
    },
    {
      id: 'acme-cli', label: 'Acme CLI', protocols: ['anthropic-messages', 'openai-responses'],
      resolve: () => ({
        endpoints: {
          'anthropic-messages': { baseUrl: 'https://cli-proxy.example', headers: { 'X-Acme-X-Client': 'claude-code' } },
          'openai-responses': { baseUrl: 'https://cli-proxy.example/v2', headers: { 'X-Acme-X-Client': 'codex' } },
        },
        credential: { kind: 'command', command: '/usr/local/bin/acme', args: ['auth', 'get-token'] },
      }),
      catalog: async () => [],
    },
  ];

  it('uses source-owned static credentials and the normalized Claude base without revealing the key in helper argv', async () => {
    provideModelSources(() => sources);
    try {
      const h = await makeHarness();
      Object.assign(h.profile.config, { modelSource: 'acme-gateway', apiEndpoint: 'https://source.example/v1', apiKey: 'source-owned-test-key' });
      await h.open();
      const settings = await overlay(h);
      expect(settings.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://source.example', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '', RIFFET_CLAUDE_API_KEY: 'source-owned-test-key' });
      expect(settings.env).not.toHaveProperty('ANTHROPIC_CUSTOM_HEADERS');
      expect(settings.apiKeyHelper).not.toContain('source-owned-test-key');
      expect(settings.enableArtifact).toBe(false);
    } finally { provideModelSources(() => []); }
  });

  it('runs a source command credential as the helper, with its headers, instead of a stale static key', async () => {
    provideModelSources(() => sources);
    try {
      const h = await makeHarness();
      Object.assign(h.profile.config, { modelSource: 'acme-cli', apiKey: 'old-static-test-key' });
      await h.open();
      const settings = await overlay(h);
      expect(settings.apiKeyHelper).toBe("'/usr/local/bin/acme' 'auth' 'get-token'");
      expect(settings.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://cli-proxy.example', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '', CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '', ANTHROPIC_CUSTOM_HEADERS: 'X-Acme-X-Client: claude-code' });
      expect(settings.env).not.toHaveProperty('RIFFET_CLAUDE_API_KEY');
      expect(JSON.stringify(settings)).not.toContain('old-static-test-key');
    } finally { provideModelSources(() => []); }
  });

  it('reports a source nothing provides as the reason it is unavailable', async () => {
    const h = await makeHarness();
    Object.assign(h.profile.config, { modelSource: 'acme-missing' });
    expect(await h.adapter.available(h.host, h.profile)).toEqual({ available: false, reason: '模型源「acme-missing」当前不可用：提供它的集成未开启' });
  });

  it('keeps declared source reasoning levels and native Claude effort when metadata is absent', async () => {
    provideModelSources(() => sources);
    const h = await makeHarness();
    Object.assign(h.profile.config, { modelSource: 'acme-gateway', apiEndpoint: 'https://declared-source.example/v1', apiKey: 'declared-test-key' });
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: 'declared-model', available_agents: ['claude-code'], supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'], default_reasoning_level: 'medium' },
      { id: 'claude-sonnet-5-5', supported_reasoning_levels: ['low', 'high'], default_reasoning_level: 'high' },
      { id: 'claude-fable-5-2', object: 'model', created: 0, owned_by: 'gateway' },
      { id: 'undeclared-model', available_agents: ['claude-code'] },
    ] }), { status: 200 }));
    try {
      const models = await h.adapter.listModels(h.host, h.host.getProject(h.getSession().projectId), h.profile);
      const effort = models.find(model => model.value === 'declared-model')!.configOptions.find(option => option.id === 'effort')!;
      expect(effort.options.map(option => option.value)).toEqual(['low', 'medium', 'high', 'xhigh']);
      expect(effort.currentValue).toBe('medium');
      const nativeDeclared = models.find(model => model.value === 'claude-sonnet-5-5')!.configOptions.find(option => option.id === 'effort')!;
      expect(nativeDeclared.options.map(option => option.value)).toEqual(['low', 'high']);
      expect(nativeDeclared.currentValue).toBe('high');
      const fallback = models.find(model => model.value === 'claude-fable-5-2')!.configOptions.find(option => option.id === 'effort')!;
      expect(fallback.options.map(option => option.value)).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
      expect(fallback.currentValue).toBe('default');
      expect(models.find(model => model.value === 'undeclared-model')!.configOptions.some(option => option.id === 'effort')).toBe(false);
      h.store.update({ model: 'claude-fable-5-2[effort=xhigh]' });
      await h.open();
      expect(flagValue(h.launches.at(-1)!.args, '--model')).toBe('claude-fable-5-2');
      expect(flagValue(h.launches.at(-1)!.args, '--effort')).toBe('xhigh');
      const selected = await h.adapter.listModels(h.host, h.host.getProject(h.getSession().projectId), h.profile, h.getSession());
      expect(selected.find(model => model.value === 'claude-fable-5-2')!.configOptions.find(option => option.id === 'effort')!.currentValue).toBe('xhigh');
    } finally { request.mockRestore(); provideModelSources(() => []); }
  });
});

describe('Claude gateway-declared context windows', () => {
  it('applies exact metadata only to the selected custom model and preserves explicit native context requests', async () => {
    const h = await makeHarness();
    const custom = 'opensource/deepseek_v4_1_flash';
    const rows = [
      { id: custom, display_name: 'DeepSeek V4.1 Flash', context_length: 1048576 },
      { id: 'custom-small', context_window: 524288 },
      { id: 'custom-unknown' },
      { id: 'custom-long[1m]' },
      { id: 'claude-opus-5-5', context_length: 1048576 },
    ];
    h.profile.config.apiEndpoint = 'https://metadata.example.invalid';
    h.profile.config.apiKey = 'fake-gateway-key';
    h.store.update({ model: `${custom}[effort=high,fast=false]` });
    let unavailable = false;
    const originalFetch = globalThis.fetch;
    const requests = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) === 'https://metadata.example.invalid/v1/models') {
        return unavailable ? new Response('unavailable', { status: 503 }) : new Response(JSON.stringify({ data: rows }), { status: 200 });
      }
      return await originalFetch(input, init);
    });
    const overlay = async (): Promise<Record<string, any>> => JSON.parse(await readFile(flagValue(h.launches.at(-1)!.args, '--settings')!, 'utf8'));
    const configure = async (model: string) => {
      await h.deliverSessionStart('default');
      await pick(h, { model });
    };
    try {
      const models = await h.adapter.listModels(h.host, h.host.getProject(h.getSession().projectId), h.profile, h.getSession());
      expect(models.find(model => model.value === custom)).toMatchObject({ name: 'DeepSeek V4.1 Flash', contextWindow: 1048576 });
      expect(models.find(model => model.value === custom)?.configOptions.find(option => option.id === 'context')).toMatchObject({ currentValue: 'default', options: [{ value: 'default' }, { value: '1m' }] });
      for (const id of ['custom-small', 'custom-unknown']) {
        expect(models.find(model => model.value === id)?.configOptions.some(option => option.id === 'context')).toBe(false);
      }

      await h.open();
      expect(flagValue(h.launches.at(-1)!.args, '--model')).toBe(custom);
      expect(flagValue(h.launches.at(-1)!.args, '--effort')).toBe('high');
      expect(await overlay()).toMatchObject({ fastMode: false, env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1048576' } });

      await configure(`${custom}[context=1m,effort=high,fast=false]`);
      expect(flagValue(h.launches.at(-1)!.args, '--model')).toBe(`${custom}[1m]`);
      expect(flagValue(h.launches.at(-1)!.args, '--effort')).toBe('high');
      expect((await overlay()).env).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS');
      expect(await overlay()).toHaveProperty('fastMode', false);

      await configure(`${custom}[1m][context=default,effort=high,fast=false]`);
      expect(flagValue(h.launches.at(-1)!.args, '--model')).toBe(custom);
      expect((await overlay()).env).toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS', '1048576');

      await configure('custom-small[effort=high,fast=false]');
      expect((await overlay()).env).toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS', '524288');
      const stops = h.terminals.stopped.length;
      for (const model of ['custom-small[context=1m]', 'custom-unknown[context=1m]']) {
        await expect(h.adapter.configure(h.host, h.getSession(), h.profile, { model })).rejects.toMatchObject({ code: 'INVALID_MODEL_PARAMETER' });
      }
      expect(h.terminals.stopped).toHaveLength(stops);

      // A window the profile declares stands in for the one the gateway never gave.
      h.profile.config.modelContextWindows = { 'custom-unknown': 1048576 };
      const declared = await h.adapter.listModels(h.host, h.host.getProject(h.getSession().projectId), h.profile, h.getSession());
      expect(declared.find(model => model.value === 'custom-unknown')?.configOptions.some(option => option.id === 'context')).toBe(true);
      await configure('custom-unknown[context=1m]');
      expect(flagValue(h.launches.at(-1)!.args, '--model')).toBe('custom-unknown[1m]');
      // The CLI sizes a `claude-` id from its own table and takes no window for it but `[1m]`.
      h.profile.config.modelContextWindows = { 'claude-fable-9': 1048576, 'claude-haiku-9': 200000 };
      await configure('claude-fable-9[effort=high]');
      expect(flagValue(h.launches.at(-1)!.args, '--model')).toBe('claude-fable-9[1m]');
      await configure('claude-haiku-9[effort=high]');
      expect(flagValue(h.launches.at(-1)!.args, '--model')).toBe('claude-haiku-9');
      delete h.profile.config.modelContextWindows;

      await configure('custom-unknown[effort=high,fast=false]');
      expect((await overlay()).env).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS');
      await configure('custom-long[context=1m]');
      expect(flagValue(h.launches.at(-1)!.args, '--model')).toBe('custom-long[1m]');
      await configure('claude-opus-5-5[effort=high,fast=true]');
      expect((await overlay()).env).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS');
      expect(await overlay()).toHaveProperty('fastMode', true);

      // The catalog was read once for all of the above, and a gateway that stops answering keeps it.
      expect(requests.mock.calls.filter(([input]) => String(input) === 'https://metadata.example.invalid/v1/models')).toHaveLength(1);
      unavailable = true;
      await configure(`${custom}[context=1m]`);
      expect(flagValue(h.launches.at(-1)!.args, '--model')).toBe(`${custom}[1m]`);
      // A provider whose catalog was never read cannot vouch for 1M, and says why.
      h.profile.config.apiKey = 'rotated-gateway-key';
      await expect(h.adapter.listModels(h.host, h.host.getProject(h.getSession().projectId), h.profile, h.getSession())).rejects.toThrow(/503/);
      await expect(h.adapter.configure(h.host, h.getSession(), h.profile, { model: `${custom}[context=1m]` })).rejects.toMatchObject({ code: 'NATIVE_MODEL_CATALOG_UNAVAILABLE' });
      await configure(`${custom}[effort=high,fast=false]`);
      expect(flagValue(h.launches.at(-1)!.args, '--model')).toBe(custom);
      expect((await overlay()).env).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS');
    } finally { requests.mockRestore(); }
  });
});

/**
 * Claude Code states the context window only through the command configured as its status line:
 * no transcript record, config file or API frame carries it. The launch therefore installs the
 * collector through `--settings`, and a reader who had a status line of their own keeps it.
 */
describe('Claude context meter from the status line', () => {
  it('publishes the window the CLI states and forwards a status line the reader already had', async () => {
    const h = await makeHarness();
    await writeFile(join(h.profile.config.configDir as string, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: '~/.claude/scripts/statusline.py' } }));
    await h.open();
    await h.deliverSessionStart('default');
    const messages = h.listen();

    const overlay = JSON.parse(await readFile(flagValue(h.launches.at(-1)!.args, '--settings')!, 'utf8')) as { statusLine?: { type?: string; command?: string } };
    expect(overlay.statusLine?.type).toBe('command');
    expect(overlay.statusLine?.command).toContain('statusline-cli.mjs');
    expect(overlay.statusLine?.command).toContain("--forward '~/.claude/scripts/statusline.py'");

    const sessionId = h.getSession().nativeSessionId;
    // A status line frame carries no `hook_event_name`; it is the CLI's own window and occupancy.
    expect(await h.deliver({ session_id: sessionId, model: { id: 'claude-opus-5-5' }, context_window: { context_window_size: 1_000_000, total_input_tokens: 274_244, used_percentage: 27 } })).toEqual({});
    expect(messages.filter(message => message.type === 'context').at(-1)).toEqual({
      type: 'context', context: { used: 274_244, size: 1_000_000, breakdown: [] },
    });

    // A frame that states no window leaves the meter alone instead of inventing a denominator,
    // and another session's frame is never this conversation's meter.
    await h.deliver({ session_id: sessionId, context_window: { total_input_tokens: 10 } });
    await h.deliver({ session_id: 'another-session', context_window: { context_window_size: 200_000, total_input_tokens: 5 } });
    expect(messages.filter(message => message.type === 'context')).toHaveLength(1);

    // `/compact` and a session's first frame both read zero, which clears the ring rather than
    // leaving the compacted occupancy on screen.
    await h.deliver({ session_id: sessionId, context_window: { context_window_size: 1_000_000, total_input_tokens: 0, current_usage: null } });
    expect(messages.filter(message => message.type === 'context').at(-1)).toEqual({
      type: 'context', context: { used: 0, size: 1_000_000, breakdown: [] },
    });
  });

  it('installs the collector without a forward target when the reader has no status line', async () => {
    const h = await makeHarness();
    await h.open();
    const overlay = JSON.parse(await readFile(flagValue(h.launches.at(-1)!.args, '--settings')!, 'utf8')) as { statusLine?: { command?: string } };
    expect(overlay.statusLine?.command).toContain('statusline-cli.mjs');
    expect(overlay.statusLine?.command).not.toContain('--forward');
  });

  it('prefers the status line of the project over the one in the reader’s own settings', async () => {
    const h = await makeHarness();
    await writeFile(join(h.profile.config.configDir as string, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'user-bar' } }));
    await mkdir(join(h.host.getProject(h.getSession().projectId).cwd, '.claude'), { recursive: true });
    await writeFile(join(h.host.getProject(h.getSession().projectId).cwd, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'project-bar' } }));
    await h.open();
    const overlay = JSON.parse(await readFile(flagValue(h.launches.at(-1)!.args, '--settings')!, 'utf8')) as { statusLine?: { command?: string } };
    expect(overlay.statusLine?.command).toContain("--forward 'project-bar'");
  });
});

// The mode can be changed inside Claude Code itself (Shift+Tab, `/permissions`), and its hooks then
// report the mode the TUI is really in. Without adoption a later *partial* configure merges the
// record back over the CLI — silently undoing the user's own choice.
describe('Claude protocol interaction acknowledgement', () => {
  // Claude Code 2.1.302 draws its question dialog about a second before the PermissionRequest hook that brings the card.
  it('lifts no screen card for a question whose hook is on its way, and lifts it once no hook came', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    const sessionId = h.getSession().nativeSessionId;
    const listened = h.listen();
    await h.deliver({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt_id: 'p-ask', prompt: 'ask me' });
    const toolInput = { questions: [{ question: 'Which letter do you pick?', header: 'Letter', options: [{ label: 'Alpha', description: 'Choose the first option' }, { label: 'Beta', description: 'Choose the second option' }] }] };
    await appendRows(h, humanRow('p-ask', 'ask me'));
    await h.deliver({ hook_event_name: 'PreToolUse', session_id: sessionId, prompt_id: 'p-ask', tool_name: 'AskUserQuestion', tool_use_id: 'ask-1', tool_input: toolInput });
    await appendRows(h, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ask-1', name: 'AskUserQuestion', input: toolInput }], stop_reason: 'tool_use' } });
    h.terminals.screens.set(h.getSession().terminalId!, await readFile(new URL('./fixtures/screens/2.1.302/question.txt', import.meta.url), 'utf8'));
    const runtime = (h.adapter as unknown as { runtimes: Map<string, { refreshScreenState(): Promise<void>; screenDialogTask?: Promise<void> }> }).runtimes.get(h.getSession().id)!;
    const readScreen = async () => { while (runtime.screenDialogTask) await runtime.screenDialogTask; await runtime.refreshScreenState(); };
    await readScreen();
    expect(h.adapter.interaction(h.host, h.getSession())).toBeUndefined();

    const hook = h.deliver({ hook_event_name: 'PermissionRequest', session_id: sessionId, prompt_id: 'p-ask', tool_name: 'AskUserQuestion', tool_use_id: 'ask-1', tool_input: toolInput });
    const card = await waitFor(() => h.adapter.interaction(h.host, h.getSession()));
    expect(card.transport).toBe('protocol');
    const shown = listened.flatMap(message => message.type === 'status' && message.status.interaction ? [message.status.interaction.id] : []);
    expect(shown.some(id => id.startsWith('claude-screen:'))).toBe(false);
    await h.adapter.respond(h.host, h.getSession(), h.profile, { interactionId: card.id, revision: card.revision, requestId: 'web-ask', action: 'answer', selectedIds: [card.options[1]!.id] });
    expect(JSON.stringify(await hook)).toContain('Beta');

    // A question whose hook never comes (no hook for it, or one that was lost) is the screen's to answer.
    await h.deliver({ hook_event_name: 'PreToolUse', session_id: sessionId, prompt_id: 'p-ask', tool_name: 'AskUserQuestion', tool_use_id: 'ask-2', tool_input: toolInput });
    await appendRows(h, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ask-2', name: 'AskUserQuestion', input: toolInput }], stop_reason: 'tool_use' } });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await readScreen();
      expect(h.adapter.interaction(h.host, h.getSession())).toBeUndefined();
      vi.setSystemTime(Date.now() + 5_001);
      await readScreen();
      expect(h.adapter.interaction(h.host, h.getSession())?.id).toMatch(/^claude-screen:/);
    } finally { vi.useRealTimers(); }
  });

  const start = async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    return h;
  };
  const permission = async (h: FakeHarness, id: string, toolInput: Record<string, unknown> = { plan: '# Plan\n\nReview before execution.' }) => {
    const hook = h.deliver({ hook_event_name: 'PermissionRequest', session_id: h.getSession().nativeSessionId, tool_name: 'ExitPlanMode', tool_use_id: id, tool_input: toolInput });
    const interaction = await waitFor(() => {
      const current = h.adapter.interaction(h.host, h.getSession());
      return current?.requestId === id ? current : undefined;
    });
    const response = { interactionId: interaction.id, revision: interaction.revision, requestId: `web-${id}`, action: 'allow' };
    return { hook, interaction, response, toolInput };
  };
  const confirm = (h: FakeHarness, id: string, toolInput: Record<string, unknown>, event = 'PostToolUse') => h.deliver({
    hook_event_name: event, session_id: h.getSession().nativeSessionId,
    tool_name: 'ExitPlanMode', tool_use_id: id, tool_input: toolInput, tool_response: { ok: true },
  });

  const autoModeUnavailable = [
    '─'.repeat(80),
    "Auto mode can't check actions in this session",
    '',
    "Auto mode's safety check runs on the server. Your requests go through 127.0.0.1:19090, and the check isn't getting through.",
    '',
    'Enter to stay in auto mode · shift+Tab to leave for accept edits mode and stop · Esc to cancel',
  ].join('\n');

  it.each([
    { action: 'continue', key: 'Enter', screen: ['─'.repeat(80), 'A notice from Claude', 'Enter to continue · Esc to cancel'].join('\n') },
    { action: 'continue', key: 'Enter', screen: autoModeUnavailable },
    { action: 'accept-edits', key: 'BTab', screen: autoModeUnavailable },
    { action: 'cancel', key: 'Escape', screen: autoModeUnavailable },
  ])('fences a screen $action response before its key write so a lost acknowledgement cannot resend it', async ({ action, key, screen }) => {
    const h = await start();
    const terminal = await h.terminals.get(h.getSession().terminalId!);
    const interaction = claudeScreenInteraction(screen, terminal)!;
    h.control.screens = [screen];
    h.host.terminal.withInteraction = async (_terminalId, task) => task({
      screen: async () => screen,
      keys: async keys => { h.control.keys.push(keys); throw new Error('write acknowledgement lost'); },
      paste: async () => undefined,
    });
    const response = { interactionId: interaction.id, revision: interaction.revision, requestId: 'notice-once', action };
    const result = await h.adapter.respond(h.host, h.getSession(), h.profile, response);
    expect(result.status).toBe('uncertain');
    expect(await h.adapter.respond(h.host, h.getSession(), h.profile, response)).toEqual(result);
    expect(h.control.keys).toEqual([[key]]);
    await expect(h.adapter.respond(h.host, h.getSession(), h.profile, { ...response, action: action === 'cancel' ? 'continue' : 'cancel' }))
      .rejects.toMatchObject({ code: 'NATIVE_INTERACTION_REQUEST_CONFLICT' });
    expect(h.control.keys).toHaveLength(1);
  });

  it('rejects an auto-mode response when the terminal no longer shows that notice', async () => {
    const h = await start();
    const terminal = await h.terminals.get(h.getSession().terminalId!);
    const interaction = claudeScreenInteraction(autoModeUnavailable, terminal)!;
    h.host.terminal.withInteraction = async (_terminalId, task) => task({
      screen: async () => IDLE_SCREEN,
      keys: async keys => { h.control.keys.push(keys); },
      paste: async () => undefined,
    });
    await expect(h.adapter.respond(h.host, h.getSession(), h.profile, {
      interactionId: interaction.id, revision: interaction.revision, requestId: 'auto-mode-stale', action: 'accept-edits',
    })).rejects.toMatchObject({ code: 'NATIVE_INTERACTION_STALE' });
    expect(h.control.keys).toEqual([]);
  });

  it('answers Claude Code’s own question by moving its cursor, then presses Enter exactly once', async () => {
    const h = await start();
    const rule = '─'.repeat(80);
    let focus = 1, typed: string | undefined, submitted = false;
    const row = (index: number, label: string) => `${focus === index ? '❯' : ' '} ${index}. ${label}`;
    const screen = () => submitted ? IDLE_SCREEN : [rule, ' ☐ Scope', '', 'Which scope?', '', row(1, 'Small'), '     Change one file.', row(2, 'Large'), '     Change several files.',
      row(3, typed ?? 'Type something.'), rule, row(4, 'Chat about this'), '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
    const terminal = await h.terminals.get(h.getSession().terminalId!);
    const sent: string[][] = [], pasted: string[] = [];
    let stuck = false;
    h.host.terminal.withInteraction = async (_terminalId, task) => task({
      screen: async () => screen(),
      keys: async keys => {
        sent.push(keys);
        for (const key of keys) {
          if (key === 'Enter') submitted = true;
          else if (!stuck) focus = Math.max(1, Math.min(4, focus + (key === 'Down' ? 1 : -1)));
        }
      },
      paste: async text => { typed = text; pasted.push(text); },
    });
    const card = claudeScreenInteraction(screen(), terminal)!;
    expect(card).toMatchObject({ kind: 'question', options: [{ id: 'option-0', label: 'Small' }, { id: 'option-1', label: 'Large' }], actions: [{ id: 'answer' }] });
    const answer = (requestId: string, rest: Record<string, unknown>) => ({ interactionId: card.id, revision: card.revision, requestId, action: 'answer', ...rest });

    // A cursor that never lands is not a reason to submit whatever is under it.
    stuck = true;
    expect(await h.adapter.respond(h.host, h.getSession(), h.profile, answer('stuck', { selectedIds: ['option-1'] }))).toMatchObject({ status: 'uncertain' });
    expect(sent).toEqual([['Down']]);
    stuck = false;
    sent.length = 0;

    expect(await h.adapter.respond(h.host, h.getSession(), h.profile, answer('pick', { selectedIds: ['option-1'] }))).toEqual({ status: 'completed' });
    expect(sent).toEqual([['Down'], ['Enter']]);
    // A retry of the same request reads the receipt instead of pressing anything.
    expect(await h.adapter.respond(h.host, h.getSession(), h.profile, answer('pick', { selectedIds: ['option-1'] }))).toEqual({ status: 'completed' });
    expect(sent).toHaveLength(2);

    submitted = false; focus = 1; sent.length = 0;
    expect(await h.adapter.respond(h.host, h.getSession(), h.profile, answer('typed', { otherText: 'my own\nwords' }))).toEqual({ status: 'completed' });
    expect(sent).toEqual([['Down', 'Down'], ['Enter']]);
    expect(pasted).toEqual(['my own words']);
    submitted = false;
    await expect(h.adapter.respond(h.host, h.getSession(), h.profile, answer('nothing', {}))).rejects.toMatchObject({ code: 'INVALID_NATIVE_INTERACTION' });
  });

  it('does not let an in-flight screen read replace a newly arrived protocol request', async () => {
    const h = await start();
    let release!: (screen: string) => void;
    let reading = false;
    const held = new Promise<string>(resolve => { release = resolve; });
    const spy = vi.spyOn(h.host.terminal, 'screen').mockImplementationOnce(async () => { reading = true; return await held; });
    await waitFor(() => reading ? true : undefined);
    const p = await permission(h, 'during-screen-read');
    release(['─'.repeat(80), 'A notice from Claude', 'Enter to continue · Esc to cancel'].join('\n'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.adapter.interaction(h.host, h.getSession())?.id).toBe(p.interaction.id);
    spy.mockRestore();
    await h.deliver({ hook_event_name: 'SessionEnd', session_id: h.getSession().nativeSessionId });
    await p.hook;
  });

  it('preserves the plan and complete allow input, waits visibly, and never resends on retries', async () => {
    const h = await start();
    const p = await permission(h, 'plan-1', { plan: '# Plan\n\n- Change one file', allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }], extra: { keep: true } });
    expect(p.interaction).toMatchObject({ kind: 'plan', message: p.toolInput.plan });
    vi.useFakeTimers();
    try {
      const responding = h.adapter.respond(h.host, h.getSession(), h.profile, p.response);
      expect(await p.hook).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: p.toolInput } } });
      expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ phase: 'attention', interaction: { id: p.interaction.id, revision: '1', actions: p.interaction.actions } });
      expect(h.adapter.interaction(h.host, h.getSession())?.expiresAt).toBeUndefined();
      const notice = h.adapter.status(h.host, h.getSession()).notice;
      await appendFile(h.transcriptPath, `${JSON.stringify({ type: 'assistant', uuid: 'while-plan-pending', message: {
        role: 'assistant', content: [{ type: 'text', text: 'Additional output is not an approval receipt' }],
      } })}\n`);
      const runtime = (h.adapter as unknown as { runtimes: Map<string, { refreshTranscript(): Promise<void> }> }).runtimes.get(h.getSession().id)!;
      await runtime.refreshTranscript();
      expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ phase: 'attention', interaction: { id: p.interaction.id } });
      expect(h.adapter.status(h.host, h.getSession()).notice).toBe(notice);
      await vi.advanceTimersByTimeAsync(4_001);
      expect(await responding).toMatchObject({ status: 'uncertain' });
      expect(await h.adapter.respond(h.host, h.getSession(), h.profile, p.response)).toMatchObject({ status: 'uncertain' });
      expect(await h.adapter.respond(h.host, h.getSession(), h.profile, { ...p.response, requestId: 'different-web-id', action: 'deny' })).toMatchObject({ status: 'uncertain' });
      await expect(h.adapter.respond(h.host, h.getSession(), h.profile, { ...p.response, action: 'deny' })).rejects.toMatchObject({ code: 'NATIVE_INTERACTION_REQUEST_CONFLICT' });
      // Neither a mismatched input nor an old tool id can acknowledge this request.
      await confirm(h, 'plan-1', { plan: 'different' });
      await confirm(h, 'old-plan', p.toolInput);
      expect(h.adapter.interaction(h.host, h.getSession())?.id).toBe(p.interaction.id);
      await confirm(h, 'plan-1', p.toolInput);
      expect(await h.adapter.respond(h.host, h.getSession(), h.profile, p.response)).toMatchObject({ status: 'completed' });
      expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ phase: 'busy' });
      expect(h.adapter.interaction(h.host, h.getSession())).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  // A safety check no rule may allow stays an ask after the hook allows it, and the CLI asks again in its own dialog.
  it('hands back a bare allow, and gives the screen a dialog that outlives the delivered answer', async () => {
    const h = await start();
    const toolInput = { command: 'rm -rf $(cat build/targets.txt)', description: 'Remove listed build targets' };
    await appendRows(h, humanRow('p-rm'), { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'rm-1', name: 'Bash', input: toolInput }], stop_reason: 'tool_use' } });
    const hook = h.deliver({ hook_event_name: 'PermissionRequest', session_id: h.getSession().nativeSessionId, tool_name: 'Bash', tool_use_id: 'rm-1', tool_input: toolInput });
    const interaction = await waitFor(() => {
      const current = h.adapter.interaction(h.host, h.getSession());
      return current?.requestId === 'rm-1' ? current : undefined;
    });
    // Drawn while the hook is held, and still up for a moment after it answers.
    h.terminals.screens.set(h.getSession().terminalId!, ['─'.repeat(80), ' Bash command', '', '   rm -rf $(cat build/targets.txt)', '   Remove listed build targets', '',
      ' Dangerous rm operation on statically-unresolvable target: command substitution output', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No, and tell Claude what to do differently (esc)', '', ' Esc to cancel · Tab to amend'].join('\n'));
    const runtime = (h.adapter as unknown as { runtimes: Map<string, { refreshScreenState(): Promise<void>; screenDialogTask?: Promise<void> }> }).runtimes.get(h.getSession().id)!;
    const readScreen = async () => { while (runtime.screenDialogTask) await runtime.screenDialogTask; await runtime.refreshScreenState(); };
    const response = { interactionId: interaction.id, revision: interaction.revision, requestId: 'web-rm-1', action: 'allow' };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const responding = h.adapter.respond(h.host, h.getSession(), h.profile, response);
      expect(await hook).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
      await readScreen();
      expect(h.adapter.interaction(h.host, h.getSession())?.id).toBe(interaction.id);
      vi.setSystemTime(Date.now() + 2_001);
      await readScreen();
      expect(await responding).toEqual({ status: 'uncertain', message: 'Claude Code asked again in its terminal dialog.' });
      expect(h.adapter.interaction(h.host, h.getSession())).toBeUndefined();
      expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ phase: 'attention' });
      expect(await h.adapter.respond(h.host, h.getSession(), h.profile, response)).toEqual({ status: 'uncertain', message: 'Claude Code asked again in its terminal dialog.' });
    } finally { vi.useRealTimers(); }
  });

  it.each(['PostToolUse', 'PostToolUseFailure'])('does not clear the next question when %s arrives late', async event => {
    const h = await start();
    const p = await permission(h, 'old-plan');
    const responding = h.adapter.respond(h.host, h.getSession(), h.profile, p.response);
    await p.hook;
    const question = h.deliver({ hook_event_name: 'PermissionRequest', session_id: h.getSession().nativeSessionId, tool_name: 'AskUserQuestion', tool_use_id: 'next-question', tool_input: { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] } });
    await waitFor(() => h.adapter.interaction(h.host, h.getSession())?.requestId === 'next-question' ? true : undefined);
    await confirm(h, 'old-plan', p.toolInput, event);
    expect(await responding).toMatchObject({ status: 'completed', message: event === 'PostToolUseFailure' ? expect.stringContaining('failed') : expect.any(String) });
    expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ phase: 'attention', interaction: { requestId: 'next-question', kind: 'question' } });
    await h.deliver({ hook_event_name: 'SessionEnd', session_id: h.getSession().nativeSessionId });
    await question;
  });

  it.each(['allow', 'deny'])('records a provider denial truthfully after %s without granting persistent permissions', async action => {
    const h = await start();
    const p = await permission(h, 'denied-plan', { allowedPrompts: [{ tool: 'Bash', prompt: 'anything' }] });
    expect(p.interaction.message).not.toContain('allowedPrompts');
    const response = { ...p.response, action };
    const responding = h.adapter.respond(h.host, h.getSession(), h.profile, response);
    const output = await p.hook;
    expect(output).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: action, ...(action === 'allow' ? { updatedInput: p.toolInput } : {}) } } });
    await confirm(h, 'denied-plan', p.toolInput, 'PermissionDenied');
    expect(await responding).toMatchObject({ status: action === 'allow' ? 'uncertain' : 'completed', message: expect.stringMatching(/deni/i) });
    expect(h.getSession().approval).toBe('default');
    expect(await h.adapter.respond(h.host, h.getSession(), h.profile, response)).toMatchObject({ status: action === 'allow' ? 'uncertain' : 'completed' });
  });

  it('cleans an unconfirmed submission without implying success or offering a second execution', async () => {
    const h = await start();
    const p = await permission(h, 'unconfirmed-plan');
    vi.useFakeTimers();
    try {
      const responding = h.adapter.respond(h.host, h.getSession(), h.profile, p.response);
      await p.hook;
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
      expect(await responding).toMatchObject({ status: 'uncertain' });
      // Nothing waits on a person any more, so the turn is simply running again — with the reason said out loud.
      expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ phase: 'busy', notice: expect.stringContaining('Open the terminal') });
      expect(h.adapter.interaction(h.host, h.getSession())).toBeUndefined();
      expect(await h.adapter.respond(h.host, h.getSession(), h.profile, { ...p.response, requestId: 'after-cleanup' })).toMatchObject({ status: 'uncertain' });
      await expect(h.adapter.extendInteraction(h.host, h.getSession(), h.profile, p.interaction.id)).rejects.toMatchObject({ code: 'NATIVE_INTERACTION_GONE' });
      vi.useRealTimers();
      await h.deliver({ hook_event_name: 'Stop', session_id: h.getSession().nativeSessionId });
      await waitFor(() => h.adapter.status(h.host, h.getSession()).phase === 'idle' ? true : undefined);
      expect(h.adapter.status(h.host, h.getSession()).phase).toBe('idle');
      expect(await h.adapter.respond(h.host, h.getSession(), h.profile, p.response)).toMatchObject({ status: 'uncertain' });
    } finally { vi.useRealTimers(); }
  });

  it.each(['Stop', 'StopFailure'])('%s with a request nobody answered clears its card for good and lets the CLI ask in its own dialog', async event => {
    const h = await start();
    const p = await permission(h, `unanswered-${event}`);
    await h.deliver({ hook_event_name: event, session_id: h.getSession().nativeSessionId });
    // Not denied on the reader's behalf: the CLI is released to ask natively.
    expect(await p.hook).toEqual({});
    await waitFor(() => h.adapter.status(h.host, h.getSession()).phase === 'idle' ? true : undefined);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ phase: 'idle' });
    expect(h.adapter.status(h.host, h.getSession()).interaction).toBeUndefined();
  });

  it('lets the CLI ask natively when the server closes with a request open', async () => {
    const h = await start();
    const p = await permission(h, 'closing');
    await h.adapter.close();
    expect(await p.hook).toEqual({});
  });

  it.each(['Stop', 'StopFailure'])('lets %s finish an idle turn without inventing an approval acknowledgement', async event => {
    const h = await start();
    const p = await permission(h, `stopping-${event}`);
    const responding = h.adapter.respond(h.host, h.getSession(), h.profile, p.response);
    await p.hook;
    await h.deliver({ hook_event_name: event, session_id: h.getSession().nativeSessionId });
    await waitFor(() => h.adapter.status(h.host, h.getSession()).phase === 'idle' ? true : undefined);
    expect(await responding).toMatchObject({ status: 'uncertain' });
    await confirm(h, `stopping-${event}`, p.toolInput);
    expect(h.adapter.status(h.host, h.getSession()).phase).toBe('idle');
    expect(await h.adapter.respond(h.host, h.getSession(), h.profile, p.response)).toMatchObject({ status: 'uncertain' });
  });

  it('settles a submitted response as uncertain on terminal exit and never revives it on a late hook', async () => {
    const h = await start();
    const p = await permission(h, 'exiting-plan');
    const responding = h.adapter.respond(h.host, h.getSession(), h.profile, p.response);
    await p.hook;
    await h.terminals.stop(h.getSession().terminalId!);
    expect(await responding).toMatchObject({ status: 'uncertain' });
    await confirm(h, 'exiting-plan', p.toolInput);
    expect(h.adapter.status(h.host, h.getSession()).phase).toBe('offline');
    expect(await h.adapter.respond(h.host, h.getSession(), h.profile, p.response)).toMatchObject({ status: 'uncertain' });
  });
});

describe('Claude following the permission mode its own CLI reports', () => {
  const startIdle = async (h: FakeHarness) => {
    await h.open();
    const before = h.store.patches.length;
    await h.deliverSessionStart('default');
    // The launch's own handshake reports the mode it was launched with: nothing moved, so nothing is
    // written — and the fence a queued message was accepted under must not move either.
    expect(h.store.patches.slice(before)).toEqual([]);
    expect(h.adapter.status(h.host, h.getSession()).phase).toBe('idle');
  };

  it('writes a known mode back to the record and moves the configuration revision', async () => {
    const h = await makeHarness();
    await startIdle(h);
    const messages = h.listen();
    const before = h.store.patches.length;

    await h.deliverSessionStart('plan');

    // The revision moves because the meaning moved: a message already queued under `default` must be
    // refused (`CONFIGURATION_CHANGED`) rather than dispatched under a mode the user has left.
    expect(h.store.patches.slice(before)).toEqual([{ approval: 'plan', configRevision: 5 }]);
    expect(h.adapter.status(h.host, h.getSession()).approval).toBe('plan');
    // A client that keeps its own copy of the record has to be told, not left showing the old mode.
    expect(messages.find(message => message.type === 'session')).toMatchObject({ type: 'session', session: { approval: 'plan' } });
  });

  it('adopts the mode a submitted prompt reports as well', async () => {
    const h = await makeHarness();
    await startIdle(h);
    const before = h.store.patches.length;

    await h.deliver({ hook_event_name: 'UserPromptSubmit', session_id: h.getSession().nativeSessionId, permission_mode: 'acceptEdits', prompt: 'hello' });

    expect(h.store.patches.slice(before)).toEqual([{ approval: 'acceptEdits', configRevision: 5 }]);
  });

  it('keeps pending permission intent across old hooks and a cold runtime, and applies it once idle', async () => {
    const hot = await makeHarness();
    await startIdle(hot);
    await hot.deliver({ hook_event_name: 'UserPromptSubmit', session_id: hot.getSession().nativeSessionId, permission_mode: 'default', prompt: 'work' });
    hot.store.update(await hot.adapter.configure(hot.host, hot.getSession(), hot.profile, { approval: 'plan' }));
    await hot.deliver({ hook_event_name: 'PostToolUse', session_id: hot.getSession().nativeSessionId, permission_mode: 'default', tool_name: 'Bash', tool_use_id: 'old-tool' });
    expect(hot.getSession()).toMatchObject({ approval: 'plan', configPending: true });
    expect(hot.launches).toHaveLength(1);
    await hot.deliver({ hook_event_name: 'Stop', session_id: hot.getSession().nativeSessionId, permission_mode: 'default' });
    await waitFor(() => hot.launches.length === 2 && !hot.getSession().configPending ? true : undefined);
    expect(flagValue(hot.launches.at(-1)!.args, '--permission-mode')).toBe('plan');
    await hot.deliverSessionStart('plan');
    const stops = hot.terminals.stopped.length;
    hot.store.update(await hot.adapter.configure(hot.host, hot.getSession(), hot.profile, { approval: 'plan' }));
    expect(hot.launches).toHaveLength(2);
    expect(hot.terminals.stopped).toHaveLength(stops);

    const cold = await makeHarness();
    await appendRows(cold, humanRow('p-cold'));
    cold.store.update({ approval: 'plan', configPending: true });
    await cold.attachColdRuntime('busy');
    await appendRows(cold, durationRow());
    await waitFor(() => cold.launches.length === 1 && !cold.getSession().configPending ? true : undefined);
    expect(flagValue(cold.launches[0]!.args, '--permission-mode')).toBe('plan');
  });

  it('returns a question\'s PreToolUse hook at once and holds the card on its PermissionRequest hook', async () => {
    const h = await makeHarness();
    await startIdle(h);
    const sessionId = h.getSession().nativeSessionId;
    const toolInput = { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] };
    // Claude Code writes the rows in front of a tool call once its PreToolUse hooks have returned: a hook held for a person hides them.
    expect(await h.deliver({ hook_event_name: 'PreToolUse', session_id: sessionId, tool_name: 'AskUserQuestion', tool_use_id: 'ask-1', tool_input: toolInput })).toEqual({});
    expect(h.adapter.status(h.host, h.getSession()).interaction).toBeUndefined();
    const hook = h.deliver({ hook_event_name: 'PermissionRequest', session_id: sessionId, tool_name: 'AskUserQuestion', tool_input: toolInput });
    const card = await waitFor(() => h.adapter.status(h.host, h.getSession()).interaction);
    expect(card).toMatchObject({ kind: 'question', requestId: 'ask-1' });
    await h.adapter.respond(h.host, h.getSession(), h.profile, { interactionId: card.id, revision: card.revision, requestId: 'web-1', action: 'answer', selectedIds: [card.options[1]!.id] });
    expect(await hook).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...toolInput, answers: { 'Continue?': 'No' } } } } });
  });

  it('keeps a permission request answerable for as long as the CLI waits, and leaves 延长 as a no-op', async () => {
    const h = await makeHarness();
    await startIdle(h);
    const hook = h.deliver({ hook_event_name: 'PermissionRequest', session_id: h.getSession().nativeSessionId, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'tool-1' });
    const opened = await waitFor(() => h.adapter.status(h.host, h.getSession()).interaction);
    expect(opened.expiresAt).toBeUndefined();
    expect(opened.extendableUntil).toBeUndefined();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
      expect(await Promise.race([hook, Promise.resolve('waiting')])).toBe('waiting');
    } finally { vi.useRealTimers(); }
    expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ phase: 'attention', interaction: { id: opened.id } });
    expect(await h.adapter.extendInteraction(h.host, h.getSession(), h.profile, opened.id)).toEqual(opened);

    void h.adapter.respond(h.host, h.getSession(), h.profile, { interactionId: opened.id, revision: opened.revision, requestId: 'web-1', action: 'deny' });
    await hook;
  });

  it('ignores a mode label this backend cannot send back', async () => {
    const h = await makeHarness();
    await startIdle(h);
    const before = h.store.patches.length;

    await h.deliverSessionStart('delegate');

    // `--permission-mode` is validated on the way out, so a mode from a newer CLI must never reach
    // the record: the next launch would fail on it.
    expect(h.store.patches.slice(before)).toEqual([]);
    expect(h.adapter.status(h.host, h.getSession()).approval).toBe('default');
  });

  it('does not adopt while a configuration change is in flight', async () => {
    const h = await makeHarness();
    await startIdle(h);
    const hold = h.holdNextLaunch();
    h.store.update(await h.adapter.configure(h.host, h.getSession(), h.profile, { model: 'opus' }));
    await hold.started;
    const before = h.store.patches.length;

    // The CLI being replaced still reports the mode it was launched with; adopting it here would
    // pin back the very value the user is moving away from.
    await h.deliverSessionStart('plan');

    expect(h.store.patches.slice(before)).toEqual([]);
    hold.release();
    await waitFor(() => (h.getSession().configPending === false ? true : undefined));
    expect(h.getSession()).toMatchObject({ approval: 'default', model: 'opus' });
  });

  it('carries an adopted mode into the next launch instead of the stale record', async () => {
    const h = await makeHarness();
    await startIdle(h);
    await h.deliverSessionStart('plan');

    // Only the model is asked for here; the approval is whatever the record says.
    await pick(h, { model: 'opus' });

    const args = h.launches.at(-1)!.args;
    // A reopened conversation is launched with `--resume`; the mode travels on that same command
    // line, which is the only way the workbench can put a resumed TUI into another mode.
    expect(flagValue(args, '--resume')).toBe(h.getSession().nativeSessionId);
    expect(flagValue(args, '--model')).toBe('opus');
    expect(flagValue(args, '--permission-mode')).toBe('plan');
  });
});

// A paste is written as one bracketed paste and, for a long time, submitted by an Enter pressed
// 80 ms later. That is too early for anything multi-line: Claude collapses such a paste into
// `[Pasted text #N +M lines]` a few hundred milliseconds after the bytes arrive, so the box is still
// empty when that Enter lands, it goes nowhere, no turn starts — and the transcript receipt the send
// waits on can never arrive. Ninety seconds later the run was parked on `uncertain` while the message
// sat visibly unsent in the terminal. Every message with an attachment took that shape (the rendered
// prompt carries the file paths on their own lines); every text-only message arrived.
describe('Claude sending into the composer', () => {
  const prompt = '还有，cursor 的 plan 模式无法被识别为web 卡';
  const composerRule = '─'.repeat(100);
  /** A pane whose composer still holds the prompt the workbench pasted into it. */
  const stuckComposer = () => ['', '● Previous turn finished.', '', composerRule, `❯ ${prompt}`, composerRule, '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\n');

  const request = (h: FakeHarness, text: string): NativeBackendSendRequest => ({
    session: h.getSession(), project: h.host.getProject(h.getSession().projectId), profile: h.profile,
    commandId: 'command-1', runId: 'run-1',
    input: { text, attachmentIds: [], context: [] },
    config: { mode: 'agent' },
    commitDispatchFence: () => ({} as Run),
  });

  /**
   * Start one send on a faked clock. The promise is handed back inside an object on purpose: an
   * async function that returns it would adopt it and wait for the receipt the test is about to fake.
   */
  const startSend = async (h: FakeHarness, screens: string[]): Promise<{ sending: Promise<void> }> => {
    await h.open();
    await h.deliverSessionStart('default');
    h.control.screens = screens;
    vi.useFakeTimers();
    const sending = h.adapter.send(h.host, request(h, prompt));
    // The rejection is asserted later, after fake time has been advanced past it; a sink attached
    // now keeps that gap from being reported as an unhandled rejection.
    sending.catch(() => undefined);
    return { sending };
  };

  /** Settle the send's own microtask chain up to the paste, without moving the faked clock. */
  const settlePaste = async (h: FakeHarness): Promise<void> => {
    for (let turn = 0; turn < 40 && h.control.pastes.length === 0; turn += 1) await Promise.resolve();
  };

  it('holds the Enter until the composer shows the paste', async () => {
    const h = await makeHarness();
    // The guard reads an idle box, and the first poll still reads an empty one — the placeholder a
    // multi-line paste turns into is not drawn yet — so nothing may be pressed at that point.
    const { sending } = await startSend(h, [IDLE_SCREEN, IDLE_SCREEN, stuckComposer()]);
    try {
      await settlePaste(h);
      expect(h.control.pastes).toEqual([prompt]);
      expect(h.control.keys).toEqual([]);

      // One poll later the paste is drawn, and only then is Enter pressed.
      await vi.advanceTimersByTimeAsync(60);
      expect(h.control.keys).toEqual([['Enter']]);

      await vi.advanceTimersByTimeAsync(90_000);
      await expect(sending).rejects.toThrow(/did not confirm/);
    } finally { vi.useRealTimers(); }
  });

  it('presses Enter again while the composer keeps holding the paste', async () => {
    const h = await makeHarness();
    // The box shows the paste for the poll and then never gives it up: the press after it is lost.
    const { sending } = await startSend(h, [IDLE_SCREEN, stuckComposer()]);
    try {
      await settlePaste(h);
      await vi.advanceTimersByTimeAsync(60);
      expect(h.control.keys).toEqual([['Enter']]);

      // Pressing is bounded: a CLI that holds the text through every retry is left to answer for
      // itself, and the run still ends as unconfirmed rather than waiting on a receipt forever.
      await vi.advanceTimersByTimeAsync(90_000);
      expect(h.control.keys).toEqual([['Enter'], ['Enter'], ['Enter'], ['Enter']]);
      await expect(sending).rejects.toThrow(/did not confirm/);
    } finally { vi.useRealTimers(); }
  });

  it('leaves a composer that gave the paste up alone', async () => {
    const h = await makeHarness();
    // Claude took the write: the box is empty afterwards, so an extra Enter would only risk a second
    // submission. One press is the whole send.
    const { sending } = await startSend(h, [IDLE_SCREEN, stuckComposer(), IDLE_SCREEN]);
    try {
      await settlePaste(h);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(h.control.keys).toEqual([['Enter']]);
      await expect(sending).rejects.toThrow(/did not confirm/);
    } finally { vi.useRealTimers(); }
  });
});

// A Stop hook says the main loop finished. It does not say the session did: Claude Code continues on
// its own — after a compact, or when a background agent reports back — and starts a turn that no
// hook announces. Reading the screen's status slot is what tells those apart; before that, the
// session was called finished while the pane was plainly still working (measured: a run completed
// five seconds after the continuation began, and the CLI kept going for twenty minutes).
describe('Claude status while a turn runs', () => {
  const statusOf = (h: FakeHarness) => h.adapter.status(h.host, h.getSession()).phase;

  /**
   * Claude Code announces a session start for a turn that is already running: it compacts its own
   * context when it runs out and carries straight on (`source: 'compact'`), and restarting the CLI
   * on resume does the same. Neither carries a `UserPromptSubmit`, so reading the start as "idle"
   * left a working session looking finished until the screen poll — or the next tool call — put it
   * back. A cold start is still idle.
   */
  it('does not idle a running turn when Claude restarts its own session', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('startup');
    const session = h.getSession();
    await h.deliver({ hook_event_name: 'UserPromptSubmit', session_id: session.nativeSessionId, prompt: 'work', prompt_id: 'p-run', permission_mode: 'default' });
    await waitFor(() => (statusOf(h) === 'busy' ? true : undefined));

    for (const source of ['compact', 'resume', 'clear', 'fork']) {
      await h.deliver({
        hook_event_name: 'SessionStart', session_id: session.nativeSessionId,
        transcript_path: h.transcriptPath, permission_mode: 'default', source,
      });
      expect(statusOf(h)).toBe('busy');
    }

    // The CLI does say when it is done: the turn's own end reaches idle at once.
    await h.deliver({ hook_event_name: 'Stop', session_id: session.nativeSessionId, prompt_id: 'p-run' });
    expect(statusOf(h)).toBe('idle');
  });

  // EnterWorktree / ExitWorktree make the CLI announce a transcript path in the other directory's
  // project folder, while it keeps writing the file the conversation started in. Following that
  // path left the conversation frozen at the switch.
  it('keeps reading the existing transcript when a session start names a path with no file', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    h.listen();
    const elsewhere = join(dirname(dirname(h.transcriptPath)), '-riffet-test--claude-worktrees-x', basename(h.transcriptPath));
    await h.deliver({
      hook_event_name: 'SessionStart', session_id: h.getSession().nativeSessionId,
      transcript_path: elsewhere, permission_mode: 'default', source: 'resume',
    });
    await appendRows(h, { type: 'assistant', uuid: 'after-worktree-exit', message: { role: 'assistant', content: [{ type: 'text', text: 'still here' }] } });
    const runtime = (h.adapter as unknown as { runtimes: Map<string, { refreshTranscript(): Promise<void> }> }).runtimes.get(h.getSession().id)!;
    await runtime.refreshTranscript();
    expect(JSON.stringify(rows(h)).includes('still here')).toBe(true);
  });

  // `--resume` launches announce themselves with `source: 'resume'`. While the runtime is still
  // `starting` there is no turn to protect, so any start must open the session; leaving it wedged
  // made every send fail with CLI_BUSY for good.
  it('leaves `starting` on any SessionStart source, and on an idle composer when the hook never comes', async () => {
    const h = await makeHarness();
    await h.open();
    expect(statusOf(h)).toBe('starting');
    await h.deliver({
      hook_event_name: 'SessionStart', session_id: h.getSession().nativeSessionId,
      transcript_path: h.transcriptPath, permission_mode: 'default', source: 'resume',
    });
    expect(statusOf(h)).toBe('idle');

    const silent = await makeHarness();
    await silent.open();
    expect(statusOf(silent)).toBe('starting');
    await waitFor(() => (statusOf(silent) === 'idle' ? true : undefined));
  });

  // A resume announces itself before the input box is redrawn, so the hook only opens the gate: the
  // composer has to be seen after it. If it never is, the gate gives up rather than hold the session.
  it('waits for the input box after SessionStart(resume), and accepts the hook alone after the gate timeout', async () => {
    const resume = (h: FakeHarness) => h.deliver({
      hook_event_name: 'SessionStart', session_id: h.getSession().nativeSessionId,
      transcript_path: h.transcriptPath, permission_mode: 'default', source: 'resume',
    });
    const h = await makeHarness();
    await h.open();
    const terminalId = h.getSession().terminalId!;
    h.terminals.screens.set(terminalId, 'Resuming conversation…');
    await resume(h);
    expect(statusOf(h)).toBe('starting');
    h.terminals.screens.set(terminalId, IDLE_SCREEN);
    await waitFor(() => (statusOf(h) === 'idle' ? true : undefined));

    const silent = await makeHarness();
    await silent.open();
    silent.terminals.screens.set(silent.getSession().terminalId!, 'Resuming conversation…');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await resume(silent);
      expect(statusOf(silent)).toBe('starting');
      await vi.advanceTimersByTimeAsync(9_000);
      expect(statusOf(silent)).toBe('starting');
      await vi.advanceTimersByTimeAsync(1_500);
      expect(statusOf(silent)).toBe('idle');
    } finally { vi.useRealTimers(); }
  });

  it('reports a structured launch failure when neither a hook nor an input box shows up, and clears it on recovery', async () => {
    const h = await makeHarness();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await h.open();
      h.terminals.screens.set(h.getSession().terminalId!, 'Loading…');
      await vi.advanceTimersByTimeAsync(44_000);
      expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ phase: 'starting' });
      expect(h.adapter.status(h.host, h.getSession()).connection).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ phase: 'starting', connection: { state: 'failed' } });
    } finally { vi.useRealTimers(); }
    h.terminals.screens.set(h.getSession().terminalId!, IDLE_SCREEN);
    await waitFor(() => (statusOf(h) === 'idle' ? true : undefined));
    expect(h.adapter.status(h.host, h.getSession()).connection).toBeUndefined();
  });

  it('claims the pending send from a hook prompt wrapped in pasted_content', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    const session = h.getSession();
    const text = 'first line\nsecond line';
    void h.adapter.send(h.host, {
      session, project: h.host.getProject(session.projectId), profile: h.profile,
      commandId: 'command-paste', runId: 'run-paste',
      input: { text, attachmentIds: [], context: [] },
      config: { mode: 'agent' },
      commitDispatchFence: () => ({} as Run),
    }).catch(() => undefined);
    await waitFor(() => (h.control.pastes.length > 0 ? true : undefined));
    const runtime = (h.adapter as unknown as { runtimes: Map<string, { pendingSend?: { promptSeen: boolean } }> }).runtimes.get(session.id)!;
    await h.deliver({
      hook_event_name: 'UserPromptSubmit', session_id: session.nativeSessionId,
      prompt: `\n<pasted_content id="1">${text}</pasted_content id="1">`, prompt_id: 'prompt-paste', permission_mode: 'default',
    });
    expect(runtime.pendingSend?.promptSeen).toBe(true);
  });

  it('does not call a turn finished when the Stop of an earlier prompt arrives while the next one is already running', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    const session = h.getSession();
    h.listen();

    // A send in flight owns the web turn the Stop hook would otherwise close.
    const prompt = 'riffet 肯定需要可以批准 plan';
    const pending = (h.adapter.send(h.host, {
      session, project: h.host.getProject(session.projectId), profile: h.profile,
      commandId: 'command-stop', runId: 'run-stop',
      input: { text: prompt, attachmentIds: [], context: [] },
      config: { mode: 'agent' },
      commitDispatchFence: () => ({} as Run),
    }) satisfies Promise<void>).catch(() => undefined);
    await waitFor(() => (h.control.pastes.length > 0 ? true : undefined));
    await h.deliver({
      hook_event_name: 'UserPromptSubmit', session_id: session.nativeSessionId,
      prompt, prompt_id: 'prompt-1', permission_mode: 'default',
    });
    await waitFor(() => (statusOf(h) === 'busy' ? true : undefined));
    expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ phase: 'busy', activeTurn: { turnId: 'prompt-1' }, activeTurnId: 'run-stop' });

    // The previous turn's end — a late Stop, and its `turn_duration` read before this turn's own row — is
    // not this turn's end, and the screen has no say.
    await h.deliver({ hook_event_name: 'Stop', session_id: session.nativeSessionId, prompt_id: 'prompt-0' });
    await appendRows(h, durationRow());
    await h.read();
    expect(statusOf(h)).toBe('busy');

    // Its own Stop hook is one of several the CLI runs; the turn ends when the summary of all of them is written.
    await appendRows(h, humanRow('prompt-1', prompt));
    await h.deliver({ hook_event_name: 'Stop', session_id: session.nativeSessionId, prompt_id: 'prompt-1' });
    expect(statusOf(h)).toBe('busy');
    await appendRows(h, stopSummaryRow());
    await h.read();
    expect(statusOf(h)).toBe('idle');
    void pending;
  });

  // The turn's own rows are written after its Stop hook arrives: the assistant text, the
  // stop-hook summary, the duration. They describe a turn that is over and must not reopen it.
  it('stays idle after Stop while the rest of that turn is still being read from the transcript', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    const session = h.getSession();
    await waitFor(() => (statusOf(h) === 'idle' ? true : undefined));
    const messages = h.listen();
    await h.deliver({ hook_event_name: 'UserPromptSubmit', session_id: session.nativeSessionId, prompt: 'work', prompt_id: 'p1', permission_mode: 'default' });
    await h.deliver({ hook_event_name: 'Stop', session_id: session.nativeSessionId, prompt_id: 'p1' });
    expect(statusOf(h)).toBe('idle');
    const rows = [humanRow('p1', 'work'), { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }];
    await appendRows(h, ...rows);
    await h.read();
    // A transcript remap before its durable end arrives must preserve the Stop already seen.
    await writeFile(h.transcriptPath, [{ type: 'file-history-snapshot' }, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n');
    await h.read();
    expect(statusOf(h)).toBe('idle');
    await appendRows(h, durationRow());
    await h.read();
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(statusOf(h)).toBe('idle');
    const phases = messages.flatMap(message => message.type === 'status' ? [message.status.phase] : []);
    expect(phases.filter(phase => phase === 'busy')).toHaveLength(1);
    expect(phases.at(-1)).toBe('idle');
  });

  // A turn the hooks never announced (they are lossy) still opens and closes from the transcript alone.
  it('follows a turn from the transcript when no hook announces it', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    await waitFor(() => (statusOf(h) === 'idle' ? true : undefined));
    await appendRows(h, humanRow('p-silent'));
    await h.read();
    expect(statusOf(h)).toBe('busy');
    // A Stop for another prompt ends nothing; the turn's own duration row does.
    await h.deliver({ hook_event_name: 'Stop', session_id: h.getSession().nativeSessionId, prompt_id: 'someone-else' });
    expect(statusOf(h)).toBe('busy');
    await appendRows(h, durationRow());
    await h.read();
    expect(statusOf(h)).toBe('idle');
    // The CLI's own interruption marker ends a turn that has no duration row.
    await appendRows(h, humanRow('p-esc'));
    await h.read();
    expect(statusOf(h)).toBe('busy');
    await appendRows(h, { type: 'user', promptId: 'p-esc', message: { role: 'user', content: '[Request interrupted by user]' } });
    await h.read();
    expect(statusOf(h)).toBe('idle');
  });

  it('only reports a turn that stays silent for a very long time, and leaves its state alone', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    await h.deliver({ hook_event_name: 'UserPromptSubmit', session_id: h.getSession().nativeSessionId, prompt: 'work', prompt_id: 'p-long', permission_mode: 'default' });
    await waitFor(() => (statusOf(h) === 'busy' ? true : undefined));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 31 * 60_000);
      const notice = await waitFor(() => h.adapter.status(h.host, h.getSession()).notice);
      expect(notice).toMatch(/no activity/);
      expect(statusOf(h)).toBe('busy');
      await h.deliver({ hook_event_name: 'PostToolUse', session_id: h.getSession().nativeSessionId, prompt_id: 'p-long', tool_use_id: 't1', tool_name: 'Bash' });
      expect(h.adapter.status(h.host, h.getSession()).notice).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('does not read a saved terminal with an unreadable screen as busy', async () => {
    const h = await makeHarness({ screen: 'Partial redraw\n❯' });
    await h.attachColdRuntime('idle');
    expect(h.adapter.status(h.host, h.getSession()).notice).toBeUndefined();
  });
});

// A CLI that outlived the server is the same CLI afterwards: taken over, not restarted, with its turn
// read back from the transcript.
describe('Claude takeover of a live terminal', () => {
  it('reattaches to the running pane and replays its turn from the transcript instead of relaunching', async () => {
    const h = await makeHarness();
    await appendRows(h, humanRow('p-before'), durationRow(), humanRow('p-open', 'still going'));
    const opened = await h.open({ takeover: true });
    expect(opened.terminalId).toBe(h.savedTerminalId);
    expect(h.launches).toHaveLength(0);
    expect(h.terminals.stopped).toEqual([]);
    expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ phase: 'busy' });
    // The turn that was open finishes while no server was watching; the record says so.
    await appendRows(h, durationRow());
    await waitFor(() => (h.adapter.status(h.host, h.getSession()).phase === 'idle' ? true : undefined));
    expect(h.launches).toHaveLength(0);
  });

  it('keeps a taken-over pane’s hook-held question over the dialog the CLI draws for it', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    const sessionId = h.getSession().nativeSessionId;
    // A runtime that found the CLI already running (the server restarted) started nothing: it reads the pane every tick.
    (h.adapter as unknown as { runtimes: Map<string, { started: boolean }> }).runtimes.get(h.getSession().id)!.started = false;
    await h.deliver({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt_id: 'p-open', prompt: 'ask me' });
    const rule = '─'.repeat(80);
    h.terminals.screens.set(h.getSession().terminalId!, [rule, ' ☐ Scope', '', 'Which scope?', '', '❯ 1. Small', '  2. Large', '  3. Type something.', rule, '  4. Chat about this', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n'));
    const toolInput = { questions: [{ question: 'Which scope?', header: 'Scope', options: [{ label: 'Small' }, { label: 'Large' }] }] };
    await h.deliver({ hook_event_name: 'PreToolUse', session_id: sessionId, prompt_id: 'p-open', tool_name: 'AskUserQuestion', tool_use_id: 'ask-1', tool_input: toolInput });
    const hook = h.deliver({ hook_event_name: 'PermissionRequest', session_id: sessionId, prompt_id: 'p-open', tool_name: 'AskUserQuestion', tool_input: toolInput });
    const card = await waitFor(() => { const shown = h.adapter.status(h.host, h.getSession()).interaction; return shown?.transport === 'protocol' ? shown : undefined; });
    // Cold monitoring reads the pane every tick; the dialog on it is the same question, which only the hook can answer.
    await new Promise(resolve => setTimeout(resolve, 2_000));
    expect(h.adapter.status(h.host, h.getSession()).interaction?.id).toBe(card.id);
    await h.adapter.respond(h.host, h.getSession(), h.profile, { interactionId: card.id, revision: card.revision, requestId: 'web-1', action: 'answer', selectedIds: [card.options[1]!.id] });
    expect(await hook).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow', updatedInput: { answers: { 'Which scope?': 'Large' } } } } });
  });

  it('writes to a taken-over idle pane without a second launch', async () => {
    const h = await makeHarness();
    await h.open({ takeover: true });
    await waitFor(() => (h.adapter.status(h.host, h.getSession()).phase === 'idle' ? true : undefined));
    const sending = h.adapter.send(h.host, {
      session: h.getSession(), project: h.host.getProject(h.getSession().projectId), profile: h.profile,
      commandId: 'command-takeover', runId: 'run-takeover', input: { text: 'after restart', attachmentIds: [], context: [] },
      config: { mode: 'agent' }, commitDispatchFence: () => ({} as Run),
    }).catch(() => undefined);
    await waitFor(() => (h.control.pastes.length > 0 ? true : undefined));
    expect(h.control.pastes).toEqual(['after restart']);
    expect(h.launches).toHaveLength(0);
    void sending;
  });
});

// The two questions a write has to answer are not the same one. "Is this session finished?" is what
// the status reports; "will this CLI run a prompt right now?" is what the send guard asks. A CLI that
// is only waiting on background agents answers yes to the second while still working on the first.
describe('Claude sending while background work is tracked', () => {
  const request = (h: FakeHarness, prompt: string): NativeBackendSendRequest => ({
    session: h.getSession(), project: h.host.getProject(h.getSession().projectId), profile: h.profile,
    commandId: 'command-delegated', runId: 'run-delegated',
    input: { text: prompt, attachmentIds: [], context: [] },
    config: { mode: 'agent' },
    commitDispatchFence: () => ({} as Run),
  });

  it('writes straight away while only background agents run, and reports the session idle', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    await waitFor(() => (h.adapter.status(h.host, h.getSession()).phase === 'idle' ? true : undefined));
    await startBackgroundAgent(h);
    // The main agent is free: background work is reported through its own `subagent` frames.
    expect(h.adapter.status(h.host, h.getSession()).phase).toBe('idle');

    const sending = h.adapter.send(h.host, request(h, '接着做 plan 的展示')).catch(() => undefined);

    await waitFor(() => (h.control.pastes.length > 0 ? true : undefined));
    expect(h.control.pastes).toEqual(['接着做 plan 的展示']);
    void sending;
  });

  // 2.1.302 draws a focused tasks entry only in reverse video; while it has the keyboard a paste is dropped and Enter opens it.
  it('gives the box back the keyboard from a focused tasks entry, and presses Enter for a paste the box shows late only once it does', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    await waitFor(() => (h.adapter.status(h.host, h.getSession()).phase === 'idle' ? true : undefined));
    const rule = '─'.repeat(60);
    const withShell = [rule, '❯ ', rule, '  ⏵⏵ auto mode on · 1 shell'].join('\n');
    h.control.screens = [withShell];
    h.control.styled = [[rule, '❯ ', rule, '  \u001b[38;5;137m⏵⏵ auto mode on\u001b[38;5;241m · \u001b[7m\u001b[38;5;37m1 shell\u001b[0m'].join('\n'), withShell];
    void h.adapter.send(h.host, request(h, 'first')).catch(() => undefined);
    await waitFor(() => (h.control.keys.some(keys => keys.includes('Enter')) ? true : undefined));
    expect(h.control.keys.slice(0, 2)).toEqual([['Up'], ['Enter']]);
    expect(h.control.pastes).toEqual(['first']);

    const dropped = await makeHarness();
    await dropped.open();
    await dropped.deliverSessionStart('default');
    await waitFor(() => (dropped.adapter.status(dropped.host, dropped.getSession()).phase === 'idle' ? true : undefined));
    dropped.control.dropPastes = true;
    vi.useFakeTimers();
    try {
      const sending = dropped.adapter.send(dropped.host, request(dropped, 'second'));
      sending.catch(() => undefined);
      // The box shows nothing within the window: the send is not failed and no Enter is pressed.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(dropped.control.pastes).toEqual(['second']);
      expect(dropped.control.keys).toEqual([]);
      // The CLI draws the paste late (several image paths take it a long while): the receipt wait presses the one Enter.
      dropped.control.typed = 'second';
      await vi.advanceTimersByTimeAsync(600);
      expect(dropped.control.keys).toEqual([['Enter']]);
    } finally { vi.useRealTimers(); }
  });

  it('refuses a write while the main turn is running, and while no input box is drawn', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    await h.deliver({ hook_event_name: 'UserPromptSubmit', session_id: h.getSession().nativeSessionId, prompt: 'working', prompt_id: 'p-busy', permission_mode: 'default' });
    await expect(h.adapter.send(h.host, request(h, '别插队'))).rejects.toMatchObject({ code: 'CLI_BUSY' });
    await h.deliver({ hook_event_name: 'Stop', session_id: h.getSession().nativeSessionId, prompt_id: 'p-busy' });
    h.control.screens = [BARE_SCREEN];
    await expect(h.adapter.send(h.host, request(h, '没有输入框'))).rejects.toThrow(/not at its input prompt/);
    expect(h.control.pastes).toEqual([]);
  });

  it('refuses an inline dialog before fencing or writing even when the screen poll still reports idle', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    // Only the locked capture sees the newly drawn dialog; the background observer still sees an idle composer.
    h.control.screens = [
      ['─'.repeat(60), ' Teach auto mode about your environment?', '',
        ' Auto mode works better when it knows your environment. Takes about a minute.', '',
        ' ❯ 1. Yes', '   2. Not now', "   3. Don't show again", '',
        ' Enter to confirm · Esc to cancel', '', IDLE_SCREEN.slice(IDLE_SCREEN.indexOf('─'))].join('\n'),
    ];
    const commitDispatchFence = vi.fn();
    await expect(h.adapter.send(h.host, { ...request(h, 'continue'), commitDispatchFence }))
      .rejects.toMatchObject({ code: 'CLI_INTERACTION_REQUIRED' });
    expect(commitDispatchFence).not.toHaveBeenCalled();
    expect(h.control.pastes).toEqual([]);
    expect(h.control.keys).toEqual([]);
  });

  // Stop never presses a key that could quit the CLI: with nothing running there is nothing to stop,
  // and background agents are stopped by the one Ctrl-C the CLI answers with `agents_killed`.
  it('stops background agents with one Ctrl-C confirmed by the CLI’s own record, and presses nothing when nothing runs', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    await waitFor(() => (h.adapter.status(h.host, h.getSession()).phase === 'idle' ? true : undefined));
    const keys: string[][] = [];
    h.host.terminal.sendKeys = async (_terminalId: string, pressed: string[]) => { keys.push(pressed); };

    await h.adapter.interrupt(h.host, h.getSession(), h.profile);
    expect(keys).toEqual([]);

    await startBackgroundAgent(h);
    const stopping = h.adapter.interrupt(h.host, h.getSession(), h.profile);
    await waitFor(() => (keys.length > 0 ? true : undefined));
    await backgroundAgentFiles(h, { stoppedByUser: true });
    await appendRows(h, { type: 'system', subtype: 'agents_killed' });
    await stopping;
    expect(keys).toEqual([['C-c']]);
  });

  // A safety net for an end the records never report: the footer draws shells, monitors and agents, so a long-quiet footer says they are over.
  it('drops background work the idle screen has shown none of for a while, and keeps it while the footer draws it', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    await waitFor(() => (h.adapter.status(h.host, h.getSession()).phase === 'idle' ? true : undefined));
    const terminalId = h.getSession().terminalId!;
    const rule = '─'.repeat(60);
    const withShell = [rule, '❯ ', rule, '  ⏵⏵ auto mode on · 1 shell'].join('\n');
    h.terminals.screens.set(terminalId, withShell);
    await startBackgroundAgent(h);
    const runtime = (h.adapter as unknown as { runtimes: Map<string, { convergeBackground(screen: string): Promise<void>; screenConvergenceSupported(): Promise<boolean> }> }).runtimes.get(h.getSession().id)!;
    runtime.screenConvergenceSupported = async () => true;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let read = 0; read < 3; read += 1) { vi.setSystemTime(Date.now() + 10_000); await runtime.convergeBackground(withShell); }
      expect(runningAgents(h)).toBe(1);
      h.terminals.screens.set(terminalId, IDLE_SCREEN);
      await runtime.convergeBackground(IDLE_SCREEN);
      expect(runningAgents(h)).toBe(1);
      vi.setSystemTime(Date.now() + 6_000);
      await runtime.convergeBackground(IDLE_SCREEN);
      expect(runningAgents(h)).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  // A `dequeue` row names nothing, so a wrong guess leaves an entry no row removes; an idle CLI holds no queue.
  it('clears a CLI queue entry left over at an idle screen, which would otherwise block a settings relaunch for good', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    await waitFor(() => (h.adapter.status(h.host, h.getSession()).phase === 'idle' ? true : undefined));
    const runtime = (h.adapter as unknown as { runtimes: Map<string, { convergeBackground(screen: string): Promise<void>; screenConvergenceSupported(): Promise<boolean>; state: { cliQueue: unknown[] } }> }).runtimes.get(h.getSession().id)!;
    runtime.screenConvergenceSupported = async () => true;
    await appendRows(h, { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "x" completed</summary>\n</task-notification>' });
    await waitFor(() => (runtime.state.cliQueue.length === 1 ? true : undefined));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await runtime.convergeBackground(IDLE_SCREEN);
      expect(runtime.state.cliQueue).toHaveLength(1);
      vi.setSystemTime(Date.now() + 6_000);
      await runtime.convergeBackground(IDLE_SCREEN);
      expect(runtime.state.cliQueue).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  // The "Background" list is walked over several keys; on a version whose screens were never captured nobody checked them.
  it('leaves background shells to the terminal on an untested Claude Code, pressing no key', async () => {
    const h = await makeHarness();
    const newer = join(root, `claude-new-${randomUUID()}`);
    await writeFile(newer, STUB_CLI.replace('2.1.252', '9.0.0'), { mode: 0o755 });
    h.profile.config.executable = newer;
    await h.open();
    await h.deliverSessionStart('default');
    await waitFor(() => (h.adapter.status(h.host, h.getSession()).phase === 'idle' ? true : undefined));
    const keys: string[][] = [];
    h.host.terminal.sendKeys = async (_terminalId: string, pressed: string[]) => { keys.push(pressed); };
    await appendRows(h, humanRow('p-sh', 'build in the background'),
      { type: 'assistant', message: { id: 'm-sh', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-sh-1', name: 'Bash', input: { command: 'make', run_in_background: true } }] } },
      { type: 'user', toolUseResult: { backgroundTaskId: 'bsh1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-sh-1', content: 'Command running in background with ID: bsh1.' }] } },
      durationRow());
    for (let tries = 0; tries < 50 && !runningAgents(h); tries += 1) { await h.read(); await new Promise(resolve => setTimeout(resolve, 100)); }
    expect(runningAgents(h)).toBe(1);

    await expect(h.adapter.interrupt(h.host, h.getSession(), h.profile)).rejects.toThrow(/9\.0\.0 background shells and monitors have to be stopped in its terminal/);
    expect(keys).toEqual([]);
    expect(h.control.keys).toEqual([]);
  });

  // Clients read activities from the journal (sync v3): the stop has to show there as it goes, not only in the status.
  it('records a stop of background work in the journal as stopping until the CLI reports it stopped', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    await waitFor(() => (h.adapter.status(h.host, h.getSession()).phase === 'idle' ? true : undefined));
    const journal = new Journal(new DatabaseSync(':memory:'));
    const id = h.getSession().id;
    const ingest = new TranscriptIngest({ journal, source: () => h.adapter.transcript(h.host, h.getSession(), h.profile) });
    h.host.transcript = {
      drain: sessionId => ingest.drain(sessionId),
      endTurn: (sessionId, turnId, status, at, error) => ingest.endTurn(sessionId, turnId, status, at, error),
      withSource: (sessionId, task) => ingest.control(sessionId, task),
      wake: sessionId => ingest.wake(sessionId),
    };
    const release = ingest.follow(id);
    cleaning.push(async () => { release(); ingest.close(); });
    const keys: string[][] = [];
    h.host.terminal.sendKeys = async (_terminalId: string, pressed: string[]) => { keys.push(pressed); };
    await appendRows(h, humanRow('p-bg', 'dig in the background'),
      { type: 'assistant', message: { id: 'm-bg', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-bg-1', name: 'Agent', input: { description: 'Sleeps', prompt: 'sleep', run_in_background: true } }] } },
      { type: 'user', toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'bg1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-bg-1', content: 'Async agent launched' }] } },
      durationRow());
    await startBackgroundAgent(h);
    const lane = () => rowsOf(journal, id).flatMap(row => activityOfEvent(row.payload) ?? []).filter(activity => activity.id === 'claude:bg1').map(activity => activity.status);
    await ingest.drain(id);
    expect(lane()).toEqual(['running']);

    const stopping = h.adapter.stopActivity!(h.host, h.getSession(), h.profile, 'claude:bg1');
    await waitFor(() => (keys.length > 0 ? true : undefined));
    expect(lane()).toEqual(['running', 'stopping']);
    await backgroundAgentFiles(h, { stoppedByUser: true });
    await appendRows(h, { type: 'system', subtype: 'agents_killed' });
    await stopping;
    await ingest.drain(id);
    expect(lane()).toEqual(['running', 'stopping', 'stopped']);
  });

  // Stopped before the model produced anything on 2.1.322 (no `esc to interrupt` hint, live spinner above the box):
  // stop must send Ctrl-C rather than treating the turn as already idle, and must not fabricate a cancellation while
  // the spinner remains on screen.
  it('sends C-c and refuses to fake cancellation for a live turn before first output while Claude 2.1.322 is spinning', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    await waitFor(() => (h.adapter.status(h.host, h.getSession()).phase === 'idle' ? true : undefined));
    const prompt = 'adjust the video script';
    const spinning = [
      `❯ ${prompt}`, '', '✽ Noodling… (2s · ↓ 0 tokens)', '  ⎿ \u00a0Tip: Use /btw', '',
      '─'.repeat(60), '❯ ', '─'.repeat(60), '    Fable 5.2 · /tmp/project', '  ⏵⏵ auto mode on',
    ].join('\n');
    const sending = h.adapter.send(h.host, request(h, prompt)).catch(() => undefined);
    await waitFor(() => (h.control.pastes.length > 0 ? true : undefined));
    await h.deliver({ hook_event_name: 'UserPromptSubmit', session_id: h.getSession().nativeSessionId, prompt, prompt_id: 'p-spin', permission_mode: 'default' });
    await appendRows(h, humanRow('p-spin', prompt), { type: 'api-request', timestamp: new Date().toISOString() });
    await sending;

    h.terminals.screens.set(h.getSession().terminalId!, spinning);
    const keys: string[][] = [];
    h.host.terminal.sendKeys = async (_id, pressed) => { keys.push(pressed); };
    let settled = false;
    const stopping = h.adapter.interrupt(h.host, h.getSession(), h.profile).then(() => { settled = true; });
    await waitFor(() => keys.length ? true : undefined);
    expect(keys).toEqual([['C-c']]);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(settled).toBe(false);
    expect(h.adapter.status(h.host, h.getSession()).phase).toBe('busy');
    await appendRows(h, { type: 'user', promptId: 'p-spin', message: { role: 'user', content: '[Request interrupted by user]' } });
    await stopping;
    expect(h.adapter.status(h.host, h.getSession()).phase).toBe('idle');
  });

  // Stopped before the model produced anything, the CLI writes no end record: it drops the turn and takes the
  // message back. Nothing answered and nothing recorded, so the stop is complete once the message is out of
  // the box (confirmed against it) — it must not stay there to be submitted later.
  it('ends a stop that left no record by taking the unanswered message out of the box, and cancels its Run once', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    await waitFor(() => (h.adapter.status(h.host, h.getSession()).phase === 'idle' ? true : undefined));
    const messages = h.listen();
    const prompt = 'say something slowly';
    const composerOf = (text: string) => ['Welcome back', '', '─'.repeat(60), `❯ ${text}`, '─'.repeat(60), '    Opus 5 · ctx 30%'].join('\n') + '\n'.repeat(40);
    const sending = h.adapter.send(h.host, request(h, prompt)).catch(() => undefined);
    await waitFor(() => (h.control.pastes.length > 0 ? true : undefined));
    await h.deliver({ hook_event_name: 'UserPromptSubmit', session_id: h.getSession().nativeSessionId, prompt, prompt_id: 'p-slow', permission_mode: 'default' });
    expect(h.adapter.status(h.host, h.getSession()).phase).toBe('busy');
    // The CLI wrote the user row (that is the receipt) and has not answered.
    await appendRows(h, humanRow('p-slow', prompt));
    await sending;

    h.terminals.screens.set(h.getSession().terminalId!, composerOf(prompt));
    h.control.screens = [composerOf(prompt), composerOf(prompt), IDLE_SCREEN];
    h.control.reads = 0;
    const typed = h.control.keys.length;
    await h.adapter.interrupt(h.host, h.getSession(), h.profile);

    expect(h.adapter.status(h.host, h.getSession()).phase).toBe('idle');
    expect(h.control.keys.slice(typed)).toEqual([['C-u'], ['C-k'], ['BSpace']]);
    const ended = messages.flatMap(message => message.type === 'append' ? message.events : []).filter(event => ['run_completed', 'run_cancelled'].includes(event.type));
    expect(ended.map(event => event.type)).toEqual(['run_cancelled']);
  });

  it('preempts a pending delivery receipt without another Enter, and still claims its late prompt for the stop', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    const messages = h.listen();
    const sending = h.adapter.send(h.host, request(h, 'slow delivery')).then(() => undefined, error => error);
    await waitFor(() => h.control.keys.some(keys => keys.includes('Enter')) ? true : undefined);
    h.adapter.requestInterrupt(h.host, h.getSession());
    h.adapter.requestInterrupt(h.host, h.getSession());
    expect(await Promise.race([sending, new Promise(resolve => setTimeout(() => resolve('still waiting'), 500))]))
      .toMatchObject({ code: 'NATIVE_SEND_UNCONFIRMED' });
    await appendRows(h, humanRow('late-stopped-prompt', 'slow delivery'));
    await h.adapter.interrupt(h.host, h.getSession(), h.profile);
    expect(h.adapter.status(h.host, h.getSession()).phase).toBe('idle');
    expect(h.control.keys.filter(keys => keys.includes('Enter'))).toEqual([['Enter']]);
    expect(h.control.pastes).toEqual(['slow delivery']);
    expect(messages.flatMap(message => message.type === 'append' ? message.events : [])
      .filter(event => event.type === 'run_cancelled')).toHaveLength(1);
  });

  it('persists a recordless cold stop before returning and restores it across restarts, while respecting a native busy frame', async () => {
    const h = await makeHarness();
    await appendRows(h, humanRow('cold-stop', 'an unanswered prompt'));
    await h.attachColdRuntime('busy');
    const journal = new Journal(new DatabaseSync(':memory:'));
    const id = h.getSession().id;
    const ingest = new TranscriptIngest({ journal, source: () => h.adapter.transcript(h.host, h.getSession(), h.profile) });
    h.host.transcript = {
      drain: sessionId => ingest.drain(sessionId),
      endTurn: (sessionId, turnId, status, at, error) => ingest.endTurn(sessionId, turnId, status, at, error),
      withSource: (sessionId, task) => ingest.control(sessionId, task),
      wake: sessionId => ingest.wake(sessionId),
    };
    cleaning.push(async () => { ingest.close(); });
    // No journal pull happened before Stop: the control path must import and persist the end itself.
    const keys: string[][] = [];
    h.host.terminal.sendKeys = async (_id, pressed) => { keys.push(pressed); };
    await h.adapter.interrupt(h.host, h.getSession(), h.profile);
    expect(keys).toEqual([]);
    const ended = () => rowsOf(journal, id).filter(row => row.kind === 'meta.turn_ended');
    expect(ended()).toHaveLength(1);
    expect(ended()[0]!.payload).toMatchObject({ status: 'cancelled' });
    await h.adapter.close();
    const rowCount = rowsOf(journal, id).length;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const restored = new ClaudeBackendAdapter();
      cleaning.push(async () => { await restored.close(); });
      const phases: NativeStatus['phase'][] = [];
      restored.subscribe(h.host, h.getSession(), h.profile, message => { if (message.type === 'status') phases.push(message.status.phase); });
      await waitFor(() => restored.status(h.host, h.getSession()).phase === 'idle' ? true : undefined);
      expect(phases).not.toContain('busy');
      await restored.close();
    }
    expect(rowsOf(journal, id)).toHaveLength(rowCount);
    expect(h.launches).toEqual([]);
    expect(h.control.pastes).toEqual([]);
    const sentKeys = keys.length;
    const busy = new ClaudeBackendAdapter();
    cleaning.push(async () => { await busy.close(); });
    h.terminals.screens.set(h.savedTerminalId, `${IDLE_SCREEN.trimEnd()}\n  esc to interrupt`);
    busy.subscribe(h.host, h.getSession(), h.profile, () => undefined);
    await waitFor(() => busy.status(h.host, h.getSession()).phase === 'busy' ? true : undefined);
    expect(keys).toHaveLength(sentKeys);
    await appendRows(h, { type: 'assistant', uuid: 'continued-after-stop', message: { role: 'assistant',
      content: [{ type: 'tool_use', id: 'continued-call', name: 'Bash', input: {} }] } });
    await h.host.transcript.drain(id);
    await busy.close();
    const continued = new ClaudeBackendAdapter();
    cleaning.push(async () => { await continued.close(); });
    continued.subscribe(h.host, h.getSession(), h.profile, () => undefined);
    await waitFor(() => continued.status(h.host, h.getSession()).activeTurnId === 'claude-turn:continued-after-stop' ? true : undefined);
    expect(continued.status(h.host, h.getSession()).phase).toBe('busy');
    expect(keys).toHaveLength(sentKeys);
  });

  it.each(['transcript', 'hook'])('waits for native interruption evidence after %s execution evidence, even when the busy hint disappears', async evidence => {
    const h = await makeHarness();
    if (evidence === 'hook') { await h.open(); await h.deliverSessionStart('default'); }
    await appendRows(h, humanRow('running-tool'), ...(evidence === 'transcript' ? [{ type: 'assistant', message: { role: 'assistant',
      content: [{ type: 'tool_use', id: 'native-call', name: 'Bash', input: { command: 'read-only fixture' } }] } }] : []));
    if (evidence === 'transcript') await h.attachColdRuntime('busy');
    else {
      await h.read();
      await h.deliver({ hook_event_name: 'PreToolUse', session_id: h.getSession().nativeSessionId, prompt_id: 'running-tool',
        tool_use_id: 'native-call', tool_name: 'Bash', tool_input: { command: 'read-only fixture' } });
    }
    const keys: string[][] = [];
    h.host.terminal.sendKeys = async (_id, pressed) => { keys.push(pressed); };
    let settled = false;
    const stopping = h.adapter.interrupt(h.host, h.getSession(), h.profile).then(() => { settled = true; });
    await waitFor(() => keys.length ? true : undefined);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(keys).toEqual([['C-c']]);
    expect(settled).toBe(false);
    expect(h.adapter.status(h.host, h.getSession()).phase).toBe('busy');
    await appendRows(h, { type: 'user', promptId: 'running-tool', message: { role: 'user', content: '[Request interrupted by user for tool use]' } });
    await stopping;
    expect(h.adapter.status(h.host, h.getSession()).phase).toBe('idle');
  });

  // A message the CLI keeps in its own queue is delivered, not lost, and a removal is the evidence it was taken back.
  it('follows a message through the CLI’s own queue: queued, then submitted or taken back', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    await waitFor(() => (h.adapter.status(h.host, h.getSession()).phase === 'idle' ? true : undefined));
    const messages = h.listen();
    const send = (commandId: string, text: string) => h.adapter.send(h.host, { ...request(h, text), commandId, runId: `run-${commandId}` });
    const tagged = (commandId: string) => [...rows(h), ...messages.flatMap(message => message.type === 'append' ? message.events : [])]
      .filter(event => event.data.commandId === commandId);

    // The CLI writes `enqueue` for text it cannot run yet; that alone is the receipt.
    const first = send('queued-1', 'wait your turn');
    await waitFor(() => (h.control.pastes.length > 0 ? true : undefined));
    await appendRows(h, { type: 'queue-operation', operation: 'enqueue' });
    await first;
    expect(tagged('queued-1').some(event => event.type === 'user_message_chunk')).toBe(false);
    await appendRows(h, { type: 'queue-operation', operation: 'dequeue' }, humanRow('p-queued', 'wait your turn'));
    await waitFor(() => (tagged('queued-1').some(event => event.type === 'user_message_chunk') ? true : undefined));
    // The transcript records the turn's end; the journal carries it to the run.
    await appendRows(h, durationRow());
    await waitFor(() => (h.adapter.status(h.host, h.getSession()).phase === 'idle' ? true : undefined));

    // A removal names why: taken back, not run.
    const second = send('queued-2', 'never mind');
    await waitFor(() => (h.control.pastes.length > 1 ? true : undefined));
    await appendRows(h, { type: 'queue-operation', operation: 'enqueue', content: 'never mind' });
    await second;
    await appendRows(h, { type: 'queue-operation', operation: 'remove', content: 'never mind', reason: 'popAll' });
    await waitFor(() => (tagged('queued-2').some(event => event.type === 'run_cancelled') ? true : undefined));
    expect(tagged('queued-2').some(event => event.type === 'user_message_chunk')).toBe(false);
  });

  it('persists a fenced queue receipt across restart and consumes only that input while execution continues', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    const run = { id: 'queued-run', sessionId: h.getSession().id, commandId: 'queued-command' } as Run;
    h.host.listRuns = () => [run];
    const sending = h.adapter.send(h.host, { ...request(h, 'it is a devbox'), commandId: run.commandId, runId: run.id,
      commitDispatchFence: binding => {
        run.native = { ...binding, input: { text: 'it is a devbox', attachmentIds: [], context: [] }, config: { mode: 'agent' },
          fingerprint: 'input', delivery: 'dispatching', attempt: 1, configRevision: 4, timings: { dispatchAt: Date.now() } };
        return run;
      },
    });
    await waitFor(() => h.control.pastes.length ? true : undefined);
    expect(JSON.parse(run.native!.nativeInputBoundary!)).toMatchObject({ type: 'claude-transcript', offset: 0, inode: expect.any(Number) });
    await appendRows(h, { type: 'queue-operation', operation: 'enqueue', content: 'it is a devbox' },
      { type: 'queue-operation', operation: 'enqueue', content: 'it is a devbox' });
    await sending;
    const journal = new Journal(new DatabaseSync(':memory:'));
    const id = h.getSession().id;
    let ingest = new TranscriptIngest({ journal, source: () => h.adapter.transcript(h.host, h.getSession(), h.profile) });
    await ingest.drain(id);
    const events = () => rowsOf(journal, id).map(row => row.payload as NativeWorkbenchEvent);
    const receipt = events().find(event => event.type === 'native_input_receipt');
    expect(receipt).toMatchObject({ runId: run.id, data: { commandId: run.commandId } });
    expect(receipt).not.toHaveProperty('nativeTurnId');
    expect(rowsOf(journal, id).some(row => row.kind === 'meta.turn_started')).toBe(false);
    ingest.close();

    const restored = new ClaudeBackendAdapter();
    cleaning.push(async () => { await restored.close(); ingest.close(); });
    ingest = new TranscriptIngest({ journal, source: () => restored.transcript(h.host, h.getSession(), h.profile) });
    await appendRows(h, humanRow('original', 'the execution continues'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'still-working', name: 'Bash', input: { command: 'read-only fixture' } }] } },
      { type: 'queue-operation', operation: 'remove', content: 'it is a devbox', reason: 'absorbed_mid_turn' },
      { type: 'queue-operation', operation: 'remove', content: 'it is a devbox', reason: 'absorbed_mid_turn' },
      { type: 'queue-operation', operation: 'enqueue', content: 'it is a devbox' },
      { type: 'queue-operation', operation: 'remove', content: 'it is a devbox', reason: 'absorbed_mid_turn' });
    await ingest.drain(id);
    await h.read();
    expect(events().find(event => event.type === 'run_completed')).toMatchObject({ runId: run.id,
      data: { commandId: run.commandId, nativeMessageId: receipt!.nativeId } });
    expect(events().filter(event => event.type === 'native_input_receipt')).toHaveLength(1);
    expect(events().filter(event => event.type === 'run_completed')).toHaveLength(1);
    expect(rowsOf(journal, id).some(row => row.kind === 'meta.turn_ended')).toBe(false);
    expect(h.adapter.status(h.host, h.getSession()).phase).toBe('busy');
    expect(h.control.pastes).toEqual(['it is a devbox']);
    expect(h.control.keys.filter(keys => keys.includes('Enter'))).toEqual([['Enter']]);
  });

  it.each(['before', 'after', 'same-offset'])('uses every native write to fence queue ownership: %s', async occurrence => {
    const h = await makeHarness();
    const session = h.getSession();
    const started = Date.now() - 10_000;
    await appendRows(h, occurrence === 'before'
      ? { type: 'queue-operation', operation: 'enqueue', content: 'old input', timestamp: new Date(started + 1_000).toISOString() }
      : { type: 'api-request', timestamp: new Date(started + 1_000).toISOString() });
    const file = await stat(h.transcriptPath);
    const native = (offset: number, text: string, at: number): Run['native'] => ({ backendId: 'claude', nativeSessionId: session.nativeSessionId,
      nativeInputBoundary: JSON.stringify({ type: 'claude-transcript', nativeSessionId: session.nativeSessionId, inode: file.ino, offset }),
      input: { text, attachmentIds: [], context: [] }, config: { mode: 'agent' }, fingerprint: text, attempt: 1, configRevision: 4,
      renderedText: text, timings: { dispatchAt: at }, delivery: 'cancelled', stage: 'acknowledged' });
    const runs: Run[] = [
      { id: 'old-run', commandId: 'old-command', sessionId: session.id, prompt: 'old input', state: 'interrupted', createdAt: '', updatedAt: '', native: native(0, 'old input', started) },
      { id: 'new-run', commandId: 'new-command', sessionId: session.id, prompt: 'new input', state: 'interrupted', createdAt: '', updatedAt: '', native: native(occurrence === 'same-offset' ? 0 : file.size, 'new input', started + 2_000) },
    ];
    h.host.listRuns = () => runs;
    if (occurrence !== 'before') await appendRows(h, { type: 'queue-operation', operation: 'enqueue', content: 'old input', timestamp: new Date(started + 3_000).toISOString() });
    const journal = new Journal(new DatabaseSync(':memory:'));
    const ingest = new TranscriptIngest({ journal, source: () => h.adapter.transcript(h.host, session, h.profile) });
    cleaning.push(async () => { ingest.close(); });
    await ingest.drain(session.id);
    const receipts = rowsOf(journal, session.id).map(row => row.payload as NativeWorkbenchEvent).filter(event => event.type === 'native_input_receipt');
    expect(receipts).toHaveLength(occurrence === 'before' ? 1 : 0);
    if (occurrence === 'before') expect(receipts[0]).toMatchObject({ runId: 'old-run', data: { commandId: 'old-command' } });
  });

  it.each(['remove', 'dequeue'])('leaves production queue ownership to the durable queue order rather than a same-text runtime claim: %s', async operation => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    await appendRows(h, { type: 'queue-operation', operation: 'enqueue', content: 'same input' });
    await h.read();
    const run = { id: 'tracked-run', commandId: 'tracked-command', sessionId: h.getSession().id } as Run;
    h.host.listRuns = () => [run];
    const journal = new Journal(new DatabaseSync(':memory:'));
    const id = h.getSession().id;
    const ingest = new TranscriptIngest({ journal, source: () => h.adapter.transcript(h.host, h.getSession(), h.profile) });
    cleaning.push(async () => { ingest.close(); });
    h.host.transcript = { drain: sessionId => ingest.drain(sessionId), endTurn: (sessionId, turnId, status, at, error) => ingest.endTurn(sessionId, turnId, status, at, error),
      withSource: (sessionId, task) => ingest.control(sessionId, task), wake: sessionId => ingest.wake(sessionId) };
    const messages = h.listen();
    const sending = h.adapter.send(h.host, { ...request(h, 'same input'), runId: run.id, commandId: run.commandId,
      commitDispatchFence: binding => {
        run.native = { ...binding, input: { text: 'same input', attachmentIds: [], context: [] }, config: { mode: 'agent' },
          fingerprint: 'input', delivery: 'dispatching', attempt: 1, configRevision: 4, timings: { dispatchAt: Date.now() } };
        return run;
      } });
    await waitFor(() => h.control.pastes.length ? true : undefined);
    await appendRows(h, { type: 'queue-operation', operation: 'enqueue', content: 'same input' });
    await sending;
    await ingest.drain(id);
    await appendRows(h, { type: 'queue-operation', operation, content: 'same input', reason: 'absorbed_mid_turn' },
      ...(operation === 'dequeue' ? [{ ...humanRow('external-prompt', 'same input'), uuid: 'external-user' }] : []));
    await h.read();
    await ingest.drain(id);
    const ends = () => rowsOf(journal, id).map(row => row.payload as NativeWorkbenchEvent).filter(event => event.type === 'run_completed');
    expect(ends()).toEqual([]);
    expect(messages.flatMap(message => message.type === 'append' ? message.events : []).filter(event => event.type === 'run_completed')).toEqual([]);
    if (operation === 'dequeue') {
      expect((journal.entity(id, `claude:${h.getSession().nativeSessionId}:external-user:0`)!.payload as NativeWorkbenchEvent).data).not.toHaveProperty('commandId');
      expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ activeTurnId: 'external-prompt', activeTurn: { turnId: 'external-prompt' } });
      expect(h.adapter.status(h.host, h.getSession()).activeTurn).not.toHaveProperty('ownerRunId');
    }
    await appendRows(h, { type: 'queue-operation', operation, content: 'same input', reason: 'absorbed_mid_turn' },
      ...(operation === 'dequeue' ? [{ ...humanRow('tracked-prompt', 'same input'), uuid: 'tracked-user' }] : []));
    await h.read();
    await ingest.drain(id);
    if (operation === 'remove') expect(ends()).toMatchObject([{ runId: run.id, data: { commandId: run.commandId } }]);
    else {
      expect((journal.entity(id, `claude:${h.getSession().nativeSessionId}:tracked-user:0`)!.payload as NativeWorkbenchEvent).data).toMatchObject({ commandId: run.commandId });
      expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ activeTurnId: 'tracked-prompt', activeTurn: { turnId: 'tracked-prompt' } });
      expect(h.adapter.status(h.host, h.getSession()).activeTurn).not.toHaveProperty('ownerRunId');
    }
  });
});

describe('Claude hook guidance', () => {
  const prepare = async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    const target = { nativeSessionId: h.getSession().nativeSessionId!, turnId: 'native-prompt-1' };
    const hook = (event: string, extra: Record<string, unknown> = {}) => h.deliver({ hook_event_name: event, session_id: target.nativeSessionId, prompt_id: target.turnId, ...extra });
    await hook('UserPromptSubmit', { prompt: 'original task' });
    const events: import('../../../../../packages/contracts/src/index.js').NativeWorkbenchEvent[] = [];
    h.host.emitEvent = (_sessionId, event) => { events.push(event); };
    const runs: Run[] = [];
    h.host.findRunsByNativeTurn = (_sessionId, sid, turnId) => runs.filter(run => run.native?.nativeSessionId === sid && run.native.nativeTurnId === turnId);
    const fence = vi.fn((binding?: NativeDispatchBinding) => {
      const run = {
        id: 'steer-run-1', sessionId: h.getSession().id, commandId: 'steer-command-1', state: 'running', prompt: 'guidance', createdAt: '', updatedAt: '',
        native: { intent: 'steer', input: { text: 'use the revised requirement', attachmentIds: [], context: [] }, config: { mode: 'agent' }, fingerprint: 'steer-fingerprint', attempt: 1, configRevision: 4, delivery: 'dispatching', ...binding },
      } as Run;
      runs.push(run);
      return run;
    });
    const request: NativeBackendSendRequest & { target: typeof target } = {
      session: h.getSession(), project: h.host.getProject(h.getSession().projectId), profile: h.profile,
      commandId: 'steer-command-1', runId: 'steer-run-1', target,
      input: { text: 'use the revised requirement', attachmentIds: [], context: [] },
      config: { mode: 'agent' }, commitDispatchFence: fence,
    };
    return { h, target, hook, request, fence, events, runs };
  };

  it('waits without a write and claims once only at this prompt’s main-thread tool boundary', async () => {
    const { h, hook, request, fence, target } = await prepare();
    expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ activeTurn: target, activeTurnId: target.turnId });
    await hook('PreToolUse', { tool_use_id: 'tool-1', tool_name: 'Bash' });
    expect(await h.adapter.steer(h.host, request)).toEqual({ deferred: true });
    expect(fence).not.toHaveBeenCalled();
    expect(h.control.pastes).toEqual([]);
    expect(await hook('PostToolUse', { tool_use_id: 'tool-1', agent_id: 'child' })).toEqual({});
    expect(await hook('PostToolUse', { tool_use_id: 'tool-1', prompt_id: 'other-prompt' })).toEqual({});
    expect(await hook('PostToolUse', { tool_use_id: 'different-tool' })).toEqual({});
    expect(fence).not.toHaveBeenCalled();
    const response = await hook('PostToolUse', { tool_use_id: 'tool-1' });
    expect(response).toMatchObject({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: expect.stringContaining(request.input.text) } });
    expect(fence).toHaveBeenCalledOnce();
    expect(fence.mock.calls[0]![0]).toMatchObject({ backendId: 'claude', nativeSessionId: target.nativeSessionId, nativeTurnId: target.turnId });
    expect(await hook('PostToolUse', { tool_use_id: 'tool-1' })).toEqual({});
    expect(fence).toHaveBeenCalledOnce();
  });

  it('requires a native additional-context receipt, retains it in history, and handles Stop before receipt', async () => {
    const { h, hook, request, events } = await prepare();
    await hook('PreToolUse', { tool_use_id: 'tool-1', tool_name: 'Bash' });
    await h.adapter.steer(h.host, request);
    const response = await hook('PostToolUse', { tool_use_id: 'tool-1' });
    const context = (response.hookSpecificOutput as { additionalContext: string }).additionalContext;
    expect(events.some(event => event.type === 'native_input_receipt')).toBe(false);
    h.terminals.screens.set(h.getSession().terminalId!, IDLE_SCREEN);
    await hook('Stop');
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(h.adapter.status(h.host, h.getSession())).not.toHaveProperty('activeTurn');
    expect(h.adapter.status(h.host, h.getSession())).not.toHaveProperty('activeTurnId');
    expect(events.some(event => event.type === 'run_completed')).toBe(false);
    await appendFile(h.transcriptPath, `${JSON.stringify({ type: 'attachment', uuid: 'native-context-1', timestamp: '2026-10-16T10:00:00Z', attachment: {
      type: 'hook_additional_context', content: [context], hookName: 'PostToolUse:Bash', hookEvent: 'PostToolUse', toolUseID: 'tool-1',
    } })}\n`);
    // The receipt reaches the run through the journal: the transcript source maps the context row (`transcript-source.ts`).
    await h.read();
  });

  it('rejects unconsumed input at Stop without starting another turn', async () => {
    const event = 'Stop';
    const { h, hook, request, fence, events } = await prepare();
    await hook('PreToolUse', { tool_use_id: 'tool-1', tool_name: 'Bash' });
    await h.adapter.steer(h.host, request);
    expect(await hook(event)).toEqual({});
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'native_input_rejected', runId: request.runId, data: expect.objectContaining({ beforeWrite: true }) })]));
    expect(await hook('PostToolUse', { tool_use_id: 'tool-1' })).toEqual({});
    expect(fence).not.toHaveBeenCalled();
    expect(h.control.pastes).toEqual([]);
    await expect(h.adapter.steer(h.host, request)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects interrupted tools and never carries pending input to the next prompt', async () => {
    const { h, hook, request, fence, events } = await prepare();
    await hook('PreToolUse', { tool_use_id: 'tool-1', tool_name: 'Bash' });
    await h.adapter.steer(h.host, request);
    expect(await hook('PostToolUseFailure', { tool_use_id: 'tool-1', is_interrupt: true })).toEqual({});
    await hook('UserPromptSubmit', { prompt_id: 'native-prompt-2', prompt: 'new task' });
    await hook('PreToolUse', { prompt_id: 'native-prompt-2', tool_use_id: 'tool-2', tool_name: 'Bash' });
    expect(await hook('PostToolUse', { prompt_id: 'native-prompt-2', tool_use_id: 'tool-2' })).toEqual({});
    expect(fence).not.toHaveBeenCalled();
    expect(events.some(event => event.type === 'native_input_rejected')).toBe(true);
  });

  it('does not turn a busy cold terminal into a guidance endpoint', async () => {
    const { h, request } = await prepare();
    await h.adapter.dispose(h.host, h.getSession().id);
    await appendRows(h, humanRow(request.target.turnId));
    await h.attachColdRuntime('busy');
    const launches = h.launches.length;
    await expect(h.adapter.steer(h.host, request)).rejects.toMatchObject({ statusCode: 409 });
    expect(h.launches).toHaveLength(launches);
    expect(h.adapter.status(h.host, h.getSession()).activeTurn).toBeUndefined();
    // Still stoppable: the stop names the turn as the status does, without a turn id.
    const session = h.getSession();
    const terminal = await h.host.terminal.get(session.terminalId!);
    await expect(h.adapter.interrupt(h.host, session, h.profile, { expectedStop: { requestId: 'cold-stop', nativeSessionId: session.nativeSessionId!,
      terminalId: terminal.id, terminalEpoch: terminal.epoch } })).resolves.toBeUndefined();
  });

  it('publishes a cold-replayed turn once one of its tool hooks reaches this service', async () => {
    // A restart mid-turn whose transcript already shows the prompt: the replay opens the turn without a hook.
    const { h, request, hook, fence } = await prepare();
    await h.adapter.dispose(h.host, h.getSession().id);
    await appendRows(h, humanRow(request.target.turnId));
    await h.attachColdRuntime('busy');
    expect(h.adapter.status(h.host, h.getSession()).activeTurn).toBeUndefined();
    await hook('PreToolUse', { tool_use_id: 'tool-1', tool_name: 'Bash' });
    expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ phase: 'busy', activeTurn: request.target });
    expect(await h.adapter.steer(h.host, request)).toEqual({ deferred: true });
    expect(await hook('PostToolUse', { tool_use_id: 'tool-1' })).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining(request.input.text) } });
    expect(fence).toHaveBeenCalledOnce();
  });

  it('keeps the running tool as a guidance boundary after a stop that fails', async () => {
    const { h, request, hook, fence, target } = await prepare();
    await hook('PreToolUse', { tool_use_id: 'tool-1', tool_name: 'Bash' });
    h.host.terminal.sendKeys = async () => { throw new Error('tmux went away'); };
    await expect(h.adapter.interrupt(h.host, h.getSession(), h.profile)).rejects.toThrow();
    expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ phase: 'busy', activeTurn: target });
    expect(await h.adapter.steer(h.host, request)).toEqual({ deferred: true });
    expect(await hook('PostToolUse', { tool_use_id: 'tool-1' })).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining(request.input.text) } });
    expect(fence).toHaveBeenCalledOnce();
  });

  it('takes guidance in a turn whose hooks reach a service that did not launch the CLI', async () => {
    // A service restart mid-turn: the CLI keeps running and its next tool hook wakes a cold runtime.
    const { h, request, hook, fence } = await prepare();
    await h.adapter.dispose(h.host, h.getSession().id);
    await h.attachColdRuntime('idle');
    const launches = h.launches.length;
    await hook('PreToolUse', { tool_use_id: 'tool-1', tool_name: 'Bash' });
    expect(h.adapter.status(h.host, h.getSession())).toMatchObject({ phase: 'busy', activeTurn: request.target });
    expect(await h.adapter.steer(h.host, request)).toEqual({ deferred: true });
    expect(await hook('PostToolUse', { tool_use_id: 'tool-1' })).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining(request.input.text) } });
    expect(fence).toHaveBeenCalledOnce();
    expect(h.launches).toHaveLength(launches);
    expect(h.control.pastes).toEqual([]);
  });

  it('does not fail a receipted guidance input when its observer closes but the CLI stays alive', async () => {
    const { h, hook, request, events, runs } = await prepare();
    await hook('PreToolUse', { tool_use_id: 'tool-1', tool_name: 'Bash' });
    await h.adapter.steer(h.host, request);
    await hook('PostToolUse', { tool_use_id: 'tool-1' });
    runs[0]!.native!.delivery = 'observed';
    runs[0]!.native!.nativeMessageId = 'persisted-context-receipt';
    await h.adapter.dispose(h.host, h.getSession().id);
    expect(events.some(event => ['run_failed', 'run_cancelled', 'run_completed'].includes(event.type))).toBe(false);
    expect(h.terminals.stopped).toEqual([]);
  });

  it('keeps the outcome Stop announced when the process exits before a native receipt', async () => {
    const { h, hook, request, events } = await prepare();
    await hook('PreToolUse', { tool_use_id: 'tool-1', tool_name: 'Bash' });
    await h.adapter.steer(h.host, request);
    const response = await hook('PostToolUse', { tool_use_id: 'tool-1' });
    const context = (response.hookSpecificOutput as { additionalContext: string }).additionalContext;
    await hook('Stop');
    await h.terminals.stop(h.getSession().terminalId!);
    await appendFile(h.transcriptPath, `${JSON.stringify({ type: 'attachment', uuid: 'late-context', attachment: {
      type: 'hook_additional_context', content: [context], hookEvent: 'PostToolUse', toolUseID: 'tool-1',
    } })}\n`);
    await h.read();
    expect(events.some(event => event.type === 'run_failed' && event.runId === request.runId)).toBe(false);
  });

  it('gives up unconsumed guidance and announces no completion when the process exits mid-turn', async () => {
    const { h, hook, request, fence, events } = await prepare();
    const messages = h.listen();
    await hook('PreToolUse', { tool_use_id: 'tool-1', tool_name: 'Bash' });
    await h.adapter.steer(h.host, request);
    await h.terminals.stop(h.getSession().terminalId!);
    expect(h.adapter.status(h.host, h.getSession()).phase).toBe('offline');
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'native_input_rejected', runId: request.runId })]));
    expect(fence).not.toHaveBeenCalled();
    // A dead CLI did not finish anything: the dispatcher settles the Run from the offline status.
    expect(messages.some(message => message.type === 'append' && message.events.some(event => event.type === 'run_completed'))).toBe(false);
  });

  it('does not fence after the native hook connection aborts while waiting for the short lock', async () => {
    const { h, hook, request, fence } = await prepare();
    await hook('PreToolUse', { tool_use_id: 'tool-1', tool_name: 'Bash' });
    await h.adapter.steer(h.host, request);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.host.withSessionLock = async (_sessionId, operation) => { entered(); await gate; return await operation(); };
    const launch = h.launches.at(-1)!;
    const controller = new AbortController();
    const posting = fetch(`${launch.env!.RIFFET_CLAUDE_HOOK_URL}/hook`, {
      method: 'POST', headers: { authorization: `Bearer ${launch.env!.RIFFET_CLAUDE_HOOK_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryId: 'aborted-post-tool', payload: { hook_event_name: 'PostToolUse', session_id: request.target.nativeSessionId, prompt_id: request.target.turnId, tool_use_id: 'tool-1' } }), signal: controller.signal,
    }).catch(() => undefined);
    await waiting;
    controller.abort();
    await posting;
    await new Promise(resolve => setTimeout(resolve, 25));
    release();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(fence).not.toHaveBeenCalled();
    await hook('Stop');
  });
});

// A send is bound to the first prompt the CLI submits after the write fence, not to whatever text its
// hook happens to echo; and a receipt that never came is not a failure until the transcript says so.
describe('Claude prompt claiming and late confirmation', () => {
  const request = (h: FakeHarness, text: string): NativeBackendSendRequest => ({
    session: h.getSession(), project: h.host.getProject(h.getSession().projectId), profile: h.profile,
    commandId: 'command-1', runId: 'run-1',
    input: { text, attachmentIds: [], context: [] },
    config: { mode: 'agent' },
    commitDispatchFence: () => ({} as Run),
  });
  const userRow = (uuid: string, promptId: string, text: string) => `${JSON.stringify({
    type: 'user', uuid, promptId, timestamp: new Date().toISOString(), message: { role: 'user', content: text },
  })}\n`;
  const taggedRows = (h: FakeHarness) => rows(h).filter(event => event.type === 'user_message_chunk' && event.data.commandId === 'command-1');
  const settle = async () => { for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setImmediate(resolve)); };
  /** Lets the send reach its receipt wait on real I/O before the faked clock is moved. */
  const untilPasted = async (h: FakeHarness) => { for (let turn = 0; turn < 200 && h.control.pastes.length === 0; turn += 1) await new Promise(resolve => setImmediate(resolve)); };

  it.each(['turn', 'epoch'])('refuses targeted Stop when the %s changes during its last screen read', async changed => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    const session = h.getSession();
    await h.deliver({ hook_event_name: 'UserPromptSubmit', session_id: session.nativeSessionId, prompt_id: 'original-stop-turn', prompt: 'original task' });
    const terminal = await h.host.terminal.get(session.terminalId!);
    const screen = h.host.terminal.screen;
    let reads = 0, writes = 0;
    h.host.terminal.sendKeys = async () => { writes += 1; };
    h.host.terminal.screen = async id => {
      const value = await screen(id);
      if (++reads === 1) {
        if (changed === 'turn') await h.deliver({ hook_event_name: 'UserPromptSubmit', session_id: session.nativeSessionId, prompt_id: 'new-stop-turn', prompt: 'new task' });
        else {
          const get = h.host.terminal.get;
          h.host.terminal.get = key => key === id ? Promise.resolve({ ...terminal, epoch: terminal.epoch + 1 }) : get(key);
        }
      }
      return value;
    };
    await expect(h.adapter.interrupt(h.host, session, h.profile, { expectedStop: { requestId: 'targeted-stop', nativeSessionId: session.nativeSessionId!,
      turnId: 'original-stop-turn', terminalId: terminal.id, terminalEpoch: terminal.epoch } })).rejects.toMatchObject({ code: 'NATIVE_STOP_TARGET_CHANGED' });
    expect(writes).toBe(0);
  });

  it('stops clearing the composer when a new turn starts between cleanup keys', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    const text = 'previous prompt';
    const sending = h.adapter.send(h.host, request(h, text));
    await waitFor(() => h.control.pastes.length ? true : undefined);
    await h.deliver({ hook_event_name: 'UserPromptSubmit', session_id: h.getSession().nativeSessionId, prompt_id: 'old-cleanup-turn', prompt: text });
    await appendRows(h, humanRow('old-cleanup-turn', text), durationRow());
    await sending;
    await h.read();
    await waitFor(() => h.adapter.status(h.host, h.getSession()).phase === 'idle' ? true : undefined);
    h.control.screens = [IDLE_SCREEN.replace('❯ ', `❯ ${text}`)];
    h.control.reads = 0;
    const interact = h.host.terminal.withInteraction;
    h.host.terminal.withInteraction = (id, task) => interact(id, control => task({ ...control,
      keys: async keys => {
        await control.keys(keys);
        if (keys.includes('C-u')) await h.deliver({ hook_event_name: 'UserPromptSubmit', session_id: h.getSession().nativeSessionId, prompt_id: 'successor-cleanup-turn', prompt: 'new task' });
      },
    }));
    const before = h.control.keys.length;
    await expect(h.adapter.interrupt(h.host, h.getSession(), h.profile, { expectedStop: {
      requestId: 'stop-cleanup', nativeSessionId: h.getSession().nativeSessionId!,
    } })).rejects.toMatchObject({ code: 'NATIVE_STOP_TARGET_CHANGED' });
    expect(h.control.keys.slice(before)).toEqual([['C-u']]);
  });

  it.each(['typed', 'queued'])('restores a persisted input after its untagged user row was already journaled and the runtime was lost: %s', async path => {
    const h = await makeHarness();
    const session = h.getSession();
    const file = await stat(h.transcriptPath);
    const text = 'line one\nline two';
    const run: Run = { id: 'durable-run', commandId: 'durable-command', sessionId: session.id,
      createdAt: '', updatedAt: '', prompt: text, state: 'interrupted', native: {
        backendId: 'claude', nativeSessionId: session.nativeSessionId, terminalId: session.terminalId,
        nativeInputBoundary: JSON.stringify({ type: 'claude-transcript', nativeSessionId: session.nativeSessionId, inode: file.ino, offset: file.size }),
        input: { text, attachmentIds: [], context: [] }, renderedText: text, config: { mode: 'agent' }, fingerprint: text,
        attempt: 1, configRevision: 4, delivery: 'uncertain', timings: { dispatchAt: Date.now() - 1_000 },
      } };
    const pasted = '<pasted_content id="a">line one\r\nline two</pasted_content id="a">';
    // The CLI was busy: it queued the paste, ran it once free, and the queue row's text keeps the paste wrapper.
    const queued = path === 'queued' ? [{ type: 'queue-operation', operation: 'enqueue', content: pasted }, { type: 'queue-operation', operation: 'dequeue' }]
      .map(row => `${JSON.stringify({ ...row, timestamp: new Date().toISOString() })}\n`).join('') : '';
    await appendFile(h.transcriptPath, queued + userRow('durable-user', 'durable-prompt', pasted)
      + `${JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1, timestamp: new Date().toISOString() })}\n`);
    const journal = new Journal(new DatabaseSync(':memory:'));
    let ingest = new TranscriptIngest({ journal, source: () => h.adapter.transcript(h.host, session, h.profile) });
    await ingest.drain(session.id);
    const nativeId = `claude:${session.nativeSessionId}:durable-user:0`;
    expect((journal.entity(session.id, nativeId)!.payload as NativeWorkbenchEvent).data).not.toHaveProperty('commandId');
    ingest.close();
    await h.adapter.close();

    const restored = new ClaudeBackendAdapter();
    const receipts: NativeWorkbenchEvent[] = [];
    h.host.listRuns = () => [run];
    h.host.emitEvent = (_id, event) => { receipts.push(event); run.native!.nativeMessageId = event.nativeId; run.native!.delivery = 'observed'; };
    ingest = new TranscriptIngest({ journal, source: () => restored.transcript(h.host, session, h.profile) });
    cleaning.push(async () => { ingest.close(); await restored.close(); });
    await ingest.drain(session.id);
    expect(receipts).toMatchObject([{ type: 'native_input_receipt', nativeId, nativeTurnId: 'durable-prompt', runId: run.id,
      data: { commandId: run.commandId, nativeSessionId: session.nativeSessionId } }]);
    expect((journal.entity(session.id, nativeId)!.payload as NativeWorkbenchEvent).data).toMatchObject({ commandId: run.commandId });
    expect(rowsOf(journal, session.id).filter(row => row.kind === 'meta.turn_started').map(row => row.payload)).toContainEqual({ turnId: 'durable-prompt' });
    await ingest.drain(session.id);
    expect(await ingest.control(session.id, (source, writer) => source instanceof ClaudeTranscriptSource ? source.activeTurn(writer) : 'unexpected source')).toBeUndefined();
    expect(rowsOf(journal, session.id).filter(row => row.kind === 'meta.turn_ended').map(row => row.payload)).toContainEqual({ turnId: 'durable-prompt', status: 'completed' });
    expect(receipts).toHaveLength(1);
    expect(h.launches).toEqual([]);
    expect(h.control.pastes).toEqual([]);
    expect(h.control.keys).toEqual([]);
  });

  it('recovers receipt after a terminal write throws without writing the input twice', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    const text = 'written before transport failed';
    const run = { id: 'errored-run', commandId: 'errored-command', sessionId: h.getSession().id } as Run;
    h.host.listRuns = () => [run];
    const interact = h.host.terminal.withInteraction;
    h.host.terminal.withInteraction = (id, task) => interact(id, control => task({ ...control,
      paste: async value => { await control.paste(value, false); throw new Error('terminal transport failed after writing'); },
    }));
    await expect(h.adapter.send(h.host, { ...request(h, text), commandId: run.commandId, runId: run.id,
      commitDispatchFence: binding => {
        run.native = { ...binding, input: { text, attachmentIds: [], context: [] }, renderedText: text, config: { mode: 'agent' },
          fingerprint: text, attempt: 1, configRevision: 4, delivery: 'dispatching', timings: { dispatchAt: Date.now() } };
        return run;
      } })).rejects.toThrow('terminal transport failed after writing');
    run.native!.delivery = 'uncertain';
    await appendFile(h.transcriptPath, userRow('errored-user', 'errored-prompt', text));
    const journal = new Journal(new DatabaseSync(':memory:'));
    const receipts: NativeWorkbenchEvent[] = [];
    h.host.emitEvent = (_id, event) => receipts.push(event);
    const ingest = new TranscriptIngest({ journal, source: () => h.adapter.transcript(h.host, h.getSession(), h.profile) });
    cleaning.push(async () => { ingest.close(); });
    await ingest.drain(h.getSession().id);
    expect(receipts).toMatchObject([{ type: 'native_input_receipt', runId: run.id, data: { commandId: run.commandId } }]);
    expect(h.control.pastes).toEqual([text]);
    expect(h.control.keys).toEqual([]);
  });

  it.each(['two-messages', 'two-runs', 'wrong-inode', 'wrong-session', 'before-fence', 'newer-cancelled-write', 'truncated-file'])
    ('does not guess durable receipt ownership with %s', async reason => {
      const h = await makeHarness();
      const session = h.getSession();
      await appendFile(h.transcriptPath, userRow('old-user', 'old-prompt', 'same text'));
      const file = await stat(h.transcriptPath);
      const run: Run = { id: 'run', commandId: 'command', sessionId: session.id, createdAt: '', updatedAt: '', prompt: 'same text', state: 'interrupted', native: {
        backendId: 'claude', nativeSessionId: reason === 'wrong-session' ? 'another-session' : session.nativeSessionId,
        nativeInputBoundary: JSON.stringify({ type: 'claude-transcript', nativeSessionId: session.nativeSessionId,
          inode: reason === 'wrong-inode' ? file.ino + 1 : file.ino, offset: file.size }),
        input: { text: 'same text', attachmentIds: [], context: [] }, renderedText: 'same text', config: { mode: 'agent' }, fingerprint: 'same text',
        attempt: 1, configRevision: 4, delivery: 'uncertain', timings: { dispatchAt: Date.now() - 1_000 },
      } };
      const runs = [run];
      if (reason === 'two-runs') runs.push({ ...run, id: 'run2', commandId: 'command2', native: { ...run.native! } });
      if (reason === 'newer-cancelled-write' || reason === 'truncated-file') {
        await appendFile(h.transcriptPath, `${JSON.stringify({ type: 'api-request' })}\n`);
        const newerFile = await stat(h.transcriptPath);
        runs.push({ ...run, id: 'run2', commandId: 'command2', native: { ...run.native!, delivery: 'cancelled', stage: 'acknowledged',
          nativeInputBoundary: JSON.stringify({ type: 'claude-transcript', nativeSessionId: session.nativeSessionId, inode: file.ino, offset: newerFile.size + (reason === 'truncated-file' ? 10_000 : 0) }) } });
      }
      if (reason !== 'before-fence') await appendFile(h.transcriptPath, userRow('new-user', 'new-prompt', 'same text'));
      if (reason === 'two-messages') await appendFile(h.transcriptPath, userRow('other-user', 'other-prompt', 'same text'));
      h.host.listRuns = () => runs;
      const receipts: NativeWorkbenchEvent[] = [];
      h.host.emitEvent = (_id, event) => receipts.push(event);
      const journal = new Journal(new DatabaseSync(':memory:'));
      const ingest = new TranscriptIngest({ journal, source: () => h.adapter.transcript(h.host, session, h.profile) });
      cleaning.push(async () => { ingest.close(); });
      await ingest.drain(session.id);
      expect(receipts).toEqual([]);
      expect(rowsOf(journal, session.id).filter(row => row.kind === 'user_message_chunk').some(row => (row.payload as NativeWorkbenchEvent).data.commandId)).toBe(false);
      expect(h.control.pastes).toEqual([]);
      expect(h.control.keys).toEqual([]);
    });

  it.each(['empty', 'composer-input', 'queued-input', 'background', 'busy', 'wrong-terminal', 'reopened-terminal', 'epoch-changed', 'unreadable'])
    ('checks whether input can be released without changing the native terminal: %s', async reason => {
      const h = await makeHarness({ screen: reason === 'composer-input' ? IDLE_SCREEN.replace('❯ ', '❯ remains here') : IDLE_SCREEN });
      const session = h.getSession();
      await appendFile(h.transcriptPath, userRow('finished-user', 'finished-prompt', 'done')
        + `${JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1, timestamp: new Date().toISOString() })}\n`);
      const journal = new Journal(new DatabaseSync(':memory:'));
      const ingest = new TranscriptIngest({ journal, source: () => h.adapter.transcript(h.host, session, h.profile) });
      cleaning.push(async () => { ingest.close(); });
      h.host.transcript = { drain: id => ingest.drain(id), endTurn: (id, turn, status, at, error) => ingest.endTurn(id, turn, status, at, error),
        withSource: (id, task) => ingest.control(id, task), wake: id => ingest.wake(id) };
      if (reason === 'queued-input') await appendFile(h.transcriptPath, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'still queued' })}\n`);
      if (reason === 'background') await appendFile(h.transcriptPath, [
        { type: 'assistant', uuid: 'background-call', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'background-tool', name: 'Bash', input: { command: 'sleep 100', run_in_background: true } }] } },
        { type: 'user', uuid: 'background-result', toolUseResult: { backgroundTaskId: 'background-task' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'background-tool', content: 'Command running in background with ID: background-task' }] } },
        { type: 'system', subtype: 'turn_duration', durationMs: 1 },
      ].map(row => `${JSON.stringify({ timestamp: new Date().toISOString(), ...row })}\n`).join(''));
      if (reason === 'busy') await appendFile(h.transcriptPath, userRow('busy-user', 'busy-prompt', 'working'));
      if (reason === 'unreadable') h.terminals.screens.set(session.terminalId!, undefined);
      if (reason === 'epoch-changed') {
        await h.read();
        let captures = 0;
        const screen = h.host.terminal.screen;
        h.host.terminal.screen = async id => {
          const drawn = await screen(id);
          // The first capture checks process status; the second checks the empty composer.
          if (++captures === 2) {
            const terminal = await h.terminals.get(id);
            const get = h.host.terminal.get;
            h.host.terminal.get = key => key === id ? Promise.resolve({ ...terminal, epoch: terminal.epoch + 1 }) : get(key);
          }
          return drawn;
        };
      }
      const run = { id: 'run', native: { backendId: 'claude', nativeSessionId: session.nativeSessionId,
        terminalId: reason === 'wrong-terminal' ? 'another-terminal' : session.terminalId,
        terminalEpoch: reason === 'reopened-terminal' ? 99 : reason === 'epoch-changed' ? 1 : undefined } } as Run;
      // A terminal someone opened and handed back since the send is read as it is now; one that moves during the check is not.
      expect(await h.adapter.canReleaseInput(h.host, session, h.profile, run)).toBe(reason === 'empty' || reason === 'reopened-terminal');
      expect(h.launches).toEqual([]);
      expect(h.control.pastes).toEqual([]);
      expect(h.control.keys).toEqual([]);
      expect(h.terminals.stopped).toEqual([]);
    });

  it('claims the first new prompt after the fence even when its hook text is wrapped, but not a synthetic turn', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    const session = h.getSession();
    void h.adapter.send(h.host, request(h, 'fix the bug')).catch(() => undefined);
    await waitFor(() => (h.control.pastes.length > 0 ? true : undefined));
    const runtime = (h.adapter as unknown as { runtimes: Map<string, { pendingSend?: { promptSeen: boolean; promptId?: string } }> }).runtimes.get(session.id)!;
    const submit = (prompt: string, promptId: string) => h.deliver({ hook_event_name: 'UserPromptSubmit', session_id: session.nativeSessionId, prompt, prompt_id: promptId, permission_mode: 'default' });

    await submit('<task-notification><task-id>t</task-id></task-notification>', 'prompt-notice');
    expect(runtime.pendingSend?.promptSeen).toBe(false);
    await submit('<ide_opened_file>a.ts</ide_opened_file>\nfix  the\nbug', 'prompt-wrapped');
    expect(runtime.pendingSend).toMatchObject({ promptSeen: true, promptId: 'prompt-wrapped' });
  });

  it('names a task report’s live turn by the runId its rows carry', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    h.listen();
    await appendFile(h.transcriptPath, `${JSON.stringify({
      type: 'user', uuid: 'notice-row', promptId: 'prompt-notice', timestamp: new Date().toISOString(), origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification><task-id>t</task-id><status>completed</status><summary>done</summary></task-notification>' },
    })}\n`);
    const activeTurnId = await waitFor(() => h.adapter.status(h.host, h.getSession()).activeTurnId);
    const notice = rows(h).find(event => event.type === 'task_notification');
    expect(notice).toBeDefined();
    expect(notice).not.toHaveProperty('nativeTurnId');
    expect(activeTurnId).toBe(notice!.runId);
  });

  it('confirms a prompt whose transcript row appears after the receipt wait gave up, once', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    h.listen();
    const prompt = 'late but delivered';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      const sending = h.adapter.send(h.host, request(h, prompt));
      sending.catch(() => undefined);
      await untilPasted(h);
      await vi.advanceTimersByTimeAsync(95_000);
      await expect(sending).rejects.toThrow(/did not confirm/);
      expect(taggedRows(h)).toHaveLength(0);

      await appendFile(h.transcriptPath, userRow('late-user', 'prompt-late', prompt));
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(taggedRows(h)).toHaveLength(1), { timeout: 2_000, interval: 10 });
      expect(taggedRows(h)[0]!.data.content).toMatchObject({ text: prompt });

      // The second check finds nothing left to confirm and does not tag the row again.
      await vi.advanceTimersByTimeAsync(120_000);
      await settle();
      expect(taggedRows(h)).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('re-maps a row that was already shown untagged once a late hook claims the send', async () => {
    const h = await makeHarness();
    await h.open();
    await h.deliverSessionStart('default');
    h.listen();
    const prompt = 'the CLI rewrote this one';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      const sending = h.adapter.send(h.host, request(h, prompt));
      sending.catch(() => undefined);
      await untilPasted(h);
      await appendFile(h.transcriptPath, userRow('rewritten-user', 'prompt-rewritten', 'something else entirely'));
      await vi.advanceTimersByTimeAsync(95_000);
      await expect(sending).rejects.toThrow(/did not confirm/);
      expect(taggedRows(h)).toHaveLength(0);

      await h.read();

      await h.deliver({ hook_event_name: 'UserPromptSubmit', session_id: h.getSession().nativeSessionId, prompt: `[rewritten] ${prompt}`, prompt_id: 'prompt-rewritten', permission_mode: 'default' });
      await vi.advanceTimersByTimeAsync(5);
      await vi.waitFor(() => expect(taggedRows(h)).toHaveLength(1), { timeout: 2_000, interval: 10 });
    } finally { vi.useRealTimers(); }
  });
});

// A CLI that dies right after it starts will die the same way on the next `--resume`: the saved
// conversation, not the process, is what it chokes on. After two such exits the third launch starts afresh.
describe('Claude resume after the CLI exited', () => {
  // A conversation reopened by a send: the poll that was looking at the exited terminal finishes after the new CLI is
  // launched. Taking its answer would mark the live CLI gone, and the reader then ends each step it writes as interrupted.
  it('does not take an inspection of the replaced terminal as the exit of the new CLI', async () => {
    const h = await makeHarness();
    await h.attachColdRuntime('idle');
    await h.terminals.stop(h.savedTerminalId);
    const runtime = (h.adapter as unknown as { runtimes: Map<string, { refreshTerminalStatus(): Promise<void>; exitedAt?: string }> }).runtimes.get(h.getSession().id)!;
    await runtime.refreshTerminalStatus();
    expect(h.adapter.status(h.host, h.getSession()).phase).toBe('offline');

    const hold = h.holdNextLaunch();
    const opening = h.open({ takeover: true });
    await hold.started;
    await runtime.refreshTerminalStatus();
    hold.release();
    const opened = await opening;

    expect(opened.terminalId).not.toBe(h.savedTerminalId);
    expect(runtime.exitedAt).toBeUndefined();
    expect(h.adapter.status(h.host, h.getSession()).phase).not.toBe('offline');
  });
});

describe('Claude crash protection', () => {
  it('starts without --resume after two quick exits, keeps the old id, and says why', async () => {
    const h = await makeHarness();
    const oldId = h.getSession().nativeSessionId!;
    for (const attempt of [1, 2]) {
      await h.open();
      expect(flagValue(h.launches.at(-1)!.args, '--resume')).toBe(oldId);
      await h.terminals.stop(h.getSession().terminalId!);
      expect(h.getSession().quickExitCount).toBe(attempt);
      const runtime = (h.adapter as unknown as { runtimes: Map<string, { refreshTerminalStatus(): Promise<void> }> }).runtimes.get(h.getSession().id)!;
      await runtime.refreshTerminalStatus();
      const notice = h.adapter.status(h.host, h.getSession()).notice;
      if (attempt === 2) expect(notice).toMatch(/连续/);
      else expect(notice).toBeUndefined();
    }

    watchNativeId(h);
    await h.open();
    const args = h.launches.at(-1)!.args;
    const fresh = h.getSession();
    expect(h.launches).toHaveLength(3);
    expect(args).not.toContain('--resume');
    expect(flagValue(args, '--session-id')).toBe(fresh.nativeSessionId);
    expect(fresh.nativeSessionId).not.toBe(oldId);
    expect(fresh.previousNativeSessionIds).toEqual([oldId]);
    expect(fresh.quickExitCount).toBe(0);
    expect(h.adapter.status(h.host, fresh).notice).toMatch(/全新/);
  });

  it('forgets earlier quick exits once a launch survives the window', async () => {
    const h = await makeHarness();
    await h.open();
    await h.terminals.stop(h.getSession().terminalId!);
    expect(h.getSession().quickExitCount).toBe(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await h.open();
      vi.setSystemTime(Date.now() + 31_000);
      await h.terminals.stop(h.getSession().terminalId!);
    } finally { vi.useRealTimers(); }
    expect(h.getSession().quickExitCount).toBe(0);
  });
});

describe('Claude transcript reads', () => {
  it('gives a caller who needs what was written meanwhile a read that starts after the one in flight', async () => {
    const h = await makeHarness();
    await h.open();
    const runtime = (h.adapter as unknown as { runtimes: Map<string, { transcript: ClaudeTranscript; refreshTranscript(follow?: boolean): Promise<void> }> }).runtimes.get(h.getSession().id)!;
    const calls: string[] = [];
    const real = runtime.transcript.refresh.bind(runtime.transcript);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    runtime.transcript.refresh = async () => { calls.push('start'); if (calls.length === 1) await gate; const result = await real(); calls.push('end'); return result; };
    const poll = runtime.refreshTranscript(false);
    // A Stop hook is posted before the last row is flushed: the read already under way may have started too early for it.
    const needed = runtime.refreshTranscript();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toEqual(['start']);
    release();
    await Promise.all([poll, needed]);
    expect(calls).toEqual(['start', 'end', 'start', 'end']);
  });
});
