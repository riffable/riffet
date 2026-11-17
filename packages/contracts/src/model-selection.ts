import type { ModelInfo, NativeBackendDefaults } from './index.js';

/*
 * Model selections (`model[k=v,…]`) and the catalog parameters behind them: pure and language-free,
 * shared by the Web picker and the channel `/model` card. Display labels stay with each client.
 */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const records = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const cleanLabel = (value: string): string => value.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();

export interface ModelParam {
  id: string;
  name: string;
  description?: string;
  category?: string;
  value: string;
  options: Array<{ value: string; label: string }>;
}

export type ParamKind = 'effort' | 'toggle' | 'fast' | 'max' | 'select';

const PARAM_CATEGORIES = new Set(['thought_level', 'model_config']);

/** Reads model parameter selects (effort, fast, context…) out of the catalog's config options. */
export function paramsFromOptions(options: unknown): ModelParam[] {
  return records(options).flatMap((option) => {
    const id = str(option.id);
    const category = str(option.category);
    if (!id || !category || !PARAM_CATEGORIES.has(category) || option.type !== 'select') return [];
    const choices = records(option.options).flatMap((item) => (str(item.value) ? [{ value: str(item.value)!, label: cleanLabel(str(item.name) ?? str(item.value)!) }] : []));
    if (choices.length < 2) return [];
    return [{ id, name: cleanLabel(str(option.name) ?? id), category, value: str(option.currentValue) ?? choices[0]!.value, options: choices, ...(str(option.description) ? { description: str(option.description) } : {}) }];
  });
}

export function parseSelection(value?: string): { model: string; params: Record<string, string> } {
  const raw = value?.trim() ?? '';
  const match = /^(.*)\[([^\[\]]*)\]$/.exec(raw);
  const entries = match?.[2]?.split(',') ?? [];
  // Native model ids can contain suffixes such as Claude's [1m]. Only our final
  // key=value suffix is a workbench selector; preserve every other native suffix.
  if (!match || !match[1] || !entries.length || entries.some((entry) => {
    const separator = entry.indexOf('=');
    return separator <= 0 || !entry.slice(0, separator).trim() || !entry.slice(separator + 1).trim();
  })) return { model: raw, params: {} };
  const params: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    const key = entry.slice(0, separator).trim();
    const item = entry.slice(separator + 1).trim();
    if (key && item) params[key] = item;
  }
  return { model: match[1]!, params };
}

/** The catalog entry a selector names, including identities the provider kept from a rename. */
export function catalogEntry(catalog: ModelInfo[], model: string): ModelInfo | undefined {
  return catalog.find((item) => item.value === model)
    ?? catalog.find((item) => item.aliases?.includes(model))
    ?? catalog.find((item) => item.nativeVariants?.some((variant) => variant.value === model));
}

export function serializeSelection(model: string, params: Record<string, string>): string {
  // A CLI that matches parameterized model strings exactly needs their key order deterministic.
  const entries = Object.entries(params).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return entries.length ? `${model}[${entries.map(([key, value]) => `${key}=${value}`).join(',')}]` : model;
}

/**
 * Builds a model selection from its complete catalog entry, including fixed one-value options
 * that do not need a visible control. Invalid or stale overrides are replaced by catalog values.
 */
export function catalogSelection(catalog: ModelInfo[], model: string, overrides: Record<string, string> = {}, preferredParam?: string): string {
  const info = catalogEntry(catalog, model);
  if (!info) return serializeSelection(model, overrides);
  const canonical = info.value;
  const params: Record<string, string> = {};
  for (const option of info.configOptions) {
    if (option.type !== 'select' || !option.id) continue;
    const allowed = option.options.map((item) => item.value).filter(Boolean);
    if (!allowed.length) continue;
    const value = allowed.includes(overrides[option.id] ?? '')
      ? overrides[option.id]!
      : allowed.includes(option.currentValue) ? option.currentValue : allowed[0]!;
    params[option.id] = value;
  }
  const nativeVariant = selectNativeVariant(info, params, preferredParam);
  // A native variant id encodes effort / thinking / fast by suffix and nothing else. When the reader
  // also chose a dimension the id cannot carry - the context window, i.e. `context=max` for Max mode
  // - the selection has to be the family's parameterized form the CLI documents
  // (`claude-opus-4-8[context=1m,effort=high,fast=false]`). Returning the flat id there would drop
  // the choice silently: the switch would look on and the CLI would never hear about it.
  if (nativeVariant && !Object.keys(overrides).some((id) => !NATIVE_VARIANT_PARAMS.has(id))) return nativeVariant;
  return serializeSelection(canonical, params);
}

