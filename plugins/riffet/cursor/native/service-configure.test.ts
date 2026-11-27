import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalMode, NativeStatus } from '@contracts';
import type { AgentLaunchSpec, AgentSessionView, AgentTerminalView } from '@riffet/plugin-api/experimental/agent';
import { cursorPort } from '../host-port.js';
import { FakeHost } from '../testing/fake-host.js';
import { adoptableApproval, approvalFromFooter, configureGate, NativeService, Transcript, type SettledCursorTurn } from './service.js';
import type { CursorLiveStep } from './live.js';
import { Watch } from './watch.js';

/** A footer the CLI painted: prompt bar above the model/context/permission line above the workspace. */
const idleScreen = [
  '  → Add a follow-up',
  '  Claude Opus 5.5 300K High · 7.4%       Auto Review',
  '  /srv/home/alice/project · main',
].join('\n');

const busyScreen = [
  '  Working…  ctrl+c to stop',
  '  → Add a follow-up',
  '  Claude Opus 5.5 300K High · 7.4%       Run Everything',
  '  /srv/home/alice/project · main',
].join('\n');

/** A dialog owns the pane: the footer is still painted, the prompt bar is not. */
const dialogScreen = [
  '  Do you want to run `rm -rf build`?',
  '  Claude Opus 5.5 300K High · 7.4%       Run Everything',
  '  /srv/home/alice/project · main',
].join('\n');

/** Idle, and the footer names the mode the switch asked for: the CLI is the authority on it. */
const idleRunEverythingScreen = [
  '  → Add a follow-up',
  '  Claude Opus 5.5 300K High · 7.4%       Run Everything',
  '  /srv/home/alice/project · main',
].join('\n');

/** Boot: no footer yet, which the parser reports as an unparsable pane. */
const bootingScreen = '  Starting cursor-agent…';

describe('approvalFromFooter', () => {
  it('reads the CLI default when a painted footer names no permission', () => {
    expect(approvalFromFooter(undefined)).toBe('allowlist');
    expect(approvalFromFooter('')).toBe('allowlist');
  });

  it('reads auto review however the CLI spells it', () => {
    expect(approvalFromFooter('Auto Review')).toBe('auto-review');
    expect(approvalFromFooter('auto-review')).toBe('auto-review');
  });

  it('reads the run-everything family as unrestricted', () => {
    for (const label of ['Run Everything', 'run everything', 'Unrestricted', 'YOLO']) {
      expect(approvalFromFooter(label)).toBe('unrestricted');
    }
  });

  it('reports an unknown label as unrecognised instead of guessing allowlist', () => {
    expect(approvalFromFooter('Supervised')).toBeUndefined();
  });
});

describe('adoptableApproval', () => {
  it('adopts what a footer painted by this tick names', () => {
    expect(adoptableApproval(true, 'Run Everything')).toBe('unrestricted');
    expect(adoptableApproval(true, undefined)).toBe('allowlist');
  });

  it('never writes back the cached fallback a footer-less tick keeps for the UI', () => {
    // This is the restart window: `watch.status.approval` still holds the pre-switch value because
    // a restart drops chat/transcript/booted state, not status. Persisting it would silently undo
    // the switch that was just applied to the launch flags.
    expect(adoptableApproval(false, 'Run Everything')).toBeUndefined();
    expect(adoptableApproval(false, undefined)).toBeUndefined();
  });

  it('does not adopt an unknown label even from a painted footer', () => {
    expect(adoptableApproval(true, 'Supervised')).toBeUndefined();
  });
});

