import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import type {
  ChannelAccountInfo, ChannelAccountInput, ChannelConnectionStatus, ChannelHealth,
  ChannelRegistration, ChannelRegistrationInput, ChannelRegistrationState,
} from '../../../../packages/contracts/src/channels.js';
import { AppError, requireString } from '../errors.js';
import { atomicWritePrivateFile, readPrivateSettingsFile } from '../settings/private-file.js';
import { channelKind, mergeCard, type CardPatch, type StoredAccount } from './bindings.js';
import {
  errorMessage, HEALTH_TTL_MS, REGISTRATION_KEEP_MS, REGISTRATION_READY_MS,
  type ChannelSharedState, type Registration, type Runtime,
} from './shared.js';
import type { ChannelAccount, ChannelConnection, ChannelContext, ChannelProvider, InboundAction, InboundMessage, ProviderRegistration, ActionReply } from './types.js';

const CARD_FIELDS = ['header', 'process', 'stopButton'] as const;
const FOOTER_FIELDS = ['model', 'changes', 'context', 'elapsed'] as const;

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

export class ChannelAccounts {
  constructor(
    private readonly state: ChannelSharedState,
    private readonly handlers: {
      onInbound: (m: InboundMessage) => Promise<void>;
      onAction: (a: InboundAction) => Promise<ActionReply>;
      onResume: (account: string, connection: ChannelConnection) => Promise<void>;
      onTrackPending: (runId: string) => void;
    },
  ) {}

  newAccountId(kind: string): string {
    return `${kind.slice(kind.lastIndexOf('/') + 1)}-${randomBytes(4).toString('hex')}`;
  }

  secretPath(id: string): string { return join(this.state.deps.stateDir, 'channels', `${id}.secret`); }

  writeSecret(id: string, secret: string): void {
    mkdirSync(join(this.state.deps.stateDir, 'channels'), { recursive: true, mode: 0o700 });
    atomicWritePrivateFile(this.secretPath(id), secret);
  }

  domain(value: unknown): 'feishu' | 'lark' {
    if (value !== 'feishu' && value !== 'lark') throw new AppError('INVALID_CHANNEL_DOMAIN', 'domain must be feishu or lark');
    return value;
  }

  account(id: string): StoredAccount {
    const account = this.state.bindings.accounts().find(item => item.id === id);
    if (!account) throw new AppError('CHANNEL_ACCOUNT_NOT_FOUND', 'No such channel account', 404);
    return account;
  }

  info(account: StoredAccount): ChannelAccountInfo {
    const status = this.state.runtimes.get(account.id)?.status ?? { state: account.enabled ? 'connecting' as const : 'disabled' as const };
    const connection = this.state.runtimes.get(account.id)?.connection;
    const { source: _source, card, ...rest } = account;
    const links = this.state.provider(account.kind)?.links(account) ?? {};
    return { ...rest, ...(connection?.botName ? { botName: connection.botName } : {}), ...(connection?.avatarUrl ? { avatarUrl: connection.avatarUrl } : {}), secretSet: existsSync(this.secretPath(account.id)), status, links, card: mergeCard(card) };
  }

