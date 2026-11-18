import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NativeInteractionResponse, NativeSlashItem, NativeTurnTarget } from '@contracts';
import { AppError, estimatedTokens, materializeNativeInput, queryDirectory, scanCommandRoots, scanSkillRoots, slashTokens } from '@riffet/plugin-api/kit';
import {
  AGENT_PROTOCOL_VERSION, type AgentAvailability, type AgentBackend, type AgentCapabilities, type AgentCommandRequest, type AgentConfigurePatch, type AgentContext,
  type AgentControlMessage, type AgentHistoryOptions, type AgentHost, type AgentLaunchSpec, type AgentModelQuery, type AgentOpenOptions, type AgentPrewarmRequest,
  type AgentPrewarmResult, type AgentProfile, type AgentProjectConfigs, type AgentProjectView, type AgentReport, type AgentSendRequest, type AgentStopOptions,
  type AgentTerminalBehaviour, type AgentTraits, type AgentTranscriptSource,
} from '@riffet/plugin-api/experimental/agent';
import { CURSOR_AGENT_BUSY_PATTERN, CURSOR_AGENT_READY_PATTERN, CURSOR_CLI_VERSIONS, cursorAgentStartupError } from './cli-adapter.js';
import { CURSOR_LAUNCH_ENV, cursorApiFrontable, cursorLaunchProfileOf, setCursorApiFront, cursorLaunchSpec, redactCursorOutput, runCursor, type CursorLaunchProfile } from './cli-driver.js';
import { cursorCapabilityReport, cursorNeedsLogin, describeCursorProfile, runCursorOperation } from './config.js';
import { cursorPort, type CursorPort } from './host-port.js';
import { CursorActivities } from './backend/activity.js';
import { CURSOR_EXTENSION_LAYOUT } from './backend/extensions.js';
import { probeCursorHookSteer } from './backend/launch-plugin.js';
import { CursorLiveReceipts } from './backend/live-receipts.js';
import { CursorProjectConfigs } from './backend/project-configs.js';
import { readCursorShare } from './backend/share-read.js';
import { CursorSteerBridge } from './backend/steer.js';
import { CursorApiCache } from './backend/api-cache.js';
import { CursorTranscriptSource, type CursorTranscriptSignals } from './backend/transcript-source.js';
import { CursorUsageIngest } from './backend/usage.js';
import { workspaceChatsDir } from './native/chat-store.js';
import { CursorLive } from './native/live.js';
import { nativeModelCatalogFromVariants } from './native/model-catalog.js';
import { emptyRuntimeStats, NativeRuntimeManager } from './native/runtime.js';
import { promptSettled } from './native/screen.js';
import { NativeService } from './native/service.js';
import type { WatchMessage } from './native/watch.js';
import { ResumeTitleWatcher } from './title-watcher.js';

const CURSOR_MODES = [
  { id: 'agent', label: 'Agent' },
  { id: 'plan', label: 'Plan' },
  { id: 'ask', label: 'Ask' },
];
const CURSOR_PERMISSIONS = [
  { id: 'allowlist', label: 'Ask each time' },
  { id: 'auto-review', label: 'Auto review' },
  { id: 'unrestricted', label: 'Run everything' },
];
/** The CLI's own slash commands. Everything typed after `/` is forwarded verbatim, listed or not. */
const CURSOR_COMMANDS = [
  { name: 'model', description: '选择模型', hint: '[filter]' },
  { name: 'max-mode', description: '切换 Max 模式' },
  { name: 'fast', description: '切换 Fast 模式' },
  { name: 'plan', description: '规划模式：先出方案', hint: '[prompt]' },
  { name: 'ask', description: '切换只读问答模式' },
  { name: 'goal', description: '设定一个持续推进的目标', hint: '[objective]' },
  { name: 'summarize', description: '压缩对话以释放上下文' },
  { name: 'clear', description: '开始新的会话' },
  { name: 'resume', description: '打开最近会话并恢复' },
  { name: 'fork', description: '把当前会话分叉为新会话' },
  { name: 'rewind', description: '回退到之前的某条消息' },
  { name: 'rename', description: '重命名当前会话', hint: '<name>' },
  { name: 'changes', description: '查看本次对话、暂存与已提交的变更' },
  { name: 'commit', description: '让 Agent 暂存并提交变更' },
  { name: 'jobs', description: '查看正在运行的任务' },
  { name: 'run-everything', description: '切换 Run Everything' },
  { name: 'auto-review', description: '切换 Auto-review' },
  { name: 'sandbox', description: '沙箱设置' },
  { name: 'add-dir', description: '添加目录到当前工作区', hint: '[path]' },
  { name: 'skills', description: '打开 Skills 菜单' },
  { name: 'rule', description: '管理 Cursor 规则' },
  { name: 'command', description: '管理自定义命令' },
  { name: 'mcp', description: '管理 MCP 服务', hint: '[subcommand]' },
  { name: 'plugin', description: '管理插件' },
  { name: 'usage', description: '查看套餐与用量' },
  { name: 'config', description: '交互式修改 CLI 设置' },
  { name: 'debug', description: '切换调试模式', hint: '[prompt]' },
  { name: 'shell', description: '进入 Shell 模式', hint: '[command]' },
  { name: 'about', description: '版本、系统与账号信息' },
  { name: 'help', description: '帮助', hint: '[command]' },
];