describe('configureGate', () => {
  it('believes the in-memory phase when it knows something', () => {
    expect(configureGate({ phase: 'busy' })).toBe('busy');
    expect(configureGate({ phase: 'attention' })).toBe('attention');
    expect(configureGate({ phase: 'starting' })).toBe('starting');
    // A screen is only consulted about a memory that has nothing to say.
    expect(configureGate({ phase: 'busy', screenPhase: 'idle' })).toBe('busy');
    expect(configureGate({ phase: 'starting', screenPhase: 'idle' })).toBe('starting');
  });

  it('lets a known-idle CLI through without re-reading the pane', () => {
    expect(configureGate({ phase: 'idle' })).toBe('proceed');
    expect(configureGate({ phase: 'idle', screenPhase: 'busy' })).toBe('proceed');
  });

  it('reads the screen when the memory is blank, because offline is ignorance not idleness', () => {
    expect(configureGate({ phase: 'offline', screenPhase: 'idle' })).toBe('proceed');
    expect(configureGate({ phase: 'offline', screenPhase: 'busy' })).toBe('busy');
    expect(configureGate({ phase: 'offline', screenPhase: 'attention' })).toBe('attention');
    expect(configureGate({ phase: 'offline', screenPhase: 'starting' })).toBe('starting');
  });

  it('refuses when no screen answered at all', () => {
    expect(configureGate({ phase: 'offline' })).toBe('unreadable');
    expect(configureGate({ phase: 'offline', screenPhase: 'offline' })).toBe('unreadable');
  });
});

/** The flags of a launch, without the `--resume <chat>` the runtime puts first: what these tests pin. */
const flagsOf = ({ spec }: { spec: AgentLaunchSpec }): string[] => { const args = spec.args; return args[0] === '--resume' ? args.slice(2) : args; };

function fakeSession(overrides: Partial<AgentSessionView> = {}): AgentSessionView {
  return {
    id: 'session-1', projectId: 'project-1', title: 'Conversation',
    state: 'running', model: 'gpt-5', mode: 'agent', approval: 'allowlist',
    terminalId: 'terminal-1', nativeSessionId: '29846c62-123d-4c49-bddc-7da93361b97a',
    ...overrides,
  };
}

const project = { id: 'project-1', name: 'Project', cwd: '/srv/home/alice/project' };

const terminalRecord = (id: string, epoch = 1): AgentTerminalView => ({
  id, projectId: 'project-1', title: 't', kind: 'cursor', epoch, state: 'running', persistent: true, cols: 80, rows: 24, createdAt: '2026-01-01T00:00:00.000Z',
});

/** A run the dispatcher has taken ownership of: it left the queue, so the pane is no longer free to relaunch. */
const sentRun = { id: 'run-1', sessionId: 'session-1', commandId: 'command-1', state: 'running', delivery: 'input_sent' };

/**
 * A host with one mutable session record and a screen the test can repaint, so a subscription can
 * watch the conversation the way the browser does and a switch can land between two ticks.
 */
function watchHarness(initialScreen: string | undefined) {
  const screens: { value: string | undefined } = { value: initialScreen };
  const host = new FakeHost({ sessions: [fakeSession({ nativeSessionId: undefined })], projects: [project], terminals: [terminalRecord('terminal-1')] });
  host.screen = () => screens.value;
  host.onLaunch = () => ({ id: 'terminal-2', epoch: 2 });
  const lockGate = { get hold() { return host.lockGate; }, set hold(value: Promise<void> | undefined) { host.lockGate = value; } };
  const service = new NativeService(cursorPort(host), { configDir: '/tmp/riffet-test', cliPath: 'cursor-agent', pollMs: 25 });
  services.push(service);
  return { service, session: () => host.sessions.get('session-1')!, screens, stopped: host.stopped, created: host.launched, inFlight: host.unfinished, locks: host.locked, lockGate };
}

/**
 * The watch's first tick is fire-and-forget and `snapshot` coalesces onto it without awaiting, so
 * wait for the status a completed tick publishes instead of assuming one has finished.
 */
async function settle(service: NativeService, sessionId: string, ready: (phase: NativeStatus['phase']) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (ready(service.status(sessionId).phase)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`native status never settled, still ${service.status(sessionId).phase}`);
}

