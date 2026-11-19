import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeStatus, Project, Session } from '../../../../../packages/contracts/src/index.js';
import type { RuntimeAttachment, RuntimeContext } from '@riffet/plugin-api';
import type { CodexAppServerClient, CodexAppServerFactory, CodexAppServerOptions } from '../shared/codex-app-server.js';
import { listWorkbenchAppServers, stopWorkbenchAppServerAt } from '../shared/app-server-daemons.js';
import { AppError } from '../../errors.js';
import type { PluginRegistry } from '../../plugins/registry.js';
import type { NativeBackendHost, NativeBackendProfileConfig } from '../types.js';
import type { CodexFlavor } from './flavors.js';
import { NotificationGate, type CodexObservation } from './observation.js';
import { conversationServerOptions, spawnConversationServer, type CodexWarm } from './launch.js';
import { credentialDirFor, matchesRuntimeFingerprint, runtimeFingerprintFor, runtimeScopeFingerprintFor } from './config.js';
import { isActiveWriterError, isUnavailableSocket, safeProviderError } from './errors.js';
import type { CodexTerminal } from './terminal.js';
import type { RpcThread } from './types.js';
import type { JsonRpcServerRequest } from '../shared/codex-app-server.js';

/** The plugins' runtime hooks, as `PluginRegistry` serves them. */
export type NativeRuntimeHooks = Pick<PluginRegistry, 'runtimeHooks'>;

/** What `CodexConnection` needs from the runtime that owns it. */
export interface CodexConnectionContext {
  readonly host: NativeBackendHost;
  readonly project: Project;
  readonly profile: NativeBackendProfileConfig;
  readonly flavor: CodexFlavor;
  readonly startAppServer: CodexAppServerFactory;
  readonly runtimeHooks?: NativeRuntimeHooks;
  /** Reports what shell commands change in the working tree (`observation.ts`). */
  readonly observation?: CodexObservation;
  /** The session as this runtime last saw it; its saved binding says which app-server to look for. */
  session(): Session;
  threadId(): string | undefined;
  status(): NativeStatus;
  /** The terminal of the same session: its endpoint check gates every write on this connection. */
  terminal(): CodexTerminal;
  /** The only way a status changes; the connection names the facts it owns. */
  refreshStatus(change?: { link?: 'starting' | 'offline' | 'quiet' | 'working'; connection?: NativeStatus['connection'] }): void;
  /** The link a status shows once live traffic is evidence: `working` stays, otherwise `quiet`. */
  resumed(): 'quiet' | 'working';
  /** Whether nothing is in flight that a provider change would cut off. */
  canSwitchProfile(): boolean;
  readThread(threadId: string): Promise<RpcThread | undefined>;
  interrupt(): Promise<void>;
  /** Tears down the whole runtime, as a replacement or a restart requires. */
  dispose(): Promise<void>;
  beginMaterialization(): void;
  /** What the runtime shows when its terminal's endpoint is reachable by no candidate. */
  terminalEndpointUnreachable(): void;
  onNotification(method: string, params: Record<string, unknown>): void;
  onServerRequest(request: JsonRpcServerRequest): Promise<unknown>;
  onExit(error: Error): void;
}

/**
 * The link between one session and the app-server that serves it: the transport, which saved or
 * verified endpoint it was reached through, whether this runtime spawned it or borrowed it, the
 * profile identity that process was launched with, and the write gate that identity and the
 * terminal's endpoint decide.
 *
 * It owns the transport, the endpoint and binding conflicts, the profile fingerprints, the plugin
 * sidecar attached to the process and the warm thread a pre-started process brings. It starts,
 * restarts and releases the process, and commits the durable binding once a thread is confirmed.
 *
 * It does not open or resume threads, route notifications, check the terminal's endpoint or decide
 * the session's status: those stay in the runtime, the terminal and `refreshStatus`, which it calls
 * through its context.
 */
