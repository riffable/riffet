import type { ModelConfigOption, ModelDailyQuota, ModelInfo, ModelStatus, NativeBackendUsage, UsageWindow } from '../../../../../packages/contracts/src/index.js';
import type { CodexAppServerClient } from '../shared/codex-app-server.js';
import type { NativeModelSelection } from '../shared/model-selection.js';
import { AppError } from '../../errors.js';
import type { CodexFlavor } from './flavors.js';
import { titleCase, str, finiteToken, asRecord, asArray } from './util.js';

/**
 * Codex's Fast mode is a *service tier*, not a model variant: the catalog publishes
 * `serviceTiers` per model and the app-server accepts the chosen tier as `serviceTier`.
 * `priority` is the request value Codex itself sends for its `Fast` tier; `default` is its
 * explicit standard-routing sentinel, which is what turns Fast back off when the reader's own
 * `~/.codex/config.toml` already sets `service_tier = "priority"`.
 */
const FAST_TIER_IDS = new Set(['priority', 'fast']);
const DEFAULT_FAST_TIER = 'priority';
const STANDARD_SERVICE_TIER = 'default';
/** `<flavor>:<model slug>` -> the service tier id its Fast switch turns on, learned from `model/list`. */
const fastTierIds = new Map<string, string>();

/** How long a transport's alias map may serve thread and turn requests without a fresh `model/list`. */
const ALIAS_CACHE_TTL_MS = 5 * 60_000;
/**
 * A provider renames the selector it wants on the wire without retiring the ids already saved in
 * sessions. The map is scoped to the transport so a re-login or a different profile cannot leak
 * one catalog's aliases into another's.
 */
const aliasCaches = new WeakMap<CodexAppServerClient, { expiresAt: number; aliases: Map<string, string>; pending?: Promise<Map<string, string>> }>();

/**
 * Every identity the provider publishes for one catalog entry besides its wire selector. TRAE
 * exposes `id` and `configName` (e.g. `openrouter-4o`) while the current selector is the model
 * name (e.g. `Orange-O55`); older sessions and cached catalogs still hold the former.
 */
function aliasValues(model: Record<string, unknown>, value: string): string[] {
  return [...new Set([str(model.id), str(model.configName)].filter((alias): alias is string => alias !== undefined && alias !== value))];
}

interface CatalogEntry { value: string; aliases: string[] }

/**
 * Canonical selectors resolve to themselves and outrank every other entry's alias. Building both
 * layers separately keeps an alias that happens to equal another entry's current selector from
 * rewriting that model onto the alias's owner.
 */
function catalogAliasMap(entries: CatalogEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) map.set(entry.value, entry.value);
  for (const entry of entries) for (const alias of entry.aliases) if (!map.has(alias)) map.set(alias, entry.value);
  return map;
}

function rememberAliases(transport: CodexAppServerClient, aliases: Map<string, string>): void {
  aliasCaches.set(transport, { expiresAt: Date.now() + ALIAS_CACHE_TTL_MS, aliases });
}

async function aliasIndex(transport: CodexAppServerClient): Promise<Map<string, string>> {
  const cached = aliasCaches.get(transport);
  if (cached && cached.expiresAt > Date.now()) return cached.aliases;
  if (cached?.pending) return await cached.pending;
  const previous = cached?.aliases ?? new Map<string, string>();
  const pending = (async () => {
    const entries: CatalogEntry[] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < 20; page += 1) {
        const response = await transport.request<{ data?: Array<Record<string, unknown>>; nextCursor?: string | null }>('model/list', { ...(cursor ? { cursor } : {}), limit: 100, includeHidden: false });
        for (const model of asArray<Record<string, unknown>>(response.data)) {
          const value = str(model.model) ?? str(model.id);
          if (!value) continue;
          entries.push({ value, aliases: aliasValues(model, value) });
        }
        if (!response.nextCursor) break;
        cursor = response.nextCursor;
      }
    } catch {
      // Keep the last successful mapping; a cold miss simply leaves the saved spelling on the wire.
      return previous;
    }
    return catalogAliasMap(entries);
  })();
  aliasCaches.set(transport, { expiresAt: cached?.expiresAt ?? 0, aliases: previous, pending });
  const aliases = await pending;
  rememberAliases(transport, aliases);
  return aliases;
}

/**
 * Rewrites a saved selector that the provider has since renamed, keeping the picker parameters.
 * Only TRAE publishes the alternative identities; Codex's selector is its own id.
 */
