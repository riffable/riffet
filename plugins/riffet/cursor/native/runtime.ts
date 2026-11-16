import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { TerminalAppearance } from '@contracts';
import { AppError, resolveTerminalAppearance } from '@riffet/plugin-api/kit';
import { type AgentProjectView, type AgentReservation, type AgentSessionView, type AgentTerminalHandle } from '@riffet/plugin-api/experimental/agent';
import { cursorAgentAdapter } from '../cli-adapter.js';
import { cursorConfigDirectory, cursorLaunchSpec, type CursorLaunchProfile } from '../cli-driver.js';
import type { CursorPort } from '../host-port.js';
import type { CursorLive } from './live.js';
import { parseScreen } from './screen.js';

export interface NativeRuntimeConfig {
  appearance?: TerminalAppearance;
  model?: string;
  mode?: string;
  approval?: string;
  /** Resolved Cursor data directory; defaults to the launcher's standard directory. */
  configDir?: string;
  /** Stable non-secret identity for wrapper/account/environment selection. */
  profileKey?: string;
}

export interface NativeRuntimeManagerOptions {
  port: CursorPort;
  prepareModel(model: string | undefined, project: Pick<AgentProjectView, 'cwd'>): Promise<string | undefined>;
  cliPath: string;
  profile?: CursorLaunchProfile;
  configDir?: string;
  profileKey?: string;
  /** Where the CLIs it starts write the step they stream (`live.ts`). */
  live?: CursorLive;
  /** The id a new chat is created under; a fresh UUID unless a test fixes it. */
  createChatId?(cwd: string): Promise<string | undefined>;
  /**
   * How long a warm CLI outlives the last request for it. The page that wants it renews it while it
   * is open and releases it when it closes (`releasePrewarm`); this only bounds a page that vanished.
   */
  warmLeaseMs?: number;
  /** How long a send waits for a warmup still booting before it starts a CLI of its own. */
  warmClaimWaitMs?: number;
  readinessTimeoutMs?: number;
  readinessPollMs?: number;
  failureBackoffMs?: number;
  now?(): number;
}

export interface NativePrewarmRenewal {
  /** The claim the asking page holds: its renewal never replaces a warm CLI another page holds. */
  claimId?: string;
  /** Renew only, start nothing. */
  renewOnly?: boolean;
}

export interface NativePrewarmResult {
  state: 'ready' | 'preparing' | 'skipped';
  claimId?: string;
  reason?: string;
  expiresAt?: number;
}

export type NativeRuntimeStage = 'prepareModel' | 'createChatId' | 'terminalCreate' | 'prewarmReady' | 'warmCleanup';
export interface NativeRuntimeStats {
  warmHits: number;
  warmMisses: number;
  prewarmReady: number;
  prewarmSkipped: number;
  stages: Record<NativeRuntimeStage, { count: number; totalMs: number; maxMs: number }>;
}

export interface NativeEnsureOptions {
  initialPrompt?: string;
  /** `host.beforeSpawn` is asynchronous; a hook that is not stays synchronous all the way to the launch. */
  beforeSpawn?: () => void | Promise<void>;
}

export interface NativeEnsureResult {
  terminal: AgentTerminalHandle;
  /**
   * The `initialPrompt` was not put on a command line: a warm CLI took the conversation and the
   * caller submits the prompt to it, committing its fence (`beforeSpawn`) before the write.
   */
  promptPending?: true;
}

/** Runs a launch hook; a refusal becomes `NATIVE_LAUNCH_ABORTED` so callers can tell it from a start failure. */
export function runBeforeSpawn(beforeSpawn: (() => void | Promise<void>) | undefined): void | Promise<void> {
  if (!beforeSpawn) return;
  const aborted = (error: unknown) => new AppError('NATIVE_LAUNCH_ABORTED', error instanceof Error ? error.message : 'Launch was aborted before the CLI started', 409, { reason: error instanceof AppError ? error.code : undefined });
  try {
    const pending = beforeSpawn();
    if (pending) return pending.then(undefined, (error) => { throw aborted(error); });
  } catch (error) { throw aborted(error); }
}

