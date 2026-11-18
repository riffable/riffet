import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { CommandHandler } from '@riffet/plugin-api';
import { PLUGIN_COMMAND_BUDGET, type CommandMessage, type CommandSelection, type LocalizedText, type PluginCommandResult, type Project, type Session, type Task, type TaskParams } from '../../../../packages/contracts/src/index.js';
import { AppError, requireString } from '../errors.js';
import { requireProjectVisibleToClient, requireSessionVisibleToClient } from '../native/client-features.js';
import type { RouteDeps } from '../routes/deps.js';
import { readParams, resolveParams } from '../tasks/service.js';
import type { PluginRegistry } from './registry.js';

// Plugin commands (docs/design/plugin-system.md §4.3). A command is declared in a manifest, run by its id
// with a context the server has checked, and answers one of three results. What the client shows or hides
// is advice (`when`); every check that matters is made again here.

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const RUN_ID = /^[A-Za-z0-9._:-]{1,200}$/;
/** A message of the longest allowed length, in the widest UTF-8, with room for the rest of the body. */
const BODY_LIMIT = PLUGIN_COMMAND_BUDGET.messageChars * 4 + 16 * 1024;
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

interface Remembered { fingerprint: string; at: number; result: Promise<PluginCommandResult>; cancel?: () => void; waiters: number }

export class CommandService {
  private readonly remembered = new Map<string, Remembered>();

  constructor(private readonly options: CommandServiceOptions) {}

  /**
   * Runs `<pluginId>/<name>` for a request, checking in order: the plugin is on and offers the command (404 `COMMAND_NOT_FOUND`,
   * 409 `COMMAND_UNAVAILABLE`), the scope's project or session exists and is visible to the caller, `when` still holds, and the
   * arguments fit `params` (400 `COMMAND_ARGS_INVALID`). The same request id with the same body within ten minutes returns the same
   * result without running the handler again; with another body it is refused (409 `COMMAND_REQUEST_CONFLICT`).
   */
  async run(pluginId: string, name: string, body: unknown, headers: IncomingHttpHeaders | undefined, requestSignal?: AbortSignal): Promise<PluginCommandResult> {
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
    const locale = body.locale == null ? undefined : requireString(body.locale, 'locale', 35);
    if (locale !== undefined && !LOCALE.test(locale)) throw new AppError('INVALID_INPUT', 'locale must be a BCP-47 language tag');
    // The menus' context: a command listed in one needs what it lists, any other is refused both. A null is no value, as some clients write an absent field.
    const inMessageMenu = declaration.menus?.includes('message') ?? false;
    const inSelectionMenu = declaration.menus?.includes('selection') ?? false;
    if (body.message != null && body.selection != null) throw invalid('send message or selection, not both');
    if (body.message != null && !inMessageMenu) throw invalid(`${commandId} does not take a message`);
    if (body.selection != null && !inSelectionMenu) throw invalid(`${commandId} does not take a selection`);
    if ((inMessageMenu || inSelectionMenu) && body.message == null && body.selection == null) {
      throw invalid(`${commandId} runs on ${inMessageMenu && inSelectionMenu ? 'a message or a selection: send message or selection' : inMessageMenu ? 'a message: send message' : 'a selection: send selection'}`);
    }
    const message = body.message == null ? undefined : readMessage(body.message, invalid);
    const selection = body.selection == null ? undefined : readSelection(body.selection, invalid);

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
    const fingerprint = createHash('sha256').update(JSON.stringify([project?.id ?? null, session?.id ?? null, confirm ?? null, Object.entries(given).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), message ?? null, selection ?? null, locale ?? null])).digest('hex');
    const now = Date.now();
    this.forget(now);
    const known = this.remembered.get(key);
    if (known) {
      if (known.fingerprint !== fingerprint) throw new AppError('COMMAND_REQUEST_CONFLICT', 'This request id was already used for a different command', 409);
      return this.awaitRemembered(key, known, requestSignal);
    }
    const callerAbort = new AbortController();
    const result = this.execute(commandId, pluginId, handler, (message || selection) ? AbortSignal.any([signal, callerAbort.signal]) : signal, { ...(project ? { projectId: project.id } : {}), ...(session ? { sessionId: session.id } : {}), ...(confirm ? { confirm } : {}), ...(message ? { message } : {}), ...(selection ? { selection } : {}), ...(locale ? { locale } : {}), args });
    const entry: Remembered = {
      fingerprint,
      at: now,
      result,
      ...(message || selection ? { cancel: () => { if (this.remembered.get(key) === entry) this.remembered.delete(key); callerAbort.abort(); } } : {}),
      waiters: 0,
    };
    this.remembered.set(key, entry);
    // A result on a message or selection can be long and the client keeps it: a repeat while it runs shares the run, a later one runs again.
    if (message || selection) void result.then(() => undefined, () => undefined).then(() => { if (this.remembered.get(key) === entry) this.remembered.delete(key); });
    return this.awaitRemembered(key, entry, requestSignal);
  }

  private awaitRemembered(_key: string, entry: Remembered, requestSignal?: AbortSignal): Promise<PluginCommandResult> {
    if (!requestSignal || !entry.cancel) return entry.result;
    if (requestSignal.aborted) {
      if (entry.waiters <= 0) entry.cancel();
      return Promise.reject(requestSignal.reason ?? new Error('aborted'));
    }
    entry.waiters += 1;
    return new Promise<PluginCommandResult>((resolve, reject) => {
      const onAbort = () => {
        entry.waiters -= 1;
        if (entry.waiters <= 0) entry.cancel?.();
        reject(requestSignal.reason ?? new Error('aborted'));
      };
      requestSignal.addEventListener('abort', onAbort, { once: true });
      entry.result.then(
        value => { requestSignal.removeEventListener('abort', onAbort); entry.waiters = Math.max(0, entry.waiters - 1); resolve(value); },
        error => { requestSignal.removeEventListener('abort', onAbort); entry.waiters = Math.max(0, entry.waiters - 1); reject(error); },
      );
    });
  }

  private forget(now: number): void {
    const ttl = this.options.idempotencyMs ?? IDEMPOTENCY_MS;
    for (const [key, item] of this.remembered) {
      if (now - item.at < ttl && this.remembered.size < MAX_REMEMBERED) break;
      this.remembered.delete(key);
    }
  }

  private async execute(
    commandId: string, pluginId: string, handler: CommandHandler, activation: AbortSignal, context: { projectId?: string; sessionId?: string; confirm?: string; message?: CommandMessage; selection?: CommandSelection; locale?: string; args: TaskParams },
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
      return await this.checked(commandId, pluginId, context.projectId, Boolean(context.message || context.selection), outcome);
    } catch (error) {
      if (error instanceof AppError) throw error;
      const reason = describe(error);
      throw new AppError('COMMAND_FAILED', `${commandId} failed: ${reason}`, 502, undefined, { message: reason });
    } finally {
      clearTimeout(timer);
      activation.removeEventListener('abort', stop);
    }
  }

  /** The result as the client is told it: only the members this version knows, each checked. Code that is not ours does not get to hand the client anything else. */
  private async checked(commandId: string, pluginId: string, projectId: string | undefined, onText: boolean, outcome: unknown): Promise<PluginCommandResult> {
    const fail = (why: string) => new AppError('COMMAND_FAILED', `${commandId} returned an invalid result: ${why}`, 502, undefined, { message: why });
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
    if (outcome.kind === 'text') {
      if (!onText) throw fail('text answers a command run on a message or a selection');
      if (!text(outcome.text, PLUGIN_COMMAND_BUDGET.resultChars)) throw fail(`text must be 1 to ${PLUGIN_COMMAND_BUDGET.resultChars} characters`);
      if (outcome.title === undefined) return { kind: 'text', text: outcome.text };
      const entries = isRecord(outcome.title) ? Object.entries(outcome.title) : [];
      if (!entries.length || entries.length > 16 || entries.some(([tag, line]) => tag.length > 32 || !text(line, 40))) throw fail('title must map language tags to short text');
      return { kind: 'text', text: outcome.text, title: Object.fromEntries(entries) as LocalizedText };
    }
    throw fail('kind must be done, open, task or text');
  }
}