export async function resolveModelSelection(transport: CodexAppServerClient, flavor: CodexFlavor, selection: NativeModelSelection): Promise<NativeModelSelection> {
  if (flavor.id !== 'traex' || !selection.model) return selection;
  const canonical = (await aliasIndex(transport)).get(selection.model);
  return canonical && canonical !== selection.model ? { model: canonical, params: selection.params } : selection;
}

/** The Fast tier a catalog entry advertises, if any. A cheap-only listing (`flex`) is not Fast. */
function fastTierIdOf(model: Record<string, unknown>): string | undefined {
  return asArray<Record<string, unknown>>(model.serviceTiers)
    .map(tier => str(tier.id))
    .find((id): id is string => id !== undefined && FAST_TIER_IDS.has(id));
}

/**
 * The `serviceTier` request value for a picker selection. `undefined` means the catalog never
 * published a Fast control for this model, so the turn must leave the profile's own tier alone.
 */
export function fastServiceTier(flavor: CodexFlavor, model: string, fast: boolean | undefined): string | undefined {
  if (fast === undefined) return undefined;
  const learned = fastTierIds.get(`${flavor.id}:${model}`);
  // Codex's tier names are its own; a fork that never advertised one gets no tier at all.
  if (!learned && flavor.id !== 'codex') return undefined;
  return fast ? learned ?? DEFAULT_FAST_TIER : STANDARD_SERVICE_TIER;
}

/** TRAE retains a thread's variant, so selecting a model without Max must explicitly reset it. */
export function modelBackendVariant(flavor: CodexFlavor, selection: NativeModelSelection): 'standard' | 'max' | undefined {
  if (flavor.id !== 'traex' || !selection.model) return undefined;
  const context = selection.params.context;
  if (context === undefined || context === 'standard') return 'standard';
  if (context === 'max') return 'max';
  throw new AppError('INVALID_NATIVE_MODEL', `Unsupported TRAE CLI context mode: ${context}. Choose Standard or Max.`, 400, undefined, { reason: 'context', context });
}

/** Availability and advertised capacities come from TRAE's backend variants, not model names. */
function contextConfigOption(model: Record<string, unknown>): ModelConfigOption | undefined {
  const variants = asRecord(asRecord(model.businessMetadata)?.variants);
  if (!str(variants?.standard_key)?.trim() || !str(variants?.max_key)?.trim()) return undefined;
  return {
    id: 'context',
    name: 'Context',
    category: 'model_config',
    type: 'select',
    currentValue: 'standard',
    options: (['standard', 'max'] as const).map(value => {
      const window = finiteToken(variants?.[`${value}_context_window`]);
      const name = titleCase(value);
      const capacity = window === undefined || window <= 0 ? undefined
        : window >= 1_000_000 ? `${window / 1_000_000}M`
          : window >= 1_000 ? `${window / 1_000}K` : String(window);
      return { value, name: capacity ? `${name} · ${capacity}` : name };
    }),
  };
}

/** The picker's Fast switch for one `model/list` entry, absent when the model has no Fast tier. */
function fastConfigOption(model: Record<string, unknown>, tierId: string): ModelConfigOption {
  const description = asArray<Record<string, unknown>>(model.serviceTiers).find(tier => str(tier.id) === tierId)?.description;
  return {
    id: 'fast',
    name: 'Fast',
    ...(str(description) ? { description: str(description)! } : {}),
    category: 'model_config',
    type: 'select',
    // The catalog's own default decides the opening position; a profile-level
    // `service_tier = "priority"` cannot be seen from here, so the switch stays catalog-truthful.
    currentValue: str(model.defaultServiceTier) === tierId ? 'true' : 'false',
    options: [
      { value: 'false', name: 'Off' },
      { value: 'true', name: 'On', ...(str(description) ? { description: str(description)! } : {}) },
    ],
  };
}

