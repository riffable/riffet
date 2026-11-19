import { isDeepStrictEqual } from 'node:util';
import { realpath } from 'node:fs/promises';
import type { NativeInteraction, NativeRunConfig, NativeStatus, NativeTurnTarget, Project, Run } from '../../../../../packages/contracts/src/index.js';
import type { CodexAppServerClient } from '../shared/codex-app-server.js';
import { nativeModelEffort, nativeModelFast, parseNativeModelSelection } from '../shared/model-selection.js';
import { AppError } from '../../errors.js';
import type { NativeBackendHost, NativeDispatchBinding } from '../types.js';
import { fastServiceTier, listModels, modelBackendVariant, resolveModelSelection } from './catalog.js';
import type { CodexNativeCommand } from './commands.js';
import { STEER_MIN_VERSIONS, collaborationModeOf, permissionOf, supportsSteerVersion } from './config.js';
import type { CodexConnection } from './connection.js';
import { safeProviderError } from './errors.js';
import type { CodexEventLog } from './event-log.js';
import type { CodexFlavor } from './flavors.js';
import type { CodexHistoryReader } from './history-read.js';
import type { CodexHistorySync } from './history-sync.js';
import { MESSAGE_ID_PREFIX, STEER_ELEMENT_PREFIX } from './message-tag.js';
import type { CodexInteractions } from './pending.js';
import type { CodexSettings } from './settings.js';
import type { CodexSubagents } from './subagents.js';
import type { CodexTerminal } from './terminal.js';
import type { CodexThread } from './thread.js';
import type { CodexTurns } from './turns.js';
import type { RpcThread } from './types.js';
import { asArray, asRecord, str } from './util.js';

/** A written operation (`/compact`, `/review`) waiting for the turn it starts. */
export interface PendingNativeCommand {
  commandId: string;
  runId: string;
  config: NativeRunConfig;
  type: CodexNativeCommand['type'];
  transport: CodexAppServerClient;
  threadId: string;
  acknowledged: boolean;
  cancelled?: boolean;
  rejected?: boolean;
  foregroundEndedBeforeSend?: string;
  previousTurns: Set<string>;
  startedTurns: Set<string>;
  candidate?: string;
  userTurns: Set<string>;
  turnId?: string;
  resolve(turnId: string): void;
  reject(error: Error): void;
}

/** What a send carries from the adapter: the rendered input and the config the run was fenced with. */
export interface SendInput {
  runId: string;
  commandId: string;
  renderedText: string;
  input: unknown[];
  config: NativeRunConfig;
  nativeSessionId: string;
  command?: CodexNativeCommand;
  commitDispatchFence(binding?: NativeDispatchBinding): unknown;
}

/** What `CodexDispatch` needs from the runtime that owns it. */
export interface CodexDispatchContext {
  readonly host: NativeBackendHost;
  readonly sessionId: string;
  readonly project: Project;
  readonly flavor: CodexFlavor;
  readonly profileConfig: Record<string, unknown>;
  readonly connection: CodexConnection;
  readonly log: CodexEventLog;
  readonly turns: CodexTurns;
  readonly thread: CodexThread;
  readonly settings: CodexSettings;
  readonly interactions: CodexInteractions;
  readonly subagents: CodexSubagents;
  readonly sync: CodexHistorySync;
  readonly reader: CodexHistoryReader;
  readonly terminal: CodexTerminal;
  threadId(): string | undefined;
  status(): NativeStatus;
  /** The blocking request the card shows. */
  interaction(): NativeInteraction | undefined;
  /** What the card shows: a blocking request first, then the oldest unanswered async question. */
  currentInteraction(): NativeInteraction | undefined;
  /** Evidence of live traffic ends `starting` and `offline`; a link that already says work is going on stays. */
  resumed(): 'quiet' | 'working';
  scopedRequestId(threadId: string | undefined, id: string): string;
  attachLoadedOwner(): Promise<void>;
  refreshStatus(change: {
    link?: 'quiet' | 'working'; model?: string; approval?: string;
    notice?: { text: string; level: NativeStatus['noticeLevel']; source: 'transient' | 'other' } | undefined;
  }): void;
}

/**
 * What the workbench writes to the thread: a message that starts a turn or steers the running one, a
 * native command, and the interruption of a turn.
 *
 * It owns the native command waiting for its turn, the command id of one whose turn is not yet
 * known, and the checks that fence a write: the target a steer names, the settings a command verifies.
 *
 * It does not own the turn records (`turns.ts`), the settings it sends (`settings.ts`) or the status:
 * it records the submission in the turns, reads the settings, and asks the runtime to republish the status.
 */