export class CodexConnection {
  private client?: CodexAppServerClient;
  private owner = false;
  private borrowed = false;
  private source: 'terminal' | 'binding' | 'spawn' = 'spawn';
  /** The saved endpoint this runtime found gone before spawning its own; it stays saved until a resume confirms the replacement. */
  private unreachable: string | undefined;
  private writeConflict = false;
  private scopeMismatch = false;
  private conflictSource?: 'profile' | 'endpoint';
  private fingerprint: string;
  private pending = false;
  private readonly scopeFingerprint: string;
  /** A plugin's sidecar on the native process, such as a routing proxy, with the plugin's id. */
  private sidecar?: { owner: string; value: RuntimeAttachment };
  /** The thread a warm app-server was started with, until this conversation opens its first thread. */
  private warmThread?: CodexWarm;
  private loadedCheck: boolean | undefined;
  private loadedCheckAt = 0;
  private loadedCheckThreadId: string | undefined;

  constructor(private readonly ctx: CodexConnectionContext) {
    this.fingerprint = runtimeFingerprintFor(ctx.project, ctx.profile, ctx.flavor);
    this.scopeFingerprint = runtimeScopeFingerprintFor(ctx.project, ctx.profile, ctx.flavor);
  }

  private get label(): string { return this.ctx.flavor.label; }
  private get profileConfig(): Record<string, unknown> { return this.ctx.profile.config; }
  private get sessionId(): string { return this.ctx.session().id; }

  get transport(): CodexAppServerClient | undefined { return this.client; }
  /** The thread's owner was confirmed over this connection. */
  get attached(): boolean { return this.owner; }
  /** This runtime joined an app-server something else started. */
  get transportBorrowed(): boolean { return this.borrowed; }
  get endpointSource(): 'terminal' | 'binding' | 'spawn' { return this.source; }
  get profilePending(): boolean { return this.pending; }
  get bindingScopeMismatch(): boolean { return this.scopeMismatch; }
  /** Writes wait for the terminal's endpoint to be verified again. */
  get endpointBlocked(): boolean { return this.writeConflict; }
  /** The fingerprint of the process, not of the latest profile. */
  get runtimeFingerprint(): string { return this.fingerprint; }
  get attachment(): { owner: string; value: RuntimeAttachment } | undefined { return this.sidecar; }

  markAttached(): void { this.owner = true; }

  /** The thread a warm app-server was started with, once; a later call has none. */
  takeWarm(): CodexWarm | undefined {
    const warm = this.warmThread;
    this.warmThread = undefined;
    return warm;
  }

  /** Whether a fresh answer to `thread/loaded/list` is at hand that says this thread is loaded here. */
  loadedOwnerFresh(threadId: string): boolean {
    return this.loadedCheck === true && this.loadedCheckThreadId === threadId && Date.now() - this.loadedCheckAt < 5_000;
  }

  matches(project: Project, profile: NativeBackendProfileConfig): boolean {
    return !this.pending && runtimeFingerprintFor(project, profile, this.ctx.flavor) === this.fingerprint;
  }

  belongsTo(project: Project, profile: NativeBackendProfileConfig): boolean {
    return runtimeScopeFingerprintFor(project, profile, this.ctx.flavor) === this.scopeFingerprint && !this.scopeMismatch;
  }

  canRunWith(project: Project, profile: NativeBackendProfileConfig): boolean {
    return this.belongsTo(project, profile) && !this.writeConflict;
  }

  syncSessionBinding(session: Session, project: Project, profile: NativeBackendProfileConfig): void {
    this.ctx.terminal().adoptTerminal(session.terminalId);
    // The fingerprint belongs to the process, not the latest profile. A restored profile clears
    // the pending state without rewriting that process's identity or replacing its connection.
    this.pending = !matchesRuntimeFingerprint(this.fingerprint, project, profile, this.ctx.flavor);
    if (!this.pending && !session.nativeRuntime?.scopeFingerprint) this.scopeMismatch = false;
    if (this.belongsTo(project, profile) && !this.writeConflict
      && this.conflictSource === 'profile' && this.ctx.status().connection?.state === 'conflict') {
      this.setConnection({ state: this.owner ? 'connected' : 'disconnected' });
      return;
    }
    this.ctx.refreshStatus();
  }

