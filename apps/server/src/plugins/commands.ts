import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { CommandHandler } from '@riffet/plugin-api';
import type { LocalizedText, PluginCommandResult, Project, Session, Task, TaskParams } from '../../../../packages/contracts/src/index.js';
import { AppError, requireString } from '../errors.js';
import { requireProjectVisibleToClient, requireSessionVisibleToClient } from '../native/client-features.js';
import type { RouteDeps } from '../routes/deps.js';
import { readParams, resolveParams } from '../tasks/service.js';
import type { PluginRegistry } from './registry.js';

// Plugin commands (docs/design/plugin-system.md §4.3). A command is declared in a manifest, run by its id
// with a context the server has checked, and answers one of three results. What the client shows or hides
// is advice (`when`); every check that matters is made again here.

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** How long the same request id with the same body returns the same result. */
const IDEMPOTENCY_MS = 10 * 60_000;
/** A command that has not answered by then is reported as failed and its signal aborts. An installed package's own call limit (60 s) comes first. */
const COMMAND_TIMEOUT_MS = 65_000;
const MAX_REMEMBERED = 500;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const describe = (error: unknown): string => (error instanceof Error && error.message ? error.message : String(error));

export interface CommandServiceOptions {
  registry: Pick<PluginRegistry, 'command'> & Partial<Pick<PluginRegistry, 'ensureContribution'>>;
  /** Throw 404 for an unknown id. */
  project(id: string): Project;
  session(id: string): Session;
  /** The project types the task providers recognise in a project: what a command's `when.projectType` is judged against. */
  projectTypes(projectId: string): Promise<readonly string[]>;
  /** A task, to confirm that the one a command names exists and belongs to the plugin. */
  task(id: string): Promise<Pick<Task, 'pluginId'>>;
  idempotencyMs?: number;
  timeoutMs?: number;
}

interface Remembered { fingerprint: string; at: number; result: Promise<PluginCommandResult> }

export class CommandService {
  private readonly remembered = new Map<string, Remembered>();

  constructor(private readonly options: CommandServiceOptions) {}

