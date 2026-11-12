import { readContextFile } from '../../context-references/read-file.js';
import type {
  ModelInfo, NativeBackendCapabilities, NativeBackendId, NativeInteraction,
  NativeInteractionResponse, NativeInteractionResult, NativeSlashItem, NativeStatus, Project, Session,
} from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import type { TranscriptSource } from '../../journal/ingest.js';
import type { UsageEntry, UsageTranscript } from '../../stats/types.js';
import type { CliVersionRange } from '../shared/cli-version.js';
import type {
  NativeBackendAvailability, NativeBackendConfigurePatch, NativeBackendConfigureResult, NativeBackendDriver, NativeBackendHost,
  NativeBackendOpenResult, NativeBackendProfileConfig, NativeBackendSendRequest, NativeBackendTraits, NativeControlMessage,
  NativeShareReadOptions, NativeShareTranscript,
  NativeDriverStored,
} from '../types.js';
import { findPiTranscript, piEntryUsage, parsePiTranscript, readPiTranscript, validatePiSessionId, type PiEntry } from './history.js';
import { invalidatePiModels, listPiModels, listPiSlashItems, probePiCli, PI_MINIMUM_VERSION } from './models.js';
import { projectPiChain } from './projection.js';
import { closePiRuntime, getPiRuntime } from './runtime.js';
import { piCustomEndpoint, piProviderId } from './provider.js';

const BACKEND_ID: NativeBackendId = 'pi';
const PROFILE_ID = 'local';

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function defaultProfile(): NativeBackendProfileConfig {
  const config: Record<string, unknown> = {
    ...(envValue('PI_CLI') ? { executable: envValue('PI_CLI') } : {}),
    ...(envValue('PI_MODEL') ? { defaultModel: envValue('PI_MODEL') } : {}),
    ...(envValue('PI_CODING_AGENT_DIR') ? { configDir: envValue('PI_CODING_AGENT_DIR') } : {}),
  };
  return { id: PROFILE_ID, backendId: BACKEND_ID, name: 'pi', isDefault: true, config };
}

/** pi answers a prompt with its own queue, but Riffet never uses it: one run at a time. */
export const PI_TRAITS: NativeBackendTraits = {
  acceptsInputWhileBusy: false,
  untaggedEcho: false,
  completesOnTurnEvent: true,
  offlineMayBeRunning: true,
  resumesByNativeId: true,
  riffetTools: true,
};

/** The RPC commands this adapter relies on first shipped together in 1.4.0. */
export const PI_CLI_VERSIONS: CliVersionRange = { minimum: PI_MINIMUM_VERSION, testedThrough: PI_MINIMUM_VERSION };

/** The provider/model an assistant entry recorded, when it names one. */
function modelOf(entry: PiEntry): string | undefined {
  const message = entry.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const value = message as Record<string, unknown>;
  const provider = typeof value.provider === 'string' ? value.provider : undefined;
  const model = typeof value.model === 'string' ? value.model : undefined;
  return provider && model ? `${provider}/${model}` : model;
}

/** The pi coding agent, driven through `pi --mode rpc` with one process per conversation. */
export class PiBackendAdapter implements NativeBackendDriver {
  readonly stored: NativeDriverStored = {
    readOnly: true,
    usage: (host, session, profile, known) => this.usageTranscript(host, session, profile, known),
    context: (host, session, profile, options) => this.readContextTranscript(host, session, profile, options),
    share: (host, session, profile, options) => this.readShareTranscript(host, session, profile, options),
  };
  readonly id = BACKEND_ID;
  readonly label = 'pi';
  readonly traits = PI_TRAITS;
  readonly cliVersions = PI_CLI_VERSIONS;

  private readonly stateDir?: string;

  constructor(options: { stateDir?: string } = {}) {
    this.stateDir = options.stateDir;
  }

  profiles(_host: NativeBackendHost): NativeBackendProfileConfig[] { return [defaultProfile()]; }

