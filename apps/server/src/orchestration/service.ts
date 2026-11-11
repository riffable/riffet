import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { AttemptCleanup, AttemptComparison, AttemptGroup, HandoffDraft, LaunchTarget, MergeResult, NativeRunInput, NativeSessionInput, Project, Run, ReviewComment, Schedule, Session, SessionOrigin, TaskTemplate, RiffetWakeup } from '../../../../packages/contracts/src/index.js';
import { isNativeBackendId } from '../backends/registry.js';
import type { NativeBackendService } from '../backends/service.js';
import { AppError, requireString } from '../errors.js';
import type { IdentifiedSession } from '../session-identity.js';
import { generatedBranch, type GitService } from '../git/index.js';
import type { NativeDispatcher } from '../native/dispatch.js';
import { resolveNativeSessionInput } from '../native/session-input.js';
import { servingKey } from '../journal/ingest.js';
import { NativeEventLog } from '../journal/native-log.js';
import { extractIndexable } from '../search/messages.js';
import type { SettingsService } from '../settings/index.js';
import type { Store } from '../store.js';
import { auxiliaryEndpoint } from '../auxiliary/models.js';
import { summaryHeading, writeBrief, writeMaterial, type BriefSource } from './brief.js';
import { requestHandoffSummary } from './handoff-summary.js';
import type { SessionCommands } from './session-commands.js';
import { nextCronTime, parseCron } from './cron.js';
import type { NoticeLog } from '../riffet-mcp/notices.js';

/*
 * Records live in the settings table under these keys, one JSON map each: they are few, small and
 * written by one process, so a table of their own would add a migration and buy nothing.
 */
const GROUPS = 'orchestration:attempt-groups';
const TEMPLATES = 'orchestration:templates';
const SCHEDULES = 'orchestration:schedules';
const WAKEUPS = 'orchestration:wakeups';
const MAX_ATTEMPTS = 4;
const MAX_TEMPLATES = 200;
const MAX_SCHEDULES = 50;
const MAX_GROUPS_KEPT = 100;
/** A run that should have fired longer ago than this — the workbench was off — is marked missed, not fired late. */
const MISSED_AFTER_MS = 60 * 60 * 1000;
const SCHEDULER_INTERVAL_MS = 30_000;
const MAX_PENDING_WAKEUPS_PER_SESSION = 20;
const MAX_WAKEUPS = 500;
const MAX_WAKEUP_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
/** Settled wake-ups are kept this long for `list_wakeups` and the conversation's own view. */
const WAKEUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface OrchestrationDeps { store: Store; settings: SettingsService; nativeBackends: NativeBackendService; git: GitService; dispatch: NativeDispatcher; sessionCommands: SessionCommands; schedulerIntervalMs?: number; notices?: NoticeLog;
  /** Told of every wake-up that was scheduled or left `pending`; device leases follow it (docs/DEVICES.md §3). */
  onWakeup?: (wakeup: RiffetWakeup) => void; }
interface Ids { sessionId?: string; commandId?: string }
const HANDOFF_NEXT = '先用几句话确认你理解的现状和尚未完成的部分，然后继续完成它。';
type StoredAttemptGroup = AttemptGroup & { requestId?: string; requestFingerprint?: string; warnings?: string[]; runInput?: NativeRunInput };

const now = () => new Date().toISOString();
const textInput = (text: string): NativeRunInput => ({ text, attachmentIds: [], context: [] });

function optionalString(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max || /[\0\r\n]/.test(value)) throw new AppError('INVALID_INPUT', `${name} is invalid`);
  return value;
}

/** The backend fields of a request; whether the backend offers them is checked when the session is resolved. */
export function launchTarget(value: unknown): LaunchTarget {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new AppError('INVALID_INPUT', 'target must be an object');
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const backendId = optionalString(raw.backendId, 'backendId', 40);
  // A quick chat is started in its own project, never by a template, schedule, fork or attempt.
  if (backendId !== undefined && (!isNativeBackendId(backendId) || backendId === 'chat')) throw new AppError('INVALID_BACKEND', 'Choose a supported native backend');
  const target: LaunchTarget = {};
  if (backendId) target.backendId = backendId;
  for (const [key, max] of [['backendProfileId', 200], ['model', 200], ['mode', 100], ['approval', 100]] as const) {
    const item = optionalString(raw[key], key, max);
    if (item !== undefined) target[key] = item;
  }
  return target;
}

/** The message a set of review remarks becomes; each names its file and lines so the agent can find them without the diff. */
export function reviewMessage(comments: ReviewComment[], note?: string): string {
  const items = comments.map((comment, index) => {
    const where = comment.line === undefined ? comment.path : `${comment.path}:${comment.line}${comment.endLine && comment.endLine !== comment.line ? `-${comment.endLine}` : ''}`;
    const quote = comment.quote?.trim() ? `\n${comment.quote.trim().split('\n').slice(0, 12).map(line => `> ${line}`).join('\n')}` : '';
    return `${index + 1}. \`${where}\`${quote}\n${comment.body.trim()}`;
  });
  return [note?.trim() || '请根据以下代码审阅意见修改：', ...items].join('\n\n');
}

export function reviewComments(value: unknown): ReviewComment[] {
  if (!Array.isArray(value) || !value.length || value.length > 50) throw new AppError('INVALID_REVIEW', 'Send between 1 and 50 review comments');
  return value.map(item => {
    const raw = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const line = raw.line === undefined ? undefined : Number(raw.line), endLine = raw.endLine === undefined ? undefined : Number(raw.endLine);
    if ((line !== undefined && (!Number.isSafeInteger(line) || line < 1)) || (endLine !== undefined && (!Number.isSafeInteger(endLine) || line === undefined || endLine < line))) throw new AppError('INVALID_LINE', 'Review comment lines are invalid');
    return {
      path: requireString(raw.path, 'path', 8192), body: requireString(raw.body, 'body', 10_000),
      ...(line !== undefined ? { line } : {}), ...(endLine !== undefined ? { endLine } : {}),
      ...(typeof raw.quote === 'string' && raw.quote ? { quote: raw.quote.slice(0, 4_000) } : {}),
    };
  });
}

/** `{{date}}` and `{{project}}`, the only placeholders a template knows; anything else is left as written. */
function renderTemplate(prompt: string, project: Project, at = new Date()): string {
  const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  return prompt.replace(/\{\{\s*date\s*\}\}/g, date).replace(/\{\{\s*project\s*\}\}/g, project.name);
}

