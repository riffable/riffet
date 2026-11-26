import { randomBytes, randomUUID } from 'node:crypto';
import { assistantChoice, type NativeBackendCatalogEntry, type NativeInteraction, type Project, type Run } from '../../../../packages/contracts/src/index.js';
import type {
  ChannelAccountInfo, ChannelAccountInput, ChannelBindCode, ChannelChat,
  ChannelHealth, ChannelRegistration, ChannelRegistrationInput, ChannelRegistrationState, ChannelsState,
} from '../../../../packages/contracts/src/channels.js';
import { AppError } from '../errors.js';
import { resolveNativeSessionInput } from '../native/session-input.js';
import { NEW_TOPIC, claimMainConversation } from '../assistant/standing.js';
import { ChannelBindings, addressKeys, chatKey } from './bindings.js';
import { commandOfAction, helpText, panelContent, parseCommand, REPLY, type ChannelCommand } from './commands.js';
import { ChannelIdentities } from './identity.js';
import { isTerminalRun } from './projector.js';
import { ChannelAccounts } from './accounts.js';
import { ChannelModelPicker } from './model-picker.js';
import { ChannelTurnTracker } from './turn-tracker.js';
import {
  ANSWER_WAIT_MS, answerKey, DEDUPE_WINDOW_MS, errorMessage, HOLD_MS,
  MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, PICKER_LIMIT, REF_TTL_MS, UNCERTAIN_TEXT,
  type ChannelDeps, type ChannelSharedState, type ModelNameCacheEntry, type RefEntry,
  type Registration, type Runtime, type SessionFollow, type Tracker,
} from './shared.js';
import type {
  ActionReply, ChannelAddress, ChannelConnection, ChannelProvider, ImChannelProvider,
  InboundAction, InboundMessage, ProjectPickerView, ReplyAnchor,
} from './types.js';

export type { ChannelDeps };

const withKind = new WeakMap<ImChannelProvider, Map<string, ChannelProvider>>();
/** The same object for the same provider and declaration, so a reconnect is needed only when the platform really changed. */
export function channelProvider(kind: string, provider: ImChannelProvider, title?: ChannelProvider['title']): ChannelProvider {
  let byKind = withKind.get(provider);
  if (!byKind) { byKind = new Map(); withKind.set(provider, byKind); }
  let wrapped = byKind.get(kind);
  if (!wrapped) { wrapped = Object.assign(Object.create(provider) as ImChannelProvider, { kind, ...(title ? { title } : {}) }); byKind.set(kind, wrapped); }
  return wrapped;
}

export class ChannelService {
  private readonly bindings: ChannelBindings;
  private readonly identities: ChannelIdentities;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly trackers = new Map<string, Tracker>();
  private readonly follows = new Map<string, SessionFollow>();
  private readonly refs = new Map<string, RefEntry>();
  private readonly anchors = new Map<string, ReplyAnchor>();
  private readonly recent = new Map<string, number>();
  private readonly submits = new Map<string, Promise<void>>();
  private readonly held = new Map<string, { message: InboundMessage; at: number }>();
  private readonly listeners = new Set<() => void>();
  private readonly registrations = new Map<string, Registration>();
  private readonly healthCache = new Map<string, { at: number; value: ChannelHealth }>();
  private readonly catalogs = new Map<string, { at: number; value: Promise<NativeBackendCatalogEntry> }>();
  private readonly backendList: { at: number; value?: Promise<Array<{ id: string; name: string }>> } = { at: 0 };
  private readonly modelNames = new Map<string, ModelNameCacheEntry>();
  private offRuns?: () => void;
  private offProviders?: () => void;
  private started?: Promise<void>;
  private closed = false;

  private readonly accounts: ChannelAccounts;
  private readonly models: ChannelModelPicker;
  private readonly turnTracker: ChannelTurnTracker;

