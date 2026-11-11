import { randomUUID, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { catalogEntry, catalogSelection, parseSelection, resolveCatalogSelection, type ModelInfo, type NativeBackendCatalogEntry, type NativeInteraction, type NativeStatus, type Project, type Run, type Session } from '../../../../packages/contracts/src/index.js';
import type { ChannelCardOptions, ChannelAccountInfo, ChannelAccountInput, ChannelBindCode, ChannelChat, ChannelConnectionStatus, ChannelHealth, ChannelKind, ChannelRegistration, ChannelRegistrationInput, ChannelRegistrationState, ChannelsState } from '../../../../packages/contracts/src/channels.js';
import { AppError, requireString } from '../errors.js';
import type { SessionLock } from '../agent-host/session-lock.js';
import type { NativeBackendService } from '../backends/service.js';
import type { NativeDispatcher } from '../native/dispatch.js';
import { configureNative } from '../native/configure.js';
import { defaultBackendForClient } from '../native/client-features.js';
import { resolveNativeSessionInput } from '../native/session-input.js';
import { savedDefaultBackendId } from '../session-identity.js';
import type { OwnerService } from '../owner/index.js';
import type { SessionCommands } from '../orchestration/session-commands.js';
import { atomicWritePrivateFile, readPrivateSettingsFile } from '../settings/private-file.js';
import type { SettingsService } from '../settings/index.js';
import type { Store } from '../store.js';
import type { TranscriptIngest } from '../sync/ingest.js';
import type { TimelineService } from '../timeline/service.js';
import type { WorkspaceService } from '../workspace/index.js';
import { ChannelBindings, addressKeys, chatKey, mergeCard, type CardPatch, type StoredAccount } from './bindings.js';
import { commandOfAction, helpText, panelContent, parseCommand, REPLY, type ChannelCommand } from './commands.js';
import { followSession, type Following } from './follow.js';
import { ChannelIdentities } from './identity.js';
import { buildModelView, isTerminalRun, projectTurn } from './projector.js';
import type { ActionReply, ChannelAccount, ChannelAddress, ChannelConnection, ChannelContext, ChannelProvider, InboundAction, InboundMessage, InteractionView, ModelPickerView, ProjectPickerView, ProviderRegistration, ReplyAnchor, SentRef, TurnSurface, TurnView } from './types.js';

/*
 * The IM-agnostic core of docs/design/channels.md: accounts, the gate, chat and conversation
 * bindings, the inbound pipeline, and following a conversation's turns back to the chat. Providers
 * (feishu/) only translate the platform; they never see the store or the sessions.
 */

export interface ChannelDeps {
  store: Store;
  settings: SettingsService;
  nativeBackends: NativeBackendService;
  dispatch: NativeDispatcher;
  sessionCommands: SessionCommands;
  sessionLock: SessionLock;
  timeline: TimelineService;
  ingest: TranscriptIngest;
  workspace: WorkspaceService;
  owner: OwnerService;
  stateDir: string;
  providers: ChannelProvider[];
}

const DEDUPE_WINDOW_MS = 60_000;
const HOLD_MS = 10 * 60_000;
const REF_TTL_MS = 24 * 60 * 60_000;
const PICKER_LIMIT = 50;
const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;
const PUSH_DELAY_MS = 400;
const MODEL_NAMES_TTL_MS = 10 * 60_000;
const CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_CACHE_MAX = 32;

const CARD_FIELDS = ['header', 'process', 'stopButton'] as const;
const FOOTER_FIELDS = ['model', 'changes', 'context', 'elapsed'] as const;
/** Only known boolean fields of a card patch; anything else is a bad request. */
function validCard(value: unknown): CardPatch {
  const record = (item: unknown, fields: readonly string[], where: string): Record<string, boolean> => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new AppError('INVALID_CHANNEL_CARD', `card${where} must be an object`);
    const out: Record<string, boolean> = {};
    for (const [key, flag] of Object.entries(item)) {
      if (key === 'footer' && !where) continue;
      if (!fields.includes(key) || typeof flag !== 'boolean') throw new AppError('INVALID_CHANNEL_CARD', `card${where}.${key} must be a boolean`);
      out[key] = flag;
    }
    return out;
  };
  const top = record(value, CARD_FIELDS, '');
  const footer = (value as { footer?: unknown }).footer;
  return { ...top, ...(footer === undefined ? {} : { footer: record(footer, FOOTER_FIELDS, '.footer') }) };
}
const PERSIST_EVERY_MS = 5000;
const HEALTH_TTL_MS = 60_000;
const REGISTRATION_READY_MS = 15_000;
const REGISTRATION_KEEP_MS = 10 * 60_000;
/** How long an answer press waits for the backend before toasting without its result. */
const ANSWER_WAIT_MS = 2500;
const MODEL_NAMES_CAP = 16;
const MODEL_NAMES_FINAL_WAIT_MS = 500;

interface Runtime {
  status: ChannelConnectionStatus;
  abort: AbortController;
  connection?: ChannelConnection;
  /** Settles when the connection attempt (and the resume after it) is over. */
  settled: Promise<void>;
  /** Set once the previous process's turn cards are taken over; runs seen before wait in `pending`. */
  resumed: boolean;
  pending: Set<string>;
}

type RefEntry =
  | { kind: 'stop'; account: string; sessionId: string; runId: string }
  | { kind: 'picker'; account: string; chat: string; at: number }
  | { kind: 'panel'; account: string; address: ChannelAddress; anchor?: ReplyAnchor; at: number }
  | ModelRef
  | { kind: 'interaction'; account: string; sessionId: string; interactionId: string; revision: string };

/** One `/model` card: where it was asked and what it changes; its live state is read from the session or chat. */
interface ModelRef {
  kind: 'model'; account: string; address: ChannelAddress; anchor?: ReplyAnchor; at: number;
  scope: ModelPickerView['scope']; chat: string; sessionId?: string; sent?: SentRef;
  /** A session change still being applied, so the next press builds on it. */
  pending?: string;
  /** Session changes run one after another, so a slow earlier press cannot land after a later one. */
  chain?: Promise<void>;
}

interface Tracker {
  runId: string; sessionId: string; commandId: string; address: ChannelAddress;
  source: TurnView['source']; anchor?: ReplyAnchor;
  surface?: TurnSurface; opening?: Promise<TurnSurface | undefined>;
  timer?: NodeJS.Timeout; finishing: boolean; persisted?: string; persistedAt?: number; persistedIds?: string; stopRef: string;
}

/** `refs`: every ref issued for the card; older ones stay so a press from a superseded revision is told so. */
interface Shown { ref: string; refs: string[]; interaction: NativeInteraction; sent: SentRef }
interface SessionFollow {
  sessionId: string; following: Following; trackers: Set<string>;
  waiting: boolean; shown?: Shown; answered: Set<string>;
  /** Latest context meter, in percent; unset while the backend reports none. */
  contextPercent?: number;
  /** Interaction cards are drawn one at a time, in the order the status changed. */
  chain: Promise<void>;
}

/** One scan-to-create flow in flight or recently finished. */
interface Registration extends ChannelRegistrationState {
  kind: ChannelKind;
  abort: AbortController;
  url: string;
  qr: string;
  expiresAt: number;
  finishedAt?: number;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const UNCERTAIN_TEXT = '已发送，但没有确认收到';
const answerKey = (id: string, revision: string) => `${id}\n${revision}`;

export class ChannelService {
  private readonly bindings: ChannelBindings;
  private readonly identities: ChannelIdentities;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly trackers = new Map<string, Tracker>();
  private readonly follows = new Map<string, SessionFollow>();
  private readonly refs = new Map<string, RefEntry>();
  /** What a message the chat sent is answered under; its presence marks the run as the chat's own. */
  private readonly anchors = new Map<string, ReplyAnchor>();
  private readonly recent = new Map<string, number>();
  /** Submits of one conversation run one after another, so two quick messages share one session. */
  private readonly submits = new Map<string, Promise<void>>();
  private readonly held = new Map<string, { message: InboundMessage; at: number }>();
  private readonly listeners = new Set<() => void>();
  private readonly registrations = new Map<string, Registration>();
  private readonly healthCache = new Map<string, { at: number; value: ChannelHealth }>();
  private offRuns?: () => void;
  private started?: Promise<void>;
  private closed = false;

