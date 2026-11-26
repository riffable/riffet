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
import { accountConfig, channelKind, mergeCard, type CardPatch, type StoredAccount } from './bindings.js';
import {
  errorMessage, HEALTH_TTL_MS, REGISTRATION_KEEP_MS, REGISTRATION_READY_MS,
  type ChannelSharedState, type Registration, type Runtime,
} from './shared.js';
import type {
  ActionReply, ChannelAccount, ChannelConnection, ChannelContext, ChannelProvider,
  InboundAction, InboundMessage, ProviderRegistration,
} from './types.js';

const CARD_FIELDS = ['header', 'process', 'stopButton'] as const;
const FOOTER_FIELDS = ['model', 'changes', 'context', 'elapsed'] as const;
const MAX_FIELD_LEN = 500;

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

function stringMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AppError('INVALID_INPUT', `${label} must be an object`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new AppError('INVALID_INPUT', `${label}.${key} must be a string`);
    if (item.length > MAX_FIELD_LEN) throw new AppError('INVALID_INPUT', `${label}.${key} is too long`);
    out[key] = item.trim();
  }
  return out;
}

function incomingConfig(input: Partial<ChannelAccountInput>): Record<string, string> {
  const out = stringMap(input.config, 'config');
  if (input.appId !== undefined) out.appId = requireString(input.appId, 'appId', MAX_FIELD_LEN).trim();
  if (input.domain !== undefined) out.domain = requireString(input.domain, 'domain', MAX_FIELD_LEN).trim();
  return out;
}

function incomingSecrets(input: Partial<ChannelAccountInput>): Record<string, string> {
  const out = stringMap(input.secrets, 'secrets');
  if (input.appSecret !== undefined) out.appSecret = requireString(input.appSecret, 'appSecret', MAX_FIELD_LEN).trim();
  return out;
}

