import { readContextFile } from '../../context-references/read-file.js';
import { queryDirectory } from '../shared/query-directory.js';
import { probeClaudeLoadedExtensions } from './loaded-extensions.js';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ModelInfo, NativeActivity, NativeBackendCapabilities, NativeInteraction, NativeInteractionResponse, NativeInteractionResult, NativeSlashItem, NativeStatus, NativeStopRequest, NativeTurnTarget, NativeWorkbenchEvent, Project, Run, Session } from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { activityId } from '../../journal/activity.js';
import { ClaudeActivities } from './activity.js';
import { leadsWithCommand, leadWithInlineSkill, probeClaudeSlashItems } from './slash.js';
import { slashTokens } from '../shared/slash-tokens.js';
import { DeferredSteerInputs } from '../shared/deferred-steer.js';
import { readClaudeShare } from '../shared/share-read.js';
import { launchSource, modelSourceOf } from '../shared/model-source.js';
import { materializeNativeInput } from '../attachments.js';
import type { NativeBackendAvailability, NativeBackendConfigurePatch, NativeBackendConfigureResult, NativeBackendDriver, NativeBackendHost, NativeBackendOpenResult, NativeBackendProfileConfig, NativeBackendSendRequest, NativeBackendTraits, NativeControlMessage, NativeShareReadOptions, NativeDriverExtensions, NativeDriverExternal, NativeDriverStored, ExternalHolder, ExternalSessionEntry, ExternalSessionScan, NativePtyLaunchSpec } from '../types.js';
import { ClaudeHookBridge } from './hook-bridge.js';
import type { UsageTranscript } from '../../stats/types.js';
import { claudeHistoryMetrics, claudeUsageRecord, runForClaudeStep } from './metering.js';
import { ClaudeTranscript, claudePromptKey, findClaudeTranscript, parseRow, mapRow, type MapperState, type ClaudeRow } from './history.js';
import { ClaudeTranscriptChanges, ClaudeTranscriptSource } from './transcript-source.js';
import { claudeHolders, scanClaudeSessions } from './external.js';
import type { TranscriptSource } from '../../journal/ingest.js';
import { string, executableOf, runHelp, backendId, CLAUDE_CLI_VERSIONS, CLAUDE_PERMISSIONS, asRecord, configDirOf, profileEnv, providerEnv, pause, screenDialogEndorsed, claudeAvailability , STANDING_ISOLATION } from './launch.js';
import { normalizeClaudeModel, selectedModel, validateModelSelection, gatewayCatalogs, claudeGatewayModels, claudeModels } from './models.js';
import { QUICK_EXIT_MS, QUICK_EXIT_LIMIT, rewriteKey, ClaudeSessionRuntime } from './runtime.js';
import { workspaceObserver, type WorkspaceObserver } from '../shared/workspace-observer.js';
export { CLAUDE_CLI_VERSIONS } from './launch.js';
export { CLAUDE_CONFIG_SETTLE_MS } from './runtime.js';

const PROFILE_ID = 'local';

/** Older provider session ids kept on a conversation that had to start over. */
const MAX_PREVIOUS_SESSION_IDS = 8;

/** How long a transcript must sit unwritten before its trailing response is taken as finished. */
const TRANSCRIPT_QUIET_MS = 60_000;

