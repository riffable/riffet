import { mkdir } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { parseSelection, type ModelConfigOption, type ModelInfo } from '@contracts';
import type { AgentHost, AgentModelQuery, AgentProfile } from '@riffet/plugin-api/experimental/agent';
import { runProcess } from '@riffet/plugin-api/kit';
import { AGY_EFFORTS, agyLaunchConfig, agyProfileEnvironment, parseAgyProfile, type AgyProfile, type AgySelection } from './config.js';
import type { Hub } from './runtime.js';

/** One row of `agy models`: the id `--model` takes and the label agy shows, which is also what its status line reports. */
export interface AgyModel {
  value: string;
  name: string;
}

/**
 * agy names a built-in model's effort in its id (`gemini-3.8-flash-high`) and also takes the family with `--effort`.
 * A model registered through `customModelsConfig` (a gateway's own id) takes `--effort` only up to `high`.
 */
const EFFORT_SUFFIX = new RegExp(`^(.+)-(${AGY_EFFORTS.join('|')})$`);
const EFFORT_LABEL = /\s*\((?:Low|Medium|High|XHigh|Max)\)$/i;
const EFFORT_NAMES: Record<string, string> = { default: 'Default', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'xhigh', max: 'Max' };
const CUSTOM_EFFORTS = ['low', 'medium', 'high'];
/** A signed-in account's list can change; the API-key list only with the binary, which an update replaces in place. */
const CATALOG_FRESH_MS = 5 * 60_000;
const CATALOG_TIMEOUT_MS = 20_000;
const CATALOG_OUTPUT_BYTES = 256 * 1024;
const MANAGED_ENV = ['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'AGY_CLI_DISABLE_AUTO_UPDATE'];

export function parseAgyModels(stdout: string): AgyModel[] {
  return stdout.split('\n').flatMap(line => {
    const [value, name] = line.split('\t').map(part => part.trim());
    return value && name && /^[\w.:-]+$/.test(value) ? [{ value, name }] : [];
  });
}

async function readNativeModels(hub: Hub, profile: AgyProfile): Promise<AgyModel[]> {
  // A private directory: listing must not write into the reader's own agy state, and needs none of it.
  const dir = join(hub.stateDir, 'catalog');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const { env, secretEnv } = agyProfileEnvironment(profile);
  const inherited = { ...process.env };
  for (const name of MANAGED_ENV) delete inherited[name];
  const result = await runProcess(
    profile.executable,
    [`--gemini_dir=${dir}`, '--settings', JSON.stringify(profile.hasApiKey ? { modelProvider: 'gemini' } : {}), '--log-file', devNull, 'models'],
    { cwd: dir, env: { ...inherited, ...env, ...secretEnv }, timeoutMs: CATALOG_TIMEOUT_MS, maxOutputBytes: CATALOG_OUTPUT_BYTES },
  );
  return result.code === 0 ? parseAgyModels(result.stdout) : [];
}

/** The models this agy knows by itself for the profile's sign-in, without the ones Riffet registers per launch. */
export function nativeModels(hub: Hub, profile: AgyProfile): Promise<AgyModel[]> {
  const key = `${profile.hasApiKey ? 'key' : 'login'}\0${profile.executable}`;
  const cached = hub.catalogs.get(key);
  if (cached && Date.now() - cached.at < CATALOG_FRESH_MS) return cached.models;
  const models = readNativeModels(hub, profile).catch(() => []);
  hub.catalogs.set(key, { at: Date.now(), models });
  // An empty answer is a failed read (no sign-in, a broken binary): the next caller tries again.
  void models.then(value => {
    if (!value.length && hub.catalogs.get(key)?.models === models) hub.catalogs.delete(key);
  });
  return models;
}

export async function launchProfile(host: AgentHost, profile: AgentProfile): Promise<AgyProfile> {
  return parseAgyProfile(await agyLaunchConfig(host, profile));
}

function effortOption(currentValue: string, values: string[]): ModelConfigOption {
  return {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    type: 'select',
    currentValue,
    options: values.map(value => ({ value, name: EFFORT_NAMES[value] ?? value })),
  };
}

const familyOf = (value: string) => EFFORT_SUFFIX.exec(value)?.[1];

/** Built-in variants of one model fold into one entry with an effort control; the picker keeps the exact variant id. */
export function agyCatalog(native: AgyModel[]): ModelInfo[] {
  const families = new Map<string, AgyModel[]>();
  for (const model of native) {
    const base = familyOf(model.value) ?? model.value;
    families.set(base, [...(families.get(base) ?? []), model]);
  }
  return [...families].flatMap(([base, members]): ModelInfo[] => {
    const efforts = members.map(member => EFFORT_SUFFIX.exec(member.value)?.[2]);
    if (members.length < 2 || efforts.some(effort => !effort))
      return members.map(({ value, name }) => ({ value, name, configOptions: [] }));
    const ordered = AGY_EFFORTS.filter(effort => efforts.includes(effort));
    return [
      {
        value: base,
        name: members[0]!.name.replace(EFFORT_LABEL, ''),
        configOptions: [effortOption(ordered.includes('medium') ? 'medium' : ordered[0]!, ordered)],
        nativeVariants: members.map(({ value, name }) => ({ value, name })),
        aliases: members.map(member => member.value),
      },
    ];
  });
}

/** A model id agy does not know by itself, which a Gemini API gateway serves under its own name. */
function customEntry(value: string, apiKey: boolean): ModelInfo {
  return { value, name: value, configOptions: apiKey ? [effortOption('default', ['default', ...CUSTOM_EFFORTS])] : [] };
}

/**
 * The models a profile offers. With its own API endpoint or a model source, that is what the host reads for the Gemini
 * protocol: agy's built-in list names models a gateway may not have, and agy asks the endpoint for them under its own
 * names. An id there that is one of agy's model families keeps agy's effort variants. Without either (a sign-in, or
 * Google's own API) the list is agy's; one whose endpoint cannot be read lists none. Ids saved on the profile or the
 * session that the list does not name stay usable.
 */
export async function listModels(hub: Hub, host: AgentHost, query: AgentModelQuery): Promise<ModelInfo[]> {
  const profile = await launchProfile(host, query.profile).catch(() => undefined);
  const native = profile ? await nativeModels(hub, profile) : [];
  const apiKey = Boolean(profile?.hasApiKey);
  const catalog = agyCatalog(native);
  const entryOf = (id: string, name = id) => catalog.find(entry => entry.value === id || entry.aliases?.includes(id)) ?? { ...customEntry(id, apiKey), name };
  const config = query.profile.config;
  // A profile with its own endpoint never falls back to agy's list: those are not models that endpoint is known to serve.
  const own = Boolean(config.modelSource || config.apiEndpoint);
  const served = await host.modelSources.models(query.profile.id, 'google-generative-ai').catch(() => undefined);
  const listed = served ? served.map(model => entryOf(model.value, model.name)) : own ? [] : catalog;
  const saved = [...(Array.isArray(config.enabledModels) ? config.enabledModels : []), query.session?.model, config.defaultModel].flatMap(value =>
    typeof value === 'string' && value.trim() ? [parseSelection(value).model] : [],
  );
  const extra = [...new Set(saved)].filter(id => !listed.some(entry => entry.value === id || entry.aliases?.includes(id)));
  const added = new Map(extra.map(id => entryOf(id)).map(entry => [entry.value, entry]));
  return [...listed, ...added.values()];
}

export interface AgyLaunchModel {
  /** `--model`. */
  model?: string;
  /** `--effort`, only where agy takes it next to that model. */
  effort?: string;
  /** Registered for this launch in `customModelsConfig`, so agy sends the id to the gateway as it is. */
  custom?: string;
  /** Labels agy may report for the model it was asked for; anything else means it chose another. */
  labels: string[];
}

/**
 * How a selection reaches agy. A built-in id goes as it is, a family with an effort becomes that variant, and an id
 * agy does not know is registered as a custom model when a Gemini API key is in use: `--model` alone would fall
 * back to agy's default model without a word.
 */
export function agyLaunchModel(selection: AgySelection | undefined, native: AgyModel[], profile: Pick<AgyProfile, 'hasApiKey'>): AgyLaunchModel {
  if (!selection) return { labels: [] };
  const { model, effort } = selection;
  // Without agy's list there is nothing to decide on: the id goes alone (agy refuses an effort it cannot place next to
  // it), agy reports what it picked and the session follows that.
  if (!native.length) return { model, labels: [] };
  const exact = native.find(item => item.value === model);
  const base = exact ? familyOf(exact.value) ?? exact.value : model;
  const family = native.filter(item => familyOf(item.value) === base);
  if (exact || family.length) {
    // A variant id carries its effort, and agy refuses `--effort` beside it.
    const chosen = (effort && family.find(item => item.value === `${base}-${effort}`)) || exact;
    return chosen ? { model: chosen.value, labels: [chosen.name] } : { model, labels: family.map(item => item.name) };
  }
  // Custom models need a Gemini API key; with a sign-in agy falls back, which the session then reports.
  if (!profile.hasApiKey) return { model, labels: [model] };
  return { model, ...(effort && CUSTOM_EFFORTS.includes(effort) ? { effort } : {}), custom: model, labels: [model] };
}
