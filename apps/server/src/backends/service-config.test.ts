import { afterEach, describe, expect, it } from 'vitest';
import type { ModelInfo, NativeInteraction, NativeRunConfig, Run, Session } from '../../../../packages/contracts/src/index.js';
import type { Store } from '../store.js';
import type { NativeBackendDriver, NativeBackendProfileConfig as ProfileConfig } from './types.js';
import { NativeBackendService } from './service.js';

/**
 * One rule, pinned here: a queued message is delivered under the settings in effect when it starts,
 * not under the snapshot it was accepted with.
 *
 * DSH's own agent layer resolves a message's model when its step is assembled (`followup()` queues
 * the prompt, `installModelSelection` reads the live selection), so a switch made while a message
 * waited governs it. The run keeps what was accepted as `config`; what it was really delivered with
 * is what the fence records as `resolvedConfig`.
 */

const project = { id: 'project-a', cwd: '/srv/home/me/project', name: 'project' };

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 'session-a', projectId: 'project-a', kind: 'native', backendId: 'dsh',
    state: 'idle', title: 'conversation', tags: [], mode: 'agent', model: 'old-model', approval: 'allowlist',
    ...patch,
  } as Session;
}

function run(config: NativeRunConfig): Run {
  return {
    id: 'run-a', sessionId: 'session-a', commandId: 'command-a', prompt: 'queued while the settings changed',
    state: 'queued', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    native: {
      input: { text: 'queued while the settings changed', attachmentIds: [], context: [] },
      config, fingerprint: 'fingerprint-a', delivery: 'queued', attempt: 0,
    },
  } as unknown as Run;
}

const services: NativeBackendService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.closeAll().catch(() => undefined); });

function harness() {
  let current = session();
  let currentRun = run({ model: 'old-model', mode: 'agent', approval: 'allowlist' });
  const delivered: NativeRunConfig[] = [];
  const publishedSessions: Session[] = [];
  const driver = {
    id: 'dsh',
    label: 'Test backend',
    profiles: () => [{ id: 'local', backendId: 'dsh', name: 'Local', isDefault: true, config: {} }] as ProfileConfig[],
    capabilities: () => ({
      backendId: 'dsh', label: 'Test backend', modes: [], permissions: [], interactionTransport: 'protocol',
      supportsResume: true, supportsInterrupt: true, supportsHistory: true,
      supportsModelSelection: true, supportsModeSelection: false, supportsPermissionSelection: false,
    }),
    status: () => ({ phase: 'idle' as const }),
    subscribe: () => () => undefined,
    snapshot: async () => ({ events: [], status: { phase: 'idle' as const } }),
    send: async (_host: unknown, request: { config: NativeRunConfig }) => { delivered.push(request.config); },
  } as unknown as NativeBackendDriver;
  const store = {
    getSession: () => current,
    updateSession: (_id: string, patch: Partial<Session>) => (current = { ...current, ...patch }),
    bumpConfig: (_id: string, patch: Partial<Session>) => (current = { ...current, ...patch, configRevision: (current.configRevision ?? 0) + 1 }),
    appendEvent: (_id: string, type: string, data: { session?: Session }) => { if (type === 'session' && data.session) publishedSessions.push(data.session); },
    listTerminals: () => [],
    getProject: () => project,
    getRun: () => currentRun,
    transaction: <T>(operation: () => T): T => operation(),
    transitionNativeRun: (_id: string, _expected: string[], nativePatch: Record<string, unknown>, runPatch: Partial<Run> = {}) => {
      currentRun = { ...currentRun, ...runPatch, native: { ...currentRun.native!, ...nativePatch } } as Run;
      return currentRun;
    },
  } as unknown as Store;
  const service = new NativeBackendService({
    store,
    workspace: {} as never,
    terminal: {} as never,
    runtime: { withSession: async <T>(_id: string, operation: () => Promise<T> | T) => await operation() } as never,
    registry: { require: () => driver } as never,
  });
  services.push(service);
  return { service, driver, delivered, publishedSessions, accepted: () => currentRun, setRun: (value: Run) => { currentRun = value; }, switchTo: (patch: Partial<Session>) => { current = { ...current, ...patch }; } };
}

