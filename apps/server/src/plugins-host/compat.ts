import { PLUGIN_API_VERSION, type PluginManifest } from '@riffet/plugin-api';
import { AGENT_PROTOCOL_VERSION } from '@riffet/plugin-api/experimental/agent';
import { PLUGIN_WEB_API_VERSION, type PluginCompatibility } from '../../../../packages/contracts/src/index.js';
import { satisfies } from './semver.js';

/** Isolated model providers cannot occupy the historical identities that carry saved profile keys. */
export function installedModelSourceProblem(pluginId: string, id: string): string | undefined {
  return id.length > 64 || !id.startsWith(`${pluginId}.`) || !/^[a-z0-9][a-z0-9-]*$/.test(id.slice(pluginId.length + 1))
    ? `model source "${id.slice(0, 80)}" must be named ${pluginId}.<name> (lowercase letters, digits and hyphens, at most 64 characters in all)` : undefined;
}

/** What the package asked for, sorted and without repeats: the set the user grants. */
export function requestedCapabilities(manifest: PluginManifest): string[] {
  return [...new Set(manifest.capabilities ?? [])].sort();
}

/** Per entry, whether this host satisfies the package's `hostApi`; absent when the package states no requirement. */
export function compatibility(manifest: PluginManifest): PluginCompatibility | undefined {
  const { server, web } = manifest.hostApi ?? {};
  if (server === undefined && web === undefined) return undefined;
  return {
    ...(server !== undefined ? { server: { range: server, ok: satisfies(PLUGIN_API_VERSION, server) } } : {}),
    ...(web !== undefined ? { web: { range: web, ok: satisfies(PLUGIN_WEB_API_VERSION, web) } } : {}),
  };
}

/** Why this host cannot run the package's server entry, if it cannot. */
export function serverIncompatibility(manifest: PluginManifest): string | undefined {
  const { server, agent } = manifest.hostApi ?? {};
  if (server !== undefined && !satisfies(PLUGIN_API_VERSION, server)) return `needs integration API ${server}; this Riffet provides ${PLUGIN_API_VERSION}`;
  if (agent !== undefined && !satisfies(AGENT_PROTOCOL_VERSION, agent)) return `needs agent protocol ${agent}; this Riffet provides ${AGENT_PROTOCOL_VERSION}`;
  return undefined;
}

/** Package paths the declarations point at (icons and appearance assets), which must exist inside the package. */
export function referencedFiles(manifest: PluginManifest): string[] {
  const { views, agentBackends, appearance } = manifest.contributes ?? {};
  return [
    ...[...(views ?? []), ...(agentBackends ?? [])].flatMap(item => item.icon?.svg ? [item.icon.svg] : []),
    ...(appearance?.palettes ?? []).map(item => item.asset),
    ...(appearance?.backgrounds ?? []).map(item => item.asset),
    ...(appearance?.fonts ?? []).flatMap(item => item.files.map(file => file.path)),
  ];
}