  capabilities(_host: NativeBackendHost, _profile: NativeBackendProfileConfig): NativeBackendCapabilities {
    return {
      backendId: BACKEND_ID,
      label: this.label,
      modes: [{ id: 'agent', label: 'Agent' }],
      permissions: [],
      interactionTransport: 'protocol',
      supportsResume: true,
      supportsInterrupt: true,
      supportsSteer: false,
      supportsHistory: true,
      supportsModelSelection: true,
      supportsModeSelection: false,
      supportsPermissionSelection: false,
      supportsTerminal: false,
      supportsPrewarm: false,
      slashCommands: [],
      inlineSkills: false,
    };
  }

  async available(_host: NativeBackendHost, profile: NativeBackendProfileConfig): Promise<NativeBackendAvailability> {
    return await probePiCli(profile);
  }

  normalizeModel(model: string, profile?: NativeBackendProfileConfig): string {
    return profile && piCustomEndpoint(profile) ? model.trim().replace(new RegExp(`^${piProviderId(profile)}/`), '') : model.trim();
  }

  validateNativeSessionId(value: string): void { validatePiSessionId(value); }

  async openOrResume(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig): Promise<NativeBackendOpenResult> {
    return getPiRuntime(host, this.stateDir).open(session, project, profile);
  }

  async send(host: NativeBackendHost, request: NativeBackendSendRequest): Promise<void> {
    await host.withSessionLock(request.session.id, async () => {
      await getPiRuntime(host, this.stateDir).send({
        session: host.getSession(request.session.id),
        project: request.project,
        profile: request.profile,
        commandId: request.commandId,
        runId: request.runId,
        input: request.input,
        config: request.config,
        isCancelled: () => host.isRunCancelled(request.runId),
        commitDispatchFence: request.commitDispatchFence,
      });
    });
  }

  async interrupt(host: NativeBackendHost, session: Session, _profile?: NativeBackendProfileConfig, options?: { beforeWrite?: () => void }): Promise<void> {
    await getPiRuntime(host, this.stateDir).interrupt(session, options?.beforeWrite);
  }

  async respond(host: NativeBackendHost, session: Session, _profile: NativeBackendProfileConfig, response: NativeInteractionResponse): Promise<NativeInteractionResult> {
    return await getPiRuntime(host, this.stateDir).respond(session, response);
  }

  async configure(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, patch: NativeBackendConfigurePatch): Promise<NativeBackendConfigureResult> {
    if (patch.mode !== undefined && patch.mode !== 'agent') throw new AppError('NATIVE_MODE_UNSUPPORTED', 'pi runs in agent mode only.', 400);
    if (patch.approval !== undefined) throw new AppError('NATIVE_APPROVAL_UNSUPPORTED', 'pi has no approval selector.', 400);
    const model = patch.model === undefined ? undefined : this.normalizeModel(patch.model);
    return await host.withSessionLock(session.id, async () => {
      await getPiRuntime(host, this.stateDir).configure(host.getSession(session.id), host.getProject(session.projectId), profile, { ...patch, ...(model !== undefined ? { model } : {}) });
      return {
        ...(model !== undefined ? { model } : {}),
        ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      };
    });
  }

  async rename(host: NativeBackendHost, session: Session): Promise<void> {
    await getPiRuntime(host, this.stateDir).rename(session);
  }

  async slashItems(_host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig): Promise<NativeSlashItem[]> {
    return await listPiSlashItems(profile, project?.cwd);
  }

  async listModels(host: NativeBackendHost, _project: Project | undefined, profile: NativeBackendProfileConfig, session?: Session): Promise<ModelInfo[]> {
    if (piCustomEndpoint(profile)) return await listPiModels(profile);
    if (session) {
      try {
        const project = host.getProject(session.projectId);
        return await getPiRuntime(host, this.stateDir).listModels(session, project, profile);
      } catch { /* fall back to the files pi reads anyway */ }
    }
    try {
      return await listPiModels(profile);
    } catch {
      const fallback = typeof profile.config.defaultModel === 'string' ? profile.config.defaultModel : undefined;
      return fallback ? [{ value: fallback, name: fallback, configOptions: [] }] : [];
    }
  }

  invalidateModels(): void { invalidatePiModels(); }

  transcript(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): TranscriptSource {
    return getPiRuntime(host, this.stateDir).transcriptSource(session, profile);
  }