interface WarmEntry {
  claimId: string;
  ownerToken: string;
  resourceKey: string;
  requestKey: string;
  projectId: string;
  nativeSessionId?: string;
  launchModel?: string;
  state: 'preparing' | 'ready' | 'failed';
  reason?: string;
  terminalId?: string;
  expiresAt?: number;
  /** Until when the page that asked for it is taken to still want it. */
  leaseUntil: number;
  cancelled: boolean;
  task: Promise<void>;
  createTask?: Promise<AgentReservation>;
  timer?: NodeJS.Timeout;
  cleanupTask?: Promise<void>;
  stopTask?: Promise<void>;
  stopTerminalId?: string;
}

const EMPTY_STAGE_STATS = (): NativeRuntimeStats['stages'] => ({
  prepareModel: { count: 0, totalMs: 0, maxMs: 0 },
  createChatId: { count: 0, totalMs: 0, maxMs: 0 },
  terminalCreate: { count: 0, totalMs: 0, maxMs: 0 },
  prewarmReady: { count: 0, totalMs: 0, maxMs: 0 },
  warmCleanup: { count: 0, totalMs: 0, maxMs: 0 },
});

/** What `stats()` reports before anything has run. */
export const emptyRuntimeStats = (): NativeRuntimeStats => ({ warmHits: 0, warmMisses: 0, prewarmReady: 0, prewarmSkipped: 0, stages: EMPTY_STAGE_STATS() });

const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Coordinates native terminal creation and one short-lived, unused warm terminal.
 * Warm terminals are reservations the host holds and never links to a Session
 * until they are claimed. No prompt is ever sent during warmup.
 */
export class NativeRuntimeManager {
  private readonly ownerToken = randomUUID();
  /** The operations `withSession` has started and not finished, for `close` to wait on. */
  private readonly sessionOperations = new Set<Promise<unknown>>();
  private warmTail?: Promise<void>;
  private readonly warmLeaseMs: number;
  private readonly warmClaimWaitMs: number;
  private readonly readinessTimeoutMs: number;
  private readonly readinessPollMs: number;
  private readonly failureBackoffMs: number;
  private readonly now: () => number;
  private readonly statsState: NativeRuntimeStats = emptyRuntimeStats();
  private readonly failedWarmups = new Map<string, { until: number; reason: string }>();
  private startupReap?: Promise<void>;
  private warm?: WarmEntry;
  private closed = false;
  private launchPlugin?: (session?: AgentSessionView) => Promise<string[]>;
  private readonly port: CursorPort;

  constructor(private readonly options: NativeRuntimeManagerOptions) {
    this.port = options.port;
    this.warmLeaseMs = Math.max(1, options.warmLeaseMs ?? 90_000);
    this.warmClaimWaitMs = Math.max(0, options.warmClaimWaitMs ?? 15_000);
    this.readinessTimeoutMs = Math.max(1, options.readinessTimeoutMs ?? 30_000);
    this.readinessPollMs = Math.max(10, options.readinessPollMs ?? 160);
    this.failureBackoffMs = Math.max(0, options.failureBackoffMs ?? 5_000);
    this.now = options.now ?? Date.now;
    void this.beginStartupReap().catch(() => undefined);
  }

  /** Server-owned plugins are prepared before spawn, including unused warm terminals. */
  useLaunchPlugin(prepare: (session?: AgentSessionView) => Promise<string[]>): void { this.launchPlugin = prepare; }

  /** The host's per-session lock. */
  withSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> { return this.tracked(this.port.withSessionLock(sessionId, fn)); }

  /** `withSession` for work scheduled from timers. */
  withDetachedSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> { return this.tracked(this.port.withSessionLock(sessionId, fn, { detached: true })); }

