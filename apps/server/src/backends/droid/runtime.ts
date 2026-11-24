import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type {
  NativeContext, NativeInteraction, NativeInteractionResponse, NativeInteractionResult, NativeRunConfig,
  NativeRunInput, NativeStatus, Project, Session,
} from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { ActivityLedger, withActivity } from '../../journal/activity.js';
import { firstHumanMessage, firstMessageTitlePatch, providerTitlePatch } from '../../session-title.js';
import { childHasExited, waitForExit } from '../shared/child-process.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativeControlMessage, NativeDispatchBinding } from '../types.js';
import { droidUserEventId, projectDroidMessage, projectDroidTurnEnd, type DroidAttachmentInfo } from './events.js';
import { findDroidTranscript, readDroidSessionSettings, readDroidTranscript, type DroidTranscript } from './history.js';
import { DROID_RPC_ERRORS, DroidRpcClient, DroidRpcError } from './rpc.js';
import { DroidTranscriptSource } from './transcript.js';
import { listDroidModels } from './runtime-discovery.js';
import {
  finishDroidSubagent, handleDroidNotification, handleDroidRequest, keepDroidEvents, keepLateDroidCommand,
  refreshDroidContext, type DroidEventHost,
} from './runtime-events.js';
import {
  askUserQuestions, BUSY_STATES, cancelResult, confirmDroidSettings, desiredSettings, droidAutonomy, droidModelValue,
  droidSettingsOverlay, droidTurns, dropPending, errorMessage, IDLE_STOP_MS, IMAGE_MEDIA_TYPES, MAX_INLINE_IMAGE_BYTES,
  notify, questionAnswer, questionInteraction, readSettings, RECENT_MESSAGES, settingsChange, spawnDroid,
  START_TIMEOUT_MS, STDERR_TAIL, str, type DroidConversation, type DroidProcess, type DroidSettings,
} from './runtime-shared.js';

export { DROID_AUTONOMY_LEVELS, DROID_MODES, droidAutonomy, droidMode, droidModelValue, droidSettingsOverlay } from './runtime-shared.js';
export { probeDroidCli, listDroidModels, listDroidSlashItems, droidSlashItems, droidModelInfos } from './runtime-discovery.js';

/** Owns one `droid exec` process per open conversation and routes its stream to the workbench. */
export class DroidRuntime {
  private readonly conversations = new Map<string, DroidConversation>();

  constructor(private readonly host: NativeBackendHost) {}

  private eventHost(): DroidEventHost {
    return {
      host: this.host,
      emitStatus: state => this.emitStatus(state),
      stop: (state, proc) => this.stop(state, proc),
      scheduleIdleStop: state => this.scheduleIdleStop(state),
      applySettings: (state, proc, change, desired) => this.applySettings(state, proc, change, desired),
      contextBudgetChanged: (proc, desired) => this.contextBudgetChanged(proc, desired),
      hasActiveWork: state => this.hasActiveWork(state),
      endUnechoed: (state, commands, reason) => this.endUnechoed(state, commands, reason),
    };
  }

  conversation(session: Session, project: Project, profile: NativeBackendProfileConfig): DroidConversation {
    const existing = this.conversations.get(session.id);
    if (existing) {
      if (existing.nativeSessionId && session.nativeSessionId && existing.nativeSessionId !== session.nativeSessionId) {
        throw new AppError('NATIVE_SESSION_SCOPE_MISMATCH', 'This Droid conversation is bound to a different Droid session', 409);
      }
      existing.session = session;
      existing.project = project;
      existing.profile = profile;
      existing.nativeSessionId ??= session.nativeSessionId;
      return existing;
    }
    const state: DroidConversation = {
      workbenchSessionId: session.id,
      session,
      project,
      profile,
      ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
      listeners: new Set(),
      wakers: new Set(),
      events: new Map(),
      working: 'idle',
      turnActive: false,
      status: { phase: 'idle' },
      drafts: new Map(),
      subagents: new Map(),
      loaded: false,
      commands: new Map(),
      lateCommands: new Map(),
      turns: new Map(),
      pending: [],
      configuring: 0,
      disposed: false,
      metrics: new Map(),
      steps: new Map(),
      activities: new ActivityLedger(() => this.emitStatus(state)),
      compactions: 0,
    };
    state.status = this.statusOf(state);
    this.conversations.set(session.id, state);
    return state;
  }