async function until(check: () => boolean, description: string, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/**
 * A NativeService with no watch at all — the state the audit called out. `status()` therefore
 * answers `offline` exactly as it does in production before a browser subscribes.
 */
function harness(screen: string | undefined) {
  const session = fakeSession();
  const host = new FakeHost({ sessions: [session], projects: [project], terminals: [terminalRecord('terminal-1')], screen });
  host.onLaunch = () => ({ id: 'terminal-2' });
  const service = new NativeService(cursorPort(host), { configDir: '/tmp/riffet-test', cliPath: 'cursor-agent' });
  services.push(service);
  return { service, session, host, stopped: host.stopped, created: host.launched, updates: host.updates };
}

const services: NativeService[] = [];
afterEach(() => { while (services.length) services.pop()!.closeAll(); });

it('waits for a continuously idle Cursor prompt before settling the same turn', async () => {
  const { service, session, host } = harness(busyScreen);
  const watch = new Watch(session.id);
  const chat = new Transcript(session.nativeSessionId!, '/tmp/riffet-test-unused/store.db', session.id);
  chat.status = 'ok';
  chat.rootId = 'root';
  chat.events = [{ type: 'agent_thought_chunk', nativeId: 'thought', sessionId: session.id, sequence: 1, data: {}, createdAt: '' }];
  const turn = vi.spyOn(chat, 'turnId').mockReturnValue('generation');
  watch.chat = chat;
  const answered = vi.fn<(_session: AgentSessionView, answer: SettledCursorTurn, stillIdle: () => boolean) => void>();
  let stoppedTurn: string | undefined;
  service.useTurnObserver({
    answered, activeTurn: () => undefined, offline: vi.fn(),
    recordedOutcome: (_sessionId, target) => target.turnId === stoppedTurn ? 'cancelled' : undefined,
  });
  const poll = (clock: number) => {
    vi.setSystemTime(new Date(clock));
    return (service as unknown as { updateStatus(watch: Watch, session: AgentSessionView): Promise<void> }).updateStatus(watch, session);
  };
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    await poll(1000);
    await poll(5000);
    expect(answered).not.toHaveBeenCalled();

    host.screen = idleScreen;
    await poll(5100);
    host.screen = dialogScreen;
    await poll(8000);
    host.screen = idleScreen;
    await poll(8100);
    await poll(11099);
    expect(answered).not.toHaveBeenCalled();
    await poll(11100);
    expect(answered).toHaveBeenCalledTimes(1);
    const [_, answer, stillIdle] = answered.mock.calls[0]!;
    expect(answer).toMatchObject({ turnId: 'generation', rootId: 'root' });
    expect(stillIdle()).toBe(true);

    host.screen = `${idleScreen}\n  Error: gateway timeout`;
    await poll(11200);
    await poll(14200);
    const [, failed, stillFailed] = answered.mock.calls[1]!;
    expect(failed).toMatchObject({ turnId: 'generation', error: 'gateway timeout' });
    expect(stillFailed()).toBe(true);

    chat.rootId = 'successor-root';
    turn.mockReturnValue('successor');
    expect(stillFailed()).toBe(false);
    // The old error line stayed visible while the successor's busy frames went unsampled.
    await poll(14300);
    await poll(17300);
    expect(answered.mock.calls[2]?.[1]).toMatchObject({ turnId: 'successor', rootId: 'successor-root', error: undefined });

    host.screen = idleScreen;
    chat.rootId = 'incomplete-tool-root';
    chat.lastActivityAt = 17400;
    vi.spyOn(chat, 'answered').mockReturnValue(false);
    vi.spyOn(chat, 'awaitingReply').mockReturnValue(true);
    stoppedTurn = 'generation';
    await poll(17400);
    await poll(20400);
    expect(answered).toHaveBeenCalledTimes(3);
    expect(watch.status.phase).toBe('busy');
    // An exact Stop can settle a checkpoint that has no final assistant answer.
    stoppedTurn = 'successor';
    await poll(20500);
    await poll(23500);
    const [, stopped, stillStopped] = answered.mock.calls[3]!;
    expect(stopped).toMatchObject({ turnId: 'successor', rootId: 'incomplete-tool-root', error: undefined });
    expect(stillStopped()).toBe(true);
    expect(watch.status.phase).toBe('idle');
  } finally {
    watch.close();
    vi.useRealTimers();
  }
});

