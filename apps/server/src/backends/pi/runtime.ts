import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ModelInfo, NativeInteraction, NativeInteractionResponse, NativeInteractionResult,
  NativeRunConfig, NativeRunInput, NativeStatus, NativeWorkbenchEvent,
  Project, Session,
} from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { PiStepMetering } from './metering.js';
import { activityEvent, activityId, withActivity } from '../../journal/activity.js';
import { firstMessageTitlePatch, providerTitlePatch } from '../../session-title.js';
import { childHasExited, waitForExit } from '../shared/child-process.js';
import { DormancyClock } from '../shared/dormancy.js';
import { nativeModelEffort, parseNativeModelSelection } from '../shared/model-selection.js';
import type {
  NativeBackendHost, NativeBackendProfileConfig, NativeControlMessage,
  NativeDispatchBinding,
} from '../types.js';
import { findPiTranscript, readPiTranscript, type PiEntry, type PiTranscript } from './history.js';
import {
  piDefaultModel, piLaunchCommand, piEnvironment, listPiModels, piModelInfos,
  probePiCli, readPiSettings,
} from './models.js';
import { isPiPrompt, piTurnEndId, projectPiTurnEnd, type PiTurnOutcome } from './projection.js';
import { piCustomEndpoint, piCustomModelId, piProviderExtension, piProviderId, piRiffetMcpExtension } from './provider.js';
import { PiTranscriptSource } from './transcript.js';
import { PiRpcError, PiRpcTransport } from './transport.js';
import { handlePiUpdate, reconcilePiEntries, restorePiDeliveries } from './runtime-reconcile.js';
import {
  IDLE_STOP_MS, PROMPT_ACK_GRACE_MS, REQUEST_TIMEOUT_MS, START_TIMEOUT_MS, STDERR_TAIL,
  dropPending, errorMessage, isEntry, notify, piModelValue, piTurns, promptText, readReported,
  record, sameSelection, splitModel, str, wake,
  type PiConversation, type PiDelivery, type PiDesired, type PiDraft, type PiProcess, type RecordValue,
} from './runtime-shared.js';
import { handlePiUiRequest, materializePiInput, piAnswerFor } from './runtime-ui.js';

export type { PiDraft };
export { piModelValue };

const runtimes = new WeakMap<NativeBackendHost, PiRuntime>();

/** Owns one `pi --mode rpc` child per open conversation. */
export class PiRuntime {
  private readonly conversations = new Map<string, PiConversation>();

  constructor(private readonly host: NativeBackendHost, private readonly stateDir?: string) {}

