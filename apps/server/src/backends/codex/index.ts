import { resolve as resolvePath } from 'node:path';
import { queryDirectory } from '../shared/query-directory.js';
import type {
  ModelInfo, NativeActivity, NativeBackendCapabilities, NativeBackendUsage, NativeInteraction, NativeInteractionResponse, NativeInteractionResult, NativeRuntimeActionRequest,
  NativeSlashItem, NativeStatus, NativeStopRequest, NativeTurnTarget, Project, Session,
} from '../../../../../packages/contracts/src/index.js';
import type { CodexAppServerClient, CodexAppServerFactory } from '../shared/codex-app-server.js';
import { str } from './util.js';
import { CodexAppServer as CodexAppServerProcess } from '../shared/codex-app-server.js';
import { codexFlavor, type CodexFlavor } from './flavors.js';
import { codexTrustArgs } from '../shared/cli-trust.js';
import { resolveCliExecutable } from '../shared/cli-resolve.js';
import { AppError, sessionInTerminal } from '../../errors.js';
import { materializeAttachment } from '../attachments.js';
import type {
  NativeBackendAvailability, NativeBackendConfigurePatch, NativeBackendConfigureResult, NativeBackendDriver, NativeBackendHost, NativeDriverCommandObservation, NativeBackendOpenOptions, NativeBackendOpenResult, NativeBackendProfileConfig,
  NativeBackendSendRequest, NativeBackendTraits, NativeControlMessage,
  NativeDriverExtensions, NativeDriverExternal, NativeDriverStored, NativePrewarmRequest, NativePrewarmResult,
} from '../types.js';
import { WarmPool } from '@riffet/plugin-api/kit';
import { sessionWarmKey, startCodexWarm, warmKey, type CodexWarm } from './launch.js';
import { MAX_PREVIOUS_NATIVE_SESSIONS } from '../types.js';
import type { CliVersionRange } from '../shared/cli-version.js';
import {
  normalizePermission, configuredCommand, executableOf, runtimeFingerprintFor, assertSupportedProfile, providerEnv,
  collaborationModeOf, STEER_MIN_VERSIONS, readCodexOwnerGateway, hasCodexChatgptAuth,
} from './config.js';
import type { AgentDiscussionRequest } from '@riffet/plugin-api/experimental/agent';
import { streamTraeDiscussion } from './traex-discussion.js';
import { CodexAuxiliary } from './auxiliary.js';
import { CodexExternalSessions } from './external-sessions.js';
import { capabilitiesOf, availabilityOf } from './availability.js';
import { commandObservationOf } from './command-observation.js';
import { CodexJournalFeeds } from './journal-feeds.js';
import { CodexListeners } from './listeners.js';
import { CodexSkills } from './skills.js';
import { CodexExtensionDriver } from './extension-driver.js';
import { listModelsOf, usageOf } from './model-list.js';
import { readContextTranscript, readShareTranscript, usageTranscript } from './stored-reads.js';
import { readCodexRequests } from './request-records.js';
import { resumeCommand, terminalLaunch, type TerminalLaunchContext } from './terminal-launch.js';
import { parseCodexNativeCommand } from './commands.js';
import { modelSourceOf, prepareSource, resolveSource } from '../shared/model-source.js';
import { modelFamily } from '../shared/model-selection.js';
import { safeProviderError } from './errors.js';
import { isKnownBlockingTitle } from '../../agent-host/interaction-choice.js';
import { CodexSessionRuntime, type NativeRuntimeHooks } from './runtime.js';
import { newTopicBoundary } from './transcript-source.js';
import { codexStanding, type CodexStanding } from './standing.js';
import { codexObservation, type CodexObservation } from './observation.js';
import type { TranscriptSource } from '../../journal/ingest.js';

const startNativeAppServer: CodexAppServerFactory = options => CodexAppServerProcess.start(options);

const PROFILE_ID = 'local';
/**
 * TRAE draws a command approval on its TUI and also reports the same request through a connected
 * app-server. The protocol card is the one to answer then; reading the screen too would keep a copy
 * of an answered approval around and republish it once the protocol interaction settles.
 */
const TRAE_COMMAND_PERMISSION = 'Would you like to run the following command?';
interface PendingRuntime {
  projectId: string;
  fingerprint: string;
  promise: Promise<CodexSessionRuntime>;
}

/**
 * A Codex turn is settled by its own `turn/completed`, never by an idle status; closing the driver
 * detaches the reusable app-server that per-session disposal would stop.
 */
export const CODEX_TRAITS: NativeBackendTraits = { completesOnTurnEvent: true, startsNewTopic: true, survivesRestart: true, offlineMayBeRunning: true, closesSessionsItself: true, resumesByNativeId: true, riffetTools: true, extensionToggles: { mcp: true, skills: false }, consumesProtocols: ['openai-responses'] };

export class CodexBackendAdapter implements NativeBackendDriver {
  readonly extensions: NativeDriverExtensions = {
    loaded: (host, project, profile) => this.extensionDriver.loaded(host, project, profile),
    runtime: (host, project, profile) => this.extensionDriver.runtime(host, project, profile),
    skillStates: (host, project, profile) => this.extensionDriver.skillStates(host, project, profile),
    setSkillEnabled: (host, project, profile, path, enabled) => this.extensionDriver.setSkillEnabled(host, project, profile, path, enabled),
    reload: (host, project, profile) => this.extensionDriver.reload(host, project, profile),
    authorizeMcp: (host, project, profile, name) => this.extensionDriver.authorize(host, project, profile, name),
  };
  readonly external: NativeDriverExternal = {
    list: (host, profile, options) => this.externalSessions.list(host, profile, options),
    holder: (host, profile, id) => this.externalSessions.holder(host, profile, id),
    terminalLaunch: (host, session, project, profile) => terminalLaunch(this.launchContext(), host, session, project, profile),
    resumeCommand: (session, profile) => resumeCommand(this.launchContext(), session, profile),
  };
  readonly stored: NativeDriverStored = {
    usage: (_host, session, profile, known) => usageTranscript(this.flavor, session, profile, known),
    context: (_host, session, profile, options) => readContextTranscript(this.flavor, session, profile, options),
    share: (host, session, profile, options) => readShareTranscript(this.flavor, host, session, profile, options),
    requests: (_host, session, profile, options) => readCodexRequests(this.flavor.id, session, this.flavor.stateHome(profile.config), options.lane, options.agentId, options.signal),
  };
  readonly id: CodexFlavor['id'];
  readonly label: string;
  readonly traits: NativeBackendTraits;
  readonly cliVersions: CliVersionRange;
  private readonly runtimes = new Map<string, CodexSessionRuntime>();
  private readonly creating = new Map<string, PendingRuntime>();
  private readonly restarting = new Set<string>();
  private readonly profileSwitchTimers = new Map<string, NodeJS.Timeout>();
  private readonly profileSwitchFailures = new Set<string>();
  private readonly listeners: CodexListeners;
  private readonly journalFeeds: CodexJournalFeeds;
  readonly streamDiscussion?: NativeBackendDriver['streamDiscussion'];
  private readonly sideChats = new AbortController();
  private readonly auxiliary: CodexAuxiliary;
  private readonly externalSessions: CodexExternalSessions;
  private readonly skills: CodexSkills;
  private readonly extensionDriver: CodexExtensionDriver;
  private closing = false;
  private closeTask: Promise<void> | undefined;
  /** An app-server with a new thread, started for the next new conversation of the project a page shows (`launch.ts`). */
  private readonly warm: WarmPool<CodexWarm>;
  /** What shell commands changed in the working tree, seen by hooks (`observation.ts`). */
  readonly observation?: CodexObservation;
  readonly commandObservation?: NativeDriverCommandObservation;