export class CodexDispatch {
  /** A written operation without a receipted turn may still start, even after its local wait ends. */
  private unboundNativeCommand: string | undefined;
  nativeCommand?: PendingNativeCommand;

  constructor(private readonly ctx: CodexDispatchContext) {}

  /** The id a submitted message is tagged with, in the field the provider echoes back. */
  private messageTagOf(commandId: string): string {
    return this.ctx.flavor.messageTag.echo === 'id' ? `${MESSAGE_ID_PREFIX}${commandId}` : commandId;
  }

  /** Local evidence of a live turn on the attached owner connection. */
  private foregroundTarget(): (NativeTurnTarget & { ownerRunId?: string }) | undefined {
    const turnId = this.ctx.turns.unsettledActiveTurnId;
    const threadId = this.ctx.threadId();
    if (!this.ctx.connection.attached || !this.ctx.connection.transport?.isOnline || this.ctx.connection.bindingScopeMismatch || this.ctx.connection.endpointBlocked ||
      !threadId || !turnId ||
      this.ctx.status().connection?.state !== 'connected' || this.ctx.status().phase !== 'busy' || this.ctx.currentInteraction()) return undefined;
    const ownerRunId = this.ctx.turns.turnRun(turnId)?.runId;
    return { nativeSessionId: threadId, turnId, ...(ownerRunId ? { ownerRunId } : {}) };
  }

  /** Only a mapped Riffet run may authorize a foreground tool. */
  ownedForegroundTurn(): (NativeTurnTarget & { ownerRunId: string }) | undefined {
    const target = this.foregroundTarget();
    return target?.ownerRunId ? { ...target, ownerRunId: target.ownerRunId } : undefined;
  }

  /** Steering additionally depends on the native protocol version. */
  get steerTarget(): (NativeTurnTarget & { ownerRunId?: string }) | undefined {
    return supportsSteerVersion(this.ctx.connection.transport?.serverUserAgent, this.ctx.flavor.id) ? this.foregroundTarget() : undefined;
  }

  private assertSteerTarget(target: NativeTurnTarget): void {
    this.ctx.connection.assertWritable();
    const live = this.steerTarget;
    if (!live || live.nativeSessionId !== target.nativeSessionId || live.turnId !== target.turnId ||
      this.ctx.host.getSession(this.ctx.sessionId).nativeSessionId !== target.nativeSessionId) {
      throw new AppError('STEER_TARGET_CHANGED', 'The original turn is no longer active and writable; the instruction was not sent.', 409);
    }
  }

