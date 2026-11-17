import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelInfo, NativeModelApiProtocol } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { validateNativeModelApiProtocol } from '../../settings/index.js';
import { effortOption, fetchGatewayModels, gatewayBaseUrl, gatewayRootUrl, googleBaseUrl, modelIdOf } from '../shared/gateway-models.js';
import { parseNativeModelSelection } from '../shared/model-selection.js';
import type { NativeBackendProfileConfig } from '../types.js';

/** Riffet profiles keep their own model/key namespace; they never overwrite pi's models.json. */
export function piProviderId(profile: NativeBackendProfileConfig): string {
  return `riffet-${createHash('sha256').update(profile.id).digest('hex').slice(0, 16)}`;
}

export function piCustomEndpoint(profile: NativeBackendProfileConfig): string | undefined {
  const value = profile.config.apiEndpoint;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function piApiProtocol(profile: NativeBackendProfileConfig): NativeModelApiProtocol {
  return validateNativeModelApiProtocol(profile.config.apiProtocol ?? 'openai-completions');
}

/** A slash inside a gateway model id belongs to the model, rather than to pi's provider prefix. */
export function piCustomModelId(profile: NativeBackendProfileConfig, value: string): string {
  const model = parseNativeModelSelection(value).model;
  const prefix = `${piProviderId(profile)}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

/** Catalog lookup never launches pi; output limits are collected separately from the public model DTO. */
export async function piProviderModels(profile: NativeBackendProfileConfig, outputLimits?: Map<string, number>): Promise<ModelInfo[]> {
  const endpoint = piCustomEndpoint(profile);
  if (!endpoint) return [];
  const api = piApiProtocol(profile);
  const key = typeof profile.config.apiKey === 'string' ? profile.config.apiKey : undefined;
  let models: ModelInfo[];
  try {
    models = await fetchGatewayModels({
      baseUrl: endpoint,
      ...(key ? { apiKey: key } : {}),
      protocol: api,
      select: entry => {
        const id = modelIdOf(entry);
        const runtime = entry.runtime && typeof entry.runtime === 'object' && !Array.isArray(entry.runtime) ? entry.runtime as Record<string, unknown> : undefined;
        const limit = [runtime?.max_output_tokens, entry.max_output_tokens, entry.max_tokens, entry.maxTokens, entry.outputTokenLimit]
          .find((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
        if (id && limit !== undefined) outputLimits?.set(api === 'google-generative-ai' ? id.replace(/^models\//, '') : id, limit);
        return true;
      },
      reasoningLevels: true,
    });
  } catch (error) {
    // An explicitly configured model still works when its service implements inference only.
    const configured = Array.isArray(profile.config.enabledModels) ? profile.config.enabledModels : [];
    if (!configured.length && !profile.config.defaultModel) throw error;
    models = [];
  }
  const configured = [
    ...(Array.isArray(profile.config.enabledModels) ? profile.config.enabledModels : []),
    ...(typeof profile.config.defaultModel === 'string' && profile.config.defaultModel ? [profile.config.defaultModel] : []),
  ];
  for (const value of configured) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const id = piCustomModelId(profile, value);
    if (!models.some(model => model.value === id)) models.push({ value: id, name: id, configOptions: [] });
  }
  return models.map(model => {
    const windows = profile.config.modelContextWindows as Record<string, number> | undefined;
    // Some compatible directories omit reasoning metadata. This model's adaptive Anthropic
    // low/high/off requests were verified against OpenDesign; declared ladders remain authoritative.
    const effort = !model.configOptions.some(option => option.id === 'effort') &&
      api === 'anthropic-messages' && model.value === 'deepseek-v4.1-flash'
      ? effortOption(['off', 'low', 'medium', 'high'], 'off') : undefined;
    return { ...model, ...(effort ? { configOptions: [...model.configOptions, effort] } : {}), ...(windows?.[model.value] ? { contextWindow: windows[model.value] } : {}) };
  });
}

/** Pi's official registerProvider API overlays one private provider in this process only. */
export async function piProviderExtension(profile: NativeBackendProfileConfig, stateDir: string): Promise<{ path: string; env: NodeJS.ProcessEnv } | undefined> {
  const endpoint = piCustomEndpoint(profile);
  if (!endpoint) return undefined;
  const api = piApiProtocol(profile);
  const outputLimits = new Map<string, number>();
  const models = await piProviderModels(profile, outputLimits);
  if (!models.length) throw new AppError('INVALID_MODEL', 'Choose at least one model for this pi provider.', 400);
  const inputs = profile.config.modelInputModalities as Record<string, Array<'text' | 'image'>> | undefined;
  const definition = {
    name: profile.name,
    api,
    baseUrl: api === 'anthropic-messages' ? gatewayRootUrl(endpoint) : api === 'google-generative-ai' ? googleBaseUrl(endpoint) : gatewayBaseUrl(endpoint),
    apiKey: '$RIFFET_PI_PROVIDER_KEY',
    models: models.map(model => {
      const levels = model.configOptions.find(option => option.id === 'effort')?.options.map(option => option.value);
      const contextWindow = model.contextWindow ?? 128000;
      return {
        id: model.value, name: model.name, input: inputs?.[model.value] ?? ['text'],
        reasoning: Boolean(levels?.some(level => level !== 'off')),
        // A declared effort ladder maps to the API's output_config.effort, rather than a token budget.
        ...(api === 'anthropic-messages' && levels ? { compat: { forceAdaptiveThinking: true } } : {}),
        ...(levels ? { thinkingLevelMap: Object.fromEntries(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => [level, levels.includes(level) ? level : null])) } : {}),
        contextWindow, maxTokens: Math.min(16384, contextWindow, outputLimits.get(model.value) ?? Infinity),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    }),
  };
  const source = `// Generated by Riffet. Credentials are supplied only to this pi child.\nexport default function(pi) { pi.registerProvider(${JSON.stringify(piProviderId(profile))}, ${JSON.stringify(definition)}); }\n`;
  const directory = join(stateDir, 'pi');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `provider-${createHash('sha256').update(source).digest('hex').slice(0, 24)}.ts`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, source, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  // A dummy key permits unauthenticated local endpoints, which ignore it.
  return { path, env: { RIFFET_PI_PROVIDER_KEY: typeof profile.config.apiKey === 'string' && profile.config.apiKey ? profile.config.apiKey : 'riffet-local' } };
}

/**
 * The conversation's Riffet MCP server (docs/DEVICES.md §2) through pi's `registerMcpServer`, which
 * holds it for this process only and never writes `mcp.json`. The source names only the shim and
 * its credential file, so it is keyed by content like the provider extension.
 */
export async function piRiffetMcpExtension(server: { name: string; command: string; args: string[] }, stateDir: string): Promise<string> {
  const source = `// Generated by Riffet: this conversation's Riffet tools.\nexport default function(pi) { pi.registerMcpServer(${JSON.stringify(server.name)}, ${JSON.stringify({ type: 'stdio', command: server.command, args: server.args })}); }\n`;
  const directory = join(stateDir, 'pi');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `riffet-mcp-${createHash('sha256').update(source).digest('hex').slice(0, 24)}.ts`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, source, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return path;
}
