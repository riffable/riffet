import type { AppSettings, AuxiliaryModelOption, AuxiliaryModelPurpose, AuxiliaryModelRef, AuxiliaryModelTransport, ModelInfo, ModelUseDeclaration, NativeBackendId } from '../../../../packages/contracts/src/index.js';
import { driverGatewayOf, type NativeBackendProfileConfig } from '../backends/types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchSource, modelSourceOf, prepareSource, sourceCatalog, sourceEndpoint } from '../backends/shared/model-source.js';
import { fetchGatewayModels, type GatewayModelsRequest } from '../backends/shared/gateway-models.js';
import { AUXILIARY_MODEL_BACKENDS, complete, gatewayEfforts, GatewayHttpError, gatewayModelId, gatewayProtocol, streamComplete, type CompletionMetrics, type GatewayEndpoint, type GatewayProtocol } from './gateway.js';
import type { AuxiliaryCallRecorder } from './telemetry.js';

/** The gateway protocol a model source names for each wire format a side chat can speak. */
const SOURCE_PROTOCOL: Record<GatewayProtocol, string> = { anthropic: 'anthropic-messages', responses: 'openai-responses', chat: 'openai-chat' };

const AUTH_CACHE_TTL_MS = 60_000;
const MAX_AUTH_CACHE_ENTRIES = 64;
// perf-rules: allow bounded by MAX_AUTH_CACHE_ENTRIES, FIFO eviction in rememberCache
const preparedSourceAt = new Map<string, number>();
// perf-rules: allow bounded by MAX_AUTH_CACHE_ENTRIES, FIFO eviction in rememberCache
const commandCredentialCache = new Map<string, { key: string; at: number }>();

function rememberCache<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_AUTH_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearAuxiliaryAuthCache(): void {
  preparedSourceAt.clear();
  commandCredentialCache.clear();
}

/** Gateway-backed profiles of one backend, credentials included. */
export type GatewayProfiles = (backendId: NativeBackendId) => NativeBackendProfileConfig[];

/** Resolves the model for a bounded auxiliary purpose, falling back to `auxiliaryModels.default` when unset. */
export function resolveAuxiliaryModel(
  settings: Pick<AppSettings, 'auxiliaryModels'>,
  purpose: Exclude<AuxiliaryModelPurpose, 'default' | 'chat'>,
): AuxiliaryModelRef | undefined {
  return settings.auxiliaryModels?.[purpose] ?? settings.auxiliaryModels?.default;
}