  constructor(
    private readonly startAppServer: CodexAppServerFactory = startNativeAppServer,
    private readonly flavor: CodexFlavor = codexFlavor,
    /** The plugins' sidecars for native processes (`PluginRegistry`); without them a process runs as launched. */
    private readonly runtimeHooks?: NativeRuntimeHooks,
    options: { stateDir?: string } = {},
  ) {
    // Only Codex itself has the hooks that observation runs on; TRAE's fork is not assumed to.
    if (options.stateDir && flavor.id === 'codex') this.observation = codexObservation(options.stateDir);
    if (this.observation) {
      this.commandObservation = commandObservationOf({ flavor, observation: this.observation, withTransport: (project, profile, session, read, extraArgs) => this.withTransport(project, profile, session, read, extraArgs) });
    }
    this.id = flavor.id;
    this.label = flavor.label;
    // Each context reads `withTransport` through the adapter on every call, so a replaced reader is seen.
    const withTransport = <T>(project: Project | undefined, profile: NativeBackendProfileConfig, session: Session | undefined, read: (transport: CodexAppServerClient) => Promise<T>) => this.withTransport(project, profile, session, read);
    if (flavor.id === 'traex') this.streamDiscussion = (host, profile, request) => this.traeDiscussion(host, profile, request);
    this.auxiliary = new CodexAuxiliary({ flavor, startAppServer, withTransport });
    this.externalSessions = new CodexExternalSessions({
      flavor,
      withManagementTransport: (...args) => this.withManagementTransport(...args),
      ownAddresses: () => [...this.runtimes.values()].flatMap(runtime => runtime.transport?.remoteAddress ?? []),
    });
    this.skills = new CodexSkills({ withTransport, standingOf: (host, project) => this.standingOf(host, project) });
    this.journalFeeds = new CodexJournalFeeds({
      flavor,
      observation: this.observation,
      runtime: sessionId => this.runtimes.get(sessionId),
      restarting: sessionId => this.restarting.has(sessionId),
      profileSwitchPending: session => this.profileSwitchPending(session),
      activeProfile: (...args) => this.activeProfile(...args),
      externalHolder: (host, profile, threadId) => this.externalSessions.holder(host, profile, threadId),
      ensureRuntime: (...args) => this.ensureRuntime(...args),
    });
    this.listeners = new CodexListeners({
      runtime: sessionId => this.runtimes.get(sessionId),
      ensureRuntime: (...args) => this.ensureRuntime(...args),
      activeProfile: (...args) => this.activeProfile(...args),
    });
    this.extensionDriver = new CodexExtensionDriver({
      runtimes: this.runtimes,
      withTransport,
      withManagementTransport: (...args) => this.withManagementTransport(...args),
      standingOf: (host, project) => this.standingOf(host, project),
    });
    this.warm = new WarmPool<CodexWarm>({ label: flavor.id, stop: async warm => { warm.mcp?.revoke(); await warm.transport.dispose(); } });
    // TRAE background children outlive the foreground turn independently. Keep observing them,
    // but their activity alone must not hold the parent session/sidebar in running.
    // TRAE CLI signs in with its own account and takes no model source (`traexFlavor.unsupportedProfileSetting`), so it consumes no protocol.
    this.traits = flavor.id === 'traex' ? { ...CODEX_TRAITS, detachedSubagents: true, consumesProtocols: [] } : CODEX_TRAITS;
    this.cliVersions = flavor.cliVersions;
  }

  profiles(): NativeBackendProfileConfig[] {
    const executable = process.env[this.flavor.executableEnv]?.trim() || this.flavor.command;
    return [{ id: PROFILE_ID, backendId: this.id, name: this.flavor.profileName, isDefault: true, config: { executable } }];
  }

  gatewayProfile(profile: NativeBackendProfileConfig): NativeBackendProfileConfig | undefined {
    if (this.flavor.id !== 'codex') return undefined;
    const http = readCodexOwnerGateway(profile, this.flavor.stateHome(profile.config));
    if (http) return http;
    if (!hasCodexChatgptAuth(this.flavor.stateHome(profile.config))) return undefined;
    if (this.startAppServer === startNativeAppServer && resolveCliExecutable({ command: configuredCommand(profile, this.flavor) }).source === 'unresolved') return undefined;
    return { ...profile };
  }

  invalidateModels(): void {
    this.auxiliary.invalidate();
  }

  auxiliaryModels(profile: NativeBackendProfileConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
    return this.auxiliary.models(profile, signal);
  }

  auxiliaryComplete(profile: NativeBackendProfileConfig, request: Parameters<CodexAuxiliary['complete']>[1]): Promise<string> {
    return this.auxiliary.complete(profile, request);
  }

  auxiliaryStreamChat(profile: NativeBackendProfileConfig, request: Parameters<CodexAuxiliary['streamChat']>[1]): ReturnType<CodexAuxiliary['streamChat']> {
    return this.auxiliary.streamChat(profile, request);
  }


