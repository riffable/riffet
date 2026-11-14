import { readContextFile } from '../../context-references/read-file.js';
import { projectShareRollout } from './share-read.js';
import { queryDirectory } from '../shared/query-directory.js';
import { readFile, stat } from 'node:fs/promises';
import { readCodexShare } from './share-read.js';
import { homedir } from 'node:os';
import { basename, resolve as resolvePath } from 'node:path';
import { EXTERNAL_CACHE_MS, holderOf, listExternalThreads, scanProcesses, type ProcessRow } from './external.js';
import type {
  CommandObservation, ModelInfo, NativeActivity, NativeBackendCapabilities, NativeBackendUsage, NativeInteraction, NativeInteractionResponse, NativeInteractionResult, NativeRuntimeActionRequest,
  LoadedExtensions, NativeSlashItem, NativeStatus, NativeStopRequest, NativeTurnTarget, Project, Session,
} from '../../../../../packages/contracts/src/index.js';
import type { CodexAppServerClient, CodexAppServerFactory } from '../shared/codex-app-server.js';
import { referencedSkills, slashTokens } from '../shared/slash-tokens.js';
import { commandIdOfMessageId } from './message-tag.js';
import { asArray, asRecord, str } from './util.js';
import { CodexAppServer as CodexAppServerProcess } from '../shared/codex-app-server.js';
import { codexFlavor, usesOwnProvider, type CodexFlavor } from './flavors.js';
import { fetchGatewayModels } from '../shared/gateway-models.js';
import { findCodexRollout, parseRolloutUsage } from './rollout-usage.js';
import type { UsageTranscript } from '../../stats/types.js';
import { codexTrustArgs } from '../shared/cli-trust.js';
import { describeSearch, resolveCliExecutable } from '../shared/cli-resolve.js';
import { AppError } from '../../errors.js';
import { materializeAttachment } from '../attachments.js';
import type {
  ExternalHolder, ExternalSessionEntry, ExternalSessionScan, NativePtyLaunchSpec,
  NativeBackendAvailability, NativeBackendConfigurePatch, NativeBackendConfigureResult, NativeBackendDriver, NativeBackendHost, NativeDriverCommandObservation, NativeBackendOpenOptions, NativeBackendOpenResult, NativeBackendProfileConfig,
  NativeBackendSendRequest, NativeBackendTraits, NativeControlMessage,
  NativeDriverExtensions, NativeDriverExternal, NativeDriverStored,
} from '../types.js';
import type { CliVersionRange } from '../shared/cli-version.js';
import {
  MAX_ROLLOUT_BYTES, normalizePermission, configuredCommand, executableOf, runtimeFingerprintFor, matchesRuntimeFingerprint, assertSupportedProfile, providerEnv,
  collaborationModeOf, probeAppServer, STEER_MIN_VERSIONS, supportsSteerVersion,
} from './config.js';
import { listModels, readUsage } from './catalog.js';
import { parseCodexNativeCommand, codexNativeSlashItems } from './commands.js';
import { modelSourceOf, prepareSource, resolveSource, sourceCatalog } from '../shared/model-source.js';
import { modelFamily } from '../shared/model-selection.js';
import { extensionDiagnostic, fileRuntimeEntries, readConfiguredMcpNames, readMcpRuntime, readMcpServers } from './extensions.js';
import { RIFFET_MCP_NAME } from '../../riffet-mcp/service.js';
import { safeProviderError, safeTurnError } from './errors.js';
import { isKnownBlockingTitle } from '../../agent-host/interaction-choice.js';
import { CodexSessionRuntime, type NativeRuntimeHooks } from './runtime.js';
import { rolloutItemSpans } from './item-spans.js';
import { CodexTranscriptSource, type CodexLiveFeed } from './transcript-source.js';
import { codexObservation, type CodexObservation } from './observation.js';
import type { TranscriptSource } from '../../journal/ingest.js';
import type { RpcItem } from './types.js';

/** How long the settings page is answered from the last read of whether commands are observed. */
const OBSERVATION_READ_MS = 5 * 60_000;

const startNativeAppServer: CodexAppServerFactory = options => CodexAppServerProcess.start(options);

const PROFILE_ID = 'local';
/** How long a rollout must sit unwritten before its last turn is taken as finished. */
const ROLLOUT_QUIET_MS = 60_000;
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

type NativeListener = (message: NativeControlMessage) => void;

interface CodexSessionListeners {
  listeners: Set<NativeListener>;
  unsubscriptions: Map<NativeListener, () => void>;
  runtime?: CodexSessionRuntime;
  binding?: Promise<void>;
}

/**
 * A Codex turn is settled by its own `turn/completed`, never by an idle status; closing the driver
 * detaches the reusable app-server that per-session disposal would stop.
 */
export const CODEX_TRAITS: NativeBackendTraits = { completesOnTurnEvent: true, survivesRestart: true, offlineMayBeRunning: true, closesSessionsItself: true, resumesByNativeId: true, riffetTools: true, extensionToggles: { mcp: true, skills: false }, consumesProtocols: ['openai-responses'] };

