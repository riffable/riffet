import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ModelInfo, NativeContext, NativeInteraction, NativeInteractionResponse, NativeInteractionResult,
  NativeRunConfig, NativeRunInput, NativeStatus, NativeWorkbenchEvent,
  Project, Session,
} from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { activityEvent, activityId, withActivity } from '../../journal/activity.js';
import type { TranscriptSource } from '../../journal/ingest.js';
import { firstMessageTitlePatch, providerTitlePatch } from '../../session-title.js';
import { childHasExited, waitForExit } from '../shared/child-process.js';
import { DormancyClock } from '../shared/dormancy.js';
import { nativeModelEffort, parseNativeModelSelection } from '../shared/model-selection.js';
import { KeyedTurnTrackers } from '../shared/turn-tracker.js';
import type {
  NativeBackendHost, NativeBackendProfileConfig, NativeControlMessage,
  NativeDispatchBinding,
} from '../types.js';
import { findPiTranscript, piEntryUsage, readPiTranscript, type PiEntry, type PiTranscript } from './history.js';
import {
  piDefaultModel, piLaunchCommand, piEnvironment, listPiModels, piModelInfos,
  probePiCli, readPiSettings,
} from './models.js';
import { isPiPrompt, piBlockEventId, piTurnEndId, projectPiTurnEnd, type PiTurnOutcome } from './projection.js';
import { piCustomEndpoint, piCustomModelId, piProviderExtension, piProviderId, piRiffetMcpExtension } from './provider.js';
import { PiTranscriptSource } from './transcript.js';
import { PiRpcError, PiRpcTransport } from './transport.js';

/** A conversation with nothing running gives its process back after this long (droid's own choice). */
const IDLE_STOP_MS = 10 * 60_000;
const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** How long a written prompt may go unacknowledged before pi is stopped; until then a late ack still confirms it. */
const PROMPT_ACK_GRACE_MS = 5 * 60_000;
const STDERR_TAIL = 4 * 1024;
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

type RecordValue = Record<string, unknown>;

/** One streamed assistant block that has not reached pi's session file yet. */
export interface PiDraft {
  key: string;
  contentIndex: number;
  thought: boolean;
  text: string;
  at: string;
  entryId?: string;
  messageTimestamp?: number;
  turnId?: string;
  runId?: string;
}

interface PiDelivery {
  readonly commandId: string;
  readonly runId: string;
  readonly text: string;
  expectedText?: string;
  disposition?: string;
  readonly at: string;
  /** Entry index at the dispatch fence: ownership only looks after it. */
  readonly lastEntryId: string | null;
  readonly leafId: string | null;
  readonly recovered?: boolean;
  entryId?: string;
}

interface PiPendingUi {
  readonly requestId: string;
  readonly method: string;
  interaction: NativeInteraction;
  resolve(response: RecordValue): Promise<void>;
  timer?: NodeJS.Timeout;
}

interface PiProcess {
  readonly child: ChildProcess;
  readonly rpc: PiRpcTransport;
  stderr: string;
  stopping: boolean;
  exited: boolean;
  launchKey: string;
  exitTask?: Promise<void>;
  settling?: Promise<void>;
  pendingSettle?: RecordValue;
  stopTask?: Promise<void>;
  /** A settled run was aborted by pi. */
  settledAborted: boolean;
  /** Final retry failure, which outranks the last assistant's stop reason. */
  retryError?: string;
  lastAssistant?: RecordValue;
}