  private async traeDiscussion(host: NativeBackendHost, profile: NativeBackendProfileConfig, request: AgentDiscussionRequest): Promise<void> {
    const source = request.sourceAttachment !== null && request.sourceSessionId ? host.getSession(request.sourceSessionId) : undefined;
    const current = source?.nativeRuntime?.attachment;
    const required = request.sourceAttachment === undefined ? current : request.sourceAttachment;
    let address: string | undefined;
    if (required) {
      const runtime = source && this.runtimes.get(source.id);
      if (!source?.nativeRuntime || current?.hook !== required.hook || current.id !== required.id
        || source.backendId !== this.id || (source.backendProfileId && source.backendProfileId !== profile.id)
        || (source.nativeRuntime.profileId && source.nativeRuntime.profileId !== profile.id)
        || runtime?.launchProfile.id !== profile.id || !runtime.transport?.isOnline
        || runtime.transport.remoteAddress !== source.nativeRuntime.address || runtime.nativeSessionId !== source.nativeSessionId)
        throw new AppError('DISCUSSION_PROVIDER_UNAVAILABLE', 'The routing provider of the main conversation is unavailable', 409);
      address = runtime.transport.remoteAddress;
    }
    await streamTraeDiscussion(this.startAppServer, profile, {
      ...request, signal: AbortSignal.any([request.signal, this.sideChats.signal]),
    }, address);
  }

  continuationKey(profile: NativeBackendProfileConfig): string {
    return this.id === 'codex' ? resolvePath(this.flavor.stateHome(profile.config)) : profile.id;
  }

  canContinueProfile(from: NativeBackendProfileConfig, to: NativeBackendProfileConfig): boolean {
    // Keep the native provider identity as well as the thread. Cross-authentication histories
    // need a separately verified protocol route; merely sharing CODEX_HOME is insufficient.
    const customProvider = (profile: NativeBackendProfileConfig) => this.flavor.args(profile.config).includes('model_provider="riffet"');
    return this.id === 'codex' && customProvider(from) === customProvider(to)
      && executableOf(from, this.flavor) === executableOf(to, this.flavor);
  }

  afterConfigure(host: NativeBackendHost, session: Session): void {
    this.profileSwitchFailures.delete(session.id);
    this.scheduleProfileSwitch(host, session.id);
  }

  /** Settings describe the next provider; controls and readers still belong to the live writer. */
  private activeProfile(host: NativeBackendHost, session: Session, desired: NativeBackendProfileConfig): NativeBackendProfileConfig {
    const actualId = session.configPending && this.id === 'codex' ? session.nativeRuntime?.profileId : undefined;
    if (!actualId || actualId === desired.id) return desired;
    const live = this.runtimes.get(session.id);
    if (live?.launchProfile.id === actualId) return live.launchProfile;
    return host.getProfile?.({ ...session, backendProfileId: actualId })
      ?? (() => { throw new AppError('NATIVE_PROFILE_NOT_FOUND', 'The running provider is unavailable', 409); })();
  }

  private profileSwitchPending(session: Session): boolean {
    return this.id === 'codex' && session.configPending === true
      && Boolean(session.nativeRuntime?.profileId && session.backendProfileId
        && session.nativeRuntime.profileId !== session.backendProfileId);
  }

  private scheduleProfileSwitch(host: NativeBackendHost, sessionId: string, delay = 250): void {
    if (this.closing || this.profileSwitchTimers.has(sessionId) || this.profileSwitchFailures.has(sessionId)
      || host.getSession(sessionId).archivedAt || !this.profileSwitchPending(host.getSession(sessionId))) return;
    const timer = setTimeout(() => {
      // Keep the timer as a cancellation token while this callback waits for the session lock.
      // dispose/close may run before it acquires the lock, even though the timeout already fired.
      const apply = () => this.profileSwitchTimers.get(sessionId) === timer && !this.closing
        ? this.applyProfileSwitch(host, sessionId) : Promise.resolve(true);
      const task = host.withDetachedSessionLock ? host.withDetachedSessionLock(sessionId, apply) : host.withSessionLock(sessionId, apply);
      void task.catch(error => {
        this.profileSwitchFailures.add(sessionId);
        const runtime = this.runtimes.get(sessionId);
        if (runtime) runtime.profileSwitchFailed(safeProviderError(error, runtime.launchProfile.config));
      })
        .finally(() => {
          if (this.profileSwitchTimers.get(sessionId) !== timer) return;
          this.profileSwitchTimers.delete(sessionId);
          if (!this.closing) { try { this.scheduleProfileSwitch(host, sessionId, 1_000); } catch { /* session was deleted */ } }
        });
    }, delay);
    timer.unref?.();
    this.profileSwitchTimers.set(sessionId, timer);
  }

  /** Called only for a saved user selection, under the same lock as sends and configuration. */
  private async applyProfileSwitch(host: NativeBackendHost, sessionId: string): Promise<boolean> {
    const session = host.getSession(sessionId);
    if (this.closing || session.archivedAt) return false;
    if (!this.profileSwitchPending(session)) return true;
    if (session.terminalHold) return false;
    const project = host.getProject(session.projectId);
    const target = host.getProfile?.(session);
    if (!target) throw new AppError('NATIVE_PROFILE_NOT_FOUND', 'The selected provider is unavailable', 409);
    const source = this.activeProfile(host, session, target);
    if (this.continuationKey(source) !== this.continuationKey(target) || !this.canContinueProfile(source, target)) {
      throw new AppError('NATIVE_PROFILE_SWITCH_UNSUPPORTED', 'This conversation cannot continue on that provider; hand it off instead', 409);
    }
    if (this.runtimes.get(sessionId)?.canSwitchProfile === false) return false;
    const previous = await this.ensureRuntime(host, session, project, source, true);
    if (!previous.canSwitchProfile) return false;
    // thread/read reports the current model when loaded and the persisted model otherwise.
    // Read it before releasing a cold source; resuming with the desired target would overwrite it.
    await previous.prime();
    if (!previous.canSwitchProfile) return false;
    const previousModel = previous.currentModel;
    const selectedModel = session.model ?? str(target.config.defaultModel);
    if (!previousModel || !selectedModel || modelFamily(previousModel) !== modelFamily(selectedModel)) {
      throw new AppError('NATIVE_PROFILE_SWITCH_MODEL', 'A conversation moves to another provider within its model line; hand it off instead', 409);
    }
    try { await prepareSource(target.config); }
    catch (error) { throw new AppError('NATIVE_PROFILE_SWITCH_FAILED', safeProviderError(error, target.config), 502); }
    // A fresh, unloaded process validates the target launch before the old writer is released.
    // Its snapshot deliberately has no old socket/TUI binding to accidentally reattach.
    const replacement = new CodexSessionRuntime(host, { ...session, nativeRuntime: undefined, terminalId: undefined }, project, target, this.startAppServer, this.flavor, this.runtimeHooks, this.observation);
    this.restarting.add(sessionId);
    const task = Promise.resolve().then(() => previous.switchProfile(replacement, {
      feed: () => this.journalFeeds.feedOf(sessionId),
      publish: runtime => { this.runtimes.set(sessionId, runtime); },
      bind: runtime => this.listeners.bind(sessionId, runtime),
      restore: () => {
        const restored = new CodexSessionRuntime(host, { ...host.getSession(sessionId), nativeRuntime: undefined, terminalId: undefined }, project, source, this.startAppServer, this.flavor, this.runtimeHooks, this.observation);
        restored.attachFeed(this.journalFeeds.feedOf(sessionId));
        this.runtimes.set(sessionId, restored);
        return restored;
      },
      previousModel,
      describe: error => safeProviderError(error, target.config),
      succeeded: () => { this.profileSwitchFailures.delete(sessionId); },
      failed: () => { this.profileSwitchFailures.add(sessionId); },
    }));
    const entry = { projectId: project.id, fingerprint: runtimeFingerprintFor(project, source, this.flavor), promise: task };
    this.creating.set(sessionId, entry);
    try { await task; return !this.profileSwitchPending(host.getSession(sessionId)); }
    finally { this.restarting.delete(sessionId); if (this.creating.get(sessionId) === entry) this.creating.delete(sessionId); }
  }