  status(session: Session): NativeStatus {
    return this.conversations.get(session.id)?.status ?? { phase: 'idle' };
  }

  interaction(session: Session): NativeInteraction | undefined {
    return this.conversations.get(session.id)?.pending[0]?.interaction;
  }

  context(session: Session): NativeContext | undefined {
    return this.conversations.get(session.id)?.context;
  }

  isRunning(sessionId: string): boolean {
    const proc = this.conversations.get(sessionId)?.proc;
    return Boolean(proc && !proc.exited);
  }

  subscribe(session: Session, project: Project, profile: NativeBackendProfileConfig, listener: (message: NativeControlMessage) => void): () => void {
    const state = this.conversation(session, project, profile);
    state.listeners.add(listener);
    listener({ type: 'context', ...(state.context ? { context: state.context } : {}) });
    void this.ensureLoaded(state);
    return () => { state.listeners.delete(listener); };
  }

  /**
   * The conversation's transcript for the session journal (sync v3): Droid's session file, woken by this
   * process's notifications, with the text it is streaming and the subagents it has running.
   */
  transcriptSource(session: Session, profile: NativeBackendProfileConfig): DroidTranscriptSource {
    const sessionId = session.id;
    const current = () => { try { return this.host.getSession(sessionId); } catch { return undefined; } };
    return new DroidTranscriptSource({
      sessionId,
      nativeSessionId: () => current()?.nativeSessionId,
      locate: async nativeSessionId => {
        const latest = current();
        return latest ? await findDroidTranscript(nativeSessionId, this.host.getProject(latest.projectId).cwd) : undefined;
      },
      live: {
        watch: wake => {
          const latest = this.host.getSession(sessionId);
          const state = this.conversation(latest, this.host.getProject(latest.projectId), profile);
          state.wakers.add(wake);
          return () => { state.wakers.delete(wake); };
        },
        streaming: () => [...this.conversations.get(sessionId)?.drafts.values() ?? []],
        running: () => [...this.conversations.get(sessionId)?.subagents.values() ?? []]
          .filter(item => item.running).map(item => ({ toolCallId: item.toolCallId, childId: item.childId, ...(item.subagentType ? { subagentType: item.subagentType } : {}) })),
        command: messageId => {
          const known = this.conversations.get(sessionId)?.turns.get(messageId);
          if (known) return known;
          // After a restart only the run the dispatcher bound to the echoed prompt knows it.
          const runId = this.host.findRunIdByNativeMessage(sessionId, droidUserEventId(messageId));
          return runId ? { runId } : undefined;
        },
      },
    });
  }

  /**
   * Binds the conversation without starting Droid: its transcript reads from disk, and the process
   * (which also creates the Droid session of a new conversation) starts with the first send.
   */
  open(session: Session, project: Project, profile: NativeBackendProfileConfig): { nativeSessionId?: string; status: NativeStatus } {
    const state = this.conversation(session, project, profile);
    return { ...(state.nativeSessionId ? { nativeSessionId: state.nativeSessionId } : {}), status: state.status };
  }

