import { readContextFile } from '../../context-references/read-file.js';
import { queryDirectory } from '../shared/query-directory.js';
import type {
  ModelInfo, NativeBackendCapabilities, NativeBackendId, NativeInteraction,
  NativeInteractionResponse, NativeInteractionResult, NativeSlashItem, NativeStatus, Project, Session,
} from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import type { TranscriptSource } from '../../journal/ingest.js';
import { readDroidShare } from '../shared/share-read.js';
import type {
  NativeBackendAvailability, NativeBackendConfigurePatch, NativeBackendConfigureResult, NativeBackendDriver, NativeBackendHost,
  NativeBackendOpenResult, NativeBackendProfileConfig, NativeBackendSendRequest, NativeBackendTraits, NativeControlMessage, NativeShareReadOptions,
  NativeDriverStored,
} from '../types.js';
import { findDroidTranscript, parseDroidTranscript, projectDroidChain, validateDroidSessionId } from './history.js';
import { closeDroidRuntime, DROID_AUTONOMY_LEVELS, DROID_MODES, getDroidRuntime, listDroidModels, listDroidSlashItems, probeDroidCli } from './runtime.js';
import type { CliVersionRange } from '../shared/cli-version.js';

const BACKEND_ID: NativeBackendId = 'droid';
const PROFILE_ID = 'local';

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function defaultProfile(): NativeBackendProfileConfig {
  const config: Record<string, unknown> = {
    ...(envValue('DROID_CLI') ? { executable: envValue('DROID_CLI') } : {}),
    ...(envValue('DROID_MODEL') ? { defaultModel: envValue('DROID_MODEL') } : {}),
    ...(envValue('FACTORY_API_KEY') ? { apiKey: envValue('FACTORY_API_KEY') } : {}),
  };
  return { id: PROFILE_ID, backendId: BACKEND_ID, name: 'Droid', isDefault: true, config };
}

/** Factory's Droid, driven through `droid exec --input-format stream-jsonrpc` with one process per conversation. */
export const DROID_TRAITS: NativeBackendTraits = { offlineMayBeRunning: true, riffetTools: true };

/**
 * No release is known to break the adapter; the help probe gates `stream-jsonrpc`.
 */
export const DROID_CLI_VERSIONS: CliVersionRange = { testedThrough: '0.243.0' };

export class DroidBackendAdapter implements NativeBackendDriver {
  readonly stored: NativeDriverStored = {
    readOnly: true,
    context: (host, session, profile, options) => this.readContextTranscript(host, session, profile, options),
    share: (host, session, profile, options) => this.readShareTranscript(host, session, profile, options),
  };
  readonly id = BACKEND_ID;
  readonly label = 'Droid';
  readonly traits = DROID_TRAITS;
  readonly cliVersions = DROID_CLI_VERSIONS;

  profiles(_host: NativeBackendHost): NativeBackendProfileConfig[] { return [defaultProfile()]; }

  capabilities(_host: NativeBackendHost, _profile: NativeBackendProfileConfig): NativeBackendCapabilities {
    return {
      backendId: BACKEND_ID,
      label: this.label,
      modes: [
        { id: 'agent', label: 'Agent', description: 'Works on the task directly' },
        { id: 'spec', label: 'Spec', description: 'Writes a spec first and asks you to approve it before changing anything' },
      ],
      permissions: [
        { id: 'off', label: 'Ask first', description: 'Reads freely; asks before every edit and command' },
        { id: 'low', label: 'Auto (Low)', description: 'Edits files and runs read-only commands without asking' },
        { id: 'medium', label: 'Auto (Medium)', description: 'Also runs reversible commands, such as installs and local git' },
        { id: 'high', label: 'Auto (High)', description: 'Runs every command without asking, including irreversible ones' },
      ],
      interactionTransport: 'protocol',
      supportsResume: true,
      supportsInterrupt: true,
      supportsHistory: true,
      supportsModelSelection: true,
      supportsModeSelection: true,
      supportsPermissionSelection: true,
      supportsTerminal: false,
      supportsPrewarm: false,
      slashCommands: [],
      inlineSkills: true,
    };
  }

  async available(_host: NativeBackendHost, profile: NativeBackendProfileConfig): Promise<NativeBackendAvailability> {
    return await probeDroidCli(profile);
  }

  normalizeModel(model: string): string {
    return model.trim();
  }

  validateNativeSessionId(value: string): void { validateDroidSessionId(value); }

