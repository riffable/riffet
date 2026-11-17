import type { AuxiliaryModelOption, AuxiliaryModelRef, ModelInfo, ModelUseDeclaration, NativeBackendId } from '../../../../packages/contracts/src/index.js';
import type { NativeBackendProfileConfig } from '../backends/types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchSource, modelSourceOf, prepareSource, sourceCatalog, sourceEndpoint } from '../backends/shared/model-source.js';
import { fetchGatewayModels, type GatewayModelsRequest } from '../backends/shared/gateway-models.js';
import { AUXILIARY_MODEL_BACKENDS, complete, gatewayEfforts, gatewayModelId, gatewayProtocol, type GatewayEndpoint, type GatewayProtocol } from './gateway.js';

/** The gateway protocol a model source names for each wire format a side chat can speak. */
const SOURCE_PROTOCOL: Record<GatewayProtocol, string> = { anthropic: 'anthropic-messages', responses: 'openai-responses', chat: 'openai-chat' };

/** Gateway-backed profiles of one backend, credentials included. */
export type GatewayProfiles = (backendId: NativeBackendId) => NativeBackendProfileConfig[];

/** Same profile and model source as the parent agent; refresh command credentials for every request. */
export async function profileModelEndpoint(ref: AuxiliaryModelRef, profile: NativeBackendProfileConfig, signal?: AbortSignal): Promise<GatewayEndpoint> {
  signal?.throwIfAborted();
  await prepareSource(profile.config);
  signal?.throwIfAborted();
  const protocol = gatewayProtocol(ref.backendId);
  const { resolved, credential } = launchSource(profile.config);
  const source = modelSourceOf(profile.config);
  const gateway = source && protocol ? sourceEndpoint(resolved, SOURCE_PROTOCOL[protocol]) : undefined;
  const baseUrl = source ? gateway?.baseUrl
    : typeof profile.config.apiEndpoint === 'string' ? profile.config.apiEndpoint : undefined;
  if (!protocol || !baseUrl || resolved?.reason) throw new Error('The model provider is unavailable for side chats');
  let apiKey = credential?.kind === 'static' ? credential.key : undefined;
  if (credential?.kind === 'command') {
    try {
      apiKey = (await promisify(execFile)(credential.command, credential.args, { timeout: 15_000, maxBuffer: 64 * 1024, encoding: 'utf8', signal })).stdout.trim();
      if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('Invalid credential');
    } catch { throw new Error('The model provider credential could not be refreshed'); }
  }
  const headers = gateway?.headers;
  // The public Anthropic API authenticates with x-api-key; compatible gateways use bearer keys.
  const anthropicKey = protocol === 'anthropic' && new URL(baseUrl).hostname === 'api.anthropic.com' && apiKey;
  return { protocol, baseUrl, model: gatewayModelId(ref.backendId, ref.model),
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
      let ids = enabled;
      if (!ids) {
        try {
          const endpoint = await profileModelEndpoint({ backendId, profileId: profile.id, model: '' }, profile, options.signal);
          ids = (await listModels({
            baseUrl: endpoint.baseUrl,
            ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
            ...(endpoint.headers ? { headers: endpoint.headers } : {}),
            timeoutMs: 5_000,
            ...(options.signal ? { signal: options.signal } : {}),
          })).map(model => model.value);
        } catch (error) {
          if (options.signal?.aborted) throw error;
          ids = [];
        }
      }
      return [...new Set(ids.map(id => gatewayModelId(backendId, id)))]
        .map(model => ({ backendId, profileId: profile.id, profileName: profile.name, model }));
    });
  }));
  return groups.flat();
}

/** Where `ref` is served, with the name of the profile it is listed under; throws when that profile is gone. */
export async function auxiliaryEndpoint(ref: AuxiliaryModelRef, gatewayProfiles: GatewayProfiles, signal?: AbortSignal): Promise<GatewayEndpoint & { profileName: string }> {
  const profile = gatewayProfiles(ref.backendId).find(item => item.id === ref.profileId);
  if (!profile) throw new Error('model profile is not configured');
  const endpoint = await profileModelEndpoint(ref, profile, signal);
  signal?.throwIfAborted();
  return { ...endpoint, profileName: profile.name };
}

/** What a plugin asks of `host.models.complete`, checked here: the host's own limits apply whatever the plugin sends. */
export interface PluginCompletion { use?: string; system: string; content: string; maxOutputTokens: number; timeoutMs?: number; signal?: AbortSignal }
/** The model choices a plugin completion reads, each read on every call so a settings change applies at once. */
export interface PluginModelChoices { chat(): AuxiliaryModelRef | undefined; use(id: string): AuxiliaryModelRef | undefined }

const PLUGIN_MAX_OUTPUT_TOKENS = 16_000;
const PLUGIN_TIMEOUT_MS = { default: 60_000, max: 120_000 } as const;

/**
 * `host.models.complete` (docs/PLUGIN_ARCHITECTURE.md「模型用途」): one completion on the model chosen for one of the plugin's
 * own `uses`, else on that use's fallback; without a use, on the model chosen for 快速对话. With none it refuses with 409
 * `PLUGIN_MODEL_NOT_CHOSEN`, naming the use in its details so a client opens the right setting.
 */
export async function completeForPlugin(
  request: PluginCompletion, uses: readonly ModelUseDeclaration[], choices: PluginModelChoices, gatewayProfiles: GatewayProfiles,
  options: { complete?: typeof complete; error: (code: string, message: string, status: number, details?: unknown) => Error },
): Promise<string> {
  let ref: AuxiliaryModelRef | undefined;
  if (request?.use !== undefined) {
    const use = uses.find(item => item.id === request.use);
    if (!use) throw options.error('PLUGIN_MODEL_USE_FOREIGN', `${String(request.use)} is not a model use this plugin declares`, 403);
    ref = choices.use(use.id) ?? (use.fallback === 'chat' ? choices.chat() : undefined);
    if (!ref) throw options.error('PLUGIN_MODEL_NOT_CHOSEN', 'Choose a model for this plugin in Settings › Auxiliary models', 409, { use: use.id });
  } else {
    ref = choices.chat();
    if (!ref) throw options.error('PLUGIN_MODEL_NOT_CHOSEN', 'Choose a default model in Settings › Quick chat', 409);
  }
  if (typeof request?.system !== 'string' || typeof request.content !== 'string' || !request.content.trim()) throw options.error('INVALID_INPUT', 'system and content must be text', 400);
  const maxOutputTokens = Math.trunc(request.maxOutputTokens);
  if (!(maxOutputTokens > 0 && maxOutputTokens <= PLUGIN_MAX_OUTPUT_TOKENS)) throw options.error('INVALID_INPUT', `maxOutputTokens must be 1 to ${PLUGIN_MAX_OUTPUT_TOKENS}`, 400);
  const timeoutMs = Math.min(Math.max(1_000, Math.trunc(request.timeoutMs ?? PLUGIN_TIMEOUT_MS.default)), PLUGIN_TIMEOUT_MS.max);
  const endpoint = await auxiliaryEndpoint(ref, gatewayProfiles, request.signal);
  return (options.complete ?? complete)({ ...endpoint, system: request.system, content: request.content, maxOutputTokens, timeoutMs, ...(request.signal ? { signal: request.signal } : {}) });
}
