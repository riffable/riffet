import type { ModelConfigOption, ModelInfo } from '@contracts';
import { AppError } from '@riffet/plugin-api/kit';
import { baseValues, launchableValues, parameterizedModelFor, variantWith, type CursorParameterizedModel } from './model-parameters.js';

export interface NativeModelEntry { value: string; name: string; }

interface NativeVariantSlots { effort: string; thinking: boolean; fast: boolean; }

// Keep this suffix parser aligned with the native picker: model families encode supported
// dimensions in their ids, e.g. gpt-5.6-luna-low and gpt-5.6-luna-low-fast.
const DIMENSIONS = ['extra-high', 'xhigh', 'minimal', 'none', 'medium', 'low', 'high', 'max', 'thinking', 'fast'];

function familyOf(rawId: string): { id: string; fast: boolean; slots: NativeVariantSlots; suffixes: string[] } {
  let id = rawId.trim().split('[', 1)[0] ?? '';
  const slots: NativeVariantSlots = { effort: '', thinking: false, fast: false };
  const suffixes: string[] = [];
  for (;;) {
    const token = DIMENSIONS.find((candidate) => id.length > candidate.length + 1 && id.endsWith(`-${candidate}`));
    if (!token) break;
    id = id.slice(0, -(token.length + 1));
    suffixes.push(token);
    if (token === 'fast') slots.fast = true;
    else if (token === 'thinking') slots.thinking = true;
    else slots.effort = token;
  }
  return { id, fast: slots.fast, slots, suffixes };
}

function nativeFamilies(entries: NativeModelEntry[]): Map<string, { hasFast: boolean }> {
  const families = new Map<string, { hasFast: boolean }>();
  for (const entry of entries) {
    const { id, fast } = familyOf(entry.value);
    const family = families.get(id) ?? { hasFast: false };
    family.hasFast ||= fast;
    families.set(id, family);
  }
  return families;
}

const EFFORT_LABELS: Record<string, string> = {
  default: 'Default', none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High',
  xhigh: 'xhigh', 'extra-high': 'xhigh', max: 'Max',
};

/**
 * The context window is not a suffix of any flat id: Cursor defines it per model, with its own values
 * (`300k` / `1m` for Gemini, `272k` / `1m` for GPT, `256k` for Grok), and only some models have it.
 * It is offered only from those definitions; without them (an older CLI, an API the tap could not
 * read) there is no Context choice rather than a guessed one the CLI would refuse.
 */
function contextOption(model: CursorParameterizedModel | undefined, flatDefault: string): ModelConfigOption | undefined {
  if (!model) return undefined;
  const values = launchableValues(model, 'context');
  if (values.length < 2) return undefined;
  const current = baseValues(model, flatDefault)?.context;
  return {
    id: 'context',
    name: model.parameters.find((item) => item.id === 'context')?.name || 'Context',
    category: 'model_config',
    type: 'select',
    currentValue: current && values.some((item) => item.value === current) ? current : values[0]!.value,
    options: values.map(({ value, name }) => ({ value, name })),
  };
}

function familyLabel(names: string[]): string {
  const usable = names.map((name) => name.trim()).filter(Boolean);
  if (!usable.length) return '';
  let prefix = usable[0]!;
  for (const name of usable.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < name.length && prefix[index] === name[index]) index += 1;
    prefix = prefix.slice(0, index);
  }
  const label = prefix.replace(/[\s·:,-]+$/, '').replace(/\s*\((?:default|current)\)$/i, '').trim();
  return label || usable[0]!;
}

const DISPLAY_DIMENSIONS: Record<string, string[]> = {
  'extra-high': ['extra high', 'very high', 'xhigh', 'extra-high'], xhigh: ['xhigh', 'extra high', 'very high'],
  minimal: ['minimal'], none: ['none'], medium: ['medium'], low: ['low'], high: ['high'], max: ['max'],
  thinking: ['thinking'], fast: ['fast'],
};

function familyDisplayName(entry: NativeModelEntry): string {
  let name = entry.name.trim();
  for (const suffix of familyOf(entry.value).suffixes) {
    for (const label of DISPLAY_DIMENSIONS[suffix] ?? [suffix]) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const ending = new RegExp(`(?:\\s+|-|·)${escaped}$`, 'i');
      if (ending.test(name)) { name = name.replace(ending, '').trim(); break; }
    }
  }
  // The CLI's display names (`cursor-agent models`) hard-code the family's current context
  // window — e.g. "Claude Opus 5.5 1M High", "GPT-5.6 Sol 1M". We expose context as its own
  // picker (300K / 1M / MAX), so strip the token from the model label to avoid showing a
  // frozen "1M" next to the family name when the user may be running on 300K or MAX.
  name = name.replace(/(?:\s+|·)(?:300k|1m|max)\b/gi, '').replace(/\s{2,}/g, ' ').trim();
  return name.replace(/[\s·:,-]+$/, '').replace(/\s*\((?:default|current)\)$/i, '').trim() || entry.name.trim();
}