  async openOrResume(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig): Promise<NativeBackendOpenResult> {
    return getDroidRuntime(host).open(session, project, profile);
  }

  async send(host: NativeBackendHost, request: NativeBackendSendRequest): Promise<void> {
    await host.withSessionLock(request.session.id, async () => {
      await getDroidRuntime(host).send({
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

  async interrupt(host: NativeBackendHost, session: Session): Promise<void> {
    await getDroidRuntime(host).interrupt(session);
  }

  async respond(host: NativeBackendHost, session: Session, _profile: NativeBackendProfileConfig, response: NativeInteractionResponse): Promise<NativeInteractionResult> {
    return await getDroidRuntime(host).respond(session, response);
  }

  async configure(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, patch: NativeBackendConfigurePatch): Promise<NativeBackendConfigureResult> {
    if (patch.mode !== undefined && !(DROID_MODES as readonly string[]).includes(patch.mode)) {
      throw new AppError('NATIVE_MODE_UNSUPPORTED', 'Droid supports the Agent and Spec modes.', 400);
    }
    if (patch.approval !== undefined && !(DROID_AUTONOMY_LEVELS as readonly string[]).includes(patch.approval)) {
      throw new AppError('INVALID_APPROVAL_MODE', 'Droid autonomy is one of off, low, medium or high.', 400);
    }
    const model = patch.model === undefined ? undefined : this.normalizeModel(patch.model);
    return await host.withSessionLock(session.id, async () => {
      await getDroidRuntime(host).configure(host.getSession(session.id), host.getProject(session.projectId), profile, { ...patch, ...(model !== undefined ? { model } : {}) });
      return {
        ...(model !== undefined ? { model } : {}),
        ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
        ...(patch.approval !== undefined ? { approval: patch.approval } : {}),
      };
    });
  }

  async rename(host: NativeBackendHost, session: Session): Promise<void> {
    await getDroidRuntime(host).rename(session);
  }

  async slashItems(_host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig): Promise<NativeSlashItem[]> {
    return await listDroidSlashItems(profile, await queryDirectory(project, profile));
  }

  async listModels(_host: NativeBackendHost, _project: Project | undefined, profile: NativeBackendProfileConfig): Promise<ModelInfo[]> {
    try {
      return await listDroidModels(profile);
    } catch {
      const fallback = typeof profile.config.defaultModel === 'string' ? profile.config.defaultModel : undefined;
      return fallback ? [{ value: fallback, name: fallback, configOptions: [] }] : [];
    }
  }

  transcript(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): TranscriptSource {
    return getDroidRuntime(host).transcriptSource(session, profile);
  }

  private async readContextTranscript(host: NativeBackendHost, session: Session, _profile: NativeBackendProfileConfig, options: { maxBytes: number; signal: AbortSignal }) {
    if (!session.nativeSessionId) return [];
    const file = await findDroidTranscript(session.nativeSessionId, host.getProject(session.projectId).cwd);
    if (!file) throw new AppError('SESSION_REFERENCE_UNAVAILABLE', 'The native history file is unavailable', 409);
    const transcript = parseDroidTranscript(await readContextFile(file, options.maxBytes, options.signal), file, session.nativeSessionId);
    return projectDroidChain(transcript, { sessionId: session.id, unbounded: true }, messageId => {
      const runId = host.findRunIdByNativeMessage(session.id, messageId);
      return runId ? { runId, commandId: '' } : undefined;
    }).filter(event => event.type === 'user_message_chunk' || event.type === 'agent_message_chunk');
  }

  private readShareTranscript(host: NativeBackendHost, session: Session, _profile: NativeBackendProfileConfig, options?: NativeShareReadOptions) {
    return readDroidShare(host, session, options);
  }

  interaction(host: NativeBackendHost, session: Session): NativeInteraction | undefined {
    return getDroidRuntime(host).interaction(session);
  }

  status(host: NativeBackendHost, session: Session): NativeStatus {
    return getDroidRuntime(host).status(session);
  }

  subscribe(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, listener: (message: NativeControlMessage) => void): () => void {
    return getDroidRuntime(host).subscribe(session, host.getProject(session.projectId), profile, listener);
  }

  async dispose(host: NativeBackendHost, sessionId: string): Promise<void> {
    await getDroidRuntime(host).dispose(sessionId);
  }

  async close(host: NativeBackendHost): Promise<void> {
    await closeDroidRuntime(host);
  }
}
