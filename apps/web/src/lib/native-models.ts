import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { resolveCatalogSelection, splitModelId, type ModelInfo, type NativeSlots } from '@contracts';
import { catalogParams, paramKind, parseSelection, serializeSelection, type ModelParam } from './models';

export { splitModelId };
export type { NativeSlots };

/**
 * Helpers for legacy native CLI ids and footer labels. The native detail picker uses the shared
 * model catalog for choices and config options; these helpers map older flat ids/footer text back
 * to that catalog (one that groups exact CLI ids under `nativeVariants`) when restoring the
 * displayed native selection.
 */

export interface NativeModelEntry { value: string; name: string; }

export interface NativeFamily {
  /** The id prefix shared by the family; also the model's own id when every slot is at its default. */
  id: string;
  label: string;
  models: Array<{ id: string; name: string; slots: NativeSlots }>;
}

/** The CLI's current selection: the family, its dimensions, and the overrides it spelled out itself. */
export interface NativeSelection {
  family: NativeFamily;
  slots: NativeSlots;
  overrides: Record<string, string>;
}

/** Longest tokens first: `extra-high` has to be consumed before the `high` inside it. */
const EFFORT_TOKENS = ['extra-high', 'xhigh', 'minimal', 'none', 'medium', 'low', 'high', 'max'];
const EFFORT_ORDER = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'extra-high', 'max'];
/** The CLI spells the effort dimension differently from one model family to the next. */
const EFFORT_KEYS = ['effort', 'reasoning_effort', 'reasoning'];

/**
 * What every member's name has in common — "Claude Opus 4.8 1M" out of "…1M Low" / "…1M Extra
 * High" / "…1M Thinking". Dimension words therefore stay out of the label and are shown by the
 * controls instead. A parenthetical that every member shares is kept, since it is a property of
 * the family rather than of one combination (`… 1M (NO ZDR)`).
 */
function familyLabel(names: string[]): string {
  const usable = names.filter(Boolean);
  if (!usable.length) return '';
  let prefix = usable[0]!;
  for (const name of usable.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < name.length && prefix[index] === name[index]) index += 1;
    prefix = prefix.slice(0, index);
  }
  const label = prefix.replace(/[\s·:,-]+$/, '').replace(/\s*\((?:default|current)\)$/i, '').trim();
  if (!label) return usable[0]!;
  const suffixes = usable.map((name) => /\(([^()]*)\)\s*$/.exec(name)?.[1] ?? '');
  const shared = suffixes[0];
  return shared && !/^(?:default|current)$/i.test(shared) && suffixes.every((item) => item === shared) ? `${label} (${shared})` : label;
}

const sameSlots = (a: NativeSlots, b: NativeSlots) => a.thinking === b.thinking && a.effort === b.effort && a.fast === b.fast;

/** Groups the CLI's flat list into model families, preserving the CLI's own ordering. */
export function nativeFamilies(entries: NativeModelEntry[]): NativeFamily[] {
  const families = new Map<string, NativeFamily>();
  for (const entry of entries) {
    const { base, slots } = splitModelId(entry.value);
    const family = families.get(base) ?? { id: base, label: '', models: [] };
    family.models.push({ id: entry.value, name: entry.name, slots });
    families.set(base, family);
  }
  return [...families.values()].map((family) => ({ ...family, label: familyLabel(family.models.map((model) => model.name)) }));
}

/** The member a slot tuple identifies, if the CLI listed it. */
export function familyModel(family: NativeFamily, slots: NativeSlots) {
  return family.models.find((model) => sameSlots(model.slots, slots));
}

/** The family's own default: the bare id, else the member the CLI names after the family itself. */
export function defaultSlots(family: NativeFamily): NativeSlots {
  const bare = family.models.find((model) => sameSlots(model.slots, { thinking: false, effort: '', fast: false }));
  const named = family.models.find((model) => model.name === family.label);
  return (bare ?? named ?? family.models[0]!).slots;
}

/** Every value of one dimension the CLI listed for this family. */
function dimensionValues(family: NativeFamily, key: keyof NativeSlots): string[] {
  const values = new Set<string>();
  for (const model of family.models) values.add(key === 'effort' ? model.slots.effort : String(model.slots[key]));
  return [...values];
}

const toggleParam = (id: 'thinking' | 'fast', name: string, on: boolean): ModelParam => ({
  id, name, category: 'model_config', value: on ? 'true' : 'false',
  options: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'On' }],
});

/**
 * Dimension controls for the current selection, shaped like the catalog's `configOptions` so the
 * shared picker renders them identically (segments for effort, switches for thinking and fast).
 * A dimension with a single listed value is not a choice, so it is left out; combinations the CLI
 * did not list are handled by `changeSlots` instead of by hiding the control.
 */