  private tracked<T>(operation: Promise<T>): Promise<T> {
    this.sessionOperations.add(operation);
    const done = () => { this.sessionOperations.delete(operation); };
    operation.then(done, done);
    return operation;
  }

  /**
   * Reuses a live process, claims a matching warm process, or creates a new native CLI.
   *
   * When `initialPrompt` is set the caller is dispatching the FIRST user message of a brand-new
   * session. A matching warm CLI is claimed first, even one still booting: a CLI's own start takes
   * seconds (its runtime, MCP servers, skills), so one that began earlier is ready sooner than a new
   * one. The prompt is then left to the caller (`promptPending`). Without one, the prompt is put on
   * the command line of a new CLI, which takes it as soon as it has started.
   *
   * `beforeSpawn` runs (and is awaited) immediately before the CLI carrying `initialPrompt` is created,
   * so the caller can commit its no-replay fence first. If it throws, nothing is spawned and the
   * launch fails with `NATIVE_LAUNCH_ABORTED`, leaving the session state as it was.
   */
  async ensure(session: AgentSessionView, options: NativeEnsureOptions = {}): Promise<NativeEnsureResult> {
    return this.withSession(session.id, async () => {
      let current = this.port.getSession(session.id);
      const previous = { state: current.state, error: current.error };
      const hasLiveTerminal = current.terminalId !== undefined && (this.port.findTerminal(current.terminalId)?.state ?? 'exited') !== 'exited';
      if (!hasLiveTerminal && current.state !== 'starting') {
        current = this.port.updateSession(session.id, { state: 'starting', error: undefined });
      }
      try { return await this.ensureLocked(session.id, options); }
      catch (error) {
        if (error instanceof AppError && error.code === 'NATIVE_LAUNCH_ABORTED') {
          this.port.updateSession(session.id, previous);
          throw error;
        }
        const message = error instanceof AppError ? error.message : 'Native Cursor terminal could not start';
        this.port.updateSession(session.id, { state: 'failed', error: message });
        throw error;
      }
    });
  }

  private async ensureLocked(sessionId: string, options: NativeEnsureOptions = {}): Promise<NativeEnsureResult> {
    if (this.closed) throw new AppError('NATIVE_RUNTIME_CLOSED', 'Native runtime manager is closed', 503);
    await this.ensureStartupReap();
    let session = this.port.getSession(sessionId);
    if (session.archivedAt) throw new AppError('ARCHIVED_SESSION', 'Restore this conversation before running it', 409);
    const project = this.port.getProject(session.projectId);

    const existing = await this.findExisting(session);
    if (existing) {
      // A pre-existing live terminal cannot absorb a positional argv prompt retroactively.
      // The caller must guard against this (dispatcher only sets initialPrompt when the session
      // has no terminal yet); surface a clear error if the contract is violated.
      if (options.initialPrompt) throw new AppError('CLI_ALREADY_RUNNING', 'The CLI is already ready; the first message should use the normal submit path', 409);
      return { terminal: existing };
    }

    const requestedModel = session.model;
    const fresh = !session.resumePicker && !session.nativeSessionId;
    // The model check and the hook plugin do not depend on each other.
    const pluginTask = this.launchPlugin?.(session) ?? Promise.resolve([]);
    void pluginTask.catch(() => undefined);
    let launchModel = session.model;
    if (!session.resumePicker) {
      const started = this.now();
      launchModel = await this.options.prepareModel(session.model, project);
      this.recordStage('prepareModel', started);
      if (launchModel !== session.model) {
        session = this.port.updateSession(session.id, { model: launchModel });
      }
    }

    if (fresh) {
      const resourceKey = this.resourceKey(project, { ...this.sessionConfig(session), model: launchModel });
      const requestKey = this.resourceKey(project, { ...this.sessionConfig(session), model: requestedModel });
      const warm = await this.claimReadyWarmup(resourceKey, requestKey, session.id, launchModel);
      if (warm) return { terminal: warm, ...(options.initialPrompt ? { promptPending: true as const } : {}) };
    }

    let chatId = session.nativeSessionId;
    if (!chatId && !session.resumePicker) {
      const started = this.now();
      chatId = await this.createChatId(project.cwd);
      this.recordStage('createChatId', started);
      if (chatId) session = this.port.setNativeSessionId(session.id, chatId);
    }

    const pluginArgs = await pluginTask;
    const args = [...pluginArgs, ...cursorAgentAdapter.buildArgs({
      ...(session.resumePicker ? { resumePicker: true } : {}),
      hasStoredSession: Boolean(chatId),
      mode: session.mode,
      ...(session.approval ? { approval: session.approval } : {}),
      ...(launchModel ? { model: launchModel } : {}),
      ...(options.initialPrompt ? { initialPrompt: options.initialPrompt } : {}),
    })];
    if (options.initialPrompt) await runBeforeSpawn(options.beforeSpawn);
    const launchStarted = this.now();
    const info = await this.port.terminals.launch(session.id, {
      ...cursorLaunchSpec(this.options.profile ?? this.options.cliPath, [...(chatId ? ['--resume', chatId] : []), ...args], {}, project.cwd, { paneEnv: this.options.live?.launchEnv() }),
      kind: 'cursor',
      reuseLive: true,
    });
    this.recordStage('terminalCreate', launchStarted);
    // This launch read the record, so any switch that was waiting for a relaunch has just been
    // honored: leaving the flag set would make the workbench restart a CLI that is already current.
    this.port.updateSession(session.id, { terminalId: info.id, state: 'running', error: undefined, configPending: false });
    return { terminal: info };
  }

