import { createHash } from 'node:crypto';
import type { ModelInfo, Session } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { FreshCache } from '../shared/fresh-cache.js';
import { fetchGatewayModels } from '../shared/gateway-models.js';
import { modelSourceOf, sourceCatalog } from '../shared/model-source.js';
import { versionAtLeast } from '../shared/cli-version.js';
import { nativeModelEffort, parseNativeModelSelection } from '../shared/model-selection.js';
import type { NativeBackendProfileConfig } from '../types.js';
import { ClaudeCliProbe, string, executableOf, runHelp } from './launch.js';

/** Fast and 1M context were verified from this version on; older builds only offer the defaults. */
const MODEL_OPTIONS_MIN_VERSION = '2.1.252';

const CLAUDE_MODELS: ModelInfo[] = [
  { value: 'sonnet', name: 'Sonnet', configOptions: [] },
  { value: 'opus', name: 'Opus', configOptions: [] },
  { value: 'haiku', name: 'Haiku', configOptions: [] },
];

const CLAUDE_EFFORTS = [
  { value: 'default', name: 'Default' },
  { value: 'low', name: 'Low' },
  { value: 'medium', name: 'Medium' },
  { value: 'high', name: 'High' },
  { value: 'xhigh', name: 'Extra high' },
  { value: 'max', name: 'Max' },
];

function claudeModelBase(model: string): string {
  return model.trim().replace(/(?:\[1m\])+$/i, '');
}

/** Preserve native long-context intent in the same parameter form used by every client. */
export function normalizeClaudeModel(value: string): string {
  const selection = parseNativeModelSelection(value);
  const model = claudeModelBase(selection.model);
  const params = { ...(model !== selection.model ? { context: '1m' } : {}), ...selection.params };
  const entries = Object.entries(params).sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? `${model}[${entries.map(([key, option]) => `${key}=${option}`).join(',')}]` : model;
}