export interface CursorBackendOptions {
  /** Where the hook bridge's plugin (`cursor-hook`) and the project-config backups (`config-backups`) are kept: Riffet's state directory, as they were before this was a plugin (see `legacyStateRoot`). */
  stateDir: string;
}

/** Metadata-only output-token estimate for one in-flight Cursor step. */
export interface CursorLiveUsageProgress {
  nativeSessionId: string;
  nativeTurnId: string;
  stepId: string;
  at: number;
  model?: string;
  outputTokens: number;
  sealed: boolean;
}

/** The pieces built from the first resolved launch profile; one set for the activation. */
interface CursorParts {
  profile: CursorLaunchProfile;
  port: CursorPort;
  native: NativeService;
  runtime: NativeRuntimeManager;
  steering: CursorSteerBridge;
  configs: CursorProjectConfigs;
  titles: ResumeTitleWatcher;
  live: CursorLive;
  receipts: CursorLiveReceipts;
  usage: CursorUsageIngest;
  apiCache?: CursorApiCache;
}

/**
 * cursor-agent echoes a prompt without any command id and answers slash commands in its own pane;
 * its hooks report turn ends; NativeService keeps its session state, statistics and dialogs.
 */
export const CURSOR_TRAITS: AgentTraits = {
  settlesSlashOnSubmit: true,
  untaggedEcho: true,
  reportsTurnOutcome: true,
  survivesRestart: true,
  ownsSessionObservation: true,
  resumesByNativeId: true,
  terminalName: 'Cursor',
};

/**
 * How the terminal host reads cursor-agent's panes: its prompt, or a turn in flight, means it
 * started; before that, its own error text explains an exit. The key is redacted out of that text.
 */
export const cursorTerminalBehaviour = (profile: CursorLaunchProfile | (() => CursorLaunchProfile | string)): AgentTerminalBehaviour => ({
  title: 'Cursor Agent',
  ready: text => CURSOR_AGENT_READY_PATTERN.test(text) || CURSOR_AGENT_BUSY_PATTERN.test(text),
  startupError: text => cursorAgentStartupError(redactCursorOutput(typeof profile === 'function' ? profile() : profile, text)),
});

