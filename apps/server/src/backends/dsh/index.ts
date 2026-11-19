import { queryDirectory } from '../shared/query-directory.js';
import type {
  ModelInfo, NativeActivity, NativeBackendCapabilities,
  NativeBackendId, NativeSlashItem, NativeInteraction, NativeInteractionResponse,
  NativeInteractionResult, NativeStatus,
  Project, Session,
} from '../../../../../packages/contracts/src/index.js';
import { AppError } from '../../errors.js';
import { readDshShare } from './share-read.js';
import { DshTranscriptSource } from './journal-source.js';
import type { TranscriptSource } from '../../journal/ingest.js';
import { fetchGatewayModels } from '../shared/gateway-models.js';
import type {
  NativeBackendAvailability, NativeBackendDriver, NativeBackendHost, NativeBackendProfileConfig, NativeShareReadOptions,
  NativeBackendSendRequest, NativeBackendConfigurePatch, NativeBackendConfigureResult,
  NativeBackendOpenResult, NativeBackendTraits, NativeControlMessage,
  NativeDriverExtensions, NativeDriverStored,
} from '../types.js';
import { canonicalDshModelValue, closeDshProfileRuntimes, disposeDshSession, dshPermission, getDshProfileRuntime, nativeDshSessionId, probeDshCli, validateDshNativeSessionId } from './runtime.js';
import { DSH_CLI_VERSIONS } from './settings.js';

const BACKEND_ID: NativeBackendId = 'dsh';
const PROFILE_ID = 'local';
const MAX_RPC_REQUEST_BYTES = 60 * 1024 * 1024;

interface DshAttachmentInfo {
  id: string;
  name: string;
  mimeType: string;
  width?: number;
  height?: number;
}

interface DshPromptPayload {
  content: Array<Record<string, unknown>>;
  attachments: DshAttachmentInfo[];
  renderedText: string;
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function defaultProfile(): NativeBackendProfileConfig {
  const config: Record<string, unknown> = {
    ...(envValue('DSH_CLI') ? { executable: envValue('DSH_CLI') } : {}),
    ...(envValue('DSH_CONFIG_DIR') ? { configDir: envValue('DSH_CONFIG_DIR') } : {}),
    ...(envValue('DSH_SOURCE_DIR') ? { sourceDir: envValue('DSH_SOURCE_DIR') } : {}),
    ...(envValue('DEEPSEEK_BASE_URL') ? { apiEndpoint: envValue('DEEPSEEK_BASE_URL') } : {}),
    defaultModel: envValue('DEEPSEEK_MODEL') ?? 'deepseek-flash',
    ...(envValue('DEEPSEEK_API_KEY') ? { apiKey: envValue('DEEPSEEK_API_KEY') } : {}),
  };
  return { id: PROFILE_ID, backendId: BACKEND_ID, name: 'DeepSeek Harness', isDefault: true, config };
}

async function materializePrompt(host: NativeBackendHost, input: NativeBackendSendRequest['input']): Promise<DshPromptPayload> {
  const lines = [input.text];
  for (const context of input.context) lines.push(`@${context.path}${context.line ? `:${context.line}` : ''}`);
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: lines.join('\n') }];
  const attachments: DshAttachmentInfo[] = [];
  for (const id of input.attachmentIds) {
    const { attachment, data } = await host.readAttachment(id);
    attachments.push({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      ...(attachment.width !== undefined ? { width: attachment.width } : {}),
      ...(attachment.height !== undefined ? { height: attachment.height } : {}),
    });
    const encoded = data.toString('base64');
    if (/^image\//i.test(attachment.mimeType)) {
      content.push({ type: 'image', data: encoded, mediaType: attachment.mimeType, name: attachment.name });
    } else {
      content.push({ type: 'file', data: encoded, name: attachment.name });
    }
  }
  const renderedText = lines.join('\n');
  const encodedBytes = Buffer.byteLength(JSON.stringify({ content, attachments, renderedText }));
  if (encodedBytes > MAX_RPC_REQUEST_BYTES) {
    throw new AppError('NATIVE_INPUT_TOO_LARGE', 'The DSH prompt and attachments exceed the bridge message limit.', 413);
  }
  return { content, attachments, renderedText };
}