  constructor(private readonly deps: ChannelDeps) {
    this.bindings = new ChannelBindings(deps.store);
    this.identities = new ChannelIdentities(this.bindings);
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  /** Connects every enabled account and listens for turns of bound conversations. Idempotent. */
  start(): Promise<void> {
    this.started ??= (async () => {
      this.offRuns = this.deps.store.onRunChanged(run => this.runChanged(run));
      await Promise.allSettled(this.bindings.accounts().filter(account => account.enabled).map(account => this.connect(account.id)));
    })();
    return this.started;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.offRuns?.();
    for (const registration of this.registrations.values()) registration.abort.abort();
    for (const tracker of this.trackers.values()) clearTimeout(tracker.timer);
    for (const follow of this.follows.values()) follow.following.close();
    this.follows.clear();
    await Promise.allSettled([...this.runtimes.keys()].map(id => this.disconnect(id)));
  }

  /** Settings pages refetch on this. */
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void { for (const listener of [...this.listeners]) { try { listener(); } catch { /* a closed stream */ } } }

  /** Resolves once the account's connection attempt is over; for tests and the settings page. */
  connected(id: string): Promise<void> { return this.runtimes.get(id)?.settled ?? Promise.resolve(); }

  // ---- accounts ----------------------------------------------------------------------------------

  private secretPath(id: string): string { return join(this.deps.stateDir, 'channels', `${id}.secret`); }
  private writeSecret(id: string, secret: string): void {
    mkdirSync(join(this.deps.stateDir, 'channels'), { recursive: true, mode: 0o700 });
    atomicWritePrivateFile(this.secretPath(id), secret);
  }

  private info(account: StoredAccount): ChannelAccountInfo {
    const status = this.runtimes.get(account.id)?.status ?? { state: account.enabled ? 'connecting' as const : 'disabled' as const };
    const connection = this.runtimes.get(account.id)?.connection;
    const { source: _source, card, ...rest } = account;
    const links = this.deps.providers.find(item => item.kind === account.kind)?.links(account) ?? {};
    return { ...rest, ...(connection?.botName ? { botName: connection.botName } : {}), ...(connection?.avatarUrl ? { avatarUrl: connection.avatarUrl } : {}), secretSet: existsSync(this.secretPath(account.id)), status, links, card: mergeCard(card) };
  }

  private cardOf(accountId: string): ChannelCardOptions { return mergeCard(this.bindings.accounts().find(item => item.id === accountId)?.card); }

  /** Display names and catalogs by backend and profile: filled in the background, never awaited by a render. */
  private readonly modelNames = new Map<string, { names: Map<string, string>; models: ModelInfo[]; loading?: Promise<void>; at: number }>();
  private modelEntry(session: Session): { names: Map<string, string>; models: ModelInfo[]; loading?: Promise<void>; at: number } | undefined {
    if (!session.model || !session.backendId) return undefined;
    const key = `${session.backendId}:${session.backendProfileId ?? ''}`;
    const entry = this.modelNames.get(key);
    if (!entry || (!entry.loading && Date.now() - entry.at > MODEL_NAMES_TTL_MS)) this.loadModelNames(key, session);
    return this.modelNames.get(key);
  }
  private modelName(session: Session): string | undefined {
    return this.modelEntry(session)?.names.get(parseSelection(session.model).model);
  }
  private loadModelNames(key: string, session: Session): void {
    const previous = this.modelNames.get(key);
    const entry = { names: previous?.names ?? new Map<string, string>(), models: previous?.models ?? [], at: Date.now() } as { names: Map<string, string>; models: ModelInfo[]; loading?: Promise<void>; at: number };
    this.modelNames.delete(key);
    this.modelNames.set(key, entry);
    while (this.modelNames.size > MODEL_NAMES_CAP) this.modelNames.delete(this.modelNames.keys().next().value!);
    entry.loading = (async () => {
      try {
        const { models } = await this.deps.nativeBackends.catalog(session.backendId!, this.projectOf(session.projectId), undefined, session, { allModels: true });
        const names = new Map<string, string>();
        for (const model of models) for (const id of [model.value, ...(model.aliases ?? []), ...(model.nativeVariants ?? []).map(variant => variant.value)]) if (model.name) names.set(id, model.name);
        entry.names = names; entry.models = models;
        for (const tracker of this.trackers.values()) if (tracker.sessionId === session.id) this.schedule(tracker);
      } catch { /* the tidied id stays */ }
      finally { entry.loading = undefined; }
    })();
  }

  private account(id: string): StoredAccount {
    const account = this.bindings.accounts().find(item => item.id === id);
    if (!account) throw new AppError('CHANNEL_ACCOUNT_NOT_FOUND', 'No such channel account', 404);
    return account;
  }

  state(): ChannelsState {
    return { accounts: this.bindings.accounts().map(account => this.info(account)), identities: this.identities.list(), chats: this.bindings.chats() };
  }

  async createAccount(input: ChannelAccountInput): Promise<ChannelAccountInfo> {
    if (input?.kind !== 'feishu') throw new AppError('INVALID_CHANNEL_KIND', 'Unsupported channel kind');
    const account: StoredAccount = { id: `${input.kind}-${randomBytes(4).toString('hex')}`, kind: input.kind, appId: requireString(input.appId, 'appId', 200).trim(), domain: this.domain(input.domain), enabled: input.enabled !== false, source: 'manual' };
    this.writeSecret(account.id, requireString(input.appSecret, 'appSecret', 500).trim());
    this.bindings.setAccount(account);
    if (account.enabled) void this.connect(account.id);
    this.changed();
    return this.info(account);
  }

  async updateAccount(id: string, patch: Partial<ChannelAccountInput>): Promise<ChannelAccountInfo> {
    const current = this.account(id);
    const next: StoredAccount = {
      ...current,
      ...(patch.appId !== undefined ? { appId: requireString(patch.appId, 'appId', 200).trim() } : {}),
      ...(patch.domain !== undefined ? { domain: this.domain(patch.domain) } : {}),
      ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
      ...(patch.card !== undefined ? { card: mergeCard(current.card, validCard(patch.card)) } : {}),
    };
    if (patch.card !== undefined && patch.appId === undefined && patch.domain === undefined && patch.appSecret === undefined && patch.enabled === undefined) {
      this.bindings.setAccount(next);
      this.changed();
      return this.info(next);
    }
    if (patch.appSecret !== undefined) this.writeSecret(id, requireString(patch.appSecret, 'appSecret', 500).trim());
    this.bindings.setAccount(next);
    this.healthCache.delete(id);
    await this.disconnect(id);
    if (next.enabled) void this.connect(id);
    this.changed();
    return this.info(next);
  }

  async deleteAccount(id: string): Promise<void> {
    this.account(id);
    await this.disconnect(id);
    this.healthCache.delete(id);
    this.bindings.removeAccount(id);
    try { rmSync(this.secretPath(id), { force: true }); } catch { /* nothing to remove */ }
    this.changed();
  }

  // ---- health and registration ---------------------------------------------------------------------

  /** The bot page's checklist: the connection, then whatever the provider can check live; cached about a minute. */
  async health(id: string, refresh = false): Promise<ChannelHealth> {
    const stored = this.account(id);
    const cached = this.healthCache.get(id);
    if (!refresh && cached && Date.now() - cached.at < HEALTH_TTL_MS) return this.liveHealth(id, cached.value);
    const provider = this.deps.providers.find(item => item.kind === stored.kind);
    let remote: Awaited<ReturnType<NonNullable<ChannelProvider['health']>>> = {};
    const secret = readPrivateSettingsFile(this.secretPath(id))?.trim();
    if (provider?.health && secret) {
      try { remote = await provider.health({ id, kind: stored.kind, appId: stored.appId, domain: stored.domain, enabled: stored.enabled, appSecret: secret }); } catch { remote = {}; }
    }
    const value: ChannelHealth = {
      connected: false,
      ...(remote.activated !== undefined ? { activated: remote.activated } : {}),
      ...(remote.missingScopes ? { missingScopes: remote.missingScopes } : {}),
      ...(remote.missingScopes?.length && provider?.links(stored, remote.missingScopes).grant ? { grantUrl: provider.links(stored, remote.missingScopes).grant } : {}),
    };
    this.healthCache.set(id, { at: Date.now(), value });
    return this.liveHealth(id, value);
  }

  /** The cached remote checks with the parts that are cheap and must be current: connection and first message. */
  private liveHealth(id: string, remote: ChannelHealth): ChannelHealth {
    const runtime = this.runtimes.get(id);
    const connected = runtime?.status.state === 'connected';
    const lastEventAt = runtime?.status.lastEventAt;
    const manual = (this.account(id).source ?? 'manual') === 'manual';
    return { ...remote, connected, ...(lastEventAt ? { lastEventAt } : {}), ...(manual && connected && !lastEventAt ? { needsLongConnection: true } : {}) };
  }

  async startRegistration(input: ChannelRegistrationInput): Promise<ChannelRegistration> {
    const provider = this.deps.providers.find(item => item.kind === input?.kind);
    if (!provider?.register) throw new AppError('INVALID_CHANNEL_KIND', 'Unsupported channel kind');
    const appId = input.appId === undefined ? undefined : requireString(input.appId, 'appId', 200).trim();
    if (appId && !this.bindings.accounts().some(item => item.appId === appId && item.kind === input.kind)) throw new AppError('CHANNEL_ACCOUNT_NOT_FOUND', 'No such channel account', 404);
    const now = Date.now();
    for (const [id, item] of this.registrations) {
      if (item.kind === input.kind && item.state === 'waiting') this.endRegistration(item, 'cancelled');
      if (item.finishedAt && now - item.finishedAt > REGISTRATION_KEEP_MS) this.registrations.delete(id);
    }
    const id = randomUUID();
    const abort = new AbortController();
    let onReady!: (value: { url: string; expiresIn: number }) => void;
    const ready = new Promise<{ url: string; expiresIn: number }>(resolve => { onReady = resolve; });
    let onTimeout!: (error: Error) => void;
    const timedOut = new Promise<never>((_, reject) => { onTimeout = reject; });
    const owner = this.deps.owner.get().name;
    const running = provider.register({ ...(appId ? { appId } : {}), ...(owner ? { ownerName: owner } : {}), signal: abort.signal, ready: (url, expiresIn) => onReady({ url, expiresIn }) });
    // The SDK's first request can hang before it ever reports a QR code, so the wait itself is bounded, not only the scan.
    const timer = setTimeout(() => { abort.abort(); onTimeout(new Error('Timed out waiting for the QR code')); }, REGISTRATION_READY_MS);
    running.catch(() => undefined);
    const first = await Promise.race([ready, timedOut, running.then(() => undefined, error => { throw error; })]).catch(error => { clearTimeout(timer); abort.abort(); throw new AppError('CHANNEL_REGISTRATION_FAILED', message(error).slice(0, 200), 502); });
    clearTimeout(timer);
    if (abort.signal.aborted) throw new AppError('CHANNEL_REGISTRATION_FAILED', 'Registration was cancelled', 502);
    if (!first) { abort.abort(); throw new AppError('CHANNEL_REGISTRATION_FAILED', 'No QR code was issued', 502); }
    let qr: string;
    try { qr = await QRCode.toString(first.url, { type: 'svg' }); }
    catch (error) { abort.abort(); throw new AppError('CHANNEL_REGISTRATION_FAILED', message(error).slice(0, 200), 502); }
    const registration: Registration = { id, kind: input.kind, state: 'waiting', abort, url: first.url, expiresAt: Date.now() + first.expiresIn * 1000, qr } as Registration;
    this.registrations.set(id, registration);
    const expiry = setTimeout(() => this.endRegistration(registration, 'expired'), Math.max(0, registration.expiresAt - Date.now()));
    running.then(
      result => this.completeRegistration(registration, result),
      error => { if (registration.state === 'waiting') this.endRegistration(registration, registration.abort.signal.aborted ? 'cancelled' : 'failed', error); },
    ).catch(error => this.endRegistration(registration, 'failed', error)).finally(() => clearTimeout(expiry));
    return { id, url: registration.url, qr: registration.qr, expiresAt: new Date(registration.expiresAt).toISOString() };
  }

  registration(id: string): ChannelRegistrationState {
    const item = this.registrations.get(id);
    if (!item) throw new AppError('CHANNEL_REGISTRATION_NOT_FOUND', 'No such registration', 404);
    return { state: item.state, ...(item.accountId ? { accountId: item.accountId } : {}), ...(item.error ? { error: item.error } : {}) };
  }

  cancelRegistration(id: string): void {
    const item = this.registrations.get(id);
    if (item?.state === 'waiting') this.endRegistration(item, 'cancelled');
  }

  private endRegistration(item: Registration, state: 'expired' | 'failed' | 'cancelled', error?: unknown): void {
    if (item.state !== 'waiting') return;
    item.state = state;
    item.finishedAt = Date.now();
    if (error !== undefined) item.error = message(error).slice(0, 200);
    item.abort.abort();
    this.changed();
  }

  /** Creates the bot the scan produced, or updates the one with the same App ID, then binds the scanner. */
  private async completeRegistration(item: Registration, result: ProviderRegistration): Promise<void> {
    if (item.state !== 'waiting' || this.closed) return;
    const existing = this.bindings.accounts().find(account => account.kind === item.kind && account.appId === result.appId);
    const account: StoredAccount = existing
      ? { ...existing, domain: result.domain, enabled: true }
      : { id: `${item.kind}-${randomBytes(4).toString('hex')}`, kind: item.kind, appId: result.appId, domain: result.domain, enabled: true, source: 'scan' };
    this.writeSecret(account.id, result.appSecret);
    this.bindings.setAccount(account);
    this.healthCache.delete(account.id);
    if (existing) await this.disconnect(account.id);
    if (this.closed) return;
    void this.connect(account.id);
    // A cancel or expiry that came in while the old connection closed stands; the new credentials are kept.
    if (item.state !== 'waiting') return;
    if (result.userId) this.identities.bindKnown(account.id, { id: result.userId, name: this.deps.owner.get().name });
    item.accountId = account.id;
    item.state = 'done';
    item.finishedAt = Date.now();
    this.changed();
  }

  private domain(value: unknown): 'feishu' | 'lark' {
    if (value !== 'feishu' && value !== 'lark') throw new AppError('INVALID_CHANNEL_DOMAIN', 'domain must be feishu or lark');
    return value;
  }

  bindCode(accountId: string): ChannelBindCode { this.account(accountId); return this.identities.issueCode(accountId); }

  unbind(identityId: string): void {
    if (!this.identities.remove(identityId)) throw new AppError('CHANNEL_IDENTITY_NOT_FOUND', 'No such bound account', 404);
    this.changed();
  }

  patchChat(key: string, patch: { projectId?: string | null; flat?: boolean }): ChannelChat {
    const chat = this.bindings.chat(key);
    if (!chat) throw new AppError('CHANNEL_CHAT_NOT_FOUND', 'No such chat', 404);
    if (typeof patch.projectId === 'string') this.requireProject(patch.projectId);
    const updated = patch.projectId === null ? this.bindings.clearChatProject(key)! : this.bindings.touchChat(chat.account, chat.chatId, chat.chatType, { ...(typeof patch.projectId === 'string' ? { projectId: patch.projectId } : {}), ...(patch.flat !== undefined ? { flat: Boolean(patch.flat) } : {}) });
    this.changed();
    return updated;
  }

  deleteChat(key: string): void {
    if (!this.bindings.removeChat(key)) throw new AppError('CHANNEL_CHAT_NOT_FOUND', 'No such chat', 404);
    this.changed();
  }

  // ---- connections -------------------------------------------------------------------------------

  /** A reply under the conversation's last inbound message, for turns nobody typed into this chat. */
  private threadAnchor(sessionId: string, address: ChannelAddress): ReplyAnchor | undefined {
    const messageId = this.bindings.anchorOf(sessionId);
    return messageId ? { messageId, inThread: address.chatType === 'group' } : undefined;
  }

  private connectionOf(account: string): ChannelConnection | undefined { return this.runtimes.get(account)?.connection; }

  private connect(id: string): Promise<void> {
    const stored = this.account(id);
    const previous = this.runtimes.get(id);
    const runtime: Runtime = { status: { state: 'connecting' }, abort: new AbortController(), settled: Promise.resolve(), resumed: false, pending: new Set() };
    this.runtimes.set(id, runtime);
    const setStatus = (status: ChannelConnectionStatus) => { runtime.status = { ...status, ...(status.lastEventAt || runtime.status.lastEventAt ? { lastEventAt: status.lastEventAt ?? runtime.status.lastEventAt } : {}) }; this.changed(); };
    runtime.settled = (async () => {
      // A runtime left behind by a concurrent account update is shut down first, so no connection leaks.
      if (previous) { for (const runId of previous.pending) runtime.pending.add(runId); previous.abort.abort(); await previous.settled.catch(() => undefined); await previous.connection?.close().catch(() => undefined); }
      try {
        const provider = this.deps.providers.find(item => item.kind === stored.kind);
        if (!provider) throw new Error('这个版本没有对应的连接器');
        const secret = readPrivateSettingsFile(this.secretPath(id))?.trim();
        if (!secret) throw new Error('缺少 App Secret');
        const context: ChannelContext = {
          inbound: inbound => { void this.inbound(inbound).catch(error => console.warn('[channels] inbound failed', message(error))); },
          action: action => this.action(action),
          status: setStatus,
          signal: runtime.abort.signal,
          log: { info: (text, data) => console.info(`[channels] ${text}`, data ?? ''), warn: (text, data) => console.warn(`[channels] ${text}`, data ?? '') },
        };
        const connection = await provider.connect({ id, kind: stored.kind, appId: stored.appId, domain: stored.domain, enabled: true, appSecret: secret } satisfies ChannelAccount, context);
        if (runtime.abort.signal.aborted) { await connection.close().catch(() => undefined); return; }
        runtime.connection = connection;
        if (runtime.status.state === 'connecting') setStatus({ state: 'connected' });
        try { await this.resume(id, connection); }
        finally {
          runtime.resumed = true;
          for (const runId of runtime.pending) this.trackPending(runId);
          runtime.pending.clear();
        }
      } catch (error) {
        if (!runtime.abort.signal.aborted) setStatus({ state: 'error', error: message(error).slice(0, 300) });
      }
    })();
    this.changed();
    return runtime.settled;
  }

  private async disconnect(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    this.runtimes.delete(id);
    runtime.abort.abort();
    await runtime.settled.catch(() => undefined);
    await runtime.connection?.close().catch(() => undefined);
  }

  // ---- inbound -----------------------------------------------------------------------------------

  private reply(connection: ChannelConnection, m: InboundMessage, text: string): Promise<unknown> {
    return connection.send(m.address, text, m.anchor).catch(error => console.warn('[channels] reply failed', message(error)));
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
    // Strangers' chatter (any group message, any p2p text that is not a bind) never reaches the persisted record.
    if (!bound && !binding) return;
    // Recorded before any work: changing a binding later never replays old messages.
    if (!this.bindings.claim(key, now)) return;

    if (!bound) {
      if (command?.name === 'bind') {
        if (this.identities.redeem(m.account, command.code, m.sender)) { this.changed(); await this.reply(connection, m, REPLY.bound); }
        else await this.reply(connection, m, REPLY.bindFailed);
      }
      return;
    }
    const chat = this.bindings.chat(chatKey(m.account, m.address.chatId)) ?? this.bindings.touchChat(m.account, m.address.chatId, m.address.chatType);
    const conversation = this.bindings.conversation(m.address, chat.flat);
    if (m.address.chatType === 'group' && !m.mentionsBot && !conversation) return;
    if (command) { await this.command(command, m, chat, conversation?.sessionId, connection); return; }
    if (!m.text.trim() && !m.attachments.length) return;
    void connection.acknowledge(m.anchor, 'received').catch(() => undefined);
    if (!chat.projectId || !this.projectUsable(chat.projectId)) { await this.askProject(m, chat, connection, true); return; }
    await this.submit(m, chat.projectId, connection);
  }

  private async command(command: ChannelCommand, m: InboundMessage, chat: ChannelChat, sessionId: string | undefined, connection: ChannelConnection): Promise<void> {
    switch (command.name) {
      case 'bind': await this.reply(connection, m, REPLY.bound); return;
      case 'new':
        this.bindings.unbind(m.address, chat.flat);
        await this.reply(connection, m, REPLY.newSession);
        return;
      case 'stop': {
        if (!sessionId) { await this.reply(connection, m, REPLY.noSession); return; }
        try { await this.reply(connection, m, await this.stop(sessionId) ? REPLY.stopped : REPLY.nothingRunning); }
        catch (error) { await this.reply(connection, m, REPLY.failed(message(error))); }
        return;
      }
      case 'project': await this.askProject(m, chat, connection, false); return;
      case 'flat': {
        if (m.address.chatType !== 'group') { await this.reply(connection, m, REPLY.flatGroupOnly); return; }
        const flat = command.value ? command.value === 'on' : !chat.flat;
        this.bindings.touchChat(m.account, m.address.chatId, 'group', { flat });
        this.changed();
        await this.reply(connection, m, flat ? REPLY.flatOn : REPLY.flatOff);
        return;
      }
      case 'status': await this.reply(connection, m, this.statusText(chat, sessionId)); return;
      case 'model': await this.askModel(m, chat, sessionId, connection); return;
      case 'help': await this.showHelp(m, connection); return;
    }
  }

  /** The command panel; a provider without panels gets the text list. */
  private async showHelp(m: InboundMessage, connection: ChannelConnection): Promise<void> {
    try {
      const ref = this.addRef({ kind: 'panel', account: m.account, address: m.address, anchor: m.anchor, at: Date.now() });
      await connection.showPanel(m.address, { kind: 'command-panel', ref, ...panelContent(m.address.chatType) }, m.anchor);
    } catch { await this.reply(connection, m, helpText()); }
  }

  /** A command button: runs as if the operator had typed it in that chat or thread. */
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
    void this.command(command, m, chat, sessionId, connection).catch(error => console.warn('[channels] command failed', message(error)));
    return {};
  }