const NATIVE_DIMENSIONS = ['extra-high', 'xhigh', 'minimal', 'none', 'medium', 'low', 'high', 'max', 'thinking', 'fast'];

/**
 * The parameters a native variant id already carries as a suffix. Everything else has to be spelled
 * out in `[...]`, which is why `catalogSelection` leaves the flat id as soon as one of them is chosen.
 */
const NATIVE_VARIANT_PARAMS = new Set(['effort', 'reasoning', 'reasoning_effort', 'thinking', 'fast']);
interface NativeVariantSlots { effort: string; thinking: boolean; fast: boolean; }

function nativeVariantSlots(value: string): { base: string; slots: NativeVariantSlots } {
  let base = value.trim().split('[', 1)[0] ?? '';
  const slots: NativeVariantSlots = { effort: '', thinking: false, fast: false };
  for (;;) {
    const token = NATIVE_DIMENSIONS.find((item) => base.length > item.length + 1 && base.endsWith(`-${item}`));
    if (!token) break;
    base = base.slice(0, -(token.length + 1));
    if (token === 'fast') slots.fast = true;
    else if (token === 'thinking') slots.thinking = true;
    else slots.effort = token;
  }
  return { base, slots };
}

function selectNativeVariant(info: ModelInfo, params: Record<string, string>, preferredParam?: string): string | undefined {
  const variants = info.nativeVariants?.filter((variant) => nativeVariantSlots(variant.value).base === info.value);
  if (!variants?.length) return undefined;
  const members = variants.map((variant) => ({ variant, slots: nativeVariantSlots(variant.value).slots }));
  const defaultMember = members.find(({ slots }) => !slots.effort && !slots.fast && !slots.thinking)
    ?? members.find(({ variant }) => variant.name === info.name)
    ?? members[0]!;
  const effortParam = Object.entries(params).find(([id]) => ['effort', 'reasoning', 'reasoning_effort'].includes(id))?.[1];
  const wished: NativeVariantSlots = {
    effort: effortParam === 'default' ? '' : effortParam ?? defaultMember.slots.effort,
    fast: params.fast === undefined ? defaultMember.slots.fast : params.fast === 'true',
    thinking: params.thinking === undefined ? defaultMember.slots.thinking : params.thinking === 'true',
  };
  const preferredDimension = preferredParam === 'reasoning' || preferredParam === 'reasoning_effort' ? 'effort' : preferredParam;
  const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'extra-high', 'max'];
  const rank = (value: string) => effortOrder.indexOf(value || 'medium');
  const cost = (slots: NativeVariantSlots) => {
    const fixedCost = preferredDimension === 'effort' && slots.effort !== wished.effort
      || preferredDimension === 'fast' && slots.fast !== wished.fast
      || preferredDimension === 'thinking' && slots.thinking !== wished.thinking ? 1000 : 0;
    return fixedCost
      + (slots.fast === wished.fast ? 0 : 2)
      + (slots.thinking === wished.thinking ? 0 : 2)
      + Math.abs(rank(slots.effort) - rank(wished.effort)) * 0.1;
  };
  return [...members].sort((left, right) => cost(left.slots) - cost(right.slots))[0]!.variant.value;
}

export function catalogParams(catalog: ModelInfo[], model: string, overrides: Record<string, string>): ModelParam[] {
  const info = catalogEntry(catalog, model);
  return paramsFromOptions(info?.configOptions).map((param) => {
    const value = overrides[param.id];
    return value && param.options.some((option) => option.value === value) ? { ...param, value } : param;
  });
}

