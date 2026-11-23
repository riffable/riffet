import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModelConfigOption, ModelInfo, NativeSlashItem } from '../../../../../packages/contracts/src/index.js';
import { parseVersion, versionAtLeast } from '../shared/cli-version.js';
import { isCliMissing, resolveCliExecutable, shellFunctionInvocation } from '../shared/cli-resolve.js';
import { scanCommandRoots, scanSkillRoots } from '../shared/skill-files.js';
import type { NativeBackendAvailability, NativeBackendProfileConfig } from '../types.js';
import { piAgentDir } from './history.js';
import { expandHome } from '../../environment.js';
import { piCustomEndpoint, piProviderModels } from './provider.js';

/*
 * Discovery that must never start a conversation (docs/PI.md §2): the installed CLI is checked with
 * `--version`/`--help`, and models, skills and commands are read from pi's own files. A live RPC
 * process may answer with more current data, but nothing here waits for one.
 */

const MODEL_CACHE_MS = 10 * 60_000;
/** Levels pi always knows; a `thinkingLevelMap` may hide some with `null` and add xhigh/max. */
const BASE_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];
const EXTENDED_THINKING_LEVELS = ['xhigh', 'max'];

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The agent directory a profile reads: its configured one, else pi's own default. */
export function piProfileAgentDir(profile: NativeBackendProfileConfig): string {
  return expandHome(str(profile.config.configDir) ?? piAgentDir());
}

/** The launch a profile resolves to, shared by the probe and the runtime. */
export function piLaunchCommand(profile: NativeBackendProfileConfig): { command: string; args: string[]; configured: string } {
  const configured = str(profile.config.executable) ?? 'pi';
  const resolution = resolveCliExecutable({ command: configured });
  if (resolution.source === 'shell-function') {
    const invocation = shellFunctionInvocation(configured.slice('shell:'.length), []);
    return { ...invocation, configured };
  }
  return { command: resolution.executable, args: [], configured };
}

export function piEnvironment(profile: NativeBackendProfileConfig): NodeJS.ProcessEnv {
  const agentDir = str(profile.config.configDir) ? piProfileAgentDir(profile) : undefined;
  return { ...process.env, ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}) };
}

async function readJson(path: string): Promise<RecordValue | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return record(value);
  } catch {
    return undefined;
  }
}

export interface PiSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
}

/** The default model pi would start with, as `provider/modelId`. */
export async function readPiSettings(profile: NativeBackendProfileConfig): Promise<PiSettings> {
  const settings = await readJson(join(piProfileAgentDir(profile), 'settings.json')) ?? {};
  return {
    ...(str(settings.defaultProvider) ? { defaultProvider: str(settings.defaultProvider) } : {}),
    ...(str(settings.defaultModel) ? { defaultModel: str(settings.defaultModel) } : {}),
    ...(str(settings.defaultThinkingLevel) ? { defaultThinkingLevel: str(settings.defaultThinkingLevel) } : {}),
  };
}

/** The model a session starts with: the profile's own choice, else pi's saved default. */
export async function piDefaultModel(profile: NativeBackendProfileConfig): Promise<string | undefined> {
  const configured = str(profile.config.defaultModel);
  if (configured) return configured;
  if (piCustomEndpoint(profile)) return (await listPiModels(profile))[0]?.value;
  const settings = await readPiSettings(profile);
  const model = settings.defaultModel;
  if (!model) return undefined;
  return model.includes('/') || !settings.defaultProvider ? model : `${settings.defaultProvider}/${model}`;
}

function thinkingOptions(model: RecordValue, fallback: string | undefined): ModelConfigOption | undefined {
  const map = record(model.thinkingLevelMap);
  // pi-ai getSupportedThinkingLevels: non-reasoning models only accept off; base levels are
  // enabled by default for reasoning models, while xhigh/max require an explicit mapping.
  if (model.reasoning !== true) return undefined;
  const unsupported = new Set(BASE_THINKING_LEVELS.filter(level => map?.[level] === null));
  const mapped = EXTENDED_THINKING_LEVELS.filter(level => map?.[level] !== undefined && map[level] !== null);
  const levels = [...BASE_THINKING_LEVELS.filter(level => !unsupported.has(level)), ...mapped];
  if (!levels.length) return undefined;
  const options = [...new Set(levels)];
  const current = fallback && options.includes(fallback) ? fallback : options[0]!;
  return {
    id: 'effort',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: current,
    options: options.map(level => ({ value: level, name: level[0]!.toUpperCase() + level.slice(1) })),
  };
}

