import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NativeInteractionResponse, NativeInteractionResult, NativeSlashItem, NativeStatus } from '@contracts';
import {
  isCliMissing,
  redactSensitiveText,
  resolveCliExecutable,
  runProcess,
  scanSkillRoots,
  stripTerminalSequences,
} from '@riffet/plugin-api/kit';
import {
  AGENT_PROTOCOL_VERSION, type AgentBackend, type AgentCapabilities, type AgentConfigurePatch, type AgentContext, type AgentDiscussionRequest, type AgentExtensionLayout, type AgentHistoryOptions, type AgentHost, type AgentModelQuery,
  type AgentOpenResult, type AgentProfile, type AgentProjectView, type AgentReport, type AgentRunRef, type AgentSendRequest, type AgentSessionView, type AgentStopOptions,
} from '@riffet/plugin-api/experimental/agent';
import { emptyComposer, sameInput } from './composer.js';
import { agyMode, agySelection, agySessionGeminiDir, agyToolPermission, parseAgyProfile } from './config.js';
import { streamAgyDiscussion } from './discussion.js';
import { queueConfiguration } from './config-queue.js';
import { interrupt, runtimeAction } from './control.js';
import { interactionOf } from './interactions.js';
import { attach } from './lifecycle.js';
import { open } from './launch.js';
import { capabilities, extensionLayout } from './metadata.js';
import { listModels } from './models.js';
import { agyConversationId, agyRecord, type AgyRecord } from './protocol.js';
import { interaction, respond } from './respond.js';
import { detach, idle, loadContext, nativeStatus, sessionRoot, waiting, type Hub } from './runtime.js';
import { send } from './send.js';
import { scanStandingSkills } from './standing.js';
import { AntigravityTranscriptSource, agyStepIdentity, mapLiveSnapshot, readAgyHistory } from './transcript.js';

const READY_PATTERN = /\? for shortcuts|Antigravity|Gemini.*Flash/;

function agyStartupError(screen: string): string | undefined {
  const text = stripTerminalSequences(screen);
  if (READY_PATTERN.test(text)) return undefined;
  const line = text
    .split('\n')
    .map(entry => entry.trim())
    .find(entry =>
      /^(?:Cannot\b|Unable to\b|Failed\b|(?:\w*Error)(?:\s*\[[^\]]+\])?:|error:|Unauthorized\b|Forbidden\b|Not authenticated\b|Authentication (?:failed|required)\b|Login required\b|Please sign in\b|Invalid API key\b|API key\b.*(?:invalid|missing|expired|required))/i.test(
        entry,
      ),
    );
  if (!line) return undefined;
  return `Antigravity failed to start: ${redactSensitiveText(line).slice(0, 500)}`;
}

export class AntigravityBackend implements AgentBackend {
  readonly id = 'antigravity' as const;
  readonly label = 'Antigravity';
  readonly protocolVersion = AGENT_PROTOCOL_VERSION;
  readonly cliVersions = { minimum: '1.5.6', testedThrough: '1.5.18' };
  readonly readOnlyHistory = true;
  readonly traits = {
    survivesRestart: true,
    resumesByNativeId: true,
    offlineMayBeRunning: true,
    riffetTools: true,
    relaunchesForPendingConfig: true,
    startsNewTopic: true,
    cachesModels: true,
    terminalName: 'Antigravity',
    consumesProtocols: ['google-generative-ai'] as const,
  };
  readonly launchEnv = {
    managed: ['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'AGY_CLI_DISABLE_AUTO_UPDATE'],
    secrets: ['GEMINI_API_KEY'],
  };
  readonly terminal = {
    title: 'Antigravity',
    ready: (screen: string) => READY_PATTERN.test(screen),
    startupError: (screen: string) => agyStartupError(screen),
  };
  private readonly discussions = new AbortController();
  private readonly hub: Hub;
  private readonly runtimes: Hub['runtimes'];

  constructor(options: { stateDir: string }) {
    this.hub = {
      stateDir: options.stateDir,
      closed: false,
      runtimes: new Map(),
      attaching: new Map(),
      opening: new Map(),
      watchers: new Map(),
      lifecycle: new Map(),
      catalogs: new Map(),
      reopen: (host, context) => this.open(host, context),
    };
    this.runtimes = this.hub.runtimes;
  }

  profiles(): AgentProfile[] {
    return [{ id: 'default', name: 'Antigravity CLI', isDefault: true, config: {} }];
  }

  validateProfileConfig(config: Record<string, unknown>): void {
    parseAgyProfile(config);
  }

  validateNativeSessionId(id: string): void {
    agyConversationId(id);
  }

  normalizeModel(model: string): string {
    agySelection(model);
    return model.trim();
  }

  capabilities(): AgentCapabilities {
    return capabilities();
  }

  extensionLayout(profile: AgentProfile): AgentExtensionLayout {
    return extensionLayout(parseAgyProfile(profile.config).sourceDir);
  }

  async available(_host: AgentHost, profile: AgentProfile) {
    const parsed = parseAgyProfile(profile.config);
    const resolution = resolveCliExecutable({ command: parsed.executable });
    if (!resolution.resolved)
      return { available: false, ...(isCliMissing(resolution) ? { cliMissing: true } : {}), reason: 'Antigravity CLI (agy) was not found' };
    const result = await runProcess(parsed.executable, ['--version'], { cwd: process.cwd(), timeoutMs: 5000, maxOutputBytes: 4096 }).catch(
      () => undefined,
    );
    const version = result?.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0];
    return {
      available: result?.code === 0,
      ...(version ? { version } : {}),
      ...(result?.code === 0 ? {} : { reason: 'Antigravity CLI could not start' }),
    };
  }

