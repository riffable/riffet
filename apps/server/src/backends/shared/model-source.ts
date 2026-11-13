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

/**
 * Where sources come from: the app's plugin registry, consulted on every lookup so a source
 * follows its plugin being turned on or off. Until this is called no source resolves.
 */
export function provideModelSources(lookup: () => readonly ModelSourceProvider[], ensure?: (source: string) => Promise<void>): void {
  providers = lookup;
  activate = ensure ?? (async () => undefined);
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

/** The saved source name, whether or not anything provides it on this server. */
export function modelSourceOf(config: Record<string, unknown>): NativeModelSource | undefined {
  return typeof config.modelSource === 'string' && config.modelSource ? config.modelSource : undefined;
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
  // `catalog` still takes the older per-CLI name, which only the two built-in protocols have.
  const backend = protocol && protocolBackend(protocol);
  if (!backend) throw new Error(`${provider.label} 不支持这个 CLI`);
  const overrides = overridesOf(config);
  return await provider.catalog(backend, overrides);
}

/** Quota belongs to the selected source's credentials, independently of the CLI's own login. */
export async function sourceUsage(source: NativeModelSource, config: Record<string, unknown>): Promise<NativeBackendUsage | undefined> {
  await prepareSource({ ...config, modelSource: source });
  const provider = modelSourceProvider(source);
  if (!provider) throw new Error(unavailable(source));
  return await provider.usage?.(overridesOf(config));
}