  constructor(private readonly deps: ChannelDeps) {
    this.bindings = new ChannelBindings(deps.store);
    this.identities = new ChannelIdentities(this.bindings);
    const shared: ChannelSharedState = {
      deps,
      bindings: this.bindings,
      identities: this.identities,
      runtimes: this.runtimes,
      trackers: this.trackers,
      follows: this.follows,
      refs: this.refs,
      anchors: this.anchors,
      registrations: this.registrations,
      healthCache: this.healthCache,
      catalogs: this.catalogs,
      backendList: this.backendList,
      modelNames: this.modelNames,
      isClosed: () => this.closed,
      provider: kind => this.provider(kind),
      connectionOf: account => this.connectionOf(account),
      changed: () => this.changed(),
      addRef: entry => this.addRef(entry),
      projectOf: id => this.projectOf(id),
      threadAnchor: (sessionId, address) => this.threadAnchor(sessionId, address),
      reply: (connection, address, anchor, text) => this.reply(connection, address, anchor, text),
      notify: (sessionId, text) => this.notify(sessionId, text),
    };
    this.accounts = new ChannelAccounts(shared, {
      onInbound: inbound => this.inbound(inbound),
      onAction: action => this.action(action),
      onResume: (account, connection) => this.turnTracker.resume(account, connection),
      onTrackPending: runId => this.turnTracker.trackPending(runId),
    });
    this.models = new ChannelModelPicker(shared, sessionId => this.turnTracker.scheduleForSession(sessionId));
    this.turnTracker = new ChannelTurnTracker(shared, this.models);
  }

  start(): Promise<void> {
    this.started ??= (async () => {
      this.offRuns = this.deps.store.onRunChanged(run => this.turnTracker.runChanged(run));
      this.offProviders = this.deps.onProvidersChanged?.(() => this.providersChanged());
      await Promise.allSettled(this.bindings.accounts().filter(account => account.enabled).map(account => this.accounts.connect(account.id)));
    })();
    return this.started;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.offRuns?.();
    this.offProviders?.();
    for (const registration of this.registrations.values()) registration.abort.abort();
    for (const tracker of this.trackers.values()) clearTimeout(tracker.timer);
    for (const follow of this.follows.values()) follow.following.close();
    this.follows.clear();
    await Promise.allSettled([...this.runtimes.keys()].map(id => this.accounts.disconnect(id)));
  }

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void { for (const listener of [...this.listeners]) { try { listener(); } catch { /* a closed stream */ } } }

  connected(id: string): Promise<void> { return this.runtimes.get(id)?.settled ?? Promise.resolve(); }
  private provider(kind: string): ChannelProvider | undefined { return this.deps.providers().find(item => item.kind === kind); }
  private connectionOf(account: string): ChannelConnection | undefined { return this.runtimes.get(account)?.connection; }

  private providersChanged(): void {
    if (this.closed) return;
    let changed = false;
    for (const account of this.bindings.accounts()) {
      if (!account.enabled) continue;
      const runtime = this.runtimes.get(account.id);
      if (runtime && runtime.provider === this.provider(account.kind)) continue;
      void this.accounts.connect(account.id);
      changed = true;
    }
    if (changed) this.changed();
  }

  state(): ChannelsState {
    return {
      providers: this.deps.providers().map(item => ({
        id: item.kind,
        title: item.title ?? { en: item.kind.slice(item.kind.lastIndexOf('/') + 1) },
        register: Boolean(item.register),
        fields: item.meta?.fields ?? [],
        capabilities: item.capabilities,
        ...(item.meta?.card ? { card: item.meta.card } : {}),
        ...(item.meta?.hints ? { hints: item.meta.hints } : {}),
      })),
      accounts: this.bindings.accounts().map(account => this.accounts.info(account)),
      identities: this.identities.list(),
      chats: this.bindings.chats(),
    };
  }

