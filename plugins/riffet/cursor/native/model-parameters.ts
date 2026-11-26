import { protoFields } from './chat-store.js';

/**
 * Cursor's own description of a parameterized model, from `aiserver.v1.AiService/AvailableModels`
 * (`useModelParameters: true`), which `cursor-agent --list-models` requests but does not print.
 * Parameter ids, values and the exact launch strings differ per model family (`context=272k` with
 * `reasoning` for GPT, `context=300k` with `reasoning_effort` for Gemini), so they are read, not guessed.
 */
export interface CursorModelParameter { id: string; name: string; values: Array<{ value: string; name: string }> }

export interface CursorModelVariant {
  values: Record<string, string>;
  /** What `--model` accepts for exactly this combination (`variant_string_representation`). */
  selector?: string;
  /** The flat id `--list-models` prints for this combination, when it has one. */
  legacySlug?: string;
  defaultNonMax: boolean;
}

export interface CursorParameterizedModel {
  name: string;
  legacySlugs: string[];
  parameters: CursorModelParameter[];
  variants: CursorModelVariant[];
}

type Fields = ReturnType<typeof protoFields>;

const decoder = new TextDecoder();
const messages = (fields: Fields, number: number): Fields[] =>
  fields.flatMap(([n, value]) => (n === number && value instanceof Uint8Array ? [protoFields(value)] : []));
const strings = (fields: Fields, number: number): string[] =>
  fields.flatMap(([n, value]) => (n === number && value instanceof Uint8Array ? [decoder.decode(value)] : []));
const text = (fields: Fields, number: number): string | undefined => strings(fields, number).at(-1) || undefined;
const flag = (fields: Fields, number: number): boolean => fields.some(([n, value]) => n === number && value === 1);

// Field numbers from the CLI's generated descriptors (`AvailableModelsResponse.*`, `ModelParameterDefinition.*`).
function parameter(fields: Fields): CursorModelParameter | undefined {
  const id = text(fields, 1);
  if (!id) return undefined;
  const type = messages(fields, 4)[0] ?? [];
  // `boolean_parameter` = 1, `enum_parameter` = 2; both hold repeated `{ value = 1, display_name = 2 }`.
  const definition = messages(type, 2)[0] ?? messages(type, 1)[0] ?? [];
  const values = messages(definition, 1).flatMap((item) => {
    const value = text(item, 1);
    return value ? [{ value, name: text(item, 2) ?? value }] : [];
  });
  return { id, name: text(fields, 2) ?? id, values };
}

function variant(fields: Fields): CursorModelVariant {
  const values: Record<string, string> = {};
  for (const item of messages(fields, 1)) {
    const id = text(item, 1), value = text(item, 2);
    if (id && value !== undefined) values[id] = value;
  }
  const selector = text(fields, 9), legacySlug = text(fields, 11);
  return { values, ...(selector ? { selector } : {}), ...(legacySlug ? { legacySlug } : {}), defaultNonMax: flag(fields, 5) };
}

/** Decodes an `AvailableModelsResponse`; models without parameters or variants are left out. */
export function decodeAvailableModels(body: Uint8Array): CursorParameterizedModel[] {
  return messages(protoFields(body), 2).flatMap((fields) => {
    const name = text(fields, 1);
    if (!name) return [];
    const parameters = messages(fields, 29).flatMap((item) => parameter(item) ?? []);
    const variants = messages(fields, 30).map(variant);
    if (!parameters.length || !variants.length) return [];
    return [{ name, legacySlugs: strings(fields, 36), parameters, variants }];
  });
}

/** The parameterized model behind a family of flat `--list-models` ids. */
export function parameterizedModelFor(models: readonly CursorParameterizedModel[], familyId: string, flatIds: readonly string[]): CursorParameterizedModel | undefined {
  return models.find((model) => model.variants.some((item) => item.legacySlug && flatIds.includes(item.legacySlug)))
    ?? models.find((model) => model.name === familyId || model.legacySlugs.includes(familyId));
}

/** A parameter's values that some variant can actually be launched with. */
export function launchableValues(model: CursorParameterizedModel, id: string): Array<{ value: string; name: string }> {
  const definition = model.parameters.find((item) => item.id === id);
  if (!definition) return [];
  const used = new Set(model.variants.map((item) => item.values[id]).filter((value): value is string => value !== undefined));
  return definition.values.filter((item) => used.has(item.value));
}

const sameValues = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
};

export function variantWith(model: CursorParameterizedModel, values: Record<string, string>): CursorModelVariant | undefined {
  return model.variants.find((item) => sameValues(item.values, values));
}

/** The values a flat id stands for, or the model's default combination. */
export function baseValues(model: CursorParameterizedModel, flatId: string | undefined): Record<string, string> | undefined {
  const variant = (flatId ? model.variants.find((item) => item.legacySlug === flatId) : undefined)
    ?? model.variants.find((item) => item.defaultNonMax)
    ?? model.variants[0];
  return variant?.values;
}