  async send(input: {
    session: Session;
    project: Project;
    profile: NativeBackendProfileConfig;
    commandId: string;
    runId: string;
    input: NativeRunInput;
    config: NativeRunConfig;
    isCancelled(): boolean;
    commitDispatchFence(binding?: NativeDispatchBinding): unknown;
  }): Promise<void> {
    const state = this.conversation(input.session, input.project, input.profile);
    const prompt = await this.materialize(input.input);
    if (input.isCancelled()) return;
    const desired = desiredSettings(input.profile, input.config);
    const proc = await this.ensureProcess(state, desired);
    if (proc.stopping || proc.exited || proc.modelMismatch) throw new AppError('NATIVE_SETTINGS_UNCONFIRMED', state.failure ?? 'Droid stopped before confirming this send. No prompt was sent.', 503);
    const change = settingsChange(state.reported, desired);
    if (change) await this.applySettings(state, proc, change, desired);
    confirmDroidSettings(state.reported, desired);
    if (proc.stopping || proc.exited || proc.modelMismatch) throw new AppError('NATIVE_SETTINGS_UNCONFIRMED', state.failure ?? 'Droid stopped before dispatch. No prompt was sent.', 503);
    // This send has adopted the latest persisted selection, replacing any older deferred change.
    state.deferred = undefined;
    if (input.isCancelled()) return;
    const resolvedConfig: NativeRunConfig = {
      ...(desired.modelId ? { model: droidModelValue(desired.modelId, desired.reasoningEffort, desired.compactionTokenLimit) } : {}),
      mode: desired.interactionMode === 'spec' ? 'spec' : 'agent',
      approval: desired.autonomyLevel,
    };
    input.commitDispatchFence({
      backendId: 'droid',
      ...(state.nativeSessionId ? { nativeSessionId: state.nativeSessionId } : {}),
      // Where the receipt is looked for; the service starts it at the end of the conversation's log.
      baselineSequence: 0,
      renderedText: prompt.text,
      resolvedConfig,
    });
    // Droid echoes this id on the user message it creates, which is how the turn finds its command.
    const rpcId = `add:${input.commandId}`;
    state.commands.set(rpcId, { commandId: input.commandId, runId: input.runId, ...(prompt.attachments.length ? { attachments: prompt.attachments } : {}) });
    // Busy before the request: a turn Droid ends at once can report that before this send returns.
    state.turnActive = true;
    state.failure = undefined;
    this.emitStatus(state);
    try {
      await proc.rpc.request('droid.add_user_message', {
        text: prompt.text,
        ...(prompt.images.length ? { images: prompt.images } : {}),
      }, { id: rpcId, timeoutMs: 30_000 });
    } catch (error) {
      const late = state.commands.get(rpcId);
      state.commands.delete(rpcId);
      if (late) keepLateDroidCommand(state, rpcId, late);
      if (!state.activeTurn) {
        state.turnActive = state.commands.size > 0;
        this.emitStatus(state);
      }
      throw new Error(`Droid did not acknowledge this send; its outcome may be uncertain (${errorMessage(error)})`);
    }
  }

  async interrupt(session: Session): Promise<void> {
    const state = this.conversations.get(session.id);
    const proc = state?.proc;
    if (!state || !proc || proc.exited) return;
    for (const pending of state.pending.splice(0)) pending.resolve(cancelResult(pending));
    try {
      await proc.rpc.request('droid.interrupt_session', {}, { timeoutMs: 10_000 });
    } catch (error) {
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', `Droid did not confirm that the turn stopped (${errorMessage(error)}).`, 503);
    }
    this.emitStatus(state);
  }

  /**
   * Switches model, effort, mode or autonomy. A running process takes it at once, or at the end of
   * the turn in flight; a stopped one takes it when it next starts, from the session record.
   */
  async configure(session: Session, project: Project, profile: NativeBackendProfileConfig, patch: { model?: string; mode?: string; approval?: string }): Promise<void> {
    const state = this.conversation(session, project, profile);
    const desired = desiredSettings(profile, {
      model: patch.model ?? session.model,
      mode: patch.mode ?? session.mode,
      approval: patch.approval ?? session.approval,
    });
    await this.validateContextBudget(profile, desired);
    const proc = state.proc;
    if (!proc || proc.exited) { state.deferred = undefined; return; }
    // Supersede any older deferred choice, including a turn-end application waiting for the lock.
    state.deferred = desired;
    if (state.turnActive || BUSY_STATES.has(state.working) || state.pending.length) {
      return;
    }
    if (this.contextBudgetChanged(proc, desired)) {
      if (this.hasActiveWork(state)) {
        return;
      }
      await this.stop(state, proc);
      if (state.deferred === desired) state.deferred = undefined;
      return;
    }
    const change = settingsChange(state.reported, desired);
    if (change) await this.applySettings(state, proc, change, desired);
    if (state.deferred === desired) state.deferred = undefined;
  }

  async rename(session: Session): Promise<void> {
    const proc = this.conversations.get(session.id)?.proc;
    if (!proc || proc.exited || !session.title.trim()) return;
    await proc.rpc.request('droid.rename_session', { title: session.title }, { timeoutMs: 10_000 }).catch(() => undefined);
  }