  createAccount(input: ChannelAccountInput): Promise<ChannelAccountInfo> { return this.accounts.createAccount(input); }
  updateAccount(id: string, patch: Partial<ChannelAccountInput>): Promise<ChannelAccountInfo> { return this.accounts.updateAccount(id, patch); }
  deleteAccount(id: string): Promise<void> { return this.accounts.deleteAccount(id); }
  health(id: string, refresh = false): Promise<ChannelHealth> { return this.accounts.health(id, refresh); }
  startRegistration(input: ChannelRegistrationInput): Promise<ChannelRegistration> { return this.accounts.startRegistration(input); }
  registration(id: string): ChannelRegistrationState { return this.accounts.registration(id); }
  cancelRegistration(id: string): void { this.accounts.cancelRegistration(id); }

  bindCode(accountId: string): ChannelBindCode { this.accounts.account(accountId); return this.identities.issueCode(accountId); }
  unbind(identityId: string): void {
    if (!this.identities.remove(identityId)) throw new AppError('CHANNEL_IDENTITY_NOT_FOUND', 'No such bound account', 404);
    this.changed();
  }

  patchChat(key: string, patch: { projectId?: string | null; flat?: boolean }): ChannelChat {
    const chat = this.bindings.chat(key);
    if (!chat) throw new AppError('CHANNEL_CHAT_NOT_FOUND', 'No such chat', 404);
    if (typeof patch.projectId === 'string') this.requireProject(patch.projectId, chat.chatType);
    const updated = patch.projectId === null ? this.bindings.clearChatProject(key)! : this.bindings.touchChat(chat.account, chat.chatId, chat.chatType, { ...(typeof patch.projectId === 'string' ? { projectId: patch.projectId } : {}), ...(patch.flat !== undefined ? { flat: Boolean(patch.flat) } : {}) });
    this.changed();
    return updated;
  }

  deleteChat(key: string): void {
    if (!this.bindings.removeChat(key)) throw new AppError('CHANNEL_CHAT_NOT_FOUND', 'No such chat', 404);
    this.changed();
  }

  private threadAnchor(sessionId: string, address: ChannelAddress): ReplyAnchor | undefined {
    const messageId = this.bindings.anchorOf(sessionId);
    return messageId ? { messageId, inThread: address.chatType === 'group' } : undefined;
  }

  private reply(connection: ChannelConnection, address: ChannelAddress, anchor: ReplyAnchor | undefined, text: string): Promise<unknown> {
    return connection.send(address, text, anchor).catch(error => console.warn('[channels] reply failed', errorMessage(error)));
  }

  private async inbound(m: InboundMessage): Promise<void> {
    const runtime = this.runtimes.get(m.account);
    const connection = runtime?.connection;
    if (this.closed || !runtime || !connection) return;
    runtime.status = { ...runtime.status, lastEventAt: new Date().toISOString() };
    const key = `${m.account}:${m.messageId}`;
    const now = Date.now();
    for (const [name, at] of this.recent) if (now - at > DEDUPE_WINDOW_MS) this.recent.delete(name);
    if (this.recent.has(key)) return;
    this.recent.set(key, now);
    const command = parseCommand(m.text);
    const bound = this.identities.isBound(m.account, m.sender.id);
    const binding = command?.name === 'bind' && m.address.chatType === 'p2p';
    if (!bound && !binding) return;
    if (!this.bindings.claim(key, now)) return;

    if (!bound) {
      if (command?.name === 'bind') {
        if (this.identities.redeem(m.account, command.code, m.sender)) { this.changed(); await this.reply(connection, m.address, m.anchor, REPLY.bound); }
        else await this.reply(connection, m.address, m.anchor, REPLY.bindFailed);
      }
      return;
    }
    const incomingName = m.address.chatName?.trim();
    const existingChat = this.bindings.chat(chatKey(m.account, m.address.chatId));
    const chat = !existingChat
      ? this.bindings.touchChat(m.account, m.address.chatId, m.address.chatType, incomingName ? { name: incomingName } : {})
      : incomingName && existingChat.name !== incomingName
        ? this.bindings.touchChat(m.account, m.address.chatId, m.address.chatType, { name: incomingName })
        : existingChat;
    if (!existingChat || (incomingName && existingChat.name !== incomingName)) this.changed();
    const conversation = this.bindings.conversation(m.address, chat.flat);
    if (m.address.chatType === 'group' && !m.mentionsBot && !conversation) return;
    if (command) { await this.command(command, m, chat, conversation?.sessionId, connection); return; }
    if (!m.text.trim() && !m.attachments.length) return;
    void connection.acknowledge(m.anchor, 'received').catch(() => undefined);
    const fallbackProjectId = this.accounts.account(m.account).defaultProjectId;
    const projectId = chat.projectId && this.projectUsable(chat.projectId, chat.chatType)
      ? chat.projectId
      : fallbackProjectId && this.projectUsable(fallbackProjectId, chat.chatType)
        ? fallbackProjectId
        : undefined;
    if (!projectId) { await this.askProject(m, chat, connection, true); return; }
    await this.submit(m, projectId, connection);
  }