function primaryExternalId(provider: ChannelProvider | undefined, config: Record<string, string>): string | undefined {
  const immutable = provider?.meta?.fields.find(field => field.kind === 'text' && field.immutable);
  if (immutable && config[immutable.key]) return config[immutable.key];
  return config.appId || undefined;
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

  readSecrets(id: string): Record<string, string> {
    const raw = readPrivateSettingsFile(this.secretPath(id))?.trim();
    if (!raw) return {};
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0));
        }
      } catch { /* fall through to legacy plain secret */ }
    }
    // Pre-generalization Feishu secret files stored the raw appSecret as plain text.
    return { appSecret: raw };
  }

  writeSecrets(id: string, secrets: Record<string, string>): void {
    const cleaned = Object.fromEntries(Object.entries(secrets).filter(([, value]) => value.length > 0));
    if (!Object.keys(cleaned).length) {
      try { rmSync(this.secretPath(id), { force: true }); } catch { /* nothing to remove */ }
      return;
    }
    mkdirSync(join(this.state.deps.stateDir, 'channels'), { recursive: true, mode: 0o700 });
    atomicWritePrivateFile(this.secretPath(id), JSON.stringify(cleaned));
  }

  account(id: string): StoredAccount {
    const account = this.state.bindings.accounts().find(item => item.id === id);
    if (!account) throw new AppError('CHANNEL_ACCOUNT_NOT_FOUND', 'No such channel account', 404);
    return account;
  }

  private resolveFields(
    provider: ChannelProvider | undefined,
    rawConfig: Record<string, string>,
    rawSecrets: Record<string, string>,
    previous?: { config: Record<string, string>; secrets: Record<string, string> },
  ): { config: Record<string, string>; secrets: Record<string, string> } {
    const fields = provider?.meta?.fields;
    if (!fields?.length) {
      const config = { ...(previous?.config ?? {}) };
      for (const [key, value] of Object.entries(rawConfig)) { if (value) config[key] = value; else delete config[key]; }
      const secrets = { ...(previous?.secrets ?? {}) };
      for (const [key, value] of Object.entries(rawSecrets)) { if (value) secrets[key] = value; else delete secrets[key]; }
      return { config, secrets };
    }
    const config: Record<string, string> = { ...(previous?.config ?? {}) };
    const secrets: Record<string, string> = { ...(previous?.secrets ?? {}) };
    for (const field of fields) {
      if (field.kind === 'secret') {
        const provided = Object.hasOwn(rawSecrets, field.key) ? rawSecrets[field.key]! : undefined;
        if (provided !== undefined) {
          if (provided) secrets[field.key] = provided;
          else if (field.required) throw new AppError('INVALID_CHANNEL_FIELD', `${field.key} is required`);
          else delete secrets[field.key];
        } else if (!previous && field.required && !secrets[field.key]) {
          throw new AppError('INVALID_CHANNEL_FIELD', `${field.key} is required`);
        }
        continue;
      }
      const provided = Object.hasOwn(rawConfig, field.key) ? rawConfig[field.key]! : undefined;
      if (previous && field.immutable && provided !== undefined && provided !== (previous.config[field.key] ?? '')) {
        throw new AppError('INVALID_CHANNEL_FIELD', `${field.key} cannot be changed`);
      }
      const value = provided !== undefined ? provided : (previous ? config[field.key] : field.defaultValue);
      if (!value) {
        if (field.required) throw new AppError('INVALID_CHANNEL_FIELD', `${field.key} is required`);
        delete config[field.key];
        continue;
      }
      if (field.kind === 'select' && field.options?.length && !field.options.some(option => option.value === value)) {
        throw new AppError('INVALID_CHANNEL_FIELD', `${field.key} is invalid`);
      }
      config[field.key] = value;
    }
    return { config, secrets };
  }

  private missingRequiredSecrets(provider: ChannelProvider, secrets: Record<string, string>): string[] {
    if (provider.meta !== undefined) {
      return provider.meta.fields.filter(field => field.kind === 'secret' && field.required && !secrets[field.key]).map(field => field.key);
    }
    return Object.values(secrets).some(Boolean) ? [] : ['secret'];
  }

  private resolveDefaultProject(value: string | null | undefined, previous?: string): string | undefined {
    if (value === undefined) return previous;
    if (value === null) return undefined;
    const trimmed = requireString(value, 'defaultProjectId', MAX_FIELD_LEN).trim();
    if (!trimmed) return undefined;
    const project = this.state.projectOf(trimmed);
    if (!project || project.archivedAt || project.system) throw new AppError('INVALID_PROJECT', 'Choose an open project');
    return project.id;
  }

  private toChannelAccount(stored: StoredAccount, secrets: Record<string, string>): ChannelAccount {
    return {
      id: stored.id,
      kind: stored.kind,
      config: accountConfig(stored),
      secrets,
      enabled: stored.enabled,
      source: stored.source ?? 'manual',
    };
  }

  info(account: StoredAccount): ChannelAccountInfo {
    const status = this.state.runtimes.get(account.id)?.status ?? { state: account.enabled ? 'connecting' as const : 'disabled' as const };
    const connection = this.state.runtimes.get(account.id)?.connection;
    const provider = this.state.provider(account.kind);
    const config = accountConfig(account);
    const providerLinks = provider?.links?.({ id: account.id, config, source: account.source ?? 'manual' }) ?? {};
    const links = {
      ...(providerLinks.open ? { open: providerLinks.open } : {}),
      ...(providerLinks.console ? { console: providerLinks.console } : {}),
      ...(connection?.links?.open ? { open: connection.links.open } : {}),
      ...(connection?.links?.console ? { console: connection.links.console } : {}),
    };
    const badge = provider?.badge?.({ config });
    const identity = connection?.identity ?? provider?.identity?.({ config }, connection);
    return {
      id: account.id,
      kind: account.kind,
      config,
      appId: config.appId ?? '',
      domain: config.domain ?? '',
      enabled: account.enabled,
      ...(connection?.botName ? { botName: connection.botName } : {}),
      ...(connection?.avatarUrl ? { avatarUrl: connection.avatarUrl } : {}),
      ...(badge ? { badge } : {}),
      ...(identity ? { identity } : {}),
      secretSet: existsSync(this.secretPath(account.id)),
      status,
      links,
      card: mergeCard(account.card),
      ...(account.defaultProjectId ? { defaultProjectId: account.defaultProjectId } : {}),
    };
  }

  async createAccount(input: ChannelAccountInput): Promise<ChannelAccountInfo> {
    const kind = typeof input?.kind === 'string' ? channelKind(input.kind) : undefined;
    const provider = kind ? this.state.provider(kind) : undefined;
    if (!kind || !provider) throw new AppError('INVALID_CHANNEL_KIND', 'Unsupported channel kind');
    const { config, secrets } = this.resolveFields(provider, incomingConfig(input), incomingSecrets(input));
    const defaultProjectId = this.resolveDefaultProject(input.defaultProjectId);
    const externalId = primaryExternalId(provider, config);
    const account: StoredAccount = {
      id: this.newAccountId(kind),
      kind,
      config,
      ...(externalId ? { externalId } : {}),
      ...(defaultProjectId ? { defaultProjectId } : {}),
      enabled: input.enabled !== false,
      source: 'manual',
    };
    this.writeSecrets(account.id, secrets);
    this.state.bindings.setAccount(account);
    if (account.enabled) void this.connect(account.id);
    this.state.changed();
    return this.info(account);
  }

  async updateAccount(id: string, patch: Partial<ChannelAccountInput>): Promise<ChannelAccountInfo> {
    const current = this.account(id);
    const provider = this.state.provider(current.kind);
    const hasConfigOrSecret = patch.config !== undefined || patch.secrets !== undefined
      || patch.appId !== undefined || patch.domain !== undefined || patch.appSecret !== undefined;
    const nextDefaultProjectId = this.resolveDefaultProject(patch.defaultProjectId, current.defaultProjectId);
    if ((patch.card !== undefined || patch.defaultProjectId !== undefined) && !hasConfigOrSecret && patch.enabled === undefined) {
      const next: StoredAccount = {
        ...current,
        ...(patch.card !== undefined ? { card: mergeCard(current.card, validCard(patch.card)) } : {}),
      };
      if (nextDefaultProjectId) next.defaultProjectId = nextDefaultProjectId; else delete next.defaultProjectId;
      this.state.bindings.setAccount(next);
      this.state.changed();
      return this.info(next);
    }
    const previousConfig = accountConfig(current);
    const previousSecrets = this.readSecrets(id);
    const resolved = hasConfigOrSecret
      ? this.resolveFields(provider, incomingConfig(patch), incomingSecrets(patch), { config: previousConfig, secrets: previousSecrets })
      : { config: previousConfig, secrets: previousSecrets };
    const externalId = current.externalId ?? primaryExternalId(provider, resolved.config);
    const next: StoredAccount = {
      ...current,
      config: resolved.config,
      ...(externalId ? { externalId } : {}),
      ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
      ...(patch.card !== undefined ? { card: mergeCard(current.card, validCard(patch.card)) } : {}),
    };
    if (nextDefaultProjectId) next.defaultProjectId = nextDefaultProjectId; else delete next.defaultProjectId;
    delete next.appId;
    delete next.domain;
    if (hasConfigOrSecret) this.writeSecrets(id, resolved.secrets);
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
    // An explicit refresh retries accounts that failed during initial connect (e.g. network not ready yet).
    if (refresh && stored.enabled) {
      const runtime = this.state.runtimes.get(id);
      if (!runtime?.connection && runtime?.status.state !== 'connecting') {
        void this.connect(id);
      }
    }
    const cached = this.state.healthCache.get(id);
    if (!refresh && cached && Date.now() - cached.at < HEALTH_TTL_MS) return this.liveHealth(id, cached.value);
    const provider = this.state.provider(stored.kind);
    let remote: Awaited<ReturnType<NonNullable<ChannelProvider['health']>>> = {};
    const secrets = this.readSecrets(id);
    if (provider?.health && this.missingRequiredSecrets(provider, secrets).length === 0) {
      try { remote = await provider.health(this.toChannelAccount(stored, secrets)); } catch { remote = {}; }
    }
    const config = accountConfig(stored);
    const grantUrl = remote.missingScopes?.length ? provider?.links?.({ id, config, source: stored.source ?? 'manual' }, remote.missingScopes).grant : undefined;
    const value: ChannelHealth = {
      connected: false,
      ...(remote.activated !== undefined ? { activated: remote.activated } : {}),
      ...(remote.missingScopes ? { missingScopes: remote.missingScopes } : {}),
      ...(grantUrl ? { grantUrl } : {}),
    };
    this.state.healthCache.set(id, { at: Date.now(), value });
    return this.liveHealth(id, value);
  }

  private liveHealth(id: string, remote: ChannelHealth): ChannelHealth {
    const stored = this.account(id);
    const runtime = this.state.runtimes.get(id);
    const provider = this.state.provider(stored.kind);
    const connected = runtime?.status.state === 'connected';
    const lastEventAt = runtime?.status.lastEventAt;
    const manual = (stored.source ?? 'manual') === 'manual';
    const needsManualStep = Boolean(provider?.meta?.hints?.manualSetupStep) && manual && connected && !lastEventAt;
    return {
      ...remote,
      connected,
      ...(lastEventAt ? { lastEventAt } : {}),
      ...(needsManualStep ? { needsLongConnection: true } : {}),
    };
  }

  async startRegistration(input: ChannelRegistrationInput): Promise<ChannelRegistration> {
    const kind = typeof input?.kind === 'string' ? channelKind(input.kind) : undefined;
    const provider = kind ? this.state.provider(kind) : undefined;
    if (!kind || !provider?.register) throw new AppError('INVALID_CHANNEL_KIND', 'Unsupported channel kind');
    const rawExternal = input.externalId ?? input.appId;
    const externalId = rawExternal === undefined ? undefined : requireString(rawExternal, 'externalId', MAX_FIELD_LEN).trim();
    if (externalId && !this.state.bindings.accounts().some(item => item.kind === kind && (item.externalId === externalId || accountConfig(item).appId === externalId))) {
      throw new AppError('CHANNEL_ACCOUNT_NOT_FOUND', 'No such channel account', 404);
    }
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
    const running = provider.register({
      ...(externalId ? { externalId, appId: externalId } : {}),
      ...(owner ? { ownerName: owner } : {}),
      signal: abort.signal,
      ready: (url, expiresIn) => onReady({ url, expiresIn }),
    });
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
    const config: Record<string, string> = {
      ...(result.appId ? { appId: result.appId } : {}),
      ...(result.domain ? { domain: result.domain } : {}),
      ...(result.config ?? {}),
    };
    const secrets: Record<string, string> = {
      ...(result.appSecret ? { appSecret: result.appSecret } : {}),
      ...(result.secrets ?? {}),
    };
    const externalId = result.externalId ?? result.appId ?? config.appId;
    const existing = externalId
      ? this.state.bindings.accounts().find(account => account.kind === item.kind && (account.externalId === externalId || accountConfig(account).appId === externalId))
      : undefined;
    const account: StoredAccount = existing
      ? { ...existing, config: { ...accountConfig(existing), ...config }, ...(externalId ? { externalId } : {}), enabled: true }
      : { id: this.newAccountId(item.kind), kind: item.kind, config, ...(externalId ? { externalId } : {}), enabled: true, source: 'scan' };
    delete account.appId;
    delete account.domain;
    this.writeSecrets(account.id, secrets);
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
        const secrets = this.readSecrets(id);
        const missing = this.missingRequiredSecrets(provider, secrets);
        if (missing.length) throw new Error('缺少机器人凭据');
        const context: ChannelContext = {
          inbound: inbound => { void this.handlers.onInbound(inbound).catch(error => console.warn('[channels] inbound failed', errorMessage(error))); },
          action: action => this.handlers.onAction(action),
          status: setStatus,
          signal: runtime.abort.signal,
          log: { info: (text, data) => console.info(`[channels] ${text}`, data ?? ''), warn: (text, data) => console.warn(`[channels] ${text}`, data ?? '') },
        };
        const connection = await provider.connect(this.toChannelAccount(stored, secrets), context);
        if (runtime.abort.signal.aborted) { await connection.close().catch(() => undefined); return; }
        runtime.connection = connection;
        if (connection.ownerIdentity?.id && !this.state.identities.isBound(id, connection.ownerIdentity.id)) {
          this.state.identities.bindKnown(id, { id: connection.ownerIdentity.id, name: connection.ownerIdentity.name ?? this.state.deps.owner.get().name });
          this.state.changed();
        }
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