/** Cursor's dispatcher/runtime/history/TUI implementation behind the Agent protocol. */
export class CursorBackend implements AgentBackend {
  readonly protocolVersion = AGENT_PROTOCOL_VERSION;
  readonly id = 'cursor' as const;
  readonly label = 'Cursor';
  readonly traits = CURSOR_TRAITS;
  readonly cliVersions = CURSOR_CLI_VERSIONS;
  /**
   * A Cursor snapshot reads the CLI's own chat store (`native/chat-store.ts`) and launches nothing,
   * so the search index may read a Cursor conversation nobody has opened.
   */
  readonly readOnlyHistory = true;
  /** cursor-agent queues a prompt submitted mid-turn, and Enter on the empty bar sends it in place of the turn. */
  readonly sendsNow = true;
  readonly launchEnv = CURSOR_LAUNCH_ENV;
  /** The key is redacted with the launch profile once there is one; before any, no Cursor terminal of this process has been launched. */
  readonly terminal: AgentTerminalBehaviour = cursorTerminalBehaviour(() => this.built?.profile ?? 'cursor-agent');
  readonly projectConfigs: AgentProjectConfigs = {
    list: (host, project, profile) => this.parts(host, profile).configs.list(project),
    read: (host, project, profile, id) => this.parts(host, profile).configs.read(project, id),
    write: (host, project, profile, id, content, expectedHash) => this.parts(host, profile).configs.write(project, id, content, expectedHash),
    create: (host, project, profile, input) => this.parts(host, profile).configs.create(project, input),
  };
  /** Whether a screen that shows no dialog has the CLI back at its prompt, which completes a dialog answer at once. */
  readonly settledScreen = promptSettled;
  private built?: CursorParts;
  private shutdown?: Promise<void>;
  private usageHost?: AgentHost;
  private stopUsageChanges?: () => void;
  private stopLiveUsageWatch?: () => void;
  private readonly usageListeners = new Set<() => void>();
  private readonly liveUsageListeners = new Set<(progress: CursorLiveUsageProgress) => void>();
  private readonly liveUsageEmitted = new Map<string, { outputTokens: number; sealed: boolean }>();
  /** Metadata-only settled counters, plus live step progress; no transcript, launch configuration or credentials. */
  readonly usageService = {
    version: '1.1.0',
    read: async () => {
      const host = this.usageHost;
      if (this.shutdown || !host?.stats.readObservations) throw new AppError('USAGE_UNAVAILABLE', 'Cursor usage is unavailable', 503);
      const records = await host.stats.readObservations();
      if (this.shutdown || host !== this.usageHost) throw new AppError('USAGE_UNAVAILABLE', 'Cursor usage is unavailable', 503);
      return { records };
    },
    subscribe: (listener: () => void) => {
      if (this.shutdown) throw new AppError('USAGE_UNAVAILABLE', 'Cursor usage is unavailable', 503);
      this.usageListeners.add(listener);
      return () => { this.usageListeners.delete(listener); };
    },
    subscribeLive: (listener: (progress: CursorLiveUsageProgress) => void) => {
      if (this.shutdown) throw new AppError('USAGE_UNAVAILABLE', 'Cursor usage is unavailable', 503);
      this.liveUsageListeners.add(listener);
      this.ensureLiveUsageWatch();
      return () => {
        this.liveUsageListeners.delete(listener);
        if (!this.liveUsageListeners.size) {
          this.stopLiveUsageWatch?.();
          this.stopLiveUsageWatch = undefined;
          this.liveUsageEmitted.clear();
        }
      };
    },
  };
  private readonly defaultProfile: AgentProfile = { id: 'default', name: 'Cursor CLI', isDefault: true, config: {} };
  /** One per conversation somebody is subscribed to; its jobs also reach clients as background-task activities. */
  private readonly activities = new Map<string, { tracker: CursorActivities; listeners: Set<AgentReport> }>();
  /** Readers of a conversation's transcript into the journal (`transcriptSource`), told what the hooks report. */
  private readonly transcriptSignals = new Map<string, Set<CursorTranscriptSignals>>();

  constructor(private readonly options: CursorBackendOptions) {}

