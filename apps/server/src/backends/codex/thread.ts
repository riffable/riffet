import { isAbsolute } from 'node:path';
import type { Project, Session } from '../../../../../packages/contracts/src/index.js';
import { nativeModelEffort, nativeModelFast, parseNativeModelSelection, type NativeModelSelection } from '../shared/model-selection.js';
import { modelSourceOf, resolveSource } from '../shared/model-source.js';
import { AppError } from '../../errors.js';
import { extensionsOffNames } from '../../extensions/toggles.js';
import type { NativeBackendHost, NativeBackendProfileConfig } from '../types.js';
import { fastServiceTier, modelBackendVariant, resolveModelSelection } from './catalog.js';
import { permissionOf, riffetMcpOverride } from './config.js';
import type { CodexConnection } from './connection.js';
import type { CodexTerminal } from './terminal.js';
import { isActiveWriterError } from './errors.js';
import { readConfiguredMcpNames } from './extensions.js';
import type { CodexFlavor } from './flavors.js';
import { newThreadRequest, type ThreadStart } from './launch.js';
import { findCodexRollout } from './rollout-usage.js';
import { codexStanding, standingThreadConfig, useStandingSkillRoots, type CodexStanding } from './standing.js';
import type { RpcThread } from './types.js';
import { str } from './util.js';

/** What `CodexThread` needs from the runtime that owns it. */
export interface CodexThreadContext {
  readonly host: NativeBackendHost;
  readonly project: Project;
  readonly profile: NativeBackendProfileConfig;
  readonly flavor: CodexFlavor;
  /** The session as this runtime last saw it. */
  session(): Session;
  terminal(): CodexTerminal;
  /** Whether the thread can be left or its profile switched: nothing is running or asked. */
  canSwitchProfile(): boolean;
  /** A turn is in the foreground or the status says one is running. */
  busy(): boolean;
  readThread(threadId: string): Promise<RpcThread | undefined>;
  /** Counters that tell whether a notification overtook an open's own settings (`runtime.ts#adoptApproval`). */
  permissionObservation(): number;
  modeObservation(): number;
  permissionParams(permission: ReturnType<typeof permissionOf>, sandboxField: 'sandbox' | 'sandboxPolicy', force?: boolean): Record<string, unknown>;
  adoptApproval(settings: Record<string, unknown> | undefined): void;
  adoptSettingsMode(settings: Record<string, unknown> | undefined): void;
  adoptProviderTitle(name: string | undefined): void;
  /** A first thread of the conversation exists: the journal and the history reader number from it. */
  startedThread(threadId: string): void;
  /** A different thread is a different window: the old context numbers are dropped. */
  resetUsage(): void;
  readGoal(threadId: string): void;
  applyThreadStatus(status: RpcThread['status']): void;
  /** Moves the link out of `offline` and `starting` once the thread is confirmed. */
  markQuiet(): void;
  refreshEvents(): Promise<unknown>;
  noteHistoryFailure(error: unknown): void;
}

/**
 * The conversation's thread on the app-server: creating or resuming it, the configuration it is given
 * at every start, and whether this runtime owns it while it is loaded.
 *
 * It owns the thread's id, the model and rollout path the thread last reported, its name, the
 * gate that serializes opens, and what the 助理 has been told or has written (`standing.ts`).
 *
 * It does not own the app-server connection or the thread's status: it asks the connection to commit
 * the binding and records failures there, and the history, title and goal are adopted through the context.
 */
export class CodexThread {
  private threadId: string | undefined;
  /** The model the thread last reported; Plan mode settings must name one. */
  private reportedModel: string | undefined;
  /** The rollout the provider itself reported for this thread (`thread.path`), when it did. */
  private rolloutPath: string | undefined;
  /** The name the thread itself last reported, or was last given. */
  private reportedName: string | undefined;
  private opening?: Promise<string | undefined>;
  private attachAttemptAt = 0;
  /** A sandbox other than the 助理's profile was named on the loaded thread (`standingProfile`). */
  private standingSandboxNamed = false;
  /** The files each of the 助理's open file changes writes, by item: an approval request names only the item. */
  private readonly standingWrites = new Map<string, string[]>();

