import type { ModelInfo, NativeStatus, NativeStreamMessage, Project, SessionGoal } from '../../../../../packages/contracts/src/index.js';
import { nativeModelEffort, nativeModelFast, parseNativeModelSelection } from '../shared/model-selection.js';
import { firstHumanMessage, firstMessageTitlePatch, isPromptTitle, nativeTitlePatch } from '../../session-title.js';
import type { NativeBackendHost } from '../types.js';
import { fastServiceTier, listModels, modelBackendVariant, resolveModelSelection } from './catalog.js';
import {
  collaborationModeOf, hasNativePermissions, normalizePermission, permissionOf, permissionParamsOf, reportedTraePermission, sandboxPolicyOf,
} from './config.js';
import type { CodexConnection } from './connection.js';
import type { CodexEventLog } from './event-log.js';
import type { CodexFlavor } from './flavors.js';
import { codexGoal, sameGoal } from './goal.js';
import type { CodexHistoryReader } from './history-read.js';
import type { CodexThread } from './thread.js';
import type { CodexTurns } from './turns.js';
import type { RpcThread } from './types.js';
import { asRecord, str } from './util.js';

/** What `CodexSettings` needs from the runtime that owns it. */
export interface CodexSettingsContext {
  readonly host: NativeBackendHost;
  readonly sessionId: string;
  readonly project: Project;
  readonly flavor: CodexFlavor;
  readonly connection: CodexConnection;
  threadId(): string | undefined;
  status(): NativeStatus;
  turns(): CodexTurns;
  thread(): CodexThread;
  reader(): CodexHistoryReader;
  log(): CodexEventLog;
  /** The runtime's copy of the session is stale after the host changed it. */
  reloadSession(): void;
  emit(message: NativeStreamMessage): void;
  openOrResume(override?: { model?: string; approval?: string }): Promise<string>;
  applyThreadStatus(status: RpcThread['status']): void;
  refreshStatus(change: { approval: string }): void;
}

/**
 * What the conversation is set to run with, as the thread reports it and as the reader asked for it:
 * permissions, collaboration mode, model, goal and title.
 *
 * It owns the last native permission and mode it observed, the counters that tell whether a
 * notification overtook a write of its own, the mode readback in flight, the observer that a
 * native command's settings check installs, and the title push in flight.
 *
 * It does not own the session record, the thread or the status: it writes the session through the
 * host, asks the runtime to reload its copy and to republish the status, and sends settings over the connection.
 */
export class CodexSettings {
  private configuring = false;
  /*
   * The fields below are read by the send path as fences: whether a notification overtook what it
   * was about to write. Only this class writes the counters and the observed settings.
   */
  /** The recorded mode corresponding to the last observed native permissions, including customizations. */
  nativeApproval: string | undefined;
  /** Native collaboration mode is independent of permission presets and browser configuration intent. */
  nativeMode: string | undefined;
  modeObservation = 0;
  /** The native mode readback in flight, which a send waits for. */
  modeReconciliation: Promise<void> | undefined;
  permissionObservation = 0;
  permissionSettings: Record<string, unknown> | undefined;
  /** Receives every settings notification of the thread while a native command's settings are being verified. */
  commandConfigObserver?: (settings: Record<string, unknown>) => void;
  /** The name a `thread/name/set` in flight is giving the thread. */
  private pushingTitle: string | undefined;

  constructor(private readonly ctx: CodexSettingsContext) {}

  /** A `thread/settings/updated` of the conversation's own thread: counted as an observation, then adopted. */
  observe(settings: Record<string, unknown> | undefined): void {
    this.commandConfigObserver?.(settings ?? {});
    this.permissionObservation += 1;
    this.permissionSettings = settings;
    this.adoptApproval(settings);
    this.adoptSettingsMode(settings);
  }

  adoptApproval(settings: Record<string, unknown> | undefined): void {
    if (this.ctx.flavor.id !== 'traex' || this.configuring) return;
    const session = this.ctx.host.getSession(this.ctx.sessionId);
    if (session.configPending) return;
    const approval = reportedTraePermission(settings);
    if (settings?.approvalPolicy !== undefined && settings.approvalsReviewer !== undefined) {
      this.nativeApproval = approval ?? normalizePermission(session.approval, this.ctx.flavor.id);
    }
    if (!approval) {
      // Keep the configured intent as the inheritance fence, but do not label extended/native
      // permission profiles as a bare built-in preset. Only an explicit picker change replaces it.
      if (this.hasNativePermissions(settings)) this.ctx.refreshStatus({ approval: 'custom' });
      return;
    }
    if (approval !== session.approval) {
      const updated = this.ctx.host.bumpConfig(session.id, { approval });
      this.ctx.emit({ type: 'session', session: updated });
    }
    this.ctx.reloadSession();
    this.ctx.refreshStatus({ approval });
  }

