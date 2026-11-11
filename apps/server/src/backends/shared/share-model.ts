import type { NativeBackendId, ShareModelInfo } from '../../../../../packages/contracts/src/index.js';
import { parseModelSelection } from '../dsh/selection.js';
import { nativeModelEffort, parseNativeModelSelection } from './model-selection.js';

const label = (value: unknown): string | undefined => typeof value === 'string' && value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]|:\/\//.test(value) ? value.trim() : undefined;

/** Project model identity and known execution options, never a provider's configuration object. */
export function shareModelInfo(value: unknown, backend: NativeBackendId, source: ShareModelInfo['source'], metadata: Record<string, unknown> = {}): ShareModelInfo | undefined {
  if (typeof value !== 'string') return;
  const selection = parseNativeModelSelection(value);
  let model = selection.model, effort = nativeModelEffort(selection);
  if (backend === 'dsh') {
    try { const parsed = parseModelSelection(value, 'default'); model = parsed.model; effort = parsed.reasoningEffort; }
    catch { return; }
  }
  const name = label(model);
  if (!name || name === '<synthetic>') return;
  const reasoning = metadata.reasoning && typeof metadata.reasoning === 'object' ? metadata.reasoning as Record<string, unknown> : undefined;
  const reasoningEffort = label(metadata.reasoningEffort ?? metadata.reasoning_effort ?? metadata.effort ?? reasoning?.effort ?? effort);
  const fast = typeof metadata.fast === 'boolean' ? metadata.fast : selection.params.fast === 'true' ? true : selection.params.fast === 'false' ? false : undefined;
  const serviceTier = label(metadata.serviceTier ?? metadata.service_tier);
  return { model: name, source, ...(reasoningEffort ? { reasoningEffort } : {}), ...(fast !== undefined ? { fast } : {}), ...(serviceTier ? { serviceTier } : {}) };
}