export function nativeParams(family: NativeFamily, slots: NativeSlots): ModelParam[] {
  const params: ModelParam[] = [];
  const efforts = dimensionValues(family, 'effort');
  if (efforts.length > 1) {
    const options = efforts.map((value) => ({ value, label: value || i18n._(msg`默认`) }));
    options.sort((a, b) => EFFORT_ORDER.indexOf(a.value) - EFFORT_ORDER.indexOf(b.value));
    params.push({ id: 'effort', name: 'Effort', category: 'thought_level', value: slots.effort, options });
  }
  if (dimensionValues(family, 'thinking').length > 1) params.push(toggleParam('thinking', 'Thinking', slots.thinking));
  if (dimensionValues(family, 'fast').length > 1) params.push(toggleParam('fast', 'Fast', slots.fast));
  return params;
}

const effortRank = (value: string) => {
  // An id with no effort suffix is the family's own default, which the CLI's vocabulary calls
  // `medium` — so a repair towards `medium` lands on the bare id rather than the lowest effort.
  const scale = EFFORT_ORDER.slice(1);
  const index = value === '' ? scale.indexOf('medium') : scale.indexOf(value);
  return index < 0 ? scale.indexOf('medium') : index;
};

/**
 * The listed combination closest to `wished`. When one dimension must be honoured (`fixed`, the one
 * just changed) the others move as little as possible: nearest effort first, then flags.
 */
function nearestSlots(family: NativeFamily, wished: NativeSlots, fixed?: keyof NativeSlots): NativeSlots {
  const matching = fixed ? family.models.filter((model) => model.slots[fixed] === wished[fixed]) : family.models;
  const candidates = matching.length ? matching : family.models;
  const cost = (model: NativeSlots) => {
    let total = 0;
    if (model.thinking !== wished.thinking) total += 2;
    if (model.fast !== wished.fast) total += 2;
    return total + Math.abs(effortRank(model.effort) - effortRank(wished.effort)) * 0.1;
  };
  return [...candidates].sort((a, b) => cost(a.slots) - cost(b.slots))[0]!.slots;
}

/**
 * Applies one dimension change. The CLI does not list every combination (e.g. `claude-opus-5` has
 * no thinking/high), so the requested value is kept and the other dimensions follow it, instead of
 * composing an id the CLI would reject.
 */
export function changeSlots(family: NativeFamily, slots: NativeSlots, paramId: string, value: string): NativeSlots {
  const wanted: NativeSlots = { ...slots };
  if (paramId === 'thinking' || paramId === 'fast') wanted[paramId] = value === 'true';
  else if (paramId === 'effort') wanted.effort = value;
  else return nearestSlots(family, wanted);
  return nearestSlots(family, wanted, paramId as keyof NativeSlots);
}

/**
 * Finds the family and dimensions the CLI is currently on. `value` is the id we last set; when the
 * model was changed inside the terminal itself, `label` carries the CLI's own footer text, which is
 * a display name ("Claude Opus 5.5 1M High · 300K") rather than an id.
 *
 * `overrides` keeps the parameterised part of the CLI's own selection (`context=300k`), which the
 * flat list cannot name but `--model` understands, so a switch does not silently reset it.
 */
export function matchFamily(families: NativeFamily[], value?: string, label?: string): NativeSelection | undefined {
  const id = value?.trim();
  if (id) {
    for (const family of families) {
      const member = family.models.find((model) => model.id === id);
      if (member) return { family, slots: member.slots, overrides: {} };
    }
    const [base, paramText] = id.split('[') as [string, string?];
    const family = families.find((item) => item.id === base);
    if (family) {
      const parsed: NativeSlots = { thinking: false, effort: '', fast: false };
      const overrides: Record<string, string> = {};
      for (const pair of (paramText ?? '').replace(/\]$/, '').split(',')) {
        const [key, raw] = pair.split('=');
        if (!key || raw === undefined) continue;
        overrides[key] = raw;
        if (key === 'thinking') parsed.thinking = raw === 'true';
        else if (key === 'fast') parsed.fast = raw === 'true';
        else if (EFFORT_KEYS.includes(key) && (!raw || EFFORT_TOKENS.includes(raw))) parsed.effort = raw;
      }
      return { family, slots: nearestSlots(family, parsed), overrides };
    }
  }
  if (!label) return undefined;
  // The footer drops/rounds some detail (context as `300K`, a `· MAX` mode suffix), so compare on
  // a normalised form and fall back to the longest matching name.
  const normal = (text: string) => text.toLowerCase().replace(/·.*$/, '').replace(/\(no zdr\)/g, '').replace(/\b\d+(?:\.\d+)?\s*[km]\b/g, '').replace(/[^a-z0-9.]+/g, ' ').trim();
  const needle = normal(label);
  if (!needle) return undefined;
  let best: { family: NativeFamily; slots: NativeSlots; length: number } | undefined;
  for (const family of families) {
    for (const model of family.models) {
      const text = normal(model.name);
      if (text === needle) return { family, slots: model.slots, overrides: {} };
      const boundaryPrefix = (longer: string, shorter: string) => longer === shorter || longer.startsWith(`${shorter} `);
      if ((boundaryPrefix(needle, text) || boundaryPrefix(text, needle)) && (!best || text.length > best.length)) best = { family, slots: model.slots, length: text.length };
    }
  }
  return best ? { family: best.family, slots: best.slots, overrides: {} } : undefined;
}