  /**
   * Start warmup in the background. Repeated calls with the same resource key return the
   * existing claim state and renew its lease; only one unused persistent CLI is allowed per manager.
   */
  async prewarm(projectId: string, config: NativeRuntimeConfig, renewal: NativePrewarmRenewal = {}): Promise<NativePrewarmResult> {
    return this.withWarmLock(() => this.prewarmLocked(projectId, config, renewal));
  }

  private async prewarmLocked(projectId: string, config: NativeRuntimeConfig, renewal: NativePrewarmRenewal): Promise<NativePrewarmResult> {
    if (this.closed) return this.skipped('manager-closed');
    await this.ensureStartupReap();
    if (this.closed) return this.skipped('manager-closed');
    const project = this.port.getProject(projectId);
    if (project.archivedAt) return this.skipped('project-archived');
    const requestKey = this.resourceKey(project, config);
    const current = this.warm;
    const live = current && !current.cancelled && current.state !== 'failed' ? current : undefined;
    if (live && (live.resourceKey === requestKey || live.requestKey === requestKey)) {
      if (live.state === 'ready' && (live.expiresAt ?? 0) > this.now()) {
        await this.renewLease(live);
        return { state: 'ready', claimId: live.claimId, expiresAt: live.expiresAt };
      }
      if (live.state === 'preparing') {
        live.leaseUntil = this.now() + this.warmLeaseMs;
        return { state: 'preparing', claimId: live.claimId };
      }
    }
    if (renewal.renewOnly) return this.skipped('workspace_busy');
    // One slot: a page's first request takes it over, its renewals never take it from another page.
    if (renewal.claimId && live && live.claimId !== renewal.claimId) return this.skipped('held_elsewhere');
    const previousFailure = this.failedWarmups.get(requestKey);
    if (previousFailure && previousFailure.until > this.now()) return this.skipped(previousFailure.reason);
    if (previousFailure) this.failedWarmups.delete(requestKey);

    if (current) await this.invalidateWarmLocked(current, 'replaced');
    if (this.closed) return this.skipped('manager-closed');
    const entry: WarmEntry = {
      claimId: randomUUID(),
      ownerToken: this.ownerToken,
      resourceKey: requestKey,
      requestKey,
      projectId,
      state: 'preparing',
      leaseUntil: this.now() + this.warmLeaseMs,
      cancelled: false,
      task: Promise.resolve(),
    };
    this.warm = entry;
    entry.task = this.prepareWarmup(entry, project, config);
    void entry.task.catch(() => undefined);
    return { state: 'preparing', claimId: entry.claimId };
  }