/** Same profile and model source as the parent agent; caches command credentials briefly for speed. */
export async function profileModelEndpoint(ref: AuxiliaryModelRef, profile: NativeBackendProfileConfig, signal?: AbortSignal, options?: { bypassAuthCache?: boolean }): Promise<GatewayEndpoint> {
  signal?.throwIfAborted();
  const source = modelSourceOf(profile.config);
  const sourceKey = source
    ? JSON.stringify([source, typeof profile.config.apiEndpoint === 'string' ? profile.config.apiEndpoint.trim() : '', typeof profile.config.apiKey === 'string' ? profile.config.apiKey.trim() : ''])
    : undefined;
  const now = Date.now();
  if (sourceKey && (options?.bypassAuthCache || !(now - (preparedSourceAt.get(sourceKey) ?? -Infinity) < AUTH_CACHE_TTL_MS))) {
    await prepareSource(profile.config);
    rememberCache(preparedSourceAt, sourceKey, Date.now());
  }
  signal?.throwIfAborted();
  const protocol = gatewayProtocol(ref.backendId);
  const driverGateway = driverGatewayOf(profile);
  if (driverGateway?.auxiliaryComplete && !source && typeof profile.config.apiEndpoint !== 'string') {
    if (!protocol) throw new Error('The model provider is unavailable for side chats');
    return {
      protocol,
      baseUrl: '',
      model: gatewayModelId(ref.backendId, ref.model),
      executeComplete: request => driverGateway.auxiliaryComplete!(profile, {
        model: request.model, system: request.system, content: request.content,
        maxOutputTokens: request.maxOutputTokens, timeoutMs: request.timeoutMs, signal: request.signal,
      }),
      ...(driverGateway.auxiliaryStreamChat ? {
        executeStreamChat: request => driverGateway.auxiliaryStreamChat!(profile, {
          model: request.model, system: request.system,
          messages: request.messages.map(message => ({ role: message.role, content: message.content })),
          maxOutputTokens: request.maxOutputTokens, idleTimeoutMs: request.idleTimeoutMs,
          signal: request.signal, effort: request.effort, fast: request.fast, onDelta: request.onDelta,
        }),
      } : {}),
    };
  }
  const { resolved, credential } = launchSource(profile.config);
  const gateway = source && protocol ? sourceEndpoint(resolved, SOURCE_PROTOCOL[protocol]) : undefined;
  const baseUrl = source ? gateway?.baseUrl
    : typeof profile.config.apiEndpoint === 'string' ? profile.config.apiEndpoint : undefined;
  if (!protocol || !baseUrl || resolved?.reason) throw new Error('The model provider is unavailable for side chats');
  let apiKey = credential?.kind === 'static' ? credential.key : undefined;
  const configScope = typeof profile.config.configDir === 'string' ? profile.config.configDir : '';
  if (credential?.kind === 'command') {
    const cacheKey = JSON.stringify(['cmd', credential.command, credential.args, baseUrl, configScope]);
    const cached = !options?.bypassAuthCache ? commandCredentialCache.get(cacheKey) : undefined;
    if (cached && Date.now() - cached.at < AUTH_CACHE_TTL_MS) {
      apiKey = cached.key;
    } else {
      try {
        apiKey = (await promisify(execFile)(credential.command, credential.args, { timeout: 15_000, maxBuffer: 64 * 1024, encoding: 'utf8', signal })).stdout.trim();
        if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('Invalid credential');
        rememberCache(commandCredentialCache, cacheKey, { key: apiKey, at: Date.now() });
      } catch { throw new Error('The model provider credential could not be refreshed'); }
    }
  } else if (!apiKey && typeof profile.config.gatewayCredentialCommand === 'string' && profile.config.gatewayCredentialCommand.trim()) {
    const command = profile.config.gatewayCredentialCommand;
    const cacheKey = JSON.stringify(['sh', command, baseUrl, configScope]);
    const cached = !options?.bypassAuthCache ? commandCredentialCache.get(cacheKey) : undefined;
    if (cached && Date.now() - cached.at < AUTH_CACHE_TTL_MS) {
      apiKey = cached.key;
    } else {
      try {
        apiKey = (await promisify(execFile)('/bin/sh', ['-c', command], { timeout: 15_000, maxBuffer: 64 * 1024, encoding: 'utf8', signal })).stdout.trim();
        if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('Invalid credential');
        rememberCache(commandCredentialCache, cacheKey, { key: apiKey, at: Date.now() });
      } catch { throw new Error('The model provider credential could not be refreshed'); }
    }
  }
  const extraHeaders = profile.config.gatewayHeaders && typeof profile.config.gatewayHeaders === 'object' && !Array.isArray(profile.config.gatewayHeaders)
    ? Object.fromEntries(Object.entries(profile.config.gatewayHeaders as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : undefined;
  const headers = (extraHeaders || gateway?.headers) ? { ...extraHeaders, ...gateway?.headers } : undefined;
  // The public Anthropic API authenticates with x-api-key; compatible gateways use bearer keys.
  const anthropicKey = protocol === 'anthropic' && new URL(baseUrl).hostname === 'api.anthropic.com' && apiKey;
  const rawModel = gatewayModelId(ref.backendId, ref.model);
  const aliasMap = profile.config.gatewayModelAliases && typeof profile.config.gatewayModelAliases === 'object' && !Array.isArray(profile.config.gatewayModelAliases)
    ? profile.config.gatewayModelAliases as Record<string, unknown>
    : undefined;
  const resolvedAlias = aliasMap?.[rawModel.toLowerCase()];
  const model = typeof resolvedAlias === 'string' && resolvedAlias ? resolvedAlias : rawModel;
  return { protocol, baseUrl, model,
    ...(apiKey && !anthropicKey ? { apiKey } : {}),
    ...((headers || anthropicKey) ? { headers: { ...headers, ...(anthropicKey ? { 'x-api-key': anthropicKey } : {}) } } : {}) };
}

/** Models from just one provider, with parameters expressed in the chat gateway's vocabulary. */
export async function profileChatModels(ref: AuxiliaryModelRef, profile: NativeBackendProfileConfig, current?: { effort?: string }): Promise<ModelInfo[]> {
  const source = modelSourceOf(profile.config);
  const endpoint = source ? undefined : await profileModelEndpoint(ref, profile);
  const protocol = gatewayProtocol(ref.backendId);
  const listed = source && protocol
    ? await sourceCatalog(source, [SOURCE_PROTOCOL[protocol]], profile.config)
    : Array.isArray(profile.config.enabledModels) ? profile.config.enabledModels.filter((id): id is string => typeof id === 'string').map(value => ({ value, name: value, configOptions: [] } as ModelInfo))
      : await fetchGatewayModels({ ...endpoint!, reasoningLevels: true, timeoutMs: 10_000 });
  const currentId = gatewayModelId(ref.backendId, ref.model);
  // Only the picker includes an unlisted selection. Provider membership checks must use the
  // unmodified directory, otherwise an inherited native alias would validate itself.
  const models = current && !listed.some(info => gatewayModelId(ref.backendId, info.value) === currentId)
    ? [{ value: currentId, name: currentId, configOptions: [] }, ...listed] : listed;
  return models.map(info => {
    const supported = gatewayEfforts(gatewayProtocol(ref.backendId)!);
    const effort = info.configOptions.find(option => ['effort', 'reasoning_effort', 'reasoning'].includes(option.id));
    const levels = effort ? effort.options.filter(option => supported.includes(option.value as typeof supported[number]))
      : source ? [] : supported.map(value => ({ value, name: value }));
    const options = [{ value: 'default', name: 'Default' }, ...levels];
    const model = gatewayModelId(ref.backendId, info.value);
    const currentEffort = current?.effort;
    // Preserve an already selected effort without inventing other levels for a named source.
    if (model === currentId && currentEffort && supported.includes(currentEffort as typeof supported[number]) && !options.some(option => option.value === currentEffort)) options.push({ value: currentEffort, name: currentEffort });
    return { ...info, value: `${ref.backendId}:${ref.profileId}:${model}`, name: info.name,
      aliases: undefined, nativeVariants: undefined,
      configOptions: options.length ? [{ id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: model === currentId ? currentEffort ?? 'default' : effort?.currentValue ?? 'default', options }] : [] };
  });
}

/** Every model an auxiliary job can run on: each gateway profile's curated list, else its catalog. */
export async function listAuxiliaryModels(gatewayProfiles: GatewayProfiles, options: { listModels?: (request: GatewayModelsRequest) => Promise<ModelInfo[]>; signal?: AbortSignal } = {}): Promise<AuxiliaryModelOption[]> {
  const listModels = options.listModels ?? fetchGatewayModels;
  const groups = await Promise.all(AUXILIARY_MODEL_BACKENDS.flatMap(backendId => {
    let profiles: NativeBackendProfileConfig[];
    try { profiles = gatewayProfiles(backendId); } catch { return []; }
    return profiles.map(async (profile): Promise<AuxiliaryModelOption[]> => {
      const enabled = Array.isArray(profile.config.enabledModels) ? profile.config.enabledModels.filter((id): id is string => typeof id === 'string') : undefined;
      const driverGateway = driverGatewayOf(profile);
      const isCliProcess = !enabled && Boolean(driverGateway?.auxiliaryModels && typeof profile.config.apiEndpoint !== 'string' && !modelSourceOf(profile.config));
      const transport: AuxiliaryModelTransport = isCliProcess ? 'cli-process' : 'http';
      let ids = enabled;
      if (!ids) {
        try {
          if (isCliProcess) {
            ids = (await driverGateway!.auxiliaryModels!(profile, options.signal)).map(model => model.value);
          } else {
            const endpoint = await profileModelEndpoint({ backendId, profileId: profile.id, model: '' }, profile, options.signal, { bypassAuthCache: true });
            const headers = !options.listModels && endpoint.protocol === 'anthropic' && endpoint.headers?.['x-api-key']
              ? { 'anthropic-version': '2023-06-01', ...endpoint.headers }
              : endpoint.headers;
            const listed = await listModels({
              baseUrl: endpoint.baseUrl,
              ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
              ...(headers ? { headers } : {}),
              ...(!options.listModels ? { protocol: SOURCE_PROTOCOL[endpoint.protocol] } : {}),
              timeoutMs: 5_000,
              ...(options.signal ? { signal: options.signal } : {}),
            });
            const rawIds = listed.map(model => model.value);
            if (profile.config.gatewayModelScope === 'claude') {
              const claudeOnly = rawIds.filter(id => /claude/i.test(id));
              ids = claudeOnly.length ? claudeOnly : rawIds;
            } else {
              ids = rawIds;
            }
          }
        } catch (error) {
          if (options.signal?.aborted) throw error;
          ids = [];
        }
        if (!ids.length && typeof profile.config.defaultModel === 'string' && profile.config.defaultModel.trim()) {
          const fallback = profile.config.defaultModel.trim();
          const claudeAlias = backendId === 'claude' && /^(?:default|opus|sonnet|haiku|fable|opusplan|best)$/i.test(fallback);
          if (!claudeAlias) ids = [fallback];
        }
      }
      return [...new Set(ids.map(id => gatewayModelId(backendId, id)))]
        .map(model => ({ backendId, profileId: profile.id, profileName: profile.name, model, transport }));
    });
  }));
  const flattened = groups.flat();
  const rank = (item: AuxiliaryModelOption) => item.transport === 'cli-process' ? 1 : 0;
  return flattened.sort((left, right) => rank(left) - rank(right));
}

/** Where `ref` is served, with the name of the profile it is listed under; throws when that profile is gone. */
export async function auxiliaryEndpoint(ref: AuxiliaryModelRef, gatewayProfiles: GatewayProfiles, signal?: AbortSignal, options?: { bypassAuthCache?: boolean }): Promise<GatewayEndpoint & { profileName: string }> {
  const profile = gatewayProfiles(ref.backendId).find(item => item.id === ref.profileId);
  if (!profile) throw new Error('model profile is not configured');
  const endpoint = await profileModelEndpoint(ref, profile, signal, options);
  signal?.throwIfAborted();
  return { ...endpoint, profileName: profile.name };
}

/** What a plugin asks of `host.models.complete`, checked here: the host's own limits apply whatever the plugin sends. */
export interface PluginCompletion { use?: string; system: string; content: string; maxOutputTokens: number; timeoutMs?: number; signal?: AbortSignal }
/** What a plugin asks of `host.models.stream`: the same completion with `onDelta` called as text arrives. */
export interface PluginStreamCompletion extends PluginCompletion { onDelta(text: string): void }
/** The model choices a plugin completion reads, each read on every call so a settings change applies at once. */
export interface PluginModelChoices {
  default?(): AuxiliaryModelRef | undefined;
  chat(): AuxiliaryModelRef | undefined;
  use(id: string): AuxiliaryModelRef | undefined;
}

const PLUGIN_MAX_OUTPUT_TOKENS = 16_000;
const PLUGIN_TIMEOUT_MS = { default: 60_000, max: 120_000 } as const;

function resolvePluginCompletion(
  request: PluginCompletion, uses: readonly ModelUseDeclaration[], choices: PluginModelChoices,
  error: (code: string, message: string, status: number, details?: unknown) => Error,
): { ref: AuxiliaryModelRef; maxOutputTokens: number; timeoutMs: number } {
  let ref: AuxiliaryModelRef | undefined;
  if (request?.use !== undefined) {
    const use = uses.find(item => item.id === request.use);
    if (!use) throw error('PLUGIN_MODEL_USE_FOREIGN', `${String(request.use)} is not a model use this plugin declares`, 403);
    ref = choices.use(use.id)
      ?? (use.fallback === 'default' ? choices.default?.() : use.fallback === 'chat' ? choices.chat() : undefined);
    if (!ref) throw error('PLUGIN_MODEL_NOT_CHOSEN', 'Choose a model for this plugin in Settings › Auxiliary models', 409, { use: use.id });
  } else {
    ref = choices.chat();
    if (!ref) throw error('PLUGIN_MODEL_NOT_CHOSEN', 'Choose a default model in Settings › Quick chat', 409);
  }
  if (typeof request?.system !== 'string' || typeof request.content !== 'string' || !request.content.trim()) throw error('INVALID_INPUT', 'system and content must be text', 400);
  const maxOutputTokens = Math.trunc(request.maxOutputTokens);
  if (!(maxOutputTokens > 0 && maxOutputTokens <= PLUGIN_MAX_OUTPUT_TOKENS)) throw error('INVALID_INPUT', `maxOutputTokens must be 1 to ${PLUGIN_MAX_OUTPUT_TOKENS}`, 400);
  const timeoutMs = Math.min(Math.max(1_000, Math.trunc(request.timeoutMs ?? PLUGIN_TIMEOUT_MS.default)), PLUGIN_TIMEOUT_MS.max);
  return { ref, maxOutputTokens, timeoutMs };
}

function mapPluginModelError(error: unknown, signal: AbortSignal | undefined, buildError: (code: string, message: string, status: number, details?: unknown) => Error): never {
  if (signal?.aborted) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'model output was cut off at the token limit') throw buildError('PLUGIN_MODEL_CUT_OFF', message, 502);
  if ((error instanceof Error && error.name === 'TimeoutError') || /aborted due to timeout|timed out/i.test(message)) {
    throw buildError('PLUGIN_MODEL_TIMEOUT', 'The model timed out', 504);
  }
  throw error;
}

/**
 * `host.models.complete` (docs/PLUGIN_ARCHITECTURE.md「模型用途」): one completion on the model chosen for one of the plugin's
 * own `uses`, else on that use's fallback (`default` auxiliary model or `chat`); without a use, on the model chosen for 快速对话.
 * With none it refuses with 409 `PLUGIN_MODEL_NOT_CHOSEN`, naming the use in its details so a client opens the right setting.
 */
export async function completeForPlugin(
  request: PluginCompletion, uses: readonly ModelUseDeclaration[], choices: PluginModelChoices, gatewayProfiles: GatewayProfiles,
  options: { complete?: typeof complete; error: (code: string, message: string, status: number, details?: unknown) => Error; record?: AuxiliaryCallRecorder },
): Promise<string> {
  const { ref, maxOutputTokens, timeoutMs } = resolvePluginCompletion(request, uses, choices, options.error);
  const resolveEndpoint = async (bypassAuthCache = false) => {
    try { return await auxiliaryEndpoint(ref, gatewayProfiles, request.signal, bypassAuthCache ? { bypassAuthCache: true } : undefined); }
    catch (error) {
      if (request.signal?.aborted) throw error;
      throw options.error('PLUGIN_MODEL_UNAVAILABLE', error instanceof Error && error.message ? error.message : 'The chosen model\'s provider is unavailable', 409);
    }
  };
  const runComplete = options.complete ?? complete;
  const authStartedAt = Date.now();
  let endpoint = await resolveEndpoint(false);
  let authMs = Math.max(0, Date.now() - authStartedAt);
  const emitRecord = (metrics: CompletionMetrics | undefined, ok: boolean, durationMs: number, errorCode?: string) => {
    if (!options.record || request.signal?.aborted) return;
    options.record({
      kind: 'plugin', preset: 'stream', source: 'live',
      backendId: ref.backendId, profileId: ref.profileId, model: ref.model,
      transport: (endpoint.executeComplete || endpoint.executeStreamChat) ? 'cli-process' : 'http',
      protocol: endpoint.protocol,
      ok: metrics?.ok ?? ok, authMs, ttftMs: metrics?.ttftMs ?? null, durationMs: metrics?.durationMs ?? durationMs,
      inputTokens: metrics?.inputTokens ?? null, outputTokens: metrics?.outputTokens ?? null,
      reasoningTokens: metrics?.reasoningTokens ?? null, reasoningChars: metrics?.reasoningChars ?? 0,
      thinkingDetected: metrics?.thinkingDetected ?? false, streaming: metrics?.streaming ?? false,
      ...(metrics?.errorCode || errorCode ? { errorCode: metrics?.errorCode ?? errorCode } : {}),
    });
  };
  let metrics: CompletionMetrics | undefined;
  const startedAt = Date.now();
  try {
    const out = await runComplete({ ...endpoint, system: request.system, content: request.content, maxOutputTokens, timeoutMs, onMetrics: m => { metrics = m; }, ...(request.signal ? { signal: request.signal } : {}) });
    emitRecord(metrics, true, Math.max(0, Date.now() - startedAt));
    return out;
  } catch (error) {
    if (!request.signal?.aborted && error instanceof GatewayHttpError && (error.status === 401 || error.status === 403)) {
      const retryAuthAt = Date.now();
      endpoint = await resolveEndpoint(true);
      authMs += Math.max(0, Date.now() - retryAuthAt);
      metrics = undefined;
      const retryStartedAt = Date.now();
      try {
        const out = await runComplete({ ...endpoint, system: request.system, content: request.content, maxOutputTokens, timeoutMs, onMetrics: m => { metrics = m; }, ...(request.signal ? { signal: request.signal } : {}) });
        emitRecord(metrics, true, Math.max(0, Date.now() - retryStartedAt));
        return out;
      } catch (retryError) {
        emitRecord(metrics, false, Math.max(0, Date.now() - retryStartedAt), retryError instanceof GatewayHttpError ? `HTTP_${retryError.status}` : 'ERROR');
        mapPluginModelError(retryError, request.signal, options.error);
      }
    }
    emitRecord(metrics, false, Math.max(0, Date.now() - startedAt), error instanceof GatewayHttpError ? `HTTP_${error.status}` : 'ERROR');
    mapPluginModelError(error, request.signal, options.error);
  }
}

/**
 * `host.models.stream`: streaming counterpart of `completeForPlugin`, calling `onDelta` as answer text arrives.
 */
export async function streamForPlugin(
  request: PluginStreamCompletion, uses: readonly ModelUseDeclaration[], choices: PluginModelChoices, gatewayProfiles: GatewayProfiles,
  options: { streamComplete?: typeof streamComplete; error: (code: string, message: string, status: number, details?: unknown) => Error; record?: AuxiliaryCallRecorder },
): Promise<string> {
  if (typeof request?.onDelta !== 'function') throw options.error('INVALID_INPUT', 'onDelta must be a function', 400);
  const { ref, maxOutputTokens, timeoutMs } = resolvePluginCompletion(request, uses, choices, options.error);
  const resolveEndpoint = async (bypassAuthCache = false) => {
    try { return await auxiliaryEndpoint(ref, gatewayProfiles, request.signal, bypassAuthCache ? { bypassAuthCache: true } : undefined); }
    catch (error) {
      if (request.signal?.aborted) throw error;
      throw options.error('PLUGIN_MODEL_UNAVAILABLE', error instanceof Error && error.message ? error.message : 'The chosen model\'s provider is unavailable', 409);
    }
  };
  const runStream = options.streamComplete ?? streamComplete;
  const authStartedAt = Date.now();
  let endpoint = await resolveEndpoint(false);
  let authMs = Math.max(0, Date.now() - authStartedAt);
  let emitted = 0;
  const onDelta = (text: string) => { emitted += text.length; request.onDelta(text); };
  const emitRecord = (metrics: CompletionMetrics | undefined, ok: boolean, durationMs: number, errorCode?: string) => {
    if (!options.record || request.signal?.aborted) return;
    options.record({
      kind: 'plugin', preset: 'stream', source: 'live',
      backendId: ref.backendId, profileId: ref.profileId, model: ref.model,
      transport: (endpoint.executeComplete || endpoint.executeStreamChat) ? 'cli-process' : 'http',
      protocol: endpoint.protocol,
      ok: metrics?.ok ?? ok, authMs, ttftMs: metrics?.ttftMs ?? null, durationMs: metrics?.durationMs ?? durationMs,
      inputTokens: metrics?.inputTokens ?? null, outputTokens: metrics?.outputTokens ?? null,
      reasoningTokens: metrics?.reasoningTokens ?? null, reasoningChars: metrics?.reasoningChars ?? 0,
      thinkingDetected: metrics?.thinkingDetected ?? false, streaming: metrics?.streaming ?? true,
      ...(metrics?.errorCode || errorCode ? { errorCode: metrics?.errorCode ?? errorCode } : {}),
    });
  };
  let metrics: CompletionMetrics | undefined;
  const startedAt = Date.now();
  try {
    const out = await runStream({ ...endpoint, system: request.system, content: request.content, maxOutputTokens, timeoutMs, onDelta, onMetrics: m => { metrics = m; }, ...(request.signal ? { signal: request.signal } : {}) });
    emitRecord(metrics, true, Math.max(0, Date.now() - startedAt));
    return out;
  } catch (error) {
    if (!request.signal?.aborted && emitted === 0 && error instanceof GatewayHttpError && (error.status === 401 || error.status === 403)) {
      const retryAuthAt = Date.now();
      endpoint = await resolveEndpoint(true);
      authMs += Math.max(0, Date.now() - retryAuthAt);
      metrics = undefined;
      const retryStartedAt = Date.now();
      try {
        const out = await runStream({ ...endpoint, system: request.system, content: request.content, maxOutputTokens, timeoutMs, onDelta, onMetrics: m => { metrics = m; }, ...(request.signal ? { signal: request.signal } : {}) });
        emitRecord(metrics, true, Math.max(0, Date.now() - retryStartedAt));
        return out;
      } catch (retryError) {
        emitRecord(metrics, false, Math.max(0, Date.now() - retryStartedAt), retryError instanceof GatewayHttpError ? `HTTP_${retryError.status}` : 'ERROR');
        mapPluginModelError(retryError, request.signal, options.error);
      }
    }
    emitRecord(metrics, false, Math.max(0, Date.now() - startedAt), error instanceof GatewayHttpError ? `HTTP_${error.status}` : 'ERROR');
    mapPluginModelError(error, request.signal, options.error);
  }
}