  private hasNativePermissions(settings: Record<string, unknown> | undefined): boolean {
    return hasNativePermissions(settings);
  }

  adoptMode(mode: string | undefined): void {
    if (this.ctx.flavor.id !== 'traex' || !mode || !this.ctx.flavor.modes.some(option => option.id === mode)) return;
    // Even same-value settings are observations, but this counter is only a read fence: it
    // cannot order a provider's settings event against its independently resolved mode request.
    this.nativeMode = mode;
    this.modeObservation += 1;
    const session = this.ctx.host.getSession(this.ctx.sessionId);
    if (session.mode !== mode) {
      this.ctx.emit({ type: 'session', session: this.ctx.host.bumpConfig(session.id, { mode }) });
      this.ctx.reloadSession();
    }
  }

  adoptSettingsMode(settings: Record<string, unknown> | undefined): void {
    const model = str(settings?.model);
    this.ctx.thread().noteModel(model);
    this.adoptMode(str(asRecord(settings?.collaborationMode)?.mode));
  }

  /** Reads the settings back after a mode change whose winner cannot be told from observation counts alone. */
  startModeReconciliation(threadId: string): void {
    const task = this.reconcileMode(threadId).finally(() => {
      if (this.modeReconciliation === task) this.modeReconciliation = undefined;
    });
    this.modeReconciliation = task;
  }