  async respond(session: Session, response: NativeInteractionResponse): Promise<NativeInteractionResult> {
    if (typeof response.requestId !== 'string' || !response.requestId || response.requestId.length > 200 || /[\0\r\n]/.test(response.requestId)) {
      throw new AppError('INVALID_INTERACTION_REQUEST_ID', 'Interaction request id is invalid');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({
      interactionId: response.interactionId,
      revision: response.revision,
      action: response.action,
      selectedIds: response.selectedIds ?? [],
      otherText: response.otherText ?? '',
    })).digest('hex');
    const previous = this.host.getInteractionReceipt(session.id, response.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.interactionId !== response.interactionId || previous.revision !== response.revision) {
        throw new AppError('NATIVE_INTERACTION_REQUEST_CONFLICT', 'This interaction retry id was already used for a different answer', 409);
      }
      return previous.result;
    }
    const state = this.conversations.get(session.id);
    const pending = state?.pending[0];
    const current = pending?.interaction;
    if (!state || !pending || !current || current.id !== response.interactionId || current.revision !== response.revision) {
      return { status: 'uncertain', ...(current ? { interaction: current } : {}), message: 'This Droid request is no longer active.' };
    }
    if (!current.actions.some(action => action.id === response.action)) {
      return { status: 'uncertain', interaction: current, message: 'The selected action is not available for this request.' };
    }
    const save = (result: NativeInteractionResult) => {
      this.host.saveInteractionReceipt(session.id, response.requestId, { fingerprint, interactionId: response.interactionId, revision: response.revision, result, createdAt: new Date().toISOString() });
      return result;
    };
    let answer: unknown;
    if (pending.method === 'droid.ask_user') {
      const questions = askUserQuestions(pending.params);
      if (response.action === 'cancel') {
        answer = { cancelled: true, answers: [] };
      } else {
        const question = questions[pending.questionIndex]!;
        pending.answers.push({ index: question.index, question: question.question, answer: questionAnswer(question, response) });
        if (pending.questionIndex + 1 < questions.length) {
          pending.questionIndex += 1;
          pending.interaction = questionInteraction(current.id, pending.rpcId, questions, pending.questionIndex);
          const advanced = save({ status: 'advanced', interaction: pending.interaction });
          this.emitStatus(state);
          return advanced;
        }
        answer = { cancelled: false, answers: pending.answers };
      }
    } else if (current.kind === 'plan') {
      answer = { selectedOption: response.action === 'submit' ? (response.selectedIds?.[0] ?? current.options[0]?.id ?? 'proceed_once') : 'cancel' };
    } else {
      answer = { selectedOption: response.action };
    }
    state.pending.shift();
    const next = state.pending[0];
    const result = save(next ? { status: 'advanced', interaction: next.interaction } : { status: 'completed' });
    pending.resolve(answer);
    this.emitStatus(state);
    return result;
  }

  async dispose(sessionId: string): Promise<void> {
    const state = this.conversations.get(sessionId);
    if (!state) return;
    this.conversations.delete(sessionId);
    state.disposed = true;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    if (state.backgroundWatch) clearInterval(state.backgroundWatch);
    if (state.subagentTimer) clearInterval(state.subagentTimer);
    state.subagentTimer = undefined;
    state.listeners.clear();
    state.wakers.clear();
    if (state.proc) await this.stop(state, state.proc);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.conversations.keys()].map(id => this.dispose(id)));
  }

  private async transcript(state: DroidConversation): Promise<DroidTranscript | undefined> {
    if (!state.nativeSessionId) return undefined;
    const path = await findDroidTranscript(state.nativeSessionId, state.project.cwd);
    return path ? await readDroidTranscript(path, state.nativeSessionId) : undefined;
  }

  /** Reads Droid's session file once, unless a live process already keeps the conversation current. */
  private async ensureLoaded(state: DroidConversation): Promise<void> {
    if (state.loaded || state.proc || !state.nativeSessionId) return;
    state.loaded = true;
    try { await this.loadTranscript(state); } catch { state.loaded = false; }
  }

  /** What the session file says of the conversation: where its numbering stands, its subagents, its title and its settings. */
  private async loadTranscript(state: DroidConversation): Promise<void> {
    const transcript = await this.transcript(state);
    if (!transcript) {
      state.loaded = Boolean(state.proc);
      return;
    }
    const events = transcript.chain.slice(-RECENT_MESSAGES).flatMap(message => projectDroidMessage(message, { sessionId: state.workbenchSessionId }));
    keepDroidEvents(state, events, this.eventHost());
    state.lastSeq = transcript.lastSeq;
    state.loaded = true;
    const first = firstHumanMessage(events);
    if (first && !state.firstMessage) state.firstMessage = first;
    if (first) this.patchSession(state, firstMessageTitlePatch(this.host.getSession(state.workbenchSessionId), first));
    if (transcript.title) this.patchSession(state, providerTitlePatch(this.host.getSession(state.workbenchSessionId), transcript.title));
    await this.adoptStoredSettings(state, transcript.path);
  }

  /** A session imported from Droid takes the settings Droid last used for whatever the record leaves open. */
  private async adoptStoredSettings(state: DroidConversation, path: string): Promise<void> {
    const initial = this.host.getSession(state.workbenchSessionId);
    if (initial.model && initial.approval) return;
    const stored = await readDroidSessionSettings(path);
    if (!stored) return;
    // Import can overlap a picker change while the sidecar is being read. Only fill fields that
    // are still unspecified now, rather than replacing the user's newer selection.
    const session = this.host.getSession(state.workbenchSessionId);
    const patch: Partial<Session> = {
      ...(!session.model && stored.model ? { model: droidModelValue(stored.model, stored.reasoningEffort) } : {}),
      ...(!session.approval && stored.autonomyLevel ? { approval: droidAutonomy(stored.autonomyLevel) } : {}),
    };
    if (Object.keys(patch).length) this.patchSession(state, patch);
  }

  private patchSession(state: DroidConversation, patch: Partial<Session> | undefined): void {
    if (!patch || !Object.keys(patch).length) return;
    state.session = this.host.updateSession(state.workbenchSessionId, patch);
    notify(state, { type: 'session', session: state.session });
  }

  private async materialize(input: NativeRunInput): Promise<{ text: string; images: Array<{ type: 'base64'; data: string; mediaType: string }>; attachments: DroidAttachmentInfo[] }> {
    const extras = input.context.map(item => `@${item.path}${item.line ? `:${item.line}` : ''}`);
    const images: Array<{ type: 'base64'; data: string; mediaType: string }> = [];
    const attachments: DroidAttachmentInfo[] = [];
    for (const id of input.attachmentIds) {
      const { attachment, data } = await this.host.readAttachment(id);
      attachments.push({
        id: attachment.id, name: attachment.name, mimeType: attachment.mimeType,
        ...(attachment.width !== undefined ? { width: attachment.width } : {}),
        ...(attachment.height !== undefined ? { height: attachment.height } : {}),
      });
      if (IMAGE_MEDIA_TYPES.has(attachment.mimeType.toLowerCase()) && data.length <= MAX_INLINE_IMAGE_BYTES) {
        images.push({ type: 'base64', data: data.toString('base64'), mediaType: attachment.mimeType.toLowerCase() });
        continue;
      }
      const directory = join(tmpdir(), 'riffet-attachments', attachment.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = join(directory, basename(attachment.name) || 'attachment');
      await writeFile(target, data, { mode: 0o600 });
      extras.push(target);
    }
    return { text: [input.text, ...(extras.length ? ['', ...extras] : [])].join('\n'), images, attachments };
  }

  private async ensureProcess(state: DroidConversation, desired?: DroidSettings): Promise<DroidProcess> {
    const previous = state.proc;
    if (previous?.stopTask) await previous.stopTask;
    if (state.proc && !state.proc.exited && desired && this.contextBudgetChanged(state.proc, desired)) {
      if (this.hasActiveWork(state)) {
        throw new AppError('CLI_BUSY', 'The new Droid context budget takes effect after the current turn and background work finish.', 409);
      }
      await this.stop(state, state.proc);
    }
    if (state.proc && !state.proc.exited) return state.proc;
    state.starting ??= this.launch(state, desired ?? desiredSettings(state.profile, state.session)).finally(() => { state.starting = undefined; });
    return await state.starting;
  }

  private async launch(state: DroidConversation, desired: DroidSettings): Promise<DroidProcess> {
    await this.validateContextBudget(state.profile, desired);
    if (state.nativeSessionId) await this.loadTranscript(state);
    const cwd = resolve(state.project.cwd);
    let settingsDirectory: string | undefined;
    let settingsFile: string | undefined;
    const overlay = droidSettingsOverlay(desired, this.host.riffetMcp?.server(state.workbenchSessionId));
    if (overlay) {
      settingsDirectory = await mkdtemp(join(tmpdir(), 'riffet-droid-settings-'));
      settingsFile = join(settingsDirectory, 'settings.json');
      try {
        await writeFile(settingsFile, JSON.stringify(overlay), { mode: 0o600 });
      } catch (error) {
        await rm(settingsDirectory, { recursive: true, force: true });
        throw error;
      }
    }
    const child = spawnDroid(state.profile, cwd, settingsFile);
    const eventHost = this.eventHost();
    const proc: DroidProcess = {
      child,
      stderr: '',
      stopping: false,
      exited: false,
      contextRefreshSequence: 0,
      settingsRequests: new Map(),
      ...(desired.modelId ? { pinnedModelId: desired.modelId } : {}),
      ...(desired.compactionTokenLimit !== undefined ? { compactionTokenLimit: desired.compactionTokenLimit, compactionModelId: desired.modelId } : {}),
      ...(settingsDirectory ? { settingsDirectory } : {}),
      rpc: new DroidRpcClient(child.stdin!, child.stdout!, {
        onNotification: notification => handleDroidNotification(eventHost, state, proc, notification),
        onRequest: async (method, params, id) => await handleDroidRequest(eventHost, state, proc, method, params, id),
        // A transport that closed under a live child (a bad frame, a broken stdin) cannot be reused.
        onClose: () => { if (!proc.exited) proc.child.kill('SIGTERM'); },
      }),
    };
    child.stderr!.on('data', (chunk: Buffer) => { proc.stderr = `${proc.stderr}${chunk.toString()}`.slice(-STDERR_TAIL); });
    child.once('error', error => {
      this.handleExit(state, proc, error.message);
      if (settingsDirectory) void rm(settingsDirectory, { recursive: true, force: true }).catch(() => undefined);
    });
    child.once('exit', (code, signal) => {
      this.handleExit(state, proc, `exit ${code ?? signal ?? 'unknown'}`);
      if (settingsDirectory) void rm(settingsDirectory, { recursive: true, force: true }).catch(() => undefined);
    });
    state.proc = proc;
    state.working = 'idle';
    state.configuring += 1;
    try {
      if (state.nativeSessionId) {
        const loaded = await proc.rpc.request<Record<string, unknown>>('droid.load_session', { sessionId: state.nativeSessionId, messageLimit: 1 }, { timeoutMs: START_TIMEOUT_MS });
        state.reported = readSettings(loaded.settings);
        const change = settingsChange(state.reported, desired);
        if (change) await this.applySettings(state, proc, change, desired);
      } else {
        const created = await proc.rpc.request<Record<string, unknown>>('droid.initialize_session', {
          machineId: hostname(),
          cwd,
          ...(desired.modelId ? { modelId: desired.modelId } : {}),
          ...(desired.reasoningEffort ? { reasoningEffort: desired.reasoningEffort } : {}),
          autonomyLevel: desired.autonomyLevel,
          interactionMode: desired.interactionMode,
        }, { timeoutMs: START_TIMEOUT_MS });
        const nativeSessionId = str(created.sessionId);
        if (!nativeSessionId) throw new Error('Droid did not return a session id');
        state.nativeSessionId = nativeSessionId;
        state.loaded = true;
        state.reported = readSettings(created.settings);
        state.session = this.host.setNativeSessionId(state.workbenchSessionId, nativeSessionId);
        notify(state, { type: 'session', session: state.session });
      }
      if (desired.compactionTokenLimit !== undefined) await refreshDroidContext(state, true);
    } catch (error) {
      await this.stop(state, proc);
      if (error instanceof AppError) throw error;
      const detail = proc.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
      const code = error instanceof DroidRpcError ? error.code : undefined;
      if (code === DROID_RPC_ERRORS.unauthorized) throw new AppError('NATIVE_AUTH_REQUIRED', 'Droid is not signed in. Run `droid` once in a terminal to sign in, or set an API key on this profile.', 401);
      if (code === DROID_RPC_ERRORS.notFound) throw new AppError('NATIVE_SESSION_NOT_FOUND', 'Droid no longer has this session.', 404);
      throw new AppError('NATIVE_START_FAILED', `Droid could not start: ${errorMessage(error)}${detail ? ` (${detail})` : ''}`, 503);
    } finally {
      state.configuring -= 1;
    }
    state.loaded = true;
    state.failure = undefined;
    this.emitStatus(state);
    if (desired.compactionTokenLimit === undefined) void refreshDroidContext(state);
    return proc;
  }

  private contextBudgetChanged(proc: DroidProcess, desired: DroidSettings): boolean {
    return proc.compactionTokenLimit !== desired.compactionTokenLimit
      || (desired.compactionTokenLimit !== undefined && proc.compactionModelId !== desired.modelId);
  }

  /** A child can still be executing after its parent's turn has ended. */
  private hasActiveWork(state: DroidConversation): boolean {
    return state.turnActive || BUSY_STATES.has(state.working) || state.pending.length > 0
      || [...state.subagents.values()].some(child => child.running);
  }

  private async validateContextBudget(profile: NativeBackendProfileConfig, desired: DroidSettings): Promise<void> {
    if (desired.compactionTokenLimit === undefined) return;
    const model = (await listDroidModels(profile)).find(item => item.value === desired.modelId);
    if (!model?.configOptions.some(option => option.id === 'context')) {
      throw new AppError('INVALID_MODEL', 'Long context requires a Droid-listed built-in model with a known input window; custom and Auto models are not supported.', 400);
    }
  }

  private async applySettings(state: DroidConversation, proc: DroidProcess, change: Partial<DroidSettings>, desired = change): Promise<void> {
    const requestId = `settings:${randomUUID()}`;
    const acknowledgement: { reported?: Partial<DroidSettings> } = {};
    proc.settingsRequests.set(requestId, acknowledgement);
    state.configuring += 1;
    try {
      await proc.rpc.request('droid.update_session_settings', change, { id: requestId, timeoutMs: 15_000 });
      // The supported protocol emits settings_updated(requestId, actual settings) before the
      // empty response. The empty response alone does not prove which model or permission won.
      confirmDroidSettings(acknowledgement.reported, desired);
      confirmDroidSettings(state.reported, desired);
      if (desired.modelId) proc.pinnedModelId = desired.modelId;
    } catch (error) {
      state.failure = errorMessage(error);
      await this.stop(state, proc);
      if (error instanceof AppError) throw error;
      if (error instanceof DroidRpcError && (error.code === undefined || error.code === DROID_RPC_ERRORS.disconnected)) {
        throw new AppError('NATIVE_SETTINGS_UNCONFIRMED', `Droid did not confirm the requested settings (${errorMessage(error)}). No prompt was sent.`, 503);
      }
      if (change.modelId || change.reasoningEffort) throw new AppError('INVALID_MODEL', `Droid refused this model selection (${errorMessage(error)})`, 400);
      throw new AppError('INVALID_APPROVAL_MODE', `Droid refused this setting (${errorMessage(error)})`, 400);
    } finally {
      state.configuring -= 1;
      proc.settingsRequests.delete(requestId);
    }
    if (change.modelId || change.reasoningEffort) void refreshDroidContext(state);
  }

  private handleExit(state: DroidConversation, proc: DroidProcess, reason: string): void {
    if (proc.exited) return;
    proc.exited = true;
    proc.rpc.close(new DroidRpcError(`Droid exited (${reason})`, DROID_RPC_ERRORS.disconnected));
    if (state.proc !== proc || state.disposed) return;
    state.proc = undefined;
    state.working = 'idle';
    dropPending(state);
    if (state.turnActive) {
      // Droid writes no outcome for a turn it died in. The one it echoed ends on the journal (below);
      // a prompt it never echoed is in no transcript, so its run hears the end directly.
      const reason = proc.modelMismatch ? 'model_changed' : proc.stopping ? 'cancelled' : 'process_exit';
      this.endUnechoed(state, [...state.commands.entries()], reason);
    }
    state.commands.clear();
    state.lateCommands.clear();
    state.steps.clear();
    state.drafts.clear();
    state.requestStartAt = undefined;
    state.lastCallUsage = undefined;
    const eventHost = this.eventHost();
    for (const item of state.subagents.values()) if (item.running) finishDroidSubagent(eventHost, state, item);
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
    if (!proc.stopping && state.turnActive) {
      const detail = proc.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 240);
      state.failure = `Droid exited during this turn (${reason})${detail ? `: ${detail}` : ''}`;
    }
    // The journal's copy of the turn (sync v3): its transcript has no outcome line to end it with.
    if (state.turnActive) this.endExitedTurn(state.workbenchSessionId, proc.stopping && !proc.modelMismatch ? 'cancelled' : 'failed', state.failure);
    state.turnActive = false;
    state.activeTurn = undefined;
    // Nothing reports on a compaction once this process is gone; a detached command outlives it and is followed by its process id.
    state.compaction = undefined;
    state.activities.settleWhere(activity => activity.kind === 'compaction', 'unknown');
    this.emitStatus(state);
  }

  /** Tells the runs of prompts Droid never echoed how their turn ended; nothing in its transcript can. */
  private endUnechoed(state: DroidConversation, commands: Array<[string, { commandId: string; runId: string }]>, reason: string): void {
    const createdAt = new Date().toISOString();
    for (const [rpcId, command] of commands) {
      const event = projectDroidTurnEnd({ turnId: rpcId, reason }, state.lastSeq ?? 0, createdAt, { sessionId: state.workbenchSessionId, commandId: command.commandId, runId: command.runId });
      if (event) this.host.emitEvent(state.workbenchSessionId, event);
    }
  }

  /** Ends on the journal the turn a Droid process exited in, after what it wrote; fire and forget. */
  private endExitedTurn(sessionId: string, status: 'cancelled' | 'failed', error: string | undefined): void {
    const at = new Date().toISOString();
    void this.host.transcript?.withSource(sessionId, (source, w) => source instanceof DroidTranscriptSource ? source.endOpenTurns(w, status, at, status === 'failed' ? error : undefined) : undefined)
      .catch(() => undefined);
  }

  private stop(state: DroidConversation, proc: DroidProcess): Promise<void> {
    return proc.stopTask ??= (async () => {
      try {
        if (proc.exited) return;
        proc.stopping = true;
        for (const pending of state.pending.splice(0)) pending.resolve(cancelResult(pending));
        await proc.rpc.request('droid.close_session', {}, { timeoutMs: 2_000 }).catch(() => undefined);
        proc.child.stdin?.end();
        if (await waitForExit(proc.child, 2_000)) return;
        proc.child.kill('SIGTERM');
        if (await waitForExit(proc.child, 3_000)) return;
        proc.child.kill('SIGKILL');
        if (!await waitForExit(proc.child, 3_000)) {
          throw new AppError('NATIVE_STOP_UNCONFIRMED', 'Droid did not confirm that its previous process stopped; the new context budget was not started.', 503);
        }
      } finally {
        if (childHasExited(proc.child)) {
          this.handleExit(state, proc, 'stopped');
          if (proc.settingsDirectory) await rm(proc.settingsDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    })();
  }

  private scheduleIdleStop(state: DroidConversation): void {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
    const proc = state.proc;
    if (!proc || proc.exited || proc.stopping || this.hasActiveWork(state)) return;
    state.idleTimer = setTimeout(() => {
      state.idleTimer = undefined;
      if (state.proc === proc && !this.hasActiveWork(state)) {
        void this.stop(state, proc).catch(error => { state.failure = errorMessage(error); this.emitStatus(state); });
      }
    }, IDLE_STOP_MS);
    state.idleTimer.unref();
  }

  private statusOf(state: DroidConversation): NativeStatus {
    const session = state.session;
    const interaction = state.pending[0]?.interaction;
    // Droid's protocol is the only channel, so the tracker only records the lifecycle it reports.
    const phase = droidTurns.report(state, state.failure && state.proc?.modelMismatch ? 'attention' : interaction
      ? 'attention'
      : state.turnActive || (state.proc && BUSY_STATES.has(state.working))
        ? 'busy'
        : state.failure ? 'offline' : 'idle', 'protocol');
    const approval = droidAutonomy(session.approval);
    return withActivity({
      phase,
      ...(session.model ?? str(state.profile.config.defaultModel) ? { model: session.model ?? str(state.profile.config.defaultModel) } : {}),
      approval,
      permission: approval,
      ...(interaction ? { interaction } : {}),
      ...(state.failure && (phase === 'offline' || phase === 'attention') ? { notice: state.failure, noticeLevel: 'error' } : {}),
    }, state.activities.list());
  }

  private emitStatus(state: DroidConversation): void {
    if (state.disposed) return;
    try { state.session = this.host.getSession(state.workbenchSessionId); } catch { /* deleted; keep the last record */ }
    state.status = this.statusOf(state);
    notify(state, { type: 'status', status: state.status });
    this.scheduleIdleStop(state);
  }
}

const runtimes = new WeakMap<NativeBackendHost, DroidRuntime>();

export function getDroidRuntime(host: NativeBackendHost): DroidRuntime {
  let runtime = runtimes.get(host);
  if (!runtime) {
    runtime = new DroidRuntime(host);
    runtimes.set(host, runtime);
  }
  return runtime;
}

export async function closeDroidRuntime(host: NativeBackendHost): Promise<void> {
  const runtime = runtimes.get(host);
  runtimes.delete(host);
  await runtime?.close();
}
