// Shared with the independently distributed SDK, CLI and generated JSON Schema.
import { EXECUTABLE_NAME, MAX_EXECUTABLES } from '../../../../packages/plugin-api/src/manifest.js';
export { apiVersionProblem, checkManifest, loadableManifest, checkDeclarations, declaredIds, knownDeclarations, isPackagePath, hostMatchesDeclared } from '../../../../packages/plugin-api/src/manifest.js';

/** The commands a grant dialog names for `process.exec`. Reads untrusted index data too, so every member is checked. */
export function grantExecutables(manifest: { executables?: unknown } | undefined): string[] | undefined {
  const names = Array.isArray(manifest?.executables) ? manifest.executables.filter((name): name is string => typeof name === 'string' && EXECUTABLE_NAME.test(name)).slice(0, MAX_EXECUTABLES) : [];
  return names.length ? names : undefined;
}

/** The model sources a grant dialog names, each with the hosts it declares. Reads untrusted index data too, so every member is checked. */
export function grantModelSources(contributes: { modelSources?: unknown } | undefined): Array<{ id: string; hosts?: string[] }> | undefined {
  const sources = Array.isArray(contributes?.modelSources) ? contributes.modelSources : [];
  const named = sources.slice(0, 64).flatMap((item: unknown): Array<{ id: string; hosts?: string[] }> => {
    if (!item || typeof item !== 'object') return [];
    const { id, hosts } = item as { id?: unknown; hosts?: unknown };
    if (typeof id !== 'string') return [];
    const kept = Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === 'string' && host.length <= 253).slice(0, 16) : [];
    return [{ id, ...(kept.length ? { hosts: kept } : {}) }];
  });
  return named.length ? named : undefined;
}