describe('NativeBackendService.models', () => {
  it('preserves provider capabilities for a parameterized current model without adding a duplicate', async () => {
    const h = harness();
    const model = 'opensource/deepseek_v4_1_flash';
    const selected = `${model}[effort=xhigh,context=1m]`;
    const declared: ModelInfo = {
      value: model, name: 'DeepSeek V4.1 Flash', contextWindow: 1048576,
      configOptions: [{ id: 'context', name: 'Context', type: 'select', currentValue: '1m', options: [{ value: 'default', name: 'Default' }, { value: '1m', name: '1M' }] }],
    };
    h.driver.profiles = () => [{ id: 'local', backendId: 'dsh', name: 'Local', isDefault: true, config: { enabledModels: [model, 'manual-model'] } }];
    h.driver.listModels = async () => [declared];
    const current = session({ model: selected });
    h.switchTo({ model: selected });
    expect(await h.service.models(current)).toEqual([declared, { value: 'manual-model', name: 'manual-model', configOptions: [] }]);
    expect(current.model).toBe(selected);
  });

  it('resolves provider aliases for enabled and current models without rewriting the session selection', async () => {
    const h = harness();
    const declared: ModelInfo = { value: 'Orange-O55', name: 'Orange-O55', aliases: ['openrouter-4o'], configOptions: [] };
    h.driver.profiles = () => [{ id: 'local', backendId: 'dsh', name: 'Local', isDefault: true, config: { enabledModels: ['openrouter-4o[effort=high]', 'manual-model'] } }];
    h.driver.listModels = async () => [declared];
    const current = session({ model: 'openrouter-4o[context=max]' });
    h.switchTo({ model: current.model });
    expect(await h.service.models(current)).toEqual([declared, { value: 'manual-model', name: 'manual-model', configOptions: [] }]);
    expect(current.model).toBe('openrouter-4o[context=max]');
  });
});