/** Queue rows are native receipt evidence only beyond the exact input fence in this same file. */
function queuedInputEvents(host: NativeBackendHost, session: Session, row: ClaudeRow, position: { offset: number; inode?: number; receipt?: { nativeId: string; runId: string; commandId: string } }): NativeWorkbenchEvent[] {
  const nativeSessionId = session.nativeSessionId;
  const text = string(row.content);
  const at = string(row.timestamp);
  if (!nativeSessionId || !text || !at || row.isSidechain === true || row.agentId !== undefined
    || (row.sessionId !== undefined && row.sessionId !== nativeSessionId)
    || !['enqueue', 'remove'].includes(string(row.operation) ?? '')) return [];
  const created = Date.parse(at);
  if (!Number.isFinite(created)) return [];
  if (row.operation === 'remove') {
    // The queue cursor remembers which exact enqueue was removed, even if the process restarted,
    // or a later input repeats its text. This ends only that input, never the active execution.
    const receipt = position.receipt;
    if (!receipt?.nativeId.startsWith(`claude:${nativeSessionId}:queue:`)) return [];
    const consumed = row.reason === 'absorbed_mid_turn' || row.reason === 'delivered_to_agent';
    return [{ sequence: 0, sessionId: session.id, runId: receipt.runId,
      nativeId: `claude:${nativeSessionId}:queue:${position.offset}:remove`, createdAt: at,
      type: consumed ? 'run_completed' : 'run_cancelled',
      data: { commandId: receipt.commandId, nativeMessageId: receipt.nativeId,
        ...(!consumed ? { reason: 'Claude Code removed the message from its input queue.' } : {}) } }];
  }
  const candidates = (host.listRuns?.(session.id) ?? []).flatMap(run => {
    const native = run.native;
    if (!native?.nativeInputBoundary || native.backendId !== backendId || native.nativeSessionId !== nativeSessionId) return [];
    let fence: Record<string, unknown> | undefined;
    try { fence = asRecord(JSON.parse(native.nativeInputBoundary)); } catch { return []; }
    if (fence?.type !== 'claude-transcript' || fence.nativeSessionId !== nativeSessionId
      || typeof fence.offset !== 'number' || position.offset < fence.offset
      || (fence.inode !== undefined && fence.inode !== position.inode)
      || created < (native.timings?.dispatchAt ?? Infinity)) return [];
    return [{ run, offset: fence.offset }];
  }).sort((left, right) => right.offset - left.offset);
  // A newer write fences all earlier candidates. Equal boundaries cannot identify one command.
  const selected = candidates[0];
  // The queue holds the prompt as the CLI recorded it, a multi-line paste in its paste wrapper.
  const sent = selected?.run.native!.renderedText;
  if (!selected || candidates[1]?.offset === selected.offset || sent === undefined || claudePromptKey(sent) !== claudePromptKey(text)) return [];
  const { run } = selected;
  const prefix = `claude:${nativeSessionId}:queue:`;
  const receiptId = `${prefix}${position.offset}:enqueue`;
  const storedReceipt = run.native!.nativeMessageId;
  if (storedReceipt && storedReceipt !== receiptId) return [];
  return [{ sequence: 0, sessionId: session.id, runId: run.id, nativeId: receiptId, createdAt: at,
    type: 'native_input_receipt', data: { commandId: run.commandId, content: { type: 'text', text } } }];
}

/**
 * Claude's `/` catalog per profile and project. The composer lists it, and a send that names a
 * `/token` needs it too — to tell a skill from a built-in command — so both share one probe: a
 * listing younger than `maxAgeMs` is reused and a probe already running is joined.
 */
const slashCatalogs = new Map<string, { items?: NativeSlashItem[]; at: number; request?: Promise<NativeSlashItem[]> }>();
const MAX_SLASH_CATALOGS = 32;
/** How stale a catalog a send may decide by; skills change when files do, not per message. */
const SEND_SLASH_CATALOG_MAX_AGE_MS = 10 * 60_000;

/** [launchArgs] are a standing conversation's (its isolation and plugin folders): it lists what that launch loads. */
function claudeSlashItems(profile: NativeBackendProfileConfig, cwd: string, maxAgeMs: number, launchArgs: readonly string[] = []): Promise<NativeSlashItem[]> {
  const key = JSON.stringify([profile.id, executableOf(profile), configDirOf(profile), cwd, launchArgs]);
  const entry = slashCatalogs.get(key) ?? { at: 0 };
  slashCatalogs.delete(key);
  slashCatalogs.set(key, entry);
  if (slashCatalogs.size > MAX_SLASH_CATALOGS) slashCatalogs.delete(slashCatalogs.keys().next().value!);
  if (entry.items && Date.now() - entry.at <= maxAgeMs) return Promise.resolve(entry.items);
  entry.request ??= probeClaudeSlashItems(executableOf(profile), cwd, profileEnv(profile), launchArgs)
    .then(items => { entry.items = items; entry.at = Date.now(); return items; })
    .finally(() => { entry.request = undefined; });
  return entry.request;
}

/** What a probe adds to list a standing conversation's extensions as its launch loads them; nothing for any other. */
function standingArgs(host: NativeBackendHost, project: Project): string[] {
  const standing = host.standing?.launch(project);
  return standing ? [...STANDING_ISOLATION, ...standing.pluginDirs.flatMap(dir => ['--plugin-dir', dir]), ...(standing.mcpConfigFiles.length ? ['--mcp-config', ...standing.mcpConfigFiles] : [])] : [];
}

function isClaudeSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Claude Code answers slash commands in its own pane, reports turn ends by hook, keeps a message it
 * holds in its input box or queue across a stop, and runs background agents on their own.
 */
export const CLAUDE_TRAITS: NativeBackendTraits = {
  settlesSlashOnSubmit: true,
  reportsTurnOutcome: true,
  survivesRestart: true,
  offlineMayBeRunning: true,
  stopKeepsPendingInput: true,
  detachedSubagents: true,
  cachesModels: true,
  terminalName: 'Claude',
  resumesByNativeId: true,
  riffetTools: true,
  extensionToggles: { mcp: true, skills: true },
  relaunchesForPendingConfig: true,
  consumesProtocols: ['anthropic-messages'],
};