  constructor(private readonly ctx: CodexThreadContext, private readonly connection: CodexConnection, threadId: string | undefined) {
    this.threadId = threadId;
  }

  private get label(): string { return this.ctx.flavor.label; }

  get id(): string | undefined { return this.threadId; }
  get model(): string | undefined { return this.reportedModel; }
  get name(): string | undefined { return this.reportedName; }
  set name(name: string | undefined) { this.reportedName = name; }

  /** Keeps the model a settings notification or a response reported. */
  noteModel(model: string | undefined): void {
    if (model) this.reportedModel = model;
  }

  /** Keeps what a thread record says about itself: where its rollout is, which model it runs. */
  noteThread(thread: RpcThread | undefined, settings?: Record<string, unknown>): void {
    if (!thread) return;
    if (str(thread.path) && isAbsolute(thread.path!)) this.rolloutPath = thread.path!;
    // start/resume report the effective model at the response's top level, not inside Thread.
    const model = str(settings?.model) ?? str(thread.model);
    if (model) this.reportedModel = model;
  }

  async rolloutFile(threadId: string): Promise<string | undefined> {
    return this.rolloutPath ?? await findCodexRollout(this.ctx.flavor.stateHome(this.ctx.profile.config), threadId);
  }

  /**
   * Lets go of the thread for a new topic (docs/ASSISTANT.md §5.5): what it wrote is read into the journal, the TUI
   * that shows it stops and the app-server unloads it. The app-server stays, for the thread that follows. Only an idle
   * thread is left; the caller holds the session lock and replaces this runtime afterwards.
   */
  async leaveThread(): Promise<string> {
    const busy = () => new AppError('CLI_BUSY', 'The current task is still running; start a new topic when it finishes.', 409);
    const threadId = this.threadId;
    if (!threadId || !this.connection.attached) throw new AppError('NATIVE_SESSION_NOT_STARTED', 'This conversation has not started yet', 409);
    if (!this.ctx.canSwitchProfile()) throw busy();
    this.connection.assertWritable();
    const transport = this.connection.requireTransport();
    await this.ctx.host.transcript?.drain(this.ctx.session().id);
    if (!this.ctx.canSwitchProfile()) throw busy();
    const terminal = this.ctx.terminal();
    if (terminal.id) {
      const terminalId = terminal.id;
      terminal.bind(undefined);
      this.ctx.host.updateSession(this.ctx.session().id, { terminalId: undefined });
      await this.ctx.host.terminal.stop(terminalId).catch(() => undefined);
    }
    await transport.request('thread/unsubscribe', { threadId }).catch(() => undefined);
    return threadId;
  }