// docs/TURN-LIFECYCLE.md §4.6: the tap's stream says when the turn the store names is over. The pane decides
// nothing while it is open, and only stands in again once it broke without an end.
it('lets the protocol stream settle a turn the tap follows, whatever the pane shows', async () => {
  const session = fakeSession();
  const host = new FakeHost({ sessions: [session], projects: [project], terminals: [terminalRecord('terminal-1')], screen: idleScreen });
  let step: CursorLiveStep | undefined = { turn: 'generation', at: '', step: 'request:1', sealed: true, parts: [{ type: 'text', text: 'between steps' }], turnEnds: true };
  const service = new NativeService(cursorPort(host), { configDir: '/tmp/riffet-test', cliPath: 'cursor-agent', live: { read: () => step } as never });
  services.push(service);
  const watch = new Watch(session.id);
  const chat = new Transcript(session.nativeSessionId!, '/tmp/riffet-test-unused/store.db', session.id);
  chat.status = 'ok';
  chat.rootId = 'root';
  chat.events = [{ type: 'agent_message_chunk', nativeId: 'answer', sessionId: session.id, sequence: 1, data: {}, createdAt: '' }];
  const turn = vi.spyOn(chat, 'turnId').mockReturnValue('generation');
  vi.spyOn(chat, 'answered').mockReturnValue(true);
  watch.chat = chat;
  const answered = vi.fn<(_session: AgentSessionView, answer: SettledCursorTurn, stillIdle: () => boolean) => void>();
  service.useTurnObserver({ answered, activeTurn: () => undefined, offline: vi.fn(), recordedOutcome: () => undefined });
  const poll = (clock: number) => {
    vi.setSystemTime(new Date(clock));
    return (service as unknown as { updateStatus(watch: Watch, session: AgentSessionView): Promise<void> }).updateStatus(watch, session);
  };
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    // An idle prompt and an answered-looking store between two steps: the stream is still open.
    await poll(1000);
    await poll(9000);
    expect(answered).not.toHaveBeenCalled();
    expect(watch.status.phase).toBe('busy');

    // The server ends the turn while the pane still shows a spinner: settled at once, by the store's turn.
    step = { ...step, ended: 9500 };
    host.screen = busyScreen;
    await poll(9600);
    expect(answered).toHaveBeenCalledTimes(1);
    const [, answer, stillCurrent] = answered.mock.calls[0]!;
    expect(answer).toMatchObject({ turnId: 'generation', rootId: 'root' });
    expect(stillCurrent()).toBe(true);
    step = { ...step, ended: undefined, parts: [{ type: 'text', text: 'went on' }] };
    expect(stillCurrent()).toBe(false);

    // A stream that broke without an end leaves the turn to the pane and the store again.
    turn.mockReturnValue('next');
    chat.rootId = 'next-root';
    step = { turn: 'next', at: '', step: 'request:2', sealed: true, parts: [], prompt: 'next', turnEnds: true, broken: 12000 };
    host.screen = idleScreen;
    await poll(12100);
    await poll(15200);
    expect(answered.mock.calls[1]?.[1]).toMatchObject({ turnId: 'next', rootId: 'next-root' });
  } finally {
    watch.close();
    vi.useRealTimers();
  }
});

it('publishes a persisted startup error offline and clears it after correcting the session settings', async () => {
  const { service, session } = watchHarness(undefined);
  const error = 'Cursor 启动失败：Cannot use this model: retired-model.';
  Object.assign(session(), { state: 'failed', error, terminalId: undefined });
  const unsubscribe = service.subscribe(session().id, () => undefined);
  try {
    await until(() => service.status(session().id).notice === error, 'the persisted startup failure');
    expect(service.status(session().id).phase).toBe('offline');
    expect(session().state).toBe('failed');
    await service.setApproval(session(), 'unrestricted');
    await until(() => service.status(session().id).notice === undefined, 'the corrected offline settings');
    expect(session().error).toBeUndefined();
  } finally { unsubscribe(); }
});

