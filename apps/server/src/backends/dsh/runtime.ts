import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';
import type {
  ModelConfigOption, ModelInfo, NativeActivity, NativeRunConfig, NativeSlashItem, NativeInteraction, NativeInteractionResponse,
  NativeInteractionResult, NativeStatus, NativeWorkbenchEvent, Project, Session,
} from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { childHasExited, waitForExit } from '../shared/child-process.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativeControlMessage, NativeDispatchBinding } from '../types.js';
import type { ActivityLedger } from '../../journal/activity.js';
import { JOB_ACTIVITY_PREFIX, STOP_DEADLINE_MS, noteKilled, type JobWire } from './activities.js';
import { DshTranscriptSource } from './journal-source.js';
import { DshLogStore } from './log-store.js';
import { DshRpcPeer } from './rpc.js';
import type { DshModelInfo, DshSessionReadResult, PendingInteraction, DshAttachmentInfo, DshConversation, DshSubagent } from './types.js';
import { nonEmpty, asRecord } from './util.js';
import {
  DEFAULT_PROVIDER, runtimeSettings, nativeDshSessionId, requireSafeNativeSessionId, probeDshCli, resolveExecutable, scrubbedEnvironment,
  type DshRuntimeSettings,
} from './settings.js';
import {
  MODEL_UNAVAILABLE, PERMISSION_UNAVAILABLE, DSH_PERMISSIONS, dshPermission, toDshSelection, canonicalDshModelValue,
  modelValue, type DshConfigureResponse, type DshConfigureFailure,
} from './selection.js';
import { BRIDGE_PROTOCOL, peerHandlers, listenForBridge, waitForBridge, provisionBridgeProfile, closeServer } from './bridge.js';
import { dshTurns, statusFor, interactionRequestId } from './transcript.js';
import {
  configuredDshModelFallback, dshStatusFromResponse, dshTurnFailureMessage, IDLE_PUMP_INTERVAL_MS, IDLE_STOP_MS, notifyListeners,
  PUMP_INTERVAL_MS, STARTUP_TIMEOUT_MS, type DshObserver,
} from './runtime-shared.js';
import {
  cacheDshEvents, handleDshAgentStatus, handleDshAssistantStream, handleDshSessionEvent, pollDshConversation,
  refreshDshConversation, refreshDshSubagents, type DshEventHost,
} from './runtime-events.js';

export { nativeDshSessionId, validateDshNativeSessionId, probeDshCli } from './settings.js';
export { DSH_PERMISSIONS, dshPermission, canonicalDshModelValue, configAdoption, type DshConfigureFailure, type DshPermission } from './selection.js';
export { dshProfilePatch } from './bridge.js';
export type { DshObserver } from './runtime-shared.js';

const profileRuntimes = new WeakMap<NativeBackendHost, Map<string, DshProfileRuntime>>();
const profileStarts = new WeakMap<NativeBackendHost, Map<string, Promise<void>>>();

/** Different connection settings may share a persistent profile, but never an active writer. */
async function withProfileStart<T>(host: NativeBackendHost, directory: string, operation: () => Promise<T>): Promise<T> {
  let locks = profileStarts.get(host);
  if (!locks) { locks = new Map(); profileStarts.set(host, locks); }
  const previous = locks.get(directory) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  locks.set(directory, tail);
  await previous;
  try { return await operation(); }
  finally { release(); if (locks.get(directory) === tail) locks.delete(directory); }
}

/** Owns the no-TUI DSH profile process and routes its durable events to native sessions. */
export class DshProfileRuntime {
  readonly settings: DshRuntimeSettings;
  private child?: ChildProcess;
  private peer?: DshRpcPeer;
  private server?: net.Server;
  private startup?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  private stopping = false;
  private stoppingTask?: Promise<void>;
  private endpoint?: string;
  private token?: string;
  private readonly byWorkbenchId = new Map<string, DshConversation>();
  private readonly byNativeId = new Map<string, DshConversation>();
  /** Conversations a configuration change is being applied to right now; see {@link configAdoption}. */
  private readonly configuring = new Set<string>();
  /** Who follows a DSH session's changes without being a stream subscriber (sync v3 transcript sources); see {@link observe}. */
  private readonly observers = new Map<string, Set<DshObserver>>();
  private logStore?: DshLogStore;

  constructor(public profile: NativeBackendProfileConfig, private readonly host: NativeBackendHost, settings = runtimeSettings(profile)) {
    this.settings = settings;
  }

  private eventHost(): DshEventHost {
    return {
      settings: this.settings,
      isConfiguring: sessionId => this.configuring.has(sessionId),
      ensureStarted: provision => this.ensureStarted(provision),
      readPage: (state, before, limit, nativeSessionId, after) => this.readPage(state, before, limit, nativeSessionId, after),
      noteObservers: (nativeSessionId, method, params) => this.noteObservers(nativeSessionId, method, params),
      cacheEvents: (state, rawEvents) => this.cacheEvents(state, rawEvents),
      refreshSubagents: (state, items) => this.refreshSubagents(state, items),
      statusFromResponse: (state, response) => this.statusFromResponse(state, response),
      emitStatus: state => this.emitStatus(state),
      markOffline: (state, error) => this.markOffline(state, error),
      turnFailureMessage: (data, profile) => this.turnFailureMessage(data, profile),
    };
  }

  /** Refresh picker/default preferences without touching the models held by open conversations. */
  updateProfile(profile: NativeBackendProfileConfig, settings: DshRuntimeSettings): void {
    if (settings.key !== this.settings.key) throw new Error('Cannot change a DSH runtime\'s launch settings');
    this.profile = profile;
    Object.assign(this.settings, settings);
  }

