// A Claude Code CLI started for the next new conversation of a project (a warm one, `WarmPool`): launched
// as `ClaudeSessionRuntime.startTui` launches a new conversation, in a reserved terminal, with a session id
// of its own. The conversation that takes it records that id and the terminal (`claimWarmup`), and its
// runtime then takes the running CLI over as it takes over one that outlived a server restart.
import { createHash, randomUUID } from 'node:crypto';
import type { Project, Session, TerminalAppearance } from '../../../../../packages/contracts/src/index.js';
import { reserveWarmTerminal, WarmupRefused, type WarmStart } from '@riffet/plugin-api/kit';
import type { AgentReservation } from '@riffet/plugin-api/experimental/agent';
import { claudeComposerVisible } from '../../adapters/cli/claude-code.js';
import { extensionsOffNames } from '../../extensions/toggles.js';
import { ensureClaudeWorkspaceTrust } from '../shared/cli-trust.js';
import type { WarmTerminals } from '../shared/warm-terminals.js';
import type { NativeBackendHost, NativeBackendProfileConfig } from '../types.js';
import type { ClaudeHookBridge } from './hook-bridge.js';
import { ClaudeHookOverlay } from './hook-overlay.js';
import { claudeAvailability, executableOf, permissionArgs, profileEnv, string } from './launch.js';
import { declaredLongContext, modelArgs, validateModelSelection } from './models.js';
import { parseClaudeScreenDialog } from './screen-dialog.js';

export interface ClaudeWarm {
  terminals: WarmTerminals;
  reservation: AgentReservation;
  /** Lives as long as the CLI: its settings file and hooks are the ones the CLI was started with. */
  overlay: ClaudeHookOverlay;
  /** The hooks it sent before a conversation took it (`ClaudeHookBridge.hold`). */
  held: { release(): void };
  mcp?: { adopt(sessionId: string): void; revoke(): void };
}

/** What a warm CLI is taken by: the same launch (profile, model, permission, colours) and the same tools. */
export function claudeWarmKey(project: Project, profile: NativeBackendProfileConfig, input: { model?: string; approval?: string; appearance?: TerminalAppearance; tools?: string; extensionsOff?: readonly string[] }): string {
  const launch = createHash('sha256').update(JSON.stringify([profile.id, profile.config])).digest('hex');
  return JSON.stringify([
    project.id, project.cwd, launch, input.model ?? string(profile.config.defaultModel) ?? '', input.approval ?? string(profile.config.approval) ?? '',
    input.appearance ?? null, input.tools ?? '', [...extensionsOffNames(input.extensionsOff, 'mcp'), ...extensionsOffNames(input.extensionsOff, 'skill')].sort(),
  ]);
}

/** The key of the conversation `session` would launch. */
export function sessionClaudeWarmKey(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig): string {
  return claudeWarmKey(project, profile, {
    ...(session.model ? { model: session.model } : {}), ...(session.approval ? { approval: session.approval } : {}),
    ...(session.terminalAppearance ? { appearance: session.terminalAppearance } : {}),
    tools: host.riffetMcp?.signature?.(session.id) ?? '', ...(session.extensionsOff ? { extensionsOff: session.extensionsOff } : {}),
  });
}

export async function stopClaudeWarm(warm: ClaudeWarm): Promise<void> {
  warm.mcp?.revoke();
  warm.held.release();
  await warm.terminals.releaseReservation(warm.reservation.terminal.id, warm.reservation.ownerToken).catch(() => false);
  await warm.overlay.dispose();
}

/**
 * Starts one: ready once its input box is drawn and its SessionStart came, the same two signs a launched
 * conversation waits for (`ReadyGate`). A dialog the CLI draws first is a CLI asking someone; it is refused.
 */
export async function startClaudeWarm(options: {
  host: NativeBackendHost; bridge: ClaudeHookBridge; terminals: WarmTerminals; ownerToken: string;
  project: Project; profile: NativeBackendProfileConfig; model?: string; approval?: string; appearance?: TerminalAppearance;
  start: WarmStart;
}): Promise<ClaudeWarm> {
  const { host, bridge, project, profile, start } = options;
  const model = options.model ?? string(profile.config.defaultModel);
  await validateModelSelection(profile, model);
  const availability = await claudeAvailability(profile);
  if (!availability.available) throw new WarmupRefused('cli-unavailable');
  ensureClaudeWorkspaceTrust({ configHome: string(profile.config.configDir), cwd: project.cwd });
  const nativeSessionId = randomUUID();
  const mcp = host.riffetMcp?.provisional?.(project.id);
  const draft = { id: nativeSessionId, projectId: project.id, kind: 'native', ...(model ? { model } : {}), ...(options.approval ? { approval: options.approval } : {}) } as Session;
  const overlay = new ClaudeHookOverlay({
    host, bridge, nativeSessionId, project, profile: () => profile, session: () => draft, isDisposed: () => start.signal.aborted,
    onHook: async () => ({}), draft: mcp ? { riffetMcp: mcp.server } : {},
  });
  const held = bridge.hold(nativeSessionId);
  try {
    await overlay.ensureHookServer(model);
    start.alias(claudeWarmKey(project, profile, { ...options, model, tools: mcp?.signature ?? '' }));
    const args = [
      '--session-id', nativeSessionId,
      ...(overlay.mcpConfigFile ? ['--mcp-config', overlay.mcpConfigFile] : []),
      '--settings', overlay.overlayFile!,
      ...modelArgs(model, await declaredLongContext(profile, model)),
      ...permissionArgs(options.approval ?? string(profile.config.approval)),
    ];
    const env = { ...profileEnv(profile), ...(bridge.descriptorPath ? {} : { RIFFET_CLAUDE_HOOK_URL: overlay.hookUrl!, RIFFET_CLAUDE_HOOK_TOKEN: overlay.hookToken! }) };
    const reservation = await reserveWarmTerminal(options.terminals, {
      projectId: project.id, ownerToken: options.ownerToken, resourceKey: randomUUID(), nativeSessionId,
      ...(options.appearance ? { appearance: options.appearance } : {}),
      spec: { kind: 'native', command: executableOf(profile), args, env, cwd: project.cwd, title: 'Claude Agent' },
    }, start, screen => parseClaudeScreenDialog(screen) ? { blocked: 'cli-attention-required' } : claudeComposerVisible(screen) ? 'ready' : undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(start.signal.reason ?? new WarmupRefused('released'));
        if (start.signal.aborted) return aborted();
        start.signal.addEventListener('abort', aborted, { once: true });
        void held.started.then(() => { start.signal.removeEventListener('abort', aborted); resolve(); });
      });
    } catch (error) {
      await options.terminals.releaseReservation(reservation.terminal.id, reservation.ownerToken).catch(() => false);
      throw error;
    }
    return { terminals: options.terminals, reservation, overlay, held, ...(mcp ? { mcp: { adopt: mcp.adopt, revoke: mcp.revoke } } : {}) };
  } catch (error) {
    held.release();
    mcp?.revoke();
    await overlay.dispose();
    throw error;
  }
}