  capabilities(_host: NativeBackendHost, profile: NativeBackendProfileConfig): Promise<NativeBackendCapabilities> {
    return capabilitiesOf({ flavor: this.flavor, runtimeHooks: this.runtimeHooks }, profile);
  }

  available(_host: NativeBackendHost, profile: NativeBackendProfileConfig): Promise<NativeBackendAvailability> {
    return availabilityOf(this.flavor, profile);
  }

  async openOrResume(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig, options: NativeBackendOpenOptions = {}): Promise<NativeBackendOpenResult> {
    return await host.withSessionLock(session.id, async () => {
      await this.applyProfileSwitch(host, session.id);
      session = host.getSession(session.id);
      profile = this.activeProfile(host, session, profile);
      let runtime = await this.ensureRuntime(host, session, project, profile, true);
      if (!runtime.connection.canRunWith(project, profile)) {
        runtime.connection.deferWriteBlocked(project, profile);
        return { ...(runtime.nativeSessionId ? { nativeSessionId: runtime.nativeSessionId } : {}), ...(runtime.terminalId ? { terminalId: runtime.terminalId } : {}), status: runtime.status };
      }
      if (options.restartFingerprint && runtime.status.profilePending
        && host.getSession(session.id).nativeRuntime?.fingerprint === options.restartFingerprint
        && host.getSession(session.id).nativeRuntime?.address === options.restartAddress) {
        const previous = runtime;
        this.restarting.add(session.id);
        const promise = Promise.resolve().then(async () => {
          if (!await previous.connection.restartBackend(options.restartFingerprint!, options.restartAddress!)) return previous;
          this.runtimes.delete(session.id);
          const replacement = new CodexSessionRuntime(host, host.getSession(session.id), project, profile, this.startAppServer, this.flavor, this.runtimeHooks, this.observation);
          replacement.attachFeed(this.journalFeeds.feedOf(session.id));
          await replacement.start();
          this.runtimes.set(session.id, replacement);
          await this.listeners.bind(session.id, replacement);
          return replacement;
        });
        const entry = { projectId: project.id, fingerprint: runtimeFingerprintFor(project, profile, this.flavor), promise };
        this.creating.set(session.id, entry);
        try { runtime = await promise; }
        finally { this.restarting.delete(session.id); if (this.creating.get(session.id) === entry) this.creating.delete(session.id); }
      }
      if (!runtime.connection.canRunWith(project, profile)) {
        runtime.connection.deferWriteBlocked(project, profile);
        return { ...(runtime.nativeSessionId ? { nativeSessionId: runtime.nativeSessionId } : {}), ...(runtime.terminalId ? { terminalId: runtime.terminalId } : {}), status: runtime.status };
      }
      const nativeSessionId = await runtime.openOrResume();
      await runtime.terminal.ensureTui();
      // A colour change recorded while no runtime was loaded (or a TUI from before it) applies now.
      await runtime.terminal.relaunchTuiForAppearance();
      const terminalId = runtime.terminalId;
      return { nativeSessionId, ...(terminalId ? { terminalId } : {}), status: runtime.status };
    });
  }

  async send(host: NativeBackendHost, request: NativeBackendSendRequest): Promise<void | { settled: true }> {
    const sourceText = request.sourceText ?? request.input.text;
    if (host.standing?.newTopic?.(request.session.id, sourceText)) return await this.newTopic(host, request);
    const command = this.flavor.id === 'codex' ? parseCodexNativeCommand(sourceText) : undefined;
    if (command && (request.input.attachmentIds.length || request.input.context.length || request.input.references?.length)) {
      throw new AppError('NATIVE_COMMAND_ARGUMENTS', 'Remove attachments and context references before running this command.', 400);
    }
    await host.withSessionLock(request.session.id, async () => {
      if (!await this.applyProfileSwitch(host, request.session.id)) {
        throw new AppError('CLI_BUSY', 'The current task is still running; the provider change will apply when it finishes.', 409);
      }
      const runtime = await this.ensureRuntime(host, request.session, request.project, request.profile, true);
      if (!runtime.connection.canRunWith(request.project, request.profile)) {
        const blocked = runtime.connection.deferWriteBlocked(request.project, request.profile);
        throw new AppError(blocked.code, blocked.message, 409);
      }
      const nativeSessionId = await runtime.openOrResume();
      await runtime.terminal.ensureTui();
      const { input, images, renderedText } = await renderInput(host, request.input);
      const standing = this.standingOf(host, request.project);
      const skills = command ? [] : await this.skills.inputs(runtime.transport, request.project.cwd, request.profile, sourceText, false, standing);
      if (host.isRunCancelled(request.runId)) return;
      const result = await runtime.send({
        runId: request.runId,
        commandId: request.commandId,
        renderedText,
        input: [...input, ...images, ...skills],
        config: { ...request.config, ...(request.config.model === undefined && typeof request.profile.config.defaultModel === 'string'
          ? { model: request.profile.config.defaultModel } : {}) },
        nativeSessionId,
        ...(command ? { command } : {}),
        commitDispatchFence: request.commitDispatchFence,
      });
      runtime.recordSubmittedTurn(result.turnId, request.runId, request.commandId);
    });
  }