/** pi's model objects, from `models-store.json` or a live `get_available_models`. */
export function piModelInfos(models: unknown[], defaultThinkingLevel?: string): ModelInfo[] {
  const items: ModelInfo[] = [];
  for (const value of models) {
    const model = record(value);
    const id = str(model?.id) ?? str(model?.modelId);
    if (!model || !id) continue;
    // models-store also holds image/classifier catalogs; pi's agent uses chat models only.
    if (model.type !== undefined && model.type !== 'chat') continue;
    const provider = str(model.provider);
    const effort = thinkingOptions(model, defaultThinkingLevel);
    const contextWindow = finite(model.contextWindow);
    items.push({
      value: provider ? `${provider}/${id}` : id,
      name: str(model.name) ?? id,
      configOptions: effort ? [effort] : [],
      ...(contextWindow ? { contextWindow } : {}),
    });
  }
  return items;
}

const modelCache = new Map<string, { at: number; models: ModelInfo[] }>();

/** A stable cache key: another executable or agent directory is another catalog. */
export function piProfileKey(profile: NativeBackendProfileConfig): string {
  return createHash('sha256').update(JSON.stringify([
    profile.id, profile.config,
  ])).digest('hex');
}

/** A live process's answer replaces the file read, so the picker matches what pi will accept. */
export function rememberPiModels(profile: NativeBackendProfileConfig, models: ModelInfo[]): void {
  if (!models.length) return;
  modelCache.set(piProfileKey(profile), { at: Date.now(), models });
}

export function invalidatePiModels(): void {
  modelCache.clear();
}

/**
 * pi's catalog files: `models-store.json` caches provider catalogs (`{provider:{models:[...]}}`),
 * and `models.json` adds or overrides providers and models the user configured. A custom provider
 * pi would run must appear in the picker even when no catalog has been cached for it.
 */
async function catalogModels(agentDir: string): Promise<unknown[]> {
  const [store, custom] = await Promise.all([
    readJson(join(agentDir, 'models-store.json')),
    readJson(join(agentDir, 'models.json')),
  ]);
  const byProvider = new Map<string, Map<string, RecordValue>>();
  const collect = (providerId: string, values: unknown[], defaults: RecordValue) => {
    const models = byProvider.get(providerId) ?? new Map<string, RecordValue>();
    byProvider.set(providerId, models);
    for (const value of values) {
      const model = record(value);
      const id = str(model?.id) ?? str(model?.modelId);
      if (!model || !id) continue;
      models.set(id, { ...defaults, ...model, provider: str(model.provider) ?? providerId, id });
    }
  };
  for (const [providerId, value] of Object.entries(store ?? {})) {
    const provider = record(value);
    if (Array.isArray(provider?.models)) collect(providerId, provider.models, {});
  }
  const providers = record(custom?.providers);
  for (const [providerId, value] of Object.entries(providers ?? {})) {
    const provider = record(value);
    if (!provider) continue;
    const defaults = {
      ...(str(provider.name) ? { providerName: str(provider.name) } : {}),
      ...(str(provider.api) ? { api: str(provider.api) } : {}),
      ...(str(provider.baseUrl) ? { baseUrl: str(provider.baseUrl) } : {}),
    };
    if (Array.isArray(provider.models)) collect(providerId, provider.models, defaults);
    const overrides = record(provider.modelOverrides);
    const models = byProvider.get(providerId);
    if (overrides && models) {
      for (const [id, value] of Object.entries(overrides)) {
        const override = record(value);
        const model = models.get(id);
        if (override && model) models.set(id, { ...model, ...override });
      }
    }
  }
  return [...byProvider.values()].flatMap(models => [...models.values()]);
}
/**
 * Models pi has configured. Catalogs come from pi's cache plus custom providers; a machine that has
 * not listed models yet still yields the saved default, so the picker is never empty when pi itself
 * would run.
 */
