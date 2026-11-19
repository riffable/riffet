// Which models a profile is pointed at, and how it authenticates to them.
//
// A profile can *name* a source instead of typing an address and a key, because some credentials are
// not something a user can type: a token in another tool's cache, a JWT a CLI mints per request.
// Sources come from plugins (docs/PLUGIN_ARCHITECTURE.md); this module is the single place that turns
// a saved name plus the profile's own overrides into wire facts, so the Claude and Codex drivers read
// `ResolvedSource` and never grow a branch per source.

import { type GatewayProtocol, type ModelSourceBackend, type ModelSourceProvider, type ResolvedSource, type SourceCredential, type SourceOverrides } from '@riffet/plugin-api';
import { protocolBackend, sourceEndpoint, sourceProtocols } from '@riffet/plugin-api/kit';
import type { ModelInfo, NativeBackendUsage, NativeModelSource } from '../../../../../packages/contracts/src/index.js';

export { sourceEndpoint };
export type { ModelSourceBackend, ResolvedSource };

let providers: () => readonly ModelSourceProvider[] = () => [];
let activate: (source: string) => Promise<void> = async () => undefined;
let declaredRole: (source: string) => ModelSourceProvider['role'] = () => undefined;

/**
 * Where sources come from: the app's plugin registry, consulted on every lookup so a source
 * follows its plugin being turned on or off. Until this is called no source resolves.
 */
export function provideModelSources(lookup: () => readonly ModelSourceProvider[], ensure?: (source: string) => Promise<void>, role?: (source: string) => ModelSourceProvider['role']): void {
  providers = lookup;
  activate = ensure ?? (async () => undefined);
  declaredRole = role ?? (() => undefined);
}

/** Called from asynchronous launch/catalog boundaries before synchronous credential resolution. */
export async function prepareSource(config: Record<string, unknown>): Promise<void> {
  const source = modelSourceOf(config);
  if (!source) return;
  if (!modelSourceProvider(source)) return;
  await activate(source);
  await modelSourceProvider(source)?.prepare?.(overridesOf(config));
}

export function modelSourceProvider(source: NativeModelSource): ModelSourceProvider | undefined {
  return providers().find(provider => provider.id === source);
}

/** Static identity can outlive enablement; asking for it never activates or resolves a source. */
export function modelSourceRole(source: NativeModelSource): ModelSourceProvider['role'] {
  const provider = modelSourceProvider(source);
  return declaredRole(source) ?? provider?.role ?? (provider ? 'source' : undefined);
}

/** The saved source name, whether or not anything provides it on this server. */
export function savedModelSourceOf(config: Record<string, unknown>): NativeModelSource | undefined {
  return typeof config.modelSource === 'string' && config.modelSource ? config.modelSource : undefined;
}

/**
 * The source a launch or catalog read goes through; quota reads the saved name. An adapter only adds
 * gateway behavior to the profile's own connection, so once nothing provides it the profile is that
 * plain API connection again rather than a blocked one. An uninstalled plugin leaves no declared role behind, and the address and key
 * are the user's own either way, so an unknown role falls back too; a declared connection source never does.
 */
export function modelSourceOf(config: Record<string, unknown>): NativeModelSource | undefined {
  const source = savedModelSourceOf(config);
  if (!source || modelSourceProvider(source)) return source;
  const ownEndpoint = typeof config.apiEndpoint === 'string' && config.apiEndpoint.trim();
  return ownEndpoint && modelSourceRole(source) !== 'source' ? undefined : source;
}

function overridesOf(config: Record<string, unknown>): SourceOverrides {
  const apiEndpoint = typeof config.apiEndpoint === 'string' ? config.apiEndpoint.trim() : '';
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  return { ...(apiEndpoint ? { apiEndpoint } : {}), ...(apiKey ? { apiKey } : {}) };
}

function unavailable(source: NativeModelSource): string {
  return `模型源「${source}」当前不可用：提供它的集成未开启`;
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * Wire facts for one source. Returns a `reason` rather than throwing: a source that cannot resolve —
 * including one no enabled plugin provides — is a normal state the settings UI reports.
 */
export function resolveSource(source: NativeModelSource, config: Record<string, unknown>): ResolvedSource {
  const provider = modelSourceProvider(source);
  if (!provider) return { reason: unavailable(source) };
  // Plugin code runs inside a synchronous launch path; a throw there must not take the launch down with it.
  try { return provider.resolve(overridesOf(config)); }
  catch (error) { return { reason: `${provider.label}：${describeError(error)}` }; }
}

/**
 * What a launch talks to and authenticates with. A named source's credential already accounts for
 * the profile's own key where the source allows one; without a source, the typed key is the credential.
 */
export function launchSource(config: Record<string, unknown>): { resolved?: ResolvedSource; credential?: SourceCredential } {
  const source = modelSourceOf(config);
  if (source) {
    const resolved = resolveSource(source, config);
    return { resolved, ...(resolved.credential ? { credential: resolved.credential } : {}) };
  }
  const apiKey = typeof config.apiKey === 'string' && config.apiKey ? config.apiKey : undefined;
  return apiKey ? { credential: { kind: 'static', key: apiKey } } : {};
}

/**
 * The picker's catalog for one source, already narrowed to the tiers this backend can send. `consumes` is the
 * backend's `traits.consumesProtocols`: the source answers for the first protocol it shares with them.
 */
export async function sourceCatalog(source: NativeModelSource, consumes: readonly GatewayProtocol[], config: Record<string, unknown>): Promise<ModelInfo[]> {
  await prepareSource({ ...config, modelSource: source });
  const provider = modelSourceProvider(source);
  if (!provider) throw new Error(unavailable(source));
  const served = sourceProtocols(provider);
  const protocol = consumes.find(item => served.includes(item));
  if (!protocol) throw new Error(`${provider.label} 不支持这个 CLI`);
  // The older per-CLI name goes along for sources written before `catalog` took the protocol.
  return await provider.catalog(protocolBackend(protocol), overridesOf(config), protocol);
}

/** Quota belongs to the selected source's credentials, independently of the CLI's own login. */
export async function sourceUsage(source: NativeModelSource, config: Record<string, unknown>): Promise<NativeBackendUsage | undefined> {
  await prepareSource({ ...config, modelSource: source });
  const provider = modelSourceProvider(source);
  if (!provider) throw new Error(unavailable(source));
  return await provider.usage?.(overridesOf(config));
}