describe('NativeBackendService.configure', () => {
  it('does not advance the submission revision for repeated intent, while still applying pending runtime settings', async () => {
    const h = harness();
    h.switchTo({ model: 'selected-model', configRevision: 7 });
    let applied = 'old-model';
    const applications: string[] = [];
    h.driver.configure = async (_host, _session, _profile, patch) => {
      if (patch.model && patch.model !== applied) { applied = patch.model; applications.push(applied); }
      return patch;
    };
    for (const model of ['selected-model', 'selected-model']) {
      expect((await h.service.configure(h.service.host.getSession('session-a'), { model })).configRevision).toBe(7);
    }
    expect(applications).toEqual(['selected-model']);
    expect((await h.service.configure(h.service.host.getSession('session-a'), { model: 'new-model' })).configRevision).toBe(8);
    expect((await h.service.configure(h.service.host.getSession('session-a'), { model: 'new-model' })).configRevision).toBe(8);
    expect(applications).toEqual(['selected-model', 'new-model']);
    const stale = h.service.host.getSession('session-a');
    h.switchTo({ model: 'interleaved-model', configRevision: 9 });
    expect((await h.service.configure(stale, { model: 'new-model' })).configRevision).toBe(10);
  });

  // Moving to another provider keeps the native session only where both keep it in the same place.
  it('moves a conversation to a provider sharing its store, and refuses one that does not', async () => {
    const h = harness();
    h.switchTo({ backendProfileId: 'a', configRevision: 3, model: 'claude-opus-5-5[effort=high]' });
    h.driver.profiles = () => [
      { id: 'a', backendId: 'dsh', name: 'A', isDefault: true, config: { store: 'shared' } },
      { id: 'b', backendId: 'dsh', name: 'B', config: { store: 'shared' } },
      { id: 'c', backendId: 'dsh', name: 'C', config: { store: 'elsewhere' } },
    ] as ProfileConfig[];
    h.driver.continuationKey = profile => String(profile.config.store);
    const launchedOn: string[] = [];
    h.driver.configure = async (_host, _session, profile, patch) => { launchedOn.push(profile.id); return patch; };

    await expect(h.service.configure(h.service.host.getSession('session-a'), { backendProfileId: 'c', model: 'claude-opus-5-5' })).rejects.toMatchObject({ code: 'NATIVE_PROFILE_SWITCH_UNSUPPORTED' });
    // The transcript goes on within its model line, never to another one.
    await expect(h.service.configure(h.service.host.getSession('session-a'), { backendProfileId: 'b', model: 'opensource/deepseek_v4_1_flash' })).rejects.toMatchObject({ code: 'NATIVE_PROFILE_SWITCH_MODEL' });
    expect(launchedOn).toEqual([]);

    const moved = await h.service.configure(h.service.host.getSession('session-a'), { backendProfileId: 'b', model: 'claude-haiku-5-5' });
    expect(launchedOn).toEqual(['b']);
    expect(moved).toMatchObject({ backendProfileId: 'b', model: 'claude-haiku-5-5', configRevision: 4 });
  });

  it('offers and accepts only protocol-compatible providers within a shared store', async () => {
    const h = harness();
    h.switchTo({ backendProfileId: 'a', model: 'gpt-6-astra', nativeRuntime: { address: 'unix:///writer-a', fingerprint: 'writer-a', profileId: 'a' } });
    h.driver.profiles = () => ['a', 'b', 'c'].map(id => ({ id, backendId: 'dsh', name: id, isDefault: id === 'a', config: { store: 'shared' } }));
    h.driver.continuationKey = profile => String(profile.config.store);
    h.driver.canContinueProfile = (from, to, session) => from.id === 'a' && to.id === 'b' && session.nativeRuntime?.profileId === 'a';
    h.driver.available = async () => ({ available: true });
    const listed: string[] = [];
    h.driver.listModels = async (_host, _project, profile) => {
      listed.push(profile.id);
      return [{ value: 'gpt-6-astra', name: 'GPT', configOptions: [] }];
    };
    const applied: string[] = [];
    h.driver.configure = async (_host, _session, profile, patch) => { applied.push(profile.id); return patch; };
    const current = h.service.host.getSession('session-a');
    const catalog = await h.service.catalog.entry('dsh', project as never, undefined, current);
    expect(catalog.continuations?.map(item => item.profile.id)).toEqual(['b']);
    expect(listed).toEqual(['a', 'b']);
    await expect(h.service.configure(current, { backendProfileId: 'c', model: 'gpt-6-astra' })).rejects.toMatchObject({ code: 'NATIVE_PROFILE_SWITCH_UNSUPPORTED' });
    expect(applied).toEqual([]);
    expect((await h.service.configure(current, { backendProfileId: 'b', model: 'gpt-6-astra' })).backendProfileId).toBe('b');
    expect(applied).toEqual(['b']);
  });

  it('notifies deferred work after the target and revision are published, including repeated intent', async () => {
    const h = harness();
    h.switchTo({ backendProfileId: 'a', model: 'gpt-6-astra', configRevision: 3 });
    h.driver.profiles = () => ['a', 'b'].map(id => ({ id, backendId: 'dsh', name: id, isDefault: id === 'a', config: { store: 'shared' } }));
    h.driver.continuationKey = profile => String(profile.config.store);
    h.driver.configure = async (_host, _session, _profile, patch) => patch;
    const notices: Session[] = [];
    h.driver.afterConfigure = (host, saved, profile) => {
      expect(saved).toBe(host.getSession(saved.id));
      expect(saved).toMatchObject({ backendProfileId: profile.id, model: 'gpt-6-sol', configRevision: 4 });
      expect(h.publishedSessions.at(-1)).toBe(saved);
      notices.push(saved);
      // The request still succeeded if scheduling fails after its configuration was committed.
      if (notices.length === 2) throw new Error('scheduler unavailable');
    };
    const first = await h.service.configure(h.service.host.getSession('session-a'), { backendProfileId: 'b', model: 'gpt-6-sol' });
    const repeated = await h.service.configure(h.service.host.getSession('session-a'), { backendProfileId: 'b', model: 'gpt-6-sol' });
    expect(repeated).toBe(first);
    expect(notices).toEqual([first, repeated]);
    expect(h.publishedSessions).toEqual([first]);
  });
});

