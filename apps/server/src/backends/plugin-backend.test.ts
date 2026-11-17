import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Plugin } from '@riffet/plugin-api';
import { AGENT_PROTOCOL_VERSION, type AgentBackend, type AgentEvent, type AgentHost, type AgentTraits } from '@riffet/plugin-api/experimental/agent';
import type { NativeWorkbenchEvent, Run } from '../../../../packages/contracts/src/index.js';
import { SessionLock } from '../agent-host/session-lock.js';
import { PluginRegistry } from '../plugins/registry.js';
import { laneKey } from '../journal/journal.js';
import { Store } from '../store.js';
import { StatsLedger } from '../stats/ledger.js';
import { TranscriptIngest } from '../sync/ingest.js';
import { isWarmupTerminal } from '../terminal/service.js';
import { PluginBackendDriver } from './plugin-backend.js';
import { PluginBackends } from './plugin-backends.js';
import { NativeBackendRegistry } from './registry.js';
import { NativeBackendService } from './service.js';
import type { NativeBackendHost } from './types.js';
import { provideModelSources } from './shared/model-source.js';

/**
 * An Agent backend from a plugin, driven through the real adapter, registry, service and journal: the
 * plugin below is the whole of its "agent", an in-memory conversation.
 */

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const at = '2026-11-01T00:00:00.000Z';

/** Declares `pi`, the reused enum value; the test's own backend registry holds no core driver of that id. */
function memoryPlugin(traits?: AgentTraits) {
  const calls: string[] = [];
  const history: AgentEvent[] = [];
  const hosts: AgentHost[] = [];
  const backend: AgentBackend = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    id: 'test.agent',
    label: 'Memory agent',
    readOnlyHistory: true,
    ...(traits ? { traits } : {}),
    profiles: () => [{ id: 'default', name: 'Memory', isDefault: true, config: {} }],
    capabilities: () => ({ modes: [{ id: 'agent', label: 'Agent' }], permissions: [], interactionTransport: 'none', supportsResume: true, supportsInterrupt: false, supportsHistory: true, supportsModelSelection: false, supportsModeSelection: false, supportsPermissionSelection: false }),
    available: async () => ({ available: true }),
    async open(host, { session }) {
      calls.push('open');
      hosts.push(host);
      return { nativeSessionId: session.nativeSessionId ?? 'native-1', status: { phase: 'idle' } };
    },
    observe(host, { session }) {
      calls.push('observe');
      host.emit(session.id, { type: 'status', status: { phase: 'idle', model: 'memory' } });
      return () => { calls.push('unobserve'); };
    },
    async send(host, request) {
      calls.push(`send:${request.input.text}`);
      await host.commitDispatchFence(request.runId, { nativeSessionId: 'native-1', renderedText: request.input.text });
      history.push(
        { type: 'user_message_chunk', nativeId: 'm1', nativeTurnId: 't1', createdAt: at, data: { commandId: request.commandId, content: { type: 'text', text: request.input.text } } },
        { type: 'agent_message_chunk', nativeId: 'm2', nativeTurnId: 't1', createdAt: at, data: { content: { type: 'text', text: `echo: ${request.input.text}` } } },
      );
      // Told of rather than asked for: written through the host, beside what `transcript` reads.
      await host.transcript.ingest(request.context.session.id, { events: [{ type: 'agent_thought_chunk', nativeId: 'm3', nativeTurnId: 't1', createdAt: at, data: { content: { type: 'text', text: 'thinking' } } }], cursor: null, caughtUp: true });
      return { state: 'accepted', nativeTurnId: 't1' };
    },
    transcript: () => ({
      read: async ({ cursor }) => ({
        events: history.slice(Number(cursor ?? 0)),
        turns: history.length ? [{ edge: 'ended', turnId: 't1', at, status: 'completed' }] : [],
        cursor: String(history.length), caughtUp: true,
      }),
    }),
    readHistory: async () => ({ events: [...history], subagents: [] }),
    detach: (_host, sessionId) => { calls.push(`detach:${sessionId}`); },
    stop: () => { calls.push('stop'); },
    start: (_host, profile) => { calls.push(`start:${profile.id}`); },
  };
  const plugin: Plugin = {
    manifest: { id: 'test.agent', vendor: 'Test', name: 'agent', apiVersion: 1, defaultEnabled: false, contributes: { agentBackends: [{ id: 'test.agent', title: { en: 'Memory agent' } }] } },
    activate: () => ({ agentBackends: [backend] }),
  };
  return { plugin, calls, backend, hosts };
}