function option(id: string, name: string, category: string, currentValue: string, values: string[]): ModelConfigOption {
  return {
    id,
    name,
    category,
    type: 'select',
    currentValue,
    options: values.map((value) => ({ value, name: id === 'effort' ? EFFORT_LABELS[value] ?? value : value === 'true' ? 'On' : 'Off' })),
  };
}

/**
 * Builds the model catalog from the exact variants the CLI lists. Every exposed option comes
 * from an observed suffix, and the exact variant table lets the web picker resolve only
 * combinations the CLI actually listed.
 */
export function nativeModelCatalogFromVariants(nativeEntries: NativeModelEntry[], parameterized: readonly CursorParameterizedModel[] = []): ModelInfo[] {
  if (!nativeEntries.length) throw new AppError('MODEL_CATALOG_UNAVAILABLE', 'The CLI model catalog is unavailable; try again shortly', 503);

  const families = new Map<string, NativeModelEntry[]>();
  for (const entry of nativeEntries) {
    const { id } = familyOf(entry.value);
    const variants = families.get(id) ?? [];
    if (!variants.some((item) => item.value === entry.value)) variants.push(entry);
    families.set(id, variants);
  }

  return [...families].map(([id, variants]) => {
    const members = variants.map((entry) => ({ entry, slots: familyOf(entry.value).slots }));
    const bare = members.find((item) => !item.slots.effort && !item.slots.thinking && !item.slots.fast);
    const label = familyLabel(variants.map(familyDisplayName));
    const named = members.find((item) => familyDisplayName(item.entry) === label);
    const selected = bare ?? named ?? members[0]!;
    const configOptions: ModelConfigOption[] = [];

    const efforts = [...new Set(members.map(({ slots }) => slots.effort || 'default'))];
    if (efforts.length > 1) {
      const order = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'extra-high', 'max'];
      efforts.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      configOptions.push(option('effort', 'Effort', 'thought_level', selected.slots.effort || 'default', efforts));
    }

    const thinkingValues = [...new Set(members.map(({ slots }) => String(slots.thinking)))].sort();
    if (thinkingValues.length > 1) configOptions.push(option('thinking', 'Thinking', 'model_config', String(selected.slots.thinking), thinkingValues));

    const fastValues = [...new Set(members.map(({ slots }) => String(slots.fast)))].sort();
    if (fastValues.length > 1) configOptions.push(option('fast', 'Fast', 'model_config', String(selected.slots.fast), fastValues));

    const context = contextOption(parameterizedModelFor(parameterized, id, variants.map((item) => item.value)), selected.entry.value);
    if (context) configOptions.push(context);

    return {
      value: id,
      name: label || id,
      configOptions,
      nativeVariants: variants.map(({ value, name }) => ({ value, name })),
    };
  });
}

interface BracketParam {
  key: string;
  value: string;
  normalized: string;
}

function parseBracketParams(raw: string | undefined): BracketParam[] {
  return (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq < 0) return { key: part, value: '', normalized: part };
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      return { key, value, normalized: `${key}=${value}` };
    });
}

/** Refuses unavailable families while leaving parameterized variants to the native CLI. */
export function assertNativeModelSelection(model: string, nativeEntries: NativeModelEntry[]): void {
  if (!nativeEntries.length) throw new AppError('MODEL_CATALOG_UNAVAILABLE', 'Could not confirm the models this native CLI supports; check the CLI model list and try again', 503);

  const match = /^([^\[\]]+)(?:\[([^\]]*)\])?$/.exec(model.trim());
  if (!match) return;
  const { id: familyId, fast: fastSuffix } = familyOf(match[1]!);
  const family = nativeFamilies(nativeEntries).get(familyId);
  if (!family) {
    throw new AppError('INVALID_NATIVE_MODEL', `The native CLI catalog has no model "${model.trim()}"; choose another model`, 400, undefined, { reason: 'model', model: model.trim() });
  }
  if (family.hasFast) return;

  const fastParam = parseBracketParams(match[2]).find((param) => param.key === 'fast');
  const fast = fastParam ? fastParam.value === 'true' : fastSuffix;
  if (fast) throw new AppError('INVALID_NATIVE_MODEL', 'The native CLI does not support Fast for this model; turn Fast off and try again', 400, undefined, { reason: 'fast' });
}

