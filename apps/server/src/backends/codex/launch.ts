// How a conversation's app-server and its first thread start: by the conversation itself
// (`CodexSessionRuntime.start`/`openOrResume`), or ahead of it for the next new conversation of a project
// (a warm one, `WarmPool`). Both go through the same two steps here, so a warm thread is started exactly
// as the conversation would have started it.
import type { Project, Session } from '../../../../../packages/contracts/src/index.js';
import type { CodexAppServerClient, CodexAppServerFactory, CodexAppServerOptions } from '../shared/codex-app-server.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativeRiffetMcpHost } from '../types.js';
import { codexTrustArgs } from '../shared/cli-trust.js';
import { nativeModelEffort, nativeModelFast, parseNativeModelSelection, type NativeModelSelection } from '../shared/model-selection.js';
import { fastServiceTier, modelBackendVariant, resolveModelSelection } from './catalog.js';
import { credentialDirFor, executableOf, permissionOf, permissionParamsOf, probeAppServer, providerEnv, riffetMcpOverride, runtimeFingerprintFor } from './config.js';
import { extensionsOffNames } from '../../extensions/toggles.js';
import type { CodexFlavor } from './flavors.js';
import type { CodexObservation } from './observation.js';
import type { RpcThread } from './types.js';
import { str } from './util.js';

type Handlers = Pick<CodexAppServerOptions, 'onNotification' | 'onServerRequest' | 'onExit'>;
export type ThreadStart = { thread: RpcThread } & Record<string, unknown>;

/** The app-server a conversation of this project runs on, its messages going to `handlers`. */
export async function conversationServerOptions(
  project: Project, profile: NativeBackendProfileConfig, flavor: CodexFlavor, observation: CodexObservation | undefined, handlers: Handlers,
): Promise<CodexAppServerOptions> {
  const executable = executableOf(profile, flavor);
  return {
    executable,
    args: [...flavor.args(profile.config), ...codexTrustArgs(project.cwd), ...await observation?.launchArgs(executable) ?? []],
    cwd: project.cwd,
    env: providerEnv(profile, flavor),
    credentialDir: credentialDirFor(flavor),
    requiredHumanApproval: flavor.id === 'codex',
    ...handlers,
  };
}

/**
 * Spawns it as a listener the conversation's TUI can join where the build offers one. A listener whose
 * ownership or token enforcement cannot be proved is replaced by a Unix one, which no TUI joins
 * (`terminalUnavailable`).
 */
export async function spawnConversationServer(start: CodexAppServerFactory, flavor: CodexFlavor, options: CodexAppServerOptions): Promise<{ transport: CodexAppServerClient; terminalUnavailable: boolean }> {
  const shared = flavor.terminalTransport(await probeAppServer(options.executable));
  try {
    return { transport: await start({ ...options, listen: shared === 'ws' ? 'ws' : 'unix' }), terminalUnavailable: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'WS_AUTH_NOT_ENFORCED' && code !== 'WS_UNVERIFIED') throw error;
    return { transport: await start({ ...options, listen: 'unix' }), terminalUnavailable: true };
  }
}

/** `thread/start` for a new thread on `selection`; `config` is the conversation's own overrides, after the model's. */
export function newThreadRequest(
  flavor: CodexFlavor, cwd: string, selection: NativeModelSelection, permission: Record<string, unknown>, config: Record<string, unknown>,
  instructions?: Record<string, unknown>,
): Record<string, unknown> {
  const effort = nativeModelEffort(selection);
  const serviceTier = fastServiceTier(flavor, selection.model, nativeModelFast(selection));
  const backendVariant = modelBackendVariant(flavor, selection);
  const merged = {
    ...(effort && effort !== 'default' ? { model_reasoning_effort: effort } : {}),
    ...(backendVariant ? { model_backend_variant: backendVariant } : {}),
    ...config,
  };
  return {
    ...instructions,
    cwd,
    model: selection.model || null,
    ...permission,
    ...(serviceTier ? { serviceTier } : {}),
    ...(Object.keys(merged).length ? { config: merged } : {}),
    ephemeral: false,
  };
}