  async createAccount(input: ChannelAccountInput): Promise<ChannelAccountInfo> {
    const kind = typeof input?.kind === 'string' ? channelKind(input.kind) : undefined;
    if (!kind || !this.state.provider(kind)) throw new AppError('INVALID_CHANNEL_KIND', 'Unsupported channel kind');
    const account: StoredAccount = { id: this.newAccountId(kind), kind, appId: requireString(input.appId, 'appId', 200).trim(), domain: this.domain(input.domain), enabled: input.enabled !== false, source: 'manual' };
    this.writeSecret(account.id, requireString(input.appSecret, 'appSecret', 500).trim());
    this.state.bindings.setAccount(account);
    if (account.enabled) void this.connect(account.id);
    this.state.changed();
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
      this.state.bindings.setAccount(next);
      this.state.changed();
      return this.info(next);
    }
    if (patch.appSecret !== undefined) this.writeSecret(id, requireString(patch.appSecret, 'appSecret', 500).trim());
    this.state.bindings.setAccount(next);
    this.state.healthCache.delete(id);
    await this.disconnect(id);
    if (next.enabled) void this.connect(id);
    this.state.changed();
    return this.info(next);
  }

  async deleteAccount(id: string): Promise<void> {
    this.account(id);
    await this.disconnect(id);
    this.state.healthCache.delete(id);
    this.state.bindings.removeAccount(id);
    try { rmSync(this.secretPath(id), { force: true }); } catch { /* nothing to remove */ }
    this.state.changed();
  }

  async health(id: string, refresh = false): Promise<ChannelHealth> {
    const stored = this.account(id);
    const cached = this.state.healthCache.get(id);
    if (!refresh && cached && Date.now() - cached.at < HEALTH_TTL_MS) return this.liveHealth(id, cached.value);
    const provider = this.state.provider(stored.kind);
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
    this.state.healthCache.set(id, { at: Date.now(), value });
    return this.liveHealth(id, value);
  }

  private liveHealth(id: string, remote: ChannelHealth): ChannelHealth {
    const runtime = this.state.runtimes.get(id);
    const connected = runtime?.status.state === 'connected';
    const lastEventAt = runtime?.status.lastEventAt;
    const manual = (this.account(id).source ?? 'manual') === 'manual';
    return { ...remote, connected, ...(lastEventAt ? { lastEventAt } : {}), ...(manual && connected && !lastEventAt ? { needsLongConnection: true } : {}) };
  }

  async startRegistration(input: ChannelRegistrationInput): Promise<ChannelRegistration> {
    const kind = typeof input?.kind === 'string' ? channelKind(input.kind) : undefined;
    const provider = kind ? this.state.provider(kind) : undefined;
    if (!kind || !provider?.register) throw new AppError('INVALID_CHANNEL_KIND', 'Unsupported channel kind');
    const appId = input.appId === undefined ? undefined : requireString(input.appId, 'appId', 200).trim();
    if (appId && !this.state.bindings.accounts().some(item => item.appId === appId && item.kind === kind)) throw new AppError('CHANNEL_ACCOUNT_NOT_FOUND', 'No such channel account', 404);
    const now = Date.now();
    for (const [id, item] of this.state.registrations) {
      if (item.kind === kind && item.state === 'waiting') this.endRegistration(item, 'cancelled');
      if (item.finishedAt && now - item.finishedAt > REGISTRATION_KEEP_MS) this.state.registrations.delete(id);
    }
    const id = randomUUID();
    const abort = new AbortController();
    let onReady!: (value: { url: string; expiresIn: number }) => void;
    const ready = new Promise<{ url: string; expiresIn: number }>(resolve => { onReady = resolve; });
    let onTimeout!: (error: Error) => void;
    const timedOut = new Promise<never>((_, reject) => { onTimeout = reject; });
    const owner = this.state.deps.owner.get().name;
    const running = provider.register({ ...(appId ? { appId } : {}), ...(owner ? { ownerName: owner } : {}), signal: abort.signal, ready: (url, expiresIn) => onReady({ url, expiresIn }) });
    const timer = setTimeout(() => { abort.abort(); onTimeout(new Error('Timed out waiting for the QR code')); }, REGISTRATION_READY_MS);
    running.catch(() => undefined);
    const first = await Promise.race([ready, timedOut, running.then(() => undefined, error => { throw error; })]).catch(error => { clearTimeout(timer); abort.abort(); throw new AppError('CHANNEL_REGISTRATION_FAILED', errorMessage(error).slice(0, 200), 502); });
    clearTimeout(timer);
    if (abort.signal.aborted) throw new AppError('CHANNEL_REGISTRATION_FAILED', 'Registration was cancelled', 502);
    if (!first) { abort.abort(); throw new AppError('CHANNEL_REGISTRATION_FAILED', 'No QR code was issued', 502); }
    let qr: string;
    try { qr = await QRCode.toString(first.url, { type: 'svg' }); }
    catch (error) { abort.abort(); throw new AppError('CHANNEL_REGISTRATION_FAILED', errorMessage(error).slice(0, 200), 502); }
    const registration: Registration = { id, kind, state: 'waiting', abort, url: first.url, expiresAt: Date.now() + first.expiresIn * 1000, qr } as Registration;
    this.state.registrations.set(id, registration);
    const expiry = setTimeout(() => this.endRegistration(registration, 'expired'), Math.max(0, registration.expiresAt - Date.now()));
    running.then(
      result => this.completeRegistration(registration, result),
      error => { if (registration.state === 'waiting') this.endRegistration(registration, registration.abort.signal.aborted ? 'cancelled' : 'failed', error); },
    ).catch(error => this.endRegistration(registration, 'failed', error)).finally(() => clearTimeout(expiry));
    return { id, url: registration.url, qr: registration.qr, expiresAt: new Date(registration.expiresAt).toISOString() };
  }

  registration(id: string): ChannelRegistrationState {
    const item = this.state.registrations.get(id);
    if (!item) throw new AppError('CHANNEL_REGISTRATION_NOT_FOUND', 'No such registration', 404);
    return { state: item.state, ...(item.accountId ? { accountId: item.accountId } : {}), ...(item.error ? { error: item.error } : {}) };
  }

  cancelRegistration(id: string): void {
    const item = this.state.registrations.get(id);
    if (item?.state === 'waiting') this.endRegistration(item, 'cancelled');
  }

  private endRegistration(item: Registration, state: 'expired' | 'failed' | 'cancelled', error?: unknown): void {
    if (item.state !== 'waiting') return;
    item.state = state;
    item.finishedAt = Date.now();
    if (error !== undefined) item.error = errorMessage(error).slice(0, 200);
    item.abort.abort();
    this.state.changed();
  }

  private async completeRegistration(item: Registration, result: ProviderRegistration): Promise<void> {
    if (item.state !== 'waiting' || this.state.isClosed()) return;
    const existing = this.state.bindings.accounts().find(account => account.kind === item.kind && account.appId === result.appId);
    const account: StoredAccount = existing
      ? { ...existing, domain: result.domain, enabled: true }
      : { id: this.newAccountId(item.kind), kind: item.kind, appId: result.appId, domain: result.domain, enabled: true, source: 'scan' };
    this.writeSecret(account.id, result.appSecret);
    this.state.bindings.setAccount(account);
    this.state.healthCache.delete(account.id);
    if (existing) await this.disconnect(account.id);
    if (this.state.isClosed()) return;
    void this.connect(account.id);
    if (item.state !== 'waiting') return;
    if (result.userId) this.state.identities.bindKnown(account.id, { id: result.userId, name: this.state.deps.owner.get().name });
    item.accountId = account.id;
    item.state = 'done';
    item.finishedAt = Date.now();
    this.state.changed();
  }

  connect(id: string): Promise<void> {
    const stored = this.account(id);
    const previous = this.state.runtimes.get(id);
    const runtime: Runtime = { status: { state: 'connecting' }, abort: new AbortController(), settled: Promise.resolve(), resumed: false, pending: new Set() };
    this.state.runtimes.set(id, runtime);
    const setStatus = (status: ChannelConnectionStatus) => { runtime.status = { ...status, ...(status.lastEventAt || runtime.status.lastEventAt ? { lastEventAt: status.lastEventAt ?? runtime.status.lastEventAt } : {}) }; this.state.changed(); };
    runtime.settled = (async () => {
      if (previous) { for (const runId of previous.pending) runtime.pending.add(runId); previous.abort.abort(); await previous.settled.catch(() => undefined); await previous.connection?.close().catch(() => undefined); }
      try {
        const provider = this.state.provider(stored.kind);
        runtime.provider = provider;
        if (!provider) throw new Error('提供这个通道的插件没有启用');
        const secret = readPrivateSettingsFile(this.secretPath(id))?.trim();
        if (!secret) throw new Error('缺少 App Secret');
        const context: ChannelContext = {
          inbound: inbound => { void this.handlers.onInbound(inbound).catch(error => console.warn('[channels] inbound failed', errorMessage(error))); },
          action: action => this.handlers.onAction(action),
          status: setStatus,
          signal: runtime.abort.signal,
          log: { info: (text, data) => console.info(`[channels] ${text}`, data ?? ''), warn: (text, data) => console.warn(`[channels] ${text}`, data ?? '') },
        };
        const connection = await provider.connect({ id, kind: stored.kind, appId: stored.appId, domain: stored.domain, enabled: true, appSecret: secret } satisfies ChannelAccount, context);
        if (runtime.abort.signal.aborted) { await connection.close().catch(() => undefined); return; }
        runtime.connection = connection;
        if (runtime.status.state === 'connecting') setStatus({ state: 'connected' });
        try { await this.handlers.onResume(id, connection); }
        finally {
          runtime.resumed = true;
          for (const runId of runtime.pending) this.handlers.onTrackPending(runId);
          runtime.pending.clear();
        }
      } catch (error) {
        if (!runtime.abort.signal.aborted) setStatus({ state: 'error', error: errorMessage(error).slice(0, 300) });
      }
    })();
    this.state.changed();
    return runtime.settled;
  }

  async disconnect(id: string): Promise<void> {
    const runtime = this.state.runtimes.get(id);
    if (!runtime) return;
    this.state.runtimes.delete(id);
    runtime.abort.abort();
    await runtime.settled.catch(() => undefined);
    await runtime.connection?.close().catch(() => undefined);
  }
}