  /** The page that asked for the warm CLI no longer wants it; one a session has claimed is not affected. */
  async releasePrewarm(claimId: string): Promise<void> {
    await this.withWarmLock(async () => {
      const warm = this.warm;
      if (warm && warm.claimId === claimId) await this.invalidateWarmLocked(warm, 'released');
    });
  }

  /** Counters and aggregate stage times; no prompt text, credentials, or model arguments are kept. */
  stats(): NativeRuntimeStats {
    return {
      warmHits: this.statsState.warmHits,
      warmMisses: this.statsState.warmMisses,
      prewarmReady: this.statsState.prewarmReady,
      prewarmSkipped: this.statsState.prewarmSkipped,
      stages: Object.fromEntries(Object.entries(this.statsState.stages).map(([key, value]) => [key, { ...value }])) as NativeRuntimeStats['stages'],
    };
  }

  /** Stops only unclaimed warm terminals created by this manager. Active sessions stay running. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.startupReap?.catch(() => undefined);
    await Promise.allSettled([...this.sessionOperations]);
    await this.withWarmLock(async () => {
      const warm = this.warm;
      if (warm) await this.invalidateWarmLocked(warm, 'manager-closed');
      for (const warmup of await this.port.terminals.reservations(this.ownerToken)) {
        await this.port.terminals.releaseReservation(warmup.terminal.id, this.ownerToken).catch(() => false);
      }
    });
  }

  private async findExisting(session: AgentSessionView): Promise<AgentTerminalHandle | undefined> {
    // The port's terminals are those of this Agent's sessions: a reservation is not among them.
    const isLiveCursor = (info: { kind: string; state: string }) => info.kind === 'cursor' && info.state !== 'exited';
    // With a terminalId the sessionId-filtered match is a subset of the plain id match, so the id lookup alone is equivalent.
    const byId = session.terminalId ? this.port.findTerminal(session.terminalId) : undefined;
    const candidate = session.terminalId
      ? (byId && isLiveCursor(byId) ? byId : undefined)
      : this.port.listTerminals().find(info => isLiveCursor(info) && info.sessionId === session.id);
    if (!candidate) return undefined;
    const info = await this.port.terminals.get(candidate.id);
    if (info.state === 'exited') return undefined;
    // Reattaching is not activity: a live CLI's idle/waiting state comes from its screen, and forcing
    // `running` here made every new stream subscriber see the session flash busy and back.
    const live = session.state === 'running' || session.state === 'idle' || session.state === 'waiting' || session.state === 'cancelling';
    if (session.terminalId !== info.id || !live) {
      this.port.updateSession(session.id, { terminalId: info.id, ...(live ? {} : { state: 'running' as const }), error: undefined });
    }
    return info;
  }

  private async claimReadyWarmup(resourceKey: string, requestKey: string, sessionId: string, launchModel?: string): Promise<AgentTerminalHandle | undefined> {
    // A warm CLI still booting is waited for outside the warm lock, which renewals, releases and other launches take.
    const booting = this.warm;
    if (booting && !booting.cancelled && booting.state === 'preparing' && (booting.resourceKey === resourceKey || booting.requestKey === requestKey)) {
      // It has been booting since the page opened; a CLI started now would take longer.
      let readyTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        booting.task,
        new Promise<void>(resolveWait => { readyTimer = setTimeout(resolveWait, this.warmClaimWaitMs); }),
      ]);
      if (readyTimer) clearTimeout(readyTimer);
    }
    return this.withWarmLock(() => this.claimReadyWarmupLocked(resourceKey, requestKey, sessionId, launchModel));
  }

  private async claimReadyWarmupLocked(resourceKey: string, requestKey: string, sessionId: string, launchModel?: string): Promise<AgentTerminalHandle | undefined> {
    const warm = this.warm;
    // One for other settings or another project stays: it is held for the page that asked for it.
    if (!warm || (warm.resourceKey !== resourceKey && warm.requestKey !== requestKey) || warm.cancelled) {
      this.statsState.warmMisses += 1;
      return undefined;
    }
    if (warm.state === 'preparing') {
      this.statsState.warmMisses += 1;
      await this.invalidateWarmLocked(warm, 'not-ready-at-claim');
      return undefined;
    }
    if (warm.cancelled || warm.state !== 'ready' || warm.resourceKey !== resourceKey || warm.launchModel !== launchModel || !warm.terminalId) {
      this.statsState.warmMisses += 1;
      if (this.warm === warm) await this.invalidateWarmLocked(warm, warm.reason ?? 'warmup-unavailable');
      return undefined;
    }
    try {
      const info = await this.port.terminals.claim(warm.terminalId, {
        ownerToken: warm.ownerToken,
        resourceKey,
        sessionId,
      });
      this.clearWarmTimer(warm);
      warm.cancelled = true;
      if (this.warm === warm) this.warm = undefined;
      this.statsState.warmHits += 1;
      return info;
    } catch (error) {
      this.statsState.warmMisses += 1;
      await this.invalidateWarmLocked(warm, error instanceof AppError ? error.code.toLowerCase() : 'claim-failed');
      return undefined;
    }
  }

  private async prepareWarmup(entry: WarmEntry, project: AgentProjectView, config: NativeRuntimeConfig): Promise<void> {
    try {
      const modelStarted = this.now();
      const launchModel = await this.options.prepareModel(config.model, project);
      this.recordStage('prepareModel', modelStarted);
      if (entry.cancelled || this.closed) return;
      entry.launchModel = launchModel;
      entry.resourceKey = this.resourceKey(project, { ...config, model: launchModel });
      const chatStarted = this.now();
      const nativeSessionId = await this.createChatId(project.cwd);
      this.recordStage('createChatId', chatStarted);
      if (!nativeSessionId) {
        this.failWarmup(entry, 'chat-id-unavailable');
        return;
      }
      if (entry.cancelled || this.closed) return;
      entry.nativeSessionId = nativeSessionId;
      const normalized = { ...config, model: launchModel };
      const args = [...await this.launchPlugin?.() ?? [], ...this.launchArgs(normalized)];
      if (entry.cancelled || this.closed) return;
      const expiresAt = this.now() + this.readinessTimeoutMs + this.warmLeaseMs;
      const createStarted = this.now();
      const appearance = resolveTerminalAppearance(config.appearance);
      entry.createTask = this.port.terminals.reserve({
        projectId: project.id,
        ownerToken: entry.ownerToken,
        resourceKey: entry.resourceKey,
        nativeSessionId,
        expiresAt,
        ...(appearance ? { appearance } : {}),
        spec: { ...cursorLaunchSpec(this.options.profile ?? this.options.cliPath, ['--resume', nativeSessionId, ...args], {}, project.cwd, { paneEnv: this.options.live?.launchEnv() }), title: 'Native startup warmup', kind: 'cursor' },
      });
      const reservation = await entry.createTask;
      this.recordStage('terminalCreate', createStarted);
      entry.terminalId = reservation.terminal.id;
      entry.createTask = undefined;
      if (entry.cancelled || this.closed || this.warm !== entry) {
        await this.stopOwnedWarm(entry);
        return;
      }
      const readyStarted = this.now();
      const ready = await this.waitForIdle(entry);
      this.recordStage('prewarmReady', readyStarted);
      // Released or replaced while it booted: that is not a failure, and must not hold back the next request.
      if (entry.cancelled || this.closed || this.warm !== entry) {
        await this.stopOwnedWarm(entry);
        return;
      }
      if (!ready) {
        this.failWarmup(entry, entry.reason ?? 'cli-not-ready');
        await this.stopOwnedWarm(entry);
        return;
      }
      entry.state = 'ready';
      this.statsState.prewarmReady += 1;
      await this.withWarmLock(() => this.renewLease(entry, entry.leaseUntil));
    } catch (error) {
      this.failWarmup(entry, error instanceof AppError ? error.code.toLowerCase() : 'warmup-failed');
      await this.stopOwnedWarm(entry);
    }
  }

  /**
   * Moves a ready warm CLI's end to `until` (a new lease when absent) and arms its timer; one whose
   * lease has already run out is stopped by it at once. Called under the warm lock, so renewals land in order.
   */
  private async renewLease(entry: WarmEntry, until = this.now() + this.warmLeaseMs): Promise<void> {
    if (entry.cancelled || this.warm !== entry || !entry.terminalId) return;
    entry.leaseUntil = until;
    const remaining = until - this.now();
    // Armed first, so a failed extension below still leaves the lease able to run out.
    this.clearWarmTimer(entry);
    entry.timer = setTimeout(() => {
      void this.withWarmLock(async () => {
        if (entry.leaseUntil <= this.now()) await this.invalidateWarmLocked(entry, 'lease-expired');
      }).catch(() => undefined);
    }, Math.max(0, remaining));
    entry.timer.unref?.();
    if (remaining <= 0) return;
    entry.expiresAt = until;
    await this.port.terminals.extendReservation(entry.terminalId, { ownerToken: entry.ownerToken, resourceKey: entry.resourceKey, expiresAt: until });
  }

