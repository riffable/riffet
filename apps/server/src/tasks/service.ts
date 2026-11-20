import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectContext, TaskActionSpec } from '@riffet/plugin-api';
import type {
  Project, Task, TaskAction, TaskActionIcon, TaskActionPresentation, TaskActionsResponse, TaskDiagnostic, TaskEvent, TaskLogChunk, TaskLogRecords, TaskLogRule, TaskLogTone, TaskParamField, TaskParams, TaskState,
} from '../../../../packages/contracts/src/index.js';
import { AppError, requireString } from '../errors.js';
import { terminalEnvironment } from '../environment.js';
import type { OwnedTaskProvider } from '../plugins/registry.js';
import { isWithin, projectRoot } from '../workspace/scope.js';
import { checkCommand, checkGlobs, diagnosticsContext, expandArtifacts, projectContext, resolveWorkingDirectory } from './files.js';
import { identify, isAlive, processStart, readExitCode, signalExitCode, signalGroup, spawnTask } from './process.js';
import { TaskStore, isOpen, type ApprovalKey, type StoredTask } from './store.js';
import { INSTALLED_ENV_VALUE_BYTES, installedEnvNameAllowed } from '../backends/shared/installed-env.js';

const POLL_MS = 500;
/** From SIGTERM to SIGKILL. */
const KILL_GRACE_MS = 10_000;
const ACTIONS_TTL_MS = 5_000;
/** How long a provider may take to answer; code that never yields cannot be interrupted, only no longer waited for. */
const PROVIDER_TIMEOUT_MS = 10_000;
const DEFAULT_LOG_BYTES = 64 * 1024;
export const MAX_LOG_BYTES = 256 * 1024;
const DIAGNOSTICS_TAIL_BYTES = 512 * 1024;
const MAX_DIAGNOSTICS = 200;
const MAX_ACTIONS = 50;
const KEEP_FINISHED_PER_PROJECT = 100;
const KEEP_MS = 30 * 24 * 60 * 60_000;

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PARAM_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The most an installed package's plan may show the user, in characters of `file`, `args` and `env` together: what fits the confirmation without hiding a part. */
const INSTALLED_PLAN_CHARS = 8192;
/** Control, format (bidirectional overrides, zero-width) and line-separator characters: they can make the confirmed text read as something else. */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const PARAM_KINDS: readonly TaskParamField['kind'][] = ['text', 'boolean', 'choice'];
const ACTION_ICONS: readonly TaskActionIcon[] = ['run', 'build', 'test', 'inspect', 'clean', 'crash', 'screenshot', 'sync', 'log'];
const LOG_TONES: readonly TaskLogTone[] = ['muted', 'error', 'warning', 'success', 'accent'];
const MAX_LOG_RULES = 24;
const MAX_LOG_PATTERN = 200;

export interface TaskProviders {
  activateTaskProviders?(): Promise<void>;
  ensureContribution?(kind: 'task', contributionId: string): Promise<void>;
  /** The providers a new task may start under: those of enabled plugins that are not turning off. */
  taskProviders(): OwnedTaskProvider[];
  /** The provider, and only the version, that started a task, for reading its log: it is up while its plugin waits for running tasks. Without it `taskProviders` is used. */
  taskProviderFor?(pluginId: string, providerId: string, version: string): OwnedTaskProvider | undefined;
  /** Whether the plugin is turning off after its running tasks, so a refusal can say so. */
  isStopping?(pluginId: string): boolean;
}

export interface TaskServiceOptions {
  stateDir: string;
  /** The workbench database; tasks get a table of their own in it. */
  db: DatabaseSync;
  /** Throws a 404 for an unknown project. */
  project(id: string): Project;
  providers: TaskProviders;
  /** What a task runs with before the plan's own variables. Defaults to this process's, which carries the user's PATH, JAVA_HOME and ANDROID_HOME. */
  environment?(): NodeJS.ProcessEnv;
  pollMs?: number;
  killGraceMs?: number;
  actionsTtlMs?: number;
}

interface Watch {
  timer?: NodeJS.Timeout;
  child?: ChildProcess;
  /** Set when the process this server started has exited. */
  exited?: { code: number | null; signal: NodeJS.Signals | null };
  busy: boolean;
}

type Outcome = { kind: 'exit'; exitCode: number } | { kind: 'gone' } | { kind: 'other'; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const now = (): string => new Date().toISOString();

/** Provider code is not ours: its failure is a 502, and what it never answers is no longer waited for. */
async function guarded<T>(what: string, run: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no answer within ' + PROVIDER_TIMEOUT_MS / 1000 + 's')), PROVIDER_TIMEOUT_MS); timer.unref(); }),
    ]);
  } catch (error) {
    throw error instanceof AppError ? error : new AppError('TASK_PROVIDER_FAILED', `${what} failed: ${error instanceof Error ? error.message : String(error)}`, 502);
  } finally { clearTimeout(timer); }
}

