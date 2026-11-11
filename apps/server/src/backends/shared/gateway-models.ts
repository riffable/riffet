// Model discovery for user-supplied gateways.
//
// A profile that points a CLI at a custom endpoint cannot rely on that CLI's built-in catalog:
// Claude only knows its own aliases, and a gateway fronting other vendors reports ids neither
// side has heard of. Every OpenAI- and Anthropic-compatible gateway exposes `GET /v1/models`
// with the same `{ data: [{ id }] }` envelope, so one fetcher covers all of them.

import type { ModelInfo } from '../../../../../packages/contracts/src/index.js';

/**
 * Listing is read off the send path and cached by its callers, so it can afford to wait: some
 * gateways take 15s to list their models, and giving up sooner left them with no catalog at all.
 */
const GATEWAY_MODELS_TIMEOUT_MS = 30_000;
/** A catalog is a list of ids; an address chosen by an installed package must not fill the server's memory for a whole timeout. */
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

async function catalogJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return response.json();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CATALOG_BYTES) { await reader.cancel().catch(() => undefined); throw new Error('Model catalog response is too large'); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** `anthropic` sends `x-api-key`; every other gateway family expects `Authorization: Bearer`. */
export type GatewayAuth = 'bearer' | 'anthropic';

export interface GatewayModelsRequest {
  baseUrl: string;
  apiKey?: string;
  auth?: GatewayAuth;
  /** Retry a rejected credential header once using this scheme; the key and endpoint stay the same. */
  fallbackAuth?: GatewayAuth;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Expose the gateway's own declared reasoning ladder as an `effort` config option.
   *
   * Off by default because not every caller can consume it: Claude and Codex catalogs share this
   * fetcher, and their pickers derive parameters with conventions of their own (the `effort` slot
   * of a Claude model string, Cursor's variant ids). Only a backend whose model string can carry
   * an `[effort=…]` suffix should opt in, so no other catalog changes shape silently.
   */
  reasoningLevels?: boolean;
  /**
   * The listing path, when the gateway does not serve it at the conventional one — some answer
   * `/models`, with a different, narrower handler at `/v1/models`.
   */
  modelsPath?: string;
  /** Extra request headers, merged after the credential ones. */
  headers?: Record<string, string>;
  /**
   * Keeps only the entries this caller can use. A gateway that serves several agents from one
   * directory (listing, say, `available_agents` per model) has to be filtered by the caller, which
   * is the only side that knows which CLI the profile drives.
   */
  select?: (entry: Record<string, unknown>) => boolean;
}

/**
 * Gateways are configured with or without the version segment, and both forms are common enough
 * that guessing wrong is the most likely cause of an empty catalog. Reuse an existing `/v1` rather
 * than producing `/v1/v1/models`.
 */
export function gatewayModelsUrl(baseUrl: string, modelsPath?: string): URL {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  if (modelsPath) {
    url.pathname = `${path}${modelsPath}`;
    return url;
  }
  url.pathname = /\/v\d+$/.test(path) ? `${path}/models` : `${path}/v1/models`;
  return url;
}

/**
 * The base URL a CLI should be pointed at, with a version segment appended unless one is already
 * there. Claude Code appends `/v1/messages` itself and so wants the root; Codex wants the segment
 * spelled out. One stored `apiEndpoint` has to serve both, so the suffix is derived here rather
 * than at each call site.
 */
export function gatewayBaseUrl(baseUrl: string, segment = '/v1'): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/v\d+$/.test(path) ? path : `${path}${segment}`;
  return url.toString().replace(/\/$/, '');
}

/** Named gateways expose Claude and their unversioned directory at this protocol root. */
export function gatewayRootUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v\d+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function modelIdOf(record: Record<string, unknown>): string | undefined {
  return [record.id, record.slug, record.model, record.name]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
}

/**
 * The catalog rows.
 *
 * A gateway may publish two parallel arrays: `data` is the directory (which ids exist, which agents
 * may use them) and `models` is the metadata (context window, reasoning ladder). Neither is
 * complete on its own, so a row from `data` is enriched with the matching row from `models`. Only
 * enrichment happens — an id that appears solely in `models` is not invented into the directory.
 */
function entries(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;
  const primary = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  const metadata = Array.isArray(record.data) && Array.isArray(record.models) ? record.models : undefined;
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of metadata ?? []) {
    if (!item || typeof item !== 'object') continue;
    const id = modelIdOf(item as Record<string, unknown>);
    if (id) byId.set(id, item as Record<string, unknown>);
  }
  const rows: unknown[] = [];
  for (const item of primary) {
    // A row may be a bare string, which `toModel` accepts and nothing can enrich.
    if (!item || typeof item !== 'object') { rows.push(item); continue; }
    const row = item as Record<string, unknown>;
    const extra = byId.get(modelIdOf(row) ?? '');
    rows.push(extra ? { ...extra, ...row } : row);
  }
  return rows;
}