  private async waitForIdle(entry: WarmEntry): Promise<boolean> {
    const deadline = this.now() + this.readinessTimeoutMs;
    while (!entry.cancelled && !this.closed && this.now() <= deadline) {
      if (!entry.terminalId) return false;
      let info: AgentTerminalHandle;
      try { info = await this.port.terminals.get(entry.terminalId); }
      catch { this.failWarmup(entry, 'terminal-unavailable'); return false; }
      if (info.state === 'exited') { this.failWarmup(entry, 'cli-exited'); return false; }
      const screen = await this.port.terminals.screen(entry.terminalId).catch(() => undefined);
      if (screen) {
        const phase = parseScreen(screen);
        if (phase.phase === 'idle' && phase.footer) return true;
        if (phase.phase === 'attention' && phase.footer) {
          this.failWarmup(entry, 'cli-attention-required');
          return false;
        }
      }
      await new Promise(resolvePoll => setTimeout(resolvePoll, this.readinessPollMs));
    }
    if (!entry.cancelled) this.failWarmup(entry, 'readiness-timeout');
    return false;
  }

  private async invalidateWarmLocked(entry: WarmEntry, reason: string): Promise<void> {
    if (entry.cancelled) return entry.cleanupTask;
    const started = this.now();
    entry.cancelled = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.reason ??= reason;
    const cleanup = (async () => {
      if (entry.createTask) {
        const created = await entry.createTask.catch(() => undefined);
        if (created && !entry.stopTask) entry.terminalId = created.terminal.id;
        entry.createTask = undefined;
      }
      await this.stopOwnedWarm(entry);
      if (this.warm === entry) this.warm = undefined;
    })();
    entry.cleanupTask = cleanup;
    await cleanup;
    this.recordStage('warmCleanup', started);
  }