  /** The session's saved endpoint names another app-server than this one, and not the one it already found gone. */
  bindingMoved(address: string | undefined): boolean {
    return Boolean(address && address !== this.client?.remoteAddress && address !== this.unreachable);
  }

  deferForProfileChange(): void {
    const message = `The ${this.label} profile changed. Restore the previous profile or explicitly end its ${this.label} backend, then retry.`;
    this.setConnection({ state: 'conflict', message }, 'profile');
  }

  deferWriteBlocked(project: Project, profile: NativeBackendProfileConfig): { code: string; message: string } {
    if (!this.belongsTo(project, profile)) {
      this.deferForProfileChange();
      return {
        code: 'NATIVE_PROFILE_CHANGED',
        message: `The ${this.label} profile changed. Restore the previous profile or explicitly end its ${this.label} backend, then retry.`,
      };
    }
    this.deferForEndpointConflict();
    return {
      code: 'NATIVE_ENDPOINT_CONFLICT',
      message: this.endpointConflictMessage(),
    };
  }

  assertWritable(): void {
    if (this.scopeMismatch) throw new AppError('NATIVE_PROFILE_CHANGED', `The previous ${this.label} profile must be restored or its backend explicitly ended before this thread can be resumed.`, 409);
    if (this.writeConflict) throw new AppError('NATIVE_ENDPOINT_CONFLICT', this.endpointConflictMessage(), 409);
  }

  endpointConflictMessage(): string {
    return this.ctx.terminal().endpointStateValue === 'changed'
      ? `This ${this.label} terminal is connected to a different backend.`
      : `This ${this.label} terminal's backend connection could not be verified.`;
  }

  /**
   * Writes stay blocked either way, but only a terminal proven to use another app-server is a
   * conflict. One that could not be verified yet is retried and reads as reconnecting.
   */
  endpointConnection(): NonNullable<NativeStatus['connection']> {
    return { state: this.ctx.terminal().endpointStateValue === 'changed' ? 'conflict' : 'reconnecting', message: this.endpointConflictMessage() };
  }

  deferForEndpointConflict(): void {
    const message = this.endpointConflictMessage();
    if (!this.writeConflict || this.ctx.status().connection?.message !== message) {
      this.logRecovery('terminal', this.client?.remoteAddress ?? 'unknown', 'verify', this.ctx.terminal().endpointStateValue === 'changed' ? 'changed' : 'unverified', false);
    }
    this.writeConflict = true;
    this.setConnection(this.endpointConnection(), 'endpoint');
  }

  /** The terminal's endpoint was verified or found absent: the write gate it held opens. Returns whether it was shut. */
  clearEndpointBlock(): boolean {
    const wasBlocked = this.writeConflict;
    this.writeConflict = false;
    return wasBlocked;
  }

  /** The status a verified or absent terminal leaves, once the terminal has recorded its state. */
  settleAfterEndpoint(wasBlocked: boolean): void {
    if (this.scopeMismatch || (this.ctx.status().connection?.state === 'conflict' && this.conflictSource !== 'endpoint')) return;
    this.conflictSource = undefined;
    if (this.owner) {
      this.ctx.refreshStatus({ link: this.ctx.resumed(), connection: { state: 'connected' } });
    } else if (this.ctx.status().connection?.state === 'conflict' || wasBlocked) {
      this.ctx.refreshStatus({ link: 'offline', connection: { state: 'disconnected' } });
    }
  }