  private statusText(chat: ChannelChat, sessionId: string | undefined): string {
    const lines: string[] = [];
    const project = chat.projectId ? this.projectOf(chat.projectId) : undefined;
    lines.push(`项目：${project?.name ?? '未选择'}`);
    if (sessionId) {
      try {
        const session = this.deps.store.getSession(sessionId);
        const phase = this.deps.nativeBackends.status(sessionId).phase;
        lines.push(`会话：${session.title}`, `状态：${phase === 'busy' ? '进行中' : phase === 'attention' ? '等待回答' : '空闲'}`, `模型：${[session.backendId, session.model].filter(Boolean).join(' · ') || '默认'}`);
      } catch { lines.push('会话：已不存在'); }
    } else lines.push('会话：新消息会开新会话');
    if (chat.chatType === 'group') lines.push(chat.flat ? '整群共用一个会话' : '按话题分会话');
    return lines.join('\n');
  }

  // ---- model ---------------------------------------------------------------------------------------

  private readonly catalogs = new Map<string, { at: number; value: Promise<NativeBackendCatalogEntry> }>();
  private readonly backendList: { at: number; value?: Promise<Array<{ id: string; name: string }>> } = { at: 0 };

  /** Catalog reads can be slow; one read per backend/profile/session is shared for a few minutes. A press takes any age (`stale`) so it never waits on a re-read. */
  private catalogOf(backendId: string, profileId: string | undefined, project: Project | undefined, session: Session | undefined, stale: boolean): Promise<NativeBackendCatalogEntry> {
    const key = `${backendId}:${profileId ?? ''}:${session?.id ?? ''}`;
    const hit = this.catalogs.get(key);
    const expired = !hit || Date.now() - hit.at > CATALOG_TTL_MS;
    if (hit && (!expired || stale)) {
      if (expired) void this.readCatalog(key, backendId, profileId, project, session).catch(() => undefined);
      return hit.value;
    }
    return this.readCatalog(key, backendId, profileId, project, session);
  }
  private readCatalog(key: string, backendId: string, profileId: string | undefined, project: Project | undefined, session: Session | undefined): Promise<NativeBackendCatalogEntry> {
    const value = this.deps.nativeBackends.catalog(backendId, project, profileId, session, { allModels: true });
    this.catalogs.delete(key);
    this.catalogs.set(key, { at: Date.now(), value });
    // Oldest first: past a few dozen open cards the least recent read is dropped.
    while (this.catalogs.size > CATALOG_CACHE_MAX) this.catalogs.delete(this.catalogs.keys().next().value!);
    value.catch(() => { if (this.catalogs.get(key)?.value === value) this.catalogs.delete(key); });
    return value;
  }