interface PiDesired {
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

interface PiConversation {
  readonly workbenchSessionId: string;
  session: Session;
  project: Project;
  profile: NativeBackendProfileConfig;
  nativeSessionId?: string;
  readonly listeners: Set<(message: NativeControlMessage) => void>;
  readonly wakers: Set<() => void>;
  context?: NativeContext;
  proc?: PiProcess;
  starting?: Promise<PiProcess>;
  status: NativeStatus;
  failure?: string;
  disposed: boolean;
  nativeActive: boolean;
  /** The selection a send must apply before its prompt. */
  desired?: PiDesired;
  /** What pi last reported. */
  reported: PiDesired;
  /** Unsettled prompts, by workbench command id. */
  readonly deliveries: Map<string, PiDelivery>;
  /** Confirmed native user entries, mapped to the command they answered. */
  readonly turns: Map<string, { commandId: string; runId: string }>;
  readonly drafts: Map<string, PiDraft>;
  /** The turn the streamed blocks belong to: a confirmed entry id, else the command id. */
  streamTurn?: string;
  activeTurn?: string;
  activeRunId?: string;
  /** Increments for each assistant message in a turn; draft keys stay unique across tool loops. */
  assistantStep: number;
  /** A stop was requested; the settled event is the outcome. */
  stopRequested: boolean;
  readonly pending: PiPendingUi[];
  readonly knownEntries: Set<string>;
  /** The last entry id the runtime has seen. */
  boundary?: string;
  loaded: boolean;
  firstMessage?: string;
  readonly dormancy: DormancyClock;
  compaction?: string;
  compactions: number;
  idleTimer?: NodeJS.Timeout;
  /** A non-fatal provider message, shown with its own level. */
  notice?: string;
  noticeLevel?: 'info' | 'warning' | 'error';
  /** An automatic retry still running: shown over `notice` without replacing it, gone once the retry or its turn ends. */
  retryNotice?: string;
}

const piTurns = new KeyedTurnTrackers<object>();
const runtimes = new WeakMap<NativeBackendHost, PiRuntime>();

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEntry(value: unknown): value is PiEntry {
  const entry = record(value);
  return typeof entry?.id === 'string' && typeof entry.type === 'string';
}

function messageOf(entry: PiEntry): RecordValue | undefined {
  return record(entry.message);
}

/** The user text of a prompt entry, ignoring images. */
function promptText(entry: PiEntry): string {
  const content = messageOf(entry)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap(value => {
    const block = record(value);
    return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
  }).join('\n');
}

/** Compares what the workbench sent with what pi persisted; an extension may rewrite the text. */
function samePrompt(sent: string, stored: string): boolean {
  return sent.trim() === stored.trim();
}

/** The workbench model form pi understands: `provider/modelId[effort=level]`. */
export function piModelValue(provider: string | undefined, modelId: string, thinkingLevel?: string): string {
  return `${provider ? `${provider}/` : ''}${modelId}${thinkingLevel ? `[effort=${thinkingLevel}]` : ''}`;
}

function splitModel(value: string | undefined): { provider?: string; modelId?: string } {
  const model = value?.trim();
  if (!model) return {};
  const slash = model.indexOf('/');
  if (slash <= 0) return { modelId: model };
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

function readReported(data: RecordValue): PiDesired {
  const model = record(data.model);
  const provider = str(model?.provider);
  const modelId = str(model?.id);
  const thinking = str(data.thinkingLevel);
  return {
    ...(provider ? { provider } : {}),
    ...(modelId ? { modelId } : {}),
    ...(thinking ? { thinkingLevel: thinking } : {}),
  };
}

/** A model selection is already in force when pi reports the same provider, id and level. */
function sameSelection(reported: PiDesired, desired: PiDesired): boolean {
  if (desired.modelId && desired.modelId !== reported.modelId) return false;
  if (desired.provider && desired.provider !== reported.provider) return false;
  if (desired.thinkingLevel && desired.thinkingLevel !== reported.thinkingLevel) return false;
  return true;
}

function notify(state: PiConversation, message: NativeControlMessage): void {
  for (const listener of state.listeners) {
    try { listener(message); } catch { /* one subscriber must not stop the others */ }
  }
}

function wake(state: PiConversation): void {
  for (const waker of state.wakers) {
    try { waker(); } catch { /* one reader must not stop the others */ }
  }
}

function dropPending(state: PiConversation): void {
  for (const pending of state.pending.splice(0)) {
    if (pending.timer) clearTimeout(pending.timer);
    void pending.resolve({ cancelled: true }).catch(() => undefined);
  }
}

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
    const prompt = await this.materialize(input.input);
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
    const answer = this.answerFor(pending, response);
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
      if (transcript) this.reconcileEntries(state, transcript.entries);
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
    this.restoreDeliveries(state, transcript.entries);
    this.reconcileEntries(state, transcript.entries);
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

  /**
   * Matches the entries pi appended to the prompt the workbench sent. Only a unique user entry after
   * that prompt's fence claims the run; a rewrite or a second candidate leaves it unclaimed rather
   * than guessing, and nothing is replayed.
   */
  private restoreDeliveries(state: PiConversation, entries: PiEntry[]): void {
    for (const run of this.host.listRuns?.(state.workbenchSessionId) ?? []) {
      const native = run.native;
      if (!native || native.nativeSessionId !== state.nativeSessionId) continue;
      if (native.nativeMessageId?.startsWith('msg:')) {
        state.turns.set(native.nativeMessageId.slice(4), { runId: run.id, commandId: run.commandId });
        continue;
      }
      if (!['dispatching', 'input_sent', 'uncertain'].includes(native.delivery) || !native.nativeInputBoundary || state.deliveries.has(run.commandId)) continue;
      try {
        const boundary = record(JSON.parse(native.nativeInputBoundary));
        if (boundary?.v !== 1 || !(boundary.lastEntryId === null || typeof boundary.lastEntryId === 'string') || !(boundary.leafId === null || typeof boundary.leafId === 'string')) continue;
        state.deliveries.set(run.commandId, {
          runId: run.id, commandId: run.commandId, text: native.renderedText ?? native.input.text,
          at: new Date(native.timings?.dispatchAt ?? Date.parse(run.createdAt)).toISOString(),
          lastEntryId: boundary.lastEntryId as string | null, leafId: boundary.leafId as string | null,
          recovered: true,
        });
      } catch { /* An invalid fence cannot establish receipt ownership. */ }
    }
  }

  private async reconcile(state: PiConversation, proc: PiProcess, initial = false): Promise<void> {
    if (state.proc !== proc || proc.exited) return;
    const { entries } = await this.getEntries(proc);
    if (initial) this.restoreDeliveries(state, entries);
    this.reconcileEntries(state, entries);
  }

  private reconcileEntries(state: PiConversation, entries: PiEntry[]): void {
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    // A native user entry must be after the complete append boundary and descend from the leaf
    // captured at dispatch. Count the whole candidate set before claiming either side.
    const candidates = new Map<PiDelivery, PiEntry[]>();
    for (const delivery of state.deliveries.values()) {
      if (delivery.entryId) continue;
      if (!delivery.recovered && delivery.disposition !== 'started' && delivery.expectedText === undefined) continue;
      const index = delivery.lastEntryId === null ? -1 : entries.findIndex(entry => entry.id === delivery.lastEntryId);
      if (delivery.lastEntryId !== null && index < 0) continue;
      const users = entries.slice(index + 1).filter(entry => {
        if (!isPiPrompt(entry) || !samePrompt(delivery.expectedText ?? delivery.text, promptText(entry))) return false;
        if (!Number.isFinite(Date.parse(entry.timestamp)) || Date.parse(entry.timestamp) < Date.parse(delivery.at)) return false;
        let parent = entry.parentId ?? null;
        const seen = new Set<string>();
        while (parent !== delivery.leafId) {
          if (parent === null || seen.has(parent)) return false;
          seen.add(parent);
          const ancestor = byId.get(parent);
          if (!ancestor || isPiPrompt(ancestor)) return false;
          parent = ancestor.parentId ?? null;
        }
        return true;
      });
      candidates.set(delivery, users);
    }
    for (const [delivery, users] of candidates) {
      if (users.length !== 1) continue;
      const entry = users[0]!;
      if ([...candidates.values()].filter(values => values.some(value => value.id === entry.id)).length !== 1) continue;
      if ([...state.turns.keys()].includes(entry.id)) continue;
      delivery.entryId = entry.id;
      state.turns.set(entry.id, { commandId: delivery.commandId, runId: delivery.runId });
      // The JSONL reader may have consumed the user entry before the get_entries response arrived.
      // A tagged receipt publishes the now-proven association without replaying provider input.
      this.host.emitEvent(state.workbenchSessionId, {
        sequence: 0, sessionId: state.workbenchSessionId, runId: delivery.runId,
        type: 'native_input_receipt', nativeId: `msg:${entry.id}`, nativeTurnId: entry.id,
        createdAt: entry.timestamp,
        data: { commandId: delivery.commandId, nativeSessionId: state.nativeSessionId },
      });
      if (!delivery.recovered) {
        state.activeTurn = entry.id;
        state.activeRunId = delivery.runId;
        for (const draft of state.drafts.values()) if (draft.turnId === delivery.commandId) draft.turnId = entry.id;
        state.streamTurn = entry.id;
      } else {
        state.deliveries.delete(delivery.commandId);
      }
    }
    for (const entry of entries) {
      const message = messageOf(entry);
      if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
      const timestamp = typeof message.timestamp === 'number' ? message.timestamp : undefined;
      if (timestamp === undefined) continue;
      for (const draft of state.drafts.values()) {
        if (draft.entryId || draft.messageTimestamp !== timestamp) continue;
        draft.entryId = entry.id;
      }
      const usage = piEntryUsage(entry);
      if (usage) {
        let ancestor: PiEntry | undefined = entry;
        const seen = new Set<string>();
        while (ancestor && !isPiPrompt(ancestor) && !seen.has(ancestor.id)) {
          seen.add(ancestor.id);
          ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
        }
        const runId = ancestor ? state.turns.get(ancestor.id)?.runId : undefined;
        const provider = str(message.provider), model = str(message.model);
        this.host.stats.recordUsage(state.workbenchSessionId, runId, {
          stepId: `pi:${entry.id}`, nativeMessageId: `msg:${entry.id}`,
          ...(model ? { model: provider ? `${provider}/${model}` : model } : {}),
          endedAt: Date.parse(entry.timestamp),
          inputTokens: usage.input, outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite,
          ...(typeof record(message.usage)?.reasoning === 'number' ? { reasoningTokens: record(message.usage)!.reasoning as number } : {}),
          tokenSource: 'provider',
        });
      }
    }
    state.boundary = entries.at(-1)?.id ?? state.boundary;
    wake(state);
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
        }
        return;
      }
      case 'message_update':
        this.handleUpdate(state, frame);
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
        this.handleUiRequest(state, frame);
        return;
      case 'extension_error':
        state.failure = str(frame.error) ? `${str(frame.event) ?? 'extension'}: ${str(frame.error)}` : 'A pi extension failed.';
        this.emitStatus(state);
        return;
      default:
    }
  }

  private handleUpdate(state: PiConversation, frame: RecordValue): void {
    const update = record(frame.assistantMessageEvent);
    const kind = str(update?.type);
    if (!update || !kind) return;
    const contentIndex = typeof update.contentIndex === 'number' && Number.isSafeInteger(update.contentIndex) && update.contentIndex >= 0 ? update.contentIndex : 0;
    const thought = kind.startsWith('thinking');
    if (!thought && !kind.startsWith('text')) return;
    if (!kind.endsWith('_start') && !kind.endsWith('_delta') && !kind.endsWith('_end')) return;
    const turn = state.activeTurn ?? state.streamTurn ?? 'live';
    const key = `${state.workbenchSessionId}:${state.activeRunId ?? turn}:${state.assistantStep}:${contentIndex}:${thought ? 'thinking' : 'text'}`;
    const draft = state.drafts.get(key) ?? {
      key,
      contentIndex,
      thought,
      text: '',
      at: new Date().toISOString(),
      ...(state.activeTurn ? { entryId: undefined, turnId: state.activeTurn } : { turnId: state.streamTurn }),
      ...(state.activeRunId ? { runId: state.activeRunId } : {}),
    };
    if (kind.endsWith('_delta')) draft.text += str(update.delta) ?? '';
    if (kind.endsWith('_end')) {
      const content = str(update.content);
      if (content) draft.text = content;
    }
    const partial = record(frame.message);
    if (typeof partial?.timestamp === 'number') draft.messageTimestamp = partial.timestamp;
    state.drafts.set(key, draft);
    wake(state);
  }

  private handleMessageEnd(state: PiConversation, proc: PiProcess, frame: RecordValue): void {
    const message = record(frame.message);
    if (message?.role === 'assistant') {
      proc.lastAssistant = message;
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

  private handleUiRequest(state: PiConversation, frame: RecordValue): void {
    const requestId = str(frame.id);
    const method = str(frame.method);
    if (!requestId || !method) return;
    if (method === 'notify') {
      const message = str(frame.message);
      if (message) {
        state.notice = message;
        state.noticeLevel = frame.notifyType === 'error' ? 'error' : frame.notifyType === 'warning' ? 'warning' : 'info';
        this.emitStatus(state);
      }
      return;
    }
    const interaction = this.uiInteraction(requestId, method, frame);
    if (!interaction) return;
    const proc = state.proc;
    if (!proc || proc.exited) {
      void proc?.rpc.send({ type: 'extension_ui_response', id: requestId, cancelled: true }).catch(() => undefined);
      return;
    }
    const pending: PiPendingUi = { requestId, method, interaction, resolve: answer => proc.rpc.send({ type: 'extension_ui_response', id: requestId, ...answer }) };
    if (interaction.expiresAt) {
      pending.timer = setTimeout(() => {
        const index = state.pending.indexOf(pending);
        if (index < 0) return;
        state.pending.splice(index, 1);
        void pending.resolve({ cancelled: true }).catch(() => undefined);
        this.emitStatus(state);
      }, Math.max(0, Date.parse(interaction.expiresAt) - Date.now()));
      pending.timer.unref();
    }
    state.pending.push(pending);
    this.emitStatus(state);
  }

  private uiInteraction(requestId: string, method: string, frame: RecordValue): NativeInteraction | undefined {
    const base = {
      id: `pi:${requestId}`,
      revision: `${requestId}:0`,
      transport: 'protocol' as const,
      requestId,
      ...(typeof frame.timeout === 'number' && frame.timeout > 0 ? { expiresAt: new Date(Date.now() + frame.timeout).toISOString() } : {}),
    };
    const title = str(frame.title);
    if (method === 'confirm') {
      return {
        ...base,
        kind: 'confirmation',
        title: title ?? 'Confirm',
        ...(str(frame.message) ? { message: str(frame.message) } : {}),
        options: [],
        actions: [{ id: 'confirm', label: 'Confirm', tone: 'primary' }, { id: 'cancel', label: 'Cancel', tone: 'danger' }],
      };
    }
    if (method === 'select') {
      const options = Array.isArray(frame.options) ? frame.options.flatMap(item => str(item) ?? []) : [];
      return {
        ...base,
        kind: 'choice',
        title: title ?? 'Choose',
        ...(str(frame.message) ? { message: str(frame.message) } : {}),
        options: options.map((label, index) => ({ id: `option:${index}`, label, selected: false })),
        actions: [{ id: 'answer', label: 'Choose', tone: 'primary' }, { id: 'cancel', label: 'Cancel', tone: 'danger' }],
      };
    }
    if (method === 'input' || method === 'editor') {
      return {
        ...base,
        kind: 'question',
        title: title ?? 'Input',
        ...(str(frame.placeholder) ? { message: str(frame.placeholder) } : {}),
        options: [],
        allowOther: true,
        ...(str(frame.prefill) ? { otherValue: str(frame.prefill), otherSelected: true } : {}),
        actions: [{ id: 'answer', label: 'Submit', tone: 'primary' }, { id: 'cancel', label: 'Cancel', tone: 'danger' }],
      };
    }
    return undefined;
  }

  private answerFor(pending: PiPendingUi, response: NativeInteractionResponse): RecordValue {
    if (response.action === 'cancel') return { cancelled: true };
    if (pending.method === 'confirm') return { confirmed: true };
    if (pending.method === 'select') {
      const selected = response.selectedIds ?? [];
      const option = pending.interaction.options.find(item => item.id === selected[0]);
      if (selected.length !== 1 || !option) throw new AppError('INVALID_INTERACTION_RESPONSE', 'Choose one available pi option.', 400);
      return { value: option.label };
    }
    return { value: response.otherText ?? '' };
  }

  private async materialize(input: NativeRunInput): Promise<{ text: string; images: Array<{ type: 'image'; data: string; mimeType: string }> }> {
    const extras = input.context.map(item => `@${item.path}${item.line ? `:${item.line}` : ''}`);
    const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
    for (const id of input.attachmentIds) {
      const { attachment, data } = await this.host.readAttachment(id);
      const mimeType = attachment.mimeType.toLowerCase();
      if (IMAGE_MEDIA_TYPES.has(mimeType) && data.length <= MAX_INLINE_IMAGE_BYTES) {
        images.push({ type: 'image', data: data.toString('base64'), mimeType });
        continue;
      }
      // pi reads files through its own tools; anything it cannot take as an image is handed over as a path.
      const directory = join(tmpdir(), 'riffet-attachments', attachment.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = join(directory, basename(attachment.name) || 'attachment');
      await writeFile(target, data, { mode: 0o600 });
      extras.push(target);
    }
    return { text: [input.text, ...(extras.length ? ['', ...extras] : [])].join('\n'), images };
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