  conversation(session: Session, project: Project, profile: NativeBackendProfileConfig): PiConversation {
    const existing = this.conversations.get(session.id);
    if (existing) {
      if (existing.nativeSessionId && session.nativeSessionId && existing.nativeSessionId !== session.nativeSessionId) {
        throw new AppError('NATIVE_SESSION_SCOPE_MISMATCH', 'This pi conversation is bound to a different pi session', 409);
      }
      existing.session = session;
      existing.project = project;
      existing.profile = profile;
      existing.nativeSessionId ??= session.nativeSessionId;
      return existing;
    }
    const state: PiConversation = {
      workbenchSessionId: session.id,
      session,
      project,
      profile,
      ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
      listeners: new Set(),
      wakers: new Set(),
      status: { phase: 'idle' },
      reported: {},
      deliveries: new Map(),
      turns: new Map(),
      drafts: new Map(),
      metering: undefined as unknown as PiStepMetering,
      assistantStep: 0,
      stopRequested: false,
      pending: [],
      knownEntries: new Set(),
      loaded: false,
      disposed: false,
      nativeActive: false,
      dormancy: new DormancyClock(),
      compactions: 0,
    };
    (state as { metering: PiStepMetering }).metering = new PiStepMetering(this.host, msg => notify(state, msg));
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

  subscribe(session: Session, project: Project, profile: NativeBackendProfileConfig, listener: (message: NativeControlMessage) => void): () => void {
    const state = this.conversation(session, project, profile);
    state.listeners.add(listener);
    listener({ type: 'status', status: state.status });
    if (state.context) listener({ type: 'context', context: state.context });
    void this.ensureLoaded(state);
    return () => { state.listeners.delete(listener); };
  }

  /**
   * The conversation's transcript for the journal: pi's own session file, woken by this process's
   * events, with the blocks it is still streaming. Viewing history never starts a process.
   */
  transcriptSource(session: Session, profile: NativeBackendProfileConfig): PiTranscriptSource {
    const sessionId = session.id;
    const current = () => { try { return this.host.getSession(sessionId); } catch { return undefined; } };
    return new PiTranscriptSource({
      sessionId,
      nativeSessionId: () => current()?.nativeSessionId,
      locate: async nativeSessionId => {
        const latest = current();
        return latest ? await findPiTranscript(nativeSessionId, this.host.getProject(latest.projectId).cwd, str(profile.config.configDir)) : undefined;
      },
      live: {
        watch: wake => {
          const latest = this.host.getSession(sessionId);
          const state = this.conversation(latest, this.host.getProject(latest.projectId), profile);
          state.wakers.add(wake);
          return () => { state.wakers.delete(wake); };
        },
        streaming: () => [...this.conversations.get(sessionId)?.drafts.values() ?? []],
        active: turnId => {
          const state = this.conversations.get(sessionId);
          return Boolean(state?.nativeActive && !state.deliveries.size) || [...state?.deliveries.values() ?? []]
            .some(delivery => !delivery.recovered && (!delivery.entryId || delivery.entryId === turnId));
        },
        command: entryId => {
          const known = this.conversations.get(sessionId)?.turns.get(entryId);
          if (known) return known;
          // After a restart only the run the dispatcher bound to the echoed entry knows it.
          const runId = this.host.findRunIdByNativeMessage(sessionId, `msg:${entryId}`);
          const run = runId ? this.host.listRuns?.(sessionId).find(item => item.id === runId) : undefined;
          return run ? { runId: run.id, commandId: run.commandId } : runId ? { runId } : undefined;
        },
        superseded: entryId => {
          const state = this.conversations.get(sessionId);
          if (!state) return [];
          const retired: string[] = [];
          for (const [key, draft] of state.drafts) {
            if (draft.entryId !== entryId) continue;
            retired.push(`draft:${draft.key}`);
            state.drafts.delete(key);
          }
          return retired;
        },
      },
    });
  }

  /** Binds the conversation without starting pi: history reads from disk, the process starts with the first send. */
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
    const prompt = await materializePiInput(this.host, input.input);
    if (input.isCancelled()) return;
    const desired = await this.desiredSelection(state, input.config);
    const proc = await this.ensureProcess(state, desired);
    if (proc.stopping || proc.exited) throw new AppError('NATIVE_SETTINGS_UNCONFIRMED', state.failure ?? 'pi stopped before this send. No prompt was sent.', 503);
    await this.applySelection(state, proc, desired);
    const entries = await this.getEntries(proc);
    state.boundary = entries.entries.at(-1)?.id;
    const boundary = JSON.stringify({ v: 1, lastEntryId: state.boundary ?? null, leafId: entries.leafId ?? null });
    const dispatchAt = new Date().toISOString();
    const resolvedConfig: NativeRunConfig = {
      mode: 'agent',
      ...(desired.modelId ? { model: this.modelValue(state, desired.provider, desired.modelId, desired.thinkingLevel) } : {}),
    };
    input.commitDispatchFence({
      backendId: 'pi',
      ...(state.nativeSessionId ? { nativeSessionId: state.nativeSessionId } : {}),
      baselineSequence: 0,
      renderedText: prompt.text,
      nativeInputBoundary: boundary,
      resolvedConfig,
    });
    if (input.isCancelled()) return;
    const delivery: PiDelivery = {
      commandId: input.commandId,
      runId: input.runId,
      text: prompt.text,
      at: dispatchAt,
      lastEntryId: state.boundary ?? null,
      leafId: entries.leafId ?? null,
    };
    state.deliveries.set(input.commandId, delivery);
    state.streamTurn = input.commandId;
    state.activeRunId = input.runId;
    state.stopRequested = false;
    state.failure = state.retryNotice = undefined;
    // Busy before the request: pi can report the whole turn before this send returns.
    this.emitStatus(state);
    // RPC input hooks may ask for a user answer before producing the prompt ACK. Return once
    // stdin accepted the frame, releasing the dispatch/session lock needed by that answer.
    // The ACK is checked in the background; it is never treated as turn completion.
    let written!: () => void;
    let writeFailed!: (error: Error) => void;
    const sent = new Promise<void>((resolve, reject) => { written = resolve; writeFailed = reject; });
    const response = proc.rpc.request({
      type: 'prompt', message: prompt.text,
      ...(prompt.images.length ? { images: prompt.images } : {}),
    }, { id: `prompt:${input.commandId}`, timeoutMs: 0, onWritten: written });
    const ackStart = Date.now();
    const checkAck = () => {
      if (state.proc !== proc || state.disposed) return;
      if (state.pending.length) { ackTimer = setTimeout(checkAck, REQUEST_TIMEOUT_MS); ackTimer.unref(); return; }
      // A slow pi is not a lost prompt: the frame was written and is never resent, so keep listening and let a late
      // ack or the transcript confirm it. Only a pi silent for the whole grace window is stopped.
      if (Date.now() - ackStart < PROMPT_ACK_GRACE_MS) {
        // A retry notice of pi's own says more than this one; it is not covered over.
        if (!state.retryNotice || state.retryNotice.startsWith('pi has not acknowledged')) {
          state.retryNotice = 'pi has not acknowledged this input yet; still waiting.';
          this.emitStatus(state);
        }
        ackTimer = setTimeout(checkAck, REQUEST_TIMEOUT_MS); ackTimer.unref();
        return;
      }
      state.failure = 'pi did not acknowledge this input; it will not be sent again.';
      void this.stop(state, proc);
    };
    let ackTimer = setTimeout(checkAck, REQUEST_TIMEOUT_MS);
    ackTimer.unref();
    void response.then(async answer => {
      clearTimeout(ackTimer);
      if (state.proc !== proc || state.disposed || !state.deliveries.has(delivery.commandId)) return;
      if (state.retryNotice?.startsWith('pi has not acknowledged')) state.retryNotice = undefined;
      const disposition = str(answer.disposition);
      delivery.disposition = disposition;
      if (disposition === 'handled') {
        await this.finishDelivery(state, delivery, 'completed', new Date().toISOString());
        this.emitStatus(state);
      } else if (disposition === 'started' || disposition === 'queued') {
        await this.reconcile(state, proc).catch(() => undefined);
      } else {
        throw new PiRpcError('pi returned an unknown prompt disposition');
      }
      if (proc.pendingSettle) {
        const settled = proc.pendingSettle;
        proc.pendingSettle = undefined;
        await this.queueSettled(state, proc, settled);
      }
    }).catch(error => {
      clearTimeout(ackTimer);
      writeFailed(error instanceof Error ? error : new Error(errorMessage(error)));
      if (state.proc !== proc || state.disposed) return;
      state.failure = errorMessage(error);
      void this.stop(state, proc);
    });
    await sent;
  }