  /** The agents a chat can pick for new conversations. */
  private backendChoices(stale: boolean): Promise<Array<{ id: string; name: string }>> {
    const hit = this.backendList.value;
    if (hit && (stale || Date.now() - this.backendList.at <= CATALOG_TTL_MS)) return hit;
    const offered = new Set<string>(this.deps.nativeBackends.offeredBackendIds());
    const value = this.deps.nativeBackends.listBackends().then(entries => entries.filter(entry => offered.has(entry.backendId) && entry.backendId !== 'chat' && entry.available).map(entry => ({ id: entry.backendId as string, name: entry.label })));
    this.backendList.value = value; this.backendList.at = Date.now();
    value.catch(() => { if (this.backendList.value === value) this.backendList.value = undefined; });
    return value;
  }

  /** What a `/model` card currently edits, read fresh: the session's own selection, or the chat's defaults for new ones. */
  private modelTarget(entry: ModelRef): { backendId: string; profileId?: string; project?: Project; session?: Session; selection: string } | undefined {
    if (entry.scope === 'session') {
      let session: Session;
      try { session = this.deps.store.getSession(entry.sessionId!); } catch { return undefined; }
      if (!session.backendId) return undefined;
      return { backendId: session.backendId, ...(session.backendProfileId ? { profileId: session.backendProfileId } : {}), project: this.projectOf(session.projectId), session, selection: entry.pending ?? session.model ?? '' };
    }
    const chat = this.bindings.chat(entry.chat);
    if (!chat) return undefined;
    const defaults = this.bindings.chatModel(chat.key);
    // The backend a new conversation would start on, resolved as `resolveNativeSessionInput` does.
    const backendId = defaults.backendId ?? defaultBackendForClient(undefined, savedDefaultBackendId(this.deps.settings.getSettings()), this.deps.nativeBackends.offeredBackendIds());
    return { backendId, project: chat.projectId ? this.projectOf(chat.projectId) : undefined, selection: defaults.model ?? '' };
  }