  /**
   * The runtime, built from the first launch profile resolved from a profile config (its stored settings, key and
   * the executable the server was started with) and kept until the plugin is turned off: a later change of those
   * settings reaches a new activation, as it always has.
   */
  private parts(host: AgentHost, profile: AgentProfile): CursorParts {
    if (this.built) return this.built;
    // A call that outlived the activation must not build a second runtime (a sweep, a hook server) that nothing would close.
    if (this.shutdown) throw new AppError('AGENT_BACKEND_CLOSED', 'Cursor was turned off', 409);
    const launch = cursorLaunchProfileOf(profile.config);
    const port = cursorPort(host);
    const live = new CursorLive(join(this.options.stateDir, 'cursor-live'));
    const native = new NativeService(port, { configDir: launch.configDir, cliPath: launch.executable, profile: launch, live });
    const runtime = new NativeRuntimeManager({ port, cliPath: launch.executable, configDir: launch.configDir, profile: launch, live, prepareModel: (model, project) => native.prepareModel(model, project) });
    const steering = new CursorSteerBridge(host, port, native, this.options.stateDir, launch);
    this.usageHost = host;
    this.stopUsageChanges = host.stats.subscribeObservations?.(() => {
      for (const listener of this.usageListeners) { try { listener(); } catch { /* consumers are independent */ } }
    });
    const usage = new CursorUsageIngest(host, live, launch.configDir);
    steering.onPreCompact = (sessionId, info) => {
      this.activityEntry(sessionId, native).tracker.compactionStarted(info);
      for (const listener of this.transcriptSignals.get(sessionId) ?? []) listener.preCompact(info);
    };
    steering.onTurnEnded = (sessionId) => {
      this.activities.get(sessionId)?.tracker.settleLiveCompaction();
      for (const listener of this.transcriptSignals.get(sessionId) ?? []) listener.changed();
    };
    // A gateway's startup queries are answered locally; the first launch waits for the front, a failed one is skipped.
    const apiCache = cursorApiFrontable(launch, true) ? new CursorApiCache(launch.apiEndpoint!, join(this.options.stateDir, 'cursor-api-front.json')) : undefined;
    const front = apiCache?.start().then(url => { if (!this.shutdown) setCursorApiFront(launch, url); }, error => {
      console.warn(`[riffet] Cursor startup cache unavailable; launches use the endpoint directly: ${error instanceof Error ? error.message : String(error)}`);
    });
    runtime.useLaunchPlugin(async session => { await front; return steering.launchArgs(session); });
    this.built = { profile: launch, port, native, runtime, steering, configs: new CursorProjectConfigs(this.options.stateDir, launch.configDir), titles: new ResumeTitleWatcher({ port }), live, receipts: new CursorLiveReceipts(live), usage, ...(apiCache ? { apiCache } : {}) };
    this.ensureLiveUsageWatch();
    return this.built;
  }

  private ensureLiveUsageWatch(): void {
    if (this.shutdown || !this.built || !this.liveUsageListeners.size || this.stopLiveUsageWatch) return;
    this.stopLiveUsageWatch = this.built.live.watch(chatId => this.emitLiveUsage(chatId));
  }

  private emitLiveUsage(chatId: string): void {
    if (this.shutdown || !this.liveUsageListeners.size) return;
    const step = this.built?.live.read(chatId);
    if (!step?.parts.length) return;
    const outputTokens = estimatedTokens(step.parts.map(part => part.text).join(''));
    if (outputTokens <= 0) return;
    const key = `${chatId}\0${step.step}`;
    const previous = this.liveUsageEmitted.get(key);
    if (previous && previous.outputTokens === outputTokens && previous.sealed === step.sealed) return;
    this.liveUsageEmitted.delete(key);
    this.liveUsageEmitted.set(key, { outputTokens, sealed: step.sealed });
    while (this.liveUsageEmitted.size > 256) this.liveUsageEmitted.delete(this.liveUsageEmitted.keys().next().value!);
    const sessions = this.usageHost?.view.sessions() ?? [];
    const model = step.requestedModel
      ?? sessions.find(item => item.nativeSessionId === chatId && !item.archivedAt)?.model
      ?? sessions.find(item => item.nativeSessionId === chatId)?.model;
    const progress: CursorLiveUsageProgress = {
      nativeSessionId: chatId,
      nativeTurnId: step.run ?? step.turn,
      stepId: step.step,
      at: Date.now(),
      ...(model ? { model } : {}),
      outputTokens,
      sealed: step.sealed,
    };
    for (const listener of [...this.liveUsageListeners]) {
      try { listener(progress); } catch { /* consumers are independent */ }
    }
  }

  profiles(): AgentProfile[] { return [this.defaultProfile]; }

  /**
   * Builds the runtime as soon as the plugin is registered, as the server did at its start before Cursor was a plugin: the
   * sweep that corrects sessions left running by an earlier process must not wait for the first request to arrive. Warm
   * CLIs an earlier process left are the host's to end (`TerminalService.endPreviousWarmupsOnce`).
   */
  start(host: AgentHost, profile: AgentProfile): void { this.parts(host, profile); }

  validateProfileConfig(config: Record<string, unknown>): void { cursorLaunchProfileOf(config); }