const bad = (message: string): AppError => new AppError('TASK_PARAMS_INVALID', message);

/** The values a request carries, as plain data; `fail` makes the error, since a task's parameters and a command's arguments answer with their own codes. */
export function readParams(value: unknown, fail: (message: string) => Error = bad, name = 'params'): TaskParams {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > 32) throw fail(`${name} must be an object of at most 32 values`);
  for (const [key, item] of Object.entries(value)) {
    if (!PARAM_KEY.test(key) || !(typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)) || (typeof item === 'string' && item.length <= 4096))) throw fail(`${name}.${key} is invalid`);
  }
  // `fromEntries` defines an own property even for a key such as `__proto__`.
  return Object.fromEntries(Object.entries(value)) as TaskParams;
}

/** What a request carries, as the start of one task: the same request id with the same fingerprint is the same task. */
function fingerprint(projectId: string, providerId: string, actionId: string, params: TaskParams): string {
  const canonical = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify([projectId, providerId, actionId, canonical])).digest('hex');
}

/** The values the fields declare, with defaults filled in; anything else is refused before the provider plans (or the command runs). */
export function resolveParams(declared: readonly TaskParamField[] | undefined, given: TaskParams, fail: (message: string) => Error = bad): TaskParams {
  const fields = declared ?? [];
  for (const key of Object.keys(given)) if (!fields.some(field => field.key === key)) throw fail(`Unknown parameter ${key}`);
  const entries: Array<[string, string | number | boolean]> = [];
  for (const field of fields) {
    const value = Object.hasOwn(given, field.key) ? given[field.key] : field.default;
    if (value === undefined) { if (field.required) throw fail(`${field.key} is required`); continue; }
    const ok = field.kind === 'boolean' ? typeof value === 'boolean' : field.kind === 'choice' ? typeof value === 'string' && Boolean(field.options?.includes(value)) : typeof value === 'string';
    if (!ok) throw fail(`${field.key} has the wrong type or value`);
    entries.push([field.key, value]);
  }
  return Object.fromEntries(entries);
}

/** A provider's action as the host serves it; `undefined` for one that is malformed. */
function cleanSpec(raw: unknown): TaskActionSpec | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !ACTION_ID.test(raw.id) || !isRecord(raw.title) || !Object.values(raw.title).every(text => typeof text === 'string')) return undefined;
  const spec: TaskActionSpec = { id: raw.id, title: raw.title as Record<string, string> };
  if (Array.isArray(raw.params)) {
    const params: TaskParamField[] = [];
    for (const field of raw.params.slice(0, 16)) {
      if (!isRecord(field) || typeof field.key !== 'string' || !PARAM_KEY.test(field.key) || !isRecord(field.label) || !PARAM_KINDS.includes(field.kind as never)) return undefined;
      const options = Array.isArray(field.options) ? field.options.filter((option): option is string => typeof option === 'string').slice(0, 64) : undefined;
      params.push({
        key: field.key, label: field.label as Record<string, string>, kind: field.kind as TaskParamField['kind'],
        ...(options ? { options } : {}),
        ...(typeof field.default === 'string' || typeof field.default === 'boolean' || typeof field.default === 'number' ? { default: field.default } : {}),
        ...(field.required === true ? { required: true } : {}),
      });
    }
    if (params.length) spec.params = params;
  }
  return { ...spec, ...cleanPresentation(raw) };
}

const isText = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every(text => typeof text === 'string');

/** How the action is drawn; a field that does not check out is left out, and the action still works without it. */
function cleanPresentation(raw: Record<string, unknown>): TaskActionPresentation {
  const presentation: TaskActionPresentation = {};
  if (isText(raw.group)) presentation.group = raw.group;
  if (raw.primary === true) presentation.primary = true;
  if (ACTION_ICONS.includes(raw.icon as never)) presentation.icon = raw.icon as TaskActionIcon;
  if (isText(raw.confirm)) presentation.confirm = raw.confirm;
  if (isRecord(raw.log) && Array.isArray(raw.log.rules)) {
    const rules: TaskLogRule[] = [];
    for (const rule of raw.log.rules.slice(0, MAX_LOG_RULES)) {
      if (!isRecord(rule) || typeof rule.pattern !== 'string' || !rule.pattern || rule.pattern.length > MAX_LOG_PATTERN) continue;
      if (rule.flags !== undefined && rule.flags !== 'i') continue;
      // A pattern the client could not compile would be dropped there; it is dropped here instead.
      try { new RegExp(rule.pattern, rule.flags === 'i' ? 'i' : undefined); } catch { continue; }
      rules.push({
        pattern: rule.pattern,
        ...(rule.flags === 'i' ? { flags: 'i' } : {}),
        ...(LOG_TONES.includes(rule.tone as never) ? { tone: rule.tone as TaskLogTone } : {}),
        ...(rule.fold === true ? { fold: true } : {}),
      });
    }
    const records = cleanRecords(raw.log.records);
    if (rules.length || records) presentation.log = { rules, ...(records ? { records } : {}) };
  }
  return presentation;
}