// A pane the CLI has not finished with cannot be relaunched — that would kill the turn — but the
// switch itself is never refused any more: it is recorded and applied at the first idle moment. A
// refused switch was the one outcome the reader could do nothing about.
describe('NativeService.configure with no watch', () => {
  it('defers a switch made against a busy pane instead of stopping the CLI mid-turn', async () => {
    const { service, session, stopped, updates } = harness(busyScreen);
    expect(service.status(session.id).phase).toBe('offline');

    const next = await service.configure(session, { approval: 'unrestricted' });

    expect(next.approval).toBe('unrestricted');
    expect(next.configPending).toBe(true);
    expect(updates).toEqual([{ approval: 'unrestricted', configPending: true, error: undefined }]);
    expect(stopped).toEqual([]);
  });

  it('records a switch made while a dialog owns the pane, and still leaves it alone', async () => {
    const { service, session, stopped, updates } = harness(dialogScreen);

    const next = await service.configure(session, { approval: 'auto-review' });

    expect(next.configPending).toBe(true);
    expect(updates).toEqual([{ approval: 'auto-review', configPending: true, error: undefined }]);
    expect(stopped).toEqual([]);
  });

  it('defers when the screen cannot be read, because a killed turn is worse than a wait', async () => {
    const { service, session, stopped } = harness(undefined);

    const next = await service.configure(session, { approval: 'unrestricted' });

    expect(next.configPending).toBe(true);
    expect(stopped).toEqual([]);
  });

  it('defers on a pane that has not painted its footer yet', async () => {
    const { service, session, stopped } = harness(bootingScreen);

    const next = await service.configure(session, { approval: 'unrestricted' });

    expect(next.configPending).toBe(true);
    expect(stopped).toEqual([]);
  });

  it('restarts once the screen really is idle, applying the new intent', async () => {
    const { service, session, stopped, created, updates } = harness(idleScreen);
    const next = await service.configure(session, { approval: 'unrestricted' });
    expect(stopped).toEqual(['terminal-1']);
    expect(created).toHaveLength(1);
    expect(flagsOf(created[0]!)).toEqual(['--trust', '--force', '--model', 'gpt-5']);
    expect(updates).toEqual([{ terminalId: 'terminal-2', state: 'running', approval: 'unrestricted', configPending: false }]);
    expect(next.approval).toBe('unrestricted');
    expect(next.configPending).toBe(false);
  });
});

describe('NativeService.configure with a watch', () => {
  it('defers a switch until a CLI that is still starting has a prompt bar', async () => {
    // `starting` is the phase the old gate let through even though the CLI has no prompt bar yet.
    const { service, session } = watchHarness(bootingScreen);
    service.subscribe(session().id, () => undefined);
    await settle(service, session().id, (phase) => phase === 'starting');

    const next = await service.configure(session(), { approval: 'unrestricted' });

    expect(next.configPending).toBe(true);
    expect(session().terminalId).toBe('terminal-1');
  });

  it('allows back-to-back permission switches while a config relaunch is still booting and never flips to busy on historical scrollback', async () => {
    const { service, session, screens, created, stopped } = watchHarness(idleScreen);
    const phases: NativeStatus['phase'][] = [];
    service.subscribe(session().id, (msg) => {
      if (msg.type === 'status') phases.push(msg.status.phase);
    });
    await settle(service, session().id, (phase) => phase === 'idle');

    // Switch 1: relaunches into a terminal that is still rendering historical scrollback (including a past busy footer).
    screens.value = busyScreen;
    const first = await service.configure(session(), { approval: 'unrestricted' });
    expect(first.configPending).toBe(false);
    expect(first.approval).toBe('unrestricted');
    await settle(service, session().id, (phase) => phase === 'starting');
    expect(phases).not.toContain('busy');

    // Switch 2 while the first config relaunch is still booting: replaces immediately without deferring.
    const second = await service.configure(session(), { approval: 'allowlist' });
    expect(second.configPending).toBe(false);
    expect(second.approval).toBe('allowlist');
    expect(created).toHaveLength(2);
    expect(stopped).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(session().approval).toBe('allowlist');
    expect(phases).not.toContain('busy');
  });
});