/** DeepSeek Harness' native Session/Agent backend, driven through a no-TUI DSH profile bridge. */
/** DSH accepts follow-ups into its own inbox even while running. */
export const DSH_TRAITS: NativeBackendTraits = { acceptsInputWhileBusy: true, offlineMayBeRunning: true };

export class DshBackendAdapter implements NativeBackendDriver {
  readonly extensions: NativeDriverExtensions = {
    runtime: (host, project, profile) => this.extensionRuntime(host, project, profile),
    managementCapabilities: () => this.extensionManagementCapabilities(),
    manage: (host, profile, input, item) => this.manageExtension(host, profile, input, item),
  };
  readonly stored: NativeDriverStored = {
    share: (host, session, profile, options) => this.readShareTranscript(host, session, profile, options),
  };
  readonly id = BACKEND_ID;
  readonly label = 'DeepSeek Harness';
  readonly traits = DSH_TRAITS;
  readonly cliVersions = DSH_CLI_VERSIONS;

  profiles(_host: NativeBackendHost): NativeBackendProfileConfig[] { return [defaultProfile()]; }

  gatewayProfile(profile: NativeBackendProfileConfig): NativeBackendProfileConfig | undefined {
    if (typeof profile.config.apiEndpoint === 'string' && profile.config.apiEndpoint.trim()) return profile;
    if (typeof profile.config.apiKey === 'string' && profile.config.apiKey.trim()) {
      return { ...profile, config: { ...profile.config, apiEndpoint: 'https://api.deepseek.com' } };
    }
    return undefined;
  }

  private extensionManagementCapabilities(): import('../../../../../packages/contracts/src/index.js').ExtensionManagementCapabilities {
    return { actions: ['install'], installScopes: ['user'], kinds: { plugin: ['install', 'enable', 'disable', 'uninstall'] }, reason: '插件操作使用 DSH profile 的原生管理服务；必要时启动管理连接。' };
  }

  private async extensionRuntime(host: NativeBackendHost, _project: Project | undefined, profile: NativeBackendProfileConfig) {
    return getDshProfileRuntime(profile, host).extensionRuntime();
  }

