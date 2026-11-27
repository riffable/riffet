import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { samePromptText, type NativeInteractionResponse, type NativeSlashItem, type NativeTurnTarget } from '@contracts';
import { AppError, estimatedTokens, isCliMissing, materializeNativeInput, queryDirectory, redactSensitiveText, resolveCliExecutable, scanCommandRoots, scanSkillRoots, slashTokens } from '@riffet/plugin-api/kit';
import {
  AGENT_PROTOCOL_VERSION, type AgentAvailability, type AgentBackend, type AgentCapabilities, type AgentCommandRequest, type AgentConfigurePatch, type AgentContext,
  type AgentControlMessage, type AgentDelivery, type AgentDiscussionRequest, type AgentHistoryOptions, type AgentHost, type AgentLaunchSpec, type AgentModelQuery, type AgentOpenOptions, type AgentPrewarmRequest,
  type AgentPrewarmResult, type AgentProfile, type AgentProjectConfigs, type AgentProjectView, type AgentReport, type AgentRunRef, type AgentSendRequest, type AgentSessionView, type AgentStopOptions,
  type AgentTerminalBehaviour, type AgentTraits, type AgentTranscriptSource,
} from '@riffet/plugin-api/experimental/agent';
import { CURSOR_AGENT_BUSY_PATTERN, CURSOR_AGENT_READY_PATTERN, CURSOR_CLI_VERSIONS, cursorAgentStartupError, cursorPromptBarEmpty } from './cli-adapter.js';
import { CURSOR_LAUNCH_ENV, cursorApiFrontable, cursorConfigDirectory, cursorLaunchProfileOf, setCursorApiFront, cursorLaunchSpec, redactCursorOutput, runCursor, withCursorConfigDir, type CursorLaunchProfile } from './cli-driver.js';
import { cursorCapabilityReport, cursorNeedsLogin, describeCursorProfile, runCursorOperation } from './config.js';
import { cursorPort, type CursorPort } from './host-port.js';
import { CursorActivities } from './backend/activity.js';
import { streamCursorDiscussion } from './backend/discussion.js';
import { CURSOR_EXTENSION_LAYOUT } from './backend/extensions.js';
import { probeCursorHookSteer } from './backend/launch-plugin.js';
import { CursorLiveReceipts } from './backend/live-receipts.js';
import { CursorProjectConfigs } from './backend/project-configs.js';
import { CURSOR_DEFAULT_PROFILE_ID, cursorProfileConfig, cursorProfileDir, prepareCursorProfileDir } from './backend/profiles.js';
import { readCursorShare } from './backend/share-read.js';
import { cursorProjectConfigDir, cursorStandingDir, isStandingProject, prepareStandingLaunch, withoutStandingMemberContext, wrapStandingPrompt } from './backend/standing.js';
import { CursorSteerBridge } from './backend/steer.js';
import { CursorRiffetTools } from './backend/riffet-tools.js';
import { CursorApiCache } from './backend/api-cache.js';
import { CursorTranscriptSource, type CursorTranscriptSignals } from './backend/transcript-source.js';
import { CursorUsageIngest } from './backend/usage.js';
import { ChatReader, chatStorePath, userQuery, workspaceChatsDir } from './native/chat-store.js';
import { CursorLive, cursorPromptAlias } from './native/live.js';
import { nativeModelCatalogFromVariants } from './native/model-catalog.js';
import { emptyRuntimeStats, NativeRuntimeManager, type NativeLaunchExtras } from './native/runtime.js';
import { parseScreen, promptSettled, turnControls } from './native/screen.js';
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
/** Mirrors `apps/server/src/terminal/launch-args.ts#LAUNCH_ARG_MAX_BYTES`; longer prompts go through `native.deliver` (tmux paste-buffer). */
const LAUNCH_ARG_MAX_BYTES = 8 * 1024;
const fitsLaunchArg = (text: string): boolean => !text.includes('\0') && Buffer.byteLength(text, 'utf8') <= LAUNCH_ARG_MAX_BYTES;