describe('NativeService approval follow-through', () => {
  it('adopts a permission the user toggled in the TUI', async () => {
    const { service, session } = watchHarness(idleScreen);
    // The fixture footer reads "Auto Review" while the record still says allowlist: the CLI wins.
    service.subscribe(session().id, () => undefined);
    await settle(service, session().id, (phase) => phase === 'idle');
    expect(session().approval).toBe('auto-review');
    // The watched path moves the counter too, so the same rule holds however the mode was learned.
    expect(session().configRevision).toBe(1);
  });

  it('does not resurrect the cached permission over a switch made during a restart window', async () => {
    const { service, session, screens } = watchHarness(idleScreen);
    service.subscribe(session().id, () => undefined);
    await settle(service, session().id, (phase) => phase === 'idle');
    expect(session().approval).toBe('auto-review');
    // The user switches back to Ask-each-time; the CLI relaunches and its footer is not painted yet,
    // so `watch.status.approval` still holds the pre-switch value while booting covers the footer.
    await service.configure(session(), { approval: 'allowlist' });
    expect(session().approval).toBe('allowlist');
    screens.value = bootingScreen;
    await settle(service, session().id, (phase) => phase !== 'idle');
    // The UI keeps the last painted value instead of blinking, but the record keeps the new intent.
    expect(service.status(session().id).approval).toBe('auto-review');
    expect(session().approval).toBe('allowlist');
  });
});

describe('NativeService unrecognised panes', () => {
  /** Footer painted, prompt bar gone, and nothing the interaction readers know. */
  const unknownScreen = [
    '  Something the CLI has never asked before',
    '  Claude Opus 5.5 300K High · 7.4%       Auto Review',
    '  /srv/home/alice/project · main',
  ].join('\n');

  async function sample(service: NativeService, sessionId: string, ms: number): Promise<Array<NativeStatus['phase']>> {
    const phases: Array<NativeStatus['phase']> = [];
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      phases.push(service.status(sessionId).phase);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return phases;
  }

  it('does not report a frame that passes within a poll as attention', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { service, session, screens } = watchHarness(idleScreen);
    service.subscribe(session().id, () => undefined);
    await settle(service, session().id, (phase) => phase === 'idle');
    screens.value = unknownScreen;
    await new Promise((resolve) => setTimeout(resolve, 30));
    screens.value = idleScreen;
    expect(await sample(service, session().id, 120)).not.toContain('attention');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reports a pane that stays unrecognised, and logs its bottom lines once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { service, session, screens } = watchHarness(idleScreen);
    service.subscribe(session().id, () => undefined);
    await settle(service, session().id, (phase) => phase === 'idle');
    screens.value = unknownScreen;
    const changedAt = Date.now();
    await settle(service, session().id, (phase) => phase === 'attention');
    expect(Date.now() - changedAt).toBeGreaterThanOrEqual(50);
    await sample(service, session().id, 80);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('Something the CLI has never asked before');
    warn.mockRestore();
  });
});

/**
 * A conversation no browser subscribes to, which is the only state the state sweep reads panes for.
 * `fakeSession` is `running` with a live terminal, so the sweep's own filters let it through.
 */
function sweepHarness(screen: string, approval: ApprovalMode = 'allowlist') {
  const screens = { value: screen };
  const host = new FakeHost({ sessions: [fakeSession({ approval })], projects: [project], terminals: [terminalRecord('terminal-1')] });
  host.screen = () => screens.value;
  host.onLaunch = (_sessionId, spec) => {
    screens.value = spec.args.includes('--force') ? idleRunEverythingScreen : idleScreen;
    return { id: 'terminal-2', epoch: 2 };
  };
  const service = new NativeService(cursorPort(host), { configDir: '/tmp/riffet-test', cliPath: 'cursor-agent' });
  services.push(service);
  return { service, session: () => host.sessions.get('session-1')!, screens, created: host.launched };
}