/** The message a command is run on, as the client sent it: a role, the text within the budget, and the run when there is one. */
function readMessage(value: unknown, invalid: (message: string) => AppError): CommandMessage {
  if (!isRecord(value)) throw invalid('message must be an object');
  if (value.role !== 'assistant' && value.role !== 'user') throw invalid('message.role must be assistant or user');
  if (typeof value.text !== 'string' || !value.text.trim()) throw invalid('message.text must be text');
  if (value.text.length > PLUGIN_COMMAND_BUDGET.messageChars) throw invalid(`message.text is longer than ${PLUGIN_COMMAND_BUDGET.messageChars} characters`);
  if (value.runId !== undefined && !(typeof value.runId === 'string' && RUN_ID.test(value.runId))) throw invalid('message.runId is invalid');
  return { role: value.role, text: value.text, ...(value.runId !== undefined ? { runId: value.runId } : {}) };
}

/** The text a command is run on from the selection toolbar, as the client sent it: the text within the budget, and the run when there is one. */
function readSelection(value: unknown, invalid: (message: string) => AppError): CommandSelection {
  if (!isRecord(value)) throw invalid('selection must be an object');
  if (typeof value.text !== 'string' || !value.text.trim()) throw invalid('selection.text must be text');
  if (value.text.length > PLUGIN_COMMAND_BUDGET.messageChars) throw invalid(`selection.text is longer than ${PLUGIN_COMMAND_BUDGET.messageChars} characters`);
  if (value.runId !== undefined && !(typeof value.runId === 'string' && RUN_ID.test(value.runId))) throw invalid('selection.runId is invalid');
  return { text: value.text, ...(value.runId !== undefined ? { runId: value.runId } : {}) };
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
  app.post<{ Params: { id: string; name: string }; Body: unknown }>('/api/integrations/:id/commands/:name', { bodyLimit: BODY_LIMIT },
    async (request, reply) => {
      const controller = new AbortController();
      reply.raw.once('close', () => { if (!reply.raw.writableFinished) controller.abort(); });
      return commands.run(request.params.id, request.params.name, request.body, request.headers, controller.signal);
    });
}
