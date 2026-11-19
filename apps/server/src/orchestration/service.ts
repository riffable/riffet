import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { CapturedSessionReference, AttemptCleanup, AttemptComparison, AttemptGroup, HandoffDraft, LaunchTarget, MergeResult, NativeRunInput, NativeSessionInput, Project, Run, ReviewComment, Session, SessionOrigin, RiffetWakeup, Automation, AutomationRun, AutomationTrigger } from '../../../../packages/contracts/src/index.js';
import { isNativeBackendId } from '../backends/registry.js';
import type { NativeBackendService } from '../backends/service.js';
import { AppError, requireString } from '../errors.js';
import type { IdentifiedSession } from '../session-identity.js';
import { generatedBranch, type GitService } from '../git/index.js';
import type { NativeDispatcher } from '../native/dispatch.js';
import { resolveNativeSessionInput, type NativeSessionRequest } from '../native/session-input.js';
import { servingKey } from '../journal/ingest.js';
import { NativeEventLog } from '../journal/native-log.js';
import { extractIndexable } from '../search/messages.js';
import type { SettingsService } from '../settings/index.js';
import type { Store } from '../store.js';
import { auxiliaryEndpoint, resolveAuxiliaryModel } from '../auxiliary/models.js';
import type { CompletionMetrics } from '../auxiliary/gateway.js';
import type { AuxiliaryCallRecorder } from '../auxiliary/telemetry.js';
import { summaryHeading, writeBrief, writeMaterial, type BriefSource } from './brief.js';
import { requestHandoffSummary } from './handoff-summary.js';
import type { SessionCommands } from './session-commands.js';
import { nextCronTime, parseCron } from './cron.js';
import { AutomationStore } from './automation-store.js';
import { latestDue, nameFromPrompt, nextTime, parseTriggers, renderPrompt, serverTimeZone } from './automation.js';
import type { NoticeLog } from '../riffet-mcp/notices.js';

/*
 * Attempt groups live in the settings table under this key, one JSON map: they are few, small and
 * written by one process. Automations and their runs have tables of their own (`AutomationStore`).
 */
const GROUPS = 'orchestration:attempt-groups';
/** Before 0.7 templates, schedules and wake-ups were settings keys; `migrateLegacyAutomations` folds them in once. */
const LEGACY_TEMPLATES = 'orchestration:templates';
const LEGACY_SCHEDULES = 'orchestration:schedules';
const LEGACY_WAKEUPS = 'orchestration:wakeups';
const MAX_ATTEMPTS = 4;
const MAX_AUTOMATIONS = 250;
const MAX_AUTOMATIONS_PER_AGENT_SESSION = 10;
const MIN_AGENT_CRON_GAP_MS = 15 * 60_000;
const MAX_GROUPS_KEPT = 100;
/** A follow-up that should have run longer ago than this — the workbench was off — is recorded missed, not sent late. */
const SKIP_CATCH_UP_MS = 60 * 60 * 1000;
/** `catchUp: 'latest'` still runs a time missed up to this long ago. */
const LATEST_CATCH_UP_MS = 7 * 24 * 60 * 60 * 1000;
/** Later than this after its time, a run counts as a catch-up rather than on time. */
const ON_TIME_MS = 2 * 60 * 1000;
const SCHEDULER_INTERVAL_MS = 30_000;
const MAX_PENDING_FOLLOW_UPS_PER_SESSION = 20;
const MAX_FOLLOW_UPS = 500;
const MAX_WAKEUP_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
/** Settled follow-ups are kept this long for `list_wakeups` and the conversation's own view. */
const FOLLOW_UP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface OrchestrationDeps { store: Store; settings: SettingsService; nativeBackends: NativeBackendService; git: GitService; dispatch: NativeDispatcher; sessionCommands: SessionCommands; schedulerIntervalMs?: number; notices?: NoticeLog;
  recordAuxiliaryCall?: AuxiliaryCallRecorder;
  /** Told of every wake-up that was scheduled or left `pending`; device leases follow it (docs/DEVICES.md §3). */
  onWakeup?: (wakeup: RiffetWakeup) => void; }
interface Ids { sessionId?: string; commandId?: string }
const HANDOFF_NEXT = '先用几句话确认你理解的现状和尚未完成的部分，然后继续完成它。';
type StoredAttemptGroup = AttemptGroup & { requestId?: string; requestFingerprint?: string; warnings?: string[]; runInput?: NativeRunInput };

const now = () => new Date().toISOString();
/** Where a user follow-up keeps the session references it froze when it was scheduled; the blobs belong to the conversation. */
const snapshotsKey = (automationId: string): string => `automation-snapshots:${automationId}`;
/** What the route captured under one transaction: the composer's input beyond the text, and the frozen session references. */
export interface FrozenInput { input: NativeRunInput; snapshots: CapturedSessionReference[] }
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
  // A quick chat is started in its own project, never by an automation, fork or attempt.
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

/**
 * Everything that opens or steers a conversation on someone's behalf: parallel attempts, forks,
 * handoffs, review feedback and automations. Each of them ends in the same two store
 * writes the composer uses — `createNativeSubmission` or `acceptNativeRun` — so the dispatcher,
 * recovery and idempotency treat these turns exactly like typed ones.
 */