// A switch asked for mid-turn is the case the picker used to refuse outright. It cannot relaunch the
// CLI without killing the turn, so it is recorded and applied at the first idle moment — the same
// promise the next `start` already gives a CLI that is not running at all.
describe('NativeService deferring a switch asked for mid-turn', () => {
  it('records it, leaves the turn alone, and relaunches as soon as the pane is idle', async () => {
    const { service, session, screens, stopped, created } = watchHarness(busyScreen.replace('Run Everything', 'Auto Review'));
    service.subscribe(session().id, () => undefined);
    await settle(service, session().id, (phase) => phase === 'busy');

    const updated = await service.configure(session(), { approval: 'unrestricted' });

    expect(updated.approval).toBe('unrestricted');
    expect(updated.configPending).toBe(true);
    expect(stopped).toEqual([]);
    expect(created).toEqual([]);

    // The old process keeps its original mode until it is actually relaunched. Reading its idle
    // footer must not erase the pending choice before restart builds the new argv.
    screens.value = idleScreen;
    await settle(service, session().id, (phase) => phase === 'idle');
    await until(() => created.length > 0, 'the deferred relaunch');
    expect(stopped).toEqual(['terminal-1']);
    expect(flagsOf(created[0]!)).toEqual(['--trust', '--force', '--model', 'gpt-5']);
    expect(session().configPending).toBe(false);
    expect(session().approval).toBe('unrestricted');
    screens.value = idleRunEverythingScreen;
  });

  it('waits for a message that already left the queue, not just for the screen', async () => {
    const { service, session, screens, created, inFlight } = watchHarness(idleScreen);
    service.subscribe(session().id, () => undefined);
    await settle(service, session().id, (phase) => phase === 'idle');
    // The pane looks idle because the message is still on its way to it: relaunching now would pull the
    // terminal out from under the delivery.
    inFlight.push(sentRun);

    const updated = await service.configure(session(), { approval: 'unrestricted' });
    expect(updated.configPending).toBe(true);
    expect(created).toEqual([]);

    inFlight.length = 0;
    await settle(service, session().id, (phase) => phase === 'idle');
    await until(() => created.length > 0, 'the relaunch once the delivery settled');
    expect(session().configPending).toBe(false);
  });

  it('applies the deferred relaunch under the session lock and re-checks for a delivery that took the lock first', async () => {
    const { service, session, screens, created, stopped, inFlight, locks, lockGate } = watchHarness(busyScreen);
    service.subscribe(session().id, () => undefined);
    await settle(service, session().id, (phase) => phase === 'busy');
    await service.configure(session(), { approval: 'unrestricted' });
    expect(session().configPending).toBe(true);

    // A dispatcher holds the lock while the pane goes idle; it leaves a delivery in flight behind it.
    let release!: () => void;
    lockGate.hold = new Promise<void>((resolve) => { release = resolve; });
    screens.value = idleRunEverythingScreen;
    await until(() => locks.length > 0, 'the deferred relaunch to queue on the session lock');
    expect(created).toEqual([]);
    inFlight.push(sentRun);
    release();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(created).toEqual([]);
    expect(stopped).toEqual([]);
    expect(session().configPending).toBe(true);

    lockGate.hold = undefined;
    inFlight.length = 0;
    await until(() => created.length > 0, 'the relaunch once the delivery settled');
    expect(stopped).toEqual(['terminal-1']);
    expect(session().configPending).toBe(false);
  });
});