/**
 * Everything that opens or steers a conversation on someone's behalf: parallel attempts, forks,
 * handoffs, review feedback, templates and their schedules. Each of them ends in the same two store
 * writes the composer uses — `createNativeSubmission` or `acceptNativeRun` — so the dispatcher,
 * recovery and idempotency treat these turns exactly like typed ones.
 */
export class OrchestrationService {
  private readonly timer: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private readonly operations = new Map<string, Promise<void>>();
  private readonly firing = new Map<string, Promise<Schedule>>();
  private wakeupTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly deps: OrchestrationDeps) {
    this.timer = setInterval(() => { void this.tick().catch(error => console.error('[orchestration] schedule tick failed:', error)); }, deps.schedulerIntervalMs ?? SCHEDULER_INTERVAL_MS);
    this.timer.unref();
    this.armWakeups();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    if (this.wakeupTimer) clearTimeout(this.wakeupTimer);
    await Promise.allSettled([this.ticking, ...this.firing.values(), ...this.operations.values()].filter(task => task !== undefined));
  }

  /** Reserve the request before any async validation or worktree creation can produce side effects. */
  private async withOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new AppError('SERVICE_CLOSED', 'The workbench is shutting down', 503);
    const previous = this.operations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => hold);
    this.operations.set(key, tail);
    await previous;
    try {
      if (this.closed) throw new AppError('SERVICE_CLOSED', 'The workbench is shutting down', 503);
      return await operation();
    } finally {
      release();
      if (this.operations.get(key) === tail) this.operations.delete(key);
    }
  }

  private read<T>(key: string): Record<string, T> { return Object.assign(Object.create(null) as Record<string, T>, this.deps.store.getSetting<Record<string, T>>(key, {})); }
  private write<T>(key: string, value: Record<string, T>): void { this.deps.store.setSetting(key, value); }
  private busy(sessionId: string): boolean {
    const session = this.deps.store.getSession(sessionId);
    return this.deps.store.listUnfinishedNativeRuns(sessionId).length > 0
      || ['starting', 'running', 'waiting', 'cancelling'].includes(session.state)
      || ['starting', 'busy', 'attention'].includes(this.deps.nativeBackends.status(sessionId).phase);
  }

  /**
   * A retried launch. The first message of a fork or handoff is written from live state, so a retry
   * would not reproduce it byte for byte and `createNativeSubmission` would call it a conflict;
   * the conversation the first attempt created is returned instead.
   */
  private relaunched(ids: Ids, origin: SessionOrigin, projectId?: string): { session: Session; run: Run } | undefined {
    if (!ids.sessionId) return undefined;
    let session: Session;
    // A deleted id is refused before anything (a worktree, a brief) is made for it.
    try { session = this.deps.store.getSession(ids.sessionId); } catch (error) { if (error instanceof AppError && error.code === 'SESSION_DELETED') throw error; return undefined; }
    const run = this.deps.store.listRuns(session.id)[0];
    const project = this.deps.store.getProject(session.projectId);
    if (!run || (ids.commandId && run.commandId !== ids.commandId) || !session.origin || (['kind', 'sessionId', 'runId', 'groupId', 'templateId', 'scheduleId'] as const).some(key => session.origin?.[key] !== origin[key])
      || (projectId && project.id !== projectId && project.worktree?.originProjectId !== projectId)) throw new AppError('SESSION_ID_CONFLICT', 'This clientSessionId was already used for a different session creation request', 409);
    return { session, run };
  }

  /** Opens a conversation with its first message, resolving the backend as the composer would. */
  private launch(input: NativeSessionInput, text: string | NativeRunInput, origin: SessionOrigin, ids: Ids = {}): { session: Session; run: Run } {
    if (this.closed) throw new AppError('SERVICE_CLOSED', 'The workbench is shutting down', 503);
    const result = this.deps.store.createNativeSubmission(ids.sessionId ?? randomUUID(), { ...input, origin }, ids.commandId ?? randomUUID(), typeof text === 'string' ? textInput(text) : text);
    this.deps.dispatch.kick();
    return result;
  }

  /** A follow-up in an existing conversation under its current settings, as the composer's send does. */
  private send(sessionId: string, text: string, commandId: string = randomUUID()): Run {
    const session = this.deps.store.getSession(sessionId);
    if (session.kind !== 'native') throw new AppError('NOT_NATIVE', 'Only native conversations accept text input', 409);
    const existing = this.deps.store.findRunByCommand(session.id, commandId);
    if (existing) return this.deps.store.acceptNativeRun(session.id, commandId, textInput(text), existing.native!.config);
    this.deps.sessionCommands.admit(session);
    this.deps.nativeBackends.assertAvailable(session);
    const run = this.deps.store.acceptNativeRun(session.id, commandId, textInput(text), { model: session.model, mode: session.mode, approval: session.approval });
    this.deps.dispatch.kick();
    return run;
  }

  /** [shadow]: an attempt, which a directory outside Git can also start (see `GitService.worktreeBase`). */
  private async worktreeProject(origin: Project, base: string, label?: string, shadow = false): Promise<Project> {
    const namingOrigin = this.deps.store.getProject(this.deps.store.originChain(origin.id).at(-1) ?? origin.id);
    if (origin.system === 'task-workspace') throw new AppError('TASK_WORKSPACE_SAVE_REQUIRED', 'Save this task as a project before creating worktrees', 409);
    const created = await this.deps.git.createWorktree(origin, { branch: generatedBranch(namingOrigin.name, { suffix: label }), base }, { shadow });
    const branch = created.branch ?? created.head.slice(0, 8);
    return this.deps.store.createProject(await realpath(created.path), `${origin.name} · ${branch}`, { originProjectId: origin.id, branch });
  }

  // ---- Review feedback -------------------------------------------------------------------------

  review(sessionId: string, commandId: string, comments: ReviewComment[], note?: string): Run {
    return this.send(sessionId, reviewMessage(comments, note), commandId);
  }

  // ---- Fork and handoff ------------------------------------------------------------------------

  /**
   * What a continuing conversation is written from. When a backend can be read without starting
   * it, its transcript is the source, uncapped, and is indexed on the way so search catches up too;
   * otherwise the search index is, whose replies may be clipped or missing for a thread never
   * opened since the server started.
   */
  private async briefSource(session: IdentifiedSession, upToRunId?: string): Promise<BriefSource> {
    const { store, nativeBackends, git } = this.deps;
    let messages: BriefSource['messages'] = [];
    try {
      const events = await nativeBackends.indexableTranscript(session.id);
      store.indexMessages(extractIndexable(session.id, events));
      messages = extractIndexable(session.id, events, Number.POSITIVE_INFINITY);
    } catch { /* the transcript and the index are best-effort sources */ }
    if (!messages.length) {
      const { key } = servingKey(store.journal, session.id, 'main');
      const events = new NativeEventLog(store.journal, session.id, key).tail(Number.MAX_SAFE_INTEGER);
      messages = extractIndexable(session.id, events, Number.POSITIVE_INFINITY);
    }
    if (!messages.length) messages = store.indexedMessages(session.id, { tools: true });
    const status = await git.status(store.getProject(session.projectId)).catch(() => undefined);
    return { session, runs: store.listRuns(session.id), messages, ...(status ? { status } : {}), ...(upToRunId ? { upToRunId } : {}) };
  }

  private async brief(session: IdentifiedSession, upToRunId?: string): Promise<string> {
    return writeBrief(await this.briefSource(session, upToRunId));
  }

  /**
   * Continues a conversation in a new one, optionally from an earlier turn, on another backend, or
   * in a fresh worktree. Code is not rewound here: undoing a turn's edits is a checkpoint restore,
   * a separate and previewed step, so a fork never silently changes files.
   */
  async fork(sessionId: string, options: { runId?: string; target?: LaunchTarget; isolate?: boolean; note?: string } & Ids): Promise<{ session: Session; run: Run }> {
    return this.withOperation(`launch:${options.sessionId ?? randomUUID()}`, async () => {
      const { store } = this.deps;
      const provenance: SessionOrigin = { kind: 'fork', sessionId, ...(options.runId ? { runId: options.runId } : {}) };
      const again = this.relaunched(options, provenance);
      if (again) return again;
      const source = store.getSession(sessionId);
      if (options.runId) { const run = store.getRun(options.runId); if (run.sessionId !== source.id) throw new AppError('RUN_NOT_FOUND', 'Run does not belong to this conversation', 404); }
      const origin = store.getProject(source.projectId);
      const text = `${await this.brief(source, options.runId)}\n\n## 接下来\n${options.note?.trim() || '先用几句话确认你理解的现状，然后等我的下一步指示，暂时不要修改文件。'}`;
      // Inherit the source's provider only while it still exists: a fork of a conversation whose
      // provider was removed must land on the backend's default, not fail on the dangling id.
      const sourceBackend = source.backendId;
      const inheritProfile = source.backendProfileId
        && this.deps.nativeBackends.profileSettings(sourceBackend).profiles.some(profile => profile.id === source.backendProfileId)
        ? source.backendProfileId : undefined;
      const target = options.target ?? { backendId: sourceBackend, ...(inheritProfile ? { backendProfileId: inheritProfile } : {}), ...(source.model ? { model: source.model } : {}), mode: source.mode, ...(source.approval ? { approval: source.approval } : {}) };
      const input = await resolveNativeSessionInput(this.deps, { ...target, projectId: origin.id, title: `${source.title} · 新会话` });
      const project = options.isolate ? await this.worktreeProject(origin, 'HEAD', 'fork') : origin;
      // A continuation keeps the tool groups its source was created with (docs/DEVICES.md §2).
      return this.launch({ ...input, projectId: project.id, ...(source.toolGroups?.length ? { toolGroups: source.toolGroups } : {}), ...sameLaunchExtensions(source, input) }, text, provenance, options);
    });
  }

  /**
   * The opening message proposed for a handoff, for the reader to edit before `handoff` sends it.
   * The auxiliary handoff model writes it when one is set — it need not be the model the source ran
   * on, which may be the very thing that stopped working — and the transcript brief stands in when
   * none is set or the model fails, so a handoff never depends on it.
   */
  async handoffDraft(sessionId: string, options: { target: LaunchTarget; goal?: string; signal?: AbortSignal }): Promise<HandoffDraft> {
    const { store, settings, nativeBackends } = this.deps;
    const source = store.getSession(sessionId);
    if (!options.target.backendId) throw new AppError('INVALID_BACKEND', 'Choose the backend to hand this conversation to');
    if (this.busy(source.id)) throw new AppError('SESSION_BUSY', 'Stop or finish the current turn before handing this conversation off', 409);
    const material = await this.briefSource(source);
    const next = `\n\n## 接下来\n${options.goal?.trim() || HANDOFF_NEXT}`;
    const ref = settings.getSettings().auxiliaryModels?.handoff;
    if (!ref) return { text: `${writeBrief(material)}${next}` };
    try {
      const { profileName, ...endpoint } = auxiliaryEndpoint(ref, backendId => nativeBackends.gatewayProfiles(backendId));
      const note = await requestHandoffSummary(endpoint, writeMaterial(material), { ...(options.goal?.trim() ? { goal: options.goal.trim() } : {}), ...(options.signal ? { signal: options.signal } : {}) });
      return { text: `${summaryHeading(source)}\n\n${note}${next}`, generatedBy: { ...ref, profileName } };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : error instanceof Error ? error.message : String(error);
      return { text: `${writeBrief(material)}${next}`, fallbackReason: reason };
    }
  }

  /**
   * Moves the work to another backend in the same checkout. The source must be idle — two agents
   * editing one tree at once is the failure this exists to avoid — and is marked as handed off so a
   * client can point readers to where the thread went.
   */
  async handoff(sessionId: string, options: { target: LaunchTarget; note?: string; text?: string } & Ids): Promise<{ session: Session; run: Run }> {
    return this.withOperation(`launch:${options.sessionId ?? randomUUID()}`, async () => {
      const { store } = this.deps;
      const provenance: SessionOrigin = { kind: 'handoff', sessionId };
      const again = this.relaunched(options, provenance);
      if (again) return again;
      const source = store.getSession(sessionId);
      if (!options.target.backendId) throw new AppError('INVALID_BACKEND', 'Choose the backend to hand this conversation to');
      if (this.busy(source.id)) throw new AppError('SESSION_BUSY', 'Stop or finish the current turn before handing this conversation off', 409);
      // A reviewed draft is sent as the reader left it; without one the brief is written here.
      const text = options.text ?? `${await this.brief(source)}\n\n## 接下来\n${options.note?.trim() || HANDOFF_NEXT}`;
      const input = await resolveNativeSessionInput(this.deps, { ...options.target, projectId: source.projectId, title: source.title });
      // Transcript reads and backend validation await I/O. Recheck at the synchronous acceptance
      // boundary, since a user may have submitted another turn while the brief was being prepared.
      if (this.busy(source.id)) throw new AppError('SESSION_BUSY', 'Stop or finish the current turn before handing this conversation off', 409);
      const result = this.launch({ ...input, ...(source.toolGroups?.length ? { toolGroups: source.toolGroups } : {}), ...sameLaunchExtensions(source, input) }, text, provenance, options);
      const updated = store.updateSession(source.id, { handedOffTo: result.session.id });
      store.appendEvent(source.id, 'session', { session: updated });
      return result;
    });
  }

  // ---- Parallel attempts -----------------------------------------------------------------------

  /**
   * One prompt, several backends, each in a worktree cut from the same commit. Every target is
   * resolved before anything is created, so a bad choice fails the request instead of leaving some
   * worktrees behind. Uncommitted changes in the project are not part of the base and are reported;
   * a directory outside Git starts from a snapshot of what is on disk instead.
   */
  async createAttempts(projectId: string, input: { prompt: string; targets: LaunchTarget[]; base?: string; requestId?: string; runInput?: NativeRunInput }): Promise<{ group: AttemptGroup; warnings: string[] }> {
    return this.withOperation(`attempts:${input.requestId ?? randomUUID()}`, async () => {
      const { store, git } = this.deps;
      const origin = store.getProject(projectId);
      if (!Array.isArray(input.targets) || input.targets.length < 2 || input.targets.length > MAX_ATTEMPTS) throw new AppError('INVALID_ATTEMPTS', `Choose between 2 and ${MAX_ATTEMPTS} backends`);
      const groups = this.read<StoredAttemptGroup>(GROUPS);
      const requestFingerprint = createHash('sha256').update(JSON.stringify({ projectId, prompt: input.prompt, base: input.base ?? 'HEAD', targets: input.targets.map(launchTarget), attachments: input.runInput?.attachmentIds ?? [], context: input.runInput?.context ?? [] })).digest('hex');
      const repeated = input.requestId ? Object.values(groups).find(group => group.requestId === input.requestId) : undefined;
      if (repeated) {
        if (repeated.requestFingerprint !== requestFingerprint) throw new AppError('REQUEST_ID_CONFLICT', 'This requestId was already used for different attempts', 409);
        if (repeated.attempts.length === input.targets.length) return { group: repeated, warnings: repeated.warnings ?? [] };
      }
      const resolved = await Promise.all(input.targets.map(target => resolveNativeSessionInput(this.deps, { ...target, projectId: origin.id })));
      const start = repeated ? undefined : await git.worktreeBase(origin, input.base ?? 'HEAD');
      const base = repeated?.base ?? start?.commit;
      if (!base) throw new AppError('INVALID_BASE', 'The project has no commit to start attempts from', 422);
      const warnings = repeated?.warnings ?? (start?.uncommitted ? ['项目有未提交的改动，它们不在并行尝试的起点里。'] : []);
      const group: StoredAttemptGroup = repeated ?? { id: randomUUID(), projectId: origin.id, prompt: input.prompt, base, createdAt: now(), attempts: [], requestFingerprint, warnings, ...(input.requestId ? { requestId: input.requestId } : {}), ...(input.runInput ? { runInput: input.runInput } : {}) };
      this.write(GROUPS, this.prune({ ...this.read(GROUPS), [group.id]: group }));
      for (let index = group.attempts.length; index < input.targets.length; index++) {
        const target = input.targets[index];
        const project = await this.worktreeProject(origin, base, target.backendId, true);
        const { session } = this.launch({ ...resolved[index], projectId: project.id, title: `${input.prompt.split('\n')[0].slice(0, 60)} · ${target.backendId ?? 'default'}` }, input.runInput ?? input.prompt, { kind: 'attempt', groupId: group.id });
        group.attempts.push({ sessionId: session.id, projectId: project.id, branch: project.worktree!.branch, target });
        // Written after every attempt so a failure part way still leaves the started ones findable.
        this.write(GROUPS, this.prune({ ...this.read(GROUPS), [group.id]: group }));
      }
      return { group, warnings };
    });
  }

  private prune(groups: Record<string, AttemptGroup>): Record<string, AttemptGroup> {
    const kept = Object.values(groups).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_GROUPS_KEPT);
    return Object.fromEntries(kept.map(group => [group.id, group]));
  }

  attemptGroups(projectId?: string): AttemptGroup[] {
    return Object.values(this.read<AttemptGroup>(GROUPS)).filter(group => !projectId || group.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  attemptGroup(id: string): AttemptGroup {
    const group = this.read<AttemptGroup>(GROUPS)[id];
    if (!group) throw new AppError('ATTEMPT_GROUP_NOT_FOUND', 'Attempt group does not exist', 404);
    return group;
  }

  /** Each attempt's state and what it changed against the shared base, read fresh from its worktree. */
  async compareAttempts(id: string): Promise<{ group: AttemptGroup; attempts: AttemptComparison[] }> {
    const { store, git } = this.deps;
    const group = this.attemptGroup(id);
    const attempts = await Promise.all(group.attempts.map(async (attempt): Promise<AttemptComparison> => {
      const row: AttemptComparison = { ...attempt };
      try { const session = store.getSession(attempt.sessionId); row.state = session.state; row.title = session.title; } catch { /* a deleted conversation still shows its branch */ }
      try { row.comparison = await git.compare(store.getProject(attempt.projectId), group.base); }
      catch (error) { row.error = error instanceof Error ? error.message : String(error); }
      return row;
    }));
    return { group, attempts };
  }

  /** Adds one more attempt to a group that has not been adopted yet, from the group's own base and prompt. */
  async addAttempt(id: string, target: LaunchTarget): Promise<{ group: AttemptGroup }> {
    return this.withOperation(`attempts-group:${id}`, async () => {
      const { store } = this.deps;
      const group = this.attemptGroup(id);
      if (group.adopted) throw new AppError('ATTEMPT_GROUP_ADOPTED', 'This attempt group already has an adopted result', 409);
      if (group.attempts.filter(item => !item.discardedAt).length >= MAX_ATTEMPTS) throw new AppError('INVALID_ATTEMPTS', `Keep at most ${MAX_ATTEMPTS} attempts in one group`, 409);
      const origin = store.getProject(group.projectId);
      const resolved = await resolveNativeSessionInput(this.deps, { ...target, projectId: origin.id });
      const project = await this.worktreeProject(origin, group.base, target.backendId, true);
      // Added and retried attempts run the group's original input, attachments and file references included.
      const runInput = this.read<StoredAttemptGroup>(GROUPS)[id]?.runInput;
      const { session } = this.launch({ ...resolved, projectId: project.id, title: `${group.prompt.split('\n')[0].slice(0, 60)} · ${target.backendId ?? 'default'}` }, runInput ?? group.prompt, { kind: 'attempt', groupId: group.id });
      const next: AttemptGroup = { ...group, attempts: [...group.attempts, { sessionId: session.id, projectId: project.id, branch: project.worktree!.branch, target }] };
      this.write(GROUPS, { ...this.read(GROUPS), [id]: next });
      return { group: next };
    });
  }

  /**
   * Archives one attempt's conversation and marks it discarded. Its worktree is removed only when
   * Git can do so without losing uncommitted work; otherwise the project stays findable and the
   * caller is told why.
   */
  async discardAttempt(id: string, sessionId: string, options: { removeWorktree?: boolean } = {}): Promise<{ group: AttemptGroup; warnings: string[] }> {
    return this.withOperation(`attempts-group:${id}`, async () => {
      const group = this.attemptGroup(id);
      const attempt = group.attempts.find(item => item.sessionId === sessionId);
      if (!attempt) throw new AppError('ATTEMPT_NOT_FOUND', 'This conversation is not part of the attempt group', 404);
      if (group.adopted?.sessionId === sessionId) throw new AppError('ATTEMPT_ADOPTED', 'The adopted attempt cannot be discarded', 409);
      if (!attempt.discardedAt && this.busy(sessionId)) throw new AppError('SESSION_BUSY', 'Stop this attempt before discarding it', 409);
      const warnings = await this.archiveAttempt(group, attempt, options.removeWorktree === true);
      const next: AttemptGroup = { ...group, attempts: group.attempts.map(item => item.sessionId === sessionId ? { ...item, discardedAt: item.discardedAt ?? now() } : item) };
      this.write(GROUPS, { ...this.read(GROUPS), [id]: next });
      return { group: next, warnings };
    });
  }

  /** Archives an attempt's conversation; with [remove], also removes its worktree when that loses nothing. Returns warnings. */
  private async archiveAttempt(group: AttemptGroup, attempt: AttemptGroup['attempts'][number], remove: boolean): Promise<string[]> {
    const { store, git } = this.deps;
    const warnings: string[] = [];
    try {
      const session = store.getSession(attempt.sessionId);
      if (!session.archivedAt) store.updateSession(session.id, { archivedAt: now(), state: 'archived' });
    } catch { /* a deleted conversation has nothing to archive */ }
    if (remove) {
      try {
        const worktree = store.getProject(attempt.projectId);
        await git.removeWorktree(store.getProject(group.projectId), worktree.cwd, { shadow: true });
        store.updateProject(worktree.id, { archivedAt: now() });
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
    return warnings;
  }

  /** Merges the chosen attempt into the project the group started from, then applies [cleanup] to the others. */
  async adoptAttempt(id: string, sessionId: string, options: { strategy?: 'merge' | 'squash'; message?: string; commitPending?: string; removeWorktree?: boolean; cleanup?: AttemptCleanup }): Promise<{ group: AttemptGroup; merge: MergeResult; warnings: string[] }> {
    return this.withOperation(`attempts-group:${id}`, async () => {
      const { store, git } = this.deps;
      const group = this.attemptGroup(id);
      const attempt = group.attempts.find(item => item.sessionId === sessionId);
      if (!attempt) throw new AppError('ATTEMPT_NOT_FOUND', 'This conversation is not part of the attempt group', 404);
      if (group.adopted) throw new AppError('ATTEMPT_GROUP_ADOPTED', 'This attempt group already has an adopted result', 409);
      if (attempt.discardedAt) throw new AppError('ATTEMPT_DISCARDED', 'This attempt was discarded', 409);
      if (this.busy(sessionId)) throw new AppError('SESSION_BUSY', 'Wait for this attempt to finish before merging it', 409);
      const { cleanup, ...mergeOptions } = options;
      // Only the merge itself needs the two workspaces it writes to; reserving the siblings too
      // would make adopting impossible while one of them is still running.
      const releaseWorkspace = this.deps.dispatch.reserveWorkspace([group.projectId, attempt.projectId]);
      let merge: MergeResult;
      try {
        const worktree = store.getProject(attempt.projectId);
        merge = await git.mergeWorktree(store.getProject(group.projectId), worktree, { ...mergeOptions, shadow: true, message: options.message ?? `${group.prompt.split('\n')[0].slice(0, 72)} (${attempt.target.backendId ?? 'attempt'})` });
        if (merge.removedWorktree) store.updateProject(worktree.id, { archivedAt: now() });
        const adopted: AttemptGroup = { ...group, adopted: { sessionId, at: now(), ...(merge.head ? { head: merge.head } : {}) } };
        this.write(GROUPS, { ...this.read(GROUPS), [id]: adopted });
      } finally { releaseWorkspace(); }
      const warnings: string[] = [];
      if (cleanup && cleanup !== 'keep') {
        for (const other of group.attempts) {
          if (other.sessionId === sessionId || other.discardedAt) continue;
          try { if (this.busy(other.sessionId)) await this.deps.dispatch.interrupt(other.sessionId); } catch { /* archiving below still applies */ }
          warnings.push(...await this.archiveAttempt(group, other, cleanup === 'remove'));
          const marked: AttemptGroup = { ...this.attemptGroup(id), attempts: this.attemptGroup(id).attempts.map(item => item.sessionId === other.sessionId ? { ...item, discardedAt: item.discardedAt ?? now() } : item) };
          this.write(GROUPS, { ...this.read(GROUPS), [id]: marked });
        }
      }
      return { group: this.attemptGroup(id), merge, warnings };
    });
  }

  // ---- Templates -------------------------------------------------------------------------------

  templates(): TaskTemplate[] { return Object.values(this.read<TaskTemplate>(TEMPLATES)).sort((a, b) => a.name.localeCompare(b.name)); }

  template(id: string): TaskTemplate {
    const template = this.read<TaskTemplate>(TEMPLATES)[id];
    if (!template) throw new AppError('TEMPLATE_NOT_FOUND', 'Template does not exist', 404);
    return template;
  }

  saveTemplate(id: string | undefined, body: Record<string, unknown>): TaskTemplate {
    const templates = this.read<TaskTemplate>(TEMPLATES);
    const current = id ? this.template(id) : undefined;
    if (!current && Object.keys(templates).length >= MAX_TEMPLATES) throw new AppError('TOO_MANY_TEMPLATES', `Keep at most ${MAX_TEMPLATES} templates`, 409);
    if (body.isolate !== undefined && typeof body.isolate !== 'boolean') throw new AppError('INVALID_INPUT', 'isolate must be a boolean');
    const stamp = now();
    const template: TaskTemplate = {
      id: current?.id ?? randomUUID(),
      name: body.name === undefined && current ? current.name : requireString(body.name, 'name', 100).trim(),
      prompt: body.prompt === undefined && current ? current.prompt : requireString(body.prompt, 'prompt', 100_000),
      ...(body.target === undefined && current ? launchTarget(current) : launchTarget(body.target)),
      ...((body.isolate ?? current?.isolate) ? { isolate: true } : {}),
      createdAt: current?.createdAt ?? stamp, updatedAt: stamp,
    };
    this.write(TEMPLATES, { ...templates, [template.id]: template });
    return template;
  }

  deleteTemplate(id: string): void {
    this.template(id);
    const users = Object.values(this.read<Schedule>(SCHEDULES)).filter(schedule => schedule.templateId === id);
    if (users.length) throw new AppError('TEMPLATE_IN_USE', 'Remove the schedules that run this template first', 409, { schedules: users.map(item => item.id) });
    const { [id]: _removed, ...rest } = this.read<TaskTemplate>(TEMPLATES);
    this.write(TEMPLATES, rest);
  }

  async runTemplate(id: string, projectId: string, ids: Ids = {}, origin?: SessionOrigin, targetOverride?: LaunchTarget): Promise<{ session: Session; run: Run }> {
    return this.withOperation(`launch:${ids.sessionId ?? randomUUID()}`, async () => {
      const provenance = origin ?? { kind: 'template', templateId: id };
      const again = this.relaunched(ids, provenance, projectId);
      if (again) return again;
      const template = this.template(id);
      const project = this.deps.store.getProject(projectId);
      const input = await resolveNativeSessionInput(this.deps, { ...(targetOverride ?? launchTarget(template)), projectId, title: template.name });
      const target = template.isolate ? await this.worktreeProject(project, 'HEAD', 'task') : project;
      if (provenance.scheduleId) {
        const schedule = this.schedule(provenance.scheduleId);
        if (schedule.projectId !== projectId || schedule.templateId !== id) throw new AppError('SCHEDULE_CHANGED', 'The scheduled task changed before it could start', 409);
      }
      return this.launch({ ...input, projectId: target.id }, renderTemplate(template.prompt, project), provenance, ids);
    });
  }

  // ---- Schedules -------------------------------------------------------------------------------

  schedules(): Schedule[] { return Object.values(this.read<Schedule>(SCHEDULES)).sort((a, b) => a.name.localeCompare(b.name)); }

  schedule(id: string): Schedule {
    const schedule = this.read<Schedule>(SCHEDULES)[id];
    if (!schedule) throw new AppError('SCHEDULE_NOT_FOUND', 'Schedule does not exist', 404);
    return schedule;
  }

  saveSchedule(id: string | undefined, body: Record<string, unknown>): Schedule {
    const schedules = this.read<Schedule>(SCHEDULES);
    const current = id ? this.schedule(id) : undefined;
    if (!current && Object.keys(schedules).length >= MAX_SCHEDULES) throw new AppError('TOO_MANY_SCHEDULES', `Keep at most ${MAX_SCHEDULES} schedules`, 409);
    const templateId = body.templateId === undefined && current ? current.templateId : requireString(body.templateId, 'templateId', 100);
    this.template(templateId);
    const projectId = body.projectId === undefined && current ? current.projectId : requireString(body.projectId, 'projectId', 100);
    this.deps.store.getProject(projectId);
    const cron = body.cron === undefined && current ? current.cron : requireString(body.cron, 'cron', 200).trim();
    parseCron(cron);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new AppError('INVALID_INPUT', 'enabled must be a boolean');
    const target = body.target === undefined ? current?.target ?? 'new' : body.target;
    if (target !== 'new' && target !== 'same') throw new AppError('INVALID_INPUT', 'target must be new or same');
    const enabled = (body.enabled as boolean | undefined) ?? current?.enabled ?? true;
    const stamp = now();
    const next = enabled ? current?.enabled && current.cron === cron ? current.nextRunAt : nextCronTime(parseCron(cron), new Date())?.toISOString() : undefined;
    if (enabled && !next) throw new AppError('INVALID_CRON', 'Cron has no matching time in the next four years');
    const { nextRunAt: _next, ...kept } = current ?? ({} as Partial<Schedule>);
    const schedule: Schedule = {
      ...kept,
      id: current?.id ?? randomUUID(),
      name: body.name === undefined && current ? current.name : requireString(body.name, 'name', 100).trim(),
      templateId, projectId, cron, enabled, target,
      ...(next ? { nextRunAt: next } : {}),
      createdAt: current?.createdAt ?? stamp, updatedAt: stamp,
    };
    // A different project or a switch to `new` must not keep sending into the old conversation.
    if (current && (current.projectId !== projectId || current.templateId !== templateId)) delete schedule.lastSessionId;
    this.write(SCHEDULES, { ...schedules, [schedule.id]: schedule });
    return schedule;
  }

  deleteSchedule(id: string): void {
    this.schedule(id);
    const { [id]: _removed, ...rest } = this.read<Schedule>(SCHEDULES);
    this.write(SCHEDULES, rest);
  }

  private record(id: string, patch: Partial<Schedule>, expected?: Schedule): Schedule | undefined {
    const schedules = this.read<Schedule>(SCHEDULES);
    if (!schedules[id]) return undefined;
    if (expected && (schedules[id].projectId !== expected.projectId || schedules[id].templateId !== expected.templateId)) return schedules[id];
    const schedule: Schedule = { ...schedules[id], ...patch };
    for (const key of Object.keys(patch) as Array<keyof Schedule>) if (patch[key] === undefined) delete schedule[key];
    this.write(SCHEDULES, { ...schedules, [id]: schedule });
    return schedule;
  }

  /**
   * Fires one schedule. A previous run still working means this one is skipped, not queued: a
   * nightly job that has not finished by morning should not stack another behind it.
   */
  fire(id: string, targetOverride?: LaunchTarget): Promise<Schedule> {
    if (this.closed) return Promise.reject(new AppError('SERVICE_CLOSED', 'The workbench is shutting down', 503));
    const pending = this.firing.get(id);
    if (pending) return pending;
    const task = this.fireSchedule(id, targetOverride).finally(() => { if (this.firing.get(id) === task) this.firing.delete(id); });
    this.firing.set(id, task);
    return task;
  }

  private async fireSchedule(id: string, targetOverride?: LaunchTarget): Promise<Schedule> {
    const schedule = this.schedule(id);
    const at = now();
    const previous = schedule.lastSessionId;
    if (previous && (() => { try { return this.busy(previous); } catch { return false; } })()) return this.record(id, { lastRunAt: at, lastResult: 'skipped', lastError: undefined })!;
    try {
      let sessionId: string;
      const reuse = schedule.target === 'same' && previous ? (() => { try { const session = this.deps.store.getSession(previous); return session.archivedAt || session.handedOffTo ? undefined : session; } catch { return undefined; } })() : undefined;
      if (reuse) {
        this.send(reuse.id, renderTemplate(this.template(schedule.templateId).prompt, this.deps.store.getProject(reuse.projectId)));
        sessionId = reuse.id;
      } else {
        sessionId = (await this.runTemplate(schedule.templateId, schedule.projectId, {}, { kind: 'schedule', scheduleId: id, templateId: schedule.templateId }, targetOverride)).session.id;
      }
      return this.record(id, { lastRunAt: at, lastResult: 'started', lastSessionId: sessionId, lastError: undefined }, schedule) ?? schedule;
    } catch (error) {
      return this.record(id, { lastRunAt: at, lastResult: 'failed', lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500) }, schedule) ?? schedule;
    }
  }

  /**
   * Due schedules have their next time written before they fire, so a crash mid-launch cannot
   * fire the same slot twice: a schedule runs at most once per slot.
   */
  tick(at = new Date()): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const task = this.tickDue(at).finally(() => { if (this.ticking === task) this.ticking = undefined; });
    this.ticking = task;
    return task;
  }

  private async tickDue(at: Date): Promise<void> {
    this.fireWakeups(at);
    for (const listed of this.schedules()) {
      // Earlier launches await I/O; another request may have edited or deleted a later row.
      const schedule = this.read<Schedule>(SCHEDULES)[listed.id];
      if (!schedule || this.closed) continue;
      if (!schedule.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > at.getTime()) continue;
      let next: string | undefined;
      try { next = nextCronTime(parseCron(schedule.cron), at)?.toISOString(); } catch { next = undefined; }
      this.record(schedule.id, { nextRunAt: next });
      if (at.getTime() - Date.parse(schedule.nextRunAt) > MISSED_AFTER_MS) { this.record(schedule.id, { lastResult: 'missed', lastError: undefined }); continue; }
      if (this.closed) return;
      await this.fire(schedule.id);
    }
  }

  // ---- One-shot wake-ups (docs/DEVICES.md §2) ---------------------------------------------------

  /** The conversation's wake-ups, soonest first; settled ones stay listed for a week. */
  wakeups(sessionId: string): RiffetWakeup[] {
    return Object.values(this.read<RiffetWakeup>(WAKEUPS)).filter(item => item.sessionId === sessionId).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }

  /** Every conversation's wake-ups still to fire. */
  pendingWakeups(): RiffetWakeup[] {
    return Object.values(this.read<RiffetWakeup>(WAKEUPS)).filter(item => item.status === 'pending');
  }

  private announceWakeup(wakeup: RiffetWakeup): void {
    try { this.deps.onWakeup?.(wakeup); } catch (error) { console.error('[orchestration] wake-up listener failed:', error); }
  }

  /** A turn in this same conversation at `dueAt`, carrying `note`. */
  scheduleWakeup(sessionId: string, input: { dueAt: Date; note: string }): RiffetWakeup {
    if (this.closed) throw new AppError('SERVICE_CLOSED', 'The workbench is shutting down', 503);
    const session = this.deps.store.getSession(sessionId);
    if (session.kind !== 'native' || session.backendId === 'chat') throw new AppError('NOT_NATIVE', 'Only agent conversations can be woken', 409);
    if (session.archivedAt || session.handedOffTo) throw new AppError('SESSION_NOT_ACTIVE', 'This conversation is archived or was handed off', 409);
    const due = input.dueAt.getTime(), at = Date.now();
    if (!Number.isFinite(due) || due < at - 60_000 || due > at + MAX_WAKEUP_AHEAD_MS) throw new AppError('INVALID_WAKEUP_TIME', 'Choose a time from now up to 30 days ahead');
    const note = input.note.trim();
    if (!note || note.length > 4000) throw new AppError('INVALID_WAKEUP_NOTE', 'Give the wake-up a note of at most 4000 characters');
    const all = this.prunedWakeups(at);
    if (Object.values(all).filter(item => item.sessionId === sessionId && item.status === 'pending').length >= MAX_PENDING_WAKEUPS_PER_SESSION) throw new AppError('TOO_MANY_WAKEUPS', `Keep at most ${MAX_PENDING_WAKEUPS_PER_SESSION} pending wake-ups per conversation`, 409);
    if (Object.keys(all).length >= MAX_WAKEUPS) throw new AppError('TOO_MANY_WAKEUPS', 'Too many wake-ups are scheduled', 409);
    const wakeup: RiffetWakeup = { id: randomUUID(), sessionId, dueAt: new Date(Math.max(due, at)).toISOString(), note, createdAt: now(), status: 'pending' };
    this.write(WAKEUPS, { ...all, [wakeup.id]: wakeup });
    this.armWakeups();
    this.announceWakeup(wakeup);
    return wakeup;
  }

  /** How many schedules last ran in one of these conversations; they go on, and start a new one next time. */
  schedulesUsing(sessionIds: readonly string[]): number {
    const ids = new Set(sessionIds);
    return Object.values(this.read<Schedule>(SCHEDULES)).filter(item => item.lastSessionId && ids.has(item.lastSessionId)).length;
  }

  /** Conversations about to be deleted: their pending wake-ups are cancelled while they still exist, so paired devices drop the leases. */
  cancelWakeupsOf(sessionIds: readonly string[]): void {
    const ids = new Set(sessionIds);
    for (const wakeup of Object.values(this.read<RiffetWakeup>(WAKEUPS))) if (ids.has(wakeup.sessionId) && wakeup.status === 'pending') this.cancelWakeup(wakeup.id);
  }

  /** Deleted conversations (inside the deletion's transaction): their wake-ups go, and no schedule names them as its last. */
  forgetSessions(sessionIds: readonly string[]): void {
    const ids = new Set(sessionIds);
    const wakeups = this.read<RiffetWakeup>(WAKEUPS);
    const kept = Object.fromEntries(Object.entries(wakeups).filter(([, item]) => !ids.has(item.sessionId)));
    if (Object.keys(kept).length !== Object.keys(wakeups).length) this.write(WAKEUPS, kept);
    const schedules = this.read<Schedule>(SCHEDULES);
    let changed = false;
    for (const schedule of Object.values(schedules)) if (schedule.lastSessionId && ids.has(schedule.lastSessionId)) { delete schedule.lastSessionId; changed = true; }
    if (changed) this.write(SCHEDULES, schedules);
  }

  /** Cancels a pending wake-up; `sessionId` confines the request to that conversation's own. */
  cancelWakeup(id: string, sessionId?: string): RiffetWakeup {
    const all = this.read<RiffetWakeup>(WAKEUPS), current = all[id];
    if (!current || (sessionId !== undefined && current.sessionId !== sessionId)) throw new AppError('WAKEUP_NOT_FOUND', 'Wake-up does not exist', 404);
    if (current.status !== 'pending') throw new AppError('WAKEUP_SETTLED', `This wake-up is already ${current.status}`, 409);
    const cancelled: RiffetWakeup = { ...current, status: 'cancelled' };
    this.write(WAKEUPS, { ...all, [id]: cancelled });
    this.armWakeups();
    this.announceWakeup(cancelled);
    return cancelled;
  }

  private prunedWakeups(at: number): Record<string, RiffetWakeup> {
    const all = this.read<RiffetWakeup>(WAKEUPS);
    const kept = Object.fromEntries(Object.entries(all).filter(([, item]) => item.status === 'pending' || at - Date.parse(item.firedAt ?? item.dueAt) < WAKEUP_RETENTION_MS));
    if (Object.keys(kept).length !== Object.keys(all).length) this.write(WAKEUPS, kept);
    return kept;
  }

  /**
   * Updates one wake-up if it is still in the state `from`. Every caller is synchronous from read to
   * write, so two firings cannot both see it pending.
   */
  private settleWakeup(id: string, from: RiffetWakeup['status'], patch: Partial<RiffetWakeup>): RiffetWakeup | undefined {
    const all = this.read<RiffetWakeup>(WAKEUPS), current = all[id];
    if (!current || current.status !== from) return undefined;
    const next: RiffetWakeup = { ...current, ...patch };
    this.write(WAKEUPS, { ...all, [id]: next });
    if (from === 'pending') this.announceWakeup(next);
    return next;
  }

  /** Wakes the scheduler at the next due wake-up, so one is not up to a scheduler interval late. */
  private armWakeups(): void {
    if (this.wakeupTimer) clearTimeout(this.wakeupTimer);
    this.wakeupTimer = undefined;
    if (this.closed) return;
    const next = Math.min(...Object.values(this.read<RiffetWakeup>(WAKEUPS)).filter(item => item.status === 'pending').map(item => Date.parse(item.dueAt)));
    if (!Number.isFinite(next)) return;
    // Capped so a clock change or a long sleep is corrected by the next arm.
    this.wakeupTimer = setTimeout(() => {
      this.wakeupTimer = undefined;
      try { this.fireWakeups(new Date()); } catch (error) { console.error('[orchestration] wake-up firing failed:', error); }
      this.armWakeups();
    }, Math.min(Math.max(next - Date.now(), 0) + 50, 60 * 60_000));
    this.wakeupTimer.unref();
  }

  /**
   * Due wake-ups are marked `fired` before their turn is sent, the schedules' write-before-dispatch
   * rule: a crash between the two loses the turn rather than sending it twice, and the turn's
   * command id is derived from the wake-up, so even a retried send is the same turn.
   */
  private fireWakeups(at: Date): void {
    for (const wakeup of Object.values(this.read<RiffetWakeup>(WAKEUPS))) {
      if (this.closed) return;
      if (wakeup.status !== 'pending' || Date.parse(wakeup.dueAt) > at.getTime()) continue;
      if (at.getTime() - Date.parse(wakeup.dueAt) > MISSED_AFTER_MS) {
        if (this.settleWakeup(wakeup.id, 'pending', { status: 'missed', firedAt: now(), error: 'The workbench was not running at the scheduled time' })) this.noticeWakeup(wakeup, '唤醒已错过：到点时 Riffet 未在运行');
        continue;
      }
      const fired = this.settleWakeup(wakeup.id, 'pending', { status: 'fired', firedAt: now() });
      if (!fired) continue;
      try {
        const session = this.deps.store.getSession(fired.sessionId);
        if (session.archivedAt) throw new AppError('ARCHIVED_SESSION', 'The conversation was archived');
        if (session.handedOffTo) throw new AppError('SESSION_HANDED_OFF', 'The conversation was handed off');
        const run = this.send(session.id, wakeupMessage(fired), `wakeup-${fired.id}`);
        this.settleWakeup(fired.id, 'fired', { runId: run.id });
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        this.settleWakeup(fired.id, 'fired', { status: 'failed', error: message });
        this.noticeWakeup(fired, `唤醒未能执行：${message}`);
      }
    }
  }

  private noticeWakeup(wakeup: RiffetWakeup, body: string): void {
    try { this.deps.notices?.add({ sessionId: wakeup.sessionId, title: wakeup.note.split('\n')[0]!.slice(0, 120), body, source: 'wakeup' }); } catch { /* the wake-up's own record says what happened */ }
  }
}

/** The turn a wake-up starts: the agent's own note, framed so it reads as the scheduled continuation. */
export function wakeupMessage(wakeup: Pick<RiffetWakeup, 'id' | 'createdAt' | 'dueAt' | 'note'>): string {
  return `[Riffet 唤醒] 这是你在 ${wakeup.createdAt} 用 schedule_wakeup 安排、定于 ${wakeup.dueAt} 的唤醒（${wakeup.id}）。说明：\n\n${wakeup.note}`;
}

/** The switched-off extensions a continuation keeps: names belong to one backend profile, so a different target starts clean. */
function sameLaunchExtensions(source: Session, input: { backendId: string; backendProfileId: string }): { extensionsOff?: string[] } {
  const same = source.backendId === input.backendId && source.backendProfileId === input.backendProfileId;
  return same && source.extensionsOff?.length ? { extensionsOff: source.extensionsOff } : {};
}