  /** Release only an idle, verified owner; a provider change never interrupts its current work. */
  async releaseForProfileSwitch(): Promise<boolean> {
    if (!this.ctx.canSwitchProfile()) return false;
    await this.ctx.terminal().endpointState(true);
    this.assertWritable();
    const transport = this.requireTransport();
    const threadId = this.ctx.threadId();
    const binding = this.ctx.host.getSession(this.sessionId).nativeRuntime;
    const loaded = threadId ? await this.loadedThread(threadId, true) : undefined;
    if (loaded === false && !this.borrowed) {
      // A saved owner was already gone and this reader spawned an unloaded replacement.
      await this.ctx.dispose();
      return true;
    }
    if (!threadId || binding?.address !== transport.remoteAddress || loaded !== true) {
      throw new AppError('NATIVE_LAUNCH_ABORTED', 'The existing backend could not be verified; it was left running.', 409);
    }
    const idle = async () => {
      const thread = await this.ctx.readThread(threadId);
      return thread?.id === threadId && thread.status?.type !== 'active' && this.ctx.canSwitchProfile();
    };
    if (!await idle()) return false;
    await this.ctx.host.transcript?.drain(this.sessionId);
    if (!await idle()) return false;
    this.assertWritable();
    const current = this.ctx.host.getSession(this.sessionId);
    if (current.nativeSessionId !== threadId || current.nativeRuntime?.address !== binding.address
      || current.nativeRuntime.fingerprint !== binding.fingerprint || this.client !== transport) {
      throw new AppError('NATIVE_LAUNCH_ABORTED', 'The backend binding changed during restart; no backend was stopped.', 409);
    }
    // Reattached Unix clients have no process handle. Stop only the verified Riffet-owned daemon.
    if (this.borrowed && !transport.processId
      && !await stopWorkbenchAppServerAt(binding.address, [credentialDirFor(this.ctx.flavor)])) {
      throw new AppError('NATIVE_LAUNCH_ABORTED', 'The existing backend process could not be verified; it was left running.', 409);
    }
    await this.ctx.dispose();
    return true;
  }

  /** Explicit user action, never called by a reader or by ordinary reconnect/send. */
  async restartBackend(expected: string, address: string): Promise<boolean> {
    const binding = this.ctx.host.getSession(this.sessionId).nativeRuntime;
    if (!binding || binding.fingerprint !== expected || binding.address !== address || !this.pending) return false;
    await this.ctx.terminal().endpointState(true);
    this.assertWritable();
    const transport = this.requireTransport();
    const assertTarget = () => {
      const current = this.ctx.host.getSession(this.sessionId);
      if (current.nativeRuntime?.fingerprint !== expected || current.nativeRuntime.address !== address
        || current.nativeSessionId !== this.ctx.threadId() || this.client !== transport || !transport.isOnline || !this.pending) {
        throw new AppError('NATIVE_LAUNCH_ABORTED', 'The backend binding changed during restart; no backend was stopped.', 409);
      }
      this.assertWritable();
    };
    const threadId = this.ctx.threadId();
    if (binding.address !== transport.remoteAddress || !threadId
      || await this.loadedThread(threadId, true) !== true) {
      throw new AppError('NATIVE_LAUNCH_ABORTED', 'The existing backend could not be verified; it was left running.', 409);
    }
    const stopBorrowed = this.borrowed && !transport.processId;
    if (stopBorrowed && !(await listWorkbenchAppServers([credentialDirFor(this.ctx.flavor)])).some(server => server.address === binding.address)) {
      throw new AppError('NATIVE_LAUNCH_ABORTED', 'The existing backend process could not be verified; it was left running.', 409);
    }
    assertTarget();
    await this.ctx.interrupt();
    await this.ctx.host.transcript?.drain(this.sessionId);
    assertTarget();
    // A borrowed Unix connection has no process handle. Only a verified Riffet process group
    // may be stopped; closing the socket alone must never be mistaken for stopping its owner.
    if (stopBorrowed
      && !await stopWorkbenchAppServerAt(binding.address, [credentialDirFor(this.ctx.flavor)])) {
      throw new AppError('NATIVE_LAUNCH_ABORTED', 'The existing backend process could not be verified; it was left running.', 409);
    }
    await this.ctx.dispose();
    // The durable binding stays until a replacement resumes the same native thread. start()
    // still probes it, so a surviving listener cannot produce a second writer.
    return true;
  }