const modelWords = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const containsModelWords = (text: string, value: string) => {
  const words = modelWords(value);
  return Boolean(words) && ` ${modelWords(text)} `.includes(` ${words} `);
};
const effortWords = (value: string) => {
  const words = modelWords(value);
  return words === 'extra high' || words === 'very high' ? 'xhigh' : words;
};

function catalogValues(catalog: ModelInfo[], model: string, overrides: Record<string, string>, slots?: NativeSlots, suffix = '', metadata = ''): Record<string, string> {
  const params = catalogParams(catalog, model, overrides);
  const values: Record<string, string> = {};
  for (const param of params) {
    // Saved parameters and the CLI's variant suffix are evidence of a choice. Catalog defaults are
    // only for rendering controls and must not become explicit CLI overrides during restoration.
    if (param.id in overrides) {
      if (param.options.some((option) => option.value === overrides[param.id])) values[param.id] = overrides[param.id]!;
      continue;
    }
    if (paramKind(param) === 'effort') {
      const inferred = param.options.find((option) => {
        const optionWords = effortWords(option.value || option.label);
        return optionWords && containsModelWords(suffix, optionWords);
      })?.value;
      const wanted = slots?.effort || inferred;
      if (wanted) {
        const option = param.options.find((item) => effortWords(item.value) === effortWords(wanted) || effortWords(item.label) === effortWords(wanted));
        if (option) values[param.id] = option.value;
      }
    } else if (param.id === 'fast') {
      if (slots) values[param.id] = String(slots.fast);
      else if (containsModelWords(suffix, 'fast')) values[param.id] = 'true';
    } else if (param.id === 'thinking') {
      if (slots) values[param.id] = String(slots.thinking);
      else if (containsModelWords(suffix, 'thinking')) values[param.id] = 'true';
    } else if (paramKind(param) === 'max') {
      if (containsModelWords(metadata, 'max')) values[param.id] = param.options.at(-1)?.value ?? param.value;
      else {
        const option = param.options.find((item) => containsModelWords(metadata, item.value) || containsModelWords(metadata, item.label));
        if (option) values[param.id] = option.value;
      }
    }
  }
  return values;
}

/** Maps persisted CLI variants and its footer back to the shared catalog's model and config options. */
export function nativeCatalogSelection(catalog: ModelInfo[], value?: string, statusModel?: string): string | undefined {
  const resolved = resolveCatalogSelection(catalog, value);
  if (resolved !== undefined) return resolved;
  const parsed = parseSelection(value);

  const legacy = splitModelId(parsed.model);
  if (legacy.base !== parsed.model && catalog.some((item) => item.value === legacy.base)) {
    return serializeSelection(legacy.base, catalogValues(catalog, legacy.base, parsed.params, legacy.slots));
  }

  if (statusModel) {
    const entries = catalog.map(({ value: id, name }) => ({ value: id, name }));
    const matched = matchFamily(nativeFamilies(entries), undefined, statusModel);
    const visible = statusModel.split(/\s·\s/)[0] ?? statusModel;
    const metadata = statusModel.split(/\s·\s/).slice(1).join(' ');
    const statusFamily = matched?.family;
    if (statusFamily) {
      const member = [...statusFamily.models]
        .filter((item) => {
          const name = modelWords(item.name);
          const label = modelWords(visible);
          return label === name || label.startsWith(`${name} `);
        })
        .sort((left, right) => modelWords(right.name).length - modelWords(left.name).length)[0];
      const model = member?.id ?? statusFamily.id;
      const name = member?.name ?? statusFamily.label;
      const suffix = modelWords(visible).slice(modelWords(name).length).trim();
      const selectedSlots = !suffix ? member?.slots : undefined;
      const values = catalogValues(catalog, model, {}, selectedSlots, suffix, metadata);
      return serializeSelection(model, values);
    }
  }
  return value;
}

/**
 * The `--model` argument for a selection.
 *
 * The flat ids the CLI lists are always accepted, so they are the default. When the current
 * selection is the CLI's parameterised form — which is how a non-default context window
 * (`context=300k`) is expressed and which the flat list never names — that string is kept and only
 * the dimensions it already spells out are rewritten. If it cannot express the new selection, the
 * flat id wins and the overrides are dropped rather than guessed at.
 */
export function composeModel(selection: NativeSelection, slots: NativeSlots): string | undefined {
  const flat = familyModel(selection.family, slots)?.id;
  if (!flat) return undefined;
  const { overrides } = selection;
  if (!Object.keys(overrides).length) return flat;
  const effortKey = EFFORT_KEYS.find((key) => key in overrides);
  const expressible = (!slots.thinking || 'thinking' in overrides) && (!slots.fast || 'fast' in overrides) && (slots.effort ? Boolean(effortKey) : !effortKey);
  if (!expressible) return flat;
  const params = { ...overrides };
  if (effortKey) params[effortKey] = slots.effort;
  if ('thinking' in params) params.thinking = String(slots.thinking);
  if ('fast' in params) params.fast = String(slots.fast);
  return `${selection.family.id}[${Object.entries(params).map(([key, value]) => `${key}=${value}`).join(',')}]`;
}