  private async modelView(entry: ModelRef, ref: string, options: { selection?: string; error?: string; stale?: boolean } = {}): Promise<ModelPickerView> {
    const target = this.modelTarget(entry);
    if (!target) throw new AppError('SESSION_NOT_FOUND', 'The conversation no longer exists', 404);
    const stale = options.stale ?? false;
    // A chat can still switch away from an agent that has no model list; a session has nothing else to show.
    const catalog = await this.catalogOf(target.backendId, target.profileId, target.project, target.session, stale)
      .catch(error => { if (entry.scope === 'chat') return undefined; throw error; });
    if (!catalog?.models.length && entry.scope !== 'chat') throw new AppError('NATIVE_MODEL_UNSUPPORTED', catalog?.reason ?? 'This agent has no model list', 409);
    const backends = entry.scope === 'chat' ? await this.backendChoices(stale).catch(() => undefined) : undefined;
    const running = target.session ? this.deps.nativeBackends.status(target.session.id).phase === 'busy' : false;
    return buildModelView({
      ref, scope: entry.scope, backend: { id: target.backendId, name: catalog?.label ?? backends?.find(item => item.id === target.backendId)?.name ?? target.backendId },
      ...(backends?.length ? { backends } : {}),
      models: catalog?.models ?? [], selection: options.selection ?? target.selection, ...(catalog?.defaultModel ? { defaultModel: catalog.defaultModel } : {}),
      ...(entry.scope === 'session' && running ? { note: REPLY.modelNextTurn } : {}),
      ...(options.error ? { error: options.error } : {}),
    });
  }

  /** `/model`: scoped to the conversation of this thread when there is one, else to the chat's new conversations. */
  private async askModel(m: InboundMessage, chat: ChannelChat, sessionId: string | undefined, connection: ChannelConnection): Promise<void> {
    let bound: string | undefined;
    if (sessionId) { try { bound = this.deps.store.getSession(sessionId).id; } catch { bound = undefined; } }
    const entry: ModelRef = { kind: 'model', account: m.account, address: m.address, anchor: m.anchor, at: Date.now(), scope: bound ? 'session' : 'chat', chat: chat.key, ...(bound ? { sessionId: bound } : {}) };
    const ref = this.addRef(entry);
    try {
      const view = await this.modelView(entry, ref);
      try { entry.sent = await connection.showPanel(m.address, view, m.anchor); }
      catch (error) { console.warn('[channels] model card failed', message(error)); await this.reply(connection, m, `${REPLY.modelUnavailable}：${view.summary}`); }
    } catch (error) {
      this.refs.delete(ref);
      await this.reply(connection, m, REPLY.failed(error instanceof AppError && error.statusCode < 500 ? error.message : REPLY.modelUnavailable));
    }
  }

  /** A press can wait on a cold catalog; past the platform's reply window the toast goes out alone and the card is redrawn when the press settles. */
  private async pressModel(a: InboundAction, ref: string, entry: ModelRef): Promise<ActionReply> {
    const pending = this.settleModelPress(a, ref, entry);
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([pending, new Promise<'slow'>(resolve => { timer = setTimeout(() => resolve('slow'), ANSWER_WAIT_MS); timer.unref?.(); })]);
    clearTimeout(timer);
    if (outcome !== 'slow') return outcome;
    void pending.then(async reply => {
      const connection = this.connectionOf(a.account);
      if (!entry.sent || !connection) return;
      try {
        const view = reply.redraw?.kind === 'model-picker' ? reply.redraw : await this.modelView(entry, ref, { stale: true, ...(reply.toast?.tone === 'error' ? { error: REPLY.failed(reply.toast.text) } : {}) });
        await connection.updatePanel(entry.sent, view);
      } catch { /* the next press redraws */ }
    });
    return { toast: { tone: 'info', text: '正在切换…' } };
  }

  private async settleModelPress(a: InboundAction, ref: string, entry: ModelRef): Promise<ActionReply> {
    const value = a.selectedIds?.[0];
    const target = this.modelTarget(entry);
    if (!target) return { toast: { tone: 'info', text: REPLY.cardExpired } };
    if (!value) return {};
    try {
      if (a.action === 'backend') {
        if (entry.scope !== 'chat' || !(await this.backendChoices(true)).some(item => item.id === value)) return { toast: { tone: 'error', text: '这个 Agent 不可用' } };
        this.bindings.setChatModel(entry.chat, { backendId: value });
        return { toast: { tone: 'success', text: '已切换' }, redraw: await this.modelView(entry, ref, { stale: true }) };
      }
      const catalog = await this.catalogOf(target.backendId, target.profileId, target.project, target.session, true);
      const models = catalog.models;
      const selection = target.selection || catalog.defaultModel || '';
      const current = parseSelection(resolveCatalogSelection(models, selection) ?? selection);
      const currentModel = catalogEntry(models, current.model)?.value ?? current.model;
      let next: string | undefined;
      if (a.action === 'model') {
        if (!catalogEntry(models, value)) return { toast: { tone: 'error', text: '这个模型不可用' } };
        next = catalogSelection(models, value, current.params);
      } else if (a.action.startsWith('param:')) {
        const id = a.action.slice('param:'.length);
        next = catalogSelection(models, currentModel, { ...current.params, [id]: value }, id);
      }
      if (!next) return {};
      const view = await this.modelView(entry, ref, { selection: next, stale: true });
      const toast = { tone: 'success' as const, text: REPLY.modelSwitched(view.summary) };
      if (entry.scope === 'chat') {
        // The backend is stored with the model: the model string only means something on the agent whose catalog it came from.
        this.bindings.setChatModel(entry.chat, { backendId: target.backendId, model: next });
        return { toast, redraw: view };
      }
      this.applyModel(entry, ref, target.session!.id, next, a.account);
      return { toast, redraw: view };
    } catch (error) {
      return { toast: { tone: 'error', text: error instanceof AppError && error.statusCode < 500 ? error.message : REPLY.modelUnavailable } };
    }
  }