  get states(): Iterable<DshConversation> { return this.byWorkbenchId.values(); }

  /** The profile's stored DSH session logs, read in place; reading them never starts DSH. */
  logs(): DshLogStore { return this.logStore ??= new DshLogStore(this.settings); }

  /**
   * Calls `listener` with every bridge notification of DSH session `nativeSessionId`, and with
   * `session/read` / `subagent/read` when a poll this runtime runs anyway found new records of it or of
   * one of its children, and `bridge/closed` when the DSH process went away. It starts nothing.
   */
  observe(nativeSessionId: string, listener: DshObserver): () => void {
    let set = this.observers.get(nativeSessionId);
    if (!set) this.observers.set(nativeSessionId, set = new Set());
    set.add(listener);
    return () => {
      set.delete(listener);
      if (!set.size && this.observers.get(nativeSessionId) === set) this.observers.delete(nativeSessionId);
    };
  }

  private noteObservers(nativeSessionId: string, method: string, params: Record<string, unknown>): void {
    for (const listener of this.observers.get(nativeSessionId) ?? []) {
      try { listener(method, params); } catch { /* an observer must not break the stream */ }
    }
  }

  /** Observes only this profile's existing bridge; never provisions or starts DSH. */
  async extensionRuntime(): Promise<import('../../../../../packages/contracts/src/index.js').ExtensionRuntimeReport> {
    const report: import('../../../../../packages/contracts/src/index.js').ExtensionRuntimeReport = { entries: [], diagnostics: [], checkedAt: new Date().toISOString() };
    if (!this.peer) { report.diagnostics.push('DSH 当前配置没有在线连接；运行状态未知。'); return report; }
    const response = await this.peer.request<{ available: boolean; plugins: Array<{ moduleName: string; enabled: boolean; fiberPhase: string }> }>('extensions/list', {}, 10_000);
    if (!response.available) report.diagnostics.push('当前 DSH composition 没有挂载插件管理服务。');
    report.entries = (response.plugins ?? []).map(row => ({ sessionId: this.settings.profileName, kind: 'plugin', name: row.moduleName, enabled: row.enabled, state: row.fiberPhase === 'active' ? 'loaded' : row.fiberPhase === 'failed' ? 'error' : row.fiberPhase === 'loading' ? 'pending' : 'unknown', message: row.fiberPhase ?? 'unknown' }));
    return report;
  }

  async manageExtension(action: string, target: string): Promise<import('../../../../../packages/contracts/src/index.js').ExtensionActionResult> {
    await this.ensureStarted(true);
    const result = await this.peer!.request<{ changed: boolean; application: string; error?: { code: string }; warnings?: string[]; packageResult?: { output?: string } }>('extensions/manage', { action, target }, 120_000);
    return { success: !result.error && ['applied', 'restart-required'].includes(result.application), applyEffect: result.application === 'restart-required' ? '配置已保存；DSH 需要重启 profile 后生效。' : `DSH 应用结果：${result.application}`, ...(result.error ? { diagnostics: [result.error.code, ...(result.warnings ?? [])] } : { diagnostics: result.warnings ?? [] }) };
  }

  /**
   * Whether this runtime holds the conversation open. DSH only accepts a configuration change on a
   * live agent, so an open conversation is what makes a switch take effect immediately instead of
   * waiting for the next send to carry it.
   */
  isOpen(sessionId: string): boolean {
    return Boolean(this.byWorkbenchId.get(sessionId)?.active && this.peer);
  }

  /** Marks a conversation whose configuration is in flight, so a read stops adopting DSH's settings. */
  setConfiguring(sessionId: string, configuring: boolean): void {
    if (configuring) this.configuring.add(sessionId);
    else this.configuring.delete(sessionId);
  }

  /** User-invocable skills for `cwd`, read through the bridge; starts the profile's DSH process if needed. */
  async slashItems(cwd: string): Promise<NativeSlashItem[]> {
    const response = await this.request<{ skills?: Array<Record<string, unknown>> }>('runtime/skills', { cwd }, 20_000);
    return (response.skills ?? []).flatMap(skill => {
      if (typeof skill.name !== 'string' || !skill.name) return [];
      const description = typeof skill.description === 'string' && skill.description ? skill.description : undefined;
      const path = typeof skill.path === 'string' && skill.path ? skill.path : undefined;
      return [{ name: skill.name, kind: 'skill' as const, ...(description ? { description } : {}), ...(path ? { path } : {}) }];
    });
  }

  async models(): Promise<ModelInfo[]> {
    if (!this.peer) return configuredDshModelFallback(this.settings.defaultModel);
    const response = await this.request<{ models?: DshModelInfo[] }>('runtime/models', {}, 20_000);
    return (response.models ?? []).map(model => {
      const efforts = model.reasoning?.efforts ?? [];
      const defaultEffort = model.reasoning?.defaultEffort ?? efforts[0]?.id;
      const configOptions: ModelConfigOption[] = efforts.length ? [{
        id: 'effort', name: 'Reasoning effort', category: 'thought_level', type: 'select',
        currentValue: defaultEffort ?? efforts[0]!.id,
        options: efforts.map(effort => ({ value: effort.id, name: effort.name, ...(effort.description ? { description: effort.description } : {}) })),
      }] : [];
      return {
        value: modelValue(model.provider, model.id),
        name: `${model.providerName}: ${model.name}`,
        ...(model.description ? { description: model.description } : {}),
        configOptions,
      };
    });
  }