  async interrupt(session: Session, beforeWrite?: () => void): Promise<void> {
    const state = this.conversations.get(session.id);
    const proc = state?.proc;
    if (!state || !proc || proc.exited) return;
    beforeWrite?.();
    dropPending(state);
    let clearError: unknown;
    try { await proc.rpc.request({ type: 'clear_queue' }, { timeoutMs: 10_000 }); }
    catch (error) { clearError = error; }
    // The native queue may have advanced while the clear request was in flight.
    beforeWrite?.();
    const previousStopRequested = state.stopRequested;
    state.stopRequested = true;
    try {
      // Always attempt the abort, even if the queue refused to clear. Closing the child on error
      // also prevents any queued input from restarting after an unconfirmed abort.
      await proc.rpc.request({ type: 'abort' }, { timeoutMs: 60_000 });
      if (clearError) throw clearError;
    } catch (error) {
      // A failed abort may return after another turn started. Guard failures must escape this
      // kill fallback; stopping the process would otherwise terminate that successor too.
      try { beforeWrite?.(); }
      catch (changed) {
        if (state.proc === proc) state.stopRequested = previousStopRequested;
        throw changed;
      }
      await this.stop(state, proc);
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', `pi stopped after its RPC interrupt could not be confirmed (${errorMessage(error)}).`, 503);
    }
    this.emitStatus(state);
  }

  /**
   * Saves the next turn's selection. A running process takes it before its next prompt, never in the
   * middle of the tool loop pi is executing.
   */
  async configure(session: Session, project: Project, profile: NativeBackendProfileConfig, patch: { model?: string; mode?: string; approval?: string }): Promise<void> {
    if (patch.mode !== undefined && patch.mode !== 'agent') throw new AppError('NATIVE_MODE_UNSUPPORTED', 'pi runs in agent mode only.', 400);
    if (patch.approval !== undefined) throw new AppError('NATIVE_APPROVAL_UNSUPPORTED', 'pi has no approval selector.', 400);
    const state = this.conversation(session, project, profile);
    state.desired = patch.model === undefined ? undefined : await this.selectionOf(state, patch.model);
  }