export async function listModels(transport: CodexAppServerClient, flavor: CodexFlavor): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  const entries: CatalogEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const response = await transport.request<{ data?: Array<Record<string, unknown>>; nextCursor?: string | null }>('model/list', { ...(cursor ? { cursor } : {}), limit: 100, includeHidden: false });
    for (const model of asArray<Record<string, unknown>>(response.data)) {
      const value = str(model.model) ?? str(model.id);
      if (!value) continue;
      const modelAliases = flavor.id === 'traex' ? aliasValues(model, value) : [];
      entries.push({ value, aliases: modelAliases });
      const efforts = asArray<Record<string, unknown>>(model.supportedReasoningEfforts).flatMap(effort => {
        const id = str(effort.reasoningEffort);
        return id ? [{ value: id, name: str(effort.description) ?? titleCase(id) }] : [];
      });
      const defaultEffort = str(model.defaultReasoningEffort);
      const configOptions: ModelConfigOption[] = efforts.length ? [{
        id: 'effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select' as const,
        currentValue: defaultEffort ?? efforts[0]!.value,
        options: efforts,
      }] : [];
      // Fast is the same switch the UI already renders for Cursor: an `id: 'fast'` boolean
      // select. Publishing it here is the whole server-side contract the picker needs.
      const fastTier = fastTierIdOf(model);
      if (fastTier) {
        fastTierIds.set(`${flavor.id}:${value}`, fastTier);
        configOptions.push(fastConfigOption(model, fastTier));
      }
      const context = flavor.id === 'traex' ? contextConfigOption(model) : undefined;
      if (context) configOptions.push(context);
      models.push({ value, name: str(model.displayName) ?? value, configOptions, ...(modelAliases.length ? { aliases: modelAliases } : {}) });
    }
    if (!response.nextCursor) break;
    cursor = response.nextCursor;
  }
  if (flavor.id === 'traex') rememberAliases(transport, catalogAliasMap(entries));
  return models;
}

/**
 * Account quota and per-model load from an app-server.
 *
 * The two CLIs report different halves. Codex meters the ChatGPT account (`account/rateLimits/read`:
 * a weekly or five-hour window, plan, credits) and says nothing per model. TRAE CLI refuses that
 * call for its own login, but every `model/list` entry carries `businessMetadata` with the gateway's
 * current load and, for models on the internal weekly or daily quota, that quota. Each half is read
 * when the CLI offers it, and a failed half is simply absent.
 */