  /** The session switch can relaunch the CLI, so it runs after the press is answered; a failure of the latest press redraws the card from the session's own selection. */
  private applyModel(entry: ModelRef, ref: string, sessionId: string, next: string, account: string): void {
    entry.pending = next;
    const run = (entry.chain ?? Promise.resolve()).then(() => configureNative(this.deps, sessionId, { model: next }));
    entry.chain = run.then(() => undefined, () => undefined);
    void run.then(() => {
      if (entry.pending === next) entry.pending = undefined;
      this.changed();
    }, async (error: unknown) => {
      const latest = entry.pending === next;
      if (latest) entry.pending = undefined;
      const text = REPLY.failed(error instanceof AppError && error.statusCode < 500 ? error.message : '服务暂时不可用');
      const connection = this.connectionOf(account);
      // A later press owns the card now; its own result redraws it.
      if (latest && entry.sent && connection) {
        try { await connection.updatePanel(entry.sent, await this.modelView(entry, ref, { error: text, stale: true })); } catch { /* the notice below still tells */ }
      }
      this.notify(sessionId, text);
    });
  }

  // ---- projects ----------------------------------------------------------------------------------

  private projectOf(id: string): Project | undefined { try { return this.deps.store.getProject(id); } catch { return undefined; } }
  private projectUsable(id: string): boolean { const project = this.projectOf(id); return Boolean(project && !project.archivedAt && !project.system); }
  private requireProject(id: string): Project {
    const project = this.projectOf(id);
    if (!project || project.archivedAt || project.system) throw new AppError('INVALID_PROJECT', 'Choose an open project');
    return project;
  }

  private projectChoices(): ProjectPickerView['projects'] {
    return this.deps.store.listProjects().filter(project => !project.archivedAt && !project.system)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, PICKER_LIMIT)
      .map(project => ({ id: project.id, name: project.name, path: project.cwd }));
  }

  /** Shows the picker; with `hold` the message waits (the latest one only) and is sent once a project is picked. */
  private async askProject(m: InboundMessage, chat: ChannelChat, connection: ChannelConnection, hold: boolean): Promise<void> {
    const projects = this.projectChoices();
    if (!projects.length) { await this.reply(connection, m, REPLY.noProjects); return; }
    if (hold) this.held.set(chat.key, { message: m, at: Date.now() });
    const ref = this.addRef({ kind: 'picker', account: m.account, chat: chat.key, at: Date.now() });
    try { await connection.showProjectPicker(m.address, { kind: 'project-picker', ref, projects, ...(chat.projectId ? { selectedId: chat.projectId } : {}) }, m.anchor); }
    catch (error) { await this.reply(connection, m, REPLY.failed(message(error))); }
  }