  /**
   * `override` carries a configuration change that has not reached the session yet: the runtime
   * only ever holds the snapshot it was constructed with, while `configure` merges its patch with
   * the store's current intent. Without it, opening first on the snapshot would create or resume the
   * thread on the previous model/approval and only correct it with a follow-up request — wrong on
   * the wire, and a real defect for any reader that adopts what the first response reported.
   */
  async openOrResume(override?: { model?: string; approval?: string }): Promise<string> {
    const { host, flavor, project } = this.ctx;
    const profileConfig = this.ctx.profile.config;
    const source = modelSourceOf(profileConfig);
    const reason = source && resolveSource(source, profileConfig).reason;
    if (reason && !this.connection.transportBorrowed) throw new AppError('NATIVE_MODEL_SOURCE_UNAVAILABLE', reason, 409);
    this.connection.assertWritable();
    while (this.opening) {
      const opened = await this.opening;
      if (opened) return opened;
    }
    this.connection.assertWritable();
    if (this.threadId && this.connection.transport?.isOnline && this.connection.attached) return this.threadId;
    const task = (async () => {
      const transport = this.connection.requireTransport();
      const existingId = this.threadId;
      const current = host.getSession(this.ctx.session().id);
      const requestedModel = override?.model ?? current.model ?? str(profileConfig.defaultModel);
      // A saved selector may predate a provider rename; resolve it against the live catalog before
      // the thread is created or resumed, so the provider never sees the retired spelling.
      const selection = await resolveModelSelection(transport, flavor, parseNativeModelSelection(requestedModel));
      const permission = permissionOf(override?.approval ?? current.approval, flavor.id);
      let thread: RpcThread;
      let settings: Record<string, unknown> | undefined;
      let permissionObservation = this.ctx.permissionObservation();
      const modeObservation = this.ctx.modeObservation();
      if (existingId) {
        const observed = await this.ctx.readThread(existingId).catch(() => undefined);
        const active = this.ctx.busy() || observed?.status?.type === 'active';
        try {
          permissionObservation = this.ctx.permissionObservation();
          const response = active
            ? await transport.request<{ thread: RpcThread } & Record<string, unknown>>('thread/resume', {
              threadId: existingId, cwd: project.cwd, excludeTurns: true,
            })
            : await this.resumeWithConfiguration(existingId, selection,
              flavor.id === 'traex' && override?.approval === undefined && !current.configPending ? undefined : permission);
          thread = response.thread;
          settings = response;
        } catch (error) {
          this.connection.noteConnectionFailure(error);
          this.connection.logRecovery(this.connection.endpointSource, transport.remoteAddress, 'resume', isActiveWriterError(error) ? 'conflict' : 'failed', false);
          await this.connection.discardFailedTransport();
          throw error;
        }
      } else {
        // A warm thread started for the same model and permission is this conversation's first thread.
        const warm = this.connection.takeWarm();
        try {
          const response = warm && warm.model === requestedModel && warm.approval === permission.id ? warm.thread : await this.startThread(selection, permission);
          thread = response.thread;
          settings = response;
        } catch (error) {
          this.connection.noteConnectionFailure(error);
          this.connection.logRecovery(this.connection.endpointSource, transport.remoteAddress, 'start', isActiveWriterError(error) ? 'conflict' : 'failed', false);
          await this.connection.discardFailedTransport();
          throw error;
        }
      }
      if (!thread?.id) {
        const error = new Error(`${this.label} app-server did not return a thread id`);
        this.connection.noteConnectionFailure(error);
        this.connection.logRecovery(this.connection.endpointSource, transport.remoteAddress, existingId ? 'resume' : 'start', 'missing-thread-id', false);
        await this.connection.discardFailedTransport();
        throw error;
      }
      if (existingId && thread.id !== existingId) {
        const error = new Error(`${this.label} app-server resumed a different thread`);
        this.connection.noteConnectionFailure(error);
        this.connection.logRecovery(this.connection.endpointSource, transport.remoteAddress, 'resume', 'wrong-thread', false);
        await this.connection.discardFailedTransport();
        throw error;
      }
      this.connection.markAttached();
      this.threadId = thread.id;
      // A newly created thread has no older transcript to seed before accepting live events.
      if (!existingId) {
        this.ctx.startedThread(thread.id);
      }
      this.noteThread(thread, this.ctx.modeObservation() === modeObservation ? settings : undefined);
      if (this.ctx.permissionObservation() === permissionObservation) this.ctx.adoptApproval(settings);
      if (this.ctx.modeObservation() === modeObservation) this.ctx.adoptSettingsMode(settings);
      this.ctx.resetUsage();
      this.ctx.adoptProviderTitle(typeof thread.name === 'string' ? thread.name : undefined);
      host.setNativeSessionId(this.ctx.session().id, thread.id);
      this.ctx.readGoal(thread.id);
      this.ctx.applyThreadStatus(thread.status);
      this.ctx.markQuiet();
      // Commit the durable endpoint only after Codex confirms the requested thread id. History is
      // a separate read path: a transcript error must not undo an established writer binding.
      await this.connection.commitBinding(transport, thread.id);
      this.connection.setConnection({ state: 'connected' });
      this.connection.logRecovery(this.connection.endpointSource, transport.remoteAddress, existingId ? 'resume' : 'start', 'confirmed', true);
      await this.ctx.refreshEvents().catch(error => this.ctx.noteHistoryFailure(error));
      return thread.id;
    })();
    this.opening = task;
    try { return await task; }
    finally { if (this.opening === task) this.opening = undefined; }
  }

