import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { TerminalAppearance } from '@contracts';
import { AppError, WarmPool, WarmupRefused, reserveWarmTerminal, resolveTerminalAppearance, terminalWarmOptions, type WarmPoolStats, type WarmStart } from '@riffet/plugin-api/kit';
import { type AgentProjectView, type AgentReservation, type AgentSessionView, type AgentTerminalHandle } from '@riffet/plugin-api/experimental/agent';
import { cursorAgentAdapter } from '../cli-adapter.js';
import { cursorConfigDirectory, cursorLaunchSpec, type CursorLaunchProfile } from '../cli-driver.js';
import type { CursorPort } from '../host-port.js';
import type { CursorLive } from './live.js';
import type { CursorToolsLaunch } from '../backend/riffet-tools.js';
import { writeChatApproval } from './chat-store.js';
import { cursorLoginPrompt, parseScreen } from './screen.js';

export interface NativeRuntimeConfig {
  appearance?: TerminalAppearance;
  model?: string;
  mode?: string;
  approval?: string;
  /** Resolved Cursor data directory; defaults to the launcher's standard directory. */
  configDir?: string;
  /** Stable non-secret identity for wrapper/account/environment selection. */
  profileKey?: string;
  /** What decides the CLI's Riffet tool list (`CursorRiffetTools.signature`); a warm CLI is taken only with the same. */
  tools?: string;
}

/** Riffet's tools for the CLIs a runtime starts (`backend/riffet-tools.ts`). */
export interface NativeRuntimeTools {
  forSession(sessionId: string): Promise<CursorToolsLaunch | undefined>;
  provisional(projectId: string): Promise<(CursorToolsLaunch & { signature: string; adopt(sessionId: string): void; revoke(): void }) | undefined>;
  signature(sessionId: string): Promise<string | undefined>;
}

/** A warm CLI's terminal, and the provisional tools credential it holds until a session adopts it. */
type CursorWarm = AgentReservation & { tools?: { adopt(sessionId: string): void; revoke(): void } };

/** Extra profile, CLI flags, and pane env supplied per session (used by standing assistant launches). */
export interface NativeLaunchExtras {
  profile?: CursorLaunchProfile;
  args?: string[];
  env?: Record<string, string>;
  /** True when the session must skip generic warm CLI reuse (isolated configuration). */
  skipWarm?: boolean;
}