function claudeModelName(model: string): string {
  const match = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(model);
  if (!match) return model;
  const family = match[1]!.toLowerCase();
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${match[2]}${match[3] ? `.${match[3]}` : ''}`;
}

function claudeFastModel(model: string, probe?: ClaudeCliProbe): boolean {
  if (!probe || !versionAtLeast(probe.parsed, MODEL_OPTIONS_MIN_VERSION)) return false;
  const base = claudeModelBase(model).toLowerCase();
  // Match Claude Code's capability fallback, including gateway namespaces and dated model ids.
  return base === 'opus' || base.includes('opus-4-8') || base.includes('opus-5');
}

function claudeNativeModel(model: string): boolean {
  const base = claudeModelBase(model).toLowerCase();
  return !base || ['default', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan', 'best'].includes(base) || base.includes('claude-');
}

function claudeLongContextModel(model: string, probe?: ClaudeCliProbe, contextWindow?: number, longContext = false): boolean {
  if (!probe || !versionAtLeast(probe.parsed, MODEL_OPTIONS_MIN_VERSION)) return false;
  const base = claudeModelBase(model).toLowerCase();
  // A discovered gateway id that already carries Claude Code's `[1m]` suffix is the provider saying
  // this model is its long-context variant; the gateway need not declare a token limit for that.
  return (!claudeNativeModel(base) && (longContext || (contextWindow !== undefined && contextWindow >= 1_000_000)))
    || base === 'opus' || base === 'sonnet'
    || ['opus-4-6', 'opus-4-7', 'opus-4-8', 'opus-5', 'sonnet-4-5', 'sonnet-4-6', 'sonnet-5'].some(id => base.includes(id));
}

function selectedContext(value: string | undefined): '1m' | undefined {
  const selection = parseNativeModelSelection(value);
  const context = selection.params.context;
  if (context !== undefined && context !== 'default' && context !== '1m') {
    throw new AppError('INVALID_MODEL_PARAMETER', 'Claude context must be default or 1m');
  }
  if (context === 'default') return undefined;
  return context === '1m' || /\[1m\]$/i.test(selection.model) ? '1m' : undefined;
}

export function selectedFast(value: string | undefined): boolean | undefined {
  const fast = parseNativeModelSelection(value).params.fast;
  if (fast === undefined || fast === 'default') return undefined;
  if (fast !== 'true' && fast !== 'false') throw new AppError('INVALID_MODEL_PARAMETER', 'Claude Fast must be default, true or false');
  return fast === 'true';
}

/**
 * Gateway catalogs by provider: listing models, launching and checking a send all need the same one,
 * and a gateway can take seconds to list (some take 15). Each is read once, trusted while fresh, and
 * once stale still answered at once while a refresh runs behind it; a failed refresh keeps the last
 * catalog that was read. The key covers the whole profile config, so editing a provider reads anew.
 */
export const gatewayCatalogs = new FreshCache<ModelInfo[] | undefined>(5 * 60_000, 32);

/**
 * The windows a profile declares for models its gateway does not describe. The person configuring it is
 * the one who knows what a pass-through id really runs on, so a declaration replaces the gateway's figure.
 */
function declaredContextWindows(profile: NativeBackendProfileConfig): Map<string, number> {
  const declared = new Map<string, number>();
  const raw = profile.config.modelContextWindows;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return declared;
  for (const [id, window] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof window === 'number' && Number.isSafeInteger(window) && window > 0) declared.set(claudeModelBase(id), window);
  }
  return declared;
}

/** The gateway's catalog with the profile's declared windows applied, including ids the gateway does not list. */
export async function claudeGatewayModels(profile: NativeBackendProfileConfig): Promise<ModelInfo[] | undefined> {
  const catalog = await cachedGatewayModels(profile);
  const declared = declaredContextWindows(profile);
  // No gateway (the CLI's own login): declarations must not stand in for Claude's built-in model list.
  if (!declared.size || catalog === undefined) return catalog;
  const listed = catalog.map(item => {
    const window = declared.get(claudeModelBase(item.value));
    return window === undefined ? item : { ...item, contextWindow: window };
  });
  const known = new Set(listed.map(item => claudeModelBase(item.value)));
  return [...listed, ...[...declared].filter(([id]) => !known.has(id)).map(([id, window]) => ({ value: id, name: id, configOptions: [], contextWindow: window }))];
}

function cachedGatewayModels(profile: NativeBackendProfileConfig): Promise<ModelInfo[] | undefined> {
  // Only what reaches the gateway keys its catalog: choosing models or declaring their windows does not read it again.
  const { modelContextWindows: _declared, defaultModel: _default, enabledModels: _enabled, ...config } = profile.config;
  const key = createHash('sha256').update(JSON.stringify([profile.id, config])).digest('hex');
  return gatewayCatalogs.get(key, () => readGatewayModels(profile));
}

async function readGatewayModels(profile: NativeBackendProfileConfig): Promise<ModelInfo[] | undefined> {
  // A named source answers for itself: its catalog is not necessarily reachable over plain HTTP,
  // and its own metadata is more accurate than the gateway's.
  const source = modelSourceOf(profile.config);
  if (source) return await sourceCatalog(source, ['anthropic-messages'], profile.config);
  const endpoint = string(profile.config.apiEndpoint)?.trim();
  if (!endpoint) return undefined;
  const apiKey = string(profile.config.apiKey);
  return await fetchGatewayModels({
    baseUrl: endpoint, ...(apiKey ? { apiKey } : {}),
    ...(new URL(endpoint).hostname.toLowerCase() === 'api.anthropic.com' ? { auth: 'anthropic' as const } : {}),
  });
}

function gatewayModelWindow(model: string, catalog: ModelInfo[] | undefined): number | undefined {
  return catalog?.find(item => claudeModelBase(item.value) === claudeModelBase(model))?.contextWindow;
}

/** Teach Claude the declared window of an otherwise unknown model without changing its identity. */
export async function gatewayContextEnv(profile: NativeBackendProfileConfig, value: string | undefined): Promise<Record<string, string>> {
  const model = claudeModelBase(parseNativeModelSelection(value).model);
  if (claudeNativeModel(model) || selectedContext(value) === '1m') return {};
  const contextWindow = declaredContextWindows(profile).get(model)
    ?? gatewayModelWindow(model, await claudeGatewayModels(profile).catch(() => undefined));
  return contextWindow === undefined ? {} : { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow) };
}

/** A `claude-` id the profile declares at 1M: the case `CLAUDE_CODE_MAX_CONTEXT_TOKENS` cannot reach. */
function declaresLongContext(profile: NativeBackendProfileConfig, model: string): boolean {
  const base = claudeModelBase(model);
  return claudeNativeModel(base) && (declaredContextWindows(profile).get(base) ?? 0) >= 1_000_000;
}

/**
 * Claude Code sizes a bare `claude-` id from its own model table and ignores the declared-window
 * variable for it, so a model newer than the installed CLI runs at 200K. `[1m]` is the one statement
 * of a window the CLI accepts for such an id, and leaves the window alone where the table already
 * says 1M — so a profile that declares 1M launches with it.
 */
export async function declaredLongContext(profile: NativeBackendProfileConfig, value: string | undefined): Promise<boolean> {
  if (!declaresLongContext(profile, parseNativeModelSelection(value).model)) return false;
  const probe = await runHelp(executableOf(profile)).catch(() => undefined);
  return probe !== undefined && versionAtLeast(probe.parsed, MODEL_OPTIONS_MIN_VERSION);
}

export function claudeModels(configured?: string, catalog?: ModelInfo[], probe?: ClaudeCliProbe, declaredEffort = false, profile?: NativeBackendProfileConfig): ModelInfo[] {
  const selection = parseNativeModelSelection(configured);
  const currentModel = claudeModelBase(selection.model);
  const currentEffort = nativeModelEffort(selection) ?? 'default';
  const currentContext = selection.params.context ?? (/\[1m\]$/i.test(selection.model) ? '1m' : 'default');
  // Named sources own their model membership; an empty directory must not invent native aliases.
  const listed = declaredEffort ? catalog ?? [] : catalog?.length ? catalog : CLAUDE_MODELS;
  const models = [...new Map(listed.map(model => {
    const value = claudeModelBase(model.value);
    // The suffix the gateway listed the model under is its own declaration of the long-context variant.
    const longContext = /(?:\[1m\])+$/i.test(model.value);
    return [value, { ...model, value, longContext, name: model.name === model.value ? claudeModelName(value) : model.name.replace(/\s*\[1m\]$/i, '') }];
  })).values()];
  if (currentModel && !models.some(model => model.value === currentModel)) models.unshift({ value: currentModel, name: currentModel, longContext: false, configOptions: [] });
  return models.map(model => ({
    ...model,
    name: model.name === model.value ? claudeModelName(model.value) : model.name,
    configOptions: [...(declaredEffort ? model.configOptions.filter(option => option.id === 'effort').map(option => ({
      ...option,
      currentValue: model.value === currentModel && option.options.some(level => level.value === currentEffort) ? currentEffort : option.currentValue,
    })) : [{
      id: 'effort', name: 'Effort', category: 'thought_level', type: 'select' as const,
      currentValue: model.value === currentModel ? currentEffort : 'default', options: CLAUDE_EFFORTS,
    }]), ...(claudeFastModel(model.value, probe) ? [{
      id: 'fast', name: 'Fast', category: 'model_config', type: 'select' as const,
      currentValue: model.value === currentModel ? selection.params.fast ?? 'default' : 'default',
      description: 'Default follows Claude Code. On requests Fast; whether it applies depends on the model, account, organization policy and upstream service. Fast may cost more; a change applies once the session is idle.',
      options: [{ value: 'default', name: 'Default' }, { value: 'true', name: 'On' }, { value: 'false', name: 'Off' }],
    }] : []), ...(claudeLongContextModel(model.value, probe, model.contextWindow, model.longContext) ? [{
      id: 'context', name: 'Context', category: 'model_config', type: 'select' as const,
      currentValue: model.value === currentModel ? currentContext : 'default',
      description: `Requests a 1M context window; whether it applies depends on the account, organization policy and upstream model, and it may cost more. ${(!claudeNativeModel(model.value) && model.contextWindow !== undefined) || (profile && declaresLongContext(profile, model.value)) ? 'Default uses the window the provider declares' : 'Default follows Claude Code'}; a change applies once the session is idle.`,
      options: [{ value: 'default', name: 'Default' }, { value: '1m', name: '1M' }],
    }] : [])],
  }));
}

export function selectedModel(session: Session, profile: NativeBackendProfileConfig): string | undefined {
  return session.model ?? string(profile.config.defaultModel);
}

export function modelArgs(value: string | undefined, declaredLong = false): string[] {
  if (!value) return [];
  const selection = parseNativeModelSelection(value);
  const model = claudeModelBase(selection.model);
  if (!model || selection.model.length > 200 || /[\0\r\n]/.test(selection.model)) throw new AppError('INVALID_NATIVE_MODEL', 'Claude model selection is invalid');
  const args = ['--model', `${model}${declaredLong || selectedContext(value) === '1m' ? '[1m]' : ''}`];
  const effort = nativeModelEffort(selection);
  if (effort && effort !== 'default') {
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new AppError('INVALID_MODEL_PARAMETER', 'Claude effort must be a supported effort level');
    args.push('--effort', effort);
  }
  return args;
}

export async function validateModelSelection(profile: NativeBackendProfileConfig, value: string | undefined): Promise<void> {
  modelArgs(value);
  const fast = selectedFast(value);
  const context = selectedContext(value);
  if (fast === undefined && context === undefined) return;
  const probe = await runHelp(executableOf(profile));
  if (!versionAtLeast(probe.parsed, MODEL_OPTIONS_MIN_VERSION)) {
    throw new AppError('INVALID_MODEL_PARAMETER', `This Claude Code version has not been verified for Fast or 1M context; update to ${MODEL_OPTIONS_MIN_VERSION} or later, or choose the defaults.`);
  }
  if (fast && !claudeFastModel(parseNativeModelSelection(value).model, probe)) {
    throw new AppError('INVALID_MODEL_PARAMETER', 'This model has no verified Claude Code Fast support; choose Opus or reset Fast to default.');
  }
  if (context && !claudeLongContextModel(parseNativeModelSelection(value).model, probe)) {
    const model = parseNativeModelSelection(value).model;
    let catalog: ModelInfo[] | undefined;
    // A window the profile declares answers for the model without asking the gateway.
    const declared = declaredContextWindows(profile).get(claudeModelBase(model));
    if (declared !== undefined) catalog = [{ value: claudeModelBase(model), name: model, configOptions: [], contextWindow: declared }];
    else if (!claudeNativeModel(model)) {
      try { catalog = await claudeGatewayModels(profile); }
      catch (error) { throw new AppError('NATIVE_MODEL_CATALOG_UNAVAILABLE', `Claude could not verify this gateway model's context limit (${error instanceof Error ? error.message : String(error)}).`, 503); }
    }
    const declaredLongContext = catalog?.some(item => claudeModelBase(item.value) === claudeModelBase(model) && /(?:\[1m\])+$/i.test(item.value)) ?? false;
    if (!claudeLongContextModel(model, probe, gatewayModelWindow(model, catalog), declaredLongContext)) {
      throw new AppError('INVALID_MODEL_PARAMETER', 'This model has no declared 1M context support; choose a supported model or reset Context to default.');
    }
  }
}
