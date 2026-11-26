import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createPairingCode } from '../pairing.js';
import type { ChannelConnection, ProviderRegistration, ChannelContext, ChannelProvider, InboundMessage, InteractionView, ModelPickerView, PanelView, ProjectPickerView } from './types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/** A provider that records what the core renders and lets the test play the platform. */
function fakeProvider() {
  const sent: string[] = [];
  const pickers: ProjectPickerView[] = [];
  const cards: InteractionView[] = [];
  const panels: PanelView[] = [];
  let context!: ChannelContext;
  const registrations: ProviderRegistration[] = [];
  const connection: ChannelConnection = {
    openTurn: async () => ({ update: () => undefined, finish: async () => undefined, state: () => ({ kind: 'feishu', data: {} }) }),
    resumeTurn: async () => undefined,
    showInteraction: async (_address, view) => { cards.push(view); return { messageId: 'i' }; },
    updateInteraction: async (_sent, view) => { cards.push(view); },
    showProjectPicker: async (_address, view) => { pickers.push(view); return { messageId: 'p' }; },
    showPanel: async (_address, view) => { panels.push(view); return { messageId: 'panel' }; },
    updatePanel: async (_sent, view) => { panels.push(view); },
    send: async (_address, text) => { sent.push(text); return { messageId: 's' }; },
    acknowledge: async () => undefined,
    close: async () => undefined,
  };
  const provider: ChannelProvider = { kind: 'riffet.channel-feishu/feishu', title: { 'zh-Hans': '飞书', en: 'Feishu' }, capabilities: { edit: true, actions: 'buttons', threads: true }, connect: async (_account, ctx) => { context = ctx; return connection; },
    links: account => ({ open: `https://open.test/${account.config.appId ?? ''}` }),
    register: async ({ ready }) => { ready('https://scan.test/code', 600); return registrations.shift()!; },
  };
  const message = (messageId: string, text: string, sender = 'ou_owner', chatType: 'p2p' | 'group' = 'p2p'): InboundMessage => ({
    account: '', messageId, address: { account: '', chatId: 'oc_1', chatType, threadKey: messageId }, sender: { id: sender }, text, attachments: [],
    mentionsBot: true, inThread: false, anchor: { messageId, inThread: false },
  });
  return { provider, registrations, sent, pickers, cards, panels, context: () => context, message };
}

async function boot() {
  const stateDir = await mkdtemp(join(tmpdir(), 'riffet-channels-'));
  const projectDir = await mkdtemp(join(tmpdir(), 'riffet-channels-project-'));
  const fake = fakeProvider();
  const { app, channels, store, dispatch, nativeBackends } = await createApp({ stateDir, auth: false, cliPath: '/nonexistent/cursor-agent', channelProviders: [fake.provider] });
  cleanups.push(async () => { await app.close(); await rm(stateDir, { recursive: true, force: true }); await rm(projectDir, { recursive: true, force: true }); });
  vi.spyOn(dispatch, 'kick').mockImplementation(() => undefined);
  vi.spyOn(nativeBackends, 'assertAvailable').mockImplementation(() => undefined);
  vi.spyOn(nativeBackends.catalog, 'availableBackendIds').mockResolvedValue(['claude']);
  vi.spyOn(nativeBackends.catalog, 'listBackends').mockResolvedValue([
    { backendId: 'claude', label: 'Claude Code', available: true, models: [], profiles: [], capabilities: {} },
    { backendId: 'codex', label: 'Codex', available: false, models: [], profiles: [], capabilities: {} },
  ] as never);
  const project = store.createProject(projectDir, 'demo');
  const account = await channels.createAccount({ kind: 'feishu', appId: 'cli_x', appSecret: 'secret', domain: 'feishu', enabled: true });
  await channels.connected(account.id);
  const inbound = (message: InboundMessage) => fake.context().inbound({ ...message, account: account.id, address: { ...message.address, account: account.id } });
  const bind = async (sender = 'ou_owner') => {
    inbound(fake.message('m-bind', `/bind ${channels.bindCode(account.id).code}`, sender));
    await vi.waitFor(() => expect(channels.state().identities).toHaveLength(1));
  };
  return { ...fake, app, channels, store, nativeBackends, project, account, inbound, bind, stateDir };
}