  async steer(input: {
    runId: string; commandId: string; renderedText: string; input: unknown[]; target: NativeTurnTarget;
    commitDispatchFence(binding?: NativeDispatchBinding): unknown;
  }): Promise<void> {
    // Updating the CLI symlink does not upgrade an already running app-server. Never advertise or
    // write steering to an unverified process, and never restart its task to obtain support.
    if (!supportsSteerVersion(this.ctx.connection.transport?.serverUserAgent, this.ctx.flavor.id)) {
      throw new AppError('STEER_UNSUPPORTED', `This ${this.ctx.flavor.label} app-server requires version ${STEER_MIN_VERSIONS[this.ctx.flavor.id]} or newer with verified steering receipts.`, 409);
    }
    this.assertSteerTarget(input.target);
    const terminal = this.ctx.terminal.id ? await this.ctx.host.terminal.get(this.ctx.terminal.id).catch(() => undefined) : undefined;
    this.ctx.turns.restoreCommands(input.target.turnId);
    // All asynchronous preparation precedes the final identity check and durable write fence.
    this.assertSteerTarget(input.target);
    const target = input.target;
    // A turn started in the native TUI may have no Riffet owner. Its steering input must not
    // become the execution owner just because it is the first Riffet command we observe.
    this.ctx.turns.ensureTurnRun(target.turnId);
    const ownerRunId = this.ctx.turns.turnRun(target.turnId)?.runId;
    const resolvedConfig = this.ctx.turns.turnConfig(target.turnId);
    const transport = this.ctx.connection.requireTransport();
    const taggedInput = this.ctx.flavor.id === 'traex' ? input.input.map(part => {
      const value = asRecord(part);
      if (value?.type !== 'text' || value.text !== input.renderedText) return part;
      return { ...value, text_elements: [...asArray(value.text_elements), {
        // A zero-width span survives native history without making the text an atomic UI element.
        byteRange: { start: 0, end: 0 }, placeholder: `${STEER_ELEMENT_PREFIX}${input.commandId}`,
      }] };
    }) : input.input;
    input.commitDispatchFence({
      backendId: this.ctx.flavor.id, nativeSessionId: target.nativeSessionId, nativeTurnId: target.turnId,
      ...(ownerRunId ? { ownerRunId } : {}),
      ...(terminal ? { terminalId: terminal.id, terminalEpoch: terminal.epoch } : {}),
      baselineSequence: this.ctx.log.headSequence, renderedText: input.renderedText,
      ...(resolvedConfig ? { resolvedConfig } : {}),
    });
    this.ctx.turns.submitCommand(input.commandId, input.runId);
    try {
      const result = await transport.request<{ turn?: { id: string }; turnId?: string }>('turn/steer', {
        threadId: target.nativeSessionId, expectedTurnId: target.turnId,
        ...(this.ctx.flavor.messageTag.echo === 'clientId' ? { clientUserMessageId: input.commandId } : {}),
        input: taggedInput,
      });
      if ((result.turn?.id ?? result.turnId) !== target.turnId) throw new Error(`${this.ctx.flavor.label} acknowledged a different turn`);
      // A completion may have arrived before this acknowledgement; never resurrect that turn.
      const outcome = this.ctx.turns.pendingOutcome(target.turnId);
      if (outcome) this.ctx.log.emitTurnOutcome(outcome, target.turnId);
    } catch (error) {
      if ((error as { rpcError?: boolean })?.rpcError) {
        this.ctx.turns.forgetCommand(target.turnId, input.commandId);
        const message = safeProviderError(error, this.ctx.profileConfig);
        const changed = /expected.*turn|turn.*mismatch|no active turn|not.*active|turn.*(?:finished|completed|ended)/i.test(message);
        throw new AppError(changed ? 'STEER_TARGET_CHANGED' : 'STEER_REJECTED', message, 409);
      }
      // A transport failure cannot prove the provider rejected a submitted message.
      throw error;
    }
  }

