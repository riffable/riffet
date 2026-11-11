import type { ModelConfigOption, ModelInfo } from '@contracts';
import { AppError } from '@riffet/plugin-api';

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

// The CLI's `--list-models` emits a flat list of ids whose suffix encodes effort / thinking /
// fast only. The `context` dimension is a parameterized bracket argument (see `cursor-agent
// --help`: `claude-opus-4-8[context=1m,effort=high,fast=false]`) and the TUI footer shows one of
// `300K` / `1M` / `MAX`. Expose the three documented settings as a dedicated select so users can
// still pick a context window after the ACP catalog was removed; an unknown family simply does
// not render it. The CLI rejects an unsupported combination at launch, which our normal error
// path surfaces.
const CONTEXT_VALUES = ['300k', '1m', 'max'] as const;
const CONTEXT_LABELS: Record<(typeof CONTEXT_VALUES)[number], string> = { '300k': '300K', '1m': '1M', max: 'MAX' };
function familySupportsContext(id: string): boolean {
  const normalized = id.toLowerCase();
  // Anthropic (claude-*, opus/sonnet/haiku shorthands) and OpenAI long-context GPT-5 variants
  // accept `[context=…]`. The CLI's auto-router entries (`auto-smart`, `auto-fast`) and legacy
  // `cheetah` family do not. Err toward offering the control for named families and hiding it
  // only for the routers the CLI treats as opaque.
  if (normalized.startsWith('auto-') || normalized === 'cheetah') return false;
  return /^(?:claude|opus|sonnet|haiku|gpt-5)/.test(normalized);
}
function contextOption(): ModelConfigOption {
  return {
    id: 'context',
    name: 'Context',
    category: 'model_config',
    type: 'select',
    currentValue: '300k',
    options: CONTEXT_VALUES.map((value) => ({ value, name: CONTEXT_LABELS[value] })),
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
export function nativeModelCatalogFromVariants(nativeEntries: NativeModelEntry[]): ModelInfo[] {
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

    if (familySupportsContext(id)) configOptions.push(contextOption());

    return {
      value: id,
      name: label || id,
      configOptions,
      nativeVariants: variants.map(({ value, name }) => ({ value, name })),
    };
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

  const fastParam = (match[2] ?? '').split(',').map((part) => part.trim()).find((part) => part.startsWith('fast='));
  const fast = fastParam ? fastParam.slice('fast='.length) === 'true' : fastSuffix;
  if (fast) throw new AppError('INVALID_NATIVE_MODEL', 'The native CLI does not support Fast for this model; turn Fast off and try again', 400, undefined, { reason: 'fast' });
}

/**
 * Cursor matches parameterized ids against its canonical variant strings, including parameter
 * order. Sort parameters before launch so selections saved by older clients can resume. Families
 * without Fast still need an explicit `fast=false`; exact CLI-listed ids stay untouched.
 */
export function normalizeNativeModelSelection(model: string, nativeEntries: NativeModelEntry[]): string {
  const value = model.trim();
  const match = /^([^\[\]]+)(?:\[([^\]]*)\])?$/.exec(value);
  assertNativeModelSelection(value, nativeEntries);
  if (nativeEntries.some((entry) => entry.value === value)) return model;
  if (!match) return model;

  const family = nativeFamilies(nativeEntries).get(familyOf(match[1]!).id);
  const params = (match[2] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  if (family && !family.hasFast && !params.some((part) => /^fast\s*=/.test(part))) params.push('fast=false');
  return params.length ? `${match[1]}[${params.sort().join(',')}]` : model;
}
