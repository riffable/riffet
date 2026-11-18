import { createHash } from 'node:crypto';
import type {
  GatewayProtocol, LoadedExtensions, ModelInfo, NativeBackendCatalogEntry, NativeBackendId, NativeBackendUsage,
  NativeBackendProfileSettings, NativeBackendProfilesResponse, NativeModelApiProtocol, NativeModelSource, NativeProfileContinuation, NativeSlashCatalog, NativeSlashItem, Project, Session,
} from '../../../../packages/contracts/src/index.js';
import { AppError } from '../errors.js';
import type { TerminalLaunchEnv } from '../terminal/service.js';
import { validateNativeModelApiProtocol, validateNativeModelSource, validateNativeProfileEndpoint } from '../settings/index.js';
import { piProviderModels } from './pi/provider.js';
import { fetchGatewayModels } from './shared/gateway-models.js';
import { modelSourceOf, modelSourceProvider, modelSourceRole, prepareSource, sourceCatalog, sourceUsage } from './shared/model-source.js';
import { modelFamily, parseNativeModelSelection } from './shared/model-selection.js';
import { NativeBackendRegistry, isNativeBackendId } from './registry.js';
import { FreshCache } from './shared/fresh-cache.js';
import { cliVersionReport } from './shared/cli-version.js';
import { backendIdOf } from '../session-identity.js';
import type { NativeBackendAvailability, NativeBackendDriver, NativeBackendHost, NativeBackendProfileConfig, NativeBackendTraits, NativePrewarmRequest, NativePrewarmResult } from './types.js';

const MODEL_LIST_FRESH_MS = 5 * 60_000;
const MAX_MODEL_LISTINGS = 64;
/** Load moves by the minute, so a usage read is only reused briefly; it still spares a CLI spawn per open picker. */
const USAGE_FRESH_MS = 30_000;
/** Past fresh, a reading this young answers at once while the next read runs behind it; an older one waits for that read. */
const USAGE_STALE_MS = 5 * 60_000;
/** Availability probes spawn a CLI; this is short enough to notice an install and long enough to poll. */
const AVAILABILITY_FRESH_MS = 30_000;
const MAX_AVAILABILITY_ENTRIES = 32;

/** Skills change when someone edits a file, so a listing is short-lived; a stale one still answers at once. */
const SLASH_LIST_FRESH_MS = 60_000;
/** A probe of what a launch loads may start a CLI; the extension management drops it when it writes. */
const LOADED_EXTENSIONS_FRESH_MS = 5 * 60_000;
const LOADED_EXTENSIONS_DEADLINE_MS = 20_000;

/** `work`, or a rejection after `ms`; the work itself is not cancelled. */
function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); timer.unref?.(); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * One entry per name. A discovered entry replaces a static built-in of the same name, since the
 * provider describes its own command better; among discovered entries the first wins, which is
 * the provider's own precedence order.
 */
export function mergeSlashItems(builtins: NativeSlashItem[], discovered: NativeSlashItem[]): NativeSlashItem[] {
  const byName = new Map<string, NativeSlashItem>();
  for (const item of discovered) if (item.name && !byName.has(item.name)) byName.set(item.name, item);
  const result = builtins.filter(item => !byName.has(item.name));
  return [...result, ...byName.values()];
}

interface AvailabilityEntry { result: NativeBackendAvailability; checkedAt: number }

/** Rated from the version the availability probe already read; nothing is spawned for it. */
function cliVersionOf(driver: NativeBackendDriver, availability: NativeBackendAvailability): Pick<NativeBackendCatalogEntry, 'cliVersion'> {
  return driver.cliVersions ? { cliVersion: cliVersionReport(driver.cliVersions, availability.version) } : {};
}

export function safeBackendReason(reason: string, profile: NativeBackendProfileConfig): string {
  let safe = reason;
  for (const [key, value] of Object.entries(profile.config)) {
    if (!/(?:secret|token|password|credential|api[_-]?key)/i.test(key) || typeof value !== 'string' || !value) continue;
    safe = safe.split(value).join('[REDACTED]');
  }
  return safe
    .replace(/(\b(?:secret|token|password|credential|api[_-]?key|authorization)\b\s*[:=]\s*)([^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s,;}]+/gi, 'Bearer [REDACTED]')
    .slice(0, 1000);
}

/**
 * Narrows a backend's catalog to the models a profile exposes. An absent list means the profile
 * has not been curated, so everything shows; an empty one is an explicit choice and is kept
 * empty. The session's current model always survives, otherwise narrowing the list would leave
 * an active conversation pointing at a model its own picker no longer offers.
 *
 * The list also carries ids the catalog does not mention. A gateway that cannot be interrogated
 * is still usable that way: the user types the ids by hand and they become the catalog.
 */