export interface CursorBackendOptions {
  /** Where the hook bridge's plugin (`cursor-hook`) and the project-config backups (`config-backups`) are kept: Riffet's state directory, as they were before this was a plugin (see `legacyStateRoot`). */
  stateDir: string;
  /** The Cursor profiles as configured now, `config` included (`PluginHost.agentProfiles`): how code that cannot await finds a conversation's profile. */
  profiles?(): AgentProfile[];
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

/**
 * The pieces built from the first resolved launch profile; one set for the activation. `profile` is that launch
 * profile: what the warm CLIs, the startup-query front and the hook probe use. A conversation on another
 * profile launches with its own (`CursorBackend.sessionLaunch`).
 */
interface CursorParts {
  profile: CursorLaunchProfile;
  port: CursorPort;
  native: NativeService;
  runtime: NativeRuntimeManager;
  steering: CursorSteerBridge;
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
  // Riffet's tools reach each CLI through a plugin directory of their own (`backend/riffet-tools.ts`).
  riffetTools: true,
  startsNewTopic: true,
  settlesSlashOnSubmit: true,
  untaggedEcho: true,
  reportsTurnOutcome: true,
  survivesRestart: true,
  ownsSessionObservation: true,
  resumesByNativeId: true,
  terminalName: 'Cursor',
};

const MAX_PREVIOUS_NATIVE_SESSIONS = 8;

/**
 * How the terminal host reads cursor-agent's panes: its prompt, or a turn in flight, means it
 * started; before that, its own error text explains an exit. The key is redacted out of that text.
 */
export const cursorTerminalBehaviour = (profile: CursorLaunchProfile | (() => CursorLaunchProfile | string | Array<CursorLaunchProfile | string>)): AgentTerminalBehaviour => ({
  title: 'Cursor Agent',
  ready: text => CURSOR_AGENT_READY_PATTERN.test(text) || CURSOR_AGENT_BUSY_PATTERN.test(text),
  startupError: text => {
    const resolved = typeof profile === 'function' ? profile() : profile;
    return cursorAgentStartupError((Array.isArray(resolved) ? resolved : [resolved]).reduce<string>((output, item) => redactCursorOutput(item, output), text));
  },
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
  readonly launchEnv = CURSOR_LAUNCH_ENV;
  /** The keys of every launch profile resolved so far are redacted; before any, no Cursor terminal of this process has been launched. */
  readonly terminal: AgentTerminalBehaviour = cursorTerminalBehaviour(() => this.launches.size ? [...this.launches.values()].map(item => item.launch) : 'cursor-agent');
  readonly projectConfigs: AgentProjectConfigs = {
    list: (host, project, profile) => this.configsFor(host, profile).list(project),
    read: (host, project, profile, id) => this.configsFor(host, profile).read(project, id),
    write: (host, project, profile, id, content, expectedHash) => this.configsFor(host, profile).write(project, id, content, expectedHash),
    create: (host, project, profile, input) => this.configsFor(host, profile).create(project, input),
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
  private readonly defaultProfile: AgentProfile = { id: CURSOR_DEFAULT_PROFILE_ID, name: 'Cursor CLI', isDefault: true, config: {} };
  /** The launch profile of each Riffet profile seen, rebuilt when its config changes; the base one stays the same object while its config does. */
  private readonly launches = new Map<string, { config: string; launch: CursorLaunchProfile }>();
  /** The built-in profile's config as last seen: the CLI management other profiles take (`cursorProfileConfig`). */
  private builtinConfig?: Record<string, unknown>;
  /** The default profile's id as last seen: where a conversation that recorded none runs. */
  private defaultProfileId?: string;
  /** Project and user configuration documents, by the configuration directory they edit. */
  private readonly configs = new Map<string, CursorProjectConfigs>();
  /** One per conversation somebody is subscribed to; its jobs also reach clients as background-task activities. */
  private readonly activities = new Map<string, { tracker: CursorActivities; listeners: Set<AgentReport> }>();
  /** Readers of a conversation's transcript into the journal (`transcriptSource`), told what the hooks report. */
  private readonly transcriptSignals = new Map<string, Set<CursorTranscriptSignals>>();
  /** Standing chat ids that already received their `<riffet-member>` seed prompt; bounded LRU. */
  private readonly seededStandingChats = new Set<string>();
  /** Standing sessions that compacted and should re-seed `<riffet-member>` on their next turn; bounded LRU. */
  private readonly reseedStandingSessions = new Set<string>();

  constructor(private readonly options: CursorBackendOptions) {}

  private builtin(): Record<string, unknown> | undefined {
    return this.builtinConfig ?? this.options.profiles?.().find(item => item.id === CURSOR_DEFAULT_PROFILE_ID)?.config;
  }

  /**
   * The launch profile `profile` resolves to as configured now (`backend/profiles.ts`). The same object comes back
   * while its config is unchanged, so what is keyed by it (the startup-query front, the hook probe) carries over.
   * A gateway profile's own directory is created here, before anything runs the CLI with it.
   */
  private launchFor(profile: AgentProfile): CursorLaunchProfile {
    if (profile.id === CURSOR_DEFAULT_PROFILE_ID) this.builtinConfig = profile.config;
    if (profile.isDefault) this.defaultProfileId = profile.id;
    const config = cursorProfileConfig(profile, this.builtin(), this.options.stateDir);
    const launch = cursorLaunchProfileOf(config);
    // What the launch is made of; a profile's name, default model or default flag is not.
    const key = JSON.stringify([launch.identityKey, typeof config.apiKey === 'string' ? config.apiKey : null]);
    const cached = this.launches.get(profile.id);
    if (cached?.config === key) return cached.launch;
    if (profile.id !== CURSOR_DEFAULT_PROFILE_ID && launch.configDir === cursorProfileDir(this.options.stateDir, profile.id)) {
      prepareCursorProfileDir(launch.configDir, cursorConfigDirectory('cursor-agent'));
    }
    this.launches.set(profile.id, { config: key, launch });
    return launch;
  }

  /**
   * The launch profile of the conversation's own profile, for code that cannot await: the one seen last, else the
   * one configured now. A conversation whose profile was removed keeps reading the directory it wrote.
   */
  private sessionLaunch(session: Pick<AgentSessionView, 'backendProfileId'> | undefined, base: CursorLaunchProfile): CursorLaunchProfile {
    // A conversation that never recorded a profile runs on the default one, as the core resolves it.
    const id = session?.backendProfileId ?? this.defaultProfileId ?? this.options.profiles?.().find(item => item.isDefault)?.id ?? CURSOR_DEFAULT_PROFILE_ID;
    const seen = this.launches.get(id)?.launch;
    if (seen) return seen;
    const profile = this.options.profiles?.().find(item => item.id === id);
    if (profile) {
      try { return this.launchFor(profile); } catch { return base; }
    }
    const dir = cursorProfileDir(this.options.stateDir, id);
    return id !== CURSOR_DEFAULT_PROFILE_ID && existsSync(dir) ? withCursorConfigDir(base, dir) : base;
  }

  private configsFor(host: AgentHost, profile: AgentProfile): CursorProjectConfigs {
    this.parts(host, profile);
    const configDir = this.launchFor(profile).configDir;
    let configs = this.configs.get(configDir);
    if (!configs) this.configs.set(configDir, configs = new CursorProjectConfigs(this.options.stateDir, configDir));
    return configs;
  }

  private rememberSeededStandingChat(chatId: string | undefined): void {
    if (!chatId) return;
    this.seededStandingChats.delete(chatId);
    this.seededStandingChats.add(chatId);
    while (this.seededStandingChats.size > 256) this.seededStandingChats.delete(this.seededStandingChats.keys().next().value!);
  }

  private markStandingReseed(sessionId: string): void {
    this.reseedStandingSessions.delete(sessionId);
    this.reseedStandingSessions.add(sessionId);
    while (this.reseedStandingSessions.size > 256) this.reseedStandingSessions.delete(this.reseedStandingSessions.keys().next().value!);
  }

  private chatHasUserTurns(cwd: string, chatId: string): boolean {
    const reader = new ChatReader(chatStorePath(cursorStandingDir(this.options.stateDir), cwd, chatId));
    try {
      const snap = reader.snapshot();
      if (!snap) return false;
      for (const id of snap.messageIds) {
        const message = reader.message(id);
        if (message?.role === 'user' && userQuery(message)) return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      reader.close();
    }
  }

  /**
   * Cursor's interactive TUI skips `sessionStart` when launched with `--resume <chatId>` and does not run
   * `--plugin-dir` hooks on `beforeSubmitPrompt`. For standing members, seed `<riffet-member>` instructions on
   * the first turn of each fresh chat (and after compaction); `userQuery()` strips the tag from transcripts.
   */
  private maybeWrapStandingPrompt(
    host: AgentHost,
    session: AgentSessionView,
    project: AgentProjectView,
    text: string,
  ): { text: string; seeded: boolean } {
    const standing = host.standing?.launch(project, session);
    if (!standing) return { text, seeded: false };
    const chatId = session.nativeSessionId;
    const forceReseed = this.reseedStandingSessions.has(session.id);
    const alreadySeeded = !forceReseed && Boolean(chatId && (this.seededStandingChats.has(chatId) || this.chatHasUserTurns(project.cwd, chatId)));
    if (alreadySeeded) {
      if (chatId) this.rememberSeededStandingChat(chatId);
      return { text, seeded: false };
    }
    return { text: wrapStandingPrompt(project.cwd, standing, text), seeded: true };
  }

  /**
   * The runtime, built from the first launch profile resolved from a profile config (its stored settings, key and
   * the executable the server was started with) and kept until the plugin is turned off: a later change of those
   * settings reaches a new activation, as it always has.
   */
  private parts(host: AgentHost, profile: AgentProfile): CursorParts {
    if (this.built) return this.built;
    // A call that outlived the activation must not build a second runtime (a sweep, a hook server) that nothing would close.
    if (this.shutdown) throw new AppError('AGENT_BACKEND_CLOSED', 'Cursor was turned off', 409);
    const launch = this.launchFor(profile);
    const port = cursorPort(host);
    const live = new CursorLive(join(this.options.stateDir, 'cursor-live'));
    const launchOf = (session: AgentSessionView | undefined) => this.sessionLaunch(session, launch);
    const configDirFor = (project: AgentProjectView, session?: AgentSessionView) => cursorProjectConfigDir(launchOf(session).configDir, this.options.stateDir, project, session);
    const tools = new CursorRiffetTools(host, this.options.stateDir, () => probeCursorHookSteer(launch));
    // A gateway's startup queries are answered locally; the first launch waits for the front, a failed one is skipped.
    const apiCache = cursorApiFrontable(launch, true) ? new CursorApiCache(launch.apiEndpoint!, join(this.options.stateDir, 'cursor-api-front.json')) : undefined;
    const front = apiCache?.start().then(url => { if (!this.shutdown) setCursorApiFront(launch, url); }, error => {
      console.warn(`[riffet] Cursor startup cache unavailable; launches use the endpoint directly: ${error instanceof Error ? error.message : String(error)}`);
    });
    let steering!: CursorSteerBridge;
    /** The conversation's own launch profile, as configured when it starts: read again rather than taken from what was seen last. */
    const ownLaunch = async (session: AgentSessionView) => {
      try { return this.launchFor(await host.profile(session.id)); } catch { return launchOf(session); }
    };
    // A conversation on another profile than the warm CLIs' starts cold, as a standing one does.
    const sessionExtras = async (session: AgentSessionView, project: AgentProjectView): Promise<NativeLaunchExtras | undefined> => {
      const own = await ownLaunch(session);
      const standing = host.standing?.launch(project, session);
      if (!standing) return own === launch ? undefined : { profile: own, skipWarm: true as const };
      await front;
      const prepared = prepareStandingLaunch({
        baseProfile: own,
        stateDir: this.options.stateDir,
        cwd: project.cwd,
        launch: standing,
      });
      return { ...prepared, skipWarm: true as const };
    };
    const native = new NativeService(port, {
      configDir: launch.configDir,
      cliPath: launch.executable,
      profile: launch,
      live,
      configDirFor,
      profileFor: launchOf,
      restartLaunch: async (session, project) => {
        await front;
        const [pluginArgs, toolsLaunch, standing] = await Promise.all([
          steering.launchArgs(session).catch(() => []),
          tools.forSession(session.id).catch(() => undefined),
          sessionExtras(session, project).catch(() => undefined),
        ]);
        const args = [...pluginArgs, ...standing?.args ?? [], ...toolsLaunch?.args ?? []];
        const env = standing?.env;
        const paneEnv = toolsLaunch?.env;
        if (!standing && !args.length && !paneEnv) return undefined;
        return {
          ...(standing ? { profile: standing.profile } : {}),
          ...(args.length ? { args } : {}),
          ...(env ? { env } : {}),
          ...(paneEnv ? { paneEnv } : {}),
        };
      },
    });
    const runtime = new NativeRuntimeManager({ port, cliPath: launch.executable, configDir: launch.configDir, profile: launch, live, tools, launchExtras: sessionExtras, prepareModel: (model, project, session) => native.prepareModel(model, project, session) });
    steering = new CursorSteerBridge(host, port, native, this.options.stateDir, launch, launchOf);
    this.usageHost = host;
    this.stopUsageChanges = host.stats.subscribeObservations?.(() => {
      for (const listener of this.usageListeners) { try { listener(); } catch { /* consumers are independent */ } }
    });
    const usage = new CursorUsageIngest(host, live, launch.configDir, configDirFor);
    steering.onPreCompact = (sessionId, info) => {
      this.markStandingReseed(sessionId);
      this.activityEntry(sessionId, native).tracker.compactionStarted(info);
      for (const listener of this.transcriptSignals.get(sessionId) ?? []) listener.preCompact(info);
    };
    steering.onTurnEnded = (sessionId) => {
      this.activities.get(sessionId)?.tracker.settleLiveCompaction();
      for (const listener of this.transcriptSignals.get(sessionId) ?? []) listener.changed();
    };
    runtime.useLaunchPlugin(async session => { await front; return steering.launchArgs(session); });
    this.built = { profile: launch, port, native, runtime, steering, titles: new ResumeTitleWatcher({ port }), live, receipts: new CursorLiveReceipts(live, sessionId => native.notePromptReceived(sessionId)), usage, ...(apiCache ? { apiCache } : {}) };
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
  describeProfile(profile: AgentProfile) {
    return describeCursorProfile(cursorProfileConfig(profile, this.builtin(), this.options.stateDir));
  }

  extensionLayout() { return CURSOR_EXTENSION_LAYOUT; }

  async prewarm(host: AgentHost, project: AgentProjectView, profile: AgentProfile, request: AgentPrewarmRequest): Promise<AgentPrewarmResult> {
    // The warm CLI is launched from the runtime's own launch profile only, and standing conversations launch isolated.
    const parts = this.parts(host, profile);
    if (this.launchFor(profile) !== parts.profile) return { state: 'skipped', reason: 'profile_unsupported' };
    if (isStandingProject(project)) return { state: 'skipped', reason: 'standing_unsupported' };
    if (request.approval !== undefined && !CURSOR_PERMISSIONS.some(item => item.id === request.approval)) throw new AppError('INVALID_APPROVAL_MODE', 'Choose a known approval mode');
    const { claimId, renewOnly, ...config } = request;
    return parts.runtime.prewarm(project.id, config, { ...(claimId ? { claimId } : {}), ...(renewOnly ? { renewOnly } : {}) });
  }

  async releasePrewarm(_host: AgentHost, claimId: string): Promise<void> {
    await this.built?.runtime.releasePrewarm(claimId);
  }

  loginLaunch(host: AgentHost, project: AgentProjectView, profile: AgentProfile): AgentLaunchSpec {
    this.parts(host, profile);
    return cursorLaunchSpec(this.launchFor(profile), ['login'], { NO_OPEN_BROWSER: '1' }, project.cwd, { title: 'Cursor Login' });
  }

  capabilityReport(host: AgentHost, profile: AgentProfile) {
    this.parts(host, profile);
    return cursorCapabilityReport(this.launchFor(profile));
  }

  runCommand(host: AgentHost, profile: AgentProfile, request: AgentCommandRequest) {
    this.parts(host, profile);
    return runCursorOperation(this.launchFor(profile), request.operation, request.args, request.cwd);
  }

  runtimeStats(): Record<string, unknown> { return { ...(this.built?.runtime.stats() ?? emptyRuntimeStats()) }; }

  async capabilities(host: AgentHost, profile: AgentProfile): Promise<AgentCapabilities> {
    let steers = false;
    try { this.parts(host, profile); steers = await probeCursorHookSteer(this.launchFor(profile)); }
    catch { /* a profile the CLI cannot launch with has no steering; `available` says why */ }
    return {
      modes: CURSOR_MODES, permissions: CURSOR_PERMISSIONS,
      interactionTransport: 'both', supportsResume: true, supportsInterrupt: true,
      supportsHistory: true, supportsModelSelection: true, supportsModeSelection: true,
      supportsPermissionSelection: true, supportsTerminal: true, requiresLiveTerminal: true, supportsPrewarm: true,
      supportsSteer: steers,
      supportsSessionReferences: true,
      // cursor-agent takes a positional [prompt...], so a brand-new session's first message can
      // ride on the launch argv instead of being pasted into a TUI that is still booting.
      supportsInitialPromptArgs: true,
      slashCommands: CURSOR_COMMANDS,
      compactCommand: 'summarize',
    };
  }

  /**
   * cursor-agent has no listing interface, so its skill directories are read the way it reads
   * them: project roots before user roots, the bundled `skills-cursor` last. Custom commands come
   * from `.cursor/commands`. Text after `/` is forwarded to the CLI verbatim either way.
   */
  async slashItems(host: AgentHost, project: AgentProjectView | undefined): Promise<NativeSlashItem[]> {
    const standing = project ? host.standing?.launch(project) : undefined;
    if (standing) {
      return await scanSkillRoots([standing.skillsDir, ...standing.pluginDirs.map(dir => join(dir, 'skills'))]);
    }
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
      this.parts(host, profile);
      const launch = this.launchFor(profile);
      const [result, needsLogin] = await Promise.all([
        runCursor(launch, ['--version'], { cwd: process.cwd(), timeoutMs: 8000, maxOutputBytes: 16 * 1024 }),
        cursorNeedsLogin(launch).catch(() => false),
      ]);
      if (result.code === 0) return { available: true, version: result.stdout || result.stderr, ...(needsLogin ? { needsLogin: true } : {}) };
      const cliMissing = result.code === null && !result.timedOut && !result.truncated && isCliMissing(resolveCliExecutable({ command: launch.executable }));
      return { available: false, ...(cliMissing ? { cliMissing: true } : {}), reason: `cursor-agent exited with code ${result.code ?? 'unknown'}` };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : 'cursor-agent is unavailable' };
    }
  }

  async open(host: AgentHost, context: AgentContext, options: AgentOpenOptions = {}) {
    const { native, runtime, port, steering, titles, receipts } = this.parts(host, context.profile);
    const { session } = context;
    steering.bind(session.id);
    const prompt = options.initialPrompt;
    const wrapped = prompt ? this.maybeWrapStandingPrompt(host, session, context.project, prompt) : undefined;
    const deliveredPrompt = wrapped?.text;
    const passPromptViaArgv = Boolean(deliveredPrompt && fitsLaunchArg(deliveredPrompt));
    let fencedAt: number | undefined;
    const fence = async () => { await host.beforeSpawn(session.id); fencedAt = Date.now(); };
    const { terminal, promptPending } = await runtime.ensure(session, {
      ...(deliveredPrompt && passPromptViaArgv ? { initialPrompt: deliveredPrompt } : {}),
      beforeSpawn: fence,
    });
    if (deliveredPrompt && (promptPending || !passPromptViaArgv)) {
      // Either a warm CLI took the conversation or the wrapped standing prompt exceeds the 8 KiB launch-arg cap:
      // start the CLI cleanly without positional argv and submit through `native.deliver` (tmux paste-buffer).
      try { await native.deliver(port.getSession(session.id), deliveredPrompt, fence); }
      catch (error) {
        // Nothing was written, so the message can go again; it is pasted into the CLI now running.
        if (fencedAt === undefined) throw new AppError('NATIVE_LAUNCH_ABORTED', error instanceof Error ? error.message : 'The CLI could not take the message yet', 409, { reason: error instanceof AppError ? error.code : undefined });
        throw error;
      }
    }
    const current = port.getSession(session.id);
    if (wrapped?.seeded && fencedAt !== undefined) {
      this.rememberSeededStandingChat(current.nativeSessionId);
      this.reseedStandingSessions.delete(session.id);
    }
    // The store echoes a first prompt only when the CLI has written its step; the live tap sees it go out.
    if (prompt && fencedAt !== undefined) await this.expectFirstReceipt(host, receipts, port, session.id, prompt, fencedAt);
    else await this.expectExitedReceipts(host, receipts, port, session.id);
    if (session.resumePicker && !session.nativeSessionId) titles.watch({ sessionId: session.id, terminalId: terminal.id, projectId: session.projectId });
    return { terminalId: terminal.id, ...(current.nativeSessionId ? { nativeSessionId: current.nativeSessionId } : {}), status: native.status(session.id) };
  }

  private async expectFirstReceipt(host: AgentHost, receipts: CursorLiveReceipts, port: CursorPort, sessionId: string, text: string, sentAt: number): Promise<void> {
    const chatId = port.getSession(sessionId).nativeSessionId;
    if (!chatId) return;
    const runs = await host.runs.find(sessionId, { unfinished: true }).catch(() => []);
    const run = runs.find(item => item.delivery === 'dispatching' && item.intent !== 'steer');
    if (run) await receipts.expect({ host, sessionId, chatId, runId: run.id, commandId: run.commandId, text, sentAt });
  }

  /**
   * A first prompt whose CLI exited at launch (a model it refused) was left unconfirmed, and nothing can
   * release it: its terminal is gone. The relaunched CLI runs that prompt when it resumes the chat, long
   * after the first wait ran out, so each launch, and each start of observing the conversation, looks for it
   * again; the live tap's last step is kept on disk, so a prompt run before this look is still seen.
   */
  private async expectExitedReceipts(host: AgentHost, receipts: CursorLiveReceipts, port: CursorPort, sessionId: string): Promise<void> {
    const chatId = port.getSession(sessionId).nativeSessionId;
    if (!chatId) return;
    const runs = await host.runs.find(sessionId, { unfinished: true }).catch(() => []);
    for (const run of runs) {
      if (run.delivery !== 'uncertain' || run.stage !== 'runtime_exit' || run.nativeMessageId || run.queueReleasedAt || run.intent === 'steer'
        || run.nativeSessionId !== chatId || !run.renderedText || run.inputSentAt === undefined) continue;
      await receipts.expect({ host, sessionId, chatId, runId: run.id, commandId: run.commandId, text: run.renderedText, sentAt: run.inputSentAt, waitFrom: Date.now() });
    }
  }

  async send(host: AgentHost, request: AgentSendRequest): Promise<AgentDelivery | void> {
    const sourceText = request.sourceText ?? request.input.text;
    if (host.standing?.newTopic?.(request.context.session.id, sourceText)) return await this.newTopic(host, request);
    const { text } = await materializeNativeInput(attachments(host), request.input);
    const { native, port, receipts } = this.parts(host, request.context.profile);
    const session = port.getSession(request.context.session.id);
    const { text: deliveredText, seeded } = this.maybeWrapStandingPrompt(host, session, request.context.project, text);
    let sentAt = Date.now();
    const fence = async ({ terminalId, epoch, chatId }: { terminalId: string; epoch: number; chatId?: string }) => {
      const nativeSessionId = chatId ?? session.nativeSessionId;
      if (nativeSessionId) await host.setNativeSessionId(session.id, nativeSessionId);
      await host.commitDispatchFence(request.runId, {
        ...(nativeSessionId ? { nativeSessionId } : {}),
        terminal: { id: terminalId, epoch },
        renderedText: text,
        resolvedConfig: { model: session.model, mode: session.mode, approval: session.approval },
      });
      sentAt = Date.now();
      port.noteInputSent(request.runId, sentAt);
    };
    await native.deliver(session, deliveredText, fence);
    // The echo in the store can be a whole answer away; the CLI taking the prompt is not.
    const chatId = port.getSession(session.id).nativeSessionId;
    if (seeded) {
      this.rememberSeededStandingChat(chatId);
      this.reseedStandingSessions.delete(session.id);
    }
    if (chatId) await receipts.expect({ host, sessionId: session.id, chatId, runId: request.runId, commandId: request.commandId, text, sentAt });
  }

  /**
   * Starts a fresh topic in the standing member's main conversation (docs/ASSISTANT.md §5.5):
   * archives the current chat id into `previousNativeSessionIds`, stops the old CLI process, and clears
   * `nativeSessionId` so the next user message opens a fresh Cursor chat with `<riffet-member>` seeded on argv.
   */
  private async newTopic(host: AgentHost, request: AgentSendRequest): Promise<AgentDelivery> {
    if (request.input.attachmentIds.length || request.input.context.length || request.input.references?.length) {
      throw new AppError('NATIVE_COMMAND_ARGUMENTS', 'Remove attachments and context references before running this command.', 400);
    }
    const { port, steering } = this.parts(host, request.context.profile);
    const sessionId = request.context.session.id;
    return await host.withSessionLock(sessionId, async () => {
      const session = port.getSession(sessionId);
      if (session.terminalHold) throw new AppError('TERMINAL_HELD', 'This conversation is open in a terminal; return it first.', 409);
      const previous = session.nativeSessionId;
      if (!previous) {
        await host.commitDispatchFence(request.runId, { slashCommand: true, renderedText: request.input.text });
        return { state: 'settled' as const };
      }
      await host.commitDispatchFence(request.runId, { slashCommand: true, renderedText: request.input.text, nativeSessionId: previous });
      steering.reject(sessionId, 'Starting a new topic');
      this.seededStandingChats.delete(previous);
      this.reseedStandingSessions.delete(sessionId);
      if (session.terminalId) {
        await port.terminals.stop(session.terminalId).catch(() => undefined);
      }
      const archived = [...(session.previousNativeSessionIds ?? []).filter(id => id !== previous), previous].slice(-MAX_PREVIOUS_NATIVE_SESSIONS);
      await host.updateSession(sessionId, { previousNativeSessionIds: archived, terminalId: undefined });
      await host.setNativeSessionId(sessionId, undefined);
      return { state: 'settled' as const };
    });
  }

  /** Strict V1 context accepts plain text; CLI commands/skills and attachments need a normal turn. */
  async steer(host: AgentHost, request: AgentSendRequest & { target: NativeTurnTarget }) {
    const { steering } = this.parts(host, request.context.profile);
    if (!await probeCursorHookSteer(this.launchFor(request.context.profile))) throw new AppError('STEER_REJECTED', 'This Cursor CLI version has not been verified for safe steering', 409);
    if (request.input.attachmentIds.length) throw new AppError('STEER_REJECTED', 'Cursor steering does not support attachments; send a text steer message', 409);
    const commands = slashTokens(request.sourceText ?? request.input.text);
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
    if (options?.expectedStop) {
      native.refreshTurnIdentity?.(current, options.expectedStop);
      await host.checkStopTarget(sessionId);
      const active = steering.activeTurn(port.getSession(sessionId));
      if (active && (active.nativeSessionId !== options.expectedStop.nativeSessionId
        || (options.expectedStop.turnId && active.turnId !== options.expectedStop.turnId))) {
        throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'The running Cursor turn already changed', 409);
      }
    }
    const target = steering.activeTurn(port.getSession(sessionId));
    steering.rejectPending(sessionId, 'Current task is stopping');
    await native.interrupt(port.getSession(sessionId), {
      ...(options?.clearPrompt !== undefined ? { clearPrompt: options.clearPrompt } : {}),
      ...(options?.expectedStop ? { expectedStop: options.expectedStop, beforeWrite: allowEnded => host.checkStopTarget(sessionId, allowEnded) } : {}),
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

  streamDiscussion(_host: AgentHost, profile: AgentProfile, request: AgentDiscussionRequest): Promise<void> {
    return streamCursorDiscussion(this.launchFor(profile), request);
  }

  async listModels(host: AgentHost, query: AgentModelQuery) {
    const { native } = this.parts(host, query.profile);
    const launch = this.launchFor(query.profile);
    const context = { cwd: await queryDirectory(query.project, { backendId: this.id, id: query.profile.id }) };
    const variants = await native.models(context, launch);
    if (!variants.length) {
      const reason = native.modelListError(context, launch);
      throw new AppError('MODEL_CATALOG_UNAVAILABLE', reason ?? 'The Cursor CLI model catalog is unavailable; try again shortly', 503, reason ? { reason } : undefined);
    }
    return nativeModelCatalogFromVariants(variants, native.modelParameters(context, launch));
  }

  readHistory(host: AgentHost, context: AgentContext, options?: AgentHistoryOptions) {
    this.parts(host, context.profile);
    const configDir = cursorProjectConfigDir(this.launchFor(context.profile).configDir, this.options.stateDir, context.project, context.session);
    return readCursorShare(context, configDir, options);
  }

  async interaction(host: AgentHost, context: AgentContext) {
    const { native, port } = this.parts(host, context.profile);
    return (await native.interaction(port.getSession(context.session.id))) ?? undefined;
  }

  status(host: AgentHost, context: AgentContext) {
    const status = this.parts(host, context.profile).native.status(context.session.id);
    return this.activities.get(context.session.id)?.tracker.status(status) ?? status;
  }

  /**
   * Read-only proof that `run`'s input is no longer sitting in Cursor's composer, follow-up queue,
   * or an active turn. Mirrors Claude's passive `canReleaseInput` check so "Check status" can
   * offer "Continue" when an unconfirmed prompt was genuinely dropped.
   */
  canReleaseInput(host: AgentHost, context: AgentContext, run: AgentRunRef): Promise<boolean> {
    return this.checkInputRelease(host, context, run, false);
  }

  /**
   * Automatic queue recovery proof: requires both the passive idle/empty-composer proof and a
   * later, distinct, completed Cursor turn in the same chat after `run` was sent.
   */
  canReleaseAfterLaterTurn(host: AgentHost, context: AgentContext, run: AgentRunRef): Promise<boolean> {
    return this.checkInputRelease(host, context, run, true);
  }

  private async checkInputRelease(host: AgentHost, context: AgentContext, run: AgentRunRef, requireLaterTurn: boolean): Promise<boolean> {
    try {
      const { native, steering, port, live } = this.parts(host, context.profile);
      const sessionId = context.session.id;
      await native.refreshStatus(sessionId);
      await host.transcript.drain(sessionId);
      const session = port.getSession(sessionId);
      const terminalId = session.terminalId;
      const chatId = session.nativeSessionId;
      if (session.archivedAt || !terminalId || !chatId || !run.nativeSessionId || run.nativeSessionId !== chatId) return false;
      const status = this.status(host, context);
      if (status.phase !== 'idle' || status.activeTurn || status.interaction
        || status.activity?.background || status.activity?.compacting) return false;
      if (steering.activeTurn(session) || port.dialogs.isResponding(terminalId)) return false;
      const liveBefore = live.read(chatId);
      if (liveBefore && !liveBefore.sealed) return false;
      let later: { chatId: string; turnId: string } | undefined;
      if (requireLaterTurn) {
        const sentAt = run.inputSentAt ?? run.dispatchAt;
        const prompt = run.renderedText ?? run.inputText;
        const stepAt = liveBefore ? Date.parse(liveBefore.at) : Number.NaN;
        if (!liveBefore || !liveBefore.sealed || !liveBefore.prompt || !liveBefore.turn
          || sentAt === undefined || !Number.isFinite(stepAt) || !(stepAt > sentAt)) return false;
        if (liveBefore.turn === run.nativeTurnId || cursorPromptAlias(liveBefore.turn) === run.nativeMessageId) return false;
        const livePrompt = withoutStandingMemberContext(liveBefore.prompt);
        if (prompt && samePromptText(prompt, livePrompt)) return false;
        if (run.inputText && run.inputText !== prompt && samePromptText(run.inputText, livePrompt)) return false;
        later = { chatId, turnId: liveBefore.turn };
      }
      const releasable = await host.transcript.withSource(sessionId, (source, w) =>
        source instanceof CursorTranscriptSource ? source.canReleaseInput(w, later) : false);
      if (releasable !== true) return false;
      const terminalView = port.findTerminal(terminalId);
      if (!terminalView || terminalView.kind !== 'cursor' || terminalView.sessionId !== session.id
        || terminalView.projectId !== session.projectId || terminalView.state === 'exited') return false;
      const terminal = await host.terminals.get(terminalId);
      if (!terminal || terminal.state === 'exited' || (requireLaterTurn && terminal.ownerId)) return false;
      const screen = await host.terminals.screen(terminalId, { fresh: true });
      if (!screen) return false;
      const parsed = parseScreen(screen);
      const controls = turnControls(screen);
      if (!parsed.footer || parsed.phase !== 'idle' || parsed.subview) return false;
      if (controls.stoppable || controls.exitArmed || controls.followUps) return false;
      if (!cursorPromptBarEmpty(screen)) return false;
      if (await port.dialogs.current(sessionId)) return false;
      // Re-verify terminal epoch, ownership, session binding, and idle state after screen capture.
      const checked = await host.terminals.get(terminalId);
      const checkedView = port.findTerminal(terminalId);
      if (!checked || checked.epoch !== terminal.epoch || checked.state === 'exited'
        || (requireLaterTurn && checked.ownerId)
        || !checkedView || checkedView.kind !== 'cursor' || checkedView.sessionId !== session.id
        || checkedView.projectId !== session.projectId || checkedView.state === 'exited') return false;
      const latest = port.getSession(sessionId);
      const latestStatus = this.status(host, context);
      const liveAfter = live.read(chatId);
      if (liveAfter && !liveAfter.sealed) return false;
      if (requireLaterTurn && (liveAfter?.step !== liveBefore?.step || liveAfter?.turn !== liveBefore?.turn)) return false;
      return !latest.archivedAt && latest.terminalId === terminalId && latest.nativeSessionId === chatId
        && latestStatus.phase === 'idle' && !latestStatus.activeTurn && !latestStatus.interaction
        && !latestStatus.activity?.background && !latestStatus.activity?.compacting
        && !steering.activeTurn(latest) && !port.dialogs.isResponding(terminalId);
    } catch { return false; }
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
    const { native, steering, port, receipts } = this.parts(host, context.profile);
    const sessionId = context.session.id;
    steering.bind(sessionId);
    void steering.hydrate(context.session).catch(() => undefined);
    // A CLI taken over after a restart may have run such a prompt while nothing here was looking.
    void this.expectExitedReceipts(host, receipts, port, sessionId).catch(() => undefined);
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
    const { native, profile: base, port, live, steering } = this.parts(host, context.profile);
    const sessionId = context.session.id;
    this.launchFor(context.profile);
    const launchNow = () => this.sessionLaunch(port.getSession(sessionId), base);
    return new CursorTranscriptSource({
      sessionId,
      live,
      chatsDir: () => {
        const session = port.getSession(sessionId);
        const project = port.getProject(session.projectId);
        return workspaceChatsDir(cursorProjectConfigDir(launchNow().configDir, this.options.stateDir, project, session), project.cwd);
      },
      chatId: () => port.getSession(sessionId).nativeSessionId,
      previousChatIds: () => port.getSession(sessionId).previousNativeSessionIds ?? [],
      tailState: (chatId, turnId) => {
        const session = port.getSession(sessionId);
        if (session.nativeSessionId !== chatId) return;
        const terminal = session.terminalId ? port.findTerminal(session.terminalId) : undefined;
        if (!session.archivedAt && terminal && terminal.state !== 'exited') return 'live';
        const observed = steering.recordedOutcome(sessionId, { nativeSessionId: chatId, turnId });
        if (observed) return observed;
        const run = port.runsOfTurn(sessionId, chatId, turnId).find(run => run.intent !== 'steer');
        if (run?.state === 'failed') {
          const error = run.error && redactSensitiveText(redactCursorOutput(launchNow(), run.error));
          return { status: 'failed', ...(error ? { error } : {}) };
        }
        if (run?.state === 'completed' || run?.state === 'cancelled') return { status: run.state };
        if (run?.state === 'interrupted') return { status: run.stage === 'provider_cancelled' ? 'cancelled' : 'interrupted' };
        return terminal?.state === 'exited' ? 'exited' : undefined;
      },
      ...(host.workspaceChanges ? { observedChanges: (toolCallId: string) => host.workspaceChanges?.changes(sessionId, toolCallId) } : {}),
      additionalContext: (text, sourceNativeId, createdAt) => steering.transcriptReceipts(sessionId, text, sourceNativeId, createdAt),
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
        if (message.type === 'reset' || message.type === 'append' || message.type === 'draft' || message.type === 'subagent'
          || (message.type === 'status' && message.status.phase === 'offline')) listener.changed();
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
      this.seededStandingChats.clear();
      this.reseedStandingSessions.clear();
      this.usageHost = undefined;
      this.configs.clear();
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
