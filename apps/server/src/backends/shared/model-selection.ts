export interface NativeModelSelection {
  model: string;
  params: Record<string, string>;
}

/** The model line behind a gateway namespace, used to constrain provider continuation. */
export function modelFamily(id: string): string {
  const name = parseNativeModelSelection(id).model.toLowerCase().split('/').at(-1)!;
  if (/claude|opus|sonnet|haiku|fable/.test(name)) return 'claude';
  if (/^(?:gpt|codex|o\d)/.test(name)) return 'gpt';
  return /^[a-z]+/.exec(name)?.[0] ?? name;
}

/** Parses the workbench's `model[key=value,...]` form without rewriting unknown options. */
export function parseNativeModelSelection(value: string | undefined): NativeModelSelection {
  const raw = value?.trim() ?? '';
  const closing = raw.endsWith(']') ? raw.length - 1 : -1;
  const opening = closing > 0 ? raw.lastIndexOf('[', closing) : -1;
  if (opening <= 0 || closing <= opening) return { model: raw, params: {} };
  const entries = raw.slice(opening + 1, closing).split(',');
  const parsed = entries.map(entry => {
    const separator = entry.indexOf('=');
    if (separator <= 0) return undefined;
    const key = entry.slice(0, separator).trim();
    const option = entry.slice(separator + 1).trim();
    return key && option ? [key, option] as const : undefined;
  });
  if (!parsed.length || parsed.some(entry => !entry)) return { model: raw, params: {} };
  const params: Record<string, string> = {};
  for (const [key, option] of parsed as Array<readonly [string, string]>) params[key] = option;
  return { model: raw.slice(0, opening).trim(), params };
}

export function nativeModelEffort(selection: NativeModelSelection): string | undefined {
  return selection.params.effort ?? selection.params.reasoningEffort ?? selection.params.reasoning_effort ?? selection.params.reasoning;
}

/**
 * Reads the picker's Fast switch. `undefined` means the catalog never published one for this
 * model, so the backend must leave its own tier alone rather than force a value.
 */
export function nativeModelFast(selection: NativeModelSelection): boolean | undefined {
  const value = selection.params.fast;
  return value === undefined ? undefined : value === 'true';
}