  async open(session: Session, project: Project, profile: NativeBackendProfileConfig): Promise<{ nativeSessionId: string; status: NativeStatus }> {
    const canonicalModel = canonicalDshModelValue(session.model, this.settings.defaultModel);
    const currentSession = session.model === canonicalModel ? session : this.host.updateSession(session.id, { model: canonicalModel });
    if (currentSession !== session) this.host.emit(session.id, { type: 'session', session: currentSession });
    const state = this.conversation(currentSession, project, profile);
    state.session = currentSession;
    await this.ensureStarted(true);
    const current = toDshSelection(currentSession.model, DEFAULT_PROVIDER, this.settings.defaultModel);
    const permission = dshPermission(currentSession.approval);
    const response = await this.request<{ status?: 'busy' | 'idle'; model?: string; approval?: string; permission?: string }>('session/open', {
      sessionId: currentSession.id,
      nativeSessionId: state.nativeSessionId,
      cwd: project.cwd,
      selection: current,
      permission,
      approval: DSH_PERMISSIONS[permission],
    }, 30_000);
    state.active = true;
    state.status = this.statusFromResponse(state, response);
    state.historyTotal = 0;
    this.emitStatus(state);
    return { nativeSessionId: state.nativeSessionId, status: state.status };
  }

  private async refresh(state: DshConversation): Promise<void> {
    await refreshDshConversation(this.eventHost(), state);
  }

  subscribe(session: Session, project: Project, profile: NativeBackendProfileConfig, listener: (message: NativeControlMessage) => void): () => void {
    if (!session.nativeSessionId) return () => {};
    const state = this.conversation(session, project, profile, session.nativeSessionId);
    const first = !state.listeners.size;
    state.listeners.add(listener);
    if (state.context) listener({ type: 'context', context: state.context });
    if (first) void this.refresh(state);
    if (!state.pump && !state.polling) {
      void this.ensureStarted(false).then((started) => {
        if (!started || !state.listeners.size || state.pump || state.polling) return;
        this.schedulePump(state);
      }).catch(error => this.markOffline(state, error));
    }
    return () => {
      state.listeners.delete(listener);
      if (state.listeners.size === 0 && state.pump) {
        clearTimeout(state.pump);
        state.pump = undefined;
      }
      this.scheduleIdleStop();
    };
  }

  /** The status DSH reported; its background jobs are summarized from the journal (`NativeBackendService`). */
  status(session: Session): NativeStatus {
    return this.byWorkbenchId.get(session.id)?.status ?? { phase: 'offline' };
  }

  /**
   * Stops a background job: `stopping` now, `stopped` when DSH settles it as killed. The ledger of the
   * conversation's journal lane is the authority (G10): a repeated request joins the stop in flight, and a
   * stop DSH has not acted on by {@link STOP_DEADLINE_MS} after acknowledging it puts the job back to running.
   */
  async stopActivity(session: Session, activityId: string): Promise<NativeActivity> {
    const state = this.byWorkbenchId.get(session.id);
    if (!activityId.startsWith(JOB_ACTIVITY_PREFIX)) throw new AppError('ACTIVITY_NOT_FOUND', 'This activity is not known to the conversation', 404);
    const { activity, token } = await this.onLedger(session.id, ledger => {
      // Only the DSH process holding the conversation can stop its jobs.
      if (ledger.get(activityId) && !state?.active) throw new AppError('ACTIVITY_STOP_FAILED', 'DeepSeek Harness could not stop this job', 502);
      return ledger.beginStop(activityId);
    });
    if (token === undefined || !state) return activity;
    const undo = () => this.onLedger(session.id, ledger => ledger.stopFailed(activityId, token)).catch(() => undefined);
    let answer: { result?: string; job?: JobWire } | undefined;
    try {
      answer = await this.request<{ result?: string; job?: JobWire }>('job/kill', {
        sessionId: state.workbenchSessionId, nativeSessionId: state.nativeSessionId, jobId: activityId.slice(JOB_ACTIVITY_PREFIX.length), reason: 'Stopped from Riffet',
      }, 15_000);
    } catch (error) {
      await undo();
      const message = error instanceof Error ? error.message : String(error);
      if (/unknown DSH bridge method|unknown method|method not found|-32601|no background jobs/i.test(message) || (error as { rpcCode?: unknown } | undefined)?.rpcCode === -32601) {
        throw new AppError('ACTIVITY_STOP_UNSUPPORTED', 'This DeepSeek Harness profile cannot stop background jobs', 409);
      }
      throw new AppError('ACTIVITY_STOP_FAILED', 'DeepSeek Harness could not stop this job', 502);
    }
    const stopped = await this.onLedger(session.id, ledger => { noteKilled(ledger, answer?.job); return ledger.get(activityId)!; });
    if (stopped.status === 'stopping') setTimeout(() => { void undo(); }, STOP_DEADLINE_MS).unref();
    return stopped;
  }

  /** Runs `task` on the activity ledger of the conversation's main lane, between its reads; jobs belong to the main lane. */
  private async onLedger<T>(sessionId: string, task: (ledger: ActivityLedger) => T): Promise<T> {
    const outcome = await this.host.transcript?.withSource(sessionId, (source, w) => {
      if (!(source instanceof DshTranscriptSource)) return undefined;
      try { return { value: task((w.scratch ?? w).activities) }; } catch (error) { return { error }; }
    });
    if (!outcome) throw new AppError('ACTIVITY_NOT_FOUND', 'This activity is not known to the conversation', 404);
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }

  /**
   * DSH closes a turn its process died in only when the session is next resumed; until then the journal
   * would show it running. Called once the process is gone, so everything it wrote is on disk.
   */
  private endCrashedTurns(sessionIds: readonly string[], at: string, error?: string): void {
    for (const sessionId of sessionIds) {
      void this.host.transcript?.withSource(sessionId, (source, w) => source instanceof DshTranscriptSource ? source.endOpenTurn(w, at, error) : undefined)
        .catch(() => undefined);
    }
  }

  interaction(session: Session): NativeInteraction | undefined {
    return this.byWorkbenchId.get(session.id)?.interaction;
  }

  async send(input: {
    session: Session;
    project: Project;
    profile: NativeBackendProfileConfig;
    commandId: string;
    runId: string;
    config: NativeRunConfig;
    content: Array<Record<string, unknown>>;
    attachments: DshAttachmentInfo[];
    renderedText: string;
    isCancelled(): boolean;
    commitDispatchFence(binding?: NativeDispatchBinding): unknown;
  }): Promise<void> {
    let state = this.byWorkbenchId.get(input.session.id);
    if (!state?.active || !this.peer) {
      await this.open(input.session, input.project, input.profile);
      state = this.byWorkbenchId.get(input.session.id);
      if (!state) throw new Error('DeepSeek Harness session did not open');
    }
    if (input.config.mode && input.config.mode !== 'agent') throw new AppError('NATIVE_MODE_UNSUPPORTED', 'DeepSeek Harness only supports Agent mode', 400);
    const selected = toDshSelection(input.config.model ?? input.session.model, DEFAULT_PROVIDER, this.settings.defaultModel);
    const permission = dshPermission(input.config.approval);
    const resolvedConfig: NativeRunConfig = {
      model: modelValue(selected.provider, selected.model, selected.reasoningEffort),
      mode: 'agent',
      approval: permission,
    };
    await this.request('session/validate-content', { content: input.content }, 30_000);
    const statusBeforeBaseline = state.status;
    const baseline = await this.readPage(state, undefined, 1);
    // The snapshot carries DSH's live phase as well as the transcript. Prefer it when no newer
    // status notification arrived while the read was in flight; a later notification wins over
    // this response so a stale idle snapshot cannot hide a newly busy turn.
    if (baseline.found && baseline.status && state.status === statusBeforeBaseline) {
      state.status = this.statusFromResponse(state, baseline.status);
    }
    if (baseline.found) {
      this.cacheEvents(state, baseline.events);
      state.historyTotal = baseline.total;
    }
    if (input.isCancelled()) return undefined;
    if (state.status.phase === 'busy' || state.status.phase === 'attention') {
      throw new AppError('CLI_BUSY', 'DeepSeek Harness is still processing the previous message.', 409);
    }
    input.commitDispatchFence({
      backendId: 'dsh',
      nativeSessionId: state.nativeSessionId,
      // Where the receipt is looked for; the service starts it at the end of the conversation's log.
      baselineSequence: 0,
      renderedText: input.renderedText,
      resolvedConfig,
    });
    try {
      await this.request<unknown>('session/send', {
        sessionId: input.session.id,
        nativeSessionId: state.nativeSessionId,
        cwd: resolve(state.project.cwd),
        commandId: input.commandId,
        runId: input.runId,
        content: input.content,
        attachments: input.attachments,
        config: { modelSelection: selected, permission, approval: DSH_PERMISSIONS[permission] },
      }, 20_000);
    } catch (error) {
      // This is a no-replay send path: the caller owns the committed dispatch fence.
      throw new Error(`DeepSeek Harness did not acknowledge this send; its outcome may be uncertain (${error instanceof Error ? error.message : String(error)})`);
    }
    state.status = { ...statusFor(state, 'busy'), model: resolvedConfig.model, approval: permission, permission };
    this.emitStatus(state);
  }