export interface NativeRuntimeManagerOptions {
  port: CursorPort;
  /** `session` is the conversation being started, whose profile's catalog names the model; a warmup has none. */
  prepareModel(model: string | undefined, project: Pick<AgentProjectView, 'cwd'>, session?: AgentSessionView): Promise<string | undefined>;
  cliPath: string;
  profile?: CursorLaunchProfile;
  configDir?: string;
  /** Riffet's tools for each CLI; without it the CLIs get none. */
  tools?: NativeRuntimeTools;
  /** Session-specific launch overrides (e.g. standing assistant isolation). */
  launchExtras?(session: AgentSessionView, project: AgentProjectView): Promise<NativeLaunchExtras | undefined>;
  profileKey?: string;
  /** Where the CLIs it starts write the step they stream (`live.ts`). */
  live?: CursorLive;
  /** The id a new chat is created under; a fresh UUID unless a test fixes it. */
  createChatId?(cwd: string): Promise<string | undefined>;
  /** The warm pool's timings (`PREWARM_BUDGET` unless a test sets them). */
  warmLeaseMs?: number;
  readinessTimeoutMs?: number;
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

export type NativeRuntimeStage = 'prepareModel' | 'createChatId' | 'terminalCreate' | 'prewarmReady';
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

const EMPTY_STAGE_STATS = (): NativeRuntimeStats['stages'] => ({
  prepareModel: { count: 0, totalMs: 0, maxMs: 0 },
  createChatId: { count: 0, totalMs: 0, maxMs: 0 },
  terminalCreate: { count: 0, totalMs: 0, maxMs: 0 },
  prewarmReady: { count: 0, totalMs: 0, maxMs: 0 },
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
  private readonly now: () => number;
  private readonly statsState: NativeRuntimeStats = emptyRuntimeStats();
  /** The one warm CLI, in a reserved terminal; the pool decides when it starts and ends. */
  private readonly warm: WarmPool<CursorWarm>;
  private closed = false;
  private launchPlugin?: (session?: AgentSessionView) => Promise<string[]>;
  private readonly port: CursorPort;

  constructor(private readonly options: NativeRuntimeManagerOptions) {
    this.port = options.port;
    this.now = options.now ?? Date.now;
    const terminalOptions = terminalWarmOptions(this.port.terminals);
    this.warm = new WarmPool<CursorWarm>({
      label: 'cursor',
      ...terminalOptions,
      // A warm CLI no session took gives its provisional credential back with its terminal.
      stop: async reservation => { reservation.tools?.revoke(); await terminalOptions.stop(reservation); },
      ...(options.warmLeaseMs !== undefined ? { leaseMs: options.warmLeaseMs } : {}),
      ...(options.readinessTimeoutMs !== undefined ? { readyTimeoutMs: options.readinessTimeoutMs } : {}),
      ...(options.failureBackoffMs !== undefined ? { failureBackoffMs: options.failureBackoffMs } : {}),
      now: this.now,
    });
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

    const fresh = !session.resumePicker && !session.nativeSessionId;
    // The model check, the hook plugin, Riffet's tools and any standing overrides do not depend on each other.
    const pluginTask = this.launchPlugin?.(session) ?? Promise.resolve([]);
    void pluginTask.catch(() => undefined);
    const toolsTask = this.options.tools?.forSession(session.id) ?? Promise.resolve(undefined);
    void toolsTask.catch(() => undefined);
    const extrasTask = this.options.launchExtras?.(session, project) ?? Promise.resolve(undefined);
    void extrasTask.catch(() => undefined);
    let launchModel = session.model;
    if (!session.resumePicker) {
      const started = this.now();
      launchModel = await this.options.prepareModel(session.model, project, session);
      this.recordStage('prepareModel', started);
      if (launchModel !== session.model) {
        session = this.port.updateSession(session.id, { model: launchModel });
      }
    }

    const extras = await extrasTask;
    if (fresh && !extras?.skipWarm) {
      // By the model as resolved now: one resolved differently at prewarm (a refreshed catalog) runs another model.
      const tools = await this.options.tools?.signature(session.id).catch(() => undefined);
      const resourceKey = this.resourceKey(project, { ...this.sessionConfig(session), model: launchModel, ...(tools ? { tools } : {}) });
      const sessionId = session.id;
      const warm = await this.warm.take(resourceKey, async reservation => {
        const claimed = await this.port.terminals.claim(reservation.terminal.id, { ownerToken: reservation.ownerToken, resourceKey: reservation.resourceKey, sessionId });
        // The CLI's tools now act for this conversation; one that gets none leaves the provisional credential unused.
        try {
          if (tools) reservation.tools?.adopt(sessionId); else reservation.tools?.revoke();
        } catch (error) {
          // Claimed but not adopted: its credential is about to be revoked, so the cold launch must not reuse it.
          await this.port.terminals.stop(claimed.id).catch(() => {});
          throw error;
        }
        return claimed;
      });
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
    const toolsLaunch = await toolsTask.catch(() => undefined);
    const launchProfile = extras?.profile ?? this.options.profile ?? this.options.cliPath;
    const args = [...pluginArgs, ...extras?.args ?? [], ...toolsLaunch?.args ?? [], ...cursorAgentAdapter.buildArgs({
      ...(session.resumePicker ? { resumePicker: true } : {}),
      hasStoredSession: Boolean(chatId),
      mode: session.mode,
      ...(session.approval ? { approval: session.approval } : {}),
      ...(launchModel ? { model: launchModel } : {}),
      ...(options.initialPrompt ? { initialPrompt: options.initialPrompt } : {}),
    })];
    if (options.initialPrompt) await runBeforeSpawn(options.beforeSpawn);
    writeChatApproval(cursorConfigDirectory(launchProfile), project.cwd, chatId, session.approval);
    const launchStarted = this.now();
    const info = await this.port.terminals.launch(session.id, {
      ...cursorLaunchSpec(launchProfile, [...(chatId ? ['--resume', chatId] : []), ...args], extras?.env ?? {}, project.cwd, { paneEnv: { ...this.options.live?.launchEnv(), ...toolsLaunch?.env } }),
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
    if (this.closed) return { state: 'skipped', reason: 'manager-closed' };
    const project = this.port.getProject(projectId);
    if (project.archivedAt) return { state: 'skipped', reason: 'project-archived' };
    return this.warm.request({ key: this.resourceKey(project, config), ...renewal }, start => this.startWarm(start, project, config));
  }

  /** The page that asked for the warm CLI no longer wants it; one a session has claimed is not affected. */
  async releasePrewarm(claimId: string): Promise<void> {
    await this.warm.release(claimId);
  }

  /** Counters and aggregate stage times; no prompt text, credentials, or model arguments are kept. */
  stats(): NativeRuntimeStats & { warm: WarmPoolStats } {
    const warm = this.warm.stats();
    return {
      warmHits: warm.hits,
      warmMisses: warm.misses,
      prewarmReady: warm.ready,
      prewarmSkipped: warm.skipped + warm.failed,
      stages: { ...Object.fromEntries(Object.entries(this.statsState.stages).map(([key, value]) => [key, { ...value }])) as NativeRuntimeStats['stages'], prewarmReady: warm.readyMs },
      warm,
    };
  }

  /** Stops only unclaimed warm terminals created by this manager. Active sessions stay running. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.sessionOperations]);
    await this.warm.close();
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

  /**
   * The warm CLI for `config`: the model resolved the way a session's start resolves it (and kept as
   * the key a session matches it by), a chat id of its own, the hook plugin, and a reserved terminal,
   * ready once its prompt bar is drawn. A dialog or the login screen in its place refuses the warmup.
   */
  private async startWarm(start: WarmStart, project: AgentProjectView, config: NativeRuntimeConfig): Promise<CursorWarm> {
    const modelStarted = this.now();
    const launchModel = await this.options.prepareModel(config.model, project);
    this.recordStage('prepareModel', modelStarted);
    const tools = await this.options.tools?.provisional(project.id).catch(() => undefined);
    try {
      // Matched by the tools it lists too: a conversation with others (a phone, another Agent) starts its own CLI.
      const resourceKey = this.resourceKey(project, { ...config, model: launchModel, ...(tools ? { tools: tools.signature } : {}) });
      start.alias(resourceKey);
      const reservation = await this.reserveWarm(start, project, config, launchModel, resourceKey, tools);
      return { ...reservation, ...(tools ? { tools: { adopt: tools.adopt, revoke: tools.revoke } } : {}) };
    } catch (error) {
      tools?.revoke();
      throw error;
    }
  }

  private async reserveWarm(start: WarmStart, project: AgentProjectView, config: NativeRuntimeConfig, launchModel: string | undefined, resourceKey: string, tools: CursorToolsLaunch | undefined): Promise<AgentReservation> {
    const nativeSessionId = await this.createChatId(project.cwd);
    if (!nativeSessionId) throw new WarmupRefused('chat-id-unavailable');
    const args = [...await this.launchPlugin?.() ?? [], ...tools?.args ?? [], ...this.launchArgs({ ...config, model: launchModel })];
    const appearance = resolveTerminalAppearance(config.appearance);
    return reserveWarmTerminal(this.port.terminals, {
      projectId: project.id,
      ownerToken: this.ownerToken,
      resourceKey,
      nativeSessionId,
      ...(appearance ? { appearance } : {}),
      spec: { ...cursorLaunchSpec(this.options.profile ?? this.options.cliPath, ['--resume', nativeSessionId, ...args], {}, project.cwd, { paneEnv: { ...this.options.live?.launchEnv(), ...tools?.env } }), title: 'Native startup warmup', kind: 'cursor' },
    }, start, screen => {
      const parsed = parseScreen(screen);
      if (parsed.footer && parsed.phase === 'idle') return 'ready';
      if (parsed.footer && parsed.phase === 'attention') return { blocked: 'cli-attention-required' };
      if (cursorLoginPrompt(screen)) return { blocked: 'cli-login-required' };
      return undefined;
    });
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
      tools: config.tools ?? null,
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

  private recordStage(stage: NativeRuntimeStage, startedAt: number): void {
    const duration = Math.max(0, this.now() - startedAt);
    const stat = this.statsState.stages[stage];
    stat.count += 1;
    stat.totalMs += duration;
    stat.maxMs = Math.max(stat.maxMs, duration);
  }

}