  /** What the profile list shows of a profile that stores nothing: the values the launch uses. */
  describeProfile(profile: AgentProfile) { return describeCursorProfile(profile.config, this.built?.profile); }

  extensionLayout() { return CURSOR_EXTENSION_LAYOUT; }

  async prewarm(host: AgentHost, project: AgentProjectView, profile: AgentProfile, request: AgentPrewarmRequest): Promise<AgentPrewarmResult> {
    // The warm CLI is launched from the default launch profile only.
    if (profile.id !== this.defaultProfile.id) return { state: 'skipped', reason: 'profile_unsupported' };
    if (request.approval !== undefined && !CURSOR_PERMISSIONS.some(item => item.id === request.approval)) throw new AppError('INVALID_APPROVAL_MODE', 'Choose a known approval mode');
    const { claimId, renewOnly, ...config } = request;
    return this.parts(host, profile).runtime.prewarm(project.id, config, { ...(claimId ? { claimId } : {}), ...(renewOnly ? { renewOnly } : {}) });
  }

  async releasePrewarm(_host: AgentHost, claimId: string): Promise<void> {
    await this.built?.runtime.releasePrewarm(claimId);
  }

  loginLaunch(host: AgentHost, project: AgentProjectView, profile: AgentProfile): AgentLaunchSpec {
    return cursorLaunchSpec(this.parts(host, profile).profile, ['login'], { NO_OPEN_BROWSER: '1' }, project.cwd, { title: 'Cursor Login' });
  }

  capabilityReport(host: AgentHost, profile: AgentProfile) {
    return cursorCapabilityReport(this.parts(host, profile).profile);
  }

  runCommand(host: AgentHost, profile: AgentProfile, request: AgentCommandRequest) {
    return runCursorOperation(this.parts(host, profile).profile, request.operation, request.args, request.cwd);
  }

  runtimeStats(): Record<string, unknown> { return { ...(this.built?.runtime.stats() ?? emptyRuntimeStats()) }; }

  async capabilities(host: AgentHost, profile: AgentProfile): Promise<AgentCapabilities> {
    let steers = false;
    try { steers = await probeCursorHookSteer(this.parts(host, profile).profile); }
    catch { /* a profile the CLI cannot launch with has no steering; `available` says why */ }
    return {
      modes: CURSOR_MODES, permissions: CURSOR_PERMISSIONS,
      interactionTransport: 'both', supportsResume: true, supportsInterrupt: true,
      supportsHistory: true, supportsModelSelection: true, supportsModeSelection: true,
      supportsPermissionSelection: true, supportsTerminal: true, requiresLiveTerminal: true, supportsPrewarm: true,
      supportsSteer: steers,
      // cursor-agent takes a positional [prompt...], so a brand-new session's first message can
      // ride on the launch argv instead of being pasted into a TUI that is still booting.
      supportsInitialPromptArgs: true,
      slashCommands: CURSOR_COMMANDS,
    };
  }

  /**
   * cursor-agent has no listing interface, so its skill directories are read the way it reads
   * them: project roots before user roots, the bundled `skills-cursor` last. Custom commands come
   * from `.cursor/commands`. Text after `/` is forwarded to the CLI verbatim either way.
   */
  async slashItems(_host: AgentHost, project: AgentProjectView | undefined): Promise<NativeSlashItem[]> {
    const home = homedir();
    const skillDirs = ['.cursor/skills', '.agents/skills', '.claude/skills', '.codex/skills'];
    const [skills, commands] = await Promise.all([
      scanSkillRoots([
        ...(project ? skillDirs.map(dir => join(project.cwd, dir)) : []),
        ...skillDirs.map(dir => join(home, dir)),
        join(home, '.cursor/skills-cursor'),
      ]),
      scanCommandRoots([...(project ? [join(project.cwd, '.cursor/commands')] : []), join(home, '.cursor/commands')]),
    ]);
    return [...commands, ...skills];
  }

