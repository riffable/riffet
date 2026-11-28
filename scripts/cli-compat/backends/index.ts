import { BUILTIN_CLI_BACKENDS, type BuiltinCliBackendId } from '../manifest.js';
import {
  BUILTIN_BACKEND_SPECS,
  createExternalPluginBackendSpec,
  type BackendCompatSpec,
  type BackendProtocol,
  type BackendToolArgProfile,
  type BackendToolMap,
  type BuildProfileInput,
  type BuiltProfileSpec,
  type ExternalPluginBackendOptions,
} from './adapters.js';

export {
  BUILTIN_BACKEND_SPECS,
  createExternalPluginBackendSpec,
  type BackendCompatSpec,
  type BackendProtocol,
  type BackendToolArgProfile,
  type BackendToolMap,
  type BuildProfileInput,
  type BuiltProfileSpec,
  type ExternalPluginBackendOptions,
};

export function isBuiltinBackendId(id: string): id is BuiltinCliBackendId {
  return (BUILTIN_CLI_BACKENDS as readonly string[]).includes(id);
}

export function listBackendCompatSpecs(): BackendCompatSpec[] {
  return BUILTIN_CLI_BACKENDS.map(id => BUILTIN_BACKEND_SPECS[id]);
}

export function getBackendCompatSpec(
  backendId: string,
  externalOptions?: ExternalPluginBackendOptions,
): BackendCompatSpec {
  if (isBuiltinBackendId(backendId) && !externalOptions?.pluginDir) {
    return BUILTIN_BACKEND_SPECS[backendId];
  }
  if (externalOptions?.pluginDir) {
    return createExternalPluginBackendSpec(backendId, externalOptions);
  }
  throw new Error(
    `Unknown CLI backend "${backendId}". Pass one of [${BUILTIN_CLI_BACKENDS.join(', ')}] or provide --plugin-dir <path> for an external plugin.`,
  );
}