  private async command(command: ChannelCommand, m: InboundMessage, chat: ChannelChat, sessionId: string | undefined, connection: ChannelConnection): Promise<void> {
    switch (command.name) {
      case 'bind': await this.reply(connection, m.address, m.anchor, REPLY.bound); return;
      case 'new':
        if (chat.projectId && this.projectOf(chat.projectId)?.system === 'assistant') {
          await this.submit({ ...m, text: NEW_TOPIC }, chat.projectId, connection);
          await this.reply(connection, m.address, m.anchor, REPLY.newTopic);
          return;
        }
        this.bindings.unbind(m.address, chat.flat);
        await this.reply(connection, m.address, m.anchor, REPLY.newSession);
        return;
      case 'stop': {
        if (!sessionId) { await this.reply(connection, m.address, m.anchor, REPLY.noSession); return; }
        try { await this.reply(connection, m.address, m.anchor, await this.stop(sessionId) ? REPLY.stopped : REPLY.nothingRunning); }
        catch (error) { await this.reply(connection, m.address, m.anchor, REPLY.failed(errorMessage(error))); }
        return;
      }
      case 'project': await this.askProject(m, chat, connection, false); return;
      case 'flat': {
        if (m.address.chatType !== 'group') { await this.reply(connection, m.address, m.anchor, REPLY.flatGroupOnly); return; }
        const flat = command.value ? command.value === 'on' : !chat.flat;
        this.bindings.touchChat(m.account, m.address.chatId, 'group', { flat });
        this.changed();
        await this.reply(connection, m.address, m.anchor, flat ? REPLY.flatOn : REPLY.flatOff);
        return;
      }
      case 'status': await this.reply(connection, m.address, m.anchor, this.statusText(chat, sessionId)); return;
      case 'model': await this.models.askModel(m, chat, sessionId, connection); return;
      case 'help': await this.showHelp(m, connection); return;
    }
  }

  private async showHelp(m: InboundMessage, connection: ChannelConnection): Promise<void> {
    if (this.runtimes.get(m.account)?.provider?.capabilities.actions === 'none') {
      await this.reply(connection, m.address, m.anchor, helpText());
      return;
    }
    try {
      const ref = this.addRef({ kind: 'panel', account: m.account, address: m.address, anchor: m.anchor, at: Date.now() });
      await connection.showPanel(m.address, { kind: 'command-panel', ref, ...panelContent(m.address.chatType) }, m.anchor);
    } catch { await this.reply(connection, m.address, m.anchor, helpText()); }
  }