/** True when Fast is not explicitly false for a native model whose catalog only permits false. */
export function nativeFastUnavailable(catalog: ModelInfo[], selection?: string): boolean {
  const { model, params } = parseSelection(selection);
  if (params.fast === 'false') return false;
  const fast = catalog.find((item) => item.value === model)?.configOptions.find((option) => option.id === 'fast');
  return fast?.options.length === 1 && fast.options[0]?.value === 'false';
}

/** Preserve valid parameters and add the explicit fixed Fast=false value for native CLI safety. */
export function normalizeNativeFastSelection(catalog: ModelInfo[], selection?: string): string | undefined {
  if (!selection || !nativeFastUnavailable(catalog, selection)) return selection;
  const { model, params } = parseSelection(selection);
  return catalogSelection(catalog, model, { ...params, fast: 'false' });
}

const isBoolean = (param: ModelParam) => param.options.length === 2 && param.options.every((option) => option.value === 'true' || option.value === 'false');

export const MAX_VALUE = 'max';

export function paramKind(param: ModelParam): ParamKind {
  if (param.id === 'fast'
    && ['true', 'false'].every(value => param.options.some(option => option.value === value))
    && param.options.every(option => ['true', 'false', 'default'].includes(option.value))) return 'fast';
  // Max is the `max` context window, not "a context select with two entries": the catalog publishes
  // three windows (300K / 1M / MAX) and Max is the one a CLI's own UI shows as a mode.
  if (param.id === 'context' && param.options.some((option) => option.value === MAX_VALUE)) return 'max';
  if (isBoolean(param)) return 'toggle';
  if (param.category === 'thought_level') return 'effort';
  return 'select';
}

/** The option that turns Max mode on, when this parameter has one. */
export const maxOption = (param: ModelParam) => (paramKind(param) === 'max' ? param.options.find((option) => option.value === MAX_VALUE) : undefined);

/** The context windows the Max switch does not own (300K / 1M), so nothing documented is unreachable. */
export const contextChoices = (param: ModelParam) => (paramKind(param) === 'max' ? param.options.filter((option) => option.value !== MAX_VALUE) : []);


export const isOn = (param: ModelParam) => (paramKind(param) === 'max' ? param.value === MAX_VALUE : param.value === 'true');

/**
 * The value a toggle writes. Max turns on the `max` context window and off to `fallback` - the window
 * the caller was showing - so a round trip through Max never silently drops a context choice. With no
 * fallback the widest non-Max window is the honest default: it is the one the catalog's model names
 * advertise (`Claude Opus 5.5 1M`).
 */
export function toggledValue(param: ModelParam, on: boolean, fallback?: string): string {
  if (paramKind(param) !== 'max') return on ? 'true' : 'false';
  if (on) return MAX_VALUE;
  return fallback ?? contextChoices(param).at(-1)?.value ?? param.options[0]!.value;
}

/** Dimensions a native CLI encodes as id suffixes. `''` effort means "no suffix", i.e. the family's default. */
export interface NativeSlots { thinking: boolean; effort: string; fast: boolean; }

/** Longest tokens first: `extra-high` has to be consumed before the `high` inside it. */
const SLOT_EFFORT_TOKENS = ['extra-high', 'xhigh', 'minimal', 'none', 'medium', 'low', 'high', 'max'];
const SLOT_FLAG_TOKENS = ['thinking', 'fast'];

/** Splits an id into its family prefix and the dimensions its suffixes spell out. */
export function splitModelId(id: string): { base: string; slots: NativeSlots } {
  let base = id;
  const slots: NativeSlots = { thinking: false, effort: '', fast: false };
  for (;;) {
    const token = [...SLOT_EFFORT_TOKENS, ...SLOT_FLAG_TOKENS].find((candidate) => base.length > candidate.length + 1 && base.endsWith(`-${candidate}`));
    if (!token) break;
    base = base.slice(0, -(token.length + 1));
    if (token === 'thinking') slots.thinking = true;
    else if (token === 'fast') slots.fast = true;
    else slots.effort = token;
  }
  return { base, slots };
}

