import type { NativeBackendId } from '../../../../packages/contracts/src/index.js';
import type { BackendCatalog } from '../backends/catalog.js';
import { AppError, requireString } from '../errors.js';

export async function validateBackendDefaults(
  catalog: Pick<BackendCatalog, 'validateProfile' | 'capabilitiesFor'>,
  backendId: NativeBackendId, profileId: string | undefined, model: unknown,
) {
  const profile = catalog.validateProfile(backendId, profileId);
  const capabilities = await catalog.capabilitiesFor(backendId, profile.id);
  if (model !== undefined) {
    requireString(model, 'model', 200);
    if (!capabilities.supportsModelSelection) throw new AppError('NATIVE_MODEL_UNSUPPORTED', `${backendId} does not support model selection`);
  }
  return { profile, capabilities };
}