  async interrupt(session: Session, beforeWrite?: () => void): Promise<void> {
    const state = this.byWorkbenchId.get(session.id);
    if (!session.nativeSessionId) return;
    if (!state || state.nativeSessionId !== session.nativeSessionId || !this.peer || !state.active) {
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'DeepSeek Harness is offline and its stop could not be confirmed.', 503);
    }
    const result = await this.request<{ interrupted?: boolean }>('session/interrupt', {
      sessionId: state.workbenchSessionId,
      nativeSessionId: state.nativeSessionId,
      cwd: resolve(state.project.cwd),
    }, 10_000, beforeWrite);
    if (result.interrupted !== true) {
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'DeepSeek Harness did not confirm that the turn stopped.', 503);
    }
  }

  /**
   * Switches a conversation's model or approval policy.
   *
   * DSH only accepts this on a live agent: its own session controller resolves (resumes) a session
   * before it installs a selection, because a selection no agent holds cannot be logged. The driver
   * opens the conversation first for the same reason — a change that stayed a workbench-only record
   * would be reported back over by DSH's own state on the next read.
   */
  async configure(session: Session, patch: { model?: string; mode?: string; approval?: string }): Promise<{ nativeSessionId?: string; failure?: DshConfigureFailure }> {
    if (patch.mode && patch.mode !== 'agent') throw new AppError('NATIVE_MODE_UNSUPPORTED', 'DeepSeek Harness only supports Agent mode', 400);
    const permission = patch.approval === undefined ? undefined : dshPermission(patch.approval);
    const state = this.byWorkbenchId.get(session.id);
    if (!state?.active || !this.peer) {
      throw new AppError('NATIVE_SESSION_NOT_OPEN', 'Open this DeepSeek Harness conversation before switching its model or approval mode', 409);
    }
    const selection = patch.model === undefined
      ? undefined
      : toDshSelection(patch.model, DEFAULT_PROVIDER, this.settings.defaultModel);
    const apply = async () => await this.request<DshConfigureResponse>('session/configure', {
      sessionId: state.workbenchSessionId,
      nativeSessionId: state.nativeSessionId,
      cwd: resolve(state.project.cwd),
      ...(selection ? { modelSelection: selection } : {}),
      ...(permission ? { permission, approval: DSH_PERMISSIONS[permission] } : {}),
    }, 10_000);
    let response = await apply();
    if (response.configured === false && response.reason === undefined) {
      // The bridge no longer holds this conversation — a restarted profile, or an idle stop between
      // the driver's open and this call. Resume it and ask once more, rather than reporting a change
      // that never reached DSH.
      await this.open(state.session, state.project, this.profile);
      response = await apply();
    }
    // The bridge validates the route the way DSH's own controller does, so a provider or reasoning
    // effort this profile cannot serve is refused here instead of being written into the record and
    // failing at a turn.
    if (response.configured === false) {
      return response.reason === MODEL_UNAVAILABLE || response.reason === PERMISSION_UNAVAILABLE
        ? { failure: { reason: response.reason, ...(response.message ? { message: response.message } : {}) } }
        : { failure: { reason: 'session-not-open' } };
    }
    if (patch.model !== undefined) state.session.model = patch.model;
    if (permission !== undefined) state.session.approval = permission;
    state.status = this.statusFromResponse(state, response);
    this.emitStatus(state);
    return { nativeSessionId: state.nativeSessionId };
  }

  async respond(session: Session, response: NativeInteractionResponse): Promise<NativeInteractionResult> {
    const state = this.byWorkbenchId.get(session.id);
    const current = state?.interaction;
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
    const nativeRequestId = current ? interactionRequestId(current) : undefined;
    if (!state || !current || current.id !== response.interactionId || current.revision !== response.revision) {
      return { status: 'uncertain', ...(current ? { interaction: current } : {}), message: 'This DeepSeek Harness interaction is no longer active.' };
    }
    const pending = nativeRequestId ? state.interactionRequests.get(nativeRequestId) : undefined;
    if (!pending) return { status: 'uncertain', message: 'This DeepSeek Harness interaction is no longer active.' };
    if (!current.actions.some(action => action.id === response.action)) {
      return { status: 'uncertain', interaction: current, message: 'The selected action is not available for this interaction.' };
    }
    const pendingId = nativeRequestId!;
    const next = state.interactionQueue[0];
    const result: NativeInteractionResult = next
      ? { status: 'advanced', interaction: next.interaction }
      : { status: 'completed' };
    this.host.saveInteractionReceipt(session.id, response.requestId, {
      fingerprint,
      interactionId: response.interactionId,
      revision: response.revision,
      result,
      createdAt: new Date().toISOString(),
    });
    state.interactionRequests.delete(pendingId);
    clearTimeout(pending.timer);
    pending.resolve(response);
    state.interaction = undefined;
    this.activateNextInteraction(state);
    state.status = statusFor(state, state.interaction ? 'attention' : state.active ? 'busy' : 'offline');
    this.emitStatus(state);
    return result;
  }

  async dispose(sessionId: string): Promise<void> {
    const state = this.byWorkbenchId.get(sessionId);
    if (!state) return;
    if (state.active && this.peer) {
      await this.request('session/dispose', {
        sessionId: state.workbenchSessionId,
        nativeSessionId: state.nativeSessionId,
        cwd: resolve(state.project.cwd),
      }, 15_000).catch(() => undefined);
    }
    for (const pending of state.interactionRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('DeepSeek Harness session was closed'));
    }
    state.interactionRequests.clear();
    state.listeners.clear();
    if (state.pump) clearTimeout(state.pump);
    this.byWorkbenchId.delete(sessionId);
    this.byNativeId.delete(state.nativeSessionId);
    this.scheduleIdleStop();
  }

  async disposeProfile(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.startup) await this.startup.catch(() => undefined);
    const logs = this.logStore;
    this.logStore = undefined;
    try { await this.stop(); } finally { await logs?.close(); }
  }

  private conversation(session: Session, project: Project, profile: NativeBackendProfileConfig, nativeSessionId = nativeDshSessionId(session)): DshConversation {
    requireSafeNativeSessionId(nativeSessionId);
    const requestedCwd = resolve(project.cwd);
    const existing = this.byWorkbenchId.get(session.id);
    if (existing) {
      if (existing.nativeSessionId !== nativeSessionId || resolve(existing.project.cwd) !== requestedCwd || existing.profile.id !== profile.id) {
        throw new AppError('NATIVE_SESSION_SCOPE_MISMATCH', 'This workbench session is already bound to another DeepSeek Harness session or workspace.', 409);
      }
      return existing;
    }
    const nativeOwner = this.byNativeId.get(nativeSessionId);
    if (nativeOwner && (nativeOwner.workbenchSessionId !== session.id || resolve(nativeOwner.project.cwd) !== requestedCwd || nativeOwner.profile.id !== profile.id)) {
      throw new AppError('NATIVE_SESSION_ID_INUSE', 'This DeepSeek Harness session is already owned by another workbench session or workspace.', 409);
    }
    const state: DshConversation = {
      workbenchSessionId: session.id,
      nativeSessionId,
      session,
      project,
      profile,
      host: this.host,
      listeners: new Set(),
      events: new Map(),
      interactionQueue: [],
      interactionRequests: new Map(),
      status: { phase: 'offline' },
      active: false,
      historyTotal: 0,
      turnCommands: new Map(),
      commandMap: new Map(),
      metrics: new Map(),
      attempts: new Map(),
      subagents: new Map(),
      contextFacts: {},
    };
    this.byWorkbenchId.set(session.id, state);
    this.byNativeId.set(nativeSessionId, state);
    return state;
  }

  /**
   * One `session/read`. `after` asks for nothing older than that record; a bridge from before it was
   * understood ignores it and returns the full window, which the caller trims by `start`.
   */
  private async readPage(state: DshConversation, before: number | undefined, limit: number, nativeSessionId = state.nativeSessionId, after?: number): Promise<DshSessionReadResult> {
    return await this.request<DshSessionReadResult>('session/read', {
      sessionId: state.workbenchSessionId,
      nativeSessionId,
      cwd: resolve(state.project.cwd),
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      limit,
    }, 20_000);
  }

  /** Projects records just read and remembers them; returns the projected events. */
  private cacheEvents(state: DshConversation, rawEvents: unknown[]): NativeWorkbenchEvent[] {
    return cacheDshEvents(this.eventHost(), state, rawEvents);
  }

  /** What a failed `turn/end` record says went wrong, without the profile's secrets. */
  turnFailureMessage(data: Record<string, unknown>, profile: NativeBackendProfileConfig = this.profile): string | undefined {
    return dshTurnFailureMessage(this.settings, data, profile);
  }

  private async refreshSubagents(state: DshConversation, items?: readonly DshSubagent[]): Promise<void> {
    await refreshDshSubagents(this.eventHost(), state, items);
  }

  private statusFromResponse(state: DshConversation, response: DshSessionReadResult['status'] | { status?: 'busy' | 'idle'; model?: string; provider?: string; reasoningEffort?: string; approval?: string; permission?: string } | undefined): NativeStatus {
    return dshStatusFromResponse(state, response);
  }

  handleNotification(method: string, params: Record<string, unknown>): void {
    const state = this.byNativeId.get(nonEmpty(params.nativeSessionId) ?? '');
    if (!state) return;
    if (typeof params.sessionId === 'string' && params.sessionId !== state.workbenchSessionId) return;
    this.noteObservers(state.nativeSessionId, method, params);
    if (method === 'session/event') {
      handleDshSessionEvent(this.eventHost(), state, params);
    } else if (method === 'agent/status') {
      // A bridge older than the fix above packed stream frames into `agent/status`. Accepting
      // both keeps live text working until the profile is reprovisioned on the next start.
      if (asRecord(params.assistantStream)) handleDshAssistantStream(state, params);
      else handleDshAgentStatus(this.eventHost(), state, params);
    } else if (method === 'agent/assistant-stream') {
      handleDshAssistantStream(state, params);
    } else if (method === 'interaction/cancel') {
      this.cancelInteraction(state, nonEmpty(params.requestId));
    } else if (method === 'bridge/error') {
      this.markOffline(state, new Error(nonEmpty(params.message) ?? 'DeepSeek Harness bridge reported an error'));
    }
  }

  async handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'bridge/ready') {
      if (params.token !== this.token || params.protocolVersion !== BRIDGE_PROTOCOL || params.profileName !== this.settings.profileName) {
        throw new Error('DeepSeek Harness bridge authentication or protocol version failed');
      }
      return { protocolVersion: BRIDGE_PROTOCOL };
    }
    if (method === 'interaction/open') return await this.openInteraction(params);
    throw new Error(`Unsupported request from DeepSeek Harness: ${method}`);
  }

  private async openInteraction(params: Record<string, unknown>): Promise<NativeInteractionResponse> {
    const nativeSessionId = nonEmpty(params.nativeSessionId);
    const state = nativeSessionId ? this.byNativeId.get(nativeSessionId) : undefined;
    const workbenchSessionId = nonEmpty(params.sessionId);
    const interaction = asRecord(params.interaction) as NativeInteraction | undefined;
    const requestId = interaction ? interactionRequestId(interaction) : undefined;
    if (!state || state.workbenchSessionId !== workbenchSessionId || !interaction || !requestId) throw new Error('DeepSeek Harness interaction has an invalid session or request id');
    return await new Promise<NativeInteractionResponse>((resolve, reject) => {
      const pending: PendingInteraction = {
        interaction,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.cancelInteraction(state, requestId, new Error('DeepSeek Harness interaction expired'));
        }, 10 * 60_000),
      };
      state.interactionRequests.set(requestId, pending);
      if (state.interaction) state.interactionQueue.push(pending);
      else {
        state.interaction = interaction;
        state.status = statusFor(state, 'attention');
        this.emitStatus(state);
      }
    });
  }

  private cancelInteraction(state: DshConversation, requestId: string | undefined, error = new Error('DeepSeek Harness interaction cancelled')): void {
    if (!requestId) return;
    const pending = state.interactionRequests.get(requestId);
    if (!pending) return;
    state.interactionRequests.delete(requestId);
    clearTimeout(pending.timer);
    const queuedIndex = state.interactionQueue.indexOf(pending);
    if (queuedIndex >= 0) state.interactionQueue.splice(queuedIndex, 1);
    if (state.interaction?.requestId === requestId) {
      state.interaction = undefined;
      this.activateNextInteraction(state);
    }
    pending.reject(error);
    state.status = statusFor(state, state.interaction ? 'attention' : state.active ? 'busy' : 'idle');
    this.emitStatus(state);
  }

  private activateNextInteraction(state: DshConversation): void {
    if (state.interaction) return;
    const next = state.interactionQueue.shift();
    if (next) state.interaction = next.interaction;
  }

  private emitStatus(state: DshConversation): void {
    state.status = statusFor(state, state.interaction ? 'attention' : state.status.phase);
    notifyListeners(state, { type: 'status', status: state.status });
    if (state.pump && (state.pumpDelay ?? 0) > this.pumpDelay(state)) this.schedulePump(state);
    this.scheduleIdleStop();
  }

  private pumpDelay(state: DshConversation): number {
    // Continuable children keep working after the parent's turn ends.
    if ([...state.subagents.values()].some(item => item.running)) return PUMP_INTERVAL_MS;
    return state.status.phase === 'idle' || state.status.phase === 'offline' ? IDLE_PUMP_INTERVAL_MS : PUMP_INTERVAL_MS;
  }

  private schedulePump(state: DshConversation): void {
    if (state.pump) clearTimeout(state.pump);
    state.pump = undefined;
    if (!state.listeners.size || state.polling) return;
    state.pumpDelay = this.pumpDelay(state);
    state.pump = setTimeout(() => {
      state.pump = undefined;
      state.polling = true;
      void this.poll(state).finally(() => {
        state.polling = false;
        this.schedulePump(state);
      });
    }, state.pumpDelay);
  }

  private async ensureStarted(provision: boolean): Promise<boolean> {
    if (this.startup) await this.startup;
    if (this.stoppingTask) await this.stoppingTask;
    if (this.peer && this.child && !childHasExited(this.child)) return true;
    if (this.peer || this.child || this.server) await this.stop();
    if (!provision && !existsSync(join(this.settings.profileDir, 'package.json'))) return false;
    const task = this.start();
    this.startup = task;
    try { await task; return true; } catch (error) { throw error; } finally { if (this.startup === task) this.startup = undefined; }
  }

  private async start(): Promise<void> {
    return withProfileStart(this.host, this.settings.profileDir, async () => {
      for (const other of profileRuntimes.get(this.host)?.values() ?? []) {
        if (other === this || other.settings.profileDir !== this.settings.profileDir || (!other.peer && !other.child)) continue;
        if (other.startup || other.stoppingTask || [...other.states].some(state => state.status.phase === 'busy' || state.interaction || state.interactionRequests.size > 0)) {
          throw new AppError('DSH_PROFILE_BUSY', 'Conversations are still running or waiting for input on this DSH profile; apply the new connection settings after they finish.', 409);
        }
        await other.stop();
      }
      await this.startExclusive();
    });
  }

  private async startExclusive(): Promise<void> {
    // Every spawn rewrites the bridge, including one started by a history read: DSH loads the
    // bridge once per process, so a spawn that skipped this would run the previous build's bridge
    // until the next DSH restart. `ensureStarted` has already refused to create a missing profile.
    await provisionBridgeProfile(this.settings);
    const available = await probeDshCli(this.profile);
    if (!available.available) throw new AppError('DSH_RUNTIME_UNAVAILABLE', available.reason ?? 'DeepSeek Harness is unavailable', 503);
    const command = resolveExecutable(this.settings);
    if (!command) throw new AppError('DSH_RUNTIME_UNAVAILABLE', 'The configured DSH sourceDir has no built apps/cli/lib/bin.js.', 503);
    const { server, endpoint, token } = await listenForBridge();
    this.server = server;
    this.endpoint = endpoint;
    this.token = token;
    const environment: NodeJS.ProcessEnv = {
      ...scrubbedEnvironment(),
      DSH_HOME: this.settings.profileHome,
      RIFFET_DSH_BRIDGE_ENDPOINT: endpoint,
      RIFFET_DSH_BRIDGE_TOKEN: token,
      RIFFET_DSH_PROFILE_NAME: this.settings.profileName,
      ...(this.settings.apiEndpoint ? { DEEPSEEK_BASE_URL: this.settings.apiEndpoint } : {}),
      ...(this.settings.apiKey ? { DEEPSEEK_API_KEY: this.settings.apiKey } : {}),
    };
    const child = spawn(command.executable, [...command.args, '--profile', this.settings.profileName, '--patch', this.settings.bridgePatchPath], {
      cwd: command.cwd,
      env: environment,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    this.child = child;
    let startupReject: (error: Error) => void = () => {};
    const exited = new Promise<never>((_resolve, reject) => { startupReject = reject; });
    child.once('error', (error) => startupReject(error));
    child.once('exit', (code, signal) => startupReject(new Error(`DeepSeek Harness exited during startup (${code ?? signal ?? 'unknown'})`)));
    let startupTimer: NodeJS.Timeout | undefined;
    const startupTimeout = new Promise<never>((_resolve, reject) => {
      startupTimer = setTimeout(() => reject(new Error('DeepSeek Harness bridge startup timed out')), STARTUP_TIMEOUT_MS);
    });
    try {
      const peer = await Promise.race([waitForBridge(server, token, this.settings.profileName), exited, startupTimeout]);
      if (!(peer instanceof DshRpcPeer)) throw new Error('DeepSeek Harness bridge startup timed out');
      this.peer = peer;
      this.stopping = false;
      peerHandlers.set(peer, this);
      child.once('exit', (code, signal) => {
        if (this.child === child && !this.stopping) {
          this.handleClose(new Error(`DeepSeek Harness exited (${code ?? signal ?? 'unknown'})`));
        }
      });
      child.once('error', (error) => {
        if (this.child === child && !this.stopping) this.handleClose(error);
      });
      this.scheduleIdleStop();
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    } finally {
      if (startupTimer) clearTimeout(startupTimer);
    }
  }

  private async request<T>(method: string, params: Record<string, unknown>, timeoutMs = 15_000, beforeWrite?: () => void): Promise<T> {
    await this.ensureStarted(method.startsWith('session/open') || method.startsWith('session/send'));
    const peer = this.peer;
    if (!peer) throw new Error('DeepSeek Harness profile is not available for read-only access');
    beforeWrite?.();
    return await peer.request<T>(method, params, timeoutMs);
  }

  private async poll(state: DshConversation): Promise<void> {
    await pollDshConversation(this.eventHost(), state, Boolean(this.peer));
  }

  handleClose(error: Error): void {
    if (this.stopping) return;
    const at = new Date().toISOString();
    const open = [...this.byWorkbenchId.values()].filter(state => state.active).map(state => state.workbenchSessionId);
    for (const state of this.byWorkbenchId.values()) state.active = false;
    const cleanup = this.stop();
    for (const state of this.byWorkbenchId.values()) {
      this.noteObservers(state.nativeSessionId, 'bridge/closed', {});
      // Continuable children live in the DSH process that just exited.
      for (const item of state.subagents.values()) {
        if (!item.running) continue;
        item.running = false;
        notifyListeners(state, { type: 'subagent', toolCallId: item.toolCallId, agentId: item.childId, running: false });
      }
      this.markOffline(state, error);
      for (const pending of state.interactionRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      state.interactionRequests.clear();
      state.interactionQueue.length = 0;
      state.interaction = undefined;
    }
    void cleanup.catch(() => undefined).then(() => this.endCrashedTurns(open, at, error.message));
  }

  private markOffline(state: DshConversation, error: unknown): void {
    state.status = { phase: dshTurns.report(state, 'offline'), noticeLevel: 'error', notice: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240) };
    this.emitStatus(state);
  }

  private scheduleIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const isBusy = [...this.byWorkbenchId.values()].some(state => state.status.phase === 'busy' || state.listeners.size > 0 || state.interactionRequests.size > 0 || state.interaction !== undefined);
    if (isBusy || !this.peer) return;
    this.idleTimer = setTimeout(() => { void this.stop().catch(() => undefined); }, IDLE_STOP_MS);
  }

  private stop(): Promise<void> {
    if (this.stoppingTask) return this.stoppingTask;
    const task = this.stopCurrent();
    this.stoppingTask = task;
    void task.then(
      () => { if (this.stoppingTask === task) this.stoppingTask = undefined; },
      () => { if (this.stoppingTask === task) this.stoppingTask = undefined; },
    );
    return task;
  }

  private async stopCurrent(): Promise<void> {
    this.stopping = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const peer = this.peer;
    const child = this.child;
    this.peer = undefined;
    if (peer) peer.destroy();
    let terminated = !child || childHasExited(child);
    let cleanupError: Error | undefined;
    try {
      if (child && !terminated) {
        child.kill('SIGTERM');
        terminated = await waitForExit(child, 2_000);
        if (!terminated) {
          child.kill('SIGKILL');
          terminated = await waitForExit(child);
        }
        if (!terminated) cleanupError = new Error('DeepSeek Harness child process did not exit after SIGKILL');
      }
    } finally {
      const server = this.server;
      if (server) await closeServer(server);
      if (this.server === server) this.server = undefined;
      this.endpoint = undefined;
      this.token = undefined;
      if (child && childHasExited(child) && this.child === child) this.child = undefined;
      this.stopping = false;
      const open: string[] = [];
      for (const state of this.byWorkbenchId.values()) {
        if (state.active) {
          open.push(state.workbenchSessionId);
          state.active = false;
          this.noteObservers(state.nativeSessionId, 'bridge/closed', {});
          state.status = statusFor(state, 'offline');
          this.emitStatus(state);
        }
      }
      if (terminated) this.endCrashedTurns(open, new Date().toISOString());
    }
    if (cleanupError) throw cleanupError;
  }
}

export function getDshProfileRuntime(profile: NativeBackendProfileConfig, host: NativeBackendHost): DshProfileRuntime {
  const settings = runtimeSettings(profile);
  const key = settings.key;
  let runtimes = profileRuntimes.get(host);
  if (!runtimes) {
    runtimes = new Map<string, DshProfileRuntime>();
    profileRuntimes.set(host, runtimes);
  }
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = new DshProfileRuntime(profile, host, settings);
    runtimes.set(key, runtime);
  } else runtime.updateProfile(profile, settings);
  return runtime;
}

export async function disposeDshSession(host: NativeBackendHost, sessionId: string): Promise<void> {
  const runtimes = profileRuntimes.get(host);
  if (!runtimes) return;
  for (const runtime of runtimes.values()) await runtime.dispose(sessionId);
}

export async function closeDshProfileRuntimes(host: NativeBackendHost): Promise<void> {
  const runtimes = profileRuntimes.get(host);
  if (!runtimes) return;
  profileRuntimes.delete(host);
  try {
    await Promise.allSettled([...runtimes.values()].map(runtime => runtime.disposeProfile()));
  } finally {
    runtimes.clear();
  }
}
