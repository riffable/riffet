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
  const provider: ChannelProvider = { kind: 'feishu', capabilities: { edit: true, actions: 'buttons', threads: true }, connect: async (_account, ctx) => { context = ctx; return connection; },
    links: account => ({ open: `https://open.test/${account.appId}` }),
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
    await vi.waitFor(() => expect(store.listSessions()).toHaveLength(1));
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
    await vi.waitFor(() => expect(store.listSessions()).toHaveLength(1));
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
});