  private launchContext(): TerminalLaunchContext {
    return { flavor: this.flavor, label: this.label, ensureRuntime: (...args) => this.ensureRuntime(...args) };
  }

  /** The 助理's isolation when [project] is its directory (docs/ASSISTANT.md §4); TRAE CLI's app-server is not isolated. */
  private standingOf(host: NativeBackendHost, project: Project): CodexStanding | undefined {
    return this.flavor.id === 'codex' ? codexStanding(host.standing?.launch(project)) : undefined;
  }

  /**
   * A new topic in the 助理's main conversation (docs/ASSISTANT.md §5.5). The app-server cannot clear a thread's
   * context, so the conversation goes on in a new thread on the same app-server, and the old one leads its history
   * (`previousNativeSessionIds`), as after Claude Code's `/clear`. No turn is started: the run is settled here.
   */
  private async newTopic(host: NativeBackendHost, request: NativeBackendSendRequest): Promise<{ settled: true }> {
    if (request.input.attachmentIds.length || request.input.context.length || request.input.references?.length) {
      throw new AppError('NATIVE_COMMAND_ARGUMENTS', 'Remove attachments and context references before running this command.', 400);
    }
    const sessionId = request.session.id;
    return await host.withSessionLock(sessionId, async () => {
      if (!await this.applyProfileSwitch(host, sessionId)) {
        throw new AppError('CLI_BUSY', 'The current task is still running; the provider change will apply when it finishes.', 409);
      }
      const session = host.getSession(sessionId);
      if (session.terminalHold) throw sessionInTerminal();
      const previous = session.nativeSessionId;
      const settle = () => { request.commitDispatchFence({ backendId: this.flavor.id, slashCommand: true, renderedText: request.input.text }); return { settled: true as const }; };
      // A conversation that never started has no context to clear.
      if (!previous) return settle();
      const runtime = await this.ensureRuntime(host, session, request.project, request.profile, true);
      if (!runtime.connection.canRunWith(request.project, request.profile)) {
        const blocked = runtime.connection.deferWriteBlocked(request.project, request.profile);
        throw new AppError(blocked.code, blocked.message, 409);
      }
      await runtime.openOrResume();
      // Nor does a thread nothing was sent in yet, which is never written to disk.
      const head = await runtime.turnsPage({ threadId: previous, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }).catch(() => undefined);
      if (!head?.data?.length) return settle();
      // Fenced before the thread is left, so a send that fails part way is not replayed into a third thread. The
      // boundary names the thread it ends: the journal's reader shows the message there (`transcript-source.ts`).
      request.commitDispatchFence({ backendId: this.flavor.id, slashCommand: true, renderedText: request.input.text, nativeSessionId: previous, nativeInputBoundary: newTopicBoundary(previous) });
      // The journal's reader must not bring up a runtime of its own while the thread changes hands.
      this.restarting.add(sessionId);
      try {
        const left = await runtime.leaveThread();
        const stored = host.getSession(sessionId);
        host.updateSession(sessionId, { previousNativeSessionIds: [...(stored.previousNativeSessionIds ?? []), left].slice(-MAX_PREVIOUS_NATIVE_SESSIONS), terminalId: undefined });
        host.setNativeSessionId(sessionId, undefined);
        this.runtimes.delete(sessionId);
        await runtime.dispose(host, { keepRunning: true });
        const next = await this.ensureRuntime(host, host.getSession(sessionId), request.project, request.profile, true);
        await next.openOrResume();
        await next.terminal.ensureTui();
      } finally {
        this.restarting.delete(sessionId);
      }
      return { settled: true };
    });
  }

  async steer(host: NativeBackendHost, request: NativeBackendSendRequest & { target: NativeTurnTarget }): Promise<void> {
    await host.withSessionLock(request.session.id, async () => {
      if (!(await this.capabilities(host, request.profile)).supportsSteer) throw new AppError('STEER_UNSUPPORTED', `${this.label} requires a verified CLI version (${STEER_MIN_VERSIONS[this.flavor.id]} or newer) with attributable in-flight input receipts.`, 409);
      const session = host.getSession(request.session.id);
      if (session.nativeSessionId !== request.target.nativeSessionId) throw new AppError('STEER_TARGET_CHANGED', 'The target conversation changed.', 409);
      // Reconnect only to a verified existing endpoint: this path must never spawn a new server.
      const profile = this.activeProfile(host, session, request.profile);
      const runtime = await this.ensureRuntime(host, session, request.project, profile, true, true);
      if (!runtime.connection.canRunWith(request.project, profile)) {
        const blocked = runtime.connection.deferWriteBlocked(request.project, profile);
        throw new AppError(blocked.code, blocked.message, 409);
      }
      if (!runtime.steerTarget) await runtime.prime();
      await runtime.attachLoadedOwner();
      const { input, images, renderedText } = await renderInput(host, request.input);
      const skills = await this.skills.inputs(runtime.transport, request.project.cwd, request.profile, request.sourceText ?? request.input.text, true, this.standingOf(host, request.project));
      if (host.isRunCancelled(request.runId)) throw new AppError('RUN_CANCELLED', 'Instruction was cancelled before delivery.', 409);
      await runtime.steer({
        runId: request.runId, commandId: request.commandId, target: request.target,
        renderedText, input: [...input, ...images, ...skills], commitDispatchFence: request.commitDispatchFence,
      });
    });
  }

  requestInterrupt(_host: NativeBackendHost, session: Session): void {
    this.runtimes.get(session.id)?.requestInterrupt();
  }