  async available(host: AgentHost, profile: AgentProfile): Promise<AgentAvailability> {
    try {
      const launch = this.parts(host, profile).profile;
      const [result, needsLogin] = await Promise.all([
        runCursor(launch, ['--version'], { cwd: process.cwd(), timeoutMs: 8000, maxOutputBytes: 16 * 1024 }),
        cursorNeedsLogin(launch).catch(() => false),
      ]);
      return result.code === 0
        ? { available: true, version: result.stdout || result.stderr, ...(needsLogin ? { needsLogin: true } : {}) }
        : { available: false, reason: `cursor-agent exited with code ${result.code ?? 'unknown'}` };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : 'cursor-agent is unavailable' };
    }
  }

  async open(host: AgentHost, context: AgentContext, options: AgentOpenOptions = {}) {
    const { native, runtime, port, steering, titles, receipts } = this.parts(host, context.profile);
    const { session } = context;
    steering.bind(session.id);
    const prompt = options.initialPrompt;
    let fencedAt: number | undefined;
    const fence = async () => { await host.beforeSpawn(session.id); fencedAt = Date.now(); };
    const { terminal, promptPending } = await runtime.ensure(session, {
      ...(prompt ? { initialPrompt: prompt } : {}),
      beforeSpawn: fence,
    });
    if (prompt && promptPending) {
      // A warm CLI took the conversation: the prompt is submitted to it like any later one.
      try { await native.deliver(port.getSession(session.id), prompt, fence); }
      catch (error) {
        // Nothing was written, so the message can go again; it is pasted into the CLI now running.
        if (fencedAt === undefined) throw new AppError('NATIVE_LAUNCH_ABORTED', error instanceof Error ? error.message : 'The CLI could not take the message yet', 409, { reason: error instanceof AppError ? error.code : undefined });
        throw error;
      }
    }
    // The store echoes a first prompt only when the CLI has written its step; the live tap sees it go out.
    if (prompt && fencedAt !== undefined) await this.expectFirstReceipt(host, receipts, port, session.id, prompt, fencedAt);
    const current = port.getSession(session.id);
    if (session.resumePicker && !session.nativeSessionId) titles.watch({ sessionId: session.id, terminalId: terminal.id, projectId: session.projectId });
    return { terminalId: terminal.id, ...(current.nativeSessionId ? { nativeSessionId: current.nativeSessionId } : {}), status: native.status(session.id) };
  }

  private async expectFirstReceipt(host: AgentHost, receipts: CursorLiveReceipts, port: CursorPort, sessionId: string, text: string, sentAt: number): Promise<void> {
    const chatId = port.getSession(sessionId).nativeSessionId;
    if (!chatId) return;
    const runs = await host.runs.find(sessionId, { unfinished: true }).catch(() => []);
    const run = runs.find(item => item.delivery === 'dispatching' && item.intent !== 'steer');
    if (run) receipts.expect({ host, sessionId, chatId, runId: run.id, commandId: run.commandId, text, sentAt });
  }

  async send(host: AgentHost, request: AgentSendRequest): Promise<void> {
    const { text } = await materializeNativeInput(attachments(host), request.input);
    const { native, port, receipts } = this.parts(host, request.context.profile);
    const session = port.getSession(request.context.session.id);
    const deliver = request.now ? native.deliverNow.bind(native) : native.deliver.bind(native);
    const sentAt = Date.now();
    await deliver(session, text, async ({ terminalId, epoch, chatId }) => {
      const nativeSessionId = chatId ?? session.nativeSessionId;
      if (nativeSessionId) await host.setNativeSessionId(session.id, nativeSessionId);
      await host.commitDispatchFence(request.runId, {
        ...(nativeSessionId ? { nativeSessionId } : {}),
        terminal: { id: terminalId, epoch },
        renderedText: text,
        resolvedConfig: { model: session.model, mode: session.mode, approval: session.approval },
      });
      port.noteInputSent(request.runId);
    });
    // The echo in the store can be a whole answer away; the CLI taking the prompt is not.
    const chatId = port.getSession(session.id).nativeSessionId;
    if (chatId) receipts.expect({ host, sessionId: session.id, chatId, runId: request.runId, commandId: request.commandId, text, sentAt });
  }

  /** Strict V1 context accepts plain text; CLI commands/skills and attachments need a normal turn. */
  async steer(host: AgentHost, request: AgentSendRequest & { target: NativeTurnTarget }) {
    const { steering, profile } = this.parts(host, request.context.profile);
    if (!await probeCursorHookSteer(profile)) throw new AppError('STEER_REJECTED', 'This Cursor CLI version has not been verified for safe steering', 409);
    if (request.input.attachmentIds.length) throw new AppError('STEER_REJECTED', 'Cursor steering does not support attachments; send a text steer message', 409);
    const commands = slashTokens(request.input.text);
    const { text } = await materializeNativeInput(attachments(host), request.input);
    if (!text.trim() || text.length > 6000 || commands.length) {
      throw new AppError('STEER_REJECTED', 'Cursor steering supports at most 6000 characters of text; use a new message for CLI commands and skills', 409);
    }
    return steering.enqueue(request, text);
  }

  async interrupt(host: AgentHost, context: AgentContext, options?: AgentStopOptions): Promise<void> {
    const { native, steering, port } = this.parts(host, context.profile);
    const sessionId = context.session.id;
    const current = port.getSession(sessionId);
    const target = steering.activeTurn(current);
    steering.rejectPending(sessionId, 'Current task is stopping');
    await native.interrupt(current, {
      ...(options?.clearPrompt !== undefined ? { clearPrompt: options.clearPrompt } : {}),
      ...(options?.expectedStop ? { beforeWrite: allowEnded => host.checkStopTarget(sessionId, allowEnded) } : {}),
    });
    const remaining = steering.activeTurn(port.getSession(sessionId));
    if (target && remaining?.nativeSessionId === target.nativeSessionId && remaining.turnId === target.turnId) {
      steering.reject(sessionId, 'Current task was stopped');
    }
  }

  respond(host: AgentHost, context: AgentContext, response: NativeInteractionResponse) {
    const { native, port } = this.parts(host, context.profile);
    return native.respondInteraction(port.getSession(context.session.id), response);
  }

  async configure(host: AgentHost, context: AgentContext, patch: AgentConfigurePatch) {
    const { native, port } = this.parts(host, context.profile);
    // Serialize with start/send/interrupt like every other backend: a configure that decides the CLI
    // is not running and only records the intent races a concurrent start that is already launching.
    return await host.withSessionLock(context.session.id, async () => {
      const next = await native.configure(port.getSession(context.session.id), patch);
      return { model: next.model, mode: next.mode, approval: next.approval, nativeSessionId: next.nativeSessionId, terminalId: next.terminalId };
    });
  }

  async listModels(host: AgentHost, query: AgentModelQuery) {
    const { native } = this.parts(host, query.profile);
    const context = { cwd: await queryDirectory(query.project, { backendId: this.id, id: query.profile.id }) };
    const variants = await native.models(context);
    if (!variants.length) {
      const reason = native.modelListError(context);
      throw new AppError('MODEL_CATALOG_UNAVAILABLE', reason ?? 'The Cursor CLI model catalog is unavailable; try again shortly', 503, reason ? { reason } : undefined);
    }
    return nativeModelCatalogFromVariants(variants);
  }

  readHistory(host: AgentHost, context: AgentContext, options?: AgentHistoryOptions) {
    return readCursorShare(context, this.parts(host, context.profile).profile.configDir, options);
  }

  async interaction(host: AgentHost, context: AgentContext) {
    const { native, port } = this.parts(host, context.profile);
    return (await native.interaction(port.getSession(context.session.id))) ?? undefined;
  }

  status(host: AgentHost, context: AgentContext) {
    const status = this.parts(host, context.profile).native.status(context.session.id);
    return this.activities.get(context.session.id)?.tracker.status(status) ?? status;
  }

  /** One conversation's activity tracker and its live listeners, shared by subscribers and the compaction hook. */
  private activityEntry(sessionId: string, native: NativeService) {
    let entry = this.activities.get(sessionId);
    if (!entry) {
      const tracker = new CursorActivities();
      const listeners = new Set<AgentReport>();
      tracker.onChange = () => {
        const status = tracker.status(native.status(sessionId));
        for (const target of listeners) target({ type: 'status', status });
      };
      entry = { tracker, listeners };
      this.activities.set(sessionId, entry);
    }
    return entry;
  }

  observe(host: AgentHost, context: AgentContext, report: AgentReport) {
    const { native, steering } = this.parts(host, context.profile);
    const sessionId = context.session.id;
    steering.bind(sessionId);
    void steering.launchArgs().catch(() => undefined);
    const { tracker, listeners } = this.activityEntry(sessionId, native);
    listeners.add(report);
    // Every subscriber sees the same tracker, so a job frame is taken in once and announced to all of them.
    const stop = native.subscribe(sessionId, message => {
      tracker.observe(message);
      const control = controlOf(message, tracker);
      if (control) report(control);
    });
    return () => {
      stop();
      listeners.delete(report);
      if (!listeners.size && this.activities.get(sessionId)?.tracker === tracker) this.activities.delete(sessionId);
    };
  }

  /**
   * The conversation's chat store, read into the journal from each lane's cursor (sync v3). It reads
   * whichever chat the session follows now, and wakes on what the service already watches: its own
   * check of the store (the frames it emits) and the CLI's hooks.
   */
  transcriptSource(host: AgentHost, context: AgentContext): AgentTranscriptSource {
    const { native, profile: launch, port, live } = this.parts(host, context.profile);
    const sessionId = context.session.id;
    return new CursorTranscriptSource({
      sessionId,
      live,
      chatsDir: () => workspaceChatsDir(launch.configDir, port.getProject(port.getSession(sessionId).projectId).cwd),
      chatId: () => port.getSession(sessionId).nativeSessionId,
      ...(host.workspaceChanges ? { observedChanges: (toolCallId: string) => host.workspaceChanges?.changes(sessionId, toolCallId) } : {}),
      signals: listener => this.followTranscript(native, sessionId, listener),
    });
  }

  private followTranscript(native: NativeService, sessionId: string, listener: CursorTranscriptSignals): () => void {
    let listeners = this.transcriptSignals.get(sessionId);
    if (!listeners) this.transcriptSignals.set(sessionId, listeners = new Set());
    listeners.add(listener);
    let stop = () => {};
    try {
      stop = native.subscribe(sessionId, message => {
        if (message.type === 'subagent') listener.subagent(message.toolCallId, message.agentId);
        if (message.type === 'reset' || message.type === 'append' || message.type === 'draft' || message.type === 'subagent') listener.changed();
      });
    } catch { /* not a conversation the service follows: the hooks still wake it */ }
    return () => {
      stop();
      listeners.delete(listener);
      if (!listeners.size && this.transcriptSignals.get(sessionId) === listeners) this.transcriptSignals.delete(sessionId);
    };
  }

  /** The conversation is closed or no longer watched here: its observation state goes; the CLI is the terminal service's. */
  stop(_host: AgentHost, sessionId: string): void { this.activities.delete(sessionId); this.built?.steering.dispose(sessionId); }

  detach(host: AgentHost, sessionId: string): void { this.stop(host, sessionId); }

  /**
   * Shuts the runtime down in the order it was wired: the hook server, the unused warm processes, then the
   * observation of conversations. A session's CLI keeps running.
   */
  close(): Promise<void> {
    return this.shutdown ??= (async () => {
      this.stopUsageChanges?.();
      this.stopLiveUsageWatch?.();
      this.stopLiveUsageWatch = undefined;
      this.usageListeners.clear();
      this.liveUsageListeners.clear();
      this.liveUsageEmitted.clear();
      this.usageHost = undefined;
      const built = this.built;
      if (!built) return;
      await built.usage.close();
      await built.steering.close();
      await built.runtime.close();
      built.native.closeAll();
      built.titles.disposeAll();
      built.receipts.close();
      built.live.close();
      setCursorApiFront(built.profile, undefined);
      await built.apiCache?.close();
    })();
  }
}

/** The attachment reader the kit's input materializer wants, over the host's. */
const attachments = (host: AgentHost) => ({
  readAttachment: async (id: string) => {
    const { attachment, data } = await host.readAttachment(id);
    return { attachment, data: Buffer.from(data) };
  },
});

/** What the control path takes of a watch message: the transcript itself is read into the journal instead. */
function controlOf(message: WatchMessage, tracker: CursorActivities): AgentControlMessage | undefined {
  switch (message.type) {
    case 'status': return { type: 'status', status: tracker.status(message.status) };
    case 'subagent': return { type: 'subagent', toolCallId: message.toolCallId, agentId: message.agentId, ...(message.running !== undefined ? { running: message.running } : {}) };
    case 'session': return { type: 'session' };
    case 'reset': case 'append': case 'draft': return undefined;
    default: return message;
  }
}