export class OrchestrationService {
  private readonly timer: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private readonly operations = new Map<string, Promise<void>>();
  private readonly firing = new Map<string, Promise<AutomationRun>>();
  private readonly automationStore: AutomationStore;
  private readonly startTimer: NodeJS.Timeout;
  private followUpTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly deps: OrchestrationDeps) {
    this.automationStore = new AutomationStore(deps.store.db);
    this.migrateLegacyAutomations();
    const tick = () => { void this.tick().catch(error => console.error('[orchestration] schedule tick failed:', error)); };
    this.timer = setInterval(tick, deps.schedulerIntervalMs ?? SCHEDULER_INTERVAL_MS);
    this.timer.unref();
    // What came due while the server was off runs now, not at the first interval.
    this.startTimer = setTimeout(tick, 0);
    this.startTimer.unref();
    this.armFollowUps();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.startTimer);
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
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
    if (!run || (ids.commandId && run.commandId !== ids.commandId) || !session.origin || (['kind', 'sessionId', 'runId', 'groupId', 'automationId', 'templateId', 'scheduleId'] as const).some(key => session.origin?.[key] !== origin[key])
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
  private send(sessionId: string, text: string | NativeRunInput, commandId: string = randomUUID(), snapshots?: CapturedSessionReference[]): Run {
    const input = typeof text === 'string' ? textInput(text) : text;
    const session = this.deps.store.getSession(sessionId);
    if (session.kind !== 'native') throw new AppError('NOT_NATIVE', 'Only native conversations accept text input', 409);
    const existing = this.deps.store.findRunByCommand(session.id, commandId);
    if (existing) return this.deps.store.acceptNativeRun(session.id, commandId, input, existing.native!.config);
    this.deps.sessionCommands.admit(session);
    this.deps.nativeBackends.assertAvailable(session);
    const run = this.deps.store.acceptNativeRun(session.id, commandId, input, { model: session.model, mode: session.mode, approval: session.approval }, undefined, undefined, snapshots);
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

  /** A plain message into a conversation, as the owner would send it; `commandId` makes a retry send nothing new. */
  message(sessionId: string, text: string, commandId: string): Run {
    return this.send(sessionId, text, commandId);
  }

  /**
   * A new conversation in [projectId] on [backendId] (else the owner's default) with the owner's saved
   * defaults, opened with [text], as the composer would. [attach] runs in the same write, before the
   * conversation's CLI can start, so whatever it records is there from its first turn.
   */
  async open(target: { projectId: string; backendId?: string; backendProfileId?: string; model?: string; title?: string }, text: string, attach: (sessionId: string) => void): Promise<Session> {
    if (this.closed) throw new AppError('SERVICE_CLOSED', 'The workbench is shutting down', 503);
    const input = await resolveNativeSessionInput(this.deps, { projectId: target.projectId, ...(target.backendId ? { backendId: target.backendId } : {}), ...(target.backendProfileId ? { backendProfileId: target.backendProfileId } : {}), ...(target.model ? { model: target.model } : {}), ...(target.title ? { title: target.title } : {}) });
    const result = this.deps.store.transaction(() => {
      const created = this.deps.store.createNativeSubmission(randomUUID(), input, randomUUID(), textInput(text));
      attach(created.session.id);
      return created;
    });
    this.deps.dispatch.kick();
    return this.deps.store.getSession(result.session.id);
  }

  /**
   * A conversation the server opens on someone's behalf, like the 助理's background runs (docs/ASSISTANT.md §7):
   * resolved as the composer would, with [origin] recorded. The same [ids] return the conversation the first try made.
   */
  async start(body: NativeSessionRequest, text: string, origin: SessionOrigin, ids: Required<Ids>): Promise<Session> {
    const { session } = await this.withOperation(`launch:${ids.sessionId}`, async () => {
      const again = this.relaunched(ids, origin, body.projectId);
      if (again) return again;
      const input = await resolveNativeSessionInput(this.deps, body);
      return this.launch(input, text, origin, ids);
    });
    return session;
  }

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
        && this.deps.nativeBackends.catalog.profileSettings(sourceBackend).profiles.some(profile => profile.id === source.backendProfileId)
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
    const ref = resolveAuxiliaryModel(settings.getSettings(), 'handoff');
    if (!ref) return { text: `${writeBrief(material)}${next}` };
    const authStartedAt = Date.now();
    let endpoint: Awaited<ReturnType<typeof auxiliaryEndpoint>> | undefined;
    let metrics: CompletionMetrics | undefined;
    const callStartedAt = Date.now();
    try {
      endpoint = await auxiliaryEndpoint(ref, backendId => nativeBackends.catalog.gatewayProfiles(backendId), options.signal);
      const authMs = Math.max(0, Date.now() - authStartedAt);
      const { profileName, ...gateway } = endpoint;
      const note = await requestHandoffSummary(gateway, writeMaterial(material), {
        ...(options.goal?.trim() ? { goal: options.goal.trim() } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        onMetrics: recorded => { metrics = recorded; },
      });
      this.deps.recordAuxiliaryCall?.({
        kind: 'handoff', preset: 'long', source: 'live',
        backendId: ref.backendId, profileId: ref.profileId, model: ref.model,
        transport: (gateway.executeComplete || gateway.executeStreamChat) ? 'cli-process' : 'http',
        protocol: gateway.protocol,
        ok: metrics?.ok ?? true, authMs, ttftMs: metrics?.ttftMs ?? null,
        durationMs: metrics?.durationMs ?? Math.max(0, Date.now() - callStartedAt),
        inputTokens: metrics?.inputTokens ?? null, outputTokens: metrics?.outputTokens ?? null,
        reasoningTokens: metrics?.reasoningTokens ?? null, reasoningChars: metrics?.reasoningChars ?? 0,
        thinkingDetected: metrics?.thinkingDetected ?? false, streaming: metrics?.streaming ?? false,
      });
      return { text: `${summaryHeading(source)}\n\n${note}${next}`, generatedBy: { ...ref, profileName } };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (endpoint) {
        this.deps.recordAuxiliaryCall?.({
          kind: 'handoff', preset: 'long', source: 'live',
          backendId: ref.backendId, profileId: ref.profileId, model: ref.model,
          transport: (endpoint.executeComplete || endpoint.executeStreamChat) ? 'cli-process' : 'http',
          protocol: endpoint.protocol,
          ok: false, authMs: Math.max(0, Date.now() - authStartedAt), ttftMs: metrics?.ttftMs ?? null,
          durationMs: metrics?.durationMs ?? Math.max(0, Date.now() - callStartedAt),
          inputTokens: metrics?.inputTokens ?? null, outputTokens: metrics?.outputTokens ?? null,
          reasoningTokens: metrics?.reasoningTokens ?? null, reasoningChars: metrics?.reasoningChars ?? 0,
          thinkingDetected: metrics?.thinkingDetected ?? false, streaming: metrics?.streaming ?? false,
          errorCode: metrics?.errorCode ?? 'ERROR',
        });
      }
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

  // ---- Automations (docs/ORCHESTRATION.md §5) --------------------------------------------------

  automations(): Automation[] { return this.automationStore.all().sort((a, b) => a.name.localeCompare(b.name) || a.createdAt.localeCompare(b.createdAt)); }

  automation(id: string): Automation {
    const item = this.automationStore.get(id);
    if (!item) throw new AppError('AUTOMATION_NOT_FOUND', 'Automation does not exist', 404);
    return item;
  }

  /** The newest runs of one automation, or of all of them. */
  runs(automationId?: string, limit = 50, visibleIds?: readonly string[]): AutomationRun[] {
    if (automationId !== undefined) { this.automation(automationId); return this.automationStore.runs(automationId); }
    return this.automationStore.allRuns(Math.min(Math.max(Math.trunc(limit) || 50, 1), 500), visibleIds ?? this.automationStore.all().map(item => item.id));
  }

  /**
   * Creates or edits an automation. A body with `followUp` creates a user's follow-up (send later);
   * its `by` is never taken from the request. An agent's follow-up is made by `scheduleWakeup`.
   */
  saveAutomation(id: string | undefined, body: Record<string, unknown>, creator: { createdBySessionId?: string } = {}, frozen?: FrozenInput): Automation {
    if (this.closed) throw new AppError('SERVICE_CLOSED', 'The workbench is shutting down', 503);
    const current = id ? this.automation(id) : undefined;
    if (body.followUp !== undefined) {
      if (current) throw new AppError('INVALID_INPUT', 'followUp cannot be changed');
      const raw = (body.followUp && typeof body.followUp === 'object' ? body.followUp : {}) as Record<string, unknown>;
      if (raw.by !== undefined && raw.by !== 'user') throw new AppError('INVALID_INPUT', 'by is set by the server');
      const triggers = parseTriggers(body.triggers);
      if (triggers.length !== 1 || triggers[0]!.kind !== 'once') throw new AppError('INVALID_INPUT', 'A follow-up has exactly one once trigger');
      return this.insertFollowUp(requireString(raw.sessionId, 'sessionId', 100), 'user', { prompt: requireString(body.prompt, 'prompt', 100_000), triggers, ...(frozen ? { frozen } : {}), ...(body.id !== undefined ? { id: requireString(body.id, 'id', 100) } : {}) });
    }
    if (current?.followUp) throw new AppError('FOLLOW_UP_READONLY', 'A follow-up cannot be edited; cancel or delete it', 409);
    if (!current && this.automationStore.count('other') >= MAX_AUTOMATIONS) throw new AppError('TOO_MANY_AUTOMATIONS', `Keep at most ${MAX_AUTOMATIONS} automations`, 409);
    for (const key of ['isolate', 'enabled'] as const) if (body[key] !== undefined && typeof body[key] !== 'boolean') throw new AppError('INVALID_INPUT', `${key} must be a boolean`);
    const prompt = body.prompt === undefined && current ? current.prompt : requireString(body.prompt, 'prompt', 100_000);
    const name = body.name === undefined && current ? current.name : requireString(body.name, 'name', 100).trim();
    const target = body.target === undefined && current ? launchTarget(current) : launchTarget(body.target);
    let projectId = current?.projectId;
    if (body.projectId !== undefined) projectId = body.projectId === null || body.projectId === '' ? undefined : requireString(body.projectId, 'projectId', 100);
    if (projectId && projectId !== current?.projectId) this.deps.store.getProject(projectId);
    const triggers = body.triggers === undefined ? current?.triggers ?? [] : parseTriggers(body.triggers);
    if (triggers.length && !projectId) throw new AppError('INVALID_INPUT', 'Choose a project for an automation that runs by itself');
    const delivery = body.delivery === undefined ? current?.delivery ?? 'new' : body.delivery;
    if (delivery !== 'new' && delivery !== 'same') throw new AppError('INVALID_INPUT', 'delivery must be new or same');
    const catchUp = body.catchUp === undefined ? current?.catchUp ?? 'latest' : body.catchUp;
    if (catchUp !== 'latest' && catchUp !== 'skip') throw new AppError('INVALID_INPUT', 'catchUp must be latest or skip');
    const enabled = (body.enabled as boolean | undefined) ?? current?.enabled ?? true;
    const stamp = new Date();
    let next: string | undefined;
    if (enabled && triggers.length) {
      next = nextTime(triggers, stamp, new Date(stamp.getTime() - 60_000))?.toISOString();
      // A finished one-time automation stays finished when edited, however the client re-encodes its time;
      // only one that had a next time must still have one.
      if (!next && !(current && !current.nextRunAt && current.enabled === enabled)) throw new AppError('INVALID_TRIGGER', 'The triggers have no upcoming time');
    }
    const { nextRunAt: _next, ...kept } = current ?? ({} as Partial<Automation>);
    const item: Automation = {
      ...kept, id: current?.id ?? randomUUID(), name, prompt, ...target,
      ...(projectId ? { projectId } : {}), ...((body.isolate ?? current?.isolate) ? { isolate: true } : {}),
      triggers, delivery, catchUp, enabled,
      ...(creator.createdBySessionId ? { createdBySessionId: creator.createdBySessionId } : {}),
      ...(next ? { nextRunAt: next } : {}),
      createdAt: current?.createdAt ?? stamp.toISOString(), updatedAt: stamp.toISOString(),
    };
    if (!projectId) delete item.projectId;
    if (!item.isolate) delete item.isolate;
    // Another project must not keep sending into the old project's conversation.
    if (current && current.projectId !== projectId) delete item.lastSessionId;
    this.automationStore.put(item);
    return item;
  }

  /** Removes the record and lets go of the session references it froze, unless a run took them over or another follow-up holds the same ones. */
  private removeAutomation(id: string): void {
    const item = this.automationStore.get(id);
    const frozen = this.deps.store.getSetting<CapturedSessionReference[]>(snapshotsKey(id), []);
    this.automationStore.remove(id);
    this.deps.store.deleteSetting(snapshotsKey(id));
    if (!item?.followUp || !frozen.length) return;
    const recipient = item.followUp.sessionId, db = this.deps.store.db;
    const heldByRun = db.prepare("SELECT 1 AS one FROM runs r, json_each(r.json,'$.native.contextSnapshots') c WHERE r.session_id=? AND json_extract(c.value,'$.snapshotRef')=? LIMIT 1");
    const heldByOther = db.prepare("SELECT 1 AS one FROM settings s, json_each(s.json) c WHERE s.key LIKE 'automation-snapshots:%' AND json_extract(c.value,'$.snapshotRef')=? LIMIT 1");
    const free = frozen.map(ref => ref.snapshotRef).filter(ref => !heldByRun.get(recipient, ref) && !heldByOther.get(ref));
    if (free.length) this.deps.store.journal.releaseSessionBlobs(recipient, free);
  }

  /** The follow-up an earlier request with this client id made, when this one says the same; another content under the id is a conflict. */
  existingFollowUp(id: string, body: Record<string, unknown>, input: NativeRunInput): Automation | undefined {
    const existing = this.automationStore.get(id);
    if (!existing) return undefined;
    const triggers = parseTriggers(body.triggers), raw = (body.followUp && typeof body.followUp === 'object' ? body.followUp : {}) as Record<string, unknown>;
    const held = existing.input ?? { attachmentIds: [], context: [] };
    const sameInput = JSON.stringify({ a: input.attachmentIds, c: input.context, r: input.references ?? [] }) === JSON.stringify({ a: held.attachmentIds, c: held.context, r: held.references ?? [] });
    const at = triggers[0]?.kind === 'once' ? Date.parse(triggers[0].at) : NaN, was = existing.triggers[0]?.kind === 'once' ? Date.parse(existing.triggers[0].at) : NaN;
    if (existing.followUp?.by !== 'user' || existing.followUp.sessionId !== raw.sessionId || existing.prompt !== input.text || !sameInput || triggers.length !== 1 || !(at <= was)) throw new AppError('AUTOMATION_ID_CONFLICT', 'This id was already used for another follow-up', 409);
    return existing;
  }

  deleteAutomation(id: string): void {
    const item = this.automation(id);
    // Deleting an agent's follow-up cancels it: the record stays for `list_wakeups` until it ages out.
    if (item.followUp?.by === 'agent') { if (this.isPending(item)) this.cancelWakeup(id); return; }
    if (item.followUp && !this.isPending(item)) throw new AppError('FOLLOW_UP_SETTLED', 'This follow-up has already run or was cancelled', 409);
    this.deps.store.transaction(() => this.removeAutomation(id));
    if (item.followUp) this.armFollowUps();
  }

  /** Runs one now, under the skip-while-busy rule of its timer; the next timed run is unchanged. */
  fire(id: string, options: FireOptions = {}): Promise<AutomationRun> {
    if (this.closed) return Promise.reject(new AppError('SERVICE_CLOSED', 'The workbench is shutting down', 503));
    const pending = this.firing.get(id);
    if (pending) return pending;
    const task = this.execute(id, options).finally(() => { if (this.firing.get(id) === task) this.firing.delete(id); });
    this.firing.set(id, task);
    return task;
  }

  /** Records the run and the automation's summary together; a run of a deleted automation is not kept. */
  private settle(automation: Automation, run: Omit<AutomationRun, 'id'> & { id?: string }): AutomationRun {
    const record: AutomationRun = { ...run, id: run.id ?? randomUUID() };
    if (record.error) record.error = record.error.slice(0, 500);
    this.deps.store.transaction(() => {
      const current = this.automationStore.get(automation.id);
      if (!current) return;
      this.automationStore.addRun(record);
      const next: Automation = { ...current, lastRunAt: record.at, lastResult: record.result };
      if (record.result === 'failed' && record.error) next.lastError = record.error; else delete next.lastError;
      // A launch that finished after the project was changed must not restore a conversation of the old one.
      if (record.sessionId && current.projectId === automation.projectId) next.lastSessionId = record.sessionId;
      this.automationStore.put(next);
    });
    return record;
  }

  private sessionBusy(sessionId: string): boolean { try { return this.busy(sessionId); } catch { return false; } }

  private async execute(id: string, options: FireOptions): Promise<AutomationRun> {
    const automation = this.automation(id);
    const cause = options.cause ?? 'manual';
    const manual = cause === 'manual';
    const commandId = options.ids?.commandId;
    // A retried manual run is the run it was: same command, same record.
    const runId = manual && commandId ? `${id}:${commandId}` : randomUUID();
    if (manual && commandId) { const done = this.automationStore.run(runId); if (done) return done; }
    const base = { id: runId, automationId: id, cause, ...(options.scheduledFor ? { scheduledFor: options.scheduledFor } : {}), at: now() };
    if (automation.followUp) throw new AppError('FOLLOW_UP_READONLY', 'A follow-up cannot be run by hand', 409);
    const skip = (reason: NonNullable<AutomationRun['reason']>) => this.settle(automation, { ...base, result: 'skipped', reason });
    const projectId = automation.projectId ?? options.projectId;
    if (!projectId) throw new AppError('INVALID_INPUT', 'Choose a project to run this in');
    let project: Project | undefined;
    // A project the caller named is theirs to get right; one the automation saved may be gone.
    if (manual && !automation.projectId) project = this.deps.store.getProject(projectId);
    else { try { project = this.deps.store.getProject(projectId); } catch { project = undefined; } }
    if (!project || project.archivedAt) return skip('project-unavailable');
    const previous = automation.lastSessionId;
    if (previous && this.sessionBusy(previous)) return skip('busy');
    try {
      const reuse = automation.delivery === 'same' && previous ? (() => { try { const session = this.deps.store.getSession(previous); return session.archivedAt || session.handedOffTo ? undefined : session; } catch { return undefined; } })() : undefined;
      if (reuse) {
        const run = this.send(reuse.id, renderPrompt(automation, this.deps.store.getProject(reuse.projectId)), commandId);
        return this.settle(automation, { ...base, result: 'started', sessionId: reuse.id, runId: run.id });
      }
      const created = await this.launchAutomation(automation, project, options.ids ?? {}, options.target);
      return this.settle(automation, { ...base, result: 'started', sessionId: created.session.id, runId: created.run.id });
    } catch (error) {
      // A person who asked gets the refusal; a timer's failure is the record.
      if (manual && error instanceof AppError) throw error;
      return this.settle(automation, { ...base, result: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async launchAutomation(automation: Automation, project: Project, ids: Ids, targetOverride?: LaunchTarget): Promise<{ session: Session; run: Run }> {
    return this.withOperation(`launch:${ids.sessionId ?? randomUUID()}`, async () => {
      const origin: SessionOrigin = { kind: 'automation', automationId: automation.id };
      const again = this.relaunched(ids, origin, project.id);
      if (again) return again;
      const input = await resolveNativeSessionInput(this.deps, { ...launchTarget(automation), ...targetOverride, projectId: project.id, title: automation.name });
      const target = automation.isolate ? await this.worktreeProject(project, 'HEAD', 'task') : project;
      return this.launch({ ...input, projectId: target.id }, renderPrompt(automation, project), origin, ids);
    });
  }

  /**
   * A turn in the follow-up's conversation. An agent's carries its note framed as the wake-up it
   * asked for, with the command id `wakeup-<id>`; a user's sends the prompt as typed under
   * `follow-up-<id>`. Either way the id names the follow-up, so a retried send is the same turn.
   * It is not skipped when the conversation is busy: it queues like a typed message.
   */
  private runFollowUp(automation: Automation, base: { id: string; automationId: string; cause: AutomationRun['cause']; scheduledFor?: string; at: string }, commandId?: string): AutomationRun {
    const followUp = automation.followUp!;
    const settle = (patch: Pick<AutomationRun, 'result'> & Partial<AutomationRun>) => {
      const run = this.settle(automation, { ...base, ...patch });
      if (followUp.by === 'agent') this.announceWakeup(this.wakeupOf(this.automationStore.get(automation.id) ?? automation));
      return run;
    };
    const fail = (message: string, unavailable: boolean) => {
      const run = settle({ result: 'failed', error: message, ...(unavailable ? { reason: 'session-unavailable' as const } : {}) });
      this.noticeFollowUp(automation, `${followUp.by === 'agent' ? '唤醒' : '定时发送'}未能执行：${run.error}`);
      return run;
    };
    let session: Session;
    try { session = this.deps.store.getSession(followUp.sessionId); } catch (error) { return fail(error instanceof Error ? error.message : String(error), true); }
    if (session.archivedAt) return fail('The conversation was archived', true);
    if (session.handedOffTo) return fail('The conversation was handed off', true);
    try {
      const text = followUp.by === 'agent' ? wakeupMessage({ id: automation.id, createdAt: automation.createdAt, dueAt: base.scheduledFor ?? automation.nextRunAt ?? base.at, note: automation.prompt }) : automation.prompt;
      const input: string | NativeRunInput = followUp.by === 'user' && automation.input ? { ...automation.input, text } : text;
      const snapshots = followUp.by === 'user' && automation.input?.references?.length ? this.deps.store.getSetting<CapturedSessionReference[]>(snapshotsKey(automation.id), []) : undefined;
      const run = this.send(session.id, input, commandId ?? `${followUp.by === 'agent' ? 'wakeup' : 'follow-up'}-${automation.id}`, snapshots);
      return settle({ result: 'started', sessionId: session.id, runId: run.id });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), false);
    }
  }

  private noticeFollowUp(automation: Automation, body: string): void {
    const followUp = automation.followUp;
    if (!followUp) return;
    try { this.deps.notices?.add({ sessionId: followUp.sessionId, title: automation.prompt.split('\n')[0]!.slice(0, 120), body, source: 'wakeup' }); } catch { /* the run record says what happened */ }
  }

  /**
   * Due automations have their next time written before they run, so a crash mid-launch cannot
   * run the same slot twice: an automation runs at most once per slot.
   */
  tick(at = new Date()): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const task = this.tickDue(at).finally(() => { if (this.ticking === task) this.ticking = undefined; });
    this.ticking = task;
    return task;
  }

  /** Moves a due automation's next time past `at` before anything starts; undefined when another caller already took the slot. */
  private claim(id: string, at: Date): { automation: Automation; due: Date; late: number } | undefined {
    const current = this.automationStore.get(id);
    if (!current || !current.enabled || !current.nextRunAt || Date.parse(current.nextRunAt) > at.getTime()) return undefined;
    const next = nextTime(current.triggers, at)?.toISOString();
    const claimed: Automation = { ...current };
    if (next) claimed.nextRunAt = next; else delete claimed.nextRunAt;
    // A follow-up with nothing left to run is settled.
    if (current.followUp && !next) claimed.enabled = false;
    this.automationStore.put(claimed);
    // `latest` stands for the most recent time that passed, not the oldest one still unrun.
    const listed = new Date(current.nextRunAt);
    let due = listed;
    if (current.catchUp === 'latest' && !current.followUp && at.getTime() - listed.getTime() > ON_TIME_MS) { const recent = latestDue(current.triggers, at); if (recent && recent > due) due = recent; }
    return { automation: { ...claimed, nextRunAt: current.nextRunAt }, due, late: at.getTime() - listed.getTime() };
  }

  /** How late a claimed slot is: on time, a catch-up that still runs, or missed. */
  private slotKind(automation: Automation, due: Date, at: Date, late: number): 'schedule' | 'catch-up' | 'missed' {
    if (at.getTime() - due.getTime() > (automation.catchUp === 'latest' ? LATEST_CATCH_UP_MS : SKIP_CATCH_UP_MS)) return 'missed';
    return late > ON_TIME_MS ? 'catch-up' : 'schedule';
  }

  private settleMissed(automation: Automation, due: Date): void {
    const base = { automationId: automation.id, cause: 'schedule' as const, scheduledFor: due.toISOString(), at: now() };
    this.settle(automation, { ...base, result: 'missed', reason: 'offline' });
    if (automation.followUp) {
      this.noticeFollowUp(automation, `${automation.followUp.by === 'agent' ? '唤醒' : '定时发送'}已错过：到点时 Riffet 未在运行`);
      if (automation.followUp.by === 'agent') this.announceWakeup(this.wakeupOf(this.automationStore.get(automation.id) ?? automation));
    }
  }

  /** Follow-ups are sent synchronously, so the exact timer can run them without waiting for a tick. */
  private runDueFollowUps(at: Date): void {
    for (const listed of this.automationStore.due(at.toISOString())) {
      if (this.closed) return;
      if (!listed.followUp) continue;
      const slot = this.claim(listed.id, at);
      if (!slot) continue;
      const kind = this.slotKind(slot.automation, slot.due, at, slot.late);
      if (kind === 'missed') this.settleMissed(slot.automation, slot.due);
      else this.runFollowUp(slot.automation, { id: randomUUID(), automationId: listed.id, cause: kind, scheduledFor: slot.due.toISOString(), at: now() });
    }
  }

  private async tickDue(at: Date): Promise<void> {
    this.pruneFollowUps(at.getTime());
    this.runDueFollowUps(at);
    this.armFollowUps();
    for (const listed of this.automationStore.due(at.toISOString())) {
      // Earlier launches await I/O; another request may have edited or deleted a later row.
      if (this.closed) return;
      if (listed.followUp) continue;
      const slot = this.claim(listed.id, at);
      if (!slot) continue;
      const kind = this.slotKind(slot.automation, slot.due, at, slot.late);
      if (kind === 'missed') { this.settleMissed(slot.automation, slot.due); continue; }
      if (this.firing.has(listed.id)) {
        // A run by hand is still going: this slot is not queued behind it.
        this.settle(slot.automation, { automationId: listed.id, cause: kind, scheduledFor: slot.due.toISOString(), at: now(), result: 'skipped', reason: 'busy' });
        continue;
      }
      try { await this.fire(listed.id, { cause: kind, scheduledFor: slot.due.toISOString() }); } catch (error) { console.error('[orchestration] automation run failed:', error); }
    }
  }

  // ---- Follow-ups: wake-ups an agent asked for and messages a user sent for later (docs/DEVICES.md §2) ----

  private isPending(item: Automation): boolean { return item.enabled && item.nextRunAt !== undefined; }

  /** The wake-up an agent follow-up reads as; `cancelled` is a settled one that never ran. */
  private wakeupOf(item: Automation): RiffetWakeup {
    const pending = this.isPending(item);
    const lastResult = item.lastResult;
    const status: RiffetWakeup['status'] = pending ? 'pending' : lastResult === 'started' ? 'fired' : lastResult === 'missed' ? 'missed' : lastResult ? 'failed' : 'cancelled';
    const dueAt = item.triggers.flatMap(trigger => trigger.kind === 'once' ? [trigger.at] : []).sort()[0] ?? item.createdAt;
    const wakeup: RiffetWakeup = { id: item.id, sessionId: item.followUp!.sessionId, dueAt, note: item.prompt, createdAt: item.createdAt, status };
    if (!pending && item.lastRunAt && lastResult) wakeup.firedAt = item.lastRunAt;
    if (status === 'fired') { const runId = this.automationStore.runs(item.id)[0]?.runId; if (runId) wakeup.runId = runId; }
    const error = item.lastError ?? (status === 'missed' ? 'The workbench was not running at the scheduled time' : undefined);
    if (error) wakeup.error = error;
    return wakeup;
  }

  private agentFollowUps(sessionId?: string): Automation[] { return this.automationStore.followUps(sessionId).filter(item => item.followUp?.by === 'agent'); }

  /** The conversation's wake-ups, soonest first; settled ones stay listed for a week. */
  wakeups(sessionId: string): RiffetWakeup[] {
    return this.agentFollowUps(sessionId).map(item => this.wakeupOf(item)).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }

  /** Every conversation's wake-ups still to fire. */
  pendingWakeups(): RiffetWakeup[] {
    return this.agentFollowUps().filter(item => this.isPending(item)).map(item => this.wakeupOf(item));
  }

  private announceWakeup(wakeup: RiffetWakeup): void {
    try { this.deps.onWakeup?.(wakeup); } catch (error) { console.error('[orchestration] wake-up listener failed:', error); }
  }

  /** A turn in this same conversation at `dueAt`, carrying `note`. */
  scheduleWakeup(sessionId: string, input: { dueAt: Date; note: string }): RiffetWakeup {
    const note = input.note.trim();
    const item = this.insertFollowUp(sessionId, 'agent', { prompt: note, triggers: [{ kind: 'once', at: input.dueAt.toISOString() }] });
    return this.wakeupOf(item);
  }

  private insertFollowUp(sessionId: string, by: 'agent' | 'user', input: { prompt: string; triggers: AutomationTrigger[]; frozen?: FrozenInput; id?: string }): Automation {
    if (this.closed) throw new AppError('SERVICE_CLOSED', 'The workbench is shutting down', 503);
    const session = this.deps.store.getSession(sessionId);
    if (session.kind !== 'native' || session.backendId === 'chat') throw new AppError('NOT_NATIVE', by === 'agent' ? 'Only agent conversations can be woken' : 'Only agent conversations take later messages', 409);
    if (session.archivedAt || session.handedOffTo) throw new AppError('SESSION_NOT_ACTIVE', 'This conversation is archived or was handed off', 409);
    const at = Date.now();
    const triggers = input.triggers.map((trigger): AutomationTrigger => {
      const due = trigger.kind === 'once' ? Date.parse(trigger.at) : NaN;
      if (!Number.isFinite(due) || due < at - 60_000 || (by === 'agent' && due > at + MAX_WAKEUP_AHEAD_MS)) throw new AppError('INVALID_WAKEUP_TIME', by === 'agent' ? 'Choose a time from now up to 30 days ahead' : 'Choose a time from now on');
      return { kind: 'once', at: new Date(Math.max(due, at)).toISOString() };
    });
    const prompt = input.prompt.trim();
    if (!prompt || prompt.length > (by === 'agent' ? 4000 : 100_000)) throw new AppError('INVALID_WAKEUP_NOTE', by === 'agent' ? 'Give the wake-up a note of at most 4000 characters' : 'Give the message a text');
    this.pruneFollowUps(at);
    const all = this.automationStore.followUps();
    if (all.filter(item => item.followUp!.sessionId === sessionId && this.isPending(item)).length >= MAX_PENDING_FOLLOW_UPS_PER_SESSION) throw new AppError('TOO_MANY_WAKEUPS', `Keep at most ${MAX_PENDING_FOLLOW_UPS_PER_SESSION} pending follow-ups per conversation`, 409);
    if (all.length >= MAX_FOLLOW_UPS) throw new AppError('TOO_MANY_WAKEUPS', 'Too many follow-ups are scheduled', 409);
    const stamp = now();
    const item: Automation = {
      id: input.id ?? randomUUID(), name: nameFromPrompt(prompt), prompt, projectId: session.projectId, triggers,
      delivery: 'same', catchUp: 'skip', enabled: true, followUp: { sessionId, by },
      nextRunAt: triggers.map(trigger => (trigger as { at: string }).at).sort()[0]!, createdAt: stamp, updatedAt: stamp,
    };
    if (input.frozen) {
      const { attachmentIds, context, references } = input.frozen.input;
      item.input = { attachmentIds, context, ...(references?.length ? { references } : {}) };
      if (input.frozen.snapshots.length) this.deps.store.setSetting(snapshotsKey(item.id), input.frozen.snapshots);
    }
    this.automationStore.put(item);
    this.armFollowUps();
    if (by === 'agent') this.announceWakeup(this.wakeupOf(item));
    return item;
  }

  /** Cancels a pending wake-up; `sessionId` confines the request to that conversation's own. */
  cancelWakeup(id: string, sessionId?: string): RiffetWakeup {
    const current = this.automationStore.get(id);
    if (!current || current.followUp?.by !== 'agent' || (sessionId !== undefined && current.followUp.sessionId !== sessionId)) throw new AppError('WAKEUP_NOT_FOUND', 'Wake-up does not exist', 404);
    if (!this.isPending(current)) throw new AppError('WAKEUP_SETTLED', `This wake-up is already ${this.wakeupOf(current).status}`, 409);
    const { nextRunAt: _next, ...rest } = current;
    const cancelled: Automation = { ...rest, enabled: false, updatedAt: now() };
    this.automationStore.put(cancelled);
    this.armFollowUps();
    const view = this.wakeupOf(cancelled);
    this.announceWakeup(view);
    return view;
  }

  /** Settled follow-ups age out after a week. */
  private pruneFollowUps(at: number): void {
    for (const item of this.automationStore.followUps()) {
      if (!this.isPending(item) && at - Date.parse(item.lastRunAt ?? item.updatedAt) >= FOLLOW_UP_RETENTION_MS) this.deps.store.transaction(() => this.removeAutomation(item.id));
    }
  }

  /** Wakes the scheduler at the next due follow-up, so one is not up to a scheduler interval late. */
  private armFollowUps(): void {
    if (this.followUpTimer) clearTimeout(this.followUpTimer);
    this.followUpTimer = undefined;
    if (this.closed) return;
    const next = this.automationStore.nextFollowUp();
    if (next === undefined) return;
    // Capped so a clock change or a long sleep is corrected by the next arm.
    this.followUpTimer = setTimeout(() => {
      this.followUpTimer = undefined;
      try { this.runDueFollowUps(new Date()); } catch (error) { console.error('[orchestration] follow-up failed:', error); }
      this.armFollowUps();
    }, Math.min(Math.max(Date.parse(next) - Date.now(), 0) + 50, 60 * 60_000));
    this.followUpTimer.unref();
  }

  // ---- schedule_task (Riffet MCP) -------------------------------------------------------------

  /** An automation an agent made in its conversation's project, on its conversation's backend and model. */
  scheduleTask(sessionId: string, input: { name: string; prompt: string; trigger: AutomationTrigger; delivery: 'new' | 'same' }): Automation {
    const session = this.deps.store.getSession(sessionId);
    if (session.kind !== 'native' || session.backendId === 'chat') throw new AppError('NOT_NATIVE', 'Only agent conversations can schedule tasks', 409);
    if (session.origin?.kind === 'automation') throw new AppError('NOT_ALLOWED', 'A scheduled run cannot schedule more tasks', 409);
    if (input.trigger.kind === 'cron') {
      const cron = parseCron(input.trigger.cron);
      let cursor = new Date();
      for (let index = 0; index < 8; index++) {
        const next = nextCronTime(cron, cursor, input.trigger.timeZone);
        if (!next) break;
        if (index > 0 && next.getTime() - cursor.getTime() < MIN_AGENT_CRON_GAP_MS) throw new AppError('INVALID_TRIGGER', 'A scheduled task repeats at most every 15 minutes');
        cursor = next;
      }
    }
    if (this.automationStore.count('created-by', sessionId) >= MAX_AUTOMATIONS_PER_AGENT_SESSION) throw new AppError('TOO_MANY_AUTOMATIONS', `A conversation can schedule at most ${MAX_AUTOMATIONS_PER_AGENT_SESSION} tasks`, 409);
    return this.saveAutomation(undefined, {
      name: input.name, prompt: input.prompt, projectId: session.projectId, delivery: input.delivery, triggers: [input.trigger],
      target: { backendId: session.backendId, backendProfileId: session.backendProfileId, ...(session.model ? { model: session.model } : {}), ...(session.mode ? { mode: session.mode } : {}), ...(session.approval ? { approval: session.approval } : {}) },
    }, { createdBySessionId: sessionId });
  }

  // ---- Conversations going away (session-deletion.ts) ------------------------------------------

  /** How many automations last ran in one of these conversations; they go on, and start a new one next time. Follow-ups go with the conversation and are not counted. */
  schedulesUsing(sessionIds: readonly string[]): number {
    return this.automationStore.usingSessions(sessionIds).filter(item => !item.followUp).length;
  }

  /** Conversations about to be deleted: their pending wake-ups are cancelled while they still exist, so paired devices drop the leases. */
  cancelWakeupsOf(sessionIds: readonly string[]): void {
    const ids = new Set(sessionIds);
    for (const item of this.agentFollowUps()) if (ids.has(item.followUp!.sessionId) && this.isPending(item)) this.cancelWakeup(item.id);
  }

  /** Deleted conversations (inside the deletion's transaction): their follow-ups go, and no automation names them as its last. */
  forgetSessions(sessionIds: readonly string[]): void {
    for (const id of sessionIds) {
      for (const item of this.automationStore.followUps(id)) this.removeAutomation(item.id);
      for (const item of this.automationStore.usingSessions([id])) { const { lastSessionId: _gone, ...rest } = item; this.automationStore.put(rest); }
    }
    this.armFollowUps();
  }

  // ---- Migration of the 0.6 settings keys --------------------------------------------------------

  /**
   * Templates, schedules and wake-ups used to be settings keys. One transaction turns them into
   * automations and deletes the keys, so a failure leaves the old data for the next start and a
   * finished one leaves nothing to repeat. Wake-ups keep their ids: the commands they sent
   * (`wakeup-<id>`) and the leases devices hold are named by them.
   */
  private migrateLegacyAutomations(): void {
    const { store } = this.deps;
    const keys = [LEGACY_TEMPLATES, LEGACY_SCHEDULES, LEGACY_WAKEUPS];
    if (keys.every(key => store.getSetting<unknown>(key, undefined) === undefined)) return;
    type LegacyTemplate = LaunchTarget & { id: string; name: string; prompt: string; isolate?: boolean; createdAt: string; updatedAt: string };
    type LegacySchedule = { id: string; name: string; templateId: string; projectId: string; cron: string; enabled: boolean; target: 'new' | 'same'; nextRunAt?: string; lastRunAt?: string; lastSessionId?: string; lastResult?: Automation['lastResult']; lastError?: string; createdAt: string; updatedAt: string };
    type LegacyWakeup = { id: string; sessionId: string; dueAt: string; note: string; createdAt: string; status: RiffetWakeup['status']; firedAt?: string; runId?: string; error?: string };
    try {
      store.transaction(() => {
        const templates = store.getSetting<Record<string, LegacyTemplate>>(LEGACY_TEMPLATES, {});
        const schedules = Object.values(store.getSetting<Record<string, LegacySchedule>>(LEGACY_SCHEDULES, {}));
        const wakeups = Object.values(store.getSetting<Record<string, LegacyWakeup>>(LEGACY_WAKEUPS, {}));
        const zone = serverTimeZone();
        const used = new Set<string>();
        const put = (item: Automation) => { if (!this.automationStore.get(item.id)) this.automationStore.put(item); };
        for (const schedule of schedules) {
          const template = templates[schedule.templateId];
          if (!template) { console.warn(`[orchestration] migration dropped schedule ${schedule.id}: its template ${schedule.templateId} is gone`); continue; }
          used.add(template.id);
          const triggers: AutomationTrigger[] = [{ kind: 'cron', cron: schedule.cron, timeZone: zone }];
          const next = schedule.enabled ? schedule.nextRunAt ?? nextTime(triggers, new Date())?.toISOString() : undefined;
          put({
            id: schedule.id, name: schedule.name, prompt: template.prompt, ...launchTarget(template), projectId: schedule.projectId,
            ...(template.isolate ? { isolate: true } : {}), triggers, delivery: schedule.target, catchUp: 'latest', enabled: schedule.enabled && next !== undefined,
            ...(next ? { nextRunAt: next } : {}),
            ...(schedule.lastRunAt ? { lastRunAt: schedule.lastRunAt } : {}), ...(schedule.lastResult ? { lastResult: schedule.lastResult } : {}),
            ...(schedule.lastError ? { lastError: schedule.lastError } : {}), ...(schedule.lastSessionId ? { lastSessionId: schedule.lastSessionId } : {}),
            createdAt: schedule.createdAt, updatedAt: schedule.updatedAt,
          });
        }
        for (const template of Object.values(templates)) {
          if (used.has(template.id)) continue;
          put({
            id: template.id, name: template.name, prompt: template.prompt, ...launchTarget(template), ...(template.isolate ? { isolate: true } : {}),
            triggers: [], delivery: 'new', catchUp: 'latest', enabled: true, createdAt: template.createdAt, updatedAt: template.updatedAt,
          });
        }
        for (const wakeup of wakeups) {
          let projectId: string;
          try { projectId = store.getSession(wakeup.sessionId).projectId; } catch { console.warn(`[orchestration] migration dropped wake-up ${wakeup.id}: its conversation ${wakeup.sessionId} is gone`); continue; }
          const pending = wakeup.status === 'pending';
          const item: Automation = {
            id: wakeup.id, name: nameFromPrompt(wakeup.note), prompt: wakeup.note, projectId, triggers: [{ kind: 'once', at: wakeup.dueAt }],
            delivery: 'same', catchUp: 'skip', enabled: pending, followUp: { sessionId: wakeup.sessionId, by: 'agent' },
            ...(pending ? { nextRunAt: wakeup.dueAt } : {}), createdAt: wakeup.createdAt, updatedAt: wakeup.firedAt ?? wakeup.createdAt,
          };
          const result: AutomationRun['result'] | undefined = wakeup.status === 'fired' ? 'started' : wakeup.status === 'failed' ? 'failed' : wakeup.status === 'missed' ? 'missed' : undefined;
          if (result) {
            const at = wakeup.firedAt ?? wakeup.dueAt;
            item.lastRunAt = at; item.lastResult = result;
            if (result === 'failed' && wakeup.error) item.lastError = wakeup.error;
            if (result === 'started') item.lastSessionId = wakeup.sessionId;
          }
          put(item);
          if (result) this.automationStore.addRun({
            id: randomUUID(), automationId: wakeup.id, cause: 'schedule', scheduledFor: wakeup.dueAt, at: wakeup.firedAt ?? wakeup.dueAt, result,
            ...(result === 'missed' ? { reason: 'offline' as const } : {}), ...(result === 'failed' && wakeup.error ? { error: wakeup.error } : {}),
            ...(result === 'started' ? { sessionId: wakeup.sessionId, ...(wakeup.runId ? { runId: wakeup.runId } : {}) } : {}),
          });
        }
        for (const key of keys) store.deleteSetting(key);
      });
    } catch (error) { console.error('[orchestration] migrating templates, schedules and wake-ups failed; retrying on next start:', error); }
  }
}

interface FireOptions {
  cause?: AutomationRun['cause'];
  scheduledFor?: string;
  /** For an automation saved without a project. */
  projectId?: string;
  ids?: Ids;
  /** Fills in what the automation leaves unset (an old client's compatible backend). */
  target?: LaunchTarget;
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