  async interrupt(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, options?: { clearPrompt?: boolean; expectedStop?: NativeStopRequest }): Promise<void> {
    if (!session.nativeSessionId) return;
    await host.withSessionLock(session.id, async () => {
      profile = this.activeProfile(host, host.getSession(session.id), profile);
      const project = host.getProject(session.projectId);
      const runtime = await this.ensureRuntime(host, session, project, profile, true, Boolean(options?.expectedStop));
      if (!runtime.connection.canRunWith(project, profile)) {
        const blocked = runtime.connection.deferWriteBlocked(project, profile);
        throw new AppError(blocked.code, blocked.message, 409);
      }
      const expected = options?.expectedStop;
      if (expected && (runtime.nativeSessionId !== expected.nativeSessionId || runtime.activeTurnId !== expected.turnId)) {
        throw new AppError('NATIVE_STOP_TARGET_CHANGED', 'The original task changed before stopping', 409);
      }
      await runtime.interrupt(expected?.turnId, expected?.nativeSessionId);
    });
  }

  async runtimeAction(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, request: NativeRuntimeActionRequest): Promise<void> {
    if (!this.runtimeHooks?.runtimeHooks(this.id).length) throw new AppError('RUNTIME_CONTROL_UNAVAILABLE', 'This backend has no runtime control', 409);
    return await host.withSessionLock(session.id, async () => {
      profile = this.activeProfile(host, host.getSession(session.id), profile);
      const project = host.getProject(session.projectId);
      // A runtime action may reconnect to an existing owner, but must never create a new native turn.
      const runtime = await this.ensureRuntime(host, session, project, profile, true, true);
      if (!runtime.connection.canRunWith(project, profile)) {
        const blocked = runtime.connection.deferWriteBlocked(project, profile);
        throw new AppError(blocked.code, blocked.message, 409);
      }
      await runtime.runtimeAction(request);
    });
  }

  async stopActivity(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, activityId: string): Promise<NativeActivity> {
    const runtime = this.runtimes.get(session.id);
    if (!runtime) throw new AppError('ACTIVITY_NOT_FOUND', 'This conversation is not open, so it has no running activities', 404);
    // Same gate as interrupt: a runtime whose profile or endpoint no longer matches must not act on the thread.
    // Only the check holds the session lock; the stop itself waits on the provider for seconds.
    await host.withSessionLock(session.id, async () => {
      profile = this.activeProfile(host, host.getSession(session.id), profile);
      const project = host.getProject(session.projectId);
      if (!runtime.connection.canRunWith(project, profile)) {
        const blocked = runtime.connection.deferWriteBlocked(project, profile);
        throw new AppError(blocked.code, blocked.message, 409);
      }
    });
    return await runtime.stopActivity(activityId);
  }

  async respond(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, response: NativeInteractionResponse): Promise<NativeInteractionResult> {
    if (!session.nativeSessionId) return { status: 'uncertain', message: `This ${this.label} session has no native thread yet.` };
    return await host.withSessionLock(session.id, async () => {
      profile = this.activeProfile(host, host.getSession(session.id), profile);
      // A request that arrived on this runtime's own socket proves it owns the waiting turn, so its
      // answer goes back the same way. Re-verifying the TUI endpoint guards new writes; for a reply it
      // only lets a slow or failed process scan turn a valid answer into a conflict.
      const live = this.runtimes.get(session.id);
      if (live?.holdsInteraction(response.interactionId)) return await live.respond(response);
      const project = host.getProject(session.projectId);
      const runtime = await this.ensureRuntime(host, session, project, profile, true);
      if (!runtime.connection.canRunWith(project, profile)) {
        const blocked = runtime.connection.deferWriteBlocked(project, profile);
        return { status: 'uncertain', message: blocked.message };
      }
      return await runtime.respond(response);
    });
  }

  async rename(_host: NativeBackendHost, session: Session): Promise<void> {
    await this.runtimes.get(session.id)?.pushTitle();
  }

  async configure(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, patch: NativeBackendConfigurePatch): Promise<NativeBackendConfigureResult> {
    return await host.withSessionLock(session.id, async () => {
      if (patch.mode !== undefined && !this.flavor.modes.length) throw new Error(`This ${this.label} app-server version does not expose a mode setter.`);
      const runtime = this.runtimes.get(session.id);
      const resolved: NativeBackendConfigureResult = {};
      if (patch.model !== undefined) resolved.model = patch.model;
      if (patch.mode !== undefined) resolved.mode = collaborationModeOf(patch.mode) ?? 'default';
      if (patch.approval !== undefined) resolved.approval = normalizePermission(patch.approval, this.flavor.id);
      if (this.id === 'codex') {
        const current = host.getSession(session.id);
        const actualId = runtime?.launchProfile.id ?? current.nativeRuntime?.profileId ?? current.backendProfileId;
        if (actualId && actualId !== profile.id && current.nativeRuntime) {
          const sourceModel = runtime?.currentModel;
          const targetModel = patch.model ?? current.model ?? str(profile.config.defaultModel);
          if (sourceModel && targetModel && modelFamily(sourceModel) !== modelFamily(targetModel)) {
            throw new AppError('NATIVE_PROFILE_SWITCH_MODEL', 'A conversation moves to another provider within its model line; hand it off instead', 409);
          }
          // Persist who still owns the turn before the service saves the target selection.
          host.updateSession(session.id, { configPending: true, nativeRuntime: { ...current.nativeRuntime, profileId: actualId } });
          return resolved;
        }
        if (current.configPending && actualId === profile.id) {
          host.updateSession(session.id, { configPending: false });
          this.profileSwitchFailures.delete(session.id);
        }
      }
      if (runtime?.transport?.isOnline && !runtime.connection.canRunWith(host.getProject(session.projectId), profile)) runtime.connection.deferWriteBlocked(host.getProject(session.projectId), profile);
      // A map entry is not a working runtime: `onExit` deliberately keeps the handle of a dead
      // transport around so a later reopen can dispose it. Pushing the patch into such a zombie
      // would resume on a dead socket, throw, and take the caller's record write down with it —
      // leaving the reader with an error and no remembered intent for the very change people make
      // when a provider misbehaves. Echoing the patch instead is the deliberate degradation: the
      // caller records it, and the next open/send rebuilds the runtime from that record.
      // Codex defers changes during a turn because it configures through resume. TRAE's dedicated
      // settings setter safely updates subsequent turns and the attached TUI while a turn runs.
      if (runtime?.connection.canRunWith(host.getProject(session.projectId), profile) && runtime.transport?.isOnline && (this.flavor.id === 'traex' || runtime.status.phase !== 'busy')) {
        const current = host.getSession(session.id);
        const effective = await runtime.applyThreadConfig({
          model: patch.model ?? current.model,
          approval: normalizePermission(patch.approval ?? current.approval, this.flavor.id),
          ...(this.flavor.modes.length ? { mode: resolved.mode ?? current.mode } : {}),
        }, patch.approval !== undefined || current.configPending === true);
        if (this.flavor.id === 'traex') {
          if (effective.approval !== undefined) resolved.approval = effective.approval;
          if (effective.mode !== undefined) resolved.mode = effective.mode;
        }
        if (this.flavor.id === 'traex' && host.getSession(session.id).configPending) host.updateSession(session.id, { configPending: false });
        resolved.nativeSessionId = runtime.nativeSessionId;
        if (runtime.terminalId) resolved.terminalId = runtime.terminalId;
      } else if (this.flavor.id === 'traex' && patch.approval !== undefined) {
        // Remember an offline permission switch so reconnecting cannot adopt the old native mode.
        host.updateSession(session.id, { configPending: true });
      }
      return resolved;
    });
  }

