import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import type { GatewayModelsRequest, PluginHost, ProjectContext } from '@riffet/plugin-api';
import { AppError } from '../errors.js';
import { INSTALLED_ENV_VALUE_BYTES, installedEnvNameAllowed } from '../backends/shared/installed-env.js';
import { AddressRefused, type SourceAddresses } from './addresses.js';
import type { ProjectCall } from '../../../../packages/plugin-api/src/runtime/protocol.js';

const MAX_READ_BYTES = 1024 * 1024;
const MAX_PATH = 1024;
const MAX_HEADERS = 32;
const EXEC_DEFAULT_TIMEOUT_MS = 30_000;
const EXEC_MAX_TIMEOUT_MS = 120_000;
const EXEC_DEFAULT_OUTPUT = 256 * 1024;
const EXEC_MAX_OUTPUT = 1024 * 1024;
const EXEC_MAX_ARGS = 64;
const EXEC_MAX_ARG_CHARS = 8192;
const EXEC_MAX_ENV = 32;
/** Commands one package runs at once. */
const MAX_EXECS = 4;
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

  private executing = 0;

  /**
   * `exec` is what `process.exec` stands for. The named commands run outside the sandbox, as the user who runs Riffet, with the arguments
   * the package chooses: this checks consent and names, it does not contain what the command does. `roots` are the package's directory
   * and its state directory (real paths): a binary inside either is one the package shipped or wrote, and is refused.
   */
  constructor(
    private readonly host: PluginHost, private readonly granted: ReadonlySet<string>, private readonly addresses?: SourceAddresses,
    private readonly exec: { executables: readonly string[]; roots: readonly string[]; stateDir: string; modelSources: readonly string[] } = { executables: [], roots: [], stateDir: '', modelSources: [] },
  ) {}

  /** What the child's synchronous members answer from: which declared commands are installed now, and which of its model sources a saved profile names. */
  facts(): { executables: Record<string, boolean>; modelSourcesInUse: string[] } {
    const executables: Record<string, boolean> = {};
    if (this.granted.has('process.exec')) for (const name of this.exec.executables) executables[name] = this.host.resolveCli(name) !== undefined;
    return { executables, modelSourcesInUse: this.exec.modelSources.filter(id => this.host.modelSourceInUse?.(id)) };
  }

  private checkArgs(args: unknown): string[] {
    if (!Array.isArray(args) || args.length > EXEC_MAX_ARGS || args.some(item => typeof item !== 'string' || item.length > EXEC_MAX_ARG_CHARS || item.includes('\0'))) {
      throw new AppError('INVALID_INPUT', `args must be at most ${EXEC_MAX_ARGS} texts of at most ${EXEC_MAX_ARG_CHARS} characters, without NUL`);
    }
    return args as string[];
  }

  /** The absolute path of a command the package declared, or an error: not declared, not installed, or a file of the package's own. */
  private executable(command: unknown): string {
    if (typeof command !== 'string' || !this.exec.executables.includes(command)) throw new AppError('PLUGIN_EXEC_UNDECLARED', 'That command is not among the package\'s declared executables', 403);
    const resolved = this.host.resolveCli(command);
    if (!resolved) throw new AppError('PLUGIN_EXEC_NOT_FOUND', `${command} is not installed on this machine`, 404);
    let real: string;
    try { real = realpathSync(resolved); } catch { throw new AppError('PLUGIN_EXEC_NOT_FOUND', `${command} is not installed on this machine`, 404); }
    for (const root of this.exec.roots) {
      const path = relative(root, real);
      if (path === '' || (!path.startsWith('..') && !isAbsolute(path))) throw new AppError('PLUGIN_EXEC_OWN_FILE', `${command} resolves to a file of the package itself`, 403);
    }
    return resolved;
  }

  /** A `{ kind: 'command' }` credential the drivers run later, outside the sandbox: the same rules as `host.exec`. `undefined` when it is not allowed. */
  credentialCommand(command: unknown, args: unknown): { kind: 'command'; command: string; args: string[] } | undefined {
    if (!this.granted.has('process.exec')) return undefined;
    try { return { kind: 'command', command: this.executable(command), args: this.checkArgs(args ?? []) }; } catch { return undefined; }
  }

  private async execute(params: Record<string, unknown>): Promise<unknown> {
    this.need('process.exec');
    const command = params.command;
    const file = this.executable(command);
    const args = this.checkArgs(params.args ?? []);
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (params.env !== undefined) {
      if (!isRecord(params.env) || Object.keys(params.env).length > EXEC_MAX_ENV) throw new AppError('INVALID_INPUT', 'env must map names to text');
      for (const [name, value] of Object.entries(params.env)) {
        if (!installedEnvNameAllowed(name)) throw new AppError('PLUGIN_EXEC_ENV_REFUSED', `env may not set ${name}`, 403);
        if (typeof value !== 'string' || Buffer.byteLength(value) > INSTALLED_ENV_VALUE_BYTES || value.includes('\0')) throw new AppError('INVALID_INPUT', `env value of ${name} must be text of at most ${INSTALLED_ENV_VALUE_BYTES} bytes`);
        env[name] = value;
      }
    }
    const number = (value: unknown, fallback: number, max: number) => typeof value === 'number' && value > 0 && Number.isFinite(value) ? Math.min(Math.floor(value), max) : fallback;
    if (this.executing >= MAX_EXECS) throw new AppError('PLUGIN_HOST_BUSY', 'Too many commands running at once', 429);
    this.executing++;
    const started = Date.now();
    try {
      const result = await this.host.runProcess(file, args, {
        cwd: this.exec.stateDir, env,
        timeoutMs: number(params.timeoutMs, EXEC_DEFAULT_TIMEOUT_MS, EXEC_MAX_TIMEOUT_MS),
        maxOutputBytes: number(params.maxOutputBytes, EXEC_DEFAULT_OUTPUT, EXEC_MAX_OUTPUT),
      });
      // The arguments may hold secrets: the journal gets their count only.
      this.host.logger?.debug(`exec ${String(command)} (${args.length} args) ${Date.now() - started} ms exit ${result.code ?? 'none'}${result.timedOut ? ' timed out' : ''}`);
      return { code: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut, truncated: result.truncated };
    } finally { this.executing--; }
  }

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
        // The server makes this request, outside the sandbox: where it may go is checked here.
        try { this.addresses?.checkFetch(new URL(request.baseUrl)); } catch (error) {
          if (error instanceof AddressRefused) throw new AppError('PLUGIN_ADDRESS_REFUSED', error.message, 403);
          throw error;
        }
        if (this.fetching >= MAX_FETCHES) throw new AppError('PLUGIN_HOST_BUSY', 'Too many model catalog requests at once', 429);
        this.fetching++;
        try { return await this.host.gateway.fetchModels(request); } finally { this.fetching--; }
      }
      case 'host.exec': return this.execute(params);
      case 'host.tasks.start': {
        this.need('tasks.run');
        const { projectId, actionId, params: taskParams, providerId, confirm } = params;
        if (typeof projectId !== 'string' || typeof actionId !== 'string' || (providerId !== undefined && typeof providerId !== 'string') || (confirm !== undefined && typeof confirm !== 'string') || (taskParams !== undefined && !isRecord(taskParams))) {
          throw new AppError('INVALID_INPUT', 'projectId and actionId must be text');
        }
        if (!this.host.tasks) throw new AppError('PLUGIN_HOST_UNSUPPORTED', 'This plugin has no task providers to start tasks with', 501);
        return this.host.tasks.start(projectId, actionId, taskParams as never, { ...(providerId ? { providerId } : {}), ...(confirm ? { confirm } : {}) });
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
