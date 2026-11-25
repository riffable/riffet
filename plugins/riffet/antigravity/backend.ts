import { join } from 'node:path';
import type { NativeInteractionResponse, NativeInteractionResult, NativeStatus } from '@contracts';
import { isCliMissing, resolveCliExecutable, runProcess } from '@riffet/plugin-api/kit';
import {
  AGENT_PROTOCOL_VERSION, type AgentBackend, type AgentCapabilities, type AgentConfigurePatch, type AgentContext, type AgentDiscussionRequest, type AgentExtensionLayout, type AgentHost, type AgentModelQuery,
  type AgentOpenResult, type AgentProfile, type AgentReport, type AgentRunRef, type AgentSendRequest, type AgentStopOptions,
} from '@riffet/plugin-api/experimental/agent';
import { agyMode, agySelection, agyToolPermission, parseAgyProfile } from './config.js';
import { streamAgyDiscussion } from './discussion.js';
import { queueConfiguration } from './config-queue.js';
import { interrupt, runtimeAction } from './control.js';
import { attach } from './lifecycle.js';
import { open } from './launch.js';
import { COMMANDS, capabilities, extensionLayout } from './metadata.js';
import { listModels } from './models.js';
import { agyConversationId } from './protocol.js';
import { interaction, respond } from './respond.js';
import { detach, loadContext, sessionRoot, type Hub } from './runtime.js';
import { send } from './send.js';
import { AntigravityTranscriptSource, readAgyHistory } from './transcript.js';

export class AntigravityBackend implements AgentBackend {
  readonly id = 'antigravity' as const;
  readonly label = 'Antigravity';
  readonly protocolVersion = AGENT_PROTOCOL_VERSION;
  readonly cliVersions = { minimum: '1.5.6', testedThrough: '1.5.10' };
  readonly readOnlyHistory = true;
  readonly traits = {
    survivesRestart: true,
    resumesByNativeId: true,
    completesOnTurnEvent: true,
    offlineMayBeRunning: true,
    riffetTools: true,
    terminalName: 'Antigravity',
    consumesProtocols: ['google-generative-ai'] as const,
  };
  readonly launchEnv = {
    managed: ['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'AGY_CLI_DISABLE_AUTO_UPDATE'],
    secrets: ['GEMINI_API_KEY'],
  };
  readonly terminal = { title: 'Antigravity', ready: (screen: string) => /\? for shortcuts|Antigravity|Gemini.*Flash/.test(screen) };
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

  extensionLayout(): AgentExtensionLayout {
    return extensionLayout();
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

  streamDiscussion(host: AgentHost, profile: AgentProfile, request: AgentDiscussionRequest): Promise<void> {
    return streamAgyDiscussion(this.hub, host, profile, { ...request, signal: AbortSignal.any([request.signal, this.discussions.signal]) });
  }

  async slashItems() {
    return COMMANDS.map(name => ({ name, kind: 'command' as const }));
  }

  status(_host: AgentHost, context: AgentContext): NativeStatus {
    const id = context.session.id;
    // With no runtime, the terminal is either being attached or launched, or there is nothing to reach: an exited
    // pane, or one whose launch record does not match. `starting` there would hide the resume action for good.
    const pending = this.hub.attaching.has(id) || this.hub.opening.has(id);
    return this.runtimes.get(id)?.status ?? { phase: pending ? 'starting' : 'offline', connection: { state: 'disconnected' } };
  }

  async start(host: AgentHost): Promise<void> {
    for (const session of host.view.sessions()) {
      if (session.terminalId && !session.archivedAt) {
        const context = await loadContext(host, session.id).catch(() => undefined);
        if (context) await attach(this.hub, host, context).catch(() => undefined);
      }
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
      geminiDir: () => join(sessionRoot(hub, id), 'native'),
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

  async readHistory(_host: AgentHost, context: AgentContext) {
    return context.session.nativeSessionId
      ? readAgyHistory(join(sessionRoot(this.hub, context.session.id), 'native'), context.session.nativeSessionId, context.session.id)
      : { events: [], subagents: [] };
  }

  async canReleaseInput(_host: AgentHost, _context: AgentContext, _run: AgentRunRef) {
    return false;
  }

  detach(_host: AgentHost, id: string): void {
    detach(this.hub, id);
  }

  async stop(host: AgentHost, id: string): Promise<void> {
    const terminalId = host.view.session(id)?.terminalId;
    detach(this.hub, id);
    if (terminalId) await host.terminals.stop(terminalId);
  }

  close(host?: AgentHost): void {
    this.discussions.abort();
    this.hub.closed = true;
    for (const [id, runtime] of this.hub.runtimes) this.detach(host ?? runtime.host, id);
  }
}