  /** Without a loaded runtime the session's recorded colours are applied when it next opens. */
  async relaunchForAppearance(host: NativeBackendHost, session: Session): Promise<void> {
    await host.withSessionLock(session.id, async () => { await this.runtimes.get(session.id)?.terminal.relaunchTuiForAppearance(); });
  }

  listModels(_host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig, session?: Session): Promise<ModelInfo[]> {
    return listModelsOf({ flavor: this.flavor, consumesProtocols: this.traits.consumesProtocols ?? [], withTransport: (project, profile, session, read) => this.withTransport(project, profile, session, read) }, project, profile, session);
  }

  usage(_host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig, session?: Session): Promise<NativeBackendUsage> {
    return usageOf({ flavor: this.flavor, withTransport: (project, profile, session, read) => this.withTransport(project, profile, session, read) }, project, profile, session);
  }

  slashItems(host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig): Promise<NativeSlashItem[]> {
    return this.skills.slashItems(host, project, profile);
  }




  private async withManagementTransport<T>(project: Project | undefined, profile: NativeBackendProfileConfig, action: (transport: CodexAppServerClient) => Promise<T>): Promise<T> {
    assertSupportedProfile(profile, this.flavor);
    // A management process has no conversation and needs no workspace trust override.
    const transport = await this.startAppServer({
      executable: executableOf(profile, this.flavor), args: [],
      cwd: await queryDirectory(project, profile), env: { ...process.env, ...this.flavor.env({ configDir: profile.config.configDir }) },
      onNotification: () => undefined, onServerRequest: async () => { throw new Error('Management requires interactive authorization'); }, onExit: () => undefined,
    });
    try { return await action(transport); }
    finally { await transport.dispose(); }
  }

  /** The session's live app-server when it has one, otherwise a short-lived one for this read. */
  private async withTransport<T>(project: Project | undefined, profile: NativeBackendProfileConfig, session: Session | undefined, read: (transport: CodexAppServerClient) => Promise<T>, extraArgs: string[] = []): Promise<T> {
    assertSupportedProfile(profile, this.flavor);
    const existing = session ? this.runtimes.get(session.id)?.transport : undefined;
    if (existing?.isOnline) return await read(existing);
    const transport = await this.startAppServer({
      executable: executableOf(profile, this.flavor),
      args: [...this.flavor.args(profile.config), ...(project ? codexTrustArgs(project.cwd) : []), ...extraArgs],
      cwd: await queryDirectory(project, profile),
      env: providerEnv(profile, this.flavor),
      onNotification: () => undefined,
      onServerRequest: async request => { throw new Error(`Unsupported ${this.label} request: ${request.method}`); },
      onExit: () => undefined,
    });
    try { return await read(transport); }
    finally { await transport.dispose(); }
  }

  transcript(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): TranscriptSource {
    return this.journalFeeds.source(host, session, profile);
  }

  interaction(_host: NativeBackendHost, session: Session): NativeInteraction | undefined {
    return this.runtimes.get(session.id)?.currentInteraction;
  }

  /**
   * As for Claude: a menu recognized on the TUI screen by shape alone is also what a quoted option
   * list or a suggested reply looks like, and a card nobody waits on can never be answered. Believe
   * the screens that block by themselves (startup modals, the plan confirmation) and otherwise only a
   * menu drawn while a turn is open behind it.
   */
  endorsesScreenDialog(_host: NativeBackendHost, session: Session, dialog: NativeInteraction): boolean {
    const runtime = this.runtimes.get(session.id);
    // TRAE reports command approvals through the app-server once it is connected; its four-option
    // screen is that same request drawn again. Before the connection exists the screen is the only
    // approval surface, so it stays readable.
    if (this.flavor.id === 'traex' && runtime?.transport?.isOnline
      && dialog.title.replace(/^(?:⚠️?\s*)/, '').trim() === TRAE_COMMAND_PERMISSION) return false;
    if (isKnownBlockingTitle(dialog.title)) return true;
    return Boolean(runtime && (runtime.activeTurnId || runtime.status.phase === 'busy' || runtime.status.phase === 'attention'));
  }

  ownedForegroundTurn(session: Session) {
    return this.runtimes.get(session.id)?.ownedForegroundTurn();
  }

  status(host: NativeBackendHost, session: Session, profile?: NativeBackendProfileConfig): NativeStatus {
    const runtime = this.runtimes.get(session.id);
    const observed = this.profileSwitchPending(session) ? { ...session, backendProfileId: session.nativeRuntime!.profileId } : session;
    const desired = host.getProfile?.(observed) ?? profile;
    if (runtime && desired) runtime.connection.syncSessionBinding(session, host.getProject(session.projectId), this.activeProfile(host, session, desired));
    return runtime?.status ?? { phase: 'offline' };
  }

  subscribe(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, listener: (message: NativeControlMessage) => void): () => void {
    return this.listeners.subscribe(host, session, profile, listener);
  }

  async dispose(host: NativeBackendHost, sessionId: string): Promise<void> {
    clearTimeout(this.profileSwitchTimers.get(sessionId));
    this.profileSwitchTimers.delete(sessionId);
    this.profileSwitchFailures.delete(sessionId);
    const pending = this.creating.get(sessionId);
    if (pending) await pending.promise.catch(() => undefined);
    this.listeners.clear(sessionId);
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    this.runtimes.delete(sessionId);
    await runtime.dispose(host);
  }