const FIELD = /^[a-z][a-z0-9]{0,15}$/;
/** A records declaration whose pattern compiles and names its fields; anything else in it is dropped. */
function cleanRecords(raw: unknown): TaskLogRecords | undefined {
  if (!isRecord(raw) || typeof raw.pattern !== 'string' || !raw.pattern || raw.pattern.length > MAX_LOG_PATTERN) return undefined;
  try { new RegExp(raw.pattern); } catch { return undefined; }
  const fields = [...raw.pattern.matchAll(/\(\?<([A-Za-z][A-Za-z0-9]*)>/g)].map(match => match[1]!);
  if (!fields.length || fields.length > 12 || !fields.every(field => FIELD.test(field))) return undefined;
  const levels = Array.isArray(raw.levels) ? raw.levels.slice(0, 12).flatMap(level => isRecord(level) && typeof level.value === 'string' && level.value && level.value.length <= 16
    ? [{ value: level.value, ...(LOG_TONES.includes(level.tone as never) ? { tone: level.tone as TaskLogTone } : {}) }] : []) : [];
  const columns = Array.isArray(raw.columns) ? raw.columns.filter((column): column is string => typeof column === 'string' && fields.includes(column) && column !== 'level' && column !== 'message') : [];
  return { pattern: raw.pattern, ...(levels.length ? { levels } : {}), ...(columns.length ? { columns } : {}) };
}

function cleanDiagnostics(raw: unknown): TaskDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  const result: TaskDiagnostic[] = [];
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  for (const item of raw) {
    if (result.length >= MAX_DIAGNOSTICS) break;
    if (!isRecord(item) || (item.severity !== 'error' && item.severity !== 'warning') || typeof item.message !== 'string' || !item.message.trim()) continue;
    const diagnostic: TaskDiagnostic = { severity: item.severity, message: item.message.trim().slice(0, 2000) };
    if (typeof item.file === 'string' && item.file && item.file.length <= 1024 && !item.file.startsWith('/') && !item.file.split('/').includes('..')) {
      diagnostic.file = item.file;
      if (count(item.line)) diagnostic.line = item.line;
      if (count(item.column)) diagnostic.column = item.column;
    }
    result.push(diagnostic);
  }
  return result;
}

/** What an installed package's plan may carry: an environment that cannot hook how a program or the shell starts, and text the user can read as it is. Anything else is a plan the host will not run. */
function checkInstalledPlan(plan: { file: string; args: string[]; env: Record<string, string> }): void {
  const invalid = (message: string) => new AppError('TASK_PLAN_INVALID', message, 502);
  for (const [name, value] of Object.entries(plan.env)) {
    if (!installedEnvNameAllowed(name)) throw invalid(`The plan's env may not set ${name}`);
    if (Buffer.byteLength(value) > INSTALLED_ENV_VALUE_BYTES) throw invalid(`The plan's env value of ${name} is longer than ${INSTALLED_ENV_VALUE_BYTES} bytes`);
  }
  const shown = [plan.file, ...plan.args, ...Object.entries(plan.env).flat()];
  if (shown.some(text => UNSHOWABLE.test(text))) throw invalid('The plan\'s file, args and env may not hold control, format or line-separator characters');
  if (shown.reduce((sum, text) => sum + text.length, 0) > INSTALLED_PLAN_CHARS) throw invalid(`The plan's file, args and env are longer than ${INSTALLED_PLAN_CHARS} characters together`);
}

/**
 * The sha256 of the plan as the user is shown it (file, args, project-relative cwd, env in name order) in the project it runs
 * in: what an approval is for. The same `./gradlew` in another project is another project's file, so it asks again there.
 */
function planFingerprint(projectId: string, plan: { file: string; args: string[]; cwd: string; env: Record<string, string> }): string {
  const env = Object.entries(plan.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify({ projectId, file: plan.file, args: plan.args, cwd: plan.cwd, env })).digest('hex');
}

/**
 * Project tasks (docs/TASKS.md). A task is a process the server starts for a project, with its own
 * process group and a log it writes itself, so it outlives a client and a server restart. This
 * service owns identity and idempotency, the per-project lock, cancellation, restart recovery,
 * artifacts and diagnostics; what to run comes from a plugin's task provider and is fixed at start.
 *
 * It is not tied to the plugin that provided the task: turning that plugin off refuses new tasks and
 * stops offering actions, and a task already running carries on to its end.
 */