// The sweep runs every three seconds, so these drive the clock rather than wait for it. Without this
// follow-through the record keeps a permission the user has already left, and the next `restart`
// relaunches the CLI with it — the one direction the contract forbids.
describe('NativeService state sweep', () => {
  it('preserves a pending choice while an unwatched old process still reports its original mode', async () => {
    vi.useFakeTimers();
    try {
      const { service, session, screens, created } = sweepHarness(busyScreen.replace('Run Everything', 'Auto Review'), 'auto-review');
      await service.configure(session(), { approval: 'unrestricted' });
      await vi.advanceTimersByTimeAsync(3000);
      expect(session()).toMatchObject({ approval: 'unrestricted', configPending: true });
      expect(created).toEqual([]);
      screens.value = idleScreen;
      await vi.advanceTimersByTimeAsync(3010);
      expect(created).toHaveLength(1);
      expect(flagsOf(created[0]!)).toEqual(['--trust', '--force', '--model', 'gpt-5']);
      expect(session()).toMatchObject({ approval: 'unrestricted', configPending: false });
      screens.value = idleRunEverythingScreen;
    } finally { vi.useRealTimers(); }
  });

  it('follows a permission toggled in a CLI nobody subscribes to', async () => {
    vi.useFakeTimers();
    try {
      const { session } = sweepHarness(idleScreen);
      await vi.advanceTimersByTimeAsync(3000);
      expect(session().approval).toBe('auto-review');
      // A change of meaning moves the counter, exactly as it does on the watched path.
      expect(session().configRevision).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('writes nothing when the pane names the mode the record already holds', async () => {
    vi.useFakeTimers();
    try {
      const { session } = sweepHarness(idleScreen, 'auto-review');
      await vi.advanceTimersByTimeAsync(3000);
      expect(session().approval).toBe('auto-review');
      expect(session().configRevision).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});

describe('NativeService Cursor chat identity', () => {
  const oldChat = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const nextChat = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const scanProject = { id: 'project-1', name: 'Scan', cwd: '/tmp/riffet-scan' };

  function identityHarness() {
    const session = fakeSession({ nativeSessionId: oldChat, terminalId: 'pane-1' });
    const host = new FakeHost({ sessions: [session], projects: [scanProject], terminals: [terminalRecord('pane-1')] });
    const service = new NativeService(cursorPort(host), { configDir: '/tmp/riffet-scan', cliPath: 'cursor-agent' });
    services.push(service);
    return { host, session, service };
  }

  function chats(service: NativeService, open: string[]) {
    const scan = service as unknown as {
      workspaceChats: (dir: string) => Promise<Array<{ id: string; mtime: number; meta: { agentId: string } }>>;
      openChats: (dir: string, terminalId: string) => Promise<string[]>;
      scan: (watch: Watch, session: AgentSessionView, dir: string) => Promise<AgentSessionView>;
    };
    scan.workspaceChats = async () => [
      { id: oldChat, mtime: 1, meta: { agentId: oldChat } },
      { id: nextChat, mtime: 2, meta: { agentId: nextChat } },
    ];
    scan.openChats = async () => open;
    return scan;
  }

  it('moves the stored chat id when the CLI switches chats', async () => {
    const { host, session, service } = identityHarness();
    const selected = await chats(service, [nextChat]).scan(new Watch(session.id), session, scanProject.cwd);
    expect(selected).toMatchObject({ nativeSessionId: nextChat });
    expect(host.sessions.get(session.id)).toMatchObject({ nativeSessionId: nextChat });
    // Hooks and the transcript source read the canonical field, so it now names the new chat.
    expect(service.sessionForChat(nextChat)?.id).toBe(session.id);
    expect(service.sessionForChat(oldChat)).toBeUndefined();
  });

  it('keeps the chat this launch was given while its CLI holds no chat open', async () => {
    // After `/new` the CLI resumes an assigned id whose store only appears with its first prompt; a newer
    // chat in the shared workspace bucket (the one just archived, or another conversation's) is no answer.
    const { host, session, service } = identityHarness();
    const selected = await chats(service, []).scan(new Watch(session.id), session, scanProject.cwd);
    expect(selected).toMatchObject({ nativeSessionId: oldChat });
    expect(host.sessions.get(session.id)).toMatchObject({ nativeSessionId: oldChat });
  });

  it('leaves the record untouched when the working chat belongs to another conversation', async () => {
    const { host, session, service } = identityHarness();
    host.sessions.set('session-2', fakeSession({ id: 'session-2', nativeSessionId: nextChat, terminalId: undefined }));
    await expect(chats(service, [nextChat]).scan(new Watch(session.id), session, scanProject.cwd))
      .rejects.toMatchObject({ code: 'NATIVE_SESSION_ID_IN_USE' });
    expect(host.sessions.get(session.id)).toMatchObject({ nativeSessionId: oldChat });
    expect(host.sessions.get('session-2')).toMatchObject({ nativeSessionId: nextChat });
  });
});