function findMatchingFlatVariant(rawBase: string, variants: readonly NativeModelEntry[], params: readonly BracketParam[]): string | undefined {
  if (!variants.length) return undefined;
  const members = variants.map((entry) => ({ entry, slots: familyOf(entry.value).slots }));
  const bare = members.find((item) => !item.slots.effort && !item.slots.thinking && !item.slots.fast);
  const label = familyLabel(variants.map(familyDisplayName));
  const named = members.find((item) => familyDisplayName(item.entry) === label);
  const defaultSlots = (bare ?? named ?? members[0]!).slots;

  const baseSlots = familyOf(rawBase).slots;
  const hasBaseSuffix = Boolean(baseSlots.effort || baseSlots.thinking || baseSlots.fast);
  const paramMap = new Map(params.map((param) => [param.key, param.value]));
  const rawEffort = paramMap.get('effort') ?? paramMap.get('reasoning_effort') ?? paramMap.get('reasoning');
  const effort = rawEffort === 'default' ? '' : rawEffort ?? baseSlots.effort;
  const thinking = paramMap.has('thinking') ? paramMap.get('thinking') === 'true' : (hasBaseSuffix ? baseSlots.thinking : defaultSlots.thinking);
  const fast = paramMap.has('fast') ? paramMap.get('fast') === 'true' : (hasBaseSuffix ? baseSlots.fast : defaultSlots.fast);

  const exact = members.find(({ slots }) => slots.effort === effort && slots.thinking === thinking && slots.fast === fast);
  if (exact) return exact.entry.value;

  // Families without a bare variant (only e.g. `-medium` / `-high`) still emit `effort=default`
  // or omit `effort` when `context` was copied across models; fall back to the family's default
  // variant (`named ?? first`) matching `nativeModelCatalogFromVariants`.
  if (!effort) {
    const candidates = members.filter(({ slots }) => slots.thinking === thinking && slots.fast === fast);
    if (candidates.length) {
      return (candidates.find(({ entry }) => familyDisplayName(entry) === label) ?? candidates[0])!.entry.value;
    }
    if (!paramMap.has('thinking') && !paramMap.has('fast')) {
      return (bare ?? named ?? members[0])!.entry.value;
    }
  }
  return undefined;
}

/**
 * What `--model` is given for a selection. Cursor accepts a flat id it lists, or exactly the
 * `variant_string_representation` of one parameterized variant (its parameter ids and order), so a
 * context choice is resolved to that string from the model's own variants. A context value the model
 * no longer offers is dropped, so a selection saved before the catalog changed still resumes.
 */
export function normalizeNativeModelSelection(model: string, nativeEntries: NativeModelEntry[], parameterized: readonly CursorParameterizedModel[] = []): string {
  const value = model.trim();
  const match = /^([^\[\]]+)(?:\[([^\]]*)\])?$/.exec(value);
  assertNativeModelSelection(value, nativeEntries);
  if (nativeEntries.some((entry) => entry.value === value)) return model;
  if (parameterized.some((item) => item.variants.some((variant) => variant.selector === value))) return model;
  if (!match) return model;

  const familyId = familyOf(match[1]!).id;
  const family = nativeFamilies(nativeEntries).get(familyId);
  const familyVariants = nativeEntries.filter((entry) => familyOf(entry.value).id === familyId);
  const rawParams = parseBracketParams(match[2]);
  const context = rawParams.find((param) => param.key === 'context')?.value;
  const params = rawParams.filter((param) => param.key !== 'context');
  const flat = findMatchingFlatVariant(match[1]!, familyVariants, params);

  const described = context ? parameterizedModelFor(parameterized, familyId, familyVariants.map((entry) => entry.value)) : undefined;
  if (described && context && launchableValues(described, 'context').some((item) => item.value === context)) {
    const values = baseValues(described, flat);
    const variant = values && variantWith(described, { ...values, context });
    if (!variant) {
      throw new AppError('INVALID_NATIVE_MODEL', 'This model does not offer that context window with these settings; choose another context window', 400, undefined, { reason: 'context', model: value });
    }
    return variant.selector ?? variant.legacySlug ?? `${described.name}[${Object.entries(variant.values).map(([key, item]) => `${key}=${item}`).join(',')}]`;
  }

  if (flat) return flat;
  if (!params.length) return match[1]!;
  const serialized = params.map((param) => param.normalized);
  if (family && !family.hasFast && !params.some((param) => param.key === 'fast')) serialized.push('fast=false');
  return `${match[1]}[${serialized.sort().join(',')}]`;
}