export async function listPiModels(profile: NativeBackendProfileConfig, live?: ModelInfo[]): Promise<ModelInfo[]> {
  if (live?.length) {
    rememberPiModels(profile, live);
    return live;
  }
  const key = piProfileKey(profile);
  const cached = modelCache.get(key);
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return cached.models;
  if (piCustomEndpoint(profile)) {
    const infos = await piProviderModels(profile);
    modelCache.set(key, { at: Date.now(), models: infos });
    return infos;
  }
  const settings = await readPiSettings(profile);
  const models = await catalogModels(piProfileAgentDir(profile));
  let infos = piModelInfos(models, settings.defaultThinkingLevel);
  const enabled = Array.isArray(profile.config.enabledModels) ? profile.config.enabledModels.filter((item): item is string => typeof item === 'string') : undefined;
  if (enabled?.length) infos = infos.filter(model => enabled.includes(model.value));
  if (!infos.length) {
    const fallback = await piDefaultModel(profile);
    if (fallback) infos = [{ value: fallback, name: fallback, configOptions: [] }];
  }
  modelCache.set(key, { at: Date.now(), models: infos });
  return infos;
}

/** What pi would accept for one model value, from the catalog both paths share. */
export function piThinkingLevels(model: ModelInfo | undefined): string[] {
  const option = model?.configOptions.find(item => item.id === 'effort');
  return option ? option.options.map(item => item.value) : [];
}

/**
 * Skills and prompt templates pi discovers for this project. The user roots come after the project
 * roots, so a project resource of the same name wins. pi addresses a skill as `/skill:name`.
 */
export async function listPiSlashItems(profile: NativeBackendProfileConfig, cwd: string | undefined): Promise<NativeSlashItem[]> {
  const agent = piProfileAgentDir(profile);
  const [skills, commands] = await Promise.all([
    scanSkillRoots([...(cwd ? [join(cwd, '.pi', 'skills')] : []), join(agent, 'skills')]),
    scanCommandRoots([...(cwd ? [join(cwd, '.pi', 'prompts')] : []), join(agent, 'prompts')]),
  ]);
  return [
    ...commands,
    ...skills.map(item => ({ ...item, kind: 'command' as const, name: `skill:${item.name}` })),
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first pi whose RPC mode carries the commands this backend relies on. */
export const PI_MINIMUM_VERSION = '1.4.0';

/**
 * Whether pi can serve this profile, without starting a session or loading MCP. `--help` must name
 * RPC mode and the version must be one this backend was written against; an older CLI is refused
 * rather than reported as merely untested.
 */
export async function probePiCli(profile: NativeBackendProfileConfig): Promise<NativeBackendAvailability> {
  const launch = piLaunchCommand(profile);
  const { spawn } = await import('node:child_process');
  const run = (args: string[]) => new Promise<string>((resolvePromise, reject) => {
    const child = spawn(launch.command, [...launch.args, ...args], { env: piEnvironment(profile), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timed out')); }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => { if (output.length < 256 * 1024) output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { if (output.length < 256 * 1024) output += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); resolvePromise(output); });
  });
  try {
    const version = await run(['--version']);
    const help = await run(['--help']);
    if (!/--mode\b/.test(help) || !/\brpc\b/.test(help)) {
      return { available: false, reason: `“${launch.configured}” does not support \`pi --mode rpc\`; update pi.`, version: parseVersion(version)?.text };
    }
    const found = parseVersion(version);
    if (!versionAtLeast(found, PI_MINIMUM_VERSION)) {
      return {
        available: false,
        reason: `pi ${found?.text ?? 'version unknown'} is older than ${PI_MINIMUM_VERSION}; update pi.`,
        ...(found ? { version: found.text } : {}),
      };
    }
    return { available: true, version: found?.text };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const cliMissing = isCliMissing(resolveCliExecutable({ command: launch.configured }));
      return { available: false, ...(cliMissing ? { cliMissing: true } : {}), reason: `Cannot find “${launch.configured}”. Install pi or set this profile's executable to its absolute path.` };
    }
    return { available: false, reason: `Could not start pi at “${launch.command}” (${errorMessage(error)}).` };
  }
}