async function build(plugin: Plugin, workspace: object = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'riffet-plugin-backend-'));
  const store = new Store(':memory:');
  const plugins = new PluginRegistry({ stateDir: directory, plugins: [plugin], developmentPackages: [] });
  const registry = new NativeBackendRegistry();
  const service = new NativeBackendService({ store, terminal: { listWarmups: async () => store.listTerminals().filter(isWarmupTerminal) } as never, workspace: workspace as never, runtime: new SessionLock(), registry });
  const ingest = new TranscriptIngest({ journal: store.journal, source: id => service.transcriptSource(id) });
  service.attachIngest(ingest);
  const backends = new PluginBackends({ plugins, registry, service });
  backends.start();
  cleanups.push(async () => { backends.close(); await service.closeAll(); ingest.close(); await plugins.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const project = store.createProject('/tmp/riffet-plugin-backend', 'plugin');
  const session = store.createSession({ projectId: project.id, kind: 'native', backendId: 'test.agent', mode: 'agent' });
  return { store, plugins, registry, service, session };
}

describe('an Agent backend from a plugin', () => {
  it('isolates durable observations and releases subscriptions when its host is revoked', async () => {
    const plugin = memoryPlugin();
    const { store, plugins, service, session } = await build(plugin.plugin);
    const ledger = new StatsLedger(store);
    cleanups.push(() => ledger.close());
    service.host.stats = ledger;
    await plugins.update('test.agent', { enablement: 'on' });
    await service.ensure(session);
    const host = plugin.hosts[0]!;
    const foreign = store.createSession({ projectId: session.projectId, kind: 'native', backendId: 'codex' });
    const otherRun = store.acceptNativeRun(foreign.id, 'foreign-stats', { text: 'x', attachmentIds: [], context: [] }, { mode: 'agent' });
    const observation = { nativeSessionId: 'native', nativeTurnId: 'turn', requestId: 'request', scope: 'agent-turn' as const,
      agentKind: 'main' as const, startedAt: 1_000, endedAt: 2_000, status: 'completed' as const,
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    const listener = vi.fn();
    const unsubscribe = host.stats.subscribeObservations!(listener);
    expect(() => host.stats.recordObservation!(foreign.id, undefined, observation)).toThrow(expect.objectContaining({ code: 'AGENT_SESSION_FOREIGN' }));
    expect(() => host.stats.recordObservation!(session.id, otherRun.id, observation)).toThrow(expect.objectContaining({ code: 'AGENT_SESSION_FOREIGN' }));
    ledger.recordObservation(foreign.id, otherRun.id, observation);
    expect(listener).not.toHaveBeenCalled();
    expect(host.stats.recordObservation!(session.id, undefined, observation)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    const ownObservations = await host.stats.readObservations!();
    expect(ownObservations).toHaveLength(1);
    expect(ownObservations[0]?.backendId).toBe('test.agent');

    // Disabling while a snapshot is in flight must still refuse its eventual result.
    let finishRead!: (value: typeof ownObservations) => void;
    vi.spyOn(ledger, 'readObservations').mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    const pending = host.stats.readObservations!();
    await plugins.update('test.agent', { enablement: 'off' });
    finishRead(ownObservations);
    await expect(pending).rejects.toMatchObject({ code: 'AGENT_HOST_REVOKED' });
    await expect(host.stats.readObservations!()).rejects.toMatchObject({ code: 'AGENT_HOST_REVOKED' });
    expect(() => host.stats.subscribeObservations!(listener)).toThrow(expect.objectContaining({ code: 'AGENT_HOST_REVOKED' }));
    ledger.recordObservation(session.id, undefined, { ...observation, nativeTurnId: 'later' });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe(); // Cleanup handles remain safe after revocation.
  });

  it('runs a session through the adapter and, once turned off, keeps its history readable but refuses new work', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const plugin = memoryPlugin();
    const { store, plugins, registry, service, session } = await build(plugin.plugin);
    const received: NativeWorkbenchEvent[] = [];
    service.watchEvents(session.id, event => received.push(event));

    // Off: no driver, and the reason says why.
    expect(registry.get('test.agent')).toBeUndefined();
    await expect(service.ensure(session)).rejects.toMatchObject({ code: 'NATIVE_BACKEND_UNAVAILABLE', statusCode: 503, details: { backendId: 'test.agent', reason: 'plugin test.agent is off' } });

    await plugins.update('test.agent', { enablement: 'on' });
    expect(registry.ownerOf('test.agent')).toBe('test.agent');

    // Open, then send: the fence is committed through the run's own closure, and acceptance reaches the dispatcher as a receipt.
    const opened = await service.ensure(session);
    expect(opened.nativeSessionId).toBe('native-1');
    expect(store.getSession(session.id).nativeSessionId).toBe('native-1');
    const control = service.watchControl(session.id, () => undefined);
    expect(control.status()).toMatchObject({ phase: 'idle', model: 'memory' });
    const run = store.acceptNativeRun(session.id, 'cmd-1', { text: 'hello', attachmentIds: [], context: [] }, { mode: 'agent' });
    store.transitionNativeRun(run.id, ['queued'], { delivery: 'preparing' });
    await service.sendRun(store.getSession(session.id), run, binding => service.commitDispatchFence(run.id, binding));
    expect(store.getRun(run.id).native).toMatchObject({ delivery: 'dispatching', renderedText: 'hello', nativeSessionId: 'native-1' });
    expect(received).toContainEqual(expect.objectContaining({ type: 'native_input_receipt', runId: run.id, data: expect.objectContaining({ commandId: 'cmd-1' }) }));

    // Output observation: the plugin's transcript lands in the journal, then the history read.
    await service.drainTranscript(session.id);
    const rows = store.journal.range(laneKey(session.id, 'main'), 0, 50).map(row => row.nativeId);
    expect(rows).toEqual(expect.arrayContaining(['m1', 'm2', 'm3', 'meta:turn:t1:ended']));
    expect((await service.readShareTranscript(session.id)).events.map(event => event.nativeId)).toEqual(['m1', 'm2']);

    // Turned off: new sessions and deliveries stop, reads carry on without the plugin, observation is detached and nothing is killed.
    await plugins.update('test.agent', { enablement: 'off' });
    expect(registry.get('test.agent')).toBeUndefined();
    const sends = plugin.calls.filter(call => call.startsWith('send:')).length;
    const next = store.acceptNativeRun(session.id, 'cmd-2', { text: 'again', attachmentIds: [], context: [] }, { mode: 'agent' });
    await expect(service.sendRun(store.getSession(session.id), next, () => next)).rejects.toMatchObject({ code: 'NATIVE_BACKEND_UNAVAILABLE', statusCode: 503 });
    await expect(service.ensure(store.getSession(session.id))).rejects.toMatchObject({ code: 'NATIVE_BACKEND_UNAVAILABLE' });
    expect(plugin.calls.filter(call => call.startsWith('send:')).length).toBe(sends);
    expect(service.transcriptSource(session.id)).toBeUndefined();
    expect(store.journal.range(laneKey(session.id, 'main'), 0, 50).map(row => row.nativeId)).toEqual(expect.arrayContaining(['m1', 'm2']));
    expect(await service.indexableTranscript(session.id)).toEqual([]);
    expect(await service.interaction(store.getSession(session.id))).toBeUndefined();
    expect(service.watchControl(session.id, () => undefined).status()).toMatchObject({ phase: 'offline', connection: { state: 'failed', message: expect.stringContaining('test.agent is off') } });
    await expect(service.readShareTranscript(session.id)).rejects.toMatchObject({ code: 'NATIVE_BACKEND_UNAVAILABLE' });
    await vi.waitFor(() => expect(plugin.calls).toContain(`detach:${session.id}`));
    expect(plugin.calls).toContain('unobserve');
    expect(plugin.calls).not.toContain('stop');

    // Back on: a new activation registers a fresh driver.
    await plugins.update('test.agent', { enablement: 'on' });
    expect(registry.get('test.agent')).toBeDefined();
    expect(await service.readShareTranscript(session.id)).toMatchObject({ events: expect.any(Array) });
  });

  it('offers a model source to a plugin Agent by the gateway protocol it consumes, whatever its id', async () => {
    const asked: string[] = [];
    const gateway = (id: string, served: { protocols?: readonly string[]; backends?: Array<'claude' | 'codex'> }) => ({
      id, label: id, ...served, resolve: () => ({}), catalog: async (backend?: string) => { asked.push(`${id}:${backend}`); return [{ value: 'm1', name: 'M1', configOptions: [] }]; },
    });
    provideModelSources(() => [gateway('responses-gw', { protocols: ['openai-responses'] }), gateway('older-gw', { backends: ['codex'] }), gateway('messages-gw', { protocols: ['anthropic-messages'] })]);
    cleanups.push(() => provideModelSources(() => []));

    const consuming = await build(memoryPlugin({ consumesProtocols: ['openai-responses'] }).plugin);
    await consuming.plugins.update('test.agent', { enablement: 'on' });
    expect((await consuming.service.catalog.capabilitiesFor('test.agent')).consumesProtocols).toEqual(['openai-responses']);
    expect(consuming.service.catalog.consumesProtocols('test.agent')).toEqual(['openai-responses']);
    // A source that serves the protocol answers, one that declares only the older `backends` included; one that serves another does not.
    expect((await consuming.service.catalog.probeModels('test.agent', { modelSource: 'responses-gw' })).map(model => model.value)).toEqual(['m1']);
    expect((await consuming.service.catalog.probeModels('test.agent', { modelSource: 'older-gw' })).map(model => model.value)).toEqual(['m1']);
    await expect(consuming.service.catalog.probeModels('test.agent', { modelSource: 'messages-gw' })).rejects.toMatchObject({ code: 'NATIVE_MODEL_PROBE_FAILED' });
    expect(asked).toEqual(['responses-gw:codex', 'older-gw:codex']);

    const bare = await build(memoryPlugin().plugin);
    await bare.plugins.update('test.agent', { enablement: 'on' });
    expect((await bare.service.catalog.capabilitiesFor('test.agent')).consumesProtocols).toEqual([]);
    await expect(bare.service.catalog.probeModels('test.agent', { modelSource: 'responses-gw' })).rejects.toMatchObject({ code: 'INVALID_BACKEND_PROFILE' });
  });

  it('hands a plugin Agent the wire address of the model source on its own profile, over a protocol the source serves, and no more', async () => {
    const source = (id: string, resolved: object, served: readonly string[] = ['openai-responses']) => ({ id, label: id, protocols: served, resolve: () => resolved, catalog: async () => [] });
    provideModelSources(() => [
      source('gw', { endpoints: { 'openai-responses': { baseUrl: 'https://gw.example/v1', headers: { 'x-a': '1' } } }, credential: { kind: 'static', key: 'k1' } }),
      source('older', { codexBaseUrl: 'https://older.example/v1', headers: { codex: { 'x-b': '2' } }, credential: { kind: 'static', key: 'k2' } }),
      source('helper', { codexBaseUrl: 'https://helper.example/v1', credential: { kind: 'command', command: '/bin/sh', args: [] } }),
      source('down', { reason: 'signed out' }),
      source('chat-only', { endpoints: { 'openai-chat': { baseUrl: 'https://chat.example/v1' } } }, ['openai-chat']),
    ]);
    cleanups.push(() => provideModelSources(() => []));
    const plugin = memoryPlugin({ consumesProtocols: ['openai-responses'] });
    plugin.backend.profiles = () => ['gw', 'older', 'helper', 'down', 'chat-only', undefined].map((modelSource, index) => ({ id: `p${index}`, name: `p${index}`, config: modelSource ? { modelSource } : {} }));
    const { plugins, service, session } = await build(plugin.plugin);
    await plugins.update('test.agent', { enablement: 'on' });
    await service.ensure(session);
    const { modelSources } = plugin.hosts[0]!;
    expect(await modelSources.resolve('p0', 'openai-responses')).toEqual({ baseUrl: 'https://gw.example/v1', headers: { 'x-a': '1' }, credential: { kind: 'static', key: 'k1' } });
    // A source that names only the older members answers through the same mapping.
    expect(await modelSources.resolve('p1', 'openai-responses')).toEqual({ baseUrl: 'https://older.example/v1', headers: { 'x-b': '2' }, credential: { kind: 'static', key: 'k2' } });
    // A key the source runs a command for is not data to hand over; the address still is.
    expect(await modelSources.resolve('p2', 'openai-responses')).toEqual({ baseUrl: 'https://helper.example/v1' });
    // Unavailable, another protocol, or no source on the profile: nothing.
    for (const profile of ['p3', 'p4', 'p5']) expect(await modelSources.resolve(profile, 'openai-responses'), profile).toBeUndefined();
    expect(await modelSources.resolve('p0', 'anthropic-messages')).toBeUndefined();
    // Only this Agent's own profiles.
    await expect(modelSources.resolve('cursor-profile', 'openai-responses')).rejects.toMatchObject({ code: 'AGENT_PROFILE_FOREIGN', statusCode: 403 });
  });

  it('gives a plugin its own records only, and the session run state only when it keeps it', async () => {
    const plugin = memoryPlugin();
    const { store, plugins, service, session } = await build(plugin.plugin);
    await plugins.update('test.agent', { enablement: 'on' });
    await service.ensure(session);
    const host = plugin.hosts[0]!;
    const base = { projectId: session.projectId, title: 't', persistent: true, epoch: 0, cols: 80, rows: 24, createdAt: at, state: 'running' as const };
    const foreign = store.createSession({ projectId: session.projectId, kind: 'native', backendId: 'codex', mode: 'agent' });
    store.saveTerminal({ ...base, id: 'own-terminal', kind: 'native', sessionId: session.id });
    store.saveTerminal({ ...base, id: 'foreign-terminal', kind: 'native', sessionId: foreign.id });
    const warmup = { ownerToken: 'owner', resourceKey: 'key', nativeSessionId: 'chat', expiresAt: Date.now() + 60_000 };
    store.saveTerminal({ ...base, id: 'own-reservation', kind: 'native', warmup: { ...warmup, backendId: 'test.agent' } } as never);
    store.saveTerminal({ ...base, id: 'foreign-reservation', kind: 'cursor', warmup: { ...warmup, backendId: 'cursor' } } as never);

    // Sessions and terminals of another agent are not there to read, and refused when named.
    await expect(host.session(foreign.id)).rejects.toMatchObject({ code: 'AGENT_SESSION_FOREIGN', statusCode: 403 });
    expect(host.view.session(foreign.id)).toBeUndefined();
    expect(host.view.sessions().map(item => item.id)).toEqual([session.id]);
    expect(host.view.terminals().map(item => item.id)).toEqual(['own-terminal']);
    expect(host.view.terminal('foreign-terminal')).toBeUndefined();
    expect(host.view.terminal('own-reservation')).not.toHaveProperty('warmup');
    await expect(host.terminals.get('foreign-terminal')).rejects.toMatchObject({ code: 'AGENT_SESSION_FOREIGN' });
    expect(() => host.terminals.observe('foreign-terminal', () => undefined)).toThrow(expect.objectContaining({ code: 'AGENT_SESSION_FOREIGN' }));
    await expect(host.terminals.interact('foreign-reservation', async () => undefined)).rejects.toMatchObject({ code: 'AGENT_SESSION_FOREIGN' });

    // A reservation is reachable by its own agent only; the list is narrowed the same way.
    await expect(host.terminals.releaseReservation('foreign-reservation', 'owner')).rejects.toMatchObject({ code: 'AGENT_SESSION_FOREIGN' });
    await expect(host.terminals.extendReservation('foreign-reservation', { ownerToken: 'owner', resourceKey: 'key', expiresAt: Date.now() + 1000 })).rejects.toMatchObject({ code: 'AGENT_SESSION_FOREIGN' });
    await expect(host.terminals.claim('own-reservation', { ownerToken: 'owner', resourceKey: 'key', sessionId: foreign.id })).rejects.toMatchObject({ code: 'AGENT_SESSION_FOREIGN' });
    expect((await host.terminals.reservations()).map(item => item.terminal.id)).toEqual(['own-reservation']);

    // Writes are visible to the synchronous view as soon as the call returns; the run state is not the plugin's to write here.
    const written = host.updateSession(session.id, { title: 'renamed' });
    expect(host.view.session(session.id)?.title).toBe('renamed');
    await written;
    await expect(host.updateSession(session.id, { state: 'running' })).rejects.toMatchObject({ code: 'AGENT_PATCH_REFUSED' });
    await expect(host.updateSession(session.id, { error: 'boom' })).rejects.toMatchObject({ code: 'AGENT_PATCH_REFUSED' });
    expect(store.getSession(session.id).state).not.toBe('running');
  });

  it('hands the readers of a conversation to the new driver when its plugin is turned off and on, and starts it once per activation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const plugin = memoryPlugin();
    const { plugins, service, session } = await build(plugin.plugin);
    const count = (call: string) => plugin.calls.filter(item => item === call).length;
    await plugins.update('test.agent', { enablement: 'on' });
    await vi.waitFor(() => expect(count('start:default')).toBe(1));
    await service.ensure(session);
    const first: string[] = [];
    const reader = service.watchControl(session.id, message => { if (message.type === 'status') first.push(message.status.phase); });
    expect(reader.status()).toMatchObject({ phase: 'idle', model: 'memory' });

    // Off: the reader is told, and the watch behind it is released.
    await plugins.update('test.agent', { enablement: 'off' });
    expect(first.at(-1)).toBe('offline');
    // A reader that opens while the plugin is away is recorded, and reads the journal meanwhile.
    const late: string[] = [];
    const waiting = service.watchControl(session.id, message => { if (message.type === 'status') late.push(message.status.phase); });
    expect(waiting.status()).toMatchObject({ phase: 'offline' });
    expect(count('unobserve')).toBe(1);

    // On again: both readers hear the new driver, with no watch left over from the first activation.
    await plugins.update('test.agent', { enablement: 'on' });
    await vi.waitFor(() => { expect(first.at(-1)).toBe('idle'); expect(late.at(-1)).toBe('idle'); });
    expect(count('start:default')).toBe(2);
    expect(count('observe') - count('unobserve')).toBe(1);
    expect(reader.status()).toMatchObject({ phase: 'idle', model: 'memory' });

    // Closing the last reader releases the one watch there is.
    reader.close(); waiting.close();
    expect(service.hasListeners(session.id)).toBe(false);
  });

  it('refuses every call of a turned-off plugin once it was released, and a plugin the runs and attachments of other agents', async () => {
    const plugin = memoryPlugin();
    const attachment = { id: 'att-1', name: 'a.txt', mimeType: 'text/plain', size: 1, path: '/tmp/a.txt' };
    const { store, plugins, service, session } = await build(plugin.plugin, { readAttachment: async () => ({ attachment, data: Buffer.from('x') }) });
    const reads: unknown[] = [];
    const send = plugin.backend.send.bind(plugin.backend);
    plugin.backend.send = async (host, request) => {
      reads.push(await host.readAttachment('att-1'), await host.readAttachment('att-2').catch((error: unknown) => error));
      return send(host, request);
    };
    await plugins.update('test.agent', { enablement: 'on' });
    await service.ensure(session);
    const host = plugin.hosts[0]!;
    const foreign = store.createSession({ projectId: session.projectId, kind: 'native', backendId: 'codex', mode: 'agent' });
    const other = store.acceptNativeRun(foreign.id, 'foreign-1', { text: 'x', attachmentIds: [], context: [] }, { mode: 'agent' });
    const own = store.acceptNativeRun(session.id, 'own-1', { text: 'hello', attachmentIds: ['att-1'], context: [] }, { mode: 'agent' });

    // Another agent's run is neither measured nor answered about; one of its own is.
    expect(() => host.stats.saveRunMetrics(other.id, { outputTokensPerSecond: 1 } as never)).toThrow(expect.objectContaining({ code: 'AGENT_SESSION_FOREIGN' }));
    await expect(host.isRunCancelled(other.id)).rejects.toMatchObject({ code: 'AGENT_SESSION_FOREIGN' });
    expect(() => host.stats.recordUsage(session.id, other.id, {} as never)).toThrow(expect.objectContaining({ code: 'AGENT_SESSION_FOREIGN' }));
    expect(await host.isRunCancelled(own.id)).toBe(false);
    // Only the attachments of the input being delivered can be named, and only while it is.
    await expect(host.readAttachment('att-1')).rejects.toMatchObject({ code: 'AGENT_SESSION_FOREIGN' });
    store.transitionNativeRun(own.id, ['queued'], { delivery: 'preparing' });
    await service.sendRun(store.getSession(session.id), own, binding => service.commitDispatchFence(own.id, binding));
    expect(reads[0]).toMatchObject({ attachment: { id: 'att-1' } });
    expect(reads[1]).toMatchObject({ code: 'AGENT_SESSION_FOREIGN' });

    // Turned off, and released: what a timer of that activation still holds writes and reads nothing.
    await plugins.update('test.agent', { enablement: 'off' });
    await expect(host.updateSession(session.id, { title: 'late' })).rejects.toMatchObject({ code: 'AGENT_HOST_REVOKED' });
    expect(() => host.emit(session.id, { type: 'status', status: { phase: 'idle' } })).toThrow(expect.objectContaining({ code: 'AGENT_HOST_REVOKED' }));
    expect(() => host.view.session(session.id)).toThrow(expect.objectContaining({ code: 'AGENT_HOST_REVOKED' }));
    expect(store.getSession(session.id).title).not.toBe('late');
  });

  it('counts a plugin that is starting as on its way, and stops once it has settled either way', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const plugin = memoryPlugin();
    const activate = plugin.plugin.activate;
    let failing = false;
    plugin.plugin.activate = async (host, scope) => { await gate; if (failing) throw new Error('boom'); return activate(host, scope); };
    const { plugins, service, session } = await build(plugin.plugin);
    // Not evaluated yet: it may still be provided.
    expect(service.backendPending('test.agent')).toBe(true);
    const starting = plugins.update('test.agent', { enablement: 'on' });
    await vi.waitFor(() => expect(service.backendPending('test.agent')).toBe(true));
    release();
    await starting;
    expect(service.backendPending('test.agent')).toBe(false);
    await service.ensure(session);
    // A failed activation is an answer: the work that waited gets the usual reason.
    failing = true;
    await plugins.update('test.agent', { enablement: 'off' });
    await plugins.update('test.agent', { enablement: 'on' });
    expect(service.backendPending('test.agent')).toBe(false);
    await expect(service.ensure(session)).rejects.toMatchObject({ code: 'NATIVE_BACKEND_UNAVAILABLE' });
  });

  it('lets a plugin that keeps the session run state write it', async () => {
    const plugin = memoryPlugin({ ownsSessionObservation: true });
    const { store, plugins, service, session } = await build(plugin.plugin);
    await plugins.update('test.agent', { enablement: 'on' });
    await service.ensure(session);
    await plugin.hosts[0]!.updateSession(session.id, { state: 'failed', error: 'boom' });
    expect(store.getSession(session.id)).toMatchObject({ state: 'failed', error: 'boom' });
  });

  it('refuses a plugin that contributes an Agent its manifest does not declare', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const plugin = memoryPlugin();
    plugin.plugin.manifest.contributes = { agentBackends: [] };
    const { plugins, registry } = await build(plugin.plugin);
    await plugins.update('test.agent', { enablement: 'on' });
    expect(registry.get('test.agent')).toBeUndefined();
    expect((await plugins.descriptors())[0]!.status).toMatchObject({ state: 'unavailable', message: expect.stringContaining('not declared in contributes.agentBackends') });
  });

  it('keeps the fence of a deferred steer open for its one commit, with the run it joins', async () => {
    const committed: unknown[] = [];
    let agent: AgentHost | undefined;
    const backend = { id: 'test.agent', label: 'Memory agent', steer: async (host: AgentHost) => { agent = host; return { deferred: true as const }; } } as unknown as AgentBackend;
    const driver = new PluginBackendDriver(backend, 'test.agent');
    const session = { id: 's', projectId: 'p', kind: 'native', backendId: 'test.agent', mode: 'agent', state: 'idle' };
    const request = {
      session, project: { id: 'p', name: 'p', cwd: '/tmp' }, profile: { id: 'default', backendId: 'test.agent', name: 'Memory', config: {} }, runId: 'run-1', commandId: 'c1',
      input: { text: 'guide', attachmentIds: [], context: [] }, config: {}, target: { nativeSessionId: 'chat', turnId: 'turn' },
      commitDispatchFence: (binding: unknown) => { committed.push(binding); return {} as Run; },
    };
    const host = { getSession: () => session, terminal: {}, withSessionLock: <T>(_id: string, operation: () => Promise<T>) => operation() } as unknown as NativeBackendHost;
    await expect(driver.steer!(host, request as never)).resolves.toEqual({ deferred: true });
    await agent!.commitDispatchFence('run-1', { nativeSessionId: 'chat', nativeTurnId: 'turn', ownerRunId: 'owner', renderedText: 'guide' });
    expect(committed).toEqual([expect.objectContaining({ backendId: 'test.agent', nativeTurnId: 'turn', ownerRunId: 'owner', renderedText: 'guide' })]);
    await expect(agent!.commitDispatchFence('run-1')).rejects.toMatchObject({ code: 'AGENT_RUN_UNKNOWN' });
  });
});
