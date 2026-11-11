import { AppError } from '../../errors.js';
import type { DshSessionReadResult } from './types.js';
import { nonEmpty } from './util.js';

export const DEFAULT_MODEL = 'deepseek-flash';
export const DEFAULT_PROVIDER = 'deepseek-official';

/** The bridge's structured refusal for a selection its own LLM runtime cannot resolve. */
export const MODEL_UNAVAILABLE = 'model-unavailable';
/** The bridge's structured refusal for a permission preset this profile does not offer or admit. */
export const PERMISSION_UNAVAILABLE = 'permission-unavailable';

/** The bridge answered `session/configure` with the conversation's resulting status. */
export type DshConfigureResponse = DshSessionReadResult['status'] & { configured?: boolean; reason?: string; message?: string };

/** A configuration change DSH refused; the driver turns it into a client-visible error. */
export interface DshConfigureFailure {
  reason: typeof MODEL_UNAVAILABLE | typeof PERMISSION_UNAVAILABLE | 'session-not-open';
  message?: string;
}

/**
 * The permission presets the Riffet DSH profile composes: `@deepseek-ai/dsh-base`'s table plus the
 * experimental Auto review bundle, each a sandbox mode paired with an approval policy. The approval
 * policy alone is not a permission — `never` under the default workspace-write sandbox rejects every
 * wider action without asking. The policy is sent alongside the preset for a bridge that predates
 * presets.
 */
export const DSH_PERMISSIONS = {
  'workspace-write': 'ask',
  'read-only': 'ask',
  'danger-full-access': 'never',
  auto: 'ask',
} as const satisfies Record<string, 'ask' | 'never'>;
export type DshPermission = keyof typeof DSH_PERMISSIONS;

/**
 * The preset a recorded value runs as. The bare policies recorded before presets existed (`ask`,
 * `never`) settle on the default preset rather than widening what was chosen.
 */
export function dshPermission(value: string | undefined): DshPermission {
  if (value === undefined || value === '' || value === 'ask' || value === 'never') return 'workspace-write';
  if (Object.hasOwn(DSH_PERMISSIONS, value)) return value as DshPermission;
  throw new AppError('NATIVE_PERMISSION_UNSUPPORTED', `DeepSeek Harness does not offer the permission preset “${value}”.`, 400);
}

export function displayedPermission(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Object.hasOwn(DSH_PERMISSIONS, value) ? value : value === '' || value === 'ask' || value === 'never' ? 'workspace-write' : value;
}

export function toDshSelection(model: string | undefined, currentProvider: string, defaultModel: string): { provider: string; model: string; reasoningEffort?: string } {
  const parsed = parseModelSelection(model ?? defaultModel, currentProvider);
  return { provider: parsed.provider, model: parsed.model, ...(parsed.reasoningEffort ? { reasoningEffort: parsed.reasoningEffort } : {}) };
}

export function canonicalDshModelValue(value: string | undefined, defaultModel = DEFAULT_MODEL): string {
  const selection = toDshSelection(nonEmpty(value) ?? nonEmpty(defaultModel) ?? DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_MODEL);
  return modelValue(selection.provider, selection.model, selection.reasoningEffort);
}

/**
 * What a transcript read adopts from DSH, for the two settings a client can also change.
 *
 * A conversation's own log is the authority for both: DSH's session controller reads the logged
 * selection back on resume, and its approval fold is what every ask resolves under — so a client that
 * changed either one there (or in another client entirely) has to be followed. The exception is a
 * change the workbench has just asked for: while it is still being applied, DSH reports the settings
 * being replaced, and adopting those would undo the choice the user just made.
 *
 * A patch is flagged `bump` (written through `bumpConfig`) only when the meaning moved. That counter is how a client
 * learns that the settings it holds are stale before it submits (the store compares the expectation
 * it sends); a mere respelling DSH normalized (`open()` harmonizes one) is not a change of meaning and
 * must not move it. A message still waiting in the queue is not affected either way: it is delivered
 * under whatever is in effect when it starts.
 *
 * @param reported - the settings DSH reported for the conversation.
 * @param recorded - the settings on the workbench's own session record.
 * @param configuring - whether a configuration change for this conversation is in flight.
 * @param canonical - DSH's canonical spelling of one model selection.
 * @returns the status values to publish, and the record patch a read owes DSH.
 */
export function configAdoption(options: {
  reported: { model?: string; approval?: string };
  recorded: { model?: string; approval?: string };
  configuring: boolean;
  canonical: (value: string | undefined) => string;
}): { model: string; approval?: string; patch?: { model?: string; approval?: string }; bump?: true } {
  // While a change is in flight the status keeps what the user asked for: DSH still reports the
  // settings being replaced, and publishing those would flicker the pickers back.
  const model = options.configuring
    ? options.canonical(options.recorded.model)
    : options.canonical(options.reported.model ?? options.recorded.model);
  const approval = options.configuring || options.reported.approval === undefined
    ? options.recorded.approval
    : options.reported.approval;
  const modelMoved = !options.configuring && options.reported.model !== undefined
    && options.canonical(options.recorded.model) !== options.canonical(options.reported.model);
  const approvalMoved = !options.configuring && options.reported.approval !== undefined
    && options.reported.approval !== options.recorded.approval;
  const modelPatch = options.recorded.model === model ? {} : { model };
  const approvalPatch = approval === undefined || approval === options.recorded.approval ? {} : { approval };
  const status = { model, ...(approval !== undefined ? { approval } : {}) };
  if (!Object.keys(modelPatch).length && !Object.keys(approvalPatch).length) return status;
  return {
    ...status,
    patch: { ...modelPatch, ...approvalPatch },
    ...(modelMoved || approvalMoved ? { bump: true as const } : {}),
  };
}

export function parseModelSelection(value: string, fallbackProvider: string): { provider: string; model: string; reasoningEffort?: string } {
  const match = /^([^\[\]]+)(?:\[([^\]]*)\])?$/.exec(value.trim());
  const base = match?.[1] ?? value.trim();
  const parameters = new Map<string, string>();
  for (const pair of (match?.[2] ?? '').split(',')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    parameters.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
  let provider = fallbackProvider;
  let model = base;
  if (base.startsWith('dsh:')) {
    const encoded = base.slice(4).split(':');
    if (encoded.length < 2) throw new AppError('NATIVE_MODEL_INVALID', 'The selected DSH model id is invalid', 400);
    try {
      provider = decodeURIComponent(encoded[0] ?? fallbackProvider);
      model = decodeURIComponent(encoded.slice(1).join(':'));
    } catch { throw new AppError('NATIVE_MODEL_INVALID', 'The selected DSH model id is invalid', 400); }
  } else {
    const separator = base.indexOf('::');
    if (separator > 0) {
      provider = base.slice(0, separator);
      model = base.slice(separator + 2);
    }
  }
  if (!provider || !model) throw new AppError('NATIVE_MODEL_INVALID', 'A DSH provider and model are required', 400);
  const reasoningEffort = parameters.get('effort') ?? parameters.get('reasoning') ?? parameters.get('reasoning_effort');
  return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export function modelValue(provider: string, model: string, reasoningEffort?: string): string {
  const base = `dsh:${encodeURIComponent(provider)}:${encodeURIComponent(model)}`;
  return reasoningEffort ? `${base}[effort=${reasoningEffort}]` : base;
}