  private async readContextTranscript(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, options: { maxBytes: number; signal: AbortSignal }) {
    if (!session.nativeSessionId) return [];
    const file = await findPiTranscript(session.nativeSessionId, host.getProject(session.projectId).cwd, typeof profile.config.configDir === 'string' ? profile.config.configDir : undefined);
    if (!file) throw new AppError('SESSION_REFERENCE_UNAVAILABLE', 'The native history file is unavailable', 409);
    const transcript = parsePiTranscript(await readContextFile(file, options.maxBytes, options.signal), file, session.nativeSessionId);
    return projectPiChain(transcript, { sessionId: session.id, unbounded: true }, entryId => {
      const runId = host.findRunIdByNativeMessage(session.id, `msg:${entryId}`);
      return runId ? { runId } : undefined;
    }).filter(event => event.type === 'user_message_chunk' || event.type === 'agent_message_chunk');
  }

  /** A frozen export reads pi's own file only; it never starts the conversation. */
  private async readShareTranscript(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, options: NativeShareReadOptions = {}): Promise<NativeShareTranscript> {
    options.signal?.throwIfAborted();
    if (!session.nativeSessionId) return { events: [], subagents: [] };
    const cwd = host.getProject(session.projectId).cwd;
    const file = await findPiTranscript(session.nativeSessionId, cwd, typeof profile.config.configDir === 'string' ? profile.config.configDir : undefined);
    options.signal?.throwIfAborted();
    if (!file) throw new AppError('SHARE_HISTORY_UNAVAILABLE', 'The pi conversation history file does not exist', 409);
    const transcript = await readPiTranscript(file, session.nativeSessionId);
    options.signal?.throwIfAborted();
    const events = projectPiChain(transcript, { sessionId: session.id, unbounded: true }, entryId => {
      const runId = host.findRunIdByNativeMessage(session.id, `msg:${entryId}`);
      return runId ? { runId } : undefined;
    });
    return { events, subagents: [] };
  }

  /** Settled provider requests from pi's stored transcript, for the statistics backfill. */
  private async usageTranscript(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, known?: string): Promise<UsageTranscript | undefined> {
    if (!session.nativeSessionId) return known === 'none' ? undefined : { generation: 'none', entries: [] };
    const file = await findPiTranscript(session.nativeSessionId, host.getProject(session.projectId).cwd, typeof profile.config.configDir === 'string' ? profile.config.configDir : undefined);
    if (!file) return known === 'none' ? undefined : { generation: 'none', entries: [] };
    const transcript = await readPiTranscript(file, session.nativeSessionId);
    const generation = `pi:${transcript.generation}`;
    if (generation === known) return undefined;
    const entries: UsageEntry[] = [];
    for (const entry of transcript.entries) {
      const usage = piEntryUsage(entry);
      if (!usage) continue;
      const runId = host.findRunIdByNativeMessage(session.id, `msg:${entry.id}`);
      const model = modelOf(entry) ?? transcript.model;
      const at = Date.parse(entry.timestamp);
      entries.push({
        ...(runId ? { runId } : {}),
        usage: {
          stepId: `pi:${entry.id}`,
          ...(model ? { model } : {}),
          ...(Number.isFinite(at) ? { endedAt: at } : {}),
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
          tokenSource: 'provider',
        },
      });
    }
    return { generation, entries };
  }

  interaction(host: NativeBackendHost, session: Session): NativeInteraction | undefined {
    return getPiRuntime(host, this.stateDir).interaction(session);
  }

  status(host: NativeBackendHost, session: Session): NativeStatus {
    return getPiRuntime(host, this.stateDir).status(session);
  }

  subscribe(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, listener: (message: NativeControlMessage) => void): () => void {
    return getPiRuntime(host, this.stateDir).subscribe(session, host.getProject(session.projectId), profile, listener);
  }

  async dispose(host: NativeBackendHost, sessionId: string): Promise<void> {
    await getPiRuntime(host, this.stateDir).dispose(sessionId);
  }

  async close(host: NativeBackendHost): Promise<void> {
    await closePiRuntime(host);
  }
}