describe('NativeBackendService controls after a pending provider is deleted', () => {
  it('keeps the existing writer controllable and allows cancellation while new sends still reject the missing target', async () => {
    const h = harness();
    h.switchTo({
      backendProfileId: 'b', model: 'gpt-6-astra', nativeSessionId: 'thread-a', configPending: true,
      nativeRuntime: { address: 'unix:///writer-a', fingerprint: 'writer-a', profileId: 'a' },
    });
    h.driver.profiles = () => [{ id: 'a', backendId: 'dsh', name: 'A', isDefault: true, config: {} }];
    const routed: string[] = [];
    const checkRoute = (method: string, current: Session, profile: ProfileConfig) => {
      expect(current.backendProfileId).toBe('a');
      expect(profile.id).toBe('a');
      // Codex's status/control paths can resolve the profile again through the host.
      expect(h.service.host.getProfile?.(current).id).toBe('a');
      routed.push(method);
    };
    const approval: NativeInteraction = {
      id: 'approval-a', revision: '1', transport: 'protocol', kind: 'permission', title: 'Approve', options: [], actions: [],
    };
    h.driver.status = (_host, current, profile) => {
      checkRoute('status', current, profile);
      return { phase: 'busy', activeTurn: { nativeSessionId: 'thread-a', turnId: 'turn-a' } };
    };
    h.driver.interrupt = async (_host, current, profile, options) => {
      checkRoute('interrupt', current, profile);
      options?.beforeWrite?.();
    };
    h.driver.interaction = async (_host, current, profile) => { checkRoute('interaction', current, profile); return approval; };
    h.driver.respond = async (_host, current, profile) => { checkRoute('respond', current, profile); return { status: 'completed' }; };
    h.driver.extendInteraction = async (_host, current, profile) => { checkRoute('extend', current, profile); return approval; };
    h.driver.stopActivity = async (_host, current, profile) => {
      checkRoute('stopActivity', current, profile);
      return { id: 'background-a', kind: 'background_task', status: 'stopping', title: 'Task' };
    };
    h.driver.runtimeAction = async (_host, current, profile) => { checkRoute('runtimeAction', current, profile); };
    h.driver.available = async () => ({ available: true });
    h.driver.listModels = async (_host, _project, profile) => {
      expect(profile.id).toBe('a');
      return [{ value: 'gpt-6-astra', name: 'GPT', configOptions: [] }];
    };
    const current = h.service.host.getSession('session-a');
    expect(h.service.status(current.id).phase).toBe('busy');
    await h.service.interrupt(current.id, { expectedStop: { requestId: 'stop-a', nativeSessionId: 'thread-a', turnId: 'turn-a' } });
    expect(await h.service.interaction(current)).toBe(approval);
    expect(await h.service.respondInteraction(current, { interactionId: approval.id, revision: '1', requestId: 'answer-a', action: 'approve' })).toEqual({ status: 'completed' });
    expect(await h.service.extendInteraction(current, approval.id)).toBe(approval);
    expect((await h.service.stopActivity(current, 'background-a')).status).toBe('stopping');
    await h.service.runtimeAction(current.id, { action: 'control-a', revision: '1' });
    expect((await h.service.capabilities(current)).supportsModelSelection).toBe(true);
    const catalog = await h.service.catalog.entry('dsh', project as never, 'b', current);
    expect(catalog.models).toEqual([]);
    expect(catalog.continuations).toMatchObject([{ profile: { id: 'a' }, models: [{ value: 'gpt-6-astra' }] }]);
    expect(h.service.host.getSession(current.id)).toMatchObject({ backendProfileId: 'b', configPending: true });
    const accepted = h.accepted();
    await expect(h.service.sendRun(current, accepted, () => accepted)).rejects.toMatchObject({ code: 'NATIVE_PROFILE_NOT_FOUND' });
    expect(h.delivered).toEqual([]);
    await expect(h.service.configure(current, { model: 'gpt-6-astra' })).rejects.toMatchObject({ code: 'NATIVE_PROFILE_NOT_FOUND' });
    await expect(h.service.configure(current, { backendProfileId: 'b', model: 'gpt-6-astra' })).rejects.toMatchObject({ code: 'NATIVE_PROFILE_NOT_FOUND' });
    h.driver.configure = async (host, _session, profile, patch) => {
      expect(profile.id).toBe('a');
      host.updateSession(current.id, { configPending: false });
      return patch;
    };
    expect(await h.service.configure(current, { backendProfileId: 'a', model: 'gpt-6-astra' })).toMatchObject({ backendProfileId: 'a', configPending: false });
    expect(routed).toEqual(expect.arrayContaining(['interrupt', 'interaction', 'respond', 'extend', 'stopActivity', 'runtimeAction', 'status']));
  });

  it.each([
    { backendProfileId: 'a', configPending: false, actual: 'a' },
    { backendProfileId: 'b', configPending: true, actual: 'a' },
    { backendProfileId: 'b', configPending: false, actual: 'a' },
  ])('keeps deleted actual providers unavailable ($backendProfileId, pending $configPending)', async ({ backendProfileId, configPending, actual }) => {
    const h = harness();
    h.switchTo({ backendProfileId, configPending, nativeRuntime: { address: 'unix:///writer-a', fingerprint: 'writer-a', profileId: actual } });
    h.driver.profiles = () => [{ id: 'other', backendId: 'dsh', name: 'Other', isDefault: true, config: {} }];
    h.driver.interrupt = async () => { throw new Error('must not reach a deleted writer'); };
    await expect(h.service.interrupt('session-a')).rejects.toMatchObject({ code: 'NATIVE_PROFILE_NOT_FOUND' });
    await expect(h.service.configure(h.service.host.getSession('session-a'), { backendProfileId: 'a' })).rejects.toMatchObject({ code: 'NATIVE_PROFILE_NOT_FOUND' });
  });
});