  describeProfile(profile: AgentProfile) {
    const p = parseAgyProfile(profile.config);
    return { executable: p.executable, sourceDir: p.sourceDir, apiEndpoint: p.apiEndpoint, disableAutoUpdate: p.disableAutoUpdate };
  }

  listModels(host: AgentHost, query: AgentModelQuery) {
    return listModels(this.hub, host, query);
  }

  invalidateModels(): void {
    this.hub.catalogs.clear();
  }

  streamDiscussion(host: AgentHost, profile: AgentProfile, request: AgentDiscussionRequest): Promise<void> {
    return streamAgyDiscussion(this.hub, host, profile, { ...request, signal: AbortSignal.any([request.signal, this.discussions.signal]) });
  }

  async slashItems(host: AgentHost, project: AgentProjectView | undefined, profile: AgentProfile, session?: AgentSessionView): Promise<NativeSlashItem[]> {
    const standing = project ? host.standing?.launch(project, session) : undefined;
    if (standing) return await scanStandingSkills(standing);
    let sourceDir: string;
    try {
      sourceDir = (session && agySessionGeminiDir(this.hub.stateDir, session.id)) ?? parseAgyProfile(profile.config).sourceDir;
    } catch {
      sourceDir = join(homedir(), '.gemini');
    }
    const layout = extensionLayout(sourceDir);
    return await scanSkillRoots([
      ...(project ? layout.directories.project.skill.map(dir => join(project.cwd, dir)) : []),
      ...layout.directories.user.skill.map(dir => join(sourceDir, dir)),
      ...(layout.sharedRoot?.directories.skill ?? []).map(dir => join(homedir(), dir)),
    ]);
  }

  status(_host: AgentHost, context: AgentContext): NativeStatus {
    const id = context.session.id;
    // With no runtime, the terminal is either being attached or launched, or there is nothing to reach: an exited
    // pane, or one whose launch record does not match. `starting` there would hide the resume action for good.
    const pending = this.hub.attaching.has(id) || this.hub.opening.has(id);
    return this.runtimes.get(id)?.status ?? { phase: pending ? 'starting' : 'offline', connection: { state: 'disconnected' } };
  }