  private async stopOwnedWarm(entry: WarmEntry): Promise<void> {
    if (entry.stopTask) {
      if (entry.terminalId === entry.stopTerminalId) entry.terminalId = undefined;
      await entry.stopTask;
      return;
    }
    if (!entry.terminalId) return;
    const id = entry.terminalId;
    entry.terminalId = undefined;
    entry.stopTerminalId = id;
    entry.stopTask = this.port.terminals.releaseReservation(id, entry.ownerToken).then(() => undefined).catch(() => undefined);
    await entry.stopTask;
  }

  private failWarmup(entry: WarmEntry, reason: string): void {
    // A released or replaced warmup stops without having failed; it must not hold back the next request.
    if (entry.state === 'failed' || entry.cancelled) return;
    entry.state = 'failed';
    entry.reason = reason;
    this.statsState.prewarmSkipped += 1;
    this.failedWarmups.set(entry.resourceKey, { until: this.now() + this.failureBackoffMs, reason });
    this.failedWarmups.set(entry.requestKey, { until: this.now() + this.failureBackoffMs, reason });
  }

  private skipped(reason: string): NativePrewarmResult {
    this.statsState.prewarmSkipped += 1;
    return { state: 'skipped', reason };
  }

  /** Reap tagged terminals left by an earlier manager before this one starts a new CLI. */
  private beginStartupReap(): Promise<void> {
    if (this.startupReap) return this.startupReap;
    const task = this.reapOrphanWarmups();
    this.startupReap = task;
    void task.catch(() => {
      if (this.startupReap === task) this.startupReap = undefined;
    });
    return task;
  }