export class CodexBackendAdapter implements NativeBackendDriver {
  readonly extensions: NativeDriverExtensions = {
    loaded: (host, project, profile) => this.loadedExtensions(host, project, profile),
    runtime: (host, project, profile) => this.extensionRuntime(host, project, profile),
    skillStates: (host, project, profile) => this.skillStates(host, project, profile),
    setSkillEnabled: (host, project, profile, path, enabled) => this.setSkillEnabled(host, project, profile, path, enabled),
    reload: (host, project, profile) => this.reloadExtensions(host, project, profile),
    authorizeMcp: (host, project, profile, name) => this.authorizeMcp(host, project, profile, name),
  };
  readonly external: NativeDriverExternal = {
    list: (host, profile, options) => this.listExternalSessions(host, profile, options),
    holder: (host, profile, id) => this.externalHolder(host, profile, id),
    terminalLaunch: (host, session, project, profile) => this.terminalLaunch(host, session, project, profile),
    resumeCommand: (session, profile) => this.resumeCommand(session, profile),
  };
  readonly stored: NativeDriverStored = {
    usage: (host, session, profile, known) => this.usageTranscript(host, session, profile, known),
    context: (host, session, profile, options) => this.readContextTranscript(host, session, profile, options),
    share: (host, session, profile, options) => this.readShareTranscript(host, session, profile, options),
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
  private readonly sessionListeners = new Map<string, CodexSessionListeners>();
  /** The journal's transcript sources following each session's runtime (`transcript`). */
  private readonly feeds = new Map<string, Set<CodexLiveFeed>>();
  /** Last confirmed skill names distinguish inline invocations from prose during a catalog outage. */
  private readonly knownSkillNames = new Map<string, Set<string>>();
  /** Recent `listExternalSessions` results: a scan starts a management app-server. */
  private readonly externalScans = new Map<string, { at: number; entries: ExternalSessionEntry[] }>();
  private closing = false;
  private closeTask: Promise<void> | undefined;
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
      // Read, and trusted, through a management server started with the same hooks a conversation's server gets:
      // the trust is keyed by what the hooks are, so it holds for every later launch.
      const observation = this.observation;
      // A read starts a server, so a settings page shown again within a few minutes is answered from the last one.
      const read = new Map<string, { at: number; state: CommandObservation['state'] }>();
      const cacheKey = (profile: NativeBackendProfileConfig) => JSON.stringify([executableOf(profile, this.flavor), resolvePath(this.flavor.stateHome(profile.config))]);
      const through = async (profile: NativeBackendProfileConfig, act: (transport: CodexAppServerClient, cwd: string) => Promise<CommandObservation['state']>): Promise<CommandObservation> => {
        const executable = executableOf(profile, this.flavor);
        const hooks = await observation.launchArgs(executable);
        if (!hooks.length) return { state: 'unsupported' };
        const cwd = await queryDirectory(undefined, profile);
        const state = await this.withTransport(undefined, profile, undefined, transport => act(transport, cwd), hooks);
        read.set(cacheKey(profile), { at: Date.now(), state });
        return { state };
      };
      this.commandObservation = {
        state: async (_host, profile) => {
          const known = read.get(cacheKey(profile));
          if (known && Date.now() - known.at < OBSERVATION_READ_MS) return { state: known.state };
          return await through(profile, (transport, cwd) => observation.probe(transport, cwd));
        },
        trust: (_host, profile) => through(profile, (transport, cwd) => observation.trust(transport, cwd)),
      };
    }
    this.id = flavor.id;
    this.label = flavor.label;
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
    let released = false;
    this.restarting.add(sessionId);
    const task = Promise.resolve().then(async () => {
      try {
        await replacement.start();
        if (!await previous.releaseForProfileSwitch()) { await replacement.dispose(host); return previous; }
        released = true;
        host.updateSession(sessionId, { terminalId: undefined });
        replacement.attachFeed(this.feedOf(sessionId));
        await replacement.openOrResume();
        this.runtimes.set(sessionId, replacement);
        const updated = host.updateSession(sessionId, { configPending: false, terminalId: undefined });
        host.emit(sessionId, { type: 'session', session: updated });
        await this.bindListeners(sessionId, replacement).catch(error => replacement.profileSwitchFailed(safeProviderError(error, target.config)));
        await replacement.ensureTui().catch(error => replacement.profileSwitchFailed(safeProviderError(error, target.config)));
        this.profileSwitchFailures.delete(sessionId);
        return replacement;
      } catch (error) {
        await replacement.dispose(host).catch(() => undefined);
        let restored = previous;
        if (released) {
          // The failed target never receives user input. Restore the old writer, retain the
          // desired provider and pending flag, and let an explicit retry attempt it again.
          restored = new CodexSessionRuntime(host, { ...host.getSession(sessionId), nativeRuntime: undefined, terminalId: undefined }, project, source, this.startAppServer, this.flavor, this.runtimeHooks, this.observation);
          restored.attachFeed(this.feedOf(sessionId));
          this.runtimes.set(sessionId, restored);
          try {
            await restored.start();
            await restored.openOrResume({ model: previousModel });
            await this.bindListeners(sessionId, restored);
            await restored.ensureTui();
          } catch { /* The persisted source binding and original thread remain recoverable. */ }
        }
        restored.profileSwitchFailed(safeProviderError(error, target.config));
        this.profileSwitchFailures.add(sessionId);
        throw new AppError('NATIVE_PROFILE_SWITCH_FAILED', safeProviderError(error, target.config), 502);
      }
    });
    const entry = { projectId: project.id, fingerprint: runtimeFingerprintFor(project, source, this.flavor), promise: task };
    this.creating.set(sessionId, entry);
    try { await task; return !this.profileSwitchPending(host.getSession(sessionId)); }
    finally { this.restarting.delete(sessionId); if (this.creating.get(sessionId) === entry) this.creating.delete(sessionId); }
  }

  async capabilities(_host: NativeBackendHost, profile: NativeBackendProfileConfig): Promise<NativeBackendCapabilities> {
    // Probe results are shared with availability/TUI discovery and cached per executable. Never
    // test steering by writing to a user's live turn; unrecognized or older builds stay disabled.
    const supportsSteer = supportsSteerVersion((await probeAppServer(executableOf(profile, this.flavor))).version, this.flavor.id);
    return {
      supportsSessionReferences: this.flavor.id === 'codex',
      backendId: this.id,
      label: this.label,
      modes: this.flavor.modes,
      permissions: this.flavor.id === 'traex' ? [
        { id: 'on-request', label: 'Workspace Edit' },
        { id: 'auto-review', label: 'Auto Mode' },
        { id: 'danger-full-access', label: 'Full Access' },
        { id: 'read-only', label: 'Read Only' },
      ] : [
        { id: 'on-request', label: 'Default', description: 'Edits the workspace freely; asks before going outside it or onto the network' },
        { id: 'read-only', label: 'Read only', description: 'Reads anything; asks before every edit or command that needs more' },
        { id: 'danger-full-access', label: 'Full access', description: 'No sandbox and never asks: edits and network anywhere' },
      ],
      interactionTransport: 'protocol',
      supportsResume: true,
      supportsInterrupt: true,
      // Both flavors require a verified version and uniquely attributable native input receipts.
      supportsSteer,
      supportsHistory: true,
      supportsModelSelection: true,
      supportsModeSelection: this.flavor.modes.length > 0,
      supportsPermissionSelection: true,
      supportsTerminal: true,
      supportsPrewarm: false,
      slashCommands: this.flavor.id === 'codex' ? codexNativeSlashItems() : [],
      inlineSkills: true,
    };
  }

  async available(_host: NativeBackendHost, profile: NativeBackendProfileConfig): Promise<NativeBackendAvailability> {
    const unsupported = this.flavor.unsupportedProfileSetting(profile.config);
    if (unsupported) return { available: false, reason: unsupported };
    const source = modelSourceOf(profile.config);
    const sourceReason = source && resolveSource(source, profile.config).reason;
    if (sourceReason) return { available: false, reason: sourceReason };
    const executable = executableOf(profile, this.flavor);
    let probe;
    try {
      probe = await probeAppServer(executable);
    } catch (error) {
      const resolution = resolveCliExecutable({ command: configuredCommand(profile, this.flavor) });
      const code = (error as NodeJS.ErrnoException).code;
      const detail = resolution.resolved ? ` (${typeof code === 'string' ? code : 'process error'})` : `${describeSearch(resolution)} Set this profile’s executable to an absolute path.`;
      return { available: false, reason: `${this.label} could not be started from “${executable}”.${detail}` };
    }
    const reason = this.flavor.unavailableReason(probe, executable);
    const version = probe.version ? { version: probe.version } : {};
    if (reason) return { available: false, reason, ...version };
    return { available: true, ...version };
  }

  async openOrResume(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig, options: NativeBackendOpenOptions = {}): Promise<NativeBackendOpenResult> {
    return await host.withSessionLock(session.id, async () => {
      await this.applyProfileSwitch(host, session.id);
      session = host.getSession(session.id);
      profile = this.activeProfile(host, session, profile);
      let runtime = await this.ensureRuntime(host, session, project, profile, true);
      if (!runtime.canRunWith(project, profile)) {
        runtime.deferWriteBlocked(project, profile);
        return { ...(runtime.nativeSessionId ? { nativeSessionId: runtime.nativeSessionId } : {}), ...(runtime.terminalId ? { terminalId: runtime.terminalId } : {}), status: runtime.status };
      }
      if (options.restartFingerprint && runtime.status.profilePending
        && host.getSession(session.id).nativeRuntime?.fingerprint === options.restartFingerprint
        && host.getSession(session.id).nativeRuntime?.address === options.restartAddress) {
        const previous = runtime;
        this.restarting.add(session.id);
        const promise = Promise.resolve().then(async () => {
          if (!await previous.restartBackend(options.restartFingerprint!, options.restartAddress!)) return previous;
          this.runtimes.delete(session.id);
          const replacement = new CodexSessionRuntime(host, host.getSession(session.id), project, profile, this.startAppServer, this.flavor, this.runtimeHooks, this.observation);
          replacement.attachFeed(this.feedOf(session.id));
          await replacement.start();
          this.runtimes.set(session.id, replacement);
          await this.bindListeners(session.id, replacement);
          return replacement;
        });
        const entry = { projectId: project.id, fingerprint: runtimeFingerprintFor(project, profile, this.flavor), promise };
        this.creating.set(session.id, entry);
        try { runtime = await promise; }
        finally { this.restarting.delete(session.id); if (this.creating.get(session.id) === entry) this.creating.delete(session.id); }
      }
      if (!runtime.canRunWith(project, profile)) {
        runtime.deferWriteBlocked(project, profile);
        return { ...(runtime.nativeSessionId ? { nativeSessionId: runtime.nativeSessionId } : {}), ...(runtime.terminalId ? { terminalId: runtime.terminalId } : {}), status: runtime.status };
      }
      const nativeSessionId = await runtime.openOrResume();
      await runtime.ensureTui();
      // A colour change recorded while no runtime was loaded (or a TUI from before it) applies now.
      await runtime.relaunchTuiForAppearance();
      const terminalId = runtime.terminalId;
      return { nativeSessionId, ...(terminalId ? { terminalId } : {}), status: runtime.status };
    });
  }

  async send(host: NativeBackendHost, request: NativeBackendSendRequest): Promise<void> {
    const sourceText = request.sourceText ?? request.input.text;
    const command = this.flavor.id === 'codex' ? parseCodexNativeCommand(sourceText) : undefined;
    if (command && (request.input.attachmentIds.length || request.input.context.length || request.input.references?.length)) {
      throw new AppError('NATIVE_COMMAND_ARGUMENTS', 'Remove attachments and context references before running this command.', 400);
    }
    await host.withSessionLock(request.session.id, async () => {
      if (!await this.applyProfileSwitch(host, request.session.id)) {
        throw new AppError('CLI_BUSY', 'The current task is still running; the provider change will apply when it finishes.', 409);
      }
      const runtime = await this.ensureRuntime(host, request.session, request.project, request.profile, true);
      if (!runtime.canRunWith(request.project, request.profile)) {
        const blocked = runtime.deferWriteBlocked(request.project, request.profile);
        throw new AppError(blocked.code, blocked.message, 409);
      }
      const nativeSessionId = await runtime.openOrResume();
      await runtime.ensureTui();
      const { input, images, renderedText } = await renderInput(host, request.input);
      const skills = command ? [] : await this.skillInputs(runtime.transport, request.project.cwd, request.profile, sourceText);
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

  async steer(host: NativeBackendHost, request: NativeBackendSendRequest & { target: NativeTurnTarget }): Promise<void> {
    await host.withSessionLock(request.session.id, async () => {
      if (!(await this.capabilities(host, request.profile)).supportsSteer) throw new AppError('STEER_UNSUPPORTED', `${this.label} requires a verified CLI version (${STEER_MIN_VERSIONS[this.flavor.id]} or newer) with attributable in-flight input receipts.`, 409);
      const session = host.getSession(request.session.id);
      if (session.nativeSessionId !== request.target.nativeSessionId) throw new AppError('STEER_TARGET_CHANGED', 'The target conversation changed.', 409);
      // Reconnect only to a verified existing endpoint: this path must never spawn a new server.
      const profile = this.activeProfile(host, session, request.profile);
      const runtime = await this.ensureRuntime(host, session, request.project, profile, true, true);
      if (!runtime.canRunWith(request.project, profile)) {
        const blocked = runtime.deferWriteBlocked(request.project, profile);
        throw new AppError(blocked.code, blocked.message, 409);
      }
      if (!runtime.steerTarget) await runtime.prime();
      await runtime.attachLoadedOwner();
      const { input, images, renderedText } = await renderInput(host, request.input);
      const skills = await this.skillInputs(runtime.transport, request.project.cwd, request.profile, request.sourceText ?? request.input.text, true);
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
      if (!runtime.canRunWith(project, profile)) {
        const blocked = runtime.deferWriteBlocked(project, profile);
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
      if (!runtime.canRunWith(project, profile)) {
        const blocked = runtime.deferWriteBlocked(project, profile);
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
      if (!runtime.canRunWith(project, profile)) {
        const blocked = runtime.deferWriteBlocked(project, profile);
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
      if (!runtime.canRunWith(project, profile)) {
        const blocked = runtime.deferWriteBlocked(project, profile);
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
      if (runtime?.transport?.isOnline && !runtime.canRunWith(host.getProject(session.projectId), profile)) runtime.deferWriteBlocked(host.getProject(session.projectId), profile);
      // A map entry is not a working runtime: `onExit` deliberately keeps the handle of a dead
      // transport around so a later reopen can dispose it. Pushing the patch into such a zombie
      // would resume on a dead socket, throw, and take the caller's record write down with it —
      // leaving the reader with an error and no remembered intent for the very change people make
      // when a provider misbehaves. Echoing the patch instead is the deliberate degradation: the
      // caller records it, and the next open/send rebuilds the runtime from that record.
      // Codex defers changes during a turn because it configures through resume. TRAE's dedicated
      // settings setter safely updates subsequent turns and the attached TUI while a turn runs.
      if (runtime?.canRunWith(host.getProject(session.projectId), profile) && runtime.transport?.isOnline && (this.flavor.id === 'traex' || runtime.status.phase !== 'busy')) {
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
    await host.withSessionLock(session.id, async () => { await this.runtimes.get(session.id)?.relaunchTuiForAppearance(); });
  }

  async listModels(_host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig, session?: Session): Promise<ModelInfo[]> {
    // A named source publishes its own catalog over HTTP, so it is answered without starting an
    // app-server — and for some sources it is the only answer there is, since their models are not
    // in any Codex-side listing.
    const source = modelSourceOf(profile.config);
    if (source) return await sourceCatalog(source, this.traits.consumesProtocols ?? [], profile.config);
    const builtIn = () => this.withTransport(project, profile, session, transport => listModels(transport, this.flavor));
    // A typed endpoint with a key is a provider of its own: the app-server's `model/list` still
    // answers from Codex's built-in OpenAI catalog and never asks it, so the gateway says which
    // models exist. Many gateways list bare ids, so a model Codex also knows keeps Codex's effort
    // ladder and Fast tier; listing it also teaches the driver that tier's request value.
    if (this.flavor.id === 'codex' && usesOwnProvider(profile.config)) {
      const apiKey = str(profile.config.apiKey);
      const [served, known] = await Promise.all([
        fetchGatewayModels({ baseUrl: str(profile.config.apiEndpoint)!, ...(apiKey ? { apiKey } : {}), reasoningLevels: true }),
        builtIn().catch(() => [] as ModelInfo[]),
      ]);
      const byId = new Map(known.map(model => [model.value, model]));
      return served.map(model => {
        const codex = byId.get(model.value);
        if (!codex) return model;
        // The gateway's declared ladder is what it accepts; Codex's fills in when it declares none.
        const own = new Set(model.configOptions.map(option => option.id));
        return { ...model, name: model.name === model.value ? codex.name : model.name, configOptions: [...model.configOptions, ...codex.configOptions.filter(option => !own.has(option.id))] };
      });
    }
    return await builtIn();
  }

  async usage(_host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig, session?: Session): Promise<NativeBackendUsage> {
    // TRAE's managed runtime route stops the CLI from publishing its internal daily bindings, so
    // usage reads through a fresh read-only CLI with the same profile instead of a live session.
    // Explicit profile or global configuration still reaches that CLI through the normal env.
    const live = this.flavor.id === 'traex' ? undefined : session;
    return await this.withTransport(project, profile, live, transport => readUsage(transport, this.flavor, { account: !usesOwnProvider(profile.config) }));
  }

  async slashItems(_host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig): Promise<NativeSlashItem[]> {
    const cwd = await queryDirectory(project, profile);
    const items = await this.withTransport(project, profile, undefined, transport => listSkills(transport, cwd));
    this.rememberSkillNames(cwd, profile, items);
    return items;
  }

  private async loadedExtensions(_host: NativeBackendHost, project: Project, profile: NativeBackendProfileConfig): Promise<Omit<LoadedExtensions, 'checkedAt'>> {
    const cwd = await queryDirectory(project, profile);
    return await this.withTransport(project, profile, undefined, async transport => {
      const [servers, configured, skills] = await Promise.all([readMcpServers(transport), readConfiguredMcpNames(transport, cwd), listSkills(transport, cwd)]);
      return {
        // Plugin and app servers are listed by the app-server but cannot be switched off per thread (`readConfiguredMcpNames`).
        mcp: servers.filter(server => server.name !== RIFFET_MCP_NAME && configured.has(server.name)),
        skills: skills.map(skill => ({ name: skill.name, ...(skill.description ? { description: skill.description } : {}) })),
      };
    });
  }

  private async extensionRuntime(_host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig): Promise<import('../../../../../packages/contracts/src/index.js').ExtensionRuntimeReport> {
    const report: import('../../../../../packages/contracts/src/index.js').ExtensionRuntimeReport = { entries: [], diagnostics: [], checkedAt: new Date().toISOString() };
    if (!project) { report.diagnostics.push('选择项目以查看已运行会话的 MCP 状态。'); return report; }
    const matching = [...this.runtimes].filter(([, runtime]) => runtime.transport?.isOnline && runtime.matches(project, profile));
    await Promise.all(matching.slice(0, 16).map(async ([sessionId, runtime]) => {
      const transport = runtime.transport!;
      const results = await Promise.allSettled([
        readMcpRuntime(transport, sessionId, runtime.nativeSessionId),
        transport.request('skills/list', { cwds: [project.cwd], forceReload: true }, 10_000).then(value => fileRuntimeEntries(value, 'skill', sessionId)),
        transport.request('hooks/list', { cwds: [project.cwd] }, 10_000).then(value => fileRuntimeEntries(value, 'hook', sessionId)),
      ]);
      for (const result of results) if (result.status === 'fulfilled') report.entries.push(...result.value); else report.diagnostics.push(`${sessionId}: ${extensionDiagnostic(result.reason)}`);
    }));
    if (!matching.length) report.diagnostics.push('没有与当前项目和配置匹配的在线连接；运行状态未知。');
    if (matching.length > 16) report.diagnostics.push('当前仅展示前 16 个匹配的在线会话。');
    if (report.entries.some(entry => entry.kind === 'hook')) report.diagnostics.push('Hook 目录描述原生发现结果；信任状态不代表用户已在 Riffet 中审核，执行还受会话启动策略影响。');
    return report;
  }

  private async skillStates(_host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig): Promise<Array<{ path: string; enabled: boolean }>> {
    return await this.withManagementTransport(project, profile, async transport => {
      const response = await transport.request<unknown>('skills/list', { cwds: [project?.cwd ?? homedir()], forceReload: true }, 15_000);
      const states: Array<{ path: string; enabled: boolean }> = [];
      for (const group of asArray<unknown>(asRecord(response)?.data)) {
        for (const raw of asArray<unknown>(asRecord(group)?.skills)) {
          const skill = asRecord(raw);
          const path = str(skill?.path);
          // Older or partial responses must leave state unknown rather than infer enabled.
          if (path && typeof skill?.enabled === 'boolean') states.push({ path, enabled: skill.enabled });
        }
      }
      return states;
    });
  }

  private async setSkillEnabled(_host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig, path: string, enabled: boolean): Promise<void> {
    await this.withManagementTransport(project, profile, async transport => {
      await transport.request('skills/config/write', { path, enabled }, 15_000);
    });
  }

  private async listExternalSessions(host: NativeBackendHost, profile: NativeBackendProfileConfig, options: ExternalSessionScan): Promise<ExternalSessionEntry[]> {
    const key = `${profile.id}:${options.includeNonInteractive}:${options.limit}`;
    let cached = this.externalScans.get(key);
    if (!cached || Date.now() - cached.at > EXTERNAL_CACHE_MS) {
      const entries = await this.withManagementTransport(undefined, profile, async transport => {
        // A slow start or page must not outlive the caller.
        const aborted = new Promise<never>((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
        aborted.catch(() => undefined);
        return await Promise.race([
          listExternalThreads(params => transport.request<unknown>('thread/list', params, 30_000), options),
          aborted,
        ]);
      });
      cached = { at: Date.now(), entries };
      this.externalScans.set(key, cached);
    }
    // Who holds a thread changes faster than the list, so it is read on every call, in one `ps` scan.
    const rows = await scanProcesses();
    return cached.entries.map(entry => {
      const live = this.holderIn(rows, profile, entry.nativeSessionId);
      return live ? { ...entry, live } : entry;
    });
  }

  private async externalHolder(_host: NativeBackendHost, profile: NativeBackendProfileConfig, threadId: string): Promise<ExternalHolder | undefined> {
    return this.holderIn(await scanProcesses(), profile, threadId);
  }

  private holderIn(rows: readonly ProcessRow[], profile: NativeBackendProfileConfig, threadId: string): ExternalHolder | undefined {
    const executables = new Set([this.flavor.command, basename(executableOf(profile, this.flavor))]);
    const own = new Set<string>();
    for (const runtime of this.runtimes.values()) { const address = runtime.transport?.remoteAddress; if (address) own.add(address); }
    return holderOf(rows, threadId, executables, own);
  }

  private async terminalLaunch(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig): Promise<{ spec: NativePtyLaunchSpec; keepsRuntime?: boolean }> {
    const threadId = host.getSession(session.id).nativeSessionId;
    if (!threadId) throw new AppError('NATIVE_SESSION_NOT_STARTED', 'This conversation has not started yet, so there is nothing to continue in a terminal.', 409);
    assertSupportedProfile(profile, this.flavor);
    if (this.flavor.terminalTransport(await probeAppServer(executableOf(profile, this.flavor))) !== 'none') {
      // Riffet keeps the app-server and the loaded thread; only its own TUI is left out, so the terminal is the one client.
      const spec = await host.withSessionLock(session.id, async () => {
        const runtime = await this.ensureRuntime(host, session, project, profile, true);
        if (!runtime.canRunWith(project, profile)) return undefined;
        await runtime.openOrResume();
        return await runtime.tuiLaunchSpec();
      });
      if (spec) return { spec, keepsRuntime: true };
    }
    // No shared transport: a standalone CLI owns the thread and the core stops the runtime first.
    const own: Record<string, string> = {};
    const secret: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.flavor.env(profile.config))) (name === 'CODEX_HOME' || name === 'TRAE_HOME' ? own : secret)[name] = value;
    return {
      spec: {
        command: executableOf(profile, this.flavor),
        args: [...this.flavor.args(profile.config), ...codexTrustArgs(project.cwd), '-c', 'check_for_update_on_startup=false', '--cd', project.cwd, 'resume', threadId],
        env: own,
        ...(Object.keys(secret).length ? { secretEnv: secret } : {}),
        cwd: project.cwd,
        title: this.label,
      },
    };
  }

  private resumeCommand(session: Session, profile: NativeBackendProfileConfig): { argv: string[]; env: Record<string, string>; credentialsOmitted?: boolean } {
    if (!session.nativeSessionId) throw new AppError('NATIVE_SESSION_NOT_STARTED', 'This conversation has not started yet', 409);
    const command = typeof profile.config.executable === 'string' && profile.config.executable.trim() || this.flavor.command;
    const configDir = typeof profile.config.configDir === 'string' && profile.config.configDir.trim();
    const home = this.flavor.id === 'traex' ? 'TRAE_HOME' : 'CODEX_HOME';
    // A gateway profile's provider settings carry its credential; the reader's own login is used instead.
    const gateway = this.flavor.args(profile.config).length > 0 || Object.keys(this.flavor.env(profile.config)).some(name => name !== home);
    return {
      argv: [command, 'resume', session.nativeSessionId],
      env: configDir ? { [home]: configDir } : {},
      ...(gateway ? { credentialsOmitted: true } : {}),
    };
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

  private async reloadExtensions(_host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig): Promise<number> {
    if (!project) return 0;
    const visited = new Set<string>();
    for (const runtime of this.runtimes.values()) {
      const transport = runtime.transport;
      if (!transport?.isOnline || !runtime.matches(project, profile) || visited.has(transport.remoteAddress)) continue;
      await transport.request('config/mcpServer/reload', {}, 15_000);
      visited.add(transport.remoteAddress);
    }
    return visited.size;
  }

  private async authorizeMcp(_host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig, name: string): Promise<string> {
    if (project) for (const [sessionId, runtime] of this.runtimes) {
      if (!runtime.transport?.isOnline || !runtime.matches(project, profile)) continue;
      const servers = await readMcpRuntime(runtime.transport, sessionId, runtime.nativeSessionId);
      if (!servers.some(server => server.name === name)) continue;
      const response = await runtime.transport.request<{ authorizationUrl: string }>('mcpServer/oauth/login', { name, threadId: runtime.nativeSessionId, timeoutSecs: 300 }, 15_000);
      const url = new URL(response.authorizationUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new AppError('EXTENSION_AUTH_URL_INVALID', 'Agent returned an unsupported authorization URL');
      return url.toString();
    }
    throw new AppError('EXTENSION_RUNTIME_REQUIRED', 'Open a conversation that uses this MCP server before authorizing.', 409);
  }

  /**
   * The app-server only loads a skill handed to it as a structured input item; `/name` in the text
   * is just prose to it. Each token naming an enabled skill becomes one, wherever it sits, and the
   * text is left as typed. A failed lookup must not silently drop an invoked skill.
   */
  private rememberSkillNames(cwd: string, profile: NativeBackendProfileConfig, skills: NativeSlashItem[]): void {
    const key = JSON.stringify([cwd, profile.id, profile.config]);
    const names = this.knownSkillNames.get(key) ?? new Set<string>();
    for (const skill of skills) names.add(skill.name);
    this.knownSkillNames.delete(key);
    this.knownSkillNames.set(key, names);
    if (this.knownSkillNames.size > 64) this.knownSkillNames.delete(this.knownSkillNames.keys().next().value!);
  }

  private async skillInputs(transport: CodexAppServerClient | undefined, cwd: string, profile: NativeBackendProfileConfig, text: string, strictSteer = false): Promise<unknown[]> {
    const tokens = slashTokens(text);
    const leading = tokens.find(token => token.start === text.length - text.trimStart().length);
    const rejectCommand = () => new AppError('STEER_REJECTED', 'Steering accepts only messages or enabled skills; use the matching conversation action for CLI commands.', 409);
    const unavailable = () => strictSteer ? rejectCommand() : new AppError('NATIVE_SKILL_CATALOG_UNAVAILABLE', 'Could not verify skills; refresh the skill list and try again.', 503);
    if (!tokens.length) return [];
    const known = this.knownSkillNames.get(JSON.stringify([cwd, profile.id, profile.config]));
    const onUnavailable = (): unknown[] => {
      if (leading || tokens.some(token => known?.has(token.name))) throw unavailable();
      return []; // An unrecognized inline API path is prose, not an asserted skill invocation.
    };
    if (!transport?.isOnline) {
      return onUnavailable();
    }
    let skills: Awaited<ReturnType<typeof listSkills>>;
    try { skills = await listSkills(transport, cwd); }
    catch {
      return onUnavailable();
    }
    this.rememberSkillNames(cwd, profile, skills);
    // The app-server has a skills directory, but no TUI command catalog. Both send paths
    // admit a remaining leading /name only when that native directory identifies an enabled
    // skill. This rejects /model, /clear and unknown commands without maintaining a parallel list;
    // slashTokens excludes full paths such as /usr/bin; inline references remain ordinary prose.
    if (leading && !skills.some(skill => skill.name === leading.name)
      || tokens.some(token => known?.has(token.name) && !skills.some(skill => skill.name === token.name))) {
      throw strictSteer ? rejectCommand() : new AppError('NATIVE_COMMAND_UNSUPPORTED', 'This command or skill is unavailable; use the conversation controls or choose an enabled skill.', 400);
    }
    return referencedSkills(text, skills).map(skill => ({ type: 'skill', name: skill.name, path: skill.path }));
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

  /**
   * The thread as the session journal reads it (`transcript-source.ts`), through the session's
   * runtime: a pull connects it as a snapshot does, and its notifications are the live feed.
   */
  transcript(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): TranscriptSource {
    const sessionId = session.id;
    const threadOf = () => host.getSession(sessionId).nativeSessionId;
    return new CodexTranscriptSource({
      sessionId,
      backend: this.flavor.id,
      ...(this.observation ? { observedChanges: (toolCallId: string) => this.observation?.changes(sessionId, toolCallId) } : {}),
      threadId: threadOf,
      reader: async () => {
        if (!threadOf()) return undefined;
        // The restart drains the old journal before stopping its writer. Do not have that drain
        // wait on the very restart it belongs to or spawn a reader during the handover.
        if (this.restarting.has(sessionId)) {
          const current = this.runtimes.get(sessionId);
          return current?.transport?.isOnline ? current : undefined;
        }
        const current = host.getSession(sessionId);
        const resolved = this.profileSwitchPending(current)
          ? this.activeProfile(host, current, profile) : host.getProfile?.(current) ?? profile;
        // A terminal's own CLI holds the thread without Riffet's app-server (a hold, or a reader's own `codex resume`
        // after "resume in terminal"); a second app-server loading it here would be a second holder.
        if (!this.runtimes.get(sessionId)?.transport?.isOnline) {
          const threadId = current.nativeSessionId;
          if (current.terminalHold || threadId && await this.externalHolder(host, resolved, threadId)) return undefined;
        }
        const runtime = await this.ensureRuntime(host, current, host.getProject(current.projectId), resolved);
        return runtime.transport?.isOnline ? runtime : undefined;
      },
      commandOf: (item, turnId) => this.runtimes.get(sessionId)?.commandOf(item, turnId) ?? taggedCommand(item, this.flavor),
      itemSpans: threadId => rolloutItemSpans(this.flavor.stateHome(profile.config), threadId),
      runOf: commandId => host.findRunIdByCommand(sessionId, commandId),
      turnError: turn => {
        const actual = this.runtimes.get(sessionId)?.launchProfile.config;
        return safeTurnError(turn.error, profile.config, actual ?? {});
      },
      observe: feed => {
        let feeds = this.feeds.get(sessionId);
        if (!feeds) this.feeds.set(sessionId, feeds = new Set());
        feeds.add(feed);
        return () => { feeds.delete(feed); if (!feeds.size && this.feeds.get(sessionId) === feeds) this.feeds.delete(sessionId); };
      },
    });
  }

  /** What every runtime of a session tells the transcript sources that follow it. */
  private feedOf(sessionId: string): CodexLiveFeed {
    const each = (fn: (feed: CodexLiveFeed) => void) => { for (const feed of this.feeds.get(sessionId) ?? []) fn(feed); };
    return {
      notification: (method, params) => each(feed => feed.notification(method, params)), activity: activity => each(feed => feed.activity(activity)),
      active: () => (this.feeds.get(sessionId)?.size ?? 0) > 0,
      lost: () => each(feed => feed.lost?.()),
    };
  }

  /** Reads the thread's rollout file directly; the app-server is not involved. */
  private async usageTranscript(_host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, known?: string): Promise<UsageTranscript | undefined> {
    const threadId = session.nativeSessionId;
    const file = threadId ? await findCodexRollout(this.flavor.stateHome(profile.config), threadId) : undefined;
    if (!threadId || !file) return known === 'none' ? undefined : { generation: 'none', entries: [] };
    const info = await stat(file);
    if (info.size > MAX_ROLLOUT_BYTES) throw new Error(`${this.label} rollout exceeds the read limit`);
    const quiet = Date.now() - info.mtimeMs >= ROLLOUT_QUIET_MS;
    const generation = `${info.size}:${Math.round(info.mtimeMs)}:${quiet ? 'quiet' : 'busy'}`;
    if (generation === known) return undefined;
    const entries = parseRolloutUsage(await readFile(file, 'utf8'), threadId, quiet).map(usage => ({ usage }));
    return { generation, entries };
  }

  private async readContextTranscript(_host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, options: { maxBytes: number; signal: AbortSignal }): Promise<import('../../../../../packages/contracts/src/index.js').NativeWorkbenchEvent[]> {
    if (!session.nativeSessionId) return [];
    const file = await findCodexRollout(this.flavor.stateHome(profile.config), session.nativeSessionId);
    if (!file) throw new AppError('SESSION_REFERENCE_UNAVAILABLE', 'The native history file is unavailable', 409);
    const content = await readContextFile(file, options.maxBytes, options.signal);
    const metadata = content.split('\n', 1).map(line => { try { return JSON.parse(line); } catch { return undefined; } })[0]?.payload;
    if (metadata?.history_base || metadata?.id && metadata.id !== session.nativeSessionId) throw new AppError('SESSION_REFERENCE_UNAVAILABLE', 'Use the saved journal for inherited native history', 409);
    return projectShareRollout(content, session.id, session.nativeSessionId, true).events;
  }

  private readShareTranscript(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, options?: import('../types.js').NativeShareReadOptions) {
    return readCodexShare(host, session, this.flavor.stateHome(profile.config), options);
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

  status(host: NativeBackendHost, session: Session, profile?: NativeBackendProfileConfig): NativeStatus {
    const runtime = this.runtimes.get(session.id);
    const observed = this.profileSwitchPending(session) ? { ...session, backendProfileId: session.nativeRuntime!.profileId } : session;
    const desired = host.getProfile?.(observed) ?? profile;
    if (runtime && desired) runtime.syncSessionBinding(session, host.getProject(session.projectId), this.activeProfile(host, session, desired));
    return runtime?.status ?? { phase: 'offline' };
  }

  subscribe(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, listener: (message: NativeControlMessage) => void): () => void {
    if (!session.nativeSessionId) {
      listener({ type: 'status', status: { phase: 'offline' } });
      return () => undefined;
    }
    const subscriptions = this.listenersFor(session.id);
    subscriptions.listeners.add(listener);
    const project = host.getProject(session.projectId);
    profile = this.activeProfile(host, host.getSession(session.id), profile);
    const current = this.runtimes.get(session.id);
    if (current?.belongsTo(project, profile) && current.transport?.isOnline) {
      current.syncSessionBinding(session, project, profile);
      void this.bindListeners(session.id, current).catch(error => {
        if (subscriptions.listeners.has(listener)) listener({ type: 'status', status: { phase: 'offline', connection: { state: 'failed', message: safeProviderError(error, profile.config) } } });
      });
    } else {
      void this.ensureRuntime(host, session, project, profile).then(runtime => this.bindListeners(session.id, runtime)).catch(error => {
        if (subscriptions.listeners.has(listener)) {
          const message = safeProviderError(error, profile.config);
          listener({ type: 'status', status: { phase: 'offline', connection: { state: 'failed', message }, history: { state: 'error', message } } });
        }
      });
    }
    return () => {
      subscriptions.listeners.delete(listener);
      subscriptions.unsubscriptions.get(listener)?.();
      subscriptions.unsubscriptions.delete(listener);
      if (subscriptions.listeners.size === 0) {
        this.sessionListeners.delete(session.id);
        subscriptions.runtime = undefined;
      }
    };
  }

  async dispose(host: NativeBackendHost, sessionId: string): Promise<void> {
    clearTimeout(this.profileSwitchTimers.get(sessionId));
    this.profileSwitchTimers.delete(sessionId);
    this.profileSwitchFailures.delete(sessionId);
    const pending = this.creating.get(sessionId);
    if (pending) await pending.promise.catch(() => undefined);
    this.clearListeners(sessionId);
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    this.runtimes.delete(sessionId);
    await runtime.dispose(host);
  }

  async close(host: NativeBackendHost): Promise<void> {
    if (this.closeTask) return await this.closeTask;
    this.closing = true;
    for (const timer of this.profileSwitchTimers.values()) clearTimeout(timer);
    this.profileSwitchTimers.clear();
    this.closeTask = (async () => {
      await Promise.allSettled([...this.creating.values()].map(entry => entry.promise));
      const runtimes = [...this.runtimes.values()];
      this.runtimes.clear();
      // Closing the web service must not stop native turns or their subagents. Their durable
      // socket bindings let the next service instance reconnect to the same writer.
      await Promise.allSettled(runtimes.map(runtime => runtime.dispose(host, { keepRunning: true })));
      for (const sessionId of this.sessionListeners.keys()) this.clearListeners(sessionId);
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
        if (forceEndpointCheck) await runtime.terminalEndpointState(true);
        return runtime;
      }
      await pending.promise.catch(() => undefined);
      if (this.creating.get(session.id) === pending) await new Promise<void>(resolve => queueMicrotask(resolve));
      return await this.ensureRuntime(host, host.getSession(session.id), project, profile, forceEndpointCheck, reconnectOnly);
    }
    const task = Promise.resolve().then(async () => {
      let current = this.runtimes.get(session.id);
      let endpointChanged = false;
      current?.syncSessionBinding(session, project, profile);
      if (current?.transport?.isOnline && current.projectCwd === project.cwd && current.nativeSessionId === session.nativeSessionId) {
        const endpointState = await current.terminalEndpointState(forceEndpointCheck || current.status.connection?.state === 'conflict');
        // A cold reader's replacement leaves the dead binding saved; that binding is not a new owner.
        endpointChanged = endpointState === 'changed' || current.bindingMoved(session.nativeRuntime?.address);
        const latest = this.runtimes.get(session.id);
        if (latest !== current) current = latest;
        if (endpointState === 'unknown' && current?.transport?.isOnline) {
          if (!current.belongsTo(project, profile)) current.deferForProfileChange();
          return current;
        }
        if (!endpointChanged && current?.belongsTo(project, profile) && current.transport?.isOnline
          && (current.matches(project, profile) || session.nativeRuntime?.address === current.transport.remoteAddress)) {
          return current;
        }
      }
      if (current) {
        const threadId = session.nativeSessionId;
        const confirmedProfileRestored = Boolean(session.nativeRuntime?.fingerprint && matchesRuntimeFingerprint(session.nativeRuntime.fingerprint, project, profile, this.flavor));
        // If the terminal still proves this is the active endpoint, preserve its owner while a
        // profile change waits. A changed endpoint is reselected below, with the old runtime only
        // detached so it cannot stop the terminal's new owner.
        if (!endpointChanged && current.transport?.isOnline && current.projectCwd === project.cwd && current.nativeSessionId === threadId
          && (current.status.phase === 'busy' || current.activeTurnId) && !confirmedProfileRestored) {
          current.deferForProfileChange();
          return current;
        }
        this.runtimes.delete(session.id);
        // A profile switch must never stop a live terminal or its app-server. Detach this client's
        // socket and let the verified terminal endpoint select the existing owner below.
        await current.dispose(host, { keepRunning: true });
      }
      const runtime = new CodexSessionRuntime(host, session, project, profile, this.startAppServer, this.flavor, this.runtimeHooks, this.observation);
      runtime.attachFeed(this.feedOf(session.id));
      await runtime.start({ reconnectOnly });
      this.runtimes.set(session.id, runtime);
      await this.bindListeners(session.id, runtime);
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

  private listenersFor(sessionId: string): CodexSessionListeners {
    let subscriptions = this.sessionListeners.get(sessionId);
    if (!subscriptions) {
      subscriptions = { listeners: new Set(), unsubscriptions: new Map() };
      this.sessionListeners.set(sessionId, subscriptions);
    }
    return subscriptions;
  }

  private async bindListeners(sessionId: string, runtime: CodexSessionRuntime): Promise<void> {
    const subscriptions = this.sessionListeners.get(sessionId);
    if (!subscriptions || subscriptions.listeners.size === 0) return;
    if (subscriptions.runtime === runtime && subscriptions.listeners.size === subscriptions.unsubscriptions.size) return;
    if (subscriptions.binding) {
      await subscriptions.binding;
      if (subscriptions.runtime === runtime && subscriptions.listeners.size === subscriptions.unsubscriptions.size) return;
    }
    const task = (async () => {
      if (subscriptions.runtime !== runtime) {
        for (const unsubscribe of subscriptions.unsubscriptions.values()) unsubscribe();
        subscriptions.unsubscriptions.clear();
        subscriptions.runtime = runtime;
        // Prime the read-only transcript first. A loaded owner can then be attached with a
        // configuration-free resume; a cold stored thread remains a read-only observer.
        await runtime.prime().catch(() => undefined);
        await runtime.attachLoadedOwner().catch(() => undefined);
      }
      if (subscriptions.runtime !== runtime) return;
      for (const listener of subscriptions.listeners) {
        if (!subscriptions.unsubscriptions.has(listener)) subscriptions.unsubscriptions.set(listener, runtime.subscribe(listener));
      }
    })();
    subscriptions.binding = task;
    try { await task; }
    finally { if (subscriptions.binding === task) subscriptions.binding = undefined; }
  }

  private clearListeners(sessionId: string): void {
    const subscriptions = this.sessionListeners.get(sessionId);
    if (!subscriptions) return;
    for (const unsubscribe of subscriptions.unsubscriptions.values()) unsubscribe();
    subscriptions.unsubscriptions.clear();
    subscriptions.listeners.clear();
    subscriptions.runtime = undefined;
    this.sessionListeners.delete(sessionId);
  }
}

/** The workbench command a user item names by the tag the flavor echoes, read without a runtime. */
function taggedCommand(item: RpcItem, flavor: CodexFlavor): string | undefined {
  if (item.type !== 'userMessage') return undefined;
  if (flavor.messageTag.echo === 'clientId') return str(item.clientId);
  const id = str(item.id);
  return commandIdOfMessageId(id);
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

/** Enabled skills for `cwd` in the app-server's precedence order, one per name. */
async function listSkills(transport: CodexAppServerClient, cwd: string): Promise<Array<NativeSlashItem & { path: string }>> {
  const response = await transport.request<{ data?: Array<{ cwd?: string; skills?: unknown[] }> }>('skills/list', { cwds: [cwd] });
  const seen = new Set<string>();
  const items: Array<NativeSlashItem & { path: string }> = [];
  for (const entry of asArray<{ skills?: unknown[] }>(response.data)) {
    for (const skill of asArray<Record<string, unknown>>(entry.skills)) {
      const name = str(skill.name);
      const path = str(skill.path);
      if (!name || !path || skill.enabled === false || seen.has(name)) continue;
      seen.add(name);
      const face = asRecord(skill.interface) ?? {};
      const description = str(face.shortDescription) ?? str(skill.shortDescription) ?? str(skill.description);
      items.push({ name, kind: 'skill', path, ...(description ? { description } : {}) });
    }
  }
  return items;
}
