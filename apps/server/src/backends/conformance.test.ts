import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSISTANT_BACKENDS,
  DEFAULT_QUICK_CHAT_PRESETS,
  isAssistantBackend,
  type NativeBackendCapabilities,
  type NativeBackendId,
  type NativeStatus,
  type Run,
  type Session,
  type TerminalInfo,
} from '../../../../packages/contracts/src/index.js';
import { SessionLock } from '../agent-host/session-lock.js';
import { AgentTeamService } from '../assistant/team.js';
import { JournalFeed } from '../journal/feed.js';
import { buildSessionControlSnapshot } from '../native/control.js';
import { NativeDispatcher } from '../native/dispatch.js';
import { PluginRegistry } from '../plugins/registry.js';
import { RiffetMcpService } from '../riffet-mcp/service.js';
import { restartObservation } from '../session-identity.js';
import { Store } from '../store.js';
import { ChatBackendAdapter } from './chat/index.js';
import { ClaudeBackendAdapter } from './claude/index.js';
import { traexFlavor } from './codex/flavors.js';
import { CodexBackendAdapter } from './codex/index.js';
import { DispatchFeed } from './dispatch-feed.js';
import { DroidBackendAdapter } from './droid/index.js';
import { DshBackendAdapter } from './dsh/index.js';
import { PiBackendAdapter } from './pi/index.js';
import { PluginBackends } from './plugin-backends.js';
import { isNativeBackendId, NativeBackendRegistry } from './registry.js';
import { NativeBackendService } from './service.js';
import type { NativeBackendDriver, NativeBackendProfileConfig, NativeControlMessage } from './types.js';

/**
 * Cross-backend conformance suite pinning invariants shared by every registered core and built-in
 * plugin Agent driver. Built-in plugin drivers are loaded exclusively through `PluginRegistry`
 * + `PluginBackends` to honor `pnpm check:plugins` boundaries without spawning external CLIs.
 */

const CORE_BACKEND_IDS: readonly NativeBackendId[] = ['claude', 'codex', 'traex', 'dsh', 'droid', 'pi', 'chat'];
const EXPECTED_PLUGIN_BACKEND_IDS: readonly NativeBackendId[] = ['cursor', 'antigravity'];
const ALL_EXPECTED_BACKEND_IDS: readonly NativeBackendId[] = [...CORE_BACKEND_IDS, ...EXPECTED_PLUGIN_BACKEND_IDS];

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const safeExecutableConfig = (backendId: NativeBackendId): Record<string, unknown> => {
  switch (backendId) {
    case 'codex':
      return { executable: '/nonexistent/codex' };
    case 'traex':
      return { executable: '/nonexistent/traecli' };
    case 'cursor':
      return { executable: '/nonexistent/cursor-agent' };
    case 'antigravity':
      return { executable: '/nonexistent/agy' };
    default:
      return {};
  }
};