describe('channel core', () => {
  it('ignores an unbound sender, accepts one bound with a code, and never sends a held message twice', async () => {
    const { channels, store, project, account, inbound, bind, message, sent, pickers, context } = await boot();
    inbound(message('m1', 'hello', 'ou_stranger'));
    // A device pairing code is no bind code.
    inbound(message('m2', `/bind ${createPairingCode().code}`, 'ou_stranger'));
    await vi.waitFor(() => expect(sent).toEqual([expect.stringContaining('无效')]));
    expect(store.listSessions()).toHaveLength(0);

    await bind();
    expect(channels.state().identities[0]).toMatchObject({ userId: 'ou_owner', account: account.id });

    // No project yet: the message is held behind the picker, and the same platform message id is not processed again.
    inbound(message('m3', 'hello'));
    inbound(message('m3', 'hello'));
    await vi.waitFor(() => expect(pickers).toHaveLength(1));
    expect(store.listSessions()).toHaveLength(0);

    const reply = await context().action({ account: account.id, eventId: 'e1', operator: { id: 'ou_owner' }, ref: pickers[0]!.ref, action: 'pick', selectedIds: [project.id] });
    expect(reply.redraw).toMatchObject({ kind: 'project-picker', closed: true });
    await vi.waitFor(() => expect(store.listSessions()).toHaveLength(1), { timeout: 5_000 });
    const [session] = store.listSessions();
    expect(session!.origin).toMatchObject({ kind: 'channel', channel: { account: account.id, chatId: 'oc_1' } });
    expect(store.listRuns(session!.id).map(run => run.commandId)).toEqual(['m3']);

    // The conversation continues in its thread; a replay of the same message adds nothing.
    inbound({ ...message('m4', 'more'), address: { account: account.id, chatId: 'oc_1', chatType: 'p2p', threadKey: 'm3' } });
    await vi.waitFor(() => expect(store.listRuns(session!.id)).toHaveLength(2));
    expect(store.listSessions()).toHaveLength(1);
  });

  it('refuses an action from an operator who is not bound', async () => {
    const { store, project, account, inbound, bind, message, pickers, context } = await boot();
    await bind();
    inbound(message('m1', 'hello'));
    await vi.waitFor(() => expect(pickers).toHaveLength(1));
    const reply = await context().action({ account: account.id, eventId: 'e1', operator: { id: 'ou_stranger' }, ref: pickers[0]!.ref, action: 'pick', selectedIds: [project.id] });
    expect(reply.toast?.tone).toBe('error');
    expect(reply.redraw).toBeUndefined();
    expect(store.listSessions()).toHaveLength(0);
  });

  it('applies a /model press to the session with the shared selection, and refuses an unbound operator', async () => {
    const { store, project, account, inbound, bind, message, pickers, panels, context, nativeBackends } = await boot();
    await bind();
    inbound(message('m1', 'hello'));
    await vi.waitFor(() => expect(pickers).toHaveLength(1));
    await context().action({ account: account.id, eventId: 'e1', operator: { id: 'ou_owner' }, ref: pickers[0]!.ref, action: 'pick', selectedIds: [project.id] });
    await vi.waitFor(() => expect(store.listSessions()).toHaveLength(1), { timeout: 5_000 });
    const effort = { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select' as const, currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] };
    const models = [{ value: 'opus', name: 'Opus', configOptions: [effort] }, { value: 'haiku', name: 'Haiku', configOptions: [] }];
    vi.spyOn(nativeBackends.catalog, 'entry').mockResolvedValue({ backendId: 'cursor', label: 'Cursor', available: true, models, profiles: [], capabilities: {} } as never);
    vi.spyOn(nativeBackends, 'capabilities').mockResolvedValue({ supportsModelSelection: true } as never);
    const configure = vi.spyOn(nativeBackends, 'configure').mockImplementation(async session => session);
    const sessionId = store.listSessions()[0]!.id;
    store.updateSession(sessionId, { model: 'opus[effort=low]' });

    inbound({ ...message('m2', '/model'), address: { account: account.id, chatId: 'oc_1', chatType: 'p2p', threadKey: 'm1' } });
    await vi.waitFor(() => expect(panels).toHaveLength(1));
    const card = panels[0] as ModelPickerView;
    expect(card).toMatchObject({ kind: 'model-picker', scope: 'session', modelId: 'opus', summary: 'Opus · low' });

    const press = (operator: string, eventId: string) => context().action({ account: account.id, eventId, operator: { id: operator }, ref: card.ref, action: 'param:effort', selectedIds: ['high'] });
    expect((await press('ou_stranger', 'e2')).toast?.tone).toBe('error');
    expect(configure).not.toHaveBeenCalled();
    const reply = await press('ou_owner', 'e3');
    expect(reply.redraw).toMatchObject({ summary: 'Opus · high' });
    await vi.waitFor(() => expect(configure).toHaveBeenCalledWith(expect.objectContaining({ id: sessionId }), { model: 'opus[effort=high]' }));
  });

  it("continues the 个人助理's one main conversation from any thread of a private chat, and never offers it to a group", async () => {
    const { store, account, inbound, bind, message, pickers, context, sent } = await boot();
    await bind();
    inbound(message('m1', 'hello'));
    await vi.waitFor(() => expect(pickers).toHaveLength(1));
    const assistant = store.listProjects().find(project => project.system === 'assistant')!;
    expect(pickers[0]!.projects[0]).toMatchObject({ id: assistant.id });
    await context().action({ account: account.id, eventId: 'e1', operator: { id: 'ou_owner' }, ref: pickers[0]!.ref, action: 'pick', selectedIds: [assistant.id] });
    // Its agent is chosen from the catalog, which a first read probes.
    await vi.waitFor(() => expect({ main: store.getProject(assistant.id).mainSessionId, sent }).toMatchObject({ main: expect.any(String) }), { timeout: 15_000 });
    const main = store.getProject(assistant.id).mainSessionId!;
    // Another topic of the same chat is the same conversation, not a second one in its directory.
    inbound({ ...message('m2', 'again'), address: { account: account.id, chatId: 'oc_1', chatType: 'p2p', threadKey: 't2' } });
    await vi.waitFor(() => expect(store.listRuns(main).map(run => run.commandId)).toEqual(['m1', 'm2']));
    expect(store.listSessions().filter(session => session.projectId === assistant.id)).toHaveLength(1);

    inbound({ ...message('g1', 'hi', 'ou_owner', 'group'), address: { account: account.id, chatId: 'oc_group', chatType: 'group', threadKey: 'g1' } });
    await vi.waitFor(() => expect(pickers).toHaveLength(2));
    expect(pickers[1]!.projects.some(project => project.id === assistant.id)).toBe(false);
  });

  it('keeps one session for two quick messages, and turns away a press from a superseded question card', async () => {
    const { channels, store, project, account, inbound, bind, message, pickers, cards, context } = await boot();
    await bind();
    inbound(message('m1', 'hello'));
    await vi.waitFor(() => expect(pickers).toHaveLength(1));
    await context().action({ account: account.id, eventId: 'e1', operator: { id: 'ou_owner' }, ref: pickers[0]!.ref, action: 'pick', selectedIds: [project.id] });
    await vi.waitFor(() => expect(store.listSessions()).toHaveLength(1));

    const topic = (id: string) => ({ ...message(id, id), address: { account: account.id, chatId: 'oc_1', chatType: 'p2p' as const, threadKey: 't2' } });
    inbound(topic('m2'));
    inbound(topic('m3'));
    await vi.waitFor(() => expect(store.listSessions()).toHaveLength(2));
    await vi.waitFor(() => expect(store.listRuns(store.listSessions().find(item => item.origin?.kind === 'channel' && store.listRuns(item.id).some(run => run.commandId === 'm2'))!.id)).toHaveLength(2));
    expect(store.listSessions()).toHaveLength(2);

    const interaction = (revision: string) => ({ id: 'q1', revision, multiple: false, questions: [], options: [] }) as never;
    let current = interaction('r1');
    const deps = (channels as unknown as { deps: { nativeBackends: { status: (id: string) => unknown } } }).deps;
    vi.spyOn(deps.nativeBackends, 'status').mockImplementation(() => ({ interaction: current }));
    const service = channels as unknown as { follows: Map<string, unknown>; syncInteraction(follow: unknown, next: unknown): void };
    await vi.waitFor(() => expect(service.follows.size).toBeGreaterThan(0));
    const sessionId = [...service.follows.keys()][0]!;
    service.syncInteraction(service.follows.get(sessionId), current);
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    current = interaction('r2');
    service.syncInteraction(service.follows.get(sessionId), current);
    await vi.waitFor(() => expect(cards).toHaveLength(2));
    expect(cards[1]!.ref).not.toBe(cards[0]!.ref);
    const stale = await context().action({ account: account.id, eventId: 'e2', operator: { id: 'ou_owner' }, ref: cards[0]!.ref, action: 'submit' });
    expect(stale.toast?.text).toBe('已在其他端处理');
  });

  it('creates a bot from a scan with its secret kept private, binds the scanner, and updates rather than duplicates on the same app', async () => {
    const { channels, registrations } = await boot();
    const run = async (result: ProviderRegistration) => {
      registrations.push(result);
      const started = await channels.startRegistration({ kind: 'feishu' });
      expect(started.qr).toContain('<svg');
      await vi.waitFor(() => expect(channels.registration(started.id).state).toBe('done'));
      return channels.registration(started.id).accountId!;
    };
    const id = await run({ appId: 'cli_scan', appSecret: 'scan-secret', domain: 'feishu', userId: 'ou_scanner' });
    const account = channels.state().accounts.find(item => item.id === id)!;
    expect(account).toMatchObject({ appId: 'cli_scan', secretSet: true, enabled: true });
    expect(JSON.stringify(channels.state())).not.toContain('scan-secret');
    expect(channels.state().identities).toEqual([expect.objectContaining({ account: id, userId: 'ou_scanner' })]);

    expect(await run({ appId: 'cli_scan', appSecret: 'rotated', domain: 'lark', userId: 'ou_scanner' })).toBe(id);
    const state = channels.state();
    expect(state.accounts.filter(item => item.appId === 'cli_scan')).toHaveLength(1);
    expect(state.accounts.find(item => item.id === id)!.domain).toBe('lark');
    expect(state.identities.filter(item => item.account === id)).toHaveLength(1);
  });

  it('merges a card-only patch into the bot without reconnecting it, and rejects a non-boolean', async () => {
    const { channels, account, provider } = await boot();
    const connect = vi.spyOn(provider, 'connect');
    const id = account.id;
    expect(channels.state().accounts[0]!.card).toEqual({ header: true, process: true, stopButton: true, footer: { model: true, changes: true, context: true, elapsed: true } });
    const info = await channels.updateAccount(id, { card: { process: false, footer: { context: false } } });
    expect(info.card).toEqual({ header: true, process: false, stopButton: true, footer: { model: true, changes: true, context: false, elapsed: true } });
    expect(connect).not.toHaveBeenCalled();
    await expect(channels.updateAccount(id, { card: { header: 'no' as unknown as boolean } })).rejects.toThrow();
  });

  it('connects a token-only channel using declared fields without leaking secrets or requiring Feishu fields', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-channels-generic-'));
    const seen: Array<{ config: Record<string, string>; secrets: Record<string, string> }> = [];
    const tokenProvider: ChannelProvider = {
      kind: 'riffet.channel-telegram/telegram',
      title: { 'zh-Hans': 'Telegram', en: 'Telegram' },
      capabilities: { edit: true, actions: 'buttons', threads: true },
      meta: {
        fields: [
          { key: 'botToken', label: { en: 'Bot Token' }, kind: 'secret', required: true, mono: true },
          { key: 'proxy', label: { en: 'Proxy' }, kind: 'text', mono: true },
        ],
        card: { header: true, stopButton: true, footer: true },
      },
      connect: async account => {
        seen.push({ config: account.config, secrets: account.secrets });
        return {
          botName: 'RiffetBot',
          identity: { label: { en: 'Username' }, value: '@riffet_bot' },
          links: { open: 'https://t.me/riffet_bot' },
          openTurn: async () => ({ update: () => undefined, finish: async () => undefined, state: () => ({ kind: 'riffet.channel-telegram/telegram', data: {} }) }),
          resumeTurn: async () => undefined,
          showInteraction: async () => ({ messageId: 'i' }),
          updateInteraction: async () => undefined,
          showProjectPicker: async () => ({ messageId: 'p' }),
          showPanel: async () => ({ messageId: 'panel' }),
          updatePanel: async () => undefined,
          send: async () => ({ messageId: 's' }),
          acknowledge: async () => undefined,
          close: async () => undefined,
        };
      },
    };
    const { app, channels } = await createApp({ stateDir, auth: false, cliPath: '/nonexistent/cursor-agent', channelProviders: [tokenProvider] });
    cleanups.push(async () => { await app.close(); await rm(stateDir, { recursive: true, force: true }); });

    await expect(channels.createAccount({ kind: 'riffet.channel-telegram/telegram', config: {}, secrets: {} })).rejects.toThrow(/botToken/);
    const created = await channels.createAccount({ kind: 'riffet.channel-telegram/telegram', config: { proxy: 'http://127.0.0.1:7890' }, secrets: { botToken: '123:secret-token' } });
    await channels.connected(created.id);

    expect(seen).toEqual([{ config: { proxy: 'http://127.0.0.1:7890' }, secrets: { botToken: '123:secret-token' } }]);
    const state = channels.state();
    expect(JSON.stringify(state)).not.toContain('123:secret-token');
    expect(state.providers[0]).toMatchObject({ id: 'riffet.channel-telegram/telegram', register: false, card: { header: true, stopButton: true, footer: true } });
    expect(state.accounts[0]).toMatchObject({ botName: 'RiffetBot', identity: { value: '@riffet_bot' }, links: { open: 'https://t.me/riffet_bot' }, secretSet: true });
    // Platforms without `hints.manualSetupStep` never ask for Feishu's long-connection console step.
    expect((await channels.health(created.id)).needsLongConnection).toBeUndefined();

    // Updating only non-secret config keeps the stored botToken intact.
    await channels.updateAccount(created.id, { config: { proxy: '' } });
    await channels.connected(created.id);
    expect(seen[1]).toEqual({ config: {}, secrets: { botToken: '123:secret-token' } });
  });

  it('supports secretless self-authenticated channels with defaultProjectId, chatName sync, actions:none fallback and mirrorOtherClients:false', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'riffet-channels-proxy-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'riffet-channels-proxy-project-'));
    const sent: string[] = [];
    const openedTurns: Array<{ runId: string; source: string }> = [];
    const pickers: ProjectPickerView[] = [];
    let ctx!: ChannelContext;
    const connectSpy = vi.fn(async (_account, context: ChannelContext): Promise<ChannelConnection> => {
      ctx = context;
      return {
        botName: 'Local Proxy',
        ownerIdentity: { id: 'ou_self', name: 'Owner' },
        openTurn: async (_address, view) => {
          openedTurns.push({ runId: view.runId, source: view.source });
          return { update: () => undefined, finish: async () => undefined, state: () => ({ kind: 'demo.proxy/proxy', data: {} }) };
        },
        resumeTurn: async () => undefined,
        showInteraction: async () => ({ messageId: 'i' }),
        updateInteraction: async () => undefined,
        showProjectPicker: async (_address, view) => { pickers.push(view); return { messageId: 'p' }; },
        showPanel: async () => ({ messageId: 'panel' }),
        updatePanel: async () => undefined,
        send: async (_address, text) => { sent.push(text); return { messageId: 's' }; },
        acknowledge: async () => undefined,
        close: async () => undefined,
      };
    });
    const proxyProvider: ChannelProvider = {
      kind: 'demo.proxy/proxy',
      title: { 'zh-Hans': '本地代理', en: 'Local Proxy' },
      capabilities: { edit: false, actions: 'none', threads: true, mirrorOtherClients: false },
      meta: { fields: [] },
      connect: connectSpy,
    };
    const { app, channels, store, dispatch, nativeBackends } = await createApp({ stateDir, auth: false, cliPath: '/nonexistent/cursor-agent', channelProviders: [proxyProvider] });
    cleanups.push(async () => { await app.close(); await rm(stateDir, { recursive: true, force: true }); await rm(projectDir, { recursive: true, force: true }); });
    vi.spyOn(dispatch, 'kick').mockImplementation(() => undefined);
    vi.spyOn(nativeBackends, 'assertAvailable').mockImplementation(() => undefined);
    vi.spyOn(nativeBackends.catalog, 'availableBackendIds').mockResolvedValue(['claude']);
    const project = store.createProject(projectDir, 'workspace');
    const assistant = store.listProjects().find(item => item.system === 'assistant')!;

    // Secretless channel connects without any secret fields and auto-binds `ownerIdentity`.
    const account = await channels.createAccount({ kind: 'demo.proxy/proxy', enabled: true });
    await channels.connected(account.id);
    expect(channels.state().accounts[0]!.status.state).toBe('connected');
    expect(channels.state().identities).toEqual([expect.objectContaining({ account: account.id, userId: 'ou_self', name: 'Owner' })]);

    // Without a default project, an `actions: 'none'` channel replies with plain text instead of hanging on a picker card.
    ctx.inbound({
      account: account.id, messageId: 'm0', sender: { id: 'ou_self' }, text: 'hello', attachments: [], mentionsBot: true, inThread: false,
      address: { account: account.id, chatId: 'oc_team', chatType: 'group', chatName: 'Core Team', threadKey: 'm0' },
      anchor: { messageId: 'm0', inThread: true },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(pickers).toHaveLength(0);
    expect(channels.state().chats).toEqual([expect.objectContaining({ chatId: 'oc_team', name: 'Core Team' })]);

    // System projects are refused as account-level defaultProjectId; setting a normal project updates without reconnecting.
    await expect(channels.updateAccount(account.id, { defaultProjectId: assistant.id })).rejects.toThrow();
    const updated = await channels.updateAccount(account.id, { defaultProjectId: project.id });
    expect(updated.defaultProjectId).toBe(project.id);
    expect(connectSpy).toHaveBeenCalledTimes(1);

    // Inbound message now routes straight to the account's default project and tracks the channel-originated run.
    ctx.inbound({
      account: account.id, messageId: 'm1', sender: { id: 'ou_self' }, text: 'summarize thread', attachments: [], mentionsBot: true, inThread: false,
      address: { account: account.id, chatId: 'oc_team', chatType: 'group', chatName: 'Core Team', threadKey: 'm1' },
      anchor: { messageId: 'm1', inThread: true },
    });
    await vi.waitFor(() => expect(store.listSessions()).toHaveLength(1), { timeout: 5_000 });
    const [session] = store.listSessions();
    expect(session!.projectId).toBe(project.id);
    await vi.waitFor(() => expect(openedTurns).toHaveLength(1));
    expect(openedTurns[0]!.source).toBe('channel');

    // A follow-up turn started from another client is never mirrored back to this IM channel.
    store.acceptNativeRun(session!.id, 'web-cmd-1', { text: 'private follow-up from web', attachmentIds: [], context: [] }, { model: session!.model, mode: session!.mode, approval: session!.approval });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(openedTurns).toHaveLength(1);
  });
});