export class ClaudeBackendAdapter implements NativeBackendDriver {
  readonly extensions: NativeDriverExtensions = {
    loaded: (host, project, profile) => this.loadedExtensions(host, project, profile),
  };
  readonly external: NativeDriverExternal = {
    list: (host, profile, options) => this.listExternalSessions(host, profile, options),
    holder: (host, profile, id) => this.externalHolder(host, profile, id),
    terminalLaunch: (host, session, project, profile) => this.terminalLaunch(host, session, project, profile),
    resumeCommand: (session, profile) => this.resumeCommand(session, profile),
    follow: (host, session, profile) => this.followExternal(host, session, profile),
  };
  readonly stored: NativeDriverStored = {
    usage: (host, session, profile, known) => this.usageTranscript(host, session, profile, known),
    context: (host, session, profile, options) => this.readContextTranscript(host, session, profile, options),
    share: (host, session, profile, options) => this.readShareTranscript(host, session, profile, options),
  };
  readonly id = backendId;
  readonly label = 'Claude';
  readonly traits = CLAUDE_TRAITS;
  readonly cliVersions = CLAUDE_CLI_VERSIONS;
  /** One loopback endpoint for every runtime of this process; see `ClaudeHookBridge`. */
  private readonly bridge: ClaudeHookBridge;

  private bridgeAttempt = 0;
  private bridgeRetry?: NodeJS.Timeout;
  private closing = false;

  /** What a shell command changed, seen around it; only a served state directory keeps snapshots. */
  private readonly observer?: WorkspaceObserver;

  constructor(options: { stateDir?: string } = {}) {
    this.bridge = new ClaudeHookBridge(options);
    if (options.stateDir) this.observer = workspaceObserver(options.stateDir);
    // The descriptor is how a CLI that outlived the previous server finds this one, so it is published as soon as
    // the server is up, not when the first conversation happens to open. Never blocks start-up.
    if (options.stateDir) this.keepBridgeUp();
  }