  /**
   * `warm` hands over an app-server with a new thread started ahead of this conversation (`launch.ts`);
   * it is asked only by a conversation that has no thread and no process of its own yet.
   */
  async start(optionsOnly: { reconnectOnly?: boolean; warm?: () => Promise<CodexWarm | undefined> } = {}): Promise<void> {
    let live = false;
    const { ctx } = this;
    const binding = ctx.session().nativeRuntime;
    const launchChanged = Boolean(binding?.fingerprint && !matchesRuntimeFingerprint(binding.fingerprint, ctx.project, ctx.profile, ctx.flavor));
    this.scopeMismatch = Boolean(binding?.scopeFingerprint && binding.scopeFingerprint !== this.scopeFingerprint);
    const gate = new NotificationGate();
    const handlers: Pick<CodexAppServerOptions, 'onNotification' | 'onServerRequest' | 'onExit'> = {
      // A command's completion waits for its PostToolUse record, and everything after it waits behind it.
      onNotification: (method, params) => gate.push(ctx.observation?.hold(method, params), () => { if (live) ctx.onNotification(method, params); }),
      onServerRequest: request => (live ? ctx.onServerRequest(request) : undefined) ?? Promise.reject(new Error(`${this.label} runtime is not ready`)),
      // An exit is taken after a completion held before it, or the completion would land on a runtime that has let go.
      onExit: error => gate.push(undefined, () => { if (live) ctx.onExit(error); }),
    };
    const options = await conversationServerOptions(ctx.project, ctx.profile, ctx.flavor, ctx.observation, handlers);
    live = true;
    const threadId = ctx.threadId();
    const terminal = ctx.terminal();
    const terminalAddress = threadId && terminal.id
      ? await terminal.endpoint(terminal.id, threadId).catch(() => undefined)
      : undefined;
    const candidates: Array<{ address: string; source: 'terminal' | 'binding' }> = [];
    if (terminalAddress) candidates.push({ address: terminalAddress, source: 'terminal' });
    if (binding?.address && !candidates.some(candidate => candidate.address === binding.address)) {
      candidates.push({ address: binding.address, source: 'binding' });
    }

    let lastAttachError: unknown;
    for (const candidate of candidates) {
      try {
        this.client = await ctx.startAppServer({ ...options, remoteAddress: candidate.address });
        this.borrowed = true;
        this.source = candidate.source;
        if (binding?.address === candidate.address && launchChanged) {
          this.fingerprint = binding.fingerprint;
          this.pending = true;
          // Old rows have only a launch hash. A verified terminal proves their cwd/thread; a
          // headless owner must prove both through the protocol before relaxing the old gate.
          if (!binding.scopeFingerprint && !terminalAddress) {
            const thread = threadId ? await ctx.readThread(threadId).catch(() => undefined) : undefined;
            const [storedCwd, projectCwd] = await Promise.all([
              thread?.cwd ? realpath(thread.cwd).catch(() => undefined) : undefined,
              realpath(ctx.project.cwd).catch(() => undefined),
            ]);
            this.scopeMismatch = !threadId || await this.loadedThread(threadId, true) !== true
              || thread?.id !== threadId || !storedCwd || storedCwd !== projectCwd;
          }
        } else if (launchChanged) {
          this.scopeMismatch = true;
        }
        this.logRecovery(candidate.source, candidate.address, 'connect', 'connected', false);
        break;
      } catch (error) {
        lastAttachError = error;
        this.logRecovery(candidate.source, candidate.address, 'connect', isUnavailableSocket(error) ? 'unreachable' : 'failed', false);
        // A terminal's verified endpoint can still be the active owner even when this socket
        // failed. Try only another durable endpoint; never create a second writer in that case.
        if (!isUnavailableSocket(error)) throw error;
      }
    }

    if (!this.client) {
      if (optionsOnly.reconnectOnly) throw new AppError('STEER_TARGET_CHANGED', `The existing ${this.label} endpoint is unavailable; the instruction was not sent.`, 409);
      if (terminalAddress) {
        const error = lastAttachError ?? new Error(`The verified ${this.label} terminal endpoint is unavailable`);
        ctx.terminalEndpointUnreachable();
        throw error;
      }
      // Only a definitively gone endpoint permits a replacement. Its binding is retained until
      // the replacement confirms the original thread id.
      this.scopeMismatch = false;
      this.pending = false;
      this.fingerprint = runtimeFingerprintFor(ctx.project, ctx.profile, ctx.flavor);
      if (binding?.address && lastAttachError && !isUnavailableSocket(lastAttachError)) throw lastAttachError;
      if (binding?.address && lastAttachError) {
        this.logRecovery('binding', binding.address, 'connect', 'unreachable', false);
        this.unreachable = binding.address;
      }
      const warm = !binding && !threadId && !terminal.id ? await optionsOnly.warm?.() : undefined;
      let spawnedTransport: CodexAppServerClient | undefined;
      try {
        if (warm) {
          warm.attach(handlers);
          spawnedTransport = warm.transport;
          terminal.noteUnavailable(warm.terminalUnavailable);
          this.warmThread = warm;
        } else {
          await this.prepareAttachment();
          if (this.sidecar) options.env = { ...options.env, ...this.sidecar.value.launchEnv };
          const spawned = await spawnConversationServer(ctx.startAppServer, ctx.flavor, options);
          spawnedTransport = spawned.transport;
          terminal.noteUnavailable(spawned.terminalUnavailable);
        }
        this.client = spawnedTransport;
        await this.sidecar?.value.bindNative({ address: spawnedTransport.remoteAddress, pid: spawnedTransport.processId });
      } catch (error) {
        await spawnedTransport?.dispose();
        this.client = undefined;
        await this.releaseAttachment(false);
        throw error;
      }
      this.borrowed = false;
      this.source = 'spawn';
      this.logRecovery('spawn', this.client.remoteAddress, 'connect', 'connected', false);
    }
    // A sidecar a previous server left on this very process comes back only through the plugin that made it.
    const saved = this.borrowed && binding?.address === this.client.remoteAddress ? binding?.attachment : undefined;
    const owned = saved && ctx.runtimeHooks?.runtimeHooks(ctx.flavor.id).find(item => item.owner === saved.hook);
    if (binding && saved && owned) {
      const value = await owned.hook.recover({ ...this.runtimeContext(binding.fingerprint), id: saved.id, address: this.client.remoteAddress }).catch(() => undefined);
      if (value) this.sidecar = { owner: owned.owner, value };
    }
    // Riffet's observation hooks run only once confirmed; a conversation without a TUI is confirmed here.
    await ctx.observation?.trust(this.client, ctx.project.cwd).catch(() => undefined);
    await terminal.endpointState(true);
  }

