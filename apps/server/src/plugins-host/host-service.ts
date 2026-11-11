import { randomBytes } from 'node:crypto';
import type { GatewayModelsRequest, PluginHost, ProjectContext } from '@riffet/plugin-api';
import { AppError } from '../errors.js';
import type { ProjectCall } from '../../../../packages/plugin-api/src/runtime/protocol.js';

const MAX_READ_BYTES = 1024 * 1024;
const MAX_PATH = 1024;
const MAX_HEADERS = 32;
/** Catalog reads the server makes for one package at once: each buffers a response of up to 16 MB. */
const MAX_FETCHES = 4;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const denied = (capability: string) => new AppError('PLUGIN_CAPABILITY_DENIED', `This package was not granted ${capability}`, 403);

/** Only fields the proxy host forwards, each checked: the package's request is data, not an object of the server's. */
function gatewayRequest(value: unknown): GatewayModelsRequest {
  if (!isRecord(value)) throw new AppError('INVALID_INPUT', 'request must be an object');
  const { baseUrl, apiKey, auth, timeoutMs, reasoningLevels, modelsPath, headers } = value;
  let url: URL | undefined;
  if (typeof baseUrl === 'string' && baseUrl.length <= 2048) try { url = new URL(baseUrl); } catch { /* rejected below */ }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new AppError('INVALID_INPUT', 'baseUrl must be an http or https address');
  if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > 64 * 1024)) throw new AppError('INVALID_INPUT', 'apiKey must be text');
  if (auth !== undefined && auth !== 'bearer' && auth !== 'anthropic') throw new AppError('INVALID_INPUT', 'auth must be bearer or anthropic');
  if (modelsPath !== undefined && (typeof modelsPath !== 'string' || !modelsPath.startsWith('/') || modelsPath.length > 256)) throw new AppError('INVALID_INPUT', 'modelsPath must be a path');
  let sent: Record<string, string> | undefined;
  if (headers !== undefined) {
    if (!isRecord(headers) || Object.keys(headers).length > MAX_HEADERS || Object.values(headers).some(item => typeof item !== 'string' || item.length > 4096)) throw new AppError('INVALID_INPUT', 'headers must map names to text');
    sent = headers as Record<string, string>;
  }
  return {
    baseUrl,
    ...(apiKey !== undefined ? { apiKey: apiKey as string } : {}),
    ...(auth ? { auth } : {}),
    ...(typeof timeoutMs === 'number' && timeoutMs > 0 ? { timeoutMs: Math.min(timeoutMs, 60_000) } : {}),
    ...(reasoningLevels === true ? { reasoningLevels: true } : {}),
    ...(modelsPath ? { modelsPath: modelsPath as string } : {}),
    ...(sent ? { headers: sent } : {}),
  } as GatewayModelsRequest;
}

/**
 * What an installed package may ask of the server. Every request is checked against the capabilities
 * granted for the version that runs, and a project is reachable only through a handle the server
 * issued for the call being served: the package never learns a path, and a handle from another
 * plugin, another call or a finished call is refused.
 */
export class HostService {
  private readonly handles = new Map<string, ProjectContext>();
  private fetching = 0;

  constructor(private readonly host: PluginHost, private readonly granted: ReadonlySet<string>) {}

  has(capability: string): boolean { return this.granted.has(capability); }
  need(capability: string): void { if (!this.granted.has(capability)) throw denied(capability); }

  /** Serves `run` with a handle for `project`, valid until it settles. */
  async withProject<T>(project: ProjectContext, run: (call: ProjectCall) => Promise<T>): Promise<T> {
    const handle = randomBytes(16).toString('hex');
    this.handles.set(handle, project);
    try { return await run({ handle, id: project.id, name: project.name }); }
    finally { this.handles.delete(handle); }
  }

  private project(params: Record<string, unknown>): { project: ProjectContext; path: string } {
    const project = typeof params.handle === 'string' ? this.handles.get(params.handle) : undefined;
    if (!project) throw new AppError('PLUGIN_HANDLE_INVALID', 'That project handle is not valid', 403);
    const path = params.path;
    if (typeof path !== 'string' || path.length > MAX_PATH) throw new AppError('INVALID_INPUT', 'path must be text');
    return { project, path };
  }

  async serve(method: string, raw: unknown): Promise<unknown> {
    const params = isRecord(raw) ? raw : {};
    switch (method) {
      case 'host.secrets.set': {
        const { name, value } = params;
        if (typeof name !== 'string' || (value !== null && typeof value !== 'string')) throw new AppError('INVALID_INPUT', 'name and value must be text');
        await this.host.secrets.set(name, value as string | null);
        return null;
      }
      case 'host.invalidateModelCatalogs':
        this.need('models.provide');
        this.host.invalidateModelCatalogs();
        return null;
      case 'host.gateway.fetchModels': {
        this.need('network');
        const request = gatewayRequest(params.request);
        if (this.fetching >= MAX_FETCHES) throw new AppError('PLUGIN_HOST_BUSY', 'Too many model catalog requests at once', 429);
        this.fetching++;
        try { return await this.host.gateway.fetchModels(request); } finally { this.fetching--; }
      }
      case 'project.exists': { this.need('projects.read'); const { project, path } = this.project(params); return project.exists(path); }
      case 'project.readText': {
        this.need('projects.read');
        const { project, path } = this.project(params);
        const maxBytes = typeof params.maxBytes === 'number' && params.maxBytes > 0 ? Math.min(Math.floor(params.maxBytes), MAX_READ_BYTES) : MAX_READ_BYTES;
        return (await project.readText(path, maxBytes)) ?? null;
      }
      case 'project.list': { this.need('projects.read'); const { project, path } = this.project(params); return project.list(path); }
      default: throw new AppError('PLUGIN_UNKNOWN_HOST_CALL', `Unknown host call ${method.slice(0, 64)}`, 404);
    }
  }
}