describe('NativeBackendService.slashCatalog', () => {
  function catalogService(slashItems?: () => Promise<Array<{ name: string; kind: 'command' | 'skill'; description?: string }>>) {
    const driver = {
      id: 'claude',
      label: 'Test backend',
      profiles: () => [{ id: 'local', backendId: 'claude', name: 'Local', isDefault: true, config: {} }] as ProfileConfig[],
      capabilities: () => ({
        backendId: 'claude', label: 'Test backend', modes: [], permissions: [], interactionTransport: 'terminal',
        supportsResume: true, supportsInterrupt: true, supportsHistory: true,
        supportsModelSelection: false, supportsModeSelection: false, supportsPermissionSelection: false,
        slashCommands: [{ name: '/model', description: 'static' }, { name: 'permissions' }],
        inlineSkills: true,
      }),
      ...(slashItems ? { slashItems } : {}),
    } as unknown as NativeBackendDriver;
    const service = new NativeBackendService({
      store: {} as never, workspace: {} as never, terminal: {} as never,
      runtime: { withSession: async <T>(_id: string, operation: () => Promise<T> | T) => await operation() } as never,
      registry: { require: () => driver } as never,
    });
    services.push(service);
    return service;
  }

  it('lists built-ins first, lets a discovered entry describe a built-in, and caches the discovery', async () => {
    let calls = 0;
    const service = catalogService(async () => {
      calls += 1;
      return [{ name: 'model', kind: 'command', description: 'discovered' }, { name: 'dataviz', kind: 'skill' }, { name: 'dataviz', kind: 'skill', description: 'shadowed' }];
    });
    const catalog = await service.catalog.slashCatalog('claude', project as never);
    expect(catalog).toEqual({
      inlineSkills: true,
      items: [{ name: 'permissions', kind: 'command' }, { name: 'model', kind: 'command', description: 'discovered' }, { name: 'dataviz', kind: 'skill' }],
    });
    await service.catalog.slashCatalog('claude', project as never);
    expect(calls).toBe(1);
  });

  it('answers with the built-ins and a reason when discovery fails', async () => {
    const service = catalogService(async () => { throw new Error('probe failed'); });
    expect(await service.catalog.slashCatalog('claude', project as never)).toEqual({
      inlineSkills: true,
      reason: 'probe failed',
      items: [{ name: 'model', description: 'static', kind: 'command' }, { name: 'permissions', kind: 'command' }],
    });
  });
});

describe('NativeBackendService.sendRun', () => {
  it('delivers a queued message under the settings in effect now, not the ones it was accepted with', async () => {
    const { service, delivered, switchTo } = harness();
    const accepted = run({ model: 'old-model', mode: 'agent', approval: 'allowlist' });
    switchTo({ model: 'new-model', approval: 'never', configRevision: 1 });

    await service.sendRun(session({ model: 'new-model', approval: 'never', configRevision: 1 }), accepted, () => accepted);

    expect(delivered).toEqual([{ model: 'new-model', mode: 'agent', approval: 'never' }]);
    // The accepted snapshot stays untouched: it is the record of what the user submitted under.
    expect(accepted.native!.config).toEqual({ model: 'old-model', mode: 'agent', approval: 'allowlist' });
  });

  it('omits what the session does not name instead of resurrecting the accepted value', async () => {
    const { service, delivered } = harness();
    const accepted = run({ model: 'old-model', mode: 'agent', approval: 'allowlist' });

    // A session with neither a model nor an approval (a backend that resolves both itself) must not
    // inherit the accepted snapshot: `resolvedConfig` would then claim a route nobody asked for.
    await service.sendRun(session({ model: undefined, approval: undefined }), accepted, () => accepted);

    expect(delivered).toEqual([{ mode: 'agent' }]);
  });
});

/**
 * The fence is the last thing before a provider is touched. It used to refuse a run whose accepted
 * revision no longer matched the conversation; under the settings-in-effect rule it must instead let
 * the delivery through and record what the provider is really receiving.
 */