  private runtimeContext(fingerprint: string): RuntimeContext {
    return {
      sessionId: this.sessionId, fingerprint, profileConfig: this.profileConfig,
      // `<backend>/routes` predates hooks; routes already running are found there.
      directory: join(credentialDirFor(this.ctx.flavor), '..', 'routes'),
      onChange: () => this.ctx.refreshStatus(),
    };
  }

  /** The first hook that attaches to the process about to spawn. One that fails leaves the process as launched. */
  private async prepareAttachment(): Promise<void> {
    for (const { owner, hook } of this.ctx.runtimeHooks?.runtimeHooks(this.ctx.flavor.id) ?? []) {
      try {
        const value = await hook.prepare(this.runtimeContext(this.fingerprint));
        if (value) { this.sidecar = { owner, value }; return; }
      } catch (error) {
        console.warn(`[riffet] plugin ${owner} did not attach to ${this.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** `keep` leaves the sidecar serving a native process that outlives this runtime. */
  private async releaseAttachment(keep: boolean): Promise<void> {
    const attachment = this.sidecar?.value;
    this.sidecar = undefined;
    try {
      if (keep) attachment?.detach();
      else await attachment?.stop();
    } catch { /* Plugin code is not ours: its failure cannot fail a teardown. */ }
  }

  /** Explicit opens and observer resumes must preserve the same durable native/attachment association. */
  async commitBinding(transport: CodexAppServerClient, threadId: string): Promise<void> {
    const current = this.ctx.host.getSession(this.sessionId);
    const previous = current.nativeRuntime;
    const attachment = this.sidecar ? { hook: this.sidecar.owner, id: this.sidecar.value.id }
      : this.borrowed && previous?.address === transport.remoteAddress ? previous?.attachment : undefined;
    // A sidecar that cannot bind says so in its own control; the native writer stays verified.
    try { await this.sidecar?.value.bindNative({ address: transport.remoteAddress, nativeSessionId: threadId }); }
    catch { /* reported by the plugin */ }
    // A control outage must not erase a verified native writer or lose the attachment needed on reconnect.
    this.ctx.host.updateSession(this.sessionId, {
      ...(this.ctx.flavor.id === 'codex' && current.configPending && current.backendProfileId === this.ctx.profile.id ? { configPending: false } : {}),
      nativeRuntime: {
        address: transport.remoteAddress, fingerprint: this.fingerprint, scopeFingerprint: this.scopeFingerprint,
        profileId: this.ctx.profile.id, ...(attachment ? { attachment } : {}),
      },
    });
  }

  async loadedThread(threadId: string, fresh = false): Promise<boolean | undefined> {
    if (!fresh && this.loadedCheckThreadId === threadId && Date.now() - this.loadedCheckAt < 5_000) return this.loadedCheck;
    const clearCheck = () => {
      this.loadedCheck = undefined;
      this.loadedCheckAt = 0;
      this.loadedCheckThreadId = undefined;
    };
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      let result: { data?: unknown; nextCursor?: string | null };
      try {
        result = await this.requireTransport().request<{ data?: unknown; nextCursor?: string | null }>('thread/loaded/list', {
          ...(cursor ? { cursor } : {}), limit: 100,
        });
      } catch {
        // Older app-server versions may not expose this endpoint. Unknown is different from the
        // authoritative empty list and must never trigger a writer-creating resume.
        clearCheck();
        return undefined;
      }
      if (!Array.isArray(result.data)) {
        clearCheck();
        return undefined;
      }
      if (result.data.includes(threadId)) {
        this.loadedCheck = true;
        this.loadedCheckAt = Date.now();
        this.loadedCheckThreadId = threadId;
        return true;
      }
      if (!result.nextCursor) {
        this.loadedCheck = false;
        this.loadedCheckAt = Date.now();
        this.loadedCheckThreadId = threadId;
        return false;
      }
      cursor = result.nextCursor;
    }
    clearCheck();
    return undefined;
  }

  requireTransport(): CodexAppServerClient {
    if (!this.client?.isOnline) throw new Error(`${this.label} app-server is offline`);
    return this.client;
  }

  async discardFailedTransport(): Promise<void> {
    this.ctx.beginMaterialization();
    const transport = this.client;
    this.client = undefined;
    this.owner = false;
    if (!transport) return;
    if (this.borrowed && transport.detach) await transport.detach();
    else await transport.dispose();
    await this.releaseAttachment(this.borrowed);
  }

  /**
   * Lets the transport and the sidecar go. `keepRunning` leaves a process this runtime borrowed or
   * confirmed as owner running for the next one to join; `markClosed` then clears what it knew.
   */
  async releaseTransport(keepRunning: boolean | undefined): Promise<void> {
    const transport = this.client;
    this.client = undefined;
    const preserveOwner = keepRunning && (this.borrowed || this.owner);
    if (preserveOwner && transport?.detach) await transport.detach();
    else await transport?.dispose();
    await this.releaseAttachment(Boolean(preserveOwner));
  }

  markClosed(): void {
    this.borrowed = false;
    this.owner = false;
  }

  noteConnectionFailure(error: unknown): void {
    if (isActiveWriterError(error)) {
      this.setConnection({ state: 'conflict', message: `Another ${this.label} client currently owns this thread. The saved history remains available.` });
      return;
    }
    const message = safeProviderError(error, this.profileConfig);
    this.ctx.refreshStatus({ ...(this.client?.isOnline ? {} : { link: 'offline' as const }), connection: { state: 'failed', message } });
  }

  setConnection(connection: NonNullable<NativeStatus['connection']>, source?: 'profile' | 'endpoint'): void {
    this.conflictSource = connection.state === 'conflict' ? source : undefined;
    this.ctx.refreshStatus({ connection });
  }

  logRecovery(source: string, endpoint: string, attempt: string, result: string, commit: boolean): void {
    console.info('[codex-recovery]', JSON.stringify({
      sessionId: this.sessionId,
      nativeThreadId: this.ctx.threadId() ?? null,
      source,
      endpoint,
      attempt,
      result,
      commit,
    }));
  }
}