  private async ensureStartupReap(): Promise<void> {
    await this.beginStartupReap();
  }

  /**
   * Each temporary terminal is owner-tagged. A new process manager has a new token, so it
   * removes all still-live warmups by each record's own token; ordinary terminals have no
   * warmup metadata and are never considered here.
   */
  private async reapOrphanWarmups(): Promise<void> {
    const warmups = await this.port.terminals.reservations();
    const results = await Promise.allSettled(warmups.map(warmup =>
      this.port.terminals.releaseReservation(warmup.terminal.id, warmup.ownerToken),
    ));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  private sessionConfig(session: AgentSessionView): NativeRuntimeConfig {
    return { model: session.model, mode: session.mode, approval: session.approval, appearance: session.terminalAppearance };
  }

  private resourceKey(project: AgentProjectView, config: NativeRuntimeConfig): string {
    const configDir = resolve(config.configDir ?? this.options.configDir ?? cursorConfigDirectory(this.options.cliPath));
    const identity = {
      cliPath: this.options.cliPath,
      launchIdentity: this.options.profile?.identityKey??this.options.cliPath,
      profileKey: config.profileKey ?? this.options.profileKey ?? this.options.cliPath,
      configDir,
      cwd: resolve(project.cwd),
      model: config.model ?? null,
      mode: config.mode ?? 'agent',
      approval: config.approval ?? 'allowlist',
      appearance: resolveTerminalAppearance(config.appearance),
    };
    return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  }

  /** A warmup never resumes and carries no prompt; everything else matches a cold start. */
  private launchArgs(config: NativeRuntimeConfig): string[] {
    return cursorAgentAdapter.buildArgs({
      ...(config.mode ? { mode: config.mode } : {}),
      ...(config.approval ? { approval: config.approval } : {}),
      ...(config.model ? { model: config.model } : {}),
    });
  }

  /**
   * The id a new chat is created under. The CLI takes an id it has not seen with `--resume` and creates
   * the chat under it, so it is chosen here: known before the CLI starts (its receipt and live step
   * are found by it), and without `create-chat`, a CLI start of its own that takes seconds.
   */
  private async createChatId(cwd: string): Promise<string | undefined> {
    if (!this.options.createChatId) return randomUUID();
    try {
      const id = await this.options.createChatId(cwd);
      return id && CHAT_ID.test(id) ? id : undefined;
    } catch { return undefined; }
  }

  private clearWarmTimer(entry: WarmEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  private recordStage(stage: NativeRuntimeStage, startedAt: number): void {
    const duration = Math.max(0, this.now() - startedAt);
    const stat = this.statsState.stages[stage];
    stat.count += 1;
    stat.totalMs += duration;
    stat.maxMs = Math.max(stat.maxMs, duration);
  }

  private async withWarmLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.warmTail;
    let release!: () => void;
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const tail = (previous ?? Promise.resolve()).catch(() => undefined).then(() => gate);
    this.warmTail = tail;
    if (previous) await previous.catch(() => undefined);
    try { return await fn(); }
    finally {
      release();
    if (this.warmTail === tail) this.warmTail = undefined;
    }
  }
}