  async send(input: {
    runId: string;
    commandId: string;
    renderedText: string;
    input: unknown[];
    config: NativeRunConfig;
    nativeSessionId: string;
    command?: CodexNativeCommand;
    commitDispatchFence(binding?: NativeDispatchBinding): unknown;
  }): Promise<{ turnId: string }> {
    this.ctx.connection.assertWritable();
    if (input.command) return await this.sendCommand(input, input.command);
    const requestedModel = input.config.model ?? str(this.ctx.profileConfig.defaultModel);
    const requestedSelection = parseNativeModelSelection(requestedModel);
    const submittedAt = new Date().toISOString();
    this.ctx.turns.submitCommand(input.commandId, input.runId, submittedAt);
    const transport = this.ctx.connection.requireTransport();
    const modeObservation = this.ctx.settings.modeObservation;
    const modelSelection = await resolveModelSelection(transport, this.ctx.flavor, requestedSelection);
    const effort = nativeModelEffort(modelSelection);
    const serviceTier = fastServiceTier(this.ctx.flavor, modelSelection.model, nativeModelFast(modelSelection));
    const backendVariant = modelBackendVariant(this.ctx.flavor, modelSelection);
    const terminal = this.ctx.terminal.id ? await this.ctx.host.terminal.get(this.ctx.terminal.id).catch(() => undefined) : undefined;
    // A resolved candidate can require authoritative readback. Do not send its next turn in
    // the earlier observed mode merely because the resolution receipt completed first.
    while (this.ctx.settings.modeReconciliation) await this.ctx.settings.modeReconciliation;
    // Ordinary send follows the current foreground, unlike an explicit user-targeted steer.
    // Select after the final terminal await; a completed/replaced turn must never be steered.
    this.ctx.connection.assertWritable();
    const activeTurnId = this.ctx.turns.unsettledActiveTurnId;
    // The TUI may tighten permissions or resolve a mode decision during preparation. Fence and
    // submit the same effective config, not the adapter's earlier snapshot.
    if (this.ctx.flavor.id === 'traex') input.config = { ...input.config,
      approval: this.ctx.host.getSession(this.ctx.sessionId).approval,
      ...(this.ctx.settings.modeObservation !== modeObservation && this.ctx.settings.nativeMode ? { mode: this.ctx.settings.nativeMode } : {}),
    };
    const binding = {
      backendId: this.ctx.flavor.id,
      nativeSessionId: input.nativeSessionId,
      ...(terminal ? { terminalId: terminal.id, terminalEpoch: terminal.epoch } : {}),
      baselineSequence: this.ctx.log.headSequence,
      renderedText: input.renderedText,
      slashCommand: false,
      // Keep the accepted spelling in the run snapshot, but attribute the dispatch to the
      // canonical model sent below. The saved parameter suffix still selects the same controls.
      resolvedConfig: modelSelection.model === requestedSelection.model ? input.config : {
        ...input.config,
        model: modelSelection.model + (requestedModel?.trim().slice(requestedSelection.model.length) ?? ''),
      },
    };
    input.commitDispatchFence(binding);
    const permission = permissionOf(input.config.approval, this.ctx.flavor.id);
    // Codex states the sandbox per turn. TRAE inherits its observed native permissions unless
    // the requested mode changed, preserving profile modifications made in the TUI.
    const mode = this.ctx.flavor.modes.length ? collaborationModeOf(input.config.mode) : undefined;
    const modeModel = modelSelection.model || this.ctx.thread.model;
    const collaborationMode = mode && modeModel ? { mode, settings: { model: modeModel, reasoning_effort: effort === 'default' ? null : effort ?? null } } : undefined;
    const params = {
      threadId: input.nativeSessionId,
      [this.ctx.flavor.messageTag.request]: this.messageTagOf(input.commandId),
      input: input.input,
      model: modelSelection.model || null,
      ...(backendVariant ? { modelBackendVariant: backendVariant } : {}),
      ...this.ctx.settings.permissionParams(permission, 'sandboxPolicy'),
      effort: effort === 'default' ? null : effort ?? null,
      ...(serviceTier ? { serviceTier } : {}),
      // Each turn states its own mode, like its approval policy, so a browser turn runs in the mode
      // the browser shows even when the TUI switched in between. A mode never chosen is left alone.
      ...(collaborationMode ? { collaborationMode } : {}),
    };
    const foregroundEndedBeforeSend = this.ctx.turns.foregroundEndedTurnId;
    this.ctx.turns.beginDispatch(input.commandId);
    if (activeTurnId) this.ctx.turns.rememberCommand(activeTurnId, input.commandId, false);
    try {
      const steerClaim = activeTurnId && this.ctx.flavor.messageTag.echo === 'id'
        ? { turnId: activeTurnId, commandId: input.commandId, text: input.renderedText }
        : undefined;
      if (steerClaim) {
        this.ctx.turns.addSteerClaim(steerClaim);
      }
      let response: { turn?: { id: string }; turnId?: string };
      const permissionObservation = this.ctx.settings.permissionObservation;
      try {
        response = activeTurnId
          ? await transport.request<{ turn?: { id: string }; turnId?: string }>('turn/steer', {
            threadId: params.threadId,
            ...(this.ctx.flavor.messageTag.echo === 'clientId' ? { clientUserMessageId: input.commandId } : {}),
            input: params.input, expectedTurnId: activeTurnId,
          })
          : await transport.request<{ turn?: { id: string }; turnId?: string }>('turn/start', params);
      } catch (error) {
        // A definite rejection leaves a new thread empty. A lost acknowledgement may already
        // have started its first turn; native notifications independently supply that evidence.
        if (!(error as { rpcError?: boolean })?.rpcError) this.ctx.reader.beginMaterialization();
        // A message the provider never took must not claim a TUI message with the same text later.
        if (steerClaim) this.ctx.turns.dropSteerClaim(steerClaim);
        throw error;
      }
      this.ctx.reader.beginMaterialization();
      // Codex acknowledges with the turn; TRAE CLI's steer answers with just its id.
      const turnId = response.turn?.id ?? str(response.turnId);
      if (!turnId) throw new Error(`${this.ctx.flavor.label} app-server did not acknowledge the submitted turn`);
      if (!activeTurnId && this.ctx.flavor.id === 'traex' && Object.hasOwn(params, 'approvalPolicy')) {
        if (this.ctx.host.getSession(this.ctx.sessionId).configPending) {
          this.ctx.log.emit({ type: 'session', session: this.ctx.host.updateSession(this.ctx.sessionId, { configPending: false }) });
        }
        if (this.ctx.settings.permissionObservation !== permissionObservation) this.ctx.settings.adoptApproval(this.ctx.settings.permissionSettings);
        else {
          this.ctx.settings.nativeApproval = permission.id;
          this.ctx.refreshStatus({ approval: permission.id });
        }
      }
      // A new message supersedes the questions still open, as a TUI submission does.
      this.ctx.interactions.supersedeAsyncQuestions();
      this.ctx.turns.rememberCommand(turnId, input.commandId, !activeTurnId);
      if (!activeTurnId) this.ctx.turns.setTurnConfig(turnId, structuredClone(binding.resolvedConfig));
      const completedBeforeAck = this.ctx.turns.takePendingOutcome(turnId);
      if (completedBeforeAck) this.ctx.log.emitTurnOutcome(completedBeforeAck, turnId);
      // A fast completion can precede this response. Neither that turn nor a newer native turn
      // which started while the response was pending may be replaced by the acknowledgement.
      this.ctx.turns.settleAcknowledged(turnId, foregroundEndedBeforeSend, Boolean(completedBeforeAck));
      this.ctx.refreshStatus({ link: 'quiet', model: input.config.model || undefined, ...(completedBeforeAck ? {} : { notice: undefined }) });
      return { turnId };
    } finally {
      this.ctx.turns.endDispatch(input.commandId);
    }
  }