  private pressCommand(a: InboundAction, entry: Extract<RefEntry, { kind: 'panel' }>): ActionReply {
    const command = commandOfAction(a.action);
    const connection = this.connectionOf(a.account);
    if (!command || !connection) return {};
    const m: InboundMessage = {
      account: a.account, messageId: `action:${a.eventId}`, address: entry.address, sender: { id: a.operator.id }, text: `/${command.name}`,
      attachments: [], mentionsBot: true, inThread: Boolean(entry.address.threadKey), anchor: entry.anchor ?? { messageId: '', inThread: false },
    };
    const chat = this.bindings.chat(chatKey(m.account, m.address.chatId)) ?? this.bindings.touchChat(m.account, m.address.chatId, m.address.chatType);
    const sessionId = this.bindings.conversation(m.address, chat.flat)?.sessionId;
    void this.command(command, m, chat, sessionId, connection).catch(error => console.warn('[channels] command failed', errorMessage(error)));
    return {};
  }

  private statusText(chat: ChannelChat, sessionId: string | undefined): string {
    const lines: string[] = [];
    const effectiveProjectId = chat.projectId ?? this.bindings.accounts().find(item => item.id === chat.account)?.defaultProjectId;
    const project = effectiveProjectId ? this.projectOf(effectiveProjectId) : undefined;
    lines.push(`项目：${project?.name ?? '未选择'}`);
    if (sessionId) {
      try {
        const session = this.deps.store.getSession(sessionId);
        const phase = this.deps.nativeBackends.status(sessionId).phase;
        const readableModel = this.models.modelName(session) ?? session.model;
        lines.push(`会话：${session.displayTitle ?? session.title}`, `状态：${phase === 'busy' ? '进行中' : phase === 'attention' ? '等待回答' : '空闲'}`, `模型：${[session.backendId, readableModel].filter(Boolean).join(' · ') || '默认'}`);
      } catch { lines.push('会话：已不存在'); }
    } else lines.push('会话：新消息会开新会话');
    if (chat.chatType === 'group') lines.push(chat.flat ? '整群共用一个会话' : '按话题分会话');
    return lines.join('\n');
  }

  private projectOf(id: string): Project | undefined { try { return this.deps.store.getProject(id); } catch { return undefined; } }
  private offered(project: Project | undefined, chatType: ChannelChat['chatType']): project is Project {
    return Boolean(project && !project.archivedAt && (!project.system || (project.system === 'assistant' && chatType === 'p2p')));
  }
  private projectUsable(id: string, chatType: ChannelChat['chatType']): boolean { return this.offered(this.projectOf(id), chatType); }
  private requireProject(id: string, chatType: ChannelChat['chatType']): Project {
    const project = this.projectOf(id);
    if (!this.offered(project, chatType)) throw new AppError('INVALID_PROJECT', 'Choose an open project');
    return project;
  }

