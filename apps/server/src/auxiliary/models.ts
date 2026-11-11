import type { AuxiliaryModelOption, AuxiliaryModelRef, ModelInfo, NativeBackendId } from '../../../../packages/contracts/src/index.js';
import type { NativeBackendProfileConfig } from '../backends/types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchSource, modelSourceOf, prepareSource, sourceCatalog, sourceEndpoint } from '../backends/shared/model-source.js';
import { fetchGatewayModels, type GatewayModelsRequest } from '../backends/shared/gateway-models.js';
import { AUXILIARY_MODEL_BACKENDS, gatewayEfforts, gatewayModelId, gatewayProtocol, type GatewayEndpoint, type GatewayProtocol } from './gateway.js';

/** The gateway protocol a model source names for each wire format a side chat can speak. */
const SOURCE_PROTOCOL: Record<GatewayProtocol, string> = { anthropic: 'anthropic-messages', responses: 'openai-responses', chat: 'openai-chat' };

/** Gateway-backed profiles of one backend, credentials included. */
export type GatewayProfiles = (backendId: NativeBackendId) => NativeBackendProfileConfig[];

/** Same profile and model source as the parent agent; refresh command credentials for every request. */
export async function profileModelEndpoint(ref: AuxiliaryModelRef, profile: NativeBackendProfileConfig, signal?: AbortSignal): Promise<GatewayEndpoint> {
  await prepareSource(profile.config);
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
      const ids = enabled ?? (await listModels({
        baseUrl: String(profile.config.apiEndpoint),
        ...(typeof profile.config.apiKey === 'string' ? { apiKey: profile.config.apiKey } : {}),
        timeoutMs: 5_000,
        ...(options.signal ? { signal: options.signal } : {}),
      }).catch(error => {
        if (options.signal?.aborted) throw error;
        return [];
      })).map(model => model.value);
      return [...new Set(ids.map(id => gatewayModelId(backendId, id)))]
        .map(model => ({ backendId, profileId: profile.id, profileName: profile.name, model }));
    });
  }));
  return groups.flat();
}

/** Where `ref` is served, with the name of the profile it is listed under; throws when that profile is gone. */
export function auxiliaryEndpoint(ref: AuxiliaryModelRef, gatewayProfiles: GatewayProfiles): GatewayEndpoint & { profileName: string } {
  const protocol = gatewayProtocol(ref.backendId);
  const profile = gatewayProfiles(ref.backendId).find(item => item.id === ref.profileId);
  if (!protocol || !profile) throw new Error('model profile is not configured');
  return {
    protocol,
    baseUrl: String(profile.config.apiEndpoint),
    ...(typeof profile.config.apiKey === 'string' ? { apiKey: profile.config.apiKey } : {}),
    model: gatewayModelId(ref.backendId, ref.model),
    profileName: profile.name,
  };
}
