import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type {
  AttemptCleanup,
  AttemptComparison,
  AttemptGroup,
  Automation,
  AutomationRun,
  AutomationTrigger,
  CapturedSessionReference,
  HandoffDraft,
  LaunchTarget,
  MergeResult,
  NativeRunInput,
  NativeSessionInput,
  Project,
  ReviewComment,
  RiffetWakeup,
  Run,
  Session,
  SessionOrigin,
  WorkbenchEvent,
} from '../../../../packages/contracts/src/index.js';
import { auxiliaryEndpoint, resolveAuxiliaryModel } from '../auxiliary/models.js';
import type { CompletionMetrics } from '../auxiliary/gateway.js';
import type { NativeBackendService } from '../backends/service.js';
import { AppError } from '../errors.js';
import { generatedBranch } from '../git/index.js';
import { servingKey } from '../journal/ingest.js';
import { NativeEventLog } from '../journal/native-log.js';
import { resolveNativeSessionInput, type NativeSessionRequest } from '../native/session-input.js';
import { extractIndexable } from '../search/messages.js';
import type { IdentifiedSession } from '../session-identity.js';
import { AttemptManager } from './attempts.js';
import { AutomationEngine } from './automations-engine.js';
import { continuationSection, sourceLanguage, summaryHeading, writeBrief, writeMaterial, type BriefSource } from './brief.js';
import { requestHandoffSummary } from './handoff-summary.js';
import {
  launchTarget, reviewComments, reviewMessage, sameLaunchExtensions, textInput, wakeupMessage,
  type FireOptions, type FrozenInput, type Ids, type OrchestrationDeps, type OrchestrationHost,
} from './shared.js';

export type { FrozenInput, OrchestrationDeps };
export { launchTarget, reviewComments, reviewMessage, wakeupMessage };

/**
 * Everything that opens or steers a conversation on someone's behalf: parallel attempts, forks,
 * handoffs, review feedback and automations. Each of them ends in the same two store
 * writes the composer uses — `createNativeSubmission` or `acceptNativeRun` — so the dispatcher,
 * recovery and idempotency treat these turns exactly like typed ones.
 */
export class OrchestrationService {
  private readonly operations = new Map<string, Promise<void>>();
  private closed = false;
  private readonly attempts: AttemptManager;
  private readonly automationsEngine: AutomationEngine;