  private projectChoices(chatType: ChannelChat['chatType']): ProjectPickerView['projects'] {
    const projects = this.deps.store.listProjects();
    const assistant = chatType === 'p2p' ? projects.filter(project => project.system === 'assistant' && !project.archivedAt) : [];
    return [...assistant, ...projects.filter(project => !project.archivedAt && !project.system).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))].slice(0, PICKER_LIMIT)
      .map(project => ({ id: project.id, name: project.name, path: project.system === 'assistant' ? '' : project.cwd }));
  }

  private async askProject(m: InboundMessage, chat: ChannelChat, connection: ChannelConnection, hold: boolean): Promise<void> {
    if (this.runtimes.get(m.account)?.provider?.capabilities.actions === 'none') {
      await this.reply(connection, m.address, m.anchor, REPLY.projectRequiredInRiffet);
      return;
    }
    const projects = this.projectChoices(chat.chatType);
    if (!projects.length) { await this.reply(connection, m.address, m.anchor, REPLY.noProjects); return; }
    if (hold) this.held.set(chat.key, { message: m, at: Date.now() });
    const ref = this.addRef({ kind: 'picker', account: m.account, chat: chat.key, at: Date.now() });
    try { await connection.showProjectPicker(m.address, { kind: 'project-picker', ref, projects, ...(chat.projectId ? { selectedId: chat.projectId } : {}) }, m.anchor); }
    catch (error) { await this.reply(connection, m.address, m.anchor, REPLY.failed(errorMessage(error))); }
  }

  private submit(m: InboundMessage, projectId: string, connection: ChannelConnection): Promise<void> {
    const flat = this.bindings.chat(chatKey(m.account, m.address.chatId))?.flat ?? false;
    const key = addressKeys(m.address, flat)[0]!;
    const next = (this.submits.get(key) ?? Promise.resolve()).then(() => this.submitNow(m, projectId, connection));
    this.submits.set(key, next);
    void next.finally(() => { if (this.submits.get(key) === next) this.submits.delete(key); });
    return next;
  }

  private async submitNow(m: InboundMessage, projectId: string, connection: ChannelConnection): Promise<void> {
    const { store, dispatch, nativeBackends, sessionCommands } = this.deps;
    let created: string | undefined;
    try {
      const chat = this.bindings.chat(chatKey(m.account, m.address.chatId))!;
      const existing = this.bindings.conversation(m.address, chat.flat);
      let session = existing ? (() => { try { return store.getSession(existing.sessionId); } catch { return undefined; } })() : undefined;
      const project = store.getProject(projectId);
      const assistant = project.system === 'assistant';
      if (assistant && (!session || session.archivedAt || session.id !== project.mainSessionId)) {
        const main = project.mainSessionId ? (() => { try { const found = store.getSession(project.mainSessionId!); return found.archivedAt ? undefined : found; } catch { return undefined; } })() : undefined;
        session = main;
        if (main) this.bindings.bind(m.address, chat.flat, main.id, m.anchor.messageId);
      }
      const attachmentIds = await this.upload(m, session?.projectId ?? projectId);
      const input = { text: m.text.trim() || '请查看附件', attachmentIds, context: [] };
      this.anchors.set(m.messageId, m.anchor);
      if (!session) {
        const choice = assistant ? assistantChoice(this.deps.settings.getSettings().assistant, await nativeBackends.catalog.listBackends()) : undefined;
        const defaults = choice ? { backendId: choice.backendId, model: choice.model, profileId: choice.profileId } : { ...this.bindings.chatModel(chat.key), profileId: undefined };
        const sessionInput = await resolveNativeSessionInput(this.deps, { projectId, ...(defaults.backendId ? { backendId: defaults.backendId } : {}), ...(defaults.profileId ? { backendProfileId: defaults.profileId } : {}), ...(defaults.model ? { model: defaults.model } : {}) }, undefined)
          .catch(error => defaults.backendId || defaults.model ? resolveNativeSessionInput(this.deps, { projectId }, undefined) : Promise.reject(error));
        const sessionId = randomUUID();
        this.bindings.bind(m.address, chat.flat, sessionId, m.anchor.messageId);
        created = sessionId;
        const result = store.transaction(() => {
          const made = store.createNativeSubmission(sessionId, { ...sessionInput, origin: { kind: 'channel', channel: { kind: this.accounts.account(m.account).kind, account: m.account, chatId: m.address.chatId } } }, m.messageId, input);
          if (assistant) claimMainConversation(store, store.getProject(projectId), sessionId);
          return made;
        });
        dispatch.kick();
        this.turnTracker.track(result.run);
      } else {
        this.bindings.setAnchor(session.id, m.anchor.messageId);
        const found = store.findRunByCommand(session.id, m.messageId);
        const run = found ? store.acceptNativeRun(session.id, m.messageId, input, found.native!.config) : (() => {
          sessionCommands.admit(session!);
          nativeBackends.assertAvailable(session!);
          return store.acceptNativeRun(session!.id, m.messageId, input, { model: session!.model, mode: session!.mode, approval: session!.approval });
        })();
        dispatch.kick();
        this.turnTracker.track(run);
      }
      this.changed();
    } catch (error) {
      this.anchors.delete(m.messageId);
      if (created) this.bindings.unbind(m.address, this.bindings.chat(chatKey(m.account, m.address.chatId))?.flat ?? false);
      void connection.acknowledge(m.anchor, 'failed').catch(() => undefined);
      await this.reply(connection, m.address, m.anchor, REPLY.failed(error instanceof AppError && error.statusCode < 500 ? error.message : '服务暂时不可用'));
    }
  }

  private async upload(m: InboundMessage, projectId: string): Promise<string[]> {
    if (!m.attachments.length) return [];
    if (m.attachments.length > MAX_ATTACHMENTS) throw new AppError('TOO_MANY_ATTACHMENTS', `Use at most ${MAX_ATTACHMENTS} attachments`);
    const project = this.deps.store.getProject(projectId);
    const ids: string[] = [];
    for (const attachment of m.attachments) {
      const file = await attachment.download();
      if (file.data.byteLength > MAX_ATTACHMENT_BYTES) throw new AppError('ATTACHMENT_TOO_LARGE', 'An attachment is larger than 24 MB');
      ids.push((await this.deps.workspace.upload(project, { name: file.name, mimeType: file.mimeType, dataBase64: file.data.toString('base64') })).id);
    }
    return ids;
  }

  private async stop(sessionId: string): Promise<boolean> {
    const { store, nativeBackends, dispatch } = this.deps;
    const session = store.getSession(sessionId);
    if (!store.listUnfinishedNativeRuns(sessionId).some(run => !run.native?.queueReleasedAt)) return false;
    const active = nativeBackends.status(sessionId).activeTurn;
    const nativeSessionId = active?.nativeSessionId ?? session.nativeSessionId;
    if (!nativeSessionId) return false;
    await dispatch.interrupt(sessionId, { requestId: randomUUID(), nativeSessionId, ...(active ? { turnId: active.turnId } : {}) });
    return true;
  }

  private async stopRun(sessionId: string, runId: string): Promise<void> {
    const { store, dispatch } = this.deps;
    if (store.getRun(runId).state === 'queued') {
      try { dispatch.cancel(sessionId, runId); return; }
      catch (error) { if (!(error instanceof AppError && error.code === 'RUN_ALREADY_DISPATCHED')) throw error; }
    }
    await this.stop(sessionId);
  }

  private addRef(entry: RefEntry): string {
    const now = Date.now();
    for (const [ref, item] of this.refs) if ('at' in item && now - item.at > REF_TTL_MS) this.refs.delete(ref);
    const ref = randomBytes(9).toString('base64url');
    this.refs.set(ref, entry);
    return ref;
  }

  private async action(a: InboundAction): Promise<ActionReply> {
    if (this.closed) return { toast: { tone: 'warning', text: '服务正在关闭' } };
    if (!this.identities.isBound(a.account, a.operator.id)) return { toast: { tone: 'error', text: '没有权限' } };
    const entry = this.refs.get(a.ref);
    if (!entry || entry.account !== a.account) return { toast: { tone: 'info', text: '这张卡片已失效' } };
    if (!this.bindings.claim(`${a.account}:action:${a.eventId}`)) return {};
    if (entry.kind === 'stop') {
      let run: Run | undefined;
      try { run = this.deps.store.getRun(entry.runId); } catch { run = undefined; }
      if (!run || isTerminalRun(run)) return { toast: { tone: 'info', text: '这个回合已结束' } };
      void this.stopRun(entry.sessionId, entry.runId).catch(error => this.notify(entry.sessionId, REPLY.failed(errorMessage(error))));
      return { toast: { tone: 'info', text: REPLY.stopped } };
    }
    if (entry.kind === 'picker') return this.pick(a, a.ref, entry);
    if (entry.kind === 'panel') return this.pressCommand(a, entry);
    if (entry.kind === 'model') return this.models.pressModel(a, a.ref, entry);
    return this.answer(a, entry);
  }

  private pick(a: InboundAction, ref: string, entry: Extract<RefEntry, { kind: 'picker' }>): ActionReply {
    const projectId = a.selectedIds?.[0] ?? (a.action !== 'pick' ? a.action : undefined);
    const project = projectId ? this.projectOf(projectId) : undefined;
    const chat = this.bindings.chat(entry.chat);
    if (!projectId || !chat || !this.offered(project, chat.chatType)) return { toast: { tone: 'error', text: '这个项目不可用' } };
    this.bindings.touchChat(chat.account, chat.chatId, chat.chatType, { projectId });
    this.changed();
    const held = this.held.get(chat.key);
    this.held.delete(chat.key);
    const connection = this.connectionOf(a.account);
    if (held && connection && Date.now() - held.at < HOLD_MS) void this.submit(held.message, projectId, connection);
    return { toast: { tone: 'success', text: REPLY.projectChanged(project.name) }, redraw: { kind: 'project-picker', ref, projects: this.projectChoices(chat.chatType), selectedId: projectId, closed: true } };
  }

  private async answer(a: InboundAction, entry: Extract<RefEntry, { kind: 'interaction' }>): Promise<ActionReply> {
    const { nativeBackends, sessionLock, store } = this.deps;
    const current = nativeBackends.status(entry.sessionId).interaction;
    const follow = this.follows.get(entry.sessionId);
    if (!current || current.id !== entry.interactionId || current.revision !== entry.revision) {
      if (follow) this.turnTracker.syncInteraction(follow, current);
      return { toast: { tone: 'warning', text: '已在其他端处理' } };
    }
    const key = answerKey(entry.interactionId, entry.revision);
    if (follow?.answered.has(key)) return { toast: { tone: 'info', text: '已提交过' } };
    follow?.answered.add(key);
    const otherText = a.otherText?.trim() || undefined;
    const selectedIds = otherText && !current.multiple ? undefined : a.selectedIds;
    let slow = false;
    const pending = (async (): Promise<'sent' | 'uncertain' | 'failed'> => {
      try {
        const result = await sessionLock.withSession(entry.sessionId, () => nativeBackends.respondInteraction(store.getSession(entry.sessionId), {
          interactionId: entry.interactionId, revision: entry.revision, requestId: a.eventId, action: a.action,
          ...(selectedIds ? { selectedIds } : {}), ...(otherText !== undefined ? { otherText } : {}),
        }));
        if (result.status !== 'uncertain') return 'sent';
        if (slow) this.notify(entry.sessionId, UNCERTAIN_TEXT);
        return 'uncertain';
      } catch (error) {
        this.follows.get(entry.sessionId)?.answered.delete(key);
        this.notify(entry.sessionId, REPLY.failed(errorMessage(error)));
        return 'failed';
      }
    })();
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([pending, new Promise<'slow'>(resolve => { timer = setTimeout(() => resolve('slow'), ANSWER_WAIT_MS); timer.unref?.(); })]);
    clearTimeout(timer);
    if (outcome === 'slow') slow = true;
    if (outcome === 'failed') return { toast: { tone: 'error', text: '没有提交' } };
    return {
      toast: outcome === 'uncertain' ? { tone: 'warning', text: UNCERTAIN_TEXT } : { tone: 'success', text: '已提交' },
      redraw: this.turnTracker.interactionView(current, a.ref, { outcome: 'answered' }),
    };
  }

  private notify(sessionId: string, text: string): void {
    const address = this.bindings.addressOf(sessionId);
    const connection = address && this.connectionOf(address.account);
    if (address && connection) void connection.send(address, text, this.threadAnchor(sessionId, address)).catch(() => undefined);
  }

  private syncInteraction(follow: SessionFollow, next: NativeInteraction | undefined): void {
    this.turnTracker.syncInteraction(follow, next);
  }
}