  // ---- submit ------------------------------------------------------------------------------------

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
      // Looked up inside the per-conversation queue: an earlier message may have just created the session.
      const existing = this.bindings.conversation(m.address, chat.flat);
      let session = existing ? (() => { try { return store.getSession(existing.sessionId); } catch { return undefined; } })() : undefined;
      const attachmentIds = await this.upload(m, session?.projectId ?? projectId);
      const input = { text: m.text.trim() || '请查看附件', attachmentIds, context: [] };
      this.anchors.set(m.messageId, m.anchor);
      if (!session) {
        const defaults = this.bindings.chatModel(chat.key);
        // A default the backend no longer accepts is dropped silently: the chat still gets its conversation.
        const sessionInput = await resolveNativeSessionInput(this.deps, { projectId, ...(defaults.backendId ? { backendId: defaults.backendId } : {}), ...(defaults.model ? { model: defaults.model } : {}) }, undefined)
          .catch(error => defaults.backendId || defaults.model ? resolveNativeSessionInput(this.deps, { projectId }, undefined) : Promise.reject(error));
        const sessionId = randomUUID();
        // Bound before the run exists, so the run's first change already finds where to write back.
        this.bindings.bind(m.address, chat.flat, sessionId, m.anchor.messageId);
        created = sessionId;
        const result = store.createNativeSubmission(sessionId, { ...sessionInput, origin: { kind: 'channel', channel: { kind: this.account(m.account).kind, account: m.account, chatId: m.address.chatId } } }, m.messageId, input);
        dispatch.kick();
        this.track(result.run);
      } else {
        this.bindings.setAnchor(session.id, m.anchor.messageId);
        const found = store.findRunByCommand(session.id, m.messageId);
        const run = found ? store.acceptNativeRun(session.id, m.messageId, input, found.native!.config) : (() => {
          sessionCommands.admit(session!);
          nativeBackends.assertAvailable(session!);
          return store.acceptNativeRun(session!.id, m.messageId, input, { model: session!.model, mode: session!.mode, approval: session!.approval });
        })();
        dispatch.kick();
        this.track(run);
      }
      this.changed();
    } catch (error) {
      this.anchors.delete(m.messageId);
      if (created) this.bindings.unbind(m.address, this.bindings.chat(chatKey(m.account, m.address.chatId))?.flat ?? false);
      void connection.acknowledge(m.anchor, 'failed').catch(() => undefined);
      await this.reply(connection, m, REPLY.failed(error instanceof AppError && error.statusCode < 500 ? error.message : '服务暂时不可用'));
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

  /** Interrupts the conversation's active turn; false when nothing is running. */
  private async stop(sessionId: string): Promise<boolean> {
    const { store, nativeBackends, dispatch } = this.deps;
    const session = store.getSession(sessionId);
    if (!store.listUnfinishedNativeRuns(sessionId).length) return false;
    const active = nativeBackends.status(sessionId).activeTurn;
    const nativeSessionId = active?.nativeSessionId ?? session.nativeSessionId;
    if (!nativeSessionId) return false;
    await dispatch.interrupt(sessionId, { requestId: randomUUID(), nativeSessionId, ...(active ? { turnId: active.turnId } : {}) });
    return true;
  }

  /** The stop control of one turn's card: cancels it while queued, interrupts it while it is the active run. */
  private async stopRun(sessionId: string, runId: string): Promise<void> {
    const { store, dispatch } = this.deps;
    if (store.getRun(runId).state === 'queued') {
      try { dispatch.cancel(sessionId, runId); return; }
      catch (error) { if (!(error instanceof AppError && error.code === 'RUN_ALREADY_DISPATCHED')) throw error; }
    }
    await this.stop(sessionId);
  }

  // ---- actions -----------------------------------------------------------------------------------

  private addRef(entry: RefEntry): string {
    const now = Date.now();
    for (const [ref, item] of this.refs) if ('at' in item && now - item.at > REF_TTL_MS) this.refs.delete(ref);
    const ref = randomBytes(9).toString('base64url');
    this.refs.set(ref, entry);
    return ref;
  }

  private async action(a: InboundAction): Promise<ActionReply> {
    if (this.closed) return { toast: { tone: 'warning', text: '服务正在关闭' } };
    // Old cards keep their buttons: the operator is checked against today's bindings every time.
    if (!this.identities.isBound(a.account, a.operator.id)) return { toast: { tone: 'error', text: '没有权限' } };
    const entry = this.refs.get(a.ref);
    if (!entry || entry.account !== a.account) return { toast: { tone: 'info', text: '这张卡片已失效' } };
    if (!this.bindings.claim(`${a.account}:action:${a.eventId}`)) return {};
    if (entry.kind === 'stop') {
      let run: Run | undefined;
      try { run = this.deps.store.getRun(entry.runId); } catch { run = undefined; }
      if (!run || isTerminalRun(run)) return { toast: { tone: 'info', text: '这个回合已结束' } };
      void this.stopRun(entry.sessionId, entry.runId).catch(error => this.notify(entry.sessionId, REPLY.failed(message(error))));
      return { toast: { tone: 'info', text: REPLY.stopped } };
    }
    if (entry.kind === 'picker') return this.pick(a, a.ref, entry);
    if (entry.kind === 'panel') return this.pressCommand(a, entry);
    if (entry.kind === 'model') return this.pressModel(a, a.ref, entry);
    return this.answer(a, entry);
  }

  private pick(a: InboundAction, ref: string, entry: Extract<RefEntry, { kind: 'picker' }>): ActionReply {
    const projectId = a.selectedIds?.[0] ?? (a.action !== 'pick' ? a.action : undefined);
    const project = projectId ? this.projectOf(projectId) : undefined;
    const chat = this.bindings.chat(entry.chat);
    if (!projectId || !project || project.archivedAt || project.system || !chat) return { toast: { tone: 'error', text: '这个项目不可用' } };
    this.bindings.touchChat(chat.account, chat.chatId, chat.chatType, { projectId });
    this.changed();
    const held = this.held.get(chat.key);
    this.held.delete(chat.key);
    const connection = this.connectionOf(a.account);
    if (held && connection && Date.now() - held.at < HOLD_MS) void this.submit(held.message, projectId, connection);
    return { toast: { tone: 'success', text: REPLY.projectChanged(project.name) }, redraw: { kind: 'project-picker', ref, projects: this.projectChoices(), selectedId: projectId, closed: true } };
  }

  private async answer(a: InboundAction, entry: Extract<RefEntry, { kind: 'interaction' }>): Promise<ActionReply> {
    const { nativeBackends, sessionLock, store } = this.deps;
    const current = nativeBackends.status(entry.sessionId).interaction;
    const follow = this.follows.get(entry.sessionId);
    if (!current || current.id !== entry.interactionId || current.revision !== entry.revision) {
      if (follow) this.syncInteraction(follow, current);
      return { toast: { tone: 'warning', text: '已在其他端处理' } };
    }
    const key = answerKey(entry.interactionId, entry.revision);
    if (follow?.answered.has(key)) return { toast: { tone: 'info', text: '已提交过' } };
    follow?.answered.add(key);
    // A form sends the picked option and the typed text together; for a single-answer question the typed text wins.
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
        this.notify(entry.sessionId, REPLY.failed(message(error)));
        return 'failed';
      }
    })();
    // The platform wants a quick reply: past the wait the toast goes out without the result.
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([pending, new Promise<'slow'>(resolve => { timer = setTimeout(() => resolve('slow'), ANSWER_WAIT_MS); timer.unref?.(); })]);
    clearTimeout(timer);
    if (outcome === 'slow') slow = true;
    if (outcome === 'failed') return { toast: { tone: 'error', text: '没有提交' } };
    return {
      toast: outcome === 'uncertain' ? { tone: 'warning', text: UNCERTAIN_TEXT } : { tone: 'success', text: '已提交' },
      redraw: this.interactionView(current, a.ref, { outcome: 'answered' }),
    };
  }

  /** A short notice in the conversation's thread, for what happened outside a message of the chat. */
  private notify(sessionId: string, text: string): void {
    const address = this.bindings.addressOf(sessionId);
    const connection = address && this.connectionOf(address.account);
    if (address && connection) void connection.send(address, text, this.threadAnchor(sessionId, address)).catch(() => undefined);
  }

  // ---- following turns ---------------------------------------------------------------------------

  private runChanged(run: Run): void {
    if (this.closed) return;
    const tracker = this.trackers.get(run.id);
    if (tracker) { if (isTerminalRun(run)) void this.finalize(tracker); else this.schedule(tracker); return; }
    if (!isTerminalRun(run)) this.track(run);
  }

  /** Starts following a run of a bound conversation; one that is not the chat's own is shown with its prompt. */
  private track(run: Run, resumed?: { surface: TurnSurface; address: ChannelAddress; anchor?: ReplyAnchor; source: TurnView['source'] }): Tracker | undefined {
    if (this.trackers.has(run.id)) return this.trackers.get(run.id);
    const address = resumed?.address ?? this.bindings.addressOf(run.sessionId);
    const runtime = address && this.runtimes.get(address.account);
    if (!address || !runtime) return undefined;
    // Cards of the previous process are taken over first; a tracker opened earlier would start a second card.
    if (!resumed && !runtime.resumed) { runtime.pending.add(run.id); return undefined; }
    const own = this.anchors.get(run.commandId);
    this.anchors.delete(run.commandId);
    const source = resumed?.source ?? (own ? 'channel' : 'other-client');
    const anchor = resumed ? resumed.anchor : own ?? this.threadAnchor(run.sessionId, address);
    const stopRef = this.addRef({ kind: 'stop', account: address.account, sessionId: run.sessionId, runId: run.id });
    const tracker: Tracker = { runId: run.id, sessionId: run.sessionId, commandId: run.commandId, address, source, ...(anchor ? { anchor } : {}), ...(resumed ? { surface: resumed.surface } : {}), finishing: false, stopRef };
    this.trackers.set(run.id, tracker);
    if (!isTerminalRun(run)) this.hold(tracker);
    this.schedule(tracker);
    return tracker;
  }

  /** A run seen before its account finished resuming; tracked now unless it moved on. */
  private trackPending(runId: string): void {
    let run: Run;
    try { run = this.deps.store.getRun(runId); } catch { return; }
    const tracker = this.track(run);
    if (tracker && isTerminalRun(run)) void this.finalize(tracker);
  }

  private hold(tracker: Tracker): void {
    let follow = this.follows.get(tracker.sessionId);
    if (!follow) {
      const created: SessionFollow = {
        sessionId: tracker.sessionId, trackers: new Set(), waiting: false, answered: new Set(), chain: Promise.resolve(),
        following: followSession({ ingest: this.deps.ingest, timeline: this.deps.timeline, control: (id, listener) => this.deps.nativeBackends.watchControl(id, listener) }, tracker.sessionId, {
          rows: () => { for (const id of created.trackers) { const item = this.trackers.get(id); if (item) this.schedule(item); } },
          status: status => this.onStatus(created, status),
          context: context => {
            const percent = context && context.size > 0 ? Math.max(0, Math.min(100, Math.round(context.used / context.size * 100))) : undefined;
            if (percent === created.contextPercent) return;
            created.contextPercent = percent;
            for (const id of created.trackers) { const item = this.trackers.get(id); if (item) this.schedule(item); }
          },
          controlFailed: error => console.warn('[channels] following without live status', message(error)),
        }),
      };
      this.follows.set(tracker.sessionId, follow = created);
    }
    follow.trackers.add(tracker.runId);
  }

  private onStatus(follow: SessionFollow, status: NativeStatus): void {
    follow.waiting = Boolean(status.interaction);
    for (const id of follow.trackers) { const tracker = this.trackers.get(id); if (tracker) this.schedule(tracker); }
    this.syncInteraction(follow, status.interaction);
  }

  private schedule(tracker: Tracker): void {
    if (tracker.finishing || tracker.timer) return;
    tracker.timer = setTimeout(() => { tracker.timer = undefined; void this.push(tracker); }, PUSH_DELAY_MS);
    tracker.timer.unref?.();
  }

  private viewOf(tracker: Tracker, final = false): TurnView {
    const { store, timeline } = this.deps;
    const run = store.getRun(tracker.runId);
    const session = store.getSession(tracker.sessionId);
    const turn = timeline.outline(session.id, 'main', 10).turns.find(item => item.runId === run.id);
    // Only this turn's rows: read from its first position, not the newest page of the whole lane.
    const rows = turn ? timeline.page(session.id, 'main', { from: turn.startPos, rows: 500, bytes: 1024 * 1024 }).rows.filter(row => row.turn === turn.turn) : [];
    const finalAnswer = final && turn && run.state === 'completed' ? timeline.turnText(session.id, turn.turn)?.answer : undefined;
    const modelName = this.modelName(session);
    const models = this.modelEntry(session)?.models;
    const contextPercent = this.follows.get(session.id)?.contextPercent;
    return projectTurn({ session, run, rows, source: tracker.source, root: this.projectOf(session.projectId)?.cwd, waiting: this.follows.get(session.id)?.waiting, stopRef: tracker.stopRef, card: this.cardOf(tracker.address.account), ...(modelName ? { modelName } : {}), ...(models?.length ? { models } : {}), ...(contextPercent !== undefined ? { contextPercent } : {}), ...(finalAnswer ? { finalAnswer } : {}) });
  }

  private ensureSurface(tracker: Tracker, view: TurnView): Promise<TurnSurface | undefined> {
    if (tracker.surface) return Promise.resolve(tracker.surface);
    const connection = this.connectionOf(tracker.address.account);
    if (!connection) return Promise.resolve(undefined);
    tracker.opening ??= connection.openTurn(tracker.address, view, tracker.anchor).then(surface => { tracker.surface = surface; return surface; }, error => {
      console.warn('[channels] could not open the turn card', message(error));
      tracker.opening = undefined;
      return undefined;
    });
    return tracker.opening;
  }

  /** Rewrites the stored card state at most every few seconds, at once when a message id first appears, and at the end. */
  private persist(tracker: Tracker, surface: TurnSurface, force = false): void {
    const state = surface.state();
    const json = JSON.stringify(state);
    if (json === tracker.persisted) return;
    const cot = state.data.cot as { messageId?: unknown } | undefined;
    const ids = JSON.stringify([state.data.messageId, state.data.extra, cot?.messageId]);
    const now = Date.now();
    const idsMoved = tracker.persisted === undefined || ids !== tracker.persistedIds;
    if (!force && !idsMoved && now - (tracker.persistedAt ?? 0) < PERSIST_EVERY_MS) return;
    tracker.persisted = json;
    tracker.persistedAt = now;
    tracker.persistedIds = ids;
    this.bindings.setSurface({ account: tracker.address.account, address: tracker.address, sessionId: tracker.sessionId, runId: tracker.runId, source: tracker.source, ...(tracker.anchor ? { anchor: tracker.anchor } : {}), state });
  }

  private async push(tracker: Tracker): Promise<void> {
    if (tracker.finishing) return;
    let view: TurnView;
    try { view = this.viewOf(tracker); } catch { return; }
    const surface = await this.ensureSurface(tracker, view);
    if (!surface || tracker.finishing) return;
    surface.update(view);
    this.persist(tracker, surface);
  }

  private async finalize(tracker: Tracker): Promise<void> {
    if (tracker.finishing) return;
    tracker.finishing = true;
    clearTimeout(tracker.timer);
    const connection = this.connectionOf(tracker.address.account);
    try {
      // The transcript read and the fold settle before the turn is closed, so the answer is complete.
      await this.deps.ingest.read(tracker.sessionId)?.catch(() => undefined);
      await this.deps.timeline.ready(tracker.sessionId, 'main').catch(() => undefined);
      // A short first turn can end before the catalog read does; wait a moment so the footer names the model.
      try {
        const loading = this.modelEntry(this.deps.store.getSession(tracker.sessionId))?.loading;
        if (loading) {
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([loading, new Promise<void>(resolve => { timer = setTimeout(resolve, MODEL_NAMES_FINAL_WAIT_MS); timer.unref?.(); })]);
          clearTimeout(timer);
        }
      } catch { /* the session is gone; the lost view follows */ }
      let view: TurnView;
      try { view = this.viewOf(tracker, true); } catch { view = this.lostView(tracker); }
      const surface = await this.ensureSurface(tracker, view);
      if (surface) await surface.finish(view);
      else if (connection && (view.answer || view.error)) await connection.send(tracker.address, view.answer || view.error!, tracker.anchor).catch(() => undefined);
      // Without a connection the card stays recorded: the next connect finishes it.
      if (surface || connection) this.bindings.removeSurface(tracker.runId);
      if (tracker.anchor && tracker.source === 'channel') void connection?.acknowledge(tracker.anchor, view.status === 'completed' ? 'done' : 'failed').catch(() => undefined);
    } catch (error) {
      console.warn('[channels] could not finish the turn card', message(error));
    } finally {
      this.release(tracker);
    }
  }

  private lostView(tracker: Pick<Tracker, 'sessionId' | 'runId' | 'source' | 'address'>): TurnView {
    return { sessionId: tracker.sessionId, runId: tracker.runId, title: '会话', status: 'interrupted', source: tracker.source, steps: [], answer: '', error: '会话已不存在', card: this.cardOf(tracker.address.account), footer: {} };
  }

  private release(tracker: Tracker): void {
    this.trackers.delete(tracker.runId);
    this.refs.delete(tracker.stopRef);
    const follow = this.follows.get(tracker.sessionId);
    if (!follow) return;
    follow.trackers.delete(tracker.runId);
    if (follow.trackers.size) return;
    this.follows.delete(tracker.sessionId);
    follow.chain = follow.chain.then(() => this.closeShown(follow, 'cancelled')).catch(() => undefined).finally(() => follow.following.close());
  }

  // ---- interaction cards -------------------------------------------------------------------------

  private syncInteraction(follow: SessionFollow, next: NativeInteraction | undefined): void {
    follow.chain = follow.chain.then(() => this.drawInteraction(follow, next)).catch(error => console.warn('[channels] interaction card failed', message(error)));
  }

  private interactionView(interaction: NativeInteraction, ref: string, closed?: InteractionView['closed']): InteractionView {
    return { kind: 'interaction', interaction, ref, ...(closed ? { closed } : {}) };
  }

  private async drawInteraction(follow: SessionFollow, next: NativeInteraction | undefined): Promise<void> {
    const address = this.bindings.addressOf(follow.sessionId);
    const connection = address && this.connectionOf(address.account);
    if (!address || !connection) return;
    const shown = follow.shown;
    if (shown && next && shown.interaction.id === next.id) {
      if (shown.interaction.revision === next.revision) return;
      // The same request moved on (the next question of a group): the card is redrawn in place under a
      // new ref; the old ref keeps its old revision, so a press from the superseded card is turned away.
      const ref = this.addRef({ kind: 'interaction', account: address.account, sessionId: follow.sessionId, interactionId: next.id, revision: next.revision });
      shown.interaction = next;
      shown.ref = ref;
      shown.refs.push(ref);
      await connection.updateInteraction(shown.sent, this.interactionView(next, ref));
      return;
    }
    if (shown) await this.closeShown(follow, [...follow.answered].some(key => key.startsWith(`${shown.interaction.id}\n`)) ? 'answered' : 'answered-elsewhere');
    if (!next) return;
    const ref = this.addRef({ kind: 'interaction', account: address.account, sessionId: follow.sessionId, interactionId: next.id, revision: next.revision });
    const anchor = [...follow.trackers].map(id => this.trackers.get(id)?.anchor).findLast(Boolean) ?? this.threadAnchor(follow.sessionId, address);
    follow.shown = { ref, refs: [ref], interaction: next, sent: await connection.showInteraction(address, this.interactionView(next, ref), anchor) };
  }

  private async closeShown(follow: SessionFollow, outcome: NonNullable<InteractionView['closed']>['outcome']): Promise<void> {
    const shown = follow.shown;
    if (!shown) return;
    follow.shown = undefined;
    for (const ref of shown.refs) this.refs.delete(ref);
    const address = this.bindings.addressOf(follow.sessionId);
    const connection = address && this.connectionOf(address.account);
    if (connection) await connection.updateInteraction(shown.sent, this.interactionView(shown.interaction, shown.ref, { outcome })).catch(() => undefined);
  }

  // ---- restart -----------------------------------------------------------------------------------

  /** Takes over the turn cards a previous process left open: follow the run on, or finish it by its result. */
  private async resume(account: string, connection: ChannelConnection): Promise<void> {
    for (const record of this.bindings.surfaces().filter(item => item.address.account === account)) {
      const existing = this.trackers.get(record.runId);
      if (existing?.surface || existing?.opening) continue;
      const surface = await connection.resumeTurn(record.address, record.state).catch(() => undefined);
      if (!surface) { this.bindings.removeSurface(record.runId); continue; }
      let run: Run | undefined;
      try { run = this.deps.store.getRun(record.runId); } catch { run = undefined; }
      if (!run) {
        await surface.finish({ sessionId: record.sessionId, runId: record.runId, title: '会话', status: 'interrupted', source: record.source, steps: [], answer: '', error: '会话已不存在', card: this.cardOf(record.address.account), footer: {} }).catch(() => undefined);
        this.bindings.removeSurface(record.runId);
        continue;
      }
      // Followed under the stored address, so a conversation unbound since still gets its card finished.
      const tracker = this.trackers.get(record.runId) ?? this.track(run, { surface, address: record.address, source: record.source, ...(record.anchor ? { anchor: record.anchor } : {}) });
      if (!tracker) { await surface.finish(this.lostView(record)).catch(() => undefined); this.bindings.removeSurface(record.runId); continue; }
      if (!tracker.surface) tracker.surface = surface;
      if (isTerminalRun(run)) await this.finalize(tracker);
    }
  }
}