describe('NativeBackendService.commitDispatchFence', () => {
  it('lets a message whose settings moved in the queue through, and records what was delivered', () => {
    const { service, switchTo, accepted } = harness();
    switchTo({ model: 'new-model', approval: 'never', configRevision: 3 });

    const fenced = service.commitDispatchFence('run-a', {
      backendId: 'dsh',
      resolvedConfig: { model: 'new-model', mode: 'agent', approval: 'never' },
      nativeInputBoundary: JSON.stringify({ v: 1, leafId: 'native-leaf', lastEntryId: 'native-tail' }),
    });

    expect(fenced.native?.delivery).toBe('dispatching');
    expect(fenced.native?.resolvedConfig).toEqual({ model: 'new-model', mode: 'agent', approval: 'never' });
    expect(accepted().native?.nativeInputBoundary).toBe(JSON.stringify({ v: 1, leafId: 'native-leaf', lastEntryId: 'native-tail' }));
    // What the user submitted under is still on the run, untouched by the delivery.
    expect(fenced.native?.config).toEqual(accepted().native?.config);
  });
});


describe('NativeBackendService steer boundary', () => {
  function instruction() {
    const value = run({ mode: 'agent', model: 'original-model' });
    value.native = { ...value.native!, intent: 'steer', nativeSessionId: 'thread-1', nativeTurnId: 'turn-1', delivery: 'preparing' };
    return value;
  }

  it('dispatches to the explicit method with the immutable target and original configuration', async () => {
    const h = harness();
    const capabilities = h.driver.capabilities.bind(h.driver);
    h.driver.capabilities = async (host, profile) => ({ ...await capabilities(host, profile), supportsSteer: true });
    const accepted = instruction();
    let delivered: unknown;
    h.driver.steer = async (_host, request) => { delivered = request; };
    h.switchTo({ nativeSessionId: 'thread-1', model: 'next-model' });
    const current = session({ nativeSessionId: 'thread-1', model: 'next-model' });
    expect(await h.service.supportsSteer(current)).toBe(true);
    await h.service.steerRun(current, accepted, () => accepted);
    expect(delivered).toMatchObject({ target: { nativeSessionId: 'thread-1', turnId: 'turn-1' }, config: { mode: 'agent', model: 'original-model' } });
    expect(h.delivered).toHaveLength(0);
  });

  it('never rebinds a durable steer target at the external write fence', () => {
    const h = harness();
    const accepted = instruction(); h.setRun(accepted);
    h.switchTo({ nativeSessionId: 'thread-1' });
    expect(() => h.service.commitDispatchFence(accepted.id, { nativeSessionId: 'thread-1', nativeTurnId: 'turn-2' })).toThrow(expect.objectContaining({ code: 'STEER_TARGET_CHANGED' }));
    expect(h.accepted().native!.delivery).toBe('preparing');
    const fenced = h.service.commitDispatchFence(accepted.id, { nativeSessionId: 'thread-1', nativeTurnId: 'turn-1', ownerRunId: 'owner', resolvedConfig: { model: 'original-model', mode: 'agent' } });
    expect(fenced.native).toMatchObject({ delivery: 'dispatching', nativeSessionId: 'thread-1', nativeTurnId: 'turn-1', ownerRunId: 'owner', resolvedConfig: { model: 'original-model' } });
  });
});


it('keeps global model, usage and skill queries separate from project caches without opening a session', async () => {
  const {service,driver}=harness();
  const scopes:unknown[]=[];
  driver.available=async()=>({available:true});
  driver.listModels=async(_host,context)=>{scopes.push(context);return [{value:context?'project-model':'global-model',name:'Model',configOptions:[]}];};
  driver.usage=async(_host,context)=>({models:{},fetchedAt:context?'project':'global'});
  driver.slashItems=async(_host,context)=>[{name:context?'project-skill':'global-skill',kind:'skill'}];
  driver.openOrResume=async()=>{throw new Error('A management query must not open a session');};
  expect((await service.catalog.entry('dsh',undefined)).models[0]?.value).toBe('global-model');
  expect((await service.catalog.entry('dsh',project as never)).models[0]?.value).toBe('project-model');
  expect((await service.catalog.entry('dsh',undefined)).models[0]?.value).toBe('global-model');
  expect(scopes).toEqual([undefined,project]);
  expect((await service.catalog.usage('dsh',undefined))?.fetchedAt).toBe('global');
  expect((await service.catalog.usage('dsh',project as never))?.fetchedAt).toBe('project');
  expect((await service.catalog.slashCatalog('dsh',undefined)).items[0]?.name).toBe('global-skill');
  expect((await service.catalog.slashCatalog('dsh',project as never)).items[0]?.name).toBe('project-skill');
});
