// Model sources and Agents meet at a gateway protocol (docs/design/plugin-system.md §5.1): a source
// serves some, an Agent consumes some, and a source is offered to every Agent that shares one, with no
// Agent id involved. `ModelSourceBackend` and `ResolvedSource`'s per-backend members are the older
// names for the two built-in protocols; this file is the one place they are mapped.

import type { GatewayProtocol, ModelSourceBackend, ModelSourceProvider, ResolvedSource, SourceEndpoint } from '../index.js';

const BACKEND_PROTOCOL: Readonly<Record<ModelSourceBackend, GatewayProtocol>> = { claude: 'anthropic-messages', codex: 'openai-responses' };
const BACKENDS = Object.keys(BACKEND_PROTOCOL) as ModelSourceBackend[];

/** The older backend name a protocol goes by, for `ModelSourceProvider.catalog`, which still takes one. */
export function protocolBackend(protocol: GatewayProtocol): ModelSourceBackend | undefined {
  return BACKENDS.find(backend => BACKEND_PROTOCOL[backend] === protocol);
}

/** The protocols a provider serves: `protocols`, else what its `backends` stand for. */
export function sourceProtocols(provider: Pick<ModelSourceProvider, 'protocols' | 'backends'>): GatewayProtocol[] {
  const declared = provider.protocols ?? (provider.backends ?? []).flatMap(backend => Object.hasOwn(BACKEND_PROTOCOL, backend) ? [BACKEND_PROTOCOL[backend]] : []);
  return [...new Set(declared)];
}

/** The older `backends` list for protocols, for clients that match by backend. */
export function protocolBackends(protocols: readonly GatewayProtocol[]): ModelSourceBackend[] {
  return BACKENDS.filter(backend => protocols.includes(BACKEND_PROTOCOL[backend]));
}

/**
 * Where a resolved source is reached over one protocol: its `endpoints` entry, else the older per-backend
 * members. A driver reads its address and headers only through this.
 */
export function sourceEndpoint(resolved: ResolvedSource | undefined, protocol: GatewayProtocol): SourceEndpoint | undefined {
  const own = resolved?.endpoints?.[protocol];
  const backend = protocolBackend(protocol);
  const baseUrl = own?.baseUrl ?? (backend === 'claude' ? resolved?.claudeBaseUrl : backend === 'codex' ? resolved?.codexBaseUrl : undefined);
  if (baseUrl === undefined) return undefined;
  const headers = own?.headers ?? (backend ? resolved?.headers?.[backend] : undefined);
  return { baseUrl, ...(headers ? { headers } : {}) };
}