  private async manageExtension(host: NativeBackendHost, profile: NativeBackendProfileConfig, input: import('../../../../../packages/contracts/src/index.js').ExtensionActionRequest, item?: import('../../../../../packages/contracts/src/index.js').ExtensionItem) {
    if (input.scope === 'project') throw new AppError('EXTENSION_SCOPE_UNSUPPORTED', 'DSH plugins belong to a backend profile and cannot be installed per project', 409, undefined, { subject: 'dsh' });
    const target = item?.nativeId ?? input.target;
    if (!target || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9._-]+)?$/.test(target)) throw new AppError('INVALID_EXTENSION_TARGET', 'Use a DSH npm bundle name, optionally with a fixed version', 400, undefined, { subject: 'dsh' });
    return getDshProfileRuntime(profile, host).manageExtension(input.action, target);
  }

  capabilities(_host: NativeBackendHost, _profile: NativeBackendProfileConfig): NativeBackendCapabilities {
    return {
      backendId: BACKEND_ID,
      label: this.label,
      modes: [],
      permissions: [
        { id: 'workspace-write', label: 'Workspace write', description: 'Writes inside the workspace and temporary directories; anything wider asks first' },
        { id: 'read-only', label: 'Read only', description: 'Reads anything; every write asks first' },
        { id: 'danger-full-access', label: 'Full access', description: 'No sandbox and no approval prompts' },
        { id: 'auto', label: 'Auto review (experimental)', shortLabel: 'Auto review', description: 'The agent\'s own model reviews each tool call before it runs with full access, and a denied call asks you; it costs extra tokens and can misjudge' },
      ],
      interactionTransport: 'protocol',
      supportsResume: true,
      supportsInterrupt: true,
      supportsHistory: true,
      supportsModelSelection: true,
      supportsModeSelection: false,
      supportsPermissionSelection: true,
      supportsTerminal: false,
      supportsPrewarm: false,
      supportsSessionReferences: true,
      slashCommands: [],
      inlineSkills: true,
    };
  }

  async available(_host: NativeBackendHost, profile: NativeBackendProfileConfig): Promise<NativeBackendAvailability> {
    return await probeDshCli(profile);
  }

  normalizeModel(model: string, profile: NativeBackendProfileConfig): string {
    return canonicalDshModelValue(model, String(profile.config.defaultModel ?? 'deepseek-flash'));
  }

  validateNativeSessionId(value: string): void { validateDshNativeSessionId(value); }

  async openOrResume(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig): Promise<NativeBackendOpenResult> {
    return await host.withSessionLock(session.id, async () => {
      const runtime = getDshProfileRuntime(profile, host);
      const opened = await runtime.open(session, project, profile);
      const current = host.setNativeSessionId(session.id, opened.nativeSessionId);
      return { nativeSessionId: current.nativeSessionId ?? opened.nativeSessionId, status: opened.status };
    });
  }

  async send(host: NativeBackendHost, request: NativeBackendSendRequest): Promise<void> {
    await host.withSessionLock(request.session.id, async () => {
      const payload = await materializePrompt(host, request.input);
      if (host.isRunCancelled(request.runId)) return;
      const runtime = getDshProfileRuntime(request.profile, host);
      const session = host.getSession(request.session.id);
      const opened = await runtime.open(session, request.project, request.profile);
      const current = host.setNativeSessionId(session.id, opened.nativeSessionId);
      await runtime.send({
        session: current,
        project: request.project,
        profile: request.profile,
        commandId: request.commandId,
        runId: request.runId,
        config: request.config,
        content: payload.content,
        attachments: payload.attachments,
        renderedText: payload.renderedText,
        isCancelled: () => host.isRunCancelled(request.runId),
        commitDispatchFence: request.commitDispatchFence,
      });
    });
  }

  async interrupt(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, options?: { beforeWrite?: () => void }): Promise<void> {
    if (!session.nativeSessionId) return;
    await host.withSessionLock(session.id, async () => {
      options?.beforeWrite?.();
      await getDshProfileRuntime(profile, host).interrupt(session, options?.beforeWrite);
    });
  }

  async stopActivity(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, activityId: string): Promise<NativeActivity> {
    return await getDshProfileRuntime(profile, host).stopActivity(session, activityId);
  }

  async respond(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, response: NativeInteractionResponse): Promise<NativeInteractionResult> {
    return await host.withSessionLock(session.id, async () => {
      return await getDshProfileRuntime(profile, host).respond(session, response);
    });
  }

  async configure(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, patch: NativeBackendConfigurePatch): Promise<NativeBackendConfigureResult> {
    return await host.withSessionLock(session.id, async () => {
      if (patch.mode !== undefined && patch.mode !== 'agent') {
        throw new AppError('NATIVE_MODE_UNSUPPORTED', 'DeepSeek Harness only supports Agent mode.', 400);
      }
      const normalizedPatch = patch.model === undefined ? patch : { ...patch, model: this.normalizeModel(patch.model, profile) };
      const runtime = getDshProfileRuntime(profile, host);
      // DSH installs a selection on a live agent, so a conversation that is not open is resumed
      // first — the order DSH's own session controller uses (`resolveAgent` before `selectModel`).
      // Without it the change only reached the workbench's record, and DSH's own state reported the
      // model it still held back over it on the next read.
      runtime.setConfiguring(session.id, true);
      try {
        if (!runtime.isOpen(session.id)) {
          // The resume carries the record as it stands; the change itself is installed by
          // `session/configure` below, once the bridge has validated it. Applying the approval here
          // instead would leave DSH ahead of the record whenever the model is refused.
          const opened = await runtime.open(session, host.getProject(session.projectId), profile);
          host.setNativeSessionId(session.id, opened.nativeSessionId);
        }
        const result = await runtime.configure(session, normalizedPatch);
        if (result.failure) {
          if (result.failure.reason === 'session-not-open') throw new AppError('NATIVE_SESSION_NOT_OPEN', 'DeepSeek Harness did not hold this conversation; try the switch again', 409);
          if (result.failure.reason === 'permission-unavailable') throw new AppError('INVALID_APPROVAL_MODE', result.failure.message ?? 'This DeepSeek Harness profile does not offer the selected permission preset', 400);
          throw new AppError('INVALID_MODEL', result.failure.message ?? 'This DeepSeek Harness profile cannot serve the selected model', 400);
        }
        return {
          ...(normalizedPatch.model !== undefined ? { model: normalizedPatch.model } : {}),
          ...(patch.mode !== undefined ? { mode: 'agent' } : {}),
          ...(patch.approval !== undefined ? { approval: dshPermission(patch.approval) } : {}),
          ...(result.nativeSessionId ? { nativeSessionId: result.nativeSessionId } : {}),
        };
      } finally {
        runtime.setConfiguring(session.id, false);
      }
    });
  }

  async slashItems(host: NativeBackendHost, project: Project | undefined, profile: NativeBackendProfileConfig): Promise<NativeSlashItem[]> {
    return await getDshProfileRuntime(profile, host).slashItems(await queryDirectory(project, profile));
  }

  async listModels(host: NativeBackendHost, _project: Project | undefined, profile: NativeBackendProfileConfig, session?: Session): Promise<ModelInfo[]> {
    void session;
    const listed = await getDshProfileRuntime(profile, host).models();
    const endpoint = typeof profile.config.apiEndpoint === 'string' ? profile.config.apiEndpoint.trim() : '';
    if (!endpoint) return listed;
    // DSH only names its built-in DeepSeek ids, yet forwards any id to the configured gateway.
    // A gateway is asked what it really serves, the way Claude profiles are. The gateway is also
    // the only authority on the reasoning ladder of an id DSH does not catalog, and DSH carries a
    // chosen effort in the model string (`dsh:<provider>:<model>[effort=…]`), so its ladder is read.
    const apiKey = typeof profile.config.apiKey === 'string' && profile.config.apiKey ? profile.config.apiKey : undefined;
    const served = await fetchGatewayModels({ baseUrl: endpoint, ...(apiKey ? { apiKey } : {}), reasoningLevels: true }).catch(() => []);
    if (!served.length) return listed;
    return mergeDshModelListing(listed, served, id => this.normalizeModel(id, profile));
  }

  /** DSH's stored session log, read in place (see `journal-source.ts`); building or pulling it starts nothing. */
  transcript(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): TranscriptSource {
    const runtime = getDshProfileRuntime(profile, host);
    return new DshTranscriptSource({
      sessionId: session.id,
      nativeSessionId: () => nativeDshSessionId(host.getSession(session.id)),
      cwd: () => host.getProject(host.getSession(session.id).projectId).cwd,
      logs: runtime.logs(),
      runOf: commandId => host.findRunIdByCommand(session.id, commandId),
      observe: (nativeSessionId, listener) => runtime.observe(nativeSessionId, listener),
      failureMessage: data => runtime.turnFailureMessage(data, profile),
    });
  }

  private readShareTranscript(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, options?: NativeShareReadOptions) {
    return readDshShare(host, session, profile, options);
  }

  interaction(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): NativeInteraction | undefined {
    return getDshProfileRuntime(profile, host).interaction(session);
  }

  status(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig): NativeStatus {
    return getDshProfileRuntime(profile, host).status(session);
  }

  subscribe(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, listener: (message: NativeControlMessage) => void): () => void {
    return getDshProfileRuntime(profile, host).subscribe(session, host.getProject(session.projectId), profile, listener);
  }

  async dispose(_host: NativeBackendHost, sessionId: string): Promise<void> {
    await disposeDshSession(_host, sessionId);
  }

  async close(host: NativeBackendHost): Promise<void> {
    await closeDshProfileRuntimes(host);
  }
}

/**
 * The picker's catalog: what the gateway serves, described as richly as either side can describe it.
 *
 * DSH's own entry used to be the better answer whenever it had one, because a match meant DSH
 * catalogued the model itself. That stopped being true once Riffet started writing a gateway id into
 * DSH's catalog to declare its input types: such a row carries input types and nothing else, so
 * preferring it wholesale would silently drop the gateway's reasoning ladder — the picker's Effort
 * control. A DSH entry therefore only wins when it has a ladder of its own to offer.
 *
 * @param listed - what DSH reports for the profile, already carrying any declared catalog rows.
 * @param served - what the gateway reports for the same profile.
 * @param normalize - DSH's canonical spelling of one id.
 * @returns one entry per served model, in the gateway's order.
 */
export function mergeDshModelListing(listed: ModelInfo[], served: ModelInfo[], normalize: (id: string) => string): ModelInfo[] {
  const known = new Map(listed.map(model => [model.value, model]));
  return served.map(model => {
    const value = normalize(model.value);
    const dsh = known.get(value);
    return dsh && dsh.configOptions.length ? dsh : { ...model, value };
  });
}