export async function readUsage(transport: CodexAppServerClient, flavor: CodexFlavor, options: { account?: boolean } = {}): Promise<NativeBackendUsage> {
  const traex = flavor.id === 'traex';
  const [listed, limits, internal] = await Promise.all([
    transport.request<{ data?: Array<Record<string, unknown>> }>('model/list', { limit: 100, includeHidden: false }).catch(() => undefined),
    // A profile on its own provider still runs under the CLI's ChatGPT sign-in, which would answer
    // with a quota that has nothing to do with the profile's models.
    traex || options.account === false ? Promise.resolve(undefined) : transport.request<Record<string, unknown>>('account/rateLimits/read', {}).catch(() => undefined),
    traex ? transport.request<{ dailyUsage?: unknown; usage?: unknown }>('model/internalUsage/read', {}).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  // The gateway's daily counters are keyed by `quotaKey`; a model opts in through
  // `businessMetadata.internal_daily_quota_key` so several models can share one counter.
  const dailyByKey = new Map<string, Record<string, unknown>>();
  for (const entry of asArray<Record<string, unknown>>(internal?.dailyUsage)) {
    const key = str(entry.quotaKey)?.trim();
    if (key) dailyByKey.set(key, entry);
  }
  const rpcWeekly = asRecord(internal?.usage);
  const models: Record<string, ModelStatus> = {};
  const entries: Array<CatalogEntry & { status?: ModelStatus }> = [];
  const canonical = new Set<string>();
  for (const model of asArray<Record<string, unknown>>(listed?.data)) {
    const value = str(model.model) ?? str(model.id);
    if (!value) continue;
    canonical.add(value);
    entries.push({ value, aliases: traex ? aliasValues(model, value) : [], status: modelStatus(asRecord(model.businessMetadata), dailyByKey, rpcWeekly) });
  }
  for (const entry of entries) if (entry.status) models[entry.value] = entry.status;
  // An alias may never stand in for another entry's canonical selector, even when that entry
  // published no status of its own.
  for (const entry of entries) if (entry.status) for (const alias of entry.aliases) {
    if (!canonical.has(alias) && !models[alias]) models[alias] = entry.status;
  }
  if (traex && entries.some(entry => entry.aliases.length)) rememberAliases(transport, catalogAliasMap(entries));
  const snapshot = asRecord(limits?.rateLimits);
  const windows = [snapshot?.primary, snapshot?.secondary].flatMap(entry => usageWindow(asRecord(entry)) ?? []);
  const credits = asRecord(snapshot?.credits);
  const balance = Number(str(credits?.balance) ?? Number.NaN);
  const account = snapshot && (windows.length || credits || str(snapshot.planType)) ? {
    ...(str(snapshot.planType) && snapshot.planType !== 'unknown' ? { plan: str(snapshot.planType)! } : {}),
    windows,
    ...(credits ? { credits: { ...(Number.isFinite(balance) ? { balance } : {}), ...(credits.unlimited === true ? { unlimited: true } : {}) } } : {}),
    ...(snapshot.rateLimitReachedType || snapshot.spendControlReached === true ? { limitReached: true } : {}),
  } : undefined;
  return { ...(account ? { account } : {}), models, fetchedAt: new Date().toISOString() };
}

/** Quota amounts arrive as decimal strings, so they must survive beyond the integer range. */
function numericAmount(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function weeklyQuota(usage: Record<string, unknown> | undefined): ModelStatus['quota'] {
  const used = finiteToken(usage?.usage_percent);
  if (used === undefined) return undefined;
  const resetSeconds = finiteToken(usage?.reset_time);
  // Older Kotlin clients decode weekly amounts as integers, so keep this half integer-only.
  const remaining = finiteToken(usage?.quota_remaining);
  const limit = finiteToken(usage?.quota_limit);
  // TRAE CLI documents this as the internal *weekly* basic quota.
  return {
    usedPercent: Math.round(used), windowMinutes: 7 * 24 * 60,
    ...(resetSeconds ? { resetsAt: new Date(resetSeconds * 1000).toISOString() } : {}),
    ...(remaining === undefined ? {} : { remaining: Math.trunc(remaining) }),
    ...(limit === undefined ? {} : { limit: Math.trunc(limit) }),
    ...(usage?.is_depleted === true ? { depleted: true } : {}),
  };
}

/** A daily counter is a soft limit: exhaustion lowers queue priority instead of disabling the model. */
function dailyQuota(usage: Record<string, unknown> | undefined): ModelDailyQuota | undefined {
  if (!usage) return undefined;
  const used = numericAmount(usage.usagePercent);
  const remaining = numericAmount(usage.quotaRemaining);
  const limit = numericAmount(usage.quotaLimit);
  if (used === undefined || remaining === undefined || limit === undefined) return undefined;
  const resetSeconds = numericAmount(usage.resetTime);
  return {
    usedPercent: Math.round(used), windowMinutes: 24 * 60,
    ...(resetSeconds === undefined ? {} : { resetsAt: new Date(resetSeconds * 1000).toISOString() }),
    remaining, limit,
    ...(usage.isDepleted === true ? { depleted: true } : {}),
  };
}

function modelStatus(
  metadata: Record<string, unknown> | undefined,
  dailyByKey: Map<string, Record<string, unknown>>,
  rpcWeekly: Record<string, unknown> | undefined,
): ModelStatus | undefined {
  if (!metadata) return undefined;
  const load = finiteToken(asRecord(metadata.load)?.load_percent);
  const limited = typeof metadata.is_internal_usage_limit === 'boolean' ? metadata.is_internal_usage_limit : undefined;
  // Metadata is authoritative; the account-wide RPC read only fills a missing weekly snapshot.
  const quota = limited === false ? undefined
    : weeklyQuota(asRecord(metadata.internal_usage)) ?? (limited === true ? weeklyQuota(rpcWeekly) : undefined);
  const dailyQuotaKey = str(metadata.internal_daily_quota_key)?.trim() || undefined;
  const quotaLimited = limited ?? (quota ? true : undefined);
  // The daily counter must name the same key this model declares; otherwise the metadata belongs
  // to a different binding and would report another model's usage as this one's.
  const metadataDaily = asRecord(metadata.internal_daily_usage);
  const daily = dailyQuotaKey
    ? (str(metadataDaily?.quotaKey)?.trim() === dailyQuotaKey ? dailyQuota(metadataDaily) : undefined)
      ?? dailyQuota(dailyByKey.get(dailyQuotaKey))
    : undefined;
  if (load === undefined && !quota && quotaLimited === undefined && !dailyQuotaKey) return undefined;
  return {
    ...(load === undefined ? {} : { loadPercent: load }),
    ...(quota ? { quota } : {}),
    ...(quotaLimited === undefined ? {} : { quotaLimited }),
    ...(dailyQuotaKey ? { dailyQuotaKey } : {}),
    ...(daily ? { dailyQuota: daily } : {}),
  };
}

function usageWindow(entry: Record<string, unknown> | undefined): UsageWindow | undefined {
  const used = finiteToken(entry?.usedPercent);
  if (used === undefined) return undefined;
  const minutes = finiteToken(entry?.windowDurationMins);
  const resets = finiteToken(entry?.resetsAt);
  return { usedPercent: used, ...(minutes ? { windowMinutes: minutes } : {}), ...(resets ? { resetsAt: new Date(resets * 1000).toISOString() } : {}) };
}