  async prewarm(host: NativeBackendHost, project: Project, profile: NativeBackendProfileConfig, request: Omit<NativePrewarmRequest, 'project' | 'backendProfileId'>): Promise<NativePrewarmResult> {
    if (this.closing) return { state: 'skipped', reason: 'closing' };
    if (this.runtimeHooks?.runtimeHooks(this.flavor.id).length) return { state: 'skipped', reason: 'runtime_hooks' };
    if (this.flavor.unsupportedProfileSetting(profile.config)) return { state: 'skipped', reason: 'profile_unsupported' };
    const source = modelSourceOf(profile.config);
    if (source && resolveSource(source, profile.config).reason) return { state: 'skipped', reason: 'model_source_unavailable' };
    // The tools are known once the thread has its server; until then the key matches no conversation.
    const key = warmKey(project, profile, this.flavor, request.model, request.approval, '?');
    return await this.warm.request({ key, ...(request.claimId ? { claimId: request.claimId } : {}), ...(request.renewOnly ? { renewOnly: true } : {}) }, ({ signal, alias, lost }) => startCodexWarm({
      start: this.startAppServer, flavor: this.flavor, observation: this.observation, riffetMcp: host.riffetMcp,
      project, profile, model: request.model, approval: request.approval, signal, alias, lost,
    }));
  }

  async releasePrewarm(_host: NativeBackendHost, claimId: string): Promise<void> {
    await this.warm.release(claimId);
  }

  /** The warm app-server of a conversation that would start the same one; the 助理's threads are started for it alone. */
  private takeWarm(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig): Promise<CodexWarm | undefined> {
    if (this.runtimeHooks?.runtimeHooks(this.flavor.id).length || host.standing?.launch(project, session)) return Promise.resolve(undefined);
    return this.warm.take(sessionWarmKey(host, session, project, profile, this.flavor), async warm => {
      // One that exited after it was ready is not handed over: the pool ends it and the conversation starts its own.
      if (!warm.transport.isOnline) throw new Error(`The warm ${this.label} app-server has exited`);
      warm.mcp?.adopt(session.id);
      return warm;
    });
  }

  async close(host: NativeBackendHost): Promise<void> {
    if (this.closeTask) return await this.closeTask;
    this.closing = true;
    this.sideChats.abort();
    for (const timer of this.profileSwitchTimers.values()) clearTimeout(timer);
    this.profileSwitchTimers.clear();
    this.closeTask = (async () => {
      await this.warm.close();
      await Promise.allSettled([...this.creating.values()].map(entry => entry.promise));
      const runtimes = [...this.runtimes.values()];
      this.runtimes.clear();
      // Closing the web service must not stop native turns or their subagents. Their durable
      // socket bindings let the next service instance reconnect to the same writer.
      await Promise.allSettled(runtimes.map(runtime => runtime.dispose(host, { keepRunning: true })));
      this.listeners.clearAll();
      await this.observation?.close();
    })();
    await this.closeTask;
  }

  private async ensureRuntime(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig, forceEndpointCheck = false, reconnectOnly = false): Promise<CodexSessionRuntime> {
    assertSupportedProfile(profile, this.flavor);
    if (this.closing) throw new Error(`${this.label} adapter is shutting down`);
    session = host.getSession(session.id);
    profile = this.activeProfile(host, session, profile);
    this.scheduleProfileSwitch(host, session.id);
    if (session.projectId !== project.id) {
      throw new AppError('NATIVE_PROJECT_CHANGED', `This session moved to a different project while ${this.label} was reconnecting. Reload the session and retry.`, 409);
    }
    const pending = this.creating.get(session.id);
    if (pending) {
      const matches = pending.projectId === project.id && pending.fingerprint === runtimeFingerprintFor(project, profile, this.flavor);
      if (matches) {
        const runtime = await pending.promise;
        // A send may join a read-only reconnect, whose cached scan is not a fresh write check.
        if (forceEndpointCheck) await runtime.terminal.endpointState(true);
        return runtime;
      }
      await pending.promise.catch(() => undefined);
      if (this.creating.get(session.id) === pending) await new Promise<void>(resolve => queueMicrotask(resolve));
      return await this.ensureRuntime(host, host.getSession(session.id), project, profile, forceEndpointCheck, reconnectOnly);
    }
    const task = Promise.resolve().then(async () => {
      let current = this.runtimes.get(session.id);
      const probe = await current?.probeEndpoint(session, project, profile, forceEndpointCheck);
      // A runtime that replaced this one while its terminal was being checked is the one judged.
      if (probe) current = this.runtimes.get(session.id);
      if (current) {
        if (current.reuseVerdict(session, project, profile, probe) === 'keep') return current;
        this.runtimes.delete(session.id);
        // A profile switch must never stop a live terminal or its app-server. Detach this client's
        // socket and let the verified terminal endpoint select the existing owner below.
        await current.dispose(host, { keepRunning: true });
      }
      const runtime = new CodexSessionRuntime(host, session, project, profile, this.startAppServer, this.flavor, this.runtimeHooks, this.observation);
      runtime.attachFeed(this.journalFeeds.feedOf(session.id));
      await runtime.start({ reconnectOnly, warm: () => this.takeWarm(host, session, project, profile) });
      this.runtimes.set(session.id, runtime);
      await this.listeners.bind(session.id, runtime);
      return runtime;
    });
    const entry: PendingRuntime = {
      projectId: project.id,
      fingerprint: runtimeFingerprintFor(project, profile, this.flavor),
      promise: task,
    };
    this.creating.set(session.id, entry);
    try { return await task; }
    finally { if (this.creating.get(session.id) === entry) this.creating.delete(session.id); }
  }
}

async function renderInput(host: NativeBackendHost, input: NativeBackendSendRequest['input']): Promise<{ input: unknown[]; images: unknown[]; renderedText: string }> {
  const lines = [input.text];
  for (const context of input.context) lines.push(`@${context.path}${context.line ? `:${context.line}` : ''}`);
  const images: unknown[] = [];
  for (const id of input.attachmentIds) {
    const { attachment, data } = await host.readAttachment(id);
    if (/^image\//i.test(attachment.mimeType)) images.push({ type: 'localImage', path: attachment.path });
    else lines.push(`@${await materializeAttachment(attachment, data, { durable: true })}`);
  }
  const renderedText = lines.join('\n');
  return { input: [{ type: 'text', text: renderedText, text_elements: [] }], images, renderedText };
}