/**
 * A gateway's declared reasoning ladder as an `effort` config option.
 *
 * The ladder is the authority on what the model really accepts — a CLI's built-in one is a generic
 * guess for ids the CLI does not catalog. Gateways spell it either as bare strings or as
 * `{effort, description}` objects, and both are common enough that reading only the first form
 * silently drops the whole ladder.
 */
export function effortOption(levels: readonly string[], declaredDefault?: string): ModelInfo['configOptions'][number] | undefined {
  const unique = [...new Set(levels.filter(level => typeof level === 'string' && level.trim()).map(level => level.trim()))];
  if (!unique.length) return undefined;
  const currentValue = declaredDefault && unique.includes(declaredDefault) ? declaredDefault : unique[0]!;
  return {
    id: 'effort', name: 'Reasoning effort', category: 'thought_level', type: 'select',
    currentValue,
    options: unique.map(level => ({ value: level, name: level })),
  };
}

function reasoningLevelOption(record: Record<string, unknown>): ModelInfo['configOptions'][number] | undefined {
  const declared = record.supported_reasoning_levels;
  if (!Array.isArray(declared)) return undefined;
  const levels: string[] = [];
  for (const level of declared) {
    const value = typeof level === 'string' ? level : level && typeof level === 'object' ? (level as Record<string, unknown>).effort : undefined;
    if (typeof value === 'string' && value.trim() && !levels.includes(value.trim())) levels.push(value.trim());
  }
  const declaredDefault = typeof record.default_reasoning_level === 'string' ? record.default_reasoning_level.trim() : undefined;
  return effortOption(levels, declaredDefault);
}

function toModel(entry: unknown, reasoningLevels: boolean): ModelInfo | undefined {
  if (typeof entry === 'string') return entry.trim() ? { value: entry, name: entry, configOptions: [] } : undefined;
  if (!entry || typeof entry !== 'object') return undefined;
  const record = entry as Record<string, unknown>;
  const value = modelIdOf(record);
  if (!value) return undefined;
  const label = [record.display_name, record.displayName, record.name].find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
  const option = reasoningLevels ? reasoningLevelOption(record) : undefined;
  const runtime = record.runtime && typeof record.runtime === 'object' && !Array.isArray(record.runtime)
    ? record.runtime as Record<string, unknown> : undefined;
  // Some gateways nest the window instead of publishing a top-level field; vela-served
  // catalogs (OpenDesign) declare it as `metadata.context_limit`.
  const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown> : undefined;
  const contextWindow = [runtime?.max_input_tokens, record.max_input_tokens, record.context_window, record.contextWindow, record.context_length, record.inputTokenLimit, metadata?.context_limit]
    .find((limit): limit is number => typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0);
  return { value, name: label ?? value, configOptions: option ? [option] : [], ...(contextWindow !== undefined ? { contextWindow } : {}) };
}

/**
 * Throws on an unreachable or rejecting gateway so callers can surface the reason; an endpoint
 * that answers with no usable entries yields an empty list rather than an error.
 */
export async function fetchGatewayModels({ baseUrl, apiKey, auth = 'bearer', fallbackAuth, timeoutMs = GATEWAY_MODELS_TIMEOUT_MS, signal, reasoningLevels = false, modelsPath, headers: extraHeaders, select }: GatewayModelsRequest): Promise<ModelInfo[]> {
  const url = gatewayModelsUrl(baseUrl, modelsPath);
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const request = async (scheme: GatewayAuth) => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiKey) {
      if (scheme === 'anthropic') {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers.authorization = `Bearer ${apiKey}`;
      }
    }
    Object.assign(headers, extraHeaders ?? {});
    let target = url;
    for (let redirects = 0; ; redirects++) {
      // fetch only strips standard Authorization on cross-origin redirects, not x-api-key or
      // x-goog-api-key. Keep every credential within this configured provider's origin.
      const response = await fetch(target, { headers, signal: requestSignal, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      await response.body?.cancel();
      const destination = new URL(location, target);
      if (destination.origin !== url.origin) throw new Error('Model catalog redirected to a different origin');
      if (redirects >= 5) throw new Error('Model catalog exceeded the redirect limit');
      target = destination;
    }
  };
  let response = await request(auth);
  if (response.status === 401 && apiKey && fallbackAuth && fallbackAuth !== auth &&
      (!response.redirected || new URL(response.url).origin === url.origin)) {
    await response.body?.cancel();
    response = await request(fallbackAuth);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${url.origin}${url.pathname} responded ${response.status}`);
  }
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const entry of entries(await catalogJson(response))) {
    // A predicate filters on a row's metadata, which a bare-string row does not have.
    if (select && entry && typeof entry === 'object' && !select(entry as Record<string, unknown>)) continue;
    const model = toModel(entry, reasoningLevels);
    if (model && !seen.has(model.value)) {
      seen.add(model.value);
      models.push(model);
    }
  }
  return models;
}