  /**
   * Runs `<pluginId>/<name>` for a request, checking in order: the plugin is on and offers the command (404 `COMMAND_NOT_FOUND`,
   * 409 `COMMAND_UNAVAILABLE`), the scope's project or session exists and is visible to the caller, `when` still holds, and the
   * arguments fit `params` (400 `COMMAND_ARGS_INVALID`). The same request id with the same body within ten minutes returns the same
   * result without running the handler again; with another body it is refused (409 `COMMAND_REQUEST_CONFLICT`).
   */
  async run(pluginId: string, name: string, body: unknown, headers: IncomingHttpHeaders | undefined): Promise<PluginCommandResult> {
    const commandId = `${pluginId}/${name}`;
    await this.options.registry.ensureContribution?.('command', commandId).catch(() => undefined);
    const { declaration, handler, signal } = this.options.registry.command(pluginId, commandId);
    const unavailable = (reason: string) => new AppError('COMMAND_UNAVAILABLE', `${commandId} is unavailable: ${reason}`, 409, { reason });

    if (!isRecord(body)) throw new AppError('INVALID_INPUT', 'Expected an object');
    const requestId = requireString(body.requestId, 'requestId', 128);
    if (!REQUEST_ID.test(requestId)) throw new AppError('INVALID_INPUT', 'requestId may hold letters, digits and . _ : - only');
    const id = (value: unknown, field: string): string | undefined => value === undefined ? undefined : requireString(value, field, 200);
    let projectId = id(body.projectId, 'projectId');
    const sessionId = id(body.sessionId, 'sessionId');
    const invalid = (message: string) => new AppError('COMMAND_ARGS_INVALID', message);
    const given = readParams(body.args, invalid, 'args');
    const confirm = body.confirm === undefined ? undefined : requireString(body.confirm, 'confirm', 128);

    // Scope: the context the command needs exists, is visible to this caller, and is one: a session of that project.
    let session: Session | undefined;
    if (sessionId) {
      session = this.options.session(sessionId);
      requireSessionVisibleToClient(headers, session, projectId => this.options.project(projectId));
      if (projectId && projectId !== session.projectId) throw new AppError('SESSION_NOT_FOUND', 'Conversation does not exist', 404);
      projectId ??= session.projectId;
    }
    let project: Project | undefined;
    if (projectId) {
      project = this.options.project(projectId);
      requireProjectVisibleToClient(headers, project);
    }
    const scope = declaration.scope ?? 'project';
    if (scope === 'project' && !project) throw unavailable('it needs a project');
    if (scope === 'session' && !session) throw unavailable('it needs a conversation');

    // `when`, judged again on the server; `capability` is a fact of the client and is not.
    const { when } = declaration;
    if (when?.hasProject && !project) throw unavailable('it needs a project');
    if (when?.hasSession && !session) throw unavailable('it needs a conversation');
    if (when?.projectType && !(project && (await this.options.projectTypes(project.id)).includes(when.projectType))) throw unavailable(`the project is not of type ${when.projectType}`);

    const args = resolveParams(declaration.params, given, invalid);

    // The same request again returns what the first one answered, running or finished.
    const key = `${commandId}\0${requestId}`;
    const fingerprint = createHash('sha256').update(JSON.stringify([project?.id ?? null, session?.id ?? null, confirm ?? null, Object.entries(given).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))])).digest('hex');
    const now = Date.now();
    this.forget(now);
    const known = this.remembered.get(key);
    if (known) {
      if (known.fingerprint !== fingerprint) throw new AppError('COMMAND_REQUEST_CONFLICT', 'This request id was already used for a different command', 409);
      return known.result;
    }
    const result = this.execute(commandId, pluginId, handler, signal, { ...(project ? { projectId: project.id } : {}), ...(session ? { sessionId: session.id } : {}), ...(confirm ? { confirm } : {}), args });
    this.remembered.set(key, { fingerprint, at: now, result });
    return result;
  }

  private forget(now: number): void {
    const ttl = this.options.idempotencyMs ?? IDEMPOTENCY_MS;
    for (const [key, item] of this.remembered) {
      if (now - item.at < ttl && this.remembered.size < MAX_REMEMBERED) break;
      this.remembered.delete(key);
    }
  }

  private async execute(
    commandId: string, pluginId: string, handler: CommandHandler, activation: AbortSignal, context: { projectId?: string; sessionId?: string; confirm?: string; args: TaskParams },
  ): Promise<PluginCommandResult> {
    const controller = new AbortController();
    const stop = () => controller.abort();
    activation.addEventListener('abort', stop, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const ms = this.options.timeoutMs ?? COMMAND_TIMEOUT_MS;
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(() => handler.run({ ...context, signal: controller.signal })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`did not finish within ${ms / 1000}s`)); }, ms); timer.unref(); }),
      ]);
      return await this.checked(commandId, pluginId, context.projectId, outcome);
    } catch (error) {
      if (error instanceof AppError) throw error;
      const message = `${commandId} failed: ${describe(error)}`;
      throw new AppError('COMMAND_FAILED', message, 502, undefined, { message });
    } finally {
      clearTimeout(timer);
      activation.removeEventListener('abort', stop);
    }
  }

  /** The result as the client is told it: only the members this version knows, each checked. Code that is not ours does not get to hand the client anything else. */
  private async checked(commandId: string, pluginId: string, projectId: string | undefined, outcome: unknown): Promise<PluginCommandResult> {
    const fail = (why: string) => new AppError('COMMAND_FAILED', `${commandId} returned an invalid result: ${why}`, 502, undefined, { message: `${commandId} returned an invalid result: ${why}` });
    if (!isRecord(outcome)) throw fail('not an object');
    const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
    if (outcome.kind === 'done') {
      if (outcome.message === undefined) return { kind: 'done' };
      const entries = isRecord(outcome.message) ? Object.entries(outcome.message) : [];
      if (!entries.length || entries.length > 16 || entries.some(([tag, line]) => tag.length > 32 || !text(line, 400))) throw fail('message must map language tags to text');
      return { kind: 'done', message: Object.fromEntries(entries) as LocalizedText };
    }
    if (outcome.kind === 'open') {
      const { view, sessionId, path } = outcome;
      if (view === undefined && sessionId === undefined && path === undefined) throw fail('open names nothing to open');
      if ((view !== undefined && !text(view, 130)) || (sessionId !== undefined && !text(sessionId, 200))) throw fail('view and sessionId must be text');
      if (path !== undefined && (!text(path, 1024) || path.startsWith('/') || /[\\\0]/.test(path) || path.split('/').some(part => part === '..' || part === ''))) throw fail('path must be project-relative');
      if (path !== undefined && !projectId) throw fail('a path needs a project');
      return { kind: 'open', ...(view !== undefined ? { view } : {}), ...(sessionId !== undefined ? { sessionId } : {}), ...(path !== undefined ? { path } : {}) };
    }
    if (outcome.kind === 'task') {
      if (!text(outcome.taskId, 200)) throw fail('taskId must be text');
      const task = await this.options.task(outcome.taskId).catch(() => undefined);
      if (!task || task.pluginId !== pluginId) throw fail('taskId is not a task of this plugin');
      return { kind: 'task', taskId: outcome.taskId };
    }
    throw fail('kind must be done, open or task');
  }
}

/** `POST /api/integrations/:id/commands/:name` (design §4.3). */
export function registerCommandRoutes(app: FastifyInstance, deps: Pick<RouteDeps, 'plugins' | 'tasks' | 'store'>): void {
  const { plugins, tasks, store } = deps;
  const commands = new CommandService({
    registry: plugins,
    project: id => store.getProject(id),
    session: id => store.getSession(id),
    projectTypes: async projectId => (await tasks.actions(projectId)).projectTypes,
    task: id => tasks.get(id),
  });
  app.post<{ Params: { id: string; name: string }; Body: unknown }>('/api/integrations/:id/commands/:name', { bodyLimit: 16 * 1024 },
    async request => commands.run(request.params.id, request.params.name, request.body, request.headers));
}