async function createFullBackendHarness() {
  const stateDir = await mkdtemp(join(tmpdir(), 'riffet-backend-conformance-'));
  const store = new Store(':memory:');
  const registry = new NativeBackendRegistry();
  const plugins = new PluginRegistry({
    stateDir,
    developmentPackages: [],
    agentBackendProvided: id => isNativeBackendId(id) && registry.isCore(id),
  });

  let service!: NativeBackendService;
  registry
    .register(new CodexBackendAdapter(undefined, undefined, plugins, { stateDir }))
    .register(new ClaudeBackendAdapter({ stateDir }))
    .register(new DshBackendAdapter())
    .register(new DroidBackendAdapter())
    .register(new PiBackendAdapter({ stateDir }))
    .register(new CodexBackendAdapter(undefined, traexFlavor, plugins))
    .register(new ChatBackendAdapter({
      stateDir,
      get catalog() { return service.catalog; },
      gatewayProfiles: backendId => service.catalog.gatewayProfiles(backendId),
      defaultModel: () => undefined,
      latestModel: () => undefined,
      presets: () => DEFAULT_QUICK_CHAT_PRESETS,
    }));

  const terminal = {
    listWarmups: async () => [],
    get: async () => { throw new Error('No live terminal in conformance harness'); },
    stop: async () => undefined,
  };
  service = new NativeBackendService({
    store,
    terminal: terminal as never,
    workspace: {} as never,
    runtime: new SessionLock(),
    registry,
    profiles: {
      get: () => ({ profiles: [] }),
      getConfig: (backendId) => safeExecutableConfig(backendId),
    },
  });

  const pluginBackends = new PluginBackends({ plugins, registry, service });
  pluginBackends.start();

  cleanups.push(async () => {
    pluginBackends.close();
    await service.closeAll().catch(() => undefined);
    await plugins.close().catch(() => undefined);
    store.close();
    await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  // Activate every built-in plugin that declares an Agent backend (e.g. cursor, antigravity).
  const owners = [...new Set(plugins.declaredAgentBackends().map(entry => entry.owner))];
  for (const owner of owners) {
    await plugins.update(owner, { enablement: 'on' });
  }

  return { stateDir, store, registry, plugins, service };
}

function makeStopContractDriver(options: {
  id: NativeBackendId;
  label: string;
  supportsTargetedStop: boolean;
}) {
  const statuses = new Map<string, NativeStatus>();
  const listeners = new Map<string, Set<(message: NativeControlMessage) => void>>();
  const interruptCalls: Array<{ clearPrompt?: boolean; expectedStop?: unknown } | undefined> = [];

  const emitStatus = (sessionId: string, status: NativeStatus) => {
    statuses.set(sessionId, status);
    for (const listener of listeners.get(sessionId) ?? []) listener({ type: 'status', status });
  };

  const driver: NativeBackendDriver = {
    id: options.id,
    label: options.label,
    traits: {},
    profiles: () => [{ id: 'default', backendId: options.id, name: options.label, isDefault: true, config: {} }],
    capabilities: (): NativeBackendCapabilities => ({
      backendId: options.id,
      label: options.label,
      modes: [{ id: 'agent', label: 'Agent' }],
      permissions: [],
      interactionTransport: 'protocol',
      supportsResume: true,
      supportsInterrupt: true,
      supportsTargetedStop: options.supportsTargetedStop,
      supportsHistory: true,
      supportsModelSelection: false,
      supportsModeSelection: false,
      supportsPermissionSelection: false,
      slashCommands: [],
    }),
    available: async () => ({ available: true }),
    status: (_host, session) => statuses.get(session.id) ?? { phase: 'idle' },
    subscribe: (_host, session, _profile, listener) => {
      const bucket = listeners.get(session.id) ?? new Set();
      bucket.add(listener);
      listeners.set(session.id, bucket);
      return () => { bucket.delete(listener); };
    },
    openOrResume: async (_host, session) => ({
      nativeSessionId: session.nativeSessionId ?? `native-${session.id}`,
      status: statuses.get(session.id) ?? { phase: 'idle' },
    }),
    send: async () => undefined,
    interrupt: async (_host, session, _profile, interruptOptions) => {
      interruptCalls.push(interruptOptions);
      emitStatus(session.id, { phase: 'idle' });
    },
    interaction: () => undefined,
    respond: async () => ({ status: 'completed' }),
    transcript: (_host, session) => ({ identity: () => session.nativeSessionId, pull: async () => ({ caughtUp: true }), drain: async () => undefined }),
    configure: async (_host, _session, _profile, patch) => ({ ...patch }),
    listModels: async () => [],
    dispose: async () => undefined,
  };

  return { driver, interruptCalls, setStatus: emitStatus };
}

describe('backend conformance suite', () => {
  it('registers all core and official plugin drivers with faithful capability forwarding and valid default profiles', async () => {
    const { registry, plugins, service } = await createFullBackendHarness();
    const drivers = registry.list();
    const registeredIds = drivers.map(driver => driver.id);

    for (const id of ALL_EXPECTED_BACKEND_IDS) {
      expect(registeredIds, `expected backend ${id} to be registered`).toContain(id);
    }
    for (const declared of plugins.declaredAgentBackends()) {
      expect(declared.enabled, `declared plugin backend ${declared.id} should be active`).toBe(true);
      expect(registeredIds, `declared plugin backend ${declared.id} should be registered`).toContain(declared.id);
    }

    for (const driver of drivers) {
      const rawProfiles = driver.profiles(service.host);
      expect(rawProfiles.length, `${driver.id}: profiles() must return at least one profile`).toBeGreaterThanOrEqual(1);
      for (const profile of rawProfiles) {
        expect(profile.id.trim().length, `${driver.id}: profile id must be non-empty`).toBeGreaterThan(0);
        expect(profile.name.trim().length, `${driver.id}: profile name must be non-empty`).toBeGreaterThan(0);
        expect(profile.backendId, `${driver.id}: profile backendId must match driver.id`).toBe(driver.id);
      }

      const catalogProfiles = service.catalog.profiles(driver);
      expect(catalogProfiles.length, `${driver.id}: catalog.profiles() must return at least one profile`).toBeGreaterThanOrEqual(1);
      const rawDefault = rawProfiles.find(profile => profile.isDefault) ?? rawProfiles[0]!;
      const resolvedDefault = service.catalog.validateProfile(driver.id);
      expect(catalogProfiles.some(profile => profile.isDefault) || resolvedDefault.id === rawDefault.id, `${driver.id}: default profile must resolve`).toBe(true);
      expect(() => service.catalog.validateProfileConfig(driver.id, rawDefault.config), `${driver.id}: validateProfileConfig must accept default profile`).not.toThrow();

      const safeProfile: NativeBackendProfileConfig = {
        ...resolvedDefault,
        config: { ...rawDefault.config, ...safeExecutableConfig(driver.id) },
      };
      const rawCapabilities = await driver.capabilities(service.host, safeProfile);
      const forwarded = await service.catalog.driverCapabilities(driver, safeProfile);

      if (rawCapabilities.supportsTargetedStop === false) {
        expect(forwarded.supportsTargetedStop, `${driver.id}: supportsTargetedStop=false must never be overwritten to true`).toBe(false);
      } else {
        expect(forwarded.supportsTargetedStop, `${driver.id}: supportsTargetedStop must match driver declaration`).toBe(rawCapabilities.supportsTargetedStop ?? true);
      }
      expect(forwarded.supportsInterrupt, `${driver.id}: supportsInterrupt must be preserved`).toBe(rawCapabilities.supportsInterrupt);
      if (driver.traits?.riffetTools) {
        expect(forwarded.supportsRiffetTools, `${driver.id}: riffetTools trait must expose supportsRiffetTools=true`).toBe(true);
      }
    }

    // Explicitly pin Antigravity's false supportsTargetedStop so regressions cannot hide behind defaults.
    const agyCapabilities = await service.catalog.capabilitiesFor('antigravity');
    expect(agyCapabilities.supportsTargetedStop).toBe(false);
    expect(agyCapabilities.supportsInterrupt).toBe(true);
  });

  it('registers restartObservation for every driver declaring survivesRestart', async () => {
    const { registry } = await createFullBackendHarness();
    const surviving = registry.list().filter(driver => driver.traits?.survivesRestart === true);

    expect(surviving.map(driver => driver.id)).toEqual(expect.arrayContaining(['claude', 'codex', 'traex', 'cursor', 'antigravity']));
    for (const driver of surviving) {
      const mode = restartObservation(driver.id);
      expect(['hook', 'daemon'], `${driver.id} declares survivesRestart=true and must register restartObservation()`).toContain(mode);
    }
  });

  it('enforces team-member invariants (riffetTools, ASSISTANT_BACKENDS, and dontAsk approval)', async () => {
    const { store, registry, service } = await createFullBackendHarness();
    const project = store.createProject('/tmp/riffet-conformance-member', 'Member Conformance');
    const memberDrivers = registry.list().filter(driver => driver.traits?.startsNewTopic === true);

    expect([...memberDrivers.map(driver => driver.id)].sort()).toEqual([...ASSISTANT_BACKENDS].sort());

    for (const driver of memberDrivers) {
      expect(driver.traits?.riffetTools, `${driver.id}: startsNewTopic driver must declare traits.riffetTools=true`).toBe(true);

      const defaultProfile = service.catalog.validateProfile(driver.id);
      const capabilities = await service.catalog.driverCapabilities(driver, defaultProfile);
      expect(capabilities.supportsRiffetTools, `${driver.id}: driverCapabilities must expose supportsRiffetTools=true`).toBe(true);
      expect(capabilities.supportsStandingMember, `${driver.id}: driverCapabilities must expose supportsStandingMember=true`).toBe(true);
      expect(
        isAssistantBackend(driver.id) || capabilities.supportsStandingMember === true,
        `${driver.id}: startsNewTopic driver must be recognized by isAssistantBackend or supportsStandingMember`,
      ).toBe(true);

      const session = store.createSession({
        projectId: project.id,
        kind: 'native',
        backendId: driver.id,
        mode: 'agent',
      });
      // Background standing runs always configure approval='dontAsk'; no member driver may reject it.
      await expect(
        driver.configure(service.host, session, defaultProfile, { approval: 'dontAsk' }),
        `${driver.id}: configure({ approval: 'dontAsk' }) must be accepted`,
      ).resolves.toBeDefined();
    }

    // Lockstep check for every static ASSISTANT_BACKENDS entry.
    for (const backendId of ASSISTANT_BACKENDS) {
      const driver = registry.get(backendId);
      expect(driver, `ASSISTANT_BACKENDS member ${backendId} should be registered`).toBeDefined();
      expect(isAssistantBackend(backendId), `${backendId} must satisfy isAssistantBackend()`).toBe(true);
      expect(driver!.traits?.startsNewTopic, `ASSISTANT_BACKENDS member ${backendId} must declare traits.startsNewTopic=true`).toBe(true);
      expect(driver!.traits?.riffetTools, `ASSISTANT_BACKENDS member ${backendId} must declare traits.riffetTools=true`).toBe(true);
      const capabilities = await service.catalog.capabilitiesFor(backendId);
      expect(capabilities.supportsStandingMember, `ASSISTANT_BACKENDS member ${backendId} must expose supportsStandingMember=true`).toBe(true);
      expect(capabilities.supportsRiffetTools, `ASSISTANT_BACKENDS member ${backendId} must expose supportsRiffetTools=true`).toBe(true);
    }
  });

  it('enforces plain-stop vs targeted-stop contract across buildSessionControlSnapshot and NativeDispatcher', async () => {
    const store = new Store(':memory:');
    const registry = new NativeBackendRegistry();
    const classA = makeStopContractDriver({ id: 'antigravity', label: 'Class A (No Targeted Stop)', supportsTargetedStop: false });
    const classB = makeStopContractDriver({ id: 'claude', label: 'Class B (Targeted Stop)', supportsTargetedStop: true });
    registry.register(classA.driver).register(classB.driver);

    const sessionLock = new SessionLock();
    const service = new NativeBackendService({
      store,
      terminal: { listWarmups: async () => [] } as never,
      workspace: {} as never,
      runtime: sessionLock,
      registry,
    });
    const journalFeed = new JournalFeed(store.journal);
    const dispatchBackend = {
      ...new DispatchFeed({ service, feed: journalFeed, store }).backend(),
      supportsTargetedStop: (session: Session) => service.supportsTargetedStop(session),
    };
    const dispatcher = new NativeDispatcher(
      store,
      dispatchBackend,
      {
        withSession: (id, operation, options) => (options?.detached ? sessionLock.withDetachedSession(id, operation) : sessionLock.withSession(id, operation)),
        ensure: session => service.ensure(session),
      },
      { readAttachment: async () => { throw new Error('unused'); } } as never,
    );

    cleanups.push(async () => {
      await dispatcher.close();
      await service.closeAll();
      store.close();
    });

    const project = store.createProject('/tmp/riffet-conformance-stop', 'Stop Matrix');
    const makeRunningCase = async (backendId: NativeBackendId, nativeSessionId: string, turnId: string) => {
      const session = store.createSession({
        projectId: project.id,
        kind: 'native',
        backendId,
        nativeSessionId,
        mode: 'agent',
      });
      const terminal: TerminalInfo = {
        id: `term-${session.id}`,
        projectId: project.id,
        sessionId: session.id,
        kind: 'native',
        title: backendId,
        persistent: true,
        epoch: 1,
        cols: 80,
        rows: 24,
        createdAt: new Date().toISOString(),
        state: 'running',
      };
      store.saveTerminal(terminal);
      const bound = store.updateSession(session.id, { terminalId: terminal.id, state: 'running' });
      await service.ensure(bound);

      const activeRun = store.acceptNativeRun(bound.id, `active-${backendId}`, { text: 'running turn', attachmentIds: [], context: [] }, { mode: 'agent' });
      store.transitionNativeRun(activeRun.id, ['queued'], {
        delivery: 'observed',
        nativeSessionId,
        nativeTurnId: turnId,
        terminalId: terminal.id,
        terminalEpoch: terminal.epoch,
        timings: { busyAt: Date.now() },
      }, { state: 'running' });
      const queuedRun = store.acceptNativeRun(bound.id, `queued-${backendId}`, { text: 'queued follow-up', attachmentIds: [], context: [] }, { mode: 'agent' });
      const runs: Run[] = [store.getRun(activeRun.id), store.getRun(queuedRun.id)];
      const status: NativeStatus = { phase: 'busy', activeTurn: { nativeSessionId, turnId, ownerRunId: activeRun.id } };
      const capabilities = await service.catalog.capabilitiesFor(backendId);
      const snapshot = buildSessionControlSnapshot({
        revision: 1,
        session: bound,
        status,
        queue: { next: queuedRun.id, held: { reason: 'turn_running', runId: activeRun.id } },
        runs,
        capabilities,
      });
      return { session: bound, terminal, activeRun: store.getRun(activeRun.id), queuedRun: store.getRun(queuedRun.id), status, snapshot };
    };

    const caseA = await makeRunningCase('antigravity', 'agy-chat-1', 'agy-turn-1');
    const caseB = await makeRunningCase('claude', 'claude-chat-1', 'claude-turn-1');

    // Control snapshot matrix: both support plain stop, only Class B supports send_now.
    expect(caseA.snapshot.activeTurn?.canStop).toBe(true);
    expect(caseA.snapshot.capabilities.canStop).toBe(true);
    expect(caseA.snapshot.capabilities.canSendNow).toBe(false);
    expect(caseA.snapshot.inbox.find(item => item.id === caseA.queuedRun.id)?.actions).not.toContain('send_now');

    expect(caseB.snapshot.activeTurn?.canStop).toBe(true);
    expect(caseB.snapshot.capabilities.canStop).toBe(true);
    expect(caseB.snapshot.capabilities.canSendNow).toBe(true);
    expect(caseB.snapshot.inbox.find(item => item.id === caseB.queuedRun.id)?.actions).toContain('send_now');

    // Real NativeDispatcher verification for Class A (supportsTargetedStop: false):
    // 1. Plain interrupt succeeds, dispatches without expectedStop, and settles run as interrupted.
    classA.setStatus(caseA.session.id, caseA.status);
    const plainStop = {
      requestId: 'stop-a-plain',
      nativeSessionId: 'agy-chat-1',
      turnId: 'agy-turn-1',
      terminalId: caseA.terminal.id,
      terminalEpoch: caseA.terminal.epoch,
    };
    const settledPlain = await dispatcher.interrupt(caseA.session.id, plainStop);
    expect(classA.interruptCalls).toHaveLength(1);
    expect(classA.interruptCalls[0]?.expectedStop).toBeUndefined();
    expect(settledPlain).toMatchObject({
      id: caseA.activeRun.id,
      state: 'interrupted',
      native: { delivery: 'cancelled', stage: 'interrupted' },
    });

    // 2. interruptAndSend rejects with TARGETED_STOP_UNSUPPORTED, writes no pending receipt,
    //    and a subsequent plain interrupt (even reusing the same requestId) still stops cleanly.
    const caseA2 = await makeRunningCase('antigravity', 'agy-chat-2', 'agy-turn-2');
    classA.interruptCalls.length = 0;
    classA.setStatus(caseA2.session.id, caseA2.status);
    const targetedStop = {
      requestId: 'stop-a-targeted',
      nativeSessionId: 'agy-chat-2',
      turnId: 'agy-turn-2',
      terminalId: caseA2.terminal.id,
      terminalEpoch: caseA2.terminal.epoch,
    };
    await expect(
      dispatcher.interruptAndSend(
        caseA2.session.id,
        'replacement-cmd',
        () => store.acceptNativeRun(caseA2.session.id, 'replacement-cmd', { text: 'replace', attachmentIds: [], context: [] }, { mode: 'agent' }),
        targetedStop,
        'fp-replace',
      ),
    ).rejects.toMatchObject({ code: 'TARGETED_STOP_UNSUPPORTED' });

    expect(classA.interruptCalls).toHaveLength(0);
    expect(store.getSetting<Record<string, unknown>>(`native-stops:${caseA2.session.id}`, {})).toEqual({});
    expect(store.findRunByCommand(caseA2.session.id, 'replacement-cmd')).toBeUndefined();

    const settledAfterRejection = await dispatcher.interrupt(caseA2.session.id, targetedStop);
    expect(classA.interruptCalls).toHaveLength(1);
    expect(classA.interruptCalls[0]?.expectedStop).toBeUndefined();
    expect(settledAfterRejection).toMatchObject({
      id: caseA2.activeRun.id,
      state: 'interrupted',
      native: { delivery: 'cancelled', stage: 'interrupted' },
    });
  });

  it('validates slash command advertisements across all drivers and prevents Antigravity TUI-only leaks', async () => {
    const { registry, service } = await createFullBackendHarness();

    for (const driver of registry.list()) {
      const profile = service.catalog.validateProfile(driver.id);
      const capabilities = await service.catalog.driverCapabilities(driver, profile);
      for (const item of capabilities.slashCommands ?? []) {
        expect(typeof item.name, `${driver.id}: slash command name must be a string`).toBe('string');
        expect(item.name.trim().length, `${driver.id}: slash command name must be non-empty`).toBeGreaterThan(0);
        expect(item.name.startsWith('/'), `${driver.id}: slash command "${item.name}" must not have a leading /`).toBe(false);
      }
    }

    const agyCapabilities = await service.catalog.capabilitiesFor('antigravity');
    const agySlashNames = (agyCapabilities.slashCommands ?? []).map(item => item.name);
    for (const tuiPanelCommand of ['model', 'clear', 'resume', 'rewind']) {
      expect(agySlashNames, `antigravity must not advertise TUI-panel command "${tuiPanelCommand}"`).not.toContain(tuiPanelCommand);
    }
  });

  it('prunes wakeup/schedule tools when delegations=false while always preserving read_context as MCP readiness probe', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-conformance-mcp-'));
    const store = new Store(':memory:');
    cleanups.push(async () => {
      store.close();
      await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const project = store.createProject(join(stateDir, 'workspace'), 'MCP Conformance');
    let assistantSystemProject: ReturnType<Store['createProject']> | undefined;
    const team = new AgentTeamService({
      store,
      stateDir,
      defaultProject: () => (assistantSystemProject ??= store.updateProject(store.createProject(join(stateDir, 'assistant'), 'Assistant').id, { system: 'assistant' })),
      defaultInstructions: () => ({ text: '', custom: false }),
    });
    const member = await team.create({
      name: 'Read-only Project Member',
      scope: { kind: 'project', projectIds: [project.id] },
      capabilities: { delegations: false },
    });

    const session = store.createSession({
      projectId: project.id,
      kind: 'native',
      backendId: 'antigravity',
      agentMemberId: member.id,
      mode: 'agent',
    });

    const mcp = new RiffetMcpService({
      store,
      team: () => team,
      auth: { device: () => undefined } as never,
      credentials: {} as never,
      notices: {} as never,
      orchestration: () => { throw new Error('unused'); },
      devices: {} as never,
      workspace: {} as never,
    });

    const toolNames = mcp.tools(session).map(tool => tool.name);
    expect(toolNames).toContain('read_context');
    for (const pruned of ['list_wakeups', 'schedule_wakeup', 'cancel_wakeup', 'schedule_task']) {
      expect(toolNames, `delegations=false member session must not expose ${pruned}`).not.toContain(pruned);
    }
  });
});