/**
 * Maps a persisted selection onto the catalog's family model and its config options: an exact
 * family id (with legacy effort keys renamed), a flat native variant id such as `…-high-fast`, or an
 * id the provider kept from a rename. Undefined when none of those apply.
 */
export function resolveCatalogSelection(catalog: ModelInfo[], value?: string): string | undefined {
  const parsed = parseSelection(value);
  const exactModel = catalog.find((item) => item.value === parsed.model);
  if (exactModel) {
    // Older native selections serialize the effort slot as `reasoning` or `reasoning_effort`.
    // Fallback families expose the shared `effort` control, so translate those aliases.
    if (exactModel.nativeVariants?.length) {
      const params = { ...parsed.params };
      const effort = params.effort ?? params.reasoning_effort ?? params.reasoning;
      delete params.reasoning;
      delete params.reasoning_effort;
      if (effort !== undefined) params.effort = effort;
      if (Object.keys(params).length !== Object.keys(parsed.params).length
        || Object.keys(params).some((key) => params[key] !== parsed.params[key])) {
        return serializeSelection(parsed.model, params);
      }
    }
    return value ?? parsed.model;
  }
  const exactVariant = catalog.find((item) => item.nativeVariants?.some((variant) => variant.value === parsed.model));
  if (exactVariant) {
    const variant = exactVariant.nativeVariants!.find((item) => item.value === parsed.model)!;
    const slots = splitModelId(variant.value).slots;
    const params: Record<string, string> = {};
    if (slots.effort) params.effort = slots.effort;
    params.thinking = String(slots.thinking);
    params.fast = String(slots.fast);
    Object.assign(params, parsed.params);
    return serializeSelection(exactVariant.value, params);
  }
  const aliased = catalog.find((item) => item.aliases?.includes(parsed.model));
  if (aliased) return serializeSelection(aliased.value, parsed.params);
  return undefined;
}

/**
 * The selection a model starts with when it is picked. The model last used on this provider
 * (`remembered`, a full selection) comes back as it was; any other model takes on the parameters in
 * force (`current`) wherever it accepts them, so effort, Fast and the context window survive a switch.
 */
export function pickedSelection(catalog: ModelInfo[], model: string, current: Record<string, string> = {}, remembered?: string): string {
  const canonical = (id: string) => catalogEntry(catalog, id)?.value ?? id;
  const last = parseSelection(remembered).model;
  if (remembered && last && canonical(last) === canonical(model)) return remembered;
  return catalogSelection(catalog, model, current);
}

/**
 * A backend's defaults after a save of `next` over `stored`: the provider/model pair in force is
 * remembered under its provider, and a switch to a provider that names no model starts on the one last
 * used there. `profileModels` is the server's own record; a value sent for it is ignored.
 */
export function rememberProfileModel(stored: NativeBackendDefaults | undefined, next: NativeBackendDefaults, limit: number): NativeBackendDefaults {
  const { profileModels: _sent, ...entry } = next;
  const models: Record<string, string> = { ...stored?.profileModels };
  const record = (profileId: string | undefined, model: string | undefined) => {
    if (!profileId || !model) return;
    delete models[profileId];
    models[profileId] = model;
  };
  // A pair saved before this record existed is kept too, so a provider switched away from comes back.
  if (stored?.profileModels?.[stored.profileId ?? ''] === undefined) record(stored?.profileId, stored?.model);
  const switched = entry.profileId !== undefined && entry.profileId !== stored?.profileId;
  if (switched && entry.model === undefined && models[entry.profileId!]) entry.model = models[entry.profileId!];
  // The same provider saved without a model is a return to its configured default.
  if (!switched && entry.profileId && entry.model === undefined && stored?.model !== undefined) delete models[entry.profileId];
  record(entry.profileId, entry.model);
  const kept = Object.entries(models).slice(-limit);
  return kept.length ? { ...entry, profileModels: Object.fromEntries(kept) } : entry;
}