  async start(host: AgentHost): Promise<void> {
    const targets = host.view.sessions().filter(session => session.terminalId && !session.archivedAt);
    const BATCH_SIZE = 4;
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      await Promise.allSettled(
        targets.slice(i, i + BATCH_SIZE).map(async session => {
          const context = await loadContext(host, session.id);
          await attach(this.hub, host, context);
        }),
      );
    }
  }

  open(host: AgentHost, context: AgentContext): Promise<AgentOpenResult> {
    return open(this.hub, host, context);
  }

  send(host: AgentHost, request: AgentSendRequest) {
    return send(this.hub, host, request);
  }

  async configure(host: AgentHost, context: AgentContext, patch: AgentConfigurePatch) {
    agySelection(patch.model);
    agyMode(patch.mode);
    agyToolPermission(patch.approval);
    await host.updateSession(context.session.id, { ...patch, configPending: true }, { bump: true });
    const runtime = await attach(this.hub, host, context);
    // The scheduler applies saved intent when the native composer and all native work are idle.
    // A stopped session picks it up on its next explicit open.
    if (runtime) queueConfiguration(this.hub, runtime);
    return patch;
  }

  runtimeAction(host: AgentHost, context: AgentContext, request: { action: string; revision: string }): Promise<void> {
    return runtimeAction(this.hub, host, context, request);
  }

  interrupt(host: AgentHost, context: AgentContext, options: AgentStopOptions = {}) {
    return interrupt(this.hub, host, context, options);
  }

  interaction(host: AgentHost, context: AgentContext) {
    return interaction(this.hub, host, context);
  }

  respond(host: AgentHost, context: AgentContext, response: NativeInteractionResponse): Promise<NativeInteractionResult> {
    return respond(this.hub, host, context, response);
  }

  observe(host: AgentHost, context: AgentContext, report: AgentReport) {
    // Attaching first makes the first report `starting`; an attach that finds nothing reports again, as offline.
    const attached = attach(this.hub, host, context).catch(() => undefined);
    report({ type: 'status', status: this.status(host, context) });
    void attached.then(runtime => {
      if (!runtime) report({ type: 'status', status: this.status(host, context) });
    });
    return () => {};
  }

  transcriptSource(host: AgentHost, context: AgentContext) {
    const id = context.session.id;
    const { hub } = this;
    return new AntigravityTranscriptSource({
      sessionId: id,
      nativeId: () => host.view.session(id)?.nativeSessionId,
      geminiDir: () => this.geminiDir(id),
      live: () => hub.runtimes.get(id)?.snapshot,
      watch: wake => {
        const set = hub.watchers.get(id) ?? new Set();
        hub.watchers.set(id, set);
        set.add(wake);
        return () => {
          set.delete(wake);
          if (!set.size) hub.watchers.delete(id);
        };
      },
      host,
    });
  }

  async readHistory(_host: AgentHost, context: AgentContext, options?: AgentHistoryOptions) {
    return context.session.nativeSessionId
      ? readAgyHistory(this.geminiDir(context.session.id), context.session.nativeSessionId, context.session.id, options)
      : { events: [], subagents: [] };
  }

  /** A session's data root never changes once recorded; the transcript reads it on every wake, so it is kept. */
  private readonly roots = new Map<string, string>();
  private geminiDir(id: string): string {
    const known = this.roots.get(id);
    if (known) return known;
    const recorded = agySessionGeminiDir(this.hub.stateDir, id);
    if (!recorded) return join(sessionRoot(this.hub, id), 'native');
    this.roots.set(id, recorded);
    return recorded;
  }

  canReleaseInput(host: AgentHost, context: AgentContext, run: AgentRunRef): Promise<boolean> {
    return this.checkInputRelease(host, context, run, false);
  }

  canReleaseAfterLaterTurn(host: AgentHost, context: AgentContext, run: AgentRunRef): Promise<boolean> {
    return this.checkInputRelease(host, context, run, true);
  }

  private async checkInputRelease(
    host: AgentHost,
    context: AgentContext,
    run: AgentRunRef,
    requireLaterTurn: boolean,
  ): Promise<boolean> {
    try {
      if (!run.nativeInputBoundary) return false;
      let boundary: AgyRecord;
      try {
        const parsed: unknown = JSON.parse(run.nativeInputBoundary);
        if (!agyRecord(parsed)) return false;
        boundary = parsed;
      } catch {
        return false;
      }
      if (boundary.version !== 1 || typeof boundary.root !== 'string' || !Array.isArray(boundary.users)) return false;

      const sessionId = context.session.id;
      const runtime = this.runtimes.get(sessionId);
      if (
        !runtime ||
        runtime.stopped ||
        runtime.conflict ||
        runtime.cancelling ||
        !runtime.rpc ||
        runtime.status.connection?.state !== 'connected'
      ) {
        return false;
      }
      await host.transcript.drain?.(sessionId);
      const session = host.view.session(sessionId);
      if (!session || session.archivedAt || !session.terminalId || session.terminalId !== runtime.launch.terminalId) return false;

      const [boundRoot, launchRoot] = await Promise.all([
        realpath(boundary.root).catch(() => boundary.root),
        realpath(runtime.launch.geminiDir).catch(() => runtime.launch.geminiDir),
      ]);
      if (boundRoot !== launchRoot) return false;
      if (boundary.id && boundary.id !== session.nativeSessionId) return false;
      if (run.nativeSessionId && run.nativeSessionId !== session.nativeSessionId) return false;

      if (
        runtime.status.phase !== 'idle' ||
        runtime.status.activeTurn ||
        runtime.status.interaction ||
        runtime.status.activity?.background ||
        runtime.status.activity?.compacting
      ) {
        return false;
      }
      const status = await nativeStatus(runtime);
      if (!idle(runtime, status) || (status?.conversation_id ?? '') !== (session.nativeSessionId ?? '')) return false;

      const snap = runtime.snapshot;
      if (session.nativeSessionId) {
        if (!snap || snap.conversationId !== session.nativeSessionId || waiting(snap) || interactionOf(snap)) return false;
        if (boundary.trajectoryId && snap.trajectoryId !== boundary.trajectoryId) return false;
        const hasText = Boolean(run.renderedText?.trim());
        const recorded = snap.steps.some((step, index) => {
          if (!step.userInput) return false;
          const identity = agyStepIdentity(snap, step, index);
          if (boundary.users.includes(identity)) return false;
          const body = step.userInput.userResponse;
          if (hasText) {
            if (sameInput(body, run.renderedText)) return true;
            if (run.inputText && run.inputText !== run.renderedText && sameInput(body, run.inputText)) return true;
            return false;
          }
          const bodyText = typeof body === 'string' ? body : '';
          const hasMedia =
            (Array.isArray(step.userInput.images) && step.userInput.images.length > 0) ||
            (Array.isArray(step.userInput.media) && step.userInput.media.length > 0);
          return !bodyText.trim() && hasMedia;
        });
        if (recorded) return false;
        if (requireLaterTurn) {
          const sentAt = run.inputSentAt ?? run.dispatchAt;
          if (sentAt === undefined) return false;
          const turns = mapLiveSnapshot(snap, sessionId).turns;
          const hasLaterCompleted = turns.some(turn => {
            if (!turn.status || turn.id === run.nativeTurnId) return false;
            const startedAt = Date.parse(turn.at);
            return Number.isFinite(startedAt) && startedAt > sentAt;
          });
          if (!hasLaterCompleted) return false;
        }
      } else {
        if (requireLaterTurn || snap) return false;
      }

      const terminal = await host.terminals.get(session.terminalId);
      if (!terminal || terminal.state === 'exited' || terminal.epoch !== runtime.launch.epoch || (requireLaterTurn && terminal.ownerId)) {
        return false;
      }
      const screen = await host.terminals.screen(session.terminalId, { fresh: true });
      if (!screen || !emptyComposer(screen)) return false;
      if (host.dialogs.isResponding?.(session.terminalId)) return false;
      if (await host.dialogs.current?.(sessionId)) return false;

      // Re-verify terminal epoch, session binding, and idle state after screen capture.
      const latestTerminal = await host.terminals.get(session.terminalId);
      if (
        !latestTerminal ||
        latestTerminal.state === 'exited' ||
        latestTerminal.epoch !== terminal.epoch ||
        (requireLaterTurn && latestTerminal.ownerId)
      ) {
        return false;
      }
      const latestSession = host.view.session(sessionId);
      const latestStatus = await nativeStatus(runtime);
      return Boolean(
        latestSession &&
          !latestSession.archivedAt &&
          latestSession.terminalId === session.terminalId &&
          latestSession.nativeSessionId === session.nativeSessionId &&
          !runtime.stopped &&
          !runtime.conflict &&
          runtime.status.phase === 'idle' &&
          !runtime.status.activeTurn &&
          !runtime.status.interaction &&
          idle(runtime, latestStatus),
      );
    } catch {
      return false;
    }
  }

  detach(_host: AgentHost, id: string): void {
    detach(this.hub, id);
  }

  async stop(host: AgentHost, id: string): Promise<void> {
    const terminalId = host.view.session(id)?.terminalId;
    detach(this.hub, id);
    this.roots.delete(id);
    if (terminalId) await host.terminals.stop(terminalId);
  }

  close(host?: AgentHost): void {
    this.discussions.abort();
    this.hub.closed = true;
    this.roots.clear();
    for (const [id, runtime] of this.hub.runtimes) this.detach(host ?? runtime.host, id);
  }
}