/**
 * An app-server with a new thread on it, started for the next new conversation of a project. Codex
 * starts a thread's MCP servers when the thread starts and writes nothing to disk before its first
 * turn, so one never used leaves no trace in history.
 */
export interface CodexWarm {
  transport: CodexAppServerClient;
  terminalUnavailable: boolean;
  thread: ThreadStart;
  /** What it was started for, as the conversation states it: compared again when the conversation opens the thread. */
  model: string | undefined;
  approval: string;
  /** Gives the app-server's messages to the conversation that takes it. */
  attach(handlers: Handlers): void;
  /** The provisional Riffet MCP server the thread was started with (`NativeRiffetMcpHost.provisional`). */
  mcp?: { adopt(sessionId: string): void; revoke(): void };
}

/** What a warm thread is taken by: the same launch, model, permission and tools as the conversation's. */
export function warmKey(project: Project, profile: NativeBackendProfileConfig, flavor: CodexFlavor, model: string | undefined, approval: string | undefined, tools: string | undefined, mcpOff: readonly string[] = []): string {
  return JSON.stringify([project.id, runtimeFingerprintFor(project, profile, flavor), model ?? str(profile.config.defaultModel) ?? '', permissionOf(approval, flavor.id).id, tools ?? '', [...mcpOff].sort()]);
}

/** The key of the conversation `session` would start: its own model, permission, tools and switched-off servers. */
export function sessionWarmKey(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig, flavor: CodexFlavor): string {
  return warmKey(project, profile, flavor, session.model, session.approval, host.riffetMcp?.signature?.(session.id), extensionsOffNames(session.extensionsOff, 'mcp'));
}

/**
 * Starts one. Messages before a conversation takes it go nowhere: they are the thread's start and its MCP
 * servers' progress, which a conversation reads from the thread itself. It ends what it made if `signal`
 * aborts first or a step fails.
 */
export async function startCodexWarm(options: {
  start: CodexAppServerFactory; flavor: CodexFlavor; observation?: CodexObservation; riffetMcp?: NativeRiffetMcpHost;
  project: Project; profile: NativeBackendProfileConfig; model: string | undefined; approval: string | undefined;
  signal: AbortSignal; alias(key: string): void; lost(): void;
}): Promise<CodexWarm> {
  const { flavor, project, profile, signal } = options;
  let target: Handlers | undefined;
  let exited: Error | undefined;
  const server = await conversationServerOptions(project, profile, flavor, options.observation, {
    onNotification: (method, params) => target?.onNotification(method, params),
    onServerRequest: request => target?.onServerRequest(request) ?? Promise.reject(new Error('No conversation has taken this app-server yet')),
    onExit: error => { if (target) target.onExit(error); else { exited = error; options.lost(); } },
  });
  const { transport, terminalUnavailable } = await spawnConversationServer(options.start, flavor, server);
  const aborted = () => { if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted'); };
  let mcp: ReturnType<NonNullable<NativeRiffetMcpHost['provisional']>>;
  try {
    mcp = options.riffetMcp?.provisional?.(project.id);
    aborted();
    await options.observation?.trust(transport, project.cwd).catch(() => undefined);
    const requested = options.model ?? str(profile.config.defaultModel);
    const selection = await resolveModelSelection(transport, flavor, parseNativeModelSelection(requested));
    const thread = await transport.request<ThreadStart>('thread/start', newThreadRequest(
      flavor, project.cwd, selection, permissionParamsOf(permissionOf(options.approval, flavor.id), 'sandbox'), riffetMcpOverride(mcp?.server),
    ));
    if (!thread?.thread?.id) throw new Error(`${flavor.label} app-server did not return a thread id`);
    aborted();
    if (exited) throw exited;
    options.alias(warmKey(project, profile, flavor, options.model, options.approval, mcp?.signature));
    return {
      transport, terminalUnavailable, thread, model: requested, approval: permissionOf(options.approval, flavor.id).id,
      attach: handlers => { target = handlers; if (exited) handlers.onExit(exited); },
      ...(mcp ? { mcp: { adopt: mcp.adopt, revoke: mcp.revoke } } : {}),
    };
  } catch (error) {
    mcp?.revoke();
    await transport.dispose().catch(() => undefined);
    throw error;
  }
}