  /** Starts the hook bridge, and starts it again (with a growing pause) for as long as that fails. */
  private keepBridgeUp(): void {
    this.bridge.start().then(
      () => { this.bridgeAttempt = 0; },
      error => {
        if (this.closing) return;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.bridgeAttempt, 5));
        this.bridgeAttempt += 1;
        console.warn('[riffet] claude: the hook bridge could not start; trying again', { attempt: this.bridgeAttempt, retryInMs: delay, error: error instanceof Error ? error.message : String(error) });
        this.bridgeRetry = setTimeout(() => { this.bridgeRetry = undefined; if (!this.closing) this.keepBridgeUp(); }, delay);
        this.bridgeRetry.unref?.();
      },
    );
  }

  /**
   * Where a hook from a conversation with no runtime is sent to be brought up: the service looks the
   * conversation up by its Claude session id and opens it (without launching anything).
   */
  setHookWake(wake: (nativeSessionId: string) => Promise<boolean>): void { this.bridge.setWake(wake); }
  private readonly runtimes = new Map<string, ClaudeSessionRuntime>();
  private readonly creating = new Map<string, Promise<ClaudeSessionRuntime>>();
  /** Whom a running conversation wakes when its CLI may have written to the transcript (see `transcript`). */
  private readonly changes = new ClaudeTranscriptChanges();

  normalizeModel(model: string): string { return normalizeClaudeModel(model); }

  /** Profiles sharing a config directory resume each other's conversations: `--resume` reads the same transcript. */
  continuationKey(profile: NativeBackendProfileConfig): string { return configDirOf(profile); }

  private listExternalSessions(_host: NativeBackendHost, profile: NativeBackendProfileConfig, options: ExternalSessionScan): Promise<ExternalSessionEntry[]> {
    return scanClaudeSessions(configDirOf(profile), options);
  }

  private async externalHolder(_host: NativeBackendHost, profile: NativeBackendProfileConfig, nativeSessionId: string): Promise<ExternalHolder | undefined> {
    return (await claudeHolders(configDirOf(profile))).get(nativeSessionId);
  }

  private async terminalLaunch(_host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig): Promise<{ spec: NativePtyLaunchSpec }> {
    const configDir = configDirOf(profile);
    const id = session.nativeSessionId;
    if (!id || !await findClaudeTranscript(configDir, id)) throw new AppError('CLAUDE_SESSION_NOT_FOUND', 'The saved Claude session could not be found in this profile', 404);
    // Plain `--resume`: the terminal runs the reader's own Claude, without Riffet's overlay, hooks or MCP. The
    // overlay is where provider settings normally travel, so the endpoint and key go in the environment instead.
    const { RIFFET_CLAUDE_API_KEY: _helperKey, ANTHROPIC_AUTH_TOKEN: _a, ANTHROPIC_API_KEY: _b, CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: _c, ...provider } = providerEnv(profile);
    const { credential } = launchSource(profile.config);
    const secretEnv = credential?.kind === 'static' ? { [provider.ANTHROPIC_BASE_URL ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY']: credential.key } : undefined;
    return { spec: { command: executableOf(profile), args: ['--resume', id], env: { ...profileEnv(profile), ...provider }, ...(secretEnv ? { secretEnv } : {}), cwd: project.cwd, title: 'Claude Agent' } };
  }

  private resumeCommand(session: Session, profile: NativeBackendProfileConfig): { argv: string[]; env: Record<string, string>; credentialsOmitted?: boolean } {
    if (!session.nativeSessionId) throw new AppError('NATIVE_SESSION_NOT_STARTED', 'This conversation has not started yet', 409);
    // The name the reader would type; the launch resolves it to a path only because the daemon's PATH may lack it.
    const command = string(profile.config.executable)?.trim() || process.env.CLAUDE_CLI?.trim() || 'claude';
    const configDir = string(profile.config.configDir)?.trim();
    const { ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_CUSTOM_HEADERS: headers } = providerEnv(profile);
    return {
      argv: [command, '--resume', session.nativeSessionId],
      env: { ...(configDir ? { CLAUDE_CONFIG_DIR: resolve(configDir) } : {}), ...(endpoint ? { ANTHROPIC_BASE_URL: endpoint } : {}) },
      ...(launchSource(profile.config).credential || headers ? { credentialsOmitted: true } : {}),
    };
  }

  private followExternal(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): () => void {
    const configDir = configDirOf(profile);
    let file: string | undefined;
    let located: string | undefined;
    let seen = '';
    let busy = false;
    // With no runtime of ours, nothing else wakes the transcript reader when the terminal's CLI writes.
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        // The id can change under a terminal (`/clear`, a fork), so the stored session is asked each tick.
        const id = host.getSession(session.id)?.nativeSessionId ?? session.nativeSessionId;
        if (id !== located || !file) { located = id; file = id ? await findClaudeTranscript(configDir, id) : undefined; }
        const info = file ? await stat(file).catch(() => undefined) : undefined;
        const stamp = info ? `${info.size}:${info.mtimeMs}` : '';
        if (stamp !== seen) { seen = stamp; if (info) this.changes.emit(session.id); }
      })().catch(() => undefined).finally(() => { busy = false; });
    }, 1000);
    timer.unref();
    return () => clearInterval(timer);
  }

  validateNativeSessionId(nativeSessionId: string): void {
    if (!isClaudeSessionId(nativeSessionId)) throw new AppError('INVALID_CLAUDE_SESSION_ID', 'Claude session id must be a UUID');
  }

  profiles(): NativeBackendProfileConfig[] {
    return [{
      id: PROFILE_ID, backendId, name: 'Claude Code CLI', isDefault: true,
      config: {
        executable: process.env.CLAUDE_CLI?.trim() || 'claude',
        ...(process.env.CLAUDE_CONFIG_DIR ? { configDir: process.env.CLAUDE_CONFIG_DIR } : {}),
      },
    }];
  }

  capabilities(): NativeBackendCapabilities {
    return {
      supportsSessionReferences: true,
      backendId, label: this.label, modes: [], permissions: CLAUDE_PERMISSIONS,
      interactionTransport: 'both', supportsResume: true, supportsInterrupt: true,
      supportsSteer: true, supportsHistory: true, supportsModelSelection: true, supportsModeSelection: false,
      supportsPermissionSelection: true, supportsTerminal: true, supportsPrewarm: false,
      slashCommands: [
        { name: 'model', description: 'Change the Claude model' },
        { name: 'permissions', description: 'View native permission rules' },
      ],
      inlineSkills: true,
    };
  }

  async slashItems(host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig): Promise<NativeSlashItem[]> {
    return await claudeSlashItems(profile, await queryDirectory(project, profile), 0, project ? standingArgs(host, project) : []);
  }

  private async loadedExtensions(host: NativeBackendHost, project: Project, profile: NativeBackendProfileConfig) {
    // A standing conversation loads its own directory's extensions only, so that is what is listed for it.
    return await probeClaudeLoadedExtensions(executableOf(profile), await queryDirectory(project, profile), profileEnv(profile), standingArgs(host, project));
  }

  async available(_host: NativeBackendHost, profile: NativeBackendProfileConfig): Promise<NativeBackendAvailability> {
    return await claudeAvailability(profile);
  }

  async openOrResume(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig): Promise<NativeBackendOpenResult> {
    return await host.withSessionLock(session.id, async () => {
      let current = session;
      let launchNotice: string | undefined;
      const stored = host.getSession(session.id);
      if (stored.nativeSessionId && (stored.quickExitCount ?? 0) >= QUICK_EXIT_LIMIT) {
        // `--resume` keeps failing at once, so the saved conversation is what the CLI chokes on. Start
        // under a new id instead, and keep the old ones on the session: their transcripts still lead
        // the conversation the reader sees (see `ClaudeTranscript`).
        await this.dispose(host, session.id);
        host.updateSession(session.id, { previousNativeSessionIds: [...(stored.previousNativeSessionIds ?? []), stored.nativeSessionId].slice(-MAX_PREVIOUS_SESSION_IDS), quickExitCount: 0 });
        current = host.setNativeSessionId(session.id, randomUUID());
        launchNotice = `Claude Code 已连续 ${QUICK_EXIT_LIMIT} 次在启动后 ${QUICK_EXIT_MS / 1000} 秒内退出，这次放弃 --resume，以全新的 Claude 会话启动；之前的对话记录仍会显示在本会话中。`;
      }
      if (current.nativeSessionId) this.validateNativeSessionId(current.nativeSessionId);
      const resumeRequested = Boolean(current.nativeSessionId) && launchNotice === undefined;
      const nativeSessionId = current.nativeSessionId ?? randomUUID();
      if (!current.nativeSessionId) host.setNativeSessionId(current.id, nativeSessionId);
      const runtime = await this.ensureRuntime(host, { ...current, nativeSessionId }, project, profile, true, resumeRequested, launchNotice);
      const opened = await runtime.start();
      return { nativeSessionId, ...(opened.terminalId ? { terminalId: opened.terminalId } : {}), status: runtime.status };
    });
  }

  async send(host: NativeBackendHost, request: NativeBackendSendRequest): Promise<void> {
    await host.withSessionLock(request.session.id, async () => {
      const session = host.getSession(request.session.id);
      const runtime = await this.ensureRuntime(host, session, request.project, request.profile, true);
      await runtime.start();
      // Only a message naming a `/token` needs the catalog; one that cannot be listed is sent as
      // typed and judged by its text alone.
      const sourceText = request.sourceText ?? request.input.text;
      // A standing conversation's own command, which the CLI knows by another name.
      const standing = host.standing?.rewrite?.(request.session.id, sourceText);
      if (standing) { await runtime.send(request, { deliverText: standing, command: true }); return; }
      const items = slashTokens(sourceText).length
        ? await claudeSlashItems(request.profile, request.project.cwd, SEND_SLASH_CATALOG_MAX_AGE_MS, standingArgs(host, request.project)).catch(() => undefined)
        : undefined;
      const leading = items ? leadWithInlineSkill(sourceText, items) : sourceText;
      const text = leading === sourceText ? request.input.text : `${leading}${request.input.text.slice(sourceText.length)}`;
      await runtime.send(request, {
        ...(text === request.input.text ? {} : { deliverText: text }),
        ...(items ? { command: leadsWithCommand(sourceText, items) } : {}),
      });
    });
  }

  async steer(host: NativeBackendHost, request: NativeBackendSendRequest & { target: NativeTurnTarget }): Promise<{ deferred: true }> {
    const runtime = this.runtimes.get(request.session.id);
    if (!runtime) throw new AppError('NATIVE_STEER_TARGET_GONE', 'Claude has no live hook connection for this turn.', 409);
    // Attachment reads happen outside the short target/fence lock. The target is checked again
    // when enqueuing and when the matching native tool returns.
    if (slashTokens(request.sourceText ?? request.input.text).length) throw new AppError('NATIVE_STEER_UNSUPPORTED_INPUT', 'Claude guidance cannot invoke commands or skills.', 400);
    for (const id of request.input.attachmentIds) {
      const { attachment } = await host.readAttachment(id);
      if (attachment.mimeType.startsWith('image/')) throw new AppError('NATIVE_STEER_UNSUPPORTED_INPUT', 'Claude hook guidance cannot carry images.', 400);
    }
    const rendered = await materializeNativeInput(host, request.input);
    if (rendered.text.length > 6000) throw new AppError('NATIVE_STEER_INPUT_TOO_LARGE', 'Claude guidance must fit within 6000 characters including file references.', 400);
    return await host.withSessionLock(request.session.id, () => runtime.steer(request, rendered.text));
  }

  async interrupt(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, options?: { clearPrompt?: boolean; expectedStop?: NativeStopRequest }): Promise<void> {
    await host.withSessionLock(session.id, async () => {
      const runtime = this.runtimes.get(session.id)
        ?? await this.ensureRuntime(host, session, host.getProject(session.projectId), profile, false);
      await runtime.interrupt(options);
    });
  }

  requestInterrupt(_host: NativeBackendHost, session: Session): void {
    this.runtimes.get(session.id)?.requestInterrupt();
  }

  async stopActivity(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, activityId: string): Promise<NativeActivity> {
    return await host.withSessionLock(session.id, async () => {
      const runtime = this.runtimes.get(session.id)
        ?? await this.ensureRuntime(host, session, host.getProject(session.projectId), profile, false);
      return await runtime.stopActivity(activityId);
    });
  }

  async canReleaseInput(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, run: Run): Promise<boolean> {
    if (!session.nativeSessionId || !session.terminalId || run.native?.backendId !== backendId
      || run.native.nativeSessionId !== session.nativeSessionId || run.native.terminalId !== session.terminalId) return false;
    try {
      const runtime = this.runtimes.get(session.id)
        ?? await this.ensureRuntime(host, session, host.getProject(session.projectId), profile, false);
      return await runtime.canReleaseInput(run);
    } catch { return false; }
  }

  async respond(host: NativeBackendHost, session: Session, _profile: NativeBackendProfileConfig, response: NativeInteractionResponse): Promise<NativeInteractionResult> {
    const runtime = this.runtimes.get(session.id);
    if (!runtime) return { status: 'uncertain', message: 'Claude has no live permission request.' };
    return await runtime.respond(response);
  }

  async extendInteraction(_host: NativeBackendHost, session: Session, _profile: NativeBackendProfileConfig, interactionId: string): Promise<NativeInteraction> {
    const runtime = this.runtimes.get(session.id);
    if (!runtime) throw new AppError('NATIVE_INTERACTION_GONE', 'Claude has no live permission request.', 409);
    return runtime.extendInteraction(interactionId);
  }

  async configure(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, patch: NativeBackendConfigurePatch): Promise<NativeBackendConfigureResult> {
    if (patch.mode !== undefined && patch.mode !== 'agent') throw new AppError('NATIVE_MODE_UNSUPPORTED', 'Claude Code does not expose a separate work mode.');
    if (patch.approval !== undefined && !CLAUDE_PERMISSIONS.some(item => item.id === patch.approval)) {
      throw new AppError('INVALID_CLAUDE_PERMISSION', 'Choose a permission mode supported by Claude Code');
    }
    await validateModelSelection(profile, patch.model ?? selectedModel(session, profile));
    return await host.withSessionLock(session.id, async () => {
      session = host.getSession(session.id);
      const runtime = this.runtimes.get(session.id);
      // `profile` is the one the conversation moves to when it differs from what it runs on.
      const switching = profile.id !== (runtime?.profileId ?? session.backendProfileId);
      // `isLive`, never `started`: after a workbench restart the CLI is still running behind its
      // saved terminal while this process has launched nothing, and a change reported as applied
      // only because the record now says so is a silent lie. With nothing live the record is the
      // only place the intent can wait — the next `start`/`open`, or the dispatch that finds this
      // terminal, carries it (see `prepareExistingTerminal`).
      if (!runtime?.isLive()) {
        runtime?.useProfile(profile);
        if (session.terminalId && (switching || Object.entries(patch).some(([key, value]) => session[key as keyof typeof patch] !== value))) {
          host.updateSession(session.id, { configPending: true });
        }
        return { ...patch };
      }
      // The running CLI changes only by a relaunch. Doing it here held the picker for a whole stop and
      // `--resume`, once per click; the change is recorded instead and applied once the picks stop
      // (`deferConfig`), or by the next send, whichever comes first.
      runtime.useProfile(profile);
      if (runtime.launchedMatches({ ...session, ...patch })) {
        if (session.configPending) host.updateSession(session.id, { configPending: false });
      } else {
        host.updateSession(session.id, { configPending: true });
        runtime.deferConfig();
      }
      return { ...patch };
    });
  }

  invalidateModels(): void { gatewayCatalogs.clear(); }

  async listModels(_host: NativeBackendHost, _project: Project | undefined, profile: NativeBackendProfileConfig, session?: Session): Promise<ModelInfo[]> {
    const configured = session?.model ?? string(profile.config.defaultModel);
    const [probe, gateway] = await Promise.all([
      runHelp(executableOf(profile)).catch(() => undefined), claudeGatewayModels(profile),
    ]);
    // Claude's built-in aliases name Anthropic's own models, so they are meaningless against a
    // gateway. Ask the gateway what it serves; `--model` forwards any id verbatim.
    return claudeModels(configured, gateway, probe, modelSourceOf(profile.config) !== undefined, profile);
  }

  private async readContextTranscript(_host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, options: { maxBytes: number; signal: AbortSignal }): Promise<NativeWorkbenchEvent[]> {
    if (!session.nativeSessionId) return [];
    const events: NativeWorkbenchEvent[] = [];
    let remaining = options.maxBytes, sequence = 0;
    for (const id of [...(session.previousNativeSessionIds ?? []), session.nativeSessionId]) {
      options.signal.throwIfAborted();
      const file = await findClaudeTranscript(configDirOf(profile), id);
      if (!file) throw new AppError('SESSION_REFERENCE_UNAVAILABLE', 'The native history file is unavailable', 409);
      const content = await readContextFile(file, remaining, options.signal);
      remaining -= Buffer.byteLength(content);
      const state: MapperState = { turnAt: session.createdAt, calls: new Map(), tasks: new Map(), activities: new ClaudeActivities(session.id) };
      for (const [line, text] of content.split('\n').entries()) {
        options.signal.throwIfAborted();
        if (!text.trim()) continue;
        const row = parseRow(text, true);
        if (!row) continue;
        for (const event of mapRow(row, line, { ...session, nativeSessionId: id }, state, { unbounded: true, skipSubagents: true })) {
          if (event.type === 'user_message_chunk' || event.type === 'agent_message_chunk') events.push({ ...event, sequence: ++sequence });
        }
      }
    }
    return events;
  }

  private readShareTranscript(_host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, options?: NativeShareReadOptions) {
    return readClaudeShare(session, configDirOf(profile), options);
  }

  /**
   * The conversation's transcripts as the session journal reads them (`transcript-source.ts`). Read-only
   * on the CLI's files; a running conversation wakes it from its hooks and its transcript poll, and lends
   * it what it knows about its rows (the run a prompt belongs to, a prompt it rewrote).
   */
  transcript(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): TranscriptSource {
    const configDir = configDirOf(profile);
    const current = () => { try { return host.getSession(session.id); } catch { return session; } };
    const runtime = () => this.runtimes.get(session.id);
    const steering = new DeferredSteerInputs(host, { backendId, sessionId: session.id, currentTarget: () => undefined });
    return new ClaudeTranscriptSource({
      sessionId: session.id,
      nativeSessionId: () => current().nativeSessionId,
      previousNativeSessionIds: () => current().previousNativeSessionIds ?? [],
      locate: nativeSessionId => findClaudeTranscript(configDir, nativeSessionId),
      watch: wake => this.changes.on(session.id, wake),
      exited: () => runtime()?.exitedAt,
      hooks: {
        inputRuns: host.listRuns ? () => host.listRuns!(session.id) : undefined,
        inputReceipt: event => host.emitEvent(session.id, event),
        queuedInput: (row, position) => {
          const events = queuedInputEvents(host, current(), row, position);
          if (position.receipt && (row.operation === 'remove' && events.length
            || row.operation === 'dequeue' && position.receipt.nativeId.startsWith(`claude:${current().nativeSessionId}:queue:`))) runtime()?.releaseQueuedInput(position.receipt.commandId);
          return events;
        },
        additionalContext: (text, nativeId, createdAt) => steering.receiptEvents(text, nativeId, createdAt),
        commandForUserMessage: message => runtime()?.commandForUserMessage(message),
        promptText: prompt => runtime()?.rewrites.get(rewriteKey(prompt)),
        putBlob: text => host.journal?.putSessionBlob(session.id, Buffer.from(text)),
        observedChanges: toolUseId => this.observer?.changes(session.id, toolUseId),
      },
    });
  }

  /**
   * A private parse of the JSONL, never the running watcher's instance, so the read cannot advance
   * the stream's emission state. The trailing response counts only once the file has gone quiet:
   * until a later row supersedes it, it may still be streaming.
   */
  private async usageTranscript(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, known?: string): Promise<UsageTranscript | undefined> {
    // A watched conversation hands every settled response to the ledger as it reads the file; a second
    // full parse here (hundreds of ms for a long one) would only find the same rows. Reported as
    // unchanged, it is read once the runtime is gone and the generation has moved on.
    if (this.runtimes.get(session.id)?.recordsUsage) return undefined;
    const nativeSessionId = session.nativeSessionId;
    const file = nativeSessionId ? await findClaudeTranscript(configDirOf(profile), nativeSessionId) : undefined;
    if (!nativeSessionId || !file) return known === 'none' ? undefined : { generation: 'none', entries: [] };
    const info = await stat(file);
    const quiet = Date.now() - info.mtimeMs >= TRANSCRIPT_QUIET_MS;
    const generation = `metrics-v2:${info.size}:${Math.round(info.mtimeMs)}:${quiet ? 'quiet' : 'busy'}`;
    if (generation === known) return undefined;
    const steering = new DeferredSteerInputs(host, { backendId, sessionId: session.id, currentTarget: () => undefined });
    const transcript = new ClaudeTranscript(session, nativeSessionId, {
      additionalContext: (text, nativeId, createdAt) => steering.receiptEvents(text, nativeId, createdAt),
    });
    await transcript.setFile(file);
    if (transcript.state !== 'ok') throw new Error(`Claude transcript is ${transcript.state}`);
    const steps = transcript.measurements().filter(step => step.agentKind === 'subagent' || !step.live || quiet);
    claudeHistoryMetrics(host, session, steps);
    const entries = steps
      .map(step => {
        const runId = runForClaudeStep(host, session.id, step);
        return { ...(runId ? { runId } : {}), usage: claudeUsageRecord(step) };
      });
    return { generation, entries };
  }

  interaction(_host: NativeBackendHost, session: Session): NativeInteraction | undefined { return this.runtimes.get(session.id)?.status.interaction; }

  /** Without a running runtime only the screens that block the CLI by themselves are believed. */
  endorsesScreenDialog(_host: NativeBackendHost, session: Session, dialog: NativeInteraction): boolean {
    return this.runtimes.get(session.id)?.endorsesDialog(dialog) ?? screenDialogEndorsed(dialog, { held: false, turnOpen: false, open: [] });
  }

  status(_host: NativeBackendHost, session: Session): NativeStatus {
    const runtime = this.runtimes.get(session.id);
    if (runtime) return runtime.status;
    // status() is synchronous, so defer the cold terminal read to subscribe/snapshot. Never
    // report an attached saved TUI as offline while that read is pending. The phase drives loading;
    // an expected reconnect does not need a separate notice.
    return session.terminalId
      ? { phase: 'starting', transcript: 'unavailable' }
      : { phase: 'offline', transcript: 'unavailable' };
  }

  subscribe(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, listener: (message: NativeControlMessage) => void): () => void {
    const nativeSessionId = session.nativeSessionId;
    if (!nativeSessionId) {
      queueMicrotask(() => listener({ type: 'status', status: { phase: 'offline', transcript: 'unavailable' } }));
      return () => undefined;
    }
    let closed = false;
    void this.ensureRuntime(host, session, host.getProject(session.projectId), profile, false).then(async runtime => {
      if (closed) return;
      const unsubscribe = runtime.subscribe(listener);
      if (closed) unsubscribe();
      await runtime.monitor();
    }).catch(() => {
      if (!closed) listener({ type: 'status', status: { phase: 'offline', transcript: 'unavailable' } });
    });
    return () => { closed = true; const runtime = this.runtimes.get(session.id); runtime?.unsubscribe(listener); };
  }

  async dispose(host: NativeBackendHost, sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    this.runtimes.delete(sessionId);
    await runtime.dispose();
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.bridgeRetry) clearTimeout(this.bridgeRetry);
    this.bridgeRetry = undefined;
    const pending = await Promise.allSettled([...this.creating.values()]);
    const active = new Set(this.runtimes.values());
    for (const item of pending) if (item.status === 'fulfilled') active.add(item.value);
    for (const runtime of active) await runtime.dispose().catch(() => undefined);
    this.runtimes.clear();
    this.creating.clear();
    await this.bridge.close().catch(() => undefined);
  }

  private async ensureRuntime(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig, start: boolean, resumeRequested = Boolean(session.nativeSessionId), launchNotice?: string): Promise<ClaudeSessionRuntime> {
    const cleared = this.runtimes.get(session.id);
    if (cleared?.clearedTo) {
      // After `/clear` the conversation goes on under the CLI's new id: the old one leads its history.
      const stored = host.getSession(session.id);
      if (stored.nativeSessionId === cleared.nativeSessionId) {
        host.updateSession(session.id, { previousNativeSessionIds: [...(stored.previousNativeSessionIds ?? []), cleared.nativeSessionId].slice(-MAX_PREVIOUS_SESSION_IDS) });
        host.setNativeSessionId(session.id, cleared.clearedTo);
      }
      this.runtimes.delete(session.id);
      await cleared.dispose();
      session = host.getSession(session.id);
      resumeRequested = true;
    }
    const current = this.runtimes.get(session.id);
    if (current) {
      if (start) await current.setStartRequested();
      return current;
    }
    const pending = this.creating.get(session.id);
    if (pending) {
      const runtime = await pending;
      if (start) await runtime.setStartRequested();
      return runtime;
    }
    const task = (async () => {
      const nativeSessionId = session.nativeSessionId ?? randomUUID();
      if (!session.nativeSessionId && start) host.setNativeSessionId(session.id, nativeSessionId);
      const runtime = new ClaudeSessionRuntime(host, { ...session, nativeSessionId }, project, profile, resumeRequested, this.bridge, launchNotice, this.changes, this.observer);
      this.runtimes.set(session.id, runtime);
      try {
        await runtime.monitor();
        if (start) await runtime.setStartRequested();
        return runtime;
      } catch (error) {
        if (this.runtimes.get(session.id) === runtime) this.runtimes.delete(session.id);
        await runtime.dispose();
        throw error;
      }
    })();
    this.creating.set(session.id, task);
    try { return await task; }
    finally { if (this.creating.get(session.id) === task) this.creating.delete(session.id); }
  }
}