  async rename(session: Session): Promise<void> {
    const proc = this.conversations.get(session.id)?.proc;
    if (!proc || proc.exited || !session.title.trim()) return;
    await proc.rpc.request({ type: 'set_session_name', name: session.title }, { timeoutMs: 10_000 }).catch(() => undefined);
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
      return { status: 'uncertain', ...(current ? { interaction: current } : {}), message: 'This pi request is no longer active.' };
    }
    if (current.expiresAt && Date.parse(current.expiresAt) <= Date.now()) {
      if (pending.timer) clearTimeout(pending.timer);
      state.pending.shift();
      void pending.resolve({ cancelled: true }).catch(() => undefined);
      this.emitStatus(state);
      return { status: 'uncertain', message: 'This pi request has expired.' };
    }
    if (!current.actions.some(action => action.id === response.action)) {
      return { status: 'uncertain', interaction: current, message: 'The selected action is not available for this request.' };
    }
    const answer = piAnswerFor(pending, response);
    if (pending.timer) clearTimeout(pending.timer);
    state.pending.shift();
    try {
      await pending.resolve(answer);
    } catch (error) {
      // The bytes may not have reached pi; never report this interaction as completed.
      this.emitStatus(state);
      return { status: 'uncertain', ...(state.pending[0] ? { interaction: state.pending[0].interaction } : {}), message: `pi did not confirm this answer (${errorMessage(error)}).` };
    }
    const next = state.pending[0];
    const result: NativeInteractionResult = next ? { status: 'advanced', interaction: next.interaction } : { status: 'completed' };
    this.host.saveInteractionReceipt(session.id, response.requestId, { fingerprint, interactionId: response.interactionId, revision: response.revision, result, createdAt: new Date().toISOString() });
    this.emitStatus(state);
    return result;
  }

  async dispose(sessionId: string): Promise<void> {
    const state = this.conversations.get(sessionId);
    if (!state) return;
    this.conversations.delete(sessionId);
    state.disposed = true;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.listeners.clear();
    state.wakers.clear();
    dropPending(state);
    if (state.proc) await this.stop(state, state.proc);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.conversations.keys()].map(id => this.dispose(id)));
  }

  private modelValue(state: PiConversation, provider: string | undefined, modelId: string, thinkingLevel?: string): string {
    return piModelValue(piCustomEndpoint(state.profile) && provider === piProviderId(state.profile) ? undefined : provider, modelId, thinkingLevel);
  }

  private async selectionOf(state: PiConversation, value: string | undefined): Promise<PiDesired | undefined> {
    if (!value) return undefined;
    const selection = parseNativeModelSelection(value);
    let effort = nativeModelEffort(selection);
    const custom = piCustomEndpoint(state.profile);
    const split = custom ? { provider: piProviderId(state.profile), modelId: piCustomModelId(state.profile, selection.model) } : splitModel(selection.model);
    let provider = split.provider;
    if ((!provider || custom && !effort) && split.modelId) {
      const models = await listPiModels(state.profile);
      const model = models.find(model => model.value === split.modelId || model.value.endsWith(`/${split.modelId}`));
      provider ??= splitModel(model?.value)?.provider;
      if (custom) effort ??= model?.configOptions.find(option => option.id === 'effort')?.currentValue;
    }
    return {
      ...(provider ? { provider } : {}),
      ...(split.modelId ? { modelId: split.modelId } : {}),
      ...(effort ? { thinkingLevel: effort } : {}),
    };
  }

  private async desiredSelection(state: PiConversation, config: NativeRunConfig): Promise<PiDesired> {
    const value = config.model ?? state.session.model ?? str(state.profile.config.defaultModel);
    return await this.selectionOf(state, value || await piDefaultModel(state.profile)) ?? {};
  }

  private async applySelection(state: PiConversation, proc: PiProcess, desired: PiDesired): Promise<void> {
    if (sameSelection(state.reported, desired)) return;
    try {
      if (desired.modelId) {
        if (!desired.provider) throw new AppError('INVALID_MODEL', 'A pi model must name its provider as provider/modelId.', 400);
        const answer = await proc.rpc.request({ type: 'set_model', provider: desired.provider, modelId: desired.modelId }, { timeoutMs: REQUEST_TIMEOUT_MS });
        const reported = readReported(answer);
        if (reported.modelId && reported.modelId !== desired.modelId) {
          throw new AppError('NATIVE_SETTINGS_UNCONFIRMED', `pi selected ${reported.modelId} instead of ${desired.modelId}. No prompt was sent.`, 503);
        }
        state.reported = { ...state.reported, ...reported };
        if (reported.modelId) state.reported.provider = desired.provider;
      }
      if (desired.thinkingLevel) {
        const levels = await proc.rpc.request({ type: 'get_available_thinking_levels' }, { timeoutMs: REQUEST_TIMEOUT_MS });
        const available = Array.isArray(levels.levels) ? levels.levels.flatMap(item => str(item) ?? []) : [];
        if (available.length && !available.includes(desired.thinkingLevel)) {
          throw new AppError('INVALID_MODEL', `This pi model does not support thinking level ${desired.thinkingLevel}.`, 400);
        }
        await proc.rpc.request({ type: 'set_thinking_level', level: desired.thinkingLevel }, { timeoutMs: REQUEST_TIMEOUT_MS });
        state.reported.thinkingLevel = desired.thinkingLevel;
      }
      // Confirm with the process's own state: a setter's empty response proves nothing about the run.
      const current = readReported(await proc.rpc.request({ type: 'get_state' }, { timeoutMs: REQUEST_TIMEOUT_MS }));
      if (desired.modelId && desired.modelId !== current.modelId) {
        throw new AppError('NATIVE_SETTINGS_UNCONFIRMED', `pi reports model ${current.modelId ?? 'none'} instead of ${desired.modelId}. No prompt was sent.`, 503);
      }
      if (desired.thinkingLevel && current.thinkingLevel && desired.thinkingLevel !== current.thinkingLevel) {
        throw new AppError('NATIVE_SETTINGS_UNCONFIRMED', `pi reports thinking level ${current.thinkingLevel} instead of ${desired.thinkingLevel}. No prompt was sent.`, 503);
      }
      state.reported = current;
    } catch (error) {
      if (error instanceof AppError) throw error;
      state.failure = errorMessage(error);
      throw new AppError('INVALID_MODEL', `pi refused this model selection (${errorMessage(error)})`, 400);
    }
    this.patchSession(state, { ...(desired.modelId ? { model: this.modelValue(state, desired.provider, desired.modelId, desired.thinkingLevel) } : {}) });
  }

  private launchKey(state: PiConversation): string {
    return createHash('sha256').update(JSON.stringify([resolve(state.project.cwd), state.profile.id, state.profile.config, piLaunchCommand(state.profile), piEnvironment(state.profile).PI_CODING_AGENT_DIR ?? ''])).digest('hex');
  }

  private async ensureProcess(state: PiConversation, desired?: PiDesired): Promise<PiProcess> {
    const previous = state.proc;
    if (previous?.settling) await previous.settling;
    if (previous && !previous.exited && previous.launchKey !== this.launchKey(state)) {
      if (state.deliveries.size || state.nativeActive || state.pending.length) throw new AppError('NATIVE_BACKEND_BUSY', 'pi configuration changed while a turn is running.', 409);
      await this.stop(state, previous);
    }
    if (previous?.stopTask) await previous.stopTask;
    if (state.proc && !state.proc.exited) return state.proc;
    state.starting ??= this.launch(state, desired ?? state.desired ?? {}).finally(() => { state.starting = undefined; });
    return await state.starting;
  }

  private async launch(state: PiConversation, desired: PiDesired): Promise<PiProcess> {
    const cwd = resolve(state.project.cwd);
    const launch = piLaunchCommand(state.profile);
    const availability = await probePiCli(state.profile);
    if (!availability.available) throw new AppError('NATIVE_UNAVAILABLE', availability.reason ?? 'pi RPC is unavailable.', 503);
    // A conversation gets its stable pi id before the process exists, so a restart before pi has
    // written a file can still resume the same conversation instead of inventing a new one.
    if (!state.nativeSessionId) {
      state.nativeSessionId = randomUUID();
      state.session = this.host.setNativeSessionId(state.workbenchSessionId, state.nativeSessionId);
      notify(state, { type: 'session', session: state.session });
    }
    const sessionFile = await this.verifyResume(state, cwd);
    const providerExtension = await piProviderExtension(state.profile, this.stateDir ?? join(tmpdir(), 'riffet-pi-runtime'));
    const riffetMcp = this.host.riffetMcp?.server(state.workbenchSessionId);
    const riffetExtension = riffetMcp ? await piRiffetMcpExtension(riffetMcp, this.stateDir ?? join(tmpdir(), 'riffet-pi-runtime')) : undefined;
    const child = spawn(launch.command, [
      ...launch.args,
      '--mode', 'rpc',
      ...(sessionFile ? ['--session', sessionFile] : ['--session-id', state.nativeSessionId]),
      ...(providerExtension ? ['-e', providerExtension.path] : []),
      ...(riffetExtension ? ['-e', riffetExtension] : []),
    ], { cwd, env: { ...piEnvironment(state.profile), ...providerExtension?.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const proc: PiProcess = {
      child,
      rpc: new PiRpcTransport(child.stdin!, child.stdout!, {
        onEvent: frame => this.handleEvent(state, proc, frame),
        // A transport that closed under a live child cannot be reused.
        onClose: () => { if (!proc.exited) proc.child.kill('SIGTERM'); },
      }),
      stderr: '',
      stopping: false,
      exited: false,
      launchKey: this.launchKey(state),
      settledAborted: false,
    };
    child.stderr!.on('data', (chunk: Buffer) => { proc.stderr = `${proc.stderr}${chunk.toString()}`.slice(-STDERR_TAIL); });
    child.once('error', error => { void this.handleExit(state, proc, error.message); });
    child.once('close', (code, signal) => { void this.handleExit(state, proc, `exit ${code ?? signal ?? 'unknown'}`); });
    state.proc = proc;
    try {
      const ready = await proc.rpc.request({ type: 'get_state' }, { timeoutMs: START_TIMEOUT_MS });
      const nativeSessionId = str(ready.sessionId);
      if (!nativeSessionId) throw new Error('pi did not return a session id');
      if (state.nativeSessionId && state.nativeSessionId !== nativeSessionId) {
        throw new AppError('NATIVE_SESSION_SCOPE_MISMATCH', 'pi resumed a different session than this conversation owns', 409);
      }
      state.nativeSessionId = nativeSessionId;
      if (state.session.nativeSessionId !== nativeSessionId) {
        state.session = this.host.setNativeSessionId(state.workbenchSessionId, nativeSessionId);
        notify(state, { type: 'session', session: state.session });
      }
      state.reported = readReported(ready);
      state.loaded = true;
      await this.reconcile(state, proc, true).catch(() => undefined);
      if (!sameSelection(state.reported, desired)) await this.applySelection(state, proc, desired);
    } catch (error) {
      await this.stop(state, proc).catch(() => undefined);
      if (error instanceof AppError) throw error;
      const detail = proc.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
      throw new AppError('NATIVE_START_FAILED', `pi could not start: ${errorMessage(error)}${detail ? ` (${detail})` : ''}`, 503);
    }
    state.failure = state.retryNotice = undefined;
    this.emitStatus(state);
    return proc;
  }

  /**
   * Resuming must find the conversation pi already wrote. A new conversation has no file yet, so
   * only a session with recorded runs is refused when its file is missing: silently creating an
   * empty session under that id would detach the history the workbench still shows.
   */
  private async verifyResume(state: PiConversation, cwd: string): Promise<string | undefined> {
    const nativeSessionId = state.nativeSessionId;
    if (!nativeSessionId) return;
    const found = await findPiTranscript(nativeSessionId, cwd, str(state.profile.config.configDir));
    const recorded = (this.host.listRuns?.(state.workbenchSessionId) ?? []).some(run =>
      run.native?.nativeInputBoundary || run.native?.nativeMessageId);
    if (!found && recorded) {
      throw new AppError('NATIVE_SESSION_NOT_FOUND', 'pi has no stored session for this conversation; its history cannot be resumed.', 409);
    }
    return found;
  }

  private handleExit(state: PiConversation, proc: PiProcess, reason: string): Promise<void> {
    return proc.exitTask ??= (async () => {
      proc.exited = true;
      proc.pendingSettle = undefined;
      proc.rpc.close(new PiRpcError(`pi exited (${reason})`));
      if (state.proc !== proc || state.disposed) return;
      const at = new Date().toISOString();
      // File append follows message_end; close means all stdout records have been consumed.
      const transcript = await this.transcript(state).catch(() => undefined);
      if (transcript) reconcilePiEntries(this.host, state, transcript.entries);
      await this.host.transcript?.drain(state.workbenchSessionId);
      const deliveries = [...state.deliveries.values()];
      for (const delivery of deliveries) {
        if (delivery.entryId) await this.finishDelivery(state, delivery, 'interrupted', at, `pi exited during this turn (${reason})`);
      }
      state.proc = undefined;
      state.nativeActive = false;
      state.retryNotice = undefined;
      dropPending(state);
      state.drafts.clear();
      state.metering.clearOpen();
      state.activeTurn = undefined;
      state.activeRunId = undefined;
      state.streamTurn = undefined;
      if (state.idleTimer) clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
      if (state.deliveries.size || !proc.stopping) {
        state.failure = `pi exited (${reason}); unconfirmed input will not be sent again.`;
        // The dispatcher persists unreceipted input as uncertain, fencing later sends.
        notify(state, { type: 'status', status: { phase: 'offline', notice: state.failure, noticeLevel: 'error' } });
      }
      state.deliveries.clear();
      this.emitStatus(state);
    })().catch(error => {
      state.failure = errorMessage(error);
      state.proc = undefined;
      notify(state, { type: 'status', status: { phase: 'offline', notice: state.failure, noticeLevel: 'error' } });
    });
  }

  private stop(state: PiConversation, proc: PiProcess): Promise<void> {
    return proc.stopTask ??= (async () => {
      try {
        if (proc.exited) return;
        proc.stopping = true;
        dropPending(state);
        proc.child.stdin?.end();
        if (await waitForExit(proc.child, 2_000)) return;
        proc.child.kill('SIGTERM');
        if (await waitForExit(proc.child, 3_000)) return;
        proc.child.kill('SIGKILL');
        await waitForExit(proc.child, 3_000);
      } finally {
        if (childHasExited(proc.child)) await this.handleExit(state, proc, 'stopped');
      }
    })();
  }

  private scheduleIdleStop(state: PiConversation): void {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
    const proc = state.proc;
    if (!proc || proc.exited || proc.stopping || state.deliveries.size || state.nativeActive || state.pending.length) return;
    state.idleTimer = setTimeout(() => {
      state.idleTimer = undefined;
      if (state.proc === proc && !state.deliveries.size && !state.nativeActive && !state.pending.length) {
        void this.stop(state, proc).catch(error => { state.failure = errorMessage(error); this.emitStatus(state); });
      }
    }, IDLE_STOP_MS);
    state.idleTimer.unref();
  }

  private statusOf(state: PiConversation): NativeStatus {
    const interaction = state.pending[0]?.interaction;
    const compacting = Boolean(state.compaction);
    const phase = piTurns.report(state, interaction
      ? 'attention'
      : state.deliveries.size || state.nativeActive || compacting
        ? 'busy'
        : state.failure && !state.proc ? 'offline' : 'idle', 'protocol');
    const model = state.reported.provider && state.reported.modelId
      ? this.modelValue(state, state.reported.provider, state.reported.modelId)
      : str(state.session.model);
    return withActivity({
      phase,
      ...(model ? { model } : {}),
      ...(interaction ? { interaction } : {}),
      ...(state.failure ? { notice: state.failure, noticeLevel: 'error' as const }
        : state.retryNotice ? { notice: state.retryNotice, noticeLevel: 'info' as const }
        : state.notice ? { notice: state.notice, noticeLevel: state.noticeLevel ?? 'info' } : {}),
    }, []);
  }

  private emitStatus(state: PiConversation): void {
    if (state.disposed) return;
    try { state.session = this.host.getSession(state.workbenchSessionId); } catch { /* deleted; keep the last record */ }
    state.status = this.statusOf(state);
    notify(state, { type: 'status', status: state.status });
    this.scheduleIdleStop(state);
  }

  private patchSession(state: PiConversation, patch: Partial<Session> | undefined): void {
    if (!patch || !Object.keys(patch).length) return;
    state.session = this.host.updateSession(state.workbenchSessionId, patch);
    notify(state, { type: 'session', session: state.session });
  }

  private async ensureLoaded(state: PiConversation): Promise<void> {
    if (state.loaded || state.proc || !state.nativeSessionId) return;
    state.loaded = true;
    try { await this.loadTranscript(state); } catch { state.loaded = false; }
  }

  private async transcript(state: PiConversation): Promise<PiTranscript | undefined> {
    if (!state.nativeSessionId) return undefined;
    const path = await findPiTranscript(state.nativeSessionId, state.project.cwd, str(state.profile.config.configDir));
    return path ? await readPiTranscript(path, state.nativeSessionId) : undefined;
  }

  private async loadTranscript(state: PiConversation): Promise<void> {
    const transcript = await this.transcript(state);
    if (!transcript) return;
    restorePiDeliveries(this.host, state);
    reconcilePiEntries(this.host, state, transcript.entries);
    const first = transcript.chain.find(isPiPrompt);
    const text = first ? promptText(first) : undefined;
    if (text) {
      state.firstMessage ??= text;
      this.patchSession(state, firstMessageTitlePatch(this.host.getSession(state.workbenchSessionId), text));
    }
    if (transcript.title) this.patchSession(state, providerTitlePatch(this.host.getSession(state.workbenchSessionId), transcript.title));
  }

  private async getEntries(proc: PiProcess): Promise<{ entries: PiEntry[]; leafId?: string }> {
    const data = await proc.rpc.request({ type: 'get_entries' }, { timeoutMs: REQUEST_TIMEOUT_MS });
    const entries = Array.isArray(data.entries) ? data.entries.filter(isEntry) : [];
    return { entries, leafId: str(data.leafId) };
  }

  private async reconcile(state: PiConversation, proc: PiProcess, initial = false): Promise<void> {
    if (state.proc !== proc || proc.exited) return;
    const { entries } = await this.getEntries(proc);
    if (initial) restorePiDeliveries(this.host, state);
    reconcilePiEntries(this.host, state, entries);
  }

  private handleEvent(state: PiConversation, proc: PiProcess, frame: RecordValue): void {
    if (state.proc !== proc) return;
    const type = str(frame.type);
    switch (type) {
      case 'agent_start':
        state.nativeActive = true;
        proc.lastAssistant = undefined;
        proc.retryError = undefined;
        proc.settledAborted = false;
        this.emitStatus(state);
        return;
      case 'turn_start':
      case 'turn_end':
      case 'agent_end':
        this.emitStatus(state);
        return;
      case 'message_start': {
        const message = record(frame.message);
        if (message?.role === 'assistant') {
          state.assistantStep++;
          state.streamTurn = state.activeTurn ?? state.streamTurn;
          state.metering.start(state.assistantStep, state.activeTurn ?? state.streamTurn, state.activeRunId);
        }
        return;
      }
      case 'message_update':
        handlePiUpdate(state, frame);
        return;
      case 'message_end':
        this.handleMessageEnd(state, proc, frame);
        return;
      case 'tool_execution_start':
      case 'tool_execution_update':
        this.emitStatus(state);
        return;
      case 'tool_execution_end':
        wake(state);
        this.emitStatus(state);
        return;
      case 'agent_settled':
        void this.queueSettled(state, proc, frame).catch(error => {
          state.failure = errorMessage(error);
          void this.stop(state, proc);
        });
        return;
      case 'compaction_start':
        this.startCompaction(state, frame);
        return;
      case 'compaction_end':
        this.endCompaction(state, frame);
        return;
      case 'auto_retry_start':
        // A retry still in progress is not a failure; only one that gives up is.
        state.retryNotice = str(frame.errorMessage) ? `pi is retrying: ${str(frame.errorMessage)}` : 'pi is retrying.';
        this.emitStatus(state);
        return;
      case 'auto_retry_end':
        state.retryNotice = undefined;
        if (frame.success === false) {
          proc.retryError = str(frame.finalError) ?? 'pi gave up after retrying.';
          state.failure = proc.retryError;
        } else {
          proc.retryError = undefined;
          state.failure = undefined;
        }
        this.emitStatus(state);
        return;
      case 'thinking_level_changed': {
        const level = str(frame.level);
        if (level) state.reported.thinkingLevel = level;
        this.emitStatus(state);
        return;
      }
      case 'session_info_changed': {
        const name = str(frame.name);
        this.patchSession(state, providerTitlePatch(this.host.getSession(state.workbenchSessionId), name));
        return;
      }
      case 'entry_appended':
        wake(state);
        return;
      case 'extension_ui_request':
        handlePiUiRequest(state, frame, target => this.emitStatus(target));
        return;
      case 'extension_error':
        state.failure = str(frame.error) ? `${str(frame.event) ?? 'extension'}: ${str(frame.error)}` : 'A pi extension failed.';
        this.emitStatus(state);
        return;
      default:
    }
  }

  private handleMessageEnd(state: PiConversation, proc: PiProcess, frame: RecordValue): void {
    const message = record(frame.message);
    if (message?.role === 'assistant') {
      proc.lastAssistant = message;
      state.metering.finish(state.assistantStep, message, state.activeTurn ?? state.streamTurn, state.activeRunId);
      for (const draft of state.drafts.values()) {
        if (!draft.key.includes(`:${state.assistantStep}:`)) continue;
        if (typeof message.timestamp === 'number') draft.messageTimestamp = message.timestamp;
        const block = Array.isArray(message.content) ? record(message.content[draft.contentIndex]) : undefined;
        const finalText = draft.thought ? block?.thinking : block?.text;
        if (typeof finalText === 'string') draft.text = finalText;
      }
    }
    void this.reconcile(state, proc).catch(() => undefined);
    wake(state);
  }

  private async settle(state: PiConversation, proc: PiProcess, frame: RecordValue): Promise<void> {
    if (state.proc !== proc || state.disposed) return;
    proc.settledAborted = frame.aborted === true;
    state.retryNotice = undefined;
    const status = this.outcomeOf(state, proc);
    const at = new Date().toISOString();
    const error = status === 'failed' ? (proc.retryError ?? str(proc.lastAssistant?.errorMessage) ?? 'pi ended this turn without completing it.') : undefined;
    await this.reconcile(state, proc).catch(() => undefined);
    // A handled extension command can run independent work before its ACK. Its settled event
    // cannot establish ownership of the Riffet submission; decide once the ACK arrives.
    if ([...state.deliveries.values()].some(delivery => !delivery.disposition && delivery.expectedText === undefined)) {
      proc.pendingSettle = frame;
      return;
    }
    await this.host.transcript?.drain(state.workbenchSessionId).catch(() => undefined);
    await this.refreshContext(state, proc).catch(() => undefined);
    const deliveries = [...state.deliveries.values()];
    state.activeTurn = undefined;
    state.activeRunId = undefined;
    state.streamTurn = undefined;
    state.drafts.clear();
    state.metering.clearOpen();
    state.stopRequested = false;
    state.nativeActive = false;
    dropPending(state);
    if (status !== 'completed') state.failure = error;
    for (const delivery of deliveries) {
      if (delivery.entryId) await this.finishDelivery(state, delivery, status, at, error);
    }
    if (state.deliveries.size) {
      state.failure = 'pi settled without confirming the native input entry; this input will not be sent again.';
      await this.stop(state, proc);
    }
    this.emitStatus(state);
  }

  private queueSettled(state: PiConversation, proc: PiProcess, frame: RecordValue): Promise<void> {
    return proc.settling ??= this.settle(state, proc, frame).finally(() => { proc.settling = undefined; });
  }

  private outcomeOf(state: PiConversation, proc: PiProcess): 'completed' | 'failed' | 'cancelled' {
    if (proc.settledAborted || state.stopRequested) return 'cancelled';
    if (proc.retryError) return 'failed';
    const reason = str(proc.lastAssistant?.stopReason);
    if (reason === 'error') return 'failed';
    if (reason === 'aborted') return 'cancelled';
    return 'completed';
  }

  private async refreshContext(state: PiConversation, proc: PiProcess): Promise<void> {
    const stats = await proc.rpc.request({ type: 'get_session_stats' }, { timeoutMs: 10_000 });
    const usage = record(stats.contextUsage);
    const window = typeof usage?.contextWindow === 'number' ? usage.contextWindow : undefined;
    const tokens = typeof usage?.tokens === 'number' ? usage.tokens : undefined;
    // NativeContext requires measured counts. pi deliberately reports null after compaction;
    // remove the meter until a provider response supplies valid context usage again.
    state.context = window !== undefined && tokens !== undefined
      ? { used: tokens, size: window, breakdown: [] }
      : undefined;
    notify(state, { type: 'context', context: state.context });
  }

  /** Ends one delivery: on the journal when its native entry is known, else as a run-scoped row. */
  private async finishDelivery(state: PiConversation, delivery: PiDelivery, status: 'completed' | 'failed' | 'cancelled' | 'interrupted', at: string, error?: string): Promise<void> {
    state.deliveries.delete(delivery.commandId);
    if (!state.deliveries.size) {
      state.activeTurn = undefined;
      state.activeRunId = undefined;
      state.streamTurn = undefined;
    }
    if (delivery.entryId) {
      await this.host.transcript?.endTurn(state.workbenchSessionId, delivery.entryId, status, at, error).catch(() => undefined);
      return;
    }
    const outcome: PiTurnOutcome = { turnId: delivery.commandId, status, at, ...(error ? { error } : {}) };
    const event: NativeWorkbenchEvent = projectPiTurnEnd(outcome, {
      sessionId: state.workbenchSessionId,
      commandId: delivery.commandId,
      runId: delivery.runId,
    });
    this.host.emitEvent(state.workbenchSessionId, { ...event, nativeId: piTurnEndId(delivery.commandId) });
  }

  private startCompaction(state: PiConversation, frame: RecordValue): void {
    const reason = str(frame.reason);
    const id = activityId('pi', `compaction:${Date.now().toString(36)}-${++state.compactions}`);
    state.compaction = id;
    const activity = {
      id, kind: 'compaction' as const, status: 'running' as const, title: 'Context compaction',
      startedAt: new Date().toISOString(),
      compaction: { trigger: reason === 'manual' ? 'manual' as const : 'auto' as const },
    };
    this.host.emitEvent(state.workbenchSessionId, activityEvent(state.workbenchSessionId, activity));
    this.emitStatus(state);
  }

  private endCompaction(state: PiConversation, frame: RecordValue): void {
    const id = state.compaction;
    if (!id) return;
    state.compaction = undefined;
    const failed = Boolean(str(frame.errorMessage));
    const activity = {
      id, kind: 'compaction' as const, status: failed ? 'failed' as const : 'completed' as const, title: 'Context compaction',
      endedAt: new Date().toISOString(), ...(str(frame.errorMessage) ? { detail: str(frame.errorMessage) } : {}),
    };
    this.host.emitEvent(state.workbenchSessionId, activityEvent(state.workbenchSessionId, activity));
    // The conversation's context was replaced: the next turn starts from the new history.
    this.emitStatus(state);
  }

  async listModels(session: Session, project: Project, profile: NativeBackendProfileConfig): Promise<ModelInfo[]> {
    const state = this.conversation(session, project, profile);
    const proc = state.proc;
    if (proc && !proc.exited) {
      try {
        const answer = await proc.rpc.request({ type: 'get_available_models' }, { timeoutMs: REQUEST_TIMEOUT_MS });
        const infos = piModelInfos(Array.isArray(answer.models) ? answer.models : [], (await readPiSettings(profile)).defaultThinkingLevel);
        if (infos.length) {
          await listPiModels(profile, infos);
          return infos;
        }
      } catch { /* fall back to the files pi would read anyway */ }
    }
    return await listPiModels(profile);
  }
}

export function getPiRuntime(host: NativeBackendHost, stateDir?: string): PiRuntime {
  let runtime = runtimes.get(host);
  if (!runtime) {
    runtime = new PiRuntime(host, stateDir);
    runtimes.set(host, runtime);
  }
  return runtime;
}

export async function closePiRuntime(host: NativeBackendHost): Promise<void> {
  const runtime = runtimes.get(host);
  runtimes.delete(host);
  await runtime?.close();
}