export class TaskService {
  private readonly store: TaskStore;
  private readonly watched = new Map<string, Watch>();
  private readonly kills = new Map<string, NodeJS.Timeout>();
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  private readonly actionsCache = new Map<string, { at: number; key: string; result: Promise<TaskActionsResponse> }>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: TaskServiceOptions) {
    this.store = new TaskStore(options.db);
  }

  private get pollMs(): number { return this.options.pollMs ?? POLL_MS; }
  private get killGraceMs(): number { return this.options.killGraceMs ?? KILL_GRACE_MS; }
  private directory(id: string): string { return join(this.options.stateDir, 'tasks', id); }
  private logPath(id: string): string { return join(this.directory(id), 'log'); }
  private exitPath(id: string): string { return join(this.directory(id), 'exit'); }

  subscribe(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(task: Pick<Task, 'id' | 'projectId' | 'state'>): void {
    for (const listener of this.listeners) { try { listener({ id: task.id, projectId: task.projectId, state: task.state }); } catch { /* an observer must not fail a task */ } }
  }

  /** One at a time: starts and cancels read and then write the task's record, and idempotency and the lock hold only if nothing interleaves. */
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const done = this.tail.then(run);
    this.tail = done.then(() => undefined, () => undefined);
    return done;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  private async view(stored: StoredTask): Promise<Task> {
    const logSize = await stat(this.logPath(stored.task.id)).then(info => info.size, () => 0);
    return { ...stored.task, logSize };
  }

  private stored(id: string): StoredTask {
    const stored = typeof id === 'string' ? this.store.get(id) : undefined;
    if (!stored) throw new AppError('TASK_NOT_FOUND', 'Task not found', 404);
    return stored;
  }

  get(id: string): Promise<Task> { return this.view(this.stored(id)); }

  list(projectId: string, limit: number): Promise<Task[]> {
    return Promise.all(this.store.list(projectId, Math.max(1, Math.min(limit, 100))).map(stored => this.view(stored)));
  }

  /** A plugin's recent tasks across the projects `visible` accepts, newest first. A project that is gone is skipped. */
  async listByPlugin(pluginId: string, limit: number, visible: (projectId: string) => boolean): Promise<Task[]> {
    const wanted = Math.max(1, Math.min(limit, 100));
    const rows = this.store.listByPlugin(pluginId, 100).filter(stored => visible(stored.task.projectId)).slice(0, wanted);
    return Promise.all(rows.map(stored => this.view(stored)));
  }

  /** The bytes `[from, to)` of the log. `to` stops at a character boundary, so `from = to` continues exactly where this ended. */
  async log(id: string, from: number, limit: number): Promise<TaskLogChunk> {
    const stored = this.stored(id);
    if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new AppError('INVALID_INPUT', 'from and limit must be positive integers');
    const ended = !isOpen(stored.task.state);
    let handle;
    try { handle = await open(this.logPath(id), 'r'); } catch { return { from: 0, to: 0, text: '', eof: ended }; }
    try {
      const { size } = await handle.stat();
      let start = Math.min(from, size);
      const buffer = Buffer.alloc(Math.min(limit, MAX_LOG_BYTES, size - start));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let bytes = buffer.subarray(0, bytesRead);
      // A window that begins inside a character starts at the next one.
      let skip = 0;
      while (start > 0 && skip < 3 && skip < bytes.length && (bytes[skip]! & 0xc0) === 0x80) skip++;
      start += skip; bytes = bytes.subarray(skip);
      let end = start + bytes.length;
      if (!(ended && end >= size)) {
        // A character cut off at the end is left for the next window (or, while the task runs, for the writer to finish).
        for (let back = 1; back <= Math.min(3, bytes.length); back++) {
          const byte = bytes[bytes.length - back]!;
          if ((byte & 0xc0) === 0x80) continue;
          const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
          if (length > back) { bytes = bytes.subarray(0, bytes.length - back); end -= back; }
          break;
        }
      }
      return { from: start, to: end, text: bytes.toString('utf8'), eof: ended && end >= size };
    } finally { await handle.close(); }
  }

  /** A registered artifact's file, checked once more at the moment of download. */
  async artifact(id: string, artifactId: string): Promise<{ file: string; name: string; size: number }> {
    const stored = this.stored(id);
    const artifact = stored.task.artifacts?.find(item => item.id === artifactId);
    const stamp = stored.stamps?.[artifactId];
    if (!artifact || stamp === undefined) throw new AppError('TASK_ARTIFACT_NOT_FOUND', 'Artifact not found', 404);
    let file: string;
    let info;
    try {
      file = await realpath(join(stored.root, artifact.path));
      info = await stat(file);
    } catch { throw new AppError('TASK_ARTIFACT_MISSING', 'The file is no longer there', 404); }
    if (!isWithin(stored.root, file) || !info.isFile()) throw new AppError('TASK_ARTIFACT_MISSING', 'The file is no longer there', 404);
    // A later build replaces the file: what was registered is then gone, and the new bytes belong to another task.
    if (info.size !== artifact.size || info.mtimeMs !== stamp) throw new AppError('TASK_ARTIFACT_CHANGED', 'The file changed after this task finished', 409);
    return { file, name: artifact.name, size: info.size };
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  private async offered(owned: OwnedTaskProvider, context: ProjectContext): Promise<TaskActionSpec[]> {
    const { provider } = owned;
    if (!await guarded(`${provider.id} detect`, () => provider.detect(context))) return [];
    const specs = await guarded(`${provider.id} actions`, () => provider.actions(context));
    return (Array.isArray(specs) ? specs : []).flatMap(spec => cleanSpec(spec) ?? []).slice(0, MAX_ACTIONS);
  }

  /** The actions of the enabled providers that recognise the project. Cached briefly per project; detection only reads marker files. */
  async actions(projectId: string): Promise<TaskActionsResponse> {
    const project = this.options.project(projectId);
    await this.options.providers.activateTaskProviders?.();
    const providers = this.options.providers.taskProviders();
    const key = providers.map(item => `${item.owner}:${item.provider.id}`).join(',');
    const cached = this.actionsCache.get(project.id);
    if (cached && cached.key === key && Date.now() - cached.at < (this.options.actionsTtlMs ?? ACTIONS_TTL_MS)) return cached.result;
    const result = (async (): Promise<TaskActionsResponse> => {
      let context: ProjectContext;
      try { context = projectContext(project, await projectRoot(project), this.options.stateDir); }
      catch (error) { if (error instanceof AppError && error.code === 'PROJECT_PATH_UNAVAILABLE') return { actions: [], projectTypes: [] }; throw error; }
      const actions: TaskAction[] = [];
      const projectTypes = new Set<string>();
      for (const owned of providers) {
        try {
          const specs = await this.offered(owned, context);
          if (owned.projectType && specs.length) projectTypes.add(owned.projectType);
          for (const spec of specs) actions.push({ ...spec, providerId: owned.provider.id, pluginId: owned.owner });
        } catch (error) { console.warn(`[riffet] task provider ${owned.provider.id} could not list actions:`, error instanceof Error ? error.message : error); }
      }
      return { actions, projectTypes: [...projectTypes] };
    })();
    this.actionsCache.set(project.id, { at: Date.now(), key, result });
    result.catch(() => { if (this.actionsCache.get(project.id)?.result === result) this.actionsCache.delete(project.id); });
    return result;
  }

  // ── Start ──────────────────────────────────────────────────────────────────

  /** How many tasks of the plugin are running, or being cancelled: what turning it off, or switching its version, waits for. */
  runningCount(pluginId: string): number { return this.store.open().filter(({ task }) => task.pluginId === pluginId).length; }

  /** Whether a task started under this version of a plugin is still open, so its files are kept. */
  usesPluginVersion(pluginId: string, version: string): boolean { return this.store.open().some(({ task }) => task.pluginId === pluginId && task.providerVersion === version); }

  start(input: unknown): Promise<Task> { return this.exclusive(() => this.begin(input)); }

  private async begin(input: unknown): Promise<Task> {
    if (process.platform === 'win32') throw new AppError('TASKS_UNSUPPORTED', 'Project tasks are not supported on this system', 501);
    if (!isRecord(input)) throw new AppError('INVALID_INPUT', 'Expected an object');
    const requestId = requireString(input.requestId, 'requestId', 128);
    if (!REQUEST_ID.test(requestId)) throw new AppError('INVALID_INPUT', 'requestId may hold letters, digits and . _ : - only');
    const projectId = requireString(input.projectId, 'projectId', 200);
    const providerId = requireString(input.providerId, 'providerId', 130);
    const actionId = requireString(input.actionId, 'actionId', 64);
    const given = readParams(input.params);
    const identity = fingerprint(projectId, providerId, actionId, given);

    // The same request again, even long after it finished: the same task.
    const existing = this.store.byRequest(requestId);
    if (existing) {
      if (existing.fingerprint !== identity) throw new AppError('TASK_REQUEST_CONFLICT', 'This request id was already used for a different task', 409, { taskId: existing.task.id });
      return this.view(existing);
    }

    const project = this.options.project(projectId);
    await this.options.providers.ensureContribution?.('task', providerId).catch(() => undefined);
    const owned = this.options.providers.taskProviders().find(item => item.provider.id === providerId);
    if (!owned) {
      if (this.options.providers.isStopping?.(providerId.split('/')[0]!)) throw new AppError('TASK_PROVIDER_STOPPING', 'The plugin is turning off once its running tasks end and accepts no new tasks', 409);
      throw new AppError('TASK_PROVIDER_UNAVAILABLE', 'This task provider is not available', 409);
    }
    const root = await projectRoot(project);
    const context = projectContext(project, root, this.options.stateDir);
    const spec = (await this.offered(owned, context)).find(item => item.id === actionId);
    if (!spec) throw new AppError('TASK_ACTION_UNAVAILABLE', 'The provider does not offer this action for the project', 404);
    const params = resolveParams(spec.params, given);
    const raw: unknown = await guarded(`${providerId} plan`, () => owned.provider.plan(spec.id, params, context));

    const plan = await this.checkPlan(raw, root);
    if (owned.source === 'installed') checkInstalledPlan(plan);
    if (plan.lock) {
      const holder = this.store.holder(project.id, plan.lock);
      if (holder) throw new AppError('TASK_BUSY', 'Another task of this project holds the same lock', 409, { taskId: holder.task.id, lock: plan.lock });
    }
    // An installed package's command is not code Riffet shipped: its environment is limited, and the user approves each plan before it first runs.
    if (owned.source === 'installed') this.confirmed(owned, spec.id, projectId, plan, root, input.confirm);

    const id = randomUUID();
    await mkdir(this.directory(id), { recursive: true, mode: 0o700 });
    const stored: StoredTask = {
      task: {
        id, requestId, projectId: project.id, pluginId: owned.owner, providerId, providerVersion: owned.version ?? 'unversioned', actionId,
        title: spec.title, params, state: 'running', startedAt: now(),
      },
      fingerprint: identity, root, cwd: plan.cwd,
      plan: { file: plan.file, args: plan.args, ...(plan.lock ? { lock: plan.lock } : {}), ...(plan.artifacts.length ? { artifacts: plan.artifacts } : {}) },
    };
    // The record comes first: a crash between it and the process leaves a task that recovery marks unknown, never a process nobody knows of.
    this.store.insert(stored);
    let child: ChildProcess;
    try {
      child = spawnTask({ file: plan.file, args: plan.args, cwd: plan.cwd, env: { ...(this.options.environment?.() ?? { ...process.env, ...terminalEnvironment() }), ...plan.env }, logPath: this.logPath(id), exitPath: this.exitPath(id) });
    } catch (error) { return this.view(this.spawnFailed(stored, error)); }
    if (child.pid === undefined) {
      const error = await new Promise<Error>(resolve => child.once('error', resolve));
      return this.view(this.spawnFailed(stored, error));
    }
    stored.process = { pid: child.pid, pgid: child.pid };
    this.store.save(stored);
    this.watch(id, child);
    this.emit(stored.task);
    const started = await processStart(child.pid);
    const current = this.store.get(id);
    if (started && current?.process && isOpen(current.task.state)) { current.process.start = started; this.store.save(current); }
    return this.view(this.store.get(id) ?? stored);
  }

  /** Passes a plan the user has approved for this plugin version, or when `confirm` is its fingerprint (and records that); otherwise asks for confirmation. */
  private confirmed(owned: OwnedTaskProvider, actionId: string, projectId: string, plan: { file: string; args: string[]; cwd: string; env: Record<string, string> }, root: string, confirm: unknown): void {
    const shown = { file: plan.file, args: plan.args, cwd: relative(root, plan.cwd) || '.', env: plan.env };
    const fingerprint = planFingerprint(projectId, shown);
    const key: ApprovalKey = { pluginId: owned.owner, version: owned.version ?? 'unversioned', providerId: owned.provider.id, actionId };
    if (this.store.approved(key, fingerprint)) return;
    if (confirm !== fingerprint) throw new AppError('TASK_CONFIRM_REQUIRED', 'This command comes from an installed plugin and has not run before: confirm it first', 409, { fingerprint, plan: shown });
    this.store.approve(key, fingerprint);
  }

  private async checkPlan(raw: unknown, root: string): Promise<{ file: string; args: string[]; cwd: string; env: Record<string, string>; lock?: string; artifacts: string[] }> {
    const invalid = (message: string) => new AppError('TASK_PLAN_INVALID', message, 502);
    if (!isRecord(raw)) throw invalid('The provider returned no plan');
    const { args, env, lock } = raw;
    if (!Array.isArray(args) || args.length > 256 || args.some(arg => typeof arg !== 'string' || arg.length > 16_384 || arg.includes('\0'))) throw invalid('The plan\'s args must be a list of strings');
    if (env !== undefined && (!isRecord(env) || Object.keys(env).length > 64 || Object.entries(env).some(([name, value]) => !ENV_NAME.test(name) || typeof value !== 'string' || value.length > 32_768 || value.includes('\0')))) throw invalid('The plan\'s env must map names to strings');
    if (lock !== undefined && (typeof lock !== 'string' || !lock || lock.length > 100)) throw invalid('The plan\'s lock must be a short string');
    const artifacts = checkGlobs(raw.artifacts);
    const cwd = await resolveWorkingDirectory(root, raw.cwd as string | undefined);
    const file = await checkCommand(root, cwd, raw.file);
    return { file, args: args as string[], cwd, env: { ...(env as Record<string, string> | undefined) }, ...(lock ? { lock } : {}), artifacts };
  }

  private spawnFailed(stored: StoredTask, error: unknown): StoredTask {
    try { appendFileSync(this.logPath(stored.task.id), `Could not start the process: ${error instanceof Error ? error.message : String(error)}\n`); } catch { /* the state says it */ }
    stored.task.state = 'failed';
    stored.task.endedAt = now();
    this.store.save(stored);
    this.emit(stored.task);
    return stored;
  }

  // ── Cancel ─────────────────────────────────────────────────────────────────

  /** Asks the task to stop: SIGTERM to its process group, SIGKILL after the grace period. It is `cancelled` only once the process is seen to be gone. */
  cancel(id: string): Promise<Task> {
    return this.exclusive(async () => {
      const first = this.stored(id);
      if (first.task.state !== 'running') return this.view(first);
      // A process this server started is trusted; one it adopted after a restart is matched first, so a reused pid is never signalled.
      const identity = this.watched.get(id)?.child ? 'same' : await identify(first.process);
      const stored = this.store.get(id)!;
      if (stored.task.state !== 'running') return this.view(stored);
      stored.task.state = 'cancelling';
      stored.task.cancelRequestedAt = now();
      this.store.save(stored);
      this.emit(stored.task);
      if (identity === 'same' && stored.process) {
        signalGroup(stored.process.pgid, 'SIGTERM');
        this.armKill(id, this.killGraceMs);
      }
      return this.view(stored);
    });
  }

  private armKill(id: string, delayMs: number): void {
    if (this.closed) return;
    clearTimeout(this.kills.get(id));
    const timer = setTimeout(() => {
      this.kills.delete(id);
      void (async () => {
        const stored = this.store.get(id);
        if (!stored?.process || !isOpen(stored.task.state)) return;
        if (this.watched.get(id)?.child || (await identify(stored.process)) === 'same') signalGroup(stored.process.pgid, 'SIGKILL');
      })().catch(() => undefined);
    }, Math.max(0, delayMs));
    timer.unref();
    this.kills.set(id, timer);
  }

  // ── Watching ───────────────────────────────────────────────────────────────

  private watch(id: string, child?: ChildProcess): void {
    if (this.closed || this.watched.has(id)) return;
    const watch: Watch = { busy: false, ...(child ? { child } : {}) };
    this.watched.set(id, watch);
    child?.once('exit', (code, signal) => { watch.exited = { code, signal }; void this.check(id); });
    this.schedule(id);
  }

  private schedule(id: string): void {
    const watch = this.watched.get(id);
    if (!watch || this.closed) return;
    watch.timer = setTimeout(() => void this.check(id), this.pollMs);
    watch.timer.unref();
  }

  private unwatch(id: string): void {
    clearTimeout(this.watched.get(id)?.timer);
    this.watched.delete(id);
    clearTimeout(this.kills.get(id));
    this.kills.delete(id);
  }

  /** One look at a task: finished if its exit file exists, or its process is gone. */
  private async check(id: string): Promise<void> {
    const watch = this.watched.get(id);
    if (!watch || watch.busy || this.closed) return;
    watch.busy = true;
    clearTimeout(watch.timer);
    try {
      const stored = this.store.get(id);
      if (!stored || !isOpen(stored.task.state)) { this.unwatch(id); return; }
      const code = await readExitCode(this.exitPath(id));
      if (code !== undefined) return await this.finish(stored, { kind: 'exit', exitCode: code });
      if (watch.exited) {
        // The wrapper died before it could write: killed from outside, or by the SIGKILL that follows a cancel. The status is the shell's own.
        const lost = watch.exited.code ?? signalExitCode(watch.exited.signal);
        return await this.finish(stored, lost === undefined ? { kind: 'gone' } : { kind: 'exit', exitCode: lost });
      }
      if (!watch.child && !(stored.process && isAlive(stored.process.pid))) {
        // It may have written its code between the two looks.
        const late = await readExitCode(this.exitPath(id));
        return await this.finish(stored, late === undefined ? { kind: 'gone' } : { kind: 'exit', exitCode: late });
      }
    } catch (error) {
      console.warn(`[riffet] task ${id} could not be checked:`, error instanceof Error ? error.message : error);
    } finally {
      watch.busy = false;
      if (this.watched.get(id) === watch) this.schedule(id);
    }
  }

  private async logTail(id: string): Promise<string> {
    let handle;
    try { handle = await open(this.logPath(id), 'r'); } catch { return ''; }
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - DIAGNOSTICS_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const text = buffer.toString('utf8', 0, bytesRead);
      // A tail that starts mid-line would parse as a different line.
      if (start === 0) return text;
      const newline = text.indexOf('\n');
      return newline < 0 ? '' : text.slice(newline + 1);
    } finally { await handle.close(); }
  }

  /**
   * The reading of the log by the provider version that started the task. If that version is not the one running, because the plugin
   * is off or another version took over, there are no diagnostics and `note` says so.
   */
  private async diagnose(stored: StoredTask): Promise<{ diagnostics?: TaskDiagnostic[]; note?: string }> {
    const { pluginId, providerId, providerVersion } = stored.task;
    const { providers } = this.options;
    const owned = providers.taskProviderFor
      ? providers.taskProviderFor(pluginId, providerId, providerVersion)
      : providers.taskProviders().find(item => item.owner === pluginId && item.provider.id === providerId && (item.version ?? 'unversioned') === providerVersion);
    if (!owned) return { note: `Diagnostics were skipped: version ${providerVersion} of ${pluginId} was no longer active when the task ended` };
    const { provider } = owned;
    if (!provider.diagnostics) return {};
    try {
      const found = cleanDiagnostics(await provider.diagnostics(await this.logTail(stored.task.id), diagnosticsContext([stored.root])));
      return found.length ? { diagnostics: found } : {};
    } catch (error) {
      console.warn(`[riffet] task ${stored.task.id} diagnostics failed:`, error instanceof Error ? error.message : error);
      return {};
    }
  }

  private async finish(stored: StoredTask, outcome: Outcome): Promise<void> {
    const id = stored.task.id;
    const { diagnostics, note } = await this.diagnose(stored);
    const files = outcome.kind === 'exit' && outcome.exitCode === 0 && stored.plan.artifacts ? await expandArtifacts(stored.root, stored.plan.artifacts).catch(() => []) : [];
    // Read again: a cancel may have been recorded while the log was read, and only one writer's state may stand.
    const fresh = this.store.get(id);
    if (!fresh || !isOpen(fresh.task.state)) { this.unwatch(id); return; }
    const { task } = fresh;
    const cancelled = Boolean(task.cancelRequestedAt);
    let state: TaskState;
    if (outcome.kind === 'exit') {
      task.exitCode = outcome.exitCode;
      state = outcome.exitCode === 0 ? 'succeeded' : cancelled ? 'cancelled' : 'failed';
    } else if (outcome.kind === 'gone' && cancelled) state = 'cancelled';
    else {
      state = 'unknown';
      task.unknownReason = outcome.kind === 'other' ? outcome.reason : 'The process ended while the server was not watching it, and left no exit code.';
    }
    task.state = state;
    task.endedAt = now();
    if (diagnostics) task.diagnostics = diagnostics;
    if (note) task.diagnosticsNote = note;
    if (files.length) {
      task.artifacts = files.map(file => ({ id: createHash('sha256').update(file.path).digest('hex').slice(0, 16), name: file.name, path: file.path, size: file.size, sha256: file.sha256 }));
      fresh.stamps = Object.fromEntries(task.artifacts.map((artifact, index) => [artifact.id, files[index]!.mtimeMs]));
    }
    this.store.save(fresh);
    this.unwatch(id);
    this.emit(task);
    this.prune();
  }

  // ── Recovery ───────────────────────────────────────────────────────────────

  /**
   * Run once when the server starts. A task still `running` or `cancelling` is finished if its exit
   * file exists, followed again if its process is alive and is the one that was started, and
   * otherwise `unknown`. Nothing is ever started again.
   */
  async recover(): Promise<void> {
    for (const stored of this.store.open()) {
      const id = stored.task.id;
      try {
        const code = await readExitCode(this.exitPath(id));
        if (code !== undefined) { await this.finish(stored, { kind: 'exit', exitCode: code }); continue; }
        if (!stored.process) { await this.finish(stored, { kind: 'other', reason: 'The server stopped before the process was started.' }); continue; }
        const identity = await identify(stored.process);
        if (identity === 'same') {
          this.watch(id);
          if (stored.task.state === 'cancelling') this.armKill(id, Math.max(0, Date.parse(stored.task.cancelRequestedAt ?? '') + this.killGraceMs - Date.now() || 0));
        } else if (identity === 'gone') await this.finish(stored, { kind: 'gone' });
        else await this.finish(stored, { kind: 'other', reason: 'A process with the recorded id exists but could not be matched to this task, so it was left alone.' });
      } catch (error) { console.warn(`[riffet] task ${id} could not be recovered:`, error instanceof Error ? error.message : error); }
    }
    this.prune();
  }

  /** Finished tasks past their retention: the newest per project stay, and so does anything recent. */
  private prune(): void {
    try {
      for (const id of this.store.expired(new Date(Date.now() - KEEP_MS).toISOString(), KEEP_FINISHED_PER_PROJECT)) {
        this.store.delete(id);
        void rm(this.directory(id), { recursive: true, force: true }).catch(() => undefined);
      }
    } catch (error) { console.warn('[riffet] task pruning failed:', error instanceof Error ? error.message : error); }
  }

  /** Stops watching. The processes are not touched: a task outlives the server that started it, and the next start picks it up. */
  close(): void {
    this.closed = true;
    for (const id of [...this.watched.keys()]) this.unwatch(id);
    for (const timer of this.kills.values()) clearTimeout(timer);
    this.kills.clear();
    this.listeners.clear();
    this.store.close();
  }
}