  private async resumeWithConfiguration(threadId: string, selection: NativeModelSelection, permission: ReturnType<typeof permissionOf> | undefined): Promise<{ thread: RpcThread } & Record<string, unknown>> {
    const { flavor } = this.ctx;
    const standing = await this.standingThread();
    const effort = nativeModelEffort(selection);
    const serviceTier = fastServiceTier(flavor, selection.model, nativeModelFast(selection));
    const backendVariant = modelBackendVariant(flavor, selection);
    const config = {
      ...(effort && effort !== 'default' ? { model_reasoning_effort: effort } : {}),
      ...(backendVariant ? { model_backend_variant: backendVariant } : {}),
      ...this.riffetMcpConfig(),
      ...await this.extensionsOffConfig(),
      ...standing?.config,
    };
    return await this.connection.requireTransport().request<{ thread: RpcThread } & Record<string, unknown>>('thread/resume', {
      ...standing?.instructions,
      threadId,
      cwd: this.ctx.project.cwd,
      model: selection.model || null,
      ...(permission ? this.ctx.permissionParams(permission, 'sandbox', true) : {}),
      ...(serviceTier ? { serviceTier } : {}),
      ...(Object.keys(config).length ? { config } : {}),
      excludeTurns: true,
    });
  }

  /**
   * The 助理's isolation (`standing.ts`), given again at every start and resume: a resumed thread keeps nothing of the
   * last one's overrides, and the directory's files may have changed since. Undefined for any other conversation.
   */
  private async standingThread(): Promise<{ instructions: { baseInstructions: string; developerInstructions: string }; config: Record<string, unknown> } | undefined> {
    const standing = this.standing();
    if (!standing) return undefined;
    const transport = this.connection.requireTransport();
    await useStandingSkillRoots(transport, standing);
    const riffet = Object.keys(this.riffetMcpConfig()).map(key => key.slice('mcp_servers.'.length));
    return {
      instructions: { baseInstructions: standing.baseInstructions, developerInstructions: standing.developerInstructions },
      config: await standingThreadConfig(transport, this.ctx.project.cwd, standing, riffet),
    };
  }

  isStanding(): boolean {
    const { host, flavor, project } = this.ctx;
    return flavor.id === 'codex' && Boolean(host.standing?.launch(project, host.getSession(this.ctx.session().id)));
  }

  /** The 助理's isolation when this is one of its conversations (`standing.ts`); TRAE's app-server is not isolated. */
  standing(): CodexStanding | undefined {
    const { host, flavor, project } = this.ctx;
    return flavor.id === 'codex' ? codexStanding(host.standing?.launch(project, host.getSession(this.ctx.session().id))) : undefined;
  }

  /**
   * Whether the 助理's permission profile is the sandbox in force: in the workspace-write preset, until a sandbox of
   * another mode was named on the loaded thread, which stays in force over the profile until the thread is loaded
   * again. Then the preset is named instead, without the profile's read-only files (docs/ASSISTANT.md §4.1).
   */
  standingProfile(permission: ReturnType<typeof permissionOf>): boolean {
    if (!this.isStanding()) return false;
    if (permission.sandbox !== 'workspace-write') { this.standingSandboxNamed = true; return false; }
    return !this.standingSandboxNamed;
  }

  /** A file change of the 助理's started (`paths`) or finished (undefined). */
  noteStandingWrites(itemId: string, paths: string[] | undefined): void {
    if (paths) this.standingWrites.set(itemId, paths);
    else this.standingWrites.delete(itemId);
  }

  standingWritesOf(itemId: string): string[] | undefined { return this.standingWrites.get(itemId); }

  clearStandingWrites(): void { this.standingWrites.clear(); }

  /**
   * The conversation's Riffet MCP server as a per-thread override (docs/DEVICES.md §2). The dotted
   * key adds one server beside the reader's own; the CLI's config files are never written. The
   * app-server starts MCP servers itself, outside the command sandbox, so no network opening is needed.
   */
  private riffetMcpConfig(): Record<string, unknown> {
    const server = this.ctx.host.riffetMcp?.server(this.ctx.session().id);
    return riffetMcpOverride(server);
  }