  /** Native operations have no user-message echo. Bind their real turn before reporting receipt. */
  private async sendCommand(input: SendInput, command: CodexNativeCommand): Promise<{ turnId: string }> {
    if (this.ctx.flavor.id !== 'codex') throw new AppError('NATIVE_COMMAND_UNSUPPORTED', 'This backend does not support this native command.', 400);
    const assertIdle = () => {
      if (this.ctx.turns.activeTurnId || this.nativeCommand || this.ctx.interaction() || this.ctx.status().phase === 'busy') {
        throw new AppError('CLI_BUSY', 'Finish or stop the current turn before running this command.', 409);
      }
    };
    assertIdle();
    const transport = this.ctx.connection.requireTransport();
    const terminal = this.ctx.terminal.id ? await this.ctx.host.terminal.get(this.ctx.terminal.id).catch(() => undefined) : undefined;
    // The setter ACK is not application evidence. Verify the final native snapshot after all
    // other preparation awaits, including on fresh threads, before the irreversible command.
    const verified = await this.verifyCommandConfig(input.config, input.nativeSessionId);
    this.ctx.connection.assertWritable();
    assertIdle();
    if (transport !== this.ctx.connection.transport || input.nativeSessionId !== this.ctx.threadId() || verified.observation !== this.ctx.settings.permissionObservation) {
      throw new AppError('NATIVE_COMMAND_CONFIG_UNVERIFIED', 'Native settings changed before the command could be submitted.', 409);
    }
    input.config = verified.config;
    const submittedAt = new Date().toISOString();
    const previousTurns = new Set([...this.ctx.turns.knownTurnIds(),
      ...this.ctx.log.events.map(event => event.nativeTurnId).filter((id): id is string => Boolean(id))]);
    let resolve!: (turnId: string) => void;
    let reject!: (error: Error) => void;
    const observed = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
    void observed.catch(() => undefined);
    const pending: PendingNativeCommand = { commandId: input.commandId, runId: input.runId, config: input.config, type: command.type, transport, threadId: input.nativeSessionId, acknowledged: false, foregroundEndedBeforeSend: this.ctx.turns.foregroundEndedTurnId, previousTurns, startedTurns: new Set(), userTurns: new Set(), resolve, reject };
    input.commitDispatchFence({ backendId: this.ctx.flavor.id, nativeSessionId: input.nativeSessionId,
      ...(terminal ? { terminalId: terminal.id, terminalEpoch: terminal.epoch } : {}),
      baselineSequence: this.ctx.log.headSequence, renderedText: input.renderedText, resolvedConfig: input.config, slashCommand: true });
    this.ctx.turns.submitCommand(input.commandId, input.runId, submittedAt);
    this.nativeCommand = pending;
    this.unboundNativeCommand = input.commandId;
    this.ctx.turns.beginDispatch(input.commandId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cancelled = observed.then(() => new Promise<never>(() => undefined));
      // Observe the RPC independently of the local wait: Stop must not discard a definitive
      // rejection or an authoritative review turn id which arrives after it releases the lock.
      const response = (command.type === 'review'
        ? transport.request<{ turn?: { id: string }; reviewThreadId: string }>('review/start', { threadId: input.nativeSessionId, delivery: 'inline',
          target: command.target.type === 'commit' ? { ...command.target, title: command.target.title ?? null } : command.target }).then(result => {
          if (!result.turn?.id || result.reviewThreadId !== pending.threadId) throw new Error('Codex did not identify the review turn.');
          pending.acknowledged = true;
          this.confirmNativeCommand(result.turn.id, pending);
        })
        : transport.request('thread/compact/start', { threadId: input.nativeSessionId }).then(() => {
          pending.acknowledged = true;
          if (this.nativeCommand === pending && pending.candidate) this.confirmNativeCommand(pending.candidate, pending);
        })).catch(error => { this.rejectNativeCommand(pending, error); throw error; });
      await Promise.race([response, cancelled]);
      this.ctx.reader.beginMaterialization();
      // The empty compact ACK means accepted, not completed. A missing start remains uncertain
      // behind the dispatch fence; it must never fall back to a prompt or retry the operation.
      const turnId = pending.turnId ?? await Promise.race([observed, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Codex accepted the command but its turn is unconfirmed.')), 10_000);
      })]);
      return { turnId };
    } finally {
      if (timer) clearTimeout(timer);
      if (this.nativeCommand === pending) this.nativeCommand = undefined;
      this.ctx.turns.endDispatch(input.commandId);
      if (pending.turnId && (this.ctx.turns.isSettled(pending.turnId) || this.ctx.turns.hasPendingOutcome(pending.turnId))
        && transport === this.ctx.connection.transport && transport.isOnline && this.ctx.status().phase !== 'offline') {
        this.ctx.refreshStatus({ link: 'quiet' });
      }
    }
  }

  private async verifyCommandConfig(config: NativeRunConfig, threadId: string): Promise<{ config: NativeRunConfig; observation: number }> {
    const transport = this.ctx.connection.requireTransport();
    const fail = (field: string) => new AppError('NATIVE_COMMAND_CONFIG_UNVERIFIED', `Native command settings were not confirmed (${field}).`, 409);
    if (this.ctx.settings.commandConfigObserver) throw fail('concurrent configuration');
    const notifications: Record<string, unknown>[] = [];
    let overflow = false;
    const observe = (settings: Record<string, unknown>) => {
      if (notifications.length < 64) notifications.push(settings); else overflow = true;
    };
    this.ctx.settings.commandConfigObserver = observe;
    try {
      const requested = config.model ?? str(this.ctx.profileConfig.defaultModel) ?? this.ctx.thread.model;
      const selection = await resolveModelSelection(transport, this.ctx.flavor, parseNativeModelSelection(requested));
      let effort = nativeModelEffort(selection);
      if (!selection.model) throw fail('model');
      if (effort === 'default') {
        const model = (await listModels(transport, this.ctx.flavor)).find(item => item.value === selection.model);
        effort = model?.configOptions.find(option => option.id === 'effort')?.currentValue;
        if (!effort || effort === 'default') throw fail('reasoning effort');
      }
      const tier = fastServiceTier(this.ctx.flavor, selection.model, nativeModelFast(selection));
      const permission = permissionOf(config.approval, this.ctx.flavor.id);
      const sandbox = this.ctx.settings.sandboxPolicy(permission.sandbox);
      const cwd = await realpath(this.ctx.project.cwd).catch(() => this.ctx.project.cwd);
      const profileId = permission.id === 'on-request' ? ':workspace' : permission.id === 'read-only' ? ':read-only' : ':danger-full-access';
      const matches = (value: Record<string, unknown>): boolean => {
        const profile = asRecord(value.activePermissionProfile);
        const provenance = value.activePermissionProfile == null || Boolean(profile && profile.id === profileId && profile.extends == null
          && (profile.modifications === undefined || Array.isArray(profile.modifications) && profile.modifications.length === 0)
          && Object.keys(profile).every(key => ['id', 'extends', 'modifications'].includes(key)));
        return provenance && value.model === selection.model && [cwd, this.ctx.project.cwd].includes(String(value.cwd))
          && value.approvalPolicy === permission.approvalPolicy && value.approvalsReviewer === 'user'
          && isDeepStrictEqual(value.sandbox, sandbox) && (effort === undefined || value.reasoningEffort === effort)
          && (tier === undefined || value.serviceTier === tier);
      };
      const assertNoConflict = () => {
        if (overflow || notifications.some(settings => !matches({ ...settings, sandbox: settings.sandboxPolicy, reasoningEffort: settings.effort }))) {
          throw fail('concurrent settings change');
        }
      };
      try {
        assertNoConflict();
        this.ctx.connection.assertWritable();
        if (transport !== this.ctx.connection.transport || !transport.isOnline || threadId !== this.ctx.threadId()) throw fail('connection');
        if (this.ctx.turns.activeTurnId || this.ctx.interaction() || this.ctx.status().phase === 'busy') throw new AppError('CLI_BUSY', 'Finish or stop the current turn before running this command.', 409);
        // Unlike resume overrides, this applies to an already loaded thread. Null effort preserves
        // the old effort, so an explicit default above resolves to the model catalog's actual value.
        await transport.request('thread/settings/update', { threadId, cwd: this.ctx.project.cwd, model: selection.model,
          approvalPolicy: permission.approvalPolicy, approvalsReviewer: 'user', ...(this.ctx.thread.standingProfile(permission) ? {} : { sandboxPolicy: sandbox }),
          ...(effort !== undefined ? { effort } : {}), ...(tier !== undefined ? { serviceTier: tier } : {}),
        });
        const deadline = Date.now() + 5_000;
        do {
          assertNoConflict();
          if (transport !== this.ctx.connection.transport || !transport.isOnline || this.ctx.threadId() !== threadId) throw fail('connection');
          const observation = this.ctx.settings.permissionObservation;
          const actual = await transport.request<Record<string, unknown>>('thread/resume', { threadId, excludeTurns: true });
          assertNoConflict();
          const thread = asRecord(actual.thread);
          if (thread?.id !== threadId) throw fail('thread');
          if (asRecord(thread.status)?.type === 'active' || this.ctx.turns.activeTurnId) throw new AppError('CLI_BUSY', 'Finish or stop the current turn before running this command.', 409);
          if (asRecord(thread.status)?.type === 'idle' && observation === this.ctx.settings.permissionObservation && matches(actual)) {
            this.ctx.thread.noteThread(thread as unknown as RpcThread, actual);
            const suffix = requested?.trim().slice(parseNativeModelSelection(requested).model.length) ?? '';
            return { config: { ...config, model: selection.model + suffix, approval: permission.id }, observation };
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        throw fail('model or permissions');
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw fail('native protocol');
      }
    } finally { if (this.ctx.settings.commandConfigObserver === observe) this.ctx.settings.commandConfigObserver = undefined; }
  }

  private rejectNativeCommand(pending: PendingNativeCommand, error: unknown): void {
    if (!(error as { rpcError?: boolean })?.rpcError || pending.turnId || pending.rejected) return;
    pending.rejected = true;
    if (this.unboundNativeCommand === pending.commandId) this.unboundNativeCommand = undefined;
    this.ctx.host.emitEvent(this.ctx.sessionId, { sequence: this.ctx.log.headSequence + 1, sessionId: this.ctx.sessionId,
      runId: pending.runId, type: 'native_input_rejected', nativeId: `${pending.threadId}:command:${pending.commandId}:rejected`, createdAt: new Date().toISOString(),
      data: { commandId: pending.commandId, nativeSessionId: pending.threadId, receiptKind: 'native_command', error: safeProviderError(error, this.ctx.profileConfig) },
    });
  }

  confirmNativeCommand(turnId: string, pending = this.nativeCommand): void {
    if (!pending || pending.rejected || pending.cancelled && pending.type !== 'review' || pending.turnId || pending.transport !== this.ctx.connection.transport || pending.threadId !== this.ctx.threadId()
      || !pending.transport.isOnline || pending.previousTurns.has(turnId) || pending.userTurns.has(turnId)) return;
    if (pending.type === 'compact') {
      pending.candidate = turnId;
      if (pending.startedTurns.size !== 1 || !pending.startedTurns.has(turnId)) return;
    }
    if (!pending.acknowledged) return;
    pending.turnId = turnId;
    if (this.unboundNativeCommand === pending.commandId) this.unboundNativeCommand = undefined;
    this.ctx.turns.rememberCommand(turnId, pending.commandId, true);
    this.ctx.turns.setTurnConfig(turnId, structuredClone(pending.config));
    const receipt = this.ctx.log.withStableSequence(this.ctx.log.makeEvent(
      `${this.ctx.threadId()}:${turnId}:command:${pending.commandId}`, turnId, this.ctx.turns.commandRun(pending.commandId)?.runId,
      'native_input_receipt', { commandId: pending.commandId, receiptKind: 'native_command', nativeSessionId: this.ctx.threadId() },
    ));
    this.ctx.log.pushEvent(receipt);
    this.ctx.host.emitEvent(this.ctx.sessionId, receipt);
    this.recordSubmittedTurn(turnId, pending.runId, pending.commandId);
    if (this.ctx.turns.adoptCommandTurn(turnId, pending.foregroundEndedBeforeSend)) this.ctx.refreshStatus({ link: this.ctx.resumed() });
    pending.resolve(turnId);
  }

  /** Release a local receipt wait so Stop can acquire the session lock; this does not stop Codex. */
  requestInterrupt(): void {
    const pending = this.nativeCommand;
    if (!pending) return;
    pending.cancelled = true;
    pending.reject(new Error('The native command receipt is unconfirmed.'));
  }

  async interrupt(targetTurnId?: string, targetThreadId = this.ctx.threadId()): Promise<void> {
    this.ctx.connection.assertWritable();
    const runs = this.ctx.host.listRuns?.(this.ctx.sessionId);
    const unresolved = (run: Run) => run.native && !run.native.nativeTurnId
      && (!run.native.nativeSessionId || run.native.nativeSessionId === this.ctx.threadId())
      && ['dispatching', 'input_sent', 'uncertain'].includes(run.native.delivery)
      && !['completed', 'failed', 'cancelled'].includes(run.state) && run.native.stage !== 'acknowledged'
      && /^\s*\/(compact|review)(?=\s|$)/.test(run.native.input.text);
    if (this.unboundNativeCommand && runs) {
      const run = runs.find(run => run.commandId === this.unboundNativeCommand);
      if (run && !unresolved(run)) this.unboundNativeCommand = undefined;
    }
    if (targetThreadId === this.ctx.threadId() && (this.unboundNativeCommand || this.ctx.flavor.id === 'codex' && runs?.some(unresolved))
      && (!targetTurnId || targetTurnId !== this.ctx.turns.activeTurnId)) {
      throw new AppError('NATIVE_INTERRUPT_UNCONFIRMED', 'The native command has no confirmed turn yet; stopping it could not be verified.', 409);
    }
    if (targetThreadId && targetThreadId !== this.ctx.threadId() && !this.ctx.subagents.owns(targetThreadId)) {
      throw new AppError('NATIVE_SESSION_NOT_CONNECTED', `The requested ${this.ctx.flavor.label} child is not associated with this session.`, 409);
    }
    if (!this.ctx.connection.transport?.isOnline) throw new Error(`${this.ctx.flavor.label} app-server is offline; the turn has not been confirmed stopped.`);
    if (!this.ctx.connection.attached) {
      // A reconnect has not observed the running turn yet. Rejoin only a verified loaded owner,
      // then read its current turn; lack of local state is not proof that the task already stopped.
      await this.ctx.attachLoadedOwner();
      this.ctx.connection.assertWritable();
      if (!this.ctx.connection.attached) throw new AppError('NATIVE_SESSION_NOT_CONNECTED', `The ${this.ctx.flavor.label} thread is not attached; its turn has not been confirmed stopped.`, 409);
      await this.ctx.sync.refreshEvents();
      if (!this.ctx.sync.snapshotReady) throw new AppError('NATIVE_HISTORY_UNAVAILABLE', `The current ${this.ctx.flavor.label} turn could not be read; interruption was not confirmed.`, 503);
    }
    const turnId = targetTurnId ?? (targetThreadId === this.ctx.threadId() ? this.ctx.turns.activeTurnId : undefined);
    if (!turnId || !targetThreadId) return;
    const waiterId = this.ctx.scopedRequestId(targetThreadId, turnId);
    const { completed, release } = this.ctx.turns.waitForCompletion(waiterId);
    let rejectTimeout!: (error: Error) => void;
    const timeoutReached = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    const timeout = setTimeout(() => {
      release();
      rejectTimeout(new Error(`${this.ctx.flavor.label} acknowledged interruption but did not confirm the turn stopped.`));
    }, 15_000);
    timeout.unref();
    try {
      await Promise.race([
        this.ctx.connection.requireTransport().request('turn/interrupt', { threadId: targetThreadId, turnId }).then(() => completed),
        timeoutReached,
      ]);
    } finally {
      clearTimeout(timeout);
      release();
    }
  }

  recordSubmittedTurn(turnId: string, runId: string, commandId: string): void {
    this.ctx.turns.confirmCommand(commandId, runId);
    this.ctx.turns.rememberCommand(turnId, commandId, false);
    const completedBeforeAck = this.ctx.turns.takePendingOutcome(turnId);
    if (completedBeforeAck) this.ctx.log.emitTurnOutcome(completedBeforeAck, turnId);
  }
}