export function curateModels(models: ModelInfo[], profile: NativeBackendProfileConfig, session?: Session, normalize: (id: string) => string = id => id): ModelInfo[] {
  const enabled = profile.config.enabledModels;
  if (!Array.isArray(enabled)) return models;
  const known = new Map(models.map(model => [model.value, model]));
  // A canonical value always wins over another entry's alias, so only register aliases the
  // catalog itself does not already name.
  const aliases = new Map<string, string>();
  for (const model of models) for (const alias of model.aliases ?? []) {
    if (!known.has(alias) && !aliases.has(alias)) aliases.set(alias, model.value);
  }
  const catalogId = (value: string) => {
    const normalized = normalize(value);
    if (known.has(normalized)) return normalized;
    // Session parameters select controls on the same catalog entry, not a separate model with
    // no capabilities. Keep an unknown spelling intact so manually configured ids still work.
    const base = parseNativeModelSelection(normalized).model;
    return known.has(base) ? base : aliases.get(base) ?? normalized;
  };
  const chosen = [...new Set(enabled.filter((value): value is string => typeof value === 'string').map(catalogId))];
  if (session?.model) {
    const current = catalogId(session.model);
    if (!chosen.includes(current)) chosen.push(current);
  }
  return chosen.map(value => known.get(value) ?? { value, name: value, configOptions: [] });
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** A probe failure can echo the request; never let the key travel back out in the message. */
function redactSecret(message: string, secret?: string): string {
  return (secret ? message.split(secret).join('[REDACTED]') : message).slice(0, 500);
}

/**
 * A driver's canonical spelling of a model id. Ids saved from a gateway probe are the gateway's
 * own (`deepseek-v4.1-flash`), while a backend such as DSH names the same model differently.
 */
export function modelNormalizer(driver: NativeBackendDriver, profile: NativeBackendProfileConfig): (id: string) => string {
  return id => {
    try { return driver.normalizeModel?.(id, profile) ?? id; } catch { return id; }
  };
}

/**
 * How long a conversation's catalog waits for another provider's model list. A slower gateway is
 * left out of this answer, while its read goes on and fills the cache for the next one.
 */
const CONTINUATION_LISTING_WAIT_MS = 2_000;

export function profileDefaultModel(driver: NativeBackendDriver, profile: NativeBackendProfileConfig): string | undefined {
  const raw = typeof profile.config.defaultModel === 'string' ? profile.config.defaultModel : undefined;
  return raw ? driver.normalizeModel?.(raw, profile) ?? raw : undefined;
}

export interface BackendCatalogOptions {
  defaultProfileId?: (backendId: NativeBackendId) => string | undefined;
  profiles?: {
    get(backendId: NativeBackendId): NativeBackendProfilesResponse;
    getConfig(backendId: NativeBackendId, profileId: string): Record<string, unknown> | undefined;
  };
}

/** Which backends, profiles and models exist and what they can do, independent of any conversation. */
export class BackendCatalog {
  private readonly modelListings = new FreshCache<ModelInfo[]>(MODEL_LIST_FRESH_MS, MAX_MODEL_LISTINGS);
  private readonly slashListings = new FreshCache<NativeSlashItem[]>(SLASH_LIST_FRESH_MS, MAX_MODEL_LISTINGS);
  /** What a launch loads per backend, profile and directory (`loadedExtensions`); a probe can start a CLI, so a read is kept for a while. */
  private readonly loadedListings = new Map<string, { at: number; value?: LoadedExtensions; request?: Promise<LoadedExtensions> }>();
  private readonly usageReads = new Map<string, { freshUntil: number; value?: NativeBackendUsage; request?: Promise<NativeBackendUsage | undefined> }>();
  private readonly availability = new Map<string, AvailabilityEntry>();

  constructor(
    private readonly registry: NativeBackendRegistry,
    private readonly host: NativeBackendHost,
    private readonly options: BackendCatalogOptions,
    /** The profile a conversation is currently bound to; the one value of a session this class reads. */
    private readonly sessionProfile: (session: Session) => NativeBackendProfileConfig,
  ) {}

  /** User roots can be shared by profiles and backends, so invalidate every derived slash view. */
  invalidateSlashCatalogs(): void { this.slashListings.clear(); this.loadedListings.clear(); }
  /** A source login changes credentials without changing its saved profile. */
  invalidateModelCatalogs(): void {
    this.modelListings.clear();
    this.usageReads.clear();
    this.availability.clear();
    for (const driver of this.registry.list()) driver.invalidateModels?.();
  }

  /** The installed driver's `NativeBackendTraits`; none for a backend that is not installed. */
  traits(backendId: string): NativeBackendTraits {
    if (!isNativeBackendId(backendId)) return {};
    try { return this.registry.require(backendId).traits ?? {}; } catch { return {}; }
  }

  /** The environment names every installed backend's launches handle specially (`NativeBackendDriver.launchEnv`). */
  terminalLaunchEnv(): TerminalLaunchEnv {
    const drivers = this.registry.list();
    return {
      managed: drivers.flatMap(driver => driver.launchEnv?.managed ?? []),
      secrets: drivers.flatMap(driver => driver.launchEnv?.secrets ?? []),
    };
  }

  /**
   * Whether a prewarm is not even attempted: `skipped` with the reason for a backend that has no driver now (its plugin is
   * off) or keeps no warm process, or for a profile it cannot do it for. Asked before anything of the project's workspace is
   * touched, so such a backend never answers `workspace_busy` or fails for the workspace's sake.
   */
  prewarmSkip(backendId: NativeBackendId, backendProfileId?: string): NativePrewarmResult | undefined {
    if (!this.registry.get(backendId)?.prewarm) return { state: 'skipped', reason: 'backend_unsupported' };
    try { this.validateProfile(backendId, backendProfileId); }
    catch (error) {
      if (error instanceof AppError && error.code === 'NATIVE_PROFILE_NOT_FOUND') return { state: 'skipped', reason: 'profile_unsupported' };
      throw error;
    }
    return undefined;
  }

  /**
   * Starts the backend's unused process for the project's next session, when it keeps one. Says
   * `skipped` with the reason for a backend that does not, or for a profile it cannot do it for.
   */
  async prewarm(backendId: NativeBackendId, request: NativePrewarmRequest): Promise<NativePrewarmResult> {
    const driver = this.registry.require(backendId);
    if (!driver.prewarm) return { state: 'skipped', reason: 'backend_unsupported' };
    let profile: NativeBackendProfileConfig;
    try { profile = this.validateProfile(backendId, request.backendProfileId); }
    catch (error) {
      if (error instanceof AppError && error.code === 'NATIVE_PROFILE_NOT_FOUND') return { state: 'skipped', reason: 'profile_unsupported' };
      throw error;
    }
    const { project, backendProfileId: _profile, ...rest } = request;
    await prepareSource(profile.config);
    return await driver.prewarm(this.host, project, profile, rest);
  }

  /** Stops the unused process a prewarm answered with `claimId`; nothing when the backend is gone or a session claimed it. */
  async releasePrewarm(backendId: NativeBackendId, claimId: string): Promise<void> {
    await this.registry.get(backendId)?.releasePrewarm?.(this.host, claimId);
  }

  /** The gateway protocols a backend's profiles can be pointed at; none for a backend that is not registered. */
  consumesProtocols(backendId: NativeBackendId): readonly GatewayProtocol[] {
    return this.registry.get(backendId)?.traits?.consumesProtocols ?? [];
  }

  /** A driver's check of a profile config before the settings store it; a backend without a driver is `NATIVE_BACKEND_UNAVAILABLE`. */
  validateProfileConfig(backendId: NativeBackendId, config: Record<string, unknown>): void {
    this.registry.require(backendId).validateProfileConfig?.(config);
  }

  /** The driver's own model listing, without this service's cache; the CLI runs in `cwd`, which stands in for a project. */
  async driverModels(backendId: NativeBackendId, cwd: string): Promise<ModelInfo[]> {
    const driver = this.registry.require(backendId);
    const project: Project = { id: '', name: '', cwd, createdAt: '', updatedAt: '' };
    return await driver.listModels(this.host, project, this.validateProfile(backendId));
  }

  validateProfile(backendId: NativeBackendId, profileId?: string): NativeBackendProfileConfig {
    const driver = this.registry.require(backendId);
    const profiles = this.profiles(driver);
    const selected = (profileId ? profiles.find(item => item.id === profileId) : undefined)
      ?? profiles.find(item => item.isDefault)
      ?? profiles[0];
    if (!selected || (profileId && selected.id !== profileId)) throw new AppError('NATIVE_PROFILE_NOT_FOUND', 'Native backend profile does not exist', 404, { backendId });
    return selected;
  }

  /** A driver's capabilities, with whether its launches carry the Riffet MCP server. */
  async driverCapabilities(driver: NativeBackendDriver, profile: NativeBackendProfileConfig) {
    const capabilities = await driver.capabilities(this.host, profile);
    return { ...capabilities, supportsRecovery: true, supportsTargetedStop: true,
      ...(driver.traits?.riffetTools ? { supportsRiffetTools: true } : {}),
      ...(driver.traits?.extensionToggles ? { extensionToggles: { ...driver.traits.extensionToggles } } : {}),
      consumesProtocols: [...(driver.traits?.consumesProtocols ?? [])] };
  }

  async capabilitiesFor(backendId: NativeBackendId, profileId?: string) {
    const driver = this.registry.require(backendId);
    const profile = this.validateProfile(backendId, profileId);
    return this.driverCapabilities(driver, profile);
  }

  normalizeModel(backendId: NativeBackendId, profileId: string | undefined, model: string): string {
    const driver = this.registry.require(backendId);
    const profile = this.validateProfile(backendId, profileId);
    return driver.normalizeModel?.(model, profile) ?? model;
  }

  validateNativeSessionId(backendId: NativeBackendId, nativeSessionId: string): void {
    this.registry.require(backendId).validateNativeSessionId?.(nativeSessionId);
  }

  profiles(driver: NativeBackendDriver): NativeBackendProfileConfig[] {
    const builtins = driver.profiles(this.host);
    const saved = this.options.profiles?.get(driver.id);
    const defaultProfileId = saved?.defaultProfileId ?? this.options.defaultProfileId?.(driver.id);
    const configured = saved?.profiles ?? [];
    const profiles = builtins.map(profile => {
      const settings = configured.find(item => item.id === profile.id);
      const secretConfig = this.options.profiles?.getConfig(driver.id, profile.id) ?? {};
      const { hasApiKey: _hasApiKey, ...safeConfig } = settings ?? {};
      return {
        ...profile,
        ...(settings ? { name: settings.name, description: settings.description } : {}),
        isDefault: profile.id === defaultProfileId || (!defaultProfileId && profile.isDefault),
        config: { ...profile.config, ...safeConfig, ...secretConfig },
      };
    });
    for (const settings of configured) {
      if (profiles.some(item => item.id === settings.id)) continue;
      const { hasApiKey: _hasApiKey, isDefault: _isDefault, ...safeConfig } = settings;
      profiles.push({
        id: settings.id, backendId: driver.id, name: settings.name, description: settings.description,
        isDefault: settings.id === defaultProfileId,
        config: { ...safeConfig, ...(this.options.profiles?.getConfig(driver.id, settings.id) ?? {}) },
      });
    }
    return profiles;
  }

  /**
   * Profiles that point at a gateway of their own, credentials included. Server-side only.
   *
   * Explicit API connections remain eligible when a gateway adapter interprets their address.
   * Sources that supply another connection or credential remain confined to the agent picker.
   */
  gatewayProfiles(backendId: NativeBackendId): NativeBackendProfileConfig[] {
    return this.profiles(this.registry.require(backendId))
      .filter(profile => {
        if (!str(profile.config.apiEndpoint)) return false;
        const source = modelSourceOf(profile.config);
        return !source || modelSourceRole(source) === 'adapter' && Boolean(str(profile.config.apiKey));
      });
  }

  profileSettings(backendId: NativeBackendId): NativeBackendProfilesResponse {
    const driver = this.registry.require(backendId);
    const safe = this.options.profiles?.get(backendId) ?? { profiles: [] };
    const configured = safe.profiles;
    const profiles: NativeBackendProfileSettings[] = this.profiles(driver).map(profile => {
      const saved = configured.find(item => item.id === profile.id);
      const settings = saved ?? { id: profile.id, backendId, name: profile.name, description: profile.description };
      // A driver that resolves its launch (executable on PATH, default directory) shows what it resolved when nothing is stored.
      const values = driver.describeProfile?.(profile) ?? profile.config;
      const resolved: NativeBackendProfileSettings = { ...settings, isDefault: profile.isDefault };
      for (const key of ['executable', 'configDir', 'sourceDir', 'apiEndpoint', 'agentEndpoint', 'defaultModel'] as const) {
        if (typeof values[key] === 'string' && resolved[key] === undefined) resolved[key] = values[key] as string;
      }
      // A source is never inherited from a builtin's config; only a saved profile can
      // carry one, so this reads `settings` rather than `values`.
      if (typeof settings.modelSource === 'string' && resolved.modelSource === undefined) resolved.modelSource = settings.modelSource;
      if (typeof values.disableAutoUpdate === 'boolean' && resolved.disableAutoUpdate === undefined) resolved.disableAutoUpdate = values.disableAutoUpdate;
      resolved.hasApiKey = settings.hasApiKey ?? typeof profile.config.apiKey === 'string';
      if (resolved.enabledModels) resolved.enabledModels = [...new Set(resolved.enabledModels.map(modelNormalizer(driver, profile)))];
      return resolved;
    });
    return { profiles, ...(safe.defaultProfileId ? { defaultProfileId: safe.defaultProfileId } : {}) };
  }

  /** A deleted pending choice must not hide controls for a writer whose profile still exists. */
  currentSession(session: Session): Session {
    const actual = session.nativeRuntime?.profileId;
    if (!session.configPending || !actual || !session.backendProfileId || actual === session.backendProfileId) return session;
    let driver: NativeBackendDriver;
    try { driver = this.registry.require(backendIdOf(session)); } catch { return session; }
    const profiles = this.profiles(driver);
    return profiles.some(profile => profile.id === actual) && !profiles.some(profile => profile.id === session.backendProfileId)
      ? { ...session, backendProfileId: actual }
      : session;
  }

  /**
   * Listing models means spawning a CLI or calling a gateway, which takes seconds. A listing is
   * reused while fresh and, once stale, still answered at once while a refresh runs behind it.
   * The key covers the whole profile config, so editing a provider never serves its old list.
   * A driver that keeps its own provider catalog (`cachesModels`) is asked directly.
   */
  listModels(driver: NativeBackendDriver, project: Project | undefined, profile: NativeBackendProfileConfig, session?: Session): Promise<ModelInfo[]> {
    if (driver.traits?.cachesModels) return driver.listModels(this.host, project, profile, session);
    const key = createHash('sha256').update(JSON.stringify([driver.id, profile.id, profile.config, project?.cwd ?? null, session?.model ?? ''])).digest('hex');
    return this.modelListings.get(key, () => driver.listModels(this.host, project, profile, session));
  }

  /**
   * The availability a backend list reports. A probe spawns a CLI, so the answer is cached briefly:
   * this route is polled by every open page, and `available: true` used to be hardcoded here — which
   * is why a backend whose executable could not be found still showed up as healthy until a
   * conversation tried to start it.
   */
  private async backendAvailability(driver: NativeBackendDriver, profile: NativeBackendProfileConfig): Promise<AvailabilityEntry> {
    const key = `${driver.id}:${profile.id}`;
    const cached = this.availability.get(key);
    if (cached && cached.checkedAt + AVAILABILITY_FRESH_MS > Date.now()) return cached;
    // A source in its own process answers `resolve` only from a finished `prepare`; without one the probe would
    // read (and cache) "not ready" for a source that is fine.
    await prepareSource(profile.config).catch(() => undefined);
    const result = await driver.available(this.host, profile)
      .catch(error => ({ available: false, reason: error instanceof Error ? error.message : 'Backend is unavailable' }));
    const entry = { result, checkedAt: Date.now() };
    this.availability.set(key, entry);
    for (const oldest of this.availability.keys()) {
      if (this.availability.size <= MAX_AVAILABILITY_ENTRIES) break;
      this.availability.delete(oldest);
    }
    return entry;
  }

  async listBackends(onAvailability?: (id: NativeBackendId, checkedAt: number) => void): Promise<NativeBackendCatalogEntry[]> {
    const result: NativeBackendCatalogEntry[] = [];
    for (const driver of this.registry.list()) {
      const profiles = this.profiles(driver);
      const profile = profiles.find(item => item.isDefault) ?? profiles[0];
      if (!profile) continue;
      const capabilities = await this.driverCapabilities(driver, profile);
      const { result: availability, checkedAt } = await this.backendAvailability(driver, profile);
      onAvailability?.(driver.id, checkedAt);
      const reason = availability.reason ? safeBackendReason(availability.reason, profile) : undefined;
      const rawDefaultModel = typeof profile.config.defaultModel === 'string' ? profile.config.defaultModel : undefined;
      const defaultModel = rawDefaultModel ? driver.normalizeModel?.(rawDefaultModel, profile) ?? rawDefaultModel : undefined;
      result.push({ backendId: driver.id, label: driver.label, available: availability.available, ...(availability.needsLogin ? { needsLogin: true } : {}), profiles: profiles.map(({ config: _config, ...item }) => item), capabilities, models: [], ...(reason ? { reason } : {}), ...(defaultModel ? { defaultModel } : {}), ...cliVersionOf(driver, availability) });
    }
    return result;
  }

  async entry(backendId: string, project: Project | undefined, profileId?: string, session?: Session, options: { allModels?: boolean } = {}): Promise<NativeBackendCatalogEntry> {
    if (!isNativeBackendId(backendId)) throw new AppError('INVALID_BACKEND', 'Choose a supported native backend');
    const driver = this.registry.require(backendId);
    const profiles = this.profiles(driver);
    const requestedSession = session;
    if (session) session = this.currentSession(session);
    const selected = session ? this.sessionProfile(session) : (profileId ? profiles.find(item => item.id === profileId) : undefined)
      ?? profiles.find(item => item.isDefault)
      ?? profiles[0];
    const pendingChoiceRemoved = session !== requestedSession;
    if (!selected || (profileId && selected.id !== profileId && !(pendingChoiceRemoved && profileId === requestedSession?.backendProfileId))) throw new AppError('NATIVE_PROFILE_NOT_FOUND', 'The selected native profile does not exist', 404);
    await prepareSource(selected.config);
    const capabilities = await this.driverCapabilities(driver, selected);
    const availability: NativeBackendAvailability = await driver.available(this.host, selected).catch(error => ({ available: false, reason: error instanceof Error ? error.message : 'Backend is unavailable' }));
    let reason = availability.reason ? safeBackendReason(availability.reason, selected) : undefined;
    let models: ModelInfo[] = [];
    if (availability.available && capabilities.supportsModelSelection) {
      try {
        const listed = await this.listModels(driver, project, selected, session);
        models = options.allModels ? listed : curateModels(listed, selected, session, modelNormalizer(driver, selected));
      }
      catch (error) { reason = safeBackendReason(error instanceof Error ? error.message : 'Could not load the model catalog', selected); }
    }
    const defaultModel = profileDefaultModel(driver, selected);
    const continuations = session && capabilities.supportsModelSelection ? await this.continuations(driver, selected, profiles, project, session) : [];
    if (pendingChoiceRemoved && capabilities.supportsModelSelection) {
      // The client still shows the deleted choice as current. Offer the actual writer explicitly
      // so picking its model sends a profile cancellation, rather than another write to that choice.
      const { config: _config, ...publicProfile } = selected;
      continuations.unshift({ profile: publicProfile, models });
      models = [];
    }
    return {
      backendId, label: driver.label, available: availability.available,
      ...(availability.needsLogin ? { needsLogin: true } : {}),
      ...(reason ? { reason } : {}),
      profiles: profiles.map(({ config: _config, ...item }) => item), capabilities, models,
      ...(defaultModel ? { defaultModel } : {}),
      ...cliVersionOf(driver, availability),
      ...(continuations.length ? { continuations } : {}),
    };
  }

  /**
   * The profiles a conversation on `current` can move to without a new session, each with its
   * models of the line it runs on (`modelFamily`): those keeping conversations where `current` does
   * and serving that line. Sharing a store only says the transcript can be resumed there; the line is
   * what says the next request accepts its turns (signed reasoning among them). Moving to another line
   * is a handoff. A profile whose catalog cannot be read in time is left out rather than offered empty.
   */
  private async continuations(driver: NativeBackendDriver, current: NativeBackendProfileConfig, profiles: NativeBackendProfileConfig[], project: Project | undefined, session: Session): Promise<NativeProfileContinuation[]> {
    const key = driver.continuationKey?.(current);
    const running = session.model ?? profileDefaultModel(driver, current);
    if (key === undefined || !running) return [];
    const family = modelFamily(modelNormalizer(driver, current)(running));
    const candidates = profiles.filter(item => item.id !== current.id && driver.continuationKey!(item) === key);
    const listed = await Promise.all(candidates.map(async profile => {
      const normalize = modelNormalizer(driver, profile);
      const listing = (async () => {
        await prepareSource(profile.config);
        if (driver.canContinueProfile && !driver.canContinueProfile(current, profile, session)) return undefined;
        return curateModels(await this.listModels(driver, project, profile), profile, undefined, normalize);
      })();
      listing.catch(() => undefined);
      let late!: () => void;
      const waited = new Promise<undefined>(resolve => { late = () => resolve(undefined); });
      const timer = setTimeout(late, CONTINUATION_LISTING_WAIT_MS);
      timer.unref?.();
      const models = await Promise.race([listing, waited]).catch(() => undefined).finally(() => clearTimeout(timer));
      const same = models?.filter(model => modelFamily(normalize(model.value)) === family);
      if (!same?.length) return undefined;
      const { config: _config, ...publicProfile } = profile;
      return { profile: publicProfile, models: same };
    }));
    return listed.filter((item): item is NativeProfileContinuation => item !== undefined);
  }

  /**
   * Account quota and per-model load for one backend profile, from its selected model source or
   * its CLI. A named source never inherits the CLI login's quota. Reused for a short while.
   */
  async usage(backendId: string, project: Project | undefined, profileId?: string, session?: Session): Promise<NativeBackendUsage | undefined> {
    if (!isNativeBackendId(backendId)) throw new AppError('INVALID_BACKEND', 'Choose a supported native backend');
    const driver = this.registry.require(backendId);
    const profiles = this.profiles(driver);
    // Keep the session's bound identity, but read quota with its current saved settings rather
    // than the launch snapshot a running session deliberately retains.
    const selectedProfileId = session ? this.sessionProfile(session).id : profileId;
    const profile = selectedProfileId ? profiles.find(item => item.id === selectedProfileId) : profiles.find(item => item.isDefault) ?? profiles[0];
    if (!profile || (profileId && profile.id !== profileId)) throw new AppError('NATIVE_PROFILE_NOT_FOUND', 'The selected native profile does not exist', 404);
    const source = modelSourceOf(profile.config);
    if (source ? !modelSourceProvider(source) : !driver.usage) return undefined;
    const key = createHash('sha256').update(JSON.stringify([driver.id, profile.id, profile.config, project?.cwd ?? null])).digest('hex');
    let read = this.usageReads.get(key);
    if (read?.value && read.freshUntil > Date.now()) return read.value;
    const stale = read?.value && read.freshUntil - USAGE_FRESH_MS + USAGE_STALE_MS > Date.now() ? read.value : undefined;
    if (!read) {
      read = { freshUntil: 0 };
      this.usageReads.set(key, read);
      if (this.usageReads.size > MAX_MODEL_LISTINGS) this.usageReads.delete(this.usageReads.keys().next().value!);
    }
    const entry = read;
    entry.request ??= (source ? sourceUsage(source, profile.config) : driver.usage!(this.host, project, profile, session))
      .then(value => { entry.value = value; entry.freshUntil = value ? Date.now() + USAGE_FRESH_MS : 0; return value; })
      .finally(() => { entry.request = undefined; });
    if (stale) { entry.request.catch(() => undefined); return stale; }
    return await entry.request;
  }

  /**
   * The composer's `/` menu for one backend profile in one project: static built-ins first, then
   * whatever the provider discovers. Discovery spawns a CLI on some backends, so a listing is
   * reused while fresh and, once stale, answered at once while a refresh runs behind it. A failed
   * discovery still answers with the built-ins.
   */
  async slashCatalog(backendId: string, project: Project | undefined, profileId?: string, session?: Session, options: { refresh?: boolean } = {}): Promise<NativeSlashCatalog> {
    if (!isNativeBackendId(backendId)) throw new AppError('INVALID_BACKEND', 'Choose a supported native backend');
    const driver = this.registry.require(backendId);
    const profiles = this.profiles(driver);
    const profile = session ? this.sessionProfile(session) : (profileId ? profiles.find(item => item.id === profileId) : undefined) ?? profiles.find(item => item.isDefault) ?? profiles[0];
    if (!profile || (profileId && profile.id !== profileId)) throw new AppError('NATIVE_PROFILE_NOT_FOUND', 'The selected native profile does not exist', 404);
    const capabilities = await this.driverCapabilities(driver, profile);
    const builtins: NativeSlashItem[] = (capabilities.slashCommands ?? []).map(command => ({ ...command, name: command.name.replace(/^\//, ''), kind: 'command' }));
    let discovered: NativeSlashItem[] = [];
    let reason: string | undefined;
    if (driver.slashItems) {
      try { discovered = await this.discoverSlashItems(driver, project, profile, options.refresh === true); }
      catch (error) { reason = safeBackendReason(error instanceof Error ? error.message : 'Could not list skills', profile); }
    }
    return { items: mergeSlashItems(builtins, discovered), inlineSkills: capabilities.inlineSkills === true, ...(reason ? { reason } : {}) };
  }

  /** The MCP servers and skills a launch of this backend profile in `project` loads; kept for five minutes. */
  async loadedExtensions(backendId: string, project: Project, profileId?: string): Promise<LoadedExtensions> {
    if (!isNativeBackendId(backendId)) throw new AppError('INVALID_BACKEND', 'Choose a supported native backend');
    const driver = this.registry.require(backendId);
    const profile = this.validateProfile(backendId, profileId);
    if (!driver.extensions?.loaded || !driver.traits?.extensionToggles) throw new AppError('EXTENSION_TOGGLES_UNSUPPORTED', 'This agent cannot switch extensions off per conversation', 409);
    // Hashed with the profile's config, as the slash cache is: an edited profile is a new key, and no secret is kept in one.
    const key = createHash('sha256').update(JSON.stringify([driver.id, profile.id, profile.config, project.cwd])).digest('hex');
    const entry = this.loadedListings.get(key) ?? { at: 0 };
    this.loadedListings.delete(key);
    this.loadedListings.set(key, entry);
    if (this.loadedListings.size > MAX_MODEL_LISTINGS) this.loadedListings.delete(this.loadedListings.keys().next().value!);
    if (entry.value && Date.now() - entry.at < LOADED_EXTENSIONS_FRESH_MS) return entry.value;
    entry.request ??= withDeadline(driver.extensions.loaded(this.host, project, profile), LOADED_EXTENSIONS_DEADLINE_MS, 'Reading the loaded extensions took too long')
      .then(value => { const result = { ...value, checkedAt: new Date().toISOString() }; entry.value = result; entry.at = Date.now(); return result; })
      .finally(() => { entry.request = undefined; });
    try { return await entry.request; }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('EXTENSIONS_PROBE_FAILED', safeBackendReason(error instanceof Error ? error.message : 'Could not read the loaded extensions', profile), 502);
    }
  }

  private discoverSlashItems(driver: NativeBackendDriver, project: Project | undefined, profile: NativeBackendProfileConfig, refresh: boolean): Promise<NativeSlashItem[]> {
    const key = createHash('sha256').update(JSON.stringify([driver.id, profile.id, profile.config, project?.cwd ?? null])).digest('hex');
    return this.slashListings.get(key, () => driver.slashItems!(this.host, project, profile), { refresh });
  }

  /**
   * Asks a gateway what it serves using the values a settings form currently holds, including a
   * key typed but not yet saved, so adding a provider is one pass instead of save-then-return.
   * Nothing here is persisted; the answer is a list of candidates the user picks from.
   */
  async probeModels(backendId: string, input: { apiEndpoint?: string; apiKey?: string; profileId?: string; modelSource?: NativeModelSource; apiProtocol?: NativeModelApiProtocol }): Promise<ModelInfo[]> {
    if (!isNativeBackendId(backendId)) throw new AppError('INVALID_BACKEND', 'Choose a supported native backend');
    const driver = this.registry.require(backendId);
    const profiles = this.profiles(driver);
    const profile = profiles.find(item => item.id === input.profileId) ?? profiles.find(item => item.isDefault) ?? profiles[0];
    const normalize = profile ? modelNormalizer(driver, profile) : (id: string) => id;
    // A blank key means "reuse what is already saved" so re-fetching does not force a retype.
    const storedConfig = input.profileId ? this.options.profiles?.getConfig(backendId, input.profileId) : undefined;
    const storedSource = modelSourceOf(storedConfig ?? {});
    const storedApiConnection = !storedSource || modelSourceRole(storedSource) === 'adapter';
    const targetApiConnection = !input.modelSource || Boolean(modelSourceProvider(input.modelSource)) && modelSourceRole(input.modelSource) === 'adapter';
    // Changing a gateway adapter keeps the same connection. A type change must not forward its key
    // to a different address or to a source that supplies its own connection/credentials.
    const sameConnection = Boolean(input.apiEndpoint?.trim())
      && input.apiEndpoint!.trim() === str(storedConfig?.apiEndpoint)?.trim()
      && storedApiConnection && targetApiConnection;
    const stored = input.apiKey === undefined && (input.modelSource === storedSource || sameConnection)
      ? str(storedConfig?.apiKey)
      : undefined;
    const apiKey = input.apiKey?.trim() || stored;
    // A source answers for itself, with its own endpoint and credential; the form only has to say
    // which one, which is what lets a source with no typed address be probed at all.
    if (input.modelSource) {
      const source = validateNativeModelSource(input.modelSource);
      await prepareSource({ modelSource: source, ...(apiKey ? { apiKey } : {}), ...(input.apiEndpoint ? { apiEndpoint: input.apiEndpoint } : {}) });
      if (!modelSourceProvider(source)) throw new AppError('INVALID_BACKEND_PROFILE', 'This model source is not available on this server');
      const consumes = driver.traits?.consumesProtocols ?? [];
      if (!consumes.length) throw new AppError('INVALID_BACKEND_PROFILE', 'This backend does not support a model source');
      const config: Record<string, unknown> = { modelSource: source, ...(apiKey ? { apiKey } : {}), ...(input.apiEndpoint ? { apiEndpoint: validateNativeProfileEndpoint(input.apiEndpoint, 'apiEndpoint') } : {}) };
      try {
        const models = await sourceCatalog(source, consumes, config);
        return models.map(model => ({ ...model, value: normalize(model.value) }));
      } catch (error) {
        const message = redactSecret(error instanceof Error ? error.message : 'The model catalog could not be read', apiKey);
        throw new AppError('NATIVE_MODEL_PROBE_FAILED', message, 400, undefined, { message });
      }
    }
    if (backendId === 'pi' || backendId === 'antigravity') {
      const endpoint = validateNativeProfileEndpoint(input.apiEndpoint, 'apiEndpoint');
      const apiProtocol = validateNativeModelApiProtocol(input.apiProtocol ?? storedConfig?.apiProtocol ?? (backendId === 'antigravity' ? 'google-generative-ai' : 'openai-completions'));
      if (backendId === 'antigravity' && apiProtocol !== 'google-generative-ai') throw new AppError('INVALID_BACKEND_PROFILE', 'Antigravity requires the Google Gemini model API protocol');
      try {
        return await piProviderModels({ id: profile?.id ?? 'probe', backendId, name: driver.label, config: { apiEndpoint: endpoint, apiProtocol, ...(apiKey ? { apiKey } : {}) } });
      } catch (error) {
        const message = redactSecret(error instanceof Error ? error.message : 'The model catalog could not be read', apiKey);
        throw new AppError('NATIVE_MODEL_PROBE_FAILED', message, 400, undefined, { message });
      }
    }
    const endpoint = validateNativeProfileEndpoint(input.apiEndpoint, 'apiEndpoint');
    try {
      const models = await fetchGatewayModels({ baseUrl: endpoint, ...(apiKey ? { apiKey } : {}) });
      return models.map(model => ({ ...model, value: normalize(model.value) }));
    } catch (error) {
      // 4xx so the reason survives the error handler: an unreachable gateway or a rejected key
      // is about the address the user just typed, not a fault in this service.
      const message = redactSecret(error instanceof Error ? error.message : 'The model catalog could not be read', apiKey);
      throw new AppError('NATIVE_MODEL_PROBE_FAILED', message, 400, undefined, { message });
    }
  }
}