  /**
   * The MCP servers this conversation switched off (docs/EXTENSIONS.md), as per-thread overrides. Skills the owner
   * switched off stay in the CLI's own configuration; only the 助理's thread switches skills off itself (`standing.ts`).
   */
  private async extensionsOffConfig(): Promise<Record<string, unknown>> {
    // A dotted key cannot carry a dot inside a server name; the CLI's own names never have one.
    const names = extensionsOffNames(this.ctx.host.getSession(this.ctx.session().id).extensionsOff, 'mcp').filter(name => /^[\w-]+$/.test(name));
    if (!names.length) return {};
    // The app-server refuses a thread whose config names an MCP server the configuration does not define (a stale or
    // handed-over name, or a plugin's server), so only defined names reach it. If the config cannot be read, nothing
    // is switched off rather than risking the launch.
    let known: Set<string>;
    try { known = await readConfiguredMcpNames(this.connection.requireTransport(), this.ctx.project.cwd); }
    catch { return {}; }
    return Object.fromEntries(names.filter(name => known.has(name)).map(name => [`mcp_servers.${name}.enabled`, false]));
  }

  private async startThread(selection: NativeModelSelection, permission: ReturnType<typeof permissionOf>): Promise<{ thread: RpcThread } & Record<string, unknown>> {
    const standing = await this.standingThread();
    const config = { ...this.riffetMcpConfig(), ...await this.extensionsOffConfig(), ...standing?.config };
    return await this.connection.requireTransport().request<ThreadStart>('thread/start',
      newThreadRequest(this.ctx.flavor, this.ctx.project.cwd, selection, this.ctx.permissionParams(permission, 'sandbox', true), config, standing?.instructions));
  }

  /** Attach only when the selected endpoint already proves it owns this loaded thread. */
  async attachLoadedOwner(): Promise<void> {
    const threadId = this.threadId;
    if (!threadId || this.connection.attached || !this.connection.transport?.isOnline) return;
    if (this.connection.bindingScopeMismatch) {
      this.connection.deferForProfileChange();
      return;
    }
    if (this.connection.endpointBlocked) {
      this.connection.deferForEndpointConflict();
      return;
    }
    if (this.opening) {
      // An explicit open owns the same resume gate. Its error is already reported to its caller;
      // the observer must not issue a competing resume after that operation settles.
      await this.opening.catch(() => undefined);
      return;
    }
    const task = (async (): Promise<string | undefined> => {
      const loaded = await this.connection.loadedThread(threadId, true);
      if (loaded !== true || this.connection.attached || !this.connection.transport?.isOnline) return undefined;
      if (this.connection.bindingScopeMismatch) {
        this.connection.deferForProfileChange();
        return undefined;
      }
      if (this.connection.endpointBlocked) {
        this.connection.deferForEndpointConflict();
        return undefined;
      }
      if (Date.now() - this.attachAttemptAt < 15_000) return undefined;
      this.attachAttemptAt = Date.now();
      try {
        const transport = this.connection.requireTransport();
        const permissionObservation = this.ctx.permissionObservation();
        const modeObservation = this.ctx.modeObservation();
        const response = await transport.request<{ thread: RpcThread } & Record<string, unknown>>('thread/resume', {
          threadId, cwd: this.ctx.project.cwd, excludeTurns: true,
        });
        if (!response.thread?.id || response.thread.id !== threadId) throw new Error(`${this.label} app-server resumed a different thread`);
        this.noteThread(response.thread, this.ctx.modeObservation() === modeObservation ? response : undefined);
        if (this.ctx.permissionObservation() === permissionObservation) this.ctx.adoptApproval(response);
        if (this.ctx.modeObservation() === modeObservation) this.ctx.adoptSettingsMode(response);
        this.connection.markAttached();
        this.ctx.applyThreadStatus(response.thread.status);
        this.ctx.markQuiet();
        await this.connection.commitBinding(transport, threadId);
        this.connection.setConnection({ state: 'connected' });
        this.connection.logRecovery(this.connection.endpointSource, transport.remoteAddress, 'observer-resume', 'confirmed', true);
        return threadId;
      } catch (error) {
        this.connection.noteConnectionFailure(error);
        this.connection.logRecovery(this.connection.endpointSource, this.connection.transport?.remoteAddress ?? 'unknown', 'observer-resume', isActiveWriterError(error) ? 'conflict' : 'failed', false);
        return undefined;
      }
    })();
    this.opening = task;
    try { await task; }
    catch { /* Only an explicit open can reject the shared opening gate. */ }
    finally { if (this.opening === task) this.opening = undefined; }
  }
}