  constructor(private readonly deps: OrchestrationDeps) {
    const host: OrchestrationHost = {
      isClosed: () => this.closed,
      withOperation: (key, operation) => this.withOperation(key, operation),
      busy: sessionId => this.busy(sessionId),
      relaunched: (ids, origin, projectId) => this.relaunched(ids, origin, projectId),
      launch: (input, text, origin, ids, attach) => this.launch(input, text, origin, ids, attach),
      send: (sessionId, text, commandId, snapshots) => this.send(sessionId, text, commandId, snapshots),
      worktreeProject: (origin, base, label, shadow, checkpointId) => this.worktreeProject(origin, base, label, shadow, checkpointId),
      launchAutomation: (automation, project, ids, targetOverride) => this.launchAutomation(automation, project, ids, targetOverride),
    };
    this.attempts = new AttemptManager(deps, host);
    this.automationsEngine = new AutomationEngine(deps, host);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([
      this.automationsEngine.close(),
      ...this.operations.values(),
    ]);
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

  private busy(sessionId: string): boolean {
    const session = this.deps.store.getSession(sessionId);
    return this.deps.store.listUnfinishedNativeRuns(sessionId).some(run => !run.native?.queueReleasedAt)
      || ['starting', 'running', 'waiting', 'cancelling'].includes(session.state)
      || ['starting', 'busy', 'attention'].includes(this.deps.nativeBackends.status(sessionId).phase);
  }

  /** True when a turn is actively executing (not merely queued behind a paused dispatcher). */
  private activelyRunning(sessionId: string): boolean {
    const session = this.deps.store.getSession(sessionId);
    if (['starting', 'running', 'waiting', 'cancelling'].includes(session.state)) return true;
    if (['starting', 'busy', 'attention'].includes(this.deps.nativeBackends.status(sessionId).phase)) return true;
    return this.deps.store.listUnfinishedNativeRuns(sessionId).some(run =>
      !run.native?.queueReleasedAt && ['preparing', 'dispatching', 'input_sent', 'observed'].includes(run.native?.delivery ?? ''),
    );
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

  /**
   * Opens a conversation with its first message, resolving the backend as the composer would.
   * [attach] runs in the creation's transaction, before anything else sees the new conversation.
   */
  private launch(input: NativeSessionInput, text: string | NativeRunInput, origin: SessionOrigin, ids: Ids = {}, attach?: (session: Session) => void): { session: Session; run: Run } {
    if (this.closed) throw new AppError('SERVICE_CLOSED', 'The workbench is shutting down', 503);
    const { store } = this.deps;
    const result = store.transaction(() => {
      const created = store.createNativeSubmission(ids.sessionId ?? randomUUID(), { ...input, origin }, ids.commandId ?? randomUUID(), typeof text === 'string' ? textInput(text) : text);
      if (!attach) return created;
      attach(created.session);
      return { ...created, session: store.getSession(created.session.id) };
    });
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
  private async worktreeProject(origin: Project, base: string, label?: string, shadow = false, checkpointId?: string): Promise<Project> {
    const namingOrigin = this.deps.store.getProject(this.deps.store.originChain(origin.id).at(-1) ?? origin.id);
    if (origin.system === 'task-workspace') throw new AppError('TASK_WORKSPACE_SAVE_REQUIRED', 'Save this task as a project before creating worktrees', 409);
    const branchName = generatedBranch(namingOrigin.name, { suffix: label });
    const created = (checkpointId && !shadow
      ? await this.deps.git.createWorktreeFromCheckpoint(origin, { branch: branchName, checkpointId }).catch(() => undefined)
      : undefined)
      ?? await this.deps.git.createWorktree(origin, { branch: branchName, base }, { shadow });
    const branch = created.branch ?? created.head.slice(0, 8);
    return this.deps.store.createProject(await realpath(created.path), `${origin.name} · ${branch}`, { originProjectId: origin.id, branch });
  }

  /** A worktree cut from the project's `HEAD` for another Agent called to work (docs/AGENT-CALLS.md §5), as an isolated fork gets. */
  async callWorktree(projectId: string): Promise<Project> {
    return await this.worktreeProject(this.deps.store.getProject(projectId), 'HEAD', 'call');
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

  private briefMessagesFromEvents(sessionId: string, events: readonly WorkbenchEvent[]): BriefSource['messages'] {
    const meta = new Map<string, { turnId?: string; runId?: string }>();
    for (const event of events) {
      const nativeId = (event as { nativeId?: unknown }).nativeId;
      const messageId = typeof nativeId === 'string' && nativeId ? nativeId : `${event.sequence}`;
      const existing = meta.get(messageId);
      const turnId = (event as { nativeTurnId?: unknown }).nativeTurnId;
      const runId = event.runId;
      if (!existing) {
        meta.set(messageId, {
          ...(typeof turnId === 'string' && turnId ? { turnId } : {}),
          ...(typeof runId === 'string' && runId ? { runId } : {}),
        });
      } else {
        if (!existing.turnId && typeof turnId === 'string' && turnId) existing.turnId = turnId;
        if (!existing.runId && typeof runId === 'string' && runId) existing.runId = runId;
      }
    }
    return extractIndexable(sessionId, events, Number.POSITIVE_INFINITY).map(row => {
      const ids = meta.get(row.messageId);
      return {
        kind: row.kind, text: row.text, at: row.at, messageId: row.messageId,
        ...(ids?.turnId ? { turnId: ids.turnId } : {}),
        ...(ids?.runId ? { runId: ids.runId } : {}),
      };
    });
  }

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
      messages = this.briefMessagesFromEvents(session.id, events);
    } catch { /* the transcript and the index are best-effort sources */ }
    if (!messages.length) {
      const { key } = servingKey(store.journal, session.id, 'main');
      const events = new NativeEventLog(store.journal, session.id, key).tail(Number.MAX_SAFE_INTEGER);
      messages = this.briefMessagesFromEvents(session.id, events);
    }
    if (!messages.length) messages = store.indexedMessages(session.id, { tools: true });
    const status = await git.status(store.getProject(session.projectId)).catch(() => undefined);
    return { session, runs: store.listRuns(session.id), messages, ...(status ? { status } : {}), ...(upToRunId ? { upToRunId } : {}) };
  }

  /**
   * Continues a conversation in a new one, optionally from an earlier turn, on another backend, or
   * in a fresh worktree. Code is not rewound in place: an isolated fork from an earlier turn starts
   * from that turn's checkpoint when one exists, and otherwise from `HEAD`. [attach] puts the new
   * conversation on its own task in the same write.
   */
  async fork(sessionId: string, options: { runId?: string; target?: LaunchTarget; isolate?: boolean; note?: string; attach?: (session: Session, source: Session) => void } & Ids): Promise<{ session: Session; run: Run }> {
    return this.withOperation(`launch:${options.sessionId ?? randomUUID()}`, async () => {
      const { store } = this.deps;
      const provenance: SessionOrigin = { kind: 'fork', sessionId, ...(options.runId ? { runId: options.runId } : {}) };
      const again = this.relaunched(options, provenance);
      if (again) return again;
      const source = store.getSession(sessionId);
      const targetRun = options.runId ? store.getRun(options.runId) : undefined;
      if (targetRun && targetRun.sessionId !== source.id) throw new AppError('RUN_NOT_FOUND', 'Run does not belong to this conversation', 404);
      if (!options.isolate && this.activelyRunning(source.id)) {
        throw new AppError('SESSION_BUSY', 'Stop or finish the current turn before forking in the same workspace, or isolate the fork in a new worktree', 409);
      }
      const origin = store.getProject(source.projectId);
      // Inherit the source's provider only while it still exists: a fork of a conversation whose
      // provider was removed must land on the backend's default, not fail on the dangling id.
      const sourceBackend = source.backendId;
      const inheritProfile = source.backendProfileId
        && this.deps.nativeBackends.catalog.profileSettings(sourceBackend).profiles.some(profile => profile.id === source.backendProfileId)
        ? source.backendProfileId : undefined;
      const target = options.target ?? { backendId: sourceBackend, ...(inheritProfile ? { backendProfileId: inheritProfile } : {}), ...(source.model ? { model: source.model } : {}), mode: source.mode, ...(source.approval ? { approval: source.approval } : {}) };
      const input = await resolveNativeSessionInput(this.deps, { ...target, projectId: origin.id, title: `${source.title} · 新会话` });
      const checkpoint = options.isolate && options.runId
        ? (await this.deps.git.checkpoints(origin).catch(() => [])).find(item => item.sessionId === source.id && item.runId === options.runId)
        : undefined;
      const project = options.isolate ? await this.worktreeProject(origin, 'HEAD', 'fork', false, checkpoint?.id) : origin;
      let nativeFork: Awaited<ReturnType<NativeBackendService['forkNativeSession']>>;
      try {
        nativeFork = await this.deps.nativeBackends.forkNativeSession(source, project, {
          backendId: input.backendId,
          ...(input.backendProfileId ? { backendProfileId: input.backendProfileId } : {}),
        }, {
          ...(options.runId ? { upToRunId: options.runId } : {}),
          ...(targetRun?.native?.nativeTurnId ? { upToNativeTurnId: targetRun.native.nativeTurnId } : {}),
          ...(targetRun?.native?.nativeMessageId ? { upToNativeMessageId: targetRun.native.nativeMessageId } : {}),
        });
        let text: string;
        if (nativeFork) {
          const lang = sourceLanguage({ session: source, runs: store.listRuns(source.id), messages: store.indexedMessages(source.id), ...(options.runId ? { upToRunId: options.runId } : {}) });
          text = options.note?.trim() || (lang === 'en'
            ? 'Briefly confirm your understanding of the current state, then wait for my next instruction without modifying files yet.'
            : '先用几句话确认你理解的现状，然后等我的下一步指示，暂时不要修改文件。');
        } else {
          const material = await this.briefSource(source, options.runId);
          text = `${writeBrief(material)}${continuationSection(sourceLanguage(material), 'fork', options.note)}`;
        }
        // Recheck at the synchronous acceptance boundary for non-isolated forks.
        if (!options.isolate && this.activelyRunning(source.id)) {
          throw new AppError('SESSION_BUSY', 'Stop or finish the current turn before forking in the same workspace, or isolate the fork in a new worktree', 409);
        }
        // A continuation keeps the tool groups its source was created with (docs/DEVICES.md §2).
        return this.launch({
          ...input,
          projectId: project.id,
          ...(nativeFork ? { nativeSessionId: nativeFork.nativeSessionId } : {}),
          ...(source.toolGroups?.length ? { toolGroups: source.toolGroups } : {}),
          ...sameLaunchExtensions(source, input),
        }, text, provenance, options, options.attach && (session => options.attach!(session, source)));
      } catch (error) {
        await nativeFork?.cleanup?.().catch(() => undefined);
        if (options.isolate && project.id !== origin.id) {
          await this.deps.git.discardWorktree(origin, project.cwd, project.worktree?.branch).catch(() => undefined);
          try { store.deleteProject(project.id); } catch { /* best-effort rollback */ }
        }
        throw error;
      }
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
    const language = sourceLanguage(material);
    const next = continuationSection(language, 'handoff', options.goal);
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
      return { text: `${summaryHeading(source, language)}\n\n${note}${next}`, generatedBy: { ...ref, profileName } };
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
      let text = options.text;
      if (text === undefined) {
        const material = await this.briefSource(source);
        text = `${writeBrief(material)}${continuationSection(sourceLanguage(material), 'handoff', options.note)}`;
      }
      const input = await resolveNativeSessionInput(this.deps, { ...options.target, projectId: source.projectId, title: source.title });
      // Transcript reads and backend validation await I/O. Recheck at the synchronous acceptance
      // boundary, since a user may have submitted another turn while the brief was being prepared.
      if (this.busy(source.id)) throw new AppError('SESSION_BUSY', 'Stop or finish the current turn before handing this conversation off', 409);
      if (this.closed) throw new AppError('SERVICE_CLOSED', 'The workbench is shutting down', 503);
      const { result, updated } = store.transaction(() => {
        const created = store.createNativeSubmission(
          options.sessionId ?? randomUUID(),
          { ...input, ...(source.toolGroups?.length ? { toolGroups: source.toolGroups } : {}), ...sameLaunchExtensions(source, input), origin: provenance },
          options.commandId ?? randomUUID(),
          textInput(text),
        );
        const marked = store.updateSession(source.id, { handedOffTo: created.session.id });
        return { result: created, updated: marked };
      });
      store.appendEvent(source.id, 'session', { session: updated });
      this.deps.dispatch.kick();
      return result;
    });
  }

  // ---- Parallel attempts -----------------------------------------------------------------------

  createAttempts(projectId: string, input: { prompt: string; targets: LaunchTarget[]; base?: string; requestId?: string; runInput?: NativeRunInput }): Promise<{ group: AttemptGroup; warnings: string[] }> {
    return this.attempts.createAttempts(projectId, input);
  }
  attemptGroups(projectId?: string): AttemptGroup[] { return this.attempts.attemptGroups(projectId); }
  attemptGroup(id: string): AttemptGroup { return this.attempts.attemptGroup(id); }
  compareAttempts(id: string): Promise<{ group: AttemptGroup; attempts: AttemptComparison[] }> { return this.attempts.compareAttempts(id); }
  addAttempt(id: string, target: LaunchTarget): Promise<{ group: AttemptGroup }> { return this.attempts.addAttempt(id, target); }
  discardAttempt(id: string, sessionId: string, options?: { removeWorktree?: boolean }): Promise<{ group: AttemptGroup; warnings: string[] }> { return this.attempts.discardAttempt(id, sessionId, options); }
  adoptAttempt(id: string, sessionId: string, options: { strategy?: 'merge' | 'squash'; message?: string; commitPending?: string; removeWorktree?: boolean; cleanup?: AttemptCleanup }): Promise<{ group: AttemptGroup; merge: MergeResult; warnings: string[] }> {
    return this.attempts.adoptAttempt(id, sessionId, options);
  }

  // ---- Automations (docs/ORCHESTRATION.md §5) --------------------------------------------------

  automations(): Automation[] { return this.automationsEngine.automations(); }
  automation(id: string): Automation { return this.automationsEngine.automation(id); }
  runs(automationId?: string, limit = 50, visibleIds?: readonly string[]): AutomationRun[] { return this.automationsEngine.runs(automationId, limit, visibleIds); }
  saveAutomation(id: string | undefined, body: Record<string, unknown>, creator: { createdBySessionId?: string } = {}, frozen?: FrozenInput): Automation {
    return this.automationsEngine.saveAutomation(id, body, creator, frozen);
  }
  existingFollowUp(id: string, body: Record<string, unknown>, input: NativeRunInput): Automation | undefined { return this.automationsEngine.existingFollowUp(id, body, input); }
  deleteAutomation(id: string): void { this.automationsEngine.deleteAutomation(id); }
  fire(id: string, options: FireOptions = {}): Promise<AutomationRun> { return this.automationsEngine.fire(id, options); }
  tick(at = new Date()): Promise<void> { return this.automationsEngine.tick(at); }
  wakeups(sessionId: string): RiffetWakeup[] { return this.automationsEngine.wakeups(sessionId); }
  pendingWakeups(): RiffetWakeup[] { return this.automationsEngine.pendingWakeups(); }
  scheduleWakeup(sessionId: string, input: { dueAt: Date; note: string }): RiffetWakeup { return this.automationsEngine.scheduleWakeup(sessionId, input); }
  cancelWakeup(id: string, sessionId?: string): RiffetWakeup { return this.automationsEngine.cancelWakeup(id, sessionId); }
  scheduleTask(sessionId: string, input: { name: string; prompt: string; trigger: AutomationTrigger; delivery: 'new' | 'same' }): Automation {
    return this.automationsEngine.scheduleTask(sessionId, input);
  }
  schedulesUsing(sessionIds: readonly string[]): number { return this.automationsEngine.schedulesUsing(sessionIds); }
  cancelWakeupsOf(sessionIds: readonly string[]): void { this.automationsEngine.cancelWakeupsOf(sessionIds); }
  forgetSessions(sessionIds: readonly string[]): void { this.automationsEngine.forgetSessions(sessionIds); }

  private launchAutomation(automation: Automation, project: Project, ids: Ids, targetOverride?: LaunchTarget): Promise<{ session: Session; run: Run }> {
    return this.automationsEngine.launchAutomation(automation, project, ids, targetOverride);
  }
}