  /** Read effective settings without selecting a mode/model or resuming the native execution. */
  private async reconcileMode(threadId: string): Promise<void> {
    const transport = this.ctx.connection.transport;
    if (this.ctx.flavor.id !== 'traex' || !transport?.isOnline || this.ctx.threadId() !== threadId) return;
    // ThreadSettingsUpdateParams has only threadId required; omitted overrides leave settings
    // unchanged. Its current-settings response is the protocol's readback (there is no get RPC).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const observation = this.modeObservation;
      try {
        const response = await transport.request<{ threadSettings?: Record<string, unknown> | null }>('thread/settings/update', { threadId });
        if (this.ctx.connection.transport !== transport || !transport.isOnline || this.ctx.threadId() !== threadId) return;
        if (this.modeObservation !== observation) continue;
        this.adoptSettingsMode(response.threadSettings ?? undefined);
        return;
      } catch { return; } // Empty legacy replies/outages leave the last actual observation intact.
    }
  }

  sandboxPolicy(mode: ReturnType<typeof permissionOf>['sandbox']): Record<string, unknown> {
    return sandboxPolicyOf(mode);
  }

  permissionParams(permission: ReturnType<typeof permissionOf>, sandboxField: 'sandbox' | 'sandboxPolicy', force = false): Record<string, unknown> {
    // An unchanged TRAE mode inherits the actual native profile, including additional roots and
    // custom restrictions. Only an explicit switch may replace it with a bare built-in preset.
    if (this.ctx.flavor.id === 'traex' && !force && this.nativeApproval === permission.id && !this.ctx.host.getSession(this.ctx.sessionId).configPending) return {};
    if (this.ctx.thread().standingProfile(permission)) return { approvalPolicy: permission.approvalPolicy };
    return permissionParamsOf(permission, sandboxField);
  }

  async applyThreadConfig(config: { model?: string; approval?: string; mode?: string }, updateApproval = true): Promise<{ approval?: string; mode?: string }> {
    this.ctx.connection.assertWritable();
    const observedBeforeConfig = this.permissionObservation;
    let effectiveApproval: string | undefined;
    let effectiveMode: string | undefined;
    this.configuring = updateApproval;
    try {
      // The open itself has to carry the merged setting rather than the runtime's construction-time
      // snapshot; the native settings update below keeps an already-attached thread in step rather
      // than correcting a thread that this call has just created with stale settings.
      const current = this.ctx.threadId();
      if (current && this.ctx.flavor.id !== 'traex') {
        const observed = await this.ctx.reader().readThread(current, false).catch(() => undefined);
        if (this.ctx.turns().activeTurnId || this.ctx.status().phase === 'busy' || observed?.status?.type === 'active') {
          this.ctx.applyThreadStatus(observed?.status);
          return {};
        }
      }
      const threadId = await this.ctx.openOrResume({ model: config.model, ...(updateApproval ? { approval: config.approval } : {}) });
      const transport = this.ctx.connection.requireTransport();
      const selection = await resolveModelSelection(transport, this.ctx.flavor, parseNativeModelSelection(config.model));
      const effort = nativeModelEffort(selection);
      const serviceTier = fastServiceTier(this.ctx.flavor, selection.model, nativeModelFast(selection));
      const backendVariant = modelBackendVariant(this.ctx.flavor, selection);
      const modelConfig = {
        ...(effort && effort !== 'default' ? { model_reasoning_effort: effort } : {}),
        ...(backendVariant ? { model_backend_variant: backendVariant } : {}),
      };
      const permission = permissionOf(config.approval, this.ctx.flavor.id);
      // TRAE has an explicit settings setter. A new, already-attached thread may have no rollout
      // until its first turn, so resuming it merely to change settings would fail before the setter.
      if (this.ctx.flavor.id !== 'traex') {
        const response = await transport.request<{ thread: RpcThread } & Record<string, unknown>>('thread/resume', {
          threadId,
          cwd: this.ctx.project.cwd,
          model: selection.model || null,
          ...this.permissionParams(permission, 'sandbox', true),
          ...(serviceTier ? { serviceTier } : {}),
          ...(Object.keys(modelConfig).length ? { config: modelConfig } : {}),
          excludeTurns: true,
        });
        this.ctx.thread().noteThread(response.thread, response);
      }
      // Resume carries no mode; the thread's own settings do, which is also what an attached TUI shows.
      const mode = collaborationModeOf(config.mode);
      const modeModel = selection.model || this.ctx.thread().model;
      const collaborationMode = mode && modeModel && this.ctx.flavor.modes.length ? { mode, settings: { model: modeModel, reasoning_effort: effort === 'default' ? null : effort ?? null } } : undefined;
      if (this.ctx.flavor.id === 'traex' || collaborationMode) {
        // Keep TRAE's model and variant in one update, including Standard when leaving Max.
        const permissionObservation = this.permissionObservation;
        const modeObservation = this.modeObservation;
        const response = await transport.request<{ threadSettings?: Record<string, unknown> | null }>('thread/settings/update', {
          threadId,
          ...(this.ctx.flavor.id === 'traex' ? {
            ...(selection.model ? { model: selection.model } : {}),
            ...(backendVariant ? { modelBackendVariant: backendVariant } : {}),
            effort: effort === 'default' ? null : effort ?? null,
            ...(updateApproval ? this.permissionParams(permission, 'sandboxPolicy', true) : {}),
          } : {}),
          ...(collaborationMode ? { collaborationMode } : {}),
        });
        if (this.ctx.flavor.id === 'traex') {
          if (this.modeObservation === modeObservation) this.adoptSettingsMode(response.threadSettings ?? undefined);
          if (this.modeObservation !== modeObservation) effectiveMode = this.nativeMode;
          if (!updateApproval) {
            // A TUI notification received while awaiting this reply may already be newer.
            if (this.permissionObservation === permissionObservation) this.adoptApproval(response.threadSettings ?? undefined);
          }
          else {
            const newerSettings = this.permissionObservation !== permissionObservation ? this.permissionSettings : undefined;
            const effectiveSettings = newerSettings ?? response.threadSettings ?? undefined;
            const reported = reportedTraePermission(effectiveSettings);
            effectiveApproval = reported ?? (newerSettings ? normalizePermission(this.ctx.host.getSession(this.ctx.sessionId).approval, this.ctx.flavor.id) : permission.id);
            this.nativeApproval = effectiveApproval;
            this.ctx.refreshStatus({ approval: !reported && this.hasNativePermissions(effectiveSettings) ? 'custom' : this.nativeApproval });
          }
        }
      }
    } catch (error) {
      this.configuring = false;
      // A failed write cannot invalidate a native settings notification received while awaiting it.
      if (updateApproval && this.permissionObservation !== observedBeforeConfig) this.adoptApproval(this.permissionSettings);
      throw error;
    } finally { this.configuring = false; }
    return {
      ...(effectiveApproval !== undefined ? { approval: effectiveApproval } : {}),
      ...(effectiveMode !== undefined ? { mode: effectiveMode } : {}),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return await listModels(this.ctx.connection.requireTransport(), this.ctx.flavor);
  }

  /** Keep the session's goal equal to the thread's. */
  adoptGoal(goal: SessionGoal | undefined): void {
    if (sameGoal(goal, this.ctx.host.getSession(this.ctx.sessionId).goal)) return;
    this.ctx.emit({ type: 'session', session: this.ctx.host.updateSession(this.ctx.sessionId, { goal }) });
  }

  /** Reads the thread's goal once it is attached; a CLI without goals answers with an error and leaves the stored one. */
  async readGoal(threadId: string): Promise<void> {
    try {
      const response = await this.ctx.connection.requireTransport().request<{ goal?: unknown }>('thread/goal/get', { threadId });
      if (this.ctx.threadId() !== threadId) return;
      const goal = codexGoal(response.goal);
      // The thread keeps a finished goal until the next one; here it already stepped aside unless it was still on show.
      if (goal?.status === 'complete' && this.ctx.host.getSession(this.ctx.sessionId).goal?.objective !== goal.objective) return;
      this.adoptGoal(goal);
    } catch { /* goals are an opt-in feature of the CLI */ }
  }

  /**
   * A thread name can be a first-message fallback before the CLI writes its actual summary. Read
   * the durable first message before adopting or echoing an automatic title, including on resume.
   */
  adoptProviderTitle(name: string | undefined): void {
    if (name) {
      this.ctx.thread().name = name;
      const message = this.firstTitleMessage();
      const patch = message === undefined ? undefined : nativeTitlePatch(this.ctx.host.getSession(this.ctx.sessionId), name, message);
      if (patch) {
        // Only what the store now holds: a reset frame carrying the CLI's name while the store kept a
        // human one would contradict the title every list renders.
        this.ctx.emit({ type: 'session', session: this.ctx.host.updateSession(this.ctx.sessionId, patch) });
      }
    }
    void this.pushTitle().catch(() => undefined);
  }

  /**
   * Gives Codex the conversation's title when the reader or a model chose one the thread does not
   * carry, so the Codex app and `codex resume` list it under the same name. Codex echoes the change
   * as `thread/name/updated`, which then matches and stops here.
   */
  async pushTitle(): Promise<void> {
    const session = this.ctx.host.getSession(this.ctx.sessionId);
    if (session.titleSource !== 'user' && session.titleSource !== 'generated' && session.titleSource !== 'agent') return;
    if (session.titleSource !== 'user') {
      const message = this.firstTitleMessage();
      if (message === undefined || isPromptTitle(session.title, message)) return;
    }
    if (!this.ctx.threadId() || !this.ctx.connection.transport?.isOnline || session.title === this.ctx.thread().name) return;
    if (this.pushingTitle === session.title) return;
    this.pushingTitle = session.title;
    try {
      await this.ctx.connection.transport.request('thread/name/set', { threadId: this.ctx.threadId(), name: session.title });
      this.ctx.thread().name = session.title;
    } finally {
      if (this.pushingTitle === session.title) this.pushingTitle = undefined;
    }
  }

  private firstTitleMessage(): string | undefined {
    // Resident events and search indexes can contain only the tail. Production hosts resolve the
    // original input from the real journal or an unassigned new thread; an imported thread waits for it.
    if (this.ctx.host.firstUserMessage) return this.ctx.host.firstUserMessage(this.ctx.sessionId);
    const session = this.ctx.host.getSession(this.ctx.sessionId);
    return firstHumanMessage(this.ctx.log().events) ?? (session.titleSource === 'prompt' ? session.title : undefined);
  }

  /**
   * Name the conversation after the first human message of the thread, which is what a resumed
   * conversation has instead of a name. Idempotent once the title carries `titleSource: 'prompt'`.
   */
  nameFromMessage(text: string): void {
    if (this.ctx.log().importing) return;
    const firstMessage = this.ctx.host.firstUserMessage ? this.firstTitleMessage() : text;
    if (firstMessage === undefined) return;
    const patch = firstMessageTitlePatch(this.ctx.host.getSession(this.ctx.sessionId), firstMessage);
    if (!patch) return;
    this.ctx.emit({ type: 'session', session: this.ctx.host.updateSession(this.ctx.sessionId, patch) });
  }
}
